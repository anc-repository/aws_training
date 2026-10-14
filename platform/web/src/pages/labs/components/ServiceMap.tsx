/**
 * 服务地图 ServiceMap（40 个 ServiceCell）与服务格侧栏 ServiceCellPanel（08 §5.1；05 §2.5；tracks-and-catalog §5.4）。
 * - 每行一个类别：`role="group"` + `aria-label`，可见的行标签 aria-hidden；不用 grid/gridcell 角色（§5.1）；
 * - 服务格是原生 <button> + `aria-pressed`（侧栏打开），完整 aria-label；roving tabindex，方向键按几何位置移动；
 * - 进度环只表示分数，等级用“形状 + 文字”；掌握度不可用时只显示格子（不显示进度环与等级）；
 * - 视觉化（I6 c）：格子是服务图标网格（ServiceGlyph + 短名），行标签是组的几何符号；“单服务卡 / 场景卡”的完成情况用
 *   方块与六边形两个小图标表示（完整文字在按钮的 aria-label 与悬停提示中）。
 * P02（服务地图视图）与 P10（服务掌握度页签）共用。
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fmtPercent, msg, t } from '../../../i18n';
import { Drawer, Shape } from '../../../ui';
import { categoryLabel, isDoneStatus, membershipOf, spatialNext, type Holder, type ProgressLike, type ServiceCellView } from '../model';
import { BADGE_LEVEL_TEXT, MASTERY_META, S } from '../strings';
import type { CatalogCard, CatalogIndex, LabItem, ServiceMasteryView, Taxonomy } from '../types';
import { CardRowCompact } from './CardTile';
import { ProgressRing } from './Marks';
import { GroupSymbol, ServiceGlyph } from '../../../ui/glyphs';
import { ProgressRing as ChartRing } from '../../../ui/charts';
import { Link } from 'react-router-dom';

const PL = msg.pages.labs;

export interface ServiceMapProps {
  cells: readonly ServiceCellView[];
  tax: Taxonomy;
  /** 掌握度；null = 不可用（只显示格子）。 */
  mastery: ReadonlyMap<string, ServiceMasteryView> | null;
  progress: ReadonlyMap<string, ProgressLike>;
  selected: string | null;
  onSelect: (cellId: string) => void;
  /** 不匹配筛选的服务格（淡化）。 */
  dimmed?: ReadonlySet<string>;
}

/** 侧栏中的掌握度分数环（I6 f）。 */
function MasteryRing({ score }: { score: number }) {
  return <ChartRing value={score} max={100} size={48} label={S.map.panelMastery} />;
}

/** 服务格底部的小图标：方块 = 单服务卡，六边形 = 场景卡（与徽章图形一致，05 §2.10）。 */
function CreditMark({ kind, done, text }: { kind: 'svc' | 'sc'; done: boolean; text: string }) {
  return (
    <span className={done ? 'cm on' : 'cm'}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        {kind === 'svc' ? <rect x="1" y="1" width="8" height="8" rx="1.5" /> : <path d="M5 .8l3.8 2.1v4.2L5 9.2 1.2 7.1V2.9z" />}
      </svg>
      {text}
    </span>
  );
}

export function masteryCounts(cells: readonly ServiceCellView[], mastery: ReadonlyMap<string, ServiceMasteryView> | null) {
  const out = { proficient: 0, mastered: 0, touched: 0, not_started: 0, review: 0 };
  for (const c of cells) {
    const m = mastery?.get(c.id);
    out[m?.level ?? 'not_started']++;
    if (m?.needsReview) out.review++;
  }
  return out;
}

