/**
 * Reconnect backoff (03 §3.5.9), aligned with the plugin's data channel retryer
 * (aws/session-manager-plugin `src/sessionmanagerplugin/session/sessionhandler.go` + `src/config/config.go`):
 * the initial delay is drawn once per episode in [100, 200) ms, multiplied by 2 per attempt, capped at 5 s, 5 attempts.
 */
import { RECONNECT_INITIAL_DELAY_MS, RECONNECT_MAX_ATTEMPTS, RECONNECT_MAX_DELAY_MS, RECONNECT_RETRY_BASE } from './constants.js';

export interface BackoffPolicy {
  /** Initial delay = initialDelayMs + floor(random × initialDelayMs). */
  initialDelayMs: number;
  factor: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: Readonly<BackoffPolicy> = Object.freeze({
  initialDelayMs: RECONNECT_INITIAL_DELAY_MS,
  factor: RECONNECT_RETRY_BASE,
  maxDelayMs: RECONNECT_MAX_DELAY_MS,
  maxAttempts: RECONNECT_MAX_ATTEMPTS,
});

export function initialDelay(policy: BackoffPolicy, random: () => number): number {
  return policy.initialDelayMs + Math.floor(Math.min(0.999999, Math.max(0, random())) * policy.initialDelayMs);
}

/** Delay before attempt `attempt` (0-based) of an episode whose initial delay is `initial`. */
export function backoffDelay(attempt: number, initial: number, policy: BackoffPolicy): number {
  return Math.min(policy.maxDelayMs, Math.round(initial * policy.factor ** Math.max(0, attempt)));
}
