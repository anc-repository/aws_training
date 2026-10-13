/**
 * `LabSession` persistence. Every write is a versioned conditional update (`ver = :ver`, then `ver + 1`) of the changed
 * top-level attributes, in one transaction with the `SessionEvent` items and any extra items (lock, environment) —
 * 01 §7.5 items 1–2. GSI2 (sparse) is recomputed from the new item on every write (01 §7.2).
 */
import { canTransition, Gsi1, Gsi2, Keys, type SessionState } from '@atl/shared';
import type { Ctx } from '../context.js';
import { err, WorkflowError } from '../errors.js';
import { cancelledIndex, diffItems, Expr, isConditionFailed, isTransactionConflict, updateExpression, type TransactItem } from './ddb.js';
import { buildEvent, eventPut, publish, type BuiltEvent, type EventDraft } from './events.js';
import type { SessionRecord } from './model.js';

export async function getSession(ctx: Ctx, sid: string): Promise<SessionRecord | null> {
  return ctx.main.get<SessionRecord>(Keys.labSession(sid));
}

export async function mustGetSession(ctx: Ctx, sid: string): Promise<SessionRecord> {
  const s = await getSession(ctx, sid);
  if (!s) throw err.notFound(`session ${sid} does not exist`);
  return s;
}

/** GSI2 attributes of a session item (REMOVE when the item leaves the sparse index). */
export function withSessionGsi2(s: SessionRecord): SessionRecord {
  const g = Gsi2.labSession({
    sid: s.sid,
    state: s.state,
    stateEnteredAt: s.stateEnteredAt,
    deadlineAt: s.deadlineAt ?? null,
    revokedAt: s.revokedAt ?? null,
    reclaim: s.reclaim ?? null,
  });
  const next = { ...s } as SessionRecord & { GSI2PK?: string; GSI2SK?: string };
  if (g) {
    next.GSI2PK = g.GSI2PK;
    next.GSI2SK = g.GSI2SK;
  } else {
    delete next.GSI2PK;
    delete next.GSI2SK;
  }
  return next;
}

export interface SessionMutation {
  patch: Partial<SessionRecord>;
  /** attributes to remove */
  remove?: string[];
  /** extra transaction items; their condition failures are mapped with `onExtraFailed` */
  extra?: TransactItem[];
  onExtraFailed?: (index: number) => Error;
  events?: EventDraft[];
}

export interface MutateResult {
  session: SessionRecord;
  previous: SessionRecord;
  changed: boolean;
}

/**
 * Read-modify-write with optimistic locking. `fn` returns `null` for “nothing to do”. Retries on version conflicts.
 */
export async function mutateSession(ctx: Ctx, sid: string, fn: (s: SessionRecord) => SessionMutation | null, opts: { retries?: number } = {}): Promise<MutateResult> {
  const retries = opts.retries ?? 6;
  for (let attempt = 0; ; attempt++) {
    const prev = await mustGetSession(ctx, sid);
    const m = fn(prev);
    if (!m) return { session: prev, previous: prev, changed: false };
    const now = ctx.nowIso();
    let next = { ...prev, ...m.patch, ver: prev.ver + 1, updatedAt: now } as SessionRecord;
    for (const k of m.remove ?? []) delete (next as Record<string, unknown>)[k];
    for (const [k, v] of Object.entries(m.patch)) if (v === undefined) delete (next as Record<string, unknown>)[k];
    next = withSessionGsi2(next);
    const { set, remove } = diffItems(prev, next);
    const e = new Expr();
    const cond = `${e.name('ver')} = ${e.value(prev.ver)}`;
    const updExpr = updateExpression(e, set, remove);
    const built: BuiltEvent[] = (m.events ?? []).map((d, i) => buildEvent(ctx, sid, { envId: next.envId ?? null, ...d }, ctx.nowMs() + i));
    try {
      if ((m.extra?.length ?? 0) === 0 && built.length === 0) {
        await ctx.main.updateRaw(Keys.labSession(sid), updExpr, cond, e);
      } else {
        const update: TransactItem = {
          Update: { TableName: ctx.main.name, Key: Keys.labSession(sid), UpdateExpression: updExpr, ConditionExpression: cond, ...e.input() },
        };
        await ctx.main.transact([update, ...(m.extra ?? []), ...built.map((b) => eventPut(ctx, b))]);
      }
    } catch (ex) {
      const idx = cancelledIndex(ex);
      const retry = isConditionFailed(ex) || idx === 0 || isTransactionConflict(ex);
      if (idx > 0 && idx <= (m.extra?.length ?? 0)) throw m.onExtraFailed?.(idx - 1) ?? ex;
      if (retry && attempt < retries) continue;
      if (retry) throw err.retryable(`session ${sid}: too many concurrent updates`);
      throw ex;
    }
    await publish(ctx, built);
    return { session: next, previous: prev, changed: true };
  }
}

export interface TransitionRequest {
  from: readonly (SessionState | null)[];
  to: SessionState;
  reason: string;
  patch?: (s: SessionRecord) => Partial<SessionRecord>;
  remove?: string[];
  extra?: (s: SessionRecord) => TransactItem[];
  onExtraFailed?: (index: number) => Error;
  events?: (s: SessionRecord) => EventDraft[];
  /** Additional guard on the current item; return an error to refuse. */
  guard?: (s: SessionRecord) => Error | null;
}

export interface TransitionResult {
  session: SessionRecord;
  previous: SessionRecord;
  replayed: boolean;
}

