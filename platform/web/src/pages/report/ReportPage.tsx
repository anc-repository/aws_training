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
import { ATTEMPT_STATUS_META, Button, EmptyState, ErrorPanel, Icon, SessionStatePill, Shape, Skeleton, Status, type AttemptStatus } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { Missing } from '../errors/NotFoundPage';
import { useAction } from '../errors/useAction';
import { ExperimentCompare } from '../experiments/ExperimentCompare';
import { cardTitle, useApiData, useCatalogIndex, useLabContent, useSessionView, viewX, type SessionViewX } from '../sessions/data';
import '../sessions/pages.css';
import { BADGE_LEVEL_TEXT, BADGE_STATUS_TEXT, formatMoneyRange, hourlyRange } from '../sessions/sessionText';
import { ExportDialog } from './ExportDialog';
import { ShareDialog, ShareList } from './Shares';
import { CheckHistory, StepEvidence, type StepResult } from './StepEvidence';

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

export const REVISION_REASON_TEXT: Readonly<Record<string, string>> = {
  finalize: '定稿',
  cleanup: '追加清理结果',
  'late-ownership': '追加延迟归属',
  ownership: '追加延迟归属',
  rescan: '追加复扫结果',
  quiz: '追加小测成绩',
  certificate: '追加证书',
  regenerate: '重新生成',
  manual: '重新生成',
};

