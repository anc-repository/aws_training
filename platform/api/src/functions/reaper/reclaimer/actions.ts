/**
 * Deletion (02 §7.2, §7.4–§7.8): BuildDeletionPlan (derived resources, eligibility, stages), DeleteItem / PollItem
 * (per-item deadline and attempt cap → MANUAL), MarkManual, Verify (existence, final tag scan, stacks gone, severity
 * summary), ResolveItem (“我已处理”), PurgeEnvState (state prefix and lock item after the rescan window, 9.5).
 */
import { envLockKey, Keys, RoleSessionNames, type ReclaimPassMode } from '@atl/shared';
import type { Ctx } from '../../lifecycle/context.js';
import { MINUTE } from '../../lifecycle/context.js';
import type { DeleteContext, ResourceRef, StepResult } from '../../lifecycle/cloud/port.js';
import { emit } from '../../lifecycle/store/events.js';
import type { SessionResourceRecord } from '../../lifecycle/store/model.js';
import { getLock } from '../../lifecycle/store/platform.js';
import { getSession } from '../../lifecycle/store/sessions.js';
import { chainSessions, mustEnv } from './discovery.js';
import { deriveFrom } from './derived.js';
import { getResource, keyOf, listResources, mutateResource, upsertResource } from './ledger.js';
import { eligibility, EVIDENCE_SOURCES, isKnownType, ruleFor, STAGES } from './rules.js';
import { refFromArn } from './arn.js';

export const MAX_ATTEMPTS = 12;
export const PLAN_CHILD_THRESHOLD = 300;

const DONE_STATES = ['DELETED', 'RETAINED', 'RESOLVED_BY_LEARNER'];

function hasEvidence(r: SessionResourceRecord): boolean {
  const sources = r.sources ?? [r.discoveredBy];
  return sources.some((x) => (EVIDENCE_SOURCES as readonly string[]).includes(x) && (x !== 'CLOUDTRAIL' || !!r.eventId));
}

// ---------------------------------------------------------------------------------------------------------------
// BuildDeletionPlan

export async function buildDeletionPlan(ctx: Ctx, p: { envId: string; sessionId: string; passNo: number; mode: ReclaimPassMode }) {
  const env = await mustEnv(ctx, p.envId);
  const chain = await chainSessions(ctx, env);
  const keepPrerequisites = [...new Set(chain.flatMap((s) => s.keepPrerequisites ?? []))];
  // derived resources of the known ones (7.4)
  for (const r of await listResources(ctx, p.envId)) {
    if (r.cleanupState === 'REVIEW' || !hasEvidence(r)) continue;
    for (const d of deriveFrom(r)) {
      await upsertResource(ctx, p.envId, { ...d, sessionId: r.sessionId, source: 'DERIVED', createdBy: 'service', passNo: p.passNo, meta: { derivedFrom: r.resourceKey } });
    }
  }
  // a retry (T19) tries the manual items again from scratch (the learner may have lifted the blocker)
  if (p.mode === 'RETRY' || p.mode === 'UNINSTALL') {
    for (const r of await listResources(ctx, p.envId)) {
      if (r.cleanupState === 'MANUAL_REQUIRED' && !r.resourceType.startsWith('ATL::')) {
        await mutateResource(ctx, p.envId, r.resourceKey, () => ({ cleanupState: 'TRACKED', severity: null, attempts: 0, firstAttemptAt: null, deadlineAt: null, pendingSince: null }));
      }
    }
  }
  const items = await listResources(ctx, p.envId);
  const stages = new Map<string, string[]>();
  for (const r of items) {
    if (DONE_STATES.includes(r.cleanupState) || r.cleanupState === 'MANUAL_REQUIRED') continue;
    if (r.cleanupState === 'REVIEW') continue;
    if (!hasEvidence(r)) {
      await mutateResource(ctx, p.envId, r.resourceKey, () => ({ cleanupState: 'REVIEW', severity: 'REVIEW', lastError: 'no creation evidence (7.2 rule 1)' }));
      continue;
    }
    if (!isKnownType(r.resourceType) && !(r.sources ?? []).some((x) => x === 'STACK' || x === 'RETAINED')) {
      await mutateResource(ctx, p.envId, r.resourceKey, () => ({ cleanupState: 'REVIEW', severity: 'REVIEW', lastError: `no reclaim handler for ${r.resourceType}` }));
      continue;
    }
    const el = r.resourceType.startsWith('ATL::') ? ({ delete: true } as const) : eligibility({
      type: r.resourceType,
      id: r.id,
      name: r.name,
      arn: r.arn,
      stackName: r.stackName ?? null,
      tags: (r.meta?.tags as Record<string, string> | undefined) ?? null,
      chain: env.sessionChain,
      keepPrerequisites,
      isDefaultVpcResource: r.meta?.isDefault === true,
    });
    if (!el.delete) {
      await mutateResource(ctx, p.envId, r.resourceKey, () => ({ cleanupState: el.state, severity: el.severity, lastError: el.reason }));
      continue;
    }
    const stage = ruleFor(r.resourceType).stage;
    stages.set(stage, [...(stages.get(stage) ?? []), r.resourceKey]);
  }
  const planned = STAGES.filter((s) => stages.has(s)).map((stage) => ({ stage, resourceKeys: stages.get(stage)! }));
  const total = planned.reduce((a, s) => a + s.resourceKeys.length, 0);
  if (total > PLAN_CHILD_THRESHOLD) console.warn(JSON.stringify({ msg: 'reclaim plan above the inline Map threshold (02 §7.11)', envId: p.envId, total }));
  return { stages: planned, total };
}

