/**
 * Catalog model (05 §8.3 `catalog.yaml`, §8.4 `CatalogIndex` / `CatalogCard` / `CardIntro`): one function computes the
 * cards, track summaries and service map from lab.yaml + _tracks + taxonomy; `labs:catalog` writes it as
 * `labs/_catalog/catalog.yaml` (committed, CI compares) and `labs:build` writes it into `catalog/index.json` with the
 * derivation results (plan digests) added.
 *
 * The committed catalog.yaml only contains values that are fully determined by the content (declared start provisions,
 * declared and DRV-11-verified class / tier): plan digests depend on the toolkit and are only in the build products.
 */
import fs from 'node:fs';
import type { LabV2, ProvisionItem } from '@atl/shared';
import { startProfileName } from '@atl/shared';
import { trackMembership, type CardContent, type ContentSet, type TrackDoc } from './content.js';
import { costSources, costTier, expandCost, provisionClass, type CostTier } from './derive/classify.js';
import type { CardDerivation } from './derive/index.js';
import type { PlanEntry } from './derive/plan.js';
import { variantView } from './derive/reference.js';
import { loadRegistry, registryVersion, startDriverOf, toolkitVersion } from './registry.js';
import { LEGACY_LABS } from './lint/catalog.js';
import { generatedText, SOURCE_LANG } from './l10n.js';

export interface CatalogCard {
  id: string;
  kind: 'service' | 'scenario';
  version: string;
  status: string;
  startable: boolean;
  title: string;
  subtitle?: string;
  service?: string;
  function?: string;
  summary: string;
  category?: string;
  services: { id: string; role: 'primary' | 'supporting'; optional?: boolean }[];
  servicesCount: number;
  domains: string[];
  difficulty: string;
  estimatedMinutes: number;
  timeLimitMinutes: number;
  durationBucket: string;
  costTier: { required: CostTier; withOptional: CostTier; hourlyUnits: number; accountScoped: string[] };
  costSources: { hourly: string[]; usage: string[]; monthly: string[] };
  mainDrivers: string[];
  provisionClass: string;
  startProfiles: {
    name: string;
    variant: string;
    select: 'default' | 'learner' | 'preflight';
    title?: string;
    modules: string[];
    localSettings: Record<string, string>;
    runtime: Record<string, string>;
    seeds: string[];
    platform: { previewDirectHttps: string };
    provisionClass: string;
    costTier: CostTier;
    planDigest?: string;
  }[];
  variants: { id: string; title: string; select: 'default' | 'learner' | 'preflight'; provisionClass: string; costTier: CostTier }[];
  targets: { module: string; from: string | null; to: string; optional: boolean }[];
  expectedWarnings: string[];
  learnerInputs: { id: string; required: boolean }[];
  accountImpact: { id: string; resource: string; revert: string }[];
  platformOps: { id: string; title: string; optional: boolean }[];
  saa: { domains: string[]; primaryDomain: string; topicTitles: string[] };
  scenarioQuestion?: string;
  tags: string[];
  tracks: { trackId: string; stageId: string; role: 'required' | 'elective' | 'optional'; groupId?: string }[];
  legacyLabs: number[];
  flags: string[];
  credits: string[];
  badge: { title: string; short?: string };
  prerequisites: { id: string; kind: 'soft' | 'hard' }[];
  workstation: { required: boolean; savingsMode: string };
  reuseFrom: { labId: string; extraModules: string[]; warn?: 'hourly' | 'baseline' }[];
  searchText: string;
}

export interface TrackSummary {
  id: string;
  title: string;
  summary: string;
  domain?: string;
  requiredCards: number;
  totalCards: number;
  requiredMinutes: number;
  totalMinutes: number;
  certificate: { enabled: boolean; title: string };
  completion: TrackDoc['completion'];
}

export interface ServiceCell {
  id: string;
  module: string;
  category: string;
  abbr: string;
  serviceCard: string;
  creditedBy: string[];
  appearsIn: string[];
}

export interface CatalogModel {
  schema: 'atl.catalog/v1';
  source: { registryVersion: string; toolkitVersion: string; taxonomyVersion: string };
  counts: { cards: number; service: number; scenario: number; tracks: number; startable: number; planned: number };
  cards: CatalogCard[];
  tracks: TrackSummary[];
  serviceMap: ServiceCell[];
}

