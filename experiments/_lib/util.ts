/**
 * experiments/_lib/util.ts —— 实验框架的通用小工具（时长解析、分位数、稳定序列化、路径定位）。
 * 不依赖任何服务端代码；Windows 与 Amazon Linux 2023 都可运行（路径一律用 node:path）。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `60s`、`2m`、`500ms`、`1h`、`1m30s`、纯数字（毫秒）→ 毫秒。 */
export function parseDuration(input: string | number | undefined | null, fallbackMs = 0): number {
  if (input === undefined || input === null || input === '') return fallbackMs;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : fallbackMs;
  const s = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
    consumed += m[0].length;
  }
  if (consumed !== s.length || consumed === 0) throw new Error(`无法解析的时长：${input}（示例：500ms、60s、2m、1h）`);
  return total;
}

/** 毫秒 → `1m30s` / `850ms`（日志与报告用）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s || (!h && !m) ? `${s}s` : ''}`;
}

/** 最近秩（nearest-rank）分位数；输入无需排序。空数组返回 undefined。 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return percentileSorted(sorted, p);
}

export function percentileSorted(sorted: readonly number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function mean(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 保留 1 位小数（与 Server-Timing 的精度一致）。 */
export function round1(n: number | undefined): number | undefined {
  return n === undefined || !Number.isFinite(n) ? n : Math.round(n * 10) / 10;
}

export function round3(n: number | undefined): number | undefined {
  return n === undefined || !Number.isFinite(n) ? n : Math.round(n * 1000) / 1000;
}

/** 键排序后的 JSON（用于哈希与比较）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `2026-10-13T06:00:00.000Z` → `20261013T060000Z`（文件名用；Windows 不允许冒号）。 */
export function fileTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** 可被中止的 sleep；中止时立即 resolve（调用方自己检查 signal.aborted）。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** 以有限并发执行一组异步任务（保持结果顺序）。 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 按点号路径取值（`a.b.c`）；路径中某段不存在时返回 undefined。 */
export function getPath(obj: unknown, dotted: string | readonly string[]): unknown {
  const parts = typeof dotted === 'string' ? dotted.split('.') : dotted;
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** `photo_time_to_ready_p95` / `photo-time-to-ready.p95` → `photoTimeToReadyP95` */
export function toCamel(key: string): string {
  return key.replace(/[._-]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 简单的 ULID 形状校验（Crockford Base32，26 位）。 */
export function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s);
}

/**
 * experiments 工作区根目录（含 `_lib/schema/`）。源码（tsx / vitest）与编译产物（dist/_lib）都能定位。
 */
export function experimentsRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(path.join(dir, '_lib', 'schema', 'experiment.schema.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到 experiments 根目录（_lib/schema/experiment.schema.json）');
}

/** 仓库根目录（experiments 的上一级）。 */
export function repoRoot(): string {
  return path.dirname(experimentsRoot());
}

/** 当前模块文件是否以 TypeScript 源码运行（tsx / vitest），决定场景脚本用 .ts 还是 dist 下的 .js。 */
export function runningFromSource(): boolean {
  return fileURLToPath(import.meta.url).endsWith('.ts');
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 解析 `k=v` 列表（`--param a=1 --param b=x`）。 */
export function parseKeyValues(list: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`--param 需要 <键>=<值>：${item}`);
    out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }
  return out;
}
