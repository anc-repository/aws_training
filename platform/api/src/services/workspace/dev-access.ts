/**
 * Dev-mode `WorkspaceAccess` (ATL_DEV_MODE=1, `npm run platform:dev`): no AWS.
 *
 * - SSM: the local mock Session Manager of `@atl/ssm-client` (`platform/ssm-client/src/mock`, started by the dev server
 *   or `npm run mock -w @atl/ssm-client`) through its HTTP control interface (`POST /StartSession`, `/ResumeSession`,
 *   `/TerminateSession`, `GET /sessions`); the browser connects to the `ws://127.0.0.1:<port>/v1/data-channel/…`
 *   StreamUrl it returns with the real protocol client.
 * - STS: fake learner credentials (`ASIADEV…`), valid for the requested duration (1 h without one).
 * - Federation: the local stub `dev-federation.ts` served by the dev server at `/__dev/federation`.
 * - Instances: the dev environment's stand-in ids (`i-dev-<envName>-lab` / `-ws`) with the tags the real discovery
 *   checks; always `Online`. They are shown to the API (and the browser) as EC2-shaped aliases (`i-0` + 16 hex digits of
 *   their SHA-256), because the terminal request validates `instanceId` like a real one (e2e:platform found this).
 * - CloudAlbum admin: the local L0's `etc/atl/app-admin-password` (`local-l0` runner mode), else a dev password kept in
 *   `<dataDir>/workspace/` (stand-in for the SSM parameter the runner writes).
 * Only the dev runtime imports this module.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AtlError, StackNames } from '@atl/shared';
import type { InstanceFacts, LearnerCredentials, SsmSessionGrant, WorkspaceAccess } from './access.js';

export interface DevWorkspaceAccessOptions {
  /** Base URL of the mock SSM control interface, e.g. `http://127.0.0.1:8790`. */
  ssmMockUrl: string;
  /** The dev federation stub, e.g. `http://127.0.0.1:8787/__dev/federation`. */
  federationUrl: string;
  dataDir: string;
  nowMs: () => number;
  /** Dev environment registry (local L0 directory, stand-in instance ids). */
  envs?: { get(envId: string): { envName: string; root: string | null; instances: { lab: string; workstation: string } } | null };
  fetch?: typeof fetch;
}

