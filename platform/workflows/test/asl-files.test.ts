import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATE_MACHINES } from '@atl/shared';
import { aslPath, loadStateMachine, validateAslStructure, validateAslWithLibrary } from '../src/index.js';

describe('statemachines/*.asl.json (01 §3.3)', () => {
  it('there is exactly one file per state machine of the name table', () => {
    const dir = aslPath(STATE_MACHINES[0]).replace(/[\\/][^\\/]+$/, '');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.asl.json')).sort();
    expect(files).toEqual(STATE_MACHINES.map((n) => `${n}.asl.json`).sort());
  });

  for (const name of STATE_MACHINES) {
    it(`${name} passes the structural checks and asl-validator`, async () => {
      const def = loadStateMachine(name);
      expect(validateAslStructure(def)).toEqual([]);
      const lib = await validateAslWithLibrary(def);
      expect(lib.errorsText).toBe('');
      expect(lib.isValid).toBe(true);
    });
  }
});
