/**
 * Module hooks of scripts/module (wave1-prep): the module-specific parts of plan / enable / disable for the wave 1 modules,
 * one file per module (module-hooks/<id>.ts), registered in module-hooks/index.ts. Everything that the registry can express
 * (stacks with region / when, injects, baseParams, ownsEnv, host artifacts) stays generic; a hook only adds what the module
 * document describes as special (examples: tls ACME probe + EAB + certbot, waf us-east-1 stack and the CloudFront association,
 * shell-access closing port 22, dns hosted-zone checks and the "no own domain" hint).
 *
 * Call order of `scripts/module enable <id>` (modular-design.md 9.2) and the hook points:
 *   1  plan check ............. plan()          settings (e.g. TLS_DOMAIN from --domain), notes, missing manual prerequisites
 *                                               (enable stops with exit 2 and the hint; `plan` prints the hint and skips the module)
 *   3  stack parameters ....... prepare()       params / secretParams / settings / remote steps / notes (same contract as the MVP
 *                                               hooks.ts prepareModule); preflight checks (registry `preflight`) belong here
 *      stacks to deploy ....... stacks()        default = registry stacks whose `when` holds (region from the registry); a hook
 *                                               adds per-stack parameters or drops a stack
 *   3b after the deployment ... afterDeploy()   out-of-band steps that need the outputs (EAB, IP-set import, tag activation, ...)
 *   4-11 generic: Outputs -> env, injects, baseParams, PolicyArn, delivery, restart, probes
 * `scripts/module disable <id>`: beforeDisable() before the env is removed (refuse, or keep base parameters such as
 * SshIngressCidr), afterDisable() after the stacks are deleted (cleanup of out-of-band resources, reminders).
 * `plan --start-of` / `profile gen-single`: planHints() (pure: no ctx, no AWS) adds warnings such as "needs your own domain".
 *
 * Rules for hooks:
 *   - Never call AWS directly: use ctx.aws.send() (prints instead of executing in --dry-run and returns undefined; treat
 *     undefined as "unknown" and fall back to ctx.ph(value, name) placeholders).
 *   - args.planOnly = `scripts/module plan`: read-only, never create out-of-band resources.
 *   - Secrets only in p.secrets / NoEcho parameters (D5); never in settings, notes or state.json.
 *   - Out-of-band resources are recorded in ctx.state.outOfBand (module, kind, id) so that disable / teardown can clean them up.
 */
import type { ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from '../context.js';
import type { ModuleTarget, PlanStep } from '../deps.js';
import type { EnvMap } from '../env-file.js';
import type { Prepared } from '../hooks.js';
import type { ModuleRecord } from '../state.js';

/** Module-specific command-line arguments of enable / plan / disable, passed through to the hooks. */
export interface HookArgs {
  /** --domain <name> (dns, tls; also email for the SES identity) */
  domain?: string;
  /** --zone-id <id> (dns: existing public hosted zone; tls: zone for the validation records) */
  zoneId?: string;
  /** --target eip|alb|cloudfront (dns) */
  target?: string;
  /** --no-acme gives false (tls: practise the exam form, TLS_ACME=off without probing) */
  acme?: boolean;
  /** --reopen-ssh (shell-access disable: restore SshIngressCidr explicitly, 9.2 disable step 5) */
  reopenSsh?: boolean;
  /** --param K=V of the target module (stack parameters; also available to dependency steps as {}) */
  params: Readonly<Record<string, string>>;
  /** `scripts/module plan` (and plan --single): read-only, no out-of-band resources */
  planOnly: boolean;
  /** true for the module the operator asked for, false for a dependency enabled by --with-deps / profile apply */
  isTarget: boolean;
}

export interface MissingPrerequisite {
  /** registry prerequisite name (domain, ses-identity, confirm-email, cost-allocation-tag, ...) */
  prerequisite: string;
  message: string;
  /** what to do, e.g. "scripts/module enable dns --domain album.example.com" */
  hint?: string;
}

export interface HookPlanResult {
  /** settings merged into the step (modules.d/<id>.env keys of this module, ownsEnv) */
  settings?: EnvMap;
  notes?: string[];
  /** manual prerequisites that are not met: enable exits 2 with the hint, plan prints it and skips the module (exit 0) */
  missing?: MissingPrerequisite[];
}

export interface StackPlan {
  /** registry stacks[].name (main, edge, regional, ...); CloudFormation name cloudalbum-<env>-<id>[-<name>] */
  name: string;
  /** repository-relative template path */
  template: string;
  /** resolved region (ctx.region unless the registry says otherwise, e.g. us-east-1) */
  region: string;
  /** per-stack parameters on top of the module parameters (e.g. Scope=CLOUDFRONT) */
  params?: Record<string, string>;
}

export interface DeployedStacks {
  /** outputs of every deployed stack merged in deployment order (a non-empty value wins over an empty one) */
  outputs: Record<string, string>;
  /** outputs per stack name */
  byStack: Record<string, Record<string, string>>;
  /** the stacks that were deployed */
  stacks: StackPlan[];
}

export interface HookDisableResult {
  /** base stack parameters that must keep their current value instead of being restored (e.g. SshIngressCidr without --reopen-ssh) */
  keepBaseParams?: string[];
  notes?: string[];
}

export interface ModuleHook {
  readonly id: ModuleId;
  /** pure and synchronous (plan --start-of, gen-single): warnings such as "needs your own domain (manual prerequisite)" */
  planHints?(target: ModuleTarget): string[];
  /** enable / plan step 1 */
  plan?(ctx: Ctx, step: PlanStep, args: HookArgs): Promise<HookPlanResult> | HookPlanResult;
  /** enable step 3 (before the stacks): parameters, secrets, settings, remote steps, preflight checks */
  prepare?(ctx: Ctx, step: PlanStep, args: HookArgs, p: Prepared): Promise<void> | void;
  /** enable step 3: adjust the stacks to deploy (selected = registry stacks whose `when` holds) */
  stacks?(ctx: Ctx, step: PlanStep, args: HookArgs, selected: StackPlan[], env: Readonly<EnvMap>): StackPlan[];
  /** enable step 3b: out-of-band steps after the deployment, before the env is delivered */
  afterDeploy?(ctx: Ctx, step: PlanStep, args: HookArgs, deployed: DeployedStacks, p: Prepared): Promise<void> | void;
  /** disable, before the env is removed (throw CliError to refuse) */
  beforeDisable?(ctx: Ctx, rec: ModuleRecord, args: HookArgs): Promise<HookDisableResult | void> | HookDisableResult | void;
  /** disable, after the stacks are deleted */
  afterDisable?(ctx: Ctx, rec: ModuleRecord, args: HookArgs): Promise<void> | void;
}
