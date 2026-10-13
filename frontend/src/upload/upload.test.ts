import { describe, expect, it, vi } from 'vitest';
import type { Photo } from '../api/types';
import { capsWith, installMockFetch, l0Caps } from '../test/helpers';
import type { PutImpl } from './http';
import type { ResumeState } from './types';
import { chooseStrategy, pollUntilSettled, prefixTokenUpload, signedUrlUpload, uploadFile } from './index';

const MB = 1024 * 1024;

/** jsdom 的 Blob 没有 text()，用 FileReader 读取 */
function blobText(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
}

function file(bytes: number, name = 'p.jpg'): File {
  return new File([new Uint8Array(bytes).fill(7)], name, { type: 'image/jpeg' });
}

describe('chooseStrategy（按 capabilities 自动选择）', () => {
  it('单个小文件 → F6 逐文件签名 URL；via 来自 features["F6.upload"]', () => {
    const c = chooseStrategy(l0Caps(), [{ size: 1000 }]);
    expect(c).toMatchObject({ id: 'signed-url', via: ['storage:local'] });
    const s3 = capsWith({ storage: { driver: 's3', status: 'ok' } });
    s3.features['F6.upload'] = { enabled: true, via: ['storage:s3'] };
    expect(chooseStrategy(s3, [{ size: 1000 }])).toMatchObject({ id: 'signed-url', via: ['storage:s3'] });
  });

  it('多个文件或大文件 → F14；identity-pool:none = 前缀令牌，identity-pool:cognito = STS', () => {
    expect(chooseStrategy(l0Caps(), [{ size: 1 }, { size: 2 }]).id).toBe('prefix-token');
    expect(chooseStrategy(l0Caps(), [{ size: 30 * MB }]).id).toBe('prefix-token');
    const sts = l0Caps();
    sts.features['F14.directUpload'] = { enabled: true, via: ['identity-pool:cognito'] };
    expect(chooseStrategy(sts, [{ size: 1 }, { size: 2 }]).id).toBe('identity-pool');
  });

  it('手动选择与 F14 不可用时的退回', () => {
    expect(chooseStrategy(l0Caps(), [{ size: 1 }, { size: 1 }], 'single').id).toBe('signed-url');
    expect(chooseStrategy(l0Caps(), [{ size: 1 }], 'multi').id).toBe('prefix-token');
    const off = l0Caps();
    off.features['F14.directUpload'] = { enabled: false, reason: '测试' };
    const c = chooseStrategy(off, [{ size: 1 }, { size: 2 }]);
    expect(c.id).toBe('signed-url');
    expect(c.reason).toContain('测试');
  });
});

