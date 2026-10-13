/**
 * atl-checks — check engine, health gates, FinalizeAttempt, submit, manual confirmations, experiment cross-checks
 * (04 §5–§8, 02 §3.6, §6.4). Invoked by atl-api / atl-agent (async), by the state machines (sync) and by EventBridge
 * rules on `atl-events` (`session.state_changed`, `reclaim.pass_completed`).
 *
 * Action names: `FinalizeAttempt` is registered in 01; the others are listed in implementation-notes “platform-checks”
 * and in atl-api's DOWNSTREAM_ACTIONS (RunChecks, StepAction, SubmitAttempt, ApplyManualConfirmation,
 * ApplyManualReview, CrossCheckExperiment).
 */
import type { SessionState } from '@atl/shared';
import { ActionNotImplementedError, type ActionHandler, type DepsProvider, type FunctionDeps } from '../../runtime/deps.js';
import { ensureAttempt } from '../../services/progress/attempt.js';
import { DynamoItemStore, type ItemStore } from '../../services/progress/store.js';
import { prodEnginePorts } from './aws/engine-ports.js';
import { loadFacts } from './engine/facts.js';
import { preflight, runHealthGate } from './lifecycle-gates.js';
import type { EnginePortsProvider } from './engine/ports.js';
import { runChecks, type RunChecksRequest } from './engine/run.js';
import {
  applyManualConfirmation,
  applyManualReview,
  cleanupVerify,
  crossCheckExperiment,
  driftPatrol,
  experimentRegistered,
  expiringPrecheck,
  finalizeAttempt,
  healthGate,
  lateOwnership,
  stepAction,
  submitAttempt,
} from './flows.js';

export const FUNCTION_NAME = 'atl-checks';

export function storeOf(deps: FunctionDeps): ItemStore {
  return new DynamoItemStore(deps.db, deps.env.tableName);
}

type EngineAction = (payload: Record<string, unknown>, deps: FunctionDeps, engine: EnginePortsProvider) => Promise<unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const ENGINE_ACTIONS: Record<string, EngineAction> = {
  RunChecks: async (p, deps, engine) => {
    const out = await runChecks(deps, await engine(deps), storeOf(deps), p as unknown as RunChecksRequest);
    return { runId: out.run.runId, status: out.run.status, summary: out.run.summary ?? {} };
  },
  FinalizeAttempt: async (p, deps, engine) => {
    // never throw into atl-session-end: failures become `unverified` (04 §8.5)
    try {
      return await finalizeAttempt(deps, await engine(deps), storeOf(deps), { sessionId: str(p.sessionId), ...(typeof p.endReason === 'string' ? { endReason: p.endReason } : {}) });
    } catch (e) {
      return { attemptStatus: 'unverified', checkRunId: null, missing: [], ownershipPending: [], reportRevision: null, certificateEligible: false, completedAt: null, notes: [`finalize error: ${e instanceof Error ? e.message : String(e)}`] };
    }
  },
  SubmitAttempt: async (p, deps, engine) => submitAttempt(deps, await engine(deps), storeOf(deps), { sessionId: str(p.sessionId), requestedBy: p.requestedBy }),
  HealthGate: async (p, deps, engine) => healthGate(deps, await engine(deps), storeOf(deps), p as never),
  // the start workflow's calls (02 §3.5, §4.4) with the lifecycle's request / result shapes
  Preflight: async (p, deps, engine) => preflight(deps, await engine(deps), storeOf(deps), p as never),
  RunHealthGate: async (p, deps, engine) => runHealthGate(deps, await engine(deps), storeOf(deps), p as never),
  StepAction: async (p, deps) => stepAction(deps, storeOf(deps), p as never),
  ApplyManualConfirmation: async (p, deps) => applyManualConfirmation(deps, storeOf(deps), p as never),
  ApplyManualReview: async (p, deps) => applyManualReview(deps, storeOf(deps), p as never),
  CrossCheckExperiment: async (p, deps, engine) => crossCheckExperiment(deps, await engine(deps), storeOf(deps), { sessionId: str(p.sessionId), runId: str(p.runId) }),
  ExperimentRegistered: async (p, deps, engine) => experimentRegistered(deps, await engine(deps), storeOf(deps), { sessionId: str(p.sessionId), runId: str(p.runId) }),
  ExpiringPrecheck: async (p, deps, engine) => expiringPrecheck(deps, await engine(deps), storeOf(deps), str(p.sessionId)),
  LateOwnership: async (p, deps, engine) => lateOwnership(deps, await engine(deps), storeOf(deps), str(p.sessionId)),
  CleanupVerify: async (p, deps, engine) => cleanupVerify(deps, await engine(deps), storeOf(deps), str(p.sessionId)),
  DriftPatrol: async (p, deps, engine) => driftPatrol(deps, await engine(deps), storeOf(deps), str(p.sessionId)),
};

