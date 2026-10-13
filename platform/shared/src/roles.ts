/**
 * IAM roles, policies, role session names and Cognito groups — 01 §5.2, §6.1–§6.9 (name-table rows “角色”, “策略”,
 * “角色会话名”, “Cognito 组”).
 */
import { assertSid, SID_RE } from './ids.js';
import type { AtlOp } from './runner.js';
import { isAtlOp } from './runner.js';

export const ROLE_NAMES = [
  'ATLLearnerRole',
  'ATLProvisionerRole',
  'ATLVerifierRole',
  'CloudAlbumAppRole',
  'ATLWorkstationRole',
  'ATLOrchestratorRole',
  'ATLRunnerServiceRole',
  'ATLSchedulerRole',
  'ATLApiFunctionRole',
  'ATLPublicFunctionRole',
  'ATLAgentFunctionRole',
  'ATLChecksFunctionRole',
  'ATLLifecycleFunctionRole',
  'ATLTimerFunctionRole',
  'ATLReaperFunctionRole',
  'ATLCertsFunctionRole',
  'ATLPricingFunctionRole',
  'ATLTaggerFunctionRole',
  'ATLCustomResourceRole',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const PERMISSION_BOUNDARIES = ['ATLLearnerBoundary', 'ATLWorkloadBoundary', 'ATLProvisionerBoundary'] as const;
export const GUARDRAIL_POLICIES = ['ATLLearnerGuardrails', 'ATLLearnerCostGuards'] as const;
/** Inline policies of ATLLearnerRole (ATLRevokedSessions is maintained at run time by atl-lifecycle). */
export const LEARNER_INLINE_POLICIES = ['ATLLearnerIam', 'ATLAgentApi', 'ATLRevokedSessions'] as const;
export const REVOKED_SESSIONS_STATEMENTS = ['AtlRevokedSessions', 'AtlFinalizingSession'] as const;
/** Stack-managed conditional inline policy (TerminalRecording=cloudwatch). */
export const TERMINAL_RECORDING_POLICY = 'atl-terminal-recording';
export const PROVISIONER_POLICY_PREFIX = 'ATLProvisionerPolicy-';

/** Cognito groups (single-learner model; there is no admin group). */
export const COGNITO_GROUPS = ['learner', 'assistant', 'observer'] as const;
export type CognitoGroup = (typeof COGNITO_GROUPS)[number];
export const USER_POOL_NAME = 'atl-users';
export const WEB_CLIENT_NAME = 'atl-web';

// ---------------------------------------------------------------------------------------------------------------
// Role session names (01 §6.3)

export const RoleSessionNames = {
  console: (sid: string) => `atl-${assertSid(sid)}-console`,
  term: (sid: string) => `atl-${assertSid(sid)}-term`,
  ws: (sid: string) => `atl-${assertSid(sid)}-ws`,
  prov: (sid: string, op: AtlOp) => `atl-${assertSid(sid)}-prov-${op}`,
  reap: (sid: string, n: number) => `atl-${assertSid(sid)}-reap-${n}`,
  verify: (sid: string) => `atl-${assertSid(sid)}-verify`,
} as const;

export type ParsedRoleSessionName =
  | { sid: string; channel: 'console' | 'term' | 'ws' | 'verify' }
  | { sid: string; channel: 'prov'; op: AtlOp }
  | { sid: string; channel: 'reap'; n: number };

const SESSION_NAME_RE = new RegExp(`^atl-(${SID_RE.source.slice(1, -1)})-(console|term|ws|verify|prov-([a-z-]+)|reap-([0-9]+))$`);

export function parseRoleSessionName(name: string): ParsedRoleSessionName | null {
  const m = SESSION_NAME_RE.exec(name);
  if (!m) return null;
  const sid = m[1]!;
  const tail = m[2]!;
  if (tail.startsWith('prov-')) return isAtlOp(m[3]) ? { sid, channel: 'prov', op: m[3] } : null;
  if (tail.startsWith('reap-')) return { sid, channel: 'reap', n: Number(m[4]) };
  return { sid, channel: tail as 'console' | 'term' | 'ws' | 'verify' };
}

/** Is this session name one that the reclaimer treats as “learner-created” (01 §6.3)? */
export function isLearnerSessionName(name: string): boolean {
  const p = parseRoleSessionName(name);
  return !!p && (p.channel === 'console' || p.channel === 'term' || p.channel === 'ws');
}

export interface AssumedRoleArn {
  partition: string;
  accountId: string;
  roleName: string;
  sessionName: string;
}

/** Parse `arn:aws:sts::<acct>:assumed-role/<role>/<session>` (the caller ARN of SigV4 routes, 01 §5.3). */
export function parseAssumedRoleArn(arn: string): AssumedRoleArn | null {
  const m = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([\w+=,.@-]+)\/([\w+=,.@-]+)$/.exec(arn);
  if (!m) return null;
  return { partition: m[1]!, accountId: m[2]!, roleName: m[3]!, sessionName: m[4]! };
}
