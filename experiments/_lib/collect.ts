/**
 * experiments/_lib/collect.ts —— 拉取服务端数据（总纲 §8.2 运行器第 2、3、6、7 步）。
 *
 * - `/api/capabilities`（管理员视图）快照：校验 `requires[label]`、计算 capabilitiesHash、提取环境（驱动 / 状态 / 档位）。
 * - `POST /api/lab/runs` 登记时间窗；`POST /api/lab/runs/:id/finish` 结束。
 * - `GET /api/lab/metrics?run=<runId>`：分钟汇总（路由 / 路径签名 / 端口）、主机采样、源站卸载 → 结果的 `server` 段。
 * - `POST /api/lab/results`（--upload）。
 */
import { isModuleId, MODULE_IDS } from '@cloudalbum/contracts';
import type { ExpClient } from './http.js';
import type {
  Capabilities, HostSummary, OriginSummary, RequireMismatch, RequireValue, ResultDoc, ServerPortStats, ServerRouteStats, ServerSection,
} from './types.js';
import { getPath, percentile, round1, sha256, stableStringify } from './util.js';

// ------------------------------------------------------------------------------------- capabilities

export async function fetchCapabilities(client: ExpClient): Promise<Capabilities> {
  const res = await client.get('/api/capabilities', { record: false, timeoutMs: 20_000 });
  if (!res.ok) {
    throw new Error(`GET /api/capabilities 失败：${res.status || res.error}${res.status ? ` ${res.text().slice(0, 200)}` : ''}`);
  }
  return res.json<Capabilities>();
}

/** `queue.driver` → capabilities.modules.queue.driver；非模块开头的键（`app.deployMode`、`lab.bypassEnabled`）从根取。 */
export function capabilityValue(caps: Capabilities, key: string): unknown {
  const [head, ...rest] = key.split('.');
  if (head && isModuleId(head)) return getPath(caps.modules?.[head], rest);
  return getPath(caps, key);
}

function scalarMatches(actual: unknown, expected: string | number | boolean | null): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (typeof expected === 'string' && expected.startsWith('!')) return String(actual ?? '') !== expected.slice(1);
  if (typeof expected === 'string' && expected === '*') return actual !== undefined && actual !== null && actual !== '';
  return String(actual) === String(expected);
}

export function valueMatches(actual: unknown, expected: RequireValue): boolean {
  return Array.isArray(expected) ? expected.some((e) => scalarMatches(actual, e)) : scalarMatches(actual, expected);
}

