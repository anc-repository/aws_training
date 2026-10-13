/**
 * UUIDs of the data channel (03 §3.5.2).
 *
 * Wire order — aws/session-manager-plugin `src/message/messageparser.go` `putUuid` / `getUuid`: the 16-byte MessageId
 * field holds the UUID's least significant 64 bits (UUID bytes 8–15) first, then the most significant 64 bits
 * (UUID bytes 0–7), each as a big-endian long. Text form is lower-case hyphenated (twinj/uuid `CleanHyphen`).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Random v4 UUID: `crypto.randomUUID()` (browsers in secure contexts, Node ≥ 19), else `getRandomValues`. */
export function randomUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('ssm-client: no Web Crypto random source available');
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return bytesToUuid(b);
}

/** Canonical byte order (RFC 4122 / 9562): byte 0 is the most significant. */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!isUuid(uuid)) throw new TypeError(`ssm-client: not a UUID: ${JSON.stringify(uuid)}`);
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToUuid(b: Uint8Array): string {
  if (b.length !== 16) throw new TypeError(`ssm-client: a UUID has 16 bytes, got ${b.length}`);
  let hex = '';
  for (const x of b) hex += x.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID → the 16 bytes of the MessageId field: UUID bytes 8–15, then bytes 0–7. */
export function uuidToWire(uuid: string): Uint8Array {
  const b = uuidToBytes(uuid);
  const out = new Uint8Array(16);
  out.set(b.subarray(8, 16), 0);
  out.set(b.subarray(0, 8), 8);
  return out;
}

/** The 16 bytes of a MessageId field → UUID text. */
export function wireToUuid(w: Uint8Array): string {
  if (w.length !== 16) throw new TypeError(`ssm-client: a MessageId field has 16 bytes, got ${w.length}`);
  const b = new Uint8Array(16);
  b.set(w.subarray(8, 16), 0);
  b.set(w.subarray(0, 8), 8);
  return bytesToUuid(b);
}