/**
 * `Transition` (02 §2.3, 2.7): the edge must be one of T01–T21 and the current state one of `from`. A replay (already in
 * the target state with the same reason) succeeds without writing. Every transition writes `session.state_changed`.
 */
export async function transitionSession(ctx: Ctx, sid: string, req: TransitionRequest): Promise<TransitionResult> {
  let replayed = false;
  const r = await mutateSession(ctx, sid, (s) => {
    if (s.state === req.to && (s.stateReason ?? null) === req.reason && !(req.to === 'KEPT' && s.state === 'KEPT')) {
      replayed = true;
      return null;
    }
    if (!req.from.includes(s.state)) {
      throw err.transitionRejected(`session ${sid} is ${s.state}, expected one of ${req.from.join(', ')} for → ${req.to}`);
    }
    if (!canTransition(s.state, req.to)) throw err.transitionRejected(`${s.state} → ${req.to} is not a transition of 02 §2.3`);
    const refused = req.guard?.(s);
    if (refused) throw refused;
    const now = ctx.nowIso();
    const patch: Partial<SessionRecord> = { ...(req.patch?.(s) ?? {}), state: req.to, stateReason: req.reason, stateEnteredAt: now };
    return {
      patch,
      ...(req.remove ? { remove: req.remove } : {}),
      ...(req.extra ? { extra: req.extra(s) } : {}),
      ...(req.onExtraFailed ? { onExtraFailed: req.onExtraFailed } : {}),
      events: [{ type: 'session.state_changed', data: { from: s.state, to: req.to, reason: req.reason } }, ...(req.events?.(s) ?? [])],
    };
  });
  return { session: r.session, previous: r.previous, replayed };
}

/**
 * Versioned update of *another* session inside the transaction of a first one (T15: the kept session A ends when the
 * new session B enters PROVISIONING). Returns the transaction items (update + events) and the built events to publish.
 */
export function otherSessionUpdate(
  ctx: Ctx,
  prev: SessionRecord,
  patch: Partial<SessionRecord>,
  drafts: EventDraft[],
): { items: TransactItem[]; built: BuiltEvent[]; next: SessionRecord } {
  const next = withSessionGsi2({ ...prev, ...patch, ver: prev.ver + 1, updatedAt: ctx.nowIso() } as SessionRecord);
  const { set, remove } = diffItems(prev, next);
  const e = new Expr();
  const cond = `${e.name('ver')} = ${e.value(prev.ver)}`;
  const built = drafts.map((d, i) => buildEvent(ctx, prev.sid, { envId: next.envId ?? null, ...d }, ctx.nowMs() + 100 + i));
  return {
    items: [
      { Update: { TableName: ctx.main.name, Key: Keys.labSession(prev.sid), UpdateExpression: updateExpression(e, set, remove), ConditionExpression: cond, ...e.input() } },
      ...built.map((b) => eventPut(ctx, b)),
    ],
    built,
    next,
  };
}

export { publish as publishEvents };

/** T01: create the session item (from `null` → REQUESTED, condition `attribute_not_exists(PK)`, 01 §7.5 item 1). */
export async function createSessionItem(ctx: Ctx, s: SessionRecord, events: EventDraft[]): Promise<SessionRecord> {
  const item = withSessionGsi2({ ...s, ...Keys.labSession(s.sid), ...Gsi1.labSession(s.sub, s.createdAt, s.sid) } as SessionRecord);
  const e = new Expr();
  const built = [
    { type: 'session.requested', data: { labId: s.labId, variant: s.variant, quoteId: s.costQuote?.quoteId ?? null } },
    { type: 'session.state_changed', data: { from: null, to: 'REQUESTED', reason: s.stateReason ?? 'CREATED' } },
    ...events,
  ].map((d, i) => buildEvent(ctx, s.sid, { envId: null, ...(d as EventDraft) }, ctx.nowMs() + i));
  try {
    await ctx.main.transact([
      { Put: { TableName: ctx.main.name, Item: item, ConditionExpression: `attribute_not_exists(${e.name('PK')})`, ...e.input() } },
      ...built.map((b) => eventPut(ctx, b)),
    ]);
  } catch (ex) {
    if (cancelledIndex(ex) === 0 || isConditionFailed(ex)) throw new WorkflowError('Atl.TransitionRejected', `session ${s.sid} already exists`);
    throw ex;
  }
  await publish(ctx, built);
  return item;
}

/** Phase marks (session.phase_changed, `LabSession.phases[]`); names follow 08 §9.2 #8 (not yet registered in 01). */
export function applyPhaseMarks(
  s: SessionRecord,
  marks: { phase: string; status: string; detail?: string | null }[],
  now: string,
): { phases: NonNullable<SessionRecord['phases']>; events: EventDraft[] } {
  const phases = [...(s.phases ?? [])];
  const events: EventDraft[] = [];
  for (const m of marks) {
    const i = phases.map((p) => p.name).lastIndexOf(m.phase);
    const cur = i >= 0 ? phases[i] : undefined;
    if (cur && cur.status === m.status && (cur.detail ?? null) === (m.detail ?? null)) continue;
    const entry = { name: m.phase, status: m.status, at: now, ...(m.detail ? { detail: m.detail } : {}) };
    if (cur && !(cur.status === 'DONE' && m.status === 'RUNNING')) phases[i] = { ...entry, at: cur.status === m.status ? cur.at : now };
    else phases.push(entry);
    events.push({ type: 'session.phase_changed', data: { phase: m.phase, status: m.status, detail: m.detail ?? null } });
  }
  return { phases: phases.slice(-60), events };
}
