/**
 * Generated parts of the platform template (repetitive resources that would otherwise be copy-pasted YAML):
 *   - the twelve Lambda functions of 01 §3.2 (+ their pre-created log groups, 01 §4.6), with the `ATL_*` environment of
 *     platform/api/src/runtime/env.ts (PLATFORM_ENV_VARS) on every function;
 *   - the six state machines of 01 §3.3 from platform/workflows/statemachines/*.asl.json (+ /aws/vendedlogs/states/<name>),
 *     DefinitionSubstitutions derived from the keys of DEV_SUBSTITUTIONS (one placeholder set for dev and prod);
 *   - the inline code of atl-copy-artifacts (minified custom-resources/copy-artifacts.cjs, 01 §4.5);
 *   - the EC2 trust policy (aws:SourceAccount per release.config.json, 07 V1-6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { LAMBDA_FUNCTIONS, STATE_MACHINES, type LambdaFunctionName, type StateMachineName } from '@atl/shared';
import { DEV_SUBSTITUTIONS, RUNNER_SESSION_STATIC_POLICY, staticRunnerStatements } from '@atl/workflows';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INFRA_DIR = path.resolve(HERE, '..');
export const PLATFORM_DIR = path.resolve(INFRA_DIR, '..');
export const STATEMACHINES_DIR = path.join(PLATFORM_DIR, 'workflows', 'statemachines');

type Json = Record<string, unknown>;

export interface FunctionDef {
  name: LambdaFunctionName;
  logicalId: string;
  role: string;
  timeout: number;
  memory: number;
  description: string;
  condition?: string;
  /** Inline Code.ZipFile (atl-copy-artifacts) instead of the release zip. */
  inline?: boolean;
  dependsOn?: string[];
}

/** 01 §3.2 (timeouts: HTTP functions stay below the 30 s HTTP API integration limit; long tasks up to 15 min). */
export const FUNCTION_DEFS: readonly FunctionDef[] = [
  { name: 'atl-api', logicalId: 'ApiFunction', role: 'ApiFunctionRole', timeout: 29, memory: 1024, description: 'ATL browser API (/api/v1, Cognito JWT)' },
  { name: 'atl-public', logicalId: 'PublicFunction', role: 'PublicFunctionRole', timeout: 10, memory: 256, description: 'ATL public routes (certificates, keys, health)' },
  { name: 'atl-agent', logicalId: 'AgentFunction', role: 'AgentFunctionRole', timeout: 29, memory: 512, description: 'ATL agent (workstation) and internal (runner) routes' },
  { name: 'atl-checks', logicalId: 'ChecksFunction', role: 'ChecksFunctionRole', timeout: 900, memory: 1024, description: 'ATL checks, health gates, finalize' },
  { name: 'atl-lifecycle', logicalId: 'LifecycleFunction', role: 'LifecycleFunctionRole', timeout: 300, memory: 512, description: 'ATL session lifecycle (single writer of LabSession state)' },
  { name: 'atl-timer', logicalId: 'TimerFunction', role: 'TimerFunctionRole', timeout: 300, memory: 512, description: 'ATL timers and the SWEEP watchdog' },
  { name: 'atl-reaper', logicalId: 'ReaperFunction', role: 'ReaperFunctionRole', timeout: 900, memory: 1024, description: 'ATL reclaimer and ownership lookup' },
  { name: 'atl-certs', logicalId: 'CertsFunction', role: 'CertsFunctionRole', timeout: 300, memory: 1024, description: 'ATL reports, certificates, revocation lists', dependsOn: ['CertsSigningPolicy'] },
  { name: 'atl-pricing', logicalId: 'PricingFunction', role: 'PricingFunctionRole', timeout: 30, memory: 512, description: 'ATL cost quotes (Price List API)' },
  {
    name: 'atl-custom-resources',
    logicalId: 'CustomResourcesFunction',
    role: 'CustomResourceRole',
    timeout: 900,
    memory: 1024,
    description: 'ATL install / upgrade / uninstall custom resources',
    dependsOn: ['CustomResourceKmsPolicy'],
  },
  { name: 'atl-copy-artifacts', logicalId: 'CopyArtifactsFunction', role: 'CustomResourceRole', timeout: 900, memory: 2048, description: 'ATL CopyArtifacts (inline)', inline: true },
  { name: 'atl-tagger', logicalId: 'TaggerFunction', role: 'TaggerFunctionRole', timeout: 60, memory: 256, description: 'ATL realtime tagger (PlatformTrail=enabled)', condition: 'TrailEnabled' },
];

