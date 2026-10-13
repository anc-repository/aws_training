/**
 * Catalog-level rules of `labs:lint`: 04 §3.5 group B (21–25, the per-card part of 21/22 is in card.ts), the catalog
 * rules C-1…C-15 of 05 §8.7, and the track file rules of tracks-and-catalog §7.3.
 */
import type { LabV2 } from '@atl/shared';
import { checkUses, resolveRef } from '../checks.js';
import { isRegisteredConsoleLink } from '../console-links.js';
import { trackMembership, type CardContent, type ContentSet, type LintIssue, type Severity, type TrackDoc } from '../content.js';
import { loadRegistry } from '../registry.js';
import { validateWith } from '../schemas/index.js';

/** 05 §5.1: original Lab 0–25 → card (the only source of `legacyLab`). Combination cards of stage 9 and the new
 *  closing card have no number. */
export const LEGACY_LABS: Readonly<Record<string, number>> = {
  'svc-ec2': 0, 'svc-iam': 1, 'svc-cost': 1, 'svc-shell-access': 2, 'svc-logging': 3, 'svc-monitoring': 3, 'svc-storage': 4, 'svc-cdn': 5,
  'svc-dns': 6, 'svc-tls': 6, 'svc-waf': 7, 'sc-edge-protection': 7, 'sc-static-acceleration': 7, 'svc-auth': 8, 'svc-identity-pool': 8,
  'sc-user-identity': 8, 'svc-email': 9, 'svc-notification': 9, 'sc-event-fanout': 9, 'svc-queue': 10, 'sc-decoupling': 10,
  'svc-image-processing': 11, 'svc-tagging': 11, 'sc-image-pipeline': 11, 'svc-workflow': 11, 'svc-scheduler': 12, 'svc-kms': 13,
  'svc-secrets': 13, 'svc-config': 13, 'svc-network': 14, 'svc-database': 15, 'svc-db-proxy': 15, 'svc-cache': 16, 'sc-db-performance': 16,
  'svc-social-store': 17, 'svc-social-api': 17, 'sc-serverless-api': 17, 'svc-analytics': 18, 'sc-analytics': 18, 'svc-load-balancer': 19,
  'sc-private-network': 20, 'svc-autoscaling': 21, 'sc-ha-web': 21, 'svc-ami': 21, 'svc-shared-fs': 21, 'svc-tracing': 22, 'svc-audit': 23,
  'svc-threat-detection': 23, 'svc-backup': 24, 'svc-compliance': 25, 'svc-vuln-scan': 25,
};

export interface CatalogLintOptions {
  /** generated catalog.yaml text to compare with the committed file (C-2); undefined = skip */
  generatedCatalog?: string;
  committedCatalog?: string | null;
}

