/**
 * experiments/_lib/scenario.ts —— 场景脚本的接口。
 *
 * 每个 `<module>/<scenario>.ts` 默认导出 `defineScenario({ run, warmup? })`。运行器构造 `ScenarioContext`：
 * 已登记的 runId、带实验头的 HTTP 客户端、capabilities 快照、参数、采集器、中止信号与时长。
 * 场景只负责“发请求 + 计算本场景特有的发现（findings）与业务指标（business）”；延迟分布、路径头、Server-Timing
 * 由客户端自动采集，服务端指标由运行器在结束后统一拉取。
 */
import type { BypassKey } from '@cloudalbum/contracts';
import type { ExpClient } from './http.js';
import type { Recorder } from './stats.js';
import type { Capabilities, ExperimentDef } from './types.js';

export type ParamValue = string | number | boolean;

export interface ScenarioContext {
  module: string;
  experiment: ExperimentDef;
  /** 基础标签（before / after / l0 …） */
  label: string;
  runId: string;
  /** 目标基址（APP_BASE_URL） */
  target: string;
  phase: 'warmup' | 'measure';
  vus: number;
  durationMs: number;
  /** 第几轮（--repeat，从 1 开始） */
  repeat: number;
  /** 阶段标签（`--vus 10,50` 时为 `vus=10`） */
  stage?: string;
  /** 是否开启 A/B 交替 */
  ab: boolean;
  abBypass?: BypassKey;
  params: Record<string, ParamValue>;
  capabilities: Capabilities;
  /** 指向目标、带管理员令牌与实验头的客户端 */
  client: ExpClient;
  /** 指向其他基址的客户端（CDN 域名、S3 预签名 URL…）；auth=false 时不带令牌，experiment=false 时不带实验头 */
  http(base: string, opts?: { target?: string; auth?: boolean; experiment?: boolean; token?: string }): ExpClient;
  recorder: Recorder;
  signal: AbortSignal;
  log(message: string): void;
  /** 记录本场景的发现（写入结果的 scenario.findings） */
  finding(key: string, value: unknown): void;
  /** 记录业务指标（写入结果的 server.business，供 `biz.*` 指标引用） */
  business(key: string, value: number | undefined): void;
  note(text: string): void;
  /** 结束后需要清理的资源（运行器先尝试 experiment.cleanup，失败时逐个调用这些请求） */
  cleanupLater(method: string, path: string): void;
  /** 从测量阶段开始经过的毫秒数 */
  elapsedMs(): number;
  /** 测量阶段剩余毫秒数 */
  remainingMs(): number;
  /** 管理员凭据（login 类场景用；可能不存在） */
  credentials?: { email: string; password: string };
}

export interface ScenarioModule {
  /** 可选：预热（不计入结果、不带实验头）。缺省时运行器以 phase='warmup' 调用 run。 */
  warmup?(ctx: ScenarioContext): Promise<void>;
  run(ctx: ScenarioContext): Promise<void>;
  /** 预热是否复用 run（缺省 true）；只读 / 功能型场景设为 false 即跳过预热 */
  warmupWithRun?: boolean;
}

export function defineScenario(s: ScenarioModule): ScenarioModule {
  return s;
}

/** 读取数值参数（字符串也接受）。 */
export function numParam(ctx: Pick<ScenarioContext, 'params'>, key: string, fallback: number): number {
  const v = ctx.params[key];
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function strParam(ctx: Pick<ScenarioContext, 'params'>, key: string, fallback: string): string {
  const v = ctx.params[key];
  return v === undefined || v === '' ? fallback : String(v);
}

export function boolParam(ctx: Pick<ScenarioContext, 'params'>, key: string, fallback: boolean): boolean {
  const v = ctx.params[key];
  if (v === undefined || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
