#!/usr/bin/env node
/**
 * Card content tools (04 §2.5). Root scripts: `npm run labs:<command>`.
 *
 *   schema   write labs/_schema/lab.schema.json from @atl/shared (the 04 §3.3 transcription)
 *   lint     schema + single-card rules (04 §3.5 A/B; scaffold implements A1, A2, A5)
 *   derive   start-state derivation via scripts/module plan --start-of (group C)      — not implemented yet
 *   build    content release dist/content/<contentDigest>/                             — not implemented yet
 *   catalog  labs/_catalog/catalog.yaml                                                — not implemented yet
 *   policy   ATLVerifierRole read-only allow list (platform/infra/policies/generated) — not implemented yet
 *
 * Options: --labs <dir> (default: <repo>/labs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB_SCHEMA_V2 } from '@atl/shared';
import { lintLabs } from './lint.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

export function writeSchema(labsDir: string): string {
  const file = path.join(labsDir, '_schema', 'lab.schema.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(LAB_SCHEMA_V2, null, 2) + '\n');
  return file;
}

function main(): number {
  const cmd = process.argv[2];
  const labsDir = path.resolve(opt('--labs', path.join(REPO_ROOT, 'labs')));
  switch (cmd) {
    case 'schema': {
      console.log(`wrote ${path.relative(process.cwd(), writeSchema(labsDir))}`);
      return 0;
    }
    case 'lint': {
      const { cards, issues } = lintLabs(labsDir);
      for (const i of issues) console.log(`${i.severity === 'error' ? '✗' : '!'} ${i.card} [${i.rule}] ${i.message}`);
      const errors = issues.filter((i) => i.severity === 'error').length;
      console.log(`labs:lint: ${cards.length} card(s), ${errors} error(s), ${issues.length - errors} warning(s)`);
      return errors > 0 ? 1 : 0;
    }
    case 'derive':
    case 'build':
    case 'catalog':
    case 'policy':
      console.error(`labs:${cmd} is not implemented yet (labs-tools implementer; 04 §2.5, §3.5)`);
      return 2;
    default:
      console.error('usage: atl-labs <schema|lint|derive|build|catalog|policy> [--labs <dir>]');
      return 2;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) process.exitCode = main();
