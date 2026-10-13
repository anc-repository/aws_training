/**
 * Input of one `atl-runner` build (01 §3.4, 02 §4.3): the orchestration variables (`ATL_OP`, `ATL_RUN_ID`, …) plus what
 * the buildspec reads itself from `atl-main` (Environment, LabSession, PlatformConfig) — region, envName, state bucket,
 * tags and the platform API address are never passed by the orchestration. The scripts/module environment comes from
 * the same builder as the workstation's `session.env` (`buildAgentContext` + `toSessionEnv`, opsReport `internal`).
 */
import {
  ATL_OPS,
  BucketNames,
  buildAgentContext,
  decodeJsonArgs,
  RoleSessionNames,
  RUNNER_ENV,
  toSessionEnv,
  type AtlOp,
  type BuildAgentContextInput,
} from '@atl/shared';

export interface RunnerInput {
  op: AtlOp;
  runId: string;
  sessionId: string;
  envId: string;
  labId: string;
  release: string;
  region: string;
  accountId: string;
  args: Record<string, unknown> | null;
  profile: string | null;
  applyMode: 'fresh' | 'additive' | null;
  repair: boolean;
}

export class RunnerInputError extends Error {
  override readonly name = 'RunnerInputError';
}

/** Validates the build environment (exit 2 on error, like scripts/module's usage errors). */
export function readRunnerInput(env: NodeJS.ProcessEnv): RunnerInput {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new RunnerInputError(`${k} is required`);
    return v;
  };
  const op = need(RUNNER_ENV.op);
  if (!(ATL_OPS as readonly string[]).includes(op)) throw new RunnerInputError(`ATL_OP=${op} is not one of ${ATL_OPS.join(', ')}`);
  const runId = need(RUNNER_ENV.runId);
  const sessionId = need(RUNNER_ENV.sessionId);
  if (!runId.startsWith(`${sessionId}-`)) throw new RunnerInputError(`ATL_RUN_ID ${runId} does not belong to ${sessionId}`);
  const rawArgs = env[RUNNER_ENV.args];
  let args: Record<string, unknown> | null = null;
  if (rawArgs) {
    try {
      args = decodeJsonArgs(rawArgs) as Record<string, unknown>;
    } catch {
      throw new RunnerInputError('ATL_ARGS is not base64url JSON');
    }
  }
  if (op === 'module-op' && (!args || typeof args.actionId !== 'string' || Object.keys(args).length !== 1)) throw new RunnerInputError('module-op needs ATL_ARGS {actionId} and nothing else');
  if (op === 'extra-stack') {
    const a = args as { action?: unknown; stackIds?: unknown } | null;
    if (!a || (a.action !== 'deploy' && a.action !== 'destroy') || !Array.isArray(a.stackIds) || !a.stackIds.every((s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s))) {
      throw new RunnerInputError('extra-stack needs ATL_ARGS {action: deploy|destroy, stackIds[]}');
    }
  }
  const applyMode = env[RUNNER_ENV.applyMode];
  if (applyMode && applyMode !== 'fresh' && applyMode !== 'additive') throw new RunnerInputError(`ATL_APPLY_MODE=${applyMode}`);
  if (op === 'profile-apply' && !env[RUNNER_ENV.profile]) throw new RunnerInputError('profile-apply needs ATL_PROFILE');
  return {
    op: op as AtlOp,
    runId,
    sessionId,
    envId: need(RUNNER_ENV.envId),
    labId: need(RUNNER_ENV.labId),
    release: need(RUNNER_ENV.release),
    region: env[RUNNER_ENV.region] ?? env.AWS_REGION ?? need('AWS_DEFAULT_REGION'),
    accountId: need('ATL_ACCOUNT_ID'),
    args,
    profile: env[RUNNER_ENV.profile] || null,
    applyMode: (applyMode as 'fresh' | 'additive' | undefined) ?? null,
    repair: env[RUNNER_ENV.repair] === '1' || env[RUNNER_ENV.repair] === 'true',
  };
}

