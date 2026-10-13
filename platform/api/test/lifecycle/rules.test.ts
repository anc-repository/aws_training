/**
 * Pure rules of the lifecycle and the reclaimer: runner failure classification (02 §4.3), budgets (§2.5, §11.1),
 * extension limits (§5.4), keep limits (§8.1), conclusions (§6.7), the revocation policy (§6.3), end phases, ARN mapping,
 * CloudTrail extraction and eligibility (7.2).
 */
import { describe, expect, it } from 'vitest';
import { ExecutionNames } from '@atl/shared';
import { endPhaseOf } from '../../src/functions/lifecycle/end.js';
import {
  buildBudget,
  buildStatusOf,
  checkExtension,
  classifyRunnerFailure,
  cleanupBudgetMinutes,
  concludeState,
  envBudget,
  initialDeadline,
  keepHoursLimit,
  remainingDeployMinutes,
} from '../../src/functions/lifecycle/rules.js';
import { configView } from '../../src/functions/lifecycle/store/platform.js';
import { failureCodeOf } from '../../src/functions/lifecycle/failures.js';
import { parseRevocationPolicy, revocationPolicy, uploadExemptResource } from '../../src/functions/lifecycle/cloud/revocation-policy.js';
import type { SessionRecord } from '../../src/functions/lifecycle/store/model.js';
import { refFromArn } from '../../src/functions/reaper/reclaimer/arn.js';
import { extractRefs, looksLikeCreation, parseTrailEvent } from '../../src/functions/reaper/reclaimer/extractors.js';
import { eligibility, lookupRegion, ruleFor } from '../../src/functions/reaper/reclaimer/rules.js';
import { cardFixture } from './support/harness.js';

const SID = 's0123456789ab';
const MIN = 60_000;
const T = Date.UTC(2026, 9, 14, 1, 0, 0);

describe('runner failure classification (02 §4.3)', () => {
  it('maps exit codes to retryability and failure codes', () => {
    expect(classifyRunnerFailure('profile-apply', { exitCode: 2 }, 'FAILED')).toMatchObject({ retryable: false, code: 'PROFILE_RULES' });
    expect(classifyRunnerFailure('profile-apply', { exitCode: 2, classification: { code: 'PROFILE_DIGEST_MISMATCH' } }, 'FAILED')).toMatchObject({ code: 'PROFILE_DIGEST_MISMATCH' });
    expect(classifyRunnerFailure('base-deploy', { exitCode: 3, error: 'We currently do not have sufficient t3.micro capacity in the AZ' }, 'FAILED')).toMatchObject({ retryable: true, code: 'CAPACITY' });
    expect(classifyRunnerFailure('base-deploy', { exitCode: 3, error: 'Rate exceeded' }, 'FAILED')).toMatchObject({ retryable: true, code: 'BASE_DEPLOY_FAILED' });
    expect(classifyRunnerFailure('profile-apply', { exitCode: 3, cfnFailures: [{ reason: 'is not authorized to perform: rds:CreateDBInstance' }] }, 'FAILED')).toMatchObject({ retryable: false, code: 'ACCESS_DENIED' });
    expect(classifyRunnerFailure('profile-apply', { exitCode: 4 }, 'FAILED')).toMatchObject({ retryable: true, code: 'PROFILE_MIGRATION_FAILED' });
    expect(classifyRunnerFailure('base-deploy', { exitCode: 5 }, 'FAILED')).toMatchObject({ code: 'BASE_BOOTSTRAP_FAILED' });
    expect(classifyRunnerFailure('profile-apply', { exitCode: 5 }, 'FAILED')).toMatchObject({ code: 'PROFILE_PROBE_FAILED' });
    expect(classifyRunnerFailure('destroy', { exitCode: 6 }, 'FAILED')).toMatchObject({ notAFailure: true, code: null });
    expect(classifyRunnerFailure('profile-apply', { exitCode: 7 }, 'FAILED')).toMatchObject({ retryable: true, code: 'ENV_LOCK_TIMEOUT' });
    expect(classifyRunnerFailure('profile-apply', { exitCode: 8 }, 'FAILED')).toMatchObject({ retryable: true, repairState: true });
  });

  it('a build without result.json is a runner timeout / queue timeout / infrastructure error', () => {
    expect(classifyRunnerFailure('base-deploy', null, 'TIMED_OUT')).toMatchObject({ retryable: true, code: 'RUNNER_TIMEOUT' });
    expect(classifyRunnerFailure('base-deploy', null, 'QUEUE_TIMEOUT')).toMatchObject({ code: 'RUNNER_QUEUE_TIMEOUT' });
    expect(classifyRunnerFailure('base-deploy', null, null)).toMatchObject({ code: 'RUNNER_ERROR' });
    expect(buildStatusOf({ Error: 'States.TaskFailed', Cause: JSON.stringify({ Build: { BuildStatus: 'TIMED_OUT' } }) })).toBe('TIMED_OUT');
    expect(buildStatusOf({ Error: 'States.Timeout' })).toBe('TIMED_OUT');
    expect(buildStatusOf({ Error: 'X', Cause: 'not json' })).toBeNull();
  });

  it('failure codes come from Atl.* errors or a CODE: prefix of the cause', () => {
    expect(failureCodeOf({ Error: 'Atl.PlatformUninstalling' })).toBe('LOCK_BUSY');
    expect(failureCodeOf({ Error: 'States.TaskFailed', Cause: 'HEALTH_FAILED: probe' })).toBe('HEALTH_FAILED');
    expect(failureCodeOf({ Error: 'Lambda.Unknown' })).toBe('WORKFLOW_ERROR');
  });
});

