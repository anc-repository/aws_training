import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { json, problem } from '../../test/helpers';
import { resolveTiming } from '../manual/ManualList';
import ManualResourcesPage from '../manual/ManualResourcesPage';
import { iso, mountAt, sessionView } from '../sessions/testHarness';
import EndPage from './EndPage';
import { resetStageMemory } from './ResourceStages';

const SID = 's4k7m2q9x1abc';
const routes = [{ path: '/sessions/:sid/end', element: <EndPage /> }];

afterEach(() => {
  resetStageMemory();
  resolveTiming.pollMs = 4_000;
});

const resource = (over: Record<string, unknown>) => ({ resourceKey: `k-${String(over.id)}`, severity: 'INFO', region: 'ap-northeast-1', billing: 'none', source: 'STACK', attempts: 0, ...over });

describe('P07 回收进度', () => {
  it('CLEANING: phases with the current stage, resources by stage S0～S6 (masked), “可以离开这个页面”', async () => {
    const view = sessionView({
      state: 'CLEANING',
      endedAt: null,
      reclaim: null,
      phases: [
        { name: 'end.disarm', status: 'DONE', at: iso(-20) },
        { name: 'end.revoke', status: 'DONE', at: iso(-19) },
        { name: 'end.finalize', status: 'DONE', at: iso(-15) },
        { name: 'clean.destroy', status: 'RUNNING', at: iso(-10) },
      ],
    });
    const { f } = mountAt(`/sessions/${SID}/end`, {
      routes,
      api: {
        [`GET /api/v1/sessions/${SID}`]: json(200, view),
        [`GET /api/v1/sessions/${SID}/events`]: json(200, { events: [], next: null, hasMore: false, pollAfterMs: 10000 }),
        [`GET /api/v1/sessions/${SID}/cleanup`]: json(200, { sessionId: SID, passes: [], counts: { DELETED: 1, DELETING: 1 }, items: [] }),
        [`GET /api/v1/sessions/${SID}/resources`]: json(200, {
          items: [
            resource({ id: 'E2QWABCDEFG7K', type: 'AWS::CloudFront::Distribution', stage: 'S0', cleanupState: 'DELETING', billing: 'usage', source: 'CLOUDTRAIL' }),
            resource({ id: 'arn:aws:ec2:ap-northeast-1:111122223333:instance/i-06c2d9e41a7b3f805', type: 'AWS::EC2::Instance', stage: 'S1', cleanupState: 'DELETED', billing: 'hourly' }),
          ],
        }),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'svc-cdn · 结束与回收' })).toBeTruthy();
    const phases = document.querySelector('[data-phases]')!;
    const current = phases.querySelector('[aria-current="step"]')!;
    expect(current.getAttribute('data-stage')).toBe('destroy');
    expect(phases.querySelector('[data-stage="workstation"]')!.getAttribute('data-status')).toBe('done');
    expect(within(phases as HTMLElement).getByText(/尝试：已完成（全自动）/)).toBeTruthy();
    const res = await screen.findByRole('heading', { name: /资源（本次实验创建或接管的 2 项）/ });
    expect(res.textContent).toContain('已删除 1 · 删除中 1');
    const s0 = document.querySelector('details[data-stage="S0"]') as HTMLDetailsElement;
    expect(s0.open).toBe(true);
    expect((document.querySelector('details[data-stage="S1"]') as HTMLDetailsElement).open).toBe(false);
    expect(s0.textContent).toContain('正在禁用，部署完成后删除');
    expect(s0.textContent).toContain('CloudTrail（你在控制台或 CLI 创建）');
    expect(document.body.textContent).not.toContain('111122223333');
    expect(document.body.textContent).toContain('••••3333');
    expect(screen.getByText('可以离开这个页面。')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '之后还会做什么' })).toBeTruthy();
    expect(f.calls.some((c) => c.url.includes(`/sessions/${SID}/cleanup`))).toBe(true);
  });

  it('CLEANUP_FAILED (#manual): sorted manual items, console link and CLI, “我已处理，重新核对” confirms', async () => {
    resolveTiming.pollMs = 20;
    const view = sessionView({ state: 'CLEANUP_FAILED', cleanup: { deleted: 10, manual: 2 }, reclaim: { followUp: 'PENDING', rescanAt: [iso(-60)] } });
    const items = [
      resource({ id: 'cloudalbum-e7k2m9qx-static', type: 'AWS::S3::Bucket', severity: 'REVIEW', billing: 'storage', cleanupState: 'REVIEW', source: 'TAG', stage: 'S2' }),
      resource({ id: 'cloudalbum-e7k2m9qx-db', type: 'AWS::RDS::DBInstance', severity: 'BLOCKING', billing: 'hourly', cleanupState: 'MANUAL_REQUIRED', reason: '已开启删除保护', stage: 'S2', attempts: 4, lastTriedAt: iso(-30), hint: { consoleUrl: 'https://console.aws.amazon.com/rds/home', cli: 'aws rds delete-db-instance --db-instance-identifier cloudalbum-e7k2m9qx-db' } }),
    ];
    let resolved = false;
    const { f } = mountAt(`/sessions/${SID}/end#manual`, {
      routes,
      api: {
        [`GET /api/v1/sessions/${SID}`]: json(200, view),
        [`GET /api/v1/sessions/${SID}/events`]: json(200, { events: [], next: null, hasMore: false, pollAfterMs: 60000 }),
        [`GET /api/v1/sessions/${SID}/cleanup`]: () => json(200, { sessionId: SID, passes: [], counts: {}, hourlyBlocking: resolved ? 0 : 1, items: resolved ? items.slice(0, 1) : items }),
        [`GET /api/v1/sessions/${SID}/resources`]: json(200, { items }),
        [`POST /api/v1/sessions/${SID}/cleanup/items/*`]: () => {
          resolved = true;
          return json(202, { resourceKey: 'k-cloudalbum-e7k2m9qx-db', status: 'verifying' });
        },
      },
    });
    const manual = await screen.findByRole('heading', { name: /释放未完成：2 项资源没能自动删除，其中 1 项按小时计费/ });
    const section = manual.closest('section')!;
    const cards = within(section).getAllByRole('article');
    expect(cards[0]!.getAttribute('data-resource')).toBe('k-cloudalbum-e7k2m9qx-db');
    expect(within(cards[0]!).getByRole('link', { name: /在 AWS 控制台中打开/ }).getAttribute('target')).toBe('_blank');
    expect(cards[1]!.textContent).toContain('来源：标签（仅凭标签发现）');
    expect(cards[0]!.textContent).toContain('已尝试 4 次');
    expect(within(section).getByRole('button', { name: '立即重试回收' })).toBeTruthy();
    fireEvent.click(within(cards[0]!).getByRole('button', { name: /我已处理 .*，重新核对/ }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'POST' && c.url.endsWith('/cleanup/items/k-cloudalbum-e7k2m9qx-db/resolve'))).toBe(true));
    expect(await screen.findByText('已确认：资源已不存在。')).toBeTruthy();
    const post = f.calls.find((c) => c.method === 'POST' && c.url.includes('/resolve'))!;
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('observers see only the phases and the conclusion (no ledger calls)', async () => {
    const view = sessionView({ state: 'CLEANUP_FAILED', cleanup: { deleted: 3, manual: 1 } });
    const { f } = mountAt(`/sessions/${SID}/end`, {
      group: 'observer',
      routes,
      api: { [`GET /api/v1/sessions/${SID}`]: json(200, view), [`GET /api/v1/sessions/${SID}/events`]: json(200, { events: [], next: null, hasMore: false }) },
    });
    expect(await screen.findByText(/你的角色（观察者）看不到待人工处理清单/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立即重试回收' })).toBeNull();
    expect(f.calls.some((c) => c.url.includes('/cleanup') || c.url.includes('/resources'))).toBe(false);
  });

  it('ENDED summary: conclusion, rescan timeline, report link; assistants have no actions', async () => {
    const view = sessionView({ state: 'ENDED', reclaim: { followUp: 'PENDING', rescanAt: [iso(-80), iso(-40), iso(260)] } });
    mountAt(`/sessions/${SID}/end`, {
      group: 'assistant',
      routes,
      api: {
        [`GET /api/v1/sessions/${SID}`]: json(200, view),
        [`GET /api/v1/sessions/${SID}/events`]: json(200, { events: [], next: null, hasMore: false }),
        [`GET /api/v1/sessions/${SID}/cleanup`]: json(200, { sessionId: SID, passes: [{ mode: 'RESCAN', startedAt: iso(-80), finishedAt: iso(-79), manual: 0 }], counts: { DELETED: 2 }, items: [] }),
        [`GET /api/v1/sessions/${SID}/resources`]: json(200, { items: [] }),
      },
    });
    expect(await screen.findByText('已释放全部资源。')).toBeTruthy();
    expect(screen.getByText(/复扫会在 .* 前完成/)).toBeTruthy();
    const timeline = await screen.findByRole('heading', { name: '复扫时间线' });
    await waitFor(() => expect(timeline.closest('section')!.querySelector('[data-rescan="1"]')!.getAttribute('data-status')).toBe('done'));
    expect(timeline.closest('section')!.querySelector('[data-rescan="3"]')!.getAttribute('data-status')).toBe('pending');
    expect(screen.getAllByRole('link', { name: '查看报告' })[0]!.getAttribute('href')).toBe(`/sessions/${SID}/report`);
    expect(screen.queryByRole('button', { name: /显示完整值/ })).toBeNull();
  });

  it('never-ready sessions have no report; live sessions redirect to the workspace; unknown sessions are “没有这个会话”', async () => {
    const a = mountAt(`/sessions/${SID}/end`, {
      routes,
      api: { [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ state: 'ENDED', readyAt: null, endReason: 'CANCELLED' })), [`GET /api/v1/sessions/${SID}/events`]: json(200, { events: [] }) },
    });
    expect(await screen.findByText(/这次会话在环境就绪前结束，没有报告/)).toBeTruthy();
    expect(screen.getByText('环境未就绪：没有报告，尝试不计入次数')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '查看报告' })).toBeNull();
    a.unmount();
    const b = mountAt(`/sessions/${SID}/end`, { routes, api: { [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ state: 'RUNNING', endedAt: null })) } });
    await waitFor(() => expect(b.loc()).toBe(`/workspace/${SID}`));
    b.unmount();
    mountAt(`/sessions/${SID}/end`, { routes, api: { [`GET /api/v1/sessions/${SID}`]: problem(404, 'NOT_FOUND') } });
    expect(await screen.findByRole('heading', { level: 1, name: '没有这个会话' })).toBeTruthy();
  });
});

