/**
 * Pure lifecycle rules (no I/O): budgets by provision class (02 §11.1), runner failure classification (02 §4.3),
 * deadline and extension arithmetic (02 §5.1, §5.4), keep limits (02 §8.1), conclusion (02 §6.7).
 */
import { ceilToMinute, terminalStateFor, type AtlOp, type EndReason, type FailureCode } from '@atl/shared';
import type { CardSnapshot, PlatformConfigView, SessionRecord } from './store/model.js';

const MIN = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Budgets (02 §11.1, §2.5)

export const CLASS_BUDGETS: Readonly<Record<'A' | 'B' | 'C' | 'D', { deploy: number; cleanup: number }>> = {
  A: { deploy: 30, cleanup: 45 },
  B: { deploy: 45, cleanup: 60 },
  C: { deploy: 90, cleanup: 120 },
  D: { deploy: 120, cleanup: 150 },
};

/** base-deploy build timeout (02 §2.5: 30 minutes, queue timeout 30 minutes). */
export const BASE_BUILD_MINUTES = 30;
/** Step Functions task timeout = build timeout + 5 minutes of queueing / polling slack. */
export const TASK_SLACK_SECONDS = 300;
/** CodeBuild accepts a build timeout of at least 5 minutes. */
export const MIN_BUILD_MINUTES = 5;
export const SSM_TIMEOUT_SECONDS = 600;
export const SSM_REMEDIATE_AFTER_SECONDS = 360;

export function deployBudgetMinutes(card: CardSnapshot): number {
  return card.provision.budgetMinutes ?? CLASS_BUDGETS[card.provision.class].deploy;
}

/**
 * Reclaim budget = max(class default, provision.cleanupBudgetMinutes) (02 §11.1). The third term (longest single-item
 * deadline of slow resources the learner may create, + 15 min) needs per-card data that lab.yaml v2 does not carry;
 * cards declare it through cleanupBudgetMinutes (05).
 */
export function cleanupBudgetMinutes(card: CardSnapshot): number {
  return Math.max(CLASS_BUDGETS[card.provision.class].cleanup, card.provision.cleanupBudgetMinutes ?? 0);
}

export interface EnvBudget {
  baseBuildMinutes: number;
  baseTaskSeconds: number;
  applyBuildMinutes: number;
  applyTaskSeconds: number;
  ssmTimeoutSec: number;
  ssmRemediateAfterSec: number;
  deployMinutes: number;
  cleanupMinutes: number;
  destroyBuildMinutes: number;
  destroyTaskSeconds: number;
}

export function envBudget(card: CardSnapshot): EnvBudget {
  const deploy = deployBudgetMinutes(card);
  const cleanup = cleanupBudgetMinutes(card);
  return {
    baseBuildMinutes: BASE_BUILD_MINUTES,
    baseTaskSeconds: BASE_BUILD_MINUTES * 60 + TASK_SLACK_SECONDS,
    applyBuildMinutes: deploy,
    applyTaskSeconds: deploy * 60 + TASK_SLACK_SECONDS,
    ssmTimeoutSec: SSM_TIMEOUT_SECONDS,
    ssmRemediateAfterSec: SSM_REMEDIATE_AFTER_SECONDS,
    deployMinutes: deploy,
    cleanupMinutes: cleanup,
    destroyBuildMinutes: cleanup,
    destroyTaskSeconds: cleanup * 60 + TASK_SLACK_SECONDS,
  };
}

/** PROVISIONING state timeout = deploy budget + 10 minutes grace (02 §2.1). */
export function provisioningTimeoutMinutes(card: CardSnapshot): number {
  return deployBudgetMinutes(card) + 10;
}

/** Remaining deploy budget (minutes, floored) since PROVISIONING started — retries and repair share it (02 §2.5). */
export function remainingDeployMinutes(card: CardSnapshot, provisioningStartedAt: string | null | undefined, nowMs: number): number {
  const start = provisioningStartedAt ? Date.parse(provisioningStartedAt) : nowMs;
  return Math.floor((start + deployBudgetMinutes(card) * MIN - nowMs) / MIN);
}

export function buildBudget(remainingMinutes: number): { buildMinutes: number; taskSeconds: number } {
  const buildMinutes = Math.max(MIN_BUILD_MINUTES, remainingMinutes);
  return { buildMinutes, taskSeconds: buildMinutes * 60 + TASK_SLACK_SECONDS };
}

