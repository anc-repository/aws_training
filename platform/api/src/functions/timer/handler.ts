/**
 * atl-timer — EventBridge Scheduler target: WARN_15, WARN_5, EXPIRE, READY_IDLE, KEEP_WARN_60, KEEP_WARN_15,
 * KEEP_EXPIRE, SHARE_EXPIRE and the periodic SWEEP (02 §5.3, §5.7). Dispatch on `kind`; unknown kinds throw
 * `Atl.NotImplemented`. Payload `{ kind, sessionId, deadlineVersion | keepVersion }` (01 §3.5).
 */
import { TIMER_KINDS, type TimerPayload } from '@atl/shared';
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';
import { makeCtx } from '../lifecycle/context.js';
import { handleTimer } from './kinds.js';
import { sweep } from './sweeper.js';

export const FUNCTION_NAME = 'atl-timer';

const timer: ActionHandler = (p, deps) => handleTimer(makeCtx(deps, 'scheduler'), p as unknown as Exclude<TimerPayload, { kind: 'SWEEP' }>);

export const ACTIONS: Record<string, ActionHandler> = {
  ...Object.fromEntries(TIMER_KINDS.filter((k) => k !== 'SWEEP').map((k) => [k, timer])),
  SWEEP: (_p, deps) => sweep(makeCtx(deps, 'sweeper')),
};

export function createTimerHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
