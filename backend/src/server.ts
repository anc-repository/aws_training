#!/usr/bin/env node
// backend/src/server.ts —— api 进程入口（cloudalbum-api.service：Express on 127.0.0.1:3000）
//
// 与 worker 的区别（总纲 4.5、2.6）：api 挂载 HTTP 路由，并在 QUEUE_DRIVER=memory 时启动进程内消费者
// （由 queue / L0 实现者在 startApiLoops 中接入：c.queue.bind(...) 与 c.queue.consume(...)）。
import type { Server } from 'node:http';
import { buildContainer, type Container } from './container.js';
import { createApp } from './http/app.js';
import { bindJobs, registerScheduledJobs, startJobConsumers } from './jobs/index.js';
import { onPlatformReload, onShutdown, runMain } from './main.js';
import { reloadPlatformDisplay } from './platform/mode.js';

/**
 * api 进程内的后台工作：bind 全部任务 handler（sync 驱动入队即执行）；QUEUE_DRIVER=memory 时在本进程消费本进程入队的任务
 * （sqs 只在 worker 消费）；登记定时任务但不调度（管理员“立即运行”= SchedulerPort.triggerNow 需要它，调度由 worker 负责）。
 */
async function startApiLoops(c: Container, signal: AbortSignal): Promise<void> {
  bindJobs(c);
  registerScheduledJobs(c);
  startJobConsumers(c, signal);
}

await runMain('cloudalbum-api', async () => {
  const c = await buildContainer('api');
  const app = createApp(c);
  const abort = new AbortController();
  c.startBackground();
  c.labMetrics.heartbeat('api');
  const heartbeat = setInterval(() => c.labMetrics.heartbeat('api'), 10_000);
  heartbeat.unref();
  await startApiLoops(c, abort.signal);

  const { PORT, HOST } = c.config.core;
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(PORT, HOST, () => resolve(s));
  });
  c.logger.info('cloudalbum-api listening', { host: HOST, port: PORT, entry: c.capabilities.snapshot().app.entry });
  onPlatformReload(() => reloadPlatformDisplay(c.config.core.CLOUDALBUM_ENV_DIR, c.config.core.CLOUDALBUM_ENV),
    (msg, fields) => c.logger.info(msg, fields));

  onShutdown(async (signal) => {
    c.logger.info('cloudalbum-api shutting down', { signal });
    c.capabilities.setDraining(true);
    abort.abort();
    clearInterval(heartbeat);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await c.close();
  });
});
