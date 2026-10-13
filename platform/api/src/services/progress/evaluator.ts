/**
 * ProgressEvaluator (04 §5.8, §8.2, §8.3, §8.9): folds check results into `StepResult` items (effective results, sticky
 * `once` passes, drift events), recomputes every step state, and returns the `atl.progress` events to emit.
 * Writes are per item with optimistic locking, so concurrent runs merge instead of overwriting each other.
 */
import { Keys } from '../../data/keys.js';
import { FINAL_STEP, type PlannedCheck, type SessionFacts } from '../../functions/checks/engine/facts.js';
import type { CheckResultItem, EffectiveResult } from '../../functions/checks/types.js';
import { effectiveResult, isAchieved, stepState } from './model.js';
import type { PendingEvent } from './events.js';
import { mutate, type ItemStore } from './store.js';
import type { CheckState, DriftClass, DriftEvent, ManualRecord, StepResultItem, StepState } from './types.js';

const MAX_PASS_EVIDENCE = 2048;

export function driftClassOf(type: string): DriftClass {
  if (type === 'aws-readonly') return 'config';
  if (type === 'capability') return 'runtime';
  return 'behavior';
}

/** Effective result with the drift policy applied: a passed `once` check stays passed (04 §5.8), except experiments. */
export function effectiveWithPolicy(c: CheckState, sticky: boolean): EffectiveResult {
  const eff = effectiveResult(c);
  if (sticky && c.firstPassAt && c.type !== 'experiment' && eff !== 'pass') return 'pass';
  return eff;
}

export function newStepResult(sid: string, stepId: string, nowIso: string): StepResultItem {
  return { type: 'StepResult', sessionId: sid, stepId, state: 'available', checks: {}, driftEvents: [], driftAcks: [], skipped: false, flags: [], ver: 0, createdAt: nowIso, updatedAt: nowIso };
}

/** Fold one result into a check state; returns the drift event when a must-hold pass turned into a fail. */
export function foldResult(
  prev: CheckState | undefined,
  r: CheckResultItem,
  p: Pick<PlannedCheck, 'drift' | 'required'>,
  opts: { acceptedDrift?: boolean; superseded?: boolean; runId?: string } = {},
): { state: CheckState; drift: DriftEvent | null } {
  const runId = opts.runId ?? r.evidence?.checkRunId ?? '';
  const s: CheckState = { checkKey: r.checkKey, required: p.required, effective: 'not_run', drift: p.drift, type: r.type, ...(prev ?? {}) };
  s.required = p.required;
  s.drift = p.drift;
  s.type = r.type;
  let drift: DriftEvent | null = null;
  if (r.result !== 'not_run') {
    s.lastAuto = { result: r.result, at: r.at, runId, errorCode: r.error?.code ?? null, evidenceDigest: r.evidenceDigest };
  }
  if (r.result === 'pass' || r.result === 'fail') {
    const wasPass = s.lastDecisive?.result === 'pass' || (!s.lastDecisive && !!s.lastPass);
    if (r.result === 'fail' && wasPass && p.drift.policy === 'must-hold' && !opts.acceptedDrift && !opts.superseded) {
      drift = { checkId: r.checkId, checkKey: r.checkKey, kind: r.error?.code === 'OWNERSHIP_MISMATCH' ? 'ownership' : driftClassOf(r.type), at: r.at, runId, ...(s.lastPass ? { fromRunId: s.lastPass.runId } : {}) };
    }
    s.lastDecisive = { result: r.result, at: r.at, runId, errorCode: r.error?.code ?? null };
  }
  if (r.result === 'pass') {
    s.lastPass = {
      at: r.at,
      runId,
      evidenceDigest: r.evidenceDigest,
      ...(r.instanceIds ? { instanceIds: r.instanceIds } : {}),
      ...(r.provenance ? { provenance: r.provenance } : {}),
      ...(r.ownership?.resource ? { resource: r.ownership.resource } : {}),
    };
    s.firstPassAt ??= r.at;
    const obs = r.evidence?.observed;
    s.passEvidence = obs !== undefined && JSON.stringify(obs).length <= MAX_PASS_EVIDENCE ? obs : undefined;
    s.stale = false;
  }
  s.ownershipPending = r.error?.code === 'OWNERSHIP_PENDING';
  if (r.type === 'experiment') {
    s.simulated = r.simulated === true;
    s.pendingCrosscheck = r.pendingCrosscheck === true;
  }
  s.effective = effectiveWithPolicy(s, p.drift.policy === 'once' || !!opts.superseded);
  return { state: s, drift };
}

