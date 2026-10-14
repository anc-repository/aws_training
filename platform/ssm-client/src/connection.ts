/**
 * One web terminal = one Session Manager session driven over a WebSocket (03 §3.5.1, §3.5.4, §3.5.6–§3.5.10).
 *
 * State machine (03 §3.5.9):
 *
 *   idle → requesting (open(): POST …/terminals) → connecting (new WebSocket(streamUrl))
 *        → authenticating (OpenDataChannel sent) → handshaking (HandshakeRequest) → ready (HandshakeComplete)
 *                                                 → ready (first Output: handshake skipped)
 *   ready → reconnecting (socket lost, not channel_closed; backoff) → resuming (resume(): POST …/resume)
 *         → connecting → ready (resumed: unacknowledged messages re-sent, size re-sent)
 *   * → failed (handshake timeout, KMS / session type rejected, resume gone / rejected / exhausted, …)
 *   * → closed (channel_closed, user, session.access_revoked)
 *
 * Sources: aws/session-manager-plugin `src/datachannel/streaming.go` (`FinalizeDataChannelHandshake`, `Open`,
 * `Reconnect` — sequence numbers and buffers survive a reconnect), `src/sessionmanagerplugin/session/sessionhandler.go`
 * (`ProcessFirstMessage`, `ResumeSessionHandler` → ResumeSession → new token / StreamUrl → `Reconnect`),
 * `src/sessionmanagerplugin/session/shellsession/shellsession.go` (terminal size as `SizeData` input), checked 2026-10-14.
 *
 * Choices where the sources are silent (docs/implementation-notes.md `## platform-ssm-client`):
 * - A socket lost before the first Ready fails the terminal (`connect-failed`); only a session that was Ready resumes.
 * - After a resume the terminal is Ready as soon as OpenDataChannel is sent (an idle shell sends nothing, so waiting
 *   for output would time out); a HandshakeRequest arriving later is still answered. The reconnect attempt counter is
 *   reset by the first frame received on the new socket (the re-sent size is always acknowledged).
 * - Output that arrives while the handshake is in progress is shown but does not end the handshake.
 */
import { DEFAULT_BACKOFF, backoffDelay, initialDelay, type BackoffPolicy } from './backoff.js';
import { chunkUtf8, toBytes, utf8Encode } from './bytes.js';
import { DataChannel, type ChannelEvent, type ChannelStats, type ChannelTiming } from './channel.js';
import type { DecodedClientMessage } from './codec.js';
import {
  HANDSHAKE_TIMEOUT_MS,
  MessageType,
  PENDING_INPUT_LIMIT_BYTES,
  PROTOCOL_COMPAT_VERSION,
  PayloadType,
  STREAM_DATA_PAYLOAD_SIZE,
} from './constants.js';
import { encodeHandshakeResponse, parseHandshakeComplete, parseHandshakeRequest, processHandshakeRequest } from './handshake.js';
import { buildOpenDataChannel, decodeChannelClosed, encodeSize, isValidSize, type TerminalSize } from './payloads.js';
import { WS_OPEN, defaultWebSocketFactory, type WebSocketFactory, type WebSocketLike } from './socket.js';
import { checkStreamUrl, type StreamUrlPolicy } from './streamUrl.js';
import { defaultTimers, type Timers } from './timers.js';
import { randomUuid } from './uuid.js';

export type TerminalState =
  | 'idle'
  | 'requesting'
  | 'connecting'
  | 'authenticating'
  | 'handshaking'
  | 'ready'
  | 'reconnecting'
  | 'resuming'
  | 'failed'
  | 'closed';

