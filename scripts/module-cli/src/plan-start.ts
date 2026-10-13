/**
 * Start-state derivation `plan --start-of <card-id> [--variant <v>] [--lab-file <path>]` and the runtime re-check
 * `plan --profile atl/<card-id>/<variant>` (06 PM-32, PM-33; C3).
 *
 * Pure computation: reads labs/<card-id>/lab.yaml, the registry and (when the backend is built) the rule engine through
 * `check-config --plan`; never any session state, so CI can run it without credentials.
 *   start = l0-ec2 + iam(role) (not for svc-ec2 / svc-iam) + the hard-dependency closure of the targets (registry requires and
 *           CRED-001, `a | b` per `branches` or the first automatic branch) + precursor values (targetModules[].fromDriver) +
 *           local settings (single-service cards: SINGLE_LOCAL_SETTINGS; scenario cards: provisions kind local / runtime) +
 *           context modules (scenario cards, basis context) and their closure
 *   platform.preview.directHttps (PM-21 rule 1): off when start / targets contain autoscaling, targets contain tls,
 *           PublicHttpIngress≠open or network goes private; on otherwise
 *   digest = sha256 of RFC 8785 { schema, card, variant, registryVersion, modules[{id, kind, set, params, value}] (sorted by id,
 *           ec2 excluded), platform, baseParams, extraStacks[{id, region}] } — explanatory fields (because, order, seeds)
 *           are not part of it. `plan --profile` rebuilds the same object from the profile file; registryVersion is always the
 *           registry of THIS toolkit, so a toolkit / content mismatch changes the digest (runner: PROFILE_DIGEST_MISMATCH).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';
import { canonicalJson, isParamSwitch, isSeedId, SEED_IDS, type ModuleId } from '@cloudalbum/contracts';
import { REGISTRY_DOCUMENT } from '@cloudalbum/contracts/registry';
import {
  SINGLE_LOCAL_SETTINGS, applyTarget, orderSteps, planEnable, resolveTarget, type ModuleTarget,
} from './deps.js';
import { parseEnvFile, splitList, type EnvMap } from './env-file.js';
import { CliError, EXIT } from './printer.js';
import { MODULE_IDS, REGISTRY, isModuleId, moduleOf, ownerOfKey, switchVar } from './registry.js';

export const PLAN_SCHEMA = 'cloudalbum.plan/v1';
const NO_IAM_CARDS = new Set(['svc-ec2', 'svc-iam']);
const PLACEHOLDER_RE = /\$\{atl:[A-Za-z]+\}/;

export type EntryKind = 'module' | 'local' | 'runtime';
export type Basis = 'base' | 'credential' | 'closure' | 'precursor' | 'context';

export interface StartEntry {
  id: string;
  kind: EntryKind;
  basis?: Basis;
  set?: Record<string, string>;
  params?: Record<string, string>;
  value?: string | number | boolean;
  because?: string[];
}

/** the normalized object both entry points hash (and the content of a profile file) */
export interface ProfileSpec {
  card: string;
  variant: string;
  modules: Array<{ id: string; kind: EntryKind; set: Record<string, string>; params: Record<string, string>; value: string | number | boolean | null }>;
  platform: Record<string, string>;
  baseParams: Record<string, string>;
  extraStacks: Array<{ id: string; region: string }>;
  seeds: string[];
}

export interface PlanResult {
  schema: typeof PLAN_SCHEMA;
  registryVersion: string;
  toolkitVersion: string;
  card: string;
  variant: string;
  profileName: string;
  start: StartEntry[];
  targets: Array<{ id: string; driver: string; fromDriver?: string; set?: Record<string, string>; params?: Record<string, string> }>;
  branches: Record<string, string>;
  platform: Record<string, string>;
  baseParams: Record<string, string>;
  warnings: string[];
  order: string[];
  provision: { class: string | null };
  extraStacks: Array<{ id: string; region: string }>;
  seeds: string[];
  digest: string;
}

// ------------------------------------------------------------------------------------------------ versions & digest

/** registry version of THIS toolkit: document version + content hash (any registry change changes the digest) */
export function toolkitRegistryVersion(): string {
  const h = createHash('sha256').update(canonicalJson(REGISTRY_DOCUMENT)).digest('hex').slice(0, 12);
  return `${String((REGISTRY_DOCUMENT as { version?: unknown }).version ?? 0)}+${h}`;
}

