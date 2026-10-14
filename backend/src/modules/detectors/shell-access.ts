// backend/src/modules/detectors/shell-access.ts —— shell-access 感知器（总纲 3.3；05#shell-access 第 3、10 节）
//
// 纯基础设施型：应用侧没有端口和驱动，capabilities 的 driver = SHELL_ACCESS_MODE（ssh / ssm）。
//   - ssh（本地实现）：只读 root 安全快照 security/snapshot.json 的 sshd 段（ec2 每 2 分钟生成）：sshd 是否监听、近 24 小时
//     认证失败次数、最近登录；快照超过 5 分钟 → inferred + degraded；sshd 未监听 → error（L0 唯一的运维通道断了）。
//     （模块未启用时 capabilities 不运行感知器，localHealth 固定为 ok；这个分支供 /lab 侧路与测试使用。）
//   - ssm：控制面三路信号（第 10 节）——
//       ssm:DescribeInstanceInformation（本实例的 PingStatus、AgentVersion、LastPingDateTime）、
//       ec2:DescribeSecurityGroups（实例安全组是否还有覆盖 22 的入站规则，含协议 -1 的“全部流量”）、
//       ssm:GetDocument（会话首选项 SSM-SessionManagerRunShell 的日志组是不是本模块的）；
//     深度探针另加 ssm:DescribeSessions（最近 20 次历史会话，排除平台终端会话 ATL-SessionShell* / atl-<sid>-term-*，06 PM-M28）
//     与 logs:DescribeLogStreams（会话日志组中有没有对应的日志流）。
//     判据：Agent 不是 Online 或 AccessDenied → error；Agent Online 但 22 仍开放（SHELL_ACCESS_KEEP_SSH=true 的过渡期或 SEC-003）、
//     首选项被改成别的日志组、最近的会话没有日志流 → degraded；否则 ok（detail 含“无管理端口入站”）。
// 2026-10-14 实机验证的教训：api 重启后的最初一两分钟，IMDS 与 SDK 的首个请求可能很慢。控制面读取放在后台刷新
// （stale-while-revalidate，有效期 55 秒），探针最多等 1.5 秒（深度 2.5 秒）；还没有结果时返回 degraded + transient，
// 不因为一次超时报 error。每次 AWS 调用经 withAwsRetry（单次超时 + 只对瞬时错误重试）。
// observations().port22Open 是 SEC-003（运行期规则）的输入，只在控制面确认后给出。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { describeAwsError, isAwsAccessDenied, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry } from '../../adapters/aws/clients.js';
import type { ProbeResult } from '../../ports/common.js';
import { ImdsClient } from './ec2.js';
import type { Detector, DetectorContext, DetectorFactory } from './types.js';

export const SESSION_PREFS_DOCUMENT = 'SSM-SessionManagerRunShell';
/** 快照超过这个时间 → 置信度 inferred（00 第 7 节 security-snapshot 检查项） */
const SNAPSHOT_STALE_MS = 5 * 60_000;
/** 控制面视图的有效期（registry probe.intervalSec = 60，探针循环 30 秒一轮） */
const VIEW_TTL_MS = 55_000;
const SESSIONS_TTL_MS = 60_000;

export interface SshdSnapshot { listening?: boolean; failures24h?: number; recentLogins?: string[]; effective?: Record<string, string> }
export interface SecuritySnapshotLite { generatedAt?: string; sshd?: SshdSnapshot; host?: { listening?: string[]; units?: Record<string, string> } }

export interface Port22Rule { protocol: string; from?: number; to?: number; sources: string[] }

/** 安全组入站规则中覆盖 22/tcp 的规则（协议 -1 = 全部流量，同样放开了 22） */
export function rulesCovering22(perms: ReadonlyArray<{ IpProtocol?: string; FromPort?: number; ToPort?: number;
  IpRanges?: Array<{ CidrIp?: string }>; Ipv6Ranges?: Array<{ CidrIpv6?: string }>; UserIdGroupPairs?: Array<{ GroupId?: string }>;
  PrefixListIds?: Array<{ PrefixListId?: string }> }>): Port22Rule[] {
  const out: Port22Rule[] = [];
  for (const p of perms) {
    const proto = String(p.IpProtocol ?? '');
    const all = proto === '-1';
    const tcp = proto === 'tcp' || proto === '6';
    if (!all && !(tcp && (p.FromPort ?? -1) <= 22 && (p.ToPort ?? -1) >= 22)) continue;
    const sources = [
      ...(p.IpRanges ?? []).map((r) => r.CidrIp ?? ''), ...(p.Ipv6Ranges ?? []).map((r) => r.CidrIpv6 ?? ''),
      ...(p.UserIdGroupPairs ?? []).map((g) => g.GroupId ?? ''), ...(p.PrefixListIds ?? []).map((x) => x.PrefixListId ?? ''),
    ].filter(Boolean);
    out.push({ protocol: proto, ...(p.FromPort !== undefined ? { from: p.FromPort } : {}), ...(p.ToPort !== undefined ? { to: p.ToPort } : {}), sources });
  }
  return out;
}

