// backend/src/adapters/image-processing/lambda.ts —— ImageProcessorPort 的 `lambda` 驱动（AWS Lambda；04#image-processing 第 2 节）
//
// 时序：浏览器预签名 PUT 原图 → S3 Object Created → EventBridge 规则 → Lambda（lambdas/image-thumbnail）→ 媒体桶 variants/
//       → 回写：IMAGE_RESULT_CHANNEL=callback 时 HMAC 签名 POST /internal/hooks/image-processed（acceptCallback）；
//               queue 时发到模块自带的结果队列，由 worker 的 consumeResults() 取出（acceptResult）。
// - submit()：真正触发 Lambda 的是 S3 事件，这里只登记“等待结果”（expectedBy = now + IMAGE_STUCK_AFTER_SEC），不调用 AWS。
// - acceptCallback / acceptResult：校验（时间戳 ±300 秒 + HMAC；线上格式用 zod）后返回 ImageResult | ImageFailure；
//   “状态只前进”的写回由调用方（internal-hooks 路由 / worker）执行——consumeResults() 默认用 PhotoStateStore 写回。
// - reconcile()：PROCESSING 超时的照片：媒体桶里衍生图已存在 → 用对象元数据补记 READY（回调丢了也能恢复，计数
//   biz.image_reconcile_recovered）；否则在次数内用 lambda:InvokeFunction（InvocationType=Event，载荷与 EventBridge 事件同构）重投；
//   超过 IMAGE_MAX_ATTEMPTS 标为 FAILED。
// - consumeResults()：worker 长轮询结果队列（queue 通道）与失败队列（Lambda 异步调用失败目标 / 规则 DLQ / 缓冲队列 redrive），
//   失败队列中的照片标为 FAILED。
// - 权威端口：函数不存在 / 规则被禁用时探针为 error，complete 返回 503，不偷偷改用 inline。
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { z } from 'zod';
import { jsonOut, nowIso, countOf } from '../../db/dialect.js';
import { HttpError } from '../../errors.js';
import { markPath } from '../../observability/request-context.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { ImageFailure, ImageJob, ImageProcessorPort, ImageResult } from '../../ports/image-processor.js';
import { describeAwsError, isAwsAccessDenied, isAwsNotFound, loadAwsPackage } from '../aws/clients.js';
import type { AdapterDeps } from '../types.js';

type LambdaConfig = Extract<AdapterDeps['cfg']['image'], { IMAGE_PROCESSOR: 'lambda' }>;

export const CALLBACK_TOLERANCE_SEC = 300;
export const HEADER_TIMESTAMP = 'x-cloudalbum-timestamp';
export const HEADER_SIGNATURE = 'x-cloudalbum-signature';

// ---------------------------------------------------------------------------------------------
// 线上格式（与 lambdas/image-thumbnail/src/wire.ts 一致；两边各保留一份，这里用 zod 校验）
// ---------------------------------------------------------------------------------------------
const processedBySchema = z.object({
  driver: z.literal('lambda'), durationMs: z.number().nonnegative(), coldStart: z.boolean().optional(), host: z.string().min(1),
});
const wireResultSchema = z.object({
  v: z.literal(1), kind: z.literal('result'), photoId: z.string().min(1), rawKey: z.string(),
  variants: z.array(z.object({
    name: z.enum(['thumb_200', 'display_1080']), key: z.string().min(1),
    width: z.number().int().nonnegative(), height: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(),
  })).min(1),
  meta: z.object({
    width: z.number().int().nonnegative(), height: z.number().int().nonnegative(), format: z.string(), dominantColor: z.string(),
    takenAt: z.string().optional(),
  }),
  processedBy: processedBySchema,
  requestId: z.string().optional(),
  finishedAt: z.string(),
});
const wireFailureSchema = z.object({
  v: z.literal(1), kind: z.literal('failure'), photoId: z.string().min(1), rawKey: z.string(), error: z.string(),
  permanent: z.literal(true), processedBy: processedBySchema, requestId: z.string().optional(), finishedAt: z.string(),
});
const wireSchema = z.discriminatedUnion('kind', [wireResultSchema, wireFailureSchema]);
export type WireMessage = z.infer<typeof wireSchema>;

