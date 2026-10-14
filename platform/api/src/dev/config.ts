/**
 * ATL_DEV_MODE=1 configuration (docs/implementation-notes.md “platform-scaffold”). Only the dev runtime reads these.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export type DevRunnerMode = 'noop' | 'dry-run' | 'local-l0';

export interface DevConfig {
  /** Everything the dev runtime writes (buckets, keys, runner runs, local L0 dirs): `.atl-dev/` on the repo drive. */
  dataDir: string;
  /** DynamoDB Local endpoint (docker-compose.platform.yml). */
  ddbEndpoint: string;
  /** Dev clock speed-up: 60 → one real second is one platform minute. */
  timeScale: number;
  /** What the dev runner does for each ATL_OP. */
  runnerMode: DevRunnerMode;
  /** Platform-clock seconds a `noop` build takes. */
  runnerNoopSeconds: number;
  /** JSON file with fake CloudTrail events loaded at start (array of TrailEvent). */
  trailFile: string | null;
  /** Fake CloudTrail delivery delay in platform-clock seconds (events become visible after eventTime + delay). */
  trailDelaySeconds: number;
  /** Node entry of the check runner used for ATL-RunCheck (04 §6.2 runner.mjs); null → checks report RUNNER_UNAVAILABLE. */
  checkRunner: string | null;
  /** Dev HTTP server port. */
  port: number;
  region: string;
  accountId: string;
  signingKeyId: string;
  /** Per-run table names (ATL_DEV_TABLE_MAIN / ATL_DEV_TABLE_LOCKS, e.g. e2e:platform); null → atl-main / cloudalbum-lab-locks. */
  tables: { main: string; locks: string } | null;
  /** `PlatformConfig.platformUrl` of the dev PlatformConfig (ATL_DEV_PLATFORM_URL, e.g. the Vite origin); null → the dev server. */
  platformUrl: string | null;
}

export function loadDevConfig(env: NodeJS.ProcessEnv = process.env): DevConfig {
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const mode = env.ATL_DEV_RUNNER_MODE ?? 'noop';
  if (!['noop', 'dry-run', 'local-l0'].includes(mode)) throw new Error(`ATL_DEV_RUNNER_MODE must be noop | dry-run | local-l0, got ${mode}`);
  return {
    dataDir: path.resolve(env.ATL_DEV_DATA_DIR ?? path.join(REPO_ROOT, '.atl-dev')),
    ddbEndpoint: env.ATL_DEV_DDB_ENDPOINT ?? 'http://127.0.0.1:58000',
    timeScale: num('ATL_DEV_TIME_SCALE', 1),
    runnerMode: mode as DevRunnerMode,
    runnerNoopSeconds: num('ATL_DEV_RUNNER_NOOP_SECONDS', 5),
    trailFile: env.ATL_DEV_TRAIL_FILE ?? null,
    trailDelaySeconds: Number(env.ATL_DEV_TRAIL_DELAY_SECONDS ?? 0) || 0,
    checkRunner: env.ATL_DEV_CHECK_RUNNER ?? null,
    port: num('ATL_DEV_PORT', 8787),
    region: env.AWS_REGION ?? 'ap-northeast-1',
    accountId: '000000000000',
    signingKeyId: env.ATL_DEV_SIGNING_KEY_ID ?? 'dev-signing-key',
    tables: env.ATL_DEV_TABLE_MAIN ? { main: env.ATL_DEV_TABLE_MAIN, locks: env.ATL_DEV_TABLE_LOCKS ?? `${env.ATL_DEV_TABLE_MAIN}-locks` } : null,
    platformUrl: env.ATL_DEV_PLATFORM_URL ?? null,
  };
}
