/**
 * Reliable stream layer of the data channel (03 §3.5.5): sequence numbers, acknowledge, outgoing buffer with
 * retransmission and an RFC 6298-style RTO, incoming reorder buffer, duplicate drop. Transport-agnostic (it only sees
 * frames), so it is unit-tested without WebSockets and reused by the local mock agent with `role: 'agent'`.
 *
 * Sources (checked 2026-10-14):
 * - aws/session-manager-plugin `src/datachannel/streaming.go`:
 *   `SendInputDataMessage` (Flags 0, SequenceNumber = StreamDataSequenceNumber, then ++; message kept in
 *   OutgoingMessageBuffer with LastSentTime), `SendAcknowledgeMessage` (AcknowledgeContent copied from the received
 *   message, IsSequentialMessage true), `ProcessAcknowledgedMessage` (remove by sequence number, update RTO),
 *   `CalculateRetransmissionTimeout`, `ResendStreamDataMessageScheduler` (every ResendSleepInterval look at the
 *   *front* of the outgoing buffer; resend if older than the RTO; signal a timeout after ResendMaxAttempt),
 *   `HandleOutputMessage` (seq == expected: process, ack, expected++, drain the incoming buffer;
 *   seq > expected: ack and buffer if there is room, else drop without ack; seq < expected: drop, no ack;
 *   handshake request/complete and encryption challenge are acked *before* processing),
 *   `AddDataToOutgoingMessageBuffer` (when full, the oldest entry is dropped).
 * - aws/session-manager-plugin `src/message/messageparser.go` `SerializeClientMessageWithAcknowledgeContent`
 *   (acknowledge: SchemaVersion 1, SequenceNumber 0, Flags 3, new MessageId, PayloadType left at 0).
 * - aws/amazon-ssm-agent `agent/session/datachannel/datachannel.go` — the agent side is symmetric; it *re-sends the
 *   acknowledge* for duplicates (“Resending acknowledge for already processed message”), hence `reackDuplicates`.
 *
 * Deviations (03 §3.5.5, §3.5.7):
 * - A data message whose transmit fails (socket not open) is still numbered and buffered; it goes out with
 *   `resendUnacknowledged()` after the connection is resumed (the plugin drops input on a send error).
 * - The ack of an output payload can be deferred until the sink calls `ack()` (xterm.js `write` callback: back-pressure).
 *   An ack that cannot be transmitted is kept and sent first after a resume.
 * - The plugin keeps resending the front message after ResendMaxAttempt; here it is reported once
 *   (`resend-exhausted`) and the owner treats the connection as dead (03 §3.5.8).
 */
import { decodeAcknowledgeContent, encodeAcknowledgeContent } from './payloads.js';
import { decodeAndValidate, encodeClientMessage, ProtocolError, type DecodedClientMessage } from './codec.js';
import {
  ACKNOWLEDGE_FLAGS,
  CLIENT_MESSAGE_SCHEMA_VERSION,
  CLOCK_GRANULARITY_MS,
  DEFAULT_ROUND_TRIP_TIME_MS,
  DEFAULT_ROUND_TRIP_TIME_VARIATION_MS,
  DEFAULT_TRANSMISSION_TIMEOUT_MS,
  INCOMING_MESSAGE_BUFFER_CAPACITY,
  MAX_TRANSMISSION_TIMEOUT_MS,
  MessageType,
  OUTGOING_MESSAGE_BUFFER_CAPACITY,
  PayloadType,
  RESEND_MAX_ATTEMPT,
  RESEND_SLEEP_INTERVAL_MS,
  RTT_CONSTANT,
  RTTV_CONSTANT,
  STREAM_DATA_FLAGS,
} from './constants.js';
import { defaultTimers, type Timers } from './timers.js';
import { randomUuid } from './uuid.js';

export type ChannelRole = 'client' | 'agent';

export interface ChannelTiming {
  resendIntervalMs: number;
  initialRtoMs: number;
  initialRttMs: number;
  initialRttVarMs: number;
  maxRtoMs: number;
  clockGranularityMs: number;
  resendMaxAttempt: number;
  outgoingCapacity: number;
  incomingCapacity: number;
}

export const DEFAULT_CHANNEL_TIMING: Readonly<ChannelTiming> = Object.freeze({
  resendIntervalMs: RESEND_SLEEP_INTERVAL_MS,
  initialRtoMs: DEFAULT_TRANSMISSION_TIMEOUT_MS,
  initialRttMs: DEFAULT_ROUND_TRIP_TIME_MS,
  initialRttVarMs: DEFAULT_ROUND_TRIP_TIME_VARIATION_MS,
  maxRtoMs: MAX_TRANSMISSION_TIMEOUT_MS,
  clockGranularityMs: CLOCK_GRANULARITY_MS,
  resendMaxAttempt: RESEND_MAX_ATTEMPT,
  outgoingCapacity: OUTGOING_MESSAGE_BUFFER_CAPACITY,
  incomingCapacity: INCOMING_MESSAGE_BUFFER_CAPACITY,
});

