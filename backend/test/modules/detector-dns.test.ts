// dns 感知器（01#dns 第 10 节）：被动 Host 统计、服务端解析与目标比较、NXDOMAIN 持续超过 TTL、瞬时失败不报 error、
// 深度探针（Route 53 控制面：托管区域、委派、记录、健康检查；aws-sdk-client-mock）
import {
  GetHealthCheckStatusCommand, GetHostedZoneCommand, ListResourceRecordSetsCommand, Route53Client,
} from '@aws-sdk/client-route-53';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import { DnsDetector, hostOfHeader, isIpLiteral, type DnsResolverLike } from '../../src/modules/detectors/dns.js';
import { ENABLE } from '../helpers/config.js';
import { awsError, fakeCredentials, testConfig } from '../adapters/aws/helpers.js';

const r53 = mockClient(Route53Client);
afterEach(() => r53.reset());

const EIP = '203.0.113.10';
const NS = ['ns-1.awsdns-01.org', 'ns-2.awsdns-02.co.uk'];

function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

function resolver(over: Partial<{ a: Record<string, Array<{ address: string; ttl: number }> | Error>; ns: string[] | Error; ptr: Record<string, string[]> }> = {}): DnsResolverLike {
  const a = over.a ?? { 'album.example.com': [{ address: EIP, ttl: 42 }] };
  return {
    async resolve4(host) {
      const v = a[host];
      if (v instanceof Error) throw v;
      if (!v) throw dnsError('ENOTFOUND');
      return v;
    },
    async resolveNs() {
      if (over.ns instanceof Error) throw over.ns;
      return over.ns ?? NS;
    },
    async reverse(ip) {
      return over.ptr?.[ip] ?? [];
    },
  };
}

