/**
 * 证书验证算法（04 §10.5；08 P09-V 的结果状态）。浏览器端用 WebCrypto 本地验签，不依赖任何 API：
 *
 * 1. 拆分紧凑 JWS；`alg` 必须是 ES256、`typ` 必须是 `atl-cert+jws`（否则“格式错误”）；
 * 2. 按 `kid` 在 `/.well-known/atl/jwks.json` 中选公钥（找不到 → “未知密钥”）；
 * 3. `atl:validFrom ≤ issuedAt ≤ atl:validTo`（否则“密钥不在有效期”）；
 * 4. WebCrypto ECDSA P-256 / SHA-256 验签，签名为 64 字节 r‖s（失败 → “签名无效”）；
 * 5. 载荷 `v == 1`、`nature == self-hosted-self-signed`（否则“格式错误”）；`issuer.origin ∈ jwks.origins`（否则“签发源不符”）；
 * 6. 吊销列表 `/public/revocations.jws` 用同样方式验签（`typ = atl-revocations+jws`）；certId 在列表中 → “已吊销”。
 *    列表读取失败或签名无效时签名结论照常给出，另附“无法确认吊销状态”；
 * 7. 报告核对：对持有人提供的报告 JSON 去掉 `integrity` 后按 RFC 8785 规范化、计算 SHA-256，与 `reportDigest` 比较。
 *
 * 与 atl-certs 的 verify-core（platform/api/src/services/certificates/verify-core.ts）是同一算法；这里多区分了 08 要求的
 * “签发源不符”与“浏览器不支持”。纯函数，不触碰 DOM；`subtle` 由调用方注入（测试与不支持 WebCrypto 的浏览器）。
 */

export const CERT_TYP = 'atl-cert+jws';
export const REVOCATIONS_TYP = 'atl-revocations+jws';
export const CERT_ID_RE = /^ATL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export type VerifyStatus = 'valid' | 'revoked' | 'invalid-signature' | 'unknown-key' | 'key-not-valid' | 'origin-mismatch' | 'malformed';

export interface PublicJwk {
  kty?: string;
  crv?: string;
  x: string;
  y: string;
  kid: string;
  'atl:validFrom'?: string | null;
  'atl:validTo'?: string | null;
  'atl:purposes'?: string[];
  [k: string]: unknown;
}

export interface Jwks {
  installId?: string;
  keys: PublicJwk[];
  origins?: string[];
  [k: string]: unknown;
}

export interface RevocationEntry {
  certId: string;
  revokedAt?: string;
  reason?: string;
}

export interface CertLab {
  labId: string;
  labVersion?: string;
  attemptRef?: string;
  reportDigest?: string | null;
  badgeLevel?: string;
  checks?: { auto?: number; manual?: number };
  completedAt?: string;
}

export interface CertPayload {
  v?: number;
  kind?: 'track' | 'lab' | string;
  certId?: string;
  issuer?: { name?: string; origin?: string; installId?: string; kid?: string };
  subject?: { displayName?: string; ref?: string };
  achievement?: {
    trackId?: string;
    trackVersion?: string;
    labId?: string;
    labVersion?: string;
    title?: string;
    contentDigest?: string | null;
    verifiedRatio?: number | null;
    labs?: CertLab[];
  };
  evidence?: { reportDigest?: string | null; [k: string]: unknown };
  issuedAt?: string;
  nature?: string;
  disclaimer?: string;
  verify?: string;
  [k: string]: unknown;
}

export interface JwsHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

export type RevocationState =
  /** 列表已读取且签名有效。 */
  | 'checked'
  /** 列表读取失败（网络、404、无法解析）。 */
  | 'unavailable'
  /** 列表签名无效或密钥不对。 */
  | 'invalid'
  /** 没有走到这一步（证书本身未通过验签）。 */
  | 'skipped';

