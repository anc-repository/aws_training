/**
 * Identifiers — 01 §3.9 “标识格式” (name table row “标识”).
 *
 * Pure functions; randomness comes from WebCrypto (`globalThis.crypto.getRandomValues`, available in Node 22 and browsers).
 */
import { bytesToBase64Url } from './encoding.js';
import { RUN_ID_OP_ABBREV, type AtlOp } from './runner.js';

/** Crockford Base32 alphabet, lowercase (no i, l, o, u). */
export const CROCKFORD_LOWER = '0123456789abcdefghjkmnpqrstvwxyz';
/** Crockford Base32 alphabet, uppercase. */
export const CROCKFORD_UPPER = CROCKFORD_LOWER.toUpperCase();

/** Session ID: `s` + 12 lowercase Crockford Base32 characters (01 §3.9). */
export const SID_RE = /^s[0-9a-hjkmnp-tv-z]{12}$/;
/** Environment ID: lowercase ULID (26 Crockford characters; first char 0–7). */
export const ENV_ID_RE = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
/** Environment name: `e` + 7 lowercase letters/digits (= CloudAlbum `Env`). */
export const ENV_NAME_RE = /^e[0-9a-z]{7}$/;
/** Card ID: `svc-*` / `sc-*`, ≤ 24 chars after the prefix (01 §3.9; 04 `$defs.cardId` maxLength 28). */
export const CARD_ID_RE = /^(svc|sc)-[a-z0-9]+(-[a-z0-9]+)*$/;
/** Variant: kebab-case, default `default` (04 `startVariant.id` is `^[a-z][a-z0-9-]{1,23}$`). */
export const VARIANT_RE = /^[a-z][a-z0-9-]{1,23}$/;
/** Learning-path ID: kebab-case ≤ 32 (04 `$defs.trackId`). */
export const TRACK_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** Card-owned stack id (`extraStacks[].id`, 01 §3.9 “卡片自带栈”). */
export const STACK_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
/** Certificate ID: `ATL-` + 4 groups of 4 uppercase Base32 (Crockford alphabet; 01 §3.9 example `ATL-7K2M-9Q4X-1ABZ-C3DE`). */
export const CERT_ID_RE = /^ATL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
/** Event / run ULID (uppercase or lowercase accepted when parsing). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
/** Runner run ID: `<sid>-<op abbrev>-<n>[-<m>]` (01 §3.9; 02 §4.3 example `s4k7m2q9x1abc-apply-1-0`). */
export const RUN_ID_RE = /^(s[0-9a-hjkmnp-tv-z]{12})-([a-z]+)-([0-9]{1,4})(?:-([0-9]{1,4}))?$/;
/** Installation ID: UUID v4. */
export const INSTALLATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const DEFAULT_VARIANT = 'default';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** n random characters from a 32-letter alphabet (rejection-free: 256 is a multiple of 32). */
export function randomBase32(n: number, alphabet: string = CROCKFORD_LOWER): string {
  const bytes = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[bytes[i]! & 31];
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// sid

export function newSid(): string {
  return `s${randomBase32(12)}`;
}

export function isSid(value: unknown): value is string {
  return typeof value === 'string' && SID_RE.test(value);
}

export function assertSid(value: unknown): string {
  if (!isSid(value)) throw new TypeError(`invalid session id: ${String(value)} (expected ${SID_RE.source})`);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// ULID (event IDs, run IDs, envId)

/** Encode a millisecond timestamp as 10 Crockford characters. */
function encodeTime(ms: number, alphabet: string): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > 2 ** 48 - 1) throw new RangeError(`ULID time out of range: ${ms}`);
  let s = '';
  let t = Math.floor(ms);
  for (let i = 0; i < 10; i++) {
    s = alphabet[t % 32]! + s;
    t = Math.floor(t / 32);
  }
  return s;
}

/** ULID (uppercase by default, as event / run IDs in 01 §3.9). Not monotonic within a millisecond. */
export function newUlid(nowMs: number = Date.now(), opts: { lowercase?: boolean } = {}): string {
  const alphabet = opts.lowercase ? CROCKFORD_LOWER : CROCKFORD_UPPER;
  return encodeTime(nowMs, alphabet) + randomBase32(16, alphabet);
}

