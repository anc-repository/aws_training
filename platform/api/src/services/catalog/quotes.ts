/**
 * Cost quotes — API layer (01 §7.3 `CostQuote`, §11.3; 02 §3.2, §5.4, §8.1, §10.1; 04 §3.4).
 *
 * `atl-api` builds the quote request from the card's `cost.basis` (computed lines: `ref` entries and explicit
 * `pricingKey` items), asks `atl-pricing` (synchronous, Price List + `PriceCache`) to price it, and stores the
 * `CostQuote` (15 minutes valid, `expiresAt`). No amount is ever invented here: when `atl-pricing` is not available the
 * quote keeps every line with `unknown: true`, `incomplete` lists the pricing keys, and the hourly ranges are `null`
 * (04 §3.4 “不允许静默按 0 计”).
 */
import { PortError, QUOTE_TTL_MINUTES, type QuotePurpose } from '@atl/shared';
import type { FunctionDeps } from '../../runtime/deps.js';
import { pricingParamKeys } from '../pricing/estimate.js';
import type { LabContent } from './store.js';
import type { ResolvedVariant } from './labs.js';

export type QuoteGroup = 'start' | 'target' | 'extra-stack' | 'step' | 'monthly' | 'usage' | 'platform' | 'workstation' | 'environment';

export interface QuoteLine {
  group: QuoteGroup;
  service?: string;
  dimension?: string;
  detail?: string;
  /** `cost.basis[].ref` entries are expanded by atl-pricing (start-profile, workstation, target-modules, extra-stacks). */
  ref?: string;
  key?: string;
  pricingKey?: string;
  billing?: 'hourly' | 'monthly' | 'usage' | 'one-time' | 'storage' | 'none';
  quantity?: number;
  unit?: string;
  assumedUsagePerHour?: number;
  optional?: boolean;
  whenRetained?: boolean;
  perHourLow?: number;
  perHourHigh?: number;
  unknown?: boolean;
  /** L0 base items of `ref: start-profile` (not counted in the catalog cost tier, 04 §3.4). */
  base?: boolean;
  /** Unit price the line was computed from (atl-pricing). */
  unitPrice?: { low: number; high: number; unit: string; currency: string } | null;
  /** Why an `unknown` line has no price (atl-pricing). */
  reason?: string;
  /**
   * `ref: module` (EXTEND / KEEP): the parameters the environment recorded for that module (`Environment.moduleParams`,
   * only the keys atl-pricing reads). Absent = not recorded → atl-pricing marks the parameter-dependent items unknown.
   */
  params?: Record<string, string>;
}

export interface Range {
  low: number;
  high: number;
  typical?: number;
}

export interface PricedQuote {
  currency: string;
  priceAsOf: string | null;
  lines: QuoteLine[];
  hourly: { start: Range | null; completed: Range | null } | null;
  retainHourly: number | null;
  /**
   * 08 §9.2 #6: `perHour` (workstation EC2, public IPv4, EBS), `perSession` (CodeBuild; `null` until priced),
   * `qualitative[]`; `low` / `high` repeat `perHour` for older readers.
   */
  platformOverhead: {
    low: number | null;
    high: number | null;
    notes: string[];
    perHour?: { low: number; high: number } | null;
    perSession?: { low: number; high: number; basis: 'history' | 'class' } | null;
    qualitative?: string[];
  };
  maxSession: Range | null;
  incomplete: string[];
  freeTierNote: boolean;
  notes: string[];
  /** `fixture` = dev-mode prices that are not AWS prices (atl-pricing in ATL_DEV_MODE). */
  pricing: 'price-list' | 'fixture' | 'unavailable';
  retainHourlyRange?: { low: number; high: number } | null;
  pricePublication?: string | null;
  oneTime?: QuoteLine[];
}

