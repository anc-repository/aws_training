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

export function actionTitle(actionId: string, title?: string | null): string {
  if (title) return title;
  if (actionId.startsWith('xstk-')) return `部署 ${actionId.slice(5)}`;
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
  const blocked = !ws.learner ? '你的角色不能执行平台动作' : !ws.live ? '实验就绪后可用' : running ? '平台正在执行这个动作' : null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call('requestModuleOp', { params: { sid: ws.sid }, body: { actionId } });
      announce(`已请求平台动作：${title}`);
      setOpen(false);
      void ws.data.moduleOps.refresh();
    } catch (e) {
      setError(isApiError(e) ? (e.code === 'OP_NOT_ALLOWED' ? '本卡片不允许这个平台动作' : e.code === 'REAUTH_REQUIRED' ? '这个操作要求最近 60 分钟内登录过' : (e.detail ?? e.title)) : '请求没有完成，请稍后重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="box inset stack-4 pact" data-platform-action={actionId}>
      <div className="row between">
        <b className="small">平台动作：{title}</b>
        <Button size="sm" onClick={() => setOpen(true)} disabledReason={blocked}>
          {title}…
        </Button>
      </div>
      {decl?.interruptsManagementChannel ? <span className="small muted">执行期间会暂时中断平台管理通道（预期中断）。</span> : null}
      {op ? (
        <span className="small">
          {running ? (
            <Status meta={{ text: '平台正在修改环境', shape: 'spin', tone: 'pend', spin: true }} />
          ) : failed ? (
            <Status meta={{ text: `执行失败${op.summary ? `：${op.summary}` : ''}`, shape: 'xbox', tone: 'fail' }} />
          ) : (
            <Status meta={{ text: '已完成', shape: 'check', tone: 'pass' }} />
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
              取消
            </button>
            <Button variant="primary" busy={busy} busyText="正在请求…" onClick={() => void submit()}>
              确认执行
            </Button>
          </>
        }
      >
        <p>{decl?.confirm ?? '平台会以运行器修改你的实验环境。确认执行吗？'}</p>
        {decl?.interruptsManagementChannel ? (
          <div className="note amber">
            <Shape name="tri" />
            <span>执行期间实验机终端与本地检测会暂时不可用，属预期。</span>
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
