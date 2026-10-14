// monitoring 的本地实现：alerts.yaml 规则、本地告警评估器（SQLite：lab_metric_rollups / lab_host_samples → alert_events）、
// 站内信与 EmailPort 通知、评估器心跳与 LocalMetrics 探针、LocalMetricsReader（/api/lab/monitoring 的本地一侧）
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertEvaluator, EVALUATOR_LOCK, evaluateRule, readEvaluatorHeartbeat } from '../../src/adapters/monitoring/alert-evaluator.js';
import { AlertRulesLoader, DEFAULT_ALERTS_YAML, alertsFile, parseAlertRules, parseWindow } from '../../src/adapters/monitoring/alert-rules.js';
import { LocalMetrics } from '../../src/adapters/monitoring/local.js';
import { LocalMetricsReader } from '../../src/adapters/monitoring/reader.js';
import { insertHostSamples, insertRollups } from '../../src/repositories/lab.js';
import { setMeta } from '../../src/repositories/system-meta.js';
import type { EmailMessage, EmailPort } from '../../src/ports/email.js';
import type { Lease, LockPort } from '../../src/ports/lock.js';
import { makeLocalDeps, type LocalDeps } from '../contract/_local-deps.js';
import { seedUser } from '../helpers/media-fixtures.js';

class FakeEmail implements EmailPort {
  readonly meta = { module: 'email' as const, driver: 'outbox', awsService: null, authoritative: false };
  sent: EmailMessage[] = [];
  async probe() { return { status: 'ok' as const, detail: 'fake' }; }
  async send(m: EmailMessage) { this.sent.push(m); return { messageId: `m${this.sent.length}`, transport: 'outbox' as const, delivered: true }; }
  async listRecent() { return []; }
}

class FakeLock implements LockPort {
  readonly driver = 'file' as const;
  readonly scope = 'host' as const;
  held = new Set<string>();
  async tryAcquire(name: string): Promise<Lease | null> {
    if (this.held.has(name)) return null;
    this.held.add(name);
    return { name, release: async () => { this.held.delete(name); } };
  }
}

let l: LocalDeps;
beforeEach(async () => {
  l = await makeLocalDeps({ role: 'worker' });
});
afterEach(async () => {
  await l.close();
});

const NOW = new Date('2026-10-14T03:00:30Z');
const minute = (offsetMin: number) => new Date(Date.parse('2026-10-14T03:00:00Z') + offsetMin * 60_000).toISOString();

async function seedRoutes(rows: Array<{ min: number; count: number; status: '2xx' | '5xx'; ms?: number }>) {
  await insertRollups(l.db, rows.map((r) => {
    const hist = new Array<number>(66).fill(0);
    hist[Math.min(65, Math.floor(Math.log2(Math.max(1, r.ms ?? 10)) * 4) + 1)] = r.count;
    return {
      minute: minute(r.min), instanceId: 'i-test', role: 'api' as const, kind: 'route' as const, route: '/api/feed', method: 'GET',
      statusClass: r.status, count: r.count, errors: r.status === '5xx' ? r.count : 0, sumMs: r.count * (r.ms ?? 10), maxMs: r.ms ?? 10, hist,
    };
  }));
}

async function seedHost(role: 'api' | 'worker', at: string, mem = 0.5, dataPct = 40) {
  await insertHostSamples(l.db, [{
    ts: at, instanceId: 'i-test', role, pid: 1, cpuPct: 1, rssBytes: 1, heapUsedBytes: 1, eventLoopDelayP99Ms: 1, loadavg1: 0,
    memUsedRatio: mem, dataUsedPct: dataPct,
  }]);
}

describe('alerts.yaml', () => {
  it('默认规则（文件不存在）与文档示例一致；窗口与比较符解析', () => {
    const r = new AlertRulesLoader(alertsFile(l.envDir)).load();
    expect(r.source).toBe('default');
    expect(r.evaluateEverySec).toBe(30);
    expect(r.rules.map((x) => x.name)).toEqual(['app-5xx-rate', 'app-p95-latency', 'data-disk-high', 'host-mem-high', 'api-heartbeat', 'log-errors']);
    expect(r.rules.find((x) => x.name === 'api-heartbeat')).toMatchObject({ kind: 'absent', windowSec: 120 });
    expect(parseWindow('5m')).toBe(300);
    expect(parseWindow('2h')).toBe(7200);
  });

  it('文件存在时读取（修改时间缓存）；不合法的规则被忽略并给出原因', () => {
    const f = alertsFile(l.envDir);
    writeFileSync(f, 'evaluateEverySec: 15\nrules:\n  - { name: Bad Name, kind: ratio }\n  - { name: only-5xx, kind: ratio, num: "route.count{status=5xx}", den: "route.count", window: 1m, op: ">", threshold: 0.1 }\n');
    const r = new AlertRulesLoader(f).load();
    expect(r.evaluateEverySec).toBe(15);
    expect(r.rules.map((x) => x.name)).toEqual(['only-5xx']);
    expect(r.issues.length).toBe(1);
    expect(parseAlertRules('rules: [ { name: x, kind: nope, metric: a } ]').issues[0]).toContain('未知的 kind');
  });
});

