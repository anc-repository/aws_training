// observability：请求上下文、instrument 代理、Server-Timing / X-CloudAlbum-Path 生成、LabMetricsStore、故障注入
import { describe, expect, it } from 'vitest';
import { parsePathHeader, parseServerTiming } from '@cloudalbum/contracts';
import { NotImplementedError } from '../../src/errors.js';
import { FaultRegistry, FaultInjectedError } from '../../src/observability/faults.js';
import { instrument, type PortCallEvent } from '../../src/observability/instrument.js';
import { HIST_EDGES_MS, LabMetricsStore, LogHistogram, bucketIndex, type MetricRollup } from '../../src/observability/lab-metrics.js';
import { buildPathHeader, setInstanceIdentity } from '../../src/observability/path-header.js';
import { createRequestContext, currentContext, runWithContext } from '../../src/observability/request-context.js';
import { buildServerTimingHeader } from '../../src/observability/server-timing.js';
import type { Adapter, ProbeResult } from '../../src/ports/common.js';
import type { Request } from 'express';
import { routeTemplate, UNMATCHED_ROUTE } from '../../src/http/middleware/observability.js';

class FakeCache implements Adapter {
  readonly meta = { module: 'cache' as const, driver: 'redis', awsService: 'Amazon ElastiCache', authoritative: false };
  calls = 0;
  async probe(): Promise<ProbeResult> { return { status: 'ok', detail: 'ok' }; }
  async get(key: string): Promise<string> {
    this.calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return `v:${key}`;
  }
  async fail(): Promise<void> { throw new Error('boom'); }
  sync(): number { return 42; }
  async wrap<T>(loader: () => Promise<T>): Promise<T> { return loader(); }
}

describe('instrument + 请求上下文', () => {
  it('累加同一模块多次调用的耗时，路径段默认 = 驱动名，事件交给观察者', async () => {
    const events: PortCallEvent[] = [];
    const cache = instrument(new FakeCache(), { observers: [{ onCall: (e) => events.push(e) }], faults: new FaultRegistry() });
    const ctx = createRequestContext({ requestId: 'r1', entry: 'nginx' });
    await runWithContext(ctx, async () => {
      expect(currentContext()).toBe(ctx);
      await cache.get('a');
      await cache.get('b');
      expect(cache.sync()).toBe(42);
      await expect(cache.fail()).rejects.toThrow('boom');
    });
    const t = ctx.timing.entries();
    expect(t).toHaveLength(1);
    expect(t[0]?.module).toBe('cache');
    expect(t[0]?.count).toBe(4);
    expect(t[0]!.dur).toBeGreaterThanOrEqual(8);
    expect(ctx.path.get('cache')).toBe('redis');
    expect(events.map((e) => [e.method, e.ok])).toEqual([['get', true], ['get', true], ['sync', true], ['fail', false]]);
    expect(events.every((e) => e.inRequest)).toBe(true);
  });

  it('不计时的方法（probe、wrap 等）不经代理', async () => {
    const events: PortCallEvent[] = [];
    const raw = new FakeCache();
    const cache = instrument(raw, { observers: [{ onCall: (e) => events.push(e) }], faults: new FaultRegistry() });
    await cache.probe();
    await cache.wrap(async () => 1);
    expect(events).toEqual([]);
    expect(cache.meta).toBe(raw.meta);
  });

  it('路由 / 服务可用 ctx.path.mark 覆盖为完整值，outcome 只替换结果部分', () => {
    const ctx = createRequestContext({ entry: 'cloudfront>nginx' });
    ctx.path.markIfAbsent('cache', 'redis');
    ctx.path.mark('cache', 'redis@elasticache:miss');
    ctx.path.markIfAbsent('cache', 'redis');
    ctx.path.mark('storage', 's3');
    ctx.path.outcome('storage', 'presign');
    ctx.bypass.add('cache');
    setInstanceIdentity({ instanceId: 'i-0abc', az: 'ap-northeast-1a' });
    const header = buildPathHeader(ctx);
    setInstanceIdentity({});
    expect(header).toBe('entry=cloudfront>nginx;inst=i-0abc;az=ap-northeast-1a;cache=redis@elasticache:miss;storage=s3:presign;bypass=cache');
  });

  it('Server-Timing：total 在前、模块 desc 带调用次数、app = total − 端口耗时', () => {
    const ctx = createRequestContext({ startedAt: 0 });
    ctx.path.mark('database', 'postgres@rds');
    ctx.timing.add('database', 10);
    ctx.timing.add('database', 11.3);
    ctx.timing.add('database', 0);
    const parsed = parseServerTiming(buildServerTimingHeader(ctx, 48.7));
    expect(parsed[0]).toEqual({ name: 'total', dur: 48.7 });
    expect(parsed.find((m) => m.name === 'database')).toEqual({ name: 'database', dur: 21.3, desc: 'postgres@rds x3' });
    expect(parsed.find((m) => m.name === 'app')?.dur).toBeCloseTo(27.4, 1);
  });

  it('没有 Nginx 时 entry=direct', () => {
    expect(parsePathHeader(buildPathHeader(createRequestContext())).entry).toBe('direct');
  });
});

