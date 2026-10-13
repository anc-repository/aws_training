/**
 * Platform runtime of one scripts/module invocation (06 PM-26～PM-28, PM-35): identity check, state.json from the state bucket,
 * the environment lock for environment-changing commands, progress / result reports, module-operation reports.
 * run() in index.ts calls preparePlatform() before the command and finishPlatform() after it (also on errors).
 */
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import { CliError, EXIT } from '../printer.js';
import { newState, nowIso } from '../state.js';
import { verifyIdentity, type CallerIdentity, type PlatformEnv } from './env.js';
import { EnvLock } from './lock.js';
import { reportModuleOp, Reporter, type ModuleOpBody, type ModuleResult } from './report.js';
import { S3StateStore } from './state-s3.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID (Crockford base32: 10 chars time + 16 chars random) */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) { time = CROCKFORD[t % 32]! + time; t = Math.floor(t / 32); }
  const rnd = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i += 1) r += CROCKFORD[rnd[i]! % 32];
  return time + r;
}

export interface PlatformRuntime {
  env: PlatformEnv;
  identity?: CallerIdentity;
  store: S3StateStore;
  lock?: EnvLock;
  reporter: Reporter;
  opId: string;
  /** the first failed state write (412 → exit 8); later writes are skipped */
  conflict?: CliError;
  pending: Promise<void>;
  /** state.json existed when the command started */
  stateExisted: boolean;
}

export interface PrepareOptions {
  /** the command changes the environment: take the environment lock (06 PM-28) */
  mutating: boolean;
  /** command line for the lock item and the history (`enable cdn`) */
  op: string;
  /** --lock-wait (workstation default 0, runner 900) */
  lockWait?: number;
  allowAnyIdentity?: boolean;
  /** bootstrap / base deploy may create state.json; everything else needs it (STATE_MISSING) */
  mayCreateState?: boolean;
}

export function createPlatformRuntime(ctx: Ctx, env: PlatformEnv, opts: { progressFile?: string; resultFile?: string; command: string }): PlatformRuntime {
  const opId = ulid();
  return {
    env, store: new S3StateStore(ctx.aws, env.stateBucket, env.stateKey), opId,
    reporter: new Reporter({ opId, runId: env.runId ?? null, ...(opts.progressFile ? { progressFile: opts.progressFile } : {}),
      ...(opts.resultFile ? { resultFile: opts.resultFile } : {}), command: opts.command }),
    pending: Promise.resolve(), stateExisted: false,
  };
}

/** identity → state.json → environment lock */
export async function preparePlatform(ctx: Ctx, p: PlatformRuntime, o: PrepareOptions): Promise<void> {
  p.identity = await verifyIdentity(ctx.aws, p.env, { allowAnyIdentity: Boolean(o.allowAnyIdentity) });
  const loaded = await p.store.load();
  if (loaded) {
    if (loaded.env !== p.env.env) throw new CliError(`state.json belongs to env ${loaded.env}, not ${p.env.env}`, EXIT.rules, 'STATE_MISMATCH');
    Object.assign(ctx.state, loaded);
    p.stateExisted = true;
  } else if (loaded === null) {
    if (o.mutating && !o.mayCreateState) {
      throw new CliError(`state.json does not exist (s3://${p.store.bucket}/${p.store.key}): only bootstrap and base deploy may create it`, EXIT.rules, 'STATE_MISSING');
    }
    Object.assign(ctx.state, newState(p.env.env, p.env.region, 'platform'));
  }
  ctx.state.mode = 'platform';
  ctx.state.delivery = { ...ctx.state.delivery, channel: 'ssm' };
  const envTags = Object.fromEntries(Object.entries(p.env.tags).filter(([k]) => k === 'Project' || k === 'atl:component' || k === 'atl:env-id'));
  ctx.state.platform ??= { envId: p.env.envId, platformTags: envTags, sessionChain: [], pendingHooks: [], seeds: {} };
  ctx.state.platform.envId ||= p.env.envId;
  if (!Object.keys(ctx.state.platform.platformTags).length) ctx.state.platform.platformTags = envTags;
  if (!ctx.state.platform.sessionChain.includes(p.env.sessionId)) ctx.state.platform.sessionChain.push(p.env.sessionId);
  if (p.identity.kind === 'any') ctx.state.platform.anyIdentityUsed = true;
  if (!o.mutating || ctx.dryRun) {
    p.reporter.progress('lock', 'succeeded', ctx.dryRun ? 'dry-run: no lock' : 'read-only command: no lock');
    return;
  }
  p.reporter.progress('lock', 'started', `acquire env#${p.env.env}`);
  p.lock = new EnvLock(ctx.aws, {
    table: p.env.lockTable, envName: p.env.env, holderArn: p.identity.arn, holder: p.identity.sessionName, op: o.op,
    runId: p.env.runId ?? `ws-${p.opId}`, waitSec: o.lockWait ?? (p.identity.kind === 'provisioner' ? 900 : 0),
  });
  await p.lock.acquire();
  p.reporter.progress('lock', 'succeeded', `held by ${p.identity.sessionName}`);
}

/** ctx.save() in platform mode: the write is queued (stages are written in order); a conflict stops later writes */
export function queueSave(ctx: Ctx, p: PlatformRuntime, op: string): void {
  p.lock?.assertHeld();
  if (ctx.dryRun || p.conflict) return;
  const snapshot = JSON.parse(JSON.stringify(ctx.state)) as typeof ctx.state;
  p.pending = p.pending.then(async () => {
    if (p.conflict) return;
    try {
      await p.store.save(snapshot, { writer: p.identity?.sessionName ?? 'unknown', op });
    } catch (e) {
      p.conflict = e instanceof CliError ? e : new CliError(`state.json write failed: ${(e as Error).message}`, EXIT.stateConflict, 'STATE_CONFLICT');
    }
  });
}

export async function flushPlatform(p: PlatformRuntime): Promise<void> {
  await p.pending;
  if (p.conflict) throw p.conflict;
}

/** release the lock and write --result-json */
export async function finishPlatform(p: PlatformRuntime, exitCode: number, error?: CliError): Promise<ModuleResult> {
  const waited = p.lock?.waitedSec ?? 0;
  await p.lock?.release().catch(() => undefined);
  return p.reporter.result(exitCode, {
    stateEtag: p.store.etag,
    lock: { waitedSec: waited, holder: (error?.details?.holder as string | undefined) ?? null },
    ...(error ? { error: { code: error.code ?? 'ERROR', message: error.message, ...(error.details ?? {}) } } : {}),
  });
}

/** module-ops report (start / end of enable, disable, profile apply, seed, tls-preview) */
export async function moduleOp(p: PlatformRuntime | undefined, phase: ModuleOpBody['phase'], o: { command: string; module?: string | null; driver?: string | null; profile?: string | null; exitCode?: number | null }, dryRun = false): Promise<void> {
  if (!p || dryRun) return;
  await reportModuleOp(p.env, {
    opId: p.opId, phase, command: o.command, module: o.module ?? null, driver: o.driver ?? null, profile: o.profile ?? null,
    exitCode: o.exitCode ?? null, at: nowIso(), runId: p.env.runId ?? null,
  });
}
