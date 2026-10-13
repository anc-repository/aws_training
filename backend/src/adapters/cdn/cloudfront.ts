// backend/src/adapters/cdn/cloudfront.ts —— CdnPort 的 `cloudfront` 驱动（Amazon CloudFront；参数型模块，01#cdn 第 2、10 节）
//
// - mediaUrl()：公开媒体 → ${CDN_BASE_URL}/media/<key>；私有媒体：CDN_MEDIA_ORIGIN=ec2 时 ${CDN_BASE_URL}/media/<key>?exp&sig
//   （签名参数在缓存键中，源站返回 private，边缘不缓存），CDN_MEDIA_ORIGIN=s3 时原样返回 S3 预签名 URL（不经 CDN）。
//   STORAGE_DRIVER=s3 而 CDN_MEDIA_ORIGIN=ec2（DEP-028）时不改写（源站 /media 是 302 到会过期的预签名 URL），探针 degraded。
//   管理员旁路（X-Compare-Bypass: cdn）由 MediaUrlBuilder 处理（cdn=cloudfront:bypass）。
// - invalidate()：cloudfront:CreateInvalidation（限本分配）。
// - probe()：GET ${CDN_BASE_URL}/api/health/live?cdnprobe=<nonce>，确认 X-CloudAlbum-Path 以 entry=cloudfront 开头（8080 监听器与
//   X-Origin-Verify 都正确）；连续 3 次 403 / 5xx 为 error。被动统计、DEP-028 与 GetDistribution 由 cdn 感知器（modules/detectors/cdn.ts）
//   完成——container 经 attachDetector() 把已登记的感知器交给本适配器，探针合并两者的结论。
import { randomUUID } from 'node:crypto';
import type { AdapterDeps } from '../types.js';
import { describeAwsError, loadAwsPackage } from '../aws/clients.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CdnPort } from '../../ports/cdn.js';
import { HttpError } from '../../errors.js';
import { markPath } from '../../observability/request-context.js';

interface CdnDetectorLike { detect(opts: { deep?: boolean }): Promise<ProbeResult> }

const RANK: Record<ProbeResult['status'], number> = { ok: 0, degraded: 1, error: 2 };

export class CloudFrontCdn implements CdnPort {
  readonly meta: AdapterMeta = { module: 'cdn', driver: 'cloudfront', awsService: 'Amazon CloudFront', authoritative: false };
  readonly baseUrl: string | null;
  private detector?: CdnDetectorLike;
  private consecutiveEdgeErrors = 0;

  constructor(protected readonly deps: AdapterDeps, private readonly fetchImpl: typeof fetch = globalThis.fetch) {
    this.baseUrl = deps.cfg.core.CDN_BASE_URL ? deps.cfg.core.CDN_BASE_URL.replace(/\/+$/, '') : null;
  }

  /** container 在感知器创建后注入（UNTIMED） */
  attachDetector(d: CdnDetectorLike): void {
    this.detector = d;
  }

  /** DEP-028：媒体在 S3、源站却是 EC2 —— 不改写媒体 URL */
  private mediaNotCacheable(): boolean {
    return this.deps.cfg.storage.STORAGE_DRIVER === 's3' && this.deps.cfg.infra.CDN_MEDIA_ORIGIN === 'ec2';
  }

  mediaUrl(key: string, opts: { visibility: 'public' | 'private'; originUrl: string }): string {
    const base = this.baseUrl;
    if (!base || this.mediaNotCacheable()) return opts.originUrl;
    const mediaOrigin = this.deps.cfg.infra.CDN_MEDIA_ORIGIN;
    if (opts.visibility === 'public') {
      markPath('cdn', 'cloudfront');
      return `${base}/media/${key}`;
    }
    // 私有媒体：ec2 源站时把相对的 /media/<key>?exp&sig 搬到 CDN 域名；s3 源站时用 S3 预签名 URL（CDN_SIGNED_MEDIA 未实现）
    if (mediaOrigin === 'ec2' && opts.originUrl.startsWith('/')) {
      markPath('cdn', 'cloudfront');
      return `${base}${opts.originUrl}`;
    }
    return opts.originUrl;
  }

