import type { CognitoGroup } from '@atl/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../test/helpers';
import type { SessionView } from '../api/types';
import { AppProviders, AppRoutes } from './App';
import { ROUTE_TABLE, SITEMAP_PATHS } from './routeTable';
import { createServices } from './services';

const NOW = Date.now();

function backend(opts: { current?: Partial<SessionView> | null; onboarded?: boolean } = {}) {
  const current: SessionView | null =
    opts.current === null
      ? null
      : { sessionId: 's1', labId: 'svc-cdn', state: 'RUNNING', ver: 2, createdAt: new Date(NOW - 3600_000).toISOString(), readyAt: new Date(NOW - 1800_000).toISOString(), deadlineAt: new Date(NOW + 3600_000).toISOString(), serverNow: new Date(NOW).toISOString(), allowedActions: ['end', 'extend'], limits: { extensionsLeft: 2, extensionMinutes: 30 }, ...opts.current };
  return fakeFetch({
    'GET /api/v1/platform': json(200, { version: '1.0.0', region: 'ap-northeast-1', drRegion: 'ap-northeast-3', accountId: '111122223333', maintenance: false, mode: 'NORMAL' }),
    'GET /api/v1/me': json(200, { sub: 'u1', groups: ['learner'], displayName: '张三', currentTrackId: 'saa-main', onboarding: opts.onboarded === false ? null : { completedAt: '2026-10-13T00:00:00Z', version: '1' } }),
    'GET /api/v1/platform/guardrails': json(200, { budget: null, mode: 'NORMAL', maintenance: false, uninstalling: false }),
    'GET /api/v1/catalog': json(200, { catalogVersion: '2026.10.1' }),
    'GET /api/v1/resources/manual': json(200, { items: [], total: 0, hourlyBlocking: 0 }),
    'GET /api/v1/time': () => json(200, { serverNow: new Date().toISOString() }),
    'GET /api/v1/sessions/current': () => (current ? json(200, current) : new Response(null, { status: 204 })),
    'GET /api/v1/sessions/s1': () => json(200, current),
    'GET /api/v1/sessions/s1/events': json(200, { events: [], next: null, hasMore: false, pollAfterMs: 15000 }),
    'POST /api/v1/sessions/s1/heartbeat': () => json(200, { serverNow: new Date().toISOString(), state: 'RUNNING', ver: 2, deadlineAt: current?.deadlineAt ?? null, deadlineVersion: 1 }),
    'PATCH /api/v1/me': json(200, {}),
  });
}

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{`${l.pathname}${l.search}${l.hash}`}</div>;
}

function setup(path: string, opts: { group?: CognitoGroup | null; current?: Partial<SessionView> | null; onboarded?: boolean } = {}) {
  const f = backend(opts);
  const services = createServices({
    config: { apiBase: '/api/v1', auth: 'dev' },
    fetchImpl: f.impl,
    sessionChannel: null,
    authChannel: null,
    location: { origin: 'http://127.0.0.1:5174', hostname: '127.0.0.1', assign: vi.fn() },
    connectivityTarget: null,
  });
  if (opts.group !== null) services.auth.devLogin(opts.group ?? 'learner', 'u1');
  else void services.auth.init();
  const utils = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...utils, f, services, loc: () => screen.getByTestId('loc').textContent };
}

describe('route table (08 §2)', () => {
  it('registers every SPA path of the site map (plus the / redirect)', () => {
    const paths = new Set(['/', ...ROUTE_TABLE.map((r) => r.path)]);
    for (const p of SITEMAP_PATHS) expect(paths.has(p)).toBe(true);
    expect(ROUTE_TABLE.find((r) => r.path === '/workspace/:sid')!.layout).toBe('workspace');
    expect(ROUTE_TABLE.find((r) => r.path === '/resources/manual')!.roles).toEqual(['L', 'A']);
    expect(ROUTE_TABLE.find((r) => r.path === '/labs/:labId/quiz')!.roles).toEqual(['L']);
  });
});

