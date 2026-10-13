/**
 * Session state machine — 01 §2.4 and the name-table row “会话状态”; transitions T01–T21 from 02 §2.3.
 *
 * `atl-lifecycle`'s `Transition` action is the only writer of `LabSession.state`; these tables are the shared truth that
 * both it and the tests use.
 */

/** P11's ten states + `KEPT` (02 addition). */
export const SESSION_STATES = [
  'REQUESTED',
  'PROVISIONING',
  'READY',
  'RUNNING',
  'EXPIRING',
  'ENDING',
  'KEPT',
  'CLEANING',
  'ENDED',
  'FAILED',
  'CLEANUP_FAILED',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value);
}

/** Terminal states (outside the rescan window). Inside the window they may be downgraded to `CLEANUP_FAILED` (T21). */
export const TERMINAL_STATES = ['ENDED', 'FAILED'] as const satisfies readonly SessionState[];

/** Non-terminal states queried one by one on GSI2 by the sweeper / uninstall preparation (01 §7.4 AP12). */
export const NON_TERMINAL_STATES = [
  'REQUESTED',
  'PROVISIONING',
  'READY',
  'RUNNING',
  'EXPIRING',
  'ENDING',
  'KEPT',
  'CLEANING',
  'CLEANUP_FAILED',
] as const satisfies readonly SessionState[];

export function isTerminal(state: SessionState): boolean {
  return (TERMINAL_STATES as readonly SessionState[]).includes(state);
}

/** States where the learner may be issued AWS access (console / terminal / workstation), 02 §13.6 (03). */
export const ACCESS_STATES = ['READY', 'RUNNING', 'EXPIRING'] as const satisfies readonly SessionState[];

/** States in which the countdown (deadlineAt) is running. */
export const COUNTDOWN_STATES = ['READY', 'RUNNING', 'EXPIRING'] as const satisfies readonly SessionState[];

/**
 * Does a session in this state hold `ActiveEnvironmentLock`? (01 §2.4, §7.5, 02 §2.1)
 * `REQUESTED` is “抢锁中” (may or may not hold it) → `'acquiring'`. `CLEANING` entered by T19 (retry) does not re-acquire the lock.
 */
export function holdsActiveEnvLock(state: SessionState, opts: { cleaningIsRetry?: boolean } = {}): boolean | 'acquiring' {
  switch (state) {
    case 'REQUESTED':
      return 'acquiring';
    case 'PROVISIONING':
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING':
    case 'ENDING':
    case 'KEPT':
      return true;
    case 'CLEANING':
      return !opts.cleaningIsRetry;
    case 'ENDED':
    case 'FAILED':
    case 'CLEANUP_FAILED':
      return false;
  }
}

/** Who calls `atl-lifecycle.Transition` for a transition (02 §2.3 “执行者”). */
export type TransitionExecutor =
  | 'api'
  | 'atl-session-start'
  | 'atl-session-end'
  | 'atl-timer'
  | 'sweeper'
  | 'atl-reclaim-rescan'
  | 'sfn-failure-handler';

export type TransitionId =
  | 'T01' | 'T02' | 'T03' | 'T04' | 'T05' | 'T06' | 'T07' | 'T08' | 'T09' | 'T10'
  | 'T11' | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17' | 'T18' | 'T19' | 'T20' | 'T21';

export interface TransitionDef {
  id: TransitionId;
  /** `null` = creation (T01). */
  from: readonly (SessionState | null)[];
  to: readonly SessionState[];
  trigger: string;
  executors: readonly TransitionExecutor[];
}

