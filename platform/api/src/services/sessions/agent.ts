/**
 * `atl-agent` routes (01 §8.2, §5.3 C4(b); 04 §7): session context for the workstation, experiment runs
 * (register → upload → poll, attachments), module-op reports from the workstation and the runner, runner progress
 * and credential-grant registration. Callers are already authenticated by the router (caller ARN rules); the state
 * gates of `AGENT_STATE_GATES` are applied here (`SESSION_NOT_RUNNING`).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  AGENT_STATE_GATES,
  AtlError,
  buildAgentContext,
  canonicalJson,
  DataKeys,
  newUlid,
  parseRunnerRunId,
  RoleSessionNames,
  type AgentContext,
  type AtlOp,
  type SessionState,
} from '@atl/shared';
import { Gsi1, Keys, SkPrefix } from '../../data/keys.js';
import { isConditionFailed, type Item, type SessionItem } from '../../repositories/index.js';
import { experimentLabels } from '../catalog/labs.js';
import { emitSessionEvents } from '../events/index.js';
import { mapDownstreamError } from './lifecycle-client.js';
import type { ServiceContext } from './types.js';

export const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const RUN_WINDOW_MINUTES = 60;

export function requireAgentState(s: SessionItem, gate: keyof typeof AGENT_STATE_GATES): void {
  if (!(AGENT_STATE_GATES[gate] as readonly SessionState[]).includes(s.state)) {
    throw new AtlError('SESSION_NOT_RUNNING', `session ${s.sid} is ${s.state}`, { state: s.state });
  }
}

export async function loadAgentSession(ctx: ServiceContext, sid: string): Promise<SessionItem> {
  const s = await ctx.repos.sessions.get(sid, true);
  if (!s) throw new AtlError('NOT_FOUND', `session ${sid} not found`);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Context (01 §8.2 `atl.agent-context/v1`; PROVISIONING allowed, C4(b))

export async function agentContext(ctx: ServiceContext, s: SessionItem): Promise<AgentContext> {
  requireAgentState(s, 'context');
  if (typeof s.envId !== 'string') throw new AtlError('SESSION_NOT_RUNNING', 'the environment of this session is not assigned yet', { state: s.state });
  const [env, config] = await Promise.all([ctx.repos.environments.get(s.envId), ctx.repos.platform.config()]);
  if (!env) throw new AtlError('SESSION_NOT_RUNNING', 'the environment of this session is not recorded yet', { state: s.state });
  if (!config) throw new AtlError('INTERNAL', 'PlatformConfig is missing');
  const facts = (s.cardFacts ?? { platformActions: [], sshFromWorkstation: false, sshUser: null }) as { platformActions: string[]; sshFromWorkstation: boolean; sshUser: string | null; testUsersSeeded?: boolean };
  return buildAgentContext({
    session: { ...(s as unknown as Parameters<typeof buildAgentContext>[0]['session']), cardFacts: facts },
    environment: env as unknown as Parameters<typeof buildAgentContext>[0]['environment'],
    platform: config,
    testUsersSeeded: !!facts.testUsersSeeded,
    now: new Date(ctx.nowMs),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Experiment runs (04 §7)

export interface RegisterInput {
  module: string;
  experiment: string;
  label: string;
  scenario?: string | undefined;
  params?: Record<string, unknown> | undefined;
  nonce?: string | undefined;
}

export function experimentRunView(r: Item): Record<string, unknown> {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g1s, ttl: _t, runTokenHash: _rth, type: _type, ...rest } = r;
  return rest;
}

export async function registerExperimentRun(ctx: ServiceContext, s: SessionItem, callerArn: string, input: RegisterInput): Promise<Record<string, unknown>> {
  requireAgentState(s, 'default');
  const lab = typeof s.catalogVersion === 'string' ? await ctx.catalog.lab(s.labId, s.catalogVersion) : null;
  if (!lab) throw new AtlError('EXPERIMENT_NOT_IN_LAB', `card ${s.labId} content is not available`);
  const labels = experimentLabels(lab, input.module, input.experiment);
  if (!labels) throw new AtlError('EXPERIMENT_NOT_IN_LAB', `card ${s.labId} does not declare experiment ${input.module}/${input.experiment}`);
  const lbl = labels.find((l) => l.label === input.label);
  if (!lbl) throw new AtlError('LABEL_NOT_IN_LAB', `label ${input.label} is not declared for ${input.module}/${input.experiment}`, { labels: labels.map((l) => l.label) });
  const config = await ctx.repos.platform.config();
  const fallback = (config?.agent as { lateUploadFallback?: string } | undefined)?.lateUploadFallback === 'on';
  const runId = newUlid(ctx.nowMs);
  const deadline = typeof s.deadlineAt === 'string' ? Date.parse(s.deadlineAt) + 10 * 60_000 : Number.POSITIVE_INFINITY;
  const window = { notBefore: new Date(ctx.nowMs - 60_000).toISOString(), notAfter: new Date(Math.min(ctx.nowMs + RUN_WINDOW_MINUTES * 60_000, deadline)).toISOString() };
  const variant = { label: lbl.label, role: lbl.role, cardVariant: String(s.variant ?? 'default') };
  const nonce = input.nonce && /^[A-Za-z0-9_-]{8,128}$/.test(input.nonce) ? input.nonce : randomBytes(16).toString('base64url');
  const runToken = fallback ? randomBytes(24).toString('base64url') : null;
  await ctx.repos.sessions.putChild(
    {
      ...Keys.experimentRun(s.sid, runId),
      type: 'ExperimentRun',
      ver: 1,
      createdAt: ctx.nowIso,
      updatedAt: ctx.nowIso,
      runId,
      sessionId: s.sid,
      labId: s.labId,
      module: input.module,
      experiment: input.experiment,
      label: input.label,
      variant,
      scenario: input.scenario ?? null,
      params: input.params ?? {},
      forced: false,
      window,
      nonce,
      registeredAt: ctx.nowIso,
      registeredBy: callerArn,
      status: 'registered',
      validity: null,
      ...(runToken ? { runTokenHash: createHash('sha256').update(runToken).digest('hex') } : {}),
    },
    { expression: 'attribute_not_exists(PK)' },
  );
  return {
    runId,
    window,
    variant,
    nonce,
    headers: { 'X-Experiment-Run': runId, 'X-Experiment-Label': input.label },
    uploadUrl: `/api/v1/agent/sessions/${s.sid}/experiment-runs/${runId}/result`,
    ...(runToken ? { runToken, fallbackUploadUrl: `/api/v1/agent-fallback/runs/${runId}/result` } : {}),
  };
}

async function loadRun(ctx: ServiceContext, sid: string, runId: string): Promise<Item> {
  if (!/^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/.test(runId)) throw new AtlError('RUN_NOT_FOUND', `run ${runId} is not registered`);
  const run = await ctx.repos.sessions.getChild(Keys.experimentRun(sid, runId));
  if (!run) throw new AtlError('RUN_NOT_FOUND', `run ${runId} is not registered for session ${sid}`);
  return run;
}

/** Result upload gate (04 §7.2): READY/RUNNING/EXPIRING, or ENDING for runs registered before ENDING. */
function requireUploadState(s: SessionItem, run: Item): void {
  requireAgentState(s, 'experimentResult');
  if (s.state === 'ENDING' && !(String(run.registeredAt) < String(s.stateEnteredAt))) {
    throw new AtlError('SESSION_NOT_RUNNING', 'the run was registered after the session started ending', { state: s.state });
  }
}

