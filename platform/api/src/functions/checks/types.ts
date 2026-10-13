/**
 * Check definitions, results and evidence — 04 §5 (normative TypeScript of §5.1, §5.3, §5.4, §5.5), §6.5, §8.2.
 *
 * Content (`labs/<card>/checks/*.yaml`, expanded by `labs:build` into `content/<catalogVersion>/labs/<labId>.json`)
 * is read with these types; `atl-checks` never trusts it blindly: every executor validates what it needs.
 */
import type { CheckSource, CheckRunTrigger, LabV2 } from '@atl/shared';

// ---------------------------------------------------------------------------------------------------------------
// Check definitions (04 §5.1)

export const CHECK_TYPES = ['local', 'capability', 'http-header', 'aws-readonly', 'experiment', 'manual'] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

/** Verdict source by type (04 §5.1: derived, never hand-written). */
export const SOURCE_OF_TYPE: Readonly<Record<CheckType, CheckSource>> = {
  local: 'LOCAL',
  'http-header': 'LOCAL',
  capability: 'PROBE',
  'aws-readonly': 'AWS',
  experiment: 'EXP',
  manual: 'MANUAL',
};

export const ASSERT_OPS = [
  'eq',
  'neq',
  'in',
  'nin',
  'exists',
  'absent',
  'contains',
  'icontains',
  'startsWith',
  'endsWith',
  'matches',
  'gt',
  'gte',
  'lt',
  'lte',
  'len_eq',
  'len_gte',
  'len_lte',
  'every',
  'some',
  'healthy',
] as const;
export type AssertOp = (typeof ASSERT_OPS)[number];

export interface Assertion {
  path: string;
  where?: Record<string, unknown>;
  op: AssertOp;
  value?: unknown;
  label?: string;
  severity?: 'error' | 'warn';
}

export interface DriftSpec {
  policy: 'must-hold' | 'once';
  monitor?: boolean;
}

export type BuiltinCorroborator = 'ip-in-aws-ranges' | 'tls-san' | 'fresh-nonce';

export type Corroboration =
  | { id: string; via: 'local'; checkId: string; args?: Record<string, unknown>; assert: Assertion[]; required?: boolean; on?: 'lab' | 'workstation' }
  | { id: string; via: 'aws-readonly'; service: string; action: string; params: Record<string, unknown>; assert: Assertion[]; required?: boolean; region?: AwsRegionSel }
  | { id: string; via: 'builtin'; name: BuiltinCorroborator; args: Record<string, unknown>; assert?: Assertion[]; required?: boolean };

export interface ManualSpec {
  where?: Record<string, unknown>;
  confirm?: string;
  observed?: { question: string; options?: { value: string; label: string; expected?: boolean; fixHint?: string }[] };
  input?: Record<string, unknown>;
  evidence?: { command?: { run: string; runsOn: 'workstation' | 'lab' }; parse?: 'json'; assert?: Assertion[] };
}

interface CheckBase {
  id: string;
  extends?: string;
  title: string;
  type: CheckType;
  required?: boolean;
  when?: string;
  dependsOn?: string[];
  timeoutMs?: number;
  retry?: { max: number; backoffMs: number[] };
  wait?: { typicalMinutes: number; maxMinutes: number };
  pendingIf?: Assertion[];
  anyOf?: Assertion[][];
  ttl?: string;
  drift?: DriftSpec;
  corroborate?: Corroboration[];
  evidence?: { keep?: string[]; redact?: string[] };
  explain?: string;
  reproduce?: { run: string; runsOn: 'workstation' | 'lab' };
  pitfalls?: string[];
  saaDomain?: 'secure' | 'resilient' | 'performance' | 'cost';
}

export interface LocalCheck extends CheckBase {
  type: 'local';
  on?: 'lab' | 'workstation';
  instances?: 'one' | 'all';
  checkId: string;
  args?: Record<string, unknown>;
  assert: Assertion[];
}

export interface CapabilityCheck extends CheckBase {
  type: 'capability';
  module: string;
  view?: 'public' | 'admin';
  expectedWarnings?: string[];
  assert: Assertion[];
}

