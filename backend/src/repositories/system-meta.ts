// backend/src/repositories/system-meta.ts —— system_meta 表（本地主密钥指纹等，CFG-007）
import type { Knex } from 'knex';
import { nowIso, upsert } from '../db/dialect.js';

export const META_KEYS = {
  /** LOCAL_MASTER_KEY 的指纹（sha256 前 16 个十六进制字符）；首次启动写入，此后每次启动比对 */
  localMasterKeyFingerprint: 'local_master_key_fingerprint',
} as const;

export async function getMeta(db: Knex, key: string): Promise<string | null> {
  const row = (await db('system_meta').where({ key }).first('value')) as { value?: string } | undefined;
  return row?.value ?? null;
}

export async function setMeta(db: Knex, key: string, value: string): Promise<void> {
  await upsert(db, 'system_meta', { key, value, updated_at: nowIso() }, ['key'], ['value', 'updated_at']);
}
