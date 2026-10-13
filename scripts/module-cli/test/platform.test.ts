// scripts/module platform mode (docs/platform/06 PM-26～PM-36): environment, identity, state bucket, lock, tags, SSM delivery
// with the secret hand-off, start-state derivation and its digest, reports. No AWS call is executed (fake gateways).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AwsCall, AwsGateway } from '../src/aws.js';
import { DryRunGateway } from '../src/aws.js';
import { createContext, type Ctx } from '../src/context.js';
import { discoverLabInstances, RemoteScript, SsmDeliverer, lastJsonLine } from '../src/deliver.js';
import { enableCommand } from '../src/enable.js';
import { parsePlatformTags, parseIdentity, readPlatformEnv, verifyIdentity, type PlatformEnv } from '../src/platform/env.js';
import { EnvLock, envLockKey } from '../src/platform/lock.js';
import { reportModuleOp, Reporter, ReportingPrinter } from '../src/platform/report.js';
import { createPlatformRuntime, preparePlatform, ulid } from '../src/platform/runtime.js';
import { S3StateStore } from '../src/platform/state-s3.js';
import {
  digestObject, loadLab, normalizeProfileName, parseAtlProfile, parseExtraStacks, planStartOf, renderAtlProfile, specDigest, specOf,
} from '../src/plan-start.js';
import { destroyOrder, seedPassword } from '../src/platform-cmds.js';
import { profileApply, runtimeSetLines } from '../src/profile-cmd.js';
import { CapturePrinter, CliError, EXIT } from '../src/printer.js';
import { configurePlatformTags, preserveSessionTags, stackTags } from '../src/stack.js';
import { newState, upgradeState } from '../src/state.js';
import { REPO_ROOT, RecordingDeliverer, deployedState } from './helpers.js';

const FIX = path.join(REPO_ROOT, 'scripts', 'module-cli', 'test', 'fixtures', 'labs');
const lab = (card: string) => loadLab(REPO_ROOT, card, path.join(FIX, card, 'lab.yaml'));

const ENV: NodeJS.ProcessEnv = {
  CLOUDALBUM_PLATFORM_MODE: '1', CLOUDALBUM_ENV: 'e7k2m9qx',
  CLOUDALBUM_STATE_URI: 's3://cloudalbum-lab-state-111122223333-ap-northeast-1/e7k2m9qx/state.json',
  CLOUDALBUM_LOCK_TABLE: 'cloudalbum-lab-locks',
  CLOUDALBUM_PLATFORM_TAGS: 'atl:component=env,atl:session-id=s4k7m2q9x1abc,atl:lab-id=svc-cdn,atl:env-id=01jc9x3k9cq4m2x8n5b6c0d1e2,Project=CloudAlbum',
  CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN: 'arn:aws:iam::111122223333:policy/ATLWorkloadBoundary',
  CLOUDALBUM_ADMIN_PASSWORD_PARAM: '/cloudalbum/e7k2m9qx/atl/app-admin-password',
  CLOUDALBUM_TEST_USERS_PARAM: '/cloudalbum/e7k2m9qx/atl/test-users',
  ATL_SESSION_ID: 's4k7m2q9x1abc', ATL_ENV_ID: '01jc9x3k9cq4m2x8n5b6c0d1e2', ATL_LAB_ID: 'svc-cdn', AWS_REGION: 'ap-northeast-1',
};

afterEach(() => configurePlatformTags(null));

