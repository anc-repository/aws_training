// shell-access 感知器：ssh 基线（安全快照）、ssm 控制面三路信号（PingStatus、22 端口入站、会话首选项）、深度探针的会话对照
// （排除平台终端会话）、慢请求的宽限（stale-while-revalidate + transient）、SEC-003 的 observations
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CloudWatchLogsClient, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeSecurityGroupsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeInstanceInformationCommand, DescribeSessionsCommand, GetDocumentCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { ImdsClient } from '../../src/modules/detectors/ec2.js';
import { ShellAccessDetector, isPlatformSession, rulesCovering22 } from '../../src/modules/detectors/shell-access.js';
import { ENABLE } from '../helpers/config.js';
import { awsError, fakeCredentials, sleep, testConfig } from '../adapters/aws/helpers.js';

const ssm = mockClient(SSMClient);
const ec2 = mockClient(EC2Client);
const logs = mockClient(CloudWatchLogsClient);
afterEach(() => {
  ssm.reset();
  ec2.reset();
  logs.reset();
});

const INSTANCE = 'i-0123456789abcdef0';
const SG = 'sg-0aaa';

function imds(): ImdsClient {
  return new ImdsClient({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      if (p === '/latest/api/token' && init?.method === 'PUT') return new Response('tok', { status: 200 });
      if (p === '/latest/meta-data/instance-id') return new Response(INSTANCE, { status: 200 });
      if (p === '/latest/meta-data/mac') return new Response('0a:00:00:00:00:01', { status: 200 });
      if (p === '/latest/meta-data/network/interfaces/macs/0a:00:00:00:00:01/security-group-ids') return new Response(`${SG}\nsg-0bbb`, { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch,
  });
}

const unreachable = () => new ImdsClient({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch, retries: 0 });

function detector(env: Record<string, string>, opts: { imds?: ImdsClient; budgetMs?: number } = {}): { det: ShellAccessDetector; dataDir: string } {
  const { cfg, effective, dataDir } = testConfig(env);
  const det = new ShellAccessDetector({ cfg, env: effective, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials: fakeCredentials }) },
    { imds: opts.imds ?? imds(), ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}) });
  return { det, dataDir };
}

const ssmEnv = { ...ENABLE.iamRole, ...ENABLE.shellAccess };
const prefs = (logGroup: string) => ({ Content: JSON.stringify({ schemaVersion: '1.0', sessionType: 'Standard_Stream', inputs: { cloudWatchLogGroupName: logGroup, runAsDefaultUser: 'cloudalbum-ops' } }) });

function online(): void {
  ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [{ InstanceId: INSTANCE, PingStatus: 'Online', AgentVersion: '3.3.987.0', LastPingDateTime: new Date() }] });
  ssm.on(GetDocumentCommand).resolves(prefs('/cloudalbum/lab/ssm-sessions'));
}

