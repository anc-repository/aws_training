import { describe, expect, it } from 'vitest';
import { validateAslStructure } from '../src/index.js';

const ok = {
  StartAt: 'A',
  States: {
    A: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', Next: 'B', Retry: [{ ErrorEquals: ['States.ALL'] }] },
    B: { Type: 'Choice', Choices: [{ Variable: '$.x', IsPresent: true, Next: 'C' }], Default: 'D' },
    C: { Type: 'Succeed' },
    D: { Type: 'Fail', Error: 'X' },
  },
};

describe('validateAslStructure', () => {
  it('accepts a well-formed definition', () => {
    expect(validateAslStructure(ok)).toEqual([]);
  });

  it('reports dangling transitions, unreachable states and missing Next/End', () => {
    const bad = {
      StartAt: 'A',
      States: {
        A: { Type: 'Pass', Next: 'Nope' },
        B: { Type: 'Pass' },
        C: { Type: 'Succeed', Next: 'A' },
      },
    };
    const msgs = validateAslStructure(bad).map((i) => `${i.path}: ${i.message}`);
    expect(msgs.some((m) => m.includes('"Nope" is not a state'))).toBe(true);
    expect(msgs.some((m) => m.includes('States.B') && m.includes('exactly one of Next or End'))).toBe(true);
    expect(msgs.some((m) => m.includes('States.B') && m.includes('unreachable'))).toBe(true);
    expect(msgs.some((m) => m.includes('Succeed must not have Next'))).toBe(true);
  });

  it('States.ALL must be last and alone; Retry only on Task/Parallel/Map', () => {
    const bad = {
      StartAt: 'A',
      States: {
        A: {
          Type: 'Task',
          Resource: 'r',
          End: true,
          Retry: [{ ErrorEquals: ['States.ALL'] }, { ErrorEquals: ['X'] }],
        },
        P: { Type: 'Pass', End: true, Retry: [{ ErrorEquals: ['X'] }] },
      },
    };
    const msgs = validateAslStructure(bad).map((i) => i.message);
    expect(msgs).toContain('States.ALL must appear alone in the last rule');
    expect(msgs).toContain('Retry is only allowed on Task, Parallel and Map');
  });

  it('flags unexpanded skeleton placeholders from 02 §4.4', () => {
    const def = { StartAt: 'A', States: { A: { Type: 'Task', Resource: 'r', End: true, Retry: '<<LambdaRetry>>' } } };
    expect(validateAslStructure(def).map((i) => i.message)).toContain('unexpanded skeleton placeholder <<LambdaRetry>>');
  });

  it('checks Parallel branches and Map processors recursively', () => {
    const def = {
      StartAt: 'P',
      States: {
        P: { Type: 'Parallel', Branches: [{ StartAt: 'X', States: { X: { Type: 'Pass' } } }], Next: 'M' },
        M: { Type: 'Map', ItemProcessor: { StartAt: 'Y', States: { Y: { Type: 'Pass', Next: 'Z' } } }, End: true },
      },
    };
    const msgs = validateAslStructure(def).map((i) => `${i.path}: ${i.message}`);
    expect(msgs.some((m) => m.includes('Branches[0].States.X'))).toBe(true);
    expect(msgs.some((m) => m.includes('"Z" is not a state'))).toBe(true);
  });
});
