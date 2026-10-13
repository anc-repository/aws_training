/**
 * Targeted in-session ownership scan `OwnershipLookup` (02 §7.12, 01 §3.12): does a resource the learner created by
 * hand belong to this session (or its hand-over chain)? Ledger first, then CloudTrail event history (`LookupEvents`,
 * no trail needed): `ResourceName`, then `EventName` around the creation time, then `Username`. One retry cadence for
 * the whole platform: 2, 2, 4, 4, 8 minutes, then every 8 minutes; up to the check's `maxWaitMinutes` (default 20,
 * hard limit ≥ 45). Called synchronously by atl-checks (action of atl-reaper).
 */
import { ATL_OPS, RoleSessionNames } from '@atl/shared';
import type { Ctx } from '../lifecycle/context.js';
import { MINUTE } from '../lifecycle/context.js';
import { getEnvironment } from '../lifecycle/store/environments.js';
import { getConfig } from '../lifecycle/store/platform.js';
import { getSession } from '../lifecycle/store/sessions.js';
import { creationEventsFor, extractRefs, parseTrailEvent, type ParsedEvent } from '../reaper/reclaimer/extractors.js';
import { getResource, keyOf, upsertResource } from '../reaper/reclaimer/ledger.js';
import { awaitLookupToken } from '../reaper/reclaimer/rate.js';
import { lookupRegion } from '../reaper/reclaimer/rules.js';

export interface OwnershipLookupRequest {
  sessionId: string;
  resource: { type: string; id: string; arn?: string | null; region: string };
  createdAtHint?: string | null;
  scope: 'session' | 'chain';
  maxWaitMinutes?: number | null;
  /** first lookup of this resource by the check (when there is no createdAtHint) */
  firstQueriedAt?: string | null;
  /** number of earlier PENDING answers for this resource (cadence index) */
  attempt?: number;
}

export type OwnershipLookupResult =
  | { status: 'FOUND'; sessionId: string; roleSessionName: string | null; eventId: string | null; eventName: string | null; eventTime: string | null; region: string }
  | { status: 'PENDING'; retryAfterSeconds: number; waitedSeconds: number }
  | { status: 'NOT_OWNED'; actor: string; eventId: string }
  | { status: 'NOT_FOUND' }
  | { status: 'THROTTLED'; retryAfterSeconds: number };

/** 01 §3.12: 2, 2, 4, 4, 8 minutes, then every 8 minutes. */
export const OWNERSHIP_RETRY_SECONDS = [120, 120, 240, 240, 480] as const;
export function retryAfterSeconds(attempt: number): number {
  return OWNERSHIP_RETRY_SECONDS[Math.min(Math.max(0, attempt), OWNERSHIP_RETRY_SECONDS.length - 1)]!;
}

function scopeNames(sids: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const sid of sids) {
    for (const n of [RoleSessionNames.console(sid), RoleSessionNames.term(sid), RoleSessionNames.ws(sid)]) m.set(n, sid);
    for (const op of ATL_OPS) m.set(RoleSessionNames.prov(sid, op), sid);
  }
  return m;
}

function matches(ev: ParsedEvent, req: OwnershipLookupRequest): boolean {
  const refs = extractRefs(ev) ?? [];
  const ids = new Set([req.resource.id, req.resource.arn].filter((x): x is string => !!x));
  return refs.some((r) => ids.has(r.id) || (!!r.arn && ids.has(r.arn)));
}