/** 平台终端会话（06 PM-M28、03 §3.3）：文档 ATL-SessionShell*，或会话 ID 形如 atl-<sid>-term-… */
export function isPlatformSession(s: { SessionId?: string; DocumentName?: string }): boolean {
  return (s.DocumentName ?? '').startsWith('ATL-SessionShell') || /^atl-[A-Za-z0-9]+-term-/.test(s.SessionId ?? '');
}

export interface SessionSummary { id: string; owner?: string; start?: string; end?: string; document?: string; hasLog?: boolean }

interface ControlView {
  at: number;
  instanceId: string;
  securityGroupIds: string[];
  ping: string;
  agentVersion?: string;
  lastPingAt?: string;
  port22: Port22Rule[];
  prefs: { state: 'ours' | 'foreign' | 'missing' | 'unknown'; logGroup?: string; runAs?: string; error?: string };
}

export interface ShellAccessDetectorOptions {
  imds?: ImdsClient;
  now?: () => number;
  /** 常规探针等待控制面结果的最长时间（总探针超时 2 秒） */
  budgetMs?: number;
  deepBudgetMs?: number;
}

export class ShellAccessDetector implements Detector {
  readonly module = 'shell-access' as const;
  private readonly imds: ImdsClient;
  private readonly now: () => number;
  private view: ControlView | undefined;
  private viewError: unknown;
  private refreshing: Promise<void> | undefined;
  private sessions: { at: number; list: SessionSummary[]; error?: string } | undefined;
  private port22Open: boolean | undefined;

  constructor(protected readonly ctx: DetectorContext, private readonly opts: ShellAccessDetectorOptions = {}) {
    this.imds = opts.imds ?? new ImdsClient({ timeoutMs: ctx.cfg.iam.IAM_IMDS_TIMEOUT_MS });
    this.now = opts.now ?? (() => Date.now());
  }

  private get mode(): 'ssh' | 'ssm' {
    return this.ctx.cfg.shellAccess.SHELL_ACCESS_MODE;
  }

  private get logGroup(): string | undefined {
    return this.ctx.cfg.shellAccess.SSM_SESSION_LOG_GROUP;
  }

  /** SEC-003 的输入：{ port22Open: boolean }（只在控制面确认后给出） */
  observations(): Record<string, unknown> {
    return this.port22Open === undefined ? {} : { port22Open: this.port22Open };
  }

  readSnapshot(): SecuritySnapshotLite | undefined {
    try {
      return JSON.parse(readFileSync(path.join(this.ctx.cfg.core.CLOUDALBUM_DATA_DIR, 'security', 'snapshot.json'), 'utf8')) as SecuritySnapshotLite;
    } catch {
      return undefined;
    }
  }

  private sshdData(snap: SecuritySnapshotLite | undefined): Record<string, unknown> {
    const s = snap?.sshd;
    return s ? { sshd: { listening: s.listening ?? null, failures24h: s.failures24h ?? null, recentLogins: s.recentLogins ?? [] }, snapshotAt: snap?.generatedAt } : {};
  }

