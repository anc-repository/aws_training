/**
 * Structural rules of the platform template (01 §3–§7, implementation-notes platform-scaffold §2): function runtime and
 * environment, DefinitionSubstitutions = DEV_SUBSTITUTIONS, guard ordering, keep-lists, tables = @atl/shared specs, tags,
 * conditions, outputs without secrets, size limits, and cfn-lint (when installed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ATL_MAIN_SPEC, INSTALL_DEFAULTS, INSTALL_PARAMETERS, LAB_LOCKS_SPEC, STATE_MACHINES } from '@atl/shared';
import { DEV_SUBSTITUTIONS } from '@atl/workflows';
import { describe, expect, it } from 'vitest';
import { cfnLintExecutable, runCfnLint } from '../build/cfn-lint.js';
import { collectReferences } from '../build/intrinsics.js';
import { INFRA_ROOT, templateStats, writeTemplate } from '../build/merge-template.js';
import {
  allFunctionNamesCovered,
  copyArtifactsInlineCode,
  FUNCTION_DEFS,
  INLINE_CODE_MAX_CHARS,
  placeholdersIn,
  productionSubstitution,
  STATE_MACHINE_LOGICAL_IDS,
} from '../build/template-parts.js';
import { WORKSTATION_TEMPLATE } from '../build/workstation-template.js';
import { byType, defaultConditions, emptyManifestTemplate, prop, resources, template, TEST_MANIFEST, type Resource } from './support/template.js';

/** platform/api/src/runtime/env.ts PLATFORM_ENV_VARS (minus ATL_DEV_MODE, which never appears in the template). */
const PLATFORM_ENV_VARS = [
  'ATL_ACCOUNT_ID', 'ATL_TABLE', 'ATL_LOCKS_TABLE', 'ATL_WEB_BUCKET', 'ATL_DATA_BUCKET', 'ATL_ARTIFACTS_BUCKET', 'ATL_LAB_STATE_BUCKET',
  'ATL_USER_POOL_ID', 'ATL_WEB_CLIENT_ID', 'ATL_SIGNING_KEY_ID', 'ATL_SCHEDULER_ROLE_ARN', 'ATL_TIMER_FUNCTION_ARN', 'ATL_TIMER_DLQ_ARN',
  'ATL_PLATFORM_VERSION',
];

describe('functions (01 §3.2)', () => {
  it('cover every Lambda of the name table', () => {
    expect(allFunctionNamesCovered()).toEqual([]);
  });

  it('nodejs22.x on arm64, JSON logs into the pre-created log group, code from the release zip', () => {
    for (const [, r] of byType('AWS::Lambda::Function')) {
      expect(prop(r, 'Runtime')).toBe('nodejs22.x');
      expect(prop(r, 'Architectures')).toEqual(['arm64']);
      expect(prop<{ LogFormat: string }>(r, 'LoggingConfig').LogFormat).toBe('JSON');
      const name = prop<string>(r, 'FunctionName');
      if (name === 'atl-copy-artifacts') {
        expect(prop(r, 'Handler')).toBe('index.handler');
        continue;
      }
      expect(prop(r, 'Handler')).toBe(`${name}/index.handler`);
      expect(prop(r, 'Code')).toMatchObject({ S3Key: { 'Fn::Sub': 'releases/${ReleaseVersion}/atl-lambdas.zip' }, S3ObjectVersion: { 'Fn::GetAtt': ['CopyArtifacts', 'LambdasObjectVersion'] } });
    }
  });

  it('every function (except the inline copy-artifacts) gets the ATL_* environment of platform/api/src/runtime/env.ts', () => {
    for (const [, r] of byType('AWS::Lambda::Function')) {
      if (prop(r, 'FunctionName') === 'atl-copy-artifacts') continue;
      const vars = Object.keys(prop<{ Variables: Record<string, unknown> }>(r, 'Environment').Variables);
      for (const v of PLATFORM_ENV_VARS) expect(vars, `${prop(r, 'FunctionName')} lacks ${v}`).toContain(v);
    }
    expect(JSON.stringify(template())).not.toContain('ATL_DEV_MODE');
  });

  it('the inline atl-copy-artifacts code is small enough for Code.ZipFile and exports a handler', () => {
    const code = copyArtifactsInlineCode();
    expect(code.length).toBeLessThanOrEqual(INLINE_CODE_MAX_CHARS);
    expect(code).toMatch(/handler/);
    expect(FUNCTION_DEFS.filter((f) => f.inline).map((f) => f.name)).toEqual(['atl-copy-artifacts']);
  });
});

