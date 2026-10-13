// backend/src/observability/faults.ts —— 共享故障注入设施（总纲 §8.4）
//
// POST /api/lab/faults 的请求体如 {"type":"error5xx","rate":0.2,"durationSec":120}、
// {"type":"latency","target":"database","ms":300,"rate":0.3,"durationSec":600}、{"type":"mem","durationSec":300}。
// 总开关是运行时配置 featureFlags['lab.faults']（默认关闭）；每个故障必须带 durationSec 并自动过期；
// 被注入故障的请求在路径头对应模块段的 outcome 中带 `fault`。本注册表只在进程内（每个 api / worker 进程各一份）。
import { randomUUID } from 'node:crypto';
import { isModuleId, type ModuleId } from '@cloudalbum/contracts';

export type FaultType = 'error5xx' | 'latency' | 'error' | 'mem';

export interface FaultSpec {
  type: FaultType;
  /** latency / error 的目标模块；error5xx 为整个请求 */
  target?: ModuleId;
  /** 命中概率 0..1（默认 1） */
  rate?: number;
  /** latency 的毫秒数 */
  ms?: number;
  durationSec: number;
}

export interface ActiveFault extends Required<Pick<FaultSpec, 'type' | 'durationSec'>> {
  id: string;
  target?: ModuleId;
  rate: number;
  ms?: number;
  createdAt: string;
  expiresAt: string;
}

export class FaultInjectedError extends Error {
  readonly code = 'FAULT_INJECTED';
  readonly status = 503;
  constructor(readonly faultId: string, readonly module?: ModuleId) {
    super(`实验故障注入（${faultId}${module ? ` · ${module}` : ''}）`);
    this.name = 'FaultInjectedError';
  }
}

export interface FaultDecision { faultId: string; delayMs?: number; error?: FaultInjectedError }

export class FaultRegistry {
  private readonly faults = new Map<string, ActiveFault & { expiresAtMs: number }>();
  private memBallast: Buffer[] = [];

  constructor(private readonly random: () => number = Math.random, private readonly now: () => number = Date.now) {}

  add(spec: FaultSpec): ActiveFault {
    if (!Number.isFinite(spec.durationSec) || spec.durationSec <= 0 || spec.durationSec > 3600) {
      throw new RangeError('durationSec 必须在 1～3600 之间（每个故障都会自动过期）');
    }
    if ((spec.type === 'latency' || spec.type === 'error') && (!spec.target || !isModuleId(spec.target))) {
      throw new RangeError(`${spec.type} 故障必须指定 target 模块`);
    }
    const id = `fault-${randomUUID().slice(0, 8)}`;
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + spec.durationSec * 1000;
    const fault = {
      id, type: spec.type, durationSec: spec.durationSec, rate: Math.min(1, Math.max(0, spec.rate ?? 1)),
      ...(spec.target ? { target: spec.target } : {}),
      ...(spec.ms !== undefined ? { ms: spec.ms } : {}),
      createdAt: new Date(createdAtMs).toISOString(), expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs,
    };
    this.faults.set(id, fault);
    if (spec.type === 'mem') this.memBallast.push(Buffer.alloc(64 * 1024 * 1024, 1));
    return this.strip(fault);
  }

  remove(id: string): boolean {
    const f = this.faults.get(id);
    if (f?.type === 'mem') this.memBallast = [];
    return this.faults.delete(id);
  }

  clear(): void {
    this.faults.clear();
    this.memBallast = [];
  }

  list(): ActiveFault[] {
    this.expire();
    return [...this.faults.values()].map((f) => this.strip(f));
  }

  get active(): boolean {
    this.expire();
    return this.faults.size > 0;
  }

  /** 端口调用前调用（instrument 代理）：返回要注入的延迟或错误 */
  beforeCall(module: ModuleId): FaultDecision | null {
    this.expire();
    for (const f of this.faults.values()) {
      if (f.target !== module) continue;
      if (this.random() >= f.rate) continue;
      if (f.type === 'latency') return { faultId: f.id, delayMs: f.ms ?? 300 };
      if (f.type === 'error') return { faultId: f.id, error: new FaultInjectedError(f.id, module) };
    }
    return null;
  }

  /** 请求级故障（error5xx）：http 层在路由前调用 */
  beforeRequest(): FaultDecision | null {
    this.expire();
    for (const f of this.faults.values()) {
      if (f.type !== 'error5xx') continue;
      if (this.random() < f.rate) return { faultId: f.id, error: new FaultInjectedError(f.id) };
    }
    return null;
  }

  private expire(): void {
    const now = this.now();
    for (const [id, f] of this.faults) {
      if (f.expiresAtMs <= now) {
        this.faults.delete(id);
        if (f.type === 'mem') this.memBallast = [];
      }
    }
  }

  private strip(f: ActiveFault & { expiresAtMs: number }): ActiveFault {
    const { expiresAtMs: _ignored, ...rest } = f;
    return rest;
  }
}

/** 进程内单例（api 与 worker 各一份） */
export const faults = new FaultRegistry();
