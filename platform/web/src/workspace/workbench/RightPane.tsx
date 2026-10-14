/**
 * 右侧四个标签（08 P05.6；03 §2.5、§8.4）：① 实验机终端 ② 工作台终端（省钱模式下为 CloudShell 启动卡片）③ AWS 控制台 ④ 应用预览。
 * 真正的 tablist（`aria-selected`、`aria-controls`，方向键切换）；切换只改可见性（hidden），不卸载组件，WebSocket 不断开，iframe 保留。
 * 助教、观察者：终端与控制台显示“只读：你的角色不能连接终端或控制台”，预览可看（不显示“管理员账号”）。
 * 拆分（P2）暂不提供：按钮置灰并说明。
 */
import type { KeyboardEvent, RefObject } from 'react';
import { Button, Icon, Shape, type IconName } from '../../ui';
import { ConsoleLauncher, type ConsoleOpener } from '../console/ConsoleLauncher';
import { useWorkspace } from '../context';
import type { PanelId } from '../model/lab';
import { PreviewFrame } from '../preview/PreviewFrame';
import { TerminalPane, type TerminalPaneHandle } from '../terminal/TerminalPane';
import type { TermPhase, TermTarget } from '../terminal/controller';

import { t as tr } from '../../i18n';
import { W } from '../strings';
const WR = W.right;
const tabMeta = (id: PanelId, icon: IconName) => ({
  icon,
  get text() {
    return WR.tab[id];
  },
  get short() {
    return WR.tabShort[id];
  },
});

export const TAB_META: Readonly<Record<PanelId, { icon: IconName; readonly text: string; readonly short: string }>> = {
  'terminal-lab': tabMeta('terminal-lab', 'term'),
  'terminal-workstation': tabMeta('terminal-workstation', 'term'),
  console: tabMeta('console', 'ext'),
  preview: tabMeta('preview', 'preview'),
};

export const TABS: readonly PanelId[] = ['terminal-lab', 'terminal-workstation', 'console', 'preview'];

export interface RightPaneProps {
  tab: PanelId;
  onTab: (t: PanelId) => void;
  flash: PanelId | null;
  started: ReadonlySet<TermTarget>;
  labRef: RefObject<TerminalPaneHandle>;
  wsRef: RefObject<TerminalPaneHandle>;
  consoleOpener: ConsoleOpener;
  fontSize: number;
  screenReaderMode: boolean;
  narrow: boolean;
  segmented: boolean;
  onCommandFinished: (which: TermTarget, exitCode: number | null) => void;
  /** 当前子标签的连接状态（标签上的形状 + 文字）。 */
  termStatus: Readonly<Record<TermTarget, TermPhase | null>>;
  onTermStatus: (which: TermTarget, phase: TermPhase | null) => void;
}

function TermState({ phase, started }: { phase: TermPhase | null; started: boolean }) {
  const m =
    phase === 'ready'
      ? { cls: 'pass', shape: 'dot' as const, text: WR.connected }
      : phase === 'reconnecting'
        ? { cls: 'pend', shape: 'retry' as const, text: WR.reconnecting }
        : phase === 'blocked' || phase === 'failed'
          ? { cls: 'fail', shape: 'xbox' as const, text: WR.unavailable }
          : started && phase && phase !== 'closed'
            ? { cls: 'pend', shape: 'clock' as const, text: WR.connecting }
            : { cls: 'faint', shape: 'ring' as const, text: WR.disconnected };
  return (
    <span className={`st ${m.cls}`}>
      <Shape name={m.shape} />
      <span className="sr">{m.text}</span>
    </span>
  );
}

