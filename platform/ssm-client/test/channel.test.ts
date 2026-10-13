import { describe, expect, it } from 'vitest';
import {
  DataChannel,
  MessageType,
  PayloadType,
  decodeAcknowledgeContent,
  decodeAndValidate,
  utf8Decode,
  utf8Encode,
  type ChannelEvent,
  type DataChannelOptions,
  type DecodedClientMessage,
  type TransmitMeta,
} from '../src/index.js';
import { ackFrame, controlFrame, prng, streamFrame } from './helpers.js';

interface Delivered {
  seq: number;
  payloadType: number;
  text: string;
  ack: () => void;
}

function harness(opts: Partial<DataChannelOptions> & { autoAck?: boolean } = {}) {
  let t = 1_000_000;
  let open = true;
  const sent: { meta: TransmitMeta; msg: DecodedClientMessage; frame: Uint8Array }[] = [];
  const delivered: Delivered[] = [];
  const controls: DecodedClientMessage[] = [];
  const events: ChannelEvent[] = [];
  const { autoAck, ...rest } = opts;
  const ch = new DataChannel({
    role: 'client',
    transmit: (frame, meta) => {
      if (!open) return false;
      sent.push({ meta, msg: decodeAndValidate(frame), frame });
      return true;
    },
    onStreamData: (msg, ack) => {
      delivered.push({ seq: Number(msg.sequenceNumber), payloadType: msg.payloadType, text: utf8Decode(msg.payload), ack });
      if (autoAck) ack();
    },
    onControl: (m) => controls.push(m),
    onEvent: (e) => events.push(e),
    now: () => t,
    ...rest,
  });
  const acks = () => sent.filter((s) => s.meta.kind === 'ack').map((s) => decodeAcknowledgeContent(s.msg.payload)!.AcknowledgedMessageSequenceNumber);
  return {
    ch, sent, delivered, controls, events, acks,
    advance: (ms: number) => { t += ms; },
    setOpen: (v: boolean) => { open = v; },
    clear: () => { sent.length = 0; },
  };
}

describe('sending (SendInputDataMessage)', () => {
  it('numbers input_stream_data from 0 with Flags 0 and keeps it until acknowledged', () => {
    const h = harness();
    expect(h.ch.sendStreamData(PayloadType.Size, utf8Encode('{"cols":80,"rows":24}'))).toBe(0);
    expect(h.ch.sendStreamData(PayloadType.Output, utf8Encode('l'))).toBe(1);
    expect(h.sent.map((s) => [s.msg.messageType, Number(s.msg.sequenceNumber), s.msg.flags, s.msg.payloadType])).toEqual([
      ['input_stream_data', 0, 0n, 3],
      ['input_stream_data', 1, 0n, 1],
    ]);
    expect(h.ch.unacknowledgedSequenceNumbers()).toEqual([0, 1]);
    h.ch.receive(ackFrame(1));
    expect(h.ch.unacknowledgedSequenceNumbers()).toEqual([0]);
    h.ch.receive(ackFrame(1));
    expect(h.events).toContainEqual({ type: 'ack-unknown', seq: 1 });
    expect(h.ch.stats).toMatchObject({ dataSent: 2, acksReceived: 1 });
  });

  it('writes acknowledges with SequenceNumber 0, Flags 3, PayloadType 0 and the acknowledged type / id / seq', () => {
    const h = harness({ autoAck: true });
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    h.ch.receive(streamFrame(0, 'hello', { messageId: id }));
    const ack = h.sent.find((s) => s.meta.kind === 'ack')!.msg;
    expect([ack.messageType, ack.sequenceNumber, ack.flags, ack.payloadType, ack.schemaVersion]).toEqual(['acknowledge', 0n, 3n, 0, 1]);
    expect(decodeAcknowledgeContent(ack.payload)).toEqual({ AcknowledgedMessageType: 'output_stream_data', AcknowledgedMessageId: id, AcknowledgedMessageSequenceNumber: 0, IsSequentialMessage: true });
  });

  it('drops the oldest entry when the outgoing buffer is full', () => {
    const h = harness({ timing: { outgoingCapacity: 3 } });
    for (let i = 0; i < 5; i++) h.ch.sendStreamData(PayloadType.Output, utf8Encode(String(i)));
    expect(h.ch.unacknowledgedSequenceNumbers()).toEqual([2, 3, 4]);
    expect(h.events.filter((e) => e.type === 'outgoing-buffer-full')).toEqual([
      { type: 'outgoing-buffer-full', droppedSeq: 0 },
      { type: 'outgoing-buffer-full', droppedSeq: 1 },
    ]);
  });
});

