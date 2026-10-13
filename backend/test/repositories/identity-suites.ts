// 仓储层的方言无关用例（总纲 4.3 第 4 条：仓储在 SQLite 与 PostgreSQL 上各跑一遍）。
// identity.test.ts 用 SQLite 跑；identity.int.test.ts 用 PostgreSQL 16（CLOUDALBUM_IT=1）跑同一套。
import { describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { nowIso } from '../../src/db/dialect.js';
import { ensureDefaultAlbum, findAlbum, insertAlbum, listAlbumPhotos, listAlbumsByOwner, updateAlbum, deleteAlbum, coverPhotoOf } from '../../src/repositories/albums.js';
import { appendAudit, listAudit, verifyAuditChain } from '../../src/repositories/audit.js';
import { finishLabRun, getLabResult, getLabRun, insertLabRun, listLabResults, listLabRuns, upsertLabResult } from '../../src/repositories/lab.js';
import {
  countUnread, getNotificationPrefs, insertDelivery, deliveryExists, insertNotification, listNotifications, markAllNotificationsRead,
  markNotificationRead, setNotificationPrefs,
} from '../../src/repositories/notifications.js';
import { findOutboxForRecipient, insertOutboxEmail, listOutbox, listOutboxForRecipient, deleteOutboxBefore } from '../../src/repositories/outbox.js';
import {
  bumpTokenVersion, decodeCursor, deleteAuthTokens, encodeCursor, findAuthTokenByHash, findUserByEmail, insertAuthToken, insertUser, listUsers,
  markAuthTokenUsed, recordLoginFailure, resetLoginFailures, userIsVerified,
} from '../../src/repositories/users.js';

let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${(seq += 1)}`;

export function identityRepositorySuites(name: string, getDb: () => Knex): void {
  describe(`users / auth_tokens（${name}）`, () => {
    it('插入、按邮箱（不区分大小写）查找、token_version 递增', async () => {
      const db = getDb();
      const email = `${uniq('u')}@Example.com`;
      const u = await insertUser(db, { email, displayName: 'U', passwordHash: 'h', emailVerified: true });
      expect(u.email).toBe(email.toLowerCase());
      const found = await findUserByEmail(db, email.toUpperCase());
      expect(found?.id).toBe(u.id);
      expect(userIsVerified(found!)).toBe(true);
      expect(await bumpTokenVersion(db, u.id)).toBe(1);
      expect(await bumpTokenVersion(db, u.id)).toBe(2);
    });

    it('登录失败计数达到阈值时锁定，并重置计数', async () => {
      const db = getDb();
      const u = await insertUser(db, { email: `${uniq('l')}@example.com`, displayName: 'L', passwordHash: 'h' });
      expect((await recordLoginFailure(db, u.id, 3, 15)).lockedUntil).toBeNull();
      await recordLoginFailure(db, u.id, 3, 15);
      const r = await recordLoginFailure(db, u.id, 3, 15);
      expect(Date.parse(r.lockedUntil!)).toBeGreaterThan(Date.now());
      await resetLoginFailures(db, u.id);
      const row = await db('users').where({ id: u.id }).first();
      expect(Number(row.failed_logins)).toBe(0);
      expect(row.locked_until).toBeNull();
    });

    it('auth_tokens：只存哈希；markAuthTokenUsed 原子（第二次返回 false）；按族删除', async () => {
      const db = getDb();
      const u = await insertUser(db, { email: `${uniq('t')}@example.com`, displayName: 'T', passwordHash: 'h' });
      const fam = `fam-${uniq('')}`;
      const t1 = await insertAuthToken(db, { userId: u.id, type: 'refresh', tokenHash: uniq('hash1-'), familyId: fam, expiresAt: nowIso() });
      await insertAuthToken(db, { userId: u.id, type: 'refresh', tokenHash: uniq('hash2-'), familyId: fam, expiresAt: nowIso() });
      expect((await findAuthTokenByHash(db, t1.token_hash, 'refresh'))?.id).toBe(t1.id);
      expect(await findAuthTokenByHash(db, t1.token_hash, 'verify_email')).toBeUndefined();
      expect(await markAuthTokenUsed(db, t1.id)).toBe(true);
      expect(await markAuthTokenUsed(db, t1.id)).toBe(false);
      expect(await deleteAuthTokens(db, { familyId: fam })).toBe(2);
      await expect(deleteAuthTokens(db, {})).rejects.toThrow();
    });

    it('listUsers：搜索与游标分页', async () => {
      const db = getDb();
      const tag = uniq('page');
      for (let i = 0; i < 3; i += 1) await insertUser(db, { email: `${tag}-${i}@example.com`, displayName: `P${i}`, passwordHash: null });
      const p1 = await listUsers(db, { q: tag, limit: 2 });
      expect(p1.items).toHaveLength(2);
      const p2 = await listUsers(db, { q: tag, limit: 2, cursor: p1.nextCursor! });
      expect(p2.items).toHaveLength(1);
      expect(p2.nextCursor).toBeNull();
      expect(new Set([...p1.items, ...p2.items].map((u) => u.id)).size).toBe(3);
      expect(decodeCursor(encodeCursor('2026-10-13T00:00:00.000Z', 'x|y'))).toEqual({ ts: '2026-10-13T00:00:00.000Z|x', id: 'y' });
      expect(decodeCursor('%%%')).toBeNull();
    });
  });

  describe(`albums（${name}）`, () => {
    it('默认相册幂等；列表含照片数并把默认相册排在前；封面取最新 READY 照片；删除相册保留照片', async () => {
      const db = getDb();
      const u = await insertUser(db, { email: `${uniq('a')}@example.com`, displayName: 'A', passwordHash: null });
      const d1 = await ensureDefaultAlbum(db, u.id);
      const d2 = await ensureDefaultAlbum(db, u.id);
      expect(d2.id).toBe(d1.id);
      const trip = await insertAlbum(db, { ownerId: u.id, title: 'Trip', visibility: 'public' });
      const now = nowIso();
      for (const [id, status] of [['p1', 'READY'], ['p2', 'PROCESSING']] as const) {
        await db('photos').insert({ id: `${trip.id.slice(0, 8)}-${id}`, owner_id: u.id, album_id: trip.id, raw_key: `raw/${u.id}/${id}.jpg`, filename: `${id}.jpg`,
          content_type: 'image/jpeg', status, visibility: 'public', thumb_key: `variants/${id}/thumb_200.webp`, created_at: now, updated_at: now });
      }
      const list = await listAlbumsByOwner(db, u.id);
      expect(list.map((a) => a.title)).toEqual(['默认相册', 'Trip']);
      expect(Number(list[1]!.photo_count)).toBe(2);
      expect(Number(list[0]!.photo_count ?? 0)).toBe(0);
      expect((await listAlbumsByOwner(db, u.id, { onlyPublic: true })).map((a) => a.id)).toEqual([trip.id]);
      expect((await coverPhotoOf(db, trip))?.id).toBe(`${trip.id.slice(0, 8)}-p1`);
      const others = await listAlbumPhotos(db, trip.id, { viewerIsOwner: false });
      expect(others.items).toHaveLength(1);
      const owner = await listAlbumPhotos(db, trip.id, { viewerIsOwner: true, limit: 1 });
      expect(owner.nextCursor).toBeTruthy();
      await updateAlbum(db, trip.id, { title: 'Trip 2' });
      expect((await findAlbum(db, trip.id))?.title).toBe('Trip 2');
      expect(await deleteAlbum(db, trip.id)).toBe(1);
      expect(await db('photos').where({ owner_id: u.id }).whereNull('album_id')).toHaveLength(2);
    });
  });

  describe(`notifications（${name}）`, () => {
    it('event_id 幂等；未读计数；只能标记自己的；设置与投递记录', async () => {
      const db = getDb();
      const u = await insertUser(db, { email: `${uniq('n')}@example.com`, displayName: 'N', passwordHash: null });
      const ev = uniq('ev-');
      const a = await insertNotification(db, { eventId: ev, userId: u.id, type: 'like.created', title: 't', body: 'b', data: { photoId: 'p' } });
      const b = await insertNotification(db, { eventId: ev, userId: u.id, type: 'like.created', title: 't', body: 'b' });
      expect(a.created).toBe(true);
      expect(b).toEqual({ created: false, id: a.id });
      expect(await countUnread(db, u.id)).toBe(1);
      const page = await listNotifications(db, u.id);
      expect(page.items[0]!.data).toEqual({ photoId: 'p' });
      expect(await markNotificationRead(db, 'someone-else', a.id)).toBe(false);
      expect(await markNotificationRead(db, u.id, a.id)).toBe(true);
      expect(await countUnread(db, u.id)).toBe(0);
      await insertNotification(db, { eventId: uniq('ev-'), userId: u.id, type: 'x', title: 't', body: 'b' });
      expect(await markAllNotificationsRead(db, u.id)).toBe(1);
      expect(await getNotificationPrefs(db, u.id)).toEqual({ emailEnabled: false, snsSubscriptionArn: null, snsStatus: null });
      await setNotificationPrefs(db, u.id, { emailEnabled: true });
      await setNotificationPrefs(db, u.id, { snsStatus: 'pending' });
      expect(await getNotificationPrefs(db, u.id)).toMatchObject({ emailEnabled: true, snsStatus: 'pending' });
      await insertDelivery(db, { eventId: ev, channel: 'email', target: u.email, status: 'stored' });
      expect(await deliveryExists(db, ev, 'email', u.email)).toBe(true);
      expect(await deliveryExists(db, ev, 'sns', u.email)).toBe(false);
    });
  });

  describe(`outbox_emails（${name}）`, () => {
    it('筛选、本人可见范围（不含 password-reset）、保留期删除', async () => {
      const db = getDb();
      const u = await insertUser(db, { email: `${uniq('o')}@example.com`, displayName: 'O', passwordHash: null });
      const mk = (to: string[], category: string, userId: string | null) => insertOutboxEmail(db, {
        messageId: uniq('m'), to, subject: 's', category, transport: 'outbox', status: 'sent', userId, emlPath: `2026-10-13/${uniq('f')}.eml`,
      });
      const mine = await mk([u.email], 'verification', u.id);
      await mk([u.email], 'password-reset', u.id);
      const byAddress = await mk([u.email], 'notification', null);
      await mk([u.email, 'other@example.com'], 'notification', null);
      const own = await listOutboxForRecipient(db, { userId: u.id, email: u.email });
      expect(own.items.map((r) => r.id).sort()).toEqual([mine.id, byAddress.id].sort());
      expect(await findOutboxForRecipient(db, mine.id, { userId: 'x', email: 'x@example.com' })).toBeUndefined();
      expect((await findOutboxForRecipient(db, mine.id, { userId: u.id, email: u.email }))?.to_addrs).toEqual([u.email]);
      const filtered = await listOutbox(db, { to: u.email.toUpperCase(), category: 'notification' });
      expect(filtered.items).toHaveLength(2);
      const paths = await deleteOutboxBefore(db, '2999-01-01T00:00:00.000Z');
      expect(paths.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe(`audit_log（${name}）`, () => {
    it('追加带哈希链；校验通过；分页与过滤；关闭哈希链的行会被校验指出', async () => {
      const db = getDb();
      const actor = uniq('actor-');
      for (let i = 0; i < 3; i += 1) {
        await appendAudit(db, { actorType: 'user', actorId: actor, action: 'album.create', result: 'success', targetType: 'album', targetId: `a${i}`, details: { i } });
      }
      const page = await listAudit(db, { actor, limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.items[0]!.prev_hash).toBe(page.items[1]!.hash);
      const rest = await listAudit(db, { actor, limit: 2, cursor: page.nextCursor! });
      expect(rest.items).toHaveLength(1);
      expect((await listAudit(db, { action: 'album.*', actor })).items).toHaveLength(3);
      expect((await verifyAuditChain(db)).ok).toBe(true);
      await appendAudit(db, { actorType: 'system', action: 'chain.off', result: 'success' }, { hashChain: false });
      const v = await verifyAuditChain(db);
      expect(v.ok).toBe(false);
      expect(v.detail).toContain('prev_hash');
    });
  });

  describe(`lab_runs / lab_results（${name}）`, () => {
    it('登记、结束、列表；结果上传幂等覆盖', async () => {
      const db = getDb();
      const runId = uniq('R').toUpperCase().slice(0, 26);
      await insertLabRun(db, { runId, module: 'cache', experiment: 'feed-read', label: 'before', params: { vus: 10 } });
      expect((await getLabRun(db, runId))?.params).toEqual({ vus: 10 });
      expect(await finishLabRun(db, runId)).toBe(true);
      expect(await finishLabRun(db, 'NOPE')).toBe(false);
      expect((await listLabRuns(db, { module: 'cache' })).some((r) => r.run_id === runId)).toBe(true);
      const base = { runId, module: 'cache', experiment: 'feed-read', label: 'before', startedAt: nowIso(), finishedAt: nowIso(), forced: false };
      await upsertLabResult(db, { ...base, result: { v: 1 } });
      await upsertLabResult(db, { ...base, result: { v: 2 } });
      expect((await getLabResult(db, runId))?.result).toEqual({ v: 2 });
      expect((await listLabResults(db, { module: 'cache', experiment: 'feed-read' })).filter((r) => r.run_id === runId)).toHaveLength(1);
    });
  });
}
