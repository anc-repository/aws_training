/**
 * experiments/_lib/metrics.ts —— 指标键 → 结果 JSON 中的数值（experiment.json 的 metrics / expect 与报告共用）。
 *
 * 支持的写法（兼容总纲 §8.2 示例）：
 *   client.http_req_duration{route:/api/photos/complete}.p95   客户端某路由的分位数（路由按模板宽松匹配，可带方法）
 *   client.http_req_duration.p95                               全部请求
 *   client.route.<METHOD route>.<p50|p95|p99|max|mean|errors|count|ttfbP95>
 *   client.timing.<module>.<p50|p95|mean|calls|calls_per_request>   Server-Timing（客户端观测）
 *   client.outcome_ratio.<module>.<子串>                        路径头中该模块段含子串的比例（如 cache 的 hit）
 *   client.<errors|requests|error_rate|rps>
 *   server.route.<route>.<stat>   server.port.<module>.dur.<pNN>   server.port.<module>.<calls|errors>   server.origin.<field>
 *   host.<snake>[.<stat>]    → server.host 的驼峰键（host.cpu.p95 → cpuP95，host.net_rx_bytes → netRxBytes）
 *   biz.<snake>[.<stat>]     → server.business（biz.photo_time_to_ready.p95 → photoTimeToReadyP95，biz.jobs_lost → jobsLost）
 *   scenario.<路径>          → scenario.findings（布尔值记为 1 / 0）
 * 其余按点号路径直接取值。`--repeat N` 的结果对 client.* / biz.* 取各轮中位数并给出最小～最大。
 */
import type { ClientSlice, LatencyStats, ResultDoc } from './types.js';
import { getPath, isRecord, median, toCamel } from './util.js';

export interface MetricValue {
  value?: number;
  min?: number;
  max?: number;
  /** 参与计算的轮数 */
  n?: number;
}

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i;

export function normRoute(s: string): { method?: string; path: string } {
  let t = s.trim();
  const m = METHOD_RE.exec(t);
  const method = m ? m[1]!.toUpperCase() : undefined;
  if (m) t = t.slice(m[0].length);
  t = t.split('|')[0]!.trim().split('?')[0]!;
  const path = t.split('/').filter((seg) => seg && !seg.startsWith(':')).join('/').toLowerCase();
  return method ? { method, path: `/${path}` } : { path: `/${path}` };
}

/** 在 `{ "POST /api/photos/:id/complete": … }` 中按宽松规则找路由的键（多个候选时取样本最多的）。 */
export function findRouteKey<T extends { count?: number }>(table: Record<string, T> | undefined, query: string): string | undefined {
  if (!table) return undefined;
  if (table[query]) return query;
  const q = normRoute(query);
  const candidates = Object.entries(table).filter(([k]) => {
    const n = normRoute(k);
    return n.path === q.path && (!q.method || !n.method || n.method === q.method);
  });
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0));
  return candidates[0]![0];
}

export function findRoute<T extends { count?: number }>(table: Record<string, T> | undefined, query: string): T | undefined {
  const k = findRouteKey(table, query);
  return k === undefined ? undefined : table![k];
}

