import { describe, expect, it } from 'vitest';
import type { SessionEvent, SessionView } from '../../api/types';
import { checkRow, latestResults, runSummaryText, waitDelayMs, type CheckRunView } from './checks';
import { formatRange, hourlyRangeOf, quoteHourly, scaleRange } from './cost';
import { comparability, defaultRun, deltaOf, metricsOf, metricRows, runCommand, variantColumns, variantStatus, type ExperimentRunView } from './experiments';
import { actionableState, endPrimaryLabel, expiryPhase, extendBlock, extendSummary, keepBlock, keepHourOptions, schedulerDrift, shouldOpenT5, showExpiredOverlay, showT15Banner, t5Key } from './expiry';
import { diagnosticLines, diagnosticsText, failureMeta, preflightCommand } from './failure';
import { checkLocalId, defaultPanelOf, experimentLabels, labContentUrl, type CheckDecl, type ExperimentDecl } from './lab';
import { breakpointOf, clampSplit, defaultSplitPct, dragTo, keyStep, loadLayout, saveLayout, splitBounds } from './layout';
import { evaluatePaste, looksDangerous, normalizePasteText, precheckPaste, secretReadCommand, targetOfRunsOn, type EvaluateInput } from './paste';
import { buildPhaseRows, detailText, nearBudget, phaseKeyOf, slowResourceName } from './phases';
import { applyFilters, changedKeys, collectPaths, interpolate, lookupVar, parseTemplate, resolveTemplate, shellQuote, variableChips, type VarsResponse } from './vars';

const MIN = 60_000;
const NOW = Date.parse('2026-10-14T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function view(p: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    labId: 'svc-storage',
    state: 'RUNNING',
    ver: 3,
    createdAt: iso(NOW - 60 * MIN),
    readyAt: iso(NOW - 50 * MIN),
    deadlineAt: iso(NOW + 40 * MIN),
    deadlineVersion: 1,
    limits: { extensionsLeft: 2, extensionMinutes: 30, extensionMinutesLeft: 60, maxDeadlineAt: iso(NOW + 100 * MIN), keepAllowed: true, keepMaxHours: 24 },
    allowedActions: ['end', 'extend', 'end-keep'],
    ...p,
  };
}

const VARS: VarsResponse = {
  session: { id: 's1', region: 'ap-northeast-1', accountId: '********3333', env: 'e7k2m9qx', variant: 'default' },
  platform: { origin: 'https://atl.example.com', drRegion: '' },
  learner: { inputs: { domain: 'example.com' } },
  target: { appBaseUrl: 'https://d111.cloudfront.net/albums' },
  envfile: { cdn: { CDN_SECRET: '‹secret: 在实验机上读取›' } },
  vars: [
    { name: 'rawBucket', label: '原图桶', from: 'derived', value: 'cloudalbum-e7k2m9qx-storage-raw' },
    { name: 'distributionId', label: '分配 ID', from: 'derived', value: null },
    { name: 'burstCount', label: '并发数', from: 'input', value: '200', pattern: '^[0-9]+$', example: '200' },
  ],
};

