/**
 * In-memory WebSocket pair for deterministic tests (works with fake timers: delivery uses microtasks).
 * The client end implements `WebSocketLike` (browser semantics: CONNECTING → OPEN on the next microtask; `send` while
 * CONNECTING throws; after close, sends are dropped); the server end implements `ServerSocket`.
 */
import { WS_CLOSED, WS_CLOSING, WS_CONNECTING, WS_OPEN, type WebSocketFactory, type WebSocketLike } from '../socket.js';
import type { ServerSocket } from './serverSocket.js';

export interface MemorySocketPair {
  client: MemoryClientSocket;
  server: ServerSocket;
  /** Simulates a network failure: both ends close, the client sees code 1006 (not clean). */
  drop(): void;
}

function copyBytes(data: string | ArrayBufferLike | ArrayBufferView): Uint8Array | string {
  if (typeof data === 'string') return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return new Uint8Array((data as ArrayBuffer).slice(0));
}

export class MemoryClientSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState: number = WS_CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  /** Frames sent by the client (for assertions). */
  readonly sent: (Uint8Array | string)[] = [];
  private toServer: ((data: Uint8Array | string) => void) | null = null;
  private serverClosed: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  /** @internal wiring */
  connect(toServer: (data: Uint8Array | string) => void, serverClosed: () => void): void {
    this.toServer = toServer;
    this.serverClosed = serverClosed;
    queueMicrotask(() => {
      if (this.readyState !== WS_CONNECTING) return;
      this.readyState = WS_OPEN;
      this.onopen?.({});
    });
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState === WS_CONNECTING) throw new Error('InvalidStateError: still in CONNECTING state');
    if (this.readyState !== WS_OPEN) return;
    const copy = copyBytes(data);
    this.sent.push(copy);
    const to = this.toServer;
    queueMicrotask(() => to?.(copy));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === WS_CLOSING || this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSING;
    queueMicrotask(() => this.finish(code, reason, true));
  }

  /** @internal */
  deliver(data: Uint8Array | string): void {
    if (this.readyState !== WS_OPEN) return;
    const payload = typeof data === 'string' ? data : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    this.onmessage?.({ data: payload });
  }

  /** @internal */
  finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.serverClosed?.();
    this.serverClosed = null;
    this.onclose?.({ code, reason, wasClean });
  }
}

export function createMemorySocketPair(url = 'ws://memory/v1/data-channel/x'): MemorySocketPair {
  const client = new MemoryClientSocket(url);
  const messageHandlers: ((data: Uint8Array | string) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let open = true;
  const serverClosed = (): void => {
    if (!open) return;
    open = false;
    for (const h of closeHandlers) h();
  };
  const server: ServerSocket = {
    get isOpen() {
      return open && client.readyState === WS_OPEN;
    },
    send(data) {
      if (!open) return;
      const copy = typeof data === 'string' ? data : data.slice();
      queueMicrotask(() => client.deliver(copy));
    },
    close(code = 1000, reason = '') {
      if (!open) return;
      queueMicrotask(() => client.finish(code, reason, true));
    },
    abort() {
      if (!open) return;
      queueMicrotask(() => client.finish(1006, '', false));
    },
    onMessage(cb) {
      messageHandlers.push(cb);
    },
    onClose(cb) {
      closeHandlers.push(cb);
    },
  };
  client.connect((data) => {
    if (open) for (const h of messageHandlers) h(data);
  }, serverClosed);
  return {
    client,
    server,
    drop() {
      queueMicrotask(() => client.finish(1006, '', false));
    },
  };
}

/** A WebSocketFactory whose sockets are attached to `accept` (e.g. `MockSsmService.attach`). */
export function memoryWebSocketFactory(accept: (server: ServerSocket, url: string, pair: MemorySocketPair) => void): WebSocketFactory & { pairs: MemorySocketPair[] } {
  const pairs: MemorySocketPair[] = [];
  const create: WebSocketFactory = (url) => {
    const pair = createMemorySocketPair(url);
    pairs.push(pair);
    accept(pair.server, url, pair);
    return pair.client;
  };
  return Object.assign(create, { pairs });
}
