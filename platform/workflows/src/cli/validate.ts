/**
 * `npm run validate -w @atl/workflows` — validate every state machine in statemachines/ with the structural checks and
 * with `asl-validator`. Exit code 1 when any definition has issues.
 */
import { STATE_MACHINES } from '@atl/shared';
import { aslPath, loadStateMachine } from '../asl/load.js';
import { validateAslStructure, validateAslWithLibrary } from '../asl/validate.js';

let failed = false;
for (const name of STATE_MACHINES) {
  const def = loadStateMachine(name);
  const issues = validateAslStructure(def).map((i) => `${i.path}: ${i.message}`);
  const lib = await validateAslWithLibrary(def);
  if (!lib.isValid) issues.push(`asl-validator: ${lib.errorsText}`);
  if (issues.length) {
    failed = true;
    console.error(`✗ ${aslPath(name)}\n  ${issues.join('\n  ')}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
process.exitCode = failed ? 1 : 0;
