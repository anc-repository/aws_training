/**
 * scripts/module hook of cost (wave1-prep: empty; filled by the cost implementer). Contract: ./types.ts.
 * Design: docs/modules/06-governance-cost.md#cost (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - ProjectBudgetLimit / AccountBudgetLimit are required stack parameters without defaults: ask in the confirmation step, never suggest an amount (D14)
 *   - preflight cost-allocation-tag-active (ce:ListCostAllocationTags; activation is a platform action in platform mode) and policy-quota
 */
import type { ModuleHook } from './types.js';

export const costHook: ModuleHook = {
  id: 'cost',
};
