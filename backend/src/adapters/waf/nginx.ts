// backend/src/adapters/waf/nginx.ts —— BlocklistPort 的 `nginx` 驱动（本地实现）
// 写 CLOUDALBUM_DATA_DIR/security/denylist.conf（临时文件 + rename），path 单元校验后 reload Nginx
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { BlocklistPort } from '../../ports/blocklist.js';
import { notImplemented } from '../../errors.js';

export class NginxBlocklist implements BlocklistPort {
  readonly meta: AdapterMeta = { module: 'waf', driver: 'nginx', awsService: null, authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('NginxBlocklist', 'probe', 'waf');
  }

  async add(_cidr: string, _reason: string, _ttlSec?: number): Promise<void> {
    throw notImplemented('NginxBlocklist', 'add', 'waf');
  }

  async remove(_cidr: string): Promise<void> {
    throw notImplemented('NginxBlocklist', 'remove', 'waf');
  }

  async list(): Promise<Array<{ cidr: string; reason: string; addedAt: string; source: 'app' | 'fail2ban' | 'manual' }>> {
    throw notImplemented('NginxBlocklist', 'list', 'waf');
  }
}