export function checkRequires(caps: Capabilities, requires: Record<string, RequireValue> | undefined): { ok: boolean; mismatches: RequireMismatch[] } {
  const mismatches: RequireMismatch[] = [];
  for (const [key, expected] of Object.entries(requires ?? {})) {
    const actual = capabilityValue(caps, key);
    if (!valueMatches(actual, expected)) mismatches.push({ key, expected, actual: actual ?? null });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** 只取稳定字段（驱动、状态、类型、档位、部署模式、实例类型），探针时间与耗时不参与。 */
export function capabilitiesHash(caps: Capabilities): string {
  const modules: Record<string, unknown> = {};
  for (const id of MODULE_IDS) {
    const m = caps.modules?.[id];
    if (m) modules[id] = { driver: m.driver, status: m.status, type: m.type };
  }
  const app = caps.app ? { profile: caps.app.profile, deployMode: caps.app.deployMode, instanceType: caps.app.instance?.type } : {};
  return `sha256:${sha256(stableStringify({ modules, app }))}`;
}

export function environmentOf(caps: Capabilities): ResultDoc['environment'] {
  const drivers: Record<string, string> = {};
  const statuses: Record<string, string> = {};
  for (const id of MODULE_IDS) {
    const m = caps.modules?.[id];
    if (!m) continue;
    drivers[id] = m.driver;
    statuses[id] = m.status;
  }
  const env: ResultDoc['environment'] = { drivers, statuses, capabilitiesHash: capabilitiesHash(caps) };
  if (caps.app?.profile) env.profile = caps.app.profile;
  if (caps.app?.deployMode) env.deployMode = caps.app.deployMode;
  if (caps.app?.instance?.type) env.instanceType = caps.app.instance.type;
  if (caps.app?.region) env.region = caps.app.region;
  return env;
}

// ------------------------------------------------------------------------------------- lab runs

export interface RunRegistration {
  registered: boolean;
  startedAt?: string;
  error?: string;
}

export async function registerRun(client: ExpClient, body: {
  runId: string; module: string; experiment: string; label: string; params?: Record<string, unknown>; forced?: boolean; notes?: string;
  /** 06 PM-37：任意变体（平台模式下为登记响应的 variant） */
  variant?: { label: string; role?: string; cardVariant?: string };
  windowSec?: number;
}): Promise<RunRegistration> {
  const res = await client.post('/api/lab/runs', { json: body, record: false, timeoutMs: 20_000 });
  if (res.ok) {
    const b = res.json<{ startedAt?: string }>();
    return { registered: true, ...(b?.startedAt ? { startedAt: b.startedAt } : {}) };
  }
  return { registered: false, error: `POST /api/lab/runs → ${res.status || res.error}` };
}

export async function finishRun(client: ExpClient, runId: string, notes?: string): Promise<boolean> {
  const res = await client.post(`/api/lab/runs/${runId}/finish`, { json: notes ? { notes: notes.slice(0, 2000) } : {}, record: false, timeoutMs: 20_000 });
  return res.ok;
}

export async function uploadResult(client: ExpClient, doc: ResultDoc): Promise<{ ok: boolean; status: number; error?: string }> {
  const res = await client.post('/api/lab/results', { json: doc, record: false, timeoutMs: 60_000 });
  return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: res.error ?? res.text().slice(0, 300) };
}

// ------------------------------------------------------------------------------------- /api/lab/metrics

interface RollupRow { group: string; count: number; errors: number; p50: number; p95: number; p99: number; max: number; avg?: number }

interface MetricsResponse {
  routes?: RollupRow[];
  ports?: RollupRow[];
  recent?: RollupRow[];
  host?: Array<Record<string, unknown>>;
  origin?: Array<Record<string, unknown>>;
}

function statsOf(r: RollupRow): ServerRouteStats {
  const out: ServerRouteStats = { count: Number(r.count) || 0, errors: Number(r.errors) || 0 };
  for (const k of ['p50', 'p95', 'p99', 'max', 'avg'] as const) {
    const v = Number(r[k]);
    if (Number.isFinite(v)) out[k] = round1(v)!;
  }
  return out;
}

/** 路由汇总的分组键 `GET /api/feed`（groupBy=route）；path 分组为 `GET /api/feed | entry=…;cache=…`。 */
function routeRows(rows: RollupRow[] | undefined): Record<string, ServerRouteStats> {
  const out: Record<string, ServerRouteStats> = {};
  for (const r of rows ?? []) {
    const key = String(r.group).trim();
    if (!key) continue;
    out[key] = statsOf(r);
  }
  return out;
}

/** groupBy=driver 的端口行：`storage:local` → ports.storage（按驱动拆分，顶层取调用最多的驱动的分位数）。 */
export function portRows(rows: RollupRow[] | undefined): Record<string, ServerPortStats> {
  const byModule = new Map<string, Record<string, ServerRouteStats>>();
  for (const r of rows ?? []) {
    const g = String(r.group);
    const colon = g.indexOf(':');
    const module = colon === -1 ? g : g.slice(0, colon);
    const driver = colon === -1 ? '' : g.slice(colon + 1);
    const m = byModule.get(module) ?? {};
    m[driver || 'unknown'] = statsOf(r);
    byModule.set(module, m);
  }
  const out: Record<string, ServerPortStats> = {};
  for (const [module, drivers] of byModule) {
    const entries = Object.entries(drivers).sort((a, b) => b[1].count - a[1].count);
    const [topDriver, top] = entries[0]!;
    const calls = entries.reduce((a, [, s]) => a + s.count, 0);
    out[module] = {
      ...top, count: calls, calls, errors: entries.reduce((a, [, s]) => a + s.errors, 0), driver: topDriver,
      ...(entries.length > 1 ? { drivers } : {}),
    };
  }
  return out;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 主机采样（lab_host_samples 行，snake_case）→ 汇总。网卡字节是主机累计计数器，取窗口内同一实例的首尾差。 */
export function summarizeHost(rows: Array<Record<string, unknown>> | undefined): HostSummary {
  const samples = [...(rows ?? [])].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const out: HostSummary = { samples: samples.length };
  if (!samples.length) return out;
  // CPU：同一 10 秒桶内各进程（api / worker）求和 ≈ 本应用占用的主机 CPU
  const buckets = new Map<string, number>();
  for (const s of samples) {
    const t = Date.parse(String(s.ts));
    const key = `${String(s.instance_id)}@${Number.isFinite(t) ? Math.floor(t / 10_000) : String(s.ts)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + (num(s.cpu_pct) ?? 0));
  }
  const cpu = [...buckets.values()];
  out.cpuP95 = round1(percentile(cpu, 95));
  out.cpuMax = round1(Math.max(...cpu));
  const api = samples.filter((s) => String(s.role) === 'api');
  const el = (api.length ? api : samples).map((s) => num(s.event_loop_delay_p99_ms)).filter((v): v is number => v !== undefined);
  if (el.length) {
    out.eventLoopDelayP99 = round1(Math.max(...el));
    out.eventLoopDelayP95 = round1(percentile(el, 95));
  }
  const rss = samples.map((s) => num(s.rss_bytes)).filter((v): v is number => v !== undefined);
  if (rss.length) out.rssMaxBytes = Math.max(...rss);
  const mem = samples.map((s) => num(s.mem_used_ratio)).filter((v): v is number => v !== undefined);
  if (mem.length) out.memUsedRatioMax = Math.round(Math.max(...mem) * 1000) / 1000;
  const steal = samples.map((s) => num(s.steal_pct)).filter((v): v is number => v !== undefined);
  if (steal.length) out.stealPctMax = round1(Math.max(...steal));
  const data = samples.map((s) => num(s.data_used_pct)).filter((v): v is number => v !== undefined);
  if (data.length) out.dataUsedPctMax = round1(Math.max(...data));
  // 网卡：按 (实例, 角色) 取首尾差，再按实例取最大的那一组（同一主机的计数器相同，避免 api + worker 重复计算）
  const perInstance = new Map<string, { rx: number; tx: number }>();
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const s of samples) {
    const k = `${String(s.instance_id)}|${String(s.role)}`;
    const list = groups.get(k) ?? [];
    list.push(s);
    groups.set(k, list);
  }
  for (const [k, list] of groups) {
    const inst = k.split('|')[0]!;
    const rxs = list.map((s) => num(s.net_rx_bytes)).filter((v): v is number => v !== undefined);
    const txs = list.map((s) => num(s.net_tx_bytes)).filter((v): v is number => v !== undefined);
    if (rxs.length < 2) continue;
    const rx = Math.max(0, rxs[rxs.length - 1]! - rxs[0]!);
    const tx = txs.length >= 2 ? Math.max(0, txs[txs.length - 1]! - txs[0]!) : 0;
    const cur = perInstance.get(inst);
    if (!cur || rx > cur.rx) perInstance.set(inst, { rx, tx });
  }
  if (perInstance.size) {
    out.netRxBytes = [...perInstance.values()].reduce((a, v) => a + v.rx, 0);
    out.netTxBytes = [...perInstance.values()].reduce((a, v) => a + v.tx, 0);
  }
  const byRole: NonNullable<HostSummary['byRole']> = {};
  for (const role of [...new Set(samples.map((s) => String(s.role)))]) {
    const rs = samples.filter((s) => String(s.role) === role);
    const cpuR = rs.map((s) => num(s.cpu_pct)).filter((v): v is number => v !== undefined);
    const elR = rs.map((s) => num(s.event_loop_delay_p99_ms)).filter((v): v is number => v !== undefined);
    const rssR = rs.map((s) => num(s.rss_bytes)).filter((v): v is number => v !== undefined);
    byRole[role] = {
      samples: rs.length,
      ...(cpuR.length ? { cpuP95: round1(percentile(cpuR, 95))! } : {}),
      ...(elR.length ? { eventLoopDelayP99: round1(Math.max(...elR))! } : {}),
      ...(rssR.length ? { rssMaxBytes: Math.max(...rssR) } : {}),
    };
  }
  out.byRole = byRole;
  return out;
}

export function summarizeOrigin(rows: Array<Record<string, unknown>> | undefined): OriginSummary | undefined {
  if (!rows?.length) return undefined;
  const sum = (k: string) => rows.reduce((a, r) => a + (num(r[k]) ?? 0), 0);
  return {
    samples: rows.length, requests: sum('requests'), bytes: sum('bytes'), viaCloudfront: sum('via_cloudfront'), viaAlb: sum('via_alb'), direct: sum('direct'),
  };
}

export function emptyServer(error?: string): ServerSection {
  return { available: false, ...(error ? { error } : {}), routes: {}, ports: {}, host: { samples: 0 }, business: {} };
}

/**
 * 拉取 `/api/lab/metrics`：groupBy=route（路由）与 groupBy=path（路径签名 + 端口按驱动）两次；主机与源站采样按时间窗。
 * 分钟汇总为空（例如 flush 失败）时退回环形缓冲的即时汇总 `recent`。
 */
export async function fetchServerMetrics(client: ExpClient, runId: string, window: { from: string; to: string }): Promise<ServerSection> {
  const q = (groupBy: string) => `/api/lab/metrics?run=${encodeURIComponent(runId)}&groupBy=${groupBy}&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`;
  const [byRoute, byPath] = await Promise.all([
    client.get(q('route'), { record: false, timeoutMs: 60_000 }),
    client.get(q('path'), { record: false, timeoutMs: 60_000 }),
  ]);
  if (!byRoute.ok || !byPath.ok) {
    const bad = byRoute.ok ? byPath : byRoute;
    return emptyServer(`GET /api/lab/metrics → ${bad.status || bad.error}${bad.status ? ` ${bad.text().slice(0, 200)}` : ''}`);
  }
  const r = byRoute.json<MetricsResponse>();
  const p = byPath.json<MetricsResponse>();
  if (typeof r !== 'object' || r === null || typeof p !== 'object' || p === null) return emptyServer('GET /api/lab/metrics 返回的不是对象');
  const routes = routeRows(r.routes?.length ? r.routes : r.recent);
  const paths = routeRows(p.routes?.length ? p.routes : p.recent);
  const out: ServerSection = {
    available: true,
    routes,
    ...(Object.keys(paths).length ? { paths } : {}),
    ports: portRows(p.ports),
    host: summarizeHost(p.host ?? r.host),
    business: {},
  };
  const origin = summarizeOrigin(p.origin ?? r.origin);
  if (origin) out.origin = origin;
  return out;
}