function detector(env: Record<string, string>, opts: { res?: DnsResolverLike; creds?: boolean; now?: () => number; ip?: string | null; timeoutMs?: number } = {}) {
  const { cfg, effective } = testConfig(env);
  return new DnsDetector({ cfg, env: effective, aws: lazyAwsClients({ region: 'ap-northeast-1', credentials: opts.creds === false ? null : fakeCredentials }) }, {
    resolver: opts.res ?? resolver(), publicIp: async () => (opts.ip === null ? undefined : (opts.ip ?? EIP)),
    ...(opts.now ? { now: opts.now } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

describe('DnsDetector：常规探针（不需要凭证）', () => {
  it('eip：解析结果等于实例当前公网 IPv4 → ok，detail 带剩余 TTL', async () => {
    const r = await detector({ ...ENABLE.dns }, { creds: false }).detect({});
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('album.example.com → 203.0.113.10（剩余 TTL 42 秒）');
    expect(r.data).toMatchObject({ recordName: 'album.example.com', targetType: 'eip', resolution: { answers: [EIP], match: true, expected: EIP } });
  });

  it('解析到旧 IP（记录尚未传播或指向旧目标）→ degraded；取不到 IMDS 时用 DNS_TARGET_IP', async () => {
    const stale = await detector({ ...ENABLE.dns }, { ip: '198.51.100.7' }).detect({});
    expect(stale.status).toBe('degraded');
    expect(stale.detail).toContain('记录尚未传播或指向旧目标');
    const fromEnv = await detector({ ...ENABLE.dns, DNS_TARGET_IP: EIP }, { ip: null }).detect({});
    expect(fromEnv.status).toBe('ok');
    const unknown = await detector({ ...ENABLE.dns }, { ip: null }).detect({});
    expect(unknown).toMatchObject({ status: 'ok', confidence: 'inferred' });
  });

  it('NXDOMAIN：TTL 之内 degraded，持续超过 TTL（至少 60 秒）→ error；恢复后计时清零', async () => {
    let t = 1_000_000;
    const a: Record<string, Array<{ address: string; ttl: number }> | Error> = { 'album.example.com': dnsError('ENOTFOUND') };
    const d = detector({ ...ENABLE.dns }, { res: resolver({ a }), now: () => t });
    expect((await d.detect({})).status).toBe('degraded');
    t += 61_000;
    const later = await d.detect({});
    expect(later.status).toBe('error');
    expect(later.detail).toContain('超过 TTL');
    a['album.example.com'] = [{ address: EIP, ttl: 60 }];
    expect((await d.detect({})).status).toBe('ok');
  });

  it('解析器超时 / SERVFAIL 是瞬时失败：degraded + transient，不报 error（2026-10-14 的教训）', async () => {
    const slow: DnsResolverLike = { ...resolver(), resolve4: () => new Promise(() => undefined) };
    const r = await detector({ ...ENABLE.dns }, { res: slow, timeoutMs: 30 }).detect({});
    expect(r).toMatchObject({ status: 'degraded', transient: true });
    const servfail = await detector({ ...ENABLE.dns }, { res: resolver({ a: { 'album.example.com': dnsError('ESERVFAIL') } }) }).detect({});
    expect(servfail).toMatchObject({ status: 'degraded', transient: true });
  });

  it('被动统计：Host 是记录名、IP、EC2 主机名还是其他（只写 detail，不降级）', async () => {
    const d = detector({ ...ENABLE.dns });
    d.observe({ headers: { host: 'album.example.com' }, remoteAddr: '127.0.0.1' });
    d.observe({ headers: { host: '203.0.113.10:443' }, remoteAddr: '127.0.0.1' });
    d.observe({ headers: { host: 'ec2-203-0-113-10.ap-northeast-1.compute.amazonaws.com' }, remoteAddr: '127.0.0.1' });
    d.observe({ headers: { host: 'other.example.net' }, remoteAddr: '127.0.0.1' });
    expect(d.stats()).toMatchObject({ requests5m: 4, byRecord5m: 1, byIp5m: 1, byEc2Name5m: 1, other5m: 1, ipShare5m: 0.5 });
    const r = await d.detect({});
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('4 个请求中 1 个用域名、2 个用 IP 或 EC2 主机名');
    expect(d.observations()).toEqual({ requests5m: 4, ipShare5m: 0.5 });
  });

  it('cloudfront：反向解析落在 *.cloudfront.net → ok；落在别处 → degraded', async () => {
    const env = { ...ENABLE.dns, DNS_TARGET_TYPE: 'cloudfront', CDN_BASE_URL: 'https://album.example.com' };
    const edge = { 'album.example.com': [{ address: '18.65.1.2', ttl: 60 }] };
    const ok = await detector(env, { res: resolver({ a: edge, ptr: { '18.65.1.2': ['server-18-65-1-2.nrt57.r.cloudfront.net'] } }) }).detect({});
    expect(ok.status).toBe('ok');
    const wrong = await detector(env, { res: resolver({ a: { 'album.example.com': [{ address: EIP, ttl: 60 }] }, ptr: { [EIP]: ['ec2-203-0-113-10.compute.amazonaws.com'] } }) }).detect({});
    expect(wrong.status).toBe('degraded');
  });

  it('alb：与 LB_DNS_NAME 的解析结果相交 → ok', async () => {
    const env = { ...ENABLE.dns, DNS_TARGET_TYPE: 'alb', LB_DNS_NAME: 'cloudalbum-lab-alb-1.ap-northeast-1.elb.amazonaws.com' };
    const a = {
      'album.example.com': [{ address: '52.1.1.1', ttl: 60 }, { address: '52.1.1.2', ttl: 60 }],
      'cloudalbum-lab-alb-1.ap-northeast-1.elb.amazonaws.com': [{ address: '52.1.1.2', ttl: 60 }],
    };
    expect((await detector(env, { res: resolver({ a }) }).detect({})).status).toBe('ok');
  });

  it('工具函数：Host 头去端口、IP 字面量', () => {
    expect(hostOfHeader('Album.Example.com:8443')).toBe('album.example.com');
    expect(hostOfHeader('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(isIpLiteral('203.0.113.10')).toBe(true);
    expect(isIpLiteral('album.example.com')).toBe(false);
  });
});

describe('DnsDetector：深度探针（Route 53 控制面，us-east-1）', () => {
  function zone() {
    r53.on(GetHostedZoneCommand).resolves({
      HostedZone: { Id: '/hostedzone/Z0123456789ABCDEFGHIJ', Name: 'album.example.com.', CallerReference: 'x', Config: { PrivateZone: false } },
      DelegationSet: { NameServers: NS },
    });
  }

  it('托管区域、委派、记录、健康检查都正常 → ok（confirmed）', async () => {
    zone();
    r53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [{ Name: 'album.example.com.', Type: 'A', TTL: 60, ResourceRecords: [{ Value: EIP }] }], IsTruncated: false, MaxItems: 10,
    });
    r53.on(GetHealthCheckStatusCommand).resolves({ HealthCheckObservations: [{ Region: 'us-east-1', StatusReport: { Status: 'Success: HTTP Status Code 200' } }] });
    const r = await detector({ ...ENABLE.dns, DNS_HEALTH_CHECK_ID: '11111111-2222-3333-4444-555555555555' }).detect({ deep: true });
    expect(r).toMatchObject({ status: 'ok', confidence: 'confirmed' });
    expect(r.data).toMatchObject({ delegation: { ok: true }, records: [{ type: 'A', values: [EIP] }], healthCheck: { checkers: 1, failing: 0 } });
    expect(r53.commandCalls(GetHostedZoneCommand)[0]!.args[0].input.Id).toBe('Z0123456789ABCDEFGHIJ');
  });

  it('健康检查报告 Failure、委派 NS 不一致 → degraded', async () => {
    zone();
    r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [{ Name: 'album.example.com.', Type: 'A', TTL: 60, ResourceRecords: [{ Value: EIP }] }], IsTruncated: false, MaxItems: 10 });
    r53.on(GetHealthCheckStatusCommand).resolves({ HealthCheckObservations: [{ Region: 'us-east-1', StatusReport: { Status: 'Failure: Connection timed out' } }] });
    const r = await detector({ ...ENABLE.dns, DNS_HEALTH_CHECK_ID: '11111111-2222-3333-4444-555555555555' }, { res: resolver({ ns: ['ns1.registrar.example'] }) }).detect({ deep: true });
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('报告 Failure');
    expect(r.detail).toContain('NS 委派');
  });

  it('托管区域不存在 → error；限流（瞬时）→ degraded + transient；无凭证 → degraded（CRED-004）', async () => {
    r53.on(GetHostedZoneCommand).rejects(awsError('NoSuchHostedZone', 404));
    expect((await detector({ ...ENABLE.dns }).detect({ deep: true })).status).toBe('error');
    r53.reset();
    r53.on(GetHostedZoneCommand).rejects(awsError('Throttling', 400, 'Rate exceeded'));
    r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [], IsTruncated: false, MaxItems: 10 });
    expect(await detector({ ...ENABLE.dns }).detect({ deep: true })).toMatchObject({ status: 'degraded', transient: true });
    const noCreds = await detector({ ...ENABLE.dns }, { creds: false }).detect({ deep: true });
    expect(noCreds.status).toBe('degraded');
    expect(noCreds.detail).toContain('CRED-004');
  });
});
