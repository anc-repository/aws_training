import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json } from '../../test/helpers';
import { iso, mountAt, sessionView } from '../sessions/testHarness';
import ExperimentPage from './ExperimentPage';
import { declVariants, defaultRun, maybeUploadFailed, metricRows, runStatus, type ExperimentRun } from './runs';

const SID = 's4k7m2q9x1abc';
const routes = [{ path: '/sessions/:sid/experiments/:module/:experimentId', element: <ExperimentPage /> }];
const LAB = {
  id: 'svc-cdn',
  experiments: [
    { module: 'cdn', id: 'media-load', labels: [{ id: 'before', role: 'baseline' }, { id: 'after', role: 'treatment' }], pairs: [['before', 'after']], required: true },
    { module: 'cdn', id: 'compression', labels: ['after'], required: false },
  ],
};
const run = (over: Partial<ExperimentRun>): ExperimentRun => ({
  runId: '01JA000000000000000000BEFR',
  sessionId: SID,
  module: 'cdn',
  experiment: 'media-load',
  label: 'before',
  status: 'uploaded',
  registeredAt: iso(-100),
  finishedAt: iso(-95),
  validity: { status: 'valid', reasons: [] },
  summary: { client: { requests: 1000, errors: 0 } },
  server: { app: { requests: 1200 } },
  ...over,
});

describe('experiment runs model', () => {
  it('variants from string or object labels; roles inferred', () => {
    expect(declVariants({ labels: ['before', 'after'] })).toEqual([
      { label: 'before', role: 'baseline' },
      { label: 'after', role: 'treatment' },
    ]);
    expect(declVariants({ labels: ['after'] })).toEqual([{ label: 'after', role: 'single' }]);
    expect(declVariants(null, [run({}), run({ runId: 'x', label: 'after', variant: { role: 'treatment' } })]).map((v) => v.label)).toEqual(['before', 'after']);
  });

  it('status, default selection (latest valid) and upload-failure hint', () => {
    const older = run({ runId: 'a', finishedAt: iso(-90) });
    const newerInvalid = run({ runId: 'b', finishedAt: iso(-10), validity: { status: 'invalid', reasons: ['OUT_OF_WINDOW'] } });
    expect(defaultRun([older, newerInvalid], 'before')!.runId).toBe('a');
    const registered = run({ runId: 'c', finishedAt: undefined, status: 'registered', validity: null, registeredAt: iso(-45) });
    expect(runStatus(registered)).toBe('running');
    expect(maybeUploadFailed(registered, Date.now())).toBe(true);
    expect(runStatus(null)).toBe('none');
  });

  it('metric rows from the compare API or from the selected runs', () => {
    const v = declVariants({ labels: ['before', 'after'] });
    const rows = metricRows(v, { before: run({}), after: run({ label: 'after', server: { app: { requests: 96 } } }) });
    expect(rows.find((r) => r.id === 'server.app.requests')).toMatchObject({ label: '源站收到的请求数', values: { before: 1200, after: 96 } });
    const cmp = metricRows(v, {}, { a: 'before', b: 'after', result: { metrics: [{ metric: 'client.ttfb.p50', a: 182, b: 41 }] } });
    expect(cmp).toEqual([expect.objectContaining({ id: 'client.ttfb.p50', unit: 'ms', values: { before: 182, after: 41 } })]);
  });
});

describe('P06 对比实验视图', () => {
  const api = (runs: ExperimentRun[], extra: Record<string, unknown> = {}) => ({
    [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ state: 'RUNNING', endedAt: null, deadlineAt: iso(60) })),
    [`GET /api/v1/sessions/${SID}/events`]: json(200, { events: [], next: null, hasMore: false }),
    [`GET /api/v1/sessions/${SID}/experiment-runs`]: json(200, { items: runs }),
    'GET /content/2026.10.1/labs/svc-cdn.json': json(200, LAB),
    ...extra,
  });

  it('two variants: status, metric table with deltas, pair comparability, charts with a data-table view, run command for the missing one', async () => {
    const before = run({});
    const after = run({ runId: '01JA000000000000000000AFTR', label: 'after', finishedAt: iso(-20), validity: { status: 'pending-crosscheck', reasons: [] }, summary: { client: { requests: 1000 } }, server: { app: { requests: 96 } } });
    const { f } = mountAt(`/sessions/${SID}/experiments/cdn/media-load`, {
      routes,
      api: api([before, after], {
        'GET /api/v1/experiment-runs/compare': json(200, { comparable: true, reasons: [], metrics: [{ metric: 'server.app.requests', a: 1200, b: 96 }, { metric: 'client.ttfb.p50', a: 182, b: 41 }, { metric: 'client.ttfb.p95', a: 214, b: 198 }] }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: /svc-cdn › 对比实验 · cdn\/media-load（必做）/ })).toBeTruthy();
    const cols = await waitFor(() => {
      const c = document.querySelectorAll('[data-variant]');
      expect(c).toHaveLength(2);
      return c;
    });
    expect(cols[0]!.getAttribute('data-status')).toBe('valid');
    expect(cols[1]!.getAttribute('data-status')).toBe('pending-crosscheck');
    expect(cols[1]!.textContent).toContain('稍后自动复核');
    const table = await screen.findByRole('table', { name: /cdn\/media-load 的指标对照/ });
    await waitFor(() => expect(within(table).getByText('源站收到的请求数')).toBeTruthy());
    expect(table.textContent).toContain('▼ 下降');
    expect(table.textContent).toContain('▼ 下降 · 更快');
    expect(table.textContent).toContain('差异不明显');
    expect(await screen.findByText(/可比/)).toBeTruthy();
    expect(f.calls.find((c) => c.url.includes('/experiment-runs/compare'))!.url).toContain('a=01JA000000000000000000BEFR');
    expect(document.querySelectorAll('svg.chart[role="img"]').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: '查看数据表' }));
    expect(document.querySelectorAll('svg.chart').length).toBe(0);
    expect(screen.getByRole('button', { name: /复制命令：运行 after/ })).toBeTruthy();
  });

  it('no records yet: empty state with commands; single-variant experiments have no delta column', async () => {
    const a = mountAt(`/sessions/${SID}/experiments/cdn/media-load`, { routes, api: api([]) });
    expect(await screen.findByText('还没有运行这个实验。')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /复制命令/ })).toHaveLength(2);
    a.unmount();
    mountAt(`/sessions/${SID}/experiments/cdn/compression`, { routes, api: api([run({ experiment: 'compression', label: 'after', summary: { client: { requests: 10 } }, server: null })]) });
    const table = await screen.findByRole('table', { name: /cdn\/compression 的指标对照/ });
    expect(within(table).queryByRole('columnheader', { name: '差异' })).toBeNull();
  });

  it('ended sessions and observers are read-only (no run commands); invalid runs show the reason', async () => {
    mountAt(`/sessions/${SID}/experiments/cdn/media-load`, {
      group: 'observer',
      routes,
      api: api([run({}), run({ runId: 'r2', label: 'after', validity: { status: 'invalid', reasons: ['DRIVER_MISMATCH: storage=local (expected s3)'] } })], {
        [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ state: 'ENDED' })),
        'GET /api/v1/experiment-runs/compare': json(200, { comparable: false, reasons: ['DIFFERENT_INSTANCE_TYPE'], metrics: [] }),
      }),
    });
    expect((await screen.findAllByText(/运行时驱动与该变体要求不符/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /复制命令/ })).toBeNull();
    expect(screen.getByText(/运行命令已隐藏/)).toBeTruthy();
    expect(await screen.findByText(/实例类型不一致/)).toBeTruthy();
  });
});
