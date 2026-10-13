/**
 * Loads the whole content tree (04 §2.1): cards, shared checks, tracks, taxonomy, pricing. Loading never throws for a
 * content error — problems become `LintIssue`s (rule `LOAD`) so that `labs:lint` can report everything at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LabV2 } from '@atl/shared';
import { parseManual, type ParsedManual } from './manual.js';
import type { LabsPaths } from './paths.js';
import { PLANNED_STATUS } from './schemas/planned.js';
import { loadYamlFile } from './yaml.js';

export type Severity = 'error' | 'warn';

export interface LintIssue {
  card: string;
  rule: string;
  severity: Severity;
  message: string;
}

/** A check definition as written in `checks/*.yaml` (04 §5.1); kept loose, validated by the check schema. */
export type CheckDef = Record<string, unknown> & { id: string; type: string; title?: string };

export interface PitfallDef {
  id: string;
  title?: string;
  symptom?: string;
  match?: Record<string, unknown>[];
  cause?: string;
  fix?: string;
}

export interface CardContent {
  id: string;
  dir: string;
  /** parsed lab.yaml (may be schema-invalid) */
  raw: Record<string, unknown>;
  /** typed view (only meaningful after schema validation) */
  lab: LabV2;
  planned: boolean;
  checkFiles: { file: string; doc: unknown }[];
  checks: Map<string, CheckDef & { __file: string }>;
  pitfalls: Map<string, PitfallDef>;
  quiz: unknown;
  manuals: Map<string, ParsedManual>;
  assets: string[];
  stacks: string[];
}

export interface TrackItemCard {
  card: string;
  role: 'required' | 'optional';
  legacyLab?: number;
  note?: string;
}

export interface TrackItemGroup {
  group: string;
  title: string;
  pick: number;
  cards: string[];
  legacyLab?: number;
  note?: string;
}

export interface TrackDoc {
  schema: 'atl.track/v2';
  id: string;
  version: string;
  title: string;
  summary: string;
  audience?: string;
  domain?: string;
  stages: { id: string; title: string; legacyLabs?: number[]; note?: string; items: (TrackItemCard | TrackItemGroup)[] }[];
  completion: { allowManual: boolean; minAutoRatio: number; excludeSelfReported: boolean };
  certificate: { enabled: boolean; title: string };
}

export interface TaxonomyDoc {
  schema: string;
  version: string;
  categories: { id: string; label: string; token: string; symbol: string }[];
  services: { id: string; abbr: string; name: string; short?: string; function?: string; category?: string; module?: string; iamPrefix: string; featureOf?: string; consoleHome?: string }[];
  domains: { id: string; label: string; weight: number; track: string }[];
  durationBuckets: { id: 'short' | 'medium' | 'long'; label: string; maxMinutes?: number }[];
  costTier: { highUnits: number; weights: Record<string, number>; accountScopedKeys: string[]; labels: Record<string, string> };
  provisionSpeed: Record<string, 'base' | 'fast' | 'medium' | 'slow'>;
  provisionClassRules?: { heavy?: string[]; replacement?: string[] };
  provisionClasses: { id: string; label: string; hint: string }[];
  seeds?: { id: string; title: string }[];
}

export interface BillItem {
  key: string;
  pricingKey: string;
  billing: 'hourly' | 'monthly' | 'usage' | 'one-time';
  quantity: number;
  unit?: string;
  assumedUsagePerHour?: number;
  note?: string;
  scaleBy?: { key: string; values: Record<string, number>; default?: number };
}

export interface PricingDoc {
  schema: string;
  dimensions: Record<string, { serviceCode: string; filters: Record<string, string>; unit: string; freeTierNote?: boolean; note?: string }>;
  base?: BillItem[];
  workstation?: BillItem[];
  modules?: Record<string, BillItem[]>;
}

export interface ContentSet {
  paths: LabsPaths;
  cards: CardContent[];
  byId: Map<string, CardContent>;
  sharedChecks: Map<string, CheckDef & { __file: string }>;
  sharedPitfalls: Map<string, PitfallDef>;
  sharedCheckFiles: { file: string; doc: unknown }[];
  tracks: TrackDoc[];
  trackFiles: { file: string; doc: unknown }[];
  taxonomy: TaxonomyDoc | null;
  taxonomyRaw: unknown;
  pricing: PricingDoc | null;
  pricingRaw: unknown;
  issues: LintIssue[];
}