const TIER_RANK: Record<CostTier, number> = { low: 0, medium: 1, high: 2 };
const maxTier = (a: CostTier, b: CostTier): CostTier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

/** Plan-like entries from the declared provisions (DRV-1 guarantees they equal the plan). */
export function declaredStart(provisions: readonly ProvisionItem[]): PlanEntry[] {
  const s = (v: unknown) => String(v);
  return [
    { id: 'ec2', kind: 'module', basis: 'base' },
    ...provisions
      .filter((p) => p.kind === 'module' || p.kind === 'local' || p.kind === 'runtime')
      .map(
        (p): PlanEntry => ({
          id: p.item,
          kind: p.kind as PlanEntry['kind'],
          basis: (p.basis ?? 'single') as PlanEntry['basis'],
          ...(p.set ? { set: Object.fromEntries(Object.entries(p.set).map(([k, v]) => [k, s(v)])) } : {}),
          ...(p.params ? { params: Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, s(v)])) } : {}),
          ...(p.value !== undefined ? { value: s(p.value) } : {}),
        }),
      ),
  ];
}

function durationBucket(set: ContentSet, minutes: number): string {
  const buckets = [...(set.taxonomy?.durationBuckets ?? [])].sort((a, b) => (a.maxMinutes ?? Infinity) - (b.maxMinutes ?? Infinity));
  for (const b of buckets) if (b.maxMinutes === undefined || minutes <= b.maxMinutes) return b.id;
  return minutes <= 60 ? 'short' : minutes <= 120 ? 'medium' : 'long';
}

function cellOfModule(set: ContentSet, module: string) {
  return set.taxonomy?.services.find((s) => s.module === module);
}

function startValues(entries: readonly PlanEntry[]): Map<string, Record<string, string>> {
  const m = new Map<string, Record<string, string>>();
  for (const e of entries) if (e.kind === 'module' && e.basis !== 'base') m.set(e.id, e.set ?? {});
  return m;
}

/** 05 §8.6 reuseFrom (hint only; 02 computes the real diff plan when quoting). */
function reuseFrom(set: ContentSet, b: CardContent, ordered: readonly CardContent[]): CatalogCard['reuseFrom'] {
  const reg = loadRegistry(set.paths).modules;
  const bStart = startValues(declaredStart(b.lab.startProfile?.provisions ?? []));
  const bTargets = (b.lab.targetModules ?? []).filter((t) => !t.optional);
  const hourly = (id: string) => (set.pricing?.modules?.[id] ?? []).some((i) => i.billing === 'hourly');
  const out: (CatalogCard['reuseFrom'][number] & { order: number })[] = [];
  ordered.forEach((a, order) => {
    if (a.id === b.id || !a.lab?.startProfile) return;
    const end = startValues(declaredStart(a.lab.startProfile.provisions));
    for (const t of (a.lab.targetModules ?? []).filter((x) => !x.optional)) {
      const sw = reg[t.id]?.switch;
      end.set(t.id, { ...(end.get(t.id) ?? {}), ...(sw && sw.kind !== 'param' ? { [sw.var]: t.driver } : {}), ...Object.fromEntries(Object.entries(t.set ?? {}).map(([k, v]) => [k, String(v)])) });
    }
    // 1. B's start modules ⊆ A's end, with the same values
    for (const [id, vals] of bStart) {
      const e = end.get(id);
      if (!e) return;
      for (const [k, v] of Object.entries(vals)) if (e[k] !== undefined && e[k] !== v) return;
    }
    // 2. B's targets are not already satisfied in A's end
    for (const t of bTargets) {
      const e = end.get(t.id);
      const sw = reg[t.id]?.switch;
      if (e && (!sw || sw.kind === 'param' || e[sw.var] === t.driver)) return;
    }
    const extra = [...end.keys()].filter((id) => !bStart.has(id) && !bTargets.some((t) => t.id === id));
    const warn = extra.some(hourly) ? ('hourly' as const) : undefined;
    out.push({ labId: a.id, extraModules: extra, ...(warn ? { warn } : {}), order });
  });
  // nearest in path order first; entries with warnings after the clean ones; keep 3
  const bIndex = ordered.findIndex((c) => c.id === b.id);
  return out
    .sort((x, y) => (x.warn ? 1 : 0) - (y.warn ? 1 : 0) || Math.abs(bIndex - x.order) - Math.abs(bIndex - y.order))
    .slice(0, 3)
    .map(({ order: _o, ...r }) => r);
}

