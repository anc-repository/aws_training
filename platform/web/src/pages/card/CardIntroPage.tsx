/**
 * P03 卡片简介页 `/labs/:labId`（08 §4 P03；05 §7）：卡片的封面，也是开始实验的唯一入口。
 * - 静态部分（index.json 中的该卡 + cards/<labId>.json）先渲染，个人部分（GET /labs/{labId}：状态、徽章、历次尝试、startability）
 *   到达后填充；个人部分失败时按钮区“暂时无法判断能否开始 · 重试”，开始按钮置灰；
 * - “开始实验”按钮由 startability（权威）+ 本地预判决定（startModel）；planned 卡片只显示、不能开始；A、O 没有开始与小测；
 * - 查询串：`start=1`（只对 L，打开开始对话框后立即从地址栏移除）、`variant=<id>`、`reuse=<envId>`；
 * - 生成区块按 05 §7.3 的固定句式渲染；作者撰写的概览（mdast）按二级标题放进对应区块；
 * - 视觉化（I6 d）：首屏是“开始时 → 完成后”的架构图与“你将学到”的服务图标列表；“有 vs 没有”是左右并排的图示卡片；
 *   步骤概览用步骤类型图标；资源说明、作者概览、费用说明等长段落折叠到“詳しく / Details”（<details>）；
 * - 窄屏：右栏移到左栏之后，底部吸底操作栏（开始 / 回到工作台、小测），置灰原因仍写在页头。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { isApiError } from '../../api/errors';
import { useAuth, useServices, useSessionSync } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { msg, t } from '../../i18n';
import { formatDate } from '../../lib/format';
import { Button, CostTierMark, Dialog, EmptyState, ErrorPanel, SessionStatePill, Shape, Skeleton } from '../../ui';
import { MetricIcon, StepTypeIcon } from '../../ui/charts';
import { ArchDiagram, archInputFromCatalogCard, archInputFromIntro } from '../../ui/diagram';
import { glyphModule, resolveModuleId, ServiceChip, ServiceGlyph } from '../../ui/glyphs';
import '../labs/catalog.css';
import { badgeLabel, CardBadge, kindLine, ServiceStrip } from '../labs/components/CardTile';
import { badgeStateOf, StateText } from '../labs/components/Marks';
import { CardGlyph, CardMetrics, More, primaryServices } from '../labs/components/Visuals';
import { progressMap, useCardIntro, useCatalog, useHolder, useLabs, useResource } from '../labs/data';
import { cardFlags, cardStateOf, catClass, isDoneStatus, limitText, membershipOf } from '../labs/model';
import { BADGE_LEVEL_TEXT, DOMAIN_TEXT, FLAG_TEXT, INPUT_TEXT, PROVISION_HINT, PROVISION_TEXT, S, SECTION_TEXT, STEP_TYPE_TEXT } from '../labs/strings';
import type { CardIntro, CatalogCard, CostQuote, LabDetail } from '../labs/types';
import { MarkdownView, splitOverview } from './Mdast';
import { QuotePanel } from './QuotePanel';
import { StartDialog } from './StartDialog';
import { startModel, type ResidualPolicy, type StartModel } from './startModel';
import { SS } from './strings';

import zhPages from '../../i18n/zh-CN/pages';
import { untranslated } from '../../i18n/content';
import { UntranslatedIf } from '../../i18n/Untranslated';

const PC = msg.pages.card;
const zhOverviewHeading = zhPages.card.overviewHeading;
// ---------------------------------------------------------------------------------------------------------------
// 开始区

interface StartAreaProps {
  model: StartModel;
  compact?: boolean;
  onStart: (env: 'fresh' | 'reuse') => void;
  onRelease: () => void;
  onRetry: () => void;
}

function StartArea({ model: m, compact, onStart, onRelease, onRetry }: StartAreaProps) {
  switch (m.kind) {
    case 'hidden':
      return null;
    case 'loading':
      return (
        <Button variant="primary" busy busyText={SS.start.start}>
          {SS.start.start}
        </Button>
      );
    case 'unknown':
      return (
        <>
          <Button variant="primary" disabledReason={compact ? null : SS.page.personalFailed}>
            {SS.start.start}
          </Button>
          {compact ? null : (
            <Button size="sm" onClick={onRetry}>
              {SS.page.personalRetry}
            </Button>
          )}
        </>
      );
    case 'holder':
      return (
        <Link className="btn primary" to={m.to}>
          {SS.start.toWorkspace}
        </Link>
      );
    case 'blocked':
      return (
        <>
          <Button variant="primary" aria-disabled data-start-blocked={m.code} aria-describedby={compact ? undefined : 'start-why'} onClick={() => undefined}>
            {SS.start.start}
          </Button>
          {compact ? null : (
            <span className="small start-why" id="start-why" data-reason={m.code}>
              {m.text}
              {m.link ? (
                <>
                  {' '}
                  <Link to={m.link.to}>{m.link.label}</Link>
                </>
              ) : null}
            </span>
          )}
        </>
      );
    case 'kept':
      return (
        <>
          {m.compatible ? (
            <Button variant="primary" onClick={() => onStart('reuse')} title={SS.start.startHint}>
              {SS.start.startReuse}
            </Button>
          ) : null}
          <Button onClick={onRelease}>{SS.start.releaseFresh}</Button>
          {!m.compatible && !compact && m.reasonText ? <span className="small muted start-why">{m.reasonText}</span> : null}
        </>
      );
    case 'start':
      return (
        <>
          <Button variant="primary" onClick={() => onStart('fresh')} title={SS.start.startHint} data-start="">
            {m.residual === 'ack' ? SS.start.startResidual : SS.start.start}
          </Button>
          {m.residual === 'info' && !compact ? <span className="small st drift start-why">{SS.start.residualInfo}</span> : null}
        </>
      );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 对话框：释放后全新开始、只计算价格

function ReleaseDialog({ open, sid, onClose, onDone }: { open: boolean; sid: string | null; onClose: () => void; onDone: () => void }) {
  const { api, sync } = useServices();
  const [state, setState] = useState<{ busy: boolean; done: boolean; error: string | null }>({ busy: false, done: false, error: null });
  const op = useRef<ReturnType<typeof api.operation> | null>(null);
  useEffect(() => {
    if (open) {
      setState({ busy: false, done: false, error: null });
      op.current = null;
    }
  }, [open]);
  const go = async () => {
    if (!sid) return;
    if (!op.current) op.current = api.operation('releaseKeep');
    setState({ busy: true, done: false, error: null });
    try {
      await op.current.run({ params: { sid } });
      void sync.refreshCurrent();
      setState({ busy: false, done: true, error: null });
      onDone();
    } catch (e) {
      const msg = isApiError(e) && e.code === 'REUSE_IN_PROGRESS' ? SS.release.inProgress : isApiError(e) ? (e.detail ?? e.title) : String(e);
      setState({ busy: false, done: false, error: msg });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={SS.release.title}
      size="narrow"
      alert
      initialFocus="[data-release-cancel]"
      footer={
        state.done ? (
          <>
            <Button onClick={onClose}>{SS.quoteOnly.close}</Button>
            {sid ? (
              <Link className="btn primary" to={`/sessions/${sid}/end`} onClick={onClose}>
                {SS.release.viewProgress}
              </Link>
            ) : null}
          </>
        ) : (
          <>
            <Button onClick={onClose} data-release-cancel="">
              {SS.dialog.cancel}
            </Button>
            <Button variant="danger-solid" busy={state.busy} busyText={SS.release.busy} onClick={() => void go()}>
              {SS.release.confirm}
            </Button>
          </>
        )
      }
    >
      {state.done ? (
        <p role="status">{SS.release.started}</p>
      ) : (
        <>
          <p>{SS.release.body}</p>
          {state.error ? (
            <p className="note red" role="alert">
              {state.error}
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

function QuoteOnlyDialog({ open, card, intro, onClose }: { open: boolean; card: CatalogCard; intro: CardIntro | null; onClose: () => void }) {
  const { api } = useServices();
  const [q, setQ] = useState<{ quote: CostQuote | null; error: unknown }>({ quote: null, error: null });
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setQ({ quote: null, error: null });
    api
      .call<CostQuote>('createLabQuote', { params: { labId: card.id }, body: { purpose: 'START' } })
      .then((r) => !cancelled && setQ({ quote: r.data, error: null }))
      .catch((e: unknown) => !cancelled && setQ({ quote: null, error: e }));
    return () => {
      cancelled = true;
    };
  }, [open, api, card.id]);
  const ext = intro?.timing?.extensions ?? { maxCount: 2, minutesEach: 30 };
  return (
    <Dialog open={open} onClose={onClose} title={t(SS.quoteOnly.title, { id: card.id })} footer={<Button onClick={onClose}>{SS.quoteOnly.close}</Button>}>
      {q.quote ? (
        <>
          <p className="small muted">{SS.quoteOnly.lead}</p>
          <QuotePanel quote={q.quote} options={{ workstation: 'ec2', reuse: false, limitMinutes: card.timeLimitMinutes, extensions: { count: ext.maxCount, minutes: ext.minutesEach } }} />
        </>
      ) : q.error && isApiError(q.error) ? (
        <ErrorPanel error={q.error} />
      ) : (
        <div className="row small" role="status">
          <Shape name="spin" spin />
          {SS.dialog.quoting}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 生成区块（05 §7.3 固定句式）

function ResourcesBlock({ intro, region }: { intro: CardIntro | null; region: string }) {
  const r = intro?.resources;
  const provisions = (r?.provisions ?? []).filter((x) => x.kind !== 'platform');
  const sentence = (x: (typeof provisions)[number]) => {
    switch (x.kind) {
      case 'module':
        return t(SS.sections.resourcesModule, { name: x.displayName, reason: x.reason });
      case 'local':
        return t(SS.sections.resourcesLocal, { name: x.displayName, reason: x.reason });
      case 'runtime':
        return t(SS.sections.resourcesRuntime, { name: x.displayName, reason: x.reason });
      default:
        return t(SS.sections.resourcesSeed, { name: x.displayName, reason: x.reason });
    }
  };
  const ws = intro?.workstation;
  return (
    <div className="stack-8">
      <p>{t(SS.sections.resourcesIntro, { region })}{PC.colon}</p>
      {provisions.length || r?.extraStacks?.length ? (
        <ul>
          {provisions.map((x) => (
            <li key={`${x.kind}-${x.item}`}>{sentence(x)}</li>
          ))}
          {(r?.extraStacks ?? []).map((x) => (
            <li key={x.id}>{t(SS.sections.resourcesExtra, { title: x.title })}</li>
          ))}
        </ul>
      ) : null}
      <p className="small muted">{SS.sections.resourcesChannel}</p>
      {r?.targets?.length ? (
        <p>
          <b>{SS.sections.target}</b>
          {r.targets
            .map((x) => `${x.from ? t(SS.sections.targetItem, { name: x.displayName, from: x.from, to: x.to }) : t(SS.sections.targetItemNew, { name: x.displayName, to: x.to })}${x.optional ? SS.sections.optional : ''}`)
            .join(PC.nameSep)}
          {PC.period}
          {SS.sections.targetTail}
        </p>
      ) : null}
      {(r?.expectedWarnings ?? []).map((w) => (
        <p key={w.rule} className="small muted">
          {t(SS.sections.warnings, { name: w.rule, text: w.text })}
        </p>
      ))}
      <p className="small muted">
        {SS.sections.workstation}
        {ws?.savingsMode === 'degraded' ? SS.sections.workstationDegraded : ws?.savingsMode === 'unsupported' ? SS.sections.workstationRequired : ''}
      </p>
      <p className="small muted">
        {SS.sections.cleanup}
        {intro?.cleanupSummary ? ` ${intro.cleanupSummary}` : ''}
      </p>
    </div>
  );
}

/** lab.schema 的步骤类型 → 步骤类型图标（I6 e 的 6 种）；没有专门图标的类型借用最接近的一种，类型名另写给读屏。 */
const STEP_ICON: Readonly<Record<string, string>> = { read: 'observe', manual: 'console', 'platform-action': 'script', wire: 'code' };

