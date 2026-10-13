/**
 * Target instance discovery (04 §5.2.1, 01 §9.8): never cached across runs. Lab instances: `atl:env-id=<envId>` +
 * `atl:role=lab-app`, running, `aws:cloudformation:stack-name` belongs to this environment, SSM `PingStatus=Online`; in
 * ASG mode only `InService` instances. Workstation: `atl:session-id=<sid>` + `atl:role=workstation`.
 */
import { CFN_STACK_NAME_TAG, TAG_KEYS } from '@atl/shared';
import type { AwsReadPort } from './ports.js';

export interface DiscoveredInstance {
  instanceId: string;
  publicIp: string | null;
  publicDns: string | null;
  privateIp: string | null;
  az: string | null;
  sgId: string | null;
  asg: string | null;
  online: boolean;
}

export type DiscoveryResult =
  | { ok: true; instances: DiscoveredInstance[] }
  | { ok: false; code: 'CHANNEL_DOWN' | 'TARGET_AMBIGUOUS' | 'TARGET_UNRESOLVED' | 'ACCESS_DENIED'; message: string; instances: DiscoveredInstance[] };

interface Ec2Instance {
  InstanceId?: string;
  PublicIpAddress?: string;
  PublicDnsName?: string;
  PrivateIpAddress?: string;
  Placement?: { AvailabilityZone?: string };
  SecurityGroups?: { GroupId?: string }[];
  Tags?: { Key?: string; Value?: string }[];
}

function tag(i: Ec2Instance, k: string): string | null {
  return i.Tags?.find((t) => t.Key === k)?.Value ?? null;
}

export async function discoverInstances(
  aws: AwsReadPort,
  q: { role: 'lab-app' | 'workstation'; sid: string; envId: string; envName: string; region: string; limit?: number },
): Promise<DiscoveryResult> {
  const session = { sid: q.sid, envId: q.envId };
  const filters =
    q.role === 'lab-app'
      ? [
          { Name: `tag:${TAG_KEYS.envId}`, Values: [q.envId] },
          { Name: `tag:${TAG_KEYS.role}`, Values: ['lab-app'] },
          { Name: 'instance-state-name', Values: ['running'] },
        ]
      : [
          { Name: `tag:${TAG_KEYS.sessionId}`, Values: [q.sid] },
          { Name: `tag:${TAG_KEYS.role}`, Values: ['workstation'] },
          { Name: 'instance-state-name', Values: ['running'] },
        ];
  const r = await aws.call({ service: 'ec2', action: 'DescribeInstances', params: { Filters: filters, MaxResults: 50 }, region: q.region, session });
  let found: Ec2Instance[] = ((r.Reservations as { Instances?: Ec2Instance[] }[] | undefined) ?? []).flatMap((x) => x.Instances ?? []);
  if (q.role === 'lab-app') {
    const prefix = `cloudalbum-${q.envName}-`;
    found = found.filter((i) => (tag(i, CFN_STACK_NAME_TAG) ?? '').startsWith(prefix));
  }
  if (found.length === 0) return { ok: false, code: q.role === 'lab-app' ? 'CHANNEL_DOWN' : 'TARGET_UNRESOLVED', message: `no running ${q.role} instance of this environment`, instances: [] };

  // ASG mode: only the ASG's InService instances; stopped / leftover L0 instances are ignored (cards batch 1 B-16)
  const asgMembers = found.filter((i) => tag(i, 'aws:autoscaling:groupName'));
  if (q.role === 'lab-app' && asgMembers.length > 0) {
    const ids = asgMembers.map((i) => i.InstanceId!).slice(0, 50);
    const a = await aws.call({ service: 'autoscaling', action: 'DescribeAutoScalingInstances', params: { InstanceIds: ids }, region: q.region, session });
    const inService = new Set(
      ((a.AutoScalingInstances as { InstanceId?: string; LifecycleState?: string }[] | undefined) ?? []).filter((x) => x.LifecycleState === 'InService').map((x) => x.InstanceId),
    );
    found = asgMembers.filter((i) => inService.has(i.InstanceId));
  }

  const ids = found.map((i) => i.InstanceId!).filter(Boolean);
  const info = await aws.call({
    service: 'ssm',
    action: 'DescribeInstanceInformation',
    params: { Filters: [{ Key: 'InstanceIds', Values: ids }] },
    region: q.region,
    session,
  });
  const online = new Set(
    ((info.InstanceInformationList as { InstanceId?: string; PingStatus?: string }[] | undefined) ?? []).filter((x) => x.PingStatus === 'Online').map((x) => x.InstanceId),
  );
  const instances: DiscoveredInstance[] = found
    .map((i) => ({
      instanceId: i.InstanceId!,
      publicIp: i.PublicIpAddress ?? null,
      publicDns: i.PublicDnsName || null,
      privateIp: i.PrivateIpAddress ?? null,
      az: i.Placement?.AvailabilityZone ?? null,
      sgId: i.SecurityGroups?.[0]?.GroupId ?? null,
      asg: tag(i, 'aws:autoscaling:groupName'),
      online: online.has(i.InstanceId),
    }))
    .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  const usable = instances.filter((i) => i.online);
  if (usable.length === 0) return { ok: false, code: 'CHANNEL_DOWN', message: 'instance is not an online SSM managed node (PingStatus ≠ Online)', instances };
  return { ok: true, instances: usable.slice(0, q.limit ?? 4) };
}

/** `instances: one` — single-instance: exactly one; ASG: the first InService one; more than expected → TARGET_AMBIGUOUS. */
export function pickOne(r: DiscoveryResult): DiscoveryResult {
  if (!r.ok) return r;
  const asg = r.instances.filter((i) => i.asg);
  if (asg.length > 0) return { ok: true, instances: [asg[0]!] };
  if (r.instances.length > 1) return { ok: false, code: 'TARGET_AMBIGUOUS', message: `${r.instances.length} instances carry atl:role=lab-app; temporary instances must not use this tag`, instances: r.instances };
  return r;
}