function flagsOf(lab: LabV2): string[] {
  const flags: string[] = [];
  const inputs = lab.prerequisites?.learnerInputs ?? [];
  const req = (id: string) => inputs.some((i) => i.id === id && i.required !== false);
  const opt = (id: string) => inputs.some((i) => i.id === id && i.required === false);
  if (req('cost-tags-active')) flags.push('needs-advance');
  if ((lab.regions?.extra ?? []).includes('dr-region')) flags.push('limited');
  if (req('domain')) flags.push('needs-domain');
  else if (opt('domain')) flags.push('domain-optional');
  if (['ses-identity', 'notify-email', 'recipient-emails', 'alert-email'].some(req)) flags.push('needs-email');
  if ((lab.platform?.accountImpact ?? []).length) flags.push('account-impact');
  const waits = (lab.steps ?? []).filter((s) => !s.optional && !s.when).reduce((n, s) => n + (s.wait?.typicalMinutes ?? 0), 0);
  if (waits >= lab.estimatedMinutes * 0.3) flags.push('long-wait');
  if (lab.status === 'beta') flags.push('beta');
  if ((lab.status as string | undefined) === 'planned') flags.push('planned');
  return flags;
}

export function catalogCard(set: ContentSet, card: CardContent, ordered: readonly CardContent[], derivation?: CardDerivation): CatalogCard {
  const lab = card.lab;
  const membership = trackMembership(set.tracks).get(card.id) ?? [];
  const sp = lab.startProfile;
  const variantIds = ['default', ...((sp?.variants ?? []).map((v) => v.id))];
  const startProfiles: CatalogCard['startProfiles'] = [];
  let tierReq: CostTier = 'low';
  let tierOpt: CostTier = 'low';
  let units = 0;
  let accountScoped: string[] = [];
  let sources: CatalogCard['costSources'] = { hourly: [], usage: [], monthly: [] };
  for (const v of variantIds) {
    const view = sp ? variantView(lab, v) : null;
    const provisions = view?.provisions ?? [];
    const start = declaredStart(provisions);
    const def = v === 'default';
    let pc: string = lab.provision?.class ?? 'A';
    let tier: { required: CostTier; withOptional: CostTier; hourlyUnits: number; accountScoped: string[] } = {
      required: lab.cost?.tier ?? 'low',
      withOptional: lab.cost?.tierWithOptional ?? lab.cost?.tier ?? 'low',
      hourlyUnits: 0,
      accountScoped: [],
    };
    if (set.taxonomy && !card.planned) {
      pc = provisionClass(start, (lab.extraStacks ?? []).filter((x) => x.deploy === 'start').map(() => 'extra-stack'), set.taxonomy);
      const { items } = expandCost(lab, start, set.pricing);
      const t = costTier(items, set.taxonomy);
      tier = { required: t.required, withOptional: t.withOptional, hourlyUnits: t.hourlyUnits, accountScoped: t.accountScoped };
      if (def) sources = costSources(items);
    }
    tierReq = def ? tier.required : maxTier(tierReq, tier.required);
    tierOpt = def ? tier.withOptional : maxTier(tierOpt, tier.withOptional);
    if (def) {
      units = tier.hourlyUnits;
      accountScoped = tier.accountScoped;
    }
    const vd = view?.variantDef;
    const localSettings: Record<string, string> = {};
    const runtime: Record<string, string> = {};
    for (const e of start) {
      if (e.kind === 'local') Object.assign(localSettings, e.set ?? {});
      if (e.kind === 'runtime') runtime[e.id] = e.value ?? '';
    }
    const plan = derivation?.variants.find((x) => x.variant === v)?.plan;
    startProfiles.push({
      name: startProfileName(card.id, v),
      variant: v,
      select: def ? 'default' : (vd?.select ?? 'learner'),
      ...(vd?.title ? { title: vd.title } : {}),
      modules: start.filter((e) => e.kind === 'module' && e.basis !== 'base').map((e) => e.id),
      localSettings,
      runtime,
      seeds: provisions.filter((p) => p.kind === 'seed').map((p) => p.item),
      platform: { previewDirectHttps: (vd?.platform ?? sp?.platform)?.preview?.directHttps ?? 'on' },
      provisionClass: pc,
      costTier: tier.required,
      ...(plan ? { planDigest: plan.digest } : {}),
    });
  }
  // card-level values are the declared ones: DRV-11 / C-7 verify them against the computation (tierReq / tierOpt);
  // catalog placeholders only have declarations
  const costTierCard = {
    required: card.planned ? lab.cost.tier : maxTier(lab.cost.tier, tierReq),
    withOptional: card.planned ? (lab.cost.tierWithOptional ?? lab.cost.tier) : maxTier(lab.cost.tierWithOptional ?? lab.cost.tier, tierOpt),
    hourlyUnits: units,
    accountScoped,
  };
  const targets = (lab.targetModules ?? []).map((t) => ({ module: t.id, from: startDriverOf(set.paths, t), to: t.driver, optional: t.optional === true }));
  const primary = (lab.services ?? []).find((s) => s.role === 'primary');
  const category = lab.kind === 'service' ? set.taxonomy?.services.find((s) => s.id === primary?.id)?.category : undefined;
  const credits = [
    ...new Set([
      ...(lab.targetModules ?? []).filter((t) => !t.optional).map((t) => cellOfModule(set, t.id)?.id).filter((x): x is string => !!x),
      ...(lab.services ?? []).filter((s) => (s.creditBy ?? []).length).map((s) => s.id),
    ]),
  ];
  if (lab.id === 'svc-ec2') credits.push('ec2');
  const legacy = LEGACY_LABS[card.id];
  const services = (lab.services ?? [])
    .filter((s) => s.role === 'primary' || s.role === 'supporting')
    .map((s) => ({ id: s.id, role: s.role as 'primary' | 'supporting', ...(s.optional ? { optional: true } : {}) }));
  const saa = {
    domains: lab.saa?.domains ?? [],
    primaryDomain: lab.saa?.domains?.[0] ?? 'performance',
    topicTitles: (lab.saa?.topics ?? []).map((t) => ('title' in t ? t.title : '')).filter(Boolean),
  };
  const searchText = [
    card.id,
    lab.title,
    lab.subtitle,
    lab.service,
    lab.function,
    lab.summary,
    ...(lab.tags ?? []),
    ...(lab.services ?? []).map((s) => set.taxonomy?.services.find((c) => c.id === s.id)?.name ?? s.id),
    legacy !== undefined ? `lab ${legacy} lab-${String(legacy).padStart(2, '0')}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return {
    id: card.id,
    kind: lab.kind,
    version: lab.version,
    status: lab.status ?? 'stable',
    startable: !card.planned && lab.status !== 'deprecated' && lab.status !== 'draft',
    title: lab.title,
    ...(lab.subtitle ? { subtitle: lab.subtitle } : {}),
    ...(lab.service ? { service: lab.service } : {}),
    ...(lab.function ? { function: lab.function } : {}),
    summary: lab.summary,
    ...(category ? { category } : {}),
    services,
    servicesCount: services.length,
    domains: lab.saa?.domains ?? [],
    difficulty: lab.difficulty,
    estimatedMinutes: lab.estimatedMinutes,
    timeLimitMinutes: lab.timeLimitMinutes,
    durationBucket: durationBucket(set, lab.estimatedMinutes),
    costTier: costTierCard,
    costSources: sources,
    mainDrivers: lab.cost?.mainDrivers ?? [],
    provisionClass: lab.provision?.class ?? 'A',
    startProfiles,
    variants: startProfiles.map((p) => ({ id: p.variant, title: p.title ?? (p.variant === 'default' ? generatedText('defaultVariant', set.lang ?? SOURCE_LANG) : p.variant), select: p.select, provisionClass: p.provisionClass, costTier: p.costTier })),
    targets,
    expectedWarnings: lab.expectedWarnings ?? [],
    learnerInputs: (lab.prerequisites?.learnerInputs ?? []).map((i) => ({ id: i.id, required: i.required !== false })),
    accountImpact: (lab.platform?.accountImpact ?? []).map((a) => ({ id: a.id, resource: a.resource, revert: a.revert })),
    platformOps: (lab.platformOps ?? []).map((o) => ({ id: o.id, title: o.title, optional: o.optional === true })),
    saa,
    ...(lab.scenario?.question ? { scenarioQuestion: lab.scenario.question } : {}),
    tags: lab.tags ?? [],
    tracks: membership,
    legacyLabs: legacy !== undefined ? [legacy] : [],
    flags: flagsOf(lab),
    credits,
    badge: { title: lab.badge?.title ?? '', ...(lab.badge?.short ? { short: lab.badge.short } : {}) },
    prerequisites: (lab.prerequisites?.cards ?? []).map((c) => ({ id: c.id, kind: c.kind })),
    workstation: { required: lab.workstation?.required !== false, savingsMode: lab.workstation?.savingsMode ?? 'ok' },
    reuseFrom: card.planned ? [] : reuseFrom(set, card, ordered.filter((c) => !c.planned)),
    searchText,
  };
}

export function trackSummaries(set: ContentSet): TrackSummary[] {
  const minutes = (id: string) => set.byId.get(id)?.lab?.estimatedMinutes ?? 0;
  return set.tracks.map((t) => {
    let requiredCards = 0;
    let requiredMinutes = 0;
    const all = new Set<string>();
    for (const s of t.stages ?? []) {
      for (const it of s.items ?? []) {
        if ('card' in it) {
          all.add(it.card);
          if (it.role === 'required') {
            requiredCards += 1;
            requiredMinutes += minutes(it.card);
          }
        } else {
          for (const c of it.cards) all.add(c);
          requiredCards += it.pick;
          requiredMinutes += it.cards.map(minutes).sort((a, b) => a - b).slice(0, it.pick).reduce((a, b) => a + b, 0);
        }
      }
    }
    return {
      id: t.id,
      title: t.title,
      summary: t.summary,
      ...(t.domain ? { domain: t.domain } : {}),
      requiredCards,
      totalCards: all.size,
      requiredMinutes,
      totalMinutes: [...all].map(minutes).reduce((a, b) => a + b, 0),
      certificate: t.certificate,
      completion: t.completion,
    };
  });
}

/** Cards in saa-main order (then the rest by id): used for `reuseFrom` proximity and catalog ordering. */
export function orderedCards(set: ContentSet): CardContent[] {
  const order: string[] = [];
  const saa = set.tracks.find((t) => t.id === 'saa-main');
  for (const s of saa?.stages ?? []) for (const it of s.items ?? []) for (const c of 'card' in it ? [it.card] : it.cards) if (!order.includes(c)) order.push(c);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return [...set.cards].filter((c) => c.lab?.id).sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : 1));
}

export function buildCatalog(set: ContentSet, derivations?: Map<string, CardDerivation>): CatalogModel {
  const ordered = orderedCards(set);
  const cards = ordered.map((c) => catalogCard(set, c, ordered, derivations?.get(c.id)));
  const serviceMap: ServiceCell[] = (set.taxonomy?.services ?? [])
    .filter((s) => s.module)
    .map((s) => {
      const creditedBy = cards.filter((c) => c.kind === 'scenario' && c.credits.includes(s.id)).map((c) => c.id);
      const appearsIn = cards.filter((c) => c.kind === 'scenario' && !c.credits.includes(s.id) && c.services.some((x) => x.id === s.id)).map((c) => c.id);
      return { id: s.id, module: s.module!, category: s.category ?? '', abbr: s.abbr, serviceCard: `svc-${s.module}`, creditedBy, appearsIn };
    });
  return {
    schema: 'atl.catalog/v1',
    source: { registryVersion: registryVersion(set.paths), toolkitVersion: toolkitVersion(set.paths), taxonomyVersion: set.taxonomy?.version ?? '0.0.0' },
    counts: {
      cards: cards.length,
      service: cards.filter((c) => c.kind === 'service').length,
      scenario: cards.filter((c) => c.kind === 'scenario').length,
      tracks: set.tracks.length,
      startable: cards.filter((c) => c.startable).length,
      planned: cards.filter((c) => c.status === 'planned').length,
    },
    cards,
    tracks: trackSummaries(set),
    serviceMap,
  };
}

export const CATALOG_HEADER = '# labs/_catalog/catalog.yaml — generated by npm run labs:catalog (scripts/labs), do not edit by hand (05 §8.3)';

export function readCommittedCatalog(set: ContentSet): string | null {
  try {
    return fs.readFileSync(set.paths.catalog, 'utf8');
  } catch {
    return null;
  }
}
