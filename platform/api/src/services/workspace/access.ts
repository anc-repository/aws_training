/**
 * What the workspace provider needs from AWS (03 §3.2, §5.2, §6.1, 01 §8.2 app-credentials), as one port so the dev
 * runtime can answer it locally (`dev.ts`: the @atl/ssm-client mock service and a local federation stub).
 *
 * Production (`createAwsWorkspaceAccess`): STS `AssumeRole` into `ATLLearnerRole` with the function role; EC2 / SSM
 * calls with the **learner's** credentials (03 §9.4: `ATLApiFunctionRole` itself needs no SSM / EC2 permission); the
 * federation endpoint over HTTPS; `ssm:GetParameter` (function role) for the CloudAlbum admin password only.
 */
import { AtlError, SsmParams, type RoleName } from '@atl/shared';
import type { PlatformEnv } from '../../runtime/env.js';

export interface LearnerCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO time the credentials expire (STS `Expiration`). */
  expiration: string;
}

export interface AssumeLearnerInput {
  roleSessionName: string;
  sourceIdentity: string;
  /** Inline session policy (JSON). */
  policy?: string;
  /** Omitted for the console channel (03 §5.3: role chaining + DurationSeconds breaks the federation endpoint). */
  durationSeconds?: number;
}

export interface InstanceFacts {
  instanceId: string;
  state: string;
  tags: Record<string, string>;
  launchTime: string | null;
  privateIp: string | null;
  publicIp: string | null;
}

export interface SsmSessionGrant {
  sessionId: string;
  streamUrl: string;
  tokenValue: string;
}

export interface WorkspaceAccess {
  readonly kind: 'aws' | 'dev';
  /** StreamUrl acceptance (03 §3.2 step 8): `wss://ssmmessages.<region>.amazonaws.com…`; dev also accepts `ws://127.0.0.1`. */
  readonly allowLoopbackStreamUrl: boolean;
  assumeLearner(input: AssumeLearnerInput): Promise<LearnerCredentials>;
  /** Running instances tagged `atl:env-id=<envId>` and `atl:role ∈ roles`. Dev receives the session context. */
  describeInstances(creds: LearnerCredentials, q: { envId: string; envName: string; sid: string; roles: readonly string[] }): Promise<InstanceFacts[]>;
  /** `ssm:DescribeInstanceInformation` → PingStatus per instance (missing = not registered). */
  pingStatus(creds: LearnerCredentials, instanceIds: readonly string[]): Promise<Record<string, string>>;
  startSession(creds: LearnerCredentials, input: { target: string; documentName: string; reason: string; sessionName: string; role: 'lab' | 'workstation' }): Promise<SsmSessionGrant>;
  /** Throws an error named `DoesNotExistException` for a terminated / unknown session. */
  resumeSession(creds: LearnerCredentials, sessionId: string): Promise<SsmSessionGrant>;
  terminateSession(creds: LearnerCredentials, sessionId: string): Promise<void>;
  /** Ids of the Active SSM sessions owned by this role session (reconciliation, 03 §3.2 step 2). */
  activeSessionIds(creds: LearnerCredentials, q: { ownerArn: string }): Promise<Set<string>>;
  /** Federation endpoints to try in order (regional, then global; 03 §5.2). */
  federationEndpoints(region: string): string[];
  getSigninToken(endpoint: string, creds: LearnerCredentials): Promise<string>;
  /** CloudAlbum administrator of the environment (`/cloudalbum/<envName>/atl/app-admin-password`); null when not written yet. */
  appAdmin(q: { envId: string; envName: string }): Promise<{ username: string; password: string } | null>;
}

export const LEARNER_ROLE: RoleName = 'ATLLearnerRole';

/** 06 PM-46: the runner creates the administrator with this reserved address. */
export const APP_ADMIN_USERNAME = 'atl-admin@example.com';

