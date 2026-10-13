/**
 * `GET /api/capabilities?fields=…&modules=…` 的投影（06 PM-03；01 §9.3；04 §5.2.2）。
 *
 * - `fields`：逗号分隔的点路径；`*` 只能用作模块 id（`modules.*`）或功能 id（`features.*`）的通配段；数组元素的字段写 `x[].y`。
 * - 白名单 = capabilities 响应的全部节点路径（下面的 SCHEMA 树，与 capabilities.ts 的类型逐项对应）；`data`、`public`、`stats`、
 *   `app.platform` 是自由形状的子树，可以继续向下取。不在白名单中的路径 → `FIELDS_INVALID`。
 * - `modules`：只保留列出的模块；不存在的 id → `MODULE_UNKNOWN`（由调用方用 MODULE_IDS 判断）。
 * - 结果超过 maxBytes（默认 12 KB）时按模块 id 字母序截断，带 `truncated: true` 与 `nextModules`。
 */

type SchemaNode = { [key: string]: SchemaNode | true | 'free' };

const PROBE_HISTORY: SchemaNode = { at: true, status: true, latencyMs: true, detail: true };
const FINDING: SchemaNode = { rule: true, modules: true, message: true, fix: true };

/** capabilities 响应的结构（叶子 = true；自由形状子树 = 'free'；数组元素用 `name[]` 键） */
export const CAPABILITIES_SCHEMA: SchemaNode = {
  schemaVersion: true,
  generatedAt: true,
  view: true,
  truncated: true,
  nextModules: true,
  app: {
    version: true, profile: true, deployMode: true, region: true,
    instance: { id: true, az: true, type: true, role: true },
    entry: { baseUrl: true, source: true },
    configHash: true, startedAt: true,
    platform: 'free',
  },
  https: { trusted: true, via: true, hostKind: true },
  validation: { 'errors[]': FINDING, 'warnings[]': FINDING, 'overridden[]': FINDING },
  modules: {
    '*': {
      driver: true, awsService: true, type: true, status: true, localHealth: true, detail: true, latencyMs: true,
      confidence: true, since: true, lastProbeAt: true,
      switch: { var: true, value: true, localValue: true },
      deps: { requires: true, credentials: true, satisfied: true },
      bypass: true, stats: 'free', public: 'free', data: 'free',
      'probeHistory[]': PROBE_HISTORY,
      'checks[]': { id: true, status: true, detail: true },
    },
  },
  features: { '*': { enabled: true, via: true, reason: true, detail: true } },
  lab: { bypassEnabled: true, bypassKeys: true },
};

export class ProjectionError extends Error {
  constructor(readonly code: 'FIELDS_INVALID' | 'MODULE_UNKNOWN', message: string) {
    super(message);
  }
}

const SEG_RE = /^(?:\*|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)(?:\[\])?$/;

/** 解析 `a.b[].c`：模块与功能 id 的段（例如 `F6.upload`）本身含点，按 schema 位置识别。 */
export function parseFieldPath(raw: string): string[] {
  const p = raw.trim();
  if (!p || p.length > 200) throw new ProjectionError('FIELDS_INVALID', `invalid field path "${raw}"`);
  const parts = p.split('.');
  // features.<F6.upload>.enabled：功能 id 形如 F6.upload / X12.foo（含一个点）
  if (parts[0] === 'features' && parts.length >= 3 && /^[FX][0-9]+$/.test(parts[1] ?? '')) {
    parts.splice(1, 2, `${parts[1]}.${parts[2]}`);
  }
  for (const s of parts) if (!SEG_RE.test(s)) throw new ProjectionError('FIELDS_INVALID', `invalid segment "${s}" in "${raw}"`);
  return parts;
}

/** 校验一条路径是否在白名单中；返回规范化（通配）后的段序列。 */
export function validateFieldPath(raw: string, isModuleId: (id: string) => boolean): string[] {
  const segs = parseFieldPath(raw);
  let node: SchemaNode | true | 'free' = CAPABILITIES_SCHEMA;
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i]!;
    if (node === 'free') return segs;            // 自由形状子树：继续向下取，不再校验
    if (node === true) throw new ProjectionError('FIELDS_INVALID', `"${raw}": "${segs.slice(0, i).join('.')}" is a leaf`);
    const parent = segs[i - 1];
    let key = s;
    if (parent === 'modules' && i === 1) {
      if (s !== '*' && !isModuleId(s)) throw new ProjectionError('FIELDS_INVALID', `"${raw}": unknown module ${s}`);
      key = '*';
    } else if (parent === 'features' && i === 1) {
      if (s !== '*' && !/^[FX][0-9]+\.[A-Za-z0-9_-]+$/.test(s)) throw new ProjectionError('FIELDS_INVALID', `"${raw}": invalid feature id ${s}`);
      key = '*';
    } else if (s.includes('*')) {
      throw new ProjectionError('FIELDS_INVALID', `"${raw}": "*" is only allowed for module or feature ids`);
    }
    const next: SchemaNode | true | 'free' | undefined = (node as SchemaNode)[key];
    if (next === undefined) throw new ProjectionError('FIELDS_INVALID', `"${raw}" is not a capabilities field`);
    node = next;
  }
  return segs;
}

