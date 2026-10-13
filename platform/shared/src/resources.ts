/**
 * Named platform resources — 01 §3.6–§3.11, §4.3 and the name-table rows “SSM”, “栈”, “桶与表”, “CloudFront”,
 * “通知与队列”, “工作台”, “CloudAlbum 侧接口名”, “安装参数”.
 */
import { assertSid, isEnvName, STACK_ID_RE } from './ids.js';

// ---------------------------------------------------------------------------------------------------------------
// Stacks

export const PLATFORM_STACK = 'atl';

function envName(e: string): string {
  if (!isEnvName(e)) throw new TypeError(`invalid envName: ${e}`);
  return e;
}

export const StackNames = {
  platform: () => PLATFORM_STACK,
  workstation: (sid: string) => `atl-ws-${assertSid(sid)}`,
  module: (env: string, moduleId: string) => `cloudalbum-${envName(env)}-${moduleId}`,
  base: (env: string) => `cloudalbum-${envName(env)}-ec2`,
  toolchain: (env: string) => `cloudalbum-${envName(env)}-toolchain`,
  wafEdge: (env: string) => `cloudalbum-${envName(env)}-waf-edge`,
  tlsEdge: (env: string) => `cloudalbum-${envName(env)}-tls-edge`,
  cardStack: (env: string, stackId: string) => {
    if (!STACK_ID_RE.test(stackId)) throw new TypeError(`invalid stackId: ${stackId}`);
    return `cloudalbum-${envName(env)}-x-${stackId}`;
  },
} as const;

export const DEPRECATED_STACK_PATTERNS = ['cloudalbum-lab-*', 'atl-ws-<envName>', 'atl-<envName>-<cardId>-<stackId>'] as const;

/** Session key pair and keys-mode demo user (01 §3.9). */
export const keyPairName = (env: string) => `cloudalbum-${envName(env)}-key`;
export const demoKeysUserName = (env: string) => `cloudalbum-${envName(env)}-demo-keys`;
export const DEMO_KEYS_USER_PATH = '/cloudalbum/';

// ---------------------------------------------------------------------------------------------------------------
// Buckets and tables

export const BucketNames = {
  web: (acct: string, region: string) => `atl-web-${acct}-${region}`,
  artifacts: (acct: string, region: string) => `atl-artifacts-${acct}-${region}`,
  data: (acct: string, region: string) => `atl-data-${acct}-${region}`,
  trail: (acct: string, region: string) => `atl-trail-${acct}-${region}`,
  labState: (acct: string, region: string) => `cloudalbum-lab-state-${acct}-${region}`,
  toolchain: (env: string, acct: string, region: string) => `cloudalbum-${envName(env)}-toolchain-${acct}-${region}`,
} as const;

/** `s3://cloudalbum-lab-state-<acct>-<region>/<envName>/state.json` (= Environment.stateUri). */
export function stateUri(acct: string, region: string, env: string): string {
  return `s3://${BucketNames.labState(acct, region)}/${envName(env)}/state.json`;
}

/** Key prefixes in `atl-data` (01 §3.7). */
export const DataKeys = {
  report: (sid: string) => `reports/${assertSid(sid)}/`,
  experiment: (sid: string, runId: string) => `experiments/${assertSid(sid)}/${runId}.json`,
  evidence: (sid: string, runId: string, checkKey: string) => `evidence/${assertSid(sid)}/${runId}/${checkKey}.json`,
  run: (runId: string) => `runs/${runId}/`,
  runResult: (runId: string) => `runs/${runId}/result.json`,
  archive: (sid: string) => `archive/${assertSid(sid)}/`,
  exports: 'exports/',
} as const;

/** Prefixes in `atl-web` (01 §3.7). */
export const WebKeys = {
  content: (catalogVersion: string) => `content/${catalogVersion}/`,
  profile: (catalogVersion: string, cardId: string, variant: string) => `content/${catalogVersion}/profiles/atl/${cardId}/${variant}.env`,
  cardStackTemplate: (catalogVersion: string, cardId: string, stackId: string) => `content/${catalogVersion}/stacks/${cardId}/${stackId}.yaml`,
  jwks: '.well-known/atl/jwks.json',
  revocations: 'public/revocations.jws',
  publicCert: (certId: string) => `public/certs/${certId}.jws`,
  share: (shareId: string) => `share/${shareId}/`,
  cloudshellKit: (ver: string) => `kit/cloudshell/${ver}/`,
  verify: 'verify/',
} as const;

