/**
 * Workspace routes (01 §8.2 “工作台”, 03 §2.7, §3.2, §5, §6.1, §7.4). The route layer enforces the access rule of
 * 02 §5.1 (READY/RUNNING/EXPIRING, `now < deadlineAt`, access not revoked), per-user rate limits, audit and
 * `terminal.*` / `console_link.issued` events; SSM / STS / federation work is done by the workspace provider (03).
 */
import { AtlError, type SessionState } from '@atl/shared';
import { SkPrefix } from '../data/keys.js';
import { accepted, created, NO_STORE, noContent, ok } from '../http/responses.js';
import type { RouteHandlers } from '../http/router.js';
import { json, type HttpResult } from '../http/types.js';
import { parseBody, z } from '../http/validate.js';
import { stripKeys, type SessionItem } from '../repositories/index.js';
import { emitSessionEvents, sanitizeWorkspaceEvents } from '../services/events/index.js';
import { auditOk, canIssueAccess, loadSession, platformConfig, principalOf, rateLimit, type ApiContext } from './context.js';
import type { ApiExtensions, ProviderResult, WorkspaceCallContext, WorkspaceProvider } from './extensions.js';
import { notProvided, wrap } from './platform.js';
import { CONSOLE_LINKS } from '../services/workspace/console-links.js';

async function callContext(ctx: ApiContext, s: SessionItem): Promise<WorkspaceCallContext> {
  const [env, config] = await Promise.all([typeof s.envId === 'string' ? ctx.repos.environments.get(s.envId) : Promise.resolve(null), platformConfig(ctx)]);
  return { deps: ctx.deps, repos: ctx.repos, session: s, env, config, principal: principalOf(ctx), nowMs: ctx.nowMs, requestId: ctx.req.requestId };
}

function provider(ctx: ApiContext): WorkspaceProvider {
  const p = ctx.ext.workspace;
  if (!p) throw notProvided('workspace provider (03: SSM terminals, console federation)');
  return p;
}

function result(r: ProviderResult): HttpResult {
  return json(r.status, r.body, { ...NO_STORE, ...(r.headers ?? {}) });
}

function requireAccess(ctx: ApiContext, s: SessionItem, code: 'TERMINAL_SESSION_STATE' | 'CONSOLE_SESSION_STATE' | 'INVALID_STATE'): void {
  if (!canIssueAccess(s, ctx.nowMs)) {
    throw new AtlError(code, `access cannot be issued while the session is ${s.state}${s.revokedAt ? ' (access revoked)' : ''}`, { state: s.state });
  }
}

const PREVIEW_STATES: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING', 'KEPT'];