// ---------------------------------------------------------------------------------------------------------------
// Runner failure classification (02 §4.3)

export interface RunnerResultFacts {
  exitCode?: number | null;
  phase?: string | null;
  module?: string | null;
  cfnFailures?: { stack?: string; logicalId?: string; status?: string; reason?: string }[];
  error?: string | null;
  /** classification computed by the runner (code only), e.g. PROFILE_DIGEST_MISMATCH, BASE_BOOTSTRAP_FAILED */
  classification?: { retryable?: boolean; code?: string | null; hint?: string | null } | null;
  firstCreate?: boolean;
  durationSeconds?: number | null;
}

export interface Classification {
  retryable: boolean;
  code: FailureCode | null;
  hint: string | null;
  /** destroy exit 6 and similar: not a failure, continue with the reclaimer */
  notAFailure: boolean;
  /** the next attempt must repair the state first (exit 8) */
  repairState: boolean;
}

export function defaultCodeFor(op: AtlOp | string): FailureCode {
  switch (op) {
    case 'base-deploy':
    case 'resume':
      return 'BASE_DEPLOY_FAILED';
    case 'profile-apply':
      return 'PROFILE_STACK_FAILED';
    case 'extra-stack':
      return 'EXTRA_STACK_FAILED';
    case 'workstation-up':
      return 'WORKSTATION_FAILED';
    default:
      return 'RUNNER_ERROR';
  }
}

const THROTTLE_RE = /Rate exceeded|Throttl|TooManyRequests|RequestLimitExceeded|InternalFailure|InternalError|ServiceUnavailable|ServiceException/i;
const CAPACITY_RE = /InsufficientInstanceCapacity|InsufficientCapacity|insufficient capacity|do not have sufficient \S+ capacity/i;
const QUOTA_RE = /LimitExceeded|limit exceeded|quota|VcpuLimitExceeded|AddressLimitExceeded|InstanceLimitExceeded|exceeded the maximum/i;
const ACCESS_RE = /AccessDenied|not authorized|UnauthorizedOperation|AccessDeniedException|explicit deny/i;
const RESTRICTED_RE = /OptInRequired|PendingVerification|not supported for this account|account is not authorized to|Blocked|account.*restricted|SubscriptionRequired/i;

const KNOWN_CODES = new Set<string>([
  'PROFILE_RULES',
  'PROFILE_DIGEST_MISMATCH',
  'BASE_BOOTSTRAP_FAILED',
  'BASE_DEPLOY_FAILED',
  'CAPACITY',
  'ACCOUNT_QUOTA',
  'ACCESS_DENIED',
  'ACCOUNT_RESTRICTED',
  'PROFILE_STACK_FAILED',
  'PROFILE_MIGRATION_FAILED',
  'PROFILE_PROBE_FAILED',
  'EXTRA_STACK_FAILED',
  'ENV_LOCK_TIMEOUT',
  'RUNNER_TIMEOUT',
  'RUNNER_QUEUE_TIMEOUT',
  'RUNNER_ERROR',
  'WORKSTATION_FAILED',
]);

/**
 * Classify one failed runner build. `result` is runs/<runId>/result.json (null when the build never wrote it: queue
 * timeout or infrastructure error), `buildStatus` the CodeBuild status from the `.sync` error (TIMED_OUT, FAILED…).
 */
