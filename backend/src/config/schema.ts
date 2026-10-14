// backend/src/config/schema.ts —— 启动配置的 zod 分段校验（总纲 §4.4）
//
// - 每个“开关 + 子配置”是一个分段（判别联合），第一个分支是本地实现，开关缺省 = 本地实现 = L0。
// - 覆盖全部 40 个模块的开关；registry requires / conflicts 的 when、need 中出现的每个变量都必须在某个分段中声明
//   （npm run registry:check 用 CONFIG_KEYS 校验）。
// - 本轮（MVP）未实现的驱动：结构校验通过后由 `implementationErrors()` 拒绝（CFG-001，退出码 78），见 config/implemented.ts。
// - 与总纲示例的差异（见 docs/implementation-notes.md ## scaffold）：on/off 开关保持字符串 'on' | 'off'（不 transform 成布尔），
//   便于与 registry 表达式比较；APP_BASE_URL 有默认值 http://localhost:3000；新增 CLOUDALBUM_DATA_DIR / CLOUDALBUM_ENV_DIR /
//   LOCK_FILE_DIR / PORT / HOST 等路径与进程键，路径类默认值由数据目录派生（Windows 开发机可整体改写）。
import path from 'node:path';
import { z } from 'zod';
import { isLoopback } from './net.js';
import { implementationErrors } from './implemented.js';

const onOff = z.enum(['on', 'off']);
const trueFalse = z.enum(['true', 'false']);
const optUrl = z.union([z.literal(''), z.url()]).default('');
const optStr = z.string().optional();
/** 资源 ARN（只校验 `arn:aws…:` 前缀：scripts/module 计划校验的占位值也要能通过） */
const arn = z.string().regex(/^arn:aws[a-z-]*:/, '必须是 ARN（arn:aws…:）');
const optArn = z.union([z.literal(''), arn]).optional();
const intDefault = (d: number, min = 0) => z.coerce.number().int().min(min).default(d);

/** 给每个“开关 + 子配置”的分段补上默认的本地取值，再交给判别联合 */
function section<T extends z.ZodType>(switchVar: string, localValue: string, schema: T) {
  return z.preprocess((env) => {
    const e = { ...(env as Record<string, unknown>) };
    if (e[switchVar] === undefined || e[switchVar] === '') e[switchVar] = localValue;
    return e;
  }, schema);
}

/** 声明型开关：第一个取值 = 本地实现 = 默认（纯基础设施型模块，D9） */
const decl = <const T extends readonly [string, ...string[]]>(values: T) => z.enum(values).default(values[0] as T[number] as never);

// ---------------------------------------------------------------------------------------------
// Core（总纲 4.4 照录 + 进程 / 路径键）
// ---------------------------------------------------------------------------------------------
export const Core = z.object({
  CLOUDALBUM_ROLE: z.enum(['api', 'worker', 'cli']),
  CLOUDALBUM_ENV: z.string().regex(/^[a-z][a-z0-9-]*$/).default('lab'),
  CLOUDALBUM_PROFILE: z.string().default(''),                      // scripts/module profile apply 写入（capabilities.app.profile）
  CLOUDALBUM_ENV_DIR: z.string().default('/etc/cloudalbum'),       // 第 5 层（systemd Environment=）
  CLOUDALBUM_DATA_DIR: z.string().default('/var/lib/cloudalbum'),  // 数据卷挂载点；路径类默认值由它派生
  LOCK_FILE_DIR: z.string().default('/run/cloudalbum'),            // LockPort(file)，systemd RuntimeDirectory=cloudalbum
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),                            // Nginx 反向代理到 127.0.0.1:3000
  AWS_REGION: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/).default('ap-northeast-1'),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  // 仅开发机 / 集成自测：所有 AWS SDK 客户端的端点覆盖（LocalStack、MinIO 等；S3 自动改用路径风格）。EC2 上留空；
  // NODE_ENV=production 下设置了它时 container 启动告警（integration 小节）
  AWS_ENDPOINT_URL: optUrl,
  DEPLOY_MODE: z.enum(['single', 'asg']).default('single'),           // autoscaling（参数型）
  IAM_CREDENTIALS: z.enum(['none', 'role', 'keys']).default('none'),  // iam（D1）
  CDN_BASE_URL: optUrl,                                 // cdn（参数型）
  SOCIAL_API_BASE_URL: optUrl,                          // social-api（参数型）
  IDENTITY_POOL_ID: z.union([z.literal(''), z.string().regex(/^[\w-]+:[0-9a-f-]{36}$/)]).default(''),
  KMS_KEY_ID: z.union([z.literal(''), z.string().regex(/^(arn:aws:kms:|alias\/)/)]).default(''),
  // 纯基础设施型模块的声明型开关
  NETWORK_PLACEMENT: decl(['default', 'public', 'private']),
  DNS_PROVIDER: decl(['none', 'external', 'route53']),
  TLS_MODE: decl(['selfsigned', 'letsencrypt', 'acm']),
  TLS_ACME: onOff.default('off'),                       // scripts/module 按 preflight acme-endpoint 的结果写入 tls.env；DEP-005 回退条件
  TLS_ACME_DIRECTORY_URL: optUrl,                       // TLS_ACME=on 时由 tls 的 main 栈输出（EnvTlsAcmeDirectoryUrl）
  WAF_MODE: decl(['nginx', 'aws']),
  LB_MODE: decl(['nginx', 'alb']),
  BACKUP_MODE: decl(['local', 'aws']),
  SHELL_ACCESS_MODE: decl(['ssh', 'ssm']),
  AUDIT_MODE: decl(['app', 'cloudtrail']),
  THREAT_DETECTION_MODE: decl(['fail2ban', 'guardduty']),
  COMPLIANCE_MODE: decl(['local', 'config']),
  VULN_SCAN_MODE: decl(['dnf', 'inspector']),
  COST_MODE: decl(['local', 'budgets']),
  AMI_SOURCE: decl(['userdata', 'golden']),
  LB_LOCAL_WORKERS: z.coerce.number().int().min(1).max(2).default(1),   // load-balancer 的本地档
  SECRETS_ORIGIN: z.enum(['instance', 'bundle', 'aws']).default('instance'),
  EXPOSE_PATH_HEADERS: z.enum(['all', 'admin', 'off']).default('all'),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),   // 应用审计表 audit_log 的保留期（audit.retention）
  AUDIT_HASH_CHAIN: onOff.default('on'),                                // 应用审计表的哈希链（篡改实验的对照）
  CLOUDALBUM_ALLOW_UNSAFE: z.string().default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
});

