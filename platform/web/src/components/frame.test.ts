import { describe, expect, it } from 'vitest';
import type { GuardrailsView, ManualResourcesView, PlatformView, SessionView } from '../api/types';
import { formatClock } from '../lib/format';
import { computeGlobalBanners, type BannerInput } from './globalBanners';
import { pillModel } from './sessionPillModel';

const NOW = Date.parse('2026-10-14T06:00:00Z');
const min = (m: number) => new Date(NOW + m * 60_000).toISOString();

function view(over: Partial<SessionView> = {}): SessionView {
  return { sessionId: 's1', labId: 'svc-cdn', state: 'RUNNING', ver: 1, createdAt: new Date(NOW - 372_000).toISOString(), readyAt: min(-30), deadlineAt: min(102), ...over };
}

const platform: PlatformView = { version: '1.0.0', region: 'ap-northeast-1', maintenance: false, mode: 'NORMAL' };

function input(over: Partial<BannerInput> = {}): BannerInput {
  return { role: 'L', platform, guardrails: null, current: null, nowMs: NOW, onWorkspace: false, manual: null, catalogUpdatedTo: null, envDegraded: false, ...over };
}

describe('SessionPill model (08 §3.3)', () => {
  it.each([
    ['REQUESTED', {}, 'u-prep', 'clock', '正在校验', '已用 6:12'],
    ['PROVISIONING', {}, 'u-prep', 'clock', '正在准备环境', '已用 6:12'],
    ['RUNNING', {}, 'u-live', 'dot', '实验中', '1:42:00'],
    ['READY', {}, 'u-live', 'dot', '环境已就绪', '1:42:00'],
    ['EXPIRING', { deadlineAt: min(12) }, 'u1', 'tri', '即将到期', '12:00'],
    ['EXPIRING', { deadlineAt: min(4) }, 'u2', 'sq', '即将到期', '4:00'],
    ['EXPIRING', { deadlineAt: min(-1) }, 'u4', 'hg', '已到期 · 正在结束', null],
    ['ENDING', {}, 'u-wind', 'hg', '正在结束', null],
    ['CLEANING', { cleanup: { deleted: 18, total: 23 } }, 'u-wind', 'hg', '正在释放资源', null],
    ['KEPT', { keep: { until: min(90), saveMode: true } }, 'u-kept', 'dia', '环境保留中', null],
    ['CLEANUP_FAILED', { cleanup: { hourlyBlocking: 1 } }, 'u-fail', 'tri', '释放未完成', null],
  ] as const)('%s %o → %s %s “%s” %s', (state, over, cls, shape, label, clock) => {
    const m = pillModel({ view: view({ state, ...over }), nowMs: NOW, role: 'L', costTier: 'low' })!;
    expect([m.cls, m.shape, m.label, m.clock]).toEqual([cls, shape, label, clock]);
  });

  it('labels and tails per state; observers see no reclaim counts; terminal sessions render no pill', () => {
    const run = pillModel({ view: view(), nowMs: NOW, role: 'L', costTier: 'low' })!;
    expect(run.aria).toBe('当前实验 svc-cdn，实验中，剩余 1 小时 42 分，回到工作台，费用档位低');
    expect(run.tail).toEqual(['$ 低']);
    expect(run.target).toBe('/workspace/s1');
    const cleaning = view({ state: 'CLEANING', cleanup: { deleted: 18, total: 23 } });
    expect(pillModel({ view: cleaning, nowMs: NOW, role: 'L' })!.tail).toEqual(['已删除 18/23']);
    expect(pillModel({ view: cleaning, nowMs: NOW, role: 'O' })!.tail).toEqual([]);
    expect(pillModel({ view: view({ state: 'KEPT', keep: { until: min(90), saveMode: true } }), nowMs: NOW, role: 'L' })!.tail).toEqual([`至 ${formatClock(min(90))}`, '节省模式']);
    expect(pillModel({ view: view({ state: 'CLEANUP_FAILED' }), nowMs: NOW, role: 'L' })!.target).toBe('/sessions/s1/end#manual');
    expect(pillModel({ view: view({ state: 'ENDED' }), nowMs: NOW, role: 'L' })).toBeNull();
  });
});

describe('global banners (08 §3.6)', () => {
  const manual: ManualResourcesView = {
    items: [
      { resourceKey: 'a', resourceType: 'AWS::RDS::DBInstance', cleanupState: 'MANUAL_REQUIRED', severity: 'BLOCKING', billing: 'hourly', labId: 'sc-static-acceleration', sessionCreatedAt: new Date(2026, 9, 13, 1, 26).toISOString() },
      { resourceKey: 'b', resourceType: 'AWS::S3::Bucket', cleanupState: 'REVIEW', severity: 'REVIEW', billing: 'storage' },
    ],
  };
  const guardrails = (state: 'OK' | 'WARN' | 'EXCEEDED'): GuardrailsView => ({ budget: { amount: 10, enforcement: 'block-start', state }, mode: 'NORMAL', maintenance: false, uninstalling: false });

  it('orders by priority and names the session of the residue', () => {
    const all = computeGlobalBanners(
      input({
        platform: { ...platform, mode: 'UNINSTALLING', maintenance: true },
        guardrails: guardrails('EXCEEDED'),
        manual,
        current: view({ state: 'EXPIRING', deadlineAt: min(12) }),
        catalogUpdatedTo: '2026.10.2',
        envDegraded: true,
      }),
    );
    expect(all.map((b) => b.priority)).toEqual([1, 2, 3, 4, 5, 6, 8]);
    const residual = all.find((b) => b.id === 'residual')!;
    expect(residual.text).toBe('sc-static-acceleration（10/13 01:26 的实验）有 2 项资源未释放，其中 1 项按小时计费。');
    expect(residual.dismissible).toBe(false);
    expect(all.find((b) => b.priority === 4)!.text).toContain('剩余 12 分钟');
  });

  it('observers never see the residue banner; the workspace manages its own expiry and degraded banners', () => {
    expect(computeGlobalBanners(input({ role: 'O', manual })).map((b) => b.id)).toEqual([]);
    const ws = computeGlobalBanners(input({ onWorkspace: true, current: view({ state: 'EXPIRING', deadlineAt: min(12) }), envDegraded: true }));
    expect(ws).toEqual([]);
  });

  it('budget WARN (7), keep ≤ 60 min (9), maintenance action only for learners, outage window suppresses env banner', () => {
    expect(computeGlobalBanners(input({ guardrails: guardrails('WARN') }))[0]!.priority).toBe(7);
    expect(computeGlobalBanners(input({ current: view({ state: 'KEPT', keep: { until: min(45) } }) }))[0]!.priority).toBe(9);
    expect(computeGlobalBanners(input({ current: view({ state: 'KEPT', keep: { until: min(90) } }) }))).toEqual([]);
    expect(computeGlobalBanners(input({ role: 'A', platform: { ...platform, maintenance: true } }))[0]!.action).toBeUndefined();
    expect(computeGlobalBanners(input({ current: view({ outageWindow: { until: min(5) } }), envDegraded: true }))).toEqual([]);
  });
});