export async function ownershipLookup(ctx: Ctx, req: OwnershipLookupRequest): Promise<OwnershipLookupResult> {
  const s = await getSession(ctx, req.sessionId);
  if (!s || !s.envId) return { status: 'NOT_FOUND' };
  const env = await getEnvironment(ctx, s.envId);
  const sids = req.scope === 'chain' ? (env?.sessionChain ?? [s.sid]) : [s.sid];
  const names = scopeNames(sids);
  const region = lookupRegion(req.resource.type, req.resource.region);

  // 1. ledger first (stack resources, runner resources, earlier confirmations)
  const key = keyOf(region, req.resource.type, req.resource.id, req.resource.arn ?? null);
  const known = await getResource(ctx, s.envId, key);
  if (known && sids.includes(known.sessionId) && (known.sources ?? []).some((x) => x !== 'TAG' && x !== 'INVENTORY')) {
    return { status: 'FOUND', sessionId: known.sessionId, roleSessionName: known.creatorSessionName ?? null, eventId: known.eventId ?? null, eventName: null, eventTime: known.eventTime ?? null, region };
  }

  const cfg = await getConfig(ctx);
  const limitMin = Math.min(cfg.ownership.hardMaxWaitMinutes, req.maxWaitMinutes ?? cfg.ownership.maxWaitMinutes);
  const origin = req.createdAtHint ? Date.parse(req.createdAtHint) : req.firstQueriedAt ? Date.parse(req.firstQueriedAt) : ctx.nowMs();
  const waitedSeconds = Math.max(0, Math.floor((ctx.nowMs() - origin) / 1000));
  const sessionStart = req.scope === 'chain' && env ? Date.parse(env.createdAt) : Date.parse(s.createdAt);
  const end = new Date(ctx.nowMs());
  const wideStart = new Date(sessionStart - 10 * MINUTE);

  const queries: { key: 'ResourceName' | 'EventName' | 'Username'; value: string; start: Date; end: Date }[] = [];
  queries.push({ key: 'ResourceName', value: req.resource.id, start: wideStart, end });
  if (req.resource.arn && req.resource.arn !== req.resource.id) queries.push({ key: 'ResourceName', value: req.resource.arn, start: wideStart, end });
  const hint = req.createdAtHint ? Date.parse(req.createdAtHint) : null;
  for (const c of creationEventsFor(req.resource.type)) {
    queries.push({
      key: 'EventName',
      value: c.eventName,
      start: hint ? new Date(hint - 15 * MINUTE) : wideStart,
      end: hint ? new Date(Math.min(hint + 15 * MINUTE, end.getTime())) : end,
    });
  }
  for (const n of [...names.keys()].filter((n) => /-(console|term|ws)$/.test(n))) queries.push({ key: 'Username', value: n, start: wideStart, end });

  let notOwned: { actor: string; eventId: string } | null = null;
  for (const q of queries) {
    const wait = await awaitLookupToken(ctx, region);
    if (wait > 0) return { status: 'THROTTLED', retryAfterSeconds: wait };
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await ctx.ports.trail.lookupEvents({ region, attribute: { key: q.key, value: q.value }, startTime: q.start, endTime: q.end, ...(token ? { nextToken: token } : {}), maxResults: 50 });
      pages++;
      for (const raw of page.events) {
        const ev = parseTrailEvent(raw);
        if (ev.errorCode || ev.readOnly) continue;
        if (!matches(ev, req)) continue;
        const owner = ev.sessionName ? names.get(ev.sessionName) : undefined;
        if (owner) {
          await upsertResource(ctx, s.envId, {
            type: req.resource.type,
            id: req.resource.id,
            region,
            arn: req.resource.arn ?? null,
            sessionId: owner,
            source: 'OWNERSHIP_LOOKUP',
            createdBy: /-prov-/.test(ev.sessionName!) ? 'provisioner' : 'learner',
            creatorSessionName: ev.sessionName,
            eventId: ev.eventId,
            eventTime: ev.eventTime,
          });
          return { status: 'FOUND', sessionId: owner, roleSessionName: ev.sessionName, eventId: ev.eventId, eventName: ev.eventName, eventTime: ev.eventTime, region };
        }
        notOwned ??= { actor: ev.userArn ?? ev.sessionName ?? 'unknown', eventId: ev.eventId };
      }
      token = page.nextToken;
    } while (token && pages < 3);
    if (notOwned) break;
  }
  if (notOwned) {
    await upsertResource(ctx, s.envId, {
      type: req.resource.type,
      id: req.resource.id,
      region,
      arn: req.resource.arn ?? null,
      sessionId: s.sid,
      source: 'TAG',
      cleanupState: 'REVIEW',
      severity: 'REVIEW',
      lastError: `created by ${notOwned.actor}, not by this session (OwnershipLookup)`,
    }).catch(() => undefined);
    return { status: 'NOT_OWNED', ...notOwned };
  }
  if (waitedSeconds >= limitMin * 60) return { status: 'NOT_FOUND' };
  return { status: 'PENDING', retryAfterSeconds: retryAfterSeconds(req.attempt ?? 0), waitedSeconds };
}
