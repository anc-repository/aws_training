/**
 * Local L0 for the dev runner (`ATL_DEV_RUNNER_MODE=local-l0`): `base-deploy` starts a CloudAlbum api process on a free
 * port with a fresh config / data dir (reusing scripts/smoke/lib.mjs, the same helper the L0 smoke test uses), `destroy`
 * stops it. Requires `npm run build` (backend/dist). Platform-mode settings of 06 (platform.env, probe token) are applied
 * by the CloudAlbum platform-mode implementer's CLI once it exists; this launcher only provides a running L0.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface SmokeLib {
  freePort(): Promise<number>;
  makeEnvDir(opts: { name: string; port: number; base?: Record<string, string> }): { root: string; etc: string; data: string; baseUrl: string; port: number };
  startProcess(kind: 'api' | 'worker', env: { etc: string }, opts: { root: string; extraEnv?: Record<string, string> }): {
    stop(): Promise<void>;
    log: string;
  };
  waitHealthy(baseUrl: string, proc: unknown, timeoutMs?: number): Promise<void>;
  requireBuild(): void;
}

export interface LocalL0Instance {
  baseUrl: string;
  root: string;
  stop(): Promise<void>;
}

export class LocalL0Launcher {
  private readonly running = new Map<string, LocalL0Instance>();

  constructor(private readonly repoRoot: string) {}

  private async lib(): Promise<SmokeLib> {
    return (await import(pathToFileURL(path.join(this.repoRoot, 'scripts', 'smoke', 'lib.mjs')).href)) as SmokeLib;
  }

  async start(envId: string, envName: string): Promise<LocalL0Instance> {
    const existing = this.running.get(envId);
    if (existing) return existing;
    const lib = await this.lib();
    const port = await lib.freePort();
    const env = lib.makeEnvDir({ name: `atl-${envName}`, port, base: { CLOUDALBUM_ENV: envName } });
    const proc = lib.startProcess('api', env, { root: env.root });
    await lib.waitHealthy(env.baseUrl, proc, 90_000);
    const inst: LocalL0Instance = { baseUrl: env.baseUrl, root: env.root, stop: () => proc.stop() };
    this.running.set(envId, inst);
    return inst;
  }

  async stop(envId: string): Promise<void> {
    const inst = this.running.get(envId);
    this.running.delete(envId);
    await inst?.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((k) => this.stop(k)));
  }
}
