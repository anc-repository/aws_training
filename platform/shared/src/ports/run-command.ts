import type { SsmDocumentName } from '../resources.js';

/**
 * SSM Run Command (ATL-RunCheck, ATL-WorkstationSetup). Production: `@aws-sdk/client-ssm`. Dev: run the check runner as a
 * local process against a local CloudAlbum.
 */
export interface SendCommandRequest {
  documentName: SsmDocumentName;
  instanceIds: string[];
  /** Document parameters (ENV_VAR interpolation: delivered as `SSM_<name>`). Never secrets (01 §3.6). */
  parameters: Record<string, string>;
  timeoutSeconds?: number;
  comment?: string;
  /** Pin the document (04 §5.7). */
  documentVersion?: string;
  documentHash?: string;
}

export type CommandInvocationStatus =
  | 'Pending'
  | 'InProgress'
  | 'Delayed'
  | 'Success'
  | 'Cancelled'
  | 'TimedOut'
  | 'Failed'
  | 'Cancelling';

export interface CommandInvocation {
  commandId: string;
  instanceId: string;
  status: CommandInvocationStatus;
  responseCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCommandPort {
  sendCommand(req: SendCommandRequest): Promise<{ commandId: string }>;
  /** Throws `PortError('NotFound')` while the invocation is not registered yet (callers poll). */
  getInvocation(commandId: string, instanceId: string): Promise<CommandInvocation>;
}

export function isFinalInvocationStatus(s: CommandInvocationStatus): boolean {
  return s === 'Success' || s === 'Cancelled' || s === 'TimedOut' || s === 'Failed';
}
