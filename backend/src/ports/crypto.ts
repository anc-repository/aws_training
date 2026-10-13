// backend/src/ports/crypto.ts   （kms 模块；总纲 §4.2，照录）
import type { Adapter } from './common.js';

/** 唯一的密文格式；数据库中的序列化形式为 ca1.<keyRef>.<edk>.<iv>.<ct>.<tag>（各段 base64url） */
export interface EncryptedBlob { v: 1; keyRef: string; edk: string; iv: string; tag: string; ct: string }  // edk = 被主密钥加密的数据密钥
export interface CryptoPort extends Adapter {
  readonly keyRef: string;           // 'local:v1' 或 KMS 密钥 ARN
  /** 信封加密：local 用 LOCAL_MASTER_KEY 包裹随机数据密钥（AES-256-GCM）；kms 用 GenerateDataKey + 数据密钥缓存。
   *  context 只放 { app, purpose: '<table>.<column>' }（作为 KMS EncryptionContext，缓存才能命中）；
   *  rowId 放进 AES-GCM 的 AAD，防止密文被搬到其他行 */
  encrypt(plaintext: Buffer, context: { app: string; purpose: string }, aad: { rowId: string }): Promise<EncryptedBlob>;
  decrypt(blob: EncryptedBlob, context: { app: string; purpose: string }, aad: { rowId: string }): Promise<Buffer>;   // 按 keyRef 选择方式，新旧并存
}
// 开关只有 KMS_KEY_ID（空 = local 驱动 = L0 默认，已加密）；不设 FIELD_ENCRYPTION。
// “明文对照”只作为 lab 子选项 CRYPTO_LOCAL_PLAINTEXT=on（写在 local.override.env，触发 CFG-005 横幅）；KMS_APPLY_TO 保留，只含不经栈注入的 fields、ebs（其余资源由 kms 的 injects target "*" 决定，3.4）。
