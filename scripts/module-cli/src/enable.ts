/**
 * `scripts/module enable <id>` (modular-design.md 9.2):
 *   1 plan check (dependencies, credentials, staged check-config --plan)   2 confirmation (hourly billing, prerequisites)
 *   3 deploy the module stack (base context + provider injects + secretParams)   4 Outputs -> env, secrets -> secrets.env;
 *   4b provider injects into enabled targets, baseParams -> base stack   5 attach PolicyArn   6 data migration
 *   7 deliver modules.d/<id>.env (+ .bak) and host artifacts   8 check-config on the instance   9 restart
 *   10 health probes (rollback on failure: exit 5)   11 state.json + next steps
 * Local tiers (--driver memory|worker, --self-hosted) skip 3-5 and do not write MODULE_<ID>=on.
 */
import { createInterface } from 'node:readline/promises';
import { isParamSwitch, type ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from './context.js';
import { ensureBase } from './context.js';
import { planEnable, resolveTarget, type PlanStep } from './deps.js';
import { RemoteScript, shq } from './deliver.js';
import { parseAssignments, renderEnvFile, type EnvMap } from './env-file.js';
import { waitModule, waitReady, type ProbeOutcome } from './health.js';
import { createDemoAccessKey, prepareModule, type Prepared } from './hooks.js';
import {
  hookFor, mergeStackOutputs, selectStacks, stackDrift, type HookArgs, type MissingPrerequisite, type StackPlan,
} from './module-hooks/index.js';
import { buildModuleEnv, splitOutputs } from './outputs.js';
import { applyBaseParams, recordFor, stackParams, stagedEnv, updateInjectedTargets } from './ops.js';
import { packageLambda } from './package.js';
import { printCheck, runLocalCheck } from './plan.js';
import { syncAttachments } from './policy.js';
import { CliError, EXIT } from './printer.js';
import {
  IMPLEMENTED_MODULES, REGISTRY, isHourlyBilled, moduleOf, registryVersion, stackName,
} from './registry.js';
import { deleteStack, deployStack, stackTags } from './stack.js';
import { registerHook } from './platform/hooks.js';
import { previewOffBefore } from './platform/tls-preview.js';
import { currentEnv, nowIso, recordHistory, type ModuleRecord, type StackRecord } from './state.js';
import { loadTemplate, mainTemplatePath, staticOutputValue } from './template.js';

export interface EnableOptions {
  driver?: string;
  mode?: string;
  selfHosted?: boolean;
  withDeps?: boolean;
  migrate?: boolean;
  param?: string[];
  set?: string[];
  skipHealth?: boolean;
  /** `scripts/module plan <id>`: stop after the plan check and print the env previews */
  planOnly?: boolean;
  // module-specific arguments, passed to the module hooks (module-hooks/types.ts HookArgs)
  /** --domain <name> (dns, tls) */
  domain?: string;
  /** --zone-id <id> (dns, tls) */
  zoneId?: string;
  /** --target eip|alb|cloudfront (dns) */
  target?: string;
  /** --no-acme gives false (tls) */
  acme?: boolean;
}

/** HookArgs of one plan step (only the requested module receives --param and the module-specific options). */
export function hookArgsFor(step: { isTarget: boolean }, opts: EnableOptions, userParams: Readonly<Record<string, string>>): HookArgs {
  const own = step.isTarget;
  return {
    params: own ? userParams : {}, planOnly: Boolean(opts.planOnly), isTarget: own,
    ...(own && opts.domain ? { domain: opts.domain } : {}), ...(own && opts.zoneId ? { zoneId: opts.zoneId } : {}),
    ...(own && opts.target ? { target: opts.target } : {}), ...(own && opts.acme === false ? { acme: false } : {}),
  };
}

/** Steps whose hook plan() already ran in enableCommand (enableStep runs it for profile apply / direct callers). */
const HOOK_PLANNED = new WeakSet<PlanStep>();

/** Run the module hook's plan(): merge its settings into the step, print notes; returns the unmet manual prerequisites. */
async function runHookPlan(ctx: Ctx, step: PlanStep, args: HookArgs): Promise<MissingPrerequisite[]> {
  const hook = hookFor(step.module);
  HOOK_PLANNED.add(step);
  if (!hook?.plan) return [];
  const r = await hook.plan(ctx, step, args);
  Object.assign(step.settings, r.settings ?? {});
  for (const n of r.notes ?? []) ctx.out.warn(`      ${step.module}: ${n}`);
  return r.missing ?? [];
}

function printMissing(ctx: Ctx, id: ModuleId, missing: readonly MissingPrerequisite[], asError: boolean): void {
  for (const m of missing) {
    const line = `      ${id}: manual prerequisite "${m.prerequisite}" is not met: ${m.message}${m.hint ? `\n            -> ${m.hint}` : ''}`;
    if (asError) ctx.out.error(line); else ctx.out.warn(line);
  }
}

const MANUAL_PREREQS = new Set(['domain', 'ses-identity', 'confirm-email', 'cost-allocation-tag', 'region-opt-in']);

export async function enableCommand(ctx: Ctx, idArg: string, opts: EnableOptions): Promise<number> {
  const id = idArg as ModuleId;
  const settings = parseAssignments(opts.set, '--set');
  const driver = id === 'iam' ? (opts.mode ?? opts.driver ?? 'role') : opts.driver;
  const target = resolveTarget(id, { ...(driver ? { driver } : {}), ...(opts.selfHosted ? { selfHosted: true } : {}), settings });
  await ensureBase(ctx);
  await previewOffBefore(ctx, id);

  ctx.out.section(`plan: enable ${id} (${target.tier}${target.value !== 'aws' ? ` ${moduleOf(id).switch?.var}=${target.value}` : ''})${ctx.dryRun ? ' [dry-run]' : ''}`);
  ctx.out.step(1, 'plan check: dependencies, credentials, staged check-config --plan');
  // module hook of the requested module first: its settings (e.g. TLS_DOMAIN from --domain, TLS_ACME) decide the requirements
  const userParams = parseAssignments(opts.param, '--param');
  const targetStep: PlanStep = { ...target, reason: 'requested', isTarget: true };
  const missing: Array<{ module: ModuleId; items: MissingPrerequisite[] }> = [];
  if (IMPLEMENTED_MODULES.includes(id)) {
    const own = await runHookPlan(ctx, targetStep, hookArgsFor(targetStep, opts, userParams));
    if (own.length) missing.push({ module: id, items: own });
  }
  const plan = planEnable(currentEnv(ctx.state), target, { ...(opts.withDeps ? { withDeps: true } : {}) });
  plan.steps.forEach((s, i) => ctx.out.info(`      ${i + 1}. ${s.module.padEnd(17)} ${s.tier.padEnd(11)} ${describeValue(s)}  — ${s.reason}${s.rule ? ` (${s.rule})` : ''}`));
  for (const s of plan.steps) {
    if (!IMPLEMENTED_MODULES.includes(s.module)) {
      throw new CliError(`${s.module}: templates / adapters are not implemented in this round (registry metadata only)`, EXIT.rules);
    }
  }
  for (const s of plan.steps) {
    if (s.isTarget) { HOOK_PLANNED.add(s); continue; }
    const m = await runHookPlan(ctx, s, hookArgsFor(s, opts, userParams));
    if (m.length) missing.push({ module: s.module, items: m });
  }
  if (missing.length) {
    for (const x of missing) printMissing(ctx, x.module, x.items, !opts.planOnly);
    if (opts.planOnly) {
      // plan: skipped with a clear hint (exit 0) — e.g. dns / tls without an own domain (single-module smoke "needs a human")
      ctx.out.warn(`      plan skipped: ${missing.map((x) => x.module).join(', ')} need(s) the manual prerequisite(s) above; nothing was checked`);
      return EXIT.ok;
    }
    recordHistory(ctx.state, { op: 'enable', module: id, result: 'failed', exitCode: EXIT.rules,
      detail: `manual prerequisite: ${missing.flatMap((x) => x.items.map((m) => `${x.module}:${m.prerequisite}`)).join(',')}` });
    ctx.save();
    return EXIT.rules;
  }
  if (plan.issues.length) {
    for (const i of plan.issues) ctx.out.error(`      ${i.rule}: ${i.message}${i.remedy ? `  ->  scripts/module enable ${i.remedy.module}${i.remedy.tier === 'local' ? ` --driver ${i.remedy.value}` : ''}  (or --with-deps)` : ''}`);
    recordHistory(ctx.state, { op: 'enable', module: id, result: 'failed', exitCode: EXIT.rules, detail: 'dependencies' });
    ctx.save();
    return EXIT.rules;
  }

  // staged env: every planned step as it will be written (outputs unknown yet -> placeholders)
  const previewRecords = { ...ctx.state.modules };
  for (const s of plan.steps) {
    const env = previewEnv(ctx.repoRoot, s);
    previewRecords[s.module] = recordFor(ctx.state.modules[s.module], { tier: s.tier, value: s.value, env });
  }
  if (!ctx.opts.skipLocalCheck) {
    const check = runLocalCheck(ctx.repoRoot, stagedEnv(ctx, previewRecords));
    printCheck(ctx.out, check);
    if (check.ran && !check.ok) {
      recordHistory(ctx.state, { op: 'enable', module: id, result: 'failed', exitCode: EXIT.rules, detail: 'check-config --plan' });
      ctx.save();
      return EXIT.rules;
    }
  }

  if (opts.planOnly) {
    for (const s of plan.steps) {
      ctx.out.info(`      modules.d/${s.module}.env (preview; <…> = stack output after deployment):`);
      for (const [k, v] of Object.entries(previewRecords[s.module]?.env ?? {})) ctx.out.info(`        ${k}=${v}`);
    }
    return EXIT.ok;
  }

  ctx.out.step(2, 'confirmation');
  for (const s of plan.steps) {
    const m = moduleOf(s.module);
    if (s.tier === 'aws' && isHourlyBilled(s.module)) ctx.out.warn(`      ${s.module}: billed per hour while enabled (see the official pricing page; no amounts here, D14)`);
    for (const p of m.prerequisites ?? []) {
      if (MANUAL_PREREQS.has(p)) ctx.out.warn(`      ${s.module}: manual prerequisite "${p}"`);
      if (p === 'toolchain' && s.tier === 'aws' && !ctx.state.toolchain?.bucket) ctx.out.warn(`      ${s.module}: needs the toolchain stack (scripts/module bootstrap)`);
    }
  }
  if (!ctx.dryRun && !ctx.yes && !(await confirm(`enable ${plan.steps.map((s) => s.module).join(', ')}?`))) {
    ctx.out.info('aborted');
    return EXIT.rules;
  }

  for (const step of plan.steps) {
    const code = await enableStep(ctx, step, opts);
    if (code !== EXIT.ok) return code;
  }
  return EXIT.ok;
}

function describeValue(s: PlanStep): string {
  const sw = moduleOf(s.module).switch;
  if (!sw) return '';
  return isParamSwitch(sw) ? `${sw.var}=<stack output>` : `${sw.var}=${s.value}`;
}

/** modules.d/<id>.env preview of a planned step: MODULE flags, switch value, Env* outputs as placeholders, settings. */
export function previewEnv(repoRoot: string, s: PlanStep): EnvMap {
  if (s.tier !== 'aws') return buildModuleEnv({ module: s.module, awsTier: false, switchValue: s.value, settings: s.settings });
  const tpl = mainTemplatePath(s.module);
  const outputs: Record<string, string> = {};
  // literal outputs (EnvStorageDriver: s3, EnvSqsWaitTimeSec: '20', ...) are known before deployment; the rest are placeholders
  const t = loadTemplate(repoRoot, tpl);
  for (const name of Object.keys(t.Outputs)) outputs[name] = staticOutputValue(t, name) ?? `<${s.module}:${name}>`;
  const env = buildModuleEnv({ module: s.module, awsTier: true, outputs, switchValue: s.value === 'aws' ? undefined : s.value, settings: s.settings });
  if (s.module === 'iam') env.IAM_CREDENTIALS = s.value;
  if (s.module === 'image-processing' && env.IMAGE_RESULT_CHANNEL?.startsWith('<')) env.IMAGE_RESULT_CHANNEL = s.settings.IMAGE_RESULT_CHANNEL ?? 'callback';
  if (s.module === 'image-processing' && env.IMAGE_RESULT_CHANNEL === 'queue') delete env.IMAGE_CALLBACK_URL;
  if (s.module === 'image-processing' && env.IMAGE_RESULT_CHANNEL === 'callback') delete env.IMAGE_RESULT_QUEUE_URL;
  if (s.module === 'cdn') env.CDN_MEDIA_ORIGIN = s.settings.CDN_MEDIA_ORIGIN ?? 'ec2';
  if (s.module === 'auth' && env.COGNITO_DOMAIN?.startsWith('<') && (s.settings.COGNITO_LOGIN_MODE ?? 'sdk') !== 'managed') delete env.COGNITO_DOMAIN;
  if (s.module === 'database') { delete env.DB_PASSWORD_SECRET_ARN; delete env.DB_READ_HOST; }
  return env;
}

export async function enableStep(ctx: Ctx, step: PlanStep, opts: EnableOptions): Promise<number> {
  const id = step.module;
  const prev = ctx.state.modules[id];
  ctx.out.section(`enable ${id}: ${step.tier} ${describeValue(step)}`);
  const userParams = step.isTarget ? parseAssignments(opts.param, '--param') : {};
  // module hook (module-hooks/<id>.ts): plan() when the caller did not run it (profile apply), then prepare()
  const hook = hookFor(id);
  const hookArgs = hookArgsFor(step, opts, userParams);
  if (!HOOK_PLANNED.has(step)) {
    const missing = await runHookPlan(ctx, step, hookArgs);
    if (missing.length) {
      printMissing(ctx, id, missing, true);
      recordHistory(ctx.state, { op: 'enable', module: id, result: 'failed', exitCode: EXIT.rules, detail: `manual prerequisite: ${missing.map((m) => m.prerequisite).join(',')}` });
      ctx.save();
      return EXIT.rules;
    }
  }
  const prepared = await prepareModule(ctx, step, { params: userParams });
  if (hook?.prepare) await hook.prepare(ctx, step, hookArgs, prepared);
  for (const n of prepared.notes) ctx.out.warn(`      ${n}`);
  if (userParams.AuthToken === 'generate') delete userParams.AuthToken;

  let env: EnvMap;
  let record: ModuleRecord;
  const secrets: Record<string, string> = { ...prepared.secrets };

  if (step.tier === 'aws') {
    // 3. deploy the module stacks: registry stacks[] whose `when` holds (region per stack, e.g. us-east-1), in registry order
    const records = { ...ctx.state.modules };
    const envAfter = { ...currentEnv(ctx.state), ...previewEnv(ctx.repoRoot, step), ...prepared.settings };
    let stacks = selectStacks(id, envAfter, ctx.region, { ...prepared.params, ...userParams });
    if (hook?.stacks) stacks = hook.stacks(ctx, step, hookArgs, stacks, envAfter);
    if (!stacks.length) throw new CliError(`${id}: no stack to deploy for this configuration (registry stacks[].when)`, EXIT.rules, 'NO_STACK');
    ctx.out.step(3, `deploy ${stacks.map((s) => `${stackName(ctx.env, id, s.name)}${s.region !== ctx.region ? ` [${s.region}]` : ''}`).join(', ')}`);
    const deployed = await deployModuleStacks(ctx, id, stacks, { records, envAfter, prepared, userParams });
    if (hook?.afterDeploy) {
      ctx.out.step('3b', `${id}: out-of-band steps after the deployment`);
      await hook.afterDeploy(ctx, step, hookArgs, { outputs: deployed.outputs, byStack: deployed.byStack, stacks }, prepared);
      Object.assign(secrets, prepared.secrets);
    }
    const outputs = deployed.outputs;
    // 4. Outputs -> env; secretParams -> secrets.env
    ctx.out.step(4, 'Outputs -> modules.d env, secretParams -> secrets.env');
    const sw = moduleOf(id).switch;
    env = buildModuleEnv({ module: id, awsTier: true, outputs, switchValue: sw && !isParamSwitch(sw) ? step.value : undefined, settings: prepared.settings });
    if (id === 'iam') env.IAM_CREDENTIALS = step.value;
    if (id === 'iam' && step.value === 'keys') {
      Object.assign(secrets, await createDemoAccessKey(ctx, outputs.InfoDemoUserName ?? `cloudalbum-${ctx.env}-demo-keys`));
    }
    record = recordFor(prev, {
      tier: 'aws', value: step.value, env, version: registryVersion(id), outputs, params: deployed.params, stacks: deployed.records,
      secretKeys: [...new Set([...(prev?.secretKeys ?? []), ...Object.keys(secrets)])],
    });
    const split = splitOutputs(outputs);
    for (const [k, v] of Object.entries(split.info)) ctx.out.info(`      ${k} = ${v}`);
    for (const [k, v] of Object.entries(env)) ctx.out.info(`      env ${k}=${v}`);

    // 4b. injects (this module as provider) and baseParams
    const after = { ...ctx.state.modules, [id]: record };
    ctx.out.step('4b', 'provider injects and baseParams');
    await updateInjectedTargets(ctx, id, after);
    await applyBaseParams(ctx, after, id);
    ctx.state.modules[id] = record;   // in --dry-run only in memory (state.json is never written)
    // stacks of an earlier enable that are no longer selected (e.g. tls edge after cdn was disabled): removed after the injects
    for (const old of prev?.stacks ?? []) {
      if (deployed.records.some((s) => s.name === old.name)) continue;
      ctx.out.info(`      ${old.stackName}: no longer selected (registry stacks[].when) -> delete`);
      await deleteStack(ctx.aws, ctx.out, old.stackName, old.region);
    }
    // 5. PolicyArn
    ctx.out.step(5, 'attach PolicyArn');
    if (id === 'iam') {
      const roleName = outputs.InfoAppRoleName ?? 'CloudAlbumAppRole';
      const iamState = { mode: step.value as 'role' | 'keys', roleName, ...(outputs.InfoDemoUserName ? { userName: outputs.InfoDemoUserName } : {}) };
      ctx.state.iam = iamState;
    }
    const diff = await syncAttachments(ctx.aws, ctx.out, ctx.state);
    for (const a of diff.attach) ctx.out.info(`      attach ${a.policyArn} -> ${diff.principal?.type}/${diff.principal?.name}`);
    for (const d of diff.detach) ctx.out.info(`      detach ${d.policyArn} <- ${d.principal.type}/${d.principal.name}`);
  } else {
    ctx.out.step('3-5', 'local tier: no stack, no MODULE flag, no policy');
    env = buildModuleEnv({ module: id, awsTier: false, switchValue: step.value, settings: prepared.settings });
    record = recordFor(prev, { tier: step.tier, value: step.value, env, version: registryVersion(id), stacks: [], outputs: {}, params: {},
      secretKeys: [...new Set([...(prev?.secretKeys ?? []), ...Object.keys(secrets)])] });
    for (const [k, v] of Object.entries(env)) ctx.out.info(`      env ${k}=${v}`);
  }

  // 6. migration
  const migration = moduleOf(id).migration;
  if (step.tier === 'aws' && typeof migration === 'string' && migration.startsWith('scripts/migrate') && opts.migrate !== false && !prev) {
    ctx.out.step(6, `data migration ${migration} (read-only window)`);
    const s = new RemoteScript(`migrate ${id} up`);
    s.line('/usr/local/sbin/cloudalbum-runtime set readOnly true', 'systemctl stop cloudalbum-worker || true', 'trap \'/usr/local/sbin/cloudalbum-runtime set readOnly false; systemctl start cloudalbum-worker\' EXIT');
    s.cli(`migrate-module ${id} up`).cli(`migrate-module ${id} verify`);
    const r = await ctx.deliverer().run(s);
    if (r.code !== 0) {
      ctx.out.error(`migration failed (exit ${r.code}); env not written, stack kept. Retry, or enable with --no-migrate`);
      recordHistory(ctx.state, { op: 'enable', module: id, result: 'failed', exitCode: EXIT.migration, detail: 'migration' });
      ctx.save();
      return EXIT.migration;
    }
  } else {
    ctx.out.step(6, 'data migration: none');
  }

  // 7-9. deliver configuration, check on the instance, restart
  ctx.out.step('7-9', 'deliver modules.d env + host artifacts, check-config on the instance, restart');
  const script = deliveryScript(ctx, id, env, secrets, prepared.remote);
  const delivered = await ctx.deliverer().run(script, { timeoutSec: 900 });
  if (delivered.code !== 0) {
    ctx.out.error(`delivery failed (exit ${delivered.code}): previous configuration restored on the instance`);
    recordHistory(ctx.state, { op: 'enable', module: id, result: 'rolled-back', exitCode: EXIT.rules, detail: 'instance check-config' });
    ctx.save();
    return EXIT.rules;
  }

  // 10. health
  if (!opts.skipHealth) {
    ctx.out.step(10, 'health: /api/health/ready, then probe --deep until ok|degraded (a transient degraded keeps polling)');
    const ready = await waitReady(ctx, 60);
    const probe: ProbeOutcome = ready ? await waitModule(ctx, id, { timeoutSec: 120 }) : { ok: false, status: 'not-ready', detail: '' };
    if (!ready || !probe.ok) {
      const why = probe.transient ? `${probe.status}, transient — the AWS control plane was never reachable within 120 s (NAT / VPC endpoints, security group egress, AWS_ENDPOINT_URL, IMDS hop limit)` : probe.status;
      ctx.out.error(`health probe failed (${why}: ${probe.detail}); restoring the previous configuration (stack kept)`);
      await ctx.deliverer().run(rollbackScript(id), { timeoutSec: 300 });
      recordHistory(ctx.state, { op: 'enable', module: id, result: 'rolled-back', exitCode: EXIT.health, detail: probe.status });
      ctx.save();
      return EXIT.health;
    }
    if (probe.status === 'degraded') ctx.out.warn(`      ${id} is degraded: ${probe.detail}`);
  }

  // 11. state + next steps
  ctx.state.modules[id] = record;
  // platform mode (06 PM-36): Cognito passwords of the admin / seeded users need the learner identity
  if (ctx.platform && id === 'auth' && step.tier === 'aws') {
    await registerHook(ctx, 'cognito-passwords', `auth=cognito enabled by ${ctx.platform.identity?.sessionName ?? '?'}`);
  }
  recordHistory(ctx.state, { op: 'enable', module: id, result: ctx.dryRun ? 'dry-run' : 'ok', exitCode: EXIT.ok, detail: `${step.tier} ${step.value}` });
  ctx.save();
  ctx.out.step(11, `done: open /lab/m/${id}; compare with \`npm run exp -- ${id} --label after\``);
  printStackDrift(ctx, id);
  return EXIT.ok;
}

/** Other enabled modules whose conditional stacks changed because of this operation (e.g. tls edge after enabling cdn). */
export function printStackDrift(ctx: Ctx, changed: ModuleId): void {
  for (const d of stackDrift(ctx.state.modules, currentEnv(ctx.state), ctx.region)) {
    if (d.module === changed) continue;
    const what = [...d.add.map((n) => `+${n}`), ...d.remove.map((n) => `-${n}`)].join(', ');
    ctx.out.warn(`      ${d.module}: its conditional stacks changed (${what}); run \`scripts/module enable ${d.module}\` again to apply`);
  }
}

interface DeployContext {
  records: Ctx['state']['modules'];
  envAfter: EnvMap;
  prepared: Prepared;
  userParams: Record<string, string>;
}

/** Step 3 for every selected stack: parameters per template, Lambda code package (once), deploy, outputs per stack. */
async function deployModuleStacks(ctx: Ctx, id: ModuleId, stacks: readonly StackPlan[], d: DeployContext): Promise<{
  outputs: Record<string, string>; byStack: Record<string, Record<string, string>>; records: StackRecord[]; params: Record<string, string>;
}> {
  const { prepared } = d;
  const pkg = prepared.code
    ? await packageLambda(ctx.aws, ctx.out, ctx.repoRoot, { ...prepared.code, ...(ctx.state.toolchain?.bucket ? { bucket: ctx.state.toolchain.bucket } : {}) })
    : undefined;
  const byStack: Record<string, Record<string, string>> = {};
  const records: StackRecord[] = [];
  const nonSecret: Record<string, string> = {};
  for (const st of stacks) {
    const { params, secret } = stackParams(ctx, id, d.records, d.envAfter, { ...prepared.params, ...(st.params ?? {}) }, d.userParams, st.template);
    if (pkg && prepared.code && Object.keys(loadTemplate(ctx.repoRoot, st.template).Parameters).includes(prepared.code.bucketParam)) {
      params[prepared.code.bucketParam] = pkg.bucket;
      params[prepared.code.keyParam] = pkg.key;
    }
    const name = stackName(ctx.env, id, st.name);
    const res = await deployStack(ctx.aws, ctx.out, ctx.repoRoot, {
      stackName: name, template: st.template, params, secretParams: [...secret, ...prepared.secretParams],
      tags: stackTags(ctx.env, id, registryVersion(id)), ...(ctx.state.toolchain?.bucket ? { templateBucket: ctx.state.toolchain.bucket } : {}),
      ...(st.region !== ctx.region ? { region: st.region } : {}),
    });
    byStack[st.name] = res.outputs;
    records.push({ name: st.name, stackName: name, region: st.region, status: res.status, ...(stacks.length > 1 ? { outputs: res.outputs } : {}) });
    const hidden = new Set([...secret, ...prepared.secretParams]);
    for (const [k, v] of Object.entries(params)) if (!hidden.has(k)) nonSecret[k] = v;
  }
  return { outputs: mergeStackOutputs(stacks.map((s) => byStack[s.name] ?? {})), byStack, records, params: nonSecret };
}

/** 7-9: atomic modules.d write with .bak, secrets, host artifacts, check-config (rollback on 78), restart. */
export function deliveryScript(ctx: Ctx, id: ModuleId, env: EnvMap, secrets: Record<string, string>, extra: Array<(s: RemoteScript) => void>): RemoteScript {
  const m = REGISTRY[id];
  const hasHost = Boolean(m.nginxFragments?.length || m.systemdDropIns?.length || (m.hostSetup && m.hostSetup !== 'infra/userdata/l0-bootstrap.sh'));
  const s = new RemoteScript(`enable ${id}`);
  const f = `/etc/cloudalbum/modules.d/${id}.env`;
  const who = operatorOf(ctx);
  s.line(...instanceStatePending(id, 'enable', who.opId));
  s.line('ca_rollback() {',
    `  ca_f=$(readlink -f ${f} 2>/dev/null || echo ${f})`,
    '  if [ -f "$ca_f.bak" ]; then mv -f "$ca_f.bak" "$ca_f"; else rm -f "$ca_f"; fi',
    ...(hasHost ? [`  if [ -f "$ca_f" ]; then /usr/local/lib/cloudalbum/run-hostsetup.sh ${id} apply || true; else /usr/local/lib/cloudalbum/run-hostsetup.sh ${id} revert || true; fi`] : []),
    '  systemctl restart cloudalbum-api cloudalbum-worker || true',
    '}');
  if (Object.keys(secrets).length) s.upsertSecrets(secrets);
  s.writeFile(f, renderEnvFile(env, { header: [`written by scripts/module enable ${id} at ${nowIso()} (do not edit; CFG-002: ownsEnv keys only, no secrets)`] }),
    { mode: '0640', owner: 'root:cloudalbum', backup: true });
  for (const e of extra) e(s);
  if (hasHost) s.line(`if ! /usr/local/lib/cloudalbum/run-hostsetup.sh ${id} apply; then ca_rollback; exit 2; fi`);
  s.line('/usr/local/lib/cloudalbum/render-fail2ban.sh || true');
  s.line('if ! runuser -u cloudalbum -- env CLOUDALBUM_ENV_DIR=/etc/cloudalbum CLOUDALBUM_ROLE=cli /usr/bin/node /opt/cloudalbum/backend/dist/cli.js check-config; then',
    '  echo "check-config rejected the new configuration: rolling back" >&2; ca_rollback; exit 2', 'fi');
  if (Object.keys(secrets).length) s.line('# secrets.env was replaced: restart (not reload) nginx so InaccessiblePaths hides the new inode', 'systemctl restart nginx');
  s.line('ca_extra=$(systemctl list-units --plain --no-legend --state=active \'cloudalbum-api@*.service\' | awk \'{print $1}\')',
    '# shellcheck disable=SC2086',
    'systemctl restart cloudalbum-api cloudalbum-worker $ca_extra');
  const sw = REGISTRY[id].switch;
  s.line(...instanceStateUpdate(id, 'enabled', {
    driver: sw ? (env[sw.var] ?? (isParamSwitch(sw) ? 'aws' : '')) : '', version: registryVersion(id), ...who,
    ...(ctx.state.profile ? { profile: ctx.state.profile } : {}),
  }));
  return s;
}

export function rollbackScript(id: ModuleId): RemoteScript {
  const s = new RemoteScript(`rollback ${id}`);
  const f = `/etc/cloudalbum/modules.d/${id}.env`;
  const m = REGISTRY[id];
  const hasHost = Boolean(m.nginxFragments?.length || m.systemdDropIns?.length || (m.hostSetup && m.hostSetup !== 'infra/userdata/l0-bootstrap.sh'));
  s.line(`ca_f=$(readlink -f ${f} 2>/dev/null || echo ${f})`,
    'if [ -f "$ca_f.bak" ]; then mv -f "$ca_f.bak" "$ca_f"; else rm -f "$ca_f"; fi',
    ...(hasHost ? [`if [ -f "$ca_f" ]; then /usr/local/lib/cloudalbum/run-hostsetup.sh ${id} apply; else /usr/local/lib/cloudalbum/run-hostsetup.sh ${id} revert; fi || true`] : []),
    '/usr/local/lib/cloudalbum/render-fail2ban.sh || true',
    'systemctl restart cloudalbum-api cloudalbum-worker');
  return s;
}

export interface InstanceStateInfo {
  driver?: string;
  version?: number;
  /** operation id (platform: the ULID of this invocation) */
  opId?: string;
  /** caller: platform role session name (atl-<sid>-ws / atl-<sid>-prov-<op>), standalone `scripts/module` */
  operator?: string;
  profile?: string;
}

/**
 * /etc/cloudalbum/modules.state.json (instance-side module state maintained by scripts/module; format of 06 PM-15):
 *   modules{id: {enabled, driver, version, enabledAt}}, history[{opId, op, module, at, operator, profile?}] (last 50),
 *   pending{opId, module, op, startedAt} — written at the start of the delivery, cleared when it finishes.
 * Read by `cloudalbum module-state` and the check bundle's module-state check.
 */
export function instanceStateUpdate(id: ModuleId, status: 'enabled' | 'disabled', info: InstanceStateInfo = {}): string[] {
  const op = status === 'enabled' ? 'enable' : 'disable';
  const args = [
    `--arg id ${id}`, `--arg op ${op}`, `--arg driver ${shq(info.driver ?? '')}`, `--argjson ver ${Number.isInteger(info.version) ? String(info.version) : 'null'}`,
    `--arg opid ${shq(info.opId ?? '')}`, `--arg operator ${shq(info.operator ?? 'scripts/module')}`, `--arg profile ${shq(info.profile ?? '')}`,
    '--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  ].join(' ');
  const filter = [
    '.modules = (.modules // {}) | .history = (.history // [])',
    '| .modules[$id] = {enabled: ($op == "enable"), driver: (if $driver == "" then null else $driver end), version: $ver,',
    '  enabledAt: (if $op == "enable" then $at else (.modules[$id].enabledAt // null) end)}',
    '| .history = ((.history + [{opId: $opid, op: $op, module: $id, at: $at, operator: $operator} + (if $profile == "" then {} else {profile: $profile} end)]) | .[-50:])',
    '| .pending = null | .updatedAt = $at',
  ].join(' ');
  return [
    'ca_ms=$(readlink -f /etc/cloudalbum)/modules.state.json',
    '[ -s "$ca_ms" ] || echo \'{"modules":{},"history":[],"pending":null}\' > "$ca_ms"',
    `ca_tmp=$(mktemp "$(dirname "$ca_ms")/.ms.XXXXXX"); jq ${args} '${filter}' "$ca_ms" > "$ca_tmp"`,
    'chown root:cloudalbum "$ca_tmp"; chmod 0640 "$ca_tmp"; mv -f "$ca_tmp" "$ca_ms"',
  ];
}

/** modules.state.json `pending` at the start of a delivery (06 PM-15) */
export function instanceStatePending(id: ModuleId, op: 'enable' | 'disable', opId: string): string[] {
  return [
    'ca_ms=$(readlink -f /etc/cloudalbum)/modules.state.json',
    '[ -s "$ca_ms" ] || echo \'{"modules":{},"history":[],"pending":null}\' > "$ca_ms"',
    `ca_tmp=$(mktemp "$(dirname "$ca_ms")/.ms.XXXXXX"); jq --arg id ${id} --arg op ${op} --arg opid ${shq(opId)} --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.pending = {opId: $opid, module: $id, op: $op, startedAt: $at}' "$ca_ms" > "$ca_tmp"`,
    'chown root:cloudalbum "$ca_tmp"; chmod 0640 "$ca_tmp"; mv -f "$ca_tmp" "$ca_ms"',
  ];
}

/** identity recorded on the instance and in state.json history */
export function operatorOf(ctx: Ctx): { opId: string; operator: string } {
  return { opId: ctx.platform?.opId ?? '', operator: ctx.platform?.identity?.sessionName ?? 'scripts/module' };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new CliError('confirmation needed: re-run with --yes (non-interactive shell)', EXIT.rules);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
export { confirm };
