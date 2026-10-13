/**
 * `PlatformConfig` (read with defaults from 01 §4.3 / §7.3) and `ActiveEnvironmentLock` (02 §3.4, §9.2).
 */
import { INSTALL_DEFAULTS, Keys } from '@atl/shared';
import type { Ctx } from '../context.js';
import { Expr, type TransactItem } from './ddb.js';
import type { LockRecord, PlatformConfigView } from './model.js';

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Rescan offsets (02 §7.7: +20 min, +60 min, +6 h from revokedAt). */
export const DEFAULT_RESCAN_OFFSETS_MINUTES = [20, 60, 360] as const;

export function configView(raw: Record<string, unknown> | null, region: string): PlatformConfigView {
  const r = raw ?? {};
  const limits = obj(r.limits);
  const ext = obj(limits.extension);
  const budget = obj(r.budget);
  const reclaim = obj(r.reclaim);
  const ownership = obj(r.ownership);
  const offsets = Array.isArray(reclaim.rescanOffsetsMinutes) ? (reclaim.rescanOffsetsMinutes as number[]).filter((n) => Number.isFinite(n) && n >= 0) : null;
  const hard = Math.max(45, num(ownership.hardMaxWaitMinutes, 45));
  return {
    version: typeof r.version === 'string' ? r.version : '0.0.0',
    region: typeof r.region === 'string' ? r.region : region,
    drRegion: typeof r.drRegion === 'string' && r.drRegion ? r.drRegion : null,
    platformUrl: typeof r.platformUrl === 'string' ? r.platformUrl : 'https://platform.invalid',
    agentApiEndpoint: typeof r.agentApiEndpoint === 'string' ? r.agentApiEndpoint : 'https://agent.invalid',
    workloadBoundaryArn: typeof r.workloadBoundaryArn === 'string' ? r.workloadBoundaryArn : 'arn:aws:iam::000000000000:policy/ATLWorkloadBoundary',
    maintenance: r.maintenance === true,
    mode: r.mode === 'UNINSTALLING' ? 'UNINSTALLING' : 'NORMAL',
    limits: {
      maxSessionMinutes: Math.min(480, num(limits.maxSessionMinutes, INSTALL_DEFAULTS.MaxSessionMinutes)),
      extension: { minutes: num(ext.minutes, INSTALL_DEFAULTS.ExtensionMinutes), maxCount: num(ext.maxCount, INSTALL_DEFAULTS.MaxExtensions) },
      maxKeepHours: num(limits.maxKeepHours, INSTALL_DEFAULTS.MaxKeepHours),
      keepHardMaxHours: num(limits.keepHardMaxHours, INSTALL_DEFAULTS.KeepHardMaxHours),
      envMaxAgeDays: num(limits.envMaxAgeDays, INSTALL_DEFAULTS.EnvMaxAgeDays),
      readyIdleMinutes: num(limits.readyIdleMinutes, INSTALL_DEFAULTS.ReadyIdleMinutes),
      asgMaxSizeLimit: num(limits.asgMaxSizeLimit, INSTALL_DEFAULTS.AsgMaxSizeLimit),
    },
    budget: {
      amount: typeof budget.amount === 'number' ? budget.amount : null,
      enforcement: budget.enforcement === 'notify' || budget.enforcement === 'end-active' ? budget.enforcement : 'block-start',
      state: budget.state === 'WARN' || budget.state === 'EXCEEDED' ? budget.state : 'OK',
      stateAt: typeof budget.stateAt === 'string' ? budget.stateAt : null,
    },
    reclaim: {
      rescanOffsetsMinutes: offsets && offsets.length ? offsets : [...DEFAULT_RESCAN_OFFSETS_MINUTES],
      blockStartOnResidual: reclaim.blockStartOnResidual === 'block' || reclaim.blockStartOnResidual === 'ignore' ? reclaim.blockStartOnResidual : 'ack',
    },
    ownership: { maxWaitMinutes: Math.min(hard, num(ownership.maxWaitMinutes, 20)), hardMaxWaitMinutes: hard },
    outage: { maxMinutes: num(obj(r.outage).maxMinutes, 30) },
    uninstall: r.uninstall && typeof r.uninstall === 'object' ? (r.uninstall as Record<string, unknown>) : null,
    raw: r,
  };
}

