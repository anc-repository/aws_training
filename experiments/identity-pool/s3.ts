/**
 * identity-pool/s3 —— 用 STS 临时凭证直接调用 S3（Node 版 SigV4，与 frontend/src/upload/sigv4.ts 同一算法）。
 * 负载一律 UNSIGNED-PAYLOAD；临时凭证带 x-amz-security-token。默认虚拟主机式地址 https://<bucket>.s3.<region>.amazonaws.com/<key>；
 * `--param s3Endpoint=http://127.0.0.1:4566` 时改用路径式（LocalStack / 测试替身）。
 */
import { createHash, createHmac } from 'node:crypto';
import type { ExpResponse } from '../_lib/http.js';
import type { ScenarioContext } from '../_lib/scenario.js';
import { strParam } from '../_lib/scenario.js';

export interface StsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
  identityId: string;
  region: string;
  bucket: string;
  prefix: string;
}

export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function keyPath(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

export interface SignedS3 { url: string; headers: Record<string, string> }

export function signS3(opts: {
  method: string; base: string; pathStyleBucket?: string; key: string; query?: Record<string, string>; headers?: Record<string, string>;
  region: string; credentials: Pick<StsCredentials, 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>; now?: Date;
}): SignedS3 {
  const u = new URL(opts.base);
  const path = `${opts.pathStyleBucket ? `/${uriEncode(opts.pathStyleBucket)}` : ''}/${keyPath(opts.key)}`;
  const long = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const short = long.slice(0, 8);
  const send: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) send[k.toLowerCase()] = v;
  send['x-amz-date'] = long;
  send['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD';
  if (opts.credentials.sessionToken) send['x-amz-security-token'] = opts.credentials.sessionToken;
  const all: Record<string, string> = { ...send, host: u.host };
  const names = Object.keys(all).sort();
  const query = Object.entries(opts.query ?? {}).map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [opts.method, path, query, names.map((n) => `${n}:${all[n]!.trim()}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${short}/${opts.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', long, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  let key: Buffer = createHmac('sha256', `AWS4${opts.credentials.secretAccessKey}`).update(short).digest();
  for (const part of [opts.region, 's3', 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    url: `${u.origin}${path}${query ? `?${query}` : ''}`,
    headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
  };
}

/** S3 的错误码（XML <Code>） */
export function s3ErrorCode(res: Pick<ExpResponse, 'text'>): string | undefined {
  try {
    return /<Code>([^<]+)<\/Code>/.exec(res.text())?.[1];
  } catch {
    return undefined;
  }
}

export function xmlTag(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
}

/** 直连 S3 的客户端：不带 CloudAlbum 令牌、不带实验头；目标标签 s3（客户端统计里与 EC2 分开） */
export class StsS3 {
  private readonly endpoint: string;
  constructor(private readonly ctx: Pick<ScenarioContext, 'http' | 'params'>, public creds: StsCredentials) {
    this.endpoint = strParam(ctx, 's3Endpoint', '');
  }

  private base(): { base: string; pathStyleBucket?: string } {
    return this.endpoint
      ? { base: this.endpoint, pathStyleBucket: this.creds.bucket }
      : { base: `https://${this.creds.bucket}.s3.${this.creds.region}.amazonaws.com` };
  }

  async send(method: string, key: string, opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer | string; route: string }): Promise<ExpResponse> {
    const b = this.base();
    const s = signS3({ method, ...b, key, ...(opts.query ? { query: opts.query } : {}), ...(opts.headers ? { headers: opts.headers } : {}), region: this.creds.region, credentials: this.creds });
    const client = this.ctx.http(b.base, { target: 's3', auth: false, experiment: false });
    return client.request(method, s.url, { headers: s.headers, ...(opts.body !== undefined ? { body: opts.body } : {}), route: opts.route, auth: false, expect: [200, 204] });
  }

  putObject(key: string, body: Buffer, contentType = 'image/jpeg'): Promise<ExpResponse> {
    return this.send('PUT', key, { headers: { 'content-type': contentType }, body, route: 'PUT s3:PutObject' });
  }

  deleteObject(key: string): Promise<ExpResponse> {
    return this.send('DELETE', key, { route: 'DELETE s3:DeleteObject' });
  }

  listBucket(prefix?: string): Promise<ExpResponse> {
    return this.send('GET', '', { query: { 'list-type': '2', ...(prefix !== undefined ? { prefix } : {}) }, route: 'GET s3:ListObjectsV2' });
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const r = await this.send('POST', key, { query: { uploads: '' }, headers: { 'content-type': contentType }, route: 'POST s3:CreateMultipartUpload' });
    const id = r.ok ? xmlTag(r.text(), 'UploadId') : undefined;
    if (!id) throw new Error(`CreateMultipartUpload 失败：HTTP ${r.status} ${s3ErrorCode(r) ?? r.error ?? ''}`);
    return id;
  }

  async uploadPart(key: string, uploadId: string, part: number, body: Buffer): Promise<{ etag?: string; res: ExpResponse }> {
    const res = await this.send('PUT', key, { query: { partNumber: String(part), uploadId }, body, route: 'PUT s3:UploadPart' });
    return { res, ...(res.ok && res.headers.etag ? { etag: res.headers.etag } : {}) };
  }

  async listParts(key: string, uploadId: string): Promise<Map<number, string>> {
    const r = await this.send('GET', key, { query: { uploadId }, route: 'GET s3:ListParts' });
    const out = new Map<number, string>();
    if (!r.ok) return out;
    for (const m of r.text().matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const n = Number(xmlTag(m[1]!, 'PartNumber'));
      const etag = (xmlTag(m[1]!, 'ETag') ?? '').replace(/&quot;/g, '"');
      if (n > 0) out.set(n, etag);
    }
    return out;
  }

  async completeMultipart(key: string, uploadId: string, parts: Map<number, string>): Promise<ExpResponse> {
    const body = `<CompleteMultipartUpload>${[...parts.entries()].sort((a, b) => a[0] - b[0])
      .map(([n, e]) => `<Part><PartNumber>${n}</PartNumber><ETag>${e.replace(/"/g, '&quot;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    return this.send('POST', key, { query: { uploadId }, headers: { 'content-type': 'application/xml' }, body, route: 'POST s3:CompleteMultipartUpload' });
  }
}