const PLATFORM_OVERHEAD_LINE: QuoteLine = {
  group: 'platform',
  service: '平台开销',
  dimension: '工作台实例与公有 IPv4、EBS；CodeBuild 构建分钟；Step Functions、Lambda 与日志摄入',
  detail: '每次会话的固定开销（01 §11.3），后几项通常很小，不估金额',
  billing: 'usage',
};

const GROUP_OF_SOURCE: Record<string, QuoteGroup> = {
  'start-profile': 'start',
  workstation: 'workstation',
  target: 'target',
  'target-modules': 'target',
  'learner-created': 'step',
  'extra-stack': 'extra-stack',
  'extra-stacks': 'extra-stack',
  platform: 'platform',
};

/** Lines of a START / REUSE quote from `cost.basis` (04 §3.2 `LabCost`). */
export function quoteLinesFromLab(lab: LabContent): QuoteLine[] {
  const lines: QuoteLine[] = [];
  for (const it of lab.cost?.basis ?? []) {
    if ('ref' in it) {
      lines.push({ group: GROUP_OF_SOURCE[it.ref] ?? 'start', ref: it.ref, ...(it.note ? { detail: it.note } : {}) });
    } else {
      lines.push({
        group: it.billing === 'monthly' ? 'monthly' : it.billing === 'usage' ? 'usage' : (GROUP_OF_SOURCE[it.source] ?? 'start'),
        key: it.key,
        pricingKey: it.pricingKey,
        billing: it.billing,
        quantity: it.quantity,
        ...(it.unit ? { unit: it.unit } : {}),
        ...(it.assumedUsagePerHour !== undefined ? { assumedUsagePerHour: it.assumedUsagePerHour } : {}),
        ...(it.optional ? { optional: true } : {}),
        ...(it.whenRetained !== undefined ? { whenRetained: it.whenRetained } : {}),
        ...(it.note ? { detail: it.note } : {}),
      });
    }
  }
  lines.push({ ...PLATFORM_OVERHEAD_LINE });
  return lines;
}

/**
 * The pricing-relevant parameters `Environment.moduleParams[module]` recorded for an enabled module (`NETWORK_NAT_MODE`,
 * `MultiAz`, `DbInstanceClass`, …; scalar values only, other keys dropped so nothing else of the stack reaches a quote).
 * `null` when the environment has no record for the module.
 */
export function recordedModuleParams(env: Record<string, unknown> | null, moduleId: string): Record<string, string> | null {
  const all = env?.moduleParams;
  if (!all || typeof all !== 'object') return null;
  const rec = (all as Record<string, unknown>)[moduleId];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const keys = new Set(pricingParamKeys());
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    if (keys.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out[k] = String(v);
  }
  return out;
}

/** Lines of an EXTEND / KEEP quote: the environment as it is now (02 §5.4: enabled modules, card stacks, manual resources). */
export function quoteLinesForEnvironment(env: Record<string, unknown> | null, hourlyResources: { resourceType?: string; name?: string; billing?: string }[]): QuoteLine[] {
  const lines: QuoteLine[] = [{ group: 'environment', ref: 'start-profile', detail: '实验机、EBS 与公有 IPv4' }];
  for (const m of (Array.isArray(env?.enabledModules) ? env.enabledModules : []) as string[]) {
    const params = recordedModuleParams(env, String(m));
    lines.push({ group: 'environment', ref: 'module', key: String(m), detail: `模块 ${String(m)}`, ...(params ? { params } : {}) });
  }
  for (const r of hourlyResources) {
    lines.push({ group: 'step', service: r.resourceType ?? '手工资源', detail: r.name ?? '', billing: (r.billing as QuoteLine['billing']) ?? 'hourly', unknown: true });
  }
  return lines;
}

export interface PriceRequest {
  purpose: QuotePurpose;
  region: string;
  labId: string;
  labVersion: string;
  catalogVersion: string;
  variant: string;
  /** Preflight alternatives: atl-pricing prices both and keeps the costlier (02 §3.2). */
  alternativeVariants?: string[];
  lines: QuoteLine[];
  durationMinutes: number;
  maxTotalMinutes: number;
  envId?: string | null;
  keepHours?: number;
}

