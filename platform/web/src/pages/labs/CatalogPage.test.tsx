import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json } from '../../test/helpers';
import CatalogPage from './CatalogPage';
import { CATALOG_PREFS_KEY } from './keys';
import { NOW, renderPage, V } from './testing';

const page = (path = '/labs', extra: Parameters<typeof renderPage>[0] extends infer T ? Partial<T> : never = {}) =>
  renderPage({ path, route: '/labs', element: <CatalogPage />, ...extra });

describe('P02 卡片目录', () => {
  it('renders the grid grouped by kind with counts, kind lines, planned tags and personal state', async () => {
    page();
    expect(await screen.findByRole('heading', { level: 1, name: '卡片目录' })).toBeTruthy();
    const ec2 = await screen.findByRole('article', { name: /Amazon EC2/ });
    expect(within(ec2).getByRole('link', { name: /Amazon EC2/ }).getAttribute('href')).toBe('/labs/svc-ec2');
    // grouped by kind: the section heading names the kind and category, the tile does not repeat it (I6 c)
    expect(ec2.textContent).not.toContain('单服务 · 基础');
    expect(ec2.closest('section')?.querySelector('h2')?.textContent).toContain('基础');
    // I6 c：服务图标 + 迷你架构图 + 指标图标（时长用 Intl 的分钟；时间上限只给读屏）
    expect(ec2.querySelector('[data-glyph="ec2"]')).toBeTruthy();
    expect(ec2.querySelector('[data-arch="svc-ec2"] svg.arch-svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(ec2.querySelector('[data-metric="duration"]')!.textContent).toContain('60');
    expect(ec2.textContent).toContain('上限 1.5 小时');
    await waitFor(() => expect(within(ec2).getByText('已完成')).toBeTruthy());
    expect(within(ec2).getByRole('img', { name: '徽章：EC2 基线，已核验' })).toBeTruthy();
    // 卡片上没有“开始”按钮
    expect(within(ec2).queryByRole('button')).toBeNull();
    const cost = screen.getByRole('article', { name: /AWS Budgets/ });
    expect(within(cost).getByText('即将推出')).toBeTruthy();
    expect(within(cost).getByText('需要邮箱确认')).toBeTruthy();
    const sc = screen.getByRole('article', { name: /削峰与重试/ });
    expect(sc.textContent).toContain('场景 · 包含 3 个服务');
    expect(screen.getByRole('heading', { level: 2, name: /单服务卡片 · 基础/ }).textContent).toContain('已完成 1 / 1');
    expect(screen.getByRole('heading', { level: 2, name: /场景卡片/ })).toBeTruthy();
    // 继续学习条：推荐下一张（svc-ec2 已完成 → svc-iam）
    expect(screen.getByText('继续学习').parentElement!.textContent).toContain('svc-iam');
  });

  it('facets filter, count and write the query string; empty results explain the filters and can be cleared', async () => {
    const { loc } = page();
    await screen.findByRole('article', { name: /Amazon EC2/ });
    const scenario = screen.getByRole('button', { name: /^场景/ });
    fireEvent.click(scenario);
    await waitFor(() => expect(loc()).toBe('/labs?kind=scenario'));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('显示 1 / 6 张')).toBeTruthy();
    expect(scenario.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^\$\$\$ 高/ }));
    expect(await screen.findByText('没有符合条件的卡片')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '清除筛选' }).pop()!);
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(6));
  });

  it('search matches legacy lab numbers and is reflected in the URL; Esc clears it', async () => {
    const { loc } = page();
    await screen.findByRole('article', { name: /Amazon EC2/ });
    const box = screen.getByRole('searchbox', { name: '搜索卡片（快捷键 /）' });
    fireEvent.change(box, { target: { value: 'lab 10' } });
    await waitFor(() => expect(loc()).toBe('/labs?q=lab+10'));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('data-card'))).toEqual(['svc-queue', 'sc-decoupling']);
    expect(screen.getAllByText('原 Lab 10').length).toBe(2);
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(loc()).toBe('/labs'));
  });

  it('restores the last view and filters from localStorage when the URL has none', async () => {
    localStorage.setItem(CATALOG_PREFS_KEY, JSON.stringify('kind=service&sort=duration'));
    const { loc } = page();
    await waitFor(() => expect(loc()).toBe('/labs?sort=duration&kind=service'));
  });

  it('the holder card gets “回到工作台” and the environment bar shows the running session', async () => {
    page('/labs', { current: { labId: 'svc-queue', sessionId: 's1', state: 'RUNNING' } });
    const bar = await screen.findByRole('region', { name: '当前环境' });
    await waitFor(() => expect(bar.textContent).toContain('svc-queue'));
    expect(bar.textContent).toContain('实验中');
    expect(within(bar).getByRole('link', { name: '回到工作台' }).getAttribute('href')).toBe('/workspace/s1');
    expect(within(bar).getByRole('button', { name: '结束实验…' })).toBeTruthy();
    const tile = screen.getByRole('article', { name: /Amazon SQS/ });
    await waitFor(() => expect(within(tile).getByRole('link', { name: '回到工作台' }).getAttribute('href')).toBe('/workspace/s1'));
    expect(tile.textContent).toMatch(/进行中 · 剩余 \d+:\d\d/);
  });

  it('personal status failure keeps the cards and greys out the status facet', async () => {
    page('/labs', { routes: { 'GET /api/v1/labs': json(503, { code: 'UPSTREAM_UNAVAILABLE', status: 503, title: 'x' }) } });
    await screen.findByRole('article', { name: /Amazon EC2/ });
    await waitFor(() => expect(screen.getAllByText('状态暂不可用').length).toBeGreaterThan(1));
    expect(screen.getByRole('button', { name: /^已完成/ }).getAttribute('aria-disabled')).toBe('true');
  });

  it('service map: cells with levels, roving tabindex, and the side panel opened via cell=', async () => {
    const { loc } = page('/labs?view=map');
    const cell = await screen.findByRole('button', { name: /Amazon EC2，运行整个应用，已掌握，60 分/ });
    expect(cell.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('group', { name: 'D 计算、异步与通知' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Amazon SQS/ }));
    await waitFor(() => expect(loc()).toBe('/labs?view=map&cell=sqs'));
    const panel = await screen.findByRole('dialog', { name: 'Amazon SQS · 异步任务队列与死信队列' });
    expect(within(panel).getByText('计入本服务的场景卡')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'sc-decoupling' })).toBeTruthy();
  });

  it('tracks view: stage list with roles, groups and recommendation; learners can set the current track', async () => {
    const { f } = page('/labs?view=tracks&track=quick-compare');
    expect(await screen.findByRole('combobox', { name: '路径' })).toBeTruthy();
    const head = document.querySelector('[data-track-head="quick-compare"]')!;
    expect(head.textContent).toContain('必修 0/2');
    fireEvent.click(within(head as HTMLElement).getByRole('button', { name: '设为当前路径' }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/me') && (c.body as { currentTrackId?: string }).currentTrackId === 'quick-compare')).toBe(true));
  });

  it('shows the one-time “首次设置已跳过” note', async () => {
    sessionStorage.setItem('atl.setup.skipped.v1', 'true');
    page();
    expect(await screen.findByText('首次设置已跳过：可在 设置 › 平台 中重看。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭提醒' }));
    await waitFor(() => expect(screen.queryByText('首次设置已跳过：可在 设置 › 平台 中重看。')).toBeNull());
  });

  it('catalog not published → error panel', async () => {
    page('/labs', { routes: { 'GET /api/v1/catalog': json(404, { code: 'NOT_FOUND', status: 404, title: 'no release' }) } });
    expect(await screen.findByText('还没有发布卡片目录。')).toBeTruthy();
    expect(V).toBeTruthy();
    expect(NOW).toBeGreaterThan(0);
  });
});
