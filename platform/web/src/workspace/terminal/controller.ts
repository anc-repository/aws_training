/**
 * 一个终端子标签（一个 SSM 会话）的控制器（03 §3.2、§3.5.9、§3.9；08 P05.6），建立在 ssm-client 的 `SsmTerminalConnection` 之上：
 *
 * - 打开：`POST /sessions/{sid}/terminals {target, instanceId?, cols, rows, clientId}`（由连接对象的 open 回调发出），令牌只在内存；
 * - 握手超时（15 秒）、续连（`POST …/resume`，最多 5 次）、channel_closed 由协议层处理；握手超时后 `DELETE` 结束该 SSM 会话；
 * - 结束：`DELETE …/terminals/{terminalId}`；`session.access_revoked` → 立即关闭连接（不再调用终端接口）；
 * - 另外维护“终端是否正忙”（OSC 133：收到 C 未收到 D）、上一条命令的退出码、当前目录（OSC 7），供确认矩阵与“检测本步”建议使用。
 *
 * 状态以快照形式暴露（subscribe / getSnapshot），供 React 的 useSyncExternalStore 订阅。
 */
import type { ApiClient } from '../../api/client';
import { ApiError, isApiError } from '../../api/errors';
import { loadSsmClient, tabClientId, type SsmClientModule, type SsmConnectionLike, type SsmStateChange } from './channel';

export type TermTarget = 'lab' | 'workstation';

export type TermPhase = 'idle' | 'requesting' | 'connecting' | 'handshaking' | 'ready' | 'reconnecting' | 'failed' | 'closed' | 'blocked';

export interface TermError {
  code: string;
  message?: string | null;
  requestId?: string | null;
}

export interface TermSnapshot {
  phase: TermPhase;
  error: TermError | null;
  /** 失败或关闭的原因：handshake-timeout、gone、idle、max-duration、channel-closed、revoked、ended…… */
  reason: string | null;
  /** channel_closed 的说明（Agent 给出的文字）。 */
  closedOutput: string | null;
  attempt: number;
  maxAttempts: number;
  terminalId: string | null;
  ssmSessionId: string | null;
  instanceId: string | null;
  runAs: string | null;
  idleTimeoutMin: number | null;
  maxDurationMin: number | null;
  document: string | null;
  busy: boolean;
  lastExitCode: number | null;
  cwd: string | null;
  openedAt: number | null;
}

export interface CreateTerminalResponse {
  terminalId: string;
  ssmSessionId?: string;
  instanceId?: string;
  streamUrl: string;
  tokenValue: string;
  document?: string;
  runAs?: string;
  idleTimeoutMin?: number;
  maxDurationMin?: number;
  connectBy?: string;
  /** 签发时的服务端时间（与 connectBy 同一时钟）。 */
  serverNow?: string;
  clientVersion?: string;
}

/** xterm.js 的最小接口（便于测试替身）。 */
export interface XtermLike {
  cols: number;
  rows: number;
  modes?: { bracketedPasteMode?: boolean };
  options?: { disableStdin?: boolean };
  write(data: Uint8Array | string, cb?: () => void): void;
  paste(text: string): void;
  focus(): void;
  onData(cb: (d: string) => void): { dispose(): void };
  onBinary?(cb: (d: string) => void): { dispose(): void };
  onResize?(cb: (s: { cols: number; rows: number }) => void): { dispose(): void };
  parser?: { registerOscHandler(ident: number, cb: (data: string) => boolean): { dispose(): void } };
}

export const READY_WAIT_MS = 15_000;
/**
 * 新 SSM 会话 Ready 之后等 shell 第一次显示提示符的时限（从 Ready 且 xterm 已接上起算）。Ready 时 shell 还没输出提示符，
 * bracketedPasteMode 要等 readline 输出 `ESC[?2004h` 才变 true；在此之前判定会把多行命令按“非安全粘贴”逐行执行（03 §7.1）。
 */
