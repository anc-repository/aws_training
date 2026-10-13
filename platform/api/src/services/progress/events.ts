/**
 * `atl.progress` events (01 §8.4): written as `SessionEvent` items (cursor reads, 01 AP5) and published to `atl-events`.
 * Publishing failures never fail the caller (the item is the source of truth for the UI).
 */
import { eventSourceOf, newUlid, type RegisteredEventType } from '@atl/shared';
import { Keys } from '../../data/keys.js';
import type { FunctionDeps } from '../../runtime/deps.js';
import type { ItemStore } from './store.js';

export interface PendingEvent {
  type: RegisteredEventType;
  sessionId: string | null;
  data: Record<string, unknown>;
}

export async function emitEvents(deps: FunctionDeps, store: ItemStore, events: PendingEvent[]): Promise<void> {
  if (events.length === 0) return;
  const now = deps.ports.clock.nowMs();
  const at = new Date(now).toISOString();
  for (const e of events) {
    if (!e.sessionId) continue;
    const eventId = newUlid(now);
    await store
      // stored like the other writers: `type` = event type (01 §7.3), entity name in `entity`
      .put({ ...Keys.sessionEvent(e.sessionId, eventId), type: e.type, entity: 'SessionEvent', eventId, sessionId: e.sessionId, at, source: eventSourceOf(e.type), actor: 'system', data: e.data, ver: 1, createdAt: at, updatedAt: at })
      .catch((err: unknown) => console.warn(JSON.stringify({ level: 'warn', msg: 'session event write failed', type: e.type, error: String(err) })));
  }
  await deps.ports.events
    .publish(events.map((e) => ({ source: eventSourceOf(e.type), detailType: e.type, detail: { ...(e.sessionId ? { sessionId: e.sessionId } : {}), ...e.data, at } })))
    .catch((err: unknown) => console.warn(JSON.stringify({ level: 'warn', msg: 'event publish failed', error: String(err) })));
}