describe('variables (04 §4.4)', () => {
  it('parses placeholders, filters and escapes', () => {
    const parts = parseTemplate('aws s3 ls s3://{{ var.rawBucket }} --region {{session.region|upper}} \\{{ literal }}');
    expect(parts.filter((p) => p.kind === 'var').map((p) => (p.kind === 'var' ? p.ph.path : ''))).toEqual(['var.rawBucket', 'session.region']);
    expect(parts.some((p) => p.kind === 'text' && p.text.includes('{{ literal }}'))).toBe(true);
    const f = parseTemplate('{{ var.distributionId | default:"‹分配 ID›" | shell }}')[0];
    expect(f && f.kind === 'var' ? f.ph.filters : []).toEqual([{ name: 'default', arg: '‹分配 ID›' }, { name: 'shell' }]);
  });

  it('looks values up by namespace (session.env, var, learner.inputs, target)', () => {
    expect(lookupVar(VARS, 'session.env')).toBe('e7k2m9qx');
    expect(lookupVar(VARS, 'session.envName')).toBe('e7k2m9qx');
    expect(lookupVar(VARS, 'var.rawBucket')).toBe('cloudalbum-e7k2m9qx-storage-raw');
    expect(lookupVar(VARS, 'var.distributionId')).toBeNull();
    expect(lookupVar(VARS, 'learner.inputs.domain')).toBe('example.com');
    expect(lookupVar(VARS, 'target.appBaseUrl')).toBe('https://d111.cloudfront.net/albums');
    expect(lookupVar(null, 'session.region')).toBeNull();
  });

  it('applies filters; default only for unresolved values', () => {
    expect(applyFilters('https://d111.cloudfront.net/x', [{ name: 'host' }]).value).toBe('d111.cloudfront.net');
    expect(applyFilters('https://a.b/c', [{ name: 'trimScheme' }]).value).toBe('a.b/c');
    expect(applyFilters("it's", [{ name: 'shell' }]).value).toBe(`'it'\\''s'`);
    expect(applyFilters('111122223333', [{ name: 'mask' }]).value).toBe('••••3333');
    expect(applyFilters(null, [{ name: 'default', arg: 'X' }])).toEqual({ value: null, fallback: 'X' });
    expect(shellQuote('abc-1.2/x')).toBe('abc-1.2/x');
  });

  it('resolves templates into command parts (unresolved and secret placeholders)', () => {
    const r = resolveTemplate('aws cloudfront get-distribution --id {{ var.distributionId }} # {{ var.rawBucket }}', VARS);
    expect(r.unresolved).toEqual(['var.distributionId']);
    expect(r.text).toContain('‹分配 ID›');
    expect(r.text).toContain('cloudalbum-e7k2m9qx-storage-raw');
    const s = resolveTemplate('curl -H "x: {{ envfile.cdn.CDN_SECRET }}"', VARS);
    expect(s.secret).toBe(true);
    expect(s.unresolved).toEqual([]);
    expect(resolveTemplate('{{ x.y }}', VARS, false).text).toBe('{{ x.y }}');
    expect(interpolate('区域 {{ session.region }}', VARS)).toEqual({ text: '区域 ap-northeast-1', unresolved: false });
  });

  it('builds variable chips (input variables editable; account masked) and detects changes', () => {
    const chips = variableChips(VARS, collectPaths(['{{ target.instanceId }}']));
    expect(chips.find((c) => c.key === 'session.accountId')?.account).toBe(true);
    expect(chips.find((c) => c.key === 'var.burstCount')?.input).toEqual({ pattern: '^[0-9]+$', example: '200' });
    expect(chips.find((c) => c.key === 'target.instanceId')?.value).toBeNull();
    const next = variableChips({ ...VARS, vars: VARS.vars!.map((v) => (v.name === 'distributionId' ? { ...v, value: 'E2QW' } : v.name === 'rawBucket' ? { ...v, value: 'b2' } : v)) });
    expect(changedKeys(chips, next)).toEqual(['var.rawBucket', 'var.distributionId']);
  });
});

