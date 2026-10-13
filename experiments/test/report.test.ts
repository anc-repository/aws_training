import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildReport, generateReport, judge, parseReportArgs, renderHtml, renderMarkdown, variantView } from '../_lib/report.js';
import { validateResult } from '../_lib/schema.js';
import type { ResultDoc } from '../_lib/types.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'exp-report-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function result(label: string, over: Partial<ResultDoc> & { p95: number; cpu: number; lost: number; runId: string; startedAt: string }): ResultDoc {
  const { p95, cpu, lost, ...rest } = over;
  return {
    schemaVersion: 1, module: 'queue', experiment: 'upload-burst', label, variant: label, forced: false,
    finishedAt: over.startedAt, target: 'http://mock', params: { vus: 10, duration: '60s', repeat: 1, ab: false },
    environment: { drivers: { queue: label === 'after' ? 'sqs' : 'memory', storage: 'local' }, statuses: { queue: label === 'after' ? 'ok' : 'off' }, capabilitiesHash: `sha256:${'0'.repeat(64)}`, instanceType: 't4g.small' },
    client: {
      requests: 100, errors: 0, errorRate: 0,
      latencyMs: { 'POST /api/photos/:id/complete': { method: 'POST', route: '/api/photos/:id/complete', count: 100, errors: 0, p50: p95 / 2, p95, p99: p95 * 1.2, max: p95 * 2 } },
      paths: { 'entry=nginx;queue=sqs:queued': 100 },
    },
    server: { available: true, routes: {}, ports: {}, host: { samples: 4, cpuP95: cpu }, business: { jobsLost: lost, photoTimeToReadyP95: 1000 } },
    faults: [], notes: '',
    spec: {
      title: 'queue upload burst', kind: 'before-after', metrics: ['client.http_req_duration{route:/api/photos/complete}.p95', 'host.cpu.p95', 'biz.jobs_lost'],
      expect: [
        { metric: 'client.http_req_duration{route:/api/photos/complete}.p95', direction: 'down' },
        { metric: 'host.cpu.p95', direction: 'flat' },
        { metric: 'biz.jobs_lost', direction: 'zero' },
        { metric: 'biz.missing_metric', direction: 'down' },
      ],
    },
    ...rest,
  } as ResultDoc;
}

describe('judge', () => {
  it('applies directions with a noise band', () => {
    expect(judge('down', { value: 100 }, { value: 50 }, 0.1).verdict).toBe('pass');
    expect(judge('down', { value: 100 }, { value: 95 }, 0.1).verdict).toBe('inconclusive');
    expect(judge('down', { value: 100 }, { value: 150 }, 0.1).verdict).toBe('fail');
    expect(judge('up-or-flat', { value: 100 }, { value: 97 }, 0.1).verdict).toBe('pass');
    expect(judge('down-or-flat', { value: 100 }, { value: 200 }, 0.1).verdict).toBe('fail');
    expect(judge('flat', { value: 100, min: 50, max: 150 }, { value: 140 }, 0).verdict).toBe('pass');
    expect(judge('zero', {}, { value: 0 }, 0.1).verdict).toBe('pass');
    expect(judge('nonzero', {}, { value: 0 }, 0.1).verdict).toBe('fail');
    expect(judge('down', {}, { value: 1 }, 0.1).verdict).toBe('missing');
    // 毫秒类指标的 1 ms 噪声下限：1.6 → 1.8 不算“变慢”
    expect(judge('down-or-flat', { value: 1.6 }, { value: 1.8 }, 0.1).verdict).toBe('fail');
    expect(judge('down-or-flat', { value: 1.6 }, { value: 1.8 }, 0.1, 1).verdict).toBe('pass');
  });
});

