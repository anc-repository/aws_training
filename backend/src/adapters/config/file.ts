// backend/src/adapters/config/file.ts —— ConfigPort 的 `file` 驱动（本地实现，02#config 第 1 节）
//
// - 运行时热键在 CLOUDALBUM_ENV_DIR/runtime.json（L0：/etc/cloudalbum → 数据卷 etc/），只含业务热键（D7），不含任何驱动开关。
// - 热更新：fs.watch 监听所在**目录**（编辑器“写临时文件再改名”时直接监听文件会丢事件），去抖后重新加载。
// - 校验（zod）：值不合法（例如 maxUploadMb=-1）或 JSON 损坏 → 拒绝这次变更、沿用上一份快照，状态 degraded；
//   未知键（例如有人写了 CACHE_DRIVER）→ 按总纲 4.2 忽略并告警（CFG-009），其余合法键照常生效，状态 degraded 并列出被忽略的键。
// - current() 同步读内存快照，热路径零 I/O。版本号 vN 每次成功加载 +1（capabilities 响应带路径段 config=file:vN）。
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import { DEFAULT_RUNTIME_CONFIG, type ConfigPort, type RuntimeConfig } from '../../ports/config.js';

export const RUNTIME_FILE = 'runtime.json';

/** RuntimeConfig 的 zod 校验（全部键可选，缺省取 DEFAULT_RUNTIME_CONFIG） */
export const RuntimeConfigSchema = z.object({
  maintenanceMode: z.boolean(),
  readOnly: z.boolean(),
  maxUploadMb: z.number().positive().max(5120),
  allowedEmailDomains: z.array(z.string().min(1).regex(/^[a-z0-9.-]+$/i, '只能是域名')),
  feedCacheTtlSec: z.number().int().min(0).max(86_400),
  labBypassEnabled: z.boolean(),
  banner: z.string().max(500),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  featureFlags: z.record(z.string(), z.boolean()),
}).partial();

export const RUNTIME_KEYS: readonly string[] = Object.keys(RuntimeConfigSchema.shape);

export interface RuntimeParseResult { config?: RuntimeConfig; ignoredKeys: string[]; error?: string }

/** 解析 runtime.json 的文本：返回合并默认值后的快照、被忽略的未知键，或拒绝原因 */
export function parseRuntimeConfig(text: string): RuntimeParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ignoredKeys: [], error: `runtime.json 不是合法 JSON：${(e as Error).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ignoredKeys: [], error: 'runtime.json 必须是 JSON 对象' };
  const obj = raw as Record<string, unknown>;
  const ignoredKeys = Object.keys(obj).filter((k) => !RUNTIME_KEYS.includes(k));
  const known = Object.fromEntries(Object.entries(obj).filter(([k]) => RUNTIME_KEYS.includes(k)));
  const r = RuntimeConfigSchema.safeParse(known);
  if (!r.success) {
    return { ignoredKeys, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}：${i.message}`).join('；') };
  }
  const config: RuntimeConfig = {
    ...DEFAULT_RUNTIME_CONFIG,
    ...(r.data as Partial<RuntimeConfig>),
    allowedEmailDomains: (r.data.allowedEmailDomains ?? DEFAULT_RUNTIME_CONFIG.allowedEmailDomains).map((d) => d.toLowerCase()),
    featureFlags: { ...DEFAULT_RUNTIME_CONFIG.featureFlags, ...(r.data.featureFlags ?? {}) },
  };
  if (!r.data.banner) delete config.banner;
  return { config, ignoredKeys };
}

function changedKeysOf(a: RuntimeConfig, b: RuntimeConfig): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify((a as unknown as Record<string, unknown>)[k]) !== JSON.stringify((b as unknown as Record<string, unknown>)[k]));
}

