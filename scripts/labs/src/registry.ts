/**
 * Read-only views of the CloudAlbum sources that card content must agree with:
 *   - modules/registry.yaml (module ids, switches, requires, credentials, billing) — 04 §3.5 A1, DRV-*;
 *   - backend/src/rules/rules.ts (rule id → level) — 04 §3.2.5 expectedWarnings, A10;
 *   - experiments/<module>/experiment.json (experiment ids and labels) — A11;
 *   - platform/checks/src/args-schemas.mjs (checkId catalogue and args schemas, 04 §6.4) — A7/A8 for `local` checks.
 * Everything is loaded lazily and cached per process.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { LabsPaths } from './paths.js';
import { loadYamlFile } from './yaml.js';
import { canonicalJson } from '@atl/shared';

// ---------------------------------------------------------------------------------------------------------------
// registry

export interface RegistrySwitch {
  var: string;
  kind?: 'param';
  values?: string[];
  ownedValues?: string[];
  localTiers?: string[];
}

export interface RegistryRequire {
  rule: string;
  when?: Record<string, string>;
  need?: string[];
  severity?: 'warn';
}

export interface RegistryModule {
  group?: string;
  function?: string;
  awsService?: string;
  type?: string;
  switch?: RegistrySwitch;
  credentials?: 'none' | 'optional' | 'required';
  requires?: RegistryRequire[];
  orderBefore?: string[];
  billing?: { resource: string; dimension?: string; hourly?: boolean }[];
  lab?: { hourlyBilled?: boolean; experiments?: string[] };
  singleLocalSettings?: Record<string, string>;
  singleRuntime?: Record<string, string | boolean | number>;
}

export interface RegistryDoc {
  version: number | string;
  modules: Record<string, RegistryModule>;
}

/** Parameter switches: [local driver, AWS driver] (same table as scripts/module-cli PARAM_DRIVERS / backend PARAM_DRIVERS). */
export const PARAM_DRIVERS: Readonly<Record<string, readonly [string, string]>> = {
  cdn: ['direct', 'cloudfront'],
  'identity-pool': ['none', 'cognito'],
  kms: ['local', 'kms'],
  'social-api': ['express', 'apigw'],
};

const cache = new Map<string, unknown>();

function memo<T>(key: string, f: () => T): T {
  if (!cache.has(key)) cache.set(key, f());
  return cache.get(key) as T;
}

export function loadRegistry(p: LabsPaths): RegistryDoc {
  return memo(`registry:${p.registry}`, () => {
    const doc = loadYamlFile(p.registry) as RegistryDoc;
    if (!doc?.modules) throw new Error(`${p.registry}: no modules`);
    return doc;
  });
}

export function moduleIds(p: LabsPaths): string[] {
  return Object.keys(loadRegistry(p).modules);
}

/** Local (start-of-L0) driver of a module: values[0] for enum switches, the PARAM_DRIVERS local name otherwise. */
/**
 * The driver a target module has when the card starts: its `fromDriver`, otherwise the module's local implementation
 * (registry `localDriver`); null when the module is not there at the start. The catalog index and the card intro both use
 * it, so the “at start” diagram and the “with vs without” pair show the same thing everywhere.
 */
export function startDriverOf(p: LabsPaths, t: { id: string; fromDriver?: string | null }): string | null {
  return t.fromDriver ?? (localDriver(p, t.id) || null);
}

export function localDriver(p: LabsPaths, id: string): string {
  if (id === 'ec2') return 'single';
  const m = loadRegistry(p).modules[id];
  const sw = m?.switch;
  if (!sw) return '';
  if (sw.kind === 'param') return PARAM_DRIVERS[id]?.[0] ?? 'local';
  return sw.values?.[0] ?? '';
}

/** Drivers that count as “not the AWS implementation” of a module (local value and local tiers). */
export function localDrivers(p: LabsPaths, id: string): string[] {
  const m = loadRegistry(p).modules[id];
  const sw = m?.switch;
  if (!sw) return [];
  if (sw.kind === 'param') return [PARAM_DRIVERS[id]?.[0] ?? 'local'];
  return [sw.values?.[0] ?? '', ...(sw.localTiers ?? [])].filter(Boolean);
}

export function isInfraModule(p: LabsPaths, id: string): boolean {
  return loadRegistry(p).modules[id]?.type === 'infra';
}

/** Owner of an env key (ownsEnv longest prefix, same rule as scripts/module-cli ownerOfKey). */
export function ownerOfKey(p: LabsPaths, key: string, opts: { switchVar?: boolean } = {}): string | undefined {
  const reg = loadRegistry(p).modules;
  let best: { id: string; len: number } | undefined;
  for (const [id, m] of Object.entries(reg)) {
    const owns = (m as { ownsEnv?: string[] }).ownsEnv ?? [];
    if (opts.switchVar !== false && m.switch?.var === key) return id;
    for (const entry of owns) {
      const match = entry.endsWith('_') ? key.startsWith(entry) : key === entry;
      if (!match) continue;
      const len = entry.endsWith('_') ? entry.length : entry.length + 1000;
      if (!best || len > best.len) best = { id, len };
    }
  }
  return best?.id;
}

// ---------------------------------------------------------------------------------------------------------------
// rules table (backend/src/rules/rules.ts)

