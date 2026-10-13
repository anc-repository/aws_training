// ImageProcessorPort 契约（inline / worker）与 PhotoPipeline：渲染 → 幂等写回 → 打标签 → 审核 → 通知；对账；位置加密
import path from 'node:path';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestImage, variantKey } from '@cloudalbum/image-core';
import { ImageProcessingFailedError, InlineImageProcessor, isImageProcessingFailed } from '../../src/adapters/image-processing/inline.js';
import { WorkerImageProcessor } from '../../src/adapters/image-processing/worker.js';
import { MemoryQueue } from '../../src/adapters/queue/memory.js';
import { SyncQueue } from '../../src/adapters/queue/sync.js';
import { LocalStorage } from '../../src/adapters/storage/local.js';
import { NoTagger } from '../../src/adapters/tagging/none.js';
import type { AdapterDeps } from '../../src/adapters/types.js';
import type { AppConfig } from '../../src/config/schema.js';
import { createRequestContext, runWithContext } from '../../src/observability/request-context.js';
import type { CryptoPort, EncryptedBlob } from '../../src/ports/crypto.js';
import type { ImageProcessorPort, ImageResult } from '../../src/ports/image-processor.js';
import type { TaggerPort } from '../../src/ports/tagger.js';
import { listSteps } from '../../src/repositories/job-runs.js';
import { getLabels, getPhoto, insertPhoto, markProcessing } from '../../src/repositories/photos.js';
import {
  decryptPhotoLocation, encryptPhotoLocation, handleImageOutcome, parseBlob, pipelineDepsFromAdapter, reconcileLocal,
  runInlinePipeline, serializeBlob, tagPhoto, type ImageTagPayload, type PipelineDeps,
} from '../../src/services/photo-pipeline.js';
import { adapterDeps, seedAlbum, seedUser, tempDir, testConfig, testDb, waitFor } from '../helpers/media-fixtures.js';

let db: Knex;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.destroy();
});

interface Rig { cfg: AppConfig; deps: AdapterDeps; storage: LocalStorage; pd: PipelineDeps }

async function rig(env: Record<string, string> = {}, opts: { tagger?: TaggerPort; images?: 'inline' | 'worker' } = {}): Promise<Rig> {
  const data = tempDir();
  const cfg = testConfig({ WORKFLOW_LOCAL_BACKOFF_MS: '1', ...env }, data);
  const deps = adapterDeps(cfg, { db });
  const storage = new LocalStorage(deps, { root: path.join(data, 'uploads'), module: 'storage', driver: 'local', awsService: null, redirectPrefix: '/_media_local' });
  await storage.init();
  deps.storage = storage;
  deps.tagger = opts.tagger ?? new NoTagger(deps);
  const queue = cfg.queue.QUEUE_DRIVER === 'memory' ? new MemoryQueue(deps) : new SyncQueue(deps);
  deps.queue = queue;
  const images: ImageProcessorPort = opts.images === 'worker' ? new WorkerImageProcessor(deps) : new InlineImageProcessor(deps);
  deps.images = images;
  const pd = pipelineDepsFromAdapter(deps);
  queue.bind({
    'image.tag': async (j) => { await tagPhoto(pd, j.payload as ImageTagPayload); },
    'notify.fanout': async () => undefined,
    'image.process': async (j) => {
      try {
        await handleImageOutcome(pd, await (images as WorkerImageProcessor).process(j.payload as never));
      } catch (e) {
        if (isImageProcessingFailed(e)) await handleImageOutcome(pd, e.failure);
        else throw e;
      }
    },
  });
  return { cfg, deps, storage, pd };
}

async function seedPhoto(r: Rig, body: Buffer, contentType = 'image/jpeg'): Promise<{ id: string; ownerId: string; rawKey: string }> {
  const ownerId = await seedUser(db);
  const albumId = await seedAlbum(db, ownerId);
  const id = crypto.randomUUID();
  const rawKey = `raw/${ownerId}/${id}.jpg`;
  await insertPhoto(db, { id, ownerId, albumId, rawKey, filename: 'a.jpg', contentType, sizeBytes: body.length, visibility: 'public' });
  await r.storage.putObject(rawKey, body, { contentType });
  await markProcessing(db, id);
  return { id, ownerId, rawKey };
}

