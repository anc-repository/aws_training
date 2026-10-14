/**
 * Structural validation of a parsed `lab.yaml` against the `atl.lab/v2` JSON Schema (04 §3.3).
 * Cross-field / cross-file rules (04 §3.5 lint A/B/C) are implemented by `labs:lint` (scripts/labs), not here.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { LAB_SCHEMA_V2 } from './lab-schema.generated.js';
import type { LabV2Source } from './types.js';

export const LAB_SCHEMA_ID = 'urn:atl:schema:lab:v2';
export const LAB_SCHEMA_VERSION = 'atl.lab/v2';

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (!compiled) {
    // strict mode off: the transcribed schema uses `if` blocks without `type` and `required` without `properties`
    // (both valid draft 2020-12); `allErrors` so that lint can report every problem at once.
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    compiled = ajv.compile(LAB_SCHEMA_V2 as Record<string, unknown>);
  }
  return compiled;
}

export interface LabSchemaIssue {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

/** On success `lab` is the card as written: text fields may still be localized objects (`resolveLocalized`). */
export type LabValidationResult = { ok: true; lab: LabV2Source } | { ok: false; issues: LabSchemaIssue[] };

export function validateLab(doc: unknown): LabValidationResult {
  const v = validator();
  if (v(doc)) return { ok: true, lab: doc as LabV2Source };
  return { ok: false, issues: (v.errors ?? []).map(toIssue) };
}

function toIssue(e: ErrorObject): LabSchemaIssue {
  return {
    path: e.instancePath || '/',
    message: e.message ?? e.keyword,
    keyword: e.keyword,
    params: e.params as Record<string, unknown>,
  };
}

export function formatLabIssues(issues: readonly LabSchemaIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('\n');
}
