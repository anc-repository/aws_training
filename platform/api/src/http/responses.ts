/**
 * Response helpers shared by every route handler (01 §8.1): JSON bodies, `202 Accepted` with `Location`, `ETag` /
 * `If-None-Match` → `304`, `Cache-Control`. Errors are thrown as `AtlError` and rendered by the router.
 */
import { createHash } from 'node:crypto';
import { API_PREFIX } from '@atl/shared';
import { header, json, type HttpEvent, type HttpResult } from './types.js';

export const NO_STORE = { 'cache-control': 'no-store' } as const;

export function ok(body: unknown, headers: Record<string, string> = {}): HttpResult {
  return json(200, body, { ...NO_STORE, ...headers });
}

export function created(body: unknown, location?: string, headers: Record<string, string> = {}): HttpResult {
  return json(201, body, { ...NO_STORE, ...(location ? { location } : {}), ...headers });
}

/** Long operation accepted (01 §8.1): `202` + resource link. */
export function accepted(body: unknown, location?: string, headers: Record<string, string> = {}): HttpResult {
  return json(202, body, { ...NO_STORE, ...(location ? { location } : {}), ...headers });
}

export function noContent(headers: Record<string, string> = {}): HttpResult {
  return { statusCode: 204, headers: { ...NO_STORE, ...headers }, body: '' };
}

/** Absolute API path of a resource, e.g. `apiPath('/sessions', sid)` → `/api/v1/sessions/<sid>`. */
export function apiPath(...parts: string[]): string {
  return API_PREFIX + parts.map((p) => (p.startsWith('/') ? p : `/${encodeURIComponent(p)}`)).join('');
}

/** Weak ETag over the JSON of `body` without the volatile keys (e.g. `serverNow`). */
export function etagOf(body: unknown, exclude: readonly string[] = ['serverNow']): string {
  const stable = body && typeof body === 'object' && !Array.isArray(body) ? omitKeys(body as Record<string, unknown>, exclude) : body;
  const digest = createHash('sha256').update(JSON.stringify(stable ?? null)).digest('base64url').slice(0, 22);
  return `W/"${digest}"`;
}

/**
 * `200` with an ETag, or `304` when `If-None-Match` matches (01 §8.1: session view and progress support conditional
 * GET; the catalog uses `catalogVersion` as its ETag, 05 §8.8).
 */
export function withEtag(
  event: HttpEvent,
  body: unknown,
  opts: { etag?: string; exclude?: readonly string[]; cacheControl?: string } = {},
): HttpResult {
  const tag = opts.etag ?? etagOf(body, opts.exclude);
  const headers = { etag: tag, 'cache-control': opts.cacheControl ?? 'no-cache' };
  const inm = header(event, 'if-none-match');
  if (inm && inm.split(',').some((t) => normalizeTag(t) === normalizeTag(tag))) {
    return { statusCode: 304, headers, body: '' };
  }
  return json(200, body, headers);
}

function normalizeTag(t: string): string {
  return t.trim().replace(/^W\//, '');
}

function omitKeys(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** `If-Match: "<ver>"` (01 §7.5 item 4) → the expected version, or `undefined` when absent. */
export function ifMatchVersion(event: HttpEvent): number | undefined {
  const v = header(event, 'if-match');
  if (!v) return undefined;
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(v);
  return m ? Number(m[1]) : Number.NaN;
}
