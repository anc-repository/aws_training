/**
 * ATL_DEV_MODE implementation of the lifecycle cloud port (IAM revocation, instance discovery, SSM ping / sessions,
 * stack outputs, active builds, DLQ, notifications). Instances come from the dev environment registry the local
 * runner fills (`i-dev-<envName>-lab` / `-ws`); knobs let tests simulate stopped instances or a lost management channel.
 * Dev only: never imported by a production entry (test/lifecycle/prod-isolation.test.ts).
 */
import { StackNames, type TimerPayload } from '@atl/shared';
import type { DiscoveredInstance, LifecycleCloud, PingStatus, RevocationState } from '../functions/lifecycle/cloud/port.js';

/** The parts of the dev environment registry this cloud reads (structural: no import of src/dev). */
export interface DevEnvSource {
  get(envId: string): { envId: string; envName: string; baseUrl: string | null; instances: { lab: string; workstation: string } } | null;
  /** All dev environments (DevEnvRegistry); used to answer stack outputs with the local L0 URL. */
  list?(): { envName: string; baseUrl: string | null }[];
}

export interface DevBuildSource {
  list(): { buildId: string; runId: string; status: string }[];
}

export class DevLifecycleCloud implements LifecycleCloud {
  revocations: RevocationState = { revoked: {}, finalizing: null };
  revocationWrites = 0;
  workstationTag: string | null = null;
  readonly instanceState = new Map<string, string>();
  readonly ping = new Map<string, PingStatus>();
  readonly removed = new Set<string>();
  readonly reboots: string[] = [];
  readonly terminatedSessions: { sid: string; targets: string[] }[] = [];
  readonly notifications: { topic: string; subject: string; message: string }[] = [];
  readonly dlq: TimerPayload[] = [];
  /** a reboot brings an offline instance back Online (default) */
  rebootFixesPing = true;

  constructor(
    private readonly envs: DevEnvSource,
    private readonly builds: DevBuildSource | null = null,
  ) {}

  async getRevocations(): Promise<RevocationState> {
    return structuredClone(this.revocations);
  }

  async putRevocations(state: RevocationState): Promise<void> {
    this.revocations = structuredClone(state);
    this.revocationWrites++;
  }

  async tagWorkstationRole(sid: string): Promise<void> {
    this.workstationTag = sid;
  }

  async untagWorkstationRole(sid?: string): Promise<void> {
    if (!sid || this.workstationTag === sid) this.workstationTag = null;
  }

  async discoverInstances(q: { envId: string; envName: string; sessionIds: string[] }): Promise<DiscoveredInstance[]> {
    const rec = this.envs.get(q.envId);
    if (!rec) return [];
    const out: DiscoveredInstance[] = [];
    const lab = rec.instances.lab;
    if (!this.removed.has(lab)) out.push({ instanceId: lab, role: 'lab-app', state: this.instanceState.get(lab) ?? 'running', stackName: StackNames.base(rec.envName), privateIp: '10.0.0.10', publicIp: '203.0.113.10' });
    const ws = rec.instances.workstation;
    const owner = q.sessionIds[q.sessionIds.length - 1];
    if (owner && !this.removed.has(ws)) out.push({ instanceId: ws, role: 'workstation', state: this.instanceState.get(ws) ?? 'running', stackName: StackNames.workstation(owner), privateIp: '10.0.0.20' });
    return out;
  }

  async ssmPing(instanceIds: string[]): Promise<Record<string, PingStatus>> {
    return Object.fromEntries(instanceIds.map((id) => [id, this.instanceState.get(id) && this.instanceState.get(id) !== 'running' ? 'ConnectionLost' : (this.ping.get(id) ?? 'Online')]));
  }

  async terminateSsmSessions(q: { sid: string; targets: string[] }): Promise<{ terminated: number }> {
    this.terminatedSessions.push(q);
    return { terminated: 0 };
  }

  async rebootInstances(instanceIds: string[]): Promise<void> {
    this.reboots.push(...instanceIds);
    if (this.rebootFixesPing) for (const id of instanceIds) this.ping.set(id, 'Online');
  }

  async consoleOutput(instanceId: string): Promise<string | null> {
    return `dev console output of ${instanceId}`;
  }

  async stackOutputs(q: { stackName: string }): Promise<Record<string, string> | null> {
    const m = /^cloudalbum-(e[0-9a-z]{7})-ec2$/.exec(q.stackName);
    if (!m) return null;
    // local-l0 runner mode: the environment's CloudAlbum runs on this machine, so the app preview can open it
    const local = this.envs.list?.().find((r) => r.envName === m[1] && r.baseUrl)?.baseUrl ?? null;
    return { AppBaseUrl: local ?? `http://${m[1]}.dev.invalid` };
  }

  async listActiveBuilds(q: { envId: string; sessionIds?: string[] }): Promise<string[]> {
    const sids = q.sessionIds ?? [];
    return (this.builds?.list() ?? []).filter((b) => b.status === 'IN_PROGRESS' && (sids.length === 0 || sids.some((s) => b.runId.startsWith(`${s}-`)))).map((b) => b.buildId);
  }

  async drainTimerDlq(max: number): Promise<TimerPayload[]> {
    return this.dlq.splice(0, max);
  }

  async notify(topic: 'atl-alerts' | 'atl-notify', subject: string, message: string): Promise<void> {
    this.notifications.push({ topic, subject, message });
  }
}