describe('ShellAccessDetector · ssm', () => {
  beforeEach(() => online());

  it('Agent Online + 安全组没有 22 入站 + 首选项指向本模块的日志组 → ok（detail 含“无管理端口入站”）', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: SG, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }] });
    const { det } = detector(ssmEnv);
    const r = await det.detect({});
    expect(r.status).toBe('ok');
    expect(r.confidence).toBe('confirmed');
    expect(r.detail).toBe('Agent Online（版本 3.3.987.0） · 无管理端口入站 · 会话日志 → /cloudalbum/lab/ssm-sessions');
    expect(r.data).toMatchObject({ instanceId: INSTANCE, securityGroupIds: [SG, 'sg-0bbb'], pingStatus: 'Online', port22: [] });
    expect(ec2.commandCalls(DescribeSecurityGroupsCommand)[0]!.args[0].input.GroupIds).toEqual([SG, 'sg-0bbb']);
    expect(ssm.commandCalls(DescribeInstanceInformationCommand)[0]!.args[0].input.Filters).toEqual([{ Key: 'InstanceIds', Values: [INSTANCE] }]);
    expect(det.observations()).toEqual({ port22Open: false });
  });

  it('22 仍开放（含协议 -1 的全部流量）→ degraded；KEEP_SSH=true 时文案是“过渡期”；observations 给 SEC-003', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: SG, IpPermissions: [
      { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '203.0.113.10/32' }] },
    ] }] });
    let { det } = detector(ssmEnv);
    let r = await det.detect({});
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('安全组仍开放 22（入站 22/tcp ← 203.0.113.10/32；SEC-003）');
    expect(r.detail).not.toContain('无管理端口入站');
    expect(det.observations()).toEqual({ port22Open: true });
    ({ det } = detector({ ...ssmEnv, SHELL_ACCESS_KEEP_SSH: 'true' }));
    r = await det.detect({});
    expect(r.detail).toContain('过渡期：22 仍开放');
  });

  it('Agent ConnectionLost / 未注册 → error', async () => {
    ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [{ InstanceId: INSTANCE, PingStatus: 'ConnectionLost' }] });
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    expect((await detector(ssmEnv).det.detect({})).status).toBe('error');
    ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [] });
    const r = await detector(ssmEnv).det.detect({});
    expect(r.status).toBe('error');
    expect(r.detail).toContain('SSM Agent NotRegistered');
  });

  it('AccessDenied 是确定性失败 → error（检查 PolicyArn）', async () => {
    ssm.on(DescribeInstanceInformationCommand).rejects(awsError('AccessDeniedException', 400, 'not authorized to perform ssm:DescribeInstanceInformation'));
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    const r = await detector(ssmEnv).det.detect({});
    expect(r.status).toBe('error');
    expect(r.detail).toContain('PolicyArn');
  });

  it('首次控制面请求很慢：先返回 degraded + transient，不报 error；后台完成后下一轮给出结论', async () => {
    ec2.on(DescribeSecurityGroupsCommand).callsFake(async () => { await sleep(300); return { SecurityGroups: [] }; });
    const { det } = detector(ssmEnv, { budgetMs: 50 });
    const first = await det.detect({});
    expect(first).toMatchObject({ status: 'degraded', transient: true });
    expect(first.detail).toContain('正在查询 SSM 控制面');
    await sleep(400);
    expect((await det.detect({})).status).toBe('ok');
  });

  it('瞬时错误（节流）在重试后仍失败 → degraded + transient', async () => {
    ssm.on(DescribeInstanceInformationCommand).rejects(awsError('ThrottlingException', 400, 'Rate exceeded'));
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    const { det } = detector(ssmEnv, { budgetMs: 3000 });
    const r = await det.detect({});
    expect(r).toMatchObject({ status: 'degraded', transient: true });
  });

  it('会话首选项被改成别的日志组 / 不存在 → degraded', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    ssm.on(GetDocumentCommand).resolves(prefs('/someone/else'));
    let r = await detector(ssmEnv).det.detect({});
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('/someone/else');
    ssm.on(GetDocumentCommand).rejects(awsError('InvalidDocument', 400, 'document does not exist'));
    r = await detector(ssmEnv).det.detect({});
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('不存在');
  });

  it('深度探针：最近会话（排除平台终端会话）对照会话日志流；shell 会话没有日志流 → degraded', async () => {
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [] });
    ssm.on(DescribeSessionsCommand).resolves({ Sessions: [
      { SessionId: 'atl-s1-ws-0abc', Owner: 'arn:aws:sts::1:assumed-role/ATLLearnerRole/atl-s1-ws', DocumentName: 'SSM-SessionManagerRunShell', StartDate: new Date(), EndDate: new Date() },
      { SessionId: 'atl-s1-term-0def', DocumentName: 'ATL-SessionShell', StartDate: new Date(), EndDate: new Date() },
      { SessionId: 'atl-s1-ws-0fwd', DocumentName: 'AWS-StartPortForwardingSession', StartDate: new Date(), EndDate: new Date() },
    ] });
    logs.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 'atl-s1-ws-0abc' }] });
    let r = await detector(ssmEnv).det.detect({ deep: true });
    expect(r.status).toBe('ok');
    const sessions = (r.data as { sessions: Array<{ id: string; hasLog?: boolean }> }).sessions;
    expect(sessions.map((s) => s.id)).toEqual(['atl-s1-ws-0abc', 'atl-s1-ws-0fwd']);
    expect(sessions[0]!.hasLog).toBe(true);
    expect(ssm.commandCalls(DescribeSessionsCommand)[0]!.args[0].input).toMatchObject({ State: 'History', Filters: [{ key: 'Target', value: INSTANCE }] });
    logs.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    r = await detector(ssmEnv).det.detect({ deep: true });
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('没有日志流');
  });

  it('不在 EC2 上（IMDS 不可达）→ degraded + inferred（开发机）', async () => {
    const r = await detector(ssmEnv, { imds: unreachable() }).det.detect({});
    expect(r).toMatchObject({ status: 'degraded', confidence: 'inferred' });
    expect(r.detail).toContain('不在 EC2 上');
  });
});

