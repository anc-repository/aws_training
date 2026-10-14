/**
 * 取消（P04 CancelDialog）、T-5 到期提醒（ExpiryDialog）与到期 / 结束覆盖层（08 P04、P05.9、§5.2）。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import type { SessionView } from '../../api/types';
import { announce } from '../../lib/announce';
import { formatClock } from '../../lib/format';
import { Button, Dialog, Shape } from '../../ui';
import { useWorkspace } from '../context';
import { schedulerDrift } from '../model/expiry';

import { t } from '../../i18n';
import { W } from '../strings';

const WD = W.dialogs;
/** 取消实验（P04）：`POST /sessions/{sid}/end {disposition: destroy, when: now}`；会话离开 REQUESTED / PROVISIONING 时自动关闭。 */
export function CancelDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const { api, sync } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const op = useRef(api.operation('endSession'));
  const requested = ws.view.state === 'REQUESTED';
  useEffect(() => {
    if (!['REQUESTED', 'PROVISIONING'].includes(ws.view.state)) onClose();
  }, [ws.view.state, onClose]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await op.current.run<SessionView>({ params: { sid: ws.sid }, body: { disposition: 'destroy', when: 'now' } });
      if (r.data?.sessionId) sync.applyView(r.data);
      else void sync.refreshView(ws.sid);
      announce(WD.cancelling);
      onClose();
    } catch (e) {
      if (isApiError(e) && (e.status === 409 || e.code === 'INVALID_STATE')) {
        // 状态已推进（例如刚好就绪）：刷新后按新状态处理
        void sync.refreshView(ws.sid);
        onClose();
        return;
      }
      setError(isApiError(e) ? (e.detail ?? e.title) : WD.cancelFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={WD.cancelTitle}
      size="narrow"
      alert
      initialFocus="[data-cancel]"
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={onClose} disabled={busy}>
            {WD.keepPreparing}
          </button>
          <Button variant="danger" onClick={() => void submit()} busy={busy} busyText={WD.cancellingBusy} data-cancel-submit="">
            {WD.cancelTitle}
          </Button>
        </>
      }
    >
      <p>{requested ? WD.cancelRequested : WD.cancelProvisioning}</p>
      {error ? (
        <p className="small st fail" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** T-5 模态（只出现一次、只对学员；关闭后焦点回到原处，原焦点在终端则回到终端）。 */
export function ExpiryDialog({ canExtend, onExtend, onClose }: { canExtend: boolean; onExtend: () => void; onClose: () => void }) {
  const prev = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={WD.t5Title}
      size="narrow"
      initialFocus="[data-ack]"
      returnFocusTo={() => prev.current}
      footer={
        <>
          {canExtend ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                onClose();
                onExtend();
              }}
            >
              {WD.extend30}
            </button>
          ) : null}
          <button type="button" className="btn primary" data-ack="" onClick={onClose}>
            {WD.gotIt}
          </button>
        </>
      }
    >
      <p>{WD.t5Body}</p>
    </Dialog>
  );
}

/**
 * 到期 / 结束覆盖层（P05.9、§2.4 表 2）：`role="alertdialog"` + `aria-modal="true"`，出现时焦点移到主按钮 [查看回收进度]，
 * 背后的手册、终端区、分段控件与 SessionBar 设为 inert（由工作台根据 `overlay` 状态设置）；浏览器不调用“结束”，只加快轮询。
 */
export function ExpiredOverlay({ kind }: { kind: 'overdue' | 'revoking' }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus();
    announce(kind === 'overdue' ? WD.overdueAnnounce : WD.endedAnnounce, { politeness: 'assertive' });
  }, [kind]);
  const drift = schedulerDrift(ws.view, ws.now());
  return (
    <div className="ws-ovl" role="alertdialog" aria-modal="true" aria-labelledby="ws-ovl-t" aria-describedby="ws-ovl-d" data-ws-overlay={kind}>
      <div className="ws-ovl-box stack-8">
        <h2 id="ws-ovl-t">
          <Shape name="hg" /> {kind === 'overdue' ? WD.overdueTitle : WD.endedTitle}
        </h2>
        <p id="ws-ovl-d">
          {kind === 'overdue' ? WD.overdueBody : WD.endedBody}
          {ws.view.deadlineAt && kind === 'overdue' ? t(WD.expiredAt, { t: formatClock(ws.view.deadlineAt) }) : ''}
        </p>
        {drift ? <p className="small muted">{WD.drift}</p> : null}
        <div className="row">
          <button ref={primary} type="button" className="btn primary" onClick={() => navigate(`/sessions/${ws.sid}/end`)} data-ovl-primary="">
            {WD.viewReclaim}
          </button>
          {ws.view.readyAt ? (
            <Button onClick={() => navigate(`/sessions/${ws.sid}/report`)}>{WD.viewReport}</Button>
          ) : null}
          <Button variant="ghost" onClick={() => navigate('/labs')}>
            {WD.backToCatalog}
          </Button>
        </div>
      </div>
    </div>
  );
}