// ---------------------------------------------------------------------------------------------
// iam（02#iam 第 3 节）：IAM_CREDENTIALS 的子配置；keys 模式的长期密钥只能来自 secrets.env
// ---------------------------------------------------------------------------------------------
export const Iam = z.object({
  IAM_CREDENTIALS: z.enum(['none', 'role', 'keys']).default('none'),
  IAM_EXPECTED_ROLE: z.string().default('CloudAlbumAppRole'),
  IAM_IMDS_TIMEOUT_MS: intDefault(1000, 100),
  IAM_IMDS_MAX_RETRIES: intDefault(3),
  IAM_KEYS_ACCESS_KEY_ID: optStr,
  IAM_KEYS_SECRET_ACCESS_KEY: optStr,
}).superRefine((v, ctx) => {
  if (v.IAM_CREDENTIALS === 'keys' && (!v.IAM_KEYS_ACCESS_KEY_ID || !v.IAM_KEYS_SECRET_ACCESS_KEY))
    ctx.addIssue({ code: 'custom', message: 'IAM_CREDENTIALS=keys 时 secrets.env 必须提供 IAM_KEYS_ACCESS_KEY_ID 与 IAM_KEYS_SECRET_ACCESS_KEY' });
});

// ---------------------------------------------------------------------------------------------
// storage / shared-fs
// ---------------------------------------------------------------------------------------------
export const Storage = section('STORAGE_DRIVER', 'local', z.discriminatedUnion('STORAGE_DRIVER', [
  z.object({ STORAGE_DRIVER: z.literal('local'),
             STORAGE_LOCAL_ROOT: z.string().default('/var/lib/cloudalbum/uploads'),
             STORAGE_LOCAL_MIN_FREE_PCT: z.coerce.number().min(1).max(50).default(10) }),   // 低于该比例拒绝新上传（507）
  z.object({ STORAGE_DRIVER: z.literal('efs'),
             STORAGE_LOCAL_ROOT: z.string().startsWith('/mnt/efs/'),
             STORAGE_LOCAL_MIN_FREE_PCT: z.coerce.number().min(1).max(50).default(10),
             EFS_FILE_SYSTEM_ID: z.string().regex(/^fs-[0-9a-f]+$/) }),
  z.object({ STORAGE_DRIVER: z.literal('s3'),
             STORAGE_S3_RAW_BUCKET: z.string().min(3),
             STORAGE_S3_MEDIA_BUCKET: z.string().min(3),
             STORAGE_S3_PRESIGN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(300),
             STORAGE_S3_GET_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(600),
             STORAGE_S3_URL_REUSE_SEC: z.coerce.number().int().min(0).default(300) }),   // 必须小于 GET TTL（superRefine 校验）
])).superRefine((v, ctx) => {
  if (v.STORAGE_DRIVER === 's3' && v.STORAGE_S3_URL_REUSE_SEC >= v.STORAGE_S3_GET_TTL_SEC)
    ctx.addIssue({ code: 'custom', message: 'STORAGE_S3_URL_REUSE_SEC 必须小于 STORAGE_S3_GET_TTL_SEC' });
});

// ---------------------------------------------------------------------------------------------
// auth（总纲 4.4 + 02#auth 第 3 节）
// ---------------------------------------------------------------------------------------------
const authCommon = {
  AUTH_ACCESS_TTL_SEC: z.coerce.number().int().min(60).default(900),
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  AUTH_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  AUTH_LOCKOUT_THRESHOLD: intDefault(5, 1),
  AUTH_LOCKOUT_MINUTES: intDefault(15, 1),
  AUTH_MFA: z.enum(['off', 'optional']).default('optional'),
  JWT_SIGNING_KEY_FILE: z.string().default('/etc/cloudalbum/keys/jwt-es256.pem'),   // 来自 secrets.env
};
export const Auth = section('AUTH_DRIVER', 'local', z.discriminatedUnion('AUTH_DRIVER', [
  z.object({ AUTH_DRIVER: z.literal('local'), ...authCommon }),
  z.object({ AUTH_DRIVER: z.literal('cognito'), ...authCommon,
             COGNITO_USER_POOL_ID: z.string().regex(/^[a-z0-9-]+_[0-9A-Za-z]+$/),
             COGNITO_CLIENT_ID: z.string().min(1),
             COGNITO_DOMAIN: optStr,
             COGNITO_CLIENT_SECRET_ARN: optStr,                                    // secrets=secretsmanager 时；值不进 modules.d
             COGNITO_LOGIN_MODE: z.enum(['sdk', 'managed']).default('sdk'),        // managed 需要受信 HTTPS（DEP-029）
             COGNITO_TRIGGERS: onOff.default('off'),       // 默认不部署 Lambda（D8）；F3/F4 触发器与 lazy 迁移（DEP-031）要求显式 on
             AUTH_MIGRATION: z.enum(['bulk', 'lazy']).default('bulk'),             // D8；lazy 受 DEP-031 约束
             AUTH_DUAL_STACK: onOff.default('off') }),                              // 只在迁移窗口内开启
]));
// auth 的 ownsEnv = [AUTH_, COGNITO_]；client secret 经 SecretsPort('cognito-client-secret') 读取，不进 modules.d。

