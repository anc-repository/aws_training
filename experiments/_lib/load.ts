/**
 * experiments/_lib/load.ts —— 负载生成（替代 k6）：闭环虚拟用户（VU）与开环固定到达速率。
 *
 * - `runVus`：N 个 VU 各自循环执行迭代函数，直到时长用尽、达到总迭代数或被中止。迭代内的异常只计数，不中断其他 VU。
 * - `runRate`：每秒固定 rate 次（开环，不等前一次完成），在途上限 maxInFlight，用于“背景流量”（例如上传期间以 5 rps 读时间线）。
 */
import { sleep } from './util.js';

export interface VuOptions {
  vus: number;
  durationMs: number;
  /** 所有 VU 合计的迭代上限（达到后停止）；缺省不限 */
  iterations?: number;
  signal?: AbortSignal;
  /** 每次迭代后的思考时间 */
  pauseMs?: number;
  /** VU 启动时间均匀铺开在 rampUpMs 内 */
  rampUpMs?: number;
  onError?: (e: unknown, vu: number) => void;
}

export interface LoadStats {
  iterations: number;
  errors: number;
  elapsedMs: number;
}

export async function runVus(opts: VuOptions, fn: (vu: number, iteration: number) => Promise<void>): Promise<LoadStats> {
  const started = performance.now();
  const deadline = started + opts.durationMs;
  let started_iterations = 0;
  let errors = 0;
  const vus = Math.max(1, Math.floor(opts.vus));
  const take = (): number | undefined => {
    if (opts.signal?.aborted) return undefined;
    if (performance.now() >= deadline) return undefined;
    if (opts.iterations !== undefined && started_iterations >= opts.iterations) return undefined;
    started_iterations += 1;
    return started_iterations;
  };
  await Promise.all(Array.from({ length: vus }, async (_v, vu) => {
    if (opts.rampUpMs && vus > 1) await sleep((opts.rampUpMs * vu) / vus, opts.signal);
    for (let it = take(); it !== undefined; it = take()) {
      try {
        await fn(vu, it);
      } catch (e) {
        errors += 1;
        opts.onError?.(e, vu);
      }
      if (opts.pauseMs) await sleep(opts.pauseMs, opts.signal);
    }
  }));
  return { iterations: started_iterations, errors, elapsedMs: performance.now() - started };
}

export interface RateOptions {
  ratePerSec: number;
  durationMs: number;
  maxInFlight?: number;
  signal?: AbortSignal;
  /** 额外的停止条件（例如主负载已结束） */
  until?: () => boolean;
  onError?: (e: unknown) => void;
}

export async function runRate(opts: RateOptions, fn: (iteration: number) => Promise<void>): Promise<LoadStats> {
  const started = performance.now();
  const deadline = started + opts.durationMs;
  const interval = 1000 / Math.max(0.001, opts.ratePerSec);
  const maxInFlight = opts.maxInFlight ?? 32;
  const inFlight = new Set<Promise<void>>();
  let n = 0;
  let errors = 0;
  let nextAt = started;
  while (!opts.signal?.aborted && performance.now() < deadline && !(opts.until?.() ?? false)) {
    const now = performance.now();
    if (now < nextAt) {
      await sleep(Math.min(nextAt - now, 250), opts.signal);
      continue;
    }
    nextAt += interval;
    if (inFlight.size >= maxInFlight) {
      // 开环模型下“发不出去”本身就是饱和信号：跳过本次而不是排队
      errors += 1;
      continue;
    }
    n += 1;
    const p: Promise<void> = fn(n)
      .catch((e: unknown) => {
        errors += 1;
        opts.onError?.(e);
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  await Promise.all(inFlight);
  return { iterations: n, errors, elapsedMs: performance.now() - started };
}

/** 生成 Zipf 分布的下标（0..n-1），s 越大越集中。 */
export function zipfSampler(n: number, s = 1.1, rand: () => number = Math.random): () => number {
  const weights = Array.from({ length: n }, (_v, i) => 1 / (i + 1) ** s);
  const total = weights.reduce((a, b) => a + b, 0);
  const cdf: number[] = [];
  let acc = 0;
  for (const w of weights) {
    acc += w / total;
    cdf.push(acc);
  }
  return () => {
    const r = rand();
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cdf[mid] as number) < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}
