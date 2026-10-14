// backend/src/adapters/cost/estimate.ts —— cost 的本地实现：计费资源清单与（可选的）估算金额（06#cost 第 1 节）
//
// 文档把它写在 backend/src/services/cost-estimate.ts（总纲 §11）；services/ 是共享目录，本波放在 adapters/cost/ 下，由集成阶段决定是否搬移。
// 输入（只读）：
//   - 发布包内置的 registry（@cloudalbum/contracts 生成的 REGISTRY）：每个模块的 billing（resource、dimension、hourly），
//     以及 ec2 基础模块自己的 billing（实例、公网 IPv4、EBS…）；
//   - 有效 env：哪些模块已启用（开关取 AWS 值；本地档没有 AWS 费用，不进入清单）；
//   - /etc/cloudalbum/modules.state.json（scripts/module 维护）：enabledAt 与 history[]（本月的启停，用来算本月累计小时）；
//   - 可选的 cost-rates.yaml（COST_RATES_FILE，默认 <CLOUDALBUM_ENV_DIR>/cost-rates.yaml）：学员从官方定价页抄录的单价。
//     **项目不提供任何默认单价**（D14）：缺 source（https 官方定价页）或 retrievedAt、或 resource 与 registry billing.resource
//     对不上的条目不参与估算（CFG-010）；没有合格条目时只显示“未填写单价，不显示金额”。
// 输出：按小时计费的资源（逐行：资源、所属模块、已连续启用时长、本月累计小时）、按用量 / 请求计费的条目（“本机无法估算”）、
// 资源小时预算（COST_LOCAL_HOURS_BUDGET，度量“开了多久”，不涉及价格）、一行 detail（capabilities 与 /lab 顶栏）。
// 局限（对比点）：只知道经 scripts/module 启用的本项目模块，看不到手工资源、数据传输、请求类费用、税费与抵扣额度。
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { MODULE_IDS, type ModuleId } from '@cloudalbum/contracts';
import { REGISTRY, isEnabled, type Registry } from '../../modules/registry.js';

export interface BillingItem {
  /** 模块 id；平台模式的工作台计费维度记为 platform */
  module: ModuleId | 'platform';
  resource: string;
  dimension: 'hour' | 'usage' | 'request';
  hourly: boolean;
  quantity: number;
  /** 本次连续启用的起点（ec2 为实例启动时间） */
  enabledAt: string | null;
  runningHours: number | null;
  /** 本月（UTC）累计小时 */
  monthHours: number | null;
  amount?: { value: number; currency: string; rate: number; source: string; retrievedAt: string };
  note?: string;
}

export interface RateEntry { resource: string; unit: string; rate: number; source: string; retrievedAt: string }

export interface CostRates {
  file: string;
  currency: string;
  region?: string;
  qualified: RateEntry[];
  rejected: Array<{ resource: string; why: string }>;
  parseError?: string;
}

export interface ModuleStateFile {
  modules?: Record<string, { enabled?: boolean; driver?: string | null; enabledAt?: string | null; status?: string; at?: string }>;
  history?: Array<{ op?: string; module?: string; at?: string }>;
}

export interface CostEstimate {
  at: string;
  /** YYYY-MM（UTC） */
  month: string;
  items: BillingItem[];
  hourly: BillingItem[];
  usage: BillingItem[];
  resourceHoursMonth: number;
  amount?: { value: number; currency: string; items: number };
  hoursBudget?: { limit: number; used: number; pct: number; level: 'ok' | 'warn80' | 'over100' };
  rates: { file: string; present: boolean; qualified: number; rejected: Array<{ resource: string; why: string }>; parseError?: string };
  moduleState: 'present' | 'absent' | 'unreadable';
  /** 一行说明（capabilities.cost.detail / /lab 顶栏） */
  detail: string;
  /** 本地估算的输入是否都可读（localHealth） */
  inputsOk: boolean;
  problems: string[];
}

