/**
 * 检测的发起与在途状态（08 P05.5；04 §5.6、§12）：
 *
 * - 本步：`POST /sessions/{sid}/steps/{stepId}/check-runs {checkIds?, force?}` → `202 {runId}`；整张卡片 / 提交前预览：`POST …/check-runs {scope}`；
 * - 结果以事件 `check_run.completed` 为主路径；事件 10 秒未到时补查 `GET …/check-runs/{runId}`（之后每 5 秒，最长 3 分钟）；
 * - 在途期间对应检查行显示“核验中”；`202` 之后只显示“处理中”，结果以服务端为准（§7.6 第 2 条）。
 */
import type { ApiClient } from '../../api/client';
import { isApiError, type ApiError } from '../../api/errors';
import type { CheckRunView } from '../model/checks';

export interface InflightRun {
  runId: string;
  stepId: string | null;
  scope: 'step' | 'lab' | 'final-preview';
  checkIds: string[] | null;
  startedAt: number;
}

export interface RunnerSnapshot {
  inflight: readonly InflightRun[];
  lastError: ApiError | null;
  /** 最近完成的运行（runId → 完成时刻），用于播报与“刚到达”的淡入。 */
  completed: Readonly<Record<string, number>>;
}

export const FALLBACK_AFTER_MS = 10_000;
export const FALLBACK_EVERY_MS = 5_000;
export const RUN_TIMEOUT_MS = 180_000;

export class CheckRunner {
  private snap: RunnerSnapshot = { inflight: [], lastError: null, completed: {} };
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly doneListeners = new Set<(run: InflightRun, result: CheckRunView | null) => void>();

  constructor(
    private readonly api: Pick<ApiClient, 'call'>,
    private readonly sid: string,
  ) {}

  getSnapshot = (): RunnerSnapshot => this.snap;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  onDone(l: (run: InflightRun, result: CheckRunView | null) => void): () => void {
    this.doneListeners.add(l);
    return () => this.doneListeners.delete(l);
  }

  private set(patch: Partial<RunnerSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  inflightFor(stepId: string): Set<string> | 'all' | null {
    const runs = this.snap.inflight.filter((r) => r.scope !== 'step' || r.stepId === stepId);
    if (!runs.length) return null;
    if (runs.some((r) => r.scope !== 'step' || !r.checkIds)) return 'all';
    return new Set(runs.flatMap((r) => r.checkIds ?? []));
  }

  async runStep(stepId: string, opts: { checkIds?: string[]; force?: boolean } = {}): Promise<string | null> {
    return this.start({ scope: 'step', stepId, checkIds: opts.checkIds ?? null }, () =>
      this.api.call<{ runId: string }>('createStepCheckRun', { params: { sid: this.sid, stepId }, body: { ...(opts.checkIds ? { checkIds: opts.checkIds } : {}), ...(opts.force ? { force: true } : {}) } }),
    );
  }

  async runScope(scope: 'lab' | 'final-preview'): Promise<string | null> {
    return this.start({ scope, stepId: null, checkIds: null }, () => this.api.call<{ runId: string }>('createCheckRun', { params: { sid: this.sid }, body: { scope } }));
  }

  private async start(meta: Omit<InflightRun, 'runId' | 'startedAt'>, call: () => Promise<{ data: { runId: string } | null }>): Promise<string | null> {
    try {
      const r = await call();
      const runId = r.data?.runId;
      if (!runId) return null;
      const run: InflightRun = { ...meta, runId, startedAt: Date.now() };
      this.set({ inflight: [...this.snap.inflight, run], lastError: null });
      this.schedule(run, FALLBACK_AFTER_MS);
      return runId;
    } catch (e) {
      this.set({ lastError: isApiError(e) ? e : null });
      throw e;
    }
  }

  private schedule(run: InflightRun, ms: number): void {
    const t = setTimeout(() => void this.poll(run), ms);
    this.timers.set(run.runId, t);
  }

  private async poll(run: InflightRun): Promise<void> {
    if (!this.snap.inflight.some((r) => r.runId === run.runId)) return;
    try {
      const r = await this.api.call<CheckRunView>('getCheckRun', { params: { sid: this.sid, runId: run.runId }, conditional: false });
      if (r.data && r.data.status === 'done') {
        this.complete(run.runId, r.data);
        return;
      }
    } catch {
      /* 继续补查 */
    }
    if (Date.now() - run.startedAt > RUN_TIMEOUT_MS) {
      this.complete(run.runId, null);
      return;
    }
    this.schedule(run, FALLBACK_EVERY_MS);
  }

  /** 事件 `check_run.completed {runId}` 到达（或补查到 done）。 */
  complete(runId: string, result: CheckRunView | null = null): void {
    const run = this.snap.inflight.find((r) => r.runId === runId);
    const t = this.timers.get(runId);
    if (t) clearTimeout(t);
    this.timers.delete(runId);
    if (!run) return;
    this.set({ inflight: this.snap.inflight.filter((r) => r.runId !== runId), completed: { ...this.snap.completed, [runId]: Date.now() } });
    for (const l of this.doneListeners) l(run, result);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
    this.doneListeners.clear();
  }
}
