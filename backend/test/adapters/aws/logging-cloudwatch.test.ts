// logging=cloudwatch：LoggerPort 契约（内存 CloudWatch Logs，aws-sdk-client-mock）+ 驱动细节
// （本地文件照写、批量发送、日志组缺失、瞬时失败与积压上限、Nginx 访问日志转发与轮转、canary 摄取延迟、agent 方式、读取器）
import { appendFileSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CwLogger } from '../../../src/adapters/logging/cloudwatch.js';
import { CwLogSender, MAX_EVENT_BYTES, truncateMessage } from '../../../src/adapters/logging/cw-sender.js';
import { lineTimestamp } from '../../../src/adapters/logging/nginx-tail.js';
import { CwLogReader, FileLogReader, createLogReaders, sourceOfStream, toRecord } from '../../../src/adapters/logging/readers.js';
import { setInstanceIdentity } from '../../../src/observability/path-header.js';
import { ENABLE } from '../../helpers/config.js';
import { describeLoggerContract } from '../../contract/ops.contract.js';
import { FakeCwLogs } from './fake-cwlogs.js';
import { awsError, makeDeps, sleep, waitFor } from './helpers.js';

const APP = ENABLE.logging.LOG_CW_GROUP_APP;
const NGINX = ENABLE.logging.LOG_CW_GROUP_NGINX;
const env = { ...ENABLE.iamRole, ...ENABLE.logging };

let fake: FakeCwLogs;
const open: CwLogger[] = [];
beforeEach(() => {
  fake = new FakeCwLogs();
  fake.createGroup(APP, 14);
  fake.createGroup(NGINX, 14);
  setInstanceIdentity({ instanceId: 'i-0test', az: 'ap-northeast-1a' });
});
afterEach(async () => {
  for (const l of open.splice(0)) await l.close().catch(() => undefined);
  fake.restore();
  setInstanceIdentity({});
});

function newLogger(extra: Record<string, string> = {}, role: 'api' | 'worker' = 'api'): CwLogger & { dataDir?: string } {
  const deps = makeDeps({ ...env, LOG_CW_FLUSH_MS: '100', ...extra });
  const l = new CwLogger({ ...deps, role });
  open.push(l);
  return l;
}

/** SonicBoom 异步写文件：轮询直到出现 n 行 */
async function localLines(file: string, n: number): Promise<Array<Record<string, unknown>>> {
  let lines: string[] = [];
  await waitFor(() => {
    try {
      lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      lines = [];
    }
    return lines.length >= n;
  }, 3000);
  return lines.map((x) => JSON.parse(x) as Record<string, unknown>);
}

describeLoggerContract('cloudwatch', async () => {
  const port = newLogger();
  return { port };
});

