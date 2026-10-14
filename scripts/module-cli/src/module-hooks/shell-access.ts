/**
 * scripts/module hook of shell-access (wave1-prep: empty; filled by the shell-access implementer). Contract: ./types.ts.
 * Design: docs/modules/05-ops-observability.md#shell-access (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - write SHELL_ACCESS_KEEP_SSH=false|true explicitly (registry baseParams SshIngressCidr '' applies only when it is false)
 *   - preflight ssm-session-preferences (back up the region singleton document SSM-SessionManagerRunShell before changing it) and policy-quota
 *   - the instance must be Online in SSM before port 22 closes (the delivery channel switches to SSM after this module, context.ts)
 *   - disable: keep SshIngressCidr closed unless --reopen-ssh (beforeDisable returns keepBaseParams: ['SshIngressCidr'])
 */
import type { ModuleHook } from './types.js';

export const shellAccessHook: ModuleHook = {
  id: 'shell-access',
};
