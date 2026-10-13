/**
 * Dev HTTP server for ATL_DEV_MODE=1 (`npm run platform:dev`): serves `/api/v1/*` from the in-process functions, like
 * CloudFront + HTTP API would.
 *
 *   Browser routes:  Authorization: Bearer dev.learner.<sub>   (dev tokens, see dev/adapters/auth.ts)
 *   Agent routes:    X-ATL-Dev-Caller: arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-<sid>-ws
 *   Internal routes: X-ATL-Dev-Caller: arn:aws:sts::000000000000:assumed-role/ATLProvisionerRole/atl-<sid>-prov-<op>
 *
 * Dev control endpoints (never in production):
 *   GET  /__dev/state                     clock, executions, schedules, runner builds, published events (tail)
 *   POST /__dev/trail/events              inject fake CloudTrail events (JSON array of TrailEvent)
 *   POST /__dev/faults                    inject a Step Functions fault { state, error, cause?, times?, stateMachine? }
 *   POST /__dev/clock/skip                { minutes } — jump the scaled clock forward
 *   POST /__dev/invoke/<function>         invoke a function with the JSON body (e.g. atl-timer { kind: 'SWEEP' })
 */
import http from 'node:http';
import { LAMBDA_FUNCTIONS, matchRoute, type LambdaFunctionName, type TrailEvent } from '@atl/shared';
import type { HttpEvent, HttpResult } from '../http/types.js';
import { ScaledClock } from './adapters/clock.js';
import { loadDevConfig } from './config.js';
import { createDevRuntime, type DevRuntime } from './runtime.js';

function fnForPath(method: string, path: string): LambdaFunctionName {
  const m = matchRoute(method, path);
  if (m) return m.route.fn;
  if (path.startsWith('/api/v1/agent/') || path.startsWith('/api/v1/internal/') || path.startsWith('/api/v1/agent-fallback/')) return 'atl-agent';
  if (path.startsWith('/api/v1/public/')) return 'atl-public';
  return 'atl-api';
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: http.ServerResponse, r: HttpResult): void {
  res.writeHead(r.statusCode, r.headers ?? {});
  res.end(r.body ?? '');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  send(res, { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, null, 2) });
}

export async function handleDevRequest(rt: DevRuntime, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();
  const body = await readBody(req);

  if (url.pathname.startsWith('/__dev/')) {
    if (method === 'GET' && url.pathname === '/__dev/state') {
      return sendJson(res, 200, {
        now: rt.clock.now().toISOString(),
        timeScale: rt.cfg.timeScale,
        runnerMode: rt.cfg.runnerMode,
        executions: rt.orchestrator.sim.listExecutions(),
        schedules: rt.scheduler.list(),
        fired: rt.scheduler.fired.slice(-50),
        builds: rt.runner.list(),
        environments: rt.envs.list(),
        events: rt.events.published.slice(-50),
        asyncErrors: rt.invoker.asyncErrors.slice(-20),
      });
    }
    if (method === 'POST' && url.pathname === '/__dev/trail/events') {
      const list = JSON.parse(body || '[]') as TrailEvent[];
      rt.trail.inject(...list);
      return sendJson(res, 200, { injected: list.length });
    }
    if (method === 'POST' && url.pathname === '/__dev/faults') {
      rt.orchestrator.sim.injectFault(JSON.parse(body));
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/__dev/clock/skip') {
      if (!(rt.clock instanceof ScaledClock)) return sendJson(res, 409, { error: 'clock is not a ScaledClock' });
      rt.clock.skip(Number((JSON.parse(body || '{}') as { minutes?: number }).minutes ?? 0) * 60_000);
      return sendJson(res, 200, { now: rt.clock.now().toISOString() });
    }
    const inv = /^\/__dev\/invoke\/([a-z-]+)$/.exec(url.pathname);
    if (method === 'POST' && inv && (LAMBDA_FUNCTIONS as readonly string[]).includes(inv[1]!)) {
      try {
        return sendJson(res, 200, { result: await rt.invoker.invoke(inv[1] as LambdaFunctionName, JSON.parse(body || 'null')) });
      } catch (e) {
        return sendJson(res, 500, { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      }
    }
    return sendJson(res, 404, { error: 'unknown dev endpoint' });
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const caller = headers['x-atl-dev-caller'];
  const event: HttpEvent = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    ...(body ? { body } : {}),
    isBase64Encoded: false,
    requestContext: {
      requestId: globalThis.crypto.randomUUID(),
      http: { method, path: url.pathname, sourceIp: req.socket.remoteAddress ?? '127.0.0.1', userAgent: headers['user-agent'] ?? '' },
      ...(caller ? { authorizer: { iam: { userArn: caller, accountId: rt.env.accountId } } } : {}),
    },
  };
  const result = (await rt.invoker.invoke(fnForPath(method, url.pathname), event)) as HttpResult;
  send(res, result);
}

async function main(): Promise<void> {
  if (process.argv.includes('--dev-mode')) process.env.ATL_DEV_MODE = '1'; // npm run platform:dev (Windows-friendly)
  if (process.env.ATL_DEV_MODE !== '1') {
    console.error('set ATL_DEV_MODE=1 to start the ATL dev server');
    process.exit(2);
  }
  const cfg = loadDevConfig();
  const rt = await createDevRuntime(cfg);
  const server = http.createServer((req, res) => {
    handleDevRequest(rt, req, res).catch((e: unknown) => sendJson(res, 500, { error: String(e) }));
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`ATL dev server on http://127.0.0.1:${cfg.port}  (DynamoDB ${cfg.ddbEndpoint}, time x${cfg.timeScale}, runner ${cfg.runnerMode})`);
  });
  const stop = async () => {
    server.close();
    await rt.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
