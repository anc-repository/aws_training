/**
 * wave1-sns-ses：experiments/notification 与 experiments/email 的清单与 Node 场景。
 *
 * 场景对着共享的 mock 服务器（test/mock-server.ts）运行；它没有的接口（投递记录、outbox、注册 / 找回密码、两个功能对照端点、
 * 评论触发的通知）由本文件前置的一层小代理补上，其余请求原样转发。故障脚本由测试执行器代替（不执行任何 shell / AWS CLI）。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FaultExecutor } from '../_lib/faults.js';
import { closeSharedDispatcher } from '../_lib/http.js';
import { loadManifest, validateLabel } from '../_lib/manifest.js';
import { EXIT, parseRunnerArgs, runExperiment } from '../_lib/runner.js';
import { validateResult } from '../_lib/schema.js';
import type { ResultDoc } from '../_lib/types.js';
import { experimentsRoot } from '../_lib/util.js';
import { aliasOf } from '../notification/users.js';
import { byChannel } from '../notification/fanout.js';
import { startMockServer, type MockServer } from './mock-server.js';

interface Delivery { event_id: string; channel: string; status: string; target: string | null; at: string }
interface Mail { id: string; messageId: string; to: string[]; category: string; transport: string; status: string; deliveryStatus: string; error: string | null; createdAt: string; sentAt: string | null }

let mock: MockServer;
let front: http.Server;
let frontUrl = '';
const deliveries: Delivery[] = [];
const outbox: Mail[] = [];
const registered = new Set<string>();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'exp-sns-ses-'));
const usersFile = path.join(tmp, 'notification-users.json');
const executor: FaultExecutor = async () => ({ via: 'test', exitCode: 0 });

function mail(to: string, category: string): Mail {
  const sim = /@simulator\.amazonses\.com$/.test(to);
  const status = /unverified/.test(to) ? 'failed' : 'sent';
  const deliveryStatus = !sim ? 'none' : to.startsWith('bounce') ? 'bounced' : to.startsWith('complaint') ? 'complained' : 'delivered';
  return {
    id: randomUUID(), messageId: randomUUID(), to: [to], category, transport: 'ses', status, deliveryStatus,
    error: status === 'failed' ? 'MessageRejected（HTTP 400）：Email address is not verified.' : null, createdAt: new Date().toISOString(), sentAt: new Date().toISOString(),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown, timing = 'total;dur=3'): void {
  res.writeHead(status, { 'content-type': 'application/json', 'server-timing': timing, 'x-cloudalbum-path': 'entry=direct;inst=i-mock;email=ses:sent' });
  res.end(JSON.stringify(body));
}

/** 转发给 mock；评论成功后补一条通知的投递记录与 Server-Timing 的 notification 段 */
function forward(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): void {
  const target = new URL(mock.url);
  const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => {
      const out = Buffer.concat(chunks);
      const headers = { ...r.headers };
      if (/^\/social\/photos\/[^/]+\/comments$/.test(new URL(req.url ?? '/', 'http://x').pathname) && req.method === 'POST' && r.statusCode === 201) {
        const id = (JSON.parse(out.toString()) as { comment?: { id?: string } }).comment?.id;
        const at = new Date().toISOString();
        deliveries.push({ event_id: `comment.created:${id}`, channel: 'sns', status: 'sent', target: 'cloudalbum-lab-notification-events', at });
        deliveries.push({ event_id: `comment.created:${id}`, channel: 'sqs-copy', status: 'sent', target: 'inbox', at });
        headers['server-timing'] = `${String(headers['server-timing'] ?? '')}, notification;dur=14;desc="sns"`;
      }
      delete headers['content-length'];
      res.writeHead(r.statusCode ?? 502, headers);
      res.end(out);
    });
  });
  up.on('error', () => json(res, 502, { error: 'BAD_GATEWAY' }));
  up.end(body);
}

