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
  IDENTITY_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),   // none 驱动的前缀令牌有效期
  IDENTITY_DEV_PROVIDER: z.string().default(''),          // auth=local 时的开发者认证身份（如 login.cloudalbum）
  IDENTITY_STAGING_BUCKET: optStr,                        // cognito 驱动：模块自带暂存桶
  IDENTITY_UPLOAD_PREFIX: z.string().default('private/'),
  IDENTITY_PART_SIZE_MB: z.coerce.number().int().min(5).default(8),
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
  NETWORK_INTERFACE_ENDPOINTS: z.enum(['none', 'ops', 'all']).default('none'),
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
  LB_HTTPS: trueFalse.default('false'),
  LB_ADMIN_AUTH: z.enum(['app', 'cognito']).default('app'),                      // DEP-011、017
  LB_ORIGIN_VERIFY: onOff.default('off'),                                         // DEP-042
  LB_LOCK_ORIGIN: onOff.default('off'),
  WAF_SCOPE: z.enum(['CLOUDFRONT', 'REGIONAL']).optional(),                     // waf 的 injects 条件（CLOUDFRONT 时注入 cdn 的 WebAclArn）
  BACKUP_WHOLE_INSTANCE: onOff.default('off'),                                    // backup 的 baseParams 条件（整机恢复变体）
  COMPLIANCE_LOCAL_INTERVAL_SEC: z.coerce.number().int().min(60).default(300),   // 本地自检周期（local 与 config 档都运行）
  COMPLIANCE_RECORDER: z.enum(['created', 'external']).optional(),              // config 档必填（superRefine）
  COMPLIANCE_RULE_PREFIX: optStr,                                                 // config 档必填
  COMPLIANCE_TOPIC_ARN: optStr,
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

export const Logging = section('LOG_DRIVER', 'file', z.discriminatedUnion('LOG_DRIVER', [
  z.object({ LOG_DRIVER: z.literal('file'), LOG_DIR: z.string().default('/var/lib/cloudalbum/logs') }),
  z.object({ LOG_DRIVER: z.literal('cloudwatch'), LOG_DIR: z.string().default('/var/lib/cloudalbum/logs'),
             LOG_CW_GROUP_APP: optStr, LOG_CW_GROUP_NGINX: optStr,
             LOG_CW_SHIPPER: z.enum(['sdk', 'agent']).default('sdk'),
             LOG_CW_FLUSH_MS: intDefault(2000), LOG_CW_MAX_BACKLOG: intDefault(10_000), LOG_CW_RETENTION_DAYS: optStr }),
]));

export const Monitoring = section('METRICS_DRIVER', 'local', z.discriminatedUnion('METRICS_DRIVER', [
  z.object({ METRICS_DRIVER: z.literal('local') }),
  z.object({ METRICS_DRIVER: z.literal('cloudwatch'), METRICS_CW_NAMESPACE: optStr, METRICS_CW_MODE: optStr,
             METRICS_CW_FLUSH_SEC: optStr, METRICS_CW_ALARM_PREFIX: optStr, METRICS_CW_ALARM_TOPIC_ARN: optStr,
             METRICS_CW_DASHBOARD: optStr, METRICS_CW_EMF_ENDPOINT: optStr }),
]));

export const Notification = section('NOTIFY_DRIVER', 'db', z.discriminatedUnion('NOTIFY_DRIVER', [
  z.object({ NOTIFY_DRIVER: z.literal('db') }),
  z.object({ NOTIFY_DRIVER: z.literal('sns'), NOTIFY_TOPIC_ARN: optStr, NOTIFY_INBOX_QUEUE_URL: optStr,
             NOTIFY_DLQ_URL: optStr, NOTIFY_STATUS_SYNC_SEC: optStr }),
]));

const emailCommon = {
  EMAIL_FROM: z.string().default('CloudAlbum <no-reply@cloudalbum.local>'),
  OUTBOX_DIR: z.string().default('/var/lib/cloudalbum/outbox'),
  OUTBOX_RETENTION_DAYS: intDefault(30, 1),
};
export const Email = section('EMAIL_DRIVER', 'outbox', z.discriminatedUnion('EMAIL_DRIVER', [
  z.object({ EMAIL_DRIVER: z.literal('outbox'), ...emailCommon }),
  z.object({ EMAIL_DRIVER: z.literal('ses'), ...emailCommon,
             EMAIL_SEND_RATE_PER_SEC: optStr, EMAIL_SANDBOX_POLICY: z.enum(['fail', 'outbox']).default('fail'),
             EMAIL_FOR_COGNITO: onOff.default('off'), SES_CONFIGURATION_SET: optStr, SES_FEEDBACK_QUEUE_URL: optStr,
             SES_IDENTITY: optStr }),
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

export const SECTIONS = {
  core: Core, iam: Iam, storage: Storage, auth: Auth, db: Database, cache: Cache, queue: Queue, image: Image,
  tracing: Tracing, workflow: Workflow, identity: Identity, infra: InfraOptions,
  secrets: Secrets, config: RuntimeConfigSource, logging: Logging, monitoring: Monitoring,
  notification: Notification, email: Email, scheduler: Scheduler, social: Social, tagger: Tagger,
  analytics: Analytics, kms: Kms,
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
