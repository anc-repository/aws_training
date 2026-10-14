/**
 * `labs:derive` (04 §3.5 group C, DRV-1…DRV-11): derive the start state of every startable card and every start variant
 * with `scripts/module plan --start-of` (06 PM-33), and check `startProfile`, targets, wire order, expected warnings,
 * the generated profile digest, the provision class and the cost tier against it.
 *
 * Deriver: `auto` (default) uses the scripts/module command and falls back to the reference derivation (scripts/module-cli
 * planner, `reference.ts`) when the toolkit does not support `--start-of` yet — reported as a DRV-0 warning;
 * `cli` requires the command; `reference` never calls it.
 */
import path from 'node:path';
import type { LabV2, ProvisionItem } from '@atl/shared';
import type { CardContent, ContentSet, LintIssue } from '../content.js';
import { fullCards } from '../content.js';
import { localDriver, ownerOfKey, registryVersion } from '../registry.js';
import { costTier, expandCost, provisionClass, type CostTierResult, type ProvisionClass } from './classify.js';
import { cliPlan, cliProfileDigest } from './cli.js';
import { planDigest, profileDigest, renderProfile, str, strMap, type PlanEntry, type PlanOutput } from './plan.js';
import { referencePlan, targetsInManualOrder, variantView } from './reference.js';

export type DeriverMode = 'auto' | 'cli' | 'reference';

export interface VariantDerivation {
  variant: string;
  plan: PlanOutput | null;
  profile: string | null;
  provisionClass: ProvisionClass | null;
  cost: CostTierResult | null;
}

export interface CardDerivation {
  card: string;
  variants: VariantDerivation[];
}

export interface DeriveResult {
  deriver: 'scripts/module' | 'reference' | 'mixed';
  cards: CardDerivation[];
  issues: LintIssue[];
}

/** Preflight keys registered by 02's account preflight (DRV-9). */
export const PREFLIGHT_KEYS = new Set(['preflight.tlsAcme']);

export function variantsOf(lab: LabV2): string[] {
  return ['default', ...(lab.startProfile?.variants ?? []).map((v) => v.id)];
}

function declaredEntries(provisions: readonly ProvisionItem[]): (PlanEntry & { rule?: string[] })[] {
  return provisions
    .filter((p) => p.kind === 'module' || p.kind === 'local' || p.kind === 'runtime')
    .map((p) => ({
      id: p.item,
      kind: p.kind as PlanEntry['kind'],
      basis: (p.basis ?? 'single') as PlanEntry['basis'],
      ...(strMap(p.set) ? { set: strMap(p.set)! } : {}),
      ...(strMap(p.params) ? { params: strMap(p.params)! } : {}),
      ...(p.value !== undefined ? { value: str(p.value) } : {}),
      ...(p.rule ? { rule: Array.isArray(p.rule) ? p.rule : [p.rule] } : {}),
    }));
}

/**
 * The rule ID a plan warning stands for, or null for free text. Forms: `DEP-018` (reference deriver, `plan --profile`),
 * `rules: DEP-013` (scripts/module rule check of the start state), `waf: DEP-018 <message>` (rule issues of a target) and
 * `DRV-5: …`. Hook planHints (`email: manual prerequisite "ses-identity": …`) and other notes are not rules.
 */
export function warningRuleId(w: string): string | null {
  const m = /^(?:[a-z][a-z0-9.-]*:\s*)?([A-Z]{2,5}-\d{1,3})(?![A-Za-z0-9])/.exec(w.trim());
  return m ? m[1]! : null;
}

const sameMap = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

const fmt = (e: PlanEntry) =>
  `${e.kind}:${e.id}${e.set && Object.keys(e.set).length ? ` set ${JSON.stringify(e.set)}` : ''}${e.params && Object.keys(e.params).length ? ` params ${JSON.stringify(e.params)}` : ''}${e.value !== undefined ? ` value ${e.value}` : ''}`;

export async function planFor(set: ContentSet, card: CardContent, variant: string, mode: DeriverMode, state: { cliUnavailable?: string }): Promise<PlanOutput> {
  if (mode !== 'reference' && !state.cliUnavailable) {
    const r = cliPlan(set.paths, card.id, variant, path.join(card.dir, 'lab.yaml'));
    if (r.status === 'ok') return r.plan;
    if (r.status === 'failed') {
      if (r.raw && typeof r.raw === 'object') {
        // exit 2 with a JSON body: the plan exists but is invalid (DRV-5 etc.)
        const { normalizeCliPlan } = await import('./cli.js');
        const plan = normalizeCliPlan(r.raw as Record<string, unknown>, card.id, variant);
        plan.errors.push(`scripts/module plan --start-of exited ${r.exitCode}: ${r.message.split('\n')[0]}`);
        return plan;
      }
      throw new Error(`scripts/module plan --start-of ${card.id} --variant ${variant} failed (${r.exitCode}): ${r.message}`);
    }
    if (mode === 'cli') throw new Error(r.reason);
    state.cliUnavailable = r.reason;
  }
  return referencePlan(set.paths, card.lab, variant);
}

