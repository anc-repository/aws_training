/**
 * Unit tests of the API building blocks: route coverage, error mapping, pagination, rate limits, idempotency,
 * view limits, start guards, reuse plans, lock repository operations, workspace event sanitising, result digests.
 */
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '@atl/workflows';
import { AtlError, canonicalJson, Keys, ROUTES, type PlatformPorts } from '@atl/shared';
import { createHash } from 'node:crypto';
import { DevAuth, devToken } from '../src/dev/adapters/auth.js';
import { createCursorCodec, parseLimit } from '../src/http/pagination.js';
import { RateLimiter } from '../src/http/rate-limit.js';
import { etagOf, withEtag } from '../src/http/responses.js';
import { createHttpHandler } from '../src/http/router.js';
import { createRepositories, MonotonicUlid, incrementUlid, LockBusyError, type EnvironmentRecord, type PlatformConfig, type SessionItem } from '../src/repositories/index.js';
import { agentRouteHandlers, apiRouteHandlers, publicRouteHandlers } from '../src/routes/index.js';
import type { FunctionDeps } from '../src/runtime/deps.js';
import { loadPlatformEnv } from '../src/runtime/env.js';
import { cardLimitsOf, effectiveLimits, resolveVariant } from '../src/services/catalog/labs.js';
import { mastery, trackProgress } from '../src/services/catalog/progress.js';
import { quoteLinesFromLab, unpricedQuote } from '../src/services/catalog/quotes.js';
import type { LabContent } from '../src/services/catalog/store.js';
import { sanitizeWorkspaceEvents, pollAfterMsFor } from '../src/services/events/index.js';
import { resultDigest } from '../src/services/sessions/agent.js';
import { startBlockers, type PlatformState } from '../src/services/sessions/guards.js';
import { apiCodeOf } from '../src/services/sessions/lifecycle-client.js';
import { reusePlan } from '../src/services/sessions/start.js';
import { allowedActions, sessionLimits } from '../src/services/sessions/view.js';
import { fixtureIndex, fixtureLab } from './api-support/fixtures.js';
import { memoryDb } from './api-support/memory-ddb.js';
import { httpEvent } from './helpers.js';

