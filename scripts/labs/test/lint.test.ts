/**
 * labs:lint against the repository content and against mutated copies of it (temporary directories under .atl-dev/tmp).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findCards } from '../src/content.js';
import { lintLabs } from '../src/lint/index.js';
import { labsPaths, REPO_ROOT } from '../src/paths.js';
import { parseYamlText, stringifyYaml } from '../src/yaml.js';

const TMP_ROOT = path.join(REPO_ROOT, '.atl-dev', 'tmp');
/** the first batch (MVP) and wave 1 (wave1-integration): 22 startable cards, the other 34 are catalog placeholders */
const FULL = [
  'sc-edge-protection', 'sc-event-fanout', 'sc-static-acceleration',
  'svc-auth', 'svc-cache', 'svc-cdn', 'svc-cost', 'svc-database', 'svc-dns', 'svc-ec2', 'svc-email', 'svc-iam', 'svc-identity-pool',
  'svc-image-processing', 'svc-logging', 'svc-monitoring', 'svc-notification', 'svc-queue', 'svc-shell-access', 'svc-storage', 'svc-tls', 'svc-waf',
];

let copy = '';

function copyLabs(): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'labs-lint-'));
  fs.cpSync(path.join(REPO_ROOT, 'labs'), dir, { recursive: true });
  return dir;
}

function editYaml(file: string, mutate: (doc: Record<string, unknown>) => void): void {
  const doc = parseYamlText(fs.readFileSync(file, 'utf8'), file) as Record<string, unknown>;
  mutate(doc);
  fs.writeFileSync(file, stringifyYaml(doc, ''));
}

describe('labs:lint on the repository content', () => {
  it('finds all 56 cards, skipping _-prefixed directories', () => {
    const cards = findCards(path.join(REPO_ROOT, 'labs'));
    expect(cards).toHaveLength(56);
    expect(cards.every((c) => !c.startsWith('_'))).toBe(true);
    for (const id of FULL) expect(cards).toContain(id);
  });

  it('every card passes (0 errors, 0 warnings)', async () => {
    const { issues, cards } = await lintLabs(labsPaths());
    expect(cards).toHaveLength(56);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues).toEqual([]);
  }, 60_000);

  it('the first batch and wave 1 are complete and the other 34 cards are catalog placeholders', async () => {
    const { set } = await lintLabs(labsPaths(), { checkCatalog: false });
    const full = set.cards.filter((c) => !c.planned).map((c) => c.id).sort();
    expect(full).toEqual(FULL);
    expect(set.cards.filter((c) => c.planned)).toHaveLength(34);
    for (const c of set.cards.filter((x) => !x.planned)) {
      expect(c.manuals.size).toBeGreaterThan(3);
      expect(c.checks.size).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe('labs:lint on mutated content', () => {
  beforeAll(() => {
    copy = copyLabs();
    const q = path.join(copy, 'svc-queue');
    // A5: the C3 iam provision removed from a card that needs it
    editYaml(path.join(q, 'lab.yaml'), (lab) => {
      const sp = lab.startProfile as { provisions: { item: string }[] };
      sp.provisions = sp.provisions.filter((p) => p.item !== 'iam');
    });
    // A2: a manual file referenced by a step is missing
    fs.rmSync(path.join(q, 'manual', '50-poison.md'));
    // A7: a step references a check that does not exist
    editYaml(path.join(copy, 'svc-cache', 'lab.yaml'), (lab) => {
      const steps = lab.steps as { id: string; checks: unknown[] }[];
      steps.find((s) => s.id === 'inspect')!.checks.push('no-such-check');
    });
    // A11: an experiment step whose label is not declared
    editYaml(path.join(copy, 'svc-database', 'lab.yaml'), (lab) => {
      const steps = lab.steps as { id: string; experiment?: { label: string } }[];
      steps.find((s) => s.id === 'after')!.experiment!.label = 'later';
    });
    // B23: tracks that do not match the track files
    editYaml(path.join(copy, 'svc-iam', 'lab.yaml'), (lab) => {
      lab.tracks = ['saa-main'];
    });
    // A17: a quiz answer that is not an option
    editYaml(path.join(copy, 'svc-auth', 'quiz.yaml'), (quiz) => {
      (quiz.questions as { answer: string[] }[])[0]!.answer = ['z'];
    });
    // A1 (planned schema): a planned card must not have steps
    editYaml(path.join(copy, 'svc-waf', 'lab.yaml'), (lab) => {
      lab.steps = [];
    });
  });
  afterAll(() => fs.rmSync(copy, { recursive: true, force: true }));

  it('reports each injected defect under its rule', async () => {
    const { issues } = await lintLabs(labsPaths(copy), { checkCatalog: false });
    const by = (card: string, rule: string) => issues.filter((i) => i.card === card && i.rule === rule && i.severity === 'error');
    expect(by('svc-queue', 'A5').length).toBeGreaterThan(0);
    expect(by('svc-queue', 'A2').some((i) => i.message.includes('50-poison.md'))).toBe(true);
    expect(by('svc-cache', 'A7').some((i) => i.message.includes('no-such-check'))).toBe(true);
    expect(by('svc-database', 'A11').some((i) => i.message.includes('later'))).toBe(true);
    expect(by('svc-iam', 'B23').length).toBe(1);
    expect(by('svc-auth', 'A17').length).toBeGreaterThan(0);
    expect(by('svc-waf', 'A1').length).toBeGreaterThan(0);
    // untouched cards stay clean
    for (const id of ['svc-cdn', 'svc-storage', 'svc-ec2', 'sc-static-acceleration']) {
      expect(issues.filter((i) => i.card === id && i.severity === 'error')).toEqual([]);
    }
  }, 60_000);
});