describe('P07-K 保留中的环境', () => {
  const kept = sessionView({
    state: 'KEPT',
    endedAt: null,
    stateEnteredAt: iso(-60),
    keep: { until: iso(180), hours: 4, saveMode: true },
    limits: { keepMaxHours: 12, keepAllowed: true },
    allowedActions: ['keep-extend', 'keep-release', 'reuse'],
    env: { envId: '01JA0000000000000000000000', envName: 'e7k2m9qx', status: 'KEPT', hourlyEstimate: null },
  });
  const api = (extra: Record<string, unknown> = {}) => ({
    [`GET /api/v1/sessions/${SID}`]: json(200, kept),
    [`GET /api/v1/sessions/${SID}/events`]: json(200, { events: [], next: null, hasMore: false }),
    'GET /api/v1/environments/current': json(200, { envId: '01JA0000000000000000000000', enabledModules: ['iam', 'cdn'], createdAt: iso(-1500), maxAgeUntil: iso(8000), session: { sessionId: SID } }),
    [`GET /api/v1/sessions/${SID}/cost`]: json(200, { currency: 'USD', billable: [{ resourceKey: 'r1', type: 'AWS::EC2::EIP', billing: 'hourly' }] }),
    [`GET /api/v1/sessions/${SID}/resources`]: json(200, { items: [] }),
    ...extra,
  });

  it('shows the keep countdown, unknown amount (no invented prices), modules and the actions', async () => {
    mountAt(`/sessions/${SID}/end`, { routes, api: api() });
    expect(await screen.findByRole('heading', { level: 1, name: /环境保留中 · svc-cdn/ })).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toMatch(/^至 \d{2}:\d{2}（剩余 \d:\d{2}:\d{2}）$/);
    expect(await screen.findByText(/仍在计费（估算，按当前实际资源）：未知/)).toBeTruthy();
    expect(await screen.findByText('iam、cdn')).toBeTruthy();
    expect(screen.getByRole('link', { name: '继续本卡片 →' }).getAttribute('href')).toBe('/labs/svc-cdn?start=1&reuse=01JA0000000000000000000000');
    expect(screen.getByText(/保留期间没有终端与控制台访问/)).toBeTruthy();
  });

  it('延长保留: KEEP quote → confirm → keep/extend with the quote', async () => {
    const { f } = mountAt(`/sessions/${SID}/end`, {
      routes,
      api: api({
        [`POST /api/v1/sessions/${SID}/quotes`]: json(200, { quoteId: '01JAQUOTE00000000000000000', keepHours: 4, currency: 'USD', priceAsOf: null, expiresAt: iso(15), retainHourly: null, hourly: null, lines: [{ service: '实验机、EBS 与公有 IPv4', unknown: true }], incomplete: ['ec2'] }),
        [`POST /api/v1/sessions/${SID}/keep/extend`]: json(200, { ...kept, keep: { until: iso(420) } }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '延长保留…' }));
    const dlg = await screen.findByRole('dialog', { name: '延长保留' });
    await within(dlg).findByText(/保留期间持续计费（估算）：未知/);
    const submit = within(dlg).getByRole('button', { name: '延长保留' });
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(dlg).getByLabelText('我了解保留期间资源会持续计费'));
    fireEvent.click(within(dlg).getByLabelText(/我了解部分资源的费用未能估算/));
    fireEvent.click(submit);
    await waitFor(() => expect(f.calls.some((c) => c.method === 'POST' && c.url.endsWith('/keep/extend'))).toBe(true));
    const call = f.calls.find((c) => c.url.endsWith('/keep/extend'))!;
    expect(call.body).toEqual({ hours: 4, quoteId: '01JAQUOTE00000000000000000' });
    expect(f.calls.find((c) => c.url.endsWith('/quotes'))!.body).toEqual({ purpose: 'KEEP', keepHours: 4 });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '延长保留' })).toBeNull());
  });

  it('立即释放: alertdialog with focus on “取消”; 409 REUSE_IN_PROGRESS is explained', async () => {
    mountAt(`/sessions/${SID}/end`, { routes, api: api({ [`POST /api/v1/sessions/${SID}/keep/release`]: problem(409, 'REUSE_IN_PROGRESS') }) });
    fireEvent.click(await screen.findByRole('button', { name: '立即释放…' }));
    const dlg = await screen.findByRole('alertdialog', { name: '立即释放保留的环境' });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('取消'));
    fireEvent.click(within(dlg).getByRole('button', { name: '立即释放' }));
    expect(await within(dlg).findByText('该环境正在被新会话接管，不能立即释放')).toBeTruthy();
  });

  it('keep-extend not allowed (uninstalling): the button stays focusable with the reason', async () => {
    mountAt(`/sessions/${SID}/end`, {
      routes,
      api: api({ [`GET /api/v1/sessions/${SID}`]: json(200, { ...kept, allowedActions: ['keep-release'] }), 'GET /api/v1/platform/guardrails': json(200, { budget: null, mode: 'UNINSTALLING', maintenance: false, uninstalling: true }) }),
    });
    const btn = await screen.findByRole('button', { name: '延长保留…' });
    await waitFor(() => expect(btn.getAttribute('aria-disabled')).toBe('true'));
    expect(screen.getByText('平台正在卸载，不能延长保留。')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '继续本卡片 →' })).toBeNull();
  });
});

