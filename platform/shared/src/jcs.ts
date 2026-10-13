/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) — used for certificate payloads (04 §10.3).
 * Object members are sorted by UTF-16 code units (JavaScript's default string order); numbers use the ECMAScript
 * serialization that `JSON.stringify` already implements; non-finite numbers and non-JSON values are rejected.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported value of type ${typeof value}`);
  }
}

/** UTF-8 bytes of the canonical form. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
