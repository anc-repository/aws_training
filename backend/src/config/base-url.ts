// backend/src/config/base-url.ts —— 有效入口 URL（dns > cdn > load-balancer > 基础值）与“受信 HTTPS”判定（总纲 6.1）
//
// capabilities 的 app.entry 与 https = { trusted, via } 由这里计算。这是基于配置的推断；tls / cdn 的感知器
// （握手读取证书颁发者）可以在运行时用观测结果覆盖（CapabilityRegistry.setHttps）。
import type { AppConfig } from './schema.js';

export interface EntryInfo { baseUrl: string; source: 'dns' | 'cdn' | 'load-balancer' | 'base' }
export interface HttpsInfo { trusted: boolean; via: string }

export function effectiveEntry(cfg: AppConfig): EntryInfo {
  if (cfg.core.DNS_PROVIDER === 'route53' || cfg.core.DNS_PROVIDER === 'external') {
    return { baseUrl: cfg.core.APP_BASE_URL, source: 'dns' };       // APP_BASE_URL 只由 dns 写入
  }
  if (cfg.core.CDN_BASE_URL) return { baseUrl: cfg.core.CDN_BASE_URL, source: 'cdn' };
  if (cfg.core.LB_MODE === 'alb') return { baseUrl: cfg.core.APP_BASE_URL, source: 'load-balancer' };
  return { baseUrl: cfg.core.APP_BASE_URL, source: 'base' };
}

export function httpsState(cfg: AppConfig): HttpsInfo {
  const entry = effectiveEntry(cfg);
  let https = false;
  try {
    https = new URL(entry.baseUrl).protocol === 'https:';
  } catch {
    https = false;
  }
  if (!https) return { trusted: false, via: 'none' };
  if (entry.source === 'cdn') {
    return { trusted: true, via: cfg.core.TLS_MODE === 'acm' ? 'acm@cloudfront' : 'default@cloudfront' };
  }
  if (entry.source === 'load-balancer' && cfg.infra.LB_HTTPS === 'true') return { trusted: true, via: 'acm@alb' };
  switch (cfg.core.TLS_MODE) {
    case 'letsencrypt': return { trusted: true, via: 'letsencrypt@nginx' };
    case 'acm': return cfg.core.TLS_ACME === 'on' ? { trusted: true, via: 'acm@nginx:acme' } : { trusted: false, via: 'selfsigned@nginx' };
    default: return { trusted: false, via: 'selfsigned@nginx' };
  }
}
