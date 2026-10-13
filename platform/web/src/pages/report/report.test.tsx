import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem } from '../../test/helpers';
import { iso, mountAt, sessionView } from '../sessions/testHarness';
import ReportPage from './ReportPage';

const SID = 's4k7m2q9x1abc';
const routes = [{ path: '/sessions/:sid/report', element: <ReportPage /> }];
const LAB = {
  id: 'svc-cdn',
  title: 'Amazon CloudFront：内容分发与边缘缓存',
  steps: [
    { id: 'observe-direct', type: 'observe', title: '观察直连源站', checks: ['entry-direct-baseline'] },
    { id: 'enable-cdn', type: 'script', title: '启用 CloudFront 并接入应用', checks: ['distribution-deployed'] },
  ],
  checks: {
    'entry-direct-baseline': { id: 'entry-direct-baseline', title: '入口直连源站', type: 'capability' },
    'distribution-deployed': { id: 'distribution-deployed', title: '分配已部署', type: 'aws-readonly' },
  },
  experiments: [{ module: 'cdn', id: 'media-load', labels: [{ id: 'before', role: 'baseline' }, { id: 'after', role: 'treatment' }], pairs: [['before', 'after']], required: true }],
};
const REPORT = {
  sessionId: SID,
  version: 2,
  generatedAt: iso(-60),
  reason: 'cleanup',
  digest: 'sha256:5d1e8b3f02ac00000000000000000000000000000000000000000000000000',
  summary: { stepsDone: 2, stepsTotal: 2, evidenceQuality: { high: 12, medium: 2, low: 0 }, experiments: 1, durationMinutes: 91, attemptStatus: 'completed' },
  eligibility: { badge: true, reasons: [] },
  downloads: { json: { url: 'https://bucket.s3.amazonaws.com/r.json?sig' }, html: { url: 'https://bucket.s3.amazonaws.com/r.html?sig' } },
  revisions: [{ version: 2 }, { version: 1 }],
};
const api = (extra: Record<string, unknown> = {}) => ({
  [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ startProfile: 'atl/svc-cdn/default', labVersion: '1.0.0' })),
  [`GET /api/v1/sessions/${SID}/events`]: json(200, { events: [], next: null, hasMore: false }),
  [`GET /api/v1/sessions/${SID}/report`]: json(200, REPORT),
  [`GET /api/v1/sessions/${SID}/steps`]: json(200, {
    items: [
      { stepId: 'observe-direct', state: 'done', firstPassedAt: iso(-180), checks: { 'svc-cdn/entry-direct-baseline': { effective: 'pass', lastPass: { at: iso(-180), evidenceDigest: 'sha256:1e5f0c9a7b3d2e11', provenance: 'this-session' } } } },
      { stepId: 'enable-cdn', state: 'done', checks: { 'svc-cdn/distribution-deployed': { effective: 'pass', ownershipPending: true, lastPass: { at: iso(-150) } } } },
    ],
  }),
  [`GET /api/v1/sessions/${SID}/check-runs`]: json(200, { items: [{ runId: 'r1', trigger: 'learner', finishedAt: iso(-150), results: [{ checkKey: 'svc-cdn/distribution-deployed', checkId: 'distribution-deployed', result: 'pass' }] }], next: null }),
  [`GET /api/v1/sessions/${SID}/experiment-runs`]: json(200, { items: [] }),
  [`GET /api/v1/sessions/${SID}/report/shares`]: json(200, { items: [{ shareId: 'Xk2Qm8Rt4Wz0123456789A', status: 'active', url: '/share/Xk2Qm8Rt4Wz0123456789A/index.html', createdAt: iso(-30), expiresAt: iso(43000) }] }),
  'GET /api/v1/me/progress': json(200, { labs: [{ labId: 'svc-cdn', badge: { level: 'verified', status: 'valid', attemptId: SID, evidenceScore: 0.97, quiz: { bestScore: 3, attempts: 1 } } }] }),
  'GET /content/2026.10.1/labs/svc-cdn.json': json(200, LAB),
  ...extra,
});

