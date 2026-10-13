/**
 * Local mock of the Session Manager service + SSM Agent for dev mode and tests. It speaks the same data-channel
 * protocol as the real service (OpenDataChannel text frame, ClientMessage binary frames, sequencing / acknowledge /
 * retransmission, handshake, Size, channel_closed) and runs a fake shell or an echo. It never contacts AWS.
 *
 * Agent behaviour follows aws/amazon-ssm-agent `agent/session/datachannel/datachannel.go` (checked 2026-10-14):
 * HandshakeRequest → wait for HandshakeResponse → HandshakeComplete; stream data other than the handshake response is
 * acknowledged but ignored while the handshake is in progress; duplicates are re-acknowledged; outgoing output is
 * retransmitted from its own buffer. What the real service does on a bad token, the exact channel_closed texts and
 * whether output is re-sent after ResumeSession are unknown (07 V2-2) — the mock's choices are marked “mock:”.
 */
import { utf8Encode } from '../bytes.js';
import { DataChannel, type ChannelTiming, type TransmitMeta } from '../channel.js';
import { encodeClientMessage, type DecodedClientMessage } from '../codec.js';
import {
  ActionStatus,
  ActionType,
  CLIENT_MESSAGE_SCHEMA_VERSION,
  MessageType,
  PayloadType,
  PayloadTypeFlag,
  SHELL_SESSION_TYPE,
  STREAM_DATA_FLAGS,
} from '../constants.js';
import { encodeHandshakeComplete, encodeHandshakeRequest, parseHandshakeResponse, type HandshakeResponsePayload } from '../handshake.js';
import { decodeSize, encodeChannelClosed, parseOpenDataChannel } from '../payloads.js';
import { defaultTimers, type Timers } from '../timers.js';
import { randomUuid } from '../uuid.js';
import { EchoShell, FakeShell, type ShellLike } from './fakeShell.js';
import type { ServerSocket } from './serverSocket.js';

export type MockHandshakeMode = 'none' | 'session-type' | 'kms';
export type MockShellMode = 'shell' | 'echo';

/** Fault injection on the agent → client path (tests of retransmission, reorder, duplicates, digest errors). */
export interface MockFaults {
  /** Lose this transmission of output `seq` (`attempt` 0 is the first send). */
  dropOutput?(seq: number, attempt: number): boolean;
  /** Send the first transmission of `seq` twice. */
  duplicateOutput?(seq: number): boolean;
  /** Hold the first transmission of `seq` until the next output frame has been sent (reorder). */
  holdOutput?(seq: number): boolean;
  /** Flip a payload byte of this transmission (the client must drop it: digest mismatch, no acknowledge). */
  corruptOutput?(seq: number, attempt: number): boolean;
  /** Lose the agent's acknowledge of client input `seq`. */
  dropAck?(seq: number): boolean;
}

export interface MockSsmServiceOptions {
  mode?: MockShellMode;
  handshake?: MockHandshakeMode;
  agentVersion?: string;
  /** Session document `idleSessionTimeout` (ATL-SessionShell: 20 min). 0 = off. */
  idleTimeoutMs?: number;
  /** Session document `maxSessionDuration` (ATL-SessionShell: 240 min). 0 = off. */
  maxDurationMs?: number;
  /** mock: how long a TokenValue may be used (single use). */
  tokenTtlMs?: number;
  /** Bytes per output message (raw split, may cut UTF-8 sequences like a pty read does). */
  outputChunkSize?: number;
  /** Send `start_publication` after each OpenDataChannel (flow-control signal the client must ignore). */
  publicationSignals?: boolean;
  faults?: MockFaults;
  channelTiming?: Partial<ChannelTiming>;
  /** Base of StreamUrl, e.g. `ws://127.0.0.1:8790` (set by the server). */
  streamOrigin?: string;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
}

export interface StartSessionInput {
  /** Instance ID (informational). */
  Target?: string;
  DocumentName?: string;
  Reason?: string;
  /** Prefix of the SessionId — SSM uses the caller's role session name (03: `atl-<sid>-term`). */
  sessionName?: string;
  /** Prompt / host role of the fake shell. */
  role?: 'lab' | 'workstation';
}