export type RuleLevel = 'error' | 'warn';

/** rule id → level, parsed from the rule objects `id: 'DEP-013', category: 'DEP', severity: 'warn'`. */
export function loadRules(p: LabsPaths): Map<string, RuleLevel> {
  return memo(`rules:${p.rules}`, () => {
    const out = new Map<string, RuleLevel>();
    let text = '';
    try {
      text = fs.readFileSync(p.rules, 'utf8');
    } catch {
      return out;
    }
    const re = /id:\s*'([A-Z]+(?:-[A-Z]+)?-[0-9]{3})'\s*,\s*category:\s*'[A-Z]+'\s*,\s*severity:\s*'(error|warn)'/g;
    for (let m = re.exec(text); m; m = re.exec(text)) out.set(m[1]!, m[2] as RuleLevel);
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// experiments/<module>/experiment.json

export interface ExperimentManifestEntry {
  id: string;
  kind?: string;
  requires?: Record<string, Record<string, unknown>> | null;
  labels?: Record<string, { title?: string; role?: string }> | null;
  scenario?: { tool?: string };
  pair?: [string, string];
}

export function loadExperimentManifest(p: LabsPaths, module: string): ExperimentManifestEntry[] | null {
  return memo(`exp:${p.experiments}:${module}`, () => {
    const file = path.join(p.experiments, module, 'experiment.json');
    if (!fs.existsSync(file)) return null;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { experiments?: ExperimentManifestEntry[] };
    return doc.experiments ?? [];
  });
}

// ---------------------------------------------------------------------------------------------------------------
// check bundle: checkId catalogue and args schemas (04 §6.4)

/** 04 §6.4 table (used when the bundle source is not available). */
export const CHECK_IDS_04 = [
  'imds-get', 'systemd-unit', 'port-listen', 'disk-usage', 'file-stat', 'env-key', 'dns-resolve', 'tls-handshake', 'http-probe', 'path-seen',
  'capability-snapshot', 'nginx-log-summary', 'net-bytes', 'app-stat', 'leaked-keys', 'aws-cred-source', 'sshd-state', 'module-state',
  'lab-metrics-run', 'probe-token', 'tool-versions', 'base.ready', 'caps.profile', 'ws.ready', 'atl.channel',
] as const;

export interface CheckBundleCatalogue {
  source: 'bundle' | '04';
  ids: Set<string>;
  validate(checkId: string, args: unknown): string[];
}

export async function loadCheckCatalogue(p: LabsPaths): Promise<CheckBundleCatalogue> {
  const key = `bundle:${p.checkBundleSchemas}`;
  if (cache.has(key)) return cache.get(key) as CheckBundleCatalogue;
  let result: CheckBundleCatalogue = { source: '04', ids: new Set<string>(CHECK_IDS_04), validate: () => [] };
  if (fs.existsSync(p.checkBundleSchemas)) {
    try {
      const mod = (await import(pathToFileURL(p.checkBundleSchemas).href)) as {
        ARGS_SCHEMAS: Record<string, Record<string, unknown>>;
        ALIASES?: Record<string, string>;
      };
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      ajv.addKeyword({ keyword: 'maxMinutes', schemaType: 'number' });
      const validators = new Map<string, ValidateFunction>();
      const aliases = mod.ALIASES ?? {};
      const ids = new Set([...Object.keys(mod.ARGS_SCHEMAS), ...Object.keys(aliases)]);
      result = {
        source: 'bundle',
        ids,
        validate(checkId: string, args: unknown): string[] {
          const id = aliases[checkId] ?? checkId;
          const schema = mod.ARGS_SCHEMAS[id];
          if (!schema) return [`unknown checkId ${checkId}`];
          let v = validators.get(id);
          if (!v) {
            v = ajv.compile(schema);
            validators.set(id, v);
          }
          // templates ({{ … }}) are resolved at run time: validate a copy where they are replaced by a sample value
          const sample = replaceTemplates(args ?? {});
          return v(sample) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`);
        },
      };
    } catch (e) {
      result = { ...result, validate: () => [`check bundle schemas not loadable: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  cache.set(key, result);
  return result;
}

function replaceTemplates(v: unknown): unknown {
  if (typeof v === 'string') return /\{\{.*\}\}/.test(v) ? v.replace(/\{\{[^}]*\}\}/g, 'x0a1b2c3d4') : v;
  if (Array.isArray(v)) return v.map(replaceTemplates);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceTemplates(x)]));
  return v;
}

/** Version of the CloudAlbum toolkit (scripts/module-cli) recorded in plans and the catalog (04 §2.5). */
export function toolkitVersion(p: LabsPaths): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(p.moduleCli, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * `<version>+<sha256(RFC 8785 of the registry document)[0..12]>` — the same value as scripts/module
 * `toolkitRegistryVersion()` (06 PM-33), so reference digests equal `plan --start-of` digests.
 */
export function registryVersion(p: LabsPaths): string {
  const doc = loadRegistry(p) as unknown as Record<string, unknown>;
  const h = crypto.createHash('sha256').update(canonicalJson(doc)).digest('hex').slice(0, 12);
  return `${String(doc.version ?? 0)}+${h}`;
}
