// wave1-waf: module hook of waf (module-hooks/waf.ts) — stack selection (edge in us-east-1 / regional / AlsoRegional), stack
// parameters (RuleAction, rate limits, LabAllowCidr, re-enable keeps the last values), the cdn inject, DEP-018 note, adopting the
// retained log group, the first IP-set import of denylist.conf (optimistic lock), disable notes. No AWS call is executed:
// dry-run gateway, or a scripted fake gateway; remote scripts go to a recording deliverer.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AwsCallError, type AwsCall, type AwsGateway } from '../src/aws.js';
import { createContext } from '../src/context.js';
import type { PlanStep } from '../src/deps.js';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import type { Prepared } from '../src/hooks.js';
import type { HookArgs, StackPlan } from '../src/module-hooks/index.js';
import { denylistToIpSet, normalizeAllowList, toIpv4Cidr, wafHook } from '../src/module-hooks/waf.js';
import { CapturePrinter, CliError } from '../src/printer.js';
import type { CloudAlbumState, ModuleRecord } from '../src/state.js';
import { loadTemplate, mainTemplatePath } from '../src/template.js';
import { REPO_ROOT, RecordingDeliverer, deployedState, dryContext } from './helpers.js';

const ACL = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/cloudalbum-lab-acl/0000';

function rec(p: Partial<ModuleRecord>): ModuleRecord {
  return { enabledAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', tier: 'aws', value: 'aws', version: 1, env: {}, stacks: [], outputs: {}, params: {}, secretKeys: [], ...p };
}

/** base + iam(role) + cdn (open) — the start state of svc-waf */
function withCdn(extraCdnEnv: Record<string, string> = {}): CloudAlbumState {
  const s = deployedState();
  s.iam = { mode: 'role', roleName: 'CloudAlbumAppRole' };
  s.modules.iam = rec({ value: 'role', env: { MODULE_IAM: 'on', IAM_CREDENTIALS: 'role' }, stacks: [{ name: 'main', stackName: 'cloudalbum-lab-iam', region: 'ap-northeast-1' }] });
  s.modules.cdn = rec({
    env: { MODULE_CDN: 'on', CDN_BASE_URL: 'https://d111111abcdef8.cloudfront.net', CDN_DIRECT_ACCESS: 'open', CDN_ORIGIN_TYPE: 'ec2', ...extraCdnEnv },
    stacks: [{ name: 'main', stackName: 'cloudalbum-lab-cdn', region: 'ap-northeast-1' }],
    outputs: { EnvCdnBaseUrl: 'https://d111111abcdef8.cloudfront.net', InfoDistributionArn: 'arn:aws:cloudfront::123456789012:distribution/E2Q', InfoOriginSecurityGroupId: 'sg-0cdn' },
    params: { VpcId: 'vpc-0aaa', WebAclArn: '' },
  });
  return s;
}

class ScriptedGateway implements AwsGateway {
  readonly dryRun = false;
  readonly calls: AwsCall[] = [];
  constructor(private readonly reply: (c: AwsCall) => unknown) {}
  async send<T>(call: AwsCall): Promise<T | undefined> {
    this.calls.push(call);
    const r = this.reply(call);
    if (r instanceof Error) throw new AwsCallError(call, r);
    return r as T;
  }
}

function liveContext(state: CloudAlbumState, reply: (c: AwsCall) => unknown, denylist?: string) {
  const out = new CapturePrinter();
  const aws = new ScriptedGateway(reply);
  const deliverer = new RecordingDeliverer(false, () => (denylist === undefined ? { code: 1, stdout: '', stderr: 'no ssh' } : { code: 0, stdout: denylist, stderr: '' }));
  const ctx = createContext({ yes: true, skipLocalCheck: true, state: path.join(REPO_ROOT, '.cloudalbum', 'never-written.json') },
    { aws, out, deliverer, repoRoot: REPO_ROOT, state });
  return { ctx, out, aws, deliverer };
}

const step: PlanStep = { module: 'waf', value: 'aws', tier: 'aws', settings: {}, reason: 'requested', isTarget: true };
const args = (params: Record<string, string> = {}, extra: Partial<HookArgs> = {}): HookArgs => ({ params, planOnly: false, isTarget: true, ...extra });
const prepared = (): Prepared => ({ params: {}, secretParams: [], secrets: {}, settings: {}, remote: [], notes: [] });
const paramsOf = (c: AwsCall) => Object.fromEntries((c.input.Parameters as Array<{ ParameterKey: string; ParameterValue: string }>).map((p) => [p.ParameterKey, p.ParameterValue]));

describe('waf hook: enable (dry-run)', () => {
  it('cdn enabled: stack waf-edge in us-east-1 (CLOUDFRONT, count), inject WebAclArn -> cdn, WAF_SCOPE in the env, DEP-018 note', async () => {
    const { ctx, out, aws } = dryContext(withCdn());
    expect(await enableCommand(ctx, 'waf', {})).toBe(0);
    const deploy = aws.calls.find((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === 'cloudalbum-lab-waf-edge')!;
    expect(deploy.region).toBe('us-east-1');
    expect(paramsOf(deploy)).toMatchObject({
      Env: 'lab', StackRole: 'edge', Scope: 'CLOUDFRONT', RuleAction: 'count', RateLimit: '300', LoginRateLimit: '100', RateWindowSec: '300',
      RateKey: 'IP', LabAllowCidr: '', CreateLogGroup: 'true',
    });
    expect(aws.calls.some((c) => c.input.StackName === 'cloudalbum-lab-waf-regional')).toBe(false);
    const inject = aws.calls.find((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === 'cloudalbum-lab-cdn')!;
    expect(paramsOf(inject).WebAclArn).toBe('<cloudalbum-lab-waf-edge:EnvWafWebAclArn>');
    expect(ctx.state.modules.waf?.env).toMatchObject({ WAF_MODE: 'aws', WAF_SCOPE: 'CLOUDFRONT', WAF_RULE_ACTION: 'count', WAF_RATE_LIMIT: '300', WAF_RATE_WINDOW_SEC: '300', WAF_IP_SET_NAME: 'cloudalbum-blocklist' });
    expect(out.text()).toContain('DEP-018: CDN_DIRECT_ACCESS=open');
    expect(out.text()).toContain('aws logs:DescribeLogGroups [us-east-1]');
    expect(out.text()).toContain('first import: read /var/lib/cloudalbum/security/denylist.conf');
  });

  it('origin locked (CDN_DIRECT_ACCESS=admin-ip): no DEP-018 note', async () => {
    const { ctx, out } = dryContext(withCdn({ CDN_DIRECT_ACCESS: 'admin-ip', CDN_ADMIN_CIDR: '198.51.100.7/32' }));
    expect(await enableCommand(ctx, 'waf', {})).toBe(0);
    expect(out.text()).not.toContain('DEP-018: CDN_DIRECT_ACCESS=open');
  });

  it('--param RuleAction=block / --set WAF_LAB_ALLOW_CIDR: stack parameters and env agree; a re-enable keeps the last values', async () => {
    const { ctx, aws } = dryContext(withCdn());
    expect(await enableCommand(ctx, 'waf', { param: ['RuleAction=block', 'RateWindowSec=60', 'RateLimit=100'], set: ['WAF_LAB_ALLOW_CIDR=203.0.113.10'] })).toBe(0);
    const first = paramsOf(aws.calls.find((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === 'cloudalbum-lab-waf-edge')!);
    expect(first).toMatchObject({ RuleAction: 'block', RateWindowSec: '60', RateLimit: '100', LabAllowCidr: '203.0.113.10/32' });
    expect(ctx.state.modules.waf?.env).toMatchObject({ WAF_RULE_ACTION: 'block', WAF_RATE_WINDOW_SEC: '60', WAF_RATE_LIMIT: '100', WAF_LAB_ALLOW_CIDR: '203.0.113.10/32' });
    aws.calls.length = 0;
    expect(await enableCommand(ctx, 'waf', {})).toBe(0);
    const again = paramsOf(aws.calls.find((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === 'cloudalbum-lab-waf-edge')!);
    expect(again).toMatchObject({ RuleAction: 'block', RateWindowSec: '60', LabAllowCidr: '203.0.113.10/32' });
  });

  it('no mount point (only L0): DEP-006 stops enable with exit 2; nothing is deployed', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'waf', {})).toBe(2);
    expect(out.text()).toContain('DEP-006');
    expect(aws.calls.filter((c) => c.op === 'CreateOrUpdateStack')).toEqual([]);
  });

  it('invalid parameters are refused before any stack: RuleAction, RateWindowSec, RateLimit < 10, LabAllowCidr, unreplaced placeholder', () => {
    const { ctx } = dryContext(withCdn());
    expect(() => wafHook.plan!(ctx, step, args({ RuleAction: 'deny' }))).toThrow(CliError);
    expect(() => wafHook.plan!(ctx, step, args({ RateWindowSec: '30' }))).toThrow(/60 \| 120 \| 300 \| 600/);
    expect(() => wafHook.plan!(ctx, step, args({ RateLimit: '5' }))).toThrow(/>= 10/);
    expect(() => wafHook.plan!(ctx, step, args({ LabAllowCidr: '2001:db8::1' }))).toThrow(/IPV4/);
    expect(() => wafHook.plan!(ctx, step, args({ LabAllowCidr: '${atl:workstationPublicCidr}' }))).toThrow(/placeholder/);
  });
});

describe('waf hook: stacks()', () => {
  const edge: StackPlan = { name: 'edge', template: 'infra/modules/waf.yaml', region: 'us-east-1' };
  const regional: StackPlan = { name: 'regional', template: 'infra/modules/waf.yaml', region: 'ap-northeast-1' };

  it('cdn and load-balancer: edge only; AlsoRegional=true adds the regional web ACL with FORWARDED_IP rate keys', () => {
    const { ctx, out } = dryContext(withCdn());
    const only = wafHook.stacks!(ctx, step, args(), [edge, regional], {});
    expect(only.map((s) => s.name)).toEqual(['edge']);
    expect(out.text()).toContain('--param AlsoRegional=true');
    const both = wafHook.stacks!(ctx, step, args({ AlsoRegional: 'true' }), [edge, regional], {});
    expect(both.map((s) => [s.name, s.params?.Scope, s.params?.RateKey, s.params?.StackRole])).toEqual([
      ['edge', 'CLOUDFRONT', 'IP', 'edge'], ['regional', 'REGIONAL', 'FORWARDED_IP', 'regional'],
    ]);
  });

  it('load-balancer only: the regional stack keeps IP rate keys (the ALB sees the client)', () => {
    const { ctx } = dryContext();
    const r = wafHook.stacks!(ctx, step, args(), [regional], {});
    expect(r[0]!.params).toMatchObject({ Scope: 'REGIONAL', RateKey: 'IP', StackRole: 'regional' });
  });
});

describe('waf hook: prepare (retained log group)', () => {
  it('the log group of an earlier deployment exists -> CreateLogGroup=false (adopted); not found -> true', async () => {
    const found = liveContext(withCdn(), () => ({ logGroups: [{ logGroupName: 'aws-waf-logs-cloudalbum-lab' }] }));
    const p = prepared();
    await wafHook.prepare!(found.ctx, step, args(), p);
    expect(found.aws.calls[0]).toMatchObject({ service: 'logs', op: 'DescribeLogGroups', region: 'us-east-1' });
    expect(p.notes.join('\n')).toContain('already exists (retained by an earlier disable): adopted');
    expect(wafHook.stacks!(found.ctx, step, args(), [{ name: 'edge', template: 'infra/modules/waf.yaml', region: 'us-east-1' }], {})[0]!.params?.CreateLogGroup).toBe('false');
    const none = liveContext(withCdn(), () => ({ logGroups: [] }));
    await wafHook.prepare!(none.ctx, step, args(), prepared());
    expect(wafHook.stacks!(none.ctx, step, args(), [{ name: 'edge', template: 'infra/modules/waf.yaml', region: 'us-east-1' }], {})[0]!.params?.CreateLogGroup).toBe('true');
  });

  it('an update of a deployed stack never flips CreateLogGroup (no DescribeLogGroups)', async () => {
    const s = withCdn();
    s.modules.waf = rec({ stacks: [{ name: 'edge', stackName: 'cloudalbum-lab-waf-edge', region: 'us-east-1' }], params: { CreateLogGroup: 'false', RuleAction: 'count' } });
    const { ctx, aws } = liveContext(s, () => ({ logGroups: [] }));
    await wafHook.prepare!(ctx, step, args(), prepared());
    expect(aws.calls).toEqual([]);
    expect(wafHook.stacks!(ctx, step, args(), [{ name: 'edge', template: 'infra/modules/waf.yaml', region: 'us-east-1' }], {})[0]!.params?.CreateLogGroup).toBe('false');
  });
});

describe('waf hook: first IP-set import (afterDeploy)', () => {
  const deployed = {
    outputs: { EnvWafScope: 'CLOUDFRONT', EnvWafIpSetId: 'ipset-0000', EnvWafIpSetName: 'cloudalbum-blocklist', EnvWafWebAclArn: ACL },
    byStack: { edge: { EnvWafScope: 'CLOUDFRONT', EnvWafIpSetId: 'ipset-0000', EnvWafIpSetName: 'cloudalbum-blocklist' } },
    stacks: [{ name: 'edge', template: 'infra/modules/waf.yaml', region: 'us-east-1' }],
  };
  const DENY = [
    '# CloudAlbum denylist',
    '198.51.100.77/24 1;  # src=admin ts=2026-10-14T00:00:00Z note="scanner"',
    '192.0.2.1 1;  # src=fail2ban ts=2026-10-14T00:00:00Z until=2999-01-01T00:00:00Z note="http"',
    '203.0.113.9 1;  # src=fail2ban ts=2026-10-01T00:00:00Z until=2001-01-01T00:00:00Z note="expired"',
    '2001:db8::1 1;  # src=admin ts=2026-10-14T00:00:00Z note="v6"',
  ].join('\n');

  it('reads denylist.conf over the delivery channel and replaces the IP set (us-east-1, LockToken, Description kept); retries a stale lock', async () => {
    let lock = 0;
    const { ctx, out, aws, deliverer } = liveContext(withCdn(), (c) => {
      if (c.op === 'GetIPSet') return { IPSet: { Addresses: [], Description: 'CloudAlbum denylist' }, LockToken: `t${lock}` };
      if (c.op === 'UpdateIPSet') {
        lock += 1;
        return lock === 1 ? Object.assign(new Error('WAFOptimisticLockException: stale token'), { name: 'WAFOptimisticLockException' }) : {};
      }
      return {};
    }, DENY);
    await wafHook.afterDeploy!(ctx, step, args(), deployed, prepared());
    expect(deliverer.scripts[0]!.title).toContain('denylist.conf');
    const updates = aws.calls.filter((c) => c.op === 'UpdateIPSet');
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      service: 'wafv2', region: 'us-east-1',
      input: { Name: 'cloudalbum-blocklist', Scope: 'CLOUDFRONT', Id: 'ipset-0000', Addresses: ['192.0.2.1/32', '198.51.100.0/24'], LockToken: 't1', Description: 'CloudAlbum denylist' },
    });
    expect(out.text()).toContain('imported 2 IPv4 entries of denylist.conf into cloudalbum-blocklist (1 IPv6 entries stay local)');
  });

  it('already in sync: no UpdateIPSet; a failure (no delivery channel, AccessDenied) only warns', async () => {
    const same = liveContext(withCdn(), () => ({ IPSet: { Addresses: ['198.51.100.0/24', '192.0.2.1/32'] }, LockToken: 't' }), DENY);
    await wafHook.afterDeploy!(same.ctx, step, args(), deployed, prepared());
    expect(same.aws.calls.map((c) => c.op)).toEqual(['GetIPSet']);
    const noChannel = liveContext(withCdn(), () => ({}));
    await wafHook.afterDeploy!(noChannel.ctx, step, args(), deployed, prepared());
    expect(noChannel.out.text()).toContain('could not read denylist.conf');
    const denied = liveContext(withCdn(), () => Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }), DENY);
    await wafHook.afterDeploy!(denied.ctx, step, args(), deployed, prepared());
    expect(denied.out.text()).toContain('first IP-set import failed');
  });
});