describe('paste confirmation matrix (03 §7.1)', () => {
  const base: EvaluateInput = { text: 'scripts/module enable cdn --dry-run', mode: 'paste', target: 'workstation', expected: 'workstation', terminal: { bracketedPaste: true, busy: false, tmux: false } };

  it('single-line ordinary command pastes without confirmation', () => {
    expect(evaluatePaste(base)).toEqual({ kind: 'paste' });
  });

  it('paste-and-execute asks (with “do not ask again”), unless dismissed for this card', () => {
    const d = evaluatePaste({ ...base, mode: 'execute' });
    expect(d.kind === 'confirm' && d.notes).toEqual(['execute']);
    expect(d.kind === 'confirm' && d.offerDontAsk).toBe(true);
    expect(evaluatePaste({ ...base, mode: 'execute', dontAskExecute: true })).toEqual({ kind: 'paste' });
  });

  it('multi-line: confirms N lines in bracketed paste mode, refuses otherwise; always confirms for execute', () => {
    const text = "cat <<'EOF' > a.json\n{}\nEOF\n";
    const d = evaluatePaste({ ...base, text });
    expect(d).toMatchObject({ kind: 'confirm', notes: ['multiline'], lines: 3 });
    expect(evaluatePaste({ ...base, text, terminal: { ...base.terminal, bracketedPaste: false } })).toMatchObject({ kind: 'reject', rejection: { reason: 'multiline-unsafe' } });
    const ex = evaluatePaste({ ...base, text, mode: 'execute', dontAskExecute: true });
    expect(ex.kind === 'confirm' && ex.notes).toEqual(['multiline', 'execute']);
  });

  it('dangerous commands: red confirmation for paste, never execute', () => {
    expect(looksDangerous('scripts/module disable cdn')).toBe(true);
    expect(looksDangerous('aws ec2 terminate-instances --instance-ids i-1')).toBe(true);
    expect(looksDangerous('rm -rf /tmp/x')).toBe(true);
    expect(looksDangerous('aws s3 ls')).toBe(false);
    const d = evaluatePaste({ ...base, text: 'scripts/module disable cdn' });
    expect(d).toMatchObject({ kind: 'confirm', severe: true, notes: ['danger'] });
    expect(evaluatePaste({ ...base, text: 'aws s3 ls', danger: true, mode: 'execute' })).toMatchObject({ kind: 'reject', rejection: { reason: 'danger-execute' } });
  });

  it('unresolved variables, secrets and > 16KB are refused', () => {
    expect(precheckPaste({ text: 'x', mode: 'paste', unresolved: ['var.a'] })).toMatchObject({ reason: 'unresolved', names: ['var.a'] });
    expect(precheckPaste({ text: 'x', mode: 'paste', secret: true, secretPaths: ['envfile.cdn.CDN_SECRET'] })).toMatchObject({ reason: 'secret', readCommand: "sudo grep '^CDN_SECRET=' /etc/cloudalbum/modules.d/cdn.env" });
    expect(secretReadCommand(['var.x'])).toBeNull();
    expect(precheckPaste({ text: 'a'.repeat(16 * 1024 + 1), mode: 'paste' })).toMatchObject({ reason: 'too-large' });
  });

  it('busy terminal offers a new sub-tab; tmux disables the busy hint; target mismatch is noted', () => {
    expect(evaluatePaste({ ...base, terminal: { ...base.terminal, busy: true } })).toMatchObject({ kind: 'confirm', notes: ['busy'], offerNewTab: true });
    expect(evaluatePaste({ ...base, terminal: { bracketedPaste: true, busy: true, tmux: true } })).toEqual({ kind: 'paste' });
    expect(evaluatePaste({ ...base, target: 'lab' })).toMatchObject({ kind: 'confirm', notes: ['mismatch'] });
  });

  it('maps runsOn to terminals and normalizes the text', () => {
    expect(targetOfRunsOn('ops')).toBe('workstation');
    expect(targetOfRunsOn('ec2')).toBe('lab');
    expect(targetOfRunsOn('cloudshell')).toBe('workstation');
    expect(targetOfRunsOn('browser')).toBeNull();
    expect(normalizePasteText('a\r\nb\n\n')).toBe('a\nb');
  });
});

