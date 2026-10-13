/**
 * 变量占位符（04 §4.4）：`{{ <命名空间>.<路径> [ | <过滤器>[:<参数>] ]* }}`，在浏览器端按 `GET /sessions/{sid}/vars` 的结果代入（04 §4.5）。
 *
 * - 命名空间：session、target、workstation、stack、cap、envfile、var、learner、platform（sample.* 只在检查定义中出现）；
 * - 过滤器：default:"文字"、mask、host、trimScheme、shell、url、json、lower、upper；
 * - 未解析：返回 null，由调用方渲染红色虚线占位 `‹标签›`（`default` 过滤器的文字优先）；
 * - 密钥：任何命名空间都不提供密钥值；值形如 `‹secret…›` / `‹masked›` 时视为“含密钥占位”，粘贴被拒绝（03 §7.1）。
 * - 字面量 `\{{` 不代入。
 */
import type { CommandPart } from '../../ui';

export interface VarsResponse {
  sessionId?: string;
  session?: Record<string, unknown>;
  platform?: Record<string, unknown>;
  learner?: { inputs?: Record<string, unknown> } & Record<string, unknown>;
  target?: Record<string, unknown>;
  workstation?: Record<string, unknown>;
  stack?: Record<string, Record<string, unknown>>;
  cap?: Record<string, unknown>;
  envfile?: Record<string, Record<string, unknown>>;
  vars?: { name: string; label?: string; from?: string; value: unknown; pattern?: string | null; example?: string | null }[];
}

export interface Filter {
  name: string;
  arg?: string;
}

export interface Placeholder {
  /** `session.region`、`var.distributionId` …… */
  path: string;
  ns: string;
  filters: Filter[];
}

export type TemplatePart = { kind: 'text'; text: string } | { kind: 'var'; ph: Placeholder; raw: string };

