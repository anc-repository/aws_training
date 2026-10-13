/** In-memory `atl-events` bus for dev: keeps every published event and notifies listeners. */
import type { EventPublisherPort, PlatformBusEvent } from '@atl/shared';

export class MemoryEventPublisher implements EventPublisherPort {
  readonly published: (PlatformBusEvent & { at: string })[] = [];
  private readonly listeners = new Set<(e: PlatformBusEvent) => void>();

  onEvent(fn: (e: PlatformBusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async publish(events: PlatformBusEvent[]): Promise<void> {
    for (const e of events) {
      this.published.push({ ...e, at: new Date().toISOString() });
      for (const l of this.listeners) l(e);
    }
  }
}
