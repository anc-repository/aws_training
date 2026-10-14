/**
 * 路径视图的组件（08 §5.1 TrackStage、TrackNode、TrackProgressRow；05 §2.6）：P02 的路径视图、P02-T 路径详情与 P10 共用。
 * - 阶段是 disclosure（aria-expanded）；窄屏默认只展开推荐所在的阶段；
 * - 条目角色：必修 ●、选修组 ◇、可选 ○；当前推荐用 `--accent` 左边条；相邻卡片满足 reuseFrom 时显示“↳ 可在 X 的保留环境中继续”；
 * - 选修组 `role="group"` + “选修组：选 1 张，已完成 0 张”。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useServices } from '../../../app/context';
import { msg, t } from '../../../i18n';
import { CostTierMark, Icon, Shape } from '../../../ui';
import { cardStateOf, isDoneStatus, pct, reuseHintsOf, type Holder, type ProgressLike, type TrackSummary } from '../model';
import { ROLE_IN_TRACK, S } from '../strings';
import type { CatalogCard, LabItem, TrackDef, TrackItem } from '../types';
import { SegmentedProgress, StateText } from './Marks';
import { CardGlyph } from './Visuals';
import { ProgressRing } from '../../../ui/charts';

const PL = msg.pages.labs;

export type CertState = 'eligible' | 'not-yet' | 'claimed' | 'revoked';

export function CertStateText({ state }: { state: CertState }) {
  const m =
    state === 'eligible'
      ? { shape: 'dot' as const, tone: 'pass', text: S.track.eligibleTag }
      : state === 'claimed'
        ? { shape: 'check' as const, tone: 'pass', text: S.track.claimedTag }
        : state === 'revoked'
          ? { shape: 'xbox' as const, tone: 'fail', text: S.track.revokedTag }
          : { shape: 'ring' as const, tone: 'faint', text: S.track.notYetTag };
  return (
    <span className={`st ${m.tone}`} data-cert={state}>
      <Shape name={m.shape} />
      <span className="t">{m.text}</span>
    </span>
  );
}

export interface TrackHeadProps {
  track: TrackDef;
  summary: TrackSummary;
  cert: CertState;
  /** 学员才有“设为当前路径”。 */
  canSetCurrent: boolean;
  isCurrent: boolean;
  onSetCurrent?: () => void;
  busy?: boolean;
}

/** “必修 21/35 · 选修组 2/5 · 已核验 78%（需 ≥ 70%）· 计入 23/40 · 证书：…”+ 分段条 + 设为当前路径。 */
export function TrackHead({ track, summary: p, cert, canSetCurrent, isCurrent, onSetCurrent, busy }: TrackHeadProps) {
  return (
    <div className="track-head" data-track-head={track.id}>
      <ProgressRing value={p.counted} max={Math.max(1, p.min)} size={44} label={S.visual.ringCounted} />
      <span>
        {t(S.track.head, { done: p.requiredDone, total: p.requiredTotal })}
        {p.groups ? t(S.track.groups, { done: p.groupsDone, total: p.groups }) : ''}
        {t(S.track.verified, { pct: pct(p.ratio), min: pct(p.minRatio) })}
        {t(S.track.counted, { n: p.counted, min: p.min })} · {S.track.cert}
        <CertStateText state={cert} />
      </span>
      <SegmentedProgress verified={p.verified} attested={p.attested} inProgress={p.inProgress} min={p.min} />
      {canSetCurrent ? (
        isCurrent ? (
          <span className="tag">{S.track.current}</span>
        ) : (
          <button type="button" className="btn sm" onClick={onSetCurrent} aria-busy={busy || undefined} disabled={busy}>
            {S.track.setCurrent}
          </button>
        )
      ) : null}
    </div>
  );
}

