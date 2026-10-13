// 图片与静态资源的 Resource Timing 采集（总纲 7.4 第 1 条、12.3 缩略图角标）。
// - CloudFront 在响应头策略开启 Server-Timing 后追加 cdn-* 项（字段名以官方文档为准，这里按 cdn-cache-hit / cdn-cache-miss /
//   cdn-cache-refresh 识别命中状态）；
// - 跨域且没有 Timing-Allow-Origin 时浏览器拿不到 serverTiming、transferSize 与各阶段时间：此时状态记为 unknown（前端不猜）。
import { useSyncExternalStore } from 'react';
import {
  findResource, getTraceSnapshot, recordResource, subscribeTraces,
  type CdnCacheState, type CdnTimingItem, type ResourceRecord,
} from './TraceStore';

const RECORDED_TYPES = new Set(['img', 'image', 'css', 'script', 'link', 'other', 'video', 'beacon']);

export function cdnStateFrom(items: ReadonlyArray<Pick<CdnTimingItem, 'name' | 'description'>>): CdnCacheState | null {
  const names = items.map((i) => i.name.toLowerCase());
  if (names.includes('cdn-cache-hit')) return 'HIT';
  if (names.includes('cdn-cache-refresh')) return 'RefreshHit';
  if (names.includes('cdn-cache-miss')) return 'MISS';
  // 兼容 desc 中写状态的形式（例如 cdn-cache;desc=HIT）
  const desc = items.find((i) => i.name.toLowerCase() === 'cdn-cache')?.description?.toLowerCase();
  if (desc === 'hit') return 'HIT';
  if (desc === 'miss') return 'MISS';
  if (desc === 'refreshhit' || desc === 'refresh') return 'RefreshHit';
  return null;
}

export function toResourceRecord(e: PerformanceResourceTiming): ResourceRecord {
  const serverTiming: CdnTimingItem[] = (e.serverTiming ?? []).map((s) => ({ name: s.name, duration: s.duration, description: s.description }));
  const timingAllowed = e.responseStart > 0 || e.transferSize > 0 || serverTiming.length > 0;
  const cdn = cdnStateFrom(serverTiming);
  return {
    url: e.name,
    initiatorType: e.initiatorType,
    startTime: e.startTime,
    duration: e.duration,
    transferSize: e.transferSize ?? 0,
    ttfb: e.responseStart > 0 ? e.responseStart - e.requestStart : 0,
    serverTiming,
    cdnState: cdn ?? 'unknown',
    timingAllowed,
  };
}

let stop: (() => void) | null = null;

/** 启动一次即可（main.tsx）；重复调用无副作用 */
export function startResourceObserver(): () => void {
  if (stop) return stop;
  const PO = globalThis.PerformanceObserver;
  if (typeof PO !== 'function') return () => undefined;
  let observer: PerformanceObserver;
  try {
    observer = new PO((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceResourceTiming;
        if (!RECORDED_TYPES.has(e.initiatorType)) continue;
        recordResource(toResourceRecord(e));
      }
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    return () => undefined;
  }
  stop = () => {
    observer.disconnect();
    stop = null;
  };
  return stop;
}

/**
 * 某个图片 URL 的 CDN 缓存状态：
 *   - undefined：还没有 Resource Timing 记录（图片未加载完）；
 *   - 'unknown'：有记录但拿不到依据（没有 Timing-Allow-Origin，或响应里没有 cdn-* 项）；
 *   - 'HIT' / 'MISS' / 'RefreshHit'。
 */
export function useResourceCdnState(url: string | null | undefined): CdnCacheState | undefined {
  // 订阅 TraceStore：新的 Resource Timing 记录到达时重新渲染
  useSyncExternalStore(subscribeTraces, getTraceSnapshot, getTraceSnapshot);
  if (!url) return undefined;
  return findResource(url)?.cdnState;
}

/** 在 Resource Timing 中找到 fetch 请求自己的条目（瀑布图的浏览器侧网络阶段） */
export function findFetchTiming(url: string, startTime: number): PerformanceResourceTiming | undefined {
  const perf = globalThis.performance;
  if (!perf?.getEntriesByName) return undefined;
  let best: PerformanceResourceTiming | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const e of perf.getEntriesByName(url, 'resource') as PerformanceResourceTiming[]) {
    const gap = Math.abs(e.startTime - startTime);
    if (gap < bestGap) {
      best = e;
      bestGap = gap;
    }
  }
  return bestGap < 250 ? best : undefined;
}