export function resultDigest(body: Record<string, unknown>): string {
  const { integrity: _i, ...rest } = body;
  return `sha256:${createHash('sha256').update(canonicalJson(rest)).digest('hex')}`;
}

const isoOk = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export async function uploadExperimentResult(
  ctx: ServiceContext,
  s: SessionItem,
  runId: string,
  uploader: string,
  raw: unknown,
  rawSize: number,
  opts: { viaFallback?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (rawSize > MAX_RESULT_BYTES) throw new AtlError('TOO_LARGE', `result exceeds ${MAX_RESULT_BYTES} bytes; upload large artifacts as attachments`);
  const run = await loadRun(ctx, s.sid, runId);
  requireUploadState(s, run);
  const body = (raw ?? null) as Record<string, unknown> | null;
  const problems: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) problems.push('body must be an object');
  else {
    if (body.schema !== 'atl.experiment-result/v1') problems.push('schema must be atl.experiment-result/v1');
    for (const k of ['runId', 'sessionId', 'labId', 'module', 'experiment', 'label'] as const) if (typeof body[k] !== 'string') problems.push(`${k} is required`);
    if (!isoOk(body.startedAt) || !isoOk(body.finishedAt)) problems.push('startedAt / finishedAt must be ISO times');
    const integ = body.integrity as { canonicalization?: unknown; digest?: unknown } | undefined;
    if (!integ || integ.canonicalization !== 'RFC8785' || typeof integ.digest !== 'string') problems.push('integrity { canonicalization: RFC8785, digest } is required');
  }
  if (problems.length) throw new AtlError('SCHEMA_INVALID', problems.join('; '));
  const b = body!;
  if (resultDigest(b) !== (b.integrity as { digest: string }).digest) throw new AtlError('DIGEST_MISMATCH', 'integrity.digest does not match the RFC 8785 digest of the result');
  const variant = (b.variant ?? {}) as { label?: unknown; cardVariant?: unknown };
  const runVariant = (run.variant ?? {}) as { cardVariant?: unknown };
  const mismatches = [
    b.runId !== runId && 'runId',
    b.sessionId !== s.sid && 'sessionId',
    b.labId !== s.labId && 'labId',
    b.module !== run.module && 'module',
    b.experiment !== run.experiment && 'experiment',
    b.label !== run.label && 'label',
    run.scenario && b.scenario !== run.scenario && 'scenario',
    variant.label !== undefined && variant.label !== run.label && 'variant.label',
    variant.cardVariant !== undefined && variant.cardVariant !== runVariant.cardVariant && 'variant.cardVariant',
  ].filter(Boolean);
  if (mismatches.length) throw new AtlError('RUN_MISMATCH', `result does not match the registration: ${mismatches.join(', ')}`);
  if (run.status !== 'registered') throw new AtlError('ALREADY_SUBMITTED', `run ${runId} already has a result`);
  const key = DataKeys.experiment(s.sid, runId);
  await ctx.deps.ports.objects.put(ctx.deps.env.buckets.data, key, JSON.stringify(b), { contentType: 'application/json' });
  const env = (b.environment ?? {}) as { drivers?: unknown; capabilitiesHashBefore?: unknown; capabilitiesHashAfter?: unknown };
  const finishedAt = String(b.finishedAt);
  try {
    await ctx.repos.sessions.updateChild(Keys.experimentRun(s.sid, runId), {
      set: {
        status: 'uploaded',
        startedAt: b.startedAt,
        finishedAt,
        forced: b.forced === true,
        ab: b.ab === true,
        s3Key: key,
        digest: (b.integrity as { digest: string }).digest,
        summary: { client: b.client ?? null, params: b.params ?? null, targets: b.targets ?? null },
        environment: { drivers: env.drivers ?? null },
        capabilitiesHash: env.capabilitiesHashAfter ?? env.capabilitiesHashBefore ?? null,
        validity: { status: 'pending-crosscheck', reasons: [] },
        uploadedBy: uploader,
        uploadedAt: ctx.nowIso,
        updatedAt: ctx.nowIso,
        ...Gsi1.experimentRun(s.sub, String(run.module), String(run.experiment), finishedAt),
      },
      remove: opts.viaFallback ? ['runTokenHash'] : [],
      condition: { expression: '#rs = :reg', names: { '#rs': 'status' }, values: { ':reg': 'registered' } },
    });
  } catch (e) {
    if (isConditionFailed(e)) throw new AtlError('ALREADY_SUBMITTED', `run ${runId} already has a result`);
    throw e;
  }
  await emitSessionEvents(ctx.deps, ctx.repos, s.sid, [
    { type: 'experiment_run.recorded', data: { runId, module: run.module, experiment: run.experiment, label: run.label, variant: run.variant } },
  ], { actor: 'user', envId: typeof s.envId === 'string' ? s.envId : null });
  try {
    await ctx.deps.ports.invoker.invokeAsync('atl-checks', { action: 'CrossCheckExperiment', sessionId: s.sid, runId });
  } catch (e) {
    // the record is stored; atl-checks also re-checks pending runs (04 §7.4 “稍后自动复核”)
    console.warn(JSON.stringify({ level: 'warn', msg: 'CrossCheckExperiment not dispatched', runId, error: String(e) }));
  }
  return { runId, status: 'corroborating' };
}

