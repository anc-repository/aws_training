/**
 * 01 §7.1: “键构造只允许出现在 platform/api/src/data/keys.ts 一个文件中”. The builders themselves live in
 * `@atl/shared` (shared with tools and tests, platform-scaffold decision); this file is the API's single import point.
 * Repositories import keys from here, never from string literals.
 */
export {
  Keys,
  Gsi1,
  Gsi2,
  SkPrefix,
  eventRange,
  auditMonth,
  SWEEP_GSI2_PARTITIONS,
  MANUAL_GSI2_PARTITIONS,
  TTL_ATTRIBUTE,
  TTL_POLICY,
  ttlEpochSeconds,
  ttlAfterHours,
  RESOURCE_KEY_RE,
  type PrimaryKey,
  type Gsi1Key,
  type Gsi2Key,
  type LabSessionGsi2Input,
} from '@atl/shared';
export { resourceKey } from '@atl/shared/node';