export interface StartSessionOutput {
  SessionId: string;
  StreamUrl: string;
  TokenValue: string;
}

export class MockSsmError extends Error {
  readonly type: string;
  constructor(type: string, message: string) {
    super(message);
    this.name = 'MockSsmError';
    this.type = type;
  }
}

export interface MockSessionInfo {
  sessionId: string;
  target: string;
  status: 'Connecting' | 'Connected' | 'Disconnected' | 'Terminated';
  handshake: 'pending' | 'in-progress' | 'complete' | 'skipped';
  clientId: string | null;
  clientVersion: string | null;
  size: { cols: number; rows: number };
  inputBytes: number;
  ignoredDuringHandshake: number;
  connections: number;
  handshakeResponse: HandshakeResponsePayload | null;
  closedReason: string | null;
  expectedInputSequence: number;
  nextOutputSequence: number;
  /** Output messages the client has not acknowledged yet (back-pressure). */
  unacknowledgedOutput: number;
}

interface Token {
  value: string;
  expiresAt: number;
  used: boolean;
}

const DEFAULT_IDLE_MS = 20 * 60 * 1000;

class MockSession {
  readonly id: string;
  readonly target: string;
  readonly role: 'lab' | 'workstation';
  token: Token | null = null;
  socket: ServerSocket | null = null;
  status: MockSessionInfo['status'] = 'Connecting';
  handshake: MockSessionInfo['handshake'] = 'pending';
  clientId: string | null = null;
  clientVersion: string | null = null;
  size = { cols: 80, rows: 24 };
  inputBytes = 0;
  ignoredDuringHandshake = 0;
  connections = 0;
  handshakeResponse: HandshakeResponsePayload | null = null;
  closedReason: string | null = null;
  shell: ShellLike | null = null;
  readonly channel: DataChannel;
  private held: Uint8Array[] = [];
  private idleTimer: unknown = null;
  private maxTimer: unknown = null;
  private handshakeStartedAt = 0;

  constructor(
    private readonly svc: MockSsmService,
    private readonly opts: Required<Pick<MockSsmServiceOptions, 'mode' | 'handshake' | 'agentVersion' | 'idleTimeoutMs' | 'maxDurationMs' | 'outputChunkSize'>> & MockSsmServiceOptions,
    private readonly timers: Timers,
    private readonly now: () => number,
    input: StartSessionInput,
  ) {
    this.id = `${input.sessionName ?? 'atl-dev-term'}-${randomUuid().replace(/-/g, '').slice(0, 17)}`;
    this.target = input.Target ?? (input.role === 'workstation' ? 'i-0mockworkstation01' : 'i-0mocklabinstance01');
    this.role = input.role ?? 'lab';
    this.channel = new DataChannel({
      role: 'agent',
      transmit: (frame, meta) => this.transmit(frame, meta),
      onStreamData: (msg, ack) => this.onInput(msg, ack),
      onControl: () => {},
      reackDuplicates: true,
      ackBeforeDeliver: () => true,
      timing: opts.channelTiming,
      now,
      timers,
    });
  }

  info(): MockSessionInfo {
    return {
      sessionId: this.id,
      target: this.target,
      status: this.status,
      handshake: this.handshake,
      clientId: this.clientId,
      clientVersion: this.clientVersion,
      size: { ...this.size },
      inputBytes: this.inputBytes,
      ignoredDuringHandshake: this.ignoredDuringHandshake,
      connections: this.connections,
      handshakeResponse: this.handshakeResponse,
      closedReason: this.closedReason,
      expectedInputSequence: this.channel.expectedSequenceNumber,
      nextOutputSequence: this.channel.nextSequenceNumber,
      unacknowledgedOutput: this.channel.unacknowledgedCount,
    };
  }

  issueToken(ttlMs: number): string {
    const value = `mock-token-${randomUuid()}`;
    this.token = { value, expiresAt: this.now() + ttlMs, used: false };
    return value;
  }

