/**
 * atl-agent-call (03 §4.6 step 2): agent routes only, SigV4 for execute-api in the endpoint's region, retries with
 * 2/4/8/16/30 s back-off on network / 5xx / credential errors, exit 3 for 403 / 409, exit 4 when retries run out.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentApiFromEnvFile, callAgent, RETRY_DELAYS_SECONDS, regionOfEndpoint, UsageError, validateRequest, type AgentCallDeps } from '../src/agent-call.js';

const ENDPOINT = 'https://a1b2c3d4e5.execute-api.ap-northeast-1.amazonaws.com';
const PATH = '/api/v1/agent/sessions/s4k7m2q9x1abc/context';

function fakeDeps(responses: (number | 'throw' | 'creds')[]) {
  let t = 0;
  const calls: { url: string; headers: Record<string, string>; region: string }[] = [];
  const sleeps: number[] = [];
  const deps: AgentCallDeps = {
    async sign({ url, headers, region }) {
      const next = responses[calls.length];
      calls.push({ url: url.toString(), headers, region });
      if (next === 'creds') throw Object.assign(new Error('User: ... is not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' });
      return { ...headers, authorization: 'AWS4-HMAC-SHA256 Credential=…' };
    },
    async fetch() {
      const next = responses[calls.length - 1];
      if (next === 'throw') throw new Error('ECONNRESET');
      return { status: next as number, text: async () => (next === 200 ? '{"schema":"atl.agent-context/v1"}' : '{"code":"X"}') };
    },
    async sleep(ms) {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    log: () => undefined,
  };
  return { deps, calls, sleeps };
}

describe('atl-agent-call', () => {
  it('signs for execute-api in the endpoint region and returns the body', async () => {
    const { deps, calls } = fakeDeps([200]);
    const r = await callAgent({ endpoint: ENDPOINT, method: 'GET', path: PATH }, deps);
    expect(r).toMatchObject({ exitCode: 0, status: 200, attempts: 1 });
    expect(calls[0]).toMatchObject({ url: ENDPOINT + PATH, region: 'ap-northeast-1' });
    expect(calls[0]!.headers.host).toBe('a1b2c3d4e5.execute-api.ap-northeast-1.amazonaws.com');
  });

  it('retries network errors, 5xx and credential errors (IAM tag propagation) with the 03 §4.6 back-off', async () => {
    const { deps, sleeps } = fakeDeps(['creds', 'throw', 503, 200]);
    const r = await callAgent({ endpoint: ENDPOINT, method: 'GET', path: PATH }, deps);
    expect(r.exitCode).toBe(0);
    expect(r.attempts).toBe(4);
    expect(sleeps).toEqual([2000, 4000, 8000]);
  });

  it('403 and 409 are not retried (exit 3)', async () => {
    for (const status of [403, 409]) {
      const { deps, sleeps } = fakeDeps([status]);
      const r = await callAgent({ endpoint: ENDPOINT, method: 'GET', path: PATH }, deps);
      expect(r).toMatchObject({ exitCode: 3, status, attempts: 1 });
      expect(sleeps).toEqual([]);
    }
  });

  it('gives up with exit 4 after the last back-off', async () => {
    const { deps, sleeps } = fakeDeps(Array(10).fill(503));
    const r = await callAgent({ endpoint: ENDPOINT, method: 'GET', path: PATH }, deps);
    expect(r.exitCode).toBe(4);
    expect(sleeps).toEqual(RETRY_DELAYS_SECONDS.map((s) => s * 1000));
    expect(r.attempts).toBe(RETRY_DELAYS_SECONDS.length + 1);
  });

  it('sends Idempotency-Key and JSON bodies for POST / PUT', async () => {
    const { deps, calls } = fakeDeps([201]);
    await callAgent({ endpoint: ENDPOINT, method: 'PUT', path: '/api/v1/agent/sessions/s4k7m2q9x1abc/experiment-runs/01J/result', body: '{}', idempotencyKey: 'k1' }, deps);
    expect(calls[0]!.headers).toMatchObject({ 'idempotency-key': 'k1', 'content-type': 'application/json' });
  });

  it('only talks to execute-api endpoints and agent routes', () => {
    expect(regionOfEndpoint(`${ENDPOINT}/`)).toBe('ap-northeast-1');
    expect(() => regionOfEndpoint('https://d1234.cloudfront.net')).toThrow(UsageError);
    expect(() => validateRequest({ endpoint: ENDPOINT, method: 'GET', path: '/api/v1/internal/runs/x/events' })).toThrow(UsageError);
    expect(() => validateRequest({ endpoint: ENDPOINT, method: 'GET', path: '/api/v1/sessions' })).toThrow(UsageError);
    expect(() => validateRequest({ endpoint: ENDPOINT, method: 'TRACE', path: PATH })).toThrow(UsageError);
    expect(() => validateRequest({ endpoint: ENDPOINT, method: 'PUT', path: '/api/v1/agent-fallback/runs/01J/result' })).not.toThrow();
  });

  it('reads ATL_AGENT_API from session.env', () => {
    expect(agentApiFromEnvFile(`ATL_SESSION_ID='s4k7m2q9x1abc'\nATL_AGENT_API='${ENDPOINT}'\n`)).toBe(ENDPOINT);
    expect(agentApiFromEnvFile('X=1\n')).toBeNull();
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hasBash = spawnSync('bash', ['--version']).status === 0;
describe('workstation scripts', () => {
  it.skipIf(!hasBash)('bin/* and bootstrap/*.sh are valid bash', () => {
    for (const f of ['bin/atl-workstation-setup.sh', 'bin/atl-credentials', 'bin/atl-lab-proxy', 'bootstrap/user-data.sh', 'bootstrap/profile.d-atl.sh']) {
      const r = spawnSync('bash', ['-n', path.join(HERE, '..', f)], { encoding: 'utf8' });
      expect(r.stderr, f).toBe('');
      expect(r.status, f).toBe(0);
    }
  });
});
