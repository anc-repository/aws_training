// backend/src/adapters/monitoring/reader.ts —— MetricsPort 的只读侧（MetricsReader，05#monitoring 第 3 节）
//
// /api/lab/monitoring/*（仅管理员）与对比实验读取“告警状态、状态变化历史、曲线”：
//   - local：alert_events（本地告警评估器写入）+ lab_metric_rollups / lab_host_samples；
//   - cloudwatch：DescribeAlarms / DescribeAlarmHistory / GetMetricData（结果缓存 60 秒，避免 /lab 刷新放大 API 调用）。
// 这些是服务端证据：实验与检查以它们为准，而不是客户端看到的响应头（2026-10-14 实机验证的教训，04 §5.4）。
// 类型 SeriesQuery / AlarmView / MetricsReader 按文档应追加到 ports/metrics.ts（共享文件，由集成阶段搬移；这里先定义）。
import type { Knex } from 'knex';
import type { AwsClients } from '../aws/clients.js';
import { loadAwsPackage, withAwsRetry } from '../aws/clients.js';
import { jsonIn } from '../../db/dialect.js';
import { LogHistogram } from '../../observability/lab-metrics.js';
import type { Dims } from '../../ports/metrics.js';
import type { AlarmState, AlertRulesFile } from './alert-rules.js';
import { latestLocalStates } from './alert-evaluator.js';
import { MODULE_ALARMS } from './cloudwatch.js';
import { DIM_NAMES } from './cw-buffer.js';

export interface SeriesQuery {
  name: string;
  stat: 'avg' | 'sum' | 'max' | 'p95';
  periodSec: number;
  since: Date;
  until?: Date;
  dims?: Dims;
  source: 'local' | 'cloudwatch';
  /** cloudwatch：命名空间（默认 METRICS_CW_NAMESPACE；AWS/EC2、CWAgent 也可） */
  namespace?: string;
  /** cloudwatch：原样传入的维度（例如 InstanceId），优先于 dims */
  rawDimensions?: Array<{ Name: string; Value: string }>;
}

export interface AlarmView {
  name: string;
  state: AlarmState;
  since: string | null;
  source: 'local' | 'cloudwatch';
  /** 送达路径：local = 站内信 + EmailPort（实例宕机即失效）；sns = 告警动作 → ops-alarms 主题（实例宕机也能发出） */
  delivery: 'local' | 'sns' | 'none';
  reason?: string;
  value?: number | null;
}

export interface AlarmTransition { at: string; from: string; to: string; reason: string }

export interface MetricsReader {
  series(q: SeriesQuery): Promise<Array<{ t: number; v: number }>>;
  alarms(): Promise<AlarmView[]>;
  history(name: string, limit: number, since?: Date): Promise<AlarmTransition[]>;
}

// ------------------------------------------------------------------------------------------------ local

export class LocalMetricsReader implements MetricsReader {
  constructor(private readonly db: Knex, private readonly rules: () => AlertRulesFile) {}

  async alarms(): Promise<AlarmView[]> {
    const latest = await latestLocalStates(this.db);
    const out: AlarmView[] = [];
    for (const r of this.rules().rules) {
      const l = latest.get(r.name);
      out.push({
        name: r.name, state: l?.state ?? 'INSUFFICIENT_DATA', since: l?.ts ?? null, source: 'local', delivery: 'local',
        ...(l?.detail ? { reason: l.detail } : { reason: '本地评估器尚未评估这条规则' }), value: l?.value ?? null,
      });
    }
    return out;
  }

  async history(name: string, limit: number, since?: Date): Promise<AlarmTransition[]> {
    const q = this.db('alert_events').where({ alarm: name, source: 'local' });
    if (since) q.andWhere('ts', '>=', since.toISOString());
    const rows = (await q.orderBy('id', 'desc').limit(Math.min(Math.max(limit, 1), 200))
      .select('ts', 'state', 'detail')) as Array<{ ts: string; state: string; detail: string | null }>;
    // 每行只记录“进入的状态”：from 取时间上更早的一行
    const asc = [...rows].reverse();
    const prevRow = since
      ? ((await this.db('alert_events').where({ alarm: name, source: 'local' }).andWhere('ts', '<', since.toISOString())
        .orderBy('id', 'desc').first('state')) as { state?: string } | undefined)
      : undefined;
    let prev = prevRow?.state ?? '—';
    const out: AlarmTransition[] = [];
    for (const r of asc) {
      out.push({ at: r.ts, from: prev, to: r.state, reason: r.detail ?? '' });
      prev = r.state;
    }
    return out.reverse();
  }

