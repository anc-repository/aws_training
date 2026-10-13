/**
 * Thin DynamoDB helpers over the document client for `atl-main` (01 §7). Repositories build every key through
 * `data/keys.ts` (01 §7.1); this file only executes requests and normalises conditional failures.
 */
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { PrimaryKey } from '../data/keys.js';

export type Item = Record<string, unknown>;
export type DynamoKey = Record<string, unknown>;

/** A condition expression (or a transaction member's condition) did not hold. */
export class ConditionFailedError extends Error {
  constructor(
    message = 'condition failed',
    /** Index of the failing member for transactions. */
    readonly index?: number,
  ) {
    super(message);
    this.name = 'ConditionFailedError';
  }
}

export function isConditionFailed(e: unknown): e is ConditionFailedError {
  return e instanceof ConditionFailedError;
}

function mapError(e: unknown): unknown {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'ConditionalCheckFailedException') return new ConditionFailedError((e as Error).message);
  if (name === 'TransactionCanceledException') {
    const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
    const idx = reasons.findIndex((r) => r?.Code === 'ConditionalCheckFailed');
    if (idx >= 0) return new ConditionFailedError(`transaction condition failed (member ${idx})`, idx);
    // Parse fallback (DynamoDB Local puts reasons in the message)
    if (/ConditionalCheckFailed/.test((e as Error).message ?? '')) return new ConditionFailedError((e as Error).message);
  }
  return e;
}

/** Attributes that are storage details, never part of an API view. */
export const KEY_ATTRIBUTES = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'ttl'] as const;

export function stripKeys<T extends Item>(item: T): Omit<T, (typeof KEY_ATTRIBUTES)[number]> {
  const out: Item = {};
  for (const [k, v] of Object.entries(item)) if (!(KEY_ATTRIBUTES as readonly string[]).includes(k)) out[k] = v;
  return out as Omit<T, (typeof KEY_ATTRIBUTES)[number]>;
}

export interface Expr {
  expression: string;
  names?: Record<string, string>;
  values?: Record<string, unknown>;
}

export interface UpdateSpec {
  set?: Record<string, unknown>;
  remove?: readonly string[];
  /** Numeric ADD (e.g. counters). */
  add?: Record<string, number>;
  condition?: Expr;
}

/** Build `SET a = :a, … REMOVE b …` with generated placeholders (attribute names may be reserved words). */
export function buildUpdate(spec: UpdateSpec): { UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  const adds: string[] = [];
  let i = 0;
  for (const [k, v] of Object.entries(spec.set ?? {})) {
    if (v === undefined) continue;
    const n = `#u${i}`;
    const p = `:u${i}`;
    i++;
    names[n] = k;
    values[p] = v;
    sets.push(`${n} = ${p}`);
  }
  for (const k of spec.remove ?? []) {
    const n = `#u${i++}`;
    names[n] = k;
    removes.push(n);
  }
  for (const [k, v] of Object.entries(spec.add ?? {})) {
    const n = `#u${i}`;
    const p = `:u${i}`;
    i++;
    names[n] = k;
    values[p] = v;
    adds.push(`${n} ${p}`);
  }
  const parts: string[] = [];
  if (sets.length) parts.push(`SET ${sets.join(', ')}`);
  if (removes.length) parts.push(`REMOVE ${removes.join(', ')}`);
  if (adds.length) parts.push(`ADD ${adds.join(', ')}`);
  if (!parts.length) throw new Error('empty update');
  const c = spec.condition;
  Object.assign(names, c?.names ?? {});
  Object.assign(values, c?.values ?? {});
  return {
    UpdateExpression: parts.join(' '),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  };
}

export interface QuerySpec {
  index?: 'GSI1' | 'GSI2';
  /** Partition key value (attribute chosen by `index`). */
  pk: string;
  /** Sort key condition. */
  sk?: { beginsWith: string } | { between: [string, string] } | { gt: string; lte?: string } | { eq: string };
  filter?: Expr;
  limit?: number;
  startKey?: DynamoKey;
  descending?: boolean;
  consistent?: boolean;
}