export function learnerRoleArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:role/${LEARNER_ROLE}`;
}

export function assumedRoleArn(accountId: string, roleSessionName: string): string {
  return `arn:aws:sts::${accountId}:assumed-role/${LEARNER_ROLE}/${roleSessionName}`;
}

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

/** Production access through the AWS SDK (all clients loaded lazily; credentials of the assumed learner session). */
export function createAwsWorkspaceAccess(env: PlatformEnv, opts: { fetch?: typeof fetch } = {}): WorkspaceAccess {
  const region = env.region;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const credsOf = (c: LearnerCredentials) => ({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, expiration: new Date(c.expiration) });
  let sts: import('@aws-sdk/client-sts').STSClient | null = null;
  return {
    kind: 'aws',
    allowLoopbackStreamUrl: false,

    async assumeLearner(input) {
      const m = await import('@aws-sdk/client-sts');
      sts ??= new m.STSClient({ region });
      const out = await sts.send(
        new m.AssumeRoleCommand({
          RoleArn: learnerRoleArn(env.accountId),
          RoleSessionName: input.roleSessionName,
          SourceIdentity: input.sourceIdentity,
          ...(input.policy ? { Policy: input.policy } : {}),
          ...(input.durationSeconds ? { DurationSeconds: input.durationSeconds } : {}),
        }),
      );
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new AtlError('UPSTREAM_UNAVAILABLE', 'STS AssumeRole returned no credentials');
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: new Date(c.Expiration).toISOString() };
    },

    async describeInstances(creds, q) {
      const m = await import('@aws-sdk/client-ec2');
      const ec2 = new m.EC2Client({ region, credentials: credsOf(creds) });
      const out: InstanceFacts[] = [];
      let token: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await ec2.send(
          new m.DescribeInstancesCommand({
            Filters: [
              { Name: 'tag:atl:env-id', Values: [q.envId] },
              { Name: 'tag:atl:role', Values: [...q.roles] },
              { Name: 'instance-state-name', Values: ['running'] },
            ],
            ...(token ? { NextToken: token } : {}),
          }),
        );
        for (const res of r.Reservations ?? []) {
          for (const i of res.Instances ?? []) {
            if (!i.InstanceId) continue;
            out.push({
              instanceId: i.InstanceId,
              state: i.State?.Name ?? 'unknown',
              tags: Object.fromEntries((i.Tags ?? []).filter((t) => t.Key).map((t) => [t.Key!, t.Value ?? ''])),
              launchTime: i.LaunchTime ? new Date(i.LaunchTime).toISOString() : null,
              privateIp: i.PrivateIpAddress ?? null,
              publicIp: i.PublicIpAddress ?? null,
            });
          }
        }
        token = r.NextToken;
        if (!token) break;
      }
      return out;
    },

    async pingStatus(creds, instanceIds) {
      if (!instanceIds.length) return {};
      const m = await import('@aws-sdk/client-ssm');
      const ssm = new m.SSMClient({ region, credentials: credsOf(creds) });
      const r = await ssm.send(new m.DescribeInstanceInformationCommand({ Filters: [{ Key: 'InstanceIds', Values: [...instanceIds] }] }));
      return Object.fromEntries((r.InstanceInformationList ?? []).filter((i) => i.InstanceId).map((i) => [i.InstanceId!, i.PingStatus ?? 'Unknown']));
    },

    async startSession(creds, input) {
      const m = await import('@aws-sdk/client-ssm');
      const ssm = new m.SSMClient({ region, credentials: credsOf(creds) });
      const r = await ssm.send(new m.StartSessionCommand({ Target: input.target, DocumentName: input.documentName, Reason: input.reason }));
      if (!r.SessionId || !r.StreamUrl || !r.TokenValue) throw new AtlError('UPSTREAM_UNAVAILABLE', 'StartSession returned no stream');
      return { sessionId: r.SessionId, streamUrl: r.StreamUrl, tokenValue: r.TokenValue };
    },

    async resumeSession(creds, sessionId) {
      const m = await import('@aws-sdk/client-ssm');
      const ssm = new m.SSMClient({ region, credentials: credsOf(creds) });
      const r = await ssm.send(new m.ResumeSessionCommand({ SessionId: sessionId }));
      if (!r.StreamUrl || !r.TokenValue) throw new AtlError('UPSTREAM_UNAVAILABLE', 'ResumeSession returned no stream');
      return { sessionId: r.SessionId ?? sessionId, streamUrl: r.StreamUrl, tokenValue: r.TokenValue };
    },

    async terminateSession(creds, sessionId) {
      const m = await import('@aws-sdk/client-ssm');
      const ssm = new m.SSMClient({ region, credentials: credsOf(creds) });
      try {
        await ssm.send(new m.TerminateSessionCommand({ SessionId: sessionId }));
      } catch (e) {
        if (errName(e) !== 'DoesNotExistException') throw e;
      }
    },

    async activeSessionIds(creds, q) {
      const m = await import('@aws-sdk/client-ssm');
      const ssm = new m.SSMClient({ region, credentials: credsOf(creds) });
      const ids = new Set<string>();
      let token: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await ssm.send(new m.DescribeSessionsCommand({ State: 'Active', Filters: [{ key: 'Owner', value: q.ownerArn }], ...(token ? { NextToken: token } : {}) }));
        for (const s of r.Sessions ?? []) if (s.SessionId) ids.add(s.SessionId);
        token = r.NextToken;
        if (!token) break;
      }
      return ids;
    },

    federationEndpoints(r) {
      return [`https://${r}.signin.aws.amazon.com/federation`, 'https://signin.aws.amazon.com/federation'];
    },

    async getSigninToken(endpoint, creds) {
      const session = JSON.stringify({ sessionId: creds.accessKeyId, sessionKey: creds.secretAccessKey, sessionToken: creds.sessionToken });
      // role chaining: SessionDuration must not be sent (03 §5.3)
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Action: 'getSigninToken', Session: session }).toString(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw Object.assign(new Error(`federation endpoint answered ${res.status}`), { name: 'FederationError' });
      const body = (await res.json()) as { SigninToken?: unknown };
      if (typeof body.SigninToken !== 'string' || !body.SigninToken) throw Object.assign(new Error('federation endpoint returned no SigninToken'), { name: 'FederationError' });
      return body.SigninToken;
    },

    async appAdmin(q) {
      const m = await import('@aws-sdk/client-ssm');
      const ssm = new m.SSMClient({ region });
      try {
        const r = await ssm.send(new m.GetParameterCommand({ Name: SsmParams.appAdminPassword(q.envName), WithDecryption: true }));
        const v = r.Parameter?.Value;
        return v ? { username: APP_ADMIN_USERNAME, password: v } : null;
      } catch (e) {
        if (errName(e) === 'ParameterNotFound') return null;
        throw e;
      }
    },
  };
}
