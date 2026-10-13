/**
 * experiments/_lib/scenarios/feed-read.ts —— 时间线读压测（cache 的 feed-read / fail-open、database 的 replica-read 共用）。
 *
 * VU 循环 `GET /api/feed`（参与 A/B：cache / replica 旁路）；结束后从 Server-Timing 汇总每请求 database 调用次数、
 * 从路径头汇总 cache 段的结果（hit / miss / bypass / error-bypass），按变体分别给出。
 */
import { parseTimingDesc } from '@cloudalbum/contracts';
import { ROUTES } from '../app.js';
import { runVus } from '../load.js';
import type { ScenarioContext } from '../scenario.js';
import type { Sample } from '../stats.js';
import { round3 } from '../util.js';

export interface FeedReadOptions {
  scope?: 'mine' | 'public';
  limit?: number;
  pauseMs?: number;
}

/** 一组样本中某模块 Server-Timing 的每请求调用次数（desc 的 xN 累加；没有该项的响应计 0 次）。 */
export function callsPerRequest(samples: readonly Sample[], module: string): number | undefined {
  if (!samples.length) return undefined;
  let calls = 0;
  for (const s of samples) {
    for (const m of s.serverTiming ?? []) {
      if (m.name !== module) continue;
      calls += m.desc ? parseTimingDesc(m.desc).count : 1;
    }
  }
  return round3(calls / samples.length);
}

/** 路径头中某模块段 outcome 的分布。 */
export function outcomeCounts(samples: readonly Sample[], module: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = new RegExp(`(?:^|;)${module.replace(/-/g, '\\-')}=([^;]+)`);
  for (const s of samples) {
    const m = s.pathHeader ? re.exec(s.pathHeader) : null;
    const key = m ? m[1]! : '(无该段)';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** 命中率 = hit / (hit + miss)，排除 bypass（03#cache 第 5 节）。 */
export function hitRatio(outcomes: Record<string, number>): number | undefined {
  let hit = 0;
  let miss = 0;
  for (const [k, n] of Object.entries(outcomes)) {
    if (/(^|:)hit$/.test(k)) hit += n;
    else if (/(^|:)miss$/.test(k)) miss += n;
  }
  return hit + miss ? round3(hit / (hit + miss)) : undefined;
}

export async function runFeedRead(ctx: ScenarioContext, o: FeedReadOptions = {}): Promise<void> {
  const p = `${ROUTES.feed}?scope=${o.scope ?? 'mine'}&limit=${o.limit ?? 24}`;
  const before = ctx.recorder.size;
  await runVus({ vus: ctx.vus, durationMs: ctx.durationMs, signal: ctx.signal, ...(o.pauseMs ? { pauseMs: o.pauseMs } : {}) }, async () => {
    await ctx.client.get(p, { route: ROUTES.feed, ab: true });
  });
  if (ctx.phase !== 'measure') return;
  const samples = ctx.recorder.all().slice(before).filter((s) => s.route === ROUTES.feed);
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const k = s.variant ?? ctx.label;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const perVariant: Record<string, unknown> = {};
  for (const [k, list] of groups) {
    const cache = outcomeCounts(list, 'cache');
    perVariant[k] = {
      requests: list.length,
      dbCallsPerRequest: callsPerRequest(list, 'database'),
      cacheOutcomes: cache,
      cacheHitRatio: hitRatio(cache),
      errors: list.filter((s) => !s.ok).length,
    };
  }
  ctx.finding('feed', perVariant);
  const all = outcomeCounts(samples, 'cache');
  ctx.finding('cacheHitRatio', hitRatio(all));
  ctx.finding('dbCallsPerRequest', callsPerRequest(samples, 'database'));
  ctx.finding('errorBypass', Object.entries(all).filter(([k]) => k.endsWith(':error-bypass')).reduce((a, [, n]) => a + n, 0));
}
