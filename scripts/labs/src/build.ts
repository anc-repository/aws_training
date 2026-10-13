/**
 * `labs:build` (04 §2.5, 05 §8.4): the content release `dist/content/<catalogVersion>/`.
 *
 *   index.json, catalog/index.json   CatalogIndex (`atl.catalog-index/v2`): taxonomy, cards, full track definitions with
 *                                    their summaries, service map (atl-api reads catalog/index.json, then index.json)
 *   catalog/cards/<id>.json          CardIntro (05 §8.4; + workstation / keepablePrerequisites, 08 §9.2 #29)
 *   labs/<id>.json                   the expanded card: lab.yaml v2 + `checks` (by local id) + `checkSources` + `checkHashes`
 *                                    + `pitfalls` + `startProfileDigests` + `manuals` (atl.mdast/v1 + source) +
 *                                    generated `xstk-*` platformOps (read by atl-api and atl-checks)
 *   tracks/<id>.json                 track definitions
 *   profiles/atl/<id>/<variant>.env  start profiles (06 PM-33), one per variant of every startable card
 *   stacks/<id>/<stackId>.yaml       card stacks (extraStacks)
 *   assets/<id>/…                    images
 *   private/quiz/<id>.json           quiz banks with answers (copied to atl-artifacts only, never to atl-web)
 *   manifest.json                    SHA-256 of every file, `contentDigest`, `catalogVersion`, versions, start profiles
 *
 * `contentDigest` = SHA-256 over the sorted `path:sha256` lines of all files except manifest.json. Placeholders
 * (`status: planned`) get catalog entries, an intro and a metadata-only labs/<id>.json, never a profile.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LabV2 } from '@atl/shared';
import { buildCatalog, catalogCard, orderedCards, trackSummaries, type CatalogModel } from './catalog.js';
import { expandChecks, expandPitfalls } from './checks.js';
import { fullCards, type CardContent, type ContentSet, type LintIssue } from './content.js';
import { deriveAll, type CardDerivation, type DeriverMode } from './derive/index.js';
import { loadRegistry, registryVersion, toolkitVersion } from './registry.js';
import { readTextIfExists } from './paths.js';

export interface BuildOptions {
  outDir?: string;
  catalogVersion?: string;
  deriver?: DeriverMode;
  /** fixed `generatedAt` (deterministic builds); defaults to SOURCE_DATE_EPOCH or the epoch */
  generatedAt?: string;
}

export interface BuildResult {
  dir: string;
  catalogVersion: string;
  contentDigest: string;
  files: number;
  deriver: string;
  issues: LintIssue[];
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function defaultCatalogVersion(set: ContentSet): string {
  const v = readTextIfExists(set.paths.platformVersion)?.trim();
  return v && /^[0-9A-Za-z.+-]{1,64}$/.test(v) ? v : 'dev';
}

function generatedAtOf(opts: BuildOptions): string {
  if (opts.generatedAt) return opts.generatedAt;
  const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? '0');
  return new Date((Number.isFinite(epoch) ? epoch : 0) * 1000).toISOString();
}

const stable = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function rulesMessages(set: ContentSet): Map<string, string> {
  const out = new Map<string, string>();
  const text = readTextIfExists(set.paths.rules) ?? '';
  const re = /id:\s*'([A-Z]+-[0-9]{3})'[\s\S]*?message:\s*\([^)]*\)\s*=>\s*(?:'([^']*)'|`([^`]*)`)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) if (!out.has(m[1]!)) out.set(m[1]!, (m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, '…'));
  return out;
}

function displayName(set: ContentSet, module: string): string {
  return set.taxonomy?.services.find((s) => s.module === module)?.name ?? loadRegistry(set.paths).modules[module]?.awsService ?? module;
}