/** 02 §2.3 transition table (T01–T21). */
export const TRANSITIONS: readonly TransitionDef[] = [
  { id: 'T01', from: [null], to: ['REQUESTED'], trigger: 'POST /api/v1/sessions (CreateSession)', executors: ['api'] },
  { id: 'T02', from: ['REQUESTED'], to: ['PROVISIONING'], trigger: 'start workflow: lock held (or reuse reservation) and preflight passed', executors: ['atl-session-start'] },
  { id: 'T03', from: ['REQUESTED'], to: ['FAILED'], trigger: 'quote invalid / lock busy / preflight failed / 5 min without PROVISIONING', executors: ['atl-session-start', 'sweeper'] },
  { id: 'T04', from: ['REQUESTED'], to: ['ENDED'], trigger: 'learner cancels before PROVISIONING', executors: ['api'] },
  { id: 'T05', from: ['PROVISIONING'], to: ['READY'], trigger: 'health gate passed', executors: ['atl-session-start'] },
  { id: 'T06', from: ['PROVISIONING'], to: ['CLEANING'], trigger: 'deploy failed / timeout / learner cancels (compensation)', executors: ['atl-session-end'] },
  { id: 'T07', from: ['READY'], to: ['RUNNING'], trigger: 'first workbench heartbeat (workbench=true)', executors: ['api'] },
  { id: 'T08', from: ['READY', 'RUNNING'], to: ['EXPIRING'], trigger: 'WARN_15 or any read/write sees ≤ 15 min left', executors: ['atl-timer', 'api'] },
  { id: 'T09', from: ['EXPIRING'], to: ['RUNNING', 'READY'], trigger: 'extended to > 15 min left (RUNNING if runningAt, else READY)', executors: ['api'] },
  { id: 'T10', from: ['READY', 'RUNNING', 'EXPIRING'], to: ['ENDING'], trigger: 'end / expiry / ready-idle / budget / uninstall / admin', executors: ['api', 'atl-timer', 'sweeper', 'atl-session-end'] },
  { id: 'T11', from: ['ENDING'], to: ['KEPT'], trigger: 'disposition=keep', executors: ['atl-session-end'] },
  { id: 'T12', from: ['ENDING'], to: ['CLEANING'], trigger: 'disposition=destroy', executors: ['atl-session-end'] },
  { id: 'T13', from: ['KEPT'], to: ['KEPT'], trigger: 'keep extended', executors: ['api'] },
  { id: 'T14', from: ['KEPT'], to: ['CLEANING'], trigger: 'keep expired / release now / uninstall', executors: ['atl-timer', 'api', 'atl-session-end'] },
  { id: 'T15', from: ['KEPT'], to: ['ENDED'], trigger: 'environment handed over to the next session (same transaction as its T02)', executors: ['atl-session-start'] },
  { id: 'T16', from: ['CLEANING'], to: ['ENDED'], trigger: 'reclaim verified, endReason ∉ {PROVISION_FAILED, PROVISION_TIMEOUT}', executors: ['atl-session-end'] },
  { id: 'T17', from: ['CLEANING'], to: ['FAILED'], trigger: 'reclaim verified, endReason ∈ {PROVISION_FAILED, PROVISION_TIMEOUT}', executors: ['atl-session-end'] },
  { id: 'T18', from: ['CLEANING'], to: ['CLEANUP_FAILED'], trigger: 'BLOCKING residue / cleanup timeout / workflow error', executors: ['atl-session-end', 'sweeper', 'sfn-failure-handler'] },
  { id: 'T19', from: ['CLEANUP_FAILED'], to: ['CLEANING'], trigger: 'retry (learner, sweeper auto-retry, uninstall)', executors: ['api', 'sweeper', 'atl-session-end'] },
  { id: 'T20', from: ['CLEANUP_FAILED'], to: ['ENDED', 'FAILED'], trigger: 'all manual items resolved and verified (back to the endReason’s terminal state)', executors: ['api'] },
  { id: 'T21', from: ['ENDED', 'FAILED'], to: ['CLEANUP_FAILED'], trigger: 'rescan found BLOCKING residue within the rescan window (reclaim.followUp=PENDING)', executors: ['atl-reclaim-rescan'] },
];

/** All transitions that lead from `from` to `to` (normally zero or one). */
export function findTransitions(from: SessionState | null, to: SessionState): TransitionDef[] {
  return TRANSITIONS.filter((t) => t.from.includes(from) && t.to.includes(to));
}

