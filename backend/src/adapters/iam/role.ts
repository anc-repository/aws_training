// backend/src/adapters/iam/role.ts —— AwsCredentialsPort 的 `role` 驱动（AWS IAM）
//
// IMDSv2 实例角色凭证：显式使用 @aws-sdk/credential-providers 的 fromInstanceMetadata({ timeout, maxRetries })（不用 SDK 默认凭证链：
// 默认链会优先读环境变量，残留的 AWS_ACCESS_KEY_ID 会悄悄覆盖角色凭证）。外面包一层 memoize：过期前 5 分钟刷新、并发请求合并；
// forceRefresh() 丢弃缓存后重新从 IMDS 取（撤销会话实验）。探针：sts:GetCallerIdentity（ARN 含 IAM_EXPECTED_ROLE）+ iam:GetRole。
import type { AdapterDeps } from '../types.js';
import { loadAwsPackage, type AwsClients } from '../aws/clients.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import type { AwsCredentials, AwsCredentialsPort } from '../../ports/aws-credentials.js';
import { describeCaller, probeClients, probeWithDetector, type CredentialDescription } from './shared.js';

/** 距过期不足该时长时主动刷新 */
export const REFRESH_BEFORE_MS = 5 * 60_000;

export type CredentialSource = () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date }>;

export class RoleCredentials implements AwsCredentialsPort {
  readonly meta: AdapterMeta = { module: 'iam', driver: 'role', awsService: 'AWS IAM', authoritative: false };
  readonly mode = 'role' as const;
  private cached?: AwsCredentials;
  private inflight?: Promise<AwsCredentials> | undefined;
  private source?: CredentialSource;
  private clients?: AwsClients;
  private lastRefreshError?: string;

  /** sourceFactory：测试注入（默认 fromInstanceMetadata） */
  constructor(protected readonly deps: AdapterDeps, private readonly sourceFactory?: () => Promise<CredentialSource>) {}

  private async makeSource(): Promise<CredentialSource> {
    if (this.sourceFactory) return this.sourceFactory();
    const { fromInstanceMetadata } = await loadAwsPackage('@aws-sdk/credential-providers', () => import('@aws-sdk/credential-providers'));
    return fromInstanceMetadata({ timeout: this.deps.cfg.iam.IAM_IMDS_TIMEOUT_MS, maxRetries: this.deps.cfg.iam.IAM_IMDS_MAX_RETRIES });
  }

  private async fetch(): Promise<AwsCredentials> {
    this.source ??= await this.makeSource();
    try {
      const r = await this.source();
      this.cached = {
        accessKeyId: r.accessKeyId, secretAccessKey: r.secretAccessKey,
        ...(r.sessionToken ? { sessionToken: r.sessionToken } : {}),
        ...(r.expiration ? { expiration: new Date(r.expiration) } : {}),
      };
      this.lastRefreshError = undefined;
      return this.cached;
    } catch (e) {
      this.lastRefreshError = (e as Error)?.message ?? String(e);
      // 刷新失败但旧凭证尚未过期：继续用旧的（探针会报 degraded）
      if (this.cached?.expiration && this.cached.expiration.getTime() > Date.now()) return this.cached;
      throw e;
    }
  }

  private get(): Promise<AwsCredentials> {
    const c = this.cached;
    if (c && (!c.expiration || c.expiration.getTime() - Date.now() > REFRESH_BEFORE_MS)) return Promise.resolve(c);
    this.inflight ??= this.fetch().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  provider(): () => Promise<AwsCredentials> {
    return () => this.get();
  }

  private aws(): AwsClients {
    this.clients ??= probeClients(this.deps, this.provider());
    return this.clients;
  }

  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    let creds: AwsCredentials;
    try {
      creds = await this.get();
    } catch (e) {
      return { status: 'error', detail: `IMDS 取不到角色凭证：${(e as Error)?.message ?? String(e)}`, confidence: 'confirmed', data: { source: 'imds' } };
    }
    const r = await probeWithDetector(this.deps, this.aws(), opts);
    const data = { ...(r.data ?? {}), source: 'imds', ...(creds.expiration ? { expiration: creds.expiration.toISOString() } : {}) };
    if (r.status === 'ok' && this.lastRefreshError && creds.expiration && creds.expiration.getTime() - Date.now() < REFRESH_BEFORE_MS) {
      return { ...r, status: 'degraded', detail: `${r.detail} · 凭证即将过期且刷新失败：${this.lastRefreshError}`, data };
    }
    return { ...r, data };
  }

  async describe(): Promise<CredentialDescription> {
    return describeCaller(this.aws());
  }

  async forceRefresh(): Promise<void> {
    this.cached = undefined;
    this.source = undefined;
    await this.get();
  }

  async close(): Promise<void> {
    this.clients?.destroy();
  }
}
