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
  if (status === 'missing') return <Missing title="没有这个会话" />;
  if (status === 'error' && !view) return <ErrorPanel error={error ?? { code: 'INTERNAL' }} onRetry={retry} title="结束与回收" />;
  if (!view) return <Skeleton lines={5} block label="正在读取会话" />;
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
  const reportLink = showReport ? <Link to={`/sessions/${sid}/report`}>查看报告</Link> : null;
  const progressDetail = (() => {
    const d = progress?.data as { stack?: string; status?: string; resource?: { stack?: string; status?: string }; message?: string } | undefined;
    if (!d) return null;
    const stack = d.stack ?? d.resource?.stack;
    const st = d.status ?? d.resource?.status;
    return stack ? `${redact(stack)}${st ? ` · ${st}` : ''}` : d.message ? redact(d.message) : null;
  })();
  const extra = {
    revoke: view.revokedAt ? '终端已断开 · 控制台与工作台凭证已吊销（已打开的控制台窗口中的权限会被拒绝；权限收回需要一点时间，以官方文档为准）' : undefined,
    finalize: nr ? (
      '环境未就绪：没有报告，尝试不计入次数'
    ) : (
      <>
        尝试：{attempt && ATTEMPT_STATUS_META[attempt] ? ATTEMPT_STATUS_META[attempt].text : '—'}
        {attempt === 'unverified' ? '（部分资源的归属将在复扫后确认）' : ''}
        {reportRev ? ` · 报告第 ${reportRev} 版已生成` : ''}
        {reportLink ? <> · {reportLink}</> : null}
      </>
    ),
    destroy: progressDetail ?? undefined,
    reclaim: view.cleanup ? `已删除 ${view.cleanup.deleted ?? 0} 项${view.cleanup.manual ? ` · 需人工 ${view.cleanup.manual} 项` : ''}` : undefined,
    conclude:
      view.state === 'CLEANUP_FAILED' ? '释放未完成' : view.state === 'ENDED' ? '已释放全部资源' : view.state === 'FAILED' ? '启动失败，已释放已创建的资源' : undefined,
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
        <nav className="crumbs-row" aria-label="面包屑">
          <Link to="/sessions">我的实验</Link>
          <span aria-hidden="true">›</span>
          <Link className="mono" to={`/sessions/${sid}`}>
            {sid}
          </Link>
          <span aria-hidden="true">›</span>
          <span>结束与回收</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>{view.labId} · 结束与回收</h1>
            <span className="sub">
              会话 <span className="mono">{sid}</span>
              {view.env?.envName ? (
                <>
                  {' '}
                  · 环境 <span className="mono">{view.env.envName}</span>
                </>
              ) : null}{' '}
              · 结束原因：{endReasonText(view.endReason)}
            </span>
          </div>
          <span className="acts">
            <SessionStatePill state={view.state} />
            {winding ? (
              <span className="small">
                已用 <ElapsedSince from={view.revokedAt ?? view.stateEnteredAt ?? null} /> · 回收较慢的项目会单独提示
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {retrying ? (
        <div className="note blue" role="status">
          <Shape name="retry" />
          <span>正在重试回收。</span>
        </div>
      ) : null}

      {view.state === 'ENDED' ? (
        <div className="vres ok" role="status" data-conclusion="ended">
          <Shape name="check" />
          <div className="vbody">
            <span className="vt">已释放全部资源。</span>
            <span className="small">
              {followUpPending && lastRescan
                ? `复扫会在 ${formatClock(lastRescan.at)} 前完成。复扫若发现删不掉的残留，会话会转为“释放未完成”并通知你。`
                : '回收已全部完成。'}
            </span>
          </div>
        </div>
      ) : null}
      {view.endReason === 'HANDED_OVER' ? <div className="note">环境已交接给新的会话。</div> : null}
      {view.state === 'FAILED' ? (
        <div className="vres bad" role="status" data-conclusion="failed">
          <Shape name="xbox" />
          <div className="vbody">
            <span className="vt">启动失败，已释放已创建的资源</span>
            <span className="small">
              {failure?.code ? `失败原因：${failure.message ? redact(failure.message) : failure.code}（${failure.code}）· ` : ''}这次尝试不计入次数
            </span>
          </div>
        </div>
      ) : null}
      {view.state === 'FAILED' && L ? (
        <div className="row">
          <Link className="btn primary" to={`/labs/${view.labId}?start=1`}>
            重新开始
          </Link>
          <Link className="btn" to={`/sessions/${sid}`}>
            会话详情
          </Link>
        </div>
      ) : null}

      {view.state === 'CLEANUP_FAILED' ? (
        <section className="sec" id="manual" ref={manualRef} tabIndex={-1} aria-labelledby="manual-h" data-section="manual">
          <h2 id="manual-h" className="st fail">
            <Shape name="tri" />
            <span className="t">
              {canReadLedger ? `释放未完成：${manualItems.length || view.cleanup?.manual || 0} 项资源没能自动删除` : '释放未完成'}
              {(cleanup.data?.hourlyBlocking ?? 0) > 0 ? `，其中 ${cleanup.data!.hourlyBlocking} 项按小时计费` : ''}
            </span>
          </h2>
          {!canReadLedger ? (
            <p className="small">有资源没能自动删除，学员需要逐项处理。你的角色（观察者）看不到待人工处理清单。</p>
          ) : (
            <>
              <p className="small">
                它们仍可能计费，请按下面的指引处理。平台会在 1 小时、6 小时、24 小时后自动重试回收（以平台设置为准）。这些资源都带有{' '}
                <code>atl:env-id</code> 标签，可以在控制台按标签查找。
              </p>
              {cleanup.status === 'error' && !cleanup.loaded ? (
                <InlineProblem error={cleanup.error} onRetry={() => void cleanup.refresh()} title="待人工处理清单暂不可用" />
              ) : !cleanup.loaded ? (
                <Skeleton lines={3} />
              ) : manualItems.length ? (
                <ManualList items={manualItems} sid={sid} canAct={L} onChanged={() => void cleanup.refresh()} />
              ) : (
                <p className="small muted">清单中的资源都已处理，正在等待平台核对结论。</p>
              )}
              <div className="row">
                {L ? (
                  <Button onClick={() => void retry.run({ params: { sid } })} busy={retry.busy} busyText="正在请求重试…">
                    立即重试回收
                  </Button>
                ) : null}
                <CleanupExport sid={sid} label="导出清单" />
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
          <p className="small muted">结束阶段完成后开始回收资源。</p>
        ) : resources.status === 'error' && !resources.loaded ? (
          <div className="stack-8">
            <h2>资源</h2>
            <p className="small">
              回收报告暂不可用 ·{' '}
              <button type="button" className="linkbtn" onClick={() => void resources.refresh()}>
                重试
              </button>
            </p>
          </div>
        ) : !resources.loaded ? (
          <Skeleton lines={3} label="正在读取资源" />
        ) : (
          <ResourceStages sid={sid} items={ledger} chainExtra={chainExtra} canUnmask={L} />
        )
      ) : (
        <section className="sec" aria-labelledby="res-o-h">
          <h2 id="res-o-h">资源</h2>
          <p className="small muted">
            回收结论：{view.state === 'CLEANUP_FAILED' ? '释放未完成' : winding ? '回收进行中' : '已释放'}。你的角色（观察者）看不到资源清单与费用明细。
          </p>
        </section>
      )}

      {winding ? (
        <section className="sec" aria-labelledby="after-h">
          <h2 id="after-h">之后还会做什么</h2>
          <p className="small">
            CloudTrail 事件有投递延迟。主回收完成后，平台会在收回访问后的 +20 分钟、+60 分钟、+6 小时各复扫一次，补删迟到的资源。复扫不影响你开始下一张卡片。
          </p>
        </section>
      ) : null}

      <div className="row no-print">
        {winding ? <span className="small muted">可以离开这个页面。</span> : null}
        <span className="spacer" />
        <Link className="btn" to="/labs">
          先看看下一张卡片 →
        </Link>
        {showReport && !nr ? (
          <Link className={view.state === 'ENDED' ? 'btn primary' : 'btn'} to={`/sessions/${sid}/report`}>
            查看报告
          </Link>
        ) : null}
        {nr && view.state === 'ENDED' ? <span className="small muted">这次会话在环境就绪前结束，没有报告（尝试不计入次数）。</span> : null}
        {canReadLedger && view.state !== 'CLEANUP_FAILED' ? <CleanupExport sid={sid} /> : null}
      </div>
    </div>
  );
}

function RetryError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return <InlineProblem error={error} onRetry={onRetry} overrides={{ INVALID_STATE: '会话已不在“释放未完成”状态，页面已刷新' }} />;
}
