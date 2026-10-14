/**
 * 目录筛选 FacetBar（08 §5.1；05 §2.7）与继续学习条 ContinueStrip（05 §2.11、§2.12）。
 * - 7 个维度 + 2 个开关；取值是 aria-pressed 的切换按钮，带计数，计数为 0 的置灰但仍可点；
 * - 服务下拉按类别分组（服务格 + 附属服务）；已选的服务以“SQS ×”芯片显示；
 * - 窄屏收进“筛选（N）”（由页面的切换按钮控制 collapsed）。
 */
import { Link } from 'react-router-dom';
import { msg, rich, t } from '../../../i18n';
import { CostTierMark } from '../../../ui';
import { categoryLabel, FACET_KEYS, FACET_VALUES, serviceCategory, type CatalogQuery, type FacetKey, type Recommendation, type TrackSummary } from '../model';
import { DIFFICULTY_TEXT, DOMAIN_TEXT, DURATION_TEXT, S } from '../strings';
import type { CatalogCard, Taxonomy, TrackDef } from '../types';

const PL = msg.pages.labs;

/** 维度名（getter：切换语言后取到新语言的文案，词典叶子是原地改写的）。 */
const FACET_LABEL: Readonly<Record<FacetKey, string>> = {
  get kind() {
    return S.catalog.facetKind;
  },
  get dom() {
    return S.catalog.facetDomain;
  },
  get d() {
    return S.catalog.facetDifficulty;
  },
  get dur() {
    return S.catalog.facetDuration;
  },
  get cost() {
    return S.catalog.facetCost;
  },
  get st() {
    return S.catalog.facetStatus;
  },
};

export function facetValueText(k: FacetKey, v: string): string {
  switch (k) {
    case 'kind':
      return v === 'service' ? S.catalog.kindService : S.catalog.kindScenario;
    case 'dom':
      return DOMAIN_TEXT[v as keyof typeof DOMAIN_TEXT] ?? v;
    case 'd':
      return DIFFICULTY_TEXT[v as keyof typeof DIFFICULTY_TEXT] ?? v;
    case 'dur':
      return DURATION_TEXT[v as keyof typeof DURATION_TEXT] ?? v;
    case 'cost':
      return v === 'low' ? PL.cost.low : v === 'medium' ? PL.cost.medium : PL.cost.high;
    case 'st':
      return v === 'not_started' ? S.state.notStarted : v === 'in_progress' ? PL.inProgress : v === 'completed' ? S.state.completed : S.state.incomplete;
  }
}

/** 当前条件摘要（“没有符合条件的卡片”下方）。 */
export function filterSummary(q: CatalogQuery, tax: Taxonomy): string {
  const parts: string[] = [];
  if (q.q.trim()) parts.push(t(PL.search, { q: q.q.trim() }));
  for (const k of FACET_KEYS) if (q[k].length) parts.push(t(PL.facet, { label: FACET_LABEL[k], values: (q[k] as string[]).map((v) => facetValueText(k, v)).join(PL.listSep) }));
  if (q.svc.length) parts.push(t(PL.facet, { label: S.catalog.facetService, values: q.svc.map((id) => tax.services.find((s) => s.id === id)?.abbr ?? id).join(PL.listSep) }));
  if (q.primary) parts.push(S.catalog.onlyPrimary);
  if (q.nomanual) parts.push(S.catalog.noManual);
  return parts.join(' · ');
}

export interface FacetBarProps {
  id: string;
  query: CatalogQuery;
  counts: Record<FacetKey, Record<string, number>>;
  tax: Taxonomy;
  shown: number;
  total: number;
  /** “状态”维度不可用（个人进度加载失败）。 */
  statusDisabled: boolean;
  collapsed: boolean;
  /** 只显示这些维度（服务地图只保留类型、领域、状态）。 */
  only?: readonly FacetKey[];
  compact?: boolean;
  onChange: (next: CatalogQuery) => void;
}

