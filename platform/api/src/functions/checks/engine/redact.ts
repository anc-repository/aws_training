/**
 * Evidence redaction before anything is stored (04 §5.5): secrets and probe tokens become `‹redacted›`, correlation IDs
 * become `‹hash:…›` (SHA-256 prefix of the original, so evidence can still be compared), CloudFront origin custom header
 * values are always masked, plus the check's own `evidence.redact` paths. `evidence.keep` projects large AWS responses.
 * Account IDs and public IPs are masked later, on export and share (services/reports).
 */
import { createHash } from 'node:crypto';
import { formatPath, queryAll, setAt, type ConcretePath } from './jsonpath.js';

export const REDACTED = '‹redacted›';

export function hashMarker(value: string): string {
  return `‹hash:${createHash('sha256').update(value).digest('hex').slice(0, 12)}›`;
}

/** Keys whose values are secrets (case-insensitive, whole key or suffix). */
const SECRET_KEY = /(secret|password|passwd|token|private[_-]?key|credential|authorization|cookie|_key|apikey|api-key|accesskey|secretkey|x-origin-verify)$/i;
/** Correlation identifiers: hashed, not removed (04 §5.5). */
const CORRELATION_KEY = /^(x-amz-cf-id|x-amzn-requestid|x-amzn-request-id|x-amz-request-id|x-amz-id-2|x-amzn-trace-id|requestid|request-id|cfid)$/i;
/** Probe tokens of 06 PM-09 / PM-13 / lab tokens: `atlpk1.`, `atlpt1.`, `atllt1.` prefixes. */
const PROBE_TOKEN_VALUE = /\batl(?:pk|pt|lt)[0-9]\.[A-Za-z0-9._~-]+/g;
/** Keys that must never be redacted even though they match SECRET_KEY (status flags, not values). */
const SAFE_KEYS = /^(probeTokenPresent|tokenPresent|present|hasToken|leakedKeys|passwordAuth|envHasKeys|credentialsFile)$/i;

/** Paths always redacted for every check (04 §5.5, §14 U-5). */
export const ALWAYS_REDACT = ['$..CustomHeaders.Items[*].HeaderValue', '$..tokens'];

export interface RedactResult<T> {
  value: T;
  redactions: string[];
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function walk(v: unknown, path: ConcretePath, visit: (key: string | number, value: unknown, path: ConcretePath, parent: Record<string | number, unknown>) => void): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      visit(i, x, [...path, i], v as unknown as Record<number, unknown>);
      walk((v as unknown[])[i], [...path, i], visit);
    });
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      visit(k, x, [...path, k], v as Record<string, unknown>);
      walk((v as Record<string, unknown>)[k], [...path, k], visit);
    }
  }
}

export function redactEvidence<T>(input: T, opts: { redact?: string[]; keepOnly?: string[] } = {}): RedactResult<T> {
  let value = clone(input);
  const redactions = new Set<string>();
  if (opts.keepOnly && opts.keepOnly.length > 0 && value && typeof value === 'object') {
    const projected: Record<string, unknown> = {};
    for (const p of opts.keepOnly) for (const m of queryAll(value, p)) projected[formatPath(m.path)] = m.value;
    value = { kept: projected } as unknown as T;
  }
  for (const p of [...ALWAYS_REDACT, ...(opts.redact ?? [])]) {
    for (const m of queryAll(value, p)) {
      if (m.value === undefined || m.value === REDACTED) continue;
      setAt(value, m.path, REDACTED);
      redactions.add(p);
    }
  }
  walk(value, [], (key, v, path, parent) => {
    if (typeof key === 'string' && SECRET_KEY.test(key) && !SAFE_KEYS.test(key) && v !== null && v !== undefined && typeof v !== 'boolean' && v !== REDACTED) {
      parent[key] = REDACTED;
      redactions.add(formatPath(path));
      return;
    }
    if (typeof key === 'string' && CORRELATION_KEY.test(key) && typeof v === 'string' && !v.startsWith('‹hash:')) {
      parent[key] = hashMarker(v);
      redactions.add(formatPath(path));
      return;
    }
    if (typeof v === 'string' && PROBE_TOKEN_VALUE.test(v)) {
      PROBE_TOKEN_VALUE.lastIndex = 0;
      parent[key] = v.replace(PROBE_TOKEN_VALUE, REDACTED);
      redactions.add(formatPath(path));
    }
    PROBE_TOKEN_VALUE.lastIndex = 0;
  });
  // cfIds[{id}] produced by nginx-log-summary: hash the ids
  for (const m of queryAll(value, '$..cfIds[*].id')) {
    if (typeof m.value === 'string' && !m.value.startsWith('‹hash:')) {
      setAt(value, m.path, hashMarker(m.value));
      redactions.add('$..cfIds[*].id');
    }
  }
  return { value, redactions: [...redactions].sort() };
}

/** Mask a 12-digit account ID and public IPv4 addresses in any string (export / share, 04 §9.4, §9.5). */
export function maskText(s: string, opts: { accountId?: boolean; ip?: boolean } = { accountId: true, ip: true }): string {
  let out = s;
  if (opts.accountId !== false) out = out.replace(/(?<![0-9])(\d{8})(\d{4})(?![0-9])/g, '********$2');
  if (opts.ip !== false) {
    out = out.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a: string, b: string) => {
      const n = [a, b].map(Number);
      // keep private / loopback addresses readable
      if (n[0] === 10 || n[0] === 127 || (n[0] === 172 && n[1]! >= 16 && n[1]! <= 31) || (n[0] === 192 && n[1] === 168)) return m;
      return `${a}.${b}.x.x`;
    });
  }
  return out;
}

/** Deep variant of `maskText`. */
export function maskDeep<T>(v: T, opts?: { accountId?: boolean; ip?: boolean }): T {
  if (typeof v === 'string') return maskText(v, opts) as T;
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, opts)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, opts)])) as T;
  return v;
}
