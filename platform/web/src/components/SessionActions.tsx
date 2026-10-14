/**
 * 会话动作对话框的注册点（08 §3.3 会话菜单：取消… / 延长 30 分钟 / 结束实验…）。
 * 菜单与快捷键只调用 open(kind, sid)；对话框本身（CancelDialog、ExtendDialog、EndDialog，§5.2）由 P04、P05.9 的实现者提供，
 * 通过 `dialogs` 属性注册。脚手架阶段的默认实现只是一个说明“将在后续实现”的对话框，不发出任何请求。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Dialog } from '../ui';
import { msg } from '../i18n';

export type SessionActionKind = 'cancel' | 'extend' | 'end';

export interface SessionActionDialogProps {
  sid: string;
  onClose: () => void;
}

export type SessionActionDialogs = Partial<Record<SessionActionKind, ComponentType<SessionActionDialogProps>>>;

interface Ctx {
  open: (kind: SessionActionKind, sid: string) => void;
}

const SessionActionsContext = createContext<Ctx>({ open: () => undefined });

const TITLES: Readonly<Record<SessionActionKind, string>> = msg.frame.actions;

function StubDialog({ kind, onClose }: { kind: SessionActionKind; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={TITLES[kind]}
      size="narrow"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {msg.app.close}
        </button>
      }
    >
      <p>{msg.app.todo}</p>
    </Dialog>
  );
}

export function SessionActionsProvider({ children, dialogs = {} }: { children: ReactNode; dialogs?: SessionActionDialogs }) {
  const [state, setState] = useState<{ kind: SessionActionKind; sid: string } | null>(null);
  const open = useCallback((kind: SessionActionKind, sid: string) => setState({ kind, sid }), []);
  const value = useMemo(() => ({ open }), [open]);
  const close = () => setState(null);
  const Impl = state ? dialogs[state.kind] : undefined;
  return (
    <SessionActionsContext.Provider value={value}>
      {children}
      {state ? Impl ? <Impl sid={state.sid} onClose={close} /> : <StubDialog kind={state.kind} onClose={close} /> : null}
    </SessionActionsContext.Provider>
  );
}

export function useSessionActions(): Ctx {
  return useContext(SessionActionsContext);
}