describe('state machines (01 §3.3)', () => {
  it('DefinitionSubstitutions: every placeholder used by an ASL file has a production value', () => {
    for (const name of STATE_MACHINES) {
      const r = resources()[STATE_MACHINE_LOGICAL_IDS[name]]!;
      const used = placeholdersIn(prop(r, 'Definition'));
      const subs = Object.keys(prop<Record<string, unknown>>(r, 'DefinitionSubstitutions') ?? {}).sort();
      expect(subs, name).toEqual(used);
    }
  });

  it('every DEV_SUBSTITUTIONS key maps to a production value (same placeholder set in dev and prod)', () => {
    for (const [k, v] of Object.entries(DEV_SUBSTITUTIONS)) expect(() => productionSubstitution(k, v), k).not.toThrow();
    expect(productionSubstitution('LifecycleFn', 'atl-lifecycle')).toEqual({ 'Fn::GetAtt': ['LifecycleFunction', 'Arn'] });
    expect(productionSubstitution('SessionEndArn', 'arn:aws:states:ap-northeast-1:000000000000:stateMachine:atl-session-end')).toEqual({
      'Fn::Sub': 'arn:${AWS::Partition}:states:${AWS::Region}:${AWS::AccountId}:stateMachine:atl-session-end',
    });
    expect(() => productionSubstitution('Unknown', 'whatever')).toThrow(/KNOWN_SUBSTITUTIONS/);
  });

  it('run as ATLOrchestratorRole', () => {
    for (const [, r] of byType('AWS::StepFunctions::StateMachine')) expect(prop(r, 'RoleArn')).toEqual({ 'Fn::GetAtt': ['OrchestratorRole', 'Arn'] });
  });
});

describe('install ordering (01 §4.6)', () => {
  const all = resources();
  const unconditional = Object.entries(all).filter(([, r]) => !r.Condition).map(([id]) => id);
  const dependsOn = (r: Resource) => (Array.isArray(r.DependsOn) ? r.DependsOn : r.DependsOn ? [r.DependsOn] : []);
  const covers = (id: string, target: string) => dependsOn(all[id]!).includes(target) || collectReferences(all[id]!.Properties ?? {}).has(target);

  it('StackGuard is created last: it depends on every other unconditional resource', () => {
    for (const id of unconditional) if (id !== 'StackGuard') expect(covers('StackGuard', id), id).toBe(true);
  });

  it('UninstallGuard is deleted first: it depends on every unconditional resource except StackGuard', () => {
    for (const id of unconditional) if (id !== 'StackGuard' && id !== 'UninstallGuard') expect(covers('UninstallGuard', id), id).toBe(true);
    expect(dependsOn(all.UninstallGuard!)).not.toContain('StackGuard');
  });

  it('no DependsOn points at a conditional resource from an unconditional one', () => {
    for (const [id, r] of Object.entries(all)) {
      if (r.Condition) continue;
      for (const d of dependsOn(r)) expect(all[d]?.Condition, `${id} → ${d}`).toBeUndefined();
    }
  });

  it('BucketEmptier references the four buckets; functions reference their log groups', () => {
    const refs = collectReferences(all.BucketEmptier!.Properties);
    for (const b of ['WebBucket', 'ArtifactsBucket', 'DataBucket', 'LabStateBucket']) expect(refs.has(b)).toBe(true);
    for (const f of FUNCTION_DEFS) expect(collectReferences(all[f.logicalId]!.Properties).has(`${f.logicalId}LogGroup`)).toBe(true);
  });

  it('the release manifest is embedded in CopyArtifacts; an unpackaged template carries an empty one', () => {
    expect(prop(all.CopyArtifacts!, 'Manifest')).toEqual(TEST_MANIFEST);
    expect(prop((emptyManifestTemplate().Resources as Record<string, Resource>).CopyArtifacts!, 'Manifest')).toEqual({ Files: [], ChecksBundleDigest: '' });
  });

  it('UninstallGuard keep-lists equal the policies the stack declares on the three roles (01 §4.8)', () => {
    const keep = prop<Record<string, { Inline: unknown[]; Managed: unknown[] }>>(all.UninstallGuard!, 'KeepPolicies');
    const role = (name: string) => Object.entries(all).find(([, r]) => r.Type === 'AWS::IAM::Role' && prop(r, 'RoleName') === name)!;
    for (const name of ['ATLLearnerRole', 'ATLWorkstationRole', 'CloudAlbumAppRole']) {
      const [id, r] = role(name);
      const declaredInline = ((prop(r, 'Policies') as { PolicyName: string }[] | undefined) ?? []).map((p) => p.PolicyName);
      const rolePolicies = Object.values(all).filter((x) => x.Type === 'AWS::IAM::RolePolicy' && JSON.stringify(prop(x, 'RoleName')) === JSON.stringify({ Ref: id }));
      const inlineKeep = keep[name]!.Inline.map((x) => (typeof x === 'string' ? x : (x as { 'Fn::If': unknown[] })['Fn::If'][1]));
      expect(inlineKeep.sort(), name).toEqual([...declaredInline, ...rolePolicies.map((p) => prop<string>(p, 'PolicyName'))].sort());
      expect(keep[name]!.Managed, name).toEqual(prop(r, 'ManagedPolicyArns'));
    }
  });
});