/** 所有 ImageProcessorPort 驱动共有的行为：submit 的结果要么是同步 ImageResult，要么是 async + expectedBy */
export function imageProcessorContract(name: string, make: (r: Rig) => ImageProcessorPort, env: Record<string, string> = {}): void {
  describe(`ImageProcessorPort 契约：${name}`, () => {
    it('submit：sync 结果带两种衍生图与元数据，或 async 带 expectedBy', async () => {
      const r = await rig(env, { images: name === 'worker' ? 'worker' : 'inline' });
      const p = await seedPhoto(r, await makeTestImage({ width: 800, height: 600 }));
      const proc = make(r);
      expect(proc.placement).toBe(name);
      const out = await proc.submit({ photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId });
      if (out.mode === 'sync') {
        expect(out.result.variants.map((v) => v.name)).toEqual(['thumb_200', 'display_1080']);
        expect(out.result.meta).toMatchObject({ width: 800, height: 600, format: 'jpeg' });
        expect(out.result.processedBy.driver).toBe(name);
      } else {
        expect(Date.parse(out.expectedBy)).toBeGreaterThan(Date.now());
      }
      await r.deps.queue?.close?.();
    });

    it('reconcile 返回 resubmitted / failed 计数', async () => {
      const r = await rig(env, { images: name === 'worker' ? 'worker' : 'inline' });
      const res = await make(r).reconcile(new Date(Date.now() - 60_000));
      expect(res).toEqual({ resubmitted: 0, failed: 0 });
      await r.deps.queue?.close?.();
    });
  });
}

imageProcessorContract('inline', (r) => r.deps.images!);
imageProcessorContract('worker', (r) => r.deps.images!, { QUEUE_DRIVER: 'memory', IMAGE_PROCESSOR: 'worker' });

describe('InlineImageProcessor', () => {
  it('写出 variants/<photoId>/*.webp；损坏的文件抛出永久错误（不重试）', async () => {
    const r = await rig();
    const p = await seedPhoto(r, await makeTestImage({ width: 1600, height: 1200 }));
    const proc = new InlineImageProcessor(r.deps);
    const out = await proc.submit({ photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId });
    expect(out.mode).toBe('sync');
    expect(await r.storage.headObject(variantKey(p.id, 'thumb_200'))).not.toBeNull();
    expect((await r.storage.headObject(variantKey(p.id, 'display_1080')))?.contentType).toBe('image/webp');
    const bad = await seedPhoto(r, Buffer.from('definitely not a jpeg'));
    const e = await proc.submit({ photoId: bad.id, rawKey: bad.rawKey, ownerId: bad.ownerId }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ImageProcessingFailedError);
    expect((e as ImageProcessingFailedError).failure).toMatchObject({ photoId: bad.id, permanent: true, processedBy: { driver: 'inline' } });
  });

  it('probe：有照片 PROCESSING 超时则 localHealth=degraded；深度探针渲染内置图片', async () => {
    const r = await rig({ IMAGE_STUCK_AFTER_SEC: '10' });
    const proc = new InlineImageProcessor(r.deps);
    expect((await proc.probe({ deep: true })).status).toBe('ok');
    const p = await seedPhoto(r, await makeTestImage());
    await db('photos').where({ id: p.id }).update({ processing_started_at: '2020-01-01T00:00:00.000Z' });
    expect((await proc.probe()).status).toBe('degraded');
  });
});

