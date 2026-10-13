// backend/src/adapters/aws/clients.ts —— AWS SDK v3 客户端懒加载工厂（总纲 §4.1、§4.5）
//
// - 第一次用到某个客户端时才 `import()` 对应的 @aws-sdk 包：L0（IAM_CREDENTIALS=none）永远不会触发，进程内不加载 AWS SDK
//   （L0 冒烟测试第 7 条，GET /api/lab/self-check 用 awsSdkLoadReport() 报告）。
// - 凭证来自 AwsCredentialsPort.provider()：none 时 provider 为 null，这里拒绝创建任何客户端（CRED-001 已在启动时拦截）；
//   keys 模式的长期密钥由 adapters/iam/keys.ts 显式传入，不导出为进程环境变量。
// - 这里只用 `import type` 引用 SDK 类型（编译后被擦除），运行时依赖全部经动态 import。
import { createRequire } from 'node:module';
import type { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { RDSClient } from '@aws-sdk/client-rds';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SSMClient } from '@aws-sdk/client-ssm';
import type { STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentials } from '../../ports/aws-credentials.js';

export class AwsCredentialsUnavailableError extends Error {
  readonly code = 'AWS_CREDENTIALS_UNAVAILABLE';
  constructor(service: string) {
    super(`IAM_CREDENTIALS=none：拒绝创建 ${service} 客户端（启用 iam 模块：scripts/module enable iam）`);
    this.name = 'AwsCredentialsUnavailableError';
  }
}

export interface AwsClientFactoryOptions {
  region: string;
  credentials: (() => Promise<AwsCredentials>) | null;
  /** 测试 / LocalStack：覆盖端点（例如 http://localhost:4566） */
  endpoint?: string;
  /** S3 路径风格寻址（LocalStack / MinIO 需要；只作用于 s3()） */
  forcePathStyle?: boolean;
  maxAttempts?: number;
}

export interface ClientOverrides { region?: string; endpoint?: string; forcePathStyle?: boolean }

export interface AwsClients {
  readonly region: string;
  /** 是否有凭证（IAM_CREDENTIALS≠none） */
  readonly enabled: boolean;
  s3(o?: ClientOverrides): Promise<S3Client>;
  sqs(o?: ClientOverrides): Promise<SQSClient>;
  lambda(o?: ClientOverrides): Promise<LambdaClient>;
  cognitoIdp(o?: ClientOverrides): Promise<CognitoIdentityProviderClient>;
  sts(o?: ClientOverrides): Promise<STSClient>;
  iam(o?: ClientOverrides): Promise<IAMClient>;
  cloudfront(o?: ClientOverrides): Promise<CloudFrontClient>;
  elasticache(o?: ClientOverrides): Promise<ElastiCacheClient>;
  rds(o?: ClientOverrides): Promise<RDSClient>;
  secretsManager(o?: ClientOverrides): Promise<SecretsManagerClient>;
  ssm(o?: ClientOverrides): Promise<SSMClient>;
  eventbridge(o?: ClientOverrides): Promise<EventBridgeClient>;
  /** 关闭全部已创建的客户端（SIGTERM） */
  destroy(): void;
}

/** 本进程经本工厂动态加载过的 @aws-sdk 包 */
const loadedPackages = new Set<string>();

async function load<T>(pkg: string, importer: () => Promise<T>): Promise<T> {
  loadedPackages.add(pkg);
  return importer();
}

/**
 * 适配器动态加载其他 @aws-sdk 包（例如 `@aws-sdk/s3-request-presigner`）时也经这里登记，
 * 让 awsSdkLoadReport() 的 viaFactory 完整反映“本进程加载过哪些 SDK 包”。
 */
export function loadAwsPackage<T>(pkg: string, importer: () => Promise<T>): Promise<T> {
  return load(pkg, importer);
}

// ---------------------------------------------------------------------------------------------
// AWS SDK v3 错误分类（各适配器与探针共用；只看 name 与 $metadata.httpStatusCode，不依赖具体服务的异常类）
// ---------------------------------------------------------------------------------------------
const NOT_FOUND_NAMES = new Set([
  'NotFound', 'NoSuchKey', 'NoSuchBucket', 'NoSuchUpload', 'ResourceNotFoundException', 'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue', 'DBInstanceNotFound', 'DBInstanceNotFoundFault', 'NoSuchDistribution',
  'ReplicationGroupNotFoundFault', 'ServerlessCacheNotFoundFault', 'UserNotFoundException', 'NoSuchEntity',
  'NoSuchEntityException',
]);
const ACCESS_DENIED_NAMES = new Set([
  'AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'UnrecognizedClientException',
  'InvalidClientTokenId', 'ExpiredToken', 'ExpiredTokenException', 'SignatureDoesNotMatch', 'NotAuthorizedException',
  'AuthorizationError', 'AuthorizationErrorException', 'InvalidAccessKeyId',
]);