describe('provisioning phases (08 P04, 02 §11.3)', () => {
  it('maps phase names by prefix and aggregates the six visible phases', () => {
    expect(phaseKeyOf('start.preflight')).toBe('validate');
    expect(phaseKeyOf('provision.resume')).toBe('base');
    expect(phaseKeyOf('provision.extra-stack')).toBe('profile');
    expect(phaseKeyOf('provision.wire')).toBe('connect');
    expect(phaseKeyOf('x.y')).toBeNull();
    const rows = buildPhaseRows({
      view: {
        state: 'PROVISIONING',
        createdAt: iso(NOW - 10 * MIN),
        readyAt: null,
        phases: [
          { name: 'start.validate', status: 'DONE', at: iso(NOW - 9 * MIN) },
          { name: 'start.preflight', status: 'DONE', at: iso(NOW - 9 * MIN), detail: 'fallback variant acme-off' },
          { name: 'provision.base', status: 'DONE', at: iso(NOW - 5 * MIN) },
          { name: 'provision.workstation', status: 'DONE', at: iso(NOW - 5 * MIN) },
          { name: 'provision.profile', status: 'RUNNING', at: iso(NOW - 4 * MIN) },
          { name: 'provision.mystery', status: 'RUNNING', at: iso(NOW - 4 * MIN), detail: 'something new' },
        ],
        startProfileResolved: { name: 'atl/svc-cdn/default' },
      },
      events: [{ id: '1', type: 'session.progress', at: iso(NOW), data: { module: 'iam', moduleIndex: 1, moduleTotal: 2, resource: { type: 'AWS::CloudFront::Distribution', logicalId: 'Dist', status: 'CREATE_IN_PROGRESS' } } } as SessionEvent],
    });
    expect(rows.map((r) => r.status)).toEqual(['done', 'done', 'running', 'todo', 'todo', 'todo']);
    expect(rows[0]!.details).toEqual(['起始档位 atl/svc-cdn/default', '已改用回退档 acme-off']);
    expect(rows[2]!.details.join(' ')).toContain('模块 1/2 · iam');
    expect(rows[2]!.details).toContain('something new');
    expect(rows[2]!.slowHint).toContain('CloudFront 分配');
    expect(rows[1]!.startedAt).toBe(rows[0]!.endedAt);
  });

  it('infers phases without phases[] and completes everything once ready', () => {
    expect(buildPhaseRows({ view: { state: 'REQUESTED', createdAt: iso(NOW), readyAt: null, phases: [] }, events: [] })[0]!.status).toBe('running');
    const ready = buildPhaseRows({ view: { state: 'READY', createdAt: iso(NOW - 20 * MIN), readyAt: iso(NOW), phases: [] }, events: [] });
    expect(ready.every((r) => r.status === 'done')).toBe(true);
  });

  it('retry and queue details, slow resources, 80% of the deployment budget', () => {
    expect(detailText('provision.health', 'health gate failed: repairing once')).toBe('健康检查未通过，正在修复一次');
    expect(slowResourceName('AWS::RDS::DBInstance')).toBe('RDS');
    expect(slowResourceName('AWS::IAM::Role')).toBeNull();
    expect(nearBudget(iso(NOW - 25 * MIN), NOW, 30)).toBe(true);
    expect(nearBudget(iso(NOW - 20 * MIN), NOW, 30)).toBe(false);
  });
});

