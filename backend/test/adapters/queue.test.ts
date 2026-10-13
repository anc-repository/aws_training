// QueuePort 契约测试：sync（L0）与 memory（本地档）。语义、bind、重试、本地死信、去重、旁路、排空
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryQueue, parseConcurrency } from '../../src/adapters/queue/memory.js';
import { SyncQueue } from '../../src/adapters/queue/sync.js';
import { createRequestContext, runWithContext } from '../../src/observability/request-context.js';
import type { JobEnvelope, QueuePort } from '../../src/ports/queue.js';
import { listQueueFailures } from '../../src/repositories/job-runs.js';
import { adapterDeps, testConfig, testDb, waitFor } from '../helpers/media-fixtures.js';

let db: Knex;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.destroy();
});

/** 所有 QueuePort 驱动共有的行为（sqs 驱动的实现者可以复用：传入一个已启动消费的队列） */
export function queueContract(name: string, make: (db: Knex) => { q: QueuePort; start?: (signal: AbortSignal) => void }): void {
  describe(`QueuePort 契约：${name}`, () => {
    it('bind 之后 enqueue 的任务被执行，信封带 id / attempt / enqueuedAt / dedupKey', async () => {
      const { q, start } = make(db);
      const seen: JobEnvelope[] = [];
      q.bind({ 'analytics.flush': async (j) => { seen.push(j); } });
      const abort = new AbortController();
      start?.(abort.signal);
      const r = await q.enqueue('analytics.flush', { n: 1 }, { dedupKey: 'd1' });
      expect(r.jobId).toBeTruthy();
      await waitFor(async () => seen.length === 1);
      expect(seen[0]).toMatchObject({ id: r.jobId, name: 'analytics.flush', payload: { n: 1 }, attempt: 1, dedupKey: 'd1' });
      expect(Date.parse(seen[0]!.enqueuedAt)).toBeGreaterThan(0);
      abort.abort();
      await q.close?.();
    });

    it('没有 bind 的任务名入队时报错', async () => {
      const { q } = make(db);
      await expect(q.enqueue('email.send', {})).rejects.toThrow(/没有绑定 handler/);
      await q.close?.();
    });

    it('stats 与 probe', async () => {
      const { q } = make(db);
      const s = await q.stats();
      expect(s.depth).toBeGreaterThanOrEqual(0);
      expect(s.inFlight).toBeGreaterThanOrEqual(0);
      expect(['ok', 'degraded']).toContain((await q.probe()).status);
      await q.close?.();
    });
  });
}

const syncCfg = testConfig();
const memCfg = testConfig({ QUEUE_DRIVER: 'memory', QUEUE_MAX_ATTEMPTS: '2', QUEUE_CONCURRENCY: 'image.process:1,email.send:1' });

queueContract('sync', (d) => ({ q: new SyncQueue(adapterDeps(syncCfg, { db: d })) }));
queueContract('memory', (d) => {
  const q = new MemoryQueue(adapterDeps(memCfg, { db: d }));
  return { q, start: (signal) => void q.consume({ concurrency: 4, signal }) };
});

describe('SyncQueue', () => {
  it('语义 inline；入队即在当前请求内执行，路径头 queue=sync:inline', async () => {
    const q = new SyncQueue(adapterDeps(syncCfg, { db }));
    expect(q.semantics).toEqual({ durable: false, consumer: 'inline', delivery: 'inline' });
    let ran = false;
    q.bind({ 'image.tag': async () => { ran = true; } });
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => q.enqueue('image.tag', {}));
    expect(r.mode).toBe('inline');
    expect(ran).toBe(true);
    expect(ctx.path.get('queue')).toBe('sync:inline');
    expect(await q.drain(1)).toEqual({ remaining: 0 });
  });

  it('handler 出错：异常抛回调用方，并写一行本地死信（job_runs，name = queue.<任务名>）；探针 degraded', async () => {
    const q = new SyncQueue(adapterDeps(syncCfg, { db }));
    q.bind({ 'email.send': async () => { throw new Error('smtp down'); } });
    await expect(q.enqueue('email.send', { to: ['a@b'] })).rejects.toThrow('smtp down');
    const failures = await listQueueFailures(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: 'queue.email.send', status: 'failed', trigger: 'queue', executor: 'sync', error: 'smtp down' });
    expect(failures[0]!.detail).toMatchObject({ payload: { to: ['a@b'] }, source: 'sync' });
    expect((await q.probe()).status).toBe('degraded');
  });

  it('consume 阻塞到 signal 终止', async () => {
    const q = new SyncQueue(adapterDeps(syncCfg, { db }));
    const abort = new AbortController();
    const p = q.consume({ concurrency: 1, signal: abort.signal });
    abort.abort();
    await expect(p).resolves.toBeUndefined();
  });
});

