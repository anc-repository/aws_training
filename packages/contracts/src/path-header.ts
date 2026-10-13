/**
 * `X-CloudAlbum-Path` formatter / parser (modular-design.md §7.2).
 *
 * ```abnf
 * X-CloudAlbum-Path = segment *( ";" segment )
 * segment           = key "=" value
 * key               = module-id / "entry" / "inst" / "az" / "bypass" / "more"
 * value             = driver [ "@" host-class ] [ ":" outcome ]   ; 小写字母、数字、"-"、">"、","
 * ```
 *
 * - 键只能是模块 id 或 entry / inst / az / bypass / more；值的第一部分必须是驱动名（= 开关取值）。
 * - 超过 512 字节时截断：从末尾丢弃模块段，追加 `more=<被省略的段数>`。
 * - 解析器兼容“只有结果的简写”（例如 `cache=hit` → `{ outcome: 'hit' }`）。
 */
import { isModuleId, type ModuleId } from './module-ids.js';

export const PATH_META_KEYS = ['entry', 'inst', 'az', 'bypass', 'more'] as const;
export type PathMetaKey = (typeof PATH_META_KEYS)[number];
export type PathKey = ModuleId | PathMetaKey;

export const PATH_HEADER_MAX_BYTES = 512;

/** 解析器认作“只有结果的简写”的取值（总纲 7.2 最后一段：前端解析器兼容 `cache=hit`）。 */
export const SHORTHAND_OUTCOMES: ReadonlySet<string> = new Set([
  'hit', 'miss', 'bypass', 'error-bypass', 'error', 'fault',
]);

export interface PathValue {
  /** 驱动名（= 开关取值）；简写形式时为 undefined */
  driver?: string;
  /** 主机类别，例如 `rds`、`elasticache`、`local`、`nginx` */
  hostClass?: string;
  /** 结果，例如 `hit`、`presign`、`error-bypass`、`v12` */
  outcome?: string;
}

export interface PathModuleSegment extends PathValue {
  module: ModuleId;
  /** 原始值（规范化后的小写字符串） */
  raw: string;
}

export interface ParsedPath {
  entry?: string;
  inst?: string;
  az?: string;
  bypass: string[];
  /** 被截断省略的段数 */
  more?: number;
  /** 模块段，按首次调用顺序 */
  modules: PathModuleSegment[];
  /** 无法识别的段（不是模块 id，也不是元数据键）；规范上不应出现，保留给调试 */
  unknown: Array<{ key: string; value: string }>;
}

export interface PathHeaderInput {
  entry?: string;
  inst?: string;
  az?: string;
  /** [模块, 值] 对，值为 `driver[@host][:outcome]`；顺序 = 首次调用顺序 */
  modules?: Iterable<readonly [ModuleId, string]>;
  bypass?: Iterable<string>;
}

const VALUE_ALLOWED = /[^a-z0-9\-,>@:]/g;
const TOKEN_ALLOWED = /[^a-z0-9\-,>]/g;

/** 把任意字符串规范化为路径值可用的 token（不含结构字符 `@` `:`）。 */
export function sanitizePathToken(raw: string): string {
  return raw.trim().toLowerCase().replace(TOKEN_ALLOWED, '-');
}

/** 规范化完整的段值（保留结构字符 `@` `:`）。 */
export function sanitizePathValue(raw: string): string {
  return raw.trim().toLowerCase().replace(VALUE_ALLOWED, '-');
}

/** `driver[@hostClass][:outcome]` */
export function formatPathValue(value: PathValue): string {
  let out = value.driver ? sanitizePathToken(value.driver) : '';
  if (value.hostClass) out += `@${sanitizePathToken(value.hostClass)}`;
  if (value.outcome) out += out ? `:${sanitizePathToken(value.outcome)}` : sanitizePathToken(value.outcome);
  return out;
}

/** 解析单个段值。`hit` 之类的简写只填 outcome。 */
export function parsePathValue(raw: string): PathValue {
  const value = raw.trim().toLowerCase();
  if (!value) return {};
  if (!value.includes('@') && !value.includes(':') && SHORTHAND_OUTCOMES.has(value)) {
    return { outcome: value };
  }
  const colon = value.indexOf(':');
  const head = colon === -1 ? value : value.slice(0, colon);
  const outcome = colon === -1 ? undefined : value.slice(colon + 1) || undefined;
  const at = head.indexOf('@');
  const driver = (at === -1 ? head : head.slice(0, at)) || undefined;
  const hostClass = at === -1 ? undefined : head.slice(at + 1) || undefined;
  const result: PathValue = {};
  if (driver !== undefined) result.driver = driver;
  if (hostClass !== undefined) result.hostClass = hostClass;
  if (outcome !== undefined) result.outcome = outcome;
  return result;
}