describe('retransmission and RTO (ResendStreamDataMessageScheduler, CalculateRetransmissionTimeout)', () => {
  it('starts with RTO 200 ms and updates it from the round-trip sample', () => {
    const h = harness();
    expect(h.ch.retransmissionTimeoutMs).toBe(200);
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('a'));
    h.advance(50);
    h.ch.receive(ackFrame(0));
    // rttVar = 0.75·0 + 0.25·|100−50| = 12.5; rtt = 0.875·100 + 0.125·50 = 93.75; rto = 93.75 + max(10, 50)
    expect(h.ch.retransmissionTimeoutMs).toBeCloseTo(143.75, 6);
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('b'));
    h.advance(5000);
    h.ch.receive(ackFrame(1));
    expect(h.ch.retransmissionTimeoutMs).toBe(1000); // MaxTransmissionTimeout
  });

  it('resends only the front message, only after the RTO, and counts attempts', () => {
    const h = harness();
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('a'));
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('b'));
    h.clear();
    h.advance(200);
    h.ch.tick();
    expect(h.sent).toHaveLength(0); // not *older* than the RTO yet
    h.advance(1);
    h.ch.tick();
    h.ch.tick();
    expect(h.sent.map((s) => [s.meta.kind, s.meta.seq, s.meta.attempt])).toEqual([['resend', 0, 1]]);
    h.ch.receive(ackFrame(0));
    h.advance(201);
    h.ch.tick();
    expect(h.sent.map((s) => [s.meta.seq, s.meta.attempt])).toEqual([[0, 1], [1, 1]]);
    expect(h.events.filter((e) => e.type === 'retransmit')).toHaveLength(2);
  });

  it('re-sends the identical frame', () => {
    const h = harness();
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('x'));
    const original = h.sent[0]!.frame;
    h.advance(300);
    h.ch.tick();
    expect(h.sent[1]!.frame).toEqual(original);
  });

  it('does not count an attempt while the transport is down, and reports exhaustion once', () => {
    const h = harness({ timing: { resendMaxAttempt: 3 } });
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('a'));
    h.setOpen(false);
    for (let i = 0; i < 10; i++) {
      h.advance(300);
      h.ch.tick();
    }
    expect(h.events.filter((e) => e.type === 'retransmit')).toHaveLength(0);
    h.setOpen(true);
    for (let i = 0; i < 10; i++) {
      h.advance(1100);
      h.ch.tick();
    }
    expect(h.events.filter((e) => e.type === 'retransmit')).toHaveLength(3);
    expect(h.events.filter((e) => e.type === 'resend-exhausted')).toEqual([{ type: 'resend-exhausted', seq: 0, attempts: 3 }]);
  });

  it('resendUnacknowledged flushes unsent acks first, then every unacknowledged message in order', () => {
    const h = harness({ autoAck: true });
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('a'));
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('b'));
    h.setOpen(false);
    h.ch.receive(streamFrame(0, 'out-0')); // its ack cannot be sent
    h.ch.sendStreamData(PayloadType.Output, utf8Encode('c')); // numbered and buffered while down
    expect(h.ch.unacknowledgedSequenceNumbers()).toEqual([0, 1, 2]);
    h.setOpen(true);
    h.clear();
    h.ch.resendUnacknowledged();
    expect(h.sent.map((s) => [s.meta.kind, s.meta.seq])).toEqual([['ack', 0], ['resend', 0], ['resend', 1], ['resend', 2]]);
    h.ch.start();
    h.ch.stop();
  });
});

