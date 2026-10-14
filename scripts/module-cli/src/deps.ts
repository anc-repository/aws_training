/**
 * Dependency planning for enable / disable / profile apply / plan --single (modular-design.md 5.1, 9.2 step 1, 10.4).
 *
 * The rule engine on the instance (backend check-config --plan) stays the authority; this planner answers the operator
 * questions BEFORE anything is deployed: which modules (or local tiers) must come first, in which order, and which needs
 * cannot be satisfied automatically (domain, SES identity, a sub-option value...).
 *   - hard dependencies = registry `requires` entries without `severity: warn` whose `when` holds for the planned env
 *   - credentials: required + AWS tier -> iam (role) (CRED-001; total outline 10.4 rule 2)
 *   - `a | b` -> the first branch that can be satisfied automatically (10.4 rule 1); local tiers before AWS values
 *   - order = topological order of the dependency edges, then registry `orderBefore` (10.1)
 */
import { isParamSwitch, type ModuleId } from '@cloudalbum/contracts';
import {
  MODULE_IDS, REGISTRY, isEnabled, isLoopback, isModuleId, localValue, moduleOf, switchValue, switchVar,
  type EnvView, type Registry,
} from './registry.js';
import type { EnvMap } from './env-file.js';

export type Tier = 'aws' | 'local' | 'self-hosted';

export interface ModuleTarget {
  module: ModuleId;
  /** switch value (enum switches) or 'aws' for parameter switches (the real value is an Env* output) */
  value: string;
  tier: Tier;
  /** additional env settings of this module (sub-options, self-hosted endpoint, local tier defaults) */
  settings: EnvMap;
}

export interface PlanStep extends ModuleTarget {
  reason: string;
  rule?: string;
  isTarget: boolean;
}

export interface PlanIssue {
  rule: string;
  module: ModuleId;
  need: string;
  message: string;
  /** what --with-deps would add */
  remedy?: ModuleTarget;
}

export interface DependencyPlan {
  steps: PlanStep[];
  issues: PlanIssue[];
  /** env after every step (placeholders for values that only exist after deployment) */
  env: EnvMap;
}

/**
 * Defaults of the keys that registry `when` / `need` clauses reference (pure L0 + sub-option defaults of the zod schema).
 * A unit test compares them with backend defaultEnv() so the two never drift.
 */
export const PLAN_DEFAULTS: Readonly<EnvMap> = Object.freeze({
  AMI_SOURCE: 'userdata', AUTH_DRIVER: 'local', AUTH_MIGRATION: 'bulk', CDN_BASE_URL: '', CDN_MEDIA_ORIGIN: 'ec2',
  CDN_ORIGIN_TYPE: 'ec2', COGNITO_LOGIN_MODE: 'sdk', COGNITO_TRIGGERS: 'off', DB_DRIVER: 'sqlite', DB_PROXY_AUTH: 'secrets',
  DB_PROXY_MODE: 'none', DEPLOY_MODE: 'single', DNS_PROVIDER: 'none', DNS_TARGET_TYPE: 'eip', EMAIL_DRIVER: 'outbox',
  EMAIL_FOR_COGNITO: 'off', IAM_CREDENTIALS: 'none', IDENTITY_DEV_PROVIDER: '', IMAGE_PROCESSOR: 'inline',
  IMAGE_RESULT_CHANNEL: 'callback', LB_ADMIN_AUTH: 'app', LB_HTTPS: 'false', LB_MODE: 'nginx', LB_ORIGIN_VERIFY: 'off',
  NETWORK_EIC_ENDPOINT: 'off', NETWORK_INTERFACE_ENDPOINTS: 'none', NETWORK_NAT_MODE: 'none', NETWORK_PLACEMENT: 'default',
  QUEUE_DRIVER: 'sync', SCHEDULER_TARGET: 'tick-queue', SECRETS_DRIVER: 'env', SHELL_ACCESS_MODE: 'ssh',
  SOCIAL_API_AUTHORIZER: 'none', SOCIAL_API_INTEGRATION: 'proxy', STORAGE_DRIVER: 'local', TAGGER_INPUT: 'auto',
  TLS_ACME: 'off', TLS_DOMAIN: '', TLS_FORCE_HTTPS: 'false', TLS_MODE: 'selfsigned', TRACING_DRIVER: 'none',
  VULN_SCAN_MODE: 'dnf', WAF_MODE: 'nginx', WORKFLOW_DRIVER: 'inline',
});