export async function getExperimentRunForAgent(ctx: ServiceContext, s: SessionItem, runId: string): Promise<Record<string, unknown>> {
  const run = await loadRun(ctx, s.sid, runId);
  requireUploadState(s, run);
  return experimentRunView(run);
}

export async function createAttachment(ctx: ServiceContext, s: SessionItem, runId: string, input: { name: string; contentType?: string | undefined; size?: number | undefined }): Promise<Record<string, unknown>> {
  requireAgentState(s, 'default');
  await loadRun(ctx, s.sid, runId);
  if (input.size !== undefined && input.size > MAX_ATTACHMENT_BYTES) throw new AtlError('TOO_LARGE', `attachments are limited to ${MAX_ATTACHMENT_BYTES} bytes`);
  const key = `${DataKeys.experiment(s.sid, runId).replace(/\.json$/, '')}/${input.name}`;
  const expiresInSeconds = 900;
  const uploadUrl = await ctx.deps.ports.objects.presign(ctx.deps.env.buckets.data, key, { method: 'PUT', expiresInSeconds });
  return { name: input.name, key, uploadUrl, method: 'PUT', expiresAt: new Date(ctx.nowMs + expiresInSeconds * 1000).toISOString(), headers: input.contentType ? { 'content-type': input.contentType } : {} };
}