export function RightPane(p: RightPaneProps) {
  const ws = useWorkspace();
  const sel = p.tab;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.indexOf(sel);
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    p.onTab(TABS[n]!);
    (document.getElementById(`tab-${TABS[n]}`) as HTMLElement | null)?.focus();
  };
  const readOnly = !ws.learner;
  const cloudshell = ws.data.workspace.data?.features?.workstation === 'cloudshell';
  return (
    <section className="rpane" aria-label={WR.region} data-rpane="">
      <div className="rtabs" role="tablist" aria-label={WR.tabs} onKeyDown={onKey}>
        {TABS.map((t) => {
          const meta = TAB_META[t];
          const which: TermTarget | null = t === 'terminal-lab' ? 'lab' : t === 'terminal-workstation' ? 'workstation' : null;
          return (
            <button
              key={t}
              id={`tab-${t}`}
              type="button"
              role="tab"
              aria-selected={sel === t}
              aria-controls={`panel-${t}`}
              tabIndex={sel === t ? 0 : -1}
              className={p.flash === t ? 'flash' : undefined}
              onClick={() => p.onTab(t)}
              data-tab={t}
            >
              <Icon name={meta.icon} />
              <span className="lt">{meta.text}</span>
              <span className="st-short" aria-hidden="true">
                {meta.short}
              </span>
              {which && !readOnly && ws.live && !(which === 'workstation' && cloudshell) ? <TermState phase={p.termStatus[which]} started={p.started.has(which)} /> : null}
              {t === 'console' ? <span className="sr">{WR.newTab}</span> : null}
            </button>
          );
        })}
        <span className="spacer" />
        <button type="button" className="btn sm ghost lt" aria-disabled="true" title={WR.splitNA}>
          <Icon name="split" />
          <span className="lt">{WR.split}</span>
        </button>
      </div>
      {TABS.map((t) => (
        <div key={t} className="rpanel" role="tabpanel" id={`panel-${t}`} aria-labelledby={`tab-${t}`} hidden={sel !== t} data-panel={t}>
          {t === 'terminal-lab' || t === 'terminal-workstation' ? (
            readOnly ? (
              <ReadOnlyNotice />
            ) : t === 'terminal-workstation' && cloudshell ? (
              <CloudShellCard opener={p.consoleOpener} />
            ) : (
              <TerminalPane
                which={t === 'terminal-lab' ? 'lab' : 'workstation'}
                visible={sel === t}
                started={p.started.has(t === 'terminal-lab' ? 'lab' : 'workstation')}
                fontSize={p.fontSize}
                screenReaderMode={p.screenReaderMode}
                onCommandFinished={p.onCommandFinished}
                onStatus={p.onTermStatus}
                handleRef={t === 'terminal-lab' ? p.labRef : p.wsRef}
              />
            )
          ) : t === 'console' ? (
            readOnly ? (
              <ReadOnlyNotice />
            ) : (
              <ConsoleLauncher opener={p.consoleOpener} />
            )
          ) : (
            <PreviewFrame active={sel === 'preview'} narrow={p.narrow} />
          )}
        </div>
      ))}
    </section>
  );
}

function ReadOnlyNotice() {
  const ws = useWorkspace();
  return (
    <div className="empty ro-empty">
      <Icon name="lock" />
      <b>{WR.readOnly}</b>
      <span className="small">{tr(WR.readOnlyText, { extra: ws.role === 'A' ? WR.readOnlyAssistant : '' })}</span>
    </div>
  );
}

/** 省钱模式（03 §4.9）：工作台终端改为 CloudShell。引导环境变量的接口未登记（§9.2 #29），只给复制命令。 */
function CloudShellCard({ opener }: { opener: ConsoleOpener }) {
  return (
    <div className="cpane stack">
      <div className="box stack-8">
        <b>{WR.cloudshell}</b>
        <p className="small">{WR.cloudshellText}</p>
        <p className="small muted">{WR.cloudshellExp}</p>
        <div className="row">
          <Button variant="primary" icon="ext" onClick={() => opener.open()}>
            {WR.openConsole}
          </Button>
        </div>
      </div>
    </div>
  );
}
