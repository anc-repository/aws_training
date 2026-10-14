/**
 * 目录的纯函数（05 §2.3～§2.11；08 P02、P02-T、P10），表驱动测试见 model.test.ts：
 * - 查询串 ⇄ 目录状态（视图、分组、排序、搜索、7 个筛选维度 + 2 个开关，05 §2.7）；
 * - 卡片状态（05 §2.9：从上到下取第一个满足的）；
 * - 筛选、计数（“其他维度不变时选中该取值后的结果数”）、搜索（含原 Lab 编号）、排序、分组；
 * - 路径进度与证书条件的浏览器侧预判（tracks-and-catalog §5.5，与 platform/api trackProgress 同一规则；以服务端为准）；
 * - 推荐下一步 recommendNext（05 §2.11）。
 */
import type { SessionState } from '@atl/shared';
import { formatClock, formatCountdown } from '../../lib/format';
import type { CostTier, ShapeName, Tone } from '../../ui';
import { FLAG_ORDER, S } from './strings';
import type {
  BadgeView,
  CardKind,
  CatalogCard,
  CatalogIndex,
  Difficulty,
  LabItem,
  LabProgressStatus,
  SaaDomain,
  ServiceCellDef,
  Taxonomy,
  TaxonomyService,
  TrackDef,
} from './types';
import { fmtPercent, msg, t } from '../../i18n';

const PL = msg.pages.labs;

// ---------------------------------------------------------------------------------------------------------------
// 查询串（05 §2.7：kind、svc、dom、primary、d、dur、cost、st、nomanual、view、track、group、sort、q、cell）

export type CatalogView = 'grid' | 'map' | 'tracks';
export type CatalogGroup = 'kind' | 'category' | 'domain' | 'none';
export type CatalogSort = 'path' | 'duration' | 'cost' | 'recent';
export type StatusGroup = 'not_started' | 'in_progress' | 'completed' | 'incomplete';
export type DurationBucket = 'short' | 'medium' | 'long';

export interface CatalogQuery {
  view: CatalogView;
  group: CatalogGroup;
  sort: CatalogSort;
  q: string;
  kind: CardKind[];
  svc: string[];
  dom: SaaDomain[];
  primary: boolean;
  d: Difficulty[];
  dur: DurationBucket[];
  cost: CostTier[];
  st: StatusGroup[];
  nomanual: boolean;
  cell: string | null;
  track: string | null;
}

export const FACET_VALUES = {
  kind: ['service', 'scenario'] as const,
  dom: ['secure', 'resilient', 'performance', 'cost'] as const,
  d: ['intro', 'beginner', 'intermediate', 'advanced'] as const,
  dur: ['short', 'medium', 'long'] as const,
  cost: ['low', 'medium', 'high'] as const,
  st: ['not_started', 'in_progress', 'completed', 'incomplete'] as const,
};
export type FacetKey = keyof typeof FACET_VALUES;
export const FACET_KEYS: readonly FacetKey[] = ['kind', 'dom', 'd', 'dur', 'cost', 'st'];

const VIEWS: readonly CatalogView[] = ['grid', 'map', 'tracks'];
const GROUPS: readonly CatalogGroup[] = ['kind', 'category', 'domain', 'none'];
const SORTS: readonly CatalogSort[] = ['path', 'duration', 'cost', 'recent'];

/** 查询串中属于目录状态的参数（URL 中有任一项时以 URL 为准，否则恢复 localStorage 中上次的组合，05 §2.7 规则 4）。 */
export const CATALOG_PARAMS = ['view', 'group', 'sort', 'q', 'kind', 'svc', 'dom', 'primary', 'd', 'dur', 'cost', 'st', 'nomanual', 'cell', 'track'] as const;

export function emptyQuery(defaults: Partial<Pick<CatalogQuery, 'view' | 'group' | 'sort'>> = {}): CatalogQuery {
  return {
    view: defaults.view ?? 'grid',
    group: defaults.group ?? 'kind',
    sort: defaults.sort ?? 'path',
    q: '',
    kind: [],
    svc: [],
    dom: [],
    primary: false,
    d: [],
    dur: [],
    cost: [],
    st: [],
    nomanual: false,
    cell: null,
    track: null,
  };
}