export interface TransmitMeta {
  kind: 'data' | 'resend' | 'ack';
  /** Sequence number of the data message (for an ack: the acknowledged sequence number). */
  seq: number;
  /** 0 for the first transmission. */
  attempt: number;
  payloadType: number;
}

export type ChannelEvent =
  | { type: 'malformed'; code: string; message: string }
  | { type: 'duplicate'; seq: number; expected: number }
  | { type: 'out-of-order'; seq: number; expected: number }
  | { type: 'incoming-buffer-full'; seq: number }
  | { type: 'outgoing-buffer-full'; droppedSeq: number }
  | { type: 'retransmit'; seq: number; attempt: number; rtoMs: number }
  | { type: 'resend-exhausted'; seq: number; attempts: number }
  | { type: 'ack-unknown'; seq: number }
  | { type: 'handler-error'; error: unknown };

export interface ChannelStats {
  dataSent: number;
  acksSent: number;
  acksReceived: number;
  retransmits: number;
  dataReceived: number;
  duplicates: number;
  outOfOrder: number;
  malformed: number;
  digestMismatches: number;
}

export interface DataChannelOptions {
  role: ChannelRole;
  /** Writes one binary frame; returns false when the transport is not open (the frame is not sent). */
  transmit(frame: Uint8Array, meta: TransmitMeta): boolean;
  /**
   * In-order stream data (`output_stream_data` for the client, `input_stream_data` for the agent). Call `ack()` once the
   * payload has been consumed; a no-op when the message was already acknowledged (handshake types, buffered messages).
   */
  onStreamData(msg: DecodedClientMessage, ack: () => void): void;
  /** channel_closed, start_publication, pause_publication and unknown message types. */
  onControl?(msg: DecodedClientMessage): void;
  onEvent?(e: ChannelEvent): void;
  /** Payload types acknowledged before delivery. Default (client): HandshakeRequest, HandshakeComplete, EncChallengeRequest. */
  ackBeforeDeliver?(payloadType: number): boolean;
  /** Re-send the acknowledge for duplicates (agent behaviour). Default false (plugin behaviour, 03 §3.5.5). */
  reackDuplicates?: boolean;
  timing?: Partial<ChannelTiming>;
  now?(): number;
  timers?: Timers;
  newMessageId?(): string;
}

interface OutgoingEntry {
  seq: number;
  payloadType: number;
  frame: Uint8Array;
  lastSentAt: number;
  attempts: number;
  exhaustedReported: boolean;
}

const CLIENT_ACK_FIRST = new Set<number>([PayloadType.HandshakeRequest, PayloadType.HandshakeComplete, PayloadType.EncChallengeRequest]);

export class DataChannel {
  readonly role: ChannelRole;
  private readonly opts: DataChannelOptions;
  private readonly timing: ChannelTiming;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly newId: () => string;
  private readonly outType: string;
  private readonly inType: string;

  private outSeq = 0;
  private expectedSeq = 0;
  private readonly outgoing = new Map<number, OutgoingEntry>();
  private readonly incoming = new Map<number, DecodedClientMessage>();
  private readonly unsentAcks: { frame: Uint8Array; seq: number }[] = [];
  private rtt: number;
  private rttVar: number;
  private rto: number;
  private interval: unknown = null;
  private disposed = false;
  private readonly counters: ChannelStats = {
    dataSent: 0, acksSent: 0, acksReceived: 0, retransmits: 0, dataReceived: 0, duplicates: 0, outOfOrder: 0, malformed: 0, digestMismatches: 0,
  };

  constructor(opts: DataChannelOptions) {
    this.opts = opts;
    this.role = opts.role;
    this.timing = { ...DEFAULT_CHANNEL_TIMING, ...opts.timing };
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? defaultTimers();
    this.newId = opts.newMessageId ?? randomUuid;
    this.outType = opts.role === 'client' ? MessageType.InputStreamData : MessageType.OutputStreamData;
    this.inType = opts.role === 'client' ? MessageType.OutputStreamData : MessageType.InputStreamData;
    this.rtt = this.timing.initialRttMs;
    this.rttVar = this.timing.initialRttVarMs;
    this.rto = this.timing.initialRtoMs;
  }

