/**
 * `http-header` target resolution (04 §5.2.3 table): targets come from the AWS control plane or the session record,
 * never from learner-provided URLs. A CloudFront target must pass ownership; `tls-domain` must resolve into this
 * environment's entry set; `app-entry` is only accepted when its host equals one of the resolved hosts.
 */
import type { HttpHeaderCheck, OwnershipOutcome } from '../types.js';
import { EngineError, type RunContext } from './context.js';
import { checkOwnership } from './ownership.js';
import { AwsCallError } from './ports.js';

export interface ResolvedTarget {
  /** `https://host[:port]` (no path). */
  base: string;
  host: string;
  scheme: 'http' | 'https';
  port?: number;
  trust: 'high' | 'medium';
  ownership?: OwnershipOutcome;
  /** Built-in corroborations the target implies (tls-domain → tls-san). */
  impliedSan?: string;
  /** Pending ownership (target is known but not yet confirmed). */
  pending?: boolean;
}

async function distribution(rc: RunContext): Promise<{ id: string; domain: string; arn: string; aliases: string[] }> {
  const id = ((await rc.resolve('var.distributionId')) as string | undefined) ?? ((await rc.resolve('stack.cdn.EnvCdnDistributionId')) as string | undefined);
  if (!id || !/^E[A-Z0-9]{8,20}$/.test(id)) throw new EngineError('NOT_FOUND_VAR', 'no CloudFront distribution id (var.distributionId / stack.cdn.EnvCdnDistributionId)');
  let r: Record<string, unknown>;
  try {
    r = await rc.aws('cloudfront', 'GetDistribution', { Id: id }, 'global');
  } catch (e) {
    if (e instanceof AwsCallError && e.kind === 'NOT_FOUND') throw new EngineError('TARGET_UNRESOLVED', `distribution ${id} does not exist`);
    throw e;
  }
  const d = r.Distribution as { ARN?: string; DomainName?: string; DistributionConfig?: { Aliases?: { Items?: string[] } } } | undefined;
  if (!d?.DomainName || !d.ARN) throw new EngineError('TARGET_UNRESOLVED', `distribution ${id} has no domain`);
  return { id, domain: d.DomainName, arn: d.ARN, aliases: d.DistributionConfig?.Aliases?.Items ?? [] };
}