describe('budgets (02 §2.5, §11.1)', () => {
  it('class budgets, card overrides and the shared remaining deploy budget', () => {
    expect(envBudget(cardFixture())).toMatchObject({ deployMinutes: 30, cleanupMinutes: 45, baseBuildMinutes: 30, applyTaskSeconds: 30 * 60 + 300 });
    expect(envBudget(cardFixture({ provision: { class: 'C', budgetMinutes: null, cleanupBudgetMinutes: null } }))).toMatchObject({ deployMinutes: 90, cleanupMinutes: 120 });
    expect(cleanupBudgetMinutes(cardFixture({ provision: { class: 'A', budgetMinutes: 40, cleanupBudgetMinutes: 200 } }))).toBe(200);
    const card = cardFixture();
    expect(remainingDeployMinutes(card, new Date(T).toISOString(), T + 12 * MIN + 30_000)).toBe(17);
    expect(buildBudget(2)).toEqual({ buildMinutes: 5, taskSeconds: 5 * 60 + 300 }); // CodeBuild minimum
  });
});

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sid: SID,
    state: 'RUNNING',
    readyAt: new Date(T).toISOString(),
    deadlineAt: new Date(T + 90 * MIN).toISOString(),
    deadlineVersion: 1,
    extensions: [],
    cardSnapshot: cardFixture(),
    ...over,
  } as SessionRecord;
}

