/**
 * Quote estimation of atl-pricing (04 §3.4 algorithm, 02 §10.1 line items, 08 §9.2 #6 response structure).
 *
 * 1. **Expand** the request lines: `ref: start-profile` → the L0 base items (+ the start modules' items for START /
 *    REUSE), `ref: workstation` → workstation items, `ref: target-modules` → target modules' items, `ref: module` (EXTEND /
 *    KEEP, one per enabled module) → that module's items, quantities and placeholders taken from the parameters the
 *    environment recorded for the module (`line.params`, `Environment.moduleParams`); without them an item that depends on
 *    a parameter (`scaleBy`, `{instanceType}` …) is an unknown line — the template default (NAT 0, Single-AZ, the smallest
 *    class) is not assumed for an environment whose actual parameters are not known. `ref: extra-stacks` → one “unknown”
 *    line per card stack (their billable resources are not derived from the templates). Explicit `pricingKey` lines stay
 *    as they are.
 * 2. **Price** every item through the `PriceBook` (Price List + `PriceCache`); placeholders (`{instanceType}`, …) come
 *    from module parameters, platform settings or the region. Anything that cannot be priced is an `unknown` line and
 *    its key is listed in `incomplete` — never counted as 0.
 * 3. **Sum** (04 §3.4): hourly = quantity × price, monthly = quantity × price / 730, usage = assumedUsagePerHour × price
 *    (typical; the upper bound uses 3 × the usage); `retainHourly` = fixed items kept while the environment is retained.
 */
import { CLASS_BUDGETS } from '../../functions/lifecycle/rules.js';
import type { PricedQuote, QuoteGroup, QuoteLine } from '../catalog/quotes.js';
import type { LabContent } from '../catalog/store.js';
import { PRICING_DIMENSION_SET, type DimensionItem, type DimensionSet } from './dimensions.js';
import type { PriceBook, PriceEntry } from './price-book.js';
import { normalizeUnit } from './price-list.js';

export const HOURS_PER_MONTH = 730;
export const USAGE_HIGH_FACTOR = 3;

/** Defaults of the module templates' parameters that select a priced product (infra/modules/*.yaml), not prices. */
export const PARAM_DEFAULTS: Readonly<Record<string, string>> = { instanceType: 't4g.small', dbInstanceClass: 'db.t4g.micro', cacheNodeType: 'cache.t4g.micro' };
const PARAM_SOURCES: Readonly<Record<string, string>> = { instanceType: 'InstanceType', dbInstanceClass: 'DbInstanceClass', cacheNodeType: 'CacheNodeType' };

/** Usage-type prefixes of the Price List (`APN1-LoadBalancerUsage`); us-east-1 has none. Unknown regions → unknown price. */
export const USAGE_TYPE_PREFIX: Readonly<Record<string, string>> = {
  'us-east-1': '',
  'us-east-2': 'USE2-',
  'us-west-1': 'USW1-',
  'us-west-2': 'USW2-',
  'ca-central-1': 'CAN1-',
  'eu-west-1': 'EU-',
  'eu-west-2': 'EUW2-',
  'eu-west-3': 'EUW3-',
  'eu-central-1': 'EUC1-',
  'eu-north-1': 'EUN1-',
  'ap-northeast-1': 'APN1-',
  'ap-northeast-2': 'APN2-',
  'ap-northeast-3': 'APN3-',
  'ap-southeast-1': 'APS1-',
  'ap-southeast-2': 'APS2-',
  'ap-south-1': 'APS3-',
  'sa-east-1': 'SAE1-',
};

/** CloudFront price class location of the viewers closest to the platform region (labels of the Price List). */
export function edgeLocationGroup(region: string): string | null {
  if (region === 'ap-northeast-1' || region === 'ap-northeast-3') return 'Japan';
  if (region.startsWith('us-')) return 'United States';
  if (region.startsWith('ca-')) return 'Canada';
  if (region.startsWith('eu-')) return 'Europe';
  if (region.startsWith('ap-south-')) return 'India';
  if (region === 'ap-southeast-2' || region === 'ap-southeast-4') return 'Australia';
  if (region.startsWith('ap-')) return 'Asia Pacific';
  if (region.startsWith('sa-')) return 'South America';
  return null;
}

