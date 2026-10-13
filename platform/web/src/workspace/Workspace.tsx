/**
 * `/workspace/:sid` 的画面主体：P04 准备模式与 P05 分屏工作台（08 P04、P05；03 全文）。按会话状态渲染（§2.4 表 2，workspaceRender）：
 *
 * ┌ SessionBar ───────────────────────────────────────────────────────────────┐
 * ├ 横幅（T-15、保留中、释放未完成、环境异常、平台动作、提交结果……）───────────────┤
 * ├ 分段控件（< 1024px：[手册] [实验机] [工作台] [控制台] [预览]；P04：[进度] [手册]）┤
 * │ 手册 ManualPane │┃│ 右栏：四个标签（P05）/ 准备进度、失败面板、补偿进度（P04） │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 这里实现 03 §2.1 的 Workbench 上下文（focusTab / pasteToTerminal / openConsole / runStepCheck……）、前导键 Ctrl+.（03 §8.2）、
 * 分隔条与窄屏分段（P05.10）、T-5 提醒与到期覆盖层（P05.9）、心跳（每个可见的工作台标签页各自发送，§7.2 第 9 条）、工作台事件上报（03 §7.4）、
 * 证据抽屉 `?check=` 与对比实验抽屉 `?exp=`（§2.5：抽屉写进查询串，对话框不写）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { WorkbenchHeartbeat } from '../api/heartbeat';
import type { SessionEvent, SessionView } from '../api/types';
import { useAuth, useServices, useSessionEvents } from '../app/context';
import { useGlobalStatus } from '../app/globalStatus';
import { allowedActionsOf, workspaceRender } from '../app/sessionRouting';
import { announce } from '../lib/announce';
import { copyText } from '../lib/clipboard';
import { Shape } from '../ui';
import { useConsoleOpener } from './console/ConsoleLauncher';
import { WorkbenchContext, WorkspaceContext, type CommandFinished, type Guardrails, type OutageWindow, type PasteMeta, type Workbench, type WorkspaceCtx } from './context';
import { useWorkspaceData } from './data/useWorkspaceData';
import { ExperimentCompareDrawer } from './experiments/ExperimentCompare';
import { CheckDrawer } from './manual/CheckDrawer';
import { CheckRunner } from './manual/checkRunner';
import { ManualConfirmDialog } from './manual/ManualConfirmDialog';
import { ManualPane } from './manual/ManualPane';
import { SubmitDialog } from './manual/SubmitDialog';
import type { VariableStripHandle } from './manual/VariableStrip';
import { actionableState, extendBlock, EXTEND_REASON_TEXT, shouldOpenT5, showExpiredOverlay, t5Key } from './model/expiry';
import { defaultPanelOf, PANELS, type PanelId } from './model/lab';
import { breakpointOf, clampSplit, defaultSplitPct, isSegmented, keyStep, loadLayout, saveLayout } from './model/layout';
import { evaluatePaste, normalizePasteText, precheckPaste, sha256Hex, TARGET_TEXT, type PasteRejection, type TerminalTarget } from './model/paste';
import { ProvisionPanel, ReadyFlash } from './provision/ProvisionPanel';
import { CredentialRevealDialog } from './preview/PreviewFrame';
import type { TermPhase, TermTarget } from './terminal/controller';
import { targetOf, type TerminalPaneHandle } from './terminal/TerminalPane';
import { EndDialog } from './timer/EndDialog';
import { ExtendDialog } from './timer/ExtendDialog';
import { CancelDialog, ExpiredOverlay, ExpiryDialog } from './timer/SessionDialogs';
import { WorkspaceBanners } from './workbench/Banners';
import { CostDrawer, LEADER_TEXT, loadTermPrefs, ShortcutsDialog, TermSettingsDialog, type TermPrefs } from './workbench/Panels';
import { PasteConfirmDialog, PasteRejectDialog, type ConfirmChoice, type ConfirmRequest } from './workbench/PasteDialogs';
import { WorkspaceReporter } from './workbench/reporter';
import { RightPane, TAB_META } from './workbench/RightPane';
import { SessionBar } from './workbench/SessionBar';
import { Splitter } from './workbench/Splitter';
import './workspace.css';

type Dlg =
  | { kind: 'extend' }
  | { kind: 'end'; when: 'now' | 'at-expiry' }
  | { kind: 'cancel' }
  | { kind: 'submit' }
  | { kind: 'manual'; stepId: string; checkId: string }
  | { kind: 'shortcuts' }
  | { kind: 'term' }
  | { kind: 'cred' }
  | { kind: 'cost' }
  | { kind: 't5' }
  | { kind: 'paste-confirm'; req: ConfirmRequest; resolve: (c: ConfirmChoice) => void }
  | { kind: 'paste-reject'; rejection: PasteRejection };

const PANEL_OF: Record<TerminalTarget, PanelId> = { lab: 'terminal-lab', workstation: 'terminal-workstation' };
const LEADER_TIMEOUT_MS = 1_500;
const MIN_MS = 60_000;

function useViewportWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

function isLeader(e: KeyboardEvent, leader: TermPrefs['leader']): boolean {
  if (!e.ctrlKey || e.altKey || e.metaKey) return false;
  if (leader === 'ctrl-backquote') return e.key === '`' || e.code === 'Backquote';
  if (leader === 'ctrl-shift-period') return e.shiftKey && (e.key === '>' || e.key === '.' || e.code === 'Period');
  return !e.shiftKey && (e.key === '.' || e.code === 'Period');
}

/** 本会话最近的 env.degraded / env.recovered。 */
function envDegradedOf(events: readonly SessionEvent[]): boolean {
  const e = [...events].reverse().find((x) => x.type === 'env.degraded' || x.type === 'env.recovered');
  return e?.type === 'env.degraded';
}