describe('extensions (02 §5.4) and keep (§8.1)', () => {
  const cfg = configView({}, 'ap-northeast-1');
  it('whole-minute deadlines and the per-extension / count / cumulative / MaxSessionMinutes limits', () => {
    expect(initialDeadline(T + 10_500, 90)).toBe(T + 91 * MIN);
    expect(checkExtension(session(), cfg, { minutes: 30, expectedDeadlineVersion: 1 }, T + MIN)).toMatchObject({ ok: true, newDeadlineMs: T + 120 * MIN });
    expect(checkExtension(session(), cfg, { minutes: 45, expectedDeadlineVersion: 1 }, T + MIN)).toMatchObject({ ok: false, error: 'Atl.ExtensionLimit' });
    expect(checkExtension(session(), cfg, { minutes: 30, expectedDeadlineVersion: 2 }, T + MIN)).toMatchObject({ ok: false, error: 'Atl.PreconditionFailed' });
    const used = [
      { at: '', minutes: 30, quoteId: 'a', actor: 'user' },
      { at: '', minutes: 30, quoteId: 'b', actor: 'user' },
    ];
    expect(checkExtension(session({ extensions: used, deadlineVersion: 3 }), cfg, { minutes: 10, expectedDeadlineVersion: 3 }, T + MIN)).toMatchObject({ ok: false, error: 'Atl.ExtensionLimit' });
    expect(checkExtension(session(), cfg, { minutes: 30, expectedDeadlineVersion: 1 }, T + 90 * MIN - 10_000)).toMatchObject({ ok: false, error: 'Atl.SessionExpiringOrEnded' });
    expect(checkExtension(session({ state: 'KEPT' }), cfg, { minutes: 30, expectedDeadlineVersion: 1 }, T + MIN)).toMatchObject({ ok: false, error: 'Atl.SessionExpiringOrEnded' });
    const tight = configView({ limits: { maxSessionMinutes: 100 } }, 'ap-northeast-1');
    expect(checkExtension(session(), tight, { minutes: 30, expectedDeadlineVersion: 1 }, T + MIN)).toMatchObject({ ok: false, error: 'Atl.ExtensionLimit' });
    const uninstalling = configView({ mode: 'UNINSTALLING' }, 'ap-northeast-1');
    expect(checkExtension(session(), uninstalling, { minutes: 30, expectedDeadlineVersion: 1 }, T + MIN)).toMatchObject({ ok: false, error: 'Atl.PlatformUninstalling' });
    const card = cardFixture({ extensions: { maxCount: 5, minutesEach: 60 } }); // a card never loosens the platform limits
    expect(checkExtension(session({ cardSnapshot: card }), cfg, { minutes: 60, expectedDeadlineVersion: 1 }, T + MIN)).toMatchObject({ ok: false, error: 'Atl.ExtensionLimit' });
  });

  it('keep hours = min(MaxKeepHours, hard limit, card retain.maxHours)', () => {
    const cfg2 = configView({ limits: { maxKeepHours: 48 } }, 'ap-northeast-1');
    expect(keepHoursLimit(cardFixture({ retain: { allowed: true, maxHours: 12 } }), cfg2)).toBe(12);
    expect(keepHoursLimit(cardFixture({ retain: { allowed: true, maxHours: null as unknown as number } }), cfg2)).toBe(48);
  });

  it('conclusion: BLOCKING → CLEANUP_FAILED, else the terminal state of the end reason', () => {
    expect(concludeState('USER_ENDED', { blocking: 1 })).toBe('CLEANUP_FAILED');
    expect(concludeState('USER_ENDED', { blocking: 0 })).toBe('ENDED');
    expect(concludeState('PROVISION_FAILED', { blocking: 0 })).toBe('FAILED');
  });
});

describe('end phases and execution names', () => {
  it('first / release / retry-k map to endSeq 1 / 2 / 2+k', () => {
    expect(endPhaseOf(ExecutionNames.endFirst(SID), SID)).toEqual({ phase: 'first', seq: 1, k: 0 });
    expect(endPhaseOf(ExecutionNames.endRelease(SID), SID)).toEqual({ phase: 'release', seq: 2, k: 0 });
    expect(endPhaseOf(ExecutionNames.endRetry(SID, 3), SID)).toEqual({ phase: 'retry', seq: 5, k: 3 });
  });
});

describe('ATLRevokedSessions (02 §6.3)', () => {
  it('round-trips revoked sessions and the finalizing exemption', () => {
    const exempt = uploadExemptResource({ region: 'ap-northeast-1', accountId: '000000000000', agentApiEndpoint: 'https://abc123.execute-api.ap-northeast-1.amazonaws.com', sid: SID });
    expect(exempt).toBe(`arn:aws:execute-api:ap-northeast-1:000000000000:abc123/$default/PUT/api/v1/agent/sessions/${SID}/experiment-runs/*/result`);
    const other = 's0000000000zz';
    const doc = revocationPolicy({ revoked: { [other]: new Date(T).toISOString() }, finalizing: { sid: SID, since: new Date(T).toISOString(), exemptResource: exempt } });
    expect(doc?.Statement).toHaveLength(2);
    expect(JSON.stringify(doc)).toContain(`*:atl-${other}-*`);
    const back = parseRevocationPolicy(doc, { [other]: new Date(T).toISOString() });
    expect(Object.keys(back.revoked)).toEqual([other]);
    expect(back.finalizing).toMatchObject({ sid: SID, exemptResource: exempt });
    expect(revocationPolicy({ revoked: {}, finalizing: null })).toBeNull();
  });
});