describe('CwLogger 写入侧', () => {
  it('本地文件照写；同一行 JSON 批量 PutLogEvents 到 {instanceId}/{role}', async () => {
    const l = newLogger();
    await l.init();
    l.info('hello', { requestId: 'r-1', n: 1 });
    l.error('boom', { err: new Error('x') });
    await l.flush();
    const local = await localLines(l.file, 2);
    const remote = fake.events(APP, 'i-0test/api').map((e) => JSON.parse(e.message) as Record<string, unknown>);
    expect(local.map((x) => x.msg)).toEqual(['hello', 'boom']);
    expect(remote).toEqual(local);                                   // 逐字段相同：两侧可以用同一个查询
    expect(remote[1]).toMatchObject({ level: 'error', role: 'api', instanceId: 'i-0test' });
    expect(l.stats()).toMatchObject({ written: 2, dropped: 0, backlog: 0 });
    expect(l.stats().lastRemoteSuccessAt).toBeTruthy();
    expect(fake.puts).toHaveLength(1);                               // 一批发送
  });

  it('日志组不存在：本地文件照写，探针 error（不抛给调用方）', async () => {
    fake.groups.delete(APP);
    const l = newLogger();
    await l.init();
    l.warn('still written locally');
    await l.flush();
    expect(JSON.stringify(await localLines(l.file, 1))).toContain('still written locally');
    const p = await l.probe();
    expect(p.status).toBe('error');
    expect(p.detail).toContain('日志组不存在');
    expect(l.stats().backlog).toBe(1);
  });

  it('瞬时失败：保留积压并退避，探针 degraded（transient）；恢复后积压清零、探针 ok', async () => {
    fake.putFailures.push(awsError('ThrottlingException', 400, 'Rate exceeded'), awsError('ServiceUnavailable', 503));
    const l = newLogger();
    await l.init();
    l.info('a');
    l.info('b');
    const sender = (l as unknown as { app: CwLogSender }).app;
    await sender.sendOnce();
    let p = await l.probe();
    expect(p.status).toBe('degraded');
    expect(p.transient).toBe(true);
    expect(p.detail).toContain('积压 2 条');
    await sender.sendOnce();
    await sender.sendOnce();
    expect(l.stats().backlog).toBe(0);
    p = await l.probe();
    expect(p.status).toBe('ok');
    expect(fake.events(APP)).toHaveLength(2);
  });

  it('连续 AccessDenied：第一次 degraded，连续两次 error（检查 PolicyArn）', async () => {
    fake.putFailures.push(awsError('AccessDeniedException', 400, 'not authorized'), awsError('AccessDeniedException', 400, 'not authorized'));
    const l = newLogger();
    await l.init();
    l.info('x');
    const sender = (l as unknown as { app: CwLogSender }).app;
    await sender.sendOnce();
    expect((await l.probe()).status).toBe('degraded');
    await sender.sendOnce();
    const p = await l.probe();
    expect(p.status).toBe('error');
    expect(p.detail).toContain('PolicyArn');
  });

  it('积压上限 LOG_CW_MAX_BACKLOG：丢弃最旧的事件并计入 dropped，探针 degraded', async () => {
    fake.groups.delete(APP);
    const l = newLogger({ LOG_CW_MAX_BACKLOG: '100' });
    await l.init();
    for (let i = 0; i < 130; i += 1) l.info(`m${i}`);
    expect(l.stats()).toMatchObject({ backlog: 100, dropped: 30 });
    fake.createGroup(APP);
    const p = await l.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('丢弃 30 条');
    await l.flush();
    const msgs = fake.events(APP).map((e) => (JSON.parse(e.message) as { msg: string }).msg);
    expect(msgs[0]).toBe('m30');                                     // 最旧的 30 条被丢弃，本地文件里仍然有
    expect((await localLines(l.file, 130))[0]).toMatchObject({ msg: 'm0' });
  });
});

describe('CwLogSender', () => {
  it('按条数分批；超长事件截断；PutLogEvents 拒绝的事件计入 dropped', async () => {
    let t = Date.now();
    const s = new CwLogSender({
      group: APP, stream: () => 'i-0test/api', flushMs: 1000, maxBacklog: 10_000, timer: false, maxBatchEvents: 3,
      client: async () => new CloudWatchLogsClient({ region: 'ap-northeast-1' }),
      now: () => t,
    });
    for (let i = 0; i < 7; i += 1) s.enqueue(`{"msg":"m${i}"}`, t + i);
    await s.flush();
    expect(fake.puts.map((p) => p.count)).toEqual([3, 3, 1]);
    expect(s.stats()).toMatchObject({ sent: 7, backlog: 0, dropped: 0 });
    s.enqueue('{"msg":"old"}', Date.now() - 20 * 86_400_000);
    t += 10;
    await s.flush();
    expect(s.stats().dropped).toBe(1);
    const long = 'x'.repeat(MAX_EVENT_BYTES + 100);
    expect(Buffer.byteLength(truncateMessage(long))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(truncateMessage(long).endsWith('…[truncated]')).toBe(true);
  });
});

describe('Nginx 访问日志转发（worker）', () => {
  it('增量读取 nginx-access.json → {instanceId}/access；事件时间取 ts；轮转时读完旧文件', async () => {
    const l = newLogger({}, 'worker');
    await l.init();
    const dir = l.settings.logDir;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'nginx-access.json');
    const line = (rid: string, ts: string, status = 200) => `${JSON.stringify({ ts, rid, method: 'GET', uri: '/api/lab/now', status, run: 'RUN1' })}\n`;
    writeFileSync(file, line('r0', '2026-10-14T10:00:00+09:00'));
    const tail = l.startNginxTail({ file, intervalMs: 3600_000, fromStart: true })!;
    appendFileSync(file, line('r1', '2026-10-14T10:00:01+09:00', 503));
    tail.poll();
    appendFileSync(file, line('r2', '2026-10-14T10:00:02+09:00'));
    renameSync(file, `${file}.1`);                                    // logrotate create：改名 + 新建
    writeFileSync(file, line('r3', '2026-10-14T10:00:03+09:00'));
    await l.flush();
    const evs = fake.events(NGINX, 'i-0test/access');
    expect(evs.map((e) => (JSON.parse(e.message) as { rid: string }).rid)).toEqual(['r0', 'r1', 'r2', 'r3']);
    expect(evs[1]!.timestamp).toBe(Date.parse('2026-10-14T10:00:01+09:00'));
    expect(lineTimestamp('{"ts":"bad"}')).toBeUndefined();
  });

  it('api 进程不转发 Nginx 日志（只由 worker 转发一次）', async () => {
    const l = newLogger({}, 'api');
    await l.init();
    expect((l as unknown as { tailer?: unknown }).tailer).toBeUndefined();
  });
});

