// backend/src/adapters/image-processing/inline.ts —— ImageProcessorPort 的 `inline` 驱动（本地实现，L0 默认）
//
// “上传完成”请求内用 @cloudalbum/image-core 渲染（进程内信号量 IMAGE_INLINE_CONCURRENCY，每个任务 sharp 线程数 1）：
//   StoragePort.getObject(raw) → render() → putObject(variants/<photoId>/thumb_200.webp、display_1080.webp)。
// - 写回（photos 表）与后续步骤（打标签、审核、通知）由 services/photo-pipeline.ts 统一处理，三种驱动走同一条幂等写回；
// - EXIF 中的 GPS 经 CryptoPort 信封加密后写入 photos.location_enc（只在 EC2 上处理时；衍生图不含任何 EXIF）；
// - 永久错误（格式不支持、像素超限、文件损坏）抛出 ImageProcessingFailedError（带 ImageFailure），调用方直接写 FAILED，不重试；
// - inline 适配器始终装配（X-Compare-Bypass: image 与对账重试都用它，04#image-processing 第 10 节）。
import { hostname } from 'node:os';
import type { Readable } from 'node:stream';
import { isPermanentImageError, render, selfTest, setRenderConcurrency, VARIANT_CACHE_CONTROL, VARIANTS, type VariantName } from '@cloudalbum/image-core';
import type { AdapterDeps } from '../types.js';
import { need } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageFailure, ImageJob, ImageProcessorPort, ImageResult } from '../../ports/image-processor.js';
import { countByStatus } from '../../repositories/photos.js';
import { encryptPhotoLocation, reconcileLocal } from '../../services/photo-pipeline.js';

/** 永久错误：调用方据 failure 写 FAILED，不重试 */
export class ImageProcessingFailedError extends Error {
  readonly permanent = true;
  readonly code = 'IMAGE_PERMANENT_FAILURE';
  constructor(readonly failure: ImageFailure) {
    super(failure.error);
    this.name = 'ImageProcessingFailedError';
  }
}

export function isImageProcessingFailed(e: unknown): e is ImageProcessingFailedError {
  return e instanceof ImageProcessingFailedError || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'IMAGE_PERMANENT_FAILURE');
}

/** 本地处理器（inline / worker）额外提供的“当场处理”入口（worker 档的 image.process 任务调用） */
export interface LocalImageProcessor extends ImageProcessorPort {
  process(job: ImageJob): Promise<ImageResult>;
}

export function asLocalImageProcessor(p: ImageProcessorPort): LocalImageProcessor | null {
  return typeof (p as Partial<LocalImageProcessor>).process === 'function' ? (p as LocalImageProcessor) : null;
}

/** 简单的计数信号量（进程内） */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly size: number) {}
  get waiting(): number {
    return this.waiters.length;
  }
  get running(): number {
    return this.active;
  }
  async acquire(): Promise<() => void> {
    if (this.active < this.size) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();                 // 名额直接转交给下一个等待者
      else this.active--;
    };
  }
}

