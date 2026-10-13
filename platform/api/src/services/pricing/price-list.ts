/**
 * Price List Query API access for atl-pricing (01 §3.2, §6.9 `pricing:GetProducts`; 04 §3.4).
 *
 * - `PriceListSource` is the only thing that talks to AWS: `GetProducts` pages for one service code and a set of
 *   `TERM_MATCH` filters. Production uses `@aws-sdk/client-pricing` (loaded lazily, provided by the Lambda runtime like
 *   every other `@aws-sdk/*` package); dev mode and tests inject a fixture source (`fixture.ts`).
 * - `parsePriceList` reads the on-demand unit price out of the Price List JSON documents. Several matching products or
 *   tiers give a range (`low`…`high`); nothing matching gives `null` — the caller shows “unknown”, never 0 (04 §3.4).
 */

export interface PriceListFilter {
  field: string;
  value: string;
}

export interface GetProductsQuery {
  serviceCode: string;
  filters: PriceListFilter[];
  nextToken?: string;
  maxResults?: number;
}

export interface GetProductsPage {
  /** Price List documents (`aws_v1` format), one JSON string per product. */
  priceList: string[];
  nextToken?: string | null;
}

export interface PriceListSource {
  /** `price-list` = AWS Price List Query API; `fixture` = dev / test data (never presented as an AWS price). */
  readonly kind: 'price-list' | 'fixture';
  getProducts(q: GetProductsQuery): Promise<GetProductsPage>;
}

/**
 * The Price List Query API is served from a few regions only (us-east-1, eu-central-1, ap-south-1; AWS documentation).
 * Pick the one closest to the platform region; prices of every region are available from each endpoint.
 */
export function priceListEndpointRegion(platformRegion: string): string {
  if (platformRegion.startsWith('eu-') || platformRegion.startsWith('me-') || platformRegion.startsWith('af-') || platformRegion.startsWith('il-')) return 'eu-central-1';
  if (platformRegion.startsWith('ap-')) return 'ap-south-1';
  return 'us-east-1';
}

/** The subset of `@aws-sdk/client-pricing` that is used (structural, so the package stays optional at build time). */
export interface PricingSdk {
  PricingClient: new (config: { region: string }) => { send(command: unknown): Promise<unknown> };
  GetProductsCommand: new (input: Record<string, unknown>) => unknown;
}

const PRICING_SDK_MODULE = '@aws-sdk/client-pricing';

/** Lazy `import('@aws-sdk/client-pricing')` (a variable specifier: the package is not a build-time dependency). */
export async function loadPricingSdk(): Promise<PricingSdk> {
  return (await import(/* @vite-ignore */ PRICING_SDK_MODULE)) as PricingSdk;
}

export class PricingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Atl.PricingUnavailable';
  }
}

