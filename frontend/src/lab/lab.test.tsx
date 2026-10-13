import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LabResultRow } from '../api/types';
import { AppRoutes } from '../App';
import { capsWith, installMockFetch, l0Caps, renderWithProviders } from '../test/helpers';
import { enableCommand } from './SwitchHowTo';
import { latestDelta } from './labUtil';
import { compareRows, driverDiff } from './Compare';
import { registry } from '../test/helpers';

async function login(email: string) {
  await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'cloudalbum-dev-1' }) });
}

describe('/lab', () => {
  it('按 A～F 分组显示 40 个模块卡片；卡片内容来自 registry 与 capabilities', async () => {
    installMockFetch();
    await login('demo@example.com');
    renderWithProviders(<AppRoutes />, { route: '/lab' });
    expect(await screen.findByRole('heading', { name: '对比实验室' })).toBeTruthy();
    const cards = await screen.findAllByRole('article');
    expect(cards).toHaveLength(40);
    const cache = screen.getByRole('article', { name: 'cache 模块' });
    expect(within(cache).getByText('时间线 · 未缓存')).toBeTruthy();
    expect(within(cache).getByText(/无缓存：每次时间线请求都查库/)).toBeTruthy();
    expect(within(cache).getByText(/运行时 A\/B/)).toBeTruthy();
    // 普通用户没有“运行 A/B”
    expect(within(cache).queryByRole('button', { name: '运行 A/B' })).toBeNull();
    // 非 MVP 模块标注“本轮未实现 AWS 适配器”
    expect(within(screen.getByRole('article', { name: 'dns 模块' })).getByText('本轮未实现 AWS 适配器')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /本轮实现的 8 个/ }));
    expect(screen.getAllByRole('article')).toHaveLength(9);
  });

  it('“如何切换”给出 scripts/module 命令、硬依赖与计费提示', async () => {
    installMockFetch();
    await login('demo@example.com');
    renderWithProviders(<AppRoutes />, { route: '/lab' });
    const card = await screen.findByRole('article', { name: 'cache 模块' });
    fireEvent.click(within(card).getByRole('button', { name: '如何切换' }));
    const dialog = screen.getByRole('dialog', { name: '如何切换：cache' });
    expect(within(dialog).getByText(/scripts\/module enable cache/)).toBeTruthy();
    expect(within(dialog).getByText(/--driver memory/)).toBeTruthy();
    expect(within(dialog).getByText(/按小时计费，练完记得 disable/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('管理员：已启用且有旁路键的模块出现“运行 A/B”，A/B 运行器交替发送带 / 不带旁路头的请求', async () => {
    installMockFetch();
    await login('admin@example.com');
    const caps = capsWith({ cache: { driver: 'redis', status: 'ok', detail: 'PING 0.4ms', bypass: ['cache'] } }, l0Caps('admin'));
    renderWithProviders(<AppRoutes />, { route: '/lab', caps });
    const card = await screen.findByRole('article', { name: 'cache 模块' });
    fireEvent.click(within(card).getByRole('button', { name: '运行 A/B' }));
    const dialog = screen.getByRole('dialog', { name: '运行 A/B：cache' });
    fireEvent.change(within(dialog).getByLabelText('轮数'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '开始' }));
    await waitFor(() => expect(within(dialog).getByRole('table')).toBeTruthy());
    expect(within(dialog).getAllByText(/bypass=cache/).length).toBeGreaterThan(0);
  });

  it('模块详情：开关、依赖与实验命令；结果列表可以勾选两条对比', async () => {
    installMockFetch();
    await login('admin@example.com');
    renderWithProviders(<AppRoutes />, { route: '/lab/m/cache' });
    expect(await screen.findByRole('heading', { name: /缓存/ })).toBeTruthy();
    expect(screen.getByText(/CACHE_DRIVER=none/)).toBeTruthy();
    expect(screen.getByText(/npm run exp -- cache --scenario feed-read/)).toBeTruthy();
    expect(await screen.findAllByText('feed-read')).toBeTruthy();
  });

  it('实验结果页 → 对比页：环境差异与指标差值', async () => {
    installMockFetch();
    await login('admin@example.com');
    renderWithProviders(<AppRoutes />, { route: '/lab/results' });
    const boxes = await screen.findAllByRole('checkbox', { name: /选择/ });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: '对比所选两条' }));
    expect(await screen.findByRole('heading', { name: '对比两次运行' })).toBeTruthy();
    expect(await screen.findByText('环境差异')).toBeTruthy();
  });
});

describe('lab 工具函数', () => {
  const row = (label: string, p95: number, startedAt: string): LabResultRow => ({
    runId: label, module: 'cache', experiment: 'feed-read', label, startedAt, finishedAt: startedAt, forced: false,
    result: { schemaVersion: 1, runId: label, module: 'cache', experiment: 'feed-read', label, forced: false, startedAt, finishedAt: startedAt, server: { routes: { '/api/feed': { p95 } } }, environment: { drivers: { cache: label === 'after' ? 'redis' : 'none' } } },
  });

  it('latestDelta 取同一实验最新的 before 与 after', () => {
    const d = latestDelta([row('before', 20, '2026-10-13T01:00:00Z'), row('after', 5, '2026-10-13T02:00:00Z')]);
    expect(d).toMatchObject({ experiment: 'feed-read', before: 20, after: 5 });
    expect(d!.ratio).toBeCloseTo(0.25);
  });

  it('compareRows / driverDiff', () => {
    const a = row('before', 20, 't').result;
    const b = row('after', 5, 't').result;
    expect(compareRows(a, b).find((r) => r.name === '/api/feed p95')).toMatchObject({ a: 20, b: 5 });
    expect(driverDiff(a, b)).toEqual([{ module: 'cache', a: 'none', b: 'redis' }]);
  });

  it('enableCommand：凭证必需的模块先启用 iam；本地档与自建档另列', () => {
    expect(enableCommand('queue', registry.modules.queue)).toEqual([
      'scripts/module enable iam --mode role',
      'scripts/module enable queue',
      'scripts/module enable queue --driver memory    # 本地档，不部署栈',
    ]);
    expect(enableCommand('cache', registry.modules.cache).some((c) => c.includes('--self-hosted'))).toBe(true);
  });
});