  async detect(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const snap = this.readSnapshot();
    if (this.mode === 'ssh') return this.sshBaseline(snap);
    if (!this.ctx.aws.enabled) {
      // DEP-001 保证 ssm 时一定是 role；这里只是兜底（CRED-004 式降级，不报 error）
      return { status: 'degraded', confidence: 'inferred', detail: 'IAM_CREDENTIALS=none：无法查询 SSM 控制面（Session Manager 需要实例角色，DEP-001）', data: { mode: 'ssm', ...this.sshdData(snap) } };
    }
    // 预算：常规探针总超时 2 秒、深度（/api/capabilities?deep=1 与 cli probe --deep）5 秒
    const view = await this.currentView(opts.deep ? (this.opts.deepBudgetMs ?? 2500) : (this.opts.budgetMs ?? 1500));
    const base: Record<string, unknown> = {
      mode: 'ssm', logGroup: this.logGroup ?? null, runAs: this.ctx.cfg.shellAccess.SSM_SESSION_RUN_AS ?? null,
      keepSsh: this.ctx.cfg.shellAccess.SHELL_ACCESS_KEEP_SSH === 'true', ...this.sshdData(snap),
    };
    if (!view) {
      const e = this.viewError;
      if (e && !isAwsTransient(e) && !(e instanceof NotOnEc2)) {
        const denied = isAwsAccessDenied(e);
        return { status: 'error', confidence: 'confirmed', detail: `${denied ? '控制面查询被拒绝（检查 PolicyArn）' : '控制面查询失败'}：${describeAwsError(e)}`, data: base };
      }
      if (e instanceof NotOnEc2) return { status: 'degraded', confidence: 'inferred', detail: '不在 EC2 上（IMDS 不可达）：无法确认 SSM Agent 与安全组', data: base };
      return { status: 'degraded', transient: true, confidence: 'inferred',
        detail: e ? `正在查询 SSM 控制面：${describeAwsError(e)}（下一轮探针重试）` : '正在查询 SSM 控制面（首次请求较慢，下一轮探针给出结论）', data: base };
    }
    const data: Record<string, unknown> = {
      ...base, instanceId: view.instanceId, securityGroupIds: view.securityGroupIds, pingStatus: view.ping,
      ...(view.agentVersion ? { agentVersion: view.agentVersion } : {}), ...(view.lastPingAt ? { lastPingAt: view.lastPingAt } : {}),
      port22: view.port22, sessionPreferences: view.prefs, checkedAt: new Date(view.at).toISOString(),
      ...(this.viewError ? { refreshError: describeAwsError(this.viewError) } : {}),
    };
    if (view.ping !== 'Online') {
      return { status: 'error', confidence: 'confirmed', detail: `SSM Agent ${view.ping}：Session Manager 不可用（检查实例角色、amazon-ssm-agent 与到 ssm / ssmmessages 端点的出站 443）`, data };
    }
    const agent = `Agent Online${view.agentVersion ? `（版本 ${view.agentVersion}）` : ''}`;
    const notes: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    if (view.port22.length) {
      status = 'degraded';
      const src = [...new Set(view.port22.flatMap((r) => r.sources))].join(', ') || '?';
      notes.push(this.ctx.cfg.shellAccess.SHELL_ACCESS_KEEP_SSH === 'true'
        ? `过渡期：22 仍开放（入站 22/tcp ← ${src}；SHELL_ACCESS_KEEP_SSH=true，SEC-003）`
        : `安全组仍开放 22（入站 22/tcp ← ${src}；SEC-003）`);
    }
    if (view.prefs.state === 'foreign') {
      status = 'degraded';
      notes.push(`会话首选项 ${SESSION_PREFS_DOCUMENT} 的日志组是 ${view.prefs.logGroup ?? '（空）'}，不是 ${this.logGroup}（被别人改过？）`);
    } else if (view.prefs.state === 'missing') {
      status = 'degraded';
      notes.push(`会话首选项 ${SESSION_PREFS_DOCUMENT} 不存在：会话命令不会写进 ${this.logGroup}（scripts/module enable shell-access 重新写入）`);
    }
    if (opts.deep) {
      const s = await this.recentSessions(view.instanceId);
      data.sessions = s.list;
      if (s.error) data.sessionsError = s.error;
      // 只有 shell 会话（默认文档）会写会话日志；端口转发不记录内容
      const unlogged = s.list.filter((x) => x.end && x.hasLog === false && (!x.document || x.document === SESSION_PREFS_DOCUMENT));
      if (unlogged.length) {
        status = 'degraded';
        notes.push(`最近 ${unlogged.length} 次 shell 会话在 ${this.logGroup} 中没有日志流（cloudWatchEncryptionEnabled 与日志组加密不一致？）`);
      }
    }
    const head = view.port22.length ? agent : `${agent} · 无管理端口入站`;
    const detail = `${head}${this.logGroup ? ` · 会话日志 → ${this.logGroup}` : ''}${notes.length ? ` · ${notes.join('；')}` : ''}`;
    return { status, confidence: 'confirmed', detail, data };
  }

