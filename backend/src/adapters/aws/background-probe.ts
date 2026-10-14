// backend/src/adapters/aws/background-probe.ts —— 探针的后台刷新（stale-while-revalidate；wave1-fix）
//
// 背景：能力注册表的常规探针总预算是 2 秒（深度探针与 cli probe 是 5 秒），而 withAwsRetry 单次超时 3 秒、最多 3 次。
// 探针直接 await withAwsRetry 时，只要首个请求慢，外层 ProbeTimeoutError 一定先触发，内部重试从来跑不到；api 重启后的最初
// 一两分钟（IMDS 凭证获取、SDK 首个 TLS 握手，2026-10-14 实机验证的教训）就会被连续记为失败。
//
// 做法（与 shell-access、logging 的后台刷新一致）：
//   - 控制面读取（整个“慢探针”函数）放进后台 Promise，带完整的 withAwsRetry；探针最多等 budgetMs（常规 1.5 秒、深度 4 秒）；
//   - 预算内拿到结果 → 原样返回；
//   - 没拿到 → 返回上一次完成的结果（不超过 maxStaleMs，detail 注明“显示 n 秒前的结果”），没有上一次结果时返回
//     degraded + transient（“正在查询…”），由能力注册表的状态机决定何时升级为 error；
//   - 后台调用晚到的结果记为“上一次结果”，下一轮探针即可使用；同一时刻每种探针（常规 / 深度）最多一个后台调用，
//     超过 maxInflightMs 仍未结束的调用视为挂起、不再等待。
import type { ProbeResult } from '../../ports/common.js';
import { describeAwsError, isAwsTransient } from './clients.js';

export const PROBE_BUDGET_MS = 1500;
export const DEEP_PROBE_BUDGET_MS = 4000;
const MAX_STALE_MS = 120_000;
const MAX_INFLIGHT_MS = 60_000;

export interface BackgroundProbeOptions {
  /** 写进 detail 的名称，例如 “SES 控制面” */
  label: string;
  budgetMs?: number;
  deepBudgetMs?: number;
  maxStaleMs?: number;
  maxInflightMs?: number;
  now?: () => number;
}

interface Inflight { p: Promise<ProbeResult>; startedAt: number }

/** 慢探针函数抛出的异常 → ProbeResult（瞬时错误为 degraded + transient） */
export function probeResultFromError(e: unknown, label: string): ProbeResult {
  return isAwsTransient(e)
    ? { status: 'degraded', transient: true, confidence: 'observed', detail: `${label}暂时不可达（将重试）：${describeAwsError(e)}` }
    : { status: 'error', confidence: 'observed', detail: `${label}查询失败：${describeAwsError(e)}` };
}

export class BackgroundProbe {
  private readonly inflight: { normal?: Inflight; deep?: Inflight } = {};
  private last: { at: number; result: ProbeResult } | undefined;

  constructor(private readonly opts: BackgroundProbeOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** 最近一次完成的结果（测试与诊断用） */
  lastResult(): ProbeResult | undefined {
    return this.last?.result;
  }

  async run(fn: () => Promise<ProbeResult>, opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const key = opts.deep ? 'deep' : 'normal';
    let cur = this.inflight[key];
    if (cur && this.now() - cur.startedAt > (this.opts.maxInflightMs ?? MAX_INFLIGHT_MS)) cur = undefined;   // 挂起的调用不再等待
    if (!cur) {
      const entry: Inflight = { startedAt: this.now(), p: Promise.resolve(undefined as unknown as ProbeResult) };
      entry.p = fn()
        .catch((e: unknown) => probeResultFromError(e, this.opts.label))
        .then((r) => {
          this.last = { at: this.now(), result: r };
          return r;
        })
        .finally(() => {
          if (this.inflight[key] === entry) delete this.inflight[key];
        });
      this.inflight[key] = entry;
      cur = entry;
    }
    const budget = opts.deep ? (this.opts.deepBudgetMs ?? DEEP_PROBE_BUDGET_MS) : (this.opts.budgetMs ?? PROBE_BUDGET_MS);
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      cur.p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budget);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (settled) return settled;

    const last = this.last;
    const age = last ? this.now() - last.at : Infinity;
    if (last && age < (this.opts.maxStaleMs ?? MAX_STALE_MS)) {
      const sec = Math.max(0, Math.round(age / 1000));
      return {
        ...last.result,
        detail: `${last.result.detail}（${this.opts.label}本轮查询仍在进行：显示 ${sec} 秒前的结果）`,
        data: { ...(last.result.data ?? {}), staleMs: Math.round(age) },
      };
    }
    return {
      status: 'degraded', transient: true, confidence: 'inferred',
      detail: `正在查询 ${this.opts.label}（首次请求较慢，后台继续，下一轮探针给出结论）`,
    };
  }
}
