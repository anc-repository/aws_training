import { describe, expect, it } from 'vitest';
import { capabilitiesHash, checkRequires, environmentOf, portRows, summarizeHost, summarizeOrigin, valueMatches } from '../_lib/collect.js';
import { AbState, BypassLimiter, cookieValue } from '../_lib/http.js';
import { corruptJpeg, padJpeg, testJpeg } from '../_lib/images.js';
import { runRate, runVus, zipfSampler } from '../_lib/load.js';
import { canonicalMetric, findRoute, isLatencyMetric, normRoute, resolveMetric } from '../_lib/metrics.js';
import { Recorder, routeTemplate, summarizeSlice } from '../_lib/stats.js';
import type { Capabilities, ResultDoc } from '../_lib/types.js';
import { fileTimestamp, formatDuration, getPath, median, parseDuration, parseKeyValues, percentile, stableStringify, toCamel } from '../_lib/util.js';

describe('util', () => {
  it('parses durations', () => {
    expect(parseDuration('60s')).toBe(60_000);
    expect(parseDuration('1m30s')).toBe(90_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('250')).toBe(250);
    expect(parseDuration(undefined, 7)).toBe(7);
    expect(() => parseDuration('soon')).toThrow(/时长/);
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(850)).toBe('850ms');
  });

  it('computes nearest-rank percentiles and medians', () => {
    const v = Array.from({ length: 100 }, (_x, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 99)).toBe(99);
    expect(percentile([], 50)).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('stable stringify, camel case, paths, key/values, timestamps', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: undefined } })).toBe('{"a":{"d":[1,2]},"b":1}');
    expect(toCamel('photo_time_to_ready_p95')).toBe('photoTimeToReadyP95');
    expect(toCamel('event_loop_delay_p99')).toBe('eventLoopDelayP99');
    expect(getPath({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
    expect(parseKeyValues(['a=1', 'b=x=y'])).toEqual({ a: '1', b: 'x=y' });
    expect(() => parseKeyValues(['oops'])).toThrow();
    expect(fileTimestamp(new Date('2026-10-13T06:00:01.234Z'))).toBe('20261013T060001Z');
  });
});

describe('stats', () => {
  it('templates routes', () => {
    expect(routeTemplate('/api/photos/01JA3K9V7Q4M2X8N5B6C0D1E2F/complete?x=1')).toBe('/api/photos/:id/complete');
    expect(routeTemplate('/api/albums/0b9c6f3e-7f6a-4c43-9a43-0e8a1b2c3d4e')).toBe('/api/albums/:id');
    expect(routeTemplate('/api/feed')).toBe('/api/feed');
  });

  it('aggregates latency, Server-Timing calls, path signatures and variants', () => {
    const r = new Recorder();
    for (let i = 0; i < 10; i += 1) {
      const bypass = i % 2 === 0;
      r.record({
        method: 'GET', route: '/api/feed', status: 200, ok: true, totalMs: bypass ? 20 + i : 2 + i, variant: bypass ? 'after:A' : 'after:B', target: 'direct',
        serverTiming: bypass ? [{ name: 'total', dur: 20 }, { name: 'database', dur: 9, desc: 'sqlite x3' }] : [{ name: 'total', dur: 2 }, { name: 'cache', dur: 0.1, desc: 'memory:hit' }],
        pathHeader: bypass ? 'entry=direct;inst=i-1;cache=memory:bypass;database=sqlite;bypass=cache' : 'entry=direct;inst=i-1;cache=memory:hit',
      });
    }
    r.record({ method: 'POST', route: '/api/albums', status: 500, ok: false, totalMs: 5, target: 'direct' });
    const s = r.summary();
    expect(s.requests).toBe(11);
    expect(s.errors).toBe(1);
    expect(s.latencyMs['GET /api/feed']!.count).toBe(10);
    expect(s.serverTiming!.database!.calls).toBe(15);
    expect(s.serverTiming!.database!.descs).toEqual({ sqlite: 5 });
    expect(s.paths!['entry=direct;cache=memory:hit']).toBe(5);
    expect(s.outcomes!.cache).toEqual({ 'memory:bypass': 5, 'memory:hit': 5 });
    expect(s.instances).toEqual({ 'i-1': 10 });
    expect(Object.keys(s.byVariant!)).toEqual(['after:A', 'after:B']);
    expect(s.byVariant!['after:A']!.serverTiming!.database!.callsPerRequest).toBe(3);
    expect(s.byVariant!['after:B']!.serverTiming!.database).toBeUndefined();
    expect(s.byTarget).toBeUndefined();
    expect(summarizeSlice([]).requests).toBe(0);
  });

  it('slices by repeat and stage', () => {
    const r = new Recorder();
    r.repeat = 1;
    r.stage = 'vus=1';
    r.record({ method: 'GET', route: '/x', status: 200, ok: true, totalMs: 1 });
    r.repeat = 2;
    r.stage = 'vus=5';
    r.record({ method: 'GET', route: '/x', status: 200, ok: true, totalMs: 3 });
    expect(r.sliceForRepeat(2).latencyMs['GET /x']!.p50).toBe(3);
    expect(Object.keys(r.summary().byStage!)).toEqual(['vus=1', 'vus=5']);
  });
});