export async function getConfig(ctx: Ctx): Promise<PlatformConfigView> {
  return configView(await ctx.main.get(Keys.platformConfig()), ctx.env.region);
}

/** Attribute-level update of PlatformConfig (creates the item when the dev table has none). */
export async function updateConfig(ctx: Ctx, set: Record<string, unknown>): Promise<void> {
  const now = ctx.nowIso();
  const existing = await ctx.main.get(Keys.platformConfig());
  if (!existing) {
    await ctx.main.putIfAbsent({ ...Keys.platformConfig(), type: 'PlatformConfig', ver: 1, createdAt: now, updatedAt: now, region: ctx.env.region });
  }
  const e = new Expr();
  const fields = { ...set, updatedAt: now };
  const expr = `SET ${Object.entries(fields)
    .map(([k, v]) => `${e.name(k)} = ${e.value(v)}`)
    .join(', ')}, ${e.name('ver')} = if_not_exists(${e.name('ver')}, ${e.value(0)}) + ${e.value(1)}`;
  await ctx.main.updateRaw(Keys.platformConfig(), expr, null, e);
}

// ---------------------------------------------------------------------------------------------------------------
// ActiveEnvironmentLock

export async function getLock(ctx: Ctx): Promise<LockRecord> {
  const l = await ctx.main.get<LockRecord>(Keys.activeEnvironmentLock());
  return l ?? { ...Keys.activeEnvironmentLock(), type: 'ActiveEnvironmentLock', ver: 0 };
}

export function lockIsFree(l: LockRecord): boolean {
  return !l.holderEnvId;
}

/** A reservation (02 §3.4) only counts while `pendingUntil` is in the future. */
export function liveReservation(l: LockRecord, nowMs: number): string | null {
  return l.pendingSessionId && l.pendingUntil && Date.parse(l.pendingUntil) > nowMs ? l.pendingSessionId : null;
}

/** Put the whole lock item conditioned on the version that was read (missing item: ver 0). */
export function lockWrite(ctx: Ctx, read: LockRecord, next: Partial<LockRecord>): TransactItem {
  const now = ctx.nowIso();
  const e = new Expr();
  const item: LockRecord = {
    ...Keys.activeEnvironmentLock(),
    type: 'ActiveEnvironmentLock',
    holderEnvId: null,
    holderSessionId: null,
    acquiredAt: null,
    pendingSessionId: null,
    pendingUntil: null,
    ...stripKeys(read),
    ...next,
    ver: read.ver + 1,
    createdAt: read.createdAt ?? now,
    updatedAt: now,
  };
  const cond = read.ver === 0 ? `attribute_not_exists(${e.name('PK')})` : `${e.name('ver')} = ${e.value(read.ver)}`;
  return { Put: { TableName: ctx.main.name, Item: item, ConditionExpression: cond, ...e.input() } };
}

function stripKeys(l: LockRecord): Partial<LockRecord> {
  const { PK: _pk, SK: _sk, ver: _v, ...rest } = l;
  return rest;
}

/** Release the lock when `envId` (or, if null, `sid`) is the holder; no-op otherwise. Returns the transact item or null. */
export function lockReleaseIfHolder(ctx: Ctx, read: LockRecord, q: { envId?: string | null; sid?: string | null }): TransactItem | null {
  const holds = (q.envId && read.holderEnvId === q.envId) || (!q.envId && q.sid && read.holderSessionId === q.sid);
  if (!holds) return null;
  return lockWrite(ctx, read, { holderEnvId: null, holderSessionId: null, acquiredAt: null });
}
