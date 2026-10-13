// 端到端（浏览器内）：AppRoutes + 全部 Provider + 模拟后端，走一遍时间线、照片详情、点赞评论、分享与管理后台。
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from './App';
import { installMockFetch, l0Caps, renderWithProviders } from './test/helpers';
import { getTraceSnapshot } from './trace/TraceStore';

async function login(email = 'demo@example.com') {
  const r = await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'cloudalbum-dev-1' }) });
  expect(r.status).toBe(200);
}

describe('App（L0 + 模拟后端）', () => {
  it('未登录：时间线显示欢迎卡片与登录方式徽章；页脚显示入口与 EC2', async () => {
    installMockFetch();
    renderWithProviders(<AppRoutes />);
    expect(await screen.findByText(/面向 AWS SAA-C03 学习者的云相册/)).toBeTruthy();
    expect(screen.getAllByText('本地账号（EC2）').length).toBeGreaterThan(0);
    const footer = screen.getByRole('contentinfo', { name: '运行状态' });
    expect(within(footer).getByText(/运行在 EC2/)).toBeTruthy();
    expect(within(footer).getByText(/入口：直连（开发机，无 Nginx）/)).toBeTruthy();
  });

  it('登录后：时间线带请求级 cache 徽章与 DB 次数；照片网格有 CDN 角标', async () => {
    installMockFetch();
    await login();
    renderWithProviders(<AppRoutes />);
    expect(await screen.findByRole('heading', { name: '时间线' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('link', { name: /东京塔|海边|雪山/ }).length).toBeGreaterThan(0));
    expect(screen.getByText('时间线 · 未缓存')).toBeTruthy();
    expect(screen.getByText('SQLite（EBS 文件）')).toBeTruthy();
    expect(screen.getByText(/DB 2 次/)).toBeTruthy();
    expect(screen.getAllByText('图片由 EC2 Nginx 直出').length).toBeGreaterThan(0);
    const feedTrace = getTraceSnapshot().entries.find((e) => e.route === '/api/feed');
    expect(feedTrace?.path.modules.map((m) => m.module)).toEqual(['auth', 'cache', 'database']);
  });

  it('照片详情：存储与缩略图徽章、点赞、评论、分享链接', async () => {
    const backend = installMockFetch();
    await login();
    const photo = backend.photos.find((p) => p.ownerId === backend.users[1]!.id)!;
    renderWithProviders(<AppRoutes />, { route: `/photos/${photo.id}` });
    expect(await screen.findByText('存储于 EC2 本地磁盘（EBS）')).toBeTruthy();
    expect(screen.getByText(/缩略图由 EC2 生成 · \d+ ms（inline）/)).toBeTruthy();
    expect(screen.getByText('基础属性标签（本地）')).toBeTruthy();

    const like = await screen.findByRole('button', { name: /点赞 · 0/ });
    fireEvent.click(like);
    expect(await screen.findByRole('button', { name: /已赞 · 1/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('写评论'), { target: { value: '第一条评论' } });
    fireEvent.click(screen.getByRole('button', { name: '发表评论' }));
    expect(await screen.findByText('第一条评论')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '生成链接' }));
    const input = await screen.findByLabelText('分享链接');
    expect((input as HTMLInputElement).value).toMatch(/\/s\/[a-z0-9]+$/);
  });

  it('分享页：过期链接给出明确说明', async () => {
    const backend = installMockFetch();
    const photo = backend.photos[0]!;
    backend.shares.set('expiredtoken', { photoId: photo.id, expiresAt: new Date(Date.now() - 1000).toISOString(), by: 'x' });
    renderWithProviders(<AppRoutes />, { route: '/s/expiredtoken' });
    expect(await screen.findByText('链接已过期或不存在')).toBeTruthy();
  });

  it('上传页：显示由谁提供上传与将使用的策略', async () => {
    installMockFetch();
    await login();
    renderWithProviders(<AppRoutes />, { route: '/upload' });
    expect(await screen.findByText('上传到 EC2（签名 URL）')).toBeTruthy();
    expect(screen.getByText('逐文件签名 URL（F6）', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('storage:local')).toBeTruthy();
  });

  it('管理后台：非管理员看到无权限；管理员看到用户列表与审计', async () => {
    installMockFetch();
    await login();
    const { unmount } = renderWithProviders(<AppRoutes />, { route: '/admin/users' });
    expect(await screen.findByText('没有权限')).toBeTruthy();
    unmount();

    await fetch('/api/auth/logout', { method: 'POST' });
    await login('admin@example.com');
    renderWithProviders(<AppRoutes />, { route: '/admin/users' });
    expect(await screen.findByText('demo@example.com')).toBeTruthy();
    expect(screen.getByText(/管理后台由应用层 RBAC 保护/)).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '审计' }));
    expect(await screen.findByRole('button', { name: '校验哈希链' })).toBeTruthy();
    expect(await screen.findAllByText('user.login')).toBeTruthy();
  });

  it('校验警告与不安全实验模式横幅', async () => {
    installMockFetch();
    const caps = l0Caps();
    caps.validation.warnings.push({ rule: 'SEC-004', modules: [], message: '路径头会暴露内部架构' });
    caps.validation.overridden.push({ rule: 'DEP-028', modules: ['cdn'], message: '媒体未经 CDN' });
    renderWithProviders(<AppRoutes />, { caps });
    expect(await screen.findByText('路径头会暴露内部架构')).toBeTruthy();
    expect(screen.getByText('不安全实验模式')).toBeTruthy();
  });

  it('通知铃铛显示未读数，通知页可以全部标为已读', async () => {
    installMockFetch();
    await login('admin@example.com');
    renderWithProviders(<AppRoutes />, { route: '/notifications' });
    expect(await screen.findByRole('link', { name: /通知（1 条未读）/ })).toBeTruthy();
    expect(await screen.findByText(/示例用户 评论了你的照片/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '全部标为已读' })); });
    await waitFor(() => expect(screen.getByRole('button', { name: '全部标为已读' }).hasAttribute('disabled')).toBe(true));
  });
});
