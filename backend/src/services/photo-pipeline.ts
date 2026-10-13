// backend/src/services/photo-pipeline.ts —— PhotoPipeline：上传 → 缩略图 → 标签与审核 → 通知（F6–F8，06#workflow 第 1 节）
//
// 1. createUpload（POST /api/photos）：插入 photos(status=UPLOADING, raw_key=raw/<userId>/<photoId>.<ext>)，返回 StoragePort 的 UploadTarget；
// 2. completeUpload（POST /api/photos/:id/complete）：确认原图存在（F14 时先经 DirectUploadPort.complete 合并分片 / 导入），
//    校验大小（运行时配置 maxUploadMb）与文件头魔数，PROCESSING，然后交给 WorkflowPort.start()；
// 3. runInlinePipeline（WORKFLOW_DRIVER=inline 的编排，InlineWorkflow.start 应直接调用它）：
//    thumbnail（ImageProcessorPort.submit；X-Compare-Bypass: image 时改用 inline 适配器）→ 写回 → 入队 image.tag →
//    tag（TaggerPort）→ decide（审核 block 且未设置 log 模式 → BLOCKED）→ notify（仅 BLOCKED：通知主人与管理员）；
//    每一步写一行 job_runs（name = pipeline.<step>，subject_id = photoId）；
// 4. handleImageOutcome：三种驱动（inline / worker / lambda）共用的幂等写回（“状态只前进”，repositories/photos.ts）与后续步骤。
//    lambda 档的回调路由与结果队列轮询器拿到 ImageResult | ImageFailure 后调用它；适配器本身不写回。
// 5. reconcileLocal：inline / worker 档的对账（image.reconcile）：衍生图已存在 → 补记 READY；次数未用尽 → 重新提交；否则 FAILED。
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import type { Knex } from 'knex';
import { extensionFor, isAcceptedType, sniffImageType, VARIANTS, variantKey, type AcceptedType } from '@cloudalbum/image-core';
import type { AdapterDeps } from '../adapters/types.js';
import type { AppConfig } from '../config/schema.js';
import type { Container } from '../container.js';
import { HttpError, isNotImplemented } from '../errors.js';
import { emitNotification } from '../jobs/notify.js';
import { enqueueSafe } from '../jobs/enqueue.js';
import { isBypassed, markPath } from '../observability/request-context.js';
import type { Principal } from '../ports/auth.js';
import type { CachePort } from '../ports/cache.js';
import type { RuntimeConfig } from '../ports/config.js';
import type { CryptoPort, EncryptedBlob } from '../ports/crypto.js';
import type { ImageFailure, ImageJob, ImageMeta, ImageProcessorPort, ImageResult } from '../ports/image-processor.js';
import type { Logger } from '../ports/logger.js';
import type { MetricsPort } from '../ports/metrics.js';
import type { NotifierPort } from '../ports/notifier.js';
import type { QueuePort } from '../ports/queue.js';
import type { SocialStorePort } from '../ports/social-store.js';
import type { StoragePort, UploadTarget } from '../ports/storage.js';
import type { TaggerPort, TagResult } from '../ports/tagger.js';
import type { WorkflowPort } from '../ports/workflow.js';
import { DEFAULT_RUNTIME_CONFIG } from '../ports/config.js';
import { recordStep } from '../repositories/job-runs.js';
import {
  applyImageFailure, applyImageResult, defaultAlbumId, deletePhotoRow, findStuckProcessing, getAlbumRef, getPhoto, insertPhoto,
  markFailed, markProcessing, recoverReady, revertToUploading, saveTagResult, setBlocked, setLocationEnc, setSizeBytes, touchProcessing,
  type ApplyOutcome, type Photo, type Visibility,
} from '../repositories/photos.js';
import { bumpFeedVersions } from './feed.js';

const MB = 1024 * 1024;
/** F6 上传目标在 local 驱动下的有效期（s3 驱动取 STORAGE_S3_PRESIGN_TTL_SEC） */
export const LOCAL_UPLOAD_TTL_SEC = 900;

