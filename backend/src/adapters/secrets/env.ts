// backend/src/adapters/secrets/env.ts —— SecretsPort 的 `env` 驱动（本地实现，02#secrets 第 1 节）
//
// 从分层 env 读取（deps.env = 第 1～5 层合并结果，含 secrets.env；不是 process.env）：变量名 = secretEnvName(逻辑名)；
// 文件型（jwt-signing-key、cloudfront-signing-key）的变量是 *_FILE，值是 PEM 文件路径，读出文件内容返回。
// - 未配置 → 抛出 SecretNotFoundError（调用方决定是否致命；例如 CFG-007 指纹检查会跳过并告警）。
// - 文件内容按 (mtime, size) 缓存：`scripts/secrets rotate jwt-signing-key` 换掉 PEM 后，下一次读取即拿到新值
//   （auth 遇到未知 kid 时据此重新加载）；onRotate 在 env 驱动下只登记回调，永远不会触发。
// - 没有版本、没有审计：这正是与 Secrets Manager 对比的地方。
import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import { FILE_SECRETS, secretEnvName, type SecretName, type SecretsPort } from '../../ports/secrets.js';

export class SecretNotFoundError extends Error {
  readonly code = 'SECRET_NOT_FOUND';
  readonly status = 503;
  constructor(readonly secret: SecretName, readonly envName: string, reason?: string) {
    super(`机密 ${secret} 不可用：${reason ?? `secrets.env 中没有 ${envName}`}`);
    this.name = 'SecretNotFoundError';
  }
}

/** L0 引导脚本（l0-bootstrap.sh 第 10 步）生成的机密；探针检查它们是否齐全 */
export const L0_REQUIRED_SECRETS: readonly SecretName[] = [
  'jwt-signing-key', 'upload-hmac-key', 'media-hmac-key', 'callback-hmac-key', 'internal-hmac-key', 'cookie-secret', 'local-master-key',
];
/** 缺失即 error（其余缺失为 degraded）：签名私钥与主密钥缺失会让认证 / 已加密字段整体不可用 */
const CRITICAL: ReadonlySet<SecretName> = new Set(['jwt-signing-key', 'local-master-key']);

export class EnvSecrets implements SecretsPort {
  readonly meta: AdapterMeta = { module: 'secrets', driver: 'env', awsService: null, authoritative: true };
  private readonly fileCache = new Map<string, { value: string; mtimeMs: number; size: number }>();
  private readonly rotateListeners = new Map<SecretName, Set<(next: string) => void>>();

  constructor(protected readonly deps: AdapterDeps) {}

  /** 文件型机密的路径：分层 env 中的 *_FILE；jwt-signing-key 未写时取 auth 分段的默认值（由配置目录派生） */
  filePathOf(name: SecretName): string | undefined {
    const envName = secretEnvName(name);
    const v = this.deps.env[envName];
    if (v) return v;
    if (name === 'jwt-signing-key') return this.deps.cfg.auth.JWT_SIGNING_KEY_FILE;
    return undefined;
  }

  private readFile(name: SecretName, file: string): string {
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(file);
    } catch (e) {
      throw new SecretNotFoundError(name, secretEnvName(name), `无法读取 ${file}（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）`);
    }
    const cached = this.fileCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.value;
    let value: string;
    try {
      value = readFileSync(file, 'utf8');
    } catch (e) {
      throw new SecretNotFoundError(name, secretEnvName(name), `无法读取 ${file}（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）`);
    }
    if (!value.trim()) throw new SecretNotFoundError(name, secretEnvName(name), `${file} 为空`);
    this.fileCache.set(file, { value, mtimeMs: st.mtimeMs, size: st.size });
    return value;
  }

  async get(name: SecretName): Promise<string> {
    return this.getSync(name);
  }

  getSync(name: SecretName): string {
    const envName = secretEnvName(name);
    if (FILE_SECRETS.has(name)) {
      const file = this.filePathOf(name);
      if (!file) throw new SecretNotFoundError(name, envName);
      return this.readFile(name, file);
    }
    const v = this.deps.env[envName];
    if (v === undefined || v === '') throw new SecretNotFoundError(name, envName);
    return v;
  }

  async describe(name: SecretName): Promise<{ source: 'env' | 'secretsmanager'; origin: 'instance' | 'bundle' | 'aws'; version?: string; lastRotatedAt?: string }> {
    const out: { source: 'env'; origin: 'instance' | 'bundle' | 'aws'; version?: string; lastRotatedAt?: string } = {
      source: 'env', origin: this.deps.cfg.core.SECRETS_ORIGIN,
    };
    if (FILE_SECRETS.has(name)) {
      const file = this.filePathOf(name);
      try {
        if (file) out.lastRotatedAt = statSync(file).mtime.toISOString();
      } catch {
        /* 文件不存在：不报告时间 */
      }
    }
    return out;
  }

  /** env 驱动没有远端轮换：只登记回调（重启后读到新值），返回注销函数 */
  onRotate(name: SecretName, cb: (next: string) => void): () => void {
    const set = this.rotateListeners.get(name) ?? new Set();
    set.add(cb);
    this.rotateListeners.set(name, set);
    return () => set.delete(cb);
  }

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    const missing: SecretName[] = [];
    for (const name of L0_REQUIRED_SECRETS) {
      try {
        if (FILE_SECRETS.has(name)) {
          const file = this.filePathOf(name);
          if (!file) throw new SecretNotFoundError(name, secretEnvName(name));
          accessSync(file, fsConstants.R_OK);
        } else {
          this.getSync(name);
        }
      } catch {
        missing.push(name);
      }
    }
    const origin = this.deps.cfg.core.SECRETS_ORIGIN;
    const present = L0_REQUIRED_SECRETS.length - missing.length;
    const data = { origin, present, missing, file: `${this.deps.cfg.core.CLOUDALBUM_ENV_DIR}/secrets.env` };
    if (!missing.length) {
      return { status: 'ok', detail: `secrets.env + keys/*.pem（来源 ${origin}）· ${present} 个机密齐全 · 无版本、无审计`, data };
    }
    const critical = missing.some((m) => CRITICAL.has(m));
    return {
      status: critical ? 'error' : 'degraded',
      detail: `缺少机密：${missing.map((m) => secretEnvName(m)).join(', ')}（l0-bootstrap.sh 或 npm run dev:init 生成）`,
      data,
    };
  }
}