async function loadBalancer(rc: RunContext): Promise<{ dns: string; https: boolean } | null> {
  for (const stack of rc.facts.env?.stacks ?? []) {
    let res: Record<string, unknown>;
    try {
      res = await rc.aws('cloudformation', 'ListStackResources', { StackName: stack });
    } catch {
      continue;
    }
    const lb = ((res.StackResourceSummaries as { ResourceType?: string; PhysicalResourceId?: string }[] | undefined) ?? []).find((x) => x.ResourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    if (!lb?.PhysicalResourceId) continue;
    const d = await rc.aws('elasticloadbalancing', 'DescribeLoadBalancers', { LoadBalancerArns: [lb.PhysicalResourceId] });
    const dns = ((d.LoadBalancers as { DNSName?: string }[] | undefined) ?? [])[0]?.DNSName;
    if (!dns) continue;
    const l = await rc.aws('elasticloadbalancing', 'DescribeListeners', { LoadBalancerArn: lb.PhysicalResourceId });
    const https = ((l.Listeners as { Port?: number; Protocol?: string }[] | undefined) ?? []).some((x) => x.Protocol === 'HTTPS' || x.Port === 443);
    return { dns, https };
  }
  return null;
}

async function apiEndpoint(rc: RunContext): Promise<string | null> {
  for (const stack of rc.facts.env?.stacks ?? []) {
    let res: Record<string, unknown>;
    try {
      res = await rc.aws('cloudformation', 'ListStackResources', { StackName: stack });
    } catch {
      continue;
    }
    const api = ((res.StackResourceSummaries as { ResourceType?: string; PhysicalResourceId?: string }[] | undefined) ?? []).find((x) => x.ResourceType === 'AWS::ApiGatewayV2::Api');
    if (!api?.PhysicalResourceId) continue;
    const d = await rc.aws('apigateway', 'GetApi', { ApiId: api.PhysicalResourceId });
    if (typeof d.ApiEndpoint === 'string') return d.ApiEndpoint;
  }
  return null;
}

function directHttps(rc: RunContext): boolean {
  const e = rc.facts.env?.endpoints as { https?: { trusted?: boolean } | null; baseUrl?: string | null } | null | undefined;
  if (e?.https?.trusted) return true;
  return typeof e?.baseUrl === 'string' && e.baseUrl.startsWith('https://');
}

/** Hosts that a platform probe may reach for this environment (control plane / session record). */
async function entrySet(rc: RunContext): Promise<{ hosts: Set<string>; addresses: Set<string> }> {
  const hosts = new Set<string>();
  const addresses = new Set<string>();
  const lab = await rc.labInstance();
  if (lab.ok) {
    const i = lab.instances[0]!;
    if (i.publicIp) addresses.add(i.publicIp);
    if (i.publicIp) hosts.add(i.publicIp);
    if (i.publicDns) hosts.add(i.publicDns);
  }
  try {
    const d = await distribution(rc);
    hosts.add(d.domain);
    for (const a of d.aliases) hosts.add(a);
    for (const a of await rc.ports.http.resolve(d.domain).catch(() => [] as string[])) addresses.add(a);
  } catch {
    /* no distribution */
  }
  const lb = await loadBalancer(rc).catch(() => null);
  if (lb) {
    hosts.add(lb.dns);
    for (const a of await rc.ports.http.resolve(lb.dns).catch(() => [] as string[])) addresses.add(a);
  }
  return { hosts, addresses };
}

export async function resolveTarget(check: Pick<HttpHeaderCheck, 'target' | 'from'>, rc: RunContext): Promise<ResolvedTarget> {
  switch (check.target) {
    case 'cdn':
    case 'cdn-alias': {
      const d = await distribution(rc);
      const own = await checkOwnership(
        { resource: d.arn, resourceId: d.id, createEvents: ['CreateDistribution', 'CreateDistributionWithTags'], mode: 'session-or-start' },
        { aws: { call: (req) => rc.aws(req.service, req.action, req.params, req.region === 'us-east-1' ? 'us-east-1' : 'app') }, store: rc.store, invoke: (fn, p) => rc.deps.ports.invoker.invoke(fn, p), facts: rc.facts, region: rc.region, nowMs: rc.nowMs(), lookups: rc.lookups },
      );
      const host = check.target === 'cdn' ? d.domain : d.aliases[0];
      if (!host) throw new EngineError('TARGET_UNRESOLVED', 'the distribution has no alternate domain name');
      const ownership: OwnershipOutcome = { basis: own.basis, pending: own.pending, resource: own.resource, ...(own.provenance ? { provenance: own.provenance } : {}), ...(own.detail ? { detail: own.detail } : {}) };
      if (own.mismatch) throw Object.assign(new EngineError('OWNERSHIP_MISMATCH', `distribution ${d.id} is not from this session: ${own.detail ?? ''}`), { ownership });
      return { base: `https://${host}`, host, scheme: 'https', trust: 'high', ownership, ...(own.pending ? { pending: true } : {}) };
    }
    case 'public-ip':
    case 'public-dns': {
      const lab = await rc.labInstance();
      if (!lab.ok) throw new EngineError(lab.code === 'ACCESS_DENIED' ? 'ACCESS_DENIED' : 'TARGET_UNRESOLVED', lab.message);
      const i = lab.instances[0]!;
      if (check.target === 'public-ip') {
        if (!i.publicIp) throw new EngineError('TARGET_UNRESOLVED', 'the lab instance has no public IPv4');
        const https = directHttps(rc);
        return { base: `${https ? 'https' : 'http'}://${i.publicIp}`, host: i.publicIp, scheme: https ? 'https' : 'http', trust: 'high' };
      }
      if (!i.publicDns) throw new EngineError('TARGET_UNRESOLVED', 'the lab instance has no public DNS name');
      return { base: `http://${i.publicDns}`, host: i.publicDns, scheme: 'http', trust: 'high' };
    }
    case 'alb': {
      const lb = await loadBalancer(rc);
      if (!lb) throw new EngineError('TARGET_UNRESOLVED', 'no load balancer in this environment');
      return { base: `${lb.https ? 'https' : 'http'}://${lb.dns}`, host: lb.dns, scheme: lb.https ? 'https' : 'http', trust: 'high' };
    }
    case 'apigw': {
      const ep = await apiEndpoint(rc);
      if (!ep) throw new EngineError('TARGET_UNRESOLVED', 'no HTTP API in this environment');
      const u = new URL(ep);
      return { base: `${u.protocol}//${u.host}`, host: u.hostname, scheme: u.protocol === 'https:' ? 'https' : 'http', trust: 'high' };
    }
    case 'tls-domain': {
      const domain = ((await rc.resolve('learner.inputs.domain')) as string | undefined) || ((await rc.resolve('envfile.tls.TLS_DOMAIN')) as string | undefined);
      if (!domain || !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) throw new EngineError('NOT_FOUND_VAR', 'no domain (learner.inputs.domain / envfile.tls.TLS_DOMAIN)');
      const addrs = await rc.ports.http.resolve(domain);
      const entries = await entrySet(rc);
      if (!addrs.some((a) => entries.addresses.has(a))) throw new EngineError('TARGET_UNRESOLVED', `${domain} does not resolve to an entry of this environment`);
      return { base: `https://${domain}`, host: domain, scheme: 'https', trust: 'medium', impliedSan: domain };
    }
    case 's3-object': {
      const bucket = ((await rc.resolve('stack.storage.EnvStorageS3MediaBucket')) as string | undefined) ?? ((await rc.resolve('stack.storage.EnvStorageS3RawBucket')) as string | undefined);
      if (!bucket) throw new EngineError('TARGET_UNRESOLVED', 'no storage bucket in this environment');
      const host = `${bucket}.s3.${rc.region}.amazonaws.com`;
      return { base: `https://${host}`, host, scheme: 'https', trust: 'high' };
    }
    case 'app-entry': {
      const base = (await rc.resolve('cap.app.entry.baseUrl')) as string | undefined;
      if (!base) throw new EngineError('TARGET_UNRESOLVED', 'capabilities report no app entry');
      const u = new URL(base);
      const entries = await entrySet(rc);
      if (!entries.hosts.has(u.hostname)) throw new EngineError('TARGET_UNRESOLVED', `app entry ${u.hostname} is not a control-plane target of this environment`);
      return { base: `${u.protocol}//${u.host}`, host: u.hostname, scheme: u.protocol === 'https:' ? 'https' : 'http', ...(u.port ? { port: Number(u.port) } : {}), trust: 'medium' };
    }
    default:
      throw new EngineError('TARGET_UNRESOLVED', `target ${check.target} is only reachable from the lab instance`);
  }
}
