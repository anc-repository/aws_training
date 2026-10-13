/**
 * Session events and audit for the API functions (01 §8.4, §8.5, AP5):
 *  - `emitSessionEvents`: write `SessionEvent` items and publish them to the bus `atl-events` (detail-type = type);
 *  - `pollSessionEvents`: `GET /sessions/{sid}/events?after=` — `{ events[], next, hasMore, pollAfterMs }`;
 *  - `recordWorkspaceEvents`: `POST /sessions/{sid}/workspace-events` (03 §7.4, `workspace.*` subtypes);
 *  - `audit`: `AuditEvent` writer (every 403 is audited with `result=denied`).
 */
import { createHash } from 'node:crypto';
import { AtlError, eventSourceOf, isTerminal, type EventActor, type SessionEventType, type SessionState } from '@atl/shared';
import type { FunctionDeps } from '../../runtime/deps.js';
import type { AuditInput, Repositories, SessionEventView } from '../../repositories/index.js';

export interface EmitOptions {
  actor?: EventActor;
  envId?: string | null;
}

/** Write events (one item each) and publish them to the bus (best effort — the table is what browsers poll). */
export async function emitSessionEvents(
  deps: FunctionDeps,
  repos: Repositories,
  sid: string,
  events: { type: SessionEventType; data: Record<string, unknown> }[],
  opts: EmitOptions = {},
): Promise<SessionEventView[]> {
  if (!events.length) return [];
  const written = await repos.events.append(sid, events, deps.ports.clock.nowMs());
  await publishToBus(deps, sid, written, opts);
  return written;
}

export async function publishToBus(deps: FunctionDeps, sid: string, events: SessionEventView[], opts: EmitOptions = {}): Promise<void> {
  try {
    await deps.ports.events.publish(
      events.map((e) => ({
        source: eventSourceOf(e.type as SessionEventType),
        detailType: e.type,
        detail: { eventId: e.id, sessionId: sid, envId: opts.envId ?? null, at: e.at, actor: opts.actor ?? 'user', ...e.data },
      })),
    );
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'event bus publish failed', sessionId: sid, error: String(err) }));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Polling (AP5)

/** Server-suggested polling interval per session state (02 §5.5, 08 §7.3). */
export function pollAfterMsFor(state: SessionState | null): number {
  switch (state) {
    case 'REQUESTED':
    case 'PROVISIONING':
      return 5_000;
    case 'READY':
    case 'RUNNING':
      return 15_000;
    case 'EXPIRING':
    case 'ENDING':
    case 'CLEANING':
      return 10_000;
    case 'KEPT':
    case 'CLEANUP_FAILED':
      return 60_000;
    default:
      return state && isTerminal(state) ? 60_000 : 30_000;
  }
}

/** Events newer than this are held back for one poll (writers in other functions may still commit older ids). */
export const EVENT_SETTLE_MS = 2_000;
export const EVENTS_DEFAULT_LIMIT = 100;
export const EVENTS_MAX_LIMIT = 200;

export interface EventsPage {
  events: SessionEventView[];
  next: string | null;
  hasMore: boolean;
  pollAfterMs: number;
}

export async function pollSessionEvents(
  repos: Repositories,
  sid: string,
  state: SessionState,
  after: string | undefined,
  limit: number,
  nowMs: number,
): Promise<EventsPage> {
  if (after !== undefined && !/^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/.test(after)) {
    throw new AtlError('VALIDATION_FAILED', 'after must be an event id (ULID)');
  }
  const { events, hasMore } = await repos.events.listAfter(sid, after?.toUpperCase(), limit, nowMs - EVENT_SETTLE_MS);
  const next = events.length ? events[events.length - 1]!.id : (after ?? null);
  return { events, next, hasMore, pollAfterMs: hasMore ? 1_000 : pollAfterMsFor(state) };
}

// ---------------------------------------------------------------------------------------------------------------
// Workspace events (03 §7.4)

const WORKSPACE_EVENT_FIELDS: Record<string, readonly string[]> = {
  'workspace.command_pasted': ['stepId', 'blockIndex', 'tab', 'mode', 'textSha256', 'dangerous'],
  'workspace.command_finished': ['pastedEventId', 'exitCode', 'stepId', 'blockIndex', 'tab'],
  'workspace.console_opened': ['linkId'],
  'workspace.preview_opened': ['targetId', 'embedded'],
  'workspace.terminal_reconnected': ['terminalId', 'attempts', 'result'],
};

export const MAX_WORKSPACE_EVENTS_PER_BATCH = 50;

/**
 * Keep only the documented fields of each `workspace.*` subtype (no terminal content is ever stored, 03 §7.4);
 * unknown subtypes are rejected.
 */
export function sanitizeWorkspaceEvents(raw: { type: string; data?: Record<string, unknown>; at?: string }[]): { type: SessionEventType; data: Record<string, unknown> }[] {
  if (raw.length > MAX_WORKSPACE_EVENTS_PER_BATCH) throw new AtlError('VALIDATION_FAILED', `at most ${MAX_WORKSPACE_EVENTS_PER_BATCH} events per batch`);
  return raw.map((e, i) => {
    const fields = WORKSPACE_EVENT_FIELDS[e.type];
    if (!fields) throw new AtlError('VALIDATION_FAILED', `events.${i}.type: unknown workspace event type ${e.type}`);
    const data: Record<string, unknown> = {};
    for (const f of fields) {
      const v = e.data?.[f];
      if (v === undefined) continue;
      if (typeof v === 'string' ? v.length > 200 : typeof v !== 'number' && typeof v !== 'boolean' && v !== null) {
        throw new AtlError('VALIDATION_FAILED', `events.${i}.data.${f}: must be a short scalar`);
      }
      data[f] = v;
    }
    if (typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at))) data.clientAt = e.at;
    return { type: e.type as SessionEventType, data };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Audit (01 §8.5, §10.4)

export function userAgentHash(ua: string | undefined): string | null {
  return ua ? createHash('sha256').update(ua).digest('hex').slice(0, 16) : null;
}

export async function audit(deps: FunctionDeps, repos: Repositories, a: AuditInput): Promise<void> {
  try {
    await repos.audit.write(a, deps.ports.clock.nowMs());
  } catch (err) {
    // auditing must not turn a successful request into an error; the log line keeps the trail
    console.error(JSON.stringify({ level: 'error', msg: 'audit write failed', action: a.action, error: String(err) }));
  }
}