describe('PhotoPipeline', () => {
  it('runInlinePipeline（inline + sync）：READY、基础标签落库、每步一行 job_runs、路径头', async () => {
    const r = await rig();
    const p = await seedPhoto(r, await makeTestImage({ width: 1200, height: 800, color: '#2040e0', exif: { takenAt: '2023:01:05 10:00:00', make: 'Canon' } }));
    const ctx = createRequestContext();
    const res = await runWithContext(ctx, () => runInlinePipeline(r.pd, { photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId }));
    expect(res.mode).toBe('sync');
    const photo = (await getPhoto(db, p.id))!;
    expect(photo).toMatchObject({ status: 'READY', thumbKey: variantKey(p.id, 'thumb_200'), width: 1200, height: 800, takenAt: '2023-01-05T10:00:00.000Z' });
    expect(photo.processedBy).toMatchObject({ driver: 'inline' });
    const labels = (await getLabels(db, p.id)).map((l) => l.name);
    expect(labels).toEqual(expect.arrayContaining(['orientation:landscape', 'color:blue', 'year:2023', 'season:winter', 'camera:canon']));
    expect(photo.labels.length).toBe(labels.length);
    expect((await listSteps(db, p.id)).map((s) => s.name)).toEqual(['pipeline.thumbnail', 'pipeline.tag', 'pipeline.decide']);
    expect(ctx.path.get('image-processing')).toBe('inline:sync');
    expect(ctx.path.get('workflow')).toBe('inline:sync');
    expect(ctx.path.get('tagging')).toBe('none:basic');
  });

  it('X-Compare-Bypass: image → inline:bypass', async () => {
    const r = await rig();
    const p = await seedPhoto(r, await makeTestImage());
    const ctx = createRequestContext();
    ctx.bypass.add('image');
    await runWithContext(ctx, () => runInlinePipeline(r.pd, { photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId }));
    expect(ctx.path.get('image-processing')).toBe('inline:bypass');
  });

  it('永久错误：FAILED + 原图被删除；写回幂等（READY 不被覆盖，重复结果 ignored-duplicate）', async () => {
    const r = await rig();
    const bad = await seedPhoto(r, Buffer.from('nope'));
    await runInlinePipeline(r.pd, { photoId: bad.id, rawKey: bad.rawKey, ownerId: bad.ownerId });
    expect((await getPhoto(db, bad.id))!.status).toBe('FAILED');
    expect(await r.storage.headObject(bad.rawKey)).toBeNull();

    const ok = await seedPhoto(r, await makeTestImage());
    const res = await new InlineImageProcessor(r.deps).submit({ photoId: ok.id, rawKey: ok.rawKey, ownerId: ok.ownerId });
    const result = (res as { result: ImageResult }).result;
    expect(await handleImageOutcome(r.pd, result)).toBe('applied');
    expect(await handleImageOutcome(r.pd, result)).toBe('ignored-duplicate');
    expect(await handleImageOutcome(r.pd, { photoId: ok.id, error: 'late failure', permanent: true, processedBy: { driver: 'lambda', durationMs: 1, host: 'x' } })).toBe('ignored-duplicate');
    expect((await getPhoto(db, ok.id))!.status).toBe('READY');
    // 迟到的成功可以恢复 FAILED
    await db('photos').where({ id: ok.id }).update({ status: 'FAILED' });
    expect(await handleImageOutcome(r.pd, result)).toBe('applied');
    // 不覆盖 BLOCKED
    await db('photos').where({ id: ok.id }).update({ status: 'BLOCKED' });
    expect(await handleImageOutcome(r.pd, result)).toBe('ignored-stale');
  });

  it('审核 block（非 log 模式）→ BLOCKED，并给主人与管理员写站内信', async () => {
    const blocking: TaggerPort = {
      meta: { module: 'tagging', driver: 'rekognition', awsService: 'Amazon Rekognition', authoritative: false },
      probe: async () => ({ status: 'ok', detail: '' }),
      analyze: async () => ({
        labels: [{ name: 'Weapon', confidence: 97, source: 'rekognition' }],
        moderation: { verdict: 'block', labels: [{ name: 'Violence', confidence: 97 }] },
        analyzedBy: { driver: 'rekognition', durationMs: 120, input: 'bytes' },
      }),
    };
    const r = await rig({}, { tagger: blocking });
    const adminId = await seedUser(db, { role: 'admin' });
    const p = await seedPhoto(r, await makeTestImage());
    await runInlinePipeline(r.pd, { photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId });
    expect((await getPhoto(db, p.id))!.status).toBe('BLOCKED');
    const notes = await db('notifications').select('user_id', 'type');
    expect(notes).toEqual(expect.arrayContaining([{ user_id: p.ownerId, type: 'photo.blocked' }, { user_id: adminId, type: 'photo.blocked' }]));
    expect((await listSteps(db, p.id)).map((s) => s.name)).toContain('pipeline.notify');
  });

  it('worker 档：submit 只入队（async），消费者处理后 READY（memory 队列，本进程消费）', async () => {
    const r = await rig({ QUEUE_DRIVER: 'memory', IMAGE_PROCESSOR: 'worker' }, { images: 'worker' });
    const abort = new AbortController();
    void r.deps.queue!.consume({ concurrency: 4, signal: abort.signal });
    const p = await seedPhoto(r, await makeTestImage());
    const ctx = createRequestContext();
    const res = await runWithContext(ctx, () => runInlinePipeline(r.pd, { photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId }));
    expect(res.mode).toBe('async');
    expect(ctx.path.get('image-processing')).toBe('worker:async');
    expect(ctx.path.get('workflow')).toBe('inline:async');
    const photo = await waitFor(async () => {
      const x = await getPhoto(db, p.id);
      return x?.status === 'READY' && x.labels.length ? x : null;
    });
    expect(photo.processedBy).toMatchObject({ driver: 'worker' });
    abort.abort();
    await r.deps.queue!.close?.();
  });

  it('reconcileLocal：衍生图已存在 → 补记 READY；否则重新提交；次数用尽 → FAILED', async () => {
    const r = await rig({ IMAGE_MAX_ATTEMPTS: '2' });
    const old = '2020-01-01T00:00:00.000Z';
    // a：衍生图已存在（处理完成但写回丢失）
    const a = await seedPhoto(r, await makeTestImage());
    await new InlineImageProcessor(r.deps).submit({ photoId: a.id, rawKey: a.rawKey, ownerId: a.ownerId });
    // b：还没有衍生图，可以重试
    const b = await seedPhoto(r, await makeTestImage());
    // c：已经重试过 2 次
    const c = await seedPhoto(r, await makeTestImage());
    await db('photos').whereIn('id', [a.id, b.id, c.id]).update({ processing_started_at: old });
    await db('photos').where({ id: c.id }).update({ processing_attempts: 2 });
    const proc = new InlineImageProcessor(r.deps);
    const res = await reconcileLocal(r.deps, new Date(Date.now() - 1000), (job) => proc.submit(job));
    expect(res).toEqual({ resubmitted: 1, failed: 1 });
    expect((await getPhoto(db, a.id))!.status).toBe('READY');
    expect((await getPhoto(db, b.id))!.status).toBe('READY');
    expect((await getPhoto(db, c.id))!).toMatchObject({ status: 'FAILED' });
  });

  it('tagPhoto 只处理 READY 的照片；tagger 故障不影响照片（非权威）', async () => {
    const failing: TaggerPort = {
      meta: { module: 'tagging', driver: 'rekognition', awsService: 'Amazon Rekognition', authoritative: false },
      probe: async () => ({ status: 'ok', detail: '' }),
      analyze: async () => { throw new Error('throttled'); },
    };
    const r = await rig({}, { tagger: failing });
    const p = await seedPhoto(r, await makeTestImage());
    expect(await tagPhoto(r.pd, { photoId: p.id })).toBeNull();                  // 还是 PROCESSING
    await runInlinePipeline(r.pd, { photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId });
    expect((await getPhoto(db, p.id))!.status).toBe('READY');
    const steps = await listSteps(db, p.id);
    expect(steps.find((s) => s.name === 'pipeline.tag')).toMatchObject({ status: 'failed', error: 'throttled' });
  });
});

