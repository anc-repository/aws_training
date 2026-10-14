// waf=aws（wave1-waf）：BlocklistPort 契约（nginx 与 aws 两个驱动）+ aws 驱动细节：denylist → IP 集合的整体同步（乐观锁、
// 只同步未过期的 IPv4、Description 保留、并发合并）、无凭证时只写本地、同步失败不影响本地封禁、worker 循环与锁、探针合并、
// IP 集合与 denylist 的纯函数、源站日志按运行 ID 汇总（/api/lab/waf/origin）。
// WAFv2 / CloudFront / CloudWatch 由 aws-sdk-client-mock 拦截；IP 集合用带 LockToken 的内存替身，不发出任何网络请求。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CloudFrontClient, ListDistributionsByWebACLIdCommand } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  GetIPSetCommand, GetWebACLCommand, UpdateIPSetCommand, WAFV2Client, type GetWebACLCommandOutput,
} from '@aws-sdk/client-wafv2';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AwsBlocklist, SYNC_LOCK } from '../../../src/adapters/waf/aws.js';
import { desiredAddresses, diffAddresses, parseWebAclArn, toWafIpv4Cidr, wafRegionOf } from '../../../src/adapters/waf/ipset.js';
import { originSummary, summarizeOriginLines } from '../../../src/adapters/waf/lab-routes.js';
import { NginxBlocklist } from '../../../src/adapters/waf/nginx.js';
import { WafDetector } from '../../../src/modules/detectors/waf.js';
import { parseNginxLine } from '../../../src/observability/nginx-log.js';
import type { Lease, LockPort } from '../../../src/ports/lock.js';
import { describeBlocklistContract } from '../../contract/blocklist.contract.js';
import { ENABLE } from '../../helpers/config.js';
import { awsError, makeDeps, waitFor } from './helpers.js';

const waf = mockClient(WAFV2Client);
const cf = mockClient(CloudFrontClient);
const cw = mockClient(CloudWatchClient);

const ACL_ARN = ENABLE.waf.WAF_WEB_ACL_ARN;

/** 内存中的 IP 集合：GetIPSet 返回地址与 LockToken；UpdateIPSet 的 LockToken 过期时抛 WAFOptimisticLockException */
class FakeIpSet {
  addresses: string[] = [];
  description = 'CloudAlbum denylist (synced from security/denylist.conf)';
  token = 1;
  /** 下一次 Update 之前，模拟别的写入方先改了一次（令牌过期） */
  conflicts = 0;
  updates: Array<{ addresses: string[]; description?: string }> = [];
  install(): void {
    waf.on(GetIPSetCommand).callsFake((input: { Name: string; Scope: string; Id: string }) => {
      if (input.Id !== 'ipset-0000' || input.Name !== 'cloudalbum-blocklist' || input.Scope !== 'CLOUDFRONT') throw awsError('WAFNonexistentItemException', 400);
      return { IPSet: { Name: input.Name, Id: input.Id, ARN: 'arn', IPAddressVersion: 'IPV4', Addresses: [...this.addresses], Description: this.description }, LockToken: `t${this.token}` };
    });
    waf.on(UpdateIPSetCommand).callsFake((input: { Addresses: string[]; LockToken: string; Description?: string }) => {
      if (this.conflicts > 0) {
        this.conflicts -= 1;
        this.token += 1;
      }
      if (input.LockToken !== `t${this.token}`) throw awsError('WAFOptimisticLockException', 400);
      this.addresses = [...input.Addresses];
      this.description = input.Description ?? '';
      this.token += 1;
      this.updates.push({ addresses: [...input.Addresses], ...(input.Description ? { description: input.Description } : {}) });
      return { NextLockToken: `t${this.token}` };
    });
  }
}

const ACL: GetWebACLCommandOutput = {
  $metadata: {},
  LockToken: 'acl-token',
  WebACL: {
    Name: 'cloudalbum-lab-acl', Id: '0000', ARN: ACL_ARN, Capacity: 1157,
    DefaultAction: { Allow: { CustomRequestHandling: { InsertHeaders: [{ Name: 'cloudalbum', Value: 'inspected' }] } } },
    VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'cloudalbum-lab-acl' },
    Rules: [
      { Name: 'allow-lab', Priority: 0, Statement: { IPSetReferenceStatement: { ARN: 'a' } }, Action: { Allow: {} }, VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'allow-lab' } },
      { Name: 'block-ip-set', Priority: 1, Statement: { IPSetReferenceStatement: { ARN: 'b' } }, Action: { Block: {} }, VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'block-ip-set' } },
      { Name: 'aws-sqli', Priority: 7, Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesSQLiRuleSet' } }, OverrideAction: { Count: {} }, VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'aws-sqli' } },
    ],
  },
};

