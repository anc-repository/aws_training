/**
 * 终端标签 TerminalPane（08 P05.6、§5.3 TerminalTab / TerminalView / IdentityChip；03 §2.5、§3.7.4、§3.9、§8.6）：
 *
 * - 子标签 `#1 #2 +`（每个对应一个 SSM 会话；同一实例最多 3 个，整个会话最多 6 个，`429 TERMINAL_LIMIT`）；
 * - 身份条：主机角色 + 实例 ID（缩写，悬停全名）+ Linux 用户 + “AWS 身份”（实验机 CloudAlbumAppRole，工作台 ATLLearnerRole（atl-<sid>-ws））；
 * - 覆盖层：连接中、Agent 不在线、平台准备未完成、权限不足、文档不存在、握手超时、重连中（第 n/5 次）、空闲断开、达到最长时长、
 *   实例已替换、预期中断、需要重新登录、访问已收回、会话已结束；
 * - 状态栏“● 已连接 · Session Manager · 空闲 20 分钟断开”，录制提示、tmux 提示，常驻“按 Ctrl+. 再按 M 回到手册”（触屏隐藏）；
 * - < 768px 时附加按键条（Esc Tab Ctrl Alt ↑ ↓ ← → | ~ / - 粘贴，每个 ≥ 44×44px，Ctrl 粘滞）。
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServices } from '../../app/context';
import { isLocalDevHost } from '../../auth/config';
import { announce } from '../../lib/announce';
import { formatClock } from '../../lib/format';
import { Button, Disclosure, Icon, Shape } from '../../ui';
import { useWorkspace } from '../context';
import type { WorkspaceTarget } from '../data/types';
import { TerminalController, overlayOf, type TermPhase, type TermSnapshot, type TermTarget } from './controller';
import { TerminalView, type TermHandle } from './TerminalView';

import { rich, t } from '../../i18n';
import { W } from '../strings';
export const MAX_PER_INSTANCE = 3;

export interface TerminalPaneHandle {
  /** 当前子标签的控制器（没有时新开一个）。 */
  active(): TerminalController;
  /** 在新的终端子标签中粘贴。 */
  newSubTab(): TerminalController | null;
  focus(): void;
  bracketedPaste(): boolean;
  tmux: boolean;
  /** 子标签编号（播报“已粘贴到 工作台终端 #1”）。 */
  activeNo(): number;
  revokeAll(): void;
}

interface Sub {
  no: number;
  ctl: TerminalController;
  name: string | null;
  /** 打开时工作台描述中的目标实例（之后描述里的实例变了 = 实例已替换）。 */
  targetAtOpen: string | null;
}

const WT = W.terminal;
const HOST_TEXT: Readonly<Record<TermTarget, string>> = WT.host;

function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

export function targetOf(targets: readonly WorkspaceTarget[] | undefined, which: TermTarget): WorkspaceTarget | null {
  const list = targets ?? [];
  if (which === 'lab') return list.find((t) => (t.tab === 'terminal-lab' || t.role === 'lab-app') && t.primary) ?? list.find((t) => t.tab === 'terminal-lab' || t.role === 'lab-app') ?? null;
  return list.find((t) => t.tab === 'terminal-workstation' || t.role === 'workstation') ?? null;
}

