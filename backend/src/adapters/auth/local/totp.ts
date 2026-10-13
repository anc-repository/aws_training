// backend/src/adapters/auth/local/totp.ts —— RFC 6238 TOTP（HMAC-SHA1，30 秒步长，6 位）
//
// 自写而不用 otplib：otplib@12 已弃用、v13 的 API 不同（脚手架 notes 第 15 条）；算法本身只有几十行，便于 cloc 对比。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SEC);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, '0');
}

/** 允许前后各 `window` 个时间步的时钟偏差 */
export function verifyTotp(secretBase32: string, code: string, opts: { atMs?: number; window?: number } = {}): boolean {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const at = opts.atMs ?? Date.now();
  const w = opts.window ?? 1;
  for (let i = -w; i <= w; i += 1) {
    const expected = totpAt(secretBase32, at + i * TOTP_STEP_SEC * 1000);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

export function otpauthUrl(opts: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const q = new URLSearchParams({
    secret: opts.secret, issuer: opts.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
