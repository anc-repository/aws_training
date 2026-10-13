/**
 * Injectable fake CloudTrail event history. Events are matched like `LookupEvents`: one lookup attribute, time range,
 * region; newest first; paginated. `delaySeconds` simulates delivery latency (an event is visible once
 * `eventTime + delay <= now`), so OwnershipLookup's PENDING path (02 §7.12) can be exercised.
 */
import fs from 'node:fs';
import type { ClockPort, TrailEvent, TrailLookupPort, TrailLookupRequest } from '@atl/shared';

export class FakeTrailLookup implements TrailLookupPort {
  private events: TrailEvent[] = [];
  readonly calls: TrailLookupRequest[] = [];

  constructor(
    private readonly clock: ClockPort,
    private readonly delaySeconds = 0,
  ) {}

  inject(...events: TrailEvent[]): void {
    this.events.push(...events);
  }

  loadFile(file: string): number {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as TrailEvent[];
    if (!Array.isArray(list)) throw new Error(`${file}: expected a JSON array of TrailEvent`);
    this.inject(...list);
    return list.length;
  }

  clear(): void {
    this.events = [];
  }

  async lookupEvents(req: TrailLookupRequest) {
    this.calls.push(req);
    const visibleUntil = this.clock.nowMs() - this.delaySeconds * 1000;
    const start = req.startTime.getTime();
    const end = req.endTime.getTime();
    const matched = this.events
      .filter((e) => {
        const t = Date.parse(e.eventTime);
        return e.region === req.region && t >= start && t <= end && t <= visibleUntil && matches(e, req.attribute.key, req.attribute.value);
      })
      .sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime));
    const offset = req.nextToken ? Number(req.nextToken) : 0;
    const size = Math.min(req.maxResults ?? 50, 50);
    const page = matched.slice(offset, offset + size);
    return { events: page, ...(offset + size < matched.length ? { nextToken: String(offset + size) } : {}) };
  }
}

function matches(e: TrailEvent, key: TrailLookupRequest['attribute']['key'], value: string): boolean {
  switch (key) {
    case 'EventId':
      return e.eventId === value;
    case 'EventName':
      return e.eventName === value;
    case 'EventSource':
      return e.eventSource === value;
    case 'Username':
      return e.username === value;
    case 'ReadOnly':
      return String(!!e.readOnly) === value;
    case 'AccessKeyId':
      return e.accessKeyId === value;
    case 'ResourceType':
      return e.resources.some((r) => r.resourceType === value);
    case 'ResourceName':
      return e.resources.some((r) => r.resourceName === value);
  }
}
