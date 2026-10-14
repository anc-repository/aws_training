/**
 * shell-access/session-audit —— 审计链对齐（05#shell-access 第 5 节步骤 4；cards svc-shell-access 第 7 步）。
 *
 *   npm run exp -- shell-access --label after --scenario session-audit --upload [--param waitMin=15 --param hours=2]
 *
 * 以学员身份（工作台的 AWS CLI，只读）取三路控制面证据，按会话 ID 对齐：
 *   1. `aws ssm describe-sessions --state History --filters key=Target,value=<实例>`：谁、何时开了会话；
 *      排除平台终端会话（文档 ATL-SessionShell*、会话 ID 形如 atl-<sid>-term-…，06 PM-M28），只统计学员自己的会话；
 *   2. `aws logs describe-log-streams --log-group-name <会话日志组>`：日志流名 = 会话 ID（会话里执行了什么，只有 shell 会话有）；
 *   3. `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StartSession`：
 *      StartSession 管理事件（发起者 IAM 身份）；事件有分钟级延迟，脚本最多轮询 waitMin 分钟。
 * 对照：SSH 基线只能从 journal 看到“公钥指纹 + 来源 IP”，回答不了“谁执行了什么命令”。
 */
import { defineScenario, numParam, strParam } from '../_lib/scenario.js';
import { sleep } from '../_lib/util.js';
import { awsJson } from './aws-cli.js';

export interface Session { SessionId?: string; Owner?: string; Target?: string; DocumentName?: string; StartDate?: string; EndDate?: string; Status?: string }

/** 平台终端会话（06 PM-M28）不计入 */
export function isPlatformSession(s: Session): boolean {
  return (s.DocumentName ?? '').startsWith('ATL-SessionShell') || /^atl-[A-Za-z0-9]+-term-/.test(s.SessionId ?? '');
}

/** CloudTrail StartSession 事件 → { sessionId, user, target } */
export function trailSessions(events: ReadonlyArray<{ Username?: string; CloudTrailEvent?: string }>): Map<string, { user?: string; target?: string; at?: string }> {
  const out = new Map<string, { user?: string; target?: string; at?: string }>();
  for (const e of events) {
    try {
      const ev = JSON.parse(e.CloudTrailEvent ?? '{}') as { responseElements?: { sessionId?: string }; requestParameters?: { target?: string }; eventTime?: string; userIdentity?: { arn?: string } };
      const id = ev.responseElements?.sessionId;
      if (id) out.set(id, { ...(e.Username ? { user: e.Username } : {}), ...(ev.requestParameters?.target ? { target: ev.requestParameters.target } : {}), ...(ev.eventTime ? { at: ev.eventTime } : {}) });
    } catch {
      /* 忽略无法解析的事件 */
    }
  }
  return out;
}

export interface AlignedSession { id: string; owner?: string; start?: string; document?: string; shell: boolean; hasLog: boolean; trailed: boolean; trailUser?: string }

export function align(sessions: readonly Session[], streams: ReadonlySet<string>, trail: ReadonlyMap<string, { user?: string }>): AlignedSession[] {
  return sessions.filter((s) => s.SessionId && !isPlatformSession(s)).map((s) => {
    const shell = !s.DocumentName || s.DocumentName === 'SSM-SessionManagerRunShell';
    const t = trail.get(s.SessionId!);
    return {
      id: s.SessionId!, ...(s.Owner ? { owner: s.Owner } : {}), ...(s.StartDate ? { start: s.StartDate } : {}), ...(s.DocumentName ? { document: s.DocumentName } : {}),
      shell, hasLog: streams.has(s.SessionId!), trailed: Boolean(t), ...(t?.user ? { trailUser: t.user } : {}),
    };
  });
}

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const region = ctx.capabilities.app.region;
    const instanceId = ctx.capabilities.app.instance.id;
    const data = ctx.capabilities.modules['shell-access']?.data as { logGroup?: string } | undefined;
    const logGroup = strParam(ctx, 'logGroup', '') || data?.logGroup || '';
    const hours = numParam(ctx, 'hours', 2);
    const waitMs = numParam(ctx, 'waitMin', 15) * 60_000;
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    if (!logGroup) {
      ctx.note('不知道会话日志组：capabilities 的 shell-access 段没有 data.logGroup（需要管理员令牌），可用 --param logGroup=/cloudalbum/<env>/ssm-sessions');
      return;
    }
    const all = await awsJson<{ Sessions?: Session[] }>(['ssm', 'describe-sessions', '--state', 'History', '--filters', `key=Target,value=${instanceId}`, `key=InvokedAfter,value=${since}`], region);
    const platform = (all.Sessions ?? []).filter(isPlatformSession).length;
    const streamsOut = await awsJson<{ logStreams?: Array<{ logStreamName?: string }> }>(
      ['logs', 'describe-log-streams', '--log-group-name', logGroup, '--order-by', 'LastEventTime', '--descending', '--max-items', '50'], region);
    const streams = new Set((streamsOut.logStreams ?? []).map((s) => s.logStreamName ?? ''));

    let aligned: AlignedSession[] = [];
    const deadline = Date.now() + waitMs;
    let polls = 0;
    for (;;) {
      polls += 1;
      const trail = await awsJson<{ Events?: Array<{ Username?: string; CloudTrailEvent?: string }> }>(
        ['cloudtrail', 'lookup-events', '--lookup-attributes', 'AttributeKey=EventName,AttributeValue=StartSession', '--start-time', since, '--max-results', '50'], region);
      aligned = align(all.Sessions ?? [], streams, trailSessions(trail.Events ?? []));
      if (!aligned.length || aligned.every((s) => s.trailed) || Date.now() > deadline || ctx.signal.aborted) break;
      ctx.log(`CloudTrail 还没有全部 StartSession 事件（${aligned.filter((s) => s.trailed).length}/${aligned.length}），30 秒后再查`);
      await sleep(30_000, ctx.signal);
    }
    const shells = aligned.filter((s) => s.shell);
    ctx.finding('instanceId', instanceId);
    ctx.finding('logGroup', logGroup);
    ctx.finding('platformSessionsExcluded', platform);
    ctx.finding('sessions', aligned.length);
    ctx.finding('shellSessions', shells.length);
    ctx.finding('withLog', shells.filter((s) => s.hasLog).length);
    ctx.finding('withTrail', aligned.filter((s) => s.trailed).length);
    ctx.finding('aligned', shells.filter((s) => s.hasLog && s.trailed).length);
    ctx.finding('owners', [...new Set(aligned.map((s) => s.owner).filter(Boolean))]);
    ctx.finding('examples', aligned.slice(0, 3));
    ctx.finding('polls', polls);
    if (!aligned.length) ctx.note('最近没有学员发起的会话：先在工作台执行 aws ssm start-session --target <实验机>，执行几条命令后 exit');
    else if (!shells.some((s) => s.hasLog)) ctx.note('shell 会话没有日志流：检查会话首选项 SSM-SessionManagerRunShell 的 cloudWatchLogGroupName 与 cloudWatchEncryptionEnabled');
  },
});
