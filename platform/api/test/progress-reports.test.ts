/**
 * Progress model (04 §8.2–§8.4; tracks-and-catalog §5) as pure functions, and reports (04 §9): atl.report/v1 with an
 * RFC 8785 integrity digest, self-contained HTML without scripts, revisions only on change, export masking, share
 * copies with forced masking, expiry schedule and removal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ScheduleNames, WebKeys, type PlatformPorts } from '@atl/shared';
import { Keys } from '../src/data/keys.js';
import type { FunctionDeps } from '../src/runtime/deps.js';
import { loadPlatformEnv } from '../src/runtime/env.js';
import { primeContentCache } from '../src/functions/checks/engine/facts.js';
import { badgeLevel, effectiveResult, evaluateCompletion, evidenceScore, nextAttemptStatus, stepState, type StepInput } from '../src/services/progress/model.js';
import { mastery, trackProgress, type TrackDef } from '../src/services/progress/tracks.js';
import type { LabProgressItem } from '../src/services/progress/types.js';
import { createShare, exportReport, generateReport, maskReport, removeShare, type ReportsContext } from '../src/services/reports/publish.js';
import { reportDigest, type Report } from '../src/services/reports/report.js';
import { CATALOG, LAB_ID, testCard } from './checks-support/card.js';
import { MemoryItemStore, MemoryObjects, RecordingEvents, RecordingScheduler, TestClock } from './checks-support/memory.js';
import { NO_DB } from './helpers.js';

const base: StepInput = { whenFalse: false, skippedByLearner: false, requiredStepsDone: true, runtimeReqsMet: true, requiredChecks: ['pass'], firstPassedAt: null, hasMustHoldFailure: false, running: false };

describe('step state (04 §8.3)', () => {
  it.each([
    ['when false', { whenFalse: true }, 'skipped'],
    ['skipped by learner', { skippedByLearner: true }, 'skipped'],
    ['locked by requires', { requiredStepsDone: false }, 'locked'],
    ['fail before achievement', { requiredChecks: ['pass', 'fail'] }, 'failed'],
    ['must-hold fail after achievement', { requiredChecks: ['fail'], firstPassedAt: 't', hasMustHoldFailure: true }, 'drifted'],
    ['once fail after achievement', { requiredChecks: ['fail'], firstPassedAt: 't' }, 'failed'],
    ['pending', { requiredChecks: ['pass', 'pending'] }, 'verifying'],
    ['running', { running: true }, 'verifying'],
    ['error', { requiredChecks: ['error'] }, 'error'],
    ['needs manual', { requiredChecks: ['needs_manual'] }, 'needs_manual'],
    ['unavailable', { requiredChecks: ['unavailable'] }, 'needs_manual'],
    ['all pass', { requiredChecks: ['pass', 'skipped'] }, 'done'],
    ['manual', { requiredChecks: ['pass', 'manual_evidence'] }, 'done_manual'],
    ['not run', { requiredChecks: ['not_run'] }, 'available'],
    ['reading step', { requiredChecks: [], read: true }, 'done'],
  ] as [string, Partial<StepInput>, string][])('%s', (_n, patch, expected) => {
    expect(stepState({ ...base, ...patch })).toBe(expected);
  });

  it('effective result: latest pass/fail > manual > pending/error/unavailable > not_run (04 §8.2)', () => {
    const at = '2026-10-13T00:00:00Z';
    expect(effectiveResult({ lastDecisive: { result: 'pass', at, runId: 'r' }, lastAuto: { result: 'error', at, runId: 'r2' } })).toBe('pass');
    expect(effectiveResult({ lastDecisive: { result: 'fail', at, runId: 'r' }, lastManual: { confirmationId: 'c', kind: 'degraded', result: 'manual', observed: 'x', note: 'n', at, by: 'u' } })).toBe('fail');
    expect(effectiveResult({ lastAuto: { result: 'error', at, runId: 'r' }, lastManual: { confirmationId: 'c', kind: 'degraded', result: 'manual', observed: 'x', note: 'n', at, by: 'u' } })).toBe('manual');
    expect(effectiveResult({ lastAuto: { result: 'error', at, runId: 'r' }, lastManual: { confirmationId: 'c', kind: 'degraded', result: 'manual', observed: 'x', note: 'n', at, by: 'u', review: { by: 'a', decision: 'reject', at } } })).toBe('error');
    expect(effectiveResult({ type: 'manual' })).toBe('needs_manual');
    expect(effectiveResult({})).toBe('not_run');
  });
});

describe('completion, attempt status, evidence score (04 §8.4; tracks §5.3)', () => {
  const step = { stepId: 's1', required: true, state: 'done' as const };
  const chk = { stepId: 's1', checkKey: 'svc-x/a', required: true, type: 'aws-readonly' as const, mustHold: true, effective: 'pass' as const };
  it('needs every required step, must-hold checks, finals and required experiments', () => {
    expect(evaluateCompletion({ steps: [step], checks: [chk], finalChecks: [], experiments: [] }).complete).toBe(true);
    expect(evaluateCompletion({ steps: [{ ...step, state: 'drifted' }], checks: [chk], finalChecks: [], experiments: [] }).complete).toBe(false);
    expect(evaluateCompletion({ steps: [step], checks: [chk], finalChecks: [{ ...chk, stepId: null, effective: 'fail' }], experiments: [] }).complete).toBe(false);
    expect(evaluateCompletion({ steps: [step], checks: [chk], finalChecks: [], experiments: [{ module: 'm', experiment: 'e', required: true, satisfied: false, pendingCrosscheck: false }] }).complete).toBe(false);
    // manual only satisfies native manual checks and degraded aws-readonly
    expect(evaluateCompletion({ steps: [step], checks: [{ ...chk, type: 'local', effective: 'manual' }], finalChecks: [], experiments: [] }).complete).toBe(false);
    const v = evaluateCompletion({ steps: [step], checks: [{ ...chk, effective: 'manual', manualKind: 'degraded' }], finalChecks: [], experiments: [] });
    expect(v.complete && v.withManual).toBe(true);
    const own = evaluateCompletion({ steps: [{ ...step, state: 'verifying' }], checks: [{ ...chk, effective: 'pending', errorCode: 'OWNERSHIP_PENDING' }], finalChecks: [], experiments: [] });
    expect(own.onlyOwnershipPending).toBe(true);
    expect(nextAttemptStatus('active', own, 'finalize')).toBe('unverified');
    expect(nextAttemptStatus('active', own, 'submit')).toBe('active');
    expect(nextAttemptStatus('completed', own, 'finalize')).toBe('completed');
    expect(nextAttemptStatus('completed_manual', { ...own, complete: true, withManual: false }, 'submit')).toBe('completed');
  });
  it('weights automatic, simulated, evidence-backed, native and degraded manual results', () => {
    expect(evidenceScore([{ effective: 'pass', type: 'local' }, { effective: 'manual', type: 'manual' }])).toBe(1);
    expect(evidenceScore([{ effective: 'pass', type: 'experiment', simulated: true }, { effective: 'pass', type: 'local' }])).toBe(0.9);
    expect(evidenceScore([{ effective: 'manual', type: 'aws-readonly', manualKind: 'degraded' }, { effective: 'pass', type: 'local' }])).toBe(0.75);
    expect(evidenceScore([{ effective: 'manual', type: 'aws-readonly', manualKind: 'degraded', reviewed: true }, { effective: 'pass', type: 'local' }])).toBe(0.9);
    expect([0.96, 0.9, 0.5].map(badgeLevel)).toEqual(['verified', 'attested', 'self-reported']);
  });
});

describe('tracks and mastery (tracks-and-catalog §5.4, §5.5)', () => {
  const lp = (labId: string, level: 'verified' | 'attested' | 'self-reported', status: 'valid' | 'pending' = 'valid', e = 1): LabProgressItem =>
    ({ labId, badge: { level, status, evidenceScore: e, attemptId: 'a', earnedAt: 't', labVersion: '1', variant: 'default' }, credits: [], regressions: [] }) as unknown as LabProgressItem;
  const track: TrackDef = {
    schema: 'atl.track/v2',
    id: 't',
    version: '1.0.0',
    title: 'T',
    stages: [{ id: 's', title: 'S', items: [{ card: 'svc-a', role: 'required' }, { card: 'svc-b', role: 'required' }, { group: 'g', pick: 1, cards: ['sc-x', 'sc-y'] }] }],
    completion: { minAutoRatio: 0.8 },
  };
  it('counts valid non-self-reported badges and the verified ratio', () => {
    expect(trackProgress(track, [lp('svc-a', 'verified'), lp('svc-b', 'verified'), lp('sc-x', 'verified')]).status).toBe('completed');
    const p = trackProgress(track, [lp('svc-a', 'verified'), lp('svc-b', 'self-reported'), lp('sc-x', 'verified')]);
    expect(p.status).toBe('in_progress');
    expect(p.reasons.join()).toContain('svc-b');
    expect(trackProgress(track, [lp('svc-a', 'verified'), lp('svc-b', 'verified'), lp('sc-x', 'verified', 'pending')]).groups[0]!.done).toBe(0);
    expect(trackProgress(track, [lp('svc-a', 'attested'), lp('svc-b', 'attested'), lp('sc-x', 'verified')]).reasons.join()).toContain('占比');
    expect(trackProgress(track, []).status).toBe('not_started');
  });
  it('computes service mastery levels and scores', () => {
    const credited = { ...lp('sc-x', 'verified'), credits: [{ serviceId: 'cloudfront', attemptId: 'a', provenance: 'this-session' }] } as LabProgressItem;
    const m = mastery([lp('svc-cdn', 'verified'), credited], { cloudfront: { correctRatio: 0.9, answered: 3 } }, [{ id: 'cloudfront', serviceCard: 'svc-cdn', scenarioCards: ['sc-x'] }, { id: 'sqs', serviceCard: 'svc-queue', scenarioCards: [] }]);
    expect(m[0]).toMatchObject({ serviceId: 'cloudfront', level: 'proficient', score: 99 });
    expect(m[1]).toMatchObject({ serviceId: 'sqs', level: 'not_started', score: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------

const SID = 's4k7m2q9x1abc';
let store: MemoryItemStore;
let objects: MemoryObjects;
let scheduler: RecordingScheduler;
let c: ReportsContext;

beforeEach(() => {
  store = new MemoryItemStore();
  objects = new MemoryObjects();
  scheduler = new RecordingScheduler();
  const ports = { clock: new TestClock(), objects, scheduler, events: new RecordingEvents() } as unknown as PlatformPorts;
  const deps: FunctionDeps = { ports, db: NO_DB, env: { ...loadPlatformEnv({ AWS_REGION: 'ap-northeast-1', ATL_ACCOUNT_ID: '123456789012' }) } };
  c = { deps, store, nowIso: '2026-10-13T09:00:00.000Z', invalidate: async () => undefined };
  primeContentCache(CATALOG, LAB_ID, testCard());
  store.seed({ ...Keys.labSession(SID), type: 'LabSession', sid: SID, sub: 'u-1', labId: LAB_ID, labKind: 'service', variant: 'default', catalogVersion: CATALOG, envId: '01jc9x3k9cq4m2x8n5b6c0d1e2', state: 'ENDED', createdAt: '2026-10-13T06:50:00Z', readyAt: '2026-10-13T07:00:00Z', endedAt: '2026-10-13T08:30:00Z', endReason: 'USER_ENDED', startProfile: `atl/${LAB_ID}/default`, startProfileDigest: 'sha256:p', costQuote: { quoteId: 'q-1' } });
  store.seed({ ...Keys.platformConfig(), type: 'PlatformConfig', installationId: 'inst-1', platformUrl: 'https://d1.cloudfront.net', region: 'ap-northeast-1' });
  store.seed({ ...Keys.labAttempt(SID), type: 'LabAttempt', status: 'completed', completedAt: '2026-10-13T08:00:00Z', checksSummary: { auto: 3, manual: 1, failed: 0 }, submittedAt: '2026-10-13T08:00:00Z' });
  store.seed({
    ...Keys.stepResult(SID, 'enable-cdn'),
    type: 'StepResult',
    stepId: 'enable-cdn',
    state: 'done',
    startedAt: '2026-10-13T07:10:00Z',
    firstPassedAt: '2026-10-13T07:30:00Z',
    driftEvents: [],
    checks: { 'dist-deployed': { checkKey: `${LAB_ID}/dist-deployed`, required: true, effective: 'pass', type: 'aws-readonly', lastPass: { at: '2026-10-13T07:30:00Z', runId: 'R1', evidenceDigest: 'sha256:abc', provenance: 'this-session' } } },
  });
  store.seed({
    ...Keys.stepResult(SID, 'confirm'),
    type: 'StepResult',
    stepId: 'confirm',
    state: 'done_manual',
    driftEvents: [],
    checks: { 'confirm-mail': { checkKey: `${LAB_ID}/confirm-mail`, required: true, effective: 'manual', type: 'manual', lastManual: { confirmationId: 'c', kind: 'native', result: 'manual', observed: '收到 <img src=x onerror=alert(1)>', note: '私人备注 instance i-0abc1234def567890', at: 't', by: 'u' } } },
  });
  store.seed({
    ...Keys.checkRun(SID, '01JB3C0000000000000000000A'),
    type: 'CheckRun',
    runId: '01JB3C0000000000000000000A',
    scope: 'step',
    trigger: 'user',
    status: 'done',
    results: [{ checkKey: `${LAB_ID}/dist-deployed`, checkId: 'dist-deployed', result: 'pass', at: '2026-10-13T07:30:00Z', trust: 'medium', keyAssertions: [{ label: '状态', expected: 'Deployed', actual: 'Deployed', ok: true }], ownership: { basis: 'lookup' } }],
  });
  store.seed({ ...Keys.experimentRun(SID, '01JB3M2C8Y3T5Q6W7E8R9T0Y1A'), type: 'ExperimentRun', runId: '01JB3M2C8Y3T5Q6W7E8R9T0Y1A', module: 'cdn', experiment: 'media-load', label: 'before', validity: { status: 'valid' }, summary: { client: { requests: 20, errors: 0 } }, server: { app: { requests: 20 } }, finishedAt: '2026-10-13T07:20:00Z' });
  store.seed({ ...Keys.experimentRun(SID, '01JB3M2C8Y3T5Q6W7E8R9T0Y1B'), type: 'ExperimentRun', runId: '01JB3M2C8Y3T5Q6W7E8R9T0Y1B', module: 'cdn', experiment: 'media-load', label: 'after', validity: { status: 'valid' }, summary: { client: { requests: 20, errors: 0 } }, server: { app: { requests: 6 } }, finishedAt: '2026-10-13T07:50:00Z' });
});

describe('reports (04 §9)', () => {
  it('builds atl.report/v1 with an integrity digest and stores revisions only on change', async () => {
    const r1 = await generateReport(c, SID, 'finalize');
    expect(r1).toMatchObject({ revision: 1, created: true });
    expect(r1.events[0]!.type).toBe('report.generated');
    const report = JSON.parse(objects.text(c.deps.env.buckets.data, `reports/${SID}/v1/report.json`)!) as Report;
    expect(report.schema).toBe('atl.report/v1');
    expect(report.integrity.digest).toBe(reportDigest(report));
    expect(report.outcome).toMatchObject({ attemptStatus: 'completed', checks: { auto: 3, manual: 1, failed: 0 } });
    expect(report.session.accountIdMasked).toBe('********9012');
    expect(report.learner.ref).toMatch(/^sha256:/);
    expect(JSON.stringify(report)).not.toContain('u-1');
    expect(report.experiments[0]!.pairs[0]).toMatchObject({ a: 'before', b: 'after', comparable: true });
    expect(report.experiments[0]!.metrics.find((m) => m.id === 'server.requests')!.values).toEqual({ before: 20, after: 6 });
    expect(report.experiments[0]!.charts[0]!.svg.startsWith('<svg')).toBe(true);
    expect(report.steps.find((s) => s.stepId === 'enable-cdn')!.checks[0]!.keyAssertions[0]!.label).toBe('状态');
    expect(report.cost.quote).toEqual({ quoteId: 'q-1' });
    const same = await generateReport({ ...c, nowIso: '2026-10-13T09:05:00.000Z' }, SID, 'cleanup');
    expect(same.created).toBe(false);
    await store.put({ ...(await store.get<Record<string, unknown>>(Keys.labAttempt(SID)))!, checksSummary: { auto: 4, manual: 0, failed: 0 } } as never);
    expect((await generateReport(c, SID, 'late-ownership')).revision).toBe(2);
  });

  it('renders self-contained HTML without scripts and escapes learner input', async () => {
    await generateReport(c, SID, 'finalize');
    const html = objects.text(c.deps.env.buckets.data, `reports/${SID}/v1/report.html`)!;
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('@media print');
    expect(html).toContain('不是 AWS 官方认证');
  });

  it('exports masked copies and shares with forced masking, expiry schedule and removal', async () => {
    await generateReport(c, SID, 'finalize');
    const exp = await exportReport(c, SID, { format: 'json' });
    expect(exp.url).toContain('exports/');
    const share = await createShare(c, SID, { expiresInDays: 7 });
    expect(share.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(share.url).toBe(`https://d1.cloudfront.net/share/${share.shareId}/index.html`);
    const html = objects.text(c.deps.env.buckets.web, `${WebKeys.share(share.shareId)}index.html`)!;
    expect(html).toContain('脱敏报告副本');
    expect(html).not.toContain('私人备注');
    expect(html).not.toContain('i-0abc1234def567890');
    expect(scheduler.created[0]).toMatchObject({ name: ScheduleNames.shareExpire(share.shareId), group: 'atl-system', payload: { kind: 'SHARE_EXPIRE', shareId: share.shareId } });
    await removeShare(c, share.shareId, { reason: 'expired' });
    expect(objects.text(c.deps.env.buckets.web, `${WebKeys.share(share.shareId)}index.html`)).toBeNull();
    expect((await store.get<{ revokedAt?: string }>(Keys.reportShare(SID, share.shareId)))!.revokedAt).toBe(c.nowIso);
  });

  it('masking keeps chart SVG intact and hides account ids and public IPs', () => {
    const r = { steps: [], checkHistory: [], experiments: [{ charts: [{ kind: 'bars', svg: '<svg>123456789012</svg>' }] }], note: 'ip 54.1.2.3 acct 123456789012', integrity: { canonicalization: 'RFC8785', digest: 'd' } } as unknown as Report;
    const m = maskReport(r, { accountId: true, ip: true });
    expect((m as unknown as { note: string }).note).toBe('ip 54.1.x.x acct ********9012');
    expect(m.experiments[0]!.charts[0]!.svg).toBe('<svg>123456789012</svg>');
  });
});