describe('platform environment and identity (PM-26)', () => {
  it('reads the PM-26 variables; missing ones → exit 2 PLATFORM_ENV_INCOMPLETE listing them', () => {
    const p = readPlatformEnv(ENV);
    expect(p).toMatchObject({ env: 'e7k2m9qx', stateBucket: 'cloudalbum-lab-state-111122223333-ap-northeast-1', stateKey: 'e7k2m9qx/state.json',
      lockTable: 'cloudalbum-lab-locks', variant: 'default', opsReport: 'off' });
    expect(p.tags['atl:session-id']).toBe('s4k7m2q9x1abc');
    try {
      readPlatformEnv({ ...ENV, CLOUDALBUM_LOCK_TABLE: '', ATL_ENV_ID: '' });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toMatchObject({ exitCode: 2, code: 'PLATFORM_ENV_INCOMPLETE', details: { missing: ['CLOUDALBUM_LOCK_TABLE', 'ATL_ENV_ID'] } });
    }
    expect(() => readPlatformEnv({ ...ENV, CLOUDALBUM_OPS_REPORT: 'agent' })).toThrow(/ATL_AGENT_API/);
    expect(() => readPlatformEnv({ ...ENV, CLOUDALBUM_STATE_URI: 's3://atl-data/x/state.json' })).toThrow(CliError);
    expect(() => parsePlatformTags('a=b,bad entry')).toThrow(CliError);
  });

  it('identity: learner ws / console and provisioner prov-<op> of the same session; anything else → PLATFORM_IDENTITY_MISMATCH', async () => {
    const sid = 's4k7m2q9x1abc';
    expect(parseIdentity(`arn:aws:sts::111122223333:assumed-role/ATLLearnerRole/atl-${sid}-ws`, sid)?.kind).toBe('learner');
    expect(parseIdentity(`arn:aws:sts::111122223333:assumed-role/ATLLearnerRole/atl-${sid}-console`, sid)?.kind).toBe('console');
    expect(parseIdentity(`arn:aws:sts::111122223333:assumed-role/ATLProvisionerRole/atl-${sid}-prov-profile-apply`, sid)).toMatchObject({ kind: 'provisioner', sessionName: `atl-${sid}-prov-profile-apply` });
    expect(parseIdentity('arn:aws:sts::111122223333:assumed-role/ATLLearnerRole/atl-s000000000000-ws', sid)).toBeNull();
    expect(parseIdentity('arn:aws:sts::111122223333:assumed-role/Admin/me', sid)).toBeNull();
    const gw: AwsGateway = { dryRun: false, send: async <T>() => ({ Arn: 'arn:aws:sts::111122223333:assumed-role/Admin/me', Account: '111122223333' }) as T };
    await expect(verifyIdentity(gw, readPlatformEnv(ENV))).rejects.toMatchObject({ exitCode: 2, code: 'PLATFORM_IDENTITY_MISMATCH' });
    expect((await verifyIdentity(gw, readPlatformEnv(ENV), { allowAnyIdentity: true })).kind).toBe('any');
  });
});

// ------------------------------------------------------------------------------------------------ fake AWS

class FakeAws implements AwsGateway {
  readonly dryRun = false;
  readonly calls: AwsCall[] = [];
  readonly s3 = new Map<string, { body: string; etag: string }>();
  readonly ddb = new Map<string, Record<string, { S?: string; N?: string }>>();
  failUpdates = false;
  private n = 0;
  async send<T>(call: AwsCall): Promise<T | undefined> {
    this.calls.push(call);
    const i = call.input as Record<string, unknown>;
    const fail = (name: string) => Object.assign(new Error(name), { name });
    if (call.service === 's3' && call.op === 'GetObject') {
      const o = this.s3.get(`${String(i.Bucket)}/${String(i.Key)}`);
      if (!o) throw fail('NoSuchKey');
      return { Body: o.body, ETag: o.etag } as T;
    }
    if (call.service === 's3' && call.op === 'PutObject') {
      const k = `${String(i.Bucket)}/${String(i.Key)}`;
      const cur = this.s3.get(k);
      if (i.IfNoneMatch === '*' && cur) throw fail('PreconditionFailed');
      if (i.IfMatch && cur?.etag !== i.IfMatch) throw fail('PreconditionFailed');
      this.n += 1;
      const etag = `"e${this.n}"`;
      this.s3.set(k, { body: String(i.Body), etag });
      return { ETag: etag } as T;
    }
    if (call.service === 'dynamodb') {
      const key = String(((i.Key ?? i.Item) as Record<string, { S: string }>).lockKey.S);
      const cur = this.ddb.get(key);
      const vals = (i.ExpressionAttributeValues ?? {}) as Record<string, { S?: string; N?: string }>;
      if (call.op === 'PutItem') {
        if (cur && Number(cur.leaseUntil?.N) >= Number(vals[':stale']?.N)) throw fail('ConditionalCheckFailedException');
        this.ddb.set(key, i.Item as Record<string, { S?: string; N?: string }>);
        return {} as T;
      }
      if (call.op === 'GetItem') return { Item: cur } as T;
      const owner = cur && cur.holderArn?.S === vals[':me']?.S && cur.ver?.N === vals[':v']?.N;
      if (call.op === 'UpdateItem') {
        if (this.failUpdates || !owner) throw fail('ConditionalCheckFailedException');
        cur!.leaseUntil = { N: String(vals[':lease']?.N) };
        cur!.ver = { N: String(Number(cur!.ver!.N) + 1) };
        return {} as T;
      }
      if (call.op === 'DeleteItem') {
        if (!owner) throw fail('ConditionalCheckFailedException');
        this.ddb.delete(key);
        return {} as T;
      }
    }
    return {} as T;
  }
}

