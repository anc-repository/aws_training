// backend/src/repositories/atl-probe-nonces.ts —— 一次性探测令牌的 nonce 登记（06 PM-09）
//
// 校验通过后插入一行；主键冲突 = 同一个 nonce 已经用过 → 401 PROBE_TOKEN_REPLAYED。worker 的定时任务 atl.probe-nonce-gc
// 每 10 分钟删除 exp < now - 600 的行。表在主库中：ASG 必然已启用共享的 database（ASG-002），所以令牌在任一实例上都只能用一次。
import type { Knex } from 'knex';
import { isUniqueViolation } from '../db/dialect.js';

/** true = 登记成功（首次使用）；false = 已经用过（重放） */
export async function registerNonce(db: Knex, input: { nonce: string; exp: number; usedAt?: number; instanceId?: string | null }): Promise<boolean> {
  try {
    await db('atl_probe_nonces').insert({
      nonce: input.nonce, exp: input.exp, used_at: input.usedAt ?? Math.floor(Date.now() / 1000), instance_id: input.instanceId ?? null,
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/** 删除 exp < nowSec - graceSec 的行，返回删除的行数 */
export async function purgeExpiredNonces(db: Knex, nowSec = Math.floor(Date.now() / 1000), graceSec = 600): Promise<number> {
  return db('atl_probe_nonces').where('exp', '<', nowSec - graceSec).del();
}
