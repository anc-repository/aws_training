import { SESSION_STATES, type SessionState } from '@atl/shared';
import { describe, expect, it } from 'vitest';
import type { SessionView } from '../api/types';
import { allowedActionsOf, endRender, extendBlockReason, neverReady, pillTarget, rootRedirect, workspaceRender } from './sessionRouting';

const NOW = Date.parse('2026-10-14T06:00:00Z');

function v(state: SessionState, over: Partial<SessionView> = {}): SessionView {
  return { sessionId: 's1', labId: 'svc-cdn', state, ver: 1, createdAt: '2026-10-14T05:00:00Z', readyAt: '2026-10-14T05:10:00Z', ...over };
}

/** 08 §2.4 表 2：状态 × 是否进入过 READY。 */
const TABLE2: [SessionState, boolean, string, string, string | null][] = [
  // state, readyAt?, /workspace, /end, pill target
  ['REQUESTED', false, 'P04 preparing', 'redirect', '/workspace/s1'],
  ['PROVISIONING', false, 'P04 preparing', 'redirect', '/workspace/s1'],
  ['READY', true, 'P05 live', 'redirect', '/workspace/s1'],
  ['RUNNING', true, 'P05 live', 'redirect', '/workspace/s1'],
  ['EXPIRING', true, 'P05 live', 'redirect', '/workspace/s1'],
  ['ENDING', true, 'P05 winding', 'P07', '/sessions/s1/end'],
  ['CLEANING', true, 'P05 winding', 'P07', '/sessions/s1/end'],
  ['ENDING', false, 'P04 compensating', 'P07', '/sessions/s1/end'],
  ['CLEANING', false, 'P04 compensating', 'P07', '/sessions/s1/end'],
  ['KEPT', true, 'P05 kept', 'P07-K', '/sessions/s1/end'],
  ['CLEANUP_FAILED', true, 'P05 cleanup-failed', 'P07', '/sessions/s1/end#manual'],
  ['CLEANUP_FAILED', false, 'P04 cleanup-failed', 'P07', '/sessions/s1/end#manual'],
  ['ENDED', true, 'P05 archive', 'P07-summary', null],
  ['ENDED', false, 'P04 ended', 'P07-summary', null],
  ['FAILED', false, 'P04 failed', 'P07-summary', null],
];

describe('per-state rendering (08 §2.4 table 2)', () => {
  it.each(TABLE2)('%s (ready=%s) → %s · %s · pill %s', (state, ready, ws, end, pill) => {
    const view = v(state, ready ? {} : { readyAt: null });
    const w = workspaceRender(view);
    expect(`${w.screen} ${w.variant}`).toBe(ws);
    const e = endRender(view);
    expect(e.kind).toBe(end);
    if (e.kind === 'redirect') expect(e.to).toBe('/workspace/s1');
    if (e.kind === 'P07' && state === 'CLEANUP_FAILED') expect(e.anchor).toBe('manual');
    if ('report' in e) expect(e.report).toBe(ready);
    expect(pillTarget(view)).toBe(pill);
  });

  it('covers every session state', () => {
    for (const s of SESSION_STATES) expect(() => workspaceRender(v(s))).not.toThrow();
  });

  it('never-ready sessions: readyAt empty or endReason CANCELLED / PROVISION_* (no report)', () => {
    expect(neverReady(v('ENDED', { endReason: 'CANCELLED' }))).toBe(true);
    expect(neverReady(v('ENDED', { endReason: 'PROVISION_TIMEOUT' }))).toBe(true);
    expect(neverReady(v('ENDED', { endReason: 'EXPIRED' }))).toBe(false);
    expect(endRender(v('ENDED', { endReason: 'CANCELLED' }))).toEqual({ kind: 'P07-summary', report: false });
  });

  it('`/` goes to the workspace for REQUESTED…EXPIRING, otherwise to the catalog', () => {
    expect(rootRedirect(v('PROVISIONING'))).toBe('/workspace/s1');
    expect(rootRedirect(v('KEPT'))).toBe('/labs');
    expect(rootRedirect(null)).toBe('/labs');
  });
});

describe('allowedActions (08 §3.3, §9.2 #27)', () => {
  const ctx = { role: 'L' as const, nowMs: NOW, uninstalling: false, budgetExceeded: false, envHealthy: true };
  const live = (over: Partial<SessionView> = {}) =>
    v('RUNNING', { deadlineAt: new Date(NOW + 3600_000).toISOString(), limits: { extensionsLeft: 2, extensionMinutes: 30, extensionMinutesLeft: 60, maxDeadlineAt: new Date(NOW + 3 * 3600_000).toISOString(), keepAllowed: true }, ...over });

  it('uses the server field when present and is empty for assistants / observers', () => {
    expect(allowedActionsOf(live({ allowedActions: ['end'] }), ctx)).toEqual(['end']);
    expect(allowedActionsOf(live({ allowedActions: ['end'] }), { ...ctx, role: 'O' })).toEqual([]);
  });

  it('derives from the state table before 01 registers the enum', () => {
    expect(allowedActionsOf(v('PROVISIONING'), ctx)).toEqual(['cancel']);
    expect(allowedActionsOf(live(), ctx)).toEqual(['end', 'extend', 'end-keep']);
    expect(allowedActionsOf(live(), { ...ctx, uninstalling: true })).toEqual(['end']);
    expect(allowedActionsOf(live({ deadlineAt: new Date(NOW + 20_000).toISOString() }), ctx)).toEqual(['end', 'end-keep']);
    expect(allowedActionsOf(v('KEPT'), ctx)).toEqual(['keep-release', 'keep-extend']);
    expect(allowedActionsOf(v('KEPT'), { ...ctx, budgetExceeded: true })).toEqual(['keep-release']);
    expect(allowedActionsOf(v('CLEANUP_FAILED'), ctx)).toEqual(['cleanup-retry']);
    expect(allowedActionsOf(v('ENDED'), ctx)).toEqual([]);
  });

  it('explains why “延长” is disabled', () => {
    expect(extendBlockReason(live(), ctx)).toBeNull();
    expect(extendBlockReason(live({ deadlineAt: new Date(NOW + 10_000).toISOString() }), ctx)).toBe('last30s');
    expect(extendBlockReason(live({ limits: { extensionsLeft: 0 } }), ctx)).toBe('none');
    expect(extendBlockReason(live(), { ...ctx, budgetExceeded: true })).toBe('budget');
    expect(extendBlockReason(v('ENDING'), ctx)).toBe('state');
  });
});
