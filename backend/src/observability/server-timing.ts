// backend/src/observability/server-timing.ts —— 生成 Server-Timing（§7.1）
//
// total（应用内总耗时，必有）、app（扣除端口调用后的业务代码耗时）、其余为模块 id；desc = 路径段值 + ` x<次数>`。
import { performance } from 'node:perf_hooks';
import { buildTimingDesc, formatServerTiming, type ServerTimingMetric } from '@cloudalbum/contracts';
import type { RequestContext } from './request-context.js';

export function serverTimingMetrics(ctx: RequestContext, now = performance.now()): ServerTimingMetric[] {
  const total = Math.max(0, now - ctx.startedAt);
  const metrics: ServerTimingMetric[] = [{ name: 'total', dur: total }];
  const ports = ctx.timing.entries();
  for (const p of ports) {
    const value = ctx.path.get(p.module);
    metrics.push({ name: p.module, dur: p.dur, ...(value ? { desc: buildTimingDesc(value, p.count) } : {}) });
  }
  metrics.push({ name: 'app', dur: Math.max(0, total - ctx.timing.sum()) });
  return metrics;
}

export function buildServerTimingHeader(ctx: RequestContext, now = performance.now()): string {
  return formatServerTiming(serverTimingMetrics(ctx, now));
}
