/**
 * Thin DynamoDB helpers for the lifecycle functions (atl-lifecycle, atl-timer, atl-reaper): expression building,
 * conditional writes, transactions and paginated queries over `atl-main`. Keys come only from `@atl/shared`
 * (01 §7.1 — never concatenated here).
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

export type Item = Record<string, unknown>;
export interface Key {
  PK: string;
  SK: string;
}

/** Placeholder allocator for ExpressionAttributeNames / Values. */
export class Expr {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private n = 0;
  private v = 0;

  /** `#nX` for an attribute name (dotted paths become `#a.#b`). */
  name(attr: string): string {
    return attr
      .split('.')
      .map((part) => {
        const existing = Object.entries(this.names).find(([, a]) => a === part)?.[0];
        if (existing) return existing;
        const k = `#n${this.n++}`;
        this.names[k] = part;
        return k;
      })
      .join('.');
  }

  value(val: unknown): string {
    const k = `:v${this.v++}`;
    this.values[k] = val;
    return k;
  }

  input(): { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } {
    return {
      ...(Object.keys(this.names).length ? { ExpressionAttributeNames: this.names } : {}),
      ...(Object.keys(this.values).length ? { ExpressionAttributeValues: this.values } : {}),
    };
  }
}

/** `SET a = :a, … REMOVE b, …` from a set map and a remove list (top-level attributes). */
export function updateExpression(e: Expr, set: Item, remove: readonly string[] = []): string {
  const parts: string[] = [];
  const sets = Object.entries(set).filter(([, v]) => v !== undefined);
  if (sets.length) parts.push(`SET ${sets.map(([k, v]) => `${e.name(k)} = ${e.value(v)}`).join(', ')}`);
  const rem = remove.filter((k) => !(k in set) || set[k] === undefined);
  if (rem.length) parts.push(`REMOVE ${rem.map((k) => e.name(k)).join(', ')}`);
  return parts.join(' ');
}

/** Top-level diff: attributes to SET (changed or new) and to REMOVE (gone or undefined). */
export function diffItems(before: Item, after: Item): { set: Item; remove: string[] } {
  const set: Item = {};
  const remove: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (k === 'PK' || k === 'SK') continue;
    if (v === undefined) {
      if (k in before) remove.push(k);
      continue;
    }
    if (JSON.stringify(before[k]) !== JSON.stringify(v)) set[k] = v;
  }
  for (const k of Object.keys(before)) if (!(k in after) && k !== 'PK' && k !== 'SK') remove.push(k);
  return { set, remove };
}

export function errorName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export function isConditionFailed(e: unknown): boolean {
  return errorName(e) === 'ConditionalCheckFailedException';
}

/** Index of the transaction item whose condition failed, or -1 (`TransactionCanceledException`). */
export function cancelledIndex(e: unknown): number {
  if (errorName(e) !== 'TransactionCanceledException') return -1;
  const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.findIndex((r) => r?.Code === 'ConditionalCheckFailed');
}

export function isTransactionConflict(e: unknown): boolean {
  if (errorName(e) !== 'TransactionCanceledException') return errorName(e) === 'TransactionConflictException';
  const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.some((r) => r?.Code === 'TransactionConflict');
}

export type TransactItem =
  | { Put: { TableName: string; Item: Item; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } }
  | {
      Update: {
        TableName: string;
        Key: Key | Record<string, unknown>;
        UpdateExpression: string;
        ConditionExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    }
  | { Delete: { TableName: string; Key: Key | Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } }
  | { ConditionCheck: { TableName: string; Key: Key; ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } };

export class Table {
  constructor(
    readonly db: DynamoDBDocumentClient,
    readonly name: string,
  ) {}

  async get<T extends Item = Item>(key: Key, consistent = true): Promise<T | null> {
    const r = await this.db.send(new GetCommand({ TableName: this.name, Key: key, ConsistentRead: consistent }));
    return (r.Item as T | undefined) ?? null;
  }

  async put(item: Item, condition?: { expr: string; e: Expr }): Promise<void> {
    await this.db.send(
      new PutCommand({ TableName: this.name, Item: item, ...(condition ? { ConditionExpression: condition.expr, ...condition.e.input() } : {}) }),
    );
  }

  /** Put only when the item does not exist yet; returns false when it already existed. */
  async putIfAbsent(item: Item): Promise<boolean> {
    const e = new Expr();
    try {
      await this.put(item, { expr: `attribute_not_exists(${e.name('PK')})`, e });
      return true;
    } catch (err) {
      if (isConditionFailed(err)) return false;
      throw err;
    }
  }

  async update(key: Key, set: Item, remove: readonly string[] = [], condition?: { expr: string; e: Expr }): Promise<void> {
    const e = condition?.e ?? new Expr();
    const expr = updateExpression(e, set, remove);
    if (!expr) return;
    await this.db.send(
      new UpdateCommand({
        TableName: this.name,
        Key: key,
        UpdateExpression: expr,
        ...(condition ? { ConditionExpression: condition.expr } : {}),
        ...e.input(),
      }),
    );
  }

  /** Update with a prepared expression (the Expr must not contain unused names / values). */
  async updateRaw(key: Key, updateExpr: string, conditionExpr: string | null, e: Expr): Promise<void> {
    await this.db.send(
      new UpdateCommand({ TableName: this.name, Key: key, UpdateExpression: updateExpr, ...(conditionExpr ? { ConditionExpression: conditionExpr } : {}), ...e.input() }),
    );
  }

  async delete(key: Key | Record<string, unknown>, condition?: { expr: string; e: Expr }): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.name, Key: key, ...(condition ? { ConditionExpression: condition.expr, ...condition.e.input() } : {}) }));
  }

  async transact(items: TransactItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.send(new TransactWriteCommand({ TransactItems: items }));
  }

  /** All items of a query (follows LastEvaluatedKey; `limit` caps the total). */
  async query<T extends Item = Item>(q: {
    index?: 'GSI1' | 'GSI2';
    pk: { attr: string; value: string };
    sk?: { attr: string; beginsWith?: string; gt?: string; lte?: string; between?: [string, string] };
    forward?: boolean;
    limit?: number;
    consistent?: boolean;
  }): Promise<T[]> {
    const e = new Expr();
    let kce = `${e.name(q.pk.attr)} = ${e.value(q.pk.value)}`;
    if (q.sk) {
      const n = e.name(q.sk.attr);
      if (q.sk.beginsWith !== undefined) kce += ` AND begins_with(${n}, ${e.value(q.sk.beginsWith)})`;
      else if (q.sk.between) kce += ` AND ${n} BETWEEN ${e.value(q.sk.between[0])} AND ${e.value(q.sk.between[1])}`;
      else if (q.sk.gt !== undefined) kce += ` AND ${n} > ${e.value(q.sk.gt)}`;
      else if (q.sk.lte !== undefined) kce += ` AND ${n} <= ${e.value(q.sk.lte)}`;
    }
    const out: T[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(
        new QueryCommand({
          TableName: this.name,
          ...(q.index ? { IndexName: q.index } : {}),
          KeyConditionExpression: kce,
          ScanIndexForward: q.forward ?? true,
          ...(q.limit ? { Limit: Math.max(1, q.limit - out.length) } : {}),
          ...(start ? { ExclusiveStartKey: start } : {}),
          ...(q.consistent && !q.index ? { ConsistentRead: true } : {}),
          ...e.input(),
        }),
      );
      out.push(...((r.Items as T[] | undefined) ?? []));
      start = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start && (!q.limit || out.length < q.limit));
    return out;
  }
}
