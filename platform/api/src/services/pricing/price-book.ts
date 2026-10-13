/**
 * Unit prices with the `PriceCache` entity (01 §7.2: `PRICE#<region>` / `<serviceCode>#<dimension key>`, TTL 24 h).
 *
 * `expiresAt` decides freshness (TTL only cleans up, 01 §7.2). A dimension the Price List has no match for is cached as
 * `found: false` for a shorter time, so a mis-mapped filter does not cost a GetProducts call per quote. Entries carry the
 * source kind; a fixture price is never served to a `price-list` book and vice versa.
 */
import { Keys, ttlAfterHours, TTL_POLICY } from '../../data/keys.js';
import type { Table } from '../../repositories/index.js';
import type { PricingDimension } from './dimensions.js';
import { parsePriceList, type PriceListFilter, type PriceListSource } from './price-list.js';

export interface PriceEntry {
  pricingKey: string;
  serviceCode: string;
  unit: string;
  currency: 'USD';
  /** USD per unit; `null` when the Price List has no matching product (shown as “unknown”). */
  low: number | null;
  high: number | null;
  found: boolean;
  source: 'price-list' | 'fixture';
  fetchedAt: string;
  publication: string | null;
  skus: string[];
}

export const NOT_FOUND_CACHE_HOURS = 1;
const MAX_PAGES = 5;

/** Services whose products have no `regionCode` (priced by edge location or globally). */
const GLOBAL_SERVICE_CODES = new Set(['AmazonCloudFront', 'AmazonRoute53']);

/** Dimension key of the cache item: the pricing key plus the resolved placeholder values (`ec2.instance@instanceType=t4g.small`). */
export function cacheDimensionKey(pricingKey: string, params: Record<string, string>): string {
  const p = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join(',');
  return p ? `${pricingKey}@${p}` : pricingKey;
}

export function priceListFilters(dim: PricingDimension, resolved: Record<string, string>, region: string): PriceListFilter[] {
  const filters = Object.entries(resolved).map(([field, value]) => ({ field, value }));
  if (!GLOBAL_SERVICE_CODES.has(dim.serviceCode) && !('regionCode' in resolved) && !('location' in resolved)) filters.push({ field: 'regionCode', value: region });
  return filters;
}

export class PriceBook {
  private readonly memo = new Map<string, Promise<PriceEntry>>();
  calls = 0;

  constructor(
    private readonly o: {
      table: Table | null;
      region: string;
      source: PriceListSource;
      nowMs: () => number;
      ttlHours?: number;
    },
  ) {}

  /** Unit price of a dimension whose placeholders are already substituted (`filters`). */
  price(pricingKey: string, dim: PricingDimension, filters: Record<string, string>, params: Record<string, string>): Promise<PriceEntry> {
    const dimKey = cacheDimensionKey(pricingKey, params);
    const k = `${dim.serviceCode}#${dimKey}`;
    let p = this.memo.get(k);
    if (!p) {
      p = this.load(pricingKey, dim, filters, dimKey);
      this.memo.set(k, p);
    }
    return p;
  }

  private async load(pricingKey: string, dim: PricingDimension, filters: Record<string, string>, dimKey: string): Promise<PriceEntry> {
    const key = Keys.priceCache(this.o.region, dim.serviceCode, dimKey);
    const nowMs = this.o.nowMs();
    if (this.o.table) {
      const cached = await this.o.table.get(key).catch(() => null);
      if (cached && cached.source === this.o.source.kind && typeof cached.expiresAt === 'string' && Date.parse(cached.expiresAt) > nowMs) {
        return {
          pricingKey,
          serviceCode: dim.serviceCode,
          unit: String(cached.unit ?? dim.unit),
          currency: 'USD',
          low: typeof cached.low === 'number' ? cached.low : null,
          high: typeof cached.high === 'number' ? cached.high : null,
          found: cached.found === true,
          source: this.o.source.kind,
          fetchedAt: String(cached.fetchedAt),
          publication: (cached.publication as string | null | undefined) ?? null,
          skus: Array.isArray(cached.skus) ? (cached.skus as string[]) : [],
        };
      }
    }
    const docs: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      this.calls++;
      const r = await this.o.source.getProducts({ serviceCode: dim.serviceCode, filters: priceListFilters(dim, filters, this.o.region), ...(token ? { nextToken: token } : {}) });
      docs.push(...r.priceList);
      if (!r.nextToken) break;
      token = r.nextToken;
    }
    const unit = parsePriceList(docs, dim.unit);
    const fetchedAt = new Date(nowMs).toISOString();
    const entry: PriceEntry = {
      pricingKey,
      serviceCode: dim.serviceCode,
      unit: dim.unit,
      currency: 'USD',
      low: unit?.low ?? null,
      high: unit?.high ?? null,
      found: !!unit,
      source: this.o.source.kind,
      fetchedAt,
      publication: unit?.publication ?? null,
      skus: unit?.skus.slice(0, 20) ?? [],
    };
    if (this.o.table) {
      const hours = entry.found ? (this.o.ttlHours ?? TTL_POLICY.priceCacheHours) : NOT_FOUND_CACHE_HOURS;
      const expiresMs = nowMs + hours * 3_600_000;
      await this.o.table
        .put({
          ...key,
          type: 'PriceCache',
          ver: 1,
          createdAt: fetchedAt,
          updatedAt: fetchedAt,
          region: this.o.region,
          dimensionKey: dimKey,
          filters,
          ...entry,
          expiresAt: new Date(expiresMs).toISOString(),
          ttl: ttlAfterHours(expiresMs, 0),
        })
        .catch((e: unknown) => console.warn(JSON.stringify({ level: 'warn', msg: 'PriceCache write failed', pricingKey, error: String(e) })));
    }
    return entry;
  }
}
