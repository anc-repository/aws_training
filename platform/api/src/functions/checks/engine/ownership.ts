/**
 * Ownership by creation evidence only (04 §5.2.4, decision C6): ① stack member of this environment (stack created after
 * the boundary, carries this env's `atl:env-id`, resource not imported) → ② 02 ledger (`SessionResource`, creator session
 * name of this session / same-learner chain / runner when `session-or-start` / a role that is itself an env stack member)
 * → ③ parent resource (`aws:autoscaling:groupName`, `aws:cloudformation:stack-name`) → ④ targeted scan
 * (`atl-reaper` `OwnershipLookup`, 02 §7.12) → pending. Tags never prove ownership.
 */
import { parseRoleSessionName, StackNames, TAG_KEYS, type LambdaFunctionName } from '@atl/shared';
import { Keys, resourceKey } from '../../../data/keys.js';
import type { ItemStore } from '../../../services/progress/store.js';
import type { OwnershipOutcome, OwnershipRule, Provenance } from '../types.js';
import { sameLearnerChain, type SessionFacts } from './facts.js';
import { AwsCallError, type AwsReadPort } from './ports.js';

/** Rhythm of targeted scans (01 §3.12): 2, 2, 4, 4, 8 minutes, then every 8. */
export const LOOKUP_RHYTHM_MINUTES = [2, 2, 4, 4, 8];
export function nextLookupDelayMinutes(count: number): number {
  return LOOKUP_RHYTHM_MINUTES[Math.min(count, LOOKUP_RHYTHM_MINUTES.length - 1)] ?? 8;
}

export interface OwnershipLookupRequest {
  sessionId: string;
  resource: { type: string; id: string; arn?: string; region: string };
  createdAtHint?: string;
  scope: 'session' | 'chain';
  maxWaitMinutes?: number;
}

export type OwnershipLookupResult =
  | { status: 'FOUND'; sessionId: string; roleSessionName: string; eventId: string; eventName: string; eventTime: string; region: string }
  | { status: 'PENDING'; retryAfterSeconds: number; waitedSeconds: number }
  | { status: 'NOT_OWNED'; actor: string; eventId: string }
  | { status: 'NOT_FOUND' }
  | { status: 'THROTTLED'; retryAfterSeconds: number };

export interface OwnershipContext {
  aws: AwsReadPort;
  store: ItemStore;
  invoke: <T>(fn: LambdaFunctionName, payload: unknown) => Promise<T>;
  facts: SessionFacts;
  region: string;
  nowMs: number;
  /** Start of the step the check belongs to (for `createdAfter: step.startedAt`). */
  stepStartedAt?: string | null;
  /** Previous lookup bookkeeping (LabAttempt.ownershipLookups) — updated in place. */
  lookups: Record<string, { first: string; count: number; nextAt: string }>;
}

export type OwnershipVerdict = OwnershipOutcome & { ok: boolean; mismatch?: boolean };

