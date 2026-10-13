/**
 * experiments/_lib/manifest.ts —— 读取并校验 `<module>/experiment.json`，选择实验、校验标签与参数。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ParamValue } from './scenario.js';
import { validateExperimentManifest } from './schema.js';
import type { ExperimentDef, ExperimentManifest, VariantInfo } from './types.js';
import { experimentsRoot } from './util.js';

export const LABEL_RE = /^[a-z][a-z0-9-]{0,23}$/;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

export function moduleDir(module: string, root: string = experimentsRoot()): string {
  return path.join(root, module);
}

/** 列出有 experiment.json 的模块目录。 */
export function listModules(root: string = experimentsRoot()): string[] {
  return readdirSync(root)
    .filter((d) => !d.startsWith('_') && !d.startsWith('.') && d !== 'node_modules' && d !== 'dist' && d !== 'test')
    .filter((d) => {
      const p = path.join(root, d);
      return statSync(p).isDirectory() && existsSync(path.join(p, 'experiment.json'));
    })
    .sort();
}

export function normalizeManifest(doc: unknown): ExperimentManifest {
  const d = doc as Partial<ExperimentManifest> & Partial<ExperimentDef>;
  if (Array.isArray(d.experiments)) return d as ExperimentManifest;
  const single = d as ExperimentDef;
  return { module: single.module, default: single.id, experiments: [single] };
}

export function loadManifest(module: string, root: string = experimentsRoot()): ExperimentManifest {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(module)) throw new ManifestError(`模块 id 不合法：${module}`);
  const file = path.join(moduleDir(module, root), 'experiment.json');
  if (!existsSync(file)) {
    throw new ManifestError(`没有 ${path.relative(root, file)}。已有实验的模块：${listModules(root).join(', ') || '（无）'}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ManifestError(`${file} 不是合法 JSON：${(e as Error).message}`);
  }
  const check = validateExperimentManifest(doc);
  if (!check.ok) throw new ManifestError(`${file} 不符合 experiment.schema.json：\n  ${check.errors.join('\n  ')}`);
  const manifest = normalizeManifest(doc);
  if (manifest.module !== module) throw new ManifestError(`${file} 的 module=${manifest.module} 与目录名 ${module} 不一致`);
  const seen = new Set<string>();
  for (const e of manifest.experiments) {
    if (e.module !== module) throw new ManifestError(`实验 ${e.id} 的 module=${e.module} 与目录名 ${module} 不一致`);
    if (seen.has(e.id)) throw new ManifestError(`实验 id 重复：${e.id}`);
    seen.add(e.id);
  }
  return manifest;
}

export function selectExperiment(manifest: ExperimentManifest, scenario?: string): ExperimentDef {
  const id = scenario ?? manifest.default ?? manifest.experiments[0]?.id;
  const exp = manifest.experiments.find((e) => e.id === id);
  if (!exp) {
    throw new ManifestError(`模块 ${manifest.module} 没有实验 ${id}。可选：${manifest.experiments.map((e) => e.id).join(', ')}`);
  }
  return exp;
}

/** `--label`：必须匹配 ^[a-z][a-z0-9-]{0,23}$；实验声明了 requires 时必须是其中的键（平台模式“任意变体标签”）。 */
export function validateLabel(exp: ExperimentDef, label: string): void {
  if (!LABEL_RE.test(label)) throw new ManifestError(`--label 不合法：${label}（^[a-z][a-z0-9-]{0,23}$）`);
  const allowed = Object.keys(exp.requires ?? {});
  if (allowed.length && !allowed.includes(label)) {
    throw new ManifestError(`实验 ${exp.module}/${exp.id} 不支持标签 ${label}；可选：${allowed.join(', ')}`);
  }
}

/** 结果中的变体：label + experiment.json labels 中声明的角色（06 PM-37） */
export function variantOf(exp: ExperimentDef, label: string, cardVariant?: string): VariantInfo {
  const role = exp.labels?.[label]?.role;
  return { label, ...(role ? { role } : {}), ...(cardVariant ? { cardVariant } : {}) };
}

/** 旧结果文件的 variant 是字符串；新结果是对象 */
export function variantLabelOf(doc: { label: string; variant?: VariantInfo | string }): string {
  if (!doc.variant) return doc.label;
  return typeof doc.variant === 'string' ? doc.variant : doc.variant.label;
}

/** 合并参数：experiment.params 的默认值 + `--param k=v`（按声明的类型 / 范围校验；未声明的键拒绝）。 */
export function resolveParams(exp: ExperimentDef, given: Record<string, string>): Record<string, ParamValue> {
  const specs = exp.params ?? {};
  const out: Record<string, ParamValue> = {};
  for (const [k, spec] of Object.entries(specs)) if (spec.default !== undefined) out[k] = spec.default;
  for (const [k, raw] of Object.entries(given)) {
    const spec = specs[k];
    if (!spec) throw new ManifestError(`实验 ${exp.id} 不接受参数 ${k}；可用：${Object.keys(specs).join(', ') || '（无）'}`);
    const type = spec.type ?? (typeof spec.default === 'number' ? 'number' : typeof spec.default === 'boolean' ? 'boolean' : 'string');
    let v: ParamValue = raw;
    if (type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ManifestError(`参数 ${k} 需要数字：${raw}`);
      if (spec.min !== undefined && n < spec.min) throw new ManifestError(`参数 ${k}=${n} 小于下限 ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) throw new ManifestError(`参数 ${k}=${n} 超过上限 ${spec.max}`);
      v = n;
    } else if (type === 'boolean') {
      v = ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
    }
    if (spec.enum && !spec.enum.map(String).includes(String(v))) throw new ManifestError(`参数 ${k}=${raw} 不在允许范围：${spec.enum.join(', ')}`);
    out[k] = v;
  }
  return out;
}

/** 本次运行适用的故障（onlyFor 过滤）。 */
export function faultsFor(exp: ExperimentDef, label: string): NonNullable<ExperimentDef['faults']> {
  return (exp.faults ?? []).filter((f) => !f.onlyFor?.length || f.onlyFor.includes(label));
}