describe('P07-M 待人工处理清单', () => {
  const mroutes = [{ path: '/resources/manual', element: <ManualResourcesPage />, roles: ['L', 'A'] as const }];
  it('groups by session with the card and date, filters by severity / billing, exports per session', async () => {
    mountAt('/resources/manual', {
      routes: mroutes.map((r) => ({ ...r, roles: [...r.roles] })),
      api: {
        'GET /api/v1/resources/manual': json(200, {
          items: [
            resource({ id: 'cloudalbum-e7k2m9qx-db', type: 'AWS::RDS::DBInstance', severity: 'BLOCKING', billing: 'hourly', cleanupState: 'MANUAL_REQUIRED', sessionId: SID }),
            resource({ id: 'b2', type: 'AWS::S3::Bucket', severity: 'REVIEW', billing: 'storage', cleanupState: 'REVIEW', sessionId: 's9q3w7k2m8xr1' }),
          ],
          total: 2,
          hourlyBlocking: 1,
        }),
        [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ state: 'CLEANUP_FAILED' })),
        'GET /api/v1/sessions/s9q3w7k2m8xr1': json(200, sessionView({ sessionId: 's9q3w7k2m8xr1', labId: 'svc-storage', state: 'CLEANUP_FAILED' })),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: '待人工处理清单' })).toBeTruthy();
    expect(await screen.findByText('共 2 项，其中 1 项阻塞且按小时计费')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /svc-cdn · .* · 会话 s4k7…/ })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /svc-storage · .* · 会话 s9q3…/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('严重级别'), { target: { value: 'REVIEW' } });
    await waitFor(() => expect(document.querySelectorAll('[data-group]')).toHaveLength(1));
    expect(document.querySelector('[data-group]')!.getAttribute('data-group')).toBe('s9q3w7k2m8xr1');
    expect(screen.getAllByRole('button', { name: /导出/ }).length).toBeGreaterThan(0);
  });

  it('empty state', async () => {
    mountAt('/resources/manual', { routes: mroutes.map((r) => ({ ...r, roles: [...r.roles] })), api: { 'GET /api/v1/resources/manual': json(200, { items: [] }) } });
    expect(await screen.findByText('没有未释放的资源。')).toBeTruthy();
  });
});
