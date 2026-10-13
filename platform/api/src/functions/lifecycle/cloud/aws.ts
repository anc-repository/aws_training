/**
 * Production implementation of the lifecycle cloud port (IAM revocation policy, workstation role tag, instance discovery,
 * SSM, CloudFormation outputs, runner builds, timer DLQ, SNS). Wired by `functions/<fn>/index.ts` through
 * `setProductionClouds(awsClouds)`; never used in tests or ATL_DEV_MODE (no AWS credentials there).
 */
import { CFN_STACK_NAME_TAG, TAG_KEYS, type TimerPayload } from '@atl/shared';
import type { PlatformEnv } from '../../../runtime/env.js';
import type { DiscoveredInstance, InstanceRole, LifecycleCloud, PingStatus, PlatformClouds, RevocationState } from './port.js';
import { parseRevocationPolicy, revocationPolicy, type PolicyDocument } from './revocation-policy.js';
import { call, errName, isNotFound, paginate } from './sdk.js';
import { AwsReclaimCloud } from '../../reaper/reclaimer/aws.js';

const LEARNER_ROLE = 'ATLLearnerRole';
const REVOKED_POLICY = 'ATLRevokedSessions';
const WORKSTATION_ROLE = 'ATLWorkstationRole';

type Tag = { Key?: string; Value?: string };
const tagMap = (tags: Tag[] | undefined): Record<string, string> => Object.fromEntries((tags ?? []).filter((t) => t.Key).map((t) => [t.Key!, t.Value ?? '']));

export class AwsLifecycleCloud implements LifecycleCloud {
  constructor(private readonly env: PlatformEnv) {}

  private get region() {
    return this.env.region;
  }

  async getRevocations(): Promise<RevocationState> {
    try {
      const out = await call('iam', this.region, 'GetRolePolicy', { RoleName: LEARNER_ROLE, PolicyName: REVOKED_POLICY });
      const doc = JSON.parse(decodeURIComponent(String(out.PolicyDocument ?? '{}'))) as PolicyDocument;
      return parseRevocationPolicy(doc);
    } catch (e) {
      if (errName(e) === 'NoSuchEntityException' || isNotFound(e)) return { revoked: {}, finalizing: null };
      throw e;
    }
  }

  async putRevocations(state: RevocationState): Promise<void> {
    const doc = revocationPolicy(state);
    if (!doc) {
      await call('iam', this.region, 'DeleteRolePolicy', { RoleName: LEARNER_ROLE, PolicyName: REVOKED_POLICY }).catch((e: unknown) => {
        if (errName(e) !== 'NoSuchEntityException') throw e;
      });
      return;
    }
    await call('iam', this.region, 'PutRolePolicy', { RoleName: LEARNER_ROLE, PolicyName: REVOKED_POLICY, PolicyDocument: JSON.stringify(doc) });
  }

  async tagWorkstationRole(sid: string): Promise<void> {
    await call('iam', this.region, 'TagRole', { RoleName: WORKSTATION_ROLE, Tags: [{ Key: TAG_KEYS.activeSessionId, Value: sid }] });
  }

  async untagWorkstationRole(sid?: string): Promise<void> {
    if (sid) {
      const out = await call('iam', this.region, 'ListRoleTags', { RoleName: WORKSTATION_ROLE });
      if (tagMap(out.Tags as Tag[])[TAG_KEYS.activeSessionId] !== sid) return;
    }
    await call('iam', this.region, 'UntagRole', { RoleName: WORKSTATION_ROLE, TagKeys: [TAG_KEYS.activeSessionId] });
  }

  async discoverInstances(q: { envId: string; envName: string; sessionIds: string[] }): Promise<DiscoveredInstance[]> {
    const found: DiscoveredInstance[] = [];
    const ownStack = (name: string | null) => !!name && (name.startsWith(`cloudalbum-${q.envName}-`) || q.sessionIds.some((sid) => name === `atl-ws-${sid}`));
    for await (const page of paginate('ec2', this.region, 'DescribeInstances', {
      Filters: [
        { Name: `tag:${TAG_KEYS.envId}`, Values: [q.envId] },
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
      ],
    })) {
      for (const r of (page.Reservations ?? []) as { Instances?: Record<string, unknown>[] }[]) {
        for (const i of r.Instances ?? []) {
          const tags = tagMap(i.Tags as Tag[]);
          const role = tags[TAG_KEYS.role];
          const stackName = tags[CFN_STACK_NAME_TAG] ?? null;
          if ((role !== 'lab-app' && role !== 'workstation') || !ownStack(stackName)) continue;
          found.push({
            instanceId: String(i.InstanceId),
            role: role as InstanceRole,
            state: String((i.State as { Name?: string } | undefined)?.Name ?? 'unknown'),
            stackName,
            asgName: tags['aws:autoscaling:groupName'] ?? null,
            publicIp: (i.PublicIpAddress as string | undefined) ?? null,
            privateIp: (i.PrivateIpAddress as string | undefined) ?? null,
          });
        }
      }
    }
    const inAsg = found.filter((i) => i.asgName).map((i) => i.instanceId);
    if (inAsg.length) {
      const out = await call('autoscaling', this.region, 'DescribeAutoScalingInstances', { InstanceIds: inAsg });
      const states = new Map(((out.AutoScalingInstances ?? []) as { InstanceId: string; LifecycleState: string }[]).map((a) => [a.InstanceId, a.LifecycleState]));
      for (const i of found) if (i.asgName) i.lifecycleState = states.get(i.instanceId) ?? null;
    }
    return found;
  }