function list<T extends string>(v: string | null, allowed?: readonly T[]): T[] {
  if (!v) return [];
  const out = v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean) as T[];
  const uniq = [...new Set(out)];
  return allowed ? uniq.filter((x) => allowed.includes(x)) : uniq;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function parseCatalogQuery(sp: URLSearchParams, defaults: Partial<Pick<CatalogQuery, 'view' | 'group' | 'sort'>> = {}): CatalogQuery {
  const base = emptyQuery(defaults);
  const pick = <T extends string>(k: string, allowed: readonly T[], fallback: T): T => {
    const v = sp.get(k) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  };
  const cell = sp.get('cell');
  const track = sp.get('track');
  return {
    view: pick('view', VIEWS, base.view),
    group: pick('group', GROUPS, base.group),
    sort: pick('sort', SORTS, base.sort),
    q: (sp.get('q') ?? '').slice(0, 80),
    kind: list(sp.get('kind'), FACET_VALUES.kind),
    svc: list<string>(sp.get('svc')).filter((x) => SLUG.test(x)),
    dom: list(sp.get('dom'), FACET_VALUES.dom),
    primary: sp.get('primary') === '1',
    d: list(sp.get('d'), FACET_VALUES.d),
    dur: list(sp.get('dur'), FACET_VALUES.dur),
    cost: list(sp.get('cost'), FACET_VALUES.cost),
    st: list(sp.get('st'), FACET_VALUES.st),
    nomanual: sp.get('nomanual') === '1',
    cell: cell && SLUG.test(cell) ? cell : null,
    track: track && SLUG.test(track) ? track : null,
  };
}

/** 只写出与默认值不同的参数（可分享、可后退）。 */
export function serializeCatalogQuery(q: CatalogQuery, defaults: Partial<Pick<CatalogQuery, 'view' | 'group' | 'sort'>> = {}): URLSearchParams {
  const d = emptyQuery(defaults);
  const sp = new URLSearchParams();
  if (q.view !== d.view) sp.set('view', q.view);
  if (q.view === 'tracks' && q.track) sp.set('track', q.track);
  if (q.view === 'map' && q.cell) sp.set('cell', q.cell);
  if (q.group !== d.group) sp.set('group', q.group);
  if (q.sort !== d.sort) sp.set('sort', q.sort);
  if (q.q.trim()) sp.set('q', q.q);
  for (const k of ['kind', 'svc', 'dom', 'd', 'dur', 'cost', 'st'] as const) if (q[k].length) sp.set(k, q[k].join(','));
  if (q.primary) sp.set('primary', '1');
  if (q.nomanual) sp.set('nomanual', '1');
  return sp;
}

export function hasCatalogParams(sp: URLSearchParams): boolean {
  return CATALOG_PARAMS.some((k) => sp.has(k));
}

/** 已选的筛选条件数（窄屏“筛选（N）”按钮）。 */
export function activeFilterCount(q: CatalogQuery): number {
  return FACET_KEYS.reduce((n, k) => n + q[k].length, 0) + q.svc.length + (q.nomanual ? 1 : 0) + (q.primary ? 1 : 0);
}

