/**
 * P11 我的实验 `/sessions`（08 P11 列表；01 §8.2 `GET /sessions?state=&labId=`，分页 `limit` + `cursor`）。
 * - 列：开始时间、卡片（id + 标题）、状态胶囊、结束原因、尝试结果、用时、估算费用、清理；行可聚焦，Enter 打开 P11-D；窄屏每个会话一张卡片；
 * - 列表项目前没有尝试结果与费用摘要（§9.2 #15）：这两列显示“—”，在会话详情中查看；
 * - 筛选：状态、卡片（服务端），时间（本页已加载的记录，默认最近 30 天）；写进查询串；
 * - 概览：会话数、实验时长合计、待人工处理（L A）与保留中的环境；
 * - 列表来自 GSI，允许短暂滞后（01 §7.5）：顶部“刷新”，脚注说明。
 */
import { SESSION_STATES, type SessionState } from '@atl/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isApiError, type ApiError } from '../../api/errors';
import { useAuth, useServices } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { formatDate, formatSpan, formatUtcTitle } from '../../lib/format';
import { Button, DataTable, EmptyState, SessionStatePill, Skeleton, Status, SESSION_STATE_META, type Column } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { cardTitle, useCatalogIndex } from './data';
import './pages.css';
import { endReasonText } from './sessionText';

import { t } from '../../i18n';
import { SN } from './strings';
export interface SessionListItem {
  sessionId: string;
  labId: string;
  variant?: string;
  state: SessionState;
  endReason?: string | null;
  createdAt: string;
  readyAt?: string | null;
  endedAt?: string | null;
  deadlineAt?: string | null;
  durationMinutes?: number | null;
  cleanup?: { deleted?: number; manual?: number; failed?: number; hourlyBlocking?: number } | null;
  terminal?: boolean;
}

interface SessionsPage {
  items: SessionListItem[];
  next: string | null;
}

export const RANGES = ['7', '30', '90', 'all'] as const;

export function cleanupCell(s: SessionListItem, role: 'L' | 'A' | 'O' | null): { text: string; shape: 'check' | 'tri' | 'clock' | 'dia' | 'dash'; tone: 'pass' | 'drift' | 'fail' | 'pend' | 'kept' | 'faint' } {
  switch (s.state) {
    case 'CLEANUP_FAILED':
      return role === 'O' ? { text: SN.list.cleanupFailed, shape: 'tri', tone: 'fail' } : { text: t(SN.list.pendingItems, { n: s.cleanup?.manual ?? s.cleanup?.failed ?? 0 }), shape: 'tri', tone: 'drift' };
    case 'ENDING':
    case 'CLEANING':
      return { text: SN.list.inProgress, shape: 'clock', tone: 'pend' };
    case 'KEPT':
      return { text: SN.list.kept, shape: 'dia', tone: 'kept' };
    case 'ENDED':
    case 'FAILED':
      return { text: SN.list.released, shape: 'check', tone: 'pass' };
    default:
      return { text: '—', shape: 'dash', tone: 'faint' };
  }
}

export function durationOf(s: Pick<SessionListItem, 'durationMinutes' | 'readyAt' | 'endedAt'>, nowMs: number): string {
  if (typeof s.durationMinutes === 'number') return formatSpan(s.durationMinutes * 60_000);
  if (s.readyAt) return formatSpan((s.endedAt ? Date.parse(s.endedAt) : nowMs) - Date.parse(s.readyAt));
  return '—';
}

