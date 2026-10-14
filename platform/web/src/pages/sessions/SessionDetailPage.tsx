/**
 * P11-D 会话详情 `/sessions/:sid`（08 P11-D；§2.5：站内通知与邮件链接一律指向这里，由它按状态给出去向）。
 * - 页头：卡片 · 会话、状态胶囊、结束原因、时间范围、环境；主按钮按状态：回到工作台 / 查看回收进度（管理保留）/ 报告 + 回收；
 * - 页签（改变 URL：`?tab=timeline|resources|cost|ops|audit`，nav + aria-current；窄屏为下拉）：
 *   时间线（`GET …/events` 从头分页拉取；进行中的会话随事件刷新；可按类别筛选）、资源（L A）、费用（L A）、平台动作、审计（L A）；
 *   观察者没有资源、费用、审计页签（01 §8.2），直接访问时原位置显示“角色不足”；
 * - 404 → “没有这个会话”。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { SessionEvent, SessionView } from '../../api/types';
import { isApiError, type ApiError } from '../../api/errors';
import { useAuth, useServices, useSessionEvents } from '../../app/context';
import { neverReady } from '../../app/sessionRouting';
import { msg, rich, t, withText } from '../../i18n';
import { formatClock, formatDate, formatUtcTitle } from '../../lib/format';
import { redact } from '../../lib/redact';
import { BILLING_TEXT, CLEANUP_STATE_META, ErrorPanel, SessionStatePill, Skeleton, Status } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { Missing } from '../errors/NotFoundPage';
import { normalizeResource } from '../end/resources';
import { ResourceStages } from '../end/ResourceStages';
import { useApiData, useSessionView, viewX, type SessionViewX } from './data';
import { categoryOf, CATEGORY_TEXT, eventText, type EventCategory } from './eventText';
import './pages.css';
import { endReasonText, formatMoneyRange, hourlyRange } from './sessionText';

import { SN } from './strings';
type BillingLike = keyof typeof BILLING_TEXT;
type Tab = 'timeline' | 'resources' | 'cost' | 'ops' | 'audit';
const D = SN.detail;
const TABS: readonly Tab[] = ['timeline', 'resources', 'cost', 'ops', 'audit'];
const LA_ONLY: readonly Tab[] = ['resources', 'cost', 'audit'];
const LIVE = ['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING'];
const WIND = ['ENDING', 'CLEANING', 'CLEANUP_FAILED', 'KEPT'];

export default function SessionDetailPage() {
  const { sid = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const { clock } = useServices();
  const { view, status, error, retry } = useSessionView(sid);
  const raw = search.get('tab') as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : 'timeline';
  if (status === 'missing') return <Missing title={D.noSession} />;
  if (status === 'error' && !view) return <ErrorPanel error={error ?? { code: 'INTERNAL' }} onRetry={retry} title={D.title} />;
  if (!view) return <Skeleton lines={5} block label={D.reading} />;
  const v = viewX(view);
  const tabs = TABS.filter((k) => role !== 'O' || !LA_ONLY.includes(k));
  const href = (k: Tab) => (k === 'timeline' ? `/sessions/${sid}` : `/sessions/${sid}?tab=${k}`);
  const denied = role === 'O' && LA_ONLY.includes(tab);
  const nr = neverReady(view);
  const now = clock.now();

  return (
    <div className="stack-16" data-screen="P11-D" data-tab={tab}>
      <div>
        <nav className="crumbs-row" aria-label={D.crumbs}>
          <Link to="/sessions">{D.mySessions}</Link>
          <span aria-hidden="true">›</span>
          <span className="mono">{sid}</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>
              {rich(D.heading, { labId: view.labId, sid: <span className="mono">{sid}</span> })}
            </h1>
            <span className="sub">
              <SessionStatePill state={view.state} size="sm" /> · {LIVE.includes(view.state) ? D.inProgress : endReasonText(view.endReason)} ·{' '}
              <span title={formatUtcTitle(view.createdAt)}>{formatDate(view.createdAt, now)}</span>～{view.endedAt ? <span title={formatUtcTitle(view.endedAt)}>{formatClock(view.endedAt)}</span> : '—'}
              {view.env?.envName ? rich(D.env, { name: <span className="mono">{view.env.envName}</span> }) : null}
            </span>
          </div>
          <span className="acts">
            {LIVE.includes(view.state) ? (
              <Link className="btn primary" to={`/workspace/${sid}`}>
                {D.backToWorkspace}
              </Link>
            ) : WIND.includes(view.state) ? (
              <Link className="btn primary" to={view.state === 'CLEANUP_FAILED' ? `/sessions/${sid}/end#manual` : `/sessions/${sid}/end`}>
                {view.state === 'KEPT' ? D.manageKeep : D.viewReclaim}
              </Link>
            ) : (
              <>
                {!nr ? (
                  <Link className="btn" to={`/sessions/${sid}/report`}>
                    {D.report}
                  </Link>
                ) : null}
                <Link className="btn" to={`/sessions/${sid}/end`}>
                  {D.reclaim}
                </Link>
              </>
            )}
          </span>
        </div>
      </div>

      <nav className="tabs collapse-sm" aria-label={D.title}>
        {tabs.map((k) => (
          <Link key={k} to={href(k)} aria-current={k === tab ? 'page' : undefined} replace>
            {D.tab[k]}
          </Link>
        ))}
      </nav>
      <div className="tabs-select">
        <label className="sr" htmlFor="sd-tab">
          {D.tabs}
        </label>
        <select id="sd-tab" className="input" value={tab} onChange={(e) => navigate(href(e.target.value as Tab), { replace: true })}>
          {tabs.map((k) => (
            <option key={k} value={k}>
              {D.tab[k]}
            </option>
          ))}
        </select>
      </div>

      {denied ? (
        <div className="note" role="status" data-problem="role">
          <span>
            {t(msg.p13.roleDeniedInline, { role: msg.roles.O })}
            {D.deniedTail}
          </span>
        </div>
      ) : tab === 'timeline' ? (
        <TimelineTab view={v} />
      ) : tab === 'resources' ? (
        <ResourcesTab sid={sid} canUnmask={role === 'L'} />
      ) : tab === 'cost' ? (
        <CostTab view={v} />
      ) : tab === 'ops' ? (
        <OpsTab sid={sid} />
      ) : (
        <AuditTab sid={sid} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 时间线

const MAX_PAGES = 25;

function TimelineTab({ view }: { view: SessionView }) {
  const { api, clock } = useServices();
  const sid = view.sessionId;
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cat, setCat] = useState<EventCategory | ''>('');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      const all: SessionEvent[] = [];
      let after: string | undefined;
      for (let i = 0; i < MAX_PAGES; i++) {
        const r = await api.call<{ events?: SessionEvent[]; next?: string | null; hasMore?: boolean }>('listSessionEvents', { params: { sid }, query: { after, limit: 200 }, conditional: false });
        const page = r.data?.events ?? [];
        all.push(...page);
        if (!r.data?.hasMore || !r.data.next || r.data.next === after) break;
        after = r.data.next;
      }
      if (cancelled) return;
      setEvents(all);
      setTruncated(all.length > 0 && all[0]!.type !== 'session.requested');
      setStatus('ok');
    })().catch((e: unknown) => {
      if (cancelled || !isApiError(e)) return;
      setError(e);
      setStatus('error');
    });
    return () => {
      cancelled = true;
    };
  }, [api, sid, attempt]);

  // 进行中的会话：新事件追加到时间线（SessionSync 已去重、排序）
  useSessionEvents(
    (_sid, fresh) => {
      setEvents((cur) => {
        const seen = new Set(cur.map((e) => e.id));
        const add = fresh.filter((e) => !seen.has(e.id));
        return add.length ? [...cur, ...add].sort((a, b) => (a.id < b.id ? -1 : 1)) : cur;
      });
    },
    { sid },
  );

  const shown = useMemo(() => events.filter((e) => !cat || categoryOf(e.type) === cat), [events, cat]);
  const now = clock.now();
  if (status === 'loading') return <Skeleton lines={6} label={D.readingTimeline} />;
  if (status === 'error') return <InlineProblem error={error} onRetry={() => setAttempt((x) => x + 1)} title={D.timeline} />;
  const summary: [string, string][] = [
    [view.createdAt, D.sumRequested],
    ...(view.readyAt ? ([[view.readyAt, D.sumReady]] as [string, string][]) : []),
    ...(view.revokedAt ? ([[view.revokedAt, D.sumRevoked]] as [string, string][]) : []),
    ...(view.endedAt ? ([[view.endedAt, t(D.sumEnded, { reason: endReasonText(view.endReason) })]] as [string, string][]) : []),
  ];
  return (
    <section className="sec" aria-labelledby="tl-h" data-section="timeline">
      <h2 id="tl-h">
        {D.timeline}
        <span className="aside">
          <label className="sr" htmlFor="tl-cat">
            {D.filterByCategory}
          </label>
          <select id="tl-cat" className="input" value={cat} onChange={(e) => setCat(e.target.value as EventCategory | '')}>
            <option value="">{D.allCategories}</option>
            {(Object.keys(CATEGORY_TEXT) as EventCategory[]).map((k) => (
              <option key={k} value={k}>
                {CATEGORY_TEXT[k]}
              </option>
            ))}
          </select>
        </span>
      </h2>
      {truncated ? <p className="small muted">{D.truncated}</p> : null}
      {truncated ? (
        <ol className="timeline" aria-label={D.summary}>
          {summary.map(([at, text]) => (
            <li key={`${at}-${text}`}>
              <span className="t" title={formatUtcTitle(at)}>
                {formatDate(at, now)}
              </span>
              <span className="what">{text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {shown.length ? (
        <ol className="timeline" data-events={shown.length}>
          {shown.map((e) => (
            <li key={e.id} data-type={e.type}>
              <span className="t" title={formatUtcTitle(e.at)}>
                {formatDate(e.at, now)}
              </span>
              <span className="what">{eventText(e)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="small muted">{events.length ? D.noEventsInCategory : D.noEvents}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 资源（L A）

const RESOURCE_STATES = ['', 'TRACKED', 'DELETING', 'DELETED', 'RETAINED', 'REVIEW', 'MANUAL_REQUIRED', 'RESOLVED_BY_LEARNER', 'FAILED'] as const;

function ResourcesTab({ sid, canUnmask }: { sid: string; canUnmask: boolean }) {
  const [state, setState] = useState('');
  const data = useApiData<{ items?: Record<string, unknown>[] }>(`res:${sid}:${state}`, 'listSessionResources', { params: { sid }, query: { state: state || undefined } });
  const items = useMemo(() => (data.data?.items ?? []).map(normalizeResource), [data.data]);
  return (
    <div className="stack-8">
      <div className="filters">
        <label className="small muted" htmlFor="res-state">
          {D.cleanupState}
        </label>
        <select id="res-state" className="input" value={state} onChange={(e) => setState(e.target.value)}>
          {RESOURCE_STATES.map((s) => (
            <option key={s} value={s}>
              {s ? CLEANUP_STATE_META[s].text : D.all}
            </option>
          ))}
        </select>
      </div>
      {data.status === 'error' && !data.loaded ? (
        <InlineProblem error={data.error} onRetry={() => void data.refresh()} title={D.resources} />
      ) : !data.loaded ? (
        <Skeleton lines={4} />
      ) : (
        <ResourceStages sid={`detail-${sid}`} items={items} heading={t(D.resourcesHeading, { n: items.length })} canUnmask={canUnmask} />
      )}
      <p className="small muted">{D.resourcesNote}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 费用（L A）

interface SessionCostView {
  currency?: string;
  priceAsOf?: string | null;
  elapsedHours?: number;
  hourly?: { low?: number | null; high?: number | null } | null;
  estimate?: { low?: number; high?: number } | null;
  incomplete?: string[];
  billable?: { resourceKey?: string | null; type?: string | null; name?: string | null; billing?: string; since?: string | null; createdBy?: string | null }[];
  unestimatedManualResources?: number;
  disclaimer?: string;
}

function CostTab({ view }: { view: SessionViewX }) {
  const { clock } = useServices();
  const sid = view.sessionId;
  const data = useApiData<SessionCostView>(`cost:${sid}`, 'getSessionCost', { params: { sid } });
  const c = data.data;
  const q = view.cost ?? null;
  const currency = c?.currency ?? q?.currency ?? 'USD';
  const priceAsOf = c?.priceAsOf ?? q?.priceAsOf ?? null;
  const est = c?.estimate ? formatMoneyRange(c.estimate.low, c.estimate.high, currency) : null;
  const start = hourlyRange(q?.hourly ?? null);
  const startText = start ? formatMoneyRange(start.low, start.high, currency, D.perHour) : null;
  const now = clock.now();
  return (
    <div className="stack-16" data-section="cost">
      <p className="small muted">
        {t(D.costNote, { asOf: priceAsOf ? t(D.priceAsOf, { t: formatDate(priceAsOf, now) }) : '' })}
      </p>
      {q?.dimensions?.length ? (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{D.colService}</th>
                <th scope="col">{D.colDimension}</th>
                <th scope="col">{D.colDetail}</th>
              </tr>
            </thead>
            <tbody>
              {q.dimensions.map((d, i) => (
                <tr key={i}>
                  <td className="mono small">{d.service ?? '—'}</td>
                  <td className="small">{d.dimension ? (BILLING_TEXT[d.dimension as BillingLike] ?? d.dimension) : '—'}</td>
                  <td className="small">{d.detail ? redact(d.detail) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">{D.noDimensions}</p>
      )}
      <dl className="kv">
        <dt>{D.startEstimate}</dt>
        <dd>
          {startText ?? D.unknownPrice}
          {q?.quoteId ? <span className="small faint">{rich(D.quoteRef, { id: <span className="mono">{q.quoteId.slice(0, 6)}…</span> })}</span> : null}
        </dd>
        <dt>{D.thisSession}</dt>
        <dd>
          {data.loaded ? (est ? t(D.recomputed, { est }) : D.unknownBill) : '…'}
          {c?.unestimatedManualResources ? t(D.unestimated, { n: c.unestimatedManualResources }) : ''}
        </dd>
        {view.extensions?.length ? (
          <>
            <dt>{D.extensions}</dt>
            <dd>
              {(view.extensions as { at?: string; minutes?: number; quoteId?: string }[]).map((x, i) => (
                <span key={i} className="block-line">
                  {x.at ? `${formatDate(x.at, now)} ` : ''}
                  {t(D.extensionLine, { n: x.minutes ?? '?' })}
                  {x.quoteId ? t(D.extensionQuote, { id: x.quoteId.slice(0, 6) }) : ''}
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      {data.status === 'error' && !data.loaded ? <InlineProblem error={data.error} onRetry={() => void data.refresh()} title={D.cost} /> : null}
      {c?.billable?.length ? (
        <section className="sec" aria-labelledby="bill-h">
          <h2 id="bill-h">{D.billable}</h2>
          <ul className="small">
            {c.billable.map((b, i) => (
              <li key={b.resourceKey ?? i}>
                <span className="mono">{b.type ?? '—'}</span> <span className="mono wrap-any">{b.name ? redact(b.name) : ''}</span> · {b.billing ? (BILLING_TEXT[b.billing as BillingLike] ?? b.billing) : '—'}
                {b.since ? t(D.since, { t: formatDate(b.since, now) }) : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="small muted">{D.billNote}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 平台动作

interface ModuleOp {
  opId?: string;
  source?: string;
  op?: string;
  moduleId?: string;
  actionId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  summary?: string | null;
  runId?: string | null;
}

const SOURCE_TEXT: Readonly<Record<string, string>> = D.source;

function OpsTab({ sid }: { sid: string }) {
  const { clock } = useServices();
  const data = useApiData<{ items?: ModuleOp[] }>(`ops:${sid}`, 'listModuleOps', { params: { sid } });
  if (data.status === 'error' && !data.loaded) return <InlineProblem error={data.error} onRetry={() => void data.refresh()} title={D.ops} />;
  if (!data.loaded) return <Skeleton lines={3} />;
  const items = data.data?.items ?? [];
  if (!items.length) return <p className="small muted">{D.noOps}</p>;
  const now = clock.now();
  return (
    <div className="tbl-wrap cardify" data-section="ops">
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">{D.colTime}</th>
            <th scope="col">{D.colSource}</th>
            <th scope="col">{D.colOp}</th>
            <th scope="col">{D.colModule}</th>
            <th scope="col">{D.colResult}</th>
            <th scope="col">{D.colRunId}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o, i) => {
            const at = o.startedAt ?? o.finishedAt;
            const result = !o.finishedAt ? { text: D.opRunning, shape: 'clock' as const, tone: 'pend' as const } : o.exitCode === 0 || o.exitCode === null ? { text: D.opOk, shape: 'check' as const, tone: 'pass' as const } : { text: t(D.opFailed, { code: o.exitCode }), shape: 'xbox' as const, tone: 'fail' as const };
            return (
              <tr key={o.opId ?? i}>
                <td className="tnum" data-label={D.colTime}>
                  {at ? formatDate(at, now) : '—'}
                </td>
                <td data-label={D.colSource}>{SOURCE_TEXT[o.source ?? ''] ?? '—'}</td>
                <td className="mono small" data-label={D.colOp}>
                  {o.actionId ?? o.op ?? '—'}
                </td>
                <td className="mono small" data-label={D.colModule}>
                  {o.moduleId ?? '—'}
                </td>
                <td data-label={D.colResult}>
                  <Status meta={result} />
                  {o.summary ? <span className="small muted block-line">{redact(o.summary)}</span> : null}
                </td>
                <td className="mono small" data-label={D.colRunId}>
                  {o.runId ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 审计（L A）

interface AuditItem {
  auditId?: string;
  at?: string;
  action?: string;
  actor?: { sub?: string; role?: string; displayName?: string; via?: string; group?: string } | string | null;
  target?: string | null;
  result?: string;
}

const RESULT_META: Readonly<Record<string, { readonly text: string; shape: 'check' | 'xbox' | 'tri'; tone: 'pass' | 'fail' | 'drift' }>> = withText(
  {
    ok: { shape: 'check', tone: 'pass' },
    success: { shape: 'check', tone: 'pass' },
    denied: { shape: 'xbox', tone: 'fail' },
    error: { shape: 'tri', tone: 'drift' },
  } as const,
  D.result,
);

function actorText(a: AuditItem['actor']): string {
  if (!a) return '—';
  if (typeof a === 'string') return a === 'system' ? D.platform : a;
  const role = a.role === 'learner' || a.group === 'learner' ? msg.roles.L : a.role === 'assistant' ? msg.roles.A : a.role === 'observer' ? msg.roles.O : a.role === 'system' ? D.platform : '';
  const name = a.displayName ?? (a.sub ? `${a.sub.slice(0, 6)}…` : D.platform);
  return role ? t(D.actorRole, { name, role }) : name;
}

function AuditTab({ sid }: { sid: string }) {
  const { clock } = useServices();
  const data = useApiData<{ items?: AuditItem[] }>(`audit:${sid}`, 'listAuditEvents', { query: { sessionId: sid } });
  if (data.status === 'error' && !data.loaded) return <InlineProblem error={data.error} onRetry={() => void data.refresh()} title={D.audit} />;
  if (!data.loaded) return <Skeleton lines={3} />;
  const items = data.data?.items ?? [];
  if (!items.length) return <p className="small muted">{D.noAudit}</p>;
  const now = clock.now();
  return (
    <div className="tbl-wrap cardify" data-section="audit">
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">{D.colTime}</th>
            <th scope="col">{D.colActor}</th>
            <th scope="col">{D.colAction}</th>
            <th scope="col">{D.colTarget}</th>
            <th scope="col">{D.colResult}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <tr key={a.auditId ?? i}>
              <td className="tnum" data-label={D.colTime}>
                {a.at ? formatDate(a.at, now) : '—'}
              </td>
              <td data-label={D.colActor}>{actorText(a.actor)}</td>
              <td className="mono small" data-label={D.colAction}>
                {a.action ?? '—'}
              </td>
              <td className="mono small wrap-any" data-label={D.colTarget}>
                {a.target ? redact(a.target) : '—'}
              </td>
              <td data-label={D.colResult}>{RESULT_META[a.result ?? ''] ? <Status meta={RESULT_META[a.result!]!} /> : (a.result ?? '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
