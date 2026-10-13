// database 探针：SQLite（文件可写、quick_check）、PostgreSQL（延迟、连接池排队、只读副本）、RDS 深度探针（DescribeDBInstances）
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { databaseProbe, rdsInstanceIdOf } from '../../src/modules/database-probe.js';
import { ENABLE } from '../helpers/config.js';
import { awsError, fakeCredentials, testConfig } from '../adapters/aws/helpers.js';

const rds = mockClient(RDSClient);
const opened: Knex[] = [];
afterEach(async () => {
  rds.reset();
  for (const k of opened.splice(0)) await k.destroy();
});

/** 不连真实 PostgreSQL 的假 Knex：只实现探针用到的 raw() 与连接池计数 */
function fakePg(opts: { latencyMs?: number; pending?: number; fail?: boolean } = {}): Knex {
  return {
    async raw(sql: string) {
      if (opts.fail) throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      return sql.startsWith('show') ? { rows: [{ server_version: '16.4' }] } : { rows: [{ '?column?': 1 }] };
    },
    client: { pool: { numPendingAcquires: () => opts.pending ?? 0 } },
  } as unknown as Knex;
}

const aws = (creds = true) => lazyAwsClients({ region: 'ap-northeast-1', credentials: creds ? fakeCredentials : null });

describe('databaseProbe：SQLite', () => {
  it('select 1 + 版本 + 主机分类 file；深度探针执行 PRAGMA quick_check', async () => {
    const { cfg } = testConfig({});
    if (cfg.db.DB_DRIVER !== 'sqlite') throw new Error('unexpected');
    mkdirSync(path.dirname(cfg.db.SQLITE_PATH), { recursive: true });
    const db = knexFactory({ client: 'better-sqlite3', connection: { filename: cfg.db.SQLITE_PATH }, useNullAsDefault: true });
    opened.push(db);
    const r = await databaseProbe(db, cfg);
    // 宿主机磁盘剩余 < 15% 时为 degraded（与机器有关，这里只断言原因）
    if (r.status !== 'ok') expect(r.detail).toContain('数据卷剩余');
    expect(r.detail).toMatch(/^select 1 = [\d.]+ms · SQLite \d+\.\d+/);
    expect(r.data).toMatchObject({ hostClass: 'file', file: cfg.db.SQLITE_PATH });
    const deep = await databaseProbe(db, cfg, { deep: true });
    expect(deep.data).toMatchObject({ quickCheck: 'ok' });
  });

  it('连接失败 → error', async () => {
    const { cfg } = testConfig({});
    const r = await databaseProbe(fakePg({ fail: true }), cfg);
    expect(r.status).toBe('error');
    expect(r.detail).toContain('数据库连接失败');
  });
});

