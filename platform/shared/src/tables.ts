/**
 * Table definitions — `atl-main` (01 §7.1) and the learner-accessible lock table `cloudalbum-lab-locks` (01 §3.11).
 *
 * Plain objects in the shape of DynamoDB `CreateTable` input (no SDK import), used by the dev table script
 * (`platform/api/src/dev/create-tables.ts`) and available to the infra template generator.
 */

export const ATL_MAIN_TABLE = 'atl-main';
export const LAB_LOCKS_TABLE = 'cloudalbum-lab-locks';

/** Attributes projected into GSI2 (01 §7.1). */
export const GSI2_PROJECTED_ATTRIBUTES = ['type', 'state', 'labId', 'envId', 'deadlineAt', 'cleanupState', 'severity'] as const;

export interface TableSpec {
  TableName: string;
  BillingMode: 'PAY_PER_REQUEST';
  AttributeDefinitions: { AttributeName: string; AttributeType: 'S' | 'N' | 'B' }[];
  KeySchema: { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[];
  GlobalSecondaryIndexes?: {
    IndexName: string;
    KeySchema: { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[];
    Projection: { ProjectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'; NonKeyAttributes?: string[] };
  }[];
  /** Not part of CreateTable: applied with UpdateTimeToLive afterwards. */
  ttlAttribute: string;
}

export const ATL_MAIN_SPEC: TableSpec = {
  TableName: ATL_MAIN_TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'GSI1PK', AttributeType: 'S' },
    { AttributeName: 'GSI1SK', AttributeType: 'S' },
    { AttributeName: 'GSI2PK', AttributeType: 'S' },
    { AttributeName: 'GSI2SK', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'GSI1',
      KeySchema: [
        { AttributeName: 'GSI1PK', KeyType: 'HASH' },
        { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
    {
      IndexName: 'GSI2',
      KeySchema: [
        { AttributeName: 'GSI2PK', KeyType: 'HASH' },
        { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: [...GSI2_PROJECTED_ATTRIBUTES] },
    },
  ],
  ttlAttribute: 'ttl',
};

export const LAB_LOCKS_SPEC: TableSpec = {
  TableName: LAB_LOCKS_TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [{ AttributeName: 'lockKey', AttributeType: 'S' }],
  KeySchema: [{ AttributeName: 'lockKey', KeyType: 'HASH' }],
  ttlAttribute: 'ttl',
};

export const TABLE_SPECS: readonly TableSpec[] = [ATL_MAIN_SPEC, LAB_LOCKS_SPEC];

/** Environment operation lock key in `cloudalbum-lab-locks`: `env#<envName>` (01 §3.11). */
export function envLockKey(envName: string): string {
  if (!/^e[0-9a-z]{7}$/.test(envName)) throw new TypeError(`invalid envName: ${envName}`);
  return `env#${envName}`;
}

/** Attributes of a lock item (01 §3.11); `leaseUntil` decides, `ttl` only cleans up. */
export interface EnvLockItem {
  lockKey: string;
  holderArn: string;
  holder: string;
  op: string;
  runId?: string | null;
  acquiredAt: string;
  leaseUntil: string;
  ver: number;
  ttl?: number;
}
