// backend/src/adapters/aws/clients.ts —— AWS SDK v3 客户端懒加载工厂（总纲 §4.1、§4.5）
//
// - 第一次用到某个客户端时才 `import()` 对应的 @aws-sdk 包：L0（IAM_CREDENTIALS=none）永远不会触发，进程内不加载 AWS SDK
//   （L0 冒烟测试第 7 条，GET /api/lab/self-check 用 awsSdkLoadReport() 报告）。
// - 凭证来自 AwsCredentialsPort.provider()：none 时 provider 为 null，这里拒绝创建任何客户端（CRED-001 已在启动时拦截）；
//   keys 模式的长期密钥由 adapters/iam/keys.ts 显式传入，不导出为进程环境变量。
// - 这里只用 `import type` 引用 SDK 类型（编译后被擦除），运行时依赖全部经动态 import。
import { createRequire } from 'node:module';
import type { ACMClient } from '@aws-sdk/client-acm';
import type { BudgetsClient } from '@aws-sdk/client-budgets';
import type { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { RDSClient } from '@aws-sdk/client-rds';
import type { Route53Client } from '@aws-sdk/client-route-53';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { SNSClient } from '@aws-sdk/client-sns';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SSMClient } from '@aws-sdk/client-ssm';
import type { STSClient } from '@aws-sdk/client-sts';
import type { WAFV2Client } from '@aws-sdk/client-wafv2';
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
  // —— 第 1 波模块（wave1-prep）。全局 / 固定区域的服务由调用方传 { region }：
  //    route53、budgets、costExplorer 的控制面在 us-east-1；waf 的 CLOUDFRONT 范围与 tls-edge 证书也在 us-east-1。
  sns(o?: ClientOverrides): Promise<SNSClient>;                         // notification；monitoring / cost 的自带主题
  sesv2(o?: ClientOverrides): Promise<SESv2Client>;                     // email
  cloudwatch(o?: ClientOverrides): Promise<CloudWatchClient>;           // monitoring；waf 的拦截计数
  cloudwatchLogs(o?: ClientOverrides): Promise<CloudWatchLogsClient>;   // logging；shell-access 的会话日志
  budgets(o?: ClientOverrides): Promise<BudgetsClient>;                 // cost（us-east-1）
  costExplorer(o?: ClientOverrides): Promise<CostExplorerClient>;       // cost（us-east-1；按请求计费，只在手动刷新时调用）
  cognitoIdentity(o?: ClientOverrides): Promise<CognitoIdentityClient>; // identity-pool
  wafv2(o?: ClientOverrides): Promise<WAFV2Client>;                     // waf（CLOUDFRONT 范围传 { region: 'us-east-1' }）
  route53(o?: ClientOverrides): Promise<Route53Client>;                 // dns（us-east-1）
  acm(o?: ClientOverrides): Promise<ACMClient>;                         // tls（edge 证书传 { region: 'us-east-1' }）
  ec2(o?: ClientOverrides): Promise<EC2Client>;                         // shell-access 的安全组 22 端口感知
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
  // 第 1 波模块：SNS / SES v2 / Budgets 的 NotFoundException、WAFv2、Route 53、EC2 安全组
  'NotFoundException', 'WAFNonexistentItemException', 'NoSuchHostedZone', 'NoSuchHealthCheck', 'InvalidGroup.NotFound',
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

/**
 * 瞬时错误（超时、限流、网络、5xx）：探针与控制面读取可以重试；权限、不存在、参数错误不重试。
 * 依据 2026-10-14 实机验证：api 重启后的最初一两分钟，IMDS 与 SDK 的首个请求可能很慢（凭证获取 + TLS 握手 + 懒加载 SDK 包）。
 */
export function isAwsTransient(e: unknown): boolean {
  if (isAwsAccessDenied(e) || isAwsNotFound(e)) return false;
  const name = awsErrorName(e);
  const status = awsHttpStatus(e);
  if (status !== undefined && status >= 500) return true;
  if (status === 429) return true;
  return /Timeout|TimedOut|Throttl|TooManyRequests|RequestLimitExceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|NetworkingError|socket hang up|CredentialsProviderError|ProbeTimeoutError/i
    .test(`${name} ${(e as Error | null)?.message ?? ''}`);
}

/**
 * 探针与控制面只读调用的统一重试（wave1-prep 提供给各模块实现者）：
 *   - 每次尝试有自己的超时（默认 3 秒）；只对瞬时错误重试（默认共 3 次，间隔 200、800 ms）；
 *   - 最后一次仍失败时抛出最后的错误，由调用方映射为 degraded / error。
 * 能力注册表的状态机另有“启动宽限”：首次探针超时不会直接记为 error（modules/capabilities.ts）。
 */
export async function withAwsRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; timeoutMs?: number; delaysMs?: readonly number[] } = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delays = opts.delaysMs ?? [200, 800];
  const timeoutMs = opts.timeoutMs ?? 3000;
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`AWS 调用超时（${timeoutMs} ms）`), { name: 'TimeoutError' })), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (e) {
      last = e;
      if (!isAwsTransient(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)] ?? 0));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw last;
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
    sns: (o) => make('SNS', o, async (c) => new (await load('@aws-sdk/client-sns', () => import('@aws-sdk/client-sns'))).SNSClient(c)),
    sesv2: (o) => make('SES', o, async (c) => new (await load('@aws-sdk/client-sesv2', () => import('@aws-sdk/client-sesv2'))).SESv2Client(c)),
    cloudwatch: (o) => make('CloudWatch', o, async (c) =>
      new (await load('@aws-sdk/client-cloudwatch', () => import('@aws-sdk/client-cloudwatch'))).CloudWatchClient(c)),
    cloudwatchLogs: (o) => make('CloudWatch Logs', o, async (c) =>
      new (await load('@aws-sdk/client-cloudwatch-logs', () => import('@aws-sdk/client-cloudwatch-logs'))).CloudWatchLogsClient(c)),
    budgets: (o) => make('Budgets', o, async (c) =>
      new (await load('@aws-sdk/client-budgets', () => import('@aws-sdk/client-budgets'))).BudgetsClient(c)),
    costExplorer: (o) => make('Cost Explorer', o, async (c) =>
      new (await load('@aws-sdk/client-cost-explorer', () => import('@aws-sdk/client-cost-explorer'))).CostExplorerClient(c)),
    cognitoIdentity: (o) => make('Cognito Identity Pools', o, async (c) =>
      new (await load('@aws-sdk/client-cognito-identity', () => import('@aws-sdk/client-cognito-identity'))).CognitoIdentityClient(c)),
    wafv2: (o) => make('WAFV2', o, async (c) => new (await load('@aws-sdk/client-wafv2', () => import('@aws-sdk/client-wafv2'))).WAFV2Client(c)),
    route53: (o) => make('Route 53', o, async (c) =>
      new (await load('@aws-sdk/client-route-53', () => import('@aws-sdk/client-route-53'))).Route53Client(c)),
    acm: (o) => make('ACM', o, async (c) => new (await load('@aws-sdk/client-acm', () => import('@aws-sdk/client-acm'))).ACMClient(c)),
    ec2: (o) => make('EC2', o, async (c) => new (await load('@aws-sdk/client-ec2', () => import('@aws-sdk/client-ec2'))).EC2Client(c)),
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
