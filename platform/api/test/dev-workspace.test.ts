/**
 * Dev mode end to end (ATL_DEV_MODE wiring of platform-backend-gaps): the API routes with the dev WorkspaceAccess, the
 * real mock Session Manager of @atl/ssm-client (ws data channel, in this process) driven by the real browser protocol
 * client (`SsmTerminalConnection`, Node 22 global WebSocket), and the local federation stub. Loopback only, no AWS.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devAdvance } from '../src/dev-server.js';
import { ensureSsmMock } from '../src/dev/adapters/workspace.js';
import { createDevWorkspaceAccess } from '../src/services/workspace/dev-access.js';
import { DevFederationStub } from '../src/services/workspace/dev-federation.js';
import { createWorkspaceProvider } from '../src/services/workspace/provider.js';
import { SsmTerminalConnection, type StateChange } from '../../ssm-client/src/index.js';
import { body, createApiTestRuntime, ev, LEARNER, type ApiTestRuntime } from './api-support/api-runtime.js';
import { LAB_ID } from './api-support/fixtures.js';

let mock: { url: string; close: () => Promise<void> } | null = null;
let fedServer: http.Server;
let fedUrl = '';
const federation = new DevFederationStub();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-dev-ws-'));

beforeAll(async () => {
  mock = await ensureSsmMock({ url: 'http://127.0.0.1:0', quiet: true });
  fedServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const params = new URLSearchParams(new URL(req.url ?? '/', 'http://x').search);
      for (const [k, v] of new URLSearchParams(raw)) params.set(k, v);
      const r = federation.handle(req.method ?? 'GET', params);
      res.writeHead(r.status, r.headers).end(r.body);
    });
  });
  await new Promise<void>((resolve) => fedServer.listen(0, '127.0.0.1', resolve));
  fedUrl = `http://127.0.0.1:${(fedServer.address() as AddressInfo).port}/__dev/federation`;
});

afterAll(async () => {
  await mock?.close();
  await new Promise<void>((resolve) => fedServer.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function waitFor<T>(what: string, poll: () => T | undefined | null | false, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = poll();
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('dev workspace: terminal through the SSM mock, console through the federation stub', () => {
  let rt: ApiTestRuntime;
  let sid = '';

  beforeAll(async () => {
    expect(mock, 'the @atl/ssm-client mock server starts in-process').not.toBeNull();
    rt = await createApiTestRuntime({
      ext: {
        workspace: createWorkspaceProvider({
          access: createDevWorkspaceAccess({ ssmMockUrl: mock!.url, federationUrl: fedUrl, dataDir, nowMs: () => Date.now() }),
        }),
      },
    });
    await rt.repos.platform.updateConfig({ rateLimits: { terminal: 0, consoleLink: 0 } }, undefined, new Date(rt.clock.nowMs()).toISOString());
    const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
    sid = body(await rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true } }))).sessionId as string;
    await devAdvance(rt.deps, sid, 'PROVISIONING');
    await devAdvance(rt.deps, sid, 'READY');
  });

  it('opens, types, survives a dropped connection through the resume route, and closes', async () => {
    let terminalId = '';
    let ssmSessionId = '';
    const out: string[] = [];
    const states: StateChange[] = [];
    const conn = new SsmTerminalConnection({
      clientId: 'vitest-tab',
      streamUrlPolicy: { allowLoopback: true },
      open: async () => {
        const r = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab', cols: 100, rows: 30, clientId: 'vitest-tab' } }));
        expect(r.statusCode, r.body).toBe(201);
        const b = body(r);
        terminalId = String(b.terminalId);
        ssmSessionId = String(b.ssmSessionId);
        expect(b.streamUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/data-channel\/atl-s[0-9a-z]{12}-term-/);
        return { streamUrl: String(b.streamUrl), tokenValue: String(b.tokenValue), connectBy: String(b.connectBy) };
      },
      resume: async () => {
        const r = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals/${terminalId}/resume`, { token: LEARNER, body: { clientId: 'vitest-tab' } }));
        if (r.statusCode !== 200) throw Object.assign(new Error(r.body ?? ''), { status: r.statusCode, code: body(r).code });
        const b = body(r);
        return { streamUrl: String(b.streamUrl), tokenValue: String(b.tokenValue), connectBy: String(b.connectBy) };
      },
      onOutput: (data, done) => {
        out.push(Buffer.from(data).toString('utf8'));
        done();
      },
    });
    conn.on('state', (s) => states.push(s));
    await conn.start();
    await waitFor('ready', () => conn.state === 'ready');
    conn.sendInput('echo hello-from-atl\n');
    await waitFor('echo output', () => out.join('').includes('hello-from-atl\r\n') || out.join('').split('hello-from-atl').length > 2);
    // network failure on the data channel → the client resumes through POST …/resume (ResumeSession on the mock)
    await fetch(`${mock!.url}/DropConnection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ SessionId: ssmSessionId }) });
    await waitFor('resumed ready', () => states.some((s) => s.state === 'ready' && s.resumed));
    conn.sendInput('echo after-resume\n');
    await waitFor('output after resume', () => out.join('').split('after-resume').length > 2);
    const term = await rt.api(ev('GET', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER }));
    expect(body<{ terminalId: string; resumeCount: number; status: string }[]>(term).find((t) => t.terminalId === terminalId)).toMatchObject({ status: 'OPEN', resumeCount: 1 });
    // DELETE → TerminateSession on the mock → channel_closed reaches the client
    expect((await rt.api(ev('DELETE', `/api/v1/sessions/${sid}/terminals/${terminalId}`, { token: LEARNER }))).statusCode).toBe(204);
    await waitFor('closed', () => conn.state === 'closed');
    const gone = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals/${terminalId}/resume`, { token: LEARNER, body: {} }));
    expect(body(gone)).toMatchObject({ status: 409, code: 'TERMINAL_GONE' });
    conn.close();
  }, 30_000);

  it('workspace targets, console sign-in through the stub, app credentials', async () => {
    const w = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/workspace`, { token: LEARNER })));
    expect((w.targets as { tab: string; ssmPing: string }[]).map((t) => `${t.tab}:${t.ssmPing}`)).toEqual(['terminal-lab:Online', 'terminal-workstation:Online']);
    const link = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/console-link`, { token: LEARNER, body: { linkId: 'cloudtrail.events' } })));
    const form = link.form as { action: string; fields: Record<string, string> };
    expect(form.action).toBe(fedUrl);
    const login = await fetch(form.action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form.fields).toString() });
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('cloudtrail/home?region=ap-northeast-1#/events');
    expect(federation.logins.at(-1)).toMatchObject({ destination: form.fields.Destination });
    // a token is single use
    const again = await fetch(form.action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form.fields).toString() });
    expect(again.status).toBe(400);
    const cred = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/app-credentials`, { token: LEARNER })));
    expect(cred).toMatchObject({ username: 'atl-admin@example.com', password: expect.stringMatching(/^[\w-]{20,}$/) });
    expect(body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/app-credentials`, { token: LEARNER }))).password).toBe(cred.password);
  });

  it('the federation stub refuses SessionDuration (role chaining, 03 §5.3)', () => {
    const r = federation.handle('POST', new URLSearchParams({ Action: 'getSigninToken', SessionDuration: '43200', Session: '{}' }));
    expect(r.status).toBe(400);
  });
});
