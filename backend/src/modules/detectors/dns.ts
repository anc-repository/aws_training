// backend/src/modules/detectors/dns.ts —— dns 感知器（总纲 3.3；01#dns 第 1、3、10 节）
//
// 只在 DNS_PROVIDER=route53 时运行（本地档 external 不运行感知器，总纲 3.3）。
// 被动（observe，每个请求 O(1) 计数，保留最近 5 分钟）：请求的 Host 是记录名、IP 字面量、EC2 公网主机名还是其他名字
//   ——看出多少用户仍在用 IP 访问（只写 detail，不降级）。
// 主动（常规 60 秒）：node:dns 的 resolve4(host, { ttl: true })（服务端视角，实例所在 VPC 的解析器），比较解析结果与
//   DNS_TARGET_TYPE：eip → 实例当前公网 IPv4（IMDS public-ipv4，取不到时用 DNS_TARGET_IP）；alb → LB_DNS_NAME 的解析结果；
//   cloudfront → 反向解析落在 *.cloudfront.net，或与 CDN 域名的解析结果相交。不一致 → degraded（记录尚未传播或指向旧目标）；
//   NXDOMAIN 持续超过 TTL（至少 60 秒）→ error；解析器超时 / SERVFAIL → degraded + transient（2026-10-14 实机验证的教训：
//   一次超时不报 error）。不需要凭证。
// 深度（管理员 ?deep=1 与 enable 的健康检查阶段）：route53:GetHostedZone（不存在 → error；委派 NS 与托管区域不一致 → degraded）、
//   ListResourceRecordSets（记录缺失 → degraded）、GetHealthCheckStatus（有检查器报告 Failure → degraded）；全部经 withAwsRetry，
//   Route 53 控制面在 us-east-1。无凭证时跳过并降为 degraded（CRED-004）。
// 预算（wave1-fix）：解析、IMDS 与 Route 53 读取整体放在后台（adapters/aws/background-probe.ts），探针最多等 1.5 秒（深度 4 秒），
//   不占用能力注册表 2 秒的探针预算；没等到时返回上一次的结果或 degraded + transient。
import { Resolver } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { BackgroundProbe } from '../../adapters/aws/background-probe.js';
import { describeAwsError, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry } from '../../adapters/aws/clients.js';
import type { ProbeResult } from '../../ports/common.js';
import { ImdsClient } from './ec2.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

const BUCKET_MS = 10_000;
const BUCKETS = 30;                               // 30 × 10 秒 = 5 分钟
const CLOUDFRONT_ZONE = 'Z2FDTNDATAQYW2';
const TRANSIENT_DNS = new Set(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EREFUSED', 'ECANCELLED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET']);
const NXDOMAIN = new Set(['ENOTFOUND', 'ENODATA']);

interface Bucket { slot: number; total: number; record: number; ip: number; ec2Name: number; other: number }

export interface DnsPassiveStats { requests5m: number; byRecord5m: number; byIp5m: number; byEc2Name5m: number; other5m: number; ipShare5m: number | null }

/** 可注入的解析器（测试用）；缺省为 node:dns/promises 的 Resolver（1 秒超时、2 次尝试）。 */
export interface DnsResolverLike {
  resolve4(host: string, opts: { ttl: true }): Promise<Array<{ address: string; ttl: number }>>;
  resolveNs(host: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
}

export interface DnsDetectorOptions {
  now?: () => number;
  resolver?: DnsResolverLike;
  /** 实例当前公网 IPv4（缺省读 IMDS public-ipv4，10 分钟缓存） */
  publicIp?: () => Promise<string | undefined>;
  /** 单次解析的超时（默认 1500 ms：常规探针的整体超时是 2 秒） */
  timeoutMs?: number;
}

export class DnsTimeoutError extends Error {
  readonly code = 'ETIMEOUT';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new DnsTimeoutError(`DNS 查询超时（${ms} ms）`)), ms);
      t.unref?.();
    }),
  ]).finally(() => { if (t) clearTimeout(t); });
}