// ---------------------------------------------------------------------------------------------
// database / db-proxy（总纲 4.4 照录）
// ---------------------------------------------------------------------------------------------
export const Database = section('DB_DRIVER', 'sqlite', z.discriminatedUnion('DB_DRIVER', [
  z.object({ DB_DRIVER: z.literal('sqlite'),
             SQLITE_PATH: z.string().default('/var/lib/cloudalbum/db/cloudalbum.sqlite') }),
  z.object({ DB_DRIVER: z.literal('postgres'),
             DB_HOST: z.string().min(1), DB_PORT: z.coerce.number().default(5432),
             DB_READ_HOST: optStr,                          // RDS 只读副本（无副本时 dbRead = db）
             DB_NAME: z.string().default('cloudalbum'), DB_USER: z.string().min(1),
             DB_PASSWORD: optStr,                           // 只能来自 secrets.env（第 3 层）
             DB_PASSWORD_SECRET_ARN: optStr,                // secrets=secretsmanager 或 RDS 托管主密码时（modules.d 中只写 ARN）
             DB_SSL: z.enum(['require', 'no-verify', 'disable']).default('require'),   // no-verify：显式选择“加密但不校验证书”
             DB_SSL_CA: optStr,
             DB_POOL_MAX: z.coerce.number().int().default(10),
             // —— db-proxy（ownsEnv DB_PROXY_，按最长前缀从 DB_ 中划出；DEP-032、033、036，MUTEX-006）——
             DB_PROXY_MODE: z.enum(['none', 'pgbouncer', 'rds-proxy']).default('none'),
             DB_PROXY_ENDPOINT: optStr,
             DB_PROXY_PORT: z.coerce.number().int().default(5432),                  // pgbouncer 档为 6432
             DB_PROXY_AUTH: z.enum(['secrets', 'iam']).default('secrets'),          // 只在 rds-proxy 时有意义；iam = 端到端 IAM 认证变体（DEP-036）
             DB_PROXY_SSL_CA: optStr,                                               // 代理证书链用 Amazon Trust Services 根证书
             DB_PROXY_NAME: optStr,
             DB_PROXY_POOL_MODE: z.enum(['transaction', 'session']).default('transaction') }),   // 只在 pgbouncer 时有意义
])).superRefine((v, ctx) => {
  if (v.DB_DRIVER !== 'postgres') return;
  if (!v.DB_PASSWORD && !v.DB_PASSWORD_SECRET_ARN && v.DB_PROXY_AUTH !== 'iam')
    ctx.addIssue({ code: 'custom', message: 'DB_PASSWORD 与 DB_PASSWORD_SECRET_ARN 至少提供一个' });
  if (v.DB_PROXY_MODE !== 'none' && !v.DB_PROXY_ENDPOINT)
    ctx.addIssue({ code: 'custom', message: 'DB_PROXY_MODE≠none 时必须提供 DB_PROXY_ENDPOINT' });
  if (v.DB_PROXY_MODE === 'pgbouncer' && !isLoopback(v.DB_PROXY_ENDPOINT))
    ctx.addIssue({ code: 'custom', message: 'DB_PROXY_MODE=pgbouncer 时 DB_PROXY_ENDPOINT 必须是回环地址（本机 PgBouncer）' });
});
// DB_DRIVER=sqlite 时出现 DB_PROXY_MODE≠none 由 DEP-033 报错。

// ---------------------------------------------------------------------------------------------
// cache（总纲 4.4 + 03#cache 第 3 节）
// ---------------------------------------------------------------------------------------------
export const Cache = section('CACHE_DRIVER', 'none', z.discriminatedUnion('CACHE_DRIVER', [
  z.object({ CACHE_DRIVER: z.literal('none') }),
  z.object({ CACHE_DRIVER: z.literal('memory'), CACHE_MEMORY_MAX_ITEMS: z.coerce.number().int().min(1).default(5000) }),
  z.object({ CACHE_DRIVER: z.literal('redis'), REDIS_URL: z.string().regex(/^rediss?:\/\//), REDIS_TLS: onOff.default('on'),
             REDIS_CLIENT_MODE: z.enum(['single', 'cluster']).default('single'),
             REDIS_TIMEOUT_MS: intDefault(100, 1),
             REDIS_KEY_PREFIX: z.string().default('ca:'),
             REDIS_AUTH_SECRET_ARN: optStr }),
]));

// ---------------------------------------------------------------------------------------------
// queue（总纲 4.4 + 04#queue 第 3 节）
// ---------------------------------------------------------------------------------------------
const queueCommon = {
  QUEUE_MAX_ATTEMPTS: intDefault(3, 1),
  QUEUE_CONCURRENCY: z.string().default('image.process:1,image.tag:2,email.send:2,notify.fanout:4,analytics.flush:1'),
};
export const Queue = section('QUEUE_DRIVER', 'sync', z.discriminatedUnion('QUEUE_DRIVER', [
  z.object({ QUEUE_DRIVER: z.literal('sync'), ...queueCommon }),
  z.object({ QUEUE_DRIVER: z.literal('memory'), ...queueCommon, QUEUE_MEMORY_CONCURRENCY: z.coerce.number().int().min(1).default(2) }),
  z.object({ QUEUE_DRIVER: z.literal('sqs'), ...queueCommon, SQS_QUEUE_URL: z.url(), SQS_DLQ_URL: z.url(),
             SQS_WAIT_TIME_SEC: z.coerce.number().int().min(0).max(20).default(20),
             QUEUE_SQS_POLLERS: intDefault(2, 1) }),
]));

// ---------------------------------------------------------------------------------------------
// image-processing（总纲 4.4 + 04#image-processing 第 3 节）
// ---------------------------------------------------------------------------------------------
const imageCommon = {
  IMAGE_SIZES: z.string().default('thumb_200,display_1080'),
  IMAGE_MAX_PIXELS: intDefault(40_000_000, 1),
  IMAGE_INLINE_CONCURRENCY: z.coerce.number().int().min(1).default(2),   // inline 适配器始终装配（X-Compare-Bypass: image）
  IMAGE_STUCK_AFTER_SEC: intDefault(120, 10),
  IMAGE_MAX_ATTEMPTS: intDefault(3, 1),
};
export const Image = section('IMAGE_PROCESSOR', 'inline', z.discriminatedUnion('IMAGE_PROCESSOR', [
  z.object({ IMAGE_PROCESSOR: z.literal('inline'), ...imageCommon }),
  z.object({ IMAGE_PROCESSOR: z.literal('worker'), ...imageCommon, IMAGE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1) }),
  z.object({ IMAGE_PROCESSOR: z.literal('lambda'), ...imageCommon,
             IMAGE_LAMBDA_FUNCTION: z.string().min(1),
             IMAGE_TRIGGER: z.enum(['eventbridge', 'buffer-queue']).default('eventbridge'),
             IMAGE_RESULT_CHANNEL: z.enum(['callback', 'queue']).default('callback'),
             IMAGE_CALLBACK_URL: optUrl,                // callback 通道必填（DEP-019～021）
             IMAGE_RESULT_QUEUE_URL: optUrl,            // queue 通道必填
             IMAGE_FAILURE_QUEUE_URL: z.url() }),       // 模块自带失败队列（规则目标的重试失败 / DLQ）
])).superRefine((v, ctx) => {   // discriminatedUnion 的成员必须是纯 z.object，跨字段校验放在分段级（04#image-processing）
  if (v.IMAGE_PROCESSOR === 'lambda' && !(v.IMAGE_RESULT_CHANNEL === 'queue' ? v.IMAGE_RESULT_QUEUE_URL : v.IMAGE_CALLBACK_URL))
    ctx.addIssue({ code: 'custom', message: 'callback 通道需要 IMAGE_CALLBACK_URL；queue 通道需要 IMAGE_RESULT_QUEUE_URL（CFG-001）' });
});

