// backend/src/ports/config.ts （总纲 §4.2，照录）
import type { Adapter } from './common.js';

/** 运行时配置（可热更新的业务热键），与“启动配置”（环境变量，含模块开关）严格区分。
 *  这是 ConfigPort 能管理的全部键（D7）：不包含任何 *_DRIVER、MODULE_*、模块 Outputs；未知键被忽略并告警（CFG-009） */
export interface RuntimeConfig {
  maintenanceMode: boolean;
  readOnly: boolean;                 // 数据迁移窗口使用
  maxUploadMb: number;               // 上传上限的唯一来源
  allowedEmailDomains: string[];     // F3
  feedCacheTtlSec: number;
  labBypassEnabled: boolean;         // X-Compare-Bypass 总开关
  banner?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  featureFlags: Record<string, boolean>;   // 例如 'lab.faults'（8.4）、'analytics.shadowDb'
}

/** RuntimeConfig 的默认值（runtime.json 不存在或缺键时使用）。 */
export const DEFAULT_RUNTIME_CONFIG: Readonly<RuntimeConfig> = Object.freeze({
  maintenanceMode: false,
  readOnly: false,
  maxUploadMb: 25,
  allowedEmailDomains: [],
  feedCacheTtlSec: 30,
  labBypassEnabled: true,
  logLevel: 'info',
  featureFlags: {},
});

export interface ConfigPort extends Adapter {
  current(): RuntimeConfig;          // 同步读内存快照，热路径零 I/O
  onChange(cb: (next: RuntimeConfig, changedKeys: string[], source: string) => void): () => void;
  /** file：监听 /etc/cloudalbum 目录（兼容“写临时文件再改名”）；ssm：每 30s GetParametersByPath('/cloudalbum/<env>/runtime/') */
  refresh(): Promise<{ changedKeys: string[] }>;
  describeSource(): { driver: 'file' | 'ssm'; location: string; lastLoadedAt: string; version?: string };
}
// file 档的 /etc/cloudalbum/runtime.json 对应用只读（改它要登录机器）；ssm 档在控制台/CLI 修改，路径头 config=ssm:v<版本>。
// “改一个热键要不要登录服务器”正是 config 模块的对比点。ConfigPort 不解析 Secrets Manager 引用，敏感值一律经 SecretsPort。
// 模块开关只由 scripts/module 写入 modules.d；ConfigPort 不提供“远程改驱动并重启”，也没有 last-known-good 装配。
