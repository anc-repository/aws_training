/**
 * ATL_DEV_MODE wiring of the lifecycle (docs/implementation-notes.md, platform-lifecycle): attaches the dev
 * implementations of the lifecycle cloud ports to a dev runtime, emulates the EventBridge rule `atl-sfn-failed` on the
 * in-process simulator, and gives atl-checks / atl-custom-resources dev fallbacks for the lifecycle's calls while those
 * actions are not implemented. Structurally typed against the dev runtime, so it does not import `src/dev/**`.
 * Dev only: never imported by a production entry (test/lifecycle/prod-isolation.test.ts).
 */
import type { LambdaFunctionName } from '@atl/shared';
import type { FunctionDeps } from '../runtime/deps.js';
import { provideClouds } from '../functions/lifecycle/cloud/registry.js';
import { DevLifecycleCloud, type DevBuildSource, type DevEnvSource } from './lifecycle-cloud.js';
import { DevReclaimCloud } from './reclaim-cloud.js';

export { DevLifecycleCloud } from './lifecycle-cloud.js';
export { DevReclaimCloud, type FakeBehaviour, type FakeResource, type FakeStack } from './reclaim-cloud.js';

type Fn = (payload: unknown) => Promise<unknown>;

/** The parts of `DevRuntime` (src/dev/runtime.ts) used here. */
export interface DevRuntimeLike {
  deps: FunctionDeps;
  envs: DevEnvSource;
  runner?: DevBuildSource;
  functions: Partial<Record<LambdaFunctionName, Fn>>;
  invoker: { register(fn: LambdaFunctionName, handler: Fn): void; invoke<T = unknown>(fn: LambdaFunctionName, payload: unknown): Promise<T> };
  orchestrator: { sim: { addListener(fn: (e: { type: string; executionArn: string; detail?: unknown }) => void): () => void } };
}

export interface LifecycleDevOptions {
  /** emulate `atl-sfn-failed` (default true) */
  sfnFailedRule?: boolean;
  /** dev answers for atl-checks Preflight / RunHealthGate / FinalizeAttempt while they throw Atl.NotImplemented (default true) */
  checksFallback?: boolean;
}

export interface LifecycleDev {
  lifecycle: DevLifecycleCloud;
  reclaim: DevReclaimCloud;
  /** lifecycle invocations triggered by the emulated `atl-sfn-failed` rule, and their errors */
  sfnFailed: { name: string; status: string; error?: string }[];
  roleCleanups: unknown[];
  dispose(): void;
}

const STATUS: Record<string, string> = { ExecutionFailed: 'FAILED', ExecutionTimedOut: 'TIMED_OUT', ExecutionAborted: 'ABORTED' };

const isNotImplemented = (e: unknown) => (e as { name?: string })?.name === 'Atl.NotImplemented';

export function installLifecycleDev(rt: DevRuntimeLike, opts: LifecycleDevOptions = {}): LifecycleDev {
  const lifecycle = new DevLifecycleCloud(rt.envs, rt.runner ?? null);
  const reclaim = new DevReclaimCloud();
  provideClouds(rt.deps, { lifecycle, reclaim });
  const sfnFailed: LifecycleDev['sfnFailed'] = [];
  const roleCleanups: unknown[] = [];

  if (opts.checksFallback !== false) {
    const checks = rt.functions['atl-checks'];
    rt.invoker.register('atl-checks', async (payload) => {
      const action = (payload as { action?: string } | null)?.action;
      try {
        if (!checks) throw Object.assign(new Error('atl-checks missing'), { name: 'Atl.NotImplemented' });
        return await checks(payload);
      } catch (e) {
        if (!isNotImplemented(e)) throw e;
        if (action === 'Preflight') return { result: 'PASS', items: [], warnings: ['dev: account preflight simulated (atl-checks has no Preflight action)'], variant: null };
        if (action === 'RunHealthGate') return { status: 'PASS', report: { dev: true, gates: (payload as { gates?: string[] }).gates ?? [] } };
        if (action === 'FinalizeAttempt') return { finalized: false, dev: true };
        throw e;
      }
    });
    const cr = rt.functions['atl-custom-resources'];
    rt.invoker.register('atl-custom-resources', async (payload) => {
      const action = (payload as { action?: string } | null)?.action;
      try {
        if (!cr) throw Object.assign(new Error('atl-custom-resources missing'), { name: 'Atl.NotImplemented' });
        return await cr(payload);
      } catch (e) {
        if (!isNotImplemented(e) || action !== 'UninstallRoleCleanup') throw e;
        roleCleanups.push(payload);
        return { dev: true, outcome: (payload as { outcome?: string }).outcome ?? null };
      }
    });
  }

  let unsubscribe: () => void = () => undefined;
  if (opts.sfnFailedRule !== false) {
    unsubscribe = rt.orchestrator.sim.addListener((e) => {
      const status = STATUS[e.type];
      if (!status) return;
      const m = /:execution:(atl-[a-z-]+):([A-Za-z0-9_-]+)$/.exec(e.executionArn);
      if (!m) return;
      const rec: LifecycleDev['sfnFailed'][number] = { name: m[2]!, status };
      sfnFailed.push(rec);
      const detail = e.detail as { error?: string; cause?: string } | undefined;
      setImmediate(() => {
        rt.invoker
          .invoke('atl-lifecycle', {
            'detail-type': 'Step Functions Execution Status Change',
            detail: { executionArn: e.executionArn, name: m[2], stateMachineArn: m[1], status, error: detail?.error ?? null, cause: detail?.cause ?? null },
          })
          .catch((err: unknown) => {
            rec.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          });
      });
    });
  }

  return { lifecycle, reclaim, sfnFailed, roleCleanups, dispose: () => unsubscribe() };
}
