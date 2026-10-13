/**
 * SchemaMigrator (01 §4.7 #5): expand-only, idempotent data migrations; the applied version is kept in `PLATFORM / SCHEMA`.
 * v1 has no migrations: the item records schema 1. A migration is a function added to MIGRATIONS with the next number.
 */
import { Keys } from '@atl/shared';
import type { CfnEvent, CfnResult } from '../cfn.js';
import { defaultPhysicalId, prop } from '../cfn.js';
import type { Ports } from '../ports.js';

export interface Migration {
  version: number;
  description: string;
  run(ports: Ports, table: string): Promise<void>;
}

export const SCHEMA_VERSION = 1;
export const MIGRATIONS: readonly Migration[] = [];

export async function schemaMigrator(event: CfnEvent, ports: Ports, migrations: readonly Migration[] = MIGRATIONS): Promise<CfnResult> {
  const id = defaultPhysicalId(event);
  if (event.RequestType === 'Delete') return { physicalResourceId: id };
  const table = prop(event, 'Table');
  const current = await ports.table.get(table, Keys.schemaVersion());
  let version = typeof current?.version === 'number' ? current.version : 0;
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= version) continue;
    await m.run(ports, table);
    version = m.version;
    applied.push(m.version);
  }
  const target = Math.max(version, SCHEMA_VERSION);
  const now = ports.now().toISOString();
  await ports.table.put(table, {
    ...Keys.schemaVersion(),
    type: 'SchemaVersion',
    ver: (typeof current?.ver === 'number' ? current.ver : 0) + 1,
    createdAt: (current?.createdAt as string | undefined) ?? now,
    updatedAt: now,
    version: target,
    platformVersion: String(event.ResourceProperties.Version ?? ''),
    lastApplied: applied,
  });
  return { physicalResourceId: id, data: { SchemaVersion: String(target) } };
}
