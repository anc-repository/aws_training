/**
 * scripts/module hook of logging (wave1-prep: empty; filled by the logging implementer). Contract: ./types.ts.
 * Design: docs/modules/05-ops-observability.md#logging (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - LOG_CW_SHIPPER=agent needs IAM_CREDENTIALS=role (05 convention 2): refuse with keys, the cwAgentFragment is only delivered for agent
 */
import type { ModuleHook } from './types.js';

export const loggingHook: ModuleHook = {
  id: 'logging',
};
