/**
 * experiments/test/mock-server.ts —— 本地 mock CloudAlbum（只用于测试运行器、采集与报告；不连任何真实服务）。
 *
 * 模拟：/api/capabilities（admin / public 视图）、/api/lab/runs|metrics|results|faults|self-check、登录 / 登出 / me / JWKS、
 * 时间线（cache-aside：命中时没有 database 段，旁路时 database x3）、相册、上传三步（local 档）、照片就绪、评论、首页与静态资源。
 * 与后端一致：非管理员携带 X-Experiment-* / X-Compare-Bypass 返回 403；每个响应带 Server-Timing 与 X-CloudAlbum-Path。
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatPathHeader, formatServerTiming, MODULE_IDS, pathSignature, type ModuleId } from '@cloudalbum/contracts';

export interface RecordedRequest {
  method: string;
  path: string;
  route: string;
  status: number;
  runId?: string;
  label?: string;
  bypass?: string;
  authorization?: string;
  pathHeader: string;
  ms: number;
}

export interface MockOptions {
  drivers?: Partial<Record<ModuleId, string>>;
  statuses?: Partial<Record<ModuleId, string>>;
  /** 照片从 complete 到 READY 的毫秒数 */
  processingMs?: number;
  /** POST /api/lab/runs 等实验接口返回 501（模拟旧后端） */
  labDisabled?: boolean;
  /** 自定义 capabilities 片段（覆盖） */
  capsPatch?: Record<string, unknown>;
}

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

export function fakeJwt(payload: Record<string, unknown>, alg = 'ES256'): string {
  return `${b64url({ alg, kid: 'kid-1', typ: 'JWT' })}.${b64url(payload)}.c2ln`;
}

export interface MockServer {
  url: string;
  adminToken: string;
  requests: RecordedRequest[];
  runs: Map<string, Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
  faults: Array<Record<string, unknown>>;
  setDriver(module: ModuleId, driver: string, status?: string): void;
  close(): Promise<void>;
}

