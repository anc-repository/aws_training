/**
 * shell-access/probe-port —— 从运维机（平台模式：工作台）探测实验机的 22 端口（05#shell-access 第 5 节步骤 1；06 PM-M28）。
 *
 *   npm run exp -- shell-access --label before --scenario probe-port --param target=private-ip --upload   # SSH 基线
 *   npm run exp -- shell-access --label after  --scenario probe-port --param target=private-ip --upload   # Session Manager
 *
 * 对 22 与 443（param ports）各尝试 attempts 次 `net.connect`（超时 timeoutMs）：open / refused / timeout。
 * 目标：target=public（EXP_TARGET 的主机，缺省）、target=private-ip（平台模式：SSH 基线只对工作台私网 /32 开放，经公网地址
 * 探测在 before 时就是超时；私网地址经 `aws ec2 describe-instances` 查得），或 --param host=<地址>。
 * 服务端证据：实例安全组的入站规则（`aws ec2 describe-security-group-rules`，以学员身份只读）中覆盖 22 的规则数与来源，
 * 以及 capabilities 的 shell-access 段（ssm 档的感知器给出“无管理端口入站”与 port22 规则）。客户端的探测结果只作对照。
 */
import { connect } from 'node:net';
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { awsJson } from './aws-cli.js';

export type ProbeOutcome = 'open' | 'refused' | 'timeout' | 'error';

export function probeOnce(host: string, port: number, timeoutMs: number): Promise<{ outcome: ProbeOutcome; ms: number; code?: string }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (outcome: ProbeOutcome, code?: string) => {
      s.removeAllListeners();
      s.destroy();
      resolve({ outcome, ms: Math.round(performance.now() - t0), ...(code ? { code } : {}) });
    };
    s.setTimeout(timeoutMs, () => done('timeout'));
    s.once('connect', () => done('open'));
    s.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ETIMEDOUT' ? 'timeout' : 'error', e.code));
  });
}

/** 多次尝试的结论：有一次连上 = open；全部超时 = filtered（安全组丢弃）；有拒绝 = closed（可达但没有进程监听） */
export function summarize(outcomes: readonly ProbeOutcome[]): 'open' | 'filtered' | 'closed' | 'error' {
  if (outcomes.includes('open')) return 'open';
  if (outcomes.length && outcomes.every((o) => o === 'timeout')) return 'filtered';
  if (outcomes.includes('refused')) return 'closed';
  return 'error';
}

interface SgRule { GroupId?: string; IsEgress?: boolean; IpProtocol?: string; FromPort?: number; ToPort?: number; CidrIpv4?: string; CidrIpv6?: string;
  ReferencedGroupInfo?: { GroupId?: string }; PrefixListId?: string }

/** 入站规则中覆盖 22/tcp 的（协议 -1 = 全部流量，同样放开了 22） */
export function rules22(rules: readonly SgRule[]): SgRule[] {
  return rules.filter((r) => !r.IsEgress && (r.IpProtocol === '-1' || ((r.IpProtocol === 'tcp' || r.IpProtocol === '6') && (r.FromPort ?? -1) <= 22 && (r.ToPort ?? -1) >= 22)));
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const attempts = numParam(ctx, 'attempts', 5);
    const timeoutMs = numParam(ctx, 'timeoutMs', 3000);
    const ports = strParam(ctx, 'ports', '22,443').split(',').map((p) => Number(p.trim())).filter((p) => p > 0 && p < 65536);
    const targetKind = strParam(ctx, 'target', 'public');
    const region = ctx.capabilities.app.region;
    const instanceId = ctx.capabilities.app.instance.id;

    // 实例的私网地址与安全组（控制面，只读）
    let privateIp: string | undefined;
    let groups: string[] = [];
    try {
      const d = await awsJson<{ Reservations?: Array<{ Instances?: Array<{ PrivateIpAddress?: string; SecurityGroups?: Array<{ GroupId?: string }> }> }> }>(
        ['ec2', 'describe-instances', '--instance-ids', instanceId], region);
      const inst = d.Reservations?.[0]?.Instances?.[0];
      privateIp = inst?.PrivateIpAddress;
      groups = (inst?.SecurityGroups ?? []).map((g) => g.GroupId ?? '').filter(Boolean);
    } catch (e) {
      ctx.note(`describe-instances 失败（没有 AWS CLI 或权限）：${(e as Error).message}`);
    }
    const host = strParam(ctx, 'host', '') || (targetKind === 'private-ip' ? privateIp ?? '' : new URL(ctx.target).hostname);
    if (!host) {
      ctx.note('没有探测目标：target=private-ip 需要 aws ec2 describe-instances 查得私网地址，或用 --param host=<地址>');
      return;
    }
    ctx.finding('target', { kind: strParam(ctx, 'host', '') ? 'host' : targetKind, host, instanceId });

    for (const port of ports) {
      const outcomes: ProbeOutcome[] = [];
      const ms: number[] = [];
      for (let i = 0; i < attempts && !ctx.signal.aborted; i += 1) {
        const r = await probeOnce(host, port, timeoutMs);
        outcomes.push(r.outcome);
        ms.push(r.ms);
      }
      ctx.finding(`port${port}`, {
        result: summarize(outcomes), open: outcomes.filter((o) => o === 'open').length, refused: outcomes.filter((o) => o === 'refused').length,
        timeout: outcomes.filter((o) => o === 'timeout').length, maxMs: Math.max(...ms),
      });
    }

    // 服务端证据：安全组的 22 端口入站规则
    if (groups.length) {
      try {
        const r = await awsJson<{ SecurityGroupRules?: SgRule[] }>(['ec2', 'describe-security-group-rules', '--filters', `Name=group-id,Values=${groups.join(',')}`], region);
        const hits = rules22(r.SecurityGroupRules ?? []);
        ctx.finding('sgRules22', hits.length);
        ctx.finding('sgSources22', hits.map((h) => h.CidrIpv4 ?? h.CidrIpv6 ?? h.ReferencedGroupInfo?.GroupId ?? h.PrefixListId ?? '?'));
        ctx.finding('sgOpenToWorld', hits.some((h) => h.CidrIpv4 === '0.0.0.0/0' || h.CidrIpv6 === '::/0'));
      } catch (e) {
        ctx.note(`describe-security-group-rules 失败：${(e as Error).message}`);
      }
    }
    const sa = ctx.capabilities.modules['shell-access'];
    ctx.finding('capability', { driver: sa?.driver, status: sa?.status, detail: sa?.detail });
  },
});
