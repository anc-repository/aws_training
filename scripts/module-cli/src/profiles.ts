/**
 * Profile files profiles/*.env (modular-design.md 10.1) and single-module profiles profiles/single/<id>.env (10.4).
 *   PROFILE_NAME, PROFILE_EXTENDS (inherit modules and values), PROFILE_MODULES (modules at their AWS value),
 *   PROFILE_DRIVERS (values of multi-value switches / sub-options; a local-tier value of a module that is not in
 *   PROFILE_MODULES enables that local tier), PROFILE_PARAMS (<module>.<StackParam>=value), PROFILE_LOCAL_SETTINGS
 *   (local-tier adjustments, 10.4 rule 3), PROFILE_OPTIONAL, PROFILE_PREREQUISITES, PROFILE_GATED,
 *   PROFILE_HOURLY_BILLED (hint only), PROFILE_LAB_BYPASS.
 * Profiles are only shortcuts: no profile-specific code (10.1).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isParamSwitch, type ModuleId } from '@cloudalbum/contracts';
import {
  SINGLE_LOCAL_SETTINGS, SINGLE_TARGET_SETTINGS, hardRequirements, planEnable, resolveTarget, type ModuleTarget,
} from './deps.js';
import { parseAssignments, parseEnvFile, splitList, type EnvMap } from './env-file.js';
import {
  MODULE_IDS, REGISTRY, isHourlyBilled, moduleOf, ownerOfKey, parseModuleId, type Registry,
} from './registry.js';

export interface ProfileFile {
  name: string;
  extends?: string;
  modules: ModuleId[];
  drivers: EnvMap;
  params: Record<string, string>;
  localSettings: EnvMap;
  optional: ModuleId[];
  prerequisites: string[];
  gated: string[];
  hourlyBilled: ModuleId[];
  labBypass: 'on' | 'off';
}

export function parseProfile(text: string, fallbackName = ''): ProfileFile {
  const e = parseEnvFile(text);
  const ids = (k: string) => splitList(e[k]).map((x) => parseModuleId(x));
  return {
    name: e.PROFILE_NAME || fallbackName,
    ...(e.PROFILE_EXTENDS ? { extends: e.PROFILE_EXTENDS } : {}),
    modules: ids('PROFILE_MODULES'),
    drivers: parseAssignments(e.PROFILE_DRIVERS ? [e.PROFILE_DRIVERS] : [], 'PROFILE_DRIVERS'),
    params: parseAssignments(e.PROFILE_PARAMS ? [e.PROFILE_PARAMS] : [], 'PROFILE_PARAMS'),
    localSettings: parseAssignments(e.PROFILE_LOCAL_SETTINGS ? [e.PROFILE_LOCAL_SETTINGS] : [], 'PROFILE_LOCAL_SETTINGS'),
    optional: ids('PROFILE_OPTIONAL'),
    prerequisites: splitList(e.PROFILE_PREREQUISITES),
    gated: splitList(e.PROFILE_GATED),
    hourlyBilled: ids('PROFILE_HOURLY_BILLED'),
    labBypass: e.PROFILE_LAB_BYPASS === 'off' ? 'off' : 'on',
  };
}

export function profilePath(repoRoot: string, name: string): string {
  return path.join(repoRoot, 'profiles', ...`${name}.env`.split('/'));
}

export function loadProfileFile(repoRoot: string, name: string): ProfileFile {
  const file = profilePath(repoRoot, name);
  if (!existsSync(file)) throw new Error(`profile ${name} not found (${path.relative(repoRoot, file)})`);
  return parseProfile(readFileSync(file, 'utf8'), name);
}

export interface ResolvedProfile {
  name: string;
  chain: string[];
  /** module -> what the profile wants (AWS value, local tier or self-hosted) */
  targets: Map<ModuleId, ModuleTarget>;
  /** <module> -> { StackParam: value } */
  params: Partial<Record<ModuleId, Record<string, string>>>;
  prerequisites: string[];
  hourlyBilled: ModuleId[];
  labBypass: 'on' | 'off';
}