const SERVICE_NAMES: Readonly<Record<string, string>> = {
  AmazonEC2: 'EC2',
  AmazonVPC: 'VPC',
  AmazonCloudFront: 'CloudFront',
  AmazonRoute53: 'Route 53',
  AWSELB: 'Elastic Load Balancing',
  awswaf: 'WAF',
  AmazonS3: 'S3',
  AmazonEFS: 'EFS',
  AmazonRDS: 'RDS',
  AmazonElastiCache: 'ElastiCache',
  AmazonDynamoDB: 'DynamoDB',
  AmazonKinesisFirehose: 'Data Firehose',
  AWSBackup: 'AWS Backup',
  AWSLambda: 'Lambda',
  AWSQueueService: 'SQS',
  AmazonSNS: 'SNS',
  AmazonSES: 'SES',
  AmazonEventBridge: 'EventBridge',
  AmazonRekognition: 'Rekognition',
  AmazonApiGateway: 'API Gateway',
  AmazonStates: 'Step Functions',
  AmazonCognito: 'Cognito',
  awskms: 'KMS',
  AWSSecretsManager: 'Secrets Manager',
  AmazonCloudWatch: 'CloudWatch',
  AWSXRay: 'X-Ray',
  AWSCloudTrail: 'CloudTrail',
  AmazonGuardDuty: 'GuardDuty',
  AWSConfig: 'Config',
  AmazonInspectorV2: 'Inspector',
  AWSBudgets: 'Budgets',
};

export interface VariantInputs {
  id: string;
  provisions: { item: string; kind: string; set?: Record<string, unknown>; params?: Record<string, unknown> }[];
  targetModules: { id: string; optional?: boolean; set?: Record<string, unknown>; params?: Record<string, unknown> }[];
}

export interface EstimateInput {
  purpose: string;
  region: string;
  lines: QuoteLine[];
  lab: LabContent | null;
  variant: VariantInputs | null;
  workstationInstanceType: string;
  durationMinutes: number;
  maxTotalMinutes: number;
  keepHours?: number;
  dims?: DimensionSet;
}

/** One priceable (or explicitly unknown) item after expansion. */
interface Expanded {
  line: QuoteLine;
  item: (Pick<DimensionItem, 'pricingKey' | 'billing' | 'quantity' | 'unit' | 'assumedUsagePerHour'> & { whenRetained?: boolean; optional?: boolean }) | null;
  params: Record<string, string>;
  reason?: string;
}

