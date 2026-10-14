/**
 * scripts/module hook of monitoring. Contract: ./types.ts.
 * Design: docs/modules/05-ops-observability.md#monitoring (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12
 * platform mode). What this module needs beyond the generic flow:
 *   - --param AlertEmail=<address> (stack parameter; the e-mail subscription of the module's own ops-alarms topic) and the
 *     confirm-email manual prerequisite: without AlertEmail the alarms are only visible in the console and on /lab.
 *   - --param Mode=putmetricdata|emf: emf needs the CloudWatch Agent, i.e. IAM_CREDENTIALS=role (05 convention 2).
 *   - IAM_CREDENTIALS=keys: the Agent fragment is refused by host-setup.sh (memory / disk metrics and EMF unavailable; CRED-002).
 *   - --param DetailedMonitoring=true: forwarded to the base stack by the registry baseParams (billed per instance).
 *   - After the deployment: remind the recipient to confirm the SNS subscription (sns:GetTopicAttributes shows the pending count).
 * The Agent fragment, the hostSetup apply / revert and the injects into audit / backup are generic (registry driven).
 * Platform mode: no out-of-band call (registry platform.outOfBand would be empty); the alarm e-mail is the learner input notify-email.
 */
import { CliError, EXIT } from '../printer.js';
import { currentEnv } from '../state.js';
import type { ModuleHook } from './types.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODES = ['putmetricdata', 'emf'] as const;

/**
 * Manual prerequisites, printed by plan() (enable / plan / plan --single). Deliberately not returned by planHints(): hints become
 * `plan --start-of` warnings, which labs:derive (DRV-6) only accepts when they are rule ids listed in expectedWarnings.
 */
export const MONITORING_PREREQ_NOTE = 'manual prerequisite confirm-email: pass --param AlertEmail=<address> and click the SNS confirmation link, otherwise alarms are only visible in the console and on /lab';

export const monitoringHook: ModuleHook = {
  id: 'monitoring',

  plan(ctx, step, args) {
    const notes: string[] = [];
    if (step.tier !== 'aws') return {};
    const p = args.params;
    if (p.Mode !== undefined && !(MODES as readonly string[]).includes(p.Mode)) {
      throw new CliError(`monitoring: --param Mode must be ${MODES.join(' | ')} (got "${p.Mode}")`, EXIT.rules, 'PARAM_INVALID');
    }
    if (p.AlertEmail !== undefined && p.AlertEmail !== '' && !EMAIL_RE.test(p.AlertEmail)) {
      throw new CliError(`monitoring: --param AlertEmail is not an e-mail address ("${p.AlertEmail}")`, EXIT.rules, 'PARAM_INVALID');
    }
    if (args.isTarget && !p.AlertEmail) {
      notes.push('no --param AlertEmail: the ops-alarms topic gets no subscription, alarms are only visible in the console and on /lab');
    } else if (args.isTarget) {
      notes.push(MONITORING_PREREQ_NOTE);
    }
    const creds = currentEnv(ctx.state).IAM_CREDENTIALS ?? 'none';
    if (creds === 'keys') {
      notes.push('IAM_CREDENTIALS=keys: the CloudWatch Agent fragment is not delivered (the agent only uses the instance profile) — no memory / disk metrics, no EMF; monitoring will be degraded (CRED-002)');
    }
    if (p.Mode === 'emf') {
      notes.push('Mode=emf: metrics go through the local CloudWatch Agent (tcp://127.0.0.1:25888) and CloudWatch Logs (/cloudalbum/<env>/metrics-emf, log ingestion is billed); needs IAM_CREDENTIALS=role');
      if (creds !== 'role' && creds !== 'none') {
        throw new CliError(`monitoring: Mode=emf needs IAM_CREDENTIALS=role (now ${creds}); use Mode=putmetricdata or scripts/module enable iam --mode role`, EXIT.rules, 'EMF_NEEDS_ROLE');
      }
    }
    if (p.DetailedMonitoring === 'true') notes.push('DetailedMonitoring=true: 1-minute EC2 metrics are billed per instance (official pricing page; no amounts here)');
    notes.push('custom metrics, alarms, dashboards beyond the free number and GetMetricData calls are billed by usage (official pricing page; no amounts here)');
    return { notes };
  },

  prepare(_ctx, step, args, prep) {
    if (step.tier !== 'aws') return;
    if (args.params.AlertEmail) {
      prep.notes.push(`after the deployment: open the mailbox of ${args.params.AlertEmail} and confirm the SNS subscription (manual prerequisite confirm-email)`);
    }
  },

  async afterDeploy(ctx, step, args, deployed) {
    if (step.tier !== 'aws' || args.planOnly) return;
    const topic = deployed.outputs.EnvMetricsCwAlarmTopicArn;
    if (!topic) return;
    const r = await ctx.aws.send<{ Attributes?: Record<string, string> }>({ service: 'sns', op: 'GetTopicAttributes', input: { TopicArn: topic } })
      .catch(() => undefined);
    const pending = Number(r?.Attributes?.SubscriptionsPending ?? NaN);
    if (pending > 0) ctx.out.warn(`      monitoring: ${pending} subscription(s) of ${topic} wait for confirmation — click the link in the e-mail; until then the probe reports degraded`);
    if (deployed.outputs.InfoDashboardUrl) ctx.out.info(`      dashboard: ${deployed.outputs.InfoDashboardUrl}`);
  },

  beforeDisable(_ctx, rec) {
    const notes = ['custom metrics that were already published cannot be deleted; they expire by the retention schedule once nothing publishes them'];
    if (rec.params.DetailedMonitoring === 'true') notes.push('DetailedMonitoring goes back to false on the base stack (registry baseParams)');
    notes.push('the alarms, the dashboard and the ops-alarms topic are deleted with the stack; audit / backup lose the injected AlarmTopicArn first');
    return { notes };
  },
};
