/**
 * atl-runner (01 §3.4, 02 §4.3): input validation, the op plans, the session policy, SigV4, the admin PHC string and
 * the executor against a scripted host (no AWS, no processes).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeJsonArgs } from '@atl/shared';
import { buildRunnerContext, readRunnerInput, RunnerInputError, type RunnerContext, type RunnerRecords } from '../src/runner/context.js';
import { envValue, manifestSha, RunnerExecutor } from '../src/runner/execute.js';
import type { Host, RunOptions, RunResult } from '../src/runner/host.js';
import { planOp } from '../src/runner/plan.js';
import { apiIdOf, INLINE_SESSION_POLICY_LIMIT, inlineSessionPolicy, runnerSessionPolicy, staticRunnerStatements } from '../src/runner/policy.js';
import { argon2idPhc, randomPassword } from '../src/runner/secrets.js';
import { signRequest } from '../src/runner/sigv4.js';
import { unmarshall } from '../src/runner/main.js';

const SID = 's4k7m2q9x1abc';
const ENV_ID = '01jc9x3k9cq4m2x8n5b6c0d1e2';
const ACCT = '111122223333';
const REGION = 'ap-northeast-1';

function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ATL_OP: 'base-deploy',
    ATL_RUN_ID: `${SID}-base-1`,
    ATL_SESSION_ID: SID,
    ATL_ENV_ID: ENV_ID,
    ATL_LAB_ID: 'svc-database',
    ATL_RELEASE: '0.1.0',
    ATL_REGION: REGION,
    ATL_ACCOUNT_ID: ACCT,
    ...over,
  };
}

function records(over: Partial<RunnerRecords['session']['cardSnapshot']> = {}): RunnerRecords {
  return {
    session: {
      sid: SID,
      state: 'PROVISIONING',
      labId: 'svc-database',
      labKind: 'service',
      variant: 'default',
      startProfileResolved: { name: 'atl/svc-database/default', digest: 'sha256:abc', variant: 'default' },
      cardFacts: { platformActions: ['iam-revoke-sessions'], sshFromWorkstation: false, sshUser: null },
      cardSnapshot: {
        catalogVersion: '2026.10.0',
        workstation: { required: true, sshFromWorkstation: false },
        extraStacks: [{ id: 'dr-crr-target', region: 'dr-region', deploy: 'start', reclaimPhase: 'before-modules' }],
        platformActions: [{ id: 'iam-revoke-sessions', op: 'enable', module: 'iam' }],
        ...over,
      },
    } as unknown as RunnerRecords['session'],
    environment: {
      envId: ENV_ID,
      envName: 'e7k2m9qx',
      stateUri: `s3://cloudalbum-lab-state-${ACCT}-${REGION}/e7k2m9qx/state.json`,
      platformTags: { 'atl:component': 'env', 'atl:env-id': ENV_ID, Project: 'CloudAlbum' },
      endpoints: null,
    } as unknown as RunnerRecords['environment'],
    platform: {
      region: REGION,
      drRegion: 'ap-northeast-3',
      agentApiEndpoint: 'https://a1b2c3d4e5.execute-api.ap-northeast-1.amazonaws.com',
      platformUrl: 'https://d111.cloudfront.net',
      workloadBoundaryArn: `arn:aws:iam::${ACCT}:policy/ATLWorkloadBoundary`,
      limits: { asgMaxSizeLimit: 4 },
    } as unknown as RunnerRecords['platform'],
  };
}

function ctxFor(env: Record<string, string> = {}, card: Partial<RunnerRecords['session']['cardSnapshot']> = {}): RunnerContext {
  return buildRunnerContext(readRunnerInput(baseEnv(env)), records(card), new Date('2026-10-14T01:00:00Z'));
}

describe('runner input (ATL_* variables)', () => {
  it('accepts the 01 §3.4 variables and builds the scripts/module environment from the agent-context builder', () => {
    const ctx = ctxFor();
    expect(ctx.roleSessionName).toBe(`atl-${SID}-prov-base-deploy`);
    expect(ctx.moduleEnv).toMatchObject({
      CLOUDALBUM_PLATFORM_MODE: '1',
      CLOUDALBUM_ENV: 'e7k2m9qx',
      CLOUDALBUM_OPS_REPORT: 'internal',
      CLOUDALBUM_LOCK_TABLE: 'cloudalbum-lab-locks',
      ATL_RUN_ID: `${SID}-base-1`,
      CLOUDALBUM_DR_REGION: 'ap-northeast-3',
    });
    expect(ctx.moduleEnv.CLOUDALBUM_PLATFORM_TAGS).toContain(`atl:session-id=${SID}`);
  });

  it('rejects unknown ops, foreign run ids and malformed ATL_ARGS', () => {
    expect(() => readRunnerInput(baseEnv({ ATL_OP: 'session-bootstrap' }))).toThrow(RunnerInputError);
    expect(() => readRunnerInput(baseEnv({ ATL_RUN_ID: 's0000000000zz-base-1' }))).toThrow(/does not belong/);
    expect(() => readRunnerInput(baseEnv({ ATL_OP: 'module-op', ATL_ARGS: encodeJsonArgs({ actionId: 'x', module: 'iam' }) }))).toThrow(/actionId/);
    expect(() => readRunnerInput(baseEnv({ ATL_OP: 'extra-stack', ATL_ARGS: encodeJsonArgs({ action: 'drop', stackIds: [] }) }))).toThrow(/extra-stack/);
    expect(() => readRunnerInput(baseEnv({ ATL_OP: 'profile-apply' }))).toThrow(/ATL_PROFILE/);
  });
});

describe('op plans (02 §4.3)', () => {
  it('base-deploy: bootstrap → key pair → base deploy (--retry-az) → platform.env → probe key → admin', () => {
    const steps = planOp(ctxFor());
    expect(steps.map((s) => s.id)).toEqual(['bootstrap', 'key-pair', 'base', 'platform-env', 'probe-token', 'admin']);
    const base = steps.find((s) => s.id === 'base')!;
    expect(base.kind === 'module' && base.args).toEqual(['base', 'deploy', '--env', 'e7k2m9qx', '--delivery', 'ssm', '--instance-profile', 'CloudAlbumAppRole', '--key-name', 'cloudalbum-e7k2m9qx-key', '--disable-rollback', '--retry-az']);
  });

  it('profile-apply: ⓪ only when reusing, then download → plan → digest → apply → seeds', () => {
    const fresh = planOp(ctxFor({ ATL_OP: 'profile-apply', ATL_RUN_ID: `${SID}-apply-1-0`, ATL_PROFILE: 'atl/svc-database/default', ATL_APPLY_MODE: 'fresh' }));
    expect(fresh.map((s) => s.id)).toEqual(['profile', 'plan', 'digest', 'apply', 'seeds']);
    const reuse = planOp(ctxFor({ ATL_OP: 'profile-apply', ATL_RUN_ID: `${SID}-apply-1-0`, ATL_PROFILE: 'atl/svc-database/default', ATL_APPLY_MODE: 'additive', ATL_REPAIR: '1' }));
    expect(reuse[0]!.id).toBe('apply-env');
    const apply = reuse.find((s) => s.id === 'apply')!;
    expect(apply.kind === 'module' && apply.args).toEqual(['profile', 'apply', 'atl/svc-database/default', '--mode', 'additive', '--repair', '--yes']);
  });

  it('destroy archives the state, deletes before-modules card stacks, then env destroy --fast (exit 6 tolerated)', () => {
    const steps = planOp(ctxFor({ ATL_OP: 'destroy', ATL_RUN_ID: `${SID}-destroy-1-1` }));
    expect(steps.map((s) => s.id)).toEqual(['archive', 'card-stacks-before', 'destroy', 'card-stacks-after']);
    const d = steps.find((s) => s.id === 'destroy')!;
    expect(d.kind === 'module' && d.okExit).toEqual([6]);
  });

  it('module-op maps the card action to scripts/module; other ops have one step', () => {
    const ctx = ctxFor({ ATL_OP: 'module-op', ATL_RUN_ID: `${SID}-modop-1`, ATL_ARGS: encodeJsonArgs({ actionId: 'iam-revoke-sessions' }) });
    const steps = planOp(ctx, { actionArgs: { revokeOlderSessions: true } });
    expect(steps[0]!.kind === 'module' && steps[0]!.args).toEqual(['enable', 'iam', '--param', 'revokeOlderSessions=true']);
    expect(() => planOp(ctxFor({ ATL_OP: 'module-op', ATL_RUN_ID: `${SID}-modop-1`, ATL_ARGS: encodeJsonArgs({ actionId: 'rm-rf' }) }))).toThrow(/not on the card/);
    for (const op of ['resume', 'suspend', 'workstation-up', 'workstation-down'] as const) expect(planOp(ctxFor({ ATL_OP: op, ATL_RUN_ID: `${SID}-x-1` }))).toHaveLength(1);
  });
});

describe('session policy (01 §6.7 rule 6)', () => {
  it('scopes direct calls to the environment and everything else to CloudFormation', () => {
    const p = runnerSessionPolicy(ctxFor());
    const sids = p.Statement.map((s) => s.Sid);
    expect(sids).toEqual(expect.arrayContaining(['DirectReads', 'EnvStacks', 'EnvDirect', 'EnvLock', 'RunArtifacts', 'ReportToPlatform', 'EverythingElseViaCloudFormation']));
    const json = JSON.stringify(p);
    expect(json).toContain('parameter/cloudalbum/e7k2m9qx/*');
    expect(json).toContain(`key-pair/cloudalbum-e7k2m9qx-key`);
    expect(json).toContain(`runs/${SID}-*`);
    expect(json).toContain('"dynamodb:LeadingKeys":["env#e7k2m9qx"]');
    expect(json).toContain(`a1b2c3d4e5/*/*/api/v1/internal/*`);
    expect(apiIdOf('https://zz9.execute-api.us-east-1.amazonaws.com')).toBe('zz9');
  });

  it('adds the statements of the op / platform action', () => {
    const revoke = JSON.stringify(runnerSessionPolicy(ctxFor({ ATL_OP: 'module-op', ATL_RUN_ID: `${SID}-modop-1`, ATL_ARGS: encodeJsonArgs({ actionId: 'iam-revoke-sessions' }) })));
    expect(revoke).toContain('iam:PutRolePolicy');
    const xstk = runnerSessionPolicy(ctxFor({ ATL_OP: 'extra-stack', ATL_RUN_ID: `${SID}-xstk-1-0`, ATL_ARGS: encodeJsonArgs({ action: 'deploy', stackIds: ['dr-crr-target'] }) }));
    const stacks = xstk.Statement.find((s) => s.Sid === 'EnvStacks')!;
    expect(stacks.Resource).toEqual(expect.arrayContaining(['arn:aws:cloudformation:ap-northeast-3:111122223333:stack/cloudalbum-e7k2m9qx-x-*', 'arn:aws:cloudformation:us-east-1:111122223333:stack/cloudalbum-e7k2m9qx-x-*']));
    expect(JSON.stringify(stacks.Resource)).not.toContain('stack/cloudalbum-e7k2m9qx-*');
    // session-independent statements never grant writes outside CloudFormation
    expect(JSON.stringify(staticRunnerStatements({ region: REGION, accountId: ACCT, apiId: 'x' }))).not.toMatch(/"cloudformation:\*"/);
  });

  it('the inline part stays under the AssumeRole limit for every op and platform action', () => {
    const cases: Record<string, string>[] = [
      {},
      { ATL_OP: 'destroy', ATL_RUN_ID: `${SID}-destroy-1-1` },
      { ATL_OP: 'extra-stack', ATL_RUN_ID: `${SID}-xstk-1-0`, ATL_ARGS: encodeJsonArgs({ action: 'deploy', stackIds: ['dr-crr-target'] }) },
    ];
    for (const actionId of ['iam-revoke-sessions', 'iam-keys-on', 'iam-refresh-credentials', 'cost-tags']) {
      cases.push({ ATL_OP: 'module-op', ATL_RUN_ID: `${SID}-modop-1`, ATL_ARGS: encodeJsonArgs({ actionId }) });
    }
    const card = { platformActions: [
      { id: 'iam-revoke-sessions', op: 'enable', module: 'iam' },
      { id: 'iam-keys-on', op: 'keys-on', module: 'iam' },
      { id: 'iam-refresh-credentials', op: 'refresh-instance-credentials', module: 'iam' },
      { id: 'cost-tags', op: 'activate-cost-allocation-tags', module: 'cost' },
    ] };
    for (const env of cases) {
      const json = inlineSessionPolicy(ctxFor(env, card));
      expect(json.length).toBeLessThanOrEqual(INLINE_SESSION_POLICY_LIMIT);
      expect(json).not.toContain('"Sid"');
    }
  });
});

describe('SigV4 and secrets', () => {
  it('signs like the AWS reference (get-vanilla test vector)', () => {
    const s = signRequest(
      { method: 'GET', url: 'https://example.amazonaws.com/' },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      { region: 'us-east-1', service: 'service', now: new Date('2015-08-30T12:36:00Z') },
    );
    // x-amz-content-sha256 is signed too, so the signature differs from the suite's; the structure must match
    expect(s.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(s.headers['x-amz-date']).toBe('20150830T123600Z');
    const again = signRequest({ method: 'GET', url: 'https://example.amazonaws.com/' }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, { region: 'us-east-1', service: 'service', now: new Date('2015-08-30T12:36:00Z') });
    expect(again.headers.authorization).toBe(s.headers.authorization);
  });

  it('admin password: plaintext only for the parameter, argon2id PHC with the application parameters', () => {
    const pw = randomPassword();
    expect(pw).toHaveLength(24);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[0-9]/);
    const phc = argon2idPhc('correct horse', new Uint8Array(16).fill(7), { m: 64, t: 1, p: 1, dkLen: 32 });
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=64,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]{43}$/);
  });

  it('helpers: DynamoDB JSON, profile values, manifest shapes', () => {
    expect(unmarshall({ M: { a: { S: 'x' }, n: { N: '4' }, l: { L: [{ BOOL: true }, { NULL: true }] } } })).toEqual({ a: 'x', n: 4, l: [true, null] });
    expect(envValue('A=1\nPROFILE_SEEDS="gps-sample-photos cognito-test-users"\n', 'PROFILE_SEEDS')).toBe('gps-sample-photos cognito-test-users');
    expect(manifestSha({ files: { 'a.env': 'sha256:AB' } }, 'a.env')).toBe('AB');
    expect(manifestSha({ files: [{ path: 'a.env', sha256: 'cd' }] }, 'a.env')).toBe('cd');
    expect(manifestSha({ 'a.env': { sha256: 'ef' } }, 'a.env')).toBe('ef');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// executor against a scripted host

type Responder = (cmd: string, args: string[], opts: RunOptions) => RunResult | undefined;

class FakeHost implements Host {
  readonly files = new Map<string, string>();
  readonly calls: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
  readonly posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  constructor(private readonly respond: Responder) {}
  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ cmd, args, ...(opts.env ? { env: opts.env } : {}) });
    if (cmd === 'aws' && args[0] === 'configure') return { code: 0, stdout: JSON.stringify({ AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'TK' }), stderr: '' };
    return this.respond(cmd, args, opts) ?? { code: 0, stdout: '', stderr: '' };
  }
  async readFile(p: string) {
    return this.files.get(p) ?? null;
  }
  async writeFile(p: string, data: string, opts: { append?: boolean } = {}) {
    this.files.set(p, opts.append ? (this.files.get(p) ?? '') + data : data);
  }
  async removeFile(p: string) {
    this.files.delete(p);
  }
  async listFiles(dir: string) {
    return dir.endsWith('/src') ? ['cloudalbum-0.1.0-arm64.tgz', 'SHA256SUMS'] : [];
  }
  async post(url: string, init: { headers: Record<string, string>; body: string }) {
    this.posts.push({ url, ...init });
    return 202;
  }
  now = () => new Date('2026-10-14T01:00:00Z');
  sleep = async () => undefined;
  log = () => undefined;
}

const OPTS = { srcDir: '/src', workDir: '/src/.atl-run', pollSeconds: 0 };
const ssmOk = (cmd: string, args: string[]): RunResult | undefined => {
  if (cmd !== 'aws') return undefined;
  if (args[0] === 'ssm' && args[1] === 'send-command') return { code: 0, stdout: JSON.stringify({ Command: { CommandId: 'c-1' } }), stderr: '' };
  if (args[0] === 'ssm' && args[1] === 'list-command-invocations') return { code: 0, stdout: JSON.stringify({ CommandInvocations: [{ Status: 'Success' }] }), stderr: '' };
  if (args[0] === 'ec2' && args[1] === 'describe-key-pairs') return { code: 254, stdout: '', stderr: 'InvalidKeyPair.NotFound' };
  if (args[0] === 'ssm' && args[1] === 'get-parameter') return { code: 254, stdout: '', stderr: 'ParameterNotFound' };
  if (args[0] === 'ec2' && args[1] === 'create-key-pair') return { code: 0, stdout: JSON.stringify({ KeyMaterial: '-----BEGIN OPENSSH PRIVATE KEY-----x' }), stderr: '' };
  return undefined;
};

describe('executor', () => {
  it('base-deploy success: scripts/module under atl-prov, key pair via a 0600 input file, admin hash only, result.json', async () => {
    const host = new FakeHost((cmd, args) => ssmOk(cmd, args));
    const exec = new RunnerExecutor(ctxFor(), host, OPTS);
    const r = await exec.runAll();
    expect(r).toMatchObject({ exitCode: 0, command: 'base-deploy', runId: `${SID}-base-1` });
    expect(r.steps.map((s) => s.id)).toEqual(['bootstrap', 'key-pair', 'base', 'platform-env', 'probe-token', 'admin']);
    const module = host.calls.filter((c) => c.cmd === '/src/scripts/module');
    expect(module[0]!.args.slice(0, 5)).toEqual(['bootstrap', '--env', 'e7k2m9qx', '--release-file', '/src/cloudalbum-0.1.0-arm64.tgz']);
    expect(module[0]!.args).toEqual(expect.arrayContaining(['--platform', '--progress-jsonl', '--result-json', '--lock-wait', '900']));
    expect(module[0]!.env).toMatchObject({ AWS_PROFILE: 'atl-prov', CLOUDALBUM_ENV: 'e7k2m9qx', ATL_RUN_ID: `${SID}-base-1` });
    // the private key and the admin password never appear in an argument list
    const argv = JSON.stringify(host.calls.map((c) => c.args));
    expect(argv).not.toContain('BEGIN OPENSSH');
    const sends = host.calls.filter((c) => c.args[1] === 'send-command').map((c) => c.args[c.args.indexOf('--parameters') + 1]!);
    expect(sends[0]).toContain('platform:apply-env --b64');
    expect(sends[2]).toMatch(/admin:ensure --email atl-admin@example.com --password-hash '\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(host.calls.some((c) => c.args[1] === 'put-parameter' && c.args.includes('--cli-input-json'))).toBe(true);
    expect(host.posts.length).toBeGreaterThan(0);
    expect(host.posts[0]!.url).toBe(`https://a1b2c3d4e5.execute-api.ap-northeast-1.amazonaws.com/api/v1/internal/runs/${SID}-base-1/events`);
    expect(host.posts[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
  }, 60_000);

  it('a failing scripts/module step stops the build; phase / module / cfnFailures come from its --result-json', async () => {
    const host = new FakeHost((cmd, args) => {
      if (cmd === '/src/scripts/module' && args[0] === 'base') {
        const file = args[args.indexOf('--result-json') + 1]!;
        host.files.set(file, JSON.stringify({ exitCode: 3, phase: 'deploy-stack', module: 'base', cfnFailures: [{ stack: 'cloudalbum-e7k2m9qx-ec2', logicalId: 'Instance', status: 'CREATE_FAILED', reason: 'We currently do not have sufficient t3.micro capacity' }] }));
        return { code: 3, stdout: '', stderr: 'stack failed' };
      }
      return ssmOk(cmd, args);
    });
    const r = await new RunnerExecutor(ctxFor(), host, OPTS).runAll();
    expect(r).toMatchObject({ exitCode: 3, phase: 'deploy-stack', module: 'base', step: 'base', firstCreate: true });
    expect(r.cfnFailures[0]).toMatchObject({ logicalId: 'Instance' });
    expect(r.steps.map((s) => s.id)).toEqual(['bootstrap', 'key-pair', 'base']); // platform.env etc. not attempted
  });

  it('platform.env delivery is retried once, then BASE_BOOTSTRAP_FAILED (exit 5)', async () => {
    let sends = 0;
    const host = new FakeHost((cmd, args) => {
      if (cmd === 'aws' && args[1] === 'list-command-invocations') return { code: 0, stdout: JSON.stringify({ CommandInvocations: [{ Status: 'Failed', CommandPlugins: [{ Output: 'nginx -t failed' }] }] }), stderr: '' };
      if (cmd === 'aws' && args[1] === 'send-command') sends++;
      return ssmOk(cmd, args);
    });
    const r = await new RunnerExecutor(ctxFor(), host, OPTS).runAll();
    expect(r).toMatchObject({ exitCode: 5, step: 'platform-env', classification: { code: 'BASE_BOOTSTRAP_FAILED' } });
    expect(sends).toBe(2);
  });

  it('profile-apply: manifest SHA-256 + digest check, placeholders replaced, seeds failing twice become warnings', async () => {
    const profile = 'atl/svc-database/default';
    const body = 'PROFILE_CARD=svc-database\nPROFILE_PLAN_DIGEST=sha256:abc\nPROFILE_BASE_PARAMS=DrRegion=${atl:drRegion}\nPROFILE_SEEDS=gps-sample-photos,cognito-test-users\n';
    const sha = createHash('sha256').update(body).digest('hex');
    const host = new FakeHost((cmd, args) => {
      if (cmd === 'aws' && args[0] === 's3' && args[1] === 'cp') {
        const dest = args[3]!;
        host.files.set(dest, args[2]!.endsWith('manifest.json') ? JSON.stringify({ files: { [`profiles/${profile}.env`]: sha } }) : body);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === '/src/scripts/module' && args[0] === 'plan') return { code: 0, stdout: JSON.stringify({ digest: 'sha256:abc' }), stderr: '' };
      if (cmd === '/src/scripts/module' && args[0] === 'seed' && args[1] === 'cognito-test-users') return { code: 5, stdout: '', stderr: 'auth not ready' };
      return ssmOk(cmd, args);
    });
    const ctx = ctxFor({ ATL_OP: 'profile-apply', ATL_RUN_ID: `${SID}-apply-1-0`, ATL_PROFILE: profile, ATL_APPLY_MODE: 'fresh' });
    const r = await new RunnerExecutor(ctx, host, OPTS).runAll();
    expect(r.exitCode).toBe(0);
    expect(r.warnings).toEqual(['seed:cognito-test-users']);
    expect(host.files.get(`/src/profiles/${profile}.env`)).toContain('DrRegion=ap-northeast-3');
    expect(host.calls.filter((c) => c.args[0] === 'seed' && c.args[1] === 'cognito-test-users')).toHaveLength(2);
    // the s3 downloads use the service role, not atl-prov
    expect(host.calls.find((c) => c.args[0] === 's3')!.env).toMatchObject({ AWS_PROFILE: undefined });
  });

  it('profile-apply: a digest mismatch is PROFILE_DIGEST_MISMATCH (exit 2, not retryable) before anything is applied', async () => {
    const profile = 'atl/svc-database/default';
    const body = 'PROFILE_PLAN_DIGEST=sha256:abc\n';
    const sha = createHash('sha256').update(body).digest('hex');
    const host = new FakeHost((cmd, args) => {
      if (cmd === 'aws' && args[0] === 's3') {
        host.files.set(args[3]!, args[2]!.endsWith('manifest.json') ? JSON.stringify({ files: { [`profiles/${profile}.env`]: sha } }) : body);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === '/src/scripts/module' && args[0] === 'plan') return { code: 0, stdout: JSON.stringify({ digest: 'sha256:OTHER' }), stderr: '' };
      return undefined;
    });
    const ctx = ctxFor({ ATL_OP: 'profile-apply', ATL_RUN_ID: `${SID}-apply-1-0`, ATL_PROFILE: profile });
    const r = await new RunnerExecutor(ctx, host, OPTS).runAll();
    expect(r).toMatchObject({ exitCode: 2, classification: { code: 'PROFILE_DIGEST_MISMATCH', retryable: false } });
    expect(host.calls.some((c) => c.args[0] === 'profile' && c.args[1] === 'apply')).toBe(false);
  });

  it('destroy: exit 6 of env destroy continues to the after-modules card stacks and stays 6', async () => {
    const host = new FakeHost((cmd, args) => {
      if (cmd === '/src/scripts/module' && args[0] === 'env') return { code: 6, stdout: '', stderr: 'partly deleted' };
      if (cmd === 'aws' && args[1] === 'describe-stacks') return { code: 254, stdout: '', stderr: 'does not exist' };
      return undefined;
    });
    const r = await new RunnerExecutor(ctxFor({ ATL_OP: 'destroy', ATL_RUN_ID: `${SID}-destroy-1-1` }), host, OPTS).runAll();
    expect(r.exitCode).toBe(6);
    expect(r.steps.map((s) => s.id)).toEqual(['archive', 'card-stacks-before', 'destroy', 'card-stacks-after']);
  });
});

describe('runner bundle', () => {
  it('bundles src/runner/main.ts into one ESM file without the simulator', async () => {
    // @ts-expect-error build.mjs is plain JS without declarations
    const { bundleRunner } = (await import('../runner/build.mjs')) as { bundleRunner: (o: { write: boolean }) => Promise<{ errors: unknown[]; metafile: { inputs: Record<string, unknown> } }> };
    const r = await bundleRunner({ write: false });
    expect(r.errors).toEqual([]);
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.some((p) => /src[\\/]runner[\\/]main\.ts$/.test(p))).toBe(true);
    expect(inputs.filter((p) => /simulator|[\\/]asl[\\/]/.test(p))).toEqual([]);
  }, 60_000);
});
