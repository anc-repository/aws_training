// backend/src/platform/env-schema.ts —— /etc/cloudalbum/platform.env 的严格校验（06 PM-01）
//
// 这份文件只由 `cloudalbum platform:apply-env` 写入（PM-02），内容为 KEY=VALUE 行、只允许 ATL_ 前缀的键、不含机密。
// 启动配置（config/schema.ts 的 Platform 分段）只做宽松的结构解析；这里的严格校验同时用于：
//   - 规则 ATL-CFG-001（启动范围，错误 → 退出码 78）；
//   - `platform:apply-env` 写入前的校验（失败退出 2，不写文件）；
//   - `platform-status` 的 platformEnv.valid / errors。
import { z } from 'zod';

/** platform.env 允许出现的键（06 PM-01 的变量表） */
export const PLATFORM_ENV_KEYS = [
  'ATL_PLATFORM_MODE', 'ATL_SESSION_ID', 'ATL_ENV_ID', 'ATL_ENV_NAME', 'ATL_LAB_ID', 'ATL_VARIANT',
  'ATL_PLATFORM_ORIGIN', 'ATL_PROBE_TOKEN_FILE', 'ATL_RELEASE',
] as const;
export type PlatformEnvKey = (typeof PLATFORM_ENV_KEYS)[number];

/** 平台模式开启时必填的键 */
export const REQUIRED_WHEN_ON: readonly PlatformEnvKey[] = [
  'ATL_SESSION_ID', 'ATL_ENV_ID', 'ATL_ENV_NAME', 'ATL_LAB_ID', 'ATL_PLATFORM_ORIGIN',
];

/** 只用于展示、日志与种子归属的键：只有它们变化时进程收到 SIGHUP，不重启（PM-02） */
export const DISPLAY_ONLY_KEYS: readonly PlatformEnvKey[] = ['ATL_SESSION_ID', 'ATL_LAB_ID', 'ATL_VARIANT', 'ATL_RELEASE'];
/** 变化时需要重启 api / worker 的键 */
export const RESTART_KEYS: readonly PlatformEnvKey[] = ['ATL_PLATFORM_MODE', 'ATL_PLATFORM_ORIGIN', 'ATL_PROBE_TOKEN_FILE'];

export const PLATFORM_PATTERNS: Readonly<Record<Exclude<PlatformEnvKey, 'ATL_PLATFORM_MODE' | 'ATL_RELEASE'>, RegExp>> = {
  ATL_SESSION_ID: /^s[0-9a-hjkmnp-tv-z]{12}$/,
  ATL_ENV_ID: /^[0-9a-hjkmnp-tv-z]{26}$/,
  ATL_ENV_NAME: /^e[a-z0-9]{7}$/,
  ATL_LAB_ID: /^(svc|sc)-[a-z0-9]+(-[a-z0-9]+)*$/,
  ATL_VARIANT: /^[a-z][a-z0-9-]{0,31}$/,
  ATL_PLATFORM_ORIGIN: /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/,
  ATL_PROBE_TOKEN_FILE: /^\/etc\/cloudalbum\/atl\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/,
};
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** 默认的本机探测密钥文件（/etc/cloudalbum 指向数据卷 etc/） */
export const DEFAULT_PROBE_TOKEN_FILE = '/etc/cloudalbum/atl/probe.token';

export type PlatformModeValue = 'on' | 'off';

/** `on`/`1`/`true` → on；`off`/`0`/`false`/空 → off；其他 → null（格式不符） */
export function normalizeMode(raw: string | undefined | null): PlatformModeValue | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'on' || v === '1' || v === 'true') return 'on';
  return null;
}

export interface PlatformEnvValues {
  mode: PlatformModeValue;
  sessionId?: string;
  envId?: string;
  envName?: string;
  labId?: string;
  variant: string;
  origin?: string;
  probeTokenFile: string;
  release?: string;
}

export interface PlatformEnvValidation {
  valid: boolean;
  errors: string[];
  /** 规范化后的取值（valid=false 时尽力而为） */
  values: PlatformEnvValues;
  /** 规范化后的文件内容（ATL_PLATFORM_MODE 写为 on/off；只含已知键；键按变量表顺序） */
  normalized: Record<string, string>;
}

export interface ValidateOptions {
  /** 当前 CLOUDALBUM_ENV：开启时必须等于 ATL_ENV_NAME */
  cloudalbumEnv?: string;
  /** 文件中的全部键（含非 ATL_ 键）；用于报告“只允许 ATL_ 前缀” */
  rawKeys?: readonly string[];
}

/** zod 形式（单元测试与文档用）：每个变量的格式；跨字段规则在 validatePlatformEnv 中 */
export const PlatformEnvSchema = z.object({
  ATL_PLATFORM_MODE: z.string().refine((v) => normalizeMode(v) !== null, 'ATL_PLATFORM_MODE 只接受 on|off（或 1|true|0|false）'),
  ATL_SESSION_ID: z.string().regex(PLATFORM_PATTERNS.ATL_SESSION_ID).optional(),
  ATL_ENV_ID: z.string().regex(PLATFORM_PATTERNS.ATL_ENV_ID).optional(),
  ATL_ENV_NAME: z.string().regex(PLATFORM_PATTERNS.ATL_ENV_NAME).optional(),
  ATL_LAB_ID: z.string().regex(PLATFORM_PATTERNS.ATL_LAB_ID).optional(),
  ATL_VARIANT: z.string().regex(PLATFORM_PATTERNS.ATL_VARIANT).optional(),
  ATL_PLATFORM_ORIGIN: z.string().regex(PLATFORM_PATTERNS.ATL_PLATFORM_ORIGIN).optional(),
  ATL_PROBE_TOKEN_FILE: z.string().regex(PLATFORM_PATTERNS.ATL_PROBE_TOKEN_FILE).optional(),
  ATL_RELEASE: z.string().regex(SEMVER_RE).optional(),
}).strict();