export function FacetBar({ id, query: q, counts, tax, shown, total, statusDisabled, collapsed, only, compact, onChange }: FacetBarProps) {
  const keys = only ?? FACET_KEYS;
  const anyFilter = !!q.q.trim() || FACET_KEYS.some((k) => q[k].length) || q.svc.length > 0 || q.nomanual || q.primary;
  const svcGroups = tax.categories.map((cat) => ({ cat, services: tax.services.filter((s) => serviceCategory(tax, s.id) === cat.id) })).filter((g) => g.services.length);
  return (
    <div className={collapsed ? 'facets collapsed' : 'facets'} id={id} data-facets="">
      {keys.map((k) => (
        <div key={k} className="fr" role="group" aria-label={FACET_LABEL[k]}>
          <span className="fl" aria-hidden="true">
            {FACET_LABEL[k]}
          </span>
          <div className="fv">
            {(FACET_VALUES[k] as readonly string[]).map((v) => {
              const n = counts[k]?.[v] ?? 0;
              const on = (q[k] as readonly string[]).includes(v);
              const off = k === 'st' && statusDisabled;
              return (
                <button
                  key={v}
                  type="button"
                  className={n || on ? 'facet' : 'facet zero'}
                  aria-pressed={on}
                  aria-disabled={off || undefined}
                  title={off ? S.catalog.statusFacetOff : undefined}
                  data-facet={`${k}-${v}`}
                  onClick={() => {
                    if (off) return;
                    const cur = q[k] as readonly string[];
                    onChange({ ...q, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
                  }}
                >
                  {k === 'cost' ? <span className="cost">{facetValueText(k, v)}</span> : facetValueText(k, v)}
                  <span className="n">{off ? '—' : n}</span>
                </button>
              );
            })}
            {k === 'dom' ? (
              <label className="chk small">
                <input type="checkbox" checked={q.primary} onChange={(e) => onChange({ ...q, primary: e.target.checked })} />
                <span>{S.catalog.onlyPrimary}</span>
              </label>
            ) : null}
          </div>
        </div>
      ))}
      {!compact ? (
        <div className="fr">
          <span className="fl" aria-hidden="true">
            {S.catalog.facetService}
          </span>
          <div className="fv">
            <select
              className="input inline"
              aria-label={S.catalog.pickService}
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v && !q.svc.includes(v)) onChange({ ...q, svc: [...q.svc, v] });
              }}
            >
              <option value="">{S.catalog.pickService}</option>
              {svcGroups.map((g) => (
                <optgroup key={g.cat.id} label={categoryLabel(tax, g.cat.id)}>
                  {g.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {t(PL.serviceOption, { name: s.name, abbr: s.abbr })}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {q.svc.map((id) => {
              const s = tax.services.find((x) => x.id === id);
              return (
                <button
                  key={id}
                  type="button"
                  className="facet"
                  aria-pressed="true"
                  aria-label={t(S.catalog.removeService, { name: s?.name ?? id })}
                  onClick={() => onChange({ ...q, svc: q.svc.filter((x) => x !== id) })}
                >
                  {s?.abbr ?? id} ×
                </button>
              );
            })}
            <label className="chk small">
              <input type="checkbox" checked={q.nomanual} onChange={(e) => onChange({ ...q, nomanual: e.target.checked })} />
              <span>{S.catalog.noManual}</span>
            </label>
            <span className="spacer" />
            <span className="small" data-shown="">
              {t(S.catalog.shown, { n: shown, total })}
            </span>
            {anyFilter ? (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => onChange({ ...q, q: '', kind: [], svc: [], dom: [], d: [], dur: [], cost: [], st: [], nomanual: false, primary: false })}
              >
                {S.catalog.clear}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface ContinueStripProps {
  track: TrackDef | null;
  summary: TrackSummary | null;
  rec: Recommendation | null;
  recCard: CatalogCard | null;
  hasEnvironment: boolean;
  newLearner: boolean;
  firstCardId: string | null;
}

/** 继续学习条：当前路径的进度与推荐的下一张卡片（05 §2.11）；新学员时“从 svc-ec2 开始”或“快速路径”。 */
export function ContinueStrip({ track, summary, rec, recCard, hasEnvironment, newLearner, firstCardId }: ContinueStripProps) {
  if (!track) return null;
  const name = track.title ?? track.id;
  return (
    <div className="contstrip" data-continue="">
      <b>{S.cont.title}</b>
      {newLearner && firstCardId ? (
        <>
          <span>
            <Link to={`/labs/${firstCardId}`}>{t(S.cont.newLearner, { labId: firstCardId, track: name })}</Link>
          </span>
          <span className="muted">·</span>
          <Link to="/tracks/quick-compare">{S.cont.quickPath}</Link>
        </>
      ) : (
        <>
          {/* 路径全部完成且没有推荐时只说完成（不重复路径名，也不显示占位的“—”） */}
          {summary?.completed && !(rec && recCard) ? null : (
            <span>
              {rec?.stageTitle
                ? t(S.cont.path, { track: name, stage: rec.stageTitle, done: summary?.requiredDone ?? 0, total: summary?.requiredTotal ?? 0 })
                : t(S.cont.pathNoStage, { track: name, done: summary?.requiredDone ?? 0, total: summary?.requiredTotal ?? 0 })}
            </span>
          )}
          {rec && recCard ? (
            <span className="rec">
              · {t(PL.recommend, { label: hasEnvironment ? S.cont.recommendAfter : S.cont.recommend })}
              <Link to={`/labs/${recCard.id}`}>{recCard.id}</Link>
              {rich(PL.recCard, {
                difficulty: DIFFICULTY_TEXT[recCard.difficulty],
                n: recCard.estimatedMinutes,
                cost: <CostTierMark tier={recCard.costTier.required} withOptional={recCard.costTier.withOptional} />,
              })}
              {rec.reuseFrom ? <span className="small muted">{t(S.cont.reuseHint, { labId: rec.reuseFrom })}</span> : null}
              <Link className="btn sm" to={`/labs/${recCard.id}`}>
                {S.cont.view}
              </Link>
            </span>
          ) : summary?.completed ? (
            <span>{t(S.cont.done, { track: name })}</span>
          ) : null}
        </>
      )}
    </div>
  );
}