  /** 本地曲线：route.count、route.5xx、route.latency（p95 / avg / max）、host.memUsedRatio、host.cpuPct、host.dataUsedPct、host.loadavg1 */
  async series(q: SeriesQuery): Promise<Array<{ t: number; v: number }>> {
    const from = q.since.toISOString();
    const to = (q.until ?? new Date()).toISOString();
    const period = Math.max(10, q.periodSec) * 1000;
    const bucket = (iso: string) => Math.floor(Date.parse(iso) / period) * period;
    if (q.name.startsWith('route.')) {
      const qb = this.db('lab_metric_rollups').where('kind', 'route').andWhere('minute', '>=', from).andWhere('minute', '<=', to);
      if (q.dims?.route) qb.andWhere('route', q.dims.route);
      const rows = (await qb.select('minute', 'count', 'errors', 'sum_ms', 'max_ms', 'hist', 'status_class')) as Array<Record<string, unknown>>;
      const groups = new Map<number, { h: LogHistogram; errors: number }>();
      for (const r of rows) {
        const t = bucket(String(r.minute));
        const g = groups.get(t) ?? { h: new LogHistogram(), errors: 0 };
        g.h.merge({ counts: jsonIn<number[]>(r.hist, []) ?? [], count: Number(r.count), sum: Number(r.sum_ms), max: Number(r.max_ms) });
        if (r.status_class === '5xx') g.errors += Number(r.count ?? 0);
        groups.set(t, g);
      }
      return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([t, g]) => {
        const v = q.name === 'route.count' ? g.h.count
          : q.name === 'route.5xx' ? g.errors
            : q.stat === 'p95' ? g.h.percentile(95) : q.stat === 'max' ? g.h.max : g.h.count ? g.h.sum / g.h.count : 0;
        return { t, v: Math.round(v * 1000) / 1000 };
      });
    }
    // host.cpuPct 是采样进程自己的 CPU；整机负载看 host.loadavg1（例如别的进程制造的 CPU 尖峰）
    const col = q.name === 'host.memUsedRatio' ? 'mem_used_ratio' : q.name === 'host.cpuPct' ? 'cpu_pct' : q.name === 'host.dataUsedPct' ? 'data_used_pct'
      : q.name === 'host.loadavg1' ? 'loadavg1' : undefined;
    if (!col) return [];
    const rows = (await this.db('lab_host_samples').where('ts', '>=', from).andWhere('ts', '<=', to).whereNotNull(col)
      .select('ts', col)) as Array<Record<string, unknown>>;
    const groups = new Map<number, { sum: number; n: number; max: number }>();
    for (const r of rows) {
      const t = bucket(String(r.ts));
      const v = Number(r[col]);
      if (!Number.isFinite(v)) continue;
      const g = groups.get(t) ?? { sum: 0, n: 0, max: -Infinity };
      g.sum += v;
      g.n += 1;
      g.max = Math.max(g.max, v);
      groups.set(t, g);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0])
      .map(([t, g]) => ({ t, v: Math.round((q.stat === 'max' ? g.max : g.sum / g.n) * 1000) / 1000 }));
  }
}

// ------------------------------------------------------------------------------------------------ cloudwatch

export interface CwReaderConfig {
  namespace: string;
  alarmPrefix: string;
  topicArn?: string;
  cacheMs?: number;
}

const STAT_MAP: Record<SeriesQuery['stat'], string> = { avg: 'Average', sum: 'Sum', max: 'Maximum', p95: 'p95' };

