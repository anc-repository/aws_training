/**
 * DynamoDB key construction for `atl-main` — 01 §7.1, §7.2, §7.4.
 *
 * 01 §7.1 requires a single place for key construction (`platform/api/src/data/keys.ts`); that file re-exports this module,
 * so the browser-side code and tools share the same definitions (see docs/implementation-notes.md “platform-scaffold”).
 * Nothing else may concatenate `PK` / `SK` / `GSI*` strings.
 */
import { GSI2_CLEANUP_STATES, type CleanupState, type EnvironmentStatus } from './entities.js';
import { assertSid } from './ids.js';
import { COUNTDOWN_STATES, NON_TERMINAL_STATES, type SessionState } from './session-states.js';

export interface PrimaryKey {
  PK: string;
  SK: string;
}
export interface Gsi1Key {
  GSI1PK: string;
  GSI1SK: string;
}
export interface Gsi2Key {
  GSI2PK: string;
  GSI2SK: string;
}

const pk = (PK: string, SK: string): PrimaryKey => ({ PK, SK });

function nonEmpty(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  if (value.includes('#') && name !== 'dimensionKey' && name !== 'idempotencyKey') {
    // '#' is the key separator; ids never contain it (dimension keys may, they are the last segment).
    throw new TypeError(`${name} must not contain '#': ${value}`);
  }
  return value;
}

function padNumber(n: number, width: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`expected a non-negative integer, got ${n}`);
  const s = String(n);
  if (s.length > width) throw new RangeError(`${n} does not fit in ${width} digits`);
  return s.padStart(width, '0');
}