describe('App routing and global frame', () => {
  it('unauthenticated visitors land on /login with next; dev mode shows the dev form', async () => {
    const { loc } = setup('/labs?view=map', { group: null });
    expect(await screen.findByRole('heading', { level: 1, name: '登录' })).toBeTruthy();
    expect(loc()).toBe('/login?next=%2Flabs%3Fview%3Dmap');
    expect(screen.getByRole('button', { name: '以开发身份登录' })).toBeTruthy();
  });

  it('learner on /labs: global bar, current nav item, session pill back to the workspace, footer', async () => {
    setup('/labs');
    expect(await screen.findByRole('heading', { level: 1, name: '卡片目录' })).toBeTruthy();
    const header = screen.getByRole('banner');
    const nav = within(header).getByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('link', { name: '卡片目录' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: '学习路径' }).getAttribute('href')).toBe('/tracks/saa-main');
    const pill = await within(header).findByRole('link', { name: /当前实验 svc-cdn，实验中/ });
    expect(pill.getAttribute('href')).toBe('/workspace/s1');
    expect(within(header).getByText('非 AWS 官方')).toBeTruthy();
    expect(screen.getByRole('contentinfo').textContent).toContain('实时 · 轮询中（30 秒）');
    // 账号 ID 打码
    await waitFor(() => expect(header.textContent).toContain('••••3333'));
    expect(header.textContent).not.toContain('111122223333');
  });

  it('`/` redirects to the workspace of the running session; the workspace has no global bar and sends a heartbeat', async () => {
    const { loc, f } = setup('/');
    await waitFor(() => expect(loc()).toBe('/workspace/s1'));
    // the workspace chunk loads lazily: allow for a busy machine (the full suite runs ~230 files in parallel)
    expect(await screen.findByRole('heading', { level: 1, name: /^工作台/ }, { timeout: 5000 })).toBeTruthy();
    // 工作台没有全局顶栏（主导航）；它自己的会话栏（header.wsbar）是本画面的 banner
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
    expect(screen.getByRole('banner').classList.contains('wsbar')).toBe(true);
    await waitFor(() => expect(f.calls.some((c) => c.method === 'POST' && c.url.endsWith('/sessions/s1/heartbeat'))).toBe(true));
    expect(f.calls.find((c) => c.url.endsWith('/heartbeat'))!.body).toEqual({ workbench: true });
  });

  it('learners who have not finished the first-run setup go to /setup (the workspace is exempt)', async () => {
    const { loc } = setup('/learning', { onboarded: false });
    await waitFor(() => expect(loc()).toBe('/setup?next=%2Flearning'));
    expect(await screen.findByRole('heading', { level: 1, name: '首次设置' })).toBeTruthy();
  });

  it('observers get “角色不足” on /resources/manual (address kept)', async () => {
    const { loc } = setup('/resources/manual', { group: 'observer' });
    expect(await screen.findByRole('heading', { level: 1, name: '角色不足' })).toBeTruthy();
    expect(loc()).toBe('/resources/manual');
  });

  it('settings: /settings → profile; assistants cannot open platform; unknown tabs are not found', async () => {
    const a = setup('/settings', { group: 'assistant' });
    await waitFor(() => expect(a.loc()).toBe('/settings/profile'));
    expect(await screen.findByRole('heading', { level: 1, name: '设置' })).toBeTruthy();
    a.unmount();
    setup('/settings/platform', { group: 'assistant' });
    expect(await screen.findByRole('heading', { level: 1, name: '角色不足' })).toBeTruthy();
  });

  it('unknown routes show “页面不存在” inside the frame', async () => {
    setup('/no/such/page', { current: null });
    expect(await screen.findByRole('heading', { level: 1, name: '页面不存在' })).toBeTruthy();
    expect(screen.getByRole('banner')).toBeTruthy();
  });
});
