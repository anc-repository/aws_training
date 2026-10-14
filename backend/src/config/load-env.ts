// backend/src/config/load-env.ts —— 启动配置的分层加载（总纲 §4.4）
//
// 顺序（后者覆盖前者）：
//   1. <envDir>/cloudalbum.env          基础配置（User Data 写入）
//   1b. <envDir>/platform.env           ATL 平台模式（06 PM-01）：只由 `cloudalbum platform:apply-env` 写入，只允许 ATL_ 前缀的键
//                                       （其他键 → ATL-CFG-001，不参与合并）；ATL_ 键出现在其他层 → CFG-002（同样不参与合并）
//   2. <envDir>/modules.d/*.env         按文件名排序；每个文件只能出现该模块 ownsEnv 中的键 + MODULE_<ID>(_VERSION) + 开关（CFG-002）；
//                                       不得出现机密类键（CFG-002）；两个模块文件定义同一个键（CFG-003）
//   3. <envDir>/secrets.env             只允许 SecretName 映射出的变量、SECRETS_ORIGIN、IAM_KEYS_*
//   4. <envDir>/local.override.env      可选，临时实验（存在即 CFG-005 警告）
//   5. 进程环境中的白名单键               NODE_ENV、CLOUDALBUM_ROLE、CLOUDALBUM_ENV_DIR、PORT、HOST、NODE_OPTIONS
// 不依赖 systemd 的 EnvironmentFile，也不把机密导出为进程环境变量（结果只存在于返回值中）。
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isModuleId, moduleFlagKey, type ModuleId } from '@cloudalbum/contracts';
import { SECRET_NAMES, secretEnvName } from '../ports/secrets.js';
import { REGISTRY, isKeyAllowedForModule, ownerOfKey, type Registry } from '../modules/registry.js';

export type LayerKind = 'base' | 'platform' | 'module' | 'secrets' | 'override' | 'process';

export interface EnvLayer {
  kind: LayerKind;
  /** 文件路径（process 层为 'process.env'） */
  file: string;
  module?: ModuleId;
  values: Record<string, string>;
}

export interface LayerIssue {
  code: 'CFG-002' | 'CFG-003' | 'ATL-CFG-001';
  file: string;
  key: string;
  module?: string;
  otherModule?: string;
  message: string;
}

export interface CostRatesFile {
  path: string;
  entries: Array<Record<string, unknown>>;
  parseError?: string;
}

export interface EnvLayers {
  envDir: string;
  exists: boolean;
  /** envDir 是否为符号链接（CFG-008：/etc/cloudalbum 应指向数据卷 etc/） */
  isSymlink: boolean;
  realPath?: string;
  layers: EnvLayer[];
  /** 合并结果（含机密；不要整体打印） */
  merged: Record<string, string>;
  /** 键 → 来源文件 */
  sources: Record<string, string>;
  issues: LayerIssue[];
  localOverride: boolean;
  /** /etc/cloudalbum/cost-rates.yaml（CFG-010） */
  costRates: CostRatesFile | null;
  /** 第 1b 层 platform.env：是否存在与文件中的全部键（含被丢弃的非 ATL_ 键，供 ATL-CFG-001 报告） */
  platformEnv?: { file: string; keys: string[] };
}

/** ATL 平台模式的键前缀：只能出现在 platform.env（06 PM-01） */
export const ATL_PREFIX = 'ATL_';

/** 进程环境中允许进入配置的键（第 5 层）。 */
export const PROCESS_ENV_WHITELIST = ['NODE_ENV', 'CLOUDALBUM_ROLE', 'CLOUDALBUM_ENV_DIR', 'PORT', 'HOST', 'NODE_OPTIONS'] as const;

const SECRET_ENV_KEYS: ReadonlySet<string> = new Set(SECRET_NAMES.flatMap((n) => {
  const k = secretEnvName(n);
  return k.endsWith('_FILE') ? [k, k.slice(0, -'_FILE'.length)] : [k, `${k}_FILE`];
}));

/** secrets.env 允许出现的键 */
export function isAllowedInSecretsFile(key: string): boolean {
  return SECRET_ENV_KEYS.has(key) || key === 'SECRETS_ORIGIN' || key.startsWith('IAM_KEYS_');
}

/**
 * 机密类键（4.4 第 2 层的定义，D5）：SecretName 映射出的变量名及其 _FILE 形式、IAM_KEYS_*，
 * 以及以 _SECRET、_PASSWORD、_TOKEN、_PRIVATE_KEY 结尾的键；*_SECRET_ARN、*_SECRET_NAME 允许。
 */
export function isSecretLikeKey(key: string): boolean {
  if (key.endsWith('_SECRET_ARN') || key.endsWith('_SECRET_NAME')) return false;
  if (SECRET_ENV_KEYS.has(key) || key.startsWith('IAM_KEYS_')) return true;
  return /(_SECRET|_PASSWORD|_TOKEN|_PRIVATE_KEY)$/.test(key);
}

