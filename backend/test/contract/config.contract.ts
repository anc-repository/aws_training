// ConfigPort 契约：运行时热键（D7）。file 与 ssm 驱动都要满足。
import { describe, expect, it } from 'vitest';
import type { ConfigPort } from '../../src/ports/config.js';

export interface ConfigFixture {
  port: ConfigPort;
  /** 修改一个热键（file：改写 runtime.json；ssm：PutParameter 的 mock） */
  setMaxUploadMb(mb: number): Promise<void>;
  cleanup?: () => Promise<void>;
}

export function describeConfigContract(driver: string, make: () => Promise<ConfigFixture>): void {
  describe(`ConfigPort 契约 · ${driver}`, () => {
    it('meta：module=config、非权威端口', async () => {
      const f = await make();
      expect(f.port.meta).toMatchObject({ module: 'config', driver, authoritative: false });
      await f.cleanup?.();
    });

    it('current() 同步返回完整的 RuntimeConfig 快照（全部键、正确类型）', async () => {
      const f = await make();
      await f.port.init?.();
      const rc = f.port.current();
      expect(typeof rc.maintenanceMode).toBe('boolean');
      expect(typeof rc.readOnly).toBe('boolean');
      expect(rc.maxUploadMb).toBeGreaterThan(0);
      expect(Array.isArray(rc.allowedEmailDomains)).toBe(true);
      expect(typeof rc.feedCacheTtlSec).toBe('number');
      expect(typeof rc.labBypassEnabled).toBe('boolean');
      expect(['debug', 'info', 'warn', 'error']).toContain(rc.logLevel);
      expect(typeof rc.featureFlags).toBe('object');
      await f.port.close?.();
      await f.cleanup?.();
    });

    it('refresh() 拿到新值，并通知 onChange 订阅者（changedKeys）', async () => {
      const f = await make();
      await f.port.init?.();
      const seen: string[][] = [];
      const off = f.port.onChange((_next, keys) => seen.push(keys));
      await f.setMaxUploadMb(7);
      const r = await f.port.refresh();
      expect(r.changedKeys).toContain('maxUploadMb');
      expect(f.port.current().maxUploadMb).toBe(7);
      expect(seen.some((k) => k.includes('maxUploadMb'))).toBe(true);
      off();
      await f.port.close?.();
      await f.cleanup?.();
    });

    it('describeSource() 给出驱动、位置、最近加载时间与版本', async () => {
      const f = await make();
      await f.port.init?.();
      const src = f.port.describeSource();
      expect(src.driver).toBe(driver);
      expect(src.location).toBeTruthy();
      expect(Date.parse(src.lastLoadedAt)).not.toBeNaN();
      await f.port.close?.();
      await f.cleanup?.();
    });
  });
}