export function toolkitVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function sortObj(o: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** digest object (PM-33 step 11) */
export function digestObject(spec: ProfileSpec, registryVersion = toolkitRegistryVersion()): Record<string, unknown> {
  const modules = spec.modules
    .filter((m) => m.id !== 'ec2')
    .map((m) => ({ id: m.id, kind: m.kind, set: sortObj(m.set), params: sortObj(m.params), value: m.value ?? null }))
    .sort((a, b) => (a.id === b.id ? (a.kind < b.kind ? -1 : 1) : a.id < b.id ? -1 : 1));
  return {
    schema: PLAN_SCHEMA, card: spec.card, variant: spec.variant, registryVersion, modules,
    platform: sortObj(spec.platform), baseParams: sortObj(spec.baseParams), extraStacks: spec.extraStacks.map((x) => ({ id: x.id, region: x.region })),
  };
}

export function specDigest(spec: ProfileSpec, registryVersion?: string): string {
  return `sha256:${createHash('sha256').update(canonicalJson(digestObject(spec, registryVersion))).digest('hex')}`;
}

// ------------------------------------------------------------------------------------------------ lab.yaml

type Scalar = string | number | boolean;
interface ProvisionItem { item: string; kind: string; basis?: string; set?: Record<string, Scalar>; params?: Record<string, Scalar>; value?: Scalar; rule?: string | string[]; reason?: string }
interface TargetModuleDoc { id: string; driver: string; fromDriver?: string; set?: Record<string, Scalar>; params?: Record<string, Scalar>; optional?: boolean }
interface VariantDoc { id: string; provisions: ProvisionItem[]; branches?: Record<string, { choose: string }>; platform?: { preview?: { directHttps?: string } }; targetModules?: TargetModuleDoc[] }
export interface LabDoc {
  id: string;
  kind: 'service' | 'scenario';
  startProfile: { provisions: ProvisionItem[]; branches?: Record<string, { choose: string }>; platform?: { preview?: { directHttps?: string } }; variants?: VariantDoc[] };
  targetModules: TargetModuleDoc[];
  workstation?: { sshFromWorkstation?: boolean };
  provision?: { class?: string };
  extraStacks?: Array<{ id: string; region: string; deploy: string; when?: string }>;
}

const CARD_RE = /^(svc|sc)-[a-z0-9]+(-[a-z0-9]+)*$/;
const VARIANT_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function labPath(repoRoot: string, card: string): string {
  return path.join(repoRoot, 'labs', card, 'lab.yaml');
}

export function loadLab(repoRoot: string, card: string, labFile?: string): LabDoc {
  if (!CARD_RE.test(card)) throw new CliError(`invalid card id ${card}`, EXIT.rules, 'CARD_INVALID');
  const file = labFile ? path.resolve(labFile) : labPath(repoRoot, card);
  if (!existsSync(file)) throw new CliError(`lab.yaml not found: ${file}`, EXIT.rules, 'CARD_NOT_FOUND');
  const doc = parseYaml(readFileSync(file, 'utf8')) as LabDoc;
  if (!doc || doc.id !== card) throw new CliError(`${file}: id is ${String(doc?.id)}, expected ${card}`, EXIT.rules, 'CARD_INVALID');
  if (!doc.startProfile || !Array.isArray(doc.targetModules)) throw new CliError(`${file}: startProfile / targetModules missing`, EXIT.rules, 'CARD_INVALID');
  return doc;
}

export function listCards(repoRoot: string): string[] {
  const dir = path.join(repoRoot, 'labs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => CARD_RE.test(d) && existsSync(path.join(dir, d, 'lab.yaml'))).sort();
}

export function variantsOf(lab: LabDoc): string[] {
  return ['default', ...(lab.startProfile.variants ?? []).map((v) => v.id).filter((id) => id !== 'default')];
}

const str = (o: Record<string, Scalar> | undefined): Record<string, string> => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, String(v)]));

// ------------------------------------------------------------------------------------------------ derivation