const NOW = Date.UTC(2026, 9, 14, 1, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe('route table coverage (01 §8.2)', () => {
  it('every registered route has exactly one handler in the function that serves it', () => {
    const maps = { 'atl-api': apiRouteHandlers(), 'atl-agent': agentRouteHandlers(), 'atl-public': publicRouteHandlers() } as const;
    for (const r of ROUTES) {
      expect(maps[r.fn][r.id as keyof (typeof maps)['atl-api']], `${r.id} in ${r.fn}`).toBeTypeOf('function');
      for (const [fn, m] of Object.entries(maps)) if (fn !== r.fn) expect(m[r.id as keyof typeof m], `${r.id} must not be in ${fn}`).toBeUndefined();
    }
    const total = Object.values(maps).reduce((n, m) => n + Object.keys(m).length, 0);
    expect(total).toBe(ROUTES.length);
  });
});

describe('lifecycle error mapping', () => {
  it('maps Atl.* names to API codes', () => {
    expect(apiCodeOf('Atl.QuoteExpired')).toBe('QUOTE_EXPIRED');
    expect(apiCodeOf('Atl.EXTENSION_LIMIT')).toBe('EXTENSION_LIMIT');
    expect(apiCodeOf('Atl.TransitionRejected')).toBe('INVALID_STATE');
    expect(apiCodeOf('Atl.CostNotAcknowledged')).toBe('COST_ACK_REQUIRED');
    expect(apiCodeOf('Atl.LockBusy', 'ENV_KEPT_EXISTS: kept')).toBe('ENV_KEPT_EXISTS');
    expect(apiCodeOf('Atl.SomethingElse')).toBeNull();
    expect(apiCodeOf('TypeError')).toBeNull();
  });
});

describe('pagination, ETag, rate limits', () => {
  it('cursors are HMAC-signed and bound to their list', () => {
    const c = createCursorCodec('secret-0123456789');
    const k = { PK: 'SESSION#s4k7m2q9x1abc', SK: 'RUN#01J' };
    const cur = c.encode('runs|a', k)!;
    expect(c.decode('runs|a', cur)).toEqual(k);
    expect(() => c.decode('runs|b', cur)).toThrow(AtlError);
    const [p, mac] = cur.split('.');
    expect(() => c.decode('runs|a', `${p}x.${mac}`)).toThrow(/invalid cursor/);
    expect(c.encode('x', undefined)).toBeNull();
    expect(parseLimit({})).toBe(20);
    expect(parseLimit({ limit: '500' })).toBe(100);
    expect(() => parseLimit({ limit: '0' })).toThrow(AtlError);
  });

  it('ETag ignores serverNow and answers 304', () => {
    expect(etagOf({ a: 1, serverNow: 'x' })).toBe(etagOf({ a: 1, serverNow: 'y' }));
    const tag = etagOf({ a: 1 });
    expect(withEtag(httpEvent('GET', '/x', { headers: { 'if-none-match': tag } }), { a: 1 }).statusCode).toBe(304);
    expect(withEtag(httpEvent('GET', '/x', { headers: { 'if-none-match': '"other"' } }), { a: 1 }).statusCode).toBe(200);
  });

  it('per-user fixed window with Retry-After', () => {
    const l = new RateLimiter();
    l.hit('k', 2, NOW);
    l.hit('k', 2, NOW + 1);
    try {
      l.hit('k', 2, NOW + 1000);
      expect.unreachable();
    } catch (e) {
      expect((e as AtlError).code).toBe('RATE_LIMITED');
      expect((e as AtlError).extra.retryAfterSeconds).toBe(59);
    }
    l.hit('k', 2, NOW + 60_000);
  });
});

describe('router: Retry-After, 501 for downstream not implemented, idempotency in progress', () => {
  const clock = new VirtualClock(NOW);
  const { client } = memoryDb();
  const deps: FunctionDeps = { ports: { clock, auth: new DevAuth(clock) } as unknown as PlatformPorts, db: client, env: loadPlatformEnv({ ATL_ACCOUNT_ID: '111122223333' }) };
  const repos = createRepositories(client, deps.env.tableName);
  const h = createHttpHandler({
    fn: 'atl-api',
    getDeps: async () => deps,
    idempotency: { store: () => repos.idempotency },
    handlers: {
      getTime: async () => {
        throw new AtlError('RATE_LIMITED', 'slow down', { retryAfterSeconds: 7 });
      },
      getMe: async () => {
        throw Object.assign(new Error('x'), { name: 'Atl.NotImplemented' });
      },
      createSession: async () => ({ statusCode: 202, body: '{}' }),
    },
  });
  const auth = { authorization: `Bearer ${devToken('learner', 'u1')}` };

  it('adds Retry-After to 429 / 503', async () => {
    const r = await h(httpEvent('GET', '/api/v1/time', { headers: auth }));
    expect(r.statusCode).toBe(429);
    expect(r.headers?.['retry-after']).toBe('7');
  });

  it('downstream Atl.NotImplemented → 501', async () => {
    expect((await h(httpEvent('GET', '/api/v1/me', { headers: auth }))).statusCode).toBe(501);
  });

  it('a key still in progress → 409 with Retry-After; malformed keys → 400', async () => {
    const body = JSON.stringify({ a: 1 });
    const { createHash: ch } = await import('node:crypto');
    const hash = ch('sha256').update(`createSession\n/api/v1/sessions\n${body}`).digest('hex');
    await repos.idempotency.reserve('u1', 'in-flight-key', 'createSession', hash, NOW);
    const r = await h({ ...httpEvent('POST', '/api/v1/sessions', { headers: { ...auth, 'idempotency-key': 'in-flight-key' } }), body });
    expect(r.statusCode).toBe(409);
    expect(r.headers?.['retry-after']).toBe('1');
    expect((await h(httpEvent('POST', '/api/v1/sessions', { headers: { ...auth, 'idempotency-key': 'bad key!' }, body: {} }))).statusCode).toBe(400);
  });
});

describe('session limits and allowed actions (02 §5.4, §10.4)', () => {
  const lab = fixtureLab() as unknown as LabContent;
  const base = { sid: 's4k7m2q9x1abc', sub: 'u', labId: 'svc-queue', ver: 3, createdAt: iso(NOW), stateEnteredAt: iso(NOW), cardLimits: cardLimitsOf(lab) } as unknown as SessionItem;
  const cfg = { limits: { maxSessionMinutes: 120, extension: { minutes: 30, maxCount: 2 }, maxKeepHours: 24, keepHardMaxHours: 72, envMaxAgeDays: 7, readyIdleMinutes: 60, asgMaxSizeLimit: 4 } } as unknown as PlatformConfig;

  it('the session cap truncates extensions', () => {
    const s = { ...base, state: 'RUNNING', readyAt: iso(NOW), deadlineAt: iso(NOW + 90 * 60_000), extensions: [] } as SessionItem;
    const l = sessionLimits(s, effectiveLimits(cardLimitsOf(lab), cfg));
    expect(l).toMatchObject({ extensionsLeft: 2, extensionMinutesLeft: 30, maxDeadlineAt: iso(NOW + 120 * 60_000), keepMaxHours: 12 });
    expect(allowedActions(s, cfg, l, NOW)).toEqual(['extend', 'end', 'end-keep']);
    expect(allowedActions(s, cfg, l, NOW + 90 * 60_000 - 10_000)).toEqual(['end', 'end-keep']);
    const exceeded = { ...cfg, budget: { state: 'EXCEEDED', enforcement: 'block-start' } } as unknown as PlatformConfig;
    expect(allowedActions(s, exceeded, l, NOW)).toEqual(['end']);
    expect(allowedActions({ ...s, state: 'CLEANUP_FAILED' } as SessionItem, cfg, l, NOW)).toEqual(['cleanup-retry']);
  });

  it('variants: default / learner variants; preflight variants are not selectable', () => {
    expect(resolveVariant(lab).profileName).toBe('atl/svc-queue/default');
    expect(resolveVariant(lab, 'fifo').profileName).toBe('atl/svc-queue/fifo');
    const withPreflight = { ...lab, startProfile: { ...lab.startProfile, variants: [{ id: 'acme-off', title: 'x', select: 'preflight', provisions: [], reason: 'r' }] } } as unknown as LabContent;
    expect(() => resolveVariant(withPreflight, 'acme-off')).toThrow(/VARIANT|variant/);
    expect(resolveVariant(withPreflight).preflightAlternatives.map((v) => v.id)).toEqual(['acme-off']);
  });
});

describe('start guards (02 §3.4, §9.2)', () => {
  const st = (over: Partial<PlatformState>): PlatformState => ({ config: null, lock: null, holder: null, reservation: null, requested: [], residues: [], ...over });
  const kept = { sid: 's4k7m2q9x1abc', labId: 'svc-queue', state: 'KEPT' } as unknown as SessionItem;

  it('kept environment: blocked unless reused; reservation by another session blocks reuse', () => {
    const lock = { holderEnvId: '01jc9x3k9cq4m2x8n5b6c0d1e2', holderSessionId: kept.sid };
    expect(startBlockers(st({ lock, holder: kept }), { nowMs: NOW }).map((b) => b.code)).toEqual(['ENV_KEPT_EXISTS']);
    expect(startBlockers(st({ lock, holder: kept }), { nowMs: NOW, reuseEnvId: lock.holderEnvId })).toEqual([]);
    expect(startBlockers(st({ lock, holder: kept, reservation: { sessionId: 's1', until: 'x' } }), { nowMs: NOW, reuseEnvId: lock.holderEnvId }).map((b) => b.code)).toEqual(['REUSE_IN_PROGRESS']);
    expect(startBlockers(st({}), { nowMs: NOW, reuseEnvId: lock.holderEnvId }).map((b) => b.code)).toEqual(['VALIDATION_FAILED']);
  });

  it('cleaning holder, residues by policy, uninstall and maintenance', () => {
    expect(startBlockers(st({ holder: { ...kept, state: 'CLEANING' } as SessionItem }), { nowMs: NOW }).map((b) => b.code)).toEqual(['CLEANUP_IN_PROGRESS']);
    const residues = [{ severity: 'BLOCKING', billing: 'hourly', cleanupState: 'MANUAL_REQUIRED' }];
    expect(startBlockers(st({ residues }), { nowMs: NOW }).map((b) => b.code)).toEqual(['RESIDUAL_ACK_REQUIRED']);
    expect(startBlockers(st({ residues }), { nowMs: NOW, residualAck: true })).toEqual([]);
    const block = { reclaim: { blockStartOnResidual: 'block' } } as unknown as PlatformConfig;
    expect(startBlockers(st({ residues, config: block }), { nowMs: NOW, residualAck: true }).map((b) => b.code)).toEqual(['RESIDUAL_ACK_REQUIRED']);
    const cfg = { mode: 'UNINSTALLING', maintenance: true } as unknown as PlatformConfig;
    expect(startBlockers(st({ config: cfg }), { nowMs: NOW }).map((b) => b.code)).toEqual(['PLATFORM_UNINSTALLING', 'MAINTENANCE_MODE']);
  });

  it('reuse plan (02 §8.4 rule 1)', () => {
    const lab = fixtureLab() as unknown as LabContent;
    const v = resolveVariant(lab);
    const env = { envId: 'e', envName: 'e1234567', status: 'KEPT', enabledModules: ['ec2', 'iam', 'cdn:cloudfront'], labChain: ['svc-cdn'] } as unknown as EnvironmentRecord;
    expect(reusePlan(env, lab, v, 2, NOW)).toMatchObject({ compatible: true, enable: [], extraModules: ['cdn'], manualResources: 2 });
    const satisfied = { ...env, enabledModules: ['queue:sqs'] } as unknown as EnvironmentRecord;
    expect(reusePlan(satisfied, lab, v, 0, NOW)).toMatchObject({ compatible: false, reason: 'TARGET_ALREADY_SATISFIED' });
    expect(reusePlan({ ...satisfied, labChain: ['svc-queue'] } as EnvironmentRecord, lab, v, 0, NOW).compatible).toBe(true);
    expect(reusePlan({ ...env, maxAgeUntil: iso(NOW - 1) } as unknown as EnvironmentRecord, lab, v, 0, NOW)).toMatchObject({ compatible: false, reason: 'ENV_TOO_OLD' });
  });
});

describe('quotes never invent prices (04 §3.4)', () => {
  it('lines come from cost.basis; unpriced quotes list every key as incomplete', () => {
    const lines = quoteLinesFromLab(fixtureLab() as unknown as LabContent);
    expect(lines.map((l) => l.ref ?? l.pricingKey ?? l.group)).toEqual(['start-profile', 'workstation', 'sqs.requests', 'platform']);
    const q = unpricedQuote(lines);
    expect(q).toMatchObject({ hourly: null, maxSession: null, priceAsOf: null, pricing: 'unavailable' });
    expect(q.incomplete).toEqual(['ref:start-profile', 'ref:workstation', 'sqs.requests']);
    expect(JSON.stringify(q)).not.toMatch(/"(low|high|price)":\s*\d/);
  });
});

describe('progress model (tracks §5.4, §5.5)', () => {
  const idx = fixtureIndex() as unknown as Parameters<typeof mastery>[0];
  it('track eligibility counts only valid, non-self-reported badges and the verified ratio', () => {
    const track = idx.tracks[0]!;
    const verified = { level: 'verified', status: 'valid' } as const;
    expect(trackProgress(track, [{ labId: 'svc-queue', badge: verified }, { labId: 'sc-decoupling', badge: verified }]).certificate).toEqual({ eligible: true, reasons: [] });
    const attested = trackProgress(track, [{ labId: 'svc-queue', badge: { level: 'attested', status: 'valid' } }, { labId: 'sc-decoupling', badge: { level: 'attested', status: 'valid' } }]);
    expect(attested.certificate.reasons).toEqual([{ code: 'VERIFIED_RATIO_LOW', ratio: 0, min: 0.7 }]);
    const pending = trackProgress(track, [{ labId: 'svc-queue', badge: { level: 'verified', status: 'pending' } }]);
    expect(pending.certificate.reasons.map((r) => r.code)).toEqual(['BADGE_PENDING', 'GROUP_PICK_UNMET']);
  });

  it('mastery levels', () => {
    const quiz = { sqs: { correct: 3, total: 3 } };
    expect(mastery(idx, [{ labId: 'svc-queue', badge: { level: 'verified', status: 'valid', evidenceScore: 1 }, quizByService: quiz }, { labId: 'sc-decoupling', badge: { level: 'verified', status: 'valid', evidenceScore: 1 }, credits: [{ serviceId: 'sqs' }] }])[0]).toMatchObject({ level: 'proficient', score: 100 });
    expect(mastery(idx, [{ labId: 'svc-queue', attempts: 1 }])[0]).toMatchObject({ level: 'touched', score: 0 });
  });
});

describe('events', () => {
  it('workspace events keep only the documented fields', () => {
    expect(sanitizeWorkspaceEvents([{ type: 'workspace.console_opened', data: { linkId: 's3.bucket', secret: 'x' } }])).toEqual([{ type: 'workspace.console_opened', data: { linkId: 's3.bucket' } }]);
    expect(() => sanitizeWorkspaceEvents([{ type: 'workspace.command_pasted', data: { stepId: { nested: true } } }])).toThrow(AtlError);
    expect(pollAfterMsFor('PROVISIONING')).toBe(5000);
    expect(pollAfterMsFor('ENDED')).toBe(60000);
  });

  it('monotonic ULIDs within a millisecond', () => {
    const g = new MonotonicUlid();
    const a = g.next(NOW);
    const b = g.next(NOW);
    expect(b > a).toBe(true);
    expect(incrementUlid('01JA3M0Q2V6K8B1N4C7D9E2F3Z')).toBe('01JA3M0Q2V6K8B1N4C7D9E2F40');
    expect(g.next(NOW - 3_600_000) < a).toBe(true); // another clock far behind starts over
  });

  it('experiment result digest = RFC 8785 SHA-256 without integrity', () => {
    const r = { b: 1, a: 'x' };
    expect(resultDigest({ ...r, integrity: { digest: 'whatever' } })).toBe(`sha256:${createHash('sha256').update(canonicalJson(r)).digest('hex')}`);
  });
});

describe('ActiveEnvironmentLock operations (02 §3.4, §9.2)', () => {
  it('acquire, busy, reserve for reuse, transfer in a transaction, release', async () => {
    const { client } = memoryDb();
    const repos = createRepositories(client, 'atl-main');
    const env = '01jc9x3k9cq4m2x8n5b6c0d1e2';
    const A = 's4k7m2q9x1abc';
    const B = 's8p2c4n6r0dfg';
    await repos.platform.acquire(A, env, iso(NOW));
    await repos.platform.acquire(A, env, iso(NOW)); // idempotent for the holder
    await expect(repos.platform.acquire(B, '01jc9x3k9cq4m2x8n5b6c0d1e3', iso(NOW))).rejects.toBeInstanceOf(LockBusyError);
    await repos.platform.reserve(B, A, env, iso(NOW + 5 * 60_000), iso(NOW));
    await expect(repos.platform.reserve('s3m5q7t9v1wxy', A, env, iso(NOW + 5 * 60_000), iso(NOW))).rejects.toBeInstanceOf(LockBusyError);
    // expired reservation → transfer fails
    await expect(repos.table.transact([repos.platform.transferTx(B, A, env, iso(NOW + 6 * 60_000))])).rejects.toMatchObject({ name: 'ConditionFailedError' });
    await repos.table.transact([repos.platform.transferTx(B, A, env, iso(NOW + 60_000))]);
    expect(await repos.platform.lock()).toMatchObject({ holderSessionId: B, holderEnvId: env });
    expect((await repos.platform.lock())?.pendingSessionId).toBeUndefined();
    expect(await repos.platform.release(A, iso(NOW))).toBe(false);
    expect(await repos.platform.release(B, iso(NOW))).toBe(true);
    expect((await repos.platform.lock())?.holderSessionId).toBeUndefined();
    await repos.platform.acquire(A, env, iso(NOW));
  });

  it('T01 + Transition write events in the same transaction and recompute GSI2', async () => {
    const { client, store } = memoryDb();
    const repos = createRepositories(client, 'atl-main');
    const sid = 's4k7m2q9x1abc';
    await repos.sessions.createRequested({ sid, sub: 'u', labId: 'svc-queue', variant: 'default' }, NOW);
    await expect(repos.sessions.createRequested({ sid, sub: 'u', labId: 'svc-queue', variant: 'default' }, NOW)).rejects.toMatchObject({ name: 'ConditionFailedError' });
    const r = await repos.sessions.transition({ sid, from: ['REQUESTED'], to: 'PROVISIONING', reason: 'LOCK_ACQUIRED', nowMs: NOW + 1 });
    expect(r.session).toMatchObject({ state: 'PROVISIONING', ver: 2, GSI2PK: 'STATE#PROVISIONING' });
    expect((await repos.sessions.transition({ sid, from: ['REQUESTED'], to: 'PROVISIONING', reason: 'LOCK_ACQUIRED', nowMs: NOW + 2 })).replayed).toBe(true);
    await expect(repos.sessions.transition({ sid, from: ['PROVISIONING'], to: 'RUNNING', reason: 'x', nowMs: NOW })).rejects.toMatchObject({ name: 'Atl.TransitionRejected' });
    await repos.sessions.transition({ sid, from: ['PROVISIONING'], to: 'CLEANING', reason: 'PROVISION_FAILED', nowMs: NOW + 3 });
    const ended = (await repos.sessions.transition({ sid, from: ['CLEANING'], to: 'FAILED', reason: 'PROVISION_FAILED', nowMs: NOW + 4 })).session;
    expect(ended.GSI2PK).toBeUndefined();
    const item = store.dump('atl-main').find((i) => i.SK === 'META');
    expect(item?.GSI2PK).toBeUndefined();
    const events = (await repos.events.listAfter(sid, undefined, 50)).events.map((e) => [e.type, e.data.to]);
    expect(events).toEqual([
      ['session.requested', undefined],
      ['session.state_changed', 'REQUESTED'],
      ['session.state_changed', 'PROVISIONING'],
      ['session.state_changed', 'CLEANING'],
      ['session.state_changed', 'FAILED'],
    ]);
    expect(Keys.labSession(sid)).toEqual({ PK: `SESSION#${sid}`, SK: 'META' });
  });
});