// ---------------------------------------------------------------------------------------------
// tracing（总纲 4.4 照录）
// ---------------------------------------------------------------------------------------------
export const Tracing = section('TRACING_DRIVER', 'none', z.discriminatedUnion('TRACING_DRIVER', [
  z.object({ TRACING_DRIVER: z.literal('none') }),
  z.object({ TRACING_DRIVER: z.literal('local'), TRACING_LOCAL_RETENTION_DAYS: z.coerce.number().default(3),
             TRACING_LOCAL_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1) }),
  z.object({ TRACING_DRIVER: z.literal('xray'), TRACING_OTLP_ENDPOINT: z.url().default('http://127.0.0.1:4318'),
             TRACING_SAMPLING_ENDPOINT: z.url().default('http://127.0.0.1:2000'),
             TRACING_XRAY_GROUP: optStr,
             TRACING_LOCAL_SPANS: onOff.default('on'),            // xray 档是否同时写本地 span 文件（并排比较）
             TRACING_LOCAL_RETENTION_DAYS: z.coerce.number().default(3),
             TRACING_LOCAL_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1) }),
]));

/** F14：identity-pool 的子配置。IDENTITY_DEV_PROVIDER 是 DEP-002 的条件变量；L0（none 驱动）也读取 TTL */
export const Identity = z.object({
  IDENTITY_POOL_ID: z.union([z.literal(''), z.string().regex(/^[\w-]+:[0-9a-f-]{36}$/)]).default(''),   // 开关（与 Core 同名同义）
  IDENTITY_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),   // none 驱动的前缀令牌有效期
  IDENTITY_DEV_PROVIDER: z.string().default(''),          // auth=local 时的开发者认证身份（如 login.cloudalbum）
  IDENTITY_STAGING_BUCKET: optStr,                        // cognito 驱动：模块自带暂存桶（Outputs.EnvIdentityStagingBucket）
  IDENTITY_UPLOAD_PREFIX: z.string().default('private/'),
  IDENTITY_PART_SIZE_MB: z.coerce.number().int().min(5).default(8),
}).superRefine((v, ctx) => {
  if (v.IDENTITY_POOL_ID && !v.IDENTITY_STAGING_BUCKET)
    ctx.addIssue({ code: 'custom', path: ['IDENTITY_STAGING_BUCKET'], message: 'IDENTITY_POOL_ID 非空（cognito 驱动）时必须提供 IDENTITY_STAGING_BUCKET（identity-pool 栈的 Outputs）' });
});

/** 纯基础设施型与参数型模块的子选项，以及其他出现在 registry requires / conflicts 条件里、但不属于上面判别联合的变量（5.1） */
export const InfraOptions = z.object({
  TLS_DOMAIN: z.string().default(''),                                           // DEP-005 ①（TLS_MODE=acm 时必填）
  SCHEDULER_TARGET: z.enum(['tick-queue', 'ssm']).default('tick-queue'),       // DEP-026
  SOCIAL_API_INTEGRATION: z.enum(['proxy', 'lambda']).default('proxy'),        // DEP-022、024、025
  SOCIAL_API_AUTHORIZER: z.enum(['none', 'jwt', 'lambda']).default('none'),    // DEP-023、024
  SOCIAL_API_REQUIRE_GATEWAY: trueFalse.default('false'),                       // 04#social-api：拒绝不带 X-Origin-Verify 的 /social 直连
  SOCIAL_API_ID: optStr,
  TAGGER_INPUT: z.enum(['auto', 'bytes', 's3']).default('auto'),               // DEP-027
  NETWORK_NAT_MODE: z.enum(['none', 'instance', 'gateway']).default('none'),
  NETWORK_INTERFACE_ENDPOINTS: z.enum(['none', 'ssm', 'ops', 'all']).default('none'),   // ssm：平台管理通道的三个终端节点（PM-M01）
  NETWORK_EIC_ENDPOINT: onOff.default('off'),
  CDN_ORIGIN_TYPE: z.enum(['ec2', 'alb', 'vpc-origin']).default('ec2'),          // DEP-014、038、039
  CDN_MEDIA_ORIGIN: z.enum(['ec2', 's3']).default('ec2'),                        // DEP-010、028
  CDN_DIRECT_ACCESS: z.enum(['open', 'admin-ip', 'closed']).default('open'),     // DEP-018
  CDN_DISTRIBUTION_ID: optStr,                                                    // 01#cdn 第 3 节（失效按钮、GetDistribution 探针）
  CDN_ORIGIN_PORT: z.coerce.number().int().default(8080),
  CDN_ADMIN_CIDR: optStr,
  CDN_SIGNED_MEDIA: onOff.default('off'),
  CDN_ORIGIN_DIRECT_URL: optUrl,                                                  // 对比实验的直连地址
  DNS_TARGET_TYPE: z.enum(['eip', 'alb', 'cloudfront']).default('eip'),          // DEP-040、041
  TLS_FORCE_HTTPS: trueFalse.default('false'),                                    // DEP-015
  // 平台预览方案 B（06 PM-21）：tls 本地档 letsencrypt 为实验机 EIP 申请的 IP 短期证书（tls-preview on 写入 tls.env）
  TLS_LE_PROFILE: z.enum(['classic', 'shortlived']).optional(),
  TLS_PUBLIC_IP: z.union([z.literal(''), z.ipv4()]).optional(),
  TLS_PREVIEW: z.enum(['', 'letsencrypt-ip']).optional(),
  LB_HTTPS: trueFalse.default('false'),
  LB_ADMIN_AUTH: z.enum(['app', 'cognito']).default('app'),                      // DEP-011、017
  LB_ORIGIN_VERIFY: onOff.default('off'),                                         // DEP-042
  LB_LOCK_ORIGIN: onOff.default('off'),
  BACKUP_WHOLE_INSTANCE: onOff.default('off'),                                    // backup 的 baseParams 条件（整机恢复变体）
  COMPLIANCE_LOCAL_INTERVAL_SEC: z.coerce.number().int().min(60).default(300),   // 本地自检周期（local 与 config 档都运行）
  COMPLIANCE_RECORDER: z.enum(['created', 'external']).optional(),              // config 档必填（superRefine）
  COMPLIANCE_RULE_PREFIX: optStr,                                                 // config 档必填
  COMPLIANCE_TOPIC_ARN: optStr,
});

