/**
 * scripts/module hook of email (wave1-prep: empty; filled by the email implementer). Contract: ./types.ts.
 * Design: docs/modules/04-compute-async.md#email (section 6 "切换、数据迁移与回滚", section 0 registry entry, section 12 platform mode).
 * What this module needs beyond the generic flow:
 *   - prerequisite ses-identity: preflight (sesv2:GetEmailIdentity / GetAccount) that the sender identity is verified; sandbox notice
 *   - --param ForCognito=true -> EMAIL_FOR_COGNITO=on (registry injects SesIdentityArn into auth); with dns enabled the HostedZoneId inject creates DKIM / MAIL FROM records
 */
import type { ModuleHook } from './types.js';

export const emailHook: ModuleHook = {
  id: 'email',
};
