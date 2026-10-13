import { describe, expect, it } from 'vitest';
import {
  allowedTargets,
  canTransition,
  endPhaseFor,
  findTransitions,
  holdsActiveEnvLock,
  isTerminal,
  NON_TERMINAL_STATES,
  SESSION_STATES,
  terminalStateFor,
  TRANSITIONS,
  type SessionState,
} from '../src/index.js';

/** The edges of the 02 §2.2 state diagram, written out independently of TRANSITIONS. */
const DIAGRAM: [SessionState | null, SessionState][] = [
  [null, 'REQUESTED'],
  ['REQUESTED', 'PROVISIONING'],
  ['REQUESTED', 'FAILED'],
  ['REQUESTED', 'ENDED'],
  ['PROVISIONING', 'READY'],
  ['PROVISIONING', 'CLEANING'],
  ['READY', 'RUNNING'],
  ['READY', 'EXPIRING'],
  ['RUNNING', 'EXPIRING'],
  ['EXPIRING', 'RUNNING'],
  ['EXPIRING', 'READY'],
  ['READY', 'ENDING'],
  ['RUNNING', 'ENDING'],
  ['EXPIRING', 'ENDING'],
  ['ENDING', 'KEPT'],
  ['ENDING', 'CLEANING'],
  ['KEPT', 'KEPT'],
  ['KEPT', 'CLEANING'],
  ['KEPT', 'ENDED'],
  ['CLEANING', 'ENDED'],
  ['CLEANING', 'FAILED'],
  ['CLEANING', 'CLEANUP_FAILED'],
  ['CLEANUP_FAILED', 'CLEANING'],
  ['CLEANUP_FAILED', 'ENDED'],
  ['CLEANUP_FAILED', 'FAILED'],
  ['ENDED', 'CLEANUP_FAILED'],
  ['FAILED', 'CLEANUP_FAILED'],
];

describe('session state machine (02 §2.2, §2.3)', () => {
  it('has the eleven states (P11 + KEPT)', () => {
    expect(SESSION_STATES).toHaveLength(11);
    expect(new Set(SESSION_STATES).size).toBe(11);
  });

  it('T01–T21 are all present, in order, once each', () => {
    expect(TRANSITIONS.map((t) => t.id)).toEqual(Array.from({ length: 21 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
  });

  it('the transition table equals the state diagram exactly', () => {
    const fromTable = new Set<string>();
    for (const t of TRANSITIONS) for (const f of t.from) for (const to of t.to) fromTable.add(`${f}->${to}`);
    const fromDiagram = new Set(DIAGRAM.map(([f, t]) => `${f}->${t}`));
    expect([...fromTable].sort()).toEqual([...fromDiagram].sort());
  });

  it('allows every documented transition and rejects every other pair', () => {
    const allowed = new Set(DIAGRAM.map(([f, t]) => `${f}->${t}`));
    for (const from of [null, ...SESSION_STATES]) {
      for (const to of SESSION_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}->${to}`));
      }
    }
  });

  it('spot checks', () => {
    expect(canTransition('RUNNING', 'READY')).toBe(false); // only EXPIRING → READY (T09)
    expect(canTransition('ENDED', 'RUNNING')).toBe(false);
    expect(canTransition('PROVISIONING', 'ENDING')).toBe(false); // compensation goes straight to CLEANING (T06)
    expect(findTransitions('KEPT', 'ENDED').map((t) => t.id)).toEqual(['T15']);
    expect(findTransitions('EXPIRING', 'ENDING').map((t) => t.id)).toEqual(['T10']);
    expect(allowedTargets('ENDING').sort()).toEqual(['CLEANING', 'KEPT']);
    expect(allowedTargets(null)).toEqual(['REQUESTED']);
  });

  it('every non-terminal state has a way forward; terminal states only downgrade (T21)', () => {
    for (const s of NON_TERMINAL_STATES) expect(allowedTargets(s).length).toBeGreaterThan(0);
    expect(allowedTargets('ENDED')).toEqual(['CLEANUP_FAILED']);
    expect(allowedTargets('FAILED')).toEqual(['CLEANUP_FAILED']);
    expect(isTerminal('ENDED')).toBe(true);
    expect(isTerminal('CLEANUP_FAILED')).toBe(false);
    expect(NON_TERMINAL_STATES).toHaveLength(9); // + FOLLOWUP#PENDING = the 10 queries of AP12
  });

  it('lock ownership follows 01 §2.4', () => {
    expect(holdsActiveEnvLock('REQUESTED')).toBe('acquiring');
    for (const s of ['PROVISIONING', 'READY', 'RUNNING', 'EXPIRING', 'ENDING', 'KEPT', 'CLEANING'] as const) {
      expect(holdsActiveEnvLock(s)).toBe(true);
    }
    expect(holdsActiveEnvLock('CLEANING', { cleaningIsRetry: true })).toBe(false);
    for (const s of ['ENDED', 'FAILED', 'CLEANUP_FAILED'] as const) expect(holdsActiveEnvLock(s)).toBe(false);
  });

  it('terminal state after reclaim depends on endReason (T16 / T17)', () => {
    expect(terminalStateFor('PROVISION_FAILED')).toBe('FAILED');
    expect(terminalStateFor('PROVISION_TIMEOUT')).toBe('FAILED');
    expect(terminalStateFor('USER_ENDED')).toBe('ENDED');
    expect(terminalStateFor(null)).toBe('ENDED');
  });

  it('end phases map to the execution-name families (02 §6.1)', () => {
    expect(endPhaseFor('RUNNING')).toBe('first');
    expect(endPhaseFor('PROVISIONING')).toBe('first');
    expect(endPhaseFor('KEPT')).toBe('release');
    expect(endPhaseFor('CLEANUP_FAILED')).toBe('retry');
    expect(endPhaseFor('ENDED')).toBeNull();
    expect(endPhaseFor('REQUESTED')).toBeNull();
  });
});
