/**
 * Platform mode of scripts/module (06 PM-26): the switch, the environment variables and the caller identity check.
 *   switch   : CLOUDALBUM_PLATFORM_MODE=1 or --platform (either one; isPlatform() is the only place that decides)
 *   variables: written by the workstation wiring (03 /etc/atl/session.env) and the runner buildspec (02) from the same
 *              atl.agent-context/v1 record; a missing required variable -> exit 2 PLATFORM_ENV_INCOMPLETE
 *   identity : sts:GetCallerIdentity must be ATLLearnerRole/atl-<sid>-(ws|console) or ATLProvisionerRole/atl-<sid>-prov-<op>
 *              with <sid> == ATL_SESSION_ID (the reclaimer attributes resources by session name, P5) -> otherwise exit 2
 *              PLATFORM_IDENTITY_MISMATCH. --allow-any-identity skips it for development (recorded in the state history).
 */
import type { AwsGateway } from '../aws.js';
import { CliError, EXIT } from '../printer.js';

export function isPlatform(opts: { platform?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): boolean {
  if (opts.platform) return true;
  return /^(1|true|on)$/i.test(env.CLOUDALBUM_PLATFORM_MODE ?? '');
}

export interface PlatformEnv {
  env: string;
  region: string;
  stateUri: string;
  stateBucket: string;
  stateKey: string;
  lockTable: string;
  /** every tag of CLOUDALBUM_PLATFORM_TAGS (environment and session level) */
  tags: Record<string, string>;
  boundaryArn: string;
  adminPasswordParam: string;
  testUsersParam?: string;
  opsReport: 'agent' | 'internal' | 'off';
  asgMaxSizeLimit?: number;
  drRegion?: string;
  agentApi?: string;
  sessionId: string;
  envId: string;
  labId: string;
  variant: string;
  runId?: string;
}

const RE = {
  env: /^e[a-z0-9]{7}$/,
  stateUri: /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/([A-Za-z0-9!_.*'()/-]{1,900})$/,
  lockTable: /^[A-Za-z0-9_.-]{3,255}$/,
  tagPart: /^[A-Za-z0-9:._-]{1,128}$/,
  boundary: /^arn:aws[a-z-]*:iam::[0-9]{12}:policy\/[A-Za-z0-9+=,.@_/-]{1,128}$/,
  param: /^\/cloudalbum\/[a-z0-9-]+\/atl\/[A-Za-z0-9_.-]+$/,
  sessionId: /^s[0-9a-hjkmnp-tv-z]{12}$/,
  envId: /^[0-9a-hjkmnp-tv-z]{26}$/,
  labId: /^(svc|sc)-[a-z0-9]+(-[a-z0-9]+)*$/,
  variant: /^[a-z][a-z0-9-]{0,31}$/,
  region: /^[a-z]{2}(-[a-z]+)+-\d$/,
  runId: /^[a-z0-9][a-z0-9-]{2,96}$/,
  agentApi: /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9/_-]*)?$/,
};

/** "k=v,k=v" (keys and values ^[A-Za-z0-9:._-]{1,128}$) */
export function parsePlatformTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const k = eq > 0 ? part.slice(0, eq) : '';
    const v = eq > 0 ? part.slice(eq + 1) : '';
    if (!RE.tagPart.test(k) || !RE.tagPart.test(v)) throw new CliError(`CLOUDALBUM_PLATFORM_TAGS: invalid entry "${part}"`, EXIT.rules, 'PLATFORM_ENV_INVALID');
    out[k] = v;
  }
  return out;
}

const REQUIRED = [
  'CLOUDALBUM_ENV', 'CLOUDALBUM_STATE_URI', 'CLOUDALBUM_LOCK_TABLE', 'CLOUDALBUM_PLATFORM_TAGS', 'CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN',
  'CLOUDALBUM_ADMIN_PASSWORD_PARAM', 'ATL_SESSION_ID', 'ATL_ENV_ID', 'ATL_LAB_ID', 'AWS_REGION',
] as const;

