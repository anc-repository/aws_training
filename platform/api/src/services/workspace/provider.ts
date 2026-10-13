/**
 * `WorkspaceProvider` (routes/extensions.ts) — 03 §3.2 terminals, §5 console federation, §6.1 preview, §2.7 live
 * targets, and 01 §8.2 app-credentials. The route layer has already checked ownership, the access rule (02 §5.1),
 * recent login (`recentAuth` routes) and rate limits; it emits `terminal.*` / `console_link.issued` and audits.
 *
 * Identity: every AWS call that touches the environment uses the **learner** session obtained here —
 * `AssumeRole ATLLearnerRole` with `RoleSessionName = atl-<sid>-term | atl-<sid>-console` and `SourceIdentity = Cognito
 * username`; terminal sessions carry the 03 §3.2 session policy and `DurationSeconds = clamp(deadlineAt − now + 60 s,
 * 900, 3600)`, the console none of both (03 §5.3). Each issuance is registered as a `CredentialGrant` (01 §7.2).
 * Tokens and credentials are never stored or logged; `TerminalSession` keeps ids only (03 §9.2).
 */
import { AtlError, newUlid, RoleSessionNames, StackNames, ULID_RE, type JwtPrincipal } from '@atl/shared';
import { Keys, SkPrefix } from '../../data/keys.js';
import type { Item } from '../../repositories/index.js';
import type { ProviderResult, WorkspaceCallContext, WorkspaceProvider } from '../../routes/extensions.js';
import { CatalogStore } from '../catalog/store.js';
import { assumedRoleArn, type InstanceFacts, type LearnerCredentials, type WorkspaceAccess } from './access.js';
import { checkDestination, consoleHome, CONSOLE_LINKS, resolveConsoleLink } from './console-links.js';
import { cachedProber, createHttpsProber, previewEntries, previewTargets, type PreviewProber } from './preview.js';

/** `ClientVersion` of the browser data channel (= `PROTOCOL_COMPAT_VERSION` of @atl/ssm-client; tested). */
export const SSM_CLIENT_VERSION = '1.2.896.0';

/** 03 §3.2 / §3.3 constants. */
export const TERMINAL_LIMITS = { perInstance: 3, perSession: 6 } as const;
export const SESSION_SHELL = { document: 'ATL-SessionShell', loggedDocument: 'ATL-SessionShell-Logged', runAs: 'labuser', idleTimeoutMin: 20, maxDurationMin: 240 } as const;
export const CONNECT_BY_MS = 30_000;
export const CONSOLE_LINK_TTL_MS = 15 * 60_000;

const OPEN_STATES = ['OPENING', 'OPEN'];

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** STS `SourceIdentity`: 2–64 chars of `[\w+=,.@-]` (STS rule); the Cognito username, else the sub. */
export function sourceIdentityOf(p: Pick<JwtPrincipal, 'username' | 'sub'>): string {
  const ok = (v: string) => /^[\w+=,.@-]{2,64}$/.test(v);
  if (ok(p.username)) return p.username;
  const sub = p.sub.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
  return ok(sub) ? sub : `atl-${sub}`.slice(0, 64);
}

/** 03 §3.2 session policy for `atl-<sid>-term` (narrows ATLLearnerRole to “find targets + open / resume / end own terminals”). */
export function terminalSessionPolicy(p: { region: string; accountId: string; sid: string; envId: string }): string {
  const ssm = `arn:aws:ssm:${p.region}:${p.accountId}`;
  const own = `${ssm}:session/atl-${p.sid}-term-*`;
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'FindTargets', Effect: 'Allow', Action: ['ec2:DescribeInstances', 'ssm:DescribeInstanceInformation'], Resource: '*' },
      { Sid: 'OnlyThisEnvironmentsInstances', Effect: 'Allow', Action: 'ssm:StartSession', Resource: `arn:aws:ec2:${p.region}:${p.accountId}:instance/*`, Condition: { StringEquals: { 'ssm:resourceTag/atl:env-id': p.envId } } },
      { Sid: 'OnlyAtlSessionShell', Effect: 'Allow', Action: 'ssm:StartSession', Resource: [`${ssm}:document/ATL-SessionShell`, `${ssm}:document/ATL-SessionShell-Logged`] },
      { Sid: 'OwnSessionsOnly', Effect: 'Allow', Action: ['ssm:ResumeSession', 'ssm:TerminateSession'], Resource: own },
      { Sid: 'OpenOwnDataChannel', Effect: 'Allow', Action: 'ssmmessages:OpenDataChannel', Resource: own },
      { Sid: 'Reconcile', Effect: 'Allow', Action: 'ssm:DescribeSessions', Resource: '*' },
    ],
  });
}