describe('state bucket with S3 conditional writes (PM-27)', () => {
  it('create with If-None-Match: *, update with If-Match; a concurrent writer → exit 8 STATE_CONFLICT', async () => {
    const aws = new FakeAws();
    const a = new S3StateStore(aws, 'b', 'e7k2m9qx/state.json');
    expect(await a.load()).toBeNull();
    const st = newState('e7k2m9qx', 'ap-northeast-1', 'platform');
    await a.save(st, { writer: 'atl-s4k7m2q9x1abc-ws', op: 'enable cdn' });
    expect(aws.calls.find((c) => c.op === 'PutObject')?.input).toMatchObject({ IfNoneMatch: '*', Metadata: { writer: 'atl-s4k7m2q9x1abc-ws', op: 'enable cdn' } });
    const b = new S3StateStore(aws, 'b', 'e7k2m9qx/state.json');
    const loaded = await b.load();
    expect(loaded?.mode).toBe('platform');
    await b.save(loaded!, { writer: 'atl-s4k7m2q9x1abc-prov-apply', op: 'profile apply' });
    expect(aws.calls.filter((c) => c.op === 'PutObject')[1]?.input).toMatchObject({ IfMatch: '"e1"' });
    await expect(a.save(st, { writer: 'x', op: 'disable cdn' })).rejects.toMatchObject({ exitCode: EXIT.stateConflict, code: 'STATE_CONFLICT' });
  });

  it('v1 → v2 upgrade (standalone files keep working)', () => {
    const v1 = { version: 1, env: 'lab', region: 'ap-northeast-1', createdAt: 'x', updatedAt: 'x', delivery: { channel: 'ssh', sshUser: 'ec2-user' }, modules: {} };
    const s = upgradeState(v1 as Record<string, unknown>);
    expect(s).toMatchObject({ version: 2, schemaVersion: 2, mode: 'standalone', backups: [], imports: [], suspended: null });
    expect(() => upgradeState({ version: 3 })).toThrow(/unsupported/);
  });
});

describe('environment lock (PM-28)', () => {
  const opts = (holder: string, now: () => number) => ({ table: 't', envName: 'e7k2m9qx', holderArn: `arn:aws:sts::1:assumed-role/R/${holder}`, holder, op: 'enable cdn',
    runId: 'ws-1', waitSec: 0, now, sleepMs: async () => undefined });

  it('key env#<envName>; a second holder gets ENV_LOCK_BUSY (exit 7) with the holder; takeover only after the lease (+30 s skew)', async () => {
    expect(envLockKey('e7k2m9qx')).toBe('env#e7k2m9qx');
    const aws = new FakeAws();
    let t = 1_790_000_000_000;
    const a = new EnvLock(aws, opts('atl-s1-ws', () => t));
    await a.acquire();
    const b = new EnvLock(aws, opts('atl-s1-prov-module-op', () => t));
    await expect(b.acquire()).rejects.toMatchObject({ exitCode: EXIT.lock, code: 'ENV_LOCK_BUSY', details: { holder: 'atl-s1-ws', op: 'enable cdn' } });
    t += 310_000;                                    // 300 s lease + 10 s: still within the 30 s skew
    await expect(b.acquire()).rejects.toMatchObject({ code: 'ENV_LOCK_BUSY' });
    t += 30_000;
    await b.acquire();
    expect(aws.ddb.get('env#e7k2m9qx')?.holder?.S).toBe('atl-s1-prov-module-op');
    await a.release();                               // not the holder any more: ignored
    expect(aws.ddb.has('env#e7k2m9qx')).toBe(true);
    await b.release();
    expect(aws.ddb.has('env#e7k2m9qx')).toBe(false);
  });

  it('two failed renewals set the abort flag (ENV_LOCK_LOST at the next safe point)', async () => {
    const aws = new FakeAws();
    const l = new EnvLock(aws, opts('atl-s1-ws', () => 1_790_000_000_000));
    await l.acquire();
    expect(await l.renew()).toBe(true);
    aws.failUpdates = true;
    await l.renew();
    expect(l.lost).toBe(false);
    await l.renew();
    expect(l.lost).toBe(true);
    expect(() => l.assertHeld()).toThrow(expect.objectContaining({ exitCode: EXIT.lock, code: 'ENV_LOCK_LOST' }));
    await l.release();
  });

  it('--lock-wait polls every 10 s until the deadline', async () => {
    const aws = new FakeAws();
    let t = 1_790_000_000_000;
    await new EnvLock(aws, opts('atl-s1-prov-x', () => t)).acquire();
    let sleeps = 0;
    const w = new EnvLock(aws, { ...opts('atl-s1-ws', () => t), waitSec: 400, sleepMs: async () => { sleeps += 1; t += 10_000; } });
    await w.acquire();                               // the lease expires (300 s + 30 s skew) while waiting
    expect(sleeps).toBeGreaterThanOrEqual(33);
    expect(w.waitedSec).toBeGreaterThanOrEqual(330);
    await w.release();
  });
});