describe('evaluateRule（共享数据库中的数据源）', () => {
  const rules = parseAlertRules(DEFAULT_ALERTS_YAML).rules;
  const rule = (n: string) => rules.find((r) => r.name === n)!;

  it('ratio：5xx 比率超过阈值 → ALARM；窗口内没有请求 → OK（与 CloudWatch 的 notBreaching 一致）', async () => {
    expect((await evaluateRule(l.db, rule('app-5xx-rate'), NOW)).state).toBe('OK');
    await seedRoutes([{ min: -1, count: 80, status: '2xx' }, { min: 0, count: 20, status: '5xx' }]);
    const r = await evaluateRule(l.db, rule('app-5xx-rate'), NOW);
    expect(r).toMatchObject({ state: 'ALARM', value: 0.2 });
    // 窗口之外的数据不计入
    await seedRoutes([{ min: -30, count: 1000, status: '2xx' }]);
    expect((await evaluateRule(l.db, rule('app-5xx-rate'), NOW)).value).toBe(0.2);
  });

  it('quantile：合并直方图算 p95', async () => {
    await seedRoutes([{ min: 0, count: 100, status: '2xx', ms: 2000 }]);
    const r = await evaluateRule(l.db, rule('app-p95-latency'), NOW);
    expect(r.state).toBe('ALARM');
    expect(r.value).toBeGreaterThan(1000);
  });

  it('gauge：每台实例取窗口平均，取最大；data_used_pct 换算为比率；没有采样 → INSUFFICIENT_DATA', async () => {
    expect((await evaluateRule(l.db, rule('host-mem-high'), NOW)).state).toBe('INSUFFICIENT_DATA');
    await seedHost('api', minute(0), 0.95, 90);
    expect((await evaluateRule(l.db, rule('host-mem-high'), NOW)).state).toBe('ALARM');
    expect((await evaluateRule(l.db, rule('data-disk-high'), NOW))).toMatchObject({ state: 'ALARM', value: 0.9 });
  });

  it('absent：api 进程超过窗口没有采样 → ALARM；有新采样 → OK；从未有采样 → INSUFFICIENT_DATA', async () => {
    expect((await evaluateRule(l.db, rule('api-heartbeat'), NOW)).state).toBe('INSUFFICIENT_DATA');
    await seedHost('api', new Date(NOW.getTime() - 300_000).toISOString());
    expect((await evaluateRule(l.db, rule('api-heartbeat'), NOW)).state).toBe('ALARM');
    await seedHost('api', new Date(NOW.getTime() - 10_000).toISOString());
    expect((await evaluateRule(l.db, rule('api-heartbeat'), NOW))).toMatchObject({ state: 'OK', value: 10 });
  });

  it('sum（log.events）没有本地数据源 → INSUFFICIENT_DATA 并说明', async () => {
    const r = await evaluateRule(l.db, rule('log-errors'), NOW);
    expect(r.state).toBe('INSUFFICIENT_DATA');
    expect(r.detail).toContain('没有本地数据源');
  });
});

describe('AlertEvaluator', () => {
  it('状态变化才写 alert_events；进入 ALARM 时给管理员写站内信并发邮件；恢复时再通知一次；写评估器心跳', async () => {
    const adminId = await seedUser(l.db, { role: 'admin', email: 'boss@example.com' });
    const email = new FakeEmail();
    let now = NOW;
    const ev = new AlertEvaluator({ db: l.db, envDir: l.envDir, email, now: () => now, appBaseUrl: 'https://album.example.com' });
    await seedHost('api', new Date(now.getTime() - 10_000).toISOString());
    const first = await ev.evaluateOnce();
    expect(first.find((r) => r.name === 'api-heartbeat')).toMatchObject({ state: 'OK', changed: true });
    expect(email.sent).toHaveLength(0);                                   // 首次 OK / INSUFFICIENT_DATA 不通知
    const second = await ev.evaluateOnce();
    expect(second.every((r) => !r.changed)).toBe(true);
    const before = await l.db('alert_events').count({ n: '*' }).first();

    now = new Date(NOW.getTime() + 600_000);                               // api 停了 10 分钟
    const third = await ev.evaluateOnce();
    expect(third.find((r) => r.name === 'api-heartbeat')).toMatchObject({ state: 'ALARM', changed: true, from: 'OK' });
    expect(Number((await l.db('alert_events').count({ n: '*' }).first())!.n)).toBeGreaterThan(Number(before!.n));
    const notes = await l.db('notifications').where({ user_id: adminId, type: 'monitoring.alarm' });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('api-heartbeat');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.to).toEqual(['admin@example.com']);           // 默认规则的 alertEmail
    expect(email.sent[0]!.text).toContain('实例宕机即失效');

    await seedHost('api', new Date(now.getTime() - 5_000).toISOString());
    await ev.evaluateOnce();
    expect(email.sent).toHaveLength(2);
    expect(email.sent[1]!.subject).toContain('恢复');

    const hb = await readEvaluatorHeartbeat(l.db);
    expect(hb).toMatchObject({ rules: 6, intervalSec: 30, source: 'default' });
  });

  it('重启后从 alert_events 恢复上一次状态，不重复记录', async () => {
    await seedHost('api', new Date(NOW.getTime() - 10_000).toISOString());
    await new AlertEvaluator({ db: l.db, envDir: l.envDir, now: () => NOW }).evaluateOnce();
    const n1 = Number((await l.db('alert_events').count({ n: '*' }).first())!.n);
    const again = await new AlertEvaluator({ db: l.db, envDir: l.envDir, now: () => NOW }).evaluateOnce();
    expect(again.every((r) => !r.changed)).toBe(true);
    expect(Number((await l.db('alert_events').count({ n: '*' }).first())!.n)).toBe(n1);
  });

  it('start()：取单例锁后评估；锁被别人持有时跳过；signal 终止后停止', async () => {
    const lock = new FakeLock();
    lock.held.add(EVALUATOR_LOCK);
    const ac = new AbortController();
    const ev = new AlertEvaluator({ db: l.db, envDir: l.envDir, lock, firstDelayMs: 50 });
    ev.start(ac.signal);
    await new Promise((r) => setTimeout(r, 300));
    expect(await readEvaluatorHeartbeat(l.db)).toBeNull();
    lock.held.clear();
    ac.abort();
    await ev.evaluateOnce();
    expect(await readEvaluatorHeartbeat(l.db)).not.toBeNull();
  });
});

