/**
 * In-memory stand-in for the DynamoDB document client (lib-dynamodb commands) used by the lifecycle tests: Get, Put,
 * Update, Delete, Query (base table, GSI1, GSI2 — sparse), TransactWrite, with the expression subset of the lifecycle
 * code (comparisons, AND / OR / NOT, BETWEEN, IN, attribute_exists, attribute_not_exists, begins_with, if_not_exists,
 * + / -, SET / REMOVE). Like DynamoDB it rejects unused ExpressionAttributeNames / Values and reports condition
 * failures as ConditionalCheckFailedException / TransactionCanceledException (with CancellationReasons).
 * The same tests run against DynamoDB Local with ATL_IT=1.
 */
type Item = Record<string, unknown>;

interface TableDef {
  keys: string[];
  indexes: Record<string, [string, string]>;
}

const TABLES: Record<string, TableDef> = {
  'atl-main': { keys: ['PK', 'SK'], indexes: { GSI1: ['GSI1PK', 'GSI1SK'], GSI2: ['GSI2PK', 'GSI2SK'] } },
  'cloudalbum-lab-locks': { keys: ['lockKey'], indexes: {} },
};

class DdbError extends Error {
  CancellationReasons?: { Code: string; Message?: string }[];
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// tokenizer / parser

type Tok = { t: 'name' | 'value' | 'ident' | 'num' | 'op' | 'punct'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('=<>+-'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if ('(),.[]'.includes(c)) {
      out.push({ t: 'punct', v: c });
      i++;
      continue;
    }
    const m = /^[#:]?[A-Za-z0-9_]+/.exec(src.slice(i));
    if (!m) throw new DdbError('ValidationException', `unexpected character ${c} in ${src}`);
    const w = m[0];
    out.push(w.startsWith('#') ? { t: 'name', v: w } : w.startsWith(':') ? { t: 'value', v: w } : /^\d+$/.test(w) ? { t: 'num', v: w } : { t: 'ident', v: w });
    i += w.length;
  }
  return out;
}

interface Ctx {
  names: Record<string, string>;
  values: Record<string, unknown>;
  usedNames: Set<string>;
  usedValues: Set<string>;
}

type Path = (string | number)[];

class Parser {
  i = 0;
  constructor(
    readonly toks: Tok[],
    readonly ctx: Ctx,
  ) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new DdbError('ValidationException', 'unexpected end of expression');
    return t;
  }
  accept(v: string): boolean {
    const t = this.peek();
    if (t && (t.v === v || (t.t === 'ident' && t.v.toUpperCase() === v))) {
      this.i++;
      return true;
    }
    return false;
  }
  expect(v: string): void {
    if (!this.accept(v)) throw new DdbError('ValidationException', `expected ${v} at ${JSON.stringify(this.peek())}`);
  }
  path(): Path {
    const p: Path = [];
    const seg = () => {
      const t = this.next();
      if (t.t === 'name') {
        const n = this.ctx.names[t.v];
        if (n === undefined) throw new DdbError('ValidationException', `undefined attribute name ${t.v}`);
        this.ctx.usedNames.add(t.v);
        p.push(n);
      } else if (t.t === 'ident') p.push(t.v);
      else throw new DdbError('ValidationException', `bad path token ${t.v}`);
    };
    seg();
    for (;;) {
      if (this.accept('.')) seg();
      else if (this.accept('[')) {
        p.push(Number(this.next().v));
        this.expect(']');
      } else break;
    }
    return p;
  }
}

const get = (item: Item | undefined, p: Path): unknown => {
  let cur: unknown = item;
  for (const s of p) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[s];
  }
  return cur;
};

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/** Operand: path, :value, or function. Returns a getter. */
function operand(ps: Parser): (item: Item | undefined) => unknown {
  const t = ps.peek()!;
  if (t.t === 'value') {
    ps.i++;
    if (!(t.v in ps.ctx.values)) throw new DdbError('ValidationException', `undefined value ${t.v}`);
    ps.ctx.usedValues.add(t.v);
    const v = ps.ctx.values[t.v];
    return () => v;
  }
  if (t.t === 'ident' && ['if_not_exists', 'list_append', 'size'].includes(t.v)) {
    ps.i++;
    ps.expect('(');
    if (t.v === 'size') {
      const p = ps.path();
      ps.expect(')');
      return (it) => {
        const v = get(it, p);
        return typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : undefined;
      };
    }
    if (t.v === 'if_not_exists') {
      const p = ps.path();
      ps.expect(',');
      const d = operand(ps);
      ps.expect(')');
      return (it) => {
        const v = get(it, p);
        return v === undefined ? d(it) : v;
      };
    }
    const a = operand(ps);
    ps.expect(',');
    const b = operand(ps);
    ps.expect(')');
    return (it) => [...((a(it) as unknown[]) ?? []), ...((b(it) as unknown[]) ?? [])];
  }
  const p = ps.path();
  return (it) => get(it, p);
}

