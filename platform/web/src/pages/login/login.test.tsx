import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../labs/testing';
import AuthCallbackPage from './AuthCallbackPage';
import LoginPage from './LoginPage';
import SignedOutPage from './SignedOutPage';

describe('P01 登录', () => {
  it('shows the reason, the dev form in dev mode and the tab-only note; signing in returns to next', async () => {
    const { loc } = renderPage({ path: '/login?next=%2Flearning&reason=expired', route: '/login', element: <LoginPage />, group: null, others: ['/learning'] });
    expect(await screen.findByRole('heading', { level: 1, name: '登录' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('登录已过期，请重新登录。');
    expect(screen.getByText('非 AWS 官方')).toBeTruthy();
    expect(screen.getByText('登录状态只保存在当前浏览器标签页，关闭标签页后需要重新登录。')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '用户标识' }), { target: { value: 'bad id' } });
    fireEvent.click(screen.getByRole('button', { name: '以开发身份登录' }));
    expect(await screen.findByText('只能包含字母、数字、- 与 _（1～64 个字符）')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '用户标识' }), { target: { value: 'u2' } });
    fireEvent.click(screen.getByRole('button', { name: '以开发身份登录' }));
    await waitFor(() => expect(loc()).toBe('/learning'));
  });

  it('already signed in → straight to next (only same-site paths)', async () => {
    const { loc } = renderPage({ path: '/login?next=https%3A%2F%2Fevil.example.com', route: '/login', element: <LoginPage />, others: ['/'] });
    await waitFor(() => expect(loc()).toBe('/'));
  });

  it('callback without a matching login request is stale; errors from the identity provider are shown', async () => {
    window.history.replaceState(null, '', '/auth/callback?code=x&state=y');
    const a = renderPage({ path: '/auth/callback', route: '/auth/callback', element: <AuthCallbackPage />, group: null });
    expect(await screen.findByText('登录请求已失效（可能是打开了旧的登录页）。请重新登录。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '重新登录' }).getAttribute('href')).toBe('/login');
    a.unmount();
    window.history.replaceState(null, '', '/auth/callback?error=access_denied&error_description=User%20is%20not%20confirmed.');
    renderPage({ path: '/auth/callback', route: '/auth/callback', element: <AuthCallbackPage />, group: null });
    expect(await screen.findByText('登录未完成：User is not confirmed.')).toBeTruthy();
    window.history.replaceState(null, '', '/');
  });

  it('signed out page', async () => {
    renderPage({ path: '/auth/signed-out', route: '/auth/signed-out', element: <SignedOutPage />, group: null });
    expect(await screen.findByRole('heading', { level: 1, name: '已退出' })).toBeTruthy();
    expect(screen.getByText('你已退出 ATL 实验平台。')).toBeTruthy();
  });
});
