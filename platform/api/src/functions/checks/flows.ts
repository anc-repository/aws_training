/**
 * atl-checks flows beyond a single check run (04 §8.4, §8.5, §8.9, §7.4; 02 §3.6, §6.4): submit and the final review,
 * `FinalizeAttempt` (never throws into the end workflow), the EXPIRING pre-check, the late ownership confirmation after
 * rescans, health gates, step actions, manual confirmations and the experiment cross-check.
 */
import { SkPrefix, type SessionState } from '@atl/shared';
import { Keys } from '../../data/keys.js';
import type { FunctionDeps } from '../../runtime/deps.js';
import { applyReview, completionOf, countChecks, ensureAttempt, newAttempt, scoredChecks, withdrawBadge } from '../../services/progress/attempt.js';
import { emitEvents, type PendingEvent } from '../../services/progress/events.js';
import { applyManual, computeStepStates, recomputeAndStore, effectiveWithPolicy } from '../../services/progress/evaluator.js';
import { mutate, type ItemStore } from '../../services/progress/store.js';
import type { LabAttemptItem, ManualRecord, StepResultItem } from '../../services/progress/types.js';
import { evaluateAll } from './engine/assert.js';
import { RunContext } from './engine/context.js';
import { experimentVerdict, labelsOf, validateRun, type ExperimentRunRecord, type LabMetrics, type ResultJson } from './engine/experiments.js';
import { FINAL_STEP, loadFacts, loadFactsLenient, planCard, type SessionFacts } from './engine/facts.js';
import { healthy } from './engine/healthy.js';
import type { CheckEnginePorts } from './engine/ports.js';
import { runChecks, type RunOutput } from './engine/run.js';
import { renderDeep } from './engine/template.js';
import type { AwsReadonlyCheck, ManualCheck } from './types.js';

const LIVE: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING'];

function nowIso(deps: FunctionDeps): string {
  return new Date(deps.ports.clock.nowMs()).toISOString();
}

async function experimentRuns(store: ItemStore, facts: SessionFacts): Promise<ExperimentRunRecord[]> {
  const own = await store.query<ExperimentRunRecord>(Keys.labSession(facts.session.sid).PK, { skPrefix: SkPrefix.experiment });
  const out = own.map((r) => normalizeRun(r, facts.session.sid));
  // same learner's earlier sessions of the same card in the hand-over chain may provide a baseline (04 §8.11 rule 4)
  for (const c of facts.chain.filter((x) => x.sub === facts.session.sub && x.labId === facts.session.labId)) {
    const runs = await store.query<ExperimentRunRecord>(Keys.labSession(c.sid).PK, { skPrefix: SkPrefix.experiment });
    out.push(...runs.map((r) => normalizeRun(r, c.sid)));
  }
  return out;
}

/** Fields of the agent-written item are normalized to the comparison record. */
export function normalizeRun(r: ExperimentRunRecord, sid: string): ExperimentRunRecord {
  const summary = (r.summary ?? {}) as { params?: Record<string, unknown> };
  return { ...r, sessionId: r.sessionId ?? sid, params: r.params ?? summary.params ?? {} };
}

function stepStatesOf(steps: Map<string, StepResultItem>): Map<string, string> {
  return new Map([...steps].map(([k, v]) => [k, v.state]));
}

// ---------------------------------------------------------------------------------------------------------------
// Submit / final review

export interface FinalizeResult {
  attemptStatus: string;
  checkRunId: string | null;
  missing: { stepId: string | null; checkKey: string; result: string }[];
  ownershipPending: string[];
  reportRevision: number | null;
  certificateEligible: boolean;
  completedAt: string | null;
  notes?: string[];
}

