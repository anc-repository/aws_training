/**
 * Structural validation of ASL definitions (self-written; complements the schema check of `asl-validator`, see
 * `validateAslWithLibrary()`). Checks what the schema cannot: transition targets, reachability, terminal states,
 * Retry/Catch placement, `States.ALL` last, and unexpanded skeleton placeholders such as `"<<LambdaRetry>>"` (02 §4.4).
 */
import type { AslDefinition, AslState, AslSubMachine } from './types.js';

export interface AslIssue {
  path: string;
  message: string;
}

const TYPES = new Set(['Task', 'Pass', 'Choice', 'Wait', 'Succeed', 'Fail', 'Parallel', 'Map']);
const TERMINAL = new Set(['Succeed', 'Fail']);
const RETRY_CATCH = new Set(['Task', 'Parallel', 'Map']);
const PATH_FIELDS = ['InputPath', 'OutputPath', 'ResultPath', 'SecondsPath', 'TimestampPath', 'ItemsPath', 'TimeoutSecondsPath', 'ErrorPath', 'CausePath'];

export function validateAslStructure(def: unknown, opts: { allowPlaceholders?: boolean } = {}): AslIssue[] {
  const issues: AslIssue[] = [];
  if (!def || typeof def !== 'object') return [{ path: '$', message: 'definition must be an object' }];
  const d = def as AslDefinition;
  if (d.QueryLanguage && d.QueryLanguage !== 'JSONPath') {
    issues.push({ path: '$.QueryLanguage', message: 'only JSONPath is supported by the ATL simulator' });
  }
  if (d.TimeoutSeconds !== undefined && !(Number.isInteger(d.TimeoutSeconds) && d.TimeoutSeconds > 0)) {
    issues.push({ path: '$.TimeoutSeconds', message: 'must be a positive integer' });
  }
  checkMachine(d, '$', issues);
  if (!opts.allowPlaceholders) {
    const text = JSON.stringify(def);
    for (const m of text.matchAll(/<<[A-Za-z0-9_]+>>/g)) issues.push({ path: '$', message: `unexpanded skeleton placeholder ${m[0]}` });
  }
  return issues;
}

function checkMachine(m: AslSubMachine, at: string, issues: AslIssue[]): void {
  if (!m.States || typeof m.States !== 'object' || Object.keys(m.States).length === 0) {
    issues.push({ path: `${at}.States`, message: 'States must be a non-empty object' });
    return;
  }
  const names = new Set(Object.keys(m.States));
  if (typeof m.StartAt !== 'string' || !names.has(m.StartAt)) {
    issues.push({ path: `${at}.StartAt`, message: `StartAt "${String(m.StartAt)}" is not a state` });
  }
  const edges = new Map<string, string[]>();
  for (const [name, state] of Object.entries(m.States)) {
    const p = `${at}.States.${name}`;
    if (name.length > 80) issues.push({ path: p, message: 'state name longer than 80 characters' });
    edges.set(name, checkState(state, p, names, issues));
  }
  // reachability
  const seen = new Set<string>();
  const stack = typeof m.StartAt === 'string' && names.has(m.StartAt) ? [m.StartAt] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const t of edges.get(n) ?? []) if (names.has(t)) stack.push(t);
  }
  for (const n of names) if (!seen.has(n)) issues.push({ path: `${at}.States.${n}`, message: 'state is unreachable from StartAt' });
}

