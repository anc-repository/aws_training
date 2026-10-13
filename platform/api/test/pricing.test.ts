/**
 * atl-pricing (01 §3.2, 02 §3.2 / §10.1, 04 §3.4, 08 §9.2 #6): dimension table, Price List parsing, PriceCache, ref
 * expansion, the estimate algorithm, failure semantics (unknown, never 0), the production SDK wiring (fake SDK module;
 * aws-sdk-client-mock when @aws-sdk/client-pricing is installed) and the API pass-through. No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Keys } from '@atl/shared';
import { createPricingActions, createPricingHandler } from '../src/functions/pricing/handler.js';
import { createRepositories } from '../src/repositories/index.js';
import { estimate, expandLines, resolveFilters } from '../src/services/pricing/estimate.js';
import { PRICING_DIMENSION_SET } from '../src/services/pricing/dimensions.js';
import { fixturePriceListSource } from '../src/services/pricing/fixture.js';
import { cacheDimensionKey, NOT_FOUND_CACHE_HOURS, PriceBook } from '../src/services/pricing/price-book.js';
import { awsPriceListSource, normalizeUnit, parsePriceList, priceListEndpointRegion, type PricingSdk } from '../src/services/pricing/price-list.js';
import { priceQuoteAction } from '../src/services/pricing/index.js';
import { quoteLinesFromLab, type QuoteLine } from '../src/services/catalog/quotes.js';
import type { LabContent } from '../src/services/catalog/store.js';
import { body, createApiTestRuntime, ev, LEARNER, type ApiTestRuntime } from './api-support/api-runtime.js';
import { CATALOG_VERSION, fixtureLab, LAB_ID } from './api-support/fixtures.js';
import { memoryDb } from './api-support/memory-ddb.js';
import { devAdvance } from '../src/dev-server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

function doc(o: { sku?: string; unit?: string; usd: string | string[]; begin?: string[]; publication?: string }): string {
  const usd = Array.isArray(o.usd) ? o.usd : [o.usd];
  const dims = Object.fromEntries(usd.map((u, i) => [`D${i}`, { unit: o.unit ?? 'Hrs', pricePerUnit: { USD: u }, beginRange: o.begin?.[i] ?? '0', endRange: 'Inf', description: `tier ${i}` }]));
  return JSON.stringify({ product: { sku: o.sku ?? 'SKU1' }, terms: { OnDemand: { T: { priceDimensions: dims } } }, publicationDate: o.publication ?? '2026-09-01T00:00:00Z' });
}

describe('dimension table', () => {
  it('is the transcription of labs/_pricing/dimensions.yaml (no prices)', () => {
    const y = parseYaml(fs.readFileSync(path.join(REPO, 'labs/_pricing/dimensions.yaml'), 'utf8')) as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(PRICING_DIMENSION_SET))).toEqual({ schema: y.schema, dimensions: y.dimensions, base: y.base, workstation: y.workstation, modules: y.modules });
    expect(JSON.stringify(PRICING_DIMENSION_SET)).not.toMatch(/"(usd|price|USD)"/);
  });

  it('every item references a dimension', () => {
    const items = [...PRICING_DIMENSION_SET.base, ...PRICING_DIMENSION_SET.workstation, ...Object.values(PRICING_DIMENSION_SET.modules).flat()];
    for (const it of items) expect(PRICING_DIMENSION_SET.dimensions[it.pricingKey], it.pricingKey).toBeTruthy();
  });
});

describe('Price List parsing', () => {
  it('normalizes units', () => {
    expect(normalizeUnit('Hrs')).toBe(normalizeUnit('hours'));
    expect(normalizeUnit('GB-Mo')).toBe(normalizeUnit('GB-month'));
    expect(normalizeUnit('Requests')).toBe(normalizeUnit('requests'));
    expect(normalizeUnit('Lambda-GB-Second')).toBe(normalizeUnit('GB-second'));
    expect(normalizeUnit('WriteRequestUnits')).toBe(normalizeUnit('WRU'));
    expect(normalizeUnit('LCU-Hrs')).toBe(normalizeUnit('LCU-hour'));
  });

  it('reads the first-tier on-demand price; several products give a range; nothing → null', () => {
    expect(parsePriceList([doc({ usd: '0.0216000000' })], 'Hrs')).toMatchObject({ low: 0.0216, high: 0.0216, skus: ['SKU1'], publication: '2026-09-01T00:00:00Z' });
    expect(parsePriceList([doc({ usd: '0.02' }), doc({ sku: 'SKU2', usd: '0.03' })], 'Hrs')).toMatchObject({ low: 0.02, high: 0.03, skus: ['SKU1', 'SKU2'] });
    expect(parsePriceList([doc({ usd: '0.02', unit: 'GB-Mo' })], 'Hrs')).toBeNull();
    expect(parsePriceList(['not json'], 'Hrs')).toBeNull();
    expect(parsePriceList([], 'Hrs')).toBeNull();
  });

  it('a free first tier followed by paid tiers bounds the range with the cheapest paid tier', () => {
    expect(parsePriceList([doc({ usd: ['0', '0.09', '0.085'], begin: ['0', '1', '10240'], unit: 'GB' })], 'GB')).toMatchObject({ low: 0, high: 0.085 });
  });

  it('endpoint regions of the Price List Query API', () => {
    expect(priceListEndpointRegion('ap-northeast-1')).toBe('ap-south-1');
    expect(priceListEndpointRegion('eu-west-1')).toBe('eu-central-1');
    expect(priceListEndpointRegion('us-west-2')).toBe('us-east-1');
  });
});

describe('placeholders', () => {
  it('region-derived values; a missing one is reported, never guessed', () => {
    expect(resolveFilters({ usagetype: '{regionPrefix}LoadBalancerUsage' }, {}, 'ap-northeast-1')).toEqual({ filters: { usagetype: 'APN1-LoadBalancerUsage' }, used: { regionPrefix: 'APN1-' } });
    expect(resolveFilters({ usagetype: '{regionPrefix}LoadBalancerUsage' }, {}, 'us-east-1')).toMatchObject({ filters: { usagetype: 'LoadBalancerUsage' } });
    expect(resolveFilters({ usagetype: '{regionPrefix}LoadBalancerUsage' }, {}, 'xx-nowhere-9')).toEqual({ missing: 'regionPrefix' });
    expect(resolveFilters({ instanceType: '{instanceType}' }, { instanceType: 't4g.small' }, 'ap-northeast-1')).toMatchObject({ filters: { instanceType: 't4g.small' } });
    expect(cacheDimensionKey('ec2.instance', { instanceType: 't4g.small' })).toBe('ec2.instance@instanceType=t4g.small');
  });
});

// ---------------------------------------------------------------------------------------------------------------

function lab(over: Record<string, unknown> = {}): LabContent {
  return { ...fixtureLab(), ...over } as unknown as LabContent;
}

function variantOf(l: LabContent) {
  return { id: 'default', provisions: l.startProfile.provisions as never, targetModules: l.targetModules as never };
}

function input(l: LabContent, extra: Partial<Parameters<typeof estimate>[0]> = {}): Parameters<typeof estimate>[0] {
  return {
    purpose: 'START',
    region: 'ap-northeast-1',
    lines: quoteLinesFromLab(l),
    lab: l,
    variant: variantOf(l),
    workstationInstanceType: 't4g.small',
    durationMinutes: 90,
    maxTotalMinutes: 150,
    ...extra,
  };
}

const NOW = Date.UTC(2026, 9, 14, 1, 0, 0);

describe('estimate (04 §3.4)', () => {
  let book: PriceBook;
  let source: ReturnType<typeof fixturePriceListSource>;
  beforeEach(() => {
    source = fixturePriceListSource({ prices: { 'ec2.instance': 0.02, 'ebs.gp3.storage': 0.1, 'vpc.public-ipv4': 0.005, 'sqs.requests': 0.0000004 } });
    book = new PriceBook({ table: null, region: 'ap-northeast-1', source, nowMs: () => NOW });
  });

  it('expands start-profile / workstation refs and prices hourly, monthly and usage items', async () => {
    const l = lab();
    const ex = expandLines(input(l));
    expect(ex.map((x) => `${x.line.group}:${x.line.key}`)).toEqual([
      'start:lab-instance',
      'start:lab-ebs',
      'start:lab-ipv4',
      'workstation:ws-instance',
      'workstation:ws-ebs',
      'workstation:ws-ipv4',
      'usage:sqs-requests',
      'platform:undefined',
    ]);
    const e = await estimate(input(l), book, 'fixture');
    // start = instance 0.02 + EBS 40 GB × 0.1 / 730 + IPv4 0.005
    const start = 0.02 + (40 * 0.1) / 730 + 0.005;
    expect(e.hourly?.start?.low).toBeCloseTo(start, 6);
    // completed adds the usage item (typical 1000 × 0.0000004, high × 3)
    expect(e.hourly?.completed?.low).toBeCloseTo(start, 6);
    expect(e.hourly?.completed?.typical).toBeCloseTo(start + 0.0004, 6);
    expect(e.hourly?.completed?.high).toBeCloseTo(start + 0.0012, 6);
    // workstation = platform overhead per hour (08 §9.2 #6)
    const ws = 0.02 + (20 * 0.1) / 730 + 0.005;
    expect(e.platformOverhead.perHour?.low).toBeCloseTo(ws, 6);
    expect(e.platformOverhead.perSession).toBeNull();
    expect(e.platformOverhead.qualitative?.length).toBeGreaterThan(0);
    // maxSession = completed.high × 150/60 + start.high × (deploy 15 + cleanup …)/60 + ws × (…)
    expect(e.maxSession!.high).toBeGreaterThan(e.hourly!.completed!.high * 2.5);
    expect(e.retainHourly).toBeCloseTo(start, 6); // usage items are not retained
    expect(e.incomplete).toEqual([]);
    expect(e.pricing).toBe('fixture');
    expect(e.notes.join('\n')).toContain('不是 AWS 价格');
    const line = e.lines.find((x) => x.key === 'lab-instance')!;
    expect(line).toMatchObject({ service: 'EC2', dimension: 'ec2.instance', perHourLow: 0.02, unitPrice: { low: 0.02, unit: 'Hrs' }, base: true });
    expect(source.queries.find((q) => q.serviceCode === 'AmazonEC2' && q.filters.some((f) => f.field === 'instanceType'))?.filters).toEqual(
      expect.arrayContaining([
        { field: 'instanceType', value: 't4g.small' },
        { field: 'regionCode', value: 'ap-northeast-1' },
      ]),
    );
  });

  it('a dimension without a price is unknown and listed in incomplete — never 0', async () => {
    source = fixturePriceListSource({ prices: { 'vpc.public-ipv4': null } });
    book = new PriceBook({ table: null, region: 'ap-northeast-1', source, nowMs: () => NOW });
    const e = await estimate(input(lab()), book, 'fixture');
    const ipv4 = e.lines.filter((l) => l.pricingKey === 'vpc.public-ipv4');
    expect(ipv4.length).toBe(2);
    expect(ipv4.every((l) => l.unknown === true && l.perHourLow === undefined && typeof l.reason === 'string')).toBe(true);
    expect(e.incomplete).toEqual(['vpc.public-ipv4']);
    expect(e.notes.join()).toContain('未按 0 计');
  });

  it('target modules, scaleBy and module parameters (RDS Multi-AZ = 2 units, instance class placeholder)', async () => {
    const l = lab({
      cost: { tier: 'medium', basis: [{ ref: 'target-modules' }] },
      targetModules: [{ id: 'database', driver: 'postgres', params: { MultiAz: 'true', DbInstanceClass: 'db.t4g.small' }, wireStep: 'wire' }],
    });
    const e = await estimate(input(l), book, 'fixture');
    const rds = e.lines.find((x) => x.key === 'rds-instance')!;
    expect(rds.quantity).toBe(2);
    expect(source.queries.find((q) => q.serviceCode === 'AmazonRDS' && q.filters.some((f) => f.field === 'instanceType'))?.filters).toContainEqual({ field: 'instanceType', value: 'db.t4g.small' });
  });

  it('extra stacks are one unknown line each (not derived from the templates)', async () => {
    const l = lab({ cost: { tier: 'low', basis: [{ ref: 'extra-stacks' }] }, extraStacks: [{ id: 'bench', title: '基准实例' }] });
    const e = await estimate(input(l), book, 'fixture');
    expect(e.lines.find((x) => x.ref === 'extra-stacks')).toMatchObject({ unknown: true, group: 'extra-stack', reason: expect.stringContaining('模板') });
    expect(e.incomplete).toContain('ref:extra-stacks');
  });

  it('KEEP: environment lines (base + enabled modules), maxSession = retained hourly × hours', async () => {
    const lines: QuoteLine[] = [
      { group: 'environment', ref: 'start-profile' },
      { group: 'environment', ref: 'module', key: 'cache' },
      { group: 'environment', ref: 'module', key: 'not-a-module' },
    ];
    const e = await estimate({ ...input(lab(), { purpose: 'KEEP', lines, durationMinutes: 240, maxTotalMinutes: 240, keepHours: 4 }) }, book, 'fixture');
    expect(e.lines.map((l) => l.key)).toEqual(['lab-instance', 'lab-ebs', 'lab-ipv4', 'elasticache-node', 'not-a-module']);
    expect(e.retainHourly).not.toBeNull();
    expect(e.maxSession!.high).toBeCloseTo(e.retainHourlyRange!.high * 4, 6);
    expect(e.incomplete).toEqual(['ref:module']);
  });
});

describe('PriceCache', () => {
  it('caches 24 h, re-fetches after expiry, caches “no price” for 1 h, and never mixes sources', async () => {
    const db = memoryDb().client;
    const repos = createRepositories(db, 'atl-main');
    let now = NOW;
    const source = fixturePriceListSource({ prices: { 'vpc.public-ipv4': null } });
    const mk = (s = source) => new PriceBook({ table: repos.table, region: 'ap-northeast-1', source: s, nowMs: () => now });
    const dim = PRICING_DIMENSION_SET.dimensions['ec2.instance']!;
    const first = await mk().price('ec2.instance', dim, { ...dim.filters, instanceType: 't4g.small' }, { instanceType: 't4g.small' });
    expect(first).toMatchObject({ found: true, low: 0.01, source: 'fixture' });
    const item = await repos.table.get(Keys.priceCache('ap-northeast-1', 'AmazonEC2', 'ec2.instance@instanceType=t4g.small'));
    expect(item).toMatchObject({ type: 'PriceCache', expiresAt: new Date(NOW + 24 * 3_600_000).toISOString(), found: true });
    expect(typeof item!.ttl).toBe('number');
    const calls = source.queries.length;
    await mk().price('ec2.instance', dim, { ...dim.filters, instanceType: 't4g.small' }, { instanceType: 't4g.small' });
    expect(source.queries.length).toBe(calls);
    now += 25 * 3_600_000;
    await mk().price('ec2.instance', dim, { ...dim.filters, instanceType: 't4g.small' }, { instanceType: 't4g.small' });
    expect(source.queries.length).toBe(calls + 1);
    // negative entries
    const ipv4 = PRICING_DIMENSION_SET.dimensions['vpc.public-ipv4']!;
    expect(await mk().price('vpc.public-ipv4', ipv4, ipv4.filters, {})).toMatchObject({ found: false, low: null });
    const neg = await repos.table.get(Keys.priceCache('ap-northeast-1', 'AmazonVPC', 'vpc.public-ipv4'));
    expect(neg!.expiresAt).toBe(new Date(now + NOT_FOUND_CACHE_HOURS * 3_600_000).toISOString());
    // a price-list book does not read fixture entries
    const real = { kind: 'price-list' as const, queries: 0, async getProducts() { this.queries++; return { priceList: [doc({ usd: '0.0168' })] }; } };
    expect(await mk(real as never).price('ec2.instance', dim, { ...dim.filters, instanceType: 't4g.small' }, { instanceType: 't4g.small' })).toMatchObject({ low: 0.0168, source: 'price-list' });
    expect(real.queries).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('awsPriceListSource (production wiring with a fake SDK module)', () => {
  class FakeCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  it('sends GetProducts with TERM_MATCH filters to the Price List endpoint region and follows NextToken', async () => {
    const sent: { region: string; input: Record<string, unknown> }[] = [];
    const sdk: PricingSdk = {
      PricingClient: class {
        constructor(private readonly cfg: { region: string }) {}
        async send(cmd: unknown) {
          const input = (cmd as FakeCommand).input;
          sent.push({ region: this.cfg.region, input });
          return input.NextToken ? { PriceList: [doc({ sku: 'B', usd: '0.03' })] } : { PriceList: [doc({ usd: '0.02' })], NextToken: 'n1' };
        }
      },
      GetProductsCommand: FakeCommand,
    };
    const book = new PriceBook({ table: null, region: 'ap-northeast-1', source: awsPriceListSource({ platformRegion: 'ap-northeast-1', loadSdk: async () => sdk }), nowMs: () => NOW });
    const dim = PRICING_DIMENSION_SET.dimensions['ec2.instance']!;
    const p = await book.price('ec2.instance', dim, { ...dim.filters, instanceType: 't4g.small' }, { instanceType: 't4g.small' });
    expect(p).toMatchObject({ low: 0.02, high: 0.03, found: true, source: 'price-list', skus: ['B', 'SKU1'] });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.region).toBe('ap-south-1');
    expect(sent[0]!.input).toMatchObject({ ServiceCode: 'AmazonEC2', FormatVersion: 'aws_v1', MaxResults: 100 });
    expect(sent[0]!.input.Filters).toContainEqual({ Type: 'TERM_MATCH', Field: 'regionCode', Value: 'ap-northeast-1' });
    expect(sent[1]!.input.NextToken).toBe('n1');
  });

  it('a missing SDK surfaces as Atl.PricingUnavailable (the API then keeps its unpriced quote)', async () => {
    const src = awsPriceListSource({ platformRegion: 'ap-northeast-1', loadSdk: async () => Promise.reject(new Error('Cannot find package')) });
    await expect(src.getProducts({ serviceCode: 'AmazonEC2', filters: [] })).rejects.toMatchObject({ name: 'Atl.PricingUnavailable' });
  });
});

// aws-sdk-client-mock needs the real client class: runs once @aws-sdk/client-pricing is installed (missing dependency)
const PRICING_PKG = '@aws-sdk/client-pricing';
const realSdk = (await import(/* @vite-ignore */ PRICING_PKG).catch(() => null)) as (PricingSdk & Record<string, unknown>) | null;
describe.skipIf(!realSdk)('awsPriceListSource with @aws-sdk/client-pricing (aws-sdk-client-mock)', () => {
  it('GetProductsCommand round trip', async () => {
    const { mockClient } = await import('aws-sdk-client-mock');
    const m = mockClient(realSdk!.PricingClient as never);
    try {
      m.on(realSdk!.GetProductsCommand as never).resolves({ PriceList: [doc({ usd: '0.0168' })] } as never);
      const src = awsPriceListSource({ platformRegion: 'us-east-1' });
      const r = await src.getProducts({ serviceCode: 'AmazonEC2', filters: [{ field: 'instanceType', value: 't4g.small' }] });
      expect(parsePriceList(r.priceList, 'Hrs')).toMatchObject({ low: 0.0168 });
    } finally {
      m.restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('PriceQuote action and the API', () => {
  let rt: ApiTestRuntime;
  beforeEach(async () => {
    rt = await createApiTestRuntime();
  });
  afterEach(() => undefined);

  it('handler: PriceQuote priced from the content release; unknown actions are Atl.NotImplemented', async () => {
    const h = createPricingHandler(async () => rt.deps, createPricingActions({ source: () => fixturePriceListSource() }));
    const r = (await h({ action: 'PriceQuote', purpose: 'START', region: 'ap-northeast-1', labId: LAB_ID, catalogVersion: CATALOG_VERSION, variant: 'default', lines: quoteLinesFromLab(lab()), durationMinutes: 90, maxTotalMinutes: 150 })) as Record<string, unknown>;
    expect(r).toMatchObject({ pricing: 'fixture', priceSource: 'fixture', pricedVariant: 'default', currency: 'USD' });
    expect((r.hourly as { start: { low: number } }).start.low).toBeGreaterThan(0);
    await expect(h({ action: 'Nope' })).rejects.toMatchObject({ name: 'Atl.NotImplemented' });
    await expect(h({ action: 'PriceQuote', purpose: 'X', lines: [] })).rejects.toMatchObject({ name: 'Atl.InvalidInput' });
  });

  it('every Price List call failing → Atl.PricingUnavailable; some failing → unknown lines', async () => {
    const all = Object.fromEntries(Object.keys(PRICING_DIMENSION_SET.dimensions).map((k) => [k, Object.assign(new Error('denied'), { name: 'AccessDeniedException' })]));
    const payload = { purpose: 'START', region: 'ap-northeast-1', labId: LAB_ID, catalogVersion: CATALOG_VERSION, lines: quoteLinesFromLab(lab()), durationMinutes: 90, maxTotalMinutes: 150 };
    await expect(priceQuoteAction(payload, rt.deps, { source: () => fixturePriceListSource({ failures: all }) })).rejects.toMatchObject({ name: 'Atl.PricingUnavailable' });
    const some = await priceQuoteAction(payload, rt.deps, { source: () => fixturePriceListSource({ failures: { 'sqs.requests': Object.assign(new Error('slow'), { name: 'ThrottlingException' }) } }) });
    expect(some.incomplete).toEqual(['sqs.requests']);
    expect(JSON.stringify(some)).not.toContain('ThrottlingException');
  });

  it('preflight variants: the costlier quote is returned and named', async () => {
    const l = { ...fixtureLab() } as Record<string, unknown>;
    (l.startProfile as Record<string, unknown>).variants = [{ id: 'with-cache', title: 'x', select: 'preflight', when: 'x', provisions: [{ item: 'cache', kind: 'module', reason: 'x' }], reason: 'x' }];
    await rt.objects.put(rt.deps.env.buckets.web, `content/${CATALOG_VERSION}/labs/${LAB_ID}.json`, JSON.stringify(l));
    const r = await priceQuoteAction(
      { purpose: 'START', region: 'ap-northeast-1', labId: LAB_ID, catalogVersion: CATALOG_VERSION, variant: 'default', alternativeVariants: ['with-cache'], lines: quoteLinesFromLab(l as unknown as LabContent), durationMinutes: 90, maxTotalMinutes: 150 },
      rt.deps,
      { source: () => fixturePriceListSource() },
    );
    expect(r.pricedVariant).toBe('with-cache');
    expect((r.notes as string[]).join()).toContain('with-cache');
  });

  it('POST /labs/{labId}/quotes passes the priced structure through (08 §9.2 #6)', async () => {
    rt.invoker.register('atl-pricing', createPricingHandler(async () => rt.deps, createPricingActions({ source: () => fixturePriceListSource() })));
    const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
    expect(q).toMatchObject({
      pricing: 'fixture',
      hourly: { start: { low: expect.any(Number), high: expect.any(Number) }, completed: { low: expect.any(Number), typical: expect.any(Number), high: expect.any(Number) } },
      platformOverhead: { perHour: { low: expect.any(Number) }, perSession: null, qualitative: expect.any(Array) },
      maxSession: { low: expect.any(Number), high: expect.any(Number) },
      incomplete: [],
    });
    expect((q.lines as QuoteLine[]).some((l) => l.group === 'platform')).toBe(true);
  });

  it('KEEP quotes: requiresTypedConfirm above cost.highHourlyThreshold (08 §9.2 #7)', async () => {
    rt.invoker.register('atl-pricing', createPricingHandler(async () => rt.deps, createPricingActions({ source: () => fixturePriceListSource() })));
    const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
    const s = body(await rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true } })));
    const sid = s.sessionId as string;
    await devAdvance(rt.deps, sid, 'PROVISIONING');
    await devAdvance(rt.deps, sid, 'READY');
    const keep = async () => body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/quotes`, { token: LEARNER, body: { purpose: 'KEEP', keepHours: 4 } })));
    expect(await keep()).toMatchObject({ purpose: 'KEEP', highHourlyThreshold: null, requiresTypedConfirm: false });
    const patched = await rt.api(ev('PATCH', '/api/v1/settings', { token: LEARNER, body: { cost: { highHourlyThreshold: 0.001 } } }));
    expect(patched.statusCode, patched.body).toBe(200);
    expect(body(patched).cost).toEqual({ highHourlyThreshold: 0.001 });
    const k = await keep();
    expect(k).toMatchObject({ highHourlyThreshold: 0.001, requiresTypedConfirm: true, typedConfirmValue: LAB_ID });
    expect(k.maxSession).toMatchObject({ high: expect.any(Number) });
  });
});
