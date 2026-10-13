/**
 * Dev wiring of the 03 workspace and the member directory (ATL_DEV_MODE=1):
 *
 * - the local mock Session Manager of `@atl/ssm-client` (`platform/ssm-client/src/mock`): reused when one already
 *   answers at `ATL_DEV_SSM_MOCK_URL` (default `http://127.0.0.1:8790`, e.g. started by `npm run platform:dev`),
 *   otherwise started in this process on that port (or a free one);
 * - the federation stub (`/__dev/federation` on the dev server);
 * - `createDevWorkspaceAccess` + the real `WorkspaceProvider`, and the dev `MemberDirectory`.
 *
 * `@atl/ssm-client` is not a dependency of `@atl/api` (not linked in the lockfile yet), so the mock is loaded from its
 * sources by path (tsx / vitest transpile it).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApiExtensions } from '../../routes/extensions.js';
import { createDevMemberDirectory } from '../../services/members/index.js';
import { createDevWorkspaceAccess } from '../../services/workspace/dev-access.js';
import { DevFederationStub } from '../../services/workspace/dev-federation.js';
import { cachedProber, type PreviewProber } from '../../services/workspace/preview.js';
import { createWorkspaceProvider } from '../../services/workspace/provider.js';
import { REPO_ROOT } from '../config.js';
import type { DevEnvRegistry } from './envs.js';

interface MockServer {
  httpOrigin: string;
  close(): Promise<void>;
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Start (or reuse) the SSM mock; `null` when neither works (terminal routes then answer 503 with a hint). */
export async function ensureSsmMock(opts: { url?: string; quiet?: boolean } = {}): Promise<{ url: string; close: () => Promise<void>; started: boolean } | null> {
  const url = opts.url ?? process.env.ATL_DEV_SSM_MOCK_URL ?? 'http://127.0.0.1:8790';
  if (await healthy(url)) return { url, close: async () => undefined, started: false };
  const port = Number(new URL(url).port || 8790);
  const file = pathToFileURL(path.join(REPO_ROOT, 'platform', 'ssm-client', 'src', 'mock', 'server.ts')).href;
  try {
    const m = (await import(/* @vite-ignore */ file)) as { startMockSsmServer(o: Record<string, unknown>): Promise<MockServer> };
    const log = opts.quiet ? undefined : (line: string) => process.stdout.write(`[ssm-mock] ${line}\n`);
    let server: MockServer;
    try {
      server = await m.startMockSsmServer({ host: '127.0.0.1', port, mode: 'shell', handshake: 'session-type', log });
    } catch {
      server = await m.startMockSsmServer({ host: '127.0.0.1', port: 0, mode: 'shell', handshake: 'session-type', log });
    }
    return { url: server.httpOrigin, close: () => server.close(), started: true };
  } catch (e) {
    console.warn(`dev: SSM mock not available (${e instanceof Error ? e.message : String(e)}); terminals will answer 503`);
    return null;
  }
}

export interface DevExtensions {
  ext: ApiExtensions;
  federation: DevFederationStub;
  ssmMockUrl: string | null;
  close(): Promise<void>;
}

/** Dev preview probe: local L0 entries are http:// (MIXED_CONTENT); https entries are reported unreachable, never fetched. */
const devProbe: PreviewProber = async (url) =>
  url.startsWith('https://') ? { embeddable: false, reason: 'UNREACHABLE', probed: false, detail: 'dev: preview probes do not leave this machine' } : { embeddable: false, reason: 'MIXED_CONTENT', probed: false };

export async function createDevExtensions(o: { port: number; dataDir: string; nowMs: () => number; envs?: DevEnvRegistry; ssmMockUrl?: string; quiet?: boolean }): Promise<DevExtensions> {
  const mock = await ensureSsmMock({ ...(o.ssmMockUrl ? { url: o.ssmMockUrl } : {}), ...(o.quiet ? { quiet: true } : {}) });
  const federation = new DevFederationStub(o.nowMs);
  const access = createDevWorkspaceAccess({
    ssmMockUrl: mock?.url ?? 'http://127.0.0.1:1',
    federationUrl: `http://127.0.0.1:${o.port}/__dev/federation`,
    dataDir: o.dataDir,
    nowMs: o.nowMs,
    ...(o.envs ? { envs: o.envs } : {}),
  });
  return {
    ext: { workspace: createWorkspaceProvider({ access, probe: cachedProber(devProbe, o.nowMs) }), memberDirectory: createDevMemberDirectory() },
    federation,
    ssmMockUrl: mock?.url ?? null,
    close: async () => {
      await mock?.close();
    },
  };
}
