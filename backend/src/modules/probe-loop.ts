// backend/src/modules/probe-loop.ts —— 探针循环（总纲 6.2：常规探针每 30 秒一次，±5 秒抖动，超时 2 秒）
//
// 通用的“带抖动的周期任务”：上一轮结束后才安排下一轮（不会重叠）；定时器 unref，不阻止进程退出。
export interface LoopOptions {
  intervalSec: number;
  jitterSec?: number;
  /** 立即执行第一轮（默认 false：启动探针已由 probeAll 完成） */
  immediate?: boolean;
  onError?: (e: unknown) => void;
}

export interface LoopHandle {
  stop(): void;
  readonly running: boolean;
}

export function startLoop(task: () => Promise<void>, opts: LoopOptions): LoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const delayMs = () => {
    const jitter = (opts.jitterSec ?? 0) * 1000;
    return Math.max(1000, opts.intervalSec * 1000 + (Math.random() * 2 - 1) * jitter);
  };
  const tick = async () => {
    if (stopped) return;
    try {
      await task();
    } catch (e) {
      opts.onError?.(e);
    }
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, delayMs());
    timer.unref();
  };
  if (opts.immediate) void tick();
  else schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    get running() {
      return !stopped;
    },
  };
}

/** Promise 超时：超时后以 TimeoutError 拒绝（不会取消底层操作） */
export class ProbeTimeoutError extends Error {
  constructor(ms: number) {
    super(`探针超时（${ms}ms）`);
    this.name = 'ProbeTimeoutError';
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError(ms)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
