/**
 * scripts/module hook of notification (wave1-prep: empty; filled by the notification implementer). Contract: ./types.ts.
 * Design: docs/modules/04-compute-async.md#notification (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - prerequisite confirm-email: tell the operator that every e-mail subscription must be confirmed (plan note)
 *   - migration scripts/migrate/notification (generic step 6) creates / removes the subscriptions of users with e-mail notification on
 */
import type { ModuleHook } from './types.js';

export const notificationHook: ModuleHook = {
  id: 'notification',
};
