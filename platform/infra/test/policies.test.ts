/**
 * Generated IAM policies (01 §6.4–§6.8, §6.10): size budgets, presence of the key Deny statements, and the guardrail cases
 * of 07 V5-2 evaluated offline with test/support/iam-eval.ts against the rendered policies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compilePolicies,
  GENERATED_DIR,
  generatedFiles,
  MANAGED_POLICY_MAX_CHARS,
  POLICY_SPECS,
  renderPolicy,
  SCENARIOS,
  sizeReport,
  sizeViolations,
} from '../build/gen-policies.js';
import { ADMINISTRATOR_ACCESS, evaluate, matchingSids, POWER_USER_ACCESS, type PolicyDoc, type RequestContext } from './support/iam-eval.js';

const ACCT = '111122223333';
const REGION = 'ap-northeast-1';
const DR = 'ap-northeast-3';
const compiled = compilePolicies();
const render = (name: string, scenario = SCENARIOS[0]!) => renderPolicy(compiled[name], scenario) as unknown as PolicyDoc;
const sids = (doc: PolicyDoc) => (Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement]).map((s) => s.Sid);
const statement = (doc: PolicyDoc, sid: string) => (Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement]).find((s) => s.Sid === sid)!;

const learner = { identity: [POWER_USER_ACCESS, render('ATLLearnerGuardrails'), render('ATLLearnerCostGuards'), render('ATLLearnerIam'), render('ATLAgentApi')], boundary: render('ATLLearnerBoundary') };
const workload = { identity: [ADMINISTRATOR_ACCESS], boundary: render('ATLWorkloadBoundary') };
const provisioner = { identity: [render('ATLProvisionerPolicy-Core'), render('ATLProvisionerPolicy-Guards')], boundary: render('ATLProvisionerBoundary') };
const verifier = { identity: [render('ATLVerifierReadOnly'), render('ATLVerifierRunCheck')] };

function req(action: string, resource: string, keys: RequestContext['keys'] = {}, region = REGION): RequestContext {
  return { action, resource, keys: { 'aws:RequestedRegion': region, ...keys } };
}
const asLearner = (r: RequestContext) => evaluate(r, learner.identity, learner.boundary);
const asWorkload = (r: RequestContext) => evaluate(r, workload.identity, workload.boundary);
const asProvisioner = (r: RequestContext) => evaluate(r, provisioner.identity, provisioner.boundary);
const asVerifier = (r: RequestContext) => evaluate(r, verifier.identity);

const STATE_BUCKET = `cloudalbum-lab-state-${ACCT}-${REGION}`;
const LOCKS = `arn:aws:dynamodb:${REGION}:${ACCT}:table/cloudalbum-lab-locks`;
const INSTANCE = `arn:aws:ec2:${REGION}:${ACCT}:instance/i-0123456789abcdef0`;
const API = `arn:aws:execute-api:${REGION}:${ACCT}:a1b2c3d4e5`;

describe('policy generation', () => {
  it('committed policies/generated/ equals a fresh generation (CI: regenerate == repository, 01 §6.10)', () => {
    for (const [name, body] of Object.entries(generatedFiles())) {
      const file = path.join(GENERATED_DIR, name);
      expect(fs.existsSync(file), `${name} missing: npm run policies -w @atl/infra`).toBe(true);
      expect(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `${name} is stale: npm run policies -w @atl/infra`).toBe(body);
    }
  });

  it('every managed policy stays within 6,144 characters and inline policies within the role budget, in every scenario', () => {
    const reports = sizeReport(compiled);
    expect(sizeViolations(reports)).toEqual([]);
    for (const r of reports) for (const m of r.managed) expect(m.size).toBeLessThanOrEqual(MANAGED_POLICY_MAX_CHARS);
  });

  it('the boundaries keep room for a few more instance types than the default list', () => {
    const extra = ['t3.micro', 't3.small', 't3.medium', 't4g.micro', 't4g.small', 't4g.medium', 't3a.micro', 't3a.small', 't3a.medium'];
    for (const name of ['ATLLearnerBoundary', 'ATLWorkloadBoundary', 'ATLProvisionerBoundary']) {
      const doc = renderPolicy(compiled[name], SCENARIOS[0], { AllowedInstanceTypes: extra });
      expect(JSON.stringify(doc).replace(/\s+/g, '').length, name).toBeLessThanOrEqual(MANAGED_POLICY_MAX_CHARS);
    }
  });

  it('ATLRevokedSessions (02 §6.3) with a dozen entries plus the finalizing exemption fits the reserved inline budget', () => {
    const sid = (i: number) => `s${String(i).padStart(12, '0').replace(/[ilou]/g, 'x')}`;
    const revoked = {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'AtlRevokedSessions', Effect: 'Deny', Action: '*', Resource: '*', Condition: { StringLike: { 'aws:userid': Array.from({ length: 12 }, (_v, i) => `*:atl-${sid(i)}-*`) } } },
        {
          Sid: 'AtlFinalizingSession',
          Effect: 'Deny',
          Action: '*',
          NotResource: `${API}/$default/PUT/api/v1/agent/sessions/s4k7m2q9x1abc/experiment-runs/*/result`,
          Condition: { StringLike: { 'aws:userid': '*:atl-s4k7m2q9x1abc-*' } },
        },
        { Sid: 'AtlEmergencyRevokeAll', Effect: 'Deny', Action: '*', Resource: '*', Condition: { DateLessThan: { 'aws:TokenIssueTime': '2026-10-14T00:00:00Z' } } },
      ],
    };
    const report = sizeReport(compiled)[0]!.inline.find((i) => i.role === 'ATLLearnerRole')!;
    expect(JSON.stringify(revoked).length).toBeLessThanOrEqual(report.reserve);
    expect(report.size + report.reserve).toBeLessThanOrEqual(report.limit);
  });

  it('IAM policy variables are rendered as ${aws:…} without Fn::Sub', () => {
    const runCheck = JSON.stringify(compiled.ATLVerifierRunCheck);
    expect(runCheck).toContain('${aws:PrincipalTag/atl:env-id}');
    expect(runCheck).toContain('${aws:PrincipalTag/atl:session-id}');
  });

  it('every policy spec has a source', () => {
    for (const s of POLICY_SPECS) expect(compiled[s.name], s.name).toBeTruthy();
  });
});

describe('key Deny statements are present', () => {
  it('learner boundary (01 §6.5)', () => {
    const b = render('ATLLearnerBoundary');
    expect(sids(b)).toEqual(
      expect.arrayContaining([
        'AllowLabServices', 'DenyOtherRegions', 'UsEast1EdgeOnly', 'DrRegionLimited', 'DenyPlatformByName', 'DenyPlatformByTag',
        'ProtectComponentTag', 'DenyIamUsersAndAccountIam', 'PrincipalWritesNeedWorkloadBoundary', 'NoBoundaryRemoval',
        'PassOnlyLabRoles', 'AssumeOnlyLabRoles', 'LimitEc2InstanceTypes', 'LimitDbClasses', 'LimitCacheNodeTypes', 'LimitAsgSize',
      ]),
    );
    expect(statement(b, 'AssumeOnlyLabRoles')).toMatchObject({ Effect: 'Deny', Action: 'sts:AssumeRole', NotResource: [`arn:aws:iam::${ACCT}:role/CloudAlbum*`, `arn:aws:iam::${ACCT}:role/*cloudalbum-*`] });
    expect(statement(b, 'ProtectComponentTag').Condition).toEqual({ StringEquals: { 'aws:RequestTag/atl:component': ['platform', 'workstation'] } });
    expect(statement(b, 'DenyPlatformByTag').Condition).toEqual({ StringEquals: { 'aws:ResourceTag/atl:component': ['platform', 'workstation'] } });
  });

  it('learner guardrails (01 §6.5)', () => {
    const g = render('ATLLearnerGuardrails');
    expect(sids(g)).toEqual(
      expect.arrayContaining([
        'NoCommitments', 'ProtectAppRole', 'KeepPlatformChannel', 'KeepInstanceProfiles', 'ProtectNonLabTrails', 'ProtectAtlDocuments',
        'ProtectRecordings', 'ProtectLabStateStore', 'KeepAtlTags', 'ProtectRoleTag', 'LabIamResourcesOnly', 'DenyPlatformByArn',
        'DenyInternalRoutes', 'DrRegionLabStacksOnly', 'UsEast1LabStacksOnly',
      ]),
    );
    expect(statement(g, 'UsEast1LabStacksOnly')).toMatchObject({
      Effect: 'Deny',
      NotResource: `arn:aws:cloudformation:us-east-1:${ACCT}:stack/cloudalbum-*/*`,
      Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } },
    });
    expect(statement(g, 'DenyInternalRoutes').Resource).toBe(`${API}/*/*/api/v1/internal/*`);
    const arns = statement(g, 'DenyPlatformByArn').Resource as string[];
    // distribution, atl-* functions, three response headers policies, cache policy, OAC, user pool, HTTP API, key, association
    expect(arns).toHaveLength(11);
    expect(arns.some((a) => a.includes(':association/'))).toBe(true);
  });

  it('workload boundary (01 §6.6): DenySessionSecrets, DenyLabStateStore, ProtectRecordings, no cloudformation', () => {
    const w = render('ATLWorkloadBoundary');
    expect(statement(w, 'DenySessionSecrets')).toMatchObject({
      Effect: 'Deny',
      Action: 'ssm:GetParameter*',
      Resource: [`arn:aws:ssm:*:${ACCT}:parameter/cloudalbum/*/atl/*`, `arn:aws:ssm:*:${ACCT}:parameter/ec2/keypair/*`],
    });
    expect(statement(w, 'DenyLabStateStore').Resource).toEqual([`arn:aws:s3:::${STATE_BUCKET}`, `arn:aws:s3:::${STATE_BUCKET}/*`, LOCKS]);
    expect(statement(w, 'ProtectComponentTag').Condition).toEqual({ StringEquals: { 'aws:RequestTag/atl:component': ['platform', 'workstation'] } });
    const allow = statement(w, 'AllowLabServices').Action as string[];
    expect(allow).not.toContain('cloudformation:*');
    expect(allow).not.toContain('iam:*');
    expect(allow).not.toContain('sts:*');
  });

  it('provisioner boundary (01 §6.7 #2): ProtectComponentTag and DenyPlatformByTag only block the value platform', () => {
    const p = render('ATLProvisionerBoundary');
    expect(statement(p, 'ProtectComponentTag').Condition).toEqual({ StringEquals: { 'aws:RequestTag/atl:component': 'platform' } });
    expect(statement(p, 'DenyPlatformByTag').Condition).toEqual({ StringEquals: { 'aws:ResourceTag/atl:component': 'platform' } });
    expect(sids(p)).toEqual(expect.arrayContaining(['UsEast1LabStacksOnly', 'DrRegionLabStacksOnly', 'PassOnlyLabRoles', 'DenyPlatformRoles']));
    expect(statement(p, 'PassOnlyLabRoles').NotResource).toContain(`arn:aws:iam::${ACCT}:role/ATLWorkstationRole`);
    expect(sids(render('ATLProvisionerPolicy-Guards'))).toEqual(
      expect.arrayContaining(['ArtifactsReadOnly', 'DataRunsAndArchiveOnly', 'DenyPlatformByArn', 'UsersOnlyUnderLabPath', 'LimitEc2InstanceTypes']),
    );
  });

  it('LabRegion=us-east-1 drops UsEast1EdgeOnly / UsEast1LabStacksOnly; no DrRegion drops the DR statements', () => {
    const us = SCENARIOS.find((s) => s.region === 'us-east-1')!;
    expect(sids(render('ATLLearnerBoundary', us))).not.toContain('UsEast1EdgeOnly');
    expect(sids(render('ATLLearnerBoundary', us))).not.toContain('DrRegionLimited');
    expect(sids(render('ATLLearnerGuardrails', us))).not.toContain('UsEast1LabStacksOnly');
    expect(sids(render('ATLLearnerGuardrails', us))).not.toContain('DrRegionLabStacksOnly');
    expect(statement(render('ATLLearnerBoundary', us), 'DenyOtherRegions').Condition).toEqual({ StringNotEquals: { 'aws:RequestedRegion': ['us-east-1'] } });
  });

  it('verifier: SendCommand split into document / lab instance / workstation statements (04 §5.7)', () => {
    const r = render('ATLVerifierRunCheck');
    expect(statement(r, 'RunCheckDocument')).toMatchObject({ Resource: `arn:aws:ssm:${REGION}:${ACCT}:document/ATL-RunCheck` });
    expect(statement(r, 'RunCheckDocument').Condition).toBeUndefined();
    expect(statement(r, 'RunCheckLabInstances').Condition).toEqual({
      StringEquals: { 'ssm:resourceTag/atl:role': 'lab-app', 'ssm:resourceTag/atl:env-id': '${aws:PrincipalTag/atl:env-id}' },
    });
  });
});

describe('learner guardrail cases (07 V5-2, evaluated offline)', () => {
  it('G1 platform resources by name are denied; G2 the state store is allowed', () => {
    expect(asLearner(req('s3:ListBucket', `arn:aws:s3:::atl-data-${ACCT}-${REGION}`))).toBe('deny');
    expect(asLearner(req('dynamodb:DescribeTable', `arn:aws:dynamodb:${REGION}:${ACCT}:table/atl-main`))).toBe('deny');
    expect(asLearner(req('s3:ListBucket', `arn:aws:s3:::${STATE_BUCKET}`, { 's3:prefix': 'e7k2m9qx/' }))).toBe('allow');
    expect(asLearner(req('s3:GetObject', `arn:aws:s3:::${STATE_BUCKET}/e7k2m9qx/state.json`))).toBe('allow');
    expect(asLearner(req('s3:PutObject', `arn:aws:s3:::${STATE_BUCKET}/e7k2m9qx/state.json`))).toBe('allow');
    expect(asLearner(req('dynamodb:GetItem', LOCKS))).toBe('allow');
    expect(asLearner(req('dynamodb:PutItem', LOCKS))).toBe('allow');
  });

  it('G3 ProtectLabStateStore: reading the bucket policy is allowed, bucket-level writes are denied', () => {
    expect(asLearner(req('s3:GetBucketPolicy', `arn:aws:s3:::${STATE_BUCKET}`))).toBe('allow');
    expect(asLearner(req('s3:PutBucketVersioning', `arn:aws:s3:::${STATE_BUCKET}`))).toBe('deny');
    expect(asLearner(req('s3:DeleteBucketPolicy', `arn:aws:s3:::${STATE_BUCKET}`))).toBe('deny');
    expect(asLearner(req('dynamodb:DeleteTable', LOCKS))).toBe('deny');
  });

  it('G4–G6 tag protection', () => {
    const tag = (k: string, v: string) => ({ [`aws:RequestTag/${k}`]: v, 'aws:TagKeys': [k] });
    expect(asLearner(req('ec2:CreateTags', INSTANCE, tag('atl:component', 'platform')))).toBe('deny');
    expect(asLearner(req('ec2:CreateTags', INSTANCE, tag('atl:component', 'env')))).toBe('allow');
    expect(asLearner(req('ec2:DeleteTags', INSTANCE, { 'aws:TagKeys': ['atl:session-id'] }))).toBe('deny');
    expect(asLearner(req('ec2:CreateTags', INSTANCE, tag('atl:role', 'lab-app')))).toBe('deny');
    expect(asLearner(req('ec2:CreateTags', INSTANCE, { ...tag('atl:role', 'lab-app'), 'aws:CalledVia': ['cloudformation.amazonaws.com'] }))).toBe('allow');
  });

  it('G7–G9 instance types, volumes, RDS storage', () => {
    expect(asLearner(req('ec2:RunInstances', INSTANCE, { 'ec2:InstanceType': 'm5.large' }))).toBe('deny');
    expect(asLearner(req('ec2:RunInstances', INSTANCE, { 'ec2:InstanceType': 't3.micro' }))).toBe('allow');
    const vol = `arn:aws:ec2:${REGION}:${ACCT}:volume/*`;
    expect(asLearner(req('ec2:CreateVolume', vol, { 'ec2:VolumeSize': 101, 'ec2:VolumeType': 'gp3' }))).toBe('deny');
    expect(asLearner(req('ec2:CreateVolume', vol, { 'ec2:VolumeSize': 20, 'ec2:VolumeType': 'io2' }))).toBe('deny');
    expect(asLearner(req('ec2:CreateVolume', vol, { 'ec2:VolumeSize': 20, 'ec2:VolumeType': 'gp3' }))).toBe('allow');
    const db = `arn:aws:rds:${REGION}:${ACCT}:db:x`;
    expect(asLearner(req('rds:CreateDBInstance', db, { 'rds:StorageSize': 101, 'rds:DatabaseClass': 'db.t4g.micro' }))).toBe('deny');
    expect(asLearner(req('rds:CreateDBInstance', db, { 'rds:StorageSize': 20, 'rds:Piops': 1000, 'rds:DatabaseClass': 'db.t4g.micro' }))).toBe('deny');
    expect(asLearner(req('rds:CreateDBInstance', db, { 'rds:StorageSize': 20, 'rds:DatabaseClass': 'db.m5.large' }))).toBe('deny');
    expect(asLearner(req('rds:CreateDBInstance', db, { 'rds:StorageSize': 20, 'rds:DatabaseClass': 'db.t4g.micro' }))).toBe('allow');
    expect(asLearner(req('rds:ModifyDBInstance', db, {}))).toBe('allow');
  });

  it('G10–G13 irreversible storage and direct serverless cache', () => {
    expect(asLearner(req('s3:PutObject', 'arn:aws:s3:::cloudalbum-e7k2m9qx-g10/x', { 's3:object-lock-mode': 'COMPLIANCE' }))).toBe('deny');
    expect(asLearner(req('backup:PutBackupVaultLockConfiguration', `arn:aws:backup:${REGION}:${ACCT}:backup-vault:x`, { 'backup:ChangeableForDays': 3 }))).toBe('deny');
    expect(asLearner(req('kms:CreateKey', '*', { 'kms:BypassPolicyLockoutSafetyCheck': true }))).toBe('deny');
    expect(asLearner(req('elasticache:CreateServerlessCache', `arn:aws:elasticache:${REGION}:${ACCT}:serverlesscache:x`))).toBe('deny');
    expect(asLearner(req('elasticache:CreateServerlessCache', `arn:aws:elasticache:${REGION}:${ACCT}:serverlesscache:x`, { 'aws:CalledVia': ['cloudformation.amazonaws.com'] }))).toBe('allow');
  });

  it('G14 IAM delegation: workload boundary required, no users, no assuming platform roles', () => {
    const wb = `arn:aws:iam::${ACCT}:policy/ATLWorkloadBoundary`;
    expect(asLearner(req('iam:CreateRole', `arn:aws:iam::${ACCT}:role/cloudalbum-g14`))).toBe('deny');
    expect(asLearner(req('iam:CreateRole', `arn:aws:iam::${ACCT}:role/cloudalbum-g14`, { 'iam:PermissionsBoundary': wb }))).toBe('allow');
    expect(asLearner(req('iam:CreateUser', `arn:aws:iam::${ACCT}:user/x`))).toBe('deny');
    expect(asLearner(req('sts:AssumeRole', `arn:aws:iam::${ACCT}:role/ATLProvisionerRole`))).toBe('deny');
    expect(asLearner(req('sts:AssumeRole', `arn:aws:iam::${ACCT}:role/OrganizationAccountAccessRole`))).toBe('deny');
    expect(asLearner(req('sts:AssumeRole', `arn:aws:iam::${ACCT}:role/cloudalbum-e7k2m9qx-reader`))).toBe('allow');
    expect(asLearner(req('iam:PassRole', `arn:aws:iam::${ACCT}:role/ATLLearnerRole`))).toBe('deny');
    expect(asLearner(req('iam:PassRole', `arn:aws:iam::${ACCT}:role/CloudAlbumAppRole`))).toBe('allow');
    expect(asLearner(req('iam:UpdateAssumeRolePolicy', `arn:aws:iam::${ACCT}:role/Admin`))).toBe('deny');
    expect(asLearner(req('iam:DeleteRole', `arn:aws:iam::${ACCT}:role/CloudAlbumAppRole`))).toBe('deny');
    expect(asLearner(req('iam:DetachRolePolicy', `arn:aws:iam::${ACCT}:role/CloudAlbumAppRole`, { 'iam:PermissionsBoundary': wb, 'iam:PolicyARN': 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' }))).toBe('deny');
    expect(asLearner(req('iam:AttachRolePolicy', `arn:aws:iam::${ACCT}:role/CloudAlbumAppRole`, { 'iam:PermissionsBoundary': wb }))).toBe('allow');
  });

  it('G15 internal routes denied, agent routes allowed', () => {
    expect(asLearner(req('execute-api:Invoke', `${API}/$default/POST/api/v1/internal/runs/x/events`))).toBe('deny');
    expect(asLearner(req('execute-api:Invoke', `${API}/$default/GET/api/v1/agent/sessions/s4k7m2q9x1abc/context`))).toBe('allow');
  });

  it('G16 regions; G23/G24 us-east-1 stacks only cloudalbum-*', () => {
    expect(asLearner(req('sqs:ListQueues', '*', {}, 'eu-west-1'))).toBe('deny');
    expect(asLearner(req('sqs:CreateQueue', 'arn:aws:sqs:us-east-1:111122223333:atlv-g16', {}, 'us-east-1'))).toBe('deny');
    expect(asLearner(req('cloudfront:ListDistributions', '*', {}, 'us-east-1'))).toBe('allow');
    expect(asLearner(req('acm:ListCertificates', '*', {}, 'us-east-1'))).toBe('allow');
    const stack = (name: string) => `arn:aws:cloudformation:us-east-1:${ACCT}:stack/${name}/*`;
    expect(asLearner(req('cloudformation:CreateChangeSet', stack('cloudalbum-e7k2m9qx-g23'), {}, 'us-east-1'))).toBe('allow');
    expect(asLearner(req('cloudformation:CreateChangeSet', stack('other-g24'), {}, 'us-east-1'))).toBe('deny');
    expect(asLearner(req('cloudformation:CreateChangeSet', stack('atl-x'), {}, 'us-east-1'))).toBe('deny');
    expect(asLearner(req('ec2:RunInstances', `arn:aws:ec2:${DR}:${ACCT}:instance/*`, { 'ec2:InstanceType': 't3.micro' }, DR))).toBe('deny');
    expect(asLearner(req('backup:StartCopyJob', '*', {}, DR))).toBe('allow');
  });

  it('G17 / G18 platform resources by ARN and by name', () => {
    expect(asLearner(req('apigateway:DELETE', `arn:aws:apigateway:${REGION}::/apis/a1b2c3d4e5/routes/abc`))).toBe('deny');
    expect(asLearner(req('events:DisableRule', `arn:aws:events:${REGION}:${ACCT}:rule/atl-sfn-failed`))).toBe('deny');
    expect(asLearner(req('budgets:ModifyBudget', `arn:aws:budgets::${ACCT}:budget/atl-platform-guard`))).toBe('deny');
    expect(asLearner(req('ssm:UpdateAssociation', `arn:aws:ssm:${REGION}:${ACCT}:association/00000000-0000-4000-8000-000000000000`))).toBe('deny');
    expect(asLearner(req('ssm:UpdateDocument', `arn:aws:ssm:${REGION}:${ACCT}:document/ATL-RunCheck`))).toBe('deny');
    expect(asLearner(req('logs:DeleteLogGroup', `arn:aws:logs:${REGION}:${ACCT}:log-group:/atl-recordings/terminal-sessions`))).toBe('deny');
  });

  it('the platform CloudFront function, response headers / cache policies and OAC (untaggable) are denied by ARN', () => {
    const cf = (path: string) => `arn:aws:cloudfront::${ACCT}:${path}`;
    const platform: [string, string][] = [
      ['cloudfront:UpdateFunction', cf('function/atl-spa-rewrite')],
      ['cloudfront:PublishFunction', cf('function/atl-spa-rewrite')],
      ['cloudfront:UpdateResponseHeadersPolicy', cf('response-headers-policy/11111111-aaaa-4bbb-8ccc-000000000001')],
      ['cloudfront:UpdateResponseHeadersPolicy', cf('response-headers-policy/11111111-aaaa-4bbb-8ccc-000000000002')],
      ['cloudfront:DeleteResponseHeadersPolicy', cf('response-headers-policy/11111111-aaaa-4bbb-8ccc-000000000003')],
      ['cloudfront:UpdateCachePolicy', cf('cache-policy/22222222-aaaa-4bbb-8ccc-000000000001')],
      ['cloudfront:UpdateOriginAccessControl', cf('origin-access-control/E3EXAMPLEOAC01')],
      ['cloudfront:UpdateDistribution', cf('distribution/E2EXAMPLEATL01')],
    ];
    for (const [action, arn] of platform) {
      expect(asLearner(req(action, arn, {}, 'us-east-1')), `${action} ${arn} (learner)`).toBe('deny');
      expect(asWorkload(req(action, arn, {}, 'us-east-1')), `${action} ${arn} (workload)`).toBe('deny');
      expect(asProvisioner(req(action, arn, {}, 'us-east-1')), `${action} ${arn} (provisioner)`).toBe('deny');
    }
    // the learner's own CDN resources stay writable (svc-cdn)
    expect(asLearner(req('cloudfront:UpdateFunction', cf('function/cloudalbum-e7k2m9qx-rewrite'), {}, 'us-east-1'))).toBe('allow');
    expect(asLearner(req('cloudfront:UpdateCachePolicy', cf('cache-policy/33333333-aaaa-4bbb-8ccc-000000000009'), {}, 'us-east-1'))).toBe('allow');
  });

  it('the platform terminal still works: StartSession on the (platform-tagged) workstation is exempt', () => {
    expect(asLearner(req('ssm:StartSession', INSTANCE, { 'aws:ResourceTag/atl:component': 'workstation' }))).toBe('allow');
    expect(asLearner(req('ec2:StopInstances', INSTANCE, { 'aws:ResourceTag/atl:component': 'workstation' }))).toBe('deny');
  });
});

describe('workload boundary (01 §6.6) holds even with AdministratorAccess attached', () => {
  it('DenySessionSecrets and DenyLabStateStore', () => {
    expect(asWorkload(req('ssm:GetParameter', `arn:aws:ssm:${REGION}:${ACCT}:parameter/cloudalbum/e7k2m9qx/atl/ssh-key`))).toBe('deny');
    expect(asWorkload(req('ssm:GetParameters', `arn:aws:ssm:${REGION}:${ACCT}:parameter/ec2/keypair/key-0abc`))).toBe('deny');
    expect(asWorkload(req('ssm:GetParameter', `arn:aws:ssm:${REGION}:${ACCT}:parameter/cloudalbum/e7k2m9qx/app/db-url`))).toBe('allow');
    expect(asWorkload(req('s3:GetObject', `arn:aws:s3:::${STATE_BUCKET}/e7k2m9qx/state.json`))).toBe('deny');
    expect(asWorkload(req('dynamodb:PutItem', LOCKS))).toBe('deny');
  });

  it('no stacks, no IAM writes, STS only to lab roles', () => {
    expect(asWorkload(req('cloudformation:CreateStack', `arn:aws:cloudformation:${REGION}:${ACCT}:stack/cloudalbum-x/*`))).toBe('implicit-deny');
    expect(asWorkload(req('iam:CreateRole', `arn:aws:iam::${ACCT}:role/cloudalbum-x`))).not.toBe('allow');
    expect(asWorkload(req('iam:GetRole', `arn:aws:iam::${ACCT}:role/CloudAlbumAppRole`))).toBe('allow');
    expect(asWorkload(req('sts:AssumeRole', `arn:aws:iam::${ACCT}:role/cloudalbum-e7k2m9qx-x`))).toBe('allow');
    expect(asWorkload(req('sts:AssumeRole', `arn:aws:iam::${ACCT}:role/Admin`))).toBe('implicit-deny');
  });

  it('the SSM Agent on lab instances keeps working (association, documents, recording)', () => {
    const assoc = `arn:aws:ssm:${REGION}:${ACCT}:association/00000000-0000-4000-8000-000000000000`;
    expect(asWorkload(req('ssm:DescribeAssociation', assoc))).toBe('allow');
    expect(asWorkload(req('ssm:UpdateInstanceAssociationStatus', assoc))).toBe('allow');
    expect(asWorkload(req('ssm:GetDocument', `arn:aws:ssm:${REGION}:${ACCT}:document/ATL-PrepareInstance`))).toBe('allow');
    expect(asWorkload(req('ssm:UpdateAssociation', assoc))).toBe('deny');
    expect(asWorkload(req('ssm:DeleteDocument', `arn:aws:ssm:${REGION}:${ACCT}:document/ATL-RunCheck`))).toBe('deny');
    const stream = `arn:aws:logs:${REGION}:${ACCT}:log-group:/atl-recordings/terminal-sessions:log-stream:abc`;
    expect(asWorkload(req('logs:PutLogEvents', stream))).toBe('allow');
    expect(asWorkload(req('logs:DeleteLogGroup', `arn:aws:logs:${REGION}:${ACCT}:log-group:/atl-recordings/terminal-sessions`))).toBe('deny');
  });

  it('instance limits and platform tags', () => {
    expect(asWorkload(req('ec2:RunInstances', INSTANCE, { 'ec2:InstanceType': 'c5.4xlarge' }))).toBe('deny');
    expect(asWorkload(req('ec2:CreateTags', INSTANCE, { 'aws:RequestTag/atl:component': 'platform', 'aws:TagKeys': ['atl:component'] }))).toBe('deny');
    expect(asWorkload(req('kms:Sign', `arn:aws:kms:${REGION}:${ACCT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`))).toBe('deny');
  });
});

describe('provisioner (01 §6.7)', () => {
  it('manages the workstation but not the platform', () => {
    const ws = `arn:aws:cloudformation:${REGION}:${ACCT}:stack/atl-ws-s4k7m2q9x1abc/*`;
    expect(asProvisioner(req('cloudformation:CreateStack', ws))).toBe('allow');
    expect(asProvisioner(req('cloudformation:DeleteStack', `arn:aws:cloudformation:${REGION}:${ACCT}:stack/atl/*`))).toBe('deny');
    expect(asProvisioner(req('iam:PassRole', `arn:aws:iam::${ACCT}:role/ATLWorkstationRole`))).toBe('allow');
    expect(asProvisioner(req('iam:PassRole', `arn:aws:iam::${ACCT}:role/ATLLearnerRole`))).toBe('deny');
    expect(asProvisioner(req('iam:UpdateRole', `arn:aws:iam::${ACCT}:role/ATLWorkstationRole`))).toBe('deny');
    expect(asProvisioner(req('ec2:CreateTags', INSTANCE, { 'aws:RequestTag/atl:component': 'workstation', 'aws:TagKeys': ['atl:component'] }))).toBe('allow');
    expect(asProvisioner(req('ec2:CreateTags', INSTANCE, { 'aws:RequestTag/atl:component': 'platform', 'aws:TagKeys': ['atl:component'] }))).toBe('deny');
    expect(asProvisioner(req('ec2:TerminateInstances', INSTANCE, { 'aws:ResourceTag/atl:component': 'workstation' }))).toBe('allow');
    expect(asProvisioner(req('dynamodb:PutItem', `arn:aws:dynamodb:${REGION}:${ACCT}:table/atl-main`))).toBe('deny');
  });

  it('artifacts read-only, runs/ and archive/ writable, other data prefixes and atl-web denied', () => {
    expect(asProvisioner(req('s3:GetObject', `arn:aws:s3:::atl-artifacts-${ACCT}-${REGION}/releases/v1/cloudalbum-infra.zip`))).toBe('allow');
    expect(asProvisioner(req('s3:PutObject', `arn:aws:s3:::atl-artifacts-${ACCT}-${REGION}/releases/v1/x`))).toBe('deny');
    expect(asProvisioner(req('s3:PutObject', `arn:aws:s3:::atl-data-${ACCT}-${REGION}/runs/s4k7m2q9x1abc-base-1/result.json`))).toBe('allow');
    expect(asProvisioner(req('s3:PutObject', `arn:aws:s3:::atl-data-${ACCT}-${REGION}/archive/s4k7m2q9x1abc/state.json`))).toBe('allow');
    expect(asProvisioner(req('s3:GetObject', `arn:aws:s3:::atl-data-${ACCT}-${REGION}/reports/s4k7m2q9x1abc/r.json`))).toBe('deny');
    expect(asProvisioner(req('s3:DeleteBucket', `arn:aws:s3:::atl-data-${ACCT}-${REGION}`))).toBe('deny');
    expect(asProvisioner(req('s3:PutObject', `arn:aws:s3:::atl-web-${ACCT}-${REGION}/index.html`))).toBe('deny');
  });

  it('keys-mode demo users only under /cloudalbum/ with the workload boundary; internal routes; cost tags', () => {
    const wb = `arn:aws:iam::${ACCT}:policy/ATLWorkloadBoundary`;
    const user = `arn:aws:iam::${ACCT}:user/cloudalbum/cloudalbum-e7k2m9qx-demo-keys`;
    expect(asProvisioner(req('iam:CreateUser', user, { 'iam:PermissionsBoundary': wb }))).toBe('allow');
    expect(asProvisioner(req('iam:CreateUser', user))).toBe('deny');
    expect(asProvisioner(req('iam:CreateUser', `arn:aws:iam::${ACCT}:user/admin2`, { 'iam:PermissionsBoundary': wb }))).toBe('deny');
    expect(asProvisioner(req('execute-api:Invoke', `${API}/$default/POST/api/v1/internal/runs/x/events`))).toBe('allow');
    expect(asProvisioner(req('ce:UpdateCostAllocationTagsStatus', '*', {}, 'us-east-1'))).toBe('allow');
    expect(asProvisioner(req('cloudformation:CreateStack', `arn:aws:cloudformation:us-east-1:${ACCT}:stack/cloudalbum-e7k2m9qx-waf-edge/*`, {}, 'us-east-1'))).toBe('allow');
    expect(asProvisioner(req('cloudformation:CreateStack', `arn:aws:cloudformation:us-east-1:${ACCT}:stack/other/*`, {}, 'us-east-1'))).toBe('deny');
  });
});

describe('verifier (01 §6.8, 04 §5.7)', () => {
  const tags = { 'aws:PrincipalTag/atl:env-id': '01jc9x3k9cq4m2x8n5b6c0d1e2', 'aws:PrincipalTag/atl:session-id': 's4k7m2q9x1abc' };
  it('ATL-RunCheck only, bound to this environment / session', () => {
    expect(asVerifier(req('ssm:SendCommand', `arn:aws:ssm:${REGION}:${ACCT}:document/ATL-RunCheck`, tags))).toBe('allow');
    expect(asVerifier(req('ssm:SendCommand', `arn:aws:ssm:${REGION}::document/AWS-RunShellScript`, tags))).toBe('implicit-deny');
    const lab = { ...tags, 'ssm:resourceTag/atl:role': 'lab-app', 'ssm:resourceTag/atl:env-id': '01jc9x3k9cq4m2x8n5b6c0d1e2' };
    expect(asVerifier(req('ssm:SendCommand', INSTANCE, lab))).toBe('allow');
    expect(asVerifier(req('ssm:SendCommand', INSTANCE, { ...lab, 'ssm:resourceTag/atl:env-id': '01other' }))).toBe('implicit-deny');
    const ws = { ...tags, 'ssm:resourceTag/atl:role': 'workstation', 'ssm:resourceTag/atl:session-id': 's4k7m2q9x1abc' };
    expect(asVerifier(req('ssm:SendCommand', INSTANCE, ws))).toBe('allow');
    expect(asVerifier(req('ssm:SendCommand', INSTANCE, { ...ws, 'ssm:resourceTag/atl:session-id': 'sotherxxxxxxx' }))).toBe('implicit-deny');
  });
  it('read-only: no data reads (04 §5.7 “刻意不授予”)', () => {
    for (const a of ['s3:GetObject', 'secretsmanager:GetSecretValue', 'ssm:GetParameter', 'kms:Decrypt', 'dynamodb:Query', 'logs:GetLogEvents', 'lambda:GetFunction']) {
      expect(asVerifier(req(a, '*', tags)), a).toBe('implicit-deny');
    }
    expect(asVerifier(req('ec2:DescribeInstances', '*', tags))).toBe('allow');
    expect(matchingSids(verifier.identity, req('cloudtrail:LookupEvents', '*'), 'Allow').length).toBeGreaterThan(0);
  });
});
