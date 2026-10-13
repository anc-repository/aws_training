/**
 * UninstallGuard and UninstallRoleCleanup (01 §4.8, 02 §10.5).
 *
 * UninstallGuard (Custom::UninstallGuard, DependsOn every key resource → deleted first):
 *   - Create / Update: only records the keep-lists (which inline / managed policies of ATLLearnerRole, ATLWorkstationRole
 *     and CloudAlbumAppRole belong to the stack) in `PlatformConfig.uninstallGuard`.
 *   - Delete: sets `PlatformConfig.mode = UNINSTALLING` (maintenance), then
 *       fast path — nothing to reclaim (no non-terminal session, no session in the rescan window, no unreleased environment,
 *       no ATLRevokedSessions on ATLLearnerRole): role cleanup right away and answer CloudFormation;
 *       otherwise — start `atl-platform-uninstall` (execution `uninstall-<n>`, n = `PlatformConfig.uninstallSeq`) with
 *       `{ trigger: 'guard', cfn: {responseUrl, requestId, stackId, logicalResourceId, physicalResourceId}, keep, deadlineAt }`
 *       and return without answering: the state machine answers through UninstallRoleCleanup within 3600 s.
 *
 * UninstallRoleCleanup (`{ action, cfn, outcome: SUCCESS | FAILED, reason }`, invoked by atl-platform-uninstall):
 *   - FAILED: answer FAILED with the reason, touch nothing;
 *   - SUCCESS: require mode UNINSTALLING and no non-terminal session, then delete inline policies and detach managed
 *     policies that do not belong to the stack, remove the tag atl:active-session-id from ATLWorkstationRole, answer
 *     SUCCESS; any failure → answer FAILED naming the role and policy. Idempotent (a retried deletion repeats it safely).
 */
import { Keys, NON_TERMINAL_STATES, TAG_KEYS } from '@atl/shared';
import type { CfnCallback, CfnEvent, CfnResult } from '../cfn.js';
import { callbackOf, defaultPhysicalId, isCallback, prop, sendCfnResponse } from '../cfn.js';
import type { Item, Ports } from '../ports.js';

export const CLEANUP_ROLES = ['ATLLearnerRole', 'ATLWorkstationRole', 'CloudAlbumAppRole'] as const;
export type CleanupRole = (typeof CLEANUP_ROLES)[number];
export interface KeepList {
  Inline: string[];
  Managed: string[];
}
export type KeepPolicies = Partial<Record<CleanupRole, KeepList>>;

export const UNINSTALL_STATE_MACHINE = 'atl-platform-uninstall';
/** The guard answers before CloudFormation's 3600 s limit; the state machine gets this deadline (02 §10.5). */
export const GUARD_DEADLINE_SECONDS = 3300;
const ENV_STATES = ['PROVISIONING', 'ACTIVE', 'KEPT', 'RELEASING', 'RELEASE_FAILED'] as const;

function asKeep(v: unknown): KeepPolicies {
  const out: KeepPolicies = {};
  if (!v || typeof v !== 'object') return out;
  for (const role of CLEANUP_ROLES) {
    const k = (v as Record<string, unknown>)[role] as Record<string, unknown> | undefined;
    if (!k) continue;
    const list = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
    out[role] = { Inline: list(k.Inline), Managed: list(k.Managed) };
  }
  return out;
}

async function openSessions(ports: Ports, table: string, partitions: readonly string[]): Promise<number> {
  let n = 0;
  for (const p of partitions) n += (await ports.table.queryIndex(table, 'GSI2', p, 1)).length;
  return n;
}

/** Is there anything for atl-platform-uninstall to do? */
export async function nothingToReclaim(ports: Ports, table: string): Promise<boolean> {
  const sessions = await openSessions(ports, table, [...NON_TERMINAL_STATES.map((s) => `STATE#${s}`), 'FOLLOWUP#PENDING']);
  if (sessions) return false;
  const envs = await openSessions(ports, table, ENV_STATES.map((s) => `ENVSTATE#${s}`));
  if (envs) return false;
  const inline = await ports.iam.listRolePolicies('ATLLearnerRole');
  return !inline.includes('ATLRevokedSessions');
}

