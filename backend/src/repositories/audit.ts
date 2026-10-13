// backend/src/repositories/audit.ts —— 应用审计表 audit_log（X22；05#audit 第 1 节）
//
// - 只允许追加（迁移中的触发器拒绝 UPDATE 与保留期内的 DELETE）。
// - 哈希链：hash = sha256(prev_hash || 规范化 JSON(本行业务字段))。写入在一个事务中“读最后一行的 hash → 插入新行”：
//   SQLite 天然单写者；PostgreSQL 用 pg_advisory_xact_lock 串行化。AUDIT_HASH_CHAIN=off（篡改实验的对照）时 prev_hash 为空、
//   hash 只覆盖本行。
// - verifyAuditChain() 从头校验整条链，返回第一处断点（GET /api/admin/audit/verify）。
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { dialectOf, jsonIn, nowIso } from '../db/dialect.js';
import { decodeCursor, encodeCursor } from './users.js';

type Db = Knex | Knex.Transaction;

export type AuditActorType = 'user' | 'admin' | 'system' | 'anonymous';
export type AuditResult = 'success' | 'denied' | 'error';

export interface AuditInput {
  ts?: string;
  actorType: AuditActorType;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result: AuditResult;
  sourceIp?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  awsPrincipal?: string | null;
  /** 不得含密码、令牌、完整预签名 URL */
  details?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor_type: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  source_ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  trace_id: string | null;
  aws_principal: string | null;
  details: string | null;
  prev_hash: string | null;
  hash: string;
}

/** pg_advisory_xact_lock 的键（任意固定值，只用于 audit_log 写入的串行化） */
const AUDIT_LOCK_KEY = 0x0ca0d17;

/** 参与哈希的业务字段（顺序无关：规范化 JSON 按键名排序） */
const HASHED_FIELDS = ['ts', 'actor_type', 'actor_id', 'actor_email', 'action', 'target_type', 'target_id', 'result',
  'source_ip', 'user_agent', 'request_id', 'trace_id', 'aws_principal', 'details'] as const;

export function canonicalJson(row: Partial<Record<(typeof HASHED_FIELDS)[number], unknown>>): string {
  const obj: Record<string, unknown> = {};
  for (const k of [...HASHED_FIELDS].sort()) obj[k] = row[k] ?? null;
  return JSON.stringify(obj);
}

export function auditHash(prevHash: string | null, row: Partial<Record<(typeof HASHED_FIELDS)[number], unknown>>): string {
  return createHash('sha256').update(prevHash ?? '').update(canonicalJson(row)).digest('hex');
}

function clip(v: string | null | undefined, n: number): string | null {
  return v === undefined || v === null ? null : String(v).slice(0, n);
}

/** 追加一条审计记录（带哈希链） */
export async function appendAudit(db: Knex, input: AuditInput, opts: { hashChain?: boolean } = {}): Promise<AuditRow> {
  const business = {
    ts: input.ts ?? nowIso(),
    actor_type: input.actorType,
    actor_id: clip(input.actorId, 64),
    actor_email: clip(input.actorEmail, 320),
    action: input.action.slice(0, 64),
    target_type: clip(input.targetType, 32),
    target_id: clip(input.targetId, 128),
    result: input.result,
    source_ip: clip(input.sourceIp, 64),
    user_agent: clip(input.userAgent, 512),
    request_id: clip(input.requestId, 64),
    trace_id: clip(input.traceId, 64),
    aws_principal: clip(input.awsPrincipal, 256),
    details: input.details ? JSON.stringify(input.details) : null,
  };
  const chain = opts.hashChain !== false;
  return db.transaction(async (trx) => {
    if (chain && dialectOf(db) === 'postgres') await trx.raw('select pg_advisory_xact_lock(?)', [AUDIT_LOCK_KEY]);
    const prev = chain
      ? ((await trx('audit_log').orderBy('id', 'desc').first('hash')) as { hash?: string } | undefined)?.hash ?? null
      : null;
    const hash = auditHash(prev, business);
    const [inserted] = (await trx('audit_log').insert({ ...business, prev_hash: prev, hash }).returning('id')) as Array<{ id: number } | number>;
    const id = typeof inserted === 'object' && inserted !== null ? Number(inserted.id) : Number(inserted);
    return { id, ...business, prev_hash: prev, hash };
  });
}

export interface AuditFilter { actor?: string; action?: string; targetType?: string; targetId?: string; since?: string; until?: string; limit?: number; cursor?: string }

/** 新的在前；游标为最后一行的 `ts|id` */
export async function listAudit(db: Db, f: AuditFilter = {}): Promise<{ items: AuditRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const q = db('audit_log').select('*');
  if (f.actor) q.where((w) => w.where({ actor_id: f.actor }).orWhereRaw('lower(actor_email) = ?', [f.actor!.toLowerCase()]));
  if (f.action) {
    if (f.action.endsWith('*')) q.where('action', 'like', `${f.action.slice(0, -1)}%`);
    else q.where({ action: f.action });
  }
  if (f.targetType) q.where({ target_type: f.targetType });
  if (f.targetId) q.where({ target_id: f.targetId });
  if (f.since) q.where('ts', '>=', f.since);
  if (f.until) q.where('ts', '<=', f.until);
  const cur = decodeCursor(f.cursor);
  if (cur) q.where('id', '<', Number(cur.id));
  const rows = (await q.orderBy('id', 'desc').limit(limit + 1)) as AuditRow[];
  const items = rows.slice(0, limit).map((r) => ({ ...r, id: Number(r.id) }));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.ts, last.id) : null };
}

export function auditDetails(row: Pick<AuditRow, 'details'>): Record<string, unknown> | null {
  return jsonIn<Record<string, unknown>>(row.details, null);
}

export interface AuditVerifyResult { ok: boolean; checked: number; brokenAt: number | null; detail: string }

/** 从头校验整条链：第一行的 prev_hash 作为锚点（更早的行可能已按保留期删除），之后每行的 prev_hash 必须等于上一行的 hash */
export async function verifyAuditChain(db: Db, opts: { batch?: number } = {}): Promise<AuditVerifyResult> {
  const batch = opts.batch ?? 500;
  let lastId = 0;
  let prevHash: string | null | undefined;
  let checked = 0;
  for (;;) {
    const rows = (await db('audit_log').where('id', '>', lastId).orderBy('id').limit(batch)) as AuditRow[];
    if (!rows.length) break;
    for (const r of rows) {
      const id = Number(r.id);
      if (prevHash !== undefined && (r.prev_hash ?? null) !== prevHash) {
        return { ok: false, checked, brokenAt: id, detail: `第 ${id} 行的 prev_hash 与上一行的 hash 不一致（链被删改，或写入时关闭了哈希链）` };
      }
      const expected = auditHash(r.prev_hash ?? null, r);
      if (expected !== r.hash) {
        return { ok: false, checked, brokenAt: id, detail: `第 ${id} 行的内容与 hash 不一致（行被篡改）` };
      }
      prevHash = r.hash;
      checked += 1;
      lastId = id;
    }
  }
  return { ok: true, checked, brokenAt: null, detail: checked ? `已校验 ${checked} 行，哈希链完整` : '审计表为空' };
}

/** audit.retention：删除早于 before 的行（触发器只允许删除超过保留期的行） */
export async function deleteAuditBefore(db: Db, before: string): Promise<number> {
  return Number(await db('audit_log').where('ts', '<', before).del());
}