// ---------------------------------------------------------------------------------------------
// 第 1 波的纯基础设施型模块（wave1-prep，各模块文档第 3 节）：声明型开关在 Core，这里重复声明同名开关只为求值
// “AWS 取值时必需的键”；其余是子选项。
// ---------------------------------------------------------------------------------------------

/** dns（01#dns 第 3 节）。APP_BASE_URL 在 Core（只有 dns 拥有它，约定 5）；DNS_TARGET_TYPE 在 InfraOptions（DEP-040、041） */
export const Dns = z.object({
  DNS_PROVIDER: decl(['none', 'external', 'route53']),
  DNS_HOSTED_ZONE_ID: optStr,                                   // Outputs.EnvDnsHostedZoneId
  DNS_RECORD_NAME: optStr,                                      // Outputs.EnvDnsRecordName，例如 album.example.com
  DNS_TTL: z.coerce.number().int().min(0).max(172_800).optional(),
  DNS_ROUTING_POLICY: z.enum(['simple', 'failover', 'weighted']).default('simple'),
  DNS_HEALTH_CHECK_ID: optStr,
  DNS_CANONICAL_REDIRECT: onOff.default('off'),                 // on：Nginx 把 IP / EC2 主机名访问 301 到域名（/api/health/* 除外）
}).superRefine((v, ctx) => {
  if (v.DNS_PROVIDER === 'route53' && (!v.DNS_HOSTED_ZONE_ID || !v.DNS_RECORD_NAME))
    ctx.addIssue({ code: 'custom', path: ['DNS_HOSTED_ZONE_ID'], message: 'DNS_PROVIDER=route53 时必须提供 DNS_HOSTED_ZONE_ID 与 DNS_RECORD_NAME（dns 栈的 Outputs；需要自有域名）' });
});

/** tls（01#tls 第 3 节）。TLS_DOMAIN、TLS_FORCE_HTTPS、TLS_LE_PROFILE、TLS_PUBLIC_IP、TLS_PREVIEW 在 InfraOptions */
export const Tls = z.object({
  TLS_MODE: decl(['selfsigned', 'letsencrypt', 'acm']),
  TLS_ACME: onOff.default('off'),
  TLS_ACME_DIRECTORY_URL: optUrl,
  TLS_LE_EMAIL: optStr,                                         // letsencrypt 与 ACM ACME 注册共用
  TLS_CERTBOT_CONFIG_DIR: optStr,                               // 默认 /etc/cloudalbum/letsencrypt（数据卷上）
  ACM_CERT_ARN_EDGE: optArn,                                    // tls-edge 栈（us-east-1）：CloudFront 集成证书
  ACM_CERT_ARN_REGIONAL: optArn,                                // tls-regional 栈：ALB / API Gateway 集成证书
}).superRefine((v, ctx) => {
  if (v.TLS_MODE === 'acm' && v.TLS_ACME === 'on' && !v.TLS_ACME_DIRECTORY_URL)
    ctx.addIssue({ code: 'custom', path: ['TLS_ACME_DIRECTORY_URL'], message: 'TLS_MODE=acm 且 TLS_ACME=on 时必须提供 TLS_ACME_DIRECTORY_URL（tls main 栈的 Outputs）' });
});

/** waf（01#waf 第 3 节）：BlocklistPort 的 aws 驱动需要 Web ACL 与 IP 集合 */
export const Waf = z.object({
  WAF_MODE: decl(['nginx', 'aws']),
  WAF_NGINX_RATE_API: z.string().regex(/^\d+r\/[sm]$/).optional(),   // 本地实现的 Nginx 限速参数，两种模式都保留
  WAF_NGINX_RATE_AUTH: z.string().regex(/^\d+r\/[sm]$/).optional(),
  WAF_SCOPE: z.enum(['CLOUDFRONT', 'REGIONAL']).optional(),     // injects 条件（CLOUDFRONT 时注入 cdn 的 WebAclArn）；CLOUDFRONT 的 API 在 us-east-1
  WAF_WEB_ACL_ARN: optArn,
  WAF_IP_SET_ID: optStr,
  WAF_IP_SET_NAME: optStr,
  WAF_RULE_ACTION: z.enum(['count', 'block']).default('count'), // 托管规则组先 Count 观察，再改 block
  WAF_RATE_LIMIT: z.coerce.number().int().min(10).optional(),
  WAF_RATE_WINDOW_SEC: z.coerce.number().int().refine((n) => [60, 120, 300, 600].includes(n), '只能是 60 | 120 | 300 | 600').optional(),
  WAF_LOG_GROUP: optStr,                                        // aws-waf-logs-cloudalbum-<env>
  WAF_ORIGIN_NGINX_LIMIT: z.enum(['strict', 'relaxed', 'off']).default('relaxed'),
  WAF_LAB_ALLOW_CIDR: optStr,                                   // 实验机白名单（约定 13），平时为空
}).superRefine((v, ctx) => {
  if (v.WAF_MODE === 'aws' && (!v.WAF_SCOPE || !v.WAF_WEB_ACL_ARN || !v.WAF_IP_SET_ID || !v.WAF_IP_SET_NAME))
    ctx.addIssue({ code: 'custom', path: ['WAF_WEB_ACL_ARN'], message: 'WAF_MODE=aws 时必须提供 WAF_SCOPE、WAF_WEB_ACL_ARN、WAF_IP_SET_ID、WAF_IP_SET_NAME（waf 栈的 Outputs）' });
});

/** shell-access（05#shell-access 第 3 节）：纯基础设施型，应用侧只有感知器 */
export const ShellAccess = z.object({
  SHELL_ACCESS_MODE: decl(['ssh', 'ssm']),
  SSM_SESSION_LOG_GROUP: optStr,                                // Outputs.EnvSsmSessionLogGroup
  SSM_SESSION_RUN_AS: optStr,                                   // Outputs.EnvSsmSessionRunAs（cloudalbum-ops）
  SHELL_ACCESS_KEEP_SSH: trueFalse.default('false'),            // true = 过渡期保留 22 端口（degraded，SEC-003）
}).superRefine((v, ctx) => {
  if (v.SHELL_ACCESS_MODE === 'ssm' && !v.SSM_SESSION_LOG_GROUP)
    ctx.addIssue({ code: 'custom', path: ['SSM_SESSION_LOG_GROUP'], message: 'SHELL_ACCESS_MODE=ssm 时必须提供 SSM_SESSION_LOG_GROUP（shell-access 栈的 Outputs）' });
});

