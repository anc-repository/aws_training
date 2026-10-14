// backend/src/adapters/identity-pool/cognito.ts —— DirectUploadPort 的 `cognito` 驱动（Amazon Cognito Identity Pool；02#identity-pool 第 2 节）
//
// F14 的 AWS 实现：已登录用户换取一组只能写暂存桶 private/<identityId>/ 的 STS 临时凭证，浏览器自己签名分片直传；
// complete 时服务端校验后用 CopyObject 导入原图键（字节不经过 EC2），授权由 IAM 策略变量 ${cognito-identity.amazonaws.com:sub} 完成。
//
// - openSession：{mode:'sts', region, bucket, prefix, partSize, credentialsUrl}（路径段 identity-pool=cognito:session：只是开了会话，
//   还没有换取凭证；cognito:sts 只在 credentials() 成功与 complete() 导入成功时出现，wave1-fix）；
//   管理员带 X-Compare-Bypass: identity-pool → none 驱动的前缀令牌（cognito:bypass）；
//   Cognito Identity 或暂存桶不可用（最近一次探针 error、连续 3 次瞬时失败、或最近 60 秒内换取凭证失败）→ 退回 none 驱动的
//   前缀令牌 {mode:'token', fallback:true}（cognito:error-fallback）。不是退回 F6 的逐文件上传。
// - credentials：User Pool 的 ID 令牌（Cookie ca_it）→ GetId(Logins) → GetCredentialsForIdentity；两者都是不签名的公开 API。
//   先在本地核对 ID 令牌的声明（token_use=id、iss、aud、sub 与当前登录者一致；签名由 Cognito 校验），防止把别人的身份写进
//   users.identity_id。auth=local + IDENTITY_DEV_PROVIDER（开发者认证身份）时改用 GetOpenIdTokenForDeveloperIdentity（需要凭证），
//   再以 Logins['cognito-identity.amazonaws.com'] 调用 GetCredentialsForIdentity。identityId 以 `<池 ID>|<identityId>` 写入
//   users.identity_id（身份 ID 只在所属的池内有效；重新启用得到新池时旧值视为没有）。
// - complete：暂存对象 private/<identityId>/<photoId>.<ext> → HeadObject（大小 ≤ maxUploadMb、Content-Type 在 F6 白名单内）
//   → Range GetObject 读文件头（魔数，防扩展名伪装）→ 不合规：删除暂存对象、照片标记 FAILED、抛 413 / 415；
//   合规：StoragePort.importObject（服务端 CopyObject，storage=s3:import）→ 删除暂存对象。之后与其他上传方式相同
//   （下游订阅 EventBridge 的 Object Created，包含 Copy）。暂存桶里没有该对象时交给 none 驱动（令牌会话：bypass / 故障回退）。
// - 非权威端口：故障不影响 /api/health/ready；换取凭证失败返回 503，并让之后 60 秒内的新会话退回前缀令牌。
// - 探针：DescribeIdentityPool + 暂存桶 HeadBucket（经 withAwsRetry；瞬时失败 = degraded + transient）；degraded：
//   允许未认证身份、最近 5 分钟换取凭证失败率 > 1%；DEP-030（APP_BASE_URL 为 http）由规则引擎标注。深度探针另列出暂存桶前缀。
// - 平台探测（06 PM-11）：labProbe() = DescribeIdentityPool + HeadBucket，路径段 identity-pool=cognito:probe（探测主体没有终端用户的
//   ID 令牌，不签发 STS 凭证）。
import type { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import type { S3Client } from '@aws-sdk/client-s3';
import { isAcceptedType, sniffImageType } from '@cloudalbum/image-core';
import { HttpError } from '../../errors.js';
import { currentContext, markPath } from '../../observability/request-context.js';
import type { AdapterMeta, ProbeResult } from '../../ports/common.js';
import { DEFAULT_RUNTIME_CONFIG } from '../../ports/config.js';
import type { DirectUploadPort, DirectUploadSession, TempAwsCredentials } from '../../ports/direct-upload.js';
import type { Principal } from '../../ports/auth.js';
import type { StoragePort } from '../../ports/storage.js';
import { getPhoto, markFailed } from '../../repositories/photos.js';
import { findUserById, updateUser } from '../../repositories/users.js';
import { awsErrorName, describeAwsError, isAwsAccessDenied, isAwsNotFound, isAwsTransient, loadAwsPackage, withAwsRetry } from '../aws/clients.js';
import { BackgroundProbe } from '../aws/background-probe.js';
import type { AdapterDeps } from '../types.js';
import { PrefixTokenUpload } from './none.js';

type CiSdk = typeof import('@aws-sdk/client-cognito-identity');
type S3Sdk = typeof import('@aws-sdk/client-s3');

const MB = 1024 * 1024;
/** 换取凭证结果的统计窗口（探针 degraded 判据：最近 5 分钟失败率 > 1%） */
export const EXCHANGE_WINDOW_MS = 5 * 60_000;
export const EXCHANGE_FAILURE_RATIO = 0.01;
/** 换取凭证失败后，新会话退回前缀令牌的时长 */
export const FALLBACK_COOLDOWN_MS = 60_000;
/** 连续这么多次探针失败（含瞬时）后新会话退回前缀令牌（与能力注册表“连续 3 次 → error”一致） */
const FALLBACK_AFTER_PROBE_FAILURES = 3;
/** complete 时读取的文件头字节数（sniffImageType 至少需要 12 个） */
const HEAD_BYTES = 32;
/**
 * 换取凭证的重试（只对瞬时错误）：api 重启后的最初一两分钟，SDK 懒加载与首个 TLS 握手可能很慢（2026-10-14 实机验证），
 * 单次给 5 秒、最多 2 次，仍失败才记为一次换取失败（让之后 60 秒内的新会话退回前缀令牌）。
 */
const EXCHANGE_RETRY = { attempts: 2, timeoutMs: 5000, delaysMs: [300] } as const;
/** 开发者认证身份在 Logins 中的键（GetOpenIdTokenForDeveloperIdentity 返回的 OpenID 令牌） */
const COGNITO_IDENTITY_LOGIN = 'cognito-identity.amazonaws.com';

/** 最近一次签发给某个用户的凭证（不含密钥；/api/lab/identity-pool/whoami 展示“ASIA 凭证剩余 mm:ss”） */
export interface IssuedCredentialsInfo {
  identityId: string;
  accessKeyPrefix: string;
  expiration: string;
  issuedAt: string;
  via: 'user-pool' | 'developer';
}

/** JWT 载荷（不验签；签名由 Cognito 在 GetId 时校验） */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** identityId 形如 ap-northeast-1:<uuid>；只接受这种形状，避免拼进 S3 键时越出自己的前缀 */
export function isIdentityId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z]{2}(-[a-z]+)+-\d:[0-9a-f-]{36}$/.test(v);
}

