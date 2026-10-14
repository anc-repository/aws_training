// wave1-logs-ssm: scripts/module hook of shell-access — KEEP_SSH setting, the anti lock-out order of enable (PolicyArn attached,
// agent Online and a Run Command smoke test before SshIngressCidr is cleared), session preferences backup / restore, the
// rollback when SSM does not come up, and disable with / without --reopen-ssh.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AwsCall, AwsGateway } from '../src/aws.js';
import { createContext, type Ctx } from '../src/context.js';
import type { Deliverer, RemoteResult, RemoteScript } from '../src/deliver.js';
import type { PlanStep } from '../src/deps.js';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import {
  MANAGED_CORE_ARN, SESSION_DOCUMENT, keepSshOf, renderSessionPreferences, sessionLogGroupEncrypted, shellAccessDeps, shellAccessHook,
} from '../src/module-hooks/shell-access.js';
import { CapturePrinter } from '../src/printer.js';
import type { CloudAlbumState } from '../src/state.js';
import { loadTemplate, staticOutputValue } from '../src/template.js';
import { REPO_ROOT, RecordingDeliverer, deployedState, dryContext } from './helpers.js';

const INSTANCE = 'i-0123456789abcdef0';

function withIam(): CloudAlbumState {
  const s = deployedState();
  s.modules.iam = { enabledAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', tier: 'aws', value: 'role', version: 1,
    env: { MODULE_IAM: 'on', IAM_CREDENTIALS: 'role' }, stacks: [], outputs: {}, params: {}, secretKeys: [] };
  s.iam = { mode: 'role', roleName: 'CloudAlbumAppRole' };
  s.base!.params.SshIngressCidr = '203.0.113.10/32';
  return s;
}

class StubGateway implements AwsGateway {
  readonly dryRun = false;
  readonly calls: AwsCall[] = [];
  constructor(private readonly reply: (c: AwsCall) => unknown) {}
  async send<T>(call: AwsCall): Promise<T | undefined> {
    this.calls.push(call);
    const r = this.reply(call);
    if (r instanceof Error) throw r;
    return (r ?? {}) as T;
  }
}

class FakeDeliverer implements Deliverer {
  readonly channel = 'ssm' as const;
  readonly dryRun = false;
  readonly scripts: RemoteScript[] = [];
  constructor(private readonly result: RemoteResult = { code: 0, stdout: 'uid=0(root)\nactive\n', stderr: '' }) {}
  async run(script: RemoteScript): Promise<RemoteResult> {
    this.scripts.push(script);
    return this.result;
  }
}

const saved = { ...shellAccessDeps };
afterEach(() => Object.assign(shellAccessDeps, saved));

function realCtx(aws: AwsGateway, state = withIam()): { ctx: Ctx; out: CapturePrinter; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ca-shell-'));
  const out = new CapturePrinter();
  const ctx = createContext({ yes: true, skipLocalCheck: true, state: path.join(dir, 'state.json') },
    { aws, out, deliverer: new RecordingDeliverer(false), repoRoot: REPO_ROOT, state });
  return { ctx, out, dir };
}

const step = (settings: Record<string, string> = {}): PlanStep => ({ module: 'shell-access', value: 'ssm', tier: 'aws', settings, reason: 'requested', isTarget: true });
const deployed = {
  outputs: { PolicyArn: 'arn:aws:iam::123456789012:policy/cloudalbum-lab-shell-access', EnvShellAccessMode: 'ssm',
    EnvSsmSessionLogGroup: '/cloudalbum/lab/ssm-sessions', EnvSsmSessionRunAs: 'cloudalbum-ops', InfoManagedCore: 'false' },
  byStack: {}, stacks: [],
};

describe('shell-access hook · plan', () => {
  it('SHELL_ACCESS_KEEP_SSH is always written: false by default, true with --param KeepSsh=true', async () => {
    expect(keepSshOf(step(), { params: {} })).toBe('false');
    expect(keepSshOf(step(), { params: { KeepSsh: 'TRUE' } })).toBe('true');
    expect(() => keepSshOf(step(), { params: { KeepSsh: 'maybe' } })).toThrow('KeepSsh');
    const a = dryContext(withIam());
    expect(await enableCommand(a.ctx, 'shell-access', { planOnly: true })).toBe(0);
    expect(a.out.text()).toContain('SHELL_ACCESS_KEEP_SSH=false');
    expect(a.out.text()).toContain('SHELL_ACCESS_MODE=ssm');
  });

  it('DEP-001: without iam(role) enable stops with exit 2', async () => {
    const a = dryContext(deployedState());
    expect(await enableCommand(a.ctx, 'shell-access', {})).toBe(2);
    expect(a.out.text()).toContain('DEP-001');
  });
});

