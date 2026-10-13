// backend/src/observability/request-context.ts —— 请求上下文（AsyncLocalStorage，总纲 §4.1“请求上下文不进端口签名”）
//
// 请求 ID、管理员身份、X-Compare-Bypass、路径记录器、计时器都放在这里，由 container 给每个适配器套的 instrument 代理读取。
// 模块代码不得自行拼写 X-CloudAlbum-Path / Server-Timing，只能通过 `ctx.path.mark(module, value)` 报告结果（§7）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { BypassKey, ModuleId } from '@cloudalbum/contracts';
import type { Principal } from '../ports/auth.js';

/** 路径记录器：模块 → 段值（`driver[@host][:outcome]`），保持首次调用顺序。 */
export class PathRecorder {
  private readonly segments = new Map<ModuleId, string>();

  /** 设置（或覆盖）某个模块的段值，例如 `mark('cache', 'redis@elasticache:hit')`。顺序保持首次出现的位置。 */
  mark(module: ModuleId, value: string): void {
    this.segments.set(module, value);
  }

  /** 只在该模块尚未出现时设置（instrument 代理用：默认段值 = 驱动名）。 */
  markIfAbsent(module: ModuleId, value: string): void {
    if (!this.segments.has(module)) this.segments.set(module, value);
  }

  /** 给已存在的段追加 / 替换结果部分：`driver[@host]` → `driver[@host]:<outcome>` */
  outcome(module: ModuleId, outcome: string): void {
    const cur = this.segments.get(module);
    if (!cur) return;
    const colon = cur.indexOf(':');
    this.segments.set(module, `${colon === -1 ? cur : cur.slice(0, colon)}:${outcome}`);
  }

  get(module: ModuleId): string | undefined {
    return this.segments.get(module);
  }

  entries(): Array<[ModuleId, string]> {
    return [...this.segments.entries()];
  }
}

/** 计时器：同一模块在一次请求中多次调用时累加（§7.1）。 */
export class TimingRecorder {
  private readonly totals = new Map<ModuleId, { dur: number; count: number }>();

  add(module: ModuleId, ms: number): void {
    const cur = this.totals.get(module) ?? { dur: 0, count: 0 };
    cur.dur += ms;
    cur.count += 1;
    this.totals.set(module, cur);
  }

  entries(): Array<{ module: ModuleId; dur: number; count: number }> {
    return [...this.totals.entries()].map(([module, v]) => ({ module, ...v }));
  }

  /** 端口调用的总耗时（用于计算 `app` = total − 端口耗时） */
  sum(): number {
    let s = 0;
    for (const v of this.totals.values()) s += v.dur;
    return s;
  }
}

export interface ExperimentTag { runId: string; label?: string }

export interface RequestContext {
  requestId: string;
  /** performance.now() 起点 */
  startedAt: number;
  startedAtIso: string;
  method?: string;
  /** 路由模板（例如 /api/photos/:id），由路由层设置，供 LabMetricsStore 分组 */
  route?: string;
  /** Nginx 计算的入口链（$ca_entry） */
  entry?: string;
  path: PathRecorder;
  timing: TimingRecorder;
  bypass: Set<BypassKey>;
  principal?: Principal;
  /** 内部用户 ID（users.id），由认证中间件填写 */
  userId?: string;
  isAdmin: boolean;
  experiment?: ExperimentTag;
  /** 本次请求被注入的故障 id（§8.4） */
  faults: string[];
  /** 其他中间件 / 服务的私有数据 */
  locals: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function createRequestContext(init: Partial<Omit<RequestContext, 'path' | 'timing' | 'bypass' | 'faults' | 'locals'>> = {}): RequestContext {
  return {
    requestId: init.requestId ?? randomUUID(),
    startedAt: init.startedAt ?? performance.now(),
    startedAtIso: init.startedAtIso ?? new Date().toISOString(),
    isAdmin: init.isAdmin ?? false,
    path: new PathRecorder(),
    timing: new TimingRecorder(),
    bypass: new Set(),
    faults: [],
    locals: {},
    ...(init.method ? { method: init.method } : {}),
    ...(init.route ? { route: init.route } : {}),
    ...(init.entry ? { entry: init.entry } : {}),
    ...(init.principal ? { principal: init.principal } : {}),
    ...(init.userId ? { userId: init.userId } : {}),
    ...(init.experiment ? { experiment: init.experiment } : {}),
  };
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** 便捷函数：在请求上下文中报告路径段；请求外（worker、CLI）为空操作。 */
export function markPath(module: ModuleId, value: string): void {
  storage.getStore()?.path.mark(module, value);
}

/** 便捷函数：报告结果（只替换 outcome 部分） */
export function markOutcome(module: ModuleId, outcome: string): void {
  storage.getStore()?.path.outcome(module, outcome);
}

/** 便捷函数：手动记录一段模块耗时（例如 CachePort.wrap 内部的 get / set，instrument 代理不计 wrap 本身） */
export function addTiming(module: ModuleId, ms: number): void {
  storage.getStore()?.timing.add(module, ms);
}

/** 当前请求是否旁路了某个键 */
export function isBypassed(key: BypassKey): boolean {
  return storage.getStore()?.bypass.has(key) ?? false;
}