describe('http helpers', () => {
  it('alternates A/B and parses cookies', () => {
    const ab = new AbState('cache');
    expect([ab.next(), ab.next(), ab.next()]).toEqual(['A', 'B', 'A']);
    expect(cookieValue(['ca_rt=1; Path=/api/auth', 'ca_at=abc.def; Path=/; HttpOnly'], 'ca_at')).toBe('abc.def');
  });

  it('limits bypass concurrency', async () => {
    const l = new BypassLimiter(6000, 2, 10);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      await l.acquire();
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      l.release();
    }));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('load', () => {
  it('runs VUs until the iteration cap', async () => {
    let n = 0;
    const s = await runVus({ vus: 3, durationMs: 5_000, iterations: 10 }, async () => { n += 1; });
    expect(n).toBe(10);
    expect(s.iterations).toBe(10);
  });

  it('runs at a fixed rate and stops on until()', async () => {
    let n = 0;
    const s = await runRate({ ratePerSec: 100, durationMs: 5_000, until: () => n >= 5 }, async () => { n += 1; });
    expect(s.iterations).toBeGreaterThanOrEqual(5);
    expect(s.elapsedMs).toBeLessThan(2_000);
  });

  it('samples Zipf indexes', () => {
    const next = zipfSampler(10, 1.2, (() => { let i = 0; return () => ((i += 0.37) % 1); })());
    for (let i = 0; i < 20; i += 1) expect(next()).toBeGreaterThanOrEqual(0);
  });
});

describe('images', () => {
  it('generates and pads JPEGs', async () => {
    const img = await testJpeg({ width: 64, height: 48, targetBytes: 200_000 });
    expect(img.buffer[0]).toBe(0xff);
    expect(img.buffer[1]).toBe(0xd8);
    expect(img.buffer.length).toBe(200_000);
    expect(padJpeg(Buffer.from([1, 2, 3]), 100).length).toBe(3);
    const c = corruptJpeg(1000);
    expect(c.length).toBe(1000);
    expect(c[0]).toBe(0xff);
  });
});

const caps = (drivers: Record<string, string>, statuses: Record<string, string> = {}): Capabilities => ({
  schemaVersion: 2, generatedAt: '2026-10-13T00:00:00Z', view: 'admin',
  app: { version: '1', profile: 'l0-ec2', deployMode: 'single', region: 'ap-northeast-1', instance: { id: 'i-1', az: 'a', type: 't4g.small', role: 'api' },
    entry: { baseUrl: 'http://x', source: 'base' }, configHash: 'h', startedAt: '2026-10-13T00:00:00Z' },
  https: { trusted: false, via: 'none' }, validation: { errors: [], warnings: [], overridden: [] },
  modules: Object.fromEntries(Object.entries(drivers).map(([id, d]) => [id, { driver: d, status: statuses[id] ?? 'off', awsService: '', type: 'adapter', detail: '', lastProbeAt: String(Math.random()) }])) as unknown as Capabilities['modules'],
  features: {}, lab: { bypassEnabled: true, bypassKeys: [] },
});

describe('collect', () => {
  it('checks requires with scalars, any-of arrays, negation and app keys', () => {
    const c = caps({ queue: 'sqs', 'image-processing': 'worker' }, { queue: 'degraded' });
    expect(checkRequires(c, { 'queue.driver': 'sqs', 'image-processing.driver': 'worker', 'queue.status': ['ok', 'degraded'] }).ok).toBe(true);
    const bad = checkRequires(c, { 'queue.driver': 'memory', 'app.deployMode': 'single', 'cache.driver': null });
    expect(bad.ok).toBe(false);
    expect(bad.mismatches).toEqual([{ key: 'queue.driver', expected: 'memory', actual: 'sqs' }]);
    expect(valueMatches('sqs', '!memory')).toBe(true);
    expect(valueMatches(undefined, '*')).toBe(false);
  });

  it('hashes only stable capability fields', () => {
    const a = caps({ queue: 'sqs' });
    const b = caps({ queue: 'sqs' });
    expect(capabilitiesHash(a)).toBe(capabilitiesHash(b));
    expect(capabilitiesHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(capabilitiesHash(caps({ queue: 'memory' }))).not.toBe(capabilitiesHash(a));
    const env = environmentOf(a);
    expect(env.drivers).toEqual({ queue: 'sqs' });
    expect(env.instanceType).toBe('t4g.small');
  });

  it('summarizes host samples (CPU per 10 s bucket, net counter deltas) and ports', () => {
    const h = summarizeHost([
      { ts: '2026-10-13T00:00:00Z', instance_id: 'i', role: 'api', cpu_pct: 10, net_rx_bytes: 100, net_tx_bytes: 10, event_loop_delay_p99_ms: 5 },
      { ts: '2026-10-13T00:00:00Z', instance_id: 'i', role: 'worker', cpu_pct: 30, net_rx_bytes: 100, net_tx_bytes: 10 },
      { ts: '2026-10-13T00:00:10Z', instance_id: 'i', role: 'api', cpu_pct: 50, net_rx_bytes: '1100', net_tx_bytes: 60, event_loop_delay_p99_ms: 40 },
    ]);
    expect(h.samples).toBe(3);
    expect(h.cpuMax).toBe(50);
    expect(h.cpuP95).toBe(50);
    expect(h.netRxBytes).toBe(1000);
    expect(h.netTxBytes).toBe(50);
    expect(h.eventLoopDelayP99).toBe(40);
    expect(h.byRole!.worker!.samples).toBe(1);
    const ports = portRows([
      { group: 'storage:local', count: 10, errors: 1, p50: 1, p95: 2, p99: 3, max: 4 },
      { group: 'storage:s3', count: 2, errors: 0, p50: 5, p95: 6, p99: 7, max: 8 },
    ]);
    expect(ports.storage!.calls).toBe(12);
    expect(ports.storage!.driver).toBe('local');
    expect(ports.storage!.p95).toBe(2);
    expect(Object.keys(ports.storage!.drivers!)).toEqual(['local', 's3']);
    expect(summarizeOrigin([{ requests: 3, bytes: 10, via_cloudfront: 1, via_alb: 0, direct: 2 }])).toMatchObject({ requests: 3, viaCloudfront: 1, direct: 2 });
    expect(summarizeOrigin([])).toBeUndefined();
  });
});

describe('metrics', () => {
  const doc = {
    schemaVersion: 1, runId: '01JA3M2C8Y3T5Q6W7E8R9T0Y1U', module: 'queue', experiment: 'upload-burst', label: 'after', variant: 'after', forced: false,
    startedAt: '', finishedAt: '', target: 'http://x', params: { vus: 1, duration: '1s', repeat: 2, ab: false },
    environment: { drivers: {}, capabilitiesHash: 'none' },
    client: {
      requests: 3, errors: 0, errorRate: 0,
      latencyMs: { 'POST /api/photos/:id/complete': { count: 3, errors: 0, p50: 10, p95: 20 }, 'GET /api/feed': { count: 1, errors: 0, p95: 7 } },
      serverTiming: { database: { count: 3, calls: 9, callsPerRequest: 3, descs: {} } },
      outcomes: { cache: { 'redis@elasticache:hit': 3, 'redis@elasticache:miss': 1 } },
    },
    server: {
      available: true, routes: { 'POST /api/photos/:id/complete': { count: 3, errors: 0, p95: 15 } },
      ports: { queue: { count: 3, calls: 3, errors: 0, p95: 4 } }, host: { samples: 2, cpuP95: 33, netRxBytes: 1000 },
      business: { photoTimeToReadyP95: 900, jobsLost: 0 },
    },
    scenario: { findings: { staleRatio: 0.5, ok: true, nested: { x: '12' } } },
    repeats: [
      { index: 1, startedAt: '', finishedAt: '', client: { requests: 1, errors: 0, latencyMs: { 'POST /api/photos/:id/complete': { count: 1, errors: 0, p95: 10 } } }, business: { jobsLost: 0 } },
      { index: 2, startedAt: '', finishedAt: '', client: { requests: 1, errors: 0, latencyMs: { 'POST /api/photos/:id/complete': { count: 1, errors: 0, p95: 30 } } }, business: { jobsLost: 2 } },
    ],
    faults: [], notes: '',
  } as unknown as ResultDoc;

  it('normalizes and finds routes', () => {
    expect(normRoute('POST /api/photos/:id/complete')).toEqual({ method: 'POST', path: '/api/photos/complete' });
    expect(normRoute('/api/feed | entry=direct;cache=x')).toEqual({ path: '/api/feed' });
    expect(findRoute(doc.client.latencyMs, '/api/photos/complete')?.p50).toBe(10);
    expect(findRoute(doc.client.latencyMs, 'GET /api/photos/complete')).toBeUndefined();
  });

  it('resolves §8.2-style metric keys', () => {
    expect(resolveMetric(doc, 'client.http_req_duration{route:/api/photos/complete}.p95')).toMatchObject({ value: 20, min: 10, max: 30, n: 2 });
    expect(resolveMetric(doc, 'client.route.GET /api/feed.p95').value).toBe(7);
    expect(resolveMetric(doc, 'client.timing.database.calls_per_request').value).toBe(3);
    expect(resolveMetric(doc, 'client.timing.cache.calls').value).toBe(0);
    expect(resolveMetric(doc, 'client.outcome_ratio.cache.hit').value).toBe(0.75);
    expect(resolveMetric(doc, 'client.error_rate').value).toBe(0);
    expect(resolveMetric(doc, 'server.route./api/photos/complete.p95').value).toBe(15);
    expect(resolveMetric(doc, 'server.port.queue.dur.p95').value).toBe(4);
    expect(resolveMetric(doc, 'server.port.storage.calls').value).toBe(0);
    expect(resolveMetric(doc, 'host.cpu.p95').value).toBe(33);
    expect(resolveMetric(doc, 'host.net_rx_bytes').value).toBe(1000);
    expect(resolveMetric(doc, 'biz.photo_time_to_ready.p95').value).toBe(900);
    expect(resolveMetric(doc, 'biz.jobs_lost')).toMatchObject({ value: 1, min: 0, max: 2 });
    expect(resolveMetric(doc, 'scenario.staleRatio').value).toBe(0.5);
    expect(resolveMetric(doc, 'scenario.ok').value).toBe(1);
    expect(resolveMetric(doc, 'scenario.nested.x').value).toBe(12);
    expect(resolveMetric(doc, 'scenario.missing').value).toBeUndefined();
  });

  it('canonicalizes metric keys for de-duplication and recognizes latency metrics', () => {
    expect(canonicalMetric('client.http_req_duration{route:/api/photos/complete}.p95', [doc]))
      .toBe(canonicalMetric('client.route.POST /api/photos/:id/complete.p95', [doc]));
    expect(canonicalMetric('client.route.GET /api/feed.p95', [doc])).not.toBe(canonicalMetric('client.route.POST /api/feed.p95', [doc]));
    expect(canonicalMetric('host.cpu.p95')).toBe(canonicalMetric('host.cpu_p95'));
    expect(canonicalMetric('biz.photo_time_to_ready.p95')).toBe(canonicalMetric('biz.photo_time_to_ready_p95'));
    expect(canonicalMetric('client.timing.database.calls_per_request')).toBe('client.timing.database.callsPerRequest');
    expect(isLatencyMetric('client.http_req_duration{route:/api/feed}.p95')).toBe(true);
    expect(isLatencyMetric('biz.photo_time_to_ready.p95')).toBe(true);
    expect(isLatencyMetric('host.net_rx_bytes')).toBe(false);
    expect(isLatencyMetric('client.timing.database.calls_per_request')).toBe(false);
    expect(isLatencyMetric('biz.jobs_lost')).toBe(false);
  });
});
