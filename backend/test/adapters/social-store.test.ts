// SocialStorePort 契约测试：db 驱动（SQLite，内存库 + 全部迁移）。一人一赞、计数、评论游标、分享链接过期、清理、迁移
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbSocialStore, clampShareTtl } from '../../src/adapters/social-store/db.js';
import type { SocialStorePort } from '../../src/ports/social-store.js';
import { adapterDeps, testConfig, testDb } from '../helpers/media-fixtures.js';

let db: Knex;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.destroy();
});

/** 所有 SocialStorePort 驱动共有的行为（dynamodb 驱动的实现者可以复用） */
export function socialContract(name: string, make: (db: Knex) => SocialStorePort): void {
  describe(`SocialStorePort 契约：${name}`, () => {
    it('like 幂等（一人一赞），unlike 只在删除成功时减计数', async () => {
      const s = make(db);
      expect(await s.like('p1', 'u1')).toEqual({ created: true, likes: 1 });
      expect(await s.like('p1', 'u1')).toEqual({ created: false, likes: 1 });
      expect(await s.like('p1', 'u2')).toEqual({ created: true, likes: 2 });
      expect(await s.unlike('p1', 'u1')).toEqual({ removed: true, likes: 1 });
      expect(await s.unlike('p1', 'u1')).toEqual({ removed: false, likes: 1 });
      expect([...(await s.likedBy(['p1', 'p2'], 'u2'))]).toEqual(['p1']);
    });

    it('并发重复点赞不会把计数加两次', async () => {
      const s = make(db);
      const rs = await Promise.all(Array.from({ length: 5 }, () => s.like('p9', 'u1')));
      expect(rs.filter((r) => r.created)).toHaveLength(1);
      expect((await s.getCounters(['p9'])).p9).toEqual({ likes: 1, comments: 0 });
    });

    it('评论：ULID、倒序、游标分页、按用户列出、只能删自己的', async () => {
      const s = make(db);
      const c1 = await s.addComment('p1', 'u1', 'first');
      const c2 = await s.addComment('p1', 'u2', 'second');
      const c3 = await s.addComment('p1', 'u1', 'third');
      expect(c1.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      const page1 = await s.listComments('p1', { limit: 2 });
      expect(page1.items.map((c) => c.text)).toEqual(['third', 'second']);
      const page2 = await s.listComments('p1', { limit: 2, cursor: page1.next! });
      expect(page2.items.map((c) => c.text)).toEqual(['first']);
      expect(page2.next).toBeUndefined();
      expect((await s.listCommentsByUser('u1', { limit: 10 })).items.map((c) => c.id)).toEqual([c3.id, c1.id]);
      await expect(s.deleteComment('p1', c2.id, 'u1')).rejects.toMatchObject({ status: 403 });
      await expect(s.deleteComment('p1', 'nope', 'u1')).rejects.toMatchObject({ status: 404 });
      await s.deleteComment('p1', c2.id, 'u2');
      expect((await s.getCounters(['p1', 'px']))).toEqual({ p1: { likes: 0, comments: 2 }, px: { likes: 0, comments: 0 } });
    });

    it('分享链接：自行比较 expiresAt（过期返回 null）；purgeExpiredShares 清理过期行', async () => {
      const s = make(db);
      const live = await s.createShare({ photoId: 'p1', createdBy: 'u1', ttlSec: 3600 });
      expect(live.token.length).toBeGreaterThanOrEqual(20);
      expect(Date.parse(live.expiresAt) - Date.now()).toBeGreaterThan(3500_000);
      expect(await s.resolveShare(live.token)).toMatchObject({ photoId: 'p1', createdBy: 'u1' });
      expect(await s.resolveShare('missing')).toBeNull();
      // 直接写一条已过期的链接（模拟 TTL 时间流逝）
      await db('share_links').insert({ token: 'expired-token-1', photo_id: 'p1', created_by: 'u1', created_at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-02T00:00:00.000Z' });
      expect(await s.resolveShare('expired-token-1')).toBeNull();
      expect(await s.purgeExpiredShares()).toBeGreaterThanOrEqual(1);
      expect(await db('share_links').where({ token: 'expired-token-1' }).first()).toBeUndefined();
      expect(await s.resolveShare(live.token)).not.toBeNull();
    });

    it('purgePhoto 清理该照片的全部社交数据', async () => {
      const s = make(db);
      await s.like('p1', 'u1');
      await s.addComment('p1', 'u1', 'x');
      const share = await s.createShare({ photoId: 'p1', createdBy: 'u1', ttlSec: 600 });
      await s.like('p2', 'u1');
      await s.purgePhoto('p1');
      expect((await s.getCounters(['p1'])).p1).toEqual({ likes: 0, comments: 0 });
      expect((await s.listComments('p1', { limit: 10 })).items).toEqual([]);
      expect(await s.resolveShare(share.token)).toBeNull();
      expect((await s.getCounters(['p2'])).p2!.likes).toBe(1);
    });

    it('Migratable：exportBatch / importBatch 幂等，计数随导入维护', async () => {
      const src = make(db);
      await src.like('p1', 'u1');
      await src.like('p1', 'u2');
      await src.addComment('p1', 'u1', 'hi');
      await src.createShare({ photoId: 'p1', createdBy: 'u1', ttlSec: 600 });
      expect(await src.count()).toBe(4);
      const items = [];
      let cursor: string | undefined;
      do {
        const b = await src.exportBatch(cursor, 2);
        items.push(...b.items);
        cursor = b.next;
      } while (cursor);
      expect(items.map((i) => i.kind).sort()).toEqual(['comment', 'like', 'like', 'share']);
      const other = await testDb();
      try {
        const dst = make(other);
        expect(await dst.importBatch(items)).toEqual({ written: 4, skipped: 0 });
        expect(await dst.importBatch(items)).toEqual({ written: 0, skipped: 4 });
        expect((await dst.getCounters(['p1'])).p1).toEqual({ likes: 2, comments: 1 });
      } finally {
        await other.destroy();
      }
    });
  });
}

socialContract('db', (d) => new DbSocialStore(adapterDeps(testConfig(), { db: d })));

describe('DbSocialStore', () => {
  it('upsertPhotoSummary 是空操作；probe ok；分享有效期夹紧到 [60 秒, 30 天]', async () => {
    const s = new DbSocialStore(adapterDeps(testConfig(), { db }));
    await expect(s.upsertPhotoSummary({ photoId: 'p', ownerId: 'u', visibility: 'public', status: 'READY' })).resolves.toBeUndefined();
    expect((await s.probe()).status).toBe('ok');
    expect(clampShareTtl(1)).toBe(60);
    expect(clampShareTtl(10 ** 9)).toBe(30 * 24 * 3600);
    expect(clampShareTtl(undefined)).toBe(24 * 3600);
  });
});
