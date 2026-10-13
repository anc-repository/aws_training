/**
 * Pagination (01 §8.1): `?limit=` (default 20, max 100) + `?cursor=` — an opaque cursor whose content is HMAC-signed
 * so that it cannot be edited into a key of another partition. The cursor also carries a scope string (the query's
 * partition and prefix); decoding with a different scope fails, so even a valid cursor cannot be replayed against
 * another list.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AtlError, base64UrlToUtf8, utf8ToBase64Url } from '@atl/shared';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function parseLimit(query: Record<string, string>, def = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const raw = query.limit;
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new AtlError('VALIDATION_FAILED', 'limit must be a positive integer');
  return Math.min(n, max);
}

export type DynamoKey = Record<string, unknown>;

export interface CursorCodec {
  encode(scope: string, key: DynamoKey | undefined): string | null;
  decode(scope: string, cursor: string | undefined): DynamoKey | undefined;
}

/** HMAC-SHA256 cursor codec. `secret` comes from the function configuration (see `cursorSecret()`). */
export function createCursorCodec(secret: string): CursorCodec {
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    encode(scope, key) {
      if (!key) return null;
      const payload = utf8ToBase64Url(JSON.stringify({ s: scope, k: key }));
      return `${payload}.${sign(payload)}`;
    },
    decode(scope, cursor) {
      if (!cursor) return undefined;
      const [payload, mac] = cursor.split('.');
      if (!payload || !mac) throw new AtlError('VALIDATION_FAILED', 'invalid cursor');
      const expected = Buffer.from(sign(payload));
      const got = Buffer.from(mac);
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new AtlError('VALIDATION_FAILED', 'invalid cursor');
      let parsed: { s?: unknown; k?: unknown };
      try {
        parsed = JSON.parse(base64UrlToUtf8(payload)) as { s?: unknown; k?: unknown };
      } catch {
        throw new AtlError('VALIDATION_FAILED', 'invalid cursor');
      }
      if (parsed.s !== scope || !parsed.k || typeof parsed.k !== 'object') throw new AtlError('VALIDATION_FAILED', 'cursor does not belong to this list');
      return parsed.k as DynamoKey;
    },
  };
}

/**
 * Cursor secret: `ATL_CURSOR_SECRET` when the template sets one, otherwise derived from the account and table (the
 * scope check above is what prevents partition hopping; the HMAC only makes cursors opaque and tamper-evident).
 */
export function cursorSecret(env: { accountId: string; tableName: string }, processEnv: NodeJS.ProcessEnv = process.env): string {
  return processEnv.ATL_CURSOR_SECRET && processEnv.ATL_CURSOR_SECRET.length >= 16
    ? processEnv.ATL_CURSOR_SECRET
    : `atl-cursor:${env.accountId}:${env.tableName}`;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}
