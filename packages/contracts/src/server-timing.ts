/**
 * `Server-Timing` formatter / parser (modular-design.md §7.1, W3C Server Timing).
 *
 * | 规则 | 约定 |
 * |---|---|
 * | 名称 | `total`（必有）、`app`（扣除端口调用后的业务代码耗时）、其余为模块 id |
 * | dur | 毫秒，保留 1 位小数；同一模块多次调用累加 |
 * | desc | `驱动[@主机类别][:结果][ x次数]`，例如 `"postgres@rds x3"` |
 * | 排序与数量 | `total` 在前，其余按耗时降序；最多 12 项，超出部分合并为 `other` |
 */

export interface ServerTimingMetric {
  name: string;
  /** 毫秒 */
  dur?: number;
  desc?: string;
}

export const SERVER_TIMING_MAX_ENTRIES = 12;
export const SERVER_TIMING_TOTAL = 'total';
export const SERVER_TIMING_APP = 'app';
export const SERVER_TIMING_OTHER = 'other';

// RFC 9110 token
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const NON_TOKEN = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g;

/** 毫秒保留 1 位小数（`48.7`、`2.0`）。负数与非有限值按 0 处理。 */
export function formatTimingDuration(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return (Math.round(v * 10) / 10).toFixed(1);
}

/** desc = `<路径值>[ x<次数>]`，路径值即 `driver[@host][:outcome]`（与 X-CloudAlbum-Path 的段值一致）。 */
export function buildTimingDesc(value: string, count = 1): string {
  return count > 1 ? `${value} x${count}` : value;
}

/** `buildTimingDesc` 的逆运算。 */
export function parseTimingDesc(desc: string): { value: string; count: number } {
  const m = /^(.*?)(?:\s+x(\d+))?$/.exec(desc.trim());
  if (!m) return { value: desc, count: 1 };
  return { value: m[1] ?? '', count: m[2] ? Number.parseInt(m[2], 10) : 1 };
}

function quote(s: string): string {
  return `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

function sanitizeName(name: string): string {
  const n = name.trim().replace(NON_TOKEN, '-');
  return n || 'unnamed';
}

/**
 * 生成 `Server-Timing`：`total` 在前，其余按 dur 降序（稳定排序），最多 `maxEntries` 项，
 * 超出部分（以及已有的 `other` 项）合并为一项 `other`（dur 求和）。
 */
export function formatServerTiming(metrics: readonly ServerTimingMetric[], opts: { maxEntries?: number } = {}): string {
  const maxEntries = Math.max(2, opts.maxEntries ?? SERVER_TIMING_MAX_ENTRIES);
  const normalized = metrics.map((m) => ({ ...m, name: sanitizeName(m.name) }));
  const total = normalized.filter((m) => m.name === SERVER_TIMING_TOTAL).slice(0, 1);
  let otherDur = 0;
  let hasOther = false;
  const rest: ServerTimingMetric[] = [];
  for (const m of normalized) {
    if (m.name === SERVER_TIMING_TOTAL) continue;
    if (m.name === SERVER_TIMING_OTHER) { hasOther = true; otherDur += m.dur ?? 0; continue; }
    rest.push(m);
  }
  const sorted = rest
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (b.m.dur ?? 0) - (a.m.dur ?? 0) || a.i - b.i)
    .map((x) => x.m);

  const budget = maxEntries - total.length;
  let kept = sorted;
  if (sorted.length + (hasOther ? 1 : 0) > budget) {
    kept = sorted.slice(0, budget - 1);
    for (const m of sorted.slice(budget - 1)) otherDur += m.dur ?? 0;
    hasOther = true;
  }
  const out: ServerTimingMetric[] = [...total, ...kept];
  if (hasOther) out.push({ name: SERVER_TIMING_OTHER, dur: otherDur });

  return out
    .map((m) => {
      let s = m.name;
      if (m.dur !== undefined) s += `;dur=${formatTimingDuration(m.dur)}`;
      if (m.desc !== undefined && m.desc !== '') s += `;desc=${quote(m.desc)}`;
      return s;
    })
    .join(', ');
}

/** 在引号外按分隔符切分（支持 quoted-string 中的反斜杠转义）。 */
function splitOutsideQuotes(input: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i] as string;
    if (inQuotes) {
      cur += c;
      if (c === '\\' && i + 1 < input.length) { cur += input[i + 1]; i += 1; continue; }
      if (c === '"') inQuotes = false;
      continue;
    }
    if (c === '"') { inQuotes = true; cur += c; continue; }
    if (c === sep) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function unquote(v: string): string {
  if (!v.startsWith('"')) return v;
  let out = '';
  for (let i = 1; i < v.length; i += 1) {
    const c = v[i] as string;
    if (c === '\\' && i + 1 < v.length) { out += v[i + 1]; i += 1; continue; }
    if (c === '"') break;
    out += c;
  }
  return out;
}

/**
 * 解析 `Server-Timing`（容错：忽略非法名称；重复参数取第一个；dur 非数字时忽略）。
 * 浏览器侧 `PerformanceServerTiming` 已经解析好，这里主要给实验运行器、测试与 SSR 用。
 */
export function parseServerTiming(header: string | null | undefined): ServerTimingMetric[] {
  if (!header) return [];
  const out: ServerTimingMetric[] = [];
  for (const part of splitOutsideQuotes(header, ',')) {
    const params = splitOutsideQuotes(part, ';').map((s) => s.trim());
    const name = params.shift();
    if (!name || !TOKEN_RE.test(name)) continue;
    const metric: ServerTimingMetric = { name };
    for (const p of params) {
      if (!p) continue;
      const eq = p.indexOf('=');
      const key = (eq === -1 ? p : p.slice(0, eq)).trim().toLowerCase();
      const raw = eq === -1 ? '' : p.slice(eq + 1).trim();
      const val = unquote(raw);
      if (key === 'dur' && metric.dur === undefined) {
        const n = Number.parseFloat(val);
        if (Number.isFinite(n)) metric.dur = n;
      } else if (key === 'desc' && metric.desc === undefined) {
        metric.desc = val;
      }
    }
    out.push(metric);
  }
  return out;
}