describe('CwLogger 探针', () => {
  it('常规探针不调用 AWS；detail 含组名、日志流与积压', async () => {
    const l = newLogger();
    await l.init();
    const calls = fake.mock.calls().length;
    const p = await l.probe();
    expect(fake.mock.calls().length).toBe(calls);
    expect(p).toMatchObject({ status: 'ok', confidence: 'confirmed' });
    expect(p.detail).toContain('/cloudalbum/lab/app');
    expect(p.data).toMatchObject({ groupApp: APP, groupNginx: NGINX, shipper: 'sdk', stream: 'i-0test/api' });
  });

  it('深度探针：canary 测出摄取延迟与覆盖的实例数；超过 60 秒 → degraded', async () => {
    fake.createGroup(APP);
    const other = fake.groups.get(APP)!;
    other.streams.set('i-0other/api', [{ timestamp: Date.now(), message: '{}', ingestionTime: Date.now(), logStreamName: 'i-0other/api' }]);
    const l = newLogger();
    await l.init();
    let p = await l.probe({ deep: true });
    expect(p.status).toBe('ok');
    expect(p.detail).toMatch(/摄取延迟 [\d.]+ 秒/);
    expect(p.data).toMatchObject({ instances: 2 });
    expect(l.lastIngest?.lagMs).toBeGreaterThanOrEqual(0);
    (l as unknown as { ingest: { lagMs: number } }).ingest.lagMs = 75_000;
    p = await l.probe();
    expect(p.status).toBe('degraded');
  });

  it('canary 在预算内查不到：detail 提示后台继续测量，不判 error', async () => {
    fake.lagMs = 3_600_000;                                           // 摄取极慢：FilterLogEvents 暂时查不到
    const l = newLogger();
    await l.init();
    const p = await l.probe({ deep: true });
    expect(p.status).toBe('ok');
    expect(p.detail).toContain('canary 摄取中');
  });

  it('agent 方式：不启动发送器；本地文件比 CloudWatch 新超过 2 分钟 → degraded；keys 模式 → error', async () => {
    const l = newLogger({ LOG_CW_SHIPPER: 'agent' });
    await l.init();
    l.info('local only');
    await l.flush();
    expect(fake.puts).toHaveLength(0);
    const g = fake.groups.get(APP)!;
    const old = Date.now() - 600_000;
    g.streams.set('i-0test/api', [{ timestamp: old, message: '{}', ingestionTime: old, logStreamName: 'i-0test/api' }]);
    let p = await l.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('Agent 没有在投递');
    g.streams.get('i-0test/api')!.push({ timestamp: Date.now(), message: '{}', ingestionTime: Date.now() + 5000, logStreamName: 'i-0test/api' });
    (l as unknown as { streams: undefined }).streams = undefined;
    utimesSync(l.file, new Date(), new Date());
    p = await l.probe();
    expect(p.status).toBe('ok');
    const k = newLogger({ ...ENABLE.iamKeys, LOG_CW_SHIPPER: 'agent' });
    await k.init();
    expect((await k.probe()).status).toBe('error');
  });
});

