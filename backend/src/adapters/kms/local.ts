// backend/src/adapters/kms/local.ts —— CryptoPort 的 `local` 驱动（本地实现，02#kms 第 1 节）
//
// 信封加密：每次加密生成随机 32 字节数据密钥（DEK），用它以 AES-256-GCM 加密字段；再用 LOCAL_MASTER_KEY 派生的主密钥（KEK）
// 以 AES-256-GCM 包裹 DEK 得到 edk。上下文 {app, purpose} 与 rowId 都进 AAD：密文被搬到其他行 / 列时解密失败。
// 唯一的序列化形式：ca1.<keyRef>.<edk>.<iv>.<ct>.<tag>（各段 base64url；keyRef 也做 base64url，因为 KMS ARN 含 ':' 与 '/'）。
// 对照子选项 CRYPTO_LOCAL_PLAINTEXT=on：新写入的字段以明文保存（keyRef = local:plain），已有密文照常解密。
// 局限（对比点）：主密钥与密文在同一块数据卷上，无法审计谁解密过，也无法“一键撤销”。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { CryptoPort, EncryptedBlob } from '../../ports/crypto.js';
import { HttpError } from '../../errors.js';
import { markPath } from '../../observability/request-context.js';

export const LOCAL_KEY_REF = 'local:v1';
export const PLAINTEXT_KEY_REF = 'local:plain';

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** EncryptedBlob → `ca1.<keyRef>.<edk>.<iv>.<ct>.<tag>` */
export function serializeBlob(blob: EncryptedBlob): string {
  return ['ca1', b64u(Buffer.from(blob.keyRef, 'utf8')), blob.edk, blob.iv, blob.ct, blob.tag].join('.');
}

export function isSerializedBlob(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith('ca1.') && s.split('.').length === 6;
}

export function parseBlob(s: string): EncryptedBlob {
  const parts = s.split('.');
  if (parts.length !== 6 || parts[0] !== 'ca1') throw new Error('不是 ca1 格式的密文');
  const [, keyRef, edk, iv, ct, tag] = parts as [string, string, string, string, string, string];
  return { v: 1, keyRef: fromB64u(keyRef).toString('utf8'), edk, iv, ct, tag };
}

/** LOCAL_MASTER_KEY → 32 字节 KEK：base64 解码正好 32 字节时直接使用，否则取 sha256（兼容任意长度的口令） */
export function deriveMasterKey(secret: string): Buffer {
  const trimmed = secret.trim();
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')) return decoded;
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

function aadOf(context: { app: string; purpose: string }, aad?: { rowId: string }): Buffer {
  return Buffer.from(`ca1|${context.app}|${context.purpose}${aad ? `|${aad.rowId}` : ''}`, 'utf8');
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export class LocalCrypto implements CryptoPort {
  readonly meta: AdapterMeta = { module: 'kms', driver: 'local', awsService: null, authoritative: true };
  readonly keyRef: string;
  private kek: Buffer | undefined;
  private keyError: string | undefined;

  constructor(protected readonly deps: AdapterDeps) {
    this.keyRef = LOCAL_KEY_REF;
  }

  private get plaintextMode(): boolean {
    return this.deps.cfg.kms.CRYPTO_LOCAL_PLAINTEXT === 'on';
  }

  async init(): Promise<void> {
    await this.loadKey();
  }

  private async loadKey(): Promise<Buffer> {
    if (this.kek) return this.kek;
    const secrets = this.deps.secrets;
    if (!secrets) throw new Error('LocalCrypto: 缺少 SecretsPort（container 装配顺序错误）');
    try {
      const secret = await secrets.get('local-master-key');
      if (!secret) throw new Error('LOCAL_MASTER_KEY 为空');
      this.kek = deriveMasterKey(secret);
      this.keyError = undefined;
      return this.kek;
    } catch (e) {
      this.keyError = (e as Error).message;
      throw new HttpError(503, 'CRYPTO_KEY_UNAVAILABLE', `本地主密钥不可用：${this.keyError}`);
    }
  }

  async encrypt(plaintext: Buffer, context: { app: string; purpose: string }, aad: { rowId: string }): Promise<EncryptedBlob> {
    if (this.plaintextMode) {
      markPath('kms', 'local:plaintext');
      return { v: 1, keyRef: PLAINTEXT_KEY_REF, edk: '', iv: '', tag: '', ct: b64u(plaintext) };
    }
    const kek = await this.loadKey();
    markPath('kms', 'local:encrypt');
    const dek = randomBytes(32);
    const data = gcmEncrypt(dek, plaintext, aadOf(context, aad));
    const wrapped = gcmEncrypt(kek, dek, aadOf(context));
    return {
      v: 1, keyRef: LOCAL_KEY_REF,
      edk: b64u(Buffer.concat([wrapped.iv, wrapped.ct, wrapped.tag])),
      iv: b64u(data.iv), ct: b64u(data.ct), tag: b64u(data.tag),
    };
  }

  async decrypt(blob: EncryptedBlob, context: { app: string; purpose: string }, aad: { rowId: string }): Promise<Buffer> {
    if (blob.keyRef === PLAINTEXT_KEY_REF) {
      markPath('kms', 'local:plaintext');
      return fromB64u(blob.ct);
    }
    if (blob.keyRef !== LOCAL_KEY_REF) {
      throw new HttpError(503, 'CRYPTO_KEY_REF_UNSUPPORTED', `密文由 ${blob.keyRef} 加密，local 驱动无法解密（需要启用 kms 模块）`);
    }
    const kek = await this.loadKey();
    markPath('kms', 'local:decrypt');
    try {
      const edk = fromB64u(blob.edk);
      const dek = gcmDecrypt(kek, edk.subarray(0, 12), edk.subarray(12, edk.length - 16), edk.subarray(edk.length - 16), aadOf(context));
      return gcmDecrypt(dek, fromB64u(blob.iv), fromB64u(blob.ct), fromB64u(blob.tag), aadOf(context, aad));
    } catch {
      throw new HttpError(500, 'CRYPTO_DECRYPT_FAILED', '解密失败：主密钥不匹配，或密文被篡改 / 搬到了其他行');
    }
  }

  async probe(opts?: { deep?: boolean }): Promise<ProbeResult> {
    let kek: Buffer;
    try {
      kek = await this.loadKey();
    } catch {
      return { status: 'error', detail: `本地主密钥不可用：${this.keyError ?? 'LOCAL_MASTER_KEY 未配置'}` };
    }
    const fingerprint = createHash('sha256').update(kek).digest('hex').slice(0, 8);
    if (opts?.deep) {
      const ctx = { app: 'cloudalbum', purpose: 'probe.roundtrip' };
      const blob = await this.encrypt(Buffer.from('probe'), ctx, { rowId: 'probe' });
      const back = await this.decrypt(blob, ctx, { rowId: 'probe' });
      if (back.toString() !== 'probe') return { status: 'error', detail: '加密 / 解密往返失败' };
    }
    if (this.plaintextMode) {
      return { status: 'degraded', detail: 'CRYPTO_LOCAL_PLAINTEXT=on：新写入的敏感字段以明文保存（对照实验）', data: { keyRef: PLAINTEXT_KEY_REF } };
    }
    return {
      status: 'ok',
      detail: `LOCAL_MASTER_KEY 信封加密（AES-256-GCM）· 主密钥与密文同在数据卷上 · KEK 指纹 ${fingerprint}`,
      data: { keyRef: LOCAL_KEY_REF, kekFingerprint: fingerprint },
    };
  }
}
