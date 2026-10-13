// SecretsPort 契约（总纲 §4.2 + §11 test/contract/<port>.contract.ts）：同一套断言跑该端口的每个驱动。
// 本轮只有 env 驱动；secretsmanager 实现后用 aws-sdk-client-mock / LocalStack 提供 make()。
import { describe, expect, it } from 'vitest';
import type { SecretName, SecretsPort } from '../../src/ports/secrets.js';

export interface SecretsFixture {
  port: SecretsPort;
  /** 已配置的逻辑名 → 期望值（文件型机密为文件内容） */
  present: Partial<Record<SecretName, string>>;
  /** 未配置的逻辑名 */
  missing: SecretName;
  cleanup?: () => Promise<void>;
}

export function describeSecretsContract(driver: string, make: () => Promise<SecretsFixture>): void {
  describe(`SecretsPort 契约 · ${driver}`, () => {
    it('meta：module=secrets、权威端口、driver = 开关取值', async () => {
      const f = await make();
      expect(f.port.meta).toMatchObject({ module: 'secrets', driver, authoritative: true });
      await f.cleanup?.();
    });

    it('get() 按逻辑名返回已配置的值', async () => {
      const f = await make();
      for (const [name, value] of Object.entries(f.present) as Array<[SecretName, string]>) {
        expect(await f.port.get(name), name).toBe(value);
      }
      await f.cleanup?.();
    });

    it('get() 未配置的机密被拒绝（不返回空串冒充）', async () => {
      const f = await make();
      await expect(f.port.get(f.missing)).rejects.toThrow();
      await f.cleanup?.();
    });

    it('describe() 给出来源与 origin，不含值', async () => {
      const f = await make();
      const name = Object.keys(f.present)[0] as SecretName;
      const d = await f.port.describe(name);
      expect(['env', 'secretsmanager']).toContain(d.source);
      expect(['instance', 'bundle', 'aws']).toContain(d.origin);
      expect(JSON.stringify(d)).not.toContain(f.present[name]!.slice(0, 12));
      await f.cleanup?.();
    });

    it('onRotate() 返回注销函数', async () => {
      const f = await make();
      const off = f.port.onRotate(Object.keys(f.present)[0] as SecretName, () => undefined);
      expect(typeof off).toBe('function');
      off();
      await f.cleanup?.();
    });

    it('probe() 返回 ok | degraded | error 与一行 detail', async () => {
      const f = await make();
      const r = await f.port.probe();
      expect(['ok', 'degraded', 'error']).toContain(r.status);
      expect(typeof r.detail).toBe('string');
      await f.cleanup?.();
    });
  });
}
