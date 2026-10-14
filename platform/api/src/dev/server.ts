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
 *   POST /__dev/clock/scale               { scale } — change the clock speed from now on (platform s per wall s)
 *   POST /__dev/invoke/<function>         invoke a function with the JSON body (e.g. atl-timer { kind: 'SWEEP' })
 *   POST /__dev/fixtures/completions      { sub, trackId? | labIds? } — completion records + verified badges (dev fixture,
 *                                         marked `fixture: dev`) so that a learning path becomes certificate-eligible
 *   POST /__dev/reclaim/protected-resource { sessionId } — the learner “created” an RDS instance with deletion protection
 *                                         in the console (fake account resource + CloudTrail CreateDBInstance): the
 *                                         reclaim cannot delete it → CLEANUP_FAILED (the smoke:platform phase 8 fault)
 *   POST /__dev/reclaim/delete-resource   { type, region?, id } — the learner deleted it by hand (before “我已处理”)
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { envNameFromEnvId, Keys, LAMBDA_FUNCTIONS, matchRoute, WebKeys, type LambdaFunctionName, type TrailEvent } from '@atl/shared';
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
        timeScale: rt.clock instanceof ScaledClock ? rt.clock.scale : rt.cfg.timeScale,
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
    if (method === 'POST' && url.pathname === '/__dev/clock/scale') {
      if (!(rt.clock instanceof ScaledClock)) return sendJson(res, 409, { error: 'clock is not a ScaledClock' });
      const scale = Number((JSON.parse(body || '{}') as { scale?: number }).scale);
      if (!(scale > 0 && scale <= 600)) return sendJson(res, 400, { error: 'scale must be in (0, 600]' });
      rt.clock.setScale(scale);
      return sendJson(res, 200, { now: rt.clock.now().toISOString(), scale });
    }
    if (method === 'POST' && url.pathname === '/__dev/fixtures/completions') {
      try {
        return sendJson(res, 200, await devCompletions(rt, JSON.parse(body || '{}') as { sub?: string; trackId?: string; labIds?: string[] }));
      } catch (e) {
        return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === 'POST' && url.pathname === '/__dev/reclaim/protected-resource') {
      try {
        return sendJson(res, 200, await devProtectedResource(rt, String((JSON.parse(body || '{}') as { sessionId?: string }).sessionId ?? '')));
      } catch (e) {
        return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === 'POST' && url.pathname === '/__dev/reclaim/delete-resource') {
      const r = JSON.parse(body || '{}') as { type?: string; region?: string; id?: string };
      const k = `${r.type ?? ''}|${r.region ?? rt.env.region}|${r.id ?? ''}`;
      return sendJson(res, 200, { deleted: rt.reclaim.resources.delete(k), key: k });
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

// ---------------------------------------------------------------------------------------------------------------
// dev fixtures (the same records smoke:platform phase 7 / 8 writes; never in production)

async function devCompletions(rt: DevRuntime, p: { sub?: string; trackId?: string; labIds?: string[] }): Promise<{ sub: string; labIds: string[] }> {
  const sub = String(p.sub ?? '');
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(sub)) throw new Error('sub is required');
  let labIds = Array.isArray(p.labIds) ? p.labIds.map(String) : [];
  if (!labIds.length && p.trackId) {
    const cur = (await rt.deps.db.send(new GetCommand({ TableName: rt.env.tableName, Key: Keys.catalogCurrent() }))).Item as { catalogVersion?: string } | undefined;
    if (!cur?.catalogVersion) throw new Error('no current content release');
    const raw = await rt.objects.get(rt.env.buckets.web, `${WebKeys.content(cur.catalogVersion)}catalog/index.json`);
    const index = raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as { tracks?: { id: string; stages?: { items?: { card: string; role?: string }[] }[] }[] }) : null;
    const track = index?.tracks?.find((t) => t.id === p.trackId);
    if (!track) throw new Error(`track ${p.trackId} not found in the content release ${cur.catalogVersion}`);
    labIds = (track.stages ?? []).flatMap((s) => s.items ?? []).filter((i) => i.role === 'required').map((i) => i.card);
  }
  if (!labIds.length) throw new Error('trackId or labIds is required');
  const nowIso = rt.clock.now().toISOString();
  for (const labId of labIds) {
    const cur = (await rt.deps.db.send(new GetCommand({ TableName: rt.env.tableName, Key: Keys.labProgress(sub, labId) }))).Item ?? {};
    const attemptId = `sfx${createHash('sha256').update(`${sub}/${labId}`).digest('hex').replace(/[^0-9a-hjkmnp-tv-z]/g, '').slice(0, 10)}`;
    await rt.deps.db.send(
      new PutCommand({
        TableName: rt.env.tableName,
        Item: {
          ...cur,
          ...Keys.labProgress(sub, labId),
          type: 'LabProgress',
          sub,
          labId,
          kind: labId.startsWith('sc-') ? 'scenario' : 'service',
          ver: Number(cur.ver ?? 0) + 1,
          createdAt: cur.createdAt ?? nowIso,
          updatedAt: nowIso,
          status: 'completed',
          attempts: Number(cur.attempts ?? 0) + 1,
          attemptIds: [...((cur.attemptIds as string[] | undefined) ?? []), attemptId],
          bestAttemptId: attemptId,
          firstCompletedAt: cur.firstCompletedAt ?? nowIso,
          badge: { level: 'verified', status: 'valid', earnedAt: nowIso, attemptId, labVersion: '1.0.0', variant: 'default', evidenceScore: 0.95, fixture: 'dev' },
          credits: (cur.credits as unknown[] | undefined) ?? [],
          regressions: (cur.regressions as unknown[] | undefined) ?? [],
          quizByService: (cur.quizByService as Record<string, unknown> | undefined) ?? {},
        },
      }),
    );
  }
  return { sub, labIds };
}

async function devProtectedResource(rt: DevRuntime, sid: string): Promise<{ type: string; region: string; id: string }> {
  if (!/^s[0-9a-z]{12}$/.test(sid)) throw new Error('sessionId is required');
  const s = (await rt.deps.db.send(new GetCommand({ TableName: rt.env.tableName, Key: Keys.labSession(sid) }))).Item as { envId?: string } | undefined;
  if (!s?.envId) throw new Error(`session ${sid} has no environment`);
  const envName = envNameFromEnvId(String(s.envId));
  const region = rt.env.region;
  const id = `cloudalbum-${envName}-db-protected`;
  rt.reclaim.addResource({ type: 'AWS::RDS::DBInstance', region, id, behaviour: { kind: 'protected' } });
  const at = new Date(rt.clock.nowMs() - 60_000).toISOString();
  rt.trail.inject({
    eventId: `ev-${id}`,
    eventName: 'CreateDBInstance',
    eventTime: at,
    eventSource: 'rds.amazonaws.com',
    region,
    username: `atl-${sid}-console`,
    readOnly: false,
    resources: [{ resourceType: 'AWS::RDS::DBInstance', resourceName: id }],
    cloudTrailEvent: JSON.stringify({
      eventID: `ev-${id}`,
      eventName: 'CreateDBInstance',
      eventSource: 'rds.amazonaws.com',
      awsRegion: region,
      eventTime: at,
      userIdentity: { type: 'AssumedRole', arn: `arn:aws:sts::${rt.env.accountId}:assumed-role/ATLLearnerRole/atl-${sid}-console`, sessionContext: { sessionIssuer: { arn: `arn:aws:iam::${rt.env.accountId}:role/ATLLearnerRole` } } },
      requestParameters: { dBInstanceIdentifier: id },
      responseElements: { dBInstanceIdentifier: id, dBInstanceArn: `arn:aws:rds:${region}:${rt.env.accountId}:db:${id}` },
    }),
  });
  return { type: 'AWS::RDS::DBInstance', region, id };
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

// only when this file is the entry point: `dev-server.ts` (npm run platform:dev) also ends in “server.ts” and imports this
// module lazily for /__dev/* — a suffix match started a second runtime on the same port (EADDRINUSE; e2e:platform)
if (process.argv[1] && /(^|[\\/])dev[\\/]server\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
