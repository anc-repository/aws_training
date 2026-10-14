// backend/src/modules/detectors/waf.ts —— waf 感知器（总纲 3.3；01#waf 第 3、10 节；wave1-waf）
//
// waf 同时有适配器（BlocklistPort）和感知器：能力注册表的状态取适配器的 probe()（adapters/waf/aws.ts 把本感知器的 detect()
// 与 denylist / IP 集合同步的状态合并），本感知器另外提供 observe() / observations()（运行期规则的输入）。
//
// 被动（observe，每个请求 O(1) 计数，保留最近 5 分钟）：经 CloudFront / ALB 入口进入的请求（Nginx 计算的 entry，只信任回环地址传来的
//   X-CloudAlbum-Entry）中，entry 含 `waf>` 的比例——Nginx 在请求带 `x-amzn-waf-cloudalbum: inspected`（Web ACL 默认动作插入的头）
//   时把 waf 写进 entry（00-entry.conf）。声明启用但经入口的请求一个都没有被检查 → degraded（Web ACL 未关联）。
// 主动（有凭证，控制面只读，结果缓存 55 秒）：wafv2:GetWebACL（规则与托管规则组的动作是否与 WAF_RULE_ACTION 一致）与关联
//   （CLOUDFRONT：cloudfront:ListDistributionsByWebACLId；REGIONAL：wafv2:ListResourcesForWebACL）。CLOUDFRONT 范围的 API 在 us-east-1。
//   深度探针另读 wafv2:GetIPSet（与 denylist 是否一致）与 CloudWatch 的按规则拦截计数（只放进 data，不影响状态）。
// 2026-10-14 实机验证的教训：控制面读取在后台刷新（stale-while-revalidate，wave1-fix）：GetWebACL 与关联查询经完整的 withAwsRetry
//   （单次 3 秒、最多 3 次）放进后台 Promise，探针最多等 1.5 秒（深度 2.5 秒），不占用能力注册表 2 秒的探针预算；没等到时返回
//   上一次的视图（不超过 2 分钟）或 { status: 'degraded', transient: true }，由状态机决定何时升级为 error；
//   NotFound / AccessDenied 是确定性失败。只有成功的视图缓存 55 秒，失败的结果下一轮就重新读取。
// DEP-018（入口未锁定，可被绕过）不在这里判定：它是 warn 级运行期规则（rules.ts），由规则引擎把 waf 标为 degraded 并带规则 ID，
//   这样卡片的 `op: healthy` 能把它识别为预期警告；探针自己再报一次就成了“没有规则 ID 的 degraded”。
import { readFile } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { describeAwsError, isAwsAccessDenied, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry } from '../../adapters/aws/clients.js';
import { desiredAddresses, diffAddresses, parseWebAclArn, wafRegionOf } from '../../adapters/waf/ipset.js';
import { parseDenylist } from '../../adapters/waf/nginx.js';
import { isLoopback } from '../../config/net.js';
import type { ProbeResult } from '../../ports/common.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

const BUCKET_MS = 10_000;
const BUCKETS = 30;                               // 30 × 10 秒 = 5 分钟
/** 经入口的请求少于这个数时不判定“未关联”（刚启用、流量很小时不误报） */
export const MIN_EDGE_SAMPLES = 20;
/** 经入口的请求中带 x-amzn-waf-cloudalbum 的比例低于它 → “Web ACL 未关联？”（这个头可以伪造，见 detect()） */
export const MIN_INSPECTED_RATIO = 0.5;
const CONTROL_PLANE_TTL_MS = 55_000;
/** 控制面读取在后台进行，可以用完整的重试 */
const RETRY = { attempts: 3, timeoutMs: 3000, delaysMs: [200, 800] } as const;
/** 深度事实（IP 集合、按规则计数）只进 data，与控制面等待并行，必须落在 5 秒的深度探针预算之内 */
const DEEP_RETRY = { attempts: 2, timeoutMs: 900, delaysMs: [100] } as const;
/** 探针等待后台控制面读取的最长时间（常规 / 深度） */
export const CONTROL_PLANE_BUDGET_MS = 1500;
export const CONTROL_PLANE_DEEP_BUDGET_MS = 2500;
/** 后台读取未完成时，上一次的视图最多再用这么久 */
const MAX_STALE_MS = 120_000;

interface Bucket { slot: number; total: number; viaEdge: number; inspected: number }

