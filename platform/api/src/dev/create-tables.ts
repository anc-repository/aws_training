/**
 * Create `atl-main` and `cloudalbum-lab-locks` in DynamoDB Local with the key schema of 01 §7.1 / §3.11
 * (`TABLE_SPECS` in @atl/shared). Idempotent.
 *
 *   npm run platform:db:up        # docker compose -f docker-compose.platform.yml up -d
 *   npm run platform:db:init      # this script (add -- --reset to drop and recreate, -- --seed for a dev PlatformConfig)
 *
 * Never point it at a real AWS endpoint: it refuses endpoints that are not localhost.
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { INSTALL_DEFAULTS, Keys, TABLE_SPECS, type TableSpec } from '@atl/shared';
import { createDocumentClient } from '../aws/deps.js';
import { loadDevConfig } from './config.js';

export function assertLocalEndpoint(endpoint: string): void {
  const host = new URL(endpoint).hostname;
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) && !host.endsWith('.localhost')) {
    throw new Error(`refusing to touch a non-local DynamoDB endpoint: ${endpoint}`);
  }
}

async function exists(ddb: DynamoDBClient, name: string): Promise<boolean> {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (e) {
    if (e instanceof ResourceNotFoundException || (e as { name?: string }).name === 'ResourceNotFoundException') return false;
    throw e;
  }
}

async function waitActive(ddb: DynamoDBClient, name: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await ddb.send(new DescribeTableCommand({ TableName: name }));
    if (r.Table?.TableStatus === 'ACTIVE') return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`table ${name} did not become ACTIVE`);
}

export async function createTables(ddb: DynamoDBClient, opts: { reset?: boolean; log?: (s: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const created: string[] = [];
  for (const spec of TABLE_SPECS) {
    const { ttlAttribute, ...input }: TableSpec = spec;
    if (opts.reset && (await exists(ddb, spec.TableName))) {
      await ddb.send(new DeleteTableCommand({ TableName: spec.TableName }));
      log(`deleted ${spec.TableName}`);
    }
    if (await exists(ddb, spec.TableName)) {
      log(`exists  ${spec.TableName}`);
      continue;
    }
    await ddb.send(new CreateTableCommand(input));
    await waitActive(ddb, spec.TableName);
    try {
      await ddb.send(new UpdateTimeToLiveCommand({ TableName: spec.TableName, TimeToLiveSpecification: { AttributeName: ttlAttribute, Enabled: true } }));
    } catch (e) {
      log(`ttl     ${spec.TableName}: ${(e as Error).message} (ignored)`);
    }
    created.push(spec.TableName);
    log(`created ${spec.TableName}`);
  }
  return created;
}

/** A minimal PlatformConfig so that dev code paths that read `PLATFORM / CONFIG` work (values are dev placeholders). */
export function devPlatformConfig(nowIso: string, region: string, accountId: string, port: number): Record<string, unknown> {
  return {
    ...Keys.platformConfig(),
    type: 'PlatformConfig',
    ver: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    version: '0.1.0-dev',
    installationId: '00000000-0000-4000-8000-000000000000',
    region,
    drRegion: INSTALL_DEFAULTS.DrRegion,
    platformUrl: `http://127.0.0.1:${port}`,
    agentApiEndpoint: `http://127.0.0.1:${port}`,
    workloadBoundaryArn: `arn:aws:iam::${accountId}:policy/ATLWorkloadBoundary`,
    maintenance: false,
    mode: 'NORMAL',
    limits: {
      maxSessionMinutes: INSTALL_DEFAULTS.MaxSessionMinutes,
      extension: { minutes: INSTALL_DEFAULTS.ExtensionMinutes, maxCount: INSTALL_DEFAULTS.MaxExtensions },
      maxKeepHours: INSTALL_DEFAULTS.MaxKeepHours,
      keepHardMaxHours: INSTALL_DEFAULTS.KeepHardMaxHours,
      envMaxAgeDays: INSTALL_DEFAULTS.EnvMaxAgeDays,
      readyIdleMinutes: INSTALL_DEFAULTS.ReadyIdleMinutes,
      asgMaxSizeLimit: INSTALL_DEFAULTS.AsgMaxSizeLimit,
    },
    budget: { amount: 0, enforcement: 'block-start', state: 'OK', stateAt: nowIso },
    ownership: { maxWaitMinutes: 20, hardMaxWaitMinutes: 45 },
  };
}

async function main(): Promise<void> {
  const cfg = loadDevConfig();
  assertLocalEndpoint(cfg.ddbEndpoint);
  const ddb = new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, credentials: { accessKeyId: 'dev', secretAccessKey: 'dev' } });
  const args = new Set(process.argv.slice(2));
  await createTables(ddb, { reset: args.has('--reset'), log: (s) => console.log(s) });
  if (args.has('--seed')) {
    const db = createDocumentClient(ddb);
    await db.send(new PutCommand({ TableName: 'atl-main', Item: devPlatformConfig(new Date().toISOString(), cfg.region, cfg.accountId, cfg.port) }));
    console.log('seeded  PLATFORM / CONFIG');
  }
}

if (process.argv[1] && /create-tables\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    console.error(`is DynamoDB Local running? (npm run platform:db:up; endpoint ${loadDevConfig().ddbEndpoint})`);
    process.exit(1);
  });
}
