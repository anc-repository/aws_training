/**
 * DynamoDB repositories of `atl-main` (01 §7). Every key comes from `data/keys.ts`; no repository concatenates key
 * strings. `createRepositories(deps)` is cheap (no I/O) and can be called per request.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AuditRepo, IdempotencyRepo } from './audit.js';
import { CertificatesRepo } from './certificates.js';
import { EnvironmentsRepo } from './environments.js';
import { EventsRepo, sharedUlids, type MonotonicUlid } from './events.js';
import { PlatformRepo } from './platform.js';
import { SessionsRepo } from './sessions.js';
import { Table } from './table.js';
import { UsersRepo } from './users.js';

export interface Repositories {
  table: Table;
  platform: PlatformRepo;
  sessions: SessionsRepo;
  events: EventsRepo;
  users: UsersRepo;
  environments: EnvironmentsRepo;
  certificates: CertificatesRepo;
  audit: AuditRepo;
  idempotency: IdempotencyRepo;
  ulids: MonotonicUlid;
}

export function createRepositories(db: DynamoDBDocumentClient, tableName: string, opts: { auditRetentionDays?: number; ulids?: MonotonicUlid } = {}): Repositories {
  const table = new Table(db, tableName);
  const ulids = opts.ulids ?? sharedUlids;
  const events = new EventsRepo(table, ulids);
  return {
    table,
    platform: new PlatformRepo(table),
    sessions: new SessionsRepo(table, events),
    events,
    users: new UsersRepo(table),
    environments: new EnvironmentsRepo(table),
    certificates: new CertificatesRepo(table),
    audit: new AuditRepo(table, ulids, opts.auditRetentionDays),
    idempotency: new IdempotencyRepo(table),
    ulids,
  };
}

export * from './table.js';
export * from './transactions.js';
export * from './events.js';
export * from './sessions.js';
export * from './platform.js';
export * from './users.js';
export * from './environments.js';
export * from './certificates.js';
export * from './audit.js';
