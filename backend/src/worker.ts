#!/usr/bin/env node
// backend/src/worker.ts —— worker 进程入口（cloudalbum-worker.service）
//
// 职责（总纲 2.6）：定时任务（SCHEDULER_DRIVER=cron 的 node-cron；eventbridge 时轮询 tick 队列）、对账、
// QUEUE_DRIVER=sqs 的消费者、模块自带队列的消费循环（image-processing 结果队列、workflow 结果队列、notification 收件队列、
// email 反馈队列）、本地评估器（告警 / 安全分析 / 合规自检，LockPort 单例）、本地指标汇总写库（每 10 秒）。
// 脚手架阶段：容器、探针与 LabMetricsStore 已运行；任务与消费循环由各实现者在 startWorkerLoops 中接入。
import { buildContainer, type Container } from './container.js';
import { isNotImplemented } from './errors.js';
import { onShutdown, runMain } from './main.js';

async function startWorkerLoops(c: Container, signal: AbortSignal): Promise<void> {
  // TODO(L0 / scheduler)：c.scheduler.register(jobDefs(c))（jobs/*.ts 的 8 个 ScheduledJobName）
  try {
    void c.scheduler.start(signal).catch((e: unknown) => {
      if (!isNotImplemented(e)) c.logger.error('scheduler stopped', { error: e as Error });
    });
  } catch (e) {
    if (!isNotImplemented(e)) throw e;
  }
  // TODO(queue)：if (c.config.queue.QUEUE_DRIVER === 'sqs') void c.queue.consume({ concurrency, signal })
  // TODO(image-processing)：IMAGE_RESULT_CHANNEL=queue 时的结果队列轮询器
}

await runMain('cloudalbum-worker', async () => {
  const c = await buildContainer('worker');
  const abort = new AbortController();
  c.startBackground();
  c.labMetrics.heartbeat('worker');
  const heartbeat = setInterval(() => c.labMetrics.heartbeat('worker'), 10_000);
  await startWorkerLoops(c, abort.signal);
  c.logger.info('cloudalbum-worker started', { modules: c.capabilities.summary() });

  onShutdown(async (signal) => {
    c.logger.info('cloudalbum-worker shutting down', { signal });
    abort.abort();
    clearInterval(heartbeat);
    await c.close();
  });
});
