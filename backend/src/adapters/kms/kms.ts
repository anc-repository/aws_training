// backend/src/adapters/kms/kms.ts —— CryptoPort 的 `kms` 驱动（AWS KMS）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CryptoPort, EncryptedBlob } from '../../ports/crypto.js';
import { notImplemented } from '../../errors.js';

export class KmsCrypto implements CryptoPort {
  readonly meta: AdapterMeta = { module: 'kms', driver: 'kms', awsService: 'AWS KMS', authoritative: true };
  readonly keyRef: string;

  constructor(protected readonly deps: AdapterDeps) {
    this.keyRef = deps.cfg.core.KMS_KEY_ID;
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('KmsCrypto', 'probe', 'kms');
  }

  async encrypt(_plaintext: Buffer, _context: { app: string; purpose: string }, _aad: { rowId: string }): Promise<EncryptedBlob> {
    throw notImplemented('KmsCrypto', 'encrypt', 'kms');
  }

  async decrypt(_blob: EncryptedBlob, _context: { app: string; purpose: string }, _aad: { rowId: string }): Promise<Buffer> {
    throw notImplemented('KmsCrypto', 'decrypt', 'kms');
  }
}
