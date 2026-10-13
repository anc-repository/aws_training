/**
 * The reclaim ledger `SessionResource` (01 §7.2: `ENV#<envId>` / `RES#<resourceKey>`, GSI1 `SESRES#<sid>`, sparse
 * GSI2 `RES#<cleanupState>` for MANUAL_REQUIRED / REVIEW / FAILED). One item per resource whatever the number of
 * sources (7.2 rule “多个来源发现同一资源只记一条”); the key is `resourceKey(region, type:id)` (or the ARN when no id).
 */
import { Gsi1, Gsi2, Keys, SkPrefix, type CleanupState, type DiscoveredBy, type ResourceCreatedBy, type ResourceSeverity } from '@atl/shared';
import { resourceKey } from '@atl/shared/node';
import type { Ctx } from '../../lifecycle/context.js';
import { diffItems, Expr, isConditionFailed, updateExpression } from '../../lifecycle/store/ddb.js';
import { buildEvent, publish } from '../../lifecycle/store/events.js';
import type { SessionResourceRecord } from '../../lifecycle/store/model.js';
import { ruleFor } from './rules.js';

export interface ResourceInput {
  type: string;
  id: string;
  region: string;
  arn?: string | null;
  name?: string | null;
  sessionId: string;
  source: DiscoveredBy;
  createdBy?: ResourceCreatedBy;
  creatorSessionName?: string | null;
  eventId?: string | null;
  eventTime?: string | null;
  stackName?: string | null;
  logicalId?: string | null;
  retained?: boolean;
  /** initial state for new items (TAG / INVENTORY → REVIEW) */
  cleanupState?: CleanupState;
  severity?: ResourceSeverity | null;
  lastError?: string | null;
  meta?: Record<string, unknown>;
  passNo?: number;
  /**
   * Weak sighting (an overwrite-style write such as PutMetricAlarm, ExtractedRef.overwrite): adds the source but is no
   * creation evidence — it never turns a REVIEW item into TRACKED and never records an `eventId` (02 §7.2 rule 1).
   */
  weak?: boolean;
}

/** Reason shown in the manual list for a weak (overwrite-only) sighting. */
export const POSSIBLY_PREEXISTING = '可能是会话前已存在的资源';

export function keyOf(region: string, type: string, id: string | null | undefined, arn?: string | null): string {
  return id ? resourceKey(region, { resourceType: type, id }) : resourceKey(region, { arn: arn ?? '' });
}

export async function getResource(ctx: Ctx, envId: string, key: string): Promise<SessionResourceRecord | null> {
  return ctx.main.get<SessionResourceRecord>(Keys.sessionResource(envId, key));
}

export async function listResources(ctx: Ctx, envId: string): Promise<SessionResourceRecord[]> {
  return ctx.main.query<SessionResourceRecord>({ pk: { attr: 'PK', value: Keys.environment(envId).PK }, sk: { attr: 'SK', beginsWith: SkPrefix.resource } });
}

function withIndexes(r: SessionResourceRecord): SessionResourceRecord {
  const next = { ...r, ...Gsi1.sessionResource(r.sessionId, r.createdAt, r.resourceKey) } as SessionResourceRecord & { GSI2PK?: string; GSI2SK?: string };
  const g = Gsi2.sessionResource(r.cleanupState, r.envId, r.resourceKey);
  if (g) {
    next.GSI2PK = g.GSI2PK;
    next.GSI2SK = g.GSI2SK;
  } else {
    delete next.GSI2PK;
    delete next.GSI2SK;
  }
  return next;
}

/** States after which discovery must not resurrect an item. */
const FINAL: CleanupState[] = ['DELETED', 'RESOLVED_BY_LEARNER'];

/**
 * Insert or merge a discovered resource. Merging adds the source; stronger evidence (anything but TAG / INVENTORY)
 * turns a REVIEW item back into TRACKED. Returns the item and whether it was new.
 */
