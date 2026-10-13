// backend/src/config/base-url.ts —— 有效入口 URL（dns > cdn > load-balancer > 基础值）与“受信 HTTPS”判定（总纲 6.1）
//
// capabilities 的 app.entry 与 https = { trusted, via } 由这里计算。这是基于配置的推断；tls / cdn 的感知器
// （握手读取证书颁发者）可以在运行时用观测结果覆盖（CapabilityRegistry.setHttps）。
import type { AppConfig } from './schema.js';

export interface EntryInfo { baseUrl: string; source: 'dns' | 'cdn' | 'load-balancer' | 'base' }
export interface HttpsInfo { trusted: boolean; via: string }

/**
 * 基础值（06 PM-21 第 4 条）：cloudalbum.env 的 APP_BASE_URL 保持 http://<EIP> 不变；tls 本地档为 EIP 申请了受信证书时
 * （TLS_MODE ∈ {letsencrypt, acm}、TLS_DOMAIN 为空、TLS_PUBLIC_IP 等于 APP_BASE_URL 的主机），协议改为 https。
 */
export function baseUrlValue(cfg: AppConfig): string {
  const base = cfg.core.APP_BASE_URL;
  const ip = cfg.infra.TLS_PUBLIC_IP ?? '';
  if (!ip || cfg.infra.TLS_DOMAIN || (cfg.core.TLS_MODE !== 'letsencrypt' && cfg.core.TLS_MODE !== 'acm')) return base;
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' || u.hostname !== ip) return base;
    u.protocol = 'https:';
    u.port = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return base;
  }
}

export function effectiveEntry(cfg: AppConfig): EntryInfo {
  if (cfg.core.DNS_PROVIDER === 'route53' || cfg.core.DNS_PROVIDER === 'external') {
    return { baseUrl: cfg.core.APP_BASE_URL, source: 'dns' };       // APP_BASE_URL 只由 dns 写入
  }
  if (cfg.core.CDN_BASE_URL) return { baseUrl: cfg.core.CDN_BASE_URL, source: 'cdn' };
  if (cfg.core.LB_MODE === 'alb') return { baseUrl: cfg.core.APP_BASE_URL, source: 'load-balancer' };
  return { baseUrl: baseUrlValue(cfg), source: 'base' };
}

/** 有效入口的主机是 IP 还是域名（06 PM-21 第 5 条：DEP-029 在平台模式下要求 hostKind=dns） */
export function hostKindOf(baseUrl: string): 'ip' | 'dns' {
  try {
    const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') ? 'ip' : 'dns';
  } catch {
    return 'dns';
  }
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