  async ssmPing(instanceIds: string[]): Promise<Record<string, PingStatus>> {
    const result: Record<string, PingStatus> = Object.fromEntries(instanceIds.map((id) => [id, 'Unknown' as PingStatus]));
    if (!instanceIds.length) return result;
    for await (const page of paginate('ssm', this.region, 'DescribeInstanceInformation', { Filters: [{ Key: 'InstanceIds', Values: instanceIds }] })) {
      for (const info of (page.InstanceInformationList ?? []) as { InstanceId: string; PingStatus: string }[]) {
        result[info.InstanceId] = (['Online', 'ConnectionLost', 'Inactive'].includes(info.PingStatus) ? info.PingStatus : 'Unknown') as PingStatus;
      }
    }
    return result;
  }

  async terminateSsmSessions(q: { sid: string; targets: string[] }): Promise<{ terminated: number }> {
    let terminated = 0;
    for (const target of q.targets) {
      for await (const page of paginate('ssm', this.region, 'DescribeSessions', { State: 'Active', Filters: [{ key: 'Target', value: target }] })) {
        for (const s of (page.Sessions ?? []) as { SessionId: string; Owner?: string }[]) {
          if (!(s.Owner ?? '').includes(`/atl-${q.sid}-`)) continue;
          await call('ssm', this.region, 'TerminateSession', { SessionId: s.SessionId });
          terminated++;
        }
      }
    }
    return { terminated };
  }

  async rebootInstances(instanceIds: string[]): Promise<void> {
    if (instanceIds.length) await call('ec2', this.region, 'RebootInstances', { InstanceIds: instanceIds });
  }

  async consoleOutput(instanceId: string): Promise<string | null> {
    const out = await call('ec2', this.region, 'GetConsoleOutput', { InstanceId: instanceId, Latest: true });
    return out.Output ? Buffer.from(String(out.Output), 'base64').toString('utf8') : null;
  }

  async stackOutputs(q: { stackName: string; region?: string }): Promise<Record<string, string> | null> {
    try {
      const out = await call('cloudformation', q.region ?? this.region, 'DescribeStacks', { StackName: q.stackName });
      const st = (out.Stacks as { Outputs?: { OutputKey?: string; OutputValue?: string }[]; StackStatus?: string }[] | undefined)?.[0];
      if (!st || st.StackStatus === 'DELETE_COMPLETE') return null;
      return Object.fromEntries((st.Outputs ?? []).filter((o) => o.OutputKey).map((o) => [o.OutputKey!, o.OutputValue ?? '']));
    } catch (e) {
      if (/does not exist/i.test(String((e as Error)?.message))) return null;
      throw e;
    }
  }

  async listActiveBuilds(q: { envId: string; sessionIds?: string[] }): Promise<string[]> {
    const ids: string[] = [];
    // newest first; runner builds of one environment are recent, two pages (200 builds) are plenty
    for await (const page of paginate('codebuild', this.region, 'ListBuildsForProject', { projectName: this.env.runnerProject, sortOrder: 'DESCENDING' }, { tokenIn: 'nextToken', tokenOut: 'nextToken', maxPages: 2 })) {
      ids.push(...((page.ids ?? []) as string[]));
    }
    const active: string[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const out = await call('codebuild', this.region, 'BatchGetBuilds', { ids: ids.slice(i, i + 100) });
      for (const b of (out.builds ?? []) as { id: string; buildStatus?: string; environment?: { environmentVariables?: { name: string; value: string }[] } }[]) {
        if (b.buildStatus !== 'IN_PROGRESS') continue;
        const vars = Object.fromEntries((b.environment?.environmentVariables ?? []).map((v) => [v.name, v.value]));
        if (vars.ATL_ENV_ID === q.envId || (q.sessionIds ?? []).includes(vars.ATL_SESSION_ID ?? '')) active.push(b.id);
      }
    }
    return active;
  }

  private queueUrl(): string | null {
    const m = /^arn:aws[a-z-]*:sqs:([a-z0-9-]+):(\d{12}):(.+)$/.exec(this.env.timerDlqArn ?? '');
    return m ? `https://sqs.${m[1]}.amazonaws.com/${m[2]}/${m[3]}` : null;
  }

  async drainTimerDlq(max: number): Promise<TimerPayload[]> {
    const url = this.queueUrl();
    if (!url) return [];
    const out: TimerPayload[] = [];
    while (out.length < max) {
      const r = await call('sqs', this.region, 'ReceiveMessage', { QueueUrl: url, MaxNumberOfMessages: Math.min(10, max - out.length), WaitTimeSeconds: 0 });
      const msgs = (r.Messages ?? []) as { Body?: string; ReceiptHandle: string }[];
      if (!msgs.length) break;
      for (const m of msgs) {
        try {
          const body = JSON.parse(m.Body ?? 'null') as TimerPayload | null;
          if (body && typeof body === 'object' && 'kind' in body) out.push(body);
        } catch {
          // not a timer payload: dropped (the sweeper's reconciliation covers lost timers)
        }
        await call('sqs', this.region, 'DeleteMessage', { QueueUrl: url, ReceiptHandle: m.ReceiptHandle });
      }
    }
    return out;
  }

  async notify(topic: 'atl-alerts' | 'atl-notify', subject: string, message: string): Promise<void> {
    await call('sns', this.region, 'Publish', {
      TopicArn: `arn:aws:sns:${this.region}:${this.env.accountId}:${topic}`,
      Subject: subject.replace(/[^\x20-\x7e]/g, ' ').slice(0, 100),
      Message: message,
    });
  }
}

/** The production factory registered by the Lambda entries: `setProductionClouds(awsClouds)`. */
export function awsClouds(env: PlatformEnv): PlatformClouds {
  return { lifecycle: new AwsLifecycleCloud(env), reclaim: new AwsReclaimCloud(env) };
}