const PLACEHOLDER = /(\\?)\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\s*((?:\|\s*[A-Za-z]+(?::\s*(?:"[^"]*"|'[^']*'|[^|}\s]+))?\s*)*)\}\}/g;
const FILTER = /\|\s*([A-Za-z]+)(?::\s*("[^"]*"|'[^']*'|[^|}\s]+))?/g;

function unquote(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

export function parseTemplate(text: string): TemplatePart[] {
  const out: TemplatePart[] = [];
  let last = 0;
  PLACEHOLDER.lastIndex = 0;
  for (let m = PLACEHOLDER.exec(text); m; m = PLACEHOLDER.exec(text)) {
    const [raw, esc, path, filterStr] = m;
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (esc) {
      out.push({ kind: 'text', text: raw.slice(1) });
    } else {
      const filters: Filter[] = [];
      FILTER.lastIndex = 0;
      for (let f = FILTER.exec(filterStr ?? ''); f; f = FILTER.exec(filterStr ?? '')) filters.push({ name: f[1]!, ...(f[2] !== undefined ? { arg: unquote(f[2]) } : {}) });
      out.push({ kind: 'var', raw, ph: { path: path!, ns: path!.split('.')[0]!, filters } });
    }
    last = m.index + raw.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return mergeText(out);
}

function mergeText(parts: TemplatePart[]): TemplatePart[] {
  const out: TemplatePart[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (p.kind === 'text' && prev?.kind === 'text') prev.text += p.text;
    else out.push(p.kind === 'text' ? { ...p } : p);
  }
  return out;
}

export function hasPlaceholders(text: string): boolean {
  return parseTemplate(text).some((p) => p.kind === 'var');
}

function scalar(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function dig(obj: unknown, segs: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const s of segs) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** 变量的原始值（未经过滤器）；没有时 null。 */
export function lookupVar(vars: VarsResponse | null, path: string): string | null {
  if (!vars) return null;
  const [ns, ...rest] = path.split('.');
  if (ns === 'var') {
    const name = rest.join('.');
    const hit = vars.vars?.find((v) => v.name === name);
    return hit ? scalar(hit.value) : null;
  }
  if (ns === 'learner') return scalar(dig(vars.learner, rest));
  const root = (vars as Record<string, unknown>)[ns ?? ''];
  // session.env 与 session.envName 都接受（04 §4.4 写 session.env）
  if (ns === 'session' && rest[0] === 'envName') return scalar(dig(root, ['env']));
  return scalar(dig(root, rest));
}

export function isSecretValue(v: string | null): boolean {
  return !!v && /^‹(secret|masked)/.test(v);
}

/** POSIX 单引号转义（原型 shq）。 */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function maskValue(v: string): string {
  const digits = v.replace(/\D/g, '');
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
}

/** 依次应用过滤器（`default` 只在未解析时起作用）。 */
export function applyFilters(value: string | null, filters: readonly Filter[]): { value: string | null; fallback: string | null } {
  let v = value;
  let fallback: string | null = null;
  for (const f of filters) {
    if (f.name === 'default') {
      fallback = f.arg ?? null;
      continue;
    }
    if (v === null) continue;
    switch (f.name) {
      case 'mask':
        v = maskValue(v);
        break;
      case 'host':
        try {
          v = new URL(v).host;
        } catch {
          v = v.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? v;
        }
        break;
      case 'trimScheme':
        v = v.replace(/^[a-z]+:\/\//i, '');
        break;
      case 'shell':
        v = shellQuote(v);
        break;
      case 'url':
        v = encodeURIComponent(v);
        break;
      case 'json':
        v = JSON.stringify(v);
        break;
      case 'lower':
        v = v.toLowerCase();
        break;
      case 'upper':
        v = v.toUpperCase();
        break;
      default:
        break;
    }
  }
  return { value: v, fallback };
}

/** 变量的显示标签（未解析时的占位 `‹标签›`）。 */
export function placeholderLabel(ph: Placeholder, vars: VarsResponse | null, fallback: string | null): string {
  if (fallback) return fallback.startsWith('‹') ? fallback : `‹${fallback}›`;
  if (ph.ns === 'var') {
    const name = ph.path.slice(4);
    const d = vars?.vars?.find((v) => v.name === name);
    return `‹${d?.label ?? name}›`;
  }
  return `‹${ph.path}›`;
}

export interface Resolved {
  parts: CommandPart[];
  /** 代入后的原文（未解析的变量用占位文字）。 */
  text: string;
  unresolved: string[];
  secret: boolean;
}

/** 把模板代入成 CommandBlock 的 parts（显示用打码由 CommandBlock 负责，这里给原文）。 */
export function resolveTemplate(text: string, vars: VarsResponse | null, enabled = true): Resolved {
  if (!enabled) return { parts: [text], text, unresolved: [], secret: false };
  const parts: CommandPart[] = [];
  const unresolved: string[] = [];
  let secret = false;
  let out = '';
  for (const p of parseTemplate(text)) {
    if (p.kind === 'text') {
      parts.push(p.text);
      out += p.text;
      continue;
    }
    const raw = lookupVar(vars, p.ph.path);
    const { value, fallback } = applyFilters(raw, p.ph.filters);
    const isSecret = isSecretValue(raw);
    if (isSecret) secret = true;
    const placeholder = placeholderLabel(p.ph, vars, fallback);
    if (value === null || isSecret) {
      if (!isSecret) unresolved.push(p.ph.path);
      parts.push({ name: p.ph.path, value: null, placeholder, secret: isSecret });
      out += placeholder;
    } else {
      parts.push({ name: p.ph.path, value, placeholder });
      out += value;
    }
  }
  return { parts, text: out, unresolved, secret };
}

/** 行内文字中的变量（手册正文、inlineCode）：只要显示文本。 */
export function interpolate(text: string, vars: VarsResponse | null): { text: string; unresolved: boolean } {
  const r = resolveTemplate(text, vars);
  return { text: r.text, unresolved: r.unresolved.length > 0 };
}

export const NAMESPACE_TEXT: Readonly<Record<string, string>> = {
  session: 'session',
  target: 'target',
  workstation: 'workstation',
  stack: 'stack',
  cap: 'cap',
  envfile: 'envfile',
  var: 'var',
  learner: 'learner',
  platform: 'platform',
};

export interface VarChipModel {
  key: string;
  ns: string;
  name: string;
  label: string;
  value: string | null;
  /** 输入型变量（::var-input，`PUT /vars/{name}`）。 */
  input?: { pattern: string | null; example: string | null };
  /** 账号 ID：默认打码。 */
  account?: boolean;
}

/**
 * 变量条的条目（P05.3 VariableStrip）：session 的常用值 + 卡片声明的 var.* + 其他命名空间中有值的条目。
 * `used` 为手册中实际引用到的路径集合：只把它们与卡片声明的变量放在默认视图里。
 */
export function variableChips(vars: VarsResponse | null, used: ReadonlySet<string> = new Set()): VarChipModel[] {
  if (!vars) return [];
  const out: VarChipModel[] = [];
  const s = vars.session ?? {};
  const add = (ns: string, name: string, value: unknown, extra: Partial<VarChipModel> = {}) =>
    out.push({ key: `${ns}.${name}`, ns, name, label: extra.label ?? name, value: scalar(value), ...extra });
  add('session', 'region', s.region);
  add('session', 'env', s.env);
  add('session', 'accountId', s.accountId, { account: true });
  for (const v of vars.vars ?? []) {
    add('var', v.name, v.value, {
      label: v.label ?? v.name,
      ...(v.from === 'input' ? { input: { pattern: v.pattern ?? null, example: v.example ?? null } } : {}),
    });
  }
  for (const ns of ['target', 'workstation'] as const) {
    const o = vars[ns];
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (scalar(v) !== null || used.has(`${ns}.${k}`)) add(ns, k, v);
  }
  // 手册引用了、但响应中没有的路径：列为未解析（红色虚线框）
  for (const p of used) {
    if (out.some((c) => c.key === p)) continue;
    const [ns, ...rest] = p.split('.');
    if (!ns || ns === 'sample' || ns === 'platform' || ns === 'learner') continue;
    if (ns === 'var' && !vars.vars?.some((v) => v.name === rest.join('.'))) continue;
    add(ns, rest.join('.'), lookupVar(vars, p));
  }
  return out;
}

/** 两次变量响应之间值发生变化的键（变量条高亮 2 秒并显示“已更新”）。 */
export function changedKeys(prev: readonly VarChipModel[], next: readonly VarChipModel[]): string[] {
  const before = new Map(prev.map((c) => [c.key, c.value]));
  return next.filter((c) => before.has(c.key) && before.get(c.key) !== c.value && c.value !== null).map((c) => c.key);
}

/** 收集一棵 mdast 中引用到的变量路径（变量条只默认展示这些，以及卡片声明的变量）。 */
export function collectPaths(texts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const p of parseTemplate(t)) if (p.kind === 'var') out.add(p.ph.path);
  return out;
}
