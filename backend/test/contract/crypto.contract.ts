// CryptoPort 契约（kms 模块）：信封加密、上下文与 rowId 绑定、篡改检测。local 与 kms 驱动都要满足。
import { describe, expect, it } from 'vitest';
import type { CryptoPort } from '../../src/ports/crypto.js';

export function describeCryptoContract(driver: string, make: () => Promise<{ port: CryptoPort; cleanup?: () => Promise<void> }>): void {
  const ctx = { app: 'cloudalbum', purpose: 'users.mfa_secret_enc' };

  describe(`CryptoPort 契约 · ${driver}`, () => {
    it('meta：module=kms、权威端口；keyRef 非空', async () => {
      const { port, cleanup } = await make();
      expect(port.meta).toMatchObject({ module: 'kms', driver, authoritative: true });
      expect(port.keyRef).toBeTruthy();
      await cleanup?.();
    });

    it('encrypt → decrypt 往返；密文不含明文；每次加密的数据密钥与 IV 都不同', async () => {
      const { port, cleanup } = await make();
      await port.init?.();
      const plain = Buffer.from('JBSWY3DPEHPK3PXP-totp-secret');
      const a = await port.encrypt(plain, ctx, { rowId: 'u-1' });
      const b = await port.encrypt(plain, ctx, { rowId: 'u-1' });
      expect(a).toMatchObject({ v: 1, keyRef: port.keyRef });
      expect(JSON.stringify(a)).not.toContain(plain.toString('base64url'));
      expect(a.iv).not.toBe(b.iv);
      expect(a.edk).not.toBe(b.edk);
      expect((await port.decrypt(a, ctx, { rowId: 'u-1' })).equals(plain)).toBe(true);
      await cleanup?.();
    });

    it('rowId 进 AAD：密文搬到别的行就无法解密', async () => {
      const { port, cleanup } = await make();
      await port.init?.();
      const blob = await port.encrypt(Buffer.from('secret'), ctx, { rowId: 'u-1' });
      await expect(port.decrypt(blob, ctx, { rowId: 'u-2' })).rejects.toThrow();
      await cleanup?.();
    });

    it('purpose 进上下文：密文搬到别的列就无法解密', async () => {
      const { port, cleanup } = await make();
      await port.init?.();
      const blob = await port.encrypt(Buffer.from('secret'), ctx, { rowId: 'u-1' });
      await expect(port.decrypt(blob, { ...ctx, purpose: 'photos.location_enc' }, { rowId: 'u-1' })).rejects.toThrow();
      await cleanup?.();
    });

    it('篡改密文或认证标签被发现', async () => {
      const { port, cleanup } = await make();
      await port.init?.();
      const blob = await port.encrypt(Buffer.from('secret value'), ctx, { rowId: 'u-1' });
      const flipped = Buffer.from(blob.ct, 'base64url');
      flipped[0] = flipped[0]! ^ 0xff;
      await expect(port.decrypt({ ...blob, ct: flipped.toString('base64url') }, ctx, { rowId: 'u-1' })).rejects.toThrow();
      await expect(port.decrypt({ ...blob, tag: Buffer.alloc(16).toString('base64url') }, ctx, { rowId: 'u-1' })).rejects.toThrow();
      await cleanup?.();
    });

    it('probe()', async () => {
      const { port, cleanup } = await make();
      await port.init?.();
      expect((await port.probe({ deep: true })).status).toBe('ok');
      await cleanup?.();
    });
  });
}
