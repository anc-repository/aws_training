/**
 * P07-K 的两个对话框（08 P07-K 操作表；§5.2 QuotePanel `keep` 变体的精简版）：
 * - 延长保留：选择小时数 → `POST /sessions/{sid}/quotes {purpose: KEEP, keepHours}` → 显示估算（没有金额写“未知”，不编造价格）与取价时间 →
 *   勾选确认（部分单价不可得时额外勾选；预算接近时再确认一次）→ `POST …/keep/extend {hours, quoteId}`；报价过期时主按钮变为“重新计算费用”；
 * - 立即释放：alertdialog，默认焦点在“取消”（§8.3），确认后 `POST …/keep/release`（202），页面按新状态切回回收进度。
 * 两个对话框都只在学员的保留会话中出现；写操作的重试复用同一个 Idempotency-Key（useAction）。
 */
import { useEffect, useState } from 'react';
import type { SessionView } from '../../api/types';
import { useServices } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { announce } from '../../lib/announce';
import { formatClock, formatDate } from '../../lib/format';
import { BILLING_TEXT, Button, Dialog, Field, Shape } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { useAction } from '../errors/useAction';
import { formatMoneyRange } from '../sessions/sessionText';

import { msg, t } from '../../i18n';

const K = msg.end.keep;
export interface KeepQuote {
  quoteId: string;
  keepHours?: number;
  currency?: string;
  priceAsOf?: string | null;
  expiresAt?: string;
  retainHourly?: number | null;
  hourly?: { start?: { low?: number; high?: number } | null; completed?: { low?: number; high?: number } | null } | null;
  lines?: { service?: string; dimension?: string; detail?: string; billing?: string; perHourLow?: number; perHourHigh?: number; unknown?: boolean }[];
  incomplete?: string[];
  disclaimer?: string;
}

export const KEEP_HOUR_OPTIONS = [1, 2, 4, 8, 12, 24, 48, 72];

export function keepAmount(q: KeepQuote, hours: number): string | null {
  if (typeof q.retainHourly === 'number') return t(K.amount, { range: formatMoneyRange(q.retainHourly, q.retainHourly, q.currency ?? 'USD', K.perHour), n: hours });
  const r = q.hourly?.completed ?? q.hourly?.start ?? null;
  return r ? t(K.amount, { range: formatMoneyRange(r.low ?? null, r.high ?? null, q.currency ?? 'USD', K.perHour), n: hours }) : null;
}