export interface VerifyOutcome {
  status: VerifyStatus;
  header: JwsHeader | null;
  payload: CertPayload | null;
  /** 选中的公钥（指纹即 kid）。 */
  key: PublicJwk | null;
  revocations: { state: RevocationState; seq: number | null; entry: RevocationEntry | null };
  /** 失败细节（只用于诊断，不直接给学员看）。 */
  detail?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// 编码与规范化

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** RFC 8785（JCS）：对象成员按 UTF-16 码元排序，数字用 ECMAScript 序列化；与 @atl/shared 的 canonicalJson 相同。 */
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

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 规范化 JSON 的 SHA-256（`sha256:<hex>`）。 */
export async function sha256Canonical(subtle: SubtleCrypto, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return `sha256:${toHex(await subtle.digest('SHA-256', bytes))}`;
}

/** 报告摘要（04 §9.2 `integrity`：对去掉 integrity 后的对象计算）。 */
export async function reportDigest(subtle: SubtleCrypto, report: unknown): Promise<string> {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new TypeError('report must be an object');
  const { integrity: _i, ...rest } = report as Record<string, unknown>;
  return sha256Canonical(subtle, rest);
}

// ---------------------------------------------------------------------------------------------------------------
// JWS

export interface DecodedJws {
  header: JwsHeader;
  payload: unknown;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

export function decodeJws(jws: string): DecodedJws {
  const parts = String(jws).trim().split('.');
  if (parts.length !== 3) throw new Error('not a compact JWS');
  const [h, p, s] = parts as [string, string, string];
  const dec = new TextDecoder('utf-8', { fatal: true });
  const header = JSON.parse(dec.decode(base64UrlToBytes(h))) as unknown;
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('JWS header is not an object');
  const payload = JSON.parse(dec.decode(base64UrlToBytes(p))) as unknown;
  return { header: header as JwsHeader, payload, signingInput: `${h}.${p}`, signature: base64UrlToBytes(s) };
}

/** 浏览器是否支持本地验签（08 P09-V“浏览器不支持”）：有 crypto.subtle，且能导入 P-256 公钥。 */
export async function supportsLocalVerify(subtle: SubtleCrypto | null | undefined, sampleKey?: Pick<PublicJwk, 'x' | 'y'>): Promise<boolean> {
  if (!subtle || typeof subtle.importKey !== 'function' || typeof subtle.verify !== 'function') return false;
  if (!sampleKey) return true;
  try {
    await importKey(subtle, sampleKey);
    return true;
  } catch {
    return false;
  }
}

function importKey(subtle: SubtleCrypto, jwk: Pick<PublicJwk, 'x' | 'y'>): Promise<CryptoKey> {
  return subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export async function verifySignature(subtle: SubtleCrypto, d: DecodedJws, jwk: Pick<PublicJwk, 'x' | 'y'>): Promise<boolean> {
  if (d.signature.length !== 64) return false;
  try {
    const key = await importKey(subtle, jwk);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, d.signature, new TextEncoder().encode(d.signingInput));
  } catch {
    return false;
  }
}

function keyUsable(k: PublicJwk, purpose: 'cert' | 'revocations'): boolean {
  const purposes = k['atl:purposes'];
  return !Array.isArray(purposes) || purposes.length === 0 || purposes.includes(purpose);
}

function parseTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 吊销列表：验签并找出 certId 对应的条目。 */
export async function checkRevocations(
  subtle: SubtleCrypto,
  jwks: Jwks,
  revocationsJws: string | null | undefined,
  certId: string,
): Promise<VerifyOutcome['revocations']> {
  if (!revocationsJws || !revocationsJws.trim()) return { state: 'unavailable', seq: null, entry: null };
  let d: DecodedJws;
  try {
    d = decodeJws(revocationsJws);
  } catch {
    return { state: 'unavailable', seq: null, entry: null };
  }
  const key = jwks.keys.find((k) => k.kid === d.header.kid);
  if (d.header.alg !== 'ES256' || d.header.typ !== REVOCATIONS_TYP || !key || !keyUsable(key, 'revocations')) return { state: 'invalid', seq: null, entry: null };
  if (!(await verifySignature(subtle, d, key))) return { state: 'invalid', seq: null, entry: null };
  const p = (d.payload ?? {}) as { seq?: unknown; entries?: unknown };
  const seq = typeof p.seq === 'number' ? p.seq : null;
  const entries = Array.isArray(p.entries) ? (p.entries as RevocationEntry[]) : [];
  const entry = entries.find((e) => e && e.certId === certId) ?? null;
  return { state: 'checked', seq, entry };
}

export interface VerifyInput {
  jws: string;
  jwks: Jwks;
  revocationsJws?: string | null;
  subtle: SubtleCrypto;
}

export async function verifyCertificate(input: VerifyInput): Promise<VerifyOutcome> {
  const out: VerifyOutcome = { status: 'malformed', header: null, payload: null, key: null, revocations: { state: 'skipped', seq: null, entry: null } };
  let d: DecodedJws;
  try {
    d = decodeJws(input.jws);
  } catch (e) {
    out.detail = e instanceof Error ? e.message : String(e);
    return out;
  }
  out.header = d.header;
  if (!d.payload || typeof d.payload !== 'object' || Array.isArray(d.payload)) {
    out.detail = 'payload is not an object';
    return out;
  }
  const p = d.payload as CertPayload;
  out.payload = p;
  if (d.header.alg !== 'ES256' || d.header.typ !== CERT_TYP) {
    out.detail = `alg=${String(d.header.alg)} typ=${String(d.header.typ)}`;
    return out;
  }
  const keys = Array.isArray(input.jwks?.keys) ? input.jwks.keys : [];
  const key = keys.find((k) => k && k.kid === d.header.kid) ?? null;
  if (!key || !keyUsable(key, 'cert')) {
    out.status = 'unknown-key';
    return out;
  }
  out.key = key;
  const issuedAt = parseTime(p.issuedAt);
  if (issuedAt === null) {
    out.detail = 'issuedAt is missing';
    return out;
  }
  const from = parseTime(key['atl:validFrom']) ?? Number.NEGATIVE_INFINITY;
  const to = parseTime(key['atl:validTo']) ?? Number.POSITIVE_INFINITY;
  if (!(issuedAt >= from && issuedAt <= to)) {
    out.status = 'key-not-valid';
    return out;
  }
  if (!(await verifySignature(input.subtle, d, key))) {
    out.status = 'invalid-signature';
    return out;
  }
  if (p.v !== 1 || p.nature !== 'self-hosted-self-signed' || !p.issuer || typeof p.certId !== 'string') {
    out.status = 'malformed';
    out.detail = 'payload v / nature / issuer';
    return out;
  }
  const origins = Array.isArray(input.jwks.origins) ? input.jwks.origins : [];
  if (origins.length && !origins.includes(String(p.issuer.origin ?? ''))) {
    out.status = 'origin-mismatch';
    return out;
  }
  out.revocations = await checkRevocations(input.subtle, input.jwks, input.revocationsJws, p.certId);
  out.status = out.revocations.entry ? 'revoked' : 'valid';
  return out;
}

/** 证书引用的卡片（路径证书 `achievement.labs[]`；卡片证书只有一项，摘要在 `evidence.reportDigest`）。 */
export function certLabs(p: CertPayload | null): CertLab[] {
  if (!p?.achievement) return [];
  if (Array.isArray(p.achievement.labs)) return p.achievement.labs.filter((l) => l && typeof l.labId === 'string');
  if (p.achievement.labId) {
    return [{ labId: p.achievement.labId, labVersion: p.achievement.labVersion, reportDigest: p.evidence?.reportDigest ?? null }];
  }
  return [];
}

export interface ReportCheck {
  /** 报告 JSON 的 lab.id（找不到时 null）。 */
  labId: string | null;
  digest: string | null;
  /** consistent：与证书中该卡片的 reportDigest 一致；mismatch：不一致；no-lab：证书中没有这张卡片；invalid：不是报告 JSON。 */
  result: 'consistent' | 'mismatch' | 'no-lab' | 'invalid';
}

/** 核对持有人提供的报告文件（04 §10.5 第 7 步）。expectLabId 给定时按它比较（验证页逐张核对）。 */
export async function checkReportFile(subtle: SubtleCrypto, payload: CertPayload | null, text: string, expectLabId?: string): Promise<ReportCheck> {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return { labId: null, digest: null, result: 'invalid' };
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { labId: null, digest: null, result: 'invalid' };
  const labId = typeof (report as { lab?: { id?: unknown } }).lab?.id === 'string' ? ((report as { lab: { id: string } }).lab.id) : null;
  let digest: string;
  try {
    digest = await reportDigest(subtle, report);
  } catch {
    return { labId, digest: null, result: 'invalid' };
  }
  const target = expectLabId ?? labId;
  const lab = certLabs(payload).find((l) => l.labId === target);
  if (!lab) return { labId, digest, result: 'no-lab' };
  if (expectLabId && labId && labId !== expectLabId) return { labId, digest, result: 'mismatch' };
  return { labId, digest, result: lab.reportDigest === digest ? 'consistent' : 'mismatch' };
}
