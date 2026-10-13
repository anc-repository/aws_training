import {
  MessageType,
  PayloadType,
  encodeAcknowledgeContent,
  encodeClientMessage,
  randomUuid,
  utf8Encode,
} from '../src/index.js';

let created = 1_760_400_000_000n;

/** A frame as the agent would send it (output_stream_data by default). */
export function streamFrame(seq: number, payload: string | Uint8Array, opts: { payloadType?: number; messageType?: string; messageId?: string } = {}): Uint8Array {
  return encodeClientMessage({
    messageType: opts.messageType ?? MessageType.OutputStreamData,
    schemaVersion: 1,
    createdDate: created++,
    sequenceNumber: BigInt(seq),
    flags: 0n,
    messageId: opts.messageId ?? randomUuid(),
    payloadType: opts.payloadType ?? PayloadType.Output,
    payload: typeof payload === 'string' ? utf8Encode(payload) : payload,
  });
}

/** The agent's acknowledge of client input `seq`. */
export function ackFrame(seq: number, ackedType: string = MessageType.InputStreamData): Uint8Array {
  return encodeClientMessage({
    messageType: MessageType.Acknowledge,
    schemaVersion: 1,
    createdDate: created++,
    sequenceNumber: 0n,
    flags: 3n,
    messageId: randomUuid(),
    payloadType: 0,
    payload: encodeAcknowledgeContent({ AcknowledgedMessageType: ackedType, AcknowledgedMessageId: randomUuid(), AcknowledgedMessageSequenceNumber: seq, IsSequentialMessage: true }),
  });
}

export function controlFrame(messageType: string, payload: string | Uint8Array = ''): Uint8Array {
  return encodeClientMessage({
    messageType,
    schemaVersion: 1,
    createdDate: created++,
    sequenceNumber: 0n,
    flags: 0n,
    messageId: randomUuid(),
    payloadType: 0,
    payload: typeof payload === 'string' ? utf8Encode(payload) : payload,
  });
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Removes OSC sequences (shell integration markers) and SGR colours from terminal output. */
export function plain(s: string): string {
  // eslint-disable-next-line no-control-regex -- matching ESC / BEL is the point
  return s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');
}
