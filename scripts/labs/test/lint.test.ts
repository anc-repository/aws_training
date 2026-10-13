import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { findCards, lintLabs } from '../src/lint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../../platform/shared/test/fixtures/svc-cdn.lab.yaml');
const TMP_ROOT = path.resolve(HERE, '../../../.atl-dev/tmp');

let labs = '';

function writeCard(dir: string, mutate?: (lab: Record<string, unknown>) => void): void {
  const lab = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'), { version: '1.2' }) as Record<string, unknown>;
  mutate?.(lab);
  const cardDir = path.join(labs, dir);
  fs.mkdirSync(path.join(cardDir, 'manual'), { recursive: true });
  fs.writeFileSync(path.join(cardDir, 'lab.yaml'), YAML.stringify(lab));
  for (const s of lab.steps as { manual: string }[]) fs.writeFileSync(path.join(cardDir, s.manual), '# step\n');
}

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  labs = fs.mkdtempSync(path.join(TMP_ROOT, 'labs-'));
});
afterEach(() => fs.rmSync(labs, { recursive: true, force: true }));

describe('labs:lint (scaffold rules)', () => {
  it('finds cards, skipping _-prefixed directories', () => {
    writeCard('svc-cdn');
    fs.mkdirSync(path.join(labs, '_schema'));
    expect(findCards(labs)).toEqual(['svc-cdn']);
  });

  it('the 04 §11.1 example card is clean', () => {
    writeCard('svc-cdn');
    expect(lintLabs(labs).issues).toEqual([]);
  });

  it('reports schema errors, id/dir mismatch, missing manual files and the C3 iam rule', () => {
    writeCard('svc-wrong');
    writeCard('svc-cdn', (lab) => {
      const sp = lab.startProfile as { provisions: { item: string }[] };
      sp.provisions = sp.provisions.filter((p) => p.item !== 'iam');
    });
    fs.rmSync(path.join(labs, 'svc-cdn', 'manual'), { recursive: true });
    writeCard('svc-bad', (lab) => {
      delete lab.tracks;
    });
    const { issues } = lintLabs(labs);
    const by = (card: string, rule: string) => issues.filter((i) => i.card === card && i.rule === rule);
    expect(by('svc-wrong', 'A1').some((i) => i.message.includes('directory'))).toBe(true);
    expect(by('svc-cdn', 'A2').length).toBeGreaterThan(0);
    expect(by('svc-cdn', 'A5')).toHaveLength(1);
    expect(by('svc-bad', 'A1').some((i) => i.message.startsWith('schema:'))).toBe(true);
  });
});