describe('signedUrlUpload（F6：没有驱动分支，原样执行 UploadTarget）', () => {
  it('建档 → 按后端给的 URL 与头 PUT → complete', async () => {
    installMockFetch();
    // 先登录种子用户
    await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@example.com', password: 'cloudalbum-dev-1' }) });
    const puts: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const put: PutImpl = async (url, body, opts) => {
      puts.push({ url, headers: opts.headers });
      const r = await fetch(url, { method: 'PUT', body: await blobText(body), ...(opts.headers ? { headers: opts.headers } : {}) });
      return { status: r.status, responseText: await r.text() };
    };
    const stages: string[] = [];
    const photo = await signedUrlUpload(file(2048), { put, onStage: (s) => stages.push(s) });
    expect(stages).toEqual(['create', 'upload', 'complete']);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toMatch(/^\/api\/storage\/upload\?key=raw%2F/);
    expect(puts[0]!.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(photo.status).toBe('READY');
    expect(photo.processedBy?.driver).toBe('inline');
  });

  it('PUT 失败时抛出带状态码的错误', async () => {
    installMockFetch();
    await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@example.com', password: 'cloudalbum-dev-1' }) });
    const put: PutImpl = async () => ({ status: 403, responseText: '<Error><Code>SignatureDoesNotMatch</Code></Error>' });
    await expect(signedUrlUpload(file(10), { put })).rejects.toThrow('HTTP 403');
  });
});

describe('prefixTokenUpload（F14 本地前缀令牌）', () => {
  it('令牌放在 Authorization: CA-Upload 头里，按 partSize 分片，complete 带 uploadId 与分片表', async () => {
    const backend = installMockFetch();
    await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@example.com', password: 'cloudalbum-dev-1' }) });
    const seen: string[] = [];
    const put: PutImpl = async (url, body, opts) => {
      seen.push(`${url} ${opts.headers?.['Authorization'] ?? ''}`);
      const r = await fetch(url, { method: 'PUT', body: await blobText(body), ...(opts.headers ? { headers: opts.headers } : {}) });
      return { status: r.status, responseText: await r.text(), etag: r.headers.get('ETag') ?? '' };
    };
    const photo = await prefixTokenUpload(file(Math.round(2.5 * MB)), { put });
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s).toMatch(/uploadId=.+&part=\d/);
      expect(s).toMatch(/CA-Upload mock-upload\./);
      expect(s).not.toMatch(/token=/);
    }
    expect(photo.status).toBe('READY');
    expect(backend.photos[0]!.sizeBytes).toBe(Math.round(2.5 * MB));
  });

  it('续传：只补传服务端还没有的分片', async () => {
    installMockFetch();
    await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@example.com', password: 'cloudalbum-dev-1' }) });
    let fail = true;
    const parts: number[] = [];
    const put: PutImpl = async (url, body, opts) => {
      const part = Number(new URL(url, 'http://x').searchParams.get('part'));
      if (part === 2 && fail) {
        fail = false;
        throw new Error('网络中断');
      }
      parts.push(part);
      const r = await fetch(url, { method: 'PUT', body: await blobText(body), ...(opts.headers ? { headers: opts.headers } : {}) });
      return { status: r.status, responseText: '' };
    };
    let resume: ResumeState | undefined;
    const f = file(Math.round(2.5 * MB));
    await expect(prefixTokenUpload(f, { put, onResumeState: (s) => { resume = { ...s, done: { ...s.done } }; } })).rejects.toThrow('网络中断');
    expect(parts).toEqual([1]);
    expect(resume?.done).toEqual({ 1: expect.any(String) });
    const photo = await prefixTokenUpload(f, { put, ...(resume ? { resume } : {}) });
    expect(parts).toEqual([1, 2, 3]);
    expect(photo.status).toBe('READY');
  });

  it('越权：令牌不允许写别人的前缀（服务端 403）', async () => {
    installMockFetch();
    await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@example.com', password: 'cloudalbum-dev-1' }) });
    const r = await fetch('/api/storage/upload?key=raw/someone-else/x.jpg&uploadId=u1&part=1', { method: 'PUT', body: 'x', headers: { Authorization: 'CA-Upload mock-upload.me' } });
    expect(r.status).toBe(403);
  });
});

describe('uploadFile 与轮询', () => {
  it('identity-pool 策略收到前缀令牌（error-fallback）时改走前缀令牌', async () => {
    installMockFetch();
    await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'demo@example.com', password: 'cloudalbum-dev-1' }) });
    const put: PutImpl = async (url, body, opts) => {
      const r = await fetch(url, { method: 'PUT', body: await blobText(body), ...(opts.headers ? { headers: opts.headers } : {}) });
      return { status: r.status, responseText: '' };
    };
    const p = await uploadFile(file(1000), 'identity-pool', { put });
    expect(p.status).toBe('READY');
  });

  it('pollUntilSettled：PROCESSING 时按退避间隔轮询，直到 READY', async () => {
    const delays: number[] = [];
    const states: Photo['status'][] = ['PROCESSING', 'PROCESSING', 'READY'];
    const get = vi.fn(async () => ({ id: 'p', status: states.shift()! }) as Photo);
    const done = await pollUntilSettled({ id: 'p', status: 'PROCESSING' } as Photo, { get, sleep: async (ms) => { delays.push(ms); } });
    expect(done.status).toBe('READY');
    expect(delays).toEqual([1000, 1600, 2560]);
  });
});
