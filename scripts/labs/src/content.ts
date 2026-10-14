/**
 * Loads the whole content tree (04 §2.1): cards, shared checks, tracks, taxonomy, pricing. Loading never throws for a
 * content error — problems become `LintIssue`s (rule `LOAD`) so that `labs:lint` can report everything at once.
 *
 * Languages (09-i18n-and-visual.md §2): text fields may be `{ zh-CN, ja?, en? }`. A content set is loaded for one language
 * (default zh-CN, the source): every document is resolved to plain strings in that language (fallback → en → zh-CN), so
 * lint, catalog and build work on strings as before; the documents as written stay available as `source` for the
 * translation rules (lint I1–I5) and the coverage report. Manuals are picked per file in the same order.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LabV2 } from '@atl/shared';
import { localizeDoc, manualLanguageOf, pickManualLang, SOURCE_LANG, type ContentLang } from './l10n.js';
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
  /** parsed lab.yaml resolved to the set's language (may be schema-invalid) */
  raw: Record<string, unknown>;
  /** lab.yaml as written (text fields may be localized objects) */
  source: Record<string, unknown>;
  /** typed view (only meaningful after schema validation) */
  lab: LabV2;
  planned: boolean;
  checkFiles: { file: string; doc: unknown; source: unknown }[];
  checks: Map<string, CheckDef & { __file: string }>;
  pitfalls: Map<string, PitfallDef>;
  quiz: unknown;
  quizSource: unknown;
  /** manuals shown in the set's language, keyed by the zh-CN file (`manual/01-x.md`) */
  manuals: Map<string, ParsedManual>;
  /** language of each entry of `manuals` */
  manualLangs: Map<string, ContentLang>;
  /** zh-CN manuals (the source), whatever the set's language */
  sourceManuals: Map<string, ParsedManual>;
  /** translated manuals as written: `manual/ja/01-x.md` → language ja, key `manual/01-x.md` */
  translations: Map<ContentLang, Map<string, ParsedManual>>;
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
  /** language every text of this set is resolved to */
  lang: ContentLang;
  cards: CardContent[];
  byId: Map<string, CardContent>;
  sharedChecks: Map<string, CheckDef & { __file: string }>;
  sharedPitfalls: Map<string, PitfallDef>;
  sharedCheckFiles: { file: string; doc: unknown; source: unknown }[];
  tracks: TrackDoc[];
  trackFiles: { file: string; doc: unknown; source: unknown }[];
  taxonomy: TaxonomyDoc | null;
  taxonomyRaw: unknown;
  taxonomySource: unknown;
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

export interface LoadOptions {
  /** language to resolve every text to (default zh-CN) */
  lang?: ContentLang;
  /** prefix values shown in another language with FALLBACK_MARK (labs:build, see l10n.ts) */
  mark?: boolean;
}

