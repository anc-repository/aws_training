// iam 感知器（凭证来源：IMDS 角色、残留长期密钥、GetCallerIdentity + GetRole 两列）与 cdn 感知器（被动计数、本机监听器、GetDistribution）
import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import { GetRoleCommand, GetUserCommand, IAMClient } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { CdnDetector } from '../../src/modules/detectors/cdn.js';
import { ImdsClient } from '../../src/modules/detectors/ec2.js';
import { IamDetector, classifyCallerArn, keyPrefixOf, residualKeyFindings } from '../../src/modules/detectors/iam.js';
import { ENABLE } from '../helpers/config.js';
import { awsError, fakeCredentials, testConfig } from '../adapters/aws/helpers.js';

const sts = mockClient(STSClient);
const iam = mockClient(IAMClient);
const cloudfront = mockClient(CloudFrontClient);
afterEach(() => {
  sts.reset();
  iam.reset();
  cloudfront.reset();
});

const ROLE_ARN = 'arn:aws:sts::123456789012:assumed-role/CloudAlbumAppRole/i-0123456789abcdef0';

function imdsWithRole(role: string | null): ImdsClient {
  return new ImdsClient({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      if (p === '/latest/api/token' && init?.method === 'PUT') return new Response('tok', { status: 200 });
      if (p === '/latest/meta-data/iam/security-credentials/') return role ? new Response(`${role}\n`, { status: 200 }) : new Response('', { status: 404 });
      if (p === '/latest/meta-data/iam/info') return role ? new Response(JSON.stringify({ InstanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/CloudAlbumAppInstanceProfile' }), { status: 200 }) : new Response('', { status: 404 });
      return new Response('', { status: 404 });
    }) as typeof fetch,
  });
}

const unreachableImds = () => new ImdsClient({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });

function iamDetector(env: Record<string, string>, opts: { imds?: ImdsClient; processEnv?: NodeJS.ProcessEnv; creds?: () => Promise<{ accessKeyId: string; secretAccessKey: string; expiration?: Date }> | null } = {}) {
  const { cfg, effective } = testConfig(env);
  const credentials = opts.creds === null ? null : (opts.creds ?? fakeCredentials);
  return new IamDetector({ cfg, env: effective, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials }) }, {
    imds: opts.imds ?? imdsWithRole('CloudAlbumAppRole'), processEnv: opts.processEnv ?? {},
  });
}

describe('IamDetector', () => {
  it('role：IMDS 有角色 + assumed-role/CloudAlbumAppRole（ASIA，带过期倒计时）+ iam:GetRole 通过 → ok', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Arn: ROLE_ARN, Account: '123456789012' });
    iam.on(GetRoleCommand).resolves({ Role: { RoleName: 'CloudAlbumAppRole' } as never });
    const r = await iamDetector({ ...ENABLE.iamRole }).detect({});
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/^assumed-role\/CloudAlbumAppRole（ASIA…，约 \d+ 分钟后轮换） · 授权检查通过$/);
    expect(r.data).toMatchObject({ imdsRole: 'CloudAlbumAppRole', instanceProfileArn: expect.stringContaining('instance-profile') });
    expect(iam.commandCalls(GetRoleCommand)[0]!.args[0].input.RoleName).toBe('CloudAlbumAppRole');
  });

  it('撤销会话后：GetCallerIdentity 照常成功，但 iam:GetRole 被显式拒绝 → error（两列分别报告）', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Arn: ROLE_ARN });
    iam.on(GetRoleCommand).rejects(awsError('AccessDenied', 403, 'explicit deny in AWSRevokeOlderSessions'));
    const d = iamDetector({ ...ENABLE.iamRole });
    const r = await d.detect({});
    expect(r.status).toBe('error');
    expect(r.detail).toContain('授权检查失败（iam:GetRole）');
    expect(d.observations()).toMatchObject({ authorized: false, keyPrefix: 'ASIA' });
  });

  it('role：IMDS 中没有角色 → error；调用者不是预期角色 → error', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:sts::123456789012:assumed-role/OtherRole/i-1' });
    iam.on(GetRoleCommand).resolves({});
    const noRole = await iamDetector({ ...ENABLE.iamRole }, { imds: imdsWithRole(null) }).detect({});
    expect(noRole.status).toBe('error');
    expect(noRole.detail).toContain('实例未挂实例配置文件');
    const wrong = await iamDetector({ ...ENABLE.iamRole }).detect({});
    expect(wrong.detail).toContain('不是预期角色 CloudAlbumAppRole');
  });

  it('残留长期密钥（进程环境变量 / secrets.env 中的 IAM_KEYS_*）→ degraded', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Arn: ROLE_ARN });
    iam.on(GetRoleCommand).resolves({});
    const d = iamDetector({ ...ENABLE.iamRole, IAM_KEYS_ACCESS_KEY_ID: 'AKIAOLD', IAM_KEYS_SECRET_ACCESS_KEY: 'x' }, { processEnv: { AWS_ACCESS_KEY_ID: 'AKIAENV' } });
    const r = await d.detect({});
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('检测到残留的长期密钥');
    expect(d.observations()).toMatchObject({ residualLongTermKeys: true, imdsRole: 'CloudAlbumAppRole' });
  });

  it('keys（反面教材）：AKIA、永不过期、iam:GetUser → 始终 degraded（CRED-002）', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/cloudalbum-lab-demo-keys' });
    iam.on(GetUserCommand).resolves({ User: {} as never });
    const r = await iamDetector({ ...ENABLE.iamKeys }, { imds: unreachableImds(), creds: async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 's' }) }).detect({});
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('AKIA…，永不过期（需人工轮换）');
    expect(iam.commandCalls(GetUserCommand)[0]!.args[0].input.UserName).toBe('cloudalbum-lab-demo-keys');
  });

  it('none：应用未使用 AWS 凭证；不调用任何 AWS API', async () => {
    const r = await iamDetector({}, { creds: null, imds: unreachableImds() }).detect({});
    expect(r).toMatchObject({ status: 'ok', detail: '应用未使用 AWS 凭证' });
    expect(sts.calls()).toHaveLength(0);
  });

  it('辅助函数：ARN 分类、密钥前缀、残留密钥判定', () => {
    expect(classifyCallerArn(ROLE_ARN)).toEqual({ kind: 'assumed-role', account: '123456789012', name: 'CloudAlbumAppRole', session: 'i-0123456789abcdef0' });
    expect(classifyCallerArn('arn:aws:iam::123456789012:user/path/demo')).toEqual({ kind: 'user', account: '123456789012', name: 'demo' });
    expect(classifyCallerArn('arn:aws:iam::123456789012:root')).toEqual({ kind: 'root', account: '123456789012' });
    expect([keyPrefixOf('ASIAX'), keyPrefixOf('AKIAX'), keyPrefixOf('x')]).toEqual(['ASIA', 'AKIA', undefined]);
    expect(residualKeyFindings('keys', {}, { IAM_KEYS_ACCESS_KEY_ID: 'AKIA' })).toEqual([]);
    expect(residualKeyFindings('role', { AWS_PROFILE: 'dev' }, {})).toEqual(['进程环境变量中有 AWS_PROFILE=dev']);
  });
});