export function Workspace({ sid, view }: { sid: string; view: SessionView }) {
  const services = useServices();
  const { api, sync, clock } = services;
  const { principal } = useAuth();
  const status = useGlobalStatus();
  const role = principal?.role ?? null;
  const learner = role === 'L';
  const render = workspaceRender(view);
  const catalogVersion = view.catalogVersion ?? status.catalog?.catalogVersion ?? null;
  const data = useWorkspaceData(sid, view, { role, catalogVersion });
  const [params, setParams] = useSearchParams();

  // ---------------------------------------------------------------- 护栏、预期中断、动作
  const g = status.guardrails;
  const guard: Guardrails = {
    uninstalling: !!g?.uninstalling || status.platform.data?.mode === 'UNINSTALLING',
    budgetExceeded: g?.budget?.state === 'EXCEEDED',
    budgetWarn: g?.budget?.state === 'WARN',
    budgetEndActive: g?.budget?.state === 'EXCEEDED' && g?.budget?.enforcement === 'end-active',
    envDegraded: envDegradedOf(data.events),
  };
  const nowMs = clock.now();
  const wsOutage = data.workspace.data?.expectedOutage ?? null;
  const viewOutage = view.outageWindow as { until?: string | null; channel?: string; stepId?: string; actionId?: string; reason?: string } | null | undefined;
  const outageSrc = wsOutage ?? (viewOutage?.until ? { until: viewOutage.until, channel: viewOutage.channel ?? null, stepId: viewOutage.stepId ?? null, actionId: viewOutage.actionId ?? null, reason: viewOutage.reason ?? null } : null);
  const outage: OutageWindow | null = outageSrc && Date.parse(outageSrc.until) > nowMs ? { until: outageSrc.until, channel: outageSrc.channel ?? null, stepId: outageSrc.stepId ?? null, actionId: outageSrc.actionId ?? null, reason: outageSrc.reason ?? null } : null;
  const allowed = allowedActionsOf(view, { role, nowMs, uninstalling: guard.uninstalling, budgetExceeded: guard.budgetExceeded, envHealthy: !guard.envDegraded });
  const [overlay, setOverlay] = useState<'overdue' | 'revoking' | null>(() => showExpiredOverlay(view, nowMs));
  const preparing = render.screen === 'P04' && render.variant === 'preparing';
  const live = render.screen === 'P05' && render.variant === 'live' && overlay === null && !view.revokedAt;

  // ---------------------------------------------------------------- 心跳、上报、检测
  useEffect(() => {
    if (!learner || render.screen !== 'P05' || render.variant !== 'live') return undefined;
    const hb = new WorkbenchHeartbeat({ api, sync, sid });
    hb.start();
    return () => hb.stop();
  }, [api, sync, sid, learner, render.screen, render.variant]);
  const reporter = useMemo(() => (learner ? new WorkspaceReporter(api, sid) : null), [api, sid, learner]);
  useEffect(() => {
    if (!reporter || !live) return undefined;
    reporter.start();
    return () => reporter.stop();
  }, [reporter, live]);
  const runner = useMemo(() => new CheckRunner(api, sid), [api, sid]);
  useEffect(() => () => runner.dispose(), [runner]);
  useSessionEvents(
    (eventSid, evs) => {
      if (eventSid !== sid) return;
      for (const e of evs) if (e.type === 'check_run.completed' && typeof e.data.runId === 'string') runner.complete(e.data.runId);
      if (evs.some((e) => e.type === 'session.access_revoked')) {
        labRef.current?.revokeAll();
        wsRef.current?.revokeAll();
      }
    },
    { sid, types: ['check_run.completed', 'session.access_revoked'] },
  );

  // ---------------------------------------------------------------- 步骤
  const lab = data.lab.data;
  const steps = useMemo(() => lab?.steps ?? [], [lab]);
  const stepParam = params.get('step');
  const defaultStepIndex = useMemo(() => {
    const prog = data.progress.data?.steps ?? [];
    const i = steps.findIndex((s) => {
      const st = prog.find((p) => p.stepId === s.id)?.state;
      return !st || !['done', 'done_manual', 'skipped'].includes(st);
    });
    return i < 0 ? 0 : i;
    // 只在手册加载与首次进度到达时决定默认步骤
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length, !!data.progress.data]);
  const stepIndex = stepParam ? Math.max(0, steps.findIndex((s) => s.id === stepParam)) : defaultStepIndex;
  const step = steps[stepIndex] ?? null;
  const touched = useRef(false);

  // ---------------------------------------------------------------- 右栏标签、分段、布局
  const width = useViewportWidth();
  const bp = breakpointOf(width);
  const segmented = isSegmented(bp);
  const panelParam = params.get('panel') as PanelId | null;
  // 右栏标签：没有显式选择（?panel= 或学员点选）时取当前步骤的默认标签（04 §4.1）
  const [tabState, setTab] = useState<PanelId | null>(() => (panelParam && PANELS.includes(panelParam) ? panelParam : null));
  const [seg, setSeg] = useState<string>(preparing ? 'prov' : 'manual');
  const [started, setStarted] = useState<ReadonlySet<TermTarget>>(new Set());
  const [flash, setFlash] = useState<PanelId | null>(null);
  const [termStatus, setTermStatus] = useState<Record<TermTarget, TermPhase | null>>({ lab: null, workstation: null });
  const labRef = useRef<TerminalPaneHandle | null>(null);
  const wsRef = useRef<TerminalPaneHandle | null>(null);
  const [layout, setLayout] = useState(loadLayout);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(width);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    setBodyWidth(el.clientWidth || width);
    if (!RO) return undefined;
    const ro = new RO(() => setBodyWidth(el.clientWidth || window.innerWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  const splitPct = clampSplit(layout.split ?? defaultSplitPct(bodyWidth), bodyWidth);
  useEffect(() => {
    bodyRef.current?.style.setProperty('--split', `${splitPct}%`);
  }, [splitPct]);

  const tab: PanelId = tabState ?? (step ? defaultPanelOf(step) : 'terminal-workstation');
  const markStarted = useCallback((which: TermTarget) => setStarted((s) => (s.has(which) ? s : new Set([...s, which]))), []);
  const focusTab = useCallback(
    (panel: PanelId, opts: { user?: boolean } = {}) => {
      if (!PANELS.includes(panel)) return;
      setTab(panel);
      if (opts.user) touched.current = true;
      if (panel === 'terminal-lab') markStarted('lab');
      if (panel === 'terminal-workstation') markStarted('workstation');
      if (segmented && opts.user) setSeg(panel);
    },
    [markStarted, segmented],
  );
  // 首次打开终端标签时自动连接
  useEffect(() => {
    if (!live || !lab || !step) return;
    if (tab === 'terminal-lab') markStarted('lab');
    if (tab === 'terminal-workstation') markStarted('workstation');
  }, [tab, live, lab, step, markStarted]);
  // 步骤成为当前步骤：右侧切到它的默认标签（学员本步内手动选过标签后不再自动切换）
  const lastStep = useRef<string | null>(null);
  useEffect(() => {
    if (!step || lastStep.current === step.id) return;
    const first = lastStep.current === null;
    lastStep.current = step.id;
    touched.current = false;
    if (!first) setTab(defaultPanelOf(step));
  }, [step, panelParam]);

  const goStep = useCallback(
    (i: number) => {
      if (!steps.length) return;
      const n = Math.max(0, Math.min(steps.length - 1, i));
      const next = new URLSearchParams(params);
      next.set('step', steps[n]!.id);
      setParams(next, { replace: true });
      setTimeout(() => document.getElementById(`step-h-${steps[n]!.id}`)?.focus(), 0);
    },
    [steps, params, setParams],
  );

  // ---------------------------------------------------------------- 对话框与抽屉
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const closeDlg = useCallback(() => setDlg(null), []);
  const checkParam = params.get('check');
  const expParam = params.get('exp');
  const setParam = useCallback(
    (k: string, v: string | null) => {
      const next = new URLSearchParams(params);
      if (v === null) next.delete(k);
      else next.set(k, v);
      setParams(next, { replace: false });
    },
    [params, setParams],
  );
  const [prefs, setPrefs] = useState<TermPrefs>(loadTermPrefs);
  const dontAsk = useRef(false);
  const revealRef = useRef<VariableStripHandle | null>(null);
  const finishedListeners = useRef(new Set<(e: CommandFinished) => void>());
  const lastPaste = useRef<Record<TermTarget, string | null>>({ lab: null, workstation: null });
  const consoleOpener = useConsoleOpener({ sid, workspace: data.workspace, reporter });

  const handleOf = (t: TerminalTarget) => (t === 'lab' ? labRef.current : wsRef.current);
  const confirm = (req: ConfirmRequest) => new Promise<ConfirmChoice>((resolve) => setDlg({ kind: 'paste-confirm', req, resolve: (c) => (setDlg(null), resolve(c)) }));

  const pasteToTerminal = useCallback(
    async (tabTarget: TerminalTarget, text: string, meta: PasteMeta): Promise<boolean> => {
      const mode = meta.mode ?? 'paste';
      const pre = precheckPaste({ text, mode, danger: meta.dangerous, unresolved: meta.unresolved, secret: meta.secret, secretPaths: meta.secretPaths });
      if (pre) {
        if (pre.reason === 'unresolved') {
          revealRef.current?.reveal(pre.names);
          announce(pre.message);
        } else setDlg({ kind: 'paste-reject', rejection: pre });
        return false;
      }
      if (!learner || !live) {
        announce('环境就绪后可用');
        return false;
      }
      // 目标终端未打开：先打开并等待 Ready；超时则不粘贴，保留复制
      focusTab(PANEL_OF[tabTarget]);
      if (segmented) setSeg(PANEL_OF[tabTarget]);
      markStarted(tabTarget);
      await new Promise((r) => setTimeout(r, 0));
      const h = handleOf(tabTarget);
      if (!h) {
        announce('终端还没有准备好');
        return false;
      }
      let ctl = meta.newTab ? (h.newSubTab() ?? h.active()) : h.active();
      const ready = await ctl.ensureReady();
      if (!ready) {
        const copied = await copyText(text);
        announce(copied ? '终端还没有连上，命令已复制，可以连上后手动粘贴' : '终端还没有连上，请先复制命令，连上后手动粘贴');
        return false;
      }
      const snap = ctl.getSnapshot();
      const decision = evaluatePaste({
        text,
        mode,
        danger: meta.dangerous,
        target: tabTarget,
        expected: meta.expected ?? null,
        terminal: { bracketedPaste: ctl.bracketedPaste, busy: snap.busy, tmux: h.tmux },
        dontAskExecute: dontAsk.current,
      });
      if (decision.kind === 'reject') {
        setDlg({ kind: 'paste-reject', rejection: decision.rejection });
        return false;
      }
      if (decision.kind === 'confirm') {
        const t = targetOf(data.workspace.data?.targets, tabTarget);
        const choice = await confirm({
          text: normalizePasteText(text),
          target: tabTarget,
          expected: meta.expected ?? null,
          notes: decision.notes,
          severe: decision.severe,
          lines: decision.lines,
          offerNewTab: decision.offerNewTab,
          offerDontAsk: decision.offerDontAsk,
          execute: mode === 'execute',
          host: snap.instanceId ?? t?.instanceId ?? null,
          user: snap.runAs ?? t?.runAs ?? 'labuser',
          identity: tabTarget === 'lab' ? (t?.awsIdentity ?? 'CloudAlbumAppRole') : (t?.awsIdentity ?? `ATLLearnerRole（atl-${sid}-ws）`),
        });
        if (choice.action === 'cancel') return false;
        if (choice.dontAsk) dontAsk.current = true;
        if (choice.action === 'newtab') {
          const n = h.newSubTab();
          if (!n || !(await n.ensureReady())) {
            announce('新的终端子标签没有连上');
            return false;
          }
          ctl = n;
        }
      }
      if (!ctl.paste(normalizePasteText(text), mode === 'execute')) return false;
      lastPaste.current[tabTarget] = meta.stepId;
      ctl.focus();
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) {
        setFlash(PANEL_OF[tabTarget]);
        setTimeout(() => setFlash(null), 150);
      }
      announce(`已粘贴到 ${TARGET_TEXT[tabTarget]}终端 #${h.activeNo()}，检查后按 Enter 执行`);
      void sha256Hex(normalizePasteText(text)).then((textSha256) =>
        reporter?.push('workspace.command_pasted', { stepId: meta.stepId, blockIndex: meta.blockIndex, tab: PANEL_OF[tabTarget], mode, textSha256, dangerous: !!meta.dangerous }),
      );
      return true;
    },
    [learner, live, focusTab, segmented, markStarted, data.workspace.data, sid, reporter],
  );

  const onCommandFinished = useCallback((which: TermTarget, exitCode: number | null) => {
    const stepId = lastPaste.current[which];
    if (!stepId) return;
    reporter?.push('workspace.command_finished', { stepId, tab: PANEL_OF[which], exitCode });
    for (const l of finishedListeners.current) l({ stepId, tab: which, exitCode });
  }, [reporter]);

  const runStepCheck = useCallback(
    (stepId: string, opts: { checkIds?: string[]; force?: boolean } = {}) => {
      if (!(role === 'L' || role === 'A') || !live) {
        announce(preparing ? '环境就绪后可用' : '实验已结束，不能再检测');
        return;
      }
      runner.runStep(stepId, opts).then(
        () => announce('已开始检测', { topic: `check-start:${stepId}` }),
        () => announce('检测没有开始，请稍后重试'),
      );
    },
    [role, live, preparing, runner],
  );

  const workbench: Workbench = useMemo(
    () => ({
      focusTab,
      pasteToTerminal,
      openConsole: (dest) => {
        focusTab('console');
        consoleOpener.open(dest);
      },
      runStepCheck,
      runLabCheck: () => {
        if (!(role === 'L' || role === 'A') || !live) return;
        void runner.runScope('lab').then(
          () => announce('已开始检测整张卡片'),
          () => announce('检测没有开始'),
        );
      },
      openCheck: (checkId) => setParam('check', checkId),
      openExperiment: (key) => setParam('exp', key),
      openManualConfirm: (stepId, checkId) => setDlg({ kind: 'manual', stepId, checkId }),
      revealVariables: (names) => revealRef.current?.reveal(names),
      focusManual: () => {
        if (segmented) setSeg('manual');
        setTimeout(() => (document.querySelector('[data-step-heading]') as HTMLElement | null)?.focus(), 0);
        announce('已回到手册');
      },
      checks: runner,
      onCommandFinished: (cb) => {
        finishedListeners.current.add(cb);
        return () => finishedListeners.current.delete(cb);
      },
    }),
    [focusTab, pasteToTerminal, consoleOpener, runStepCheck, role, live, runner, setParam, segmented],
  );

  // ---------------------------------------------------------------- 就绪的 3 秒过渡、播报、通知
  const prevState = useRef(view.state);
  const [readyFlash, setReadyFlash] = useState(false);
  useEffect(() => {
    const was = prevState.current;
    prevState.current = view.state;
    if ((was === 'REQUESTED' || was === 'PROVISIONING') && (view.state === 'READY' || view.state === 'RUNNING')) {
      setReadyFlash(true);
      setSeg('manual');
      announce('环境已就绪，倒计时已开始', { politeness: 'polite' });
      try {
        if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('ATL 实验平台', { body: `${view.labId} 的实验环境已就绪` });
      } catch {
        /* 尽力送达 */
      }
    }
  }, [view.state, view.labId]);
  useEffect(() => {
    if (!readyFlash) return undefined;
    const t = setTimeout(() => setReadyFlash(false), 3000);
    return () => clearTimeout(t);
  }, [readyFlash]);

  // ---------------------------------------------------------------- 到期：T-5、覆盖层、自动关闭对话框
  const t5Shown = useRef(new Set<string>());
  const [t5Hint, setT5Hint] = useState(false);
  const dlgRef = useRef(dlg);
  dlgRef.current = dlg;
  useSecondTickCallback(() => {
    const n = clock.now();
    const ov = showExpiredOverlay(view, n);
    setOverlay((o) => (o === ov ? o : ov));
    const d = dlgRef.current;
    if (!actionableState(view, n) && d && (d.kind === 'extend' || d.kind === 'end' || d.kind === 't5')) setDlg(null);
    if (shouldOpenT5(view, n, learner && render.screen === 'P05', t5Shown.current) && !d) {
      t5Shown.current.add(t5Key(view));
      const inTerm = !!document.activeElement?.closest('.xterm');
      if (inTerm) {
        setT5Hint(true);
        setTimeout(() => {
          setT5Hint(false);
          if (actionableState(view, clock.now()) && !dlgRef.current) setDlg({ kind: 't5' });
        }, 2000);
      } else setDlg({ kind: 't5' });
    }
  });

  // T-15 / T-5 的浏览器通知（页面不可见且已授权时尽力送达，§3.9、§7.2 第 7 条；按 deadlineVersion 去重）
  useEffect(() => {
    if (!learner || !view.deadlineAt || !['READY', 'RUNNING', 'EXPIRING'].includes(view.state)) return undefined;
    const deadline = Date.parse(view.deadlineAt);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const m of [15, 5]) {
      const key = `atl.ws.notified.${sid}.${view.deadlineVersion ?? 0}.${m}`;
      const delay = deadline - m * MIN_MS - clock.now();
      if (delay <= 0) continue;
      timers.push(
        setTimeout(() => {
          try {
            if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted' || sessionStorage.getItem(key)) return;
            sessionStorage.setItem(key, '1');
            new Notification('ATL 实验平台', { body: `${view.labId} 还剩 ${m} 分钟，到期后自动收回访问并释放资源。` });
          } catch {
            /* 尽力送达 */
          }
        }, delay),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [learner, sid, view.deadlineAt, view.deadlineVersion, view.state, view.labId, clock]);

  // 覆盖层出现时背后区域 inert
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const els = Array.from(root.querySelectorAll<HTMLElement>(':scope > .wsbar, :scope > .wsbans, :scope > .wsseg, :scope > .wsbody'));
    for (const el of els) {
      if (overlay) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
    return () => els.forEach((el) => el.removeAttribute('inert'));
  }, [overlay]);
  // 到截止时间：只加快轮询（浏览器不调用“结束”）
  useEffect(() => {
    if (overlay === 'overdue') void sync.refreshView(sid);
  }, [overlay, sync, sid]);

  // ---------------------------------------------------------------- 前导键（03 §8.2）
  const [leaderWait, setLeaderWait] = useState(false);
  const leaderAt = useRef(0);
  const ctxRef = useRef({ step, stepIndex, goStep, workbench, focusTab, layout, bodyWidth, splitPct, setLayout, tab });
  ctxRef.current = { step, stepIndex, goStep, workbench, focusTab, layout, bodyWidth, splitPct, setLayout, tab };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = ctxRef.current;
      if (isLeader(e, prefs.leader)) {
        e.preventDefault();
        e.stopPropagation();
        if (leaderAt.current && Date.now() - leaderAt.current < LEADER_TIMEOUT_MS) {
          // ⌃. ⌃.：把按键原样交给终端（扩展键盘协议的 Ctrl+.）
          leaderAt.current = 0;
          setLeaderWait(false);
          const h = c.tab === 'terminal-lab' ? labRef.current : c.tab === 'terminal-workstation' ? wsRef.current : null;
          h?.active().sendRaw('\x1b[46;5u');
          return;
        }
        leaderAt.current = Date.now();
        setLeaderWait(true);
        setTimeout(() => {
          if (leaderAt.current && Date.now() - leaderAt.current >= LEADER_TIMEOUT_MS) {
            leaderAt.current = 0;
            setLeaderWait(false);
          }
        }, LEADER_TIMEOUT_MS + 20);
        return;
      }
      if (!leaderAt.current || Date.now() - leaderAt.current > LEADER_TIMEOUT_MS) return;
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      leaderAt.current = 0;
      setLeaderWait(false);
      const k = e.key.toLowerCase();
      const done = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const tabs: Record<string, PanelId> = { '1': 'terminal-lab', '2': 'terminal-workstation', '3': 'console', '4': 'preview' };
      if (tabs[k]) {
        done();
        c.focusTab(tabs[k]!, { user: true });
        setSeg(tabs[k]!);
        return;
      }
      if (k === 'm') return done(), c.workbench.focusManual();
      if (k === 't') {
        done();
        const h = c.tab === 'terminal-lab' ? labRef.current : wsRef.current;
        if (c.tab !== 'terminal-lab' && c.tab !== 'terminal-workstation') c.focusTab('terminal-workstation', { user: true });
        setTimeout(() => h?.focus(), 0);
        return;
      }
      if (k === 'r') return done(), c.step && c.workbench.runStepCheck(c.step.id);
      if (k === 'n') return done(), c.goStep(c.stepIndex + 1);
      if (k === 'p') return done(), c.goStep(c.stepIndex - 1);
      if (k === '0') {
        done();
        const next = { split: null, collapsed: false };
        c.setLayout(next);
        saveLayout(next);
        window.dispatchEvent(new Event('atl:ws-drag-end'));
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        done();
        const r = keyStep(e.key, true, { pct: c.splitPct, collapsed: c.layout.collapsed }, c.bodyWidth);
        if (r) {
          const next = { split: r.pct, collapsed: r.collapsed };
          c.setLayout(next);
          saveLayout(next);
          window.dispatchEvent(new Event('atl:ws-drag-end'));
        }
        return;
      }
      if (k === '[' || k === ']') {
        done();
        const next = { split: c.layout.split, collapsed: k === '[' };
        c.setLayout(next);
        saveLayout(next);
        window.dispatchEvent(new Event('atl:ws-drag-end'));
        return;
      }
      if (k === 's') {
        done();
        setPrefs((p) => {
          const n = { ...p, screenReader: !p.screenReader };
          try {
            globalThis.localStorage?.setItem('atl.ws.terminal.v1', JSON.stringify(n));
          } catch {
            /* 忽略 */
          }
          announce(n.screenReader ? '终端读屏模式已开启' : '终端读屏模式已关闭');
          return n;
        });
        return;
      }
      if (k === '?' || k === '/') return done(), setDlg({ kind: 'shortcuts' });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [prefs.leader]);

  // 进入工作台：焦点移到手册当前步骤标题（§8.2 工作台例外）
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusedOnce.current || !step) return;
    focusedOnce.current = true;
    setTimeout(() => {
      // 只在焦点还没有落到别处时（进入页面）移到步骤标题，不抢学员已经打开的对话框或终端的焦点
      const a = document.activeElement;
      if (a && a !== document.body && !(a instanceof HTMLElement && a.matches('main, #main, h1'))) return;
      (document.querySelector('[data-step-heading]') as HTMLElement | null)?.focus({ preventScroll: true });
    }, 0);
  }, [step]);

  // ---------------------------------------------------------------- 上下文
  const ctx: WorkspaceCtx = {
    sid,
    view,
    render,
    role,
    learner,
    live,
    preparing,
    accessRevoked: !!view.revokedAt || !['READY', 'RUNNING', 'EXPIRING'].includes(view.state),
    allowed,
    data,
    guard,
    outage,
    now: clock.now,
    reporter,
  };
  const extendReason = extendBlock(view, allowed, { learner, uninstalling: guard.uninstalling, budgetExceeded: guard.budgetExceeded, nowMs });

  const segItems: { id: string; text: string }[] = preparing || render.screen === 'P04' ? [{ id: 'prov', text: '进度' }, { id: 'manual', text: '手册' }] : [{ id: 'manual', text: '手册' }, ...PANELS.map((p) => ({ id: p, text: TAB_META[p].short }))];
  const segActive = segmented ? seg : null;
  const rightIsP04 = render.screen === 'P04' || readyFlash;

  return (
    <WorkspaceContext.Provider value={ctx}>
      <WorkbenchContext.Provider value={workbench}>
        <div className="ws ws-main" ref={rootRef} data-screen={render.screen} data-variant={render.variant} data-bp={bp}>
          <SessionBar
            onExtend={() => setDlg({ kind: 'extend' })}
            onEnd={() => setDlg({ kind: 'end', when: 'now' })}
            onCancel={() => setDlg({ kind: 'cancel' })}
            onCost={() => setDlg({ kind: 'cost' })}
            onShortcuts={() => setDlg({ kind: 'shortcuts' })}
            onTermSettings={() => setDlg({ kind: 'term' })}
            onCredentials={() => setDlg({ kind: 'cred' })}
          />
          <WorkspaceBanners
            onExtend={() => setDlg({ kind: 'extend' })}
            onEnd={(when) => setDlg({ kind: 'end', when })}
            onRepair={() => {
              const envId = view.env?.envId;
              if (!envId) return;
              void api.call('repairEnvironment', { params: { envId }, body: {} }).then(
                () => announce('已请求修复环境'),
                () => announce('修复请求没有完成'),
              );
            }}
            extendBlocked={extendReason ? EXTEND_REASON_TEXT[extendReason] : null}
          />
          {segmented ? (
            <nav className="wsseg" aria-label="工作台分段">
              <div className="seg" role="group" aria-label="显示">
                {segItems.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={segActive === s.id}
                    onClick={() => {
                      setSeg(s.id);
                      if ((PANELS as readonly string[]).includes(s.id)) focusTab(s.id as PanelId, { user: true });
                    }}
                  >
                    {s.text}
                  </button>
                ))}
              </div>
            </nav>
          ) : null}
          <div
            className={['wsbody', layout.collapsed && !segmented ? 'collapsed' : ''].filter(Boolean).join(' ')}
            ref={bodyRef}
            data-seg={segmented ? (seg === 'manual' ? 'manual' : 'right') : undefined}
          >
            {layout.collapsed && !segmented ? (
              <div className="collapsed-strip">
                <button
                  type="button"
                  className="btn sm icon"
                  aria-label="展开手册"
                  onClick={() => {
                    const next = { split: layout.split, collapsed: false };
                    setLayout(next);
                    saveLayout(next);
                  }}
                >
                  <Shape name="dot" />
                </button>
              </div>
            ) : (
              <ManualPane stepIndex={stepIndex} onStep={goStep} onSubmit={() => setDlg({ kind: 'submit' })} revealRef={revealRef} />
            )}
            <Splitter
              pct={splitPct}
              collapsed={layout.collapsed}
              width={bodyWidth}
              container={() => bodyRef.current}
              onChange={(next, commit) => {
                const l = { split: next.pct, collapsed: next.collapsed };
                setLayout(l);
                if (commit) saveLayout(l);
              }}
              onReset={() => {
                const l = { split: null, collapsed: false };
                setLayout(l);
                saveLayout(l);
                window.dispatchEvent(new Event('atl:ws-drag-end'));
              }}
            />
            {rightIsP04 ? (
              readyFlash && render.screen === 'P05' ? (
                <ReadyFlash />
              ) : (
                <ProvisionPanel onCancel={() => setDlg({ kind: 'cancel' })} />
              )
            ) : (
              <RightPane
                tab={segmented && (PANELS as readonly string[]).includes(seg) ? (seg as PanelId) : tab}
                onTab={(t) => focusTab(t, { user: true })}
                flash={flash}
                started={started}
                labRef={labRef}
                wsRef={wsRef}
                consoleOpener={consoleOpener}
                fontSize={prefs.fontSize}
                screenReaderMode={prefs.screenReader}
                narrow={bp === 'narrow'}
                segmented={segmented}
                onCommandFinished={onCommandFinished}
                termStatus={termStatus}
                onTermStatus={(which, phase) => setTermStatus((s) => (s[which] === phase ? s : { ...s, [which]: phase }))}
              />
            )}
          </div>
          {leaderWait ? (
            <div className="leader-hint" role="status" aria-live="polite">
              等待第二个键…
            </div>
          ) : null}
          {t5Hint ? (
            <div className="leader-hint" role="status">
              将显示到期提醒
            </div>
          ) : null}
          {overlay && render.screen === 'P05' ? <ExpiredOverlay kind={overlay} /> : null}
        </div>
        {checkParam && lab ? <CheckDrawer checkId={checkParam} onClose={() => setParam('check', null)} /> : null}
        {expParam && lab ? <ExperimentCompareDrawer expKey={expParam} onClose={() => setParam('exp', null)} /> : null}
        {dlg?.kind === 'extend' ? <ExtendDialog onClose={closeDlg} /> : null}
        {dlg?.kind === 'end' ? <EndDialog initialWhen={dlg.when} onClose={closeDlg} /> : null}
        {dlg?.kind === 'cancel' ? <CancelDialog onClose={closeDlg} /> : null}
        {dlg?.kind === 'submit' ? <SubmitDialog onClose={closeDlg} /> : null}
        {dlg?.kind === 'manual' ? <ManualConfirmDialog stepId={dlg.stepId} checkId={dlg.checkId} onClose={closeDlg} /> : null}
        {dlg?.kind === 'shortcuts' ? <ShortcutsDialog leader={LEADER_TEXT[prefs.leader]} onClose={closeDlg} /> : null}
        {dlg?.kind === 'term' ? <TermSettingsDialog prefs={prefs} onChange={setPrefs} onClose={closeDlg} /> : null}
        {dlg?.kind === 'cred' ? <CredentialRevealDialog onClose={closeDlg} /> : null}
        {dlg?.kind === 'cost' ? <CostDrawer onClose={closeDlg} /> : null}
        {dlg?.kind === 't5' ? <ExpiryDialog canExtend={allowed.includes('extend') && !extendReason} onExtend={() => setDlg({ kind: 'extend' })} onClose={closeDlg} /> : null}
        {dlg?.kind === 'paste-confirm' ? <PasteConfirmDialog req={dlg.req} onDone={dlg.resolve} /> : null}
        {dlg?.kind === 'paste-reject' ? <PasteRejectDialog rejection={dlg.rejection} onClose={closeDlg} /> : null}
      </WorkbenchContext.Provider>
    </WorkspaceContext.Provider>
  );
}

/** 每秒调用一次（页面隐藏时暂停），不触发组件重渲染。 */
function useSecondTickCallback(fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      ref.current();
    }, 1000);
    const onVis = () => {
      if (!document.hidden) ref.current();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
}