  /** A new WebSocket for this session: the first text frame must be OpenDataChannel with the current token. */
  attach(socket: ServerSocket): void {
    let authenticated = false;
    socket.onMessage((data) => {
      if (this.status === 'Terminated') return;
      if (!authenticated) {
        if (typeof data !== 'string') {
          socket.close(1008, 'expected OpenDataChannel');
          return;
        }
        const req = parseOpenDataChannel(data);
        const t = this.token;
        if (!req || !t || t.used || t.value !== req.TokenValue || this.now() > t.expiresAt) {
          // mock: the real service's response to a bad or reused token is not documented (07 V2-2)
          socket.close(1008, 'invalid token');
          return;
        }
        t.used = true;
        authenticated = true;
        this.clientId = req.ClientId;
        this.clientVersion = req.ClientVersion;
        this.onAuthenticated(socket);
        return;
      }
      if (socket !== this.socket || typeof data === 'string') return;
      this.channel.receive(data);
    });
    socket.onClose(() => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.channel.stop();
      if (this.status !== 'Terminated') this.status = 'Disconnected';
    });
  }

  private onAuthenticated(socket: ServerSocket): void {
    const previous = this.socket;
    this.socket = socket;
    this.connections++;
    if (previous && previous !== socket) previous.close(1000, 'replaced');
    this.status = 'Connected';
    this.channel.start();
    if (this.opts.publicationSignals) this.sendControl(MessageType.StartPublication, new Uint8Array(0));
    if (this.handshake === 'pending') {
      if (this.opts.handshake === 'none') {
        this.handshake = 'skipped';
        this.startShell();
      } else {
        this.startHandshake();
      }
      return;
    }
    // Resumed: push everything the client has not acknowledged.
    this.channel.resendUnacknowledged();
  }

  private startHandshake(): void {
    this.handshake = 'in-progress';
    this.handshakeStartedAt = this.now();
    const actions: { ActionType: string; ActionParameters: unknown }[] = [
      { ActionType: ActionType.SessionType, ActionParameters: { SessionType: SHELL_SESSION_TYPE, Properties: null } },
    ];
    if (this.opts.handshake === 'kms') {
      actions.push({ ActionType: ActionType.KMSEncryption, ActionParameters: { KMSKeyId: 'arn:aws:kms:ap-northeast-1:000000000000:key/mock' } });
    }
    this.channel.sendStreamData(PayloadType.HandshakeRequest, encodeHandshakeRequest({ AgentVersion: this.opts.agentVersion, RequestedClientActions: actions }));
  }

  private onInput(msg: DecodedClientMessage, ack: () => void): void {
    ack();
    if (this.status === 'Terminated') return;
    if (this.handshake === 'in-progress') {
      if (msg.payloadType !== PayloadType.HandshakeResponse) {
        this.ignoredDuringHandshake++;
        return;
      }
      const res = parseHandshakeResponse(msg.payload);
      this.handshakeResponse = res;
      const failed = !res || res.ProcessedClientActions.some((a) => a.ActionStatus !== ActionStatus.Success);
      if (failed) {
        // mock: the agent ends the session when a requested action fails
        this.svc.terminate(this.id, `Handshake failed: ${res?.Errors.join('; ') || 'invalid HandshakeResponse'}`);
        return;
      }
      this.handshake = 'complete';
      this.channel.sendStreamData(PayloadType.HandshakeComplete, encodeHandshakeComplete({ HandshakeTimeToComplete: (this.now() - this.handshakeStartedAt) * 1e6, CustomerMessage: '' }));
      this.startShell();
      return;
    }
    switch (msg.payloadType) {
      case PayloadType.Output:
        this.inputBytes += msg.payload.length;
        this.touch();
        this.shell?.input(msg.payload);
        return;
      case PayloadType.Size: {
        const s = decodeSize(msg.payload);
        if (s) {
          this.size = s;
          this.shell?.resize(s.cols, s.rows);
        }
        return;
      }
      case PayloadType.Flag:
        if (msg.payload.length === 4 && new DataView(msg.payload.buffer, msg.payload.byteOffset, 4).getUint32(0) === PayloadTypeFlag.TerminateSession) {
          this.svc.terminate(this.id, '');
        }
        return;
      default:
    }
  }

  private startShell(): void {
    const io = {
      write: (data: string | Uint8Array) => this.writeOutput(typeof data === 'string' ? utf8Encode(data) : data),
      exit: () => this.timers.setTimeout(() => this.svc.terminate(this.id, ''), 0),
    };
    this.shell = this.opts.mode === 'echo'
      ? new EchoShell(io)
      : new FakeShell(io, { role: this.role, cols: this.size.cols, rows: this.size.rows, timers: this.timers });
    this.shell.start();
    this.touch();
    if (this.opts.maxDurationMs > 0) {
      this.maxTimer = this.timers.setTimeout(() => this.svc.terminate(this.id, `mock: session reached the maximum duration of ${Math.round(this.opts.maxDurationMs / 60000)} minutes`), this.opts.maxDurationMs);
    }
  }

  private touch(): void {
    if (this.opts.idleTimeoutMs <= 0) return;
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(() => this.svc.terminate(this.id, `mock: session was idle for ${Math.round(this.opts.idleTimeoutMs / 60000)} minutes`), this.opts.idleTimeoutMs);
  }

  private writeOutput(bytes: Uint8Array): void {
    const n = this.opts.outputChunkSize;
    for (let i = 0; i < bytes.length; i += n) this.channel.sendStreamData(PayloadType.Output, bytes.slice(i, i + n));
  }

  private transmit(frame: Uint8Array, meta: TransmitMeta): boolean {
    const socket = this.socket;
    if (!socket || !socket.isOpen) return false;
    const f = this.opts.faults;
    if (meta.kind === 'ack') {
      if (!f?.dropAck?.(meta.seq)) socket.send(frame);
      return true;
    }
    if (f?.dropOutput?.(meta.seq, meta.attempt)) return true;
    let out = frame;
    if (f?.corruptOutput?.(meta.seq, meta.attempt) && frame.length > 120) {
      out = frame.slice();
      out[out.length - 1] = out[out.length - 1]! ^ 0xff;
    }
    if (meta.attempt === 0 && f?.holdOutput?.(meta.seq)) {
      this.held.push(out);
      return true;
    }
    socket.send(out);
    if (meta.attempt === 0 && f?.duplicateOutput?.(meta.seq)) socket.send(out);
    const held = this.held;
    this.held = [];
    for (const h of held) socket.send(h);
    return true;
  }

  sendControl(messageType: string, payload: Uint8Array): void {
    this.socket?.send(encodeClientMessage({
      messageType,
      schemaVersion: CLIENT_MESSAGE_SCHEMA_VERSION,
      createdDate: BigInt(Math.max(1, Math.floor(this.now()))),
      sequenceNumber: 0n,
      flags: STREAM_DATA_FLAGS,
      messageId: randomUuid(),
      payloadType: PayloadType.None,
      payload,
    }));
  }

  close(output: string): void {
    if (this.status === 'Terminated') return;
    this.status = 'Terminated';
    this.closedReason = output;
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    if (this.maxTimer !== null) this.timers.clearTimeout(this.maxTimer);
    this.shell?.dispose();
    const socket = this.socket;
    this.socket = null;
    this.channel.dispose();
    if (socket) {
      const messageId = randomUuid();
      socket.send(encodeClientMessage({
        messageType: MessageType.ChannelClosed,
        schemaVersion: CLIENT_MESSAGE_SCHEMA_VERSION,
        createdDate: BigInt(Math.max(1, Math.floor(this.now()))),
        sequenceNumber: 0n,
        flags: STREAM_DATA_FLAGS,
        messageId,
        payloadType: PayloadType.None,
        payload: encodeChannelClosed({
          MessageId: messageId,
          CreatedDate: new Date(this.now()).toISOString(),
          DestinationId: this.clientId ?? '',
          SessionId: this.id,
          MessageType: MessageType.ChannelClosed,
          SchemaVersion: 1,
          Output: output,
        }),
      }));
      socket.close(1000, 'channel closed');
    }
  }

  dropConnection(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.channel.stop();
    this.status = 'Disconnected';
    socket.abort();
  }
}

