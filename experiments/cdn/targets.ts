/**
 * cdn/targets —— 两条路径的基址：直连源站（CDN_ORIGIN_DIRECT_URL / --target）与经 CloudFront（CDN_BASE_URL）。
 * 取值顺序：--param direct= / cdn= > capabilities（cdn 模块的 public / data 段、app.entry）> 运行器目标。
 */
import type { ScenarioContext } from '../_lib/scenario.js';
import { strParam } from '../_lib/scenario.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : undefined;
}

export function cdnTargets(ctx: ScenarioContext): { direct: string; cdn?: string } {
  const m = ctx.capabilities.modules?.cdn;
  const pub = (m?.public ?? {}) as Record<string, unknown>;
  const data = (m?.data ?? {}) as Record<string, unknown>;
  const entry = ctx.capabilities.app?.entry;
  const cdn = str(strParam(ctx, 'cdn', '')) ?? str(pub.baseUrl) ?? str(data.baseUrl) ?? (entry?.source === 'cdn' ? str(entry.baseUrl) : undefined);
  const direct = str(strParam(ctx, 'direct', '')) ?? str(data.originDirectUrl) ?? str(pub.originDirectUrl) ?? ctx.target;
  return cdn && cdn !== direct ? { direct, cdn } : { direct };
}

/** 从首页 HTML 中找第一个 /assets/*.js 与 *.css（Vite 构建产物，带哈希）。 */
export function assetPaths(html: string): { js?: string; css?: string } {
  const js = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const css = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  return { ...(js ? { js } : {}), ...(css ? { css } : {}) };
}
