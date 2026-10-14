// backend/src/modules/detectors/tls.ts —— tls 感知器（总纲 3.3；01#tls 第 1、3、10 节；约定 4、7）
//
// 只在 TLS_MODE=acm 时运行（本地档 letsencrypt 与自签名不运行感知器，总纲 3.3）。tls 是纯基础设施型，探针就是本感知器。
// 常规（300 秒，结果缓存 300 秒；deep 时重测）：对每个入口用 node:tls 握手（不校验也不拒绝，读出证书后自己判断）——
//   direct（127.0.0.1:443，SNI = TLS_DOMAIN）、cdn（CDN_BASE_URL）、alb（LB_HTTPS=true 时的 LB_DNS_NAME，SNI = TLS_DOMAIN）、
//   entry（有效入口 URL，https 时）。读取签发者、SAN、notBefore / notAfter、剩余天数、协议版本、ALPN、链校验结果。
//   degraded：TLS_ACME=on 但直连证书签发者不是 Amazon（符号链接未切换或 reload 失败）；任一入口剩余天数低于续期窗口仍未续期
//             （45 天的 ACME / Let's Encrypt 证书按寿命的 1/3，ACM 集成证书按 30 天）；cloudalbum-tls-renew 最近一次运行失败
//             （hostSetup 写的 /var/lib/cloudalbum/tls/renew-status.json）。
//   error：证书过期、域名不匹配、握手失败（超时 / 网络错误标为 transient：首次探针记 degraded，连续 3 次才 error）。
// 深度（管理员 ?deep=1 与 enable 的健康检查阶段，需要凭证）：acm:DescribeCertificate（ACM_CERT_ARN_EDGE 在 us-east-1、
//   ACM_CERT_ARN_REGIONAL 在本区域：续期状态、InUseBy、验证记录状态）；TLS_ACME=on 时 acm:SearchCertificates
//   （CertificateKeyPairOrigin=ACME；ListCertificates 默认不列出 ACME 证书）。无凭证时跳过并降为 degraded（CRED-004）。
// data.via / data.trusted：观测到的 TLS 终止点与证书来源（约定 4 的 tls 段语法），供 capabilities.https 使用。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { describeAwsError, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry } from '../../adapters/aws/clients.js';
import type { ProbeResult } from '../../ports/common.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

const DAY_MS = 86_400_000;
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'TIMEOUT', 'EPIPE']);

export type TlsEntry = 'direct' | 'cdn' | 'alb' | 'entry';

export interface TlsTarget { entry: TlsEntry; host: string; port: number; servername?: string }

export interface HandshakeResult {
  entry: TlsEntry;
  host: string;
  port: number;
  servername?: string;
  ok: boolean;
  /** 网络 / 握手错误码（ok=false 时） */
  error?: string;
  issuer?: string;
  issuerCn?: string;
  subject?: string;
  sans: string[];
  validFrom?: string;
  validTo?: string;
  serial?: string;
  protocol?: string | null;
  alpn?: string | false | null;
  /** 证书链按 Node 内置根证书校验的结果（不含主机名） */
  chainTrusted?: boolean;
  chainError?: string | null;
  latencyMs?: number;
}

export interface TlsDetectorOptions {
  now?: () => number;
  /** 握手实现（测试注入） */
  handshake?: (t: TlsTarget, timeoutMs: number) => Promise<HandshakeResult>;
  /** renew-status.json 读取（测试注入） */
  readRenewStatus?: () => Promise<{ ok?: boolean; at?: string; exitCode?: number } | undefined>;
  /** 结果缓存（默认 300 秒 = registry probe.intervalSec） */
  cacheMs?: number;
  timeoutMs?: number;
}

