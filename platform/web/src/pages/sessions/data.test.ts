import { describe, expect, it } from 'vitest';
import { stepCheckRefs } from './data';

describe('stepCheckRefs', () => {
  it('accepts both string ids and { ref, required, as } objects as published', () => {
    expect(
      stepCheckRefs({
        id: 'orient',
        checks: ['storage-local-baseline', { ref: 'data-volume-usage', required: false }, { ref: 'storage-wired', as: 'final-storage-wired' }, 'storage-local-baseline'],
      }),
    ).toEqual([
      { id: 'storage-local-baseline', key: 'storage-local-baseline', required: true },
      { id: 'data-volume-usage', key: 'data-volume-usage', required: false },
      { id: 'storage-wired', key: 'final-storage-wired', required: true },
    ]);
  });

  it('ignores malformed entries', () => {
    expect(stepCheckRefs({ id: 'x', checks: [{} as never, 3 as never] })).toEqual([]);
    expect(stepCheckRefs({ id: 'x' })).toEqual([]);
  });
});
