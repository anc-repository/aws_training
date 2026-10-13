/**
 * The `ENV#<envId>` partition (01 §7.2, AP13–AP15, AP22, AP23): `Environment`, `SessionResource`, `ReclaimPass`,
 * `InventorySnapshot`. Written by atl-lifecycle / atl-reaper / atl-tagger; atl-api only reads.
 */
import type { EnvironmentStatus } from '@atl/shared';
import { Gsi1, Gsi2, Keys, MANUAL_GSI2_PARTITIONS, SkPrefix } from '../data/keys.js';
import type { Item, Table } from './table.js';

export type EnvironmentRecord = Item & { envId: string; envName: string; status: EnvironmentStatus };
export type ResourceItem = Item & { resourceKey?: string; cleanupState?: string; severity?: string; billing?: string; sessionId?: string };

const ZERO_KEY = '0'.repeat(32);
/** Partition values derived from the key builders (01 §7.1). */
const ENVS_PK = Gsi1.environment('x', 'x').GSI1PK;
const envPk = (envId: string) => Keys.environment(envId).PK;
const sesresPk = (sid: string) => Gsi1.sessionResource(sid, 'x', ZERO_KEY).GSI1PK;
const envStatePk = (status: EnvironmentStatus) => Gsi2.environment(status, 'x', 'x')!.GSI2PK;

export class EnvironmentsRepo {
  constructor(private readonly table: Table) {}

  async get(envId: string, consistent = true): Promise<EnvironmentRecord | null> {
    return this.table.get<EnvironmentRecord>(Keys.environment(envId), consistent);
  }

  /** AP23: all environments, newest first. */
  async list(limit = 50): Promise<EnvironmentRecord[]> {
    return (await this.table.query<EnvironmentRecord>({ index: 'GSI1', pk: ENVS_PK, descending: true, limit })).items;
  }

  /** AP23: environments in a status (sparse GSI2, e.g. `KEPT`); re-read for full attributes. */
  async byStatus(status: Exclude<EnvironmentStatus, 'RELEASED'>): Promise<EnvironmentRecord[]> {
    const items = await this.table.queryAll({ index: 'GSI2', pk: envStatePk(status) }, 100);
    return this.table.batchGet<EnvironmentRecord>(items.map((i) => ({ PK: i.PK as string, SK: i.SK as string })));
  }

  /** AP14: the ledger of an environment. */
  async resources(envId: string): Promise<ResourceItem[]> {
    return this.table.queryAll<ResourceItem>({ pk: envPk(envId), sk: { beginsWith: SkPrefix.resource }, consistent: true }, 5000);
  }

  async resource(envId: string, resourceKey: string): Promise<ResourceItem | null> {
    return this.table.get<ResourceItem>(Keys.sessionResource(envId, resourceKey), true);
  }

  /** AP15: resources created by a session (GSI1 `SESRES#<sid>`). */
  async resourcesBySession(sid: string): Promise<ResourceItem[]> {
    return this.table.queryAll<ResourceItem>({ index: 'GSI1', pk: sesresPk(sid) }, 5000);
  }

  /** AP13: manual / review / failed items across environments (GSI2 projects only a few attributes: re-read). */
  async manualItems(): Promise<ResourceItem[]> {
    const keys: { PK: string; SK: string }[] = [];
    for (const pk of MANUAL_GSI2_PARTITIONS) {
      for (const it of await this.table.queryAll({ index: 'GSI2', pk }, 1000)) keys.push({ PK: it.PK as string, SK: it.SK as string });
    }
    return this.table.batchGet<ResourceItem>(keys);
  }

  /** AP22: reclaim passes of an environment. */
  async passes(envId: string): Promise<Item[]> {
    return this.table.queryAll({ pk: envPk(envId), sk: { beginsWith: SkPrefix.pass }, consistent: true }, 500);
  }
}
