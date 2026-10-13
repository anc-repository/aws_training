/**
 * The API's only path into session state changes (01 §7.5 item 2, 02 §3.3, §5.4): synchronous calls of
 * `atl-lifecycle` actions and the short workflows that `atl-api` may start (01 §3.3).
 *
 * Contract with atl-lifecycle (payload `{ action, … }`, errors thrown with `name = Atl.<…>`):
 *
 * | action          | payload                                                                     | result                    |
 * |-----------------|-----------------------------------------------------------------------------|---------------------------|
 * | `CreateSession` | `{ session: <LabSession draft>, actor }` — T01, writes `REQUESTED`, ver 1   | `{ sessionId, state, ver }`|
 * | `Transition`    | `{ sessionId, from[], to, reason, expectedVer?, actor }` (T04, T07, T08)    | session item              |
 * | `Extend`        | `{ sessionId, minutes, quoteId, expectedDeadlineVersion, actor }` (02 §5.4) | session item              |
 * | `ExtendKeep`    | `{ sessionId, hours, quoteId, expectedKeepVersion, actor }` (T13, 02 §8)    | session item              |
 *
 * `Atl.TransitionRejected` → 409 `INVALID_STATE`; `Atl.<CODE>` with a registered error code → that code;
 * `Atl.NotImplemented` → 501. Workflow starts use the deterministic execution names of 02 §2.7;
 * `ExecutionAlreadyExists` within the same phase means “somebody is already doing it”.
 */
import {
  AtlError,
  ERROR_CODES,
  ExecutionNames,
  isPortError,
  PortError,
  type ErrorCode,
  type StateMachineName,
} from '@atl/shared';
import type { FunctionDeps } from '../../runtime/deps.js';
import type { SessionItem } from '../../repositories/index.js';

export interface Actor {
  sub: string;
  role: string;
  via: 'web' | 'agent' | 'internal' | 'system';
}

/** Raised when a downstream function or port is not implemented yet (rendered as 501 by the router). */
export class DownstreamNotImplemented extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'Atl.NotImplemented';
  }
}

export function mapDownstreamError(e: unknown, what: string): never {
  if (e instanceof AtlError) throw e;
  if (isPortError(e)) {
    if (e.code === 'NotImplemented') throw new DownstreamNotImplemented(what);
    if (e.code === 'Throttled') throw new AtlError('UPSTREAM_THROTTLED', `${what}: ${e.message}`, { retryAfterSeconds: 5 });
    if (e.code === 'Unavailable' || e.code === 'NotFound') throw new AtlError('UPSTREAM_UNAVAILABLE', `${what}: ${e.message}`, { retryAfterSeconds: 10 });
    throw e;
  }
  const name = (e as { name?: string } | null)?.name ?? '';
  const message = (e as { message?: string } | null)?.message ?? String(e);
  if (name === 'Atl.NotImplemented') throw new DownstreamNotImplemented(what);
  const code = apiCodeOf(name, message);
  if (code) throw new AtlError(code, message.replace(/^[A-Z_]+: /, ''));
  throw e;
}

/** `Atl.*` names whose API code is not the plain UPPER_SNAKE form of the name. */
const NAME_ALIASES: Readonly<Record<string, ErrorCode>> = {
  TransitionRejected: 'INVALID_STATE',
  AlreadyTerminal: 'INVALID_STATE',
  SessionNotRunning: 'INVALID_STATE',
  InvalidInput: 'VALIDATION_FAILED',
  CostNotAcknowledged: 'COST_ACK_REQUIRED',
  Throttled: 'UPSTREAM_THROTTLED',
  Unavailable: 'UPSTREAM_UNAVAILABLE',
};

/**
 * Map an error name thrown by a synchronous `atl-*` call to an API error code: `Atl.<CODE>` (UPPER_SNAKE),
 * `Atl.<CamelCase>` (e.g. `Atl.QuoteExpired` → `QUOTE_EXPIRED`), the aliases above, and `Atl.LockBusy` whose message
 * starts with the detail code (`SESSION_ACTIVE_EXISTS: …`).
 */
export function apiCodeOf(name: string, message = ''): ErrorCode | null {
  if (!name.startsWith('Atl.')) return null;
  const bare = name.slice(4);
  if (bare === 'LockBusy') {
    const m = /^([A-Z_]+):/.exec(message);
    return m && m[1]! in ERROR_CODES ? (m[1] as ErrorCode) : 'SESSION_ACTIVE_EXISTS';
  }
  if (NAME_ALIASES[bare]) return NAME_ALIASES[bare];
  if (bare in ERROR_CODES) return bare as ErrorCode;
  const snake = bare.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  return snake in ERROR_CODES ? (snake as ErrorCode) : null;
}

/** `actor` (event actor string, 02 §13.3) and `requestedBy` (who asked, for audit trails). */
export function actorFields(a: Actor): { actor: 'user' | 'system'; requestedBy: Actor } {
  return { actor: a.via === 'system' ? 'system' : 'user', requestedBy: a };
}

export class LifecycleClient {
  constructor(private readonly deps: FunctionDeps) {}