describe('receiving (HandleOutputMessage)', () => {
  it('delivers in order and acknowledges an output payload only when the sink calls ack()', () => {
    const h = harness();
    h.ch.receive(streamFrame(0, 'a'));
    expect(h.delivered.map((d) => d.text)).toEqual(['a']);
    expect(h.acks()).toEqual([]);
    h.delivered[0]!.ack();
    h.delivered[0]!.ack();
    expect(h.acks()).toEqual([0]);
    expect(h.ch.expectedSequenceNumber).toBe(1);
  });

  it('acknowledges HandshakeRequest / HandshakeComplete before delivering them', () => {
    const h = harness();
    h.ch.receive(streamFrame(0, '{}', { payloadType: PayloadType.HandshakeRequest }));
    expect(h.acks()).toEqual([0]);
    h.ch.receive(streamFrame(1, '{}', { payloadType: PayloadType.HandshakeComplete }));
    expect(h.acks()).toEqual([0, 1]);
    h.delivered.forEach((d) => d.ack());
    expect(h.acks()).toEqual([0, 1]);
  });

  it('acknowledges and buffers out-of-order messages, then delivers them in order', () => {
    const h = harness();
    h.ch.receive(streamFrame(2, 'c'));
    h.ch.receive(streamFrame(1, 'b'));
    expect(h.delivered).toHaveLength(0);
    expect(h.acks()).toEqual([2, 1]);
    expect(h.ch.bufferedIncomingCount).toBe(2);
    h.ch.receive(streamFrame(0, 'a'));
    expect(h.delivered.map((d) => [d.seq, d.text])).toEqual([[0, 'a'], [1, 'b'], [2, 'c']]);
    h.delivered.forEach((d) => d.ack());
    expect(h.acks()).toEqual([2, 1, 0]); // buffered ones are not acknowledged twice
    expect(h.ch.expectedSequenceNumber).toBe(3);
    expect(h.ch.bufferedIncomingCount).toBe(0);
    expect(h.ch.stats.outOfOrder).toBe(2);
  });

  it('drops duplicates without acknowledging them (plugin), or re-acknowledges with reackDuplicates (agent)', () => {
    const plugin = harness({ autoAck: true });
    plugin.ch.receive(streamFrame(0, 'a'));
    plugin.ch.receive(streamFrame(0, 'a'));
    expect(plugin.delivered).toHaveLength(1);
    expect(plugin.acks()).toEqual([0]);
    expect(plugin.events).toContainEqual({ type: 'duplicate', seq: 0, expected: 1 });

    const agentLike = harness({ autoAck: true, reackDuplicates: true });
    agentLike.ch.receive(streamFrame(0, 'a'));
    agentLike.ch.receive(streamFrame(0, 'a'));
    expect(agentLike.delivered).toHaveLength(1);
    expect(agentLike.acks()).toEqual([0, 0]);
  });

  it('re-acknowledges a duplicate of a buffered message without buffering it twice', () => {
    const h = harness({ autoAck: true });
    h.ch.receive(streamFrame(1, 'b'));
    h.ch.receive(streamFrame(1, 'b'));
    expect(h.acks()).toEqual([1, 1]);
    h.ch.receive(streamFrame(0, 'a'));
    expect(h.delivered.map((d) => d.text)).toEqual(['a', 'b']);
  });

  it('drops a message without acknowledging it when the incoming buffer is full', () => {
    const h = harness({ autoAck: true, timing: { incomingCapacity: 2 } });
    h.ch.receive(streamFrame(1, 'b'));
    h.ch.receive(streamFrame(2, 'c'));
    h.ch.receive(streamFrame(3, 'd'));
    expect(h.acks()).toEqual([1, 2]);
    expect(h.events).toContainEqual({ type: 'incoming-buffer-full', seq: 3 });
  });

  it('drops a frame with a bad digest without acknowledging it, and accepts the retransmission', () => {
    const h = harness({ autoAck: true });
    const good = streamFrame(0, 'payload');
    const bad = good.slice();
    bad[bad.length - 1]! ^= 0xff;
    h.ch.receive(bad);
    expect(h.delivered).toHaveLength(0);
    expect(h.acks()).toEqual([]);
    expect(h.ch.stats).toMatchObject({ malformed: 1, digestMismatches: 1 });
    h.ch.receive(good);
    expect(h.delivered.map((d) => d.text)).toEqual(['payload']);
    h.ch.receive(new Uint8Array(10));
    expect(h.events.filter((e) => e.type === 'malformed').map((e) => (e as { code: string }).code)).toEqual(['DIGEST_MISMATCH', 'FRAME_TOO_SHORT']);
  });

  it('passes channel_closed / start_publication / pause_publication to onControl without touching sequencing', () => {
    const h = harness({ autoAck: true });
    h.ch.receive(controlFrame(MessageType.StartPublication));
    h.ch.receive(controlFrame(MessageType.PausePublication));
    h.ch.receive(controlFrame(MessageType.ChannelClosed, '{"Output":"bye"}'));
    expect(h.controls.map((c) => c.messageType)).toEqual(['start_publication', 'pause_publication', 'channel_closed']);
    expect(h.acks()).toEqual([]);
    expect(h.ch.expectedSequenceNumber).toBe(0);
  });

  it('acknowledges even when the handler throws', () => {
    const h = harness({ onStreamData: () => { throw new Error('boom'); } });
    h.ch.receive(streamFrame(0, 'a'));
    expect(h.acks()).toEqual([0]);
    expect(h.events.some((e) => e.type === 'handler-error')).toBe(true);
  });
});