function num(v: unknown): number | undefined {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function latencyStat(s: LatencyStats | undefined, stat: string): number | undefined {
  if (!s) return undefined;
  const key = stat === 'avg' ? 'mean' : stat === 'ttfb_p95' ? 'ttfbP95' : stat === 'ttfb_p50' ? 'ttfbP50' : stat;
  return num((s as unknown as Record<string, unknown>)[key]);
}

/** 只依赖 client 段的指标（--repeat 时逐轮计算）。 */
export function resolveClientMetric(client: ClientSlice | undefined, key: string): number | undefined {
  if (!client) return undefined;
  const rest = key.slice('client.'.length);
  const http = /^http_req_duration(?:\{route:([^}]+)\})?\.(\w+)$/.exec(rest);
  if (http) {
    const [, route, stat] = http;
    if (route) return latencyStat(findRoute(client.latencyMs, route), stat!);
    const all = Object.values(client.latencyMs ?? {});
    if (!all.length) return undefined;
    // 全部请求：按请求数加权近似（各路由的分位数无法精确合并）
    if (stat === 'count') return all.reduce((a, s) => a + s.count, 0);
    const top = [...all].sort((a, b) => b.count - a.count)[0];
    return latencyStat(top, stat!);
  }
  if (rest.startsWith('route.')) {
    const body = rest.slice('route.'.length);
    const dot = body.lastIndexOf('.');
    if (dot <= 0) return undefined;
    return latencyStat(findRoute(client.latencyMs, body.slice(0, dot)), body.slice(dot + 1));
  }
  if (rest.startsWith('timing.') || rest.startsWith('server_timing.')) {
    const parts = rest.split('.');
    const name = parts[1]!;
    const stat = toCamel(parts.slice(2).join('_') || 'p95');
    if (!client.serverTiming) return undefined;
    const t = client.serverTiming[name];
    // 有 Server-Timing 但没有该模块项 = 本次请求没有调用该端口
    if (!t) return stat === 'calls' || stat === 'callsPerRequest' ? 0 : undefined;
    return num((t as unknown as Record<string, unknown>)[stat]);
  }
  if (rest.startsWith('outcome_ratio.')) {
    const [, module, needle] = rest.split('.');
    const o = client.outcomes?.[module!];
    if (!o) return undefined;
    const total = Object.values(o).reduce((a, b) => a + b, 0);
    const hit = Object.entries(o).filter(([k]) => k.includes(needle ?? '')).reduce((a, [, v]) => a + v, 0);
    return total ? hit / total : undefined;
  }
  const flat: Record<string, unknown> = { errors: client.errors, requests: client.requests, error_rate: client.errorRate, errorRate: client.errorRate };
  if (rest in flat) return num(flat[rest]) ?? (rest.startsWith('error') ? 0 : undefined);
  return num(getPath(client, rest));
}

function resolveBusiness(business: Record<string, number> | undefined, key: string): number | undefined {
  if (!business) return undefined;
  const rest = key.slice('biz.'.length);
  return num(business[toCamel(rest.replace(/\./g, '_'))]) ?? num(business[rest]);
}

function resolveSingle(doc: ResultDoc, key: string): number | undefined {
  if (key.startsWith('client.')) {
    const v = resolveClientMetric(doc.client, key);
    if (v !== undefined) return v;
    const rest = key.slice('client.'.length);
    return num(getPath(doc.client, rest));
  }
  if (key.startsWith('biz.')) return resolveBusiness(doc.server?.business, key);
  if (key.startsWith('host.')) {
    const rest = key.slice('host.'.length);
    const host = doc.server?.host as unknown as Record<string, unknown> | undefined;
    return num(host?.[toCamel(rest.replace(/\./g, '_'))]) ?? num(getPath(host, rest));
  }
  if (key.startsWith('server.route.')) {
    const body = key.slice('server.route.'.length);
    const dot = body.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const s = findRoute(doc.server?.routes, body.slice(0, dot));
    return s ? num((s as unknown as Record<string, unknown>)[body.slice(dot + 1)]) : undefined;
  }
  if (key.startsWith('server.port.')) {
    const parts = key.slice('server.port.'.length).split('.');
    const p = doc.server?.ports?.[parts[0]!];
    if (!p) return parts[1] === 'calls' ? 0 : undefined;
    const stat = parts[1] === 'dur' ? parts[2] ?? 'p95' : parts[1] ?? 'p95';
    return num((p as unknown as Record<string, unknown>)[stat]);
  }
  if (key.startsWith('server.origin.')) {
    return num((doc.server?.origin as unknown as Record<string, unknown> | undefined)?.[toCamel(key.slice('server.origin.'.length))]);
  }
  if (key.startsWith('scenario.')) {
    const v = getPath(doc.scenario?.findings, key.slice('scenario.'.length));
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
    return num(v);
  }
  return num(getPath(doc, key));
}

