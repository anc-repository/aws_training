import type { StateMachineName } from '../workflows.js';

/** Step Functions (Standard). Production: `@aws-sdk/client-sfn`. Dev: the in-process ASL simulator (`@atl/workflows`). */
export interface StartExecutionRequest {
  stateMachine: StateMachineName;
  /** Deterministic name from `ExecutionNames` (02 §2.7). */
  name: string;
  input: unknown;
}

export interface StartExecutionResult {
  executionArn: string;
  startDate: string;
}

export type ExecutionStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED';

export interface ExecutionDescription {
  executionArn: string;
  stateMachine: StateMachineName;
  name: string;
  status: ExecutionStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  cause?: string;
  startDate: string;
  stopDate?: string;
}

export interface OrchestratorPort {
  /**
   * Start an execution. Same name + same input while RUNNING returns the running execution (Step Functions semantics);
   * the same name after it finished, or with a different input, throws `PortError('ExecutionAlreadyExists')`.
   */
  startExecution(req: StartExecutionRequest): Promise<StartExecutionResult>;
  describeExecution(executionArn: string): Promise<ExecutionDescription>;
  stopExecution(executionArn: string, opts?: { error?: string; cause?: string }): Promise<void>;
  /** Deterministic ARN of an execution (used e.g. to stop `start-<sid>` by name). */
  executionArn(stateMachine: StateMachineName, name: string): string;
}