describe('countdown, reminders, extend and end (08 P05.9)', () => {
  it('expiry phases and overlays', () => {
    expect(expiryPhase(view(), NOW)).toBe('none');
    expect(expiryPhase(view({ state: 'EXPIRING', deadlineAt: iso(NOW + 20 * MIN) }), NOW)).toBe('t15');
    expect(expiryPhase(view({ deadlineAt: iso(NOW + 12 * MIN) }), NOW)).toBe('t15');
    expect(expiryPhase(view({ deadlineAt: iso(NOW + 4 * MIN) }), NOW)).toBe('t5');
    expect(expiryPhase(view({ deadlineAt: iso(NOW + 30_000) }), NOW)).toBe('last-minute');
    expect(expiryPhase(view({ deadlineAt: iso(NOW - 1000) }), NOW)).toBe('overdue');
    expect(showT15Banner('t5')).toBe(true);
    expect(showExpiredOverlay(view({ deadlineAt: iso(NOW - 1000) }), NOW)).toBe('overdue');
    expect(showExpiredOverlay(view({ state: 'ENDING' }), NOW)).toBe('revoking');
    expect(showExpiredOverlay(view(), NOW)).toBeNull();
    expect(schedulerDrift(view({ deadlineAt: iso(NOW - 3 * MIN) }), NOW)).toBe(true);
    expect(actionableState(view({ deadlineAt: iso(NOW - 1) }), NOW)).toBe(false);
  });

  it('T-5 opens once per deadline version and only for learners', () => {
    const v = view({ deadlineAt: iso(NOW + 4 * MIN) });
    expect(shouldOpenT5(v, NOW, true, new Set())).toBe(true);
    expect(shouldOpenT5(v, NOW, false, new Set())).toBe(false);
    expect(shouldOpenT5(v, NOW, true, new Set([t5Key(v)]))).toBe(false);
    expect(shouldOpenT5(view({ deadlineAt: iso(NOW + 4 * MIN), deadlineVersion: 2 }), NOW, true, new Set([t5Key(v)]))).toBe(true);
  });

  it('extend block reasons (last 30 s, none left, cap, uninstalling, budget, role)', () => {
    const g = { learner: true, uninstalling: false, budgetExceeded: false, nowMs: NOW };
    expect(extendBlock(view(), ['end', 'extend'], g)).toBeNull();
    expect(extendBlock(view({ deadlineAt: iso(NOW + 20_000) }), ['end', 'extend'], g)).toBe('last30s');
    expect(extendBlock(view({ limits: { extensionsLeft: 0 } }), ['end'], g)).toBe('none');
    expect(extendBlock(view({ limits: { extensionsLeft: 1, extensionMinutesLeft: 0 } }), ['end'], g)).toBe('cap');
    expect(extendBlock(view(), ['end'], { ...g, uninstalling: true })).toBe('uninstalling');
    expect(extendBlock(view(), ['end'], { ...g, budgetExceeded: true })).toBe('budget');
    expect(extendBlock(view(), ['end', 'extend'], { ...g, learner: false })).toBe('role');
    expect(extendBlock(view({ state: 'ENDING' }), [], g)).toBe('state');
  });

  it('keep options and reasons; end button label', () => {
    const k = { learner: true, uninstalling: false, budgetExceeded: false, envDegraded: false, cardAllows: true, nowMs: NOW };
    expect(keepBlock(view(), ['end', 'end-keep'], k)).toBeNull();
    expect(keepBlock(view(), ['end', 'end-keep'], { ...k, cardAllows: false })).toBe('not-allowed');
    expect(keepBlock(view(), ['end', 'end-keep'], { ...k, envDegraded: true })).toBe('degraded');
    expect(keepBlock(view({ env: { envId: 'e', maxAgeUntil: iso(NOW - 1) } as SessionView['env'] }), ['end', 'end-keep'], k)).toBe('env-age');
    expect(keepHourOptions(24)).toEqual([1, 4, 12, 24]);
    expect(keepHourOptions(6)).toEqual([1, 4, 6]);
    expect(endPrimaryLabel('destroy', 'now', 4)).toBe('结束并释放资源');
    expect(endPrimaryLabel('keep', 'now', 4)).toBe('结束并保留环境 4 小时');
    expect(endPrimaryLabel('keep', 'at-expiry', 12)).toBe('到期时保留 12 小时');
    expect(endPrimaryLabel('destroy', 'at-expiry', 1)).toBe('到期时释放');
  });

  it('extend summary says “最后一次” when no further extension fits', () => {
    const f = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    expect(extendSummary(view(), 30, f)).toContain('还可以再延长 1 次');
    expect(extendSummary(view({ limits: { ...view().limits, extensionsLeft: 1 } }), 30, f)).toContain('这是最后一次延长');
    expect(extendSummary(view({ limits: { ...view().limits, maxDeadlineAt: iso(NOW + 70 * MIN) } }), 30, f)).toContain('这是最后一次延长');
  });
});