export function awsErrorName(e: unknown): string {
  if (typeof e !== 'object' || e === null) return 'Error';
  const o = e as { name?: unknown; Code?: unknown; code?: unknown };
  return String(o.name ?? o.Code ?? o.code ?? 'Error');
}

export function awsHttpStatus(e: unknown): number | undefined {
  const s = (e as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  return typeof s === 'number' ? s : undefined;
}

export function isAwsNotFound(e: unknown): boolean {
  return NOT_FOUND_NAMES.has(awsErrorName(e)) || awsHttpStatus(e) === 404;
}

export function isAwsAccessDenied(e: unknown): boolean {
  return ACCESS_DENIED_NAMES.has(awsErrorName(e)) || awsHttpStatus(e) === 403;
}

/** 一行可读描述：`AccessDenied（HTTP 403）：User is not authorized…` */
export function describeAwsError(e: unknown): string {
  const status = awsHttpStatus(e);
  const message = (e as Error | null)?.message ?? String(e);
  return `${awsErrorName(e)}${status ? `（HTTP ${status}）` : ''}：${message}`;
}

// ---------------------------------------------------------------------------------------------
// 只读控制面查询：modules/ 下的探针（例如 modules/database-probe.ts）按 ESLint 规则不能直接引用 @aws-sdk/*，
// 经这里调用；返回与 SDK 类型无关的普通对象。
// ---------------------------------------------------------------------------------------------
export interface DbInstanceSummary {
  id: string;
  status: string;
  engine?: string;
  engineVersion?: string;
  instanceClass?: string;
  multiAz: boolean;
  availabilityZone?: string;
  secondaryAvailabilityZone?: string;
  storageEncrypted?: boolean;
  latestRestorableTime?: string;
  /** PendingModifiedValues 中非空的字段名（例如 DBInstanceClass、MultiAZ） */
  pendingModified: string[];
  readReplicaIds: string[];
  replicaSourceId?: string;
}

/** `rds:DescribeDBInstances`（DBInstanceIdentifier = id）。实例不存在时返回 null；其他错误照常抛出。 */
export async function describeDbInstance(aws: AwsClients, id: string): Promise<DbInstanceSummary | null> {
  const { DescribeDBInstancesCommand } = await load('@aws-sdk/client-rds', () => import('@aws-sdk/client-rds'));
  const rds = await aws.rds();
  try {
    const r = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }));
    const i = r.DBInstances?.[0];
    if (!i) return null;
    const pending = Object.entries(i.PendingModifiedValues ?? {})
      .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k]) => k);
    return {
      id: i.DBInstanceIdentifier ?? id,
      status: i.DBInstanceStatus ?? 'unknown',
      ...(i.Engine ? { engine: i.Engine } : {}),
      ...(i.EngineVersion ? { engineVersion: i.EngineVersion } : {}),
      ...(i.DBInstanceClass ? { instanceClass: i.DBInstanceClass } : {}),
      multiAz: Boolean(i.MultiAZ),
      ...(i.AvailabilityZone ? { availabilityZone: i.AvailabilityZone } : {}),
      ...(i.SecondaryAvailabilityZone ? { secondaryAvailabilityZone: i.SecondaryAvailabilityZone } : {}),
      ...(i.StorageEncrypted !== undefined ? { storageEncrypted: i.StorageEncrypted } : {}),
      ...(i.LatestRestorableTime ? { latestRestorableTime: new Date(i.LatestRestorableTime).toISOString() } : {}),
      pendingModified: pending,
      readReplicaIds: i.ReadReplicaDBInstanceIdentifiers ?? [],
      ...(i.ReadReplicaSourceDBInstanceIdentifier ? { replicaSourceId: i.ReadReplicaSourceDBInstanceIdentifier } : {}),
    };
  } catch (e) {
    if (isAwsNotFound(e)) return null;
    throw e;
  }
}

/**
 * 报告进程中已加载的 AWS SDK 模块：本工厂的动态加载记录 + CommonJS require 缓存中的 @aws-sdk 路径。
 * L0 冒烟测试要求两者都为空。
 */