// ---------------------------------------------------------------------------------------------------------------
// SSM

export const SSM_DOCUMENTS = ['ATL-RunCheck', 'ATL-SessionShell', 'ATL-SessionShell-Logged', 'ATL-PrepareInstance', 'ATL-WorkstationSetup'] as const;
export type SsmDocumentName = (typeof SSM_DOCUMENTS)[number];
export const DEPRECATED_SSM_DOCUMENTS = ['ATL-Shell', 'ATL-Shell-NoLog'] as const;
/** ATL-RunCheck parameters (all `interpolationType: ENV_VAR`, delivered as `SSM_<name>`; 04 §6.1). */
export const RUN_CHECK_PARAMETERS = ['CheckId', 'ArgsB64', 'RunToken', 'SessionId', 'BundleDigest', 'TimeoutSec'] as const;
/** allowedPattern of each ATL-RunCheck parameter (04 §6.1). */
export const RUN_CHECK_PARAMETER_PATTERNS: Readonly<Record<(typeof RUN_CHECK_PARAMETERS)[number], RegExp>> = {
  CheckId: /^(batch|[a-z][a-z0-9-]{1,31}(\.[a-z][a-z0-9-]{1,31})?)$/,
  ArgsB64: /^[A-Za-z0-9_-]{2,6000}$/,
  RunToken: /^[A-Za-z0-9_-]{22,64}$/,
  SessionId: /^s[0-9a-hjkmnp-tv-z]{12}$/,
  BundleDigest: /^[a-f0-9]{64}$/,
  TimeoutSec: /^([1-9]|[1-7][0-9]|80)$/,
};
/** ATL-WorkstationSetup parameters (03 §4.6). */
export const WORKSTATION_SETUP_PARAMETERS = ['SessionId', 'Region', 'AgentApiEndpoint', 'PlatformOrigin'] as const;
/** Result line printed by `/opt/atl/bin/atl-check` (04 §6.5). */
export const RUN_CHECK_RESULT_PREFIX = 'ATL-RESULT-V1 ';
export const STATE_MANAGER_ASSOCIATION = 'atl-prepare-instance';

export const SsmParams = {
  appAdminPassword: (env: string) => `/cloudalbum/${envName(env)}/atl/app-admin-password`,
  sshKey: (env: string) => `/cloudalbum/${envName(env)}/atl/ssh-key`,
  testUsers: (env: string) => `/cloudalbum/${envName(env)}/atl/test-users`,
  demoKeys: (env: string) => `/cloudalbum/${envName(env)}/iam/demo-keys`,
  /** Platform-level non-secret values only (01 §3.6 hard constraint). */
  platformPrefix: '/atl/',
  installationId: '/atl/installation-id',
} as const;

export const TERMINAL_RECORDING_LOG_GROUP = '/atl-recordings/terminal-sessions';
export const RUNNER_LOG_GROUP = '/aws/codebuild/atl-runner';

// ---------------------------------------------------------------------------------------------------------------
// Events, notifications, CloudFront, KMS, Cognito

export const SNS_TOPICS = ['atl-notify', 'atl-alerts', 'atl-budget'] as const;
export const SQS_QUEUES = ['atl-timer-dlq'] as const;
export const BUDGET_NAME = 'atl-platform-guard';
export const ACCESS_ANALYZER_NAME = 'atl-external-access';
export const EVENT_RULES = ['atl-sfn-failed', 'atl-tagger-api-calls'] as const;
export const TRAIL_NAME = 'atl-trail';
export const CLOUDFRONT_DISTRIBUTION = 'atl-web';
export const CLOUDFRONT_FUNCTION = 'atl-spa-rewrite';
export const RESPONSE_HEADERS_POLICIES = ['atl-web-spa', 'atl-web-verify', 'atl-web-share'] as const;
export const KMS_SIGNING_ALIAS = 'alias/atl-certificates';