function cardIntro(set: ContentSet, card: CardContent, messages: Map<string, string>): Record<string, unknown> {
  const lab: LabV2 = card.lab;
  const overview = [...card.manuals.values()].find((m) => m.frontMatter?.section === 'overview');
  const variants = ['default', ...(lab.startProfile?.variants ?? []).map((v) => v.id)];
  const provisions = variants.flatMap((v) => {
    const list = v === 'default' ? (lab.startProfile?.provisions ?? []) : (lab.startProfile?.variants?.find((x) => x.id === v)?.provisions ?? []);
    return list.map((p) => ({
      item: p.item,
      kind: p.kind,
      displayName: p.kind === 'module' || p.kind === 'local' ? displayName(set, p.item) : p.item,
      reason: p.reason ?? '',
      variant: v,
      ...(p.set ? { set: p.set } : {}),
    }));
  });
  return {
    schema: 'atl.card-intro/v1',
    id: card.id,
    status: lab.status ?? 'stable',
    startable: !card.planned,
    overview: overview?.ast ?? null,
    ...(lab.scenario ? { scenario: { question: lab.scenario.question, constraints: lab.scenario.constraints ?? [], antiPatterns: lab.scenario.antiPatterns ?? [] } } : {}),
    story: lab.story ?? null,
    objectives: lab.objectives ?? [],
    resources: {
      provisions,
      extraStacks: (lab.extraStacks ?? []).map((x) => ({ id: x.id, title: x.id })),
      targets: (lab.targetModules ?? []).map((t) => ({ moduleId: t.id, displayName: displayName(set, t.id), ...(t.fromDriver ? { from: t.fromDriver } : {}), to: t.driver, optional: t.optional === true })),
      expectedWarnings: (lab.expectedWarnings ?? []).map((r) => ({ rule: r, text: messages.get(r) ?? '' })),
    },
    steps: (lab.steps ?? []).map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      optional: !!s.optional,
      wire: !!s.wire,
      ...(s.when ? { when: s.when } : {}),
      ...(s.wait ? { wait: { typicalMinutes: s.wait.typicalMinutes, maxMinutes: s.wait.maxMinutes } } : {}),
      ...(s.startsBilling ? { startsBilling: { class: s.startsBilling.class } } : {}),
      expectedOutage: !!s.expectedOutage,
    })),
    experiments: (lab.experiments ?? []).map((e) => ({
      module: e.module,
      id: e.id,
      title: `${e.module}/${e.id}`,
      required: e.required,
      labels: e.labels.map((l) => (typeof l === 'string' ? l : l.id)),
    })),
    saa: {
      topics: (lab.saa?.topics ?? []).filter((t): t is { id: string; title: string; domain: 'secure' } => 'title' in t).map((t) => ({ title: t.title, domain: t.domain })),
      confusables: (lab.saa?.confusables ?? []).filter((c): c is { a: string; b: string; rule: string } => 'a' in c),
    },
    cleanupSummary: lab.cleanup?.summary ?? '',
    timing: { extensions: lab.extensions, retain: lab.retain },
    workstation: { required: lab.workstation?.required !== false, savingsMode: lab.workstation?.savingsMode ?? 'ok', tools: lab.workstation?.tools ?? [] },
    keepablePrerequisites: lab.keepablePrerequisites ?? [],
    prerequisites: lab.prerequisites ?? {},
    accountImpact: lab.platform?.accountImpact ?? [],
    platformOps: (lab.platformOps ?? []).map((o) => ({ id: o.id, title: o.title, optional: o.optional === true, ...(o.confirm ? { confirm: o.confirm } : {}) })),
  };
}

