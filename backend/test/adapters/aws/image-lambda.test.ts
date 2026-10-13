// image-processing=lambda：HMAC 回调、结果队列、失败队列三种格式、对账（补记 / 重投 / FAILED）、写回“状态只前进”、探针
import { GetFunctionConfigurationCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DescribeRuleCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { GetQueueAttributesCommand, ReceiveMessageCommand, DeleteMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import knexFactory from 'knex';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LambdaImageProcessor, isImageFailure, knexPhotoStateStore, parseFailureQueueMessage, signCallback,
  type PhotoStateStore, type StuckPhoto,
} from '../../../src/adapters/image-processing/lambda.js';
import { MIGRATION_SOURCE } from '../../../src/db/migrations/index.js';
import { migrateLatest } from '../../../src/db/knex.js';
import { nowIso } from '../../../src/db/dialect.js';
import { createRequestContext, runWithContext } from '../../../src/observability/request-context.js';
import type { ImageFailure, ImageResult } from '../../../src/ports/image-processor.js';
import type { ObjectInfo, StoragePort } from '../../../src/ports/storage.js';
import { ENABLE } from '../../helpers/config.js';
import { awsError, makeDeps, waitFor } from './helpers.js';

const KEY = 'callback-secret';
const lambda = mockClient(LambdaClient);
const events = mockClient(EventBridgeClient);
const sqs = mockClient(SQSClient);
afterEach(() => {
  lambda.reset();
  events.reset();
  sqs.reset();
});

const callbackEnv = { ...ENABLE.iamRole, ...ENABLE.s3, ...ENABLE.lambdaCallback };
const queueEnv = { ...ENABLE.iamRole, ...ENABLE.s3, ...ENABLE.lambdaQueue };

function wireResult(photoId = 'p1', extra: Record<string, unknown> = {}) {
  return {
    v: 1, kind: 'result', photoId, rawKey: `raw/u1/${photoId}.jpg`,
    variants: [
      { name: 'thumb_200', key: `variants/${photoId}/thumb_200.webp`, width: 200, height: 150, bytes: 1000 },
      { name: 'display_1080', key: `variants/${photoId}/display_1080.webp`, width: 1080, height: 810, bytes: 9000 },
    ],
    meta: { width: 4000, height: 3000, format: 'jpeg', dominantColor: '#aabbcc' },
    processedBy: { driver: 'lambda', durationMs: 850, coldStart: true, host: 'lambda:fn@arm64' },
    finishedAt: new Date().toISOString(),
    ...extra,
  };
}

class MemoryStore implements PhotoStateStore {
  stuck: StuckPhoto[] = [];
  results: ImageResult[] = [];
  failures: ImageFailure[] = [];
  bumped: string[] = [];
  async listStuck() {
    return this.stuck;
  }
  async countStuck() {
    return this.stuck.length;
  }
  async applyResult(r: ImageResult) {
    this.results.push(r);
    return 'applied' as const;
  }
  async applyFailure(f: ImageFailure) {
    this.failures.push(f);
    return 'applied' as const;
  }
  async bumpAttempt(id: string) {
    this.bumped.push(id);
  }
}

function storageStub(objects: Record<string, ObjectInfo>): StoragePort {
  return { headObject: async (key: string) => objects[key] ?? null } as unknown as StoragePort;
}

function newProcessor(env: Record<string, string> = callbackEnv, opts: { store?: PhotoStateStore; storage?: StoragePort; now?: () => number } = {}) {
  const deps = makeDeps(env, { secrets: { 'callback-hmac-key': KEY }, extra: opts.storage ? { storage: opts.storage } : {} });
  return new LambdaImageProcessor(deps, { ...(opts.store ? { store: opts.store } : {}), ...(opts.now ? { now: opts.now } : {}) });
}

describe('submit', () => {
  it('只登记等待结果（expectedBy = now + IMAGE_STUCK_AFTER_SEC），不调用 AWS；路径头 lambda:async', async () => {
    const p = newProcessor(callbackEnv, { now: () => Date.parse('2026-10-13T00:00:00Z') });
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => p.submit({ photoId: 'p1', rawKey: 'raw/u1/p1.jpg', ownerId: 'u1' }));
    expect(r).toEqual({ mode: 'async', expectedBy: '2026-10-13T00:02:00.000Z' });
    expect(ctx.path.get('image-processing')).toBe('lambda:async');
    expect(lambda.calls()).toHaveLength(0);
  });
});