/** The card facts the runner needs from the session's card snapshot (lifecycle `LabSession.cardSnapshot`). */
export interface RunnerCardFacts {
  catalogVersion: string | null;
  variant: string;
  startProfileDigest: string | null;
  workstationRequired: boolean;
  sshFromWorkstation: boolean;
  extraStacks: { id: string; region: string; deploy: string; reclaimPhase: 'before-modules' | 'after-modules' }[];
  platformActions: { id: string; op: string; module: string | null }[];
}

export interface RunnerContext {
  input: RunnerInput;
  envName: string;
  /** scripts/module environment (06 PM-26) + ATL_RUN_ID */
  moduleEnv: Record<string, string>;
  roleSessionName: string;
  provisionerRoleArn: string;
  buckets: { data: string; artifacts: string; web: string; labState: string };
  drRegion: string | null;
  agentApiBase: string;
  card: RunnerCardFacts;
  platformTags: Record<string, string>;
}

export interface RunnerRecords {
  session: BuildAgentContextInput['session'] & {
    startProfileResolved?: { name: string; digest: string; variant: string } | null;
    startProfileDigest?: string | null;
    cardSnapshot?: Partial<{
      catalogVersion: string;
      workstation: { required: boolean; sshFromWorkstation: boolean };
      extraStacks: RunnerCardFacts['extraStacks'];
      platformActions: RunnerCardFacts['platformActions'];
    }>;
  };
  environment: BuildAgentContextInput['environment'];
  platform: BuildAgentContextInput['platform'];
  testUsersSeeded?: boolean;
}

export function buildRunnerContext(input: RunnerInput, rec: RunnerRecords, now = new Date()): RunnerContext {
  const agent = buildAgentContext({ session: rec.session, environment: rec.environment, platform: rec.platform, testUsersSeeded: rec.testUsersSeeded ?? false, now });
  if (agent.envId !== input.envId) throw new RunnerInputError(`Environment ${agent.envId} ≠ ATL_ENV_ID ${input.envId}`);
  if (agent.sessionId !== input.sessionId) throw new RunnerInputError(`LabSession ${agent.sessionId} ≠ ATL_SESSION_ID ${input.sessionId}`);
  const moduleEnv = { ...toSessionEnv(agent, { opsReport: 'internal' }), ATL_RUN_ID: input.runId, ATL_RELEASE: input.release };
  const snap = rec.session.cardSnapshot ?? {};
  return {
    input,
    envName: agent.envName,
    moduleEnv,
    roleSessionName: RoleSessionNames.prov(input.sessionId, input.op),
    provisionerRoleArn: `arn:aws:iam::${input.accountId}:role/ATLProvisionerRole`,
    buckets: {
      data: BucketNames.data(input.accountId, input.region),
      artifacts: BucketNames.artifacts(input.accountId, input.region),
      web: BucketNames.web(input.accountId, input.region),
      labState: BucketNames.labState(input.accountId, input.region),
    },
    drRegion: agent.drRegion,
    agentApiBase: agent.agentApiBase,
    platformTags: agent.cloudalbum.stackTags,
    card: {
      catalogVersion: snap.catalogVersion ?? null,
      variant: agent.variant,
      startProfileDigest: rec.session.startProfileResolved?.digest ?? rec.session.startProfileDigest ?? null,
      workstationRequired: snap.workstation?.required ?? false,
      sshFromWorkstation: snap.workstation?.sshFromWorkstation ?? false,
      extraStacks: snap.extraStacks ?? [],
      platformActions: snap.platformActions ?? [],
    },
  };
}

/** `app` → the lab region, `us-east-1`, `dr-region` → the DrRegion install parameter (01 §3.4). */
export function extraStackRegion(ctx: RunnerContext, region: string): string {
  if (region === 'app') return ctx.input.region;
  if (region === 'dr-region') {
    if (!ctx.drRegion) throw new RunnerInputError('the card stack needs DrRegion, which is not set');
    return ctx.drRegion;
  }
  return region;
}