describe('data (01 §7.1, §3.11)', () => {
  const table = (name: string) => byType('AWS::DynamoDB::Table').find(([, r]) => prop(r, 'TableName') === name)![1];
  it('atl-main = ATL_MAIN_SPEC', () => {
    const t = table('atl-main');
    expect(prop(t, 'KeySchema')).toEqual(ATL_MAIN_SPEC.KeySchema);
    expect(prop(t, 'AttributeDefinitions')).toEqual(ATL_MAIN_SPEC.AttributeDefinitions);
    expect(prop(t, 'GlobalSecondaryIndexes')).toEqual(ATL_MAIN_SPEC.GlobalSecondaryIndexes);
    expect(prop(t, 'BillingMode')).toBe('PAY_PER_REQUEST');
    expect(prop(t, 'TimeToLiveSpecification')).toEqual({ AttributeName: ATL_MAIN_SPEC.ttlAttribute, Enabled: true });
  });
  it('cloudalbum-lab-locks = LAB_LOCKS_SPEC, tagged lab-state (not platform)', () => {
    const t = table('cloudalbum-lab-locks');
    expect(prop(t, 'KeySchema')).toEqual(LAB_LOCKS_SPEC.KeySchema);
    expect(prop(t, 'AttributeDefinitions')).toEqual(LAB_LOCKS_SPEC.AttributeDefinitions);
    expect(prop(t, 'Tags')).toContainEqual({ Key: 'atl:component', Value: 'lab-state' });
    const bucket = resources().LabStateBucket!;
    expect(prop(bucket, 'Tags')).toContainEqual({ Key: 'atl:component', Value: 'lab-state' });
    expect(prop(bucket, 'VersioningConfiguration')).toEqual({ Status: 'Enabled' });
  });
  it('buckets block public access and use SSE-S3', () => {
    for (const [, b] of byType('AWS::S3::Bucket')) {
      expect(prop(b, 'PublicAccessBlockConfiguration')).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      expect(JSON.stringify(prop(b, 'BucketEncryption'))).toContain('AES256');
    }
  });
});

describe('IAM structure (01 §6.1–§6.3)', () => {
  const role = (name: string) => byType('AWS::IAM::Role').find(([, r]) => prop(r, 'RoleName') === name)![1];
  it('CloudAlbumAppRole carries ATLWorkloadBoundary and only AmazonSSMManagedInstanceCore; it is not tagged as a platform resource', () => {
    const r = role('CloudAlbumAppRole');
    expect(prop(r, 'PermissionsBoundary')).toEqual({ Ref: 'WorkloadBoundary' });
    expect(JSON.stringify(prop(r, 'ManagedPolicyArns'))).toContain('AmazonSSMManagedInstanceCore');
    expect(JSON.stringify(prop(r, 'Tags'))).not.toContain('atl:component');
  });
  it('the learner role: boundary, guardrails, 1 h sessions, per-principal session-name conditions (01 §6.2)', () => {
    const r = role('ATLLearnerRole');
    expect(prop(r, 'PermissionsBoundary')).toEqual({ Ref: 'LearnerBoundary' });
    expect(prop(r, 'MaxSessionDuration')).toBe(3600);
    const trust = prop<{ Statement: { Principal: unknown; Action: unknown; Condition: unknown }[] }>(r, 'AssumeRolePolicyDocument');
    expect(trust.Statement).toHaveLength(2);
    expect(trust.Statement[0]!.Condition).toEqual({ StringLike: { 'sts:RoleSessionName': ['atl-s*-console', 'atl-s*-term'] } });
    expect(trust.Statement[0]!.Action).toEqual(['sts:AssumeRole', 'sts:SetSourceIdentity']);
    expect(trust.Statement[1]!.Condition).toEqual({ StringEquals: { 'sts:RoleSessionName': 'atl-${aws:PrincipalTag/atl:active-session-id}-ws' } });
  });
  it('the provisioner trusts only the runner service role and the reaper, with session-name conditions', () => {
    const trust = prop<{ Statement: { Principal: unknown; Condition: unknown }[] }>(role('ATLProvisionerRole'), 'AssumeRolePolicyDocument');
    expect(trust.Statement.map((s) => s.Principal)).toEqual([{ AWS: { 'Fn::GetAtt': ['RunnerServiceRole', 'Arn'] } }, { AWS: { 'Fn::GetAtt': ['ReaperFunctionRole', 'Arn'] } }]);
    expect(trust.Statement.map((s) => s.Condition)).toEqual([{ StringLike: { 'sts:RoleSessionName': 'atl-s*-prov-*' } }, { StringLike: { 'sts:RoleSessionName': 'atl-s*-reap-*' } }]);
  });
  it('the verifier allows TagSession with atl:session-id / atl:env-id only', () => {
    const trust = prop<{ Statement: { Action: unknown; Condition: Record<string, unknown> }[] }>(role('ATLVerifierRole'), 'AssumeRolePolicyDocument');
    expect(trust.Statement[0]!.Action).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect(trust.Statement[0]!.Condition['ForAllValues:StringEquals']).toEqual({ 'aws:TagKeys': ['atl:session-id', 'atl:env-id'] });
  });
  it('service principals carry confused-deputy conditions (01 §6.2)', () => {
    for (const name of ['ATLOrchestratorRole', 'ATLRunnerServiceRole', 'ATLSchedulerRole']) {
      expect(JSON.stringify(prop(role(name), 'AssumeRolePolicyDocument')), name).toContain('aws:SourceArn');
    }
  });
  it('only ATLSchedulerRole can be passed to Scheduler, with iam:PassedToService', () => {
    const lifecycle = JSON.stringify(prop(role('ATLLifecycleFunctionRole'), 'Policies'));
    expect(lifecycle).toContain('"iam:PassedToService":"scheduler.amazonaws.com"');
  });
});