describe('LogReader', () => {
  it('FileLogReader：倒序扫描当前文件与 .1，按 requestId / 级别过滤，返回 meta', async () => {
    const deps = makeDeps(env);
    const dir = deps.cfg.logging.LOG_DIR;
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const t = (ms: number) => new Date(now - ms).toISOString();
    writeFileSync(path.join(dir, 'api.log.1'), `${JSON.stringify({ level: 'error', time: t(5000), msg: 'old', requestId: 'r-a' })}\n`);
    writeFileSync(path.join(dir, 'api.log'), [
      JSON.stringify({ level: 'info', time: t(3000), msg: 'one', requestId: 'r-a' }),
      JSON.stringify({ level: 'warn', time: t(2000), msg: 'two', requestId: 'r-b' }),
      'not json',
    ].join('\n'));
    writeFileSync(path.join(dir, 'nginx-access.json'), `${JSON.stringify({ ts: t(1000), rid: 'r-a', method: 'GET', uri: '/x', status: 503 })}\n`);
    const r = new FileLogReader({ logDir: dir, chunkBytes: 16 });
    const byId = await r.query({ from: t(60_000), to: t(0), limit: 10, requestId: 'r-a' });
    expect(byId.rows!.map((x) => `${x.source}:${x.msg}`)).toEqual(['api:old', 'api:one', 'nginx:GET /x 503']);
    expect(byId.meta).toMatchObject({ engine: 'local-scan', truncated: false });
    expect(byId.meta!.scannedBytes).toBeGreaterThan(0);
    const errs = await r.query({ from: t(60_000), to: t(0), limit: 10, minLevel: 'error' });
    expect(errs.rows!.map((x) => x.msg)).toEqual(['old', 'GET /x 503']);
    const capped = await r.query({ from: t(60_000), to: t(0), limit: 1 });
    expect(capped.meta!.truncated).toBe(true);
  });

  it('CwLogReader：requestId 在 app（requestId）与 nginx（rid）两组精确查找；Insights 语句异步返回扫描字节', async () => {
    const now = Date.now();
    fake.groups.get(APP)!.streams.set('i-1/api', [{ timestamp: now, message: JSON.stringify({ level: 'info', time: new Date(now).toISOString(), msg: 'a', requestId: 'r-9' }), ingestionTime: now, logStreamName: 'i-1/api' }]);
    fake.groups.get(NGINX)!.streams.set('i-2/access', [
      { timestamp: now, message: JSON.stringify({ ts: new Date(now).toISOString(), rid: 'r-9', status: 503, run: 'RUN', uri: '/u' }), ingestionTime: now, logStreamName: 'i-2/access' },
      { timestamp: now, message: JSON.stringify({ ts: new Date(now).toISOString(), rid: 'r-8', status: 200, run: 'RUN', uri: '/u' }), ingestionTime: now, logStreamName: 'i-2/access' },
    ]);
    const deps = makeDeps(env);
    const readers = createLogReaders(deps.cfg, deps.aws);
    expect(readers.cloudwatch).toBeInstanceOf(CwLogReader);
    const r = await readers.cloudwatch!.query({ from: new Date(now - 60_000).toISOString(), to: new Date(now + 1000).toISOString(), limit: 10, requestId: 'r-9' });
    expect(r.rows!.map((x) => `${x.source}@${x.instanceId}`)).toEqual(['api@i-1', 'nginx@i-2']);
    expect(r.meta).toMatchObject({ engine: 'filter-log-events', instances: ['i-1', 'i-2'] });
    const q = await readers.cloudwatch!.query({ from: new Date(now - 60_000).toISOString(), to: new Date(now + 1000).toISOString(), limit: 10,
      filter: 'filter run = "RUN" and status >= 500 | stats count(*) by uri', sources: ['nginx'] });
    expect(q.mode).toBe('async');
    const res = await readers.cloudwatch!.results!(q.queryId!);
    expect(res.done).toBe(true);
    expect(res.rows).toHaveLength(1);
    expect(res.meta.engine).toBe('logs-insights');
    expect(res.meta.scannedBytes).toBeGreaterThan(0);
    await expect(readers.cloudwatch!.query({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', limit: 1, requestId: 'bad id"}' })).rejects.toThrow('requestId');
  });

  it('file 档只有本地读取器；toRecord / sourceOfStream', () => {
    const deps = makeDeps({});
    expect(createLogReaders(deps.cfg, deps.aws).cloudwatch).toBeUndefined();
    expect(toRecord('{"ts":"2026-10-14T01:00:00Z","rid":"x","status":404,"method":"GET","uri":"/a"}', 'nginx')).toMatchObject({ level: 'warn', requestId: 'x', msg: 'GET /a 404' });
    expect(sourceOfStream('i-1/worker')).toBe('worker');
    expect(sourceOfStream('i-1/access')).toBe('nginx');
  });
});

describe('定时发送', () => {
  it('LOG_CW_FLUSH_MS 到期后自动发送（不需要显式 flush）', async () => {
    const l = newLogger({ LOG_CW_FLUSH_MS: '100' });
    await l.init();
    l.info('timer');
    await waitFor(() => fake.events(APP).length === 1, 3000);
    await sleep(10);
    expect(l.stats().backlog).toBe(0);
  });
});
