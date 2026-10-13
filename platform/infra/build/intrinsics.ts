/**
 * A small CloudFormation intrinsic-function evaluator, used to render the generated IAM policies with concrete values
 * (size budget, 01 §6.10) and to evaluate template fragments in tests (conditions, Fn::Sub, Fn::If …).
 * It only needs to be as complete as the templates in this directory: Ref, Fn::Sub, Fn::If, Fn::Join, Fn::Split,
 * Fn::Select, Fn::GetAtt, Fn::Equals / And / Or / Not, Condition, Fn::Base64, Fn::ToJsonString and AWS::NoValue.
 */

export interface EvalContext {
  /** Template parameters (CommaDelimitedList parameters as string arrays). */
  params: Record<string, string | string[]>;
  /** Pseudo parameters (`AWS::AccountId`, `AWS::Region`, `AWS::Partition`, `AWS::StackName`, `AWS::StackId`, `AWS::URLSuffix`). */
  pseudo: Record<string, string>;
  /** Evaluated condition values. */
  conditions?: Record<string, boolean>;
  /** Value of `Ref <LogicalId>` for resources. */
  ref?: (logicalId: string) => string;
  /** Value of `Fn::GetAtt [<LogicalId>, <attr>]`. */
  getAtt?: (logicalId: string, attr: string) => string;
}

export const NO_VALUE = Symbol('AWS::NoValue');

export const EXAMPLE_PSEUDO: Readonly<Record<string, string>> = {
  'AWS::AccountId': '111122223333',
  'AWS::Region': 'ap-northeast-1',
  'AWS::Partition': 'aws',
  'AWS::StackName': 'atl',
  'AWS::StackId': 'arn:aws:cloudformation:ap-northeast-1:111122223333:stack/atl/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  'AWS::URLSuffix': 'amazonaws.com',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown, what: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new TypeError(`${what}: expected a string, got ${JSON.stringify(v)}`);
}

function lookupVariable(name: string, ctx: EvalContext, local: Record<string, unknown>): string {
  if (name in local) return asString(local[name], `Fn::Sub variable ${name}`);
  if (name.startsWith('AWS::')) {
    const v = ctx.pseudo[name];
    if (v === undefined) throw new Error(`unknown pseudo parameter ${name}`);
    return v;
  }
  const dot = name.indexOf('.');
  if (dot > 0) {
    if (!ctx.getAtt) throw new Error(`no GetAtt resolver for ${name}`);
    return ctx.getAtt(name.slice(0, dot), name.slice(dot + 1));
  }
  return refValue(name, ctx, 'Fn::Sub');
}

function refValue(name: string, ctx: EvalContext, where: string): string {
  if (name.startsWith('AWS::')) {
    const v = ctx.pseudo[name];
    if (v === undefined) throw new Error(`unknown pseudo parameter ${name}`);
    return v;
  }
  if (name in ctx.params) {
    const v = ctx.params[name]!;
    if (Array.isArray(v)) throw new TypeError(`${where}: list parameter ${name} cannot be used as a string`);
    return v;
  }
  if (!ctx.ref) throw new Error(`no Ref resolver for ${name}`);
  return ctx.ref(name);
}

/** `${Name}` substitution; `${!Literal}` renders `${Literal}` (CloudFormation escape). */
export function substitute(template: string, ctx: EvalContext, local: Record<string, unknown> = {}): string {
  return template.replace(/\$\{([^}]*)\}/g, (_m, inner: string) => {
    if (inner.startsWith('!')) return '${' + inner.slice(1) + '}';
    return lookupVariable(inner.trim(), ctx, local);
  });
}

export function evaluateCondition(node: unknown, ctx: EvalContext): boolean {
  const v = evaluate(node, ctx);
  if (typeof v !== 'boolean') throw new TypeError(`condition did not evaluate to a boolean: ${JSON.stringify(node)}`);
  return v;
}

