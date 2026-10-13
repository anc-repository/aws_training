// backend/src/adapters/auth/local.ts —— AuthPort 的 `local` 驱动（本地实现）
// argon2id + ES256 JWT（jose）+ JWKS（当前与上一版本 kid）；tv 声明与 users.token_version 比对
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「L0 本地实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AuthPort, AuthPublicConfig, EmbeddedAuthFlows, ExportedIdentity, Principal } from '../../ports/auth.js';
import { notImplemented } from '../../errors.js';

export class LocalAuth implements AuthPort {
  readonly meta: AdapterMeta = { module: 'auth', driver: 'local', awsService: null, authoritative: true };
  /** local 驱动实现时提供 EmbeddedAuthFlows；cognito 为 null（浏览器直接与 Cognito 交互） */
  readonly flows: EmbeddedAuthFlows | null = null;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('LocalAuth', 'probe', 'auth');
  }

  publicConfig(): AuthPublicConfig {
    throw notImplemented('LocalAuth', 'publicConfig', 'auth');
  }

  async verifyAccessToken(_token: string): Promise<Principal> {
    throw notImplemented('LocalAuth', 'verifyAccessToken', 'auth');
  }

  jwks(): { keys: Array<Record<string, string>> } | null {
    throw notImplemented('LocalAuth', 'jwks', 'auth');
  }

  async adminSetGroups(_subject: string, _groups: string[]): Promise<void> {
    throw notImplemented('LocalAuth', 'adminSetGroups', 'auth');
  }

  async adminDisableUser(_subject: string): Promise<void> {
    throw notImplemented('LocalAuth', 'adminDisableUser', 'auth');
  }

  async count(): Promise<number> {
    throw notImplemented('LocalAuth', 'count', 'auth');
  }

  async exportBatch(_cursor?: string, _limit?: number): Promise<{ items: ExportedIdentity[]; next?: string }> {
    throw notImplemented('LocalAuth', 'exportBatch', 'auth');
  }

  async importBatch(_items: ExportedIdentity[]): Promise<{ written: number; skipped: number }> {
    throw notImplemented('LocalAuth', 'importBatch', 'auth');
  }
}