/** `yyyy-mm` (UTC) of an ISO timestamp / Date — the AuditEvent partition. */
export function auditMonth(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new TypeError(`invalid date: ${String(at)}`);
  return d.toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------------------------------------------
// Primary keys (one function per entity, 01 §7.2)

export const Keys = {
  platformConfig: () => pk('PLATFORM', 'CONFIG'),
  schemaVersion: () => pk('PLATFORM', 'SCHEMA'),
  activeEnvironmentLock: () => pk('PLATFORM', 'LOCK#ACTIVE_ENV'),
  /** e.g. `RATE#cloudtrail-lookup#us-east-1`. */
  rateBucket: (api: string, region: string) => pk('PLATFORM', `RATE#${nonEmpty('api', api)}#${nonEmpty('region', region)}`),
  catalogRelease: (catalogVersion: string) => pk('CATALOG', `REL#${nonEmpty('catalogVersion', catalogVersion)}`),
  /** Pointer to the current catalog release. */
  catalogCurrent: () => pk('CATALOG', 'CURRENT'),
  priceCache: (region: string, serviceCode: string, dimensionKey: string) =>
    pk(`PRICE#${nonEmpty('region', region)}`, `${nonEmpty('serviceCode', serviceCode)}#${nonEmpty('dimensionKey', dimensionKey)}`),
  costQuote: (sub: string, quoteId: string) => pk(`USER#${nonEmpty('sub', sub)}`, `QUOTE#${nonEmpty('quoteId', quoteId)}`),
  /** Learner and Member share the PROFILE item (distinguished by GSI1SK / `type`). */
  userProfile: (sub: string) => pk(`USER#${nonEmpty('sub', sub)}`, 'PROFILE'),
  labProgress: (sub: string, labId: string) => pk(`USER#${nonEmpty('sub', sub)}`, `LAB#${nonEmpty('labId', labId)}`),
  quizAttempt: (sub: string, labId: string, ulid: string) =>
    pk(`USER#${nonEmpty('sub', sub)}`, `QUIZ#${nonEmpty('labId', labId)}#${nonEmpty('ulid', ulid)}`),
  labSession: (sid: string) => pk(sessionPk(sid), 'META'),
  sessionEvent: (sid: string, ulid: string) => pk(sessionPk(sid), `EVT#${nonEmpty('ulid', ulid)}`),
  stepResult: (sid: string, stepId: string) => pk(sessionPk(sid), `STEP#${nonEmpty('stepId', stepId)}`),
  checkRun: (sid: string, runId: string) => pk(sessionPk(sid), `RUN#${nonEmpty('runId', runId)}`),
  manualConfirmation: (sid: string, stepId: string, checkId: string, ulid: string) =>
    pk(sessionPk(sid), `MANUAL#${nonEmpty('stepId', stepId)}#${nonEmpty('checkId', checkId)}#${nonEmpty('ulid', ulid)}`),
  experimentRun: (sid: string, runId: string) => pk(sessionPk(sid), `EXP#${nonEmpty('runId', runId)}`),
  moduleOp: (sid: string, ulid: string) => pk(sessionPk(sid), `MODOP#${nonEmpty('ulid', ulid)}`),
  runnerRun: (sid: string, runId: string) => pk(sessionPk(sid), `BUILD#${nonEmpty('runId', runId)}`),
  credentialGrant: (sid: string, channel: string, ulid: string) =>
    pk(sessionPk(sid), `CRED#${nonEmpty('channel', channel)}#${nonEmpty('ulid', ulid)}`),
  terminalSession: (sid: string, ulid: string) => pk(sessionPk(sid), `TERM#${nonEmpty('ulid', ulid)}`),
  labAttempt: (sid: string) => pk(sessionPk(sid), 'ATTEMPT'),
  report: (sid: string, version: number) => pk(sessionPk(sid), `REPORT#v${positive(version)}`),
  reportShare: (sid: string, shareId: string) => pk(sessionPk(sid), `SHARE#${nonEmpty('shareId', shareId)}`),
  environment: (envId: string) => pk(`ENV#${nonEmpty('envId', envId)}`, 'META'),
  sessionResource: (envId: string, resourceKey: string) => pk(`ENV#${nonEmpty('envId', envId)}`, `RES#${checkResourceKey(resourceKey)}`),
  /** `PASS#<n>`, n left-padded to 4 digits. */
  reclaimPass: (envId: string, passNo: number) => pk(`ENV#${nonEmpty('envId', envId)}`, `PASS#${padNumber(passNo, 4)}`),
  inventorySnapshot: (envId: string) => pk(`ENV#${nonEmpty('envId', envId)}`, 'INV'),
  certificate: (certId: string) => pk(`CERT#${nonEmpty('certId', certId)}`, 'META'),
  /** `CERT#REVOCATIONS / SEQ#<n>`, n left-padded to 8 digits. */
  revocationList: (seq: number) => pk('CERT#REVOCATIONS', `SEQ#${padNumber(seq, 8)}`),
  signingKey: (kid: string) => pk(`KEY#${nonEmpty('kid', kid)}`, 'META'),
  auditEvent: (at: string | Date, ulid: string) => pk(`AUDIT#${auditMonth(at)}`, nonEmpty('ulid', ulid)),
  idempotencyRecord: (sub: string, key: string) => pk(`IDEMP#${nonEmpty('sub', sub)}#${nonEmpty('idempotencyKey', key)}`, 'META'),
} as const;

function sessionPk(sid: string): string {
  return `SESSION#${assertSid(sid)}`;
}

function positive(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`expected a positive integer, got ${n}`);
  return n;
}

/** resourceKey = first 32 hex chars of SHA-256 (computed by `resourceKey()` in `@atl/shared/node`). */
export const RESOURCE_KEY_RE = /^[0-9a-f]{32}$/;
function checkResourceKey(k: string): string {
  if (!RESOURCE_KEY_RE.test(k)) throw new TypeError(`invalid resourceKey: ${k}`);
  return k;
}

// ---------------------------------------------------------------------------------------------------------------
// GSI1 (ALL projection): per learner, per environment, collections