describe('databaseProbe：PostgreSQL / RDS', () => {
  const rdsEnv = { ...ENABLE.iamRole, ...ENABLE.rds };

  it('RDS 常规探针：主机分类 rds；延迟 > 200ms → degraded；连接池排队 → degraded', async () => {
    const { cfg } = testConfig(rdsEnv);
    const ok = await databaseProbe(fakePg(), cfg);
    expect(ok).toMatchObject({ status: 'ok', data: { hostClass: 'rds', version: 'PostgreSQL 16.4' } });
    expect(ok.detail).toContain('主机分类：rds · 无只读副本');
    expect((await databaseProbe(fakePg({ latencyMs: 220 }), cfg)).status).toBe('degraded');
    const queued = await databaseProbe(fakePg({ pending: 3 }), cfg);
    expect(queued.status).toBe('degraded');
    expect(queued.detail).toContain('连接池有 3 个请求在排队');
  });

  it('只读副本：可达时报告副本延迟；不可达 → degraded（不是 error）', async () => {
    const { cfg } = testConfig({ ...rdsEnv, DB_READ_HOST: 'cloudalbum-lab-database-replica.abc123.ap-northeast-1.rds.amazonaws.com' });
    const ok = await databaseProbe(fakePg(), cfg, { dbRead: fakePg() });
    expect(ok.detail).toContain('有只读副本 · 副本 select 1 =');
    const bad = await databaseProbe(fakePg(), cfg, { dbRead: fakePg({ fail: true }) });
    expect(bad.status).toBe('degraded');
    expect(bad.detail).toContain('只读副本不可达');
  });

  it('深度探针：DescribeDBInstances（Multi-AZ、最近可恢复时间点、副本状态）', async () => {
    const { cfg } = testConfig({ ...rdsEnv, DB_READ_HOST: 'cloudalbum-lab-database-replica.abc123.ap-northeast-1.rds.amazonaws.com' });
    rds.on(DescribeDBInstancesCommand, { DBInstanceIdentifier: 'cloudalbum-lab-database' }).resolves({ DBInstances: [{
      DBInstanceIdentifier: 'cloudalbum-lab-database', DBInstanceStatus: 'available', MultiAZ: true, Engine: 'postgres', EngineVersion: '16.4',
      LatestRestorableTime: new Date('2026-10-13T05:00:00Z'), PendingModifiedValues: {}, ReadReplicaDBInstanceIdentifiers: ['cloudalbum-lab-database-replica'],
    }] });
    rds.on(DescribeDBInstancesCommand, { DBInstanceIdentifier: 'cloudalbum-lab-database-replica' }).resolves({ DBInstances: [{
      DBInstanceIdentifier: 'cloudalbum-lab-database-replica', DBInstanceStatus: 'available', MultiAZ: false, ReadReplicaSourceDBInstanceIdentifier: 'cloudalbum-lab-database',
    }] });
    const r = await databaseProbe(fakePg(), cfg, { deep: true, dbRead: fakePg(), aws: aws() });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('cloudalbum-lab-database available · Multi-AZ 开 · 最近可恢复时间点 2026-10-13T05:00:00.000Z');
    expect(r.detail).toContain('副本 cloudalbum-lab-database-replica available');
    expect(r.data).toMatchObject({ rds: { multiAz: true, readReplicaIds: ['cloudalbum-lab-database-replica'] } });
  });

  it('深度探针：状态不是 available / 有待处理修改 → degraded；实例不存在 → error；无凭证 → 跳过（CRED-004）', async () => {
    const { cfg } = testConfig(rdsEnv);
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ DBInstanceIdentifier: 'cloudalbum-lab-database', DBInstanceStatus: 'modifying', PendingModifiedValues: { DBInstanceClass: 'db.t4g.small' } }] });
    const mod = await databaseProbe(fakePg(), cfg, { deep: true, aws: aws() });
    expect(mod.status).toBe('degraded');
    expect(mod.detail).toContain('待处理修改：DBInstanceClass');
    rds.on(DescribeDBInstancesCommand).rejects(awsError('DBInstanceNotFound', 404));
    const gone = await databaseProbe(fakePg(), cfg, { deep: true, aws: aws() });
    expect(gone.status).toBe('error');
    expect(gone.detail).toContain('不存在');
    const noCreds = await databaseProbe(fakePg(), cfg, { deep: true, aws: aws(false) });
    expect(noCreds.status).toBe('ok');
    expect(noCreds.detail).toContain('CRED-004');
  });

  it('自建 PostgreSQL（回环地址）不查控制面', async () => {
    const { cfg } = testConfig({ ...ENABLE.pgLocal });
    const r = await databaseProbe(fakePg(), cfg, { deep: true, aws: aws() });
    expect(r.data).toMatchObject({ hostClass: 'local' });
    expect(rds.calls()).toHaveLength(0);
  });

  it('rdsInstanceIdOf：只认 RDS 实例端点（RDS Proxy 端点返回 null）', () => {
    expect(rdsInstanceIdOf('cloudalbum-lab-database.abc123.ap-northeast-1.rds.amazonaws.com')).toBe('cloudalbum-lab-database');
    expect(rdsInstanceIdOf('cloudalbum-lab.proxy-abc123.ap-northeast-1.rds.amazonaws.com')).toBeNull();
    expect(rdsInstanceIdOf('127.0.0.1')).toBeNull();
    expect(rdsInstanceIdOf(undefined)).toBeNull();
  });
});