export function workspaceRoutes(ext: ApiExtensions): RouteHandlers {
  return {
    getWorkspace: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const wctx = await callContext(ctx, s);
      const env = wctx.env;
      const [terminals, consoleGrants, lab] = await Promise.all([
        ctx.repos.sessions.children(s.sid, SkPrefix.terminal, { all: true }),
        ctx.repos.sessions.children(s.sid, SkPrefix.credentialChannel('console'), { all: true }),
        typeof s.catalogVersion === 'string' ? ctx.catalog.lab(s.labId, s.catalogVersion).catch(() => null) : Promise.resolve(null),
      ]);
      // live discovery (03 §2.7) runs as the learner (it assumes atl-<sid>-term with the caller as SourceIdentity), so
      // assistants and observers (01 §5.2: never AWS credentials) see the cached Environment.instances; any failure too
      const live =
        ext.workspace?.describeTargets && canIssueAccess(s, ctx.nowMs) && principalOf(ctx).groups.includes('learner')
          ? await ext.workspace.describeTargets(wctx).catch((e: unknown) => {
              console.warn(JSON.stringify({ level: 'warn', msg: 'workspace target discovery failed', sid: s.sid, error: e instanceof Error ? e.name : String(e) }));
              return null;
            })
          : null;
      const cached = Array.isArray(env?.instances) ? (env!.instances as Record<string, unknown>[]) : [];
      const targets = live ?? cached.map((i) => ({ tab: i.role === 'workstation' ? 'terminal-workstation' : 'terminal-lab', ...i, cached: true }));
      const lastConsole = consoleGrants.items.sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)))[0];
      const terminal = (wctx.config?.terminal ?? {}) as { recording?: string; persistence?: string; streamUrlSigning?: string };
      const ow = s.outageWindow as { until?: string; reason?: string; stepId?: string; actionId?: string; channel?: string } | null | undefined;
      return ok({
        sessionId: s.sid,
        labId: s.labId,
        variant: s.variant ?? 'default',
        state: s.state,
        envId: env?.envId ?? s.envId ?? null,
        envName: env?.envName ?? null,
        region: wctx.config?.region ?? ctx.deps.env.region,
        access: { available: canIssueAccess(s, ctx.nowMs), revokedAt: s.revokedAt ?? null, deadlineAt: s.deadlineAt ?? null },
        targets,
        terminals: terminals.items.map((t) => stripKeys(t)),
        console: {
          available: canIssueAccess(s, ctx.nowMs),
          lastIssuedAt: lastConsole?.issuedAt ?? null,
          credentialsExpireAt: lastConsole?.expiresAt ?? null,
          links: (lab?.platform?.consoleLinks ?? []).map((linkId) => ({ linkId, label: CONSOLE_LINKS[linkId]?.label ?? null, registered: !!CONSOLE_LINKS[linkId] })),
        },
        features: {
          workstation: (s.workstation as { mode?: string } | undefined)?.mode ?? 'ec2',
          terminalRecording: terminal.recording ?? 'off',
          terminalPersistence: terminal.persistence ?? 'none',
          streamUrlSigning: terminal.streamUrlSigning ?? 'none',
          previewDirectHttps: lab?.startProfile?.platform?.preview?.directHttps ?? null,
          provider: !!ext.workspace,
        },
        expectedOutage: ow && ow.until && Date.parse(ow.until) > ctx.nowMs ? { reason: ow.reason ?? null, channel: ow.channel ?? null, stepId: ow.stepId ?? null, actionId: ow.actionId ?? null, until: ow.until } : null,
        serverNow: ctx.nowIso,
      });
    }),

    postWorkspaceEvents: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(
        z.object({ events: z.array(z.object({ type: z.string().max(64), data: z.record(z.string(), z.unknown()).optional(), at: z.string().max(40).optional() }).strict()).min(1).max(50) }).strict(),
        ctx.req.body,
      );
      rateLimit(ctx, 'workspaceEvents', s.sid, await platformConfig(ctx));
      const events = sanitizeWorkspaceEvents(body.events);
      await emitSessionEvents(ctx.deps, ctx.repos, s.sid, events, { actor: 'user', envId: typeof s.envId === 'string' ? s.envId : null });
      return accepted({ accepted: events.length });
    }),

    listTerminals: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const items = (await ctx.repos.sessions.children(s.sid, SkPrefix.terminal, { all: true })).items;
      return ok(items.map((t) => stripKeys(t)));
    }),

    createTerminal: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(
        z
          .object({
            target: z.enum(['lab', 'workstation']),
            instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/).optional(),
            cols: z.number().int().min(10).max(500).optional(),
            rows: z.number().int().min(5).max(300).optional(),
            clientId: z.string().max(64).optional(),
          })
          .strict(),
        ctx.req.body,
      );
      requireAccess(ctx, s, 'TERMINAL_SESSION_STATE');
      const p = provider(ctx);
      rateLimit(ctx, 'terminal', principalOf(ctx).sub, await platformConfig(ctx));
      const r = await p.openTerminal(await callContext(ctx, s), body);
      if (r.status < 300) {
        const b = r.body as { terminalId?: string; instanceId?: string } | null;
        await emitSessionEvents(ctx.deps, ctx.repos, s.sid, [{ type: 'terminal.opened', data: { terminalId: b?.terminalId ?? null, target: body.target, instanceId: b?.instanceId ?? null } }]);
        await auditOk(ctx, 'terminal.start', { sessionId: s.sid, target: b?.instanceId ?? body.target });
      }
      return r.status === 201 ? created(r.body) : result(r);
    }),

    resumeTerminal: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(z.object({ clientId: z.string().max(64).optional() }).strict(), ctx.req.body);
      requireAccess(ctx, s, 'TERMINAL_SESSION_STATE');
      const p = provider(ctx);
      rateLimit(ctx, 'terminal', principalOf(ctx).sub, await platformConfig(ctx));
      return result(await p.resumeTerminal(await callContext(ctx, s), ctx.req.params.terminalId ?? '', body));
    }),

    deleteTerminal: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const p = provider(ctx);
      const terminalId = ctx.req.params.terminalId ?? '';
      const r = await p.closeTerminal(await callContext(ctx, s), terminalId);
      if (r.status < 300) {
        await emitSessionEvents(ctx.deps, ctx.repos, s.sid, [{ type: 'terminal.closed', data: { terminalId } }]);
        await auditOk(ctx, 'terminal.stop', { sessionId: s.sid, target: terminalId });
      }
      return r.status === 204 ? noContent() : result(r);
    }),

    createConsoleLink: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      const body = parseBody(
        z
          .object({
            destination: z.string().max(2048).optional(),
            linkId: z.string().max(64).optional(),
            // deep-link parameters of the registry entry (validated against its regexes, 03 §5.4)
            params: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,31}$/), z.string().max(1024)).optional(),
          })
          .strict(),
        ctx.req.body ?? {},
      );
      requireAccess(ctx, s, 'CONSOLE_SESSION_STATE');
      const p = provider(ctx);
      rateLimit(ctx, 'consoleLink', principalOf(ctx).sub, await platformConfig(ctx));
      const r = await p.consoleLink(await callContext(ctx, s), body);
      if (r.status < 300) {
        const b = r.body as { consoleSessionExpiresAt?: string } | null;
        await emitSessionEvents(ctx.deps, ctx.repos, s.sid, [{ type: 'console_link.issued', data: { expiresAt: b?.consoleSessionExpiresAt ?? null, linkId: body.linkId ?? null } }]);
        await auditOk(ctx, 'console_link.issue', { sessionId: s.sid, target: body.linkId ?? body.destination ?? 'home' });
      }
      return result(r);
    }),

    getPreview: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      if (!PREVIEW_STATES.includes(s.state)) return ok({ sessionId: s.sid, available: false, reason: 'SESSION_STATE', state: s.state, targets: [] });
      const wctx = await callContext(ctx, s);
      if (ext.workspace?.preview) return result(await ext.workspace.preview(wctx));
      const app = (s.app ?? null) as { entryUrl?: string | null; embeddable?: boolean; reason?: string } | null;
      const endpoints = (wctx.env?.endpoints ?? {}) as { baseUrl?: string | null; https?: { trusted?: boolean } | null };
      const url = app?.entryUrl ?? endpoints.baseUrl ?? null;
      const embeddable = app?.embeddable ?? (url ? url.startsWith('https://') && !!endpoints.https?.trusted : false);
      return ok({
        sessionId: s.sid,
        available: !!url,
        targets: url
          ? [{ id: 'app', url, embeddable, reason: embeddable ? null : (app?.reason ?? (url.startsWith('http://') ? 'MIXED_CONTENT' : 'UNTRUSTED_CERT')), probed: false }]
          : [],
      });
    }),

    getAppCredentials: wrap(ext, async (ctx) => {
      const s = await loadSession(ctx, ctx.req.params.sid);
      requireAccess(ctx, s, 'INVALID_STATE');
      const p = provider(ctx);
      const r = await p.appCredentials(await callContext(ctx, s));
      if (r.status < 300) await auditOk(ctx, 'app_credentials.reveal', { sessionId: s.sid });
      return result(r);
    }),
  };
}