export const HTTP_TARGETS = [
  'cdn',
  'cdn-alias',
  'public-ip',
  'public-dns',
  'alb',
  'apigw',
  'app-entry',
  'tls-domain',
  's3-object',
  'self',
  'origin-private',
  'cdn-origin',
] as const;
export type HttpTarget = (typeof HTTP_TARGETS)[number];
/** Targets a platform probe may use (04 §5.2.3 table). */
export const PLATFORM_TARGETS: readonly HttpTarget[] = ['cdn', 'cdn-alias', 'public-ip', 'public-dns', 'alb', 'apigw', 'app-entry', 'tls-domain', 's3-object'];
/** Targets that only exist on the lab instance. */
export const LAB_ONLY_TARGETS: readonly HttpTarget[] = ['self', 'origin-private', 'cdn-origin'];

export type HttpHeaderName = 'Accept' | 'Accept-Encoding' | 'X-Compare-Bypass' | 'Authorization' | 'Cookie';

export interface HttpHeaderCheck extends CheckBase {
  type: 'http-header';
  from: 'platform' | 'lab' | 'browser';
  target: HttpTarget;
  path: string;
  method?: 'GET' | 'HEAD';
  headers?: Partial<Record<HttpHeaderName, string>>;
  repeat?: number;
  intervalMs?: number;
  stripQuery?: boolean;
  assert: Assertion[];
}

export type AwsRegionSel = 'app' | 'us-east-1' | 'global' | 'dr-region';

export interface OwnershipRule {
  resource: string;
  resourceId?: string;
  createEvents?: string[];
  mode: 'session' | 'session-or-start';
  createdAfter?: 'session.readyAt' | 'step.startedAt';
  maxWaitMinutes?: number;
}

export interface AwsReadonlyCheck extends CheckBase {
  type: 'aws-readonly';
  service: string;
  action: string;
  region?: AwsRegionSel;
  params: Record<string, unknown>;
  paginate?: { maxPages: number };
  ownership?: OwnershipRule;
  assert?: Assertion[];
  expectError?: string;
  manualFallback: ManualSpec;
}

export interface ExperimentCheck extends CheckBase {
  type: 'experiment';
  module: string;
  experiment: string;
  label?: string;
  pair?: [string, string] | 'any';
  accept?: ('valid' | 'simulated')[];
}

export interface ManualCheck extends CheckBase {
  type: 'manual';
  spec: ManualSpec;
}

export type CheckDecl = LocalCheck | CapabilityCheck | HttpHeaderCheck | AwsReadonlyCheck | ExperimentCheck | ManualCheck;

