/**
 * JSON Schemas of the content files (04 §2.1 `labs/_schema/`) and their ajv validators.
 * lab.schema.json is the 04 §3.3 transcription in @atl/shared; the others are defined in this directory.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { LAB_SCHEMA_V2 } from '@atl/shared';
import { CHECK_SCHEMA } from './check.js';
import { MANUAL_FRONTMATTER_SCHEMA } from './manual.js';
import { plannedLabSchema } from './planned.js';
import { PRICING_SCHEMA } from './pricing.js';
import { QUIZ_SCHEMA } from './quiz.js';
import { TAXONOMY_SCHEMA } from './taxonomy.js';
import { TRACK_SCHEMA } from './track.js';

export { CHECK_SCHEMA, MANUAL_FRONTMATTER_SCHEMA, PRICING_SCHEMA, QUIZ_SCHEMA, TAXONOMY_SCHEMA, TRACK_SCHEMA, plannedLabSchema };

export type SchemaName = 'lab' | 'lab-planned' | 'check' | 'quiz' | 'track' | 'taxonomy' | 'pricing' | 'manual-frontmatter';

/** File names under labs/_schema (04 §2.1; `lab-planned` and `pricing` are additions of this round). */
export const SCHEMA_FILES: Readonly<Record<SchemaName, string>> = {
  lab: 'lab.schema.json',
  'lab-planned': 'lab-planned.schema.json',
  check: 'check.schema.json',
  quiz: 'quiz.schema.json',
  track: 'track.schema.json',
  taxonomy: 'taxonomy.schema.json',
  pricing: 'pricing.schema.json',
  'manual-frontmatter': 'manual-frontmatter.schema.json',
};

export function schemaObject(name: SchemaName): Record<string, unknown> {
  switch (name) {
    case 'lab':
      return LAB_SCHEMA_V2 as Record<string, unknown>;
    case 'lab-planned':
      return plannedLabSchema();
    case 'check':
      return CHECK_SCHEMA as unknown as Record<string, unknown>;
    case 'quiz':
      return QUIZ_SCHEMA as unknown as Record<string, unknown>;
    case 'track':
      return TRACK_SCHEMA as unknown as Record<string, unknown>;
    case 'taxonomy':
      return TAXONOMY_SCHEMA as unknown as Record<string, unknown>;
    case 'pricing':
      return PRICING_SCHEMA as unknown as Record<string, unknown>;
    case 'manual-frontmatter':
      return MANUAL_FRONTMATTER_SCHEMA as unknown as Record<string, unknown>;
  }
}

export interface SchemaIssue {
  path: string;
  message: string;
}

const compiled = new Map<SchemaName, ValidateFunction>();

function validator(name: SchemaName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    // strict off: the 04 schema uses `if` without `type` and `required` without `properties` (valid 2020-12)
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    v = ajv.compile(schemaObject(name));
    compiled.set(name, v);
  }
  return v;
}

/** Drop the noise of `oneOf` / `if` wrappers: keep the most specific errors first. */
function toIssues(errors: readonly ErrorObject[] | null | undefined): SchemaIssue[] {
  const list = (errors ?? []).filter((e) => !['if', 'oneOf', 'anyOf', 'allOf'].includes(e.keyword) || (errors ?? []).length === 1);
  const seen = new Set<string>();
  const out: SchemaIssue[] = [];
  for (const e of list.length ? list : (errors ?? [])) {
    const extra =
      e.keyword === 'additionalProperties'
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : e.keyword === 'enum'
          ? ` (${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})`
          : '';
    const issue = { path: e.instancePath || '/', message: `${e.message ?? e.keyword}${extra}` };
    const k = `${issue.path} ${issue.message}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(issue);
    }
  }
  return out;
}

export function validateWith(name: SchemaName, doc: unknown): SchemaIssue[] {
  const v = validator(name);
  return v(doc) ? [] : toIssues(v.errors);
}
