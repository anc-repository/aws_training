// backend/src/adapters/kms/local.ts —— CryptoPort 的 `local` 驱动（本地实现）
// LOCAL_MASTER_KEY 包裹随机数据密钥（AES-256-GCM），密文格式 ca1.<keyRef>.<edk>.<iv>.<ct>.<tag>
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CryptoPort, EncryptedBlob } from '../../ports/crypto.js';
import { notImplemented } from '../../errors.js';

export class LocalCrypto implements CryptoPort {
  readonly meta: AdapterMeta = { module: 'kms', driver: 'local', awsService: null, authoritative: true };
  readonly keyRef: string;

  constructor(protected readonly deps: AdapterDeps) {
    this.keyRef = 'local:v1';
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('LocalCrypto', 'probe', 'kms');
  }

  async encrypt(_plaintext: Buffer, _context: { app: string; purpose: string }, _aad: { rowId: string }): Promise<EncryptedBlob> {
    throw notImplemented('LocalCrypto', 'encrypt', 'kms');
  }

  async decrypt(_blob: EncryptedBlob, _context: { app: string; purpose: string }, _aad: { rowId: string }): Promise<Buffer> {
    throw notImplemented('LocalCrypto', 'decrypt', 'kms');
  }
}
