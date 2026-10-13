#!/usr/bin/env node
// scripts/smoke/selfhost.mjs —— npm run smoke:selfhost：自建档（EC2 上自建 PostgreSQL 16 + Valkey 8 的近似）端到端自测
//
// 用本机 Docker 起 docker-compose.test.yml 中的 postgres（127.0.0.1:55432）与 valkey（127.0.0.1:56379）——只用本机已有的镜像
// （--pull never），然后 DB_DRIVER=postgres（DB_HOST 指向本机）+ CACHE_DRIVER=redis，把 L0 的全流程再跑一遍，
// 并确认 LockPort 自动换成 pg advisory lock、缓存命中 / 旁路、迁移在 PostgreSQL 上执行。
// 每次运行建一个新库 cloudalbum_smoke_<时间>（结束时删除）与独立的 Redis 键前缀。
// 用法：node scripts/smoke/selfhost.mjs [--keep] [--no-compose]（--no-compose：服务已由别处启动，例如 CI）
import path from 'node:path';
import { argFlag, check, docker, dockerAvailable, expectStatus, imagePresent, Reporter, requireBuild, ROOT, waitTcp } from './lib.mjs';
import { runVariant } from './run.mjs';

const COMPOSE = ['compose', '-f', path.join(ROOT, 'docker-compose.test.yml')];
const PG = { host: '127.0.0.1', port: 55432, user: 'cloudalbum', password: 'cloudalbum' };
const REDIS = { host: '127.0.0.1', port: 56379 };

function psql(sql, db = 'cloudalbum') {
  const id = docker([...COMPOSE, 'ps', '-q', 'postgres']).stdout.split('\n')[0];
  check(id, 'postgres 容器没有运行');
  const r = docker(['exec', id, 'psql', '-U', PG.user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  check(r.status === 0, `psql 失败：${r.stderr}`);
  return r.stdout;
}

async function main() {
  requireBuild();
  const keep = argFlag('keep');
  const t = new Reporter('smoke:selfhost');
  t.section('自建档：本机 Docker 服务');
  const ok = await t.step('Docker 可用，postgres:16-alpine 与 valkey/valkey:8 镜像在本机', async () => {
    const v = dockerAvailable();
    check(v, 'docker 不可用（Docker Desktop 未启动？）');
    for (const img of ['postgres:16-alpine', 'valkey/valkey:8']) check(imagePresent(img), `本机没有镜像 ${img}（本脚本不拉取镜像：docker pull ${img}）`);
    return `Docker ${v}`;
  });
  if (!ok) process.exit(t.finish());
  if (!argFlag('no-compose')) {
    await t.step('docker compose up -d --pull never postgres valkey', async () => {
      const r = docker([...COMPOSE, 'up', '-d', '--pull', 'never', '--wait', 'postgres', 'valkey'], { timeout: 180_000 });
      check(r.status === 0, `compose up 失败：${r.stderr || r.stdout}`);
      return 'healthy';
    });
  }
  await t.step('PostgreSQL 16 与 Valkey 8 可连接', async () => {
    await waitTcp(PG.host, PG.port);
    await waitTcp(REDIS.host, REDIS.port);
    const ver = psql('select version()');
    check(/PostgreSQL 16/.test(ver), `不是 PostgreSQL 16：${ver}`);
    const id = docker([...COMPOSE, 'ps', '-q', 'valkey']).stdout.split('\n')[0];
    const info = docker(['exec', id, 'valkey-cli', 'INFO', 'server']).stdout;
    const vv = /valkey_version:(\S+)/.exec(info)?.[1] ?? /redis_version:(\S+)/.exec(info)?.[1];
    check(vv?.startsWith('8.'), `不是 Valkey 8：${vv}`);
    return `${ver.split(',')[0]} · Valkey ${vv}`;
  });

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const dbName = `cloudalbum_smoke_${stamp}`;
  const prefix = `smoke:${stamp}:`;
  await t.step(`建库 ${dbName}`, async () => {
    psql(`create database ${dbName}`);
    return 'ok';
  });

  const variant = {
    modules: {
      database: { DB_DRIVER: 'postgres', DB_HOST: PG.host, DB_PORT: String(PG.port), DB_NAME: dbName, DB_USER: PG.user, DB_SSL: 'disable', DB_POOL_MAX: '10' },
      cache: { CACHE_DRIVER: 'redis', REDIS_URL: `redis://${REDIS.host}:${REDIS.port}`, REDIS_TLS: 'off', REDIS_KEY_PREFIX: prefix },
    },
    profile: {
      name: '自建档 PostgreSQL 16 + Valkey 8', storage: 'local', imageAsync: false, imageDriver: 'inline', cacheDriver: 'redis', dbDriver: 'postgres',
      expectNoAwsSdk: true,
      expectModules: { ec2: { allow: ['ok', 'degraded'] }, database: { driver: 'postgres' }, cache: { driver: 'redis' } },
    },
    async after(tt, env, s) {
      await tt.step('PostgreSQL：迁移已执行、业务数据写入了自建库', async () => {
        const tables = psql("select count(*) from information_schema.tables where table_schema='public'", dbName);
        const photos = psql("select count(*) from photos where status='READY'", dbName);
        check(Number(tables) > 10 && Number(photos) >= 1, `自建库中表 ${tables} 张、READY 照片 ${photos} 张`);
        return `${tables} 张表 · READY 照片 ${photos} 张`;
      });
      await tt.step('Valkey：时间线缓存键写在独立前缀下', async () => {
        const id = docker([...COMPOSE, 'ps', '-q', 'valkey']).stdout.split('\n')[0];
        const keys = docker(['exec', id, 'valkey-cli', '--scan', '--pattern', `${prefix}*`]).stdout.split('\n').filter(Boolean);
        check(keys.some((k) => k.includes('feed:')), `没有 feed 缓存键：${keys.slice(0, 10).join(', ')}`);
        return `${keys.length} 个键（例：${keys.find((k) => k.includes('feed:'))}）`;
      });
      await tt.step('LockPort 自动选择 pg（scope=cluster），定时任务手动触发经 advisory lock 执行', async () => {
        const caps = expectStatus(await s.admin.get('/api/capabilities'), 200).body;
        const scope = caps.modules.scheduler?.data?.lockScope;
        check(scope === 'cluster', `DB_DRIVER=postgres 时锁应为 pg（scope=cluster）：${scope}`);
        const run = expectStatus(await s.admin.post('/api/admin/jobs/share.cleanup/run', {}), 200).body;
        check(run.status === 'ok', `share.cleanup 状态 ${run.status}`);
        return `lock scope=${scope} · share.cleanup ${run.status}`;
      });
    },
  };
  try {
    await runVariant(t, 'selfhost', variant, { keep, secrets: { DB_PASSWORD: PG.password } });
  } finally {
    if (!keep) {
      try {
        psql(`drop database if exists ${dbName} with (force)`);
      } catch (e) {
        console.log(`删除测试库失败（可手动删除 ${dbName}）：${e.message}`);
      }
      const id = docker([...COMPOSE, 'ps', '-q', 'valkey']).stdout.split('\n')[0];
      if (id) {
        const keys = docker(['exec', id, 'valkey-cli', '--scan', '--pattern', `${prefix}*`]).stdout.split('\n').filter(Boolean);
        for (let i = 0; i < keys.length; i += 200) docker(['exec', id, 'valkey-cli', 'DEL', ...keys.slice(i, i + 200)]);
      }
    }
  }
  process.exitCode = t.finish(path.join(ROOT, '.cloudalbum', 'smoke', 'last-selfhost.json'));
}

await main();