export function lintCatalog(set: ContentSet, opts: CatalogLintOptions = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (card: string, rule: string, message: string, severity: Severity = 'error') => issues.push({ card, rule, severity, message });
  const registry = loadRegistry(set.paths).modules;

  // ---- C-1: taxonomy
  const tax = set.taxonomy;
  if (!set.taxonomyRaw) add('_catalog', 'C-1', 'labs/_catalog/taxonomy.yaml is missing');
  else {
    for (const i of validateWith('taxonomy', set.taxonomyRaw)) add('_catalog', 'C-1', `taxonomy.yaml: schema: ${i.path}: ${i.message}`);
  }
  const cells = new Map<string, NonNullable<typeof tax>['services'][number]>();
  if (tax?.services) {
    const abbrs = new Map<string, string>();
    for (const s of tax.services) {
      if (cells.has(s.id)) add('_catalog', 'C-1', `taxonomy: service id ${s.id} is duplicated`);
      cells.set(s.id, s);
      if (abbrs.has(s.abbr)) add('_catalog', 'C-1', `taxonomy: abbreviation ${s.abbr} is used by ${abbrs.get(s.abbr)} and ${s.id}`);
      abbrs.set(s.abbr, s.id);
      if (s.module && !registry[s.module]) add('_catalog', 'C-1', `taxonomy: service ${s.id} names unknown module ${s.module}`);
      if (s.consoleHome && !isRegisteredConsoleLink(s.consoleHome)) add('_catalog', 'C-14', `taxonomy: consoleHome ${s.consoleHome} of ${s.id} is not a registered deep link`);
      if (s.featureOf && !tax.services.some((x) => x.id === s.featureOf)) add('_catalog', 'C-1', `taxonomy: ${s.id}.featureOf ${s.featureOf} does not exist`);
    }
    for (const m of Object.keys(registry)) {
      const n = tax.services.filter((s) => s.module === m).length;
      if (n !== 1) add('_catalog', 'C-1', `taxonomy: module ${m} must map to exactly one service cell (found ${n})`);
    }
    for (const m of Object.keys(registry)) if (tax.provisionSpeed && !tax.provisionSpeed[m]) add('_catalog', 'C-1', `taxonomy: provisionSpeed has no entry for module ${m}`, 'warn');
  }
  if (!set.pricingRaw) add('_pricing', 'A14', 'labs/_pricing/dimensions.yaml is missing');
  else for (const i of validateWith('pricing', set.pricingRaw)) add('_pricing', 'A14', `dimensions.yaml: schema: ${i.path}: ${i.message}`);
  if (set.pricing) {
    for (const [m, list] of Object.entries(set.pricing.modules ?? {})) {
      if (!registry[m]) add('_pricing', 'A14', `dimensions.yaml modules: ${m} is not a registry module`);
      for (const it of list) if (!set.pricing.dimensions[it.pricingKey]) add('_pricing', 'A14', `dimensions.yaml modules.${m}: pricingKey ${it.pricingKey} has no dimension`);
    }
    for (const it of [...(set.pricing.base ?? []), ...(set.pricing.workstation ?? [])]) {
      if (!set.pricing.dimensions[it.pricingKey]) add('_pricing', 'A14', `dimensions.yaml base/workstation: pricingKey ${it.pricingKey} has no dimension`);
    }
  }
  for (const f of set.sharedCheckFiles) for (const i of validateWith('check', f.doc)) add('_shared', 'A7', `${f.file}: schema: ${i.path}: ${i.message}`);

  // ---- per card catalog rules
  const membership = trackMembership(set.tracks);
  const serviceCards = new Map<string, string>();
  for (const card of set.cards) {
    const lab = card.lab;
    if (!lab || typeof lab !== 'object' || !lab.id) continue;
    if (validateWith(card.planned ? 'lab-planned' : 'lab', card.raw).length) continue; // reported by A1
    // C-4: id rules; svc cards cover the registry exactly once
    if (lab.kind === 'service') {
      const mod = lab.id.slice(4);
      if (serviceCards.has(mod)) add(card.id, 'C-4', `module ${mod} already has the service card ${serviceCards.get(mod)}`);
      serviceCards.set(mod, card.id);
    } else if (lab.id.slice(3).length > 24) add(card.id, 'C-4', 'sc-<slug>: slug longer than 24 characters');
    // C-3: services in the taxonomy
    for (const s of lab.services ?? []) {
      if (tax && !cells.has(s.id)) add(card.id, 'C-3', `services: ${s.id} is not in taxonomy.yaml`);
      if (s.featureOf && tax && !cells.has(s.featureOf)) add(card.id, 'C-3', `services: featureOf ${s.featureOf} is not in taxonomy.yaml`);
      if (s.module && !registry[s.module]) add(card.id, 'C-3', `services: module ${s.module} does not exist`);
    }
    if (tax) {
      const prefixes = new Set((lab.services ?? []).map((s) => cells.get(s.id)?.iamPrefix).filter(Boolean));
      const skip = new Set(['cloudformation', 'ssm', 'iam', 'sts', 'ec2', 'tag', 'logs', 'events']);
      for (const a of lab.permissions?.learner ?? []) {
        const p = a.split(':')[0]!;
        if (!prefixes.has(p) && !skip.has(p)) add(card.id, 'C-3', `permissions ${a}: no service with iamPrefix ${p} in services`, 'warn');
      }
    }
    // C-5: service = primary cell's full name
    if (lab.kind === 'service' && tax) {
      const primary = (lab.services ?? []).find((s) => s.role === 'primary');
      const cell = primary ? cells.get(primary.id) : undefined;
      if (cell && cell.name !== lab.service) add(card.id, 'C-5', `service "${lab.service}" must equal the primary service cell's name "${cell.name}"`);
      if (cell && cell.module !== lab.id.slice(4)) add(card.id, 'C-5', `primary service ${primary!.id} belongs to module ${cell.module ?? 'none'}, not ${lab.id.slice(4)}`);
    }
    // C-6: difficulty
    const required = (lab.targetModules ?? []).filter((t) => !t.optional);
    if (lab.kind === 'scenario' && (lab.difficulty === 'intro' || lab.difficulty === 'beginner')) add(card.id, 'C-6', 'scenario cards are at least intermediate');
    const low = lab.difficulty === 'intro' || lab.difficulty === 'beginner';
    if (low && (required.length >= 3 || lab.cost?.tier === 'high' || ['C', 'D'].includes(lab.provision?.class))) add(card.id, 'C-6', 'difficulty below intermediate for a card with ≥ 3 targets, high cost tier or class C/D', 'warn');
    // C-8: durations (schema has multipleOf; recheck the ratio)
    if (lab.estimatedMinutes % 15 || lab.timeLimitMinutes % 30) add(card.id, 'C-8', 'estimatedMinutes must be a multiple of 15 and timeLimitMinutes of 30');
    // C-13: summary 40–200 characters, title ≤ 48
    const len = [...(lab.summary ?? '')].length;
    if (len < 40 || len > 200) add(card.id, 'C-13', `summary is ${len} characters (40–200)`);
    if ([...(lab.title ?? '')].length > 48) add(card.id, 'C-13', 'title longer than 48 characters');
    // C-14: console links
    for (const l of lab.platform?.consoleLinks ?? []) if (!isRegisteredConsoleLink(l)) add(card.id, 'C-14', `platform.consoleLinks ${l} is not in the 03 §5.4 registry`);
    // C-15
    if ((lab.prerequisites?.learnerInputs ?? []).some((i) => i.id === 'cost-tags-active' && i.required !== false) && !(lab.platformOps ?? []).some((o) => o.id === 'cost-activate-tags')) {
      add(card.id, 'C-15', 'cost-tags-active is required: the intro page needs an entry to the cost-activate-tags platform action', 'warn');
    }
    // B23: tracks of the card = actual membership
    const actual = [...new Set((membership.get(card.id) ?? []).map((m) => m.trackId))].sort();
    const declared = [...(lab.tracks ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(declared)) add(card.id, 'B23', `tracks [${declared}] must equal the paths that contain the card [${actual}]`);
    // B24: creditBy steps have an automatic, non-start-state check for the service
    if (!card.planned) lintCreditBy(set, card, add);
  }
  if (tax) {
    const missing = Object.keys(registry).filter((m) => !serviceCards.has(m));
    if (missing.length) add('_catalog', 'C-4', `no service card for module(s): ${missing.join(', ')}`);
  }

  // ---- tracks (tracks-and-catalog §7.3) and C-10 / C-11
  for (const f of set.trackFiles) for (const i of validateWith('track', f.doc)) add('_tracks', 'B23', `${f.file}: schema: ${i.path}: ${i.message}`);
  const ids = new Set<string>();
  for (const t of set.tracks) {
    if (!t?.id) continue;
    if (ids.has(t.id)) add('_tracks', 'B23', `track id ${t.id} is duplicated`);
    ids.add(t.id);
    lintTrack(set, t, add);
  }
  for (const card of set.cards) for (const tr of card.lab?.tracks ?? []) if (!ids.has(tr)) add(card.id, 'B23', `tracks: ${tr} is not a track in labs/_tracks`);
  const saa = set.tracks.find((t) => t.id === 'saa-main');
  if (!saa) add('_tracks', 'C-11', 'labs/_tracks/saa-main.yaml is missing');
  else {
    const seen = new Set<number>();
    for (const s of saa.stages ?? []) {
      for (const it of s.items ?? []) {
        if ('card' in it) {
          const want = LEGACY_LABS[it.card];
          if (want !== it.legacyLab) add('_tracks', 'C-11', `saa-main ${it.card}: legacyLab ${it.legacyLab ?? 'none'}, 05 §5.1 says ${want ?? 'none'}`);
          if (it.legacyLab !== undefined) seen.add(it.legacyLab);
        } else {
          for (const c of it.cards) if (LEGACY_LABS[c] !== undefined) seen.add(LEGACY_LABS[c]!);
        }
      }
    }
    for (let n = 0; n <= 25; n++) if (!seen.has(n)) add('_tracks', 'C-11', `saa-main: original Lab ${n} is not covered by any legacyLab`);
  }

  // ---- C-2: catalog.yaml is generated
  if (opts.generatedCatalog !== undefined) {
    if (opts.committedCatalog === null || opts.committedCatalog === undefined) add('_catalog', 'C-2', 'labs/_catalog/catalog.yaml is missing (npm run labs:catalog)');
    else if (opts.committedCatalog.replace(/\r\n/g, '\n') !== opts.generatedCatalog) add('_catalog', 'C-2', 'labs/_catalog/catalog.yaml differs from the regenerated catalog (npm run labs:catalog; do not edit by hand)');
  }
  return issues;
}

function requiresDomain(lab: LabV2 | undefined): boolean {
  return !!lab?.prerequisites?.learnerInputs?.some((i) => i.id === 'domain' && i.required !== false);
}

function lintTrack(set: ContentSet, t: TrackDoc, add: (card: string, rule: string, message: string, severity?: Severity) => void): void {
  const where = `_tracks/${t.id}`;
  const seen = new Set<string>();
  const requiredCards = new Set<string>();
  const groupCards = new Set<string>();
  const groups = new Set<string>();
  for (const s of t.stages ?? []) {
    for (const it of s.items ?? []) {
      const cards = 'card' in it ? [it.card] : it.cards;
      for (const c of cards) {
        if (!set.byId.has(c)) add(where, 'B23', `card ${c} does not exist`);
        if (seen.has(c)) add(where, 'B23', `card ${c} appears more than once`);
        seen.add(c);
      }
      if ('card' in it) {
        if (it.role === 'required') requiredCards.add(it.card);
      } else {
        if (groups.has(it.group)) add(where, 'B23', `group ${it.group} is duplicated`);
        groups.add(it.group);
        if (it.pick < 1 || it.pick > it.cards.length) add(where, 'B23', `group ${it.group}: pick ${it.pick} must be 1…${it.cards.length}`);
        for (const c of it.cards) groupCards.add(c);
      }
    }
  }
  for (const c of groupCards) if (requiredCards.has(c)) add(where, 'B23', `card ${c} is both required and in an elective group`);
  const ratio = t.completion?.minAutoRatio;
  if (ratio !== undefined && (ratio < 0 || ratio > 1)) add(where, 'B23', 'completion.minAutoRatio must be within [0, 1]');
  // C-10 / tracks §7.3 rule 4: no domain may be needed to earn the certificate. Required cards never need one; an
  // elective group may contain a domain card as long as `pick` of its cards do not need one (resilient's g-dr, §4.3).
  for (const c of requiredCards) {
    if (requiresDomain(set.byId.get(c)?.lab)) add(where, 'C-10', `${c} needs a domain (required learner input) and cannot be required in a track`);
  }
  for (const s of t.stages ?? []) {
    for (const it of s.items ?? []) {
      if ('card' in it) continue;
      const free = it.cards.filter((c) => !requiresDomain(set.byId.get(c)?.lab)).length;
      if (free < it.pick) add(where, 'C-10', `group ${it.group}: only ${free} card(s) can be done without a domain, pick is ${it.pick}`);
    }
  }
}

function lintCreditBy(set: ContentSet, card: CardContent, add: (card: string, rule: string, message: string, severity?: Severity) => void): void {
  const lab = card.lab;
  const tax = set.taxonomy;
  for (const s of lab.services ?? []) {
    for (const stepId of s.creditBy ?? []) {
      const step = lab.steps.find((x) => x.id === stepId);
      if (!step) {
        add(card.id, 'B24', `services ${s.id}.creditBy: step ${stepId} does not exist`);
        continue;
      }
      const module = s.module ?? tax?.services.find((c) => c.id === s.id)?.module;
      const ok = checkUses(lab)
        .filter((u) => u.stepId === stepId)
        .some((u) => {
          const r = resolveRef(set, card, u.ref);
          if (!r.ok) return false;
          const d = r.check.decl;
          if (d.type === 'manual' || d.type === 'experiment') return false;
          if ((d.drift as { policy?: string } | undefined)?.policy === 'once' && u.overrides?.drift?.policy !== 'must-hold') return false;
          return !module || d.module === module || d.service === s.id || JSON.stringify(d).includes(module);
        });
      if (!ok) add(card.id, 'B24', `services ${s.id}.creditBy ${stepId}: the step needs an automatic check of the service that does not only describe the start state`);
    }
  }
}