  private sshBaseline(snap: SecuritySnapshotLite | undefined): ProbeResult {
    const data = { mode: 'ssh', ...this.sshdData(snap) };
    if (!snap?.sshd) return { status: 'degraded', confidence: 'inferred', detail: 'SSH 基线：security/snapshot.json 中没有 sshd 段（cloudalbum-security-snapshot.timer 未运行？）', data };
    const fresh = Boolean(snap.generatedAt && this.now() - Date.parse(snap.generatedAt) < SNAPSHOT_STALE_MS);
    const s = snap.sshd;
    if (s.listening === false) return { status: 'error', confidence: fresh ? 'observed' : 'inferred', detail: 'sshd 没有监听 22：L0 唯一的运维通道断了', data };
    const eff = s.effective ?? {};
    const weak = eff.passwordauthentication === 'yes' || eff.permitrootlogin === 'yes';
    const detail = `SSH 基线 · sshd 监听 22 · 近 24 小时失败 ${s.failures24h ?? 0} 次 · 登录审计只有 journal 中的公钥指纹与来源 IP`;
    if (!fresh) return { status: 'degraded', confidence: 'inferred', detail: `${detail}（快照超过 5 分钟未更新）`, data };
    if (weak) return { status: 'degraded', confidence: 'observed', detail: `${detail}；sshd 生效配置与加固片段不一致（密码或 root 登录被打开）`, data };
    return { status: 'ok', confidence: 'observed', detail, data };
  }

