// dns hook (wave1-route53-acm): the manual prerequisite "domain", stack parameters, automatic target, the local tier
// external, the retained hosted zone on disable. Everything runs in --dry-run (no AWS call is executed).
import { describe, expect, it } from 'vitest';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import { appScheme, autoTarget, delegationMatches, dnsHook, domainProblem } from '../src/module-hooks/dns.js';
import type { ModuleRecord } from '../src/state.js';
import { dryContext } from './helpers.js';

const deploys = (calls: Array<{ op: string; input: Record<string, unknown> }>, stack: string) =>
  calls.filter((c) => /Stack$/.test(c.op) && c.input.StackName === stack);
const paramsOf = (call: { input: Record<string, unknown> } | undefined) =>
  Object.fromEntries(((call?.input.Parameters ?? []) as Array<{ ParameterKey: string; ParameterValue?: string }>).map((p) => [p.ParameterKey, p.ParameterValue]));

describe('dns hook: no own domain', () => {
  it('enable stops with exit 2 and a clear hint before anything is deployed; plan prints it and skips (exit 0)', async () => {
    const a = dryContext();
    expect(await enableCommand(a.ctx, 'dns', {})).toBe(2);
    expect(a.out.text()).toContain('manual prerequisite "domain" is not met');
    expect(a.out.text()).toContain('scripts/module enable dns --domain album.example.com');
    expect(a.aws.calls.filter((c) => /Stack$/.test(c.op))).toEqual([]);
    expect(a.ctx.state.history.at(-1)).toMatchObject({ op: 'enable', module: 'dns', result: 'failed', exitCode: 2 });
    const b = dryContext();
    expect(await enableCommand(b.ctx, 'dns', { planOnly: true })).toBe(0);
    expect(b.out.text()).toContain('plan skipped: dns');
  });

  it('rejects names that cannot be an own domain', async () => {
    expect(domainProblem('203.0.113.10')).toContain('IP');
    expect(domainProblem('ec2-1-2-3-4.ap-northeast-1.compute.amazonaws.com')).toContain('不是你自己的域名');
    expect(domainProblem('d111.cloudfront.net')).toContain('不是你自己的域名');
    expect(domainProblem('album.example.com')).toBeUndefined();
    const { ctx } = dryContext();
    await expect(enableCommand(ctx, 'dns', { domain: '203.0.113.10' })).rejects.toThrow(/IP/);
  });

  it('planHints: the domain hint only when the target does not name the domain', () => {
    expect(dnsHook.planHints!({ module: 'dns', value: 'route53', tier: 'aws', settings: {} })[0]).toContain('需要自有域名');
    expect(dnsHook.planHints!({ module: 'dns', value: 'route53', tier: 'aws', settings: { DNS_RECORD_NAME: 'album.example.com' } })).toEqual([]);
  });
});

