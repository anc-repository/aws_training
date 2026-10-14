/**
 * Operations shared by enable / disable / profile apply: module stack parameters, provider injections,
 * base-stack parameters (baseParams), and the staged env of the plan check.
 */
import type { ModuleId } from '@cloudalbum/contracts';
import type { Ctx } from './context.js';
import { computeInjections, injectTargetsOf } from './injects.js';
import { mergeBaseParams, originalsFor } from './base-params.js';
import { deployStack, stackTags } from './stack.js';
import { loadTemplate, mainTemplatePath, noEchoParameters, templateOfStack } from './template.js';
import { registryVersion, stackName } from './registry.js';
import type { CloudAlbumState, ModuleRecord } from './state.js';
import { currentEnv, nowIso } from './state.js';
import { CliError, EXIT } from './printer.js';
import { baseContextParams, httpsOnly } from './hooks.js';
import { mergeStackOutputs } from './module-hooks/index.js';
import type { StagedEnv } from './plan.js';
import type { EnvMap } from './env-file.js';

export function directOrigin(ctx: Ctx): string {
  return `http://${ctx.ph(ctx.state.base?.publicIp, 'ec2:PublicIp')}`;
}

/**
 * Injected parameter values for `target` given the module records after the operation. A parameter that is also part
 * of the base context (VpcId, SubnetIds: network injects them) falls back to the base-context value when no provider
 * injects it any more.
 */
export function injectedParams(ctx: Ctx, target: ModuleId, records: CloudAlbumState['modules'], env: EnvMap,
  template: string = mainTemplatePath(target)): Record<string, string> {
  const t = loadTemplate(ctx.repoRoot, template);
  const params = Object.keys(t.Parameters);
  const baseLists: Record<string, string> = {};
  if (params.includes('AppOrigins')) baseLists.AppOrigins = target === 'auth' ? '' : directOrigin(ctx);
  const inj = computeInjections(target, params, {
    records, env, baseLists, context: { Env: ctx.env, ...(ctx.state.base?.arch ? { Arch: ctx.state.base.arch } : {}) },
    ...(ctx.dryRun ? { placeholders: true } : {}),
  });
  const out = Object.fromEntries(Object.values(inj).map((v) => [v.param, v.value]));
  if (target === 'auth' && 'AppOrigins' in out) out.AppOrigins = httpsOnly(out.AppOrigins ?? '');   // Cognito callbacks: https only
  const base = baseContextParams(ctx, target, params);
  for (const [k, v] of Object.entries(out)) if (v === '' && base[k] !== undefined) out[k] = base[k]!;
  return out;
}

/** Full parameter set of a module stack: base context + injections + module specific + user --param (only declared ones). */
export function stackParams(ctx: Ctx, id: ModuleId, records: CloudAlbumState['modules'], env: EnvMap,
  moduleParams: Record<string, string>, userParams: Record<string, string>,
  template: string = mainTemplatePath(id)): { params: Record<string, string>; secret: string[] } {
  const t = loadTemplate(ctx.repoRoot, template);
  const declared = Object.keys(t.Parameters);
  const params = {
    ...baseContextParams(ctx, id, declared),
    ...injectedParams(ctx, id, records, env, template),
    ...moduleParams,
    ...userParams,
  };
  for (const k of Object.keys(params)) if (!declared.includes(k)) delete params[k];
  return { params, secret: noEchoParameters(t) };
}

/**
 * After a provider changed (enabled, updated or disabled): update every enabled target stack whose injected parameters
 * differ from what it was deployed with (9.2 step 4b / disable step 5).
 */
export async function updateInjectedTargets(ctx: Ctx, provider: ModuleId, records: CloudAlbumState['modules']): Promise<void> {
  const env = mergedEnv(ctx.state, records);
  const targets = new Set<ModuleId>([...injectTargetsOf(provider, { modules: records }), ...injectTargetsOf(provider, ctx.state)]);
  for (const target of targets) {
    const rec = records[target];
    if (!rec || rec.tier !== 'aws' || target === provider) continue;
    // every deployed stack of the target (tls main / edge / regional ...) whose template declares a changed parameter
    const stacks = rec.stacks.length ? rec.stacks : [{ name: 'main', stackName: stackName(ctx.env, target), region: ctx.region }];
    const applied: Record<string, string> = {};
    for (const st of stacks) {
      const template = templateOfStack(target, st.name);
      const next = injectedParams(ctx, target, records, env, template);
      const changed = Object.entries(next).filter(([k, v]) => (rec.params[k] ?? '') !== v);
      if (!changed.length) continue;
      ctx.out.info(`      inject ${provider} -> ${st.stackName}: ${changed.map(([k, v]) => `${k}=${v || "''"}`).join(', ')}`);
      const res = await deployStack(ctx.aws, ctx.out, ctx.repoRoot, {
        stackName: st.stackName, template, params: Object.fromEntries(changed), tags: stackTags(ctx.env, target, registryVersion(target)),
        ...(st.region && st.region !== ctx.region ? { region: st.region } : {}),
      });
      Object.assign(applied, Object.fromEntries(changed));
      if (!ctx.dryRun) {
        if (rec.stacks.length > 1) st.outputs = res.outputs;
        else rec.outputs = res.outputs;
      }
    }
    if (!Object.keys(applied).length) continue;
    rec.params = { ...rec.params, ...applied };
    if (!ctx.dryRun && rec.stacks.length > 1) rec.outputs = mergeStackOutputs(rec.stacks.map((s) => s.outputs ?? {}));
    rec.updatedAt = nowIso();
  }
}