/**
 * 解析 dotenv 风格的文件：`KEY=value`，支持 `#` 注释、`export ` 前缀、单 / 双引号（双引号内支持 \n \" \\ 转义）、
 * 未加引号时行尾 ` #` 注释。不做变量展开。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      const end = findClosingQuote(value);
      value = value.slice(1, end).replace(/\\(n|r|t|"|\\)/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[c] ?? c);
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = value.slice(1, end === -1 ? undefined : end);
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function findClosingQuote(v: string): number {
  for (let i = 1; i < v.length; i += 1) {
    if (v[i] === '\\') { i += 1; continue; }
    if (v[i] === '"') return i;
  }
  return v.length;
}

function readEnvFile(file: string): Record<string, string> | null {
  if (!existsSync(file)) return null;
  return parseEnvFile(readFileSync(file, 'utf8'));
}

export interface LoadEnvOptions {
  /** 进程环境（默认 process.env）；只取白名单键 */
  processEnv?: NodeJS.ProcessEnv;
  registry?: Registry;
}

function isRegistry(x: Registry | LoadEnvOptions | undefined): x is Registry {
  return typeof x === 'object' && x !== null && 'ec2' in x;
}

/** 总纲 4.5 的调用形式 `loadEnvLayers(dir, REGISTRY)` 与 `loadEnvLayers(dir, { processEnv })` 都支持。 */
export async function loadEnvLayers(envDir: string, registryOrOpts?: Registry | LoadEnvOptions): Promise<EnvLayers> {
  return loadEnvLayersSync(envDir, registryOrOpts);
}

