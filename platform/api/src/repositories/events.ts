/**
 * `SessionEvent` (01 §7.2 `SESSION#<sid> / EVT#<ulid>`, §7.3, §8.4) and the AP5 incremental read
 * (`SK > EVT#<after>` and `SK <= EVT#~`).
 *
 * Stored shape follows `SessionEventRecord` of @atl/shared: `type` is the event type (01 §7.3 lists `type` among the
 * SessionEvent attributes); the entity name is kept in `entity` because the generic `type` attribute (01 §7.1) is
 * taken. Readers accept items written either way (`eventType` / `entity`).
 */
import { CROCKFORD_UPPER, eventSourceOf, isSessionEventType, newUlid, ulidTime, type EventSource, type SessionEventType } from '@atl/shared';
import { eventRange, Keys, SkPrefix } from '../data/keys.js';
import type { Item, Table } from './table.js';
import type { TransactItem } from './transactions.js';

export interface SessionEventView {
  id: string;
  type: string;
  source: EventSource | string;
  at: string;
  data: Record<string, unknown>;
}

/** ULIDs that increase strictly within this container (events written in the same millisecond keep their order). */
export class MonotonicUlid {
  private last = '';
  next(nowMs: number): string {
    let id = newUlid(nowMs);
    // Same millisecond (or a clock a little behind): continue after the last id. A clock far behind the last id
    // (a different clock, e.g. tests) starts over instead of carrying ids into its future.
    if (id <= this.last && ulidTime(this.last) - nowMs <= 1000) id = incrementUlid(this.last);
    this.last = id;
    return id;
  }
}

/** Increment the last character of a Crockford Base32 (uppercase) string with carry. */
export function incrementUlid(id: string): string {
  const chars = id.split('');
  for (let i = chars.length - 1; i >= 10; i--) {
    const idx = CROCKFORD_UPPER.indexOf(chars[i]!.toUpperCase());
    if (idx < 31) {
      chars[i] = CROCKFORD_UPPER[idx + 1]!;
      return chars.join('');
    }
    chars[i] = '0';
  }
  // random part overflowed: bump the timestamp by one millisecond
  return newUlid(ulidTime(id) + 1);
}

export const sharedUlids = new MonotonicUlid();

export interface NewSessionEvent {
  type: SessionEventType;
  data: Record<string, unknown>;
  /** Defaults to the clock time of the write. */
  at?: string;
}

export function buildSessionEventItem(sid: string, ev: NewSessionEvent, eventId: string, nowIso: string, ttl?: number): Item {
  if (!isSessionEventType(ev.type)) throw new TypeError(`unregistered event type: ${ev.type}`);
  return {
    ...Keys.sessionEvent(sid, eventId),
    type: ev.type,
    entity: 'SessionEvent',
    ver: 1,
    eventId,
    sessionId: sid,
    at: ev.at ?? nowIso,
    source: eventSourceOf(ev.type),
    data: ev.data,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(ttl ? { ttl } : {}),
  };
}

export function toEventView(item: Item): SessionEventView {
  const type = (item.eventType as string | undefined) ?? (item.type !== 'SessionEvent' ? (item.type as string) : 'unknown');
  const id = (item.eventId as string | undefined) ?? String(item.SK).slice(SkPrefix.event.length);
  return {
    id,
    type,
    source: (item.source as string | undefined) ?? (isSessionEventType(type) ? eventSourceOf(type) : 'atl.lifecycle'),
    at: (item.at as string | undefined) ?? (item.createdAt as string),
    data: (item.data as Record<string, unknown> | undefined) ?? {},
  };
}

export class EventsRepo {
  constructor(
    private readonly table: Table,
    private readonly ulids: MonotonicUlid = sharedUlids,
  ) {}

  /** Items for a transaction (callers that must write events atomically with another change). */
  items(sid: string, events: NewSessionEvent[], nowMs: number, ttl?: number): { items: Item[]; ids: string[] } {
    const nowIso = new Date(nowMs).toISOString();
    const ids = events.map(() => this.ulids.next(nowMs));
    return { items: events.map((e, i) => buildSessionEventItem(sid, e, ids[i]!, nowIso, ttl)), ids };
  }

  putTx(sid: string, events: NewSessionEvent[], nowMs: number, ttl?: number): TransactItem[] {
    return this.items(sid, events, nowMs, ttl).items.map((Item) => ({ Put: { TableName: this.table.name, Item } }));
  }

  async append(sid: string, events: NewSessionEvent[], nowMs: number, ttl?: number): Promise<SessionEventView[]> {
    const { items } = this.items(sid, events, nowMs, ttl);
    for (const it of items) await this.table.put(it);
    return items.map(toEventView);
  }

  /**
   * AP5: events after `after` (exclusive), oldest first. `settleBeforeMs`: events whose ULID time is later than this are
   * not returned yet, so that a slower writer with an earlier id cannot be skipped by a cursor that already moved past it.
   */
  async listAfter(sid: string, after: string | undefined, limit: number, settleBeforeMs?: number): Promise<{ events: SessionEventView[]; hasMore: boolean }> {
    const range = eventRange(after);
    const q = after
      ? { pk: Keys.labSession(sid).PK, sk: { gt: range.lowerExclusive, lte: range.upperInclusive } }
      : { pk: Keys.labSession(sid).PK, sk: { beginsWith: SkPrefix.event } };
    const page = await this.table.query({ ...q, limit: limit + 1, consistent: true });
    let items = page.items;
    let hasMore = items.length > limit || !!page.lastKey;
    items = items.slice(0, limit);
    if (settleBeforeMs !== undefined) {
      const idx = items.findIndex((it) => {
        const id = (it.eventId as string | undefined) ?? String(it.SK).slice(4);
        try {
          return ulidTime(id) > settleBeforeMs;
        } catch {
          return false;
        }
      });
      if (idx >= 0) {
        items = items.slice(0, idx);
        hasMore = true;
      }
    }
    return { events: items.map(toEventView), hasMore };
  }
}
