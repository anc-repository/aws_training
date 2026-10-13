/**
 * ASL intrinsic functions used in `Parameters` / `ResultSelector` values whose key ends in `.$`
 * (02 uses States.Format, States.MathAdd, States.ArrayLength, States.ArrayGetItem; the rest are cheap to support).
 */
import { randomUUID } from 'node:crypto';
import { StatesError } from './errors.js';
import { readPath } from './jsonpath.js';

type Token =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'lit'; v: boolean | null }
  | { t: 'path'; v: string }
  | { t: 'call'; name: string; args: Token[] };

export function isIntrinsic(expr: string): boolean {
  return /^States\.[A-Za-z0-9]+\(/.test(expr.trim());
}

export function evalIntrinsic(expr: string, input: unknown, context: unknown): unknown {
  const p = new Parser(expr.trim());
  const call = p.parseCall();
  p.skipWs();
  if (!p.done()) throw new StatesError('States.Runtime', `trailing characters in intrinsic: ${expr}`);
  return evaluate(call, input, context);
}

/** Escaped braces in string literals are kept as sentinels until States.Format has replaced its `{}` placeholders. */
const LBRACE = String.fromCharCode(0xe000);
const RBRACE = String.fromCharCode(0xe001);
const unescapeBraces = (s: string) => s.replaceAll(LBRACE, '{').replaceAll(RBRACE, '}');

function evaluate(tok: Token, input: unknown, context: unknown, raw = false): unknown {
  switch (tok.t) {
    case 'str':
      return raw ? tok.v : unescapeBraces(tok.v);
    case 'num':
    case 'lit':
      return tok.v;
    case 'path':
      return readPath(tok.v, input, context);
    case 'call': {
      const args = tok.args.map((a, i) => evaluate(a, input, context, tok.name === 'States.Format' && i === 0));
      const fn = FUNCTIONS[tok.name];
      if (!fn) throw new StatesError('States.Runtime', `unsupported intrinsic ${tok.name}`);
      return fn(args);
    }
  }
}

const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  'States.Format': (args) => {
    const [tmpl, ...rest] = args;
    if (typeof tmpl !== 'string') throw new StatesError('States.IntrinsicFailure', 'States.Format template must be a string');
    let i = 0;
    const out = tmpl.replace(/\{\}/g, () => {
      if (i >= rest.length) throw new StatesError('States.IntrinsicFailure', 'States.Format: not enough arguments');
      const v = rest[i++];
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
    if (i !== rest.length) throw new StatesError('States.IntrinsicFailure', 'States.Format: too many arguments');
    return unescapeBraces(out);
  },
  'States.StringToJson': ([s]) => {
    if (typeof s !== 'string') throw new StatesError('States.IntrinsicFailure', 'States.StringToJson expects a string');
    return JSON.parse(s);
  },
  'States.JsonToString': ([v]) => JSON.stringify(v),
  'States.Array': (args) => args,
  'States.ArrayLength': ([a]) => {
    if (!Array.isArray(a)) throw new StatesError('States.IntrinsicFailure', 'States.ArrayLength expects an array');
    return a.length;
  },
  'States.ArrayGetItem': ([a, i]) => {
    if (!Array.isArray(a) || typeof i !== 'number') throw new StatesError('States.IntrinsicFailure', 'States.ArrayGetItem(array, index)');
    if (i < 0 || i >= a.length) throw new StatesError('States.IntrinsicFailure', 'States.ArrayGetItem: index out of range');
    return a[i];
  },
  'States.ArrayContains': ([a, v]) => {
    if (!Array.isArray(a)) throw new StatesError('States.IntrinsicFailure', 'States.ArrayContains expects an array');
    return a.some((x) => JSON.stringify(x) === JSON.stringify(v));
  },
  'States.ArrayUnique': ([a]) => {
    if (!Array.isArray(a)) throw new StatesError('States.IntrinsicFailure', 'States.ArrayUnique expects an array');
    const seen = new Set<string>();
    return a.filter((x) => {
      const k = JSON.stringify(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
  'States.MathAdd': ([a, b]) => {
    if (typeof a !== 'number' || typeof b !== 'number') throw new StatesError('States.IntrinsicFailure', 'States.MathAdd expects numbers');
    return a + b;
  },
  'States.UUID': () => randomUUID(),
  'States.Base64Encode': ([s]) => Buffer.from(String(s), 'utf8').toString('base64'),
  'States.Base64Decode': ([s]) => Buffer.from(String(s), 'base64').toString('utf8'),
};

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  done(): boolean {
    return this.i >= this.s.length;
  }

  skipWs(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  parseCall(): Token {
    this.skipWs();
    const m = /^States\.[A-Za-z0-9]+/.exec(this.s.slice(this.i));
    if (!m) throw new StatesError('States.Runtime', `expected intrinsic at ${this.i}: ${this.s}`);
    this.i += m[0].length;
    this.expect('(');
    const args: Token[] = [];
    this.skipWs();
    if (this.s[this.i] === ')') {
      this.i++;
      return { t: 'call', name: m[0], args };
    }
    for (;;) {
      args.push(this.parseArg());
      this.skipWs();
      const c = this.s[this.i++];
      if (c === ')') break;
      if (c !== ',') throw new StatesError('States.Runtime', `expected , or ) in ${this.s}`);
    }
    return { t: 'call', name: m[0], args };
  }

  private expect(c: string): void {
    this.skipWs();
    if (this.s[this.i] !== c) throw new StatesError('States.Runtime', `expected ${c} in ${this.s}`);
    this.i++;
  }

  private parseArg(): Token {
    this.skipWs();
    const c = this.s[this.i];
    if (c === "'") return this.parseString();
    if (c === '$') {
      const m = /^\$\$?(?:\.[^,()\s.[\]]+|\[\d+\]|\['[^']*'\])*/.exec(this.s.slice(this.i))!;
      this.i += m[0].length;
      return { t: 'path', v: m[0] };
    }
    if (this.s.startsWith('States.', this.i)) return this.parseCall();
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return { t: 'num', v: Number(num[0]) };
    }
    for (const [w, v] of [
      ['null', null],
      ['true', true],
      ['false', false],
    ] as const) {
      if (this.s.startsWith(w, this.i)) {
        this.i += w.length;
        return { t: 'lit', v };
      }
    }
    throw new StatesError('States.Runtime', `cannot parse intrinsic argument at ${this.i}: ${this.s}`);
  }

  /** Single-quoted literal; a backslash escapes the next character (\' \{ \} \\). */
  private parseString(): Token {
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++]!;
      if (c === '\\') {
        const n = this.s[this.i++];
        if (n === undefined) break;
        out += n === '{' ? LBRACE : n === '}' ? RBRACE : n;
      } else if (c === "'") {
        return { t: 'str', v: out };
      } else {
        out += c;
      }
    }
    throw new StatesError('States.Runtime', `unterminated string in ${this.s}`);
  }
}
