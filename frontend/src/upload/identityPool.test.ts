// identity-pool=cognito 的前端上传器：浏览器内 SigV4（对照 AWS 文档的示例签名）、STS 凭证分片直传暂存桶、凭证刷新、续传、
// 以及凭证接口 503 时退回前缀令牌。S3 由内存替身模拟（s3fetch / put 注入），不发出任何网络请求。
import { describe, expect, it } from 'vitest';
import type { CreatePhotoResponse, Photo, TempAwsCredentials } from '../api/types';
import { installMockFetch } from '../test/helpers';
import type { PutImpl } from './http';
import {
  CredentialCache, completeXml, identityPoolUpload, parseListParts, REFRESH_BEFORE_MS, s3Host, stagingKey, type S3Fetch, type StsSession,
} from './identityPoolUpload';
import { uploadFile } from './index';
import { EMPTY_SHA256, s3KeyPath, signRequest, uriEncode } from './sigv4';
import type { ResumeState } from './types';

const MB = 1024 * 1024;
const IDENTITY = 'ap-northeast-1:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BUCKET = 'cloudalbum-lab-upload-staging-123456789012';

describe('SigV4（AWS 文档“Signature Calculations for the Authorization Header”的 S3 示例）', () => {
  const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  const now = new Date('2013-05-24T00:00:00Z');
  const host = 'examplebucket.s3.amazonaws.com';
  const sig = (h: Record<string, string>) => /Signature=([0-9a-f]{64})/.exec(h.authorization ?? '')?.[1];

  it('GET Object（Range 头）', async () => {
    const r = await signRequest({ method: 'GET', host, path: '/test.txt', headers: { range: 'bytes=0-9' }, region: 'us-east-1', payloadHash: EMPTY_SHA256, credentials, now });
    expect(r.headers.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(sig(r.headers)).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('PUT Object（键中的 $ 编码为 %24）', async () => {
    const r = await signRequest({
      method: 'PUT', host, path: s3KeyPath('test$file.text'), region: 'us-east-1', credentials, now,
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    });
    expect(r.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(sig(r.headers)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('GET Bucket Lifecycle（空值查询参数）与 List Objects（参数排序）', async () => {
    const a = await signRequest({ method: 'GET', host, path: '/', query: { lifecycle: '' }, region: 'us-east-1', payloadHash: EMPTY_SHA256, credentials, now });
    expect(sig(a.headers)).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
    const b = await signRequest({ method: 'GET', host, path: '/', query: { prefix: 'J', 'max-keys': '2' }, region: 'us-east-1', payloadHash: EMPTY_SHA256, credentials, now });
    expect(sig(b.headers)).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('临时凭证：x-amz-security-token 参与签名；identityId 中的冒号在路径里编码', async () => {
    const r = await signRequest({
      method: 'PUT', host: s3Host(BUCKET, 'ap-northeast-1'), path: s3KeyPath(`private/${IDENTITY}/p.jpg`), query: { partNumber: '1', uploadId: 'u' },
      region: 'ap-northeast-1', credentials: { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 's', sessionToken: 'tok' }, now,
    });
    expect(r.url).toBe(`https://${BUCKET}.s3.ap-northeast-1.amazonaws.com/private/ap-northeast-1%3Aaaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/p.jpg?partNumber=1&uploadId=u`);
    expect(r.headers['x-amz-security-token']).toBe('tok');
    expect(r.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(r.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/20130524\/ap-northeast-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, /);
    expect(r.headers.host).toBeUndefined();
    expect(uriEncode("a b!'()*")).toBe('a%20b%21%27%28%29%2A');
  });
});

describe('辅助函数', () => {
  it('stagingKey / parseListParts / completeXml', () => {
    expect(stagingKey(`private/${IDENTITY}/`, 'p1', 'raw/u1/p1.JPG')).toBe(`private/${IDENTITY}/p1.jpg`);
    const xml = '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>'
      + '<Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag><Size>5242880</Size></Part>'
      + '<Part><PartNumber>2</PartNumber><ETag>"e2"</ETag><Size>10</Size></Part></ListPartsResult>';
    expect(parseListParts(xml)).toEqual({ parts: [{ part: 1, etag: '"e1"', size: 5242880 }, { part: 2, etag: '"e2"', size: 10 }], truncated: true, next: '2' });
    expect(completeXml([{ part: 2, etag: '"b"' }, { part: 1, etag: '"a"' }])).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part></CompleteMultipartUpload>',
    );
  });

  it('CredentialCache：剩余有效期低于 5 分钟才重新换取；并发只换一次', async () => {
    let t = 0;
    let loads = 0;
    const cache = new CredentialCache(async () => {
      loads += 1;
      return creds(t + 10 * 60_000);
    }, () => t);
    await Promise.all([cache.get(), cache.get()]);
    expect(loads).toBe(1);
    t = 10 * 60_000 - REFRESH_BEFORE_MS + 1;
    await cache.get();
    expect(loads).toBe(2);
    await cache.get(true);
    expect(loads).toBe(3);
  });
});

function creds(expiresAt: number, n = 1): TempAwsCredentials {
  return {
    accessKeyId: `ASIAEXAMPLE${n}`, secretAccessKey: `secret${n}`, sessionToken: `token${n}`, expiration: new Date(expiresAt).toISOString(),
    identityId: IDENTITY, region: 'ap-northeast-1', bucket: BUCKET, prefix: `private/${IDENTITY}/`,
  };
}

/** 内存版 S3 分片上传（按 Authorization 记录用的是哪组凭证） */
class FakeS3 {
  readonly requests: Array<{ method: string; url: string; auth: string; token?: string }> = [];
  readonly uploads = new Map<string, { key: string; parts: Map<number, number> }>();
  readonly completed: Array<{ key: string; body: string }> = [];
  failPart?: { part: number; times: number; status: number; text: string };
  dropEtag = false;

  private record(method: string, url: string, headers: Record<string, string>): URL {
    this.requests.push({ method, url, auth: headers.authorization ?? '', ...(headers['x-amz-security-token'] ? { token: headers['x-amz-security-token'] } : {}) });
    return new URL(url);
  }

  readonly fetch: S3Fetch = async (url, init) => {
    const u = this.record(init.method, url, init.headers);
    const key = decodeURIComponent(u.pathname.slice(1));
    if (init.method === 'POST' && u.searchParams.has('uploads')) {
      const id = `up-${this.uploads.size + 1}`;
      this.uploads.set(id, { key, parts: new Map() });
      return { status: 200, text: `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>` };
    }
    const up = this.uploads.get(u.searchParams.get('uploadId') ?? '');
    if (!up) return { status: 404, text: '<Error><Code>NoSuchUpload</Code></Error>' };
    if (init.method === 'GET') {
      return { status: 200, text: `<ListPartsResult><IsTruncated>false</IsTruncated>${[...up.parts.keys()].map((p) => `<Part><PartNumber>${p}</PartNumber><ETag>"etag-${p}"</ETag><Size>1</Size></Part>`).join('')}</ListPartsResult>` };
    }
    if (init.method === 'POST') {
      this.completed.push({ key: up.key, body: init.body ?? '' });
      return { status: 200, text: '<CompleteMultipartUploadResult/>' };
    }
    return { status: 400, text: '' };
  };

  readonly put: PutImpl = async (url, body, opts) => {
    const u = this.record('PUT', url, opts.headers ?? {});
    const part = Number(u.searchParams.get('partNumber'));
    if (this.failPart?.part === part && this.failPart.times > 0) {
      this.failPart.times -= 1;
      if (this.failPart.status === 0) throw new Error('网络中断');
      return { status: this.failPart.status, responseText: this.failPart.text };
    }
    this.uploads.get(u.searchParams.get('uploadId') ?? '')!.parts.set(part, body.size);
    opts.onProgress?.(body.size, body.size);
    return { status: 200, responseText: '', ...(this.dropEtag ? {} : { etag: `"etag-${part}"` }) };
  };
}

const session: StsSession = { mode: 'sts', region: 'ap-northeast-1', bucket: BUCKET, prefix: 'private/', partSize: 5 * MB, credentialsUrl: '/api/uploads/credentials' };

function file(bytes: number): File {
  return new File([new Uint8Array(bytes).fill(7)], 'p.jpg', { type: 'image/jpeg' });
}

function harness(opts: { now?: () => number; credsAt?: () => number } = {}) {
  const s3 = new FakeS3();
  const backend: string[] = [];
  let n = 0;
  const ctx = {
    session: { ...session },
    s3fetch: s3.fetch,
    put: s3.put,
    credentials: async () => {
      n += 1;
      backend.push('GET /api/uploads/credentials');
      return creds((opts.credsAt ?? (() => Date.now() + 3600_000))(), n);
    },
    createPhoto: async (): Promise<CreatePhotoResponse> => {
      backend.push('POST /api/photos');
      return { photo: { id: 'photo-1', status: 'UPLOADING', contentType: 'image/jpeg' } as Photo, rawKey: 'raw/u1/photo-1.jpg', uploadId: 'photo-1' };
    },
    completePhoto: async (id: string) => {
      backend.push(`POST /api/photos/${id}/complete`);
      return { id, status: 'READY' } as Photo;
    },
    ...(opts.now ? { now: opts.now } : {}),
  };
  return { s3, backend, ctx };
}

describe('identityPoolUpload（STS 临时凭证直传暂存桶）', () => {
  it('凭证 → 建档 → CreateMultipartUpload → UploadPart × 3 → Complete → complete；分片之间没有发往 EC2 的请求', async () => {
    const { s3, backend, ctx } = harness();
    const stages: string[] = [];
    const photo = await identityPoolUpload(file(Math.round(12 * MB)), { ...ctx, onStage: (s) => stages.push(s) });
    expect(photo.status).toBe('READY');
    expect(backend).toEqual(['GET /api/uploads/credentials', 'POST /api/photos', 'POST /api/photos/photo-1/complete']);
    expect(stages).toEqual(['create', 'upload', 'complete']);
    expect(s3.requests.map((r) => r.method)).toEqual(['POST', 'PUT', 'PUT', 'PUT', 'POST']);
    for (const r of s3.requests) {
      expect(r.url).toContain(`https://${BUCKET}.s3.ap-northeast-1.amazonaws.com/private/ap-northeast-1%3Aaaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/photo-1.jpg`);
      expect(r.auth).toMatch(/Credential=ASIAEXAMPLE1\//);
      expect(r.token).toBe('token1');
    }
    expect(s3.completed[0]!.key).toBe(`private/${IDENTITY}/photo-1.jpg`);
    expect(s3.completed[0]!.body).toContain('<PartNumber>3</PartNumber><ETag>&quot;etag-3&quot;</ETag>');
  });

  it('凭证快过期时在上传途中刷新；分片遇到 ExpiredToken 时刷新后重试一次', async () => {
    let t = Date.now();
    const { s3, backend, ctx } = harness({ now: () => t, credsAt: () => t + 6 * 60_000 });
    const put = s3.put;
    let calls = 0;
    ctx.put = async (url, body, opts) => {
      calls += 1;
      if (calls === 2) t += 2 * 60_000;   // 第 2 片之前过去 2 分钟：剩余 4 分钟 < 5 分钟 → 刷新
      return put(url, body, opts);
    };
    s3.failPart = { part: 3, times: 1, status: 400, text: '<Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>' };
    await identityPoolUpload(file(Math.round(12 * MB)), ctx);
    expect(backend.filter((b) => b.includes('credentials')).length).toBeGreaterThanOrEqual(3);
    const parts = s3.requests.filter((r) => r.method === 'PUT');
    expect(parts[0]!.token).toBe('token1');
    expect(parts.at(-1)!.token).not.toBe('token1');
  });

  it('续传：沿用 photoId 与 S3 UploadId，先 ListParts，只补传缺失的分片', async () => {
    const { s3, backend, ctx } = harness();
    s3.failPart = { part: 2, times: 1, status: 0, text: '' };
    let resume: ResumeState | undefined;
    const f = file(Math.round(12 * MB));
    await expect(identityPoolUpload(f, { ...ctx, onResumeState: (s) => { resume = { ...s, done: { ...s.done } }; } })).rejects.toThrow('网络中断');
    expect(resume).toMatchObject({ photoId: 'photo-1', uploadId: 'up-1', stagingKey: `private/${IDENTITY}/photo-1.jpg`, done: { 1: '"etag-1"' } });
    s3.requests.length = 0;
    const photo = await identityPoolUpload(f, { ...ctx, ...(resume ? { resume } : {}) });
    expect(photo.status).toBe('READY');
    expect(s3.requests.map((r) => `${r.method} ${new URL(r.url).searchParams.get('partNumber') ?? ''}`)).toEqual(['GET ', 'PUT 2', 'PUT 3', 'POST ']);
    expect(backend.filter((b) => b === 'POST /api/photos')).toHaveLength(1);
  });

  it('越权由 S3 拒绝（403 AccessDenied 原样报告）；读不到 ETag 时指出 CORS', async () => {
    const a = harness();
    a.s3.failPart = { part: 1, times: 1, status: 403, text: '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>' };
    await expect(identityPoolUpload(file(100), a.ctx)).rejects.toThrow(/HTTP 403 AccessDenied/);
    const b = harness();
    b.s3.dropEtag = true;
    await expect(identityPoolUpload(file(100), b.ctx)).rejects.toThrow(/ETag/);
  });
});

describe('uploadFile：凭证不可用时退回前缀令牌', () => {
  it('GET /api/uploads/credentials 返回 503 → 重新开会话拿到前缀令牌（cognito:error-fallback）→ 前缀令牌分片上传', async () => {
    installMockFetch();
    const inner = globalThis.fetch;
    let sessions = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, globalThis.location.href);
      if (url.pathname === '/api/uploads/session' && sessions++ === 0) {
        return new Response(JSON.stringify(session), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/uploads/credentials') {
        return new Response(JSON.stringify({ error: 'IDENTITY_POOL_UNAVAILABLE', message: '换取临时凭证失败' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return inner(input, init);
    }) as typeof fetch;
    await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@example.com', password: 'cloudalbum-dev-1' }) });
    const put: PutImpl = async (url, body, opts) => {
      const r = await fetch(url, { method: 'PUT', body: await new Response(body).text(), ...(opts.headers ? { headers: opts.headers } : {}) });
      return { status: r.status, responseText: '' };
    };
    const p = await uploadFile(file(1000), 'identity-pool', { put });
    expect(p.status).toBe('READY');
    expect(sessions).toBe(2);
  });
});
