/**
 * Narrow ports of atl-custom-resources: only the calls the handlers make. Production implementations are in aws-ports.ts
 * (AWS SDK v3 from the Lambda runtime); tests use in-memory fakes (test/custom-resources.test.ts).
 */
import type { FetchLike } from './cfn.js';

export interface VersionMarker {
  keyMarker?: string;
  versionIdMarker?: string;
}

export interface ObjectRef {
  key: string;
  versionId?: string;
}

export interface S3Port {
  bucketExists(bucket: string): Promise<boolean>;
  /** One page of object versions and delete markers (≤ 1000). */
  listObjectVersions(bucket: string, marker?: VersionMarker): Promise<{ items: ObjectRef[]; next?: VersionMarker }>;
  deleteObjects(bucket: string, items: ObjectRef[]): Promise<void>;
  /** `null` when the object does not exist. */
  getObject(bucket: string, key: string): Promise<Buffer | null>;
  putObject(bucket: string, key: string, body: Buffer | string, meta?: { contentType?: string; cacheControl?: string }): Promise<void>;
  listKeys(bucket: string, prefix: string): Promise<string[]>;
}

export type Item = Record<string, unknown>;

export interface TablePort {
  get(table: string, key: { PK: string; SK: string }): Promise<Item | undefined>;
  /** Returns false when `ifNotExists` is set and the item already exists. */
  put(table: string, item: Item, opts?: { ifNotExists?: boolean }): Promise<boolean>;
  /** `SET` the given top-level attributes (creates the item when missing). */
  update(table: string, key: { PK: string; SK: string }, set: Item): Promise<void>;
  /** `ADD <attr> :1` and return the new value. */
  increment(table: string, key: { PK: string; SK: string }, attr: string): Promise<number>;
  /** Query an index partition (GSI1 / GSI2), at most `limit` items. */
  queryIndex(table: string, index: 'GSI1' | 'GSI2', partition: string, limit: number): Promise<Item[]>;
}

export interface IamPort {
  listRolePolicies(role: string): Promise<string[]>;
  deleteRolePolicy(role: string, policyName: string): Promise<void>;
  listAttachedRolePolicies(role: string): Promise<string[]>;
  detachRolePolicy(role: string, policyArn: string): Promise<void>;
  listRoleTags(role: string): Promise<{ key: string; value: string }[]>;
  untagRole(role: string, keys: string[]): Promise<void>;
}

export interface StackPort {
  updateTerminationProtection(stackId: string, enable: boolean): Promise<void>;
  setStackPolicy(stackId: string, policyBody: string): Promise<void>;
}

export interface WorkflowPort {
  /** `alreadyExists` = an execution with this name exists (idempotent restart). */
  startExecution(stateMachineArn: string, name: string, input: unknown): Promise<{ executionArn: string; alreadyExists: boolean }>;
}

export interface KmsPort {
  /** DER (SubjectPublicKeyInfo) public key of an asymmetric key. */
  getPublicKey(keyId: string): Promise<{ der: Uint8Array; keySpec: string; keyArn: string }>;
}

export interface CdnPort {
  invalidate(distributionId: string, paths: string[]): Promise<void>;
}

export interface UsersPort {
  /** Create the user (temporary password e-mail) unless it exists, then add it to the group. */
  ensureUser(userPoolId: string, email: string, group: string): Promise<'created' | 'exists'>;
}

export interface PreflightItem {
  id: string;
  status: 'ok' | 'warn' | 'info' | 'unknown';
  detail: string;
  hint?: string;
}

export interface PreflightPort {
  run(input: { region: string; externalAccessAnalyzer: string; workstationInstanceType: string }): Promise<PreflightItem[]>;
}

export interface Ports {
  s3: S3Port;
  table: TablePort;
  iam: IamPort;
  stack: StackPort;
  workflow: WorkflowPort;
  kms: KmsPort;
  cdn: CdnPort;
  users: UsersPort;
  preflight: PreflightPort;
  fetch: FetchLike;
  now(): Date;
  log(message: string, extra?: Record<string, unknown>): void;
}