export interface WafPassiveStats {
  requests5m: number;
  /** 经 CloudFront / ALB / API Gateway 入口进入的请求 */
  viaEdge5m: number;
  /** 其中 entry 含 waf 的请求（带 x-amzn-waf-cloudalbum） */
  inspected5m: number;
  /** 经入口但没有被 WAF 检查的请求（绕过 WAF：未关联、或另一个分配指向源站） */
  notInspected5m: number;
  inspectedRatio5m: number | null;
  direct5m: number;
}

export interface WafRuleSummary { name: string; priority: number; kind: 'custom' | 'managed'; action: string }

export interface WafControlPlane {
  at: number;
  webAcl?: { name: string; id: string; capacity?: number; rules: WafRuleSummary[]; managedAction: 'count' | 'block' | 'mixed' | 'none' };
  associations?: string[];
  error?: { kind: 'not-found' | 'denied' | 'transient' | 'other'; message: string };
  /** 后台读取未在预算内完成，这是上一次的视图 */
  stale?: boolean;
}

export interface WafDetectorOptions {
  now?: () => number;
}

export interface WafDetectOptions {
  deep?: boolean;
  /** 适配器传入的期望地址（denylist 的有效 IPv4 条目）；缺省时感知器自己读 denylist.conf */
  desired?: string[];
}

