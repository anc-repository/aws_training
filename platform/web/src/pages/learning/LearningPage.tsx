/**
 * P10 我的学习 `/learning?tab=tracks|mastery|badges|history&cell=<服务格 id>`（08 §4 P10；tracks-and-catalog §4、§5；05 §2.5）。
 * - 页签会改变 URL：`<nav>` + 链接 + aria-current="page"；窄屏改为下拉（§8.8）；
 * - 路径进度：每条路径的必修 / 选修组 / 已核验占比与阈值、分段条、证书状态、推荐下一张（当前路径），学员可“设为当前路径”；
 * - 服务掌握度：与目录同一个 ServiceMap + ServiceCellPanel；徽章墙：按类别分组，可按等级、状态筛选；最近实验：GET /sessions?limit=10；
 * - 助教、观察者看到的是学员的数据（页头“学员 张三 的学习进度”，08 §9.2 #21），没有“设为当前路径”；
 * - 视觉化（I6 f）：路径进度用进度环（计入 / 最少完成）+ 分段条；服务掌握度用进度环（已掌握以上的占比）+ 各等级服务数的条形图
 *   （条形图本身是数据表，08 §6.12）；徽章墙标题旁是已获得徽章的进度环；
 * - 进入与重新可见时刷新；收到 badge.* / track.* / certificate.* / mastery.regression 事件时刷新（§7.5）。
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, useServices, useSessionEvents } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { msg, t } from '../../i18n';
import { announce } from '../../lib/announce';
import { formatDate, formatSpan } from '../../lib/format';
import { CostTierMark, DataTable, Drawer, EmptyState, ErrorPanel, SessionStatePill, Shape, Skeleton, type Column } from '../../ui';
import { BarChart, ProgressRing } from '../../ui/charts';
import '../labs/catalog.css';
import { CardBadge } from '../labs/components/CardTile';
import { CardGlyph } from '../labs/components/Visuals';
import { badgeStateOf, badgeStateText, SegmentedProgress } from '../labs/components/Marks';
import { masteryCounts, ServiceCellPanel, ServiceMap } from '../labs/components/ServiceMap';
import { CertStateText, type CertState } from '../labs/components/TrackView';
import { useCatalog, useHolder, useLabs, useResource, useSetCurrentTrack } from '../labs/data';
import { categoryLabel, pct, recommendNext, serviceOf, trackSummary, type ProgressLike } from '../labs/model';
import { BADGE_LEVEL_TEXT, DIFFICULTY_TEXT, MASTERY_META, S } from '../labs/strings';
import type { CatalogCard, CertificateItem, Taxonomy, LabItem, MasteryView, MyProgressView, ProgressRecordView, ServiceMasteryView, SessionListItem, TracksListView } from '../labs/types';
import { LS } from './strings';

type Tab = 'tracks' | 'mastery' | 'badges' | 'history';
const TABS: readonly Tab[] = ['tracks', 'mastery', 'badges', 'history'];
const EVENT_PREFIXES = ['badge.', 'track.', 'certificate.', 'mastery.'] as const;

function cleanupText(s: SessionListItem, observer: boolean): { meta: { text: string; shape: 'tri' | 'clock' | 'dia' | 'check' | 'dash'; tone: string } } {
  if (s.state === 'CLEANUP_FAILED') {
    const n = s.cleanup?.manual ?? s.cleanup?.hourlyBlocking ?? 0;
    return { meta: { text: observer || !n ? LS.history.cleanupFailed : t(LS.history.cleanupPending, { n }), shape: 'tri', tone: 'drift' } };
  }
  if (s.state === 'ENDING' || s.state === 'CLEANING') return { meta: { text: LS.history.cleanupRunning, shape: 'clock', tone: 'pend' } };
  if (s.state === 'KEPT') return { meta: { text: LS.history.cleanupKept, shape: 'dia', tone: 'kept' } };
  if (s.state === 'ENDED' || s.state === 'FAILED') return { meta: { text: LS.history.cleanupDone, shape: 'check', tone: 'pass' } };
  return { meta: { text: '—', shape: 'dash', tone: 'mut' } };
}

export default function LearningPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const { api, clock } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const L = role === 'L';
  const status = useGlobalStatus();
  const tabParam = sp.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'tracks';
  const cellParam = sp.get('cell');
  const catalog = useCatalog();
  const labs = useLabs();
  const holder = useHolder(labs.data);
  const progress = useResource<MyProgressView>('my-progress', () => api.get<MyProgressView>('getMyProgress'), { refreshOnVisible: true });
  const tracksList = useResource<TracksListView>(tab === 'tracks' ? 'tracks' : null, () => api.get<TracksListView>('listTracks'), { refreshOnVisible: true });
  const certs = useResource<{ items: CertificateItem[] }>(tab === 'tracks' ? 'certificates' : null, () => api.get<{ items: CertificateItem[] }>('listCertificates'), { refreshOnVisible: true });
  const mastery = useResource<MasteryView>(tab === 'mastery' ? 'mastery' : null, () => api.get<MasteryView>('getMyMastery'), { refreshOnVisible: true });
  const sessions = useResource<{ items: SessionListItem[] }>(tab === 'history' ? 'sessions-10' : null, () => api.get<{ items: SessionListItem[] }>('listSessions', { query: { limit: 10 } }), {
    refreshOnVisible: true,
  });
  const setCurrentTrack = useSetCurrentTrack();
  const [busyTrack, setBusyTrack] = useState<string | null>(null);
  const [badgeOpen, setBadgeOpen] = useState<string | null>(null);
  const [onlyEarned, setOnlyEarned] = useState(false);
  const [levelFilter, setLevelFilter] = useState<'all' | 'verified' | 'attested' | 'self-reported' | 'pending' | 'withdrawn'>('all');

  useSessionEvents(
    () => {
      progress.reload();
      if (tab === 'tracks') {
        tracksList.reload();
        certs.reload();
      }
      if (tab === 'mastery') mastery.reload();
    },
    { prefixes: EVENT_PREFIXES },
  );

  const records = useMemo(() => new Map<string, ProgressRecordView>((progress.data?.labs ?? []).map((r) => [r.labId, r])), [progress.data]);
  const progMap = useMemo(() => new Map<string, ProgressLike>([...records].map(([k, v]) => [k, { status: v.status, badge: v.badge ?? null }])), [records]);
  const items = useMemo(() => new Map<string, LabItem>((labs.data?.items ?? []).map((i) => [i.labId, i])), [labs.data]);
  const masteryMap = useMemo(() => (mastery.data ? new Map<string, ServiceMasteryView>(mastery.data.services.map((m) => [m.id, m])) : null), [mastery.data]);

  const setTab = (next: Tab) => {
    const q = new URLSearchParams();
    if (next !== 'tracks') q.set('tab', next);
    setSp(q);
  };
  const tabHref = (k: Tab) => (k === 'tracks' ? '/learning' : `/learning?tab=${k}`);

  const header = (
    <div className="ph">
      <div className="stack-4">
        <h1 tabIndex={-1}>{LS.title}</h1>
        {!L && progress.data?.subject?.displayName ? <span className="sub">{t(LS.subject, { name: progress.data.subject.displayName })}</span> : null}
        {!L && !progress.data?.subject?.displayName ? <span className="sub">{LS.subjectAnon}</span> : null}
      </div>
      <span className="spacer" />
      <nav className="tabs hide-sm" aria-label={LS.title}>
        {TABS.map((k) => (
          <Link key={k} to={tabHref(k)} aria-current={tab === k ? 'page' : undefined}>
            {LS.tabs[k]}
          </Link>
        ))}
      </nav>
      <select className="input only-sm" aria-label={LS.tabSelect} value={tab} onChange={(e) => setTab(e.target.value as Tab)}>
        {TABS.map((k) => (
          <option key={k} value={k}>
            {LS.tabs[k]}
          </option>
        ))}
      </select>
    </div>
  );

  if (catalog.error && !catalog.index) {
    return (
      <div className="stack-16">
        {header}
        <ErrorPanel error={catalog.error} onRetry={catalog.reload} />
      </div>
    );
  }
  if (!catalog.index) {
    return (
      <div className="stack-16">
        {header}
        <Skeleton lines={6} block />
      </div>
    );
  }
  const index = catalog.index;
  const tax = index.taxonomy;
  const currentTrackId = status.me?.currentTrackId ?? labs.data?.currentTrackId ?? 'saa-main';

  const onSetTrack = async (trackId: string) => {
    setBusyTrack(trackId);
    try {
      await setCurrentTrack(trackId);
      await status.refreshMe();
      announce(t(S.track.setCurrentDone, { name: catalog.tracks.get(trackId)?.title ?? trackId }));
    } catch {
      /* 失败时保持原样 */
    } finally {
      setBusyTrack(null);
    }
  };

  let body: JSX.Element;
  if (tab === 'tracks') {
    if (progress.error && !progress.data) body = <ErrorPanel error={progress.error} onRetry={progress.reload} />;
    else if (!progress.data) body = <Skeleton lines={6} />;
    else {
      const ordered = [...index.tracks].sort((a, b) => (a.id === currentTrackId ? -1 : b.id === currentTrackId ? 1 : 0));
      body = (
        <div className="stack-8" data-tab="tracks">
          {ordered.map((tr) => {
            const p = trackSummary(tr, progMap, holder?.labId);
            const isCur = tr.id === currentTrackId;
            const serverEligible = tracksList.data?.items.find((x) => x.id === tr.id)?.progress?.eligible;
            const mine = (certs.data?.items ?? []).filter((c) => c.trackId === tr.id);
            const cert: CertState = mine.some((c) => c.status === 'valid') ? 'claimed' : (serverEligible ?? p.eligible) ? 'eligible' : mine.some((c) => c.status === 'revoked') ? 'revoked' : 'not-yet';
            const rec = isCur ? recommendNext(tr, progMap, holder, catalog.cards) : null;
            const rc = rec ? catalog.cards.get(rec.labId) : null;
            return (
              <div key={tr.id} className={isCur ? 'box stack-8 cur lp-track' : 'box stack-8 lp-track'} data-track-row={tr.id}>
                <ProgressRing value={p.counted} max={Math.max(1, p.min)} size={56} label={t(LS.visual.trackRing, { track: tr.title ?? tr.id })} />
                <div className="stack-8 grow">
                <div className="row between">
                  <b>
                    {isCur ? '★ ' : ''}
                    {tr.title ?? tr.id}
                    {isCur ? LS.tracks.currentSuffix : ''}
                  </b>
                  <span className="small">
                    {LS.tracks.cert}
                    <CertStateText state={cert} />
                    {cert === 'revoked' ? <span className="muted">{LS.tracks.revokedNote}</span> : null}
                  </span>
                </div>
                <div className="row small">
                  <span>
                    {t(S.track.head, { done: p.requiredDone, total: p.requiredTotal })}
                    {p.groups ? t(S.track.groups, { done: p.groupsDone, total: p.groups }) : ''}
                    {t(S.track.verified, { pct: pct(p.ratio), min: pct(p.minRatio) })}
                    {t(S.track.counted, { n: p.counted, min: p.min })}
                  </span>
                  <SegmentedProgress verified={p.verified} attested={p.attested} inProgress={p.inProgress} min={p.min} />
                </div>
                {p.pending.length ? <div className="small muted">{t(LS.tracks.pending, { n: p.pending.length, list: p.pending.join(msg.pages.labs.listSep) })}</div> : null}
                {rc ? (
                  <div className="small">
                    {LS.tracks.next}
                    <CardGlyph card={rc} size={20} max={2} />
                    <Link to={`/labs/${rc.id}`}>{rc.id}</Link> · {DIFFICULTY_TEXT[rc.difficulty]}
                    {t(msg.frame.about, { n: rc.estimatedMinutes })}{' '}
                    <CostTierMark tier={rc.costTier.required} withOptional={rc.costTier.withOptional} />
                  </div>
                ) : null}
                <div className="row">
                  <Link className="btn sm" to={`/tracks/${tr.id}`}>
                    {LS.tracks.view}
                  </Link>
                  {L && !isCur ? (
                    <button type="button" className="btn sm ghost" disabled={busyTrack === tr.id} aria-busy={busyTrack === tr.id || undefined} onClick={() => void onSetTrack(tr.id)}>
                      {S.track.setCurrent}
                    </button>
                  ) : null}
                </div>
                </div>
              </div>
            );
          })}
        </div>
      );
    }
  } else if (tab === 'mastery') {
    const c = masteryCounts(catalog.cells, masteryMap);
    const selected = cellParam ? (catalog.cells.find((x) => x.id === cellParam) ?? null) : null;
    body = (
      <div className="stack" data-tab="mastery">
        {mastery.error && !mastery.data ? (
          <div className="note amber" role="status">
            <span className="grow">{S.catalog.masteryUnavailable}</span>
            <button type="button" className="btn sm" onClick={mastery.reload}>
              {S.catalog.retry}
            </button>
          </div>
        ) : null}
        {mastery.data ? (
          <div className="lp-mastery" data-mastery-summary="">
            <ProgressRing value={c.proficient + c.mastered} max={Math.max(1, catalog.cells.length)} size={72} label={LS.visual.masteryRing} />
            <div className="grow">
              <BarChart
                caption={t(LS.visual.masteryChart, { n: catalog.cells.length })}
                max={Math.max(1, catalog.cells.length)}
                itemHeader={LS.visual.level}
                valueHeader={LS.visual.services}
                data={[
                  ...(['proficient', 'mastered', 'touched', 'not_started'] as const).map((lv) => ({
                    key: lv,
                    label: MASTERY_META[lv].text,
                    icon: <Shape name={MASTERY_META[lv].shape} />,
                    value: c[lv],
                    tone: lv === 'not_started' ? ('before' as const) : ('after' as const),
                  })),
                  { key: 'review', label: S.map.needsReview, icon: <Shape name="tri" />, value: c.review, tone: 'third' as const },
                ]}
              />
              <p className="sr">{t(S.map.summary, { n: catalog.cells.length, pro: c.proficient, m: c.mastered, t: c.touched, none: c.not_started, review: c.review })}</p>
            </div>
          </div>
        ) : (
          <p className="small">{t(LS.visual.masteryTitleN, { title: LS.mastery.title, n: catalog.cells.length })}</p>
        )}
        <ServiceMap
          cells={catalog.cells}
          tax={tax}
          mastery={masteryMap}
          progress={progMap}
          selected={cellParam}
          onSelect={(id) => setSp({ tab: 'mastery', cell: id })}
        />
        <ServiceCellPanel
          cell={selected}
          index={index}
          cards={catalog.cards}
          mastery={selected ? (masteryMap?.get(selected.id) ?? null) : null}
          items={items}
          holder={holder}
          onClose={() => setSp({ tab: 'mastery' }, { replace: true })}
        />
      </div>
    );
  } else if (tab === 'badges') {
    const all = index.cards;
    const shown = all.filter((card) => {
      const st = badgeStateOf(records.get(card.id)?.badge);
      if (onlyEarned && st === 'none') return false;
      if (levelFilter !== 'all' && st !== levelFilter) return false;
      return true;
    });
    const earned = all.filter((card) => badgeStateOf(records.get(card.id)?.badge) !== 'none').length;
    const groups = [...tax.categories.map((cat) => ({ id: cat.id, title: categoryLabel(tax, cat.id), cards: shown.filter((x) => x.kind === 'service' && x.category === cat.id) })), { id: 'sc', title: S.catalog.sectionScenario, cards: shown.filter((x) => x.kind === 'scenario') }].filter(
      (g) => g.cards.length,
    );
    const open = badgeOpen ? (catalog.cards.get(badgeOpen) ?? null) : null;
    body = (
      <section className="sec" aria-labelledby="bw-h" data-tab="badges">
        <h2 id="bw-h">
          <ProgressRing value={earned} max={Math.max(1, all.length)} size={28} label={LS.visual.badgesRing} showValue={false} />{' '}
          {t(LS.badges.title, { n: earned, total: all.length })}
          <span className="aside row">
            <label className="chk">
              <input type="checkbox" checked={onlyEarned} onChange={(e) => setOnlyEarned(e.target.checked)} />
              <span>{LS.badges.onlyEarned}</span>
            </label>
            <select className="input inline" aria-label={LS.badges.level} value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as typeof levelFilter)}>
              <option value="all">{LS.badges.levelAll}</option>
              <option value="verified">{BADGE_LEVEL_TEXT.verified}</option>
              <option value="attested">{BADGE_LEVEL_TEXT.attested}</option>
              <option value="self-reported">{BADGE_LEVEL_TEXT['self-reported']}</option>
              <option value="pending">{S.card.badgePending}</option>
              <option value="withdrawn">{S.card.badgeWithdrawn}</option>
            </select>
          </span>
        </h2>
        {progress.error && !progress.data ? <ErrorPanel error={progress.error} onRetry={progress.reload} /> : null}
        {!earned && progress.data && !onlyEarned ? (
          <EmptyState
            action={
              <Link className="btn" to="/labs/svc-ec2">
                {LS.badges.emptyAction}
              </Link>
            }
          >
            {LS.badges.empty}
          </EmptyState>
        ) : null}
        <div className="bwall">
          {groups.map((g) => (
            <div key={g.id} className="stack-8">
              <b className="small">{g.title}</b>
              <div className="bw-row">
                {g.cards.map((card) => {
                  const b = records.get(card.id)?.badge ?? null;
                  return (
                    <button key={card.id} type="button" className="btn ghost bwbtn" onClick={() => setBadgeOpen(card.id)} data-badge-card={card.id}>
                      <CardBadge card={card} tax={tax} badge={b} size={40} />
                      <span className="small">{card.badge?.title ?? card.id}</span>
                      <span className="xs faint">{badgeStateText(badgeStateOf(b))}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <BadgeDrawer card={open} record={open ? (records.get(open.id) ?? null) : null} tax={tax} onClose={() => setBadgeOpen(null)} nowMs={clock.now()} />
      </section>
    );
  } else {
    const observer = role === 'O';
    const cols: Column<SessionListItem>[] = [
      { key: 'at', header: LS.history.start, render: (s) => <span className="tnum nowrap">{formatDate(s.createdAt, clock.now())}</span> },
      {
        key: 'card',
        header: LS.history.card,
        render: (s) => (
          <span>
            <Link className="mono" to={`/labs/${s.labId}`}>
              {s.labId}
            </Link>
            <span className="small faint h1-sub">{catalog.cards.get(s.labId)?.title ?? ''}</span>
          </span>
        ),
      },
      { key: 'state', header: LS.history.state, render: (s) => <SessionStatePill state={s.state} size="sm" /> },
      { key: 'dur', header: LS.history.duration, numeric: true, render: (s) => (s.durationMinutes != null ? formatSpan(s.durationMinutes * 60_000) : '—') },
      {
        key: 'clean',
        header: LS.history.cleanup,
        render: (s) => {
          const m = cleanupText(s, observer).meta;
          return (
            <span className={`st ${m.tone}`}>
              <Shape name={m.shape} />
              <span className="t">{m.text}</span>
            </span>
          );
        },
      },
      {
        key: 'go',
        header: '',
        render: (s) =>
          s.readyAt && (s.state === 'ENDED' || s.state === 'CLEANUP_FAILED') ? (
            <Link className="btn sm" to={`/sessions/${s.sessionId}/report`} onClick={(e) => e.stopPropagation()}>
              {LS.history.report}
            </Link>
          ) : null,
      },
    ];
    body = (
      <div className="stack" data-tab="history">
        {sessions.error && !sessions.data ? <ErrorPanel error={sessions.error} onRetry={sessions.reload} /> : null}
        {sessions.data ? (
          <DataTable
            columns={cols}
            rows={sessions.data.items}
            rowKey={(s) => s.sessionId}
            caption={LS.tabs.history}
            cardify
            onRowClick={(s) => navigate(`/sessions/${s.sessionId}`)}
            empty={
              <EmptyState
                action={
                  <Link className="btn" to="/labs">
                    {LS.history.emptyAction}
                  </Link>
                }
              >
                {LS.history.empty}
              </EmptyState>
            }
          />
        ) : !sessions.error ? (
          <Skeleton lines={4} />
        ) : null}
        <p>
          <Link to="/sessions">{LS.history.all}</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="stack-16" data-screen="P10" data-tab={tab}>
      {header}
      {body}
    </div>
  );
}

function BadgeDrawer({ card, record, tax, onClose, nowMs }: { card: CatalogCard | null; record: ProgressRecordView | null; tax: Taxonomy; onClose: () => void; nowMs: number }) {
  const b = record?.badge ?? null;
  const st = badgeStateOf(b);
  return (
    <Drawer open={!!card} onClose={onClose} title={card ? t(LS.badges.drawerTitle, { title: card.badge?.title ?? card.id }) : ''}>
      {card ? (
        <div className="stack-16" data-badge-drawer={card.id}>
          <div className="row nowrap-row">
            <CardBadge card={card} tax={tax} badge={b} size={40} />
            <div className="stack-4">
              <b className="mono">{card.id}</b>
              <span className="small">{card.title}</span>
            </div>
          </div>
          {b && st !== 'none' ? (
            <dl className="kv">
              <dt>{LS.badges.level}</dt>
              <dd>{badgeStateText(st)}</dd>
              {typeof b.evidenceScore === 'number' ? (
                <>
                  <dt>{LS.badges.evidence}</dt>
                  <dd className="tnum">{b.evidenceScore.toFixed(2)}</dd>
                </>
              ) : null}
              {b.earnedAt ? (
                <>
                  <dt>{LS.badges.earnedAt}</dt>
                  <dd>{formatDate(b.earnedAt, nowMs)}</dd>
                </>
              ) : null}
              {b.attemptId ? (
                <>
                  <dt>{LS.badges.attempt}</dt>
                  <dd>
                    <Link to={`/sessions/${b.attemptId}/report`}>{LS.badges.report}</Link> · <span className="mono">{b.attemptId}</span>
                  </dd>
                </>
              ) : null}
              <dt>{LS.badges.variant}</dt>
              <dd>{b.variant ?? 'default'}</dd>
              <dt>{LS.badges.version}</dt>
              <dd>{b.labVersion ?? '—'}</dd>
              <dt>{LS.badges.quiz}</dt>
              <dd>{b.quiz?.bestScore != null ? t(LS.badges.quizBest, { s: b.quiz.bestScore }) : LS.badges.quizNone}</dd>
              <dt>{LS.badges.credits}</dt>
              <dd>{(card.credits ?? []).map((id) => serviceOf(tax, id)?.name ?? id).join(msg.pages.labs.listSep) || '—'}</dd>
            </dl>
          ) : (
            <>
              <p>{LS.badges.notEarned}</p>
              <Link className="btn" to={`/labs/${card.id}`}>
                {LS.badges.openCard}
              </Link>
            </>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