describe('CdnDetector', () => {
  const cdnEnv = { ...ENABLE.iamRole, ...ENABLE.cdn, CDN_DISTRIBUTION_ID: 'E123EXAMPLE' };

  function cdn(env: Record<string, string> = cdnEnv, opts: { listener?: boolean; creds?: boolean; now?: () => number } = {}) {
    const { cfg, effective } = testConfig(env);
    return new CdnDetector({ cfg, env: effective, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials: opts.creds === false ? null : fakeCredentials }) }, {
      platform: 'linux', probePort: async () => opts.listener ?? true, ...(opts.now ? { now: opts.now } : {}),
    });
  }

  it('observe：只信任回环地址传来的 entry；带 X-Amz-Cf-Id 却不是 cloudfront> 的请求记为 X-Origin-Verify 不匹配', () => {
    const d = cdn();
    d.observe({ headers: { 'x-cloudalbum-entry': 'cloudfront>nginx', 'x-amz-cf-id': 'abc' }, remoteAddr: '127.0.0.1' });
    d.observe({ headers: { 'x-cloudalbum-entry': 'cloudfront>alb>nginx' }, remoteAddr: '::1' });
    d.observe({ headers: { 'x-cloudalbum-entry': 'nginx', 'x-amz-cf-id': 'evil' }, remoteAddr: '127.0.0.1' });
    d.observe({ headers: { 'x-cloudalbum-entry': 'cloudfront>nginx' }, remoteAddr: '203.0.113.9' });   // 不可信来源
    d.observe({ headers: {}, remoteAddr: '127.0.0.1' });
    expect(d.stats()).toEqual({ requests5m: 5, viaCdn5m: 2, viaCdnRatio5m: 0.4, cfIdSeen5m: 2, originVerifyMismatch5m: 1 });
    expect(d.observations()).toMatchObject({ originVerifyMismatch5m: 1, listener8080Missing: false });
  });

  it('计数只保留最近 5 分钟', () => {
    let now = 1_000_000_000;
    const d = cdn(cdnEnv, { now: () => now });
    d.observe({ headers: { 'x-amz-cf-id': 'x' }, remoteAddr: '127.0.0.1' });
    now += 4 * 60_000;
    expect(d.stats().requests5m).toBe(1);
    now += 2 * 60_000;
    expect(d.stats()).toMatchObject({ requests5m: 0, originVerifyMismatch5m: 0, viaCdnRatio5m: null });
  });

  it('detect：分配 Deployed → ok（confirmed）；InProgress → degraded；已禁用 / 不存在 → error', async () => {
    cloudfront.on(GetDistributionCommand).resolves({ Distribution: { Id: 'E123EXAMPLE', Status: 'Deployed', DomainName: 'd111.cloudfront.net', DistributionConfig: { Enabled: true } as never } as never });
    const ok = await cdn().detect({});
    expect(ok).toMatchObject({ status: 'ok', confidence: 'confirmed' });
    expect(ok.detail).toContain('分配 Deployed');
    cloudfront.on(GetDistributionCommand).resolves({ Distribution: { Status: 'InProgress', DistributionConfig: { Enabled: true } as never } as never });
    expect((await cdn().detect({})).status).toBe('degraded');
    cloudfront.on(GetDistributionCommand).resolves({ Distribution: { Status: 'Deployed', DistributionConfig: { Enabled: false } as never } as never });
    expect((await cdn().detect({})).status).toBe('error');
    cloudfront.on(GetDistributionCommand).rejects(awsError('NoSuchDistribution', 404));
    expect((await cdn().detect({})).detail).toContain('不存在');
  });

  it('detect：8080 监听器缺失、无凭证（CRED-004）、DEP-028 → degraded；observations 带 listener8080Missing', async () => {
    const d = cdn(cdnEnv, { listener: false, creds: false });
    const r = await d.detect({});
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('127.0.0.1:8080 没有监听器');
    expect(r.detail).toContain('CRED-004');
    expect(d.observations()).toMatchObject({ listener8080Missing: true });
    const dep028 = await cdn({ ...cdnEnv, ...ENABLE.s3 }, { creds: false }).detect({});
    expect(dep028.detail).toContain('DEP-028');
  });
});
