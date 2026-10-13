// 06 PM-37: arbitrary variant labels; the result records variant { label, role?, cardVariant? }; old string variants still read
import { describe, expect, it } from 'vitest';
import { validateLabel, variantLabelOf, variantOf } from './manifest.js';
import { validateResult } from './schema.js';
import type { ExperimentDef } from './types.js';

const exp = {
  module: 'queue', id: 'upload-burst', title: 't', kind: 'load',
  requires: { l0: {}, before: {}, after: {}, 'stop-instance': {} },
  labels: { l0: { title: '同步处理（L0）', role: 'baseline' }, after: { title: 'SQS', role: 'treatment' }, 'stop-instance': { role: 'single' } },
  scenario: { kind: 'http' },
} as unknown as ExperimentDef;

describe('variant labels (PM-37)', () => {
  it('any declared variant is accepted; undeclared or malformed labels are refused', () => {
    expect(() => validateLabel(exp, 'l0')).not.toThrow();
    expect(() => validateLabel(exp, 'stop-instance')).not.toThrow();
    expect(() => validateLabel(exp, 'selfhost')).toThrow(/不支持标签/);
    expect(() => validateLabel(exp, 'Bad_Label')).toThrow(/不合法/);
  });

  it('variantOf carries the declared role (and the card variant in platform mode)', () => {
    expect(variantOf(exp, 'l0')).toEqual({ label: 'l0', role: 'baseline' });
    expect(variantOf(exp, 'before')).toEqual({ label: 'before' });
    expect(variantOf(exp, 'after', 'default')).toEqual({ label: 'after', role: 'treatment', cardVariant: 'default' });
  });

  it('results with the new object and old string variants both read', () => {
    expect(variantLabelOf({ label: 'after', variant: { label: 'after:A' } })).toBe('after:A');
    expect(variantLabelOf({ label: 'after', variant: 'after' })).toBe('after');
    expect(variantLabelOf({ label: 'after' })).toBe('after');
    const base = {
      schemaVersion: 1, runId: '01JB3M2C8Y3T5Q6W7E8R9T0Y1V', module: 'queue', experiment: 'upload-burst', label: 'l0', forced: false,
      startedAt: '2026-10-14T00:00:00.000Z', finishedAt: '2026-10-14T00:01:00.000Z', target: 'http://x',
      params: { vus: 1, duration: '10s', repeat: 1, ab: false }, environment: { drivers: {}, capabilitiesHash: 'none' },
      client: { requests: 0, errors: 0 }, server: {},
    };
    const objectVariant = validateResult({ ...base, variant: { label: 'l0', role: 'baseline' } });
    const stringVariant = validateResult({ ...base, variant: 'l0' });
    const badVariant = validateResult({ ...base, variant: { label: 'l0', role: 'other' } });
    expect(objectVariant.errors.filter((e) => e.includes('variant'))).toEqual([]);
    expect(stringVariant.errors.filter((e) => e.includes('variant'))).toEqual([]);
    expect(badVariant.ok).toBe(false);
  });
});