/** 解析一个指标；有多轮时对 client.* / biz.* 给出中位数与区间。 */
export function resolveMetric(doc: ResultDoc, key: string): MetricValue {
  const repeats = doc.repeats ?? [];
  if (repeats.length > 1 && (key.startsWith('client.') || key.startsWith('biz.'))) {
    const values = repeats
      .map((r) => (key.startsWith('client.') ? resolveClientMetric(r.client, key) : resolveBusiness(r.business, key)))
      .filter((v): v is number => v !== undefined);
    if (values.length) {
      return { value: median(values)!, min: Math.min(...values), max: Math.max(...values), n: values.length };
    }
  }
  const v = resolveSingle(doc, key);
  return v === undefined ? {} : { value: v, n: 1 };
}

/**
 * 指标的规范形式（报告去重用）：`client.http_req_duration{route:/api/photos/complete}.p95` 与
 * `client.route.POST /api/photos/:id/complete.p95` 指向同一行时视为相同；`host.cpu.p95` 与 `host.cpu_p95` 相同。
 * 路由先在给定的结果中解析成实际的键（带方法），解析不到时按规范化的路径。
 */
export function canonicalMetric(key: string, docs: readonly ResultDoc[] = []): string {
  const routeOf = (r: string, side: 'client' | 'server') => {
    for (const d of docs) {
      const table = side === 'client' ? d.client?.latencyMs : d.server?.routes;
      const k = findRouteKey(table as Record<string, { count?: number }> | undefined, r);
      if (k) return k;
    }
    const n = normRoute(r);
    return `${n.method ?? '*'} ${n.path}`;
  };
  const http = /^client\.http_req_duration\{route:([^}]+)\}\.(\w+)$/.exec(key);
  if (http) return `client.route:${routeOf(http[1]!, 'client')}.${http[2]}`;
  for (const [prefix, side] of [['client.route.', 'client'], ['server.route.', 'server']] as const) {
    if (key.startsWith(prefix)) {
      const body = key.slice(prefix.length);
      const dot = body.lastIndexOf('.');
      if (dot > 0) return `${side}.route:${routeOf(body.slice(0, dot), side)}.${body.slice(dot + 1)}`;
    }
  }
  for (const prefix of ['host.', 'biz.']) {
    if (key.startsWith(prefix)) return `${prefix}${toCamel(key.slice(prefix.length).replace(/\./g, '_'))}`;
  }
  if (key.startsWith('client.timing.') || key.startsWith('client.server_timing.')) {
    const parts = key.split('.');
    return `client.timing.${parts[2]}.${toCamel(parts.slice(3).join('_') || 'p95')}`;
  }
  return key;
}

/** 毫秒类指标（判定时噪声带至少 1 ms，避免亚毫秒抖动被判为“不符合”）。 */
export function isLatencyMetric(key: string): boolean {
  // 注意 duration 里含有 "ratio"：只排除 _ratio / xxxRatio / 以 ratio 结尾的键
  if (/bytes|calls|count|_ratio|ratio$|Ratio|errors|requests|lost|failed|uploaded|starts/.test(key)) return false;
  return /http_req_duration|\.p\d\d$|_p\d\d$|\.dur\.|ttfb|Ms$|_ms$|\.max$|\.mean$/i.test(key);
}

/** 结果中可用的“默认”指标（报告在 experiment.metrics 之外补充的行）。 */
export function defaultMetricKeys(doc: ResultDoc): string[] {
  const keys: string[] = [];
  for (const route of Object.keys(doc.client?.latencyMs ?? {})) keys.push(`client.route.${route}.p95`);
  for (const name of Object.keys(doc.client?.serverTiming ?? {})) {
    if (name === 'total' || name === 'app') continue;
    keys.push(`client.timing.${name}.calls_per_request`);
  }
  for (const route of Object.keys(doc.server?.routes ?? {})) keys.push(`server.route.${route}.p95`);
  for (const module of Object.keys(doc.server?.ports ?? {})) keys.push(`server.port.${module}.dur.p95`);
  const host = doc.server?.host;
  if (isRecord(host)) {
    for (const k of ['cpuP95', 'eventLoopDelayP99', 'netRxBytes', 'netTxBytes', 'rssMaxBytes']) {
      if (host[k] !== undefined) keys.push(`host.${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`);
    }
  }
  for (const k of Object.keys(doc.server?.business ?? {})) keys.push(`biz.${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`);
  keys.push('client.errors');
  return keys;
}
