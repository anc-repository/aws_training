/**
 * Check runs (04 §5.9): load the pinned content and the session facts, plan the checks of the requested scope, execute
 * them in dependency order within the run budget (180 s), store the `CheckRun` (results append-only), fold the results
 * into `StepResult`s and emit `check_run.completed` / `step.*` events.
 */
import { newUlid, type CheckRunTrigger, type SessionState } from '@atl/shared';
import { Keys } from '../../../data/keys.js';
import type { FunctionDeps } from '../../../runtime/deps.js';
import { ensureAttempt } from '../../../services/progress/attempt.js';
import { emitEvents, type PendingEvent } from '../../../services/progress/events.js';
import { evaluateRun } from '../../../services/progress/evaluator.js';
import { ConflictError, mutate, type ItemStore } from '../../../services/progress/store.js';
import type { LabAttemptItem, StepResultItem } from '../../../services/progress/types.js';
import type { CheckResultItem, CheckRunItem, CheckRunScope } from '../types.js';
import { RunContext } from './context.js';
import { executeCheck } from './executors.js';
import { CLEANUP_STEP, FINAL_STEP, loadFacts, planCard, planCleanup, type PlannedCheck, type SessionFacts } from './facts.js';
import type { CheckEnginePorts } from './ports.js';

export const RUN_BUDGET_MS = 180_000;
export const CHECKABLE_STATES: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING'];

export interface RunChecksRequest {
  runId?: string;
  sessionId: string;
  stepId?: string | null;
  scope?: CheckRunScope;
  checkIds?: string[] | null;
  force?: boolean;
  trigger?: CheckRunTrigger;
  requestedBy?: { sub?: string; role?: string } | string | null;
  /** Health gates and finalization may run outside READY..EXPIRING. */
  allowStates?: readonly SessionState[];
  budgetMs?: number;
}

export interface RunOutput {
  run: CheckRunItem;
  facts: SessionFacts;
  plan: PlannedCheck[];
  steps: Map<string, StepResultItem>;
  events: PendingEvent[];
}

/** Order checks so that `dependsOn` targets run first (stable otherwise). */
export function orderByDependencies(items: PlannedCheck[]): PlannedCheck[] {
  const byId = new Map(items.map((p) => [p.localId, p]));
  const out: PlannedCheck[] = [];
  const seen = new Set<string>();
  const visit = (p: PlannedCheck, stack: Set<string>) => {
    if (seen.has(p.localId)) return;
    if (stack.has(p.localId)) return; // cycle: keep declaration order
    stack.add(p.localId);
    for (const d of p.decl.dependsOn ?? []) {
      const dep = byId.get(d);
      if (dep) visit(dep, stack);
    }
    stack.delete(p.localId);
    seen.add(p.localId);
    out.push(p);
  };
  for (const p of items) visit(p, new Set());
  return out;
}

function optionalStep(facts: SessionFacts, stepId: string | null): boolean {
  const st = facts.card.lab.steps.find((s) => s.id === stepId);
  return !!st && (st.optional === true || (typeof st.optional === 'object' && st.optional !== null));
}

/** Select the checks of a scope (04 §5.9, §8.5). */
export function selectChecks(facts: SessionFacts, plan: PlannedCheck[], req: Pick<RunChecksRequest, 'scope' | 'stepId' | 'checkIds'>): PlannedCheck[] {
  const scope = req.scope ?? (req.stepId ? 'step' : 'lab');
  let sel: PlannedCheck[];
  switch (scope) {
    case 'step':
      sel = plan.filter((p) => p.stepId === req.stepId);
      break;
    case 'final':
    case 'final-preview':
      sel = plan.filter((p) => p.required && !optionalStep(facts, p.stepId) && facts.steps.get(p.stepId ?? '')?.skipped !== true);
      // a passed `once` check stays passed; only must-hold checks and not-yet-passed ones are re-tested (04 §5.8)
      sel = sel.filter((p) => {
        if (p.drift.policy === 'must-hold' || p.decl.type === 'experiment') return true;
        return !facts.steps.get(p.stepId ?? '')?.checks?.[p.localId]?.firstPassAt;
      });
      break;
    case 'cleanup':
      sel = planCleanup(facts.card);
      break;
    default:
      sel = plan.filter((p) => p.stepId !== null);
  }
  if (req.checkIds && req.checkIds.length) sel = sel.filter((p) => req.checkIds!.includes(p.localId));
  return orderByDependencies(sel);
}

function summarize(results: CheckResultItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) out[r.result] = (out[r.result] ?? 0) + 1;
  return out;
}

async function whenFalseSteps(rc: RunContext): Promise<Set<string>> {
  const out = new Set<string>();
  for (const st of rc.facts.card.lab.steps) {
    const w = st.when ?? (typeof st.optional === 'object' && st.optional ? st.optional.when : undefined);
    if (!w) continue;
    try {
      if (!(await rc.when(w))) out.add(st.id);
    } catch {
      /* unresolvable expression → not skipped */
    }
  }
  return out;
}

function requesterOf(r: RunChecksRequest['requestedBy']): string {
  if (!r) return 'system';
  if (typeof r === 'string') return r;
  return r.sub ? `${r.role ?? 'user'}:${r.sub}` : 'system';
}