const ARN_TYPES: [RegExp, string][] = [
  [/^arn:aws[a-z-]*:cloudfront::\d+:distribution\//, 'AWS::CloudFront::Distribution'],
  [/^arn:aws[a-z-]*:cloudfront::\d+:cache-policy\//, 'AWS::CloudFront::CachePolicy'],
  [/^arn:aws[a-z-]*:cloudfront::\d+:origin-access-control\//, 'AWS::CloudFront::OriginAccessControl'],
  [/^arn:aws[a-z-]*:cloudfront::\d+:response-headers-policy\//, 'AWS::CloudFront::ResponseHeadersPolicy'],
  [/^arn:aws[a-z-]*:s3:::[^/]+$/, 'AWS::S3::Bucket'],
  [/^arn:aws[a-z-]*:ec2:[^:]+:\d+:instance\//, 'AWS::EC2::Instance'],
  [/^arn:aws[a-z-]*:ec2:[^:]+:\d+:security-group\//, 'AWS::EC2::SecurityGroup'],
  [/^arn:aws[a-z-]*:ec2:[^:]+:\d+:volume\//, 'AWS::EC2::Volume'],
  [/^arn:aws[a-z-]*:ec2:[^:]+:\d+:natgateway\//, 'AWS::EC2::NatGateway'],
  [/^arn:aws[a-z-]*:ec2:[^:]+:\d+:vpc-endpoint\//, 'AWS::EC2::VPCEndpoint'],
  [/^arn:aws[a-z-]*:elasticloadbalancing:[^:]+:\d+:loadbalancer\//, 'AWS::ElasticLoadBalancingV2::LoadBalancer'],
  [/^arn:aws[a-z-]*:elasticloadbalancing:[^:]+:\d+:targetgroup\//, 'AWS::ElasticLoadBalancingV2::TargetGroup'],
  [/^arn:aws[a-z-]*:autoscaling:[^:]+:\d+:autoScalingGroup:/, 'AWS::AutoScaling::AutoScalingGroup'],
  [/^arn:aws[a-z-]*:rds:[^:]+:\d+:db:/, 'AWS::RDS::DBInstance'],
  [/^arn:aws[a-z-]*:sqs:/, 'AWS::SQS::Queue'],
  [/^arn:aws[a-z-]*:sns:/, 'AWS::SNS::Topic'],
  [/^arn:aws[a-z-]*:lambda:[^:]+:\d+:function:/, 'AWS::Lambda::Function'],
  [/^arn:aws[a-z-]*:dynamodb:[^:]+:\d+:table\//, 'AWS::DynamoDB::Table'],
  [/^arn:aws[a-z-]*:iam::\d+:role\//, 'AWS::IAM::Role'],
  [/^arn:aws[a-z-]*:kms:[^:]+:\d+:key\//, 'AWS::KMS::Key'],
  [/^arn:aws[a-z-]*:wafv2:[^:]+:\d+:/, 'AWS::WAFv2::WebACL'],
  [/^arn:aws[a-z-]*:acm:[^:]+:\d+:certificate\//, 'AWS::CertificateManager::Certificate'],
  [/^arn:aws[a-z-]*:route53:::hostedzone\//, 'AWS::Route53::HostedZone'],
  [/^arn:aws[a-z-]*:elasticache:/, 'AWS::ElastiCache::ReplicationGroup'],
  [/^arn:aws[a-z-]*:cognito-idp:/, 'AWS::Cognito::UserPool'],
  [/^arn:aws[a-z-]*:backup:/, 'AWS::Backup::BackupVault'],
];

export function resourceTypeOfArn(arn: string): string {
  return ARN_TYPES.find(([re]) => re.test(arn))?.[1] ?? 'UNKNOWN';
}

export function resourceIdOfArn(arn: string): string {
  const tail = arn.split(':').slice(5).join(':');
  const parts = tail.split(/[/:]/);
  return parts[parts.length - 1] || tail;
}

/** Region whose CloudTrail event history holds the creation event (02 §7.12 rule 2). */
export function eventRegionOf(arn: string, fallback: string): string {
  const m = /^arn:aws[a-z-]*:([^:]+):([^:]*):/.exec(arn);
  if (!m) return fallback;
  if (['cloudfront', 'iam', 'route53', 'sts'].includes(m[1]!) || /:wafv2:[^:]+:\d+:global\//.test(arn)) return 'us-east-1';
  return m[2] || 'us-east-1';
}

function boundary(rule: OwnershipRule, ctx: OwnershipContext): { thisSession: number; chainStart: number } {
  const s = ctx.facts.session;
  const startBased = rule.mode === 'session-or-start';
  const chain = sameLearnerChain(ctx.facts);
  const thisStart = rule.createdAfter === 'step.startedAt' && ctx.stepStartedAt ? Date.parse(ctx.stepStartedAt) : startBased ? Date.parse(s.createdAt) : Date.parse(s.readyAt ?? s.createdAt);
  const chainStart = chain.length ? Math.min(...chain.map((c) => Date.parse(c.createdAt))) : thisStart;
  return { thisSession: thisStart, chainStart: Math.min(chainStart, thisStart) };
}

/** Which session of this learner's chain covers time `t` (for `inherited:<sid>` provenance). */
function provenanceAt(t: number, ctx: OwnershipContext, b: { thisSession: number }): Provenance | null {
  if (t >= b.thisSession) return 'this-session';
  const chain = sameLearnerChain(ctx.facts);
  for (const c of [...chain].reverse()) if (t >= Date.parse(c.createdAt)) return `inherited:${c.sid}`;
  return null;
}

function stackNamesOf(ctx: OwnershipContext): string[] {
  const env = ctx.facts.env;
  if (!env) return [];
  const names = new Set<string>(env.stacks ?? []);
  for (const m of env.enabledModules ?? []) names.add(StackNames.module(env.envName, m));
  for (const x of ctx.facts.card.lab.extraStacks ?? []) names.add(StackNames.cardStack(env.envName, x.id));
  return [...names];
}

interface StackFacts {
  name: string;
  createdMs: number;
  envTag: string | null;
  resources: { logicalId: string; physicalId: string; type: string }[];
}

async function stackFacts(ctx: OwnershipContext, name: string, cache: Map<string, StackFacts | null>): Promise<StackFacts | null> {
  if (cache.has(name)) return cache.get(name)!;
  const session = { sid: ctx.facts.session.sid, envId: ctx.facts.session.envId ?? '' };
  try {
    const d = await ctx.aws.call({ service: 'cloudformation', action: 'DescribeStacks', params: { StackName: name }, region: ctx.region, session });
    const st = ((d.Stacks as Record<string, unknown>[] | undefined) ?? [])[0];
    if (!st) {
      cache.set(name, null);
      return null;
    }
    const resources: StackFacts['resources'] = [];
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await ctx.aws.call({ service: 'cloudformation', action: 'ListStackResources', params: { StackName: name, ...(token ? { NextToken: token } : {}) }, region: ctx.region, session });
      for (const x of (r.StackResourceSummaries as Record<string, string>[] | undefined) ?? []) resources.push({ logicalId: x.LogicalResourceId ?? '', physicalId: x.PhysicalResourceId ?? '', type: x.ResourceType ?? '' });
      token = r.NextToken as string | undefined;
      if (!token) break;
    }
    const tags = (st.Tags as { Key?: string; Value?: string }[] | undefined) ?? [];
    const f: StackFacts = { name, createdMs: Date.parse(String(st.CreationTime)), envTag: tags.find((t) => t.Key === TAG_KEYS.envId)?.Value ?? null, resources };
    cache.set(name, f);
    return f;
  } catch (e) {
    if (e instanceof AwsCallError && (e.kind === 'NOT_FOUND' || e.kind === 'INVALID')) {
      cache.set(name, null);
      return null;
    }
    throw e;
  }
}

async function wasImported(ctx: OwnershipContext, stack: string, logicalId: string): Promise<boolean> {
  const session = { sid: ctx.facts.session.sid, envId: ctx.facts.session.envId ?? '' };
  const r = await ctx.aws.call({ service: 'cloudformation', action: 'DescribeStackEvents', params: { StackName: stack }, region: ctx.region, session });
  return ((r.StackEvents as Record<string, string>[] | undefined) ?? []).some((e) => e.LogicalResourceId === logicalId && /^IMPORT_/.test(e.ResourceStatus ?? ''));
}

function matchesPhysical(phys: string, arn: string, id: string): boolean {
  return phys === arn || phys === id || (phys.startsWith('arn:') && resourceIdOfArn(phys) === id);
}

/** Session names allowed as creators (02 §7.12 rule 4, 04 §8.11). */
function allowedCreator(name: string, rule: OwnershipRule, ctx: OwnershipContext): { ok: boolean; sid?: string } {
  const p = parseRoleSessionName(name);
  if (!p) return { ok: false };
  const sids = new Set([ctx.facts.session.sid, ...sameLearnerChain(ctx.facts).map((c) => c.sid)]);
  if (!sids.has(p.sid)) return { ok: false };
  if (p.channel === 'console' || p.channel === 'term' || p.channel === 'ws') return { ok: true, sid: p.sid };
  if (p.channel === 'prov' && rule.mode === 'session-or-start') return { ok: true, sid: p.sid };
  return { ok: false };
}

export async function checkOwnership(rule: OwnershipRule & { resource: string }, ctx: OwnershipContext): Promise<OwnershipVerdict> {
  const arn = rule.resource;
  const id = rule.resourceId ?? resourceIdOfArn(arn);
  const b = boundary(rule, ctx);
  const cache = new Map<string, StackFacts | null>();
  const envId = ctx.facts.session.envId ?? '';

  // ① stack member
  for (const name of stackNamesOf(ctx)) {
    const st = await stackFacts(ctx, name, cache);
    if (!st || st.envTag !== envId) continue;
    const res = st.resources.find((r) => matchesPhysical(r.physicalId, arn, id));
    if (!res) continue;
    if (await wasImported(ctx, name, res.logicalId)) continue; // adopted resources are not created by the stack
    const prov = st.createdMs >= b.chainStart ? provenanceAt(st.createdMs, ctx, b) : null;
    if (prov) return { ok: true, basis: 'stack', pending: false, resource: arn, detail: `member of ${name}`, provenance: prov };
  }

  // ② ledger
  const region = eventRegionOf(arn, ctx.region);
  const ledger = await ctx.store.get<Record<string, unknown>>(Keys.sessionResource(envId, resourceKey(region, { arn }))).catch(() => null);
  if (ledger) {
    const creator = String(ledger.creatorSessionName ?? '');
    const when = Date.parse(String(ledger.eventTime ?? ledger.createdAt ?? ''));
    const okCreator = allowedCreator(creator, rule, ctx);
    let creatorIsStackRole = false;
    if (!okCreator.ok && /^arn:aws[a-z-]*:iam::\d+:role\//.test(String(ledger.creatorRoleArn ?? ''))) {
      const roleArn = String(ledger.creatorRoleArn);
      for (const name of stackNamesOf(ctx)) {
        const st = await stackFacts(ctx, name, cache);
        if (st && st.envTag === envId && st.resources.some((r) => matchesPhysical(r.physicalId, roleArn, resourceIdOfArn(roleArn)))) creatorIsStackRole = true;
      }
    }
    if ((okCreator.ok || creatorIsStackRole) && Number.isFinite(when) && when >= b.chainStart) {
      const prov = provenanceAt(when, ctx, b) ?? 'this-session';
      return { ok: true, basis: 'ledger', pending: false, resource: arn, detail: `ledger: ${creator || 'stack role'}`, provenance: prov };
    }
  }

  // ③ parent resource (AWS-managed tags pointing at a claimed parent)
  try {
    const t = await ctx.aws.call({ service: 'tag', action: 'GetResources', params: { ResourceARNList: [arn] }, region, session: { sid: ctx.facts.session.sid, envId } });
    const tags = (((t.ResourceTagMappingList as { Tags?: { Key?: string; Value?: string }[] }[] | undefined) ?? [])[0]?.Tags ?? []) as { Key?: string; Value?: string }[];
    const stackTag = tags.find((x) => x.Key === 'aws:cloudformation:stack-name')?.Value;
    if (stackTag && stackNamesOf(ctx).includes(stackTag)) {
      const st = await stackFacts(ctx, stackTag, cache);
      if (st && st.envTag === envId && st.createdMs >= b.chainStart) return { ok: true, basis: 'parent', pending: false, resource: arn, detail: `created by stack ${stackTag}`, provenance: provenanceAt(st.createdMs, ctx, b) ?? 'this-session' };
    }
    const asg = tags.find((x) => x.Key === 'aws:autoscaling:groupName')?.Value;
    if (asg) {
      for (const name of stackNamesOf(ctx)) {
        const st = await stackFacts(ctx, name, cache);
        if (st && st.envTag === envId && st.resources.some((r) => r.type === 'AWS::AutoScaling::AutoScalingGroup' && r.physicalId === asg)) {
          return { ok: true, basis: 'parent', pending: false, resource: arn, detail: `launched by ${asg}`, provenance: provenanceAt(st.createdMs, ctx, b) ?? 'this-session' };
        }
      }
    }
  } catch (e) {
    if (!(e instanceof AwsCallError)) throw e;
  }

  // ④ targeted scan through atl-reaper (rhythm 2,2,4,4,8 min; first pending triggers one immediately)
  const book = ctx.lookups[arn];
  if (book && Date.parse(book.nextAt) > ctx.nowMs) {
    return { ok: false, basis: null, pending: true, resource: arn, lookups: book.count, retryAfterSeconds: Math.ceil((Date.parse(book.nextAt) - ctx.nowMs) / 1000), detail: 'waiting for CloudTrail delivery' };
  }
  const req: OwnershipLookupRequest = {
    sessionId: ctx.facts.session.sid,
    resource: { type: resourceTypeOfArn(arn), id, arn, region },
    scope: sameLearnerChain(ctx.facts).length > 0 ? 'chain' : 'session',
    ...(rule.maxWaitMinutes ? { maxWaitMinutes: Math.min(45, rule.maxWaitMinutes) } : { maxWaitMinutes: 20 }),
    ...(ctx.stepStartedAt ? { createdAtHint: ctx.stepStartedAt } : {}),
  };
  let res: OwnershipLookupResult;
  try {
    res = await ctx.invoke<OwnershipLookupResult>('atl-reaper', { action: 'OwnershipLookup', ...req });
  } catch (e) {
    return { ok: false, basis: null, pending: true, resource: arn, detail: `OwnershipLookup unavailable: ${e instanceof Error ? e.message : String(e)}`, retryAfterSeconds: 120 };
  }
  const count = (book?.count ?? 0) + 1;
  const first = book?.first ?? new Date(ctx.nowMs).toISOString();
  if (res.status === 'FOUND') {
    delete ctx.lookups[arn];
    const when = Date.parse(res.eventTime);
    const creator = allowedCreator(res.roleSessionName, rule, ctx);
    if (!creator.ok || when < b.chainStart) return { ok: false, mismatch: true, basis: 'lookup', pending: false, resource: arn, lookups: count, detail: `created by ${res.roleSessionName} at ${res.eventTime}` };
    return { ok: true, basis: 'lookup', pending: false, resource: arn, lookups: count, detail: `${res.eventName} by ${res.roleSessionName}`, provenance: provenanceAt(when, ctx, b) ?? 'this-session' };
  }
  if (res.status === 'PENDING' || res.status === 'THROTTLED') {
    const delayS = res.status === 'PENDING' ? Math.max(res.retryAfterSeconds, nextLookupDelayMinutes(count - 1) * 60) : res.retryAfterSeconds;
    ctx.lookups[arn] = { first, count: res.status === 'THROTTLED' ? count - 1 : count, nextAt: new Date(ctx.nowMs + delayS * 1000).toISOString() };
    return { ok: false, basis: null, pending: true, resource: arn, lookups: count, retryAfterSeconds: delayS, detail: res.status === 'THROTTLED' ? 'CloudTrail lookups throttled' : 'waiting for CloudTrail delivery' };
  }
  delete ctx.lookups[arn];
  return { ok: false, mismatch: true, basis: 'lookup', pending: false, resource: arn, lookups: count, detail: res.status === 'NOT_OWNED' ? `created by ${res.actor}` : 'no creation record in this session' };
}
