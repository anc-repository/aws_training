#!/usr/bin/env node
// backend/src/worker.ts —— worker 进程入口（cloudalbum-worker.service）
//
// 职责（总纲 2.6；04 组公共约定 5：只装配当前配置需要的循环）：
//   - 定时任务：SchedulerPort.register(jobs/schedule.ts 的注册表) + start()（cron 档 node-cron；eventbridge 档轮询 tick 队列）；
//   - 队列消费：QUEUE_DRIVER=sqs 时消费应用任务队列；memory 时消费本进程（定时任务）入队的任务；
//   - image-processing 的 lambda 档：结果 / 失败队列轮询器（lambda 适配器的 consumeResults()，
//     拿到的结果交给 PhotoPipeline.handleImageOutcome 统一写回）；
//   - 本地指标汇总写库（container.startBackground）。
import { buildContainer, type Container } from './container.js';
import { isNotImplemented } from './errors.js';
import { bindJobs, registerScheduledJobs, startJobConsumers } from './jobs/index.js';
import { onPlatformReload, onShutdown, runMain } from './main.js';
import { reloadPlatformDisplay } from './platform/mode.js';
import type { ImageFailure, ImageResult } from './ports/image-processor.js';
import { handleImageOutcome, pipelineDeps } from './services/photo-pipeline.js';

/** lambda 适配器提供的结果队列轮询器（IMAGE_RESULT_CHANNEL=queue；同时轮询失败队列）；阻塞直到 signal 终止 */
interface ImageResultConsumer {
  consumeResults(opts: { signal: AbortSignal; apply?: (r: ImageResult | ImageFailure) => Promise<unknown> }): Promise<void>;
}

function hasResultConsumer(x: unknown): x is ImageResultConsumer {
  return typeof (x as Partial<ImageResultConsumer>)?.consumeResults === 'function';
}

export async function startWorkerLoops(c: Container, signal: AbortSignal): Promise<void> {
  // 1) 队列：两个进程都 bind；sqs / memory 在本进程消费
  bindJobs(c);
  startJobConsumers(c, signal);

  // 2) 定时任务
  try {
    registerScheduledJobs(c);
    void c.scheduler.start(signal).catch((e: unknown) => {
      if (!isNotImplemented(e)) c.logger.error('scheduler stopped', { error: e as Error });
    });
  } catch (e) {
    if (!isNotImplemented(e)) throw e;
    c.logger.warn('scheduler 驱动尚未实现，定时任务未启动', { driver: c.config.scheduler.SCHEDULER_DRIVER });
  }

  // 3) lambda 档：结果队列（queue 通道）与失败队列的轮询器；写回统一走 PhotoPipeline（幂等写回 + 打标签 + 通知）
  if (c.config.image.IMAGE_PROCESSOR === 'lambda') {
    if (hasResultConsumer(c.images)) {
      const pd = pipelineDeps(c);
      void c.images.consumeResults({ signal, apply: (r) => handleImageOutcome(pd, r) }).catch((e: unknown) => {
        if (!isNotImplemented(e)) c.logger.error('image result consumer stopped', { error: e as Error });
      });
    } else {
      c.logger.warn('image-processing(lambda) 未提供 consumeResults()，结果 / 失败队列不会被轮询');
    }
  }
}

/** 被 vitest 导入（测试 startWorkerLoops）时不启动进程；作为入口执行（node dist/worker.js、tsx）时总是启动 */
const imported = Boolean(process.env.VITEST);

if (!imported) {
  await runMain('cloudalbum-worker', async () => {
    const c = await buildContainer('worker');
    const abort = new AbortController();
    c.startBackground();
    c.labMetrics.heartbeat('worker');
    const heartbeat = setInterval(() => c.labMetrics.heartbeat('worker'), 10_000);
    await startWorkerLoops(c, abort.signal);
    c.logger.info('cloudalbum-worker started', { modules: c.capabilities.summary() });
    onPlatformReload(() => reloadPlatformDisplay(c.config.core.CLOUDALBUM_ENV_DIR, c.config.core.CLOUDALBUM_ENV),
      (msg, fields) => c.logger.info(msg, fields));

    onShutdown(async (signal) => {
      c.logger.info('cloudalbum-worker shutting down', { signal });
      abort.abort();
      clearInterval(heartbeat);
      await c.close();
    });
  });
}