describe('LocalMetrics 探针与 LocalMetricsReader', () => {
  it('评估器从未运行 → ok；运行过但超过 2 个周期没有再评估 → degraded（本地告警沉默）', async () => {
    const m = new LocalMetrics(l.deps);
    expect((await m.probe()).status).toBe('ok');
    await setMeta(l.db, 'monitoring.alerts.heartbeat', JSON.stringify({ at: new Date(Date.now() - 300_000).toISOString(), holder: 'h', rules: 6, intervalSec: 30, source: 'default' }));
    const p = await m.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('本地告警沉默');
    await setMeta(l.db, 'monitoring.alerts.heartbeat', JSON.stringify({ at: new Date().toISOString(), holder: 'h', rules: 6, intervalSec: 30, source: 'default' }));
    expect((await m.probe()).detail).toContain('本地评估器 6 条规则');
  });

  it('alarms() 列出全部规则（未评估的为 INSUFFICIENT_DATA，送达路径 local）；history() 给出 from → to；series() 汇总分钟数据', async () => {
    const reader = new LocalMetricsReader(l.db, () => parseAlertRules(DEFAULT_ALERTS_YAML, 'default'));
    const a0 = await reader.alarms();
    expect(a0).toHaveLength(6);
    expect(a0.every((x) => x.state === 'INSUFFICIENT_DATA' && x.delivery === 'local')).toBe(true);
    await l.db('alert_events').insert([
      { ts: '2026-10-14T03:00:00.000Z', alarm: 'api-heartbeat', state: 'OK', value: 5, detail: 'ok', source: 'local' },
      { ts: '2026-10-14T03:05:00.000Z', alarm: 'api-heartbeat', state: 'ALARM', value: 300, detail: 'gone', source: 'local' },
      { ts: '2026-10-14T03:06:00.000Z', alarm: 'api-heartbeat', state: 'ALARM', value: 1, detail: 'cw', source: 'cloudwatch' },
    ]);
    const a1 = await reader.alarms();
    expect(a1.find((x) => x.name === 'api-heartbeat')).toMatchObject({ state: 'ALARM', since: '2026-10-14T03:05:00.000Z' });
    expect(await reader.history('api-heartbeat', 10)).toEqual([
      { at: '2026-10-14T03:05:00.000Z', from: 'OK', to: 'ALARM', reason: 'gone' },
      { at: '2026-10-14T03:00:00.000Z', from: '—', to: 'OK', reason: 'ok' },
    ]);
    expect(await reader.history('api-heartbeat', 10, new Date('2026-10-14T03:01:00Z'))).toEqual([
      { at: '2026-10-14T03:05:00.000Z', from: 'OK', to: 'ALARM', reason: 'gone' },
    ]);
    await seedRoutes([{ min: 0, count: 5, status: '2xx' }, { min: 0, count: 1, status: '5xx' }]);
    const pts = await reader.series({ name: 'route.5xx', stat: 'sum', periodSec: 60, since: new Date('2026-10-14T02:00:00Z'), until: new Date('2026-10-14T04:00:00Z'), source: 'local' });
    expect(pts).toEqual([{ t: Date.parse('2026-10-14T03:00:00Z'), v: 1 }]);
    await seedHost('api', '2026-10-14T03:00:10.000Z', 0.4);
    const mem = await reader.series({ name: 'host.memUsedRatio', stat: 'avg', periodSec: 60, since: new Date('2026-10-14T02:00:00Z'), until: new Date('2026-10-14T04:00:00Z'), source: 'local' });
    expect(mem[0]!.v).toBe(0.4);
    void path;
  });
});
