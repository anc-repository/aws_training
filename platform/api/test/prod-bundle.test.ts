/**
 * Production / dev isolation: every Lambda entry is bundled with esbuild (as build.mjs does) and the bundle must not
 * contain any module from src/dev/** or the simulator (@atl/workflows).
 */
import { describe, expect, it } from 'vitest';
import { LAMBDA_FUNCTIONS } from '@atl/shared';
// @ts-expect-error build.mjs is plain JS without declarations
import { bundleFunction, forbiddenInputs, FUNCTIONS } from '../build.mjs';

describe('production bundles (nodejs22.x, esbuild)', () => {
  it('cover every Lambda of the name table', () => {
    expect(Object.keys(FUNCTIONS as Record<string, string>).sort()).toEqual([...LAMBDA_FUNCTIONS].sort());
  });

  for (const fn of LAMBDA_FUNCTIONS) {
    it(`${fn} bundles without dev code`, async () => {
      const r = (await bundleFunction(fn, { write: false })) as { metafile: { inputs: Record<string, unknown> }; errors: unknown[] };
      expect(r.errors).toEqual([]);
      const inputs = Object.keys(r.metafile.inputs);
      expect(inputs.some((p) => p.includes(`functions/`) && p.endsWith('index.ts'))).toBe(true);
      expect(forbiddenInputs(r.metafile)).toEqual([]);
    }, 30_000);
  }
});
