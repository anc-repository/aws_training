import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, problem } from '../../test/helpers';
import { callsOf, renderPage } from '../labs/testing';
import type { LabDetail } from '../labs/types';
import CardIntroPage from './CardIntroPage';

const detail = (p: Partial<LabDetail['startability']> = {}, extra: Partial<LabDetail> = {}): LabDetail => ({
  labId: 'svc-queue',
  catalogVersion: '2026.10.1',
  progress: { status: 'not_started', attempts: 0 },
  attempts: [],
  startability: { canStart: true, reasons: [], reuse: null, variants: [{ id: 'default', select: 'default' }], ...p },
  ...extra,
});

const quote = (p: Record<string, unknown> = {}) => ({
  quoteId: 'q1',
  purpose: 'START',
  labId: 'svc-queue',
  currency: 'USD',
  priceAsOf: '2026-10-12T00:00:00Z',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  hourly: { start: { low: 0.05, high: 0.07 }, completed: { low: 0.05, high: 0.08 } },
  platformOverhead: { low: 0.02, high: 0.03, notes: [] },
  maxSession: { low: 0.3, high: 0.5 },
  maxTotalMinutes: 150,
  lines: [{ group: 'start', ref: 'start-profile' }, { group: 'usage', service: 'SQS 请求' }],
  incomplete: [],
  pricing: 'price-list',
  ...p,
});

function page(path = '/labs/svc-queue', extra: Partial<Parameters<typeof renderPage>[0]> = {}) {
  return renderPage({
    path,
    route: '/labs/:labId',
    element: <CardIntroPage />,
    others: ['/workspace/:sid'],
    ...extra,
    routes: {
      'GET /api/v1/labs/svc-queue': json(200, detail()),
      'GET /api/v1/labs/svc-cost': json(200, detail({ canStart: false, reasons: [{ code: 'LAB_PLANNED' }] }, { labId: 'svc-cost' })),
      'POST /api/v1/labs/svc-queue/quotes': json(201, quote()),
      'POST /api/v1/sessions': json(202, { sessionId: 'snew', labId: 'svc-queue', state: 'REQUESTED', ver: 1, createdAt: new Date().toISOString() }),
      ...extra.routes,
    },
  });
}

