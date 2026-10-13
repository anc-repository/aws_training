/**
 * In-process Step Functions simulator (ATL_DEV_MODE=1): interprets the same ASL files that are deployed
 * (`platform/workflows/statemachines/*.asl.json`, JSONPath query language) with pluggable task integrations, a pluggable
 * clock (scaled dev time) and fault injection.
 *
 * Supported: Task (lambda:invoke, codebuild:startBuild.sync, states:startExecution[.sync:2], aws-sdk:sfn:stopExecution,
 * plus any resource registered in `integrations`), Pass, Choice, Wait, Succeed, Fail, Parallel, Map (inline); InputPath,
 * Parameters, ResultSelector, ResultPath, OutputPath, ItemsPath, ItemSelector; intrinsic functions; Retry (IntervalSeconds,
 * MaxAttempts, BackoffRate, MaxDelaySeconds, JitterStrategy) and Catch; TimeoutSeconds(/Path) on tasks and executions;
 * deterministic execution names with the `ExecutionAlreadyExists` rules of 02 §2.7.
 * Not supported (rejected by the structural validator or ignored): JSONata, Assign/variables, activities,
 * `.waitForTaskToken` (not used by ATL), HeartbeatSeconds, distributed Map.
 */
import { PortError, type ExecutionDescription, type ExecutionStatus, type StateMachineName } from '@atl/shared';
import type { AslCatcher, AslChoiceRule, AslDefinition, AslRetrier, AslState, AslSubMachine } from '../asl/types.js';
import { ASL_RESOURCES } from '../asl/types.js';
import { errorMatches, StatesError, toStatesError } from './errors.js';
import { evalIntrinsic, isIntrinsic } from './intrinsics.js';
import { pathExists, readPath, writePath } from './jsonpath.js';

export interface SimClock {
  nowMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface TaskInvocation {
  resource: string;
  parameters: unknown;
  stateName: string;
  stateMachine: string;
  executionArn: string;
  executionName: string;
  /** 0 on the first attempt, then the number of retries so far. */
  attempt: number;
  signal: AbortSignal;
}

export type TaskHandler = (inv: TaskInvocation) => Promise<unknown>;

export interface BuildOutcome {
  status: 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'TIMED_OUT' | 'STOPPED';
  build: Record<string, unknown>;
}

export interface FaultSpec {
  /** State name (in any state machine unless `stateMachine` is set). */
  state: string;
  stateMachine?: string;
  /** Error name to throw, e.g. `Lambda.ServiceException`, `Atl.LockBusy`, `States.TaskFailed`. */
  error: string;
  cause?: string;
  /** How many times to inject (default 1). */
  times?: number;
}

export interface HistoryEvent {
  at: number;
  type:
    | 'ExecutionStarted'
    | 'ExecutionSucceeded'
    | 'ExecutionFailed'
    | 'ExecutionAborted'
    | 'ExecutionTimedOut'
    | 'StateEntered'
    | 'StateExited'
    | 'TaskFailed'
    | 'TaskRetried'
    | 'FaultInjected'
    | 'CatchMatched';
  executionArn: string;
  state?: string;
  detail?: unknown;
}

export interface SimulatorOptions {
  clock: SimClock;
  /** ASL definitions by state machine name. */
  definitions: Partial<Record<string, AslDefinition>>;
  /** CloudFormation `DefinitionSubstitutions` (`${Name}` → value) applied to every string of the definitions. */
  substitutions?: Record<string, string>;
  /** Extra / overriding integrations, keyed by resource ARN (after substitution). */
  integrations?: Record<string, TaskHandler>;
  /** Backend of `arn:aws:states:::lambda:invoke` (FunctionName → result payload). Errors propagate with their `name`. */
  invokeLambda?: (functionName: string, payload: unknown, inv: TaskInvocation) => Promise<unknown>;
  /** Backend of `arn:aws:states:::codebuild:startBuild.sync` (runs to completion). */
  runBuild?: (params: Record<string, unknown>, inv: TaskInvocation) => Promise<BuildOutcome>;
  faults?: FaultSpec[];
  region?: string;
  accountId?: string;
  onEvent?: (e: HistoryEvent) => void;
  /** Deterministic jitter in tests (0..1). Defaults to Math.random. */
  random?: () => number;
}

interface ExecRecord {
  arn: string;
  name: string;
  stateMachine: string;
  input: unknown;
  inputKey: string;
  status: ExecutionStatus;
  output?: unknown;
  error?: string;
  cause?: string;
  startMs: number;
  stopMs?: number;
  abort: AbortController;
  done: Promise<void>;
}

interface RunCtx {
  exec: ExecRecord;
  signal: AbortSignal;
  mapItem?: { Index: number; Value: unknown };
}

const DEFAULT_RETRY = { IntervalSeconds: 1, MaxAttempts: 3, BackoffRate: 2 };

export class StepFunctionsSimulator {
  private readonly executions = new Map<string, ExecRecord>();
  private readonly defs = new Map<string, AslDefinition>();
  private readonly faults: (FaultSpec & { remaining: number })[];
  private readonly listeners = new Set<(e: HistoryEvent) => void>();
  readonly history: HistoryEvent[] = [];
  private readonly region: string;
  private readonly accountId: string;

