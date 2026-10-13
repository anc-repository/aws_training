/**
 * `LabSession` and its children in the `SESSION#<sid>` partition (01 §7.2, §7.4 AP3–AP8, AP24, AP25).
 *
 * Writer rules (01 §7.5 item 2): the state and time fields (`LIFECYCLE_OWNED_SESSION_FIELDS`) are written only by
 * `atl-lifecycle`. `createRequested()` (T01) and `transition()` are the repository operations that `atl-lifecycle`'s
 * `CreateSession` / `Transition` actions are expected to use; `atl-api` itself only calls `updateDescriptive()` for
 * attributes outside that list (`app`, `preferredDisposition`, `preferredKeep`, `cleanupRetryCount`).
 */
import {
  canTransition,
  isSessionState,
  LIFECYCLE_OWNED_SESSION_FIELDS,
  NON_TERMINAL_STATES,
  type SessionState,
} from '@atl/shared';
import { Gsi1, Gsi2, Keys, SkPrefix, type PrimaryKey } from '../data/keys.js';
import type { EventsRepo, NewSessionEvent } from './events.js';
import { ConditionFailedError, isConditionFailed, type DynamoKey, type Item, type QueryPage, type Table } from './table.js';
import { txPut, txUpdate } from './transactions.js';

export type SessionItem = Item & {
  sid: string;
  sub: string;
  labId: string;
  state: SessionState;
  ver: number;
  createdAt: string;
  stateEnteredAt: string;
};

/** Thrown when a conditional state transition does not apply (reaches Step Functions as `Atl.TransitionRejected`). */
export class TransitionRejectedError extends Error {
  constructor(
    message: string,
    readonly current?: SessionItem,
  ) {
    super(message);
    this.name = 'Atl.TransitionRejected';
  }
}

export interface TransitionInput {
  sid: string;
  from: readonly SessionState[];
  to: SessionState;
  reason: string;
  /** Optimistic lock (`ver = :ver`); defaults to the version read just before the write. */
  expectedVer?: number;
  /** Further lifecycle-owned attributes written in the same update (e.g. `readyAt`, `deadlineAt`). */
  set?: Record<string, unknown>;
  remove?: readonly string[];
  /** Events written in the same transaction in addition to `session.state_changed`. */
  events?: NewSessionEvent[];
  nowMs: number;
}

export interface ListSessionsOptions {
  limit: number;
  startKey?: DynamoKey;
  states?: readonly SessionState[];
  labId?: string;
}

const NON_TERMINAL = NON_TERMINAL_STATES as readonly SessionState[];

export class SessionsRepo {
  constructor(
    private readonly table: Table,
    private readonly events: EventsRepo,
  ) {}

  /** AP3 (strongly consistent). */
  async get(sid: string, consistent = true): Promise<SessionItem | null> {
    return this.table.get<SessionItem>(Keys.labSession(sid), consistent);
  }