function loadManuals(dir: string, id: string, lang: ContentLang, issues: LintIssue[]) {
  const all = new Map<ContentLang, Map<string, ParsedManual>>();
  for (const f of listFiles(path.join(dir, 'manual'), (n) => n.endsWith('.md'))) {
    const rel = `manual/${f}`;
    const where = manualLanguageOf(rel);
    let parsed: ParsedManual;
    try {
      parsed = parseManual(fs.readFileSync(path.join(dir, rel), 'utf8'), where.lang === SOURCE_LANG ? where.file : rel);
    } catch (e) {
      issues.push({ card: id, rule: 'A2', severity: 'error', message: `${rel}: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const byFile = all.get(where.lang) ?? new Map<string, ParsedManual>();
    if (byFile.has(where.file)) issues.push({ card: id, rule: 'I3', severity: 'error', message: `${rel}: ${where.file} exists twice for ${where.lang} (manual/ and manual/${where.lang}/)` });
    byFile.set(where.file, parsed);
    all.set(where.lang, byFile);
  }
  const source = all.get(SOURCE_LANG) ?? new Map<string, ParsedManual>();
  const manuals = new Map<string, ParsedManual>();
  const manualLangs = new Map<string, ContentLang>();
  for (const file of source.keys()) {
    const available = new Set<ContentLang>([...all.entries()].filter(([, m]) => m.has(file)).map(([l]) => l));
    const l = pickManualLang(available, lang);
    manuals.set(file, all.get(l)!.get(file)!);
    manualLangs.set(file, l);
  }
  const translations = new Map([...all.entries()].filter(([l]) => l !== SOURCE_LANG));
  return { manuals, manualLangs, sourceManuals: source, translations };
}

export function loadCard(paths: LabsPaths, id: string, issues: LintIssue[], opts: LoadOptions = {}): CardContent | null {
  const lang = opts.lang ?? SOURCE_LANG;
  const loc = { lang, ...(opts.mark ? { mark: true } : {}) };
  const dir = path.join(paths.labs, id);
  const raw = tryLoad(path.join(dir, 'lab.yaml'), id, issues);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) issues.push({ card: id, rule: 'A1', severity: 'error', message: 'lab.yaml must be a mapping' });
    return null;
  }
  const source = raw as Record<string, unknown>;
  const planned = source.status === PLANNED_STATUS;
  const r = localizeDoc(source, planned ? 'lab-planned' : 'lab', loc);
  const checkFiles = listFiles(path.join(dir, 'checks'), (f) => /\.ya?ml$/.test(f)).map((f) => {
    const doc = tryLoad(path.join(dir, 'checks', f), id, issues);
    return { file: `checks/${f}`, doc: localizeDoc(doc, 'check', loc), source: doc };
  });
  const checks = new Map<string, CheckDef & { __file: string }>();
  const pitfalls = new Map<string, PitfallDef>();
  collectChecks(id, checkFiles, checks, pitfalls, issues);
  const quizFile = path.join(dir, 'quiz.yaml');
  const quizSource = fs.existsSync(quizFile) ? tryLoad(quizFile, id, issues) : undefined;
  const { manuals, manualLangs, sourceManuals, translations } = loadManuals(dir, id, lang, issues);
  return {
    id,
    dir,
    raw: r,
    source,
    lab: r as unknown as LabV2,
    planned,
    checkFiles,
    checks,
    pitfalls,
    quiz: localizeDoc(quizSource, 'quiz', loc),
    quizSource,
    manuals,
    manualLangs,
    sourceManuals,
    translations,
    assets: listFiles(path.join(dir, 'assets'), () => true).map((f) => `assets/${f}`),
    stacks: listFiles(path.join(dir, 'stacks'), (f) => /\.ya?ml$/.test(f)).map((f) => `stacks/${f}`),
  };
}

export function loadContent(paths: LabsPaths, opts: LoadOptions = {}): ContentSet {
  const lang = opts.lang ?? SOURCE_LANG;
  const loc = { lang, ...(opts.mark ? { mark: true } : {}) };
  const issues: LintIssue[] = [];
  const cards: CardContent[] = [];
  for (const id of findCards(paths.labs)) {
    const c = loadCard(paths, id, issues, opts);
    if (c) cards.push(c);
  }
  const sharedCheckFiles = listFiles(paths.sharedChecks, (f) => /\.ya?ml$/.test(f)).map((f) => {
    const doc = tryLoad(path.join(paths.sharedChecks, f), '_shared', issues);
    return { file: `_shared/checks/${f}`, doc: localizeDoc(doc, 'check', loc), source: doc };
  });
  const sharedChecks = new Map<string, CheckDef & { __file: string }>();
  const sharedPitfalls = new Map<string, PitfallDef>();
  collectChecks('_shared', sharedCheckFiles, sharedChecks, sharedPitfalls, issues);
  const trackFiles = listFiles(paths.tracks, (f) => /\.ya?ml$/.test(f)).map((f) => {
    const doc = tryLoad(path.join(paths.tracks, f), '_tracks', issues);
    return { file: `_tracks/${f}`, doc: localizeDoc(doc, 'track', loc), source: doc };
  });
  const taxonomySource = fs.existsSync(paths.taxonomy) ? tryLoad(paths.taxonomy, '_catalog', issues) : undefined;
  const taxonomyRaw = localizeDoc(taxonomySource, 'taxonomy', loc);
  const pricingRaw = fs.existsSync(paths.pricing) ? tryLoad(paths.pricing, '_pricing', issues) : undefined;
  return {
    paths,
    lang,
    cards,
    byId: new Map(cards.map((c) => [c.id, c])),
    sharedChecks,
    sharedPitfalls,
    sharedCheckFiles,
    tracks: trackFiles.map((t) => t.doc).filter((d): d is TrackDoc => !!d && typeof d === 'object') as TrackDoc[],
    trackFiles,
    taxonomy: (taxonomyRaw as TaxonomyDoc | undefined) ?? null,
    taxonomyRaw,
    taxonomySource,
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