export interface PlanStartOptions {
  variant?: string;
  repoRoot: string;
  /** rule engine on the start state (staged check-config --plan); undefined = skipped */
  check?: (start: StartEntry[]) => { ran: boolean; ok: boolean; errors: Array<{ rule: string; message: string }>; warnings: Array<{ rule: string }>; reason?: string };
}

function previewDirectHttps(start: StartEntry[], targets: TargetModuleDoc[], baseParams: Record<string, string>): 'on' | 'off' {
  const has = (id: string) => start.some((e) => e.id === id && e.kind === 'module');
  if (has('autoscaling') || targets.some((t) => t.id === 'autoscaling')) return 'off';
  if (targets.some((t) => t.id === 'tls')) return 'off';
  if ((baseParams.PublicHttpIngress ?? 'open') !== 'open') return 'off';
  const net = start.find((e) => e.id === 'network');
  if (net?.set?.NETWORK_PLACEMENT === 'private' || targets.some((t) => t.id === 'network' && t.driver === 'private')) return 'off';
  return 'on';
}

function targetOf(t: TargetModuleDoc, value?: string): ModuleTarget {
  const id = t.id as ModuleId;
  const sw = moduleOf(id).switch;
  const settings = str(t.set);
  const driver = value ?? t.driver;
  if (sw && isParamSwitch(sw)) return resolveTarget(id, { settings });
  return resolveTarget(id, { driver, settings });
}

/** module entry of a planned step: enum switch value in set + settings (parameter modules: settings only) */
function entryOfStep(s: ModuleTarget & { rule?: string }, basis: Basis): StartEntry {
  const sw = moduleOf(s.module).switch;
  const set: Record<string, string> = { ...s.settings };
  if (sw && !isParamSwitch(sw)) set[sw.var] = s.value;
  if (s.tier !== 'aws') return { id: s.module, kind: 'local', ...(basis === 'precursor' || basis === 'context' ? { basis } : {}), set, ...(s.rule ? { because: [s.rule] } : {}) };
  return { id: s.module, kind: 'module', basis, set, ...(s.rule ? { because: [s.rule] } : {}) };
}

function envOf(entries: StartEntry[]): EnvMap {
  let env: EnvMap = {};
  for (const e of entries) {
    if (e.kind === 'runtime' || e.id === 'ec2') continue;
    if (!isModuleId(e.id)) continue;
    const sw = moduleOf(e.id as ModuleId).switch;
    if (e.kind === 'module' && sw && isParamSwitch(sw)) {
      env = applyTarget(env, resolveTarget(e.id as ModuleId, { settings: e.set ?? {} }));
    } else {
      env = { ...env, ...(e.set ?? {}) };
    }
  }
  return env;
}

function addEntry(list: StartEntry[], e: StartEntry): void {
  const same = list.find((x) => x.id === e.id && x.kind === e.kind);
  if (!same) { list.push(e); return; }
  same.set = { ...(same.set ?? {}), ...(e.set ?? {}) };
  if (e.params) same.params = { ...(same.params ?? {}), ...e.params };
  if (e.because) same.because = [...new Set([...(same.because ?? []), ...e.because])];
}

