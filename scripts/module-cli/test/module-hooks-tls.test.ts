// tls hook (wave1-route53-acm): manual prerequisite "domain", preflight acme-endpoint (TLS_ACME=on|off), the stacks per role
// (edge in us-east-1), the out-of-band ACME steps (domain validation, EAB, certbot over the delivery channel), disable cleanup.
// Everything runs in --dry-run or against a fake gateway: no AWS call is executed.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError } from '../src/printer.js';
import { createContext } from '../src/context.js';
import { DryRunGateway, type AwsCall, type AwsGateway } from '../src/aws.js';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import { CapturePrinter } from '../src/printer.js';
import { probeAcmeEndpoint, tlsHook } from '../src/module-hooks/tls.js';
import type { ModuleRecord } from '../src/state.js';
import { loadTemplate, mainTemplatePath } from '../src/template.js';
import { REPO_ROOT, RecordingDeliverer, deployedState, dryContext } from './helpers.js';

const stackCalls = (calls: AwsCall[]) => calls.filter((c) => c.service === 'cloudformation' && /Stack$/.test(c.op) && String(c.input.StackName).includes('-tls'));
const paramsOf = (call: AwsCall | undefined) =>
  Object.fromEntries(((call?.input.Parameters ?? []) as Array<{ ParameterKey: string; ParameterValue?: string }>).map((p) => [p.ParameterKey, p.ParameterValue]));

/** dry-run gateway that answers some read-only calls (still never talks to AWS) */
class ScriptedGateway extends DryRunGateway {
  constructor(private readonly answers: Record<string, (call: AwsCall) => unknown>, out?: CapturePrinter) { super(out); }
  override async send<T>(call: AwsCall): Promise<T | undefined> {
    this.calls.push(call);
    const f = this.answers[call.op];
    return f ? (f(call) as T) : undefined;
  }
}

function ctxWith(aws: AwsGateway, channel: 'ssh' | 'ssm' = 'ssh') {
  const out = new CapturePrinter();
  const deliverer = new RecordingDeliverer(true);
  (deliverer as { channel: string }).channel = channel;
  const ctx = createContext({ dryRun: true, yes: true, skipLocalCheck: true, state: path.join(REPO_ROOT, '.cloudalbum', 'never-written.json') },
    { aws, out, deliverer, repoRoot: REPO_ROOT, state: deployedState() });
  return { ctx, out, deliverer };
}

describe('tls hook: no own domain', () => {
  it('enable exits 2 with the hint (nothing deployed); plan skips with exit 0', async () => {
    const a = dryContext();
    expect(await enableCommand(a.ctx, 'tls', {})).toBe(2);
    expect(a.out.text()).toContain('scripts/module enable tls --domain album.example.com');
    expect(stackCalls(a.aws.calls)).toEqual([]);
    const b = dryContext();
    expect(await enableCommand(b.ctx, 'tls', { planOnly: true })).toBe(0);
    expect(b.out.text()).toContain('plan skipped: tls');
  });

  it('planHints: domain hint (and the fallback dependencies) only when the target has no TLS_DOMAIN', () => {
    expect(tlsHook.planHints!({ module: 'tls', value: 'acm', tier: 'aws', settings: { TLS_ACME: 'on' } }).join('\n')).toContain('需要自有域名');
    expect(tlsHook.planHints!({ module: 'tls', value: 'acm', tier: 'aws', settings: { TLS_ACME: 'off' } }).join('\n')).toContain('DEP-005 ③');
    expect(tlsHook.planHints!({ module: 'tls', value: 'acm', tier: 'aws', settings: { TLS_DOMAIN: 'album.example.com' } })).toEqual([]);
  });
});