/** Delete / detach everything that does not belong to the stack; returns the actions taken. */
export async function cleanupRoles(ports: Ports, keep: KeepPolicies): Promise<string[]> {
  const done: string[] = [];
  for (const role of CLEANUP_ROLES) {
    const k = keep[role] ?? { Inline: [], Managed: [] };
    for (const name of await ports.iam.listRolePolicies(role)) {
      if (k.Inline.includes(name)) continue;
      try {
        await ports.iam.deleteRolePolicy(role, name);
      } catch (e) {
        throw new Error(`could not delete inline policy ${name} of ${role}: ${e instanceof Error ? e.message : String(e)}`);
      }
      done.push(`deleted ${role}/${name}`);
    }
    for (const arn of await ports.iam.listAttachedRolePolicies(role)) {
      if (k.Managed.includes(arn)) continue;
      try {
        await ports.iam.detachRolePolicy(role, arn);
      } catch (e) {
        throw new Error(`could not detach ${arn} from ${role}: ${e instanceof Error ? e.message : String(e)}`);
      }
      done.push(`detached ${role}/${arn}`);
    }
  }
  const tags = await ports.iam.listRoleTags('ATLWorkstationRole');
  if (tags.some((t) => t.key === TAG_KEYS.activeSessionId)) {
    await ports.iam.untagRole('ATLWorkstationRole', [TAG_KEYS.activeSessionId]);
    done.push(`untagged ATLWorkstationRole/${TAG_KEYS.activeSessionId}`);
  }
  return done;
}

export async function uninstallGuard(event: CfnEvent, ports: Ports): Promise<CfnResult> {
  const id = defaultPhysicalId(event);
  const table = prop(event, 'Table');
  const keep = asKeep(event.ResourceProperties.KeepPolicies);
  const key = Keys.platformConfig();
  if (event.RequestType !== 'Delete') {
    await ports.table.update(table, key, { uninstallGuard: { keep, registeredAt: ports.now().toISOString() } });
    return { physicalResourceId: id };
  }
  const cb = callbackOf(event, id);
  const now = ports.now();
  await ports.table.update(table, key, {
    mode: 'UNINSTALLING',
    maintenance: true,
    uninstallGuard: { keep, registeredAt: now.toISOString() },
    uninstall: { requestedBy: 'guard', requestedAt: now.toISOString(), cfn: cb },
  });
  if (await nothingToReclaim(ports, table)) {
    const actions = await cleanupRoles(ports, keep);
    ports.log('uninstall fast path: nothing to reclaim', { actions });
    return { physicalResourceId: id, data: { Path: 'fast' } };
  }
  const seq = await ports.table.increment(table, key, 'uninstallSeq');
  const arn = prop(event, 'UninstallStateMachineArn');
  const input = {
    trigger: 'guard',
    cfn: cb,
    keep,
    deadlineAt: new Date(now.getTime() + GUARD_DEADLINE_SECONDS * 1000).toISOString(),
  };
  const r = await ports.workflow.startExecution(arn, `uninstall-${seq}`, input);
  ports.log('uninstall started by the guard', { executionArn: r.executionArn, alreadyExists: r.alreadyExists });
  return { physicalResourceId: id, noResponse: true };
}

export interface RoleCleanupInput {
  action: 'UninstallRoleCleanup';
  cfn: CfnCallback;
  outcome: 'SUCCESS' | 'FAILED';
  reason?: string;
  keep?: KeepPolicies;
}

export async function uninstallRoleCleanup(payload: Record<string, unknown>, ports: Ports, table: string): Promise<{ status: 'SUCCESS' | 'FAILED'; reason: string; actions: string[] }> {
  const cb = payload.cfn;
  if (!isCallback(cb)) throw new Error('UninstallRoleCleanup: cfn {responseUrl, requestId, stackId, logicalResourceId, physicalResourceId} is required');
  const outcome = payload.outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
  let status: 'SUCCESS' | 'FAILED' = 'FAILED';
  let reason = typeof payload.reason === 'string' && payload.reason ? payload.reason : 'uninstall preparation did not finish';
  let actions: string[] = [];
  if (outcome === 'SUCCESS') {
    try {
      const config = (await ports.table.get(table, Keys.platformConfig())) as Item | undefined;
      if (config?.mode !== 'UNINSTALLING') throw new Error('PlatformConfig.mode is not UNINSTALLING');
      const open = await openSessions(ports, table, NON_TERMINAL_STATES.map((s) => `STATE#${s}`));
      if (open) throw new Error(`${open} session(s) are not finished yet`);
      const keep = payload.keep ? asKeep(payload.keep) : asKeep((config.uninstallGuard as Item | undefined)?.keep);
      actions = await cleanupRoles(ports, keep);
      status = 'SUCCESS';
      reason = 'all sessions reclaimed; run-time role policies removed';
    } catch (e) {
      status = 'FAILED';
      reason = `role cleanup failed: ${e instanceof Error ? e.message : String(e)}. Resolve it on the platform's uninstall page and retry the stack deletion; do not retain resources (01 §4.8).`;
    }
  }
  await sendCfnResponse(cb, status, reason, { Path: 'state-machine' }, ports.fetch);
  ports.log('UninstallRoleCleanup answered CloudFormation', { status, actions });
  return { status, reason, actions };
}