describe('layout and splitter (03 §2.6)', () => {
  it('converts the 320px / 480px limits to percentages and snaps to collapsed', () => {
    const b = splitBounds(1608);
    expect(Math.round(b.minPct)).toBe(20);
    expect(Math.round(b.maxPct)).toBe(70);
    expect(clampSplit(5, 1608)).toBeCloseTo(b.minPct);
    expect(dragTo(250, 1608).collapsed).toBe(true);
    expect(dragTo(600, 1608)).toEqual({ pct: 37.5, collapsed: false });
    expect(defaultSplitPct(1700)).toBe(36);
    expect(defaultSplitPct(1100)).toBe(42);
  });

  it('keyboard: arrows 16px (shift 64px), Home / End to min / max without collapsing, Enter toggles', () => {
    const w = 1608;
    const cur = { pct: 40, collapsed: false };
    expect(keyStep('ArrowLeft', false, cur, w)!.pct).toBeCloseTo(39);
    expect(keyStep('ArrowRight', true, cur, w)!.pct).toBeCloseTo(44);
    expect(keyStep('Home', false, cur, w)).toEqual({ pct: splitBounds(w).minPct, collapsed: false });
    expect(keyStep('End', false, cur, w)).toEqual({ pct: splitBounds(w).maxPct, collapsed: false });
    expect(keyStep('Enter', false, cur, w)!.collapsed).toBe(true);
    expect(keyStep('x', false, cur, w)).toBeNull();
  });

  it('breakpoints and persisted layout', () => {
    expect([1440, 1100, 900, 375].map(breakpointOf)).toEqual(['wide', 'mid', 'seg', 'narrow']);
    saveLayout({ split: 33, collapsed: true });
    expect(loadLayout()).toEqual({ split: 33, collapsed: true });
    localStorage.setItem('atl.ws.layout.v1', '45');
    expect(loadLayout()).toEqual({ split: 45, collapsed: false });
    localStorage.setItem('atl.ws.layout.v1', '{bad');
    expect(loadLayout()).toEqual({ split: null, collapsed: false });
  });
});

