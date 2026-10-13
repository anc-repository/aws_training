/**
 * Dev Step Functions: the in-process simulator of @atl/workflows running the deployed ASL files.
 * `lambda:invoke` → the in-process function table; `codebuild:startBuild.sync` → the dev runner, polled until the build
 * is final; nested executions run in the same simulator. Faults can be injected per state (`injectFault`).
 */
import {
  decodeJsonArgs,
  isFinalBuildStatus,
  RUNNER_ENV,
  type AtlOp,
  type ClockPort,
  type ExecutionDescription,
  type InvokerPort,
  type LambdaFunctionName,
  type OrchestratorPort,
  type RunnerBuildRequest,
  type RunnerPort,
  type StartExecutionRequest,
  type StateMachineName,
} from '@atl/shared';
import {
  DEV_SUBSTITUTIONS,
  loadAllStateMachines,
  StepFunctionsSimulator,
  type AslDefinition,
  type BuildOutcome,
  type FaultSpec,
  type HistoryEvent,
} from '@atl/workflows';

export interface SimulatedOrchestratorOptions {
  clock: ClockPort;
  invoker: InvokerPort;
  runner: RunnerPort;
  region: string;
  accountId: string;
  definitions?: Partial<Record<string, AslDefinition>>;
  substitutions?: Record<string, string>;
  faults?: FaultSpec[];
  /** Platform seconds between `getBuild` polls of a `.sync` build. */
  buildPollSeconds?: number;
  onEvent?: (e: HistoryEvent) => void;
}

export class SimulatedOrchestrator implements OrchestratorPort {
  readonly sim: StepFunctionsSimulator;

  constructor(private readonly o: SimulatedOrchestratorOptions) {
    this.sim = new StepFunctionsSimulator({
      clock: o.clock,
      definitions: o.definitions ?? loadAllStateMachines(),
      substitutions: { ...DEV_SUBSTITUTIONS, ...o.substitutions },
      region: o.region,
      accountId: o.accountId,
      faults: o.faults,
      onEvent: o.onEvent,
      invokeLambda: (fn, payload) => o.invoker.invoke(functionNameOf(fn), payload),
      runBuild: (params, inv) => this.runBuild(params, inv.signal),
    });
  }

  async startExecution(req: StartExecutionRequest) {
    return this.sim.startExecution(req.stateMachine, req.name, req.input);
  }

  async describeExecution(executionArn: string): Promise<ExecutionDescription> {
    return this.sim.describeExecution(executionArn);
  }

  async stopExecution(executionArn: string, opts: { error?: string; cause?: string } = {}) {
    this.sim.stopExecution(executionArn, opts);
  }

  executionArn(stateMachine: StateMachineName, name: string): string {
    return this.sim.executionArn(stateMachine, name);
  }

  private async runBuild(params: Record<string, unknown>, signal: AbortSignal): Promise<BuildOutcome> {
    const vars = Object.fromEntries(
      ((params.EnvironmentVariablesOverride as { Name: string; Value: string }[] | undefined) ?? []).map((v) => [v.Name, String(v.Value)]),
    );
    const req: RunnerBuildRequest = {
      op: vars[RUNNER_ENV.op] as AtlOp,
      runId: vars[RUNNER_ENV.runId] ?? '',
      sessionId: vars[RUNNER_ENV.sessionId] ?? '',
      envId: vars[RUNNER_ENV.envId] ?? '',
      labId: vars[RUNNER_ENV.labId] ?? '',
      ...(vars[RUNNER_ENV.args] ? { args: decodeJsonArgs(vars[RUNNER_ENV.args]) } : {}),
      ...(vars[RUNNER_ENV.profile] ? { profile: vars[RUNNER_ENV.profile] } : {}),
      ...(vars[RUNNER_ENV.applyMode] ? { applyMode: vars[RUNNER_ENV.applyMode] as 'fresh' | 'additive' } : {}),
      ...(vars[RUNNER_ENV.repair] ? { repair: vars[RUNNER_ENV.repair] === '1' } : {}),
      ...(typeof params.TimeoutInMinutesOverride === 'number' ? { timeoutMinutes: params.TimeoutInMinutesOverride } : {}),
    };
    let b = await this.o.runner.startBuild(req);
    const onAbort = () => void this.o.runner.stopBuild(b.buildId); // `.sync` task cancelled → StopBuild (07 V1-12 verifies on AWS)
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!isFinalBuildStatus(b.status)) {
        await this.o.clock.sleep((this.o.buildPollSeconds ?? 10) * 1000, signal);
        b = await this.o.runner.getBuild(b.buildId);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    return {
      status: b.status === 'IN_PROGRESS' ? 'FAILED' : b.status,
      build: { Id: b.buildId, BuildStatus: b.status, ExitCode: b.exitCode, RunId: b.runId, ResultKey: b.resultKey },
    };
  }
}

/** `FunctionName` may be a name or an ARN (`…:function:atl-lifecycle[:alias]`). */
export function functionNameOf(fn: string): LambdaFunctionName {
  const m = /:function:([^:]+)/.exec(fn);
  return (m ? m[1]! : fn) as LambdaFunctionName;
}