export type FailureReason =
  /** `open()` (POST …/terminals) threw; `error` carries the API error. */
  | 'open-failed'
  | 'invalid-stream-url'
  /** The WebSocket closed before the session ever became Ready (token rejected, Origin rejected, network). */
  | 'connect-failed'
  /** 03 §3.5.4: no HandshakeRequest / Output (or no HandshakeComplete) within the timeout. */
  | 'handshake-timeout'
  /** The agent asked for KMS session encryption (ATL-SessionShell must not set kmsKeyId). */
  | 'kms-unsupported'
  | 'session-type-unsupported'
  /** `resume()` reported the SSM session as terminated (409 TERMINAL_GONE). */
  | 'gone'
  /** `resume()` failed with a non-retryable error (e.g. 403 REAUTH_REQUIRED, 409 TERMINAL_SESSION_STATE). */
  | 'resume-rejected'
  | 'reconnect-exhausted'
  /** The socket was lost and no `resume` function was given. */
  | 'connection-lost';

export type CloseReason = 'channel-closed' | 'user' | 'access-revoked';

export interface StreamCredentials {
  streamUrl: string;
  tokenValue: string;
  /** 03 §3.2 `connectBy` (ISO string, epoch ms or Date): after it the token is not used; the connection resumes instead. */
  connectBy?: string | number | Date | null;
  /**
   * The server's clock when the credentials were issued (the API's `serverNow`, or the caller's server-clock estimate at
   * receipt). With it `connectBy` is judged relatively — receipt + (connectBy − serverNow) on the local clock — so a
   * browser clock that runs ahead of the server does not turn every fresh token into an expired one. Without it
   * `connectBy` is compared with `now()` directly.
   */
  serverNow?: string | number | Date | null;
}

export interface StateChange {
  state: TerminalState;
  previous: TerminalState;
  failure?: { reason: FailureReason; message: string; error?: unknown; closeCode?: number };
  closed?: { reason: CloseReason; output?: string };
  reconnect?: { attempt: number; maxAttempts: number; delayMs?: number; waitingForNetwork?: boolean };
  /** On `ready`: true when this Ready follows a resume (03 §3.9 “已重新连接”). */
  resumed?: boolean;
}

export interface HandshakeInfo {
  skipped: boolean;
  agentVersion: string;
  sessionType: string | null;
  customerMessage: string;
}

export type ConnectionDiagnostic =
  | ChannelEvent
  | { type: 'publication'; paused: boolean }
  | { type: 'exit-code'; code: string }
  | { type: 'input-dropped'; bytes: number }
  | { type: 'text-frame'; length: number }
  | { type: 'unknown-message-type'; messageType: string }
  | { type: 'socket-error' };

export interface TerminalEvents {
  state: StateChange;
  handshake: HandshakeInfo;
  diagnostic: ConnectionDiagnostic;
}

/** Receives terminal output bytes; call `done()` once they are consumed (xterm.js `write` callback) — that sends the acknowledge. */
export type OutputSink = (data: Uint8Array, done: () => void) => void;

export interface NetworkStatus {
  isOnline(): boolean;
  /** Subscribes to the `online` event; returns the unsubscribe function. */
  onOnline(cb: () => void): () => void;
}

export type ResumeErrorKind = 'retry' | 'gone' | 'fatal';

export interface SsmTerminalConnectionOptions {
  /** POST /sessions/{sid}/terminals → `{ streamUrl, tokenValue, connectBy }`. */
  open: () => Promise<StreamCredentials>;
  /** POST /sessions/{sid}/terminals/{terminalId}/resume. Without it a lost socket fails the terminal. */
  resume?: () => Promise<StreamCredentials>;
  /** Fixed per browser tab (03 §3.5.1); see `getTabClientId`. Also sent in the POST bodies by the caller. */
  clientId: string;
  /** Defaults to PROTOCOL_COMPAT_VERSION (the API's `clientVersion` field, when present, should be passed here). */
  clientVersion?: string;
  streamUrlPolicy?: StreamUrlPolicy;
  classifyResumeError?: (err: unknown) => ResumeErrorKind;
  onOutput?: OutputSink;
  webSocketFactory?: WebSocketFactory;
  /** 03 §3.5.4 (15 s). Also bounds opening the socket. */
  handshakeTimeoutMs?: number;
  backoff?: Partial<BackoffPolicy>;
  /** 03 §3.5.8 `terminal.keepalive = size-nudge`: re-send the current size every n ms while Ready (0 = off, the default). */
  sizeNudgeIntervalMs?: number;
  /** Re-acknowledge duplicates (agent behaviour). Off by default like the plugin; a PoC item (03 §3.5.5). */
  reackDuplicates?: boolean;
  channelTiming?: Partial<ChannelTiming>;
  network?: NetworkStatus;
  now?: () => number;
  random?: () => number;
  timers?: Timers;
}