/** Environment of every function (names = PLATFORM_ENV_VARS of platform/api/src/runtime/env.ts, plus a few extras). */
export function functionEnvironment(): Json {
  return {
    ATL_ACCOUNT_ID: { Ref: 'AWS::AccountId' },
    ATL_TABLE: { Ref: 'AtlMainTable' },
    ATL_LOCKS_TABLE: { Ref: 'LabLockTable' },
    ATL_WEB_BUCKET: { Ref: 'WebBucket' },
    ATL_DATA_BUCKET: { Ref: 'DataBucket' },
    ATL_ARTIFACTS_BUCKET: { Ref: 'ArtifactsBucket' },
    ATL_LAB_STATE_BUCKET: { Ref: 'LabStateBucket' },
    ATL_USER_POOL_ID: { Ref: 'UserPool' },
    ATL_WEB_CLIENT_ID: { Ref: 'WebClient' },
    ATL_SIGNING_KEY_ID: { Ref: 'CertSigningKey' },
    ATL_SCHEDULER_ROLE_ARN: { 'Fn::GetAtt': ['SchedulerRole', 'Arn'] },
    ATL_TIMER_FUNCTION_ARN: { 'Fn::Sub': 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:atl-timer' },
    ATL_TIMER_DLQ_ARN: { 'Fn::GetAtt': ['TimerDlq', 'Arn'] },
    ATL_PLATFORM_VERSION: '@@ATL_VERSION@@',
    // extras (not read by the scaffold's loadPlatformEnv yet; documented in docs/implementation-notes.md, platform-infra)
    ATL_RELEASE: { Ref: 'ReleaseVersion' },
    ATL_HTTP_API_ID: { Ref: 'HttpApi' },
    ATL_AGENT_API_ENDPOINT: { 'Fn::Sub': 'https://${HttpApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}' },
    ATL_PLATFORM_URL: {
      'Fn::If': ['HasCustomDomain', { 'Fn::Sub': 'https://${CustomDomainName}' }, { 'Fn::Sub': 'https://${WebDistribution.DomainName}' }],
    },
    ATL_DISTRIBUTION_ID: { Ref: 'WebDistribution' },
    // atl-checks pins the check bundle it asks ATL-RunCheck to run (04 §6.2; platform-checks #3, platform-integration)
    ATL_CHECK_BUNDLE_DIGEST: { 'Fn::GetAtt': ['CopyArtifacts', 'ChecksBundleDigest'] },
    ATL_STACK_NAME: { Ref: 'AWS::StackName' },
    ATL_INSTALLATION_ID: { 'Fn::Select': [2, { 'Fn::Split': ['/', { Ref: 'AWS::StackId' }] }] },
    ATL_TERMINAL_RECORDING: { Ref: 'TerminalRecording' },
    NODE_OPTIONS: '--enable-source-maps',
  };
}

const PLATFORM_TAGS = [
  { Key: 'atl:component', Value: 'platform' },
  { Key: 'Project', Value: 'ATL' },
];

/** Wrap every string that contains `${…}` in Fn::Sub (install-time values of a generated policy document). */
function subStrings(v: unknown): unknown {
  if (typeof v === 'string') return v.includes('${') ? { 'Fn::Sub': v } : v;
  if (Array.isArray(v)) return v.map(subStrings);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subStrings(x)]));
  return v;
}

/**
 * `ATLProvisionerPolicy-RunnerSession` (platform-lifecycle #10): the session-independent statements of the runner's session
 * policy, passed with `--policy-arns` when the runner assumes ATLProvisionerRole (the inline session policy is limited to
 * 2 048 characters). Not attached to any role: as a session policy it only narrows the role's own permissions.
 */