export function planStartOf(lab: LabDoc, opts: PlanStartOptions): PlanResult {
  const variant = opts.variant ?? 'default';
  if (!VARIANT_RE.test(variant)) throw new CliError(`invalid variant ${variant}`, EXIT.rules, 'VARIANT_INVALID');
  const vdoc = variant === 'default' ? undefined : (lab.startProfile.variants ?? []).find((v) => v.id === variant);
  if (variant !== 'default' && !vdoc) throw new CliError(`${lab.id} has no start variant ${variant}`, EXIT.rules, 'VARIANT_UNKNOWN');
  const provisions = vdoc?.provisions ?? lab.startProfile.provisions ?? [];
  const branches = Object.fromEntries(Object.entries(vdoc?.branches ?? lab.startProfile.branches ?? {}).map(([r, b]) => [r, b.choose]));
  const targets = (vdoc?.targetModules ?? lab.targetModules).filter((t) => !t.optional);
  const warnings: string[] = [];

  // 3. base: l0-ec2 + iam(role) unless svc-ec2 / svc-iam (C3)
  const start: StartEntry[] = [{ id: 'ec2', kind: 'module', basis: 'base' }];
  if (!NO_IAM_CARDS.has(lab.id)) start.push({ id: 'iam', kind: 'module', basis: 'credential', set: { IAM_CREDENTIALS: 'role' } });

  // 5. precursors (fromDriver): local tier -> kind local; an AWS value -> kind module (its closure follows)
  for (const t of targets) {
    if (!t.fromDriver || t.id === 'ec2' || !isModuleId(t.id)) continue;
    const id = t.id as ModuleId;
    const sw = moduleOf(id).switch;
    if (!sw || isParamSwitch(sw)) continue;
    if (t.fromDriver === sw.values[0]) continue;                      // the L0 default: nothing to provision
    const pre = resolveTarget(id, { driver: t.fromDriver });
    addEntry(start, entryOfStep(pre, 'precursor'));
  }

  // 6. local settings: single-service cards from the registry table, scenario cards from provisions (kind local / runtime)
  if (lab.kind === 'service') {
    for (const t of targets) {
      const extra = SINGLE_LOCAL_SETTINGS[t.id as ModuleId];
      for (const [k, v] of Object.entries(extra ?? {})) {
        const owner = ownerOfKey(k) ?? (t.id as ModuleId);
        addEntry(start, { id: owner, kind: 'local', set: { [k]: v } });
      }
    }
  }
  for (const p of provisions) {
    if (p.kind === 'local' && lab.kind === 'scenario') addEntry(start, { id: p.item, kind: 'local', set: str(p.set) });
    if (p.kind === 'runtime') addEntry(start, { id: p.item, kind: 'runtime', value: p.value ?? true });
    if (p.kind === 'module' && p.basis === 'context') {
      if (lab.kind !== 'scenario') warnings.push(`${p.item}: context modules are only allowed on scenario cards`);
      else addEntry(start, { id: p.item, kind: 'module', basis: 'context', set: str(p.set), ...(p.params ? { params: str(p.params) } : {}) });
    }
  }

  // 4 + 7. closure of every target (and of context / precursor modules) on top of the start state
  const targetIds = new Set<string>(targets.map((t) => t.id));
  const closureOf = (t: ModuleTarget, basis: Basis) => {
    for (let round = 0; round < 5; round += 1) {
      const plan = planEnable(envOf(start), t, { withDeps: true });
      // branches: when the plan picked another alternative for a rule the card chose explicitly, provision the choice first
      const wrong = plan.steps.find((s) => !s.isTarget && s.rule && branches[s.rule] && branches[s.rule] !== s.module);
      if (wrong) {
        const chosen = resolveTarget(branches[wrong.rule!] as ModuleId);
        addEntry(start, { ...entryOfStep(chosen, 'closure'), because: [wrong.rule!] });
        continue;
      }
      for (const s of plan.steps) {
        // another target of the card is enabled by the learner, not provisioned (scenario cards: storage then cdn)
        if (s.isTarget || targetIds.has(s.module)) continue;
        addEntry(start, entryOfStep(s, s.rule === 'CRED-001' ? 'credential' : basis));
      }
      for (const i of plan.issues) warnings.push(`${t.module}: ${i.rule} ${i.message}`);
      return;
    }
    throw new CliError(`${lab.id}: branch selection does not converge`, EXIT.rules, 'PLAN_BRANCHES');
  };
  for (const e of [...start]) {
    if (e.id === 'ec2' || e.kind !== 'module' || e.basis === 'credential' || !isModuleId(e.id)) continue;
    const sw = moduleOf(e.id as ModuleId).switch;
    const t = sw && isParamSwitch(sw) ? resolveTarget(e.id as ModuleId, { settings: e.set ?? {} })
      : resolveTarget(e.id as ModuleId, { driver: e.set?.[sw?.var ?? ''] ?? (sw && !isParamSwitch(sw) ? sw.ownedValues[0] : undefined), settings: e.set ?? {} });
    closureOf(t, e.basis === 'context' ? 'context' : 'closure');
  }
  for (const t of targets) {
    if (t.id === 'ec2' || !isModuleId(t.id)) continue;
    closureOf(targetOf(t), 'closure');
  }
  // a closure step must not provision a target module at its target value
  for (const t of targets) {
    if (!isModuleId(t.id) || t.id === 'ec2') continue;
    const tt = targetOf(t);
    const inStart = start.find((e) => e.id === t.id && e.kind !== 'runtime');
    if (!inStart) continue;
    const sv = switchVar(t.id as ModuleId);
    const startValue = inStart.kind === 'module' && (!sv || isParamSwitch(moduleOf(t.id as ModuleId).switch!)) ? 'aws' : inStart.set?.[sv ?? ''];
    const sameValue = (startValue ?? '') === tt.value;
    const differs = Object.entries(str(t.set)).some(([k, v]) => inStart.set?.[k] !== v) || Object.keys(t.params ?? {}).length > 0;
    if (sameValue && !differs) {
      throw new CliError(`DRV-5: target ${t.id}=${t.driver} is already in effect in the start state of ${lab.id}`, EXIT.rules, 'DRV-5');
    }
    if (!t.fromDriver) warnings.push(`DRV-5: target ${t.id} appears in the start state (${startValue}); targetModules[].fromDriver must say so`);
  }

  // 9. platform section and base parameters
  const baseParams: Record<string, string> = {};
  if (lab.workstation?.sshFromWorkstation) {
    baseParams.SshIngressCidr = start.some((e) => e.id === 'network' && e.kind === 'module') ? '${atl:workstationPublicCidr}' : '${atl:workstationPrivateCidr}';
  }
  const computed = previewDirectHttps(start, targets, baseParams);
  const declared = vdoc?.platform?.preview?.directHttps ?? lab.startProfile.platform?.preview?.directHttps;
  if (declared && declared !== computed) warnings.push(`preview.directHttps: the card declares ${declared}, the rules give ${computed} (06 PM-21)`);
  const platform = { 'preview.directHttps': computed };

  // 8. rule engine on the start state (startup + deploy scope): errors stop, warnings are reported
  if (opts.check) {
    const r = opts.check(start);
    if (!r.ran) warnings.push(`rules: not evaluated (${r.reason ?? 'backend not built'})`);
    else if (!r.ok) throw new CliError(`${lab.id}: the start state violates ${r.errors.map((e) => `${e.rule} (${e.message})`).join('; ')}`, EXIT.rules, 'PLAN_RULES');
    else for (const w of r.warnings) warnings.push(`rules: ${w.rule}`);
  }

  // 10. order (topological + orderBefore)
  const moduleEntries = start.filter((e) => e.id !== 'ec2' && isModuleId(e.id) && e.kind !== 'runtime');
  const order = orderSteps(moduleEntries.map((e) => ({ module: e.id as ModuleId })), []).map((s) => s.module as string);

  // 12. card stacks deployed at start
  const extraStacks = (lab.extraStacks ?? []).filter((x) => x.deploy === 'start' && String(x.when ?? 'true') !== 'false').map((x) => ({ id: x.id, region: x.region }));
  const seeds = [...new Set(provisions.filter((p) => p.kind === 'seed').map((p) => p.item))];
  for (const sd of seeds) if (!isSeedId(sd)) throw new CliError(`${lab.id}: unknown seed ${sd} (06 §11)`, EXIT.rules, 'SEED_UNKNOWN');
  const orderedSeeds = SEED_IDS.filter((s) => seeds.includes(s));

  const spec = specOf(lab.id, variant, start, platform, baseParams, extraStacks, orderedSeeds);
  return {
    schema: PLAN_SCHEMA, registryVersion: toolkitRegistryVersion(), toolkitVersion: toolkitVersion(),
    card: lab.id, variant, profileName: `atl/${lab.id}/${variant}`,
    start: start.map((e) => ({ ...e, ...(e.set ? { set: sortObj(e.set) } : {}) })),
    targets: targets.map((t) => ({ id: t.id, driver: t.driver, ...(t.fromDriver ? { fromDriver: t.fromDriver } : {}),
      ...(t.set ? { set: str(t.set) } : {}), ...(t.params ? { params: str(t.params) } : {}) })),
    branches, platform, baseParams, warnings, order, provision: { class: lab.provision?.class ?? null }, extraStacks, seeds: orderedSeeds,
    digest: specDigest(spec),
  };
}

