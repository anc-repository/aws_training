/**
 * P07 结束与回收进度（含 P07-K 保留中的环境）`/sessions/:sid/end`（08 P07；02 §6～§8；§2.4 表 2）。
 *
 * - 按 `endRender()` 选择：REQUESTED～EXPIRING 重定向回工作台；ENDING / CLEANING → 回收进度；KEPT → P07-K；
 *   CLEANUP_FAILED → 回收进度并定位 `#manual`；ENDED / FAILED → 结束摘要（结论、复扫时间线、结束阶段、资源）；
 * - 数据：会话视图（SessionSync，L A O）；回收报告 `GET …/cleanup`（30 秒，只在本页可见且 ENDING / CLEANING 时；残留与复扫窗口 60 秒）
 *   与本会话资源 `GET …/resources`（L A）；回收、资源、清理、报告类事件到达时立即刷新；
 * - 观察者只看结束阶段与结论（§1.5）；助教只读（没有重试、我已处理、导出以外的操作）；
 * - 从未就绪的会话（readyAt 为空）不出现“查看报告”。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import type { ApiError } from '../../api/errors';
import type { SessionEvent, SessionView } from '../../api/types';
import { useAuth, useServices, useSessionEvents } from '../../app/context';
import { endRender, neverReady } from '../../app/sessionRouting';
import { formatClock, formatCountdown } from '../../lib/format';
import { redact } from '../../lib/redact';
import { ATTEMPT_STATUS_META, Button, ErrorPanel, SessionStatePill, Shape, Skeleton, useSecondTick, type AttemptStatus } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { Missing } from '../errors/NotFoundPage';
import { useAction } from '../errors/useAction';
import { ManualList } from '../manual/ManualList';
import { useApiData, useSessionView, viewX } from '../sessions/data';
import { endReasonText } from '../sessions/sessionText';
import '../sessions/pages.css';
import { CleanupExport } from './CleanupExport';
import { EndPhaseList } from './EndPhaseList';
import { KeptView } from './KeptView';
import { endStages } from './phases';
import { rescanTimeline, type ReclaimPass } from './rescan';
import { RescanTimeline } from './RescanTimeline';
import { isOpen, normalizeResource } from './resources';
import { ResourceStages } from './ResourceStages';

import { msg, rich, t } from '../../i18n';

const EP = msg.end.page;
export interface CleanupReport {
  sessionId: string;
  envId?: string | null;
  status?: string;
  passes?: ReclaimPass[];
  counts?: Record<string, number>;
  hourlyBlocking?: number;
  items?: Record<string, unknown>[];
}

interface ResourcesList {
  items?: Record<string, unknown>[];
}

const RECLAIM_EVENTS = ['reclaim.', 'resource.', 'cleanup.'];

export default function EndPage() {
  const { sid = '' } = useParams();
  const { view, status, error, retry } = useSessionView(sid);
  if (status === 'missing') return <Missing title={EP.noSession} />;
  if (status === 'error' && !view) return <ErrorPanel error={error ?? { code: 'INTERNAL' }} onRetry={retry} title={EP.title} />;
  if (!view) return <Skeleton lines={5} block label={EP.reading} />;
  const r = endRender(view);
  if (r.kind === 'redirect') return <Navigate to={r.to} replace />;
  if (r.kind === 'P07-K') return <KeptView view={view} />;
  return <ReclaimView view={view} manualAnchor={r.kind === 'P07' && r.anchor === 'manual'} showReport={r.report} />;
}

function cleanupPollMs(v: SessionView): number | null {
  if (v.state === 'ENDING' || v.state === 'CLEANING') return 30_000;
  if (v.state === 'CLEANUP_FAILED') return 60_000;
  const followUp = (v.reclaim as { followUp?: string } | null)?.followUp;
  return followUp === 'PENDING' ? 60_000 : null;
}

function ElapsedSince({ from }: { from: string | null | undefined }) {
  const { clock } = useServices();
  useSecondTick(!!from);
  if (!from) return null;
  return <span className="mono">{formatCountdown(clock.now() - Date.parse(from))}</span>;
}

function ReclaimView({ view, manualAnchor, showReport }: { view: SessionView; manualAnchor: boolean; showReport: boolean }) {
  const sid = view.sessionId;
  const { clock, sync } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const L = role === 'L';
  const canReadLedger = role === 'L' || role === 'A';
  const { hash } = useLocation();
  const poll = cleanupPollMs(view);
  const cleanup = useApiData<CleanupReport>(canReadLedger ? `cleanup:${sid}` : null, 'getCleanup', { params: { sid }, query: { format: 'json' }, conditional: false }, poll);
  const resources = useApiData<ResourcesList>(canReadLedger && view.state !== 'ENDING' ? `res:${sid}` : null, 'listSessionResources', { params: { sid } }, poll);
  const [reportRev, setReportRev] = useState<number | null>(null);
  const [progress, setProgress] = useState<SessionEvent | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshCleanupRef = useRef(cleanup.refresh);
  refreshCleanupRef.current = cleanup.refresh;
  const refreshResRef = useRef(resources.refresh);
  refreshResRef.current = resources.refresh;
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);
  const onEvents = useCallback((_sid: string, events: readonly SessionEvent[]) => {
    for (const e of events) {
      if (e.type === 'report.generated' && typeof e.data.revision === 'number') setReportRev(e.data.revision);
      if (e.type === 'session.progress') setProgress(e);
    }
    if (events.some((e) => RECLAIM_EVENTS.some((p) => e.type.startsWith(p)) || e.type === 'session.state_changed')) {
      // 同一轮的多条事件合并成一次刷新
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void refreshCleanupRef.current();
        void refreshResRef.current();
      }, 500);
    }
  }, []);
  useSessionEvents(onEvents, { sid, prefixes: [...RECLAIM_EVENTS, 'report.', 'session.'] });

  const manualRef = useRef<HTMLElement>(null);
  const wantManual = manualAnchor || hash === '#manual';
  const scrolled = useRef(false);
  useEffect(() => {
    if (wantManual && !scrolled.current && manualRef.current) {
      scrolled.current = true;
      manualRef.current.scrollIntoView?.({ block: 'start' });
    }
  });

  const stages = useMemo(() => endStages(view), [view]);
  const ledger = useMemo(() => (resources.data?.items ?? []).map(normalizeResource), [resources.data]);
  const manualItems = useMemo(() => (cleanup.data?.items ?? []).map(normalizeResource).filter(isOpen), [cleanup.data]);
  const envTotal = Object.values(cleanup.data?.counts ?? {}).reduce((a, b) => a + b, 0);
  const chainExtra = viewX(view).reuseOfEnvId || envTotal > ledger.length ? Math.max(0, envTotal - ledger.length) : 0;
  const retry = useAction<SessionView>('retryCleanup', { sid, onSuccess: (v) => v && sync.applyView(v) });
  const nr = neverReady(view);
  const attempt = view.progress?.status as AttemptStatus | null | undefined;
  const reportLink = showReport ? <Link to={`/sessions/${sid}/report`}>{EP.viewReport}</Link> : null;
  const progressDetail = (() => {
    const d = progress?.data as { stack?: string; status?: string; resource?: { stack?: string; status?: string }; message?: string } | undefined;
    if (!d) return null;
    const stack = d.stack ?? d.resource?.stack;
    const st = d.status ?? d.resource?.status;
    return stack ? `${redact(stack)}${st ? ` · ${st}` : ''}` : d.message ? redact(d.message) : null;
  })();
  const extra = {
    revoke: view.revokedAt ? EP.revoked : undefined,
    finalize: nr ? (
      EP.neverReady
    ) : (
      <>
        {t(EP.attempt, { state: attempt && ATTEMPT_STATUS_META[attempt] ? ATTEMPT_STATUS_META[attempt].text : '—' })}
        {attempt === 'unverified' ? EP.unverified : ''}
        {reportRev ? t(EP.reportRev, { n: reportRev }) : ''}
        {reportLink ? <> · {reportLink}</> : null}
      </>
    ),
    destroy: progressDetail ?? undefined,
    reclaim: view.cleanup ? (view.cleanup.manual ? t(EP.reclaimedManual, { n: view.cleanup.deleted ?? 0, m: view.cleanup.manual }) : t(EP.reclaimed, { n: view.cleanup.deleted ?? 0 })) : undefined,
    conclude: view.state === 'CLEANUP_FAILED' ? EP.cleanupFailed : view.state === 'ENDED' ? EP.allReleased : view.state === 'FAILED' ? EP.failedReleased : undefined,
  };
  const rescans = rescanTimeline(view.reclaim as { followUp?: string; rescanAt?: string[] } | null, view.revokedAt ?? view.endedAt, canReadLedger ? (cleanup.data?.passes ?? null) : null, clock.now());
  const lastRescan = rescans[rescans.length - 1];
  const followUpPending = (view.reclaim as { followUp?: string } | null)?.followUp === 'PENDING';
  const winding = view.state === 'ENDING' || view.state === 'CLEANING';
  const retrying = view.state === 'CLEANING' && view.endReason === 'CLEANUP_RETRY';
  const failure = view.failure as { code?: string; message?: string } | null | undefined;

  return (
    <div className="stack-24" data-screen="P07" data-state={view.state}>
      <div>
        <nav className="crumbs-row" aria-label={EP.crumbs}>
          <Link to="/sessions">{EP.mySessions}</Link>
          <span aria-hidden="true">›</span>
          <Link className="mono" to={`/sessions/${sid}`}>
            {sid}
          </Link>
          <span aria-hidden="true">›</span>
          <span>{EP.title}</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>{t(EP.heading, { labId: view.labId })}</h1>
            <span className="sub">
              {rich(EP.session, { sid: <span className="mono">{sid}</span> })}
              {view.env?.envName ? rich(EP.env, { name: <span className="mono">{view.env.envName}</span> }) : null}
              {t(EP.endReason, { reason: endReasonText(view.endReason) })}
            </span>
          </div>
          <span className="acts">
            <SessionStatePill state={view.state} />
            {winding ? (
              <span className="small">
                {rich(EP.elapsed, { t: <ElapsedSince from={view.revokedAt ?? view.stateEnteredAt ?? null} /> })}
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {retrying ? (
        <div className="note blue" role="status">
          <Shape name="retry" />
          <span>{EP.retrying}</span>
        </div>
      ) : null}

      {view.state === 'ENDED' ? (
        <div className="vres ok" role="status" data-conclusion="ended">
          <Shape name="check" />
          <div className="vbody">
            <span className="vt">{EP.allReleasedDot}</span>
            <span className="small">{followUpPending && lastRescan ? t(EP.rescanPending, { t: formatClock(lastRescan.at) }) : EP.allDone}
            </span>
          </div>
        </div>
      ) : null}
      {view.endReason === 'HANDED_OVER' ? <div className="note">{EP.handedOver}</div> : null}
      {view.state === 'FAILED' ? (
        <div className="vres bad" role="status" data-conclusion="failed">
          <Shape name="xbox" />
          <div className="vbody">
            <span className="vt">{EP.failedReleased}</span>
            <span className="small">
              {failure?.code ? t(EP.failureReason, { reason: failure.message ? redact(failure.message) : failure.code, code: failure.code }) : ''}
              {EP.notCounted}
            </span>
          </div>
        </div>
      ) : null}
      {view.state === 'FAILED' && L ? (
        <div className="row">
          <Link className="btn primary" to={`/labs/${view.labId}?start=1`}>
            {EP.restart}
          </Link>
          <Link className="btn" to={`/sessions/${sid}`}>
            {EP.sessionDetail}
          </Link>
        </div>
      ) : null}

      {view.state === 'CLEANUP_FAILED' ? (
        <section className="sec" id="manual" ref={manualRef} tabIndex={-1} aria-labelledby="manual-h" data-section="manual">
          <h2 id="manual-h" className="st fail">
            <Shape name="tri" />
            <span className="t">
              {canReadLedger ? t(EP.manualTitle, { n: manualItems.length || view.cleanup?.manual || 0 }) : EP.cleanupFailed}
              {(cleanup.data?.hourlyBlocking ?? 0) > 0 ? t(EP.manualHourly, { n: cleanup.data!.hourlyBlocking }) : ''}
            </span>
          </h2>
          {!canReadLedger ? (
            <p className="small">{EP.observerNote}</p>
          ) : (
            <>
              <p className="small">{rich(EP.manualGuide, { tag: <code>atl:env-id</code> })}</p>
              {cleanup.status === 'error' && !cleanup.loaded ? (
                <InlineProblem error={cleanup.error} onRetry={() => void cleanup.refresh()} title={EP.manualUnavailable} />
              ) : !cleanup.loaded ? (
                <Skeleton lines={3} />
              ) : manualItems.length ? (
                <ManualList items={manualItems} sid={sid} canAct={L} onChanged={() => void cleanup.refresh()} />
              ) : (
                <p className="small muted">{EP.allHandled}</p>
              )}
              <div className="row">
                {L ? (
                  <Button onClick={() => void retry.run({ params: { sid } })} busy={retry.busy} busyText={EP.requestingRetry}>
                    {EP.retryNow}
                  </Button>
                ) : null}
                <CleanupExport sid={sid} label={EP.exportList} />
              </div>
              {retry.error ? <RetryError error={retry.error} onRetry={() => void retry.retry()} /> : null}
            </>
          )}
        </section>
      ) : null}

      {rescans.length && !winding ? <RescanTimeline items={rescans} /> : null}

      <EndPhaseList stages={stages} extra={extra} />

      {canReadLedger ? (
        view.state === 'ENDING' ? (
          <p className="small muted">{EP.reclaimAfterEnd}</p>
        ) : resources.status === 'error' && !resources.loaded ? (
          <div className="stack-8">
            <h2>{EP.resources}</h2>
            <p className="small">
              {EP.reportUnavailable}{' '}
              <button type="button" className="linkbtn" onClick={() => void resources.refresh()}>
                {EP.retry}
              </button>
            </p>
          </div>
        ) : !resources.loaded ? (
          <Skeleton lines={3} label={EP.readingResources} />
        ) : (
          <ResourceStages sid={sid} items={ledger} chainExtra={chainExtra} canUnmask={L} />
        )
      ) : (
        <section className="sec" aria-labelledby="res-o-h">
          <h2 id="res-o-h">{EP.resources}</h2>
          <p className="small muted">
            {t(EP.observerConclusion, { v: view.state === 'CLEANUP_FAILED' ? EP.cleanupFailed : winding ? EP.reclaiming : EP.released })}
          </p>
        </section>
      )}

      {winding ? (
        <section className="sec" aria-labelledby="after-h">
          <h2 id="after-h">{EP.afterTitle}</h2>
          <p className="small">{EP.afterBody}</p>
        </section>
      ) : null}

      <div className="row no-print">
        {winding ? <span className="small muted">{EP.canLeave}</span> : null}
        <span className="spacer" />
        <Link className="btn" to="/labs">
          {EP.nextCard}
        </Link>
        {showReport && !nr ? (
          <Link className={view.state === 'ENDED' ? 'btn primary' : 'btn'} to={`/sessions/${sid}/report`}>
            {EP.viewReport}
          </Link>
        ) : null}
        {nr && view.state === 'ENDED' ? <span className="small muted">{EP.noReport}</span> : null}
        {canReadLedger && view.state !== 'CLEANUP_FAILED' ? <CleanupExport sid={sid} /> : null}
      </div>
    </div>
  );
}

function RetryError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return <InlineProblem error={error} onRetry={onRetry} overrides={{ INVALID_STATE: EP.notCleanupFailed }} />;
}