export class FileConfig implements ConfigPort {
  readonly meta: AdapterMeta = { module: 'config', driver: 'file', awsService: null, authoritative: false };
  private snapshot: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG, featureFlags: { ...DEFAULT_RUNTIME_CONFIG.featureFlags } };
  private version = 0;
  private lastLoadedAt = new Date().toISOString();
  private lastError: string | undefined;
  private ignoredKeys: string[] = [];
  private fileExists = false;
  private watcher: FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(next: RuntimeConfig, changedKeys: string[], source: string) => void>();
  private loadedOnce = false;

  constructor(protected readonly deps: AdapterDeps) {}

  get location(): string {
    return path.join(this.deps.cfg.core.CLOUDALBUM_ENV_DIR, RUNTIME_FILE);
  }

  async init(): Promise<void> {
    await this.refresh();
    this.startWatching();
  }

  private startWatching(): void {
    const dir = path.dirname(this.location);
    if (this.watcher || !existsSync(dir)) return;
    try {
      this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== RUNTIME_FILE) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          void this.refresh().catch((e: unknown) => this.deps.logger?.warn('runtime.json reload failed', { error: (e as Error).message }));
        }, 100);
        this.debounce.unref();
      });
      this.watcher.unref();
      this.watcher.on('error', (e) => this.deps.logger?.warn('runtime.json watcher error', { error: e.message }));
    } catch (e) {
      this.deps.logger?.warn('cannot watch runtime.json directory', { dir, error: (e as Error).message });
    }
  }

  current(): RuntimeConfig {
    return this.snapshot;
  }

  onChange(cb: (next: RuntimeConfig, changedKeys: string[], source: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async refresh(): Promise<{ changedKeys: string[] }> {
    let text: string | undefined;
    try {
      text = readFileSync(this.location, 'utf8');
      this.fileExists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.lastError = `无法读取 ${this.location}：${(e as Error).message}`;
        return { changedKeys: [] };
      }
      this.fileExists = false;
    }
    const parsed: RuntimeParseResult = text === undefined
      ? { config: { ...DEFAULT_RUNTIME_CONFIG, featureFlags: { ...DEFAULT_RUNTIME_CONFIG.featureFlags } }, ignoredKeys: [] }
      : parseRuntimeConfig(text);
    if (!parsed.config) {
      this.lastError = parsed.error;
      this.ignoredKeys = parsed.ignoredKeys;
      this.deps.logger?.warn('runtime.json rejected, keeping last snapshot', { error: parsed.error, version: this.version });
      return { changedKeys: [] };
    }
    this.lastError = undefined;
    this.ignoredKeys = parsed.ignoredKeys;
    if (parsed.ignoredKeys.length) {
      this.deps.logger?.warn('CFG-009 runtime.json contains unknown keys (ignored)', { keys: parsed.ignoredKeys });
    }
    const changedKeys = changedKeysOf(this.snapshot, parsed.config);
    if (changedKeys.length || !this.loadedOnce) {
      this.snapshot = parsed.config;
      this.version += 1;
      this.lastLoadedAt = new Date().toISOString();
    }
    const first = !this.loadedOnce;
    this.loadedOnce = true;
    if (changedKeys.length && !first) {
      for (const cb of this.listeners) {
        try {
          cb(this.snapshot, changedKeys, 'file');
        } catch {
          /* 订阅者异常不影响快照 */
        }
      }
    }
    return { changedKeys: first ? [] : changedKeys };
  }

  describeSource(): { driver: 'file' | 'ssm'; location: string; lastLoadedAt: string; version?: string } {
    return { driver: 'file', location: this.location, lastLoadedAt: this.lastLoadedAt, version: `v${this.version}` };
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const data = { location: this.location, exists: this.fileExists, version: `v${this.version}`, lastLoadedAt: this.lastLoadedAt,
      ignoredKeys: this.ignoredKeys, watching: Boolean(this.watcher), ...(this.lastError ? { lastError: this.lastError } : {}) };
    if (this.lastError) {
      return { status: 'degraded', detail: `runtime.json 的最近一次变更被拒绝，沿用快照 v${this.version}：${this.lastError}`, data };
    }
    if (this.ignoredKeys.length) {
      return { status: 'degraded', detail: `runtime.json 中有未知键已被忽略（CFG-009）：${this.ignoredKeys.join(', ')}`, data };
    }
    return {
      status: 'ok',
      detail: this.fileExists
        ? `${this.location}（v${this.version}，目录监听热加载；改热键需要登录这台机器）`
        : `${this.location} 不存在，使用默认值（v${this.version}）`,
      data,
    };
  }

  async close(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