export async function submitAttempt(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, payload: { sessionId: string; requestedBy?: unknown }): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, payload.sessionId);
  if (!LIVE.includes(facts.session.state)) return { accepted: false, code: 'SESSION_NOT_RUNNING', state: facts.session.state };
  const at = nowIso(deps);
  if (!facts.attempt) facts.attempt = await ensureAttempt(store, facts, at);
  const from = facts.attempt.status;
  if (from !== 'completed') {
    await mutate<LabAttemptItem>(store, Keys.labAttempt(facts.session.sid), (cur) => (cur && cur.status !== 'completed' ? ({ ...cur, status: 'verifying' } as LabAttemptItem & Record<string, unknown>) : null), { now: () => at });
    await emitEvents(deps, store, [{ type: 'attempt.state_changed', sessionId: facts.session.sid, data: { from, to: 'verifying' } }]);
  }
  const out = await runChecks(deps, engine, store, { sessionId: facts.session.sid, scope: 'final', force: true, trigger: 'submit', requestedBy: payload.requestedBy as never }, facts);
  const runs = await experimentRuns(store, out.facts);
  const review = await applyReview(store, { facts: out.facts, plan: out.plan, steps: out.steps, runs }, stepStatesOf(out.steps), { mode: 'submit', nowIso: nowIso(deps), checkRunId: out.run.runId });
  await emitEvents(deps, store, review.events);
  if (review.attempt.status === 'completed' || review.attempt.status === 'completed_manual') {
    await deps.ports.invoker.invokeAsync('atl-certs', { action: 'GenerateReport', sessionId: facts.session.sid, reason: 'submit', preview: false }).catch(() => undefined);
  }
  return { attemptStatus: review.attempt.status, checkRunId: out.run.runId, missing: review.verdict.missing, badge: review.badge };
}

