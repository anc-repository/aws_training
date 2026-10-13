/**
 * `AuditEvent` (01 §7.2 `AUDIT#<yyyy-mm> / <ulid>`, GSI1 `AUDIT#SESSION#<sid>`; §8.5 actions; AP18, AP19) and
 * `IdempotencyRecord` (`IDEMP#<sub>#<key> / META`, TTL 24 h, 01 §7.5 item 3).
 */
import { auditMonth, type AuditAction } from '@atl/shared';
import { Gsi1, Keys, ttlAfterHours, TTL_POLICY } from '../data/keys.js';
import { isConditionFailed, type Item, type Table } from './table.js';
import type { MonotonicUlid } from './events.js';

export interface AuditInput {
  action: AuditAction | 'access.denied';
  actor: { sub: string | null; role: string; via: 'web' | 'agent' | 'internal' | 'system' };
  target?: string | null;
  sessionId?: string | null;
  result: 'ok' | 'denied' | 'error';
  sourceIp?: string | null;
  userAgentHash?: string | null;
  details?: Record<string, unknown>;
}

export class AuditRepo {
  constructor(
    private readonly table: Table,
    private readonly ulids: MonotonicUlid,
    private readonly retentionDays: number = TTL_POLICY.auditRetentionDaysDefault,
  ) {}

  async write(a: AuditInput, nowMs: number): Promise<Item> {
    const at = new Date(nowMs).toISOString();
    const id = this.ulids.next(nowMs);
    const item: Item = {
      ...Keys.auditEvent(at, id),
      ...(a.sessionId ? Gsi1.auditEvent(a.sessionId, id) : {}),
      type: 'AuditEvent',
      ver: 1,
      createdAt: at,
      updatedAt: at,
      auditId: id,
      at,
      action: a.action,
      actor: a.actor,
      target: a.target ?? null,
      sessionId: a.sessionId ?? null,
      result: a.result,
      sourceIp: a.sourceIp ?? null,
      userAgentHash: a.userAgentHash ?? null,
      details: a.details ?? {},
      ttl: ttlAfterHours(at, this.retentionDays * 24),
    };
    await this.table.put(item);
    return item;
  }

  /** AP18. */
  async bySession(sid: string, limit = 200): Promise<Item[]> {
    return (await this.table.query({ index: 'GSI1', pk: Gsi1.auditEvent(sid, 'x').GSI1PK, descending: true, limit })).items;
  }

  /** AP19: one month, optionally bounded by ISO times. */
  async byMonth(month: string, opts: { from?: string; to?: string; limit?: number } = {}): Promise<Item[]> {
    const pk = Keys.auditEvent(`${month}-01T00:00:00.000Z`, 'x').PK;
    const items = await this.table.queryAll({ pk, descending: true }, opts.limit ?? 500);
    return items.filter((i) => (!opts.from || String(i.at) >= opts.from) && (!opts.to || String(i.at) <= opts.to));
  }
}

/** Months (`yyyy-mm`, newest first) covered by [from, to], at most `max`. */
export function monthsBetween(from: string, to: string, max = 13): string[] {
  const out: string[] = [];
  const end = new Date(to);
  const start = new Date(from);
  let y = end.getUTCFullYear();
  let m = end.getUTCMonth();
  while (out.length < max) {
    const d = new Date(Date.UTC(y, m, 1));
    if (d.getTime() < Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)) break;
    out.push(auditMonth(d));
    m--;
    if (m < 0) {
      m = 11;
      y--;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// IdempotencyRecord

export interface StoredResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type IdempotencyItem = Item & {
  routeId: string;
  requestHash: string;
  status: 'IN_PROGRESS' | 'COMPLETE';
  response?: StoredResponse;
  expiresAt: string;
};

export type ReserveResult = { kind: 'reserved' } | { kind: 'existing'; record: IdempotencyItem };

export class IdempotencyRepo {
  constructor(private readonly table: Table) {}

  /**
   * Reserve `(scope, key)` for this request. Succeeds when no live record exists (an expired record — TTL may not
   * have removed it yet — counts as absent); otherwise returns the existing record.
   */
  async reserve(scope: string, key: string, routeId: string, requestHash: string, nowMs: number): Promise<ReserveResult> {
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + TTL_POLICY.idempotencyHours * 3600_000).toISOString();
    try {
      await this.table.put(
        {
          ...Keys.idempotencyRecord(scope, key),
          type: 'IdempotencyRecord',
          ver: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
          routeId,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt,
          ttl: ttlAfterHours(nowIso, TTL_POLICY.idempotencyHours),
        },
        { expression: 'attribute_not_exists(PK) OR expiresAt < :now', values: { ':now': nowIso } },
      );
      return { kind: 'reserved' };
    } catch (e) {
      if (!isConditionFailed(e)) throw e;
      const record = await this.table.get<IdempotencyItem>(Keys.idempotencyRecord(scope, key), true);
      if (!record) return this.reserve(scope, key, routeId, requestHash, nowMs);
      return { kind: 'existing', record };
    }
  }

  async complete(scope: string, key: string, response: StoredResponse, nowMs: number): Promise<void> {
    await this.table.update(Keys.idempotencyRecord(scope, key), {
      set: { status: 'COMPLETE', response, updatedAt: new Date(nowMs).toISOString() },
    });
  }

  async release(scope: string, key: string): Promise<void> {
    await this.table.delete(Keys.idempotencyRecord(scope, key), { expression: '#st = :ip', names: { '#st': 'status' }, values: { ':ip': 'IN_PROGRESS' } }).catch(() => undefined);
  }
}
