/**
 * scripts/module hook of dns (wave1-prep: empty; filled by the dns implementer). Contract: ./types.ts.
 * Design: docs/modules/01-edge-network-scaling.md#dns (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - --domain is required (prerequisite domain): without it plan() returns missing [{ prerequisite: 'domain', ... }] with a clear hint
 *   - --zone-id / CreateHostedZone, --target eip|alb|cloudfront (default: cdn -> cloudfront, else load-balancer -> alb, else eip)
 *   - new hosted zone: print the NS records and wait for the delegation (dig NS); disable: remind about dangling NS delegations
 */
import type { ModuleHook } from './types.js';

export const dnsHook: ModuleHook = {
  id: 'dns',
};