describe('拍摄地点的字段加密（photos.location_enc）', () => {
  const fakeCrypto: CryptoPort = {
    meta: { module: 'kms', driver: 'local', awsService: null, authoritative: true },
    keyRef: 'local:v1',
    probe: async () => ({ status: 'ok', detail: '' }),
    encrypt: async (pt, ctx, aad) => ({ v: 1, keyRef: 'local:v1', edk: 'ZWRr', iv: 'aXY', ct: Buffer.from(`${ctx.purpose}|${aad.rowId}|${pt.toString('utf8')}`).toString('base64url'), tag: 'dGFn' }),
    decrypt: async (b: EncryptedBlob, ctx, aad) => {
      const [purpose, rowId, json] = Buffer.from(b.ct, 'base64url').toString('utf8').split('|');
      if (purpose !== ctx.purpose || rowId !== aad.rowId) throw new Error('aad mismatch');
      return Buffer.from(json!, 'utf8');
    },
  };

  it('渲染时读出的 GPS 经 CryptoPort 加密存储；主人查看时解密；rowId 绑定（搬到别的行解不开）', async () => {
    const r = await rig();
    r.deps.crypto = fakeCrypto;
    const p = await seedPhoto(r, await makeTestImage({ exif: { gps: { lat: 35.6895, lon: 139.6917 } } }));
    await new InlineImageProcessor(r.deps).submit({ photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId });
    const photo = (await getPhoto(db, p.id))!;
    expect(photo.locationEnc).toMatch(/^ca1\.local:v1\./);
    const loc = await decryptPhotoLocation({ crypto: fakeCrypto }, photo);
    expect(loc?.lat).toBeCloseTo(35.6895, 3);
    await expect(decryptPhotoLocation({ crypto: fakeCrypto }, { ...photo, id: 'other' })).rejects.toMatchObject({ status: 503 });
  });

  it('CRYPTO_LOCAL_PLAINTEXT=on 时以明文保存（对照实验）；CryptoPort 未实现时不保存', async () => {
    const r = await rig({ CRYPTO_LOCAL_PLAINTEXT: 'on' });
    const p = await seedPhoto(r, await makeTestImage());
    await encryptPhotoLocation(r.deps, p.id, { lat: 1, lon: 2 });
    const photo = (await getPhoto(db, p.id))!;
    expect(photo.locationEnc).toMatch(/^plain\./);
    expect(await decryptPhotoLocation({ crypto: fakeCrypto }, photo)).toEqual({ lat: 1, lon: 2 });
  });

  it('serializeBlob / parseBlob 往返', () => {
    const b: EncryptedBlob = { v: 1, keyRef: 'arn:aws:kms:ap-northeast-1:123456789012:key/abc', edk: 'a', iv: 'b', ct: 'c', tag: 'd' };
    expect(parseBlob(serializeBlob(b))).toEqual(b);
    const dotted = { ...b, keyRef: 'weird.key.ref' };
    expect(parseBlob(serializeBlob(dotted))).toEqual(dotted);
    expect(parseBlob('garbage')).toBeNull();
  });
});
