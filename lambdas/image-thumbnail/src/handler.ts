/**
 * lambdas/image-thumbnail —— image-processing=lambda（04#image-processing 第 2 节）
 *
 * 触发：
 *   - IMAGE_TRIGGER=eventbridge：EventBridge 规则（S3 Object Created，含 CopyObject / CompleteMultipartUpload）异步调用，
 *     一次一个事件；暂时错误抛出，交给异步调用重试（MaximumRetryAttempts）与失败目标（FailureQueue）。
 *   - IMAGE_TRIGGER=buffer-queue：规则 → 缓冲队列 → SQS 事件源映射，一批记录（body = EventBridge 事件）；
 *     返回部分批处理失败响应 { batchItemFailures }（ESM 开启 ReportBatchItemFailures），只有失败的记录会重新可见。
 * 处理：HeadObject 检查大小 → GetObject 读成 Buffer → @cloudalbum/image-core render()（与 EC2 的 inline / worker 同一份代码）
 *   → PutObject 两个 WebP 到媒体桶 variants/<photoId>/（对象元数据带宽高与源图信息，供对账补记 READY）。
 * 回写（RESULT_CHANNEL）：callback = 带时间戳的 HMAC 签名 POST；queue = SendMessage 到结果队列。
 * 错误：永久错误（格式不支持、超过像素上限、文件损坏、超过大小上限）回写 FAILED 并正常返回；暂时错误抛出。
 *
 * 环境变量（由 infra/modules/image-processing.yaml 设置）：
 *   MEDIA_BUCKET（必填）、RESULT_CHANNEL=callback|queue、CALLBACK_URL、CALLBACK_HMAC_KEY（secrets=env，NoEcho 参数）
 *   或 CALLBACK_SECRET_ARN（secrets=secretsmanager，初始化时读取并缓存）、RESULT_QUEUE_URL、MAX_PIXELS（默认 40000000）、
 *   MAX_BYTES（默认 31457280 = 30 MB）、RAW_PREFIX（默认 raw/）、CALLBACK_TIMEOUT_MS（默认 10000）。
 * nodejs22.x、arm64，用 esbuild 打包（build.mjs）；sharp 需要 linux-arm64 预编译包（打包时单独安装）。
 */
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { render as defaultRender, type RenderOutput } from '@cloudalbum/image-core';
import type { Context, EventBridgeEvent, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import {
  HEADER_SIGNATURE, HEADER_TIMESTAMP, WIRE_VERSION, parseRawKey, signCallback,
  type WireFailure, type WireMessage, type WireProcessedBy, type WireResult,
} from './wire.js';

export interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size?: number; etag?: string };
  reason?: string;
}

export type ObjectCreatedEvent = EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>;

export interface HandlerDeps {
  s3: Pick<S3Client, 'send'>;
  sqs: Pick<SQSClient, 'send'>;
  fetch: typeof fetch;
  render: (input: Buffer, opts: { photoId: string; maxPixels?: number }) => Promise<RenderOutput>;
  env: () => Record<string, string | undefined>;
  /** CALLBACK_SECRET_ARN → 密钥值（默认经 Secrets Manager 读取） */
  secret?: (arn: string) => Promise<string>;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

/** 暂时错误：抛出后由异步调用重试或部分批失败处理 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

function isPermanent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { permanent?: unknown }).permanent === true;
}

function isSqsEvent(e: unknown): e is SQSEvent {
  return typeof e === 'object' && e !== null && Array.isArray((e as SQSEvent).Records);
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof b.transformToByteArray === 'function') return Buffer.from(await b.transformToByteArray());
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function decodeKey(key: string): string {
  return key.includes('%') ? decodeURIComponent(key.replace(/\+/g, ' ')) : key;
}

let coldStart = true;
const secretCache = new Map<string, { value: string; at: number }>();

/** 测试用：恢复冷启动标记与密钥缓存 */
export function resetModuleState(): void {
  coldStart = true;
  secretCache.clear();
}

export type ProcessOutcome = 'result' | 'failure' | 'skipped';

export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((level, msg, fields) => {
    const line = JSON.stringify({ level, msg, ...(fields ?? {}) });
    if (level === 'error') console.error(line);
    else console.log(line);
  });