describe('tls hook: ACME branch (TLS_ACME=on)', () => {
  it('dry-run: main stack with StackRole=main, domain validation, 1-day EAB, certbot over ssh with redacted EAB, EAB deleted', async () => {
    const { ctx, aws, deliverer, out } = dryContext();
    expect(await enableCommand(ctx, 'tls', { domain: 'album.example.com' })).toBe(0);
    const stacks = stackCalls(aws.calls);
    expect(stacks.map((c) => `${String(c.input.StackName)}@${c.region ?? 'default'}`)).toEqual(['cloudalbum-lab-tls@default']);
    expect(paramsOf(stacks[0])).toMatchObject({ StackRole: 'main', DomainName: 'album.example.com', AcmeEnabled: 'on' });
    const ops = aws.calls.filter((c) => c.service === 'acm').map((c) => c.op);
    expect(ops).toEqual(['ListAcmeEndpoints', 'DescribeAcmeDomainValidation', 'CreateAcmeExternalAccountBinding',
      'GetAcmeExternalAccountBindingCredentials', 'DeleteAcmeExternalAccountBinding', 'SearchCertificates']);
    expect(aws.calls.find((c) => c.op === 'CreateAcmeExternalAccountBinding')?.input).toMatchObject({ Expiration: { Value: 1, Type: 'DAYS' } });
    const issue = deliverer.scripts.find((s) => s.title.includes('certbot'))!;
    expect(issue.render()).toContain('host-setup.sh issue-acme --server');
    expect(issue.render()).toContain('--domain album.example.com');
    expect(ctx.state.modules.tls!.env).toMatchObject({ MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', TLS_ACME: 'on', TLS_FORCE_HTTPS: 'false' });
    expect(out.text()).toContain('按 TLS_ACME=on 计划');
    expect(ctx.state.outOfBand.map((x) => x.kind)).toEqual(expect.arrayContaining(['acme-endpoint', 'acme-domain-validation', 'acme-eab']));
    expect(ctx.state.outOfBand.find((x) => x.kind === 'acme-eab')?.detail?.deleted).toBe('true');
  });

  it('EAB credentials: ssh -> only inside the script and redacted in displays; SSM -> SecureString hand-off, never in the script', async () => {
    const answers = {
      CreateAcmeExternalAccountBinding: () => ({ ExternalAccountBinding: { AcmeExternalAccountBindingArn: 'arn:aws:acm:ap-northeast-1:1:eab/e1' } }),
      GetAcmeExternalAccountBindingCredentials: () => ({ KeyId: 'kid-123', MacKey: 'mac-secret-456' }),
      ListAcmeEndpoints: () => ({ AcmeEndpoints: [] }),
    };
    const ssh = ctxWith(new ScriptedGateway(answers));
    expect(await enableCommand(ssh.ctx, 'tls', { domain: 'album.example.com' })).toBe(0);
    const s1 = ssh.deliverer.scripts.find((s) => s.title.includes('certbot'))!;
    expect(s1.render()).toContain('mac-secret-456');
    expect(s1.display()).not.toContain('mac-secret-456');
    const gw = new ScriptedGateway(answers);
    const ssm = ctxWith(gw, 'ssm');
    expect(await enableCommand(ssm.ctx, 'tls', { domain: 'album.example.com' })).toBe(0);
    const s2 = ssm.deliverer.scripts.find((s) => s.title.includes('certbot'))!;
    expect(s2.render()).not.toContain('mac-secret-456');
    expect(s2.render()).toMatch(/--eab-param \/cloudalbum\/lab\/handoff\/tls-eab-[0-9a-f]+ --region ap-northeast-1/);
    const put = gw.calls.find((c) => c.op === 'PutParameter')!;
    expect(put.input).toMatchObject({ Type: 'SecureString' });
    expect(JSON.stringify(put.display)).not.toContain('mac-secret-456');
    expect(gw.calls.find((c) => c.op === 'DeleteParameter')?.input.Name).toBe(put.input.Name);
  });

  it('standalone + shell-access (SSM channel): the EAB hand-off parameter is readable through the shell-access instance policy (HandoffRead)', async () => {
    const answers = {
      CreateAcmeExternalAccountBinding: () => ({ ExternalAccountBinding: { AcmeExternalAccountBindingArn: 'arn:aws:acm:ap-northeast-1:1:eab/e1' } }),
      GetAcmeExternalAccountBindingCredentials: () => ({ KeyId: 'kid-123', MacKey: 'mac-secret-456' }),
      ListAcmeEndpoints: () => ({ AcmeEndpoints: [] }),
    };
    const state = deployedState();
    state.modules['shell-access'] = {
      tier: 'aws', value: 'ssm', version: 1, enabledAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', secretKeys: [],
      params: { ManagedCore: 'false' }, outputs: {}, env: { SHELL_ACCESS_MODE: 'ssm' },
      stacks: [{ name: 'main', stackName: 'cloudalbum-lab-shell-access', region: 'ap-northeast-1' }],
    } as unknown as ModuleRecord;
    const out = new CapturePrinter();
    const gw = new ScriptedGateway(answers, out);
    // no injected deliverer: the context picks the channel itself (shell-access enabled → SSM, standalone hand-off)
    const ctx = createContext({ dryRun: true, yes: true, skipLocalCheck: true, state: path.join(REPO_ROOT, '.cloudalbum', 'never-written.json') },
      { aws: gw, out, repoRoot: REPO_ROOT, state });
    expect(ctx.platform).toBeUndefined();
    expect(ctx.deliverer().channel).toBe('ssm');
    expect(await enableCommand(ctx, 'tls', { domain: 'album.example.com' })).toBe(0);
    const put = gw.calls.find((c) => c.op === 'PutParameter' && String(c.input.Name).includes('/handoff/tls-eab-'))!;
    const name = String(put.input.Name);
    const sent = gw.calls.filter((c) => c.op === 'SendCommand').map((c) => JSON.stringify(c.input));
    expect(sent.some((x) => x.includes(`--eab-param ${name}`))).toBe(true);
    expect(sent.join(' ')).not.toContain('mac-secret-456');

    // the instance policy of shell-access (least-privilege AgentCore, ManagedCore=false) lets the instance read that parameter
    const t = loadTemplate(REPO_ROOT, mainTemplatePath('shell-access'));
    const statements = ((t.Resources.AppPolicy?.Properties?.PolicyDocument as { Statement: unknown[] }).Statement)
      .filter((x): x is { Sid?: string; Action: string | string[]; Resource: { 'Fn::Sub': string } } => typeof x === 'object' && x !== null && 'Sid' in x);
    const read = statements.find((x) => x.Sid === 'HandoffRead');
    expect(read, 'HandoffRead must be unconditional (not inside Fn::If)').toBeDefined();
    expect([read!.Action].flat()).toContain('ssm:GetParameter');
    const arn = read!.Resource['Fn::Sub']
      .replace('${AWS::Partition}', 'aws').replace('${AWS::Region}', 'ap-northeast-1').replace('${AWS::AccountId}', '123456789012').replace('${Env}', 'lab');
    expect(arn).toBe('arn:aws:ssm:ap-northeast-1:123456789012:parameter/cloudalbum/lab/handoff/*');
    expect(`arn:aws:ssm:ap-northeast-1:123456789012:parameter${name}`.startsWith(arn.slice(0, -1))).toBe(true);
  });

  it('preflight acme-endpoint: an unavailable endpoint falls back to TLS_ACME=off (and then needs DEP-005 3)', async () => {
    const gw = new ScriptedGateway({ ListAcmeEndpoints: () => { throw Object.assign(new Error('UnknownOperationException'), { name: 'UnknownOperationException' }); } });
    const { ctx, out } = ctxWith(gw);
    expect((await probeAcmeEndpoint(ctx)).available).toBe(false);
    expect(await enableCommand(ctx, 'tls', { domain: 'lab.example.com' })).toBe(2);
    expect(out.text()).toContain('回退为 TLS_ACME=off');
    expect(out.text()).toContain('DEP-005');
  });
});

describe('tls hook: fallback branch (TLS_ACME=off)', () => {
  it('--no-acme with cdn and external DNS: only the edge stack, in us-east-1, StackRole=edge', async () => {
    const { ctx, aws } = dryContext();
    expect(await enableCommand(ctx, 'cdn', {})).toBe(0);
    expect(await enableCommand(ctx, 'dns', { driver: 'external', domain: 'lab.example.com' })).toBe(0);
    const before = aws.calls.length;
    expect(await enableCommand(ctx, 'tls', { domain: 'lab.example.com', acme: false })).toBe(0);
    const stacks = stackCalls(aws.calls.slice(before));
    expect(stacks.map((c) => `${String(c.input.StackName)}@${c.region ?? 'default'}`)).toEqual(['cloudalbum-lab-tls-edge@us-east-1']);
    expect(paramsOf(stacks[0])).toMatchObject({ StackRole: 'edge', AcmeEnabled: 'off' });
    expect(aws.calls.slice(before).filter((c) => c.service === 'acm')).toEqual([]);   // no ACME probe, no EAB
    expect(ctx.state.modules.tls!.env.TLS_ACME).toBe('off');
  });

  it('TLS_FORCE_HTTPS=true is refused while Nginx keeps the self-signed certificate (DEP-015)', async () => {
    const { ctx } = dryContext();
    expect(await enableCommand(ctx, 'cdn', {})).toBe(0);
    expect(await enableCommand(ctx, 'dns', { driver: 'external', domain: 'lab.example.com' })).toBe(0);
    await expect(enableCommand(ctx, 'tls', { domain: 'lab.example.com', acme: false, set: ['TLS_FORCE_HTTPS=true'] })).rejects.toThrow(CliError);
  });
});

describe('tls hook: disable', () => {
  it('purges the certbot lineage and account of the endpoint; optional revoke; out-of-band records cleared', async () => {
    const { ctx, deliverer } = dryContext();
    ctx.state.modules.tls = {
      tier: 'aws', value: 'acm', version: 1, enabledAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', secretKeys: [], params: {}, outputs: {},
      env: { MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', TLS_ACME: 'on',
        TLS_ACME_DIRECTORY_URL: 'https://acm-acme-enroll.ap-northeast-1.api.aws/e1/directory' },
      stacks: [{ name: 'main', stackName: 'cloudalbum-lab-tls', region: 'ap-northeast-1' }],
    } as unknown as ModuleRecord;
    ctx.state.outOfBand.push({ module: 'tls', kind: 'acme-endpoint', id: 'arn:x', at: '2026-10-14T00:00:00Z' });
    expect(await disableCommand(ctx, 'tls', { param: ['RevokeAcme=true'] })).toBe(0);
    const rendered = deliverer.scripts.map((s) => s.render()).join('\n');
    expect(rendered).toContain('host-setup.sh revoke-acme');
    expect(rendered).toContain('host-setup.sh purge-acme --server https://acm-acme-enroll.ap-northeast-1.api.aws/e1/directory');
    expect(ctx.state.outOfBand.filter((x) => x.module === 'tls')).toEqual([]);
  });
});