// ------------------------------------------------------------------------------------------------ platform dry-run

function platformCtx(state = deployedPlatformState(), deliverer?: RecordingDeliverer): { ctx: Ctx; out: CapturePrinter; aws: DryRunGateway } {
  const out = new CapturePrinter();
  const aws = new DryRunGateway(out);
  const ctx = createContext({ dryRun: true, yes: true, skipLocalCheck: true, platform: true },
    { aws, out, repoRoot: REPO_ROOT, state, platformEnv: readPlatformEnv(ENV), command: 'test', ...(deliverer ? { deliverer } : {}) });
  return { ctx, out, aws };
}

function deployedPlatformState() {
  const s = deployedState();
  s.env = 'e7k2m9qx';
  s.mode = 'platform';
  s.base!.params.InstanceProfileName = 'CloudAlbumAppRole';
  s.baseConfig.CLOUDALBUM_ENV = 'e7k2m9qx';
  s.toolchain = { stackName: 'cloudalbum-e7k2m9qx-toolchain', bucket: 'cloudalbum-e7k2m9qx-toolchain-artifacts' };
  return s;
}

async function prepared(ctx: Ctx): Promise<void> {
  await preparePlatform(ctx, ctx.platform!, { mutating: true, op: 'test' });
  configurePlatformTags({ env: ctx.state.platform!.platformTags, session: { 'atl:session-id': 's4k7m2q9x1abc', 'atl:lab-id': 'svc-cdn' } });
}