/** Read and validate the platform variables (06 PM-26 table). */
export function readPlatformEnv(env: NodeJS.ProcessEnv = process.env): PlatformEnv {
  const missing: string[] = REQUIRED.filter((k) => !(env[k] ?? '').trim());
  const opsReport = (env.CLOUDALBUM_OPS_REPORT ?? 'off').trim() as PlatformEnv['opsReport'];
  if (opsReport !== 'off' && !(env.ATL_AGENT_API ?? '').trim()) missing.push('ATL_AGENT_API');
  if (missing.length) {
    throw new CliError(`platform mode: missing environment variable(s) ${missing.join(', ')}`, EXIT.rules, 'PLATFORM_ENV_INCOMPLETE', { missing });
  }
  const v = (k: string) => (env[k] ?? '').trim();
  const bad = (k: string) => new CliError(`platform mode: ${k} has an invalid value`, EXIT.rules, 'PLATFORM_ENV_INVALID', { variable: k });
  if (!RE.env.test(v('CLOUDALBUM_ENV'))) throw bad('CLOUDALBUM_ENV');
  const m = RE.stateUri.exec(v('CLOUDALBUM_STATE_URI'));
  if (!m || m[1]!.startsWith('atl-')) throw bad('CLOUDALBUM_STATE_URI');
  if (!RE.lockTable.test(v('CLOUDALBUM_LOCK_TABLE'))) throw bad('CLOUDALBUM_LOCK_TABLE');
  if (!RE.boundary.test(v('CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN'))) throw bad('CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN');
  if (!RE.param.test(v('CLOUDALBUM_ADMIN_PASSWORD_PARAM'))) throw bad('CLOUDALBUM_ADMIN_PASSWORD_PARAM');
  if (v('CLOUDALBUM_TEST_USERS_PARAM') && !RE.param.test(v('CLOUDALBUM_TEST_USERS_PARAM'))) throw bad('CLOUDALBUM_TEST_USERS_PARAM');
  if (!['agent', 'internal', 'off'].includes(opsReport)) throw bad('CLOUDALBUM_OPS_REPORT');
  if (!RE.sessionId.test(v('ATL_SESSION_ID'))) throw bad('ATL_SESSION_ID');
  if (!RE.envId.test(v('ATL_ENV_ID'))) throw bad('ATL_ENV_ID');
  if (!RE.labId.test(v('ATL_LAB_ID'))) throw bad('ATL_LAB_ID');
  const variant = v('ATL_VARIANT') || 'default';
  if (!RE.variant.test(variant)) throw bad('ATL_VARIANT');
  if (!RE.region.test(v('AWS_REGION'))) throw bad('AWS_REGION');
  if (v('ATL_RUN_ID') && !RE.runId.test(v('ATL_RUN_ID'))) throw bad('ATL_RUN_ID');
  if (v('ATL_AGENT_API') && !RE.agentApi.test(v('ATL_AGENT_API'))) throw bad('ATL_AGENT_API');
  if (v('CLOUDALBUM_DR_REGION') && !RE.region.test(v('CLOUDALBUM_DR_REGION'))) throw bad('CLOUDALBUM_DR_REGION');
  const asg = v('CLOUDALBUM_ASG_MAX_SIZE_LIMIT');
  if (asg && !/^[1-9][0-9]?$/.test(asg)) throw bad('CLOUDALBUM_ASG_MAX_SIZE_LIMIT');
  return {
    env: v('CLOUDALBUM_ENV'), region: v('AWS_REGION'), stateUri: v('CLOUDALBUM_STATE_URI'), stateBucket: m[1]!, stateKey: m[2]!,
    lockTable: v('CLOUDALBUM_LOCK_TABLE'), tags: parsePlatformTags(v('CLOUDALBUM_PLATFORM_TAGS')), boundaryArn: v('CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN'),
    adminPasswordParam: v('CLOUDALBUM_ADMIN_PASSWORD_PARAM'), ...(v('CLOUDALBUM_TEST_USERS_PARAM') ? { testUsersParam: v('CLOUDALBUM_TEST_USERS_PARAM') } : {}),
    opsReport, ...(asg ? { asgMaxSizeLimit: Number(asg) } : {}), ...(v('CLOUDALBUM_DR_REGION') ? { drRegion: v('CLOUDALBUM_DR_REGION') } : {}),
    ...(v('ATL_AGENT_API') ? { agentApi: v('ATL_AGENT_API') } : {}),
    sessionId: v('ATL_SESSION_ID'), envId: v('ATL_ENV_ID'), labId: v('ATL_LAB_ID'), variant,
    ...(v('ATL_RUN_ID') ? { runId: v('ATL_RUN_ID') } : {}),
  };
}

export interface CallerIdentity {
  arn: string;
  accountId: string;
  /** role session name: atl-<sid>-ws | atl-<sid>-console | atl-<sid>-prov-<op> */
  sessionName: string;
  kind: 'learner' | 'console' | 'provisioner' | 'any';
}

const IDENTITY_RE = /^arn:aws[a-z-]*:sts::([0-9]{12}):assumed-role\/(ATLLearnerRole\/atl-(s[0-9a-hjkmnp-tv-z]{12})-(ws|console)|ATLProvisionerRole\/atl-(s[0-9a-hjkmnp-tv-z]{12})-prov-[a-z0-9-]+)$/;

export function parseIdentity(arn: string, sessionId: string): CallerIdentity | null {
  const m = IDENTITY_RE.exec(arn);
  if (!m) return null;
  const sid = m[3] ?? m[5];
  if (sid !== sessionId) return null;
  const sessionName = arn.slice(arn.lastIndexOf('/') + 1);
  return { arn, accountId: m[1]!, sessionName, kind: m[3] ? (m[4] === 'console' ? 'console' : 'learner') : 'provisioner' };
}

/** sts:GetCallerIdentity + the PM-26 check. Dry-run: a synthetic identity from ATL_RUN_ID (runner) or the workstation name. */
export async function verifyIdentity(aws: AwsGateway, p: PlatformEnv, opts: { allowAnyIdentity?: boolean } = {}): Promise<CallerIdentity> {
  const who = await aws.send<{ Account?: string; Arn?: string }>({ service: 'sts', op: 'GetCallerIdentity', input: {} });
  if (aws.dryRun || !who?.Arn) {
    const sessionName = p.runId ? `atl-${p.sessionId}-prov-dry-run` : `atl-${p.sessionId}-ws`;
    return { arn: `arn:aws:sts::000000000000:assumed-role/${p.runId ? 'ATLProvisionerRole' : 'ATLLearnerRole'}/${sessionName}`, accountId: '000000000000',
      sessionName, kind: p.runId ? 'provisioner' : 'learner' };
  }
  const id = parseIdentity(who.Arn, p.sessionId);
  if (id) return id;
  if (opts.allowAnyIdentity) {
    return { arn: who.Arn, accountId: who.Account ?? '000000000000', sessionName: who.Arn.slice(who.Arn.lastIndexOf('/') + 1), kind: 'any' };
  }
  throw new CliError(`platform mode: the caller ${who.Arn} is not ATLLearnerRole/atl-${p.sessionId}-ws|console or `
    + `ATLProvisionerRole/atl-${p.sessionId}-prov-<op> (resources created by other identities cannot be reclaimed automatically)`,
  EXIT.rules, 'PLATFORM_IDENTITY_MISMATCH');
}
