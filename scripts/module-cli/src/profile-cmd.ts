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
import { existsSync, readFileSync } from 'node:fs';
import { generateSingleProfile, loadProfileFile, parseProfile, profilePath, resolveProfile } from './profiles.js';
import { IMPLEMENTED_MODULES, parseModuleId, registryVersion, stackName } from './registry.js';
import { currentEnv, nowIso, recordHistory } from './state.js';
import { parseEnvFile, splitList } from './env-file.js';
import { containsPlaceholder, isAtlProfileName, normalizeProfileName, parseExtraStacks } from './plan-start.js';
import { atlProfileFile } from './platform-cmds.js';
import { tlsPreviewCommand } from './platform/tls-preview.js';
import { deployStack, stackTags } from './stack.js';
import { shq } from './deliver.js';

export interface ProfilePlan {
  disable: ModuleId[];
  enable: PlanStep[];
  update: PlanStep[];
  unchanged: ModuleId[];
}

function sameSettings(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  return Object.entries(a).every(([k, v]) => b[k] === v);
}

/** the raw text of a profile (atl profiles: the working directory first, where the runner puts the content release) */
export function profileText(ctx: Pick<Ctx, 'repoRoot'>, name: string): { name: string; file: string; text: string } {
  const n = normalizeProfileName(name);
  const file = isAtlProfileName(n) ? atlProfileFile(ctx.repoRoot, n) : profilePath(ctx.repoRoot, n);
  if (!existsSync(file)) throw new CliError(`profile ${n} not found (${file})`, EXIT.rules, 'PROFILE_NOT_FOUND');
  return { name: n, file, text: readFileSync(file, 'utf8') };
}

export function planProfile(ctx: Ctx, nameArg: string, opts: { withOptional?: boolean; mode?: 'fresh' | 'additive' } = {}): { plan: ProfilePlan; resolved: ReturnType<typeof resolveProfile> } {
  const top = profileText(ctx, nameArg);
  const name = top.name;
  const resolved = resolveProfile((n) => (n === name ? parseProfile(top.text, n) : loadProfileFile(ctx.repoRoot, n)), name, opts);
  const current = ctx.state.modules;
  const edges = registryEdges();
  // --mode additive (reused environments, 02 §8.4): only enable missing modules and update parameters, never disable
  const disable = (opts.mode === 'additive' ? [] : Object.keys(current).filter((id) => {
    const want = resolved.targets.get(id as ModuleId);
    const have = current[id as ModuleId]!;
    return !want || want.tier !== have.tier || want.value !== have.value;
  })) as ModuleId[];
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

/** runtime.json hot keys of an atl start profile (PROFILE_RUNTIME, 06 PM-33): `featureFlags.<flag>` or a top-level key */
export function runtimeSetLines(entries: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    if (!/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9._-]+)?$/.test(key)) throw new CliError(`PROFILE_RUNTIME: invalid key ${key}`, EXIT.rules, 'PROFILE_INVALID');
    const value = raw === 'true' || raw === 'false' || /^-?[0-9]+(\.[0-9]+)?$/.test(raw) ? raw : JSON.stringify(raw);
    const dot = key.indexOf('.');
    const filter = dot === -1 ? '.[$k] = $v' : '.[$top] = ((.[$top] // {}) | .[$sub] = $v)';
    lines.push(
      'ca_rt=$(readlink -f /etc/cloudalbum/runtime.json); ca_tmp=$(mktemp "$(dirname "$ca_rt")/.runtime.XXXXXX")',
      `{ [ -s "$ca_rt" ] && cat "$ca_rt" || echo '{}'; } | jq --arg k ${shq(key)} --arg top ${shq(dot === -1 ? key : key.slice(0, dot))} --arg sub ${shq(dot === -1 ? '' : key.slice(dot + 1))} --argjson v ${shq(value)} ${shq(filter)} > "$ca_tmp"`,
      'chown root:cloudalbum "$ca_tmp"; chmod 0640 "$ca_tmp"; mv -f "$ca_tmp" "$ca_rt"',
    );
  }
  return lines;
}