describe('platform mode enable (dry-run): tags, boundary, iam existing, SSM delivery with the secret hand-off', () => {
  it('enable cdn: platform stack tags, discovery by tags, origin-verify through a SecureString hand-off (never in the command)', async () => {
    const { ctx, aws } = platformCtx();
    await prepared(ctx);
    expect(ctx.state.platform).toMatchObject({ envId: '01jc9x3k9cq4m2x8n5b6c0d1e2', sessionChain: ['s4k7m2q9x1abc'] });
    expect(await enableCommand(ctx, 'cdn', {})).toBe(0);
    const stack = aws.calls.find((c) => c.input.StackName === 'cloudalbum-e7k2m9qx-cdn' && /Stack$/.test(c.op))!;
    const tags = Object.fromEntries((stack.input.Tags as Array<{ Key: string; Value: string }>).map((t) => [t.Key, t.Value]));
    expect(tags).toMatchObject({ 'atl:component': 'env', 'atl:session-id': 's4k7m2q9x1abc', 'atl:lab-id': 'svc-cdn', 'atl:env-id': '01jc9x3k9cq4m2x8n5b6c0d1e2', Project: 'CloudAlbum' });
    expect(tags['atl:role']).toBeUndefined();
    const describe = aws.calls.find((c) => c.op === 'DescribeInstances')!;
    expect(describe.input.Filters).toContainEqual({ Name: 'tag:atl:env-id', Values: ['01jc9x3k9cq4m2x8n5b6c0d1e2'] });
    expect(describe.input.Filters).toContainEqual({ Name: 'tag:atl:role', Values: ['lab-app'] });
    const put = aws.calls.find((c) => c.op === 'PutParameter' && String(c.input.Name).includes('/handoff/'))!;
    expect(put.input).toMatchObject({ Type: 'SecureString' });
    expect(put.display).toMatchObject({ Value: '***' });
    const send = aws.calls.find((c) => c.op === 'SendCommand' && String((c.display as { script?: string }).script) === 'enable cdn')!;
    const command = (send.input.Parameters as { commands: string[] }).commands[0]!;
    const secret = (JSON.parse(String(put.input.Value)) as Record<string, string>).ORIGIN_VERIFY!;
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(command).not.toContain(secret);
    expect(command).toContain('aws ssm get-parameter');
    expect(String(send.input.Comment)).toMatch(/^cloudalbum enable cdn [0-9A-Z]{26}$/);
    expect(aws.calls.some((c) => c.op === 'DeleteParameter' && c.input.Name === put.input.Name)).toBe(true);
    expect(command).toContain('"pending"');                         // modules.state.json pending + history (PM-15)
  });

  it('enable image-processing: PermissionsBoundaryArn + ResultChannel=queue; iam AppRoleMode=existing; keys mode refused', async () => {
    const { ctx, aws } = platformCtx();
    await prepared(ctx);
    expect(await enableCommand(ctx, 'iam', {})).toBe(0);
    const iam = aws.calls.find((c) => c.input.StackName === 'cloudalbum-e7k2m9qx-iam' && /Stack$/.test(c.op))!;
    expect(iam.input.Parameters).toContainEqual({ ParameterKey: 'AppRoleMode', ParameterValue: 'existing' });
    expect(iam.input.Parameters).toContainEqual({ ParameterKey: 'PermissionsBoundaryArn', ParameterValue: 'arn:aws:iam::111122223333:policy/ATLWorkloadBoundary' });
    expect(aws.calls.some((c) => c.input.StackName === 'cloudalbum-e7k2m9qx-ec2' && /Stack$/.test(c.op))).toBe(false);   // InstanceProfileName unchanged
    await expect(enableCommand(ctx, 'iam', { mode: 'keys' })).rejects.toMatchObject({ code: 'PLATFORM_ACTION_REQUIRED' });
    expect(await enableCommand(ctx, 'storage', { migrate: false })).toBe(0);
    expect(await enableCommand(ctx, 'image-processing', {})).toBe(0);
    const ip = aws.calls.find((c) => c.input.StackName === 'cloudalbum-e7k2m9qx-image-processing' && /Stack$/.test(c.op))!;
    expect(ip.input.Parameters).toContainEqual({ ParameterKey: 'ResultChannel', ParameterValue: 'queue' });
    expect(ip.input.Parameters).toContainEqual({ ParameterKey: 'PermissionsBoundaryArn', ParameterValue: 'arn:aws:iam::111122223333:policy/ATLWorkloadBoundary' });
  });

  it('updating an existing stack keeps its session-level tags (02 §8.4 rule 4)', () => {
    configurePlatformTags({ env: { Project: 'CloudAlbum', 'atl:env-id': 'x' }, session: { 'atl:session-id': 'snew', 'atl:lab-id': 'svc-b' } });
    const t = stackTags('e1', 'cdn', 1);
    expect(t['atl:session-id']).toBe('snew');
    expect(preserveSessionTags(t, { 'atl:session-id': 'sold', 'atl:lab-id': 'svc-a' })).toMatchObject({ 'atl:session-id': 'sold', 'atl:lab-id': 'svc-a' });
    expect(() => configurePlatformTags({ env: { 'atl:role': 'lab-app' }, session: {} })).toThrow(/atl:role/);
  });

  it('profile apply refuses unreplaced ${atl:…} placeholders (exit 2 PROFILE_PLACEHOLDER)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'atl-profile-'));
    const file = path.join(dir, 'profiles', 'atl', 'svc-ec2', 'default.env');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'PROFILE_NAME=atl/svc-ec2/default\nPROFILE_CARD=svc-ec2\nPROFILE_EXTENDS=l0-ec2\nPROFILE_BASE_PARAMS=SshIngressCidr=${atl:workstationPrivateCidr}\n');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const { ctx } = platformCtx();
      await prepared(ctx);
      await expect(profileApply(ctx, 'atl/svc-ec2', {})).rejects.toMatchObject({ exitCode: 2, code: 'PROFILE_PLACEHOLDER' });
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('SSM delivery (PM-30)', () => {
  it('discovery keeps only instances of this environment stack / ASG (learner copies and other stacks are excluded)', async () => {
    const gw: AwsGateway = { dryRun: false, send: async <T>() => ({ Reservations: [{ Instances: [
      { InstanceId: 'i-good', Tags: [{ Key: 'aws:cloudformation:stack-name', Value: 'cloudalbum-e7k2m9qx-ec2' }] },
      { InstanceId: 'i-asg', Tags: [{ Key: 'aws:autoscaling:groupName', Value: 'cloudalbum-e7k2m9qx-autoscaling-Asg-1' }] },
      { InstanceId: 'i-copy', Tags: [{ Key: 'atl:role', Value: 'lab-app' }] },
      { InstanceId: 'i-other', Tags: [{ Key: 'aws:cloudformation:stack-name', Value: 'cloudalbum-eother00-ec2' }] },
    ] }] }) as T };
    expect(await discoverLabInstances(gw, 'e7k2m9qx', '01jc9x3k9cq4m2x8n5b6c0d1e2')).toEqual(['i-good', 'i-asg']);
  });

  it('inline secrets (outside the secrets.env upsert) are still refused over SSM', async () => {
    const s = new RemoteScript('x');
    s.line(`echo ${s.secret('topsecret')}`);
    const d = new SsmDeliverer(new DryRunGateway(), undefined, new CapturePrinter(), { envName: 'e7k2m9qx', envId: 'x', region: 'ap-northeast-1', commentSuffix: 'op', handoffPrefix: '/cloudalbum/e7k2m9qx/handoff/op' });
    await expect(d.run(s)).rejects.toThrow(/secret values/);
    const u = new RemoteScript('y');
    u.upsertSecrets({ A_KEY: 'v1' });
    expect(u.render()).toContain('A_KEY=v1');
    expect(u.render({ param: '/p', region: 'ap-northeast-1' })).not.toContain('v1');
    expect(lastJsonLine('noise\n{"a":1}\n')).toEqual({ a: 1 });
  });
});

describe('start-state derivation and digest (PM-32, PM-33)', () => {
  it('svc-cdn: L0 + iam(role) only; scheme B on; svc-ec2: no iam, SSH from the workstation as a placeholder', () => {
    const cdn = planStartOf(lab('svc-cdn'), { repoRoot: REPO_ROOT });
    expect(cdn.start.map((e) => e.id)).toEqual(['ec2', 'iam']);
    expect(cdn.start[1]).toMatchObject({ kind: 'module', basis: 'credential', set: { IAM_CREDENTIALS: 'role' } });
    expect(cdn.platform).toEqual({ 'preview.directHttps': 'on' });
    expect(cdn.profileName).toBe('atl/svc-cdn/default');
    const ec2 = planStartOf(lab('svc-ec2'), { repoRoot: REPO_ROOT });
    expect(ec2.start.map((e) => e.id)).toEqual(['ec2']);
    expect(ec2.baseParams).toEqual({ SshIngressCidr: '${atl:workstationPrivateCidr}' });
  });

  it('closure, precursor and single-service local settings; autoscaling switches scheme B off', () => {
    const ip = planStartOf(lab('svc-image-processing'), { repoRoot: REPO_ROOT });
    expect(ip.start.find((e) => e.id === 'storage')).toMatchObject({ kind: 'module', basis: 'closure', set: { STORAGE_DRIVER: 's3' }, because: ['DEP-003'] });
    const q = planStartOf(lab('svc-queue'), { repoRoot: REPO_ROOT });
    expect(q.start.find((e) => e.id === 'queue')).toMatchObject({ kind: 'local', basis: 'precursor', set: { QUEUE_DRIVER: 'memory' } });
    expect(q.start.find((e) => e.id === 'image-processing')).toMatchObject({ kind: 'local', set: { IMAGE_PROCESSOR: 'worker' } });
    expect(q.seeds).toEqual(['cognito-test-users']);
    expect(planStartOf(lab('svc-autoscaling'), { repoRoot: REPO_ROOT }).platform['preview.directHttps']).toBe('off');
  });

  it('scenario cards: other targets are not provisioned; runtime keys; only deploy: start extra stacks', () => {
    const sc = planStartOf(lab('sc-static-acceleration'), { repoRoot: REPO_ROOT });
    expect(sc.start.map((e) => e.id)).toEqual(['ec2', 'iam', 'featureFlags.lab.faults']);
    expect(sc.start[2]).toMatchObject({ kind: 'runtime', value: true });
    expect(sc.extraStacks).toEqual([{ id: 'edge-cert', region: 'us-east-1' }]);
  });

  it('the digest is stable, ignores explanations, follows the registry version, and survives the profile file round trip', () => {
    const a = planStartOf(lab('svc-image-processing'), { repoRoot: REPO_ROOT });
    const b = planStartOf(lab('svc-image-processing'), { repoRoot: REPO_ROOT });
    expect(a.digest).toBe(b.digest);
    const spec = specOf(a.card, a.variant, a.start, a.platform, a.baseParams, a.extraStacks, a.seeds);
    const noBecause = specOf(a.card, a.variant, a.start.map(({ because: _b, ...e }) => e), a.platform, a.baseParams, a.extraStacks, a.seeds);
    expect(specDigest(noBecause)).toBe(a.digest);
    expect(specDigest(spec, '999+other')).not.toBe(a.digest);
    for (const card of ['svc-cdn', 'svc-ec2', 'svc-queue', 'sc-static-acceleration', 'svc-autoscaling']) {
      const p = planStartOf(lab(card), { repoRoot: REPO_ROOT });
      const text = renderAtlProfile(p);
      expect(text).toContain(`PROFILE_PLAN_DIGEST=${p.digest}`);
      const parsed = parseAtlProfile(text);
      expect(specDigest(parsed), card).toBe(p.digest);
      expect(digestObject(parsed)).toEqual(digestObject(specOf(p.card, p.variant, p.start, p.platform, p.baseParams, p.extraStacks, p.seeds)));
    }
    expect(parseAtlProfile(renderAtlProfile(planStartOf(lab('svc-ec2'), { repoRoot: REPO_ROOT }))).placeholders).toEqual(['PROFILE_BASE_PARAMS']);
  });

  it('variants, DRV-5, profile names and PROFILE_EXTRA_STACKS format', () => {
    expect(planStartOf(lab('svc-auth'), { repoRoot: REPO_ROOT, variant: 'with-cdn' }).profileName).toBe('atl/svc-auth/with-cdn');
    expect(() => planStartOf(lab('svc-auth'), { repoRoot: REPO_ROOT, variant: 'nope' })).toThrow(CliError);
    const same = { CDN_ORIGIN_TYPE: 'ec2', CDN_MEDIA_ORIGIN: 'ec2', CDN_DIRECT_ACCESS: 'open' };
    const bad = { ...lab('svc-cdn'), startProfile: { provisions: [{ item: 'cdn', kind: 'module', basis: 'context', set: same, reason: 'x' }] }, kind: 'scenario' as const };
    expect(() => planStartOf(bad, { repoRoot: REPO_ROOT })).toThrow(/DRV-5/);
    // the target changes a setting of a module that is already there: allowed, but fromDriver must say so (warning)
    const changes = { ...bad, startProfile: { provisions: [{ item: 'cdn', kind: 'module', basis: 'context', set: { ...same, CDN_DIRECT_ACCESS: 'closed' }, reason: 'x' }] } };
    expect(planStartOf(changes, { repoRoot: REPO_ROOT }).warnings.join()).toMatch(/fromDriver/);
    expect(normalizeProfileName('atl/svc-cdn')).toBe('atl/svc-cdn/default');
    expect(parseExtraStacks('dr-crr-target@dr-region,dr-crr-role@app')).toEqual([{ id: 'dr-crr-target', region: 'dr-region' }, { id: 'dr-crr-role', region: 'app' }]);
    expect(() => parseExtraStacks('x@eu-west-1')).toThrow(CliError);
    expect(runtimeSetLines({ 'featureFlags.lab.faults': 'true' }).join('\n')).toContain('--arg sub lab.faults');
  });
});

describe('reports (PM-35) and helpers', () => {
  it('progress JSONL, result JSON and the reporting printer', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'atl-report-'));
    const r = new Reporter({ opId: ulid(), runId: 's4k7m2q9x1abc-apply-1-0', progressFile: path.join(dir, 'p.jsonl'), resultFile: path.join(dir, 'r.json'), command: 'enable cdn' });
    const pr = new ReportingPrinter(new CapturePrinter(), r);
    pr.section('plan: enable cdn (aws)');
    pr.step(3, 'deploy cloudalbum-e7k2m9qx-cdn');
    pr.warn('something');
    r.cfnFailures.push({ stack: 'cloudalbum-e7k2m9qx-cdn', logicalId: 'Distribution', status: 'CREATE_FAILED', reason: 'x' });
    const res = r.result(3);
    const lines = readFileSync(path.join(dir, 'p.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.phase)).toEqual(['plan', 'deploy-stack']);
    expect(lines[1]).toMatchObject({ module: 'cdn', status: 'progress', runId: 's4k7m2q9x1abc-apply-1-0', step: '3' });
    expect(res).toMatchObject({ schema: 'cloudalbum.module-result/v1', exitCode: 3, phase: 'deploy-stack', module: 'cdn', warnings: ['something'] });
    expect(JSON.parse(readFileSync(path.join(dir, 'r.json'), 'utf8')).cfnFailures).toHaveLength(1);
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('module-ops: signed POST with an Idempotency-Key; 5xx retried once; failures never throw', async () => {
    const p: PlatformEnv = { ...readPlatformEnv(ENV), opsReport: 'agent', agentApi: 'https://abc.execute-api.ap-northeast-1.amazonaws.com' };
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let status = 503;
    const fetchImpl = (async (url: URL, init: { headers: Record<string, string> }) => {
      seen.push({ url: String(url), headers: init.headers });
      return { status, ok: status < 300 } as Response;
    }) as unknown as typeof fetch;
    const body = { opId: '01J', phase: 'started' as const, command: 'enable', module: 'cdn', driver: null, profile: null, exitCode: null, at: 'x', runId: null };
    expect(await reportModuleOp(p, body, { fetchImpl, sign: async (r) => ({ ...r.headers, authorization: 'AWS4-HMAC-SHA256 …' }), log: () => undefined })).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe('https://abc.execute-api.ap-northeast-1.amazonaws.com/api/v1/agent/sessions/s4k7m2q9x1abc/module-ops');
    expect(seen[0]?.headers['idempotency-key']).toBe('01J-started');
    status = 202;
    expect(await reportModuleOp(p, body, { fetchImpl, sign: async (r) => r.headers })).toBe(true);
    const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await reportModuleOp(p, body, { fetchImpl: failing, sign: async (r) => r.headers, log: () => undefined })).toBe(false);
    expect(await reportModuleOp({ ...p, opsReport: 'off' }, body)).toBe(false);
  });

  it('seed passwords satisfy the Cognito default policy; destroy order: card stacks, modules (reverse), ec2, toolchain', () => {
    for (let i = 0; i < 20; i += 1) {
      const pw = seedPassword();
      expect(pw).toHaveLength(24);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
    const order = destroyOrder('e1', ['cloudalbum-e1-toolchain', 'cloudalbum-e1-ec2', 'cloudalbum-e1-iam', 'cloudalbum-e1-storage', 'cloudalbum-e1-image-processing', 'cloudalbum-e1-x-edge-cert']);
    expect(order[0]).toBe('cloudalbum-e1-x-edge-cert');
    expect(order.indexOf('cloudalbum-e1-image-processing')).toBeLessThan(order.indexOf('cloudalbum-e1-storage'));
    expect(order.indexOf('cloudalbum-e1-storage')).toBeLessThan(order.indexOf('cloudalbum-e1-iam'));
    expect(order.slice(-2)).toEqual(['cloudalbum-e1-ec2', 'cloudalbum-e1-toolchain']);
  });

  it('a runtime without --platform has no platform part (standalone behaviour unchanged)', () => {
    const out = new CapturePrinter();
    const ctx = createContext({ dryRun: true }, { aws: new DryRunGateway(out), out, repoRoot: REPO_ROOT, state: deployedState() });
    expect(ctx.platform).toBeUndefined();
    const rt = createPlatformRuntime(ctx, readPlatformEnv(ENV), { command: 'x' });
    expect(rt.store.key).toBe('e7k2m9qx/state.json');
  });
});
