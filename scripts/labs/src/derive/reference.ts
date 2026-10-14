/**
 * Reference start-state derivation (06 PM-33 algorithm) used by `labs:derive` while `scripts/module plan --start-of` is
 * not available (it is the 06 P0 item of the CloudAlbum platform mode). It does not re-implement dependency solving:
 * closures, branch choice, credentials and ordering come from scripts/module-cli's own planner (`deps.ts`: planEnable,
 * resolveTarget, orderSteps — the code behind `scripts/module plan <id> --single`), loaded at run time.
 *
 * Differences from the real command (documented in implementation-notes platform-content):
 *   - the backend rule engine is not run on the start state (PM-33 step 8 “有 error 则退出 2”); only registry `requires`
 *     are evaluated (hard → errors, `severity: warn` → warnings);
 *   - `singleLocalSettings` / `singleRuntime` come from the registry when present (06 PM-34), otherwise from
 *     module-cli's SINGLE_LOCAL_SETTINGS (the same table `plan --start-of` uses);
 *   - `remedy` of rules (ASG-001…003, DEP-009) is not evaluated: cards whose closure depends on it fail loudly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LabV2, ProvisionItem, StartVariant, TargetModule } from '@atl/shared';
import type { LabsPaths } from '../paths.js';
import { loadRegistry, ownerOfKey, registryVersion, toolkitVersion, type RegistryModule } from '../registry.js';
import { PLAN_SCHEMA, planDigest, profileNameOf, str, strMap, type PlanEntry, type PlanOutput } from './plan.js';

type EnvMap = Record<string, string>;

interface ModuleTarget {
  module: string;
  value: string;
  tier: 'aws' | 'local' | 'self-hosted';
  settings: EnvMap;
}

interface PlanStep extends ModuleTarget {
  reason: string;
  rule?: string;
  isTarget: boolean;
}

interface ModuleCliDeps {
  resolveTarget(id: string, opts?: { driver?: string; selfHosted?: boolean; settings?: EnvMap }): ModuleTarget;
  planEnable(env: EnvMap, target: ModuleTarget, opts?: { withDeps?: boolean }): { steps: PlanStep[]; issues: { rule: string; module: string; need: string; message: string }[]; env: EnvMap };
  needHolds(need: string, env: EnvMap): boolean;
  PLAN_DEFAULTS: Readonly<EnvMap>;
  SINGLE_LOCAL_SETTINGS?: Readonly<Record<string, EnvMap>>;
}

/** C3: cards that do not pre-provision iam(role). */
export const NO_IAM_CARDS = new Set(['svc-ec2', 'svc-iam']);

let depsPromise: Promise<ModuleCliDeps> | null = null;

