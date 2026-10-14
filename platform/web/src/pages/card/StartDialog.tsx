/**
 * P03-D 开始实验对话框 StartDialog（08 §4 P03-D、§5.2；02 §3.1、§10.1）：选项 → 费用 → 时间 → 确认。
 * - 打开即请求报价（POST /labs/{labId}/quotes），选项（环境、起始方式）变化时重新报价、旧报价作废并清除勾选；
 *   首次以“计算中”形态渲染，初始焦点在对话框标题；焦点不离开对话框；
 * - 报价有效期本地计时（服务端时钟），≤ 2 分钟变琥珀，过期后主按钮变为“重新计算费用”；
 * - 勾选全部必需项后提交 POST /sessions（同一次操作的重试复用同一个 Idempotency-Key）；202 后立即进入 /workspace/:sid；
 * - 错误按 08 P03-D 的表处理（报价过期重算、冲突关闭费用段落并给出去处、残留确认展开、字段级错误回填、网络错误可重试）。
 * 不使用 alert / confirm；学员输入的草稿存 sessionStorage（登录过期返回后恢复，08 §8.6）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ApiError } from '../../api/errors';
import { isApiError } from '../../api/errors';
import type { SessionView } from '../../api/types';
import { useServices } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { msg, t } from '../../i18n';
import { formatCountdown } from '../../lib/format';
import { redact } from '../../lib/redact';
import { ssGet, ssSet } from '../../lib/storage';
import { BILLING_TEXT, Button, Dialog, ErrorPanel, Field, Shape, Skeleton, useSecondTick } from '../../ui';
import { INPUT_TEXT, PROVISION_TEXT } from '../labs/strings';
import type { CardIntro, CatalogCard, CostQuote, LabDetail } from '../labs/types';
import { QuotePanel } from './QuotePanel';
import { primaryEstimate, quoteHasUnknown, validateInput, type ResidualPolicy } from './startModel';
import { SS } from './strings';

export interface StartDialogProps {
  open: boolean;
  onClose: () => void;
  card: CatalogCard;
  intro: CardIntro | null;
  detail: LabDetail;
  /** 有保留中的环境且与本卡兼容时可以选“复用”。 */
  reuse: { envId: string; fromLabId: string | null; compatible: boolean } | null;
  initialEnv: 'fresh' | 'reuse';
  initialVariant?: string | null;
  trackId?: string | null;
  residual: 'ack' | 'info' | null;
  residualPolicy: ResidualPolicy;
  onRefresh: () => void;
}

type QuoteState = { status: 'loading' } | { status: 'ok'; quote: CostQuote } | { status: 'error'; error: ApiError };

const INPUTS_KEY = (labId: string) => `atl.start-inputs.v1.${labId}`;

function problemErrors(e: ApiError): { path: string; message: string }[] {
  const errs = (e.problem as { errors?: unknown } | null)?.errors;
  return Array.isArray(errs) ? (errs as { path?: unknown; message?: unknown }[]).map((x) => ({ path: String(x.path ?? ''), message: String(x.message ?? '') })) : [];
}

function problemReason(e: ApiError): string | null {
  const r = (e.problem as { reason?: unknown } | null)?.reason;
  return typeof r === 'string' ? r : null;
}