/** Settings written together with a self-hosted local tier (selfHosted.match must hold). */
export const SELF_HOSTED_SETTINGS: Readonly<Partial<Record<ModuleId, EnvMap>>> = {
  database: { DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'cloudalbum', DB_USER: 'cloudalbum', DB_SSL: 'disable' },
  cache: { REDIS_URL: 'redis://127.0.0.1:6379', REDIS_TLS: 'off', REDIS_CLIENT_MODE: 'single' },
};

/** Local-tier adjustments of single-module profiles (10.4 rule 3; registry has no singleLocalSettings field yet). */
export const SINGLE_LOCAL_SETTINGS: Readonly<Partial<Record<ModuleId, EnvMap>>> = {
  queue: { IMAGE_PROCESSOR: 'worker' },
};

/**
 * Sub-options of the module itself in its single-module profile (10.4 "可以单独启用的模块": tls needs a domain and
 * TLS_ACME=on; with TLS_ACME=off DEP-005 3 would pull in dns + cdn). The tls hook still probes the ACME endpoint at enable
 * time and falls back to TLS_ACME=off (with the DEP-005 3 dependencies) when it is not available. wave1-prep.
 */
export const SINGLE_TARGET_SETTINGS: Readonly<Partial<Record<ModuleId, EnvMap>>> = {
  tls: { TLS_ACME: 'on' },
};

export interface TargetOptions {
  driver?: string;
  selfHosted?: boolean;
  settings?: EnvMap;
}

/** Resolve what `enable <id> [--driver x] [--self-hosted]` means. */
export function resolveTarget(id: ModuleId, opts: TargetOptions = {}, registry: Registry = REGISTRY): ModuleTarget {
  const m = moduleOf(id, registry);
  if (id === 'ec2') throw new Error('ec2 is the base module: use `scripts/module base deploy` / `base set`');
  const sw = m.switch;
  if (!sw) throw new Error(`module ${id} has no switch`);
  const settings: EnvMap = { ...(opts.settings ?? {}) };
  if (isParamSwitch(sw)) {
    if (opts.driver && opts.driver !== 'aws') throw new Error(`${id} is a parameter module (${sw.var}); --driver is not supported`);
    return { module: id, value: 'aws', tier: 'aws', settings };
  }
  if (opts.selfHosted) {
    if (!m.selfHosted) throw new Error(`${id} has no self-hosted tier`);
    return { module: id, value: m.selfHosted.driver, tier: 'self-hosted', settings: { ...(SELF_HOSTED_SETTINGS[id] ?? {}), ...settings } };
  }
  const value = opts.driver ?? sw.ownedValues[0];
  if (!value) throw new Error(`${id} has no AWS value`);
  if (value === sw.values[0]) throw new Error(`${sw.var}=${value} is the local default of ${id}: use \`scripts/module disable ${id}\``);
  if (sw.localTiers.includes(value)) return { module: id, value, tier: 'local', settings };
  if (sw.ownedValues.includes(value)) return { module: id, value, tier: 'aws', settings };
  throw new Error(`${sw.var}=${value} is not owned by ${id} (values: ${sw.values.join(', ')}; owned: ${sw.ownedValues.join(', ')})`);
}

/** Env after applying a target (parameter switches get a placeholder until the stack output exists). */
export function applyTarget(env: Readonly<EnvMap>, t: ModuleTarget, registry: Registry = REGISTRY): EnvMap {
  const out: EnvMap = { ...env, ...t.settings };
  const v = switchVar(t.module, registry);
  if (v) {
    const sw = moduleOf(t.module, registry).switch;
    out[v] = sw && isParamSwitch(sw) ? (env[v] || `<${t.module}:${v}>`) : t.value;
  }
  return out;
}