export function awsSdkLoadReport(): { viaFactory: string[]; inRequireCache: string[] } {
  const require = createRequire(import.meta.url);
  const inRequireCache = Object.keys(require.cache ?? {})
    .filter((p) => /[\\/]@aws-sdk[\\/]/.test(p))
    .map((p) => {
      const m = /[\\/](@aws-sdk[\\/][^\\/]+)/.exec(p);
      return m ? m[1]!.replace(/\\/g, '/') : p;
    });
  return { viaFactory: [...loadedPackages].sort(), inRequireCache: [...new Set(inRequireCache)].sort() };
}

export function lazyAwsClients(opts: AwsClientFactoryOptions): AwsClients {
  const cache = new Map<string, Promise<unknown>>();
  const created: Array<{ destroy(): void }> = [];

  function make<T extends { destroy(): void }>(
    service: string,
    o: ClientOverrides | undefined,
    build: (config: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    if (!opts.credentials) return Promise.reject(new AwsCredentialsUnavailableError(service));
    const region = o?.region ?? opts.region;
    const endpoint = o?.endpoint ?? opts.endpoint;
    const pathStyle = o?.forcePathStyle ?? (service === 'S3' && opts.forcePathStyle === true);
    const key = `${service}|${region}|${endpoint ?? ''}|${pathStyle ? 'path' : ''}`;
    let p = cache.get(key) as Promise<T> | undefined;
    if (!p) {
      const config: Record<string, unknown> = {
        region,
        credentials: opts.credentials,
        maxAttempts: opts.maxAttempts ?? 3,
        ...(endpoint ? { endpoint } : {}),
        ...(pathStyle ? { forcePathStyle: true } : {}),
      };
      p = build(config).then((client) => {
        created.push(client);
        return client;
      });
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  }

  return {
    region: opts.region,
    enabled: Boolean(opts.credentials),
    s3: (o) => make('S3', o, async (c) => new (await load('@aws-sdk/client-s3', () => import('@aws-sdk/client-s3'))).S3Client(c)),
    sqs: (o) => make('SQS', o, async (c) => new (await load('@aws-sdk/client-sqs', () => import('@aws-sdk/client-sqs'))).SQSClient(c)),
    lambda: (o) => make('Lambda', o, async (c) => new (await load('@aws-sdk/client-lambda', () => import('@aws-sdk/client-lambda'))).LambdaClient(c)),
    cognitoIdp: (o) => make('Cognito User Pools', o, async (c) =>
      new (await load('@aws-sdk/client-cognito-identity-provider', () => import('@aws-sdk/client-cognito-identity-provider'))).CognitoIdentityProviderClient(c)),
    sts: (o) => make('STS', o, async (c) => new (await load('@aws-sdk/client-sts', () => import('@aws-sdk/client-sts'))).STSClient(c)),
    iam: (o) => make('IAM', o, async (c) => new (await load('@aws-sdk/client-iam', () => import('@aws-sdk/client-iam'))).IAMClient(c)),
    cloudfront: (o) => make('CloudFront', o, async (c) =>
      new (await load('@aws-sdk/client-cloudfront', () => import('@aws-sdk/client-cloudfront'))).CloudFrontClient(c)),
    elasticache: (o) => make('ElastiCache', o, async (c) =>
      new (await load('@aws-sdk/client-elasticache', () => import('@aws-sdk/client-elasticache'))).ElastiCacheClient(c)),
    rds: (o) => make('RDS', o, async (c) => new (await load('@aws-sdk/client-rds', () => import('@aws-sdk/client-rds'))).RDSClient(c)),
    secretsManager: (o) => make('Secrets Manager', o, async (c) =>
      new (await load('@aws-sdk/client-secrets-manager', () => import('@aws-sdk/client-secrets-manager'))).SecretsManagerClient(c)),
    ssm: (o) => make('SSM', o, async (c) => new (await load('@aws-sdk/client-ssm', () => import('@aws-sdk/client-ssm'))).SSMClient(c)),
    eventbridge: (o) => make('EventBridge', o, async (c) =>
      new (await load('@aws-sdk/client-eventbridge', () => import('@aws-sdk/client-eventbridge'))).EventBridgeClient(c)),
    destroy() {
      for (const c of created.splice(0)) {
        try {
          c.destroy();
        } catch {
          /* ignore */
        }
      }
      cache.clear();
    },
  };
}
