/**
 * Item shapes written by the lifecycle functions in `atl-main` (01 §7.2, §7.3; 02 §13.4). Field names follow 01; the
 * fields that only the lifecycle uses internally are listed in docs/implementation-notes.md (platform-lifecycle).
 * Times are ISO 8601 UTC strings (01 §7.1 common attributes); `deadlineAt` is always on a whole minute (02 §5.1).
 */
import type {
  BudgetState,
  CleanupState,
  DiscoveredBy,
  Disposition,
  EndReason,
  EnvironmentStatus,
  LabSessionFailure,
  LabSessionKeep,
  OutageWindow,
  PlatformMode,
  ReclaimPassMode,
  ResourceBilling,
  ResourceCreatedBy,
  ResourceSeverity,
  SessionState,
  WorkstationMode,
} from '@atl/shared';

/** What the lifecycle needs from the card (`lab.yaml` v2, 02 §13.5), frozen at CreateSession. */
export interface CardSnapshot {
  labId: string;
  labKind: 'service' | 'scenario';
  labVersion: string;
  catalogVersion: string;
  variant: string;
  startProfile: string;
  startProfileDigest: string;
  timeLimitMinutes: number;
  extensions: { maxCount: number; minutesEach: number };
  retain: { allowed: boolean; maxHours: number | null };
  provision: { class: 'A' | 'B' | 'C' | 'D'; budgetMinutes: number | null; cleanupBudgetMinutes: number | null };
  workstation: { required: boolean; sshFromWorkstation: boolean; sshUser: string | null };
  /** `regions.extra` (`dr-region`) and `regions.alsoUses` (`us-east-1`, `global`) as declared. */
  regions: { extra: string[]; alsoUses: string[] };
  extraStacks: { id: string; region: string; deploy: string; reclaimPhase: 'before-modules' | 'after-modules' }[];
  /** Platform actions the session may run (card `platformOps[]` + `xstk-<stackId>` for step-deployed card stacks). */
  platformActions: { id: string; op: string; module: string | null; title: string; interruptsManagementChannel: boolean }[];
  targetModules: { id: string; from: string | null; to: string }[];
  expectedWarnings: string[];
  keepablePrerequisites: string[];
  requiredLearnerInputs: string[];
  /** `startProfile.variants[]` with `select: preflight` (02 §3.6). */
  preflightVariants: { id: string; when: string | null }[];
  /** The start profile contains the seed `cognito-test-users` (agent context `testUsersParam`). */
  testUsersSeeded: boolean;
  costTier: 'low' | 'medium' | 'high' | null;
}

export interface PhaseMark {
  name: string;
  status: string;
  at: string;
  detail?: string;
}

export interface SessionRecord {
  PK: string;
  SK: string;
  type: 'LabSession';
  ver: number;
  createdAt: string;
  updatedAt: string;
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
  cardSnapshot: CardSnapshot;
  outageWindow: OutageWindow | null;
  state: SessionState;
  stateReason?: string | null;
  stateEnteredAt: string;
  phases?: PhaseMark[];
  readyAt?: string | null;
  runningAt?: string | null;
  deadlineAt?: string | null;
  deadlineVersion?: number;
  extensions?: { at: string; minutes: number; quoteId: string; actor: string }[];
  preferredDisposition?: { disposition: Disposition; keepHours: number | null; quoteId: string | null; keepPrerequisites: string[] } | null;
  revokedAt?: string | null;
  endedAt?: string | null;
  endReason?: EndReason | null;
  disposition?: Disposition | null;
  keep?: LabSessionKeep | null;
  /** Requested keep (from POST /end or preferredDisposition), turned into `keep` by EnterKept. */
  keepRequest?: { hours: number; quoteId: string | null; saveMode: boolean; confirmedAt: string } | null;
  keepPrerequisites?: string[];
  failure?: LabSessionFailure | null;
  finalizeError?: unknown;
  residualAck?: boolean | null;
  learnerInputs?: Record<string, unknown> | null;
  costQuote?: { quoteId: string; [k: string]: unknown } | null;
  workstation?: { mode: WorkstationMode; instanceId?: string | null; stackName?: string | null } | null;
  app?: { entryUrl: string | null; embeddable: boolean } | null;
  startExecutionArn?: string | null;
  endExecutionArns?: string[];
  cleanup?: { passes: number; deleted: number; manual: number; failed: number; blocking?: number; review?: number; hourlyBlocking?: number } | null;
  cleanupRetryCount?: number;
  autoCleanupRetries?: number;
  reclaim?: { followUp: 'PENDING' | 'DONE'; rescanAt: string[]; sweeperRescans?: number; lastRescanError?: unknown } | null;
  /** The SSM wait clock of the current apply round (02 §2.5). */
  ssmWait?: { round: string; startedAt: string; remediated: boolean } | null;
  provisioningStartedAt?: string | null;
  /** Revocation progress (6.3): FINALIZING after CloseLearnerAccess, SEALED after SealRevocation. */
  revocation?: { state: 'FINALIZING' | 'SEALED'; at: string; roleSessionNames: string[] } | null;
  /** End phase sequence (1 first end, 2 release, 2+k retry k) for run ids and reclaim execution names. */
  endSeq?: number;
  endPhase?: 'first' | 'release' | 'retry' | null;
  moduleOpRunning?: string | null;
  envHealth?: { status: 'ok' | 'degraded'; detail: string | null; at: string } | null;
  uninstallRetried?: boolean;
  [k: string]: unknown;
}

