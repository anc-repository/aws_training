// monitoring hook (module-hooks/monitoring.ts) + the generic flow with the real infra/modules/monitoring.yaml (dry-run only)
import { describe, expect, it } from 'vitest';
import { disableCommand } from '../src/disable.js';
import { enableCommand } from '../src/enable.js';
import { MONITORING_PREREQ_NOTE, monitoringHook } from '../src/module-hooks/monitoring.js';
import { loadLab, planStartOf } from '../src/plan-start.js';
import { loadTemplate, staticOutputValue } from '../src/template.js';
import { REPO_ROOT, deployedState, dryContext } from './helpers.js';

/** parameters of every CreateOrUpdateStack call of a stack, later calls win */
const stackParams = (calls: Array<{ op: string; input: Record<string, unknown> }>, stack: string) => Object.fromEntries(
  calls.filter((x) => x.op === 'CreateOrUpdateStack' && x.input.StackName === stack)
    .flatMap((c) => (c.input.Parameters ?? []) as Array<{ ParameterKey: string; ParameterValue: string }>)
    .map((p) => [p.ParameterKey, p.ParameterValue]));

describe('monitoring: enable / disable (dry-run)', () => {
  it('deploys the stack with AlertEmail, Mode and the base context InstanceId; injected parameters default to \'\'; DetailedMonitoring goes to the base stack', async () => {
    const { ctx, out, aws, deliverer } = dryContext();
    expect(await enableCommand(ctx, 'monitoring', { withDeps: true, param: ['AlertEmail=ops@example.com', 'DetailedMonitoring=true'] })).toBe(0);
    const p = stackParams(aws.calls, 'cloudalbum-lab-monitoring');
    expect(p).toMatchObject({ Env: 'lab', ModuleVersion: '1', InstanceId: 'i-0123456789abcdef0', AlertEmail: 'ops@example.com', DetailedMonitoring: 'true' });
    for (const k of ['KmsKeyArn', 'LogErrorsNamespace', 'AlbFullName', 'DbInstanceId', 'QueueName', 'StateMachineArn']) expect(p[k]).toBe('');
    expect(stackParams(aws.calls, 'cloudalbum-lab-ec2')).toMatchObject({ DetailedMonitoring: 'true' });
    expect(ctx.state.modules.monitoring?.env).toMatchObject({ MODULE_MONITORING: 'on', METRICS_DRIVER: 'cloudwatch', METRICS_CW_MODE: 'putmetricdata', METRICS_CW_NAMESPACE: 'CloudAlbum/App' });
    expect(out.text()).toContain('confirm the SNS subscription');
    expect(aws.calls.some((c) => c.service === 'sns' && c.op === 'GetTopicAttributes')).toBe(true);
    // the delivery runs the hostSetup (CloudWatch Agent fragment)
    expect(deliverer.scripts.map((x) => x.render()).join('\n')).toContain('run-hostsetup.sh monitoring apply');

    expect(await disableCommand(ctx, 'monitoring', {})).toBe(0);
    expect(aws.calls.filter((c) => c.op === 'DeleteStack').map((c) => c.input.StackName)).toContain('cloudalbum-lab-monitoring');
    expect(out.text()).toContain('cannot be deleted');
    expect(out.text()).toContain('baseParams DetailedMonitoring: true -> false');
  });

  it('without AlertEmail: a note (alarms only in the console); invalid Mode or e-mail: exit 2 before anything is deployed', async () => {
    const a = dryContext();
    expect(await enableCommand(a.ctx, 'monitoring', { withDeps: true, planOnly: true })).toBe(0);
    expect(a.out.text()).toContain('no --param AlertEmail');
    const b = dryContext();
    await expect(enableCommand(b.ctx, 'monitoring', { withDeps: true, param: ['Mode=statsd'] })).rejects.toMatchObject({ exitCode: 2 });
    await expect(enableCommand(b.ctx, 'monitoring', { withDeps: true, param: ['AlertEmail=nope'] })).rejects.toMatchObject({ exitCode: 2 });
    expect(b.aws.calls.filter((c) => c.op === 'CreateOrUpdateStack')).toEqual([]);
  });

  it('Mode=emf needs IAM_CREDENTIALS=role (keys is refused); keys mode notes that the Agent fragment is not delivered', async () => {
    const s = deployedState();
    s.modules.iam = { tier: 'aws', value: 'keys', env: { MODULE_IAM: 'on', IAM_CREDENTIALS: 'keys' } } as never;
    const { ctx, out } = dryContext(s);
    await expect(enableCommand(ctx, 'monitoring', { param: ['Mode=emf'] })).rejects.toMatchObject({ exitCode: 2 });
    const k = dryContext(s);
    expect(await enableCommand(k.ctx, 'monitoring', { planOnly: true })).toBe(0);
    expect(k.out.text()).toContain('the CloudWatch Agent fragment is not delivered');
    void out;
  });

  it('plan --start-of svc-monitoring: L0 + iam(role) + lab.faults, no warnings (labs:derive DRV-6); the prerequisite is a plan note', async () => {
    const r = planStartOf(loadLab(REPO_ROOT, 'svc-monitoring'), { repoRoot: REPO_ROOT });
    expect(r.warnings).toEqual([]);
    expect(monitoringHook.planHints).toBeUndefined();
    const { ctx, out } = dryContext();
    expect(await enableCommand(ctx, 'monitoring', { withDeps: true, planOnly: true, param: ['AlertEmail=ops@example.com'] })).toBe(0);
    expect(out.text()).toContain(MONITORING_PREREQ_NOTE);
  });

  it('template: static Env* outputs for the dry-run preview (Mode default putmetricdata, namespace CloudAlbum/App)', () => {
    const t = loadTemplate(REPO_ROOT, 'infra/modules/monitoring.yaml');
    expect(staticOutputValue(t, 'EnvMetricsDriver')).toBe('cloudwatch');
    expect(staticOutputValue(t, 'EnvMetricsCwMode')).toBe('putmetricdata');
    expect(staticOutputValue(t, 'EnvMetricsCwMode', { Mode: 'emf' })).toBe('emf');
    expect(staticOutputValue(t, 'EnvMetricsCwNamespace')).toBe('CloudAlbum/App');
    // heartbeat alarms: missing data is breaching (process dead or instance stopped)
    for (const a of ['AppHeartbeatAlarm', 'WorkerHeartbeatAlarm']) {
      expect(t.Resources[a]?.Properties).toMatchObject({ TreatMissingData: 'breaching', Statistic: 'SampleCount', ComparisonOperator: 'LessThanThreshold' });
    }
    // recover only on the system status check; the composite alarm only notifies
    expect(JSON.stringify(t.Resources.Ec2StatusSystemAlarm?.Properties?.AlarmActions)).toContain('ec2:recover');
    expect(JSON.stringify(t.Resources.AppUnhealthyAlarm?.Properties?.AlarmActions)).not.toContain('recover');
    // PutMetricData only into the module's namespaces
    expect(JSON.stringify(t.Resources.AppPolicy?.Properties)).toContain('"cloudwatch:namespace":["CloudAlbum/App","CWAgent"]');
  });
});
