import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { setSsmClient, type SsmClientModule, type SsmConnectionOptions, type SsmStateChange } from './channel';
import { overlayOf, PROMPT_GRACE_MS, PROMPT_WAIT_MS, TerminalController, type XtermLike } from './controller';
import { localConnectDeadline } from '@atl/ssm-client';

class FakeConn {
  static last: FakeConn | null = null;
  state: SsmStateChange['state'] = 'idle';
  lastInputAt: number | null = null;
  readyAt: number | null = null;
  inputs: (string | Uint8Array)[] = [];
  sizes: [number, number][] = [];
  closed: string | null = null;
  sink: ((d: Uint8Array, done: () => void) => void) | null = null;
  private l = new Set<(e: SsmStateChange) => void>();
  constructor(public readonly opts: SsmConnectionOptions) {
    FakeConn.last = this;
  }
  on(_t: string, fn: (e: SsmStateChange) => void) {
    this.l.add(fn);
    return () => this.l.delete(fn);
  }
  emit(state: SsmStateChange['state'], extra: Partial<SsmStateChange> = {}) {
    const previous = this.state;
    this.state = state;
    for (const f of this.l) f({ state, previous, ...extra });
  }
  setOutputSink(s: FakeConn['sink']) {
    this.sink = s;
  }
  async start() {
    this.emit('requesting');
    try {
      await this.opts.open();
    } catch (error) {
      this.emit('failed', { failure: { reason: 'open-failed', message: 'x', error } });
      return;
    }
    this.emit('connecting');
  }
  sendInput(d: string | Uint8Array) {
    this.inputs.push(d);
    return true;
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  retryNow() {}
  close(reason = 'user') {
    this.closed = reason;
    this.emit('closed', { closed: { reason: reason as 'user' } });
  }
  dispose() {
    this.close();
  }
}

const MOD: SsmClientModule = { SsmTerminalConnection: FakeConn as unknown as SsmClientModule['SsmTerminalConnection'], getTabClientId: () => 'client-1' };

function fakeTerm(): XtermLike & { pasted: string[]; written: (string | Uint8Array)[]; osc: Map<number, (d: string) => boolean> } {
  const osc = new Map<number, (d: string) => boolean>();
  const t = {
    cols: 100,
    rows: 30,
    modes: { bracketedPasteMode: true },
    pasted: [] as string[],
    written: [] as (string | Uint8Array)[],
    osc,
    write(d: string | Uint8Array, cb?: () => void) {
      t.written.push(d);
      cb?.();
    },
    paste(s: string) {
      t.pasted.push(s);
    },
    focus() {},
    onData() {
      return { dispose() {} };
    },
    parser: {
      registerOscHandler(id: number, cb: (d: string) => boolean) {
        osc.set(id, cb);
        return { dispose: () => osc.delete(id) };
      },
    },
  };
  return t;
}

function api(handler: (routeId: string, opts: { params?: Record<string, string>; body?: unknown }) => unknown) {
  return { call: vi.fn(async (routeId: string, opts: { params?: Record<string, string>; body?: unknown } = {}) => ({ status: 200, data: await handler(routeId, opts), etag: null, notModified: false, headers: new Headers() })) };
}

afterEach(() => setSsmClient(undefined));

describe('TerminalController (03 §3.2, §3.5.9, §3.9)', () => {
  it('opens through POST …/terminals with the tab clientId and pipes output / input', async () => {
    const a = api((id) => (id === 'createTerminal' ? { terminalId: 't1', ssmSessionId: 'atl-s1-term-1', instanceId: 'i-0abc1234def567890', streamUrl: 'wss://ssmmessages.ap-northeast-1.amazonaws.com/v1/data-channel/x', tokenValue: 'tok', runAs: 'labuser', idleTimeoutMin: 20, maxDurationMin: 240 } : null));
    const c = new TerminalController({ api: a as never, sid: 's1', target: 'lab', client: MOD, region: 'ap-northeast-1' });
    const term = fakeTerm();
    c.attach(term);
    await c.open();
    expect(a.call).toHaveBeenCalledWith('createTerminal', expect.objectContaining({ params: { sid: 's1' }, body: { target: 'lab', cols: 100, rows: 30, clientId: 'client-1' } }));
    const conn = FakeConn.last!;
    expect(conn.opts.streamUrlPolicy).toEqual({ region: 'ap-northeast-1' });
    expect(c.getSnapshot()).toMatchObject({ phase: 'connecting', terminalId: 't1', runAs: 'labuser', instanceId: 'i-0abc1234def567890' });
    conn.emit('ready');
    expect(c.getSnapshot().phase).toBe('ready');
    conn.sink!(new Uint8Array([104, 105]), () => undefined);
    expect(term.written).toHaveLength(1);
    expect(c.paste('ls -la', true)).toBe(true);
    expect(term.pasted).toEqual(['ls -la']);
    expect(conn.inputs).toEqual(['\r']);
  });

  it('API refusals become blocked overlays (agent offline, not prepared, reauth, limit, no provider)', async () => {
    for (const [code, overlay] of [
      ['TERMINAL_TARGET_NOT_CONNECTED', 'agent-offline'],
      ['TERMINAL_TARGET_NOT_PREPARED', 'not-prepared'],
      ['REAUTH_REQUIRED', 'reauth'],
      ['TERMINAL_LIMIT', 'limit'],
      ['NOT_IMPLEMENTED', 'unavailable'],
      ['TERMINAL_SESSION_STATE', 'revoked'],
    ] as const) {
      const a = api(() => {
        throw new ApiError({ status: 409, code });
      });
      const c = new TerminalController({ api: a as never, sid: 's1', target: 'workstation', client: MOD });
      await c.open();
      expect(c.getSnapshot()).toMatchObject({ phase: 'blocked', error: { code } });
      expect(overlayOf(c.getSnapshot(), { expectedOutage: false, replaced: false })).toBe(overlay);
    }
    const a = api(() => {
      throw new ApiError({ status: 409, code: 'TERMINAL_TARGET_NOT_CONNECTED' });
    });
    const c = new TerminalController({ api: a as never, sid: 's1', target: 'lab', client: MOD });
    await c.open();
    expect(overlayOf(c.getSnapshot(), { expectedOutage: true, replaced: false })).toBe('expected-outage');
  });

  it('missing protocol layer → “终端暂时不可用”', async () => {
    setSsmClient(null);
    const c = new TerminalController({ api: api(() => null) as never, sid: 's1', target: 'lab' });
    await c.open();
    expect(c.getSnapshot().error?.code).toBe('CLIENT_UNAVAILABLE');
    expect(overlayOf(c.getSnapshot(), { expectedOutage: false, replaced: false })).toBe('unavailable');
  });

  it('handshake timeout ends the SSM session; reconnecting shows attempt n/5; channel_closed after idle', async () => {
    const a = api((id) => (id === 'createTerminal' ? { terminalId: 't9', streamUrl: 'wss://ssmmessages.x.amazonaws.com/a', tokenValue: 't' } : null));
    const c = new TerminalController({ api: a as never, sid: 's1', target: 'lab', client: MOD });
    await c.open();
    FakeConn.last!.emit('failed', { failure: { reason: 'handshake-timeout', message: 'no response' } });
    expect(overlayOf(c.getSnapshot(), { expectedOutage: false, replaced: false })).toBe('handshake-timeout');
    await Promise.resolve();
    expect(a.call).toHaveBeenCalledWith('deleteTerminal', { params: { sid: 's1', terminalId: 't9' } });
    await c.open();
    FakeConn.last!.emit('ready');
    FakeConn.last!.emit('reconnecting', { reconnect: { attempt: 2, maxAttempts: 5 } });
    expect(c.getSnapshot()).toMatchObject({ phase: 'reconnecting', attempt: 2, maxAttempts: 5 });
    expect(overlayOf(c.getSnapshot(), { expectedOutage: false, replaced: false })).toBe('reconnecting');
    FakeConn.last!.lastInputAt = Date.now() - 25 * 60_000;
    FakeConn.last!.emit('closed', { closed: { reason: 'channel-closed', output: 'idle timeout' } });
    expect(c.getSnapshot()).toMatchObject({ phase: 'closed', reason: 'idle', closedOutput: 'idle timeout' });
    expect(overlayOf(c.getSnapshot(), { expectedOutage: false, replaced: false })).toBe('idle');
  });

  it('OSC 133 tracks busy / exit codes; revoke closes without API calls', async () => {
    const finished = vi.fn();
    const a = api((id) => (id === 'createTerminal' ? { terminalId: 't2', streamUrl: 'wss://ssmmessages.x.amazonaws.com/a', tokenValue: 't' } : null));
    const c = new TerminalController({ api: a as never, sid: 's1', target: 'workstation', client: MOD, onCommandFinished: finished });
    const term = fakeTerm();
    c.attach(term);
    await c.open();
    term.osc.get(133)!('C');
    expect(c.getSnapshot().busy).toBe(true);
    term.osc.get(133)!('D;0');
    expect(c.getSnapshot()).toMatchObject({ busy: false, lastExitCode: 0 });
    expect(finished).toHaveBeenCalledWith(0);
    term.osc.get(7)!('file://ws/home/labuser/cloudalbum');
    expect(c.getSnapshot().cwd).toBe('/home/labuser/cloudalbum');
    a.call.mockClear();
    c.revoke();
    expect(FakeConn.last!.closed).toBe('access-revoked');
    expect(overlayOf(c.getSnapshot(), { expectedOutage: false, replaced: false })).toBe('revoked');
    c.dispose();
    expect(a.call).not.toHaveBeenCalled();
  });

  it('ensureReady opens an idle terminal and resolves once Ready', async () => {
    const a = api((id) => (id === 'createTerminal' ? { terminalId: 't3', streamUrl: 'wss://ssmmessages.x.amazonaws.com/a', tokenValue: 't' } : null));
    const c = new TerminalController({ api: a as never, sid: 's1', target: 'lab', client: MOD });
    const p = c.ensureReady(5000);
    await vi.waitFor(() => expect(FakeConn.last?.state).toBe('connecting'));
    FakeConn.last!.emit('ready');
    await expect(p).resolves.toBe(true);
    expect(overlayOf(c.getSnapshot(), { expectedOutage: false, replaced: true })).toBe('replaced');
  });

  it('waitForPrompt: a fresh tab waits for OSC 133 B / bracketed paste; A alone gets a short grace; the budget runs from Ready', async () => {
    vi.useFakeTimers();
    const a = api((id) => (id === 'createTerminal' ? { terminalId: 't5', streamUrl: 'wss://ssmmessages.x.amazonaws.com/a', tokenValue: 't' } : null));
    const c = new TerminalController({ api: a as never, sid: 's1', target: 'workstation', client: MOD });
    const term = fakeTerm();
    term.modes = { bracketedPasteMode: false };
    c.attach(term);
    await c.open();
    // not Ready yet → false at once
    await expect(c.waitForPrompt()).resolves.toBe(false);
    FakeConn.last!.emit('ready');
    let done: boolean | null = null;
    void c.waitForPrompt().then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBeNull();
    // readline turns bracketed paste on, then the PS1 ends with OSC 133 B
    term.osc.get(133)!('A');
    await vi.advanceTimersByTimeAsync(PROMPT_GRACE_MS - 50);
    expect(done).toBeNull();
    term.modes = { bracketedPasteMode: true };
    term.osc.get(133)!('B');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(c.bracketedPaste).toBe(true);
    // afterwards it resolves at once
    await expect(c.waitForPrompt()).resolves.toBe(true);
  });

  it('waitForPrompt: bracketed paste switched on by the output (no shell integration) counts as the prompt; no signal → false after the budget, then no more waiting', async () => {
    vi.useFakeTimers();
    const a = api((id) => (id === 'createTerminal' ? { terminalId: 't6', streamUrl: 'wss://ssmmessages.x.amazonaws.com/a', tokenValue: 't' } : null));
    const c = new TerminalController({ api: a as never, sid: 's1', target: 'workstation', client: MOD });
    const term = fakeTerm();
    term.modes = { bracketedPasteMode: false };
    c.attach(term);
    await c.open();
    FakeConn.last!.emit('ready');
    let done: boolean | null = null;
    void c.waitForPrompt().then((v) => (done = v));
    term.modes = { bracketedPasteMode: true };
    FakeConn.last!.sink!(new TextEncoder().encode('[?2004h$ '), () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);

    const c2 = new TerminalController({ api: a as never, sid: 's1', target: 'workstation', client: MOD });
    const t2 = fakeTerm();
    t2.modes = { bracketedPasteMode: false };
    c2.attach(t2);
    await c2.open();
    FakeConn.last!.emit('ready');
    let d2: boolean | null = null;
    void c2.waitForPrompt().then((v) => (d2 = v));
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MS + 10);
    expect(d2).toBe(false);
    await expect(c2.waitForPrompt()).resolves.toBe(false);
    // only OSC 133 A (custom PS1 without B): resolves after the grace
    t2.osc.get(133)!('A');
    let d3: boolean | null = null;
    void c2.waitForPrompt().then((v) => (d3 = v));
    await vi.advanceTimersByTimeAsync(PROMPT_GRACE_MS + 10);
    expect(d3).toBe(true);
    // a connection lost while waiting resolves false; a new SSM session (open) forgets the prompt
    await c2.open();
    FakeConn.last!.emit('ready');
    let d4: boolean | null = null;
    void c2.waitForPrompt().then((v) => (d4 = v));
    FakeConn.last!.emit('closed', { closed: { reason: 'channel-closed' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(d4).toBe(false);
  });

  it('connectBy is judged on the server clock: a browser clock 60 s ahead still connects (serverNow from the response or the server clock)', async () => {
    const skewMs = 60_000;
    const serverClock = { now: () => Date.now() - skewMs }; // this browser runs 60 s ahead of the server
    const serverNow = new Date(serverClock.now()).toISOString();
    const connectBy = new Date(serverClock.now() + 30_000).toISOString();
    for (const withServerNow of [true, false]) {
      const a = api((id) =>
        id === 'createTerminal'
          ? { terminalId: 't7', streamUrl: 'wss://ssmmessages.x.amazonaws.com/a', tokenValue: 't', connectBy, ...(withServerNow ? { serverNow } : {}) }
          : id === 'resumeTerminal'
            ? { streamUrl: 'wss://ssmmessages.x.amazonaws.com/b', tokenValue: 't2', connectBy, ...(withServerNow ? { serverNow } : {}) }
            : null,
      );
      const c = new TerminalController({ api: a as never, sid: 's1', target: 'lab', client: MOD, clock: serverClock });
      await c.open();
      const creds = await FakeConn.last!.opts.open();
      expect(creds.connectBy).toBe(connectBy);
      // without the server clock the local clock (60 s ahead) says the token expired 30 s ago
      expect(Date.now()).toBeGreaterThan(Date.parse(connectBy));
      // with serverNow the protocol layer gets ~30 s on the local clock
      const deadline = localConnectDeadline(creds, Date.now())!;
      expect(deadline - Date.now()).toBeGreaterThan(25_000);
      const resumed = await FakeConn.last!.opts.resume!();
      expect(localConnectDeadline(resumed, Date.now())! - Date.now()).toBeGreaterThan(25_000);
    }
    // no clock and no serverNow: absolute connectBy as before
    const a = api(() => ({ terminalId: 't8', streamUrl: 'wss://ssmmessages.x.amazonaws.com/a', tokenValue: 't', connectBy }));
    const c = new TerminalController({ api: a as never, sid: 's1', target: 'lab', client: MOD });
    await c.open();
    const creds = await FakeConn.last!.opts.open();
    expect(creds.serverNow).toBeNull();
  });
});