describe('shell-access hook · enable (dry-run end to end)', () => {
  it('order: PolicyArn attached and the SSM checks run before the base stack closes port 22; preferences written; env has KEEP_SSH', async () => {
    const { ctx, aws, deliverer } = dryContext(withIam());
    expect(await enableCommand(ctx, 'shell-access', {})).toBe(0);
    const ops = aws.calls.map((c) => `${c.service}:${c.op}${c.input.StackName ? `:${String(c.input.StackName)}` : ''}`);
    const attach = ops.findIndex((o) => o === 'iam:AttachRolePolicy');
    const online = ops.findIndex((o) => o === 'ssm:DescribeInstanceInformation');
    const smoke = ops.findIndex((o) => o === 'ssm:SendCommand');
    const prefs = ops.findIndex((o) => o === 'ssm:UpdateDocument');
    const base = aws.calls.findIndex((c) => c.service === 'cloudformation' && /Stack$/.test(c.op) && c.op !== 'DescribeStacks'
      && String(c.input.StackName) === 'cloudalbum-lab-ec2');
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(online).toBeGreaterThan(attach);
    expect(smoke).toBeGreaterThan(online);
    expect(prefs).toBeGreaterThan(smoke);
    expect(base).toBeGreaterThan(prefs);
    expect(JSON.stringify(aws.calls[base]!.input)).toContain('SshIngressCidr');
    expect(ctx.state.modules['shell-access']?.env).toMatchObject({ MODULE_SHELL_ACCESS: 'on', SHELL_ACCESS_MODE: 'ssm', SHELL_ACCESS_KEEP_SSH: 'false' });
    expect(ctx.state.base?.params.SshIngressCidr).toBe('');
    expect(ctx.state.baseParams.SshIngressCidr).toMatchObject({ value: '', original: '203.0.113.10/32', by: ['shell-access'] });
    // the step-7 delivery (hostSetup: cloudalbum-ops + sudoers) goes through the context deliverer
    expect(deliverer.scripts.some((s) => s.display().includes('run-hostsetup.sh shell-access apply'))).toBe(true);
  });

  it('--param KeepSsh=true: the base stack is not touched (SshIngressCidr stays)', async () => {
    const { ctx, aws } = dryContext(withIam());
    expect(await enableCommand(ctx, 'shell-access', { param: ['KeepSsh=true'] })).toBe(0);
    expect(aws.calls.some((c) => c.service === 'cloudformation' && String(c.input.StackName) === 'cloudalbum-lab-ec2' && /^(Create|Update|CreateOrUpdate)Stack$/.test(c.op))).toBe(false);
    expect(ctx.state.modules['shell-access']?.env.SHELL_ACCESS_KEEP_SSH).toBe('true');
  });
});

