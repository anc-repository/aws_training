import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MessageType,
  PROTOCOL_COMPAT_VERSION,
  PayloadType,
  SsmTerminalConnection,
  decodeAndValidate,
  decodeSize,
  isUuid,
  localConnectDeadline,
  parseOpenDataChannel,
  type NetworkStatus,
  type SsmTerminalConnectionOptions,
  type StateChange,
  type StreamCredentials,
} from '../src/index.js';
import { MockSsmService, createMemorySocketPair, memoryWebSocketFactory, type MockSsmServiceOptions, type StartSessionOutput } from '../src/mock/index.js';
import { plain } from './helpers.js';

/** Lets microtask-driven memory sockets and fake timers run. */
async function settle(ms = 20): Promise<void> {
  for (let i = 0; i < ms; i++) await vi.advanceTimersByTimeAsync(1);
}

class FakeNetwork implements NetworkStatus {
  online = true;
  private cbs = new Set<() => void>();
  isOnline(): boolean {
    return this.online;
  }
  onOnline(cb: () => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  goOnline(): void {
    this.online = true;
    for (const cb of [...this.cbs]) cb();
  }
}

function setup(svcOpts: MockSsmServiceOptions = {}, connOpts: Partial<SsmTerminalConnectionOptions> = {}) {
  const svc = new MockSsmService({ idleTimeoutMs: 0, ...svcOpts });
  const factory = memoryWebSocketFactory((server, url) => svc.attachByUrl(server, url));
  const network = new FakeNetwork();
  let session: StartSessionOutput | null = null;
  const opened: StartSessionOutput[] = [];
  const decoder = new TextDecoder();
  let text = '';
  const states: StateChange[] = [];
  const resume = vi.fn(async (): Promise<StreamCredentials> => {
    const r = svc.resumeSession(session!.SessionId);
    return { streamUrl: r.StreamUrl, tokenValue: r.TokenValue };
  });
  const conn = new SsmTerminalConnection({
    open: async () => {
      session = svc.startSession({ sessionName: 'atl-s4k7m2q9x1abc-term' });
      opened.push(session);
      return { streamUrl: session.StreamUrl, tokenValue: session.TokenValue };
    },
    resume,
    clientId: 'b6a0f0d2-4a8e-4c43-9d0a-3d3f2b7e9c11',
    webSocketFactory: factory,
    streamUrlPolicy: { allowLoopback: true },
    network,
    random: () => 0,
    onOutput: (d, done) => {
      text += decoder.decode(d, { stream: true });
      done();
    },
    ...connOpts,
  });
  conn.on('state', (s) => states.push(s));
  return {
    svc, factory, network, conn, states, resume, opened,
    get session() { return session!; },
    get info() { return svc.getSession(session!.SessionId)!; },
    get text() { return plain(text); },
    clearText: () => { text = ''; },
    stateNames: () => states.map((s) => s.state),
    /** binary frames the client sent on all sockets, decoded */
    clientFrames: () => factory.pairs.flatMap((p) => p.client.sent).filter((f): f is Uint8Array => typeof f !== 'string').map((f) => decodeAndValidate(f)),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-14T00:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('connect and handshake (03 §3.5.1, §3.5.4)', () => {
  it('opens with the OpenDataChannel text frame, answers the handshake and becomes ready', async () => {
    const h = setup();
    const handshakes: unknown[] = [];
    h.conn.on('handshake', (x) => handshakes.push(x));
    h.conn.resize(100, 30);
    await h.conn.start();
    await settle();
    expect(h.stateNames()).toEqual(['requesting', 'connecting', 'authenticating', 'handshaking', 'ready']);
    const first = h.factory.pairs[0]!.client.sent[0];
    expect(typeof first).toBe('string');
    const odc = parseOpenDataChannel(first as string)!;
    expect(odc).toMatchObject({ MessageSchemaVersion: '1.0', TokenValue: h.opened[0]!.TokenValue, ClientId: 'b6a0f0d2-4a8e-4c43-9d0a-3d3f2b7e9c11', ClientVersion: PROTOCOL_COMPAT_VERSION });
    expect(isUuid(odc.RequestId)).toBe(true);
    expect(h.factory.pairs[0]!.client.binaryType).toBe('arraybuffer');
    expect(h.info.handshake).toBe('complete');
    expect(h.info.handshakeResponse).toEqual({
      ClientVersion: PROTOCOL_COMPAT_VERSION,
      ProcessedClientActions: [{ ActionType: 'SessionType', ActionStatus: 1, ActionResult: null, Error: '' }],
      Errors: [],
    });
    expect(handshakes).toEqual([{ skipped: false, agentVersion: '3.3.0.0-mock', sessionType: 'Standard_Stream', customerMessage: '' }]);
    // HandshakeResponse is seq 0, then the size on Ready
    expect(h.clientFrames().filter((m) => m.messageType === MessageType.InputStreamData).map((m) => [Number(m.sequenceNumber), m.payloadType])).toEqual([[0, PayloadType.HandshakeResponse], [1, PayloadType.Size]]);
    expect(h.info.size).toEqual({ cols: 100, rows: 30 });
    expect(h.text).toContain('labuser@ip-10-0-1-23:~$ ');
  });

  it('goes straight to ready on the first Output when the agent skips the handshake', async () => {
    const h = setup({ handshake: 'none' });
    const handshakes: unknown[] = [];
    h.conn.on('handshake', (x) => handshakes.push(x));
    await h.conn.start();
    await settle();
    expect(h.stateNames()).toEqual(['requesting', 'connecting', 'authenticating', 'ready']);
    expect(handshakes).toEqual([{ skipped: true, agentVersion: '', sessionType: null, customerMessage: '' }]);
    expect(h.info.handshake).toBe('skipped');
  });

  it('queues keystrokes and the size until ready (the agent ignores input during the handshake)', async () => {
    const h = setup();
    h.conn.resize(90, 20);
    expect(h.conn.sendInput('stty size\r')).toBe(true);
    await h.conn.start();
    await settle();
    expect(h.info.ignoredDuringHandshake).toBe(0);
    expect(h.text).toContain('stty size\r\n20 90\r\n');
    const sent = h.clientFrames().filter((m) => m.messageType === MessageType.InputStreamData).map((m) => m.payloadType);
    expect(sent).toEqual([PayloadType.HandshakeResponse, PayloadType.Size, PayloadType.Output]);
  });

  it('fails with kms-unsupported when the agent requests KMS encryption', async () => {
    const h = setup({ handshake: 'kms' });
    await h.conn.start();
    await settle();
    expect(h.conn.state).toBe('failed');
    expect(h.states.at(-1)!.failure!.reason).toBe('kms-unsupported');
    const kms = h.info.handshakeResponse!.ProcessedClientActions.find((a) => a.ActionType === 'KMSEncryption')!;
    expect(kms).toMatchObject({ ActionStatus: 2, Error: 'ATL web terminal does not support KMS session encryption' });
  });

  it('fails with handshake-timeout when nothing arrives within 15 s after OpenDataChannel', async () => {
    const pairs: ReturnType<typeof createMemorySocketPair>[] = [];
    const conn = new SsmTerminalConnection({
      open: async () => ({ streamUrl: 'wss://ssmmessages.ap-northeast-1.amazonaws.com/v1/data-channel/s?role=publish_subscribe', tokenValue: 't' }),
      clientId: 'c',
      webSocketFactory: (url) => {
        const p = createMemorySocketPair(url); // nobody answers
        pairs.push(p);
        return p.client;
      },
    });
    const states: StateChange[] = [];
    conn.on('state', (s) => states.push(s));
    await conn.start();
    await settle();
    expect(conn.state).toBe('authenticating');
    await vi.advanceTimersByTimeAsync(14_900);
    expect(conn.state).toBe('authenticating');
    await vi.advanceTimersByTimeAsync(200);
    expect(conn.state).toBe('failed');
    expect(states.at(-1)!.failure!.reason).toBe('handshake-timeout');
    expect(pairs[0]!.client.readyState).toBe(3);
  });

  it('fails with connect-failed when the socket is closed before ready (e.g. rejected token)', async () => {
    const h = setup({}, {
      open: async () => {
        const s = h.svc.startSession();
        return { streamUrl: s.StreamUrl, tokenValue: 'wrong-token' };
      },
    });
    await h.conn.start();
    await settle();
    expect(h.conn.state).toBe('failed');
    expect(h.states.at(-1)!.failure).toMatchObject({ reason: 'connect-failed', closeCode: 1008 });
  });

  it('refuses a StreamUrl that is not a Session Manager endpoint', async () => {
    const h = setup({}, { open: async () => ({ streamUrl: 'wss://evil.example/v1/data-channel/x', tokenValue: 't' }) });
    await h.conn.start();
    expect(h.conn.state).toBe('failed');
    expect(h.states.at(-1)!.failure!.reason).toBe('invalid-stream-url');
    expect(h.factory.pairs).toHaveLength(0);
  });

  it('reports open-failed with the API error', async () => {
    const err = Object.assign(new Error('Reauthentication required'), { status: 403, code: 'REAUTH_REQUIRED' });
    const h = setup({}, { open: async () => { throw err; } });
    await h.conn.start();
    expect(h.states.at(-1)!.failure).toMatchObject({ reason: 'open-failed', error: err });
  });
});

describe('input, output and size (03 §3.5.6, §3.5.7)', () => {
  it('sends Size only when it changes', async () => {
    const h = setup();
    h.conn.resize(80, 24);
    await h.conn.start();
    await settle();
    const before = h.conn.diagnostics().nextSequenceNumber;
    h.conn.resize(80, 24);
    expect(h.conn.diagnostics().nextSequenceNumber).toBe(before);
    h.conn.resize(132, 43);
    h.conn.resize(0, 10); // invalid, ignored
    await settle();
    expect(h.conn.diagnostics().nextSequenceNumber).toBe(before + 1);
    h.conn.sendInput('stty size\r');
    await settle();
    expect(h.text).toContain('43 132');
    const sizes = h.clientFrames().filter((m) => m.payloadType === PayloadType.Size).map((m) => decodeSize(m.payload));
    expect(sizes).toEqual([{ cols: 80, rows: 24 }, { cols: 132, rows: 43 }]);
  });

  it('turns a lone "\\n" into "\\r" and splits a 64 KB paste into ≤ 1024-byte UTF-8-safe payloads', async () => {
    const h = setup({ mode: 'echo', handshake: 'none' });
    await h.conn.start();
    await settle();
    h.clearText();
    h.conn.sendInput('\n');
    await settle();
    expect(h.text).toBe('\r');
    h.clearText();
    const big = '粘贴测试 paste ✓ '.repeat(3000);
    h.conn.sendInput(big);
    await settle(50);
    expect(h.text).toBe(big);
    const outputs = h.clientFrames().filter((m) => m.messageType === MessageType.InputStreamData && m.payloadType === PayloadType.Output);
    expect(Math.max(...outputs.map((m) => m.payload.length))).toBeLessThanOrEqual(1024);
    expect(outputs.length).toBeGreaterThan(60);
  });

  it('acknowledges output only after the sink is done (back-pressure)', async () => {
    const pendingDone: (() => void)[] = [];
    const h = setup({ handshake: 'none' }, { onOutput: (_d, done) => pendingDone.push(done) });
    await h.conn.start();
    await settle();
    h.conn.sendInput('seq 1 300\r');
    await settle();
    expect(h.info.unacknowledgedOutput).toBeGreaterThan(0);
    for (const d of pendingDone.splice(0)) d();
    await settle();
    for (const d of pendingDone.splice(0)) d();
    await settle();
    expect(h.info.unacknowledgedOutput).toBe(0);
  });

  it('shows output delivered out of order, duplicated or corrupted exactly once and in order', async () => {
    const clean = setup({ handshake: 'none', outputChunkSize: 16 });
    await clean.conn.start();
    await settle();
    clean.conn.sendInput('seq 1 200\r');
    await settle(400);

    const faulty = setup({
      handshake: 'none',
      outputChunkSize: 16,
      faults: {
        holdOutput: (seq) => seq % 7 === 3,
        duplicateOutput: (seq) => seq % 5 === 1,
        corruptOutput: (seq, attempt) => seq % 11 === 4 && attempt === 0,
        dropOutput: (seq, attempt) => seq % 13 === 6 && attempt === 0,
      },
    });
    await faulty.conn.start();
    await settle();
    faulty.conn.sendInput('seq 1 200\r');
    await settle(4000); // the agent re-sends one lost message per 100 ms tick
    expect(faulty.text).toBe(clean.text);
    expect(faulty.text).toContain('\r\n200\r\n');
    const d = faulty.conn.diagnostics();
    expect(d.stats.outOfOrder).toBeGreaterThan(0);
    expect(d.stats.duplicates).toBeGreaterThan(0);
    expect(d.stats.digestMismatches).toBeGreaterThan(0);
    expect(faulty.info.unacknowledgedOutput).toBe(0);
  });

  it('ignores start_publication / pause_publication (counted as diagnostics)', async () => {
    const h = setup({ publicationSignals: true });
    const diags: string[] = [];
    h.conn.on('diagnostic', (e) => diags.push(e.type));
    await h.conn.start();
    await settle();
    expect(h.conn.state).toBe('ready');
    expect(diags).toContain('publication');
  });
});

describe('channel_closed and local close (03 §3.5.10)', () => {
  it('closes with the reason text when the session is terminated or times out', async () => {
    const h = setup({ idleTimeoutMs: 60_000 });
    await h.conn.start();
    await settle();
    h.conn.sendInput('echo hi\r');
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(h.conn.state).toBe('closed');
    expect(h.states.at(-1)!.closed).toEqual({ reason: 'channel-closed', output: 'mock: session was idle for 1 minutes' });
    expect(h.conn.sendInput('x')).toBe(false);
    expect(h.conn.lastInputAt).not.toBeNull();
    expect(h.conn.readyAt).not.toBeNull();
  });

  it('closes on exit and on TerminateSession', async () => {
    const h = setup();
    await h.conn.start();
    await settle();
    h.conn.sendInput('exit\r');
    await settle();
    expect(h.states.at(-1)!.closed).toEqual({ reason: 'channel-closed', output: '' });

    const t = setup();
    await t.conn.start();
    await settle();
    t.svc.terminateSession(t.session.SessionId);
    await settle();
    expect(t.conn.state).toBe('closed');
  });

  it('close("access-revoked") closes the socket and stops reconnecting', async () => {
    const h = setup();
    await h.conn.start();
    await settle();
    h.conn.close('access-revoked');
    await settle();
    expect(h.states.at(-1)!.closed).toEqual({ reason: 'access-revoked' });
    expect(h.factory.pairs[0]!.client.readyState).toBe(3);
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.info.status).toBe('Disconnected');
  });
});

describe('reconnect and resume (03 §3.5.9)', () => {
  it('resumes after a network drop with the same sequence numbers, without losing or repeating output', async () => {
    const h = setup({ handshake: 'none', outputChunkSize: 32, faults: { dropOutput: (seq, attempt) => attempt === 0 && seq >= 4 && seq < 40 } });
    h.conn.resize(80, 24);
    await h.conn.start();
    await settle();
    h.conn.sendInput('seq 1 300\r');
    await settle(2);
    const before = h.conn.diagnostics();
    h.svc.dropConnection(h.session.SessionId);
    h.conn.sendInput('echo typed-while-offline\r');
    await settle(2);
    expect(h.conn.state).toBe('reconnecting');
    expect(h.states.at(-1)!.reconnect).toEqual({ attempt: 1, maxAttempts: 5, delayMs: 100 });
    await settle(400);
    expect(h.conn.state).toBe('ready');
    expect(h.states.filter((s) => s.state === 'ready').map((s) => s.resumed)).toEqual([false, true]);
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.info.connections).toBe(2);
    const after = h.conn.diagnostics();
    expect(after.nextSequenceNumber).toBeGreaterThan(before.nextSequenceNumber);
    expect(after.reconnects).toBe(1);
    const lines = h.text.split('\r\n').filter((l) => /^\d+$/.test(l)).map(Number);
    expect(lines).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(h.text).toContain('typed-while-offline\r\ntyped-while-offline');
    expect(h.info.unacknowledgedOutput).toBe(0);
    // the size is sent again after the resume
    expect(h.clientFrames().filter((m) => m.payloadType === PayloadType.Size)).toHaveLength(2);
  });

  it('fails with gone when resume reports TERMINAL_GONE', async () => {
    const h = setup({}, { resume: async () => { throw Object.assign(new Error('gone'), { status: 409, code: 'TERMINAL_GONE' }); } });
    await h.conn.start();
    await settle();
    h.svc.dropConnection(h.session.SessionId);
    await settle(300);
    expect(h.states.at(-1)!.failure!.reason).toBe('gone');
  });

  it('fails with resume-rejected on a non-retryable API error', async () => {
    const h = setup({}, { resume: async () => { throw Object.assign(new Error('reauth'), { status: 403, code: 'REAUTH_REQUIRED' }); } });
    await h.conn.start();
    await settle();
    h.svc.dropConnection(h.session.SessionId);
    await settle(300);
    expect(h.states.at(-1)!.failure!.reason).toBe('resume-rejected');
  });

  it('backs off 100, 200, 400, 800, 1600 ms on network errors and gives up after 5 attempts', async () => {
    const resume = vi.fn(async (): Promise<StreamCredentials> => { throw Object.assign(new Error('offline'), { status: 0, code: 'NETWORK' }); });
    const h = setup({}, { resume });
    await h.conn.start();
    await settle();
    h.svc.dropConnection(h.session.SessionId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resume).toHaveBeenCalledTimes(5);
    expect(h.states.filter((s) => s.state === 'reconnecting').map((s) => s.reconnect!.delayMs)).toEqual([100, 200, 400, 800, 1600]);
    expect(h.states.at(-1)!.failure!.reason).toBe('reconnect-exhausted');
  });

  it('does not count attempts while offline and continues on the online event', async () => {
    const h = setup();
    await h.conn.start();
    await settle();
    h.network.online = false;
    h.svc.dropConnection(h.session.SessionId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toMatchObject({ state: 'reconnecting', reconnect: { attempt: 1, waitingForNetwork: true } });
    h.network.goOnline();
    await settle(300);
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.conn.state).toBe('ready');
  });

  it('retryNow skips the backoff wait', async () => {
    const h = setup();
    await h.conn.start();
    await settle();
    h.svc.dropConnection(h.session.SessionId);
    await settle(2);
    expect(h.conn.state).toBe('reconnecting');
    h.conn.retryNow();
    await settle(5);
    expect(h.conn.state).toBe('ready');
  });

  it('treats a message beyond the retransmission limit as a dead connection and resumes', async () => {
    let dropBudget = 0;
    const h = setup({ faults: { dropAck: () => dropBudget-- > 0 } }, { channelTiming: { resendMaxAttempt: 3 } });
    const diags: string[] = [];
    h.conn.on('diagnostic', (e) => diags.push(e.type));
    await h.conn.start();
    await settle();
    dropBudget = 4; // the first transmission and 3 retransmissions of the next input lose their acknowledge
    h.conn.sendInput('a');
    await settle(3000);
    expect(diags.filter((d) => d === 'retransmit')).toHaveLength(3);
    expect(diags).toContain('resend-exhausted');
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.conn.state).toBe('ready');
    expect(h.conn.diagnostics().unacknowledged).toBe(0);
  });

  it('does not use a token past connectBy: it resumes first', async () => {
    const h = setup();
    const conn = new SsmTerminalConnection({
      open: async () => {
        const s = h.svc.startSession();
        stale = s;
        return { streamUrl: s.StreamUrl, tokenValue: s.TokenValue, connectBy: new Date(Date.now() - 1000).toISOString() };
      },
      resume: async () => {
        const r = h.svc.resumeSession(stale!.SessionId);
        return { streamUrl: r.StreamUrl, tokenValue: r.TokenValue };
      },
      clientId: 'c',
      webSocketFactory: h.factory,
      streamUrlPolicy: { allowLoopback: true },
      network: h.network,
      random: () => 0,
    });
    let stale: StartSessionOutput | null = null;
    await conn.start();
    await settle(300);
    expect(conn.state).toBe('ready');
    const firstFrame = h.factory.pairs[0]!.client.sent[0] as string;
    expect(parseOpenDataChannel(firstFrame)!.TokenValue).not.toBe(stale!.TokenValue);
    expect(conn.handshake?.skipped).toBe(false);
  });

  it('a browser clock 60 s ahead of the server still connects: connectBy is judged relative to serverNow', async () => {
    const h = setup();
    const skewMs = 60_000;
    let issued: StartSessionOutput | null = null;
    const resume = vi.fn(async (): Promise<StreamCredentials> => {
      const r = h.svc.resumeSession(issued!.SessionId);
      return { streamUrl: r.StreamUrl, tokenValue: r.TokenValue };
    });
    const conn = new SsmTerminalConnection({
      open: async () => {
        issued = h.svc.startSession();
        const serverNow = Date.now(); // the server's clock; the browser below reads it + 60 s
        return { streamUrl: issued.StreamUrl, tokenValue: issued.TokenValue, connectBy: new Date(serverNow + 30_000).toISOString(), serverNow: new Date(serverNow).toISOString() };
      },
      resume,
      clientId: 'c',
      webSocketFactory: h.factory,
      streamUrlPolicy: { allowLoopback: true },
      network: h.network,
      random: () => 0,
      now: () => Date.now() + skewMs,
    });
    await conn.start();
    await settle(300);
    expect(conn.state).toBe('ready');
    expect(resume).not.toHaveBeenCalled();
    expect(parseOpenDataChannel(h.factory.pairs[0]!.client.sent[0] as string)!.TokenValue).toBe(issued!.TokenValue);
  });

  it('localConnectDeadline: relative with serverNow, absolute without', () => {
    const connectBy = '2026-10-14T01:00:30.000Z';
    expect(localConnectDeadline({ connectBy }, 0)).toBe(Date.parse(connectBy));
    expect(localConnectDeadline({ connectBy, serverNow: '2026-10-14T01:00:00.000Z' }, 5_000)).toBe(35_000);
    expect(localConnectDeadline({ connectBy, serverNow: Date.parse('2026-10-14T01:01:00.000Z') }, 5_000)).toBe(-25_000);
    expect(localConnectDeadline({ connectBy: null, serverNow: 1 }, 5)).toBeNull();
    expect(localConnectDeadline({ connectBy, serverNow: 'not a date' }, 5)).toBe(Date.parse(connectBy));
  });

  it('fails with connection-lost when no resume function is given', async () => {
    const h = setup({}, { resume: undefined });
    await h.conn.start();
    await settle();
    h.svc.dropConnection(h.session.SessionId);
    await settle();
    expect(h.states.at(-1)!.failure!.reason).toBe('connection-lost');
  });
});

describe('misc', () => {
  it('buffers output until a sink is attached', async () => {
    const h = setup({}, { onOutput: undefined });
    await h.conn.start();
    await settle();
    const chunks: string[] = [];
    h.conn.setOutputSink((d, done) => {
      chunks.push(new TextDecoder().decode(d));
      done();
    });
    expect(plain(chunks.join(''))).toContain('ATL local mock shell');
  });

  it('start() twice throws; dispose() closes', async () => {
    const h = setup();
    await h.conn.start();
    await expect(h.conn.start()).rejects.toThrow(/start\(\) in state/);
    h.conn.dispose();
    expect(h.conn.state).toBe('closed');
  });
});