let pricingWarned = false;

/** Ask atl-pricing to price the lines; degrade to an explicit “price unavailable” quote when it cannot. */
export async function priceQuote(deps: FunctionDeps, req: PriceRequest): Promise<PricedQuote> {
  try {
    const r = await deps.ports.invoker.invoke<Partial<PricedQuote> | null>('atl-pricing', { action: 'PriceQuote', ...req });
    if (r && Array.isArray(r.lines)) {
      return {
        currency: r.currency ?? 'USD',
        priceAsOf: r.priceAsOf ?? null,
        lines: r.lines,
        hourly: r.hourly ?? null,
        retainHourly: r.retainHourly ?? null,
        platformOverhead: r.platformOverhead ?? { low: null, high: null, notes: [] },
        maxSession: r.maxSession ?? null,
        incomplete: r.incomplete ?? [],
        freeTierNote: !!r.freeTierNote,
        notes: r.notes ?? [],
        pricing: r.pricing === 'fixture' ? 'fixture' : 'price-list',
        ...(r.retainHourlyRange !== undefined ? { retainHourlyRange: r.retainHourlyRange } : {}),
        ...(r.pricePublication !== undefined ? { pricePublication: r.pricePublication } : {}),
        ...(r.oneTime?.length ? { oneTime: r.oneTime } : {}),
      };
    }
  } catch (e) {
    if (!isPricingUnavailable(e)) throw e;
    if (!pricingWarned) console.warn(JSON.stringify({ level: 'warn', msg: 'atl-pricing unavailable, quotes carry no prices', error: String(e) }));
    pricingWarned = true;
  }
  return unpricedQuote(req.lines);
}

function isPricingUnavailable(e: unknown): boolean {
  if (e instanceof PortError) return e.code === 'NotImplemented' || e.code === 'NotFound' || e.code === 'Unavailable' || e.code === 'Throttled';
  const name = (e as { name?: string } | null)?.name ?? '';
  return name === 'Atl.NotImplemented' || name === 'Atl.PricingUnavailable' || name === 'ResourceNotFoundException';
}

export function unpricedQuote(lines: QuoteLine[]): PricedQuote {
  const incomplete = [...new Set(lines.filter((l) => l.group !== 'platform').map((l) => l.pricingKey ?? (l.ref ? `ref:${l.ref}` : l.key ?? l.service ?? 'unknown')))];
  return {
    currency: 'USD',
    priceAsOf: null,
    lines: lines.map((l) => ({ ...l, unknown: true })),
    hourly: null,
    retainHourly: null,
    platformOverhead: { low: null, high: null, perHour: null, perSession: null, qualitative: ['Step Functions、Lambda 与日志摄入通常很小，不估金额'], notes: ['通常很小，不估金额'] },
    maxSession: null,
    incomplete,
    freeTierNote: false,
    notes: ['单价暂不可得：atl-pricing 未返回价格，估算不完整；金额以 AWS 官方定价与账单为准'],
    pricing: 'unavailable',
  };
}

export function quoteExpiresAt(nowMs: number): string {
  return new Date(nowMs + QUOTE_TTL_MINUTES * 60_000).toISOString();
}

export const QUOTE_DISCLAIMER = '估算值，不含数据传输与按请求计费部分，以 AWS 官方定价与账单为准';

/** Public view of a stored quote (no storage attributes). */
export function quoteView(q: Record<string, unknown>): Record<string, unknown> {
  const { PK: _pk, SK: _sk, ttl: _ttl, type: _type, ver: _ver, sub: _sub, ...rest } = q;
  return { ...rest, disclaimer: QUOTE_DISCLAIMER };
}

export type { ResolvedVariant };
