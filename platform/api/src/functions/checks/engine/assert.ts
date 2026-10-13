/**
 * Assertion evaluation (04 §5.3): the 21 operators, `where` filters, `severity`, `anyOf`, `pendingIf`, and the
 * capability-only `healthy`. Values are rendered (templates) by the caller before evaluation.
 */
import type { AssertOp, Assertion, AssertionOutcome } from '../types.js';
import { healthy, type CapModule, type Validation } from './healthy.js';
import { query, relative } from './jsonpath.js';

export interface HealthyContext {
  moduleId: string;
  validation?: Validation;
  expected: ReadonlySet<string>;
}

export interface AssertContext {
  /** Required for `op: healthy` (capability checks). */
  healthy?: HealthyContext;
  /** Collects expected warnings hit by `healthy`. */
  expectedHit?: Set<string>;
}

const MAX_REGEX = 256;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // primitives: allow number vs numeric string ("8080" vs 8080) and boolean vs "true"
    if ((typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'string' || typeof b === 'boolean')) {
      return typeof a !== typeof b && String(a) === String(b);
    }
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function safeRegex(pattern: unknown): RegExp {
  if (typeof pattern !== 'string' || pattern.length > MAX_REGEX) throw new SyntaxError('regex must be a string ≤ 256 chars');
  // RE2-compatible subset: no backreferences / lookarounds (catastrophic backtracking guard)
  if (/\\[1-9]|\(\?[=!<]/.test(pattern)) throw new SyntaxError('regex uses backreferences or lookarounds');
  return new RegExp(pattern);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function len(v: unknown): number | null {
  if (Array.isArray(v) || typeof v === 'string') return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return null;
}

/** Does `item` satisfy the `where` map? Values are literals or `{ op, value }`. */
export function matchesWhere(item: unknown, where: Record<string, unknown>, ctx: AssertContext = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    const actual = relative(item, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && 'op' in (cond as object)) {
      const c = cond as { op: AssertOp; value?: unknown };
      if (!applyOp(c.op, actual, c.value, ctx).ok) return false;
    } else if (!deepEqual(actual, cond)) return false;
  }
  return true;
}

export function applyOp(op: AssertOp, actual: unknown, expected: unknown, ctx: AssertContext = {}): { ok: boolean; note?: string } {
  switch (op) {
    case 'eq':
      return { ok: deepEqual(actual, expected) };
    case 'neq':
      return { ok: !deepEqual(actual, expected) };
    case 'in':
      return { ok: Array.isArray(expected) && expected.some((e) => deepEqual(actual, e)) };
    case 'nin':
      return { ok: Array.isArray(expected) && !expected.some((e) => deepEqual(actual, e)) };
    case 'exists':
      return { ok: actual !== undefined && actual !== null };
    case 'absent':
      return { ok: actual === undefined || actual === null };
    case 'contains':
      if (typeof actual === 'string') return { ok: actual.includes(String(expected)) };
      if (Array.isArray(actual)) return { ok: actual.some((x) => deepEqual(x, expected)) };
      return { ok: false };
    case 'icontains': {
      const e = String(expected).toLowerCase();
      if (typeof actual === 'string') return { ok: actual.toLowerCase().includes(e) };
      if (Array.isArray(actual)) return { ok: actual.some((x) => typeof x === 'string' && x.toLowerCase().includes(e)) };
      return { ok: false };
    }
    case 'startsWith':
      return { ok: typeof actual === 'string' && actual.startsWith(String(expected)) };
    case 'endsWith':
      return { ok: typeof actual === 'string' && actual.endsWith(String(expected)) };
    case 'matches':
      return { ok: typeof actual === 'string' && safeRegex(expected).test(actual) };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = num(actual);
      const b = num(expected);
      if (a === null || b === null) return { ok: false };
      return { ok: op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b };
    }
    case 'len_eq':
    case 'len_gte':
    case 'len_lte': {
      const a = len(actual);
      const b = num(expected);
      if (a === null || b === null) return { ok: false };
      return { ok: op === 'len_eq' ? a === b : op === 'len_gte' ? a >= b : a <= b };
    }
    case 'every':
    case 'some': {
      if (!Array.isArray(actual)) return { ok: false };
      const subs = (Array.isArray(expected) ? expected : [expected]) as Assertion[];
      const pred = (el: unknown) => subs.every((s) => evaluateAssertion(s, el, ctx).ok);
      return { ok: op === 'every' ? actual.every(pred) : actual.some(pred) };
    }
    case 'healthy': {
      const h = ctx.healthy;
      if (!h) return { ok: false, note: 'healthy is only valid in capability checks' };
      const v = healthy(actual as CapModule | undefined, h.validation, h.moduleId, h.expected);
      v.expectedHit.forEach((r) => ctx.expectedHit?.add(r));
      return { ok: v.ok, ...(v.why ? { note: v.why } : v.note ? { note: v.note } : {}) };
    }
  }
}

