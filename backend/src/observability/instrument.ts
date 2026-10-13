// backend/src/observability/instrument.ts —— 适配器代理：计时、路径记录、被动健康信号、故障注入（§4.1、§6.2、§7、§8.4）
//
// container 给每个适配器套一层 Proxy：
//   - 每次方法调用把耗时累加到请求上下文的 Server-Timing（同一模块多次调用累加），并在 X-CloudAlbum-Path 中
//     记下 `<module>=<driver>`（适配器 / 服务可用 ctx.path.mark() 覆盖为带主机类别与结果的完整值）；
//   - 把成败喂给能力注册表（被动信号）与 LabMetricsStore（端口调用统计）；
//   - 生效中的实验故障（latency / error）在调用前注入，并把结果标为 `fault`。
// 不计时的方法：探针、生命周期方法，以及会阻塞或包含其他端口调用的方法（例如 CachePort.wrap 包含 loader 的数据库耗时，
// 缓存驱动应自行用 addTiming() 记录 get / set）。
import { performance } from 'node:perf_hooks';
import type { ModuleId } from '@cloudalbum/contracts';
import type { Adapter } from '../ports/common.js';
import { faults as defaultFaults, type FaultRegistry } from './faults.js';
import { currentContext } from './request-context.js';

export interface PortCallEvent {
  module: ModuleId;
  driver: string;
  method: string;
  ms: number;
  ok: boolean;
  error?: unknown;
  /** 失败但属于调用方的问题（4xx 的 HttpError、永久性错误、对象不存在）：不计入被动健康信号 */
  clientError?: boolean;
  /** 是否在 HTTP 请求上下文中 */
  inRequest: boolean;
  runId?: string;
  label?: string;
}

export interface CallObserver {
  onCall(e: PortCallEvent): void;
}

export const UNTIMED_METHODS: ReadonlySet<string> = new Set([
  // 生命周期与探针
  'probe', 'init', 'close',
  // 同步只读 / 配置
  'publicConfig', 'jwks', 'current', 'describeSource', 'internalRedirectPath', 'mediaUrl',
  // 阻塞或包含其他端口调用
  'wrap', 'consume', 'bind', 'start', 'register', 'drain',
  // 回调注册与装配期注入
  'onChange', 'onRotate', 'onTerminating', 'attachPipeline', 'attachDetector',
  // 阻塞的结果队列轮询器（image-processing=lambda 的 consumeResults）
  'consumeResults',
  // 内部组件复用连接（LockPort(redis) 取 RedisCache 的客户端）
  'redisClient',
  // Logger / Metrics / Tracer 的热路径（这些端口默认不套代理）
  'log', 'debug', 'info', 'warn', 'error', 'child', 'flush', 'counter', 'histogram', 'gauge',
  'startSpan', 'withSpan', 'currentTraceId', 'inject', 'extract',
]);

export interface InstrumentOptions {
  observers?: readonly CallObserver[];
  faults?: FaultRegistry;
  /** 额外不计时的方法 */
  untimed?: readonly string[];
}

/** 4xx 的 HttpError、`permanent: true` 的错误（坏图片等）与“对象不存在”是调用方的问题，不说明端口不健康 */
export function isClientError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const x = e as { status?: unknown; permanent?: unknown; name?: unknown; code?: unknown };
  if (x.permanent === true) return true;
  if (typeof x.status === 'number' && x.status >= 400 && x.status < 500) return true;
  return x.name === 'ObjectNotFoundError' || x.code === 'OBJECT_NOT_FOUND';
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function instrument<T extends Adapter>(adapter: T, opts: InstrumentOptions | CallObserver | readonly CallObserver[] = {}): T {
  const options: InstrumentOptions = Array.isArray(opts)
    ? { observers: opts as readonly CallObserver[] }
    : 'onCall' in (opts as object)
      ? { observers: [opts as CallObserver] }
      : (opts as InstrumentOptions);
  const observers = options.observers ?? [];
  const faultRegistry = options.faults ?? defaultFaults;
  const untimed = new Set([...UNTIMED_METHODS, ...(options.untimed ?? [])]);
  const { module, driver } = adapter.meta;
  const cache = new Map<PropertyKey, unknown>();

  const emit = (e: PortCallEvent) => {
    for (const o of observers) {
      try {
        o.onCall(e);
      } catch {
        /* 观测失败不影响业务调用 */
      }
    }
  };

  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop === 'symbol' || typeof value !== 'function' || untimed.has(prop)) return value;
      const cached = cache.get(prop);
      if (cached && (cached as { __orig?: unknown }).__orig === value) return cached;
      const original = value as (...args: unknown[]) => unknown;
      const wrapped = function instrumented(this: unknown, ...args: unknown[]): unknown {
        const ctx = currentContext();
        ctx?.path.markIfAbsent(module, driver);
        const t0 = performance.now();
        const finish = (ok: boolean, error?: unknown) => {
          const ms = performance.now() - t0;
          ctx?.timing.add(module, ms);
          emit({
            module, driver, method: prop, ms, ok, ...(error !== undefined ? { error, ...(isClientError(error) ? { clientError: true } : {}) } : {}),
            inRequest: Boolean(ctx),
            ...(ctx?.experiment ? { runId: ctx.experiment.runId, ...(ctx.experiment.label ? { label: ctx.experiment.label } : {}) } : {}),
          });
        };
        const call = () => original.apply(target, args);
        const decision = faultRegistry.beforeCall(module);
        if (decision) {
          ctx?.faults.push(decision.faultId);
          ctx?.path.outcome(module, 'fault');
          const run = async () => {
            if (decision.delayMs) await sleep(decision.delayMs);
            if (decision.error) throw decision.error;
            return call();
          };
          return run().then(
            (r) => { finish(true); return r; },
            (e: unknown) => { finish(false, e); throw e; },
          );
        }
        let result: unknown;
        try {
          result = call();
        } catch (e) {
          finish(false, e);
          throw e;
        }
        if (isPromiseLike(result)) {
          return Promise.resolve(result).then(
            (r) => { finish(true); return r; },
            (e: unknown) => { finish(false, e); throw e; },
          );
        }
        finish(true);
        return result;
      };
      (wrapped as unknown as { __orig: unknown }).__orig = value;
      cache.set(prop, wrapped);
      return wrapped;
    },
  });
}