let ipset: FakeIpSet;

beforeEach(() => {
  ipset = new FakeIpSet();
  ipset.install();
  waf.on(GetWebACLCommand).resolves(ACL);
  cf.on(ListDistributionsByWebACLIdCommand).resolves({ DistributionList: { Items: [{ Id: 'E2QWRUHAPOMQZL' }] } as never });
  cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: 'blocked', Label: 'aws-sqli', Values: [3, 4] }] });
});

afterEach(() => {
  waf.reset();
  cf.reset();
  cw.reset();
});

function awsDriver(extra: Record<string, string> = {}, opts: { credentials?: boolean; role?: 'api' | 'worker'; lock?: LockPort } = {}) {
  const deps = makeDeps({ ...ENABLE.iamRole, ...ENABLE.cdn, ...ENABLE.waf, ...extra }, { credentials: opts.credentials ?? true });
  if (opts.role) deps.role = opts.role;
  if (opts.lock) deps.lock = opts.lock;
  return { deps, port: new AwsBlocklist(deps, { syncIntervalSec: 1 }) };
}

describeBlocklistContract('nginx', async () => {
  const deps = makeDeps({}, { credentials: false });
  return { port: new NginxBlocklist(deps), dataDir: deps.dataDir };
});

describeBlocklistContract('aws', async () => {
  const { deps, port } = awsDriver();
  return { port, dataDir: deps.dataDir };
});

