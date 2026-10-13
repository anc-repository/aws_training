import { afterEach, describe, expect, it, vi } from 'vitest';
import { SsmTerminalConnection, type StateChange } from '../src/index.js';
import { FakeShell, splitArgs, startMockSsmServer, type MockSsmServer } from '../src/mock/index.js';
import { plain } from './helpers.js';

describe('FakeShell', () => {
  function shell(opts: ConstructorParameters<typeof FakeShell>[1] = {}) {
    let out = '';
    const exits: number[] = [];
    const sh = new FakeShell({ write: (d) => { out += typeof d === 'string' ? d : new TextDecoder().decode(d); }, exit: (c) => exits.push(c) }, opts);
    const type = (s: string): void => sh.input(new TextEncoder().encode(s));
    return { sh, type, exits, get out() { return out; }, clear: () => { out = ''; } };
  }

  it('prints the host-role prompt with the OSC 133 / OSC 7 markers of 03 §3.7.5', () => {
    const s = shell({ role: 'workstation' });
    s.sh.start();
    expect(s.out).toContain('\x1b]7;file://atl-workstation/home/labuser\x07\x1b]133;A\x07\x1b[30;46m 工作台 \x1b[0m labuser@atl-workstation:~$ \x1b]133;B\x07');
    s.clear();
    s.type('false\r');
    expect(s.out).toContain('\x1b]133;C\x07');
    expect(s.out).toContain('\x1b]133;D;1\x07');
  });

  it('echoes, edits the line, interrupts, reports sizes and unknown commands', () => {
    const s = shell({ shellIntegration: false, cols: 100, rows: 30 });
    s.sh.start();
    s.clear();
    s.type('ecxo\x7f\x7fho 中\x7f文\r');
    expect(plain(s.out)).toContain('ecxo\b \b\b \bho 中\b\b  \b\b文\r\n文\r\n');
    s.clear();
    s.sh.resize(132, 43);
    s.type('stty size\r');
    expect(s.out).toContain('43 132\r\n');
    s.clear();
    s.type('aws s3 ls\r');
    expect(s.out).toContain('bash: aws: command not found');
    s.clear();
    s.type('half typed\x03');
    expect(s.out).toContain('^C\r\n');
    s.clear();
    s.type('\x1b[A\x1b[200~echo pasted\x1b[201~\r');
    expect(s.out).toContain('echo pasted\r\npasted\r\n');
    s.clear();
    s.type('printf "%s-%s\\n" a b\r');
    expect(s.out).toContain('a-b\r\n');
  });

  it('runs seq, cd/pwd, sleep (interruptible) and exit', () => {
    vi.useFakeTimers();
    try {
      const s = shell({ shellIntegration: false });
      s.sh.start();
      s.clear();
      s.type('seq 3\r');
      expect(s.out).toContain('1\r\n2\r\n3\r\n');
      s.type('cd /tmp\rpwd\r');
      expect(s.out).toContain('/tmp\r\n');
      s.clear();
      s.type('sleep 5\r');
      s.type('ignored\r');
      expect(s.out).not.toContain('$ ');
      vi.advanceTimersByTime(5000);
      expect(s.out).toContain('$ ');
      s.type('sleep 30\r\x03');
      expect(s.out).toContain('^C');
      s.type('exit 3\r');
      expect(s.exits).toEqual([3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('splits arguments with quotes', () => {
    expect(splitArgs(`echo 'a b' "c d" e ''`)).toEqual(['echo', 'a b', 'c d', 'e', '']);
  });
});

describe('mock server over real WebSockets (ws + Node 22 WebSocket)', () => {
  let server: MockSsmServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function post<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(`${server!.httpOrigin}${path}`, { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as T };
  }

  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function terminal(opts: { resume?: boolean } = {}) {
    let sessionId = '';
    let text = '';
    const dec = new TextDecoder();
    const states: StateChange[] = [];
    const conn = new SsmTerminalConnection({
      open: async () => {
        const r = await post<{ SessionId: string; StreamUrl: string; TokenValue: string }>('/StartSession', { sessionName: 'atl-s1-term', Target: 'i-0abc' });
        sessionId = r.json.SessionId;
        return { streamUrl: r.json.StreamUrl, tokenValue: r.json.TokenValue };
      },
      resume: opts.resume === false ? undefined : async () => {
        const r = await post<{ StreamUrl: string; TokenValue: string; __type?: string }>('/ResumeSession', { SessionId: sessionId });
        if (r.status !== 200) throw Object.assign(new Error(r.json.__type), { status: 409, code: 'TERMINAL_GONE' });
        return { streamUrl: r.json.StreamUrl, tokenValue: r.json.TokenValue };
      },
      clientId: crypto.randomUUID(),
      streamUrlPolicy: { allowLoopback: true },
      onOutput: (d, done) => {
        text += dec.decode(d, { stream: true });
        done();
      },
    });
    conn.on('state', (s) => states.push(s));
    return { conn, states, get text() { return plain(text); }, get sessionId() { return sessionId; } };
  }

  it('serves health, sessions and 404 on the control API', async () => {
    server = await startMockSsmServer();
    expect(await (await fetch(`${server.httpOrigin}/health`)).json()).toEqual({ ok: true, sessions: 0 });
    expect((await fetch(`${server.httpOrigin}/nope`)).status).toBe(404);
    const r = await post<{ SessionId: string; StreamUrl: string }>('/StartSession', { sessionName: 'atl-s9-term' });
    expect(r.json.SessionId).toMatch(/^atl-s9-term-[0-9a-f]{17}$/);
    expect(r.json.StreamUrl).toBe(`${server.wsOrigin}/v1/data-channel/${r.json.SessionId}?role=publish_subscribe`);
    expect((await post('/ResumeSession', { SessionId: 'nope' })).status).toBe(400);
    expect((await fetch(`${server.httpOrigin}/StartSession`, { method: 'POST', body: '{' })).status).toBe(400);
  });

  it('runs a shell session end to end: handshake, size, Chinese output, exit → channel_closed', async () => {
    server = await startMockSsmServer();
    const t = terminal();
    t.conn.resize(120, 40);
    await t.conn.start();
    await until(() => t.conn.state === 'ready' && t.text.includes('$ '));
    t.conn.sendInput('stty size\r');
    t.conn.sendInput("printf '中文测试\\n'\r");
    await until(() => t.text.includes('中文测试\r\n'));
    expect(t.text).toContain('40 120\r\n');
    t.conn.sendInput('exit\r');
    await until(() => t.conn.state === 'closed');
    expect(t.states.at(-1)!.closed).toEqual({ reason: 'channel-closed', output: '' });
    const info = server.service.getSession(t.sessionId)!;
    expect(info).toMatchObject({ status: 'Terminated', handshake: 'complete', clientVersion: '1.2.896.0', size: { cols: 120, rows: 40 } });
  });

  it('survives a dropped connection: resume over HTTP, no lost or repeated lines', async () => {
    server = await startMockSsmServer({ outputChunkSize: 64, faults: { dropOutput: (seq, attempt) => attempt === 0 && seq >= 6 && seq < 60 } });
    const t = terminal();
    await t.conn.start();
    await until(() => t.conn.state === 'ready' && t.text.includes('$ '));
    t.conn.sendInput('seq 1 2000\r');
    await new Promise((r) => setTimeout(r, 30));
    await post('/DropConnection', { SessionId: t.sessionId });
    await until(() => t.states.some((s) => s.state === 'reconnecting'));
    await until(() => /\r\n2000\r\n/.test(t.text), 15_000);
    await until(() => server!.service.getSession(t.sessionId)!.unacknowledgedOutput === 0);
    const lines = t.text.split('\r\n').filter((l) => /^\d+$/.test(l)).map(Number);
    expect(lines).toEqual(Array.from({ length: 2000 }, (_, i) => i + 1));
    expect(t.states.filter((s) => s.state === 'ready').map((s) => s.resumed)).toEqual([false, true]);
    expect(server.service.getSession(t.sessionId)!.connections).toBe(2);
  }, 30_000);

  it('rejects a reused token and TerminateSession closes the client', async () => {
    server = await startMockSsmServer();
    const r = await post<{ SessionId: string; StreamUrl: string; TokenValue: string }>('/StartSession', {});
    // the first client uses the token
    const c1 = new SsmTerminalConnection({ open: async () => ({ streamUrl: r.json.StreamUrl, tokenValue: r.json.TokenValue }), clientId: 'a', streamUrlPolicy: { allowLoopback: true } });
    await c1.start();
    await until(() => c1.state === 'ready');
    // a second client with the same (now used) token is refused
    const states: StateChange[] = [];
    const c2 = new SsmTerminalConnection({ open: async () => ({ streamUrl: r.json.StreamUrl, tokenValue: r.json.TokenValue }), clientId: 'b', streamUrlPolicy: { allowLoopback: true } });
    c2.on('state', (s) => states.push(s));
    await c2.start();
    await until(() => c2.state === 'failed');
    expect(states.at(-1)!.failure).toMatchObject({ reason: 'connect-failed', closeCode: 1008 });
    await post('/TerminateSession', { SessionId: r.json.SessionId });
    await until(() => c1.state === 'closed');
  });
});