function header(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

function firstKey(o: object | undefined): string | undefined {
  return o ? Object.keys(o).find((k) => (o as Record<string, unknown>)[k] !== undefined) : undefined;
}

/** GetWebACL 的规则 → 摘要；托管规则组的 OverrideAction：Count = count，None = block（托管组自带动作生效） */
export function summarizeRules(rules: ReadonlyArray<Record<string, unknown>>): { rules: WafRuleSummary[]; managedAction: 'count' | 'block' | 'mixed' | 'none' } {
  const out: WafRuleSummary[] = [];
  const managed: string[] = [];
  for (const r of rules) {
    const statement = r.Statement as Record<string, unknown> | undefined;
    const isManaged = Boolean(statement?.ManagedRuleGroupStatement || statement?.RuleGroupReferenceStatement);
    let action: string;
    if (isManaged) {
      const o = firstKey(r.OverrideAction as object | undefined);
      action = o === 'Count' ? 'count' : o === 'None' ? 'block' : 'unknown';
      managed.push(action);
    } else {
      action = (firstKey(r.Action as object | undefined) ?? 'unknown').toLowerCase();
    }
    out.push({ name: String(r.Name ?? ''), priority: Number(r.Priority ?? 0), kind: isManaged ? 'managed' : 'custom', action });
  }
  out.sort((a, b) => a.priority - b.priority);
  const uniq = [...new Set(managed)];
  const managedAction = uniq.length === 0 ? 'none' : uniq.length === 1 && (uniq[0] === 'count' || uniq[0] === 'block') ? uniq[0] : 'mixed';
  return { rules: out, managedAction };
}

export class WafDetector implements Detector {
  readonly module = 'waf' as const;
  private readonly buckets: Bucket[] = Array.from({ length: BUCKETS }, () => ({ slot: -1, total: 0, viaEdge: 0, inspected: 0 }));
  private readonly now: () => number;
  private cp?: WafControlPlane;
  private refreshing?: Promise<WafControlPlane>;

  constructor(protected readonly ctx: DetectorContext, opts: WafDetectorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  private bucket(): Bucket {
    const slot = Math.floor(this.now() / BUCKET_MS);
    const b = this.buckets[slot % BUCKETS]!;
    if (b.slot !== slot) Object.assign(b, { slot, total: 0, viaEdge: 0, inspected: 0 });
    return b;
  }

  observe(req: { headers: IncomingHttpHeaders; remoteAddr: string }): void {
    const b = this.bucket();
    b.total += 1;
    const entry = isLoopback(req.remoteAddr) ? (header(req.headers, 'x-cloudalbum-entry') ?? '') : '';
    if (!/^(cloudfront|alb|apigw)>/.test(entry)) return;
    b.viaEdge += 1;
    if (entry.includes('waf>')) b.inspected += 1;
  }

  stats(): WafPassiveStats {
    const minSlot = Math.floor(this.now() / BUCKET_MS) - (BUCKETS - 1);
    let total = 0;
    let viaEdge = 0;
    let inspected = 0;
    for (const b of this.buckets) {
      if (b.slot < minSlot) continue;
      total += b.total;
      viaEdge += b.viaEdge;
      inspected += b.inspected;
    }
    return {
      requests5m: total, viaEdge5m: viaEdge, inspected5m: inspected, notInspected5m: viaEdge - inspected,
      inspectedRatio5m: viaEdge ? Math.round((inspected / viaEdge) * 1000) / 1000 : null, direct5m: total - viaEdge,
    };
  }

  private get waf() {
    return this.ctx.cfg.waf;
  }

  /** WAF 控制面所在区域（CLOUDFRONT 范围 = us-east-1） */
  region(): string {
    return wafRegionOf(this.waf.WAF_SCOPE, this.waf.WAF_WEB_ACL_ARN, this.ctx.cfg.core.AWS_REGION);
  }

  /**
   * 控制面事实（成功的视图缓存 55 秒；force 时重新读取）。读取在后台进行，并发调用共用一次刷新；最多等 budgetMs，
   * 没等到时返回上一次的视图（stale，不超过 2 分钟）或 transient 占位。
   */
  async controlPlane(force = false, budgetMs = force ? CONTROL_PLANE_DEEP_BUDGET_MS : CONTROL_PLANE_BUDGET_MS): Promise<WafControlPlane> {
    const cached = this.cp;
    if (!force && cached && !cached.error && this.now() - cached.at < CONTROL_PLANE_TTL_MS) return cached;
    this.refreshing ??= this.readControlPlane()
      .then((cp) => {
        this.cp = cp;
        return cp;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      this.refreshing,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (done) return done;
    if (cached && this.now() - cached.at < MAX_STALE_MS) return { ...cached, stale: true };
    return { at: this.now(), error: { kind: 'transient', message: '首次请求较慢，后台继续查询，下一轮探针给出结论' } };
  }

  private async readControlPlane(): Promise<WafControlPlane> {
    const ref = parseWebAclArn(this.waf.WAF_WEB_ACL_ARN);
    const at = this.now();
    if (!ref) return { at, error: { kind: 'other', message: `WAF_WEB_ACL_ARN 不是 Web ACL 的 ARN：${this.waf.WAF_WEB_ACL_ARN || '（空）'}` } };
    const region = this.region();
    try {
      const sdk = await loadAwsPackage('@aws-sdk/client-wafv2', () => import('@aws-sdk/client-wafv2'));
      const waf = await this.ctx.aws.wafv2({ region });
      const getAcl = withAwsRetry(() => waf.send(new sdk.GetWebACLCommand({ Name: ref.name, Scope: ref.scope, Id: ref.id })), RETRY);
      const assoc = ref.scope === 'CLOUDFRONT'
        ? (async () => {
          const cfSdk = await loadAwsPackage('@aws-sdk/client-cloudfront', () => import('@aws-sdk/client-cloudfront'));
          const cf = await this.ctx.aws.cloudfront({ region: 'us-east-1' });
          const r = await withAwsRetry(() => cf.send(new cfSdk.ListDistributionsByWebACLIdCommand({ WebACLId: ref.arn })), RETRY);
          return (r.DistributionList?.Items ?? []).map((d) => d.Id ?? '').filter(Boolean);
        })()
        : withAwsRetry(() => waf.send(new sdk.ListResourcesForWebACLCommand({ WebACLArn: ref.arn, ResourceType: 'APPLICATION_LOAD_BALANCER' })), RETRY)
          .then((r) => r.ResourceArns ?? []);
      const [acl, associations] = await Promise.all([getAcl, assoc]);
      const w = acl.WebACL;
      const s = summarizeRules((w?.Rules ?? []) as unknown as Array<Record<string, unknown>>);
      return {
        at, associations,
        webAcl: { name: w?.Name ?? ref.name, id: w?.Id ?? ref.id, ...(w?.Capacity !== undefined ? { capacity: w.Capacity } : {}), ...s },
      };
    } catch (e) {
      const kind = isAwsNotFound(e) ? 'not-found' : isAwsAccessDenied(e) ? 'denied' : isAwsTransient(e) ? 'transient' : 'other';
      return { at, error: { kind, message: describeAwsError(e) } };
    }
  }

  private async desiredFromFile(): Promise<string[] | undefined> {
    try {
      const text = await readFile(path.join(this.ctx.cfg.core.CLOUDALBUM_DATA_DIR, 'security', 'denylist.conf'), 'utf8');
      return desiredAddresses(parseDenylist(text)).addresses;
    } catch {
      return undefined;
    }
  }

  /** 深度：IP 集合是否与 denylist 一致；按规则的拦截 / 计数（CloudWatch，最近 5 分钟，只放进 data） */
  private async deepFacts(desired: string[] | undefined): Promise<{ data: Record<string, unknown>; problem?: string }> {
    const data: Record<string, unknown> = {};
    let problem: string | undefined;
    const ref = parseWebAclArn(this.waf.WAF_WEB_ACL_ARN);
    if (!ref || !this.waf.WAF_IP_SET_ID || !this.waf.WAF_IP_SET_NAME) return { data };
    const region = this.region();
    try {
      const sdk = await loadAwsPackage('@aws-sdk/client-wafv2', () => import('@aws-sdk/client-wafv2'));
      const waf = await this.ctx.aws.wafv2({ region });
      const r = await withAwsRetry(() => waf.send(new sdk.GetIPSetCommand({ Name: this.waf.WAF_IP_SET_NAME!, Scope: ref.scope, Id: this.waf.WAF_IP_SET_ID! })), DEEP_RETRY);
      const current = r.IPSet?.Addresses ?? [];
      data.ipSet = { name: this.waf.WAF_IP_SET_NAME, addresses: current.length };
      const want = desired ?? (await this.desiredFromFile());
      if (want) {
        const d = diffAddresses(current, want);
        (data.ipSet as Record<string, unknown>).inSyncWithDenylist = d.same;
        if (!d.same) problem = `IP 集合与 denylist 不一致（缺 ${d.add.length} 条、多 ${d.remove.length} 条；worker 每分钟同步一次）`;
      }
    } catch (e) {
      data.ipSetError = describeAwsError(e);
    }
    try {
      const cwSdk = await loadAwsPackage('@aws-sdk/client-cloudwatch', () => import('@aws-sdk/client-cloudwatch'));
      const cw = await this.ctx.aws.cloudwatch({ region });
      const end = new Date(this.now());
      const start = new Date(end.getTime() - 5 * 60_000);
      const q = (id: string, metric: string) => ({
        Id: id, ReturnData: true, Period: 300,
        Expression: `SEARCH('Namespace="AWS/WAFV2" MetricName="${metric}" WebACL="${ref.name}"', 'Sum', 300)`,
      });
      const r = await withAwsRetry(() => cw.send(new cwSdk.GetMetricDataCommand({
        StartTime: start, EndTime: end, MetricDataQueries: [q('blocked', 'BlockedRequests'), q('counted', 'CountedRequests')],
      })), DEEP_RETRY);
      const per: Record<string, { blocked?: number; counted?: number }> = {};
      for (const m of r.MetricDataResults ?? []) {
        const label = m.Label ?? m.Id ?? '?';
        const sum = (m.Values ?? []).reduce((a, v) => a + v, 0);
        const kind = m.Id?.startsWith('blocked') ? 'blocked' : 'counted';
        per[label] = { ...(per[label] ?? {}), [kind]: sum };
      }
      data.ruleCounts5m = per;
    } catch (e) {
      data.ruleCountsError = describeAwsError(e);
    }
    return { data, ...(problem ? { problem } : {}) };
  }

  async detect(opts: WafDetectOptions = {}): Promise<ProbeResult> {
    const w = this.waf;
    const passive = this.stats();
    const region = this.region();
    const data: Record<string, unknown> = {
      mode: w.WAF_MODE, scope: w.WAF_SCOPE ?? null, region, webAclArn: w.WAF_WEB_ACL_ARN ?? null, ruleAction: w.WAF_RULE_ACTION,
      ...(w.WAF_RATE_LIMIT !== undefined ? { rateLimit: w.WAF_RATE_LIMIT } : {}),
      ...(w.WAF_RATE_WINDOW_SEC !== undefined ? { rateWindowSec: w.WAF_RATE_WINDOW_SEC } : {}),
      ...(w.WAF_LOG_GROUP ? { logGroup: w.WAF_LOG_GROUP } : {}),
      labAllowCidr: w.WAF_LAB_ALLOW_CIDR ?? '',
      passive,
    };
    if (w.WAF_MODE !== 'aws') {
      return { status: 'ok', detail: 'WAF_MODE=nginx：Nginx limit_req + 特征拦截 + denylist（实例上）', confidence: 'observed', data };
    }
    const problems: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    let confidence: ProbeResult['confidence'] = 'observed';
    let transient = false;
    const degrade = (why: string) => {
      if (status === 'ok') status = 'degraded';
      problems.push(why);
    };
    const fail = (why: string) => {
      status = 'error';
      problems.push(why);
    };

    // 比例而不是“一个都没有”：x-amzn-waf-cloudalbum 可以由客户端自己带上（/api 的源请求策略是 AllViewer），一个伪造的请求
    // 不应抵消“Web ACL 未关联”的信号；关联后经入口的请求几乎全部带这个头（被拦截的请求不到源站，wave1-fix）
    if (passive.viaEdge5m >= MIN_EDGE_SAMPLES && (passive.inspectedRatio5m ?? 0) < MIN_INSPECTED_RATIO) {
      degrade(passive.inspected5m === 0
        ? `最近 5 分钟经入口的 ${passive.viaEdge5m} 个请求都没有 x-amzn-waf-cloudalbum（Web ACL 未关联？）`
        : `最近 5 分钟经入口的 ${passive.viaEdge5m} 个请求只有 ${passive.inspected5m} 个带 x-amzn-waf-cloudalbum（Web ACL 未关联？少数带头的请求可能是客户端自己加的）`);
    }
    if (w.WAF_LAB_ALLOW_CIDR) problems.push(`实验机白名单 ${w.WAF_LAB_ALLOW_CIDR} 生效中：这些地址跳过全部规则（用完立即清空）`);

    if (!this.ctx.aws.enabled) {
      degrade('无凭证：控制面感知不可用，封禁只写本地 denylist、不同步到 IP 集合（CRED-004）');
      confidence = 'inferred';
    } else {
      // 深度事实与控制面等待并行（深度探针总预算 5 秒）
      const [cp, deep] = await Promise.all([
        this.controlPlane(Boolean(opts.deep)),
        opts.deep ? this.deepFacts(opts.desired) : Promise.resolve(undefined),
      ]);
      if (cp.stale) problems.push(`控制面本轮查询仍在进行：显示 ${Math.max(0, Math.round((this.now() - cp.at) / 1000))} 秒前的结果`);
      if (cp.error) {
        if (cp.error.kind === 'not-found') {
          fail(`控制面确认 Web ACL 不存在（${region}）：${cp.error.message}`);
          confidence = 'confirmed';
        } else if (cp.error.kind === 'denied') {
          fail(`缺少读取 Web ACL 的权限（waf 的 PolicyArn 未附加？）：${cp.error.message}`);
        } else if (cp.error.kind === 'transient') {
          degrade(`控制面暂时不可达（${region}）：${cp.error.message}`);
          transient = true;
        } else {
          degrade(`读取 Web ACL 失败：${cp.error.message}`);
        }
      } else {
        confidence = 'confirmed';
        Object.assign(data, { webAcl: cp.webAcl, associations: cp.associations });
        if (!cp.associations?.length) {
          fail(w.WAF_SCOPE === 'REGIONAL' ? 'Web ACL 没有关联任何 ALB' : 'Web ACL 没有关联任何 CloudFront 分配（cdn 栈的 WebAclArn 未注入？）');
        }
        const actual = cp.webAcl?.managedAction;
        if (actual && actual !== 'none' && actual !== w.WAF_RULE_ACTION) {
          degrade(`托管规则组的实际动作为 ${actual}，与 WAF_RULE_ACTION=${w.WAF_RULE_ACTION} 不一致（栈被手工修改，或 enable 尚未完成）`);
        }
      }
      if (deep) {
        Object.assign(data, deep.data, { deep: true });
        if (deep.problem) degrade(deep.problem);
      }
    }

    const cpView = data.webAcl as WafControlPlane['webAcl'] | undefined;
    const head = `AWS WAF（${w.WAF_SCOPE ?? '?'} · ${region}）${cpView ? ` · 托管规则 ${cpView.managedAction}` : ` · 声明 ${w.WAF_RULE_ACTION}`}`
      + `${Array.isArray(data.associations) ? ` · 关联 ${(data.associations as string[]).length} 个${w.WAF_SCOPE === 'REGIONAL' ? ' ALB' : '分配'}` : ''}`;
    const ratio = passive.inspectedRatio5m === null ? '最近 5 分钟没有经入口的请求'
      : `最近 5 分钟经入口的请求 ${Math.round(passive.inspectedRatio5m * 100)}% 经 WAF 检查`;
    return {
      status,
      detail: `${head} · ${ratio}${problems.length ? ` · ${problems.join('；')}` : ''}`,
      confidence,
      data,
      ...(transient ? { transient: true } : {}),
    };
  }

  /** 运行期规则的输入（rules.ts：ctx.observed.waf.*）；DEP-018 本身按 env 判定 */
  observations(): Record<string, unknown> {
    const s = this.stats();
    return { viaEdge5m: s.viaEdge5m, inspected5m: s.inspected5m, notInspected5m: s.notInspected5m, inspectedRatio5m: s.inspectedRatio5m };
  }
}

export const wafDetector: DetectorFactory = { module: 'waf', create: (ctx) => new WafDetector(ctx) };
