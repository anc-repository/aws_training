// backend/src/platform/probe-token.ts —— 探测令牌（06 PM-09、PM-13）与实验主体令牌（PM-17）的格式、签发与校验
//
//   本机密钥（文件 ATL_PROBE_TOKEN_FILE）：atlpk1.<32 个随机字节的 base64url>
//   本机令牌：请求头 X-ATL-Probe-Token 的值就是文件内容（只在回环地址 + 直连入口有效）
//   一次性令牌：atlpt1.<nonce>.<exp>.<sig>，sig = base64url(HMAC-SHA256(K_otp, "atlpt1.<nonce>.<exp>"))，
//              K_otp = HKDF-SHA256(ikm = 本机密钥的 32 字节, salt = 空, info = "cloudalbum/atl-probe/otp/v1", L = 32)
//              有效：now - 5 ≤ exp ≤ now + 65；nonce 只能使用一次（atl_probe_nonces，见 repositories/atl-probe-nonces.ts）
//   实验主体令牌：atllt1.<nonce>.<exp>.<sig>，K_lab = HKDF(本机密钥, info = "cloudalbum/atl-lab/v1")；有效期内可重复使用
// 令牌从不出现在 URL、日志与证据中；`probe-token --rotate` 重新生成本机密钥，已签发的一次性令牌与 lab-token 全部失效。
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { LAB_TOKEN_RE, PROBE_LOCAL_TOKEN_RE, PROBE_OTP_TOKEN_RE } from '@cloudalbum/contracts';

export const OTP_PREFIX = 'atlpt1';
export const LAB_PREFIX = 'atllt1';
export const LOCAL_PREFIX = 'atlpk1';
export const OTP_INFO = 'cloudalbum/atl-probe/otp/v1';
export const LAB_INFO = 'cloudalbum/atl-lab/v1';

/** 一次性令牌的签发上限（秒）与时钟偏差容忍 */
export const OTP_MAX_TTL_SEC = 60;
export const CLOCK_SKEW_SEC = 5;
/** lab-token 的有效期范围（秒） */
export const LAB_TTL_MIN_SEC = 60;
export const LAB_TTL_MAX_SEC = 14_400;

export type ProbeTokenErrorCode = 'PROBE_TOKEN_INVALID' | 'PROBE_TOKEN_EXPIRED' | 'PROBE_LOCAL_ONLY' | 'PROBE_TOKEN_REPLAYED';

/** 生成新的本机密钥（`probe-token --init | --rotate`） */
export function generateLocalSecret(): string {
  return `${LOCAL_PREFIX}.${randomBytes(32).toString('base64url')}`;
}

export function isLocalSecret(v: string): boolean {
  return PROBE_LOCAL_TOKEN_RE.test(v);
}

function secretBytes(secret: string): Buffer {
  if (!isLocalSecret(secret)) throw new Error('invalid local probe secret');
  return Buffer.from(secret.slice(LOCAL_PREFIX.length + 1), 'base64url');
}

/** HKDF-SHA256(ikm = 本机密钥 32 字节, salt = 空, info, L = 32) */
export function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secretBytes(secret), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** 本机令牌：与文件内容常量时间比较 */
export function verifyLocalToken(token: string, secret: string | null): boolean {
  if (!secret || !isLocalSecret(token)) return false;
  return safeEqual(token, secret);
}

function issue(prefix: string, info: string, secret: string, exp: number, nonce = randomBytes(16).toString('base64url')): string {
  const payload = `${prefix}.${nonce}.${String(exp).padStart(10, '0')}`;
  return `${payload}.${sign(deriveKey(secret, info), payload)}`;
}

/** 签发一次性探测令牌（`cloudalbum probe-token --ttl N`）。签发不访问数据库：nonce 在使用时才登记。 */
export function issueProbeToken(secret: string, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): { token: string; exp: number } {
  if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > OTP_MAX_TTL_SEC) throw new RangeError(`ttl must be 1..${OTP_MAX_TTL_SEC}`);
  const exp = nowSec + ttlSec;
  return { token: issue(OTP_PREFIX, OTP_INFO, secret, exp), exp };
}

/** 签发实验主体令牌（`cloudalbum lab-token --ttl N`，PM-17） */
export function issueLabToken(secret: string, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): { token: string; exp: number } {
  if (!Number.isInteger(ttlSec) || ttlSec < LAB_TTL_MIN_SEC || ttlSec > LAB_TTL_MAX_SEC) throw new RangeError(`ttl must be ${LAB_TTL_MIN_SEC}..${LAB_TTL_MAX_SEC}`);
  const exp = nowSec + ttlSec;
  return { token: issue(LAB_PREFIX, LAB_INFO, secret, exp), exp };
}

export type SignedVerify = { ok: true; nonce: string; exp: number } | { ok: false; code: 'PROBE_TOKEN_INVALID' | 'PROBE_TOKEN_EXPIRED' };

function verifySigned(token: string, secret: string | null, prefix: string, info: string, re: RegExp, maxAheadSec: number, nowSec: number): SignedVerify {
  if (!secret || !re.test(token)) return { ok: false, code: 'PROBE_TOKEN_INVALID' };
  const parts = token.split('.');
  const [p, nonce, expStr, sig] = parts as [string, string, string, string];
  if (p !== prefix) return { ok: false, code: 'PROBE_TOKEN_INVALID' };
  const expected = sign(deriveKey(secret, info), `${p}.${nonce}.${expStr}`);
  if (!safeEqual(sig, expected)) return { ok: false, code: 'PROBE_TOKEN_INVALID' };
  const exp = Number(expStr);
  if (exp < nowSec - CLOCK_SKEW_SEC) return { ok: false, code: 'PROBE_TOKEN_EXPIRED' };
  if (exp > nowSec + maxAheadSec + CLOCK_SKEW_SEC) return { ok: false, code: 'PROBE_TOKEN_INVALID' };
  return { ok: true, nonce, exp };
}

/** 一次性令牌：格式、签名、时间窗（nonce 的一次性由调用方登记） */
export function verifyProbeToken(token: string, secret: string | null, nowSec = Math.floor(Date.now() / 1000)): SignedVerify {
  return verifySigned(token, secret, OTP_PREFIX, OTP_INFO, PROBE_OTP_TOKEN_RE, OTP_MAX_TTL_SEC, nowSec);
}

/** lab-token：格式、签名、有效期（可重复使用） */
export function verifyLabToken(token: string, secret: string | null, nowSec = Math.floor(Date.now() / 1000)): SignedVerify {
  return verifySigned(token, secret, LAB_PREFIX, LAB_INFO, LAB_TOKEN_RE, LAB_TTL_MAX_SEC, nowSec);
}

/** 请求头的值按前缀区分令牌种类 */
export function tokenKind(value: string): 'local' | 'otp' | 'unknown' {
  if (value.startsWith(`${LOCAL_PREFIX}.`)) return 'local';
  if (value.startsWith(`${OTP_PREFIX}.`)) return 'otp';
  return 'unknown';
}
