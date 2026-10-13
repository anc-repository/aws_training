// backend/src/platform/mode.ts —— 平台模式的唯一判定处（06 PM-01、§1.5 第 1 条）
//
// 应用内一律调用 platformMode() / platformState()，不得另行读取 ATL_PLATFORM_MODE。
// - 取值来自分层配置的第 1b 层 /etc/cloudalbum/platform.env（config/load-env.ts），由 container 在装配时 initPlatform()；
// - 只改了 ATL_SESSION_ID / ATL_LAB_ID / ATL_VARIANT / ATL_RELEASE 时，`platform:apply-env` 向 api / worker 发 SIGHUP，
//   进程调用 reloadPlatformDisplay() 只重新加载这四个展示字段（PM-02）；其余键变化时进程被重启。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PlatformInfo } from '@cloudalbum/contracts';
import { parseEnvFile } from '../config/load-env.js';
import {
  DEFAULT_PROBE_TOKEN_FILE, DISPLAY_ONLY_KEYS, validatePlatformEnv, type PlatformEnvValues,
} from './env-schema.js';

export const PLATFORM_ENV_FILE = 'platform.env';

export interface PlatformState extends PlatformEnvValues {
  /** 配置目录（/etc/cloudalbum → 数据卷 etc/） */
  envDir: string;
  /** platform.env 是否存在 */
  present: boolean;
  /** 严格校验结果（ATL-CFG-001） */
  valid: boolean;
  errors: string[];
}

export interface PlatformPaths {
  /** /opt/atl（检查包安装位置，PM-04） */
  atlRoot: string;
  /** 发布包清单（.release-manifest.json：atlBundleDigest、ssmAgentMinVersion） */
  releaseManifest: string;
  /** SSM Agent 版本检查结果（PM-06） */
  ssmAgentCheck: string;
}

const DEFAULT_PATHS: PlatformPaths = {
  atlRoot: '/opt/atl',
  releaseManifest: '/opt/cloudalbum/.release-manifest.json',
  ssmAgentCheck: '/opt/cloudalbum/.ssm-agent-check.json',
};

let paths: PlatformPaths = { ...DEFAULT_PATHS };

function offState(envDir = '/etc/cloudalbum'): PlatformState {
  return { mode: 'off', variant: 'default', probeTokenFile: DEFAULT_PROBE_TOKEN_FILE, envDir, present: false, valid: true, errors: [] };
}

let state: PlatformState = offState();

/** 平台模式是否开启（唯一判定处） */
export function platformMode(): boolean {
  return state.mode === 'on';
}

export function platformState(): Readonly<PlatformState> {
  return state;
}

export function platformPaths(): Readonly<PlatformPaths> {
  return paths;
}

/** 测试 / 开发机：覆盖 /opt/atl 等主机路径 */
export function setPlatformPaths(p: Partial<PlatformPaths>): void {
  paths = { ...paths, ...p };
}

export function resetPlatformPaths(): void {
  paths = { ...DEFAULT_PATHS };
}

/** 只取 ATL_ 前缀的键（与 load-env 第 1b 层一致） */
export function atlKeys(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith('ATL_') && v !== undefined) out[k] = v;
  return out;
}

/** 读取 <envDir>/platform.env（不存在时 present=false） */
export function readPlatformEnvFile(envDir: string): { present: boolean; values: Record<string, string>; keys: string[]; file: string } {
  const file = path.join(envDir, PLATFORM_ENV_FILE);
  if (!existsSync(file)) return { present: false, values: {}, keys: [], file };
  const values = parseEnvFile(readFileSync(file, 'utf8'));
  return { present: true, values, keys: Object.keys(values), file };
}

/**
 * 由分层配置合并结果建立平台状态（container 装配时调用；CLI 子命令也可以直接调用）。
 * `fileKeys`：platform.env 中实际出现的全部键（含被 load-env 丢弃的非 ATL_ 键），用于严格校验的报告。
 */
export function initPlatform(input: { env: Readonly<Record<string, string | undefined>>; envDir: string; cloudalbumEnv?: string;
  present?: boolean; fileKeys?: readonly string[] }): PlatformState {
  const atl = atlKeys(input.env);
  const present = input.present ?? Object.keys(atl).length > 0;
  if (!present) {
    state = offState(input.envDir);
    return state;
  }
  const v = validatePlatformEnv(atl, { ...(input.cloudalbumEnv !== undefined ? { cloudalbumEnv: input.cloudalbumEnv } : {}),
    ...(input.fileKeys ? { rawKeys: input.fileKeys } : {}) });
  state = { ...v.values, envDir: input.envDir, present: true, valid: v.valid, errors: v.errors };
  return state;
}

