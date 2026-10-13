// backend/src/repositories/lab.ts —— LabMetricsStore 的落库（lab_metric_rollups、lab_host_samples）与 capability_events
// 以及 lab_runs / lab_results / lab_origin_samples 的读写（/api/lab/*）
import type { Knex } from 'knex';
import type { CapabilityTransitionEvent } from '@cloudalbum/contracts';
import { jsonIn, jsonOut } from '../db/dialect.js';
import { LogHistogram, type HostSample, type LabMetricsSink, type MetricRollup } from '../observability/lab-metrics.js';

export async function insertRollups(db: Knex, rows: readonly MetricRollup[]): Promise<void> {
  if (!rows.length) return;
  const mapped = rows.map((r) => ({
    minute: r.minute, granularity: 'minute', instance_id: r.instanceId, role: r.role, kind: r.kind,
    route: r.route ?? null, method: r.method ?? null, path_sig: r.pathSig ?? null,
    module: r.module ?? null, driver: r.driver ?? null, op: r.op ?? null,
    run_id: r.runId ?? null, label: r.label ?? null,
    count: r.count, errors: r.errors, sum_ms: r.sumMs, max_ms: r.maxMs, hist: jsonOut(r.hist),
  }));
  // SQLite 单条语句的变量数有上限：分批插入
  for (let i = 0; i < mapped.length; i += 50) await db('lab_metric_rollups').insert(mapped.slice(i, i + 50));
}

export async function insertHostSamples(db: Knex, rows: readonly HostSample[]): Promise<void> {
  if (!rows.length) return;
  const mapped = rows.map((s) => ({
    ts: s.ts, instance_id: s.instanceId, role: s.role, pid: s.pid, cpu_pct: s.cpuPct, rss_bytes: s.rssBytes,
    heap_used_bytes: s.heapUsedBytes, event_loop_delay_p99_ms: s.eventLoopDelayP99Ms, loadavg1: s.loadavg1,
    steal_pct: s.stealPct ?? null, mem_used_ratio: s.memUsedRatio, net_rx_bytes: s.netRxBytes ?? null,
    net_tx_bytes: s.netTxBytes ?? null, data_used_pct: s.dataUsedPct ?? null,
  }));
  for (let i = 0; i < mapped.length; i += 50) await db('lab_host_samples').insert(mapped.slice(i, i + 50));
}

/** LabMetricsStore → 数据库的 sink（container 装配） */
export function labMetricsDbSink(db: Knex): LabMetricsSink {
  return {
    writeRollups: (rows) => insertRollups(db, rows),
    writeHostSamples: (rows) => insertHostSamples(db, rows),
  };
}

export interface RollupQuery {
  from?: string;
  to?: string;
  kind?: 'route' | 'port';
  route?: string;
  runId?: string;
  groupBy?: 'path' | 'driver' | 'instance' | 'route';
}

export interface RollupSummary {
  group: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
}

/** GET /api/lab/metrics 的核心查询：合并直方图后计算百分位 */
export async function queryRollups(db: Knex, q: RollupQuery): Promise<RollupSummary[]> {
  const qb = db('lab_metric_rollups').select('*');
  if (q.from) qb.where('minute', '>=', q.from);
  if (q.to) qb.where('minute', '<=', q.to);
  if (q.kind) qb.where('kind', q.kind);
  if (q.route) qb.where('route', q.route);
  if (q.runId) qb.where('run_id', q.runId);
  const rows = (await qb) as Array<Record<string, unknown>>;
  const groups = new Map<string, { h: LogHistogram; errors: number }>();
  for (const r of rows) {
    const key = (() => {
      switch (q.groupBy) {
        case 'driver': return `${String(r.module ?? r.route)}:${String(r.driver ?? '')}`;
        case 'instance': return String(r.instance_id);
        case 'route': return `${String(r.method ?? '')} ${String(r.route ?? r.module ?? '')}`;
        default: return `${String(r.method ?? '')} ${String(r.route ?? `${String(r.module)}.${String(r.op)}`)} | ${String(r.path_sig ?? r.driver ?? '')}`;
      }
    })();
    const g = groups.get(key) ?? { h: new LogHistogram(), errors: 0 };
    g.h.merge({ counts: jsonIn<number[]>(r.hist, []) ?? [], count: Number(r.count), sum: Number(r.sum_ms), max: Number(r.max_ms) });
    g.errors += Number(r.errors ?? 0);
    groups.set(key, g);
  }
  return [...groups.entries()].map(([group, { h, errors }]) => ({
    group, count: h.count, errors, p50: h.percentile(50), p95: h.percentile(95), p99: h.percentile(99), max: h.max,
    avg: h.count ? h.sum / h.count : 0,
  }));
}