export function loadEnvLayersSync(envDir: string, registryOrOpts?: Registry | LoadEnvOptions): EnvLayers {
  const opts: LoadEnvOptions = isRegistry(registryOrOpts) ? { registry: registryOrOpts } : (registryOrOpts ?? {});
  const registry = opts.registry ?? REGISTRY;
  const processEnv = opts.processEnv ?? process.env;
  const dir = path.resolve(envDir);
  const exists = existsSync(dir);
  let isSymlink = false;
  let realPath: string | undefined;
  if (exists) {
    try {
      isSymlink = lstatSync(dir).isSymbolicLink();
      realPath = realpathSync(dir);
    } catch {
      /* ignore */
    }
  }

  const layers: EnvLayer[] = [];
  const issues: LayerIssue[] = [];

  // 1. 基础配置
  const baseFile = path.join(dir, 'cloudalbum.env');
  const base = readEnvFile(baseFile);
  if (base) {
    for (const key of Object.keys(base).filter((k) => k.startsWith(ATL_PREFIX))) {
      issues.push({ code: 'CFG-002', file: baseFile, key, message: `cloudalbum.env 出现 ${key}：ATL_ 前缀的键只能写在 platform.env（cloudalbum platform:apply-env）` });
    }
    layers.push({ kind: 'base', file: baseFile, values: base });
  }

  // 1b. platform.env（06 PM-01）
  const platformFile = path.join(dir, 'platform.env');
  const platformRaw = readEnvFile(platformFile);
  let platformEnv: EnvLayers['platformEnv'];
  if (platformRaw) {
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(platformRaw)) {
      if (k.startsWith(ATL_PREFIX)) values[k] = v;
      else issues.push({ code: 'ATL-CFG-001', file: platformFile, key: k, message: `platform.env 只允许 ATL_ 前缀的键，出现了 ${k}` });
    }
    platformEnv = { file: platformFile, keys: Object.keys(platformRaw) };
    layers.push({ kind: 'platform', file: platformFile, values });
  }

  // 2. modules.d/*.env（按文件名排序）
  const modDir = path.join(dir, 'modules.d');
  if (existsSync(modDir)) {
    const keyOwnerFile = new Map<string, { file: string; module: string }>();
    const files = readdirSync(modDir).filter((f) => f.endsWith('.env')).sort();
    for (const f of files) {
      const file = path.join(modDir, f);
      const values = readEnvFile(file) ?? {};
      const id = f.slice(0, -'.env'.length);
      if (!isModuleId(id)) {
        for (const key of Object.keys(values)) {
          issues.push({ code: 'CFG-002', file, key, module: id, message: `modules.d/${f}：未知模块 ${id}（文件名必须是模块 id）` });
        }
        continue;
      }
      for (const key of Object.keys(values)) {
        if (isSecretLikeKey(key)) {
          issues.push({ code: 'CFG-002', file, key, module: id,
            message: `modules.d/${f} 出现机密类键 ${key}：机密值只能在 secrets.env 与 keys/*.pem，modules.d 只写 *_SECRET_ARN 或逻辑名` });
        } else if (!isKeyAllowedForModule(key, id, registry)) {
          const owner = ownerOfKey(key, registry);
          issues.push({ code: 'CFG-002', file, key, module: id,
            message: `modules.d/${f} 出现不属于 ${id} 的键 ${key}${owner ? `（按 ownsEnv 归 ${owner}）` : '（不在任何模块的 ownsEnv 中）'}` });
        }
        const prev = keyOwnerFile.get(key);
        if (prev) {
          issues.push({ code: 'CFG-003', file, key, module: id, otherModule: prev.module,
            message: `键 ${key} 同时出现在 modules.d/${path.basename(prev.file)} 与 modules.d/${f}` });
        } else {
          keyOwnerFile.set(key, { file, module: id });
        }
      }
      layers.push({ kind: 'module', file, module: id, values });
    }
  }

  // 3. secrets.env
  const secretsFile = path.join(dir, 'secrets.env');
  const secrets = readEnvFile(secretsFile);
  if (secrets) {
    for (const key of Object.keys(secrets)) {
      if (!isAllowedInSecretsFile(key)) {
        issues.push({ code: 'CFG-002', file: secretsFile, key,
          message: `secrets.env 只允许 SecretName 映射出的变量、SECRETS_ORIGIN 与 IAM_KEYS_*，出现了 ${key}` });
      }
    }
    layers.push({ kind: 'secrets', file: secretsFile, values: secrets });
  }

  // 4. local.override.env（CFG-005）
  const overrideFile = path.join(dir, 'local.override.env');
  const override = readEnvFile(overrideFile);
  if (override) {
    for (const key of Object.keys(override).filter((k) => k.startsWith(ATL_PREFIX))) {
      issues.push({ code: 'CFG-002', file: overrideFile, key, message: `local.override.env 出现 ${key}：ATL_ 前缀的键只能写在 platform.env` });
    }
    layers.push({ kind: 'override', file: overrideFile, values: override });
  }

  // 5. 进程环境白名单
  const proc: Record<string, string> = {};
  for (const k of PROCESS_ENV_WHITELIST) {
    const v = processEnv[k];
    if (v !== undefined && v !== '') proc[k] = v;
  }
  proc.CLOUDALBUM_ENV_DIR = dir;
  layers.push({ kind: 'process', file: 'process.env', values: proc });

  const merged: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer.values)) {
      if (k.startsWith(ATL_PREFIX) && layer.kind !== 'platform') continue;   // 只认 platform.env 中的 ATL_ 键
      merged[k] = v;
      sources[k] = layer.file;
    }
  }

  // CFG-010 的输入：cost-rates.yaml（可选；COST_RATES_FILE 覆盖默认位置，与 adapters/cost/estimate.ts 一致）。
  // 格式与 estimate.ts 相同：文档格式 {currency, region, entries: [...]}，也兼容 rates: [...] 与顶层数组（wave1-integration）
  let costRates: CostRatesFile | null = null;
  const costFile = merged.COST_RATES_FILE?.trim() || path.join(dir, 'cost-rates.yaml');
  if (existsSync(costFile)) {
    try {
      const doc = parseYaml(readFileSync(costFile, 'utf8')) as unknown;
      const obj = (doc ?? {}) as { entries?: unknown; rates?: unknown };
      const list = Array.isArray(doc) ? doc : Array.isArray(obj.entries) ? obj.entries : obj.rates;
      costRates = { path: costFile, entries: Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [] };
    } catch (e) {
      costRates = { path: costFile, entries: [], parseError: (e as Error).message };
    }
  }

  return {
    envDir: dir, exists, isSymlink, ...(realPath ? { realPath } : {}),
    layers, merged, sources, issues, localOverride: Boolean(override), costRates, ...(platformEnv ? { platformEnv } : {}),
  };
}

/** 由内存中的 env 构造 EnvLayers（测试、`check-config --env` 与 scripts/module 的计划校验使用）。 */
export function layersFromEnv(env: Record<string, string>, opts: { envDir?: string; localOverride?: boolean } = {}): EnvLayers {
  const envDir = opts.envDir ?? '(memory)';
  return {
    envDir, exists: false, isSymlink: false,
    layers: [{ kind: 'base', file: '(memory)', values: { ...env } }],
    merged: { ...env },
    sources: Object.fromEntries(Object.keys(env).map((k) => [k, '(memory)'])),
    issues: [],
    localOverride: Boolean(opts.localOverride),
    costRates: null,
  };
}

/** 模块 env 文件中写了 MODULE_<ID> 的模块（scripts/module 的“声明启用”）。 */
export function declaredModules(layers: EnvLayers): ModuleId[] {
  const out: ModuleId[] = [];
  for (const l of layers.layers) {
    if (l.kind === 'module' && l.module && (l.values[moduleFlagKey(l.module)] ?? '').toLowerCase() === 'on') out.push(l.module);
  }
  return out;
}
