// backend/src/modules/detectors/cdn.ts —— cdn 感知器（总纲 3.3：参数型模块的被动感知，与 CdnPort 的主动探针互补；01#cdn 第 10 节）
//
// 请求头感知（observe，每个请求 O(1) 计数，保留最近 5 分钟）：
//   - 经 8080 监听器 / CloudFront 进入的请求：Nginx 计算的 entry（X-CloudAlbum-Entry，只信任回环地址传来的值）以 `cloudfront>` 开头；
//   - X-Origin-Verify 不匹配的回源：请求带 CloudFront 的 X-Amz-Cf-Id（或 X-Origin-Verify），但 entry 不是 cloudfront>…——
//     说明它经某个 CloudFront 分配到达，却没有通过 $ca_cdn_verified（有人用自己的分配指向我们的源站，SEC-001）。
// 本机感知：CDN_ORIGIN_TYPE=ec2 时 127.0.0.1:CDN_ORIGIN_PORT（8080）是否有监听器（只在 Linux 上检查）。
// 控制面感知：cloudfront:GetDistribution（Deployed / InProgress / 已禁用）；无凭证时降为 observed（CRED-004）。
// observations() 的键（rules.ts 约定）：originVerifyMismatch5m、listener8080Missing（SEC-001），另附 viaCdnRatio5m、requests5m。
import { connect } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { describeAwsError, isAwsNotFound, loadAwsPackage } from '../../adapters/aws/clients.js';
import { isLoopback } from '../../config/net.js';
import type { ProbeResult } from '../../ports/common.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

const BUCKET_MS = 10_000;
const BUCKETS = 30;                               // 30 × 10 秒 = 5 分钟

interface Bucket { slot: number; total: number; viaCdn: number; cfSeen: number; mismatch: number }

export interface CdnPassiveStats { requests5m: number; viaCdn5m: number; viaCdnRatio5m: number | null; cfIdSeen5m: number; originVerifyMismatch5m: number }

export interface CdnDetectorOptions {
  now?: () => number;
  platform?: NodeJS.Platform;
  /** 本机监听器检查（测试注入）：返回是否可连接 */
  probePort?: (host: string, port: number) => Promise<boolean>;
}

