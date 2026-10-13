import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SsmTerminalConnection,
  attachXterm,
  getTabClientId,
  observeContainerResize,
  pasteText,
  type DisposableLike,
  type OutputSink,
  type StateChange,
  type TerminalConnectionLike,
  type XtermLike,
} from '../src/index.js';
import { MockSsmService, memoryWebSocketFactory } from '../src/mock/index.js';
import { plain } from './helpers.js';

// Compile-time check (tsconfig.test.json): @xterm/xterm 6's Terminal satisfies the adapter's structural type.
export const terminalIsXtermLike = (t: Terminal): XtermLike => t;

class Emitter<T> {
  private fns = new Set<(v: T) => void>();
  on = (fn: (v: T) => void): DisposableLike => {
    this.fns.add(fn);
    return { dispose: () => this.fns.delete(fn) };
  };
  fire(v: T): void {
    for (const fn of this.fns) fn(v);
  }
  get size(): number {
    return this.fns.size;
  }
}

class FakeTerminal implements XtermLike {
  cols = 80;
  rows = 24;
  options: { disableStdin?: boolean } = {};
  readonly data = new Emitter<string>();
  readonly binary = new Emitter<string>();
  readonly resized = new Emitter<{ cols: number; rows: number }>();
  readonly writes: { data: string | Uint8Array; cb?: () => void }[] = [];
  readonly pasted: string[] = [];
  onData = this.data.on;
  onBinary = this.binary.on;
  onResize = this.resized.on;
  write(data: string | Uint8Array, callback?: () => void): void {
    this.writes.push({ data, cb: callback });
  }
  paste(text: string): void {
    this.pasted.push(text);
    this.data.fire(text.replace(/\r?\n/g, '\r'));
  }
  text(): string {
    const dec = new TextDecoder();
    return this.writes.map((w) => (typeof w.data === 'string' ? w.data : dec.decode(w.data, { stream: true }))).join('');
  }
  flush(): void {
    for (const w of this.writes) {
      const cb = w.cb;
      w.cb = undefined;
      cb?.();
    }
  }
  doResize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resized.fire({ cols, rows });
  }
}

function fakeConnection() {
  let sink: OutputSink | null = null;
  const stateFns = new Set<(e: StateChange) => void>();
  const conn = {
    state: 'idle' as const,
    sendInput: vi.fn((_d: string | Uint8Array) => true),
    resize: vi.fn((_c: number, _r: number) => {}),
    setOutputSink: vi.fn((s: OutputSink | null) => {
      sink = s;
    }),
    on: vi.fn((type: string, fn: (e: StateChange) => void) => {
      if (type === 'state') stateFns.add(fn);
      return () => stateFns.delete(fn);
    }),
  };
  return {
    conn: conn as unknown as TerminalConnectionLike,
    raw: conn,
    emitOutput: (bytes: Uint8Array, done: () => void) => sink?.(bytes, done),
    emitState: (state: StateChange['state']) => stateFns.forEach((fn) => fn({ state, previous: 'ready' })),
    get sink() {
      return sink;
    },
    stateListeners: () => stateFns.size,
  };
}