  /** AP8: my sessions, newest first (GSI1, eventually consistent), optional state / card filters. */
  async listByUser(sub: string, o: ListSessionsOptions): Promise<QueryPage<SessionItem>> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const conds: string[] = ['SK = :meta'];
    values[':meta'] = 'META';
    if (o.states?.length) {
      names['#st'] = 'state';
      conds.push(`#st IN (${o.states.map((s, i) => `:st${i}`).join(', ')})`);
      o.states.forEach((s, i) => (values[`:st${i}`] = s));
    }
    if (o.labId) {
      conds.push('labId = :lab');
      values[':lab'] = o.labId;
    }
    return this.table.queryPage<SessionItem>(
      {
        index: 'GSI1',
        pk: Gsi1.labSession(sub, '0', 's000000000000').GSI1PK,
        sk: { beginsWith: SkPrefix.gsi1Session },
        descending: true,
        filter: { expression: conds.join(' AND '), ...(Object.keys(names).length ? { names } : {}), values },
        ...(o.startKey ? { startKey: o.startKey } : {}),
      },
      o.limit,
    );
  }

  /**
   * Non-terminal sessions of a user (GSI1 newest first, then re-read each one strongly consistent), used by
   * `GET /sessions/current` and the start pre-check.
   */
  async listNonTerminalByUser(sub: string, scan = 40): Promise<SessionItem[]> {
    const page = await this.listByUser(sub, { limit: scan, states: NON_TERMINAL });
    const fresh = await Promise.all(page.items.map((s) => this.get(s.sid, true)));
    return fresh.filter((s): s is SessionItem => !!s && NON_TERMINAL.includes(s.state));
  }

  /** AP12 for one non-terminal state (partition from the GSI2 builder). */
  async listByState(state: SessionState, limit = 100): Promise<SessionItem[]> {
    const part = Gsi2.labSession({ sid: 's000000000000', state, stateEnteredAt: 'x' });
    if (!part) return [];
    return this.listByStatePartition(part.GSI2PK, limit);
  }

  /** AP12: terminal sessions still inside the rescan window (`FOLLOWUP#PENDING`). */
  async listFollowUps(limit = 200): Promise<SessionItem[]> {
    const part = Gsi2.labSession({ sid: 's000000000000', state: 'ENDED', stateEnteredAt: 'x', reclaim: { followUp: 'PENDING' } });
    return part ? this.listByStatePartition(part.GSI2PK, limit) : [];
  }

  /** AP12 (one partition): sessions in a non-terminal state, or `FOLLOWUP#PENDING`. */
  async listByStatePartition(partition: string, limit = 100): Promise<SessionItem[]> {
    const items = await this.table.queryAll<Item>({ index: 'GSI2', pk: partition }, limit);
    // GSI2 projects only a few attributes: re-read the items
    const keys = items.map((i) => ({ PK: i.PK as string, SK: i.SK as string }));
    return this.table.batchGet<SessionItem>(keys, true);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Writes owned by atl-lifecycle (repository operations; atl-api never calls them directly)

  /**
   * T01: write a new `LabSession` in `REQUESTED` (`ver = 1`, condition `attribute_not_exists(PK)`) together with
   * `session.requested` and `session.state_changed` in one transaction.
   */
  async createRequested(draft: Item & { sid: string; sub: string; labId: string; variant: string }, nowMs: number, reason = 'CREATED'): Promise<SessionItem> {
    const nowIso = new Date(nowMs).toISOString();
    const item: SessionItem = {
      outageWindow: null,
      ...draft,
      ...Keys.labSession(draft.sid),
      ...Gsi1.labSession(draft.sub, nowIso, draft.sid),
      ...Gsi2.labSession({ sid: draft.sid, state: 'REQUESTED', stateEnteredAt: nowIso }),
      type: 'LabSession',
      state: 'REQUESTED',
      stateReason: reason,
      stateEnteredAt: nowIso,
      ver: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    } as SessionItem;
    const events = this.events.putTx(
      draft.sid,
      [
        { type: 'session.requested', data: { labId: draft.labId, variant: draft.variant, quoteId: (draft.costQuote as { quoteId?: string } | undefined)?.quoteId ?? null } },
        { type: 'session.state_changed', data: { from: null, to: 'REQUESTED', reason } },
      ],
      nowMs,
    );
    await this.table.transact([txPut(this.table.name, item, { expression: 'attribute_not_exists(PK)' }), ...events]);
    return item;
  }

  /**
   * Conditional transition (02 §2.7): `state = :current AND ver = :ver`, `ver + 1`, GSI2 recomputed, and
   * `session.state_changed` (plus `events`) in the same transaction. A replay (state already `to` with the same reason)
   * succeeds without writing.
   */
  async transition(t: TransitionInput): Promise<{ session: SessionItem; replayed: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await this.get(t.sid, true);
      if (!cur) throw new TransitionRejectedError(`session ${t.sid} does not exist`);
      if (cur.state === t.to && cur.stateReason === t.reason && !(t.from.includes(t.to) && t.to === 'KEPT')) {
        return { session: cur, replayed: true };
      }
      if (!t.from.includes(cur.state) || !canTransition(cur.state, t.to)) {
        throw new TransitionRejectedError(`transition ${cur.state} → ${t.to} is not allowed here`, cur);
      }
      if (t.expectedVer !== undefined && cur.ver !== t.expectedVer) {
        throw new TransitionRejectedError(`version mismatch (have ${cur.ver}, expected ${t.expectedVer})`, cur);
      }
      const nowIso = new Date(t.nowMs).toISOString();
      const next = { ...cur, ...(t.set ?? {}), state: t.to, stateReason: t.reason, stateEnteredAt: nowIso, ver: cur.ver + 1, updatedAt: nowIso } as SessionItem;
      for (const r of t.remove ?? []) delete (next as Item)[r];
      const gsi2 = Gsi2.labSession({
        sid: t.sid,
        state: t.to,
        stateEnteredAt: nowIso,
        deadlineAt: (next.deadlineAt as string | null | undefined) ?? null,
        revokedAt: (next.revokedAt as string | null | undefined) ?? null,
        reclaim: (next.reclaim as { followUp?: 'PENDING' | 'DONE' } | null | undefined) ?? null,
      });
      const set: Record<string, unknown> = { ...(t.set ?? {}), state: t.to, stateReason: t.reason, stateEnteredAt: nowIso, ver: cur.ver + 1, updatedAt: nowIso };
      const remove = [...(t.remove ?? [])];
      if (gsi2) Object.assign(set, gsi2);
      else remove.push('GSI2PK', 'GSI2SK');
      const update = txUpdate(this.table.name, Keys.labSession(t.sid), {
        set,
        remove,
        condition: { expression: '#cs = :cs AND #cv = :cv', names: { '#cs': 'state', '#cv': 'ver' }, values: { ':cs': cur.state, ':cv': cur.ver } },
      });
      const events = this.events.putTx(t.sid, [{ type: 'session.state_changed', data: { from: cur.state, to: t.to, reason: t.reason } }, ...(t.events ?? [])], t.nowMs);
      try {
        await this.table.transact([update, ...events]);
        if (gsi2) Object.assign(next, gsi2);
        else {
          delete (next as Item).GSI2PK;
          delete (next as Item).GSI2SK;
        }
        return { session: next, replayed: false };
      } catch (e) {
        if (!isConditionFailed(e)) throw e;
        // lost a race: re-read once (the replay check above may now succeed)
      }
    }
    throw new TransitionRejectedError(`concurrent update of session ${t.sid}`);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Descriptive attributes that atl-api may write without changing `ver` (01 §7.5 item 2)

  /**
   * Attribute-level update of fields outside `LIFECYCLE_OWNED_SESSION_FIELDS`, guarded by the session state.
   * Throws `ConditionFailedError` when the state is not in `states`.
   */
  async updateDescriptive(sid: string, set: Record<string, unknown>, states: readonly SessionState[], extra?: { expression: string; values: Record<string, unknown> }): Promise<SessionItem> {
    for (const k of Object.keys(set)) {
      if ((LIFECYCLE_OWNED_SESSION_FIELDS as readonly string[]).includes(k)) throw new Error(`${k} is written only by atl-lifecycle`);
    }
    const values: Record<string, unknown> = { ...(extra?.values ?? {}) };
    states.forEach((s, i) => (values[`:ds${i}`] = s));
    const expression = `#ds IN (${states.map((_, i) => `:ds${i}`).join(', ')})${extra ? ` AND (${extra.expression})` : ''}`;
    return this.table.update<SessionItem>(Keys.labSession(sid), {
      set,
      condition: { expression: `attribute_exists(PK) AND ${expression}`, names: { '#ds': 'state' }, values },
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Children (AP4, AP6, AP7, AP24, AP25)

  async children(sid: string, prefix: string, o: { limit?: number; startKey?: DynamoKey; descending?: boolean; all?: boolean } = {}): Promise<QueryPage> {
    const q = { pk: Keys.labSession(sid).PK, sk: { beginsWith: prefix }, descending: !!o.descending, consistent: true, ...(o.startKey ? { startKey: o.startKey } : {}) };
    if (o.all) return { items: await this.table.queryAll(q) };
    return this.table.queryPage(q, o.limit ?? 100);
  }

  /** AP4: the whole partition (reports, cleanup summary). */
  async partition(sid: string): Promise<Item[]> {
    return this.table.queryAll({ pk: Keys.labSession(sid).PK, consistent: true }, 5000);
  }

  async getChild(key: PrimaryKey): Promise<Item | null> {
    return this.table.get(key, true);
  }

  async putChild(item: Item, condition?: { expression: string; names?: Record<string, string>; values?: Record<string, unknown> }): Promise<void> {
    await this.table.put(item, condition);
  }

  async updateChild(key: PrimaryKey, spec: Parameters<Table['update']>[1]): Promise<Item> {
    return this.table.update(key, spec);
  }

  async attempt(sid: string): Promise<Item | null> {
    return this.table.get(Keys.labAttempt(sid), true);
  }

  async latestReport(sid: string): Promise<Item | null> {
    const page = await this.table.query({ pk: Keys.labSession(sid).PK, sk: { beginsWith: SkPrefix.report }, descending: true, limit: 50, consistent: true });
    // `REPORT#v<n>` sorts lexicographically (v10 < v9): pick the highest version numerically
    return page.items.reduce<Item | null>((best, it) => (!best || Number(it.version ?? 0) > Number(best.version ?? 0) ? it : best), null);
  }
}

export function isSessionItem(v: unknown): v is SessionItem {
  return !!v && typeof v === 'object' && typeof (v as Item).sid === 'string' && isSessionState((v as Item).state);
}

export { ConditionFailedError };
