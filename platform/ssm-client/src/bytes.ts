/** Byte helpers (browser-safe: TextEncoder / TextDecoder only). */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return decoder.decode(b);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Normalizes a WebSocket message (`ArrayBuffer` with binaryType 'arraybuffer', or a view such as Node's Buffer). */
export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // ArrayBuffer from another realm (e.g. jsdom, worker): duck-type on byteLength + slice.
  if (data && typeof data === 'object' && typeof (data as ArrayBuffer).byteLength === 'number' && typeof (data as ArrayBuffer).slice === 'function') {
    return new Uint8Array(data as ArrayBuffer);
  }
  return null;
}

/**
 * Splits input into payloads of at most `max` bytes without cutting a multi-byte UTF-8 sequence (03 §3.5.7: the
 * plugin's `StreamDataPayloadSize` is 1024). A chunk boundary is moved back while the next byte is a continuation byte
 * (10xxxxxx). Input that is not valid UTF-8 (e.g. xterm `onBinary` data) is split at `max` once no boundary is found.
 */
export function chunkUtf8(bytes: Uint8Array, max: number): Uint8Array[] {
  if (max < 4) throw new RangeError('ssm-client: chunk size must be at least 4 bytes');
  const out: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + max, bytes.length);
    if (end < bytes.length) {
      let e = end;
      while (e > start && (bytes[e]! & 0xc0) === 0x80) e--;
      if (e > start) end = e;
    }
    out.push(bytes.subarray(start, end));
    start = end;
  }
  return out;
}

/** xterm.js `onBinary` delivers a “binary string” (one char per byte, U+0000–U+00FF). */
export function binaryStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
