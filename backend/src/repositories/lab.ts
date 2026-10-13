// backend/src/repositories/lab.ts —— LabMetricsStore 的落库（lab_metric_rollups、lab_host_samples）与 capability_events
// （lab_runs / lab_results / lab_origin_samples 的读写由 /lab 路由的实现者在此追加）
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