  async function hmacKey(env: Record<string, string | undefined>): Promise<string> {
    if (env.CALLBACK_HMAC_KEY) return env.CALLBACK_HMAC_KEY;
    const arn = env.CALLBACK_SECRET_ARN;
    if (!arn) throw new TransientError('callback 通道需要 CALLBACK_HMAC_KEY 或 CALLBACK_SECRET_ARN');
    const cached = secretCache.get(arn);
    if (cached && now() - cached.at < 300_000) return cached.value;
    const read = deps.secret ?? readSecretFromSecretsManager;
    const value = await read(arn);
    secretCache.set(arn, { value, at: now() });
    return value;
  }

  async function report(msg: WireMessage, env: Record<string, string | undefined>): Promise<void> {
    const body = JSON.stringify(msg);
    if ((env.RESULT_CHANNEL ?? 'callback') === 'queue') {
      if (!env.RESULT_QUEUE_URL) throw new TransientError('RESULT_CHANNEL=queue 但没有 RESULT_QUEUE_URL');
      await deps.sqs.send(new SendMessageCommand({
        QueueUrl: env.RESULT_QUEUE_URL, MessageBody: body,
        MessageAttributes: { kind: { DataType: 'String', StringValue: msg.kind } },
      }));
      return;
    }
    if (!env.CALLBACK_URL) throw new TransientError('RESULT_CHANNEL=callback 但没有 CALLBACK_URL');
    const key = await hmacKey(env);
    const ts = String(Math.floor(now() / 1000));
    let res: Response;
    try {
      res = await deps.fetch(env.CALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HEADER_TIMESTAMP]: ts, [HEADER_SIGNATURE]: signCallback(key, ts, body) },
        body,
        signal: AbortSignal.timeout(Number(env.CALLBACK_TIMEOUT_MS ?? 10_000)),
      });
    } catch (e) {
      throw new TransientError(`回调请求失败：${(e as Error).message}`);
    }
    if (res.ok) return;
    // 404 / 410：照片已被删除，重试也没有意义
    if (res.status === 404 || res.status === 410) {
      log('warn', 'callback.photo_gone', { photoId: msg.photoId, status: res.status });
      return;
    }
    throw new TransientError(`回调返回 HTTP ${res.status}`);
  }

  async function processEvent(ev: ObjectCreatedEvent, ctx: { coldStart: boolean; requestId?: string }): Promise<ProcessOutcome> {
    const env = deps.env();
    const started = now();
    const bucket = ev?.detail?.bucket?.name;
    const rawKey = ev?.detail?.object?.key ? decodeKey(ev.detail.object.key) : '';
    const parsed = rawKey ? parseRawKey(rawKey, env.RAW_PREFIX ?? 'raw/') : null;
    if (!bucket || !parsed) {
      log('warn', 'event.skipped', { reason: 'not a raw/<userId>/<photoId>.<ext> object', bucket, key: rawKey });
      return 'skipped';
    }
    const mediaBucket = env.MEDIA_BUCKET;
    if (!mediaBucket) throw new TransientError('缺少环境变量 MEDIA_BUCKET');
    const { photoId } = parsed;
    const processedBy = (): WireProcessedBy => ({
      driver: 'lambda', durationMs: Math.max(0, now() - started), coldStart: ctx.coldStart,
      host: `lambda:${env.AWS_LAMBDA_FUNCTION_NAME ?? 'local'}@${process.arch}`,
    });
    const fail = async (error: string): Promise<ProcessOutcome> => {
      const msg: WireFailure = {
        v: WIRE_VERSION, kind: 'failure', photoId, rawKey, error, permanent: true, processedBy: processedBy(),
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}), finishedAt: new Date(now()).toISOString(),
      };
      await report(msg, env);
      log('warn', 'image.failed_permanent', { photoId, error });
      return 'failure';
    };

    const maxBytes = Number(env.MAX_BYTES ?? 31_457_280);
    const head = await deps.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: rawKey }));
    if (Number(head.ContentLength ?? 0) > maxBytes) return fail(`原图 ${head.ContentLength} 字节，超过上限 ${maxBytes}`);
    const obj = await deps.s3.send(new GetObjectCommand({ Bucket: bucket, Key: rawKey }));
    const input = await bodyToBuffer(obj.Body);

    let out: RenderOutput;
    try {
      out = await deps.render(input, { photoId, maxPixels: Number(env.MAX_PIXELS ?? 40_000_000) });
    } catch (e) {
      if (isPermanent(e)) return fail((e as Error).message);
      throw e;
    }

    const srcMeta: Record<string, string> = {
      'photo-id': photoId,
      'src-width': String(out.meta.width),
      'src-height': String(out.meta.height),
      'src-format': out.meta.format,
      'dominant-color': out.meta.dominantColor,
      ...(out.meta.takenAt ? { 'taken-at': out.meta.takenAt } : {}),
    };
    await Promise.all(out.variants.map((v) => deps.s3.send(new PutObjectCommand({
      Bucket: mediaBucket, Key: v.key, Body: v.body, ContentLength: v.body.length, ContentType: v.contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { ...srcMeta, width: String(v.width), height: String(v.height) },
    }))));

    const msg: WireResult = {
      v: WIRE_VERSION, kind: 'result', photoId, rawKey,
      variants: out.variants.map((v) => ({ name: v.name, key: v.key, width: v.width, height: v.height, bytes: v.bytes })),
      meta: { ...out.meta },
      processedBy: processedBy(),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      finishedAt: new Date(now()).toISOString(),
    };
    await report(msg, env);
    log('info', 'image.processed', { photoId, durationMs: msg.processedBy.durationMs, coldStart: ctx.coldStart });
    return 'result';
  }

  return async function handler(event: ObjectCreatedEvent | SQSEvent, context?: Pick<Context, 'awsRequestId'>): Promise<void | SQSBatchResponse> {
    const isCold = coldStart;
    coldStart = false;
    if (isSqsEvent(event)) {
      const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
      let first = true;
      for (const record of event.Records) {
        try {
          const inner = JSON.parse(record.body) as ObjectCreatedEvent;
          await processEvent(inner, { coldStart: isCold && first, ...(context?.awsRequestId ? { requestId: context.awsRequestId } : {}) });
        } catch (e) {
          log('error', 'record.failed', { messageId: record.messageId, error: (e as Error)?.message ?? String(e) });
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
        first = false;
      }
      return { batchItemFailures };
    }
    await processEvent(event, { coldStart: isCold, ...(context?.awsRequestId ? { requestId: context.awsRequestId } : {}) });
  };
}

async function readSecretFromSecretsManager(arn: string): Promise<string> {
  // Lambda 运行时自带 AWS SDK v3；build.mjs 把 @aws-sdk/* 标为 external
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new TransientError(`密钥 ${arn} 没有 SecretString`);
  return r.SecretString;
}

let defaultHandler: ReturnType<typeof createHandler> | undefined;

/** Lambda 入口（index.handler） */
export async function handler(event: ObjectCreatedEvent | SQSEvent, context?: Context): Promise<void | SQSBatchResponse> {
  defaultHandler ??= createHandler({
    s3: new S3Client({}),
    sqs: new SQSClient({}),
    fetch: globalThis.fetch,
    render: defaultRender,
    env: () => process.env,
  });
  return defaultHandler(event, context);
}