export interface EstimateInput {
  env: Readonly<Record<string, string | undefined>>;
  envDir: string;
  ratesFile?: string;
  hoursBudget?: number;
  now?: Date;
  /** 实例已运行的秒数（默认 os.uptime()；ec2 条目的“已开多久”） */
  uptimeSec?: number;
  /** 平台模式：加入工作台的计费维度（只有维度，不写金额） */
  platform?: boolean;
  /** 测试：直接给定 modules.state.json 内容（null = 不存在） */
  moduleState?: ModuleStateFile | null;
  registry?: Registry;
}

/** 平台工作台的计费维度（PM-M35：只写维度，不写金额；时长以平台为准） */
export const PLATFORM_ITEMS: ReadonlyArray<Pick<BillingItem, 'resource' | 'dimension' | 'hourly'>> = [
  { resource: '平台工作台 EC2 实例', dimension: 'hour', hourly: true },
  { resource: '平台工作台 公网 IPv4', dimension: 'hour', hourly: true },
  { resource: '平台工作台 EBS 卷', dimension: 'usage', hourly: false },
];

const HOUR = 3600_000;

/** registry 中全部 billing.resource（CFG-010 的对照表） */
export function knownBillingResources(registry: Registry = REGISTRY): Set<string> {
  return new Set(MODULE_IDS.flatMap((id) => (registry[id]?.billing ?? []).map((b) => b.resource)));
}

/** 读取并校验 cost-rates.yaml（不存在 → null）。接受文档格式 {currency, region, entries: [...]}，也兼容 rates: [...] 与顶层数组。 */
export function loadCostRates(file: string, registry: Registry = REGISTRY): CostRates | null {
  if (!existsSync(file)) return null;
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, currency: 'USD', qualified: [], rejected: [], parseError: (e as Error).message };
  }
  const obj = (doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}) as Record<string, unknown>;
  const list = Array.isArray(doc) ? doc : Array.isArray(obj.entries) ? obj.entries : Array.isArray(obj.rates) ? obj.rates : [];
  const known = knownBillingResources(registry);
  const qualified: RateEntry[] = [];
  const rejected: Array<{ resource: string; why: string }> = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    const resource = String(raw?.resource ?? '');
    const source = String(raw?.source ?? '');
    const retrievedAt = raw?.retrievedAt instanceof Date ? raw.retrievedAt.toISOString().slice(0, 10) : String(raw?.retrievedAt ?? '');
    const rate = typeof raw?.rate === 'number' ? raw.rate : Number(raw?.rate);
    const why = !known.has(resource) ? 'resource 与 registry billing.resource 对不上'
      : !/^https:\/\//.test(source) ? '缺少 source（官方定价页 URL）'
        : !/^\d{4}-\d{2}-\d{2}/.test(retrievedAt) ? '缺少 retrievedAt（抄录日期）'
          : !Number.isFinite(rate) || rate < 0 ? 'rate 不是数字' : '';
    if (why) rejected.push({ resource: resource || '(空)', why });
    else qualified.push({ resource, unit: String(raw.unit ?? 'hour'), rate, source, retrievedAt: retrievedAt.slice(0, 10) });
  }
  return {
    file, currency: typeof obj.currency === 'string' && obj.currency ? obj.currency : 'USD',
    ...(typeof obj.region === 'string' ? { region: obj.region } : {}), qualified, rejected,
  };
}

export function readModuleState(envDir: string): { state: ModuleStateFile | null; status: CostEstimate['moduleState'] } {
  const file = path.join(envDir, 'modules.state.json');
  if (!existsSync(file)) return { state: null, status: 'absent' };
  try {
    return { state: JSON.parse(readFileSync(file, 'utf8')) as ModuleStateFile, status: 'present' };
  } catch {
    return { state: null, status: 'unreadable' };
  }
}

function monthStartUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * 本月（UTC）内某模块处于启用状态的累计毫秒数：由 modules.state.json 的 history（enable / disable）重建时间线；
 * history 只保留最近 50 条，缺失时以 enabledAt 补齐。无法判断时返回 null。
 */
