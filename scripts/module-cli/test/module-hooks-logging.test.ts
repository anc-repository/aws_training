// wave1-logs-ssm: scripts/module hook of logging — shipper setting (sdk / agent), keys-mode refusal for the agent, reuse of
// retained log groups, the template contract (cfn conventions checked in templates.test) and a full dry-run enable / disable.
import { describe, expect, it } from 'vitest';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import { loggingHook, shipperOf } from '../src/module-hooks/logging.js';
import type { Prepared } from '../src/hooks.js';
import type { AwsCall, AwsGateway } from '../src/aws.js';
import { CapturePrinter, CliError } from '../src/printer.js';
import { createContext } from '../src/context.js';
import { loadTemplate, staticOutputValue } from '../src/template.js';
import type { PlanStep } from '../src/deps.js';
import { REPO_ROOT, RecordingDeliverer, deployedState, dryContext } from './helpers.js';

function withIam(mode: 'role' | 'keys' = 'role') {
  const s = deployedState();
  s.modules.iam = { enabledAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', tier: 'aws', value: mode, version: 1,
    env: { MODULE_IAM: 'on', IAM_CREDENTIALS: mode }, stacks: [], outputs: {}, params: {}, secretKeys: [] };
  s.iam = { mode, roleName: 'CloudAlbumAppRole', ...(mode === 'keys' ? { userName: 'cloudalbum-lab-demo-keys' } : {}) };
  return s;
}

class StubGateway implements AwsGateway {
  readonly dryRun = false;
  readonly calls: AwsCall[] = [];
  constructor(private readonly reply: (c: AwsCall) => unknown) {}
  async send<T>(call: AwsCall): Promise<T | undefined> {
    this.calls.push(call);
    return this.reply(call) as T;
  }
}

const step = (settings: Record<string, string> = {}): PlanStep => ({ module: 'logging', value: 'cloudwatch', tier: 'aws', settings, reason: 'requested', isTarget: true });
const prepared = (): Prepared => ({ params: {}, secretParams: [], secrets: {}, settings: {}, remote: [], notes: [] });