  /** stale-while-revalidate：过期时启动后台刷新，最多等 budgetMs；返回当前（可能稍旧的）视图 */
  private async currentView(budgetMs: number): Promise<ControlView | undefined> {
    const fresh = this.view && this.now() - this.view.at < VIEW_TTL_MS;
    if (!fresh && !this.refreshing) {
      this.refreshing = this.refresh()
        .then((v) => { this.view = v; this.viewError = undefined; this.port22Open = v.port22.length > 0; })
        .catch((e: unknown) => { this.viewError = e; })
        .finally(() => { this.refreshing = undefined; });
    }
    if (this.refreshing && !fresh) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.refreshing, new Promise((r) => { timer = setTimeout(r, budgetMs); timer.unref?.(); })]);
      if (timer) clearTimeout(timer);
    }
    return this.view;
  }

  private async instanceFacts(): Promise<{ instanceId: string; securityGroupIds: string[] }> {
    const instanceId = await this.imds.text('/latest/meta-data/instance-id');
    if (!instanceId) throw new NotOnEc2();
    const mac = await this.imds.text('/latest/meta-data/mac');
    const sgText = mac ? await this.imds.text(`/latest/meta-data/network/interfaces/macs/${mac}/security-group-ids`) : undefined;
    return { instanceId, securityGroupIds: (sgText ?? '').split(/\s+/).map((x) => x.trim()).filter(Boolean) };
  }

  /** 一次完整的控制面读取（后台） */
  async refresh(): Promise<ControlView> {
    const facts = await this.instanceFacts();
    const [ssmSdk, ec2Sdk] = await Promise.all([
      loadAwsPackage('@aws-sdk/client-ssm', () => import('@aws-sdk/client-ssm')),
      loadAwsPackage('@aws-sdk/client-ec2', () => import('@aws-sdk/client-ec2')),
    ]);
    const ssm: SSMClient = await this.ctx.aws.ssm();
    const ec2: EC2Client = await this.ctx.aws.ec2();
    const retry = { attempts: 3, timeoutMs: 3000 };
    const [info, groups, prefs] = await Promise.all([
      withAwsRetry(() => ssm.send(new ssmSdk.DescribeInstanceInformationCommand({ Filters: [{ Key: 'InstanceIds', Values: [facts.instanceId] }] })), retry),
      facts.securityGroupIds.length
        ? withAwsRetry(() => ec2.send(new ec2Sdk.DescribeSecurityGroupsCommand({ GroupIds: facts.securityGroupIds })), retry)
        : Promise.resolve({ SecurityGroups: [] }),
      this.readPrefs(ssm, ssmSdk),
    ]);
    const i = info.InstanceInformationList?.[0];
    const perms = (groups.SecurityGroups ?? []).flatMap((g) => g.IpPermissions ?? []);
    return {
      at: this.now(), instanceId: facts.instanceId, securityGroupIds: facts.securityGroupIds,
      ping: i?.PingStatus ?? 'NotRegistered',
      ...(i?.AgentVersion ? { agentVersion: i.AgentVersion } : {}),
      ...(i?.LastPingDateTime ? { lastPingAt: new Date(i.LastPingDateTime).toISOString() } : {}),
      port22: rulesCovering22(perms), prefs,
    };
  }

  private async readPrefs(ssm: SSMClient, sdk: typeof import('@aws-sdk/client-ssm')): Promise<ControlView['prefs']> {
    try {
      const r = await withAwsRetry(() => ssm.send(new sdk.GetDocumentCommand({ Name: SESSION_PREFS_DOCUMENT, DocumentFormat: 'JSON' })), { attempts: 2, timeoutMs: 3000 });
      const doc = JSON.parse(r.Content ?? '{}') as { inputs?: { cloudWatchLogGroupName?: string; runAsDefaultUser?: string } };
      const lg = doc.inputs?.cloudWatchLogGroupName ?? '';
      return {
        state: this.logGroup && lg === this.logGroup ? 'ours' : 'foreign', logGroup: lg,
        ...(doc.inputs?.runAsDefaultUser ? { runAs: doc.inputs.runAsDefaultUser } : {}),
      };
    } catch (e) {
      if (isAwsNotFound(e) || /InvalidDocument/.test(String((e as Error)?.name))) return { state: 'missing' };
      if (isAwsAccessDenied(e)) throw e;
      return { state: 'unknown', error: describeAwsError(e) };   // 首选项读不到不影响 Agent / 安全组的结论
    }
  }

  /** 最近 20 次历史会话（排除平台终端会话），并对照会话日志组的日志流；结果缓存 60 秒 */
  private async recentSessions(instanceId: string): Promise<{ list: SessionSummary[]; error?: string }> {
    if (this.sessions && this.now() - this.sessions.at < SESSIONS_TTL_MS) return this.sessions;
    try {
      const sdk = await loadAwsPackage('@aws-sdk/client-ssm', () => import('@aws-sdk/client-ssm'));
      const ssm: SSMClient = await this.ctx.aws.ssm();
      // 两个调用并行、各 1.5 秒：深度探针的总预算是 5 秒
      const [r, names] = await Promise.all([
        withAwsRetry(() => ssm.send(new sdk.DescribeSessionsCommand({
          State: 'History', Filters: [{ key: 'Target', value: instanceId }], MaxResults: 20,
        })), { attempts: 1, timeoutMs: 1500 }),
        this.sessionStreams().catch(() => undefined),
      ]);
      const list: SessionSummary[] = (r.Sessions ?? []).filter((s) => !isPlatformSession(s)).map((s) => ({
        id: s.SessionId ?? '', ...(s.Owner ? { owner: s.Owner } : {}),
        ...(s.StartDate ? { start: new Date(s.StartDate).toISOString() } : {}), ...(s.EndDate ? { end: new Date(s.EndDate).toISOString() } : {}),
        document: s.DocumentName ?? '',
      }));
      if (names) for (const s of list) s.hasLog = names.has(s.id);
      this.sessions = { at: this.now(), list };
    } catch (e) {
      this.sessions = { at: this.now(), list: this.sessions?.list ?? [], error: describeAwsError(e) };
    }
    return this.sessions;
  }

  private async sessionStreams(): Promise<Set<string>> {
    if (!this.logGroup) return new Set();
    const sdk = await loadAwsPackage('@aws-sdk/client-cloudwatch-logs', () => import('@aws-sdk/client-cloudwatch-logs'));
    const logs: CloudWatchLogsClient = await this.ctx.aws.cloudwatchLogs();
    const r = await withAwsRetry(() => logs.send(new sdk.DescribeLogStreamsCommand({ logGroupName: this.logGroup!, orderBy: 'LastEventTime', descending: true, limit: 50 })),
      { attempts: 1, timeoutMs: 1500 });
    return new Set((r.logStreams ?? []).map((s) => s.logStreamName ?? ''));
  }
}

class NotOnEc2 extends Error {
  constructor() {
    super('IMDS 不可达：不在 EC2 上');
    this.name = 'NotOnEc2';
  }
}

export const shellAccessDetector: DetectorFactory = { module: 'shell-access', create: (ctx) => new ShellAccessDetector(ctx) };
