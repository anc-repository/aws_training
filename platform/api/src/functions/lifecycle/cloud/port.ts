/**
 * Lifecycle-specific ports: the AWS operations of atl-lifecycle, atl-timer and atl-reaper that the shared ports of
 * `@atl/shared` do not cover (IAM revocation, instance discovery, SSM sessions, stack outputs, reclaim handlers).
 * Production: `cloud/aws.ts` (wired by the Lambda entries). ATL_DEV_MODE: `src/orchestrator-dev/` (wired by the dev
 * runtime). The lifecycle logic only sees these interfaces.
 */
import type { TimerPayload } from '@atl/shared';

// ---------------------------------------------------------------------------------------------------------------
// atl-lifecycle / atl-timer

/**
 * `ATLRevokedSessions` (02 §6.3): fully revoked sessions (statement `AtlRevokedSessions`) and the one session still
 * finalizing (statement `AtlFinalizingSession`: deny everything except the result-upload route of that session).
 */
export interface RevocationState {
  /** sid → revoked since (ISO) */
  revoked: Record<string, string>;
  /** single active environment → at most one session finalizes at a time */
  finalizing: { sid: string; since: string; exemptResource: string } | null;
}

export type InstanceRole = 'lab-app' | 'workstation';

export interface DiscoveredInstance {
  instanceId: string;
  role: InstanceRole;
  /** EC2 state name (pending, running, stopping, stopped, shutting-down, terminated) */
  state: string;
  /** `aws:cloudformation:stack-name` (01 §9.8) */
  stackName: string | null;
  asgName?: string | null;
  /** ASG lifecycle state (InService …) when the instance belongs to an ASG */
  lifecycleState?: string | null;
  publicIp?: string | null;
  privateIp?: string | null;
}

export type PingStatus = 'Online' | 'ConnectionLost' | 'Inactive' | 'Unknown';

export interface LifecycleCloud {
  getRevocations(): Promise<RevocationState>;
  /** Writes the inline policy `ATLRevokedSessions` on ATLLearnerRole (or deletes it when both lists are empty). */
  putRevocations(state: RevocationState): Promise<void>;
  /** `atl:active-session-id` on ATLWorkstationRole (01 §6.2). */
  tagWorkstationRole(sid: string): Promise<void>;
  /** Removes the tag (only when it still names `sid`, if given). */
  untagWorkstationRole(sid?: string): Promise<void>;
  /** Instances by `atl:env-id` + `atl:role`, checked against the environment's stacks (01 §9.8; not cached). */
  discoverInstances(q: { envId: string; envName: string; sessionIds: string[] }): Promise<DiscoveredInstance[]>;
  /** SSM PingStatus per instance id (DescribeInstanceInformation). */
  ssmPing(instanceIds: string[]): Promise<Record<string, PingStatus>>;
  /** Terminates active Session Manager sessions of `atl-<sid>-*` on the given targets (02 §6.3 step 4). */
  terminateSsmSessions(q: { sid: string; targets: string[] }): Promise<{ terminated: number }>;
  rebootInstances(instanceIds: string[]): Promise<void>;
  consoleOutput(instanceId: string): Promise<string | null>;
  /** Outputs of a stack (`null` when it does not exist). */
  stackOutputs(q: { stackName: string; region?: string }): Promise<Record<string, string> | null>;
  /** Runner builds still in progress for the environment (CodeBuild ListBuildsForProject + BatchGetBuilds). */
  listActiveBuilds(q: { envId: string; sessionIds?: string[] }): Promise<string[]>;
  /** Messages of `atl-timer-dlq` (deleted once read). */
  drainTimerDlq(max: number): Promise<TimerPayload[]>;
  /** SNS `atl-alerts` / `atl-notify`; never contains credentials (02 §7.10). */
  notify(topic: 'atl-alerts' | 'atl-notify', subject: string, message: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------
// atl-reaper (02 §7.6)

export type Stage = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

export interface ResourceRef {
  /** CloudFormation type name, e.g. `AWS::RDS::DBInstance` (pseudo types `ATL::*` for S6 resets) */
  type: string;
  region: string;
  /** physical id (or name) */
  id: string;
  arn?: string | null;
}

export type StepResult =
  | { status: 'DONE' }
  | { status: 'PENDING'; waitSeconds: number }
  | { status: 'RETRY'; waitSeconds: number; reason: string }
  | { status: 'MANUAL'; reason: string; severity: 'BLOCKING' | 'REVIEW' | 'INFO' };

export interface DeleteContext {
  sessionId: string;
  /** `atl-<sid>-reap-<n>` (01 §6.3) */
  roleSessionName: string;
  attempt: number;
  /** true when this environment holds ActiveEnvironmentLock or the lock is free (7.5 S6 shared-object guard) */
  ownsSharedObjects: boolean;
  /** policy ARNs that this environment attached to CloudAlbumAppRole (from the ledger) */
  policyArns: string[];
  /** extra data of the ledger item (e.g. backups, default versions) */
  meta: Record<string, unknown>;
}

export interface StackSummary {
  name: string;
  region: string;
  status: string;
  tags: Record<string, string>;
}

export interface StackResource {
  logicalId: string;
  physicalId: string;
  type: string;
  status: string;
}

export interface ReclaimCloud {
  /** Stacks of the environment: `cloudalbum-<envName>-*`, `atl-ws-<sid>` of the chain, and stacks tagged `atl:env-id`. */
  listEnvStacks(q: { envId: string; envName: string; sessionIds: string[]; regions: string[] }): Promise<StackSummary[]>;
  listStackResources(q: { stackName: string; region: string }): Promise<StackResource[]>;
  /** Resource Groups Tagging API + IAM roles + ASGs by tag (7.1 blind spots). */
  taggedResources(q: { region: string; key: string; value: string }): Promise<{ arn: string; type: string | null }[]>;
  /** High-cost resources currently in the region (7.1 INVENTORY, 3.5). */
  inventory(q: { region: string }): Promise<{ type: string; id: string; arn?: string | null }[]>;
  exists(ref: ResourceRef): Promise<boolean>;
  delete(ref: ResourceRef, ctx: DeleteContext): Promise<StepResult>;
  poll(ref: ResourceRef, ctx: DeleteContext): Promise<StepResult>;
  manualHint(ref: ResourceRef): { consoleUrl: string; cli: string; note?: string };
}

export interface PlatformClouds {
  lifecycle: LifecycleCloud;
  reclaim: ReclaimCloud;
}