/** 原 Lab 编号：一个“0”，多个“0～3”（首尾）。 */
function legacyRange(ns: readonly number[]): string {
  return ns.length > 1 ? t(PL.numRange, { a: ns[0]!, b: ns[ns.length - 1]! }) : String(ns[0] ?? '');
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

export interface TrackStageListProps {
  track: TrackDef;
  cards: ReadonlyMap<string, CatalogCard>;
  items: ReadonlyMap<string, LabItem>;
  progress: ReadonlyMap<string, ProgressLike>;
  holder: Holder | null;
  recommendedId: string | null;
}

export function TrackStageList({ track, cards, items, progress, holder, recommendedId }: TrackStageListProps) {
  const narrow = useNarrow();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const reuse = reuseHintsOf(track, cards);
  const recStage = recommendedId ? track.stages.find((s) => s.items.some((i) => i.card === recommendedId || (i.cards ?? []).includes(recommendedId)))?.id : null;
  const done = (id: string) => isDoneStatus(progress.get(id)?.status);
  return (
    <div data-stages={track.id}>
      {track.stages.map((st) => {
        const req = st.items.filter((x) => x.card && x.role === 'required');
        const grp = st.items.filter((x) => x.group);
        const total = req.length + grp.length;
        const n = req.filter((x) => done(x.card!)).length + grp.filter((g) => (g.cards ?? []).filter(done).length >= (g.pick ?? 1)).length;
        const isOpen = open[st.id] ?? (!narrow || st.id === recStage);
        const panelId = `stage-${track.id}-${st.id}`;
        return (
          <div key={st.id} className="stage" data-stage={st.id}>
            <button type="button" className="sh" aria-expanded={isOpen} aria-controls={panelId} onClick={() => setOpen((o) => ({ ...o, [st.id]: !isOpen }))}>
              <Icon name={isOpen ? 'chev' : 'right'} />
              <b>{st.title ?? st.id}</b>
              {st.legacyLabs?.length ? <span className="small faint">{t(S.track.stageLegacy, { n: legacyRange(st.legacyLabs) })}</span> : null}
              <span className={n === total && total ? 'small st pass' : 'small muted'}>
                {t(S.track.stageCount, { done: n, total })}
                {n === total && total ? ' ✓' : ''}
              </span>
            </button>
            <div id={panelId} className="stack-4" hidden={!isOpen}>
              {st.note ? <p className="stage-note">{st.note}</p> : null}
              {st.items.map((it, i) => (
                <TrackItemView key={it.card ?? it.group ?? i} item={it} cards={cards} items={items} holder={holder} recommendedId={recommendedId} reuse={reuse} done={done} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrackItemView({
  item,
  cards,
  items,
  holder,
  recommendedId,
  reuse,
  done,
}: {
  item: TrackItem;
  cards: ReadonlyMap<string, CatalogCard>;
  items: ReadonlyMap<string, LabItem>;
  holder: Holder | null;
  recommendedId: string | null;
  reuse: ReadonlyMap<string, string>;
  done: (id: string) => boolean;
}): ReactNode {
  if (item.group) {
    const gc = item.cards ?? [];
    const pick = item.pick ?? 1;
    const dn = gc.filter(done).length;
    return (
      <div className="tgroup" role="group" aria-label={t(S.track.groupLabel, { pick, done: dn })}>
        <span className="small muted">
          {t(S.track.groupText, { title: item.title ?? item.group, pick })}
          {dn >= pick ? S.track.groupDone : ''}
        </span>
        {gc.map((id) => (
          <TrackNode key={id} id={id} role="group" cards={cards} items={items} holder={holder} recommendedId={recommendedId} reuseFrom={reuse.get(id)} />
        ))}
      </div>
    );
  }
  if (!item.card) return null;
  return <TrackNode id={item.card} role={item.role === 'required' ? 'required' : 'optional'} note={item.note} cards={cards} items={items} holder={holder} recommendedId={recommendedId} reuseFrom={reuse.get(item.card)} />;
}

export function TrackNode({
  id,
  role,
  note,
  cards,
  items,
  holder,
  recommendedId,
  reuseFrom,
}: {
  id: string;
  role: 'required' | 'optional' | 'group';
  note?: string;
  cards: ReadonlyMap<string, CatalogCard>;
  items: ReadonlyMap<string, LabItem>;
  holder: Holder | null;
  recommendedId: string | null;
  reuseFrom?: string;
}) {
  const { clock } = useServices();
  const c = cards.get(id);
  const state = cardStateOf(id, holder, items.get(id), clock.now());
  const rec = id === recommendedId;
  const r = ROLE_IN_TRACK[role];
  return (
    <>
      <div className={rec ? 'tnode rec' : 'tnode'} data-node={id}>
        <span className="role" aria-label={r.text} role="img">
          {r.symbol}
        </span>
        <StateText meta={state} hideText />
        {c ? <CardGlyph card={c} size={20} max={2} /> : null}
        <Link className="mono" to={`/labs/${id}`}>
          {id}
        </Link>
        <span className="wrap-any">{c?.title ?? ''}</span>
        {c ? (
          <span className="faint small">
            {t(PL.minutes, { n: c.estimatedMinutes })} · <CostTierMark tier={c.costTier.required} withOptional={c.costTier.withOptional} />
          </span>
        ) : null}
        {rec ? <span className="tag accent">{S.track.recommended}</span> : null}
        {note ? <span className="note">{note}</span> : null}
      </div>
      {reuseFrom ? <div className="reuse-hint">{t(S.track.reuseFrom, { labId: reuseFrom })}</div> : null}
    </>
  );
}
