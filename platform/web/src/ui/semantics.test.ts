import { SESSION_STATES, CLEANUP_STATES, CHECK_SOURCES } from '@atl/shared';
import { describe, expect, it } from 'vitest';
import {
  CHECK_RESULT_META,
  CLEANUP_STATE_META,
  checkResultMeta,
  displayState,
  keepUrgencyOf,
  SESSION_STATE_META,
  SOURCE_META,
  STEP_STATE_META,
  urgencyOf,
} from './semantics';

const MIN = 60_000;

describe('session state mapping (08 §6.3)', () => {
  it('covers every session state with text, shape and colour class', () => {
    for (const s of SESSION_STATES) {
      const m = SESSION_STATE_META[s];
      expect(m.text).toBeTruthy();
      expect(m.shape).toBeTruthy();
      expect(m.pill).toMatch(/^p-/);
    }
  });

  it('uses the learner-facing names of 02 §2.1 (REQUESTED is not “正在准备”, ENDING is not “正在释放资源”)', () => {
    expect(SESSION_STATE_META.REQUESTED.text).toBe('正在校验');
    expect(SESSION_STATE_META.PROVISIONING.text).toBe('正在准备环境');
    expect(SESSION_STATE_META.ENDING.text).toBe('正在结束');
    expect(SESSION_STATE_META.CLEANING.text).toBe('正在释放资源');
    expect(SESSION_STATE_META.CLEANUP_FAILED.text).toBe('释放未完成');
  });

  it('distinguishes states by shape, not only by colour', () => {
    const shapes = new Set(['READY', 'EXPIRING', 'ENDING', 'KEPT', 'ENDED', 'FAILED'].map((s) => SESSION_STATE_META[s as 'READY'].shape));
    expect(shapes.size).toBe(6);
  });

  it('shows the transitional “已到期 · 正在结束” when the local deadline has passed (U4)', () => {
    expect(displayState('RUNNING', 1000)).toBe('RUNNING');
    expect(displayState('EXPIRING', 0)).toBe('OVERDUE');
    expect(displayState('ENDING', -5)).toBe('ENDING');
    expect(displayState('READY', null)).toBe('READY');
  });
});

describe('countdown urgency (08 §6.4)', () => {
  it.each([
    [16 * MIN, 'U0'],
    [15 * MIN, 'U1'],
    [5 * MIN + 1, 'U1'],
    [5 * MIN, 'U2'],
    [61_000, 'U2'],
    [60_000, 'U3'],
    [1, 'U3'],
    [0, 'U4'],
    [-1, 'U4'],
  ])('%i ms left → %s', (ms, u) => {
    expect(urgencyOf(ms)).toBe(u);
  });

  it('keep reminders K1 / K2 at 60 / 15 minutes', () => {
    expect(keepUrgencyOf(61 * MIN)).toBe('K0');
    expect(keepUrgencyOf(60 * MIN)).toBe('K1');
    expect(keepUrgencyOf(15 * MIN)).toBe('K2');
  });
});

describe('check, step, cleanup and source mappings (08 §6.5, §5.3)', () => {
  it('maps the reason-qualified check results', () => {
    expect(checkResultMeta('pending', 'OWNERSHIP_PENDING').text).toBe('归属确认中');
    expect(checkResultMeta('unavailable', 'EXPECTED_OUTAGE').text).toBe('预期中断');
    expect(checkResultMeta('error', 'CHANNEL_DOWN').text).toBe(CHECK_RESULT_META.error.text);
  });

  it('covers every cleanup state of 01 §7.3 and every verdict source', () => {
    for (const s of CLEANUP_STATES) expect(CLEANUP_STATE_META[s].text).toBeTruthy();
    for (const s of CHECK_SOURCES) expect(SOURCE_META[s].symbol).toBeTruthy();
    expect(STEP_STATE_META.drifted.shape).toBe('tri');
  });
});