describe('waf hook: disable, hints, pure functions', () => {
  it('disable --dry-run: cdn gets WebAclArn=\'\' before the web ACL stack is deleted; the retained log group is named', async () => {
    const { ctx, out, aws } = dryContext(withCdn());
    expect(await enableCommand(ctx, 'waf', {})).toBe(0);
    aws.calls.length = 0;
    expect(await disableCommand(ctx, 'waf', {})).toBe(0);
    const unInject = aws.calls.findIndex((c) => c.op === 'CreateOrUpdateStack' && c.input.StackName === 'cloudalbum-lab-cdn' && paramsOf(c).WebAclArn === '');
    const del = aws.calls.findIndex((c) => c.op === 'DeleteStack' && c.input.StackName === 'cloudalbum-lab-waf-edge');
    expect(unInject).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(unInject);
    expect(aws.calls[del]!.region).toBe('us-east-1');
    expect(out.text()).toContain('aws logs delete-log-group --region us-east-1 --log-group-name aws-waf-logs-cloudalbum-lab');
  });

  it('planHints name DEP-006 / DEP-018; the local tier has none', () => {
    expect(wafHook.planHints!(step).join(' ')).toMatch(/DEP-006.*DEP-018/s);
    expect(wafHook.planHints!({ ...step, tier: 'local', value: 'nginx' })).toEqual([]);
  });

  it('toIpv4Cidr / normalizeAllowList / denylistToIpSet', () => {
    expect([toIpv4Cidr('192.0.2.1'), toIpv4Cidr('198.51.100.77/24'), toIpv4Cidr('256.1.1.1'), toIpv4Cidr('1.2.3.4/0')]).toEqual(['192.0.2.1/32', '198.51.100.0/24', undefined, undefined]);
    expect(normalizeAllowList(' 203.0.113.10 ,203.0.113.10/32, 198.51.100.0/24')).toBe('203.0.113.10/32,198.51.100.0/24');
    expect(normalizeAllowList('')).toBe('');
    expect(denylistToIpSet('192.0.2.1 1;\n2001:db8::1 1;\nnot a line\n203.0.113.1 1;  # until=2000-01-01T00:00:00Z')).toEqual({ addresses: ['192.0.2.1/32'], skippedIpv6: 1 });
  });
});