/** The browser's online/offline signal (03 §3.5.9: while offline the attempts are not counted). */
export function browserNetworkStatus(): NetworkStatus {
  const g = globalThis as { navigator?: { onLine?: boolean }; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
  return {
    isOnline: () => g.navigator?.onLine !== false,
    onOnline: (cb) => {
      if (typeof g.addEventListener !== 'function') return () => {};
      g.addEventListener('online', cb);
      return () => g.removeEventListener?.('online', cb);
    },
  };
}

/** Network errors, 408, 429 and 5xx are retried; TERMINAL_GONE is `gone`; any other HTTP error is fatal. */
export function defaultClassifyResumeError(err: unknown): ResumeErrorKind {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; status?: unknown };
  if (e.code === 'TERMINAL_GONE') return 'gone';
  if (e.code === 'NETWORK') return 'retry';
  const status = typeof e.status === 'number' ? e.status : 0;
  if (status === 0 || status === 408 || status === 429 || status >= 500) return 'retry';
  return 'fatal';
}

function deadlineOf(v: StreamCredentials['connectBy']): number | null {
  if (v === undefined || v === null) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * `connectBy` on the local clock (`now()`): relative to `serverNow` when the caller gave it (03 §3.2 step 10; the
 * server's and the browser's clocks may differ by minutes), otherwise the absolute instant.
 */
export function localConnectDeadline(creds: Pick<StreamCredentials, 'connectBy' | 'serverNow'>, receivedAt: number): number | null {
  const connectBy = deadlineOf(creds.connectBy);
  if (connectBy === null) return null;
  const serverNow = deadlineOf(creds.serverNow);
  return serverNow === null ? connectBy : receivedAt + (connectBy - serverNow);
}

type Listener<K extends keyof TerminalEvents> = (e: TerminalEvents[K]) => void;

export class SsmTerminalConnection {
  private readonly opts: SsmTerminalConnectionOptions;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly network: NetworkStatus;
  private readonly backoff: BackoffPolicy;
  private readonly handshakeTimeoutMs: number;
  private readonly clientVersion: string;
  private readonly factory: WebSocketFactory;
  private readonly channel: DataChannel;
  private readonly listeners: { [K in keyof TerminalEvents]: Set<Listener<K>> } = { state: new Set(), handshake: new Set(), diagnostic: new Set() };

  private stateValue: TerminalState = 'idle';
  private ws: WebSocketLike | null = null;
  private wsGen = 0;
  /** OpenDataChannel has been sent on the current socket: binary frames may follow. */
  private socketReady = false;
  private everReady = false;
  private timer: unknown = null;
  private reconnectTimer: unknown = null;
  private nudgeTimer: unknown = null;
  private unsubscribeOnline: (() => void) | null = null;
  private reconnectAttempt = 0;
  private episodeInitialDelay: number | null = null;
  private pendingInput: Uint8Array[] = [];
  private pendingInputBytes = 0;
  private size: TerminalSize | null = null;
  private lastSentSize: TerminalSize | null = null;
  private sink: OutputSink | null;
  private pendingOutput: Uint8Array[] = [];
  private handshakeInfo: HandshakeInfo | null = null;
  private readyAtValue: number | null = null;
  private lastInputAtValue: number | null = null;
  private reconnects = 0;

  constructor(opts: SsmTerminalConnectionOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? defaultTimers();
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.network = opts.network ?? browserNetworkStatus();
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.clientVersion = opts.clientVersion ?? PROTOCOL_COMPAT_VERSION;
    this.factory = opts.webSocketFactory ?? defaultWebSocketFactory;
    this.sink = opts.onOutput ?? null;
    this.channel = new DataChannel({
      role: 'client',
      transmit: (frame) => this.transmit(frame),
      onStreamData: (msg, ack) => this.onStreamData(msg, ack),
      onControl: (msg) => this.onControl(msg),
      onEvent: (e) => this.onChannelEvent(e),
      reackDuplicates: opts.reackDuplicates ?? false,
      timing: opts.channelTiming,
      now: this.now,
      timers: this.timers,
    });
  }

  get state(): TerminalState {
    return this.stateValue;
  }

  get handshake(): HandshakeInfo | null {
    return this.handshakeInfo;
  }

  /** For the 03 §3.9 classification of channel_closed (idle vs. maximum duration). */
  get readyAt(): number | null {
    return this.readyAtValue;
  }

  get lastInputAt(): number | null {
    return this.lastInputAtValue;
  }

  get currentSize(): TerminalSize | null {
    return this.size;
  }

  diagnostics(): { state: TerminalState; nextSequenceNumber: number; expectedSequenceNumber: number; unacknowledged: number; bufferedIncoming: number; rtoMs: number; reconnects: number; stats: ChannelStats } {
    return {
      state: this.stateValue,
      nextSequenceNumber: this.channel.nextSequenceNumber,
      expectedSequenceNumber: this.channel.expectedSequenceNumber,
      unacknowledged: this.channel.unacknowledgedCount,
      bufferedIncoming: this.channel.bufferedIncomingCount,
      rtoMs: this.channel.retransmissionTimeoutMs,
      reconnects: this.reconnects,
      stats: this.channel.stats,
    };
  }

  on<K extends keyof TerminalEvents>(type: K, fn: Listener<K>): () => void {
    const set = this.listeners[type] as Set<Listener<K>>;
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Output is buffered (and acknowledged) until a sink is attached. */
  setOutputSink(sink: OutputSink | null): void {
    this.sink = sink;
    if (!sink) return;
    const pending = this.pendingOutput;
    this.pendingOutput = [];
    for (const data of pending) sink(data, () => {});
  }

  /** Requests the session (open()) and connects. */
  async start(): Promise<void> {
    if (this.stateValue !== 'idle') throw new Error(`ssm-client: start() in state ${this.stateValue}`);
    this.setState('requesting');
    let creds: StreamCredentials;
    try {
      creds = await this.opts.open();
    } catch (error) {
      if (this.is('requesting')) this.fail('open-failed', error instanceof Error ? error.message : 'open failed', { error });
      return;
    }
    if (!this.is('requesting')) return; // closed meanwhile
    this.openSocket(creds);
  }

  /**
   * Keystrokes / pasted text. Strings are UTF-8 encoded; a lone "\n" becomes "\r" (plugin `SendInputDataMessage`);
   * payloads are split at 1024 bytes on UTF-8 boundaries (03 §3.5.7). Queued until Ready (also while reconnecting).
   * Returns false when the input was not accepted (terminal ended, or the queue is full).
   */
  sendInput(data: string | Uint8Array): boolean {
    if (this.stateValue === 'failed' || this.stateValue === 'closed') return false;
    let bytes = typeof data === 'string' ? utf8Encode(data) : data;
    if (bytes.length === 0) return true;
    if (bytes.length === 1 && bytes[0] === 0x0a) bytes = Uint8Array.of(0x0d);
    this.lastInputAtValue = this.now();
    if (this.stateValue === 'ready') {
      this.flushInput();
      for (const chunk of chunkUtf8(bytes, STREAM_DATA_PAYLOAD_SIZE)) this.channel.sendStreamData(PayloadType.Output, chunk);
      return true;
    }
    if (this.pendingInputBytes + bytes.length > PENDING_INPUT_LIMIT_BYTES) {
      this.emit('diagnostic', { type: 'input-dropped', bytes: bytes.length });
      return false;
    }
    this.pendingInput.push(bytes.slice());
    this.pendingInputBytes += bytes.length;
    return true;
  }

  /** Terminal size from xterm.js (Fit add-on); sent only when it changed (and once on Ready / after a resume). */
  resize(cols: number, rows: number): void {
    const s = { cols, rows };
    if (!isValidSize(s)) return;
    this.size = s;
    if (this.stateValue !== 'ready') return;
    if (this.lastSentSize && this.lastSentSize.cols === cols && this.lastSentSize.rows === rows) return;
    this.sendSize();
  }

  /** “立即重试” while waiting between reconnect attempts. */
  retryNow(): void {
    if (this.stateValue !== 'reconnecting') return;
    this.clearReconnectWait();
    void this.resumeNow();
  }

  /** Closes the WebSocket; the SSM session itself is ended by the caller (DELETE …/terminals/{terminalId}). */
  close(reason: Exclude<CloseReason, 'channel-closed'> = 'user'): void {
    if (this.stateValue === 'closed' || this.stateValue === 'failed') return;
    this.teardown(1000, reason);
    this.setState('closed', { closed: { reason } });
  }

  dispose(): void {
    this.close('user');
    this.channel.dispose();
    for (const set of Object.values(this.listeners)) set.clear();
  }

  // ---------------------------------------------------------------- socket

  private openSocket(creds: StreamCredentials): void {
    const check = checkStreamUrl(creds.streamUrl, this.opts.streamUrlPolicy);
    if (!check.ok) {
      this.fail('invalid-stream-url', check.reason);
      return;
    }
    // openSocket runs right after open() / resume() resolved: now() is the moment the credentials were received
    const receivedAt = this.now();
    const deadline = localConnectDeadline(creds, receivedAt);
    if (deadline !== null && receivedAt > deadline && this.opts.resume) {
      // 03 §3.2 step 10 / §3.8: a token past connectBy is not used; get a new one with ResumeSession.
      this.scheduleReconnect();
      return;
    }
    const gen = ++this.wsGen;
    this.socketReady = false;
    this.setState('connecting');
    let ws: WebSocketLike;
    try {
      ws = this.factory(check.url);
      ws.binaryType = 'arraybuffer';
    } catch (error) {
      this.onSocketLost(gen, undefined, error instanceof Error ? error.message : 'WebSocket could not be created');
      return;
    }
    this.ws = ws;
    let token: string | null = creds.tokenValue;
    ws.onopen = () => {
      if (gen !== this.wsGen || token === null) return;
      const tokenValue = token;
      token = null; // 03 §3.8: the token lives in memory only until it is used
      this.onSocketOpen(ws, tokenValue);
    };
    ws.onmessage = (ev) => {
      if (gen === this.wsGen) this.onSocketMessage(ev.data);
    };
    ws.onerror = () => {
      if (gen === this.wsGen) this.emit('diagnostic', { type: 'socket-error' });
    };
    ws.onclose = (ev) => {
      token = null;
      this.onSocketLost(gen, ev?.code, ev?.reason ? `WebSocket closed: ${ev.reason}` : undefined);
    };
    this.startTimer(() => this.onConnectTimeout(gen));
  }

  private onSocketOpen(ws: WebSocketLike, tokenValue: string): void {
    ws.send(buildOpenDataChannel({ tokenValue, clientId: this.opts.clientId, clientVersion: this.clientVersion, requestId: randomUuid() }));
    this.socketReady = true;
    this.channel.start();
    if (!this.everReady) {
      this.setState('authenticating');
      this.startTimer(() => this.onConnectTimeout(this.wsGen));
      return;
    }
    // Resumed (03 §3.5.5, §3.5.9): same sequence numbers and buffers; re-send what was not acknowledged.
    this.clearTimer();
    this.reconnects++;
    this.channel.resendUnacknowledged();
    this.enterReady(true);
  }

  private onSocketMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.emit('diagnostic', { type: 'text-frame', length: data.length });
      return;
    }
    const bytes = toBytes(data);
    if (!bytes) return;
    if (this.everReady && this.reconnectAttempt > 0) {
      this.reconnectAttempt = 0;
      this.episodeInitialDelay = null;
    }
    this.channel.receive(bytes);
  }

  private onSocketLost(gen: number, closeCode: number | undefined, detail: string | undefined): void {
    if (gen !== this.wsGen) return;
    this.dropSocket();
    if (this.stateValue === 'closed' || this.stateValue === 'failed') return;
    if (!this.everReady) {
      this.fail('connect-failed', detail ?? `WebSocket closed${closeCode !== undefined ? ` (code ${closeCode})` : ''} before the terminal was ready`, { closeCode });
      return;
    }
    this.scheduleReconnect();
  }

  private onConnectTimeout(gen: number): void {
    if (gen !== this.wsGen) return;
    if (this.everReady && this.stateValue === 'connecting') {
      // a resumed socket that does not open: next attempt
      this.dropSocket();
      this.scheduleReconnect();
      return;
    }
    if (this.stateValue === 'connecting' || this.stateValue === 'authenticating' || this.stateValue === 'handshaking') {
      this.fail('handshake-timeout', 'The instance did not respond');
    }
  }

  private transmit(frame: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || !this.socketReady || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  /** Detaches and closes the current socket; its late events are ignored. */
  private dropSocket(code = 1000, reason = ''): void {
    const ws = this.ws;
    this.ws = null;
    this.socketReady = false;
    this.wsGen++;
    this.channel.stop();
    this.clearTimer();
    this.stopNudge();
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    }
  }

  // ---------------------------------------------------------------- reconnect

  private scheduleReconnect(): void {
    this.clearReconnectWait();
    if (!this.opts.resume) {
      this.fail('connection-lost', 'The connection was lost');
      return;
    }
    const max = this.backoff.maxAttempts;
    if (this.reconnectAttempt >= max) {
      this.fail('reconnect-exhausted', `Reconnect failed after ${max} attempts`);
      return;
    }
    if (!this.network.isOnline()) {
      this.setState('reconnecting', { reconnect: { attempt: this.reconnectAttempt + 1, maxAttempts: max, waitingForNetwork: true } });
      this.unsubscribeOnline = this.network.onOnline(() => {
        if (this.stateValue === 'reconnecting') this.scheduleReconnect();
      });
      return;
    }
    this.episodeInitialDelay ??= initialDelay(this.backoff, this.random);
    const delayMs = backoffDelay(this.reconnectAttempt, this.episodeInitialDelay, this.backoff);
    this.setState('reconnecting', { reconnect: { attempt: this.reconnectAttempt + 1, maxAttempts: max, delayMs } });
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.resumeNow();
    }, delayMs);
  }

  private async resumeNow(): Promise<void> {
    const resume = this.opts.resume;
    if (this.stateValue !== 'reconnecting' || !resume) return;
    this.reconnectAttempt++;
    this.setState('resuming', { reconnect: { attempt: this.reconnectAttempt, maxAttempts: this.backoff.maxAttempts } });
    let creds: StreamCredentials;
    try {
      creds = await resume();
    } catch (error) {
      if (!this.is('resuming')) return;
      const kind = (this.opts.classifyResumeError ?? defaultClassifyResumeError)(error);
      if (kind === 'gone') this.fail('gone', 'The terminal session has ended', { error });
      else if (kind === 'fatal') this.fail('resume-rejected', error instanceof Error ? error.message : 'resume rejected', { error });
      else this.scheduleReconnect();
      return;
    }
    if (!this.is('resuming')) return;
    this.openSocket(creds);
  }

  private clearReconnectWait(): void {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.unsubscribeOnline?.();
    this.unsubscribeOnline = null;
  }

  // ---------------------------------------------------------------- protocol

  private onStreamData(msg: DecodedClientMessage, ack: () => void): void {
    switch (msg.payloadType) {
      case PayloadType.Output:
      case PayloadType.Error:
      case PayloadType.StdErr:
        if (this.stateValue === 'authenticating') {
          // plugin ProcessFirstMessage: the agent skipped the handshake
          this.handshakeInfo = { skipped: true, agentVersion: '', sessionType: null, customerMessage: '' };
          this.emit('handshake', this.handshakeInfo);
          this.enterReady(false);
        }
        this.deliverOutput(msg.payload, ack);
        return;
      case PayloadType.HandshakeRequest:
        this.onHandshakeRequest(msg.payload);
        return;
      case PayloadType.HandshakeComplete: {
        const c = parseHandshakeComplete(msg.payload);
        this.handshakeInfo = { skipped: false, agentVersion: this.handshakeInfo?.agentVersion ?? '', sessionType: this.handshakeInfo?.sessionType ?? null, customerMessage: c.CustomerMessage };
        this.emit('handshake', this.handshakeInfo);
        if (this.stateValue === 'handshaking' || this.stateValue === 'authenticating') this.enterReady(false);
        return;
      }
      case PayloadType.ExitCode:
        this.emit('diagnostic', { type: 'exit-code', code: new TextDecoder().decode(msg.payload) });
        ack();
        return;
      default:
        ack();
    }
  }

  private onHandshakeRequest(payload: Uint8Array): void {
    const req = parseHandshakeRequest(payload) ?? { AgentVersion: '', RequestedClientActions: [] };
    const outcome = processHandshakeRequest(req, this.clientVersion);
    // The response bypasses the input queue: the agent ignores everything else until the handshake completes.
    this.channel.sendStreamData(PayloadType.HandshakeResponse, encodeHandshakeResponse(outcome.response));
    this.handshakeInfo = { skipped: false, agentVersion: outcome.agentVersion, sessionType: outcome.sessionType, customerMessage: '' };
    if (outcome.rejected === 'kms-unsupported') {
      this.fail('kms-unsupported', 'The session document requests KMS encryption, which the web terminal does not support');
      return;
    }
    if (outcome.rejected === 'session-type-unsupported') {
      this.fail('session-type-unsupported', `Unsupported session type ${outcome.sessionType ?? ''}`);
      return;
    }
    if (this.stateValue === 'authenticating' || this.stateValue === 'ready') {
      this.setState('handshaking');
      this.startTimer(() => this.onConnectTimeout(this.wsGen));
    }
  }

  private onControl(msg: DecodedClientMessage): void {
    switch (msg.messageType) {
      case MessageType.ChannelClosed: {
        const c = decodeChannelClosed(msg.payload);
        if (this.stateValue === 'closed' || this.stateValue === 'failed') return;
        this.teardown(1000, 'channel_closed');
        this.setState('closed', { closed: { reason: 'channel-closed', output: c.Output } });
        return;
      }
      case MessageType.StartPublication:
      case MessageType.PausePublication:
        // Flow-control signals; the plugin ignores them (03 §3.5.3). Counted only.
        this.emit('diagnostic', { type: 'publication', paused: msg.messageType === MessageType.PausePublication });
        return;
      default:
        this.emit('diagnostic', { type: 'unknown-message-type', messageType: msg.messageType });
    }
  }

  private onChannelEvent(e: ChannelEvent): void {
    this.emit('diagnostic', e);
    if (e.type === 'resend-exhausted' && this.everReady && this.ws) {
      // 03 §3.5.8: a message beyond the retransmission limit means the connection is dead.
      const gen = this.wsGen;
      this.onSocketLost(gen, undefined, 'retransmission limit reached');
    }
  }

  private enterReady(resumed: boolean): void {
    this.clearTimer();
    this.everReady = true;
    this.readyAtValue ??= this.now();
    this.setState('ready', { resumed });
    // 03 §3.5.6: the current size is sent once on Ready and once after every resume (before queued keystrokes).
    if (this.size) this.sendSize();
    this.flushInput();
    this.startNudge();
  }

  private flushInput(): void {
    const queued = this.pendingInput;
    this.pendingInput = [];
    this.pendingInputBytes = 0;
    for (const bytes of queued) {
      for (const chunk of chunkUtf8(bytes, STREAM_DATA_PAYLOAD_SIZE)) this.channel.sendStreamData(PayloadType.Output, chunk);
    }
  }

  private sendSize(): void {
    if (!this.size) return;
    this.channel.sendStreamData(PayloadType.Size, encodeSize(this.size));
    this.lastSentSize = { ...this.size };
  }

  private deliverOutput(data: Uint8Array, ack: () => void): void {
    const sink = this.sink;
    if (!sink) {
      this.pendingOutput.push(data);
      ack();
      return;
    }
    try {
      sink(data, ack);
    } catch {
      ack();
    }
  }

  // ---------------------------------------------------------------- timers & state

  private startTimer(fn: () => void): void {
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      fn();
    }, this.handshakeTimeoutMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private startNudge(): void {
    const every = this.opts.sizeNudgeIntervalMs ?? 0;
    if (every <= 0 || this.nudgeTimer !== null) return;
    this.nudgeTimer = this.timers.setInterval(() => {
      if (this.stateValue === 'ready') this.sendSize();
    }, every);
  }

  private stopNudge(): void {
    if (this.nudgeTimer === null) return;
    this.timers.clearInterval(this.nudgeTimer);
    this.nudgeTimer = null;
  }

  private teardown(code: number, reason: string): void {
    this.clearReconnectWait();
    this.dropSocket(code, reason);
  }

  private fail(reason: FailureReason, message: string, extra: { error?: unknown; closeCode?: number } = {}): void {
    if (this.stateValue === 'failed' || this.stateValue === 'closed') return;
    this.teardown(1000, reason);
    this.setState('failed', { failure: { reason, message, ...extra } });
  }

  /** Not narrowed by TypeScript across awaits (the state changes while a promise is pending). */
  private is(state: TerminalState): boolean {
    return this.stateValue === state;
  }

  private setState(state: TerminalState, detail: Omit<StateChange, 'state' | 'previous'> = {}): void {
    const previous = this.stateValue;
    this.stateValue = state;
    this.emit('state', { state, previous, ...detail });
  }

  private emit<K extends keyof TerminalEvents>(type: K, e: TerminalEvents[K]): void {
    for (const fn of [...(this.listeners[type] as Set<Listener<K>>)]) {
      try {
        fn(e);
      } catch {
        // a listener error must not break the protocol
      }
    }
  }
}

/** ClientId fixed per browser tab (03 §3.5.1: a UUID kept in sessionStorage). Falls back to a fresh UUID. */
export function getTabClientId(storage?: Pick<Storage, 'getItem' | 'setItem'> | null, key = 'atl.terminal.clientId'): string {
  let store = storage;
  if (store === undefined) {
    try {
      store = (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
    } catch {
      store = null;
    }
  }
  try {
    const existing = store?.getItem(key);
    if (existing) return existing;
  } catch {
    // storage blocked
  }
  const id = randomUuid();
  try {
    store?.setItem(key, id);
  } catch {
    // storage blocked
  }
  return id;
}
