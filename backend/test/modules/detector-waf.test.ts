// waf 感知器（01#waf 第 3、10 节；wave1-waf）：被动比例（只信任回环地址传来的 entry）、控制面判定（Web ACL 不存在 / 无权限 / 瞬时失败 /
// 未关联 / 托管规则组动作与 WAF_RULE_ACTION 不一致）、REGIONAL 的关联查询、无凭证降级、DEP-018 不由探针重复判定、控制面缓存。
// WAFv2 与 CloudFront 由 aws-sdk-client-mock 拦截。
import { CloudFrontClient, ListDistributionsByWebACLIdCommand } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { GetIPSetCommand, GetWebACLCommand, ListResourcesForWebACLCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { MIN_EDGE_SAMPLES, summarizeRules, WafDetector } from '../../src/modules/detectors/waf.js';
import { ENABLE } from '../helpers/config.js';
import { awsError, fakeCredentials, testConfig } from '../adapters/aws/helpers.js';

const waf = mockClient(WAFV2Client);
const cf = mockClient(CloudFrontClient);
const cw = mockClient(CloudWatchClient);

const managed = (name: string, override: 'Count' | 'None') => ({
  Name: name, Priority: 5, Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: name } }, OverrideAction: { [override]: {} },
  VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: name },
});

function acl(override: 'Count' | 'None' = 'Count') {
  return {
    WebACL: {
      Name: 'cloudalbum-lab-acl', Id: '0000', ARN: ENABLE.waf.WAF_WEB_ACL_ARN, Capacity: 1157, DefaultAction: { Allow: {} },
      VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'cloudalbum-lab-acl' },
      Rules: [
        { Name: 'rate-global', Priority: 3, Statement: { RateBasedStatement: { Limit: 300, AggregateKeyType: 'IP' } }, Action: { Block: {} }, VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'rate-global' } },
        managed('aws-crs', override), managed('aws-sqli', override),
      ],
    },
    LockToken: 't',
  };
}

let now = Date.parse('2026-10-14T00:00:00Z');

beforeEach(() => {
  now = Date.parse('2026-10-14T00:00:00Z');
  waf.on(GetWebACLCommand).resolves(acl() as never);
  cf.on(ListDistributionsByWebACLIdCommand).resolves({ DistributionList: { Items: [{ Id: 'E2QWRUHAPOMQZL' }] } as never });
  waf.on(GetIPSetCommand).resolves({ IPSet: { Name: 'cloudalbum-blocklist', Id: 'ipset-0000', ARN: 'a', IPAddressVersion: 'IPV4', Addresses: [] }, LockToken: 't' });
  cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });
});

afterEach(() => {
  waf.reset();
  cf.reset();
  cw.reset();
});

function detector(env: Record<string, string> = {}, creds = true) {
  const { cfg, effective } = testConfig({ ...ENABLE.iamRole, ...ENABLE.cdn, ...ENABLE.waf, ...env });
  return new WafDetector({ cfg, env: effective, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials: creds ? fakeCredentials : null }) }, { now: () => now });
}

const edge = (inspected: boolean, remoteAddr = '127.0.0.1') => ({
  headers: { 'x-cloudalbum-entry': inspected ? 'cloudfront>waf>nginx' : 'cloudfront>nginx' }, remoteAddr,
});

describe('WafDetector：被动比例', () => {
  it('只统计经入口（cloudfront> / alb>）的请求；entry 只信任回环地址；5 分钟窗口', () => {
    const d = detector();
    for (let i = 0; i < 9; i += 1) d.observe(edge(true));
    d.observe(edge(false));
    d.observe({ headers: { 'x-cloudalbum-entry': 'nginx' }, remoteAddr: '127.0.0.1' });
    d.observe({ headers: { 'x-cloudalbum-entry': 'cloudfront>waf>nginx' }, remoteAddr: '198.51.100.9' });   // 伪造：不是回环地址
    expect(d.stats()).toEqual({ requests5m: 12, viaEdge5m: 10, inspected5m: 9, notInspected5m: 1, inspectedRatio5m: 0.9, direct5m: 2 });
    expect(d.observations()).toEqual({ viaEdge5m: 10, inspected5m: 9, notInspected5m: 1, inspectedRatio5m: 0.9 });
    now += 6 * 60_000;
    expect(d.stats().requests5m).toBe(0);
  });

  it(`经入口的请求 ≥ ${MIN_EDGE_SAMPLES} 且一个都没有被 WAF 检查 → degraded（未关联）；样本不足时不判定`, async () => {
    const few = detector();
    for (let i = 0; i < MIN_EDGE_SAMPLES - 1; i += 1) few.observe(edge(false));
    expect((await few.detect({})).status).toBe('ok');
    const many = detector();
    for (let i = 0; i < MIN_EDGE_SAMPLES; i += 1) many.observe(edge(false));
    const r = await many.detect({});
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('Web ACL 未关联');
  });
});

