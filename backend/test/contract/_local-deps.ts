// 契约测试的装配辅助：真实的分层配置（临时 /etc/cloudalbum）+ 迁移过的 SQLite + AdapterDeps
import path from 'node:path';
import type { Knex } from 'knex';
import { lazyAwsClients } from '../../src/adapters/aws/clients.js';
import type { AdapterDeps } from '../../src/adapters/types.js';
import { validateConfig } from '../../src/config/validate.js';
import { createKnex, migrateLatest } from '../../src/db/knex.js';
import { LabMetricsStore } from '../../src/observability/lab-metrics.js';
import { l0EnvDir } from '../helpers/identity-harness.js';

export interface LocalDeps {
  deps: AdapterDeps;
  db: Knex;
  envDir: string;
  dataDir: string;
  close(): Promise<void>;
}

export async function makeLocalDeps(opts: Parameters<typeof l0EnvDir>[0] & { role?: 'api' | 'worker' | 'cli' } = {}): Promise<LocalDeps> {
  const { envDir, dataDir } = l0EnvDir(opts);
  const role = opts.role ?? 'api';
  const v = await validateConfig({ role, envDir, processEnv: { NODE_ENV: 'test' } });
  if (!v.parsed.config) throw new Error(`config invalid: ${JSON.stringify(v.parsed.errors)}`);
  const cfg = v.parsed.config;
  const db = await createKnex(cfg, undefined, { sqliteFilename: path.join(dataDir, 'db', 'contract.sqlite') });
  await migrateLatest(db);
  const deps: AdapterDeps = {
    cfg, env: v.layers.merged, aws: lazyAwsClients({ region: cfg.core.AWS_REGION, credentials: null }), role, db, dbRead: db,
    labMetrics: new LabMetricsStore({ role, dataDir }),
  };
  return { deps, db, envDir, dataDir, close: () => db.destroy() };
}
