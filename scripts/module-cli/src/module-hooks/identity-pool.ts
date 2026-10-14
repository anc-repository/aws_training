/**
 * scripts/module hook of identity-pool (wave1-prep: empty; filled by the identity-pool implementer). Contract: ./types.ts.
 * Design: docs/modules/02-identity-security.md#identity-pool (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - parameter switch (IDENTITY_POOL_ID from the stack output); UserPoolId / UserPoolClientId arrive through the auth injects
 *   - disable: empty the staging bucket and abort unfinished multipart uploads before the stack is deleted
 */
import type { ModuleHook } from './types.js';

export const identityPoolHook: ModuleHook = {
  id: 'identity-pool',
};
