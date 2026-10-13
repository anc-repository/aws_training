// auth=local 的辅助代码：RFC 6238 TOTP、密码策略、argon2id 哈希
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, otpauthUrl, totpAt, verifyTotp } from '../../src/adapters/auth/local/totp.js';
import { checkPassword } from '../../src/adapters/auth/local/password-policy.js';
import { hashPassword, verifyPassword } from '../../src/adapters/auth/local/hash.js';
import { previousKeyPath } from '../../src/adapters/auth/local/keys.js';

describe('TOTP（RFC 6238 附录 B 的 SHA1 测试向量，取后 6 位）', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('base32 往返', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv-gy3t qojq')).toEqual(base32Decode('GEZDGNBVGY3TQOJQ'));
    expect(() => base32Decode('!!')).toThrow();
  });

  it.each([
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'],
  ])('T=%i → %s', (t, code) => {
    expect(totpAt(secret, t * 1000)).toBe(code);
  });

  it('允许 ±1 个时间步的偏差，拒绝格式错误', () => {
    const at = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, at - 30_000), { atMs: at })).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, at - 90_000), { atMs: at })).toBe(false);
    expect(verifyTotp(secret, 'abcdef', { atMs: at })).toBe(false);
    expect(verifyTotp(secret, '12345', { atMs: at })).toBe(false);
  });

  it('otpauth URL', () => {
    expect(otpauthUrl({ issuer: 'CloudAlbum', account: 'a@b.c', secret })).toBe(
      `otpauth://totp/CloudAlbum%3Aa%40b.c?secret=${secret}&issuer=CloudAlbum&algorithm=SHA1&digits=6&period=30`);
  });
});

describe('密码策略', () => {
  it('长度、字母、数字、常见密码、包含邮箱用户名', () => {
    expect(checkPassword('Correct-horse-42')).toEqual([]);
    expect(checkPassword('short1')).toContain('至少 8 个字符');
    expect(checkPassword('12345678901')).toContain('至少包含一个字母');
    expect(checkPassword('onlyletters')).toContain('至少包含一个数字');
    expect(checkPassword('Password123')).toContain('不能使用常见密码');
    expect(checkPassword('alice-2026-x', { email: 'alice@example.com' })).toContain('不能包含邮箱用户名');
    expect(checkPassword(`a1${'x'.repeat(300)}`)).toContain('最多 256 个字符');
  });
});

describe('argon2id', () => {
  it('哈希与校验；哈希格式错误时返回 false 而不是抛出', async () => {
    const h = await hashPassword('Correct-horse-42');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 'Correct-horse-42')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword(h, 'x'.repeat(300))).toBe(false);
  });

  it('上一版本私钥的路径', () => {
    expect(previousKeyPath('/etc/cloudalbum/keys/jwt-es256.pem')).toBe('/etc/cloudalbum/keys/jwt-es256.prev.pem');
    expect(previousKeyPath('/x/key')).toBe('/x/key.prev');
  });
});
