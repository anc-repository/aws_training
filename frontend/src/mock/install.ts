// 安装开发用模拟后端：包装 globalThis.fetch。
//   - all：/api、/social、/media、/.well-known 全部由 MockBackend 处理（不需要启动后端）；
//   - auto（vite dev 的默认值）：先探测真实后端 GET /api/health/live；可达 → 只有返回 501（脚手架桩）或网络错误的接口改由模拟后端处理；
//     不可达 → 等同 all；
//   - off：不安装。
// 选择方式：URL 参数 ?mock=all|auto|off（记在 sessionStorage），或环境变量 VITE_CLOUDALBUM_MOCK。
import type { RegistryDocument } from '@cloudalbum/contracts';
import { MockBackend } from './server';

export type MockMode = 'all' | 'auto' | 'off';

const KEY = 'cloudalbum.mock.mode';
const API_RE = /^\/(api|social|media|\.well-known)(\/|$)/;

export function resolveMockMode(envDefault: string | undefined): MockMode {
  let mode: string | null = null;
  try {
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('mock');
    if (fromUrl) globalThis.sessionStorage?.setItem(KEY, fromUrl);
    mode = fromUrl ?? globalThis.sessionStorage?.getItem(KEY) ?? null;
  } catch {
    mode = null;
  }
  const m = mode ?? envDefault ?? 'auto';
  return m === 'all' || m === 'off' ? m : 'auto';
}

function requestPath(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw, globalThis.location?.href ?? 'http://localhost/');
    return u.origin === (globalThis.location?.origin ?? u.origin) ? u.pathname : '';
  } catch {
    return '';
  }
}

export async function installMockApi(mode: MockMode, registry: RegistryDocument): Promise<MockMode> {
  if (mode === 'off') return 'off';
  const realFetch = globalThis.fetch.bind(globalThis);
  let effective: MockMode = mode;
  if (mode === 'auto') {
    try {
      const r = await realFetch('/api/health/live', { headers: { Accept: 'application/json' } });
      const ct = r.headers.get('content-type') ?? '';
      effective = r.ok && ct.includes('json') ? 'auto' : 'all';
    } catch {
      effective = 'all';
    }
  }
  const backend = new MockBackend(registry, { persistSession: true });
  const mocked: typeof fetch = async (input, init) => {
    const path = requestPath(input);
    if (!path || !API_RE.test(path)) return realFetch(input, init);
    const req = new Request(input instanceof Request ? input : new URL(String(input instanceof URL ? input.href : input), globalThis.location.href), init);
    if (effective === 'all') return (await backend.handle(req)) ?? realFetch(input, init);
    // auto：真实后端优先；501（桩）与网络错误时退回模拟
    try {
      const res = await realFetch(req.clone());
      if (res.status !== 501) return res;
    } catch {
      /* 落到模拟 */
    }
    return (await backend.handle(req)) ?? new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
  };
  globalThis.fetch = mocked;
  (globalThis as { __CLOUDALBUM_MOCK__?: string }).__CLOUDALBUM_MOCK__ = effective === 'all' ? '全部接口' : '仅 501 的接口';
  return effective;
}
