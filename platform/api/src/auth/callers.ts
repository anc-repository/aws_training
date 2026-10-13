/**
 * SigV4 caller checks for the IAM routes (01 §5.3). HTTP API has no resource policy, so the handler's check of the caller
 * ARN is authoritative.
 *  - agent:    `arn:aws:sts::<acct>:assumed-role/ATLLearnerRole/atl-<sid>-ws`, `<sid>` = path sid → else SESSION_MISMATCH
 *  - internal: `assumed-role/ATLProvisionerRole/atl-<sid>-prov-<op>`, `<sid>` = path sid or the runId's sid → else CALLER_MISMATCH
 */
import { AtlError, parseAssumedRoleArn, parseRoleSessionName, parseRunnerRunId, type AtlOp } from '@atl/shared';

export interface AgentCaller {
  arn: string;
  sid: string;
}

export function checkAgentCaller(callerArn: string | undefined, pathSid: string, accountId?: string): AgentCaller {
  const a = callerArn ? parseAssumedRoleArn(callerArn) : null;
  const s = a ? parseRoleSessionName(a.sessionName) : null;
  if (!a || a.roleName !== 'ATLLearnerRole' || !s || s.channel !== 'ws' || s.sid !== pathSid || (accountId && a.accountId !== accountId)) {
    throw new AtlError('SESSION_MISMATCH', 'caller is not the workstation session of this sid');
  }
  return { arn: callerArn!, sid: s.sid };
}

export interface InternalCaller {
  arn: string;
  sid: string;
  op: AtlOp;
}

export function checkInternalCaller(
  callerArn: string | undefined,
  target: { sid?: string; runId?: string },
  accountId?: string,
): InternalCaller {
  const a = callerArn ? parseAssumedRoleArn(callerArn) : null;
  const s = a ? parseRoleSessionName(a.sessionName) : null;
  const sid = target.sid ?? (target.runId ? parseRunnerRunId(target.runId)?.sid : undefined);
  if (!a || a.roleName !== 'ATLProvisionerRole' || !s || s.channel !== 'prov' || !sid || s.sid !== sid || (accountId && a.accountId !== accountId)) {
    throw new AtlError('CALLER_MISMATCH', 'caller is not a runner session of this session / run');
  }
  return { arn: callerArn!, sid, op: s.op };
}