interface Photo { id: string; status: string; createdAt: string; readyAt: string | null; readyAtMs: number; processedBy: Record<string, unknown> | null; deleted: boolean }

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const now = Math.floor(Date.now() / 1000);
  const adminToken = fakeJwt({ iss: 'http://mock', sub: 'admin-0001-uuid', groups: ['admin'], iat: now, exp: now + 900, tv: 1 });
  const drivers: Record<string, string> = Object.fromEntries(MODULE_IDS.map((id) => [id, 'local']));
  Object.assign(drivers, { ec2: 'ec2', iam: 'none', storage: 'local', cdn: 'direct', auth: 'local', database: 'sqlite', cache: 'memory', queue: 'sync', 'image-processing': 'inline' }, opts.drivers ?? {});
  const statuses: Record<string, string> = Object.fromEntries(MODULE_IDS.map((id) => [id, id === 'ec2' ? 'ok' : 'off']));
  Object.assign(statuses, opts.statuses ?? {});
  const requests: RecordedRequest[] = [];
  const runs = new Map<string, Record<string, unknown>>();
  const results: Array<Record<string, unknown>> = [];
  const faults: Array<Record<string, unknown>> = [];
  const photos = new Map<string, Photo>();
  const albums = new Map<string, { id: string; title: string }>();
  const userTokens = new Map<string, string>();
  const revoked = new Set<string>();
  const failedLogins = new Map<string, number>();
  let albumsCached = false;

  const caps = (admin: boolean) => ({
    schemaVersion: 2, generatedAt: new Date().toISOString(), view: admin ? 'admin' : 'public',
    app: { version: 'mock', profile: 'l0-ec2', deployMode: 'single', region: 'ap-northeast-1',
      instance: { id: 'i-mock', az: 'ap-northeast-1a', type: 't4g.small', role: 'api' },
      entry: { baseUrl: 'http://mock', source: 'base' }, configHash: 'x', startedAt: new Date().toISOString() },
    https: { trusted: false, via: 'none' },
    validation: { errors: [], warnings: drivers.iam === 'keys' ? [{ rule: 'CRED-002', modules: ['iam'], message: '长期凭证在磁盘上' }] : [], overridden: [] },
    modules: Object.fromEntries(MODULE_IDS.map((id) => [id, {
      driver: drivers[id], awsService: 'mock', type: 'adapter', status: statuses[id], detail: 'mock', lastProbeAt: new Date().toISOString(),
      ...(id === 'auth' ? { public: { driver: drivers.auth, mfa: 'optional', passwordPolicy: { minLength: 10 } } } : {}),
    }])),
    features: { 'F1.mfa': { enabled: true, via: ['auth:local'] }, 'F12.albAuth': { enabled: false, reason: '需要 load-balancer' }, 'F6.upload': { enabled: true } },
    lab: { bypassEnabled: true, bypassKeys: ['cache', 'queue', 'image', 'cdn', 'replica'] },
    ...(opts.capsPatch ?? {}),
  });

  const server = http.createServer((req, res) => {
    const started = performance.now();
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://mock');
      const p = u.pathname;
      const m = (req.method ?? 'GET').toUpperCase();
      const auth = req.headers.authorization;
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const isAdmin = bearer === adminToken;
      const userEmail = bearer && !revoked.has(bearer) ? [...userTokens.entries()].find(([, t]) => t === bearer)?.[0] : undefined;
      const authed = isAdmin || Boolean(userEmail);
      const runId = req.headers['x-experiment-run'] as string | undefined;
      const label = req.headers['x-experiment-label'] as string | undefined;
      const bypass = req.headers['x-compare-bypass'] as string | undefined;
      const body = Buffer.concat(chunks);
      let json: Record<string, unknown> = {};
      try {
        json = body.length && /json/.test(String(req.headers['content-type'])) ? JSON.parse(body.toString()) as Record<string, unknown> : {};
      } catch {
        /* ignore */
      }
      const timing: Array<{ name: string; dur: number; desc?: string }> = [];
      const pathMods: Array<[ModuleId, string]> = [];
      let route = p;
      let status = 200;
      let payload: unknown = {};
      let raw: { body: string | Buffer; type: string } | undefined;
      const extraHeaders: Record<string, string> = {};

      const send = () => {
        const ms = performance.now() - started;
        const pathHeader = formatPathHeader({ entry: 'direct', inst: 'i-mock', az: 'ap-northeast-1a', modules: pathMods, ...(bypass && isAdmin ? { bypass: bypass.split(',') } : {}) });
        res.setHeader('Server-Timing', formatServerTiming([{ name: 'total', dur: ms + timing.reduce((a, t) => a + t.dur, 0) }, ...timing]));
        res.setHeader('X-CloudAlbum-Path', pathHeader);
        for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
        requests.push({ method: m, path: p, route, status, ...(runId ? { runId } : {}), ...(label ? { label } : {}), ...(bypass ? { bypass } : {}), ...(auth ? { authorization: auth } : {}), pathHeader, ms });
        if (raw) {
          res.writeHead(status, { 'content-type': raw.type });
          res.end(raw.body);
          return;
        }
        if (status === 204) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if ((runId || label || bypass) && !isAdmin) {
        status = 403;
        payload = { error: bypass ? 'BYPASS_FORBIDDEN' : 'EXPERIMENT_FORBIDDEN' };
        return send();
      }
      const needAdmin = () => {
        if (!isAdmin) {
          status = authed ? 403 : 401;
          payload = { error: 'FORBIDDEN' };
          return true;
        }
        return false;
      };
      const labOff = () => {
        if (opts.labDisabled) {
          status = 501;
          payload = { error: 'NOT_IMPLEMENTED' };
          return true;
        }
        return false;
      };
      const photoView = (ph: Photo) => {
        if (ph.status === 'PROCESSING' && Date.now() >= ph.readyAtMs) {
          ph.status = 'READY';
          ph.readyAt = new Date(ph.readyAtMs).toISOString();
          ph.processedBy = { driver: drivers['image-processing'], durationMs: 12, coldStart: false };
        }
        return { id: ph.id, status: ph.status, createdAt: ph.createdAt, readyAt: ph.readyAt, processedBy: ph.processedBy,
          urls: ph.status === 'READY' ? { thumb: `/media/variants/${ph.id}/thumb_200.webp?sig=x`, display: `/media/variants/${ph.id}/display_1080.webp?sig=x` } : { thumb: null, display: null } };
      };

      // ---------------------------------------------------------------- 路由
      if (p === '/api/capabilities' && m === 'GET') {
        payload = caps(isAdmin);
      } else if (p === '/api/auth/login' && m === 'POST') {
        const email = String(json.email ?? '');
        const pw = String(json.password ?? '');
        pathMods.push(['auth', 'local:login']);
        timing.push({ name: 'auth', dur: 30, desc: 'local:argon2' });
        const fails = failedLogins.get(email) ?? 0;
        if (fails >= 5) {
          status = 423;
          payload = { error: 'ACCOUNT_LOCKED' };
        } else if (email === 'admin@example.test' && pw === 'secret') {
          extraHeaders['set-cookie'] = `ca_at=${adminToken}; Path=/; HttpOnly`;
          payload = { kind: 'tokens', user: { id: 'admin' } };
        } else if (email.startsWith('user') && pw === 'pw') {
          const t = fakeJwt({ iss: 'http://mock', sub: `${email}-sub`, iat: now, exp: now + 900, tv: 1 });
          userTokens.set(email, t);
          extraHeaders['set-cookie'] = `ca_at=${t}; Path=/; HttpOnly`;
          payload = { kind: 'tokens', user: { id: email } };
        } else {
          failedLogins.set(email, fails + 1);
          status = 401;
          payload = { error: 'INVALID_CREDENTIALS' };
        }
      } else if (p === '/api/auth/logout' && m === 'POST') {
        if (bearer) revoked.add(bearer);
        status = 204;
      } else if (p === '/api/me' && m === 'GET') {
        if (!authed) {
          status = 401;
          payload = { error: 'UNAUTHENTICATED' };
        } else {
          pathMods.push(['auth', 'local:verify']);
          timing.push({ name: 'auth', dur: 0.4, desc: 'local:verify' });
          payload = { id: isAdmin ? 'admin' : userEmail };
        }
      } else if (p === '/.well-known/jwks.json') {
        payload = { keys: [{ kid: 'kid-1', alg: 'ES256', kty: 'EC' }] };
      } else if (p === '/api/lab/runs' && m === 'POST') {
        if (!needAdmin() && !labOff()) {
          const id = String(json.runId ?? randomUUID());
          runs.set(id, { ...json, startedAt: new Date().toISOString() });
          status = 201;
          payload = { runId: id, startedAt: runs.get(id)!.startedAt };
        }
      } else if (/^\/api\/lab\/runs\/[^/]+\/finish$/.test(p) && m === 'POST') {
        if (!needAdmin() && !labOff()) {
          const id = p.split('/')[4]!;
          const r = runs.get(id);
          if (r) r.finishedAt = new Date().toISOString();
          payload = r ?? {};
          status = r ? 200 : 404;
        }
      } else if (/^\/api\/lab\/runs\/[^/]+\/photos$/.test(p) && m === 'DELETE') {
        status = 501;
        payload = { error: 'NOT_IMPLEMENTED' };
      } else if (p === '/api/lab/metrics' && m === 'GET') {
        if (!needAdmin() && !labOff()) {
          const run = u.searchParams.get('run');
          const groupBy = u.searchParams.get('groupBy') ?? 'path';
          const rows = requests.filter((r) => !run || r.runId === run);
          const groups = new Map<string, number[]>();
          const errs = new Map<string, number>();
          for (const r of rows) {
            const key = groupBy === 'route' ? `${r.method} ${r.route}` : `${r.method} ${r.route} | ${pathSignature(r.pathHeader)}`;
            groups.set(key, [...(groups.get(key) ?? []), r.ms]);
            if (r.status >= 500) errs.set(key, (errs.get(key) ?? 0) + 1);
          }
          const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil((q / 100) * a.length) - 1)] ?? 0;
          const routes = [...groups.entries()].map(([group, a]) => ({ group, count: a.length, errors: errs.get(group) ?? 0, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: Math.max(...a), avg: a.reduce((x, y) => x + y, 0) / a.length }));
          const cacheCalls = rows.filter((r) => /cache=/.test(r.pathHeader)).length;
          payload = {
            routes,
            ports: groupBy === 'path' && cacheCalls ? [{ group: `cache:${drivers.cache}`, count: cacheCalls, errors: 0, p50: 0.2, p95: 0.5, p99: 0.9, max: 1 }] : [],
            recent: [],
            host: [
              { ts: new Date(Date.now() - 20_000).toISOString(), instance_id: 'i-mock', role: 'api', cpu_pct: 20, rss_bytes: 1e8, event_loop_delay_p99_ms: 12, mem_used_ratio: 0.5, net_rx_bytes: 1_000, net_tx_bytes: 2_000 },
              { ts: new Date(Date.now() - 10_000).toISOString(), instance_id: 'i-mock', role: 'api', cpu_pct: 40, rss_bytes: 1.2e8, event_loop_delay_p99_ms: 30, mem_used_ratio: 0.55, net_rx_bytes: 51_000, net_tx_bytes: 4_000 },
              { ts: new Date(Date.now() - 10_000).toISOString(), instance_id: 'i-mock', role: 'worker', cpu_pct: 15, rss_bytes: 0.8e8, event_loop_delay_p99_ms: 3, mem_used_ratio: 0.55, net_rx_bytes: 51_000, net_tx_bytes: 4_000 },
            ],
            origin: [{ minute: new Date().toISOString(), instance_id: 'i-mock', requests: rows.length, bytes: 1234, via_cloudfront: 0, via_alb: 0, direct: rows.length }],
          };
        }
      } else if (p === '/api/lab/results' && m === 'POST') {
        if (!needAdmin() && !labOff()) {
          results.push(json);
          status = 201;
          payload = { runId: json.runId };
        }
      } else if (p === '/api/lab/faults' && m === 'POST') {
        if (!needAdmin()) {
          faults.push(json);
          status = 201;
          payload = { id: `f${faults.length}`, ...json };
        }
      } else if (p === '/api/lab/self-check' && m === 'GET') {
        if (!needAdmin()) payload = { ok: true, awsSdk: { loaded: [] } };
      } else if (['/api/lab/iam/whoami', '/api/lab/aws-ping', '/api/lab/db/read-after-write', '/api/lab/storage/upload-target'].includes(p)) {
        status = 501;
        payload = { error: 'NOT_IMPLEMENTED' };
      } else if (p === '/api/lab/now' || p === '/api/public/now') {
        if (p === '/api/lab/now' && needAdmin()) { /* 403 */ } else {
          extraHeaders['cache-control'] = p === '/api/public/now' ? 'public, s-maxage=10' : 'private, no-store';
          payload = { now: new Date().toISOString() };
        }
      } else if (p === '/api/feed' && m === 'GET') {
        route = '/api/feed';
        const bypassed = isAdmin && bypass?.includes('cache');
        const replica = isAdmin && bypass?.includes('replica');
        if (bypassed) {
          pathMods.push(['cache', `${drivers.cache}:bypass`]);
          timing.push({ name: 'database', dur: 6, desc: `${drivers.database} x3` });
          pathMods.push(['database', drivers.database!]);
        } else {
          pathMods.push(['cache', `${drivers.cache}:hit`]);
          timing.push({ name: 'cache', dur: 0.1, desc: `${drivers.cache}:hit` });
          if (drivers.database === 'postgres') pathMods.push(['database', replica ? 'postgres@rds:bypass' : 'postgres@rds:replica']);
        }
        const items = [...photos.values()].filter((ph) => !ph.deleted).map(photoView).filter((ph) => ph.status === 'READY');
        payload = { items, nextCursor: null };
      } else if (p === '/api/albums' && m === 'GET') {
        route = '/api/albums';
        if (albumsCached) {
          pathMods.push(['cache', `${drivers.cache}:hit`]);
        } else {
          albumsCached = true;
          pathMods.push(['cache', `${drivers.cache}:miss`]);
          timing.push({ name: 'database', dur: 3, desc: `${drivers.database} x2` });
        }
        payload = { items: [...albums.values()], nextCursor: null };
      } else if (p === '/api/albums' && m === 'POST') {
        route = '/api/albums';
        const id = randomUUID();
        albums.set(id, { id, title: String(json.title ?? '') });
        albumsCached = false;
        status = 201;
        timing.push({ name: 'database', dur: 2, desc: drivers.database! });
        payload = { id, title: json.title };
      } else if (/^\/api\/albums\/[^/]+$/.test(p)) {
        route = '/api/albums/:id';
        const id = p.split('/')[3]!;
        if (!albums.has(id)) {
          status = 404;
          payload = { error: 'ALBUM_NOT_FOUND' };
        } else if (m === 'DELETE') {
          albums.delete(id);
          albumsCached = false;
          status = 204;
        } else {
          payload = albums.get(id);
        }
      } else if (p === '/api/photos' && m === 'POST') {
        route = '/api/photos';
        if (!authed) {
          status = 401;
        } else {
          const id = randomUUID();
          photos.set(id, { id, status: 'UPLOADING', createdAt: new Date().toISOString(), readyAt: null, readyAtMs: Infinity, processedBy: null, deleted: false });
          status = 201;
          pathMods.push(['storage', `${drivers.storage}:sign`]);
          payload = { photoId: id, uploadTarget: { method: 'PUT', url: `/api/storage/upload?key=raw/${id}.jpg&sig=x`, headers: { 'Content-Type': 'image/jpeg' } } };
        }
      } else if (p === '/api/storage/upload' && m === 'PUT') {
        route = '/api/storage/upload';
        pathMods.push(['storage', `${drivers.storage}:write`]);
        timing.push({ name: 'storage', dur: 1 + body.length / 1e6, desc: `${drivers.storage}:write` });
        payload = { ok: true, bytes: body.length };
      } else if (/^\/api\/photos\/[^/]+\/complete$/.test(p) && m === 'POST') {
        route = '/api/photos/:id/complete';
        const ph = photos.get(p.split('/')[3]!);
        if (!ph) {
          status = 404;
        } else {
          const inline = drivers['image-processing'] === 'inline' || (isAdmin && (bypass?.includes('image') || bypass?.includes('queue')));
          if (inline) {
            ph.status = 'READY';
            ph.readyAtMs = Date.now();
            ph.readyAt = new Date().toISOString();
            ph.processedBy = { driver: 'inline', durationMs: 5 };
            pathMods.push(['image-processing', bypass ? 'inline:bypass' : 'inline:sync']);
            timing.push({ name: 'image-processing', dur: 5, desc: 'inline:sync' });
            payload = { status: 'READY', mode: 'inline', photo: photoView(ph) };
          } else {
            ph.status = 'PROCESSING';
            ph.readyAtMs = Date.now() + (opts.processingMs ?? 50);
            pathMods.push(['queue', `${drivers.queue}:queued`]);
            timing.push({ name: 'queue', dur: 0.5, desc: `${drivers.queue}:queued` });
            status = 202;
            payload = { status: 'PROCESSING', mode: 'async', photo: photoView(ph) };
          }
        }
      } else if (/^\/api\/photos\/[^/]+$/.test(p)) {
        route = '/api/photos/:id';
        const ph = photos.get(p.split('/')[3]!);
        if (!ph || ph.deleted) {
          status = 404;
        } else if (m === 'DELETE') {
          ph.deleted = true;
          status = 204;
        } else {
          payload = photoView(ph);
        }
      } else if (/^\/social\/photos\/[^/]+\/comments$/.test(p) && m === 'POST') {
        route = '/social/photos/:id/comments';
        status = authed ? 201 : 401;
        timing.push({ name: 'social-store', dur: 1, desc: 'db' });
        payload = { comment: { id: randomUUID(), text: json.text } };
      } else if (p.startsWith('/media/')) {
        raw = { body: Buffer.alloc(2048, 1), type: 'image/webp' };
        extraHeaders['x-cache'] = 'Miss from cloudfront';
      } else if (p === '/') {
        raw = { body: '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-abc.css"></head><body><script type="module" src="/assets/index-abc.js"></script></body></html>', type: 'text/html' };
      } else if (p.startsWith('/assets/')) {
        raw = { body: 'console.log("x");'.repeat(50), type: p.endsWith('.css') ? 'text/css' : 'application/javascript' };
      } else if (p === '/api/health/live') {
        payload = { ok: true };
      } else {
        status = 404;
        payload = { error: 'NOT_FOUND', path: p };
      }
      send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    adminToken, requests, runs, results, faults,
    setDriver(module, driver, st) {
      drivers[module] = driver;
      if (st) statuses[module] = st;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