export function KeepExtendDialog({ view, onClose }: { view: SessionView; onClose: () => void }) {
  const sid = view.sessionId;
  const { clock, sync } = useServices();
  const { guardrails } = useGlobalStatus();
  const max = view.limits?.keepMaxHours ?? 72;
  const options = KEEP_HOUR_OPTIONS.filter((h) => h <= max);
  const [hours, setHours] = useState<number>(options.includes(4) ? 4 : (options[0] ?? 1));
  const [ack, setAck] = useState(false);
  const [ackUnknown, setAckUnknown] = useState(false);
  const [ackBudget, setAckBudget] = useState(false);
  const quote = useAction<KeepQuote>('createSessionQuote', { sid });
  const extend = useAction<SessionView>('extendKeep', {
    sid,
    onSuccess: (v) => {
      if (v) sync.applyView(v);
      const until = (v?.keep as { until?: string } | null | undefined)?.until;
      announce(until ? t(K.extendedTo, { t: formatClock(until) }) : K.extended);
      onClose();
    },
  });
  const runQuote = quote.run;
  useEffect(() => {
    void runQuote({ params: { sid }, body: { purpose: 'KEEP', keepHours: hours } });
  }, [runQuote, sid, hours]);
  const q = quote.data;
  const expired = !!q?.expiresAt && Date.parse(q.expiresAt) <= clock.now();
  const unknown = !!q && ((q.incomplete?.length ?? 0) > 0 || (q.lines ?? []).some((l) => l.unknown));
  const budgetWarn = guardrails?.budget?.state === 'WARN';
  const ready = !!q && !quote.busy && ack && (!unknown || ackUnknown) && (!budgetWarn || ackBudget);
  const amount = q ? keepAmount(q, hours) : null;
  useEffect(() => {
    if (extend.error?.code === 'QUOTE_EXPIRED' || extend.error?.code === 'QUOTE_MISMATCH') void runQuote({ params: { sid }, body: { purpose: 'KEEP', keepHours: hours } });
  }, [extend.error, runQuote, sid, hours]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={K.title}
      size="narrow"
      dismissible={!extend.busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={extend.busy}>
            {K.cancel}
          </button>
          {expired ? (
            <Button variant="primary" onClick={() => void runQuote({ params: { sid }, body: { purpose: 'KEEP', keepHours: hours } })}>
              {K.recompute}
            </Button>
          ) : (
            <Button
              variant="primary"
              busy={extend.busy}
              busyText={K.extending}
              disabledReason={ready ? null : quote.busy ? K.computingReason : K.confirmFirst}
              onClick={() => q && void extend.run({ params: { sid }, body: { hours, quoteId: q.quoteId } })}
            >
              {K.extend}
            </Button>
          )}
        </>
      }
    >
      <Field label={K.more} hint={t(K.moreHint, { n: max })}>
        <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {options.map((h) => (
            <option key={h} value={h}>
              {t(K.hours, { n: h })}
            </option>
          ))}
        </select>
      </Field>
      {quote.busy ? (
        <p className="row small" role="status">
          <Shape name="spin" spin /> {K.computing}
        </p>
      ) : q ? (
        <div className="stack-8" data-quote={q.quoteId}>
          <p className="small">
            {t(K.cost, { amount: amount ?? K.unknown })}
            {amount ? '' : K.unknownPrice}
            {K.period}
          </p>
          {q.lines?.length ? (
            <ul className="small">
              {q.lines.map((l, i) => (
                <li key={i}>
                  {l.service ?? l.detail ?? '—'}
                  {l.detail && l.service ? ` · ${l.detail}` : ''}
                  {l.billing ? ` · ${BILLING_TEXT[l.billing as keyof typeof BILLING_TEXT] ?? l.billing}` : ''}
                  {l.unknown ? K.unknownLine : typeof l.perHourLow === 'number' ? ` · ${formatMoneyRange(l.perHourLow, l.perHourHigh ?? l.perHourLow, q.currency ?? 'USD', K.perHour)}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="small muted">
            {t(K.priceNote, { asOf: q.priceAsOf ? t(K.priceAsOf, { t: formatDate(q.priceAsOf, clock.now()) }) : '' })}
            {q.expiresAt ? t(K.validUntil, { t: formatClock(q.expiresAt) }) : ''}
          </p>
          {expired ? <p className="small st drift">{K.expired}</p> : null}
        </div>
      ) : null}
      {quote.error ? <InlineProblem error={quote.error} onRetry={() => void quote.retry()} /> : null}
      <label className="chk">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>{K.ack}</span>
      </label>
      {unknown ? (
        <label className="chk">
          <input type="checkbox" checked={ackUnknown} onChange={(e) => setAckUnknown(e.target.checked)} />
          <span>{K.ackUnknown}</span>
        </label>
      ) : null}
      {budgetWarn ? (
        <label className="chk">
          <input type="checkbox" checked={ackBudget} onChange={(e) => setAckBudget(e.target.checked)} />
          <span>{K.ackBudget}</span>
        </label>
      ) : null}
      {extend.error ? <InlineProblem error={extend.error} onRetry={() => void extend.retry()} /> : null}
    </Dialog>
  );
}

export function ReleaseKeepDialog({ view, onClose }: { view: SessionView; onClose: () => void }) {
  const sid = view.sessionId;
  const { sync } = useServices();
  const release = useAction<SessionView>('releaseKeep', {
    sid,
    onSuccess: (v) => {
      if (v) sync.applyView(v);
      void sync.refreshView(sid);
      announce(K.releaseStarted);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={K.releaseTitle}
      size="narrow"
      alert
      initialFocus="[data-cancel]"
      dismissible={!release.busy}
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={onClose} disabled={release.busy}>
            {K.cancel}
          </button>
          <Button variant="danger-solid" busy={release.busy} busyText={K.releasing} onClick={() => void release.run({ params: { sid } })}>
            {K.release}
          </Button>
        </>
      }
    >
      <p>{K.releaseNote}</p>
      {release.error ? <InlineProblem error={release.error} onRetry={() => void release.retry()} /> : null}
    </Dialog>
  );
}
