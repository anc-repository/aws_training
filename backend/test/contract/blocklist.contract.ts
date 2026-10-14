// BlocklistPort 的契约（waf：nginx / aws 都要满足；wave1-waf）。两种驱动都以 security/denylist.conf 为唯一来源：
// add 之后 list 能看到、remove 之后消失；非法地址 400；到期条目不出现在 list 中；文件格式能通过 denylist-apply.sh 的逐行校验。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BlocklistPort } from '../../src/ports/blocklist.js';

export interface BlocklistFixture {
  port: BlocklistPort;
  dataDir: string;
  cleanup?: () => Promise<void>;
}

const V4 = /^\s*([0-9]{1,3}\.){3}[0-9]{1,3}(\/([0-9]|[12][0-9]|3[0-2]))?\s+1;\s*(#.*)?$/;
const V6 = /^\s*[0-9A-Fa-f]*:[0-9A-Fa-f:]*(\/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))?\s+1;\s*(#.*)?$/;

export function describeBlocklistContract(driver: 'nginx' | 'aws', make: () => Promise<BlocklistFixture>): void {
  describe(`BlocklistPort 契约 · ${driver}`, () => {
    it('meta：module=waf、非权威端口、驱动名 = WAF_MODE', async () => {
      const { port, cleanup } = await make();
      expect(port.meta).toMatchObject({ module: 'waf', driver, authoritative: false });
      await cleanup?.();
    });

    it('add → list → remove；同一地址重复 add 只保留一条；非法地址 400', async () => {
      const { port, cleanup } = await make();
      await port.add('198.51.100.0/24', '扫描器', undefined);
      await port.add('192.0.2.1', '演示', 3600);
      await port.add('192.0.2.1', '演示（第二次）', 3600);
      const list = await port.list();
      expect(list.map((e) => e.cidr)).toEqual(['198.51.100.0/24', '192.0.2.1']);
      expect(list[1]).toMatchObject({ source: 'app', reason: '演示（第二次）' });
      expect(Date.parse(list[1]!.addedAt)).not.toBeNaN();
      await expect(port.add('not-an-ip', 'x')).rejects.toMatchObject({ status: 400 });
      await port.remove('198.51.100.0/24');
      expect((await port.list()).map((e) => e.cidr)).toEqual(['192.0.2.1']);
      await cleanup?.();
    });

    it('denylist.conf 只有 `<IP/CIDR> 1;` 加注释（注释里的分号、换行、引号被清掉，防止注入 Nginx 指令）', async () => {
      const { port, dataDir, cleanup } = await make();
      await port.add('203.0.113.7', 'x; } include /etc/passwd; #\n"', undefined);
      await port.add('2001:db8::1', 'ipv6', undefined);
      const text = readFileSync(path.join(dataDir, 'security', 'denylist.conf'), 'utf8');
      for (const line of text.split('\n')) expect(/^\s*(#.*)?$/.test(line) || V4.test(line) || V6.test(line), line).toBe(true);
      expect(text.split('\n').filter((l) => l.includes('203.0.113.7'))).toHaveLength(1);
      await cleanup?.();
    });

    it('probe() 返回 ok / degraded / error 之一，并带 detail', async () => {
      const { port, cleanup } = await make();
      const r = await port.probe();
      expect(['ok', 'degraded', 'error']).toContain(r.status);
      expect(r.detail.length).toBeGreaterThan(0);
      await cleanup?.();
    });
  });
}