export function applyManual(prev: CheckState | undefined, m: ManualRecord, checkKey: string, p: Pick<PlannedCheck, 'drift' | 'required'>, type: string): CheckState {
  const s: CheckState = { checkKey, required: p.required, effective: 'not_run', drift: p.drift, type, ...(prev ?? {}) };
  s.lastManual = m;
  s.effective = effectiveWithPolicy(s, p.drift.policy === 'once');
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// step states

export interface StepContext {
  /** Steps whose `when` evaluated false (skipped). */
  whenFalse: Set<string>;
  /** Steps currently being verified by a running CheckRun. */
  running?: Set<string>;
}

function supersededSteps(facts: SessionFacts, steps: Map<string, StepResultItem>): Set<string> {
  const out = new Set<string>();
  for (const st of facts.card.lab.steps) {
    const r = steps.get(st.id);
    if (r && isAchieved(r.state)) for (const s of st.supersedes ?? []) out.add(s);
  }
  return out;
}

/** Pure recomputation of every step (and the `_final` pseudo step) from the stored check states. */
export function computeStepStates(facts: SessionFacts, plan: PlannedCheck[], steps: Map<string, StepResultItem>, ctx: StepContext): Map<string, StepState> {
  const out = new Map<string, StepState>();
  const superseded = supersededSteps(facts, steps);
  const enabled = new Set(facts.env?.enabledModules ?? []);
  const ordered = [...facts.card.lab.steps];
  for (const st of ordered) {
    const r = steps.get(st.id);
    const checks = plan.filter((p) => p.stepId === st.id && p.required);
    const eff = checks.map((p) => {
      const c = r?.checks?.[p.localId];
      return c ? effectiveWithPolicy(c, p.drift.policy === 'once' || superseded.has(st.id)) : p.decl.type === 'manual' ? 'needs_manual' : 'not_run';
    });
    const mustHoldFail = checks.some((p) => {
      const c = r?.checks?.[p.localId];
      return !!c && p.drift.policy === 'must-hold' && !superseded.has(st.id) && !!c.firstPassAt && effectiveWithPolicy(c, false) === 'fail';
    });
    const reqSteps = st.requires?.steps ?? [];
    const requiredStepsDone = reqSteps.every((id) => {
      const s = out.get(id) ?? steps.get(id)?.state;
      return s ? isAchieved(s) || s === 'skipped' : false;
    });
    const runtimeReqsMet = (st.requires?.runtime ?? []).every((m) => enabled.has(m));
    out.set(
      st.id,
      stepState({
        whenFalse: ctx.whenFalse.has(st.id),
        skippedByLearner: !!r?.skipped,
        requiredStepsDone,
        runtimeReqsMet,
        requiredChecks: eff,
        firstPassedAt: r?.firstPassedAt ?? null,
        hasMustHoldFailure: mustHoldFail,
        running: ctx.running?.has(st.id) ?? false,
        read: (r?.flags ?? []).includes('read'),
      }),
    );
  }
  // finalChecks as a pseudo step
  const finals = plan.filter((p) => p.stepId === FINAL_STEP && p.required);
  if (finals.length) {
    const r = steps.get(FINAL_STEP);
    const eff = finals.map((p) => {
      const c = r?.checks?.[p.localId];
      return c ? effectiveWithPolicy(c, p.drift.policy === 'once') : 'not_run';
    });
    out.set(FINAL_STEP, stepState({ whenFalse: false, skippedByLearner: false, requiredStepsDone: true, runtimeReqsMet: true, requiredChecks: eff, firstPassedAt: r?.firstPassedAt ?? null, hasMustHoldFailure: false, running: false }));
  }
  return out;
}

export interface EvaluateOutput {
  steps: Map<string, StepResultItem>;
  events: PendingEvent[];
  driftEvents: DriftEvent[];
}

/**
 * Persist results of one run and recompute step states. `acceptedDrift` keys are `<module>.<logicalId>.<path>`; a check
 * whose `drift` mentions an accepted property is not reported as drift (04 §5.8).
 */
export async function evaluateRun(
  store: ItemStore,
  facts: SessionFacts,
  plan: PlannedCheck[],
  results: CheckResultItem[],
  ctx: StepContext & { nowIso: string; runId: string },
): Promise<EvaluateOutput> {
  const sid = facts.session.sid;
  const byStep = new Map<string, CheckResultItem[]>();
  for (const r of results) {
    if (!r.stepId) continue;
    byStep.set(r.stepId, [...(byStep.get(r.stepId) ?? []), r]);
  }
  const superseded = supersededSteps(facts, facts.steps);
  const drifts: DriftEvent[] = [];
  const steps = new Map(facts.steps);
  for (const [stepId, rs] of byStep) {
    const updated = await mutate<StepResultItem>(store, Keys.stepResult(sid, stepId), (cur) => {
      const item: StepResultItem = cur ? { ...cur, checks: { ...cur.checks } } : newStepResult(sid, stepId, ctx.nowIso);
      for (const r of rs) {
        const p = plan.find((x) => x.localId === r.checkId && x.stepId === stepId);
        if (!p) continue;
        const { state, drift } = foldResult(item.checks[r.checkId], r, p, { superseded: superseded.has(stepId), runId: ctx.runId });
        item.checks[r.checkId] = state;
        if (drift) {
          item.driftEvents = [...(item.driftEvents ?? []), { ...drift, runId: ctx.runId }].slice(-50);
          drifts.push({ ...drift, runId: ctx.runId });
        }
      }
      if (!item.startedAt) item.startedAt = ctx.nowIso;
      return item as StepResultItem & Record<string, unknown>;
    }, { now: () => ctx.nowIso });
    if (updated) steps.set(stepId, updated);
  }
  const events = await recomputeAndStore(store, facts, plan, steps, ctx);
  for (const d of drifts) events.push({ type: 'step.drifted', sessionId: sid, data: { stepId: steps.get(stepOfCheck(plan, d.checkId) ?? '')?.stepId ?? null, checkKey: d.checkKey, kind: d.kind, runId: d.runId } });
  return { steps, events, driftEvents: drifts };
}

function stepOfCheck(plan: PlannedCheck[], localId: string): string | null {
  return plan.find((p) => p.localId === localId)?.stepId ?? null;
}

/** Recompute all step states and write the ones that changed; returns `step.state_changed` events. */
export async function recomputeAndStore(store: ItemStore, facts: SessionFacts, plan: PlannedCheck[], steps: Map<string, StepResultItem>, ctx: StepContext & { nowIso: string }): Promise<PendingEvent[]> {
  const sid = facts.session.sid;
  const states = computeStepStates(facts, plan, steps, ctx);
  const events: PendingEvent[] = [];
  for (const [stepId, state] of states) {
    const prev = steps.get(stepId);
    if (prev && prev.state === state) continue;
    const updated = await mutate<StepResultItem>(store, Keys.stepResult(sid, stepId), (cur) => {
      const item: StepResultItem = cur ? { ...cur } : newStepResult(sid, stepId, ctx.nowIso);
      if (item.state === state && cur) return null;
      const from = item.state;
      item.state = state;
      if ((state === 'done' || state === 'done_manual') && !item.firstPassedAt) item.firstPassedAt = ctx.nowIso;
      if (state === 'done' || state === 'done_manual') item.lastPassedAt = ctx.nowIso;
      events.push({ type: 'step.state_changed', sessionId: sid, data: { stepId, from, to: state } });
      return item as StepResultItem & Record<string, unknown>;
    }, { now: () => ctx.nowIso });
    if (updated) steps.set(stepId, updated);
  }
  return events;
}