export function signCallback(key: string, timestamp: string, rawBody: Buffer | string): string {
  return `v1=${createHmac('sha256', key).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseRawKey(key: string): { userId: string; photoId: string; ext: string } | null {
  const m = /^raw\/([^/]+)\/([^/]+)\.([A-Za-z0-9]+)$/.exec(key);
  return m ? { userId: m[1]!, photoId: m[2]!, ext: m[3]!.toLowerCase() } : null;
}

function toPort(w: WireMessage): ImageResult | ImageFailure {
  const processedBy: ImageResult['processedBy'] = {
    driver: 'lambda', durationMs: w.processedBy.durationMs, host: w.processedBy.host,
    ...(w.processedBy.coldStart !== undefined ? { coldStart: w.processedBy.coldStart } : {}),
  };
  if (w.kind === 'failure') return { photoId: w.photoId, error: w.error, permanent: true, processedBy };
  return {
    photoId: w.photoId,
    variants: w.variants.map((v) => ({ ...v })),
    meta: { width: w.meta.width, height: w.meta.height, format: w.meta.format, dominantColor: w.meta.dominantColor, ...(w.meta.takenAt ? { takenAt: w.meta.takenAt } : {}) },
    processedBy,
  };
}

export function isImageFailure(r: ImageResult | ImageFailure): r is ImageFailure {
  return (r as ImageFailure).permanent === true;
}

/**
 * 失败队列的三种消息格式（04#image-processing：FailureQueue）：
 *   ① Lambda 异步调用的失败记录 { requestContext, requestPayload: <EventBridge 事件>, responsePayload: { errorMessage } }；
 *   ② 规则目标投递失败（规则 DLQ）：消息体就是 EventBridge 事件，消息属性带 ERROR_CODE / ERROR_MESSAGE；
 *   ③ 缓冲队列 redrive：消息体同样是 EventBridge 事件（重试次数耗尽）。
 */
export function parseFailureQueueMessage(body: string, attributes: Record<string, { StringValue?: string }> = {}): ImageFailure | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  let event = v;
  let error: string;
  if (v.requestPayload && typeof v.requestPayload === 'object') {
    event = v.requestPayload as Record<string, unknown>;
    const resp = (v.responsePayload ?? {}) as { errorMessage?: string; errorType?: string };
    const condition = (v.requestContext as { condition?: string } | undefined)?.condition;
    error = `Lambda 异步调用失败（${condition ?? 'RetriesExhausted'}）：${resp.errorType ? `${resp.errorType}: ` : ''}${resp.errorMessage ?? '未知错误'}`;
  } else if (attributes.ERROR_CODE?.StringValue || attributes.ERROR_MESSAGE?.StringValue) {
    error = `EventBridge 投递给目标失败（${attributes.ERROR_CODE?.StringValue ?? '?'}）：${attributes.ERROR_MESSAGE?.StringValue ?? ''}`;
  } else {
    error = '重试次数耗尽（缓冲队列 redrive / 规则 DLQ）';
  }
  const key = (event.detail as { object?: { key?: string } } | undefined)?.object?.key;
  const parsed = key ? parseRawKey(key.includes('%') ? decodeURIComponent(key.replace(/\+/g, ' ')) : key) : null;
  if (!parsed) return null;
  return { photoId: parsed.photoId, error, permanent: true, processedBy: { driver: 'lambda', durationMs: 0, host: 'failure-queue' } };
}

// ---------------------------------------------------------------------------------------------
// 照片状态的读写（对账与结果队列的写回）。仓储层统一后可换成 repositories/photos.ts 的同名函数（见 implementation-notes）。
// ---------------------------------------------------------------------------------------------
export type WritebackOutcome = 'applied' | 'ignored-duplicate' | 'ignored-stale';
export interface StuckPhoto { id: string; rawKey: string; ownerId: string; attempts: number }

export interface PhotoStateStore {
  listStuck(before: Date, limit: number): Promise<StuckPhoto[]>;
  countStuck(before: Date): Promise<number>;
  /** READY 可覆盖 UPLOADING / PROCESSING / FAILED；永不覆盖 READY 与 BLOCKED */
  applyResult(r: ImageResult): Promise<WritebackOutcome>;
  /** 只把 UPLOADING / PROCESSING 改为 FAILED（写入原因），不覆盖 READY / BLOCKED */
  applyFailure(f: ImageFailure): Promise<WritebackOutcome>;
  /** 重投：processing_attempts + 1，并重新开始计时 */
  bumpAttempt(photoId: string): Promise<void>;
}

export function knexPhotoStateStore(db: Knex): PhotoStateStore {
  const statusOf = async (id: string): Promise<string | undefined> =>
    ((await db('photos').where({ id }).first('status')) as { status?: string } | undefined)?.status;
  return {
    async listStuck(before, limit) {
      const rows = (await db('photos')
        .where('status', 'PROCESSING')
        .where('processing_started_at', '<', before.toISOString())
        .orderBy('processing_started_at', 'asc')
        .limit(limit)
        .select('id', 'raw_key', 'owner_id', 'processing_attempts')) as Array<{ id: string; raw_key: string; owner_id: string; processing_attempts: number | string }>;
      return rows.map((r) => ({ id: r.id, rawKey: r.raw_key, ownerId: r.owner_id, attempts: Number(r.processing_attempts ?? 0) }));
    },
    async countStuck(before) {
      return countOf(await db('photos').where('status', 'PROCESSING').where('processing_started_at', '<', before.toISOString()).count({ count: '*' }).first());
    },
    async applyResult(r) {
      const thumb = r.variants.find((v) => v.name === 'thumb_200');
      const display = r.variants.find((v) => v.name === 'display_1080');
      const now = nowIso();
      const n = await db('photos').where({ id: r.photoId }).whereIn('status', ['UPLOADING', 'PROCESSING', 'FAILED']).update({
        status: 'READY',
        ...(thumb ? { thumb_key: thumb.key } : {}),
        ...(display ? { display_key: display.key } : {}),
        width: r.meta.width, height: r.meta.height,
        ...(r.meta.dominantColor ? { dominant_color: r.meta.dominantColor.slice(0, 16) } : {}),
        ...(r.meta.takenAt ? { taken_at: r.meta.takenAt } : {}),
        processed_by: jsonOut(r.processedBy), ready_at: now, failure_reason: null, updated_at: now,
      });
      if (Number(n) > 0) return 'applied';
      return (await statusOf(r.photoId)) === 'READY' ? 'ignored-duplicate' : 'ignored-stale';
    },
    async applyFailure(f) {
      const n = await db('photos').where({ id: f.photoId }).whereIn('status', ['UPLOADING', 'PROCESSING']).update({
        status: 'FAILED', failure_reason: f.error.slice(0, 2000), processed_by: jsonOut(f.processedBy), updated_at: nowIso(),
      });
      if (Number(n) > 0) return 'applied';
      return (await statusOf(f.photoId)) === 'FAILED' ? 'ignored-duplicate' : 'ignored-stale';
    },
    async bumpAttempt(photoId) {
      await db('photos').where({ id: photoId }).update({
        processing_attempts: db.raw('processing_attempts + 1'), processing_started_at: nowIso(), updated_at: nowIso(),
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------------------------
export interface LambdaImageProcessorOptions {
  /** 测试注入：照片状态读写（默认用 deps.db 的 knexPhotoStateStore） */
  store?: PhotoStateStore;
  now?: () => number;
}

interface ResultSample { at: number; durationMs: number; coldStart: boolean; failure: boolean }

export class LambdaImageProcessor implements ImageProcessorPort {
  readonly meta: AdapterMeta = { module: 'image-processing', driver: 'lambda', awsService: 'AWS Lambda', authoritative: true };
  readonly placement = 'lambda' as const;

  private readonly lc: LambdaConfig;
  private readonly now: () => number;
  private readonly storeOverride?: PhotoStateStore;
  private callbackKeyCache?: { value: string; at: number };
  private readonly signatureFailures: number[] = [];
  private readonly samples: ResultSample[] = [];

  constructor(protected readonly deps: AdapterDeps, opts: LambdaImageProcessorOptions = {}) {
    const img = deps.cfg.image;
    if (img.IMAGE_PROCESSOR !== 'lambda') throw new Error(`LambdaImageProcessor 需要 IMAGE_PROCESSOR=lambda（当前 ${img.IMAGE_PROCESSOR}）`);
    this.lc = img;
    this.now = opts.now ?? (() => Date.now());
    if (opts.store) this.storeOverride = opts.store;
  }

  /** S3 Object Created 规则名（infra/modules/image-processing.yaml 约定：cloudalbum-<env>-image-processing-raw-created） */
  get ruleName(): string {
    return `cloudalbum-${this.deps.cfg.core.CLOUDALBUM_ENV}-image-processing-raw-created`;
  }

  private store(): PhotoStateStore | undefined {
    if (this.storeOverride) return this.storeOverride;
    return this.deps.db ? knexPhotoStateStore(this.deps.db) : undefined;
  }

  // ------------------------------------------------------------------------------------------
  // ImageProcessorPort
  // ------------------------------------------------------------------------------------------
  async submit(_job: ImageJob): Promise<{ mode: 'sync'; result: ImageResult } | { mode: 'async'; expectedBy: string }> {
    markPath('image-processing', 'lambda:async');
    return { mode: 'async', expectedBy: new Date(this.now() + this.lc.IMAGE_STUCK_AFTER_SEC * 1000).toISOString() };
  }

  private async callbackKey(): Promise<string> {
    const c = this.callbackKeyCache;
    if (c && this.now() - c.at < 300_000) return c.value;
    const secrets = this.deps.secrets;
    if (!secrets) throw new HttpError(503, 'CALLBACK_KEY_UNAVAILABLE', '没有 SecretsPort，无法读取 callback-hmac-key');
    const value = await secrets.get('callback-hmac-key');
    this.callbackKeyCache = { value, at: this.now() };
    return value;
  }

  private signatureFailed(reason: string): never {
    const t = this.now();
    this.signatureFailures.push(t);
    while (this.signatureFailures.length && t - this.signatureFailures[0]! > 300_000) this.signatureFailures.shift();
    throw new HttpError(401, 'INVALID_CALLBACK_SIGNATURE', reason);
  }

  async acceptCallback(rawBody: Buffer, headers: { signature: string; timestamp: string }): Promise<ImageResult | ImageFailure> {
    if (this.lc.IMAGE_RESULT_CHANNEL !== 'callback') throw new HttpError(404, 'NOT_FOUND', 'IMAGE_RESULT_CHANNEL≠callback');
    const ts = Number(headers.timestamp);
    if (!headers.timestamp || !Number.isFinite(ts)) this.signatureFailed('缺少或无效的 X-CloudAlbum-Timestamp');
    if (Math.abs(this.now() / 1000 - ts) > CALLBACK_TOLERANCE_SEC) this.signatureFailed(`时间戳超出 ±${CALLBACK_TOLERANCE_SEC} 秒`);
    const key = await this.callbackKey();
    if (!headers.signature || !safeEqual(signCallback(key, headers.timestamp, rawBody), headers.signature.trim())) {
      this.signatureFailed('HMAC 签名不匹配');
    }
    return this.parseWire(rawBody.toString('utf8'));
  }

  /** queue 通道：worker 从结果队列取到的消息（SQS Message、消息体字符串或已解析对象都接受） */
  async acceptResult(message: unknown): Promise<ImageResult | ImageFailure> {
    let body: unknown = message;
    if (message && typeof message === 'object' && typeof (message as { Body?: unknown }).Body === 'string') body = (message as { Body: string }).Body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    return this.parseWire(typeof body === 'string' ? body : JSON.stringify(body));
  }

  private parseWire(text: string): ImageResult | ImageFailure {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'INVALID_RESULT', '结果不是合法的 JSON');
    }
    const r = wireSchema.safeParse(json);
    if (!r.success) throw new HttpError(400, 'INVALID_RESULT', `结果格式不符：${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const out = toPort(r.data);
    this.samples.push({ at: this.now(), durationMs: r.data.processedBy.durationMs, coldStart: Boolean(r.data.processedBy.coldStart), failure: r.data.kind === 'failure' });
    if (this.samples.length > 500) this.samples.splice(0, this.samples.length - 500);
    return out;
  }

  /** 写回（状态只前进）：调用方也可以直接用自己的仓储函数 */
  async applyWriteback(r: ImageResult | ImageFailure): Promise<WritebackOutcome> {
    const store = this.store();
    if (!store) throw new Error('LambdaImageProcessor: 没有数据库（deps.db），无法写回');
    return isImageFailure(r) ? store.applyFailure(r) : store.applyResult(r);
  }

  // ------------------------------------------------------------------------------------------
  // 对账
  // ------------------------------------------------------------------------------------------
  async reconcile(stuckBefore: Date): Promise<{ resubmitted: number; failed: number }> {
    const store = this.store();
    if (!store) throw new Error('LambdaImageProcessor.reconcile: 没有数据库（deps.db）');
    const storage = this.deps.storage;
    if (!storage) throw new Error('LambdaImageProcessor.reconcile: 缺少 StoragePort（container 装配顺序错误）');
    let resubmitted = 0;
    let failed = 0;
    let recovered = 0;
    const stuck = await store.listStuck(stuckBefore, 100);
    for (const p of stuck) {
      const recoveredResult = await this.resultFromExistingVariants(p.id).catch(() => null);
      if (recoveredResult) {
        if ((await store.applyResult(recoveredResult)) === 'applied') recovered += 1;
        continue;
      }
      if (p.attempts < this.lc.IMAGE_MAX_ATTEMPTS) {
        await this.invokeFor(p.rawKey);
        await store.bumpAttempt(p.id);
        resubmitted += 1;
      } else {
        await store.applyFailure({
          photoId: p.id, error: `处理超时：已重投 ${p.attempts} 次仍未收到结果（IMAGE_MAX_ATTEMPTS=${this.lc.IMAGE_MAX_ATTEMPTS}）`,
          permanent: true, processedBy: { driver: 'lambda', durationMs: 0, host: 'reconcile' },
        });
        failed += 1;
      }
    }
    if (recovered) this.deps.metrics?.counter('biz.image_reconcile_recovered', recovered, { module: 'image-processing', driver: 'lambda' });
    return { resubmitted, failed };
  }

  /** 衍生图已在媒体桶 → 用对象元数据（Lambda 写入的 width / height / src-*）还原 ImageResult */
  private async resultFromExistingVariants(photoId: string): Promise<ImageResult | null> {
    const storage = this.deps.storage!;
    const names = ['thumb_200', 'display_1080'] as const;
    const infos = await Promise.all(names.map((n) => storage.headObject(`variants/${photoId}/${n}.webp`)));
    if (infos.some((i) => !i)) return null;
    const md = infos[1]!.metadata ?? infos[0]!.metadata ?? {};
    return {
      photoId,
      variants: names.map((name, i) => ({
        name, key: `variants/${photoId}/${name}.webp`,
        width: Number(infos[i]!.metadata?.width ?? 0), height: Number(infos[i]!.metadata?.height ?? 0), bytes: infos[i]!.size,
      })),
      meta: {
        width: Number(md['src-width'] ?? 0), height: Number(md['src-height'] ?? 0), format: md['src-format'] ?? 'unknown',
        dominantColor: md['dominant-color'] ?? '', ...(md['taken-at'] ? { takenAt: md['taken-at'] } : {}),
      },
      processedBy: { driver: 'lambda', durationMs: 0, host: 'reconcile' },
    };
  }

  private rawBucket(): string {
    const s = this.deps.cfg.storage;
    if (s.STORAGE_DRIVER !== 's3') throw new Error('IMAGE_PROCESSOR=lambda 需要 STORAGE_DRIVER=s3（DEP-003）');
    return s.STORAGE_S3_RAW_BUCKET;
  }

  /** 与 EventBridge 的 S3 Object Created 事件同构的载荷，异步调用（InvocationType=Event） */
  syntheticEvent(rawKey: string, reason = 'Reconcile'): Record<string, unknown> {
    const bucket = this.rawBucket();
    return {
      version: '0', id: randomUUID(), 'detail-type': 'Object Created', source: 'aws.s3', account: '',
      time: new Date(this.now()).toISOString(), region: this.deps.aws.region, resources: [`arn:aws:s3:::${bucket}`],
      detail: { version: '0', bucket: { name: bucket }, object: { key: rawKey }, reason },
    };
  }

  async invokeFor(rawKey: string, reason = 'Reconcile'): Promise<void> {
    const { InvokeCommand } = await loadAwsPackage('@aws-sdk/client-lambda', () => import('@aws-sdk/client-lambda'));
    const lambda = await this.deps.aws.lambda();
    await lambda.send(new InvokeCommand({
      FunctionName: this.lc.IMAGE_LAMBDA_FUNCTION, InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(this.syntheticEvent(rawKey, reason))),
    }));
  }

  // ------------------------------------------------------------------------------------------
  // worker：结果队列与失败队列
  // ------------------------------------------------------------------------------------------
  /**
   * 长轮询结果队列（IMAGE_RESULT_CHANNEL=queue）与失败队列，直到 signal 终止。apply 默认写回数据库（状态只前进）。
   * 处理成功（或消息无法解析且属于失败队列）后删除消息；写回失败则留在队列里等待重新投递。
   */
  async consumeResults(opts: { signal: AbortSignal; apply?: (r: ImageResult | ImageFailure) => Promise<unknown>; waitTimeSec?: number }): Promise<void> {
    const apply = opts.apply ?? ((r) => this.applyWriteback(r));
    const loops: Array<Promise<void>> = [
      this.pollQueue(this.lc.IMAGE_FAILURE_QUEUE_URL, 'failure', apply, opts),
    ];
    if (this.lc.IMAGE_RESULT_CHANNEL === 'queue' && this.lc.IMAGE_RESULT_QUEUE_URL) {
      loops.push(this.pollQueue(this.lc.IMAGE_RESULT_QUEUE_URL, 'result', apply, opts));
    }
    await Promise.all(loops);
  }

  /** 处理一条队列消息；返回是否应删除 */
  async handleQueueMessage(kind: 'result' | 'failure', m: { Body?: string; MessageAttributes?: Record<string, { StringValue?: string }> },
    apply: (r: ImageResult | ImageFailure) => Promise<unknown>): Promise<boolean> {
    if (kind === 'failure') {
      const f = parseFailureQueueMessage(m.Body ?? '', m.MessageAttributes ?? {});
      if (!f) {
        this.deps.logger?.warn('image.failure_queue.unparseable', { body: (m.Body ?? '').slice(0, 200) });
        return true;
      }
      await apply(f);
      return true;
    }
    let r: ImageResult | ImageFailure;
    try {
      r = await this.acceptResult(m.Body ?? '');
    } catch (e) {
      this.deps.logger?.warn('image.result_queue.invalid', { error: (e as Error).message });
      return false;                                         // 留给结果队列自己的 DLQ
    }
    await apply(r);
    return true;
  }

  private async pollQueue(url: string, kind: 'result' | 'failure', apply: (r: ImageResult | ImageFailure) => Promise<unknown>,
    opts: { signal: AbortSignal; waitTimeSec?: number }): Promise<void> {
    const { ReceiveMessageCommand, DeleteMessageCommand } = await loadAwsPackage('@aws-sdk/client-sqs', () => import('@aws-sdk/client-sqs'));
    let backoff = 500;
    while (!opts.signal.aborted) {
      try {
        const sqs = await this.deps.aws.sqs();
        const r = await sqs.send(new ReceiveMessageCommand({
          QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: opts.waitTimeSec ?? 20, MessageAttributeNames: ['All'],
        }), { abortSignal: opts.signal });
        for (const m of r.Messages ?? []) {
          let remove = false;
          try {
            remove = await this.handleQueueMessage(kind, m, apply);
          } catch (e) {
            this.deps.logger?.warn('image.queue.apply_failed', { kind, error: (e as Error).message });
          }
          if (remove && m.ReceiptHandle) await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle })).catch(() => undefined);
        }
        backoff = 500;
      } catch (e) {
        if (opts.signal.aborted) break;
        this.deps.logger?.warn('image.queue.receive_failed', { kind, error: describeAwsError(e) });
        await new Promise((res) => setTimeout(res, backoff).unref());
        backoff = Math.min(20_000, backoff * 2);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // 探针（04#image-processing 第 10 节）
  // ------------------------------------------------------------------------------------------
  private recentStats(): { count: number; p95?: number; coldStarts: number; failures: number } {
    const since = this.now() - 300_000;
    const recent = this.samples.filter((s) => s.at >= since);
    const durations = recent.map((s) => s.durationMs).sort((a, b) => a - b);
    const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : undefined;
    return { count: recent.length, ...(p95 !== undefined ? { p95 } : {}), coldStarts: recent.filter((s) => s.coldStart).length, failures: recent.filter((s) => s.failure).length };
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const t0 = performance.now();
    const [lambdaSdk, ebSdk, sqsSdk] = await Promise.all([
      loadAwsPackage('@aws-sdk/client-lambda', () => import('@aws-sdk/client-lambda')),
      loadAwsPackage('@aws-sdk/client-eventbridge', () => import('@aws-sdk/client-eventbridge')),
      loadAwsPackage('@aws-sdk/client-sqs', () => import('@aws-sdk/client-sqs')),
    ]);
    const data: Record<string, unknown> = {
      function: this.lc.IMAGE_LAMBDA_FUNCTION, rule: this.ruleName, trigger: this.lc.IMAGE_TRIGGER, resultChannel: this.lc.IMAGE_RESULT_CHANNEL,
    };
    const problems: string[] = [];
    let status: ProbeResult['status'] = 'ok';
    let arch = '?';

    try {
      const fn = await (await this.deps.aws.lambda()).send(new lambdaSdk.GetFunctionConfigurationCommand({ FunctionName: this.lc.IMAGE_LAMBDA_FUNCTION }));
      arch = fn.Architectures?.[0] ?? 'x86_64';
      Object.assign(data, { state: fn.State, lastUpdateStatus: fn.LastUpdateStatus, runtime: fn.Runtime, memoryMb: fn.MemorySize, architecture: arch });
      if (fn.State && fn.State !== 'Active') {
        return { status: 'error', detail: `函数状态 ${fn.State}（${fn.StateReason ?? ''}）`, confidence: 'confirmed', data };
      }
      if (fn.LastUpdateStatus === 'Failed') {
        status = 'degraded';
        problems.push(`最近一次更新失败：${fn.LastUpdateStatusReason ?? ''}`);
      }
    } catch (e) {
      const why = isAwsNotFound(e) ? '函数不存在' : isAwsAccessDenied(e) ? '无权限（PolicyArn 的 lambda:GetFunctionConfiguration）' : describeAwsError(e);
      return { status: 'error', detail: `GetFunctionConfiguration 失败：${why}`, confidence: 'confirmed', data };
    }

    try {
      const rule = await (await this.deps.aws.eventbridge()).send(new ebSdk.DescribeRuleCommand({ Name: this.ruleName }));
      data.ruleState = rule.State;
      if (rule.State !== 'ENABLED') return { status: 'error', detail: `S3 事件规则 ${this.ruleName} 为 ${rule.State}`, confidence: 'confirmed', data };
    } catch (e) {
      const why = isAwsNotFound(e) ? '规则不存在' : describeAwsError(e);
      return { status: 'error', detail: `DescribeRule ${this.ruleName} 失败：${why}`, confidence: 'confirmed', data };
    }

    const sqs = await this.deps.aws.sqs();
    const depthOf = async (url: string) => {
      const r = await sqs.send(new sqsSdk.GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }));
      return Number(r.Attributes?.ApproximateNumberOfMessages ?? 0);
    };
    try {
      const failureDepth = await depthOf(this.lc.IMAGE_FAILURE_QUEUE_URL);
      data.failureQueueDepth = failureDepth;
      if (failureDepth > 0) {
        status = 'degraded';
        problems.push(`失败队列有 ${failureDepth} 条`);
      }
      if (this.lc.IMAGE_RESULT_CHANNEL === 'queue' && this.lc.IMAGE_RESULT_QUEUE_URL) data.resultQueueDepth = await depthOf(this.lc.IMAGE_RESULT_QUEUE_URL);
    } catch (e) {
      status = 'degraded';
      problems.push(`读取队列深度失败：${describeAwsError(e)}`);
    }

    const store = this.store();
    if (store) {
      try {
        const stuck = await store.countStuck(new Date(this.now() - this.lc.IMAGE_STUCK_AFTER_SEC * 1000));
        data.stuckPhotos = stuck;
        if (stuck > 0) {
          status = 'degraded';
          problems.push(`${stuck} 张照片 PROCESSING 超过 ${this.lc.IMAGE_STUCK_AFTER_SEC} 秒`);
        }
      } catch {
        /* 数据库问题由 database 探针报告 */
      }
    }
    const recentSigFailures = this.signatureFailures.filter((t) => this.now() - t <= 300_000).length;
    if (recentSigFailures > 0) {
      status = 'degraded';
      problems.push(`最近 5 分钟 ${recentSigFailures} 次回调签名校验失败`);
    }
    const s = this.recentStats();
    Object.assign(data, { recent5m: s });
    let channel: string = this.lc.IMAGE_RESULT_CHANNEL;
    if (channel === 'callback' && this.lc.IMAGE_CALLBACK_URL) channel += `(${new URL(this.lc.IMAGE_CALLBACK_URL).protocol.replace(':', '')})`;
    const recentText = s.count ? ` · 最近 5 分钟回写 ${s.count} 次${s.p95 !== undefined ? `（处理 p95 ${Math.round(s.p95)}ms）` : ''} · 冷启动 ${s.coldStarts} 次` : '';
    const detail = `lambda@${arch} · 触发 ${this.lc.IMAGE_TRIGGER} · 回写 ${channel}${recentText}${problems.length ? ` · ${problems.join('；')}` : ''}`;
    return { status, detail, latencyMs: Math.round((performance.now() - t0) * 10) / 10, confidence: 'confirmed', data };
  }
}