/** EC2-shaped alias of a dev stand-in instance id (`^i-[0-9a-f]{8,17}$`, what the API validates). */
export function devInstanceAlias(id: string): string {
  return /^i-[0-9a-f]{8,17}$/.test(id) ? id : `i-0${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export function createDevWorkspaceAccess(o: DevWorkspaceAccessOptions): WorkspaceAccess {
  const f = o.fetch ?? globalThis.fetch;
  const base = o.ssmMockUrl.replace(/\/+$/, '');

  async function mock<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await f(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    } catch (e) {
      throw new AtlError('UPSTREAM_UNAVAILABLE', `dev: the SSM mock server is not reachable at ${base} (${e instanceof Error ? e.message : String(e)}); start it with npm run mock -w @atl/ssm-client`, { retryAfterSeconds: 5 });
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw named(String(data.__type ?? 'MockSsmError'), String(data.message ?? `mock answered ${res.status}`));
    return data as T;
  }

  return {
    kind: 'dev',
    allowLoopbackStreamUrl: true,

    async assumeLearner(input): Promise<LearnerCredentials> {
      const secs = input.durationSeconds ?? 3600;
      return {
        accessKeyId: `ASIADEV${randomBytes(6).toString('hex').toUpperCase()}`,
        secretAccessKey: randomBytes(20).toString('base64url'),
        sessionToken: `dev-session-token.${input.roleSessionName}.${randomBytes(12).toString('base64url')}`,
        expiration: new Date(o.nowMs() + secs * 1000).toISOString(),
      };
    },

    async describeInstances(_creds, q): Promise<InstanceFacts[]> {
      const rec = o.envs?.get(q.envId) ?? null;
      const dev = rec?.instances ?? { lab: `i-dev-${q.envName}-lab`, workstation: `i-dev-${q.envName}-ws` };
      const ids = { lab: devInstanceAlias(dev.lab), workstation: devInstanceAlias(dev.workstation) };
      const out: InstanceFacts[] = [];
      const launch = new Date(o.nowMs() - 600_000).toISOString();
      if (q.roles.includes('lab-app')) {
        out.push({ instanceId: ids.lab, state: 'running', launchTime: launch, privateIp: '10.0.0.10', publicIp: '203.0.113.10', tags: { 'atl:env-id': q.envId, 'atl:role': 'lab-app', 'aws:cloudformation:stack-name': StackNames.base(q.envName) } });
      }
      if (q.roles.includes('workstation')) {
        out.push({ instanceId: ids.workstation, state: 'running', launchTime: launch, privateIp: '10.0.0.20', publicIp: null, tags: { 'atl:env-id': q.envId, 'atl:role': 'workstation', 'aws:cloudformation:stack-name': StackNames.workstation(q.sid) } });
      }
      return out;
    },

    async pingStatus(_creds, instanceIds) {
      return Object.fromEntries(instanceIds.map((id) => [id, 'Online']));
    },

    async startSession(_creds, input): Promise<SsmSessionGrant> {
      const r = await mock<{ SessionId: string; StreamUrl: string; TokenValue: string }>('POST', '/StartSession', {
        Target: input.target,
        DocumentName: input.documentName,
        Reason: input.reason,
        sessionName: input.sessionName,
        role: input.role,
      });
      return { sessionId: r.SessionId, streamUrl: r.StreamUrl, tokenValue: r.TokenValue };
    },

    async resumeSession(_creds, sessionId): Promise<SsmSessionGrant> {
      const r = await mock<{ SessionId: string; StreamUrl: string; TokenValue: string }>('POST', '/ResumeSession', { SessionId: sessionId });
      return { sessionId: r.SessionId, streamUrl: r.StreamUrl, tokenValue: r.TokenValue };
    },

    async terminateSession(_creds, sessionId) {
      await mock('POST', '/TerminateSession', { SessionId: sessionId }).catch((e: unknown) => {
        if ((e as { name?: string }).name !== 'DoesNotExistException') throw e;
      });
    },

    async activeSessionIds(_creds, q) {
      const prefix = q.ownerArn.slice(q.ownerArn.lastIndexOf('/') + 1);
      const r = await mock<{ sessions?: { sessionId: string; status: string }[] }>('GET', '/sessions');
      return new Set((r.sessions ?? []).filter((s) => s.status !== 'Terminated' && s.sessionId.startsWith(prefix)).map((s) => s.sessionId));
    },

    federationEndpoints() {
      return [o.federationUrl];
    },

    async getSigninToken(endpoint, creds) {
      const res = await f(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Action: 'getSigninToken', Session: JSON.stringify({ sessionId: creds.accessKeyId, sessionKey: creds.secretAccessKey, sessionToken: creds.sessionToken }) }).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as { SigninToken?: string };
      if (!res.ok || !body.SigninToken) throw named('FederationError', `dev federation stub answered ${res.status}`);
      return body.SigninToken;
    },

    async appAdmin(q) {
      const rec = o.envs?.get(q.envId) ?? null;
      const l0 = rec?.root ? path.join(rec.root, 'etc', 'atl', 'app-admin-password') : null;
      if (l0 && fs.existsSync(l0)) return { username: `atl-admin@${q.envName}.example.test`, password: fs.readFileSync(l0, 'utf8').trim() };
      const dir = path.join(o.dataDir, 'workspace');
      const file = path.join(dir, `${q.envName}-app-admin-password`);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `${randomBytes(18).toString('base64url')}\n`, { mode: 0o600 });
      }
      return { username: 'atl-admin@example.com', password: fs.readFileSync(file, 'utf8').trim() };
    },
  };
}
