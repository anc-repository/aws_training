/**
 * JSON payloads of the data channel (03 §3.5.1, §3.5.3, §3.5.5, §3.5.6, §3.5.10).
 *
 * Field names and order follow the Go structs (encoding/json writes fields in declaration order):
 * - `OpenDataChannelInput`  — aws/session-manager-plugin src/service/service.go
 * - `AcknowledgeContent`, `ChannelClosed`, `SizeData` — src/message/clientmessage.go
 * - `HandshakeCompletePayload` — src/message/handshakemessage.go
 */
import { utf8Decode, utf8Encode } from './bytes.js';
import { OPEN_DATA_CHANNEL_SCHEMA_VERSION } from './constants.js';

export interface OpenDataChannelInput {
  MessageSchemaVersion: string;
  /** `min:"16"`; the plugin sends a hyphenated v4 UUID. */
  RequestId: string;
  TokenValue: string;
  ClientId: string;
  ClientVersion: string;
}

/** The first (text) frame after the WebSocket opens (`FinalizeDataChannelHandshake` + `Open`). */
export function buildOpenDataChannel(input: { tokenValue: string; clientId: string; clientVersion: string; requestId: string }): string {
  const body: OpenDataChannelInput = {
    MessageSchemaVersion: OPEN_DATA_CHANNEL_SCHEMA_VERSION,
    RequestId: input.requestId,
    TokenValue: input.tokenValue,
    ClientId: input.clientId,
    ClientVersion: input.clientVersion,
  };
  return JSON.stringify(body);
}

export function parseOpenDataChannel(text: string): OpenDataChannelInput | null {
  const v = parseJsonText(text);
  if (!isRecord(v)) return null;
  const { MessageSchemaVersion, RequestId, TokenValue, ClientId, ClientVersion } = v;
  if (typeof MessageSchemaVersion !== 'string' || typeof RequestId !== 'string' || typeof TokenValue !== 'string' || typeof ClientId !== 'string' || typeof ClientVersion !== 'string') return null;
  return { MessageSchemaVersion, RequestId, TokenValue, ClientId, ClientVersion };
}

/** clientmessage.go `AcknowledgeContent`. */
export interface AcknowledgeContent {
  AcknowledgedMessageType: string;
  /** Standard (hyphenated) UUID text of the acknowledged message. */
  AcknowledgedMessageId: string;
  AcknowledgedMessageSequenceNumber: number;
  IsSequentialMessage: boolean;
}

export function encodeAcknowledgeContent(c: AcknowledgeContent): Uint8Array {
  return utf8Encode(JSON.stringify({
    AcknowledgedMessageType: c.AcknowledgedMessageType,
    AcknowledgedMessageId: c.AcknowledgedMessageId,
    AcknowledgedMessageSequenceNumber: c.AcknowledgedMessageSequenceNumber,
    IsSequentialMessage: c.IsSequentialMessage,
  }));
}

export function decodeAcknowledgeContent(payload: Uint8Array): AcknowledgeContent | null {
  const v = parseJsonBytes(payload);
  if (!isRecord(v)) return null;
  const seq = v.AcknowledgedMessageSequenceNumber;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) return null;
  return {
    AcknowledgedMessageType: typeof v.AcknowledgedMessageType === 'string' ? v.AcknowledgedMessageType : '',
    AcknowledgedMessageId: typeof v.AcknowledgedMessageId === 'string' ? v.AcknowledgedMessageId : '',
    AcknowledgedMessageSequenceNumber: seq,
    IsSequentialMessage: v.IsSequentialMessage === true,
  };
}

/** clientmessage.go `SizeData` — `{"cols":<uint32>,"rows":<uint32>}`. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

export function isValidSize(s: TerminalSize): boolean {
  return Number.isInteger(s.cols) && Number.isInteger(s.rows) && s.cols > 0 && s.rows > 0 && s.cols <= 0xffff && s.rows <= 0xffff;
}

export function encodeSize(s: TerminalSize): Uint8Array {
  return utf8Encode(JSON.stringify({ cols: s.cols, rows: s.rows }));
}

export function decodeSize(payload: Uint8Array): TerminalSize | null {
  const v = parseJsonBytes(payload);
  if (!isRecord(v) || typeof v.cols !== 'number' || typeof v.rows !== 'number') return null;
  const s = { cols: v.cols, rows: v.rows };
  return isValidSize(s) ? s : null;
}

/** clientmessage.go `ChannelClosed` — payload of a `channel_closed` message (session ended; `Output` is the reason text). */
export interface ChannelClosedPayload {
  MessageId: string;
  CreatedDate: string;
  DestinationId: string;
  SessionId: string;
  MessageType: string;
  SchemaVersion: number;
  Output: string;
}

export function encodeChannelClosed(c: ChannelClosedPayload): Uint8Array {
  return utf8Encode(JSON.stringify({
    MessageId: c.MessageId,
    CreatedDate: c.CreatedDate,
    DestinationId: c.DestinationId,
    SessionId: c.SessionId,
    MessageType: c.MessageType,
    SchemaVersion: c.SchemaVersion,
    Output: c.Output,
  }));
}

/** Lenient: the plugin logs an unmarshal error and continues with a zero-value struct (`HandleChannelClosedMessage`). */
export function decodeChannelClosed(payload: Uint8Array): ChannelClosedPayload {
  const v = parseJsonBytes(payload);
  const r = isRecord(v) ? v : {};
  const str = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '');
  return {
    MessageId: str('MessageId'),
    CreatedDate: str('CreatedDate'),
    DestinationId: str('DestinationId'),
    SessionId: str('SessionId'),
    MessageType: str('MessageType'),
    SchemaVersion: typeof r.SchemaVersion === 'number' ? r.SchemaVersion : 0,
    Output: str('Output'),
  };
}

// ---- JSON helpers ----

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function parseJsonBytes(payload: Uint8Array): unknown {
  return parseJsonText(utf8Decode(payload));
}

export function encodeJson(v: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(v));
}