export default function SessionsPage() {
  const { api, clock } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const { manual } = useGlobalStatus();
  const index = useCatalogIndex();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const state = search.get('state') ?? '';
  const labId = search.get('labId') ?? '';
  const range = search.get('range') ?? '30';
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0);
  const [labs, setLabs] = useState<string[]>([]);

  const fetchPage = useCallback(
    (cursor: string | null) => api.call<SessionsPage>('listSessions', { query: { state: state || undefined, labId: labId || undefined, limit: 50, cursor: cursor ?? undefined }, conditional: false }),
    [api, state, labId],
  );

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setMoreError(null);
    fetchPage(null)
      .then((r) => {
        if (cancelled) return;
        const list = r.data?.items ?? [];
        setItems(list);
        setNext(r.data?.next ?? null);
        setStatus('ok');
        if (!state && !labId) setLabs([...new Set(list.map((s) => s.labId))].sort());
      })
      .catch((e: unknown) => {
        if (cancelled || !isApiError(e)) return;
        setError(e);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, reload, state, labId]);

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const r = await fetchPage(next);
      setItems((cur) => [...cur, ...(r.data?.items ?? []).filter((s) => !cur.some((c) => c.sessionId === s.sessionId))]);
      setNext(r.data?.next ?? null);
    } catch (e) {
      if (isApiError(e)) setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const now = clock.now();
  const cutoff = range === 'all' ? null : now - Number(range) * 86_400_000;
  const visible = useMemo(() => items.filter((s) => cutoff === null || Date.parse(s.createdAt) >= cutoff), [items, cutoff]);
  const recent = items.filter((s) => Date.parse(s.createdAt) >= now - 30 * 86_400_000);
  const totalMinutes = recent.reduce((n, s) => n + (typeof s.durationMinutes === 'number' ? s.durationMinutes : 0), 0);
  const ended = recent.filter((s) => s.state === 'ENDED').length;
  const openManual = (manual?.items ?? []).filter((m) => m.cleanupState !== 'RESOLVED_BY_LEARNER' && m.cleanupState !== 'DELETED');
  const kept = items.some((s) => s.state === 'KEPT');
  const labOptions = labs.length ? labs : [...new Set(items.map((s) => s.labId))].sort();

  const setParam = (k: string, v: string) => {
    const nextSp = new URLSearchParams(search);
    if (v) nextSp.set(k, v);
    else nextSp.delete(k);
    setSearch(nextSp, { replace: true });
  };

  const columns: Column<SessionListItem>[] = [
    {
      key: 'createdAt',
      header: SN.list.colStarted,
      render: (s) => (
        <span className="tnum nowrap" title={formatUtcTitle(s.createdAt)}>
          {formatDate(s.createdAt, now)}
        </span>
      ),
      sortValue: (s) => s.createdAt,
    },
    {
      key: 'lab',
      header: SN.list.colCard,
      render: (s) => (
        <span>
          <Link className="mono" to={`/labs/${encodeURIComponent(s.labId)}`} onClick={(e) => e.stopPropagation()}>
            {s.labId}
          </Link>
          {cardTitle(index, s.labId) ? <span className="small faint block-line"> {cardTitle(index, s.labId)}</span> : null}
        </span>
      ),
      sortValue: (s) => s.labId,
    },
    { key: 'state', header: SN.list.colState, render: (s) => <SessionStatePill state={s.state} size="sm" /> },
    { key: 'endReason', header: SN.list.colEndReason, render: (s) => <span className="small">{endReasonText(s.endReason)}</span> },
    {
      key: 'attempt',
      header: SN.list.colAttempt,
      render: () => (
        <span className="small faint">
          —<span className="sr">{SN.list.seeDetail}</span>
        </span>
      ),
    },
    { key: 'duration', header: SN.list.colDuration, numeric: true, render: (s) => durationOf(s, now), sortValue: (s) => s.durationMinutes ?? -1 },
    {
      key: 'cost',
      header: SN.list.colCost,
      render: () => (
        <span className="small faint">
          —<span className="sr">{SN.list.seeDetail}</span>
        </span>
      ),
    },
    { key: 'cleanup', header: SN.list.colCleanup, render: (s) => <Status meta={cleanupCell(s, role)} /> },
  ];

  return (
    <div className="stack-16" data-screen="P11">
      <div className="ph">
        <div className="ttl">
          <h1 tabIndex={-1}>{SN.list.title}</h1>
          {role !== 'L' ? <span className="sub">{SN.list.readOnlySub}</span> : null}
        </div>
        <span className="acts">
          <Button size="sm" icon="refresh" onClick={() => setReload((x) => x + 1)}>
            {SN.list.refresh}
          </Button>
        </span>
      </div>

      <div className="box stack-4" data-section="overview">
        <b>{SN.list.overview}</b>
        <span className="small">
          {t(SN.list.overviewLine, { n: recent.length, ended, total: formatSpan(totalMinutes * 60_000) })}
        </span>
        {role !== 'O' ? (
          <span className="small">
            {t(SN.list.manualPending, { n: openManual.length })}
            {openManual.length ? t(SN.list.manualHourly, { n: openManual.filter((m) => m.billing === 'hourly').length }) : ''}
            {openManual.length ? (
              <>
                {' '}
                <Link to="/resources/manual">{SN.list.view}</Link>
              </>
            ) : null}{' '}
            {t(SN.list.keptEnv, { v: kept ? SN.list.yes : SN.list.no })}
          </span>
        ) : null}
      </div>

      <div className="filters" role="group" aria-label={SN.list.filters}>
        <span className="fi">
          <label className="small muted" htmlFor="sf-state">
            {SN.list.state}
          </label>
          <select id="sf-state" className="input" value={state} onChange={(e) => setParam('state', e.target.value)}>
            <option value="">{SN.list.all}</option>
            {SESSION_STATES.map((s) => (
              <option key={s} value={s}>
                {SESSION_STATE_META[s].text}
              </option>
            ))}
          </select>
        </span>
        <span className="fi">
          <label className="small muted" htmlFor="sf-lab">
            {SN.list.card}
          </label>
          <select id="sf-lab" className="input" value={labId} onChange={(e) => setParam('labId', e.target.value)}>
            <option value="">{SN.list.all}</option>
            {labOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </span>
        <span className="fi">
          <label className="small muted" htmlFor="sf-range">
            {SN.list.time}
          </label>
          <select id="sf-range" className="input" value={range} onChange={(e) => setParam('range', e.target.value === '30' ? '' : e.target.value)}>
            {RANGES.map((v) => (
              <option key={v} value={v}>
                {SN.list.range[v]}
              </option>
            ))}
          </select>
        </span>
      </div>

      {status === 'loading' ? (
        <Skeleton lines={5} block label={SN.list.loading} />
      ) : status === 'error' ? (
        <InlineProblem error={error} onRetry={() => setReload((x) => x + 1)} title={SN.list.title} />
      ) : !items.length && !state && !labId ? (
        <EmptyState
          title={SN.list.emptyTitle}
          action={
            <Link className="btn primary" to="/labs">
              {SN.list.toCatalog}
            </Link>
          }
        />
      ) : !visible.length ? (
        <EmptyState
          title={SN.list.noMatch}
          action={
            <button type="button" className="btn" onClick={() => setSearch(new URLSearchParams(), { replace: true })}>
              {SN.list.clearFilters}
            </button>
          }
        >
          {next ? SN.list.olderNotLoaded : null}
        </EmptyState>
      ) : (
        <DataTable columns={columns} rows={visible} rowKey={(s) => s.sessionId} caption={SN.list.caption} cardify onRowClick={(s) => navigate(`/sessions/${s.sessionId}`)} />
      )}

      {status === 'ok' && next ? (
        <div className="row">
          <Button onClick={() => void loadMore()} busy={loadingMore} busyText={SN.list.loadingMore}>
            {SN.list.loadMore}
          </Button>
          {moreError ? (
            <span className="small">
              {SN.list.loadFailed}{' '}
              <button type="button" className="linkbtn" onClick={() => void loadMore()}>
                {SN.list.retry}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      <p className="small faint">{SN.list.footnote}</p>
    </div>
  );
}