export function mergedEnv(state: CloudAlbumState, records: CloudAlbumState['modules']): EnvMap {
  const env: EnvMap = { ...state.baseConfig };
  for (const r of Object.values(records)) Object.assign(env, r?.env ?? {});
  return env;
}

/** Recompute the base stack parameters from every module contribution and update the ec2 stack when needed. */
export async function applyBaseParams(ctx: Ctx, records: CloudAlbumState['modules'], _by: string): Promise<void> {
  const current = { ...(ctx.state.base?.params ?? {}) };
  const plan = mergeBaseParams(records, current, originalsFor(ctx.state), { Env: ctx.env, ...(ctx.state.base?.arch ? { Arch: ctx.state.base.arch } : {}) });
  if (plan.conflicts.length) throw new CliError(`baseParams conflict:\n  ${plan.conflicts.join('\n  ')}`, EXIT.rules);
  // platform mode (ATL-IAM-001, 06 PM-31): the management channel depends on the instance profile CloudAlbumAppRole
  const ip = plan.changes.find((c) => c.param === 'InstanceProfileName');
  if (ctx.platform && ip && ip.to !== 'CloudAlbumAppRole') {
    throw new CliError(`ATL-IAM-001: InstanceProfileName would become "${ip.to || "''"}"; in platform mode it must stay CloudAlbumAppRole`, EXIT.rules, 'ATL-IAM-001');
  }
  if (!plan.changes.length) { ctx.out.info('      baseParams: no change on the base stack'); return; }
  for (const c of plan.changes) ctx.out.info(`      baseParams ${c.param}: ${c.from || "''"} -> ${c.to || "''"} (${(plan.by[c.param] ?? []).join(', ') || 'restored'})`);
  await deployStack(ctx.aws, ctx.out, ctx.repoRoot, {
    stackName: stackName(ctx.env, 'ec2'), template: 'infra/modules/ec2.yaml',
    params: Object.fromEntries(plan.changes.map((c) => [c.param, c.to])),
    tags: stackTags(ctx.env, 'ec2', registryVersion('ec2')),
  });
  const at = nowIso();
  for (const c of plan.changes) {
    const prev = ctx.state.baseParams[c.param];
    const contributors = (plan.by[c.param] ?? []) as ModuleId[];
    if (contributors.length) ctx.state.baseParams[c.param] = { value: c.to, original: prev?.original ?? c.from, by: contributors, at };
    else delete ctx.state.baseParams[c.param];
    if (ctx.state.base) ctx.state.base.params[c.param] = c.to;
  }
}

/** Staged env for the plan check: base config + module envs after the operation (+ placeholder secrets). */
export function stagedEnv(ctx: Ctx, records: CloudAlbumState['modules'], extraSecrets: EnvMap = {}): StagedEnv {
  const base: EnvMap = {
    AWS_REGION: ctx.region, CLOUDALBUM_ENV: ctx.env, DEPLOY_MODE: 'single',
    APP_BASE_URL: ctx.state.base?.publicIp ? `http://${ctx.state.base.publicIp}` : 'http://203.0.113.10',
    ...ctx.state.baseConfig,
  };
  const modules: StagedEnv['modules'] = {};
  for (const [id, r] of Object.entries(records)) if (r) modules[id as ModuleId] = r.env;
  const secrets: EnvMap = { ...extraSecrets };
  const env = mergedEnv(ctx.state, records);
  if (env.DB_DRIVER === 'postgres' && !env.DB_PASSWORD_SECRET_ARN) secrets.DB_PASSWORD ??= 'placeholder';
  if (env.IAM_CREDENTIALS === 'keys') { secrets.IAM_KEYS_ACCESS_KEY_ID ??= 'AKIAPLACEHOLDER'; secrets.IAM_KEYS_SECRET_ACCESS_KEY ??= 'placeholder'; }
  return { base, modules, secrets };
}

export function recordFor(prev: ModuleRecord | undefined, patch: Partial<ModuleRecord> & Pick<ModuleRecord, 'tier' | 'value' | 'env'>): ModuleRecord {
  const at = nowIso();
  return {
    enabledAt: prev?.enabledAt ?? at, updatedAt: at, version: 1, stacks: [], outputs: {}, params: {}, secretKeys: [],
    ...prev, ...patch,
  } as ModuleRecord;
}

export function envBefore(state: CloudAlbumState): EnvMap {
  return currentEnv(state);
}