/** 流水线需要的依赖：Container 与 AdapterDeps（InlineWorkflow、对账）都能映射到它 */
export interface PipelineDeps {
  cfg: AppConfig;
  db: Knex;
  storage: StoragePort;
  images: ImageProcessorPort;
  inlineImages?: ImageProcessorPort;
  queue: QueuePort;
  tagger: TaggerPort;
  notifier?: NotifierPort;
  cache?: CachePort;
  social?: SocialStorePort;
  crypto?: CryptoPort;
  logger?: Logger;
  metrics?: MetricsPort;
  workflow?: WorkflowPort;
  runtimeConfig?: () => RuntimeConfig;
}

export function pipelineDeps(c: Container): PipelineDeps {
  return {
    cfg: c.config, db: c.db, storage: c.storage, images: c.images, inlineImages: c.inlineImages, queue: c.queue, tagger: c.tagger,
    notifier: c.notifier, cache: c.cache, social: c.social, crypto: c.crypto, logger: c.logger, metrics: c.metrics, workflow: c.workflow,
    runtimeConfig: () => c.runtimeConfig(),
  };
}

export function pipelineDepsFromAdapter(d: AdapterDeps): PipelineDeps {
  const missing = (['db', 'storage', 'images', 'queue', 'tagger'] as const).filter((k) => !d[k]);
  if (missing.length) throw new Error(`PhotoPipeline: 缺少依赖 ${missing.join(', ')}（container 装配顺序错误）`);
  return {
    cfg: d.cfg, db: d.db!, storage: d.storage!, images: d.images!, queue: d.queue!, tagger: d.tagger!,
    ...(d.notifier ? { notifier: d.notifier } : {}), ...(d.cache ? { cache: d.cache } : {}), ...(d.crypto ? { crypto: d.crypto } : {}), ...(d.logger ? { logger: d.logger } : {}),
    ...(d.metrics ? { metrics: d.metrics } : {}),
    runtimeConfig: () => {
      try {
        return d.runtime?.current() ?? DEFAULT_RUNTIME_CONFIG;
      } catch {
        return DEFAULT_RUNTIME_CONFIG;
      }
    },
  };
}

function count(pd: PipelineDeps, name: string, dims?: Record<string, string>): void {
  try {
    pd.metrics?.counter(name, 1, dims);
  } catch {
    /* 指标不是必需的 */
  }
}

async function safely(pd: PipelineDeps, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!isNotImplemented(e)) pd.logger?.warn(`pipeline.${what}_failed`, { error: (e as Error)?.message ?? String(e) });
  }
}

async function afterStatusChange(pd: PipelineDeps, photo: Pick<Photo, 'id' | 'ownerId' | 'albumId' | 'visibility'>, status: string): Promise<void> {
  await safely(pd, 'cache_invalidate', () => bumpFeedVersions(pd.cache, photo));
  if (pd.social) {
    const social = pd.social;
    await safely(pd, 'photo_summary', () => social.upsertPhotoSummary({ photoId: photo.id, ownerId: photo.ownerId, visibility: photo.visibility, status }));
  }
}

export interface Who { userId: string; isAdmin: boolean; principal?: Principal }

// ---------------------------------------------------------------------------------------------
// F6：建档 + 上传目标
// ---------------------------------------------------------------------------------------------
export interface CreateUploadInput {
  contentType: string; filename?: string; size?: number; albumId?: string | null; visibility?: Visibility; title?: string | null; caption?: string | null;
}