export function monthEnabledMs(id: string, state: ModuleStateFile | null, now: Date): number | null {
  if (!state) return null;
  const rec = state.modules?.[id];
  const t = (s?: string | null) => (s ? Date.parse(s) : NaN);
  const start = monthStartUtc(now);
  const end = now.getTime();
  const evs = (state.history ?? [])
    .filter((h) => h.module === id && (h.op === 'enable' || h.op === 'disable') && Number.isFinite(t(h.at)))
    .sort((a, b) => t(a.at) - t(b.at));
  const enabledAt = t(rec?.enabledAt ?? rec?.at ?? null);
  const enabledNow = rec?.enabled === true || rec?.status === 'enabled';
  if (!evs.length) {
    // 没有启停记录：只能按 enabledAt 推算
    if (!enabledNow) return 0;
    return Number.isFinite(enabledAt) ? Math.max(0, end - Math.max(start, enabledAt)) : null;
  }
  const before = evs.filter((e) => t(e.at) < start);
  const within = evs.filter((e) => t(e.at) >= start && t(e.at) <= end);
  // 月初的状态：月初之前最后一条记录；没有时，若本月第一条是 disable，说明月初已经启用
  let cur: number | null = null;
  if (before.length) cur = before[before.length - 1]!.op === 'enable' ? start : null;
  else if (within[0]?.op === 'disable') cur = start;
  let total = 0;
  for (const e of within) {
    if (e.op === 'enable' && cur === null) cur = t(e.at);
    else if (e.op === 'disable' && cur !== null) {
      total += t(e.at) - cur;
      cur = null;
    }
  }
  if (cur !== null) total += end - cur;
  return Math.max(0, total);
}

function shortName(resource: string): string {
  const i = resource.indexOf('（');
  return (i > 0 ? resource.slice(0, i) : resource).trim();
}

function fmtHours(h: number | null): string {
  if (h === null) return '时长未知';
  return h < 1 ? `${Math.round(h * 60)} 分钟` : `${Math.round(h * 10) / 10} 小时`;
}

