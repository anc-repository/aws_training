/**
 * P03 卡片简介页 `/labs/:labId`（08 §4 P03；05 §7）：卡片的封面，也是开始实验的唯一入口。
 * - 静态部分（index.json 中的该卡 + cards/<labId>.json）先渲染，个人部分（GET /labs/{labId}：状态、徽章、历次尝试、startability）
 *   到达后填充；个人部分失败时按钮区“暂时无法判断能否开始 · 重试”，开始按钮置灰；
 * - “开始实验”按钮由 startability（权威）+ 本地预判决定（startModel）；planned 卡片只显示、不能开始；A、O 没有开始与小测；
 * - 查询串：`start=1`（只对 L，打开开始对话框后立即从地址栏移除）、`variant=<id>`、`reuse=<envId>`；
 * - 生成区块按 05 §7.3 的固定句式渲染；作者撰写的概览（mdast）按二级标题放进对应区块；
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
import '../labs/catalog.css';
import { badgeLabel, CardBadge, kindLine, ServiceStrip } from '../labs/components/CardTile';
import { badgeStateOf, DifficultyBar, ServiceAbbr, StateText } from '../labs/components/Marks';
import { progressMap, useCardIntro, useCatalog, useHolder, useLabs, useResource } from '../labs/data';
import { cardFlags, cardStateOf, catClass, estimateText, isDoneStatus, limitText, membershipOf, serviceOf } from '../labs/model';
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
      <p>{t(SS.sections.resourcesIntro, { region })}：</p>
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
            .join('、')}
          。{SS.sections.targetTail}
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

function StepsTable({ intro }: { intro: CardIntro | null }) {
  const steps = intro?.steps ?? [];
  if (!steps.length) return <p className="small muted">{SS.sections.noSteps}</p>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col" className="num">
              {SS.sections.stepNo}
            </th>
            <th scope="col">{SS.sections.stepTitle}</th>
            <th scope="col">{SS.sections.stepType}</th>
            <th scope="col">{SS.sections.stepMarks}</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => {
            const marks = [
              s.optional ? SS.sections.markOptional : null,
              s.wait ? t(SS.sections.markWait, { n: s.wait.typicalMinutes }) : null,
              s.startsBilling ? (s.startsBilling.class === 'hourly' ? SS.sections.markHourly : SS.sections.markUsage) : null,
              s.expectedOutage ? SS.sections.markOutage : null,
            ].filter(Boolean);
            return (
              <tr key={s.id}>
                <td className="num">{i + 1}</td>
                <td>{s.title}</td>
                <td>{STEP_TYPE_TEXT[s.type] ?? s.type}</td>
                <td className="small">{marks.length ? marks.join(' · ') : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
  const primary = card.services.find((s) => s.role === 'primary')?.id;
  const abbr = primary ? serviceOf(tax, primary)?.abbr : null;
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

  const statusLine = (
    <span className="small">
      {SS.page.status}
      {detail.data || labs.data ? <StateText meta={state} /> : <span className="faint">…</span>} · {attemptsN ? t(S.card.attempts, { n: attemptsN }) : S.card.noAttempts} · {SS.page.badge}
      {personalBadge && badgeStateOf(personalBadge) !== 'none' ? `“${card.badge?.title ?? ''}” ${BADGE_LEVEL_TEXT[String(personalBadge.level)] ?? ''}` : S.card.badgeNone}
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
          {card.kind === 'service' && abbr ? <ServiceAbbr abbr={abbr} category={card.category} title={card.service} /> : <ServiceStrip card={card} tax={tax} />}
          <div className="stack-4 grow">
            <h1 tabIndex={-1}>
              {card.title}
              <UntranslatedIf show={untranslated(card, '/title') || untranslated(intro.data)} />
              {card.kind === 'scenario' && card.subtitle ? <span className="h1-sub">{card.subtitle}</span> : null}
            </h1>
            <span className="small muted">
              {kindLine(card, tax)}
              {card.legacyLabs?.length ? ` · ${t(S.card.legacy, { n: card.legacyLabs.join('、') })}` : ''}
            </span>
          </div>
          <span className="small faint nowrap head-ver">
            {t(SS.page.version, { v: card.version })}
            {card.status === 'beta' ? ` · ${SS.page.beta}` : ''}
            {flags.includes('new-version') ? ` · ${S.card.newVersion}` : ''}
          </span>
        </div>
        <div className="small">
          <DifficultyBar value={card.difficulty} /> · {t(SS.page.meta, { est: estimateText(card.estimatedMinutes), limit: limitText(card.timeLimitMinutes), n: ext.maxCount, m: ext.minutesEach })} ·{' '}
          <CostTierMark tier={card.costTier.required} withOptional={card.costTier.withOptional} sources={(card.mainDrivers ?? []).join('、') || undefined} /> ·{' '}
          <span title={PROVISION_HINT[card.provisionClass]}>{t(SS.page.provision, { t: PROVISION_TEXT[card.provisionClass], c: card.provisionClass })}</span>{' '}
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
          <section className="sec" aria-labelledby="sec-bg">
            <h2 id="sec-bg">{SECTION_TEXT.background}</h2>
            {intro.loading && !intro.data ? <Skeleton lines={3} /> : null}
            {intro.data?.story ? <p>{intro.data.story}</p> : !background ? <p>{card.summary}</p> : null}
            {background ? <MarkdownView nodes={background} /> : null}
          </section>
          {whyTogether ? (
            <section className="sec" aria-labelledby="sec-why">
              <h2 id="sec-why">{PC.overviewHeading.why}</h2>
              <MarkdownView nodes={whyTogether} />
            </section>
          ) : null}
          {intro.data?.objectives?.length ? (
            <section className="sec" aria-labelledby="sec-obj">
              <h2 id="sec-obj">{SECTION_TEXT.objectives}</h2>
              <ul className="obj-list">
                {intro.data.objectives.map((o) => (
                  <li key={o.text}>
                    {o.text} <span className="tag">{DOMAIN_TEXT[o.domain] ?? o.domain}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="sec" aria-labelledby="sec-res">
            <h2 id="sec-res">{SECTION_TEXT.resources}</h2>
            <ResourcesBlock intro={intro.data} region={region} />
          </section>
          <section className="sec" aria-labelledby="sec-cost">
            <h2 id="sec-cost">{SECTION_TEXT.cost}</h2>
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
            <div className="row">
              {L && !planned ? (
                <Button size="sm" onClick={() => setDialog({ kind: 'quote' })}>
                  {SS.page.quoteOnly}
                </Button>
              ) : null}
              <span className="small muted">{SS.sections.costDisclaimer}</span>
            </div>
          </section>
          <section className="sec" aria-labelledby="sec-steps" id="steps">
            <h2 id="sec-steps">{SECTION_TEXT.steps}</h2>
            <StepsTable intro={intro.data} />
          </section>
          {expPreview || intro.data?.experiments?.length ? (
            <section className="sec" aria-labelledby="sec-exp">
              <h2 id="sec-exp">{SECTION_TEXT.experiments}</h2>
              {expPreview ? (
                <MarkdownView nodes={expPreview} />
              ) : (
                <ul>
                  {(intro.data?.experiments ?? []).map((x) => (
                    <li key={`${x.module}/${x.id}`}>
                      {t(SS.sections.experimentsGenerated, { title: x.title, module: x.module, id: x.id, req: x.required ? SS.sections.required : SS.sections.elective })}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {platformNote ? (
            <section className="sec" aria-labelledby="sec-pm">
              <h2 id="sec-pm">{PC.overviewHeading.platform}</h2>
              <MarkdownView nodes={platformNote} />
            </section>
          ) : null}
          {intro.data?.saa?.topics?.length || card.saa?.topicTitles?.length ? (
            <section className="sec" aria-labelledby="sec-topics">
              <h2 id="sec-topics">{SECTION_TEXT.topics}</h2>
              <p className="small">
                {(intro.data?.saa?.topics?.map((x) => x.title) ?? card.saa?.topicTitles ?? []).join(' · ')}
              </p>
              {intro.data?.saa?.confusables?.length ? (
                <ul className="small">
                  {intro.data.saa.confusables.map((c) => (
                    <li key={`${c.a}-${c.b}`}>
                      {SECTION_TEXT.confusables}：{c.a} / {c.b}：{c.rule}
                    </li>
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
                {intro.data.prerequisites.knowledge.join('、')}
              </div>
            ) : null}
            <div className="small">
              {SS.sections.inputs}
              {inputs.length ? inputs.map((i) => `${INPUT_TEXT[i.id]?.need ?? i.id}${i.required ? '' : PC.optionalMark}`).join(PC.listSep) : SS.sections.prereqNone}
            </div>
            <div className="small">
              {SS.sections.accountImpact}
              {impacts.length ? impacts.map((i) => t(SS.sections.impactItem, { resource: i.resource, revert: revertText(i.revert) })).join('；') : SS.sections.prereqNone}
            </div>
            <div className="small">
              {SS.sections.platformOps}
              {ops.length ? ops.map((o) => t(SS.sections.opItem, { title: o.title }) + (o.optional ? SS.sections.optional : '')).join('；') : SS.sections.prereqNone}
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
              {card.mainDrivers?.length ? t(SS.sections.costMain, { list: card.mainDrivers.join('、') }) : ''}
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