export function evaluate(node: unknown, ctx: EvalContext): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => evaluate(n, ctx)).filter((n) => n !== NO_VALUE);
  }
  if (!isObject(node)) return node;
  const keys = Object.keys(node);
  if (keys.length === 1) {
    const k = keys[0]!;
    const arg = node[k];
    switch (k) {
      case 'Ref': {
        const name = asString(arg, 'Ref');
        if (name === 'AWS::NoValue') return NO_VALUE;
        if (name in ctx.params && Array.isArray(ctx.params[name])) return [...(ctx.params[name] as string[])];
        return refValue(name, ctx, 'Ref');
      }
      case 'Fn::Sub': {
        if (typeof arg === 'string') return substitute(arg, ctx);
        if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string' && isObject(arg[1])) {
          const local = Object.fromEntries(Object.entries(arg[1]).map(([n, v]) => [n, evaluate(v, ctx)]));
          return substitute(arg[0], ctx, local);
        }
        throw new TypeError(`Fn::Sub: unsupported argument ${JSON.stringify(arg)}`);
      }
      case 'Fn::If': {
        if (!Array.isArray(arg) || arg.length !== 3) throw new TypeError('Fn::If needs [condition, then, else]');
        const cond = asString(arg[0], 'Fn::If condition');
        const value = ctx.conditions?.[cond];
        if (value === undefined) throw new Error(`unknown condition ${cond}`);
        return evaluate(value ? arg[1] : arg[2], ctx);
      }
      case 'Condition': {
        const cond = asString(arg, 'Condition');
        const value = ctx.conditions?.[cond];
        if (value === undefined) throw new Error(`unknown condition ${cond}`);
        return value;
      }
      case 'Fn::Equals': {
        if (!Array.isArray(arg) || arg.length !== 2) throw new TypeError('Fn::Equals needs two arguments');
        const [a, b] = arg.map((x) => evaluate(x, ctx));
        return JSON.stringify(a) === JSON.stringify(b) || String(a) === String(b);
      }
      case 'Fn::And':
        return (arg as unknown[]).every((x) => evaluateCondition(x, ctx));
      case 'Fn::Or':
        return (arg as unknown[]).some((x) => evaluateCondition(x, ctx));
      case 'Fn::Not':
        return !evaluateCondition((arg as unknown[])[0], ctx);
      case 'Fn::Join': {
        const [sep, list] = arg as [string, unknown];
        const items = evaluate(list, ctx);
        if (!Array.isArray(items)) throw new TypeError('Fn::Join needs a list');
        return items.map((x) => asString(x, 'Fn::Join item')).join(sep);
      }
      case 'Fn::Split': {
        const [sep, s] = arg as [string, unknown];
        return asString(evaluate(s, ctx), 'Fn::Split source').split(sep);
      }
      case 'Fn::Select': {
        const [i, list] = arg as [unknown, unknown];
        const items = evaluate(list, ctx);
        const idx = Number(evaluate(i, ctx));
        if (!Array.isArray(items) || !(idx in items)) throw new RangeError(`Fn::Select index ${idx} out of range`);
        return items[idx];
      }
      case 'Fn::GetAtt': {
        const [id, attr] = Array.isArray(arg) ? (arg as [string, string]) : (String(arg).split(/\.(.*)/) as [string, string]);
        if (!ctx.getAtt) throw new Error(`no GetAtt resolver for ${id}.${attr}`);
        return ctx.getAtt(id, attr);
      }
      case 'Fn::Base64':
        return Buffer.from(asString(evaluate(arg, ctx), 'Fn::Base64'), 'utf8').toString('base64');
      case 'Fn::ToJsonString':
        return JSON.stringify(evaluate(arg, ctx));
      default:
        break;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    const e = evaluate(v, ctx);
    if (e !== NO_VALUE) out[k] = e;
  }
  return out;
}

/** Evaluate all `Conditions` of a template in dependency order. */
export function evaluateConditions(conditions: Record<string, unknown>, base: Omit<EvalContext, 'conditions'>): Record<string, boolean> {
  const done: Record<string, boolean> = {};
  const visiting = new Set<string>();
  const ctx: EvalContext = {
    ...base,
    conditions: new Proxy(done, {
      get: (_t, name: string) => resolve(name),
    }),
  };
  function resolve(name: string): boolean | undefined {
    if (name in done) return done[name];
    if (!(name in conditions)) return undefined;
    if (visiting.has(name)) throw new Error(`condition cycle at ${name}`);
    visiting.add(name);
    done[name] = evaluateCondition(conditions[name], ctx);
    visiting.delete(name);
    return done[name];
  }
  for (const name of Object.keys(conditions)) resolve(name);
  return done;
}

/** Collect every `Ref`, `Fn::GetAtt` and `${X}` / `${X.Attr}` reference (for dependency checks in tests). */
export function collectReferences(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) collectReferences(n, out);
    return out;
  }
  if (!isObject(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'Ref' && typeof v === 'string') out.add(v);
    else if (k === 'Fn::GetAtt') out.add(Array.isArray(v) ? String(v[0]) : String(v).split('.')[0]!);
    else if (k === 'Fn::Sub') {
      const s = typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : '';
      const local = Array.isArray(v) && isObject(v[1]) ? Object.keys(v[1]) : [];
      for (const m of s.matchAll(/\$\{([^}!][^}]*)\}/g)) {
        const name = m[1]!.split('.')[0]!;
        if (!local.includes(name)) out.add(name);
      }
      if (Array.isArray(v) && isObject(v[1])) collectReferences(v[1], out);
    } else collectReferences(v, out);
  }
  return out;
}