export class CloudWatchMetricsReader implements MetricsReader {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly aws: AwsClients, private readonly cfg: CwReaderConfig, private readonly now: () => number = () => Date.now()) {}

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < (this.cfg.cacheMs ?? 60_000)) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  async alarms(): Promise<AlarmView[]> {
    return this.cached('alarms', async () => {
      const sdk = await loadAwsPackage('@aws-sdk/client-cloudwatch', () => import('@aws-sdk/client-cloudwatch'));
      const cw = await this.aws.cloudwatch();
      const r = await withAwsRetry(() => cw.send(new sdk.DescribeAlarmsCommand({
        AlarmNamePrefix: this.cfg.alarmPrefix, AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], MaxRecords: 100,
      })), { attempts: 2, timeoutMs: 4000 });
      const own = new Set<string>(MODULE_ALARMS);
      const all = [...(r.MetricAlarms ?? []), ...(r.CompositeAlarms ?? [])];
      return all
        .map((a) => {
          const name = (a.AlarmName ?? '').slice(this.cfg.alarmPrefix.length);
          const actions = a.AlarmActions ?? [];
          const delivery: AlarmView['delivery'] = this.cfg.topicArn && actions.includes(this.cfg.topicArn) ? 'sns' : actions.some((x) => x.includes(':sns:')) ? 'sns' : 'none';
          return {
            name, state: (a.StateValue ?? 'INSUFFICIENT_DATA') as AlarmState,
            since: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : null,
            source: 'cloudwatch' as const, delivery, ...(a.StateReason ? { reason: a.StateReason } : {}),
          };
        })
        .filter((a) => own.has(a.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async history(name: string, limit: number, since?: Date): Promise<AlarmTransition[]> {
    const key = `history|${name}|${limit}|${since?.toISOString() ?? ''}`;
    return this.cached(key, async () => {
      const sdk = await loadAwsPackage('@aws-sdk/client-cloudwatch', () => import('@aws-sdk/client-cloudwatch'));
      const cw = await this.aws.cloudwatch();
      const r = await withAwsRetry(() => cw.send(new sdk.DescribeAlarmHistoryCommand({
        AlarmName: `${this.cfg.alarmPrefix}${name}`, HistoryItemType: 'StateUpdate', ScanBy: 'TimestampDescending',
        MaxRecords: Math.min(Math.max(limit, 1), 100), ...(since ? { StartDate: since } : {}),
      })), { attempts: 2, timeoutMs: 4000 });
      return (r.AlarmHistoryItems ?? []).map((h) => {
        const d = jsonIn<{ oldState?: { stateValue?: string }; newState?: { stateValue?: string; stateReason?: string } }>(h.HistoryData ?? null, {}) ?? {};
        return {
          at: h.Timestamp ? new Date(h.Timestamp).toISOString() : '',
          from: d.oldState?.stateValue ?? '?', to: d.newState?.stateValue ?? '?', reason: d.newState?.stateReason ?? h.HistorySummary ?? '',
        };
      });
    });
  }

  async series(q: SeriesQuery): Promise<Array<{ t: number; v: number }>> {
    const dims = q.rawDimensions ?? Object.entries(q.dims ?? {})
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => ({ Name: DIM_NAMES[k as keyof typeof DIM_NAMES], Value: String(v) }));
    const namespace = q.namespace ?? this.cfg.namespace;
    const key = `series|${namespace}|${q.name}|${q.stat}|${q.periodSec}|${q.since.toISOString()}|${q.until?.toISOString() ?? ''}|${JSON.stringify(dims)}`;
    return this.cached(key, async () => {
      const sdk = await loadAwsPackage('@aws-sdk/client-cloudwatch', () => import('@aws-sdk/client-cloudwatch'));
      const cw = await this.aws.cloudwatch();
      const r = await withAwsRetry(() => cw.send(new sdk.GetMetricDataCommand({
        StartTime: q.since, EndTime: q.until ?? new Date(this.now()), ScanBy: 'TimestampAscending',
        MetricDataQueries: [{
          Id: 'm1',
          MetricStat: { Metric: { Namespace: namespace, MetricName: q.name, Dimensions: dims }, Period: Math.max(60, Math.round(q.periodSec / 60) * 60), Stat: STAT_MAP[q.stat] },
        }],
      })), { attempts: 2, timeoutMs: 5000 });
      const res = r.MetricDataResults?.[0];
      const ts = res?.Timestamps ?? [];
      const vs = res?.Values ?? [];
      return ts.map((t, i) => ({ t: new Date(t).getTime(), v: Math.round((vs[i] ?? 0) * 1000) / 1000 })).sort((a, b) => a.t - b.t);
    });
  }
}