  /** Next sequence number to be sent (`StreamDataSequenceNumber`). */
  get nextSequenceNumber(): number {
    return this.outSeq;
  }

  /** `ExpectedSequenceNumber` of incoming stream data. */
  get expectedSequenceNumber(): number {
    return this.expectedSeq;
  }

  get unacknowledgedCount(): number {
    return this.outgoing.size;
  }

  get bufferedIncomingCount(): number {
    return this.incoming.size;
  }

  get retransmissionTimeoutMs(): number {
    return this.rto;
  }

  get stats(): Readonly<ChannelStats> {
    return { ...this.counters };
  }

  /** Sequence numbers still waiting for an acknowledge, oldest first. */
  unacknowledgedSequenceNumbers(): number[] {
    return [...this.outgoing.keys()];
  }

  /** Starts the retransmission scheduler (`ResendStreamDataMessageScheduler`). */
  start(): void {
    if (this.interval !== null || this.disposed) return;
    this.interval = this.timers.setInterval(() => this.tick(), this.timing.resendIntervalMs);
  }

  stop(): void {
    if (this.interval === null) return;
    this.timers.clearInterval(this.interval);
    this.interval = null;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.outgoing.clear();
    this.incoming.clear();
    this.unsentAcks.length = 0;
  }

  /** Numbers, buffers and transmits one stream-data message; returns its sequence number. */
  sendStreamData(payloadType: number, payload: Uint8Array): number {
    const seq = this.outSeq;
    const frame = encodeClientMessage({
      messageType: this.outType,
      schemaVersion: CLIENT_MESSAGE_SCHEMA_VERSION,
      createdDate: BigInt(Math.max(1, Math.floor(this.now()))),
      sequenceNumber: BigInt(seq),
      flags: STREAM_DATA_FLAGS,
      messageId: this.newId(),
      payloadType,
      payload,
    });
    if (this.outgoing.size >= this.timing.outgoingCapacity) {
      const oldest = this.outgoing.keys().next().value as number;
      this.outgoing.delete(oldest);
      this.emit({ type: 'outgoing-buffer-full', droppedSeq: oldest });
    }
    this.outgoing.set(seq, { seq, payloadType, frame, lastSentAt: this.now(), attempts: 0, exhaustedReported: false });
    this.outSeq++;
    if (this.opts.transmit(frame, { kind: 'data', seq, attempt: 0, payloadType })) this.counters.dataSent++;
    return seq;
  }

  /**
   * After a reconnect: first the acknowledges that could not be sent, then every unacknowledged message in order
   * (03 §3.5.5 “续连成功后立即重发缓冲中的未确认消息”). Resets the per-message attempt counters.
   */
  resendUnacknowledged(): void {
    while (this.unsentAcks.length > 0) {
      const a = this.unsentAcks[0]!;
      if (!this.opts.transmit(a.frame, { kind: 'ack', seq: a.seq, attempt: 1, payloadType: PayloadType.None })) return;
      this.unsentAcks.shift();
      this.counters.acksSent++;
    }
    const t = this.now();
    for (const e of this.outgoing.values()) {
      if (!this.opts.transmit(e.frame, { kind: 'resend', seq: e.seq, attempt: e.attempts + 1, payloadType: e.payloadType })) return;
      e.lastSentAt = t;
      e.attempts = 0;
      e.exhaustedReported = false;
      this.counters.retransmits++;
    }
  }

  /** One iteration of the retransmission scheduler (exposed for tests). */
  tick(): void {
    const front = this.outgoing.values().next().value as OutgoingEntry | undefined;
    if (!front) return;
    const t = this.now();
    if (t - front.lastSentAt <= this.rto) return;
    if (front.attempts >= this.timing.resendMaxAttempt) {
      if (!front.exhaustedReported) {
        front.exhaustedReported = true;
        this.emit({ type: 'resend-exhausted', seq: front.seq, attempts: front.attempts });
      }
      return;
    }
    if (!this.opts.transmit(front.frame, { kind: 'resend', seq: front.seq, attempt: front.attempts + 1, payloadType: front.payloadType })) return;
    front.attempts++;
    front.lastSentAt = t;
    this.counters.retransmits++;
    this.emit({ type: 'retransmit', seq: front.seq, attempt: front.attempts, rtoMs: this.rto });
  }