function checkState(s: AslState, p: string, names: Set<string>, issues: AslIssue[]): string[] {
  const out: string[] = [];
  if (!s || typeof s !== 'object' || !TYPES.has(s.Type)) {
    issues.push({ path: `${p}.Type`, message: `unknown state type ${String(s?.Type)}` });
    return out;
  }
  const target = (field: string, value: unknown) => {
    if (typeof value !== 'string' || !names.has(value)) issues.push({ path: `${p}.${field}`, message: `transition target "${String(value)}" is not a state` });
    else out.push(value);
  };
  if (s.Type === 'Choice') {
    if (!Array.isArray(s.Choices) || s.Choices.length === 0) issues.push({ path: `${p}.Choices`, message: 'Choice needs at least one rule' });
    (s.Choices ?? []).forEach((r, i) => {
      if (r.Next === undefined) issues.push({ path: `${p}.Choices[${i}]`, message: 'top-level choice rule needs Next' });
      else target(`Choices[${i}].Next`, r.Next);
    });
    if (s.Default !== undefined) target('Default', s.Default);
    if (s.Next !== undefined || s.End !== undefined) issues.push({ path: p, message: 'Choice must not have Next or End' });
  } else if (TERMINAL.has(s.Type)) {
    if (s.Next !== undefined || s.End !== undefined) issues.push({ path: p, message: `${s.Type} must not have Next or End` });
  } else {
    const hasNext = s.Next !== undefined;
    const hasEnd = s.End === true;
    if (hasNext === hasEnd) issues.push({ path: p, message: 'exactly one of Next or End: true is required' });
    if (hasNext) target('Next', s.Next);
  }
  if (s.Type === 'Task' && (typeof s.Resource !== 'string' || !s.Resource)) issues.push({ path: `${p}.Resource`, message: 'Task needs a Resource' });
  if (s.Type === 'Wait') {
    const n = ['Seconds', 'SecondsPath', 'Timestamp', 'TimestampPath'].filter((k) => s[k] !== undefined).length;
    if (n !== 1) issues.push({ path: p, message: 'Wait needs exactly one of Seconds, SecondsPath, Timestamp, TimestampPath' });
  }
  if (s.Type === 'Parallel') {
    if (!Array.isArray(s.Branches) || s.Branches.length === 0) issues.push({ path: `${p}.Branches`, message: 'Parallel needs branches' });
    (s.Branches ?? []).forEach((b, i) => checkMachine(b, `${p}.Branches[${i}]`, issues));
  }
  if (s.Type === 'Map') {
    const proc = s.ItemProcessor ?? s.Iterator;
    if (!proc) issues.push({ path: p, message: 'Map needs ItemProcessor (or Iterator)' });
    else checkMachine(proc, `${p}.ItemProcessor`, issues);
  }
  for (const [field, list] of [
    ['Retry', s.Retry],
    ['Catch', s.Catch],
  ] as const) {
    if (list === undefined) continue;
    if (!RETRY_CATCH.has(s.Type)) issues.push({ path: `${p}.${field}`, message: `${field} is only allowed on Task, Parallel and Map` });
    if (!Array.isArray(list)) {
      issues.push({ path: `${p}.${field}`, message: `${field} must be an array` });
      continue;
    }
    list.forEach((r, i) => {
      if (!Array.isArray(r.ErrorEquals) || r.ErrorEquals.length === 0) issues.push({ path: `${p}.${field}[${i}]`, message: 'ErrorEquals must be non-empty' });
      else if (r.ErrorEquals.includes('States.ALL') && (r.ErrorEquals.length > 1 || i !== list.length - 1)) {
        issues.push({ path: `${p}.${field}[${i}]`, message: 'States.ALL must appear alone in the last rule' });
      }
      if (field === 'Catch') target(`Catch[${i}].Next`, (r as { Next?: string }).Next);
    });
  }
  for (const f of PATH_FIELDS) {
    const v = s[f];
    if (v !== undefined && v !== null && (typeof v !== 'string' || !v.startsWith('$'))) {
      issues.push({ path: `${p}.${f}`, message: `${f} must be a JSONPath starting with $` });
    }
  }
  return out;
}

export interface LibraryValidation {
  isValid: boolean;
  errorsText: string;
}

/**
 * Schema validation with the `asl-validator` package (loaded lazily so the simulator does not depend on it at run time).
 * The library mutates its input (it fills in `QueryLanguage`), so it gets a deep copy.
 */
export async function validateAslWithLibrary(def: unknown): Promise<LibraryValidation> {
  const mod = await import('asl-validator');
  const validator = (typeof mod === 'function' ? mod : (mod as unknown as { default: typeof mod }).default) as unknown as (
    d: object,
    o?: { checkPaths?: boolean; checkArn?: boolean },
  ) => { isValid: boolean; errorsText(separator?: string): string };
  const r = validator(structuredClone(def) as object, { checkPaths: true, checkArn: false });
  return { isValid: r.isValid, errorsText: r.isValid ? '' : r.errorsText('\n') };
}
