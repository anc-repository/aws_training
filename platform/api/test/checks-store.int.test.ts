/**
 * DynamoDB Local integration (ATL_IT=1): the ItemStore used by atl-checks / atl-certs — conditional whole-item writes on
 * `ver`, prefix and GSI1 queries, `undefined` stripping — and a certificate issued + revoked through it. Uses its own
 * table (`atl-main-checks-it-<n>`) so it never touches the shared dev table.
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATL_MAIN_SPEC, WebKeys, type PlatformPorts } from '@atl/shared';
import { createDocumentClient } from '../src/aws/deps.js';
import { Gsi1, Keys } from '../src/data/keys.js';
import { loadDevConfig } from '../src/dev/config.js';
import { assertLocalEndpoint } from '../src/dev/create-tables.js';
import { LocalEcdsaSigner } from '../src/dev/adapters/signer.js';
import { loadPlatformEnv } from '../src/runtime/env.js';
import { issueCertificate, latestRevocationList, revokeCertificate } from '../src/services/certificates/service.js';
import { ConflictError, DynamoItemStore, mutate } from '../src/services/progress/store.js';
import { MemoryObjects, TestClock } from './checks-support/memory.js';
import { NO_DB, tmpDir } from './helpers.js';

const cfg = loadDevConfig();
assertLocalEndpoint(cfg.ddbEndpoint);
const raw = new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, credentials: { accessKeyId: 'dev', secretAccessKey: 'dev' } });
const db = createDocumentClient(raw);
const TABLE = `atl-main-checks-it-${process.pid}`;
const store = new DynamoItemStore(db, TABLE);

beforeAll(async () => {
  const { ttlAttribute: _t, ...spec } = ATL_MAIN_SPEC;
  await raw.send(new CreateTableCommand({ ...spec, TableName: TABLE } as never));
});

afterAll(async () => {
  await raw.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
});

describe('DynamoItemStore on DynamoDB Local', () => {
  it('conditional puts, mutate with retries, prefix and GSI1 queries', async () => {
    const key = Keys.stepResult('s4k7m2q9x1abc', 'enable-cdn');
    await store.put({ ...key, type: 'StepResult', ver: 1, state: 'available', nested: { a: undefined, b: 1 } }, { expectVer: null });
    await expect(store.put({ ...key, ver: 1 }, { expectVer: null })).rejects.toBeInstanceOf(ConflictError);
    await expect(store.put({ ...key, ver: 9 }, { expectVer: 5 })).rejects.toBeInstanceOf(ConflictError);
    const updated = await mutate<{ state: string }>(store, key, (cur) => ({ ...(cur as object), state: 'done' }) as never);
    expect(updated).toMatchObject({ state: 'done', ver: 2 });
    expect(await store.get(key)).toMatchObject({ nested: { b: 1 } });
    const steps = await store.query(Keys.labSession('s4k7m2q9x1abc').PK, { skPrefix: 'STEP#' });
    expect(steps).toHaveLength(1);
    await store.put({ ...Keys.certificate('ATL-AAAA-BBBB-CCCC-DDDD'), ...Gsi1.certificate('u-1', '2026-10-13T00:00:00Z', 'ATL-AAAA-BBBB-CCCC-DDDD'), ver: 1, status: 'valid' });
    expect(await store.query(Keys.userProfile('u-1').PK, { index: 'GSI1', skPrefix: 'CERT#' })).toHaveLength(1);
  });

  it('issues and revokes a card certificate end to end', async () => {
    const objects = new MemoryObjects();
    const deps = {
      ports: { clock: new TestClock(), signer: new LocalEcdsaSigner(tmpDir('it-keys-')), objects } as unknown as PlatformPorts,
      db: NO_DB,
      env: { ...loadPlatformEnv({ AWS_REGION: 'ap-northeast-1' }), signingKeyId: 'it-key' },
    };
    const sid = 's4k7m2q9x1abd';
    const now = new Date().toISOString();
    await store.put({ ...Keys.platformConfig(), ver: 1, installationId: 'inst', platformUrl: 'https://d1.cloudfront.net' });
    await store.put({ ...Keys.labProgress('u-2', 'svc-ec2'), ver: 1, labId: 'svc-ec2', badge: { level: 'verified', status: 'valid', attemptId: sid, labVersion: '1.0.0', earnedAt: now, evidenceScore: 1, variant: 'default' } });
    await store.put({ ...Keys.labAttempt(sid), ver: 1, catalogVersion: '2026.10.0', completedAt: now, checksSummary: { auto: 4, manual: 0 } });
    await store.put({ ...Keys.labSession(sid), ver: 1, sid, catalogVersion: '2026.10.0', region: 'ap-northeast-1' });
    await objects.put(deps.env.buckets.web, `${WebKeys.content('2026.10.0')}labs/svc-ec2.json`, JSON.stringify({ lab: { title: 'Amazon EC2：基线', certificate: { enabled: true }, saa: { domains: ['resilient'] } } }));
    const c = { deps, store, nowIso: now, invalidate: async () => undefined };
    const { certificate } = await issueCertificate(c, { sub: 'u-2', scope: 'lab', labId: 'svc-ec2' });
    expect(certificate.scope).toBe('lab');
    await revokeCertificate(c, certificate.certId, 'misissued');
    expect((await latestRevocationList(store))!.entries[0]!.certId).toBe(certificate.certId);
  });
});