describe('waf template: least privilege and X-Forwarded-For (wave1-fix)', () => {
  const t = loadTemplate(REPO_ROOT, mainTemplatePath('waf'));
  const policy = JSON.stringify(t.Resources.AppPolicy!.Properties);

  it('the application policy may update the blocklist only, never the allow-lab IP set (priority 0 Allow skips every rule)', () => {
    expect(policy).not.toContain('LabAllowIpSet');
    const sync = (t.Resources.AppPolicy!.Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement
      .find((s) => s.Sid === 'SyncIpSets')!;
    expect(sync.Resource).toEqual({ 'Fn::GetAtt': ['BlockIpSet', 'Arn'] });
  });

  it('FORWARDED_IP (regional ACL behind CloudFront): IP sets match the LAST X-Forwarded-For address; rate rules only without FORWARDED_IP', () => {
    const rules = (t.Resources.WebAcl!.Properties!.Rules as unknown[]);
    const text = JSON.stringify(rules);
    expect(text).not.toContain('"Position":"FIRST"');
    expect(text.match(/"Position":"LAST"/g)).toHaveLength(2);
    expect(text).not.toContain('FORWARDED_IP');
    const conditional = rules.filter((r): r is { 'Fn::If': [string, unknown, { Name: string }] } => typeof r === 'object' && r !== null && 'Fn::If' in r);
    expect(conditional.map((r) => [r['Fn::If'][0], r['Fn::If'][1], r['Fn::If'][2].Name])).toEqual([
      ['UseForwardedIp', { Ref: 'AWS::NoValue' }, 'rate-login'],
      ['UseForwardedIp', { Ref: 'AWS::NoValue' }, 'rate-global'],
    ]);
  });
});