export async function insertCapabilityEvent(db: Knex, e: CapabilityTransitionEvent & { role?: string }): Promise<void> {
  await db('capability_events').insert({
    ts: e.at, module: e.module, field: e.field, from_status: e.from, to_status: e.to,
    detail: e.detail, instance_id: e.instanceId ?? null, role: e.role ?? null,
  });
}

// ------------------------------------------------------------------------------------------------
// lab_runs / lab_results / lab_origin_samples / lab_host_samples / capability_events 的读取（/api/lab/*，§8.2）
// ------------------------------------------------------------------------------------------------

export interface LabRunRow {
  run_id: string;
  module: string;
  experiment: string;
  label: string;
  started_at: string;
  finished_at: string | null;
  created_by: string | null;
  params: unknown;
  forced: boolean | number;
  notes: string | null;
}

export async function insertLabRun(db: Knex, input: {
  runId: string; module: string; experiment: string; label: string; startedAt?: string; createdBy?: string | null;
  params?: Record<string, unknown> | null; forced?: boolean; notes?: string | null;
}): Promise<LabRunRow> {
  const row = {
    run_id: input.runId, module: input.module, experiment: input.experiment, label: input.label,
    started_at: input.startedAt ?? new Date().toISOString(), finished_at: null, created_by: input.createdBy ?? null,
    params: jsonOut(input.params ?? null), forced: input.forced ?? false, notes: input.notes ?? null,
  };
  await db('lab_runs').insert(row);
  return { ...row, params: input.params ?? null };
}

export async function finishLabRun(db: Knex, runId: string, at: string = new Date().toISOString(), notes?: string): Promise<boolean> {
  const n = await db('lab_runs').where({ run_id: runId }).update({ finished_at: at, ...(notes !== undefined ? { notes } : {}) });
  return Number(n) > 0;
}

export async function getLabRun(db: Knex, runId: string): Promise<LabRunRow | undefined> {
  const row = (await db('lab_runs').where({ run_id: runId }).first()) as LabRunRow | undefined;
  return row ? { ...row, params: jsonIn(row.params, null) } : undefined;
}

export async function listLabRuns(db: Knex, f: { module?: string; limit?: number } = {}): Promise<LabRunRow[]> {
  const q = db('lab_runs').orderBy('started_at', 'desc').limit(Math.min(Math.max(f.limit ?? 50, 1), 500));
  if (f.module) q.where({ module: f.module });
  return ((await q) as LabRunRow[]).map((r) => ({ ...r, params: jsonIn(r.params, null) }));
}

export interface LabResultRow {
  run_id: string;
  module: string;
  experiment: string;
  label: string;
  started_at: string;
  finished_at: string;
  forced: boolean | number;
  result: unknown;
  uploaded_at: string;
}

/** POST /api/lab/results：同一 runId 重复上传时覆盖（幂等） */
export async function upsertLabResult(db: Knex, input: {
  runId: string; module: string; experiment: string; label: string; startedAt: string; finishedAt: string; forced: boolean; result: unknown;
}): Promise<void> {
  await db('lab_results').where({ run_id: input.runId }).del();
  await db('lab_results').insert({
    run_id: input.runId, module: input.module, experiment: input.experiment, label: input.label, started_at: input.startedAt,
    finished_at: input.finishedAt, forced: input.forced, result: jsonOut(input.result), uploaded_at: new Date().toISOString(),
  });
}

export async function listLabResults(db: Knex, f: { module?: string; experiment?: string; label?: string; limit?: number; withResult?: boolean } = {}): Promise<LabResultRow[]> {
  const cols = f.withResult ? ['*'] : ['run_id', 'module', 'experiment', 'label', 'started_at', 'finished_at', 'forced', 'uploaded_at'];
  const q = db('lab_results').select(cols).orderBy('started_at', 'desc').limit(Math.min(Math.max(f.limit ?? 50, 1), 500));
  if (f.module) q.where({ module: f.module });
  if (f.experiment) q.where({ experiment: f.experiment });
  if (f.label) q.where({ label: f.label });
  return ((await q) as LabResultRow[]).map((r) => ({ ...r, result: f.withResult ? jsonIn(r.result, null) : undefined }));
}

export async function getLabResult(db: Knex, runId: string): Promise<LabResultRow | undefined> {
  const row = (await db('lab_results').where({ run_id: runId }).first()) as LabResultRow | undefined;
  return row ? { ...row, result: jsonIn(row.result, null) } : undefined;
}