describe('check rows (08 P05.5, 04 §8.8)', () => {
  const aws: CheckDecl = { id: 'bucket-bpa', title: '桶开启了 BPA', type: 'aws-readonly', manualFallback: { observed: { question: '?', options: [{ value: 'on', label: '开启', expected: true }] } } };
  const local: CheckDecl = { id: 'storage-wired', title: '驱动为 s3', type: 'capability' };
  const manual: CheckDecl = { id: 'sns-confirmed', title: '收到确认邮件', type: 'manual', spec: {} };

  it('automatic results with assertion summaries; running overrides', () => {
    const r = checkRow('storage-wired', local, true, { effective: 'fail', lastAuto: { result: 'fail', at: iso(NOW) } }, { checkKey: 'svc/storage-wired', checkId: 'storage-wired', stepId: 'enable', source: 'PROBE', result: 'fail', at: iso(NOW), keyAssertions: [{ label: '驱动', expected: 's3', actual: 'local', ok: false }] }, false);
    expect(r).toMatchObject({ result: 'fail', how: 'auto', source: 'PROBE', summary: '驱动 · 期望 s3，实际 local', canManual: false });
    expect(checkRow('storage-wired', local, true, null, null, true).result).toBe('running');
  });

  it('ownership pending, expected outage and errors', () => {
    const p = checkRow('bucket-bpa', aws, true, { effective: 'pending', ownershipPending: true }, { checkKey: 'k', checkId: 'bucket-bpa', stepId: 's', source: 'AWS', result: 'pending', at: iso(NOW), ownership: { basis: null, pending: true, retryAfterSeconds: 112 } }, false);
    expect(p.reason).toBe('OWNERSHIP_PENDING');
    expect(p.summary).toContain('下次 1:52 后');
    const e = checkRow('bucket-bpa', aws, true, { effective: 'error', lastAuto: { result: 'error', at: iso(NOW), errorCode: 'ACCESS_DENIED' } }, null, false);
    expect(e).toMatchObject({ result: 'error', reason: 'ACCESS_DENIED', canManual: true });
  });

  it('manual confirmations: native / degraded / evidence and review state', () => {
    const n = checkRow('sns-confirmed', manual, true, null, null, false);
    expect(n).toMatchObject({ result: 'needs_manual', how: 'manual', sub: 'native', canManual: true });
    const d = checkRow('bucket-bpa', aws, true, { effective: 'manual_evidence', lastManual: { confirmationId: 'c1', kind: 'degraded', result: 'manual_evidence', observed: 'on', at: iso(NOW) } }, null, false);
    expect(d).toMatchObject({ how: 'manual', source: 'MANUAL', sub: 'evidence', review: 'pending', summary: '你填写：on · 证据已校验', canManual: false });
    const rej = checkRow('bucket-bpa', aws, true, { effective: 'manual', lastManual: { confirmationId: 'c1', kind: 'degraded', result: 'manual', observed: 'on', review: { decision: 'reject', comment: '截图不对' } } }, null, false);
    expect(rej).toMatchObject({ review: 'rejected', reviewComment: '截图不对' });
    expect(checkRow('storage-wired', local, true, { effective: 'fail' }, null, false).canManual).toBe(false);
  });

  it('latest results per check, wait rhythm, announcement text', () => {
    const runs: CheckRunView[] = [
      { runId: 'a', stepId: 's', status: 'done', finishedAt: iso(NOW - MIN), results: [{ checkKey: 'k', checkId: 'x', stepId: 's', source: 'AWS', result: 'fail', at: iso(NOW - MIN) }] },
      { runId: 'b', stepId: 's', status: 'done', finishedAt: iso(NOW), results: [{ checkKey: 'k', checkId: 'x', stepId: 's', source: 'AWS', result: 'pass', at: iso(NOW) }] },
    ];
    expect(latestResults(runs).get('x')!.result).toBe('pass');
    expect([0, 1, 2, 3, 4, 9].map(waitDelayMs)).toEqual([15_000, 30_000, 45_000, 60_000, 60_000, 60_000]);
    expect(runSummaryText([{ result: 'pass' }, { result: 'pass' }, { result: 'fail' }])).toBe('本步检测完成：2 项通过，1 项未通过');
  });
});

describe('experiments (08 P06)', () => {
  const exp: ExperimentDecl = { module: 'cdn', id: 'media-load', labels: [{ id: 'before', role: 'baseline' }, { id: 'after', role: 'treatment' }], pairs: [['before', 'after']], required: true };
  const run = (p: Partial<ExperimentRunView>): ExperimentRunView => ({ runId: 'r', module: 'cdn', experiment: 'media-load', label: 'before', registeredAt: iso(NOW - 10 * MIN), ...p });

  it('variant status, default record and labels', () => {
    expect(variantStatus(null, NOW)).toBe('none');
    expect(variantStatus(run({}), NOW)).toBe('registered');
    expect(variantStatus(run({ registeredAt: iso(NOW - 40 * MIN) }), NOW)).toBe('stale-registered');
    expect(variantStatus(run({ finishedAt: iso(NOW), status: 'uploaded' }), NOW)).toBe('uploaded');
    expect(variantStatus(run({ validity: { status: 'pending-crosscheck' } }), NOW)).toBe('pending-crosscheck');
    const list = [run({ runId: 'new', finishedAt: iso(NOW), validity: { status: 'invalid', reasons: ['PATH_RATIO'] } }), run({ runId: 'old', finishedAt: iso(NOW - MIN), validity: { status: 'valid' } })];
    expect(defaultRun(list)!.runId).toBe('old');
    expect(experimentLabels({ module: 'm', id: 'x', labels: ['after'] })[0]!.role).toBe('single');
  });

  it('metrics prefer server values, flag client/server mismatch and describe deltas without judging', () => {
    const a = run({ runId: 'a', summary: { client: { ttfb: { p50: 120 } } }, server: { ttfb: { p50: 100 } }, validity: { status: 'valid' } });
    const b = run({ runId: 'b', label: 'after', summary: { client: { ttfb: { p50: 40 } } }, validity: { status: 'valid' } });
    expect(metricsOf(a)['ttfb.p50']).toEqual({ value: 100, client: 120, server: 100, mismatch: true });
    const cols = variantColumns(exp, [a, b], {}, NOW);
    const rows = metricRows(exp, cols);
    expect(rows[0]).toMatchObject({ key: 'ttfb.p50', delta: { dir: 'down' } });
    expect(rows[0]!.delta!.text).toContain('更快');
    expect(deltaOf(100, 105)).toEqual({ text: '差异不明显', dir: 'same' });
    expect(deltaOf(10, 0, 'count')).toEqual({ text: '▼ 变为 0', dir: 'down' });
    expect(deltaOf(null, 1).dir).toBe('none');
  });

  it('pair comparability and run commands', () => {
    expect(comparability(null, run({})).comparable).toBeNull();
    expect(comparability(run({ scenario: 'a' }), run({ scenario: 'b', forced: true })).reasons).toEqual(['场景不一致', '使用了强制运行']);
    expect(comparability(run({}), run({ label: 'after' })).comparable).toBe(true);
    expect(runCommand(exp, 'after')).toBe('npm run exp -- cdn media-load --label after --upload');
  });
});