export const PROMPT_WAIT_MS = 5_000;
/** 只见到 OSC 133 A（PROMPT_COMMAND 输出，早于 readline）时，再等 B 或 bracketed paste 开启的宽限。 */
export const PROMPT_GRACE_MS = 300;

export interface ControllerOptions {
  api: Pick<ApiClient, 'call'>;
  sid: string;
  target: TermTarget;
  instanceId?: string | null;
  /** StreamUrl 校验：区域（生产）；dev 模式下允许回环地址（ssm-client 的本地模拟服务器）。 */
  region?: string | null;
  allowLoopback?: boolean;
  /** 记录续连等工作台事件（03 §7.4）。 */
  report?: (type: string, data: Record<string, unknown>) => void;
  /** 命令结束（OSC 133 D）。 */
  onCommandFinished?: (exitCode: number | null) => void;
  /** 测试用：直接给协议层模块。 */
  client?: SsmClientModule | null;
  /**
   * 服务端时钟（api/serverClock）。`connectBy` 由服务端按自己的时钟签发：响应没有 serverNow 时用它估计签发时的服务端时间，
   * 交给 ssm-client 做相对判断——本机时钟快 30 秒以上也不会把刚拿到的令牌当成已过期（组件不得直接用 Date.now() 比较服务端时间）。
   */
  clock?: { now(): number };
}

const INITIAL: TermSnapshot = {
  phase: 'idle',
  error: null,
  reason: null,
  closedOutput: null,
  attempt: 0,
  maxAttempts: 5,
  terminalId: null,
  ssmSessionId: null,
  instanceId: null,
  runAs: null,
  idleTimeoutMin: null,
  maxDurationMin: null,
  document: null,
  busy: false,
  lastExitCode: null,
  cwd: null,
  openedAt: null,
};

function phaseOf(s: SsmStateChange['state']): TermPhase {
  switch (s) {
    case 'requesting':
      return 'requesting';
    case 'connecting':
    case 'authenticating':
      return 'connecting';
    case 'handshaking':
      return 'handshaking';
    case 'ready':
      return 'ready';
    case 'reconnecting':
    case 'resuming':
      return 'reconnecting';
    case 'failed':
      return 'failed';
    case 'closed':
      return 'closed';
    default:
      return 'idle';
  }
}

export class TerminalController {
  private snap: TermSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private conn: SsmConnectionLike | null = null;
  private term: XtermLike | null = null;
  private termSubs: { dispose(): void }[] = [];
  private connSubs: (() => void)[] = [];
  private readyWaiters: ((ok: boolean) => void)[] = [];
  private disposed = false;
  /** shell 提示符：none = 本 SSM 会话还没见到；start = OSC 133 A；end = OSC 133 B 或 bracketed paste 已开启。 */
  private promptMark: 'none' | 'start' | 'end' = 'none';
  private promptAt = 0;
  private readyAt: number | null = null;
  private attachedAt: number | null = null;
  private readonly promptWaiters = new Set<() => void>();
  private revoked = false;
  private clientId = '';

  constructor(private readonly o: ControllerOptions) {}

