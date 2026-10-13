/**
 * In-memory stand-in for the DynamoDB document client, for the API route / repository tests without DynamoDB Local.
 * Subset used by the API: Get / Put / Update / Delete / Query (base table, GSI1, GSI2; key conditions =, begins_with,
 * BETWEEN, >), TransactWrite (condition checks, all-or-nothing), BatchGet; condition and filter expressions with
 * AND / OR / NOT, comparisons, IN, BETWEEN, attribute_exists / attribute_not_exists / begins_with / contains; update
 * expressions SET / REMOVE / ADD. Error names match DynamoDB (`ConditionalCheckFailedException`,
 * `TransactionCanceledException`). The DynamoDB Local integration tests run the same scenarios on the real engine.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown>;
type Names = Record<string, string> | undefined;
type Values = Record<string, unknown> | undefined;

const INDEX_KEYS: Record<string, [string, string]> = { GSI1: ['GSI1PK', 'GSI1SK'], GSI2: ['GSI2PK', 'GSI2SK'] };

class DdbError extends Error {
  constructor(
    name: string,
    message: string,
    readonly CancellationReasons?: { Code: string }[],
  ) {
    super(message);
    this.name = name;
  }
}

const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T));

// ---------------------------------------------------------------------------------------------------------------
// Expression tokenizer / parser

type Tok = { t: 'id' | 'name' | 'value' | 'op' | 'num'; v: string };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#' || c === ':') {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      out.push({ t: c === '#' ? 'name' : 'value', v: s.slice(i, j) });
      i = j;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '<>'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('=<>(),.[]+-'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j]!)) j++;
      out.push({ t: 'num', v: s.slice(i, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
    if (j === i) throw new Error(`unexpected character ${c} in expression ${s}`);
    out.push({ t: 'id', v: s.slice(i, j) });
    i = j;
  }
  return out;
}

type Path = string[];
type Operand = { kind: 'path'; path: Path } | { kind: 'value'; v: unknown };
type Cond =
  | { k: 'and' | 'or'; a: Cond; b: Cond }
  | { k: 'not'; a: Cond }
  | { k: 'cmp'; op: string; a: Operand; b: Operand }
  | { k: 'between'; a: Operand; lo: Operand; hi: Operand }
  | { k: 'in'; a: Operand; list: Operand[] }
  | { k: 'fn'; name: string; args: Operand[] };

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly names: Names,
    private readonly values: Values,
  ) {}

  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new Error('unexpected end of expression');
    return t;
  }
  expect(v: string): void {
    const t = this.next();
    if (t.v.toUpperCase() !== v.toUpperCase()) throw new Error(`expected ${v}, got ${t.v}`);
  }
  isKw(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'id' && t.v.toUpperCase() === v;
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }

  path(): Path {
    const parts: string[] = [];
    for (;;) {
      const t = this.next();
      if (t.t === 'name') {
        const n = this.names?.[t.v];
        if (n === undefined) throw new Error(`undefined name ${t.v}`);
        parts.push(n);
      } else if (t.t === 'id') parts.push(t.v);
      else throw new Error(`expected a path, got ${t.v}`);
      if (this.peek()?.v === '.') {
        this.next();
        continue;
      }
      return parts;
    }
  }

  operand(): Operand {
    const t = this.peek();
    if (t?.t === 'value') {
      this.next();
      if (!this.values || !(t.v in this.values)) throw new Error(`undefined value ${t.v}`);
      return { kind: 'value', v: this.values[t.v] };
    }
    return { kind: 'path', path: this.path() };
  }

  cond(): Cond {
    let a = this.and();
    while (this.isKw('OR')) {
      this.next();
      a = { k: 'or', a, b: this.and() };
    }
    return a;
  }
  and(): Cond {
    let a = this.not();
    while (this.isKw('AND')) {
      this.next();
      a = { k: 'and', a, b: this.not() };
    }
    return a;
  }
  not(): Cond {
    if (this.isKw('NOT')) {
      this.next();
      return { k: 'not', a: this.not() };
    }
    return this.primary();
  }
  primary(): Cond {
    const t = this.peek();
    if (t?.v === '(') {
      this.next();
      const c = this.cond();
      this.expect(')');
      return c;
    }
    if (t?.t === 'id' && ['attribute_exists', 'attribute_not_exists', 'begins_with', 'contains'].includes(t.v) && this.toks[this.i + 1]?.v === '(') {
      this.next();
      this.expect('(');
      const args: Operand[] = [this.operand()];
      while (this.peek()?.v === ',') {
        this.next();
        args.push(this.operand());
      }
      this.expect(')');
      return { k: 'fn', name: t.v, args };
    }
    const a = this.operand();
    if (this.isKw('BETWEEN')) {
      this.next();
      const lo = this.operand();
      this.expect('AND');
      return { k: 'between', a, lo, hi: this.operand() };
    }
    if (this.isKw('IN')) {
      this.next();
      this.expect('(');
      const list = [this.operand()];
      while (this.peek()?.v === ',') {
        this.next();
        list.push(this.operand());
      }
      this.expect(')');
      return { k: 'in', a, list };
    }
    const op = this.next();
    if (op.t !== 'op' || !['=', '<>', '<', '<=', '>', '>='].includes(op.v)) throw new Error(`expected comparison, got ${op.v}`);
    return { k: 'cmp', op: op.v, a, b: this.operand() };
  }
}

function getPath(item: Item, path: Path): unknown {
  let cur: unknown = item;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function resolve(item: Item, o: Operand): unknown {
  return o.kind === 'value' ? o.v : getPath(item, o.path);
}

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function evalCond(item: Item, c: Cond): boolean {
  switch (c.k) {
    case 'and':
      return evalCond(item, c.a) && evalCond(item, c.b);
    case 'or':
      return evalCond(item, c.a) || evalCond(item, c.b);
    case 'not':
      return !evalCond(item, c.a);
    case 'cmp': {
      const a = resolve(item, c.a);
      const b = resolve(item, c.b);
      if (c.op === '=') return a !== undefined && equal(a, b);
      if (c.op === '<>') return !equal(a, b);
      const r = compare(a, b);
      if (r === null) return false;
      return c.op === '<' ? r < 0 : c.op === '<=' ? r <= 0 : c.op === '>' ? r > 0 : r >= 0;
    }
    case 'between': {
      const a = resolve(item, c.a);
      const lo = compare(a, resolve(item, c.lo));
      const hi = compare(a, resolve(item, c.hi));
      return lo !== null && hi !== null && lo >= 0 && hi <= 0;
    }
    case 'in': {
      const a = resolve(item, c.a);
      return a !== undefined && c.list.some((o) => equal(a, resolve(item, o)));
    }
    case 'fn': {
      const [x, y] = c.args;
      if (c.name === 'attribute_exists') return getPath(item, (x as { path: Path }).path) !== undefined;
      if (c.name === 'attribute_not_exists') return getPath(item, (x as { path: Path }).path) === undefined;
      if (c.name === 'begins_with') {
        const a = resolve(item, x!);
        const b = resolve(item, y!);
        return typeof a === 'string' && typeof b === 'string' && a.startsWith(b);
      }
      if (c.name === 'contains') {
        const a = resolve(item, x!);
        const b = resolve(item, y!);
        return typeof a === 'string' ? typeof b === 'string' && a.includes(b) : Array.isArray(a) && a.some((v) => equal(v, b));
      }
      throw new Error(`unsupported function ${c.name}`);
    }
  }
}

function condition(expr: string | undefined, names: Names, values: Values): (item: Item) => boolean {
  if (!expr) return () => true;
  const p = new Parser(tokenize(expr), names, values);
  const c = p.cond();
  if (!p.done()) throw new Error(`trailing tokens in ${expr}`);
  return (item) => evalCond(item, c);
}

function setPath(item: Item, path: Path, v: unknown): void {
  let cur: Record<string, unknown> = item;
  for (const p of path.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object') throw new DdbError('ValidationException', `document path ${path.join('.')} does not exist`);
    cur = cur[p] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = v;
}

function removePath(item: Item, path: Path): void {
  let cur: unknown = item;
  for (const p of path.slice(0, -1)) {
    if (!cur || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur && typeof cur === 'object') delete (cur as Record<string, unknown>)[path[path.length - 1]!];
}

function applyUpdate(item: Item, expr: string, names: Names, values: Values): void {
  const p = new Parser(tokenize(expr), names, values);
  let section = '';
  while (!p.done()) {
    if (p.isKw('SET') || p.isKw('REMOVE') || p.isKw('ADD') || p.isKw('DELETE')) {
      section = p.next().v.toUpperCase();
      continue;
    }
    if (p.peek()?.v === ',') {
      p.next();
      continue;
    }
    const path = p.path();
    if (section === 'SET') {
      p.expect('=');
      const v = resolve(item, p.operand());
      if (p.peek()?.v === '+' || p.peek()?.v === '-') throw new Error('arithmetic in SET is not used by the API');
      setPath(item, path, clone(v));
    } else if (section === 'REMOVE') {
      removePath(item, path);
    } else if (section === 'ADD') {
      const v = resolve(item, p.operand());
      const cur = getPath(item, path);
      if (typeof v !== 'number') throw new Error('ADD supports numbers only in the memory store');
      setPath(item, path, (typeof cur === 'number' ? cur : 0) + v);
    } else throw new Error(`unsupported update section ${section}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class ApiMemoryDocumentClient {
  readonly tables = new Map<string, Map<string, Item>>();

  private table(name: string): Map<string, Item> {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }

  private static key(k: Item): string {
    return `${String(k.PK)}\u0000${String(k.SK)}`;
  }

  /** All items of a table (assertions). */
  dump(table: string): Item[] {
    return [...this.table(table).values()].map(clone);
  }

  async send(command: { input: Record<string, unknown>; constructor: { name: string } }): Promise<Record<string, unknown>> {
    const input = command.input as Record<string, unknown>;
    switch (command.constructor.name) {
      case 'GetCommand':
        return this.get(input);
      case 'PutCommand':
        return this.put(input);
      case 'UpdateCommand':
        return this.update(input);
      case 'DeleteCommand':
        return this.del(input);
      case 'QueryCommand':
        return this.query(input);
      case 'TransactWriteCommand':
        return this.transact(input);
      case 'BatchGetCommand':
        return this.batchGet(input);
      default:
        throw new Error(`ApiMemoryDocumentClient: unsupported command ${command.constructor.name}`);
    }
  }

  private get(i: Record<string, unknown>) {
    const it = this.table(String(i.TableName)).get(ApiMemoryDocumentClient.key(i.Key as Item));
    return { ...(it ? { Item: clone(it) } : {}) };
  }

  private checkCond(existing: Item | undefined, i: Record<string, unknown>): boolean {
    const cond = i.ConditionExpression as string | undefined;
    if (!cond) return true;
    return condition(cond, i.ExpressionAttributeNames as Names, i.ExpressionAttributeValues as Values)(existing ?? {});
  }

  private put(i: Record<string, unknown>) {
    const t = this.table(String(i.TableName));
    const item = clone(i.Item as Item);
    const k = ApiMemoryDocumentClient.key(item);
    if (!this.checkCond(t.get(k), i)) throw new DdbError('ConditionalCheckFailedException', 'The conditional request failed');
    t.set(k, item);
    return {};
  }

  private updated(i: Record<string, unknown>): { k: string; next: Item } {
    const t = this.table(String(i.TableName));
    const key = i.Key as Item;
    const k = ApiMemoryDocumentClient.key(key);
    const existing = t.get(k);
    if (!this.checkCond(existing, i)) throw new DdbError('ConditionalCheckFailedException', 'The conditional request failed');
    const next = clone(existing ?? { ...key });
    applyUpdate(next, String(i.UpdateExpression), i.ExpressionAttributeNames as Names, i.ExpressionAttributeValues as Values);
    return { k, next };
  }

  private update(i: Record<string, unknown>) {
    const { k, next } = this.updated(i);
    this.table(String(i.TableName)).set(k, next);
    return i.ReturnValues === 'ALL_NEW' ? { Attributes: clone(next) } : {};
  }

  private del(i: Record<string, unknown>) {
    const t = this.table(String(i.TableName));
    const k = ApiMemoryDocumentClient.key(i.Key as Item);
    if (!this.checkCond(t.get(k), i)) throw new DdbError('ConditionalCheckFailedException', 'The conditional request failed');
    t.delete(k);
    return {};
  }

  private query(i: Record<string, unknown>) {
    const index = i.IndexName as string | undefined;
    const [pkName, skName] = index ? INDEX_KEYS[index]! : ['PK', 'SK'];
    const names = i.ExpressionAttributeNames as Names;
    const values = i.ExpressionAttributeValues as Values;
    const kc = condition(String(i.KeyConditionExpression), names, values);
    const fc = condition(i.FilterExpression as string | undefined, names, values);
    let items = [...this.table(String(i.TableName)).values()].filter((it) => it[pkName] !== undefined && it[skName] !== undefined && kc(it));
    const cmp = (a: Item, b: Item) => {
      const x = String(a[skName]);
      const y = String(b[skName]);
      if (x !== y) return x < y ? -1 : 1;
      const p = ApiMemoryDocumentClient.key(a);
      const q = ApiMemoryDocumentClient.key(b);
      return p < q ? -1 : p > q ? 1 : 0;
    };
    items.sort(cmp);
    if (i.ScanIndexForward === false) items.reverse();
    const start = i.ExclusiveStartKey as Item | undefined;
    if (start) {
      const idx = items.findIndex((it) => ApiMemoryDocumentClient.key(it) === ApiMemoryDocumentClient.key(start));
      items = idx >= 0 ? items.slice(idx + 1) : items.filter((it) => (i.ScanIndexForward === false ? cmp(it, start) < 0 : cmp(it, start) > 0));
    }
    const limit = typeof i.Limit === 'number' ? i.Limit : undefined;
    const evaluated = limit !== undefined ? items.slice(0, limit) : items;
    const more = limit !== undefined && items.length > limit;
    const last = evaluated[evaluated.length - 1];
    const lastKey = more && last ? Object.fromEntries([pkName, skName, 'PK', 'SK'].map((k) => [k, last[k]])) : undefined;
    return { Items: evaluated.filter(fc).map(clone), Count: evaluated.length, ...(lastKey ? { LastEvaluatedKey: lastKey } : {}) };
  }

  private transact(i: Record<string, unknown>) {
    const ops = i.TransactItems as Record<string, Record<string, unknown>>[];
    const reasons: { Code: string }[] = [];
    const writes: { table: string; k: string; next: Item | null }[] = [];
    for (const op of ops) {
      const [kind, body] = Object.entries(op)[0]!;
      const t = this.table(String(body.TableName));
      try {
        if (kind === 'Put') {
          const item = clone(body.Item as Item);
          const k = ApiMemoryDocumentClient.key(item);
          if (!this.checkCond(t.get(k), body)) throw new DdbError('ConditionalCheckFailedException', 'failed');
          writes.push({ table: String(body.TableName), k, next: item });
        } else if (kind === 'Update') {
          const { k, next } = this.updated(body);
          writes.push({ table: String(body.TableName), k, next });
        } else if (kind === 'Delete') {
          const k = ApiMemoryDocumentClient.key(body.Key as Item);
          if (!this.checkCond(t.get(k), body)) throw new DdbError('ConditionalCheckFailedException', 'failed');
          writes.push({ table: String(body.TableName), k, next: null });
        } else if (kind === 'ConditionCheck') {
          const k = ApiMemoryDocumentClient.key(body.Key as Item);
          if (!this.checkCond(t.get(k), body)) throw new DdbError('ConditionalCheckFailedException', 'failed');
        }
        reasons.push({ Code: 'None' });
      } catch (e) {
        if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
        reasons.push({ Code: 'ConditionalCheckFailed' });
      }
    }
    if (reasons.some((r) => r.Code !== 'None')) {
      throw new DdbError('TransactionCanceledException', `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((r) => r.Code).join(', ')}]`, reasons);
    }
    for (const w of writes) {
      const t = this.table(w.table);
      if (w.next) t.set(w.k, w.next);
      else t.delete(w.k);
    }
    return {};
  }

  private batchGet(i: Record<string, unknown>) {
    const req = i.RequestItems as Record<string, { Keys: Item[] }>;
    const Responses: Record<string, Item[]> = {};
    for (const [table, { Keys }] of Object.entries(req)) {
      Responses[table] = Keys.map((k) => this.table(table).get(ApiMemoryDocumentClient.key(k))).filter((x): x is Item => !!x).map(clone);
    }
    return { Responses };
  }
}

export function memoryDb(): { client: DynamoDBDocumentClient; store: ApiMemoryDocumentClient } {
  const store = new ApiMemoryDocumentClient();
  return { client: store as unknown as DynamoDBDocumentClient, store };
}
