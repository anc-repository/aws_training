// CryptoPort · local 驱动：契约 + ca1 序列化、主密钥不匹配、明文对照子选项、KMS 密文的拒绝
import { afterEach, describe, expect, it } from 'vitest';
import { deriveMasterKey, isSerializedBlob, LocalCrypto, parseBlob, serializeBlob } from '../../src/adapters/kms/local.js';
import { EnvSecrets } from '../../src/adapters/secrets/env.js';
import { HttpError } from '../../src/errors.js';
import { l0Secrets } from '../helpers/identity-harness.js';
import { describeCryptoContract } from './crypto.contract.js';
import { makeLocalDeps, type LocalDeps } from './_local-deps.js';

async function localCrypto(opts: Parameters<typeof makeLocalDeps>[0] = {}) {
  const l = await makeLocalDeps(opts);
  l.deps.secrets = new EnvSecrets(l.deps);
  return { l, port: new LocalCrypto(l.deps) };
}

describeCryptoContract('local', async () => {
  const { l, port } = await localCrypto();
  return { port, cleanup: () => l.close() };
});

describe('LocalCrypto（本地实现特有）', () => {
  const ctx = { app: 'cloudalbum', purpose: 'users.mfa_secret_enc' };
  let l: LocalDeps | undefined;
  afterEach(async () => {
    await l?.close();
    l = undefined;
  });

  it('序列化为 ca1.<keyRef>.<edk>.<iv>.<ct>.<tag>（各段 base64url）并能还原', async () => {
    const x = await localCrypto();
    l = x.l;
    const blob = await x.port.encrypt(Buffer.from('hello'), ctx, { rowId: 'r' });
    const s = serializeBlob(blob);
    expect(isSerializedBlob(s)).toBe(true);
    expect(s.split('.')).toHaveLength(6);
    expect(s.split('.').slice(1).every((seg) => /^[A-Za-z0-9_-]*$/.test(seg))).toBe(true);
    expect(parseBlob(s)).toEqual(blob);
    expect(() => parseBlob('ca2.x')).toThrow();
  });

  it('换了 LOCAL_MASTER_KEY 就无法解密旧密文（CFG-007 指纹检查要防止的情况）', async () => {
    const a = await localCrypto();
    const blob = await a.port.encrypt(Buffer.from('hello'), ctx, { rowId: 'r' });
    await a.l.close();
    const b = await localCrypto({ secrets: l0Secrets() });
    l = b.l;
    await expect(b.port.decrypt(blob, ctx, { rowId: 'r' })).rejects.toMatchObject({ code: 'CRYPTO_DECRYPT_FAILED' });
  });

  it('CRYPTO_LOCAL_PLAINTEXT=on：新写入的字段为明文（对照实验），已有密文照常解密；探针 degraded', async () => {
    const enc = await localCrypto();
    const old = await enc.port.encrypt(Buffer.from('old'), ctx, { rowId: 'r' });
    const secrets = { LOCAL_MASTER_KEY: enc.l.deps.env.LOCAL_MASTER_KEY! };
    await enc.l.close();
    const plain = await localCrypto({ base: { CRYPTO_LOCAL_PLAINTEXT: 'on' }, secrets: { ...l0Secrets(), ...secrets } });
    l = plain.l;
    const blob = await plain.port.encrypt(Buffer.from('new'), ctx, { rowId: 'r' });
    expect(blob.keyRef).toBe('local:plain');
    expect(Buffer.from(blob.ct, 'base64url').toString()).toBe('new');
    expect((await plain.port.decrypt(old, ctx, { rowId: 'r' })).toString()).toBe('old');
    expect((await plain.port.probe()).status).toBe('degraded');
  });

  it('KMS 加密的密文：local 驱动返回 503（需要启用 kms 模块），不静默失败', async () => {
    const x = await localCrypto();
    l = x.l;
    const err = await x.port.decrypt({ v: 1, keyRef: 'arn:aws:kms:ap-northeast-1:123456789012:key/abc', edk: '', iv: '', ct: '', tag: '' }, ctx, { rowId: 'r' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
  });

  it('主密钥缺失：探针 error；加密返回 503', async () => {
    const s = l0Secrets();
    delete s.LOCAL_MASTER_KEY;
    const x = await localCrypto({ secrets: s });
    l = x.l;
    expect((await x.port.probe()).status).toBe('error');
    await expect(x.port.encrypt(Buffer.from('x'), ctx, { rowId: 'r' })).rejects.toMatchObject({ status: 503 });
  });

  it('deriveMasterKey：32 字节 base64 直接使用，其他口令取 sha256', () => {
    const raw = Buffer.alloc(32, 7);
    expect(deriveMasterKey(raw.toString('base64')).equals(raw)).toBe(true);
    expect(deriveMasterKey('short passphrase')).toHaveLength(32);
  });
});
