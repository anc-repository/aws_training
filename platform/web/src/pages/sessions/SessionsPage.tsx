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

export const RANGES = [
  ['7', '最近 7 天'],
  ['30', '最近 30 天'],
  ['90', '最近 90 天'],
  ['all', '全部'],
] as const;

export function cleanupCell(s: SessionListItem, role: 'L' | 'A' | 'O' | null): { text: string; shape: 'check' | 'tri' | 'clock' | 'dia' | 'dash'; tone: 'pass' | 'drift' | 'fail' | 'pend' | 'kept' | 'faint' } {
  switch (s.state) {
    case 'CLEANUP_FAILED':
      return role === 'O' ? { text: '释放未完成', shape: 'tri', tone: 'fail' } : { text: `${s.cleanup?.manual ?? s.cleanup?.failed ?? 0} 项待处理`, shape: 'tri', tone: 'drift' };
    case 'ENDING':
    case 'CLEANING':
      return { text: '进行中', shape: 'clock', tone: 'pend' };
    case 'KEPT':
      return { text: '保留中', shape: 'dia', tone: 'kept' };
    case 'ENDED':
    case 'FAILED':
      return { text: '已释放', shape: 'check', tone: 'pass' };
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
      header: '开始时间',
      render: (s) => (
        <span className="tnum nowrap" title={formatUtcTitle(s.createdAt)}>
          {formatDate(s.createdAt, now)}
        </span>
      ),
      sortValue: (s) => s.createdAt,
    },
    {
      key: 'lab',
      header: '卡片',
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
    { key: 'state', header: '状态', render: (s) => <SessionStatePill state={s.state} size="sm" /> },
    { key: 'endReason', header: '结束原因', render: (s) => <span className="small">{endReasonText(s.endReason)}</span> },
    {
      key: 'attempt',
      header: '尝试结果',
      render: () => (
        <span className="small faint">
          —<span className="sr">（在会话详情中查看）</span>
        </span>
      ),
    },
    { key: 'duration', header: '用时', numeric: true, render: (s) => durationOf(s, now), sortValue: (s) => s.durationMinutes ?? -1 },
    {
      key: 'cost',
      header: '估算费用',
      render: () => (
        <span className="small faint">
          —<span className="sr">（在会话详情中查看）</span>
        </span>
      ),
    },
    { key: 'cleanup', header: '清理', render: (s) => <Status meta={cleanupCell(s, role)} /> },
  ];

  return (
    <div className="stack-16" data-screen="P11">
      <div className="ph">
        <div className="ttl">
          <h1 tabIndex={-1}>我的实验</h1>
          {role !== 'L' ? <span className="sub">学员的实验记录（只读）</span> : null}
        </div>
        <span className="acts">
          <Button size="sm" icon="refresh" onClick={() => setReload((x) => x + 1)}>
            刷新
          </Button>
        </span>
      </div>

      <div className="box stack-4" data-section="overview">
        <b>概览（最近 30 天）</b>
        <span className="small">
          会话 {recent.length} · 已结束 {ended} · 实验时长合计 {formatSpan(totalMinutes * 60_000)} · 估算费用：在各会话详情中查看
        </span>
        {role !== 'O' ? (
          <span className="small">
            待人工处理 {openManual.length} 项
            {openManual.length ? `（${openManual.filter((m) => m.billing === 'hourly').length} 项按小时计费）` : ''}
            {openManual.length ? (
              <>
                {' '}
                <Link to="/resources/manual">查看</Link>
              </>
            ) : null}{' '}
            · 保留中的环境：{kept ? '有' : '无'}
          </span>
        ) : null}
      </div>

      <div className="filters" role="group" aria-label="筛选">
        <span className="fi">
          <label className="small muted" htmlFor="sf-state">
            状态
          </label>
          <select id="sf-state" className="input" value={state} onChange={(e) => setParam('state', e.target.value)}>
            <option value="">全部</option>
            {SESSION_STATES.map((s) => (
              <option key={s} value={s}>
                {SESSION_STATE_META[s].text}
              </option>
            ))}
          </select>
        </span>
        <span className="fi">
          <label className="small muted" htmlFor="sf-lab">
            卡片
          </label>
          <select id="sf-lab" className="input" value={labId} onChange={(e) => setParam('labId', e.target.value)}>
            <option value="">全部</option>
            {labOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </span>
        <span className="fi">
          <label className="small muted" htmlFor="sf-range">
            时间
          </label>
          <select id="sf-range" className="input" value={range} onChange={(e) => setParam('range', e.target.value === '30' ? '' : e.target.value)}>
            {RANGES.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </span>
      </div>

      {status === 'loading' ? (
        <Skeleton lines={5} block label="正在读取实验记录" />
      ) : status === 'error' ? (
        <InlineProblem error={error} onRetry={() => setReload((x) => x + 1)} title="我的实验" />
      ) : !items.length && !state && !labId ? (
        <EmptyState
          title="还没有实验记录。"
          action={
            <Link className="btn primary" to="/labs">
              去卡片目录开始第一张 →
            </Link>
          }
        />
      ) : !visible.length ? (
        <EmptyState
          title="没有符合条件的会话。"
          action={
            <button type="button" className="btn" onClick={() => setSearch(new URLSearchParams(), { replace: true })}>
              清除筛选
            </button>
          }
        >
          {next ? '较早的记录还没有加载，可以先加载更多。' : null}
        </EmptyState>
      ) : (
        <DataTable columns={columns} rows={visible} rowKey={(s) => s.sessionId} caption="我的实验会话" cardify onRowClick={(s) => navigate(`/sessions/${s.sessionId}`)} />
      )}

      {status === 'ok' && next ? (
        <div className="row">
          <Button onClick={() => void loadMore()} busy={loadingMore} busyText="正在加载…">
            加载更多
          </Button>
          {moreError ? (
            <span className="small">
              加载失败 ·{' '}
              <button type="button" className="linkbtn" onClick={() => void loadMore()}>
                重试
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      <p className="small faint">刚结束的会话可能晚几秒出现在列表中，可以点“刷新”。行可聚焦，按 Enter 打开会话详情。</p>
    </div>
  );
}