export class MockSsmService {
  private readonly opts: ConstructorParameters<typeof MockSession>[1];
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly sessions = new Map<string, MockSession>();
  private streamOrigin: string;

  constructor(opts: MockSsmServiceOptions = {}) {
    this.opts = {
      ...opts,
      mode: opts.mode ?? 'shell',
      handshake: opts.handshake ?? 'session-type',
      agentVersion: opts.agentVersion ?? '3.3.0.0-mock',
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_MS,
      maxDurationMs: opts.maxDurationMs ?? 0,
      outputChunkSize: Math.max(1, opts.outputChunkSize ?? 1024),
    };
    this.timers = opts.timers ?? defaultTimers();
    this.now = opts.now ?? Date.now;
    this.streamOrigin = opts.streamOrigin ?? 'ws://127.0.0.1';
  }

  setStreamOrigin(origin: string): void {
    this.streamOrigin = origin.replace(/\/+$/, '');
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private urlFor(s: MockSession): string {
    return `${this.streamOrigin}/v1/data-channel/${encodeURIComponent(s.id)}?role=publish_subscribe`;
  }

  /** ssm:StartSession. */
  startSession(input: StartSessionInput = {}): StartSessionOutput {
    const s = new MockSession(this, this.opts, this.timers, this.now, input);
    this.sessions.set(s.id, s);
    const token = s.issueToken(this.opts.tokenTtlMs ?? 60_000);
    this.log(`StartSession ${s.id} target=${s.target}`);
    return { SessionId: s.id, StreamUrl: this.urlFor(s), TokenValue: token };
  }

  /** ssm:ResumeSession — a new single-use token for a session that is not terminated. */
  resumeSession(sessionId: string): StartSessionOutput {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === 'Terminated') throw new MockSsmError('DoesNotExistException', `Session ${sessionId} does not exist or has been terminated`);
    const token = s.issueToken(this.opts.tokenTtlMs ?? 60_000);
    this.log(`ResumeSession ${s.id}`);
    return { SessionId: s.id, StreamUrl: this.urlFor(s), TokenValue: token };
  }