describe('AwsBlocklist：denylist → IP 集合', () => {
  it('block：先写 denylist，再整体替换 IP 集合（单个地址写成 /32、按网络地址对齐），effective=propagating；Description 保留', async () => {
    const { port, deps } = awsDriver();
    const r = await port.block('192.0.2.1', '演示', 3600);
    expect(r).toMatchObject({ effective: 'propagating', synced: true });
    await port.block('198.51.100.77/24', '扫描器');
    expect(ipset.addresses).toEqual(['192.0.2.1/32', '198.51.100.0/24']);
    expect(ipset.updates.at(-1)?.description).toContain('CloudAlbum denylist');
    expect(readFileSync(path.join(deps.dataDir, 'security', 'denylist.conf'), 'utf8')).toContain('192.0.2.1 1;');
    // GetIPSet / UpdateIPSet 都发往 us-east-1（CLOUDFRONT 范围）
    expect(await waf.call(0).thisValue.config.region()).toBe('us-east-1');
    const u = await port.unblock('192.0.2.1');
    expect(u.synced).toBe(true);
    expect(ipset.addresses).toEqual(['198.51.100.0/24']);
  });

  it('IPv6 与已过期条目不进 IP 集合（IPv6 只在本地 Nginx 生效）；没有变化时不调用 UpdateIPSet', async () => {
    const { port, deps } = awsDriver();
    mkdirSync(path.join(deps.dataDir, 'security'), { recursive: true });
    writeFileSync(path.join(deps.dataDir, 'security', 'denylist.conf'), [
      '203.0.113.9 1;  # src=fail2ban ts=2026-10-01T00:00:00Z until=2000-01-01T00:00:00Z note="expired"',
      '203.0.113.10 1;  # src=fail2ban ts=2026-10-01T00:00:00Z until=2999-01-01T00:00:00Z note="ssh"',
      '2001:db8::1 1;  # src=admin ts=2026-10-01T00:00:00Z note="v6"',
      '',
    ].join('\n'));
    const r = await port.sync();
    expect(r).toMatchObject({ added: 1, removed: 0, total: 1, skippedIpv6: 1, unchanged: false });
    expect(ipset.addresses).toEqual(['203.0.113.10/32']);
    const again = await port.sync();
    expect(again.unchanged).toBe(true);
    expect(waf.commandCalls(UpdateIPSetCommand)).toHaveLength(1);
    // 控制台里手工加入的地址会在下一次同步时被移除（denylist 是唯一来源）
    ipset.addresses.push('100.64.0.0/10');
    expect(await port.sync()).toMatchObject({ removed: 1 });
  });

  it('WAFOptimisticLockException：重读 LockToken 后重试；并发的两次 sync 合并为一次', async () => {
    const { port } = awsDriver();
    await port.block('192.0.2.1', 'x');
    ipset.conflicts = 2;
    await port.block('192.0.2.2', 'y');
    expect(ipset.addresses).toEqual(['192.0.2.1/32', '192.0.2.2/32']);
    const before = waf.commandCalls(GetIPSetCommand).length;
    await Promise.all([port.sync(), port.sync()]);
    expect(waf.commandCalls(GetIPSetCommand).length - before).toBe(1);
  });

  it('同步失败：本地封禁照常生效，返回 effective=after-reload 与原因；状态写入 security/waf-sync.json，探针 degraded', async () => {
    const { port, deps } = awsDriver();
    waf.on(UpdateIPSetCommand).rejects(awsError('AccessDeniedException', 400, 'not authorized to perform wafv2:UpdateIPSet'));
    const r = await port.block('192.0.2.5', 'x');
    expect(r).toMatchObject({ effective: 'after-reload', synced: false });
    expect(r.detail).toContain('AccessDeniedException');
    expect((await port.list()).map((e) => e.cidr)).toEqual(['192.0.2.5']);
    const state = JSON.parse(readFileSync(path.join(deps.dataDir, 'security', 'waf-sync.json'), 'utf8')) as { ok: boolean; error: string };
    expect(state).toMatchObject({ ok: false });
    const p = await port.probe();
    expect(p.status).toBe('degraded');
    expect(p.detail).toContain('IP 集合同步落后');
  });

  it('无凭证：只写本地 denylist，effective=after-reload，“未同步到 AWS WAF”；不创建 SDK 客户端', async () => {
    const { port } = awsDriver({}, { credentials: false });
    const r = await port.block('192.0.2.1', 'x');
    expect(r).toMatchObject({ effective: 'after-reload', synced: false });
    expect(r.detail).toContain('未同步到 AWS WAF');
    expect(waf.calls()).toHaveLength(0);
    const p = await port.probe();
    expect(p).toMatchObject({ status: 'degraded', confidence: 'inferred' });
    expect(p.detail).toContain('无凭证');
  });

  it('worker：init() 启动同步循环（经 LockPort 只在一台上执行）；api 不启动', async () => {
    const leases: string[] = [];
    const lock: LockPort = {
      driver: 'file', scope: 'host',
      async tryAcquire(name: string): Promise<Lease | null> {
        leases.push(name);
        return { name, release: async () => undefined };
      },
    };
    const { port, deps } = awsDriver({}, { role: 'worker', lock });
    mkdirSync(path.join(deps.dataDir, 'security'), { recursive: true });
    writeFileSync(path.join(deps.dataDir, 'security', 'denylist.conf'), '203.0.113.20 1;  # src=fail2ban ts=2026-10-01T00:00:00Z note="http"\n');
    await port.init();
    await waitFor(() => ipset.addresses.includes('203.0.113.20/32'));
    expect(leases[0]).toBe(SYNC_LOCK);
    await port.close();
    const n = waf.commandCalls(GetIPSetCommand).length;
    const api = awsDriver({}, { role: 'api' });
    await api.port.init();
    await new Promise((r) => setTimeout(r, 50));
    expect(waf.commandCalls(GetIPSetCommand)).toHaveLength(n);
  });
});

describe('AwsBlocklist.probe：感知器 + denylist + 同步状态', () => {
  it('Web ACL 存在、已关联、托管规则组为 Count（= WAF_RULE_ACTION=count）→ ok；深度探针核对 IP 集合与 denylist、读按规则计数', async () => {
    const { port } = awsDriver();
    await port.block('192.0.2.1', 'x');
    const r = await port.probe();
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('AWS WAF（CLOUDFRONT · us-east-1）');
    expect(r.detail).toContain('关联 1 个分配');
    expect(r.data).toMatchObject({ associations: ['E2QWRUHAPOMQZL'], webAcl: { managedAction: 'count', capacity: 1157 }, desiredIpv4: 1 });
    const deep = await port.probe({ deep: true });
    expect(deep.status).toBe('ok');
    expect(deep.data).toMatchObject({ ipSet: { name: 'cloudalbum-blocklist', addresses: 1, inSyncWithDenylist: true }, ruleCounts5m: { 'aws-sqli': { blocked: 7 } } });
    // IP 集合被别人改了：深度探针 degraded
    ipset.addresses = [];
    const drift = await port.probe({ deep: true });
    expect(drift.status).toBe('degraded');
    expect(drift.detail).toContain('IP 集合与 denylist 不一致');
  });

  it('attachDetector：登记表中的感知器（收到 observe()）的被动比例进入探针', async () => {
    const { port, deps } = awsDriver();
    const det = new WafDetector({ cfg: deps.cfg, env: deps.env, aws: deps.aws });
    port.attachDetector(det);
    for (let i = 0; i < 25; i += 1) det.observe({ headers: { 'x-cloudalbum-entry': 'cloudfront>nginx' }, remoteAddr: '127.0.0.1' });
    const r = await port.probe();
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('都没有 x-amzn-waf-cloudalbum');
  });
});

