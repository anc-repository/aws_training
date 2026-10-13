// backend/src/ports/blocklist.ts   （waf 模块；总纲 §4.2，照录）
import type { Adapter } from './common.js';

export interface BlocklistPort extends Adapter {                   // waf：nginx | aws（两者都写 denylist.conf；aws 再同步到 WAF IP 集合）
  add(cidr: string, reason: string, ttlSec?: number): Promise<void>;
  remove(cidr: string): Promise<void>;
  list(): Promise<Array<{ cidr: string; reason: string; addedAt: string; source: 'app' | 'fail2ban' | 'manual' }>>;
}
