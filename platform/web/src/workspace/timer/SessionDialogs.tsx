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
      announce('正在取消实验');
      onClose();
    } catch (e) {
      if (isApiError(e) && (e.status === 409 || e.code === 'INVALID_STATE')) {
        // 状态已推进（例如刚好就绪）：刷新后按新状态处理
        void sync.refreshView(ws.sid);
        onClose();
        return;
      }
      setError(isApiError(e) ? (e.detail ?? e.title) : '取消没有完成，可以重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="取消实验"
      size="narrow"
      alert
      initialFocus="[data-cancel]"
      dismissible={!busy}
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={onClose} disabled={busy}>
            继续准备
          </button>
          <Button variant="danger" onClick={() => void submit()} busy={busy} busyText="正在取消…" data-cancel-submit="">
            取消实验
          </Button>
        </>
      }
    >
      <p>{requested ? '尚未创建任何资源，取消不会产生费用。' : '取消后，已经创建的资源会被释放，可能需要一些时间。准备期间产生的费用不会退回。'}</p>
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
      title="还剩 5 分钟"
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
              延长 30 分钟
            </button>
          ) : null}
          <button type="button" className="btn primary" data-ack="" onClick={onClose}>
            知道了
          </button>
        </>
      }
    >
      <p>还剩 5 分钟。正在运行的对比实验，请尽快让结果上传完成（结束时平台会接收在途上传）。</p>
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
    announce(kind === 'overdue' ? '实验时间已到，相关对话框已关闭' : '实验已结束，正在收回访问并释放资源', { politeness: 'assertive' });
  }, [kind]);
  const drift = schedulerDrift(ws.view, ws.now());
  return (
    <div className="ws-ovl" role="alertdialog" aria-modal="true" aria-labelledby="ws-ovl-t" aria-describedby="ws-ovl-d" data-ws-overlay={kind}>
      <div className="ws-ovl-box stack-8">
        <h2 id="ws-ovl-t">
          <Shape name="hg" /> {kind === 'overdue' ? '实验时间已到' : '实验已结束'}
        </h2>
        <p id="ws-ovl-d">
          {kind === 'overdue' ? '实验时间已到，正在收回访问并释放资源。' : '实验已结束，正在收回访问并释放资源。'}
          {ws.view.deadlineAt && kind === 'overdue' ? `（${formatClock(ws.view.deadlineAt)} 到期）` : ''}
        </p>
        {drift ? <p className="small muted">平台正在补触发到期处理（通常几分钟内）。</p> : null}
        <div className="row">
          <button ref={primary} type="button" className="btn primary" onClick={() => navigate(`/sessions/${ws.sid}/end`)} data-ovl-primary="">
            查看回收进度
          </button>
          {ws.view.readyAt ? (
            <Button onClick={() => navigate(`/sessions/${ws.sid}/report`)}>查看报告</Button>
          ) : null}
          <Button variant="ghost" onClick={() => navigate('/labs')}>
            回到卡片目录
          </Button>
        </div>
      </div>
    </div>
  );
}