describe('acceptCallback（HMAC，±300 秒）', () => {
  const body = Buffer.from(JSON.stringify(wireResult()));
  const ts = () => String(Math.floor(Date.now() / 1000));

  it('签名正确 → ImageResult', async () => {
    const p = newProcessor();
    const t = ts();
    const r = await p.acceptCallback(body, { timestamp: t, signature: signCallback(KEY, t, body) });
    expect(isImageFailure(r)).toBe(false);
    expect(r).toMatchObject({ photoId: 'p1', processedBy: { driver: 'lambda', coldStart: true }, meta: { width: 4000 } });
  });

  it('签名错误 / 时间戳过期 → 401，并让探针在 5 分钟内报 degraded', async () => {
    const p = newProcessor();
    const t = ts();
    await expect(p.acceptCallback(body, { timestamp: t, signature: signCallback('wrong', t, body) })).rejects.toMatchObject({ status: 401 });
    const old = String(Math.floor(Date.now() / 1000) - 301);
    await expect(p.acceptCallback(body, { timestamp: old, signature: signCallback(KEY, old, body) })).rejects.toMatchObject({ status: 401 });
    await expect(p.acceptCallback(body, { timestamp: '', signature: '' })).rejects.toMatchObject({ status: 401 });
    lambda.on(GetFunctionConfigurationCommand).resolves({ State: 'Active', Architectures: ['arm64'] });
    events.on(DescribeRuleCommand).resolves({ State: 'ENABLED' });
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { ApproximateNumberOfMessages: '0' } });
    const probe = await p.probe();
    expect(probe.status).toBe('degraded');
    expect(probe.detail).toContain('3 次回调签名校验失败');
  });

  it('请求体不是合法结果 → 400；永久错误 → ImageFailure', async () => {
    const p = newProcessor();
    const bad = Buffer.from('{"v":1,"kind":"result"}');
    const t = ts();
    await expect(p.acceptCallback(bad, { timestamp: t, signature: signCallback(KEY, t, bad) })).rejects.toMatchObject({ status: 400 });
    const failure = Buffer.from(JSON.stringify({
      v: 1, kind: 'failure', photoId: 'p9', rawKey: 'raw/u1/p9.heic', error: '不支持的格式', permanent: true,
      processedBy: { driver: 'lambda', durationMs: 5, host: 'h' }, finishedAt: nowIso(),
    }));
    const r = await p.acceptCallback(failure, { timestamp: t, signature: signCallback(KEY, t, failure) });
    expect(r).toEqual({ photoId: 'p9', error: '不支持的格式', permanent: true, processedBy: { driver: 'lambda', durationMs: 5, host: 'h' } });
  });

  it('queue 通道下 callback 端点视为不存在（404）', async () => {
    const p = newProcessor(queueEnv);
    await expect(p.acceptCallback(body, { timestamp: ts(), signature: 'v1=x' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('结果队列与失败队列', () => {
  it('acceptResult 接受 SQS 消息、字符串与对象', async () => {
    const p = newProcessor(queueEnv);
    expect((await p.acceptResult({ Body: JSON.stringify(wireResult('a')) })).photoId).toBe('a');
    expect((await p.acceptResult(JSON.stringify(wireResult('b')))).photoId).toBe('b');
    expect((await p.acceptResult(wireResult('c'))).photoId).toBe('c');
  });

  it('失败队列的三种格式都能解析出 photoId', () => {
    const event = { source: 'aws.s3', 'detail-type': 'Object Created', detail: { bucket: { name: 'raw' }, object: { key: 'raw/u1/p5.jpg' } } };
    const asyncFailure = parseFailureQueueMessage(JSON.stringify({
      requestContext: { condition: 'RetriesExhausted' }, requestPayload: event, responsePayload: { errorType: 'TimeoutError', errorMessage: 'S3 timeout' },
    }));
    expect(asyncFailure).toMatchObject({ photoId: 'p5', permanent: true });
    expect(asyncFailure!.error).toContain('RetriesExhausted');
    expect(asyncFailure!.error).toContain('S3 timeout');
    const ruleDlq = parseFailureQueueMessage(JSON.stringify(event), { ERROR_CODE: { StringValue: 'SDK_CLIENT_ERROR' }, ERROR_MESSAGE: { StringValue: 'throttled' } });
    expect(ruleDlq!.error).toContain('SDK_CLIENT_ERROR');
    expect(parseFailureQueueMessage(JSON.stringify(event))!.error).toContain('重试次数耗尽');
    expect(parseFailureQueueMessage('{bad')).toBeNull();
    expect(parseFailureQueueMessage(JSON.stringify({ detail: { object: { key: 'other/x' } } }))).toBeNull();
  });

  it('consumeResults：结果队列 → apply 后删除；失败队列 → 标 FAILED 后删除', async () => {
    const results = ENABLE.lambdaQueue.IMAGE_RESULT_QUEUE_URL;
    const failures = ENABLE.lambdaQueue.IMAGE_FAILURE_QUEUE_URL;
    const served = new Set<string>();
    sqs.on(ReceiveMessageCommand).callsFake(async (input: { QueueUrl: string }) => {
      if (served.has(input.QueueUrl)) {
        await new Promise((r) => setTimeout(r, 5));
        return { Messages: [] };
      }
      served.add(input.QueueUrl);
      if (input.QueueUrl === results) return { Messages: [{ ReceiptHandle: 'r1', Body: JSON.stringify(wireResult('q1')) }] };
      return { Messages: [{ ReceiptHandle: 'f1', Body: JSON.stringify({ detail: { object: { key: 'raw/u1/q2.png' } } }) }] };
    });
    sqs.on(DeleteMessageCommand).resolves({});
    const applied: Array<ImageResult | ImageFailure> = [];
    const p = newProcessor(queueEnv);
    const ac = new AbortController();
    const run = p.consumeResults({ signal: ac.signal, apply: async (r) => { applied.push(r); } });
    await waitFor(() => applied.length >= 2);
    ac.abort();
    await run;
    expect(applied.map((a) => a.photoId).sort()).toEqual(['q1', 'q2']);
    expect(applied.find((a) => a.photoId === 'q2')).toMatchObject({ permanent: true });
    expect(served).toEqual(new Set([results, failures]));
    expect(sqs.commandCalls(DeleteMessageCommand).map((c) => c.args[0].input.ReceiptHandle).sort()).toEqual(['f1', 'r1']);
  });
});

describe('reconcile', () => {
  it('衍生图已存在 → 补记 READY；次数内 → InvokeFunction(Event) 重投；超过次数 → FAILED', async () => {
    const store = new MemoryStore();
    store.stuck = [
      { id: 'done', rawKey: 'raw/u1/done.jpg', ownerId: 'u1', attempts: 1 },
      { id: 'retry', rawKey: 'raw/u1/retry.jpg', ownerId: 'u1', attempts: 1 },
      { id: 'dead', rawKey: 'raw/u1/dead.jpg', ownerId: 'u1', attempts: 3 },
    ];
    const meta = { width: '200', height: '150', 'src-width': '4000', 'src-height': '3000', 'src-format': 'jpeg', 'dominant-color': '#123456' };
    const storage = storageStub({
      'variants/done/thumb_200.webp': { key: 'variants/done/thumb_200.webp', size: 100, contentType: 'image/webp', lastModified: nowIso(), metadata: meta },
      'variants/done/display_1080.webp': { key: 'variants/done/display_1080.webp', size: 900, contentType: 'image/webp', lastModified: nowIso(), metadata: { ...meta, width: '1080', height: '810' } },
    });
    lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
    const p = newProcessor(callbackEnv, { store, storage });
    expect(await p.reconcile(new Date())).toEqual({ resubmitted: 1, failed: 1 });
    expect(store.results[0]).toMatchObject({ photoId: 'done', meta: { width: 4000, height: 3000, format: 'jpeg', dominantColor: '#123456' } });
    expect(store.results[0]!.variants[1]).toMatchObject({ name: 'display_1080', width: 1080, bytes: 900 });
    expect(store.bumped).toEqual(['retry']);
    expect(store.failures.map((f) => f.photoId)).toEqual(['dead']);
    const invoke = lambda.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(invoke.InvocationType).toBe('Event');
    const payload = JSON.parse(Buffer.from(invoke.Payload as Uint8Array).toString()) as { source: string; detail: { bucket: { name: string }; object: { key: string } } };
    expect(payload).toMatchObject({ source: 'aws.s3', 'detail-type': 'Object Created', detail: { bucket: { name: 'cloudalbum-lab-raw' }, object: { key: 'raw/u1/retry.jpg' } } });
  });
});

describe('knexPhotoStateStore（SQLite）：状态只前进', () => {
  let db: Knex;
  beforeEach(async () => {
    db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, migrations: { migrationSource: MIGRATION_SOURCE }, pool: { min: 1, max: 1 } });
    await migrateLatest(db);
    const now = nowIso();
    await db('users').insert({ id: 'u1', email: 'u1@example.com', auth_subject: 'u1', created_at: now, updated_at: now });
    const old = new Date(Date.now() - 600_000).toISOString();
    for (const [id, status] of [['p1', 'PROCESSING'], ['p2', 'READY'], ['p3', 'BLOCKED'], ['p4', 'PROCESSING']] as const) {
      await db('photos').insert({ id, owner_id: 'u1', raw_key: `raw/u1/${id}.jpg`, content_type: 'image/jpeg', status, processing_started_at: old, processing_attempts: 1, created_at: now, updated_at: now });
    }
  });
  afterEach(async () => db.destroy());

  it('applyResult / applyFailure / listStuck / countStuck / bumpAttempt', async () => {
    const store = knexPhotoStateStore(db);
    expect((await store.listStuck(new Date(), 10)).map((s) => s.id).sort()).toEqual(['p1', 'p4']);
    expect(await store.countStuck(new Date())).toBe(2);
    const r = (await newProcessor().acceptResult(wireResult('p1'))) as ImageResult;
    expect(await store.applyResult(r)).toBe('applied');
    expect(await store.applyResult(r)).toBe('ignored-duplicate');
    expect(await store.applyResult({ ...r, photoId: 'p3' })).toBe('ignored-stale');          // 不覆盖 BLOCKED
    const row = await db('photos').where({ id: 'p1' }).first();
    expect(row).toMatchObject({ status: 'READY', thumb_key: 'variants/p1/thumb_200.webp', width: 4000, height: 3000, dominant_color: '#aabbcc' });
    const failure: ImageFailure = { photoId: 'p2', error: 'x', permanent: true, processedBy: { driver: 'lambda', durationMs: 0, host: 'h' } };
    expect(await store.applyFailure(failure)).toBe('ignored-stale');                         // 不覆盖 READY
    expect(await store.applyFailure({ ...failure, photoId: 'p4' })).toBe('applied');
    expect(await store.applyFailure({ ...failure, photoId: 'p4' })).toBe('ignored-duplicate');
    expect((await store.applyResult({ ...r, photoId: 'p4' }))).toBe('applied');               // READY 可以覆盖 FAILED（迟到的成功）
    await store.bumpAttempt('p1');
    expect((await db('photos').where({ id: 'p1' }).first()).processing_attempts).toBe(2);
  });
});

describe('probe', () => {
  beforeEach(() => {
    lambda.on(GetFunctionConfigurationCommand).resolves({ State: 'Active', LastUpdateStatus: 'Successful', Architectures: ['arm64'], MemorySize: 1024 });
    events.on(DescribeRuleCommand).resolves({ State: 'ENABLED' });
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { ApproximateNumberOfMessages: '0' } });
  });

  it('函数 Active + 规则 ENABLED + 失败队列为空 → ok；规则名按约定', async () => {
    const r = await newProcessor(callbackEnv, { store: new MemoryStore() }).probe();
    expect(r.status).toBe('ok');
    expect(r.detail).toBe('lambda@arm64 · 触发 eventbridge · 回写 callback(https)');
    expect(events.commandCalls(DescribeRuleCommand)[0]!.args[0].input.Name).toBe('cloudalbum-lab-image-processing-raw-created');
  });

  it('函数不存在 / 规则被禁用 → error；失败队列有消息 / 有超时照片 → degraded', async () => {
    lambda.on(GetFunctionConfigurationCommand).rejects(awsError('ResourceNotFoundException', 404));
    expect((await newProcessor().probe()).detail).toContain('函数不存在');
    lambda.on(GetFunctionConfigurationCommand).resolves({ State: 'Active' });
    events.on(DescribeRuleCommand).resolves({ State: 'DISABLED' });
    expect((await newProcessor().probe()).status).toBe('error');
    events.on(DescribeRuleCommand).resolves({ State: 'ENABLED' });
    sqs.on(GetQueueAttributesCommand).resolves({ Attributes: { ApproximateNumberOfMessages: '2' } });
    const store = new MemoryStore();
    store.stuck = [{ id: 'x', rawKey: 'raw/u/x.jpg', ownerId: 'u', attempts: 1 }];
    const r = await newProcessor(callbackEnv, { store }).probe();
    expect(r.status).toBe('degraded');
    expect(r.detail).toContain('失败队列有 2 条');
    expect(r.detail).toContain('1 张照片 PROCESSING 超过 120 秒');
  });

  it('最近 5 分钟的回写统计进入 detail（冷启动次数）', async () => {
    const p = newProcessor(queueEnv, { store: new MemoryStore() });
    await p.acceptResult(wireResult('a'));
    await p.acceptResult(wireResult('b', { processedBy: { driver: 'lambda', durationMs: 100, coldStart: false, host: 'h' } }));
    const r = await p.probe();
    expect(r.detail).toContain('最近 5 分钟回写 2 次');
    expect(r.detail).toContain('冷启动 1 次');
  });
});
