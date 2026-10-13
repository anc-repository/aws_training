import { describe, expect, it } from 'vitest';
import {
  ActionStatus,
  DEFAULT_BACKOFF,
  KMS_UNSUPPORTED_ERROR,
  PROTOCOL_COMPAT_VERSION,
  backoffDelay,
  buildOpenDataChannel,
  checkStreamUrl,
  chunkUtf8,
  decodeAcknowledgeContent,
  decodeChannelClosed,
  decodeSize,
  encodeAcknowledgeContent,
  encodeHandshakeResponse,
  encodeSize,
  initialDelay,
  parseHandshakeComplete,
  parseHandshakeRequest,
  parseOpenDataChannel,
  processHandshakeRequest,
  utf8Decode,
  utf8Encode,
} from '../src/index.js';

describe('OpenDataChannel (service.go OpenDataChannelInput)', () => {
  it('is a JSON text frame with the five fields in Go declaration order', () => {
    const s = buildOpenDataChannel({ tokenValue: 'tok', clientId: 'cid', clientVersion: PROTOCOL_COMPAT_VERSION, requestId: '0f8fad5b-d9cb-469f-a165-70867728950e' });
    expect(s).toBe('{"MessageSchemaVersion":"1.0","RequestId":"0f8fad5b-d9cb-469f-a165-70867728950e","TokenValue":"tok","ClientId":"cid","ClientVersion":"1.2.896.0"}');
    expect(parseOpenDataChannel(s)).toMatchObject({ TokenValue: 'tok', ClientId: 'cid' });
    expect(parseOpenDataChannel('{"TokenValue":1}')).toBeNull();
    expect(parseOpenDataChannel('nope')).toBeNull();
  });
});

describe('AcknowledgeContent / SizeData / ChannelClosed', () => {
  it('encodes the acknowledge content like the plugin', () => {
    const b = encodeAcknowledgeContent({ AcknowledgedMessageType: 'output_stream_data', AcknowledgedMessageId: 'a', AcknowledgedMessageSequenceNumber: 12, IsSequentialMessage: true });
    expect(utf8Decode(b)).toBe('{"AcknowledgedMessageType":"output_stream_data","AcknowledgedMessageId":"a","AcknowledgedMessageSequenceNumber":12,"IsSequentialMessage":true}');
    expect(decodeAcknowledgeContent(b)).toMatchObject({ AcknowledgedMessageSequenceNumber: 12 });
    expect(decodeAcknowledgeContent(utf8Encode('{"AcknowledgedMessageSequenceNumber":"x"}'))).toBeNull();
  });

  it('encodes the terminal size as {"cols","rows"}', () => {
    expect(utf8Decode(encodeSize({ cols: 120, rows: 40 }))).toBe('{"cols":120,"rows":40}');
    expect(decodeSize(encodeSize({ cols: 80, rows: 24 }))).toEqual({ cols: 80, rows: 24 });
    expect(decodeSize(utf8Encode('{"cols":0,"rows":24}'))).toBeNull();
    expect(decodeSize(utf8Encode('{"cols":1.5,"rows":24}'))).toBeNull();
  });

  it('decodes channel_closed leniently (zero values on bad JSON)', () => {
    const c = decodeChannelClosed(utf8Encode('{"SessionId":"s-1","Output":"Your session timed out","SchemaVersion":1}'));
    expect(c).toMatchObject({ SessionId: 's-1', Output: 'Your session timed out', SchemaVersion: 1, MessageId: '' });
    expect(decodeChannelClosed(utf8Encode('not json')).Output).toBe('');
  });
});

describe('chunkUtf8 (StreamDataPayloadSize 1024, no split inside a UTF-8 sequence)', () => {
  it('keeps every chunk ≤ max and never starts a chunk with a continuation byte', () => {
    const text = 'a中文テスト😀é'.repeat(400);
    const bytes = utf8Encode(text);
    const chunks = chunkUtf8(bytes, 1024);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1024);
      expect(c[0]! & 0xc0).not.toBe(0x80);
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(c)).not.toThrow();
    }
    expect(chunks.map((c) => utf8Decode(c)).join('')).toBe(text);
  });

  it('handles small inputs, exact multiples and invalid UTF-8', () => {
    expect(chunkUtf8(new Uint8Array(0), 1024)).toEqual([]);
    expect(chunkUtf8(new Uint8Array(2048), 1024).map((c) => c.length)).toEqual([1024, 1024]);
    const cont = new Uint8Array(10).fill(0x80);
    expect(chunkUtf8(cont, 4).map((c) => c.length)).toEqual([4, 4, 2]);
    expect(() => chunkUtf8(new Uint8Array(1), 3)).toThrow(RangeError);
  });
});

