/**
 * Minimal item store over `atl-main` used by checks, progress, reports and certificates: whole-item reads and writes
 * with optimistic locking on `ver` (01 §7.1), queries by partition and sort-key prefix. Keys always come from
 * `data/keys.ts` (@atl/shared Keys / Gsi1). Tests use an in-memory implementation of the same interface.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PrimaryKey } from '../../data/keys.js';

export class ConflictError extends Error {
  constructor(message = 'conditional write failed') {
    super(message);
    this.name = 'ConflictError';
  }
}

export type Item = Record<string, unknown> & PrimaryKey;

export interface QueryOptions {
  skPrefix?: string;
  index?: 'GSI1' | 'GSI2';
  ascending?: boolean;
  limit?: number;
}

export interface ItemStore {
  get<T extends object = Record<string, unknown>>(key: PrimaryKey, opts?: { consistent?: boolean }): Promise<(T & PrimaryKey) | null>;
  /** `expectVer`: the stored `ver` must equal it (`null` = the item must not exist). Throws ConflictError otherwise. */
  put(item: Item, opts?: { expectVer?: number | null }): Promise<void>;
  query<T extends object = Record<string, unknown>>(pk: string, opts?: QueryOptions): Promise<(T & PrimaryKey)[]>;
  delete(key: PrimaryKey): Promise<void>;
}

export class DynamoItemStore implements ItemStore {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async get<T extends object>(key: PrimaryKey, opts: { consistent?: boolean } = {}) {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: { PK: key.PK, SK: key.SK }, ConsistentRead: opts.consistent ?? true }));
    return (r.Item as (T & PrimaryKey) | undefined) ?? null;
  }

  async put(item: Item, opts: { expectVer?: number | null } = {}) {
    const cond =
      opts.expectVer === undefined
        ? {}
        : opts.expectVer === null
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : { ConditionExpression: '#ver = :ver', ExpressionAttributeNames: { '#ver': 'ver' }, ExpressionAttributeValues: { ':ver': opts.expectVer } };
    try {
      await this.db.send(new PutCommand({ TableName: this.table, Item: stripUndefined(item), ...cond }));
    } catch (e) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') throw new ConflictError();
      throw e;
    }
  }

  async query<T extends object>(pk: string, opts: QueryOptions = {}) {
    const pkName = opts.index === 'GSI1' ? 'GSI1PK' : opts.index === 'GSI2' ? 'GSI2PK' : 'PK';
    const skName = opts.index === 'GSI1' ? 'GSI1SK' : opts.index === 'GSI2' ? 'GSI2SK' : 'SK';
    const out: (T & PrimaryKey)[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          ...(opts.index ? { IndexName: opts.index } : {}),
          KeyConditionExpression: opts.skPrefix ? '#pk = :pk AND begins_with(#sk, :sk)' : '#pk = :pk',
          ExpressionAttributeNames: { '#pk': pkName, ...(opts.skPrefix ? { '#sk': skName } : {}) },
          ExpressionAttributeValues: { ':pk': pk, ...(opts.skPrefix ? { ':sk': opts.skPrefix } : {}) },
          ScanIndexForward: opts.ascending ?? true,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      out.push(...((r.Items ?? []) as (T & PrimaryKey)[]));
      start = r.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (opts.limit && out.length >= opts.limit) return out.slice(0, opts.limit);
    } while (start);
    return out;
  }

  async delete(key: PrimaryKey) {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { PK: key.PK, SK: key.SK } }));
  }
}

/** DynamoDB rejects `undefined`; drop such members recursively (the document client is not configured to do it). */
export function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripUndefined(x)) as T;
  if (v && typeof v === 'object' && !(v instanceof Uint8Array) && !(v instanceof Set)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = stripUndefined(x);
    return out as T;
  }
  return v;
}

/**
 * Read-modify-write with optimistic locking: `fn` receives the current item (or null) and returns the new item (or
 * null to skip). Retries on ConflictError.
 */
export async function mutate<T extends object>(
  store: ItemStore,
  key: PrimaryKey,
  fn: (current: (T & PrimaryKey) | null) => (T & Record<string, unknown>) | null | Promise<(T & Record<string, unknown>) | null>,
  opts: { retries?: number; now?: () => string } = {},
): Promise<(T & PrimaryKey) | null> {
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    const cur = await store.get<T>(key);
    const next = await fn(cur);
    if (next === null) return cur;
    const curVer = cur ? Number((cur as Record<string, unknown>).ver ?? 0) : null;
    const now = opts.now?.() ?? new Date().toISOString();
    const item = {
      ...next,
      PK: key.PK,
      SK: key.SK,
      ver: (curVer ?? 0) + 1,
      createdAt: (cur as Record<string, unknown> | null)?.createdAt ?? (next as Record<string, unknown>).createdAt ?? now,
      updatedAt: now,
    } as unknown as Item;
    try {
      await store.put(item, { expectVer: curVer });
      return item as unknown as T & PrimaryKey;
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= retries) throw e;
    }
  }
}
