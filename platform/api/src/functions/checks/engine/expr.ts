/**
 * `when` / `optional.when` expressions (04 §4.4 rule 5; ui-design §5.6 grammar): references such as `runtime.storage`,
 * `done.enable-cdn`, `driver.cdn`, `var.distributionId`, `learner.inputs.domain`, `session.variant`, `platform.drRegion`,
 * `envfile.cdn.CDN_DIRECT_ACCESS`, `preflight.tlsAcme`; literals `'x'`, `"x"`, numbers, `true`, `false`; operators
 * `! && || == !=` and parentheses. Hand-written parser, never `eval`.
 */

export type Expr =
  | { t: 'ref'; name: string }
  | { t: 'lit'; value: string | number | boolean }
  | { t: 'not'; e: Expr }
  | { t: 'and' | 'or'; a: Expr; b: Expr }
  | { t: 'eq' | 'neq'; a: Expr; b: Expr };

type Tok = { k: 'ref'; v: string } | { k: 'str'; v: string } | { k: 'num'; v: number } | { k: 'op'; v: string };

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
    if (two === '&&' || two === '||' || two === '==' || two === '!=') {
      out.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if (c === '!' || c === '(' || c === ')') {
      out.push({ k: 'op', v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new SyntaxError(`unterminated string in expression: ${src}`);
      out.push({ k: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && !/[A-Za-z_]/.test(src[i + num[0].length] ?? '')) {
      out.push({ k: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: 'ref', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new SyntaxError(`unexpected '${c}' in expression: ${src}`);
  }
  return out;
}

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.k === 'op' && peek()!.v === v;
  const primary = (): Expr => {
    const t = toks[p++];
    if (!t) throw new SyntaxError(`unexpected end of expression: ${src}`);
    if (t.k === 'op' && t.v === '!') return { t: 'not', e: primary() };
    if (t.k === 'op' && t.v === '(') {
      const e = or();
      if (!isOp(')')) throw new SyntaxError(`missing ')' in expression: ${src}`);
      p++;
      return e;
    }
    if (t.k === 'str') return { t: 'lit', value: t.v };
    if (t.k === 'num') return { t: 'lit', value: t.v };
    if (t.k === 'ref') {
      if (t.v === 'true') return { t: 'lit', value: true };
      if (t.v === 'false') return { t: 'lit', value: false };
      return { t: 'ref', name: t.v };
    }
    throw new SyntaxError(`unexpected token '${t.v}' in expression: ${src}`);
  };
  const cmp = (): Expr => {
    let a = primary();
    while (isOp('==') || isOp('!=')) {
      const op = (toks[p++] as { v: string }).v;
      a = { t: op === '==' ? 'eq' : 'neq', a, b: primary() };
    }
    return a;
  };
  const and = (): Expr => {
    let a = cmp();
    while (isOp('&&')) {
      p++;
      a = { t: 'and', a, b: cmp() };
    }
    return a;
  };
  const or = (): Expr => {
    let a = and();
    while (isOp('||')) {
      p++;
      a = { t: 'or', a, b: and() };
    }
    return a;
  };
  const e = or();
  if (p !== toks.length) throw new SyntaxError(`trailing tokens in expression: ${src}`);
  return e;
}

export function exprRefs(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.t) {
    case 'ref':
      out.add(e.name);
      break;
    case 'lit':
      break;
    case 'not':
      exprRefs(e.e, out);
      break;
    default:
      exprRefs(e.a, out);
      exprRefs(e.b, out);
  }
  return out;
}

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (v === 'false' || v === 'off') return false;
  return true;
}

function norm(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** Evaluate with resolved reference values (unresolved references are `undefined` → '' / false). */
export function evalExpr(e: Expr, values: Record<string, unknown>): boolean {
  const val = (x: Expr): unknown => {
    switch (x.t) {
      case 'ref':
        return values[x.name];
      case 'lit':
        return x.value;
      default:
        return evalExpr(x, values);
    }
  };
  switch (e.t) {
    case 'ref':
      return truthy(values[e.name]);
    case 'lit':
      return truthy(e.value);
    case 'not':
      return !evalExpr(e.e, values);
    case 'and':
      return evalExpr(e.a, values) && evalExpr(e.b, values);
    case 'or':
      return evalExpr(e.a, values) || evalExpr(e.b, values);
    case 'eq':
      return norm(val(e.a)) === norm(val(e.b));
    case 'neq':
      return norm(val(e.a)) !== norm(val(e.b));
  }
}

/** Parse + resolve + evaluate. `resolve` gets every reference once. */
export async function evaluateWhen(src: string, resolve: (ref: string) => Promise<unknown> | unknown): Promise<boolean> {
  const e = parseExpr(src);
  const values: Record<string, unknown> = {};
  for (const r of exprRefs(e)) values[r] = await resolve(r);
  return evalExpr(e, values);
}