  getSnapshot = (): TermSnapshot => this.snap;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<TermSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    if (this.snap.phase === 'ready') this.readyAt ??= Date.now();
    for (const l of this.listeners) l();
    if (this.snap.phase === 'ready') this.flushWaiters(true);
    else if (['failed', 'closed', 'blocked'].includes(this.snap.phase)) this.flushWaiters(false);
    this.notifyPrompt();
  }

  private notifyPrompt(): void {
    for (const w of [...this.promptWaiters]) w();
  }

  private markPrompt(mark: 'start' | 'end'): void {
    if (this.promptMark === 'end' || (mark === 'start' && this.promptMark === 'start')) return;
    this.promptMark = mark;
    this.promptAt = Date.now();
    this.notifyPrompt();
  }

  /** 输出交给 xterm；解析完后检查 bracketed paste 是否已开启（没有 shell 集成时它就是“提示符已出现”的信号）。 */
  private sinkTo(term: XtermLike): (data: Uint8Array, done: () => void) => void {
    return (data, done) =>
      term.write(data, () => {
        done();
        if (this.term === term && this.bracketedPaste) this.markPrompt('end');
      });
  }

  private flushWaiters(ok: boolean): void {
    for (const f of this.readyWaiters.splice(0)) f(ok);
  }

  get bracketedPaste(): boolean {
    return !!this.term?.modes?.bracketedPasteMode;
  }

  /** 绑定 xterm 实例：输入转发、尺寸、OSC 133 / OSC 7。 */
  attach(term: XtermLike): void {
    this.term = term;
    this.attachedAt = Date.now();
    this.termSubs.push(term.onData((d) => void this.conn?.sendInput(d)));
    if (term.onBinary) this.termSubs.push(term.onBinary((d) => void this.conn?.sendInput(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff))));
    if (term.onResize) this.termSubs.push(term.onResize(({ cols, rows }) => this.conn?.resize(cols, rows)));
    if (term.parser) {
      this.termSubs.push(
        term.parser.registerOscHandler(133, (payload) => {
          this.onOsc133(payload);
          return true;
        }),
        term.parser.registerOscHandler(7, (payload) => {
          const m = /^file:\/\/[^/]*(\/.*)$/.exec(payload);
          if (m) this.set({ cwd: decodeURIComponent(m[1]!) });
          return true;
        }),
      );
    }
    this.conn?.setOutputSink(this.sinkTo(term));
    this.conn?.resize(term.cols, term.rows);
  }

  onOsc133(payload: string): void {
    const [kind, arg] = payload.split(';');
    if (kind === 'A') this.markPrompt('start');
    else if (kind === 'B') this.markPrompt('end');
    else if (kind === 'C') this.set({ busy: true });
    else if (kind === 'D') {
      const ec = arg !== undefined && arg !== '' && Number.isFinite(Number(arg)) ? Number(arg) : null;
      const wasBusy = this.snap.busy;
      this.set({ busy: false, lastExitCode: ec });
      if (wasBusy) this.o.onCommandFinished?.(ec);
    }
  }

  /** 打开（或重新打开）一个 SSM 会话。 */
  async open(): Promise<void> {
    if (this.disposed || this.revoked) return;
    this.teardownConn();
    // 新的 SSM 会话 = 新的 shell：提示符要重新等（续连 resume 是同一个 shell，不重置）
    this.promptMark = 'none';
    this.readyAt = null;
    this.set({ ...INITIAL, phase: 'requesting', busy: false });
    const mod = this.o.client !== undefined ? this.o.client : await loadSsmClient();
    if (this.disposed) return;
    if (!mod) {
      this.set({ phase: 'blocked', error: { code: 'CLIENT_UNAVAILABLE' } });
      return;
    }
    this.clientId ||= tabClientId(mod);
    const open = async () => {
      const r = await this.o.api.call<CreateTerminalResponse>('createTerminal', {
        params: { sid: this.o.sid },
        body: {
          target: this.o.target,
          ...(this.o.instanceId ? { instanceId: this.o.instanceId } : {}),
          cols: Math.max(10, Math.min(500, this.term?.cols ?? 120)),
          rows: Math.max(5, Math.min(300, this.term?.rows ?? 30)),
          clientId: this.clientId,
        },
      });
      const res = r.data;
      if (!res?.streamUrl) throw new ApiError({ status: r.status, code: 'BAD_RESPONSE', title: 'no streamUrl' });
      this.set({
        terminalId: res.terminalId,
        ssmSessionId: res.ssmSessionId ?? null,
        instanceId: res.instanceId ?? this.o.instanceId ?? null,
        runAs: res.runAs ?? null,
        idleTimeoutMin: res.idleTimeoutMin ?? null,
        maxDurationMin: res.maxDurationMin ?? null,
        document: res.document ?? null,
        openedAt: Date.now(),
      });
      return { streamUrl: res.streamUrl, tokenValue: res.tokenValue, connectBy: res.connectBy ?? null, serverNow: this.serverNowOf(res.serverNow) };
    };
    const resume = async () => {
      const id = this.snap.terminalId;
      if (!id) throw new ApiError({ status: 409, code: 'TERMINAL_GONE' });
      const r = await this.o.api.call<{ streamUrl: string; tokenValue: string; connectBy?: string; serverNow?: string }>('resumeTerminal', { params: { sid: this.o.sid, terminalId: id }, body: { clientId: this.clientId } });
      if (!r.data?.streamUrl) throw new ApiError({ status: r.status, code: 'BAD_RESPONSE' });
      return { streamUrl: r.data.streamUrl, tokenValue: r.data.tokenValue, connectBy: r.data.connectBy ?? null, serverNow: this.serverNowOf(r.data.serverNow) };
    };
    let conn: SsmConnectionLike;
    try {
      conn = new mod.SsmTerminalConnection({
        open,
        resume,
        clientId: this.clientId,
        streamUrlPolicy: { ...(this.o.region ? { region: this.o.region } : {}), ...(this.o.allowLoopback ? { allowLoopback: true } : {}) },
      });
    } catch (e) {
      this.set({ phase: 'blocked', error: { code: 'CLIENT_ERROR', message: e instanceof Error ? e.message : null } });
      return;
    }
    this.conn = conn;
    this.connSubs.push(conn.on('state', (e) => this.onState(e)));
    if (this.term) {
      const term = this.term;
      conn.setOutputSink(this.sinkTo(term));
      conn.resize(term.cols, term.rows);
    }
    await conn.start();
  }

  /** 签发时的服务端时间：响应自带的 serverNow，否则服务端时钟在收到时的读数（没有时钟时为 null = 按绝对时间判断）。 */
  private serverNowOf(fromResponse: string | undefined): string | number | null {
    if (fromResponse && Number.isFinite(Date.parse(fromResponse))) return fromResponse;
    return this.o.clock ? this.o.clock.now() : null;
  }

  private onState(e: SsmStateChange): void {
    const phase = phaseOf(e.state);
    if (e.state === 'failed' && e.failure) {
      const err = e.failure.error;
      if (e.failure.reason === 'open-failed') {
        this.set({ phase: 'blocked', error: isApiError(err) ? { code: String(err.code), message: err.detail ?? err.title, requestId: err.requestId } : { code: 'NETWORK', message: e.failure.message } });
        return;
      }
      if (this.snap.phase === 'reconnecting') this.o.report?.('workspace.terminal_reconnected', { terminalId: this.snap.terminalId, attempt: this.snap.attempt, result: e.failure.reason });
      this.set({ phase, reason: e.failure.reason, error: { code: isApiError(err) ? String(err.code) : e.failure.reason, message: e.failure.message } });
      if (e.failure.reason === 'handshake-timeout' || e.failure.reason === 'connect-failed' || e.failure.reason === 'invalid-stream-url') void this.deleteRemote();
      return;
    }
    if (e.state === 'closed') {
      const r = e.closed?.reason;
      const reason = r === 'access-revoked' ? 'revoked' : r === 'user' ? (this.snap.reason === 'ended' ? 'ended' : 'user') : this.closedReason();
      this.set({ phase, reason, closedOutput: e.closed?.output ?? null, busy: false });
      return;
    }
    if (e.state === 'ready' && this.snap.phase === 'reconnecting') this.o.report?.('workspace.terminal_reconnected', { terminalId: this.snap.terminalId, attempt: this.snap.attempt, result: 'ok' });
    this.set({
      phase,
      ...(e.reconnect ? { attempt: e.reconnect.attempt, maxAttempts: e.reconnect.maxAttempts } : {}),
      ...(phase === 'ready' ? { error: null, reason: null } : {}),
    });
    if (phase === 'ready' && this.term) this.conn?.resize(this.term.cols, this.term.rows);
  }

  /** channel_closed：按空闲时长或会话时长判断是“空闲断开”还是“达到最长时长”（03 §3.9）。 */
  private closedReason(): string {
    const now = Date.now();
    const idleMs = (this.snap.idleTimeoutMin ?? 20) * 60_000;
    const maxMs = (this.snap.maxDurationMin ?? 240) * 60_000;
    if (this.snap.openedAt && now - this.snap.openedAt >= maxMs - 60_000) return 'max-duration';
    const last = this.conn?.lastInputAt ?? this.conn?.readyAt ?? this.snap.openedAt;
    if (last && now - last >= idleMs - 60_000) return 'idle';
    return 'channel-closed';
  }

  /** 等待 Ready（目标终端未打开时先打开；超时与握手超时一致）。 */
  ensureReady(timeoutMs = READY_WAIT_MS): Promise<boolean> {
    if (this.snap.phase === 'ready') return Promise.resolve(true);
    if (this.snap.phase === 'blocked') return Promise.resolve(false);
    if (['idle', 'failed', 'closed'].includes(this.snap.phase)) void this.open();
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.readyWaiters.push((ok) => {
        clearTimeout(t);
        resolve(ok);
      });
    });
  }

  /**
   * 等 shell 显示提示符（OSC 133 B，或 bracketed paste 已开启；只见到 OSC 133 A 时再等 PROMPT_GRACE_MS），之后
   * `bracketedPaste` 与 `busy` 才反映 shell 的真实状态（03 §7.1）。时限从 Ready 且 xterm 已接上起算，所以对已经用了一阵的
   * 终端（没有 shell 集成也没有 bracketed paste）不会每次都等。true = 已见到提示符；false = 超时、未连接或已关闭。
   */
  waitForPrompt(timeoutMs = PROMPT_WAIT_MS): Promise<boolean> {
    const settled = (): boolean | null => {
      if (this.disposed || this.snap.phase !== 'ready') return false;
      if (this.promptMark === 'end' || this.bracketedPaste) return true;
      if (this.promptMark === 'start' && Date.now() - this.promptAt >= PROMPT_GRACE_MS) return true;
      return null;
    };
    const now = settled();
    if (now !== null) return Promise.resolve(now);
    const since = Math.max(this.readyAt ?? Date.now(), this.attachedAt ?? Date.now());
    const left = since + timeoutMs - Date.now();
    if (left <= 0 && this.promptMark === 'none') return Promise.resolve(false);
    return new Promise((resolve) => {
      let grace: ReturnType<typeof setTimeout> | null = null;
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        this.promptWaiters.delete(check);
        resolve(ok);
      };
      const check = () => {
        const r = settled();
        if (r !== null) return finish(r);
        if (this.promptMark === 'start' && !grace) grace = setTimeout(check, Math.max(0, PROMPT_GRACE_MS - (Date.now() - this.promptAt)));
      };
      const timer = setTimeout(() => finish(this.promptMark !== 'none' && !this.disposed && this.snap.phase === 'ready'), Math.max(0, left));
      this.promptWaiters.add(check);
      check();
    });
  }

  /** 粘贴（xterm.js paste() 处理 bracketed paste 与换行转换）；execute 时再发一个回车。 */
  paste(text: string, execute = false): boolean {
    if (this.snap.phase !== 'ready' || !this.term) return false;
    this.term.paste(text);
    if (execute) this.conn?.sendInput('\r');
    return true;
  }

  /** 附加按键条（Esc、Tab、方向键……）发送原始序列。 */
  sendRaw(seq: string): void {
    if (this.snap.phase === 'ready') this.conn?.sendInput(seq);
  }

  focus(): void {
    this.term?.focus();
  }

  retryNow(): void {
    if (this.snap.phase === 'reconnecting') this.conn?.retryNow();
    else void this.open();
  }

  /** 访问已收回（session.access_revoked）：立即关闭连接，不再调用任何终端接口。 */
  revoke(): void {
    this.revoked = true;
    this.conn?.close('access-revoked');
    this.set({ phase: 'closed', reason: 'revoked', busy: false });
  }

  /** 用户“结束会话”或关闭子标签：DELETE + 关闭。 */
  async end(): Promise<void> {
    this.set({ reason: 'ended' });
    this.conn?.close('user');
    await this.deleteRemote();
    this.set({ phase: 'closed', reason: 'ended', busy: false });
  }

  private async deleteRemote(): Promise<void> {
    const id = this.snap.terminalId;
    if (!id || this.revoked) return;
    try {
      await this.o.api.call('deleteTerminal', { params: { sid: this.o.sid, terminalId: id } });
    } catch {
      /* 尽力而为：服务端对账会把僵尸会话标为 CLOSED（03 §3.2 第 2 步） */
    }
  }

  private teardownConn(): void {
    for (const d of this.connSubs.splice(0)) d();
    const c = this.conn;
    this.conn = null;
    try {
      c?.dispose();
    } catch {
      /* 忽略 */
    }
  }

  /** 组件卸载：关闭连接并尽力结束 SSM 会话（页面刷新时 pagehide 也走这里，03 §3.5.9）。 */
  dispose(opts: { deleteRemote?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    if (opts.deleteRemote !== false) void this.deleteRemote();
    this.teardownConn();
    for (const s of this.termSubs.splice(0)) s.dispose();
    this.flushWaiters(false);
    this.notifyPrompt();
    this.listeners.clear();
  }
}