export async function upsertResource(ctx: Ctx, envId: string, input: ResourceInput): Promise<{ item: SessionResourceRecord; created: boolean }> {
  const key = keyOf(input.region, input.type, input.id, input.arn);
  const rule = ruleFor(input.type);
  for (let attempt = 0; attempt < 5; attempt++) {
    const prev = await getResource(ctx, envId, key);
    const now = ctx.nowIso();
    if (!prev) {
      const item = withIndexes({
        ...Keys.sessionResource(envId, key),
        type: 'SessionResource',
        ver: 1,
        createdAt: now,
        updatedAt: now,
        envId,
        resourceKey: key,
        arn: input.arn ?? null,
        resourceType: input.type,
        region: input.region,
        name: input.name ?? null,
        id: input.id,
        sessionId: input.sessionId,
        createdBy: input.createdBy ?? (input.source === 'STACK' || input.source === 'RETAINED' || input.source === 'OUT_OF_BAND' ? 'provisioner' : input.source === 'DERIVED' ? 'service' : 'learner'),
        creatorSessionName: input.creatorSessionName ?? null,
        eventId: input.weak ? null : (input.eventId ?? null),
        eventTime: input.weak ? null : (input.eventTime ?? null),
        discoveredBy: input.source,
        sources: [input.source],
        billing: rule.billing,
        stage: rule.stage,
        cleanupState: input.cleanupState ?? (input.retained ? 'TRACKED' : 'TRACKED'),
        severity: input.severity ?? null,
        attempts: 0,
        firstAttemptAt: null,
        lastTriedAt: null,
        lastError: input.lastError ?? null,
        manualHint: null,
        stackName: input.stackName ?? null,
        logicalId: input.logicalId ?? null,
        retained: input.retained === true,
        ...(input.passNo !== undefined ? { passNo: input.passNo } : {}),
        meta: input.meta ?? {},
      } as SessionResourceRecord);
      if (await ctx.main.putIfAbsent(item)) {
        const ev = buildEvent(ctx, input.sessionId, { type: 'resource.discovered', data: { resourceKey: key, resourceType: input.type, discoveredBy: input.source }, envId, actor: 'system' });
        await ctx.main.put(ev.item);
        await publish(ctx, [ev]);
        return { item, created: true };
      }
      continue;
    }
    const sources = prev.sources?.includes(input.source) ? prev.sources : [...(prev.sources ?? [prev.discoveredBy]), input.source];
    const strong = !input.weak && input.source !== 'TAG' && input.source !== 'INVENTORY';
    const patch: Partial<SessionResourceRecord> = { sources };
    if (strong && prev.cleanupState === 'REVIEW' && !FINAL.includes(prev.cleanupState)) {
      patch.cleanupState = 'TRACKED';
      patch.severity = null;
      patch.discoveredBy = input.source;
    }
    if (input.arn && !prev.arn) patch.arn = input.arn;
    if (input.name && !prev.name) patch.name = input.name;
    if (input.eventId && !prev.eventId && !input.weak) {
      patch.eventId = input.eventId;
      patch.eventTime = input.eventTime ?? null;
      patch.creatorSessionName = input.creatorSessionName ?? prev.creatorSessionName;
    }
    if (input.stackName && !prev.stackName) patch.stackName = input.stackName;
    if (input.retained && !prev.retained) patch.retained = true;
    // a weak sighting only annotates items that are still under review (it must not relabel a stack resource)
    if (input.meta && (!input.weak || prev.cleanupState === 'REVIEW')) patch.meta = { ...(prev.meta ?? {}), ...input.meta };
    const changed = Object.entries(patch).some(([k, v]) => JSON.stringify((prev as Record<string, unknown>)[k]) !== JSON.stringify(v));
    if (!changed) return { item: prev, created: false };
    try {
      return { item: await updateResource(ctx, prev, patch), created: false };
    } catch (e) {
      if (isConditionFailed(e)) continue;
      throw e;
    }
  }
  throw new Error(`ledger item ${key}: too many concurrent updates`);
}

/** Versioned update (indexes recomputed). */
export async function updateResource(ctx: Ctx, prev: SessionResourceRecord, patch: Partial<SessionResourceRecord>): Promise<SessionResourceRecord> {
  const next = withIndexes({ ...prev, ...patch, ver: prev.ver + 1, updatedAt: ctx.nowIso() });
  const { set, remove } = diffItems(prev, next);
  const e = new Expr();
  const cond = `${e.name('ver')} = ${e.value(prev.ver)}`;
  await ctx.main.updateRaw(Keys.sessionResource(prev.envId, prev.resourceKey), updateExpression(e, set, remove), cond, e);
  return next;
}

export async function mutateResource(
  ctx: Ctx,
  envId: string,
  key: string,
  fn: (r: SessionResourceRecord) => Partial<SessionResourceRecord> | null,
): Promise<SessionResourceRecord | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const prev = await getResource(ctx, envId, key);
    if (!prev) return null;
    const patch = fn(prev);
    if (!patch) return prev;
    try {
      return await updateResource(ctx, prev, patch);
    } catch (e) {
      if (isConditionFailed(e)) continue;
      throw e;
    }
  }
  throw new Error(`ledger item ${key}: too many concurrent updates`);
}