export async function loadModuleCliDeps(p: LabsPaths): Promise<ModuleCliDeps> {
  if (!depsPromise) {
    depsPromise = (async () => {
      const candidates = [path.join(p.moduleCli, 'src', 'deps.ts'), path.join(p.moduleCli, 'dist', 'deps.js')];
      let lastError: unknown = null;
      for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        try {
          return (await import(pathToFileURL(file).href)) as ModuleCliDeps;
        } catch (e) {
          lastError = e;
        }
      }
      throw new Error(`scripts/module-cli planner not loadable (${candidates.join(', ')}): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    })();
  }
  return depsPromise;
}

function switchOf(reg: Record<string, RegistryModule>, id: string) {
  return reg[id]?.switch;
}

function isEnumSwitch(reg: Record<string, RegistryModule>, id: string): boolean {
  const sw = switchOf(reg, id);
  return !!sw && sw.kind !== 'param';
}

/** Variant view: provisions / branches / platform / targetModules overridden by the variant (PM-33 step 1). */
export function variantView(lab: LabV2, variant: string): {
  provisions: ProvisionItem[];
  branches: NonNullable<LabV2['startProfile']['branches']>;
  targets: TargetModule[];
  variantDef: StartVariant | null;
} {
  const v = variant === 'default' ? null : (lab.startProfile.variants ?? []).find((x) => x.id === variant) ?? null;
  return {
    provisions: v?.provisions ?? lab.startProfile.provisions,
    branches: v?.branches ?? lab.startProfile.branches ?? {},
    targets: v?.targetModules ?? lab.targetModules,
    variantDef: v,
  };
}

/** Wire-step order of the targets (the manual order, DRV-6/DRV-7). */
export function targetsInManualOrder(lab: LabV2, targets: readonly TargetModule[]): TargetModule[] {
  const idx = new Map(lab.steps.map((s, i) => [s.id, i]));
  return [...targets].sort((a, b) => (idx.get(a.wireStep) ?? 999) - (idx.get(b.wireStep) ?? 999));
}

function whenApplies(when: Record<string, string> | undefined, module: string, env: EnvMap, defaults: Readonly<EnvMap>, enabled: (id: string) => boolean): boolean {
  if (!when || !Object.keys(when).length) return enabled(module);
  return Object.entries(when).every(([k, v]) => (env[k] ?? defaults[k] ?? '') === String(v));
}

export async function referencePlan(p: LabsPaths, lab: LabV2, variant = 'default'): Promise<PlanOutput> {
  const deps = await loadModuleCliDeps(p);
  const reg = loadRegistry(p).modules;
  const view = variantView(lab, variant);
  const errors: string[] = [];
  const start: PlanEntry[] = [{ id: 'ec2', kind: 'module', basis: 'base' }];
  let env: EnvMap = {};
  const add = (e: PlanEntry) => {
    const same = start.find((x) => x.id === e.id && x.kind === e.kind);
    if (same) {
      same.set = { ...(same.set ?? {}), ...(e.set ?? {}) };
      same.params = { ...(same.params ?? {}), ...(e.params ?? {}) };
      if (e.because?.length) same.because = [...new Set([...(same.because ?? []), ...e.because])];
      return;
    }
    start.push(e);
  };

  // step 3: base + C3 iam(role)
  if (!NO_IAM_CARDS.has(lab.id)) {
    add({ id: 'iam', kind: 'module', basis: 'credential', set: { IAM_CREDENTIALS: 'role' }, because: ['C3'] });
    env.IAM_CREDENTIALS = 'role';
  }

  const allTargets = view.targets;
  const required = targetsInManualOrder(lab, allTargets.filter((t) => !t.optional));
  const targetIds = new Set(allTargets.map((t) => t.id));

  // step 5: precursors (fromDriver)
  for (const t of allTargets) {
    if (!t.fromDriver) continue;
    const sw = switchOf(reg, t.id);
    if (!sw) {
      errors.push(`${t.id}: no switch in the registry`);
      continue;
    }
    if (sw.kind === 'param') continue;
    if (t.fromDriver === sw.values?.[0]) continue; // the local default is not a start-state entry
    const local = (sw.localTiers ?? []).includes(t.fromDriver);
    add({ id: t.id, kind: local ? 'local' : 'module', basis: 'precursor', set: { [sw.var]: t.fromDriver }, because: ['fromDriver'] });
    env[sw.var] = t.fromDriver;
  }

  // step 6: single-card local settings / runtime keys; scenario cards: declared local / runtime entries
  if (lab.kind === 'service') {
    for (const t of required) {
      const m = reg[t.id];
      const local = m?.singleLocalSettings ?? deps.SINGLE_LOCAL_SETTINGS?.[t.id] ?? {};
      for (const [k, v] of Object.entries(local)) {
        const owner = ownerOfKey(p, k) ?? t.id;
        add({ id: owner, kind: 'local', basis: 'single', set: { [k]: str(v) }, because: ['singleLocalSettings'] });
        env[k] = str(v);
      }
      const rt = m?.singleRuntime;
      for (const [k, v] of Object.entries(rt ?? {})) add({ id: k, kind: 'runtime', basis: 'single', value: str(v), because: ['singleRuntime'] });
    }
    // declared runtime keys count on service cards too (scripts/module plan-start step 6 reads provisions kind runtime for
    // every card kind; svc-logging / svc-monitoring declare featureFlags.lab.faults)
    for (const pr of view.provisions) {
      if (pr.kind === 'runtime') add({ id: pr.item, kind: 'runtime', basis: 'single', value: str(pr.value ?? true), because: ['declared'] });
    }
  } else {
    for (const pr of view.provisions) {
      if (pr.kind === 'local') {
        add({ id: pr.item, kind: 'local', basis: 'single', set: strMap(pr.set) ?? {}, because: ['declared'] });
        Object.assign(env, strMap(pr.set) ?? {});
      } else if (pr.kind === 'runtime') {
        add({ id: pr.item, kind: 'runtime', basis: 'single', value: str(pr.value ?? true), because: ['declared'] });
      }
    }
  }

  // step 7: background modules of scenario cards (+ their closure)
  const enable = (t: ModuleTarget, basis: PlanEntry['basis'], because: string[], params?: Record<string, string>) => {
    const sw = switchOf(reg, t.module);
    const set: EnvMap = { ...(t.settings ?? {}) };
    if (sw && sw.kind !== 'param' && t.value !== 'aws') set[sw.var] = t.value;
    add({ id: t.module, kind: t.tier === 'aws' ? 'module' : 'local', basis, set, ...(params && Object.keys(params).length ? { params } : {}), because });
  };
  if (lab.kind === 'scenario') {
    for (const pr of view.provisions.filter((x) => x.kind === 'module' && x.basis === 'context')) {
      try {
        const sw = switchOf(reg, pr.item);
        const settings = strMap(pr.set) ?? {};
        const driver = sw && sw.kind !== 'param' ? settings[sw.var] : undefined;
        const target = deps.resolveTarget(pr.item, { ...(driver ? { driver } : {}), settings });
        const plan = deps.planEnable(env, target, { withDeps: true });
        for (const s of plan.steps) {
          if (s.isTarget) enable(s, 'context', ['context'], strMap(pr.params));
          else if (!start.some((e) => e.id === s.module)) enable(s, 'closure', [s.rule ?? 'requires']);
        }
        env = plan.env;
      } catch (e) {
        errors.push(`context ${pr.item}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // step 4: closure of the required targets, in manual order; branches are honoured by enabling the chosen module first
  const targetDeps: Record<string, string[]> = {};
  for (const [rule, b] of Object.entries(view.branches)) {
    if (targetIds.has(b.choose) || start.some((e) => e.id === b.choose)) continue;
    try {
      const t = deps.resolveTarget(b.choose, {});
      const plan = deps.planEnable(env, t, { withDeps: true });
      for (const s of plan.steps) enable(s, 'closure', [s.isTarget ? rule : (s.rule ?? rule)]);
      env = plan.env;
    } catch (e) {
      errors.push(`branch ${rule} → ${b.choose}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const startEnv = { ...env };
  let cumulative = { ...env };
  for (const t of targetsInManualOrder(lab, allTargets)) {
    let target: ModuleTarget;
    try {
      const settings = strMap(t.set) ?? {};
      target = deps.resolveTarget(t.id, { ...(isEnumSwitch(reg, t.id) ? { driver: t.driver } : {}), settings });
    } catch (e) {
      errors.push(`target ${t.id}=${t.driver}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // DRV-5: the target value must not already hold in the start state
    const sw = switchOf(reg, t.id);
    if (sw && sw.kind !== 'param' && startEnv[sw.var] === target.value && !t.params) {
      errors.push(`DRV-5: target ${t.id}=${target.value} already holds in the start state`);
    }
    const plan = deps.planEnable(cumulative, target, { withDeps: true });
    for (const s of plan.steps) {
      if (s.isTarget) continue;
      if (targetIds.has(s.module)) {
        (targetDeps[t.id] ??= []).push(s.module);
        continue;
      }
      if (t.optional) continue; // the dependencies of an optional target must already be in the start state (04 §3.2.4)
      if (start.some((e) => e.id === s.module && e.kind === 'module')) continue;
      enable(s, 'closure', [s.rule ?? 'requires']);
      startEnv[switchOf(reg, s.module)?.var ?? s.module] = s.value;
    }
    for (const i of plan.issues) if (!t.optional) errors.push(`${i.rule}: ${i.message}`);
    cumulative = plan.env;
  }

  // warnings after enabling every target in manual order (registry `severity: warn` requirements, DRV-6)
  const enabledIn = (e: EnvMap) => (id: string) => {
    const sw = switchOf(reg, id);
    if (!sw) return id === 'ec2';
    if (sw.kind === 'param') return Boolean(e[sw.var]);
    return (sw.ownedValues ?? []).includes(e[sw.var] ?? deps.PLAN_DEFAULTS[sw.var] ?? sw.values?.[0] ?? '');
  };
  const warnings: string[] = [];
  const isOn = enabledIn(cumulative);
  for (const [id, m] of Object.entries(reg)) {
    if (!isOn(id)) continue;
    for (const r of m.requires ?? []) {
      if (r.severity !== 'warn') continue;
      if (!whenApplies(r.when, id, cumulative, deps.PLAN_DEFAULTS, isOn)) continue;
      const need = r.need ?? [];
      if (need.length === 0 ? true : need.some((n) => !deps.needHolds(n, cumulative))) warnings.push(r.rule);
    }
  }

  // step 9: platform section (06 PM-21 rule 1) and base parameters
  const all = new Set([...start.map((e) => e.id), ...allTargets.map((t) => t.id)]);
  const privateNet = [...start, ...allTargets.map((t) => ({ id: t.id, set: strMap(t.set) }))].some(
    (e) => e.id === 'network' && (e.set?.NETWORK_PLACEMENT === 'private' || (allTargets.find((t) => t.id === 'network')?.driver === 'private')),
  );
  const closedIngress = start.some((e) => e.set?.CDN_DIRECT_ACCESS !== undefined && e.set.CDN_DIRECT_ACCESS !== 'open');
  const off = all.has('autoscaling') || allTargets.some((t) => t.id === 'tls') || privateNet || closedIngress;
  const baseParams: Record<string, string> = {};
  if (lab.workstation?.sshFromWorkstation) {
    baseParams.SshIngressCidr = start.some((e) => e.id === 'network') ? '${atl:workstationPublicCidr}' : '${atl:workstationPrivateCidr}';
  }
  const extraStacks = (lab.extraStacks ?? []).filter((x) => x.deploy === 'start').map((x) => ({ id: x.id, region: x.region }));
  const seeds = view.provisions.filter((x) => x.kind === 'seed').map((x) => x.item);
  const branches = Object.fromEntries(Object.entries(view.branches).map(([k, v]) => [k, { choose: v.choose }]));
  const platform = { 'preview.directHttps': off ? ('off' as const) : ('on' as const) };
  const rv = registryVersion(p);
  const rank = (id: string) => (id === 'ec2' ? -2 : id === 'iam' ? -1 : Object.keys(reg).indexOf(id));
  const order = start.filter((e) => e.kind === 'module' && e.basis !== 'base').map((e) => e.id).sort((a, b) => rank(a) - rank(b));
  return {
    schema: PLAN_SCHEMA,
    deriver: 'reference',
    registryVersion: rv,
    toolkitVersion: toolkitVersion(p),
    card: lab.id,
    variant,
    profileName: profileNameOf(lab.id, variant),
    start,
    targets: allTargets.map((t) => ({ id: t.id, driver: t.driver, ...(t.fromDriver ? { fromDriver: t.fromDriver } : {}) })),
    branches,
    platform,
    baseParams,
    warnings: [...new Set(warnings)].sort(),
    errors,
    order,
    seeds,
    extraStacks,
    targetDeps,
    digest: planDigest({ card: lab.id, variant, registryVersion: rv, start, platform, baseParams, extraStacks }),
  };
}
