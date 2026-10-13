/**
 * In-memory doubles for the checks / reports / certificates tests: an ItemStore with optimistic locking and GSI queries,
 * an ObjectStorePort, a real-time clock, a recording event publisher, scheduler and invoker.
 */
import type {
  ClockPort,
  EventPublisherPort,
  InvokerPort,
  LambdaFunctionName,
  ObjectStorePort,
  OneTimeScheduleRequest,
  PlatformBusEvent,
  ScheduleInfo,
  SchedulerPort,
  ScheduleGroup,
} from '@atl/shared';
import type { PrimaryKey } from '../../src/data/keys.js';
import { ConflictError, type Item, type ItemStore, type QueryOptions } from '../../src/services/progress/store.js';

export class MemoryItemStore implements ItemStore {
  readonly items = new Map<string, Item>();

  private k(key: PrimaryKey): string {
    return `${key.PK}|${key.SK}`;
  }

  async get<T extends object>(key: PrimaryKey) {
    const it = this.items.get(this.k(key));
    return it ? (structuredClone(it) as unknown as T & PrimaryKey) : null;
  }

  async put(item: Item, opts: { expectVer?: number | null } = {}) {
    const cur = this.items.get(this.k(item));
    if (opts.expectVer === null && cur) throw new ConflictError();
    if (typeof opts.expectVer === 'number' && Number(cur?.ver ?? -1) !== opts.expectVer) throw new ConflictError();
    this.items.set(this.k(item), structuredClone(JSON.parse(JSON.stringify(item))) as Item);
  }

  async query<T extends object>(pk: string, opts: QueryOptions = {}) {
    const pkName = opts.index === 'GSI1' ? 'GSI1PK' : opts.index === 'GSI2' ? 'GSI2PK' : 'PK';
    const skName = opts.index === 'GSI1' ? 'GSI1SK' : opts.index === 'GSI2' ? 'GSI2SK' : 'SK';
    let out = [...this.items.values()].filter((i) => i[pkName] === pk && (!opts.skPrefix || String(i[skName] ?? '').startsWith(opts.skPrefix)));
    out.sort((a, b) => (String(a[skName]) < String(b[skName]) ? -1 : 1));
    if (opts.ascending === false) out.reverse();
    if (opts.limit) out = out.slice(0, opts.limit);
    return out.map((i) => structuredClone(i)) as unknown as (T & PrimaryKey)[];
  }

  async delete(key: PrimaryKey) {
    this.items.delete(this.k(key));
  }

  seed(item: Item): void {
    this.items.set(this.k(item), JSON.parse(JSON.stringify({ ver: 1, ...item })) as Item);
  }
}

export class MemoryObjects implements ObjectStorePort {
  readonly objects = new Map<string, Uint8Array>();
  async put(bucket: string, key: string, body: Uint8Array | string) {
    this.objects.set(`${bucket}/${key}`, typeof body === 'string' ? new TextEncoder().encode(body) : body);
  }
  async get(bucket: string, key: string) {
    return this.objects.get(`${bucket}/${key}`) ?? null;
  }
  async delete(bucket: string, key: string) {
    this.objects.delete(`${bucket}/${key}`);
  }
  async list(bucket: string, prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1));
  }
  async presign(bucket: string, key: string) {
    return `memory://${bucket}/${key}`;
  }
  text(bucket: string, key: string): string | null {
    const b = this.objects.get(`${bucket}/${key}`);
    return b ? new TextDecoder().decode(b) : null;
  }
}

export class TestClock implements ClockPort {
  offset = 0;
  now() {
    return new Date(this.nowMs());
  }
  nowMs() {
    return Date.now() + this.offset;
  }
  advance(ms: number) {
    this.offset += ms;
  }
  sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, Math.min(ms, 50)));
  }
  setTimer(ms: number, fn: () => void) {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  }
}

export class RecordingEvents implements EventPublisherPort {
  readonly events: PlatformBusEvent[] = [];
  async publish(events: PlatformBusEvent[]) {
    this.events.push(...events);
  }
  types(): string[] {
    return this.events.map((e) => e.detailType);
  }
}

export class RecordingScheduler implements SchedulerPort {
  readonly created: OneTimeScheduleRequest[] = [];
  readonly deleted: string[] = [];
  async createOneTime(req: OneTimeScheduleRequest) {
    this.created.push(req);
    return { created: true };
  }
  async delete(name: string) {
    this.deleted.push(name);
  }
  async get(_name: string, _group: ScheduleGroup): Promise<ScheduleInfo | null> {
    return null;
  }
  async setSweeperEnabled() {}
}

export class TableInvoker implements InvokerPort {
  readonly calls: { fn: LambdaFunctionName; payload: unknown; async: boolean }[] = [];
  constructor(readonly handlers: Partial<Record<LambdaFunctionName, (payload: unknown) => Promise<unknown>>> = {}) {}
  async invoke<T>(fn: LambdaFunctionName, payload: unknown): Promise<T> {
    this.calls.push({ fn, payload, async: false });
    const h = this.handlers[fn];
    if (!h) throw new Error(`no handler for ${fn}`);
    return (await h(payload)) as T;
  }
  async invokeAsync(fn: LambdaFunctionName, payload: unknown): Promise<void> {
    this.calls.push({ fn, payload, async: true });
  }
}
