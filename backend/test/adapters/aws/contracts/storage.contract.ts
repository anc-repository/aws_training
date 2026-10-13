// StoragePort 端口契约（与驱动无关）：local / efs / s3 都应通过同一组断言。
// 用法：describeStoragePortContract('s3（内存 S3）', { create, createPeer })。
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { StoragePort } from '../../../../src/ports/storage.js';

export interface StorageContractHarness {
  /** 每个用例前创建一个空的存储 */
  create(): Promise<StoragePort>;
  /** 迁移目标（Migratable 往返）；省略时跳过迁移用例 */
  createPeer?(): Promise<StoragePort>;
}

async function readAll(r: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

export function describeStoragePortContract(name: string, h: StorageContractHarness): void {
  describe(`StoragePort 契约：${name}`, () => {
    it('putObject → headObject → getObject 往返（大小、类型、元数据）', async () => {
      const s = await h.create();
      const body = Buffer.from('hello cloudalbum');
      await s.putObject('raw/u1/p1.jpg', body, { contentType: 'image/jpeg', metadata: { width: '10' } });
      const head = await s.headObject('raw/u1/p1.jpg');
      expect(head).toMatchObject({ key: 'raw/u1/p1.jpg', size: body.length, contentType: 'image/jpeg' });
      expect(head?.metadata?.width).toBe('10');
      const got = await s.getObject('raw/u1/p1.jpg');
      expect(got.info.size).toBe(body.length);
      expect((await readAll(got.body)).toString()).toBe('hello cloudalbum');
    });

    it('putObject 接受 Readable', async () => {
      const s = await h.create();
      await s.putObject('variants/p2/thumb_200.webp', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), { contentType: 'image/webp' });
      expect((await s.headObject('variants/p2/thumb_200.webp'))?.size).toBe(4);
    });

    it('headObject 对不存在的键返回 null', async () => {
      const s = await h.create();
      expect(await s.headObject('raw/nobody/none.jpg')).toBeNull();
    });

    it('list 按前缀分页，游标走完后返回全部键', async () => {
      const s = await h.create();
      for (let i = 0; i < 3; i += 1) await s.putObject(`raw/u9/p${i}.png`, Buffer.from([i]), { contentType: 'image/png' });
      await s.putObject('raw/other/x.png', Buffer.from([9]), { contentType: 'image/png' });
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await s.list('raw/u9/', cursor);
        keys.push(...page.items.map((i) => i.key));
        cursor = page.next;
      } while (cursor);
      expect(keys.sort()).toEqual(['raw/u9/p0.png', 'raw/u9/p1.png', 'raw/u9/p2.png']);
    });

    it('deleteObjects 删除对象，删除不存在的键不报错', async () => {
      const s = await h.create();
      await s.putObject('raw/u1/d.jpg', Buffer.from('x'), { contentType: 'image/jpeg' });
      await s.deleteObjects(['raw/u1/d.jpg', 'raw/u1/missing.jpg']);
      expect(await s.headObject('raw/u1/d.jpg')).toBeNull();
      await expect(s.deleteObjects([])).resolves.toBeUndefined();
    });

    it('createUploadTarget 返回 PUT 目标、必须携带的请求头与过期时间', async () => {
      const s = await h.create();
      const t = await s.createUploadTarget({ key: 'raw/u1/up.jpg', contentType: 'image/jpeg', maxBytes: 1024, expiresInSec: 300 });
      expect(t.method).toBe('PUT');
      expect(t.url).toBeTruthy();
      expect(t.headers['Content-Type'] ?? t.headers['content-type']).toBe('image/jpeg');
      expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('createReadUrl 对公开与私有对象都返回地址', async () => {
      const s = await h.create();
      await s.putObject('variants/p3/thumb_200.webp', Buffer.from('v'), { contentType: 'image/webp' });
      await s.putObject('raw/u1/p3.jpg', Buffer.from('r'), { contentType: 'image/jpeg' });
      expect(await s.createReadUrl('variants/p3/thumb_200.webp', { visibility: 'public', expiresInSec: 600 })).toBeTruthy();
      expect(await s.createReadUrl('raw/u1/p3.jpg', { visibility: 'private', expiresInSec: 600 })).toBeTruthy();
    });

    it('Migratable：exportBatch → importBatch 往返且幂等，count 一致', async () => {
      if (!h.createPeer) return;
      const src = await h.create();
      const dst = await h.createPeer();
      await src.putObject('raw/u1/m1.jpg', Buffer.from('one'), { contentType: 'image/jpeg' });
      await src.putObject('variants/m1/thumb_200.webp', Buffer.from('two!'), { contentType: 'image/webp', metadata: { width: '200' } });
      await src.putObject('reports/daily/2026-10-13.csv', Buffer.from('a,b'), { contentType: 'text/csv' });
      const copy = async () => {
        let written = 0;
        let skipped = 0;
        let cursor: string | undefined;
        do {
          const batch = await src.exportBatch(cursor, 2);
          const r = await dst.importBatch(batch.items);
          written += r.written;
          skipped += r.skipped;
          cursor = batch.next;
        } while (cursor);
        return { written, skipped };
      };
      expect(await copy()).toEqual({ written: 3, skipped: 0 });
      expect(await copy()).toEqual({ written: 0, skipped: 3 });
      expect(await dst.count()).toBe(await src.count());
      expect((await dst.headObject('variants/m1/thumb_200.webp'))?.size).toBe(4);
    });
  });
}
