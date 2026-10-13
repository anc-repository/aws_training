/**
 * Dev-mode / test Price List (`ATL_DEV_MODE=1`): answers `GetProducts` with Price List shaped documents built from a
 * table of **placeholder unit prices that are not AWS prices**. Quotes priced from it carry `pricing: 'fixture'` and the
 * note “开发模式：单价来自开发夹具，不是 AWS 价格”. Only the dev runtime and tests import this module; production uses
 * `awsPriceListSource`.
 */
import { PRICING_DIMENSION_SET, type DimensionSet } from './dimensions.js';
import type { GetProductsPage, GetProductsQuery, PriceListSource } from './price-list.js';

/** Placeholder unit prices by Price List unit (round, obviously synthetic values; USD per unit). */
const PLACEHOLDER_BY_UNIT: Readonly<Record<string, number>> = {
  Hrs: 0.01,
  'GB-Mo': 0.1,
  GB: 0.01,
  Requests: 0.000001,
  'Lambda-GB-Second': 0.00001,
  WriteRequestUnits: 0.000001,
  ReadRequestUnits: 0.0000001,
  'WriteCapacityUnit-Hrs': 0.001,
  'LCU-Hrs': 0.01,
  'vCPU-Hours': 0.01,
  Month: 1,
  Keys: 1,
  Secrets: 0.1,
  HostedZone: 0.1,
  Metrics: 0.1,
  Alarms: 0.1,
};

export interface FixtureOptions {
  /** Override the placeholder price of a pricing key (tests). `null` = the Price List has no product for it. */
  prices?: Record<string, number | null>;
  /** Pricing keys whose query fails (tests: throttling / access denied). */
  failures?: Record<string, Error>;
  dims?: DimensionSet;
  publicationDate?: string;
}

function matches(dimFilters: Record<string, string>, q: GetProductsQuery): boolean {
  const got = new Map(q.filters.map((f) => [f.field, f.value]));
  return Object.entries(dimFilters).every(([k, v]) => (v.includes('{') ? got.has(k) : got.get(k) === v));
}

export function fixturePriceListSource(opts: FixtureOptions = {}): PriceListSource & { queries: GetProductsQuery[] } {
  const dims = opts.dims ?? PRICING_DIMENSION_SET;
  const queries: GetProductsQuery[] = [];
  return {
    kind: 'fixture',
    queries,
    async getProducts(q): Promise<GetProductsPage> {
      queries.push(q);
      const hit = Object.entries(dims.dimensions).find(([, d]) => d.serviceCode === q.serviceCode && matches(d.filters, q));
      if (!hit) return { priceList: [] };
      const [pricingKey, dim] = hit;
      const fail = opts.failures?.[pricingKey];
      if (fail) throw fail;
      const price = opts.prices && pricingKey in opts.prices ? opts.prices[pricingKey] : (PLACEHOLDER_BY_UNIT[dim.unit] ?? 0.01);
      if (price === null || price === undefined) return { priceList: [] };
      const sku = `FIXTURE-${pricingKey}`;
      const attributes = Object.fromEntries(q.filters.map((f) => [f.field, f.value]));
      const doc = {
        product: { sku, productFamily: 'ATL dev fixture', attributes: { ...attributes, atlFixture: 'true' } },
        serviceCode: q.serviceCode,
        terms: {
          OnDemand: {
            [`${sku}.TERM`]: {
              sku,
              effectiveDate: opts.publicationDate ?? '2026-01-01T00:00:00Z',
              priceDimensions: {
                [`${sku}.TERM.RATE`]: { unit: dim.unit, pricePerUnit: { USD: String(price) }, beginRange: '0', endRange: 'Inf', description: 'ATL dev fixture - not an AWS price' },
              },
            },
          },
        },
        version: 'fixture',
        publicationDate: opts.publicationDate ?? '2026-01-01T00:00:00Z',
      };
      return { priceList: [JSON.stringify(doc)] };
    },
  };
}
