/**
 * 03 WorkspaceProvider against mocked SDK clients (aws-sdk-client-mock: STS, EC2, SSM) and an injected fetch for the
 * federation endpoint, driven through the real API routes (state gates, recent login, events, audit). No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  DescribeInstanceInformationCommand,
  DescribeSessionsCommand,
  GetParameterCommand,
  ResumeSessionCommand,
  SSMClient,
  StartSessionCommand,
  TerminateSessionCommand,
} from '@aws-sdk/client-ssm';
import { Keys, SkPrefix } from '@atl/shared';
import { devAdvance } from '../src/dev-server.js';
import { devToken } from '../src/dev/adapters/auth.js';
import { createAwsWorkspaceAccess } from '../src/services/workspace/access.js';
import { allowedConsoleHosts, checkDestination, CONSOLE_LINKS, resolveConsoleLink } from '../src/services/workspace/console-links.js';
import { frameHeadersVerdict, isBlockedAddress, createHttpsProber, previewEntries, type PreviewProber } from '../src/services/workspace/preview.js';
import {
  acceptTargets,
  createWorkspaceProvider,
  isAcceptableStreamUrl,
  sourceIdentityOf,
  SSM_CLIENT_VERSION,
  terminalDurationSeconds,
  terminalSessionPolicy,
} from '../src/services/workspace/provider.js';
import { ACCOUNT, body, createApiTestRuntime, ev, LEARNER, OBSERVER, type ApiTestRuntime } from './api-support/api-runtime.js';
import { LAB_ID } from './api-support/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const REGION = 'ap-northeast-1';

const mocks: { restore(): void }[] = [];
afterEach(() => mocks.splice(0).forEach((m) => m.restore()));

function named(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

describe('helpers', () => {
  it('session policy (03 §3.2) stays inside the 2,048-character packed limit and names this env / sid only', () => {
    const p = terminalSessionPolicy({ region: REGION, accountId: ACCOUNT, sid: 's4k7m2q9x1abc', envId: '01jc9x3k9cq2w8e4r6t0y1u3i5' });
    expect(p.length).toBeLessThan(2048);
    const doc = JSON.parse(p) as { Statement: { Sid: string; Resource: unknown; Condition?: unknown }[] };
    expect(doc.Statement.map((s) => s.Sid)).toEqual(['FindTargets', 'OnlyThisEnvironmentsInstances', 'OnlyAtlSessionShell', 'OwnSessionsOnly', 'OpenOwnDataChannel', 'Reconcile']);
    expect(JSON.stringify(doc)).toContain('"ssm:resourceTag/atl:env-id":"01jc9x3k9cq2w8e4r6t0y1u3i5"');
    expect(JSON.stringify(doc)).toContain(`arn:aws:ssm:${REGION}:${ACCOUNT}:session/atl-s4k7m2q9x1abc-term-*`);
  });

  it('credential duration follows the deadline (900–3600 s)', () => {
    const now = Date.UTC(2026, 9, 14, 1);
    expect(terminalDurationSeconds(new Date(now + 30 * 60_000).toISOString(), now)).toBe(1860);
    expect(terminalDurationSeconds(new Date(now + 5 * 60_000).toISOString(), now)).toBe(900);
    expect(terminalDurationSeconds(new Date(now + 5 * 3_600_000).toISOString(), now)).toBe(3600);
    expect(terminalDurationSeconds(null, now)).toBe(3600);
  });

  it('SourceIdentity: the Cognito user name when STS accepts it, else the sub', () => {
    expect(sourceIdentityOf({ username: 'zhang.san@example.com', sub: 'x' })).toBe('zhang.san@example.com');
    expect(sourceIdentityOf({ username: '张三', sub: '0d6a-4c1e' })).toBe('0d6a-4c1e');
  });

  it('StreamUrl check (03 §3.2 step 8)', () => {
    expect(isAcceptableStreamUrl(`wss://ssmmessages.${REGION}.amazonaws.com/v1/data-channel/atl-s1-term-0a?role=publish_subscribe`, REGION)).toBe(true);
    expect(isAcceptableStreamUrl(`wss://ssmmessages.${REGION}.api.aws/v1/data-channel/x`, REGION)).toBe(true);
    expect(isAcceptableStreamUrl('wss://ssmmessages.us-east-1.amazonaws.com/v1/data-channel/x', REGION)).toBe(false);
    expect(isAcceptableStreamUrl(`wss://u:p@ssmmessages.${REGION}.amazonaws.com/x`, REGION)).toBe(false);
    expect(isAcceptableStreamUrl(`ws://ssmmessages.${REGION}.amazonaws.com/x`, REGION)).toBe(false);
    expect(isAcceptableStreamUrl('ws://127.0.0.1:8790/v1/data-channel/x', REGION)).toBe(false);
    expect(isAcceptableStreamUrl('ws://127.0.0.1:8790/v1/data-channel/x', REGION, true)).toBe(true);
  });

  it('targets need the AWS-reserved stack tags of this environment (03 §3.2 step 4)', () => {
    const base = { state: 'running', launchTime: null, privateIp: null, publicIp: null };
    const t = acceptTargets(
      [
        { ...base, instanceId: 'i-0aaaaaaaaaaaaaaa1', tags: { 'atl:role': 'lab-app', 'aws:cloudformation:stack-name': 'cloudalbum-e7k2m9qx-ec2' }, launchTime: '2026-10-14T01:00:00Z' },
        { ...base, instanceId: 'i-0aaaaaaaaaaaaaaa2', tags: { 'atl:role': 'lab-app', 'aws:autoscaling:groupName': 'cloudalbum-e7k2m9qx-autoscaling-Asg' }, launchTime: '2026-10-14T00:00:00Z' },
        { ...base, instanceId: 'i-0aaaaaaaaaaaaaaa3', tags: { 'atl:role': 'lab-app', 'aws:cloudformation:stack-name': 'my-own-stack' } },
        { ...base, instanceId: 'i-0aaaaaaaaaaaaaaa4', tags: { 'atl:role': 'workstation', 'aws:cloudformation:stack-name': 'atl-ws-s4k7m2q9x1abc' } },
        { ...base, instanceId: 'i-0aaaaaaaaaaaaaaa5', tags: { 'atl:role': 'workstation', 'aws:cloudformation:stack-name': 'atl-ws-s0000000000aa' } },
        { ...base, instanceId: 'i-0aaaaaaaaaaaaaaa6', state: 'stopped', tags: { 'atl:role': 'lab-app', 'aws:cloudformation:stack-name': 'cloudalbum-e7k2m9qx-ec2' } },
      ],
      { envName: 'e7k2m9qx', sid: 's4k7m2q9x1abc' },
    );
    expect(t.map((x) => `${x.role}:${x.instanceId}`)).toEqual(['workstation:i-0aaaaaaaaaaaaaaa4', 'lab:i-0aaaaaaaaaaaaaaa2', 'lab:i-0aaaaaaaaaaaaaaa1']);
  });

  it('ssm-client protocol version stays in sync', () => {
    const src = fs.readFileSync(path.join(REPO, 'platform/ssm-client/src/constants.ts'), 'utf8');
    expect(src).toContain(`PROTOCOL_COMPAT_VERSION = '${SSM_CLIENT_VERSION}'`);
  });
});

describe('console deep links (03 §5.4)', () => {
  it('the registry has every id the content lint knows', () => {
    const lint = fs.readFileSync(path.join(REPO, 'scripts/labs/src/console-links.ts'), 'utf8');
    const ids = [...lint.matchAll(/^\s+'([a-z0-9]+\.[A-Za-z]+)': \{ params/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(15);
    expect(Object.keys(CONSOLE_LINKS).sort()).toEqual([...ids].sort());
  });

  it('substitutes validated parameters, falls back to the service home, refuses foreign hosts', () => {
    expect(resolveConsoleLink('ec2.instance', REGION, { instanceId: 'i-0abc1234def567890' })).toEqual({
      url: `https://${REGION}.console.aws.amazon.com/ec2/home?region=${REGION}#InstanceDetails:instanceId=i-0abc1234def567890`,
      linkId: 'ec2.instance',
      fallback: false,
    });
    expect(resolveConsoleLink('ec2.instance', REGION, { instanceId: 'javascript:alert(1)' })).toMatchObject({ fallback: true, url: expect.stringContaining('#Instances:') });
    expect(resolveConsoleLink('nope', REGION)).toBeNull();
    expect(checkDestination(`https://${REGION}.console.aws.amazon.com/s3/home`, REGION)).toBeTruthy();
    expect(checkDestination('https://evil.example.com/', REGION)).toBeNull();
    expect(checkDestination('https://console.aws.amazon.com.evil.example/', REGION)).toBeNull();
    expect(checkDestination('http://console.aws.amazon.com/', REGION)).toBeNull();
    expect(allowedConsoleHosts(REGION).has('us-east-1.console.aws.amazon.com')).toBe(true);
  });
});

describe('preview probe (03 §6.1)', () => {
  it('address policy', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['54.12.34.56', '13.112.0.1', '2600:1f18::1']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('frame headers', () => {
    const o = 'https://d111abcdef8.cloudfront.net';
    expect(frameHeadersVerdict({ 'content-security-policy': `default-src 'self'; frame-ancestors 'self' ${o}` }, o)).toEqual({ embeddable: true, reason: null, probed: true });
    expect(frameHeadersVerdict({ 'content-security-policy': "frame-ancestors 'self'" }, o)).toMatchObject({ embeddable: false, reason: 'FRAME_ANCESTORS_MISSING' });
    expect(frameHeadersVerdict({}, o)).toMatchObject({ reason: 'FRAME_ANCESTORS_MISSING' });
    expect(frameHeadersVerdict({ 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': `frame-ancestors ${o}` }, o)).toMatchObject({ reason: 'X_FRAME_OPTIONS' });
    expect(frameHeadersVerdict({ 'content-security-policy': 'frame-ancestors https://*.cloudfront.net' }, o)).toMatchObject({ embeddable: true });
  });

  it('http is mixed content; names resolving to private addresses are never fetched', async () => {
    let resolved = 0;
    const probe = createHttpsProber({ resolve: async () => (resolved++, [{ address: '127.0.0.1', family: 4 }]) });
    expect(await probe('http://54.12.34.56', 'https://p.example')).toMatchObject({ reason: 'MIXED_CONTENT', probed: false });
    expect(await probe('https://rebind.example.com', 'https://p.example')).toMatchObject({ reason: 'UNREACHABLE', detail: 'the address is not a public address' });
    expect(await probe('https://10.0.0.5', 'https://p.example')).toMatchObject({ reason: 'UNREACHABLE' });
    expect(await probe('https://example.com:8443', 'https://p.example')).toMatchObject({ reason: 'UNREACHABLE', probed: false });
    expect(resolved).toBe(1);
  });

  it('entries from Environment.endpoints, de-duplicated', () => {
    expect(previewEntries({ baseUrl: 'http://54.1.2.3/', cdn: { baseUrl: 'https://d1.cloudfront.net' }, https: { trusted: false } }, { entryUrl: 'https://d1.cloudfront.net' })).toEqual([
      { id: 'direct', url: 'http://54.1.2.3', via: null },
      { id: 'cdn', url: 'https://d1.cloudfront.net', via: 'cloudfront' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Through the routes

interface Mocks {
  sts: ReturnType<typeof mockClient>;
  ec2: ReturnType<typeof mockClient>;
  ssm: ReturnType<typeof mockClient>;
  fetches: { url: string; body: string }[];
}

const EXPIRATION = new Date(Date.UTC(2026, 9, 14, 2, 0, 0));

function setupMocks(): Mocks {
  const sts = mockClient(STSClient);
  const ec2 = mockClient(EC2Client);
  const ssm = mockClient(SSMClient);
  mocks.push(sts, ec2, ssm);
  sts.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: 'ASIATEST', SecretAccessKey: 'secret', SessionToken: 'token', Expiration: EXPIRATION } });
  ssm.on(DescribeInstanceInformationCommand).callsFake((input: { Filters?: { Values?: string[] }[] }) => ({ InstanceInformationList: (input.Filters?.[0]?.Values ?? []).map((id) => ({ InstanceId: id, PingStatus: 'Online' })) }));
  ssm.on(StartSessionCommand).resolves({ SessionId: 'atl-s-term-0a1b2c3d', StreamUrl: `wss://ssmmessages.${REGION}.amazonaws.com/v1/data-channel/atl-s-term-0a1b2c3d?role=publish_subscribe&cell-number=1`, TokenValue: 'TOKEN-1' });
  ssm.on(ResumeSessionCommand).resolves({ SessionId: 'atl-s-term-0a1b2c3d', StreamUrl: `wss://ssmmessages.${REGION}.amazonaws.com/v1/data-channel/atl-s-term-0a1b2c3d?role=publish_subscribe`, TokenValue: 'TOKEN-2' });
  ssm.on(TerminateSessionCommand).resolves({ SessionId: 'atl-s-term-0a1b2c3d' });
  ssm.on(DescribeSessionsCommand).resolves({ Sessions: [] });
  ssm.on(GetParameterCommand).resolves({ Parameter: { Name: 'p', Value: 'Adm1n-Pass' } });
  return { sts, ec2, ssm, fetches: [] };
}

function instancesFor(envId: string, envName: string, sid: string) {
  return {
    Reservations: [
      {
        Instances: [
          { InstanceId: 'i-0abc1234def567890', State: { Name: 'running' }, LaunchTime: new Date('2026-10-14T00:30:00Z'), PublicIpAddress: '54.1.2.3', Tags: [{ Key: 'atl:env-id', Value: envId }, { Key: 'atl:role', Value: 'lab-app' }, { Key: 'aws:cloudformation:stack-name', Value: `cloudalbum-${envName}-ec2` }] },
          { InstanceId: 'i-0def1234abc567890', State: { Name: 'running' }, LaunchTime: new Date('2026-10-14T00:40:00Z'), Tags: [{ Key: 'atl:env-id', Value: envId }, { Key: 'atl:role', Value: 'workstation' }, { Key: 'aws:cloudformation:stack-name', Value: `atl-ws-${sid}` }] },
        ],
      },
    ],
  };
}

async function readySession(rt: ApiTestRuntime): Promise<{ sid: string; envId: string; envName: string }> {
  const q = body(await rt.api(ev('POST', `/api/v1/labs/${LAB_ID}/quotes`, { token: LEARNER, body: { purpose: 'START' } })));
  const s = body(await rt.api(ev('POST', '/api/v1/sessions', { token: LEARNER, body: { labId: LAB_ID, quoteId: q.quoteId, costAcknowledged: true } })));
  const sid = s.sessionId as string;
  await devAdvance(rt.deps, sid, 'PROVISIONING');
  const ready = await devAdvance(rt.deps, sid, 'READY');
  const env = await rt.repos.environments.get(String(ready.envId));
  return { sid, envId: env!.envId, envName: env!.envName };
}

describe('WorkspaceProvider through the API routes (aws-sdk-client-mock)', () => {
  let rt: ApiTestRuntime;
  let m: Mocks;
  let fetchImpl: typeof fetch;
  let federation: (url: string, body: string) => Response;
  let probeCalls: string[];

  beforeEach(async () => {
    m = setupMocks();
    federation = () => new Response(JSON.stringify({ SigninToken: 'SIGNIN-TOKEN' }), { status: 200, headers: { 'content-type': 'application/json' } });
    fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      m.fetches.push({ url: String(url), body: String(init?.body ?? '') });
      return federation(String(url), String(init?.body ?? ''));
    }) as typeof fetch;
    probeCalls = [];
    const probe: PreviewProber = async (url) => {
      probeCalls.push(url);
      return url.startsWith('https://') ? { embeddable: true, reason: null, probed: true } : { embeddable: false, reason: 'MIXED_CONTENT', probed: false };
    };
    const env = { ...rtEnv() };
    rt = await createApiTestRuntime({ ext: { workspace: createWorkspaceProvider({ access: createAwsWorkspaceAccess(env, { fetch: fetchImpl }), probe }) } });
    // the per-user minute caps live in a container-wide limiter shared by all tests of this file (0 = no cap)
    await rt.repos.platform.updateConfig({ rateLimits: { terminal: 0, consoleLink: 0 } }, undefined, new Date(rt.clock.nowMs()).toISOString());
  });

  function rtEnv() {
    return { region: REGION, accountId: ACCOUNT } as Parameters<typeof createAwsWorkspaceAccess>[0];
  }

  it('opens a terminal: AssumeRole atl-<sid>-term with policy, discovery, ping, StartSession ATL-SessionShell; records grant + terminal; events; audit', async () => {
    const { sid, envId, envName } = await readySession(rt);
    m.ec2.on(DescribeInstancesCommand).resolves(instancesFor(envId, envName, sid));
    const r = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab', cols: 120, rows: 30, clientId: 'tab-1' } }));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.headers?.['cache-control']).toBe('no-store');
    const b = body(r);
    expect(b).toMatchObject({
      instanceId: 'i-0abc1234def567890',
      ssmSessionId: 'atl-s-term-0a1b2c3d',
      tokenValue: 'TOKEN-1',
      document: 'ATL-SessionShell',
      runAs: 'labuser',
      idleTimeoutMin: 20,
      maxDurationMin: 240,
      clientVersion: SSM_CLIENT_VERSION,
      tab: 'terminal-lab',
    });
    expect(Date.parse(String(b.connectBy)) - rt.clock.nowMs()).toBe(30_000);
    const assume = m.sts.commandCalls(AssumeRoleCommand)[0]!.args[0].input;
    expect(assume).toMatchObject({ RoleArn: `arn:aws:iam::${ACCOUNT}:role/ATLLearnerRole`, RoleSessionName: `atl-${sid}-term`, SourceIdentity: 'u-learner' });
    expect(assume.DurationSeconds).toBeGreaterThanOrEqual(900);
    expect(JSON.parse(String(assume.Policy)).Statement[1].Condition.StringEquals['ssm:resourceTag/atl:env-id']).toBe(envId);
    expect(m.ec2.commandCalls(DescribeInstancesCommand)[0]!.args[0].input.Filters).toEqual([
      { Name: 'tag:atl:env-id', Values: [envId] },
      { Name: 'tag:atl:role', Values: ['lab-app'] },
      { Name: 'instance-state-name', Values: ['running'] },
    ]);
    expect(m.ssm.commandCalls(StartSessionCommand)[0]!.args[0].input).toEqual({ Target: 'i-0abc1234def567890', DocumentName: 'ATL-SessionShell', Reason: `ATL web terminal ${sid}` });
    const terms = (await rt.repos.sessions.children(sid, SkPrefix.terminal, { all: true })).items;
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ type: 'TerminalSession', status: 'OPEN', instanceId: 'i-0abc1234def567890', clientId: 'tab-1', openedBy: 'u-learner' });
    expect(JSON.stringify(terms[0])).not.toContain('TOKEN-1');
    const grants = (await rt.repos.sessions.children(sid, SkPrefix.credentialChannel('term'), { all: true })).items;
    expect(grants[0]).toMatchObject({ type: 'CredentialGrant', channel: 'term', roleSessionName: `atl-${sid}-term`, expiresAt: EXPIRATION.toISOString() });
    rt.clock.advance(5_000);
    const events = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events`, { token: LEARNER }))).events as { type: string }[];
    expect(events.some((e) => e.type === 'terminal.opened')).toBe(true);
    // the list route shows the record (no token)
    const list = body<{ terminalId: string }[]>(await rt.api(ev('GET', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER })));
    expect(list[0]!.terminalId).toBe(b.terminalId);
    // credentials are reused within the container (one AssumeRole) for the workstation terminal
    const ws = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'workstation' } }));
    expect(ws.statusCode, ws.body).toBe(201);
    expect(body(ws).instanceId).toBe('i-0def1234abc567890');
    expect(m.sts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });

  it('recording=cloudwatch uses ATL-SessionShell-Logged', async () => {
    const { sid, envId, envName } = await readySession(rt);
    await rt.repos.platform.updateConfig({ terminal: { recording: 'cloudwatch' } }, undefined, new Date(rt.clock.nowMs()).toISOString());
    m.ec2.on(DescribeInstancesCommand).resolves(instancesFor(envId, envName, sid));
    const r = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } }));
    expect(body(r)).toMatchObject({ document: 'ATL-SessionShell-Logged', recording: true });
  });

  it('refusals: foreign instance 404, offline 409, StartSession TargetNotConnected 409, limit 429, bad StreamUrl 503', async () => {
    const { sid, envId, envName } = await readySession(rt);
    m.ec2.on(DescribeInstancesCommand).resolves(instancesFor(envId, envName, sid));
    const open = (b: Record<string, unknown>) => rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: b }));
    expect(body(await open({ target: 'lab', instanceId: 'i-0fffffffffffffff0' }))).toMatchObject({ status: 404, code: 'TERMINAL_TARGET_NOT_IN_SESSION' });
    m.ssm.on(DescribeInstanceInformationCommand).resolves({ InstanceInformationList: [{ InstanceId: 'i-0abc1234def567890', PingStatus: 'ConnectionLost' }] });
    expect(body(await open({ target: 'lab' }))).toMatchObject({ status: 409, code: 'TERMINAL_TARGET_NOT_CONNECTED', pingStatus: 'ConnectionLost' });
    m.ssm.on(DescribeInstanceInformationCommand).callsFake((input: { Filters?: { Values?: string[] }[] }) => ({ InstanceInformationList: (input.Filters?.[0]?.Values ?? []).map((id) => ({ InstanceId: id, PingStatus: 'Online' })) }));
    let start: 'not-connected' | 'evil-url' | 'ok' = 'not-connected';
    m.ssm.on(StartSessionCommand).callsFake(() => {
      if (start === 'not-connected') throw named('TargetNotConnected');
      if (start === 'evil-url') return { SessionId: 'atl-x-term-1', StreamUrl: 'wss://evil.example.com/v1/data-channel/x', TokenValue: 't' };
      return { SessionId: 'atl-s-term-z', StreamUrl: `wss://ssmmessages.${REGION}.amazonaws.com/v1/data-channel/z`, TokenValue: 't' };
    });
    expect(body(await open({ target: 'lab' }))).toMatchObject({ code: 'TERMINAL_TARGET_NOT_CONNECTED' });
    start = 'evil-url';
    expect(body(await open({ target: 'lab' }))).toMatchObject({ status: 503, code: 'UPSTREAM_UNAVAILABLE', reason: 'STREAM_URL_REJECTED' });
    expect(m.ssm.commandCalls(TerminateSessionCommand).at(-1)!.args[0].input).toEqual({ SessionId: 'atl-x-term-1' });
    start = 'ok';
    for (let i = 0; i < 3; i++) expect((await open({ target: 'lab' })).statusCode).toBe(201);
    expect(body(await open({ target: 'lab' }))).toMatchObject({ status: 429, code: 'TERMINAL_LIMIT', onInstance: 3 });
    // the workstation still has room (per-instance limit), the session limit is 6
    for (let i = 0; i < 3; i++) expect((await open({ target: 'workstation' })).statusCode).toBe(201);
    expect(body(await open({ target: 'workstation' }))).toMatchObject({ code: 'TERMINAL_LIMIT' });
  });

  it('reconciliation closes stale entries SSM no longer has before counting (03 §3.2 step 2)', async () => {
    const { sid, envId, envName } = await readySession(rt);
    m.ec2.on(DescribeInstancesCommand).resolves(instancesFor(envId, envName, sid));
    for (let i = 0; i < 3; i++) expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } }))).statusCode).toBe(201);
    rt.clock.advance(26 * 60_000);
    const r = await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } }));
    expect(r.statusCode, r.body).toBe(201);
    expect(m.ssm.commandCalls(DescribeSessionsCommand)[0]!.args[0].input).toMatchObject({ State: 'Active', Filters: [{ key: 'Owner', value: `arn:aws:sts::${ACCOUNT}:assumed-role/ATLLearnerRole/atl-${sid}-term` }] });
    const terms = (await rt.repos.sessions.children(sid, SkPrefix.terminal, { all: true })).items;
    expect(terms.filter((t) => t.status === 'CLOSED' && t.closeReason === 'reconciled')).toHaveLength(3);
  });

  it('resume, gone, close (idempotent)', async () => {
    const { sid, envId, envName } = await readySession(rt);
    m.ec2.on(DescribeInstancesCommand).resolves(instancesFor(envId, envName, sid));
    const t = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } })));
    const resume = () => rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals/${t.terminalId}/resume`, { token: LEARNER, body: { clientId: 'tab-2' } }));
    const r1 = await resume();
    expect(r1.statusCode, r1.body).toBe(200);
    expect(body(r1)).toMatchObject({ terminalId: t.terminalId, tokenValue: 'TOKEN-2', clientVersion: SSM_CLIENT_VERSION });
    expect(m.ssm.commandCalls(ResumeSessionCommand)[0]!.args[0].input).toEqual({ SessionId: 'atl-s-term-0a1b2c3d' });
    expect(await rt.repos.sessions.getChild(Keys.terminalSession(sid, String(t.terminalId)))).toMatchObject({ resumeCount: 1, clientId: 'tab-2' });
    m.ssm.on(ResumeSessionCommand).rejects(named('DoesNotExistException'));
    expect(body(await resume())).toMatchObject({ status: 409, code: 'TERMINAL_GONE' });
    expect(body(await resume())).toMatchObject({ code: 'TERMINAL_GONE' });
    expect((await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals/01JA3P0A1B2C3D4E5F6G7H8J9K/resume`, { token: LEARNER, body: {} }))).statusCode).toBe(404);
    const t2 = body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } })));
    const del = await rt.api(ev('DELETE', `/api/v1/sessions/${sid}/terminals/${t2.terminalId}`, { token: LEARNER }));
    expect(del.statusCode).toBe(204);
    expect(m.ssm.commandCalls(TerminateSessionCommand)).toHaveLength(1);
    expect(await rt.repos.sessions.getChild(Keys.terminalSession(sid, String(t2.terminalId)))).toMatchObject({ status: 'CLOSED', closeReason: 'user' });
    expect((await rt.api(ev('DELETE', `/api/v1/sessions/${sid}/terminals/${t2.terminalId}`, { token: LEARNER }))).statusCode).toBe(204);
    rt.clock.advance(5_000);
    const events = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events`, { token: LEARNER }))).events as { type: string }[];
    expect(events.filter((e) => e.type === 'terminal.closed').length).toBeGreaterThanOrEqual(1);
  });

  it('gates of the route layer: access state, recent login, role', async () => {
    const { sid } = await readySession(rt);
    const old = devToken('learner', 'u-learner', Math.floor(rt.clock.nowMs() / 1000) - 3700);
    expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: old, body: { target: 'lab' } })))).toMatchObject({ status: 403, code: 'REAUTH_REQUIRED' });
    expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: OBSERVER, body: { target: 'lab' } })))).toMatchObject({ status: 403, code: 'FORBIDDEN_ROLE' });
    await devAdvance(rt.deps, sid, 'ENDING');
    expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/terminals`, { token: LEARNER, body: { target: 'lab' } })))).toMatchObject({ status: 409, code: 'TERMINAL_SESSION_STATE' });
    expect(body(await rt.api(ev('POST', `/api/v1/sessions/${sid}/console-link`, { token: LEARNER, body: {} })))).toMatchObject({ status: 409, code: 'CONSOLE_SESSION_STATE' });
    expect(m.sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('console link: atl-<sid>-console without DurationSeconds / policy, regional endpoint then global, POST form, deep link', async () => {
    const { sid } = await readySession(rt);
    federation = (url) => (url.startsWith(`https://${REGION}.`) ? new Response('nope', { status: 500 }) : new Response(JSON.stringify({ SigninToken: 'SIGNIN-TOKEN' }), { status: 200 }));
    const r = await rt.api(ev('POST', `/api/v1/sessions/${sid}/console-link`, { token: LEARNER, body: { linkId: 's3.bucket', params: { bucket: 'cloudalbum-e7k2m9qx-storage-raw' } } }));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers?.['cache-control']).toBe('no-store');
    const b = body(r);
    const assume = m.sts.commandCalls(AssumeRoleCommand)[0]!.args[0].input;
    expect(assume).toEqual({ RoleArn: `arn:aws:iam::${ACCOUNT}:role/ATLLearnerRole`, RoleSessionName: `atl-${sid}-console`, SourceIdentity: 'u-learner' });
    expect(m.fetches.map((f) => f.url)).toEqual([`https://${REGION}.signin.aws.amazon.com/federation`, 'https://signin.aws.amazon.com/federation']);
    const sent = new URLSearchParams(m.fetches[1]!.body);
    expect(sent.get('Action')).toBe('getSigninToken');
    expect(sent.has('SessionDuration')).toBe(false);
    expect(JSON.parse(sent.get('Session')!)).toEqual({ sessionId: 'ASIATEST', sessionKey: 'secret', sessionToken: 'token' });
    expect(b).toMatchObject({
      form: { action: 'https://signin.aws.amazon.com/federation', method: 'POST', fields: { Action: 'login', SigninToken: 'SIGNIN-TOKEN', Destination: `https://s3.console.aws.amazon.com/s3/buckets/cloudalbum-e7k2m9qx-storage-raw?region=${REGION}&tab=objects`, Issuer: `https://d1234.cloudfront.net/workspace/${sid}?from=console` } },
      consoleSessionExpiresAt: EXPIRATION.toISOString(),
      roleSessionName: `atl-${sid}-console`,
      linkId: 's3.bucket',
    });
    expect(String(b.url).startsWith('https://signin.aws.amazon.com/federation?Action=login&')).toBe(true);
    expect(Date.parse(String(b.expiresAt)) - rt.clock.nowMs()).toBe(15 * 60_000);
    const grants = (await rt.repos.sessions.children(sid, SkPrefix.credentialChannel('console'), { all: true })).items;
    expect(grants[0]).toMatchObject({ channel: 'console', roleSessionName: `atl-${sid}-console` });
    expect(JSON.stringify(grants)).not.toContain('SIGNIN-TOKEN');
    rt.clock.advance(5_000);
    const events = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/events`, { token: LEARNER }))).events as { type: string; data: Record<string, unknown> }[];
    expect(events.find((e) => e.type === 'console_link.issued')?.data).toMatchObject({ linkId: 's3.bucket' });
    // workspace descriptor reflects the issue
    const w = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/workspace`, { token: LEARNER })));
    expect((w.console as Record<string, unknown>).lastIssuedAt).toBeTruthy();
  });

  it('console link refusals: foreign destination 422, unknown linkId 422, federation down 503', async () => {
    const { sid } = await readySession(rt);
    const link = (b: Record<string, unknown>) => rt.api(ev('POST', `/api/v1/sessions/${sid}/console-link`, { token: LEARNER, body: b }));
    expect(body(await link({ destination: 'https://evil.example.com/' }))).toMatchObject({ status: 422, code: 'CONSOLE_DESTINATION_NOT_ALLOWED' });
    expect(body(await link({ linkId: 'nope.nope' }))).toMatchObject({ status: 422, code: 'CONSOLE_DESTINATION_NOT_ALLOWED' });
    federation = () => new Response('down', { status: 503 });
    expect(body(await link({}))).toMatchObject({ status: 503, code: 'CONSOLE_FEDERATION_FAILED' });
    const ok = await (async () => {
      federation = () => new Response(JSON.stringify({ SigninToken: 'S' }), { status: 200 });
      return body(await link({ destination: `https://${REGION}.console.aws.amazon.com/ec2/home?region=${REGION}` }));
    })();
    expect(ok.deepLink).toBe(`https://${REGION}.console.aws.amazon.com/ec2/home?region=${REGION}`);
  });

  it('app credentials: GetParameter WithDecryption with the function role; not written yet → 404', async () => {
    const { sid, envName } = await readySession(rt);
    const r = await rt.api(ev('GET', `/api/v1/sessions/${sid}/app-credentials`, { token: LEARNER }));
    expect(r.statusCode, r.body).toBe(200);
    expect(body(r)).toEqual({ username: 'atl-admin@example.com', password: 'Adm1n-Pass', loginUrl: 'http://127.0.0.1:8080', envName });
    expect(m.ssm.commandCalls(GetParameterCommand)[0]!.args[0].input).toEqual({ Name: `/cloudalbum/${envName}/atl/app-admin-password`, WithDecryption: true });
    m.ssm.on(GetParameterCommand).rejects(named('ParameterNotFound'));
    expect(body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/app-credentials`, { token: LEARNER })))).toMatchObject({ status: 404 });
    const audit = await rt.repos.audit.bySession(sid);
    expect(audit.some((a) => a.action === 'app_credentials.reveal')).toBe(true);
  });

  it('preview: entries with reasons; default is the first embeddable', async () => {
    const { sid, envId } = await readySession(rt);
    await rt.repos.table.update(Keys.environment(envId), { set: { endpoints: { baseUrl: 'http://54.1.2.3', cdn: { baseUrl: 'https://d1.cloudfront.net' }, https: { trusted: false } } } });
    const p = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/preview`, { token: OBSERVER })));
    expect(p).toMatchObject({
      available: true,
      default: 'cdn',
      targets: [
        { id: 'direct', url: 'http://54.1.2.3', embeddable: false, reason: 'MIXED_CONTENT' },
        { id: 'cdn', url: 'https://d1.cloudfront.net', embeddable: true, reason: null, via: 'cloudfront' },
      ],
    });
    expect(probeCalls).toEqual(['http://54.1.2.3', 'https://d1.cloudfront.net']);
  });

  it('GET /workspace: live targets (ping, identities); discovery failures fall back to the cached instances', async () => {
    const { sid, envId, envName } = await readySession(rt);
    m.ec2.on(DescribeInstancesCommand).resolves(instancesFor(envId, envName, sid));
    const w = body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/workspace`, { token: LEARNER })));
    expect(w.targets).toEqual([
      expect.objectContaining({ tab: 'terminal-lab', instanceId: 'i-0abc1234def567890', primary: true, ssmPing: 'Online', awsIdentity: 'CloudAlbumAppRole', placement: 'public', cached: false }),
      expect.objectContaining({ tab: 'terminal-workstation', instanceId: 'i-0def1234abc567890', awsIdentity: `ATLLearnerRole (atl-${sid}-ws)` }),
    ]);
    expect((w.console as { links: unknown[] }).links).toEqual([{ linkId: 'sqs.queues', label: null, registered: false }]);
    // observers never cause an AssumeRole (01 §5.2): they get the cached instances
    const assumes = m.sts.commandCalls(AssumeRoleCommand).length;
    expect(body(await rt.api(ev('GET', `/api/v1/sessions/${sid}/workspace`, { token: OBSERVER }))).targets).toEqual([]);
    expect(m.sts.commandCalls(AssumeRoleCommand)).toHaveLength(assumes);
    m.ec2.on(DescribeInstancesCommand).rejects(named('UnauthorizedOperation'));
    rt.clock.advance(1000);
    const w2 = await rt.api(ev('GET', `/api/v1/sessions/${sid}/workspace`, { token: LEARNER }));
    expect(w2.statusCode).toBe(200);
    expect(body(w2).targets).toEqual([]);
  });
});
