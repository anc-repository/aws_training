// 浏览器内的 AWS Signature Version 4（WebCrypto），只用于 identity-pool=cognito 的 S3 分片直传（02 组 identity-pool 第 2 节）。
//
// 为什么不用 @aws-sdk/client-s3 + lib-storage：这里只需要 5 个 S3 REST 调用（CreateMultipartUpload、UploadPart、ListParts、
// CompleteMultipartUpload、AbortMultipartUpload），自己签名不增加任何依赖，也让“浏览器拿着 ASIA 临时凭证自己签名”这件事一目了然：
// Authorization 头里的 Credential=ASIA…/<日期>/<区域>/s3/aws4_request，另带 x-amz-security-token。
// 负载一律 UNSIGNED-PAYLOAD（S3 在 HTTPS 下接受），所以大分片不需要先在浏览器里算 SHA-256。
// host 头参与签名但不由 JS 设置（浏览器禁止设置 Host，它会按 URL 自动填写同一个值）。

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  host: string;
  /** 已编码的路径（以 / 开头），例如 /private/ap-northeast-1%3Aabc/1.jpg */
  path: string;
  query?: Record<string, string>;
  /** 需要签名并发送的请求头（不含 host；名称大小写不限） */
  headers?: Record<string, string>;
  region: string;
  service?: string;
  /** 负载哈希；默认 UNSIGNED-PAYLOAD */
  payloadHash?: string;
  credentials: SigV4Credentials;
  now?: Date;
}

export interface SignedRequest {
  url: string;
  /** 要发送的请求头（含 Authorization、x-amz-date、x-amz-content-sha256、x-amz-security-token；不含 host） */
  headers: Record<string, string>;
  /** 调试用：规范请求与待签字符串 */
  canonicalRequest: string;
  stringToSign: string;
}

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const enc = new TextEncoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('当前环境没有 WebCrypto（crypto.subtle），无法在浏览器内签名；请使用 https 页面');
  return s;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytes(data: string | ArrayBuffer | Uint8Array): ArrayBuffer {
  if (typeof data === 'string') return enc.encode(data).buffer as ArrayBuffer;
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return data;
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  return toHex(await subtle().digest('SHA-256', bytes(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const k = await subtle().importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return subtle().sign('HMAC', k, enc.encode(data));
}

/** RFC 3986 编码（SigV4 要求：除 A-Z a-z 0-9 - _ . ~ 外全部编码） */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** S3 对象键 → 路径（逐段编码，保留 /） */
export function s3KeyPath(key: string): string {
  return `/${key.split('/').map(uriEncode).join('/')}`;
}

function amzDate(d: Date): { long: string; short: string } {
  const long = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { long, short: long.slice(0, 8) };
}

export async function signRequest(input: SignInput): Promise<SignedRequest> {
  const service = input.service ?? 's3';
  const { long, short } = amzDate(input.now ?? new Date());
  const payloadHash = input.payloadHash ?? UNSIGNED_PAYLOAD;
  const send: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) send[k.toLowerCase()] = v;
  send['x-amz-date'] = long;
  send['x-amz-content-sha256'] = payloadHash;
  if (input.credentials.sessionToken) send['x-amz-security-token'] = input.credentials.sessionToken;
  const signed: Record<string, string> = { ...send, host: input.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(signed[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = Object.entries(input.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [input.method.toUpperCase(), input.path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${short}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', long, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(`AWS4${input.credentials.secretAccessKey}`, short);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));
  const headers: Record<string, string> = {
    ...send,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  return { url: `https://${input.host}${input.path}${query ? `?${query}` : ''}`, headers, canonicalRequest, stringToSign };
}
