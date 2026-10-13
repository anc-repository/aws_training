// backend/src/adapters/waf/aws.ts —— BlocklistPort 的 `aws` 驱动（AWS WAF）
// 本轮未实现
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「后续版本（本轮 MVP 不实现；配置该驱动会被 config/implemented.ts 以 CFG-001 拒绝）」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { BlocklistPort } from '../../ports/blocklist.js';
import { notImplemented } from '../../errors.js';

export class AwsBlocklist implements BlocklistPort {
  readonly meta: AdapterMeta = { module: 'waf', driver: 'aws', awsService: 'AWS WAF', authoritative: false };

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('AwsBlocklist', 'probe', 'waf');
  }

  async add(_cidr: string, _reason: string, _ttlSec?: number): Promise<void> {
    throw notImplemented('AwsBlocklist', 'add', 'waf');
  }

  async remove(_cidr: string): Promise<void> {
    throw notImplemented('AwsBlocklist', 'remove', 'waf');
  }

  async list(): Promise<Array<{ cidr: string; reason: string; addedAt: string; source: 'app' | 'fail2ban' | 'manual' }>> {
    throw notImplemented('AwsBlocklist', 'list', 'waf');
  }
}