describe('dns hook: enable (route53)', () => {
  it('new hosted zone: stack parameters, env, NS hint; no AWS call is executed', async () => {
    const { ctx, out, aws } = dryContext();
    expect(await enableCommand(ctx, 'dns', { domain: 'Album.Example.com.' })).toBe(0);
    const p = paramsOf(deploys(aws.calls, 'cloudalbum-lab-dns')[0]);
    expect(p).toMatchObject({ DomainName: 'album.example.com', TargetType: 'eip', TargetIp: '203.0.113.10', RoutingPolicy: 'simple', AppScheme: 'http' });
    expect(p.ExistingHostedZoneId).toBeUndefined();
    const env = ctx.state.modules.dns!.env;
    expect(env).toMatchObject({ MODULE_DNS: 'on', DNS_PROVIDER: 'route53', DNS_RECORD_NAME: 'album.example.com', DNS_TARGET_TYPE: 'eip', DNS_CANONICAL_REDIRECT: 'off' });
    expect(out.text()).toContain('新建的托管区域 album.example.com 的名称服务器');
    expect(out.text()).toContain('DNS_TARGET_TYPE=eip（自动选择：只有 L0');
  });

  it('--zone-id: checked with route53:GetHostedZone (printed in dry-run) and passed as ExistingHostedZoneId', async () => {
    const { ctx, aws } = dryContext();
    expect(await enableCommand(ctx, 'dns', { domain: 'album.example.com', zoneId: 'Z0123456789ABCDEFGHIJ' })).toBe(0);
    expect(aws.calls.find((c) => c.op === 'GetHostedZone')).toMatchObject({ service: 'route53', input: { Id: 'Z0123456789ABCDEFGHIJ' } });
    expect(paramsOf(deploys(aws.calls, 'cloudalbum-lab-dns')[0]).ExistingHostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
  });

  it('failover enables the health check; prefix-list ingress looks up the Route 53 health-checker prefix list', async () => {
    const { ctx, aws } = dryContext();
    expect(await enableCommand(ctx, 'dns', { domain: 'album.example.com', param: ['RoutingPolicy=failover', 'HealthCheckIngress=prefix-list'] })).toBe(0);
    const p = paramsOf(deploys(aws.calls, 'cloudalbum-lab-dns')[0]);
    expect(p).toMatchObject({ RoutingPolicy: 'failover', EnableHealthCheck: 'true', HealthCheckIngress: 'prefix-list' });
    expect(JSON.stringify(aws.calls.find((c) => c.op === 'DescribeManagedPrefixLists')?.input)).toContain('com.amazonaws.ap-northeast-1.route53-healthchecks');
  });

  it('automatic target and https entry URL', () => {
    expect(autoTarget({}).target).toBe('eip');
    expect(autoTarget({ CDN_BASE_URL: 'https://d1.cloudfront.net' })).toMatchObject({ target: 'eip', note: expect.stringContaining('DEP-041') });
    expect(autoTarget({ CDN_BASE_URL: 'https://d1.cloudfront.net', TLS_MODE: 'acm' }).target).toBe('cloudfront');
    expect(autoTarget({ LB_MODE: 'alb' }).target).toBe('alb');
    expect(appScheme({}, 'album.example.com', 'eip')).toBe('http');
    expect(appScheme({ TLS_MODE: 'acm', TLS_ACME: 'on', TLS_DOMAIN: 'album.example.com' }, 'album.example.com', 'eip')).toBe('https');
    expect(appScheme({ TLS_MODE: 'acm', TLS_ACME: 'off', TLS_DOMAIN: 'album.example.com' }, 'album.example.com', 'eip')).toBe('http');
    expect(appScheme({ TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', CDN_BASE_URL: 'https://d1.cloudfront.net', ACM_CERT_ARN_EDGE: 'arn:aws:acm:us-east-1:1:certificate/x' },
      'album.example.com', 'cloudfront')).toBe('https');
  });

  it('delegation check compares the public NS with the hosted zone NS (case and trailing dot ignored)', () => {
    expect(delegationMatches(['NS-1.awsdns-01.org.', 'ns-2.awsdns-02.co.uk'], ['ns-1.awsdns-01.org', 'ns-2.awsdns-02.co.uk', 'ns-3.awsdns-03.com'])).toBe(true);
    expect(delegationMatches(['ns1.registrar.example'], ['ns-1.awsdns-01.org'])).toBe(false);
    expect(delegationMatches([], ['ns-1.awsdns-01.org'])).toBe(false);
  });
});

describe('dns hook: local tier external', () => {
  it('writes APP_BASE_URL and DNS_PROVIDER=external only (no stack, no MODULE_DNS)', async () => {
    const { ctx, aws } = dryContext();
    expect(await enableCommand(ctx, 'dns', { driver: 'external', domain: 'lab.example.com' })).toBe(0);
    expect(ctx.state.modules.dns).toMatchObject({ tier: 'local', env: { DNS_PROVIDER: 'external', APP_BASE_URL: 'http://lab.example.com' } });
    expect(ctx.state.modules.dns!.env.MODULE_DNS).toBeUndefined();
    expect(aws.calls.filter((c) => /Stack$/.test(c.op) && String(c.input.StackName).includes('-dns'))).toEqual([]);
  });
});

describe('dns hook: disable', () => {
  function enabled(created: boolean): ModuleRecord {
    return {
      tier: 'aws', value: 'route53', version: 1, enabledAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', secretKeys: [],
      env: { MODULE_DNS: 'on', DNS_PROVIDER: 'route53', DNS_HOSTED_ZONE_ID: 'Z0123456789ABCDEFGHIJ', DNS_RECORD_NAME: 'album.example.com', APP_BASE_URL: 'http://album.example.com' },
      outputs: { InfoHostedZoneCreated: created ? 'true' : 'false', InfoNameServers: created ? 'ns-1.awsdns-01.org' : '', InfoMaintenanceBucket: '' },
      params: {}, stacks: [{ name: 'main', stackName: 'cloudalbum-lab-dns', region: 'ap-northeast-1' }],
    } as unknown as ModuleRecord;
  }

  it('a zone created by the stack is retained and recorded (reused by the next enable); NS delegation reminder', async () => {
    const { ctx, out, aws } = dryContext();
    ctx.state.modules.dns = enabled(true);
    expect(await disableCommand(ctx, 'dns', {})).toBe(0);
    expect(ctx.state.outOfBand).toEqual([expect.objectContaining({ module: 'dns', kind: 'hosted-zone', id: 'Z0123456789ABCDEFGHIJ', detail: expect.objectContaining({ domain: 'album.example.com' }) })]);
    expect(out.text()).toContain('悬空委派');
    expect(aws.calls.find((c) => c.op === 'DeleteHostedZone')).toBeUndefined();
    // the next enable reuses it (same NS, no new delegation)
    expect(await enableCommand(ctx, 'dns', { domain: 'album.example.com' })).toBe(0);
    expect(paramsOf(deploys(aws.calls, 'cloudalbum-lab-dns').at(-1)).ExistingHostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
  });

  it('refuses while tls keeps its validation records in the zone (--param Force=true overrides)', async () => {
    const { ctx, aws } = dryContext();
    ctx.state.modules.dns = enabled(true);
    ctx.state.modules.tls = { ...enabled(false), value: 'acm', env: { MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', TLS_ACME: 'on' },
      params: { HostedZoneId: 'Z0123456789ABCDEFGHIJ' }, stacks: [{ name: 'main', stackName: 'cloudalbum-lab-tls', region: 'ap-northeast-1' }] } as unknown as ModuleRecord;
    await expect(disableCommand(ctx, 'dns', {})).rejects.toThrow(/先执行 scripts\/module disable tls/);
    expect(aws.calls.filter((c) => c.op === 'DeleteStack')).toEqual([]);
    expect(await disableCommand(ctx, 'dns', { param: ['Force=true'] })).toBe(0);
  });

  it('refuses while email (Domain identity) keeps DKIM / MAIL FROM records in the zone; Force=true prints the records to re-add (wave1-fix)', async () => {
    const { ctx, aws, out } = dryContext();
    ctx.state.modules.dns = enabled(true);
    ctx.state.modules.email = { ...enabled(false), value: 'ses', env: { EMAIL_DRIVER: 'ses' },
      params: { Domain: 'album.example.com', Email: '', HostedZoneId: 'Z0123456789ABCDEFGHIJ', MailFromDomain: 'mail.album.example.com' },
      outputs: { InfoDkimRecords: 'a1._domainkey.album.example.com CNAME a1.dkim.amazonses.com | a2._domainkey.album.example.com CNAME a2.dkim.amazonses.com' },
      stacks: [{ name: 'main', stackName: 'cloudalbum-lab-email', region: 'ap-northeast-1' }] } as unknown as ModuleRecord;
    await expect(disableCommand(ctx, 'dns', {})).rejects.toMatchObject({ code: 'DNS_IN_USE' });
    await expect(disableCommand(ctx, 'dns', {})).rejects.toThrow(/先执行 scripts\/module disable email/);
    expect(aws.calls.filter((c) => c.op === 'DeleteStack')).toEqual([]);
    expect(await disableCommand(ctx, 'dns', { param: ['Force=true'] })).toBe(0);
    expect(out.text()).toContain('a1._domainkey.album.example.com CNAME a1.dkim.amazonses.com');
    expect(out.text()).toContain('MAIL FROM mail.album.example.com');
    // an e-mail address identity has no records in the zone: no guard
    const b = dryContext();
    b.ctx.state.modules.dns = enabled(true);
    b.ctx.state.modules.email = { ...ctx.state.modules.email!, params: { Email: 'me@mail.test-only.dev', Domain: '', HostedZoneId: 'Z0123456789ABCDEFGHIJ' } } as ModuleRecord;
    expect(await disableCommand(b.ctx, 'dns', {})).toBe(0);
  });

  it('--param PurgeHostedZone=true deletes the zone; an existing zone of the learner is never recorded', async () => {
    const a = dryContext();
    a.ctx.state.modules.dns = enabled(true);
    expect(await disableCommand(a.ctx, 'dns', { param: ['PurgeHostedZone=true'] })).toBe(0);
    expect(a.aws.calls.find((c) => c.op === 'DeleteHostedZone')).toMatchObject({ input: { Id: 'Z0123456789ABCDEFGHIJ' } });
    expect(a.ctx.state.outOfBand).toEqual([]);
    const b = dryContext();
    b.ctx.state.modules.dns = enabled(false);
    expect(await disableCommand(b.ctx, 'dns', {})).toBe(0);
    expect(b.ctx.state.outOfBand).toEqual([]);
  });

  it('disable --purge reaches the hook and deletes the zone the module created (wave1-integration)', async () => {
    const a = dryContext();
    a.ctx.state.modules.dns = enabled(true);
    expect(await disableCommand(a.ctx, 'dns', { purge: true })).toBe(0);
    expect(a.aws.calls.find((c) => c.op === 'DeleteHostedZone')).toMatchObject({ input: { Id: 'Z0123456789ABCDEFGHIJ' } });
    expect(a.ctx.state.outOfBand).toEqual([]);
  });
});