/** 测试用：直接设置平台状态 */
export function setPlatformStateForTests(s: Partial<PlatformState> | null): void {
  state = s ? { ...offState(s.envDir), present: true, ...s } : offState();
}

/**
 * SIGHUP：重新读取 platform.env，只更新展示字段（ATL_SESSION_ID、ATL_LAB_ID、ATL_VARIANT、ATL_RELEASE）。
 * 返回实际变化的键。文件缺失或校验失败时不改动（下一次重启会以 ATL-CFG-001 报告）。
 */
export function reloadPlatformDisplay(envDir: string = state.envDir, cloudalbumEnv?: string): string[] {
  const f = readPlatformEnvFile(envDir);
  if (!f.present) return [];
  const v = validatePlatformEnv(atlKeys(f.values), { ...(cloudalbumEnv !== undefined ? { cloudalbumEnv } : {}), rawKeys: f.keys });
  if (!v.valid) return [];
  const changed: string[] = [];
  const next = { ...state };
  const map: Record<string, keyof PlatformEnvValues> = {
    ATL_SESSION_ID: 'sessionId', ATL_LAB_ID: 'labId', ATL_VARIANT: 'variant', ATL_RELEASE: 'release',
  };
  for (const k of DISPLAY_ONLY_KEYS) {
    const field = map[k]!;
    const before = state[field];
    const after = v.values[field];
    if (before !== after) {
      changed.push(k);
      if (after === undefined) delete (next as Partial<PlatformState>)[field];
      else (next as Record<string, unknown>)[field] = after;
    }
  }
  state = next;
  return changed;
}

/**
 * 本机探测密钥文件的实际路径：ATL_PROBE_TOKEN_FILE 写的是 /etc/cloudalbum/atl/… 形式（PM-09）；
 * /etc/cloudalbum 指向配置目录，所以把这个前缀映射到 envDir（开发机上 envDir 不是 /etc/cloudalbum）。
 */
export function probeTokenPath(s: Pick<PlatformState, 'probeTokenFile' | 'envDir'> = state): string {
  const f = s.probeTokenFile || DEFAULT_PROBE_TOKEN_FILE;
  const prefix = '/etc/cloudalbum/';
  if (f.startsWith(prefix)) {
    const rel = f.slice(prefix.length).split('/');
    return path.join(s.envDir, ...rel);
  }
  return f;
}

/** 读取本机探测密钥（atlpk1.<base64url>）；不存在或格式不符时 null。不打印、不记日志。 */
export function readLocalProbeSecret(s: Pick<PlatformState, 'probeTokenFile' | 'envDir'> = state): string | null {
  try {
    const v = readFileSync(probeTokenPath(s), 'utf8').trim();
    return /^atlpk1\.[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** 密钥指纹：sha256:<前 12 位十六进制>（PM-09：命令只打印指纹） */
export function secretFingerprint(secret: string): string {
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 12)}`;
}

/** 检查包：已安装的摘要目录（按 mtime 新的在前）与发布包登记的摘要（PM-04） */
export function checkBundleInfo(p: PlatformPaths = paths): { installed: string[]; releaseDigest: string | null } {
  const dir = path.join(p.atlRoot, 'checks');
  let installed: string[] = [];
  try {
    installed = readdirSync(dir)
      .filter((d) => /^[a-f0-9]{64}$/.test(d))
      .map((d) => ({ d, t: statSync(path.join(dir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((x) => x.d);
  } catch {
    installed = [];
  }
  let releaseDigest: string | null = null;
  try {
    const m = JSON.parse(readFileSync(p.releaseManifest, 'utf8')) as { atlBundleDigest?: unknown };
    releaseDigest = typeof m.atlBundleDigest === 'string' && /^[a-f0-9]{64}$/.test(m.atlBundleDigest) ? m.atlBundleDigest : null;
  } catch {
    releaseDigest = null;
  }
  return { installed, releaseDigest };
}

/**
 * capabilities 的 `app.platform`（PM-03）：平台模式关闭时 undefined（整个键不出现）；公开视图只有 { mode: 'on' }；
 * 管理员、atl-probe、atl-lab 看到完整字段。
 */
export function platformInfo(privileged: boolean): PlatformInfo | undefined {
  if (!platformMode()) return undefined;
  if (!privileged) return { mode: 'on' };
  const s = state;
  return {
    mode: 'on',
    ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    ...(s.envId ? { envId: s.envId } : {}),
    ...(s.envName ? { envName: s.envName } : {}),
    ...(s.labId ? { labId: s.labId } : {}),
    variant: s.variant,
    ...(s.origin ? { origin: s.origin } : {}),
    ...(s.release ? { release: s.release } : {}),
    probe: { localToken: readLocalProbeSecret(s) ? 'present' : 'missing' },
    checkBundle: checkBundleInfo(),
  };
}