/** `FinalizeAttempt` (04 §8.5 contract): idempotent; re-test, wait for in-flight uploads, report v1, certificate check. */
export async function finalizeAttempt(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, payload: { sessionId: string; endReason?: string; budgetMs?: number }): Promise<FinalizeResult> {
  const t0 = deps.ports.clock.nowMs();
  const budget = payload.budgetMs ?? 8 * 60_000;
  const notes: string[] = [];
  let facts: SessionFacts;
  try {
    facts = await loadFacts(deps, store, payload.sessionId);
  } catch (e) {
    return { attemptStatus: 'unverified', checkRunId: null, missing: [], ownershipPending: [], reportRevision: null, certificateEligible: false, completedAt: null, notes: [`facts unavailable: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const prev = facts.attempt?.finalize;
  if (prev) {
    return { attemptStatus: prev.attemptStatus, checkRunId: prev.checkRunId, missing: (facts.attempt?.missing ?? []) as FinalizeResult['missing'], ownershipPending: facts.attempt?.ownershipPending ?? [], reportRevision: prev.reportRevision, certificateEligible: prev.certificateEligible, completedAt: facts.attempt?.completedAt ?? null, notes: prev.notes };
  }
  const at = nowIso(deps);
  if (!facts.session.readyAt) {
    // the session ended before READY: the attempt is void and does not count (04 §8.4)
    const a = await mutate<LabAttemptItem>(store, Keys.labAttempt(facts.session.sid), (cur) => ({ ...(cur ?? newAttempt(facts, at)), status: 'void', finalize: { at, checkRunId: null, attemptStatus: 'void', reportRevision: null, certificateEligible: false, notes: ['void: ended before READY'] } }) as LabAttemptItem & Record<string, unknown>, { now: () => at });
    return { attemptStatus: a!.status, checkRunId: null, missing: [], ownershipPending: [], reportRevision: null, certificateEligible: false, completedAt: null, notes: ['void'] };
  }
  if (!facts.attempt) facts.attempt = await ensureAttempt(store, facts, at);
  let out: RunOutput | null = null;
  let timedOut = false;
  try {
    out = await runChecks(
      deps,
      engine,
      store,
      { sessionId: facts.session.sid, scope: 'final', force: true, trigger: 'finalize', allowStates: ['READY', 'RUNNING', 'EXPIRING', 'ENDING'], budgetMs: Math.min(180_000, Math.floor(budget / 2)) },
      facts,
    );
  } catch (e) {
    timedOut = true;
    notes.push(`final review failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // wait (≤ half of the budget) for experiment uploads registered before ENDING
  const waitUntil = t0 + budget / 2;
  for (;;) {
    const runs = await store.query<Record<string, unknown>>(Keys.labSession(facts.session.sid).PK, { skPrefix: SkPrefix.experiment });
    const inFlight = runs.filter((r) => r.status === 'registered');
    if (inFlight.length === 0 || deps.ports.clock.nowMs() >= waitUntil) {
      if (inFlight.length) notes.push(`${inFlight.length} experiment upload(s) not received before finalization`);
      break;
    }
    await deps.ports.clock.sleep(10_000);
  }
  const f = out?.facts ?? (await loadFacts(deps, store, facts.session.sid));
  const plan = out?.plan ?? planCard(f.card);
  const runs = await experimentRuns(store, f);
  const review = await applyReview(store, { facts: f, plan, steps: f.steps, runs }, stepStatesOf(f.steps), { mode: 'finalize', nowIso: nowIso(deps), checkRunId: out?.run.runId ?? null, timedOut });
  const events: PendingEvent[] = [...review.events];
  // report snapshot v1 (no cleanup yet); failures are noted, never thrown
  let reportRevision: number | null = null;
  if (deps.ports.clock.nowMs() - t0 < budget) {
    try {
      const r = await deps.ports.invoker.invoke<{ revision?: number }>('atl-certs', { action: 'GenerateReport', sessionId: f.session.sid, reason: 'finalize' });
      reportRevision = r?.revision ?? null;
    } catch (e) {
      notes.push(`report not generated: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else notes.push('report skipped: budget exhausted');
  const cert = f.card.lab.certificate;
  const completed = review.attempt.status === 'completed' || review.attempt.status === 'completed_manual';
  const counts = countChecks(scoredChecks({ facts: f, plan, steps: f.steps, runs }));
  const release = await store.get<Record<string, unknown>>(Keys.catalogRelease(f.session.catalogVersion)).catch(() => null);
  const certificateEligible = !!cert?.enabled && completed && (cert.maxManualChecks === undefined || counts.manual <= cert.maxManualChecks) && release?.defective !== true;
  const result: FinalizeResult = {
    attemptStatus: review.attempt.status,
    checkRunId: out?.run.runId ?? null,
    missing: review.verdict.missing.map((m) => ({ stepId: m.stepId, checkKey: m.checkKey, result: m.result })),
    ownershipPending: review.verdict.ownershipPending,
    reportRevision,
    certificateEligible,
    completedAt: review.attempt.completedAt ?? null,
    ...(notes.length ? { notes } : {}),
  };
  await mutate<LabAttemptItem>(
    store,
    Keys.labAttempt(f.session.sid),
    (cur) => (cur ? ({ ...cur, finalize: { at: nowIso(deps), checkRunId: result.checkRunId, attemptStatus: review.attempt.status, reportRevision, certificateEligible, notes } } as LabAttemptItem & Record<string, unknown>) : null),
    { now: () => nowIso(deps) },
  );
  await emitEvents(deps, store, events);
  return result;
}

/** EXPIRING pre-check (04 §8.5): reminder of what is missing; never changes the attempt status. */
export async function expiringPrecheck(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, sid: string): Promise<Record<string, unknown>> {
  const out = await runChecks(deps, engine, store, { sessionId: sid, scope: 'final-preview', force: true, trigger: 'expiring-precheck' });
  const runs = await experimentRuns(store, out.facts);
  const steps = computeStepStates(out.facts, out.plan, out.steps, { whenFalse: new Set() });
  const verdict = completionOf({ facts: out.facts, plan: out.plan, steps: out.steps, runs }, steps as Map<string, string>);
  await mutate<LabAttemptItem>(store, Keys.labAttempt(sid), (cur) => (cur ? ({ ...cur, missing: verdict.missing, lastExpiringPrecheckAt: nowIso(deps) } as LabAttemptItem & Record<string, unknown>) : null), { now: () => nowIso(deps) });
  return { checkRunId: out.run.runId, missing: verdict.missing };
}

/** Late ownership confirmation after a rescan (04 §8.5): only the `ownershipPending` checks, only ownership. */
export async function lateOwnership(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, sid: string): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, sid);
  const a = facts.attempt;
  if (!a || a.status !== 'unverified' || a.ownershipPending.length === 0) return { skipped: true };
  const ids = a.ownershipPending.map((k) => k.slice(k.indexOf('/') + 1));
  const out = await runChecks(deps, engine, store, { sessionId: sid, scope: 'lab', checkIds: ids, force: true, trigger: 'late-ownership', allowStates: ['ENDING', 'CLEANING', 'ENDED', 'FAILED', 'CLEANUP_FAILED', 'KEPT'] }, facts);
  const runs = await experimentRuns(store, out.facts);
  const review = await applyReview(store, { facts: out.facts, plan: out.plan, steps: out.steps, runs }, stepStatesOf(out.steps), { mode: 'late-ownership', nowIso: nowIso(deps), checkRunId: out.run.runId });
  await emitEvents(deps, store, review.events);
  if (review.attempt.status !== a.status) await deps.ports.invoker.invokeAsync('atl-certs', { action: 'GenerateReport', sessionId: sid, reason: 'late-ownership' }).catch(() => undefined);
  return { attemptStatus: review.attempt.status };
}

/** `cleanup.verify` after the session reached a terminal state (04 §3.2.12): results go to the report only. */
export async function cleanupVerify(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, sid: string): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, sid);
  if (!(facts.card.lab.cleanup.verify ?? []).length) return { checks: 0 };
  const out = await runChecks(deps, engine, store, { sessionId: sid, scope: 'cleanup', force: true, trigger: 'auto', allowStates: ['ENDED', 'FAILED', 'CLEANUP_FAILED'] }, facts);
  return { checkRunId: out.run.runId, results: out.run.results.map((r) => ({ checkKey: r.checkKey, result: r.result })) };
}

// ---------------------------------------------------------------------------------------------------------------
// Health gates (02 §3.6, §4.4; 04 §6.4)

export interface HealthGateRequest {
  sessionId: string;
  envId?: string;
  gates?: ('base.ready' | 'caps.profile' | 'ws.ready')[];
  /** `{ module: driver }`; `*` = any driver (health only). Defaults to the start profile's module provisions. */
  expect?: Record<string, string>;
  expectedWarnings?: string[];
}

export async function healthGate(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, req: HealthGateRequest): Promise<Record<string, unknown>> {
  const facts = await loadFactsLenient(deps, store, req.sessionId);
  const rc = new RunContext(deps, engine, store, facts, { runId: `gate-${deps.ports.clock.nowMs()}`, force: true, nowMs: deps.ports.clock.nowMs() });
  const lab = facts.card.lab;
  const gates = req.gates ?? (facts.session.workstation?.mode === 'cloudshell' ? ['base.ready', 'caps.profile'] : ['base.ready', 'caps.profile', 'ws.ready']);
  const expect = req.expect ?? Object.fromEntries(lab.startProfile.provisions.filter((p) => p.kind === 'module').map((p) => [p.item, '*']));
  const expectedWarnings = req.expectedWarnings ?? lab.expectedWarnings ?? [];
  const out: Record<string, { ok: boolean; observed?: unknown; errorCode?: string | null; message?: string; diffs?: unknown }> = {};
  for (const gate of gates) {
    const d = gate === 'ws.ready' ? await rc.discover('workstation') : await rc.labInstance();
    if (!d.ok) {
      out[gate] = { ok: false, errorCode: d.code, message: d.message };
      continue;
    }
    const args = gate === 'caps.profile' ? { expect, expectedWarnings } : {};
    const [o] = await rc.runCheck(d.instances[0]!.instanceId, [{ key: 'gate', checkId: gate, args }], 60_000);
    if (o!.status !== 'ok') {
      out[gate] = { ok: false, errorCode: o!.errorCode, ...(o!.message ? { message: o!.message } : {}) };
      continue;
    }
    const obs = o!.observed as Record<string, unknown>;
    if (gate === 'base.ready') {
      const services = (obs.services ?? {}) as Record<string, string>;
      const ok = ['api', 'worker', 'nginx'].every((k) => services[k] === 'active') && obs.dataVolumeMounted === true && obs.platformEnvPresent === true && obs.probeTokenPresent === true;
      out[gate] = { ok, observed: obs };
    } else if (gate === 'caps.profile') {
      // the platform re-judges the observation with the same healthy() rule (04 §5.3)
      const mods = (obs.modules ?? {}) as Record<string, { driver?: string; status?: string }>;
      const validation = obs.validation as never;
      const exp = new Set(expectedWarnings);
      const diffs = Object.entries(expect)
        .map(([m, drv]) => {
          const mod = mods[m];
          const h = healthy(mod as never, validation, m, exp);
          const driverOk = drv === '*' || mod?.driver === drv;
          return driverOk && h.ok ? null : { module: m, expected: drv, driver: mod?.driver ?? null, status: mod?.status ?? null, why: driverOk ? h.why : 'driver' };
        })
        .filter(Boolean);
      out[gate] = { ok: diffs.length === 0, observed: obs, diffs };
    } else {
      out[gate] = { ok: obs.labuserPresent === true && obs.cliProfileOk === true, observed: obs };
    }
  }
  const ok = Object.values(out).every((g) => g.ok);
  return { ok, gates: out, checkedAt: nowIso(deps) };
}

// ---------------------------------------------------------------------------------------------------------------
// Step actions, manual confirmations

export async function stepAction(deps: FunctionDeps, store: ItemStore, p: { kind: 'read' | 'drift-ack' | 'skip' | 'unskip'; sessionId: string; stepId: string; by?: { sub?: string }; checkKey?: string; note?: string }): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, p.sessionId);
  const at = nowIso(deps);
  const step = facts.card.lab.steps.find((s) => s.id === p.stepId);
  if (!step) return { ok: false, reason: 'unknown step' };
  const optional = step.optional === true || (typeof step.optional === 'object' && step.optional !== null);
  if ((p.kind === 'skip' || p.kind === 'unskip') && !optional) return { ok: false, reason: 'step is not optional' };
  const updated = await mutate<StepResultItem>(store, Keys.stepResult(p.sessionId, p.stepId), (cur) => {
    const item: StepResultItem = cur ? { ...cur } : { type: 'StepResult', sessionId: p.sessionId, stepId: p.stepId, state: 'available', checks: {}, driftEvents: [], driftAcks: [], skipped: false, flags: [], ver: 0, createdAt: at, updatedAt: at };
    if (p.kind === 'read') {
      item.flags = [...new Set([...(item.flags ?? []), 'read'])];
      item.firstViewedAt ??= at;
    } else if (p.kind === 'skip') item.skipped = true;
    else if (p.kind === 'unskip') item.skipped = false;
    else item.driftAcks = [...(item.driftAcks ?? []), { at, by: p.by?.sub ?? 'learner', checkIds: p.checkKey ? [p.checkKey] : Object.keys(item.checks ?? {}) }].slice(-20);
    return item as StepResultItem & Record<string, unknown>;
  }, { now: () => at });
  facts.steps.set(p.stepId, updated!);
  const events = await recomputeAndStore(store, facts, planCard(facts.card), facts.steps, { whenFalse: new Set(), nowIso: at });
  await emitEvents(deps, store, events);
  return { ok: true, state: facts.steps.get(p.stepId)?.state ?? null };
}

/**
 * A learner's manual confirmation (04 §8.8): native for `manual` checks; degraded only for `aws-readonly` whose latest
 * automatic result is `error/ACCESS_DENIED|NOT_ALLOWED`; never over an automatic fail. Pasted evidence is checked with
 * the same assertions (`manual_evidence`), otherwise the record counts as plain `manual`.
 */
export async function applyManualConfirmation(deps: FunctionDeps, store: ItemStore, p: { sessionId: string; stepId: string; checkId: string; confirmationId: string }): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, p.sessionId);
  const item = await store.get<Record<string, unknown>>(Keys.manualConfirmation(p.sessionId, p.stepId, p.checkId, p.confirmationId));
  if (!item) return { applied: false, reason: 'confirmation not found' };
  const plan = planCard(facts.card);
  const planned = plan.find((x) => x.localId === p.checkId && x.stepId === p.stepId);
  if (!planned) return { applied: false, reason: 'check not in step' };
  const prev = facts.steps.get(p.stepId)?.checks?.[p.checkId];
  const native = planned.decl.type === 'manual';
  if (!native) {
    const lastCode = prev?.lastAuto?.errorCode;
    const degradable = planned.decl.type === 'aws-readonly' && (lastCode === 'ACCESS_DENIED' || lastCode === 'NOT_ALLOWED');
    if (!degradable || prev?.lastDecisive?.result === 'fail') return { applied: false, reason: 'manual confirmation cannot replace this automatic result' };
  }
  let result: 'manual' | 'manual_evidence' = 'manual';
  const evidence = typeof item.evidence === 'string' ? item.evidence : null;
  if (evidence) {
    const spec = native ? (planned.decl as ManualCheck).spec : (planned.decl as AwsReadonlyCheck).manualFallback;
    const asserts = spec?.evidence?.assert ?? [];
    try {
      const parsed = JSON.parse(evidence);
      const rc = new RunContext(deps, { aws: { call: async () => ({}) }, http: { fetch: async () => [], resolve: async () => [] }, ipRanges: { ranges: async () => [] }, config: { bundleDigest: null } }, store, facts, { runId: 'manual', force: false, nowMs: deps.ports.clock.nowMs() });
      const rendered = await renderDeep(asserts, { resolve: rc.resolve, self: parsed });
      if (asserts.length && evaluateAll(rendered, undefined, parsed).ok) result = 'manual_evidence';
    } catch {
      result = 'manual';
    }
  }
  const at = nowIso(deps);
  const rec: ManualRecord = {
    confirmationId: p.confirmationId,
    kind: native ? 'native' : 'degraded',
    result,
    observed: String(item.observed ?? ''),
    note: String(item.note ?? ''),
    at: String(item.createdAt ?? at),
    by: String(item.submittedBy ?? 'learner'),
  };
  const updated = await mutate<StepResultItem>(store, Keys.stepResult(p.sessionId, p.stepId), (cur) => {
    const s: StepResultItem = cur ? { ...cur, checks: { ...cur.checks } } : { type: 'StepResult', sessionId: p.sessionId, stepId: p.stepId, state: 'available', checks: {}, driftEvents: [], driftAcks: [], skipped: false, flags: [], ver: 0, createdAt: at, updatedAt: at };
    s.checks[p.checkId] = applyManual(s.checks[p.checkId], rec, planned.checkKey, planned, planned.decl.type);
    return s as StepResultItem & Record<string, unknown>;
  }, { now: () => at });
  if (result !== item.result) await store.put({ ...(item as Record<string, unknown> & { PK: string; SK: string }), result, updatedAt: at }).catch(() => undefined);
  facts.steps.set(p.stepId, updated!);
  const events = await recomputeAndStore(store, facts, plan, facts.steps, { whenFalse: new Set(), nowIso: at });
  await emitEvents(deps, store, events);
  return { applied: true, result, effective: updated!.checks[p.checkId]?.effective };
}

export async function applyManualReview(deps: FunctionDeps, store: ItemStore, p: { sessionId: string; stepId: string; checkId: string; confirmationId: string; decision: 'approve' | 'reject' }): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, p.sessionId);
  const item = await store.get<Record<string, unknown>>(Keys.manualConfirmation(p.sessionId, p.stepId, p.checkId, p.confirmationId));
  const review = (item?.review ?? { by: 'assistant', decision: p.decision, at: nowIso(deps) }) as ManualRecord['review'];
  const plan = planCard(facts.card);
  const planned = plan.find((x) => x.localId === p.checkId && x.stepId === p.stepId);
  if (!planned) return { applied: false };
  const at = nowIso(deps);
  const updated = await mutate<StepResultItem>(store, Keys.stepResult(p.sessionId, p.stepId), (cur) => {
    if (!cur?.checks?.[p.checkId]?.lastManual || cur.checks[p.checkId]!.lastManual!.confirmationId !== p.confirmationId) return null;
    const s: StepResultItem = { ...cur, checks: { ...cur.checks } };
    const c = { ...s.checks[p.checkId]!, lastManual: { ...s.checks[p.checkId]!.lastManual!, review: review! } };
    c.effective = effectiveWithPolicy(c, planned.drift.policy === 'once');
    s.checks[p.checkId] = c;
    return s as StepResultItem & Record<string, unknown>;
  }, { now: () => at });
  if (updated) facts.steps.set(p.stepId, updated);
  const events = await recomputeAndStore(store, facts, plan, facts.steps, { whenFalse: new Set(), nowIso: at });
  await emitEvents(deps, store, events);
  return { applied: !!updated };
}

// ---------------------------------------------------------------------------------------------------------------
// Experiment cross-check (04 §7.4)

export async function crossCheckExperiment(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, p: { sessionId: string; runId: string }): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, p.sessionId);
  const key = Keys.experimentRun(p.sessionId, p.runId);
  const run = await store.get<ExperimentRunRecord & Record<string, unknown>>(key);
  if (!run) return { validated: false, reason: 'run not found' };
  const exp = (facts.card.lab.experiments ?? []).find((e) => e.module === run.module && e.id === run.experiment);
  const at = nowIso(deps);
  let status: string;
  let reasons: string[];
  let server: Record<string, unknown> | undefined;
  let normalized: Partial<ExperimentRunRecord> = {};
  if (!exp || !labelsOf(exp).some((l) => l.id === run.label)) {
    status = 'invalid';
    reasons = ['LABEL_NOT_IN_LAB'];
  } else {
    const raw = typeof run.s3Key === 'string' ? await deps.ports.objects.get(deps.env.buckets.data, run.s3Key) : null;
    type FullResult = ResultJson & { scenario?: string; params?: Record<string, unknown>; environment?: { instanceType?: string; arch?: string } };
    const result: FullResult = raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as FullResult) : {};
    normalized = {
      ...(typeof result.scenario === 'string' ? { scenario: result.scenario } : {}),
      ...(result.params ? { params: result.params as Record<string, unknown> } : {}),
      environment: { ...(run.environment ?? {}), ...(result.environment?.instanceType ? { instanceType: result.environment.instanceType } : {}), ...(result.environment?.arch ? { arch: result.environment.arch } : {}) },
    };
    const rc = new RunContext(deps, engine, store, facts, { runId: `xchk-${p.runId}`, force: true, nowMs: deps.ports.clock.nowMs() });
    let metrics: LabMetrics | null = null;
    let driversNow: Record<string, string> | null = null;
    const lab = await rc.labInstance();
    if (lab.ok && LIVE.concat(['ENDING']).includes(facts.session.state)) {
      const id = lab.instances[0]!.instanceId;
      const [m, caps] = await rc.runCheck(id, [
        { key: 'm', checkId: 'lab-metrics-run', args: { runId: p.runId } },
        { key: 'caps', checkId: 'capability-snapshot', args: { view: 'public' } },
      ]);
      if (m?.status === 'ok') metrics = m.observed as LabMetrics;
      if (caps?.status === 'ok') {
        const mods = ((caps.observed as { modules?: Record<string, { driver?: string }> }).modules ?? {}) as Record<string, { driver?: string }>;
        driversNow = Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, v.driver ?? '']));
      }
    }
    // functional validity: corroborateWith checks with a pass inside the window (+10 min)
    const passes: string[] = [];
    if (exp.validity === 'functional') {
      const from = Date.parse(String(result.startedAt ?? run.startedAt ?? 0));
      const to = Date.parse(String(result.finishedAt ?? run.finishedAt ?? 0)) + 10 * 60_000;
      for (const st of facts.steps.values()) {
        for (const [id, c] of Object.entries(st.checks ?? {})) {
          const t = c.lastPass ? Date.parse(c.lastPass.at) : NaN;
          if (Number.isFinite(t) && t >= from && t <= to) passes.push(id);
        }
      }
    }
    const v = validateRun({
      exp,
      run: { ...run, ...normalized },
      result,
      driversAtRegistration: ((run.platformDrivers as { registration?: Record<string, string> } | undefined)?.registration ?? null) as Record<string, string> | null,
      driversAtUpload: driversNow,
      metrics,
      functionalPasses: passes,
    });
    status = v.status;
    reasons = v.reasons;
    server = v.server;
  }
  const prevStatus = run.validity?.status;
  await mutate<Record<string, unknown>>(store, key, (cur) => (cur ? { ...cur, ...normalized, validity: { status, reasons, at }, ...(server ? { server } : {}) } : null), { now: () => at });
  const events: PendingEvent[] = [{ type: 'experiment_run.validated', sessionId: p.sessionId, data: { runId: p.runId, label: run.label, validity: status, reasons } }];
  await emitEvents(deps, store, events);
  // re-judge experiment checks that reference this experiment
  const plan = planCard(facts.card).filter((x) => x.decl.type === 'experiment' && (x.decl as { module: string; experiment: string }).module === run.module && (x.decl as { experiment: string }).experiment === run.experiment);
  if (plan.length && LIVE.concat(['ENDING']).includes(facts.session.state)) {
    await runChecks(deps, engine, store, { sessionId: p.sessionId, scope: 'lab', checkIds: plan.map((x) => x.localId), trigger: 'auto', allowStates: [...LIVE, 'ENDING'] });
  }
  // a completing run turned invalid after the fact → badge withdrawn (04 §8.6)
  if (prevStatus === 'pending-crosscheck' && status === 'invalid' && facts.attempt && (facts.attempt.status === 'completed' || facts.attempt.status === 'completed_manual')) {
    if (await withdrawBadge(store, facts.session.sub, facts.session.labId, facts.session.sid, 'evidence-invalidated', at)) {
      await emitEvents(deps, store, [{ type: 'badge.withdrawn', sessionId: p.sessionId, data: { sub: facts.session.sub, labId: facts.session.labId, reason: 'evidence-invalidated' } }]);
      await deps.ports.invoker.invokeAsync('atl-certs', { action: 'EvidenceInvalidated', sub: facts.session.sub, labId: facts.session.labId, attemptId: facts.session.sid }).catch(() => undefined);
    }
  }
  if (prevStatus === 'pending-crosscheck' && status === 'valid' && facts.attempt?.status?.startsWith('completed')) {
    const runs = await experimentRuns(store, facts);
    const fresh = await loadFacts(deps, store, p.sessionId);
    const review = await applyReview(store, { facts: fresh, plan: planCard(fresh.card), steps: fresh.steps, runs }, stepStatesOf(fresh.steps), { mode: 'late-ownership', nowIso: at, checkRunId: null });
    await emitEvents(deps, store, review.events);
  }
  return { validated: true, status, reasons, verdict: exp ? experimentVerdict(exp, await experimentRuns(store, facts)).ok : false };
}

/** Experiment registration hook: the platform's own capability snapshot at registration time (04 §7.4 step 4). */
export async function experimentRegistered(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, p: { sessionId: string; runId: string }): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, p.sessionId);
  const rc = new RunContext(deps, engine, store, facts, { runId: `xreg-${p.runId}`, force: true, nowMs: deps.ports.clock.nowMs() });
  const lab = await rc.labInstance();
  if (!lab.ok) return { recorded: false, reason: lab.message };
  const snap = await rc.capabilitySnapshot(lab.instances[0]!.instanceId, 'public');
  if (snap.status !== 'ok') return { recorded: false, reason: snap.message };
  const mods = ((snap.observed as { modules?: Record<string, { driver?: string }> }).modules ?? {}) as Record<string, { driver?: string }>;
  const drivers = Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, v.driver ?? '']));
  const at = nowIso(deps);
  await mutate<Record<string, unknown>>(store, Keys.experimentRun(p.sessionId, p.runId), (cur) => (cur ? { ...cur, platformDrivers: { ...((cur.platformDrivers as object) ?? {}), registration: drivers, registrationAt: at } } : null), { now: () => at });
  return { recorded: true, drivers };
}

/** Lazy drift patrol (04 §5.8): monitor checks of achieved steps, at most every 10 minutes, driven by progress polls. */
export async function driftPatrol(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, sid: string): Promise<Record<string, unknown>> {
  const facts = await loadFacts(deps, store, sid);
  if (!LIVE.includes(facts.session.state) || !facts.attempt) return { skipped: true };
  const last = facts.attempt.lastDriftPatrolAt ? Date.parse(facts.attempt.lastDriftPatrolAt) : 0;
  if (deps.ports.clock.nowMs() - last < 10 * 60_000) return { skipped: true, reason: 'patrolled recently' };
  const plan = planCard(facts.card);
  const ids = plan.filter((x) => x.drift.monitor && x.stepId !== FINAL_STEP && ['done', 'done_manual', 'drifted'].includes(facts.steps.get(x.stepId ?? '')?.state ?? '')).map((x) => x.localId);
  const at = nowIso(deps);
  await mutate<LabAttemptItem>(store, Keys.labAttempt(sid), (cur) => (cur ? ({ ...cur, lastDriftPatrolAt: at } as LabAttemptItem & Record<string, unknown>) : null), { now: () => at });
  if (!ids.length) return { checks: 0 };
  const out = await runChecks(deps, engine, store, { sessionId: sid, scope: 'lab', checkIds: ids, trigger: 'auto' }, facts);
  return { checkRunId: out.run.runId, checks: ids.length };
}