// ---------------------------------------------------------------------------------------------------------------
// Module-op reports (01 §9.6): workstation (`source: agent`) and runner (`source: runner`)

export interface ModuleOpReport {
  opId?: string | undefined;
  phase: 'started' | 'finished';
  op: 'enable' | 'disable' | 'profile-apply' | 'status' | 'set';
  moduleId: string;
  actionId?: string | undefined;
  args?: Record<string, unknown> | undefined;
  exitCode?: number | undefined;
  summary?: string | undefined;
  runId?: string | undefined;
}

export async function reportModuleOp(ctx: ServiceContext, s: SessionItem, source: 'agent' | 'runner', r: ModuleOpReport): Promise<{ opId: string }> {
  const opId = r.opId ?? newUlid(ctx.nowMs);
  if (!/^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/.test(opId)) throw new AtlError('VALIDATION_FAILED', 'opId must be a ULID');
  const key = Keys.moduleOp(s.sid, opId.toUpperCase());
  const base = { source, op: r.op, moduleId: r.moduleId, actionId: r.actionId ?? null, args: r.args ?? {}, runId: r.runId ?? null };
  if (r.phase === 'started') {
    try {
      await ctx.repos.sessions.putChild({ ...key, type: 'ModuleOp', ver: 1, createdAt: ctx.nowIso, updatedAt: ctx.nowIso, opId, ...base, startedAt: ctx.nowIso, finishedAt: null, exitCode: null }, { expression: 'attribute_not_exists(PK)' });
    } catch (e) {
      if (!isConditionFailed(e)) throw e;
      return { opId };
    }
  } else {
    const existing = await ctx.repos.sessions.getChild(key);
    await ctx.repos.sessions.updateChild(key, {
      set: {
        ...(existing ? {} : { type: 'ModuleOp', ver: 1, createdAt: ctx.nowIso, opId, ...base, startedAt: null }),
        finishedAt: ctx.nowIso,
        exitCode: r.exitCode ?? null,
        summary: r.summary ?? null,
        updatedAt: ctx.nowIso,
      },
    });
  }
  const type = r.phase === 'started' ? 'module_op.started' : r.exitCode === 0 ? 'module_op.succeeded' : 'module_op.failed';
  await emitSessionEvents(ctx.deps, ctx.repos, s.sid, [{ type, data: { opId, moduleId: r.moduleId, op: r.op, source, ...(r.actionId ? { actionId: r.actionId } : {}) } }], {
    actor: source === 'runner' ? 'runner' : 'user',
    envId: typeof s.envId === 'string' ? s.envId : null,
  });
  return { opId };
}

