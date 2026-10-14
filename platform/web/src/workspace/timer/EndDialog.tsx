/**
 * 结束 EndDialog（08 P05.9、§5.2；02 §6.1、§8）：选择“释放全部资源（推荐）”或“保留环境 N 小时”，以及“现在结束 / 到期时按选择处理”。
 * - 释放分支也给费用说明：回收完成前已创建的资源仍按实际时长计费 + 本次会话已产生 ≈ x（估算）；
 * - 保留：`POST /sessions/{sid}/quotes {purpose: KEEP, keepHours}`；上限 min(MaxKeepHours, 卡片 retain.maxHours)；卡片不允许、环境异常、
 *   平台卸载中、预算超限、环境超过最长寿命时置灰并说明；勾选“我了解保留期间这些资源会持续计费”才可提交；
 *   “输入卡片 id 以确认”只在报价返回 requiresTypedConfirm 时出现（§9.2 #7 回写前不显示）；
 * - 提交 `POST /sessions/{sid}/end {disposition, keepHours?, quoteId?, when, keepPrerequisites?}`：now → 跳到 /sessions/:sid/end（P07）；
 *   at-expiry → 留在工作台，顶栏显示“到期后保留 4 小时”；
 * - 错误：409 KEEP_NOT_ALLOWED / BUDGET_BLOCKED / PLATFORM_UNINSTALLING（只能释放）、422 QUOTE_*（重新报价）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import type { SessionView } from '../../api/types';
import { announce } from '../../lib/announce';
import { formatClock, formatCountdown, formatDate } from '../../lib/format';
import { ATTEMPT_STATUS_META, Button, Dialog, Shape, Skeleton, useSecondTick, type AttemptStatus } from '../../ui';
import { useWorkspace } from '../context';
import { accruedOf, formatRange, quoteHourly, scaleRange, type QuoteView } from '../model/cost';
import { endPrimaryLabel, KEEP_REASON_TEXT, keepBlock, keepHourOptions, quoteRemainingMs, type Disposition, type When } from '../model/expiry';

import { t } from '../../i18n';
import { W } from '../strings';
const WE = W.end;
const PREREQ_TEXT: Readonly<Record<string, string>> = WE.prereq;

export function EndDialog({ initialWhen = 'now', onClose }: { initialWhen?: When; onClose: () => void }) {
  const ws = useWorkspace();
  const { api, sync } = useServices();
  const navigate = useNavigate();
  useSecondTick(true);
  const v = ws.view;
  const lab = ws.data.lab.data;
  const [disposition, setDisposition] = useState<Disposition>('destroy');
  const [when, setWhen] = useState<When>(initialWhen);
  const opts = keepHourOptions(Math.min(v.limits?.keepMaxHours ?? 24, lab?.retain?.maxHours ?? v.limits?.keepMaxHours ?? 24));
  const [hours, setHours] = useState<number>(opts.includes(4) ? 4 : opts[0]!);
  const [ackKeep, setAckKeep] = useState(false);
  const [typed, setTyped] = useState('');
  const [prereqs, setPrereqs] = useState<string[]>([]);
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [qn, setQn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const op = useRef(api.operation('endSession'));
  const ids = useId();

  const keepReason = keepBlock(v, ws.allowed, {
    learner: ws.learner,
    uninstalling: ws.guard.uninstalling,
    budgetExceeded: ws.guard.budgetExceeded,
    envDegraded: ws.guard.envDegraded,
    cardAllows: lab?.retain?.allowed !== false,
    nowMs: ws.now(),
  });

  useEffect(() => {
    if (disposition !== 'keep') return undefined;
    let alive = true;
    setQuote(null);
    setQuoteErr(null);
    api
      .call<QuoteView>('createSessionQuote', { params: { sid: ws.sid }, body: { purpose: 'KEEP', keepHours: hours } })
      .then((r) => {
        if (!alive) return;
        setQuote(r.data);
        op.current = api.operation('endSession');
      })
      .catch((e) => alive && setQuoteErr(isApiError(e) ? (e.code === 'KEEP_NOT_ALLOWED' ? KEEP_REASON_TEXT['not-allowed'] : (e.detail ?? e.title)) : WE.quoteFailed));
    return () => {
      alive = false;
    };
  }, [disposition, hours, qn, api, ws.sid]);

  const accrued = accruedOf(ws.data.cost.data);
  const currency = ws.data.cost.data?.currency ?? quote?.currency ?? 'USD';
  const hourly = quoteHourly(quote, 'KEEP');
  const qLeft = quoteRemainingMs(quote, Date.now());
  const qExpired = qLeft !== null && qLeft <= 0;
  const typedNeeded = disposition === 'keep' && !!quote?.requiresTypedConfirm;
  const keepables = (lab?.keepablePrerequisites ?? []).filter((p) => PREREQ_TEXT[p]);
  const nonStoppable = (ws.data.cost.data?.billable ?? []).filter((b) => b.billing === 'hourly' && !/AWS::EC2::Instance|ec2:instance/i.test(b.type ?? ''));
  const canSubmit =
    !busy && ws.allowed.includes('end') && (disposition === 'destroy' || (!keepReason && !!quote && !qExpired && ackKeep && (!typedNeeded || typed.trim() === v.labId)));
  const primary = endPrimaryLabel(disposition, when, hours);
  const attempt = (ws.data.progress.data?.status ?? v.progress?.status ?? 'active') as AttemptStatus;

  const submit = async () => {
    if (!ws.allowed.includes('end')) {
      setError(WE.notAllowed);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await op.current.run<SessionView>({
        params: { sid: ws.sid },
        ifMatch: ws.view.ver,
        body: {
          disposition,
          when,
          ...(disposition === 'keep' ? { keepHours: hours, quoteId: quote?.quoteId } : {}),
          ...(prereqs.length ? { keepPrerequisites: prereqs } : {}),
        },
      });
      if (r.data?.sessionId) sync.applyView(r.data);
      else void sync.refreshView(ws.sid);
      if (when === 'now') {
        announce(WE.ending);
        onClose();
        navigate(`/sessions/${ws.sid}/end`);
      } else {
        announce(disposition === 'keep' ? t(WE.keepAfter, { n: hours }) : WE.releaseAtExpiry);
        onClose();
      }
    } catch (e) {
      const code = isApiError(e) ? e.code : null;
      if (code === 'QUOTE_EXPIRED' || code === 'QUOTE_MISMATCH') {
        setError(WE.quoteExpired);
        setAckKeep(false);
        setQn((n) => n + 1);
      } else if (code === 'KEEP_NOT_ALLOWED' || code === 'BUDGET_BLOCKED' || code === 'PLATFORM_UNINSTALLING') {
        setError(`${code === 'KEEP_NOT_ALLOWED' ? KEEP_REASON_TEXT['not-allowed'] : code === 'BUDGET_BLOCKED' ? KEEP_REASON_TEXT.budget : KEEP_REASON_TEXT.uninstalling}`);
        setDisposition('destroy');
      } else if (code === 'PRECONDITION_FAILED' || code === 'INVALID_STATE' || code === 'SESSION_EXPIRING_OR_ENDED') {
        setError(WE.stateChanged);
        void sync.refreshView(ws.sid);
      } else setError(isApiError(e) ? (e.detail ?? e.title) : WE.retryable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={WE.title}
      dismissible={!busy}
      initialFocus="[data-cancel]"
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={onClose} disabled={busy}>
            {WE.cancel}
          </button>
          <Button variant={disposition === 'keep' ? 'primary' : 'danger'} onClick={() => void submit()} disabled={!canSubmit} busy={busy} busyText={WE.submitting} data-end-submit="">
            {primary}
          </Button>
        </>
      }
    >
      <div className="stack enddlg" data-end-dialog="">
        <p className="small">{WE.flow}</p>
        <p className="small">
          {t(WE.attempt, { state: ATTEMPT_STATUS_META[attempt]?.text ?? WE.active })}
          {attempt === 'active' ? WE.notSubmitted : WE.period}
        </p>
        <fieldset className="stack-8">
          <legend>{WE.environment}</legend>
          <label className="row optrow">
            <input type="radio" name={`${ids}-d`} checked={disposition === 'destroy'} onChange={() => setDisposition('destroy')} />
            <b>{WE.releaseAll}</b>
          </label>
          <p className="small muted indent">
            {t(WE.releaseCost, { accrued: accrued ? formatRange(accrued, currency) : WE.noEstimate })}
          </p>
          <div className="row optrow">
            <label className="row">
              <input type="radio" name={`${ids}-d`} checked={disposition === 'keep'} disabled={!!keepReason} onChange={() => setDisposition('keep')} aria-describedby={keepReason ? `${ids}-kr` : undefined} />
              <b>{WE.keep}</b>
            </label>
            <select className="input" aria-label={WE.keepHours} value={hours} disabled={!!keepReason || disposition !== 'keep'} onChange={(e) => setHours(Number(e.target.value))}>
              {opts.map((h) => (
                <option key={h} value={h}>
                  {t(WE.hours, { n: h })}
                </option>
              ))}
            </select>
            <span className="small muted">{t(WE.cardMax, { n: opts[opts.length - 1] })}</span>
          </div>
          <span id={`${ids}-kr`} className={keepReason ? 'small st fail indent' : 'sr'}>
            {keepReason ? KEEP_REASON_TEXT[keepReason] : WE.canKeep}
          </span>
          {disposition === 'keep' && !keepReason ? (
            <div className="stack-4 indent" data-keep-quote="">
              {quoteErr ? (
                <span className="small st fail">{quoteErr}</span>
              ) : !quote ? (
                <Skeleton lines={1} label={WE.computing} />
              ) : (
                <>
                  <span className="small">
                    {hourly
                      ? t(WE.keepCost, { hourly: formatRange(hourly, quote.currency ?? 'USD'), n: hours, total: formatRange(scaleRange(hourly, hours), quote.currency ?? 'USD').replace(/^≈ /, '') })
                      : WE.keepCostUnknown}
                  </span>
                  <span className="small muted">
                    {t(WE.priceAsOf, { t: quote.priceAsOf ? formatDate(quote.priceAsOf, ws.now()) : WE.notProvided })}
                    {qLeft !== null ? (qExpired ? WE.quoteExpiredShort : t(WE.quoteExpiresIn, { t: formatCountdown(qLeft) })) : ''}
                    {qExpired ? (
                      <>
                        {' '}
                        <button type="button" className="linkbtn" onClick={() => setQn((n) => n + 1)}>
                          {WE.recompute}
                        </button>
                      </>
                    ) : null}
                  </span>
                </>
              )}
              <span className="small">{t(WE.saveMode, { tail: nonStoppable.length ? WE.nonStoppable : WE.nonStoppableGeneric })}</span>
              {nonStoppable.length ? (
                <ul className="small mlist">
                  {nonStoppable.slice(0, 8).map((b, i) => (
                    <li key={b.resourceKey ?? i}>{b.type ?? b.name}</li>
                  ))}
                </ul>
              ) : null}
              <span className="small">{WE.noAccess}</span>
              <label className="row small">
                <input type="checkbox" checked={ackKeep} onChange={(e) => setAckKeep(e.target.checked)} />
                {WE.ackKeep}
              </label>
              {typedNeeded ? (
                <label className="small stack-4">
                  {WE.typeId}
                  <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} aria-describedby={`${ids}-typed`} />
                  <span id={`${ids}-typed`} className="faint">
                    {t(WE.typeIdHint, { labId: v.labId })}
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}
        </fieldset>
        {keepables.length ? (
          <fieldset className="stack-4">
            <legend>{WE.prereqs}</legend>
            {keepables.map((p) => (
              <label key={p} className="row small">
                <input type="checkbox" checked={prereqs.includes(p)} onChange={(e) => setPrereqs((l) => (e.target.checked ? [...l, p] : l.filter((x) => x !== p)))} />
                {PREREQ_TEXT[p]}
              </label>
            ))}
          </fieldset>
        ) : null}
        <fieldset className="row">
          <legend>{WE.when}</legend>
          <label className="row">
            <input type="radio" name={`${ids}-w`} checked={when === 'now'} onChange={() => setWhen('now')} />
            {WE.now}
          </label>
          <label className="row">
            <input type="radio" name={`${ids}-w`} checked={when === 'at-expiry'} onChange={() => setWhen('at-expiry')} />
            {v.deadlineAt ? t(WE.atExpiryTime, { t: formatClock(v.deadlineAt) }) : WE.atExpiry}
          </label>
        </fieldset>
        {error ? (
          <p className="small st fail" role="alert">
            {error}
          </p>
        ) : null}
        {disposition === 'keep' ? null : (
          <p className="small muted">
            <Shape name="dot" /> {WE.defaultNote}
          </p>
        )}
      </div>
    </Dialog>
  );
}