interface Trie { leaf: boolean; children: Map<string, Trie> }

function newTrie(): Trie {
  return { leaf: false, children: new Map() };
}

function buildTrie(paths: readonly string[][]): Trie {
  const root = newTrie();
  for (const segs of paths) {
    let t = root;
    for (const s of segs) {
      let c = t.children.get(s);
      if (!c) { c = newTrie(); t.children.set(s, c); }
      t = c;
    }
    t.leaf = true;
  }
  return root;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  return b;
}

function applyTrie(value: unknown, t: Trie): unknown {
  if (t.leaf) return value;
  if (!isPlainObject(value)) return undefined;
  let out: Record<string, unknown> = {};
  // 通配先做，具体 id 后做（合并）
  const entries = [...t.children.entries()].sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : 0));
  for (const [seg, child] of entries) {
    if (seg === '*') {
      for (const [k, v] of Object.entries(value)) {
        const r = applyTrie(v, child);
        if (r !== undefined) out[k] = k in out ? deepMerge(out[k], r) : r;
      }
      continue;
    }
    if (seg.endsWith('[]')) {
      const name = seg.slice(0, -2);
      const arr = value[name];
      if (Array.isArray(arr)) {
        const mapped = arr.map((e) => applyTrie(e, child) ?? {});
        out = { ...out, [name]: name in out && Array.isArray(out[name]) ? (out[name] as unknown[]).map((x, i) => deepMerge(x, mapped[i])) : mapped };
      }
      continue;
    }
    if (!(seg in value)) continue;
    const r = applyTrie(value[seg], child);
    if (r !== undefined) out[seg] = seg in out ? deepMerge(out[seg], r) : r;
  }
  return out;
}

export interface ProjectionOptions {
  /** 逗号分隔的 fields 参数 */
  fields?: string;
  /** 逗号分隔的 modules 参数 */
  modules?: string;
  isModuleId: (id: string) => boolean;
  /** 截断阈值（字节，默认 12 KB） */
  maxBytes?: number;
}

export interface ProjectionResult {
  body: Record<string, unknown>;
  truncated: boolean;
  nextModules: string[];
}

/** 投影 capabilities 响应体；参数错误抛 ProjectionError（调用方 → 400）。 */
export function projectCapabilities(body: object, opts: ProjectionOptions): ProjectionResult {
  const src = body as Record<string, unknown>;
  let moduleFilter: string[] | null = null;
  if (opts.modules !== undefined && opts.modules.trim() !== '') {
    moduleFilter = [...new Set(opts.modules.split(',').map((x) => x.trim()).filter(Boolean))];
    const unknown = moduleFilter.filter((m) => !opts.isModuleId(m));
    if (unknown.length) throw new ProjectionError('MODULE_UNKNOWN', `unknown module(s): ${unknown.join(', ')}`);
  }
  let projected: Record<string, unknown>;
  if (opts.fields !== undefined && opts.fields.trim() !== '') {
    const paths = opts.fields.split(',').map((f) => f.trim()).filter(Boolean).map((f) => validateFieldPath(f, opts.isModuleId));
    projected = (applyTrie(src, buildTrie(paths)) as Record<string, unknown>) ?? {};
  } else {
    projected = { ...src };
  }
  if (moduleFilter && isPlainObject(projected.modules)) {
    const mods = projected.modules;
    projected.modules = Object.fromEntries(Object.entries(mods).filter(([k]) => moduleFilter!.includes(k)));
  }
  const max = opts.maxBytes ?? 12 * 1024;
  const enc = new TextEncoder();
  const size = (o: unknown) => enc.encode(JSON.stringify(o)).length;
  if (size(projected) <= max || !isPlainObject(projected.modules)) return { body: projected, truncated: false, nextModules: [] };
  // 按模块 id 字母序截断：先放不含模块的部分，再逐个加入模块
  const ids = Object.keys(projected.modules).sort();
  const mods = projected.modules;
  const kept: Record<string, unknown> = {};
  const base = { ...projected, modules: kept, truncated: true, nextModules: [] as string[] };
  let i = 0;
  for (; i < ids.length; i += 1) {
    const id = ids[i]!;
    kept[id] = mods[id];
    base.nextModules = ids.slice(i + 1);
    if (size(base) > max) {
      delete kept[id];
      break;
    }
  }
  base.nextModules = ids.slice(Object.keys(kept).length);
  if (!base.nextModules.length) return { body: projected, truncated: false, nextModules: [] };
  return { body: base, truncated: true, nextModules: base.nextModules };
}