export function specOf(card: string, variant: string, start: StartEntry[], platform: Record<string, string>, baseParams: Record<string, string>,
  extraStacks: Array<{ id: string; region: string }>, seeds: string[]): ProfileSpec {
  return {
    card, variant,
    modules: start.filter((e) => e.id !== 'ec2').map((e) => ({ id: e.id, kind: e.kind, set: e.set ?? {}, params: e.params ?? {},
      value: e.kind === 'runtime' ? (e.value ?? true) : null })),
    platform, baseParams, extraStacks, seeds,
  };
}

// ------------------------------------------------------------------------------------------------ profile file

const list = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join(',');

/** profiles/atl/<card-id>/<variant>.env (06 PM-33): generated, not committed, shipped with the content release */
export function renderAtlProfile(plan: PlanResult): string {
  const spec = specOf(plan.card, plan.variant, plan.start, plan.platform, plan.baseParams, plan.extraStacks, plan.seeds);
  const modules = spec.modules.filter((m) => m.kind === 'module');
  const drivers: Record<string, string> = {};
  const params: Record<string, string> = {};
  for (const m of modules) {
    Object.assign(drivers, m.set);
    for (const [k, v] of Object.entries(m.params)) params[`${m.id}.${k}`] = v;
  }
  const local: Record<string, string> = {};
  for (const m of spec.modules.filter((x) => x.kind === 'local')) Object.assign(local, m.set);
  const runtime = spec.modules.filter((x) => x.kind === 'runtime').map((x) => `${x.id}=${String(x.value)}`).join(',');
  const lines = [
    `# profiles/atl/${plan.card}/${plan.variant}.env — generated by \`scripts/module profile gen-atl\` (06 PM-33); do not edit by hand.`,
    ...plan.start.filter((e) => e.id !== 'ec2').map((e) => `#   ${e.id} (${e.kind}${e.basis ? `, ${e.basis}` : ''})${e.because?.length ? ` because ${e.because.join(', ')}` : ''}`),
    `PROFILE_NAME=${plan.profileName}`,
    'PROFILE_KIND=atl-start',
    `PROFILE_CARD=${plan.card}`,
    `PROFILE_VARIANT=${plan.variant}`,
    'PROFILE_EXTENDS=l0-ec2',
    `PROFILE_MODULES=${modules.map((m) => m.id).join(',')}`,
    `PROFILE_DRIVERS=${list(drivers)}`,
    `PROFILE_LOCAL_SETTINGS=${list(local)}`,
    `PROFILE_RUNTIME=${runtime}`,
    `PROFILE_PARAMS=${list(params)}`,
    `PROFILE_BASE_PARAMS=${list(plan.baseParams)}`,
    `PROFILE_SEEDS=${plan.seeds.join(',')}`,
    `PROFILE_EXTRA_STACKS=${plan.extraStacks.map((x) => `${x.id}@${x.region}`).join(',')}`,
    `PROFILE_PLATFORM=${list(plan.platform)}`,
    `PROFILE_PLAN_DIGEST=${plan.digest}`,
    `PROFILE_REGISTRY_VERSION=${plan.registryVersion}`,
    'PROFILE_LAB_BYPASS=on',
  ];
  return `${lines.join('\n')}\n`;
}