export async function queryHostSamples(db: Knex, f: { from?: string; to?: string; instanceId?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
  const q = db('lab_host_samples').orderBy('ts', 'desc').limit(Math.min(Math.max(f.limit ?? 360, 1), 5000));
  if (f.from) q.where('ts', '>=', f.from);
  if (f.to) q.where('ts', '<=', f.to);
  if (f.instanceId) q.where({ instance_id: f.instanceId });
  return (await q) as Array<Record<string, unknown>>;
}

export async function queryOriginSamples(db: Knex, f: { from?: string; to?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
  const q = db('lab_origin_samples').orderBy('minute', 'desc').limit(Math.min(Math.max(f.limit ?? 360, 1), 5000));
  if (f.from) q.where('minute', '>=', f.from);
  if (f.to) q.where('minute', '<=', f.to);
  return (await q) as Array<Record<string, unknown>>;
}

export async function listCapabilityEvents(db: Knex, f: { module?: string; since?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
  const q = db('capability_events').orderBy('id', 'desc').limit(Math.min(Math.max(f.limit ?? 200, 1), 2000));
  if (f.module) q.where({ module: f.module });
  if (f.since) q.where('ts', '>=', f.since);
  return ((await q) as Array<Record<string, unknown>>).map((r) => ({ ...r, id: Number(r.id) }));
}

// ------------------------------------------------------------------------------------------------
// lab.compact（定时任务，jobs/schedule.ts）：把 before 之前的分钟级汇总压缩为小时级
// ------------------------------------------------------------------------------------------------

type RollupRow = Record<string, unknown>;

const GROUP_COLS = ['instance_id', 'role', 'kind', 'route', 'method', 'path_sig', 'module', 'driver', 'op', 'run_id', 'label'] as const;

function hourOf(minute: string): string {
  return `${minute.slice(0, 13)}:00:00.000Z`;
}

/**
 * 同一小时、同一维度（实例、角色、路由 / 端口、实验 runId 与标签）的分钟行合并为一行 granularity=hour：
 * count / errors / sum_ms 相加，max_ms 取最大，直方图逐桶相加。每批最多 batchSize 行，在事务内“插入小时行 + 删除分钟行”。
 * 返回压缩掉的分钟行数与写入的小时行数。
 */
export async function compactRollups(db: Knex, before: Date, opts: { batchSize?: number } = {}): Promise<{ minuteRows: number; hourRows: number }> {
  const cutoff = before.toISOString();
  const batchSize = opts.batchSize ?? 5000;
  let minuteRows = 0;
  let hourRows = 0;
  for (;;) {
    const rows = (await db('lab_metric_rollups')
      .where('granularity', 'minute').andWhere('minute', '<', cutoff)
      .orderBy('id', 'asc').limit(batchSize)) as RollupRow[];
    if (!rows.length) break;
    const groups = new Map<string, { base: RollupRow; count: number; errors: number; sum: number; max: number; hist: number[] }>();
    for (const r of rows) {
      const hour = hourOf(String(r.minute));
      const key = JSON.stringify([hour, ...GROUP_COLS.map((c) => r[c] ?? null)]);
      const hist = jsonIn<number[]>(r.hist, []) ?? [];
      let g = groups.get(key);
      if (!g) {
        g = { base: { ...Object.fromEntries(GROUP_COLS.map((c) => [c, r[c] ?? null])), minute: hour }, count: 0, errors: 0, sum: 0, max: 0, hist: [] };
        groups.set(key, g);
      }
      g.count += Number(r.count ?? 0);
      g.errors += Number(r.errors ?? 0);
      g.sum += Number(r.sum_ms ?? 0);
      g.max = Math.max(g.max, Number(r.max_ms ?? 0));
      hist.forEach((n, i) => { g!.hist[i] = (g!.hist[i] ?? 0) + Number(n ?? 0); });
    }
    const inserts = [...groups.values()].map((g) => ({
      ...g.base, granularity: 'hour', count: g.count, errors: g.errors, sum_ms: g.sum, max_ms: g.max,
      hist: jsonOut(Array.from(g.hist, (n) => n ?? 0)),
    }));
    const ids = rows.map((r) => r.id as number | string);
    await db.transaction(async (trx) => {
      for (let i = 0; i < inserts.length; i += 50) await trx('lab_metric_rollups').insert(inserts.slice(i, i + 50));
      for (let i = 0; i < ids.length; i += 500) await trx('lab_metric_rollups').whereIn('id', ids.slice(i, i + 500)).del();
    });
    minuteRows += rows.length;
    hourRows += inserts.length;
    if (rows.length < batchSize) break;
  }
  return { minuteRows, hourRows };
}
