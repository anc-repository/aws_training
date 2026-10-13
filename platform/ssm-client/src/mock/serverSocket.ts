/** Server side of one data-channel WebSocket, as seen by the mock agent (implemented over `ws` and in memory). */
export interface ServerSocket {
  readonly isOpen: boolean;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  /** Abrupt loss without a close handshake (the client sees 1006). */
  abort(): void;
  onMessage(cb: (data: Uint8Array | string) => void): void;
  onClose(cb: () => void): void;
}