  async invalidate(paths: string[]): Promise<{ id: string | null; status: 'skipped' | 'submitted' }> {
    const distributionId = this.deps.cfg.infra.CDN_DISTRIBUTION_ID;
    if (!paths.length) return { id: null, status: 'skipped' };
    if (!distributionId) throw new HttpError(409, 'CDN_DISTRIBUTION_ID_MISSING', 'cdn.env 中没有 CDN_DISTRIBUTION_ID，无法失效');
    const sdk = await loadAwsPackage('@aws-sdk/client-cloudfront', () => import('@aws-sdk/client-cloudfront'));
    const cf = await this.deps.aws.cloudfront();
    const items = [...new Set(paths.map((p) => (p.startsWith('/') ? p : `/${p}`)))];
    const r = await cf.send(new sdk.CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: `cloudalbum-${Date.now()}-${randomUUID().slice(0, 8)}`, Paths: { Quantity: items.length, Items: items } },
    }));
    return { id: r.Invalidation?.Id ?? null, status: 'submitted' };
  }

  /** 经 CDN 请求一次 /api/health/live：entry 必须以 cloudfront 开头 */
  async edgeProbe(timeoutMs = 3000): Promise<{ status: ProbeResult['status']; detail: string; data: Record<string, unknown> }> {
    const base = this.baseUrl;
    if (!base) return { status: 'error', detail: 'CDN_BASE_URL 为空', data: {} };
    const url = `${base}/api/health/live?cdnprobe=${randomUUID().slice(0, 12)}`;
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      await res.arrayBuffer().catch(() => undefined);
      const ms = Date.now() - t0;
      const pathHeader = res.headers.get('x-cloudalbum-path') ?? '';
      const data = { edgeStatus: res.status, edgeMs: ms, edgePath: pathHeader, xCache: res.headers.get('x-cache'), pop: res.headers.get('x-amz-cf-pop') };
      if (res.status === 403 || res.status >= 500) {
        this.consecutiveEdgeErrors += 1;
        return {
          status: this.consecutiveEdgeErrors >= 3 ? 'error' : 'degraded',
          detail: `经 CDN 访问返回 ${res.status}（连续 ${this.consecutiveEdgeErrors} 次；8080 监听器缺失或 X-Origin-Verify 不一致？）`, data,
        };
      }
      this.consecutiveEdgeErrors = 0;
      if (pathHeader && !/entry=cloudfront/.test(pathHeader)) {
        return { status: 'degraded', detail: `经 CDN 的请求到达源站时 entry 不是 cloudfront（${pathHeader.split(';')[0]}）`, data };
      }
      if (ms > 1000) return { status: 'degraded', detail: `经 CDN 的首字节 ${ms}ms > 1 秒`, data };
      return { status: 'ok', detail: `经 CloudFront 访问正常（${ms}ms${data.xCache ? `，${String(data.xCache)}` : ''}）`, data };
    } catch (e) {
      this.consecutiveEdgeErrors += 1;
      return {
        status: this.consecutiveEdgeErrors >= 3 ? 'error' : 'degraded',
        detail: `经 CDN 访问失败：${(e as Error)?.message ?? String(e)}`, data: { edgeError: describeAwsError(e) },
      };
    }
  }

  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const edge = await this.edgeProbe();
    let status = edge.status;
    const details = [edge.detail];
    const direct = this.deps.cfg.infra.CDN_ORIGIN_DIRECT_URL;
    let data: Record<string, unknown> = { ...edge.data, baseUrl: this.baseUrl, ...(direct ? { originDirectUrl: direct } : {}) };
    let confidence: ProbeResult['confidence'] = 'observed';
    if (this.mediaNotCacheable() && !this.detector) {
      if (status === 'ok') status = 'degraded';
      details.push('CDN 降级：STORAGE_DRIVER=s3 而 CDN_MEDIA_ORIGIN=ec2，媒体未经 CDN（DEP-028，改为 MediaOrigin=s3）');
    }
    if (this.detector) {
      try {
        const d = await this.detector.detect(opts);
        if (RANK[d.status] > RANK[status]) status = d.status;
        details.push(d.detail);
        data = { ...data, ...(d.data ?? {}) };
        if (d.confidence === 'confirmed') confidence = 'confirmed';
      } catch (e) {
        details.push(`感知器失败：${(e as Error).message}`);
      }
    }
    return { status, detail: details.filter(Boolean).join(' · '), confidence, data };
  }
}