// ---------------------------------------------------------------------------------------------------------------
// DeleteItem / PollItem / MarkManual

export interface DeleteItemInput {
  resourceKey: string;
  envId: string;
  sessionId: string;
  passNo: number;
  stage?: string;
}

async function deleteContext(ctx: Ctx, r: SessionResourceRecord, it: DeleteItemInput): Promise<DeleteContext> {
  const lock = await getLock(ctx);
  return {
    sessionId: it.sessionId,
    roleSessionName: RoleSessionNames.reap(it.sessionId, Math.max(1, it.passNo)),
    attempt: r.attempts,
    ownsSharedObjects: !lock.holderEnvId || lock.holderEnvId === it.envId,
    policyArns: (r.meta?.policyArns as string[] | undefined) ?? [],
    meta: r.meta ?? {},
  };
}

function refOf(r: SessionResourceRecord): ResourceRef {
  return { type: r.resourceType, region: r.region, id: r.id, arn: r.arn };
}

async function applyResult(ctx: Ctx, it: DeleteItemInput, r: SessionResourceRecord, res: StepResult) {
  const cloud = ctx.clouds().reclaim;
  const now = ctx.nowMs();
  const rule = ruleFor(r.resourceType);
  let status: 'DONE' | 'PENDING' | 'RETRY' | 'MANUAL' = res.status;
  let waitSeconds = 'waitSeconds' in res ? res.waitSeconds : 0;
  let patch: Partial<SessionResourceRecord>;
  if (res.status === 'DONE') {
    patch = { cleanupState: 'DELETED', severity: null, lastError: null, deadlineAt: null };
  } else if (res.status === 'MANUAL') {
    patch =
      res.severity === 'INFO'
        ? { cleanupState: 'RETAINED', severity: 'INFO', lastError: res.reason }
        : { cleanupState: res.severity === 'REVIEW' ? 'REVIEW' : 'MANUAL_REQUIRED', severity: res.severity, lastError: res.reason, manualHint: cloud.manualHint(refOf(r)) };
    waitSeconds = 0;
  } else {
    const first = r.firstAttemptAt ? Date.parse(r.firstAttemptAt) : now;
    const deadline = first + rule.deadlineMinutes * MINUTE;
    if (now >= deadline || r.attempts >= MAX_ATTEMPTS) {
      status = 'MANUAL';
      waitSeconds = 0;
      const why = now >= deadline ? `not deleted within its ${rule.deadlineMinutes}-minute deadline` : `gave up after ${r.attempts} attempts`;
      patch = { cleanupState: 'MANUAL_REQUIRED', severity: 'BLOCKING', lastError: `${why}${'reason' in res ? `: ${res.reason}` : ''}`, manualHint: cloud.manualHint(refOf(r)) };
    } else {
      waitSeconds = Math.max(1, Math.min(waitSeconds, Math.ceil((deadline - now) / 1000)));
      patch = { cleanupState: 'DELETING', lastError: 'reason' in res ? res.reason : null, deadlineAt: new Date(deadline).toISOString(), pendingSince: r.pendingSince ?? new Date(now).toISOString() };
    }
  }
  const updated = await mutateResource(ctx, it.envId, it.resourceKey, () => patch);
  if (status === 'DONE') {
    await emit(ctx, it.sessionId, [{ type: 'reclaim.item_deleted', data: { resourceKey: r.resourceKey, type: r.resourceType, severity: null, reason: null }, envId: it.envId }]);
  } else if (status === 'MANUAL' && updated?.cleanupState !== 'RETAINED') {
    await emit(ctx, it.sessionId, [{ type: 'reclaim.item_manual', data: { resourceKey: r.resourceKey, type: r.resourceType, severity: updated?.severity ?? 'BLOCKING', reason: updated?.lastError ?? null }, envId: it.envId }]);
  }
  return { resourceKey: it.resourceKey, status: status === 'RETRY' ? 'RETRY' : status, waitSeconds };
}

