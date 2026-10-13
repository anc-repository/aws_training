/**
 * Read-only access to the CloudFormation templates in infra/modules (short-form intrinsic tags supported).
 * Used to know which parameters a stack declares (injects with target "*", secret parameters, required parameters)
 * and which Env* outputs it can produce (placeholders in --dry-run plans).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { ModuleId } from '@cloudalbum/contracts';
import { REGISTRY, type Registry } from './registry.js';

const INTRINSICS = [
  'Ref', 'Sub', 'GetAtt', 'If', 'Equals', 'Not', 'And', 'Or', 'Join', 'Split', 'Select', 'FindInMap', 'GetAZs',
  'ImportValue', 'Base64', 'Cidr', 'Condition', 'Transform', 'ToJsonString', 'Length', 'Contains',
] as const;

type Tag = { tag: string; collection?: 'map' | 'seq'; resolve: (v: never) => unknown };

const CFN_TAGS: Tag[] = INTRINSICS.flatMap((n) => {
  const key = n === 'Ref' || n === 'Condition' ? n : `Fn::${n}`;
  return [
    { tag: `!${n}`, resolve: (s: string) => ({ [key]: n === 'GetAtt' ? s.split('.') : s }) },
    { tag: `!${n}`, collection: 'seq' as const, resolve: (seq: { toJSON(): unknown }) => ({ [key]: seq.toJSON() }) },
    { tag: `!${n}`, collection: 'map' as const, resolve: (m: { toJSON(): unknown }) => ({ [key]: m.toJSON() }) },
  ] as Tag[];
});

export interface TemplateParameter {
  Type: string;
  Default?: string | number;
  NoEcho?: boolean;
  AllowedValues?: Array<string | number>;
  Description?: string;
}

export interface TemplateOutput {
  Value: unknown;
  Condition?: string;
  Description?: string;
  Export?: unknown;
}

export interface CfnTemplate {
  file: string;
  Description?: string;
  Parameters: Record<string, TemplateParameter>;
  Conditions: Record<string, unknown>;
  Resources: Record<string, { Type: string; Condition?: string; Properties?: Record<string, unknown>; [k: string]: unknown }>;
  Outputs: Record<string, TemplateOutput>;
  Metadata?: Record<string, unknown>;
}

export function parseTemplate(text: string, file = '<inline>'): CfnTemplate {
  const doc = parse(text, { customTags: CFN_TAGS as never, version: '1.1' }) as Partial<CfnTemplate> | null;
  if (!doc || typeof doc !== 'object') throw new Error(`${file}: not a CloudFormation template`);
  return {
    file,
    ...(doc.Description ? { Description: doc.Description } : {}),
    Parameters: doc.Parameters ?? {},
    Conditions: doc.Conditions ?? {},
    Resources: doc.Resources ?? {},
    Outputs: doc.Outputs ?? {},
    ...(doc.Metadata ? { Metadata: doc.Metadata } : {}),
  };
}

const cache = new Map<string, CfnTemplate>();

export function loadTemplate(repoRoot: string, relPath: string): CfnTemplate {
  const abs = path.resolve(repoRoot, relPath);
  let t = cache.get(abs);
  if (!t) {
    t = parseTemplate(readFileSync(abs, 'utf8'), relPath);
    cache.set(abs, t);
  }
  return t;
}

export function readTemplateBody(repoRoot: string, relPath: string): string {
  return readFileSync(path.resolve(repoRoot, relPath), 'utf8');
}

/** Template of the main stack of a module (registry stacks[name=main]) */
export function mainTemplatePath(id: ModuleId, registry: Registry = REGISTRY): string {
  const s = registry[id]?.stacks.find((x) => x.name === 'main') ?? registry[id]?.stacks[0];
  if (!s) throw new Error(`module ${id} has no stack`);
  return s.template;
}

/** Parameters that must be supplied (no Default) */
export function requiredParameters(t: CfnTemplate): string[] {
  return Object.entries(t.Parameters).filter(([, p]) => p.Default === undefined).map(([k]) => k);
}

