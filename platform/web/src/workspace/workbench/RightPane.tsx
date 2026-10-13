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

export const TAB_META: Readonly<Record<PanelId, { icon: IconName; text: string; short: string }>> = {
  'terminal-lab': { icon: 'term', text: '实验机', short: '实验机' },
  'terminal-workstation': { icon: 'term', text: '工作台', short: '工作台' },
  console: { icon: 'ext', text: 'AWS 控制台', short: '控制台' },
  preview: { icon: 'preview', text: '应用预览', short: '预览' },
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
      ? { cls: 'pass', shape: 'dot' as const, text: '已连接' }
      : phase === 'reconnecting'
        ? { cls: 'pend', shape: 'retry' as const, text: '重连中' }
        : phase === 'blocked' || phase === 'failed'
          ? { cls: 'fail', shape: 'xbox' as const, text: '不可用' }
          : started && phase && phase !== 'closed'
            ? { cls: 'pend', shape: 'clock' as const, text: '连接中' }
            : { cls: 'faint', shape: 'ring' as const, text: '断开' };
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
    <section className="rpane" aria-label="终端、控制台与预览" data-rpane="">
      <div className="rtabs" role="tablist" aria-label="右侧标签" onKeyDown={onKey}>
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
              {t === 'console' ? <span className="sr">（新标签页打开）</span> : null}
            </button>
          );
        })}
        <span className="spacer" />
        <button type="button" className="btn sm ghost lt" aria-disabled="true" title="拆分右栏暂不提供">
          <Icon name="split" />
          <span className="lt">拆分</span>
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
      <b>只读：你的角色不能连接终端或控制台</b>
      <span className="small">助教与观察者永远拿不到 AWS 凭证。可以在手册中查看检测结果{ws.role === 'A' ? '、运行检测并复核手动确认' : ''}。</span>
    </div>
  );
}

/** 省钱模式（03 §4.9）：工作台终端改为 CloudShell。引导环境变量的接口未登记（§9.2 #29），只给复制命令。 */
function CloudShellCard({ opener }: { opener: ConsoleOpener }) {
  return (
    <div className="cpane stack">
      <div className="box stack-8">
        <b>CloudShell（省钱模式）</b>
        <p className="small">本次实验没有启动工作台实例。工作台命令请在 AWS CloudShell 中执行：先打开控制台，再从控制台顶栏打开 CloudShell。手册中工作台命令的“粘贴”改为“复制”。</p>
        <p className="small muted">省钱模式下对比实验结果无法上传，相关检查只能按规则降级。</p>
        <div className="row">
          <Button variant="primary" icon="ext" onClick={() => opener.open()}>
            在新标签页打开 AWS 控制台
          </Button>
        </div>
      </div>
    </div>
  );
}