/** cost（06#cost 第 3 节）：本地估算参数在两种模式下都生效；budgets 只读预算与（手动刷新时）Cost Explorer */
export const Cost = z.object({
  COST_MODE: decl(['local', 'budgets']),
  COST_LOCAL_IDLE_HOURS: z.coerce.number().positive().default(4),   // 长时间空开提醒
  COST_LOCAL_HOURS_BUDGET: z.union([z.literal(''), z.coerce.number().positive()]).optional(),   // 空 = 不设资源小时预算
  COST_RATES_FILE: optStr,                                      // 默认 /etc/cloudalbum/cost-rates.yaml（CFG-010）
  COST_BUDGET_NAMES: optStr,                                    // 逗号分隔：项目预算、账号预算
  COST_TOPIC_ARN: optArn,
  COST_TAG_KEY: z.string().min(1).default('Project'),
  COST_TAG_VALUE: z.string().min(1).default('CloudAlbum'),
  COST_CE_QUERY: z.enum(['manual', 'off']).default('manual'),   // Cost Explorer API 按请求计费：只手动刷新，不轮询
}).superRefine((v, ctx) => {
  if (v.COST_MODE === 'budgets' && !v.COST_BUDGET_NAMES)
    ctx.addIssue({ code: 'custom', path: ['COST_BUDGET_NAMES'], message: 'COST_MODE=budgets 时必须提供 COST_BUDGET_NAMES（cost 栈的 Outputs）' });
});

export const Workflow = section('WORKFLOW_DRIVER', 'inline', z.discriminatedUnion('WORKFLOW_DRIVER', [
  z.object({ WORKFLOW_DRIVER: z.literal('inline'),
             WORKFLOW_LOCAL_MAX_ATTEMPTS: intDefault(3, 1),
             WORKFLOW_LOCAL_BACKOFF_MS: intDefault(2000) }),
  z.object({ WORKFLOW_DRIVER: z.literal('stepfunctions'), WORKFLOW_STATE_MACHINE_ARN: z.string().startsWith('arn:aws:states:'),
             WORKFLOW_RESULT_QUEUE_URL: z.url(),
             WORKFLOW_TYPE: z.enum(['standard', 'express']).default('standard'),
             WORKFLOW_RESULT_WAIT_SEC: intDefault(20) }),
]));

// ---------------------------------------------------------------------------------------------
// 其余应用适配器型模块（总纲 4.4 末尾：“同理：每段一个判别联合，第一个分支是本地实现”）。
// 这些模块的 AWS 分支本轮未实现（implemented.ts 拒绝），因此 AWS 分支的变量一律可选，避免掩盖“未实现”的提示。
// ---------------------------------------------------------------------------------------------
export const Secrets = section('SECRETS_DRIVER', 'env', z.discriminatedUnion('SECRETS_DRIVER', [
  z.object({ SECRETS_DRIVER: z.literal('env'),
             SECRETS_ROTATION: z.literal('off', { error: 'SECRETS_ROTATION=on 只能与 SECRETS_DRIVER=secretsmanager 一起使用（CFG-001）' }).default('off') }),
  z.object({ SECRETS_DRIVER: z.literal('secretsmanager'),
             SECRETS_PREFIX: optStr,                                  // 默认 cloudalbum/<env>/
             SECRETS_CACHE_TTL_SEC: intDefault(300),
             SECRETS_ROTATION: onOff.default('off') }),
]));

export const RuntimeConfigSource = section('CONFIG_DRIVER', 'file', z.discriminatedUnion('CONFIG_DRIVER', [
  z.object({ CONFIG_DRIVER: z.literal('file') }),                     // /etc/cloudalbum/runtime.json（CLOUDALBUM_ENV_DIR）
  z.object({ CONFIG_DRIVER: z.literal('ssm'), CONFIG_PATH: optStr, CONFIG_REFRESH_SEC: intDefault(30, 5) }),
]));

// —— 第 1 波（wave1-prep）：logging、monitoring、notification、email 的 AWS 分支按各模块文档第 3 节收紧——
//    驱动必需的标识（栈 Outputs 写入）为必填；其余子选项取文档默认值。ARN 只校验前缀（计划校验的占位值也能通过）。
export const Logging = section('LOG_DRIVER', 'file', z.discriminatedUnion('LOG_DRIVER', [
  z.object({ LOG_DRIVER: z.literal('file'), LOG_DIR: z.string().default('/var/lib/cloudalbum/logs') }),
  z.object({ LOG_DRIVER: z.literal('cloudwatch'), LOG_DIR: z.string().default('/var/lib/cloudalbum/logs'),
             LOG_CW_GROUP_APP: z.string().min(1),                       // Outputs.EnvLogCwGroupApp
             LOG_CW_GROUP_NGINX: optStr,                                 // Outputs.EnvLogCwGroupNginx
             LOG_CW_SHIPPER: z.enum(['sdk', 'agent']).default('sdk'),    // agent 需要 role（05 组约定 2）
             LOG_CW_FLUSH_MS: intDefault(2000, 100), LOG_CW_MAX_BACKLOG: intDefault(10_000, 100),
             LOG_CW_RETENTION_DAYS: z.coerce.number().int().min(1).optional() }),   // 仅展示；生效的是日志组保留期
]));

export const Monitoring = section('METRICS_DRIVER', 'local', z.discriminatedUnion('METRICS_DRIVER', [
  z.object({ METRICS_DRIVER: z.literal('local') }),
  z.object({ METRICS_DRIVER: z.literal('cloudwatch'),
             METRICS_CW_NAMESPACE: z.string().min(1).default('CloudAlbum/App'),
             METRICS_CW_MODE: z.enum(['putmetricdata', 'emf']).default('putmetricdata'),   // emf 需要 Agent（role）
             METRICS_CW_FLUSH_SEC: intDefault(60, 10),
             METRICS_CW_ALARM_PREFIX: optStr, METRICS_CW_ALARM_TOPIC_ARN: optArn, METRICS_CW_DASHBOARD: optStr,
             METRICS_CW_EMF_ENDPOINT: optStr }),                          // 仅 emf：tcp://127.0.0.1:25888
]));