/** Common pitfall (ui-design §5.3 structure, taken over by 04). */
export interface Pitfall {
  id: string;
  title?: string;
  /** Matches when every listed check of the run has the given result / error code / failing assertion label. */
  match?: { checkId?: string; result?: string; errorCode?: string; assertionLabel?: string }[];
  cause?: string;
  fix?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Content release (expanded card) consumed at run time (04 §2.5: `labs/<cardId>.json`)

/**
 * The expanded card written by `labs:build` to `content/<catalogVersion>/labs/<labId>.json` (04 §2.5). `checks` holds every
 * check the card uses, keyed by its local id (own checks, `as` aliases, shared checks and `<cardId>/<checkId>` references
 * already expanded). The engine only reads the fields listed here.
 */
export interface CardBuild {
  schema: 'atl.card/v1';
  lab: LabV2;
  checks: Record<string, CheckDecl>;
  /** Source of a referenced check (`guide:…`, `<cardId>/<checkId>`, `_shared/<id>`) by local id. */
  sources?: Record<string, string>;
  /** SHA-256 of each expanded check definition (`checkHash`, 04 §5.5), by local id; computed when missing. */
  checkHashes?: Record<string, string>;
  pitfalls?: Record<string, Pitfall>;
  contentDigest?: string;
  catalogVersion?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Results (04 §5.3 “结果取值”, §5.6 error codes)

export const CHECK_RESULTS = ['pass', 'fail', 'pending', 'error', 'unavailable', 'skipped', 'not_run'] as const;
export type CheckResultValue = (typeof CHECK_RESULTS)[number];
/** Effective result (§8.2) additionally knows manual confirmations and `needs_manual`. */
export type EffectiveResult = CheckResultValue | 'manual' | 'manual_evidence' | 'needs_manual';

export const CHECK_ERROR_CODES = [
  'TIMEOUT',
  'THROTTLED',
  'NETWORK',
  'ACCESS_DENIED',
  'NOT_ALLOWED',
  'NOT_FOUND_VAR',
  'TARGET_UNRESOLVED',
  'CHANNEL_DOWN',
  'EXPECTED_OUTAGE',
  'TARGET_AMBIGUOUS',
  'RUNNER_INTEGRITY',
  'RUNNER_UNAVAILABLE',
  'OWNERSHIP_PENDING',
  'OWNERSHIP_MISMATCH',
  'CORROBORATION_FAILED',
  'SPOOF_SUSPECTED',
  'WAIT_TIMEOUT',
  'PRECONDITION',
  'SESSION_NOT_RUNNING',
  'INTERNAL',
] as const;
export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];

/** Transient codes that are retried (04 §5.6). */
export const TRANSIENT_CODES: readonly CheckErrorCode[] = ['THROTTLED', 'NETWORK', 'TIMEOUT'];

export type Trust = 'high' | 'medium' | 'low';

export interface AssertionOutcome {
  label?: string;
  path: string;
  op: AssertOp;
  expected?: unknown;
  actual?: unknown;
  ok: boolean;
  severity: 'error' | 'warn';
  note?: string;
}

export interface CorroborationOutcome {
  id: string;
  via: Corroboration['via'];
  ok: boolean;
  required: boolean;
  observed?: unknown;
  assertions?: AssertionOutcome[];
  errorCode?: CheckErrorCode;
}

export interface OwnershipOutcome {
  basis: 'stack' | 'ledger' | 'parent' | 'lookup' | null;
  pending: boolean;
  resource?: string;
  lookups?: number;
  detail?: string;
  retryAfterSeconds?: number;
  provenance?: Provenance;
}

export type Provenance = 'this-session' | `inherited:${string}`;

export interface Executor {
  kind: 'lambda';
  function: 'atl-checks';
  role?: 'ATLVerifierRole';
  ssm?: { commandId: string; instanceId: string; documentVersion?: string }[];
}

/** `atl.evidence/v1` (04 §5.5). */
export interface EvidenceEnvelope {
  schema: 'atl.evidence/v1';
  checkKey: string;
  checkHash: string;
  content: { labId: string; labVersion: string; contentDigest: string; origin: 'lab' | 'guide' | 'shared' | 'card'; variant: string };
  sessionId: string;
  checkRunId: string;
  executor: Executor;
  startedAt: string;
  finishedAt: string;
  result: CheckResultValue;
  errorCode: CheckErrorCode | null;
  trust: Trust;
  observed: unknown;
  assertions: AssertionOutcome[];
  corroboration: CorroborationOutcome[];
  pitfalls: string[];
  redactions: string[];
  ownership?: OwnershipOutcome;
  expectedWarningsHit?: string[];
  instances?: { instanceId: string; az?: string }[];
  nonce?: string;
  digest: string;
}

/** One item of `CheckRun.results[]` (01 §7.3; 04 §12.1). */
export interface CheckResultItem {
  checkKey: string;
  checkId: string;
  stepId: string | null;
  source: CheckSource;
  type: CheckType;
  result: CheckResultValue;
  required: boolean;
  trust: Trust;
  error: { code: CheckErrorCode; message?: string } | null;
  /** Redacted envelope when ≤ 4 KB, otherwise null and `evidenceKey` points at `atl-data/evidence/…`. */
  evidence: EvidenceEnvelope | null;
  evidenceKey?: string;
  evidenceDigest: string;
  corroboration: CorroborationOutcome[];
  ownership?: OwnershipOutcome;
  provenance?: Provenance;
  expectedWarningsHit?: string[];
  executor: Executor;
  at: string;
  instanceIds?: string[];
  /** Key assertions for reports (label, expected, actual, ok). */
  keyAssertions: { label: string; expected: unknown; actual: unknown; ok: boolean }[];
  drift?: DriftSpec;
  pitfalls?: string[];
  /** Experiment check satisfied by a result still in cross-check (badge pending, 04 §8.4 rule 6). */
  pendingCrosscheck?: boolean;
  /** Experiment check satisfied by a simulated baseline (weight 0.8). */
  simulated?: boolean;
}

export type CheckRunScope = 'step' | 'lab' | 'final-preview' | 'final' | 'gate' | 'cleanup' | 'checks';
export type CheckRunStatus = 'queued' | 'running' | 'done';

export interface CheckRunItem {
  type: 'CheckRun';
  runId: string;
  sessionId: string;
  stepId: string | null;
  scope: CheckRunScope;
  trigger: CheckRunTrigger;
  requestedBy: string;
  force: boolean;
  checkIds?: string[];
  status: CheckRunStatus;
  startedAt?: string;
  finishedAt?: string;
  results: CheckResultItem[];
  summary?: Record<string, number>;
  ver: number;
  createdAt: string;
  updatedAt: string;
}
