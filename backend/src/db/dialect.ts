// backend/src/db/dialect.ts —— SQLite 与 PostgreSQL 的方言差异集中在这里（总纲 §4.3）
//
// 约定（迁移脚本与仓储层共同遵守，保证双方言行为一致、模块切换不改写业务数据）：
//   - 时间一律存 ISO 8601 UTC 字符串（TEXT / varchar(32)），字典序 = 时间序；用 nowIso() 生成；
//   - JSON 列用 t.jsonb()（PostgreSQL jsonb、SQLite 文本），写入 jsonOut()，读取 jsonIn()；
//   - 布尔列读取用 boolIn()（SQLite 返回 0/1）；聚合计数用 countOf()（pg 返回字符串）；
//   - 只存逻辑键（存储键、内部用户 ID），不存 URL、桶名、绝对路径（原则 7）。
import type { Knex } from 'knex';

export type Dialect = 'sqlite' | 'postgres';

export function dialectOf(db: Knex): Dialect {
  const client = String((db.client as { config?: { client?: unknown } }).config?.client ?? '');
  return client === 'pg' || client === 'postgres' || client === 'postgresql' ? 'postgres' : 'sqlite';
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function jsonOut(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

export function jsonIn<T>(v: unknown, fallback: T | null = null): T | null {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}

export function boolIn(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/** count(*) 的结果：pg 返回字符串，better-sqlite3 返回数字 */
export function countOf(row: unknown, key = 'count'): number {
  if (!row || typeof row !== 'object') return 0;
  const v = (row as Record<string, unknown>)[key] ?? Object.values(row as Record<string, unknown>)[0];
  return Number(v ?? 0);
}

/** 不区分大小写的 LIKE：pg 用 ILIKE，SQLite 的 LIKE 对 ASCII 本来就不区分大小写 */
export function whereILike(qb: Knex.QueryBuilder, db: Knex, column: string, pattern: string): Knex.QueryBuilder {
  return dialectOf(db) === 'postgres' ? qb.whereILike(column, pattern) : qb.whereRaw('lower(??) like lower(?)', [column, pattern]);
}

/** 唯一约束冲突（SQLite SQLITE_CONSTRAINT_UNIQUE / PRIMARYKEY，pg 23505） */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; errno?: number };
  return err?.code === '23505' || err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/** INSERT … ON CONFLICT (cols) DO NOTHING，返回实际插入的行数（两种方言都支持 onConflict().ignore()） */
export async function insertIgnore(db: Knex | Knex.Transaction, table: string, rows: Record<string, unknown> | Array<Record<string, unknown>>,
  conflict: string[]): Promise<number> {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return 0;
  const res = (await db(table).insert(list).onConflict(conflict).ignore()) as unknown;
  // better-sqlite3 返回 [lastInsertRowid]，pg 返回 { rowCount }；统一用 changes 近似
  if (Array.isArray(res)) return res.length ? list.length : 0;
  return Number((res as { rowCount?: number })?.rowCount ?? 0);
}

/** INSERT … ON CONFLICT (cols) DO UPDATE SET … */
export async function upsert(db: Knex | Knex.Transaction, table: string, row: Record<string, unknown>, conflict: string[],
  merge?: string[]): Promise<void> {
  const q = db(table).insert(row).onConflict(conflict);
  await (merge ? q.merge(merge) : q.merge());
}