export const Notification = section('NOTIFY_DRIVER', 'db', z.discriminatedUnion('NOTIFY_DRIVER', [
  z.object({ NOTIFY_DRIVER: z.literal('db') }),
  z.object({ NOTIFY_DRIVER: z.literal('sns'),
             NOTIFY_TOPIC_ARN: arn,                                       // Outputs.EnvNotifyTopicArn
             NOTIFY_INBOX_QUEUE_URL: z.url(),                             // 模块自带收件队列（auxQueues notification-inbox）
             NOTIFY_DLQ_URL: optUrl,                                      // 订阅级 DLQ
             NOTIFY_STATUS_SYNC_SEC: intDefault(300, 30) }),              // pending 订阅确认状态的同步间隔
]));

const emailCommon = {
  EMAIL_FROM: z.string().default('CloudAlbum <no-reply@cloudalbum.local>'),
  OUTBOX_DIR: z.string().default('/var/lib/cloudalbum/outbox'),
  OUTBOX_RETENTION_DAYS: intDefault(30, 1),
};
export const Email = section('EMAIL_DRIVER', 'outbox', z.discriminatedUnion('EMAIL_DRIVER', [
  z.object({ EMAIL_DRIVER: z.literal('outbox'), ...emailCommon }),
  z.object({ EMAIL_DRIVER: z.literal('ses'), ...emailCommon,
             EMAIL_SEND_RATE_PER_SEC: z.coerce.number().positive().default(1),   // 消费者限速，不超过 SES 账号的最大发送速率
             EMAIL_SANDBOX_POLICY: z.enum(['fail', 'outbox']).default('fail'),
             EMAIL_FOR_COGNITO: onOff.default('off'),                             // injects → auth（SesIdentityArn）
             SES_IDENTITY: z.string().min(1),                                     // 已验证的发件身份（域名或地址）
             SES_CONFIGURATION_SET: optStr, SES_FEEDBACK_QUEUE_URL: optUrl }),    // 反馈队列（auxQueues email-feedback）
]));

const schedulerCommon = {
  SCHEDULER_TIMEZONE: z.string().default('Asia/Tokyo'),
  SCHEDULER_CATCHUP: z.string().default(''),                      // 例 report.daily：cron 档启动时补跑漏掉的那一次
  SCHEDULER_COMPARE_HEARTBEAT: onOff.default('off'),              // lab.heartbeat 同时由 node-cron 和 EventBridge 触发
};
export const Scheduler = section('SCHEDULER_DRIVER', 'cron', z.discriminatedUnion('SCHEDULER_DRIVER', [
  z.object({ SCHEDULER_DRIVER: z.literal('cron'), ...schedulerCommon }),
  z.object({ SCHEDULER_DRIVER: z.literal('eventbridge'), ...schedulerCommon,
             SCHEDULER_TICK_QUEUE_URL: optStr, SCHEDULER_DLQ_URL: optStr, SCHEDULER_GROUP: optStr }),
]));

const socialCommon = { SOCIAL_RATE_LIMIT_PER_MIN: intDefault(60, 1) };
export const Social = section('SOCIAL_DRIVER', 'db', z.discriminatedUnion('SOCIAL_DRIVER', [
  z.object({ SOCIAL_DRIVER: z.literal('db'), ...socialCommon }),
  z.object({ SOCIAL_DRIVER: z.literal('dynamodb'), ...socialCommon, SOCIAL_DDB_TABLE: optStr, SOCIAL_DDB_ENDPOINT: optStr }),
]));

export const Tagger = section('TAGGER_DRIVER', 'none', z.discriminatedUnion('TAGGER_DRIVER', [
  z.object({ TAGGER_DRIVER: z.literal('none') }),
  z.object({ TAGGER_DRIVER: z.literal('rekognition'),
             TAGGER_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(75),
             TAGGER_MAX_LABELS: intDefault(15, 1),
             TAGGER_STARTUP_PROBE: onOff.default('on'),
             TAGGER_REGION: optStr, TAGGER_MODERATION_ACTION: optStr, TAGGER_MODERATION_BLOCK: optStr,
             TAGGER_MODERATION_REVIEW: optStr, TAGGER_MODERATION_MIN: optStr, TAGGER_BLOCK_CATEGORIES: optStr }),
]));

const analyticsCommon = {
  ANALYTICS_BUFFER_MAX: intDefault(200, 1),
  ANALYTICS_FLUSH_MS: intDefault(2000, 100),
  ANALYTICS_RETENTION_DAYS: intDefault(30, 1),                    // 仅 db 驱动使用
};
export const Analytics = section('ANALYTICS_DRIVER', 'db', z.discriminatedUnion('ANALYTICS_DRIVER', [
  z.object({ ANALYTICS_DRIVER: z.literal('db'), ...analyticsCommon }),
  z.object({ ANALYTICS_DRIVER: z.literal('firehose'), ...analyticsCommon, ANALYTICS_FIREHOSE_STREAM: optStr,
             ANALYTICS_S3_BUCKET: optStr, ANALYTICS_ATHENA_WORKGROUP: optStr, ANALYTICS_ATHENA_DATABASE: optStr,
             ANALYTICS_ATHENA_TABLE: optStr }),
]));

/** kms 的子选项（02#kms 第 3 节）。开关本身是 Core 的 KMS_KEY_ID（参数型）。 */
export const Kms = z.object({
  KMS_KEY_ID: z.string().default(''),
  KMS_APPLY_TO: z.string().default('fields'),                    // 只含不经栈注入的 fields、ebs
  KMS_DATA_KEY_CACHE_SEC: intDefault(300),
  KMS_DATA_KEY_MAX_USES: intDefault(10_000, 1),
  CRYPTO_LOCAL_PLAINTEXT: onOff.default('off'),                  // lab 子选项，只应写在 local.override.env（CFG-005）
}).superRefine((v, ctx) => {
  if (v.CRYPTO_LOCAL_PLAINTEXT === 'on' && v.KMS_KEY_ID)
    ctx.addIssue({ code: 'custom', message: 'CRYPTO_LOCAL_PLAINTEXT=on 只能与 local 驱动（KMS_KEY_ID 为空）一起使用（CFG-001）' });
});

