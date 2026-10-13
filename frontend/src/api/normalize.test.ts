// 后端各路由的 JSON 写法不完全一致（next / nextCursor、owner / ownerName、{counters} / 扁平计数、{comment} / 评论本身）：
// 前端在 endpoints.ts、social.ts 与上传器里统一。
import { describe, expect, it, vi } from 'vitest';
import { deriveRawKey, extensionForType, partNumbers } from '../upload/prefixTokenUpload';
import { jsonResponse } from '../test/helpers';
import { normPage, normPhoto, photosApi } from './endpoints';
import { createSocialApi, normComment, normCounters } from './social';
import type { Photo } from './types';

describe('normPage / normPhoto', () => {
  it('next 与 nextCursor 统一为 nextCursor', () => {
    expect(normPage({ items: [1], next: 'c2' })).toEqual({ items: [1], nextCursor: 'c2' });
    expect(normPage({ items: [], nextCursor: 'c3' })).toEqual({ items: [], nextCursor: 'c3' });
    expect(normPage({ items: [] })).toEqual({ items: [], nextCursor: null });
  });

  it('owner.displayName → ownerName', () => {
    const p = normPhoto({ id: 'p', owner: { id: 'u', displayName: '小明' } } as Photo);
    expect(p.ownerName).toBe('小明');
    expect(p.urls).toEqual({});
  });

  it('feed 带 scope 查询参数，响应的 next 被识别', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [{ id: 'p1', owner: { id: 'u', displayName: 'A' }, urls: {} }], next: 'n1', scope: 'public' }));
    globalThis.fetch = fetchMock as typeof fetch;
    const page = await photosApi.feed(null, { scope: 'public' });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/feed?scope=public');
    expect(page.nextCursor).toBe('n1');
    expect(page.items[0]!.ownerName).toBe('A');
  });

  it('POST /api/photos 同时发送 size 与 sizeBytes；uploadTarget 归一为 upload', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ photoId: 'p', photo: { id: 'p', urls: {} }, uploadTarget: { method: 'PUT', url: '/u', headers: {}, expiresAt: '' } }, { status: 201 });
    }) as typeof fetch;
    const r = await photosApi.create({ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 10 });
    expect(body).toMatchObject({ size: 10, sizeBytes: 10 });
    expect(r.upload?.url).toBe('/u');
  });
});

describe('social 归一', () => {
  it('计数：{counters:{…}} 或扁平；点赞响应只有 likes 时沿用之前的评论数', () => {
    expect(normCounters({ counters: { likes: 2, comments: 5 }, likedByMe: true })).toEqual({ likes: 2, comments: 5, likedByMe: true });
    expect(normCounters({ likes: 3, likedByMe: true }, { likes: 2, comments: 5, likedByMe: false })).toEqual({ likes: 3, comments: 5, likedByMe: true });
  });

  it('评论：user.displayName → userName', () => {
    expect(normComment({ id: 'c', photoId: 'p', userId: 'u', text: 't', createdAt: '', user: { id: 'u', displayName: '小红' } }).userName).toBe('小红');
  });

  it('路径：/social/photos/:id、/likes、/comments/:commentId、/api/shares', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(u)}`);
      if (String(u).startsWith('/api/shares/')) return jsonResponse({ share: { token: 't', expiresAt: '2030-01-01T00:00:00Z' }, photo: { id: 'p', urls: {} } });
      if (String(u) === '/api/shares') return jsonResponse({ token: 't', photoId: 'p', expiresAt: 'x', url: 'http://h/s/t' }, { status: 201 });
      if (init?.method === 'DELETE' && String(u).includes('/comments/')) return new Response(null, { status: 204 });
      if (String(u).endsWith('/comments') && init?.method === 'POST') return jsonResponse({ comment: { id: 'c', photoId: 'p', userId: 'u', text: 'hi', createdAt: '', user: { id: 'u', displayName: 'U' } } }, { status: 201 });
      return jsonResponse({ photoId: 'p', counters: { likes: 1, comments: 0 }, likedByMe: false, likes: 1 });
    }) as typeof fetch;
    const s = createSocialApi('');
    await s.counters('p');
    await s.like('p');
    await s.unlike('p');
    expect((await s.addComment('p', 'hi')).userName).toBe('U');
    await s.deleteComment('p', 'c');
    expect((await s.createShare('p', 3600)).url).toBe('http://h/s/t');
    expect((await s.getShare('t')).expiresAt).toBe('2030-01-01T00:00:00Z');
    expect(calls).toEqual([
      'GET /social/photos/p',
      'POST /social/photos/p/likes',
      'DELETE /social/photos/p/likes',
      'POST /social/photos/p/comments',
      'DELETE /social/photos/p/comments/c',
      'POST /api/shares',
      'GET /api/shares/t',
    ]);
  });
});

describe('F14 约定', () => {
  it('原图键 = 会话前缀 + photoId + 扩展名（与 image-core 的 extensionFor 一致）', () => {
    expect(extensionForType('image/jpeg')).toBe('jpg');
    expect(extensionForType('image/png')).toBe('png');
    expect(extensionForType('image/webp')).toBe('webp');
    expect(deriveRawKey('raw/u1/', 'p1', 'image/jpeg')).toBe('raw/u1/p1.jpg');
    expect(deriveRawKey('raw/u1', 'p1', 'image/png')).toBe('raw/u1/p1.png');
  });

  it('已收到的分片：数字数组或 [{part, size}]', () => {
    expect(partNumbers([1, 2])).toEqual([1, 2]);
    expect(partNumbers([{ part: 1 }, { part: 3 }])).toEqual([1, 3]);
    expect(partNumbers(undefined)).toEqual([]);
  });
});
