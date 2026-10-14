/**
 * scripts/module hook of logging (wave1-logs-ssm). Contract: ./types.ts.
 * Design: docs/modules/05-ops-observability.md#logging (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * Beyond the generic flow (stack, Outputs -> env, injects LogErrorsNamespace -> monitoring, PolicyArn, hostSetup, restart):
 *   - plan: the shipper (`--param Shipper=sdk|agent`, or `--set LOG_CW_SHIPPER=…`) is written explicitly as LOG_CW_SHIPPER so that
 *     the preview, the stack parameter and the env agree; Shipper=agent needs IAM_CREDENTIALS=role (05 convention 2: the
 *     CloudWatch Agent only uses the instance profile, no second credential file) — refused with exit 2 in keys mode.
 *   - prepare: the log groups are data resources (DeletionPolicy Retain). Enabling again after a disable would collide with the
 *     retained /cloudalbum/<env>/app and /nginx groups, so the hook looks them up and passes CreateLogGroups=false to reuse them.
 *   - disable: reminds that the retained log groups keep their data until the retention period ends (delete commands printed).
 * No out-of-band resources; the agent fragment is a hostSetup artifact (infra/modules/logging/host-setup.sh).
 */
import type { Ctx } from '../context.js';
import type { PlanStep } from '../deps.js';
import type { Prepared } from '../hooks.js';
import { CliError, EXIT } from '../printer.js';
import { currentEnv } from '../state.js';
import type { HookArgs, HookPlanResult, ModuleHook } from './types.js';

export const SHIPPERS = ['sdk', 'agent'] as const;
export type Shipper = (typeof SHIPPERS)[number];

/** Shipper of this operation: --param Shipper, then --set LOG_CW_SHIPPER, then the current env, default sdk. */
export function shipperOf(step: Pick<PlanStep, 'settings'>, args: Pick<HookArgs, 'params'>, env: Readonly<Record<string, string>> = {}): Shipper {
  const v = args.params.Shipper ?? step.settings.LOG_CW_SHIPPER ?? env.LOG_CW_SHIPPER ?? 'sdk';
  if (!(SHIPPERS as readonly string[]).includes(v)) throw new CliError(`logging: Shipper must be sdk or agent (got "${v}")`, EXIT.rules, 'USAGE');
  return v as Shipper;
}

export function logGroupNames(env: string): { app: string; nginx: string } {
  return { app: `/cloudalbum/${env}/app`, nginx: `/cloudalbum/${env}/nginx` };
}

/**
 * Existing log groups among `names` (DescribeLogGroups by prefix). undefined = unknown (dry-run). Shared with the shell-access
 * hook (session log group).
 */
export async function existingLogGroups(ctx: Ctx, prefix: string, names: readonly string[]): Promise<Set<string> | undefined> {
  const r = await ctx.aws.send<{ logGroups?: Array<{ logGroupName?: string }> }>({
    service: 'logs', op: 'DescribeLogGroups', input: { logGroupNamePrefix: prefix, limit: 50 },
  });
  if (r === undefined) return undefined;
  const found = new Set((r.logGroups ?? []).map((g) => g.logGroupName ?? ''));
  return new Set(names.filter((n) => found.has(n)));
}

export const loggingHook: ModuleHook = {
  id: 'logging',

  planHints(target) {
    return target.settings.LOG_CW_SHIPPER === 'agent'
      ? ['logging: LOG_CW_SHIPPER=agent installs the CloudWatch Agent and needs IAM_CREDENTIALS=role (keys mode is refused)']
      : [];
  },

  plan(ctx, step, args): HookPlanResult {
    const env = currentEnv(ctx.state);
    const shipper = shipperOf(step, args, step.tier === 'aws' && ctx.state.modules.logging ? ctx.state.modules.logging.env : {});
    const notes: string[] = [];
    if (shipper === 'agent') {
      const creds = env.IAM_CREDENTIALS ?? 'none';
      if (creds === 'keys') {
        throw new CliError('logging: Shipper=agent needs IAM_CREDENTIALS=role — the CloudWatch Agent only uses the instance profile and never reads '
          + 'IAM_KEYS_* from secrets.env (05 convention 2). Use the default Shipper=sdk, or `scripts/module enable iam --mode role` first', EXIT.rules, 'DEP-AGENT-ROLE');
      }
      notes.push('Shipper=agent: hostSetup installs amazon-cloudwatch-agent and appends the logging fragment (rendered as cloudalbum-logging.json); '
        + 'the application only writes the local files');
    }
    if (ctx.platform) notes.push('platform mode: the log groups belong to the logging stack (/cloudalbum/<env>/…); platform log groups are never touched');
    return { settings: { LOG_CW_SHIPPER: shipper }, notes };
  },

  async prepare(ctx, step, args, p: Prepared) {
    if (step.tier !== 'aws') return;
    p.params.Shipper = shipperOf(step, args);
    p.settings.LOG_CW_SHIPPER = p.params.Shipper;
    const prev = ctx.state.modules.logging;
    if (prev?.tier === 'aws' && prev.params.CreateLogGroups) {
      p.params.CreateLogGroups = prev.params.CreateLogGroups;      // stack update: keep how the groups were obtained
      return;
    }
    const names = logGroupNames(ctx.env);
    const found = await existingLogGroups(ctx, `/cloudalbum/${ctx.env}/`, [names.app, names.nginx]);
    if (found === undefined) return;                                // dry-run: assume a first enable
    if (found.size === 2) {
      p.params.CreateLogGroups = 'false';
      p.notes.push(`logging: reusing the log groups retained by an earlier disable (${names.app}, ${names.nginx}); their retention and encryption stay as they are`);
    } else if (found.size === 1) {
      const [one] = [...found];
      throw new CliError(`logging: only ${one} exists (retained earlier); the stack creates both groups. Delete it (aws logs delete-log-group --log-group-name ${one}) `
        + 'or create the other one, then enable again', EXIT.rules, 'LOG_GROUP_PARTIAL');
    }
  },

  beforeDisable(ctx, rec) {
    const g = logGroupNames(ctx.env);
    const notes = [`the log groups ${g.app} and ${g.nginx} are kept (DeletionPolicy Retain) until their retention ends; `
      + `delete them with: aws logs delete-log-group --log-group-name ${g.app} && aws logs delete-log-group --log-group-name ${g.nginx}`];
    if (rec.env.LOG_CW_SHIPPER === 'agent') notes.push('hostSetup revert removes the logging fragment from the CloudWatch Agent (the agent stops when no fragment is left)');
    return { notes };
  },
};