  constructor(private readonly opts: SimulatorOptions) {
    this.region = opts.region ?? 'ap-northeast-1';
    this.accountId = opts.accountId ?? '000000000000';
    for (const [name, def] of Object.entries(opts.definitions)) {
      if (def) this.defs.set(name, substitute(def, opts.substitutions ?? {}) as AslDefinition);
    }
    this.faults = (opts.faults ?? []).map((f) => ({ ...f, remaining: f.times ?? 1 }));
  }

  /**
   * Subscribe to history events (dev: emulates the EventBridge rule `atl-sfn-failed` on execution status changes,
   * 01 §3.3). Returns an unsubscribe function. Listener errors are ignored.
   */
  addListener(fn: (e: HistoryEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Add a fault at run time (dev server / tests). */
  injectFault(f: FaultSpec): void {
    this.faults.push({ ...f, remaining: f.times ?? 1 });
  }

  stateMachineArn(name: string): string {
    return `arn:aws:states:${this.region}:${this.accountId}:stateMachine:${name}`;
  }

  executionArn(stateMachine: string, name: string): string {
    return `arn:aws:states:${this.region}:${this.accountId}:execution:${stateMachine}:${name}`;
  }

  /** Start an execution (does not wait). Same name+input while RUNNING returns the running one; otherwise ExecutionAlreadyExists. */
  startExecution(stateMachine: string, name: string, input: unknown): { executionArn: string; startDate: string } {
    const def = this.defs.get(stateMachine);
    if (!def) throw new PortError('NotFound', `state machine not defined in the simulator: ${stateMachine}`);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new PortError('InvalidInput', `invalid execution name: ${name}`);
    const arn = this.executionArn(stateMachine, name);
    const inputKey = JSON.stringify(input ?? {});
    const existing = this.executions.get(arn);
    if (existing) {
      if (existing.status === 'RUNNING' && existing.inputKey === inputKey) {
        return { executionArn: arn, startDate: new Date(existing.startMs).toISOString() };
      }
      throw new PortError('ExecutionAlreadyExists', `execution already exists: ${arn}`);
    }
    const rec: ExecRecord = {
      arn,
      name,
      stateMachine,
      input: structuredClone(input ?? {}),
      inputKey,
      status: 'RUNNING',
      startMs: this.opts.clock.nowMs(),
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.executions.set(arn, rec);
    this.emit({ type: 'ExecutionStarted', executionArn: arn, detail: { stateMachine, input } });
    rec.done = this.runExecution(rec, def);
    return { executionArn: arn, startDate: new Date(rec.startMs).toISOString() };
  }

  describeExecution(arn: string): ExecutionDescription {
    const r = this.executions.get(arn);
    if (!r) throw new PortError('ExecutionDoesNotExist', `execution does not exist: ${arn}`);
    return {
      executionArn: r.arn,
      stateMachine: r.stateMachine as StateMachineName,
      name: r.name,
      status: r.status,
      input: r.input,
      ...(r.output === undefined ? {} : { output: r.output }),
      ...(r.error === undefined ? {} : { error: r.error }),
      ...(r.cause === undefined ? {} : { cause: r.cause }),
      startDate: new Date(r.startMs).toISOString(),
      ...(r.stopMs === undefined ? {} : { stopDate: new Date(r.stopMs).toISOString() }),
    };
  }

  /** Wait until the execution has finished and return its description. */
  async waitFor(arn: string): Promise<ExecutionDescription> {
    const r = this.executions.get(arn);
    if (!r) throw new PortError('ExecutionDoesNotExist', `execution does not exist: ${arn}`);
    await r.done;
    return this.describeExecution(arn);
  }

  /** Run to completion (start + wait). */
  async run(stateMachine: string, name: string, input: unknown): Promise<ExecutionDescription> {
    const { executionArn } = this.startExecution(stateMachine, name, input);
    return this.waitFor(executionArn);
  }

  stopExecution(arn: string, opts: { error?: string; cause?: string } = {}): void {
    const r = this.executions.get(arn);
    if (!r) throw new PortError('ExecutionDoesNotExist', `execution does not exist: ${arn}`);
    if (r.status !== 'RUNNING') return;
    r.status = 'ABORTED';
    r.error = opts.error;
    r.cause = opts.cause;
    r.stopMs = this.opts.clock.nowMs();
    r.abort.abort(new StatesError('States.Aborted', opts.cause ?? 'stopped'));
    this.emit({ type: 'ExecutionAborted', executionArn: arn });
  }

  listExecutions(): ExecutionDescription[] {
    return [...this.executions.keys()].map((a) => this.describeExecution(a));
  }

  // -------------------------------------------------------------------------------------------------------------

  private emit(e: Omit<HistoryEvent, 'at'>): void {
    const ev = { ...e, at: this.opts.clock.nowMs() };
    this.history.push(ev);
    this.opts.onEvent?.(ev);
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // a dev listener must not break the execution
      }
    }
  }

  private async runExecution(rec: ExecRecord, def: AslDefinition): Promise<void> {
    const ctx: RunCtx = { exec: rec, signal: rec.abort.signal };
    try {
      const run = this.runMachine(def, rec.input, ctx);
      const output = def.TimeoutSeconds
        ? await this.withTimeout(run, def.TimeoutSeconds * 1000, rec.abort.signal)
        : await run;
      if (rec.status !== 'RUNNING') return;
      rec.status = 'SUCCEEDED';
      rec.output = output;
      rec.stopMs = this.opts.clock.nowMs();
      this.emit({ type: 'ExecutionSucceeded', executionArn: rec.arn, detail: output });
    } catch (e) {
      if (rec.status !== 'RUNNING') return; // aborted
      const err = toStatesError(e);
      rec.stopMs = this.opts.clock.nowMs();
      rec.error = err.error;
      rec.cause = err.cause_;
      if (err.error === 'States.Timeout' && (e as { executionTimeout?: boolean }).executionTimeout) {
        rec.status = 'TIMED_OUT';
        rec.abort.abort(err);
        this.emit({ type: 'ExecutionTimedOut', executionArn: rec.arn });
      } else {
        rec.status = 'FAILED';
        this.emit({ type: 'ExecutionFailed', executionArn: rec.arn, detail: { error: err.error, cause: err.cause_ } });
      }
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
    const timer = new AbortController();
    const onAbort = () => timer.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([
        p,
        this.opts.clock.sleep(ms, timer.signal).then(() => {
          const e = new StatesError('States.Timeout', `execution timed out after ${ms / 1000}s`);
          (e as unknown as { executionTimeout: boolean }).executionTimeout = true;
          throw e;
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      timer.abort();
    }
  }

  private context(ctx: RunCtx, stateName: string, enteredMs: number, retryCount: number): Record<string, unknown> {
    const c: Record<string, unknown> = {
      Execution: {
        Id: ctx.exec.arn,
        Name: ctx.exec.name,
        Input: ctx.exec.input,
        StartTime: new Date(ctx.exec.startMs).toISOString(),
        RoleArn: `arn:aws:iam::${this.accountId}:role/ATLOrchestratorRole`,
      },
      StateMachine: { Id: this.stateMachineArn(ctx.exec.stateMachine), Name: ctx.exec.stateMachine },
      State: { Name: stateName, EnteredTime: new Date(enteredMs).toISOString(), RetryCount: retryCount },
    };
    if (ctx.mapItem) c.Map = { Item: ctx.mapItem };
    return c;
  }

  private async runMachine(m: AslSubMachine, input: unknown, ctx: RunCtx): Promise<unknown> {
    let name = m.StartAt;
    let data = input;
    for (let steps = 0; ; steps++) {
      if (steps > 25_000) throw new StatesError('States.Runtime', 'too many state transitions (25000)');
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new StatesError('States.Aborted', 'aborted');
      const state = m.States[name];
      if (!state) throw new StatesError('States.Runtime', `no such state: ${name}`);
      this.emit({ type: 'StateEntered', executionArn: ctx.exec.arn, state: name, detail: data });
      const r = await this.runState(name, state, data, ctx);
      this.emit({ type: 'StateExited', executionArn: ctx.exec.arn, state: name, detail: r.output });
      data = r.output;
      if (r.next === null) return data;
      name = r.next;
    }
  }

  private async runState(name: string, s: AslState, rawInput: unknown, ctx: RunCtx): Promise<{ output: unknown; next: string | null }> {
    const entered = this.opts.clock.nowMs();
    const nextOf = (st: AslState): string | null => (st.End ? null : (st.Next ?? null));
    const ctxObj = (retry = 0) => this.context(ctx, name, entered, retry);
    const effective = s.InputPath === null ? {} : s.InputPath ? readPath(s.InputPath, rawInput, ctxObj()) : rawInput;
    const output = (v: unknown) => (s.OutputPath === null ? {} : s.OutputPath ? readPath(s.OutputPath, v, ctxObj()) : v);

    switch (s.Type) {
      case 'Pass': {
        const params = s.Parameters !== undefined ? applyTemplate(s.Parameters, effective, ctxObj()) : effective;
        const result = s.Result !== undefined ? structuredClone(s.Result) : params;
        return { output: output(applyResultPath(s.ResultPath, rawInput, result)), next: nextOf(s) };
      }
      case 'Succeed':
        return { output: output(effective), next: null };
      case 'Fail': {
        const error = s.ErrorPath ? String(readPath(s.ErrorPath, effective, ctxObj())) : (s.Error ?? 'States.Fail');
        const cause = s.CausePath ? String(readPath(s.CausePath, effective, ctxObj())) : (s.Cause ?? '');
        throw new StatesError(error, cause);
      }
      case 'Choice': {
        for (const rule of s.Choices ?? []) {
          if (evalRule(rule, effective, ctxObj())) return { output: output(effective), next: rule.Next! };
        }
        if (s.Default) return { output: output(effective), next: s.Default };
        throw new StatesError('States.NoChoiceMatched', `no choice rule matched in ${name}`);
      }
      case 'Wait': {
        let ms: number;
        if (s.Seconds !== undefined) ms = s.Seconds * 1000;
        else if (s.SecondsPath) ms = Number(readPath(s.SecondsPath, effective, ctxObj())) * 1000;
        else {
          const ts = s.Timestamp ?? String(readPath(s.TimestampPath!, effective, ctxObj()));
          const at = Date.parse(ts);
          if (Number.isNaN(at)) throw new StatesError('States.Runtime', `invalid timestamp ${ts}`);
          ms = at - this.opts.clock.nowMs();
        }
        if (!Number.isFinite(ms)) throw new StatesError('States.Runtime', `invalid wait in ${name}`);
        if (ms > 0) await this.opts.clock.sleep(ms, ctx.signal);
        return { output: output(effective), next: nextOf(s) };
      }
      case 'Task':
      case 'Parallel':
      case 'Map':
        return this.runWithRetry(name, s, rawInput, effective, ctx, entered, output, nextOf(s));
    }
  }

  private async runWithRetry(
    name: string,
    s: AslState,
    rawInput: unknown,
    effective: unknown,
    ctx: RunCtx,
    entered: number,
    output: (v: unknown) => unknown,
    next: string | null,
  ): Promise<{ output: unknown; next: string | null }> {
    const retriers: AslRetrier[] = Array.isArray(s.Retry) ? s.Retry : [];
    const counts = retriers.map(() => 0);
    let attempt = 0;
    for (;;) {
      try {
        const ctxObj = this.context(ctx, name, entered, attempt);
        const result = await this.execute(name, s, effective, ctx, ctxObj, attempt);
        const selected = s.ResultSelector !== undefined ? applyTemplate(s.ResultSelector, result, ctxObj) : result;
        return { output: output(applyResultPath(s.ResultPath, rawInput, selected)), next };
      } catch (e) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
        const err = toStatesError(e);
        this.emit({ type: 'TaskFailed', executionArn: ctx.exec.arn, state: name, detail: { error: err.error, cause: err.cause_, attempt } });
        const ri = retriers.findIndex((r) => errorMatches(r.ErrorEquals, err.error));
        if (ri >= 0) {
          const r = retriers[ri]!;
          const max = r.MaxAttempts ?? DEFAULT_RETRY.MaxAttempts;
          if (counts[ri]! < max) {
            const base = (r.IntervalSeconds ?? DEFAULT_RETRY.IntervalSeconds) * (r.BackoffRate ?? DEFAULT_RETRY.BackoffRate) ** counts[ri]!;
            let delay = r.MaxDelaySeconds !== undefined ? Math.min(base, r.MaxDelaySeconds) : base;
            if (r.JitterStrategy === 'FULL') delay = delay * (this.opts.random ?? Math.random)();
            counts[ri]!++;
            attempt++;
            this.emit({ type: 'TaskRetried', executionArn: ctx.exec.arn, state: name, detail: { error: err.error, attempt, delaySeconds: delay } });
            await this.opts.clock.sleep(delay * 1000, ctx.signal);
            continue;
          }
        }
        const catcher = (Array.isArray(s.Catch) ? s.Catch : []).find((c: AslCatcher) => errorMatches(c.ErrorEquals, err.error));
        if (catcher) {
          this.emit({ type: 'CatchMatched', executionArn: ctx.exec.arn, state: name, detail: { error: err.error, next: catcher.Next } });
          const errOut = { Error: err.error, Cause: err.cause_ };
          return { output: applyResultPath(catcher.ResultPath, rawInput, errOut), next: catcher.Next };
        }
        throw err;
      }
    }
  }

  private async execute(name: string, s: AslState, effective: unknown, ctx: RunCtx, ctxObj: Record<string, unknown>, attempt: number): Promise<unknown> {
    if (s.Type === 'Parallel') {
      const params = s.Parameters !== undefined ? applyTemplate(s.Parameters, effective, ctxObj) : effective;
      const child = linkedAbort(ctx.signal);
      try {
        return await Promise.all(
          (s.Branches ?? []).map((b) =>
            this.runMachine(b, structuredClone(params), { ...ctx, signal: child.signal }).catch((e) => {
              child.abort(e);
              throw e;
            }),
          ),
        );
      } finally {
        child.dispose();
      }
    }
    if (s.Type === 'Map') {
      const items = readPath(s.ItemsPath ?? '$', effective, ctxObj);
      if (!Array.isArray(items)) throw new StatesError('States.Runtime', `ItemsPath of ${name} is not an array`);
      const proc = (s.ItemProcessor ?? s.Iterator)!;
      const selector = s.ItemSelector ?? s.Parameters;
      const limit = s.MaxConcurrency && s.MaxConcurrency > 0 ? s.MaxConcurrency : items.length || 1;
      const results: unknown[] = new Array(items.length);
      const child = linkedAbort(ctx.signal);
      let cursor = 0;
      const worker = async () => {
        while (cursor < items.length) {
          const i = cursor++;
          const mapItem = { Index: i, Value: items[i] };
          const itemCtx = { ...ctxObj, Map: { Item: mapItem } };
          const itemInput = selector !== undefined ? applyTemplate(selector, effective, itemCtx) : structuredClone(items[i]);
          results[i] = await this.runMachine(proc, itemInput, { ...ctx, signal: child.signal, mapItem });
        }
      };
      try {
        await Promise.all(
          Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () =>
            worker().catch((e) => {
              child.abort(e);
              throw e;
            }),
          ),
        );
      } finally {
        child.dispose();
      }
      return results;
    }

    // Task
    const resource = s.Resource!;
    const parameters = s.Parameters !== undefined ? applyTemplate(s.Parameters, effective, ctxObj) : effective;
    const fault = this.faults.find((f) => f.remaining > 0 && f.state === name && (!f.stateMachine || f.stateMachine === ctx.exec.stateMachine));
    if (fault) {
      fault.remaining--;
      this.emit({ type: 'FaultInjected', executionArn: ctx.exec.arn, state: name, detail: { error: fault.error } });
      throw new StatesError(fault.error, fault.cause ?? 'injected fault');
    }
    const timeoutS = s.TimeoutSecondsPath ? Number(readPath(s.TimeoutSecondsPath, effective, ctxObj)) : s.TimeoutSeconds;
    const child = linkedAbort(ctx.signal);
    const inv: TaskInvocation = {
      resource,
      parameters,
      stateName: name,
      stateMachine: ctx.exec.stateMachine,
      executionArn: ctx.exec.arn,
      executionName: ctx.exec.name,
      attempt,
      signal: child.signal,
    };
    try {
      const call = this.dispatch(inv);
      if (!timeoutS || !Number.isFinite(timeoutS) || timeoutS <= 0) return await call;
      return await Promise.race([
        call,
        this.opts.clock.sleep(timeoutS * 1000, child.signal).then(() => {
          throw new StatesError('States.Timeout', `task ${name} timed out after ${timeoutS}s`);
        }),
      ]);
    } finally {
      child.abort(new StatesError('States.Aborted', 'task finished'));
      child.dispose();
    }
  }

  private async dispatch(inv: TaskInvocation): Promise<unknown> {
    const custom = this.opts.integrations?.[inv.resource];
    if (custom) return custom(inv);
    const p = (inv.parameters ?? {}) as Record<string, unknown>;
    switch (inv.resource) {
      case ASL_RESOURCES.lambdaInvoke: {
        if (!this.opts.invokeLambda) throw new StatesError('States.Runtime', 'no lambda backend configured');
        const fn = String(p.FunctionName ?? '');
        const payload = await this.opts.invokeLambda(fn, p.Payload ?? null, inv);
        return { ExecutedVersion: '$LATEST', Payload: payload ?? null, StatusCode: 200 };
      }
      case ASL_RESOURCES.codebuildStartBuildSync: {
        if (!this.opts.runBuild) throw new StatesError('States.Runtime', 'no codebuild backend configured');
        const r = await this.opts.runBuild(p, inv);
        if (r.status !== 'SUCCEEDED') throw new StatesError('States.TaskFailed', JSON.stringify({ Build: r.build }));
        return { Build: r.build };
      }
      case ASL_RESOURCES.startExecution:
      case ASL_RESOURCES.startExecutionSync2: {
        const smArn = String(p.StateMachineArn ?? '');
        const sm = smArn.includes(':stateMachine:') ? smArn.slice(smArn.lastIndexOf(':') + 1) : smArn;
        const childName = typeof p.Name === 'string' ? p.Name : `${inv.executionName}-${Math.random().toString(36).slice(2, 10)}`;
        const input = typeof p.Input === 'string' ? JSON.parse(p.Input) : (p.Input ?? {});
        let started: { executionArn: string; startDate: string };
        try {
          started = this.startExecution(sm, childName, input);
        } catch (e) {
          if (e instanceof PortError && e.code === 'ExecutionAlreadyExists') {
            throw new StatesError('StepFunctions.ExecutionAlreadyExistsException', e.message);
          }
          if (e instanceof PortError && e.code === 'NotFound') throw new StatesError('StepFunctions.StateMachineDoesNotExistException', e.message);
          throw e;
        }
        if (inv.resource === ASL_RESOURCES.startExecution) return { ExecutionArn: started.executionArn, StartDate: started.startDate };
        const onAbort = () => this.stopExecution(started.executionArn, { cause: 'parent stopped' });
        inv.signal.addEventListener('abort', onAbort, { once: true });
        const d = await this.waitFor(started.executionArn);
        inv.signal.removeEventListener('abort', onAbort);
        if (d.status !== 'SUCCEEDED') {
          throw new StatesError('States.TaskFailed', JSON.stringify({ ExecutionArn: d.executionArn, Status: d.status, Error: d.error, Cause: d.cause }));
        }
        return { ExecutionArn: d.executionArn, Output: d.output, Status: d.status, StartDate: d.startDate, StopDate: d.stopDate };
      }
      case ASL_RESOURCES.sfnStopExecution: {
        const arn = String(p.ExecutionArn ?? '');
        try {
          this.stopExecution(arn, { error: p.Error as string | undefined, cause: p.Cause as string | undefined });
        } catch (e) {
          if (e instanceof PortError) throw new StatesError('Sfn.ExecutionDoesNotExistException', e.message);
          throw e;
        }
        return { StopDate: new Date(this.opts.clock.nowMs()).toISOString() };
      }
      default:
        throw new StatesError('States.Runtime', `no integration registered for resource ${inv.resource}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// helpers

function linkedAbort(parent: AbortSignal): { signal: AbortSignal; abort: (reason?: unknown) => void; dispose: () => void } {
  const ac = new AbortController();
  const onAbort = () => ac.abort(parent.reason);
  if (parent.aborted) ac.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ac.signal,
    abort: (reason?: unknown) => {
      if (!ac.signal.aborted) ac.abort(reason);
    },
    dispose: () => parent.removeEventListener('abort', onAbort),
  };
}

/** Replace `${Name}` in every string of the definition (CloudFormation DefinitionSubstitutions). */
export function substitute(value: unknown, subs: Record<string, string>): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, k: string) => subs[k] ?? m);
  if (Array.isArray(value)) return value.map((v) => substitute(v, subs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, subs)]));
  }
  return value;
}

/** Payload templates: keys ending in `.$` take a path or an intrinsic function. */
export function applyTemplate(tmpl: unknown, input: unknown, context: unknown): unknown {
  if (Array.isArray(tmpl)) return tmpl.map((v) => applyTemplate(v, input, context));
  if (tmpl && typeof tmpl === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tmpl as Record<string, unknown>)) {
      if (k.endsWith('.$')) {
        if (typeof v !== 'string') throw new StatesError('States.Runtime', `value of ${k} must be a string`);
        out[k.slice(0, -2)] = isIntrinsic(v) ? evalIntrinsic(v, input, context) : structuredClone(readPath(v, input, context));
      } else {
        out[k] = applyTemplate(v, input, context);
      }
    }
    return out;
  }
  return tmpl;
}

function applyResultPath(resultPath: string | null | undefined, rawInput: unknown, result: unknown): unknown {
  if (resultPath === null) return rawInput;
  if (resultPath === undefined || resultPath === '$') return result;
  return writePath(resultPath, rawInput, result);
}

// ---------------------------------------------------------------------------------------------------------------
// Choice rules

function evalRule(rule: AslChoiceRule, input: unknown, context: unknown): boolean {
  if (rule.And) return rule.And.every((r) => evalRule(r, input, context));
  if (rule.Or) return rule.Or.some((r) => evalRule(r, input, context));
  if (rule.Not) return !evalRule(rule.Not, input, context);
  const variable = rule.Variable;
  if (typeof variable !== 'string') throw new StatesError('States.Runtime', 'choice rule without Variable');
  const ops = Object.keys(rule).filter((k) => k !== 'Variable' && k !== 'Next' && k !== 'Comment');
  if (ops.length !== 1) throw new StatesError('States.Runtime', `choice rule needs exactly one comparator: ${JSON.stringify(rule)}`);
  const op = ops[0]!;
  const expected = rule[op];
  if (op === 'IsPresent') return pathExists(variable, input, context) === expected;
  const value = readPath(variable, input, context);
  switch (op) {
    case 'IsNull':
      return (value === null) === expected;
    case 'IsNumeric':
      return (typeof value === 'number') === expected;
    case 'IsString':
      return (typeof value === 'string') === expected;
    case 'IsBoolean':
      return (typeof value === 'boolean') === expected;
    case 'IsTimestamp':
      return (typeof value === 'string' && isTimestamp(value)) === expected;
  }
  const isPath = op.endsWith('Path');
  const base = isPath ? op.slice(0, -4) : op;
  const rhs = isPath ? readPath(String(expected), input, context) : expected;
  return compare(base, value, rhs);
}

function isTimestamp(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s));
}

function compare(op: string, a: unknown, b: unknown): boolean {
  const kind = op.startsWith('String') ? 'String' : op.startsWith('Numeric') ? 'Numeric' : op.startsWith('Boolean') ? 'Boolean' : op.startsWith('Timestamp') ? 'Timestamp' : '';
  const rel = op.slice(kind.length);
  if (kind === 'String') {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (rel === 'Matches') return wildcard(b).test(a);
    return relation(rel, a < b ? -1 : a > b ? 1 : 0);
  }
  if (kind === 'Numeric') {
    if (typeof a !== 'number' || typeof b !== 'number') return false;
    return relation(rel, a < b ? -1 : a > b ? 1 : 0);
  }
  if (kind === 'Boolean') {
    if (typeof a !== 'boolean' || typeof b !== 'boolean') return false;
    return rel === 'Equals' && a === b;
  }
  if (kind === 'Timestamp') {
    if (typeof a !== 'string' || typeof b !== 'string' || !isTimestamp(a) || !isTimestamp(b)) return false;
    const x = Date.parse(a);
    const y = Date.parse(b);
    return relation(rel, x < y ? -1 : x > y ? 1 : 0);
  }
  throw new StatesError('States.Runtime', `unsupported comparator ${op}`);
}

function relation(rel: string, c: number): boolean {
  switch (rel) {
    case 'Equals':
      return c === 0;
    case 'LessThan':
      return c < 0;
    case 'GreaterThan':
      return c > 0;
    case 'LessThanEquals':
      return c <= 0;
    case 'GreaterThanEquals':
      return c >= 0;
    default:
      throw new StatesError('States.Runtime', `unsupported comparison ${rel}`);
  }
}

function wildcard(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && pattern[i + 1] === '*') {
      re += '\\*';
      i++;
    } else if (c === '*') re += '.*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's');
}
