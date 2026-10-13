import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { CapabilitiesResponse } from '@cloudalbum/contracts';
import { AuthProvider } from '../auth';
import { CapabilitiesProvider } from '../capabilities/CapabilitiesProvider';
import { capsWith, installMockFetch, l0Caps, registry, renderWithProviders } from '../test/helpers';
import { LoginPage } from './Login';
import { MyOutboxPage } from './MyOutbox';
import { RegisterPage, VerifyPage } from './Register';

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('登录页（local provider）', () => {
  it('显示“本地账号（EC2）”徽章与“当前连接未加密”横幅（https.trusted=false）', async () => {
    installMockFetch();
    renderWithProviders(<LoginPage />, { route: '/login' });
    expect(await screen.findByText('本地账号（EC2）')).toBeTruthy();
    expect(screen.getByText('当前连接未加密')).toBeTruthy();
  });

  it('受信 HTTPS 时不显示未加密横幅', async () => {
    installMockFetch();
    renderWithProviders(<LoginPage />, { route: '/login', caps: { ...l0Caps(), https: { trusted: true, via: 'default@cloudfront' } } });
    await screen.findByText('本地账号（EC2）');
    expect(screen.queryByText('当前连接未加密')).toBeNull();
  });

  it('错误密码给出统一提示；正确密码登录后跳转 next', async () => {
    installMockFetch();
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/albums" element={<p>相册页</p>} />
      </Routes>,
      { route: '/login?next=%2Falbums' },
    );
    await screen.findByLabelText('邮箱');
    type('邮箱', 'demo@example.com');
    type('密码', 'wrong-password-1');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText(/邮箱或密码不正确/)).toBeTruthy();
    type('密码', 'cloudalbum-dev-1');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('相册页')).toBeTruthy();
  });
});

describe('注册 → /me/outbox → 验证（L0 冒烟测试第 2 条的前端路径）', () => {
  it('注册后提示本地 outbox；受限会话可以在 /me/outbox 看到验证邮件；验证链接自动提交', async () => {
    const backend = installMockFetch();
    renderWithProviders(
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/me/outbox" element={<MyOutboxPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/login" element={<p>登录页</p>} />
      </Routes>,
      { route: '/register' },
    );
    await screen.findByLabelText('昵称');
    type('昵称', '新同学');
    type('邮箱', 'new@example.com');
    type(/^密码$/, 'abc12345');
    type('确认密码', 'abc12345');
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByText(/验证邮件已写入本地 outbox/)).toBeTruthy();
    const mail = backend.outbox.find((m) => m.to.includes('new@example.com'));
    expect(mail?.category).toBe('verification');

    fireEvent.click(screen.getByRole('link', { name: '/me/outbox' }));
    expect(await screen.findByText(/本地实现，未真正发信/)).toBeTruthy();
    expect(await screen.findByText('验证你的 CloudAlbum 邮箱')).toBeTruthy();
  });

  it('/verify?email&code 自动提交并跳到登录页', async () => {
    const backend = installMockFetch();
    await fetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'v@example.com', password: 'abc12345', displayName: 'v' }) });
    const code = backend.codes.get('v@example.com')!.code;
    renderWithProviders(
      <Routes>
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/login" element={<p>登录页</p>} />
      </Routes>,
      { route: `/verify?email=v%40example.com&code=${code}` },
    );
    expect(await screen.findByText('登录页')).toBeTruthy();
    expect(backend.users.find((u) => u.email === 'v@example.com')?.emailVerified).toBe(true);
  });
});

describe('Cognito provider（动态加载）', () => {
  function renderCognito(caps: CapabilitiesResponse, route: string) {
    return render(
      <CapabilitiesProvider fetchCapabilities={async () => caps} fetchRegistry={async () => registry} pollMs={0}>
        <AuthProvider>
          <MemoryRouter initialEntries={[route]}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </CapabilitiesProvider>,
    );
  }

  const cognito = (loginMode: string) => capsWith({
    auth: {
      driver: 'cognito', status: 'ok', detail: 'User Pool ap-northeast-1_AbCdEf',
      public: { driver: 'cognito', userPoolId: 'ap-northeast-1_AbCdEf', userPoolClientId: 'client', region: 'ap-northeast-1', hostedUiDomain: 'auth.example.com', loginMode, mfa: 'optional', passwordPolicy: { minLength: 8, requireUpper: true, requireDigit: true, requireSymbol: false } },
    },
  });

  it('sdk 子模式：仍是本站表单，徽章为“登录由 Amazon Cognito 提供”', async () => {
    installMockFetch();
    renderCognito(cognito('sdk'), '/login');
    expect(await screen.findByText('登录由 Amazon Cognito 提供')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.queryByText('当前连接未加密')).toBeNull();
  });

  it('managed 子模式：显示“前往托管登录页”，内置注册表单重定向到登录页', async () => {
    installMockFetch();
    renderCognito(cognito('managed'), '/register');
    expect(await screen.findByRole('button', { name: '前往托管登录页' })).toBeTruthy();
    expect(screen.getByText(/请在托管登录页注册/)).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(screen.queryByLabelText('昵称')).toBeNull());
  });
});