export async function createUpload(c: Container, who: Who, input: CreateUploadInput): Promise<{ photo: Photo; uploadTarget: UploadTarget; maxBytes: number }> {
  const ct = String(input.contentType ?? '').toLowerCase();
  if (!isAcceptedType(ct)) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '只接受 image/jpeg、image/png、image/webp');
  const maxBytes = Math.floor(c.runtimeConfig().maxUploadMb * MB);
  if (input.size !== undefined && (!Number.isFinite(input.size) || input.size <= 0)) throw new HttpError(400, 'INVALID_SIZE', 'size 必须是正数');
  if (input.size !== undefined && input.size > maxBytes) {
    throw new HttpError(413, 'UPLOAD_TOO_LARGE', `文件超过上限 ${c.runtimeConfig().maxUploadMb} MB`, { maxBytes });
  }
  let albumId: string | null = null;
  let albumVisibility: Visibility | undefined;
  if (input.albumId) {
    const album = await getAlbumRef(c.db, input.albumId);
    if (!album || (album.ownerId !== who.userId && !who.isAdmin)) throw new HttpError(404, 'ALBUM_NOT_FOUND', '相册不存在');
    albumId = album.id;
    albumVisibility = album.visibility;
  } else {
    albumId = await defaultAlbumId(c.db, who.userId);
    if (albumId) albumVisibility = (await getAlbumRef(c.db, albumId))?.visibility;
  }
  const id = randomUUID();
  const rawKey = `raw/${who.userId}/${id}.${extensionFor(ct as AcceptedType)}`;
  const photo = await insertPhoto(c.db, {
    id, ownerId: who.userId, albumId, rawKey, filename: input.filename ?? `${id}.${extensionFor(ct as AcceptedType)}`, contentType: ct,
    sizeBytes: input.size ?? null, visibility: input.visibility ?? albumVisibility ?? 'private',
    title: input.title ?? null, caption: input.caption ?? null,
  });
  let uploadTarget: UploadTarget;
  try {
    const s = c.config.storage;
    const ttl = s.STORAGE_DRIVER === 's3' ? s.STORAGE_S3_PRESIGN_TTL_SEC : LOCAL_UPLOAD_TTL_SEC;
    uploadTarget = await c.storage.createUploadTarget({ key: rawKey, contentType: ct, maxBytes, expiresInSec: ttl, metadata: { photoid: id, ownerid: who.userId } });
  } catch (e) {
    await deletePhotoRow(c.db, id).catch(() => undefined);
    throw e;
  }
  await bumpFeedVersions(c.cache, photo).catch(() => undefined);
  return { photo, uploadTarget, maxBytes };
}

// ---------------------------------------------------------------------------------------------
// complete：校验 → PROCESSING → 编排
// ---------------------------------------------------------------------------------------------
async function readHead(storage: StoragePort, key: string, n = 32): Promise<Buffer> {
  const { body } = await storage.getObject(key);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body as Readable) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(b);
      size += b.length;
      if (size >= n) break;
    }
  } finally {
    (body as Readable).destroy();
  }
  return Buffer.concat(chunks).subarray(0, n);
}

export interface CompleteResult { photo: Photo; mode: 'sync' | 'async'; executionId?: string; already?: boolean }

