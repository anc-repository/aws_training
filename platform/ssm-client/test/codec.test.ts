import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HEADER_LENGTH,
  MessageType,
  PayloadType,
  ProtocolError,
  bytesEqual,
  bytesToUuid,
  decodeAndValidate,
  decodeClientMessage,
  encodeClientMessage,
  isUuid,
  payloadDigest,
  randomUuid,
  uuidToBytes,
  uuidToWire,
  validateClientMessage,
  wireToUuid,
  type ClientMessage,
} from '../src/index.js';

const enc = new TextEncoder();
const MSG_ID = '12345678-9abc-def0-1122-334455667788';

function nodeSha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(b).digest());
}

/**
 * Golden frame assembled field by field from the layout of messageparser.go / clientmessage.go — independent of
 * encodeClientMessage and of @noble/hashes (digest from node:crypto).
 */
function goldenFrame(m: { type: string; schema: number; created: bigint; seq: bigint; flags: bigint; wireId: number[]; payloadType: number; payload: Uint8Array }): Uint8Array {
  const buf = new Uint8Array(120 + m.payload.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 116);
  for (let i = 4; i < 36; i++) buf[i] = 0x20;
  buf.set(enc.encode(m.type), 4);
  dv.setUint32(36, m.schema);
  dv.setBigUint64(40, m.created);
  dv.setBigInt64(48, m.seq);
  dv.setBigUint64(56, m.flags);
  buf.set(m.wireId, 64);
  buf.set(nodeSha256(m.payload), 80);
  dv.setUint32(112, m.payloadType);
  dv.setUint32(116, m.payload.length);
  buf.set(m.payload, 120);
  return buf;
}

const sample: ClientMessage = {
  messageType: MessageType.InputStreamData,
  schemaVersion: 1,
  createdDate: 1_760_400_000_123n,
  sequenceNumber: 7n,
  flags: 0n,
  messageId: MSG_ID,
  payloadType: PayloadType.Output,
  payload: enc.encode('ls -la\r'),
};

describe('UUID wire order (putUuid / getUuid)', () => {
  it('puts the least significant 8 bytes first, then the most significant 8 bytes', () => {
    expect([...uuidToWire(MSG_ID)]).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    expect(wireToUuid(uuidToWire(MSG_ID))).toBe(MSG_ID);
  });

  it('round-trips random UUIDs and formats lower-case hyphenated', () => {
    for (let i = 0; i < 50; i++) {
      const id = randomUuid();
      expect(isUuid(id)).toBe(true);
      expect(id).toBe(id.toLowerCase());
      expect(wireToUuid(uuidToWire(id))).toBe(id);
      expect(bytesToUuid(uuidToBytes(id))).toBe(id);
    }
    expect(wireToUuid(uuidToWire(MSG_ID.toUpperCase()))).toBe(MSG_ID);
  });

  it('rejects malformed UUIDs', () => {
    expect(() => uuidToWire('not-a-uuid')).toThrow(TypeError);
    expect(() => wireToUuid(new Uint8Array(15))).toThrow(TypeError);
  });
});

describe('encodeClientMessage', () => {
  it('matches the golden frame byte for byte', () => {
    const golden = goldenFrame({
      type: 'input_stream_data', schema: 1, created: 1_760_400_000_123n, seq: 7n, flags: 0n,
      wireId: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0],
      payloadType: 1, payload: enc.encode('ls -la\r'),
    });
    expect(encodeClientMessage(sample)).toEqual(golden);
  });

  it('writes HeaderLength 116 and right-pads MessageType with spaces', () => {
    const f = encodeClientMessage({ ...sample, messageType: 'acknowledge' });
    expect(new DataView(f.buffer).getUint32(0)).toBe(HEADER_LENGTH);
    expect(HEADER_LENGTH).toBe(116);
    expect(new TextDecoder().decode(f.subarray(4, 15))).toBe('acknowledge');
    expect([...f.subarray(15, 36)].every((b) => b === 0x20)).toBe(true);
  });

  it('stores the raw 32-byte SHA-256 of the payload (not hex)', () => {
    const f = encodeClientMessage(sample);
    expect(f.subarray(80, 112)).toEqual(nodeSha256(sample.payload));
    expect(payloadDigest(sample.payload)).toEqual(nodeSha256(sample.payload));
    expect(payloadDigest(new Uint8Array(0))).toEqual(nodeSha256(new Uint8Array(0)));
  });

  it('rejects fields that do not fit their Go types', () => {
    expect(() => encodeClientMessage({ ...sample, messageType: 'x'.repeat(33) })).toThrow(ProtocolError);
    expect(() => encodeClientMessage({ ...sample, messageType: '' })).toThrow(ProtocolError);
    expect(() => encodeClientMessage({ ...sample, flags: -1n })).toThrow(ProtocolError);
    expect(() => encodeClientMessage({ ...sample, sequenceNumber: 1n << 63n })).toThrow(ProtocolError);
    expect(() => encodeClientMessage({ ...sample, payloadType: -1 })).toThrow(ProtocolError);
  });
});

