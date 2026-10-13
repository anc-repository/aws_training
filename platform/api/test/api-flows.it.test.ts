/**
 * API flows against DynamoDB Local (01 §7 keys, conditional writes, transactions, GSI1 / sparse GSI2 for real).
 * Runs when CLOUDALBUM_IT=1 or ATL_IT=1 (`npm run platform:db:up` first); each runtime gets its own table.
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterAll, describe } from 'vitest';
import { ATL_MAIN_SPEC } from '@atl/shared';
import { createDocumentClient } from '../src/aws/deps.js';
import { loadDevConfig } from '../src/dev/config.js';
import { assertLocalEndpoint } from '../src/dev/create-tables.js';
import { createApiTestRuntime } from './api-support/api-runtime.js';
import { defineApiScenarios } from './api-support/api-scenarios.js';

const enabled = process.env.CLOUDALBUM_IT === '1' || process.env.ATL_IT === '1';

describe.skipIf(!enabled)('DynamoDB Local', () => {
  const cfg = loadDevConfig();
  assertLocalEndpoint(cfg.ddbEndpoint);
  const raw = new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, credentials: { accessKeyId: 'dev', secretAccessKey: 'dev' } });
  const db = createDocumentClient(raw);
  const created: string[] = [];
  let n = 0;

  afterAll(async () => {
    for (const t of created) await raw.send(new DeleteTableCommand({ TableName: t })).catch(() => undefined);
  });

  defineApiScenarios('DynamoDB Local', async (ext) => {
    const tableName = `atl-main-it-${process.pid}-${Date.now().toString(36)}-${++n}`;
    const { ttlAttribute: _ttl, ...spec } = ATL_MAIN_SPEC;
    await raw.send(new CreateTableCommand({ ...(spec as unknown as ConstructorParameters<typeof CreateTableCommand>[0]), TableName: tableName }));
    created.push(tableName);
    return createApiTestRuntime({ db, tableName, ...(ext ? { ext } : {}) });
  });
});