function byteLength(s: string): number {
  // 规范化后的头只含 ASCII；保守起见仍按 UTF-8 计算
  return new TextEncoder().encode(s).length;
}

/**
 * 生成 `X-CloudAlbum-Path`。段顺序：entry、inst、az、模块（首次调用顺序）、bypass；
 * 超过 `maxBytes`（默认 512）时从末尾丢弃模块段并追加 `more=N`。
 */
export function formatPathHeader(input: PathHeaderInput, opts: { maxBytes?: number } = {}): string {
  const maxBytes = opts.maxBytes ?? PATH_HEADER_MAX_BYTES;
  const head: string[] = [];
  if (input.entry) head.push(`entry=${sanitizePathValue(input.entry)}`);
  if (input.inst) head.push(`inst=${sanitizePathToken(input.inst)}`);
  if (input.az) head.push(`az=${sanitizePathToken(input.az)}`);

  const seen = new Set<string>();
  const modules: string[] = [];
  for (const [module, value] of input.modules ?? []) {
    if (!isModuleId(module) || seen.has(module)) continue;
    const v = sanitizePathValue(value);
    if (!v) continue;
    seen.add(module);
    modules.push(`${module}=${v}`);
  }

  const bypassKeys = [...new Set([...(input.bypass ?? [])].map(sanitizePathToken).filter(Boolean))];
  const tail = bypassKeys.length ? [`bypass=${bypassKeys.join(',')}`] : [];

  const join = (segs: string[]) => segs.join(';');
  let full = join([...head, ...modules, ...tail]);
  if (byteLength(full) <= maxBytes) return full;

  // 截断：先丢模块段（从末尾），再丢 bypass、az、inst；entry 永远保留
  const kept = [...modules];
  let dropped = 0;
  const candidate = () => join([...head, ...kept, ...tail, `more=${dropped}`]);
  while (kept.length > 0) {
    kept.pop();
    dropped += 1;
    full = candidate();
    if (byteLength(full) <= maxBytes) return full;
  }
  const headKept = [...head];
  const tailKept = [...tail];
  while (byteLength(join([...headKept, ...tailKept, `more=${dropped}`])) > maxBytes) {
    if (tailKept.length) { tailKept.pop(); dropped += 1; continue; }
    if (headKept.length > 1) { headKept.pop(); dropped += 1; continue; }
    break;
  }
  return join([...headKept, ...tailKept, `more=${dropped}`]);
}

/** 解析 `X-CloudAlbum-Path`。容错：忽略空段、大小写不敏感、未知键放入 `unknown`。 */
export function parsePathHeader(header: string | null | undefined): ParsedPath {
  const parsed: ParsedPath = { bypass: [], modules: [], unknown: [] };
  if (!header) return parsed;
  const index = new Map<ModuleId, number>();
  for (const rawSeg of header.split(';')) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) {
      parsed.unknown.push({ key: seg.toLowerCase(), value: '' });
      continue;
    }
    const key = seg.slice(0, eq).trim().toLowerCase();
    const value = seg.slice(eq + 1).trim().toLowerCase();
    switch (key) {
      case 'entry': parsed.entry = value; break;
      case 'inst': parsed.inst = value; break;
      case 'az': parsed.az = value; break;
      case 'bypass': parsed.bypass = value.split(',').map((s) => s.trim()).filter(Boolean); break;
      case 'more': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) parsed.more = n;
        break;
      }
      default:
        if (isModuleId(key)) {
          const segment: PathModuleSegment = { module: key, raw: value, ...parsePathValue(value) };
          const at = index.get(key);
          if (at === undefined) {
            index.set(key, parsed.modules.length);
            parsed.modules.push(segment);
          } else {
            parsed.modules[at] = segment;
          }
        } else {
          parsed.unknown.push({ key, value });
        }
    }
  }
  return parsed;
}

/**
 * 路径签名：去掉 `inst` / `az`（以及截断标记）后的路径头，LabMetricsStore 用它分组延迟分布（§7.3）。
 */
export function pathSignature(input: string | ParsedPath): string {
  const p = typeof input === 'string' ? parsePathHeader(input) : input;
  return formatPathHeader(
    {
      ...(p.entry ? { entry: p.entry } : {}),
      modules: p.modules.map((m) => [m.module, m.raw] as const),
      bypass: p.bypass,
    },
    { maxBytes: Number.MAX_SAFE_INTEGER },
  );
}
