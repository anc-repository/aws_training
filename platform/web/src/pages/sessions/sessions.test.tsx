import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem } from '../../test/helpers';
import { categoryOf, eventText } from './eventText';
import SessionDetailPage from './SessionDetailPage';
import SessionsPage, { cleanupCell, durationOf } from './SessionsPage';
import { formatMoneyRange, hourlyRange, validityReasonText } from './sessionText';
import { iso, mountAt, sessionView } from './testHarness';

const SID = 's4k7m2q9x1abc';

describe('session texts', () => {
  it('money ranges never invent prices; hourly estimate accepts both shapes (§9.2 #30)', () => {
    expect(formatMoneyRange(null, null)).toBeNull();
    expect(formatMoneyRange(0.12, 0.15, 'USD', '/小时')).toBe('≈ 0.12～0.15 USD/小时');
    expect(hourlyRange('0.1-0.2')).toBeNull();
    expect(hourlyRange({ low: 1, high: 2 })).toEqual({ low: 1, high: 2 });
    expect(hourlyRange({ start: { low: 1, high: 2 }, completed: null })).toEqual({ low: 1, high: 2 });
    expect(validityReasonText('DRIVER_MISMATCH: storage=local (expected s3)')).toBe('运行时驱动与该变体要求不符（storage=local (expected s3)）');
  });

  it('event texts and categories (no event names in the copy)', () => {
    expect(eventText({ type: 'session.state_changed', data: { from: 'CLEANING', to: 'ENDED' } })).toBe('正在释放资源 → 已结束');
    expect(eventText({ type: 'session.extended', data: { minutes: 30 } })).toBe('延长 30 分钟');
    expect(eventText({ type: 'reclaim.pass_completed', data: { passNo: 1, deleted: 18, manual: 1 } })).toBe('回收第 1 轮完成：删除 18 项，需人工 1 项');
    expect(eventText({ type: 'session.phase_changed', data: { phase: 'clean.destroy', status: 'RUNNING' } })).toBe('阶段 拆除环境栈：进行中');
    expect(eventText({ type: 'report.generated', data: { revision: 2 } })).toBe('报告第 2 版已生成');
    expect(eventText({ type: 'env.degraded', data: { detail: 'arn:aws:iam::111122223333:role/x' } })).toContain('••••3333');
    expect(eventText({ type: 'something.new', data: {} })).toBe('平台记录');
    expect(categoryOf('module_op.started')).toBe('ops');
    expect(categoryOf('terminal.opened')).toBe('workspace');
    expect(categoryOf('cleanup.failed')).toBe('reclaim');
  });

  it('list cells', () => {
    expect(cleanupCell({ sessionId: 'x', labId: 'l', state: 'CLEANUP_FAILED', createdAt: '', cleanup: { manual: 2 } }, 'L').text).toBe('2 项待处理');
    expect(cleanupCell({ sessionId: 'x', labId: 'l', state: 'CLEANUP_FAILED', createdAt: '' }, 'O').text).toBe('释放未完成');
    expect(cleanupCell({ sessionId: 'x', labId: 'l', state: 'ENDED', createdAt: '' }, 'L').text).toBe('已释放');
    expect(durationOf({ durationMinutes: 91 }, 0)).toBe('1 小时 31 分');
    expect(durationOf({ readyAt: null }, 0)).toBe('—');
  });
});