describe('P03 卡片简介页', () => {
  it('renders the header, generated blocks (05 §7.3), authored overview and the aside', async () => {
    page();
    expect(await screen.findByRole('heading', { level: 1, name: 'Amazon SQS：异步任务队列与死信队列' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '面包屑' }).textContent).toContain('svc-queue');
    expect(await screen.findByText('进程一重启，排队的任务全部丢失。')).toBeTruthy();
    // 链接只允许 AWS 文档与站内：外部链接只剩文字
    expect(screen.getByText('外部链接').closest('a')).toBeNull();
    expect(screen.getByText(/并预先启用 AWS IAM（应用调用 SQS 需要凭证）/)).toBeTruthy();
    expect(screen.getByText(/Amazon SQS使用本地档/)).toBeTruthy();
    expect(screen.getByText(/Amazon SQS（memory → sqs）/)).toBeTruthy();
    const steps = screen.getByRole('heading', { level: 2, name: '步骤概览' }).closest('section')!;
    expect(steps.textContent).toContain('需等待约 3 分钟 · 开始按量计费');
    expect(steps.textContent).toContain('选做');
    const aside = screen.getByRole('complementary', { name: '开始前准备与摘要' });
    expect(aside.textContent).toContain('建议先完成：svc-ec2');
    expect(aside.textContent).toContain('完成本卡片（最终复核通过）即获得徽章“削峰填谷”');
    expect(aside.textContent).toContain('SAA 主线（异步，必修）');
    expect(screen.getAllByRole('button', { name: '开始实验' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: '小测' })[0]!.getAttribute('href')).toBe('/labs/svc-queue/quiz');
  });

  it('start dialog: quote first, acknowledge, POST /sessions with Idempotency-Key, then go to the workspace', async () => {
    const { f, loc } = page();
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(callsOf(f, 'GET', '/labs/svc-queue')).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('button', { name: '开始实验' })[0]!);
    const dlg = await screen.findByRole('dialog', { name: /开始实验：svc-queue/ });
    expect(document.activeElement?.textContent).toMatch(/开始实验：svc-queue/);
    await within(dlg).findByText('起始状态每小时');
    expect(dlg.textContent).toContain('≈ $0.050～$0.070 /小时');
    expect(dlg.textContent).toMatch(/报价 1[45]:\d\d 后失效/);
    // 工作台：savingsMode=degraded 且 required=false → 可选 CloudShell
    fireEvent.click(within(dlg).getByRole('radio', { name: /CloudShell/ }));
    expect(dlg.textContent).toContain('负载类实验的结果只供参考');
    const submit = within(dlg).getByRole('button', { name: /开始实验（预计/ });
    fireEvent.click(submit);
    expect(await within(dlg).findByText('请先勾选上面的确认项。')).toBeTruthy();
    expect(callsOf(f, 'POST', '/sessions')).toHaveLength(0);
    fireEvent.click(within(dlg).getByRole('checkbox', { name: /我已了解：资源创建在我的 AWS 账号中/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(loc()).toBe('/workspace/snew'));
    const call = callsOf(f, 'POST', '/sessions')[0]!;
    expect(call.body).toMatchObject({ labId: 'svc-queue', quoteId: 'q1', costAcknowledged: true, workstation: 'cloudshell' });
    expect(call.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('expired or mismatched quotes are recomputed and the acknowledgement is cleared', async () => {
    let n = 0;
    const { f } = page('/labs/svc-queue', {
      routes: {
        'POST /api/v1/labs/svc-queue/quotes': () => json(201, quote({ quoteId: `q${++n}` })),
        'POST /api/v1/sessions': problem(422, 'QUOTE_EXPIRED'),
      },
    });
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(callsOf(f, 'GET', '/labs/svc-queue')).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('button', { name: '开始实验' })[0]!);
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByText('起始状态每小时');
    const ack = within(dlg).getByRole('checkbox', { name: /我已了解/ }) as HTMLInputElement;
    fireEvent.click(ack);
    fireEvent.click(within(dlg).getByRole('button', { name: /开始实验（预计/ }));
    expect(await within(dlg).findByText('费用信息已更新，请重新确认。')).toBeTruthy();
    await waitFor(() => expect(callsOf(f, 'POST', '/labs/svc-queue/quotes')).toHaveLength(2));
    expect(ack.checked).toBe(false);
  });

  it('a 409 conflict closes the cost section and offers the way out', async () => {
    const { f } = page('/labs/svc-queue', { routes: { 'POST /api/v1/sessions': problem(409, 'SESSION_ACTIVE_EXISTS', { detail: '会话 s7（svc-cdn）处于 RUNNING。', sessionId: 's7' }) } });
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(callsOf(f, 'GET', '/labs/svc-queue')).toHaveLength(1));
    fireEvent.click(screen.getAllByRole('button', { name: '开始实验' })[0]!);
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByText('起始状态每小时');
    fireEvent.click(within(dlg).getByRole('checkbox', { name: /我已了解/ }));
    fireEvent.click(within(dlg).getByRole('button', { name: /开始实验（预计/ }));
    expect(await within(dlg).findByText(/已有进行中的实验：会话 s7/)).toBeTruthy();
    expect(within(dlg).getByRole('link', { name: '回到工作台' }).getAttribute('href')).toBe('/workspace/s7');
    expect(within(dlg).queryByText('起始状态每小时')).toBeNull();
  });

  it('price list unavailable → “未知” rows and an extra acknowledgement', async () => {
    page('/labs/svc-queue', { routes: { 'POST /api/v1/labs/svc-queue/quotes': json(201, quote({ hourly: null, platformOverhead: { low: null, high: null }, maxSession: null, pricing: 'unavailable', incomplete: ['ref:start-profile'] })) } });
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click((await screen.findAllByRole('button', { name: '开始实验' }))[0]!);
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByText('起始状态每小时');
    expect(within(dlg).getAllByText('未知').length).toBeGreaterThan(0);
    expect(within(dlg).getByRole('checkbox', { name: '我了解有未估算的费用' })).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: '开始实验' })).toBeTruthy();
  });

  it('another session running: start is greyed with the reason and a link back', async () => {
    page('/labs/svc-queue', { current: { labId: 'svc-cdn', sessionId: 's1', state: 'RUNNING' } });
    await screen.findByRole('heading', { level: 1 });
    const why = await screen.findByText(/svc-cdn 正在进行（\d\d:\d\d 到期），结束后才能开始新的实验。/);
    expect(within(why).getByRole('link', { name: '回到工作台' }).getAttribute('href')).toBe('/workspace/s1');
    const btn = screen.getAllByRole('button', { name: '开始实验' })[0]!;
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('planned cards only show: no start, quote or quiz', async () => {
    page('/labs/svc-cost');
    expect(await screen.findByRole('heading', { level: 1, name: 'AWS Budgets：费用护栏与告警' })).toBeTruthy();
    expect(screen.getByText('这张卡片还在编写中：可以先看简介，暂时不能开始实验。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开始实验' })).toBeNull();
    expect(screen.queryByRole('button', { name: '计算当前价格' })).toBeNull();
    expect(screen.queryByRole('link', { name: '小测' })).toBeNull();
  });

  it('assistants see the page without start, quote or quiz', async () => {
    page('/labs/svc-queue', { group: 'assistant' });
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    await screen.findByText('进程一重启，排队的任务全部丢失。');
    expect(screen.queryByRole('button', { name: '开始实验' })).toBeNull();
    expect(screen.queryByRole('link', { name: '小测' })).toBeNull();
  });

  it('?start=1 opens the dialog and removes the parameter; unknown cards are not found', async () => {
    const { loc, unmount } = page('/labs/svc-queue?start=1');
    expect(await screen.findByRole('dialog', { name: /开始实验：svc-queue/ })).toBeTruthy();
    await waitFor(() => expect(loc()).toBe('/labs/svc-queue'));
    unmount();
    page('/labs/svc-nope');
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
    expect(screen.getByText('没有这张卡片（svc-nope）。它可能尚未发布。')).toBeTruthy();
  });

  it('kept environment: reuse when compatible, release-then-fresh otherwise', async () => {
    const { f } = page('/labs/svc-queue', {
      routes: {
        'GET /api/v1/labs/svc-queue': json(200, detail({ canStart: true, reasons: [{ code: 'ENV_KEPT_EXISTS', ackable: true }], reuse: { environmentId: 'e1', fromLabId: 'svc-iam', sessionId: 's4', compatible: true } })),
        'POST /api/v1/sessions/s4/keep/release': json(202, { sessionId: 's4', state: 'CLEANING' }),
      },
    });
    await screen.findByRole('heading', { level: 1 });
    expect((await screen.findAllByRole('button', { name: '在保留的环境中开始' })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: '释放后全新开始' })[0]!);
    const dlg = await screen.findByRole('alertdialog', { name: '立即释放保留的环境' });
    expect(document.activeElement?.textContent).toBe('取消');
    fireEvent.click(within(dlg).getByRole('button', { name: '立即释放' }));
    expect(await within(dlg).findByText('上一个环境正在释放，释放完成后才能开始。')).toBeTruthy();
    expect(callsOf(f, 'POST', '/sessions/s4/keep/release')[0]!.headers['idempotency-key']).toBeTruthy();
  });

  it('“计算当前价格” only shows the quote (dev fixture prices are labelled)', async () => {
    const { f } = page('/labs/svc-queue', { routes: { 'POST /api/v1/labs/svc-queue/quotes': json(201, quote({ pricing: 'fixture' })) } });
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getAllByRole('button', { name: '计算当前价格' })[0]!);
    const dlg = await screen.findByRole('dialog', { name: '当前价格（只显示，不开始）：svc-queue' });
    await within(dlg).findByText('本次会话最多');
    expect(dlg.querySelector('[data-pricing="fixture"]')).toBeTruthy();
    expect(callsOf(f, 'POST', '/labs/svc-queue/quotes')[0]!.body).toEqual({ purpose: 'START' });
    expect(callsOf(f, 'POST', '/sessions')).toHaveLength(0);
  });
});