function assignments(raw: string | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of splitList(raw)) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new CliError(`${what}: "${item}" is not KEY=value`, EXIT.rules, 'PROFILE_INVALID');
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

const EXTRA_STACK_RE = /^([a-z][a-z0-9-]{1,23})@(app|us-east-1|dr-region)$/;

export function parseExtraStacks(raw: string | undefined): Array<{ id: string; region: string }> {
  return splitList(raw).map((x) => {
    const m = EXTRA_STACK_RE.exec(x);
    if (!m) throw new CliError(`PROFILE_EXTRA_STACKS: "${x}" must be <stackId>@<app|us-east-1|dr-region>`, EXIT.rules, 'PROFILE_INVALID');
    return { id: m[1]!, region: m[2]! };
  });
}

function runtimeValue(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return Number(v);
  return v;
}

/** profile file -> the same normalized object (06 PM-32 `plan --profile`) */
export function parseAtlProfile(text: string): ProfileSpec & { name: string; kind: string; recordedDigest: string | null; recordedRegistryVersion: string | null; placeholders: string[] } {
  const e = parseEnvFile(text);
  const card = e.PROFILE_CARD ?? '';
  const variant = e.PROFILE_VARIANT || 'default';
  if (!CARD_RE.test(card)) throw new CliError('profile: PROFILE_CARD is missing or invalid (not an atl start profile)', EXIT.rules, 'PROFILE_INVALID');
  const drivers = assignments(e.PROFILE_DRIVERS, 'PROFILE_DRIVERS');
  const params = assignments(e.PROFILE_PARAMS, 'PROFILE_PARAMS');
  const modules: ProfileSpec['modules'] = [];
  for (const id of splitList(e.PROFILE_MODULES)) {
    if (!isModuleId(id)) throw new CliError(`PROFILE_MODULES: unknown module ${id}`, EXIT.rules, 'PROFILE_INVALID');
    // a key belongs to the module that owns it (ownsEnv) or, for a switch variable shared by several modules (STORAGE_DRIVER:
    // storage owns s3, shared-fs owns efs), to the module whose switch owns the value — renderAtlProfile wrote it from m.set
    const sw = moduleOf(id).switch;
    const ownsSwitchValue = (k: string, v: string) => !!sw && !isParamSwitch(sw) && sw.var === k && sw.ownedValues.includes(v);
    const set = Object.fromEntries(Object.entries(drivers).filter(([k, v]) => ownerOfKey(k) === id || ownsSwitchValue(k, v)));
    const p = Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith(`${id}.`)).map(([k, v]) => [k.slice(id.length + 1), v]));
    modules.push({ id, kind: 'module', set, params: p, value: null });
  }
  const local = assignments(e.PROFILE_LOCAL_SETTINGS, 'PROFILE_LOCAL_SETTINGS');
  const byOwner = new Map<string, Record<string, string>>();
  for (const [k, v] of Object.entries(local)) {
    const owner = ownerOfKey(k);
    if (!owner) throw new CliError(`PROFILE_LOCAL_SETTINGS: ${k} is not owned by any module`, EXIT.rules, 'PROFILE_INVALID');
    byOwner.set(owner, { ...(byOwner.get(owner) ?? {}), [k]: v });
  }
  for (const [id, set] of byOwner) modules.push({ id, kind: 'local', set, params: {}, value: null });
  for (const [k, v] of Object.entries(assignments(e.PROFILE_RUNTIME, 'PROFILE_RUNTIME'))) modules.push({ id: k, kind: 'runtime', set: {}, params: {}, value: runtimeValue(v) });
  const placeholders = Object.entries(e).filter(([, v]) => PLACEHOLDER_RE.test(v)).map(([k]) => k);
  return {
    name: e.PROFILE_NAME ?? `atl/${card}/${variant}`, kind: e.PROFILE_KIND ?? '', card, variant, modules,
    platform: assignments(e.PROFILE_PLATFORM, 'PROFILE_PLATFORM'), baseParams: assignments(e.PROFILE_BASE_PARAMS, 'PROFILE_BASE_PARAMS'),
    extraStacks: parseExtraStacks(e.PROFILE_EXTRA_STACKS), seeds: splitList(e.PROFILE_SEEDS),
    recordedDigest: e.PROFILE_PLAN_DIGEST || null, recordedRegistryVersion: e.PROFILE_REGISTRY_VERSION || null, placeholders,
  };
}

/** `atl/<card>` is accepted as an alias of `atl/<card>/default` (manual debugging only) */
export function normalizeProfileName(name: string): string {
  const m = /^atl\/((?:svc|sc)-[a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(name);
  return m ? `atl/${m[1]}/default` : name;
}

export function isAtlProfileName(name: string): boolean {
  return /^atl\/(svc|sc)-[a-z0-9-]+\/[a-z][a-z0-9-]{0,31}$/.test(normalizeProfileName(name));
}

export function containsPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value);
}

/** every module of the registry that `plan --targets` / `--then` may name */
export function knownModule(id: string): id is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(id) && Boolean(REGISTRY[id as ModuleId]);
}
