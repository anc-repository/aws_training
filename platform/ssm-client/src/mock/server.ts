/**
 * Local mock server (Node, `ws`): one HTTP port that serves
 * - the data channel `GET /v1/data-channel/{SessionId}?role=publish_subscribe` (WebSocket upgrade), and
 * - a JSON control API named after the SSM actions, for the API dev-server's workspace provider or scripts:
 *   `POST /StartSession {Target?, DocumentName?, Reason?, sessionName?, role?}` → `{SessionId, StreamUrl, TokenValue}`,
 *   `POST /ResumeSession {SessionId}`, `POST /TerminateSession {SessionId}`, `POST /DropConnection {SessionId}` (test aid),
 *   `GET /sessions`, `GET /health`.
 * It listens on 127.0.0.1 by default and never talks to AWS. StreamUrls are `ws://127.0.0.1:<port>/…`, accepted by
 * the client only with `streamUrlPolicy.allowLoopback` (dev mode).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import { MockSsmError, MockSsmService, type MockSsmServiceOptions, type StartSessionInput } from './service.js';
import type { ServerSocket } from './serverSocket.js';

/** The part of the `ws` package used here (typed locally: @types/ws is not installed). */
interface WsSocket {
  readonly readyState: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', cb: (data: Uint8Array | ArrayBuffer | Uint8Array[], isBinary: boolean) => void): void;
  on(event: 'close' | 'error', cb: () => void): void;
}
interface WsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WsSocket) => void): void;
  close(cb?: () => void): void;
  readonly clients: Set<WsSocket>;
}
interface WsModule {
  WebSocketServer: new (opts: { noServer: true; maxPayload?: number }) => WsServer;
}

const requireCjs = createRequire(import.meta.url);

function loadWs(): WsModule {
  return requireCjs('ws') as WsModule;
}

function wsBytes(data: Uint8Array | ArrayBuffer | Uint8Array[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function adapt(ws: WsSocket): ServerSocket {
  return {
    get isOpen() {
      return ws.readyState === 1;
    },
    send(data) {
      if (ws.readyState === 1) ws.send(data);
    },
    close(code = 1000, reason = '') {
      if (ws.readyState <= 1) ws.close(code, reason);
    },
    abort() {
      ws.terminate();
    },
    onMessage(cb) {
      ws.on('message', (data, isBinary) => cb(isBinary ? wsBytes(data) : Buffer.from(wsBytes(data)).toString('utf8')));
    },
    onClose(cb) {
      ws.on('close', cb);
    },
  };
}

export interface MockSsmServerOptions extends MockSsmServiceOptions {
  host?: string;
  /** 0 = any free port. */
  port?: number;
}

export interface MockSsmServer {
  readonly service: MockSsmService;
  readonly port: number;
  /** `http://127.0.0.1:<port>` — the control API. */
  readonly httpOrigin: string;
  /** `ws://127.0.0.1:<port>` — base of the StreamUrls. */
  readonly wsOrigin: string;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    const b = c as Buffer;
    n += b.length;
    if (n > MAX_BODY) throw new MockSsmError('ValidationException', 'request body too large');
    chunks.push(b);
  }
  if (n === 0) return {};
  const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new MockSsmError('ValidationException', 'body must be a JSON object');
  return v as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export async function startMockSsmServer(opts: MockSsmServerOptions = {}): Promise<MockSsmServer> {
  const host = opts.host ?? '127.0.0.1';
  const service = new MockSsmService(opts);
  const { WebSocketServer } = loadWs();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://mock');
        const route = `${req.method ?? 'GET'} ${url.pathname}`;
        switch (route) {
          case 'GET /health':
            return send(res, 200, { ok: true, sessions: service.listSessions().length });
          case 'GET /sessions':
            return send(res, 200, { sessions: service.listSessions() });
          case 'POST /StartSession': {
            const b = await readJson(req);
            const role = b.role === 'workstation' ? 'workstation' : b.role === 'lab' ? 'lab' : undefined;
            const input: StartSessionInput = { Target: str(b.Target), DocumentName: str(b.DocumentName), Reason: str(b.Reason), sessionName: str(b.sessionName), role };
            return send(res, 200, service.startSession(input));
          }
          case 'POST /ResumeSession': {
            const b = await readJson(req);
            return send(res, 200, service.resumeSession(str(b.SessionId) ?? ''));
          }
          case 'POST /TerminateSession': {
            const b = await readJson(req);
            return send(res, 200, service.terminateSession(str(b.SessionId) ?? ''));
          }
          case 'POST /DropConnection': {
            const b = await readJson(req);
            service.dropConnection(str(b.SessionId) ?? '');
            return send(res, 200, {});
          }
          default:
            return send(res, 404, { __type: 'NotFound', message: `${route} is not a mock route` });
        }
      } catch (err) {
        if (err instanceof MockSsmError) return send(res, 400, { __type: err.type, message: err.message });
        if (err instanceof SyntaxError) return send(res, 400, { __type: 'ValidationException', message: 'invalid JSON' });
        return send(res, 500, { __type: 'InternalServerError', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://mock').pathname;
    if (!/^\/v1\/data-channel\/[^/]+$/.test(path)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => service.attachByUrl(adapt(ws), path));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const httpOrigin = `http://${urlHost}:${port}`;
  const wsOrigin = `ws://${urlHost}:${port}`;
  service.setStreamOrigin(wsOrigin);

  return {
    service,
    port,
    httpOrigin,
    wsOrigin,
    close: async () => {
      service.close();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
