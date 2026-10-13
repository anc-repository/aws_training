// backend/src/adapters/auth/cognito.ts —— AuthPort 的 `cognito` 驱动（Amazon Cognito User Pool）
// aws-jwt-verify 校验访问令牌；Admin* API；JIT 建档
// 脚手架桩：方法抛出 NotImplementedError（HTTP 层映射为 501）。由「auth 模块实现者」填充。
import type { AdapterDeps } from '../types.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AuthPort, AuthPublicConfig, EmbeddedAuthFlows, ExportedIdentity, Principal } from '../../ports/auth.js';
import { notImplemented } from '../../errors.js';

export class CognitoAuth implements AuthPort {
  readonly meta: AdapterMeta = { module: 'auth', driver: 'cognito', awsService: 'Amazon Cognito User Pool', authoritative: true };
  /** local 驱动实现时提供 EmbeddedAuthFlows；cognito 为 null（浏览器直接与 Cognito 交互） */
  readonly flows: EmbeddedAuthFlows | null = null;

  constructor(protected readonly deps: AdapterDeps) {}

  async probe(_opts?: { deep?: boolean }): Promise<ProbeResult> {
    throw notImplemented('CognitoAuth', 'probe', 'auth');
  }

  publicConfig(): AuthPublicConfig {
    throw notImplemented('CognitoAuth', 'publicConfig', 'auth');
  }

  async verifyAccessToken(_token: string): Promise<Principal> {
    throw notImplemented('CognitoAuth', 'verifyAccessToken', 'auth');
  }

  jwks(): { keys: Array<Record<string, string>> } | null {
    throw notImplemented('CognitoAuth', 'jwks', 'auth');
  }

  async adminSetGroups(_subject: string, _groups: string[]): Promise<void> {
    throw notImplemented('CognitoAuth', 'adminSetGroups', 'auth');
  }

  async adminDisableUser(_subject: string): Promise<void> {
    throw notImplemented('CognitoAuth', 'adminDisableUser', 'auth');
  }

  async count(): Promise<number> {
    throw notImplemented('CognitoAuth', 'count', 'auth');
  }

  async exportBatch(_cursor?: string, _limit?: number): Promise<{ items: ExportedIdentity[]; next?: string }> {
    throw notImplemented('CognitoAuth', 'exportBatch', 'auth');
  }

  async importBatch(_items: ExportedIdentity[]): Promise<{ written: number; skipped: number }> {
    throw notImplemented('CognitoAuth', 'importBatch', 'auth');
  }
}