describe('report', () => {
  const before = result('before', { runId: '01JA0000000000000000000001', startedAt: '2026-10-13T01:00:00Z', p95: 80, cpu: 90, lost: 3 });
  const after = result('after', { runId: '01JA0000000000000000000002', startedAt: '2026-10-13T02:00:00Z', p95: 20, cpu: 88, lost: 0, forced: true, warnings: ['强制运行'] });

  it('builds comparisons, environment diff, verdicts and renders md/html', () => {
    expect(validateResult(before).ok).toBe(true);
    const d = buildReport({ label: 'before', file: 'b.json', doc: before }, { label: 'after', file: 'a.json', doc: after }, { noise: 0.1 });
    expect(d.environmentDiff).toEqual([{ module: 'queue', before: 'memory', after: 'sqs', statusBefore: 'off', statusAfter: 'ok' }]);
    expect(d.expectations.map((e) => e.verdict)).toEqual(['pass', 'pass', 'pass', 'missing']);
    const p95 = d.metrics.find((m) => m.key === 'client.http_req_duration{route:/api/photos/complete}.p95')!;
    expect(p95.diff).toBe(-60);
    expect(p95.ratio).toBe(0.25);
    expect(d.warnings[0]).toMatch(/^\[FORCED\] after/);
    expect(d.comparable).toBe(true);
    const md = renderMarkdown(d);
    expect(md).toContain('# queue/upload-burst 对比报告：before → after');
    expect(md).toContain('**[FORCED] after');
    expect(md).toContain('| queue | memory（off） | sqs（ok） |');
    expect(md).toContain('**符合**');
    expect(md).toContain('**缺少数据**');
    const html = renderHtml(d);
    expect(html).toContain('<svg');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('flags incomparable runs', () => {
    const other = { ...after, params: { ...after.params, vus: 50 }, environment: { ...after.environment, instanceType: 't4g.large' } };
    const d = buildReport({ label: 'before', file: 'b', doc: before }, { label: 'after', file: 'a', doc: other });
    expect(d.comparable).toBe(false);
    expect(d.warnings.join('\n')).toMatch(/参数不同/);
    expect(d.warnings.join('\n')).toMatch(/实例类型不同/);
  });

  it('builds A/B variant views from one --ab run', () => {
    const ab: ResultDoc = {
      ...after, label: 'after', forced: false, warnings: [], params: { ...after.params, ab: true },
      client: {
        ...after.client,
        byVariant: {
          'after:A': { requests: 50, errors: 0, latencyMs: { 'GET /api/feed': { count: 50, errors: 0, p95: 30 } }, serverTiming: { database: { count: 50, calls: 150, callsPerRequest: 3, descs: {} } } },
          'after:B': { requests: 50, errors: 0, latencyMs: { 'GET /api/feed': { count: 50, errors: 0, p95: 5 } }, serverTiming: {} },
        },
      },
      server: { ...after.server, paths: {
        'GET /api/feed | entry=nginx;cache=redis@elasticache:bypass;database=sqlite;bypass=cache': { count: 50, errors: 0, p95: 28 },
        'GET /api/feed | entry=nginx;cache=redis@elasticache:hit': { count: 40, errors: 0, p95: 3 },
        'GET /api/feed | entry=nginx;cache=redis@elasticache:miss;database=sqlite': { count: 10, errors: 0, p95: 25 },
      } },
    };
    const a = variantView(ab, 'A');
    const b = variantView(ab, 'B');
    expect(a.client.latencyMs['GET /api/feed']!.p95).toBe(30);
    expect(a.server.routes['GET /api/feed']!.p95).toBe(28);
    expect(b.server.routes['GET /api/feed']!.p95).toBe(3);
    const d = buildReport({ label: 'after:A', file: 'x', doc: a }, { label: 'after:B', file: 'x', doc: b }, {
      spec: { expect: [{ metric: 'client.http_req_duration{route:/api/feed}.p95', direction: 'down' }, { metric: 'client.timing.database.calls_per_request', direction: 'down' }] },
    });
    expect(d.expectations.map((e) => e.verdict)).toEqual(['pass', 'pass']);
    expect(d.warnings.join('\n')).toMatch(/同一次运行/);
    expect(() => variantView(before, 'A')).toThrow(/没有变体/);
  });

  it('generateReport picks the latest results per label and writes md/json/html', () => {
    const results = path.join(tmp, 'results');
    const out = path.join(tmp, 'reports');
    mkdirSync(path.join(results, 'queue'), { recursive: true });
    const older = result('after', { runId: '01JA0000000000000000000000', startedAt: '2026-10-13T00:00:00Z', p95: 999, cpu: 1, lost: 9 });
    for (const [name, doc] of [['a-old.json', older], ['b.json', before], ['a.json', after]] as const) {
      writeFileSync(path.join(results, 'queue', name), JSON.stringify(doc));
    }
    writeFileSync(path.join(results, 'queue', 'junk.json'), '{not json');
    const r = generateReport(parseReportArgs(['queue', '--results', results, '--out', out, '--format', 'md,json,html']), { now: new Date('2026-10-13T03:00:00Z') });
    expect(r.files.map((f) => path.basename(f))).toEqual(['20261013T030000Z__upload-burst.md', '20261013T030000Z__upload-burst.json', '20261013T030000Z__upload-burst.html']);
    expect(r.data.sources.after.runId).toBe(after.runId);
    const json = JSON.parse(readFileSync(r.files[1]!, 'utf8')) as { expectations: Array<{ verdictText: string }> };
    expect(json.expectations[0]!.verdictText).toBe('符合');
    // 指定文件
    const r2 = generateReport(parseReportArgs(['queue', '--results', results, '--out', out, '--after', path.join(results, 'queue', 'a-old.json'), '--format', 'md']));
    expect(r2.data.sources.after.runId).toBe(older.runId);
    expect(r2.data.expectations[0]!.verdict).toBe('fail');
    expect(() => generateReport(parseReportArgs(['queue', '--results', results, '--pair', 'before,selfhost']))).toThrow(/没有实验 upload-burst 标签 selfhost/);
    expect(() => parseReportArgs(['queue', '--format', 'pdf'])).toThrow();
    expect(() => parseReportArgs(['queue', '--pair', 'only-one'])).toThrow();
  });
});
