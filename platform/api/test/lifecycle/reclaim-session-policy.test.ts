/**
 * Session policies of the production reclaimer (02 §7.6, 01 §6.7): `Action: *` only on the item's own ARNs; no
 * `aws:CalledVia` wildcard except for deleting a stack; IAM side effects (detach, remove from profile / group) narrowed
 * to the principals the item is attached to. No AWS call is made: the reads are faked.
 */
import { describe, expect, it } from 'vitest';
import type { DeleteContext, ResourceRef } from '../../src/functions/lifecycle/cloud/port.js';
import { deleteSessionPolicy, SESSION_POLICY_MAX_CHARS, sessionPolicyFor } from '../../src/functions/reaper/reclaimer/aws.js';

const ACCT = '111122223333';
const ctx = (over: Partial<DeleteContext> = {}): DeleteContext => ({ sessionId: 's0123456789ab', roleSessionName: 'atl-s0123456789ab-reap-1', attempt: 0, ownsSharedObjects: true, policyArns: [], meta: {}, ...over });
type Stmt = { Sid: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, unknown> };
const statements = (policy: string | null) => (JSON.parse(policy!) as { Statement: Stmt[] }).Statement;
const noReads = async () => {
  throw new Error('unexpected read');
};

describe('reclaim session policies (02 §7.6)', () => {
  it('Cloud Control deletes: the item ARN only — no CalledVia wildcard', async () => {
    const ref: ResourceRef = { type: 'AWS::SNS::Subscription', region: 'ap-northeast-1', id: 'sub', arn: `arn:aws:sns:ap-northeast-1:${ACCT}:t:sub-1` };
    const st = statements(await sessionPolicyFor(ref, ACCT, ctx(), noReads));
    expect(st.map((s) => s.Sid)).toEqual(['ReapItem', 'ReapControl']);
    expect(st[0]).toMatchObject({ Action: '*', Resource: [ref.arn, `${ref.arn}/*`] });
    expect(st[1]!.Action).toEqual(['cloudformation:DeleteResource', 'cloudformation:GetResource', 'cloudformation:GetResourceRequestStatus']);
    expect(JSON.stringify(st)).not.toContain('aws:CalledVia');
    // no ARN → manual list until the learner confirms
    expect(await sessionPolicyFor({ ...ref, arn: null }, ACCT, ctx(), noReads)).toBeNull();
    expect(statements(await sessionPolicyFor({ ...ref, arn: null }, ACCT, ctx({ meta: { learnerConfirmed: true } }), noReads))[0]!.Resource).toEqual(['*']);
  });

  it('stacks keep the CalledVia statement (CloudFormation deletes the stack resources for the caller)', async () => {
    const st = statements(await sessionPolicyFor({ type: 'AWS::CloudFormation::Stack', region: 'ap-northeast-1', id: 'learner-stack' }, ACCT, ctx(), noReads));
    expect(st.map((s) => s.Sid)).toEqual(['ReapItem', 'ReapViaService']);
    expect(st[1]!.Condition).toEqual({ 'ForAnyValue:StringEquals': { 'aws:CalledVia': ['cloudformation.amazonaws.com'] } });
  });

  it('a managed policy: detach only from the principals it is attached to, only this policy; never Action * on role/*', async () => {
    const arn = `arn:aws:iam::${ACCT}:policy/cloudalbum-e7k2m9qx-s3`;
    const reads = async (svc: string, cmd: string) => {
      expect([svc, cmd]).toEqual(['iam', 'ListEntitiesForPolicy']);
      return { PolicyRoles: [{ RoleName: 'cloudalbum-e7k2m9qx-fn' }, { RoleName: 'CloudAlbumAppRole' }], PolicyUsers: [{ UserName: 'cloudalbum-e7k2m9qx-demo' }], PolicyGroups: [] };
    };
    const own = statements(await sessionPolicyFor({ type: 'AWS::IAM::ManagedPolicy', region: 'us-east-1', id: arn, arn }, ACCT, ctx(), reads));
    expect(own[0]).toMatchObject({ Sid: 'ReapItem', Action: '*', Resource: [arn] });
    const roles = own.find((s) => s.Sid === 'ReapDetachRoles')!;
    expect(roles).toMatchObject({ Action: 'iam:DetachRolePolicy', Condition: { ArnEquals: { 'iam:PolicyARN': arn } } });
    expect(roles.Resource).toEqual([
      `arn:aws:iam::${ACCT}:role/cloudalbum-e7k2m9qx-fn`,
      `arn:aws:iam::${ACCT}:role/*/cloudalbum-e7k2m9qx-fn`,
      `arn:aws:iam::${ACCT}:role/CloudAlbumAppRole`,
      `arn:aws:iam::${ACCT}:role/*/CloudAlbumAppRole`,
    ]);
    expect(own.find((s) => s.Sid === 'ReapDetachUsers')).toMatchObject({ Action: 'iam:DetachUserPolicy', Resource: [`arn:aws:iam::${ACCT}:user/cloudalbum-e7k2m9qx-demo`, `arn:aws:iam::${ACCT}:user/*/cloudalbum-e7k2m9qx-demo`] });
    expect(own.find((s) => s.Sid === 'ReapDetachGroups')).toBeUndefined();
    // CloudAlbumAppRole of another environment (shared-object guard) is not in the policy
    const shared = statements(await sessionPolicyFor({ type: 'AWS::IAM::ManagedPolicy', region: 'us-east-1', id: arn, arn }, ACCT, ctx({ ownsSharedObjects: false }), reads));
    expect(JSON.stringify(shared)).not.toContain('CloudAlbumAppRole');
    for (const s of [...own, ...shared]) if (s.Sid !== 'ReapItem') expect(s.Action).not.toBe('*');
    expect(JSON.stringify(own)).not.toMatch(/:(role|user|group)\/\*"/);
  });

  it('a role, an instance profile and a user: removal statements name the profiles / roles / groups found', async () => {
    const role = statements(
      await sessionPolicyFor({ type: 'AWS::IAM::Role', region: 'us-east-1', id: 'cloudalbum-e7k2m9qx-fn' }, ACCT, ctx(), async () => ({
        InstanceProfiles: [{ InstanceProfileName: 'cloudalbum-e7k2m9qx-fn', Arn: `arn:aws:iam::${ACCT}:instance-profile/cloudalbum-e7k2m9qx-fn` }],
      })),
    );
    expect(role).toEqual([
      { Sid: 'ReapItem', Effect: 'Allow', Action: '*', Resource: [`arn:aws:iam::${ACCT}:role/cloudalbum-e7k2m9qx-fn`] },
      { Sid: 'ReapRoleProfiles', Effect: 'Allow', Action: 'iam:RemoveRoleFromInstanceProfile', Resource: [`arn:aws:iam::${ACCT}:instance-profile/cloudalbum-e7k2m9qx-fn`] },
    ]);
    const profile = statements(
      await sessionPolicyFor({ type: 'AWS::IAM::InstanceProfile', region: 'us-east-1', id: 'cloudalbum-e7k2m9qx-ip' }, ACCT, ctx(), async () => ({
        InstanceProfile: { Roles: [{ RoleName: 'cloudalbum-e7k2m9qx-ec2', Arn: `arn:aws:iam::${ACCT}:role/cloudalbum-e7k2m9qx-ec2` }] },
      })),
    );
    expect(profile[1]).toEqual({ Sid: 'ReapProfileRoles', Effect: 'Allow', Action: 'iam:RemoveRoleFromInstanceProfile', Resource: [`arn:aws:iam::${ACCT}:role/cloudalbum-e7k2m9qx-ec2`] });
    const user = statements(
      await sessionPolicyFor({ type: 'AWS::IAM::User', region: 'us-east-1', id: 'cloudalbum-e7k2m9qx-demo' }, ACCT, ctx(), async () => ({ Groups: [{ GroupName: 'g1', Arn: `arn:aws:iam::${ACCT}:group/g1` }] })),
    );
    expect(user[1]).toEqual({ Sid: 'ReapUserGroups', Effect: 'Allow', Action: 'iam:RemoveUserFromGroup', Resource: [`arn:aws:iam::${ACCT}:group/g1`] });
    // nothing attached → only the item itself
    expect(statements(await sessionPolicyFor({ type: 'AWS::IAM::User', region: 'us-east-1', id: 'u' }, ACCT, ctx(), async () => ({ Groups: [] })))).toHaveLength(1);
  });

  it('a delete that cannot stay narrow (too many principals, or above the AssumeRole policy limit) is refused', async () => {
    const arn = `arn:aws:iam::${ACCT}:policy/cloudalbum-wide`;
    await expect(sessionPolicyFor({ type: 'AWS::IAM::ManagedPolicy', region: 'us-east-1', id: arn, arn }, ACCT, ctx(), async () => ({ IsTruncated: true, PolicyRoles: [] }))).rejects.toMatchObject({ name: 'ScopeTooWide' });
    const many = Array.from({ length: 40 }, (_v, i) => ({ RoleName: `cloudalbum-e7k2m9qx-role-${i}` }));
    await expect(sessionPolicyFor({ type: 'AWS::IAM::ManagedPolicy', region: 'us-east-1', id: arn, arn }, ACCT, ctx(), async () => ({ PolicyRoles: many }))).rejects.toMatchObject({ name: 'ScopeTooWide' });
    expect(deleteSessionPolicy(['arn:aws:s3:::b', 'arn:aws:s3:::b/*']).length).toBeLessThan(SESSION_POLICY_MAX_CHARS);
  });
});