// ---------------------------------------------------------------------------------------------
// ATL 平台模式（06 PM-01）：第 1b 层 platform.env。这里只做宽松的结构解析（ATL_PLATFORM_MODE 归一为 on / off / invalid），
// 每个变量的格式与跨字段条件由规则 ATL-CFG-001（platform/env-schema.ts 的 validatePlatformEnv）给出——错误照样以 78 退出，
// 报告里是规则 ID 而不是 zod 路径。应用内读取平台状态一律经 platform/mode.ts 的 platformMode()。
// ---------------------------------------------------------------------------------------------
export const Platform = z.object({
  ATL_PLATFORM_MODE: z.string().default('off').transform((v) => {
    const x = v.trim().toLowerCase();
    if (x === '' || x === 'off' || x === '0' || x === 'false') return 'off' as const;
    if (x === 'on' || x === '1' || x === 'true') return 'on' as const;
    return 'invalid' as const;
  }),
  ATL_SESSION_ID: optStr,
  ATL_ENV_ID: optStr,
  ATL_ENV_NAME: optStr,
  ATL_LAB_ID: optStr,
  ATL_VARIANT: optStr,
  ATL_PLATFORM_ORIGIN: optStr,
  ATL_PROBE_TOKEN_FILE: optStr,
  ATL_RELEASE: optStr,
});

export const SECTIONS = {
  core: Core, iam: Iam, storage: Storage, auth: Auth, db: Database, cache: Cache, queue: Queue, image: Image,
  tracing: Tracing, workflow: Workflow, identity: Identity, infra: InfraOptions,
  dns: Dns, tls: Tls, waf: Waf, shellAccess: ShellAccess, cost: Cost,
  secrets: Secrets, config: RuntimeConfigSource, logging: Logging, monitoring: Monitoring,
  notification: Notification, email: Email, scheduler: Scheduler, social: Social, tagger: Tagger,
  analytics: Analytics, kms: Kms, platform: Platform,
} as const;
export type SectionName = keyof typeof SECTIONS;
export type AppConfig = { [K in SectionName]: z.infer<(typeof SECTIONS)[K]> };

export interface ConfigIssue { section: string; path: string; message: string }

export interface ParsedConfig {
  config?: AppConfig;
  errors: ConfigIssue[];
  /**
   * “有效 env”：原始分层合并结果 + 派生默认值 + 解析后各分段的取值（全部转成字符串）。
   * 规则引擎用它求值 registry 表达式（when / need），因此缺省值与显式写出的值等价。
   */
  effective: Record<string, string>;
}

/**
 * 路径类默认值由 CLOUDALBUM_DATA_DIR / CLOUDALBUM_ENV_DIR 派生（L0 下与总纲的字面默认值完全一致：
 * /var/lib/cloudalbum/... 与 /etc/cloudalbum/...）；显式写出的值优先。
 */
export function applyDerivedDefaults(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  const dataDir = out.CLOUDALBUM_DATA_DIR || '/var/lib/cloudalbum';
  const envDir = out.CLOUDALBUM_ENV_DIR || '/etc/cloudalbum';
  const join = (base: string, ...p: string[]) => (base.startsWith('/') ? path.posix.join(base, ...p) : path.join(base, ...p));
  const storageDriver = out.STORAGE_DRIVER || 'local';
  if (!out.STORAGE_LOCAL_ROOT && storageDriver === 'local') out.STORAGE_LOCAL_ROOT = join(dataDir, 'uploads');
  if (!out.SQLITE_PATH) out.SQLITE_PATH = join(dataDir, 'db', 'cloudalbum.sqlite');
  if (!out.OUTBOX_DIR) out.OUTBOX_DIR = join(dataDir, 'outbox');
  if (!out.LOG_DIR) out.LOG_DIR = join(dataDir, 'logs');
  if (!out.JWT_SIGNING_KEY_FILE) out.JWT_SIGNING_KEY_FILE = join(envDir, 'keys', 'jwt-es256.pem');
  return out;
}

/** STORAGE_LOCAL_ROOT（local / efs 驱动；s3 驱动下为本地默认根目录，供迁移脚本把数据搬回本地时使用） */
export function storageLocalRoot(cfg: AppConfig): string {
  return 'STORAGE_LOCAL_ROOT' in cfg.storage
    ? cfg.storage.STORAGE_LOCAL_ROOT
    : path.join(cfg.core.CLOUDALBUM_DATA_DIR, 'uploads');
}

function stringifyValue(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String).join(',');
  return String(v);
}

export interface ParseOptions {
  /** 拒绝本轮未实现的驱动（默认 true）。规则引擎的单元测试与部署前计划可以关闭它，只做结构校验。 */
  checkImplemented?: boolean;
}

/** 一次性收集所有分段的错误，而不是遇到第一个就退出 */
export function parseConfig(env: Record<string, string | undefined>, opts: ParseOptions = {}): ParsedConfig {
  const input = applyDerivedDefaults(env);
  const config: Partial<Record<SectionName, unknown>> = {};
  const errors: ConfigIssue[] = [];
  const effective: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) effective[k] = v;
  for (const [name, schema] of Object.entries(SECTIONS) as Array<[SectionName, z.ZodType]>) {
    const r = schema.safeParse(input);
    if (r.success) {
      config[name] = r.data;
      for (const [k, v] of Object.entries(r.data as Record<string, unknown>)) {
        const s = stringifyValue(v);
        if (s !== undefined) effective[k] = s;
      }
    } else {
      for (const i of r.error.issues) errors.push({ section: name, path: i.path.join('.'), message: i.message });
    }
  }
  // 结构校验通过后：拒绝本轮未实现的驱动（CFG-001，退出码 78）
  if (!errors.length && opts.checkImplemented !== false) errors.push(...implementationErrors(effective));
  return { config: errors.length ? undefined : (config as AppConfig), errors, effective };
}

// ---------------------------------------------------------------------------------------------
// 键清单（registry:check 用：registry requires / conflicts 中出现的每个变量都必须在某个分段中声明）
// ---------------------------------------------------------------------------------------------
type ZodDefLike = { type?: string; shape?: Record<string, unknown> | (() => Record<string, unknown>); options?: unknown[];
  in?: unknown; out?: unknown; innerType?: unknown };

function keysOf(schema: unknown, acc: Set<string>): void {
  const def = (schema as { _zod?: { def?: ZodDefLike } })?._zod?.def;
  if (!def) return;
  switch (def.type) {
    case 'object': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      for (const k of Object.keys(shape ?? {})) acc.add(k);
      return;
    }
    case 'union':
      for (const o of def.options ?? []) keysOf(o, acc);
      return;
    case 'pipe':
      keysOf(def.in, acc);
      keysOf(def.out, acc);
      return;
    default:
      if (def.innerType) keysOf(def.innerType, acc);
  }
}

export const CONFIG_KEYS: ReadonlySet<string> = (() => {
  const acc = new Set<string>();
  for (const s of Object.values(SECTIONS)) keysOf(s, acc);
  return acc;
})();