export async function deleteItem(ctx: Ctx, p: { item: DeleteItemInput }) {
  const it = p.item;
  const r0 = await getResource(ctx, it.envId, it.resourceKey);
  if (!r0 || DONE_STATES.includes(r0.cleanupState)) return { resourceKey: it.resourceKey, status: 'DONE', waitSeconds: 0 };
  if (r0.cleanupState === 'MANUAL_REQUIRED' || r0.cleanupState === 'REVIEW') return { resourceKey: it.resourceKey, status: 'MANUAL', waitSeconds: 0 };
  const now = ctx.nowIso();
  const r = (await mutateResource(ctx, it.envId, it.resourceKey, (cur) => ({ attempts: cur.attempts + 1, firstAttemptAt: cur.firstAttemptAt ?? now, lastTriedAt: now, passNo: it.passNo })))!;
  const cloud = ctx.clouds().reclaim;
  const ref = refOf(r);
  const dctx = await deleteContext(ctx, r, it);
  // a resource of a stack that is still being deleted waits for the stack (S0 deletes stacks first)
  if (r.stackName && r.resourceType !== 'AWS::CloudFormation::Stack') {
    const stack = keyOf(r.region, 'AWS::CloudFormation::Stack', r.stackName, null);
    const st = await getResource(ctx, it.envId, stack);
    if (st && st.cleanupState === 'DELETING') return applyResult(ctx, it, r, { status: 'RETRY', waitSeconds: 30, reason: `waiting for stack ${r.stackName}` });
  }
  let res: StepResult;
  try {
    if (!r.resourceType.startsWith('ATL::') && !(await cloud.exists(ref))) res = { status: 'DONE' };
    else res = await cloud.delete(ref, dctx);
  } catch (e) {
    res = classifyThrown(e);
  }
  return applyResult(ctx, it, r, res);
}

export async function pollItem(ctx: Ctx, p: { item: DeleteItemInput }) {
  const it = p.item;
  const r = await getResource(ctx, it.envId, it.resourceKey);
  if (!r || DONE_STATES.includes(r.cleanupState)) return { resourceKey: it.resourceKey, status: 'DONE', waitSeconds: 0 };
  if (r.cleanupState === 'MANUAL_REQUIRED' || r.cleanupState === 'REVIEW') return { resourceKey: it.resourceKey, status: 'MANUAL', waitSeconds: 0 };
  let res: StepResult;
  try {
    res = await ctx.clouds().reclaim.poll(refOf(r), await deleteContext(ctx, r, it));
  } catch (e) {
    res = classifyThrown(e);
  }
  return applyResult(ctx, it, r, res);
}

/** Port errors: NotFound → done, AccessDenied → MANUAL / BLOCKING (7.6), throttling → retry with backoff. */
function classifyThrown(e: unknown): StepResult {
  const code = (e as { code?: string }).code;
  const msg = e instanceof Error ? e.message : String(e);
  if (code === 'NotFound') return { status: 'DONE' };
  if (code === 'AccessDenied') return { status: 'MANUAL', severity: 'BLOCKING', reason: `access denied: ${msg} (the provisioner policy of 01 may need this permission)` };
  if (code === 'Throttled' || code === 'Unavailable') return { status: 'RETRY', waitSeconds: 20, reason: msg };
  return { status: 'RETRY', waitSeconds: 30, reason: msg };
}

