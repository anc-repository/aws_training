/**
 * Build-time recomputation of the provision class (05 §3.4) and the cost tier (05 §3.3) — DRV-11 / catalog C-7.
 *
 * Provision class (from the start state only; slow resources created inside the card do not count):
 *   A  only L0 and “fast” modules;
 *   B  one or two “medium / slow” resources that are not RDS / ElastiCache (CloudFront, ALB, instance replacement,
 *      Cognito user pool, EFS …);
 *   C  RDS or ElastiCache (taxonomy `provisionClassRules.heavy`);
 *   D  RDS / ElastiCache plus an ALB, another RDS / ElastiCache or an instance replacement (`replacement`).
 * Cost tier: hourly-billed units outside the base (L0, workstation, platform), weighted by `costTier.weights` (longest
 * pricingKey prefix), plus account-scoped services; `ref:` entries expand through `labs/_pricing/dimensions.yaml`.
 */
import type { CostItem, LabV2 } from '@atl/shared';
import type { BillItem, PricingDoc, TaxonomyDoc } from '../content.js';
import type { PlanEntry } from './plan.js';

export type CostTier = 'low' | 'medium' | 'high';
export type ProvisionClass = 'A' | 'B' | 'C' | 'D';

export function provisionClass(start: readonly PlanEntry[], extraStackModules: readonly string[], taxonomy: TaxonomyDoc): ProvisionClass {
  const mods = [...new Set([...start.filter((e) => e.kind === 'module' && e.basis !== 'base').map((e) => e.id), ...extraStackModules])];
  const heavyIds = new Set(taxonomy.provisionClassRules?.heavy ?? ['database', 'cache', 'db-proxy']);
  const replacementIds = new Set(taxonomy.provisionClassRules?.replacement ?? ['load-balancer', 'autoscaling', 'network']);
  const heavy = mods.filter((m) => heavyIds.has(m));
  const replacement = mods.filter((m) => replacementIds.has(m));
  const slowish = mods.filter((m) => !heavyIds.has(m) && (taxonomy.provisionSpeed[m] ?? 'fast') !== 'fast' && taxonomy.provisionSpeed[m] !== 'base');
  if (heavy.length === 0) return slowish.length ? 'B' : 'A';
  if (heavy.length === 1 && replacement.length === 0) return 'C';
  return 'D';
}

export interface ExpandedCostItem extends BillItem {
  source: string;
  base?: boolean;
  optional?: boolean;
  whenRetained?: boolean;
}

function scaled(item: BillItem, values: Record<string, string>): number {
  if (!item.scaleBy) return item.quantity;
  const v = values[item.scaleBy.key];
  const f = v !== undefined ? item.scaleBy.values[v] : undefined;
  return item.quantity * (f ?? item.scaleBy.default ?? 1);
}

/** 04 §3.4 expansion of `cost.basis` (start-profile, workstation, target-modules, extra-stacks + explicit items). */
export function expandCost(lab: LabV2, start: readonly PlanEntry[], pricing: PricingDoc | null): { items: ExpandedCostItem[]; missingModules: string[] } {
  const items: ExpandedCostItem[] = [];
  const missingModules: string[] = [];
  const moduleItems = (id: string, values: Record<string, string>, source: string, optional: boolean) => {
    const list = pricing?.modules?.[id];
    if (!list) {
      missingModules.push(id);
      return;
    }
    for (const it of list) items.push({ ...it, quantity: scaled(it, values), source, ...(optional ? { optional: true } : {}) });
  };
  for (const b of lab.cost?.basis ?? []) {
    if ('ref' in b) {
      if (b.ref === 'start-profile') {
        for (const it of pricing?.base ?? []) items.push({ ...it, source: 'start-profile', base: true });
        for (const e of start.filter((x) => x.kind === 'module' && x.basis !== 'base')) {
          moduleItems(e.id, { ...(e.set ?? {}), ...(e.params ?? {}) }, 'start-profile', false);
        }
      } else if (b.ref === 'workstation') {
        for (const it of pricing?.workstation ?? []) items.push({ ...it, source: 'workstation' });
      } else if (b.ref === 'target-modules') {
        for (const t of lab.targetModules ?? []) {
          const values = Object.fromEntries(Object.entries({ ...(t.set ?? {}), ...(t.params ?? {}) }).map(([k, v]) => [k, String(v)]));
          moduleItems(t.id, values, 'target', t.optional === true);
        }
      }
      continue;
    }
    const c = b as Exclude<CostItem, { ref: string }>;
    items.push({
      key: c.key,
      pricingKey: c.pricingKey,
      billing: c.billing,
      quantity: c.quantity,
      ...(c.unit ? { unit: c.unit } : {}),
      ...(c.assumedUsagePerHour !== undefined ? { assumedUsagePerHour: c.assumedUsagePerHour } : {}),
      source: c.source,
      ...(c.optional ? { optional: true } : {}),
      ...(c.whenRetained === false ? { whenRetained: false } : {}),
    });
  }
  return { items, missingModules: [...new Set(missingModules)] };
}

function weightOf(key: string, weights: Record<string, number>): number {
  const hit = Object.entries(weights)
    .filter(([prefix]) => key.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : 1;
}

export interface CostTierResult {
  required: CostTier;
  withOptional: CostTier;
  hourlyUnits: number;
  hourlyUnitsWithOptional: number;
  accountScoped: string[];
}

export function costTier(items: readonly ExpandedCostItem[], taxonomy: TaxonomyDoc): CostTierResult {
  const rules = taxonomy.costTier;
  const calc = (withOptional: boolean) => {
    const inScope = items.filter((i) => withOptional || !i.optional);
    const units = inScope
      .filter((i) => i.billing === 'hourly' && !i.base && i.source !== 'workstation' && i.source !== 'platform')
      .reduce((n, i) => n + weightOf(i.pricingKey, rules.weights) * i.quantity, 0);
    const accountScoped = [...new Set(inScope.filter((i) => rules.accountScopedKeys.some((k) => i.pricingKey.startsWith(k))).map((i) => i.pricingKey))];
    const tier: CostTier = units >= rules.highUnits ? 'high' : units >= 1 || accountScoped.length ? 'medium' : 'low';
    return { tier, units, accountScoped };
  };
  const req = calc(false);
  const opt = calc(true);
  return { required: req.tier, withOptional: opt.tier, hourlyUnits: req.units, hourlyUnitsWithOptional: opt.units, accountScoped: req.accountScoped };
}

/** Display names of the cost sources by billing class (05 §8.4 `costSources`, no amounts). */
export function costSources(items: readonly ExpandedCostItem[]): { hourly: string[]; usage: string[]; monthly: string[] } {
  const pick = (b: string) => [...new Set(items.filter((i) => !i.base && i.source !== 'workstation' && i.billing === b).map((i) => i.pricingKey))];
  return { hourly: pick('hourly'), usage: pick('usage'), monthly: pick('monthly') };
}
