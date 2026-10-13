// lambdas/image-thumbnail：EventBridge 单事件 / SQS 批（部分批处理失败响应）、永久与暂时错误、callback HMAC / queue 回写、冷启动
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { PermanentImageError, type RenderOutput } from '@cloudalbum/image-core';
import type { SQSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler, resetModuleState, type HandlerDeps, type ObjectCreatedEvent } from '../src/handler.js';
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, parseRawKey, signCallback, type WireMessage } from '../src/wire.js';

const KEY = 'cb-secret';

function event(key = 'raw/u1/p1.jpg', bucket = 'cloudalbum-lab-raw'): ObjectCreatedEvent {
  return {
    version: '0', id: 'e1', 'detail-type': 'Object Created', source: 'aws.s3', account: '123456789012', time: '2026-10-13T00:00:00Z',
    region: 'ap-northeast-1', resources: [], detail: { bucket: { name: bucket }, object: { key, size: 3 }, reason: 'PutObject' },
  };
}

function rendered(photoId: string): RenderOutput {
  return {
    meta: { width: 4000, height: 3000, format: 'jpeg', dominantColor: '#102030', takenAt: '2026-01-01T00:00:00.000Z' },
    durationMs: 40,
    variants: [
      { name: 'thumb_200', key: `variants/${photoId}/thumb_200.webp`, width: 200, height: 150, bytes: 3, contentType: 'image/webp', body: Buffer.from('thb') },
      { name: 'display_1080', key: `variants/${photoId}/display_1080.webp`, width: 1080, height: 810, bytes: 4, contentType: 'image/webp', body: Buffer.from('disp') },
    ],
  };
}

interface Harness {
  deps: HandlerDeps;
  s3Calls: Array<{ name: string; input: Record<string, unknown> }>;
  sqsCalls: Array<Record<string, unknown>>;
  posts: Array<{ url: string; headers: Headers; body: string }>;
}

function harness(opts: { env?: Record<string, string>; render?: HandlerDeps['render']; fetchStatus?: number; fetchThrows?: boolean; size?: number } = {}): Harness {
  const s3Calls: Harness['s3Calls'] = [];
  const sqsCalls: Harness['sqsCalls'] = [];
  const posts: Harness['posts'] = [];
  const deps: HandlerDeps = {
    s3: {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        s3Calls.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd instanceof HeadObjectCommand) return { ContentLength: opts.size ?? 3 };
        if (cmd instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
        if (cmd instanceof PutObjectCommand) return {};
        throw new Error(`unexpected ${cmd.constructor.name}`);
      }) as unknown as HandlerDeps['s3']['send'],
    },
    sqs: {
      send: vi.fn(async (cmd: { input: Record<string, unknown> }) => {
        if (!(cmd instanceof SendMessageCommand)) throw new Error('unexpected');
        sqsCalls.push(cmd.input);
        return {};
      }) as unknown as HandlerDeps['sqs']['send'],
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (opts.fetchThrows) throw new TypeError('fetch failed');
      posts.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(null, { status: opts.fetchStatus ?? 200 });
    }) as typeof fetch,
    render: opts.render ?? (async (_buf, o) => rendered(o.photoId)),
    env: () => ({
      MEDIA_BUCKET: 'cloudalbum-lab-media', RESULT_CHANNEL: 'callback', CALLBACK_URL: 'http://203.0.113.10/internal/hooks/image-processed',
      CALLBACK_HMAC_KEY: KEY, AWS_LAMBDA_FUNCTION_NAME: 'cloudalbum-lab-image-processing-thumbnail', ...(opts.env ?? {}),
    }),
    log: () => undefined,
  };
  return { deps, s3Calls, sqsCalls, posts };
}

beforeEach(() => resetModuleState());

