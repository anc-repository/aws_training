// QueuePort 端口契约（与驱动无关）：sync / memory / sqs 都应通过同一组断言；语义差异（inline / at-most-once / at-least-once）
// 由 semantics 声明，契约按声明分别断言。
import { describe, expect, it } from 'vitest';
import type { JobEnvelope, QueuePort } from '../../../../src/ports/queue.js';

export interface QueueContractHarness {
  create(): Promise<QueuePort>;
  /** 让消费者运行直到条件成立（consumer=inline 的驱动可省略） */
  runConsumer?(q: QueuePort, until: () => boolean): Promise<void>;
  /** 推进时间（让退避中的消息重新可见）；省略时跳过重试用例 */
  advanceTime?(ms: number): void;
}

export function describeQueuePortContract(name: string, h: QueueContractHarness): void {
  describe(`QueuePort 契约：${name}`, () => {
    it('semantics 声明合法', async () => {
      const q = await h.create();
      expect(['inline', 'api', 'worker']).toContain(q.semantics.consumer);
      expect(['inline', 'at-most-once', 'at-least-once']).toContain(q.semantics.delivery);
      expect(typeof q.semantics.durable).toBe('boolean');
    });

    it('bind + enqueue：handler 收到同一个 jobId 与 payload', async () => {
      const q = await h.create();
      const seen: JobEnvelope[] = [];
      q.bind({ 'email.send': async (job) => { seen.push(job); } });
      const r = await q.enqueue('email.send', { to: 'a@example.com' }, { dedupKey: 'mail-1' });
      expect(r.jobId).toBeTruthy();
      expect(['inline', 'queued']).toContain(r.mode);
      if (r.mode === 'queued' && h.runConsumer) await h.runConsumer(q, () => seen.length > 0);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ id: r.jobId, name: 'email.send', payload: { to: 'a@example.com' }, dedupKey: 'mail-1' });
      expect(Date.parse(seen[0]!.enqueuedAt)).not.toBeNaN();
      expect(seen[0]!.attempt).toBeGreaterThanOrEqual(1);
    });

    it('at-least-once：handler 失败后重新投递，最终成功', async () => {
      const q = await h.create();
      if (q.semantics.delivery !== 'at-least-once' || !h.runConsumer || !h.advanceTime) return;
      let calls = 0;
      const attempts: number[] = [];
      q.bind({ 'notify.fanout': async (job) => {
        calls += 1;
        attempts.push(job.attempt);
        if (calls === 1) throw new Error('transient');
      } });
      await q.enqueue('notify.fanout', { n: 1 });
      await h.runConsumer(q, () => calls >= 1);
      h.advanceTime(10_000 + 1);
      await h.runConsumer(q, () => calls >= 2);
      expect(attempts).toEqual([1, 2]);
    });

    it('stats 与 drain 返回非负计数', async () => {
      const q = await h.create();
      const s = await q.stats();
      expect(s.depth).toBeGreaterThanOrEqual(0);
      expect(s.inFlight).toBeGreaterThanOrEqual(0);
      const d = await q.drain(0);
      expect(d.remaining).toBeGreaterThanOrEqual(0);
    });
  });
}