/** 证书 DN 字段可能是数组（多值 RDN）：取第一个 */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** node:tls 握手：不拒绝任何证书，读出后由感知器判断（等价于 openssl s_client -servername …） */
export function nodeHandshake(t: TlsTarget, timeoutMs: number): Promise<HandshakeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: HandshakeResult) => {
      if (done) return;
      done = true;
      resolve({ ...r, latencyMs: Date.now() - started });
    };
    const s = tls.connect({
      host: t.host, port: t.port, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'],
      ...(t.servername && !/^\d+\.\d+\.\d+\.\d+$/.test(t.servername) ? { servername: t.servername } : {}),
    }, () => {
      const c = s.getPeerCertificate(false);
      const sans = typeof c.subjectaltname === 'string'
        ? c.subjectaltname.split(/,\s*/).map((x) => x.replace(/^(DNS|IP Address):/, '').toLowerCase()) : [];
      finish({
        entry: t.entry, host: t.host, port: t.port, ...(t.servername ? { servername: t.servername } : {}), ok: true,
        issuer: first(c.issuer?.O) ?? first(c.issuer?.CN), issuerCn: first(c.issuer?.CN), subject: first(c.subject?.CN), sans,
        validFrom: c.valid_from ? new Date(c.valid_from).toISOString() : undefined,
        validTo: c.valid_to ? new Date(c.valid_to).toISOString() : undefined,
        serial: c.serialNumber, protocol: s.getProtocol(), alpn: s.alpnProtocol ?? null,
        chainTrusted: s.authorized, chainError: s.authorized ? null : String(s.authorizationError ?? ''),
      });
      s.end();
    });
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      finish({ entry: t.entry, host: t.host, port: t.port, ok: false, error: 'TIMEOUT', sans: [] });
    });
    s.once('error', (e: NodeJS.ErrnoException) => finish({ entry: t.entry, host: t.host, port: t.port, ok: false, error: e.code ?? e.message, sans: [] }));
  });
}

