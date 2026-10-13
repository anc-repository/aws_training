/**
 * `scripts/module profile apply|diff|gen-single` (modular-design.md 10.1, 10.4):
 *   apply: target set vs current set -> disable extra modules in reverse topological order (data migrated back), then
 *          enable missing modules in topological order (+ orderBefore), re-enable modules whose value / settings /
 *          stack parameters changed; finally CLOUDALBUM_PROFILE and labBypassEnabled on the instance.
 *   diff : print that plan only.   gen-single <id>|--all : (re)generate profiles/single/<id>.env.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from './context.js';
import { ensureBase } from './context.js';
import { orderSteps, planEnable, type ModuleTarget, type PlanStep } from './deps.js';
import { RemoteScript } from './deliver.js';
import { disableCommand } from './disable.js';
import { enableStep } from './enable.js';
import { registryEdges } from './meta.js';
import { CliError, EXIT } from './printer.js';
import { generateSingleProfile, loadProfileFile, profilePath, resolveProfile } from './profiles.js';
import { IMPLEMENTED_MODULES, parseModuleId } from './registry.js';
import { currentEnv, recordHistory } from './state.js';

export interface ProfilePlan {
  disable: ModuleId[];
  enable: PlanStep[];
  update: PlanStep[];
  unchanged: ModuleId[];
}

function sameSettings(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  return Object.entries(a).every(([k, v]) => b[k] === v);
}

export function planProfile(ctx: Ctx, name: string, opts: { withOptional?: boolean } = {}): { plan: ProfilePlan; resolved: ReturnType<typeof resolveProfile> } {
  const resolved = resolveProfile((n) => loadProfileFile(ctx.repoRoot, n), name, opts);
  const current = ctx.state.modules;
  const edges = registryEdges();
  const disable = Object.keys(current).filter((id) => {
    const want = resolved.targets.get(id as ModuleId);
    const have = current[id as ModuleId]!;
    return !want || want.tier !== have.tier || want.value !== have.value;
  }) as ModuleId[];
  const disableOrdered = orderSteps(disable.map((module) => ({ module })), edges).map((s) => s.module).reverse();
  const toStep = (t: ModuleTarget, reason: string): PlanStep => ({ ...t, reason, isTarget: true });
  const enable: PlanStep[] = [];
  const update: PlanStep[] = [];
  const unchanged: ModuleId[] = [];
  for (const [id, t] of resolved.targets) {
    const have = current[id];
    const params = resolved.params[id] ?? {};
    if (!have || disable.includes(id)) enable.push(toStep(t, `profile ${name}`));
    else if (!sameSettings(t.settings, have.env) || !sameSettings(params, have.params)) update.push(toStep(t, `profile ${name}: settings / parameters changed`));
    else unchanged.push(id);
  }
  return {
    plan: { disable: disableOrdered, enable: orderSteps(enable, edges), update, unchanged },
    resolved,
  };
}

export async function profileDiff(ctx: Ctx, name: string, opts: { withOptional?: boolean }): Promise<number> {
  const { plan, resolved } = planProfile(ctx, name, opts);
  printProfilePlan(ctx, name, plan, resolved.prerequisites, resolved.hourlyBilled);
  return EXIT.ok;
}

function printProfilePlan(ctx: Ctx, name: string, plan: ProfilePlan, prerequisites: string[], hourly: ModuleId[]): void {
  ctx.out.section(`profile ${name}${ctx.dryRun ? ' [dry-run]' : ''}`);
  ctx.out.info(`  disable (reverse topological): ${plan.disable.join(', ') || '-'}`);
  ctx.out.info(`  enable  (topological):         ${plan.enable.map((s) => `${s.module}=${s.value}${s.tier !== 'aws' ? `(${s.tier})` : ''}`).join(', ') || '-'}`);
  ctx.out.info(`  update  (stack / env change):  ${plan.update.map((s) => s.module).join(', ') || '-'}`);
  ctx.out.info(`  unchanged:                     ${plan.unchanged.join(', ') || '-'}`);
  if (prerequisites.length) ctx.out.warn(`  manual prerequisites: ${prerequisites.join(', ')}`);
  if (hourly.length) ctx.out.warn(`  billed per hour: ${hourly.join(', ')} (no amounts; see the official pricing pages)`);
}

export async function profileApply(ctx: Ctx, name: string, opts: { withOptional?: boolean; migrate?: boolean }): Promise<number> {
  await ensureBase(ctx);
  const { plan, resolved } = planProfile(ctx, name, opts);
  printProfilePlan(ctx, name, plan, resolved.prerequisites, resolved.hourlyBilled);
  for (const s of [...plan.enable, ...plan.update]) {
    if (!IMPLEMENTED_MODULES.includes(s.module)) throw new CliError(`profile ${name}: ${s.module} is not implemented in this round`, EXIT.rules);
  }
  // credentials prerequisite (10.1): required modules in a profile need iam(role) in the same profile
  const envAfter = { ...currentEnv(ctx.state) };
  for (const s of plan.enable) {
    const check = planEnable(envAfter, s, {});
    const cred = check.issues.find((i) => i.rule === 'CRED-001' && !resolved.targets.has('iam'));
    if (cred) throw new CliError(`profile ${name}: ${cred.message} — the profile must include iam (IAM_CREDENTIALS=role)`, EXIT.rules);
  }

  for (const id of plan.disable) {
    const code = await disableCommand(ctx, id, { cascade: true, ...(opts.migrate === false ? { migrate: false } : {}) });
    if (code !== EXIT.ok) return code;
  }
  for (const step of [...plan.enable, ...plan.update]) {
    const params = Object.entries(resolved.params[step.module] ?? {}).map(([k, v]) => `${k}=${v}`);
    const code = await enableStep(ctx, step, { param: params, ...(opts.migrate === false ? { migrate: false } : {}) });
    if (code !== EXIT.ok) return code;
  }
  const s = new RemoteScript(`profile ${name}`);
  s.line('ca_be=$(readlink -f /etc/cloudalbum/cloudalbum.env); ca_tmp=$(mktemp "$(dirname "$ca_be")/.base.XXXXXX")',
    `{ grep -v '^CLOUDALBUM_PROFILE=' "$ca_be" || true; echo 'CLOUDALBUM_PROFILE=${name}'; } > "$ca_tmp"`,
    'chown root:cloudalbum "$ca_tmp"; chmod 0640 "$ca_tmp"; mv -f "$ca_tmp" "$ca_be"',
    `/usr/local/sbin/cloudalbum-runtime set labBypassEnabled ${resolved.labBypass === 'on' ? 'true' : 'false'}`,
    'systemctl restart cloudalbum-api cloudalbum-worker');
  await ctx.deliverer().run(s);
  ctx.state.profile = name;
  ctx.state.baseConfig.CLOUDALBUM_PROFILE = name;
  recordHistory(ctx.state, { op: 'profile apply', module: name, result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok });
  ctx.save();
  if (name === 'l0-ec2') ctx.out.info('next: L0 smoke test  ->  npm run exp -- ec2 --scenario smoke --label l0 (total outline 2.9)');
  return EXIT.ok;
}

export function genSingle(repoRoot: string, ids: readonly string[], out: (l: string) => void): void {
  const list = ids.includes('--all') || ids.includes('all') ? [...IMPLEMENTED_MODULES] : ids.map((x) => parseModuleId(x));
  for (const id of list) {
    const file = profilePath(repoRoot, `single/${id}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, generateSingleProfile(id));
    out(`wrote ${path.relative(repoRoot, file)}`);
  }
}