export function classifyRunnerFailure(op: AtlOp | string, result: RunnerResultFacts | null, buildStatus: string | null): Classification {
  const base = { notAFailure: false, repairState: false };
  const runnerCode = result?.classification?.code && KNOWN_CODES.has(result.classification.code) ? (result.classification.code as FailureCode) : null;
  if (!result) {
    if (buildStatus === 'TIMED_OUT') return { ...base, retryable: true, code: 'RUNNER_TIMEOUT', hint: 'the build timed out; the next build waits for stable stacks first' };
    if (buildStatus === 'QUEUE_TIMEOUT' || buildStatus === 'QUEUED') return { ...base, retryable: true, code: 'RUNNER_QUEUE_TIMEOUT', hint: 'CodeBuild queue timeout (low concurrency quota?)' };
    return { ...base, retryable: true, code: 'RUNNER_ERROR', hint: 'the build produced no result.json (infrastructure error)' };
  }
  const exit = result.exitCode ?? null;
  const text = [result.error ?? '', ...(result.cfnFailures ?? []).map((f) => f.reason ?? '')].join('\n');
  switch (exit) {
    case 0:
      if (buildStatus === 'TIMED_OUT') return { ...base, retryable: true, code: 'RUNNER_TIMEOUT', hint: 'the build timed out after scripts/module finished' };
      return { ...base, retryable: true, code: runnerCode ?? 'RUNNER_ERROR', hint: 'scripts/module succeeded but the build failed (post_build)' };
    case 2:
      return { ...base, retryable: false, code: runnerCode === 'PROFILE_DIGEST_MISMATCH' ? 'PROFILE_DIGEST_MISMATCH' : 'PROFILE_RULES', hint: 'card definition or registry error — reported to the administrator' };
    case 3: {
      if (CAPACITY_RE.test(text)) return { ...base, retryable: result.firstCreate !== false, code: 'CAPACITY', hint: 'insufficient capacity: retry in another AZ once' };
      if (THROTTLE_RE.test(text)) return { ...base, retryable: true, code: runnerCode ?? defaultCodeFor(op), hint: 'throttling or a transient AWS error' };
      if (RESTRICTED_RE.test(text)) return { ...base, retryable: false, code: 'ACCOUNT_RESTRICTED', hint: 'the account is restricted for this resource (see the AWS message)' };
      if (QUOTA_RE.test(text)) return { ...base, retryable: false, code: 'ACCOUNT_QUOTA', hint: 'a service quota is too low (Service Quotas)' };
      if (ACCESS_RE.test(text)) return { ...base, retryable: false, code: 'ACCESS_DENIED', hint: 'permission denied (boundary, SCP or a missing provisioner permission)' };
      return { ...base, retryable: false, code: runnerCode ?? defaultCodeFor(op), hint: null };
    }
    case 4:
      return { ...base, retryable: true, code: 'PROFILE_MIGRATION_FAILED', hint: 'migration failed and was rolled back' };
    case 5:
      return { ...base, retryable: true, code: op === 'base-deploy' ? 'BASE_BOOTSTRAP_FAILED' : 'PROFILE_PROBE_FAILED', hint: 'health probe failed and was rolled back' };
    case 6:
      return { retryable: false, code: null, hint: 'stacks partly deleted (ledger written): the reclaimer continues', notAFailure: true, repairState: false };
    case 7:
      return { ...base, retryable: true, code: 'ENV_LOCK_TIMEOUT', hint: 'the environment operation lock was busy or lost' };
    case 8:
      return { retryable: true, code: 'RUNNER_ERROR', hint: 'state.json conditional write failed: the next build repairs the state first', notAFailure: false, repairState: true };
    default:
      if (buildStatus === 'TIMED_OUT') return { ...base, retryable: true, code: 'RUNNER_TIMEOUT', hint: 'the build timed out' };
      return { ...base, retryable: false, code: runnerCode ?? 'RUNNER_ERROR', hint: null };
  }
}