describe('parameters, conditions, outputs (01 §4.3, §4.6)', () => {
  it('parameters = INSTALL_PARAMETERS with the 01 §4.3 defaults', () => {
    const params = template().Parameters as Record<string, { Default?: unknown }>;
    expect(Object.keys(params).sort()).toEqual([...INSTALL_PARAMETERS].sort());
    expect(params.MaxSessionMinutes!.Default).toBe(INSTALL_DEFAULTS.MaxSessionMinutes);
    expect(params.WorkstationInstanceType!.Default).toBe(INSTALL_DEFAULTS.WorkstationInstanceType);
    expect(params.DrRegion!.Default).toBe(INSTALL_DEFAULTS.DrRegion);
    expect(params.TerminalRecording!.Default).toBe('off');
    expect(params.PlatformTrail!.Default).toBe('none');
    expect(params.MfaMode!.Default).toBe('ON');
    expect(params.ReleaseVersion!.Default).toMatch(/^v\d+\.\d+\.\d+/);
  });
  it('defaults: no trail / tagger / budget / recording; the analyzer is created', () => {
    const c = defaultConditions();
    expect(c).toMatchObject({ TrailEnabled: false, RecordingOn: false, HasBudget: false, CreateAnalyzer: true, NotUsEast1: true, HasDrRegion: true, IsMfaOn: true });
    expect(defaultConditions({ TerminalRecording: 'cloudwatch', MonthlyBudgetAmount: '50' })).toMatchObject({ RecordingOn: true, HasBudget: true });
  });
  it('outputs (01 §4.6) contain no secrets', () => {
    const outputs = template().Outputs as Record<string, unknown>;
    expect(Object.keys(outputs).sort()).toEqual(
      ['PlatformUrl', 'AgentApiEndpoint', 'UserPoolId', 'LearnerRoleArn', 'WorkloadBoundaryArn', 'LabStateBucket', 'LabLockTable', 'Version', 'InstallationId'].sort(),
    );
    expect(JSON.stringify(outputs)).not.toMatch(/password|secret|token|PrivateKey/i);
  });
  it('fits the CloudFormation limits (resources < 500, template ≤ 1 MB via S3)', () => {
    const s = templateStats(template());
    expect(s.resources).toBeLessThan(500);
    expect(s.bytes).toBeLessThan(1_000_000);
  });
  it('platform resources are tagged atl:component=platform / Project=ATL', () => {
    for (const id of ['AtlMainTable', 'DataBucket', 'ArtifactsBucket', 'WebBucket', 'CertSigningKey', 'EventBus', 'RunnerProject', 'TimerDlq']) {
      expect(JSON.stringify(resources()[id]!.Properties), id).toContain('"atl:component","Value":"platform"');
    }
  });
});

describe('cfn-lint (01 §6.10)', () => {
  const exe = cfnLintExecutable();
  it.skipIf(!exe)('platform and workstation templates have no errors', () => {
    const out = path.join(INFRA_ROOT, 'dist', 'test', 'atl-platform.template.json');
    writeTemplate(template(), out);
    const r = runCfnLint([out, WORKSTATION_TEMPLATE], exe!);
    expect(r.output.split('\n').filter((l) => /^E\d{4}/.test(l))).toEqual([]);
    expect(r.status).toBe(0);
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }, 120_000);
});