function StepMarkIcon({ kind }: { kind: 'wait' | 'bill' | 'outage' }) {
  return (
    <svg className="smk-ico" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {kind === 'wait' ? (
        <>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 4.5V8l2.6 1.6" />
        </>
      ) : kind === 'bill' ? (
        <path d="M10.8 4.6c-.5-.8-1.6-1.3-2.8-1.3-1.6 0-2.8.8-2.8 2.1 0 2.9 5.7 1.6 5.7 4.6 0 1.3-1.2 2.2-2.9 2.2-1.3 0-2.4-.6-2.9-1.5M8 1.8v12.4" />
      ) : (
        <>
          <path d="M8 2.2l6.2 11H1.8z" />
          <path d="M8 6.6v3M8 11.4v.2" />
        </>
      )}
    </svg>
  );
}

/** 步骤概览（I6 d）：步骤类型图标 + 标题 + 标记图标（选做、等待、开始计费、预期中断），代替原来的四列表格。 */
function StepsList({ intro }: { intro: CardIntro | null }) {
  const steps = intro?.steps ?? [];
  if (!steps.length) return <p className="small muted">{SS.sections.noSteps}</p>;
  return (
    <ol className="steplist">
      {steps.map((s, i) => (
        <li key={s.id} className={s.optional ? 'opt' : undefined} data-step={s.id}>
          <span className="sl-no tnum" aria-hidden="true">
            {i + 1}
          </span>
          <span className="sl-type" title={STEP_TYPE_TEXT[s.type] ?? s.type}>
            <StepTypeIcon type={STEP_ICON[s.type] ?? s.type} size={20} />
            <span className="sr">{STEP_TYPE_TEXT[s.type] ?? s.type}</span>
          </span>
          <span className="sl-title wrap-any">{s.title}</span>
          <span className="sl-marks">
            {s.optional ? <span className="tag">{SS.sections.markOptional}</span> : null}
            {s.wait ? (
              <span className="smk">
                <StepMarkIcon kind="wait" />
                {t(SS.sections.markWait, { n: s.wait.typicalMinutes })}
              </span>
            ) : null}
            {s.startsBilling ? (
              <span className="smk">
                <StepMarkIcon kind="bill" />
                {s.startsBilling.class === 'hourly' ? SS.sections.markHourly : SS.sections.markUsage}
              </span>
            ) : null}
            {s.expectedOutage ? (
              <span className="smk warn">
                <StepMarkIcon kind="outage" />
                {SS.sections.markOutage}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** SAA 领域的小图形（与领域文字一起出现；单独出现时有读屏文字）。 */
function DomainMark({ domain }: { domain: string }) {
  const name = DOMAIN_TEXT[domain as keyof typeof DOMAIN_TEXT] ?? domain;
  return (
    <span className={`dom-mark d-${domain}`} title={name}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {domain === 'secure' ? (
          <path d="M8 1.8l5.2 2v4c0 3.2-2.2 5.4-5.2 6.4-3-1-5.2-3.2-5.2-6.4v-4z" />
        ) : domain === 'resilient' ? (
          <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
        ) : domain === 'performance' ? (
          <path d="M9 1.8L3.5 9H8l-1 5.2L12.5 7H8z" />
        ) : (
          <path d="M10.8 4.6c-.5-.8-1.6-1.3-2.8-1.3-1.6 0-2.8.8-2.8 2.1 0 2.9 5.7 1.6 5.7 4.6 0 1.3-1.2 2.2-2.9 2.2-1.3 0-2.4-.6-2.9-1.5M8 1.8v12.4" />
        )}
      </svg>
      <span className="sr">{name}</span>
    </span>
  );
}

interface VsTarget {
  id: string;
  name: string;
  from: string | null;
  to: string | null;
  optional: boolean;
}

/** “有 vs 没有”的并排图示卡片（I6 d）：左边是开始时（本地实现或还没有），右边是完成后的 AWS 服务。 */
function ComparePair({ target: x }: { target: VsTarget }) {
  const short = glyphModule(x.id)?.short ?? x.name;
  return (
    <figure className="vs-pair" data-vs={x.id}>
      <div className="vs-side before">
        <span className="vs-cap">{t(SS.visual.without, { name: short })}</span>
        {x.from ? (
          <svg className="vs-local" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
            <rect x="1" y="1" width="38" height="38" rx="8" />
            <path d="M11 14h18M11 20h18M11 26h12" />
          </svg>
        ) : (
          <ServiceGlyph id={x.id} size={40} tone="ghost" />
        )}
        <span className={x.from ? 'vs-name mono' : 'vs-name muted'}>{x.from ?? SS.visual.none}</span>
        <span className="vs-note small faint">{x.from ? SS.visual.local : SS.visual.notYet}</span>
      </div>
      <span className="vs-arrow" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" focusable="false">
          <path d="M4 10h11M11 6l4 4-4 4" />
        </svg>
      </span>
      <div className="vs-side after">
        <span className="vs-cap">{t(SS.visual.with, { name: short })}</span>
        <ServiceGlyph id={x.id} size={40} />
        <span className="vs-name mono">{x.to ?? short}</span>
        <span className="vs-note small faint">{x.optional ? SS.sections.elective : glyphModule(x.id)?.awsService ?? x.name}</span>
      </div>
      <figcaption className="sr">{x.from ? t(SS.sections.targetItem, { name: x.name, from: x.from, to: x.to ?? '' }) : t(SS.sections.targetItemNew, { name: x.name, to: x.to ?? '' })}</figcaption>
    </figure>
  );
}

function revertText(r: string): string {
  return r === 'delete' ? SS.sections.revertDelete : r === 'keep' ? SS.sections.revertKeep : SS.sections.revertRestore;
}

// ---------------------------------------------------------------------------------------------------------------

export default function CardIntroPage() {
  const { labId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const location = useLocation();
  const { api, clock } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const status = useGlobalStatus();
  const { current } = useSessionSync();
  const catalog = useCatalog();
  const card = catalog.cards.get(labId) ?? null;
  const intro = useCardIntro(card ? catalog.ref : null, labId);
  const detail = useResource<LabDetail>(card ? `lab:${labId}` : null, () => api.get<LabDetail>('getLab', { params: { labId } }), { pollMs: 60_000 });
  const labs = useLabs(!!card);
  const holder = useHolder(labs.data);
  const progress = useMemo(() => progressMap(labs.data), [labs.data]);
  const [dialog, setDialog] = useState<{ kind: 'start'; env: 'fresh' | 'reuse' } | { kind: 'release' } | { kind: 'quote' } | null>(null);
  const trackId = ((location.state as { trackId?: unknown } | null)?.trackId as string | undefined) ?? null;

  const residualPolicy: ResidualPolicy = status.guardrails?.reclaim?.blockStartOnResidual ?? 'ack';
  const model = startModel({
    role,
    labId,
    cardStatus: card?.status,
    detail: detail.data,
    detailFailed: !!detail.error && !detail.data,
    current,
    platform: status.platform.data ? { mode: status.platform.data.mode, maintenance: status.platform.data.maintenance } : null,
    budget: status.guardrails?.budget ?? null,
    residualPolicy,
    residualHourly: status.manual?.hourlyBlocking ?? 0,
  });

  // ?start=1：只对 L，打开开始对话框后立即从地址栏移除（08 §2.5、D-UI-5）
  const startParam = sp.get('start') === '1';
  const startHandled = useRef(false);
  const keptCompatible = model.kind === 'kept' && model.compatible;
  useEffect(() => {
    if (!startParam || startHandled.current || model.kind === 'loading') return;
    startHandled.current = true;
    const next = new URLSearchParams(sp);
    next.delete('start');
    setSp(next, { replace: true });
    if (model.kind === 'start') setDialog({ kind: 'start', env: 'fresh' });
    else if (keptCompatible) setDialog({ kind: 'start', env: 'reuse' });
  }, [startParam, model.kind, keptCompatible, sp, setSp]);

  if (catalog.error && !catalog.index) return <ErrorPanel error={catalog.error} onRetry={catalog.reload} />;
  if (!catalog.index) return <Skeleton lines={6} block />;
  if (!card) {
    return (
      <EmptyState
        page
        title={SS.page.notFoundTitle}
        action={
          <Link className="btn" to="/labs">
            {SS.page.back}
          </Link>
        }
      >
        {t(SS.page.notFound, { id: labId })}
      </EmptyState>
    );
  }

  const index = catalog.index;
  const tax = index.taxonomy;
  const L = role === 'L';
  const planned = card.status === 'planned';
  const item = labs.data?.items.find((i) => i.labId === labId) ?? null;
  const personalBadge = detail.data?.progress.badge ?? item?.badge ?? null;
  const state = cardStateOf(labId, holder, item ?? (detail.data ? { status: detail.data.progress.status, lastSession: detail.data.attempts[0] ? { sessionId: detail.data.attempts[0].sessionId, state: detail.data.attempts[0].state } : null } : null), clock.now());
  const attemptsN = detail.data?.progress.attempts ?? item?.attempts ?? 0;
  const flags = cardFlags(card, { drRegion: catalog.ref?.drRegion ?? null, completedMajor: item?.completedMajorVersion ?? null });
  const overview = splitOverview(intro.data?.overview ?? null);
  // 概览的小节按标题匹配：当前语言的标题或 zh-CN 源标题（内容的 overview.md 用词典 pages.card.overviewHeading 中的标题）
  const section = (key: keyof typeof PC.overviewHeading) => overview.find((o) => o.title === PC.overviewHeading[key] || o.title === zhOverviewHeading[key])?.nodes ?? null;
  const background = section('background');
  const whyTogether = section('why');
  const expPreview = section('experiments');
  const platformNote = section('platform');
  const ext = intro.data?.timing?.extensions ?? { maxCount: 2, minutesEach: 30 };
  const retain = intro.data?.timing?.retain;
  const prereqCards = intro.data?.prerequisites?.cards ?? card.prerequisites ?? [];
  const inputs = card.learnerInputs ?? [];
  const impacts = intro.data?.accountImpact ?? card.accountImpact ?? [];
  const ops = intro.data?.platformOps ?? card.platformOps ?? [];
  const tracks = membershipOf(index, labId);
  const region = catalog.ref?.region ?? status.platform.data?.region ?? '—';
  const learnerVariants = (card.variants ?? []).filter((v) => v.select === 'learner');
  const preflightVariant = (card.variants ?? []).find((v) => v.select === 'preflight');
  const reuseParam = sp.get('reuse');
  const reuseInfo = model.kind === 'kept' && model.reuseEnvId ? { envId: model.reuseEnvId, fromLabId: model.fromLabId, compatible: model.compatible } : null;
  const residualForDialog = model.kind === 'start' ? model.residual : null;
  const crumbsCat = card.kind === 'service' ? kindLine(card, tax) : S.catalog.sectionScenario;
  const openStart = (env: 'fresh' | 'reuse') => setDialog({ kind: 'start', env });
  // I6 d：架构图的输入（简介页数据到达前用目录卡片的 startProfiles + targets）
  const archInput = intro.data?.resources ? archInputFromIntro(intro.data) : archInputFromCatalogCard(card);
  const vsTargets: VsTarget[] = (intro.data?.resources?.targets ?? []).length
    ? (intro.data?.resources?.targets ?? []).map((x) => ({ id: x.moduleId, name: x.displayName, from: x.from ?? null, to: x.to ?? null, optional: !!x.optional }))
    : (card.targets ?? []).map((x) => ({ id: x.module, name: glyphModule(x.module)?.awsService ?? x.module, from: x.from ?? null, to: x.to ?? null, optional: !!x.optional }));
  // “你将学到”的服务图标：目标模块；没有目标时（基础卡）用主服务
  const learnIds = [...new Set((vsTargets.length ? vsTargets.map((x) => x.id) : primaryServices(card)).map((id) => resolveModuleId(id) ?? id))];
  const topics: { title: string; domain: string | null }[] = intro.data?.saa?.topics?.length
    ? intro.data.saa.topics.map((x) => ({ title: x.title, domain: x.domain }))
    : (card.saa?.topicTitles ?? []).map((title) => ({ title, domain: null }));

  const statusLine = (
    <span className="small">
      {SS.page.status}
      {detail.data || labs.data ? <StateText meta={state} /> : <span className="faint">…</span>} · {attemptsN ? t(S.card.attempts, { n: attemptsN }) : S.card.noAttempts} · {SS.page.badge}
      {personalBadge && badgeStateOf(personalBadge) !== 'none' ? t(PC.badgeEarnedLine, { title: card.badge?.title ?? '', level: BADGE_LEVEL_TEXT[String(personalBadge.level)] ?? '' }) : S.card.badgeNone}
    </span>
  );

  return (
    <div className="stack-16" data-screen="P03" data-card={labId}>
      <nav className="crumbs-nav" aria-label={PC.crumbs}>
        <ol>
          <li>
            <Link to="/labs">{S.catalog.title}</Link>
          </li>
          <li>{crumbsCat}</li>
          <li className="mono">{labId}</li>
        </ol>
      </nav>
      <div className={`box stack-8 cardhead ${card.kind === 'service' ? catClass(card.category) : 'sc'}`}>
        <div className="row top head-top">
          {card.kind === 'service' ? <CardGlyph card={card} size={48} /> : <ServiceStrip card={card} tax={tax} />}
          <div className="stack-4 grow">
            <h1 tabIndex={-1}>
              {card.title}
              <UntranslatedIf show={untranslated(card, '/title') || untranslated(intro.data)} />
              {card.kind === 'scenario' && card.subtitle ? <span className="h1-sub">{card.subtitle}</span> : null}
            </h1>
            <span className="small muted">
              {kindLine(card, tax)}
              {card.legacyLabs?.length ? ` · ${t(S.card.legacy, { n: card.legacyLabs.join(PC.nameSep) })}` : ''}
            </span>
          </div>
          <span className="small faint nowrap head-ver">
            {t(SS.page.version, { v: card.version })}
            {card.status === 'beta' ? ` · ${SS.page.beta}` : ''}
            {flags.includes('new-version') ? ` · ${S.card.newVersion}` : ''}
          </span>
        </div>
        <div className="small head-metrics">
          <CardMetrics card={card} provision={false} />
          <span className="faint" title={t(SS.sections.timing, { limit: limitText(card.timeLimitMinutes), n: ext.maxCount, m: ext.minutesEach })}>
            {t(S.card.limit, { t: limitText(card.timeLimitMinutes) })}
          </span>
          <span title={PROVISION_HINT[card.provisionClass]}>
            <MetricIcon kind="provision" value={card.provisionClass} />
            <span className="sr">{t(SS.page.provision, { t: PROVISION_TEXT[card.provisionClass], c: card.provisionClass })}</span>
          </span>
          {planned ? <span className="tag planned">{S.card.planned}</span> : null}
          {flags
            .filter((f) => f !== 'beta' && f !== 'new-version')
            .map((f) => (
              <span key={f} className="tag">
                {FLAG_TEXT[f] ?? f}
              </span>
            ))}
        </div>
        {planned ? (
          <p className="note blue" role="note">
            <Shape name="clock" />
            <span>{SS.start.plannedNote}</span>
          </p>
        ) : card.status === 'deprecated' ? (
          <p className="note" role="note">
            <span>{SS.start.deprecatedNote}</span>
          </p>
        ) : null}
        <div className="row between">
          {statusLine}
          <div className="actions" data-start-area={model.kind}>
            <StartArea model={model} onStart={openStart} onRelease={() => setDialog({ kind: 'release' })} onRetry={detail.reload} />
            {L && !planned && card.status !== 'deprecated' ? (
              <Button onClick={() => setDialog({ kind: 'quote' })} data-quote-only="">
                {SS.page.quoteOnly}
              </Button>
            ) : null}
            {L && !planned ? (
              <Link className="btn ghost" to={`/labs/${labId}/quiz`}>
                {SS.page.quiz}
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      <div className="two-col">
        <div className="stack-24">
          {/* I6 d 首屏：开始时 → 完成后 的架构图（资源的完整句子折叠在下面） */}
          <section className="sec intro-hero" aria-labelledby="sec-arch" data-hero="">
            <h2 id="sec-arch">{SS.visual.archTitle}</h2>
            <ArchDiagram input={archInput} title={t(SS.visual.archAria, { id: labId })} />
            <More summary={SECTION_TEXT.resources}>
              <ResourcesBlock intro={intro.data} region={region} />
            </More>
          </section>
          <section className="sec" aria-labelledby="sec-obj" data-learn="">
            <h2 id="sec-obj">{SECTION_TEXT.objectives}</h2>
            {learnIds.length ? (
              <ul className="learn-grid">
                {learnIds.map((id) => (
                  <li key={id}>
                    <ServiceChip id={id} size={40} showFunction />
                  </li>
                ))}
              </ul>
            ) : null}
            {intro.data?.objectives?.length ? (
              <ul className="obj-list">
                {intro.data.objectives.map((o) => (
                  <li key={o.text}>
                    <DomainMark domain={o.domain} />
                    <span>{o.text}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          {card.kind === 'scenario' && (intro.data?.scenario || card.summary) ? (
            <section className="sec" aria-labelledby="sec-scenario">
              <h2 id="sec-scenario">{SECTION_TEXT.scenario}</h2>
              <p>{intro.data?.scenario?.question ?? card.summary}</p>
              {intro.data?.scenario?.constraints?.length ? (
                <div className="small">
                  <b>{SECTION_TEXT.constraints}</b>
                  <ul>
                    {intro.data.scenario.constraints.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {intro.data?.scenario?.antiPatterns?.length ? (
                <details className="disc">
                  <summary>{SECTION_TEXT.antiPatterns}</summary>
                  <ul className="small">
                    {intro.data.scenario.antiPatterns.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : null}
          {vsTargets.length || intro.data?.experiments?.length || expPreview ? (
            <section className="sec" aria-labelledby="sec-vs" data-compare="">
              <h2 id="sec-vs">{SS.visual.compareTitle}</h2>
              {vsTargets.length ? (
                <ul className="vs-list">
                  {vsTargets.map((x) => (
                    <li key={x.id}>
                      <ComparePair target={x} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {intro.data?.experiments?.length ? (
                <ul className="exp-list" aria-label={SECTION_TEXT.experiments}>
                  {intro.data.experiments.map((x) => (
                    <li key={`${x.module}/${x.id}`}>
                      <StepTypeIcon type="experiment" size={20} />
                      <span className="wrap-any">{x.title}</span>
                      {x.title !== `${x.module}/${x.id}` ? <span className="mono small faint">{`${x.module}/${x.id}`}</span> : null}
                      <span className={x.required ? 'tag accent' : 'tag'}>{x.required ? SS.sections.required : SS.sections.elective}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {expPreview ? (
                <More summary={SECTION_TEXT.experiments}>
                  <MarkdownView nodes={expPreview} />
                </More>
              ) : null}
            </section>
          ) : null}
          <section className="sec" aria-labelledby="sec-bg">
            <h2 id="sec-bg">{SECTION_TEXT.background}</h2>
            {intro.loading && !intro.data ? <Skeleton lines={2} /> : null}
            {intro.data?.story ? <p>{intro.data.story}</p> : <p>{card.summary}</p>}
            {background || whyTogether || platformNote ? (
              <More>
                {background ? <MarkdownView nodes={background} /> : null}
                {whyTogether ? (
                  <>
                    <h3>{PC.overviewHeading.why}</h3>
                    <MarkdownView nodes={whyTogether} />
                  </>
                ) : null}
                {platformNote ? (
                  <>
                    <h3>{PC.overviewHeading.platform}</h3>
                    <MarkdownView nodes={platformNote} />
                  </>
                ) : null}
              </More>
            ) : null}
          </section>
          <section className="sec" aria-labelledby="sec-steps" id="steps">
            <h2 id="sec-steps">{SECTION_TEXT.steps}</h2>
            <StepsList intro={intro.data} />
          </section>
          <section className="sec" aria-labelledby="sec-cost">
            <h2 id="sec-cost">{SECTION_TEXT.cost}</h2>
            <div className="row">
              <MetricIcon kind="cost" value={card.costTier.required} />
              {L && !planned ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'quote' })}>
                  {SS.page.quoteOnly}
                </Button>
              ) : null}
            </div>
            <More summary={SS.visual.costMore}>
              <p>
                {SS.sections.costLine}
                <b>
                  <CostTierMark tier={card.costTier.required} withOptional={card.costTier.withOptional} />
                </b>
                {card.mainDrivers?.length ? t(SS.sections.costSources, { list: card.mainDrivers.join(' · ') }) : SS.sections.costNone}
                {card.costTier.withOptional && card.costTier.withOptional !== card.costTier.required
                  ? t(SS.sections.costOptional, { tier: card.costTier.withOptional === 'high' ? PC.tierHigh : PC.tierMedium })
                  : ''}
              </p>
              <p className="small muted">{SS.sections.costKeep}</p>
              <p className="small muted">{SS.sections.costDisclaimer}</p>
            </More>
          </section>
          {topics.length ? (
            <section className="sec" aria-labelledby="sec-topics">
              <h2 id="sec-topics">{SECTION_TEXT.topics}</h2>
              <ul className="chips">
                {topics.map((x) => (
                  <li key={x.title} className="tag">
                    {x.domain ? <DomainMark domain={x.domain} /> : null}
                    {x.title}
                  </li>
                ))}
              </ul>
              {intro.data?.saa?.confusables?.length ? (
                <ul className="small">
                  {intro.data.saa.confusables.map((c) => (
                    <li key={`${c.a}-${c.b}`}>{t(SS.visual.confusable, { label: SECTION_TEXT.confusables, a: c.a, b: c.b, rule: c.rule })}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>

        <aside className="stack-16 sticky-aside" aria-label={SS.page.asideLabel}>
          <div className="box stack-8">
            <b>{SECTION_TEXT.prereq}</b>
            <div className="small">
              {SS.sections.prereqCards}
              {prereqCards.length
                ? prereqCards.map((p, i) => (
                    <span key={p.id}>
                      {i ? ' · ' : ''}
                      <Link to={`/labs/${p.id}`}>{p.id}</Link>{' '}
                      <StateText meta={isDoneStatus(progress.get(p.id)?.status) ? { text: S.state.completed, shape: 'check', tone: 'pass' } : { text: S.state.notStarted, shape: 'ring', tone: 'faint' }} hideText />
                    </span>
                  ))
                : SS.sections.prereqNone}
            </div>
            {intro.data?.prerequisites?.knowledge?.length ? (
              <div className="small muted">
                {SS.sections.knowledge}
                {intro.data.prerequisites.knowledge.join(PC.nameSep)}
              </div>
            ) : null}
            <div className="small">
              {SS.sections.inputs}
              {inputs.length ? inputs.map((i) => `${INPUT_TEXT[i.id]?.need ?? i.id}${i.required ? '' : PC.optionalMark}`).join(PC.listSep) : SS.sections.prereqNone}
            </div>
            <div className="small">
              {SS.sections.accountImpact}
              {impacts.length ? impacts.map((i) => t(SS.sections.impactItem, { resource: i.resource, revert: revertText(i.revert) })).join(PC.listSep) : SS.sections.prereqNone}
            </div>
            <div className="small">
              {SS.sections.platformOps}
              {ops.length ? ops.map((o) => t(SS.sections.opItem, { title: o.title }) + (o.optional ? SS.sections.optional : '')).join(PC.listSep) : SS.sections.prereqNone}
            </div>
          </div>
          <div className="box stack-8">
            <b>{SECTION_TEXT.timing}</b>
            <div className="small">
              {t(SS.sections.timing, { limit: limitText(card.timeLimitMinutes), n: ext.maxCount, m: ext.minutesEach })}
              {retain?.allowed === false ? SS.sections.timingNoKeep : t(SS.sections.timingKeep, { h: retain?.maxHours ?? (card.costTier.required === 'high' ? 12 : 24) })}
            </div>
            {learnerVariants.length ? (
              <div className="small muted">
                {t(SS.sections.variants, { n: learnerVariants.length + 1, list: [(card.variants ?? []).find((v) => v.id === 'default')?.title ?? PC.defaultVariant, ...learnerVariants.map((v) => v.title ?? v.id)].join(PC.nameSep) })}
              </div>
            ) : null}
            {preflightVariant ? <div className="small muted">{t(SS.sections.preflightVariant, { title: preflightVariant.title ?? preflightVariant.id })}</div> : null}
          </div>
          <div className="box stack-8">
            <b>{SECTION_TEXT.costShort}</b>
            <div className="small">
              {SS.sections.costTier}
              <CostTierMark tier={card.costTier.required} withOptional={card.costTier.withOptional} />
              {card.mainDrivers?.length ? t(SS.sections.costMain, { list: card.mainDrivers.join(PC.nameSep) }) : ''}
            </div>
          </div>
          <div className="box row nowrap-row">
            <CardBadge card={card} tax={tax} badge={personalBadge} size={40} />
            <div className="small">
              {t(SS.sections.badgeText, { title: card.badge?.title ?? badgeLabel(card, tax) })}
              {personalBadge && badgeStateOf(personalBadge) !== 'none' ? (
                <div className="muted">{t(SS.sections.badgeEarned, { level: BADGE_LEVEL_TEXT[String(personalBadge.level)] ?? '' })}</div>
              ) : null}
            </div>
          </div>
          <div className="box stack-8">
            <b>{SECTION_TEXT.tracks}</b>
            <div className="small">
              {tracks.length
                ? tracks.map((m, i) => (
                    <span key={m.track.id}>
                      {i ? ' · ' : ''}
                      <Link to={`/tracks/${m.track.id}`}>{m.track.title ?? m.track.id}</Link>
                      {t(PC.trackRole, { stage: m.stageTitle, role: m.role === 'required' ? PC.roleRequired : m.role === 'group' ? PC.roleGroup : PC.roleOptional })}
                    </span>
                  ))
                : '—'}
            </div>
            <b className="small">{SECTION_TEXT.reuse}</b>
            <div className="small muted">
              {(card.reuseFrom ?? []).length
                ? (card.reuseFrom ?? []).map((r, i) => (
                    <span key={r.labId}>
                      {i ? ' · ' : ''}
                      {t(SS.sections.reuseItem, { labId: r.labId })}
                      {r.warn ? t(SS.sections.reuseWarn, { mods: (r.extraModules ?? []).join(PC.nameSep) || PC.extraModules }) : ''}
                    </span>
                  ))
                : SS.sections.reuseNone}
              {(card.reuseFrom ?? []).length ? <div>{SS.sections.reuseNote}</div> : null}
            </div>
          </div>
          <div className="box stack-8">
            <b>{SECTION_TEXT.attempts}</b>
            {detail.data ? (
              detail.data.attempts.length ? (
                detail.data.attempts.map((a) => (
                  <div key={a.sessionId} className="attempt-row">
                    <span className="tnum">{formatDate(a.createdAt, clock.now())}</span>
                    <SessionStatePill state={a.state} size="sm" />
                    <Link to={`/sessions/${a.sessionId}`}>{SS.sections.attemptDetail}</Link>
                    {a.readyAt && (a.state === 'ENDED' || a.state === 'CLEANUP_FAILED') ? <Link to={`/sessions/${a.sessionId}/report`}>{SS.sections.attemptReport}</Link> : null}
                  </div>
                ))
              ) : (
                <span className="small faint">{SS.sections.attemptsNone}</span>
              )
            ) : detail.error ? (
              <span className="small muted">{S.catalog.statusUnavailable}</span>
            ) : (
              <Skeleton lines={1} />
            )}
          </div>
        </aside>
      </div>

      {L && !planned ? (
        <div className="sticky-cta" role="region" aria-label={SS.page.ctaRegion}>
          <StartArea model={model} compact onStart={openStart} onRelease={() => setDialog({ kind: 'release' })} onRetry={detail.reload} />
          <Link className="btn ghost" to={`/labs/${labId}/quiz`}>
            {SS.page.quiz}
          </Link>
        </div>
      ) : null}

      {dialog?.kind === 'start' && detail.data ? (
        <StartDialog
          open
          onClose={() => setDialog(null)}
          card={card}
          intro={intro.data}
          detail={detail.data}
          reuse={reuseInfo}
          initialEnv={dialog.env === 'reuse' || (reuseParam && reuseInfo?.compatible) ? 'reuse' : 'fresh'}
          initialVariant={sp.get('variant')}
          trackId={trackId}
          residual={residualForDialog}
          residualPolicy={residualPolicy}
          onRefresh={detail.reload}
        />
      ) : null}
      <ReleaseDialog
        open={dialog?.kind === 'release'}
        sid={model.kind === 'kept' ? model.sessionId : null}
        onClose={() => setDialog(null)}
        onDone={() => detail.reload()}
      />
      {dialog?.kind === 'quote' ? <QuoteOnlyDialog open card={card} intro={intro.data} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