const TERMINAL: readonly SessionState[] = ['ENDED', 'FAILED', 'CLEANUP_FAILED'];

/** EventBridge events from `atl-events` (04 §12.3 consumed events). */
export async function onBusEvent(event: { 'detail-type'?: string; detail?: Record<string, unknown> }, deps: FunctionDeps, engine: EnginePortsProvider): Promise<unknown> {
  const type = event['detail-type'];
  const d = event.detail ?? {};
  const sid = str(d.sessionId);
  if (!sid) return { ignored: true };
  if (type === 'session.state_changed') {
    const to = str(d.to) as SessionState;
    const store = storeOf(deps);
    if (to === 'READY') {
      const facts = await loadFacts(deps, store, sid);
      await ensureAttempt(store, facts, new Date(deps.ports.clock.nowMs()).toISOString());
      return { attempt: 'active' };
    }
    if (to === 'EXPIRING') return expiringPrecheck(deps, await engine(deps), store, sid);
    if (TERMINAL.includes(to)) {
      const facts = await loadFacts(deps, store, sid).catch(() => null);
      if (facts && !facts.session.readyAt) {
        await ensureAttempt(store, facts, new Date(deps.ports.clock.nowMs()).toISOString(), 'void');
        return { attempt: 'void' };
      }
      const verify = await cleanupVerify(deps, await engine(deps), store, sid).catch((e: unknown) => ({ error: String(e) }));
      await deps.ports.invoker.invokeAsync('atl-certs', { action: 'GenerateReport', sessionId: sid, reason: 'cleanup' }).catch(() => undefined);
      return { cleanupVerify: verify };
    }
    return { ignored: true };
  }
  if (type === 'reclaim.pass_completed') return lateOwnership(deps, await engine(deps), storeOf(deps), sid);
  return { ignored: true };
}

/** Extra / test actions (looked up at call time, before the engine actions). */
export const ACTIONS: Record<string, ActionHandler> = {};

/**
 * `createChecksHandler(getDeps, actions?, engine?)`: production passes `prodEnginePorts` (functions/checks/index.ts);
 * the ATL_DEV_MODE runtime passes the dev engine from `functions/checks/dev/engine-ports.ts` (prodEnginePorts refuses
 * to run in dev mode, so a missing wiring never reaches AWS).
 */
export function createChecksHandler(getDeps: DepsProvider, actions?: Record<string, ActionHandler>, engine: EnginePortsProvider = prodEnginePorts) {
  return async (event: unknown): Promise<unknown> => {
    if (event && typeof event === 'object' && 'detail-type' in event) return onBusEvent(event as never, await getDeps(), engine);
    const payload = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
    const action = typeof payload.action === 'string' ? payload.action : '';
    const extra = (actions ?? ACTIONS)[action];
    if (extra) return extra(payload, await getDeps());
    const fn = ENGINE_ACTIONS[action];
    if (!fn) throw new ActionNotImplementedError(FUNCTION_NAME, action || '(none)');
    return fn(payload, await getDeps(), engine);
  };
}