describe('故障注入（§8.4）', () => {
  it('latency / error 故障命中目标模块，并把路径段 outcome 标为 fault', async () => {
    const faults = new FaultRegistry(() => 0);
    const cache = instrument(new FakeCache(), { faults });
    const f = faults.add({ type: 'error', target: 'cache', durationSec: 60 });
    const ctx = createRequestContext();
    await runWithContext(ctx, async () => {
      await expect(cache.get('x')).rejects.toBeInstanceOf(FaultInjectedError);
    });
    expect(ctx.faults).toEqual([f.id]);
    expect(ctx.path.get('cache')).toBe('redis:fault');
    expect(faults.remove(f.id)).toBe(true);
    expect(faults.list()).toEqual([]);
  });

  it('必须带 durationSec 且会自动过期', () => {
    let now = 1_000_000;
    const faults = new FaultRegistry(() => 0, () => now);
    expect(() => faults.add({ type: 'latency', target: 'database', ms: 5, durationSec: 0 })).toThrow();
    expect(() => faults.add({ type: 'latency', durationSec: 10 })).toThrow();
    faults.add({ type: 'error5xx', rate: 1, durationSec: 10 });
    expect(faults.beforeRequest()?.error).toBeInstanceOf(FaultInjectedError);
    now += 11_000;
    expect(faults.beforeRequest()).toBeNull();
    expect(faults.active).toBe(false);
  });
});

describe('LabMetricsStore（§7.3）', () => {
  it('对数分桶：1ms～60s，百分位取桶上边界且不超过最大值', () => {
    expect(bucketIndex(0.5)).toBe(0);
    expect(bucketIndex(1)).toBe(1);
    expect(HIST_EDGES_MS.at(-1)).toBeGreaterThan(60_000);
    const h = new LogHistogram();
    for (let i = 1; i <= 100; i += 1) h.add(i);
    expect(h.count).toBe(100);
    expect(h.percentile(50)).toBeGreaterThanOrEqual(50);
    expect(h.percentile(50)).toBeLessThan(60);
    expect(h.percentile(100)).toBe(100);
  });

  it('请求与端口调用按分钟汇总，flush 交给 sink；sink 失败时保留数据重试', async () => {
    const store = new LabMetricsStore({ role: 'api', instanceId: () => 'i-test' });
    const written: MetricRollup[][] = [];
    let fail = true;
    store.setSink({
      writeRollups: async (rows) => {
        if (fail) throw new Error('db down');
        written.push(rows);
      },
      writeHostSamples: async () => undefined,
    });
    for (const ms of [5, 10, 20]) {
      store.recordRequest({ ts: new Date().toISOString(), requestId: `r${ms}`, method: 'GET', route: '/api/feed', status: 200,
        totalMs: ms, path: 'entry=direct;database=sqlite', pathSig: 'entry=direct;database=sqlite', modules: { database: ms / 2 }, runId: 'run1' });
    }
    store.onCall({ module: 'database', driver: 'sqlite', method: 'query', ms: 2, ok: false, inRequest: true });
    await store.flush();
    expect(store.status().lastFlushError).toBe('db down');
    fail = false;
    await store.flush();
    const rows = written.flat();
    expect(rows).toHaveLength(2);
    const route = rows.find((r) => r.kind === 'route')!;
    expect(route).toMatchObject({ instanceId: 'i-test', role: 'api', route: '/api/feed', runId: 'run1', count: 3, errors: 0, maxMs: 20 });
    expect(rows.find((r) => r.kind === 'port')).toMatchObject({ module: 'database', driver: 'sqlite', op: 'query', errors: 1 });
    expect(store.recent(2).map((r) => r.requestId)).toEqual(['r20', 'r10']);
    expect(store.summarizeRecent({ runId: 'run1', groupBy: 'route' })[0]).toMatchObject({ group: 'GET /api/feed', count: 3 });
    expect(store.toPrometheus()).toContain('cloudalbum_requests_total{role="api"} 3');
  });

  it('主机采样在任何平台上都有基本字段', () => {
    const s = new LabMetricsStore({ role: 'worker' }).sampleHost();
    expect(s.role).toBe('worker');
    expect(s.rssBytes).toBeGreaterThan(0);
    expect(s.memUsedRatio).toBeGreaterThan(0);
  });
});

describe('routeTemplate（LabMetricsStore 的汇总键必须有界）', () => {
  const req = (p: { path: string; route?: { path: unknown }; baseUrl?: string }) =>
    ({ path: p.path, originalUrl: p.path, url: p.path, baseUrl: p.baseUrl ?? '', route: p.route }) as unknown as Request;

  it('具体路由用模板；未匹配的 404 一律 <unmatched>；中间件拒绝按一级前缀；通配路由失败按模式本身', () => {
    expect(routeTemplate(req({ path: '/api/photos/123', route: { path: '/api/photos/:id' } }), undefined, 404)).toBe('/api/photos/:id');
    expect(routeTemplate(req({ path: '/api/x7Gq2pZr' }), undefined, 404)).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate(req({ path: '/api/aaaa/bbbb/cccc' }), undefined, 404)).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate(req({ path: '/api/random-1' }), undefined, 403)).toBe('/api/*');
    expect(routeTemplate(req({ path: '/zzz/random-2' }), undefined, 401)).toBe('/<other>/*');
    expect(routeTemplate(req({ path: '/api/me/whatever-9', route: { path: '/api/me/*rest' } }), undefined, 404)).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate(req({ path: '/media/raw/random', route: { path: '/media/*rest' } }), undefined, 403)).toBe('/media/*rest');
    const owner = '11111111-2222-4333-8444-555555555555';
    expect(routeTemplate(req({ path: `/media/raw/${owner}/${owner}.jpg`, route: { path: '/media/*rest' } }), undefined, 200))
      .toBe('/media/raw/:id/:id.jpg');
  });
});

describe('NotImplementedError', () => {
  it('携带组件、成员与模块', () => {
    const e = new NotImplementedError('LocalStorage', 'putObject', 'storage');
    expect(e.status).toBe(501);
    expect(e.message).toContain('LocalStorage.putObject');
  });
});
