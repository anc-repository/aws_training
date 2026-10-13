/**
 * ClientMessage binary codec (03 §3.5.2).
 *
 * Source: aws/session-manager-plugin `src/message/messageparser.go` (`SerializeClientMessage`,
 * `SerializeClientMessageWithAcknowledgeContent`, `DeserializeClientMessage`, `Validate`, `putString` / `getString`,
 * `putUuid` / `getUuid`) and `src/message/clientmessage.go` (field lengths and offsets), checked 2026-10-14.
 *
 * | offset | len | field          | notes                                                                     |
 * |--------|-----|----------------|---------------------------------------------------------------------------|
 * | 0      | 4   | HeaderLength   | uint32 = 116 (offset of PayloadLength, not the full 120-byte header)       |
 * | 4      | 32  | MessageType    | ASCII, right-padded with spaces (`putString` wipes the field with ' ')    |
 * | 36     | 4   | SchemaVersion  | uint32 = 1                                                                |
 * | 40     | 8   | CreatedDate    | uint64, Unix milliseconds                                                 |
 * | 48     | 8   | SequenceNumber | int64                                                                     |
 * | 56     | 8   | Flags          | uint64; input_stream_data 0, acknowledge 3                                |
 * | 64     | 16  | MessageId      | UUID, least significant 8 bytes first (see uuid.ts)                       |
 * | 80     | 32  | PayloadDigest  | raw SHA-256 of Payload (`hasher.Sum(nil)`, not hex)                       |
 * | 112    | 4   | PayloadType    | uint32                                                                    |
 * | 116    | 4   | PayloadLength  | uint32                                                                    |
 * | 120    | n   | Payload        | starts at HeaderLength + 4                                                |
 *
 * The community library `ssm-session` (bertrandmartel/aws-ssm-session, src/ssm.js) left-pads MessageType with 0x00
 * and writes 32 hex characters as the digest; that only works because the agent does not verify it, so it is not
 * followed here. The digest is computed synchronously (@noble/hashes) so frames are processed strictly in order
 * (WebCrypto `digest` is async).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesEqual, utf8Encode } from './bytes.js';
import {
  CREATED_DATE_OFFSET,
  FLAGS_OFFSET,
  HEADER_LENGTH,
  HL_OFFSET,
  MESSAGE_ID_LENGTH,
  MESSAGE_ID_OFFSET,
  MESSAGE_TYPE_LENGTH,
  MESSAGE_TYPE_OFFSET,
  MessageType,
  PAYLOAD_DIGEST_LENGTH,
  PAYLOAD_DIGEST_OFFSET,
  PAYLOAD_LENGTH_OFFSET,
  PAYLOAD_OFFSET,
  PAYLOAD_TYPE_OFFSET,
  SCHEMA_VERSION_OFFSET,
  SEQUENCE_NUMBER_OFFSET,
} from './constants.js';
import { uuidToWire, wireToUuid } from './uuid.js';

/** A ClientMessage as written by `encodeClientMessage` (digest and lengths are derived). */
export interface ClientMessage {
  messageType: string;
  schemaVersion: number;
  /** Unix milliseconds (uint64). */
  createdDate: bigint;
  /** int64. */
  sequenceNumber: bigint;
  /** uint64. */
  flags: bigint;
  /** Lower-case hyphenated UUID. */
  messageId: string;
  payloadType: number;
  payload: Uint8Array;
}

/** A decoded frame, including the header fields that are derived on encode. */
export interface DecodedClientMessage extends ClientMessage {
  headerLength: number;
  payloadDigest: Uint8Array;
  payloadLength: number;
}

export type ProtocolErrorCode = 'FRAME_TOO_SHORT' | 'BAD_HEADER_LENGTH' | 'TRUNCATED_PAYLOAD' | 'MISSING_MESSAGE_TYPE' | 'MISSING_CREATED_DATE' | 'DIGEST_MISMATCH' | 'BAD_FIELD';

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/** Raw 32-byte SHA-256 of the payload (`PayloadDigest`). */
export function payloadDigest(payload: Uint8Array): Uint8Array {
  return sha256(payload);
}

const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function checkRange(name: string, v: bigint, min: bigint, max: bigint): void {
  if (v < min || v > max) throw new ProtocolError('BAD_FIELD', `ssm-client: ${name} out of range: ${v}`);
}

function checkUint32(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > UINT32_MAX) throw new ProtocolError('BAD_FIELD', `ssm-client: ${name} is not a uint32: ${v}`);
}

