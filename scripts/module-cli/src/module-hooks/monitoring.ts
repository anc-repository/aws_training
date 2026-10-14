/**
 * scripts/module hook of monitoring (wave1-prep: empty; filled by the monitoring implementer). Contract: ./types.ts.
 * Design: docs/modules/05-ops-observability.md#monitoring (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - --param AlertEmail=<address> (stack parameter) and the confirm-email prerequisite
 *   - IAM_CREDENTIALS=keys: the Agent fragment is refused (05 convention 2), note it; baseParams DetailedMonitoring from ${Param.DetailedMonitoring}
 */
import type { ModuleHook } from './types.js';

export const monitoringHook: ModuleHook = {
  id: 'monitoring',
};