export async function runChecks(deps: FunctionDeps, engine: CheckEnginePorts, store: ItemStore, req: RunChecksRequest, preloaded?: SessionFacts): Promise<RunOutput> {
  const nowIso = () => new Date(deps.ports.clock.nowMs()).toISOString();
  const runId = req.runId ?? newUlid(deps.ports.clock.nowMs());
  const facts = preloaded ?? (await loadFacts(deps, store, req.sessionId));
  const plan = planCard(facts.card);
  const trigger: CheckRunTrigger = req.trigger ?? 'user';
  const scope: CheckRunScope = req.scope ?? (req.stepId ? 'step' : 'lab');
  const key = Keys.checkRun(req.sessionId, runId);
  const existing = await store.get<CheckRunItem>(key);
  if (existing && existing.status === 'done') return { run: existing, facts, plan, steps: facts.steps, events: [] };

  const allowed = req.allowStates ?? CHECKABLE_STATES;
  const base: CheckRunItem = {
    type: 'CheckRun',
    runId,
    sessionId: req.sessionId,
    stepId: req.stepId ?? null,
    scope,
    trigger,
    requestedBy: requesterOf(req.requestedBy),
    force: req.force ?? false,
    ...(req.checkIds?.length ? { checkIds: req.checkIds } : {}),
    status: 'running',
    startedAt: nowIso(),
    results: [],
    ver: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (!allowed.includes(facts.session.state)) {
    const done = { ...base, status: 'done' as const, finishedAt: nowIso(), summary: { rejected: 1 }, rejected: { code: 'SESSION_NOT_RUNNING', state: facts.session.state } };
    await store.put({ ...key, ...done, ver: 1 }).catch(() => undefined);
    return { run: done, facts, plan, steps: facts.steps, events: [] };
  }
  if (CHECKABLE_STATES.includes(facts.session.state) && !facts.attempt) facts.attempt = await ensureAttempt(store, facts, nowIso());
  try {
    await store.put({ ...key, ...base, ver: 1 }, { expectVer: existing ? Number((existing as { ver?: number }).ver ?? 0) : null });
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    // another invocation owns this run id (Lambda async retry): let it finish
    const cur = await store.get<CheckRunItem>(key);
    return { run: cur ?? base, facts, plan, steps: facts.steps, events: [] };
  }

  const rc = new RunContext(deps, engine, store, facts, { runId, force: req.force ?? (trigger === 'finalize' || trigger === 'submit'), nowMs: deps.ports.clock.nowMs() });
  const selected = selectChecks(facts, plan, { scope, ...(req.stepId ? { stepId: req.stepId } : {}), ...(req.checkIds ? { checkIds: req.checkIds } : {}) });
  const whenFalse = await whenFalseSteps(rc);
  const deadline = deps.ports.clock.nowMs() + (req.budgetMs ?? RUN_BUDGET_MS);
  const results: CheckResultItem[] = [];
  for (const p of selected) {
    if (p.stepId && whenFalse.has(p.stepId) && p.stepId !== FINAL_STEP && p.stepId !== CLEANUP_STEP) continue;
    if (deps.ports.clock.nowMs() >= deadline) {
      results.push(timeoutResult(p, rc));
      continue;
    }
    results.push(await executeCheck(p, rc, { deadlineMs: deadline }));
  }

  const finishedAt = nowIso();
  const run: CheckRunItem = { ...base, status: 'done', finishedAt, results, summary: summarize(results), ver: 2, updatedAt: finishedAt };
  await mutate<CheckRunItem>(store, key, () => run as CheckRunItem & Record<string, unknown>, { now: () => finishedAt });

  let steps = facts.steps;
  const events: PendingEvent[] = [];
  if (scope !== 'cleanup' && scope !== 'gate' && trigger !== 'expiring-precheck') {
    const ev = await evaluateRun(store, facts, plan, results, { whenFalse, nowIso: finishedAt, runId });
    steps = ev.steps;
    events.push(...ev.events);
  }
  // ownership lookup bookkeeping (rhythm across runs, 01 §3.12)
  if (facts.attempt && JSON.stringify(rc.lookups) !== JSON.stringify(facts.attempt.ownershipLookups ?? {})) {
    await mutate<LabAttemptItem>(store, Keys.labAttempt(req.sessionId), (cur) => (cur ? ({ ...cur, ownershipLookups: rc.lookups } as LabAttemptItem & Record<string, unknown>) : null), { now: () => finishedAt });
  }
  events.unshift({ type: 'check_run.completed', sessionId: req.sessionId, data: { runId, stepId: req.stepId ?? null, scope, trigger, summary: run.summary } });
  await emitEvents(deps, store, events);
  return { run, facts: { ...facts, steps }, plan, steps, events };
}

function timeoutResult(p: PlannedCheck, rc: RunContext): CheckResultItem {
  return {
    checkKey: p.checkKey,
    checkId: p.localId,
    stepId: p.stepId,
    source: p.decl.type === 'capability' ? 'PROBE' : p.decl.type === 'aws-readonly' ? 'AWS' : p.decl.type === 'experiment' ? 'EXP' : p.decl.type === 'manual' ? 'MANUAL' : 'LOCAL',
    type: p.decl.type,
    result: 'error',
    required: p.required,
    trust: 'medium',
    error: { code: 'TIMEOUT', message: 'check run budget exhausted' },
    evidence: null,
    evidenceDigest: '',
    corroboration: [],
    executor: { kind: 'lambda', function: 'atl-checks' },
    at: rc.nowIso(),
    keyAssertions: [],
    drift: p.drift,
  };
}