describe('logging hook', () => {
  it('shipperOf: --param Shipper wins, then --set LOG_CW_SHIPPER, default sdk; anything else is a usage error', () => {
    expect(shipperOf(step(), { params: {} })).toBe('sdk');
    expect(shipperOf(step({ LOG_CW_SHIPPER: 'agent' }), { params: {} })).toBe('agent');
    expect(shipperOf(step({ LOG_CW_SHIPPER: 'agent' }), { params: { Shipper: 'sdk' } })).toBe('sdk');
    expect(() => shipperOf(step(), { params: { Shipper: 'fluentd' } })).toThrow(CliError);
  });

  it('plan --dry-run: the preview writes LOG_CW_SHIPPER explicitly (sdk by default, agent with --param Shipper=agent)', async () => {
    const a = dryContext(withIam());
    expect(await enableCommand(a.ctx, 'logging', { planOnly: true })).toBe(0);
    expect(a.out.text()).toContain('LOG_CW_SHIPPER=sdk');
    expect(a.out.text()).toContain('LOG_DRIVER=cloudwatch');
    const b = dryContext(withIam());
    expect(await enableCommand(b.ctx, 'logging', { planOnly: true, param: ['Shipper=agent'] })).toBe(0);
    expect(b.out.text()).toContain('LOG_CW_SHIPPER=agent');
  });

  it('Shipper=agent in keys mode is refused with exit 2 (the CloudWatch Agent only uses the instance profile)', async () => {
    const a = dryContext(withIam('keys'));
    await expect(enableCommand(a.ctx, 'logging', { planOnly: true, param: ['Shipper=agent'] })).rejects.toMatchObject({ exitCode: 2, code: 'DEP-AGENT-ROLE' });
    const b = dryContext(withIam('keys'));
    expect(await enableCommand(b.ctx, 'logging', { planOnly: true })).toBe(0);   // sdk works with keys (CRED-002 warn)
  });

  it('enable / disable --dry-run: stack with Shipper, env, injects-ready outputs, PolicyArn, hostSetup; disable lists the retained groups', async () => {
    const { ctx, out, aws, deliverer } = dryContext(withIam());
    expect(await enableCommand(ctx, 'logging', { param: ['RetentionInDays=14'] })).toBe(0);
    const deploy = aws.calls.find((c) => c.service === 'cloudformation' && /Stack$/.test(c.op) && c.op !== 'DescribeStacks' && String(c.input.StackName) === 'cloudalbum-lab-logging');
    expect(deploy).toBeDefined();
    const params = JSON.stringify(deploy!.input.Parameters ?? deploy!.display ?? {});
    expect(params).toContain('Shipper');
    expect(params).toContain('RetentionInDays');
    expect(ctx.state.modules.logging?.env).toMatchObject({ MODULE_LOGGING: 'on', LOG_DRIVER: 'cloudwatch', LOG_CW_SHIPPER: 'sdk' });
    expect(deliverer.scripts.some((s) => s.display().includes('run-hostsetup.sh logging apply'))).toBe(true);
    expect(await disableCommand(ctx, 'logging', {})).toBe(0);
    expect(out.text()).toContain('/cloudalbum/lab/app and /cloudalbum/lab/nginx are kept (DeletionPolicy Retain)');
  });

  it('prepare: retained log groups are reused (CreateLogGroups=false); a single retained group is an error', async () => {
    const mk = (groups: string[]) => {
      const aws = new StubGateway((c) => (c.op === 'DescribeLogGroups' ? { logGroups: groups.map((logGroupName) => ({ logGroupName })) } : {}));
      return createContext({ yes: true, skipLocalCheck: true, state: `${REPO_ROOT}/.cloudalbum/never-written.json` },
        { aws, out: new CapturePrinter(), deliverer: new RecordingDeliverer(false), repoRoot: REPO_ROOT, state: withIam() });
    };
    let p = prepared();
    await loggingHook.prepare!(mk(['/cloudalbum/lab/app', '/cloudalbum/lab/nginx', '/cloudalbum/lab/ssm-sessions']), step(), { params: {}, planOnly: false, isTarget: true }, p);
    expect(p.params).toMatchObject({ Shipper: 'sdk', CreateLogGroups: 'false' });
    expect(p.notes.join('\n')).toContain('reusing the log groups');
    p = prepared();
    await loggingHook.prepare!(mk([]), step(), { params: {}, planOnly: false, isTarget: true }, p);
    expect(p.params.CreateLogGroups).toBeUndefined();
    await expect(loggingHook.prepare!(mk(['/cloudalbum/lab/app']), step(), { params: {}, planOnly: false, isTarget: true }, prepared()))
      .rejects.toMatchObject({ code: 'LOG_GROUP_PARTIAL' });
  });

  it('template: Env outputs map to the LOG_CW_* keys, enum outputs are static for the dry-run plan, injection param is optional', () => {
    const t = loadTemplate(REPO_ROOT, 'infra/modules/logging.yaml');
    expect(Object.keys(t.Outputs)).toEqual(expect.arrayContaining(['PolicyArn', 'EnvLogDriver', 'EnvLogCwShipper', 'EnvLogCwGroupApp', 'EnvLogCwGroupNginx', 'EnvLogCwRetentionDays', 'InfoMetricNamespace']));
    expect(staticOutputValue(t, 'EnvLogCwShipper')).toBe('sdk');
    expect(staticOutputValue(t, 'EnvLogCwShipper', { Shipper: 'agent' })).toBe('agent');
    expect(staticOutputValue(t, 'InfoMetricNamespace')).toBe('CloudAlbum/Logs');
    expect(t.Parameters.KmsKeyArn).toMatchObject({ Default: '' });
    for (const g of ['AppLogGroup', 'NginxLogGroup']) expect(t.Resources[g]).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });
});