/** 02 §5.1 truncation: the terminal credentials end with the session (900 s minimum, 1 h role-chaining maximum). */
export function terminalDurationSeconds(deadlineAt: string | null | undefined, nowMs: number): number {
  const left = typeof deadlineAt === 'string' ? Math.floor((Date.parse(deadlineAt) - nowMs) / 1000) + 60 : 3600;
  return Math.min(3600, Math.max(900, Number.isFinite(left) ? left : 3600));
}

/**
 * 03 §3.2 step 8: `wss://ssmmessages.<region>.amazonaws.com[.cn]/…` (or the dual-stack `ssmmessages.<region>.api.aws`),
 * no userinfo. Dev (`allowLoopback`) also accepts `ws://127.0.0.1|localhost:<port>/…`.
 */
export function isAcceptableStreamUrl(raw: string, region: string, allowLoopback = false): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (allowLoopback && (u.protocol === 'ws:' || u.protocol === 'wss:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return true;
  if (u.protocol !== 'wss:' || (u.port && u.port !== '443')) return false;
  return [`ssmmessages.${region}.amazonaws.com`, `ssmmessages.${region}.amazonaws.com.cn`, `ssmmessages.${region}.api.aws`].includes(u.hostname);
}

export interface WorkspaceTarget {
  instanceId: string;
  role: 'lab' | 'workstation';
  tab: 'terminal-lab' | 'terminal-workstation';
  launchTime: string | null;
  stackName: string | null;
  privateIp: string | null;
  publicIp: string | null;
}

/**
 * 03 §3.2 step 4: instances tagged for this environment are accepted only when the AWS-reserved tags put them in this
 * environment's CloudAlbum stacks (`cloudalbum-<envName>-*`, directly or through an ASG of those stacks) or — for the
 * workstation — in `atl-ws-<sid>`.
 */
export function acceptTargets(instances: readonly InstanceFacts[], q: { envName: string; sid: string }): WorkspaceTarget[] {
  const labPrefix = `cloudalbum-${q.envName}-`;
  const wsStack = StackNames.workstation(q.sid);
  const out: WorkspaceTarget[] = [];
  for (const i of instances) {
    if (i.state !== 'running') continue;
    const stack = i.tags['aws:cloudformation:stack-name'] ?? null;
    const asg = i.tags['aws:autoscaling:groupName'] ?? null;
    const role = i.tags['atl:role'];
    let as: WorkspaceTarget['role'] | null = null;
    if (role === 'lab-app' && ((stack && stack.startsWith(labPrefix)) || (asg && asg.startsWith(labPrefix)))) as = 'lab';
    if (role === 'workstation' && stack === wsStack) as = 'workstation';
    if (!as) continue;
    out.push({ instanceId: i.instanceId, role: as, tab: as === 'lab' ? 'terminal-lab' : 'terminal-workstation', launchTime: i.launchTime, stackName: stack, privateIp: i.privateIp, publicIp: i.publicIp });
  }
  return out.sort((a, b) => String(a.launchTime ?? '').localeCompare(String(b.launchTime ?? '')) || a.instanceId.localeCompare(b.instanceId));
}

type EnvInstance = { instanceId: string; role?: string; state?: string; prepared?: unknown };

function envInstances(ctx: WorkspaceCallContext): EnvInstance[] {
  const v = ctx.env?.instances;
  return Array.isArray(v) ? (v as EnvInstance[]).filter((i) => i && typeof i.instanceId === 'string') : [];
}

function envEndpoints(ctx: WorkspaceCallContext): Record<string, unknown> | null {
  const v = ctx.env?.endpoints;
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function result(status: number, body: unknown): ProviderResult {
  return { status, body };
}

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

function mapSsmError(e: unknown, instanceId: string | null): never {
  if (e instanceof AtlError) throw e;
  const name = errName(e);
  const message = e instanceof Error ? e.message : String(e);
  if (name === 'TargetNotConnected') throw new AtlError('TERMINAL_TARGET_NOT_CONNECTED', `the SSM agent of ${instanceId ?? 'the target'} is not connected`, { instanceId });
  if (name === 'InvalidDocument') throw new AtlError('INTERNAL', 'the platform document ATL-SessionShell is missing or unusable; redeploy the platform', { reason: 'INVALID_DOCUMENT' });
  if (name === 'AccessDeniedException' || name === 'AccessDenied') throw new AtlError('INTERNAL', `the learner role may not open terminals (${message}); this is a platform configuration problem`, { reason: 'ACCESS_DENIED' });
  throw e;
}

// ---------------------------------------------------------------------------------------------------------------

export interface WorkspaceProviderOptions {
  access: WorkspaceAccess;
  probe?: PreviewProber;
  /** Reuse learner terminal credentials while they have more than this left (one AssumeRole per minute otherwise). */
  credentialReuseMarginMs?: number;
}

export function createWorkspaceProvider(opts: WorkspaceProviderOptions): WorkspaceProvider {
  const access = opts.access;
  const margin = opts.credentialReuseMarginMs ?? 5 * 60_000;
  const termCreds = new Map<string, LearnerCredentials>();
  let probe: PreviewProber | null = opts.probe ?? null;

  async function putGrant(ctx: WorkspaceCallContext, channel: 'term' | 'console', roleSessionName: string, creds: LearnerCredentials): Promise<void> {
    const ulid = newUlid(ctx.nowMs);
    const now = new Date(ctx.nowMs).toISOString();
    await ctx.repos.sessions.putChild({
      ...Keys.credentialGrant(ctx.session.sid, channel, ulid),
      type: 'CredentialGrant',
      ver: 1,
      createdAt: now,
      updatedAt: now,
      sessionId: ctx.session.sid,
      roleSessionName,
      channel,
      issuedAt: now,
      expiresAt: creds.expiration,
      revokedAt: null,
      issuedBy: ctx.principal.sub,
    });
  }

  function envOf(ctx: WorkspaceCallContext): { envId: string; envName: string } {
    const env = ctx.env;
    if (!env?.envId || !env.envName) throw new AtlError('TERMINAL_TARGET_NOT_IN_SESSION', 'the session holds no environment');
    return { envId: env.envId, envName: env.envName };
  }

  /** `atl-<sid>-term` credentials (cached per container while > 5 min remain; a new grant per issuance). */
  async function terminalCredentials(ctx: WorkspaceCallContext): Promise<LearnerCredentials> {
    const { envId } = envOf(ctx);
    const key = `${ctx.session.sid}|${envId}`;
    const cached = termCreds.get(key);
    if (cached && Date.parse(cached.expiration) - ctx.nowMs > margin) return cached;
    const roleSessionName = RoleSessionNames.term(ctx.session.sid);
    const creds = await access.assumeLearner({
      roleSessionName,
      sourceIdentity: sourceIdentityOf(ctx.principal),
      policy: terminalSessionPolicy({ region: ctx.deps.env.region, accountId: ctx.deps.env.accountId, sid: ctx.session.sid, envId }),
      durationSeconds: terminalDurationSeconds(ctx.session.deadlineAt as string | undefined, ctx.nowMs),
    });
    await putGrant(ctx, 'term', roleSessionName, creds);
    if (termCreds.size > 200) termCreds.clear();
    termCreds.set(key, creds);
    return creds;
  }

  async function liveTargets(ctx: WorkspaceCallContext, creds: LearnerCredentials, roles: readonly string[]): Promise<WorkspaceTarget[]> {
    const { envId, envName } = envOf(ctx);
    const instances = await access.describeInstances(creds, { envId, envName, sid: ctx.session.sid, roles });
    return acceptTargets(instances, { envName, sid: ctx.session.sid });
  }

  function preparedOf(ctx: WorkspaceCallContext, instanceId: string): boolean | null {
    const entry = envInstances(ctx).find((i) => i.instanceId === instanceId);
    return typeof entry?.prepared === 'boolean' ? entry.prepared : null;
  }

  function streamOk(url: string, region: string): boolean {
    return isAcceptableStreamUrl(url, region, access.allowLoopbackStreamUrl);
  }

  async function openTerminals(ctx: WorkspaceCallContext): Promise<Item[]> {
    const items = (await ctx.repos.sessions.children(ctx.session.sid, SkPrefix.terminal, { all: true })).items;
    return items.filter((t) => OPEN_STATES.includes(String(t.status)));
  }

  /** 03 §3.2 step 2: close entries that SSM no longer has (browser crashed, idle timeout) before counting. */
  async function reconcile(ctx: WorkspaceCallContext, creds: LearnerCredentials, open: Item[]): Promise<Item[]> {
    const staleBefore = ctx.nowMs - (SESSION_SHELL.idleTimeoutMin + 5) * 60_000;
    const stale = open.filter((t) => Date.parse(String(t.lastResumedAt ?? t.openedAt ?? '')) < staleBefore);
    if (!stale.length) return open;
    const active = await access.activeSessionIds(creds, { ownerArn: assumedRoleArn(ctx.deps.env.accountId, RoleSessionNames.term(ctx.session.sid)) }).catch(() => null);
    if (!active) return open;
    const closedAt = new Date(ctx.nowMs).toISOString();
    const keep: Item[] = [];
    for (const t of open) {
      if (stale.includes(t) && !active.has(String(t.ssmSessionId))) {
        await ctx.repos.sessions.updateChild(Keys.terminalSession(ctx.session.sid, String(t.terminalId)), { set: { status: 'CLOSED', closedAt, closeReason: 'reconciled', updatedAt: closedAt } }).catch(() => undefined);
      } else keep.push(t);
    }
    return keep;
  }

  return {
    async openTerminal(ctx, body): Promise<ProviderResult> {
      const sid = ctx.session.sid;
      if (body.target === 'workstation' && (ctx.session.workstation as { mode?: string } | undefined)?.mode === 'cloudshell') {
        throw new AtlError('TERMINAL_TARGET_NOT_IN_SESSION', 'this session has no workstation (CloudShell savings mode)');
      }
      const creds = await terminalCredentials(ctx);
      const open = await reconcile(ctx, creds, await openTerminals(ctx));
      const targets = (await liveTargets(ctx, creds, [body.target === 'lab' ? 'lab-app' : 'workstation'])).filter((t) => t.role === body.target);
      const target = body.instanceId ? targets.find((t) => t.instanceId === body.instanceId) : targets[0];
      if (!target) throw new AtlError('TERMINAL_TARGET_NOT_IN_SESSION', body.instanceId ? `instance ${body.instanceId} is not a ${body.target} instance of this environment` : `no running ${body.target} instance in this environment`);
      const onInstance = open.filter((t) => t.instanceId === target.instanceId).length;
      if (onInstance >= TERMINAL_LIMITS.perInstance || open.length >= TERMINAL_LIMITS.perSession) {
        throw new AtlError('TERMINAL_LIMIT', `at most ${TERMINAL_LIMITS.perInstance} terminals per instance and ${TERMINAL_LIMITS.perSession} per session`, { open: open.length, onInstance });
      }
      const ping = (await access.pingStatus(creds, [target.instanceId]))[target.instanceId] ?? 'NotRegistered';
      if (ping !== 'Online') throw new AtlError('TERMINAL_TARGET_NOT_CONNECTED', `the SSM agent of ${target.instanceId} is ${ping}`, { instanceId: target.instanceId, pingStatus: ping });
      if (preparedOf(ctx, target.instanceId) === false) throw new AtlError('TERMINAL_TARGET_NOT_PREPARED', `platform preparation of ${target.instanceId} has not finished`, { instanceId: target.instanceId });
      const recording = (ctx.config?.terminal as { recording?: string } | undefined)?.recording === 'cloudwatch';
      const document = recording ? SESSION_SHELL.loggedDocument : SESSION_SHELL.document;
      let grant;
      try {
        grant = await access.startSession(creds, { target: target.instanceId, documentName: document, reason: `ATL web terminal ${sid}`, sessionName: RoleSessionNames.term(sid), role: body.target });
      } catch (e) {
        mapSsmError(e, target.instanceId);
      }
      if (!streamOk(grant.streamUrl, ctx.deps.env.region)) {
        await access.terminateSession(creds, grant.sessionId).catch(() => undefined);
        throw new AtlError('UPSTREAM_UNAVAILABLE', 'StartSession returned a StreamUrl outside ssmmessages.<region>.amazonaws.com', { reason: 'STREAM_URL_REJECTED' });
      }
      const terminalId = newUlid(ctx.nowMs);
      const now = new Date(ctx.nowMs).toISOString();
      await ctx.repos.sessions.putChild({
        ...Keys.terminalSession(sid, terminalId),
        type: 'TerminalSession',
        ver: 1,
        createdAt: now,
        updatedAt: now,
        terminalId,
        ssmSessionId: grant.sessionId,
        instanceId: target.instanceId,
        tab: target.tab,
        target: body.target,
        document,
        runAs: SESSION_SHELL.runAs,
        clientId: body.clientId ?? null,
        openedBy: ctx.principal.sub,
        openedAt: now,
        status: 'OPEN',
        resumeCount: 0,
        lastResumedAt: null,
        closedAt: null,
        closeReason: null,
        size: body.cols && body.rows ? { cols: body.cols, rows: body.rows } : null,
      });
      return result(201, {
        terminalId,
        ssmSessionId: grant.sessionId,
        instanceId: target.instanceId,
        tab: target.tab,
        streamUrl: grant.streamUrl,
        tokenValue: grant.tokenValue,
        document,
        runAs: SESSION_SHELL.runAs,
        idleTimeoutMin: SESSION_SHELL.idleTimeoutMin,
        maxDurationMin: SESSION_SHELL.maxDurationMin,
        connectBy: new Date(ctx.nowMs + CONNECT_BY_MS).toISOString(),
        clientVersion: SSM_CLIENT_VERSION,
        recording,
      });
    },

    async resumeTerminal(ctx, terminalId, body): Promise<ProviderResult> {
      const sid = ctx.session.sid;
      if (!ULID_RE.test(terminalId)) throw new AtlError('NOT_FOUND', 'terminal not found');
      const key = Keys.terminalSession(sid, terminalId);
      const t = await ctx.repos.sessions.getChild(key);
      if (!t) throw new AtlError('NOT_FOUND', 'terminal not found');
      if (!OPEN_STATES.includes(String(t.status))) throw new AtlError('TERMINAL_GONE', `terminal ${terminalId} is closed; open a new one`, { terminalId });
      const creds = await terminalCredentials(ctx);
      let grant;
      try {
        grant = await access.resumeSession(creds, String(t.ssmSessionId));
      } catch (e) {
        if (errName(e) === 'DoesNotExistException') {
          const now = new Date(ctx.nowMs).toISOString();
          await ctx.repos.sessions.updateChild(key, { set: { status: 'CLOSED', closedAt: now, closeReason: 'gone', updatedAt: now } }).catch(() => undefined);
          throw new AtlError('TERMINAL_GONE', `the SSM session of terminal ${terminalId} has ended; open a new one`, { terminalId });
        }
        mapSsmError(e, String(t.instanceId));
      }
      if (!streamOk(grant.streamUrl, ctx.deps.env.region)) throw new AtlError('UPSTREAM_UNAVAILABLE', 'ResumeSession returned a StreamUrl outside ssmmessages.<region>.amazonaws.com', { reason: 'STREAM_URL_REJECTED' });
      const now = new Date(ctx.nowMs).toISOString();
      await ctx.repos.sessions.updateChild(key, {
        set: { status: 'OPEN', lastResumedAt: now, updatedAt: now, ...(body.clientId ? { clientId: body.clientId } : {}) },
        add: { resumeCount: 1 },
      });
      return result(200, {
        terminalId,
        ssmSessionId: grant.sessionId,
        instanceId: t.instanceId ?? null,
        streamUrl: grant.streamUrl,
        tokenValue: grant.tokenValue,
        connectBy: new Date(ctx.nowMs + CONNECT_BY_MS).toISOString(),
        clientVersion: SSM_CLIENT_VERSION,
      });
    },

    async closeTerminal(ctx, terminalId): Promise<ProviderResult> {
      const sid = ctx.session.sid;
      if (!ULID_RE.test(terminalId)) throw new AtlError('NOT_FOUND', 'terminal not found');
      const key = Keys.terminalSession(sid, terminalId);
      const t = await ctx.repos.sessions.getChild(key);
      if (!t) throw new AtlError('NOT_FOUND', 'terminal not found');
      if (!OPEN_STATES.includes(String(t.status))) return result(204, null);
      try {
        // after access was revoked atl-lifecycle terminates every session itself (02 §6.2); only mark the entry
        const canTerminate = ['READY', 'RUNNING', 'EXPIRING'].includes(ctx.session.state) && !ctx.session.revokedAt;
        if (canTerminate) await access.terminateSession(await terminalCredentials(ctx), String(t.ssmSessionId));
      } catch (e) {
        console.warn(JSON.stringify({ level: 'warn', msg: 'TerminateSession failed; marking the terminal closed', sid, terminalId, error: errName(e) || String(e) }));
      }
      const now = new Date(ctx.nowMs).toISOString();
      await ctx.repos.sessions.updateChild(key, { set: { status: 'CLOSED', closedAt: now, closeReason: 'user', updatedAt: now } });
      return result(204, null);
    },

    async consoleLink(ctx, body): Promise<ProviderResult> {
      const sid = ctx.session.sid;
      const region = ctx.deps.env.region;
      const params = (body as { params?: Record<string, string> }).params ?? {};
      let destination: string;
      let linkId: string | null = body.linkId ?? null;
      let fallback = false;
      if (body.destination) {
        const ok = checkDestination(body.destination, region);
        if (!ok) throw new AtlError('CONSOLE_DESTINATION_NOT_ALLOWED', 'destination must be an https URL on an AWS console host of the registry');
        destination = ok;
      } else if (body.linkId) {
        const labInstance = envInstances(ctx).find((i) => i.role === 'lab-app')?.instanceId;
        const r = resolveConsoleLink(body.linkId, region, { ...(labInstance ? { instanceId: labInstance } : {}), ...params });
        if (!r) throw new AtlError('CONSOLE_DESTINATION_NOT_ALLOWED', `linkId ${body.linkId} is not in the console deep-link registry`);
        destination = r.url;
        fallback = r.fallback;
      } else {
        const lab = typeof ctx.session.catalogVersion === 'string' ? await new CatalogStore(ctx.deps, ctx.repos.platform).lab(ctx.session.labId, ctx.session.catalogVersion).catch(() => null) : null;
        const first = (lab?.platform?.consoleLinks ?? []).find((id) => CONSOLE_LINKS[id] && Object.keys(CONSOLE_LINKS[id]!.params).length === 0);
        const r = first ? resolveConsoleLink(first, region) : null;
        destination = r?.url ?? consoleHome(region);
        linkId = r ? first! : null;
      }
      const roleSessionName = RoleSessionNames.console(sid);
      // no DurationSeconds / SessionDuration: role chaining (03 §5.3) — the console session is the credentials' hour
      const creds = await access.assumeLearner({ roleSessionName, sourceIdentity: sourceIdentityOf(ctx.principal) });
      await putGrant(ctx, 'console', roleSessionName, creds);
      let endpoint: string | null = null;
      let token: string | null = null;
      for (const ep of access.federationEndpoints(region)) {
        try {
          token = await access.getSigninToken(ep, creds);
          endpoint = ep;
          break;
        } catch (e) {
          console.warn(JSON.stringify({ level: 'warn', msg: 'federation endpoint failed', endpoint: ep, sid, error: errName(e) || 'error' }));
        }
      }
      if (!token || !endpoint) throw new AtlError('CONSOLE_FEDERATION_FAILED', 'the AWS federation endpoint did not issue a sign-in token; try again', { retryAfterSeconds: 10 });
      const platformUrl = typeof ctx.config?.platformUrl === 'string' ? ctx.config.platformUrl.replace(/\/+$/, '') : null;
      const fields: Record<string, string> = {
        Action: 'login',
        ...(platformUrl ? { Issuer: `${platformUrl}/workspace/${sid}?from=console` } : {}),
        Destination: destination,
        SigninToken: token,
      };
      const now = new Date(ctx.nowMs).toISOString();
      return result(200, {
        form: { action: endpoint, method: 'POST', fields },
        url: `${endpoint}?${new URLSearchParams(fields).toString()}`,
        issuedAt: now,
        expiresAt: new Date(ctx.nowMs + CONSOLE_LINK_TTL_MS).toISOString(),
        consoleSessionExpiresAt: creds.expiration,
        deepLink: destination,
        linkId,
        fallback,
        roleSessionName,
        role: 'ATLLearnerRole',
        region,
      });
    },

    async appCredentials(ctx): Promise<ProviderResult> {
      const env = ctx.env;
      if (!env?.envName) throw new AtlError('NOT_FOUND', 'the session holds no environment');
      const admin = await access.appAdmin({ envId: env.envId, envName: env.envName });
      if (!admin) throw new AtlError('NOT_FOUND', 'the CloudAlbum administrator password has not been written yet');
      const ep = envEndpoints(ctx);
      const baseUrl = typeof ep?.baseUrl === 'string' ? ep.baseUrl : null;
      return result(200, { username: admin.username, password: admin.password, loginUrl: baseUrl, envName: env.envName });
    },

    async preview(ctx): Promise<ProviderResult> {
      probe ??= cachedProber(createHttpsProber(), () => Date.now());
      const platformUrl = typeof ctx.config?.platformUrl === 'string' ? ctx.config.platformUrl : null;
      const origin = platformUrl ? new URL(platformUrl).origin : 'null';
      const entries = previewEntries(envEndpoints(ctx), (ctx.session.app ?? null) as { entryUrl?: string | null } | null);
      const targets = await previewTargets(entries, origin, probe);
      const def = targets.find((t) => t.embeddable) ?? targets[0];
      return result(200, { sessionId: ctx.session.sid, available: targets.length > 0, default: def?.id ?? null, targets, probedAt: new Date(ctx.nowMs).toISOString() });
    },

    async describeTargets(ctx): Promise<unknown[]> {
      const creds = await terminalCredentials(ctx);
      const ws = (ctx.session.workstation as { mode?: string } | undefined)?.mode !== 'cloudshell';
      const targets = await liveTargets(ctx, creds, ws ? ['lab-app', 'workstation'] : ['lab-app']);
      const ping = targets.length ? await access.pingStatus(creds, targets.map((t) => t.instanceId)) : {};
      const primaryLab = targets.find((t) => t.role === 'lab')?.instanceId;
      return targets.map((t) => ({
        tab: t.tab,
        role: t.role === 'lab' ? 'lab-app' : 'workstation',
        instanceId: t.instanceId,
        primary: t.role === 'workstation' || t.instanceId === primaryLab,
        runAs: SESSION_SHELL.runAs,
        awsIdentity: t.role === 'lab' ? 'CloudAlbumAppRole' : `ATLLearnerRole (${RoleSessionNames.ws(ctx.session.sid)})`,
        ssmPing: ping[t.instanceId] ?? 'NotRegistered',
        prepared: preparedOf(ctx, t.instanceId),
        ...(t.role === 'workstation' ? { wired: (ctx.session.workstation as { wired?: boolean } | undefined)?.wired ?? null } : { placement: t.publicIp ? 'public' : 'private' }),
        stackName: t.stackName,
        launchTime: t.launchTime,
        cached: false,
      }));
    },
  };
}
