/**
 * 延长 ExtendDialog（08 P05.9、§5.2；02 §5.4）：
 * - 打开前与提交前都检查 allowedActions 含 extend 且剩余 > 30 秒；不满足时在对话框内显示原因，不发请求；
 * - 打开即 `POST /sessions/{sid}/quotes {purpose: EXTEND, minutes}`；报价 15 分钟有效，过期后主按钮换成“重新计算费用”；
 * - 提交 `POST /sessions/{sid}/extend {minutes, quoteId, expectedDeadlineVersion}`（If-Match + Idempotency-Key，重试复用同一个键）；
 * - 预算 WARN 时琥珀提示并追加勾选；错误：409 EXTENSION_LIMIT / SESSION_EXPIRING_OR_ENDED / BUDGET_BLOCKED、412 PRECONDITION_FAILED、422 QUOTE_*。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import type { SessionView } from '../../api/types';
import { announce } from '../../lib/announce';
import { formatClock, formatCountdown, formatDate } from '../../lib/format';
import { Button, Dialog, Shape, Skeleton, useSecondTick } from '../../ui';
import { useWorkspace } from '../context';
import { formatRange, quoteHourly, scaleRange, type QuoteView } from '../model/cost';
import { EXTEND_REASON_TEXT, extendBlock, extendSummary, quoteRemainingMs } from '../model/expiry';

export function ExtendDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const { api, sync } = useServices();
  useSecondTick(true);
  const v = ws.view;
  const minutes = Math.min(v.limits?.extensionMinutes ?? 30, v.limits?.extensionMinutesLeft ?? v.limits?.extensionMinutes ?? 30) || 30;
  const block = extendBlock(v, ws.allowed, { learner: ws.learner, uninstalling: ws.guard.uninstalling, budgetExceeded: ws.guard.budgetExceeded, nowMs: ws.now() });
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [ackBudget, setAckBudget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const op = useRef(api.operation('extendSession'));

  const requote = useCallback(async () => {
    setQuoteErr(null);
    setQuote(null);
    try {
      const r = await api.call<QuoteView>('createSessionQuote', { params: { sid: ws.sid }, body: { purpose: 'EXTEND', minutes } });
      setQuote(r.data);
      op.current = api.operation('extendSession');
    } catch (e) {
      setQuoteErr(isApiError(e) ? (e.code === 'EXTENSION_LIMIT' ? '延长次数或累计时长已用完。' : (e.detail ?? e.title)) : '没能计算费用，请重试。');
    }
  }, [api, ws.sid, minutes]);

  useEffect(() => {
    if (!block) void requote();
    // 只在打开时报价一次；过期后由学员点“重新计算费用”
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const qLeft = quoteRemainingMs(quote, Date.now());
  const expired = qLeft !== null && qLeft <= 0;
  const hourly = quoteHourly(quote, 'EXTEND');
  const currency = quote?.currency ?? 'USD';
  const deadlineAfter = v.deadlineAt ? Date.parse(v.deadlineAt) + minutes * 60_000 : null;
  const canSubmit = !block && !!quote && !expired && ack && (!ws.guard.budgetWarn || ackBudget) && !busy;

  const submit = async () => {
    const b = extendBlock(ws.view, ws.allowed, { learner: ws.learner, uninstalling: ws.guard.uninstalling, budgetExceeded: ws.guard.budgetExceeded, nowMs: ws.now() });
    if (b || !quote) {
      setError(b ? EXTEND_REASON_TEXT[b] : null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await op.current.run<SessionView>({
        params: { sid: ws.sid },
        ifMatch: ws.view.ver,
        body: { minutes, quoteId: quote.quoteId, expectedDeadlineVersion: ws.view.deadlineVersion ?? 1 },
      });
      if (r.data?.sessionId) sync.applyView(r.data);
      else void sync.refreshView(ws.sid);
      const at = r.data?.deadlineAt ?? (deadlineAfter ? new Date(deadlineAfter).toISOString() : null);
      announce(at ? `已延长到 ${formatClock(at)}` : '已延长');
      onClose();
    } catch (e) {
      const code = isApiError(e) ? e.code : null;
      if (code === 'QUOTE_EXPIRED' || code === 'QUOTE_MISMATCH') {
        setError('费用报价已失效，已重新计算，请重新确认。');
        setAck(false);
        void requote();
      } else if (code === 'PRECONDITION_FAILED') {
        setError('截止时间刚刚变化（可能在另一个标签页延长过），已刷新。');
        void sync.refreshView(ws.sid);
      } else if (code === 'SESSION_EXPIRING_OR_ENDED') {
        setError('已经到期，无法延长。');
        void sync.refreshView(ws.sid);
      } else if (code === 'EXTENSION_LIMIT') setError('延长次数或累计时长已用完。');
      else if (code === 'BUDGET_BLOCKED') setError('本月费用已超过预算，按设置不能延长。');
      else if (code === 'PLATFORM_UNINSTALLING') setError('平台正在卸载，不能延长。');
      else setError(isApiError(e) ? (e.detail ?? e.title) : '延长没有完成，可以重试（重试不会重复延长）。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`延长 ${minutes} 分钟`}
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          {block ? null : expired ? (
            <Button variant="primary" onClick={() => void requote()}>
              重新计算费用
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit} busy={busy} busyText="正在延长…" data-extend-submit="">
              延长 {minutes} 分钟
            </Button>
          )}
        </>
      }
    >
      <div className="stack" data-extend-dialog="">
        {block ? (
          <div className="note amber" role="alert">
            <Shape name="tri" />
            <span>{EXTEND_REASON_TEXT[block]}</span>
          </div>
        ) : (
          <>
            <p>{extendSummary(v, minutes, (ms) => formatClock(ms))}</p>
            {quoteErr ? (
              <p className="small st fail" role="alert">
                {quoteErr}{' '}
                <button type="button" className="linkbtn" onClick={() => void requote()}>
                  重试
                </button>
              </p>
            ) : !quote ? (
              <div role="status">
                <Skeleton lines={2} label="正在计算费用…" />
              </div>
            ) : (
              <div className="stack-4" data-quote="">
                {hourly ? (
                  <span>
                    费用（估算 · 按当前环境实际启用的资源）：{formatRange(hourly, currency)}/小时 × {minutes / 60} 小时 ≈ {formatRange(scaleRange(hourly, minutes / 60), currency).replace(/^≈ /, '')}
                  </span>
                ) : (
                  <span>费用（估算）：每小时单价暂不可得，无法估算这次延长的费用；延长期间资源照常按实际用量计费。</span>
                )}
                {quote.incomplete?.length ? <span className="small muted">部分单价不可得（{quote.incomplete.length} 项“未知”），估算不完整。</span> : null}
                <span className="small muted">
                  取价时间 {quote.priceAsOf ? formatDate(quote.priceAsOf, ws.now()) : '未提供'} · 以 AWS 官方定价与账单为准
                  {qLeft !== null ? (expired ? ' · 报价已失效' : ` · 报价 ${formatCountdown(qLeft)} 后失效`) : ''}
                </span>
              </div>
            )}
            {ws.guard.budgetWarn ? (
              <div className="note amber">
                <Shape name="tri" />
                <span>本月费用已接近预算。</span>
              </div>
            ) : null}
            <label className="row">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              我了解延长期间资源继续计费
            </label>
            {ws.guard.budgetWarn ? (
              <label className="row">
                <input type="checkbox" checked={ackBudget} onChange={(e) => setAckBudget(e.target.checked)} />
                我知道本月费用已接近预算
              </label>
            ) : null}
          </>
        )}
        {error ? (
          <p className="small st fail" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
