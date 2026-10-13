// backend/src/jobs/index.ts —— 队列任务的绑定与本进程的消费循环（04#queue 第 3 节；总纲 2.6）
//
// - bindJobs(c)：api 与 worker 两个进程启动时都执行（sync 驱动入队即执行，必须先 bind）；幂等；
// - startJobConsumers(c, signal)：按驱动装配消费循环——
//     memory：本进程内消费（api 消费 api 入队的任务；worker 消费定时任务产生的任务；内存队列不能跨进程）；
//     sqs：只在 worker 进程消费；sync：没有消费循环；
// - ensureJobs(c)：路由注册时调用的兜底（bind + 登记定时任务 + memory 消费者），防止入口进程漏接；消费循环随 queue.close() 结束。
//   必须在请求上下文之外调用（消费循环会继承调用时的 AsyncLocalStorage 上下文）。
import type { Container } from '../container.js';
import { parseConcurrency } from '../adapters/queue/memory.js';
import { isNotImplemented } from '../errors.js';
import { jobHandlers } from './handlers.js';
import { scheduledJobs } from './schedule.js';

const bound = new WeakSet<object>();
const consuming = new WeakSet<object>();

export function bindJobs(c: Container): void {
  if (bound.has(c)) return;
  c.queue.bind(jobHandlers(c));
  bound.add(c);
}

/** 本进程消费循环的总并发：各任务名并发上限之和（每个任务名另有自己的上限） */
export function totalConcurrency(c: Container): number {
  const q = c.config.queue;
  const per = parseConcurrency(q.QUEUE_CONCURRENCY);
  const fallback = 'QUEUE_MEMORY_CONCURRENCY' in q ? q.QUEUE_MEMORY_CONCURRENCY : 2;
  const names = ['image.process', 'image.tag', 'notify.fanout', 'email.send', 'analytics.flush'];
  return names.reduce((s, n) => s + (per.get(n) ?? fallback), 0);
}

export function startJobConsumers(c: Container, signal?: AbortSignal): boolean {
  bindJobs(c);
  if (consuming.has(c)) return false;
  const driver = c.config.queue.QUEUE_DRIVER;
  const here = driver === 'memory' || (driver === 'sqs' && c.role === 'worker');
  if (!here) return false;
  consuming.add(c);
  const s = signal ?? new AbortController().signal;
  void c.queue.consume({ concurrency: totalConcurrency(c), signal: s }).catch((e: unknown) => {
    c.logger.error('queue.consumer_stopped', { error: e as Error });
  }).finally(() => consuming.delete(c));
  return true;
}

const registered = new WeakSet<object>();

/** 在本进程登记定时任务（不启动调度）：api 进程里管理员的“立即运行”（SchedulerPort.triggerNow）需要它 */
export function registerScheduledJobs(c: Container): void {
  if (registered.has(c)) return;
  try {
    c.scheduler.register(scheduledJobs(c));
    registered.add(c);
  } catch (e) {
    if (!isNotImplemented(e)) throw e;
  }
}

/** 路由注册时的兜底：bind、登记定时任务，并在 memory 驱动下启动本进程的消费循环（server.ts 已启动时为空操作） */
export function ensureJobs(c: Container): void {
  bindJobs(c);
  registerScheduledJobs(c);
  if (c.config.queue.QUEUE_DRIVER === 'memory') startJobConsumers(c);
}

export { scheduledJobs, SCHEDULE } from './schedule.js';
export { emitNotification } from './notify.js';
export { enqueueSafe } from './enqueue.js';
