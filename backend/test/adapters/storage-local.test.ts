// StoragePort 契约测试：local 驱动（真实文件系统，临时目录）+ F6 签名上传、媒体签名、F14 分片辅助
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LocalStorage, asLocalMultipart, asLocalStorage, isValidKey, signUpload } from '../../src/adapters/storage/local.js';
import type { StoragePort } from '../../src/ports/storage.js';
import { adapterDeps, tempDir, testConfig } from '../helpers/media-fixtures.js';

function makeLocal(): { storage: LocalStorage; root: string } {
  const data = tempDir();
  const cfg = testConfig({}, data);
  const root = path.join(data, 'uploads');
  return { storage: new LocalStorage(adapterDeps(cfg), { root, module: 'storage', driver: 'local', awsService: null, redirectPrefix: '/_media_local' }), root };
}

async function readAll(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

/** 所有 StoragePort 驱动都应满足的行为（s3 驱动的实现者可以复用这组断言） */
export function storageContract(name: string, make: () => Promise<StoragePort>): void {
  describe(`StoragePort 契约：${name}`, () => {
    it('putObject / headObject / getObject / deleteObjects', async () => {
      const s = await make();
      await s.init?.();
      expect(await s.headObject('variants/p1/thumb_200.webp')).toBeNull();
      await s.putObject('variants/p1/thumb_200.webp', Buffer.from('hello'), { contentType: 'image/webp' });
      const info = await s.headObject('variants/p1/thumb_200.webp');
      expect(info).toMatchObject({ key: 'variants/p1/thumb_200.webp', size: 5, contentType: 'image/webp' });
      const obj = await s.getObject('variants/p1/thumb_200.webp');
      expect((await readAll(obj.body)).toString()).toBe('hello');
      await s.putObject('variants/p1/display_1080.webp', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), { contentType: 'image/webp' });
      expect((await s.headObject('variants/p1/display_1080.webp'))?.size).toBe(4);
      await s.deleteObjects(['variants/p1/thumb_200.webp', 'variants/p1/display_1080.webp', 'variants/p1/missing.webp']);
      expect(await s.headObject('variants/p1/thumb_200.webp')).toBeNull();
    });

    it('list：按前缀与游标分页，不含临时目录', async () => {
      const s = await make();
      await s.init?.();
      for (const k of ['raw/u1/a.jpg', 'raw/u1/b.jpg', 'raw/u2/c.jpg', 'variants/x/thumb_200.webp']) {
        await s.putObject(k, Buffer.from(k), { contentType: 'image/jpeg' });
      }
      const all = await s.list('raw/');
      expect(all.items.map((i) => i.key)).toEqual(['raw/u1/a.jpg', 'raw/u1/b.jpg', 'raw/u2/c.jpg']);
      expect((await s.list('raw/u1/')).items).toHaveLength(2);
      expect((await s.list('raw/u1/', 'raw/u1/a.jpg')).items.map((i) => i.key)).toEqual(['raw/u1/b.jpg']);
      expect((await s.list('')).items.every((i) => !i.key.startsWith('.incoming'))).toBe(true);
    });

    it('createUploadTarget：PUT + Content-Type 头 + 过期时间', async () => {
      const s = await make();
      const t = await s.createUploadTarget({ key: 'raw/u1/p.jpg', contentType: 'image/jpeg', maxBytes: 1000, expiresInSec: 60 });
      expect(t.method).toBe('PUT');
      expect(t.headers['Content-Type']).toBe('image/jpeg');
      expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('createReadUrl：公开媒体 URL 稳定；私有媒体带签名', async () => {
      const s = await make();
      const a = await s.createReadUrl('variants/p1/thumb_200.webp', { visibility: 'public', expiresInSec: 600 });
      const b = await s.createReadUrl('variants/p1/thumb_200.webp', { visibility: 'public', expiresInSec: 600 });
      expect(a).toBe(b);
      const p = await s.createReadUrl('raw/u1/p.jpg', { visibility: 'private', expiresInSec: 600 });
      expect(p).not.toBe(a);
    });

    it('Migratable：exportBatch → importBatch 幂等', async () => {
      const src = await make();
      const dst = await make();
      await src.putObject('raw/u1/a.jpg', Buffer.from('aaa'), { contentType: 'image/jpeg' });
      await src.putObject('raw/u1/b.jpg', Buffer.from('bb'), { contentType: 'image/jpeg' });
      expect(await src.count()).toBe(2);
      const batch = await src.exportBatch(undefined, 10);
      expect(await dst.importBatch(batch.items)).toEqual({ written: 2, skipped: 0 });
      expect(await dst.importBatch((await src.exportBatch(undefined, 10)).items)).toEqual({ written: 0, skipped: 2 });
      expect((await dst.headObject('raw/u1/a.jpg'))?.size).toBe(3);
    });

    it('probe：目录可写时 ok（本地实现的 localHealth）', async () => {
      const s = await make();
      const r = await s.probe();
      expect(['ok', 'degraded']).toContain(r.status);
    });
  });
}

storageContract('local', async () => makeLocal().storage);

describe('LocalStorage：F6 签名上传', () => {
  it('上传 URL 的签名可校验；篡改、过期、参数不全都被拒绝', async () => {
    const { storage } = makeLocal();
    const t = await storage.createUploadTarget({ key: 'raw/u1/p.jpg', contentType: 'image/jpeg', maxBytes: 1000, expiresInSec: 60 });
    const q = Object.fromEntries(new URL(t.url, 'http://x').searchParams);
    expect(t.url.startsWith('/api/storage/upload?')).toBe(true);
    const ok = await storage.verifyUploadSignature(q);
    expect(ok).toMatchObject({ ok: true, key: 'raw/u1/p.jpg', contentType: 'image/jpeg', maxBytes: 1000 });
    expect(await storage.verifyUploadSignature({ ...q, max: '99999' })).toMatchObject({ ok: false, code: 'UPLOAD_SIGNATURE_INVALID' });
    expect(await storage.verifyUploadSignature({ ...q, key: 'raw/u2/p.jpg' })).toMatchObject({ ok: false, code: 'UPLOAD_SIGNATURE_INVALID' });
    expect(await storage.verifyUploadSignature({ key: 'raw/u1/p.jpg' })).toMatchObject({ ok: false, code: 'UPLOAD_PARAMS_INVALID' });
    const exp = Math.floor(Date.now() / 1000) - 10;
    const sig = signUpload('test-secret-upload-hmac-key', { key: 'raw/u1/p.jpg', contentType: 'image/jpeg', maxBytes: 1000, exp });
    expect(await storage.verifyUploadSignature({ key: 'raw/u1/p.jpg', ct: 'image/jpeg', max: '1000', exp: String(exp), sig })).toMatchObject({ ok: false, code: 'UPLOAD_URL_EXPIRED' });
  });

  it('writeUpload：流式写盘、Content-Length 超限 413、流超限 413（不留临时文件）、幂等重试 200、大小不同 409', async () => {
    const { storage, root } = makeLocal();
    await storage.init();
    const r1 = await storage.writeUpload('raw/u1/a.jpg', Readable.from([Buffer.alloc(10, 1)]), { maxBytes: 100, contentType: 'image/jpeg', contentLength: 10 });
    expect(r1).toMatchObject({ ok: true, info: { size: 10 } });
    expect(readFileSync(path.join(root, 'raw', 'u1', 'a.jpg')).length).toBe(10);
    const r2 = await storage.writeUpload('raw/u1/b.jpg', Readable.from([Buffer.alloc(10)]), { maxBytes: 5, contentType: 'image/jpeg', contentLength: 10 });
    expect(r2).toMatchObject({ ok: false, status: 413 });
    const r3 = await storage.writeUpload('raw/u1/c.jpg', Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), { maxBytes: 5, contentType: 'image/jpeg' });
    expect(r3).toMatchObject({ ok: false, status: 413 });
    expect(existsSync(path.join(root, 'raw', 'u1', 'c.jpg'))).toBe(false);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(path.join(root, '.incoming')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const r4 = await storage.writeUpload('raw/u1/a.jpg', Readable.from([Buffer.alloc(10, 1)]), { maxBytes: 100, contentType: 'image/jpeg', contentLength: 10 });
    expect(r4).toMatchObject({ ok: true, idempotent: true });
    const r5 = await storage.writeUpload('raw/u1/a.jpg', Readable.from([Buffer.alloc(11)]), { maxBytes: 100, contentType: 'image/jpeg', contentLength: 11 });
    expect(r5).toMatchObject({ ok: false, status: 409 });
  });

  it('媒体签名：校验通过；篡改键 / 过期被拒绝；X-Accel-Redirect 路径', async () => {
    const { storage } = makeLocal();
    const url = await storage.createReadUrl('raw/u1/p.jpg', { visibility: 'private', expiresInSec: 600 });
    const u = new URL(url, 'http://x');
    expect(u.pathname).toBe('/media/raw/u1/p.jpg');
    expect(await storage.verifyMediaSignature('raw/u1/p.jpg', u.searchParams.get('exp'), u.searchParams.get('sig'))).toBe(true);
    expect(await storage.verifyMediaSignature('raw/u2/p.jpg', u.searchParams.get('exp'), u.searchParams.get('sig'))).toBe(false);
    expect(await storage.verifyMediaSignature('raw/u1/p.jpg', '1', u.searchParams.get('sig'))).toBe(false);
    expect(storage.internalRedirectPath('variants/p1/thumb_200.webp', 'public')).toBe('/_media_local/public/variants/p1/thumb_200.webp');
    expect(storage.internalRedirectPath('raw/u1/p.jpg', 'private')).toBe('/_media_local/private/raw/u1/p.jpg');
    expect(asLocalStorage(storage)).toBe(storage);
  });

  it('非法键被拒绝（路径穿越、绝对路径、.incoming）', async () => {
    expect(isValidKey('raw/u1/a.jpg')).toBe(true);
    for (const k of ['../etc/passwd', 'raw/../../x', '/abs', 'raw//x', '.incoming/x', 'raw/u1/a b.jpg', '']) expect(isValidKey(k), k).toBe(false);
    const { storage } = makeLocal();
    await expect(storage.headObject('../x')).rejects.toMatchObject({ status: 400 });
  });
});

describe('LocalStorage：F14 分片辅助', () => {
  it('分片落盘、列出、按序拼接、清理分片目录；缺片与超限被拒绝', async () => {
    const { storage, root } = makeLocal();
    await storage.init();
    const mp = asLocalMultipart(storage)!;
    expect(mp).toBe(storage);
    const up = 'upload-0001-abcdef';
    expect(await mp.writePart(up, 2, Readable.from([Buffer.from('world')]), { maxBytes: 100 })).toMatchObject({ ok: true, part: 2, size: 5 });
    expect(await mp.completeParts(up, 'raw/u1/x.jpg', { maxBytes: 100 })).toMatchObject({ ok: false, reason: '缺少分片 1' });
    expect(await mp.writePart(up, 1, Readable.from([Buffer.from('hello ')]), { maxBytes: 100 })).toMatchObject({ ok: true, part: 1 });
    // 重传同一片覆盖旧文件
    expect(await mp.writePart(up, 1, Readable.from([Buffer.from('hello, ')]), { maxBytes: 100 })).toMatchObject({ ok: true, size: 7 });
    expect((await mp.listParts(up)).map((p) => [p.part, p.size])).toEqual([[1, 7], [2, 5]]);
    expect(await mp.completeParts(up, 'raw/u1/x.jpg', { maxBytes: 5 })).toMatchObject({ ok: false });
    const done = await mp.completeParts(up, 'raw/u1/x.jpg', { maxBytes: 100, expectedParts: 2 });
    expect(done).toMatchObject({ ok: true, parts: 2, info: { size: 12 } });
    expect(readFileSync(path.join(root, 'raw', 'u1', 'x.jpg'), 'utf8')).toBe('hello, world');
    expect(await mp.listParts(up)).toEqual([]);
    expect(await mp.writePart('bad', 1, Readable.from([Buffer.from('x')]), { maxBytes: 10 })).toMatchObject({ ok: false, status: 400 });
    expect(await mp.writePart(up, 0, Readable.from([Buffer.from('x')]), { maxBytes: 10 })).toMatchObject({ ok: false, status: 400 });
    expect(await mp.writePart(up, 1, Readable.from([Buffer.alloc(20)]), { maxBytes: 10, contentLength: 20 })).toMatchObject({ ok: false, status: 413 });
  });

  it('abortParts 与 cleanupIncoming', async () => {
    const { storage } = makeLocal();
    await storage.init();
    await storage.writePart('upload-0002-abcdef', 1, Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    await storage.abortParts('upload-0002-abcdef');
    expect(await storage.listParts('upload-0002-abcdef')).toEqual([]);
    await storage.writePart('upload-0003-abcdef', 1, Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    expect((await storage.cleanupIncoming(60_000)).removed).toBe(0);
    expect((await storage.cleanupIncoming(-1)).removed).toBeGreaterThanOrEqual(1);
    expect(await storage.listParts('upload-0003-abcdef')).toEqual([]);
  });
});
