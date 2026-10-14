/**
 * 会话动作对话框的注册表（08 §3.3 会话菜单；SessionActions 的 `dialogs`）：取消 / 延长 / 结束复用工作台的对话框
 * （`workspace/timer/StandaloneDialogs.tsx`），按需加载，不进首屏包。
 */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import type { SessionActionDialogProps, SessionActionDialogs } from '../components/SessionActions';

const load = () => import('../workspace/timer/StandaloneDialogs');
const Cancel = lazy(() => load().then((m) => ({ default: m.CancelAction })));
const Extend = lazy(() => load().then((m) => ({ default: m.ExtendAction })));
const End = lazy(() => load().then((m) => ({ default: m.EndAction })));

function suspended(C: LazyExoticComponent<ComponentType<SessionActionDialogProps>>): ComponentType<SessionActionDialogProps> {
  function SessionActionDialog(p: SessionActionDialogProps) {
    return (
      <Suspense fallback={null}>
        <C {...p} />
      </Suspense>
    );
  }
  return SessionActionDialog;
}

export const SESSION_ACTION_DIALOGS: SessionActionDialogs = {
  cancel: suspended(Cancel),
  extend: suspended(Extend),
  end: suspended(End),
};