describe('shell-access hook · afterDeploy (stubbed AWS)', () => {
  it('waits until Online, smoke-tests Run Command, backs up and updates the preferences with a new default version', async () => {
    let pings = 0;
    const aws = new StubGateway((c) => {
      if (c.op === 'DescribeInstanceInformation') return { InstanceInformationList: [{ InstanceId: INSTANCE, PingStatus: (pings += 1) < 3 ? 'ConnectionLost' : 'Online', AgentVersion: '3.3.1' }] };
      if (c.op === 'GetDocument') return { Content: JSON.stringify({ inputs: { cloudWatchLogGroupName: '' } }), DocumentVersion: '2' };
      if (c.op === 'DescribeDocument') return { Document: { DefaultVersion: '2' } };
      if (c.op === 'UpdateDocument') return { DocumentDescription: { DocumentVersion: '3' } };
      return {};
    });
    const smoke = new FakeDeliverer();
    const ssh = new FakeDeliverer();
    Object.assign(shellAccessDeps, { ssm: () => smoke, ssh: () => ssh, sleep: async () => undefined });
    const { ctx } = realCtx(aws);
    await shellAccessHook.afterDeploy!(ctx, step({ SHELL_ACCESS_KEEP_SSH: 'false' }), { params: {}, planOnly: false, isTarget: true }, deployed,
      { params: {}, secretParams: [], secrets: {}, settings: {}, remote: [], notes: [] });
    expect(ssh.scripts[0]!.display()).toContain('systemctl restart amazon-ssm-agent');
    expect(pings).toBe(3);
    expect(smoke.scripts[0]!.display()).toContain('systemctl is-active cloudalbum-api');
    const update = aws.calls.find((c) => c.op === 'UpdateDocument')!;
    expect(update.input).toMatchObject({ Name: SESSION_DOCUMENT, DocumentVersion: '$LATEST' });
    expect(JSON.parse(String(update.input.Content)).inputs).toMatchObject({ cloudWatchLogGroupName: '/cloudalbum/lab/ssm-sessions', runAsDefaultUser: 'cloudalbum-ops', cloudWatchEncryptionEnabled: false });
    expect(aws.calls.find((c) => c.op === 'UpdateDocumentDefaultVersion')!.input).toEqual({ Name: SESSION_DOCUMENT, DocumentVersion: '3' });
    const oob = ctx.state.outOfBand.find((o) => o.kind === 'ssm-session-preferences')!;
    expect(oob.detail).toMatchObject({ existed: 'true', previousDefaultVersion: '2', version: '3' });
    expect(JSON.parse(readFileSync(oob.detail!.backup!, 'utf8'))).toMatchObject({ existed: true, defaultVersion: '2' });
    expect(ctx.state.backups[0]).toMatchObject({ type: 'ssm-document', id: SESSION_DOCUMENT });
    expect(ctx.state.attachments.map((a) => a.policyArn)).toEqual([deployed.outputs.PolicyArn]);
  });

  it('the document does not exist yet: CreateDocument (type Session); the backup says existed=false', async () => {
    const aws = new StubGateway((c) => {
      if (c.op === 'DescribeInstanceInformation') return { InstanceInformationList: [{ PingStatus: 'Online' }] };
      if (c.op === 'GetDocument') return Object.assign(new Error('ssm:GetDocument failed: InvalidDocument: does not exist'), { name: 'InvalidDocument' });
      return {};
    });
    Object.assign(shellAccessDeps, { ssm: () => new FakeDeliverer(), ssh: () => new FakeDeliverer(), sleep: async () => undefined });
    const { ctx } = realCtx(aws);
    await shellAccessHook.afterDeploy!(ctx, step(), { params: { ManagedCore: 'true' }, planOnly: false, isTarget: true }, deployed,
      { params: {}, secretParams: [], secrets: {}, settings: {}, remote: [], notes: [] });
    expect(aws.calls.find((c) => c.op === 'CreateDocument')!.input).toMatchObject({ Name: SESSION_DOCUMENT, DocumentType: 'Session' });
    expect(ctx.state.outOfBand.find((o) => o.kind === 'ssm-session-preferences')!.detail).toMatchObject({ existed: 'false' });
    expect(aws.calls.filter((c) => c.op === 'AttachRolePolicy').map((c) => c.input.PolicyArn)).toEqual([deployed.outputs.PolicyArn, MANAGED_CORE_ARN]);
  });

  it('the agent never comes Online: attachments rolled back, exit 5, port 22 untouched', async () => {
    let t = 0;
    const aws = new StubGateway((c) => (c.op === 'DescribeInstanceInformation' ? { InstanceInformationList: [] } : {}));
    Object.assign(shellAccessDeps, { ssm: () => new FakeDeliverer(), ssh: () => new FakeDeliverer(), sleep: async () => { t += 10_000; }, now: () => t });
    const { ctx } = realCtx(aws);
    await expect(shellAccessHook.afterDeploy!(ctx, step(), { params: {}, planOnly: false, isTarget: true }, deployed,
      { params: {}, secretParams: [], secrets: {}, settings: {}, remote: [], notes: [] })).rejects.toMatchObject({ exitCode: 5, code: 'SSM_NOT_READY' });
    expect(aws.calls.filter((c) => c.op === 'DetachRolePolicy').map((c) => c.input.PolicyArn)).toEqual([deployed.outputs.PolicyArn]);
    expect(ctx.state.attachments).toEqual([]);
    expect(aws.calls.some((c) => c.service === 'cloudformation')).toBe(false);
    expect(aws.calls.some((c) => c.op === 'UpdateDocument' || c.op === 'CreateDocument')).toBe(false);
  });

  it('the Run Command smoke test fails: rolled back, exit 5', async () => {
    const aws = new StubGateway((c) => (c.op === 'DescribeInstanceInformation' ? { InstanceInformationList: [{ PingStatus: 'Online' }] } : {}));
    Object.assign(shellAccessDeps, { ssm: () => new FakeDeliverer({ code: 1, stdout: '', stderr: 'inactive' }), ssh: () => new FakeDeliverer(), sleep: async () => undefined });
    const { ctx } = realCtx(aws);
    await expect(shellAccessHook.afterDeploy!(ctx, step(), { params: {}, planOnly: false, isTarget: true }, deployed,
      { params: {}, secretParams: [], secrets: {}, settings: {}, remote: [], notes: [] })).rejects.toMatchObject({ exitCode: 5 });
    expect(aws.calls.some((c) => c.op === 'DetachRolePolicy')).toBe(true);
  });

  it('renderSessionPreferences: KMS injected -> encrypted log group, kmsKeyId', () => {
    const doc = JSON.parse(renderSessionPreferences(REPO_ROOT, { logGroup: '/cloudalbum/lab/ssm-sessions', runAs: 'cloudalbum-ops', kmsKeyArn: 'arn:aws:kms:ap-northeast-1:1:key/x' }));
    expect(doc.inputs).toMatchObject({ cloudWatchEncryptionEnabled: true, kmsKeyId: 'arn:aws:kms:ap-northeast-1:1:key/x', idleSessionTimeout: '20', maxSessionDuration: '120' });
  });

  it('a reused log group without KMS: session data still uses kmsKeyId, but cloudWatchEncryptionEnabled stays false (wave1-fix)', async () => {
    const doc = JSON.parse(renderSessionPreferences(REPO_ROOT, { logGroup: '/cloudalbum/lab/ssm-sessions', runAs: 'cloudalbum-ops', kmsKeyArn: 'arn:aws:kms:ap-northeast-1:1:key/x', logGroupEncrypted: false }));
    expect(doc.inputs).toMatchObject({ cloudWatchEncryptionEnabled: false, kmsKeyId: 'arn:aws:kms:ap-northeast-1:1:key/x' });
    const gw = (groups: Array<{ logGroupName: string; kmsKeyId?: string }>): AwsGateway => ({
      dryRun: false, calls: [] as AwsCall[],
      async send<T>() { return { logGroups: groups } as T; },
    }) as unknown as AwsGateway;
    const { ctx } = dryContext();
    const name = '/cloudalbum/lab/ssm-sessions';
    expect(await sessionLogGroupEncrypted(ctx, name, true, '')).toBe(false);
    expect(await sessionLogGroupEncrypted(ctx, name, true, 'arn:k')).toBe(true);
    expect(await sessionLogGroupEncrypted({ ...ctx, aws: gw([{ logGroupName: name }]) } as Ctx, name, false, 'arn:k')).toBe(false);
    expect(await sessionLogGroupEncrypted({ ...ctx, aws: gw([{ logGroupName: name, kmsKeyId: 'arn:k' }]) } as Ctx, name, false, 'arn:k')).toBe(true);
  });

  it('the operator policy document carries the optional SessionDataKms statement (kms:GenerateDataKey on the session key)', () => {
    const doc = JSON.parse(readFileSync(path.join(REPO_ROOT, 'infra/modules/shell-access/operator-policy.json'), 'utf8')) as { Statement: Array<Record<string, unknown>> };
    expect(doc.Statement.find((s) => s.Sid === 'SessionDataKms')).toEqual({ Sid: 'SessionDataKms', Effect: 'Allow', Action: 'kms:GenerateDataKey', Resource: '${KmsKeyArn}' });
  });
});