/** 校验 platform.env 的内容（PM-01 变量表 + ATL-CFG-001 的条件） */
export function validatePlatformEnv(raw: Readonly<Record<string, string | undefined>>, opts: ValidateOptions = {}): PlatformEnvValidation {
  const errors: string[] = [];
  const keys = opts.rawKeys ?? Object.keys(raw);
  for (const k of keys) {
    if (!k.startsWith('ATL_')) errors.push(`platform.env 只允许 ATL_ 前缀的键，出现了 ${k}`);
    else if (!(PLATFORM_ENV_KEYS as readonly string[]).includes(k)) errors.push(`platform.env 出现未知的键 ${k}`);
  }
  const get = (k: PlatformEnvKey) => {
    const v = raw[k];
    return v === undefined || v === '' ? undefined : v.trim();
  };
  const modeRaw = get('ATL_PLATFORM_MODE');
  const mode = normalizeMode(modeRaw);
  if (mode === null) errors.push(`ATL_PLATFORM_MODE=${modeRaw} 不合法（on|off，同时接受 1|true|0|false）`);
  const on = mode !== 'off';
  for (const [k, re] of Object.entries(PLATFORM_PATTERNS) as Array<[PlatformEnvKey, RegExp]>) {
    const v = get(k);
    if (v === undefined) {
      if (on && REQUIRED_WHEN_ON.includes(k)) errors.push(`平台模式开启时 ${k} 必填`);
      continue;
    }
    if (!re.test(v)) errors.push(`${k} 格式不符（${re.source}）`);
  }
  const release = get('ATL_RELEASE');
  if (release !== undefined && !SEMVER_RE.test(release)) errors.push('ATL_RELEASE 必须是 semver');
  const envName = get('ATL_ENV_NAME');
  if (on && envName && opts.cloudalbumEnv !== undefined && envName !== opts.cloudalbumEnv) {
    errors.push(`ATL_ENV_NAME=${envName} 与 CLOUDALBUM_ENV=${opts.cloudalbumEnv} 不一致`);
  }
  const values: PlatformEnvValues = {
    mode: mode ?? 'off',
    variant: get('ATL_VARIANT') ?? 'default',
    probeTokenFile: get('ATL_PROBE_TOKEN_FILE') ?? DEFAULT_PROBE_TOKEN_FILE,
    ...(get('ATL_SESSION_ID') ? { sessionId: get('ATL_SESSION_ID')! } : {}),
    ...(get('ATL_ENV_ID') ? { envId: get('ATL_ENV_ID')! } : {}),
    ...(envName ? { envName } : {}),
    ...(get('ATL_LAB_ID') ? { labId: get('ATL_LAB_ID')! } : {}),
    ...(get('ATL_PLATFORM_ORIGIN') ? { origin: get('ATL_PLATFORM_ORIGIN')! } : {}),
    ...(release ? { release } : {}),
  };
  const normalized: Record<string, string> = {};
  for (const k of PLATFORM_ENV_KEYS) {
    if (k === 'ATL_PLATFORM_MODE') { normalized[k] = mode ?? (modeRaw ?? 'off'); continue; }
    const v = get(k);
    if (v !== undefined) normalized[k] = v;
  }
  return { valid: errors.length === 0, errors, values, normalized };
}

/** 渲染 platform.env（KEY=VALUE 行；值都通过了正则，不需要引号） */
export function renderPlatformEnv(normalized: Readonly<Record<string, string>>): string {
  const lines = ['# /etc/cloudalbum/platform.env — written by `cloudalbum platform:apply-env` only (06 PM-01/02); do not edit'];
  for (const k of PLATFORM_ENV_KEYS) if (normalized[k] !== undefined) lines.push(`${k}=${normalized[k]}`);
  return `${lines.join('\n')}\n`;
}

/** Nginx 槽位 slot-atl-frame-ancestors.inc 的内容（PM-20）：开启时一行 map 条目，关闭时为空 */
export function renderFrameAncestorsSlot(values: Pick<PlatformEnvValues, 'mode' | 'origin'>): string {
  const head = '# slot-atl-frame-ancestors.inc — rendered by `cloudalbum platform:apply-env` (06 PM-20); empty = header not sent\n';
  if (values.mode !== 'on' || !values.origin) return head;
  return `${head}"" "frame-ancestors 'self' ${values.origin}";\n`;
}

/** CSP 头的取值（应用侧中间件与 Nginx 槽位同一个字符串） */
export function frameAncestorsValue(origin: string): string {
  return `frame-ancestors 'self' ${origin}`;
}

/** 新旧文件的差异 → 进程处理方式（PM-02 `--restart auto`） */
export function applyAction(prev: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): { changed: string[]; action: 'none' | 'reload' | 'restart' } {
  const changed = PLATFORM_ENV_KEYS.filter((k) => (prev[k] ?? '') !== (next[k] ?? ''));
  if (!changed.length) return { changed: [], action: 'none' };
  const restart = changed.some((k) => RESTART_KEYS.includes(k) || !DISPLAY_ONLY_KEYS.includes(k));
  return { changed: [...changed], action: restart ? 'restart' : 'reload' };
}
