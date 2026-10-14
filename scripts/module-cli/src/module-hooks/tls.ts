/**
 * scripts/module hook of tls (wave1-prep: empty; filled by the tls implementer). Contract: ./types.ts.
 * Design: docs/modules/01-edge-network-scaling.md#tls (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - --domain is required (prerequisite domain): without it plan() returns missing [{ prerequisite: 'domain', ... }] with a clear hint
 *   - preflight acme-endpoint (acm ListAcmeEndpoints; --no-acme skips the probe) -> TLS_ACME=on|off; off needs DEP-005 3 (dns|external + cdn|lb)
 *   - stacks: main (TLS_ACME=on), edge in us-east-1 (cdn), regional (load-balancer | social-api) from the registry; afterDeploy: wait for the
 *     domain validation, EAB (1 day) + certbot over the delivery channel, delete the EAB, record endpoint / account / certificate in state.json
 *   - platform mode: tls-preview off before the ACM path (enable.ts already calls previewOffBefore)
 */
import type { ModuleHook } from './types.js';

export const tlsHook: ModuleHook = {
  id: 'tls',
};