describe('decodeClientMessage', () => {
  it('round-trips every field', () => {
    const cases: ClientMessage[] = [
      sample,
      { ...sample, messageType: MessageType.Acknowledge, sequenceNumber: 0n, flags: 3n, payloadType: 0 },
      { ...sample, messageType: MessageType.OutputStreamData, sequenceNumber: (1n << 63n) - 1n, flags: (1n << 64n) - 1n, createdDate: (1n << 64n) - 1n },
      { ...sample, sequenceNumber: -5n, payload: new Uint8Array(0) },
      { ...sample, payload: new Uint8Array(70_000).map((_, i) => i & 0xff) },
    ];
    for (const m of cases) {
      const d = decodeAndValidate(encodeClientMessage(m));
      const { payload, ...fields } = m;
      expect(d).toMatchObject({ ...fields, headerLength: 116, payloadLength: payload.length });
      expect(bytesEqual(d.payload, payload)).toBe(true);
    }
  });

  it('accepts an ArrayBuffer and a view with an offset', () => {
    const f = encodeClientMessage(sample);
    expect(decodeClientMessage(f.buffer as ArrayBuffer).messageId).toBe(MSG_ID);
    const padded = new Uint8Array(f.length + 8);
    padded.set(f, 8);
    expect(decodeAndValidate(padded.subarray(8)).sequenceNumber).toBe(7n);
  });

  it('trims NUL and space padding on either side (getString)', () => {
    const f = encodeClientMessage(sample);
    // ssm-session style: left-padded with 0x00
    const t = enc.encode('output_stream_data');
    f.fill(0, 4, 36);
    f.set(t, 36 - t.length);
    expect(decodeClientMessage(f).messageType).toBe('output_stream_data');
  });

  it('reads the payload at HeaderLength + 4 and ignores trailing bytes', () => {
    const f = encodeClientMessage(sample);
    const longer = new Uint8Array(f.length + 3);
    longer.set(f);
    expect(decodeAndValidate(longer).payload).toEqual(sample.payload);
  });

  it('rejects short, truncated and inconsistent frames', () => {
    const f = encodeClientMessage(sample);
    const err = (b: Uint8Array): string => {
      try {
        decodeClientMessage(b);
        return 'none';
      } catch (e) {
        return (e as ProtocolError).code;
      }
    };
    expect(err(f.subarray(0, 119))).toBe('FRAME_TOO_SHORT');
    expect(err(f.subarray(0, f.length - 1))).toBe('TRUNCATED_PAYLOAD');
    const bad = f.slice();
    new DataView(bad.buffer).setUint32(0, 4000);
    expect(err(bad)).toBe('BAD_HEADER_LENGTH');
  });
});

describe('validateClientMessage (messageparser.go Validate)', () => {
  it('detects a payload digest mismatch', () => {
    const f = encodeClientMessage(sample);
    f[f.length - 1]! ^= 0x01;
    expect(() => decodeAndValidate(f)).toThrow(expect.objectContaining({ code: 'DIGEST_MISMATCH' }));
  });

  it('skips the digest check for an empty payload, and everything for start/pause_publication', () => {
    const empty = encodeClientMessage({ ...sample, payload: new Uint8Array(0) });
    empty.fill(0, 80, 112);
    expect(() => decodeAndValidate(empty)).not.toThrow();

    const pub = decodeClientMessage(encodeClientMessage({ ...sample, messageType: MessageType.PausePublication, createdDate: 0n }));
    expect(() => validateClientMessage(pub)).not.toThrow();
  });

  it('requires CreatedDate and MessageType', () => {
    const noDate = decodeClientMessage(encodeClientMessage({ ...sample, createdDate: 0n }));
    expect(() => validateClientMessage(noDate)).toThrow(expect.objectContaining({ code: 'MISSING_CREATED_DATE' }));
    const f = encodeClientMessage(sample);
    f.fill(0x20, 4, 36);
    expect(() => decodeAndValidate(f)).toThrow(expect.objectContaining({ code: 'MISSING_MESSAGE_TYPE' }));
  });
});
