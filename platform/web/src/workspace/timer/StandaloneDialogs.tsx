/**
 * 会话菜单（顶栏胶囊 §3.3、目录环境条）里的“取消… / 延长… / 结束实验…”：复用工作台的 CancelDialog、ExtendDialog、EndDialog（§5.2），
 * 在工作台之外为它们准备一个最小的 WorkspaceContext（会话视图来自 SessionSync，数据来自 useWorkspaceData，护栏与工作台同一算法）。
 * 由 `app/sessionActionDialogs.tsx` 按需加载后注册到 SessionActionsProvider（platform-web-integration）。
 */
import type { ReactNode } from 'react';
import type { SessionActionDialogProps } from '../../components/SessionActions';
import { useAuth, useServices, useWatchedSession } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { allowedActionsOf, workspaceRender } from '../../app/sessionRouting';
import { Dialog, Skeleton } from '../../ui';
import { WorkspaceContext, type Guardrails, type WorkspaceCtx } from '../context';
import { useWorkspaceData } from '../data/useWorkspaceData';
import type { SessionView } from '../../api/types';
import { EndDialog } from './EndDialog';
import { ExtendDialog } from './ExtendDialog';
import { CancelDialog } from './SessionDialogs';

import { W } from '../strings';
function Loading({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={title} size="narrow">
      <Skeleton lines={3} />
    </Dialog>
  );
}

function WithView({ sid, view, children }: { sid: string; view: SessionView; children: ReactNode }) {
  const { clock } = useServices();
  const { principal } = useAuth();
  const status = useGlobalStatus();
  const role = principal?.role ?? null;
  const catalogVersion = view.catalogVersion ?? status.catalog?.catalogVersion ?? null;
  const data = useWorkspaceData(sid, view, { role, catalogVersion });
  const g = status.guardrails;
  const guard: Guardrails = {
    uninstalling: !!g?.uninstalling || status.platform.data?.mode === 'UNINSTALLING',
    budgetExceeded: g?.budget?.state === 'EXCEEDED',
    budgetWarn: g?.budget?.state === 'WARN',
    budgetEndActive: g?.budget?.state === 'EXCEEDED' && g?.budget?.enforcement === 'end-active',
    envDegraded: [...data.events].reverse().find((x) => x.type === 'env.degraded' || x.type === 'env.recovered')?.type === 'env.degraded',
  };
  const nowMs = clock.now();
  const render = workspaceRender(view);
  const ctx: WorkspaceCtx = {
    sid,
    view,
    render,
    role,
    learner: role === 'L',
    live: render.screen === 'P05' && render.variant === 'live' && !view.revokedAt,
    preparing: render.screen === 'P04' && render.variant === 'preparing',
    accessRevoked: !!view.revokedAt || !['READY', 'RUNNING', 'EXPIRING'].includes(view.state),
    allowed: allowedActionsOf(view, { role, nowMs, uninstalling: guard.uninstalling, budgetExceeded: guard.budgetExceeded, envHealthy: !guard.envDegraded }),
    data,
    guard,
    outage: null,
    now: clock.now,
    reporter: null,
  };
  return <WorkspaceContext.Provider value={ctx}>{children}</WorkspaceContext.Provider>;
}

function Standalone({ sid, title, onClose, children }: { sid: string; title: string; onClose: () => void; children: ReactNode }) {
  const view = useWatchedSession(sid);
  if (!view || view.sessionId !== sid) return <Loading title={title} onClose={onClose} />;
  return (
    <WithView sid={sid} view={view}>
      {children}
    </WithView>
  );
}

export function CancelAction({ sid, onClose }: SessionActionDialogProps) {
  return (
    <Standalone sid={sid} title={W.dialogs.standaloneCancel} onClose={onClose}>
      <CancelDialog onClose={onClose} />
    </Standalone>
  );
}

export function ExtendAction({ sid, onClose }: SessionActionDialogProps) {
  return (
    <Standalone sid={sid} title={W.dialogs.standaloneExtend} onClose={onClose}>
      <ExtendDialog onClose={onClose} />
    </Standalone>
  );
}

export function EndAction({ sid, onClose }: SessionActionDialogProps) {
  return (
    <Standalone sid={sid} title={W.dialogs.standaloneEnd} onClose={onClose}>
      <EndDialog onClose={onClose} />
    </Standalone>
  );
}
