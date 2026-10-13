import { describe, expect, it } from 'vitest';
import { evaluateGuard, isOnboardingExempt, type GuardInput } from './guards';

const L = { groups: ['learner'], role: 'L' as const };
const A = { groups: ['assistant'], role: 'A' as const };
const O = { groups: ['observer'], role: 'O' as const };

function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    location: '/labs?view=grid',
    auth: { authenticated: true, hadSession: true },
    principal: L,
    platform: { status: 'ok', mode: 'NORMAL' },
    onboardingDone: true,
    route: { roles: ['L', 'A', 'O'] },
    ...over,
  };
}

/** 08 §2.4 表 1（顺序即优先级）。 */
const TABLE: [string, Partial<GuardInput>, ReturnType<typeof evaluateGuard>][] = [
  ['1 首次访问未登录：不带 reason', { auth: { authenticated: false, hadSession: false } }, { kind: 'redirect', to: '/login?next=%2Flabs%3Fview%3Dgrid' }],
  ['2 刷新失败：reason=expired', { auth: { authenticated: false, hadSession: true } }, { kind: 'redirect', to: '/login?next=%2Flabs%3Fview%3Dgrid&reason=expired' }],
  [
    '2b 另一个标签页退出',
    { auth: { authenticated: false, hadSession: true, signedOutElsewhere: true } },
    { kind: 'redirect', to: '/login?next=%2Flabs%3Fview%3Dgrid&reason=signed-out-elsewhere' },
  ],
  ['3 没有组 → 账号未分配角色', { principal: { groups: [], role: null } }, { kind: 'no-role' }],
  ['4 平台配置读取失败', { platform: { status: 'failed' } }, { kind: 'platform-unavailable' }],
  ['4b 平台配置读取中', { platform: { status: 'loading' } }, { kind: 'loading' }],
  ['5 卸载中：允许进入并标记', { platform: { status: 'ok', mode: 'UNINSTALLING' } }, { kind: 'allow', uninstalling: true, onboardingNotice: false }],
  ['6 学员首次设置未完成 → /setup?next=', { onboardingDone: false }, { kind: 'redirect', to: '/setup?next=%2Flabs%3Fview%3Dgrid' }],
  ['6b 助教不受首次设置约束', { onboardingDone: false, principal: A }, { kind: 'allow', uninstalling: false, onboardingNotice: false }],
  [
    '6c 工作台不受约束，改为一次可关闭的提示',
    { onboardingDone: false, location: '/workspace/s1', route: { roles: ['L', 'A', 'O'], workspace: true } },
    { kind: 'allow', uninstalling: false, onboardingNotice: true },
  ],
  ['6d /sessions/* 不受约束', { onboardingDone: false, location: '/sessions/s1/end' }, { kind: 'allow', uninstalling: false, onboardingNotice: false }],
  ['7 角色不足（观察者进入待人工处理清单）', { principal: O, location: '/resources/manual', route: { roles: ['L', 'A'] } }, { kind: 'role-denied' }],
  ['7b 小测只对学员', { principal: A, location: '/labs/svc-queue/quiz', route: { roles: ['L'] } }, { kind: 'role-denied' }],
  ['通过', {}, { kind: 'allow', uninstalling: false, onboardingNotice: false }],
];

describe('route guard (08 §2.4 table 1)', () => {
  it.each(TABLE)('%s', (_name, over, expected) => {
    expect(evaluateGuard(input(over))).toEqual(expected);
  });

  it('exempt paths of rule 6', () => {
    for (const p of ['/setup', '/settings/profile', '/sessions', '/sessions/s1', '/resources/manual', '/workspace/s1']) expect(isOnboardingExempt(p)).toBe(true);
    for (const p of ['/labs', '/learning', '/certificates', '/settingsx', '/resources/manual/x']) expect(isOnboardingExempt(p)).toBe(false);
  });
});
