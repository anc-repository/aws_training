/**
 * Local L0 for the dev runner (`ATL_DEV_RUNNER_MODE=local-l0`): `base-deploy` starts a CloudAlbum api process on a free
 * port with a fresh config / data dir (reusing scripts/smoke/lib.mjs, the same helper the L0 smoke test uses), `destroy`
 * stops it. Requires `npm run build` (backend/dist).
 *
 * Platform mode (06 PM-01, PM-09): when the session facts are given, the launcher writes what `scripts/module bootstrap
 * --platform` + `cloudalbum platform:apply-env` + `cloudalbum probe-token --init` leave on an instance: `etc/platform.env`
 * (ATL_PLATFORM_MODE=on, session / env / lab ids, platform origin) and the local probe secret `etc/atl/probe.token`.
 * `CLOUDALBUM_ENV` equals the envName (ATL-CFG rule). The check bundle reads the same files through ATL_DEV_APP_ROOT.
 * Like base-deploy's `admin:ensure` (06 PM-07), an application administrator is created; its initial password is written
 * to `etc/atl/app-admin-password` (the dev stand-in for the SSM parameter `/cloudalbum/<envName>/atl/app-admin-password`).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
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
  cli(etc: string, args: string[], extraEnv?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
}

export interface LocalL0Instance {
  baseUrl: string;
  root: string;
  stop(): Promise<void>;
}

export interface LocalL0Platform {
  sessionId: string;
  labId: string;
  variant?: string;
  /** https origin of the platform (frame-ancestors); default https://127.0.0.1:8787 */
  origin?: string;
}

export class LocalL0Launcher {
  private readonly running = new Map<string, LocalL0Instance>();

  constructor(private readonly repoRoot: string) {}

  private async lib(): Promise<SmokeLib> {
    return (await import(pathToFileURL(path.join(this.repoRoot, 'scripts', 'smoke', 'lib.mjs')).href)) as SmokeLib;
  }

  /** platform.env + probe secret in the config dir (what the instance has after bootstrap in platform mode). */
  static writePlatformFiles(etc: string, envId: string, envName: string, p: LocalL0Platform): void {
    const lines = [
      'ATL_PLATFORM_MODE=on',
      `ATL_SESSION_ID=${p.sessionId}`,
      `ATL_ENV_ID=${envId}`,
      `ATL_ENV_NAME=${envName}`,
      `ATL_LAB_ID=${p.labId}`,
      `ATL_VARIANT=${p.variant ?? 'default'}`,
      `ATL_PLATFORM_ORIGIN=${p.origin ?? 'https://127.0.0.1:8787'}`,
      'ATL_PROBE_TOKEN_FILE=/etc/cloudalbum/atl/probe.token',
    ];
    fs.writeFileSync(path.join(etc, 'platform.env'), `${lines.join('\n')}\n`);
    fs.mkdirSync(path.join(etc, 'atl'), { recursive: true });
    fs.writeFileSync(path.join(etc, 'atl', 'probe.token'), `atlpk1.${randomBytes(32).toString('base64url')}\n`);
  }

  async start(envId: string, envName: string, platform?: LocalL0Platform): Promise<LocalL0Instance> {
    const existing = this.running.get(envId);
    if (existing) return existing;
    const lib = await this.lib();
    const port = await lib.freePort();
    const env = lib.makeEnvDir({ name: `atl-${envName}`, port, base: { CLOUDALBUM_ENV: envName } });
    if (platform) LocalL0Launcher.writePlatformFiles(env.etc, envId, envName, platform);
    const proc = lib.startProcess('api', env, { root: env.root });
    // Generous by default: on a busy dev machine (parallel builds / test runs) a cold api start can take minutes.
    const readyTimeoutMs = Number(process.env.ATL_DEV_L0_READY_TIMEOUT_MS ?? 240_000);
    try {
      await lib.waitHealthy(env.baseUrl, proc, readyTimeoutMs);
    } catch (e) {
      let tail = '';
      try { tail = fs.readFileSync(proc.log, 'utf8').split('\n').slice(-30).join('\n'); } catch { /* no log yet */ }
      await proc.stop().catch(() => undefined);
      const hint = `local L0 did not become ready within ${Math.round(readyTimeoutMs / 1000)} s; ATL_DEV_L0_READY_TIMEOUT_MS raises it`;
      throw new Error(`${(e as Error).message.trim()} (${hint})${tail ? `\n--- api log (last lines) ---\n${tail}` : ''}`);
    }
    if (platform) {
      const password = randomBytes(18).toString('base64url');
      const r = lib.cli(env.etc, ['admin:create', '--email', `atl-admin@${envName}.example.test`, '--password', password]);
      if (r.status !== 0) {
        await proc.stop();
        throw new Error(`local L0: admin:create failed: ${r.stderr || r.stdout}`);
      }
      fs.writeFileSync(path.join(env.etc, 'atl', 'app-admin-password'), `${password}\n`, { mode: 0o600 });
    }
    const inst: LocalL0Instance = { baseUrl: env.baseUrl, root: env.root, stop: () => proc.stop() };
    this.running.set(envId, inst);
    return inst;
  }

  isRunning(envId: string): boolean {
    return this.running.has(envId);
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
