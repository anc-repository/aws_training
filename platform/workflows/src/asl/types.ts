/**
 * Amazon States Language (JSONPath query language) — the subset used by the ATL state machines (02 §4.4, §6.6, §7.11).
 * Loosely typed on purpose: the validator checks structure, the simulator interprets.
 */

export interface AslDefinition {
  Comment?: string;
  QueryLanguage?: 'JSONPath' | 'JSONata';
  StartAt: string;
  States: Record<string, AslState>;
  TimeoutSeconds?: number;
  Version?: string;
}

/** A Parallel branch / Map item processor. */
export interface AslSubMachine {
  StartAt: string;
  States: Record<string, AslState>;
  ProcessorConfig?: Record<string, unknown>;
}

export type AslStateType = 'Task' | 'Pass' | 'Choice' | 'Wait' | 'Succeed' | 'Fail' | 'Parallel' | 'Map';

export interface AslRetrier {
  ErrorEquals: string[];
  IntervalSeconds?: number;
  MaxAttempts?: number;
  BackoffRate?: number;
  MaxDelaySeconds?: number;
  JitterStrategy?: 'FULL' | 'NONE';
}

export interface AslCatcher {
  ErrorEquals: string[];
  Next: string;
  ResultPath?: string | null;
}

export interface AslChoiceRule {
  Variable?: string;
  Next?: string;
  And?: AslChoiceRule[];
  Or?: AslChoiceRule[];
  Not?: AslChoiceRule;
  [comparator: string]: unknown;
}

export interface AslState {
  Type: AslStateType;
  Comment?: string;
  Next?: string;
  End?: boolean;
  InputPath?: string | null;
  OutputPath?: string | null;
  ResultPath?: string | null;
  Parameters?: unknown;
  ResultSelector?: unknown;
  Result?: unknown;
  Resource?: string;
  TimeoutSeconds?: number;
  TimeoutSecondsPath?: string;
  HeartbeatSeconds?: number;
  Retry?: AslRetrier[];
  Catch?: AslCatcher[];
  // Choice
  Choices?: AslChoiceRule[];
  Default?: string;
  // Wait
  Seconds?: number;
  SecondsPath?: string;
  Timestamp?: string;
  TimestampPath?: string;
  // Fail
  Error?: string;
  Cause?: string;
  ErrorPath?: string;
  CausePath?: string;
  // Parallel
  Branches?: AslSubMachine[];
  // Map
  ItemsPath?: string;
  ItemSelector?: unknown;
  ItemProcessor?: AslSubMachine;
  Iterator?: AslSubMachine;
  MaxConcurrency?: number;
  MaxConcurrencyPath?: string;
  [key: string]: unknown;
}

/** Well-known integration resources used by ATL (01 §3.3). */
export const ASL_RESOURCES = {
  lambdaInvoke: 'arn:aws:states:::lambda:invoke',
  codebuildStartBuildSync: 'arn:aws:states:::codebuild:startBuild.sync',
  startExecution: 'arn:aws:states:::states:startExecution',
  startExecutionSync2: 'arn:aws:states:::states:startExecution.sync:2',
  sfnStopExecution: 'arn:aws:states:::aws-sdk:sfn:stopExecution',
} as const;
