/**
 * Small, dependency-free encodings shared by the platform (browser-safe: uses `btoa` / `atob`, available in Node 22).
 */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError('invalid base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToBase64Url(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s));
}

export function base64UrlToUtf8(s: string): string {
  return new TextDecoder().decode(base64UrlToBytes(s));
}

/** base64url(JSON) — the encoding of `ATL_ARGS` (01 §3.4) and `ArgsB64` (04 §6.1). */
export function encodeJsonArgs(value: unknown): string {
  return utf8ToBase64Url(JSON.stringify(value));
}

export function decodeJsonArgs<T = unknown>(s: string): T {
  return JSON.parse(base64UrlToUtf8(s)) as T;
}

/**
 * Convert a DER-encoded ECDSA signature (what KMS `Sign` returns) to the fixed-length IEEE P1363 `r‖s` form that JWS ES256
 * and WebCrypto use (04 §10.3: each half left-padded to `size` bytes, 32 for P-256).
 */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const expect = (cond: boolean, what: string) => {
    if (!cond) throw new TypeError(`invalid DER ECDSA signature: ${what}`);
  };
  expect(der[i++] === 0x30, 'SEQUENCE');
  let seqLen = der[i++]!;
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    expect(n === 1, 'length form');
    seqLen = der[i++]!;
  }
  expect(seqLen === der.length - i, 'SEQUENCE length');
  const readInt = (): Uint8Array => {
    expect(der[i++] === 0x02, 'INTEGER');
    const len = der[i++]!;
    expect(len > 0 && i + len <= der.length, 'INTEGER length');
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    expect(v.length <= size, 'INTEGER too large');
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  expect(i === der.length, 'trailing bytes');
  const sig = new Uint8Array(size * 2);
  sig.set(r, 0);
  sig.set(s, size);
  return sig;
}
