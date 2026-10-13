import type { EventSource } from '../events.js';

/** Bus `atl-events`. Production: `@aws-sdk/client-eventbridge` PutEvents. Dev: in-memory list + listeners. */
export interface PlatformBusEvent {
  source: EventSource;
  /** = `SessionEvent.type` (01 §8.4). */
  detailType: string;
  detail: Record<string, unknown>;
}

export interface EventPublisherPort {
  publish(events: PlatformBusEvent[]): Promise<void>;
}