  private async call<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    try {
      return await this.deps.ports.invoker.invoke<T>('atl-lifecycle', { action, ...payload });
    } catch (e) {
      mapDownstreamError(e, `atl-lifecycle ${action}`);
    }
  }

  /** Payload: the full draft plus its identifiers at the top level; `actor` is the event actor (02 §13.3). */
  createSession(session: Record<string, unknown>, actor: Actor): Promise<{ sessionId?: string; state?: string; ver?: number } | null> {
    return this.call('CreateSession', {
      sessionId: session.sid,
      sub: session.sub,
      labId: session.labId,
      variant: session.variant,
      quoteId: (session.costQuote as { quoteId?: string } | undefined)?.quoteId ?? null,
      reuseEnvId: session.reuseOfEnvId ?? null,
      costAcknowledged: !!(session.costQuote as { acknowledgedAt?: string } | undefined)?.acknowledgedAt,
      session,
      ...actorFields(actor),
    });
  }

  transition(t: { sessionId: string; from: string[]; to: string; reason: string; expectedVer?: number }, actor: Actor): Promise<SessionItem | null> {
    return this.call('Transition', { ...t, ...actorFields(actor) });
  }

  extend(x: { sessionId: string; minutes: number; quoteId: string; expectedDeadlineVersion: number }, actor: Actor): Promise<SessionItem | null> {
    return this.call('Extend', { ...x, ...actorFields(actor) });
  }

  extendKeep(x: { sessionId: string; hours: number; quoteId: string; expectedKeepVersion: number }, actor: Actor): Promise<SessionItem | null> {
    return this.call('ExtendKeep', { ...x, ...actorFields(actor) });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Workflows started by atl-api (01 §3.3, 02 §2.7)

  private async start(stateMachine: StateMachineName, name: string, input: unknown): Promise<{ executionArn: string; alreadyRunning: boolean }> {
    try {
      const r = await this.deps.ports.orchestrator.startExecution({ stateMachine, name, input });
      return { executionArn: r.executionArn, alreadyRunning: false };
    } catch (e) {
      if (isPortError(e, 'ExecutionAlreadyExists')) {
        return { executionArn: this.deps.ports.orchestrator.executionArn(stateMachine, name), alreadyRunning: true };
      }
      mapDownstreamError(e, `states:StartExecution ${stateMachine}`);
    }
  }

  /** 02 §3.3 step 4: `start-<sid>` with `{ sessionId }`. */
  startSessionStart(sid: string) {
    return this.start('atl-session-start', ExecutionNames.start(sid), { sessionId: sid });
  }

  /** 02 §6.1: one execution name per end phase; input `{ sessionId, reason, disposition, failure?, keep? }`. */
  startSessionEnd(sid: string, phase: { kind: 'first' } | { kind: 'release' } | { kind: 'retry'; k: number }, input: Record<string, unknown>) {
    const name = phase.kind === 'first' ? ExecutionNames.endFirst(sid) : phase.kind === 'release' ? ExecutionNames.endRelease(sid) : ExecutionNames.endRetry(sid, phase.k);
    return this.start('atl-session-end', name, { sessionId: sid, ...input });
  }

  /**
   * `atl-module-op` (`modop-<sid>-<n>`): the first free `n` from `firstN` (names of finished executions cannot be
   * reused; the input carries the request id so that an existing name never matches a different request).
   */
  async startModuleOp(sid: string, firstN: number, input: Record<string, unknown>): Promise<{ executionArn: string; name: string; n: number }> {
    for (let n = Math.max(1, firstN); n < firstN + 50; n++) {
      const name = ExecutionNames.moduleOp(sid, n);
      try {
        const r = await this.deps.ports.orchestrator.startExecution({ stateMachine: 'atl-module-op', name, input: { sessionId: sid, n, ...input } });
        return { executionArn: r.executionArn, name, n };
      } catch (e) {
        if (isPortError(e, 'ExecutionAlreadyExists')) continue;
        mapDownstreamError(e, 'states:StartExecution atl-module-op');
      }
    }
    throw new AtlError('UPSTREAM_UNAVAILABLE', 'could not allocate a module-op execution name');
  }

  /** `atl-platform-uninstall` (`uninstall-<n>`): a running execution is reused; finished names are skipped. */
  async startUninstall(input: Record<string, unknown>): Promise<{ executionArn: string; name: string; alreadyRunning: boolean }> {
    for (let n = 1; n < 100; n++) {
      const name = ExecutionNames.uninstall(n);
      const arn = this.deps.ports.orchestrator.executionArn('atl-platform-uninstall', name);
      let status: string | null = null;
      try {
        status = (await this.deps.ports.orchestrator.describeExecution(arn)).status;
      } catch (e) {
        if (!(isPortError(e, 'ExecutionDoesNotExist') || isPortError(e, 'NotFound'))) mapDownstreamError(e, 'states:DescribeExecution');
      }
      if (status === 'RUNNING') return { executionArn: arn, name, alreadyRunning: true };
      if (status) continue;
      const r = await this.start('atl-platform-uninstall', name, input);
      return { executionArn: r.executionArn, name, alreadyRunning: r.alreadyRunning };
    }
    throw new AtlError('UPSTREAM_UNAVAILABLE', 'could not allocate an uninstall execution name');
  }

  async describe(executionArn: string) {
    try {
      return await this.deps.ports.orchestrator.describeExecution(executionArn);
    } catch (e) {
      if (isPortError(e, 'ExecutionDoesNotExist') || isPortError(e, 'NotFound')) return null;
      throw e;
    }
  }
}

export { PortError };
