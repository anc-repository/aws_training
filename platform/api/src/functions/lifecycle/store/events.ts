/**
 * `SessionEvent` (01 §7.2, §8.4): written to `atl-main` (browser polling) and published to the bus `atl-events`
 * (`detail-type` = type, `source` from the name table). Publishing is best effort: the table is the record.
 */
import { eventSourceOf, Keys, newUlid, type SessionEventType } from '@atl/shared';
import type { Ctx } from '../context.js';
import type { Item, TransactItem } from './ddb.js';

export interface EventDraft {
  type: SessionEventType;
  data: Record<string, unknown>;
  /** `user` / `system` / `scheduler` / `runner` / `sweeper` / `admin` (02 §13.3); defaults to the ctx actor */
  actor?: string;
  envId?: string | null;
}

export interface BuiltEvent {
  item: Item;
  bus: { source: ReturnType<typeof eventSourceOf>; detailType: string; detail: Record<string, unknown> };
}

export function buildEvent(ctx: Ctx, sid: string, d: EventDraft, atMs = ctx.nowMs()): BuiltEvent {
  const eventId = newUlid(atMs);
  const at = new Date(atMs).toISOString();
  const source = eventSourceOf(d.type);
  const actor = d.actor ?? ctx.actor;
  return {
    item: {
      ...Keys.sessionEvent(sid, eventId),
      // 01 §7.3 lists `type` of SessionEvent as the event type (8.4), as `SessionEventRecord` of @atl/shared does;
      // the entity name goes to `entity`
      type: d.type,
      entity: 'SessionEvent',
      ver: 1,
      createdAt: at,
      updatedAt: at,
      eventId,
      sessionId: sid,
      at,
      source,
      actor,
      data: d.data,
    },
    bus: { source, detailType: d.type, detail: { eventId, sessionId: sid, envId: d.envId ?? null, at, actor, ...d.data } },
  };
}

export function eventPut(ctx: Ctx, e: BuiltEvent): TransactItem {
  return { Put: { TableName: ctx.main.name, Item: e.item } };
}

export async function publish(ctx: Ctx, events: BuiltEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await ctx.ports.events.publish(events.map((e) => e.bus));
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'atl-events publish failed', error: e instanceof Error ? e.message : String(e) }));
  }
}

/** Write and publish events outside of a transaction. */
export async function emit(ctx: Ctx, sid: string, drafts: EventDraft[]): Promise<void> {
  const built = drafts.map((d, i) => buildEvent(ctx, sid, d, ctx.nowMs() + i));
  for (const b of built) await ctx.main.put(b.item);
  await publish(ctx, built);
}