export async function completeUpload(c: Container, who: Who, photoId: string): Promise<CompleteResult> {
  const photo = await getPhoto(c.db, photoId);
  if (!photo || (photo.ownerId !== who.userId && !who.isAdmin)) throw new HttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
  if (photo.status === 'READY' || photo.status === 'BLOCKED') return { photo, mode: 'sync', already: true };
  if (photo.status === 'PROCESSING' && photo.processingStartedAt) {
    const stuckAt = Date.parse(photo.processingStartedAt) + c.config.image.IMAGE_STUCK_AFTER_SEC * 1000;
    if (Date.now() < stuckAt) return { photo, mode: 'async', already: true };
  }

  // 1) 原图是否已经在原图键上（F6）；不在则交给 DirectUploadPort（F14：合并分片 / 从暂存桶导入）
  let rawKey = photo.rawKey;
  let info = await c.storage.headObject(rawKey);
  if (!info) {
    let reason = '原图尚未上传';
    try {
      const r = await c.directUpload.complete(photoId, who.principal ?? principalOf(who));
      if (r.ok && r.rawKey) rawKey = r.rawKey;
      if (!r.ok && r.reason) reason = r.reason;
    } catch (e) {
      if (!isNotImplemented(e)) throw e;
    }
    info = await c.storage.headObject(rawKey);
    if (!info) throw new HttpError(409, 'UPLOAD_NOT_FOUND', reason);
  }

  // 2) 大小（运行时配置 maxUploadMb 是唯一来源）与文件头魔数；不合格就删除原图并标记 FAILED
  const maxBytes = Math.floor(c.runtimeConfig().maxUploadMb * MB);
  const reject = async (status: number, code: string, message: string): Promise<never> => {
    await c.storage.deleteObjects([rawKey]).catch(() => undefined);
    await markFailed(c.db, photoId, message);
    await bumpFeedVersions(c.cache, photo).catch(() => undefined);
    throw new HttpError(status, code, message);
  };
  if (info.size > maxBytes) await reject(413, 'UPLOAD_TOO_LARGE', `原图 ${info.size} 字节超过上限 ${c.runtimeConfig().maxUploadMb} MB`);
  if (info.size === 0) await reject(400, 'UPLOAD_EMPTY', '原图为空');
  const sniffed = sniffImageType(await readHead(c.storage, rawKey));
  if (!sniffed) await reject(415, 'UNSUPPORTED_MEDIA_TYPE', '文件头不是 JPEG / PNG / WebP（按魔数识别，不只看扩展名）');
  if (sniffed !== photo.contentType) await reject(415, 'CONTENT_TYPE_MISMATCH', `声明的类型 ${photo.contentType} 与文件头 ${sniffed} 不一致`);
  await setSizeBytes(c.db, photoId, info.size, rawKey !== photo.rawKey ? rawKey : undefined);

  // 3) PROCESSING → 编排
  if (!(await markProcessing(c.db, photoId))) {
    return { photo: (await getPhoto(c.db, photoId))!, mode: 'sync', already: true };
  }
  const started = await startPipeline(c, { photoId, rawKey, ownerId: photo.ownerId });
  return { photo: (await getPhoto(c.db, photoId))!, mode: started.mode, executionId: started.executionId };
}

function principalOf(who: Who): Principal {
  return { provider: 'local', subject: who.userId, email: '', emailVerified: true, groups: who.isAdmin ? ['admin'] : ['member'], plan: 'free', expiresAt: 0 };
}

let workflowStubWarned = false;

/** 交给 WorkflowPort；inline 驱动尚未实现（脚手架桩）时直接运行进程内编排 */
export async function startPipeline(c: Container, photo: ImageJob): Promise<{ executionId: string; mode: 'sync' | 'async' }> {
  try {
    return await c.workflow.start(photo);
  } catch (e) {
    if (!isNotImplemented(e) || c.config.workflow.WORKFLOW_DRIVER !== 'inline') throw e;
    if (!workflowStubWarned) {
      workflowStubWarned = true;
      c.logger.warn('pipeline.workflow_stub', { detail: 'InlineWorkflow.start 尚未实现，PhotoPipeline 直接在进程内编排' });
    }
    return runInlinePipeline(pipelineDeps(c), photo);
  }
}

/**
 * WORKFLOW_DRIVER=inline 的进程内编排（InlineWorkflow.start 调用）。
 * IMAGE_PROCESSOR=inline 时整条流水线在本请求内完成（workflow=inline:sync），worker / lambda 档后续步骤异步完成（inline:async）。
 */