export interface QueryPage<T = Item> {
  items: T[];
  lastKey?: DynamoKey;
}

export class Table {
  constructor(
    readonly db: DynamoDBDocumentClient,
    readonly name: string,
  ) {}

  async get<T extends Item = Item>(key: PrimaryKey, consistent = false): Promise<T | null> {
    const r = await this.db.send(new GetCommand({ TableName: this.name, Key: key, ConsistentRead: consistent }));
    return (r.Item as T | undefined) ?? null;
  }

  async put(item: Item, condition?: Expr): Promise<void> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.name,
          Item: item,
          ...(condition
            ? {
                ConditionExpression: condition.expression,
                ...(condition.names ? { ExpressionAttributeNames: condition.names } : {}),
                ...(condition.values ? { ExpressionAttributeValues: condition.values } : {}),
              }
            : {}),
        }),
      );
    } catch (e) {
      throw mapError(e);
    }
  }

  async update<T extends Item = Item>(key: PrimaryKey, spec: UpdateSpec): Promise<T> {
    const u = buildUpdate(spec);
    try {
      const r = await this.db.send(
        new UpdateCommand({
          TableName: this.name,
          Key: key,
          ...u,
          ...(spec.condition ? { ConditionExpression: spec.condition.expression } : {}),
          ReturnValues: 'ALL_NEW',
        }),
      );
      return (r.Attributes ?? {}) as T;
    } catch (e) {
      throw mapError(e);
    }
  }

  async delete(key: PrimaryKey, condition?: Expr): Promise<void> {
    try {
      await this.db.send(
        new DeleteCommand({
          TableName: this.name,
          Key: key,
          ...(condition
            ? {
                ConditionExpression: condition.expression,
                ...(condition.names ? { ExpressionAttributeNames: condition.names } : {}),
                ...(condition.values ? { ExpressionAttributeValues: condition.values } : {}),
              }
            : {}),
        }),
      );
    } catch (e) {
      throw mapError(e);
    }
  }

  async query<T extends Item = Item>(q: QuerySpec): Promise<QueryPage<T>> {
    const pkName = q.index === 'GSI1' ? 'GSI1PK' : q.index === 'GSI2' ? 'GSI2PK' : 'PK';
    const skName = q.index === 'GSI1' ? 'GSI1SK' : q.index === 'GSI2' ? 'GSI2SK' : 'SK';
    const names: Record<string, string> = { '#pk': pkName };
    const values: Record<string, unknown> = { ':pk': q.pk };
    let kce = '#pk = :pk';
    if (q.sk) {
      names['#sk'] = skName;
      if ('beginsWith' in q.sk) {
        kce += ' AND begins_with(#sk, :sk)';
        values[':sk'] = q.sk.beginsWith;
      } else if ('between' in q.sk) {
        kce += ' AND #sk BETWEEN :sk1 AND :sk2';
        values[':sk1'] = q.sk.between[0];
        values[':sk2'] = q.sk.between[1];
      } else if ('eq' in q.sk) {
        kce += ' AND #sk = :sk';
        values[':sk'] = q.sk.eq;
      } else {
        // gt (+ optional lte): DynamoDB key conditions allow one comparison; express “> a AND <= b” as BETWEEN and drop a.
        if (q.sk.lte !== undefined) {
          kce += ' AND #sk BETWEEN :sk1 AND :sk2';
          values[':sk1'] = q.sk.gt;
          values[':sk2'] = q.sk.lte;
        } else {
          kce += ' AND #sk > :sk';
          values[':sk'] = q.sk.gt;
        }
      }
    }
    Object.assign(names, q.filter?.names ?? {});
    Object.assign(values, q.filter?.values ?? {});
    const r = await this.db.send(
      new QueryCommand({
        TableName: this.name,
        ...(q.index ? { IndexName: q.index } : {}),
        KeyConditionExpression: kce,
        ...(q.filter ? { FilterExpression: q.filter.expression } : {}),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...(q.limit ? { Limit: q.limit } : {}),
        ...(q.startKey ? { ExclusiveStartKey: q.startKey } : {}),
        ScanIndexForward: !q.descending,
        ...(q.consistent && !q.index ? { ConsistentRead: true } : {}),
      }),
    );
    let items = (r.Items ?? []) as T[];
    // BETWEEN is inclusive; `gt` must exclude the lower bound itself.
    if (q.sk && 'gt' in q.sk && q.sk.lte !== undefined) {
      const lower = q.sk.gt;
      items = items.filter((it) => (it as Item)[skName] !== lower);
    }
    return { items, ...(r.LastEvaluatedKey ? { lastKey: r.LastEvaluatedKey } : {}) };
  }

  /**
   * Collect up to `limit` matching items across pages (filters make single pages short). Returns the key to continue
   * from when more items may exist.
   */
  async queryPage<T extends Item = Item>(q: QuerySpec, limit: number): Promise<QueryPage<T>> {
    const out: T[] = [];
    let startKey = q.startKey;
    for (let guard = 0; guard < 50; guard++) {
      const page = await this.query<T>({ ...q, limit: q.filter ? Math.max(limit * 2, 25) : limit - out.length, ...(startKey ? { startKey } : {}) });
      let consumed = 0;
      for (const it of page.items) {
        if (out.length >= limit) break;
        out.push(it);
        consumed++;
      }
      if (out.length >= limit) {
        if (consumed === page.items.length && !page.lastKey) return { items: out };
        const last = out[out.length - 1] as Item;
        // continuation key = the key attributes of the last returned item
        return { items: out, lastKey: keyOf(last, q.index) };
      }
      if (!page.lastKey) return { items: out };
      startKey = page.lastKey;
    }
    return { items: out, ...(startKey ? { lastKey: startKey } : {}) };
  }

  async queryAll<T extends Item = Item>(q: QuerySpec, max = 2000): Promise<T[]> {
    const out: T[] = [];
    let startKey = q.startKey;
    do {
      const page = await this.query<T>({ ...q, ...(startKey ? { startKey } : {}) });
      out.push(...page.items);
      startKey = page.lastKey;
    } while (startKey && out.length < max);
    return out.slice(0, max);
  }

  async transact(items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>): Promise<void> {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (e) {
      throw mapError(e);
    }
  }

  async batchGet<T extends Item = Item>(keys: PrimaryKey[], consistent = false): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      let pending: Record<string, unknown>[] | undefined = keys.slice(i, i + 100).map((k) => ({ PK: k.PK, SK: k.SK }));
      for (let attempt = 0; pending && pending.length && attempt < 5; attempt++) {
        const r: { Responses?: Record<string, Record<string, unknown>[]>; UnprocessedKeys?: Record<string, { Keys?: Record<string, unknown>[] }> } =
          await this.db.send(new BatchGetCommand({ RequestItems: { [this.name]: { Keys: pending, ConsistentRead: consistent } } }));
        out.push(...((r.Responses?.[this.name] ?? []) as T[]));
        pending = r.UnprocessedKeys?.[this.name]?.Keys;
      }
    }
    return out;
  }
}

/** Primary (and index) key attributes of an item — the ExclusiveStartKey for continuing after it. */
export function keyOf(item: Item, index?: 'GSI1' | 'GSI2'): DynamoKey {
  const k: DynamoKey = { PK: item.PK, SK: item.SK };
  if (index === 'GSI1') Object.assign(k, { GSI1PK: item.GSI1PK, GSI1SK: item.GSI1SK });
  if (index === 'GSI2') Object.assign(k, { GSI2PK: item.GSI2PK, GSI2SK: item.GSI2SK });
  return k;
}