export function runnerSessionPolicyResource(): Json {
  const statements = staticRunnerStatements({ region: '${AWS::Region}', accountId: '${AWS::AccountId}', apiId: '${HttpApi}' });
  return {
    ProvisionerPolicyRunnerSession: {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: {
        ManagedPolicyName: RUNNER_SESSION_STATIC_POLICY,
        Description: 'ATL runner session policy (session-independent part; passed as PolicyArns of atl-<sid>-prov-<op>)',
        PolicyDocument: subStrings({ Version: '2012-10-17', Statement: statements }),
      },
    },
  };
}

export function copyArtifactsInlineCode(): string {
  const src = fs.readFileSync(path.join(INFRA_DIR, 'custom-resources', 'copy-artifacts.cjs'), 'utf8');
  return transformSync(src, { minify: true, format: 'cjs', platform: 'node', target: 'node22', legalComments: 'none' }).code;
}

/** Inline code size limit we hold ourselves to (the historical ZipFile limit; the current one is larger, 01 §4.5). */
export const INLINE_CODE_MAX_CHARS = 4096;

export function functionResources(): Json {
  const out: Json = {};
  for (const f of FUNCTION_DEFS) {
    const logGroupId = `${f.logicalId}LogGroup`;
    const cond = f.condition ? { Condition: f.condition } : {};
    out[logGroupId] = {
      Type: 'AWS::Logs::LogGroup',
      ...cond,
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
      Properties: { LogGroupName: `/aws/lambda/${f.name}`, RetentionInDays: { Ref: 'LogRetentionDays' }, Tags: PLATFORM_TAGS },
    };
    const code = f.inline
      ? { ZipFile: copyArtifactsInlineCode() }
      : {
          S3Bucket: { Ref: 'ArtifactsBucket' },
          S3Key: { 'Fn::Sub': 'releases/${ReleaseVersion}/atl-lambdas.zip' },
          S3ObjectVersion: { 'Fn::GetAtt': ['CopyArtifacts', 'LambdasObjectVersion'] },
        };
    out[f.logicalId] = {
      Type: 'AWS::Lambda::Function',
      ...cond,
      ...(f.dependsOn?.length ? { DependsOn: f.dependsOn } : {}),
      Properties: {
        FunctionName: f.name,
        Description: f.description,
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        // every function ships in atl-lambdas.zip as <name>/index.mjs (01 §4.5); copy-artifacts is inline (index.js)
        Handler: f.inline ? 'index.handler' : `${f.name}/index.handler`,
        Code: code,
        Role: { 'Fn::GetAtt': [f.role, 'Arn'] },
        Timeout: f.timeout,
        MemorySize: f.memory,
        ...(f.inline ? {} : { Environment: { Variables: functionEnvironment() } }),
        LoggingConfig: { LogFormat: 'JSON', LogGroup: { Ref: logGroupId } },
        Tags: PLATFORM_TAGS,
      },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// State machines

export const STATE_MACHINE_LOGICAL_IDS: Readonly<Record<StateMachineName, string>> = {
  'atl-session-start': 'SessionStartStateMachine',
  'atl-session-end': 'SessionEndStateMachine',
  'atl-reclaim': 'ReclaimStateMachine',
  'atl-reclaim-rescan': 'ReclaimRescanStateMachine',
  'atl-module-op': 'ModuleOpStateMachine',
  'atl-platform-uninstall': 'PlatformUninstallStateMachine',
};

const FUNCTION_LOGICAL_IDS: Record<string, string> = Object.fromEntries(FUNCTION_DEFS.map((f) => [f.name, f.logicalId]));

/** Production values of resources the ASL may reference by placeholder name (beyond functions and state machines). */
export const KNOWN_SUBSTITUTIONS: Readonly<Record<string, unknown>> = {
  RunnerProject: 'atl-runner',
  EventBus: 'atl-events',
  Table: { Ref: 'AtlMainTable' },
  TableName: { Ref: 'AtlMainTable' },
  DataBucket: { Ref: 'DataBucket' },
  ArtifactsBucket: { Ref: 'ArtifactsBucket' },
  WebBucket: { Ref: 'WebBucket' },
  LabStateBucket: { Ref: 'LabStateBucket' },
  LockTable: { Ref: 'LabLockTable' },
  NotifyTopicArn: { Ref: 'NotifyTopic' },
  AlertsTopicArn: { Ref: 'AlertsTopic' },
  ProvisionerRoleArn: { 'Fn::GetAtt': ['ProvisionerRole', 'Arn'] },
  Region: { Ref: 'AWS::Region' },
  AccountId: { Ref: 'AWS::AccountId' },
};

/**
 * Map one DEV_SUBSTITUTIONS entry to its production value: a dev value naming a Lambda function → that function's ARN; a
 * state machine ARN → the same state machine in this account and region; a known key → KNOWN_SUBSTITUTIONS. Anything else is
 * an error, so a new placeholder in the ASL cannot reach production unmapped.
 */
export function productionSubstitution(key: string, devValue: string): unknown {
  if (devValue in FUNCTION_LOGICAL_IDS) return { 'Fn::GetAtt': [FUNCTION_LOGICAL_IDS[devValue], 'Arn'] };
  const sm = /:stateMachine:(atl-[a-z-]+)$/.exec(devValue);
  if (sm && (STATE_MACHINES as readonly string[]).includes(sm[1]!)) {
    return { 'Fn::Sub': `arn:\${AWS::Partition}:states:\${AWS::Region}:\${AWS::AccountId}:stateMachine:${sm[1]}` };
  }
  if (key in KNOWN_SUBSTITUTIONS) return KNOWN_SUBSTITUTIONS[key];
  throw new Error(`DefinitionSubstitutions: no production value for \${${key}} (dev value ${devValue}); add it to KNOWN_SUBSTITUTIONS in platform/infra/build/template-parts.ts`);
}

/** The placeholder table shared with the dev orchestrator (platform/workflows/src/asl/load.ts). */
export function loadDevSubstitutions(): Record<string, string> {
  return { ...DEV_SUBSTITUTIONS };
}

export function placeholdersIn(definition: unknown): string[] {
  const found = new Set<string>();
  JSON.stringify(definition).replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    found.add(name);
    return '';
  });
  return [...found].sort();
}

export function stateMachineResources(devSubstitutions: Record<string, string>, dir: string = STATEMACHINES_DIR): Json {
  const substitutions = Object.fromEntries(Object.entries(devSubstitutions).map(([k, v]) => [k, productionSubstitution(k, v)]));
  const out: Json = {};
  for (const name of STATE_MACHINES) {
    const logicalId = STATE_MACHINE_LOGICAL_IDS[name];
    const definition = JSON.parse(fs.readFileSync(path.join(dir, `${name}.asl.json`), 'utf8')) as Json;
    const used = placeholdersIn(definition);
    const missing = used.filter((p) => !(p in substitutions));
    if (missing.length) throw new Error(`${name}.asl.json uses placeholders without a substitution: ${missing.join(', ')} (add them to DEV_SUBSTITUTIONS)`);
    out[`${logicalId}LogGroup`] = {
      Type: 'AWS::Logs::LogGroup',
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
      Properties: { LogGroupName: `/aws/vendedlogs/states/${name}`, RetentionInDays: { Ref: 'LogRetentionDays' }, Tags: PLATFORM_TAGS },
    };
    out[logicalId] = {
      Type: 'AWS::StepFunctions::StateMachine',
      Properties: {
        StateMachineName: name,
        StateMachineType: 'STANDARD',
        RoleArn: { 'Fn::GetAtt': ['OrchestratorRole', 'Arn'] },
        Definition: definition,
        ...(used.length ? { DefinitionSubstitutions: Object.fromEntries(used.map((p) => [p, substitutions[p]])) } : {}),
        LoggingConfiguration: {
          Level: 'ERROR',
          IncludeExecutionData: false,
          Destinations: [{ CloudWatchLogsLogGroup: { LogGroupArn: { 'Fn::GetAtt': [`${logicalId}LogGroup`, 'Arn'] } } }],
        },
        TracingConfiguration: { Enabled: false },
        Tags: PLATFORM_TAGS,
      },
    };
  }
  return out;
}

export function ec2TrustPolicy(withSourceAccount: boolean): Json {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ec2.amazonaws.com' },
        Action: 'sts:AssumeRole',
        ...(withSourceAccount ? { Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } } } : {}),
      },
    ],
  };
}

export function allFunctionNamesCovered(): string[] {
  const covered = new Set(FUNCTION_DEFS.map((f) => f.name));
  return LAMBDA_FUNCTIONS.filter((n) => !covered.has(n));
}