export function StartDialog(p: StartDialogProps) {
  const { api, clock, sync } = useServices();
  const status = useGlobalStatus();
  const navigate = useNavigate();
  const { card, intro, detail } = p;
  const labId = card.id;
  const [env, setEnv] = useState<'fresh' | 'reuse'>(p.reuse?.compatible ? p.initialEnv : 'fresh');
  const learnerVariants = (card.variants ?? []).filter((v) => v.select === 'learner');
  const preflightVariants = (card.variants ?? []).filter((v) => v.select === 'preflight');
  const [variant, setVariant] = useState<string>(() => {
    const v = p.initialVariant;
    return v && learnerVariants.some((x) => x.id === v) ? v : 'default';
  });
  const ws = intro?.workstation ?? card.workstation ?? {};
  const savingsAllowed = (ws.savingsMode ?? 'ok') !== 'unsupported' && ws.required !== true;
  const [workstation, setWorkstation] = useState<'ec2' | 'cloudshell'>('ec2');
  const inputDefs = useMemo(() => {
    const fromIntro = intro?.prerequisites?.learnerInputs ?? [];
    const fromCard = card.learnerInputs ?? [];
    const ids = [...new Set([...fromCard.map((i) => i.id), ...fromIntro.map((i) => i.id)])];
    return ids.map((id) => ({ id, required: fromCard.find((x) => x.id === id)?.required ?? fromIntro.find((x) => x.id === id)?.required !== false }));
  }, [intro, card]);
  const [inputs, setInputs] = useState<Record<string, string>>(() => ssGet<Record<string, string>>(INPUTS_KEY(labId), {}));
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [quote, setQuote] = useState<QuoteState>({ status: 'loading' });
  const [acks, setAcks] = useState({ cost: false, unknown: false, budget: false, residual: false });
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<ApiError | null>(null);
  const [forceResidual, setForceResidual] = useState(false);
  const [submit, setSubmit] = useState<{ busy: boolean; error: ApiError | null; retryable: boolean; ackError: boolean }>({ busy: false, error: null, retryable: false, ackError: false });
  const opRef = useRef<ReturnType<typeof api.operation> | null>(null);
  const quoteSeq = useRef(0);
  useSecondTick(p.open);

  // 报价只依赖原始值（环境、起始方式、复用的环境 id），父组件重绘不会触发重新报价
  const reuseEnvId = env === 'reuse' && p.reuse ? p.reuse.envId : undefined;
  const requote = useCallback(() => {
    const my = ++quoteSeq.current;
    setQuote({ status: 'loading' });
    setAcks((a) => ({ ...a, cost: false, unknown: false, budget: false, residual: false }));
    opRef.current = null;
    const reuseEnv = reuseEnvId;
    const body: Record<string, unknown> = { purpose: reuseEnv ? 'REUSE' : 'START', ...(variant !== 'default' ? { variant } : {}), ...(reuseEnv ? { reuseEnvironmentId: reuseEnv } : {}) };
    api
      .call<CostQuote>('createLabQuote', { params: { labId }, body })
      .then((r) => {
        if (my === quoteSeq.current && r.data) setQuote({ status: 'ok', quote: r.data });
      })
      .catch((e: unknown) => {
        if (my === quoteSeq.current && isApiError(e)) setQuote({ status: 'error', error: e });
      });
  }, [api, labId, variant, reuseEnvId]);

  useEffect(() => {
    if (p.open) requote();
  }, [p.open, requote]);

  useEffect(() => {
    ssSet(INPUTS_KEY(labId), inputs);
  }, [labId, inputs]);

  const nowMs = clock.now();
  const q = quote.status === 'ok' ? quote.quote : null;
  const expiresAt = q ? Date.parse(q.expiresAt) : null;
  const remaining = expiresAt !== null ? expiresAt - nowMs : null;
  const expired = remaining !== null && remaining <= 0;
  const needUnknown = !!q && quoteHasUnknown(q);
  const budgetWarn = status.guardrails?.budget?.state === 'WARN';
  const manualItems = (status.manual?.items ?? []).filter((m) => m.cleanupState !== 'RESOLVED_BY_LEARNER' && m.cleanupState !== 'DELETED');
  const residualReason = detail.startability.reasons.find((r) => r.code === 'RESIDUAL_ACK_REQUIRED');
  const residualList = residualReason?.residues?.length
    ? residualReason.residues.map((r) => ({ key: r.resourceKey ?? r.name ?? '', type: r.type ?? '', name: r.name ?? '', billing: 'hourly' }))
    : manualItems.map((m) => ({ key: m.resourceKey, type: m.resourceType, name: m.name ?? m.arn ?? '', billing: m.billing ?? '' }));
  const residualMode: 'ack' | 'info' | null = forceResidual ? 'ack' : p.residual;
  const fieldError = (id: string, required: boolean) => serverFieldErrors[id] ?? (touched[id] || submit.ackError ? validateInput(id, inputs[id] ?? '', required) : null);
  const inputsValid = inputDefs.every((d) => validateInput(d.id, inputs[d.id] ?? '', d.required) === null);
  const acksOk = acks.cost && (!needUnknown || acks.unknown) && (!budgetWarn || acks.budget) && (residualMode !== 'ack' || acks.residual);
  const can = !!q && !expired && !submit.busy && !blocked && acksOk && inputsValid;
  const estimate = primaryEstimate(q);
  const limitMin = card.timeLimitMinutes;
  const ext = intro?.timing?.extensions ?? { maxCount: 2, minutesEach: 30 };
  const readyIdle = (status.platform.data?.limits as { readyIdleMinutes?: number } | null | undefined)?.readyIdleMinutes;
  const impacts = intro?.accountImpact ?? card.accountImpact ?? [];
  const inspector = impacts.some((i) => /inspector/i.test(i.id)) || /vuln|inspector/.test(labId);

  const doSubmit = async () => {
    if (!q) return;
    if (!acksOk || !inputsValid) {
      setSubmit((s) => ({ ...s, ackError: true }));
      setTouched(Object.fromEntries(inputDefs.map((d) => [d.id, true])));
      return;
    }
    if (!opRef.current) opRef.current = api.operation('createSession');
    const reuseEnv = env === 'reuse' && p.reuse ? p.reuse.envId : undefined;
    const learnerInputs = Object.fromEntries(inputDefs.filter((d) => (inputs[d.id] ?? '').trim()).map((d) => [d.id, (inputs[d.id] ?? '').trim()]));
    const body: Record<string, unknown> = {
      labId,
      quoteId: q.quoteId,
      costAcknowledged: true,
      ...(variant !== 'default' ? { variant } : {}),
      ...(p.trackId ? { trackId: p.trackId } : {}),
      ...(reuseEnv ? { reuseEnvironmentId: reuseEnv } : {}),
      ...(residualMode === 'ack' ? { residualAck: true } : {}),
      ...(Object.keys(learnerInputs).length ? { learnerInputs } : {}),
      workstation,
    };
    setSubmit({ busy: true, error: null, retryable: false, ackError: false });
    setServerFieldErrors({});
    try {
      const r = await opRef.current.run<SessionView>({ body });
      const view = r.data;
      ssSet(INPUTS_KEY(labId), undefined);
      if (view) sync.applyView(view);
      void sync.refreshCurrent();
      p.onClose();
      navigate(`/workspace/${view?.sessionId ?? ''}`);
    } catch (e) {
      if (!isApiError(e)) {
        setSubmit({ busy: false, error: null, retryable: true, ackError: false });
        return;
      }
      const code = String(e.code);
      if (e.isTransient) {
        setSubmit({ busy: false, error: e, retryable: true, ackError: false });
        return;
      }
      opRef.current = null;
      if (code === 'QUOTE_EXPIRED' || code === 'QUOTE_MISMATCH') {
        setSubmit({ busy: false, error: null, retryable: false, ackError: false });
        setNotice(SS.dialog.quoteUpdated);
        requote();
        return;
      }
      if (code === 'VARIANT_UNKNOWN') {
        setSubmit({ busy: false, error: null, retryable: false, ackError: false });
        setNotice(SS.dialog.variantGone);
        setVariant('default');
        p.onRefresh();
        return;
      }
      if (code === 'COST_ACK_REQUIRED') {
        setSubmit({ busy: false, error: null, retryable: false, ackError: true });
        return;
      }
      if (code === 'RESIDUAL_ACK_REQUIRED') {
        setForceResidual(true);
        setSubmit({ busy: false, error: null, retryable: false, ackError: true });
        return;
      }
      if (code === 'VALIDATION_FAILED') {
        const errs = problemErrors(e);
        const fields: Record<string, string> = {};
        for (const x of errs) if (x.path.startsWith('learnerInputs.')) fields[x.path.slice('learnerInputs.'.length)] = x.message || SS.inputs.required;
        setServerFieldErrors(fields);
        if (!Object.keys(fields).length) setBlocked(e);
        setSubmit({ busy: false, error: null, retryable: false, ackError: false });
        return;
      }
      // 409 冲突（已有会话、保留中的环境、回收中、目标已生效）、维护 / 预算 / 卸载：关闭费用段落，说明原因并给出去处
      setBlocked(e);
      setSubmit({ busy: false, error: null, retryable: false, ackError: false });
      p.onRefresh();
    }
  };

  const title = t(SS.dialog.title, { id: labId, title: card.title });
  const blockedCode = blocked ? (problemReason(blocked) ?? String(blocked.code)) : null;
  const blockedSid = blocked ? ((blocked.problem as { sessionId?: unknown } | null)?.sessionId as string | undefined) : undefined;
  const footer = blocked ? (
    <Button onClick={p.onClose}>{SS.dialog.cancel}</Button>
  ) : (
    <>
      <Button onClick={p.onClose} disabled={submit.busy}>
        {SS.dialog.cancel}
      </Button>
      {expired ? (
        <Button
          variant="primary"
          onClick={() => {
            setNotice(SS.dialog.quoteUpdated);
            requote();
          }}
        >
          {SS.dialog.requote}
        </Button>
      ) : (
        <Button
          variant="primary"
          busy={submit.busy}
          busyText={SS.dialog.submitting}
          aria-disabled={!can || undefined}
          onClick={() => {
            if (!can) {
              if (q && !expired) setSubmit((s) => ({ ...s, ackError: true }));
              return;
            }
            void doSubmit();
          }}
          data-start-submit=""
        >
          {quote.status === 'loading' ? SS.dialog.quoting : estimate ? t(SS.dialog.submitEst, { est: estimate }) : SS.dialog.submit}
        </Button>
      )}
    </>
  );

  return (
    <Dialog open={p.open} onClose={submit.busy ? () => undefined : p.onClose} title={title} size="wide" initialFocus="[data-overlay-title]" dismissible={!submit.busy} footer={footer}>
      {notice ? (
        <div className="note amber" role="status">
          <Shape name="tri" />
          <span>{notice}</span>
        </div>
      ) : null}
      {blocked ? (
        <div className="stack-8" data-start-blocked={blockedCode ?? ''}>
          <h3>{SS.dialog.blockedTitle}</h3>
          <ErrorPanel error={blocked} />
          <div className="row">
            {blockedCode === 'SESSION_ACTIVE_EXISTS' && blockedSid ? (
              <Link className="btn" to={`/workspace/${blockedSid}`} onClick={p.onClose}>
                {SS.start.toWorkspace}
              </Link>
            ) : null}
            {blockedCode === 'CLEANUP_IN_PROGRESS' && blockedSid ? (
              <Link className="btn" to={`/sessions/${blockedSid}/end`} onClick={p.onClose}>
                {SS.start.viewProgress}
              </Link>
            ) : null}
            {blockedCode === 'MAINTENANCE_MODE' || blockedCode === 'BUDGET_BLOCKED' ? (
              <Link className="btn" to="/settings/guardrails" onClick={p.onClose}>
                {SS.start.viewGuardrails}
              </Link>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <section className="dsec" aria-labelledby="sd-opt">
            <h3 id="sd-opt">
              <span className="n">1</span>
              {SS.dialog.options}
            </h3>
            {p.reuse ? (
              <div className="radio-row" role="radiogroup" aria-label={SS.dialog.env}>
                <span className="flabel">{SS.dialog.env}</span>
                <label>
                  <input type="radio" name="sd-env" value="fresh" checked={env === 'fresh'} onChange={() => setEnv('fresh')} />
                  {SS.dialog.envFresh}
                </label>
                {p.reuse.compatible ? (
                  <label>
                    <input type="radio" name="sd-env" value="reuse" checked={env === 'reuse'} onChange={() => setEnv('reuse')} />
                    {t(SS.dialog.envReuse, { labId: p.reuse.fromLabId ?? '—' })}
                  </label>
                ) : null}
              </div>
            ) : null}
            {env === 'reuse' && q?.reusePlan ? (
              <div className="note amber reuse-plan" data-reuse-plan="">
                <Shape name="tri" />
                <span>
                  {q.reusePlan.compatible ? (
                    <>
                      {SS.dialog.reusePlan}
                      {[
                        q.reusePlan.enable.length ? t(SS.dialog.reuseEnable, { list: q.reusePlan.enable.join('、') }) : null,
                        q.reusePlan.change.length
                          ? t(SS.dialog.reuseChange, {
                              list: q.reusePlan.change
                                .map((c) =>
                                  t(SS.dialog.reuseChangeItem, {
                                    module: c.module,
                                    replace: c.replacesInstance ? SS.dialog.reuseReplace : SS.dialog.reuseNoReplace,
                                    downtime: c.downtime ? SS.dialog.reuseDowntime : SS.dialog.reuseNoDowntime,
                                  }),
                                )
                                .join('、'),
                            })
                          : null,
                        q.reusePlan.extraModules.length ? t(SS.dialog.reuseExtra, { list: q.reusePlan.extraModules.join('、') }) : null,
                        t(SS.dialog.reuseManual, { n: q.reusePlan.manualResources }),
                      ]
                        .filter(Boolean)
                        .join('；')}
                      。
                      <br />
                      {SS.dialog.reuseFailure}
                    </>
                  ) : (
                    t(SS.dialog.reuseIncompatible, { reason: q.reusePlan.reason === 'TARGET_ALREADY_SATISFIED' ? SS.start.targetSatisfied : (q.reusePlan.reason ?? '—') })
                  )}
                </span>
              </div>
            ) : null}
            {savingsAllowed ? (
              <div className="radio-row" role="radiogroup" aria-label={SS.dialog.workstation}>
                <span className="flabel">{SS.dialog.workstation}</span>
                <label>
                  <input type="radio" name="sd-ws" value="ec2" checked={workstation === 'ec2'} onChange={() => setWorkstation('ec2')} />
                  {SS.dialog.wsEc2}
                </label>
                <label>
                  <input type="radio" name="sd-ws" value="cloudshell" checked={workstation === 'cloudshell'} onChange={() => setWorkstation('cloudshell')} />
                  {SS.dialog.wsCloudshell}
                </label>
              </div>
            ) : (
              <p className="small">
                <span className="flabel">{SS.dialog.workstation}</span> {SS.dialog.wsRequired}
              </p>
            )}
            {workstation === 'cloudshell' ? (
              <div className="note">
                <span>
                  {SS.dialog.wsLimits}
                  {ws.savingsMode === 'degraded' ? ` ${SS.dialog.wsDegraded}` : ''}
                </span>
              </div>
            ) : null}
            {learnerVariants.length ? (
              <div className="radio-row" role="radiogroup" aria-label={SS.dialog.variant}>
                <span className="flabel">{SS.dialog.variant}</span>
                {[{ id: 'default', title: (card.variants ?? []).find((v) => v.id === 'default')?.title ?? msg.pages.card.defaultVariant }, ...learnerVariants].map((v) => (
                  <label key={v.id}>
                    <input type="radio" name="sd-variant" value={v.id} checked={variant === v.id} onChange={() => setVariant(v.id)} />
                    {v.title ?? v.id}
                  </label>
                ))}
              </div>
            ) : null}
            {preflightVariants.length ? <p className="small muted">{t(SS.sections.preflightVariant, { title: preflightVariants[0]!.title ?? preflightVariants[0]!.id })}</p> : null}
            <div className="small">
              <span className="flabel">{SS.dialog.inputs}</span> {inputDefs.length ? null : SS.dialog.inputsNone}
            </div>
            {inputDefs.length ? (
              <div className="inputs">
                {inputDefs.map((d) => {
                  const meta = INPUT_TEXT[d.id] ?? { label: d.id, need: d.id };
                  const err = fieldError(d.id, d.required);
                  if (d.id === 'cost-tags-active') {
                    return (
                      <div key={d.id} className="field">
                        <label className="chk small">
                          <input
                            type="checkbox"
                            checked={inputs[d.id] === 'true'}
                            aria-invalid={err ? true : undefined}
                            onChange={(e) => {
                              setInputs((x) => ({ ...x, [d.id]: e.target.checked ? 'true' : '' }));
                              setTouched((x) => ({ ...x, [d.id]: true }));
                            }}
                          />
                          <span>
                            {meta.label}：{meta.hint}
                          </span>
                        </label>
                        {err ? <span className="ferr">{err}</span> : null}
                      </div>
                    );
                  }
                  return (
                    <Field key={d.id} label={`${meta.label}${d.required ? '' : msg.pages.card.optionalMark}`} hint={meta.hint} error={err}>
                      <input
                        className="input"
                        value={inputs[d.id] ?? ''}
                        autoComplete="off"
                        spellCheck={false}
                        type={d.id.endsWith('email') ? 'email' : 'text'}
                        onChange={(e) => {
                          const v = e.target.value;
                          setInputs((x) => ({ ...x, [d.id]: v }));
                          setServerFieldErrors((x) => {
                            const { [d.id]: _drop, ...rest } = x;
                            return rest;
                          });
                        }}
                        onBlur={() => setTouched((x) => ({ ...x, [d.id]: true }))}
                      />
                    </Field>
                  );
                })}
              </div>
            ) : null}
          </section>

          <section className="dsec" aria-labelledby="sd-cost">
            <h3 id="sd-cost" className="quote-head">
              <span className="n">2</span>
              {SS.dialog.cost}
              <span className="small muted quote-exp">{t(SS.dialog.costSub, { date: q?.priceAsOf ? q.priceAsOf.slice(0, 10) : '—' })}</span>
              <span className="spacer" />
              {q ? (
                expired ? (
                  <span className="small st drift quote-exp">{SS.dialog.expired}</span>
                ) : (
                  <span className={remaining !== null && remaining <= 120_000 ? 'small st drift quote-exp' : 'small muted quote-exp'} data-quote-exp="">
                    {t(SS.dialog.expiresIn, { t: formatCountdown(remaining ?? 0) })}
                  </span>
                )
              ) : null}
            </h3>
            {quote.status === 'loading' ? (
              <div className="stack-8">
                <div className="row small" role="status">
                  <Shape name="spin" spin />
                  {SS.dialog.quoting}
                </div>
                <Skeleton lines={4} />
              </div>
            ) : quote.status === 'error' ? (
              <ErrorPanel error={quote.error} onRetry={requote} title={SS.dialog.quoteFailed} />
            ) : (
              <QuotePanel
                quote={quote.quote}
                options={{ workstation, reuse: env === 'reuse', limitMinutes: limitMin, extensions: { count: ext.maxCount, minutes: ext.minutesEach } }}
              />
            )}
            {q && needUnknown ? (
              <>
                <div className="note">
                  <span>{SS.dialog.unknownPrice}</span>
                </div>
                <label className="chk small">
                  <input type="checkbox" checked={acks.unknown} onChange={(e) => setAcks((a) => ({ ...a, unknown: e.target.checked }))} aria-invalid={submit.ackError && !acks.unknown ? true : undefined} />
                  <span>{SS.dialog.ackUnknown}</span>
                </label>
              </>
            ) : null}
            {inspector ? (
              <div className="note amber">
                <Shape name="tri" />
                <span>{SS.dialog.inspector}</span>
              </div>
            ) : impacts.length ? (
              <div className="note amber">
                <Shape name="tri" />
                <span>{t(SS.dialog.accountImpact, { list: impacts.map((i) => i.resource).join('、') })}</span>
              </div>
            ) : null}
            {budgetWarn ? (
              <>
                <div className="note amber">
                  <Shape name="tri" />
                  <span>{SS.dialog.budgetWarn}</span>
                </div>
                <label className="chk small">
                  <input type="checkbox" checked={acks.budget} onChange={(e) => setAcks((a) => ({ ...a, budget: e.target.checked }))} aria-invalid={submit.ackError && !acks.budget ? true : undefined} />
                  <span>{SS.dialog.ackBudget}</span>
                </label>
              </>
            ) : null}
            {residualMode && residualList.length ? (
              <>
                <div className={residualMode === 'ack' ? 'note red' : 'note amber'} data-residual={residualMode}>
                  <Shape name="tri" />
                  <span>
                    {residualMode === 'ack' ? SS.dialog.residualTitle : SS.dialog.residualInfo}
                    {residualList.map((r) => (
                      <span key={r.key || r.name} className="wrap-any">
                        <br />·{' '}
                        {t(SS.dialog.residualItem, {
                          type: r.type,
                          name: redact(r.name),
                          billing: (BILLING_TEXT as Record<string, string>)[r.billing] ?? r.billing,
                        })}
                      </span>
                    ))}
                    <br />
                    <Link to="/resources/manual">{SS.dialog.viewList}</Link>
                  </span>
                </div>
                {residualMode === 'ack' ? (
                  <label className="chk small">
                    <input type="checkbox" checked={acks.residual} onChange={(e) => setAcks((a) => ({ ...a, residual: e.target.checked }))} aria-invalid={submit.ackError && !acks.residual ? true : undefined} />
                    <span>{SS.dialog.ackResidual}</span>
                  </label>
                ) : null}
              </>
            ) : residualMode === 'ack' ? (
              <label className="chk small">
                <input type="checkbox" checked={acks.residual} onChange={(e) => setAcks((a) => ({ ...a, residual: e.target.checked }))} />
                <span>{SS.dialog.ackResidual}</span>
              </label>
            ) : null}
          </section>

          <section className="dsec" aria-labelledby="sd-time">
            <h3 id="sd-time">
              <span className="n">3</span>
              {SS.dialog.time}
            </h3>
            <p className="small">
              {t(SS.dialog.timeText, { limit: t(msg.pages.card.hours, { n: (limitMin / 60).toFixed(1).replace(/\.0$/, '') }), n: ext.maxCount, m: ext.minutesEach })}
              {typeof readyIdle === 'number' ? t(SS.dialog.timeIdle, { idle: readyIdle }) : ''}。
              <br />
              {t(SS.dialog.timeProvision, { t: PROVISION_TEXT[card.provisionClass] ?? card.provisionClass, c: card.provisionClass })}
            </p>
          </section>

          <section className="dsec" aria-labelledby="sd-ack">
            <h3 id="sd-ack">
              <span className="n">4</span>
              {SS.dialog.confirm}
            </h3>
            <label className="chk">
              <input type="checkbox" checked={acks.cost} onChange={(e) => setAcks((a) => ({ ...a, cost: e.target.checked }))} aria-invalid={submit.ackError && !acks.cost ? true : undefined} data-ack="cost" />
              <span>{SS.dialog.ack}</span>
            </label>
            {submit.ackError && !acksOk ? (
              <p className="ferr" role="alert">
                {SS.dialog.ackRequired}
              </p>
            ) : null}
            {submit.retryable ? (
              <div className="note red" role="alert">
                <Shape name="xbox" />
                <span className="grow">{SS.dialog.notDelivered}</span>
                <Button size="sm" onClick={() => void doSubmit()}>
                  {SS.dialog.retry}
                </Button>
              </div>
            ) : null}
          </section>
        </>
      )}
    </Dialog>
  );
}