function condition(ps: Parser): (item: Item | undefined) => boolean {
  const or = (): ((it: Item | undefined) => boolean) => {
    let left = and();
    while (ps.accept('OR')) {
      const l = left;
      const r = and();
      left = (it) => l(it) || r(it);
    }
    return left;
  };
  const and = (): ((it: Item | undefined) => boolean) => {
    let left = not();
    while (ps.accept('AND')) {
      const l = left;
      const r = not();
      left = (it) => l(it) && r(it);
    }
    return left;
  };
  const not = (): ((it: Item | undefined) => boolean) => {
    if (ps.accept('NOT')) {
      const inner = not();
      return (it) => !inner(it);
    }
    return primary();
  };
  const primary = (): ((it: Item | undefined) => boolean) => {
    if (ps.accept('(')) {
      const c = or();
      ps.expect(')');
      return c;
    }
    const t = ps.peek()!;
    if (t.t === 'ident' && ['attribute_exists', 'attribute_not_exists', 'begins_with', 'contains'].includes(t.v)) {
      ps.i++;
      ps.expect('(');
      const p = ps.path();
      if (t.v === 'attribute_exists' || t.v === 'attribute_not_exists') {
        ps.expect(')');
        return t.v === 'attribute_exists' ? (it) => get(it, p) !== undefined : (it) => get(it, p) === undefined;
      }
      ps.expect(',');
      const v = operand(ps);
      ps.expect(')');
      if (t.v === 'begins_with') return (it) => typeof get(it, p) === 'string' && String(get(it, p)).startsWith(String(v(it)));
      return (it) => {
        const a = get(it, p);
        const b = v(it);
        return typeof a === 'string' ? a.includes(String(b)) : Array.isArray(a) ? a.includes(b) : false;
      };
    }
    const left = operand(ps);
    if (ps.accept('BETWEEN')) {
      const lo = operand(ps);
      ps.expect('AND');
      const hi = operand(ps);
      return (it) => {
        const v = left(it);
        const a = cmp(v, lo(it));
        const b = cmp(v, hi(it));
        return a !== null && b !== null && a >= 0 && b <= 0;
      };
    }
    if (ps.accept('IN')) {
      ps.expect('(');
      const list = [operand(ps)];
      while (ps.accept(',')) list.push(operand(ps));
      ps.expect(')');
      return (it) => list.some((x) => JSON.stringify(x(it)) === JSON.stringify(left(it)));
    }
    const op = ps.next();
    if (op.t !== 'op') throw new DdbError('ValidationException', `expected comparator, got ${op.v}`);
    const right = operand(ps);
    return (it) => {
      const a = left(it);
      const b = right(it);
      if (op.v === '=') return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
      if (op.v === '<>') return JSON.stringify(a) !== JSON.stringify(b);
      const c = cmp(a, b);
      if (c === null) return false;
      return op.v === '<' ? c < 0 : op.v === '<=' ? c <= 0 : op.v === '>' ? c > 0 : c >= 0;
    };
  };
  return or();
}

function makeCtx(input: Record<string, unknown>): Ctx {
  return {
    names: (input.ExpressionAttributeNames as Record<string, string>) ?? {},
    values: (input.ExpressionAttributeValues as Record<string, unknown>) ?? {},
    usedNames: new Set(),
    usedValues: new Set(),
  };
}

function checkUnused(ctx: Ctx): void {
  for (const n of Object.keys(ctx.names)) if (!ctx.usedNames.has(n)) throw new DdbError('ValidationException', `Value provided in ExpressionAttributeNames unused in expressions: keys: {${n}}`);
  for (const v of Object.keys(ctx.values)) if (!ctx.usedValues.has(v)) throw new DdbError('ValidationException', `Value provided in ExpressionAttributeValues unused in expressions: keys: {${v}}`);
}

function compileCondition(expr: string | undefined, ctx: Ctx): (it: Item | undefined) => boolean {
  if (!expr) return () => true;
  const ps = new Parser(tokenize(expr), ctx);
  const c = condition(ps);
  if (ps.i !== ps.toks.length) throw new DdbError('ValidationException', `trailing tokens in ${expr}`);
  return c;
}

