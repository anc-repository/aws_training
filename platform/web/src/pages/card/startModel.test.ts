import { describe, expect, it } from 'vitest';
import type { CostQuote, LabDetail } from '../labs/types';
import { amountText, formatMoney, isDomain, primaryEstimate, quoteHasUnknown, quoteRows, startModel, validateInput, type StartInput } from './startModel';

const detail = (p: Partial<LabDetail['startability']> = {}): LabDetail => ({
  labId: 'svc-queue',
  catalogVersion: 'v',
  progress: { status: 'not_started', attempts: 0 },
  attempts: [],
  startability: { canStart: true, reasons: [], reuse: null, variants: [{ id: 'default', select: 'default' }], ...p },
});

const base: StartInput = {
  role: 'L',
  labId: 'svc-queue',
  cardStatus: 'beta',
  detail: detail(),
  detailFailed: false,
  current: null,
  platform: { mode: 'NORMAL', maintenance: false },
  budget: null,
  residualPolicy: 'ack',
  residualHourly: 0,
};

describe('startModel (08 P03 “开始实验”按钮表)', () => {
  const cases: [string, Partial<StartInput>, Record<string, unknown>][] = [
    ['can start', {}, { kind: 'start', residual: null }],
    ['assistants and observers never see it', { role: 'A' }, { kind: 'hidden', note: 'role' }],
    ['planned cards only show', { cardStatus: 'planned' }, { kind: 'hidden', note: 'planned' }],
    ['deprecated cards', { cardStatus: 'deprecated' }, { kind: 'hidden', note: 'deprecated' }],
    ['personal part loading', { detail: null }, { kind: 'loading' }],
    ['personal part failed', { detail: null, detailFailed: true }, { kind: 'unknown' }],
    ['this card holds the environment', { current: { sessionId: 's9', labId: 'svc-queue', state: 'RUNNING', deadlineAt: null } }, { kind: 'holder', to: '/workspace/s9' }],
    ['uninstalling', { platform: { mode: 'UNINSTALLING' } }, { kind: 'blocked', code: 'PLATFORM_UNINSTALLING' }],
    ['maintenance', { platform: { mode: 'NORMAL', maintenance: true } }, { kind: 'blocked', code: 'MAINTENANCE_MODE' }],
    ['budget exceeded and blocking', { budget: { state: 'EXCEEDED', blocksStart: true } }, { kind: 'blocked', code: 'BUDGET_BLOCKED' }],
    ['budget exceeded, notify only', { budget: { state: 'EXCEEDED', blocksStart: false } }, { kind: 'start' }],
    ['another session is running', { current: { sessionId: 's2', labId: 'svc-cdn', state: 'RUNNING', deadlineAt: '2026-10-14T07:30:00Z' } }, { kind: 'blocked', code: 'SESSION_ACTIVE_EXISTS' }],
    ['server says another session exists', { detail: detail({ canStart: false, reasons: [{ code: 'SESSION_ACTIVE_EXISTS', sessionId: 's3' }] }) }, { kind: 'blocked', code: 'SESSION_ACTIVE_EXISTS' }],
    ['cleaning', { current: { sessionId: 's2', labId: 'svc-cdn', state: 'CLEANING', deadlineAt: null, cleanup: { deleted: 18, total: 23 } } }, { kind: 'blocked', code: 'CLEANUP_IN_PROGRESS' }],
    ['kept and compatible', { detail: detail({ canStart: true, reasons: [{ code: 'ENV_KEPT_EXISTS', ackable: true }], reuse: { environmentId: 'e1', fromLabId: 'svc-iam', compatible: true, sessionId: 's4' } }) }, { kind: 'kept', compatible: true, reuseEnvId: 'e1', sessionId: 's4' }],
    ['kept and incompatible', { detail: detail({ canStart: false, reasons: [{ code: 'ENV_KEPT_EXISTS' }], reuse: { environmentId: 'e1', fromLabId: 'svc-iam', compatible: false, reason: 'TARGET_ALREADY_SATISFIED' } }) }, { kind: 'kept', compatible: false }],
    ['residual, policy ack', { detail: detail({ reasons: [{ code: 'RESIDUAL_ACK_REQUIRED', ackable: true }] }) }, { kind: 'start', residual: 'ack' }],
    ['residual, policy block', { detail: detail({ canStart: false, reasons: [{ code: 'RESIDUAL_ACK_REQUIRED', ackable: false }] }) }, { kind: 'blocked', code: 'RESIDUAL_BLOCKING' }],
    ['residual predicted locally, policy block', { residualHourly: 1, residualPolicy: 'block' }, { kind: 'blocked', code: 'RESIDUAL_BLOCKING' }],
    ['residual, policy ignore', { residualHourly: 2, residualPolicy: 'ignore' }, { kind: 'start', residual: 'info' }],
    ['hard prerequisite', { detail: detail({ canStart: false, reasons: [{ code: 'HARD_PREREQ_UNMET', labId: 'svc-iam', detail: '需要先完成 svc-iam' }] }) }, { kind: 'blocked', code: 'HARD_PREREQ_UNMET' }],
  ];
  it.each(cases)('%s', (_n, patch, want) => {
    expect(startModel({ ...base, ...patch })).toMatchObject(want);
  });

  it('explains blocked states with a way out', () => {
    const m = startModel({ ...base, current: { sessionId: 's2', labId: 'svc-cdn', state: 'RUNNING', deadlineAt: null } });
    expect(m).toMatchObject({ text: 'svc-cdn 正在进行（准备中），结束后才能开始新的实验。', link: { to: '/workspace/s2', label: '回到工作台' } });
    const c = startModel({ ...base, current: { sessionId: 's2', labId: 'svc-cdn', state: 'CLEANING', deadlineAt: null, cleanup: { deleted: 18, total: 23 } } });
    expect(c).toMatchObject({ text: '上一个环境正在释放（已删除 18/23）。', link: { to: '/sessions/s2/end' } });
    expect(startModel({ ...base, residualHourly: 1, residualPolicy: 'block' })).toMatchObject({ link: { to: '/resources/manual', label: '先处理残留' } });
  });
});