// ---------------------------------------------------------------------------------------------------------------
// Runner reports (02 §4.3)

export interface ProgressLine {
  module?: string;
  resource?: unknown;
  status?: string;
  moduleIndex?: number;
  moduleTotal?: number;
  [k: string]: unknown;
}

const MAX_PROGRESS_LINES = 100;

export async function recordRunnerProgress(ctx: ServiceContext, runId: string, op: AtlOp, lines: ProgressLine[]): Promise<number> {
  const parsed = parseRunnerRunId(runId);
  if (!parsed) throw new AtlError('NOT_FOUND', `invalid runId ${runId}`);
  if (lines.length > MAX_PROGRESS_LINES) throw new AtlError('TOO_LARGE', `at most ${MAX_PROGRESS_LINES} progress lines per request`);
  const s = await ctx.repos.sessions.get(parsed.sid, true);
  if (!s) throw new AtlError('NOT_FOUND', `session ${parsed.sid} not found`);
  const events = lines.map((l) => ({
    type: 'session.progress' as const,
    data: {
      runId,
      module: l.module ?? null,
      resource: l.resource ?? null,
      status: l.status ?? null,
      ...(typeof l.moduleIndex === 'number' ? { moduleIndex: l.moduleIndex } : {}),
      ...(typeof l.moduleTotal === 'number' ? { moduleTotal: l.moduleTotal } : {}),
    },
  }));
  if (events.length) await emitSessionEvents(ctx.deps, ctx.repos, s.sid, events, { actor: 'runner', envId: typeof s.envId === 'string' ? s.envId : null });
  const last = lines[lines.length - 1];
  await ctx.repos.sessions.updateChild(Keys.runnerRun(s.sid, runId), {
    set: {
      type: 'RunnerRun',
      runId,
      op,
      attempt: parsed.n,
      resultKey: DataKeys.runResult(runId),
      ...(last ? { progress: { module: last.module ?? null, status: last.status ?? null, at: ctx.nowIso } } : {}),
      lastReportAt: ctx.nowIso,
      updatedAt: ctx.nowIso,
    },
  });
  return events.length;
}

export async function registerRunnerGrant(
  ctx: ServiceContext,
  runId: string,
  caller: { arn: string; sid: string; op: AtlOp },
  input: { roleSessionName?: string | undefined; issuedAt?: string | undefined; expiresAt?: string | undefined },
): Promise<Record<string, unknown>> {
  const expected = RoleSessionNames.prov(caller.sid, caller.op);
  if (input.roleSessionName && input.roleSessionName !== expected) throw new AtlError('CALLER_MISMATCH', 'roleSessionName must be the caller’s own session name');
  const channel = `prov-${caller.op}`;
  const existing = (await ctx.repos.sessions.children(caller.sid, SkPrefix.credentialChannel(channel), { all: true })).items.find((g) => g.runId === runId);
  if (existing) return { grantId: existing.grantId, roleSessionName: existing.roleSessionName, channel };
  const grantId = newUlid(ctx.nowMs);
  await ctx.repos.sessions.putChild({
    ...Keys.credentialGrant(caller.sid, channel, grantId),
    type: 'CredentialGrant',
    ver: 1,
    createdAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
    grantId,
    sessionId: caller.sid,
    roleSessionName: expected,
    channel,
    runId,
    issuedAt: input.issuedAt && isoOk(input.issuedAt) ? input.issuedAt : ctx.nowIso,
    expiresAt: input.expiresAt && isoOk(input.expiresAt) ? input.expiresAt : new Date(ctx.nowMs + 3_600_000).toISOString(),
    revokedAt: null,
  });
  return { grantId, roleSessionName: expected, channel };
}

export async function dispatch(ctx: ServiceContext, fn: 'atl-checks' | 'atl-certs' | 'atl-reaper', payload: Record<string, unknown>): Promise<void> {
  try {
    await ctx.deps.ports.invoker.invokeAsync(fn, payload);
  } catch (e) {
    mapDownstreamError(e, `${fn} ${String(payload.action)}`);
  }
}