function compileUpdate(expr: string, ctx: Ctx): (it: Item) => Item {
  const ps = new Parser(tokenize(expr), ctx);
  const actions: ((it: Item) => void)[] = [];
  const setPath = (it: Item, p: Path, v: unknown) => {
    let cur = it as Record<string | number, unknown>;
    for (let k = 0; k < p.length - 1; k++) {
      if (cur[p[k]!] === undefined || typeof cur[p[k]!] !== 'object') cur[p[k]!] = {};
      cur = cur[p[k]!] as Record<string | number, unknown>;
    }
    cur[p[p.length - 1]!] = v;
  };
  const delPath = (it: Item, p: Path) => {
    let cur = it as Record<string | number, unknown>;
    for (let k = 0; k < p.length - 1; k++) {
      cur = cur?.[p[k]!] as Record<string | number, unknown>;
      if (!cur) return;
    }
    delete cur[p[p.length - 1]!];
  };
  while (ps.peek()) {
    const kw = ps.next().v.toUpperCase();
    if (kw === 'SET') {
      do {
        const p = ps.path();
        ps.expect('=');
        const a = operand(ps);
        let f = a;
        const t = ps.peek();
        if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
          ps.i++;
          const b = operand(ps);
          f = (it) => (t.v === '+' ? Number(a(it)) + Number(b(it)) : Number(a(it)) - Number(b(it)));
        }
        const fn = f;
        actions.push((it) => setPath(it, p, structuredClone(fn(it))));
      } while (ps.accept(','));
    } else if (kw === 'REMOVE') {
      do {
        const p = ps.path();
        actions.push((it) => delPath(it, p));
      } while (ps.accept(','));
    } else if (kw === 'ADD') {
      do {
        const p = ps.path();
        const v = operand(ps);
        actions.push((it) => setPath(it, p, Number(get(it, p) ?? 0) + Number(v(it))));
      } while (ps.accept(','));
    } else {
      throw new DdbError('ValidationException', `unsupported update clause ${kw}`);
    }
  }
  return (it) => {
    const before = structuredClone(it);
    for (const a of actions) a(it);
    void before;
    return it;
  };
}

// ---------------------------------------------------------------------------------------------------------------

export class MemoryDocumentClient {
  readonly tables = new Map<string, Map<string, Item>>();
  readonly calls: { op: string; table?: string }[] = [];

  private table(name: string): { def: TableDef; rows: Map<string, Item> } {
    // tests may use per-run table names (atl-main-<suffix>, cloudalbum-lab-locks-<suffix>)
    const def = TABLES[name] ?? Object.entries(TABLES).find(([n]) => name.startsWith(`${n}-`))?.[1];
    if (!def) throw new DdbError('ResourceNotFoundException', `table ${name} not found`);
    let rows = this.tables.get(name);
    if (!rows) this.tables.set(name, (rows = new Map()));
    return { def, rows };
  }

  private keyOf(def: TableDef, key: Item): string {
    return def.keys.map((k) => {
      if (key[k] === undefined) throw new DdbError('ValidationException', `missing key ${k}`);
      return String(key[k]);
    }).join('\u0000');
  }

  /** All items of a table (tests). */
  items(name = 'atl-main'): Item[] {
    return [...(this.tables.get(name)?.values() ?? [])].map((x) => structuredClone(x));
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const op = command.constructor.name;
    const input = command.input;
    this.calls.push({ op, table: input.TableName as string | undefined });
    switch (op) {
      case 'GetCommand': {
        const { def, rows } = this.table(String(input.TableName));
        const it = rows.get(this.keyOf(def, input.Key as Item));
        return it ? { Item: structuredClone(it) } : {};
      }
      case 'BatchGetCommand': {
        const req = input.RequestItems as Record<string, { Keys: Item[] }>;
        const Responses: Record<string, Item[]> = {};
        for (const [name, r] of Object.entries(req)) {
          const { def, rows } = this.table(name);
          Responses[name] = r.Keys.map((k) => rows.get(this.keyOf(def, k))).filter((x): x is Item => !!x).map((x) => structuredClone(x));
        }
        return { Responses, UnprocessedKeys: {} };
      }
      case 'PutCommand':
        this.applyWrite({ Put: input });
        return {};
      case 'UpdateCommand': {
        const attrs = this.applyWrite({ Update: input });
        return input.ReturnValues === 'ALL_NEW' && attrs ? { Attributes: structuredClone(attrs) } : {};
      }
      case 'DeleteCommand':
        this.applyWrite({ Delete: input });
        return {};
      case 'TransactWriteCommand': {
        const items = input.TransactItems as Record<string, Record<string, unknown>>[];
        if (items.length > 100) throw new DdbError('ValidationException', 'too many transaction items');
        const seen = new Set<string>();
        for (const ti of items) {
          const body = Object.values(ti)[0]!;
          const { def } = this.table(String(body.TableName));
          const k = `${body.TableName}|${this.keyOf(def, (body.Key ?? body.Item) as Item)}`;
          if (seen.has(k)) throw new DdbError('ValidationException', 'Transaction request cannot include multiple operations on one item');
          seen.add(k);
        }
        // check every condition first, then apply all (all-or-nothing)
        const reasons = items.map((ti) => {
          try {
            this.check(ti);
            return { Code: 'None' };
          } catch (e) {
            if ((e as Error).name === 'ConditionalCheckFailedException') return { Code: 'ConditionalCheckFailed', Message: (e as Error).message };
            throw e;
          }
        });
        if (reasons.some((r) => r.Code !== 'None')) {
          const err = new DdbError('TransactionCanceledException', `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((r) => r.Code).join(', ')}]`);
          err.CancellationReasons = reasons;
          throw err;
        }
        for (const ti of items) if (!('ConditionCheck' in ti)) this.applyWrite(ti, true);
        return {};
      }
      case 'QueryCommand':
        return this.query(input);
      default:
        throw new DdbError('ValidationException', `unsupported command ${op}`);
    }
  }