describe('shell-access hook · disable', () => {
  it('port 22 closed and no --reopen-ssh: refused (no channel would be left)', async () => {
    const { ctx } = dryContext(withIam());
    expect(await enableCommand(ctx, 'shell-access', {})).toBe(0);
    await expect(disableCommand(ctx, 'shell-access', {})).rejects.toMatchObject({ code: 'REOPEN_SSH_REQUIRED' });
  });

  it('--reopen-ssh: SshIngressCidr restored before the env is removed; the record is dropped; channel back to ssh', async () => {
    const { ctx, aws, deliverer } = dryContext(withIam());
    expect(await enableCommand(ctx, 'shell-access', {})).toBe(0);
    const before = aws.calls.length;
    expect(await disableCommand(ctx, 'shell-access', { reopenSsh: true })).toBe(0);
    const calls = aws.calls.slice(before);
    const reopen = calls.findIndex((c) => c.service === 'cloudformation' && String(c.input.StackName) === 'cloudalbum-lab-ec2' && /^(Create|Update|CreateOrUpdate)Stack$/.test(c.op));
    expect(reopen).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(calls[reopen]!.input)).toContain('203.0.113.10/32');
    expect(ctx.state.base?.params.SshIngressCidr).toBe('203.0.113.10/32');
    expect(ctx.state.baseParams.SshIngressCidr).toBeUndefined();
    expect(ctx.state.delivery.channel).toBe('ssh');
    expect(deliverer.scripts.some((s) => s.display().includes('run-hostsetup.sh shell-access revert'))).toBe(true);
  });

  it('--reopen-ssh with a new operator IP: --param SshIngressCidr; ssh verification failure closes 22 again and keeps the module', async () => {
    const aws = new StubGateway((c) => (c.op === 'DescribeStacks'
      ? { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Parameters: [{ ParameterKey: 'SshIngressCidr', ParameterValue: '' }], Outputs: [], Tags: [] }] } : {}));
    Object.assign(shellAccessDeps, { ssh: () => new FakeDeliverer({ code: 255, stdout: '', stderr: 'Connection timed out' }) });
    const state = withIam();
    state.base!.params.SshIngressCidr = '';
    state.baseParams.SshIngressCidr = { value: '', original: '203.0.113.10/32', by: ['shell-access'], at: '2026-10-14T00:00:00Z' };
    const { ctx } = realCtx(aws, state);
    const rec = { tier: 'aws', value: 'ssm', env: { SHELL_ACCESS_MODE: 'ssm', SHELL_ACCESS_KEEP_SSH: 'false' }, params: {}, outputs: {}, stacks: [], secretKeys: [] } as never;
    await expect(shellAccessHook.beforeDisable!(ctx, rec, { params: { SshIngressCidr: '198.51.100.7/32' }, planOnly: false, isTarget: true, reopenSsh: true }))
      .rejects.toMatchObject({ code: 'REOPEN_SSH_FAILED' });
    const sets = aws.calls.filter((c) => /^(Create|Update)Stack$/.test(c.op)).map((c) => JSON.stringify(c.input.Parameters));
    expect(sets[0]).toContain('198.51.100.7/32');
    expect(sets[1]).toContain('"ParameterValue":""');
    await expect(shellAccessHook.beforeDisable!(ctx, rec, { params: { SshIngressCidr: '0.0.0.0/0' }, planOnly: false, isTarget: true, reopenSsh: true }))
      .rejects.toMatchObject({ code: 'REOPEN_SSH_CIDR' });
  });

  it('restores the preferences from the outOfBand record (default version, or delete when it did not exist)', async () => {
    const aws = new StubGateway(() => ({}));
    const state = withIam();
    state.outOfBand.push({ module: 'shell-access', kind: 'ssm-session-preferences', id: SESSION_DOCUMENT, at: 'x', detail: { existed: 'true', previousDefaultVersion: '2', backup: 'b.json' } });
    const { ctx } = realCtx(aws, state);
    const rec = { tier: 'aws', value: 'ssm', env: { SHELL_ACCESS_KEEP_SSH: 'true' }, params: {}, outputs: {}, stacks: [], secretKeys: [] } as never;
    const r = await shellAccessHook.beforeDisable!(ctx, rec, { params: {}, planOnly: false, isTarget: true });
    expect(aws.calls.find((c) => c.op === 'UpdateDocumentDefaultVersion')!.input).toEqual({ Name: SESSION_DOCUMENT, DocumentVersion: '2' });
    expect(ctx.state.outOfBand).toEqual([]);
    expect((r as { keepBaseParams?: string[] }).keepBaseParams).toEqual(['SshIngressCidr']);
    state.outOfBand.push({ module: 'shell-access', kind: 'ssm-session-preferences', id: SESSION_DOCUMENT, at: 'x', detail: { existed: 'false' } });
    await shellAccessHook.beforeDisable!(ctx, rec, { params: {}, planOnly: false, isTarget: true });
    expect(aws.calls.some((c) => c.op === 'DeleteDocument')).toBe(true);
  });
});