describe('handshake (03 §3.5.4)', () => {
  const request = (actions: unknown[]): Uint8Array => utf8Encode(JSON.stringify({ AgentVersion: '3.3.40.0', RequestedClientActions: actions }));

  it('accepts a Standard_Stream session type', () => {
    const req = parseHandshakeRequest(request([{ ActionType: 'SessionType', ActionParameters: { SessionType: 'Standard_Stream', Properties: null } }]))!;
    const out = processHandshakeRequest(req, PROTOCOL_COMPAT_VERSION);
    expect(out).toMatchObject({ agentVersion: '3.3.40.0', sessionType: 'Standard_Stream', rejected: null });
    expect(utf8Decode(encodeHandshakeResponse(out.response))).toBe(
      '{"ClientVersion":"1.2.896.0","ProcessedClientActions":[{"ActionType":"SessionType","ActionStatus":1,"ActionResult":null,"Error":""}],"Errors":[]}',
    );
  });

  it('answers KMSEncryption with Failed and rejects the session', () => {
    const req = parseHandshakeRequest(request([
      { ActionType: 'SessionType', ActionParameters: { SessionType: 'Standard_Stream' } },
      { ActionType: 'KMSEncryption', ActionParameters: { KMSKeyId: 'arn:aws:kms:ap-northeast-1:000000000000:key/x' } },
    ]))!;
    const out = processHandshakeRequest(req, PROTOCOL_COMPAT_VERSION);
    expect(out.rejected).toBe('kms-unsupported');
    expect(out.response.ProcessedClientActions[1]).toEqual({ ActionType: 'KMSEncryption', ActionStatus: ActionStatus.Failed, ActionResult: null, Error: KMS_UNSUPPORTED_ERROR });
    expect(out.response.Errors).toEqual([KMS_UNSUPPORTED_ERROR]);
  });

  it('marks other session types and unknown actions Unsupported', () => {
    const req = parseHandshakeRequest(request([
      { ActionType: 'SessionType', ActionParameters: { SessionType: 'Port' } },
      { ActionType: 'Teleport', ActionParameters: {} },
    ]))!;
    const out = processHandshakeRequest(req, '1.0.0.0');
    expect(out.rejected).toBe('session-type-unsupported');
    expect(out.response.ProcessedClientActions.map((a) => a.ActionStatus)).toEqual([ActionStatus.Unsupported, ActionStatus.Unsupported]);
    expect(out.response.Errors).toEqual(['Unsupported session type Port', 'Unsupported action Teleport']);
  });

  it('tolerates odd requests and parses HandshakeComplete', () => {
    expect(parseHandshakeRequest(utf8Encode('[]'))).toBeNull();
    expect(processHandshakeRequest(parseHandshakeRequest(utf8Encode('{}'))!, 'v').response.ProcessedClientActions).toEqual([]);
    expect(parseHandshakeComplete(utf8Encode('{"HandshakeTimeToComplete":1500000,"CustomerMessage":"hi"}'))).toEqual({ HandshakeTimeToComplete: 1_500_000, CustomerMessage: 'hi' });
  });
});

describe('StreamUrl check (03 §3.2 step 8; plugin validateStreamUrl)', () => {
  const ok = 'wss://ssmmessages.ap-northeast-1.amazonaws.com/v1/data-channel/atl-s1-term-0a1b2c3d4e5f67890?role=publish_subscribe';
  it('accepts the regional ssmmessages endpoint and keeps the URL unchanged', () => {
    expect(checkStreamUrl(ok)).toEqual({ ok: true, url: ok });
    expect(checkStreamUrl(ok, { region: 'ap-northeast-1' }).ok).toBe(true);
    expect(checkStreamUrl('wss://ssmmessages.cn-north-1.amazonaws.com.cn/v1/data-channel/x', { region: 'cn-north-1' }).ok).toBe(true);
    expect(checkStreamUrl('wss://ssmmessages.us-gov-west-1.amazonaws.com/v1/data-channel/x').ok).toBe(true);
  });

  it('rejects other schemes, hosts, regions and userinfo', () => {
    expect(checkStreamUrl(ok.replace('wss:', 'ws:')).ok).toBe(false);
    expect(checkStreamUrl(ok, { region: 'us-east-1' }).ok).toBe(false);
    expect(checkStreamUrl('wss://evil.example/v1/data-channel/x').ok).toBe(false);
    expect(checkStreamUrl('wss://ssmmessages.ap-northeast-1.amazonaws.com.evil.example/x').ok).toBe(false);
    expect(checkStreamUrl('wss://user:pw@ssmmessages.ap-northeast-1.amazonaws.com/x')).toEqual({ ok: false, reason: 'StreamUrl must not contain userinfo' });
    expect(checkStreamUrl('::not a url').ok).toBe(false);
  });

  it('allows loopback only when asked (local mock) and extra hosts by exact name', () => {
    expect(checkStreamUrl('ws://127.0.0.1:8790/v1/data-channel/x').ok).toBe(false);
    expect(checkStreamUrl('ws://127.0.0.1:8790/v1/data-channel/x', { allowLoopback: true }).ok).toBe(true);
    expect(checkStreamUrl('ws://evil.example/v1/data-channel/x', { allowLoopback: true }).ok).toBe(false);
    expect(checkStreamUrl('wss://ssmmessages.ap-northeast-1.api.aws/x', { additionalHosts: ['ssmmessages.ap-northeast-1.api.aws'] }).ok).toBe(true);
  });
});

describe('reconnect backoff (plugin retry parameters)', () => {
  it('starts at 100–199 ms, doubles, caps at 5 s, 5 attempts', () => {
    expect(DEFAULT_BACKOFF).toEqual({ initialDelayMs: 100, factor: 2, maxDelayMs: 5000, maxAttempts: 5 });
    const i0 = initialDelay(DEFAULT_BACKOFF, () => 0);
    expect(i0).toBe(100);
    expect(initialDelay(DEFAULT_BACKOFF, () => 0.999)).toBe(199);
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, i0, DEFAULT_BACKOFF))).toEqual([100, 200, 400, 800, 1600, 3200, 5000]);
  });
});
