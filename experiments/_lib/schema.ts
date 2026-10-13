/**
 * experiments/_lib/schema.ts —— experiment.json / 结果 JSON 的 JSON Schema 校验（ajv，draft-07）。
 * schema 文件在运行时从 `_lib/schema/` 读取（源码与 dist 都能定位，见 util.experimentsRoot）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { experimentsRoot } from './util.js';

let ajv: Ajv | undefined;
const compiled = new Map<string, ValidateFunction>();

function validator(name: 'experiment' | 'result'): ValidateFunction {
  let v = compiled.get(name);
  if (v) return v;
  ajv ??= new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const file = path.join(experimentsRoot(), '_lib', 'schema', `${name}.schema.json`);
  const schema = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  v = ajv.compile(schema);
  compiled.set(name, v);
  return v;
}

export interface SchemaCheck {
  ok: boolean;
  errors: string[];
}

function format(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ''}`.trim());
}

export function validateExperimentManifest(doc: unknown): SchemaCheck {
  const v = validator('experiment');
  const ok = v(doc) as boolean;
  return { ok, errors: ok ? [] : format(v.errors) };
}

export function validateResult(doc: unknown): SchemaCheck {
  const v = validator('result');
  const ok = v(doc) as boolean;
  return { ok, errors: ok ? [] : format(v.errors) };
}