/** Merge the PROFILE_EXTENDS chain (parents first) and turn it into module targets. */
export function resolveProfile(load: (name: string) => ProfileFile, name: string, opts: { withOptional?: boolean } = {}, registry: Registry = REGISTRY): ResolvedProfile {
  const chain: ProfileFile[] = [];
  const seen = new Set<string>();
  for (let n: string | undefined = name; n; n = chain[chain.length - 1]?.extends) {
    if (seen.has(n)) throw new Error(`PROFILE_EXTENDS cycle at ${n}`);
    seen.add(n);
    chain.push(load(n));
  }
  chain.reverse();
  const modules: ModuleId[] = [];
  const drivers: EnvMap = {};
  const local: EnvMap = {};
  const params: ResolvedProfile['params'] = {};
  const prerequisites = new Set<string>();
  const hourly = new Set<ModuleId>();
  for (const p of chain) {
    for (const m of [...p.modules, ...(opts.withOptional ? p.optional : [])]) if (!modules.includes(m)) modules.push(m);
    Object.assign(drivers, p.drivers);
    Object.assign(local, p.localSettings);
    for (const [k, v] of Object.entries(p.params)) {
      const dot = k.indexOf('.');
      if (dot <= 0) throw new Error(`PROFILE_PARAMS entry ${k} must be <module>.<Param>`);
      const id = parseModuleId(k.slice(0, dot));
      params[id] = { ...(params[id] ?? {}), [k.slice(dot + 1)]: v };
    }
    p.prerequisites.forEach((x) => prerequisites.add(x));
    p.hourlyBilled.forEach((x) => hourly.add(x));
  }
  const targets = new Map<ModuleId, ModuleTarget>();
  const settingsOf = (id: ModuleId, source: EnvMap) => Object.fromEntries(Object.entries(source)
    .filter(([k]) => k !== moduleOf(id, registry).switch?.var && ownerOfKey(k, registry) === id));
  for (const id of modules) {
    const sw = moduleOf(id, registry).switch;
    const driver = sw && !isParamSwitch(sw) ? drivers[sw.var] : undefined;
    targets.set(id, resolveTarget(id, { ...(driver ? { driver } : {}), settings: { ...settingsOf(id, drivers), ...settingsOf(id, local) } }, registry));
  }
  // local tiers of modules that are not in PROFILE_MODULES (PROFILE_LOCAL_SETTINGS or a local value in PROFILE_DRIVERS)
  for (const [k, v] of Object.entries({ ...drivers, ...local })) {
    const owner = MODULE_IDS.find((id) => registry[id]?.switch?.var === k);
    if (!owner || targets.has(owner)) continue;
    const sw = registry[owner]?.switch;
    if (!sw || isParamSwitch(sw)) continue;
    const settings = { ...settingsOf(owner, drivers), ...settingsOf(owner, local) };
    if (sw.localTiers.includes(v)) targets.set(owner, resolveTarget(owner, { driver: v, settings }, registry));
    else if (registry[owner]?.selfHosted?.driver === v) targets.set(owner, resolveTarget(owner, { selfHosted: true, settings }, registry));
  }
  return {
    name, chain: chain.map((p) => p.name), targets, params, prerequisites: [...prerequisites], hourlyBilled: [...hourly],
    labBypass: chain[chain.length - 1]?.labBypass ?? 'on',
  };
}

const AUTO_PREREQS = new Set(['toolchain']);   // satisfied by `scripts/module bootstrap` (10.4 rule 4)

/** profiles/single/<id>.env content (10.4): L0 + module + minimal hard deps + credential prerequisite + local tiers. */
export function generateSingleProfile(id: ModuleId, registry: Registry = REGISTRY): string {
  const own = { ...(SINGLE_TARGET_SETTINGS[id] ?? {}) };
  const target = resolveTarget(id, { settings: { ...own } }, registry);
  const plan = planEnable({}, target, { withDeps: true, registry });
  const local = { ...(SINGLE_LOCAL_SETTINGS[id] ?? {}) };
  const modules = plan.steps.filter((s) => s.tier === 'aws').map((s) => s.module);
  const drivers: string[] = [];
  for (const s of plan.steps) {
    const sw = moduleOf(s.module, registry).switch;
    if (!sw || isParamSwitch(sw)) continue;
    if (s.tier === 'aws') drivers.push(`${sw.var}=${s.value}`);
    else local[sw.var] = s.value;
  }
  for (const [k, v] of Object.entries(own)) drivers.push(`${k}=${v}`);   // the module's own sub-options (SINGLE_TARGET_SETTINGS)
  const allPrereqs = [...new Set(plan.steps.flatMap((s) => moduleOf(s.module, registry).prerequisites ?? []))];
  const prerequisites = allPrereqs.filter((p) => !AUTO_PREREQS.has(p));
  const autoPrereqs = allPrereqs.filter((p) => AUTO_PREREQS.has(p));
  const hourly = modules.filter((m) => isHourlyBilled(m, registry));
  const alternatives: string[] = [];
  for (const s of plan.steps) {
    for (const r of hardRequirements(s.module, plan.env, registry)) {
      if (r.need.includes('|')) alternatives.push(`# ${r.rule} (${s.module}): "${r.need}" -> first automatic branch; the others are alternatives`);
    }
  }
  const issues = plan.issues.map((i) => `# needs a human: ${i.rule} ${i.message}`);
  const lines = [
    `# profiles/single/${id}.env — generated by \`scripts/module profile gen-single ${id}\` (modular-design.md 10.4); do not edit by hand.`,
    `# L0 + ${id} + minimal hard dependencies + credential prerequisite (iam role) + local-tier adjustments.`,
    ...plan.steps.map((s) => `#   ${s.module}: ${s.tier}${s.value === 'aws' ? '' : ` ${s.value}`} — ${s.reason}${s.rule ? ` (${s.rule})` : ''}`),
    ...alternatives,
    ...autoPrereqs.map((p) => `# prerequisite ${p}: satisfied by \`scripts/module bootstrap\``),
    ...issues,
    `PROFILE_NAME=single/${id}`,
    'PROFILE_EXTENDS=l0-ec2',
    `PROFILE_MODULES=${modules.join(',')}`,
    `PROFILE_DRIVERS=${drivers.join(',')}`,
    'PROFILE_PARAMS=',
    `PROFILE_LOCAL_SETTINGS=${Object.entries(local).map(([k, v]) => `${k}=${v}`).join(',')}`,
    'PROFILE_OPTIONAL=',
    `PROFILE_PREREQUISITES=${prerequisites.join(',')}`,
    'PROFILE_GATED=',
    `PROFILE_HOURLY_BILLED=${hourly.join(',')}`,
    'PROFILE_LAB_BYPASS=on',
  ];
  return `${lines.join('\n')}\n`;
}