describe('IP 集合的纯函数', () => {
  it('toWafIpv4Cidr / desiredAddresses / diffAddresses', () => {
    expect([toWafIpv4Cidr('192.0.2.1'), toWafIpv4Cidr('198.51.100.77/24'), toWafIpv4Cidr('10.1.2.3/8'), toWafIpv4Cidr('0.0.0.0/0'), toWafIpv4Cidr('::1'), toWafIpv4Cidr('x')])
      .toEqual(['192.0.2.1/32', '198.51.100.0/24', '10.0.0.0/8', undefined, undefined, undefined]);
    const d = desiredAddresses([{ cidr: '192.0.2.1' }, { cidr: '192.0.2.1/32' }, { cidr: '2001:db8::/32' }, { cidr: '203.0.113.1', until: '2000-01-01T00:00:00Z' }]);
    expect(d).toEqual({ addresses: ['192.0.2.1/32'], skippedIpv6: 1, invalid: 0, truncated: 0 });
    expect(diffAddresses(['192.0.2.1/32', '10.0.0.5/8'], ['192.0.2.1/32', '203.0.113.0/24'])).toEqual({ add: ['203.0.113.0/24'], remove: ['10.0.0.0/8'], same: false });
  });

  it('parseWebAclArn / wafRegionOf：global = CLOUDFRONT 范围；解析不了时按范围推断区域', () => {
    expect(parseWebAclArn(ACL_ARN)).toEqual({ arn: ACL_ARN, region: 'us-east-1', scope: 'CLOUDFRONT', name: 'cloudalbum-lab-acl', id: '0000' });
    expect(parseWebAclArn('arn:aws:wafv2:ap-northeast-1:123456789012:regional/webacl/cloudalbum-lab-acl/abcd')?.scope).toBe('REGIONAL');
    expect(parseWebAclArn('arn:aws:s3:::bucket')).toBeUndefined();
    expect([wafRegionOf('CLOUDFRONT', '', 'ap-northeast-1'), wafRegionOf('REGIONAL', undefined, 'ap-northeast-1')]).toEqual(['us-east-1', 'ap-northeast-1']);
  });
});

describe('源站日志按运行 ID 汇总（/api/lab/waf/origin 的服务端证据）', () => {
  const RUN = '01JA0000000000000000000000';
  const line = (o: Record<string, unknown>) => JSON.stringify({ ts: '2026-10-14T00:00:00Z', method: 'GET', uri: '/api/health/live', status: 200, bytes: 2, cf_id: '', alb_trace: '', path: '', args: '', port: '80', run: '', probe: '0', ...o });

  it('只统计 run 字段等于该运行的行；8080 / 带 cf_id = 经 CloudFront；nonce 按 atlprobe= 计数', () => {
    const lines = [
      line({ run: RUN, status: 429 }), line({ run: RUN, status: 200 }), line({ run: RUN, status: 403, port: '8080', cf_id: 'abc==' }),
      line({ run: 'OTHER', status: 200 }), line({ args: 'id=1&atlprobe=nonce1234', port: '8080' }),
    ].map((l) => parseNginxLine(l)!);
    const s = summarizeOriginLines(lines, RUN, 'nonce1234');
    expect(s).toMatchObject({ requests: 3, byStatus: { 200: 1, 403: 1, 429: 1 }, byPort: { 80: 2, 8080: 1 }, viaCloudfront: 1, direct: 2, nonce: { count: 1, ports: [8080] } });
  });

  it('originSummary 读取轮转前后两个文件；日志不存在时 logPresent=false', async () => {
    const { dataDir } = makeDeps({});
    mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    writeFileSync(path.join(dataDir, 'logs', 'nginx-access.json.1'), `${line({ run: RUN, status: 429 })}\n`);
    writeFileSync(path.join(dataDir, 'logs', 'nginx-access.json'), `${line({ run: RUN, status: 200 })}\n${line({ run: 'X', status: 200 })}\n`);
    expect(await originSummary(dataDir, RUN)).toMatchObject({ logPresent: true, requests: 2, byStatus: { 200: 1, 429: 1 } });
    expect(await originSummary(path.join(dataDir, 'nope'), RUN)).toMatchObject({ logPresent: false, requests: 0 });
  });
});
