// backend/src/config/key-fingerprint.ts —— LOCAL_MASTER_KEY 指纹比对（CFG-007，总纲 2.4、2.7 不变量 3）
//
// 首次启动时把指纹写入数据库 system_meta；此后每次启动比对，不一致即拒绝启动（退出码 78）。
// 指纹 = sha256(LOCAL_MASTER_KEY) 的前 16 个十六进制字符（不可逆，可以安全地打印与比较）。
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
