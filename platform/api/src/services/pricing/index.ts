/**
 * atl-pricing `PriceQuote` (01 §3.2, 02 §3.2, §10.1, 04 §3.4): the synchronous call `services/catalog/quotes.ts` makes
 * for every START / REUSE / EXTEND / KEEP quote. Reads the expanded card from the content release (start profile,
 * target modules, extra stacks), the workstation instance type from `PlatformConfig`, prices every billing dimension
 * through the `PriceBook` and returns the 08 §9.2 #6 quote structure. Preflight variants (02 §3.2) are priced too and the
 * costlier result is returned.
 *
 * Failure semantics: a dimension that cannot be priced is an `unknown` line; when the Price List cannot be reached at all
 * (no SDK, access denied for every call) the action throws `Atl.PricingUnavailable` and the API keeps its explicit
 * “price unavailable” quote (quotes.ts). No amount is ever made up.
 */
import { DEFAULT_VARIANT, INSTALL_DEFAULTS } from '@atl/shared';
import { createRepositories } from '../../repositories/index.js';
import type { FunctionDeps } from '../../runtime/deps.js';
import type { QuoteLine } from '../catalog/quotes.js';
import { CatalogStore, type LabContent } from '../catalog/store.js';
import { estimate, type Estimate, type VariantInputs } from './estimate.js';
import { PriceBook } from './price-book.js';
import { PricingUnavailableError, type PriceListSource } from './price-list.js';

export { PRICING_DIMENSION_SET } from './dimensions.js';
export { awsPriceListSource, PricingUnavailableError, priceListEndpointRegion, type PriceListSource } from './price-list.js';
export { PriceBook } from './price-book.js';
export { estimate, expandLines } from './estimate.js';

const PURPOSES = ['START', 'REUSE', 'EXTEND', 'KEEP'] as const;

function variantInputs(lab: LabContent | null, id: string): VariantInputs | null {
  if (!lab) return null;
  if (!id || id === DEFAULT_VARIANT) {
    return { id: DEFAULT_VARIANT, provisions: (lab.startProfile?.provisions ?? []) as VariantInputs['provisions'], targetModules: (lab.targetModules ?? []) as VariantInputs['targetModules'] };
  }
  const v = (lab.startProfile?.variants ?? []).find((x) => x.id === id);
  if (!v) return null;
  return {
    id: v.id,
    provisions: (v.provisions ?? lab.startProfile?.provisions ?? []) as VariantInputs['provisions'],
    targetModules: (v.targetModules ?? lab.targetModules ?? []) as VariantInputs['targetModules'],
  };
}

function costliness(e: Estimate): number {
  return e.hourly?.completed?.high ?? e.hourly?.start?.high ?? -1;
}

export interface PricingActionOptions {
  /** Price List access (production: `awsPriceListSource`; dev / tests: a fixture). */
  source: (deps: FunctionDeps, region: string) => PriceListSource;
}

export async function priceQuoteAction(payload: Record<string, unknown>, deps: FunctionDeps, opts: PricingActionOptions): Promise<Record<string, unknown>> {
  const purpose = String(payload.purpose ?? 'START');
  if (!(PURPOSES as readonly string[]).includes(purpose)) throw Object.assign(new Error(`PriceQuote: unknown purpose ${purpose}`), { name: 'Atl.InvalidInput' });
  const lines = Array.isArray(payload.lines) ? (payload.lines as QuoteLine[]) : null;
  if (!lines) throw Object.assign(new Error('PriceQuote: lines[] is required'), { name: 'Atl.InvalidInput' });
  const region = typeof payload.region === 'string' && payload.region ? payload.region : deps.env.region;
  const repos = createRepositories(deps.db, deps.env.tableName);
  const labId = typeof payload.labId === 'string' ? payload.labId : '';
  const catalogVersion = typeof payload.catalogVersion === 'string' ? payload.catalogVersion : '';
  const [lab, config] = await Promise.all([
    labId && catalogVersion ? new CatalogStore(deps, repos.platform).lab(labId, catalogVersion).catch(() => null) : Promise.resolve(null),
    repos.platform.config().catch(() => null),
  ]);
  const source = opts.source(deps, region);
  const book = new PriceBook({ table: repos.table, region, source, nowMs: () => deps.ports.clock.nowMs() });
  const workstationInstanceType = String((config?.workstation as { instanceType?: string } | undefined)?.instanceType ?? INSTALL_DEFAULTS.WorkstationInstanceType);
  const selected = typeof payload.variant === 'string' ? payload.variant : DEFAULT_VARIANT;
  const alternatives = Array.isArray(payload.alternativeVariants) ? (payload.alternativeVariants as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const base = {
    purpose,
    region,
    lines,
    lab,
    workstationInstanceType,
    durationMinutes: Number(payload.durationMinutes ?? 0),
    maxTotalMinutes: Number(payload.maxTotalMinutes ?? payload.durationMinutes ?? 0),
    ...(typeof payload.keepHours === 'number' ? { keepHours: payload.keepHours } : {}),
  };
  const results: { variant: string; e: Estimate }[] = [];
  for (const id of [selected, ...alternatives]) {
    const variant = variantInputs(lab, id);
    if (id !== selected && !variant) continue;
    results.push({ variant: id, e: await estimate({ ...base, variant }, book, source.kind) });
  }
  const errors = results.flatMap((r) => r.e.errors);
  if (errors.length) console.warn(JSON.stringify({ level: 'warn', msg: 'atl-pricing: Price List calls failed', count: errors.length, errors: errors.slice(0, 5) }));
  if (results.every((r) => r.e.pricedItems === 0) && errors.length) throw new PricingUnavailableError(errors[0]!);
  const chosen = results.reduce((best, r) => (costliness(r.e) > costliness(best.e) ? r : best), results[0]!);
  const { errors: _e, pricedItems: _p, ...quote } = chosen.e;
  return {
    ...quote,
    pricedVariant: chosen.variant,
    ...(chosen.variant !== selected ? { notes: [...quote.notes, `报价按预检可能替换成的变体 ${chosen.variant} 计算（较高者）`] } : {}),
    priceSource: source.kind,
  };
}