/** 覆盖层（03 §3.9 / 08 P05.6 表）。 */
export type OverlayKind =
  | 'connecting'
  | 'agent-offline'
  | 'not-prepared'
  | 'access-denied'
  | 'invalid-document'
  | 'handshake-timeout'
  | 'reconnecting'
  | 'idle'
  | 'max-duration'
  | 'replaced'
  | 'expected-outage'
  | 'reauth'
  | 'revoked'
  | 'limit'
  | 'unavailable'
  | 'closed'
  | 'error';

export function overlayOf(s: TermSnapshot, ctx: { expectedOutage: boolean; replaced: boolean }): OverlayKind | null {
  if (s.reason === 'revoked') return 'revoked';
  if (ctx.replaced) return 'replaced';
  const code = s.error?.code ?? '';
  if (s.phase === 'blocked') {
    if (code === 'TERMINAL_TARGET_NOT_CONNECTED') return ctx.expectedOutage ? 'expected-outage' : 'agent-offline';
    if (code === 'TERMINAL_TARGET_NOT_PREPARED') return 'not-prepared';
    if (code === 'REAUTH_REQUIRED') return 'reauth';
    if (code === 'TERMINAL_SESSION_STATE') return 'revoked';
    if (code === 'TERMINAL_LIMIT' || code === 'RATE_LIMITED') return 'limit';
    if (/AccessDenied|ACCESS_DENIED|FORBIDDEN/.test(code)) return 'access-denied';
    if (/InvalidDocument|INVALID_DOCUMENT/.test(code)) return 'invalid-document';
    if (code === 'NOT_IMPLEMENTED' || code === 'UPSTREAM_UNAVAILABLE' || code === 'CLIENT_UNAVAILABLE' || code === 'CLIENT_ERROR') return 'unavailable';
    return 'error';
  }
  switch (s.phase) {
    case 'requesting':
    case 'connecting':
    case 'handshaking':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'failed':
      if (s.reason === 'handshake-timeout') return 'handshake-timeout';
      if (s.reason === 'gone') return 'closed';
      return ctx.expectedOutage ? 'expected-outage' : 'error';
    case 'closed':
      if (s.reason === 'idle') return 'idle';
      if (s.reason === 'max-duration') return 'max-duration';
      if (s.reason === 'ended' || s.reason === 'user') return 'closed';
      return 'closed';
    default:
      return null;
  }
}