/** Env after disabling a module: its switch back to the local value and its own keys removed. */
export function removeModule(env: Readonly<EnvMap>, id: ModuleId, ownKeys: readonly string[], registry: Registry = REGISTRY): EnvMap {
  const out: EnvMap = { ...env };
  for (const k of ownKeys) delete out[k];
  const v = switchVar(id, registry);
  if (v) out[v] = localValue(id, registry);
  return out;
}

function valueOf(env: EnvView, key: string): string {
  return env[key] ?? PLAN_DEFAULTS[key] ?? '';
}

function atomHolds(atom: string, env: EnvView, registry: Registry): boolean {
  const ne = atom.indexOf('!=');
  const eq = atom.indexOf('=');
  if (ne === -1 && eq === -1) {
    if (isModuleId(atom)) return isEnabled(env, atom, registry);
    return false;
  }
  const negate = ne !== -1 && ne === eq - 1;
  const key = (negate ? atom.slice(0, ne) : atom.slice(0, eq)).trim();
  const expected = (negate ? atom.slice(ne + 2) : atom.slice(eq + 1)).trim();
  const actual = valueOf(env, key);
  const match = expected === 'loopback' ? isLoopback(actual) : actual === expected;
  return negate ? !match : match;
}

export function needHolds(need: string, env: EnvView, registry: Registry = REGISTRY): boolean {
  return need.split('|').map((s) => s.trim()).filter(Boolean).some((a) => atomHolds(a, env, registry));
}

function whenApplies(when: Record<string, string> | undefined, id: ModuleId, env: EnvView, registry: Registry): boolean {
  if (!when || Object.keys(when).length === 0) return isEnabled(env, id, registry);
  return Object.entries(when).every(([k, v]) => valueOf(env, k) === String(v));
}

function moduleBySwitchVar(key: string, registry: Registry): ModuleId | undefined {
  return MODULE_IDS.find((id) => registry[id]?.switch?.var === key);
}

/**
 * What could satisfy one alternative of a need automatically: enabling a module (AWS or local tier),
 * or setting one of the requiring module's own sub-options. undefined = needs a human (domain, a value, ...).
 */
export function remedyForAtom(atom: string, requiring: ModuleId, registry: Registry = REGISTRY): ModuleTarget | 'own-setting' | undefined {
  if (isModuleId(atom)) {
    try { return resolveTarget(atom, {}, registry); } catch { return undefined; }
  }
  const ne = atom.indexOf('!=');
  const eq = atom.indexOf('=');
  if (eq === -1) return undefined;
  const negate = ne !== -1 && ne === eq - 1;
  const key = (negate ? atom.slice(0, ne) : atom.slice(0, eq)).trim();
  const expected = (negate ? atom.slice(ne + 2) : atom.slice(eq + 1)).trim();
  const owner = moduleBySwitchVar(key, registry);
  if (owner) {
    const sw = registry[owner]?.switch;
    if (!sw || isParamSwitch(sw)) {
      return negate && expected === '' ? resolveTargetSafe(owner, {}, registry) : undefined;
    }
    if (!negate) {
      if (sw.localTiers.includes(expected)) return { module: owner, value: expected, tier: 'local', settings: {} };
      if (sw.ownedValues.includes(expected)) return { module: owner, value: expected, tier: 'aws', settings: {} };
      return undefined;   // the local default of another module: it has to be disabled, not enabled
    }
    // VAR!=x: prefer a local tier (no AWS resource), then the first AWS value
    const candidates = [...sw.localTiers, ...sw.ownedValues].filter((v) => v !== expected);
    const v = candidates[0];
    if (!v) return undefined;
    return { module: owner, value: v, tier: sw.localTiers.includes(v) ? 'local' : 'aws', settings: {} };
  }
  // a sub-option of the requiring module itself with a concrete value (e.g. COGNITO_TRIGGERS=on)
  const ownerOfSetting = MODULE_IDS.find((id) => (registry[id]?.ownsEnv ?? []).some((p) => (p.endsWith('_') ? key.startsWith(p) : key === p)));
  if (ownerOfSetting === requiring && !negate && expected !== '' && expected !== 'loopback') return 'own-setting';
  return undefined;
}

