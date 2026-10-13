/**
 * Catalog placeholder cards (`status: planned`): a card that the catalog lists but that cannot be started yet.
 *
 * 04 §3.1 has no such status (draft | beta | stable | deprecated, and draft cards are hidden). The content round needs
 * all 56 cards visible with only the first batch startable, so a planned card is an `atl.lab/v2` document with
 * `status: planned` that carries the catalog metadata only (05 §8.1 “目录读取的字段”): steps, checks, manuals, quiz and
 * cleanup are absent, start provisions need no reasons and target modules no wire step. The schema is derived from the
 * 04 §3.3 schema (same field definitions), so a planned card upgrades to a full card by adding fields, never renaming.
 */
import { LAB_SCHEMA_V2 } from '@atl/shared';

export const PLANNED_STATUS = 'planned';

type Json = Record<string, unknown>;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function plannedLabSchema(): Json {
  const s = clone(LAB_SCHEMA_V2) as Json & { properties: Json; $defs: Record<string, Json> };
  s.$id = 'urn:atl:schema:lab:v2:planned';
  s.title = 'ATL lab.yaml v2 — catalog placeholder (status: planned)';
  s.properties.status = { const: PLANNED_STATUS };
  s.required = [
    'schema', 'id', 'kind', 'version', 'status', 'title', 'summary', 'difficulty', 'estimatedMinutes', 'timeLimitMinutes',
    'extensions', 'retain', 'services', 'modules', 'targetModules', 'provision', 'cost', 'badge', 'tracks', 'saa', 'tags',
  ];
  const defs = s.$defs;
  defs.targetModule = { ...defs.targetModule, required: ['id', 'driver'] };
  defs.cost = { ...defs.cost, required: ['tier'] };
  defs.startProfile = { ...defs.startProfile, required: ['provisions', 'platform'] };
  defs.provisionItem = { ...defs.provisionItem, required: ['item', 'kind'] };
  // steps / experiments / cleanup / quiz are not part of a placeholder
  for (const k of ['steps', 'finalChecks', 'experiments', 'quiz', 'cleanup', 'variables', 'permissions']) delete s.properties[k];
  return s;
}
