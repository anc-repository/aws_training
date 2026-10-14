/**
 * 简介页“开始实验”按钮与开始对话框（P03-D）的纯函数，表驱动测试见 startModel.test.ts：
 * - startModel：由 `GET /labs/{labId}` 的 startability（权威，05 §7.1、08 P03 表）+ 本地预判（当前会话、维护 / 卸载 / 预算、
 *   残留策略 ack / block / ignore，08 §9.2 #26）得出按钮形态与原因；
 * - 学员输入的即时校验（05 §7.1 规则表；服务端仍按 RE2 模式权威校验）；
 * - 报价明细行（08 P03-D：平台开销拆成工作台 / 构建 / 编排与日志三行；§9.2 #6 回写前缺的字段显示“未提供”）。
 * 金额只取自服务端报价（Price List），这里不出现任何价格常量。
 */
import type { BudgetState, PlatformMode } from '@atl/shared';
import type { SessionView } from '../../api/types';
import type { Role } from '../../auth/jwt';
import { msg, t } from '../../i18n';
import { formatClock } from '../../lib/format';
import type { CardStatus, CostQuote, LabDetail, QuoteLine, Range, StartReason } from '../labs/types';
import { SS } from './strings';

export type ResidualPolicy = 'ack' | 'block' | 'ignore';

export interface StartInput {
  role: Role | null;
  labId: string;
  cardStatus: CardStatus | null | undefined;
  /** 个人部分；null + failed=false 表示加载中。 */
  detail: LabDetail | null;
  detailFailed: boolean;
  current: Pick<SessionView, 'sessionId' | 'labId' | 'state' | 'deadlineAt' | 'cleanup'> | null;
  platform: { mode?: PlatformMode | null; maintenance?: boolean } | null;
  budget: { state?: BudgetState | null; blocksStart?: boolean } | null;
  residualPolicy: ResidualPolicy;
  /** 按小时计费的 BLOCKING 残留条数（GET /resources/manual）。 */
  residualHourly: number;
}

export interface BlockedLink {
  to: string;
  label: string;
}

export type StartModel =
  | { kind: 'hidden'; note: 'role' | 'planned' | 'deprecated' }
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'holder'; to: string }
  | { kind: 'blocked'; code: string; text: string; link?: BlockedLink }
  | { kind: 'kept'; compatible: boolean; reasonText: string | null; reuseEnvId: string | null; fromLabId: string | null; sessionId: string | null }
  | { kind: 'start'; residual: 'ack' | 'info' | null };

const LIVE = ['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING'];

function activeText(cur: StartInput['current'], reason: StartReason | undefined): string {
  const labId = cur?.labId ?? (typeof reason?.labId === 'string' ? reason.labId : null) ?? reason?.detail ?? '—';
  const when = cur?.deadlineAt ? t(SS.start.until, { t: formatClock(cur.deadlineAt) }) : SS.start.preparing;
  return t(SS.start.activeExists, { labId, when });
}

