/**
 * 结果类画面的测试工具（只被测试引用）：在真实的全局框架（ProtectedShell + Guarded）中按给定路由挂载画面，
 * API 与静态内容（/content/…）都由假 fetch 回答。
 */
import type { CognitoGroup } from '@atl/shared';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import type { SessionView } from '../../api/types';
import { AppProviders } from '../../app/App';
import { createServices } from '../../app/services';
import { Guarded, ProtectedShell } from '../../components/Shells';
import type { Role } from '../../auth/jwt';
import { fakeFetch, json, type FakeResponder } from '../../test/helpers';
import NotFoundPage from '../errors/NotFoundPage';
import { clearStaticCache } from './data';

export const NOW = Date.now();
export const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();

export function sessionView(over: Omit<Partial<SessionView>, 'phases'> & { phases?: unknown[] } & Record<string, unknown> = {}): SessionView {
  return {
    sessionId: 's4k7m2q9x1abc',
    labId: 'svc-cdn',
    state: 'ENDED',
    ver: 7,
    createdAt: iso(-200),
    readyAt: iso(-190),
    endedAt: iso(-90),
    revokedAt: iso(-100),
    serverNow: new Date(NOW).toISOString(),
    catalogVersion: '2026.10.1',
    endReason: 'USER_ENDED',
    phases: [],
    allowedActions: [],
    env: { envId: '01JA0000000000000000000000', envName: 'e7k2m9qx', status: 'RELEASED' },
    cleanup: { deleted: 12, manual: 0 },
    reclaim: { followUp: 'DONE', rescanAt: [iso(-80), iso(-40), iso(260)] },
    progress: { stepsDone: 6, stepsTotal: 7, status: 'completed' },
    resources: { tracked: 12, hourlyBilled: 0 },
    ...over,
  } as SessionView;
}

export interface MountOptions {
  group?: CognitoGroup;
  routes: { path: string; element: ReactElement; roles?: readonly Role[] }[];
  api?: Record<string, FakeResponder | Response>;
  content?: Record<string, unknown>;
}

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{`${l.pathname}${l.search}${l.hash}`}</div>;
}

export function mountAt(path: string, o: MountOptions) {
  clearStaticCache();
  const content: Record<string, Response> = {};
  for (const [k, v] of Object.entries(o.content ?? {})) content[`GET ${k}`] = json(200, v);
  const f = fakeFetch({
    'GET /api/v1/platform': json(200, { version: '1.0.0', region: 'ap-northeast-1', accountId: '111122223333', maintenance: false, mode: 'NORMAL' }),
    'GET /api/v1/me': json(200, { sub: 'u1', groups: [o.group ?? 'learner'], displayName: '张三', certName: '张三', currentTrackId: 'saa-main', onboarding: { completedAt: '2026-10-13T00:00:00Z', version: '1' } }),
    'GET /api/v1/platform/guardrails': json(200, { budget: null, mode: 'NORMAL', maintenance: false, uninstalling: false }),
    'GET /api/v1/catalog': json(200, { catalogVersion: '2026.10.1', indexUrl: '/content/2026.10.1/catalog/index.json' }),
    'GET /api/v1/resources/manual': json(200, { items: [], total: 0, hourlyBlocking: 0 }),
    'GET /api/v1/time': () => json(200, { serverNow: new Date(NOW).toISOString() }),
    'GET /api/v1/sessions/current': () => new Response(null, { status: 204 }),
    'GET /content/2026.10.1/catalog/index.json': json(200, { catalogVersion: '2026.10.1', cards: [{ id: 'svc-cdn', title: 'Amazon CloudFront：内容分发与边缘缓存', kind: 'service', category: 'A', badge: { title: '边缘缓存' } }] }),
    ...content,
    ...(o.api ?? {}),
  });
  globalThis.fetch = f.impl;
  const services = createServices({
    config: { apiBase: '/api/v1', auth: 'dev' },
    fetchImpl: f.impl,
    sessionChannel: null,
    authChannel: null,
    location: { origin: 'http://127.0.0.1:5174', hostname: '127.0.0.1', assign: vi.fn() },
    connectivityTarget: null,
  });
  services.auth.devLogin(o.group ?? 'learner', 'u1');
  const utils = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<ProtectedShell layout="app" />}>
            {o.routes.map((r) => (
              <Route key={r.path} path={r.path} element={<Guarded roles={r.roles ?? ['L', 'A', 'O']}>{r.element}</Guarded>} />
            ))}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </AppProviders>,
  );
  return { ...utils, f, services, loc: () => screen.getByTestId('loc').textContent };
}