describe('learner inputs (05 §7.1)', () => {
  it.each([
    ['domain', 'lab.example.com', null],
    ['domain', 'Lab.Example.com', 'err'],
    ['domain', '1.2.3.4', 'err'],
    ['domain', '*.example.com', 'err'],
    ['domain', 'example', 'err'],
    ['domain', '-bad.example.com', 'err'],
    ['hosted-zone', 'Z0123456789ABC', null],
    ['hosted-zone', 'z123', 'err'],
    ['ses-identity', 'example.com', null],
    ['ses-identity', 'me@example.com', null],
    ['notify-email', 'me+atl@example.com', null],
    ['notify-email', 'me@ex ample.com', 'err'],
    ['notify-email', 'me$(id)@x.com', 'err'],
    ['recipient-emails', 'a@x.io, b@y.io', null],
    ['recipient-emails', 'a@x.io,b@y.io,c@z.io', 'err'],
    ['budget-amounts', '10, 20.5', null],
    ['budget-amounts', '10', 'err'],
    ['budget-amounts', '-1, 2', 'err'],
    ['cost-tags-active', 'true', null],
    ['cost-tags-active', '', 'err'],
  ])('%s = %j', (id, v, want) => {
    const r = validateInput(id, v, true);
    if (want === null) expect(r).toBeNull();
    else expect(r).toBeTruthy();
  });

  it('optional inputs may be empty', () => {
    expect(validateInput('domain', '', false)).toBeNull();
    expect(isDomain('a.b')).toBe(true);
  });
});

describe('quote rows (P03-D, 08 §9.2 #6 degradation)', () => {
  const opts = { workstation: 'ec2' as const, reuse: false, limitMinutes: 90, extensions: { count: 2, minutes: 30 } };
  const quote = (p: Partial<CostQuote> = {}): CostQuote => ({
    quoteId: 'q1',
    purpose: 'START',
    expiresAt: '2026-10-14T00:15:00Z',
    currency: 'USD',
    lines: [
      { group: 'start', ref: 'start-profile' },
      { group: 'target', service: 'Amazon SQS', dimension: '队列' },
      { group: 'usage', service: 'SQS 请求', billing: 'usage' },
      { group: 'platform', service: '平台开销' },
    ],
    ...p,
  });

  it('prices from the server only; “未知” when the price list is unavailable, “未提供” for missing fields', () => {
    const unpriced = quoteRows(quote({ pricing: 'unavailable', lines: quote().lines!.map((l) => ({ ...l, unknown: true })), incomplete: ['ref:start-profile'] }), opts);
    expect(unpriced.find((r) => r.key === 'start')!.amount).toEqual({ kind: 'text', text: '未知' });
    expect(unpriced.find((r) => r.key === 'build')!.amount).toEqual({ kind: 'text', text: '未提供' });
    expect(unpriced.find((r) => r.key === 'orchestration')!.amount).toEqual({ kind: 'text', text: '不估金额' });
    expect(quoteHasUnknown(quote({ pricing: 'unavailable' }))).toBe(true);
    expect(quoteHasUnknown(quote())).toBe(false);
    const priced = quoteRows(
      quote({ pricing: 'price-list', hourly: { start: { low: 0.05, high: 0.07 }, completed: { low: 0.05, high: 0.08 } }, platformOverhead: { low: 0.02, high: 0.03 }, maxSession: { low: 0.3, high: 0.5 }, maxTotalMinutes: 150 }),
      opts,
    );
    expect(amountText(priced.find((r) => r.key === 'start')!.amount)).toBe('≈ $0.050～$0.070 /小时');
    expect(amountText(priced.find((r) => r.key === 'workstation')!.amount)).toBe('≈ $0.020～$0.030 /小时');
    expect(priced.find((r) => r.key === 'max')!.desc).toBe('含 2 次延长（共 2.5 小时）、部署与回收期间，以及一次构建开销');
    expect(priced.find((r) => r.key === 'usage')!.desc).toContain('SQS 请求');
    expect(primaryEstimate(quote({ hourly: { start: { low: 0.05, high: 0.07 }, completed: null } }))).toBe('≈ $0.050～$0.070 /小时');
    expect(primaryEstimate(quote())).toBeNull();
  });

  it('uses perHour / perSession / qualitative from the platform overhead when present', () => {
    const r = quoteRows(quote({ platformOverhead: { low: 0.02, high: 0.03, perHour: { low: 0.02, high: 0.03 }, perSession: { low: 0.01, high: 0.04, basis: 'class' }, qualitative: ['日志摄入通常很小'] } }), opts);
    expect(amountText(r.find((x) => x.key === 'build')!.amount)).toBe('≈ $0.010～$0.040 /次');
    expect(r.find((x) => x.key === 'orchestration')!.desc).toBe('日志摄入通常很小');
  });

  it('the CloudShell saving mode removes the workstation amount', () => {
    const r = quoteRows(quote({ platformOverhead: { low: 0.02, high: 0.03 } }), { ...opts, workstation: 'cloudshell' });
    expect(r.find((x) => x.key === 'workstation')!.amount).toEqual({ kind: 'text', text: '—' });
  });

  it('formats amounts by magnitude', () => {
    expect(formatMoney(12.345)).toBe('$12.35');
    expect(formatMoney(0.0012)).toBe('$0.0012');
    expect(formatMoney(150, 'CNY')).toBe('150 CNY');
  });
});