export function estimateCost(input: EstimateInput): CostEstimate {
  const registry = input.registry ?? REGISTRY;
  const now = input.now ?? new Date();
  const ms = input.moduleState === undefined ? readModuleState(input.envDir) : { state: input.moduleState, status: input.moduleState ? 'present' as const : 'absent' as const };
  const ratesFile = input.ratesFile || path.join(input.envDir, 'cost-rates.yaml');
  const rates = loadCostRates(ratesFile, registry);
  const problems: string[] = [];
  if (ms.status === 'unreadable') problems.push('modules.state.json 不可读');
  if (rates?.parseError) problems.push(`cost-rates.yaml 解析失败：${rates.parseError}`);

  const items: BillingItem[] = [];
  const uptimeSec = input.uptimeSec ?? os.uptime();
  const bootAt = new Date(now.getTime() - uptimeSec * 1000);
  // ec2 基础模块：始终计费（实例、公网 IPv4、EBS…），已运行时长取实例启动以来的时间
  for (const b of registry.ec2?.billing ?? []) {
    const hourly = b.hourly === true;
    const monthStart = monthStartUtc(now);
    const monthMs = hourly ? now.getTime() - Math.max(monthStart, bootAt.getTime()) : null;
    items.push({
      module: 'ec2', resource: b.resource, dimension: b.dimension, hourly, quantity: 1,
      enabledAt: hourly ? bootAt.toISOString() : null, runningHours: hourly ? uptimeSec / 3600 : null,
      monthHours: monthMs === null ? null : monthMs / HOUR,
      ...(hourly ? { note: '自实例本次启动起（停机期间实例不计费，EIP 与 EBS 照常计费）' } : {}),
    });
  }
  for (const id of MODULE_IDS) {
    if (id === 'ec2' || !isEnabled(input.env, id, registry)) continue;
    const rec = ms.state?.modules?.[id];
    const enabledAtIso = rec?.enabledAt ?? rec?.at ?? null;
    const enabledAtMs = enabledAtIso ? Date.parse(enabledAtIso) : NaN;
    const monthMs = monthEnabledMs(id, ms.state, now);
    for (const b of registry[id]?.billing ?? []) {
      const hourly = b.hourly === true;
      items.push({
        module: id, resource: b.resource, dimension: b.dimension, hourly, quantity: 1,
        enabledAt: Number.isFinite(enabledAtMs) ? new Date(enabledAtMs).toISOString() : null,
        runningHours: hourly && Number.isFinite(enabledAtMs) ? Math.max(0, now.getTime() - enabledAtMs) / HOUR : null,
        monthHours: hourly && monthMs !== null ? monthMs / HOUR : null,
        ...(id === 'autoscaling' && hourly ? { note: '按 1 台计；实际按 ASG 期望容量计费' } : {}),
      });
    }
  }
  if (input.platform) {
    for (const p of PLATFORM_ITEMS) {
      items.push({ module: 'platform', ...p, quantity: 1, enabledAt: null, runningHours: null, monthHours: null, note: '平台工作台（不在本实验机上；时长以平台为准，不估算金额）' });
    }
  }

  // 金额：只对按小时计费、且有合格单价的条目（rate × 本月累计小时 × 数量）
  const byResource = new Map((rates?.qualified ?? []).filter((r) => r.unit === 'hour').map((r) => [r.resource, r]));
  let amountTotal = 0;
  let amountItems = 0;
  for (const it of items) {
    const r = byResource.get(it.resource);
    if (!r || !it.hourly || it.monthHours === null || it.module === 'platform') continue;
    const value = Math.round(r.rate * it.monthHours * it.quantity * 100) / 100;
    it.amount = { value, currency: rates!.currency, rate: r.rate, source: r.source, retrievedAt: r.retrievedAt };
    amountTotal += value;
    amountItems += 1;
  }

  const hourly = items.filter((i) => i.hourly);
  const usage = items.filter((i) => !i.hourly);
  const resourceHoursMonth = Math.round(hourly.filter((i) => i.module !== 'platform').reduce((a, i) => a + (i.monthHours ?? 0) * i.quantity, 0) * 10) / 10;
  let hoursBudget: CostEstimate['hoursBudget'];
  if (input.hoursBudget && input.hoursBudget > 0) {
    const pct = Math.round((resourceHoursMonth / input.hoursBudget) * 1000) / 10;
    hoursBudget = { limit: input.hoursBudget, used: resourceHoursMonth, pct, level: pct >= 100 ? 'over100' : pct >= 80 ? 'warn80' : 'ok' };
  }

  const list = hourly.filter((i) => i.module !== 'platform')
    .map((i) => `${shortName(i.resource)} ×${i.quantity}（${fmtHours(i.runningHours)}）`).join('、');
  const amountText = amountItems
    ? `估算 ${rates!.currency} ${Math.round(amountTotal * 100) / 100}（${amountItems} 项单价由学员抄录，注明了出处与日期；不是账单）`
    : rates ? 'cost-rates.yaml 中没有合格的按小时单价，不显示金额' : '未填写 cost-rates.yaml，不显示金额';
  const budgetText = hoursBudget ? ` · 资源小时预算 ${hoursBudget.used}/${hoursBudget.limit}（${hoursBudget.pct}%）` : '';
  const platformText = input.platform ? ' · 另有平台工作台的 EC2、EBS、公网 IPv4（不在清单中计时）' : '';
  const rejectedText = rates?.rejected.length ? ` · ${rates.rejected.length} 个单价条目未注明出处，不参与估算（CFG-010）` : '';
  const detail = `当前按小时计费的资源：${list || '无'}；${amountText}${budgetText}${platformText}${rejectedText}`;

  return {
    at: now.toISOString(), month: now.toISOString().slice(0, 7), items, hourly, usage, resourceHoursMonth,
    ...(amountItems ? { amount: { value: Math.round(amountTotal * 100) / 100, currency: rates!.currency, items: amountItems } } : {}),
    ...(hoursBudget ? { hoursBudget } : {}),
    rates: {
      file: ratesFile, present: Boolean(rates), qualified: rates?.qualified.length ?? 0, rejected: rates?.rejected ?? [],
      ...(rates?.parseError ? { parseError: rates.parseError } : {}),
    },
    moduleState: ms.status, detail, inputsOk: problems.length === 0, problems,
  };
}