function resolveTargetSafe(id: ModuleId, opts: TargetOptions, registry: Registry): ModuleTarget | undefined {
  try { return resolveTarget(id, opts, registry); } catch { return undefined; }
}

function ownSettingOf(atom: string): [string, string] {
  const eq = atom.indexOf('=');
  return [atom.slice(0, eq).trim(), atom.slice(eq + 1).trim()];
}

export interface PlanOptions {
  withDeps?: boolean;
  registry?: Registry;
}

/** Hard requirement entries of a module (severity error) that apply to `env`. */
export function hardRequirements(id: ModuleId, env: EnvView, registry: Registry) {
  const m = moduleOf(id, registry);
  const out: Array<{ rule: string; need: string }> = [];
  for (const r of m.requires ?? []) {
    if (r.severity === 'warn' || !r.need?.length) continue;
    if (!whenApplies(r.when, id, env, registry)) continue;
    for (const n of r.need) out.push({ rule: r.rule, need: n });
  }
  return out;
}

/** Plan enabling `target` on top of `currentEnv` (closure with --with-deps; issues otherwise). */
export function planEnable(currentEnv: Readonly<EnvMap>, target: ModuleTarget, opts: PlanOptions = {}): DependencyPlan {
  const registry = opts.registry ?? REGISTRY;
  const steps: PlanStep[] = [];
  const issues: PlanIssue[] = [];
  const edges: Array<[ModuleId, ModuleId]> = [];   // [dependency, dependent]
  let env: EnvMap = applyTarget(currentEnv, target, registry);
  steps.push({ ...target, reason: 'requested', isTarget: true });

  const queue: ModuleTarget[] = [target];
  const seen = new Set<string>();
  while (queue.length) {
    const t = queue.shift()!;
    const key = `${t.module}=${t.value}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // credentials prerequisite (CRED-001): required module on its AWS tier needs IAM_CREDENTIALS=role|keys
    const m = moduleOf(t.module, registry);
    if (t.tier === 'aws' && m.credentials === 'required' && t.module !== 'iam' && valueOf(env, 'IAM_CREDENTIALS') === 'none') {
      const remedy: ModuleTarget = { module: 'iam', value: 'role', tier: 'aws', settings: {} };
      edges.push(['iam', t.module]);
      if (opts.withDeps) {
        steps.push({ ...remedy, reason: `credentials prerequisite of ${t.module}`, rule: 'CRED-001', isTarget: false });
        env = applyTarget(env, remedy, registry);
        queue.push(remedy);
      } else {
        issues.push({ rule: 'CRED-001', module: t.module, need: 'IAM_CREDENTIALS=role',
          message: `${t.module} calls AWS APIs but IAM_CREDENTIALS=none`, remedy });
      }
    }

    for (const req of hardRequirements(t.module, env, registry)) {
      if (needHolds(req.need, env, registry)) continue;
      const alts = req.need.split('|').map((s) => s.trim()).filter(Boolean);
      let fixed = false;
      for (const alt of alts) {
        const r = remedyForAtom(alt, t.module, registry);
        if (!r) continue;
        if (r === 'own-setting') {
          const [k, v] = ownSettingOf(alt);
          if (opts.withDeps) {
            env[k] = v;
            const own = steps.find((s) => s.module === t.module);
            if (own) own.settings[k] = v;
          } else {
            issues.push({ rule: req.rule, module: t.module, need: req.need, message: `${t.module} needs ${alt} (--set ${alt})` });
          }
          fixed = true;
          break;
        }
        edges.push([r.module, t.module]);
        const already = steps.find((s) => s.module === r.module);
        if (already) { fixed = true; break; }
        if (opts.withDeps) {
          const reason = `${req.rule}: ${t.module} needs ${req.need}`;
          steps.push({ ...r, reason, rule: req.rule, isTarget: false });
          env = applyTarget(env, r, registry);
          queue.push(r);
        } else {
          issues.push({ rule: req.rule, module: t.module, need: req.need,
            message: `${t.module} needs ${req.need}${alts.length > 1 ? ` (first automatic branch: ${alt})` : ''}`, remedy: r });
        }
        fixed = true;
        break;
      }
      if (!fixed) {
        issues.push({ rule: req.rule, module: t.module, need: req.need,
          message: `${t.module} needs ${req.need}: cannot be satisfied automatically (manual prerequisite or explicit value)` });
      }
    }

    // MUTEX conflicts that the planned env would create
    for (const c of moduleOf(t.module, registry).conflicts ?? []) {
      if (c.module && (isEnabled(env, c.module, registry) || steps.some((s) => s.module === c.module))) {
        issues.push({ rule: c.rule, module: t.module, need: `!${c.module}`, message: `${t.module} conflicts with ${c.module}` });
      }
      if (c.need?.length && whenApplies(c.when, t.module, env, registry)) {
        for (const n of c.need) {
          if (!needHolds(n, env, registry)) issues.push({ rule: c.rule, module: t.module, need: n, message: `${t.module} conflicts: needs ${n}` });
        }
      }
    }
  }

  return { steps: orderSteps(steps, edges, registry), issues, env };
}

/** Topological order of the steps (dependencies first), then registry orderBefore, then registry order. */
export function orderSteps<T extends { module: ModuleId }>(steps: readonly T[], edges: ReadonlyArray<[ModuleId, ModuleId]>, registry: Registry = REGISTRY): T[] {
  const ids = steps.map((s) => s.module);
  const deps = new Map<ModuleId, Set<ModuleId>>(ids.map((id) => [id, new Set()]));
  for (const [dep, dependent] of edges) if (deps.has(dep) && deps.has(dependent) && dep !== dependent) deps.get(dependent)!.add(dep);
  for (const id of ids) {
    for (const later of registry[id]?.orderBefore ?? []) {
      if (deps.has(later) && !deps.get(id)!.has(later)) deps.get(later)!.add(id);
    }
  }
  // ties: ec2, then iam (the credentials provider, Lab 1), then registry order
  const rank = (id: ModuleId) => (id === 'ec2' ? -2 : id === 'iam' ? -1 : MODULE_IDS.indexOf(id));
  const out: T[] = [];
  const done = new Set<ModuleId>();
  while (out.length < steps.length) {
    const ready = steps.filter((s) => !done.has(s.module) && [...deps.get(s.module)!].every((d) => done.has(d)))
      .sort((a, b) => rank(a.module) - rank(b.module));
    const next = ready[0] ?? steps.filter((s) => !done.has(s.module)).sort((a, b) => rank(a.module) - rank(b.module))[0]!;   // cycle: registry order
    out.push(next);
    done.add(next.module);
  }
  return out;
}

/** Enabled modules (AWS tier, local tier or self-hosted) that would lose a hard requirement if `id` were disabled. */
export function reverseDependents(env: Readonly<EnvMap>, id: ModuleId, ownKeys: readonly string[], registry: Registry = REGISTRY): Array<{ module: ModuleId; rule: string; need: string }> {
  const after = removeModule(env, id, ownKeys, registry);
  const out: Array<{ module: ModuleId; rule: string; need: string }> = [];
  for (const other of MODULE_IDS) {
    if (other === id || other === 'ec2') continue;
    const active = switchValue(env, other, registry) !== localValue(other, registry) || isEnabled(env, other, registry);
    if (!active) continue;
    const m = moduleOf(other, registry);
    if (id === 'iam' && m.credentials === 'required' && isEnabled(env, other, registry)) {
      out.push({ module: other, rule: 'CRED-001', need: 'IAM_CREDENTIALS=role|keys' });
      continue;
    }
    for (const req of hardRequirements(other, env, registry)) {
      if (needHolds(req.need, env, registry) && !needHolds(req.need, after, registry)) {
        out.push({ module: other, rule: req.rule, need: req.need });
      }
    }
  }
  return out;
}