export function ServiceMap({ cells, tax, mastery, progress, selected, onSelect, dimmed }: ServiceMapProps) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => masteryCounts(cells, mastery), [cells, mastery]);
  const rows = tax.categories.map((cat) => ({ cat, cells: cells.filter((c) => c.category === cat.id) })).filter((r) => r.cells.length);
  const active = focusId ?? selected ?? cells[0]?.id ?? null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!el || !rootRef.current) return;
    e.preventDefault();
    const rects = Array.from(rootRef.current.querySelectorAll<HTMLElement>('[data-cell]')).map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.dataset.cell!, x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const next = spatialNext(rects, el.dataset.cell!, e.key as 'ArrowLeft');
    if (next) {
      setFocusId(next);
      rootRef.current.querySelector<HTMLElement>(`[data-cell="${next}"]`)?.focus();
    }
  };
  return (
    <div className="stack">
      <div className="legend" data-legend="">
        <span>{S.map.legend}</span>
        {(['not_started', 'touched', 'mastered', 'proficient'] as const).map((lv) => (
          <span key={lv} className="st mut">
            <Shape name={MASTERY_META[lv].shape} />
            <span className="t">
              {MASTERY_META[lv].text} {mastery ? counts[lv] : ''}
            </span>
          </span>
        ))}
        <span className="smap-legend-cm">
          <CreditMark kind="svc" done={false} text={S.map.legendSvc} />
          <CreditMark kind="sc" done={false} text={S.map.legendSc} />
        </span>
        <span>{S.map.legendTail}</span>
      </div>
      <div className="smap" ref={rootRef} onKeyDown={onKey} aria-describedby="smap-help" data-smap="">
        {rows.map(({ cat, cells: rowCells }) => (
          <div key={cat.id} className="mrow" role="group" aria-label={categoryLabel(tax, cat.id)}>
            <span className="rl" aria-hidden="true" title={categoryLabel(tax, cat.id)}>
              <GroupSymbol group={cat.id} size={10} />
              {cat.id === 'base' ? PL.base : cat.id}
            </span>
            <div className="cells">
              {rowCells.map((c) => {
                const m = mastery?.get(c.id) ?? null;
                const lv = MASTERY_META[m?.level ?? 'not_started'];
                const svcDone = c.serviceCard ? isDoneStatus(progress.get(c.serviceCard)?.status) : false;
                const sc = c.creditedBy ?? [];
                const scDone = sc.filter((id) => isDoneStatus(progress.get(id)?.status)).length;
                const label = [
                  t(S.map.cellLabel, { name: c.name, fn: c.fn, level: m ? lv.text : S.catalog.masteryUnavailable, score: m ? m.score : '—' }),
                  m?.needsReview ? S.map.needsReview : null,
                  c.mark === '*' ? S.map.domainNote : c.mark === '†' ? S.map.noScenario : null,
                ]
                  .filter(Boolean)
                  .join(S.map.labelSep);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={['scell', dimmed?.has(c.id) ? 'dim' : '', m ? '' : 'na'].filter(Boolean).join(' ')}
                    data-cell={c.id}
                    tabIndex={c.id === active ? 0 : -1}
                    aria-pressed={selected === c.id}
                    aria-label={label}
                    onFocus={() => setFocusId(c.id)}
                    onClick={() => onSelect(c.id)}
                  >
                    <ServiceGlyph id={c.module ?? c.id} size={32} />
                    <span className="nm">
                      {c.short}
                      {c.mark}
                    </span>
                    {m ? <ProgressRing score={m.score} /> : null}
                    <span className="lv">
                      {m ? (
                        <>
                          <Shape name={lv.shape} />
                          {lv.text} · <span className="tnum">{m.score}</span>
                          {m.needsReview ? <span className="rv"> !</span> : null}
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </span>
                    <span className="bot" title={t(S.map.single, { mark: svcDone ? '✓' : '—', done: scDone, total: sc.length })}>
                      <CreditMark kind="svc" done={svcDone} text={svcDone ? '✓' : '—'} />
                      <CreditMark kind="sc" done={!!sc.length && scDone >= sc.length} text={sc.length ? `${scDone}/${sc.length}` : '—'} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="small muted" id="smap-help">
        {S.map.help}
      </p>
    </div>
  );
}

export interface ServiceCellPanelProps {
  cell: ServiceCellView | null;
  index: CatalogIndex;
  cards: ReadonlyMap<string, CatalogCard>;
  mastery: ServiceMasteryView | null;
  items: ReadonlyMap<string, LabItem>;
  holder: Holder | null;
  onClose: () => void;
}

/** 服务格侧栏（Drawer，URL `cell=`）。 */
export function ServiceCellPanel({ cell, index, cards, mastery, items, holder, onClose }: ServiceCellPanelProps) {
  const svcCard = cell?.serviceCard ? cards.get(cell.serviceCard) : undefined;
  const lv = MASTERY_META[mastery?.level ?? 'not_started'];
  const features = cell ? index.taxonomy.services.filter((s) => s.featureOf === cell.id) : [];
  const tracks = svcCard ? membershipOf(index, svcCard.id) : [];
  const row = (id: string) => {
    const c = cards.get(id);
    return c ? <CardRowCompact key={id} card={c} item={items.get(id)} holder={holder} /> : null;
  };
  return (
    <Drawer open={!!cell} onClose={onClose} title={cell ? `${cell.name} · ${cell.fn}` : ''}>
      {cell ? (
        <div className="stack-16 smap-panel" data-cell-panel={cell.id}>
          <div className="row nowrap-row">
            <ServiceGlyph id={cell.module ?? cell.id} size={48} />
            {mastery ? <MasteryRing score={mastery.score} /> : null}
          </div>
          <div className="stack-4">
            <div>
              {S.map.panelMastery}{' '}
              {mastery ? (
                <>
                  <span className="st mut">
                    <Shape name={lv.shape} />
                    <span className="t">{lv.text}</span>
                  </span>{' '}
                  · <span className="tnum">{t(S.map.panelScore, { score: mastery.score })}</span>
                </>
              ) : (
                <span className="muted">{S.catalog.masteryUnavailable}</span>
              )}
            </div>
            {mastery ? (
              <div className="small muted">
                {t(S.map.panelSvcCardLine, { label: S.map.panelSvcCard })}{mastery.serviceCard?.badgeLevel ? (BADGE_LEVEL_TEXT[mastery.serviceCard.badgeLevel] ?? mastery.serviceCard.badgeLevel) : S.card.badgeNone} ·{' '}
                {t(PL.scenarioCredits, { label: S.map.panelCredited, n: (mastery.scenarioCredits ?? []).length })}
                {mastery.quiz?.ratio != null ? ` · ${t(S.map.panelQuiz, { r: fmtPercent(mastery.quiz.ratio) })}` : ''}
              </div>
            ) : null}
            {mastery?.needsReview ? <div className="small st drift">{S.map.panelReview}</div> : null}
          </div>
          <div className="stack-4">
            <b className="small">{S.map.panelSvcCard}</b>
            {svcCard ? row(svcCard.id) : <span className="small faint">—</span>}
          </div>
          <div className="stack-4">
            <b className="small">{S.map.panelCredited}</b>
            {(cell.creditedBy ?? []).length ? (cell.creditedBy ?? []).map(row) : <span className="small faint">{S.map.panelNoScenario}</span>}
          </div>
          {(cell.appearsIn ?? []).length ? (
            <div className="stack-4">
              <b className="small">{S.map.panelAppears}</b>
              {(cell.appearsIn ?? []).map(row)}
            </div>
          ) : null}
          {tracks.length ? (
            <div className="small">
              <b>{S.map.panelTracks}</b>{' '}
              {tracks.map((m, i) => (
                <span key={m.track.id}>
                  {i ? ' · ' : ''}
                  <Link to={`/tracks/${m.track.id}`}>{m.track.title ?? m.track.id}</Link>
                </span>
              ))}
            </div>
          ) : null}
          {svcCard?.saa?.topicTitles?.length ? (
            <div className="small">
              <b>{S.map.panelTopics}</b> {svcCard.saa.topicTitles.join(' · ')}
            </div>
          ) : null}
          <div className="small">
            <b>{S.map.panelFeatures}</b> {features.length ? features.map((f) => f.name).join(PL.listSep) : '—'}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
