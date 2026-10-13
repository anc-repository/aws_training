/**
 * `labs:lint` (04 §3.5). Scaffold scope: card discovery, safe YAML 1.2 loading, schema validation (rule A1) and the
 * cheapest unambiguous single-card rules (A1 id/kind/title/modules.target, A2 manual files exist, A5 the C3 iam rule).
 * The labs-tools implementer adds the remaining A/B rules here (and `labs:derive` for group C).
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { validateLab, type LabV2 } from '@atl/shared';

export type Severity = 'error' | 'warn';

export interface LintIssue {
  card: string;
  rule: string;
  severity: Severity;
  message: string;
}

export interface LoadedCard {
  dir: string;
  id: string;
  doc: unknown;
}

/** 04 §2.2: safe mode, no custom tags, ≤ 256 KB per file. */
export const MAX_YAML_BYTES = 256 * 1024;

export function loadYamlFile(file: string): unknown {
  const size = fs.statSync(file).size;
  if (size > MAX_YAML_BYTES) throw new Error(`${file}: ${size} bytes exceeds ${MAX_YAML_BYTES}`);
  return YAML.parse(fs.readFileSync(file, 'utf8'), { version: '1.2', schema: 'core', customTags: [], maxAliasCount: 100 });
}

/** Card directories: `labs/<cardId>/lab.yaml`; directories starting with `_` are not cards. */
export function findCards(labsDir: string): string[] {
  if (!fs.existsSync(labsDir)) return [];
  return fs
    .readdirSync(labsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.') && fs.existsSync(path.join(labsDir, d.name, 'lab.yaml')))
    .map((d) => d.name)
    .sort();
}

export function lintCard(labsDir: string, cardDir: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (rule: string, message: string, severity: Severity = 'error') => issues.push({ card: cardDir, rule, severity, message });
  let doc: unknown;
  try {
    doc = loadYamlFile(path.join(labsDir, cardDir, 'lab.yaml'));
  } catch (e) {
    add('A1', `lab.yaml cannot be parsed: ${e instanceof Error ? e.message : String(e)}`);
    return issues;
  }
  const r = validateLab(doc);
  if (!r.ok) {
    for (const i of r.issues) add('A1', `schema: ${i.path}: ${i.message}`);
    return issues;
  }
  const lab: LabV2 = r.lab;

  // A1: id = directory, kind = prefix, title, modules.target = targetModules[].id
  if (lab.id !== cardDir) add('A1', `id ${lab.id} differs from the directory name ${cardDir}`);
  const expectedKind = lab.id.startsWith('svc-') ? 'service' : 'scenario';
  if (lab.kind !== expectedKind) add('A1', `kind ${lab.kind} does not match the id prefix (${expectedKind})`);
  if (lab.kind === 'service' && lab.title !== `${lab.service}：${lab.function}`) {
    add('A1', `title must be "<service>：<function>" = "${lab.service}：${lab.function}"`);
  }
  const target = [...lab.modules.target].sort();
  const tm = [...new Set(lab.targetModules.map((t) => t.id))].sort();
  if (JSON.stringify(target) !== JSON.stringify(tm)) add('A1', `modules.target [${target}] must equal targetModules[].id [${tm}]`);

  // A2: manual files exist, one per step
  const seen = new Map<string, string>();
  for (const s of lab.steps) {
    if (!fs.existsSync(path.join(labsDir, cardDir, s.manual))) add('A2', `step ${s.id}: manual file ${s.manual} does not exist`);
    const other = seen.get(s.manual);
    if (other) add('A2', `steps ${other} and ${s.id} share the manual file ${s.manual}`);
    seen.set(s.manual, s.id);
  }
  const ids = lab.steps.map((s) => s.id);
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) add('A2', `duplicate step id ${d}`);

  // A5: the C3 iam rule
  const iam = lab.startProfile.provisions.find((p) => p.item === 'iam' && p.kind === 'module');
  if (lab.id === 'svc-ec2' || lab.id === 'svc-iam') {
    if (iam) add('A5', `${lab.id} must not pre-provision iam`);
  } else if (!iam || iam.basis !== 'credential' || iam.set?.IAM_CREDENTIALS !== 'role') {
    add('A5', 'startProfile.provisions must contain { item: iam, kind: module, basis: credential, set: { IAM_CREDENTIALS: role } }');
  }
  return issues;
}

export function lintLabs(labsDir: string): { cards: string[]; issues: LintIssue[] } {
  const cards = findCards(labsDir);
  return { cards, issues: cards.flatMap((c) => lintCard(labsDir, c)) };
}