/** messageparser.go `SerializeClientMessage`. */
export function encodeClientMessage(m: ClientMessage): Uint8Array {
  const type = utf8Encode(m.messageType);
  if (type.length === 0 || type.length > MESSAGE_TYPE_LENGTH) {
    throw new ProtocolError('BAD_FIELD', `ssm-client: MessageType must be 1–${MESSAGE_TYPE_LENGTH} bytes: ${JSON.stringify(m.messageType)}`);
  }
  checkUint32('SchemaVersion', m.schemaVersion);
  checkUint32('PayloadType', m.payloadType);
  checkRange('CreatedDate', m.createdDate, 0n, UINT64_MAX);
  checkRange('SequenceNumber', m.sequenceNumber, INT64_MIN, INT64_MAX);
  checkRange('Flags', m.flags, 0n, UINT64_MAX);

  const buf = new Uint8Array(PAYLOAD_OFFSET + m.payload.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(HL_OFFSET, HEADER_LENGTH);
  buf.fill(0x20, MESSAGE_TYPE_OFFSET, MESSAGE_TYPE_OFFSET + MESSAGE_TYPE_LENGTH);
  buf.set(type, MESSAGE_TYPE_OFFSET);
  dv.setUint32(SCHEMA_VERSION_OFFSET, m.schemaVersion);
  dv.setBigUint64(CREATED_DATE_OFFSET, m.createdDate);
  dv.setBigInt64(SEQUENCE_NUMBER_OFFSET, m.sequenceNumber);
  dv.setBigUint64(FLAGS_OFFSET, m.flags);
  buf.set(uuidToWire(m.messageId), MESSAGE_ID_OFFSET);
  buf.set(payloadDigest(m.payload), PAYLOAD_DIGEST_OFFSET);
  dv.setUint32(PAYLOAD_TYPE_OFFSET, m.payloadType);
  dv.setUint32(PAYLOAD_LENGTH_OFFSET, m.payload.length);
  buf.set(m.payload, PAYLOAD_OFFSET);
  return buf;
}

/** `getString`: `bytes.Trim(…, "\x00")` then `strings.TrimSpace`. */
function readString(b: Uint8Array): string {
  let s = 0;
  let e = b.length;
  while (s < e && b[s] === 0) s++;
  while (e > s && b[e - 1] === 0) e--;
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]!);
  return out.trim();
}

/**
 * messageparser.go `DeserializeClientMessage`: header fields at fixed offsets, payload at HeaderLength + 4.
 * The payload is `PayloadLength` bytes; a frame shorter than that is rejected (trailing bytes are ignored).
 * Does not verify the digest — call `validateClientMessage` (as the plugin does) or use `decodeAndValidate`.
 */
export function decodeClientMessage(frame: Uint8Array | ArrayBuffer): DecodedClientMessage {
  const buf = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (buf.length < PAYLOAD_OFFSET) throw new ProtocolError('FRAME_TOO_SHORT', `ssm-client: frame of ${buf.length} bytes is shorter than the ${PAYLOAD_OFFSET}-byte header`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLength = dv.getUint32(HL_OFFSET);
  if (headerLength < PAYLOAD_LENGTH_OFFSET || headerLength + 4 > buf.length) {
    throw new ProtocolError('BAD_HEADER_LENGTH', `ssm-client: HeaderLength ${headerLength} does not fit a ${buf.length}-byte frame`);
  }
  const payloadLength = dv.getUint32(PAYLOAD_LENGTH_OFFSET);
  const payloadStart = headerLength + 4;
  if (payloadStart + payloadLength > buf.length) {
    throw new ProtocolError('TRUNCATED_PAYLOAD', `ssm-client: PayloadLength ${payloadLength} exceeds the ${buf.length - payloadStart} bytes after the header`);
  }
  return {
    headerLength,
    messageType: readString(buf.subarray(MESSAGE_TYPE_OFFSET, MESSAGE_TYPE_OFFSET + MESSAGE_TYPE_LENGTH)),
    schemaVersion: dv.getUint32(SCHEMA_VERSION_OFFSET),
    createdDate: dv.getBigUint64(CREATED_DATE_OFFSET),
    sequenceNumber: dv.getBigInt64(SEQUENCE_NUMBER_OFFSET),
    flags: dv.getBigUint64(FLAGS_OFFSET),
    messageId: wireToUuid(buf.slice(MESSAGE_ID_OFFSET, MESSAGE_ID_OFFSET + MESSAGE_ID_LENGTH)),
    payloadDigest: buf.slice(PAYLOAD_DIGEST_OFFSET, PAYLOAD_DIGEST_OFFSET + PAYLOAD_DIGEST_LENGTH),
    payloadType: dv.getUint32(PAYLOAD_TYPE_OFFSET),
    payloadLength,
    payload: buf.slice(payloadStart, payloadStart + payloadLength),
  };
}

/**
 * messageparser.go `Validate`: start/pause_publication skip all checks; otherwise HeaderLength ≠ 0, MessageType
 * present, CreatedDate ≠ 0, and — only when PayloadLength ≠ 0 — SHA-256(Payload) equals PayloadDigest.
 */
export function validateClientMessage(m: DecodedClientMessage): void {
  if (m.messageType === MessageType.StartPublication || m.messageType === MessageType.PausePublication) return;
  if (m.headerLength === 0) throw new ProtocolError('BAD_HEADER_LENGTH', 'ssm-client: HeaderLength cannot be zero');
  if (m.messageType === '') throw new ProtocolError('MISSING_MESSAGE_TYPE', 'ssm-client: MessageType is missing');
  if (m.createdDate === 0n) throw new ProtocolError('MISSING_CREATED_DATE', 'ssm-client: CreatedDate is missing');
  if (m.payloadLength !== 0 && !bytesEqual(payloadDigest(m.payload), m.payloadDigest)) {
    throw new ProtocolError('DIGEST_MISMATCH', 'ssm-client: payload hash is not valid');
  }
}

export function decodeAndValidate(frame: Uint8Array | ArrayBuffer): DecodedClientMessage {
  const m = decodeClientMessage(frame);
  validateClientMessage(m);
  return m;
}
