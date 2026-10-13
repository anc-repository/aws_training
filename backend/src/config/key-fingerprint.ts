// backend/src/config/key-fingerprint.ts —— LOCAL_MASTER_KEY 指纹比对（CFG-007，总纲 2.4、2.7 不变量 3）
//
// 首次启动时把指纹写入数据库 system_meta；此后每次启动比对，不一致即拒绝启动（退出码 78）。
// 指纹 = sha256(LOCAL_MASTER_KEY) 的前 16 个十六进制字符（不可逆，可以安全地打印与比较）。
// resetKeyFingerprint()：`cloudalbum-postattach --regenerate-secrets` 的恢复路径（cli keys:reset-fingerprint --confirm-data-loss）——
//   主密钥已经丢失、重新生成后，清空无法再解密的字段（users.mfa_secret_enc → 关闭 MFA、photos.location_enc），再把指纹改写为新值。
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { ConfigValidationError, isNotImplemented } from '../errors.js';
import type { Logger } from '../ports/logger.js';
import type { SecretsPort } from '../ports/secrets.js';
import { META_KEYS, getMeta, setMeta } from '../repositories/system-meta.js';

export function keyFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16);
}

export type FingerprintStatus =
  | { status: 'recorded' | 'match'; fingerprint: string }
  | { status: 'skipped'; reason: string };

/** 读取当前指纹（cli keys:fingerprint） */
export async function currentKeyFingerprint(secrets: SecretsPort): Promise<string | null> {
  try {
    const key = await secrets.get('local-master-key');
    return key ? keyFingerprint(key) : null;
  } catch (e) {
    if (isNotImplemented(e)) return null;
    throw e;
  }
}

/**
 * 比对并在首次启动时记录指纹。不一致时抛出 ConfigValidationError（调用方以退出码 78 退出）。
 * 机密适配器尚未实现（脚手架阶段）或 LOCAL_MASTER_KEY 未配置时跳过并告警。
 */
export async function checkKeyFingerprint(db: Knex, secrets: SecretsPort, logger?: Pick<Logger, 'warn' | 'info'>): Promise<FingerprintStatus> {
  let key: string;
  try {
    key = await secrets.get('local-master-key');
  } catch (e) {
    const reason = isNotImplemented(e) ? 'SecretsPort 尚未实现' : `读取 local-master-key 失败：${(e as Error).message}`;
    logger?.warn('CFG-007 check skipped', { reason });
    return { status: 'skipped', reason };
  }
  if (!key) {
    logger?.warn('CFG-007 check skipped', { reason: 'LOCAL_MASTER_KEY 未配置' });
    return { status: 'skipped', reason: 'LOCAL_MASTER_KEY 未配置' };
  }
  const fp = keyFingerprint(key);
  const recorded = await getMeta(db, META_KEYS.localMasterKeyFingerprint);
  if (!recorded) {
    await setMeta(db, META_KEYS.localMasterKeyFingerprint, fp);
    logger?.info('local master key fingerprint recorded', { fingerprint: fp });
    return { status: 'recorded', fingerprint: fp };
  }
  if (recorded !== fp) {
    throw new ConfigValidationError([
      'FAIL 配置校验未通过：1 个错误，0 个警告',
      `  [ERROR] CFG-007  LOCAL_MASTER_KEY 的指纹（${fp}）与数据库 system_meta 中记录的（${recorded}）不一致：已加密字段将无法解密`,
      '          修复：从数据卷 / 备份恢复 etc/secrets.env，不要删除指纹记录',
    ].join('\n'));
  }
  return { status: 'match', fingerprint: fp };
}

export interface FingerprintReset {
  status: 'match' | 'reset';
  fingerprint: string;
  previous: string | null;
  cleared: { mfaUsers: number; photoLocations: number; mfaChallenges: number };
}

/**
 * 放弃旧主密钥下的全部加密字段，并记录新指纹（幂等：指纹已一致时什么都不做）。只由显式的 CLI 命令调用（--confirm-data-loss）。
 * 本轮 kms 只有本地驱动，所有 ca1.* 密文都由 LOCAL_MASTER_KEY 派生的密钥加密，因此全部清空。
 */
export async function resetKeyFingerprint(db: Knex, key: string): Promise<FingerprintReset> {
  if (!key) throw new Error('LOCAL_MASTER_KEY 未配置：无法记录新指纹');
  const fp = keyFingerprint(key);
  return db.transaction(async (trx) => {
    const previous = await getMeta(trx, META_KEYS.localMasterKeyFingerprint);
    const cleared = { mfaUsers: 0, photoLocations: 0, mfaChallenges: 0 };
    if (previous === fp) return { status: 'match' as const, fingerprint: fp, previous, cleared };
    const now = new Date().toISOString();
    cleared.mfaUsers = await trx('users').whereNotNull('mfa_secret_enc').update({ mfa_secret_enc: null, mfa_enabled: false, updated_at: now });
    cleared.photoLocations = await trx('photos').whereNotNull('location_enc').update({ location_enc: null });
    cleared.mfaChallenges = await trx('auth_tokens').where({ type: 'mfa_challenge' }).del();
    await setMeta(trx, META_KEYS.localMasterKeyFingerprint, fp);
    return { status: 'reset' as const, fingerprint: fp, previous, cleared };
  });
}