describe('attachXterm', () => {
  it('wires input, binary input, size and output with the write callback as acknowledge', () => {
    const term = new FakeTerminal();
    const f = fakeConnection();
    const binding = attachXterm(term, f.conn);
    expect(f.raw.resize).toHaveBeenCalledWith(80, 24);

    term.data.fire('ls\r');
    expect(f.raw.sendInput).toHaveBeenLastCalledWith('ls\r');
    term.binary.fire('\x1b[M !!');
    expect(f.raw.sendInput.mock.calls.at(-1)![0]).toEqual(new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0x21, 0x21]));

    const done = vi.fn();
    f.emitOutput(new TextEncoder().encode('中'), done);
    expect(done).not.toHaveBeenCalled(); // acknowledged only once xterm has parsed it
    term.flush();
    expect(done).toHaveBeenCalledTimes(1);

    term.doResize(120, 40);
    expect(f.raw.resize).toHaveBeenLastCalledWith(120, 40);
    term.cols = 100;
    binding.syncSize();
    expect(f.raw.resize).toHaveBeenLastCalledWith(100, 40);

    binding.dispose();
    binding.dispose();
    expect(term.data.size + term.binary.size + term.resized.size).toBe(0);
    expect(f.raw.setOutputSink).toHaveBeenLastCalledWith(null);
    expect(f.stateListeners()).toBe(0);
  });

  it('makes the terminal read-only when the connection fails or closes', () => {
    const term = new FakeTerminal();
    const f = fakeConnection();
    attachXterm(term, f.conn);
    f.emitState('reconnecting');
    expect(term.options.disableStdin).toBeUndefined();
    f.emitState('closed');
    expect(term.options.disableStdin).toBe(true);

    const t2 = new FakeTerminal();
    const f2 = fakeConnection();
    attachXterm(t2, f2.conn, { readOnlyWhenEnded: false });
    f2.emitState('failed');
    expect(t2.options.disableStdin).toBeUndefined();
  });

  it('pasteText goes through term.paste()', () => {
    const term = new FakeTerminal();
    const f = fakeConnection();
    attachXterm(term, f.conn);
    pasteText(term, 'echo a\necho b');
    expect(term.pasted).toEqual(['echo a\necho b']);
    expect(f.raw.sendInput).toHaveBeenLastCalledWith('echo a\recho b');
  });
});

describe('xterm adapter + connection + local mock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a command typed into the terminal and acknowledges output after xterm parsed it', async () => {
    const svc = new MockSsmService({ idleTimeoutMs: 0 });
    const factory = memoryWebSocketFactory((server, url) => svc.attachByUrl(server, url));
    let sid = '';
    const conn = new SsmTerminalConnection({
      open: async () => {
        const s = svc.startSession({ role: 'workstation' });
        sid = s.SessionId;
        return { streamUrl: s.StreamUrl, tokenValue: s.TokenValue };
      },
      clientId: 'c',
      webSocketFactory: factory,
      streamUrlPolicy: { allowLoopback: true },
    });
    const term = new FakeTerminal();
    term.cols = 101;
    term.rows = 33;
    attachXterm(term, conn);
    await conn.start();
    const step = async (): Promise<void> => {
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(1);
        term.flush();
      }
    };
    await step();
    for (const ch of 'stty size\r') term.data.fire(ch);
    await step();
    expect(plain(term.text())).toContain('工作台  labuser@atl-workstation:~$ stty size\r\n33 101\r\n');
    expect(svc.getSession(sid)!.unacknowledgedOutput).toBe(0);
  });
});

describe('observeContainerResize', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces ResizeObserver callbacks by 150 ms and pauses while a splitter is dragged', () => {
    let trigger: () => void = () => {};
    const observed: unknown[] = [];
    const disconnect = vi.fn();
    class FakeRO {
      constructor(cb: () => void) {
        trigger = cb;
      }
      observe(el: unknown) {
        observed.push(el);
      }
      disconnect = disconnect;
    }
    const fit = { fit: vi.fn() };
    const el = {} as Element;
    const h = observeContainerResize(el, fit, { ResizeObserver: FakeRO });
    expect(observed).toEqual([el]);
    trigger();
    vi.advanceTimersByTime(100);
    trigger();
    vi.advanceTimersByTime(149);
    expect(fit.fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fit.fit).toHaveBeenCalledTimes(1);

    h.pause();
    trigger();
    vi.advanceTimersByTime(500);
    expect(fit.fit).toHaveBeenCalledTimes(1);
    h.resume();
    expect(fit.fit).toHaveBeenCalledTimes(2);
    h.dispose();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('getTabClientId', () => {
  it('keeps one UUID per tab in the given storage and survives blocked storage', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    const a = getTabClientId(storage);
    expect(getTabClientId(storage)).toBe(a);
    expect(map.get('atl.terminal.clientId')).toBe(a);
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(getTabClientId(blocked)).toMatch(/^[0-9a-f-]{36}$/);
    expect(getTabClientId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
