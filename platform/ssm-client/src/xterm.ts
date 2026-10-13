/**
 * xterm.js adapter (03 §3.5.6, §3.5.7, §3.7). Structural types only — this module does not import @xterm/xterm, so
 * the web app keeps loading xterm lazily (platform/web `features/workspace/terminal/xterm.ts`) and passes the instance
 * in. `XtermLike` is checked against `@xterm/xterm` 6's `Terminal` in test/xterm.test.ts.
 *
 * - Input: `onData` (UTF-8 text; Enter is already "\r") and `onBinary` (one char per byte) → `sendInput`.
 * - Output: raw bytes → `term.write(Uint8Array, callback)`; xterm decodes UTF-8 across chunk boundaries. The acknowledge
 *   is sent from the write callback, so a fast producer (e.g. `cat` of a large file) is slowed by the agent's
 *   retransmission window (back-pressure, 03 §3.5.7).
 * - Size: `onResize` (fired by the Fit add-on) → `resize`; the connection sends Size only on change.
 * - Paste: `pasteText` uses `term.paste()` (bracketed paste and newline conversion are xterm's).
 * - Container resizes: `observeContainerResize` (ResizeObserver, 150 ms debounce, paused while a splitter is dragged).
 */
import { binaryStringToBytes } from './bytes.js';
import { RESIZE_DEBOUNCE_MS } from './constants.js';
import type { SsmTerminalConnection, StateChange } from './connection.js';

export interface DisposableLike {
  dispose(): void;
}

/** The part of xterm.js `Terminal` used here. */
export interface XtermLike {
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): DisposableLike;
  onBinary(listener: (data: string) => void): DisposableLike;
  onResize(listener: (size: { cols: number; rows: number }) => void): DisposableLike;
  write(data: string | Uint8Array, callback?: () => void): void;
  paste(data: string): void;
  options: { disableStdin?: boolean };
}

/** The part of SsmTerminalConnection used here (lets tests and other transports plug in). */
export type TerminalConnectionLike = Pick<SsmTerminalConnection, 'setOutputSink' | 'sendInput' | 'resize' | 'on' | 'state'>;

export interface AttachXtermOptions {
  /** Set `disableStdin` while the terminal is not usable (failed / closed); default true. */
  readOnlyWhenEnded?: boolean;
}

export interface XtermBinding extends DisposableLike {
  /** Pushes the terminal's current cols × rows to the connection (e.g. after `fit.fit()` without a size change event). */
  syncSize(): void;
}

export function attachXterm(term: XtermLike, conn: TerminalConnectionLike, opts: AttachXtermOptions = {}): XtermBinding {
  const readOnlyWhenEnded = opts.readOnlyWhenEnded ?? true;
  let disposed = false;
  conn.setOutputSink((data, done) => {
    if (disposed) {
      done();
      return;
    }
    term.write(data, done);
  });
  const subs: DisposableLike[] = [
    term.onData((data) => {
      conn.sendInput(data);
    }),
    term.onBinary((data) => {
      conn.sendInput(binaryStringToBytes(data));
    }),
    term.onResize(({ cols, rows }) => conn.resize(cols, rows)),
  ];
  const offState = conn.on('state', (e: StateChange) => {
    if (!readOnlyWhenEnded) return;
    if (e.state === 'failed' || e.state === 'closed') term.options.disableStdin = true;
  });
  conn.resize(term.cols, term.rows);
  return {
    syncSize: () => conn.resize(term.cols, term.rows),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offState();
      for (const s of subs) s.dispose();
      conn.setOutputSink(null);
    },
  };
}

/** Pastes through xterm.js so bracketed paste mode and "\n" → "\r" are applied (03 §3.7.3, §7.1). */
export function pasteText(term: Pick<XtermLike, 'paste'>, text: string): void {
  term.paste(text);
}

export interface FitLike {
  fit(): void;
}

interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}
type ResizeObserverCtor = new (cb: () => void) => ResizeObserverLike;

export interface ContainerResizeHandle extends DisposableLike {
  /** Stop fitting while a splitter is dragged (03 §3.5.6: “分隔条拖动中不发送”). */
  pause(): void;
  /** Resume and fit once. */
  resume(): void;
}

export function observeContainerResize(
  container: Element,
  fit: FitLike,
  opts: { debounceMs?: number; ResizeObserver?: ResizeObserverCtor } = {},
): ContainerResizeHandle {
  const debounceMs = opts.debounceMs ?? RESIZE_DEBOUNCE_MS;
  const Ctor = opts.ResizeObserver ?? (globalThis as { ResizeObserver?: ResizeObserverCtor }).ResizeObserver;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (): void => {
    timer = null;
    if (!paused) fit.fit();
  };
  const schedule = (): void => {
    if (paused) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };
  const ro = Ctor ? new Ctor(schedule) : null;
  ro?.observe(container);
  return {
    pause: () => {
      paused = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    resume: () => {
      paused = false;
      fit.fit();
    },
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ro?.disconnect();
    },
  };
}