describe('reclaimer helpers (7.1–7.3)', () => {
  it('maps Tagging API ARNs to (type, id)', () => {
    expect(refFromArn('arn:aws:ec2:ap-northeast-1:000000000000:instance/i-0abc', 'x')).toEqual({ type: 'AWS::EC2::Instance', id: 'i-0abc', region: 'ap-northeast-1' });
    expect(refFromArn('arn:aws:s3:::my-bucket', 'ap-northeast-1')).toEqual({ type: 'AWS::S3::Bucket', id: 'my-bucket', region: 'ap-northeast-1' });
    expect(refFromArn('arn:aws:rds:ap-northeast-1:000000000000:db:cloudalbum-db', 'x')).toMatchObject({ type: 'AWS::RDS::DBInstance', id: 'cloudalbum-db' });
    expect(refFromArn('arn:aws:iam::000000000000:role/path/MyRole', 'x')).toEqual({ type: 'AWS::IAM::Role', id: 'MyRole', region: 'us-east-1' });
    expect(refFromArn('arn:aws:lambda:ap-northeast-1:000000000000:function:fn:1', 'x')).toMatchObject({ type: 'AWS::Lambda::Function', id: 'fn' });
    expect(refFromArn('not-an-arn', 'x')).toBeNull();
  });

  it('extracts created resources from CloudTrail events and attributes them to the session', () => {
    const ev = parseTrailEvent({
      eventId: 'e1',
      eventName: 'RunInstances',
      eventTime: new Date(T).toISOString(),
      eventSource: 'ec2.amazonaws.com',
      region: 'ap-northeast-1',
      readOnly: false,
      resources: [],
      cloudTrailEvent: JSON.stringify({
        eventID: 'e1',
        eventName: 'RunInstances',
        eventSource: 'ec2.amazonaws.com',
        awsRegion: 'ap-northeast-1',
        userIdentity: { arn: `arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-${SID}-console` },
        responseElements: { instancesSet: { items: [{ instanceId: 'i-0aaa' }, { instanceId: 'i-0bbb' }] } },
      }),
    });
    expect(ev.sessionName).toBe(`atl-${SID}-console`);
    expect(looksLikeCreation('RunInstances')).toBe(true);
    expect(looksLikeCreation('DescribeInstances')).toBe(false);
    expect((extractRefs(ev) ?? []).map((r) => `${r.type}:${r.id}`)).toEqual(expect.arrayContaining(['AWS::EC2::Instance:i-0aaa', 'AWS::EC2::Instance:i-0bbb']));
  });

  it('eligibility keeps platform, AWS-managed and kept prerequisite resources; deletes the rest', () => {
    const f = { name: null, arn: null, stackName: null, chain: [SID], keepPrerequisites: [] as string[] };
    expect(eligibility({ ...f, type: 'AWS::S3::Bucket', id: 'cloudalbum-x-toolchain' })).toEqual({ delete: true });
    expect(eligibility({ ...f, type: 'AWS::S3::Bucket', id: 'atl-data-000000000000' })).toMatchObject({ delete: false, state: 'RETAINED' });
    expect(eligibility({ ...f, type: 'AWS::CloudFormation::Stack', id: `atl-ws-${SID}` })).toEqual({ delete: true }); // the session's workstation stack
    expect(eligibility({ ...f, type: 'AWS::IAM::Role', id: 'CloudAlbumAppRole' })).toMatchObject({ delete: false });
    expect(eligibility({ ...f, type: 'AWS::KMS::Alias', id: 'alias/aws/s3' })).toMatchObject({ delete: false });
    expect(eligibility({ ...f, type: 'AWS::Route53::HostedZone', id: 'Z1', keepPrerequisites: ['route53-hosted-zone'] })).toMatchObject({ delete: false, reason: expect.stringContaining('kept prerequisite') });
    expect(eligibility({ ...f, type: 'AWS::EC2::Instance', id: 'i-1', tags: { 'atl:component': 'platform' } })).toMatchObject({ delete: false });
    expect(lookupRegion('AWS::IAM::Role', 'ap-northeast-1')).toBe('us-east-1');
    expect(ruleFor('AWS::RDS::DBInstance').billing).toBe('hourly');
  });
});
