/**
 * JSONPath subset used by assertions, `where`, evidence `keep` / `redact` (04 §5.3):
 *   `$`, `$.a.b`, `$.a[0].b`, `$.items[*].x`, `$['x-y']`, and `$..x` (recursive descent; meant for redact).
 * Member names may contain `-` (`$.headers.x-cache`). Pure functions, no eval.
 */

export type Segment =
  | { kind: 'name'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wild' }
  | { kind: 'descend'; name: string | null };

export type ConcretePath = (string | number)[];

const cache = new Map<string, Segment[]>();

export function parsePath(path: string): Segment[] {
  const hit = cache.get(path);
  if (hit) return hit;
  if (typeof path !== 'string' || !path.startsWith('$')) throw new SyntaxError(`JSONPath must start with $: ${String(path)}`);
  const segs: Segment[] = [];
  let i = 1;
  const nameRe = /[A-Za-z0-9_$@:-]/;
  const readName = (): string => {
    let s = '';
    while (i < path.length && nameRe.test(path[i]!)) s += path[i++];
    return s;
  };
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      if (path[i + 1] === '.') {
        i += 2;
        if (path[i] === '*') {
          i++;
          segs.push({ kind: 'descend', name: null });
        } else {
          const n = readName();
          if (!n) throw new SyntaxError(`JSONPath: expected a name after '..' in ${path}`);
          segs.push({ kind: 'descend', name: n });
        }
        continue;
      }
      i++;
      if (path[i] === '*') {
        i++;
        segs.push({ kind: 'wild' });
        continue;
      }
      const n = readName();
      if (!n) throw new SyntaxError(`JSONPath: empty member name in ${path}`);
      segs.push({ kind: 'name', name: n });
      continue;
    }
    if (ch === '[') {
      const close = path.indexOf(']', i);
      if (close < 0) throw new SyntaxError(`JSONPath: unclosed '[' in ${path}`);
      const inner = path.slice(i + 1, close).trim();
      i = close + 1;
      if (inner === '*') segs.push({ kind: 'wild' });
      else if (/^-?\d+$/.test(inner)) segs.push({ kind: 'index', index: Number(inner) });
      else if (/^'(.*)'$/.test(inner) || /^"(.*)"$/.test(inner)) segs.push({ kind: 'name', name: inner.slice(1, -1) });
      else throw new SyntaxError(`JSONPath: unsupported selector [${inner}] in ${path}`);
      continue;
    }
    throw new SyntaxError(`JSONPath: unexpected '${ch}' at ${i} in ${path}`);
  }
  cache.set(path, segs);
  return segs;
}

export function hasWildcard(path: string): boolean {
  return parsePath(path).some((s) => s.kind === 'wild' || s.kind === 'descend');
}

export interface Match {
  path: ConcretePath;
  value: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every match of `path` in `root`, with its concrete location. */
export function queryAll(root: unknown, path: string): Match[] {
  let cur: Match[] = [{ path: [], value: root }];
  for (const seg of parsePath(path)) {
    const next: Match[] = [];
    for (const m of cur) {
      const v = m.value;
      switch (seg.kind) {
        case 'name': {
          if (isObj(v) && Object.prototype.hasOwnProperty.call(v, seg.name)) next.push({ path: [...m.path, seg.name], value: v[seg.name] });
          else if (Array.isArray(v) && seg.name === 'length') next.push({ path: [...m.path, 'length'], value: v.length });
          break;
        }
        case 'index': {
          if (Array.isArray(v)) {
            const idx = seg.index < 0 ? v.length + seg.index : seg.index;
            if (idx >= 0 && idx < v.length) next.push({ path: [...m.path, idx], value: v[idx] });
          }
          break;
        }
        case 'wild': {
          if (Array.isArray(v)) v.forEach((x, idx) => next.push({ path: [...m.path, idx], value: x }));
          else if (isObj(v)) for (const [k, x] of Object.entries(v)) next.push({ path: [...m.path, k], value: x });
          break;
        }
        case 'descend': {
          const walk = (p: ConcretePath, x: unknown) => {
            if (Array.isArray(x)) x.forEach((y, idx) => walk([...p, idx], y));
            else if (isObj(x)) {
              for (const [k, y] of Object.entries(x)) {
                if (seg.name === null || k === seg.name) next.push({ path: [...p, k], value: y });
                walk([...p, k], y);
              }
            }
          };
          walk(m.path, v);
          break;
        }
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Value at `path`: the single value for definite paths (undefined when missing), the array of matched values for paths
 * with wildcards / recursive descent.
 */
export function query(root: unknown, path: string): unknown {
  const ms = queryAll(root, path);
  if (hasWildcard(path)) return ms.map((m) => m.value);
  return ms[0]?.value;
}

/** Does a definite path exist (even with value null)? */
export function exists(root: unknown, path: string): boolean {
  return queryAll(root, path).length > 0;
}

/** Relative dotted lookup used by `where` keys (`CustomOriginConfig.HTTPPort`, `a[0].b`). */
export function relative(obj: unknown, dotted: string): unknown {
  return query(obj, dotted.startsWith('$') ? dotted : `$.${dotted}`);
}

/** Set a value at a concrete path (no-op when the parent is missing). */
export function setAt(root: unknown, path: ConcretePath, value: unknown): void {
  if (path.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Record<string | number, unknown>)[path[i]!];
  }
  if (cur !== null && typeof cur === 'object') (cur as Record<string | number, unknown>)[path[path.length - 1]!] = value;
}

export function formatPath(path: ConcretePath): string {
  return '$' + path.map((p) => (typeof p === 'number' ? `[${p}]` : /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(p) ? `.${p}` : `['${p}']`)).join('');
}