/** Production source: `pricing:GetProducts` with the function role (ATLPricingFunctionRole). */
export function awsPriceListSource(opts: { platformRegion: string; endpointRegion?: string; loadSdk?: () => Promise<PricingSdk> }): PriceListSource {
  const endpointRegion = opts.endpointRegion ?? priceListEndpointRegion(opts.platformRegion);
  let client: Promise<{ sdk: PricingSdk; client: InstanceType<PricingSdk['PricingClient']> }> | null = null;
  const get = () => {
    client ??= (opts.loadSdk ?? loadPricingSdk)()
      .then((sdk) => ({ sdk, client: new sdk.PricingClient({ region: endpointRegion }) }))
      .catch((e: unknown) => {
        client = null;
        throw new PricingUnavailableError(`@aws-sdk/client-pricing is not available: ${e instanceof Error ? e.message : String(e)}`);
      });
    return client;
  };
  return {
    kind: 'price-list',
    async getProducts(q) {
      const { sdk, client: c } = await get();
      const out = (await c.send(
        new sdk.GetProductsCommand({
          ServiceCode: q.serviceCode,
          FormatVersion: 'aws_v1',
          Filters: q.filters.map((f) => ({ Type: 'TERM_MATCH', Field: f.field, Value: f.value })),
          MaxResults: q.maxResults ?? 100,
          ...(q.nextToken ? { NextToken: q.nextToken } : {}),
        }),
      )) as { PriceList?: unknown[]; NextToken?: string };
      // SDK v3 returns strings (older versions a LazyJsonString wrapper whose toString() is the JSON)
      return { priceList: (out.PriceList ?? []).map((d) => (typeof d === 'string' ? d : String(d))), nextToken: out.NextToken ?? null };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing

export interface UnitPrice {
  /** USD per `unit`. `low` < `high` when several products or tiers match. */
  low: number;
  high: number;
  unit: string;
  skus: string[];
  /** `publicationDate` of the newest document. */
  publication: string | null;
  /** Price dimension descriptions (for the quote line `detail`, trimmed). */
  descriptions: string[];
}

/** `Hrs` ≡ `Hours` ≡ `hr`, `Requests` ≡ `Request`, `GB-Mo` ≡ `GB-month`, … (case-insensitive, separators ignored). */
export function normalizeUnit(u: string): string {
  const s = u.toLowerCase().replace(/[\s_-]+/g, '');
  const table: Record<string, string> = {
    hrs: 'hour',
    hours: 'hour',
    hour: 'hour',
    hr: 'hour',
    gbmo: 'gbmonth',
    gbmonth: 'gbmonth',
    gbmonths: 'gbmonth',
    requests: 'request',
    request: 'request',
    lambdagbsecond: 'gbsecond',
    gbsecond: 'gbsecond',
    gbseconds: 'gbsecond',
    writerequestunits: 'wru',
    wru: 'wru',
    readrequestunits: 'rru',
    rru: 'rru',
    lcuhrs: 'lcuhour',
    lcuhour: 'lcuhour',
    vcpuhours: 'vcpuhour',
    vcpuhour: 'vcpuhour',
    month: 'month',
    mo: 'month',
  };
  return table[s] ?? s.replace(/s$/, '');
}

interface PriceDimensionDoc {
  unit?: string;
  pricePerUnit?: Record<string, string>;
  beginRange?: string;
  description?: string;
}

/** On-demand unit price in USD from Price List documents; `null` when no document has a price in `unit`. */
export function parsePriceList(docs: readonly string[], unit: string): UnitPrice | null {
  const want = normalizeUnit(unit);
  const firstTier: number[] = [];
  const laterTiers: number[] = [];
  const skus = new Set<string>();
  const descriptions = new Set<string>();
  let publication: string | null = null;
  for (const raw of docs) {
    let doc: { product?: { sku?: string }; terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, PriceDimensionDoc> }> }; publicationDate?: string };
    try {
      doc = JSON.parse(raw) as typeof doc;
    } catch {
      continue;
    }
    let used = false;
    for (const term of Object.values(doc.terms?.OnDemand ?? {})) {
      for (const d of Object.values(term.priceDimensions ?? {})) {
        if (!d.unit || normalizeUnit(d.unit) !== want) continue;
        const usd = Number(d.pricePerUnit?.USD);
        if (!Number.isFinite(usd) || usd < 0) continue;
        const begin = Number(d.beginRange ?? '0');
        (begin === 0 ? firstTier : laterTiers).push(usd);
        if (d.description) descriptions.add(d.description.slice(0, 160));
        used = true;
      }
    }
    if (used) {
      if (doc.product?.sku) skus.add(doc.product.sku);
      if (doc.publicationDate && (!publication || doc.publicationDate > publication)) publication = doc.publicationDate;
    }
  }
  if (!firstTier.length && !laterTiers.length) return null;
  const base = firstTier.length ? firstTier : laterTiers;
  const low = Math.min(...base);
  let high = Math.max(...base);
  // a free first tier (0) followed by paid tiers: the upper bound takes the cheapest paid tier
  const paid = laterTiers.filter((p) => p > 0);
  if (high === 0 && paid.length) high = Math.min(...paid);
  return { low, high, unit, skus: [...skus].sort(), publication, descriptions: [...descriptions].slice(0, 3) };
}