describe('WafDetector：控制面', () => {
  it('Web ACL 存在、关联 1 个分配、托管规则组 Count = WAF_RULE_ACTION=count → ok（confirmed）；查询发往 us-east-1', async () => {
    const r = await detector().detect({});
    expect(r).toMatchObject({ status: 'ok', confidence: 'confirmed' });
    expect(r.data).toMatchObject({ scope: 'CLOUDFRONT', region: 'us-east-1', associations: ['E2QWRUHAPOMQZL'], webAcl: { managedAction: 'count' } });
    expect(await waf.call(0).thisValue.config.region()).toBe('us-east-1');
    expect(cf.commandCalls(ListDistributionsByWebACLIdCommand)[0]!.args[0].input).toEqual({ WebACLId: ENABLE.waf.WAF_WEB_ACL_ARN });
  });

  it('入口未锁定（CDN_DIRECT_ACCESS=open）不由探针判定：DEP-018 是带规则 ID 的运行期警告', async () => {
    const r = await detector({ CDN_DIRECT_ACCESS: 'open' }).detect({});
    expect(r.status).toBe('ok');
  });

  it('托管规则组为 None（block）但声明 count → degraded；声明 block 时 ok', async () => {
    waf.on(GetWebACLCommand).resolves(acl('None') as never);
    expect((await detector().detect({})).detail).toContain('与 WAF_RULE_ACTION=count 不一致');
    expect((await detector({ WAF_RULE_ACTION: 'block' }).detect({})).status).toBe('ok');
  });

  it('未关联任何分配 → error；Web ACL 不存在 → error（confirmed）；无权限 → error', async () => {
    cf.on(ListDistributionsByWebACLIdCommand).resolves({ DistributionList: { Items: [] } as never });
    const a = await detector().detect({});
    expect(a.status).toBe('error');
    expect(a.detail).toContain('没有关联任何 CloudFront 分配');
    waf.on(GetWebACLCommand).rejects(awsError('WAFNonexistentItemException', 400));
    expect(await detector().detect({})).toMatchObject({ status: 'error', confidence: 'confirmed' });
    waf.on(GetWebACLCommand).rejects(awsError('AccessDeniedException', 400));
    expect((await detector().detect({})).detail).toContain('缺少读取 Web ACL 的权限');
  });

  it('瞬时失败（超时 / 5xx）→ degraded + transient（不因为一次超时报 error，2026-10-14 的教训）', async () => {
    waf.on(GetWebACLCommand).rejects(awsError('ServiceUnavailable', 503));
    const r = await detector().detect({});
    expect(r).toMatchObject({ status: 'degraded', transient: true });
    expect(waf.commandCalls(GetWebACLCommand)).toHaveLength(2);   // withAwsRetry：2 次
  });

  it('REGIONAL：关联用 wafv2:ListResourcesForWebACL（ALB），区域取 ARN', async () => {
    waf.on(ListResourcesForWebACLCommand).resolves({ ResourceArns: ['arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/x/1'] });
    const r = await detector({ WAF_SCOPE: 'REGIONAL', WAF_WEB_ACL_ARN: 'arn:aws:wafv2:ap-northeast-1:123456789012:regional/webacl/cloudalbum-lab-acl/0000' }).detect({});
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('关联 1 个 ALB');
    expect(cf.calls()).toHaveLength(0);
  });

  it('控制面结果缓存 55 秒；deep 强制刷新', async () => {
    const d = detector();
    await d.detect({});
    await d.detect({});
    expect(waf.commandCalls(GetWebACLCommand)).toHaveLength(1);
    now += 56_000;
    await d.detect({});
    expect(waf.commandCalls(GetWebACLCommand)).toHaveLength(2);
    await d.detect({ deep: true, desired: [] });
    expect(waf.commandCalls(GetWebACLCommand)).toHaveLength(3);
  });

  it('无凭证：控制面感知不可用 → degraded（inferred），不调用 SDK', async () => {
    const r = await detector({}, false).detect({});
    expect(r).toMatchObject({ status: 'degraded', confidence: 'inferred' });
    expect(waf.calls()).toHaveLength(0);
  });

  it('WAF_LAB_ALLOW_CIDR 非空时在 detail 中提醒（不改变状态）', async () => {
    const r = await detector({ WAF_LAB_ALLOW_CIDR: '203.0.113.10/32' }).detect({});
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('实验机白名单 203.0.113.10/32 生效中');
  });

  it('summarizeRules：自定义规则取 Action，托管规则组取 OverrideAction（Count = count，None = block），混合为 mixed', () => {
    expect(summarizeRules(acl().WebACL.Rules as never).managedAction).toBe('count');
    const mixed = summarizeRules([managed('a', 'Count'), managed('b', 'None')] as never);
    expect(mixed.managedAction).toBe('mixed');
    expect(summarizeRules([]).managedAction).toBe('none');
    expect(summarizeRules(acl().WebACL.Rules as never).rules[0]).toEqual({ name: 'rate-global', priority: 3, kind: 'custom', action: 'block' });
  });
});