export const Gsi1 = {
  /** Learner: `MEMBERS / learner#<email>`. */
  learner: (email: string) => ({ GSI1PK: 'MEMBERS', GSI1SK: `learner#${nonEmpty('email', email)}` }),
  /** Member: `MEMBERS / <assistant|observer>#<email>`. */
  member: (role: 'assistant' | 'observer', email: string) => ({ GSI1PK: 'MEMBERS', GSI1SK: `${role}#${nonEmpty('email', email)}` }),
  labSession: (sub: string, createdAt: string, sid: string) => ({
    GSI1PK: `USER#${nonEmpty('sub', sub)}`,
    GSI1SK: `SESSION#${nonEmpty('createdAt', createdAt)}#${assertSid(sid)}`,
  }),
  experimentRun: (sub: string, module: string, experiment: string, finishedAt: string) => ({
    GSI1PK: `USER#${nonEmpty('sub', sub)}`,
    GSI1SK: `EXP#${nonEmpty('module', module)}#${nonEmpty('experiment', experiment)}#${nonEmpty('finishedAt', finishedAt)}`,
  }),
  report: (sub: string, generatedAt: string, sid: string) => ({
    GSI1PK: `USER#${nonEmpty('sub', sub)}`,
    GSI1SK: `REPORT#${nonEmpty('generatedAt', generatedAt)}#${assertSid(sid)}`,
  }),
  environment: (createdAt: string, envId: string) => ({ GSI1PK: 'ENVS', GSI1SK: `${nonEmpty('createdAt', createdAt)}#${nonEmpty('envId', envId)}` }),
  /** `sid` = the session that created the resource. */
  sessionResource: (sid: string, createdAt: string, resourceKey: string) => ({
    GSI1PK: `SESRES#${assertSid(sid)}`,
    GSI1SK: `${nonEmpty('createdAt', createdAt)}#${checkResourceKey(resourceKey)}`,
  }),
  certificate: (sub: string, issuedAt: string, certId: string) => ({
    GSI1PK: `USER#${nonEmpty('sub', sub)}`,
    GSI1SK: `CERT#${nonEmpty('issuedAt', issuedAt)}#${nonEmpty('certId', certId)}`,
  }),
  signingKey: (createdAt: string) => ({ GSI1PK: 'KEYS', GSI1SK: nonEmpty('createdAt', createdAt) }),
  /** Only when the audit event belongs to a session. */
  auditEvent: (sid: string, ulid: string) => ({ GSI1PK: `AUDIT#SESSION#${assertSid(sid)}`, GSI1SK: nonEmpty('ulid', ulid) }),
} satisfies Record<string, (...args: never[]) => Gsi1Key>;

// ---------------------------------------------------------------------------------------------------------------
// GSI2 (sparse, INCLUDE projection): by state. `null` = the item must not carry GSI2 attributes (REMOVE them on update).

export interface LabSessionGsi2Input {
  sid: string;
  state: SessionState;
  stateEnteredAt: string;
  deadlineAt?: string | null;
  revokedAt?: string | null;
  reclaim?: { followUp?: 'PENDING' | 'DONE' | null } | null;
}