export async function markManual(ctx: Ctx, p: { item: DeleteItemInput; error?: { Error?: string; Cause?: string } | null }) {
  const it = p.item;
  const r = await getResource(ctx, it.envId, it.resourceKey);
  if (!r || DONE_STATES.includes(r.cleanupState)) return {};
  await mutateResource(ctx, it.envId, it.resourceKey, () => ({
    cleanupState: 'MANUAL_REQUIRED',
    severity: 'BLOCKING',
    lastError: `reclaim handler failed: ${p.error?.Error ?? 'error'} ${p.error?.Cause ?? ''}`.trim().slice(0, 1000),
    manualHint: ctx.clouds().reclaim.manualHint(refOf(r)),
  }));
  await emit(ctx, it.sessionId, [{ type: 'reclaim.item_manual', data: { resourceKey: r.resourceKey, type: r.resourceType, severity: 'BLOCKING', reason: p.error?.Error ?? 'error' }, envId: it.envId }]);
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// Verify (7.8)

export interface PassSummary {
  passNo: number;
  mode: ReclaimPassMode;
  found: number;
  deleted: number;
  manual: number;
  blocking: number;
  review: number;
  info: number;
  hourlyBlocking: number;
  pending: number;
}

export async function verify(ctx: Ctx, p: { envId: string; sessionId: string; mode: ReclaimPassMode; passNo: number }) {
  const env = await mustEnv(ctx, p.envId);
  const cloud = ctx.clouds().reclaim;
  // 1. exists() for everything not finished
  for (const r of await listResources(ctx, p.envId)) {
    if (DONE_STATES.includes(r.cleanupState) || r.cleanupState === 'REVIEW' || r.cleanupState === 'MANUAL_REQUIRED') continue;
    if (r.resourceType.startsWith('ATL::')) {
      if (r.cleanupState === 'TRACKED' && r.resourceType === 'ATL::IAM::AppRoleReset') continue; // not planned this pass
      continue;
    }
    let exists = true;
    try {
      exists = await cloud.exists({ type: r.resourceType, region: r.region, id: r.id, arn: r.arn });
    } catch {
      exists = true;
    }
    if (!exists) {
      await mutateResource(ctx, p.envId, r.resourceKey, () => ({ cleanupState: 'DELETED', severity: null }));
    } else if (r.cleanupState === 'DELETING' || (r.attempts ?? 0) > 0) {
      await mutateResource(ctx, p.envId, r.resourceKey, () => ({
        cleanupState: 'MANUAL_REQUIRED',
        severity: 'BLOCKING',
        lastError: r.lastError ?? 'confirmed to exist and not deleted',
        manualHint: cloud.manualHint({ type: r.resourceType, region: r.region, id: r.id, arn: r.arn }),
      }));
    }
  }
  // 2. final tag scan: new tagged resources without evidence are REVIEW (7.8); tag-only items that are gone are closed
  const stillTagged = new Set<string>();
  let tagScanComplete = true;
  for (const region of env.scanRegions?.length ? env.scanRegions : [env.region]) {
    try {
      for (const f of await cloud.taggedResources({ region, key: 'atl:env-id', value: env.envId })) {
        stillTagged.add(f.arn);
        const ref = refFromArn(f.arn, region);
        await upsertResource(ctx, p.envId, {
          type: ref?.type ?? f.type ?? 'ATL::Tagged::unknown',
          id: ref?.id ?? f.arn,
          region: ref?.region ?? region,
          arn: f.arn,
          sessionId: env.ownerSessionId,
          source: 'TAG',
          cleanupState: 'REVIEW',
          severity: 'REVIEW',
          lastError: 'still tagged with atl:env-id after the reclaim pass',
          passNo: p.passNo,
        });
      }
    } catch {
      tagScanComplete = false; // tag scan failure: the rescans repeat it
    }
  }
  if (tagScanComplete) {
    for (const r of await listResources(ctx, p.envId)) {
      const tagOnly = (r.sources ?? []).every((x) => x === 'TAG');
      if (r.cleanupState === 'REVIEW' && tagOnly && r.arn && !stillTagged.has(r.arn)) {
        await mutateResource(ctx, p.envId, r.resourceKey, () => ({ cleanupState: 'DELETED', severity: null, lastError: 'no longer present (deleted with its stack or by the learner)' }));
      }
    }
  }
  // 3. a complete retry pass (no scan gaps) settles the “environment state unknown” item of a workflow error
  if (p.mode === 'RETRY') {
    const pass = await ctx.main.get(Keys.reclaimPass(p.envId, p.passNo));
    if (((pass?.gaps as string[] | undefined) ?? []).length === 0) {
      for (const r of await listResources(ctx, p.envId)) {
        if (r.resourceType === 'ATL::Environment::Unknown' && r.cleanupState === 'MANUAL_REQUIRED') {
          await mutateResource(ctx, p.envId, r.resourceKey, () => ({ cleanupState: 'DELETED', severity: null, lastError: 'settled by a complete retry pass' }));
        }
      }
    }
  }
  // 4. summary
  const all = await listResources(ctx, p.envId);
  const thisPass = all.filter((r) => r.passNo === p.passNo);
  const blockingItems = all.filter((r) => r.cleanupState === 'MANUAL_REQUIRED' && r.severity === 'BLOCKING');
  const summary: PassSummary = {
    passNo: p.passNo,
    mode: p.mode,
    found: thisPass.length,
    deleted: thisPass.filter((r) => r.cleanupState === 'DELETED').length,
    manual: all.filter((r) => r.cleanupState === 'MANUAL_REQUIRED').length,
    blocking: blockingItems.length,
    review: all.filter((r) => r.cleanupState === 'REVIEW').length,
    info: all.filter((r) => r.cleanupState === 'RETAINED').length,
    hourlyBlocking: blockingItems.filter((r) => r.billing === 'hourly').length,
    pending: all.filter((r) => r.cleanupState === 'DELETING').length,
  };
  const passKey = Keys.reclaimPass(p.envId, p.passNo);
  if (await ctx.main.get(passKey)) {
    await ctx.main.update(passKey, { finishedAt: ctx.nowIso(), found: summary.found, deleted: summary.deleted, manual: summary.manual, summary, updatedAt: ctx.nowIso() });
  }
  await emit(ctx, p.sessionId, [{ type: 'reclaim.pass_completed', data: { ...summary, envId: p.envId }, envId: p.envId }]);
  return { summary };
}

// ---------------------------------------------------------------------------------------------------------------
// ResolveItem (POST /sessions/{sid}/cleanup/items/{resourceKey}/resolve) and PurgeEnvState

export async function resolveItem(ctx: Ctx, p: { envId: string; resourceKey: string; sessionId?: string }) {
  const r = await getResource(ctx, p.envId, p.resourceKey);
  if (!r) return { resolved: false, remainingBlocking: await countBlocking(ctx, p.envId), reason: 'unknown resource' };
  let resolved = DONE_STATES.includes(r.cleanupState);
  if (!resolved) {
    const exists = r.resourceType.startsWith('ATL::') ? false : await ctx.clouds().reclaim.exists({ type: r.resourceType, region: r.region, id: r.id, arn: r.arn }).catch(() => true);
    if (!exists) {
      await mutateResource(ctx, p.envId, p.resourceKey, () => ({ cleanupState: 'RESOLVED_BY_LEARNER', severity: null, lastError: null }));
      resolved = true;
    }
  }
  return { resolved, remainingBlocking: await countBlocking(ctx, p.envId) };
}

async function countBlocking(ctx: Ctx, envId: string): Promise<number> {
  return (await listResources(ctx, envId)).filter((r) => r.cleanupState === 'MANUAL_REQUIRED' && r.severity === 'BLOCKING').length;
}

/** 9.5: after the rescan window (and not CLEANUP_FAILED) the `<envName>/` prefix and the lock item go away. */
export async function purgeEnvState(ctx: Ctx, p: { envId: string; sessionId: string }) {
  const env = await mustEnv(ctx, p.envId);
  const s = await getSession(ctx, p.sessionId);
  if (s?.state === 'CLEANUP_FAILED') return { purged: 0, skipped: 'CLEANUP_FAILED' };
  const keys = await ctx.ports.objects.list(ctx.env.buckets.labState, `${env.envName}/`).catch(() => []);
  for (const k of keys) await ctx.ports.objects.delete(ctx.env.buckets.labState, k);
  await ctx.locks.delete({ lockKey: envLockKey(env.envName) }).catch(() => undefined);
  await ctx.main.update(Keys.environment(env.envId), { statePurgedAt: ctx.nowIso(), updatedAt: ctx.nowIso() });
  return { purged: keys.length };
}
