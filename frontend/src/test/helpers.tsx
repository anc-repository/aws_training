// 测试辅助：L0 capabilities、以模拟后端驱动 fetch、带全部 Provider 的渲染。
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { CapabilitiesResponse, ModuleCapability, ModuleId } from '@cloudalbum/contracts';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import { CapabilitiesProvider } from '../capabilities/CapabilitiesProvider';
import { LocalAuthProvider } from '../auth/LocalAuthProvider';
import { buildL0Capabilities } from '../mock/fixtures';
import { MockBackend } from '../mock/server';

export const registry = REGISTRY_DOCUMENT;

export function l0Caps(view: 'public' | 'admin' = 'public'): CapabilitiesResponse {
  return buildL0Capabilities(REGISTRY_DOCUMENT, view);
}

/** 在 L0 capabilities 上改几个模块 */
export function capsWith(patch: Partial<Record<ModuleId, Partial<ModuleCapability>>>, base = l0Caps()): CapabilitiesResponse {
  const modules = { ...base.modules };
  for (const [id, p] of Object.entries(patch) as Array<[ModuleId, Partial<ModuleCapability>]>) {
    modules[id] = { ...modules[id], ...p } as ModuleCapability;
  }
  return { ...base, modules };
}

/** 用 MockBackend 处理同源 API 请求（相对 URL 补成 jsdom 的 location） */
export function installMockFetch(opts: { seed?: boolean } = {}): MockBackend {
  const backend = new MockBackend(REGISTRY_DOCUMENT, { seed: opts.seed ?? true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, globalThis.location.href);
    const req = new Request(url, init);
    const res = await backend.handle(req);
    return res ?? new Response('not found', { status: 404 });
  }) as typeof fetch;
  return backend;
}

export function renderWithProviders(
  ui: ReactNode,
  opts: { caps?: CapabilitiesResponse; route?: string } = {},
): RenderResult {
  const caps = opts.caps ?? l0Caps();
  return render(
    <CapabilitiesProvider fetchCapabilities={async () => caps} fetchRegistry={async () => REGISTRY_DOCUMENT} pollMs={0}>
      <LocalAuthProvider>
        <MemoryRouter initialEntries={[opts.route ?? '/']}>{ui}</MemoryRouter>
      </LocalAuthProvider>
    </CapabilitiesProvider>,
  );
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
}