export default function ReportPage() {
  const { sid = '' } = useParams();
  const { view, status, error, retry } = useSessionView(sid);
  if (status === 'missing') return <Missing title="没有这个会话" />;
  if (status === 'error' && !view) return <ErrorPanel error={error ?? { code: 'INTERNAL' }} onRetry={retry} title="实验报告" />;
  if (!view) return <Skeleton lines={6} block label="正在读取会话" />;
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
      <nav className="crumbs-row" aria-label="面包屑">
        <Link to="/sessions">我的实验</Link>
        <span aria-hidden="true">›</span>
        <Link className="mono" to={`/sessions/${sid}`}>
          {sid}
        </Link>
        <span aria-hidden="true">›</span>
        <span>实验报告</span>
      </nav>
      <div className="ph">
        <div className="ttl">
          <h1 tabIndex={-1}>{view.labId} · 实验报告</h1>
          <span className="sub">{sub}</span>
        </div>
        {acts ? <span className="acts no-print">{acts}</span> : null}
      </div>
    </div>
  );

  if (nr) {
    return (
      <div className="stack-16" data-screen="P08" data-report="none">
        {header(<>会话 <span className="mono">{sid}</span></>)}
        <EmptyState
          title="这次会话没有报告"
          action={
            <Link className="btn" to={`/sessions/${sid}`}>
              会话详情
            </Link>
          }
        >
          会话在环境就绪前结束（这次尝试不计入次数）。
        </EmptyState>
      </div>
    );
  }

  if (!live && !report.loaded) {
    if (report.status === 'missing') {
      if (view.state === 'ENDING') {
        return (
          <div className="stack-16" data-screen="P08" data-report="generating">
            {header(<>会话 <span className="mono">{sid}</span></>)}
            <p role="status">报告正在生成（最终复核与报告快照，通常几分钟）。</p>
            <Skeleton lines={6} block label="报告正在生成" />
          </div>
        );
      }
      return (
        <div className="stack-16" data-screen="P08" data-report="failed">
          {header(<>会话 <span className="mono">{sid}</span></>)}
          <div className="note amber" role="status">
            <Shape name="tri" />
            <span className="spacer">报告快照未能在结束时生成（不影响资源释放）。</span>
            {L ? (
              <Button size="sm" busy={regen.busy} busyText="正在请求…" onClick={() => void regen.run({ params: { sid } })}>
                重新生成
              </Button>
            ) : null}
          </div>
          {regen.data ? <p className="small muted" role="status">已开始重新生成报告，完成后自动刷新。</p> : null}
          {regen.error ? <InlineProblem error={regen.error} onRetry={() => void regen.retry()} /> : null}
        </div>
      );
    }
    if (report.status === 'error') return <InlineProblem error={report.error} onRetry={() => void report.refresh()} title="实验报告" />;
    return <Skeleton lines={6} block label="正在读取报告" />;
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
  const startText = start ? formatMoneyRange(start.low, start.high, q?.currency ?? 'USD', '/小时') : null;
  const ev = r?.summary?.evidenceQuality;
  const followUp = (view.reclaim as { followUp?: string } | null)?.followUp;
  const cleanupText =
    view.state === 'CLEANUP_FAILED'
      ? `释放未完成（${view.cleanup?.manual ?? '?'} 项待人工处理）`
      : view.state === 'ENDING' || view.state === 'CLEANING'
        ? '回收进行中，完成后报告会追加修订'
        : view.state === 'KEPT'
          ? '环境保留中'
          : live
            ? '实验进行中'
            : `已释放${followUp === 'PENDING' ? '（复扫进行中）' : ''}`;
  const acct = platform.data?.accountId ? maskAccountId(platform.data.accountId) : '••••';
  const revisions = (r?.revisions ?? []).filter((x) => typeof x.version === 'number');
  const htmlUrl = r?.downloads?.html?.url ?? null;
  const experiments = lab?.experiments ?? [];

  return (
    <div className="stack-24" data-screen="P08" data-report={live ? 'preview' : 'ready'}>
      {header(
        live ? (
          <>
            预览（不保存）· 会话 <span className="mono">{sid}</span> · <SessionStatePill state={view.state} size="sm" />
          </>
        ) : (
          <>
            第 {r?.version ?? '?'} 版{r?.reason && REVISION_REASON_TEXT[r.reason] ? `（${REVISION_REASON_TEXT[r.reason]}）` : ''}
            {r?.generatedAt ? (
              <span title={formatUtcTitle(r.generatedAt)}> · 生成于 {formatDate(r.generatedAt, now)}</span>
            ) : null}{' '}
            · 会话 <span className="mono">{sid}</span>
          </>
        ),
        !live ? (
          <>
            <label className="sr" htmlFor="rep-ver">
              版本
            </label>
            <select id="rep-ver" className="input" value={String(r?.version ?? '')} onChange={() => undefined} aria-describedby="rep-ver-note">
              <option value={String(r?.version ?? '')}>第 {r?.version ?? '?'} 版（最新）</option>
            </select>
            {L ? (
              <>
                <Button busy={regen.busy} busyText="正在请求…" onClick={() => void regen.run({ params: { sid } })}>
                  重新生成
                </Button>
                <Button onClick={() => setDialog('export')}>导出…</Button>
                <Button onClick={() => setDialog('share')}>分享…</Button>
              </>
            ) : null}
          </>
        ) : undefined,
      )}

      {revisions.length > 1 ? (
        <p className="small muted" id="rep-ver-note">
          共 {revisions.length} 版；这里显示最新版，较早的版本平台支持后可在此查看。
        </p>
      ) : (
        <span id="rep-ver-note" hidden />
      )}
      {regen.data ? <p className="small muted" role="status">已开始重新生成报告，完成后自动刷新。</p> : null}
      {regen.error ? <InlineProblem error={regen.error} onRetry={() => void regen.retry()} /> : null}
      {newer ? (
        <div className="note blue" role="status">
          <Shape name="dot" />
          <span className="spacer">报告已更新到第 {newer} 版。</span>
          <Button
            size="sm"
            onClick={() => {
              setNewer(null);
              void report.refresh();
            }}
          >
            查看
          </Button>
        </div>
      ) : null}
      {live ? (
        <div className="note amber">
          <Shape name="tri" />
          <span>实验尚未结束，以下是预览（不保存）。没有导出与分享。</span>
        </div>
      ) : null}

      <section className="sec" aria-labelledby="r-sum" data-section="summary">
        <h2 id="r-sum">摘要</h2>
        <div className="statgrid">
          <div className="stat">
            <span className="k">结论</span>
            <span className="v">
              {attemptMeta ? <Status meta={attempt === 'unverified' ? { ...attemptMeta, text: '未能核验' } : attemptMeta} /> : '—'}
              {myBadge && badgeTitle ? ` · 徽章“${badgeTitle}”` : ''}
              {myBadge?.level ? ` · ${BADGE_LEVEL_TEXT[myBadge.level] ?? myBadge.level}` : ''}
              {myBadge?.status && myBadge.status !== 'valid' ? `（${BADGE_STATUS_TEXT[myBadge.status] ?? myBadge.status}）` : ''}
              {typeof myBadge?.evidenceScore === 'number' ? `（证据分 ${myBadge.evidenceScore.toFixed(2)}）` : ''}
            </span>
            {attempt === 'unverified' ? <span className="small muted">部分资源的归属尚未确认，复扫完成后会自动更新报告。</span> : null}
            {attempt === 'incomplete' && r?.eligibility?.reasons?.length ? <span className="small muted">未完成：{r.eligibility.reasons.join('；')}</span> : null}
            {view.endReason === 'IDLE_NOT_STARTED' ? <span className="small muted">未开始：环境就绪后一直没有进入工作台。</span> : null}
          </div>
          <div className="stat">
            <span className="k">用时</span>
            <span className="v tnum">
              {view.readyAt ? `就绪 ${formatClock(view.readyAt)}` : '—'}
              {view.endedAt ? ` → 结束 ${formatClock(view.endedAt)}` : live ? ' → 进行中' : ''}
              {total ? ` · 共 ${total}` : ''} · 延长 {view.extensions?.length ?? 0} 次
            </span>
          </div>
          <div className="stat">
            <span className="k">检查</span>
            <span className="v">
              步骤 {r?.summary?.stepsDone ?? view.progress?.stepsDone ?? '—'}/{r?.summary?.stepsTotal ?? view.progress?.stepsTotal ?? '—'}
              {ev ? ` · 可信度：高 ${ev.high ?? 0} · 中 ${ev.medium ?? 0} · 低 ${ev.low ?? 0}` : ''}
            </span>
          </div>
          <div className="stat">
            <span className="k">费用</span>
            <span className="v">
              开始前估算 {startText ?? '未知'} · 按实际时长的重算见 HTML 报告（估算 · 单价取自 Price List · 以账单为准）
            </span>
          </div>
          <div className="stat">
            <span className="k">清理</span>
            <span className="v">
              {cleanupText}
              {view.state === 'CLEANUP_FAILED' ? (
                <>
                  {' '}
                  <Link to={`/sessions/${sid}/end#manual`}>清单</Link>
                </>
              ) : null}
            </span>
          </div>
          <div className="stat">
            <span className="k">环境</span>
            <span className="v">
              {view.reuseOfEnvId ? '复用环境' : '全新环境'} · <span className="mono">{platform.data?.region ?? '—'}</span> · 账号 {acct}
              {view.startProfile ? (
                <>
                  {' '}
                  · 起始档位 <span className="mono">{view.startProfile}</span>
                </>
              ) : null}
            </span>
          </div>
        </div>
      </section>

      {!live ? (
        <div className="note no-print">
          <Icon name="doc" />
          <span>
            这里显示摘要与本次会话的检测记录；完整报告（含较大的证据、小测与按实际时长重算的费用）请
            {L && htmlUrl ? (
              <a href={htmlUrl} target="_blank" rel="noopener noreferrer">
                下载 HTML 报告<span className="sr">（新标签页）</span>
              </a>
            ) : L ? (
              '在导出中下载 HTML 报告'
            ) : (
              '由学员导出 HTML 报告'
            )}
            查看。
          </span>
        </div>
      ) : null}

      <nav className="toc no-print" aria-label="报告目录">
        目录：
        <a href="#r-steps">逐步证据</a>
        <a href="#r-exp">对比实验</a>
        <a href="#r-cost">费用</a>
        <a href="#r-clean">清理</a>
        <a href="#r-app">附录</a>
      </nav>

      <section className="sec" id="r-steps" tabIndex={-1} aria-labelledby="r-steps-h">
        <h2 id="r-steps-h">逐步证据</h2>
        <StepEvidence sid={sid} lab={lab} steps={steps.data?.items ?? []} loaded={steps.loaded} error={steps.error} onRetry={() => void steps.refresh()} nowMs={now} />
        <details className="disc">
          <summary>完整检查记录</summary>
          <CheckHistory sid={sid} lab={lab} nowMs={now} />
        </details>
      </section>

      <section className="sec" id="r-exp" tabIndex={-1} aria-labelledby="r-exp-h">
        <h2 id="r-exp-h">对比实验</h2>
        {!experiments.length ? <p className="small muted">本卡片没有对比实验。</p> : null}
        {experiments.map((x) => (
          <div key={`${x.module}/${x.id}`} className="stack-8" data-experiment={`${x.module}/${x.id}`}>
            <h3>
              {x.module}/{x.id}
              {x.required ? '（必做）' : '（选做）'}{' '}
              <Link className="small" to={`/sessions/${sid}/experiments/${x.module}/${x.id}`}>
                打开对比视图
              </Link>
            </h3>
            {x.required ? <ExperimentCompare view={view} module={x.module} experimentId={x.id} mode="report" /> : null}
          </div>
        ))}
      </section>

      <section className="sec" aria-labelledby="r-quiz-h">
        <h2 id="r-quiz-h">小测</h2>
        <p className="small">
          {myBadge?.quiz?.bestScore != null ? `最好成绩 ${myBadge.quiz.bestScore} · 作答 ${myBadge.quiz.attempts ?? 1} 次。` : '小测成绩见 HTML 报告。'}只记录，不影响完成与徽章。
        </p>
      </section>

      <section className="sec" id="r-cost" tabIndex={-1} aria-labelledby="r-cost-h">
        <h2 id="r-cost-h">费用</h2>
        <p className="small">开始前的估算与按实际时长的重算都是估算（单价取自 Price List{q?.priceAsOf ? `，取价时间 ${formatDate(q.priceAsOf, now)}` : ''}），不含数据传输与部分按请求计费项，以 AWS 账单为准。</p>
        <dl className="kv">
          <dt>开始前估算</dt>
          <dd>
            {startText ?? '未知（单价暂不可得）'}
            {q?.quoteId ? (
              <span className="small faint">
                {' '}
                · 报价 <span className="mono">{q.quoteId.slice(0, 6)}…</span>
              </span>
            ) : null}
          </dd>
          <dt>账单实际</dt>
          <dd className="small muted">激活成本分配标签后，可在 AWS Cost Explorer 中按 atl:session-id 查看（数据通常有一天左右的延迟）。</dd>
        </dl>
        {role !== 'O' ? (
          <p className="small">
            <Link to={`/sessions/${sid}?tab=cost`}>在会话详情中查看计费资源与按实际时长重算的估算 →</Link>
          </p>
        ) : null}
      </section>

      <section className="sec" id="r-clean" tabIndex={-1} aria-labelledby="r-clean-h">
        <h2 id="r-clean-h">清理</h2>
        <p className="small">
          {cleanupText}
          {view.cleanup?.deleted != null ? ` · 已回收 ${view.cleanup.deleted} 项` : ''}
          {view.cleanup?.manual ? ` · 待人工处理 ${view.cleanup.manual} 项` : ''} · <Link to={`/sessions/${sid}/end`}>回收进度</Link>
        </p>
      </section>

      <section className="sec" id="r-app" tabIndex={-1} aria-labelledby="r-app-h">
        <h2 id="r-app-h">附录</h2>
        <dl className="kv small">
          <dt>卡片</dt>
          <dd>
            <span className="mono">{view.labId}</span>
            {cardTitle(index, view.labId) ? ` · ${cardTitle(index, view.labId)}` : ''}
          </dd>
          <dt>卡片版本</dt>
          <dd className="mono">{view.labVersion ?? '—'}</dd>
          <dt>目录版本</dt>
          <dd className="mono">{view.catalogVersion ?? '—'}</dd>
          <dt>起始变体</dt>
          <dd className="mono">{view.variant ?? 'default'}</dd>
          {r?.digest ? (
            <>
              <dt>报告完整性摘要</dt>
              <dd>
                <span className="mono">{r.digest.slice(0, 19)}…</span>（RFC 8785）{' '}
                <button type="button" className="linkbtn no-print" onClick={() => void copyText(r.digest!)} aria-label="复制报告完整性摘要">
                  复制
                </button>
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      {L && !live ? (
        <section className="sec no-print" aria-labelledby="r-share-h" data-section="shares">
          <h2 id="r-share-h">
            分享链接
            <span className="aside">
              <button type="button" className="linkbtn" onClick={() => setDialog('share')}>
                创建分享链接…
              </button>
            </span>
          </h2>
          <ShareList sid={sid} reloadKey={shareReload} />
        </section>
      ) : null}

      <p className="print-only small">
        导出时间 {formatDate(now, now)} · 账号 ID 已打码 · 自托管 ATL 实验平台（非 AWS 官方）
      </p>

      {dialog === 'export' ? <ExportDialog sid={sid} onClose={() => setDialog(null)} /> : null}
      {dialog === 'share' ? <ShareDialog sid={sid} onClose={() => setDialog(null)} onCreated={() => setShareReload((x) => x + 1)} /> : null}
    </div>
  );
}
