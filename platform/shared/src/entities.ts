/**
 * Entities of the single table `atl-main` and their shared enums — 01 §7.2, §7.3 (name-table rows “实体”, “关键字段”,
 * “SessionResource 枚举”, “检查来源”).
 *
 * Only the cross-document fields are typed here; full entity schemas live with the API implementation
 * (`platform/api/contracts/entities/*.schema.json`).
 */
import type { EndReason, SessionState } from './session-states.js';

export const ENTITY_TYPES = [
  'PlatformConfig',
  'SchemaVersion',
  'ActiveEnvironmentLock',
  'RateBucket',
  'CatalogRelease',
  'PriceCache',
  'CostQuote',
  'Learner',
  'Member',
  'LabProgress',
  'QuizAttempt',
  'LabSession',
  'SessionEvent',
  'StepResult',
  'CheckRun',
  'ManualConfirmation',
  'ExperimentRun',
  'ModuleOp',
  'RunnerRun',
  'CredentialGrant',
  'TerminalSession',
  'LabAttempt',
  'Report',
  'ReportShare',
  'Environment',
  'SessionResource',
  'ReclaimPass',
  'InventorySnapshot',
  'Certificate',
  'RevocationList',
  'SigningKey',
  'AuditEvent',
  'IdempotencyRecord',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Deprecated entity names → replacement (`null` = merged / removed). */
export const DEPRECATED_ENTITY_TYPES = {
  Session: 'LabSession',
  ActiveSessionLock: 'ActiveEnvironmentLock',
  PlatformSettings: 'PlatformConfig',
  ReclaimItem: 'SessionResource',
} as const;

/** Common attributes of every item (01 §7.1). */
export interface ItemBase {
  type: EntityType;
  /** Optimistic-lock version (integer). */
  ver: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------
// SessionResource (reclaim ledger)

export const CLEANUP_STATES = [
  'TRACKED',
  'DELETING',
  'DELETED',
  'RETAINED',
  'REVIEW',
  'MANUAL_REQUIRED',
  'RESOLVED_BY_LEARNER',
  'FAILED',
] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];
/** Only these cleanup states are projected into GSI2 (`RES#<cleanupState>`). */
export const GSI2_CLEANUP_STATES = ['MANUAL_REQUIRED', 'REVIEW', 'FAILED'] as const satisfies readonly CleanupState[];

export const RESOURCE_SEVERITIES = ['BLOCKING', 'REVIEW', 'INFO'] as const;
export type ResourceSeverity = (typeof RESOURCE_SEVERITIES)[number];

export const DISCOVERED_BY = [
  'STACK',
  'RETAINED',
  'OUT_OF_BAND',
  'CLOUDTRAIL',
  'DERIVED',
  'REALTIME',
  'OWNERSHIP_LOOKUP',
  'TAG',
  'INVENTORY',
] as const;
export type DiscoveredBy = (typeof DISCOVERED_BY)[number];

export const RESOURCE_CREATED_BY = ['provisioner', 'learner', 'app', 'service'] as const;
export type ResourceCreatedBy = (typeof RESOURCE_CREATED_BY)[number];

export const RESOURCE_BILLING = ['hourly', 'storage', 'monthly', 'usage', 'none'] as const;
export type ResourceBilling = (typeof RESOURCE_BILLING)[number];

export const RECLAIM_PASS_MODES = ['PRIMARY', 'RESCAN', 'RETRY', 'UNINSTALL'] as const;
export type ReclaimPassMode = (typeof RECLAIM_PASS_MODES)[number];

// ---------------------------------------------------------------------------------------------------------------
// Environment / lock / platform config

export const ENVIRONMENT_STATUSES = ['PROVISIONING', 'ACTIVE', 'KEPT', 'RELEASING', 'RELEASED', 'RELEASE_FAILED'] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export const PLATFORM_MODES = ['NORMAL', 'UNINSTALLING'] as const;
export type PlatformMode = (typeof PLATFORM_MODES)[number];

export const BUDGET_STATES = ['OK', 'WARN', 'EXCEEDED'] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

export const RESIDUAL_START_POLICIES = ['ack', 'block', 'ignore'] as const;

export interface ActiveEnvironmentLockItem {
  holderEnvId?: string | null;
  holderSessionId?: string | null;
  acquiredAt?: string | null;
  pendingSessionId?: string | null;
  pendingUntil?: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Checks, runs, credentials, quotes, module ops

/** Verdict sources (name table “检查来源”). */
export const CHECK_SOURCES = ['LOCAL', 'PROBE', 'AWS', 'EXP', 'MANUAL'] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

export const CHECK_RUN_TRIGGERS = [
  'user',
  'auto',
  'wait-poll',
  'module-op',
  'submit',
  'expiring-precheck',
  'finalize',
  'late-ownership',
] as const;
export type CheckRunTrigger = (typeof CHECK_RUN_TRIGGERS)[number];

/** Learner channels (01 §6.3); runner grants use `prov-<op>`. */
export const LEARNER_CHANNELS = ['console', 'term', 'ws'] as const;
export type LearnerChannel = (typeof LEARNER_CHANNELS)[number];
export type CredentialChannel = LearnerChannel | `prov-${string}`;

export const QUOTE_PURPOSES = ['START', 'REUSE', 'EXTEND', 'KEEP'] as const;
export type QuotePurpose = (typeof QUOTE_PURPOSES)[number];
/** `CostQuote.expiresAt` = issuedAt + 15 minutes. */
export const QUOTE_TTL_MINUTES = 15;

export const MODULE_OP_SOURCES = ['platform', 'agent', 'runner'] as const;
export const MODULE_OP_KINDS = ['enable', 'disable', 'profile-apply', 'status', 'set'] as const;

export const MANUAL_CONFIRMATION_KINDS = ['native', 'degraded'] as const;
export const MANUAL_CONFIRMATION_RESULTS = ['manual', 'manual_evidence'] as const;

export const EXPERIMENT_VALIDITY = ['valid', 'simulated', 'invalid', 'pending-crosscheck'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Progress, badges, certificates, audit

export const LAB_KINDS = ['service', 'scenario'] as const;
export const BADGE_LEVELS = ['verified', 'attested', 'self-reported'] as const;
export const BADGE_STATUSES = ['valid', 'pending', 'withdrawn'] as const;

export const CERTIFICATE_SCOPES = ['track', 'lab'] as const;
export const CERTIFICATE_STATUSES = ['valid', 'revoked'] as const;

export const AUDIT_VIA = ['web', 'agent', 'internal', 'system'] as const;
export const AUDIT_RESULTS = ['ok', 'denied', 'error'] as const;

// ---------------------------------------------------------------------------------------------------------------
// LabSession (cross-document fields only, 01 §7.3)

export const DISPOSITIONS = ['destroy', 'keep'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const WORKSTATION_MODES = ['ec2', 'cloudshell'] as const;
export type WorkstationMode = (typeof WORKSTATION_MODES)[number];
export const OUTAGE_CHANNELS = ['lab', 'workstation', 'both'] as const;
export type OutageChannel = (typeof OUTAGE_CHANNELS)[number];

export interface LabSessionKeep {
  until: string;
  version: number;
  saveMode: boolean;
  confirmedAt: string;
  quoteId: string;
}

export interface LabSessionFailure {
  code: string;
  phase: string;
  message: string;
  diagnostics: unknown[];
}

export interface OutageWindow {
  until: string;
  channel: OutageChannel;
  reason: string;
  stepId?: string;
  actionId?: string;
}

/** Cross-document view of `LabSession` (01 §7.3). Optional fields are filled as the session progresses. */
export interface LabSessionItem {
  sid: string;
  sub: string;
  labId: string;
  labKind: 'service' | 'scenario';
  variant: string;
  trackId?: string | null;
  catalogVersion: string;
  labVersion: string;
  platformVersion: string;
  envId?: string | null;
  reuseOfEnvId?: string | null;
  startProfile: string;
  startProfileDigest: string;
  startProfileResolved?: { name: string; digest: string; variant: string } | null;
  targetModules: { id: string; from: string | null; to: string }[];
  cardFacts: { platformActions: string[]; sshFromWorkstation: boolean; sshUser: string | null };
  outageWindow: OutageWindow | null;
  state: SessionState;
  stateReason?: string | null;
  stateEnteredAt: string;
  ver: number;
  phases?: { name: string; status: string; at: string; detail?: string }[];
  createdAt: string;
  readyAt?: string | null;
  runningAt?: string | null;
  deadlineAt?: string | null;
  deadlineVersion?: number;
  extensions?: { at: string; minutes: number; quoteId: string; actor: string }[];
  preferredDisposition?: Disposition | null;
  revokedAt?: string | null;
  endedAt?: string | null;
  endReason?: EndReason | null;
  disposition?: Disposition | null;
  keep?: LabSessionKeep | null;
  failure?: LabSessionFailure | null;
  residualAck?: boolean | null;
  costQuote?: { quoteId: string; [k: string]: unknown } | null;
  workstation?: { mode: WorkstationMode; instanceId?: string | null; stackName?: string | null } | null;
  app?: { entryUrl: string | null; embeddable: boolean } | null;
  startExecutionArn?: string | null;
  endExecutionArns?: string[];
  cleanup?: { passes: number; deleted: number; manual: number; failed: number } | null;
  cleanupRetryCount?: number;
  reclaim?: { followUp: 'PENDING' | 'DONE'; rescanAt: string[] } | null;
}

/** `LabSession` fields that only `atl-lifecycle` may write (01 §7.5 item 2). */
export const LIFECYCLE_OWNED_SESSION_FIELDS = [
  'state',
  'stateReason',
  'stateEnteredAt',
  'ver',
  'deadlineAt',
  'deadlineVersion',
  'extensions',
  'keep',
  'revokedAt',
  'endReason',
  'disposition',
  'failure',
  'phases',
  'reclaim',
] as const;

/** Cross-document view of `Environment` (01 §7.3). */
export interface EnvironmentItem {
  envId: string;
  envName: string;
  status: EnvironmentStatus;
  ownerSessionId: string;
  sessionChain: string[];
  labChain: string[];
  enabledModules: string[];
  stateUri: string;
  stacks: string[];
  instances?: unknown[];
  endpoints?: { baseUrl?: string | null; https?: { trusted: boolean } | null; [k: string]: unknown } | null;
  createdAt: string;
  maxAgeUntil?: string | null;
  keepUntil?: string | null;
  saveMode?: boolean | null;
  platformTags: Record<string, string>;
}

/** Cross-document view of `PlatformConfig` (01 §7.3); only the fields the agent context and timers need are typed. */
export interface PlatformConfigItem {
  version: string;
  installationId: string;
  region: string;
  drRegion: string | null;
  platformUrl: string;
  agentApiEndpoint: string;
  workloadBoundaryArn: string;
  maintenance: boolean;
  mode: PlatformMode;
  limits: {
    maxSessionMinutes: number;
    extension: { minutes: number; maxCount: number };
    maxKeepHours: number;
    keepHardMaxHours: number;
    envMaxAgeDays: number;
    readyIdleMinutes: number;
    asgMaxSizeLimit: number;
  };
  [k: string]: unknown;
}
