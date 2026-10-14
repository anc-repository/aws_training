/**
 * CardTile（目录中的完整卡片）与 CardRowCompact（紧凑行）（08 §5.1；05 §2.4、§2.8、§2.9、§2.13）。
 * - 卡片整体是拉伸链接到 /labs/:labId，卡片上没有“开始”按钮；唯一独立按钮“回到工作台”只在本卡持有环境时出现，可单独聚焦；
 * - 状态、难度、费用全部“形状 + 文字”；搜索命中高亮（mark）；只命中原 Lab 编号或考点时底部写出命中内容；
 * - 视觉化（I6 c）：服务图标 + 迷你架构图（完成后的构成）+ 标题 + 一行简介；难度 / 时长 / 费用 / 部署等级用图标 + 短标签，
 *   时间上限与部署等级的完整说明只给读屏（简介页有完整说明）；
 * - 持有环境的卡片每秒刷新剩余时间（只有这一张卡片计时）。
 */
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useServices } from '../../../app/context';
import { pillTarget } from '../../../app/sessionRouting';
import { msg, t } from '../../../i18n';
import { CostTierMark, Skeleton, useSecondTick } from '../../../ui';
import { GroupSymbol, ServiceGlyph } from '../../../ui/glyphs';
import {
  cardStateOf,
  catClass,
  categoryLabel,
  isPlanned,
  limitText,
  searchHint,
  serviceCategory,
  serviceOf,
  servicesCount,
  type Holder,
} from '../model';
import { DIFFICULTY_TEXT, FLAG_TEXT, PROVISION_TEXT, S } from '../strings';
import type { BadgeView, CatalogCard, LabItem, Taxonomy } from '../types';
import { BadgeMark, badgeStateOf, badgeStateText, StateText } from './Marks';
import { CardArch, CardGlyph, CardMetrics } from './Visuals';
import { untranslated } from '../../../i18n/content';
import { UntranslatedIf } from '../../../i18n/Untranslated';

const PL = msg.pages.labs;

