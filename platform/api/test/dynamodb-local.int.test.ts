/**
 * DynamoDB Local integration (ATL_IT=1, `npm run platform:db:up` first): the tables of 01 §7.1 / §3.11 and the key
 * builders work end to end — base table, both GSIs (including the sparse GSI2) and the lock-table conditional write.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { envLockKey, Gsi1, Gsi2, Keys, ATL_MAIN_TABLE, LAB_LOCKS_TABLE } from '@atl/shared';
import { createDocumentClient } from '../src/aws/deps.js';
import { loadDevConfig } from '../src/dev/config.js';
import { assertLocalEndpoint, createTables } from '../src/dev/create-tables.js';

const cfg = loadDevConfig();
assertLocalEndpoint(cfg.ddbEndpoint);
const raw = new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, credentials: { accessKeyId: 'dev', secretAccessKey: 'dev' } });
const db = createDocumentClient(raw);
const SID = 's4k7m2q9x1abc';

describe('DynamoDB Local: atl-main and cloudalbum-lab-locks', () => {
  it('creates the tables idempotently', async () => {
    await createTables(raw);
    expect(await createTables(raw)).toEqual([]);
  });

  it('stores a session with GSI1 / GSI2 keys and finds it through both indexes', async () => {
    const now = '2026-10-13T05:00:00.000Z';
    await db.send(
      new PutCommand({
        TableName: ATL_MAIN_TABLE,
        Item: {
          ...Keys.labSession(SID),
          ...Gsi1.labSession('sub-1', now, SID),
          ...Gsi2.labSession({ sid: SID, state: 'RUNNING', stateEnteredAt: now, deadlineAt: '2026-10-13T07:00:00.000Z' }),
          type: 'LabSession',
          ver: 1,
          state: 'RUNNING',
          labId: 'svc-ec2',
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const got = await db.send(new GetCommand({ TableName: ATL_MAIN_TABLE, Key: Keys.labSession(SID), ConsistentRead: true }));
    expect(got.Item?.state).toBe('RUNNING');
    const mine = await db.send(
      new QueryCommand({
        TableName: ATL_MAIN_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :p)',
        ExpressionAttributeValues: { ':pk': 'USER#sub-1', ':p': 'SESSION#' },
        ScanIndexForward: false,
      }),
    );
    expect(mine.Items?.map((i) => i.SK)).toContain('META');
    const running = await db.send(
      new QueryCommand({ TableName: ATL_MAIN_TABLE, IndexName: 'GSI2', KeyConditionExpression: 'GSI2PK = :pk', ExpressionAttributeValues: { ':pk': 'STATE#RUNNING' } }),
    );
    expect(running.Items?.[0]).toMatchObject({ state: 'RUNNING', labId: 'svc-ec2' }); // INCLUDE projection
  });

  it('lock table: conditional acquire (attribute_not_exists OR lease expired)', async () => {
    const key = envLockKey('e6c0d1e2');
    const put = (holder: string, now: string, leaseUntil: string) =>
      db.send(
        new PutCommand({
          TableName: LAB_LOCKS_TABLE,
          Item: { lockKey: key, holder, holderArn: `arn:${holder}`, op: 'enable', acquiredAt: now, leaseUntil, ver: 1 },
          ConditionExpression: 'attribute_not_exists(lockKey) OR leaseUntil < :now',
          ExpressionAttributeValues: { ':now': now },
        }),
      );
    await db.send(new PutCommand({ TableName: LAB_LOCKS_TABLE, Item: { lockKey: key, holder: 'old', leaseUntil: '2000-01-01T00:00:00Z' } }));
    await put(`atl-${SID}-ws`, '2026-10-13T05:00:00Z', '2026-10-13T05:05:00Z');
    await expect(put(`atl-${SID}-prov-module-op`, '2026-10-13T05:01:00Z', '2026-10-13T05:06:00Z')).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
  });
});
