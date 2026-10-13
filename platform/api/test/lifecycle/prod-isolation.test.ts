/**
 * Production / dev isolation of the lifecycle functions: the bundles of atl-lifecycle, atl-timer and atl-reaper carry the
 * AWS clouds (`setProductionClouds`) but nothing from `src/orchestrator-dev/**`, `src/dev/**`, the simulator or the
 * tests; the ASL placeholders are all covered by the substitutions the template derives from DEV_SUBSTITUTIONS.
 */
import { describe, expect, it } from 'vitest';
import { DEV_SUBSTITUTIONS, definitionPlaceholders, loadAllStateMachines } from '@atl/workflows';
// @ts-expect-error build.mjs is plain JS without declarations
import { bundleFunction } from '../../build.mjs';

const FORBIDDEN = [/[\\/]src[\\/]orchestrator-dev[\\/]/, /[\\/]src[\\/]dev[\\/]/, /platform[\\/]workflows[\\/]/, /[\\/]test[\\/]/];

describe('lifecycle production bundles', () => {
  for (const fn of ['atl-lifecycle', 'atl-timer', 'atl-reaper']) {
    it(`${fn}: AWS clouds wired, no dev code`, async () => {
      const r = (await bundleFunction(fn, { write: false })) as { metafile: { inputs: Record<string, unknown> }; outputFiles: { path: string; text: string }[] };
      const inputs = Object.keys(r.metafile.inputs);
      expect(inputs.filter((p) => FORBIDDEN.some((re) => re.test(p)))).toEqual([]);
      expect(inputs.some((p) => /functions[\\/]lifecycle[\\/]cloud[\\/]aws\.ts$/.test(p))).toBe(true);
      expect(inputs.some((p) => /functions[\\/]reaper[\\/]reclaimer[\\/]aws\.ts$/.test(p))).toBe(true);
      const js = r.outputFiles.find((f) => f.path.endsWith('.mjs'))!.text;
      expect(js).toContain('setProductionClouds(awsClouds)');
      expect(js).not.toContain('DevLifecycleCloud');
      expect(js).not.toContain('DevReclaimCloud');
    }, 60_000);
  }
});

describe('ASL placeholders', () => {
  it('every ${…} used by the six state machines has a substitution', () => {
    const defs = loadAllStateMachines();
    const missing: string[] = [];
    for (const [name, def] of Object.entries(defs)) {
      for (const p of definitionPlaceholders(def)) if (!(p in DEV_SUBSTITUTIONS)) missing.push(`${name}: ${p}`);
    }
    expect(missing).toEqual([]);
    expect(Object.keys(defs).sort()).toEqual(['atl-module-op', 'atl-platform-uninstall', 'atl-reclaim', 'atl-reclaim-rescan', 'atl-session-end', 'atl-session-start']);
  });
});