async function readAll(body: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += b.length;
    if (size > limit) {
      body.destroy();
      throw new ImageProcessingFailedError({ photoId: '', error: `原图超过 ${limit} 字节`, permanent: true, processedBy: { driver: 'inline', durationMs: 0, host: hostname() } });
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** 读原图上限：运行时上限的最大可能值 30 MB（Nginx client_max_body_size）再留余量 */
const RAW_READ_LIMIT = 40 * 1024 * 1024;

function sizesOf(deps: AdapterDeps): VariantName[] {
  const wanted = deps.cfg.image.IMAGE_SIZES.split(',').map((s) => s.trim());
  const sizes = VARIANTS.map((v) => v.name).filter((n) => wanted.includes(n));
  return sizes.length ? sizes : VARIANTS.map((v) => v.name);
}

/**
 * inline 与 worker 共用的“读原图 → 渲染 → 写衍生图”。返回端口的 ImageResult（meta 额外带 camera，供 tagging 使用）；
 * 永久错误抛 ImageProcessingFailedError。
 */
export async function renderAndStore(deps: AdapterDeps, job: ImageJob, driver: 'inline' | 'worker'): Promise<ImageResult> {
  const storage = need(deps, 'storage', 'image-processing');
  const t0 = Date.now();
  const processedBy = () => ({ driver, durationMs: Date.now() - t0, host: hostname() });
  let input: Buffer;
  try {
    const obj = await storage.getObject(job.rawKey);
    input = await readAll(obj.body, RAW_READ_LIMIT);
  } catch (e) {
    if (isImageProcessingFailed(e)) throw new ImageProcessingFailedError({ ...e.failure, photoId: job.photoId, processedBy: processedBy() });
    if ((e as { code?: string }).code === 'NoSuchKey') {
      throw new ImageProcessingFailedError({ photoId: job.photoId, error: `原图不存在：${job.rawKey}`, permanent: true, processedBy: processedBy() });
    }
    throw e;
  }
  let out;
  try {
    out = await render(input, { photoId: job.photoId, maxPixels: deps.cfg.image.IMAGE_MAX_PIXELS, sizes: sizesOf(deps) });
  } catch (e) {
    if (isPermanentImageError(e)) {
      throw new ImageProcessingFailedError({ photoId: job.photoId, error: (e as Error).message, permanent: true, processedBy: processedBy() });
    }
    throw e;
  }
  for (const v of out.variants) {
    await storage.putObject(v.key, v.body, { contentType: v.contentType, cacheControl: VARIANT_CACHE_CONTROL });
  }
  if (out.exif.location) await encryptPhotoLocation(deps, job.photoId, out.exif.location);
  return {
    photoId: job.photoId,
    variants: out.variants.map((v) => ({ name: v.name, key: v.key, width: v.width, height: v.height, bytes: v.bytes })),
    meta: { ...out.meta },
    processedBy: { driver, durationMs: Math.max(Math.round(out.durationMs), Date.now() - t0), host: hostname() },
  };
}

/** inline / worker 共用的探针：sharp 可加载、PROCESSING 超时的照片数、信号量排队 */
export async function localImageProbe(deps: AdapterDeps, base: string, opts: { deep?: boolean; extra?: Record<string, unknown> } = {}): Promise<ProbeResult> {
  const data: Record<string, unknown> = { ...(opts.extra ?? {}) };
  if (opts.deep) {
    try {
      const r = await selfTest();
      data.selfTestMs = r.durationMs;
    } catch (e) {
      return { status: 'error', detail: `sharp 无法加载或渲染失败：${(e as Error).message}`, data };
    }
  }
  if (deps.db) {
    const stuckBefore = new Date(Date.now() - deps.cfg.image.IMAGE_STUCK_AFTER_SEC * 1000);
    const stuck = await countByStatus(deps.db, 'PROCESSING', { startedBefore: stuckBefore });
    data.stuck = stuck;
    if (stuck > 0) return { status: 'degraded', detail: `${base} · ${stuck} 张照片 PROCESSING 超过 ${deps.cfg.image.IMAGE_STUCK_AFTER_SEC} 秒（等待对账）`, data };
  }
  return { status: 'ok', detail: base, data };
}

export class InlineImageProcessor implements ImageProcessorPort, LocalImageProcessor {
  readonly meta: AdapterMeta = { module: 'image-processing', driver: 'inline', awsService: null, authoritative: true };
  readonly placement = 'inline' as const;
  private readonly semaphore: Semaphore;
  private readonly concurrency: number;

  constructor(protected readonly deps: AdapterDeps) {
    this.concurrency = deps.cfg.image.IMAGE_INLINE_CONCURRENCY;
    this.semaphore = new Semaphore(this.concurrency);
  }

  async init(): Promise<void> {
    setRenderConcurrency(1);
  }

  async probe(opts?: { deep?: boolean }): Promise<ProbeResult> {
    return localImageProbe(this.deps, `缩略图在“上传完成”请求内由 sharp 生成（并发 ${this.concurrency}，排队 ${this.semaphore.waiting}）`, {
      ...(opts?.deep ? { deep: true } : {}), extra: { running: this.semaphore.running, waiting: this.semaphore.waiting, concurrency: this.concurrency },
    });
  }

  /** 当场处理（受进程内信号量约束） */
  async process(job: ImageJob): Promise<ImageResult> {
    const release = await this.semaphore.acquire();
    try {
      return await renderAndStore(this.deps, job, 'inline');
    } finally {
      release();
    }
  }

  async submit(job: ImageJob): Promise<{ mode: 'sync'; result: ImageResult } | { mode: 'async'; expectedBy: string }> {
    return { mode: 'sync', result: await this.process(job) };
  }

  /** 对账：衍生图已存在 → 补记 READY；否则次数未用尽 → 在本进程内重新处理；再否则 FAILED */
  async reconcile(stuckBefore: Date): Promise<{ resubmitted: number; failed: number }> {
    return reconcileLocal(this.deps, stuckBefore, (job) => this.submit(job));
  }
}