/** SAN 是否覆盖主机名（支持单层通配符 *.example.com） */
export function sanCovers(sans: readonly string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return sans.some((s) => {
    const n = s.toLowerCase();
    if (n === h) return true;
    if (n.startsWith('*.')) {
      const rest = n.slice(2);
      const i = h.indexOf('.');
      return i > 0 && h.slice(i + 1) === rest;
    }
    return false;
  });
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isAmazon(r: HandshakeResult): boolean {
  return /amazon/i.test(`${r.issuer ?? ''} ${r.issuerCn ?? ''}`);
}

function isLetsEncrypt(r: HandshakeResult): boolean {
  return /let'?s encrypt/i.test(`${r.issuer ?? ''} ${r.issuerCn ?? ''}`);
}

/** 证书来源的短名：acme / acm / letsencrypt / cf-default / selfsigned */
function certKind(r: HandshakeResult, entry: TlsEntry): string {
  if (!r.ok) return 'unknown';
  if (entry === 'cdn' && r.sans.some((s) => s === '*.cloudfront.net')) return 'cf-default';
  if (isAmazon(r)) return entry === 'direct' ? 'acme' : 'acm';
  if (isLetsEncrypt(r)) return 'letsencrypt';
  return r.chainTrusted ? 'trusted' : 'selfsigned';
}

export class TlsDetector implements Detector {
  readonly module = 'tls' as const;
  private readonly now: () => number;
  private readonly handshake: (t: TlsTarget, timeoutMs: number) => Promise<HandshakeResult>;
  private readonly readRenewStatus: () => Promise<{ ok?: boolean; at?: string; exitCode?: number } | undefined>;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private cache?: { at: number; results: HandshakeResult[] };

  constructor(protected readonly ctx: DetectorContext, opts: TlsDetectorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.handshake = opts.handshake ?? nodeHandshake;
    this.cacheMs = opts.cacheMs ?? 300_000;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    const file = path.join(ctx.cfg.core.CLOUDALBUM_DATA_DIR, 'tls', 'renew-status.json');
    this.readRenewStatus = opts.readRenewStatus ?? (async () => {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as { ok?: boolean; at?: string; exitCode?: number };
      } catch {
        return undefined;
      }
    });
  }

  /** 要握手的入口（直连永远在；其余按配置） */
  targets(): TlsTarget[] {
    const cfg = this.ctx.cfg;
    const env = this.ctx.env;
    const domain = cfg.infra.TLS_DOMAIN.toLowerCase();
    const out: TlsTarget[] = [{ entry: 'direct', host: '127.0.0.1', port: 443, ...(domain ? { servername: domain } : {}) }];
    const cdn = hostOf(cfg.core.CDN_BASE_URL);
    if (cdn) out.push({ entry: 'cdn', host: cdn, port: 443, servername: cdn });
    const lb = (env.LB_DNS_NAME ?? '').toLowerCase();
    if (lb && cfg.core.LB_MODE === 'alb' && cfg.infra.LB_HTTPS === 'true') out.push({ entry: 'alb', host: lb, port: 443, servername: domain || lb });
    const base = cfg.core.APP_BASE_URL;
    const entryHost = base.startsWith('https://') ? hostOf(base) : '';
    if (entryHost && entryHost !== cdn && entryHost !== 'localhost' && !out.some((t) => t.host === entryHost)) {
      out.push({ entry: 'entry', host: entryHost, port: 443, servername: entryHost });
    }
    return out;
  }

  private async results(deep: boolean): Promise<HandshakeResult[]> {
    const c = this.cache;
    if (!deep && c && this.now() - c.at < this.cacheMs) return c.results;
    const results = await Promise.all(this.targets().map((t) => this.handshake(t, this.timeoutMs)
      .catch((e: unknown) => ({ entry: t.entry, host: t.host, port: t.port, ok: false, error: (e as Error)?.message ?? 'error', sans: [] }) as HandshakeResult)));
    this.cache = { at: this.now(), results };
    return results;
  }

  async detect(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const cfg = this.ctx.cfg;
    const acmeOn = cfg.core.TLS_MODE === 'acm' && cfg.core.TLS_ACME === 'on';
    const domain = cfg.infra.TLS_DOMAIN.toLowerCase();
    const results = await this.results(Boolean(opts.deep));
    const nowMs = this.now();
    const problems: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    let transient = false;
    let confidence: ProbeResult['confidence'] = 'observed';
    const degrade = (why: string) => {
      if (status === 'ok') status = 'degraded';
      problems.push(why);
    };
    const fail = (why: string, isTransient = false) => {
      status = 'error';
      problems.push(why);
      if (isTransient) transient = true;
    };

    const entries = results.map((r) => {
      const daysLeft = r.validTo ? Math.floor((Date.parse(r.validTo) - nowMs) / DAY_MS) : undefined;
      const lifetimeDays = r.validTo && r.validFrom ? Math.round((Date.parse(r.validTo) - Date.parse(r.validFrom)) / DAY_MS) : undefined;
      const kind = certKind(r, r.entry);
      return { ...r, daysLeft, lifetimeDays, kind };
    });

    for (const e of entries) {
      const label = `${e.entry}（${e.host}${e.port !== 443 ? `:${e.port}` : ''}）`;
      if (!e.ok) {
        const net = NETWORK_CODES.has(String(e.error)) || e.error === 'TIMEOUT';
        fail(`${label} 握手失败：${e.error}`, net);
        continue;
      }
      if (e.daysLeft !== undefined && e.daysLeft < 0) {
        fail(`${label} 证书已过期（${e.validTo}）`);
        continue;
      }
      // TLS_ACME=on 但直连仍是旧证书：只降级（01#tls 第 3 节：符号链接未切换或 reload 失败），不再判断域名
      if (e.entry === 'direct' && acmeOn && !isAmazon(e)) {
        degrade(`TLS_ACME=on，但直连证书的签发者是 ${e.issuer ?? '未知'}（不是 Amazon）：证书符号链接未切换或 Nginx 未 reload`);
        continue;
      }
      // 域名匹配：直连在 TLS_ACME=on 时必须覆盖 TLS_DOMAIN；其他入口必须覆盖它的主机名
      const want = e.entry === 'direct' ? (acmeOn ? domain : '') : (e.servername ?? e.host);
      if (want && !sanCovers(e.sans, want)) fail(`${label} 证书 SAN（${e.sans.slice(0, 3).join(', ') || '无'}）不覆盖 ${want}`);
      // 续期窗口：短期证书（ACME 45 天、Let's Encrypt）按寿命的 1/3 + 2 天余量；ACM 集成证书（198 天）按 30 天
      if (e.daysLeft !== undefined && e.lifetimeDays !== undefined && e.kind !== 'selfsigned' && e.kind !== 'cf-default') {
        const managed = e.entry !== 'direct' && isAmazon(e);
        const window = managed ? 30 : Math.max(1, Math.floor(e.lifetimeDays / 3) - 2);
        if (e.daysLeft < window) degrade(`${label} 证书只剩 ${e.daysLeft} 天，已过续期点仍未续期（${managed ? 'ACM 托管续期：检查验证 CNAME 与 InUseBy' : 'certbot：检查 cloudalbum-tls-renew.timer'}）`);
      }
    }

    // certbot 定时器（ACME 或 Let's Encrypt 证书在 Nginx 上时）
    const direct = entries.find((e) => e.entry === 'direct');
    if (acmeOn || direct?.kind === 'letsencrypt') {
      const renew = await this.readRenewStatus();
      if (renew && renew.ok === false) degrade(`cloudalbum-tls-renew 最近一次运行失败（${renew.at ?? '?'}，退出码 ${String(renew.exitCode ?? '?')}）`);
    }

    // 终止点与来源（约定 4：<TLS_MODE>@<终止点>[:<证书>]）
    const effective = hostOf(cfg.core.APP_BASE_URL);
    const viaCdn = entries.find((e) => e.entry === 'cdn' && (e.host === effective || !cfg.core.APP_BASE_URL.startsWith('https://')));
    const front = viaCdn ?? entries.find((e) => e.entry === 'entry') ?? direct;
    const via = front?.entry === 'cdn'
      ? (front.kind === 'cf-default' ? 'selfsigned@cloudfront:cf-default' : 'acm@cloudfront')
      : front?.entry === 'alb' ? 'acm@alb'
        : direct?.kind === 'acme' ? 'acm@nginx:acme' : direct?.kind === 'letsencrypt' ? 'letsencrypt@nginx' : 'selfsigned@nginx';
    const trusted = Boolean(front?.ok && front.chainTrusted && (front.entry !== 'direct' || front.kind !== 'selfsigned'));

    const data: Record<string, unknown> = {
      mode: cfg.core.TLS_MODE, acme: cfg.core.TLS_ACME, domain, via, trusted, forceHttps: cfg.infra.TLS_FORCE_HTTPS,
      ...(cfg.core.TLS_ACME_DIRECTORY_URL ? { acmeDirectoryUrl: cfg.core.TLS_ACME_DIRECTORY_URL } : {}),
      ...(cfg.tls.ACM_CERT_ARN_EDGE ? { certArnEdge: cfg.tls.ACM_CERT_ARN_EDGE } : {}),
      ...(cfg.tls.ACM_CERT_ARN_REGIONAL ? { certArnRegional: cfg.tls.ACM_CERT_ARN_REGIONAL } : {}),
      entries: entries.map((e) => ({
        entry: e.entry, host: e.host, ok: e.ok, ...(e.error ? { error: e.error } : {}), issuer: e.issuer, subject: e.subject, sans: e.sans,
        notAfter: e.validTo, daysLeft: e.daysLeft, lifetimeDays: e.lifetimeDays, protocol: e.protocol, alpn: e.alpn, kind: e.kind,
        chainTrusted: e.chainTrusted, renewal: e.kind === 'acm' ? 'ACM 托管' : e.kind === 'acme' || e.kind === 'letsencrypt' ? 'certbot 定时器' : '—',
        latencyMs: e.latencyMs,
      })),
    };

    if (opts.deep) {
      data.deep = true;
      if (!this.ctx.aws.enabled) {
        degrade('无凭证：控制面感知不可用（CRED-004）');
      } else {
        const r = await this.deepCheck(acmeOn, domain);
        Object.assign(data, r.data);
        for (const d of r.degraded) degrade(d);
        if (r.error) fail(r.error);
        if (r.transient) transient = true;
        if (r.confirmed) confidence = 'confirmed';
      }
    }

    const summary = entries.map((e) => (e.ok ? `${e.entry}=${e.kind}${e.daysLeft !== undefined ? `（剩 ${e.daysLeft} 天）` : ''}` : `${e.entry}=握手失败`)).join(' · ');
    return {
      status,
      detail: `${via} · ${summary}${problems.length ? ` · ${problems.join('；')}` : ''}`,
      confidence,
      data,
      ...(transient && status !== 'ok' ? { transient: true } : {}),
    };
  }

  private async deepCheck(acmeOn: boolean, domain: string): Promise<{ data: Record<string, unknown>; degraded: string[]; error?: string; transient: boolean; confirmed: boolean }> {
    const cfg = this.ctx.cfg;
    const out: { data: Record<string, unknown>; degraded: string[]; error?: string; transient: boolean; confirmed: boolean } = {
      data: {}, degraded: [], transient: false, confirmed: false,
    };
    const retry = { attempts: 2, timeoutMs: 1800 } as const;
    let sdk: typeof import('@aws-sdk/client-acm');
    try {
      sdk = await loadAwsPackage('@aws-sdk/client-acm', () => import('@aws-sdk/client-acm'));
    } catch (e) {
      out.degraded.push(`ACM SDK 不可用：${(e as Error).message}`);
      return out;
    }
    const certs: Array<{ role: 'edge' | 'regional'; arn: string; region?: string }> = [];
    if (cfg.tls.ACM_CERT_ARN_EDGE) certs.push({ role: 'edge', arn: cfg.tls.ACM_CERT_ARN_EDGE, region: 'us-east-1' });
    if (cfg.tls.ACM_CERT_ARN_REGIONAL) certs.push({ role: 'regional', arn: cfg.tls.ACM_CERT_ARN_REGIONAL });
    const integration: Record<string, unknown> = {};
    await Promise.all(certs.map(async (c) => {
      try {
        const acm = await this.ctx.aws.acm(c.region ? { region: c.region } : undefined);
        const r = await withAwsRetry(() => acm.send(new sdk.DescribeCertificateCommand({ CertificateArn: c.arn })), retry);
        out.confirmed = true;
        const d = r.Certificate;
        const renewal = d?.RenewalSummary?.RenewalStatus;
        const failedValidation = (d?.DomainValidationOptions ?? []).filter((v) => v.ValidationStatus === 'FAILED').map((v) => v.DomainName);
        integration[c.role] = {
          arn: c.arn, status: d?.Status, notAfter: d?.NotAfter?.toISOString?.(), renewalStatus: renewal, renewalEligibility: d?.RenewalEligibility,
          inUseBy: d?.InUseBy ?? [], validation: (d?.DomainValidationOptions ?? []).map((v) => ({ domain: v.DomainName, status: v.ValidationStatus, record: v.ResourceRecord?.Name })),
        };
        if (d?.Status && ['REVOKED', 'EXPIRED', 'FAILED', 'VALIDATION_TIMED_OUT'].includes(d.Status)) out.error = `${c.role} 证书状态 ${d.Status}（${c.arn}）`;
        else if (d?.Status === 'PENDING_VALIDATION') out.degraded.push(`${c.role} 证书等待 DNS 验证：把验证 CNAME 加到你的 DNS`);
        if (renewal === 'FAILED' || renewal === 'PENDING_VALIDATION') out.degraded.push(`${c.role} 证书续期状态 ${renewal}（验证 CNAME 被删除？）`);
        if (failedValidation.length) out.degraded.push(`${c.role} 证书的验证失败：${failedValidation.join(', ')}`);
        if (d?.Status === 'ISSUED' && !(d.InUseBy ?? []).length) out.degraded.push(`${c.role} 证书没有被任何服务使用（InUseBy 为空）：ACM 不会托管续期`);
      } catch (e) {
        if (isAwsNotFound(e)) out.error = `${c.role} 证书不存在（${c.arn}）`;
        else {
          out.degraded.push(`DescribeCertificate（${c.role}）失败：${describeAwsError(e)}`);
          if (isAwsTransient(e)) out.transient = true;
        }
      }
    }));
    if (certs.length) out.data.integration = integration;

    if (acmeOn) {
      try {
        const acm = await this.ctx.aws.acm();
        const r = await withAwsRetry(() => acm.send(new sdk.SearchCertificatesCommand({
          FilterStatement: { Filter: { AcmCertificateMetadataFilter: { CertificateKeyPairOrigin: 'ACME' } } }, MaxResults: 50,
        })), retry);
        out.confirmed = true;
        const mine = (r.Results ?? []).filter((x) => {
          const names = [x.X509Attributes?.Subject?.CommonName, ...(x.X509Attributes?.SubjectAlternativeNames ?? []).map((g) => g.DnsName)]
            .filter((n): n is string => Boolean(n)).map((n) => n.toLowerCase());
          return names.includes(domain);
        });
        const issued = mine.filter((x) => x.CertificateMetadata?.AcmCertificateMetadata?.Status === 'ISSUED');
        out.data.acmeCertificates = mine.map((x) => ({
          arn: x.CertificateArn, status: x.CertificateMetadata?.AcmCertificateMetadata?.Status,
          notAfter: x.X509Attributes?.NotAfter?.toISOString?.(), endpoint: x.CertificateMetadata?.AcmCertificateMetadata?.AcmeEndpointArn,
        }));
        if (!mine.length) out.degraded.push(`ACM 中找不到 ${domain} 的 ACME 证书（SearchCertificates，CertificateKeyPairOrigin=ACME）`);
        else if (!issued.length) out.error = `${domain} 的 ACME 证书都不是 ISSUED（${mine.map((x) => x.CertificateMetadata?.AcmCertificateMetadata?.Status).join(', ')}）`;
      } catch (e) {
        out.degraded.push(`SearchCertificates 失败：${describeAwsError(e)}`);
        if (isAwsTransient(e)) out.transient = true;
      }
    }
    return out;
  }
}

export const tlsDetector: DetectorFactory = { module: 'tls', create: (ctx) => new TlsDetector(ctx) };
