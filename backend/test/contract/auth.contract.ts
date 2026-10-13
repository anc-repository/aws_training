// AuthPort 契约：local 与 cognito 驱动都要满足（cognito 用 aws-sdk-client-mock 提供 make()）。
// 只覆盖两种驱动共有的语义：publicConfig、verifyAccessToken 拒绝无效令牌（401）、jwks 形状、探针、Migratable。
import { describe, expect, it } from 'vitest';
import type { AuthPort } from '../../src/ports/auth.js';

export interface AuthFixture {
  port: AuthPort;
  /** 由该驱动签发、属于某个已存在用户的有效访问令牌（可选：cognito 的 mock 可能不提供） */
  validToken?: () => Promise<{ token: string; subject: string; email: string }>;
  cleanup?: () => Promise<void>;
}

export function describeAuthContract(driver: 'local' | 'cognito', make: () => Promise<AuthFixture>): void {
  describe(`AuthPort 契约 · ${driver}`, () => {
    it('meta：module=auth、权威端口、driver = AUTH_DRIVER', async () => {
      const f = await make();
      expect(f.port.meta).toMatchObject({ module: 'auth', driver, authoritative: true });
      await f.cleanup?.();
    });

    it('publicConfig()：driver、密码策略、MFA 模式（经 /api/capabilities 下发给前端）', async () => {
      const f = await make();
      const pc = f.port.publicConfig();
      expect(pc.driver).toBe(driver);
      expect(pc.passwordPolicy.minLength).toBeGreaterThanOrEqual(6);
      expect(['off', 'optional', 'required']).toContain(pc.mfa);
      await f.cleanup?.();
    });

    it('verifyAccessToken() 拒绝垃圾、被篡改的令牌（401）', async () => {
      const f = await make();
      for (const bad of ['', 'garbage', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.']) {
        await expect(f.port.verifyAccessToken(bad)).rejects.toMatchObject({ status: 401 });
      }
      if (f.validToken) {
        const { token } = await f.validToken();
        const parts = token.split('.');
        const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
        payload.groups = ['admin'];
        const forged = [parts[0], Buffer.from(JSON.stringify(payload)).toString('base64url'), parts[2]].join('.');
        await expect(f.port.verifyAccessToken(forged)).rejects.toMatchObject({ status: 401 });
      }
      await f.cleanup?.();
    });

    it('verifyAccessToken() 接受有效令牌并返回 Principal（provider、subject、email、groups、plan、expiresAt=epoch 秒）', async () => {
      const f = await make();
      if (!f.validToken) return;
      const { token, subject, email } = await f.validToken();
      const p = await f.port.verifyAccessToken(token);
      expect(p).toMatchObject({ provider: driver, subject, email });
      expect(Array.isArray(p.groups)).toBe(true);
      expect(typeof p.plan).toBe('string');
      expect(p.expiresAt).toBeGreaterThan(Date.now() / 1000);
      expect(p.expiresAt).toBeLessThan(Date.now() / 1000 + 86_400);
      await f.cleanup?.();
    });

    it('jwks()：local 发布公钥（无私钥参数），cognito 为 null', async () => {
      const f = await make();
      await f.port.init?.();
      const jwks = f.port.jwks();
      if (driver === 'cognito') expect(jwks).toBeNull();
      else {
        expect(jwks!.keys.length).toBeGreaterThanOrEqual(1);
        for (const k of jwks!.keys) {
          expect(k.kid).toBeTruthy();
          expect(k.d).toBeUndefined();
        }
      }
      await f.cleanup?.();
    });

    it('Migratable：count() 与 exportBatch() 的形状', async () => {
      const f = await make();
      expect(typeof (await f.port.count())).toBe('number');
      const page = await f.port.exportBatch(undefined, 10);
      expect(Array.isArray(page.items)).toBe(true);
      for (const it of page.items) expect(it).toEqual(expect.objectContaining({ subject: expect.any(String), email: expect.any(String) }));
      await f.cleanup?.();
    });

    it('probe()', async () => {
      const f = await make();
      await f.port.init?.();
      const r = await f.port.probe();
      expect(['ok', 'degraded', 'error']).toContain(r.status);
      expect(typeof r.detail).toBe('string');
      await f.cleanup?.();
    });
  });
}