describe('P08 实验报告', () => {
  it('summary, steps from session data, experiments, appendix, shares; masked account', async () => {
    mountAt(`/sessions/${SID}/report`, { routes, api: api() });
    expect(await screen.findByRole('heading', { level: 1, name: 'svc-cdn · 实验报告' })).toBeTruthy();
    expect(await screen.findByText(/第 2 版（追加清理结果）/)).toBeTruthy();
    const summary = screen.getByRole('heading', { name: '摘要' }).closest('section')!;
    await waitFor(() => expect(summary.textContent).toContain('徽章“边缘缓存” · 已核验（证据分 0.97）'));
    expect(summary.textContent).toContain('已完成（全自动）');
    expect(summary.textContent).toContain('可信度：高 12 · 中 2 · 低 0');
    expect(summary.textContent).toContain('账号 ••••3333');
    expect(summary.textContent).toContain('开始前估算 未知');
    expect(summary.textContent).not.toContain('111122223333');
    expect(await screen.findByText('观察直连源站', { exact: false })).toBeTruthy();
    expect(screen.getByText('入口直连源站')).toBeTruthy();
    expect(screen.getByText(/归属在会话结束后确认/)).toBeTruthy();
    expect(screen.getByText(/共 2 版；这里显示最新版/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /下载 HTML 报告/ }).getAttribute('target')).toBe('_blank');
    expect(screen.getByText('最好成绩 3 · 作答 1 次。只记录，不影响完成与徽章。', { exact: false })).toBeTruthy();
    expect(await screen.findByText('/share/Xk2Qm8Rt4Wz0123456789A/index.html')).toBeTruthy();
    expect(screen.getByText(/还没有运行这个实验/)).toBeTruthy();
  });

  it('export: masks on by default; turning account masking off needs a confirmation; polls until ready', async () => {
    let n = 0;
    const { f } = mountAt(`/sessions/${SID}/report`, {
      routes,
      api: api({
        [`GET /api/v1/sessions/${SID}/report/export`]: () =>
          n++ === 0 ? json(202, { status: 'rendering', retryAfterSeconds: 0 }) : json(200, { status: 'ready', download: { url: 'https://bucket.s3.amazonaws.com/export.html?sig' } }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '导出…' }));
    const dlg = await screen.findByRole('dialog', { name: '导出报告' });
    fireEvent.click(within(dlg).getByLabelText('账号 ID 打码'));
    const exportBtn = within(dlg).getByRole('button', { name: '导出' });
    expect(exportBtn.getAttribute('aria-disabled')).toBe('true');
    expect(within(dlg).getByText(/同时打码或同时不打码/, { selector: 'p' })).toBeTruthy();
    fireEvent.click(within(dlg).getByLabelText('公网 IP 打码'));
    expect(exportBtn.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(dlg).getByLabelText('我确认导出文件会包含完整的 AWS 账号 ID'));
    expect(exportBtn.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(exportBtn);
    const link = await within(dlg).findByRole('link', { name: /下载 HTML/ }, { timeout: 5000 });
    expect(link.getAttribute('href')).toBe('https://bucket.s3.amazonaws.com/export.html?sig');
    expect(f.calls.filter((c) => c.url.includes('/report/export')).map((c) => new URL(c.url, 'http://x').searchParams.get('mask'))).toEqual(['off', 'off']);
  });

  it('share: create with expiry, then revoke after confirmation', async () => {
    const { f } = mountAt(`/sessions/${SID}/report`, {
      routes,
      api: api({
        [`POST /api/v1/sessions/${SID}/report/shares`]: json(202, { shareId: 'Ab3Qm8Rt4Wz0123456789B', status: 'publishing', expiresAt: iso(10000), url: '/share/Ab3Qm8Rt4Wz0123456789B/index.html' }),
        [`DELETE /api/v1/sessions/${SID}/report/shares/*`]: json(202, { status: 'revoking' }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '分享…' }));
    const dlg = await screen.findByRole('dialog', { name: '创建分享链接' });
    expect(within(dlg).getByText(/搜索引擎不收录/)).toBeTruthy();
    fireEvent.click(within(dlg).getByLabelText('7 天'));
    fireEvent.click(within(dlg).getByRole('button', { name: '创建链接' }));
    expect(await within(dlg).findByText(/\/share\/Ab3Qm8Rt4Wz0123456789B\/index.html/)).toBeTruthy();
    expect(f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/report/shares'))!.body).toEqual({ expiresInDays: 7 });
    fireEvent.click(within(dlg).getAllByRole('button', { name: '关闭' }).pop()!);
    fireEvent.click(await screen.findByRole('button', { name: /撤销分享链接/ }));
    const confirm = await screen.findByRole('alertdialog', { name: '撤销分享链接' });
    expect(within(confirm).getByText(/CDN 缓存刷新需要时间/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/report/shares/Xk2Qm8Rt4Wz0123456789A'))).toBe(true));
  });

  it('states: preview while running (no export / share), generating while ENDING, failed snapshot, never ready', async () => {
    const a = mountAt(`/sessions/${SID}/report`, { routes, api: api({ [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ state: 'RUNNING', endedAt: null })) }) });
    expect(await screen.findByText(/实验尚未结束，以下是预览（不保存）/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导出…' })).toBeNull();
    a.unmount();
    const b = mountAt(`/sessions/${SID}/report`, { routes, api: api({ [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ state: 'ENDING', endedAt: null })), [`GET /api/v1/sessions/${SID}/report`]: problem(404, 'NOT_FOUND') }) });
    expect(await screen.findByText(/报告正在生成/)).toBeTruthy();
    b.unmount();
    const c = mountAt(`/sessions/${SID}/report`, { routes, api: api({ [`GET /api/v1/sessions/${SID}/report`]: problem(404, 'NOT_FOUND'), [`POST /api/v1/sessions/${SID}/report`]: json(202, { status: 'queued' }) }) });
    expect(await screen.findByText(/报告快照未能在结束时生成/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(await screen.findByText(/已开始重新生成报告/)).toBeTruthy();
    c.unmount();
    mountAt(`/sessions/${SID}/report`, { routes, api: api({ [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ readyAt: null, endReason: 'PROVISION_FAILED', state: 'FAILED' })) }) });
    expect(await screen.findByText('这次会话没有报告')).toBeTruthy();
  });

  it('assistants and observers: read-only (no regenerate / export / share)', async () => {
    mountAt(`/sessions/${SID}/report`, { group: 'observer', routes, api: api() });
    expect((await screen.findAllByText(/第 2 版/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
    expect(screen.queryByRole('button', { name: '分享…' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /分享链接/ })).toBeNull();
    expect(screen.getByText(/由学员导出 HTML 报告/)).toBeTruthy();
  });
});