describe('MemoryQueue', () => {
  it('语义 at-most-once；enqueue 立即返回 queued，后台执行；路径头 memory:queued', async () => {
    const q = new MemoryQueue(adapterDeps(memCfg, { db }));
    expect(q.semantics).toEqual({ durable: false, consumer: 'api', delivery: 'at-most-once' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let done = false;
    q.bind({ 'image.process': async () => { await gate; done = true; } });
    const abort = new AbortController();
    void q.consume({ concurrency: 4, signal: abort.signal });
    const ctx = createRequestContext();
    const r = await runWithContext(ctx, () => q.enqueue('image.process', {}));
    expect(r.mode).toBe('queued');
    expect(ctx.path.get('queue')).toBe('memory:queued');
    expect(done).toBe(false);
    await waitFor(async () => (await q.stats()).inFlight === 1);
    release();
    await waitFor(async () => done);
    abort.abort();
    await q.close();
  });

  it('失败按退避重试，用尽后写本地死信', async () => {
    const q = new MemoryQueue(adapterDeps(memCfg, { db }));
    q.backoffMs = () => 5;
    let attempts = 0;
    q.bind({ 'email.send': async (j) => { attempts = j.attempt; throw new Error(`fail #${j.attempt}`); } });
    const abort = new AbortController();
    void q.consume({ concurrency: 2, signal: abort.signal });
    await q.enqueue('email.send', { x: 1 });
    const failures = await waitFor(async () => {
      const f = await listQueueFailures(db);
      return f.length ? f : null;
    });
    expect(attempts).toBe(2);                         // QUEUE_MAX_ATTEMPTS=2
    expect(failures[0]).toMatchObject({ name: 'queue.email.send', attempt: 2, executor: 'memory', error: 'fail #2' });
    abort.abort();
    await q.close();
  });

  it('同一 dedupKey 排队中不重复入队；每个任务名有自己的并发上限', async () => {
    const q = new MemoryQueue(adapterDeps(memCfg, { db }));
    let active = 0;
    let maxActive = 0;
    let count = 0;
    q.bind({
      'image.process': async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        count++;
      },
    });
    const a = await q.enqueue('image.process', {}, { dedupKey: 'same' });
    const b = await q.enqueue('image.process', {}, { dedupKey: 'same' });
    expect(b.jobId).toBe(a.jobId);
    await q.enqueue('image.process', {});
    await q.enqueue('image.process', {});
    expect((await q.stats()).depth).toBe(3);
    const abort = new AbortController();
    void q.consume({ concurrency: 10, signal: abort.signal });
    await waitFor(async () => count === 3);
    expect(maxActive).toBe(1);                         // image.process:1
    abort.abort();
    await q.close();
  });

  it('X-Compare-Bypass: queue 时当场执行（memory:bypass-inline）', async () => {
    const q = new MemoryQueue(adapterDeps(memCfg, { db }));
    let ran = false;
    q.bind({ 'notify.fanout': async () => { ran = true; } });
    const ctx = createRequestContext();
    ctx.bypass.add('queue');
    const r = await runWithContext(ctx, () => q.enqueue('notify.fanout', {}));
    expect(r.mode).toBe('inline');
    expect(ran).toBe(true);
    expect(ctx.path.get('queue')).toBe('memory:bypass-inline');
  });

  it('delaySec 到期后才执行；drain 停止接收新任务并等待排空', async () => {
    const q = new MemoryQueue(adapterDeps(memCfg, { db }));
    const ran: number[] = [];
    q.bind({ 'analytics.flush': async (j) => { ran.push((j.payload as { n: number }).n); } });
    const abort = new AbortController();
    void q.consume({ concurrency: 2, signal: abort.signal });
    await q.enqueue('analytics.flush', { n: 1 }, { delaySec: 0.05 });
    await q.enqueue('analytics.flush', { n: 2 });
    await waitFor(async () => ran.length === 2);
    expect(ran).toEqual([2, 1]);
    expect(await q.drain(1)).toEqual({ remaining: 0 });
    await expect(q.enqueue('analytics.flush', { n: 3 })).rejects.toMatchObject({ status: 503 });
    abort.abort();
    await q.close();
  });

  it('parseConcurrency', () => {
    expect([...parseConcurrency('image.process:1, image.tag:2,bad,x:0').entries()]).toEqual([['image.process', 1], ['image.tag', 2]]);
  });
});