export function noEchoParameters(t: CfnTemplate): string[] {
  return Object.entries(t.Parameters).filter(([, p]) => p.NoEcho === true || String(p.NoEcho) === 'true').map(([k]) => k);
}

/**
 * Value of an output that is known before deployment: a literal, or `!Ref <Parameter>` (given value or Default).
 * undefined = only CloudFormation knows it (resource attributes, Sub, If ...).
 */
/** 只依赖参数（含默认值）与字面量的值：字面量、`!Ref 参数`；无法静态求值时返回 undefined */
function staticScalar(t: CfnTemplate, v: unknown, params: Readonly<Record<string, string>>): string | undefined {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && typeof v === 'object' && 'Ref' in v && typeof (v as { Ref: unknown }).Ref === 'string') {
    const ref = (v as { Ref: string }).Ref;
    const p = t.Parameters[ref];
    if (!p) return undefined;
    if (ref in params) return params[ref];
    return p.Default !== undefined ? String(p.Default) : undefined;
  }
  return undefined;
}

/** 只依赖参数的条件（Fn::Equals / Not / And / Or / Condition）；无法静态求值时返回 undefined */
export function staticCondition(t: CfnTemplate, cond: unknown, params: Readonly<Record<string, string>> = {}, depth = 0): boolean | undefined {
  if (depth > 10 || !cond || typeof cond !== 'object') return undefined;
  const o = cond as Record<string, unknown>;
  if (typeof o.Condition === 'string') return staticCondition(t, t.Conditions[o.Condition], params, depth + 1);
  if (Array.isArray(o['Fn::Equals'])) {
    const [a, b] = (o['Fn::Equals'] as unknown[]).map((x) => staticScalar(t, x, params));
    return a === undefined || b === undefined ? undefined : a === b;
  }
  if (Array.isArray(o['Fn::Not'])) {
    const r = staticCondition(t, (o['Fn::Not'] as unknown[])[0], params, depth + 1);
    return r === undefined ? undefined : !r;
  }
  for (const [k, all] of [['Fn::And', true], ['Fn::Or', false]] as const) {
    if (Array.isArray(o[k])) {
      const rs = (o[k] as unknown[]).map((x) => staticCondition(t, x, params, depth + 1));
      if (rs.some((r) => r === undefined)) return undefined;
      return all ? rs.every(Boolean) : rs.some(Boolean);
    }
  }
  return undefined;
}

/**
 * 部署前就能确定的输出值：字面量、`!Ref 参数`（取传入值或默认值），以及条件只依赖参数的 `!If [条件, a, b]`
 * （例如 auth 的 EnvCognitoTriggers、cache 的 EnvRedisClientMode：--dry-run 的计划校验需要合法的枚举值，不能用占位符）。
 */
export function staticOutputValue(t: CfnTemplate, name: string, params: Readonly<Record<string, string>> = {}): string | undefined {
  const v = t.Outputs[name]?.Value;
  const direct = staticScalar(t, v, params);
  if (direct !== undefined) return direct;
  if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)['Fn::If'])) {
    const [condName, a, b] = (v as { 'Fn::If': unknown[] })['Fn::If'];
    if (typeof condName !== 'string') return undefined;
    const c = staticCondition(t, t.Conditions[condName], params);
    if (c === undefined) return undefined;
    return staticScalar(t, c ? a : b, params);
  }
  return undefined;
}

/** Static checks shared by tests and preflight: no Export / ImportValue anywhere (D2). */
export function findExportsAndImports(t: CfnTemplate): string[] {
  const hits: string[] = [];
  for (const [name, o] of Object.entries(t.Outputs)) if (o.Export !== undefined) hits.push(`Outputs.${name}.Export`);
  const walk = (v: unknown, where: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'Fn::ImportValue') hits.push(where);
        walk(x, `${where}.${k}`);
      }
    }
  };
  walk(t.Resources, 'Resources');
  walk(t.Outputs, 'Outputs');
  return hits;
}