/** Evaluate one (already rendered) assertion against the main evidence. */
export function evaluateAssertion(a: Assertion, evidence: unknown, ctx: AssertContext = {}): AssertionOutcome {
  const severity = a.severity ?? 'error';
  let actual: unknown;
  let ok: boolean;
  let note: string | undefined;
  try {
    actual = query(evidence, a.path);
    if (a.where) {
      const list = Array.isArray(actual) ? actual : actual === undefined || actual === null ? [] : [actual];
      actual = list.filter((it) => matchesWhere(it, a.where!, ctx));
    }
    const r = applyOp(a.op, actual, a.value, ctx);
    ok = r.ok;
    note = r.note;
  } catch (e) {
    ok = false;
    note = e instanceof Error ? e.message : String(e);
  }
  return {
    ...(a.label !== undefined ? { label: a.label } : {}),
    path: a.path,
    op: a.op,
    ...(a.value !== undefined ? { expected: a.value } : {}),
    actual: summarizeActual(actual),
    ok,
    severity,
    ...(note ? { note } : {}),
  };
}

/** Keep evidence tables small: long arrays / strings are summarized. */
function summarizeActual(v: unknown): unknown {
  if (typeof v === 'string' && v.length > 512) return `${v.slice(0, 509)}…`;
  if (Array.isArray(v) && v.length > 20) return [...v.slice(0, 20), `…(+${v.length - 20})`];
  return v;
}

export interface AssertSetOutcome {
  /** All error-severity assertions of (one group of) the set are satisfied. */
  ok: boolean;
  outcomes: AssertionOutcome[];
}

/** `assert: [...]` (AND; warn-severity failures are recorded but never fail) and `anyOf: [[...], [...]]` (OR of AND). */
export function evaluateAll(assert: readonly Assertion[] | undefined, anyOf: readonly Assertion[][] | undefined, evidence: unknown, ctx: AssertContext = {}): AssertSetOutcome {
  const outcomes: AssertionOutcome[] = [];
  let ok = true;
  for (const a of assert ?? []) {
    const o = evaluateAssertion(a, evidence, ctx);
    outcomes.push(o);
    if (!o.ok && o.severity === 'error') ok = false;
  }
  if (anyOf && anyOf.length > 0) {
    let anyOk = false;
    const groupOutcomes: AssertionOutcome[] = [];
    for (const group of anyOf) {
      const g = group.map((a) => evaluateAssertion(a, evidence, ctx));
      groupOutcomes.push(...g);
      if (g.every((o) => o.ok || o.severity === 'warn')) {
        anyOk = true;
        outcomes.push(...g);
        break;
      }
    }
    if (!anyOk) {
      ok = false;
      outcomes.push(...groupOutcomes);
    }
  }
  return { ok, outcomes };
}

/** `pendingIf`: any satisfied assertion makes the result pending (04 §5.3). */
export function isPending(pendingIf: readonly Assertion[] | undefined, evidence: unknown, ctx: AssertContext = {}): boolean {
  return (pendingIf ?? []).some((a) => evaluateAssertion(a, evidence, ctx).ok);
}