/** Is `from → to` one of T01–T21? (Replays “state already equals target with the same reason” are handled by `Transition`, not here.) */
export function canTransition(from: SessionState | null, to: SessionState): boolean {
  return findTransitions(from, to).length > 0;
}

/** Target states reachable from `from` in one transition. */
export function allowedTargets(from: SessionState | null): SessionState[] {
  const out = new Set<SessionState>();
  for (const t of TRANSITIONS) if (t.from.includes(from)) for (const s of t.to) out.add(s);
  return [...out];
}

/** `LabSession.endReason` values (02 §6.1, T15 `HANDED_OVER`). */
export const END_REASONS = [
  'USER_ENDED',
  'EXPIRED',
  'IDLE_NOT_STARTED',
  'CANCELLED',
  'PROVISION_FAILED',
  'PROVISION_TIMEOUT',
  'BUDGET_ENFORCED',
  'ADMIN_ENDED',
  'KEEP_EXPIRED',
  'KEEP_RELEASED',
  'PLATFORM_UNINSTALL',
  'CLEANUP_RETRY',
  'HANDED_OVER',
] as const;
export type EndReason = (typeof END_REASONS)[number];

/** endReasons whose successful reclaim ends in `FAILED` (T17) instead of `ENDED` (T16). */
export const FAILED_END_REASONS = ['PROVISION_FAILED', 'PROVISION_TIMEOUT'] as const satisfies readonly EndReason[];

/** Terminal state that a successful reclaim leads to (T16 / T17, also T20). */
export function terminalStateFor(endReason: EndReason | null | undefined): 'ENDED' | 'FAILED' {
  return endReason && (FAILED_END_REASONS as readonly string[]).includes(endReason) ? 'FAILED' : 'ENDED';
}

/** Default state-level timeouts in minutes (02 §2.1); `null` = derived from card budgets / deadline. */
export const STATE_TIMEOUT_MINUTES: Readonly<Record<SessionState, number | null>> = {
  REQUESTED: 5,
  PROVISIONING: null, // card deploy budget (02 §11.1) + 10 min grace
  READY: null, // min(readyIdleMinutes (60), deadlineAt)
  RUNNING: null, // deadlineAt
  EXPIRING: null, // deadlineAt
  ENDING: 20,
  KEPT: null, // keep.until
  CLEANING: null, // card reclaim budget (02 §11.1)
  ENDED: null,
  FAILED: null,
  CLEANUP_FAILED: null,
};

/** Grace added to the deploy budget for the PROVISIONING timeout (02 §2.1). */
export const PROVISIONING_GRACE_MINUTES = 10;

/**
 * Agent route state gates (01 §5.3, C4(b)). `ENDING` is accepted for result upload / poll only for runIds registered before
 * ENDING — the caller checks `registeredAt < stateEnteredAt` itself.
 */
export const AGENT_STATE_GATES = {
  context: ['PROVISIONING', 'READY', 'RUNNING', 'EXPIRING'],
  experimentResult: ['READY', 'RUNNING', 'EXPIRING', 'ENDING'],
  default: ['READY', 'RUNNING', 'EXPIRING'],
} as const satisfies Record<string, readonly SessionState[]>;

/** Execution phase of `atl-session-end` that an end request belongs to (02 §6.1 “结束阶段”). */
export type EndPhase = 'first' | 'release' | 'retry';

export function endPhaseFor(state: SessionState): EndPhase | null {
  switch (state) {
    // REQUESTED is cancelled by T04 without an end execution (if that conditional update loses, the caller retries as T06 → 'first').
    case 'PROVISIONING':
    case 'READY':
    case 'RUNNING':
    case 'EXPIRING':
      return 'first';
    case 'KEPT':
      return 'release';
    case 'CLEANUP_FAILED':
      return 'retry';
    default:
      return null;
  }
}