/**
 * users.identity_id 的存储形式：`<IdentityPoolId>|<identityId>`（wave1-fix）。身份 ID 只在所属的池内有效；disable 会删除身份池，
 * 重新启用得到新的池 ID，旧值必须视为“没有”，否则开发者认证身份会把旧池的 IdentityId 传给 GetOpenIdTokenForDeveloperIdentity。
 */
export function encodeIdentityRef(poolId: string, identityId: string): string {
  return `${poolId}|${identityId}`;
}

/** 解析 users.identity_id：池 ID 与当前池一致才返回 identityId；旧格式（不带池 ID）与其他池的值一律视为没有 */
export function decodeIdentityRef(stored: unknown, poolId: string): string | null {
  if (typeof stored !== 'string') return null;
  const i = stored.lastIndexOf('|');
  if (i <= 0) return null;
  const id = stored.slice(i + 1);
  return stored.slice(0, i) === poolId && isIdentityId(id) ? id : null;
}

function normalizePrefix(p: string): string {
  const s = p.replace(/^\/+/, '');
  return s.endsWith('/') ? s : `${s}/`;
}

async function bodyBytes(body: unknown, max: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body.subarray(0, max);
  if (body instanceof Uint8Array) return Buffer.from(body).subarray(0, max);
  const b = body as { transformToByteArray?: () => Promise<Uint8Array>; destroy?: () => void } & Partial<AsyncIterable<unknown>>;
  if (typeof b[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    let n = 0;
    try {
      for await (const c of b as AsyncIterable<unknown>) {
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
        chunks.push(buf);
        n += buf.length;
        if (n >= max) break;
      }
    } finally {
      b.destroy?.();
    }
    return Buffer.concat(chunks).subarray(0, max);
  }
  if (typeof b.transformToByteArray === 'function') return Buffer.from(await b.transformToByteArray()).subarray(0, max);
  return Buffer.alloc(0);
}

export class CognitoDirectUpload implements DirectUploadPort {
  readonly meta: AdapterMeta = { module: 'identity-pool', driver: 'cognito', awsService: 'Amazon Cognito Identity Pool', authoritative: false };
  /** none 驱动：bypass 与故障回退时发放前缀令牌；令牌会话的 parts:sign / complete 也交给它 */
  readonly local: PrefixTokenUpload;
  private exchanges: Array<{ at: number; ok: boolean }> = [];
  private lastFailure: { at: number; detail: string } | null = null;
  private lastProbe: { status: ProbeResult['status']; at: number; detail: string } | null = null;
  private probeFailures = 0;
  /** 控制面读取放在后台（wave1-fix）：探针最多等 1.5 秒（深度 4 秒），不占用能力注册表 2 秒的探针预算 */
  private readonly bg = new BackgroundProbe({ label: 'Cognito Identity / 暂存桶' });
  private readonly issued = new Map<string, IssuedCredentialsInfo>();
  private ciSdkPromise?: Promise<CiSdk>;
  private s3SdkPromise?: Promise<S3Sdk>;

  constructor(protected readonly deps: AdapterDeps) {
    this.local = new PrefixTokenUpload(deps);
  }

  // ------------------------------------------------------------------------------------------
  // 配置与客户端
  // ------------------------------------------------------------------------------------------
  get poolId(): string {
    return this.deps.cfg.identity.IDENTITY_POOL_ID;
  }

  get bucket(): string {
    return this.deps.cfg.identity.IDENTITY_STAGING_BUCKET ?? '';   // 非空由 schema 保证（IDENTITY_POOL_ID 非空时必填）
  }

  get uploadPrefix(): string {
    return normalizePrefix(this.deps.cfg.identity.IDENTITY_UPLOAD_PREFIX || 'private/');
  }

  /** 身份池所在区域 = IdentityPoolId 的前缀（与应用区域相同；不同时以池 ID 为准） */
  get region(): string {
    const r = this.poolId.split(':')[0];
    return r && /^[a-z]{2}(-[a-z]+)+-\d$/.test(r) ? r : this.deps.cfg.core.AWS_REGION;
  }

  private get devProvider(): string {
    return this.deps.cfg.identity.IDENTITY_DEV_PROVIDER;
  }

  private userPool(): { userPoolId: string; clientId: string } | null {
    const a = this.deps.cfg.auth;
    return a.AUTH_DRIVER === 'cognito' ? { userPoolId: a.COGNITO_USER_POOL_ID, clientId: a.COGNITO_CLIENT_ID } : null;
  }

  private partSize(): number {
    return this.deps.cfg.identity.IDENTITY_PART_SIZE_MB * MB;
  }

  private maxBytes(): number {
    let mb = DEFAULT_RUNTIME_CONFIG.maxUploadMb;
    try {
      mb = this.deps.runtime?.current().maxUploadMb ?? mb;
    } catch {
      /* 运行时配置不可读：用默认值 */
    }
    return Math.floor(mb * MB);
  }

  private ciSdk(): Promise<CiSdk> {
    this.ciSdkPromise ??= loadAwsPackage('@aws-sdk/client-cognito-identity', () => import('@aws-sdk/client-cognito-identity'));
    return this.ciSdkPromise;
  }

  private s3Sdk(): Promise<S3Sdk> {
    this.s3SdkPromise ??= loadAwsPackage('@aws-sdk/client-s3', () => import('@aws-sdk/client-s3'));
    return this.s3SdkPromise;
  }

  private ci(): Promise<CognitoIdentityClient> {
    return this.deps.aws.cognitoIdentity({ region: this.region });
  }

  private s3(): Promise<S3Client> {
    return this.deps.aws.s3();
  }

  private storage(): StoragePort {
    const s = this.deps.storage;
    if (!s) throw new Error('CognitoDirectUpload: 缺少依赖 storage（container 装配顺序错误）');
    return s;
  }

  private db() {
    const db = this.deps.db;
    if (!db) throw new Error('CognitoDirectUpload: 缺少依赖 db（container 装配顺序错误）');
    return db;
  }

  // ------------------------------------------------------------------------------------------
  // 换取凭证的统计与故障回退
  // ------------------------------------------------------------------------------------------
  private record(ok: boolean, detail = ''): void {
    const now = Date.now();
    this.exchanges.push({ at: now, ok });
    this.exchanges = this.exchanges.filter((x) => now - x.at <= EXCHANGE_WINDOW_MS).slice(-10_000);
    if (!ok) this.lastFailure = { at: now, detail };
  }

  exchangeStats(now = Date.now()): { total: number; ok: number; failed: number; windowSec: number } {
    const recent = this.exchanges.filter((x) => now - x.at <= EXCHANGE_WINDOW_MS);
    const failed = recent.filter((x) => !x.ok).length;
    return { total: recent.length, ok: recent.length - failed, failed, windowSec: EXCHANGE_WINDOW_MS / 1000 };
  }

  /** 新会话是否应退回前缀令牌；返回原因（null = 走 STS） */
  fallbackReason(now = Date.now()): string | null {
    if (this.lastProbe?.status === 'error') return `探针：${this.lastProbe.detail}`;
    if (this.probeFailures >= FALLBACK_AFTER_PROBE_FAILURES) return `连续 ${this.probeFailures} 次探针失败：${this.lastProbe?.detail ?? ''}`;
    if (this.lastFailure && now - this.lastFailure.at < FALLBACK_COOLDOWN_MS) return `换取凭证失败：${this.lastFailure.detail}`;
    return null;
  }

  /** whoami：最近一次签发给该用户的凭证（不含密钥） */
  lastIssued(userId: string): IssuedCredentialsInfo | null {
    return this.issued.get(userId) ?? null;
  }

  /** 当前池中该用户的 identityId（users.identity_id 的池 ID 与当前池不一致时为 null） */
  async storedIdentityId(userId: string): Promise<string | null> {
    if (!this.deps.db) return null;
    const row = await findUserById(this.deps.db, userId);
    return decodeIdentityRef(row?.identity_id ?? null, this.poolId);
  }

  /** 暂存键：private/<identityId>/<photoId>.<ext>（扩展名与原图键一致） */
  stagingKey(identityId: string, photoId: string, rawKey: string): string {
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(rawKey)?.[1]?.toLowerCase() ?? 'bin';
    return `${this.uploadPrefix}${identityId}/${photoId}.${ext}`;
  }

  // ------------------------------------------------------------------------------------------
  // DirectUploadPort
  // ------------------------------------------------------------------------------------------
  async openSession(who: Principal, opts: { bypass?: boolean } = {}): Promise<DirectUploadSession> {
    if (opts.bypass) {
      const s = await this.local.openSession(who);
      markPath('identity-pool', 'cognito:bypass');
      return s;
    }
    const reason = this.fallbackReason();
    if (reason) {
      const s = await this.local.openSession(who);
      markPath('identity-pool', 'cognito:error-fallback');
      this.deps.logger?.warn('identity-pool.fallback', { reason });
      return { ...s, fallback: true } as DirectUploadSession;
    }
    const uid = currentContext()?.userId ?? who.subject;
    const identityId = await this.storedIdentityId(uid).catch(() => null);
    // 只是开了一个 STS 会话，还没有换取凭证：cognito:sts 留给 credentials() 成功与 complete() 导入成功（wave1-fix）
    markPath('identity-pool', 'cognito:session');
    return {
      mode: 'sts', region: this.region, bucket: this.bucket,
      prefix: identityId ? `${this.uploadPrefix}${identityId}/` : this.uploadPrefix,
      partSize: this.partSize(), credentialsUrl: '/api/uploads/credentials',
    };
  }

  /** 令牌会话（bypass / 故障回退）的分片授权：与 none 驱动相同 */
  async authorizePart(token: string, key: string, uploadId: string, part: number): Promise<{ url?: string; maxBytes: number; partSize: number }> {
    return this.local.authorizePart(token, key, uploadId, part);
  }

  /** 本地核对 ID 令牌的声明（不验签；签名、过期由 Cognito 在 GetId 时再校验一次） */
  private checkIdToken(idToken: string, who: Principal): { providerName: string } {
    const claims = decodeJwtPayload(idToken);
    const bad = (m: string) => new HttpError(401, 'ID_TOKEN_INVALID', `ID 令牌不可用：${m}`);
    if (!claims) throw bad('不是 JWT');
    if (claims.token_use !== 'id') throw bad('token_use 不是 id（需要 ID 令牌，不是 access token）');
    const iss = typeof claims.iss === 'string' ? claims.iss : '';
    const m = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([A-Za-z0-9-]+_[0-9A-Za-z]+)$/.exec(iss);
    if (!m) throw bad('签发者不是 Cognito User Pool');
    const pool = this.userPool();
    if (pool && m[2] !== pool.userPoolId) throw bad(`签发者不是本站的 User Pool（${pool.userPoolId}）`);
    if (pool && claims.aud !== pool.clientId) throw bad('aud 不是本站的应用客户端');
    if (who.provider === 'cognito' && claims.sub !== who.subject) throw bad('令牌的 sub 与当前登录用户不一致');
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new HttpError(401, 'ID_TOKEN_EXPIRED', 'ID 令牌已过期，请刷新登录状态');
    return { providerName: `cognito-idp.${m[1]}.amazonaws.com/${m[2]}` };
  }

  async credentials(who: Principal, idToken: string): Promise<TempAwsCredentials> {
    const uid = currentContext()?.userId ?? who.subject;
    const useUserPool = who.provider === 'cognito' || !this.devProvider;
    let providerName = '';
    if (useUserPool) {
      if (!idToken) throw new HttpError(401, 'ID_TOKEN_REQUIRED', '缺少 User Pool 的 ID 令牌');
      providerName = this.checkIdToken(idToken, who).providerName;
    }
    const { GetIdCommand, GetCredentialsForIdentityCommand, GetOpenIdTokenForDeveloperIdentityCommand } = await this.ciSdk();
    try {
      const ci = await this.ci();
      let identityId: string | undefined;
      let logins: Record<string, string>;
      if (useUserPool) {
        logins = { [providerName]: idToken };
        const input = { IdentityPoolId: this.poolId, Logins: logins };
        identityId = (await withAwsRetry(() => ci.send(new GetIdCommand(input)), EXCHANGE_RETRY)).IdentityId;
      } else {
        // 开发者认证身份（auth=local）：后端以 IAM 凭证为本站用户 ID 取得 Cognito 签发的 OpenID 令牌
        const stored = await this.storedIdentityId(uid);
        const input = { IdentityPoolId: this.poolId, Logins: { [this.devProvider]: uid } };
        const devToken = (withId: boolean) => withAwsRetry(
          () => ci.send(new GetOpenIdTokenForDeveloperIdentityCommand({ ...input, ...(withId && stored ? { IdentityId: stored } : {}) })), EXCHANGE_RETRY);
        let r: Awaited<ReturnType<typeof devToken>>;
        try {
          r = await devToken(true);
        } catch (e) {
          // 存储的 IdentityId 不属于这个池（或已被删除）：去掉 IdentityId 重试一次，成功后下面会覆盖存储值
          if (!stored || !['ResourceNotFoundException', 'InvalidParameterException'].includes(awsErrorName(e))) throw e;
          this.deps.logger?.warn('identity-pool.stale_identity_id', { error: describeAwsError(e) });
          r = await devToken(false);
        }
        identityId = r.IdentityId;
        logins = { [COGNITO_IDENTITY_LOGIN]: r.Token ?? '' };
      }
      if (!isIdentityId(identityId)) throw Object.assign(new Error(`GetId 返回的 IdentityId 无效：${String(identityId)}`), { name: 'InvalidIdentityId' });
      const exchange = { IdentityId: identityId, Logins: logins };
      const r = await withAwsRetry(() => ci.send(new GetCredentialsForIdentityCommand(exchange)), EXCHANGE_RETRY);
      const c = r.Credentials;
      if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken) throw Object.assign(new Error('GetCredentialsForIdentity 没有返回凭证'), { name: 'EmptyCredentials' });
      const expiration = c.Expiration ? new Date(c.Expiration).toISOString() : new Date(Date.now() + 3600_000).toISOString();
      this.record(true);
      if (this.deps.db) {
        const stored = await this.storedIdentityId(uid).catch(() => null);
        if (stored !== identityId) await updateUser(this.deps.db, uid, { identity_id: encodeIdentityRef(this.poolId, identityId) });
      }
      this.issued.set(uid, {
        identityId, accessKeyPrefix: `${c.AccessKeyId.slice(0, 4)}…`, expiration, issuedAt: new Date().toISOString(),
        via: useUserPool ? 'user-pool' : 'developer',
      });
      markPath('identity-pool', 'cognito:sts');
      return {
        accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretKey, sessionToken: c.SessionToken, expiration,
        identityId, region: this.region, bucket: this.bucket, prefix: `${this.uploadPrefix}${identityId}/`,
      };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const name = awsErrorName(e);
      if (name === 'NotAuthorizedException' && /expired/i.test((e as Error).message ?? '')) {
        throw new HttpError(401, 'ID_TOKEN_EXPIRED', 'Cognito 拒绝了已过期的 ID 令牌，请刷新登录状态');
      }
      this.record(false, describeAwsError(e));
      markPath('identity-pool', 'cognito:error');
      this.deps.logger?.warn('identity-pool.credentials_failed', { error: describeAwsError(e) });
      throw new HttpError(503, 'IDENTITY_POOL_UNAVAILABLE',
        `换取临时凭证失败（${describeAwsError(e)}）；重新开会话（POST /api/uploads/session）会退回应用自签的前缀令牌`);
    }
  }

  async complete(photoId: string, who: Principal): Promise<{ ok: boolean; rawKey?: string; reason?: string }> {
    const db = this.db();
    const photo = await getPhoto(db, photoId);
    if (!photo) return { ok: false, reason: '照片不存在' };
    const identityId = await this.storedIdentityId(photo.ownerId);
    if (!identityId) return this.completeToken(photoId, who, '该用户还没有换取过 Identity Pool 凭证');
    const key = this.stagingKey(identityId, photoId, photo.rawKey);
    const { HeadObjectCommand, GetObjectCommand, DeleteObjectsCommand } = await this.s3Sdk();
    const s3 = await this.s3();
    let head: { ContentLength?: number; ContentType?: string };
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e) {
      if (isAwsNotFound(e)) return this.completeToken(photoId, who, `暂存桶中没有 ${key}`);
      throw new HttpError(503, 'IDENTITY_STAGING_UNAVAILABLE', `读取暂存对象失败：${describeAwsError(e)}`);
    }
    const removeStaged = async () => {
      try {
        await s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: [{ Key: key }], Quiet: true } }));
      } catch (e) {
        // 删除失败不影响结果：暂存桶的生命周期规则 1 天后清理
        this.deps.logger?.warn('identity-pool.staging_delete_failed', { key, error: describeAwsError(e) });
      }
    };
    const reject = async (status: number, code: string, message: string): Promise<never> => {
      await removeStaged();
      await markFailed(db, photoId, message);
      markPath('identity-pool', 'cognito:sts');
      throw new HttpError(status, code, message);
    };
    const size = Number(head.ContentLength ?? 0);
    const max = this.maxBytes();
    if (size > max) await reject(413, 'UPLOAD_TOO_LARGE', `暂存对象 ${size} 字节超过上限 ${Math.round(max / MB)} MB`);
    if (size === 0) await reject(400, 'UPLOAD_EMPTY', '暂存对象为空');
    const declared = (head.ContentType ?? '').split(';')[0]!.trim().toLowerCase();
    if (!isAcceptedType(declared)) await reject(415, 'UNSUPPORTED_MEDIA_TYPE', `暂存对象的 Content-Type（${declared || '空'}）不在 JPEG / PNG / WebP 白名单内`);
    let headBytes: Buffer;
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${HEAD_BYTES - 1}` }));
      headBytes = await bodyBytes(r.Body, HEAD_BYTES);
    } catch (e) {
      throw new HttpError(503, 'IDENTITY_STAGING_UNAVAILABLE', `读取暂存对象文件头失败：${describeAwsError(e)}`);
    }
    const sniffed = sniffImageType(headBytes);
    if (!sniffed) await reject(415, 'UNSUPPORTED_MEDIA_TYPE', '文件头不是 JPEG / PNG / WebP（按魔数识别，不只看扩展名）');
    if (sniffed !== photo.contentType) await reject(415, 'CONTENT_TYPE_MISMATCH', `声明的类型 ${photo.contentType} 与文件头 ${String(sniffed)} 不一致`);

    const storage = this.storage();
    if (typeof storage.importObject !== 'function') {
      throw new HttpError(409, 'STORAGE_IMPORT_UNAVAILABLE', 'identity-pool 需要 STORAGE_DRIVER=s3（StoragePort.importObject，DEP-002）');
    }
    await storage.importObject({ bucket: this.bucket, key }, photo.rawKey);
    await removeStaged();
    markPath('identity-pool', 'cognito:sts');
    return { ok: true, rawKey: photo.rawKey };
  }

  /** 暂存桶中没有对象：这次上传走的是前缀令牌（bypass / 故障回退），由 none 驱动合并分片 */
  private async completeToken(photoId: string, who: Principal, why: string): Promise<{ ok: boolean; rawKey?: string; reason?: string }> {
    const r = await this.local.complete(photoId, who);
    if (r.ok) {
      markPath('identity-pool', 'none:token');
      return r;
    }
    return { ok: false, reason: `${why}；${r.reason ?? '也没有前缀令牌的分片'}` };
  }

  // ------------------------------------------------------------------------------------------
  // 探针
  // ------------------------------------------------------------------------------------------
  private probeFailure(what: string, e: unknown, data: Record<string, unknown>, t0: number): ProbeResult {
    const latencyMs = Date.now() - t0;
    let r: ProbeResult;
    if (isAwsTransient(e)) {
      r = { status: 'degraded', transient: true, detail: `${what} 暂时失败（${describeAwsError(e)}），稍后重试`, latencyMs, confidence: 'observed', data };
    } else if (isAwsNotFound(e)) {
      r = { status: 'error', detail: what === 'HeadBucket' ? `暂存桶 ${this.bucket} 不存在` : `身份池 ${this.poolId} 不存在`, latencyMs, confidence: 'confirmed', data };
    } else if (isAwsAccessDenied(e)) {
      r = { status: 'error', detail: `${what} 无权限（检查 identity-pool 栈的 PolicyArn 是否已附加到 CloudAlbumAppRole）：${describeAwsError(e)}`, latencyMs, confidence: 'confirmed', data };
    } else {
      r = { status: 'error', detail: `${what} 失败：${describeAwsError(e)}`, latencyMs, confidence: 'confirmed', data };
    }
    this.probeFailures += 1;
    this.lastProbe = { status: r.status, at: Date.now(), detail: r.detail };
    return r;
  }

  async probe(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    return this.bg.run(() => this.probeNow(opts), opts.deep ? { deep: true } : {});
  }

  private async probeNow(opts: { deep?: boolean } = {}): Promise<ProbeResult> {
    const t0 = Date.now();
    const stats = this.exchangeStats();
    const data: Record<string, unknown> = {
      identityPoolId: this.poolId, stagingBucket: this.bucket, uploadPrefix: this.uploadPrefix, region: this.region,
      credentialExchanges: stats, fallbackActive: Boolean(this.fallbackReason()),
      ...(this.devProvider ? { developerProvider: this.devProvider } : {}),
    };
    const { DescribeIdentityPoolCommand } = await this.ciSdk();
    const { HeadBucketCommand, ListObjectsV2Command } = await this.s3Sdk();
    let pool: { IdentityPoolName?: string; AllowUnauthenticatedIdentities?: boolean; CognitoIdentityProviders?: Array<{ ProviderName?: string; ClientId?: string }>; DeveloperProviderName?: string };
    try {
      pool = await withAwsRetry(async () => (await this.ci()).send(new DescribeIdentityPoolCommand({ IdentityPoolId: this.poolId })));
    } catch (e) {
      return this.probeFailure('DescribeIdentityPool', e, data, t0);
    }
    try {
      await withAwsRetry(async () => (await this.s3()).send(new HeadBucketCommand({ Bucket: this.bucket })));
    } catch (e) {
      return this.probeFailure('HeadBucket', e, data, t0);
    }
    const providers = (pool.CognitoIdentityProviders ?? []).map((p) => ({ providerName: p.ProviderName ?? '', clientId: p.ClientId ?? '' }));
    Object.assign(data, {
      identityPoolName: pool.IdentityPoolName ?? null, allowUnauthenticated: Boolean(pool.AllowUnauthenticatedIdentities), providers,
      developerProviderName: pool.DeveloperProviderName ?? null,
    });
    const problems: string[] = [];
    if (pool.AllowUnauthenticatedIdentities) problems.push('身份池允许未认证（访客）身份：任何人都能换到凭证');
    const up = this.userPool();
    if (up && !this.devProvider && !providers.some((p) => p.providerName.endsWith(`/${up.userPoolId}`) && p.clientId === up.clientId)) {
      problems.push(`身份池的身份提供方不是本站的 User Pool 客户端（${up.userPoolId} / ${up.clientId}）：重新执行 scripts/module enable identity-pool`);
    }
    if (stats.total > 0 && stats.failed / stats.total > EXCHANGE_FAILURE_RATIO) {
      problems.push(`最近 5 分钟换取凭证失败 ${stats.failed}/${stats.total}（新会话退回应用自签的前缀令牌）`);
    }
    if (opts.deep) {
      try {
        const r = await withAwsRetry(async () => (await this.s3()).send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.uploadPrefix, MaxKeys: 20 })));
        data.stagingSample = { keyCount: r.KeyCount ?? (r.Contents ?? []).length, truncated: Boolean(r.IsTruncated) };
      } catch (e) {
        problems.push(`列出暂存桶失败：${describeAwsError(e)}`);
      }
    }
    const status: ProbeResult['status'] = problems.length ? 'degraded' : 'ok';
    const detail = problems.length ? problems.join('；')
      : `身份池 ${pool.IdentityPoolName ?? this.poolId}（不允许访客身份）· 暂存桶 ${this.bucket} · 最近 5 分钟换取凭证 ${stats.ok}/${stats.total} 成功 · 字节直传 S3`;
    this.probeFailures = 0;
    this.lastProbe = { status, at: Date.now(), detail };
    data.fallbackActive = Boolean(this.fallbackReason());
    return { status, detail, latencyMs: Date.now() - t0, confidence: 'confirmed', data };
  }

  /** /api/lab/probe/identity-pool（06 PM-11）：DescribeIdentityPool + HeadBucket，路径段 identity-pool=cognito:probe */
  async labProbe(): Promise<Record<string, unknown>> {
    const { DescribeIdentityPoolCommand } = await this.ciSdk();
    const { HeadBucketCommand } = await this.s3Sdk();
    const pool = await withAwsRetry(async () => (await this.ci()).send(new DescribeIdentityPoolCommand({ IdentityPoolId: this.poolId })));
    await withAwsRetry(async () => (await this.s3()).send(new HeadBucketCommand({ Bucket: this.bucket })));
    markPath('identity-pool', 'cognito:probe');
    return {
      driver: 'cognito', identityPoolId: this.poolId, allowUnauthenticated: Boolean(pool.AllowUnauthenticatedIdentities),
      stagingBucket: this.bucket, uploadPrefix: this.uploadPrefix, region: this.region,
    };
  }

  /** 服务端证据：暂存桶中某个键是否存在（越权实验确认“别人的前缀里没有写进去”）；只在暂存前缀之内 */
  async stagingObject(key: string): Promise<{ key: string; exists: boolean; size?: number; contentType?: string }> {
    if (!key.startsWith(this.uploadPrefix) || key.includes('..')) throw new HttpError(400, 'KEY_OUT_OF_PREFIX', `只能查询暂存前缀 ${this.uploadPrefix} 之内的键`);
    const { HeadObjectCommand } = await this.s3Sdk();
    try {
      const h = await (await this.s3()).send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, exists: true, size: Number(h.ContentLength ?? 0), ...(h.ContentType ? { contentType: h.ContentType } : {}) };
    } catch (e) {
      if (isAwsNotFound(e)) return { key, exists: false };
      throw new HttpError(503, 'IDENTITY_STAGING_UNAVAILABLE', `HeadObject 失败：${describeAwsError(e)}`);
    }
  }
}