  private check(ti: Record<string, Record<string, unknown>>): void {
    const [kind, body] = Object.entries(ti)[0]!;
    const { def, rows } = this.table(String(body.TableName));
    const key = this.keyOf(def, (body.Key ?? body.Item) as Item);
    const cur = rows.get(key);
    const ctx = makeCtx(body);
    const cond = compileCondition(body.ConditionExpression as string | undefined, ctx);
    if (kind === 'Update') compileUpdate(String(body.UpdateExpression), ctx); // mark names / values as used
    checkUnused(ctx);
    if (!cond(cur)) throw new DdbError('ConditionalCheckFailedException', 'The conditional request failed');
  }

  private applyWrite(ti: Record<string, Record<string, unknown>>, prechecked = false): Item | null {
    const [kind, body] = Object.entries(ti)[0]!;
    const { def, rows } = this.table(String(body.TableName));
    const key = this.keyOf(def, (body.Key ?? body.Item) as Item);
    const cur = rows.get(key);
    const ctx = makeCtx(body);
    const cond = compileCondition(body.ConditionExpression as string | undefined, ctx);
    const update = kind === 'Update' ? compileUpdate(String(body.UpdateExpression), ctx) : null;
    checkUnused(ctx);
    if (!prechecked && !cond(cur)) throw new DdbError('ConditionalCheckFailedException', 'The conditional request failed');
    if (kind === 'Put') rows.set(key, structuredClone(body.Item as Item));
    else if (kind === 'Delete') rows.delete(key);
    else if (kind === 'Update') {
      const base: Item = cur ? structuredClone(cur) : structuredClone(body.Key as Item);
      const next = update!(base);
      for (const k of def.keys) if (next[k] !== (body.Key as Item)[k]) throw new DdbError('ValidationException', 'cannot update a key attribute');
      rows.set(key, next);
      return next;
    }
    return null;
  }

  private query(input: Record<string, unknown>): Record<string, unknown> {
    const { def, rows } = this.table(String(input.TableName));
    const index = input.IndexName as string | undefined;
    const [hk, rk] = index ? def.indexes[index]! : (def.keys as [string, string]);
    const ctx = makeCtx(input);
    const kce = compileCondition(String(input.KeyConditionExpression), ctx);
    const filter = compileCondition(input.FilterExpression as string | undefined, ctx);
    checkUnused(ctx);
    let list = [...rows.values()].filter((it) => it[hk] !== undefined && (!rk || it[rk] !== undefined) && kce(it));
    list.sort((a, b) => cmp(a[rk!], b[rk!]) ?? 0);
    if (input.ScanIndexForward === false) list.reverse();
    const start = input.ExclusiveStartKey as Item | undefined;
    if (start) {
      const sk = this.keyOf(def, start);
      const at = list.findIndex((it) => this.keyOf(def, it) === sk);
      list = at >= 0 ? list.slice(at + 1) : list;
    }
    const limit = input.Limit as number | undefined;
    const page = limit ? list.slice(0, limit) : list;
    const out: Record<string, unknown> = { Items: page.filter((it) => filter(it)).map((x) => structuredClone(x)), Count: page.length };
    if (limit && list.length > limit) {
      const last = page[page.length - 1]!;
      out.LastEvaluatedKey = Object.fromEntries([...def.keys, ...(index ? [hk, rk!] : [])].map((k) => [k, last[k]]));
    }
    return out;
  }
}
