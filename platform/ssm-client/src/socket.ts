/**
 * The subset of the WebSocket API the connection uses. The browser's `WebSocket`, Node ≥ 22's global `WebSocket`
 * (undici) and the `ws` package all satisfy it, so the same client drives the browser terminal, the 07 V2-2 Node PoC
 * and the tests (in-memory pair, src/mock/memorySocket.ts).
 *
 * The browser API cannot set request headers (so no SigV4 header signing of the handshake, 03 §3.5.11) and cannot send
 * ping frames (03 §3.5.8).
 */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export const defaultWebSocketFactory: WebSocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!Ctor) throw new Error('ssm-client: no WebSocket implementation (pass webSocketFactory)');
  return new Ctor(url) as WebSocketLike;
};
