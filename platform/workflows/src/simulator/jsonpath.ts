/**
 * JSONPath subset of ASL “reference paths”: `$`, `$.a.b`, `$.a[0]`, `$['a b']`, `$$.Execution.Name`.
 * No wildcards, filters or slices (ASL reference paths do not allow them).
 */
import { StatesError } from './errors.js';

export type PathSegment = string | number;

export function parsePath(path: string): { root: '$' | '$$'; segments: PathSegment[] } {
  let i: number;
  let root: '$' | '$$';
  if (path.startsWith('$$')) {
    root = '$$';
    i = 2;
  } else if (path.startsWith('$')) {
    root = '$';
    i = 1;
  } else {
    throw new StatesError('States.Runtime', `invalid path: ${path}`);
  }
  const segments: PathSegment[] = [];
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      const m = /^\.([^.[\]]+)/.exec(path.slice(i));
      if (!m) throw new StatesError('States.Runtime', `invalid path: ${path}`);
      segments.push(m[1]!);
      i += m[0].length;
    } else if (ch === '[') {
      const rest = path.slice(i);
      const num = /^\[(\d+)\]/.exec(rest);
      const str = /^\['((?:[^'\\]|\\.)*)'\]/.exec(rest) ?? /^\["((?:[^"\\]|\\.)*)"\]/.exec(rest);
      if (num) {
        segments.push(Number(num[1]));
        i += num[0].length;
      } else if (str) {
        segments.push(str[1]!.replace(/\\(.)/g, '$1'));
        i += str[0].length;
      } else {
        throw new StatesError('States.Runtime', `unsupported path syntax: ${path}`);
      }
    } else {
      throw new StatesError('States.Runtime', `invalid path: ${path}`);
    }
  }
  return { root, segments };
}

const MISSING = Symbol('missing');

function walk(value: unknown, segments: PathSegment[]): unknown | typeof MISSING {
  let cur: unknown = value;
  for (const s of segments) {
    if (cur === null || typeof cur !== 'object') return MISSING;
    if (typeof s === 'number') {
      if (!Array.isArray(cur) || s >= cur.length) return MISSING;
      cur = cur[s];
    } else {
      if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return MISSING;
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  return cur;
}

/** Read a path; a missing field raises `States.Runtime` (as Step Functions does). */
export function readPath(path: string, input: unknown, context: unknown): unknown {
  const { root, segments } = parsePath(path);
  const v = walk(root === '$$' ? context : input, segments);
  if (v === MISSING) throw new StatesError('States.Runtime', `path ${path} does not exist in the input`);
  return v;
}

/** `IsPresent` semantics: does the path resolve? */
export function pathExists(path: string, input: unknown, context: unknown): boolean {
  const { root, segments } = parsePath(path);
  return walk(root === '$$' ? context : input, segments) !== MISSING;
}

/** ResultPath: write `value` into a deep copy of `input` at `path`, creating objects as needed. */
export function writePath(path: string, input: unknown, value: unknown): unknown {
  const { root, segments } = parsePath(path);
  if (root !== '$') throw new StatesError('States.Runtime', `ResultPath must start with $: ${path}`);
  if (segments.length === 0) return value;
  const base: unknown = input === null || typeof input !== 'object' ? {} : structuredClone(input);
  let cur = base as Record<string | number, unknown>;
  for (let k = 0; k < segments.length - 1; k++) {
    const s = segments[k]!;
    const next = cur[s];
    if (next === null || typeof next !== 'object') cur[s] = {};
    cur = cur[s] as Record<string | number, unknown>;
  }
  cur[segments[segments.length - 1]!] = value;
  return base;
}
