/**
 * Minimal AWS Signature Version 4 for the runner's reports to `ANY /api/v1/internal/{proxy+}` (IAM auth, 01 §5.3):
 * JSON POSTs to execute-api with the `atl-<sid>-prov-<op>` credentials. node:crypto only (the runner bundle carries no SDK).
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding of one path segment / query component, as SigV4 requires. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function signRequest(
  req: { method: string; url: string; body?: string; headers?: Record<string, string> },
  creds: SigV4Credentials,
  opts: { region: string; service: string; now?: Date },
): SignedRequest {
  const url = new URL(req.url);
  const body = req.body ?? '';
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': sha256(body),
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const path = url.pathname.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).join('/') || '/';
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [req.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, headers['x-amz-content-sha256']].join('\n');
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, opts.region), opts.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: url.toString(), method: req.method.toUpperCase(), headers, body };
}
