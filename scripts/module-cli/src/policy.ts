/**
 * PolicyArn attachment (modular-design.md 1.2-8, 9.1, 9.2 step 5; 02#iam): module stacks only OUTPUT a customer managed
 * policy; scripts/module attaches it to the credential principal and records the attachment in state.json:
 *   IAM_CREDENTIALS=role -> role CloudAlbumAppRole;  keys -> demo user cloudalbum-<env>-demo-keys;  none -> nothing
 *   (credentials: optional modules then run without their control-plane features, CRED-004).
 * syncAttachments() converges the principal to "PolicyArn of every enabled module"; role <-> keys switches move all of them.
 * Quota (preflight policy-quota): managed policies per role / user are limited (20 / 10 by default at the time of writing,
 * see Service Quotas). The packing mode of 9.1 is not part of this MVP: above the quota the plan stops with exit 2.
 */
import type { ModuleId } from '@cloudalbum/contracts';
import type { AwsGateway } from './aws.js';
import { isAwsError } from './aws.js';
import type { Printer } from './printer.js';
import { CliError, EXIT } from './printer.js';
import type { Attachment, CloudAlbumState } from './state.js';
import { nowIso } from './state.js';

export const ROLE_QUOTA = 20;
export const USER_QUOTA = 10;

export type Principal = Attachment['principal'];

export function principalOf(state: CloudAlbumState): Principal | undefined {
  if (!state.iam) return undefined;
  return state.iam.mode === 'keys'
    ? { type: 'user', name: state.iam.userName ?? `cloudalbum-${state.env}-demo-keys` }
    : { type: 'role', name: state.iam.roleName };
}

/** PolicyArn of every enabled AWS-tier module (iam itself has none: its base policy is referenced by the role). */
export function desiredPolicies(state: CloudAlbumState): Array<{ module: ModuleId; policyArn: string }> {
  const out: Array<{ module: ModuleId; policyArn: string }> = [];
  for (const [id, rec] of Object.entries(state.modules)) {
    const arn = rec?.tier === 'aws' ? rec.outputs.PolicyArn : undefined;
    if (arn) out.push({ module: id as ModuleId, policyArn: arn });
  }
  return out;
}

export interface AttachmentDiff { attach: Array<{ module: ModuleId; policyArn: string }>; detach: Attachment[]; principal?: Principal }

export function diffAttachments(state: CloudAlbumState): AttachmentDiff {
  const principal = principalOf(state);
  const desired = principal ? desiredPolicies(state) : [];
  const same = (a: Attachment) => principal && a.principal.type === principal.type && a.principal.name === principal.name;
  const attach = desired.filter((d) => !state.attachments.some((a) => same(a) && a.policyArn === d.policyArn));
  const detach = state.attachments.filter((a) => !same(a) || !desired.some((d) => d.policyArn === a.policyArn));
  return { attach, detach, ...(principal ? { principal } : {}) };
}

export function quotaFor(p: Principal): number {
  return p.type === 'role' ? ROLE_QUOTA : USER_QUOTA;
}

async function countAttached(aws: AwsGateway, p: Principal): Promise<number | undefined> {
  const r = await aws.send<{ AttachedPolicies?: unknown[] }>(p.type === 'role'
    ? { service: 'iam', op: 'ListAttachedRolePolicies', input: { RoleName: p.name, MaxItems: 100 } }
    : { service: 'iam', op: 'ListAttachedUserPolicies', input: { UserName: p.name, MaxItems: 100 } });
  return r?.AttachedPolicies?.length;
}

/** Converge attachments; mutates state.attachments. */
export async function syncAttachments(aws: AwsGateway, out: Printer, state: CloudAlbumState): Promise<AttachmentDiff> {
  const diff = diffAttachments(state);
  if (!diff.principal) {
    if (desiredPolicies(state).length) out.info('      IAM_CREDENTIALS=none: PolicyArn not attached (credentials: optional modules run without control-plane features, CRED-004)');
  }
  for (const a of diff.detach) {
    try {
      await aws.send(a.principal.type === 'role'
        ? { service: 'iam', op: 'DetachRolePolicy', input: { RoleName: a.principal.name, PolicyArn: a.policyArn } }
        : { service: 'iam', op: 'DetachUserPolicy', input: { UserName: a.principal.name, PolicyArn: a.policyArn } });
    } catch (e) {
      if (!isAwsError(e, 'NoSuchEntity')) throw e;
    }
    state.attachments = state.attachments.filter((x) => x !== a);
  }
  if (diff.principal && diff.attach.length) {
    const attached = await countAttached(aws, diff.principal);
    const quota = quotaFor(diff.principal);
    if (attached !== undefined && attached + diff.attach.length > quota) {
      throw new CliError(`policy-quota: ${diff.principal.name} already has ${attached} managed policies, +${diff.attach.length} exceeds ${quota}. `
        + 'Request a quota increase (Service Quotas); the packing mode of 9.1 is not implemented in this round', EXIT.rules);
    }
    for (const d of diff.attach) {
      await aws.send(diff.principal.type === 'role'
        ? { service: 'iam', op: 'AttachRolePolicy', input: { RoleName: diff.principal.name, PolicyArn: d.policyArn } }
        : { service: 'iam', op: 'AttachUserPolicy', input: { UserName: diff.principal.name, PolicyArn: d.policyArn } });
      state.attachments.push({ module: d.module, policyArn: d.policyArn, principal: diff.principal, at: nowIso() });
    }
  }
  return diff;
}