function header(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

function tcpReachable(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export class CdnDetector implements Detector {
  readonly module = 'cdn' as const;
  private readonly buckets: Bucket[] = Array.from({ length: BUCKETS }, () => ({ slot: -1, total: 0, viaCdn: 0, cfSeen: 0, mismatch: 0 }));
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly probePort: (host: string, port: number) => Promise<boolean>;
  private listenerMissing = false;
  private listenerCheckedAt = 0;

  constructor(protected readonly ctx: DetectorContext, opts: CdnDetectorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.platform = opts.platform ?? process.platform;
    this.probePort = opts.probePort ?? ((h, p) => tcpReachable(h, p));
  }

  private bucket(): Bucket {
    const slot = Math.floor(this.now() / BUCKET_MS);
    const b = this.buckets[slot % BUCKETS]!;
    if (b.slot !== slot) Object.assign(b, { slot, total: 0, viaCdn: 0, cfSeen: 0, mismatch: 0 });
    return b;
  }

  observe(req: { headers: IncomingHttpHeaders; remoteAddr: string }): void {
    const b = this.bucket();
    b.total += 1;
    const entry = isLoopback(req.remoteAddr) ? (header(req.headers, 'x-cloudalbum-entry') ?? '') : '';
    const viaCdn = entry.startsWith('cloudfront>');
    const cf = Boolean(header(req.headers, 'x-amz-cf-id'));
    if (viaCdn) b.viaCdn += 1;
    if (cf) b.cfSeen += 1;
    if ((cf || header(req.headers, 'x-origin-verify') !== undefined) && !viaCdn) b.mismatch += 1;
  }

  stats(): CdnPassiveStats {
    const minSlot = Math.floor(this.now() / BUCKET_MS) - (BUCKETS - 1);
    let total = 0;
    let viaCdn = 0;
    let cfSeen = 0;
    let mismatch = 0;
    for (const b of this.buckets) {
      if (b.slot < minSlot) continue;
      total += b.total;
      viaCdn += b.viaCdn;
      cfSeen += b.cfSeen;
      mismatch += b.mismatch;
    }
    return {
      requests5m: total, viaCdn5m: viaCdn, viaCdnRatio5m: total ? Math.round((viaCdn / total) * 1000) / 1000 : null,
      cfIdSeen5m: cfSeen, originVerifyMismatch5m: mismatch,
    };
  }

  private async checkListener(): Promise<boolean | undefined> {
    const infra = this.ctx.cfg.infra;
    if (this.platform !== 'linux' || infra.CDN_ORIGIN_TYPE !== 'ec2') return undefined;
    const ok = await this.probePort('127.0.0.1', infra.CDN_ORIGIN_PORT);
    this.listenerMissing = !ok;
    this.listenerCheckedAt = this.now();
    return ok;
  }

  async detect(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const cfg = this.ctx.cfg;
    const baseUrl = cfg.core.CDN_BASE_URL;
    const infra = cfg.infra;
    const passive = this.stats();
    const listener = await this.checkListener();
    const data: Record<string, unknown> = {
      baseUrl, originType: infra.CDN_ORIGIN_TYPE, mediaOrigin: infra.CDN_MEDIA_ORIGIN, directAccess: infra.CDN_DIRECT_ACCESS,
      // admin-ip 时直连只对这个 CIDR 开放（只在管理员视图的 data 中）：waf/bypass 据此区分“从管理 IP 直连可达”与“未锁定”
      ...(infra.CDN_DIRECT_ACCESS === 'admin-ip' && infra.CDN_ADMIN_CIDR ? { adminCidr: infra.CDN_ADMIN_CIDR } : {}),
      ...(infra.CDN_DISTRIBUTION_ID ? { distributionId: infra.CDN_DISTRIBUTION_ID } : {}),
      passive, ...(listener !== undefined ? { listener8080: listener } : {}),
    };
    const problems: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    let confidence: ProbeResult['confidence'] = 'observed';
    const degrade = (why: string) => {
      if (status === 'ok') status = 'degraded';
      problems.push(why);
    };

    if (listener === false) degrade(`127.0.0.1:${infra.CDN_ORIGIN_PORT} 没有监听器（cdn 的 8080 server 块未投放？）`);
    if (passive.originVerifyMismatch5m > 0) degrade(`最近 5 分钟 ${passive.originVerifyMismatch5m} 个经 CloudFront 的回源请求没有通过 X-Origin-Verify（SEC-001）`);
    if (passive.requests5m >= 20 && passive.viaCdn5m === 0) degrade('最近 5 分钟没有经 CDN 进入的请求（用户仍直连 EIP？）');
    if (cfg.storage.STORAGE_DRIVER === 's3' && infra.CDN_MEDIA_ORIGIN === 'ec2') degrade('STORAGE_DRIVER=s3 而 CDN_MEDIA_ORIGIN=ec2：媒体 URL 不改写（DEP-028，改为 MediaOrigin=s3）');

    if (!this.ctx.aws.enabled) {
      degrade('无凭证：控制面感知不可用（CRED-004）');
    } else if (infra.CDN_DISTRIBUTION_ID) {
      try {
        const sdk = await loadAwsPackage('@aws-sdk/client-cloudfront', () => import('@aws-sdk/client-cloudfront'));
        const cf = await this.ctx.aws.cloudfront();
        const r = await cf.send(new sdk.GetDistributionCommand({ Id: infra.CDN_DISTRIBUTION_ID }));
        const d = r.Distribution;
        Object.assign(data, { distributionStatus: d?.Status, enabled: d?.DistributionConfig?.Enabled, domainName: d?.DomainName });
        confidence = 'confirmed';
        if (d?.DistributionConfig?.Enabled === false) {
          status = 'error';
          problems.push(`分配 ${infra.CDN_DISTRIBUTION_ID} 已禁用`);
        } else if (d?.Status && d.Status !== 'Deployed') degrade(`分配状态 ${d.Status}`);
      } catch (e) {
        if (isAwsNotFound(e)) {
          status = 'error';
          problems.push(`控制面确认分配 ${infra.CDN_DISTRIBUTION_ID} 不存在`);
          confidence = 'confirmed';
        } else degrade(`GetDistribution 失败：${describeAwsError(e)}`);
      }
    }
    if (opts.deep) data.deep = true;
    const ratio = passive.viaCdnRatio5m === null ? '最近 5 分钟没有请求' : `最近 5 分钟 ${Math.round(passive.viaCdnRatio5m * 100)}% 的请求经 CloudFront 进入`;
    return {
      status,
      detail: `${ratio}${data.distributionStatus ? ` · 分配 ${String(data.distributionStatus)}` : ''}${problems.length ? ` · ${problems.join('；')}` : ''}`,
      confidence,
      data,
    };
  }

  /** 运行期规则 SEC-001 的输入（rules.ts：ctx.observed.cdn.originVerifyMismatch5m / listener8080Missing） */
  observations(): Record<string, unknown> {
    // cdn 的主探针在 CdnPort 适配器里，detect() 未必被调用：这里每 60 秒在后台刷新一次本机监听器检查，结果用于下一轮
    if (this.ctx.cfg.core.CDN_BASE_URL && this.now() - this.listenerCheckedAt > 60_000) {
      this.listenerCheckedAt = this.now();
      void this.checkListener().catch(() => undefined);
    }
    const s = this.stats();
    return {
      originVerifyMismatch5m: s.originVerifyMismatch5m,
      listener8080Missing: this.listenerMissing,
      viaCdnRatio5m: s.viaCdnRatio5m,
      requests5m: s.requests5m,
    };
  }
}

export const cdnDetector: DetectorFactory = { module: 'cdn', create: (ctx) => new CdnDetector(ctx) };