export function toggleValue<T extends string>(arr: readonly T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

// ---------------------------------------------------------------------------------------------------------------
// 当前环境与卡片状态（05 §2.9）

/** 持有环境的会话（SessionSync 的当前会话优先，其次 GET /labs 的 environment）。 */
export interface Holder {
  labId: string;
  sessionId: string;
  state: SessionState;
  deadlineAt?: string | null;
  keepUntil?: string | null;
}

export interface CardStateView {
  key: 'preparing' | 'running' | 'winding' | 'kept' | 'cleanup-failed' | 'completed' | 'completed-manual' | 'incomplete' | 'not-started';
  text: string;
  shape: ShapeName;
  tone: Tone;
  group: StatusGroup;
  /** 卡片上的独立操作（只在本卡持有环境时出现）。 */
  action: 'workspace' | 'progress' | null;
}

const PREPARING: readonly SessionState[] = ['REQUESTED', 'PROVISIONING'];
const LIVE: readonly SessionState[] = ['READY', 'RUNNING', 'EXPIRING'];
const WIND: readonly SessionState[] = ['ENDING', 'CLEANING'];

export function isDoneStatus(s: LabProgressStatus | null | undefined): boolean {
  return s === 'completed' || s === 'completed_manual';
}

export function cardStateOf(cardId: string, holder: Holder | null, item: Pick<LabItem, 'status' | 'lastSession'> | null | undefined, nowMs: number): CardStateView {
  if (holder && holder.labId === cardId) {
    const st = holder.state;
    if (PREPARING.includes(st)) return { key: 'preparing', text: S.state.preparing, shape: 'clock', tone: 'pend', group: 'in_progress', action: 'workspace' };
    if (LIVE.includes(st)) {
      const remaining = holder.deadlineAt ? Date.parse(holder.deadlineAt) - nowMs : null;
      if (remaining !== null && remaining <= 0) return { key: 'winding', text: S.state.ending, shape: 'clock', tone: 'mut', group: 'in_progress', action: 'workspace' };
      const warn = st === 'EXPIRING' || (remaining !== null && remaining <= 15 * 60_000);
      const text = remaining !== null ? t(S.state.running, { t: formatCountdown(remaining) }) : S.state.preparing;
      return { key: 'running', text, shape: 'clock', tone: warn ? 'drift' : 'pend', group: 'in_progress', action: 'workspace' };
    }
    if (WIND.includes(st)) return { key: 'winding', text: st === 'CLEANING' ? S.state.cleaning : S.state.ending, shape: 'clock', tone: 'mut', group: 'in_progress', action: 'progress' };
    if (st === 'KEPT') return { key: 'kept', text: t(S.state.kept, { t: holder.keepUntil ? formatClock(holder.keepUntil) : '—' }), shape: 'dia', tone: 'kept', group: 'in_progress', action: null };
  }
  if (item?.lastSession?.state === 'CLEANUP_FAILED') return { key: 'cleanup-failed', text: S.state.cleanupFailed, shape: 'tri', tone: 'fail', group: 'in_progress', action: null };
  const status = item?.status ?? 'not_started';
  if (status === 'completed') return { key: 'completed', text: S.state.completed, shape: 'check', tone: 'pass', group: 'completed', action: null };
  if (status === 'completed_manual') return { key: 'completed-manual', text: S.state.completedManual, shape: 'man', tone: 'manual', group: 'completed', action: null };
  if (status === 'attempted') return { key: 'incomplete', text: S.state.incomplete, shape: 'half', tone: 'mut', group: 'incomplete', action: null };
  return { key: 'not-started', text: S.state.notStarted, shape: 'ring', tone: 'faint', group: 'not_started', action: null };
}

// ---------------------------------------------------------------------------------------------------------------
// 分类、服务格、文字

export function categoryLabel(tax: Taxonomy, id: string | null | undefined): string {
  if (!id) return '';
  const c = tax.categories.find((x) => x.id === id);
  if (!c) return id;
  return id === 'base' ? PL.base : t(PL.category, { id, label: c.label });
}

/** 类别 id → CSS 类后缀（cat-base、cat-a…）。 */
export function catClass(id: string | null | undefined): string {
  return id ? `cat-${id === 'base' ? 'base' : id.toLowerCase()}` : 'cat-base';
}

export function serviceOf(tax: Taxonomy, id: string): TaxonomyService | undefined {
  return tax.services.find((s) => s.id === id);
}

/** 服务的类别：服务格自己的类别，附属服务取所属服务格的类别。 */
export function serviceCategory(tax: Taxonomy, id: string): string | null {
  const s = serviceOf(tax, id);
  if (!s) return null;
  if (s.category) return s.category;
  return s.featureOf ? serviceCategory(tax, s.featureOf) : null;
}

/** 场景卡“包含 N 个服务”：只数 primary 与 supporting（05 §2.8 第 1 行）。 */
export function servicesCount(card: CatalogCard): number {
  return card.servicesCount ?? card.services.length;
}

/** 卡片的分类：单服务卡取自己的类别，场景卡取第一个 primary 服务的类别（按服务类别分组时使用）。 */
export function cardCategory(tax: Taxonomy, card: CatalogCard): string | null {
  if (card.kind === 'service') return card.category ?? null;
  const first = card.services.find((s) => s.role === 'primary') ?? card.services[0];
  return first ? serviceCategory(tax, first.id) : null;
}

export function primaryDomain(card: CatalogCard): SaaDomain | null {
  return card.saa?.primaryDomain ?? card.saa?.domains?.[0] ?? card.domains?.[0] ?? null;
}

export function cardDomains(card: CatalogCard): SaaDomain[] {
  return card.saa?.domains ?? card.domains ?? [];
}

export function durationBucket(card: CatalogCard): DurationBucket {
  if (card.durationBucket) return card.durationBucket;
  return card.estimatedMinutes <= 60 ? 'short' : card.estimatedMinutes <= 120 ? 'medium' : 'long';
}

export function isPlanned(card: Pick<CatalogCard, 'status' | 'startable'> | null | undefined): boolean {
  return !!card && card.status === 'planned';
}

/** “约 60 分钟”；≥ 120 分钟写成小时（05 §2.8 第 7 行）。 */
export function estimateText(min: number): string {
  if (min >= 120) return t(S.card.hours, { n: (min / 60).toFixed(1).replace(/\.0$/, '') });
  return t(S.card.minutes, { n: min });
}

/** “1.5 小时”。 */
export function limitText(min: number): string {
  return t(PL.hours, { n: (min / 60).toFixed(1).replace(/\.0$/, '') });
}

/** 卡片的提示标记（≤ 3 个由调用方截取），按 05 §2.8 的优先级；`limited` 只在灾备区域为空时出现，`new-version` 由进度推导。 */
export function cardFlags(card: CatalogCard, opts: { drRegion?: string | null; completedMajor?: number | null } = {}): string[] {
  const flags = new Set((card.flags ?? []).filter((f) => f !== 'planned'));
  if (flags.has('limited') && opts.drRegion) flags.delete('limited');
  const major = Number.parseInt(card.version.split('.')[0] ?? '', 10);
  if (opts.completedMajor != null && Number.isFinite(major) && opts.completedMajor < major) flags.add('new-version');
  const rank = (f: string) => {
    const i = (FLAG_ORDER as readonly string[]).indexOf(f);
    return i < 0 ? FLAG_ORDER.length : i;
  };
  return [...flags].sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------------------------------------------------------
// 搜索、筛选、计数（05 §2.7）

const LAB_Q = /^lab[\s-]?(\d{1,2})$/i;

/** 搜索：子串匹配预先拼好的索引（不分词、不区分大小写）；“Lab 10”“lab-10”按原 Lab 编号精确匹配。 */
export function searchMatch(card: CatalogCard, q: string, tax?: Taxonomy): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const m = LAB_Q.exec(s);
  if (m) return (card.legacyLabs ?? []).includes(Number(m[1]));
  const text =
    card.searchText ??
    [card.id, card.title, card.subtitle, card.service, card.function, card.summary, ...(card.tags ?? []), ...(card.saa?.topicTitles ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  if (text.includes(s)) return true;
  if (!tax) return false;
  return card.services.some((x) => {
    const sv = serviceOf(tax, x.id);
    return !!sv && `${sv.name} ${sv.abbr} ${sv.short ?? ''}`.toLowerCase().includes(s);
  });
}

/** 搜索只命中原 Lab 编号或考点时，卡片底部写出命中的内容（05 §2.7）。 */
export function searchHint(card: CatalogCard, q: string): { kind: 'lab'; n: number } | { kind: 'topic'; text: string } | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  const m = LAB_Q.exec(s);
  if (m) return { kind: 'lab', n: Number(m[1]) };
  const visible = [card.id, card.title, card.subtitle, card.summary, card.service, card.function].filter(Boolean).join(' ').toLowerCase();
  if (visible.includes(s)) return null;
  const topic = (card.saa?.topicTitles ?? []).find((x) => x.toLowerCase().includes(s));
  return topic ? { kind: 'topic', text: topic } : null;
}

export interface FilterContext {
  /** 卡片 → “状态”筛选归类；个人进度不可用时为 null（“状态”维度置灰，不参与筛选）。 */
  statusOf: ((cardId: string) => StatusGroup) | null;
  tax?: Taxonomy;
}

function facetValues(card: CatalogCard, k: FacetKey, q: CatalogQuery, ctx: FilterContext): string[] {
  switch (k) {
    case 'kind':
      return [card.kind];
    case 'dom': {
      if (!q.primary) return cardDomains(card);
      const p = primaryDomain(card);
      return p ? [p] : [];
    }
    case 'd':
      return [card.difficulty];
    case 'dur':
      return [durationBucket(card)];
    case 'cost':
      return [card.costTier.required];
    case 'st':
      return ctx.statusOf ? [ctx.statusOf(card.id)] : [];
  }
}

/** 是否需要学员先做人工准备（必填的学员输入；域名可选的卡片不算，05 §2.7）。 */
export function needsManualPrereq(card: CatalogCard): boolean {
  return (card.learnerInputs ?? []).some((i) => i.required);
}

/** 卡片是否满足当前条件（`skip`：计算该维度计数时忽略它自己）。同一维度内取并集，不同维度之间取交集。 */
export function cardMatches(card: CatalogCard, q: CatalogQuery, ctx: FilterContext, skip?: FacetKey | 'svc'): boolean {
  if (!searchMatch(card, q.q, ctx.tax)) return false;
  if (q.nomanual && needsManualPrereq(card)) return false;
  if (skip !== 'svc' && q.svc.length && !card.services.some((s) => q.svc.includes(s.id))) return false;
  for (const k of FACET_KEYS) {
    if (k === skip) continue;
    const sel = q[k] as readonly string[];
    if (!sel.length) continue;
    if (k === 'st' && !ctx.statusOf) continue;
    const vals = facetValues(card, k, q, ctx);
    if (!vals.some((v) => sel.includes(v))) return false;
  }
  return true;
}

export function filterCards(cards: readonly CatalogCard[], q: CatalogQuery, ctx: FilterContext): CatalogCard[] {
  return cards.filter((c) => cardMatches(c, q, ctx));
}

/** 每个取值的计数 = 其他维度保持不变时、选中该取值后的结果数（05 §2.7 规则 2）。 */
export function facetCounts(cards: readonly CatalogCard[], q: CatalogQuery, ctx: FilterContext): Record<FacetKey, Record<string, number>> {
  const out = {} as Record<FacetKey, Record<string, number>>;
  for (const k of FACET_KEYS) {
    const base = cards.filter((c) => cardMatches(c, q, ctx, k));
    const counts: Record<string, number> = {};
    for (const v of FACET_VALUES[k]) counts[v] = 0;
    for (const c of base) for (const v of facetValues(c, k, q, ctx)) if (v in counts) counts[v] = (counts[v] ?? 0) + 1;
    out[k] = counts;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 排序与分组（05 §2.4、§2.7）

/** 推荐顺序：当前路径中的顺序；不在路径中的排在后面，按类别与服务格顺序（场景卡按目录顺序）。 */
export function pathOrderOf(index: Pick<CatalogIndex, 'cards' | 'taxonomy' | 'tracks'>, trackId: string | null): Map<string, number> {
  const order = new Map<string, number>();
  const track = index.tracks.find((x) => x.id === trackId);
  let i = 0;
  for (const st of track?.stages ?? []) {
    for (const it of st.items) {
      for (const id of it.cards ?? (it.card ? [it.card] : [])) if (!order.has(id)) order.set(id, i++);
    }
  }
  const base = 10_000;
  const cats = index.taxonomy.categories.map((c) => c.id);
  const cells = index.taxonomy.services.map((s) => s.id);
  index.cards.forEach((c, n) => {
    if (order.has(c.id)) return;
    if (c.kind === 'service') {
      const primary = c.services.find((s) => s.role === 'primary')?.id ?? '';
      order.set(c.id, base + Math.max(0, cats.indexOf(c.category ?? '')) * 100 + Math.max(0, cells.indexOf(primary)));
    } else order.set(c.id, base + 5_000 + n);
  });
  return order;
}

const COST_RANK: Readonly<Record<CostTier, number>> = { low: 0, medium: 1, high: 2 };

export function sortCards(
  cards: readonly CatalogCard[],
  sort: CatalogSort,
  ctx: { pathOrder: Map<string, number>; lastAttemptAt?: (cardId: string) => number },
): CatalogCard[] {
  const po = (c: CatalogCard) => ctx.pathOrder.get(c.id) ?? 99_999;
  const by: Record<CatalogSort, (a: CatalogCard, b: CatalogCard) => number> = {
    path: (a, b) => po(a) - po(b),
    duration: (a, b) => a.estimatedMinutes - b.estimatedMinutes || po(a) - po(b),
    cost: (a, b) => COST_RANK[a.costTier.required] - COST_RANK[b.costTier.required] || po(a) - po(b),
    recent: (a, b) => (ctx.lastAttemptAt?.(b.id) ?? 0) - (ctx.lastAttemptAt?.(a.id) ?? 0) || po(a) - po(b),
  };
  return [...cards].sort(by[sort]);
}

export interface CardSection {
  id: string;
  title: string;
  cards: CatalogCard[];
  /** 按考试领域分组时，次领域的卡片以紧凑行“也涉及”显示。 */
  also: CatalogCard[];
}

export function groupCards(cards: readonly CatalogCard[], group: CatalogGroup, ctx: { tax: Taxonomy; onlyPrimary: boolean; domainLabel: (d: SaaDomain) => string }): CardSection[] {
  if (group === 'none') return [{ id: 'all', title: S.catalog.sectionAll, cards: [...cards], also: [] }];
  if (group === 'domain') {
    return FACET_VALUES.dom
      .map((d) => ({
        id: `dom-${d}`,
        title: ctx.domainLabel(d),
        cards: cards.filter((c) => primaryDomain(c) === d),
        also: ctx.onlyPrimary ? [] : cards.filter((c) => primaryDomain(c) !== d && cardDomains(c).includes(d)),
      }))
      .filter((s) => s.cards.length || s.also.length);
  }
  const cats = ctx.tax.categories.map((c) => c.id);
  if (group === 'kind') {
    const secs: CardSection[] = cats.map((cat) => ({
      id: `cat-${cat}`,
      title: t(S.catalog.sectionService, { cat: categoryLabel(ctx.tax, cat) }),
      cards: cards.filter((c) => c.kind === 'service' && c.category === cat),
      also: [],
    }));
    secs.push({ id: 'scenario', title: S.catalog.sectionScenario, cards: cards.filter((c) => c.kind === 'scenario'), also: [] });
    return secs.filter((s) => s.cards.length);
  }
  return cats
    .map((cat) => ({ id: `cat-${cat}`, title: categoryLabel(ctx.tax, cat), cards: cards.filter((c) => cardCategory(ctx.tax, c) === cat), also: [] }))
    .filter((s) => s.cards.length);
}

// ---------------------------------------------------------------------------------------------------------------
// 路径进度与证书条件（tracks-and-catalog §5.5 规则 1～4；与 platform/api services/catalog/progress.ts 同一规则）

export interface ProgressLike {
  status?: LabProgressStatus;
  badge?: BadgeView | null;
}

/** 计入证书：徽章有效且不是“自述为主”。 */
export function countsForCertificate(b: BadgeView | null | undefined): boolean {
  return !!b && b.status === 'valid' && b.level !== 'self-reported';
}

export interface TrackSummary {
  requiredDone: number;
  requiredTotal: number;
  groups: number;
  groupsDone: number;
  /** 已计入的卡片数（必修 + 每组按 pick）。 */
  counted: number;
  /** 最少完成卡片数（requiredCards）。 */
  min: number;
  verified: number;
  attested: number;
  /** “已核验”占比；没有计入的卡片时为 null。 */
  ratio: number | null;
  minRatio: number;
  /** 进行中（持有环境）的本路径卡片数。 */
  inProgress: number;
  pending: string[];
  unmetGroups: { stageId: string; stageTitle: string; title: string }[];
  completed: boolean;
  eligible: boolean;
}

export function minCardsOf(track: TrackDef): number {
  if (typeof track.requiredCards === 'number') return track.requiredCards;
  return track.stages.reduce((n, s) => n + s.items.filter((x) => x.card && x.role === 'required').length + s.items.filter((x) => x.group).reduce((a, g) => a + (g.pick ?? 1), 0), 0);
}

export function trackSummary(track: TrackDef, progress: ReadonlyMap<string, ProgressLike>, holderLabId?: string | null): TrackSummary {
  let requiredDone = 0;
  let requiredTotal = 0;
  let groups = 0;
  let groupsDone = 0;
  const counted: BadgeView[] = [];
  const pending: string[] = [];
  const unmetGroups: TrackSummary['unmetGroups'] = [];
  const ids = new Set<string>();
  for (const st of track.stages) {
    for (const it of st.items) {
      for (const id of it.cards ?? (it.card ? [it.card] : [])) ids.add(id);
      if (it.card && it.role === 'required') {
        requiredTotal++;
        const b = progress.get(it.card)?.badge;
        if (countsForCertificate(b)) {
          requiredDone++;
          counted.push(b!);
        } else if (b?.status === 'pending') pending.push(it.card);
      } else if (it.group) {
        groups++;
        const pick = it.pick ?? 1;
        const valid = (it.cards ?? []).filter((c) => countsForCertificate(progress.get(c)?.badge));
        for (const c of it.cards ?? []) if (progress.get(c)?.badge?.status === 'pending') pending.push(c);
        if (valid.length >= pick) groupsDone++;
        else unmetGroups.push({ stageId: st.id, stageTitle: st.title ?? st.id, title: it.title ?? it.group });
        for (const c of valid.slice(0, pick)) counted.push(progress.get(c)!.badge!);
      }
    }
  }
  const verified = counted.filter((b) => b.level === 'verified').length;
  const ratio = counted.length ? verified / counted.length : null;
  const minRatio = track.completion?.minAutoRatio ?? 0.8;
  const completed = requiredDone === requiredTotal && groupsDone === groups;
  return {
    requiredDone,
    requiredTotal,
    groups,
    groupsDone,
    counted: requiredDone + groupsDone,
    min: minCardsOf(track),
    verified,
    attested: counted.length - verified,
    ratio,
    minRatio,
    inProgress: holderLabId && ids.has(holderLabId) ? 1 : 0,
    pending: [...new Set(pending)],
    unmetGroups,
    completed,
    eligible: completed && (ratio === null || ratio >= minRatio) && track.certificate?.enabled !== false,
  };
}

/** 路径必修中尚未完成的卡片的预计时长合计（分钟，不含环境准备）。 */
export function remainingRequiredMinutes(track: TrackDef, progress: ReadonlyMap<string, ProgressLike>, cards: ReadonlyMap<string, CatalogCard>): number {
  let n = 0;
  for (const st of track.stages) for (const it of st.items) if (it.card && it.role === 'required' && !isDoneStatus(progress.get(it.card)?.status)) n += cards.get(it.card)?.estimatedMinutes ?? 0;
  return n;
}

export function pct(r: number | null | undefined): string {
  return r === null || r === undefined ? '—' : fmtPercent(r);
}

// ---------------------------------------------------------------------------------------------------------------
// 推荐下一步（05 §2.11）

export interface Recommendation {
  labId: string;
  stageId: string;
  stageTitle: string;
  groupId?: string;
  reason: 'next-in-path' | 'next-in-path-prereq-missing' | 'elective';
  /** 可以在保留环境中继续时，持有环境的卡片。 */
  reuseFrom: string | null;
}

export function recommendNext(track: TrackDef | null | undefined, progress: ReadonlyMap<string, ProgressLike>, holder: Holder | null, cards: ReadonlyMap<string, CatalogCard>): Recommendation | null {
  if (!track) return null;
  const done = (id: string) => id === holder?.labId || isDoneStatus(progress.get(id)?.status);
  const softPrereqs = (id: string) => (cards.get(id)?.prerequisites ?? []).filter((p) => p.kind === 'soft').map((p) => p.id);
  const reuseHint = (pick: string) =>
    holder?.state === 'KEPT' && (cards.get(pick)?.reuseFrom ?? []).some((r) => r.labId === holder.labId) ? holder.labId : null;
  for (const st of track.stages) {
    const todo = st.items.filter((i) => i.card && i.role === 'required' && !done(i.card)).map((i) => i.card!);
    const ready = todo.find((id) => softPrereqs(id).every(done));
    const pick = ready ?? todo[0];
    if (pick) return { labId: pick, stageId: st.id, stageTitle: st.title ?? st.id, reason: ready ? 'next-in-path' : 'next-in-path-prereq-missing', reuseFrom: reuseHint(pick) };
  }
  for (const st of track.stages) {
    for (const g of st.items.filter((i) => i.group)) {
      const gc = g.cards ?? [];
      if (gc.filter(done).length < (g.pick ?? 1)) {
        const pick = gc.filter((id) => !done(id)).sort((a, b) => (cards.get(a)?.estimatedMinutes ?? 0) - (cards.get(b)?.estimatedMinutes ?? 0))[0];
        if (pick) return { labId: pick, stageId: st.id, stageTitle: st.title ?? st.id, groupId: g.group, reason: 'elective', reuseFrom: reuseHint(pick) };
      }
    }
  }
  return null;
}

/** 相邻两张卡片满足 reuseFrom 时，后一张显示“↳ 可在 X 的保留环境中继续”（05 §2.6）。 */
export function reuseHintsOf(track: TrackDef, cards: ReadonlyMap<string, CatalogCard>): Map<string, string> {
  const out = new Map<string, string>();
  const seq: string[] = [];
  for (const st of track.stages) for (const it of st.items) for (const id of it.cards ?? (it.card ? [it.card] : [])) seq.push(id);
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1]!;
    const cur = seq[i]!;
    if ((cards.get(cur)?.reuseFrom ?? []).some((r) => r.labId === prev)) out.set(cur, prev);
  }
  return out;
}

/** 卡片所在的路径与角色（简介页“所属路径”）。 */
export function membershipOf(index: Pick<CatalogIndex, 'tracks'>, cardId: string): { track: TrackDef; stageTitle: string; role: 'required' | 'optional' | 'group' }[] {
  const out: { track: TrackDef; stageTitle: string; role: 'required' | 'optional' | 'group' }[] = [];
  for (const tr of index.tracks) {
    for (const st of tr.stages) {
      const it = st.items.find((x) => x.card === cardId || (x.cards ?? []).includes(cardId));
      if (it) {
        out.push({ track: tr, stageTitle: st.title ?? st.id, role: it.group ? 'group' : it.role === 'required' ? 'required' : 'optional' });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 服务地图（05 §2.5）

export interface ServiceCellView extends ServiceCellDef {
  /** 服务全称（Amazon SQS）。 */
  name: string;
  /** 服务格上的短名（SQS、CloudFront）。 */
  short: string;
  abbr: string;
  fn: string;
  category: string;
  /** `*` 需要域名才能由场景卡计入（route53、acm）；`†` 没有场景卡。 */
  mark: '*' | '†' | '';
}

const DOMAIN_CELLS = new Set(['route53', 'acm']);

export function serviceCells(index: Pick<CatalogIndex, 'serviceMap' | 'taxonomy'>): ServiceCellView[] {
  return index.serviceMap.map((cell) => {
    const sv = serviceOf(index.taxonomy, cell.id);
    const noScenario = !(cell.creditedBy ?? []).length;
    return {
      ...cell,
      name: sv?.name ?? cell.id,
      short: sv?.short ?? sv?.name ?? cell.id,
      abbr: cell.abbr ?? sv?.abbr ?? cell.id.toUpperCase(),
      fn: sv?.function ?? '',
      category: cell.category ?? sv?.category ?? 'base',
      mark: DOMAIN_CELLS.has(cell.id) ? '*' : noScenario ? '†' : '',
    };
  });
}

/** 方向键按几何位置移动（ui-design §13.3 spatialNext；roving tabindex）。 */
export function spatialNext(
  rects: readonly { id: string; x: number; y: number; w: number; h: number }[],
  fromId: string,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
): string | null {
  const from = rects.find((r) => r.id === fromId);
  if (!from) return null;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: string | null = null;
  let bd = Number.POSITIVE_INFINITY;
  for (const r of rects) {
    if (r.id === fromId) continue;
    const dx = r.x + r.w / 2 - cx;
    const dy = r.y + r.h / 2 - cy;
    const ok =
      key === 'ArrowLeft' ? dx < -4 && Math.abs(dy) < from.h / 2 : key === 'ArrowRight' ? dx > 4 && Math.abs(dy) < from.h / 2 : key === 'ArrowUp' ? dy < -4 : dy > 4;
    if (!ok) continue;
    const d = Math.abs(dx) + Math.abs(dy) * 2;
    if (d < bd) {
      bd = d;
      best = r.id;
    }
  }
  return best;
}