// ---------------------------------------------------------------------------------------------------------------
// Workstation (03 §4.6, name-table row “工作台”)

export const WORKSTATION = {
  osUser: 'labuser',
  sessionJson: '~/.atl/session.json',
  sessionEnv: '/etc/atl/session.env',
  profileScript: '/etc/profile.d/atl.sh',
  credentialsHelper: '/opt/atl/bin/atl-credentials',
  setupScript: '/opt/atl/bin/atl-workstation-setup.sh',
  agentCall: '/opt/atl/bin/atl-agent-call',
  labProxy: '/opt/atl/bin/atl-lab-proxy',
  readyFile: '/var/lib/atl/ready.json',
  preparedFile: '/var/lib/atl/prepared.json',
  checkEntry: '/opt/atl/bin/atl-check',
  checkBundleDir: (digest: string) => `/opt/atl/checks/${digest}/`,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// CloudAlbum-side interface names (01 §9, 06)

export const CLOUDALBUM_PLATFORM_ENV = {
  mode: 'ATL_PLATFORM_MODE',
  sessionId: 'ATL_SESSION_ID',
  envId: 'ATL_ENV_ID',
  envName: 'ATL_ENV_NAME',
  labId: 'ATL_LAB_ID',
  platformOrigin: 'ATL_PLATFORM_ORIGIN',
  probeTokenFile: 'ATL_PROBE_TOKEN_FILE',
} as const;
export const CLOUDALBUM_PLATFORM_ENV_FILE = '/etc/cloudalbum/platform.env';
export const PROBE_TOKEN_HEADER = 'X-ATL-Probe-Token';
export const EXPERIMENT_RUN_HEADER = 'X-Experiment-Run';
export const PROBE_PRINCIPAL = 'atl-probe';
export const PROBE_ENDPOINT_PREFIX = '/api/lab/probe/';
export const BUILTIN_CHECK_ALIASES = ['atl.capabilities', 'atl.lab-metrics'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Install parameters (01 §4.3)

export const INSTALL_PARAMETERS = [
  'LearnerEmail',
  'AssistantEmails',
  'MfaMode',
  'ReleaseVersion',
  'ArtifactSource',
  'ArtifactBaseUrl',
  'MaxSessionMinutes',
  'ExtensionMinutes',
  'MaxExtensions',
  'MaxKeepHours',
  'EnvMaxAgeDays',
  'ReadyIdleMinutes',
  'AllowedInstanceTypes',
  'AllowedDbClasses',
  'AllowedCacheNodeTypes',
  'AsgMaxSizeLimit',
  'MaxEbsVolumeGiB',
  'MaxDbStorageGiB',
  'DrRegion',
  'WorkstationInstanceType',
  'NotificationEmail',
  'CustomDomainName',
  'CustomDomainCertificateArn',
  'ExistingWebAclArn',
  'PriceClass',
  'PlatformTrail',
  'TerminalRecording',
  'ExternalAccessAnalyzer',
  'MonthlyBudgetAmount',
  'BudgetEnforcement',
  'EnablePitr',
  'LogRetentionDays',
  'RunnerTimeoutMinutes',
  'KeyPendingWindowDays',
] as const;
export const DEPRECATED_INSTALL_PARAMETERS = ['DefaultSessionMinutes', 'ReminderMinutes', 'BudgetAlertEmail'] as const;

/** Defaults of the install parameters that the platform logic needs (01 §4.3). */
export const INSTALL_DEFAULTS = {
  MaxSessionMinutes: 360,
  ExtensionMinutes: 30,
  MaxExtensions: 2,
  MaxKeepHours: 24,
  KeepHardMaxHours: 72,
  EnvMaxAgeDays: 7,
  ReadyIdleMinutes: 60,
  AsgMaxSizeLimit: 4,
  DrRegion: 'ap-northeast-3',
  WorkstationInstanceType: 't4g.small',
  LogRetentionDays: 30,
  RunnerTimeoutMinutes: 120,
} as const;
