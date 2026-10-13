// Minimal JSON Schema validator for the per-check args schemas (no dependencies on the instance).
// Supported keywords: type, enum, const, pattern, minLength, maxLength, minimum, maximum, items, minItems, maxItems,
// properties, required, additionalProperties, oneOf, and the ATL keyword maxMinutes (duration strings like 10m).
import { durationWithin } from '../args-schemas.mjs';

const TYPE_CHECK = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

export function validateArgs(schema, value, at = '$') {
  const errs = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((t) => TYPE_CHECK[t]?.(value))) {
    errs.push(`${at}: expected ${types.join('|')}`);
    return errs;
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: not one of the allowed values`);
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validateArgs(s, value, at).length === 0).length;
    if (ok !== 1) errs.push(`${at}: must match exactly one allowed form`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: too long`);
    if (schema.maxMinutes !== undefined && !durationWithin(value, schema.maxMinutes)) errs.push(`${at}: duration must be 1s..${schema.maxMinutes}m`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at}: > ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: too many items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateArgs(schema.items, v, `${at}[${i}]`)));
  }
  if (TYPE_CHECK.object(value)) {
    for (const r of schema.required ?? []) if (!(r in value)) errs.push(`${at}.${r}: required`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validateArgs(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...validateArgs(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  return errs;
}