/** 把文本中与搜索词相同的片段包进 <mark>（不区分大小写；原 Lab 编号查询不高亮）。 */
export function highlight(text: string, q: string): ReactNode {
  const s = q.trim();
  if (!s || /^lab[\s-]?\d/i.test(s)) return text;
  const lower = text.toLowerCase();
  const needle = s.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    if (j > i) out.push(<Fragment key={k++}>{text.slice(i, j)}</Fragment>);
    out.push(<mark key={k++}>{text.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
  }
  if (!out.length) return text;
  out.push(<Fragment key={k++}>{text.slice(i)}</Fragment>);
  return out;
}

export function kindLine(card: CatalogCard, tax: Taxonomy): string {
  return card.kind === 'service' ? t(S.card.kindService, { cat: categoryLabel(tax, card.category) }) : t(S.card.kindScenario, { n: servicesCount(card) });
}

export function badgeLabel(card: CatalogCard, tax: Taxonomy): string {
  if (card.kind === 'scenario') return (card.badge?.short ?? card.badge?.title ?? card.title).slice(0, 4);
  const primary = card.services.find((s) => s.role === 'primary')?.id;
  return (primary ? serviceOf(tax, primary)?.abbr : null) ?? card.id.replace(/^svc-/, '').slice(0, 4).toUpperCase();
}

export function CardBadge({ card, tax, badge, size = 24 }: { card: CatalogCard; tax: Taxonomy; badge: BadgeView | null | undefined; size?: 24 | 40 }) {
  return <BadgeMark kind={card.kind} label={badgeLabel(card, tax)} state={badgeStateOf(badge)} title={card.badge?.title ?? card.id} size={size} />;
}

/** 场景卡的服务图标（primary 在前、supporting 在后，最多 5 个，超出显示 +N；选做为虚线框）。 */
export function ServiceStrip({ card, tax, max = 5 }: { card: CatalogCard; tax: Taxonomy; max?: number }) {
  const ordered = [...card.services].sort((a, b) => (a.role === b.role ? 0 : a.role === 'primary' ? -1 : 1));
  const names = ordered.map((s) => serviceOf(tax, s.id)?.name ?? s.id);
  return (
    <div className="row svs">
      {ordered.slice(0, max).map((s) => {
        const sv = serviceOf(tax, s.id);
        const cat = serviceCategory(tax, s.id);
        return (
          <span key={s.id} className="svs-item" title={`${sv?.name ?? s.id} · ${categoryLabel(tax, cat)}${s.optional ? S.card.scenarioOptional : ''}`} aria-hidden="true">
            <ServiceGlyph id={s.id} size={24} tone={s.optional ? 'ghost' : 'solid'} />
          </span>
        );
      })}
      {ordered.length > max ? <span className="small">+{ordered.length - max}</span> : null}
      <span className="sr">{t(S.card.services, { list: names.join(PL.listSep) })}</span>
    </div>
  );
}

export interface CardTileProps {
  card: CatalogCard;
  tax: Taxonomy;
  item: LabItem | null | undefined;
  holder: Holder | null;
  /** 个人进度：loading 显示骨架；failed 显示“状态暂不可用”。 */
  personal: 'ok' | 'loading' | 'failed';
  query: string;
  flags: string[];
}

export function CardTile({ card, tax, item, holder, personal, query, flags }: CardTileProps) {
  const { clock } = useServices();
  const isHolder = !!holder && holder.labId === card.id;
  useSecondTick(isHolder && (holder.state === 'READY' || holder.state === 'RUNNING' || holder.state === 'EXPIRING'));
  const state = cardStateOf(card.id, holder, item, clock.now());
  const planned = isPlanned(card);
  const hint = searchHint(card, query);
  const titleId = `t-${card.id}`;
  const cls = ['ctile', 'vis', card.kind === 'service' ? `svc ${catClass(card.category)}` : 'sc', isHolder ? 'holder' : '']
    .filter(Boolean)
    .join(' ');
  const badge = item?.badge ?? null;
  const target = isHolder ? pillTarget({ sessionId: holder.sessionId, state: holder.state }) : null;
  const shownFlags = flags.filter((f) => f !== 'beta').slice(0, 2);
  return (
    <article className={cls} aria-labelledby={titleId} data-card={card.id}>
      <div className="ct-head">
        <CardGlyph card={card} size={40} />
        <div className="ct-title">
          <span className="kindline">
            {card.kind === 'service' ? <GroupSymbol group={card.category ?? 'base'} size={8} /> : null}
            <span>{kindLine(card, tax)}</span>
            {flags.includes('beta') ? <span className="tag info">{FLAG_TEXT.beta}</span> : null}
          </span>
          <h3 id={titleId}>
            <Link to={`/labs/${card.id}`}>
              {highlight(card.kind === 'service' ? (card.service ?? card.title) : card.title, query)}
              <span className="fn">{highlight((card.kind === 'service' ? card.function : card.subtitle) ?? '', query)}</span>
            </Link>
            <UntranslatedIf show={untranslated(card, card.kind === 'service' ? '/function' : '/title') || untranslated(card, '/summary')} />
          </h3>
        </div>
      </div>
      <CardArch card={card} />
      <p className="sum" title={card.summary}>
        {highlight(card.summary, query)}
      </p>
      <div className="meta">
        <CardMetrics card={card} />
        {planned ? <span className="tag planned">{S.card.planned}</span> : null}
        {shownFlags.map((f) => (
          <span key={f} className="tag" title={flags.map((x) => FLAG_TEXT[x] ?? x).join(PL.listSep)}>
            {FLAG_TEXT[f] ?? f}
          </span>
        ))}
        {hint ? <span className="lab-hit">{hint.kind === 'lab' ? t(S.card.legacy, { n: hint.n }) : t(PL.topic, { text: hint.text })}</span> : null}
        <span className="sr">
          {t(S.card.limit, { t: limitText(card.timeLimitMinutes) })} · {t(S.card.provision, { t: PROVISION_TEXT[card.provisionClass] ?? card.provisionClass })}
        </span>
      </div>
      <div className="foot">
        {personal === 'loading' ? (
          <span className="grow">
            <Skeleton lines={1} slowAfterMs={60_000} />
          </span>
        ) : personal === 'failed' ? (
          <span className="small muted">{S.catalog.statusUnavailable}</span>
        ) : (
          <>
            <StateText meta={state} />
            <span className="faint small">{item?.attempts ? t(S.card.attempts, { n: item.attempts }) : S.card.noAttempts}</span>
          </>
        )}
        <span className="bdg">
          <CardBadge card={card} tax={tax} badge={badge} />
          <span aria-hidden="true">{badgeStateText(badgeStateOf(badge))}</span>
        </span>
      </div>
      {target && state.action ? (
        <Link className="btn sm wsbtn" to={target}>
          {state.action === 'progress' ? S.card.viewProgress : S.card.backToWorkspace}
        </Link>
      ) : null}
    </article>
  );
}

export interface CardRowCompactProps {
  card: CatalogCard;
  item?: LabItem | null;
  holder?: Holder | null;
  extra?: ReactNode;
  current?: boolean;
}

/** 紧凑行（高 40px）：`[状态形状] svc-queue  Amazon SQS：异步任务队列与死信队列 · 初级 · 60 分钟 · $ 低`。 */
export function CardRowCompact({ card, item, holder = null, extra, current }: CardRowCompactProps) {
  const { clock } = useServices();
  const state = cardStateOf(card.id, holder, item, clock.now());
  return (
    <div className={current ? 'crow cur' : 'crow'} data-card={card.id}>
      <StateText meta={state} hideText />
      <Link className="id" to={`/labs/${card.id}`}>
        {card.id}
      </Link>
      <CardGlyph card={card} size={20} max={2} />
      <span className="wrap-any">
        {card.title}
        <UntranslatedIf show={untranslated(card, '/title')} />
      </span>
      <span className="faint small">
        · {DIFFICULTY_TEXT[card.difficulty]} · {t(PL.minutes, { n: card.estimatedMinutes })} · <CostTierMark tier={card.costTier.required} withOptional={card.costTier.withOptional} />
        {isPlanned(card) ? ` · ${S.card.planned}` : ''}
      </span>
      {extra}
    </div>
  );
}