export const Gsi2 = {
  /**
   * Non-terminal: `STATE#<state> / <deadlineAt or stateEnteredAt>#<sid>` — deadlineAt while the countdown runs
   * (READY/RUNNING/EXPIRING), stateEnteredAt otherwise. Terminal inside the rescan window (`reclaim.followUp=PENDING`):
   * `FOLLOWUP#PENDING / <revokedAt>#<sid>` (stateEnteredAt when access was never issued). Otherwise none.
   */
  labSession(s: LabSessionGsi2Input): Gsi2Key | null {
    const sid = assertSid(s.sid);
    if ((NON_TERMINAL_STATES as readonly SessionState[]).includes(s.state)) {
      const counting = (COUNTDOWN_STATES as readonly SessionState[]).includes(s.state) && s.deadlineAt;
      const at = counting ? s.deadlineAt! : s.stateEnteredAt;
      return { GSI2PK: `STATE#${s.state}`, GSI2SK: `${nonEmpty('at', at)}#${sid}` };
    }
    if (s.reclaim?.followUp === 'PENDING') {
      return { GSI2PK: 'FOLLOWUP#PENDING', GSI2SK: `${nonEmpty('at', s.revokedAt ?? s.stateEnteredAt)}#${sid}` };
    }
    return null;
  },
  /** Pending assistant review: `REVIEW#PENDING / <createdAt>#<sid>`. */
  manualConfirmation(pending: boolean, createdAt: string, sid: string): Gsi2Key | null {
    return pending ? { GSI2PK: 'REVIEW#PENDING', GSI2SK: `${nonEmpty('createdAt', createdAt)}#${assertSid(sid)}` } : null;
  },
  /** Unreleased environments: `ENVSTATE#<status> / <keepUntil or createdAt>#<envId>`. */
  environment(status: EnvironmentStatus, envId: string, createdAt: string, keepUntil?: string | null): Gsi2Key | null {
    if (status === 'RELEASED') return null;
    return { GSI2PK: `ENVSTATE#${status}`, GSI2SK: `${nonEmpty('at', keepUntil ?? createdAt)}#${nonEmpty('envId', envId)}` };
  },
  /** Only MANUAL_REQUIRED, REVIEW, FAILED: `RES#<cleanupState> / <envId>#<resourceKey>`. */
  sessionResource(cleanupState: CleanupState, envId: string, resourceKey: string): Gsi2Key | null {
    if (!(GSI2_CLEANUP_STATES as readonly CleanupState[]).includes(cleanupState)) return null;
    return { GSI2PK: `RES#${cleanupState}`, GSI2SK: `${nonEmpty('envId', envId)}#${checkResourceKey(resourceKey)}` };
  },
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Query helpers (01 §7.4)

/** Sort-key prefixes for `begins_with` queries. */
export const SkPrefix = {
  event: 'EVT#',
  step: 'STEP#',
  checkRun: 'RUN#',
  manual: 'MANUAL#',
  experiment: 'EXP#',
  moduleOp: 'MODOP#',
  runnerRun: 'BUILD#',
  credential: 'CRED#',
  credentialChannel: (channel: string) => `CRED#${nonEmpty('channel', channel)}#`,
  terminal: 'TERM#',
  report: 'REPORT#',
  share: 'SHARE#',
  lab: 'LAB#',
  quiz: 'QUIZ#',
  quizForLab: (labId: string) => `QUIZ#${nonEmpty('labId', labId)}#`,
  quote: 'QUOTE#',
  resource: 'RES#',
  pass: 'PASS#',
  revocation: 'SEQ#',
  gsi1Session: 'SESSION#',
  gsi1Experiment: (module: string) => `EXP#${nonEmpty('module', module)}#`,
  gsi1Report: 'REPORT#',
  gsi1Cert: 'CERT#',
} as const;

/** AP5: events after a cursor — `SK > EVT#<after>` and `SK <= EVT#~`. */
export function eventRange(afterUlid?: string | null): { lowerExclusive: string; upperInclusive: string } {
  return { lowerExclusive: afterUlid ? `EVT#${afterUlid}` : 'EVT#', upperInclusive: 'EVT#~' };
}

/** AP12: GSI2 partitions the sweeper / uninstall preparation query (9 non-terminal states + FOLLOWUP#PENDING = 10 queries). */
export const SWEEP_GSI2_PARTITIONS: readonly string[] = [...NON_TERMINAL_STATES.map((s) => `STATE#${s}`), 'FOLLOWUP#PENDING'];

/** AP13: cross-environment manual / review / failed items. */
export const MANUAL_GSI2_PARTITIONS: readonly string[] = GSI2_CLEANUP_STATES.map((s) => `RES#${s}`);

// ---------------------------------------------------------------------------------------------------------------
// TTL (attribute `ttl`, Unix seconds). TTL only cleans up; expiry is always decided by comparing `expiresAt` (01 §7.2).

export const TTL_ATTRIBUTE = 'ttl';

export function ttlEpochSeconds(at: Date | string | number): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : at;
  if (!Number.isFinite(ms)) throw new TypeError(`invalid TTL time: ${String(at)}`);
  return Math.floor(ms / 1000);
}

/** TTL policies of the entities that have one (01 §7.2 “TTL” column, §7.6). */
export const TTL_POLICY = {
  /** PriceCache: 24 hours. */
  priceCacheHours: 24,
  /** IdempotencyRecord: 24 hours. */
  idempotencyHours: 24,
  /** CostQuote: cleanup only; expiresAt = issue + 15 min decides validity. Cleanup after 24 h (platform-scaffold choice). */
  costQuoteCleanupHours: 24,
  /** AuditEvent: install parameter `AuditRetentionDays` (default 400). */
  auditRetentionDaysDefault: 400,
} as const;

export function ttlAfterHours(from: Date | string | number, hours: number): number {
  return ttlEpochSeconds(from) + Math.round(hours * 3600);
}