  /** ssm:TerminateSession — the client receives channel_closed. */
  terminateSession(sessionId: string): { SessionId: string } {
    this.terminate(sessionId, '');
    return { SessionId: sessionId };
  }

  /** @internal also used by sessions (idle / max duration / exit / failed handshake). */
  terminate(sessionId: string, output: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.log(`Terminate ${sessionId}${output ? `: ${output}` : ''}`);
    s.close(output);
  }

  /** Simulates a network failure on the session's current socket (no channel_closed). */
  dropConnection(sessionId: string): void {
    this.sessions.get(sessionId)?.dropConnection();
  }

  /** Accepts a data-channel WebSocket for `/v1/data-channel/{sessionId}`. */
  attach(socket: ServerSocket, sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === 'Terminated') {
      socket.close(1008, 'unknown session');
      return;
    }
    s.attach(socket);
  }

  /** Same, with the session taken from a StreamUrl / request path. */
  attachByUrl(socket: ServerSocket, url: string): void {
    const m = /\/v1\/data-channel\/([^/?#]+)/.exec(url);
    if (!m) {
      socket.close(1008, 'bad path');
      return;
    }
    this.attach(socket, decodeURIComponent(m[1]!));
  }

  getSession(sessionId: string): MockSessionInfo | null {
    return this.sessions.get(sessionId)?.info() ?? null;
  }

  listSessions(): MockSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /** Terminates every session. */
  close(): void {
    for (const id of this.sessions.keys()) this.terminate(id, 'mock: service stopped');
  }
}