/** Card directories: `labs/<cardId>/lab.yaml`; directories starting with `_` or `.` are not cards. */
export function findCards(labsDir: string): string[] {
  if (!fs.existsSync(labsDir)) return [];
  return fs
    .readdirSync(labsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.') && fs.existsSync(path.join(labsDir, d.name, 'lab.yaml')))
    .map((d) => d.name)
    .sort();
}

function listFiles(dir: string, filter: (f: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (filter(e.name)) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

function collectChecks(
  owner: string,
  files: { file: string; doc: unknown }[],
  checks: Map<string, CheckDef & { __file: string }>,
  pitfalls: Map<string, PitfallDef>,
  issues: LintIssue[],
): void {
  for (const { file, doc } of files) {
    const d = doc as { checks?: unknown; pitfalls?: unknown } | null;
    if (!d || typeof d !== 'object') continue;
    for (const c of Array.isArray(d.checks) ? d.checks : []) {
      const id = (c as { id?: unknown })?.id;
      if (typeof id !== 'string') continue;
      if (checks.has(id)) issues.push({ card: owner, rule: 'A7', severity: 'error', message: `check id ${id} is defined twice (${checks.get(id)!.__file}, ${file})` });
      checks.set(id, { ...(c as CheckDef), __file: file });
    }
    for (const p of Array.isArray(d.pitfalls) ? d.pitfalls : []) {
      const id = (p as { id?: unknown })?.id;
      if (typeof id !== 'string') continue;
      if (pitfalls.has(id)) issues.push({ card: owner, rule: 'A7', severity: 'error', message: `pitfall id ${id} is defined twice` });
      pitfalls.set(id, p as PitfallDef);
    }
  }
}

function tryLoad(file: string, owner: string, issues: LintIssue[]): unknown {
  try {
    return loadYamlFile(file);
  } catch (e) {
    issues.push({ card: owner, rule: 'LOAD', severity: 'error', message: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

export function loadCard(paths: LabsPaths, id: string, issues: LintIssue[]): CardContent | null {
  const dir = path.join(paths.labs, id);
  const raw = tryLoad(path.join(dir, 'lab.yaml'), id, issues);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) issues.push({ card: id, rule: 'A1', severity: 'error', message: 'lab.yaml must be a mapping' });
    return null;
  }
  const r = raw as Record<string, unknown>;
  const planned = r.status === PLANNED_STATUS;
  const checkFiles = listFiles(path.join(dir, 'checks'), (f) => /\.ya?ml$/.test(f)).map((f) => ({
    file: `checks/${f}`,
    doc: tryLoad(path.join(dir, 'checks', f), id, issues),
  }));
  const checks = new Map<string, CheckDef & { __file: string }>();
  const pitfalls = new Map<string, PitfallDef>();
  collectChecks(id, checkFiles, checks, pitfalls, issues);
  const quizFile = path.join(dir, 'quiz.yaml');
  const quiz = fs.existsSync(quizFile) ? tryLoad(quizFile, id, issues) : undefined;
  const manuals = new Map<string, ParsedManual>();
  for (const f of listFiles(path.join(dir, 'manual'), (n) => n.endsWith('.md'))) {
    const rel = `manual/${f}`;
    try {
      manuals.set(rel, parseManual(fs.readFileSync(path.join(dir, rel), 'utf8'), rel));
    } catch (e) {
      issues.push({ card: id, rule: 'A2', severity: 'error', message: `${rel}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return {
    id,
    dir,
    raw: r,
    lab: r as unknown as LabV2,
    planned,
    checkFiles,
    checks,
    pitfalls,
    quiz,
    manuals,
    assets: listFiles(path.join(dir, 'assets'), () => true).map((f) => `assets/${f}`),
    stacks: listFiles(path.join(dir, 'stacks'), (f) => /\.ya?ml$/.test(f)).map((f) => `stacks/${f}`),
  };
}

export function loadContent(paths: LabsPaths): ContentSet {
  const issues: LintIssue[] = [];
  const cards: CardContent[] = [];
  for (const id of findCards(paths.labs)) {
    const c = loadCard(paths, id, issues);
    if (c) cards.push(c);
  }
  const sharedCheckFiles = listFiles(paths.sharedChecks, (f) => /\.ya?ml$/.test(f)).map((f) => ({
    file: `_shared/checks/${f}`,
    doc: tryLoad(path.join(paths.sharedChecks, f), '_shared', issues),
  }));
  const sharedChecks = new Map<string, CheckDef & { __file: string }>();
  const sharedPitfalls = new Map<string, PitfallDef>();
  collectChecks('_shared', sharedCheckFiles, sharedChecks, sharedPitfalls, issues);
  const trackFiles = listFiles(paths.tracks, (f) => /\.ya?ml$/.test(f)).map((f) => ({
    file: `_tracks/${f}`,
    doc: tryLoad(path.join(paths.tracks, f), '_tracks', issues),
  }));
  const taxonomyRaw = fs.existsSync(paths.taxonomy) ? tryLoad(paths.taxonomy, '_catalog', issues) : undefined;
  const pricingRaw = fs.existsSync(paths.pricing) ? tryLoad(paths.pricing, '_pricing', issues) : undefined;
  return {
    paths,
    cards,
    byId: new Map(cards.map((c) => [c.id, c])),
    sharedChecks,
    sharedPitfalls,
    sharedCheckFiles,
    tracks: trackFiles.map((t) => t.doc).filter((d): d is TrackDoc => !!d && typeof d === 'object') as TrackDoc[],
    trackFiles,
    taxonomy: (taxonomyRaw as TaxonomyDoc | undefined) ?? null,
    taxonomyRaw,
    pricing: (pricingRaw as PricingDoc | undefined) ?? null,
    pricingRaw,
    issues,
  };
}

/** Every card that will be startable (not a catalog placeholder). */
export function fullCards(set: ContentSet): CardContent[] {
  return set.cards.filter((c) => !c.planned);
}

/** Track membership: card id → [{ trackId, stageId, role, groupId? }] (05 §8.4 CatalogCard.tracks). */
export function trackMembership(tracks: readonly TrackDoc[]): Map<string, { trackId: string; stageId: string; role: 'required' | 'elective' | 'optional'; groupId?: string }[]> {
  const out = new Map<string, { trackId: string; stageId: string; role: 'required' | 'elective' | 'optional'; groupId?: string }[]>();
  const add = (card: string, v: { trackId: string; stageId: string; role: 'required' | 'elective' | 'optional'; groupId?: string }) => {
    const list = out.get(card) ?? [];
    list.push(v);
    out.set(card, list);
  };
  for (const t of tracks) {
    for (const s of t.stages ?? []) {
      for (const it of s.items ?? []) {
        if ('card' in it) add(it.card, { trackId: t.id, stageId: s.id, role: it.role });
        else for (const c of it.cards ?? []) add(c, { trackId: t.id, stageId: s.id, role: 'elective', groupId: it.group });
      }
    }
  }
  return out;
}