beforeAll(async () => {
  mock = await startMockServer({ processingMs: 10, drivers: { notification: 'sns', email: 'ses' }, statuses: { notification: 'ok', email: 'degraded' } });
  front = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url ?? '/', 'http://front');
      const p = u.pathname;
      const m = req.method ?? 'GET';
      const input = body.length ? JSON.parse(body.toString()) as Record<string, string> : {};
      if (p === '/api/admin/notifications/deliveries' && m === 'GET') {
        const eventId = u.searchParams.get('eventId');
        return json(res, 200, { items: deliveries.filter((d) => !eventId || d.event_id === eventId).slice(-200).reverse(), nextCursor: null, driver: 'sns' });
      }
      if (p === '/api/admin/outbox' && m === 'GET') {
        const to = u.searchParams.get('to');
        const cat = u.searchParams.get('category');
        return json(res, 200, { items: outbox.filter((x) => (!to || x.to.includes(to)) && (!cat || x.category === cat)).reverse(), nextCursor: null, transport: 'ses' });
      }
      if (p === '/api/auth/register' && m === 'POST') {
        if (registered.has(input.email!)) return json(res, 409, { error: 'EMAIL_TAKEN' });
        registered.add(input.email!);
        outbox.push(mail(input.email!, 'verification'));
        return json(res, 201, { userId: randomUUID() }, 'total;dur=80, email;dur=60;desc="ses"');
      }
      if (p === '/api/auth/forgot' && m === 'POST') {
        outbox.push(mail(input.email!, 'password-reset'));
        return json(res, 202, { ok: true }, 'total;dur=70, email;dur=55;desc="ses"');
      }
      if (p === '/api/auth/resend' && m === 'POST') {
        outbox.push(mail(input.email!, 'verification'));
        res.writeHead(204);
        return res.end();
      }
      if (p === '/api/lab/notification/compare' && m === 'POST') {
        return json(res, 200, { type: 'report.ready', audience: 'admin', recipients: 3, db: { ms: 30, calls: 3, channels: ['email'] }, sns: { ms: 15, calls: 1, channels: ['sns'] } });
      }
      if (p === '/api/lab/email/compare' && m === 'POST') {
        return json(res, 200, { to: input.to, reserved: false, outbox: { ms: 2, transport: 'outbox', delivered: false }, ses: { ms: 60, transport: 'ses', delivered: true } });
      }
      forward(req, body, res);
    });
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  frontUrl = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  writeFileSync(usersFile, JSON.stringify({
    target: frontUrl, base: 'learner@mail.test-only.dev', createdAt: new Date().toISOString(),
    users: [1, 2, 3].map((i) => ({ alias: `u${i}`, email: aliasOf('learner@mail.test-only.dev', `u${i}`), password: 'pw-123456', userId: `user-${i}`, role: 'admin', photoId: `photo-${i}` })),
  }));
});

