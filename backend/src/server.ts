#!/usr/bin/env node
// backend/src/server.ts —— api 进程入口（cloudalbum-api.service：Express on 127.0.0.1:3000）
//
// 与 worker 的区别（总纲 4.5、2.6）：api 挂载 HTTP 路由，并在 QUEUE_DRIVER=memory 时启动进程内消费者
// （由 queue / L0 实现者在 startApiLoops 中接入：c.queue.bind(...) 与 c.queue.consume(...)）。
import type { Server } from 'node:http';
import { buildContainer, type Container } from './container.js';
import { createApp } from './http/app.js';
import { onShutdown, runMain } from './main.js';

/** api 进程内的后台工作（memory 队列消费者等）；脚手架阶段为空 */
async function startApiLoops(_c: Container, _signal: AbortSignal): Promise<void> {
  // TODO(queue / L0)：bindJobs(c); if (c.config.queue.QUEUE_DRIVER === 'memory') void c.queue.consume({ concurrency, signal })
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

  onShutdown(async (signal) => {
    c.logger.info('cloudalbum-api shutting down', { signal });
    c.capabilities.setDraining(true);
    abort.abort();
    clearInterval(heartbeat);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await c.close();
  });
});
