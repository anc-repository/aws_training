/**
 * scripts/module hook of waf (wave1-prep: empty; filled by the waf implementer). Contract: ./types.ts.
 * Design: docs/modules/01-edge-network-scaling.md#waf (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - stacks: edge in us-east-1 (CLOUDFRONT scope, when cdn), regional (when load-balancer; only with --also-regional when edge exists)
 *   - the CloudFront association goes through the registry inject WebAclArn -> cdn (WAF_SCOPE=CLOUDFRONT); write WAF_SCOPE explicitly
 *   - afterDeploy: first full import of security/denylist.conf into the IP set (scripts/waf/sync-denylist)
 */
import type { ModuleHook } from './types.js';

export const wafHook: ModuleHook = {
  id: 'waf',
};