export async function deriveCard(set: ContentSet, card: CardContent, mode: DeriverMode, state: { cliUnavailable?: string } = {}): Promise<{ derivation: CardDerivation; issues: LintIssue[] }> {
  const issues: LintIssue[] = [];
  const lab = card.lab;
  const add = (rule: string, message: string, severity: 'error' | 'warn' = 'error') => issues.push({ card: card.id, rule, severity, message });
  const derivation: CardDerivation = { card: card.id, variants: [] };
  const rv = registryVersion(set.paths);

  for (const variant of variantsOf(lab)) {
    const tag = variant === 'default' ? '' : ` [variant ${variant}]`;
    let plan: PlanOutput;
    try {
      plan = await planFor(set, card, variant, mode, state);
    } catch (e) {
      add('DRV-9', `${tag ? `${tag.trim()}: ` : ''}cannot derive the start state: ${e instanceof Error ? e.message : String(e)}`);
      derivation.variants.push({ variant, plan: null, profile: null, provisionClass: null, cost: null });
      continue;
    }
    const view = variantView(lab, variant);

    // DRV-9: derivable; preflight variants only reference registered keys
    for (const err of plan.errors) add(err.startsWith('DRV-5') ? 'DRV-5' : 'DRV-9', `${err}${tag}`);
    if (view.variantDef?.select === 'preflight') {
      const keys = [...(view.variantDef.when ?? '').matchAll(/\b(preflight\.[A-Za-z0-9_.]+)/g)].map((m) => m[1]!);
      for (const k of keys) if (!PREFLIGHT_KEYS.has(k)) add('DRV-9', `variant ${variant}: when references ${k}, which 02's account preflight does not register`);
      if (!keys.length) add('DRV-9', `variant ${variant}: select: preflight needs a when on preflight.* keys`);
    }

    // DRV-1: provisions (module / local / runtime) equal the plan entry by entry
    const declared = declaredEntries(view.provisions);
    const planned = plan.start.filter((e) => e.basis !== 'base');
    const key = (e: { kind: string; id: string }) => `${e.kind}:${e.id}`;
    const dmap = new Map(declared.map((e) => [key(e), e]));
    const pmap = new Map(planned.map((e) => [key(e), e]));
    for (const [k, e] of pmap) {
      const d = dmap.get(k);
      if (!d) add('DRV-1', `missing provision${tag}: ${fmt(e)} (plan: ${(e.because ?? []).join(', ') || e.basis})`);
      else if (!sameMap(d.set, e.set) || !sameMap(d.params, e.params) || (d.value ?? '') !== (e.value ?? '')) {
        add('DRV-1', `provision differs${tag}: declared ${fmt(d)}, plan ${fmt(e)}`);
      }
    }
    for (const [k, d] of dmap) if (!pmap.has(k)) add('DRV-1', `provision not in the plan${tag}: ${fmt(d)}`);

    // DRV-2: basis agrees with the plan's reason
    for (const d of declared.filter((x) => x.kind === 'module')) {
      const e = pmap.get(key(d));
      if (!e) continue;
      if (d.basis === 'credential' && d.id !== 'iam') add('DRV-2', `basis credential is only for C3's iam (${d.id})${tag}`);
      if (d.basis !== e.basis && !(d.basis === 'closure' && e.basis === 'closure')) add('DRV-2', `${d.id}: basis ${d.basis}, plan says ${e.basis}${tag}`);
      if (d.basis === 'closure') {
        const because = new Set(e.because ?? []);
        for (const r of d.rule ?? []) if (!because.has(r)) add('DRV-2', `${d.id}: rule ${r} is not in the plan's because [${[...because].join(', ')}]${tag}`);
      }
      if (d.basis === 'precursor' && !view.targets.some((t) => t.id === d.id && t.fromDriver)) add('DRV-2', `${d.id}: basis precursor without a target fromDriver${tag}`);
    }

    // DRV-5: every target changes something; fromDriver equals the start value
    for (const t of view.targets) {
      const inStart = planned.find((e) => e.id === t.id && (e.kind === 'module' || e.kind === 'local'));
      const startValue = inStart ? Object.values(inStart.set ?? {})[0] : undefined;
      if (inStart && !t.fromDriver) add('DRV-5', `target ${t.id} is in the start state (${fmt(inStart)}): fromDriver is required${tag}`);
      if (inStart && t.fromDriver && startValue !== undefined && t.fromDriver !== startValue) add('DRV-5', `target ${t.id}: fromDriver ${t.fromDriver} ≠ start value ${startValue}${tag}`);
      if (!inStart && t.fromDriver && t.fromDriver !== localDriver(set.paths, t.id)) add('DRV-5', `target ${t.id}: fromDriver ${t.fromDriver} but the module is not in the start state${tag}`);
      const changesDriver = t.driver !== (t.fromDriver ?? localDriver(set.paths, t.id));
      if (!changesDriver && !Object.keys(t.set ?? {}).length && !Object.keys(t.params ?? {}).length) add('DRV-5', `target ${t.id} does not change anything (driver ${t.driver})${tag}`);
    }

    // DRV-6: warnings when enabling the targets in manual order are expected
    const expected = new Set(lab.expectedWarnings ?? []);
    let warnings = plan.warnings;
    const profile = renderProfile(plan, String(lab.version));
    if (plan.deriver === 'scripts/module') {
      // the reference deriver must compute the same digest as scripts/module (06 PM-33 step 11)
      if (planDigest(plan) !== plan.digest) add('DRV-10', `labs digest of the scripts/module plan is ${planDigest(plan)}, scripts/module says ${plan.digest} (digest object differs)${tag}`, 'warn');
      const then = targetsInManualOrder(lab, view.targets).map((t) => `${t.id}:${Object.entries({ ...(t.set ?? {}) }).map(([k, v]) => `${k}=${String(v)}`).join(',')}`.replace(/:$/, ''));
      const r = cliProfileDigest(set.paths, card.id, variant, profile, then);
      if (r.status === 'ok') {
        warnings = [...new Set([...warnings, ...r.warnings])];
        if (r.digest !== plan.digest) {
          // scripts/module parseAtlProfile attributes PROFILE_DRIVERS keys by ownsEnv only: a switch variable that no module
          // owns (STORAGE_DRIVER is shared by storage and shared-fs) is dropped, so `plan --profile` cannot reproduce the
          // `plan --start-of` digest. When that loss explains the difference exactly, report it as a toolkit defect (warn).
          const dropped: string[] = [];
          const lossy = plan.start.map((e) => {
            if (e.kind !== 'module' || !e.set) return e;
            const keep = Object.fromEntries(Object.entries(e.set).filter(([k]) => {
              const ok = ownerOfKey(set.paths, k, { switchVar: false }) === e.id;
              if (!ok) dropped.push(k);
              return ok;
            }));
            return { ...e, set: keep };
          });
          const explained = dropped.length > 0 && planDigest({ ...plan, start: lossy }) === r.digest;
          if (explained) {
            add('DRV-10', `plan --profile drops ${[...new Set(dropped)].join(', ')} from PROFILE_DRIVERS (scripts/module parseAtlProfile only maps ownsEnv keys): its digest ${r.digest} ≠ plan --start-of digest ${plan.digest}; the runner reports PROFILE_DIGEST_MISMATCH until the toolkit is fixed${tag}`, 'warn');
          } else add('DRV-10', `plan --profile digest ${r.digest} ≠ plan --start-of digest ${plan.digest}${tag}`);
        }
      } else add('DRV-10', `plan --profile cross-check not possible: ${r.reason}${tag}`, 'warn');
    }
    for (const w of warnings) {
      // only rule-shaped warnings are compared (wave1-integration): `rules: DEP-013`, `waf: DEP-018 <message>` and `DEP-018`
      // all mean DEP-018; free text such as a module hook's planHints ("manual prerequisite …") is advice, not a rule
      const id = warningRuleId(w);
      if (id && !expected.has(id) && !expected.has(w)) add('DRV-6', `warning ${w} appears when enabling the targets in manual order but is not in expectedWarnings${tag}`);
    }

    // DRV-7: wire order follows the dependency order between targets
    const idx = new Map(lab.steps.map((s, i) => [s.id, i]));
    for (const [t, deps] of Object.entries(plan.targetDeps)) {
      const tw = lab.targetModules.find((x) => x.id === t)?.wireStep;
      for (const d of deps) {
        const dw = lab.targetModules.find((x) => x.id === d)?.wireStep;
        if (tw && dw && (idx.get(dw) ?? 0) > (idx.get(tw) ?? 0)) add('DRV-7', `target ${t} needs ${d}: wire step ${dw} must come before ${tw}${tag}`);
      }
    }

    // DRV-8: branches
    const declaredBranches = Object.fromEntries(Object.entries(view.branches).map(([k, v]) => [k, v.choose]));
    const planBranches = Object.fromEntries(Object.entries(plan.branches).map(([k, v]) => [k, v.choose]));
    if (JSON.stringify(Object.entries(declaredBranches).sort()) !== JSON.stringify(Object.entries(planBranches).sort())) {
      add('DRV-8', `branches ${JSON.stringify(declaredBranches)} ≠ plan ${JSON.stringify(planBranches)}${tag}`);
    }

    // platform section (06 PM-21) — the lint rule A6 checks the static part; the plan is the authority
    const declaredHttps = (view.variantDef?.platform ?? lab.startProfile.platform)?.preview?.directHttps;
    if (declaredHttps !== plan.platform['preview.directHttps']) add('DRV-1', `startProfile.platform.preview.directHttps is ${declaredHttps}, plan says ${plan.platform['preview.directHttps']}${tag}`);

    // DRV-10: the generated profile reproduces the plan digest
    const round = profileDigest(profile, rv, (k) => ownerOfKey(set.paths, k));
    if (plan.deriver === 'reference' && round.digest !== plan.digest) add('DRV-10', `profile digest ${round.digest} ≠ plan digest ${plan.digest}${tag}`);

    // DRV-11: provision class and cost tier
    let pc: ProvisionClass | null = null;
    let ct: CostTierResult | null = null;
    if (set.taxonomy) {
      const xstk = (lab.extraStacks ?? []).filter((x) => x.deploy === 'start').map(() => 'extra-stack');
      pc = provisionClass(plan.start, xstk, set.taxonomy);
      const { items, missingModules } = expandCost(lab, plan.start, set.pricing);
      for (const m of missingModules) add('DRV-11', `labs/_pricing/dimensions.yaml has no billing items for module ${m}${tag}`);
      ct = costTier(items, set.taxonomy);
    }
    derivation.variants.push({ variant, plan, profile, provisionClass: pc, cost: ct });
  }

  // DRV-11 on the card: class of the default variant, tier = highest of all variants (05 §8.3)
  const def = derivation.variants.find((v) => v.variant === 'default');
  if (def?.provisionClass && def.provisionClass !== lab.provision.class) add('DRV-11', `provision.class is ${lab.provision.class}, computed ${def.provisionClass}`);
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const tiers = derivation.variants.map((v) => v.cost).filter((c): c is CostTierResult => !!c);
  if (tiers.length) {
    const req = tiers.map((t) => t.required).sort((a, b) => rank[b] - rank[a])[0]!;
    const opt = tiers.map((t) => t.withOptional).sort((a, b) => rank[b] - rank[a])[0]!;
    if (req !== lab.cost.tier) add('DRV-11', `cost.tier is ${lab.cost.tier}, computed ${req}`);
    if (opt !== (lab.cost.tierWithOptional ?? lab.cost.tier)) add('DRV-11', `cost.tierWithOptional is ${lab.cost.tierWithOptional ?? `(= tier ${lab.cost.tier})`}, computed ${opt}`);
  }
  return { derivation, issues };
}

export async function deriveAll(set: ContentSet, mode: DeriverMode = 'auto', only?: readonly string[]): Promise<DeriveResult> {
  const state: { cliUnavailable?: string } = {};
  const cards: CardDerivation[] = [];
  const issues: LintIssue[] = [];
  const derivers = new Set<string>();
  for (const card of fullCards(set)) {
    if (only?.length && !only.includes(card.id)) continue;
    const r = await deriveCard(set, card, mode, state);
    cards.push(r.derivation);
    issues.push(...r.issues);
    for (const v of r.derivation.variants) if (v.plan) derivers.add(v.plan.deriver);
  }
  if (state.cliUnavailable) {
    issues.unshift({ card: '*', rule: 'DRV-0', severity: 'warn', message: `${state.cliUnavailable}: reference derivation (scripts/module-cli planner) used` });
  }
  const deriver = derivers.size === 1 ? ([...derivers][0] as 'scripts/module' | 'reference') : derivers.size ? 'mixed' : 'reference';
  return { deriver, cards, issues };
}