interface Priced extends Expanded {
  low: number | null;
  high: number | null;
  usage: boolean;
  entry: PriceEntry | null;
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

/** Module parameter / switch lookup for `scaleBy` and placeholders. */
function paramOf(key: string, ...sources: (Record<string, unknown> | undefined)[]): string | undefined {
  for (const s of sources) {
    const v = str(s?.[key]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function scaled(it: DimensionItem, ...sources: (Record<string, unknown> | undefined)[]): number {
  if (!it.scaleBy) return it.quantity;
  const v = paramOf(it.scaleBy.key, ...sources);
  const m = v !== undefined && v in it.scaleBy.values ? it.scaleBy.values[v]! : (it.scaleBy.default ?? 1);
  return it.quantity * m;
}

function placeholderParams(defaults: Record<string, string>, ...sources: (Record<string, unknown> | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, param] of Object.entries(PARAM_SOURCES)) {
    const v = paramOf(param, ...sources);
    if (v !== undefined) out[name] = v;
    else if (defaults[name] !== undefined) out[name] = defaults[name]!;
  }
  return out;
}

function fromItem(group: QuoteGroup, it: DimensionItem, extra: { ref?: string; module?: string; optional?: boolean; base?: boolean; defaults: Record<string, string> }, ...sources: (Record<string, unknown> | undefined)[]): Expanded {
  const quantity = scaled(it, ...sources);
  return {
    line: {
      group,
      key: it.key,
      pricingKey: it.pricingKey,
      billing: it.billing,
      quantity,
      ...(it.unit ? { unit: it.unit } : {}),
      ...(it.assumedUsagePerHour !== undefined ? { assumedUsagePerHour: it.assumedUsagePerHour } : {}),
      ...(extra.ref ? { ref: extra.ref } : {}),
      ...(extra.optional ? { optional: true } : {}),
      ...(extra.base ? { base: true } : {}),
      detail: [extra.module ? `模块 ${extra.module}` : null, it.note ?? null].filter(Boolean).join(' · ') || undefined,
    } as QuoteLine,
    item: { pricingKey: it.pricingKey, billing: it.billing, quantity, ...(it.unit ? { unit: it.unit } : {}), ...(it.assumedUsagePerHour !== undefined ? { assumedUsagePerHour: it.assumedUsagePerHour } : {}), ...(extra.optional ? { optional: true } : {}) },
    params: placeholderParams(extra.defaults, ...sources),
  };
}

/** Module-parameter placeholders of the filters (`{regionPrefix}` / `{edgeLocationGroup}` come from the region). */
const PARAM_PLACEHOLDER = new RegExp(String.raw`\{(${Object.keys(PARAM_SOURCES).join('|')})\}`);

/** The item's quantity or Price List product depends on a module parameter. */
export function dependsOnModuleParams(it: DimensionItem, dims: DimensionSet = PRICING_DIMENSION_SET): boolean {
  if (it.scaleBy) return true;
  return Object.values(dims.dimensions[it.pricingKey]?.filters ?? {}).some((v) => PARAM_PLACEHOLDER.test(v));
}

/**
 * The module parameters atl-pricing reads (scaleBy keys and the placeholder sources): what `Environment.moduleParams`
 * needs to carry, and the only keys `quoteLinesForEnvironment` passes on.
 */
export function pricingParamKeys(dims: DimensionSet = PRICING_DIMENSION_SET): string[] {
  const keys = new Set<string>(Object.values(PARAM_SOURCES));
  for (const items of Object.values(dims.modules)) for (const it of items) if (it.scaleBy) keys.add(it.scaleBy.key);
  return [...keys].sort();
}

function cleanLine(l: QuoteLine): QuoteLine {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(l)) if (v !== undefined) out[k] = v;
  return out as unknown as QuoteLine;
}

/** Step 1: expand the request lines for one variant. */
export function expandLines(input: EstimateInput): Expanded[] {
  const dims = input.dims ?? PRICING_DIMENSION_SET;
  const fullProfile = input.purpose === 'START' || input.purpose === 'REUSE';
  const provisions = input.variant?.provisions ?? [];
  const base = provisions.find((p) => p.item === 'ec2');
  const labDefaults = { ...PARAM_DEFAULTS, ...(paramOf('InstanceType', base?.params, base?.set) ? { instanceType: paramOf('InstanceType', base?.params, base?.set)! } : {}) };
  const out: Expanded[] = [];
  for (const l of input.lines) {
    if (l.ref === 'start-profile') {
      const group: QuoteGroup = l.group === 'environment' ? 'environment' : 'start';
      for (const it of dims.base) out.push(fromItem(group, it, { ref: 'start-profile', base: true, defaults: labDefaults }));
      if (fullProfile) {
        for (const p of provisions) {
          if (p.kind !== 'module' || p.item === 'ec2') continue;
          for (const it of dims.modules[p.item] ?? []) out.push(fromItem(group, it, { ref: 'start-profile', module: p.item, defaults: labDefaults }, p.params, p.set));
        }
      }
    } else if (l.ref === 'workstation') {
      for (const it of dims.workstation) out.push(fromItem('workstation', it, { ref: 'workstation', defaults: { ...PARAM_DEFAULTS, instanceType: input.workstationInstanceType } }));
    } else if (l.ref === 'target-modules' || l.ref === 'target') {
      for (const tm of input.variant?.targetModules ?? []) {
        for (const it of dims.modules[tm.id] ?? []) out.push(fromItem('target', it, { ref: 'target-modules', module: tm.id, optional: !!tm.optional, defaults: labDefaults }, tm.params, tm.set));
      }
    } else if (l.ref === 'module' && l.key) {
      const items = dims.modules[l.key];
      if (!items) out.push({ line: cleanLine({ ...l, unknown: true, params: undefined }), item: null, params: {}, reason: `模块 ${l.key} 没有计费维度` });
      // the parameters the module was enabled with (recorded on the environment); absent → parameter-dependent items unknown
      const params = l.params && typeof l.params === 'object' ? l.params : null;
      for (const it of items ?? []) {
        if (!params && dependsOnModuleParams(it, dims)) {
          out.push({
            line: cleanLine({ group: l.group, ref: 'module', key: it.key, pricingKey: it.pricingKey, billing: it.billing, detail: [`模块 ${l.key}`, it.note ?? null].filter(Boolean).join(' · '), unknown: true }),
            item: null,
            params: {},
            reason: `环境没有记录模块 ${l.key} 的启用参数${it.scaleBy ? `（${it.scaleBy.key}）` : ''}，不按模板默认值估算`,
          });
          continue;
        }
        out.push(fromItem(l.group, it, { ref: 'module', module: l.key, defaults: labDefaults }, params ?? undefined));
      }
    } else if (l.ref === 'extra-stacks' || l.ref === 'extra-stack') {
      const stacks = (input.lab?.extraStacks ?? []) as { id?: string; title?: string }[];
      for (const st of stacks) {
        out.push({
          line: cleanLine({ group: 'extra-stack', ref: 'extra-stacks', key: `xstk-${st.id ?? 'stack'}`, service: '卡片自带栈', detail: st.title ?? st.id ?? '', unknown: true }),
          item: null,
          params: {},
          reason: '卡片自带栈的计费资源未从模板推导',
        });
      }
    } else if (l.pricingKey && l.billing && l.billing !== 'none' && l.billing !== 'storage') {
      out.push({
        line: cleanLine({ ...l }),
        item: {
          pricingKey: l.pricingKey,
          billing: l.billing,
          quantity: l.quantity ?? 1,
          ...(l.unit ? { unit: l.unit } : {}),
          ...(l.assumedUsagePerHour !== undefined ? { assumedUsagePerHour: l.assumedUsagePerHour } : {}),
          ...(l.whenRetained !== undefined ? { whenRetained: l.whenRetained } : {}),
          ...(l.optional ? { optional: true } : {}),
        },
        params: { ...labDefaults },
      });
    } else if (l.group === 'platform') {
      out.push({ line: cleanLine({ ...l }), item: null, params: {} });
    } else {
      out.push({ line: cleanLine({ ...l, unknown: true }), item: null, params: {}, reason: l.ref ? `未知的引用 ${l.ref}` : '没有计费维度' });
    }
  }
  return out;
}

/** Substitute `{placeholders}`; `null` when one has no value (→ unknown, never a guessed product). */
export function resolveFilters(filters: Record<string, string>, params: Record<string, string>, region: string): { filters: Record<string, string>; used: Record<string, string> } | { missing: string } {
  const values: Record<string, string | null | undefined> = { ...params, regionPrefix: USAGE_TYPE_PREFIX[region], edgeLocationGroup: edgeLocationGroup(region) };
  const out: Record<string, string> = {};
  const used: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    let missing: string | null = null;
    out[k] = v.replace(/\{([A-Za-z]+)\}/g, (_m, name: string) => {
      const x = values[name];
      if (x === undefined || x === null) {
        missing = name;
        return '';
      }
      used[name] = x;
      return x;
    });
    if (missing) return { missing };
  }
  return { filters: out, used };
}

function round(n: number): number {
  return Number(n.toPrecision(6));
}

/** Step 2: price the expanded items. */
export async function priceItems(items: Expanded[], book: PriceBook, region: string, dims: DimensionSet = PRICING_DIMENSION_SET): Promise<{ priced: Priced[]; errors: string[] }> {
  const errors: string[] = [];
  const priced = await Promise.all(
    items.map(async (x): Promise<Priced> => {
      const unknown = (reason: string): Priced => ({ ...x, line: { ...x.line, unknown: true }, reason, low: null, high: null, usage: false, entry: null });
      if (!x.item) return x.line.group === 'platform' ? { ...x, low: null, high: null, usage: false, entry: null } : unknown(x.reason ?? '没有计费维度');
      const dim = dims.dimensions[x.item.pricingKey];
      if (!dim) return unknown(`计费维度 ${x.item.pricingKey} 未登记`);
      if (x.item.billing === 'one-time') return { ...x, low: null, high: null, usage: false, entry: null };
      const r = resolveFilters(dim.filters, x.params, region);
      if ('missing' in r) return unknown(`缺少参数 ${r.missing}`);
      let entry: PriceEntry;
      try {
        entry = await book.price(x.item.pricingKey, dim, r.filters, r.used);
      } catch (e) {
        errors.push(`${x.item.pricingKey}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
        return unknown('Price List 调用失败');
      }
      if (!entry.found || entry.low === null || entry.high === null) return unknown('Price List 没有匹配的单价');
      const q = x.item.quantity;
      let factor: number;
      let usage = false;
      if (x.item.billing === 'hourly') factor = q;
      else if (x.item.billing === 'monthly') factor = q / HOURS_PER_MONTH;
      else {
        usage = true;
        if (x.item.unit && normalizeUnit(x.item.unit) !== normalizeUnit(dim.unit)) return unknown(`用量单位 ${x.item.unit} 与价格单位 ${dim.unit} 不一致`);
        factor = x.item.assumedUsagePerHour ?? 0;
      }
      const low = round(factor * entry.low);
      const high = round(factor * entry.high);
      return {
        ...x,
        line: {
          ...x.line,
          service: x.line.service ?? SERVICE_NAMES[dim.serviceCode] ?? dim.serviceCode,
          dimension: x.line.dimension ?? x.item.pricingKey,
          perHourLow: low,
          perHourHigh: usage ? round(high * USAGE_HIGH_FACTOR) : high,
          unitPrice: { low: entry.low, high: entry.high, unit: dim.unit, currency: 'USD' },
        } as QuoteLine,
        low,
        high,
        usage,
        entry,
      };
    }),
  );
  return { priced, errors };
}

export interface Range3 {
  low: number;
  typical: number;
  high: number;
}

function sum(items: Priced[]): Range3 | null {
  const known = items.filter((p) => p.low !== null && p.high !== null);
  if (!known.length) return null;
  let low = 0;
  let typical = 0;
  let high = 0;
  for (const p of known) {
    if (p.usage) {
      typical += p.low!;
      high += p.high! * USAGE_HIGH_FACTOR;
    } else {
      low += p.low!;
      typical += p.low!;
      high += p.high!;
    }
  }
  return { low: round(low), typical: round(typical), high: round(high) };
}

const START_GROUPS: readonly string[] = ['start', 'environment'];
const COMPLETED_GROUPS: readonly string[] = ['start', 'environment', 'target', 'extra-stack', 'step', 'monthly', 'usage'];

export interface Estimate extends Omit<PricedQuote, 'pricing'> {
  pricing: 'price-list' | 'fixture';
  retainHourlyRange: { low: number; high: number } | null;
  oneTime: QuoteLine[];
  pricePublication: string | null;
  errors: string[];
  /** Number of priced (non-unknown) items: 0 with errors means the Price List could not be used at all. */
  pricedItems: number;
}

/** Steps 2–3 for one variant. */
export async function estimate(input: EstimateInput, book: PriceBook, sourceKind: 'price-list' | 'fixture'): Promise<Estimate> {
  const dims = input.dims ?? PRICING_DIMENSION_SET;
  const expanded = expandLines(input);
  const { priced, errors } = await priceItems(expanded, book, input.region, dims);
  const required = priced.filter((p) => !p.line.optional);
  const start = sum(required.filter((p) => START_GROUPS.includes(p.line.group)));
  const completed = sum(required.filter((p) => COMPLETED_GROUPS.includes(p.line.group)));
  const ws = sum(priced.filter((p) => p.line.group === 'workstation'));
  const retained = required.filter((p) => COMPLETED_GROUPS.includes(p.line.group) && !p.usage && p.item?.whenRetained !== false && p.line.whenRetained !== false && p.low !== null);
  const retainRange = retained.length ? { low: round(retained.reduce((a, p) => a + p.low!, 0)), high: round(retained.reduce((a, p) => a + p.high!, 0)) } : null;
  const unknownLines = priced.filter((p) => p.line.unknown && p.line.group !== 'platform');
  const incomplete = [...new Set(unknownLines.map((p) => p.item?.pricingKey ?? p.line.pricingKey ?? (p.line.ref ? `ref:${p.line.ref}` : (p.line.key ?? p.line.service ?? 'unknown'))))];
  const entries = priced.map((p) => p.entry).filter((e): e is PriceEntry => !!e);
  const fetched = entries.map((e) => e.fetchedAt).sort();
  const publications = entries.map((e) => e.publication).filter((x): x is string => !!x).sort();
  const freeTierNote = priced.some((p) => p.item && dims.dimensions[p.item.pricingKey]?.freeTierNote);

  // maxSession: completed × (base + extensions) + start state during deploy / cleanup + workstation overhead
  let maxSession: { low: number; high: number } | null = null;
  if (input.purpose === 'KEEP') {
    const h = input.keepHours ?? input.durationMinutes / 60;
    maxSession = retainRange ? { low: round(retainRange.low * h), high: round(retainRange.high * h) } : null;
  } else if (completed) {
    const isStart = input.purpose === 'START' || input.purpose === 'REUSE';
    const cls = input.lab?.provision?.class;
    const deploy = isStart && cls ? (input.lab?.provision?.budgetMinutes ?? CLASS_BUDGETS[cls].deploy) : 0;
    const cleanup = isStart && cls ? Math.max(CLASS_BUDGETS[cls].cleanup, input.lab?.provision?.cleanupBudgetMinutes ?? 0) : 0;
    const run = input.maxTotalMinutes / 60;
    const side = (deploy + cleanup) / 60;
    const st = start ?? { low: 0, high: 0 };
    const wsr = ws ?? { low: 0, high: 0 };
    maxSession = {
      low: round(completed.low * run + st.low * side + wsr.low * (run + side)),
      high: round(completed.high * run + st.high * side + wsr.high * (run + side)),
    };
  }

  const notes: string[] = [];
  if (sourceKind === 'fixture') notes.push('开发模式：单价来自开发夹具，不是 AWS 价格，只用于界面联调');
  if (priced.some((p) => p.usage && p.low !== null)) notes.push(`按量计费项按卡片假设的用量折算到每小时（典型值），上界按 ${USAGE_HIGH_FACTOR} 倍用量计；不含免费额度`);
  if (priced.some((p) => p.line.optional)) notes.push('选做项不计入“完成后每小时”');
  if (unknownLines.length) notes.push(`有 ${unknownLines.length} 项单价暂不可得（显示“未知”），估算不完整，未按 0 计`);
  if (priced.some((p) => p.line.group === 'workstation')) notes.push('平台开销按工作台 EC2 计算；开始时选择省钱模式（CloudShell）则没有这部分');
  if (priced.some((p) => p.line.base)) notes.push('“基础”项是每张卡片都有的实验机与网络开销（目录的费用档位不计入，报价照常计入）');

  return {
    currency: 'USD',
    priceAsOf: fetched[0] ?? null,
    pricePublication: publications[publications.length - 1] ?? null,
    lines: priced.map((p) => cleanLine({ ...p.line, ...(p.line.unknown && p.reason ? { reason: p.reason } : {}) } as QuoteLine)),
    hourly: start || completed ? { start: start ?? null, completed: completed ?? null } : null,
    retainHourly: retainRange?.high ?? null,
    retainHourlyRange: retainRange,
    platformOverhead: {
      low: ws?.low ?? null,
      high: ws?.high ?? null,
      perHour: ws ? { low: ws.low, high: ws.high } : null,
      perSession: null,
      qualitative: [
        'CodeBuild 构建分钟：开始与结束各需数次构建（ARM 最小规格），尚无本平台的历史数据与 Price List 维度，不估金额',
        'Step Functions 状态转换、Lambda 调用与 CloudWatch Logs 摄入：通常很小，不估金额',
      ],
      notes: ['工作台实例、公有 IPv4 与 EBS 按小时计；构建与编排开销只作定性说明'],
    },
    maxSession,
    incomplete,
    freeTierNote,
    notes,
    oneTime: priced.filter((p) => p.item?.billing === 'one-time').map((p) => p.line),
    pricing: sourceKind,
    errors,
    pricedItems: priced.filter((p) => p.low !== null).length,
  } as Estimate;
}