describe('ShellAccessDetector · ssh 基线', () => {
  function withSnapshot(snap: unknown): ShellAccessDetector {
    const { det, dataDir } = detector({ ...ENABLE.iamRole });
    mkdirSync(path.join(dataDir, 'security'), { recursive: true });
    writeFileSync(path.join(dataDir, 'security', 'snapshot.json'), JSON.stringify(snap));
    return det;
  }

  it('快照新鲜、sshd 监听 → ok（observed），detail 含近 24 小时失败次数；不调用 AWS', async () => {
    const det = withSnapshot({ generatedAt: new Date().toISOString(), sshd: { listening: true, failures24h: 7, recentLogins: ['ec2-user@10.0.0.5'] } });
    const r = await det.detect({});
    expect(r).toMatchObject({ status: 'ok', confidence: 'observed' });
    expect(r.detail).toContain('近 24 小时失败 7 次');
    expect(ssm.calls()).toHaveLength(0);
    expect(r.data).toMatchObject({ mode: 'ssh', sshd: { recentLogins: ['ec2-user@10.0.0.5'] } });
  });

  it('sshd 未监听 → error；快照过期 → degraded（inferred）；没有快照 → degraded', async () => {
    expect((await withSnapshot({ generatedAt: new Date().toISOString(), sshd: { listening: false } }).detect({})).status).toBe('error');
    const stale = await withSnapshot({ generatedAt: new Date(Date.now() - 600_000).toISOString(), sshd: { listening: true } }).detect({});
    expect(stale).toMatchObject({ status: 'degraded', confidence: 'inferred' });
    expect((await detector({ ...ENABLE.iamRole }).det.detect({})).status).toBe('degraded');
  });
});

describe('辅助函数', () => {
  it('rulesCovering22：端口范围、协议 -1、安全组引用', () => {
    expect(rulesCovering22([
      { IpProtocol: 'tcp', FromPort: 0, ToPort: 1024, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
      { IpProtocol: '-1', UserIdGroupPairs: [{ GroupId: 'sg-1' }] },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      { IpProtocol: 'udp', FromPort: 22, ToPort: 22 },
    ]).map((r) => r.sources)).toEqual([['10.0.0.0/8'], ['sg-1']]);
  });

  it('isPlatformSession：ATL-SessionShell* 文档或 atl-<sid>-term- 前缀', () => {
    expect(isPlatformSession({ SessionId: 'atl-e7k2m9qx-term-abc' })).toBe(true);
    expect(isPlatformSession({ SessionId: 'x', DocumentName: 'ATL-SessionShell-Logged' })).toBe(true);
    expect(isPlatformSession({ SessionId: 'atl-e7k2m9qx-ws-abc', DocumentName: 'SSM-SessionManagerRunShell' })).toBe(false);
  });
});