export function TerminalPane({
  which,
  visible,
  started,
  fontSize,
  screenReaderMode,
  onCommandFinished,
  onStatus,
  handleRef,
}: {
  which: TermTarget;
  visible: boolean;
  /** 首次打开（自动连接）后为 true；之前不创建会话。 */
  started: boolean;
  fontSize: number;
  screenReaderMode: boolean;
  onCommandFinished: (which: TermTarget, exitCode: number | null) => void;
  onStatus?: (which: TermTarget, phase: TermPhase | null) => void;
  handleRef: Ref<TerminalPaneHandle>;
}) {
  const ws = useWorkspace();
  const { api, config, clock } = useServices();
  const desc = ws.data.workspace.data;
  const target = targetOf(desc?.targets, which);
  const devLoopback = config.auth === 'dev' && typeof location !== 'undefined' && isLocalDevHost(location.hostname);
  const region = (desc?.region ?? (ws.data.vars.data?.session?.region as string | undefined)) || null;
  const seq = useRef(0);
  const targetIdRef = useRef<string | null>(target?.instanceId ?? null);
  targetIdRef.current = target?.instanceId ?? null;
  const finishedRef = useRef(onCommandFinished);
  finishedRef.current = onCommandFinished;
  const make = useCallback(
    (): Sub => {
      const no = ++seq.current;
      return {
        no,
        name: null,
        targetAtOpen: targetIdRef.current,
        ctl: new TerminalController({
          api,
          sid: ws.sid,
          target: which,
          instanceId: target?.instanceId ?? null,
          region,
          allowLoopback: devLoopback,
          clock,
          report: (type, data) => ws.reporter?.push(type, data),
          onCommandFinished: (ec) => finishedRef.current(which, ec),
        }),
      };
    },
    // 实例被替换时由覆盖层“连接新实验机”重新创建，不随 target 自动重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, clock, ws.sid, which, region, devLoopback],
  );
  const [subs, setSubs] = useState<Sub[]>([]);
  const [cur, setCur] = useState(0);
  const subsRef = useRef(subs);
  subsRef.current = subs;
  const curRef = useRef(cur);
  curRef.current = cur;
  const handles = useRef(new Map<number, TermHandle | null>());

  // 首次打开时自动连接（ref 守卫：StrictMode 下效果执行两次也只开一个）
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!started || autoStarted.current || subsRef.current.length || !ws.live) return;
    autoStarted.current = true;
    const s = make();
    setSubs([s]);
    setCur(s.no);
    void s.ctl.open();
  }, [started, ws.live, make]);

  // 卸载：关闭全部连接并尽力结束 SSM 会话；页面关闭 / 刷新时同样尽力结束（03 §3.5.9）
  useEffect(() => {
    const onHide = () => {
      for (const s of subsRef.current) s.ctl.dispose();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      for (const s of subsRef.current) s.ctl.dispose();
    };
  }, []);

  // 访问被收回 / 会话离开可发放访问的状态：立即断开（不再调用终端接口）；只是到了截止时间时由覆盖层设为只读，等收回事件
  useEffect(() => {
    if (ws.accessRevoked) for (const s of subsRef.current) s.ctl.revoke();
  }, [ws.accessRevoked]);

  const addSub = useCallback((): Sub | null => {
    if (subsRef.current.filter((s) => s.ctl.getSnapshot().phase !== 'closed').length >= MAX_PER_INSTANCE) {
      announce(WT.limitPerInstance);
      return null;
    }
    const s = make();
    setSubs((l) => [...l, s]);
    setCur(s.no);
    void s.ctl.open();
    return s;
  }, [make]);

  const closeSub = (no: number) => {
    const s = subsRef.current.find((x) => x.no === no);
    void s?.ctl.end();
    setSubs((l) => l.filter((x) => x.no !== no));
    if (curRef.current === no) setCur(subsRef.current.find((x) => x.no !== no)?.no ?? 0);
  };

  const tmux = desc?.features?.terminalPersistence === 'tmux';
  // 标签上的连接状态：订阅当前子标签的控制器
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const activeCtl = (subs.find((s) => s.no === cur) ?? subs[0])?.ctl ?? null;
  useEffect(() => {
    if (!activeCtl) {
      statusRef.current?.(which, null);
      return undefined;
    }
    const push = () => statusRef.current?.(which, activeCtl.getSnapshot().phase);
    push();
    return activeCtl.subscribe(push);
  }, [activeCtl, which]);
  useImperativeHandle(
    handleRef,
    (): TerminalPaneHandle => ({
      active: () => {
        const s = subsRef.current.find((x) => x.no === curRef.current) ?? subsRef.current[0];
        if (s) return s.ctl;
        const n = make();
        setSubs([n]);
        setCur(n.no);
        void n.ctl.open();
        return n.ctl;
      },
      newSubTab: () => addSub()?.ctl ?? null,
      focus: () => (subsRef.current.find((x) => x.no === curRef.current) ?? subsRef.current[0])?.ctl.focus(),
      bracketedPaste: () => (subsRef.current.find((x) => x.no === curRef.current) ?? subsRef.current[0])?.ctl.bracketedPaste ?? false,
      tmux,
      activeNo: () => curRef.current || 1,
      revokeAll: () => {
        for (const s of subsRef.current) s.ctl.revoke();
      },
    }),
    [make, addSub, tmux],
  );

  // ---- 不提供终端的状态（08 P05.12）
  if (!ws.live) return <NoTerminal which={which} />;

  const active = subs.find((s) => s.no === cur) ?? subs[0] ?? null;
  const identity = which === 'lab' ? (target?.awsIdentity ?? 'CloudAlbumAppRole') : (target?.awsIdentity ?? `ATLLearnerRole（atl-${ws.sid}-ws）`);
  const onSubKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = subs.findIndex((s) => s.no === cur);
    const n = subs[(i + (e.key === 'ArrowRight' ? 1 : -1) + subs.length) % subs.length];
    if (n) {
      setCur(n.no);
      (e.currentTarget.querySelector(`[data-sub="${n.no}"]`) as HTMLElement | null)?.focus();
    }
  };
  return (
    <div className="tpane" data-terminal={which}>
      <div className={which === 'lab' ? 'idchip lab' : 'idchip'}>
        <span>▣ {HOST_TEXT[which]}</span>
        <span title={target?.instanceId ?? undefined} className="mono">
          {shortId(active?.ctl.getSnapshot().instanceId ?? target?.instanceId)}
        </span>
        <span className="who">
          {t(WT.awsIdentity, { user: active?.ctl.getSnapshot().runAs ?? target?.runAs ?? 'labuser', identity })}
        </span>
        <span className="sr">{which === 'lab' ? WT.labIdentityNote : ''}</span>
        <div className="subtabs" role="tablist" aria-label={t(WT.subtabs, { host: HOST_TEXT[which] })} onKeyDown={onSubKey}>
          {subs.map((s) => (
            <button
              key={s.no}
              type="button"
              role="tab"
              data-sub={s.no}
              aria-selected={s.no === (active?.no ?? 0)}
              aria-controls={`term-${which}-${s.no}`}
              tabIndex={s.no === (active?.no ?? 0) ? 0 : -1}
              onClick={() => setCur(s.no)}
            >
              #{s.no}
            </button>
          ))}
          <button type="button" aria-label={WT.newTerminal} onClick={() => addSub()} disabled={subs.length >= MAX_PER_INSTANCE} title={subs.length >= MAX_PER_INSTANCE ? WT.limitPerInstance : undefined}>
            +
          </button>
        </div>
        {active ? (
          <Disclosure label={<Icon name="dots" />} ariaLabel={WT.menu} buttonClassName="btn sm ghost icon termmenu">
            {(close) => (
              <>
                <button
                  type="button"
                  className="mi"
                  onClick={() => {
                    close();
                    const sel = handles.current.get(active.no)?.term.getSelection?.() ?? '';
                    if (sel) void navigator.clipboard?.writeText(sel).then(() => announce(WT.copiedSelection));
                    else announce(WT.noSelection);
                  }}
                >
                  {WT.copySelection}
                </button>
                <button
                  type="button"
                  className="mi"
                  onClick={() => {
                    close();
                    handles.current.get(active.no)?.term.clear?.();
                  }}
                >
                  {WT.clear}
                </button>
                <button
                  type="button"
                  className="mi"
                  onClick={() => {
                    close();
                    addSub();
                  }}
                >
                  {WT.openInNewSub}
                </button>
                <button
                  type="button"
                  className="mi"
                  onClick={() => {
                    close();
                    closeSub(active.no);
                  }}
                >
                  {WT.endSession}
                </button>
              </>
            )}
          </Disclosure>
        ) : null}
      </div>
      <div className="term-stack">
        {subs.map((s) => (
          <SubTerminal
            key={s.no}
            sub={s}
            which={which}
            visible={visible && s.no === (active?.no ?? 0)}
            fontSize={fontSize}
            screenReaderMode={screenReaderMode}
            replaced={!!target?.instanceId && !!s.targetAtOpen && target.instanceId !== s.targetAtOpen}
            newInstance={target?.instanceId ?? null}
            onHandle={(h) => handles.current.set(s.no, h)}
            onReplace={() => {
              closeSub(s.no);
              addSub();
            }}
          />
        ))}
        {!subs.length ? (
          <div className="term blank">
            <div className="ovl">
              <div className="ob">
                <b>{WT.notOpened}</b>
                <Button size="sm" onClick={() => addSub()}>
                  {WT.open}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {active ? <KeyBar ctl={active.ctl} /> : null}
      {active ? <StatusLine ctl={active.ctl} tmux={tmux} recording={desc?.features?.terminalRecording ?? 'off'} /> : null}
    </div>
  );
}

function SubTerminal({
  sub,
  which,
  visible,
  fontSize,
  screenReaderMode,
  replaced,
  newInstance,
  onHandle,
  onReplace,
}: {
  sub: Sub;
  which: TermTarget;
  visible: boolean;
  fontSize: number;
  screenReaderMode: boolean;
  replaced: boolean;
  newInstance: string | null;
  onHandle: (h: TermHandle | null) => void;
  onReplace: () => void;
}) {
  const s = useSyncExternalStore(sub.ctl.subscribe, sub.ctl.getSnapshot);
  const label = t(WT.termLabel, { host: HOST_TEXT[which], no: sub.no, instance: s.instanceId ?? WT.unknownInstance, user: s.runAs ?? 'labuser' });
  return (
    <div className="term" id={`term-${which}-${sub.no}`} role="tabpanel" hidden={!visible} data-phase={s.phase}>
      <TerminalView controller={sub.ctl} label={label} fontSize={fontSize} screenReaderMode={screenReaderMode} visible={visible} onHandle={onHandle} />
      <Overlay snap={s} ctl={sub.ctl} which={which} replaced={replaced} newInstance={newInstance} onReplace={onReplace} />
    </div>
  );
}

function Overlay({ snap, ctl, which, replaced, newInstance, onReplace }: { snap: TermSnapshot; ctl: TerminalController; which: TermTarget; replaced: boolean; newInstance: string | null; onReplace: () => void }) {
  const ws = useWorkspace();
  const { api } = useServices();
  const navigate = useNavigate();
  const outage = !!ws.outage && (ws.outage.channel === null || ws.outage.channel === which || ws.outage.channel === 'lab');
  const kind = overlayOf(snap, { expectedOutage: outage && which === 'lab', replaced });
  // 平台准备未完成：自动轮询（每 15 秒重试）
  useEffect(() => {
    if (kind !== 'not-prepared' && kind !== 'expected-outage') return undefined;
    const t = setInterval(() => {
      if (!document.hidden) void ctl.open();
    }, 15_000);
    return () => clearInterval(t);
  }, [kind, ctl]);
  const [repairing, setRepairing] = useState(false);
  if (!kind) return null;
  const host = HOST_TEXT[which];
  const diag = `sessionId=${ws.sid}\ntarget=${which}\ncode=${snap.error?.code ?? snap.reason ?? ''}\nrequestId=${snap.error?.requestId ?? ''}\nmessage=${snap.error?.message ?? ''}`;
  const body = (() => {
    switch (kind) {
      case 'connecting':
        return { title: WT.connecting, text: null, actions: null };
      case 'agent-offline':
        return {
          title: t(WT.agentOffline, { host }),
          text: WT.agentOfflineText,
          actions: (
            <>
              <Button size="sm" onClick={() => void ctl.open()}>
                {WT.retry}
              </Button>
              <details className="small">
                <summary>{WT.troubleshoot}</summary>
                <ol className="mlist">
                  <li>{WT.ts1}</li>
                  <li>{WT.ts2}</li>
                  <li>{WT.ts3}</li>
                </ol>
              </details>
              {ws.learner && ws.view.env?.envId ? (
                <Button
                  size="sm"
                  busy={repairing}
                  onClick={async () => {
                    setRepairing(true);
                    try {
                      await api.call('repairEnvironment', { params: { envId: ws.view.env!.envId }, body: {} });
                      announce(WT.repairRequested);
                    } catch {
                      announce(WT.repairFailed);
                    } finally {
                      setRepairing(false);
                    }
                  }}
                >
                  {WT.repair}
                </Button>
              ) : null}
            </>
          ),
        };
      case 'not-prepared':
        return { title: t(WT.notPrepared, { host }), text: WT.autoRetry, actions: null };
      case 'access-denied':
        return { title: WT.accessDenied, text: WT.accessDeniedText, actions: <CopyDiag text={diag} /> };
      case 'invalid-document':
        return { title: WT.invalidDocument, text: WT.invalidDocumentText, actions: null };
      case 'handshake-timeout':
        return {
          title: t(WT.noResponse, { host }),
          text: null,
          actions: (
            <Button size="sm" onClick={() => void ctl.open()}>
              {WT.reconnect}
            </Button>
          ),
        };
      case 'reconnecting':
        return {
          title: t(WT.reconnecting, { n: Math.max(1, snap.attempt), max: snap.maxAttempts }),
          text: null,
          actions: (
            <Button size="sm" onClick={() => ctl.retryNow()}>
              {WT.retryNow}
            </Button>
          ),
        };
      case 'idle':
        return {
          title: t(WT.idle, { n: snap.idleTimeoutMin ?? 20 }),
          text: null,
          actions: (
            <Button size="sm" onClick={() => void ctl.open()}>
              {WT.reconnect}
            </Button>
          ),
        };
      case 'max-duration':
        return {
          title: t(WT.maxDuration, { n: Math.round((snap.maxDurationMin ?? 240) / 60) }),
          text: null,
          actions: (
            <Button size="sm" onClick={() => void ctl.open()}>
              {WT.newTerminal}
            </Button>
          ),
        };
      case 'replaced':
        return {
          title: t(WT.replaced, { host, from: shortId(snap.instanceId), to: shortId(newInstance) }),
          text: WT.replacedText,
          actions: (
            <Button size="sm" onClick={onReplace}>
              {t(WT.connectNew, { host })}
            </Button>
          ),
        };
      case 'expected-outage':
        return {
          title: WT.expectedOutage,
          text: t(WT.expectedOutageText, { until: ws.outage ? t(WT.expectedOutageUntil, { t: formatClock(ws.outage.until) }) : '' }),
          actions: null,
        };
      case 'reauth':
        return {
          title: WT.reauth,
          text: WT.reauthText,
          actions: (
            <Button size="sm" onClick={() => void ctl.open()}>
              {WT.signInAgain}
            </Button>
          ),
        };
      case 'revoked':
        return {
          title: WT.revoked,
          text: WT.revokedText,
          actions: (
            <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end`)}>
              {WT.viewReclaim}
            </Button>
          ),
        };
      case 'limit':
        return { title: WT.limit, text: WT.limitText, actions: null };
      case 'unavailable':
        return {
          title: WT.unavailable,
          text: snap.error?.code === 'CLIENT_UNAVAILABLE' ? WT.clientUnavailable : WT.notProvided,
          actions: (
            <Button size="sm" onClick={() => void ctl.open()}>
              {WT.retry}
            </Button>
          ),
        };
      case 'closed':
        return {
          title: snap.reason === 'gone' ? WT.gone : WT.closed,
          text: snap.closedOutput,
          actions: (
            <Button size="sm" onClick={() => void ctl.open()}>
              {WT.reconnect}
            </Button>
          ),
        };
      default:
        return {
          title: WT.failed,
          text: snap.error?.message ?? null,
          actions: (
            <>
              <Button size="sm" onClick={() => void ctl.open()}>
                {WT.reconnect}
              </Button>
              <CopyDiag text={diag} />
            </>
          ),
        };
    }
  })();
  return (
    <div className="ovl" data-overlay={kind}>
      <div className="ob" role={kind === 'revoked' ? 'alert' : 'status'}>
        {kind === 'connecting' || kind === 'reconnecting' ? <Shape name="spin" spin /> : null}
        <b>{body.title}</b>
        {body.text ? <span>{body.text}</span> : null}
        {body.actions ? <div className="row">{body.actions}</div> : null}
      </div>
    </div>
  );
}

function CopyDiag({ text }: { text: string }) {
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          announce(WT.copiedDiag);
        } catch {
          announce(WT.clipboardDenied);
        }
      }}
    >
      {WT.copyDiag}
    </Button>
  );
}

function StatusLine({ ctl, tmux, recording }: { ctl: TerminalController; tmux: boolean; recording: string }) {
  const s = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot);
  const ok = s.phase === 'ready';
  const meta = ok
    ? { cls: 'pass', shape: 'dot' as const, text: WT.connected }
    : s.phase === 'reconnecting'
      ? { cls: 'pend', shape: 'retry' as const, text: WT.reconnectingShort }
      : s.phase === 'connecting' || s.phase === 'requesting' || s.phase === 'handshaking'
        ? { cls: 'pend', shape: 'clock' as const, text: WT.connectingShort }
        : { cls: 'faint', shape: 'ring' as const, text: WT.disconnected };
  return (
    <div className="tstatus">
      <span className={`st ${meta.cls}`} aria-live="polite">
        <Shape name={meta.shape} />
        <span className="t">{meta.text}</span>
      </span>
      <span>{t(WT.idleNote, { n: s.idleTimeoutMin ?? 20 })}</span>
      {s.busy && !tmux ? <span className="small">{WT.busy}</span> : null}
      {tmux ? <span className="small">{WT.tmuxNote}</span> : null}
      {recording !== 'off' ? <span className="small">{WT.recording}</span> : null}
      <span className="spacer" />
      <span className="kbd-hint">
        {rich(WT.backToManual, { ctrl: <kbd>Ctrl</kbd>, dot: <kbd>.</kbd>, m: <kbd>M</kbd> })}
      </span>
    </div>
  );
}

const KEYS: readonly [string, string][] = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['Ctrl', ''],
  ['Alt', ''],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['|', '|'],
  ['~', '~'],
  ['/', '/'],
  ['-', '-'],
];

/** 附加按键条（< 768px，03 §8.6）：Ctrl 粘滞——再按一个字母生成控制字符。 */
function KeyBar({ ctl }: { ctl: TerminalController }) {
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  useEffect(() => {
    if (!ctrl && !alt) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.length !== 1) return;
      e.preventDefault();
      const ch = e.key;
      if (ctrl) ctl.sendRaw(String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f));
      else ctl.sendRaw(`\x1b${ch}`);
      setCtrl(false);
      setAlt(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctrl, alt, ctl]);
  const keys = useMemo(() => KEYS, []);
  return (
    <div className="keybar" aria-label={WT.keybar}>
      {keys.map(([k, seq]) =>
        k === 'Ctrl' ? (
          <button key={k} type="button" aria-pressed={ctrl} onClick={() => setCtrl((x) => !x)}>
            Ctrl
          </button>
        ) : k === 'Alt' ? (
          <button key={k} type="button" aria-pressed={alt} onClick={() => setAlt((x) => !x)}>
            Alt
          </button>
        ) : (
          <button key={k} type="button" onClick={() => ctl.sendRaw(seq)} aria-label={k === '|' ? WT.key.pipe : k === '~' ? WT.key.tilde : k === '/' ? WT.key.slash : k === '-' ? WT.key.minus : k}>
            {k}
          </button>
        ),
      )}
      <button
        type="button"
        onClick={async () => {
          try {
            const t = await navigator.clipboard.readText();
            if (t) ctl.paste(t);
          } catch {
            announce(WT.readClipboardFailed);
          }
        }}
      >
        {WT.paste}
      </button>
    </div>
  );
}

/** 不提供终端的状态（KEPT、CLEANUP_FAILED、FAILED、ENDED、ENDING、CLEANING）。 */
function NoTerminal({ which }: { which: TermTarget }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const st = ws.view.state;
  const list = (ws.data.workspace.data?.terminals ?? []).filter((t) => (t.target ?? (t.tab === 'terminal-lab' ? 'lab' : t.tab === 'terminal-workstation' ? 'workstation' : null)) === which || !t.target);
  if (st === 'ENDED') {
    return (
      <div className="term blank">
        <div className="ovl">
          <div className="ob">
            <b>{WT.endedNoConnect}</b>
            {list.length ? (
              <>
                <span>{WT.openedList}</span>
                <ul className="small mlist mono">
                  {list.map((t, i) => (
                    <li key={t.terminalId}>
                      #{i + 1} · {shortId(t.ssmSessionId ?? t.terminalId)} · {t.openedAt ? formatClock(t.openedAt) : '—'} · {t.status === 'OPEN' ? WT.statusOpen : WT.statusClosed}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <span>{t(WT.noneOpened, { host: HOST_TEXT[which] })}</span>
            )}
            {ws.view.readyAt ? (
              <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/report`)}>
                {WT.viewReport}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  const winding = st === 'ENDING' || st === 'CLEANING' || st === 'READY' || st === 'RUNNING' || st === 'EXPIRING';
  return (
    <div className="term blank">
      <div className="ovl">
        <div className="ob" role={winding ? 'alert' : undefined}>
          <b>{winding ? WT.revoked : WT.notInState}</b>
          <span>
            {winding
              ? WT.revokedText
              : st === 'KEPT'
                ? WT.keptNote
                : st === 'REQUESTED' || st === 'PROVISIONING'
                  ? WT.afterReady
                  : WT.ended}
          </span>
          {st !== 'REQUESTED' && st !== 'PROVISIONING' ? (
            <Button size="sm" onClick={() => navigate(`/sessions/${ws.sid}/end${st === 'CLEANUP_FAILED' ? '#manual' : ''}`)}>
              {st === 'KEPT' ? WT.manageKeep : WT.viewReclaim}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
