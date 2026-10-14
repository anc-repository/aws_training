// backend/src/adapters/monitoring/emf.ts —— METRICS_CW_MODE=emf：以 CloudWatch Embedded Metric Format 发给本机 Agent
//
// 05#monitoring 第 2 节：同样的数据以 EMF 格式发到本机 CloudWatch Agent（METRICS_CW_EMF_ENDPOINT，默认 tcp://127.0.0.1:25888），
// 由 CloudWatch Logs 从日志中抽取指标（日志组 /cloudalbum/<env>/metrics-emf）。好处是 requestId 这类高基数字段可以作为
// **属性**留在日志里供 Logs Insights 检索（它们不是维度，不产生额外的自定义指标）；代价是多一份日志摄取费。
// 端点必须显式配置，不依赖库的环境自动探测（文档第 9 节）。这里不引入 aws-embedded-metrics 包：EMF 只是一行 JSON，
// 按规范直接拼装（_aws.Timestamp / CloudWatchMetrics[].Namespace / Dimensions / Metrics），每行一个文档，经 TCP 写给 Agent。
import { connect } from 'node:net';
import type { CwDimension, CwUnit, MetricDatumLike } from './cw-buffer.js';

/** 一个 EMF 文档中单个指标数组的取值上限（以官方 EMF 规范为准） */
export const EMF_MAX_VALUES = 100;

export interface EmfDirective {
  Namespace: string;
  Dimensions: string[][];
  Metrics: Array<{ Name: string; Unit: CwUnit }>;
}

export interface EmfDocument {
  _aws: { Timestamp: number; LogGroupName?: string; CloudWatchMetrics: EmfDirective[] };
  [key: string]: unknown;
}

export interface EmfContext {
  namespace: string;
  /** /cloudalbum/<env>/metrics-emf（Agent 按 _aws.LogGroupName 写入，模板创建该日志组并设置保留期） */
  logGroupName: string;
}

/** 一条请求一个文档：Requests、Http5xx、Latency（总量与按 Route 各一份）；requestId 等作为属性 */
export function requestDocument(ctx: EmfContext, r: {
  ts: number; route: string; status: number; totalMs: number; requestId?: string; method?: string; pathSig?: string; runId?: string;
}): EmfDocument {
  return {
    _aws: {
      Timestamp: r.ts, LogGroupName: ctx.logGroupName,
      CloudWatchMetrics: [
        { Namespace: ctx.namespace, Dimensions: [[]], Metrics: [{ Name: 'Requests', Unit: 'Count' }, { Name: 'Http5xx', Unit: 'Count' }, { Name: 'Latency', Unit: 'Milliseconds' }] },
        { Namespace: ctx.namespace, Dimensions: [['Route']], Metrics: [{ Name: 'Requests', Unit: 'Count' }, { Name: 'Http5xx', Unit: 'Count' }, { Name: 'Latency', Unit: 'Milliseconds' }] },
      ],
    },
    Route: r.route,
    Requests: 1,
    Http5xx: r.status >= 500 ? 1 : 0,
    Latency: Math.round(r.totalMs * 1000) / 1000,
    // 以下是属性（不是维度）：可在 Logs Insights 中检索，不产生自定义指标
    status: r.status,
    ...(r.requestId ? { requestId: r.requestId } : {}),
    ...(r.method ? { method: r.method } : {}),
    ...(r.pathSig ? { pathSig: r.pathSig } : {}),
    ...(r.runId ? { runId: r.runId } : {}),
  };
}

/** 聚合后的 datum → EMF 文档（分布按次数展开为取值数组，超过上限时按比例抽样） */
export function datumDocument(ctx: EmfContext, d: MetricDatumLike, extra: Record<string, unknown> = {}): EmfDocument {
  const dims: CwDimension[] = d.Dimensions ?? [];
  let value: number | number[];
  if (d.Value !== undefined) value = d.Value;
  else {
    const expanded: number[] = [];
    const total = (d.Counts ?? []).reduce((a, b) => a + b, 0);
    const scale = total > EMF_MAX_VALUES ? EMF_MAX_VALUES / total : 1;
    (d.Values ?? []).forEach((v, i) => {
      const n = Math.max(1, Math.round((d.Counts?.[i] ?? 1) * scale));
      for (let k = 0; k < n && expanded.length < EMF_MAX_VALUES; k += 1) expanded.push(v);
    });
    value = expanded.length === 1 ? expanded[0]! : expanded;
  }
  const doc: EmfDocument = {
    _aws: {
      Timestamp: d.Timestamp.getTime(), LogGroupName: ctx.logGroupName,
      CloudWatchMetrics: [{ Namespace: ctx.namespace, Dimensions: [dims.map((x) => x.Name)], Metrics: [{ Name: d.MetricName, Unit: d.Unit }] }],
    },
    [d.MetricName]: value,
    ...extra,
  };
  for (const x of dims) doc[x.Name] = x.Value;
  return doc;
}

export interface EmfSink {
  /** 写入若干行（每行一个 JSON 文档）；失败时抛出 */
  write(lines: readonly string[]): Promise<void>;
  readonly endpoint: string;
}

/** tcp://host:port → TCP 连接，按换行分隔写入后关闭（Agent 的 EMF 监听器同时支持 TCP 与 UDP，这里只用 TCP） */
export function tcpEmfSink(endpoint: string, timeoutMs = 3000): EmfSink {
  const m = /^tcp:\/\/([^:/]+):(\d{1,5})\/?$/.exec(endpoint.trim());
  if (!m) throw new Error(`METRICS_CW_EMF_ENDPOINT 必须形如 tcp://127.0.0.1:25888（当前：${endpoint || '空'}）`);
  const host = m[1]!;
  const port = Number(m[2]);
  return {
    endpoint,
    write(lines) {
      if (!lines.length) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const socket = connect({ host, port });
        let settled = false;
        const done = (err?: Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (err) reject(err);
          else resolve();
        };
        socket.setTimeout(timeoutMs, () => done(Object.assign(new Error(`EMF 端点 ${endpoint} 超时`), { name: 'TimeoutError' })));
        socket.once('error', (e) => done(e));
        socket.once('connect', () => {
          socket.end(`${lines.join('\n')}\n`, () => done());
        });
      });
    },
  };
}
