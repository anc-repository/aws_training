/**
 * P08 实验报告 `/sessions/:sid/report`（08 P08；04 §9）。
 *
 * - 报告摘要 `GET /sessions/{sid}/report`（Report 项：版本、summary、eligibility、下载链接、revisions）；SPA 取不到 atl.report/v1 正文
 *   （§9.2 #12：CSP connect-src 不含 S3），所以正文按会话内数据渲染：步骤、检测历史、对比实验，并提供“下载 HTML 报告”查看完整版；
 * - 版本选择器回写前只显示最新版（§9.2 #12、#31）；`report.generated` 到达时提示“报告已更新到第 n 版”；
 * - 状态：从未就绪（没有报告）、会话进行中（预览，不保存，没有导出与分享）、定稿进行中（正在生成）、定稿失败（重新生成）、
 *   unverified / incomplete / IDLE_NOT_STARTED 的结论文案、清理待定；
 * - 操作（只对学员）：重新生成、导出…（ExportDialog）、分享…（ShareDialog + ShareList，含撤销与有效期）；A、O 只读；
 * - 打印：隐藏导航与按钮，页脚“导出时间 · 账号 ID 已打码 · 自托管 ATL 实验平台（非 AWS 官方）”。
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { SessionEvent } from '../../api/types';
import { useAuth, useServices, useSessionEvents } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { neverReady } from '../../app/sessionRouting';
import { copyText } from '../../lib/clipboard';
import { formatClock, formatDate, formatSpan, formatUtcTitle } from '../../lib/format';
import { maskAccountId } from '../../lib/redact';
import { ATTEMPT_STATUS_META, Button, EmptyState, ErrorPanel, Icon, SessionStatePill, Shape, Skeleton, Status, type AttemptStatus, type Tone } from '../../ui';
import { BarChart, ProgressRing } from '../../ui/charts';
import { ArchDiagram, archInputFromCatalogCard } from '../../ui/diagram';
import { ServiceGlyph } from '../../ui/glyphs';
import { InlineProblem } from '../errors/InlineProblem';
import { Missing } from '../errors/NotFoundPage';
import { useAction } from '../errors/useAction';
import { ExperimentCompare } from '../experiments/ExperimentCompare';
import { cardTitle, useApiData, useCatalogIndex, useLabContent, useSessionView, viewX, type SessionViewX } from '../sessions/data';
import '../sessions/pages.css';
import { BADGE_LEVEL_TEXT, BADGE_STATUS_TEXT, formatMoneyRange, hourlyRange } from '../sessions/sessionText';
import { IconBadge, StatusBadge, VTile, VTiles } from '../sessions/visuals';
import { ExportDialog } from './ExportDialog';
import { ShareDialog, ShareList } from './Shares';
import { CheckHistory, StepEvidence, type StepResult } from './StepEvidence';

import { msg, rich, t } from '../../i18n';
import { RP } from './strings';
export interface ReportItem {
  sessionId: string;
  version?: number;
  generatedAt?: string;
  reason?: string;
  status?: string;
  digest?: string;
  summary?: {
    stepsDone?: number;
    stepsTotal?: number;
    evidenceQuality?: { high?: number; medium?: number; low?: number };
    experiments?: number;
    durationMinutes?: number;
    attemptStatus?: string;
  };
  eligibility?: { badge?: boolean; reasons?: string[] };
  downloads?: { json?: { url: string; expiresAt?: string } | null; html?: { url: string; expiresAt?: string } | null };
  revisions?: { version?: number | null; generatedAt?: string | null; status?: string | null; digest?: string | null }[];
}

interface LabProgressBadge {
  labId: string;
  badge?: { level?: string; status?: string; attemptId?: string; evidenceScore?: number; quiz?: { bestScore?: number; attempts?: number } } | null;
}

const LIVE = ['REQUESTED', 'PROVISIONING', 'READY', 'RUNNING', 'EXPIRING'];

export const REVISION_REASON_TEXT: Readonly<Record<string, string>> = RP.revisionReason;

export default function ReportPage() {
  const { sid = '' } = useParams();
  const { view, status, error, retry } = useSessionView(sid);
  if (status === 'missing') return <Missing title={RP.page.noSession} />;
  if (status === 'error' && !view) return <ErrorPanel error={error ?? { code: 'INTERNAL' }} onRetry={retry} title={RP.page.title} />;
  if (!view) return <Skeleton lines={6} block label={RP.page.readingSession} />;
  return <ReportView view={viewX(view)} />;
}

function ReportView({ view }: { view: SessionViewX }) {
  const sid = view.sessionId;
  const { clock } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const L = role === 'L';
  const { platform } = useGlobalStatus();
  const index = useCatalogIndex();
  const { lab } = useLabContent(view.catalogVersion, view.labId);
  const nr = neverReady(view);
  const live = LIVE.includes(view.state);
  const report = useApiData<ReportItem>(!nr && !live ? `report:${sid}` : null, 'getReport', { params: { sid }, conditional: false }, view.state === 'ENDING' ? 15_000 : null);
  const steps = useApiData<{ items?: StepResult[] }>(!nr ? `steps:${sid}` : null, 'listSteps', { params: { sid } });
  const progress = useApiData<{ labs?: LabProgressBadge[] }>(!nr ? 'my-progress' : null, 'getMyProgress');
  const [newer, setNewer] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'export' | 'share' | null>(null);
  const [shareReload, setShareReload] = useState(0);
  const shown = report.data?.version ?? null;
  const onEvents = useCallback(
    (_sid: string, events: readonly SessionEvent[]) => {
      for (const e of events) {
        if (e.type !== 'report.generated') continue;
        const rev = typeof e.data.revision === 'number' ? e.data.revision : null;
        if (!report.loaded) void report.refresh();
        else if (rev && (!shown || rev > shown)) setNewer(rev);
      }
      if (events.some((e) => e.type === 'step.state_changed' || e.type === 'check_run.completed')) void steps.refresh();
    },
    [report, shown, steps],
  );
  useSessionEvents(onEvents, { sid, types: ['report.generated', 'step.state_changed', 'check_run.completed'] });
  const regen = useAction<{ status?: string }>('generateReport', { sid });
  const now = clock.now();

  const header = (sub: ReactNode, acts?: ReactNode) => (
    <div>
      <nav className="crumbs-row" aria-label={RP.page.crumbs}>
        <Link to="/sessions">{RP.page.mySessions}</Link>
        <span aria-hidden="true">›</span>
        <Link className="mono" to={`/sessions/${sid}`}>
          {sid}
        </Link>
        <span aria-hidden="true">›</span>
        <span>{RP.page.title}</span>
      </nav>
      <div className="ph">
        <div className="ttl">
          <h1 tabIndex={-1}>{t(RP.page.heading, { labId: view.labId })}</h1>
          <span className="sub">{sub}</span>
        </div>
        {acts ? <span className="acts no-print">{acts}</span> : null}
      </div>
    </div>
  );

  if (nr) {
    return (
      <div className="stack-16" data-screen="P08" data-report="none">
        {header(rich(RP.page.sessionSub, { sid: <span className="mono">{sid}</span> }))}
        <EmptyState
          title={RP.page.noReportTitle}
          action={
            <Link className="btn" to={`/sessions/${sid}`}>
              {RP.page.sessionDetail}
            </Link>
          }
        >
          {RP.page.noReportBody}
        </EmptyState>
      </div>
    );
  }

  if (!live && !report.loaded) {
    if (report.status === 'missing') {
      if (view.state === 'ENDING') {
        return (
          <div className="stack-16" data-screen="P08" data-report="generating">
            {header(rich(RP.page.sessionSub, { sid: <span className="mono">{sid}</span> }))}
            <p role="status">{RP.page.generating}</p>
            <Skeleton lines={6} block label={RP.page.generatingLabel} />
          </div>
        );
      }
      return (
        <div className="stack-16" data-screen="P08" data-report="failed">
          {header(rich(RP.page.sessionSub, { sid: <span className="mono">{sid}</span> }))}
          <div className="note amber" role="status">
            <Shape name="tri" />
            <span className="spacer">{RP.page.failed}</span>
            {L ? (
              <Button size="sm" busy={regen.busy} busyText={RP.page.requesting} onClick={() => void regen.run({ params: { sid } })}>
                {RP.page.regenerate}
              </Button>
            ) : null}
          </div>
          {regen.data ? <p className="small muted" role="status">{RP.page.regenStarted}</p> : null}
          {regen.error ? <InlineProblem error={regen.error} onRetry={() => void regen.retry()} /> : null}
        </div>
      );
    }
    if (report.status === 'error') return <InlineProblem error={report.error} onRetry={() => void report.refresh()} title={RP.page.title} />;
    return <Skeleton lines={6} block label={RP.page.readingReport} />;
  }

  const r = report.data;
  const attempt = (r?.summary?.attemptStatus ?? view.progress?.status ?? null) as AttemptStatus | null;
  const attemptMeta = attempt && ATTEMPT_STATUS_META[attempt] ? ATTEMPT_STATUS_META[attempt] : null;
  const myBadge = progress.data?.labs?.find((p) => p.labId === view.labId && p.badge?.attemptId === sid)?.badge ?? null;
  const card = index?.cards?.find((c) => c.id === view.labId);
  const badgeTitle = typeof card?.badge === 'object' ? card.badge?.title : typeof card?.badge === 'string' ? card.badge : null;
  const total = view.readyAt && view.endedAt ? formatSpan(Date.parse(view.endedAt) - Date.parse(view.readyAt)) : r?.summary?.durationMinutes != null ? formatSpan(r.summary.durationMinutes * 60_000) : null;
  const q = view.cost;
  const start = hourlyRange(q?.hourly ?? null);
  const startText = start ? formatMoneyRange(start.low, start.high, q?.currency ?? 'USD', RP.page.perHour) : null;
  const ev = r?.summary?.evidenceQuality;
  const followUp = (view.reclaim as { followUp?: string } | null)?.followUp;
  const cleanupText =
    view.state === 'CLEANUP_FAILED'
      ? t(RP.page.cleanupFailed, { n: view.cleanup?.manual ?? '?' })
      : view.state === 'ENDING' || view.state === 'CLEANING'
        ? RP.page.cleanupReclaiming
        : view.state === 'KEPT'
          ? RP.page.cleanupKept
          : live
            ? RP.page.cleanupLive
            : followUp === 'PENDING'
              ? RP.page.cleanupRescan
              : RP.page.cleanupDone;
  const acct = platform.data?.accountId ? maskAccountId(platform.data.accountId) : '••••';
  const revisions = (r?.revisions ?? []).filter((x) => typeof x.version === 'number');
  const htmlUrl = r?.downloads?.html?.url ?? null;
  const experiments = lab?.experiments ?? [];
  // 图形摘要（I6 f）：完成度环、结论徽记、用时、清理状态、证据可信度条形图、构成图
  const RV = RP.visual;
  const stepsDone = r?.summary?.stepsDone ?? view.progress?.stepsDone ?? null;
  const stepsTotal = r?.summary?.stepsTotal ?? view.progress?.stepsTotal ?? null;
  const cleanupTile: { icon: 'refresh' | 'shield' | 'clock' | 'play'; tone: Tone; text: string } =
    view.state === 'CLEANUP_FAILED'
      ? { icon: 'refresh', tone: 'fail', text: msg.end.page.cleanupFailed }
      : view.state === 'ENDING' || view.state === 'CLEANING'
        ? { icon: 'refresh', tone: 'pend', text: msg.end.page.reclaiming }
        : view.state === 'KEPT'
          ? { icon: 'clock', tone: 'kept', text: RP.page.cleanupKept }
          : live
            ? { icon: 'play', tone: 'live', text: RP.page.cleanupLive }
            : { icon: 'shield', tone: 'pass', text: followUp === 'PENDING' ? RP.page.cleanupRescan : RP.page.cleanupDone };
  const evidenceBars = ev
    ? [
        { key: 'high', label: RV.high, value: ev.high ?? 0, tone: 'after' as const },
        { key: 'medium', label: RV.medium, value: ev.medium ?? 0, tone: 'third' as const },
        { key: 'low', label: RV.low, value: ev.low ?? 0, tone: 'before' as const },
      ]
    : null;
  const archInput = card && (card.targets?.length || card.startProfiles?.length) ? archInputFromCatalogCard(card, view.variant ?? undefined) : null;
  const attemptNote = attempt === 'unverified' || (attempt === 'incomplete' && !!r?.eligibility?.reasons?.length) || view.endReason === 'IDLE_NOT_STARTED';

  return (
    <div className="stack-24" data-screen="P08" data-report={live ? 'preview' : 'ready'}>
      {header(
        live ? (
          rich(RP.page.previewSub, { sid: <span className="mono">{sid}</span>, state: <SessionStatePill state={view.state} size="sm" /> })
        ) : (
          <>
            {t(RP.page.versionSub, { v: r?.version ?? '?' })}
            {r?.reason && REVISION_REASON_TEXT[r.reason] ? t(RP.page.versionReason, { reason: REVISION_REASON_TEXT[r.reason] }) : ''}
            {r?.generatedAt ? <span title={formatUtcTitle(r.generatedAt)}>{t(RP.page.generatedAt, { t: formatDate(r.generatedAt, now) })}</span> : null}{' '}
            {rich(RP.page.sessionTail, { sid: <span className="mono">{sid}</span> })}
          </>
        ),
        !live ? (
          <>
            <label className="sr" htmlFor="rep-ver">
              {RP.page.version}
            </label>
            <select id="rep-ver" className="input" value={String(r?.version ?? '')} onChange={() => undefined} aria-describedby="rep-ver-note">
              <option value={String(r?.version ?? '')}>{t(RP.page.versionLatest, { v: r?.version ?? '?' })}</option>
            </select>
            {L ? (
              <>
                <Button busy={regen.busy} busyText={RP.page.requesting} onClick={() => void regen.run({ params: { sid } })}>
                  {RP.page.regenerate}
                </Button>
                <Button onClick={() => setDialog('export')}>{RP.page.export}</Button>
                <Button onClick={() => setDialog('share')}>{RP.page.share}</Button>
              </>
            ) : null}
          </>
        ) : undefined,
      )}

      {revisions.length > 1 ? (
        <p className="small muted" id="rep-ver-note">
          {t(RP.page.revisionsNote, { n: revisions.length })}
        </p>
      ) : (
        <span id="rep-ver-note" hidden />
      )}
      {regen.data ? <p className="small muted" role="status">{RP.page.regenStarted}</p> : null}
      {regen.error ? <InlineProblem error={regen.error} onRetry={() => void regen.retry()} /> : null}
      {newer ? (
        <div className="note blue" role="status">
          <Shape name="dot" />
          <span className="spacer">{t(RP.page.newer, { v: newer })}</span>
          <Button
            size="sm"
            onClick={() => {
              setNewer(null);
              void report.refresh();
            }}
          >
            {RP.page.view}
          </Button>
        </div>
      ) : null}
      {live ? (
        <div className="note amber">
          <Shape name="tri" />
          <span>{RP.page.previewNote}</span>
        </div>
      ) : null}

      <section className="sec" aria-labelledby="r-sum" data-section="summary">
        <h2 id="r-sum">{RP.page.summary}</h2>
        <div className="rep-hero" data-visual="summary">
          <VTiles>
            <VTile
              data="steps"
              visual={typeof stepsDone === 'number' && typeof stepsTotal === 'number' && stepsTotal > 0 ? <ProgressRing value={stepsDone} max={stepsTotal} size={48} label={RV.steps} /> : <IconBadge name="check" />}
              value={t(RV.stepsValue, { done: stepsDone ?? '—', total: stepsTotal ?? '—' })}
              label={RV.steps}
            />
            <VTile data="conclusion" visual={attemptMeta ? <StatusBadge shape={attemptMeta.shape} tone={attemptMeta.tone} /> : <StatusBadge shape="ring" tone="faint" />} value={<span className="small">{attempt === 'unverified' ? RP.page.unverified : (attemptMeta?.text ?? '—')}</span>} label={RV.conclusion} />
            <VTile data="duration" visual={<IconBadge name="clock" />} value={total ?? '—'} label={RV.duration} />
            <VTile data="cleanup" visual={<IconBadge name={cleanupTile.icon} tone={cleanupTile.tone} />} value={<span className="small">{cleanupTile.text}</span>} label={RP.page.cleanup} />
          </VTiles>
          {evidenceBars ? (
            <div className="rep-ev">
              <BarChart caption={RV.evidence} data={evidenceBars} />
            </div>
          ) : null}
        </div>
        {archInput ? (
          <figure className="rep-arch" data-visual="architecture">
            <figcaption>{RV.built}</figcaption>
            <ArchDiagram input={archInput} mode="after" title={RV.built} />
          </figure>
        ) : null}
        <details className="disc" open={attemptNote || undefined}>
          <summary>{RV.details}</summary>
        <div className="statgrid">
          <div className="stat">
            <span className="k">{RP.page.conclusion}</span>
            <span className="v">
              {attemptMeta ? <Status meta={attempt === 'unverified' ? { ...attemptMeta, text: RP.page.unverified } : attemptMeta} /> : '—'}
              {myBadge && badgeTitle ? t(RP.page.badgeTitle, { title: badgeTitle }) : ''}
              {myBadge?.level ? ` · ${BADGE_LEVEL_TEXT[myBadge.level] ?? myBadge.level}` : ''}
              {myBadge?.status && myBadge.status !== 'valid' ? t(RP.page.versionReason, { reason: BADGE_STATUS_TEXT[myBadge.status] ?? myBadge.status }) : ''}
              {typeof myBadge?.evidenceScore === 'number' ? t(RP.page.evidenceScore, { n: myBadge.evidenceScore.toFixed(2) }) : ''}
            </span>
            {attempt === 'unverified' ? <span className="small muted">{RP.page.unverifiedNote}</span> : null}
            {attempt === 'incomplete' && r?.eligibility?.reasons?.length ? <span className="small muted">{t(RP.page.incompleteNote, { list: r.eligibility.reasons.join(RP.page.listSep) })}</span> : null}
            {view.endReason === 'IDLE_NOT_STARTED' ? <span className="small muted">{RP.page.idleNote}</span> : null}
          </div>
          <div className="stat">
            <span className="k">{RP.page.duration}</span>
            <span className="v tnum">
              {view.readyAt ? t(RP.page.readyAt, { t: formatClock(view.readyAt) }) : '—'}
              {view.endedAt ? t(RP.page.endedAt, { t: formatClock(view.endedAt) }) : live ? RP.page.ongoing : ''}
              {total ? t(RP.page.total, { t: total }) : ''}
              {t(RP.page.extensions, { n: view.extensions?.length ?? 0 })}
            </span>
          </div>
          <div className="stat">
            <span className="k">{RP.page.checks}</span>
            <span className="v">
              {t(RP.page.stepsDone, { done: r?.summary?.stepsDone ?? view.progress?.stepsDone ?? '—', total: r?.summary?.stepsTotal ?? view.progress?.stepsTotal ?? '—' })}
              {ev ? t(RP.page.quality, { high: ev.high ?? 0, medium: ev.medium ?? 0, low: ev.low ?? 0 }) : ''}
            </span>
          </div>
          <div className="stat">
            <span className="k">{RP.page.cost}</span>
            <span className="v">
              {t(RP.page.costLine, { start: startText ?? RP.page.unknown })}
            </span>
          </div>
          <div className="stat">
            <span className="k">{RP.page.cleanup}</span>
            <span className="v">
              {cleanupText}
              {view.state === 'CLEANUP_FAILED' ? (
                <>
                  {' '}
                  <Link to={`/sessions/${sid}/end#manual`}>{RP.page.manualList}</Link>
                </>
              ) : null}
            </span>
          </div>
          <div className="stat">
            <span className="k">{RP.page.environment}</span>
            <span className="v">
              {view.reuseOfEnvId ? RP.page.reused : RP.page.fresh} · <span className="mono">{platform.data?.region ?? '—'}</span>
              {t(RP.page.account, { acct })}
              {view.startProfile ? rich(RP.page.startProfile, { name: <span className="mono">{view.startProfile}</span> }) : null}
            </span>
          </div>
        </div>
        </details>
      </section>

      {!live ? (
        <div className="note no-print">
          <Icon name="doc" />
          <span>
            {rich(RP.page.fullNote, {
              link:
                L && htmlUrl ? (
                  <a href={htmlUrl} target="_blank" rel="noopener noreferrer">
                    {RP.page.downloadHtml}
                    <span className="sr">{msg.app.newTab}</span>
                  </a>
                ) : L ? (
                  RP.page.downloadInExport
                ) : (
                  RP.page.learnerExports
                ),
            })}
          </span>
        </div>
      ) : null}

      <nav className="toc no-print" aria-label={RP.page.toc}>
        {RP.page.tocLead}
        <a href="#r-steps">{RP.page.steps}</a>
        <a href="#r-exp">{RP.page.experiments}</a>
        <a href="#r-cost">{RP.page.cost}</a>
        <a href="#r-clean">{RP.page.cleanup}</a>
        <a href="#r-app">{RP.page.appendix}</a>
      </nav>

      <section className="sec" id="r-steps" tabIndex={-1} aria-labelledby="r-steps-h">
        <h2 id="r-steps-h">{RP.page.steps}</h2>
        <StepEvidence sid={sid} lab={lab} steps={steps.data?.items ?? []} loaded={steps.loaded} error={steps.error} onRetry={() => void steps.refresh()} nowMs={now} />
        <details className="disc">
          <summary>{RP.page.fullHistory}</summary>
          <CheckHistory sid={sid} lab={lab} nowMs={now} />
        </details>
      </section>

      <section className="sec" id="r-exp" tabIndex={-1} aria-labelledby="r-exp-h">
        <h2 id="r-exp-h">{RP.page.experiments}</h2>
        {!experiments.length ? <p className="small muted">{RP.page.noExperiments}</p> : null}
        {experiments.map((x) => (
          <div key={`${x.module}/${x.id}`} className="stack-8" data-experiment={`${x.module}/${x.id}`}>
            <h3>
              <ServiceGlyph id={x.module} size={20} tooltip className="h-glyph" /> {x.module}/{x.id}
              {x.required ? RP.page.required : RP.page.optional}{' '}
              <Link className="small" to={`/sessions/${sid}/experiments/${x.module}/${x.id}`}>
                {RP.page.openCompare}
              </Link>
            </h3>
            {x.required ? <ExperimentCompare view={view} module={x.module} experimentId={x.id} mode="report" /> : null}
          </div>
        ))}
      </section>

      <section className="sec" aria-labelledby="r-quiz-h">
        <h2 id="r-quiz-h">{RP.page.quiz}</h2>
        <p className="small">
          {myBadge?.quiz?.bestScore != null ? t(RP.page.quizBest, { score: myBadge.quiz.bestScore, n: myBadge.quiz.attempts ?? 1 }) : RP.page.quizInHtml}
          {RP.page.quizNote}
        </p>
      </section>

      <section className="sec" id="r-cost" tabIndex={-1} aria-labelledby="r-cost-h">
        <h2 id="r-cost-h">{RP.page.cost}</h2>
        <dl className="kv">
          <dt>{RP.page.startEstimate}</dt>
          <dd>
            {startText ?? RP.page.unknownPrice}
            {q?.quoteId ? (
              <span className="small faint">
                {rich(RP.page.quoteRef, { id: <span className="mono">{q.quoteId.slice(0, 6)}…</span> })}
              </span>
            ) : null}
          </dd>
          <dt>{RP.page.billActual}</dt>
          <dd className="small muted">{RP.page.billNote}</dd>
        </dl>
        <details className="disc">
          <summary>{RP.visual.details}</summary>
          <p className="small">{t(RP.page.costNote, { asOf: q?.priceAsOf ? t(RP.page.priceAsOf, { t: formatDate(q.priceAsOf, now) }) : '' })}</p>
        </details>
        {role !== 'O' ? (
          <p className="small">
            <Link to={`/sessions/${sid}?tab=cost`}>{RP.page.costInDetail}</Link>
          </p>
        ) : null}
      </section>

      <section className="sec" id="r-clean" tabIndex={-1} aria-labelledby="r-clean-h">
        <h2 id="r-clean-h">{RP.page.cleanup}</h2>
        <p className="small">
          {cleanupText}
          {view.cleanup?.deleted != null ? t(RP.page.reclaimed, { n: view.cleanup.deleted }) : ''}
          {view.cleanup?.manual ? t(RP.page.manualPending, { n: view.cleanup.manual }) : ''} · <Link to={`/sessions/${sid}/end`}>{RP.page.reclaimProgress}</Link>
        </p>
      </section>

      <section className="sec" id="r-app" tabIndex={-1} aria-labelledby="r-app-h">
        <h2 id="r-app-h">{RP.page.appendix}</h2>
        <dl className="kv small">
          <dt>{RP.page.card}</dt>
          <dd>
            <span className="mono">{view.labId}</span>
            {cardTitle(index, view.labId) ? ` · ${cardTitle(index, view.labId)}` : ''}
          </dd>
          <dt>{RP.page.cardVersion}</dt>
          <dd className="mono">{view.labVersion ?? '—'}</dd>
          <dt>{RP.page.catalogVersion}</dt>
          <dd className="mono">{view.catalogVersion ?? '—'}</dd>
          <dt>{RP.page.variant}</dt>
          <dd className="mono">{view.variant ?? 'default'}</dd>
          {r?.digest ? (
            <>
              <dt>{RP.page.digest}</dt>
              <dd>
                <span className="mono">{r.digest.slice(0, 19)}…</span>（RFC 8785）{' '}
                <button type="button" className="linkbtn no-print" onClick={() => void copyText(r.digest!)} aria-label={RP.page.copyDigest}>
                  {RP.page.copy}
                </button>
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      {L && !live ? (
        <section className="sec no-print" aria-labelledby="r-share-h" data-section="shares">
          <h2 id="r-share-h">
            {RP.page.shareLinks}
            <span className="aside">
              <button type="button" className="linkbtn" onClick={() => setDialog('share')}>
                {RP.page.createShare}
              </button>
            </span>
          </h2>
          <ShareList sid={sid} reloadKey={shareReload} />
        </section>
      ) : null}

      <p className="print-only small">
        {t(RP.page.printFooter, { t: formatDate(now, now) })}
      </p>

      {dialog === 'export' ? <ExportDialog sid={sid} onClose={() => setDialog(null)} /> : null}
      {dialog === 'share' ? <ShareDialog sid={sid} onClose={() => setDialog(null)} onCreated={() => setShareReload((x) => x + 1)} /> : null}
    </div>
  );
}