export async function runInlinePipeline(pd: PipelineDeps, photo: ImageJob): Promise<{ executionId: string; mode: 'sync' | 'async' }> {
  const forceInline = isBypassed('image');
  const proc = forceInline ? (pd.inlineImages ?? pd.images) : pd.images;
  const wf = pd.cfg.workflow;
  const maxAttempts = wf.WORKFLOW_DRIVER === 'inline' ? wf.WORKFLOW_LOCAL_MAX_ATTEMPTS : 3;
  const backoffMs = wf.WORKFLOW_DRIVER === 'inline' ? wf.WORKFLOW_LOCAL_BACKOFF_MS : 2000;
  const executionId = `inline:${photo.photoId}:${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();

  for (let attempt = 1; ; attempt++) {
    try {
      const r = await proc.submit(photo);
      markPath('image-processing', forceInline ? 'inline:bypass' : `${proc.placement}:${r.mode}`);
      if (r.mode === 'sync') {
        await handleImageOutcome(pd, r.result, { attempt });
        markPath('workflow', 'inline:sync');
        return { executionId, mode: 'sync' };
      }
      markPath('workflow', 'inline:async');
      return { executionId, mode: 'async' };
    } catch (e) {
      const failure = permanentFailureOf(e);
      if (failure) {
        markPath('image-processing', forceInline ? 'inline:bypass' : `${proc.placement}:sync`);
        await handleImageOutcome(pd, { ...failure, photoId: photo.photoId }, { attempt });
        markPath('workflow', 'inline:sync');
        return { executionId, mode: 'sync' };
      }
      if (e instanceof HttpError) {
        // 端口明确拒绝受理（例如 lambda 档 error → 503）：照片退回 UPLOADING，不重试、不偷偷改用 inline
        await revertToUploading(pd.db, photo.photoId);
        throw e;
      }
      if (attempt < maxAttempts && !isNotImplemented(e)) {
        pd.logger?.warn('pipeline.thumbnail_retry', { photoId: photo.photoId, attempt, error: (e as Error)?.message });
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }
      const message = (e as Error)?.message ?? String(e);
      await recordStep(pd.db, {
        step: 'thumbnail', photoId: photo.photoId, executor: proc.placement, attempt, status: 'failed', startedAt, error: message,
      }).catch(() => undefined);
      if (isNotImplemented(e)) throw e;
      const p = await getPhoto(pd.db, photo.photoId);
      await markFailed(pd.db, photo.photoId, `缩略图处理失败（重试 ${attempt} 次）：${message}`);
      if (p) await afterStatusChange(pd, p, 'FAILED');
      throw new HttpError(503, 'IMAGE_PROCESSING_UNAVAILABLE', `缩略图处理失败：${message}`);
    }
  }
}

function permanentFailureOf(e: unknown): ImageFailure | null {
  const x = e as { permanent?: unknown; failure?: ImageFailure };
  if (x && typeof x === 'object' && x.permanent === true && x.failure) return x.failure;
  return null;
}

export function isImageFailure(o: ImageResult | ImageFailure): o is ImageFailure {
  return (o as ImageFailure).permanent === true;
}

/**
 * 三种驱动共用的写回与后续步骤（幂等）：
 *   ImageResult → READY（只覆盖 UPLOADING / PROCESSING / FAILED）→ 入队 image.tag；
 *   ImageFailure → FAILED（只覆盖 UPLOADING / PROCESSING），删除无法解码的原图。
 */
export async function handleImageOutcome(pd: PipelineDeps, outcome: ImageResult | ImageFailure, opts: { attempt?: number } = {}): Promise<ApplyOutcome> {
  const startedAt = new Date(Date.now() - Math.max(0, outcome.processedBy?.durationMs ?? 0)).toISOString();
  if (isImageFailure(outcome)) {
    const applied = await applyImageFailure(pd.db, outcome);
    count(pd, 'biz.image_result', { outcome: applied === 'applied' ? 'failed' : applied });
    await recordStep(pd.db, {
      step: 'thumbnail', photoId: outcome.photoId, executor: outcome.processedBy?.driver ?? 'unknown', attempt: opts.attempt ?? 1,
      status: 'failed', startedAt, error: outcome.error, detail: { permanent: true, applied },
    }).catch(() => undefined);
    if (applied === 'applied') {
      const p = await getPhoto(pd.db, outcome.photoId);
      if (p) {
        await safely(pd, 'delete_raw', () => pd.storage.deleteObjects([p.rawKey]));
        await afterStatusChange(pd, p, 'FAILED');
      }
    }
    return applied;
  }
  const applied = await applyImageResult(pd.db, outcome);
  count(pd, 'biz.image_result', { outcome: applied === 'applied' ? 'ready' : applied });
  await recordStep(pd.db, {
    step: 'thumbnail', photoId: outcome.photoId, executor: outcome.processedBy.driver, attempt: opts.attempt ?? 1, status: 'ok', startedAt,
    detail: { applied, durationMs: outcome.processedBy.durationMs, host: outcome.processedBy.host, ...(outcome.processedBy.coldStart ? { coldStart: true } : {}), variants: outcome.variants.length },
  }).catch(() => undefined);
  if (applied !== 'applied') return applied;
  const p = await getPhoto(pd.db, outcome.photoId);
  if (p) await afterStatusChange(pd, p, 'READY');
  await enqueueSafe(pd, 'image.tag', { photoId: outcome.photoId, meta: outcome.meta } satisfies ImageTagPayload, { dedupKey: `image.tag:${outcome.photoId}` });
  return applied;
}

// ---------------------------------------------------------------------------------------------
// tag → decide → notify
// ---------------------------------------------------------------------------------------------
export interface ImageTagPayload { photoId: string; meta?: ImageMeta }

export function metaFromPhoto(p: Photo): ImageMeta {
  const fmt = p.contentType.split('/')[1] ?? '';
  return {
    width: p.width ?? 0, height: p.height ?? 0, format: fmt === 'jpg' ? 'jpeg' : fmt, dominantColor: p.dominantColor ?? '',
    ...(p.takenAt ? { takenAt: p.takenAt } : {}),
  };
}

async function readObject(storage: StoragePort, key: string): Promise<Buffer> {
  const { body } = await storage.getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** image.tag 任务：分析、落库、审核决定。tagging 是非权威端口：失败只记录，照片保持 READY */
export async function tagPhoto(pd: PipelineDeps, payload: ImageTagPayload): Promise<TagResult | null> {
  const photo = await getPhoto(pd.db, payload.photoId);
  if (!photo || photo.status !== 'READY') return null;
  const startedAt = new Date().toISOString();
  const executor = pd.tagger.meta.driver;
  let result: TagResult;
  try {
    result = await pd.tagger.analyze({
      photoId: photo.id, storageKey: photo.rawKey, meta: payload.meta ?? metaFromPhoto(photo),
      bytes: () => readObject(pd.storage, photo.displayKey ?? photo.rawKey),
    });
  } catch (e) {
    await recordStep(pd.db, { step: 'tag', photoId: photo.id, executor, status: 'failed', startedAt, error: (e as Error)?.message ?? String(e) }).catch(() => undefined);
    if (!isNotImplemented(e)) pd.logger?.warn('pipeline.tag_failed', { photoId: photo.id, error: (e as Error)?.message });
    return null;
  }
  await saveTagResult(pd.db, photo.id, result);
  await recordStep(pd.db, {
    step: 'tag', photoId: photo.id, executor, status: 'ok', startedAt,
    detail: { driver: result.analyzedBy.driver, input: result.analyzedBy.input, labels: result.labels.length, verdict: result.moderation.verdict },
  }).catch(() => undefined);

  // decide：block 且不是 log 模式 → BLOCKED，通知主人与管理员
  const tcfg = pd.cfg.tagger as Record<string, unknown>;
  const action = typeof tcfg.TAGGER_MODERATION_ACTION === 'string' && tcfg.TAGGER_MODERATION_ACTION ? tcfg.TAGGER_MODERATION_ACTION : 'enforce';
  const decision = result.moderation.verdict === 'block' && action !== 'log' ? 'BLOCKED' : 'READY';
  await recordStep(pd.db, { step: 'decide', photoId: photo.id, executor: 'inline', status: 'ok', startedAt: new Date().toISOString(), detail: { verdict: result.moderation.verdict, action, decision } }).catch(() => undefined);
  if (decision === 'BLOCKED' && (await setBlocked(pd.db, photo.id, true))) {
    await afterStatusChange(pd, photo, 'BLOCKED');
    const evtBase = { origin: 'ec2' as const, type: 'photo.blocked' as const, link: `/photos/${photo.id}`, data: { photoId: photo.id } };
    const t0 = new Date().toISOString();
    await emitNotification(pd, { ...evtBase, eventId: `photo.blocked:${photo.id}`, audience: 'user', recipientUserId: photo.ownerId, title: '照片已被自动审核拦截', body: `你的照片「${photo.title ?? photo.filename}」被内容审核拦截，仅你自己可见。` });
    await emitNotification(pd, { ...evtBase, eventId: `photo.blocked.admin:${photo.id}`, audience: 'admin', recipientUserId: '', title: '有照片被自动审核拦截', body: `照片 ${photo.id} 被拦截，请到 /admin/reviews 复核。` });
    await recordStep(pd.db, { step: 'notify', photoId: photo.id, executor: 'inline', status: 'ok', startedAt: t0, detail: { event: 'photo.blocked' } }).catch(() => undefined);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// 对账（inline / worker 档；lambda 档由其适配器实现）
// ---------------------------------------------------------------------------------------------
export async function reconcileLocal(
  deps: AdapterDeps, stuckBefore: Date,
  submit: (job: ImageJob) => Promise<{ mode: 'sync'; result: ImageResult } | { mode: 'async'; expectedBy: string }>,
): Promise<{ resubmitted: number; failed: number }> {
  const pd = pipelineDepsFromAdapter(deps);
  const maxAttempts = deps.cfg.image.IMAGE_MAX_ATTEMPTS;
  const sizes = deps.cfg.image.IMAGE_SIZES.split(',').map((s) => s.trim());
  const wanted = VARIANTS.filter((v) => sizes.includes(v.name));
  let resubmitted = 0;
  let failed = 0;
  let recovered = 0;
  for (const p of await findStuckProcessing(pd.db, stuckBefore, 50)) {
    const keys = (wanted.length ? wanted : VARIANTS).map((v) => variantKey(p.id, v.name));
    const exists = await Promise.all(keys.map((k) => pd.storage.headObject(k)));
    if (exists.every(Boolean)) {
      if (await recoverReady(pd.db, p.id, { thumbKey: variantKey(p.id, 'thumb_200'), displayKey: variantKey(p.id, 'display_1080') })) {
        recovered++;
        await afterStatusChange(pd, p, 'READY');
        await enqueueSafe(pd, 'image.tag', { photoId: p.id } satisfies ImageTagPayload, { dedupKey: `image.tag:${p.id}:recovered` });
      }
      continue;
    }
    if (p.processingAttempts < maxAttempts) {
      await touchProcessing(pd.db, p.id);
      resubmitted++;
      try {
        const r = await submit({ photoId: p.id, rawKey: p.rawKey, ownerId: p.ownerId });
        if (r.mode === 'sync') await handleImageOutcome(pd, r.result, { attempt: p.processingAttempts + 1 });
      } catch (e) {
        const failure = permanentFailureOf(e);
        if (failure) await handleImageOutcome(pd, { ...failure, photoId: p.id }, { attempt: p.processingAttempts + 1 });
        else pd.logger?.warn('pipeline.reconcile_resubmit_failed', { photoId: p.id, error: (e as Error)?.message });
      }
      continue;
    }
    if ((await markFailed(pd.db, p.id, `处理超时：已尝试 ${p.processingAttempts} 次仍未完成`)) === 'applied') {
      failed++;
      await afterStatusChange(pd, p, 'FAILED');
    }
  }
  if (recovered) {
    try {
      pd.metrics?.counter('biz.image_reconcile_recovered', recovered);
    } catch {
      /* ignore */
    }
  }
  return { resubmitted, failed };
}

// ---------------------------------------------------------------------------------------------
// EXIF GPS 的字段加密（kms 模块：photos.location，02#kms 第 1 节）
// ---------------------------------------------------------------------------------------------
const LOCATION_CONTEXT = { app: 'cloudalbum', purpose: 'photos.location' } as const;

/** EncryptedBlob 的序列化：ca1.<keyRef>.<edk>.<iv>.<ct>.<tag>（keyRef 含 “.” 时改为 base64url，并以 “~” 开头） */
export function serializeBlob(b: EncryptedBlob): string {
  const keyRef = /^[A-Za-z0-9:/_-]+$/.test(b.keyRef) ? b.keyRef : `~${Buffer.from(b.keyRef).toString('base64url')}`;
  return ['ca1', keyRef, b.edk, b.iv, b.ct, b.tag].join('.');
}

export function parseBlob(s: string): EncryptedBlob | null {
  const parts = s.split('.');
  if (parts.length !== 6 || parts[0] !== 'ca1') return null;
  const [, keyRefRaw, edk, iv, ct, tag] = parts as [string, string, string, string, string, string];
  const keyRef = keyRefRaw.startsWith('~') ? Buffer.from(keyRefRaw.slice(1), 'base64url').toString('utf8') : keyRefRaw;
  return { v: 1, keyRef, edk, iv, ct, tag };
}

/** 渲染时读出的 GPS → 信封加密后写入 photos.location_enc（CryptoPort 未实现或失败时不保存位置，不影响缩略图） */
export async function encryptPhotoLocation(deps: Pick<AdapterDeps, 'cfg' | 'crypto' | 'db' | 'logger'>, photoId: string, loc: { lat: number; lon: number }): Promise<void> {
  if (!deps.db) return;
  try {
    if (deps.cfg.kms.CRYPTO_LOCAL_PLAINTEXT === 'on') {
      await setLocationEnc(deps.db, photoId, `plain.${Buffer.from(JSON.stringify(loc)).toString('base64url')}`);
      return;
    }
    if (!deps.crypto) return;
    const blob = await deps.crypto.encrypt(Buffer.from(JSON.stringify(loc)), LOCATION_CONTEXT, { rowId: photoId });
    await setLocationEnc(deps.db, photoId, serializeBlob(blob));
  } catch (e) {
    if (!isNotImplemented(e)) deps.logger?.warn('pipeline.location_encrypt_failed', { photoId, error: (e as Error)?.message });
  }
}

/** 照片详情（仅主人与管理员）：解密拍摄地点。CryptoPort 未实现 → null；解密失败 → 503 CRYPTO_UNAVAILABLE（kms 是权威端口） */
export async function decryptPhotoLocation(c: Pick<Container, 'crypto'>, photo: Pick<Photo, 'id' | 'locationEnc'>): Promise<{ lat: number; lon: number } | null> {
  const enc = photo.locationEnc;
  if (!enc) return null;
  if (enc.startsWith('plain.')) return JSON.parse(Buffer.from(enc.slice(6), 'base64url').toString('utf8')) as { lat: number; lon: number };
  const blob = parseBlob(enc);
  if (!blob) return null;
  try {
    const plain = await c.crypto.decrypt(blob, LOCATION_CONTEXT, { rowId: photo.id });
    return JSON.parse(plain.toString('utf8')) as { lat: number; lon: number };
  } catch (e) {
    if (isNotImplemented(e)) return null;
    throw new HttpError(503, 'CRYPTO_UNAVAILABLE', `拍摄地点无法解密：${(e as Error)?.message ?? String(e)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------------------------
export async function deletePhoto(c: Container, who: Who, photoId: string): Promise<void> {
  const photo = await getPhoto(c.db, photoId);
  if (!photo || (photo.ownerId !== who.userId && !who.isAdmin)) throw new HttpError(404, 'PHOTO_NOT_FOUND', '照片不存在');
  const keys = [photo.rawKey, photo.thumbKey, photo.displayKey].filter((k): k is string => Boolean(k));
  await c.storage.deleteObjects(keys);
  await c.social.purgePhoto(photoId);
  await deletePhotoRow(c.db, photoId);
  await bumpFeedVersions(c.cache, photo).catch(() => undefined);
  if (c.cdn.baseUrl) {
    try {
      await c.cdn.invalidate([`/media/variants/${photoId}/*`]);
    } catch (e) {
      if (!isNotImplemented(e)) c.logger.warn('cdn.invalidate_failed', { photoId, error: (e as Error).message });
    }
  }
}