describe('client ↔ agent over a lossy, reordering link', () => {
  it('delivers every message exactly once and in order in both directions', () => {
    const rnd = prng(42);
    let t = 0;
    const inboxes: { client: Uint8Array[]; agent: Uint8Array[] } = { client: [], agent: [] };
    const got = { client: [] as string[], agent: [] as string[] };
    const link = (to: 'client' | 'agent') => (frame: Uint8Array) => {
      if (rnd() < 0.25) return true; // lost
      inboxes[to].push(frame);
      if (rnd() < 0.05) inboxes[to].push(frame); // duplicated
      return true;
    };
    const make = (role: 'client' | 'agent') => new DataChannel({
      role,
      transmit: link(role === 'client' ? 'agent' : 'client'),
      onStreamData: (m, ack) => {
        got[role].push(utf8Decode(m.payload));
        ack();
      },
      // with a lossy link a lost acknowledge must be repaired by re-acknowledging duplicates (as the agent does)
      reackDuplicates: true,
      now: () => t,
    });
    const client = make('client');
    const agent = make('agent');
    for (let i = 0; i < 200; i++) client.sendStreamData(PayloadType.Output, utf8Encode(`in-${i}`));
    for (let i = 0; i < 300; i++) agent.sendStreamData(PayloadType.Output, utf8Encode(`out-${i}`));
    const pump = (to: 'client' | 'agent', ch: DataChannel): void => {
      const q = inboxes[to];
      while (q.length > 0) {
        const i = Math.floor(rnd() * Math.min(4, q.length)); // mild reordering
        ch.receive(q.splice(i, 1)[0]!);
      }
    };
    for (let step = 0; step < 20_000 && (client.unacknowledgedCount > 0 || agent.unacknowledgedCount > 0); step++) {
      pump('client', client);
      pump('agent', agent);
      t += 100;
      client.tick();
      agent.tick();
    }
    expect(client.unacknowledgedCount).toBe(0);
    expect(agent.unacknowledgedCount).toBe(0);
    expect(got.agent).toEqual(Array.from({ length: 200 }, (_, i) => `in-${i}`));
    expect(got.client).toEqual(Array.from({ length: 300 }, (_, i) => `out-${i}`));
    expect(client.stats.duplicates + client.stats.outOfOrder).toBeGreaterThan(0);
    expect(agent.stats.retransmits).toBeGreaterThan(0);
  });
});