export function startModel(i: StartInput): StartModel {
  if (i.role !== 'L') return { kind: 'hidden', note: 'role' };
  if (i.cardStatus === 'planned') return { kind: 'hidden', note: 'planned' };
  if (i.cardStatus === 'deprecated') return { kind: 'hidden', note: 'deprecated' };
  const cur = i.current;
  if (cur && cur.labId === i.labId && LIVE.includes(cur.state)) return { kind: 'holder', to: `/workspace/${cur.sessionId}` };
  if (!i.detail) return i.detailFailed ? { kind: 'unknown' } : { kind: 'loading' };
  const reasons = i.detail.startability.reasons ?? [];
  const has = (code: string) => reasons.find((r) => r.code === code);
  if (has('LAB_PLANNED')) return { kind: 'hidden', note: 'planned' };
  if (has('LAB_DEPRECATED')) return { kind: 'hidden', note: 'deprecated' };
  if (i.platform?.mode === 'UNINSTALLING' || has('PLATFORM_UNINSTALLING')) return { kind: 'blocked', code: 'PLATFORM_UNINSTALLING', text: SS.start.uninstalling };
  if (i.platform?.maintenance || has('MAINTENANCE_MODE')) return { kind: 'blocked', code: 'MAINTENANCE_MODE', text: SS.start.maintenance, link: { to: '/settings/guardrails', label: SS.start.viewSettings } };
  if (has('BUDGET_BLOCKED') || (i.budget?.state === 'EXCEEDED' && i.budget.blocksStart)) {
    return { kind: 'blocked', code: 'BUDGET_BLOCKED', text: SS.start.budget, link: { to: '/settings/guardrails', label: SS.start.viewGuardrails } };
  }
  const active = has('SESSION_ACTIVE_EXISTS');
  const curLive = cur && LIVE.includes(cur.state) && cur.labId !== i.labId;
  if (active || curLive) {
    const sid = cur && curLive ? cur.sessionId : (active?.sessionId ?? null);
    return { kind: 'blocked', code: 'SESSION_ACTIVE_EXISTS', text: activeText(curLive ? cur : null, active), ...(sid ? { link: { to: `/workspace/${sid}`, label: SS.start.toWorkspace } } : {}) };
  }
  const cleaning = has('CLEANUP_IN_PROGRESS');
  if (cleaning || (cur && (cur.state === 'CLEANING' || cur.state === 'ENDING'))) {
    const sid = cur && (cur.state === 'CLEANING' || cur.state === 'ENDING') ? cur.sessionId : (cleaning?.sessionId ?? null);
    const c = cur?.cleanup;
    const count = c && typeof c.deleted === 'number' && typeof c.total === 'number' ? t(SS.start.deleted, { n: c.deleted, m: c.total }) : '';
    return { kind: 'blocked', code: 'CLEANUP_IN_PROGRESS', text: t(SS.start.cleaning, { count }), ...(sid ? { link: { to: `/sessions/${sid}/end`, label: SS.start.viewProgress } } : {}) };
  }
  const reuseBusy = has('REUSE_IN_PROGRESS');
  if (reuseBusy) return { kind: 'blocked', code: 'REUSE_IN_PROGRESS', text: SS.start.reuseBusy };
  const kept = has('ENV_KEPT_EXISTS');
  const reuse = i.detail.startability.reuse;
  if (kept || reuse || cur?.state === 'KEPT') {
    const compatible = !!reuse?.compatible;
    const reasonText = !compatible ? (reuse?.reason === 'TARGET_ALREADY_SATISFIED' ? SS.start.targetSatisfied : SS.start.incompatible) : null;
    return {
      kind: 'kept',
      compatible,
      reasonText,
      reuseEnvId: reuse?.environmentId ?? (typeof kept?.envId === 'string' ? kept.envId : null),
      fromLabId: reuse?.fromLabId ?? (cur?.state === 'KEPT' ? cur.labId : null),
      sessionId: reuse?.sessionId ?? kept?.sessionId ?? (cur?.state === 'KEPT' ? cur.sessionId : null),
    };
  }
  const hard = has('HARD_PREREQ_UNMET');
  if (hard) {
    const pre = typeof hard.labId === 'string' ? hard.labId : null;
    return { kind: 'blocked', code: 'HARD_PREREQ_UNMET', text: hard.detail ?? SS.start.hardPrereq, ...(pre ? { link: { to: `/labs/${pre}`, label: pre } } : {}) };
  }
  const residual = has('RESIDUAL_ACK_REQUIRED') ?? has('RESIDUAL_BLOCKING');
  if (residual) {
    if (residual.ackable === true || (residual.ackable === undefined && i.residualPolicy === 'ack')) return { kind: 'start', residual: 'ack' };
    return { kind: 'blocked', code: 'RESIDUAL_BLOCKING', text: SS.start.residualBlock, link: { to: '/resources/manual', label: SS.start.handleResidual } };
  }
  if (i.residualHourly > 0) {
    if (i.residualPolicy === 'block') return { kind: 'blocked', code: 'RESIDUAL_BLOCKING', text: SS.start.residualBlock, link: { to: '/resources/manual', label: SS.start.handleResidual } };
    if (i.residualPolicy === 'ignore') return { kind: 'start', residual: 'info' };
    return { kind: 'start', residual: 'ack' };
  }
  const other = reasons.find((r) => r.ackable !== true);
  if (other) return { kind: 'blocked', code: other.code, text: other.detail ?? other.code };
  return { kind: 'start', residual: null };
}