export async function profileApply(ctx: Ctx, nameArg: string, opts: { withOptional?: boolean; migrate?: boolean; mode?: 'fresh' | 'additive'; repair?: boolean }): Promise<number> {
  const top = profileText(ctx, nameArg);
  const name = top.name;
  const fields = parseEnvFile(top.text);
  // placeholders are replaced by the runner on a temporary copy before profile apply (02 §3.6); never apply them literally
  const placeholders = Object.entries(fields).filter(([, v]) => containsPlaceholder(v)).map(([k]) => k);
  if (placeholders.length) throw new CliError(`profile ${name}: unreplaced platform placeholder(s) in ${placeholders.join(', ')}`, EXIT.rules, 'PROFILE_PLACEHOLDER');
  parseExtraStacks(fields.PROFILE_EXTRA_STACKS);   // format check only: the runner deploys them (ATL_OP=extra-stack)
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

  const rep = ctx.platform?.reporter;
  for (const id of plan.disable) {
    const code = await disableCommand(ctx, id, { cascade: true, ...(opts.migrate === false ? { migrate: false } : {}) });
    if (code !== EXIT.ok) return code;
    rep?.changed.disabled.push(id);
  }
  for (const step of [...plan.enable, ...plan.update]) {
    const params = Object.entries(resolved.params[step.module] ?? {}).map(([k, v]) => `${k}=${v}`);
    const code = await enableStep(ctx, step, { param: params, ...(opts.migrate === false ? { migrate: false } : {}) });
    if (code !== EXIT.ok) return code;
    (plan.update.includes(step) ? rep?.changed.updated : rep?.changed.enabled)?.push(step.module);
  }
  // PROFILE_BASE_PARAMS (atl start profiles, e.g. SshIngressCidr for the workstation): base stack parameters
  const kv = (raw: string | undefined) => Object.fromEntries(splitList(raw).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  const changedBase = Object.entries(kv(fields.PROFILE_BASE_PARAMS)).filter(([k, v]) => (ctx.state.base?.params[k] ?? '') !== v);
  if (changedBase.length) {
    ctx.out.section(`profile ${name}: base stack parameters ${changedBase.map(([k]) => k).join(', ')}`);
    await deployStack(ctx.aws, ctx.out, ctx.repoRoot, { stackName: stackName(ctx.env, 'ec2'), template: 'infra/modules/ec2.yaml',
      params: Object.fromEntries(changedBase), tags: stackTags(ctx.env, 'ec2', registryVersion('ec2')) });
    if (ctx.state.base) for (const [k, v] of changedBase) ctx.state.base.params[k] = v;
    ctx.save();
  }
  const s = new RemoteScript(`profile ${name}`);
  s.line('ca_be=$(readlink -f /etc/cloudalbum/cloudalbum.env); ca_tmp=$(mktemp "$(dirname "$ca_be")/.base.XXXXXX")',
    `{ grep -v '^CLOUDALBUM_PROFILE=' "$ca_be" || true; echo 'CLOUDALBUM_PROFILE=${name}'; } > "$ca_tmp"`,
    'chown root:cloudalbum "$ca_tmp"; chmod 0640 "$ca_tmp"; mv -f "$ca_tmp" "$ca_be"',
    `/usr/local/sbin/cloudalbum-runtime set labBypassEnabled ${resolved.labBypass === 'on' ? 'true' : 'false'}`,
    ...runtimeSetLines(kv(fields.PROFILE_RUNTIME)),
    'systemctl restart cloudalbum-api cloudalbum-worker');
  await ctx.deliverer().run(s);
  ctx.state.profile = name;
  ctx.state.baseConfig.CLOUDALBUM_PROFILE = name;
  if (ctx.platform && ctx.state.platform) {
    ctx.state.platform.lastApply = { profile: name, digest: fields.PROFILE_PLAN_DIGEST ?? '', mode: opts.mode ?? 'fresh', at: nowIso(),
      by: ctx.platform.identity?.sessionName ?? '?' };
  }
  recordHistory(ctx.state, { op: 'profile apply', module: name, result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok,
    ...(ctx.platform ? { opId: ctx.platform.opId, ...(ctx.platform.identity ? { actor: ctx.platform.identity.sessionName } : {}), runId: ctx.platform.env.runId ?? null } : {}) });
  ctx.save();
  // platform preview scheme B (06 PM-21): after every module; a failed issuance never fails the profile; seeds are NOT run here
  const preview = kv(fields.PROFILE_PLATFORM)['preview.directHttps'];
  if (ctx.platform && preview === 'on' && (ctx.state.baseConfig.DEPLOY_MODE ?? 'single') === 'single' && ctx.state.platform?.preview?.status !== 'issued') {
    await tlsPreviewCommand(ctx, 'on');
  } else if (ctx.platform && preview === 'off' && ctx.state.platform?.preview?.status === 'issued' && opts.mode !== 'additive') {
    await tlsPreviewCommand(ctx, 'off');
  }
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