/** Millisecond timestamp encoded in a ULID (either case). */
export function ulidTime(ulid: string): number {
  if (!ULID_RE.test(ulid)) throw new TypeError(`invalid ULID: ${ulid}`);
  let t = 0;
  for (const ch of ulid.slice(0, 10).toLowerCase()) t = t * 32 + CROCKFORD_LOWER.indexOf(ch);
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// envId / envName

export function newEnvId(nowMs: number = Date.now()): string {
  return newUlid(nowMs, { lowercase: true });
}

export function isEnvId(value: unknown): value is string {
  return typeof value === 'string' && ENV_ID_RE.test(value);
}

/**
 * `envName` = `e` + 7 lowercase characters derived from the envId's random part (01 §3.9 “由环境 ID 派生，碰撞时重新生成”):
 * the last 7 characters of the ULID. On a collision the caller generates a new envId.
 */
export function envNameFromEnvId(envId: string): string {
  if (!isEnvId(envId)) throw new TypeError(`invalid envId: ${envId}`);
  return `e${envId.slice(-7)}`;
}

export function isEnvName(value: unknown): value is string {
  return typeof value === 'string' && ENV_NAME_RE.test(value);
}

// ---------------------------------------------------------------------------------------------------------------
// cards, variants, profiles, tracks

export type CardKind = 'service' | 'scenario';

export function isCardId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 28 && CARD_ID_RE.test(value);
}

export function cardKindOf(cardId: string): CardKind {
  if (!isCardId(cardId)) throw new TypeError(`invalid card id: ${cardId}`);
  return cardId.startsWith('svc-') ? 'service' : 'scenario';
}

export function isVariant(value: unknown): value is string {
  return typeof value === 'string' && (value === DEFAULT_VARIANT || VARIANT_RE.test(value));
}

/** Start profile name `atl/<card-id>/<variant>` (the default variant is always written out, 01 §3.9). */
export function startProfileName(cardId: string, variant: string = DEFAULT_VARIANT): string {
  if (!isCardId(cardId)) throw new TypeError(`invalid card id: ${cardId}`);
  if (!isVariant(variant)) throw new TypeError(`invalid variant: ${variant}`);
  return `atl/${cardId}/${variant}`;
}

/** Start profile file path `profiles/atl/<card-id>/<variant>.env` (relative to the content release / runner workdir). */
export function startProfileFile(cardId: string, variant: string = DEFAULT_VARIANT): string {
  return `profiles/${startProfileName(cardId, variant)}.env`;
}

export function parseStartProfileName(name: string): { cardId: string; variant: string } | null {
  const m = /^atl\/([^/]+)\/([^/]+)$/.exec(name);
  if (!m || !isCardId(m[1]) || !isVariant(m[2])) return null;
  return { cardId: m[1], variant: m[2] };
}

export function isTrackId(value: unknown): value is string {
  return typeof value === 'string' && TRACK_ID_RE.test(value);
}

// ---------------------------------------------------------------------------------------------------------------
// certificates

export function newCertId(): string {
  const g = () => randomBase32(4, CROCKFORD_UPPER);
  return `ATL-${g()}-${g()}-${g()}-${g()}`;
}

export function isCertId(value: unknown): value is string {
  return typeof value === 'string' && CERT_ID_RE.test(value);
}

// ---------------------------------------------------------------------------------------------------------------
// report share links (04 §9.5)

/** Share ID: base64url of 128 random bits (22 characters, not enumerable). */
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** Share link lifetimes in days (04 §9.5: default 30, or 7 / 90; `null` = never expires). */
export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export const DEFAULT_SHARE_EXPIRY_DAYS = 30;

export function newShareId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function isShareId(value: unknown): value is string {
  return typeof value === 'string' && SHARE_ID_RE.test(value);
}

// ---------------------------------------------------------------------------------------------------------------
// runner run IDs

/** `<sid>-<op abbrev>-<n>[-<m>]`; `n` is the attempt within the session, `m` an optional retry / sub-run index. */
export function runnerRunId(sid: string, op: AtlOp, n: number, m?: number): string {
  assertSid(sid);
  const abbrev = RUN_ID_OP_ABBREV[op];
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`run index must be a non-negative integer: ${n}`);
  if (m !== undefined && (!Number.isInteger(m) || m < 0)) throw new RangeError(`run sub-index must be a non-negative integer: ${m}`);
  return m === undefined ? `${sid}-${abbrev}-${n}` : `${sid}-${abbrev}-${n}-${m}`;
}

export interface ParsedRunId {
  sid: string;
  abbrev: string;
  op: AtlOp | null;
  n: number;
  m: number | null;
}

/** Parse a runner run ID; `sid` is taken from the prefix (AP25 “sid 取自 runId 前缀”). */
export function parseRunnerRunId(runId: string): ParsedRunId | null {
  const m = RUN_ID_RE.exec(runId);
  if (!m) return null;
  const abbrev = m[2]!;
  const op = (Object.entries(RUN_ID_OP_ABBREV).find(([, a]) => a === abbrev)?.[0] ?? null) as AtlOp | null;
  return { sid: m[1]!, abbrev, op, n: Number(m[3]), m: m[4] === undefined ? null : Number(m[4]) };
}
