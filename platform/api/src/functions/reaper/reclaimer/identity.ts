/**
 * The identity set of an environment for CloudTrail attribution (02 §7.3 I1–I5). Only events of these identities count
 * as creation evidence; the reaper's own sessions (`-reap-<n>`) and the read-only checks (`-verify`) are excluded.
 */
import { ATL_OPS, RoleSessionNames, parseRoleSessionName } from '@atl/shared';
import type { ResourceCreatedBy } from '@atl/shared';
import type { EnvironmentRecord, SessionRecord, SessionResourceRecord } from '../../lifecycle/store/model.js';
import type { ParsedEvent } from './extractors.js';

export interface Attribution {
  sessionId: string;
  creatorSessionName: string | null;
  createdBy: ResourceCreatedBy;
  identity: 'I1' | 'I2' | 'I3' | 'I4' | 'I5';
  securityAlert?: string;
}

export interface IdentitySet {
  names: Map<string, { sid: string; kind: 'I1' | 'I2' }>;
  instanceIds: Set<string>;
  roleArns: Set<string>;
  chain: { sid: string; from: number; to: number }[];
  window: { from: number; to: number };
  learnerRoleName: string;
}

export function identitySet(env: EnvironmentRecord, chain: SessionRecord[], ledger: SessionResourceRecord[], nowMs: number): IdentitySet {
  const names = new Map<string, { sid: string; kind: 'I1' | 'I2' }>();
  for (const s of chain) {
    for (const n of [RoleSessionNames.console(s.sid), RoleSessionNames.term(s.sid), RoleSessionNames.ws(s.sid)]) names.set(n, { sid: s.sid, kind: 'I1' });
    for (const op of ATL_OPS) names.set(RoleSessionNames.prov(s.sid, op), { sid: s.sid, kind: 'I2' });
  }
  const instanceIds = new Set<string>([
    ...(env.instances ?? []).filter((i) => i.role === 'lab-app').map((i) => i.instanceId),
    ...ledger.filter((r) => r.resourceType === 'AWS::EC2::Instance').map((r) => r.id),
  ]);
  const roleArns = new Set<string>(ledger.filter((r) => r.resourceType === 'AWS::IAM::Role' && r.arn).map((r) => r.arn!));
  const sorted = [...chain].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const spans = sorted.map((s, i) => ({
    sid: s.sid,
    from: Date.parse(s.createdAt),
    to: s.revokedAt ? Date.parse(s.revokedAt) : i + 1 < sorted.length ? Date.parse(sorted[i + 1]!.createdAt) : nowMs,
  }));
  const last = spans[spans.length - 1];
  return {
    names,
    instanceIds,
    roleArns,
    chain: spans,
    window: { from: Date.parse(env.createdAt), to: last ? last.to : nowMs },
    learnerRoleName: 'ATLLearnerRole',
  };
}

/** Session of the chain that was active at `t` (falls back to the latest one). */
function sessionAt(ids: IdentitySet, t: number): string {
  const hit = ids.chain.find((c) => t >= c.from - 10 * 60_000 && t <= c.to + 60_000);
  return (hit ?? ids.chain[ids.chain.length - 1])?.sid ?? '';
}

export function attribute(ids: IdentitySet, ev: ParsedEvent): Attribution | null {
  const t = Date.parse(ev.eventTime);
  const name = ev.sessionName;
  if (name) {
    const parsed = parseRoleSessionName(name);
    if (parsed && (parsed.channel === 'reap' || parsed.channel === 'verify')) return null; // excluded identities
    const hit = ids.names.get(name);
    if (hit) return { sessionId: hit.sid, creatorSessionName: name, createdBy: hit.kind === 'I1' ? 'learner' : 'provisioner', identity: hit.kind };
    if (ids.instanceIds.has(name)) return { sessionId: sessionAt(ids, t), creatorSessionName: name, createdBy: 'app', identity: 'I3' };
  }
  if (ev.issuerArn && ids.roleArns.has(ev.issuerArn)) return { sessionId: sessionAt(ids, t), creatorSessionName: name ?? null, createdBy: 'learner', identity: 'I4' };
  if (ev.issuerArn && ev.issuerArn.endsWith(`:role/${ids.learnerRoleName}`) && t >= ids.window.from && t <= ids.window.to) {
    const a: Attribution = { sessionId: sessionAt(ids, t), creatorSessionName: name ?? null, createdBy: 'learner', identity: 'I5' };
    if (!name || !/^atl-s[0-9a-z]{12}-(console|term|ws)$/.test(name)) a.securityAlert = `ATLLearnerRole session ${name ?? '(unknown)'} does not follow atl-<sid>-<channel>`;
    return a;
  }
  return null;
}