  /** Handles one binary frame from the peer. */
  receive(frame: Uint8Array): void {
    if (this.disposed) return;
    let msg: DecodedClientMessage;
    try {
      msg = decodeAndValidate(frame);
    } catch (err) {
      this.counters.malformed++;
      const code = err instanceof ProtocolError ? err.code : 'DECODE_ERROR';
      if (code === 'DIGEST_MISMATCH') this.counters.digestMismatches++;
      this.emit({ type: 'malformed', code, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (msg.messageType === MessageType.Acknowledge) {
      this.handleAcknowledge(msg);
    } else if (msg.messageType === this.inType) {
      this.handleStreamData(msg);
    } else {
      this.opts.onControl?.(msg);
    }
  }

  private handleAcknowledge(msg: DecodedClientMessage): void {
    const content = decodeAcknowledgeContent(msg.payload);
    if (!content) {
      this.counters.malformed++;
      this.emit({ type: 'malformed', code: 'BAD_ACKNOWLEDGE', message: 'ssm-client: acknowledge payload is not an AcknowledgeContent' });
      return;
    }
    const seq = content.AcknowledgedMessageSequenceNumber;
    const entry = this.outgoing.get(seq);
    if (!entry) {
      this.emit({ type: 'ack-unknown', seq });
      return;
    }
    this.counters.acksReceived++;
    this.updateRto(this.now() - entry.lastSentAt);
    this.outgoing.delete(seq);
  }

  /** streaming.go `CalculateRetransmissionTimeout`. */
  private updateRto(sampleMs: number): void {
    const sample = Math.max(0, sampleMs);
    this.rttVar = (1 - RTTV_CONSTANT) * this.rttVar + RTTV_CONSTANT * Math.abs(this.rtt - sample);
    this.rtt = (1 - RTT_CONSTANT) * this.rtt + RTT_CONSTANT * sample;
    this.rto = Math.min(this.timing.maxRtoMs, this.rtt + Math.max(this.timing.clockGranularityMs, 4 * this.rttVar));
  }

  private handleStreamData(msg: DecodedClientMessage): void {
    const seq = Number(msg.sequenceNumber);
    if (seq === this.expectedSeq) {
      this.counters.dataReceived++;
      this.expectedSeq++;
      this.deliver(msg, true);
      for (let next = this.incoming.get(this.expectedSeq); next; next = this.incoming.get(this.expectedSeq)) {
        this.incoming.delete(this.expectedSeq);
        this.expectedSeq++;
        this.deliver(next, false);
      }
    } else if (seq > this.expectedSeq) {
      if (this.incoming.has(seq)) {
        this.sendAck(msg);
        return;
      }
      if (this.incoming.size >= this.timing.incomingCapacity) {
        this.emit({ type: 'incoming-buffer-full', seq });
        return;
      }
      this.counters.dataReceived++;
      this.counters.outOfOrder++;
      this.sendAck(msg);
      this.incoming.set(seq, msg);
      this.emit({ type: 'out-of-order', seq, expected: this.expectedSeq });
    } else {
      this.counters.duplicates++;
      this.emit({ type: 'duplicate', seq, expected: this.expectedSeq });
      if (this.opts.reackDuplicates) this.sendAck(msg);
    }
  }

  /** `needsAck` is false for messages drained from the incoming buffer (acknowledged when they were buffered). */
  private deliver(msg: DecodedClientMessage, needsAck: boolean): void {
    let acked = !needsAck;
    const ack = (): void => {
      if (acked) return;
      acked = true;
      this.sendAck(msg);
    };
    const first = this.opts.ackBeforeDeliver ?? ((pt: number) => this.role === 'client' && CLIENT_ACK_FIRST.has(pt));
    if (first(msg.payloadType)) ack();
    try {
      this.opts.onStreamData(msg, ack);
    } catch (error) {
      this.emit({ type: 'handler-error', error });
      ack();
    }
  }

  private sendAck(msg: DecodedClientMessage): void {
    const seq = Number(msg.sequenceNumber);
    const frame = encodeClientMessage({
      messageType: MessageType.Acknowledge,
      schemaVersion: CLIENT_MESSAGE_SCHEMA_VERSION,
      createdDate: BigInt(Math.max(1, Math.floor(this.now()))),
      sequenceNumber: 0n,
      flags: ACKNOWLEDGE_FLAGS,
      messageId: this.newId(),
      payloadType: PayloadType.None,
      payload: encodeAcknowledgeContent({
        AcknowledgedMessageType: msg.messageType,
        AcknowledgedMessageId: msg.messageId,
        AcknowledgedMessageSequenceNumber: seq,
        IsSequentialMessage: true,
      }),
    });
    if (this.disposed) return;
    if (this.unsentAcks.length === 0 && this.opts.transmit(frame, { kind: 'ack', seq, attempt: 0, payloadType: PayloadType.None })) {
      this.counters.acksSent++;
    } else {
      this.unsentAcks.push({ frame, seq });
    }
  }

  private emit(e: ChannelEvent): void {
    this.opts.onEvent?.(e);
  }
}