describe('EventBridge 单事件 + callback 通道', () => {
  it('读原图 → render → 写两个 WebP（元数据带宽高与源图信息）→ HMAC 签名回调', async () => {
    const h = harness();
    await createHandler(h.deps)(event(), { awsRequestId: 'req-1' });
    expect(h.s3Calls.map((c) => c.name)).toEqual(['HeadObjectCommand', 'GetObjectCommand', 'PutObjectCommand', 'PutObjectCommand']);
    const put = h.s3Calls[2]!.input as { Bucket: string; Key: string; ContentType: string; CacheControl: string; Metadata: Record<string, string> };
    expect(put).toMatchObject({ Bucket: 'cloudalbum-lab-media', Key: 'variants/p1/thumb_200.webp', ContentType: 'image/webp', CacheControl: 'public, max-age=31536000, immutable' });
    expect(put.Metadata).toEqual({
      'photo-id': 'p1', width: '200', height: '150', 'src-width': '4000', 'src-height': '3000', 'src-format': 'jpeg',
      'dominant-color': '#102030', 'taken-at': '2026-01-01T00:00:00.000Z',
    });
    expect(h.posts).toHaveLength(1);
    const post = h.posts[0]!;
    const ts = post.headers.get(HEADER_TIMESTAMP)!;
    expect(post.headers.get(HEADER_SIGNATURE)).toBe(signCallback(KEY, ts, post.body));
    const msg = JSON.parse(post.body) as WireMessage;
    expect(msg).toMatchObject({ v: 1, kind: 'result', photoId: 'p1', rawKey: 'raw/u1/p1.jpg', requestId: 'req-1', processedBy: { driver: 'lambda', coldStart: true } });
    expect(msg.kind === 'result' && msg.variants.map((v) => v.name)).toEqual(['thumb_200', 'display_1080']);
  });

  it('第二次调用不再是冷启动', async () => {
    const h = harness();
    const handler = createHandler(h.deps);
    await handler(event());
    await handler(event('raw/u1/p2.png'));
    const msgs = h.posts.map((p) => JSON.parse(p.body) as WireMessage);
    expect(msgs.map((m) => m.processedBy.coldStart)).toEqual([true, false]);
  });

  it('永久错误（格式不支持）→ 回写 FAILED 并正常返回，不抛异常（避免白白重试）', async () => {
    const h = harness({ render: async () => { throw new PermanentImageError('不支持的格式：image/heic'); } });
    await expect(createHandler(h.deps)(event('raw/u1/p3.heic'))).resolves.toBeUndefined();
    const msg = JSON.parse(h.posts[0]!.body) as WireMessage;
    expect(msg).toMatchObject({ kind: 'failure', photoId: 'p3', permanent: true, error: '不支持的格式：image/heic' });
    expect(h.s3Calls.filter((c) => c.name === 'PutObjectCommand')).toHaveLength(0);
  });

  it('原图超过 MAX_BYTES → 永久错误，不读取对象', async () => {
    const h = harness({ size: 40 * 1024 * 1024 });
    await createHandler(h.deps)(event());
    expect(h.s3Calls.map((c) => c.name)).toEqual(['HeadObjectCommand']);
    expect((JSON.parse(h.posts[0]!.body) as WireMessage).kind).toBe('failure');
  });

  it('暂时错误（回调 5xx / 网络失败 / render 意外错误）→ 抛出，交给异步重试与失败目标', async () => {
    await expect(createHandler(harness({ fetchStatus: 502 }).deps)(event())).rejects.toThrow('HTTP 502');
    await expect(createHandler(harness({ fetchThrows: true }).deps)(event())).rejects.toThrow('回调请求失败');
    await expect(createHandler(harness({ render: async () => { throw new Error('sharp crashed'); } }).deps)(event())).rejects.toThrow('sharp crashed');
  });

  it('回调 404（照片已删除）→ 不重试', async () => {
    await expect(createHandler(harness({ fetchStatus: 404 }).deps)(event())).resolves.toBeUndefined();
  });

  it('不是 raw/<userId>/<photoId>.<ext> 的对象 → 跳过；CALLBACK_SECRET_ARN 经 secret() 读取并缓存', async () => {
    const h = harness();
    await createHandler(h.deps)(event('lab/x.jpg'));
    expect(h.s3Calls).toHaveLength(0);
    const secret = vi.fn(async () => 'from-sm');
    const h2 = harness({ env: { CALLBACK_HMAC_KEY: '', CALLBACK_SECRET_ARN: 'arn:aws:secretsmanager:ap-northeast-1:123:secret:cb' } });
    const handler = createHandler({ ...h2.deps, secret });
    await handler(event());
    await handler(event('raw/u1/p9.jpg'));
    expect(secret).toHaveBeenCalledTimes(1);
    const post = h2.posts[0]!;
    expect(post.headers.get(HEADER_SIGNATURE)).toBe(signCallback('from-sm', post.headers.get(HEADER_TIMESTAMP)!, post.body));
  });
});

describe('queue 通道 + buffer-queue 触发（SQS 批）', () => {
  it('RESULT_CHANNEL=queue → SendMessage 到结果队列（不发 HTTP）', async () => {
    const h = harness({ env: { RESULT_CHANNEL: 'queue', RESULT_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123/image-results' } });
    await createHandler(h.deps)(event());
    expect(h.posts).toHaveLength(0);
    expect(h.sqsCalls[0]).toMatchObject({ QueueUrl: 'https://sqs.ap-northeast-1.amazonaws.com/123/image-results', MessageAttributes: { kind: { StringValue: 'result' } } });
  });

  it('SQS 批：返回部分批处理失败响应，只包含失败记录的 messageId', async () => {
    let n = 0;
    const h = harness({ render: async (_b, o) => {
      n += 1;
      if (o.photoId === 'bad') throw new Error('transient S3 timeout');
      return rendered(o.photoId);
    } });
    const batch: SQSEvent = { Records: [
      { messageId: 'm1', body: JSON.stringify(event('raw/u1/a.jpg')) },
      { messageId: 'm2', body: JSON.stringify(event('raw/u1/bad.jpg')) },
      { messageId: 'm3', body: '{not json' },
      { messageId: 'm4', body: JSON.stringify(event('raw/u1/c.jpg')) },
    ] as SQSEvent['Records'] };
    const r = await createHandler(h.deps)(batch);
    expect(r).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }, { itemIdentifier: 'm3' }] });
    expect(n).toBe(3);
    const msgs = h.posts.map((p) => JSON.parse(p.body) as WireMessage);
    expect(msgs.map((m) => [m.photoId, m.processedBy.coldStart])).toEqual([['a', true], ['c', false]]);
  });
});

describe('wire', () => {
  it('parseRawKey', () => {
    expect(parseRawKey('raw/u1/p1.JPG')).toEqual({ userId: 'u1', photoId: 'p1', ext: 'jpg' });
    expect(parseRawKey('raw/_probe/0f8f.jpg')).toEqual({ userId: '_probe', photoId: '0f8f', ext: 'jpg' });
    expect(parseRawKey('raw/u1/deep/p1.jpg')).toBeNull();
    expect(parseRawKey('variants/p1/thumb_200.webp')).toBeNull();
  });
});