describe('failure panel, cost, content helpers', () => {
  it('failure codes map to titles and actions; diagnostics are copyable', () => {
    expect(failureMeta('CAPACITY').title).toBe('可用区容量不足');
    expect(failureMeta('PREFLIGHT_QUOTA').actions).toContain('copy-command');
    expect(failureMeta('WHATEVER').title).toBe('启动失败');
    expect(diagnosticsText('s1', { code: 'HEALTH_FAILED', phase: 'provision.health', requestId: 'r1' })).toBe('sessionId=s1\ncode=HEALTH_FAILED\nphase=provision.health\nrequestId=r1');
    expect(diagnosticLines(['a', { kind: 'cfn', summary: 'CREATE_FAILED' }])).toEqual(['a', 'cfn: CREATE_FAILED']);
    expect(preflightCommand('PREFLIGHT_NO_DEFAULT_VPC', 'ap-northeast-1')).toBe('aws ec2 create-default-vpc --region ap-northeast-1');
  });

  it('cost ranges come only from the server (string estimates are “未提供”)', () => {
    expect(hourlyRangeOf('$0.10/h')).toBeNull();
    expect(hourlyRangeOf({ start: { low: 0.1, high: 0.2 }, completed: { low: 0.2, high: 0.4 } })).toMatchObject({ low: 0.2, high: 0.4 });
    expect(formatRange({ low: 0.1, high: 0.25 })).toBe('≈ $0.100～$0.250');
    expect(formatRange(null)).toBe('未提供');
    expect(scaleRange({ low: 1, high: 2 }, 0.5)).toEqual({ low: 0.5, high: 1 });
    expect(quoteHourly({ quoteId: 'q', retainHourly: 0.05 }, 'KEEP')).toEqual({ low: 0.05, high: 0.05 });
  });

  it('content URL, check ids and default panels (04 §4.1)', () => {
    expect(labContentUrl('0.1.0', 'svc-cdn')).toBe('/content/0.1.0/labs/svc-cdn.json');
    expect(checkLocalId({ ref: 'cap-ec2-healthy', as: 'after-spof' })).toBe('after-spof');
    expect(defaultPanelOf({ type: 'console' })).toBe('console');
    expect(defaultPanelOf({ type: 'code' })).toBe('terminal-lab');
    expect(defaultPanelOf({ type: 'observe' })).toBe('preview');
    expect(defaultPanelOf({ type: 'experiment' })).toBe('terminal-workstation');
    expect(defaultPanelOf({ type: 'cli', panel: 'terminal-lab' })).toBe('terminal-lab');
  });
});