describe('shell-access template', () => {
  it('one managed policy, PolicyArn + Env outputs, static mode for the dry-run plan, retained session log group', () => {
    const t = loadTemplate(REPO_ROOT, 'infra/modules/shell-access.yaml');
    expect(staticOutputValue(t, 'EnvShellAccessMode')).toBe('ssm');
    expect(staticOutputValue(t, 'EnvSsmSessionRunAs')).toBe('cloudalbum-ops');
    expect(t.Resources.SessionLogGroup).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    expect(t.Parameters.KmsKeyArn).toMatchObject({ Default: '' });
    expect(Object.values(t.Resources).filter((r) => r.Type === 'AWS::IAM::ManagedPolicy')).toHaveLength(1);
    const doc = JSON.stringify(t.Resources.AppPolicy!.Properties);
    for (const a of ['ssm:UpdateInstanceInformation', 'ssmmessages:OpenDataChannel', 'ssm:DescribeInstanceInformation', 'ec2:DescribeSecurityGroups', 'ssm:DescribeSessions']) expect(doc).toContain(a);
    // Parameter Store: only the one-time hand-off parameters (secrets.env upsert / tls EAB over SSM, wave1-fix), never the whole store
    expect(doc).not.toMatch(/ssm:GetParameters|ssm:GetParametersByPath|ssm:\*/);
    const stmts = (t.Resources.AppPolicy!.Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    const withGet = stmts.filter((x) => JSON.stringify(x).includes('ssm:GetParameter'));
    expect(withGet).toEqual([{
      Sid: 'HandoffRead', Effect: 'Allow', Action: 'ssm:GetParameter',
      Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/cloudalbum/${Env}/handoff/*' },
    }]);
  });
});

describe('shell-access hostSetup: sudoers fragment', () => {
  const hasBash = spawnSync('bash', ['--version']).status === 0;
  it.skipIf(!hasBash)('lists exact commands only: no wildcard in any argument list, --no-pager always present (wave1-fix)', () => {
    const r = spawnSync('bash', [path.join(REPO_ROOT, 'infra/modules/shell-access/host-setup.sh'), 'render'],
      { encoding: 'utf8', env: { ...process.env, CLOUDALBUM_MODULE_ENV: path.join(os.tmpdir(), 'no-such-shell-access.env') } });
    expect(r.status, r.stderr).toBe(0);
    const rules = r.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    const read = rules.find((l) => l.startsWith('Cmnd_Alias CA_OPS_READ = '))!;
    const commands = read.slice('Cmnd_Alias CA_OPS_READ = '.length).split(', ');
    for (const c of commands) {
      expect(c).not.toMatch(/[*?[\]]/);
      expect(c).toContain('--no-pager');
      expect(c).toMatch(/^\/usr\/bin\/(systemctl|journalctl) .*cloudalbum-(api|worker)/);
    }
    expect(commands).toContain('/usr/bin/journalctl -u cloudalbum-api --no-pager');
    expect(commands).toContain('/usr/bin/systemctl status cloudalbum-api --no-pager');   // the command of the card (40-session)
    // what the review showed: other units, journal rewriting, pager-less forms are not in the list (sudo needs an exact match)
    for (const bad of ['/usr/bin/journalctl -u cloudalbum-api --vacuum-time=1s', '/usr/bin/journalctl -u cloudalbum-api -u sshd --no-pager',
      '/usr/bin/journalctl --rotate', '/usr/bin/journalctl -u cloudalbum-api', '/usr/bin/systemctl status cloudalbum-api']) {
      expect(commands).not.toContain(bad);
    }
    expect(rules.join(' ')).not.toMatch(/cloudalbum-\*/);
    expect(rules).toContain('cloudalbum-ops ALL=(root) NOPASSWD: NOEXEC: CA_OPS_READ');
  });
});