function header(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Host 头 → 小写主机名（去掉端口与 IPv6 方括号） */
export function hostOfHeader(raw: string | undefined): string {
  if (!raw) return '';
  const h = raw.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  const i = h.lastIndexOf(':');
  return i > 0 && h.indexOf(':') === i ? h.slice(0, i) : h;
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function hostOfUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function errCode(e: unknown): string {
  return String((e as { code?: unknown } | null)?.code ?? (e as { name?: unknown } | null)?.name ?? 'Error');
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\.$/, '');

export class DnsDetector implements Detector {
  readonly module = 'dns' as const;
  private readonly buckets: Bucket[] = Array.from({ length: BUCKETS }, () => ({ slot: -1, total: 0, record: 0, ip: 0, ec2Name: 0, other: 0 }));
  private readonly now: () => number;
  private readonly resolver: DnsResolverLike;
  private readonly timeoutMs: number;
  private readonly publicIpFn: () => Promise<string | undefined>;
  private nxSince: number | undefined;
  private cachedIp?: { value: string | undefined; at: number };
  private readonly bg: BackgroundProbe;

  constructor(protected readonly ctx: DetectorContext, opts: DnsDetectorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.bg = new BackgroundProbe({ label: 'DNS 解析与 Route 53 控制面', now: this.now });
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.resolver = opts.resolver ?? (new Resolver({ timeout: 1000, tries: 2 }) as unknown as DnsResolverLike);
    if (opts.publicIp) {
      this.publicIpFn = opts.publicIp;
    } else {
      const imds = new ImdsClient({ timeoutMs: 500, retries: 1 });
      this.publicIpFn = () => imds.text('/latest/meta-data/public-ipv4');
    }
  }

  private recordName(): string {
    return norm(this.ctx.cfg.dns.DNS_RECORD_NAME) || hostOfUrl(this.ctx.cfg.core.APP_BASE_URL);
  }

  // ------------------------------------------------------------------------------------------ passive
  private bucket(): Bucket {
    const slot = Math.floor(this.now() / BUCKET_MS);
    const b = this.buckets[slot % BUCKETS]!;
    if (b.slot !== slot) Object.assign(b, { slot, total: 0, record: 0, ip: 0, ec2Name: 0, other: 0 });
    return b;
  }

  observe(req: { headers: IncomingHttpHeaders; remoteAddr: string }): void {
    const host = hostOfHeader(header(req.headers, 'host'));
    if (!host) return;
    const b = this.bucket();
    b.total += 1;
    if (host === this.recordName()) b.record += 1;
    else if (isIpLiteral(host)) b.ip += 1;
    else if (host.endsWith('.amazonaws.com')) b.ec2Name += 1;
    else b.other += 1;
  }

  stats(): DnsPassiveStats {
    const minSlot = Math.floor(this.now() / BUCKET_MS) - (BUCKETS - 1);
    const s = { total: 0, record: 0, ip: 0, ec2Name: 0, other: 0 };
    for (const b of this.buckets) {
      if (b.slot < minSlot) continue;
      s.total += b.total; s.record += b.record; s.ip += b.ip; s.ec2Name += b.ec2Name; s.other += b.other;
    }
    return {
      requests5m: s.total, byRecord5m: s.record, byIp5m: s.ip, byEc2Name5m: s.ec2Name, other5m: s.other,
      ipShare5m: s.total ? Math.round(((s.ip + s.ec2Name) / s.total) * 1000) / 1000 : null,
    };
  }

  observations(): Record<string, unknown> {
    const s = this.stats();
    return { requests5m: s.requests5m, ipShare5m: s.ipShare5m };
  }

  // ------------------------------------------------------------------------------------------ active
  private async publicIp(): Promise<string | undefined> {
    const c = this.cachedIp;
    if (c && this.now() - c.at < 600_000 && c.value) return c.value;
    const v = await withTimeout(this.publicIpFn(), this.timeoutMs).catch(() => undefined);
    this.cachedIp = { value: v || undefined, at: this.now() };
    return v || undefined;
  }

  private async resolveAddrs(host: string): Promise<string[]> {
    const r = await withTimeout(this.resolver.resolve4(host, { ttl: true }), this.timeoutMs);
    return r.map((x) => x.address);
  }

  /** 解析结果是否指向 DNS_TARGET_TYPE 的目标；undefined = 无法判断（只观察） */
  private async targetMatch(type: string, answers: string[]): Promise<{ match: boolean | undefined; expected: string; why: string }> {
    const env = this.ctx.env;
    if (type === 'eip') {
      const ip = (await this.publicIp()) ?? (env.DNS_TARGET_IP || undefined);
      if (!ip) return { match: undefined, expected: 'EIP（未知：不在 EC2 上且没有 DNS_TARGET_IP）', why: '' };
      return { match: answers.includes(ip), expected: ip, why: `期望 EIP ${ip}` };
    }
    if (type === 'alb') {
      const lb = norm(env.LB_DNS_NAME);
      if (!lb) return { match: undefined, expected: 'ALB（LB_DNS_NAME 未知）', why: '' };
      const lbAddrs = await this.resolveAddrs(lb).catch(() => [] as string[]);
      if (!lbAddrs.length) return { match: undefined, expected: lb, why: `无法解析 ${lb}` };
      return { match: answers.some((a) => lbAddrs.includes(a)), expected: lb, why: `期望与 ${lb} 的地址相交` };
    }
    // cloudfront：Alias 直接返回边缘地址；反向解析落在 *.cloudfront.net，或与分配域名的解析结果相交
    const cdnHost = hostOfUrl(this.ctx.cfg.core.CDN_BASE_URL);
    const [ptr, cdnAddrs] = await Promise.all([
      answers[0] ? withTimeout(this.resolver.reverse(answers[0]), this.timeoutMs).catch(() => [] as string[]) : Promise.resolve([] as string[]),
      cdnHost && cdnHost !== this.recordName() ? this.resolveAddrs(cdnHost).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    ]);
    const viaPtr = ptr.some((n) => norm(n).endsWith('.cloudfront.net'));
    const viaSet = answers.some((a) => cdnAddrs.includes(a));
    if (!ptr.length && !cdnAddrs.length) return { match: undefined, expected: 'CloudFront', why: '' };
    return { match: viaPtr || viaSet, expected: cdnHost || 'CloudFront', why: '期望 CloudFront 边缘地址' };
  }

  async detect(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    return this.bg.run(() => this.detectNow(opts), opts.deep ? { deep: true } : {});
  }

  private async detectNow(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const cfg = this.ctx.cfg;
    const record = this.recordName();
    const type = cfg.infra.DNS_TARGET_TYPE;
    const ttlConf = cfg.dns.DNS_TTL ?? 60;
    const passive = this.stats();
    const data: Record<string, unknown> = {
      provider: cfg.core.DNS_PROVIDER, recordName: record, targetType: type, routingPolicy: cfg.dns.DNS_ROUTING_POLICY,
      ttl: ttlConf, appBaseUrl: cfg.core.APP_BASE_URL, canonicalRedirect: cfg.dns.DNS_CANONICAL_REDIRECT,
      ...(cfg.dns.DNS_HOSTED_ZONE_ID ? { hostedZoneId: cfg.dns.DNS_HOSTED_ZONE_ID } : {}),
      ...(cfg.dns.DNS_HEALTH_CHECK_ID ? { healthCheckId: cfg.dns.DNS_HEALTH_CHECK_ID } : {}),
      passive,
    };
    const problems: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    let transient = false;
    let confidence: ProbeResult['confidence'] = 'observed';
    const degrade = (why: string) => {
      if (status === 'ok') status = 'degraded';
      problems.push(why);
    };
    const fail = (why: string) => {
      status = 'error';
      problems.push(why);
    };

    if (!record) {
      return { status: 'error', detail: 'DNS_RECORD_NAME 与 APP_BASE_URL 都没有主机名（dns.env 不完整，重新执行 scripts/module enable dns --domain …）', data };
    }

    // ---- 主动解析（服务端视角）
    let resolution: Record<string, unknown>;
    try {
      const answers = await withTimeout(this.resolver.resolve4(record, { ttl: true }), this.timeoutMs);
      this.nxSince = undefined;
      const addrs = answers.map((a) => a.address);
      const ttlRemaining = answers.length ? Math.min(...answers.map((a) => a.ttl)) : undefined;
      const m = await this.targetMatch(type, addrs);
      resolution = { answers: addrs, ttlRemaining, expected: m.expected, match: m.match ?? null };
      if (m.match === false) {
        if (cfg.dns.DNS_ROUTING_POLICY === 'weighted') problems.push(`加权路由：本次解析 ${addrs.join(', ')}（${m.why}）`);
        else degrade(`解析结果 ${addrs.join(', ') || '（空）'} 与 DNS_TARGET_TYPE=${type} 不一致：记录尚未传播或指向旧目标（${m.why}）`);
      }
      if (m.match === undefined) confidence = 'inferred';
    } catch (e) {
      const code = errCode(e);
      resolution = { error: code };
      if (NXDOMAIN.has(code)) {
        this.nxSince ??= this.now();
        const windowMs = Math.max(ttlConf, 60) * 1000;
        const since = Math.round((this.now() - this.nxSince) / 1000);
        if (this.now() - this.nxSince >= windowMs) fail(`${record} 无法解析（${code}）且已持续 ${since} 秒，超过 TTL：检查 NS 委派与记录`);
        else degrade(`${record} 暂时无法解析（${code}）：委派或记录可能尚未生效`);
      } else if (TRANSIENT_DNS.has(code) || e instanceof DnsTimeoutError) {
        transient = true;
        degrade(`解析 ${record} 失败（${code}，瞬时）：下次探针重试`);
      } else {
        degrade(`解析 ${record} 失败：${code}`);
      }
    }
    data.resolution = resolution;

    // ---- 深度：Route 53 控制面（us-east-1）
    if (opts.deep) {
      data.deep = true;
      if (!this.ctx.aws.enabled) {
        degrade('无凭证：控制面感知不可用（CRED-004）');
      } else {
        const r = await this.deepCheck(record);
        Object.assign(data, r.data);
        if (r.error) fail(r.error);
        for (const d of r.degraded) degrade(d);
        if (r.transient) transient = true;
        if (r.confirmed) confidence = 'confirmed';
      }
    }

    const p = passive;
    const share = p.requests5m
      ? `最近 5 分钟 ${p.requests5m} 个请求中 ${p.byRecord5m} 个用域名、${p.byIp5m + p.byEc2Name5m} 个用 IP 或 EC2 主机名`
      : '最近 5 分钟没有请求';
    const res = resolution.answers ? `${record} → ${(resolution.answers as string[]).join(', ') || '（空）'}（剩余 TTL ${String(resolution.ttlRemaining ?? '?')} 秒）` : `${record} 未解析`;
    return {
      status,
      detail: `${res} · ${share}${problems.length ? ` · ${problems.join('；')}` : ''}`,
      confidence,
      data,
      ...(transient && status !== 'ok' ? { transient: true } : {}),
    };
  }

  private async deepCheck(record: string): Promise<{ data: Record<string, unknown>; degraded: string[]; error?: string; transient: boolean; confirmed: boolean }> {
    const cfg = this.ctx.cfg;
    const out: { data: Record<string, unknown>; degraded: string[]; error?: string; transient: boolean; confirmed: boolean } = {
      data: {}, degraded: [], transient: false, confirmed: false,
    };
    const zoneId = (cfg.dns.DNS_HOSTED_ZONE_ID ?? '').replace(/^\/?hostedzone\//, '');
    if (!zoneId) {
      out.degraded.push('DNS_HOSTED_ZONE_ID 为空：无法核对托管区域');
      return out;
    }
    const retry = { attempts: 3, timeoutMs: 3000 } as const;     // 在后台进行，可以用完整的重试
    try {
      const sdk = await loadAwsPackage('@aws-sdk/client-route-53', () => import('@aws-sdk/client-route-53'));
      const r53 = await this.ctx.aws.route53({ region: 'us-east-1' });
      const [zone, records, hc] = await Promise.all([
        withAwsRetry(() => r53.send(new sdk.GetHostedZoneCommand({ Id: zoneId })), retry),
        withAwsRetry(() => r53.send(new sdk.ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: record, MaxItems: 10 })), retry)
          .catch((e: unknown) => e as Error),
        cfg.dns.DNS_HEALTH_CHECK_ID
          ? withAwsRetry(() => r53.send(new sdk.GetHealthCheckStatusCommand({ HealthCheckId: cfg.dns.DNS_HEALTH_CHECK_ID! })), retry)
            .catch((e: unknown) => e as Error)
          : Promise.resolve(undefined),
      ]);
      out.confirmed = true;
      const zoneName = norm(zone.HostedZone?.Name);
      const nameServers = (zone.DelegationSet?.NameServers ?? []).map(norm);
      out.data.zone = { id: zoneId, name: zoneName, private: zone.HostedZone?.Config?.PrivateZone ?? false, nameServers };
      // 委派：公共解析器看到的 NS 与托管区域的 NS 是否一致（新建托管区域后要到注册商 / 父域添加 NS 委派）
      if (zoneName && nameServers.length) {
        const seen = await withTimeout(this.resolver.resolveNs(zoneName), this.timeoutMs).catch(() => [] as string[]);
        const ok = seen.length > 0 && seen.map(norm).every((n) => nameServers.includes(n));
        out.data.delegation = { seen: seen.map(norm), ok };
        if (!ok) out.degraded.push(`委派 NS（${seen.map(norm).join(', ') || '无'}）与托管区域的 NS 不一致：到注册商或父域添加 / 修正 NS 委派`);
      }
      if (records instanceof Error) {
        out.degraded.push(`ListResourceRecordSets 失败：${describeAwsError(records)}`);
        if (isAwsTransient(records)) out.transient = true;
      } else {
        const mine = (records?.ResourceRecordSets ?? []).filter((x) => norm(x.Name) === record && (x.Type === 'A' || x.Type === 'AAAA'));
        out.data.records = mine.map((x) => ({
          type: x.Type, setIdentifier: x.SetIdentifier, failover: x.Failover, weight: x.Weight, ttl: x.TTL,
          values: x.ResourceRecords?.map((v) => v.Value), alias: x.AliasTarget ? { dnsName: norm(x.AliasTarget.DNSName), zone: x.AliasTarget.HostedZoneId } : undefined,
          aliasTo: x.AliasTarget?.HostedZoneId === CLOUDFRONT_ZONE ? 'cloudfront' : undefined,
        }));
        if (!mine.length) out.degraded.push(`托管区域中没有 ${record} 的 A / AAAA 记录`);
      }
      if (hc instanceof Error) {
        out.degraded.push(`GetHealthCheckStatus 失败：${describeAwsError(hc)}`);
        if (isAwsTransient(hc)) out.transient = true;
      } else if (hc) {
        const reports = (hc.HealthCheckObservations ?? []).map((o) => ({ region: o.Region, status: o.StatusReport?.Status ?? '' }));
        const failing = reports.filter((x) => /^Failure/i.test(x.status));
        out.data.healthCheck = { id: cfg.dns.DNS_HEALTH_CHECK_ID, checkers: reports.length, failing: failing.length };
        if (failing.length) out.degraded.push(`健康检查：${failing.length}/${reports.length} 个检查器报告 Failure（${failing[0]?.status.slice(0, 80)}）`);
      }
    } catch (e) {
      if (isAwsNotFound(e)) {
        out.error = `托管区域 ${zoneId} 不存在（NoSuchHostedZone）`;
        out.confirmed = true;
      } else {
        out.degraded.push(`GetHostedZone 失败：${describeAwsError(e)}`);
        if (isAwsTransient(e)) out.transient = true;
      }
    }
    return out;
  }
}

export const dnsDetector: DetectorFactory = { module: 'dns', create: (ctx) => new DnsDetector(ctx) };