describe('P11 我的实验', () => {
  const list = (items: unknown[], next: string | null = null) => json(200, { items, next });
  const item = (over: Record<string, unknown>) => ({ sessionId: SID, labId: 'svc-cdn', state: 'ENDED', endReason: 'USER_ENDED', createdAt: iso(-200), readyAt: iso(-190), endedAt: iso(-99), durationMinutes: 91, cleanup: { deleted: 3, manual: 0 }, terminal: true, ...over });

  it('lists sessions with card titles, states, end reasons, durations and cleanup; Enter opens the detail; load more', async () => {
    let page = 0;
    const { loc, f } = mountAt('/sessions', {
      routes: [
        { path: '/sessions', element: <SessionsPage /> },
        { path: '/sessions/:sid', element: <div>detail</div> },
      ],
      api: {
        'GET /api/v1/sessions': () =>
          page++ === 0 ? list([item({}), item({ sessionId: 's9q3w7k2m8xr1', labId: 'svc-storage', state: 'CLEANUP_FAILED', endReason: 'EXPIRED', cleanup: { manual: 2 } })], 'cur1') : list([item({ sessionId: 'sb1c2d3e4f5g6', labId: 'svc-database', state: 'FAILED', endReason: 'PROVISION_FAILED', readyAt: null, durationMinutes: null })]),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: '我的实验' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: '我的实验会话' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    await waitFor(() => expect(rows[0]!.textContent).toContain('Amazon CloudFront：内容分发与边缘缓存'));
    expect(rows[0]!.textContent).toContain('你结束的');
    expect(rows[0]!.textContent).toContain('1 小时 31 分');
    expect(rows[1]!.textContent).toContain('2 项待处理');
    expect(screen.getByText(/会话 2 · 已结束 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(f.calls.filter((c) => c.url.includes('/api/v1/sessions?')).pop()!.url).toContain('cursor=cur1');
    fireEvent.keyDown(rows[0]!, { key: 'Enter' });
    await waitFor(() => expect(loc()).toBe(`/sessions/${SID}`));
  });

  it('server-side state filter goes into the query string; empty list', async () => {
    const { f } = mountAt('/sessions?state=KEPT', { routes: [{ path: '/sessions', element: <SessionsPage /> }], api: { 'GET /api/v1/sessions': list([]) } });
    expect(await screen.findByText('没有符合条件的会话。')).toBeTruthy();
    expect(f.calls.find((c) => c.url.includes('/api/v1/sessions?'))!.url).toContain('state=KEPT');
  });

  it('first visit without sessions', async () => {
    mountAt('/sessions', { routes: [{ path: '/sessions', element: <SessionsPage /> }], api: { 'GET /api/v1/sessions': list([]) } });
    expect(await screen.findByText('还没有实验记录。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '去卡片目录开始第一张 →' })).toBeTruthy();
  });
});

describe('P11-D 会话详情', () => {
  const routes = [{ path: '/sessions/:sid', element: <SessionDetailPage /> }];
  const events = [
    { id: '01JA00000000000000000000A1', type: 'session.requested', at: iso(-200), data: { quoteId: '01JAQUOTE' } },
    { id: '01JA00000000000000000000A2', type: 'session.state_changed', at: iso(-190), data: { from: 'PROVISIONING', to: 'READY' } },
    { id: '01JA00000000000000000000A3', type: 'module_op.succeeded', at: iso(-150), data: { op: 'enable', moduleId: 'cdn' } },
  ];
  const base = {
    [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ cost: { quoteId: '01JAQUOTE000', currency: 'USD', hourly: null, dimensions: [{ service: 'AmazonEC2', dimension: 'hourly', detail: 't4g.small × 2' }] } })),
    [`GET /api/v1/sessions/${SID}/events`]: json(200, { events, next: events[2]!.id, hasMore: false }),
  };

  it('timeline with category filter; header actions for an ended session', async () => {
    mountAt(`/sessions/${SID}`, { routes, api: base });
    expect(await screen.findByRole('heading', { level: 1, name: `svc-cdn · 会话 ${SID}` })).toBeTruthy();
    expect(screen.getByRole('link', { name: '报告' }).getAttribute('href')).toBe(`/sessions/${SID}/report`);
    const nav = screen.getByRole('navigation', { name: '会话详情' });
    expect(within(nav).getByRole('link', { name: '时间线' }).getAttribute('aria-current')).toBe('page');
    expect(await screen.findByText('准备环境 → 环境已就绪'.replace('准备环境', '正在准备环境'))).toBeTruthy();
    expect(screen.getByText(/已受理（报价 01JAQU…）/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('按类别筛选'), { target: { value: 'ops' } });
    await waitFor(() => expect(document.querySelectorAll('[data-type]')).toHaveLength(1));
    expect(screen.getByText('平台动作 enable cdn：成功')).toBeTruthy();
  });

  it('cost tab: dimensions, unknown amounts (no invented prices), Cost Explorer note', async () => {
    mountAt(`/sessions/${SID}?tab=cost`, {
      routes,
      api: { ...base, [`GET /api/v1/sessions/${SID}/cost`]: json(200, { currency: 'USD', estimate: null, billable: [{ type: 'AWS::EC2::Instance', name: 'i-06c2d9e41a7b3f805', billing: 'hourly' }], unestimatedManualResources: 1 }) },
    });
    expect(await screen.findByText('t4g.small × 2')).toBeTruthy();
    expect(await screen.findByText(/≈ 未知（单价暂不可得，以账单为准） · \+ 未估算的手工资源 1 项/)).toBeTruthy();
    expect(screen.getByText(/AWS Cost Explorer 中按 atl:session-id 查看/)).toBeTruthy();
  });

  it('observers have no resources / cost / audit tabs; direct access shows the role notice', async () => {
    mountAt(`/sessions/${SID}?tab=audit`, { group: 'observer', routes, api: base });
    expect(await screen.findByText(/你的角色（观察者）只能查看/)).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: '会话详情' });
    expect(within(nav).queryByRole('link', { name: '审计' })).toBeNull();
    expect(within(nav).getByRole('link', { name: '平台动作' })).toBeTruthy();
  });

  it('ops tab and live sessions offer “回到工作台”; 404', async () => {
    const a = mountAt(`/sessions/${SID}?tab=ops`, {
      routes,
      api: {
        ...base,
        [`GET /api/v1/sessions/${SID}`]: json(200, sessionView({ state: 'RUNNING', endedAt: null, deadlineAt: iso(60) })),
        [`GET /api/v1/sessions/${SID}/module-ops`]: json(200, { items: [{ opId: 'o1', source: 'runner', op: 'profile-apply', moduleId: 'iam', startedAt: iso(-180), finishedAt: iso(-179), exitCode: 0, runId: `${SID}-apply-1` }] }),
      },
    });
    expect(await screen.findByRole('link', { name: '回到工作台' })).toBeTruthy();
    expect(await screen.findByText('profile-apply')).toBeTruthy();
    expect(screen.getByText('运行器')).toBeTruthy();
    a.unmount();
    mountAt(`/sessions/${SID}`, { routes, api: { [`GET /api/v1/sessions/${SID}`]: problem(404, 'NOT_FOUND') } });
    expect(await screen.findByRole('heading', { level: 1, name: '没有这个会话' })).toBeTruthy();
  });
});
