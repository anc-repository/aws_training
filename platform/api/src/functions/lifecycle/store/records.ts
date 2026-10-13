/**
 * Smaller records the lifecycle reads or writes: RunnerRun (classification), CredentialGrant (ws grant, revocation),
 * CostQuote (read), catalog pointer, and the GSI2 state queries of the sweeper / uninstall (AP12).
 */
import { Keys, newUlid, RoleSessionNames, SkPrefix, SWEEP_GSI2_PARTITIONS, type SessionState } from '@atl/shared';
import type { Ctx } from '../context.js';
import type { Item } from './ddb.js';
import type { SessionRecord } from './model.js';

// ---------------------------------------------------------------------------------------------------------------
// RunnerRun (SESSION#<sid> / BUILD#<runId>)

export interface RunnerRunRecord extends Item {
  runId: string;
  op?: string;
  attempt?: number;
  buildId?: string;
  status?: string;
  exitCode?: number | null;
  classification?: { retryable: boolean; code: string | null; hint: string | null } | null;
  resultKey?: string;
}

export async function getRunnerRun(ctx: Ctx, sid: string, runId: string): Promise<RunnerRunRecord | null> {
  return ctx.main.get<RunnerRunRecord>(Keys.runnerRun(sid, runId));
}

export async function listRunnerRuns(ctx: Ctx, sid: string): Promise<RunnerRunRecord[]> {
  return ctx.main.query<RunnerRunRecord>({ pk: { attr: 'PK', value: Keys.labSession(sid).PK }, sk: { attr: 'SK', beginsWith: SkPrefix.runnerRun } });
}

/** Attribute-level upsert (atl-agent writes progress on the same item through the internal route). */
export async function recordRunnerRun(ctx: Ctx, sid: string, runId: string, fields: Record<string, unknown>): Promise<void> {
  const now = ctx.nowIso();
  const existing = await getRunnerRun(ctx, sid, runId);
  if (!existing) {
    await ctx.main.putIfAbsent({ ...Keys.runnerRun(sid, runId), type: 'RunnerRun', ver: 1, createdAt: now, updatedAt: now, runId, sessionId: sid });
  }
  await ctx.main.update(Keys.runnerRun(sid, runId), { ...fields, updatedAt: now });
}

// ---------------------------------------------------------------------------------------------------------------
// CredentialGrant (SESSION#<sid> / CRED#<channel>#<ulid>)

export interface CredentialGrantRecord extends Item {
  sessionId: string;
  roleSessionName: string;
  channel: string;
  issuedAt: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export async function listGrants(ctx: Ctx, sid: string): Promise<CredentialGrantRecord[]> {
  return ctx.main.query<CredentialGrantRecord>({ pk: { attr: 'PK', value: Keys.labSession(sid).PK }, sk: { attr: 'SK', beginsWith: SkPrefix.credential } });
}

/** The workstation grant registered by WireWorkstation (02 §7.3 I1; `expiresAt` is filled in at revocation). */
export async function putWorkstationGrant(ctx: Ctx, sid: string): Promise<void> {
  const existing = (await listGrants(ctx, sid)).find((g) => g.channel === 'ws');
  if (existing) return;
  const now = ctx.nowIso();
  const ulid = newUlid(ctx.nowMs());
  await ctx.main.put({
    ...Keys.credentialGrant(sid, 'ws', ulid),
    type: 'CredentialGrant',
    ver: 1,
    createdAt: now,
    updatedAt: now,
    sessionId: sid,
    roleSessionName: RoleSessionNames.ws(sid),
    channel: 'ws',
    issuedAt: now,
    expiresAt: null,
    revokedAt: null,
  });
}

/**
 * Mark every grant revoked. The workstation channel refreshes its chained role credentials for up to 1 hour, so its
 * `expiresAt` becomes `revokedAt + 1 h` (02 §5.1); console / terminal grants keep the expiry set by their issuer.
 */
export async function revokeGrants(ctx: Ctx, sid: string, revokedAt: string): Promise<CredentialGrantRecord[]> {
  const grants = await listGrants(ctx, sid);
  for (const g of grants) {
    if (g.revokedAt) continue;
    const set: Record<string, unknown> = { revokedAt, updatedAt: ctx.nowIso() };
    if (g.channel === 'ws' || !g.expiresAt) set.expiresAt = new Date(Date.parse(revokedAt) + 3_600_000).toISOString();
    await ctx.main.update({ PK: String(g.PK), SK: String(g.SK) }, set);
  }
  return grants;
}

/** max(CredentialGrant.expiresAt) of the session (revocation entry clean-up, 02 §6.3). */
export function lastCredentialExpiry(grants: CredentialGrantRecord[], revokedAt: string | null | undefined): number {
  let max = revokedAt ? Date.parse(revokedAt) + 3_600_000 : 0;
  for (const g of grants) {
    const t = g.expiresAt ? Date.parse(g.expiresAt) : g.issuedAt ? Date.parse(g.issuedAt) + 3_600_000 : 0;
    if (Number.isFinite(t)) max = Math.max(max, t);
  }
  return max;
}

// ---------------------------------------------------------------------------------------------------------------
// CostQuote (USER#<sub> / QUOTE#<quoteId>) — written by atl-pricing / atl-api

export interface CostQuoteRecord extends Item {
  quoteId: string;
  purpose: string;
  labId?: string;
  labVersion?: string;
  variant?: string;
  region?: string;
  priceAsOf?: string | null;
  startProfileDigest?: string | null;
  catalogVersion?: string | null;
  durationMinutes?: number;
  maxTotalMinutes?: number;
  expiresAt: string;
  reuseEnvironmentId?: string | null;
  sessionId?: string | null;
  keepHours?: number | null;
  minutes?: number | null;
}

export async function getQuote(ctx: Ctx, sub: string, quoteId: string): Promise<CostQuoteRecord | null> {
  return ctx.main.get<CostQuoteRecord>(Keys.costQuote(sub, quoteId));
}

// ---------------------------------------------------------------------------------------------------------------
// GSI2 state queries (AP12)

export async function sessionsInState(ctx: Ctx, state: SessionState): Promise<SessionRecord[]> {
  const rows = await ctx.main.query<Item>({ index: 'GSI2', pk: { attr: 'GSI2PK', value: `STATE#${state}` } });
  return loadSessions(ctx, rows);
}

export async function sessionsInFollowUp(ctx: Ctx): Promise<SessionRecord[]> {
  const rows = await ctx.main.query<Item>({ index: 'GSI2', pk: { attr: 'GSI2PK', value: 'FOLLOWUP#PENDING' } });
  return loadSessions(ctx, rows);
}

/** All sessions of the 10 sweep partitions (9 non-terminal states + FOLLOWUP#PENDING). */
export async function sweepSessions(ctx: Ctx): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  const seen = new Set<string>();
  for (const pk of SWEEP_GSI2_PARTITIONS) {
    const rows = await ctx.main.query<Item>({ index: 'GSI2', pk: { attr: 'GSI2PK', value: pk } });
    for (const s of await loadSessions(ctx, rows)) {
      if (!seen.has(s.sid)) {
        seen.add(s.sid);
        out.push(s);
      }
    }
  }
  return out;
}

/** GSI2 projects only a few attributes: read the full items (strongly consistent). */
async function loadSessions(ctx: Ctx, rows: Item[]): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  for (const r of rows) {
    if (r.SK !== 'META' || !String(r.PK).startsWith('SESSION#')) continue;
    const s = await ctx.main.get<SessionRecord>({ PK: String(r.PK), SK: 'META' });
    if (s) out.push(s);
  }
  return out;
}