export interface EnvironmentRecord {
  PK: string;
  SK: string;
  type: 'Environment';
  ver: number;
  createdAt: string;
  updatedAt: string;
  envId: string;
  envName: string;
  status: EnvironmentStatus;
  ownerSessionId: string;
  sessionChain: string[];
  labChain: string[];
  enabledModules: string[];
  /**
   * Parameters each enabled module was enabled with (module stack parameters / switches, e.g. `network: {NETWORK_NAT_MODE:
   * "gateway"}`, `database: {MultiAz: "true", DbInstanceClass: "db.t4g.small"}`), written together with `enabledModules`.
   * EXTEND / KEEP quotes price `ref: module` lines from it; a module without a record is priced as “unknown” where its
   * cost depends on a parameter (services/pricing/estimate.ts).
   */
  moduleParams?: Record<string, Record<string, string>> | null;
  stateUri: string;
  stacks: string[];
  instances?: { instanceId: string; role: string; state: string }[];
  endpoints?: { baseUrl?: string | null; https?: { trusted: boolean } | null; [k: string]: unknown } | null;
  maxAgeUntil?: string | null;
  keepUntil?: string | null;
  saveMode?: boolean | null;
  platformTags: Record<string, string>;
  region: string;
  /** Regions the reclaimer scans for this environment (02 §7.1). */
  scanRegions: string[];
  workstation?: { mode: WorkstationMode; instanceId: string | null; stackName: string | null } | null;
  releasedAt?: string | null;
  [k: string]: unknown;
}

export interface LockRecord {
  PK: string;
  SK: string;
  type: 'ActiveEnvironmentLock';
  ver: number;
  holderEnvId?: string | null;
  holderSessionId?: string | null;
  acquiredAt?: string | null;
  pendingSessionId?: string | null;
  pendingUntil?: string | null;
  updatedAt?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export interface SessionResourceRecord {
  PK: string;
  SK: string;
  type: 'SessionResource';
  ver: number;
  createdAt: string;
  updatedAt: string;
  envId: string;
  resourceKey: string;
  arn: string | null;
  resourceType: string;
  region: string;
  name: string | null;
  id: string;
  sessionId: string;
  createdBy: ResourceCreatedBy;
  creatorSessionName: string | null;
  eventId: string | null;
  eventTime: string | null;
  discoveredBy: DiscoveredBy;
  sources: DiscoveredBy[];
  billing: ResourceBilling;
  stage: string | null;
  cleanupState: CleanupState;
  severity: ResourceSeverity | null;
  attempts: number;
  firstAttemptAt?: string | null;
  lastTriedAt?: string | null;
  lastError?: string | null;
  manualHint?: { consoleUrl: string; cli: string; note?: string } | null;
  stackName?: string | null;
  logicalId?: string | null;
  retained?: boolean;
  passNo?: number;
  pendingSince?: string | null;
  deadlineAt?: string | null;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ReclaimPassRecord {
  PK: string;
  SK: string;
  type: 'ReclaimPass';
  ver: number;
  createdAt: string;
  updatedAt: string;
  envId: string;
  sessionId: string;
  passNo: number;
  mode: ReclaimPassMode;
  startedAt: string;
  finishedAt?: string | null;
  found: number;
  deleted: number;
  manual: number;
  gaps?: string[];
  executionName?: string | null;
  summary?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface PlatformConfigView {
  version: string;
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
  budget: { amount: number | null; enforcement: 'notify' | 'block-start' | 'end-active'; state: BudgetState; stateAt: string | null };
  reclaim: { rescanOffsetsMinutes: number[]; blockStartOnResidual: 'ack' | 'block' | 'ignore' };
  ownership: { maxWaitMinutes: number; hardMaxWaitMinutes: number };
  outage: { maxMinutes: number };
  uninstall?: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}
