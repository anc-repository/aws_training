/**
 * 平台动作 PlatformActionButton（`::platform-action{id}`，08 P05.3、§5.3；04 §4.3）：显示 `confirm` 文案，学员确认后
 * `POST /sessions/{sid}/module-ops {actionId}`（敏感操作，可能 REAUTH_REQUIRED，由全局 ReauthDialog 处理）；
 * 执行中显示“平台正在修改环境”（module_op.started → succeeded / failed）；`interruptsManagementChannel` 的动作执行后实验机终端标为
 * “管理通道暂时不可用”（窗口由 atl-module-op 打开，界面不需要额外控件）；`xstk-<stackId>` 渲染为“部署 {栈说明}”。
 */
import { useState } from 'react';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import { announce } from '../../lib/announce';
import { Button, Dialog, Shape, Status } from '../../ui';
import { useWorkspace } from '../context';

import { t } from '../../i18n';
import { W } from '../strings';

const WA = W.action;
export function actionTitle(actionId: string, title?: string | null): string {
  if (title) return title;
  if (actionId.startsWith('xstk-')) return t(WA.deploy, { id: actionId.slice(5) });
  return actionId;
}

export function PlatformActionButton({ actionId }: { actionId: string }) {
  const ws = useWorkspace();
  const { api } = useServices();
  const decl = ws.data.lab.data?.platformOps?.find((o) => o.id === actionId);
  const title = actionTitle(actionId, decl?.title);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const op = (ws.data.moduleOps.data?.items ?? []).find((o) => o.actionId === actionId);
  const status = (op?.status ?? op?.state ?? '').toLowerCase();
  const running = !!op && !op.finishedAt && !['succeeded', 'failed', 'done'].includes(status);
  const failed = !!op && (status === 'failed' || (op.exitCode !== null && op.exitCode !== undefined && op.exitCode !== 0));
  const blocked = !ws.learner ? WA.roleDenied : !ws.live ? WA.afterReady : running ? WA.running : null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call('requestModuleOp', { params: { sid: ws.sid }, body: { actionId } });
      announce(t(WA.requested, { title }));
      setOpen(false);
      void ws.data.moduleOps.refresh();
    } catch (e) {
      setError(isApiError(e) ? (e.code === 'OP_NOT_ALLOWED' ? WA.notAllowed : e.code === 'REAUTH_REQUIRED' ? WA.reauth : (e.detail ?? e.title)) : WA.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="box inset stack-4 pact" data-platform-action={actionId}>
      <div className="row between">
        <b className="small">{t(WA.title, { title })}</b>
        <Button size="sm" onClick={() => setOpen(true)} disabledReason={blocked}>
          {title}…
        </Button>
      </div>
      {decl?.interruptsManagementChannel ? <span className="small muted">{WA.interrupts}</span> : null}
      {op ? (
        <span className="small">
          {running ? (
            <Status meta={{ text: WA.modifying, shape: 'spin', tone: 'pend', spin: true }} />
          ) : failed ? (
            <Status meta={{ text: op.summary ? t(WA.execFailedSummary, { summary: op.summary }) : WA.execFailed, shape: 'xbox', tone: 'fail' }} />
          ) : (
            <Status meta={{ text: WA.done, shape: 'check', tone: 'pass' }} />
          )}
        </span>
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        size="narrow"
        initialFocus="[data-cancel]"
        footer={
          <>
            <button type="button" className="btn" data-cancel="" onClick={() => setOpen(false)}>
              {WA.cancel}
            </button>
            <Button variant="primary" busy={busy} busyText={WA.requesting} onClick={() => void submit()}>
              {WA.confirm}
            </Button>
          </>
        }
      >
        <p>{decl?.confirm ?? WA.confirmDefault}</p>
        {decl?.interruptsManagementChannel ? (
          <div className="note amber">
            <Shape name="tri" />
            <span>{WA.interruptsNote}</span>
          </div>
        ) : null}
        {error ? (
          <p className="small st fail" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