function expandedCard(set: ContentSet, card: CardContent, derivation: CardDerivation | undefined, catalogVersion: string): Record<string, unknown> {
  const lab = card.lab;
  if (card.planned) return { ...lab, checks: {}, catalogVersion };
  const ex = expandChecks(set, card);
  const xstk = (lab.extraStacks ?? [])
    .filter((x) => x.deploy.startsWith('step:'))
    .map((x) => ({ id: `xstk-${x.id}`, op: 'extra-stack', stackId: x.id, title: `部署 ${x.id}`, optional: x.optional === true }));
  const manuals: Record<string, unknown> = {};
  for (const [file, m] of [...card.manuals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    manuals[file] = { frontMatter: m.frontMatter, ast: m.ast, source: m.body };
  }
  const startProfileDigests: Record<string, string> = {};
  for (const v of derivation?.variants ?? []) if (v.plan) startProfileDigests[v.variant] = v.plan.digest;
  return {
    ...lab,
    ...(xstk.length ? { platformOps: [...(lab.platformOps ?? []), ...xstk] } : {}),
    checks: ex.checks,
    checkSources: ex.sources,
    checkHashes: ex.checkHashes,
    pitfalls: expandPitfalls(set, card),
    startProfileDigests,
    manuals,
    catalogVersion,
  };
}

export async function buildContent(set: ContentSet, opts: BuildOptions = {}): Promise<BuildResult> {
  const catalogVersion = opts.catalogVersion ?? defaultCatalogVersion(set);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(catalogVersion)) throw new Error(`invalid catalog version ${catalogVersion}`);
  const dir = path.resolve(opts.outDir ?? path.join(set.paths.dist, 'content', catalogVersion));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = new Map<string, Buffer>();
  const put = (rel: string, data: string | Buffer) => files.set(rel, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));

  const derived = await deriveAll(set, opts.deriver ?? 'auto');
  const derivations = new Map(derived.cards.map((c) => [c.card, c]));
  const issues = [...derived.issues];
  const generatedAt = generatedAtOf(opts);
  const catalog: CatalogModel = buildCatalog(set, derivations);
  const messages = rulesMessages(set);

  // labs/, catalog/cards/, profiles/, stacks/, assets/, private/quiz/
  for (const card of orderedCards(set)) {
    const d = derivations.get(card.id);
    put(`labs/${card.id}.json`, stable(expandedCard(set, card, d, catalogVersion)));
    put(`catalog/cards/${card.id}.json`, stable(cardIntro(set, card, messages)));
    if (card.planned) continue;
    const ex = expandChecks(set, card);
    for (const u of ex.unresolved) issues.push({ card: card.id, rule: 'A7', severity: 'error', message: `build: ${u.message}` });
    for (const v of d?.variants ?? []) {
      if (v.profile) put(`profiles/atl/${card.id}/${v.variant}.env`, v.profile);
      else issues.push({ card: card.id, rule: 'DRV-9', severity: 'error', message: `build: no start profile for variant ${v.variant}` });
    }
    for (const s of card.stacks) put(`stacks/${card.id}/${path.posix.basename(s)}`, fs.readFileSync(path.join(card.dir, s)));
    for (const a of card.assets) put(`assets/${card.id}/${a.slice('assets/'.length)}`, fs.readFileSync(path.join(card.dir, a)));
    if (card.quiz !== undefined && card.lab.quiz) put(`private/quiz/${card.id}.json`, stable(card.quiz));
  }
  // tracks/
  const summaries = new Map(trackSummaries(set).map((t) => [t.id, t]));
  const tracks = set.tracks.map((t) => ({ ...t, ...(summaries.get(t.id) ?? {}), stages: t.stages }));
  for (const t of tracks) put(`tracks/${t.id}.json`, stable(t));
  // catalog index
  const index = {
    schema: 'atl.catalog-index/v2',
    catalogVersion,
    generatedAt,
    source: catalog.source,
    counts: catalog.counts,
    taxonomy: set.taxonomy,
    defaults: { view: 'grid', group: 'kind', sort: 'path', track: 'saa-main' },
    cards: catalog.cards,
    tracks,
    serviceMap: catalog.serviceMap,
  };
  put('catalog/index.json', stable(index));
  put('index.json', stable(index));

  // manifest
  const fileDigests: Record<string, string> = {};
  for (const [rel, buf] of [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) fileDigests[rel] = `sha256:${sha256(buf)}`;
  const contentDigest = `sha256:${sha256(Object.entries(fileDigests).map(([k, v]) => `${k}:${v}`).join('\n'))}`;
  const startProfiles: Record<string, { digest: string; file: string; sha256: string }> = {};
  for (const c of fullCards(set)) {
    for (const v of derivations.get(c.id)?.variants ?? []) {
      if (!v.plan) continue;
      const file = `profiles/atl/${c.id}/${v.variant}.env`;
      startProfiles[`atl/${c.id}/${v.variant}`] = { digest: v.plan.digest, file, sha256: fileDigests[file] ?? '' };
    }
  }
  const manifest = {
    schema: 'atl.content-manifest/v1',
    catalogVersion,
    contentDigest,
    generatedAt,
    registryVersion: registryVersion(set.paths),
    toolkitVersion: toolkitVersion(set.paths),
    taxonomyVersion: set.taxonomy?.version ?? '0.0.0',
    platformVersion: readTextIfExists(set.paths.platformVersion)?.trim() ?? null,
    deriver: derived.deriver,
    counts: catalog.counts,
    startProfiles,
    files: fileDigests,
  };
  put('manifest.json', stable(manifest));
  for (const [rel, buf] of files) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
  }
  return { dir, catalogVersion, contentDigest, files: files.size, deriver: derived.deriver, issues };
}

/** Exposed for tests: the catalog card of one card without a build. */
export { catalogCard };