afterAll(async () => {
  await new Promise<void>((r) => front.close(() => r()));
  await mock.close();
  await closeSharedDispatcher();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(module: string, id: string, label: string, extra: string[] = []): Promise<ResultDoc> {
  const argv = [module, '--scenario', id, '--label', label, '--vus', '1', '--duration', '400ms', '--warmup', '0s', '--force', '--target', frontUrl, '--out', path.join(tmp, 'results'), ...extra];
  const lines: string[] = [];
  const r = await runExperiment(parseRunnerArgs(argv), {
    env: { CLOUDALBUM_ADMIN_TOKEN: mock.adminToken, CLOUDALBUM_ADMIN_EMAIL: 'admin@example.test', CLOUDALBUM_ADMIN_PASSWORD: 'secret' },
    repo: tmp, faultExecutor: executor, log: (l) => lines.push(l),
  });
  expect(r.code, `${r.message ?? ''}\n${lines.join('\n')}`).toBe(EXIT.ok);
  const doc = r.result as ResultDoc;
  expect(validateResult(doc).errors).toEqual([]);
  expect(doc.warnings?.filter((w) => w.startsWith('场景出错')) ?? []).toEqual([]);
  return doc;
}

describe('manifests (notification, email)', () => {
  for (const module of ['notification', 'email'] as const) {
    it(`${module}: schema-valid, ids = registry lab.experiments, labels / faults / params consistent`, () => {
      const manifest = loadManifest(module, experimentsRoot());
      const registryIds = REGISTRY_DOCUMENT.modules[module].lab.experiments ?? [];
      expect(manifest.experiments.map((e) => e.id).sort()).toEqual([...registryIds].sort());
      for (const e of manifest.experiments) {
        for (const label of Object.keys(e.requires ?? {})) expect(() => validateLabel(e, label)).not.toThrow();
        for (const f of e.faults ?? []) for (const l of f.onlyFor ?? []) expect(Object.keys(e.requires ?? {})).toContain(l);
        for (const [k, spec] of Object.entries(e.params ?? {})) expect(spec.default, `${e.id}.params.${k}.default`).toBeDefined();
      }
    });
  }
});

describe('notification scenarios', () => {
  it('fanout: per-event deliveries come from the server (sns + sqs-copy), broadcast via the compare endpoint, publish timing', async () => {
    const d = await run('notification', 'fanout', 'after', ['--param', `users=${usersFile}`, '--param', 'comments=4', '--param', 'waitSec=2']);
    const f = d.scenario!.findings;
    expect(f).toMatchObject({ driver: 'sns', recipients: 3, comments: 4, deliveriesByChannel: { sns: 4, 'sqs-copy': 4 }, deliveriesPerEvent: 2, notificationMsP50: 14 });
    expect(d.server.business).toMatchObject({ deliveries_sns: 4, deliveries_inbox: 4, deliveries_email: 0, broadcast_db_email_calls: 3, broadcast_sns_ms: 15 });
  }, 30_000);

  it('filter: only the chosen user, no e-mail to the others, one inbox copy', async () => {
    const d = await run('notification', 'filter', 'after', ['--param', `users=${usersFile}`, '--param', 'user=u2']);
    expect(d.scenario!.findings).toMatchObject({ recipient: 'learner+u2@mail.test-only.dev', emailedOthers: 0 });
    expect(d.server.business).toMatchObject({ filter_emailed_others: 0, filter_inbox_copies: 1 });
  }, 30_000);

  it('compare: both sides of the functional comparison', async () => {
    const d = await run('notification', 'compare', 'after');
    expect(d.scenario!.findings).toMatchObject({ recipients: 3, dbVsSnsMsRatio: 2 });
  }, 30_000);

  it('worker-stop: faults at 5 s / 50 s are scheduled; comments keep succeeding; inbox copies complete', async () => {
    const d = await run('notification', 'worker-stop', 'after', ['--param', `users=${usersFile}`, '--param', 'intervalSec=1', '--param', 'drainSec=2']);
    expect(d.scenario!.findings.commentFailures).toBe(0);
    expect(d.server.business).toMatchObject({ worker_stop_comment_failures: 0, worker_stop_inbox_missing: 0 });
  }, 30_000);

  it('byChannel counts only the events of this run', () => {
    const rows = [{ event_id: 'a', channel: 'sns' }, { event_id: 'a', channel: 'sqs-copy' }, { event_id: 'z', channel: 'email' }] as Delivery[];
    expect(byChannel(rows, new Set(['a']))).toEqual({ sns: 1, 'sqs-copy': 1 });
  });
});

describe('email scenarios', () => {
  it('send-matrix: simulator addresses end as delivered / bounced / complained (server-side outbox records)', async () => {
    const d = await run('email', 'send-matrix', 'after', ['--param', 'to=learner@mail.test-only.dev', '--param', 'waitSec=2']);
    const results = d.scenario!.findings.results as Record<string, { deliveryStatus: string; transport: string }>;
    expect(results['success@simulator.amazonses.com']).toMatchObject({ deliveryStatus: 'delivered', transport: 'ses' });
    expect(results['bounce@simulator.amazonses.com']).toMatchObject({ deliveryStatus: 'bounced' });
    expect(results['complaint@simulator.amazonses.com']).toMatchObject({ deliveryStatus: 'complained' });
    expect(d.server.business).toMatchObject({ mail_delivered: 1, mail_bounced: 1, mail_complained: 1, email_send_ms_p50: 55 });
  }, 30_000);

  it('sandbox: MessageRejected for an unverified address is read from the server record', async () => {
    const d = await run('email', 'sandbox', 'after', ['--param', 'to=unverified@mail.test-only.dev']);
    expect(d.scenario!.findings).toMatchObject({ rejected: true });
    expect(d.server.business).toMatchObject({ sandbox_rejected: 1 });
  }, 30_000);

  it('compare and register-latency', async () => {
    const c = await run('email', 'compare', 'after', ['--param', 'to=learner@mail.test-only.dev']);
    expect(c.server.business).toMatchObject({ compare_ses_delivered: 1, compare_ses_ms: 60 });
    const r = await run('email', 'register-latency', 'after', ['--param', 'count=3', '--duration', '5s']);
    expect(r.scenario!.findings).toMatchObject({ registered: 3, emailMsP50: 60 });
  }, 30_000);
});
