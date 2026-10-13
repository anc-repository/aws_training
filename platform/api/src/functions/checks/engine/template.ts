/**
 * Placeholders in check definitions (04 §4.4, §5.3 “值中的引用”):
 *   `{{ ns.path | filter[:arg] }}`   namespaces session / target / workstation / stack / cap / envfile / var / sample /
 *                                    learner / platform (resolved by the engine's resolver)
 *   `{{$.path}}`                     the main evidence of the current check
 *   `{{$check.<checkId>.path}}`      the latest pass evidence of another check of this attempt (must be in dependsOn)
 * A string that is exactly one placeholder keeps the value's type (numbers, arrays); otherwise values are interpolated.
 * `\{{` is a literal `{{`.
 */
import { query } from './jsonpath.js';

export class UnresolvedVarError extends Error {
  constructor(readonly ref: string) {
    super(`variable ${ref} is not available`);
    this.name = 'UnresolvedVarError';
  }
}

export interface TemplateScope {
  /** Namespace resolver (`session.region`, `stack.cdn.EnvCdnDistributionId`, …); `undefined` = unresolved. */
  resolve(ref: string): Promise<unknown> | unknown;
  /** Main evidence of the current check (`{{$.…}}`). */
  self?: unknown;
  /** Latest passing evidence by check id (`{{$check.<id>.…}}`). */
  checks?: Record<string, unknown>;
}

const PLACEHOLDER = /(\\?)\{\{\s*(.*?)\s*\}\}/g;
const WHOLE = /^\{\{\s*(.*?)\s*\}\}$/;

interface Parsed {
  ref: string;
  filters: { name: string; arg?: string }[];
}

function parseInner(inner: string): Parsed {
  const parts = splitPipes(inner);
  const ref = parts[0]!.trim();
  const filters = parts.slice(1).map((f) => {
    const t = f.trim();
    const i = t.indexOf(':');
    if (i < 0) return { name: t };
    let arg = t.slice(i + 1).trim();
    if (/^".*"$/.test(arg) || /^'.*'$/.test(arg)) arg = arg.slice(1, -1);
    return { name: t.slice(0, i).trim(), arg };
  });
  return { ref, filters };
}

function splitPipes(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === '|') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function maskAccountId(v: string): string {
  return v.replace(/\b(\d{8})(\d{4})\b/g, (_m, _a, b: string) => `********${b}`);
}

function applyFilter(v: unknown, f: { name: string; arg?: string }): unknown {
  const s = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  switch (f.name) {
    case 'default':
      return v === undefined || v === null || v === '' ? (f.arg ?? '') : v;
    case 'mask':
      return maskAccountId(s);
    case 'host':
      try {
        return new URL(s.includes('://') ? s : `https://${s}`).hostname;
      } catch {
        return s;
      }
    case 'trimScheme':
      return s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    case 'shell':
      return `'${s.replace(/'/g, `'\\''`)}'`;
    case 'url':
      return encodeURIComponent(s);
    case 'json':
      return JSON.stringify(v ?? null);
    case 'lower':
      return s.toLowerCase();
    case 'upper':
      return s.toUpperCase();
    default:
      throw new SyntaxError(`unknown filter: ${f.name}`);
  }
}

async function resolveOne(p: Parsed, scope: TemplateScope): Promise<unknown> {
  let v: unknown;
  if (p.ref.startsWith('$check.')) {
    const rest = p.ref.slice('$check.'.length);
    const dot = rest.indexOf('.');
    const id = dot < 0 ? rest : rest.slice(0, dot);
    const path = dot < 0 ? '$' : `$${rest.slice(dot)}`;
    const ev = scope.checks?.[id];
    v = ev === undefined ? undefined : query(ev, path);
  } else if (p.ref === '$' || p.ref.startsWith('$.') || p.ref.startsWith('$[')) {
    v = scope.self === undefined ? undefined : query(scope.self, p.ref);
  } else {
    v = await scope.resolve(p.ref);
  }
  const hasDefault = p.filters.some((f) => f.name === 'default');
  if ((v === undefined || v === null) && !hasDefault) throw new UnresolvedVarError(p.ref);
  for (const f of p.filters) v = applyFilter(v, f);
  return v;
}

export function hasPlaceholder(s: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  for (const m of s.matchAll(PLACEHOLDER)) if (!m[1]) return true;
  return false;
}

/** References used in a string (`session.region`, `$.first.json.now`, …). */
export function placeholderRefs(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(PLACEHOLDER)) if (!m[1]) out.push(parseInner(m[2]!).ref);
  return out;
}

export async function renderString(s: string, scope: TemplateScope): Promise<unknown> {
  const whole = WHOLE.exec(s);
  if (whole && !s.startsWith('\\')) return resolveOne(parseInner(whole[1]!), scope);
  let out = '';
  let last = 0;
  for (const m of s.matchAll(PLACEHOLDER)) {
    out += s.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[1]) {
      out += m[0].slice(1);
      continue;
    }
    const v = await resolveOne(parseInner(m[2]!), scope);
    out += typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out + s.slice(last);
}

/** Render every string inside a JSON-like value. */
export async function renderDeep<T>(value: T, scope: TemplateScope): Promise<T> {
  if (typeof value === 'string') return (await renderString(value, scope)) as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await renderDeep(v, scope));
    return out as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await renderDeep(v, scope);
    return out as T;
  }
  return value;
}

/** Collect every namespace reference of a JSON-like value (for prefetching and `NOT_FOUND_VAR` reporting). */
export function collectRefs(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') for (const r of placeholderRefs(value)) out.add(r);
  else if (Array.isArray(value)) for (const v of value) collectRefs(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectRefs(v, out);
  return out;
}