// ---------------------------------------------------------------------------------------------------------------
// 学员输入的即时校验（05 §7.1）

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function isDomain(v: string): boolean {
  if (!v || v.length > 253 || v !== v.toLowerCase()) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v) || v.includes('*')) return false;
  const parts = v.split('.');
  return parts.length >= 2 && parts.every((p) => LABEL.test(p)) && /[a-z]/.test(parts[parts.length - 1]!);
}

export function isEmail(v: string): boolean {
  return EMAIL.test(v) && v.length <= 254;
}

/** 返回错误文案；合法时 null。`cost-tags-active` 的值是 'true'（复选框）。 */
export function validateInput(id: string, raw: string, required: boolean): string | null {
  const v = raw.trim();
  if (!v) return required ? SS.inputs.required : null;
  switch (id) {
    case 'domain':
      return isDomain(v) ? null : SS.inputs.domain;
    case 'hosted-zone':
      return /^Z[0-9A-Z]{4,32}$/.test(v) ? null : SS.inputs.hostedZone;
    case 'ses-identity':
      return isEmail(v) || isDomain(v) ? null : SS.inputs.sesIdentity;
    case 'notify-email':
    case 'alert-email':
      return isEmail(v) ? null : SS.inputs.email;
    case 'recipient-emails': {
      const list = v.split(',').map((x) => x.trim()).filter(Boolean);
      return list.length >= 1 && list.length <= 2 && list.every(isEmail) ? null : SS.inputs.recipients;
    }
    case 'budget-amounts': {
      const list = v.split(',').map((x) => x.trim());
      return list.length === 2 && list.every((x) => /^\d{1,9}(?:\.\d{1,2})?$/.test(x) && Number(x) > 0) ? null : SS.inputs.budget;
    }
    case 'cost-tags-active':
      return v === 'true' ? null : SS.inputs.costTags;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 报价明细（P03-D 费用段落）

export type Amount = { kind: 'range'; low: number; high: number; unit: string } | { kind: 'text'; text: string };

export interface QuoteRowView {
  key: string;
  label: string;
  desc: string;
  amount: Amount;
}

/** 金额：保留与数量级相称的小数位；货币为 USD 时写 `$`。只用于显示服务端报价，不出现价格常量。 */
export function formatMoney(n: number, currency = 'USD'): string {
  const abs = Math.abs(n);
  const s = abs >= 100 ? n.toFixed(0) : abs >= 1 ? n.toFixed(2) : abs >= 0.01 ? n.toFixed(3) : n.toFixed(4);
  return currency === 'USD' ? `$${s}` : `${s} ${currency}`;
}

export function amountText(a: Amount, currency = 'USD'): string {
  if (a.kind === 'text') return a.text;
  return t(msg.pages.card.range, { low: formatMoney(a.low, currency), high: formatMoney(a.high, currency), unit: a.unit });
}

/** 报价行的引用 → 说明的键（在使用时取文案：切换语言后取到新语言）。 */
const REF_KEY: Readonly<Record<string, 'refStart' | 'refWorkstation' | 'refTarget' | 'refExtra' | 'refModule'>> = {
  'start-profile': 'refStart',
  workstation: 'refWorkstation',
  'target-modules': 'refTarget',
  target: 'refTarget',
  'extra-stacks': 'refExtra',
  'extra-stack': 'refExtra',
  module: 'refModule',
};

export function lineText(l: QuoteLine): string {
  const parts = [l.service, l.dimension, l.detail].filter((x): x is string => !!x && !!x.trim());
  if (parts.length) return parts.join(' · ');
  if (l.ref) return REF_KEY[l.ref] ? SS.quote[REF_KEY[l.ref]!] : l.ref;
  return l.pricingKey ?? l.key ?? '—';
}

function isRange(r: unknown): r is Range {
  return !!r && typeof (r as Range).low === 'number' && typeof (r as Range).high === 'number';
}

/** 报价是否有未估算的部分（单价暂不可得）：需要额外勾选“我了解有未估算的费用”（02 §10.1）。 */
export function quoteHasUnknown(q: CostQuote): boolean {
  return q.pricing === 'unavailable' || (q.incomplete ?? []).length > 0 || (q.lines ?? []).some((l) => l.unknown && l.group !== 'platform');
}

export interface QuoteRowsOptions {
  workstation: 'ec2' | 'cloudshell';
  reuse: boolean;
  limitMinutes: number;
  extensions: { count: number; minutes: number };
}

export function quoteRows(q: CostQuote, o: QuoteRowsOptions): QuoteRowView[] {
  const lines = q.lines ?? [];
  const missing = (): Amount => ({ kind: 'text', text: q.pricing === 'unavailable' ? SS.quote.unknown : SS.quote.notProvided });
  const range = (r: unknown, unit: string): Amount => (isRange(r) ? { kind: 'range', low: r.low, high: r.high, unit } : missing());
  const of = (...groups: string[]) => lines.filter((l) => groups.includes(l.group));
  const join = (ls: QuoteLine[], fallback: string) => (ls.length ? ls.map(lineText).join(' · ') : fallback);
  const rows: QuoteRowView[] = [];
  rows.push({ key: 'start', label: SS.quote.start, desc: join(of('start', 'environment'), SS.quote.startDefault) + (o.reuse ? SS.quote.reuseSuffix : ''), amount: range(q.hourly?.start, SS.quote.perHour) });
  const target = of('target', 'extra-stack', 'step');
  rows.push({ key: 'completed', label: SS.quote.completed, desc: `+ ${join(target, SS.quote.targetDefault)}`, amount: range(q.hourly?.completed, SS.quote.perHour) });
  const usage = of('usage');
  if (usage.length) rows.push({ key: 'usage', label: SS.quote.usage, desc: `${join(usage, '')}${SS.quote.usageTail}`, amount: { kind: 'text', text: SS.quote.noEstimate } });
  const monthly = of('monthly');
  if (monthly.length) rows.push({ key: 'monthly', label: SS.quote.monthly, desc: join(monthly, ''), amount: { kind: 'text', text: SS.quote.noEstimate } });
  const po = q.platformOverhead ?? null;
  const perHour = po?.perHour ?? (po && typeof po.low === 'number' && typeof po.high === 'number' ? { low: po.low, high: po.high } : null);
  rows.push(
    o.workstation === 'ec2'
      ? { key: 'workstation', label: SS.quote.workstation, desc: SS.quote.workstationDesc, amount: range(perHour, SS.quote.perHour) }
      : { key: 'workstation', label: SS.quote.workstation, desc: SS.quote.workstationSaving, amount: { kind: 'text', text: '—' } },
  );
  rows.push({ key: 'build', label: SS.quote.build, desc: SS.quote.buildDesc, amount: isRange(po?.perSession) ? range(po?.perSession, SS.quote.perRun) : { kind: 'text', text: SS.quote.notProvided } });
  rows.push({ key: 'orchestration', label: SS.quote.orchestration, desc: po?.qualitative?.length ? po.qualitative.join(msg.pages.card.listSep) : SS.quote.orchestrationDesc, amount: { kind: 'text', text: SS.quote.noEstimate } });
  rows.push({ key: 'deploy', label: SS.quote.deploy, desc: SS.quote.deployDesc, amount: { kind: 'text', text: '—' } });
  const maxMin = q.maxTotalMinutes ?? o.limitMinutes + o.extensions.count * o.extensions.minutes;
  rows.push({
    key: 'max',
    label: SS.quote.max,
    desc: t(SS.quote.maxDesc, { n: o.extensions.count, total: t(msg.pages.card.hours, { n: (maxMin / 60).toFixed(1).replace(/\.0$/, '') }) }),
    amount: range(q.maxSession, ''),
  });
  return rows;
}

/** 主按钮上的“预计 ≈ a～b/小时”（起始状态每小时）；没有金额时不写。 */
export function primaryEstimate(q: CostQuote | null): string | null {
  const r = q?.hourly?.start ?? q?.hourly?.completed ?? null;
  return isRange(r) ? amountText({ kind: 'range', low: r.low, high: r.high, unit: SS.quote.perHour }, q?.currency) : null;
}