/** Build status from a `.sync` task error (`Cause` is the JSON `{ Build: {...} }` of the failed build). */
export function buildStatusOf(error: unknown): string | null {
  const e = error as { Error?: string; Cause?: string } | null;
  if (!e) return null;
  if (e.Error === 'States.Timeout') return 'TIMED_OUT';
  try {
    const c = JSON.parse(e.Cause ?? '') as { Build?: { BuildStatus?: string; buildStatus?: string } };
    return c.Build?.BuildStatus ?? c.Build?.buildStatus ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Deadline, extensions, keep (02 §5.1, §5.4, §8.1)

/** T05: deadlineAt = ceilToMinute(readyAt + timeLimitMinutes). */
export function initialDeadline(readyAtMs: number, timeLimitMinutes: number): number {
  return ceilToMinute(readyAtMs + timeLimitMinutes * MIN);
}

export interface ExtensionCheck {
  ok: boolean;
  error: 'Atl.SessionExpiringOrEnded' | 'Atl.ExtensionLimit' | 'Atl.PreconditionFailed' | 'Atl.BudgetBlocked' | 'Atl.PlatformUninstalling' | 'Atl.LimitExceeded' | null;
  message: string;
  newDeadlineMs: number;
}

export function extensionLimits(card: CardSnapshot, cfg: PlatformConfigView): { maxCount: number; minutesEach: number } {
  // a card may tighten the platform defaults, never loosen them (02 §5.4)
  return {
    maxCount: Math.min(card.extensions.maxCount, cfg.limits.extension.maxCount),
    minutesEach: Math.min(card.extensions.minutesEach, cfg.limits.extension.minutes),
  };
}

export function checkExtension(s: SessionRecord, cfg: PlatformConfigView, req: { minutes: number; expectedDeadlineVersion: number }, nowMs: number): ExtensionCheck {
  const no = (error: NonNullable<ExtensionCheck['error']>, message: string): ExtensionCheck => ({ ok: false, error, message, newDeadlineMs: NaN });
  if (cfg.mode === 'UNINSTALLING') return no('Atl.PlatformUninstalling', 'the platform is being uninstalled');
  if (cfg.budget.state === 'EXCEEDED' && cfg.budget.enforcement !== 'notify') return no('Atl.BudgetBlocked', 'the monthly budget is exceeded');
  if (!['READY', 'RUNNING', 'EXPIRING'].includes(s.state) || !s.deadlineAt) return no('Atl.SessionExpiringOrEnded', `session is ${s.state}`);
  const deadline = Date.parse(s.deadlineAt);
  if (nowMs >= deadline - 30_000) return no('Atl.SessionExpiringOrEnded', 'less than 30 seconds left');
  if ((s.deadlineVersion ?? 1) !== req.expectedDeadlineVersion) return no('Atl.PreconditionFailed', `deadlineVersion is ${s.deadlineVersion}`);
  const lim = extensionLimits(s.cardSnapshot, cfg);
  const used = s.extensions ?? [];
  if (!Number.isInteger(req.minutes) || req.minutes <= 0) return no('Atl.LimitExceeded', 'minutes must be a positive whole number');
  if (req.minutes > lim.minutesEach) return no('Atl.ExtensionLimit', `at most ${lim.minutesEach} minutes per extension`);
  if (used.length >= lim.maxCount) return no('Atl.ExtensionLimit', `at most ${lim.maxCount} extensions`);
  const usedMinutes = used.reduce((a, x) => a + x.minutes, 0);
  if (usedMinutes + req.minutes > lim.maxCount * lim.minutesEach) return no('Atl.ExtensionLimit', 'cumulative extension limit reached');
  const newDeadline = deadline + req.minutes * MIN; // deadline stays on a whole minute
  const readyAt = s.readyAt ? Date.parse(s.readyAt) : deadline - s.cardSnapshot.timeLimitMinutes * MIN;
  if (newDeadline - readyAt > cfg.limits.maxSessionMinutes * MIN) return no('Atl.ExtensionLimit', `the session would exceed MaxSessionMinutes (${cfg.limits.maxSessionMinutes})`);
  return { ok: true, error: null, message: 'ok', newDeadlineMs: newDeadline };
}

/** Maximum keep hours: min(MaxKeepHours, card retain.maxHours), never above the hard limit (02 §8.1). */
export function keepHoursLimit(card: CardSnapshot, cfg: PlatformConfigView): number {
  return Math.min(cfg.limits.maxKeepHours, cfg.limits.keepHardMaxHours, card.retain.maxHours ?? cfg.limits.maxKeepHours);
}

export const KEEP_HOURS_CHOICES = [1, 4, 12, 24] as const;

// ---------------------------------------------------------------------------------------------------------------
// Conclusion (02 §6.7) and rescan times (7.7)

export interface ReclaimSummary {
  passNo: number;
  mode: string;
  found: number;
  deleted: number;
  manual: number;
  blocking: number;
  review: number;
  info: number;
  hourlyBlocking: number;
  pending: number;
  [k: string]: unknown;
}

export function concludeState(endReason: EndReason | null | undefined, summary: Pick<ReclaimSummary, 'blocking'>): 'ENDED' | 'FAILED' | 'CLEANUP_FAILED' {
  return summary.blocking > 0 ? 'CLEANUP_FAILED' : terminalStateFor(endReason ?? null);
}

export function rescanTimes(revokedAtMs: number, offsetsMinutes: readonly number[]): string[] {
  return offsetsMinutes.map((m) => new Date(revokedAtMs + m * MIN).toISOString());
}

/** CLEANUP_FAILED auto-retries 1 h, 6 h and 24 h after entering the state (02 §5.7, §7.8). */
export const AUTO_RETRY_AFTER_MINUTES = [60, 360, 1440] as const;
