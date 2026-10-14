// 测试辅助：用内存中的 env 走一遍“zod → 规则引擎”，以及常用模块的启用片段
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layersFromEnv, type EnvLayers } from '../../src/config/load-env.js';
import { parseConfig, type ParsedConfig } from '../../src/config/schema.js';
import { runRules, type Finding, type RuleScope, type Verdict } from '../../src/rules/engine.js';
import { RULES } from '../../src/rules/rules.js';

export type Env = Record<string, string>;

export interface Evaluation {
  parsed: ParsedConfig;
  verdict?: Verdict;
}

export function evaluate(env: Env, opts: { phases?: RuleScope[]; checkImplemented?: boolean; layers?: EnvLayers } = {}): Evaluation {
  const layers = opts.layers ?? layersFromEnv(env);
  const parsed = parseConfig({ ...layers.merged, CLOUDALBUM_ROLE: 'api' }, { checkImplemented: opts.checkImplemented ?? false });
  if (!parsed.config) return { parsed };
  const verdict = runRules(RULES, { cfg: parsed.config, env: parsed.effective, layers, role: 'api' }, { phases: opts.phases ?? ['startup'] });
  return { parsed, verdict };
}

export type Outcome = 'error' | 'warn' | 'overridden' | 'none';

export function outcomeOf(v: Verdict | undefined, rule: string): Outcome {
  if (!v) throw new Error('config did not parse');
  const has = (list: Finding[]) => list.some((f) => f.rule === rule);
  if (has(v.errors)) return 'error';
  if (has(v.overridden)) return 'overridden';
  if (has(v.warnings)) return 'warn';
  return 'none';
}

/** 写一个临时的 /etc/cloudalbum 目录（cloudalbum.env、modules.d、secrets.env、local.override.env） */
export function tempEnvDir(files: { base?: Env; modules?: Record<string, Env>; secrets?: Env; override?: Env; raw?: Record<string, string> }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cloudalbum-env-'));
  const write = (rel: string, env: Env) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  };
  if (files.base) write('cloudalbum.env', files.base);
  for (const [id, env] of Object.entries(files.modules ?? {})) write(path.join('modules.d', `${id}.env`), env);
  if (files.secrets) write('secrets.env', files.secrets);
  if (files.override) write('local.override.env', files.override);
  for (const [rel, content] of Object.entries(files.raw ?? {})) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

// —— 常用模块的“已启用”片段（与 scripts/module 写入 modules.d 的内容一致）——
export const ENABLE = {
  iamRole: { MODULE_IAM: 'on', IAM_CREDENTIALS: 'role' },
  iamKeys: { MODULE_IAM: 'on', IAM_CREDENTIALS: 'keys', IAM_KEYS_ACCESS_KEY_ID: 'AKIAEXAMPLE', IAM_KEYS_SECRET_ACCESS_KEY: 'secret' },
  s3: { MODULE_STORAGE: 'on', STORAGE_DRIVER: 's3', STORAGE_S3_RAW_BUCKET: 'cloudalbum-lab-raw', STORAGE_S3_MEDIA_BUCKET: 'cloudalbum-lab-media' },
  cdn: { MODULE_CDN: 'on', CDN_BASE_URL: 'https://d111111abcdef8.cloudfront.net' },
  cognito: {
    MODULE_AUTH: 'on', AUTH_DRIVER: 'cognito', COGNITO_USER_POOL_ID: 'ap-northeast-1_AbCdEf123', COGNITO_CLIENT_ID: 'client123',
  },
  sqs: {
    MODULE_QUEUE: 'on', QUEUE_DRIVER: 'sqs',
    SQS_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/cloudalbum-lab-queue-jobs',
    SQS_DLQ_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/cloudalbum-lab-queue-jobs-dlq',
  },
  lambdaQueue: {
    MODULE_IMAGE_PROCESSING: 'on', IMAGE_PROCESSOR: 'lambda',
    IMAGE_LAMBDA_FUNCTION: 'arn:aws:lambda:ap-northeast-1:123456789012:function:cloudalbum-lab-image-processing-thumbnail',
    IMAGE_RESULT_CHANNEL: 'queue',
    IMAGE_RESULT_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/image-results',
    IMAGE_FAILURE_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/image-failed',
  },
  lambdaCallback: {
    MODULE_IMAGE_PROCESSING: 'on', IMAGE_PROCESSOR: 'lambda',
    IMAGE_LAMBDA_FUNCTION: 'arn:aws:lambda:ap-northeast-1:123456789012:function:cloudalbum-lab-image-processing-thumbnail',
    IMAGE_CALLBACK_URL: 'https://album.example.com/internal/hooks/image-processed',
    IMAGE_FAILURE_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/image-failed',
  },
  elasticache: { MODULE_CACHE: 'on', CACHE_DRIVER: 'redis', REDIS_URL: 'rediss://master.cloudalbum-lab-cache.abc123.apne1.cache.amazonaws.com:6379' },
  valkeyLocal: { CACHE_DRIVER: 'redis', REDIS_URL: 'redis://127.0.0.1:6379', REDIS_TLS: 'off' },
  rds: {
    MODULE_DATABASE: 'on', DB_DRIVER: 'postgres', DB_HOST: 'cloudalbum-lab-database.abc123.ap-northeast-1.rds.amazonaws.com',
    DB_USER: 'cloudalbum', DB_PASSWORD: 'secret',
  },
  pgLocal: { DB_DRIVER: 'postgres', DB_HOST: '127.0.0.1', DB_USER: 'cloudalbum', DB_PASSWORD: 'secret', DB_SSL: 'disable' },
  asg: { MODULE_AUTOSCALING: 'on', DEPLOY_MODE: 'asg' },
  // —— 第 1 波（wave1-prep）：各模块文档第 3 节的 env 示例（值为文档示例 / 占位）——
  notification: {
    MODULE_NOTIFICATION: 'on', NOTIFY_DRIVER: 'sns',
    NOTIFY_TOPIC_ARN: 'arn:aws:sns:ap-northeast-1:123456789012:cloudalbum-lab-notification-events',
    NOTIFY_INBOX_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/cloudalbum-lab-notification-inbox',
  },
  email: { MODULE_EMAIL: 'on', EMAIL_DRIVER: 'ses', SES_IDENTITY: 'mail.example.com', EMAIL_FROM: 'CloudAlbum <no-reply@mail.example.com>' },
  monitoring: { MODULE_MONITORING: 'on', METRICS_DRIVER: 'cloudwatch', METRICS_CW_NAMESPACE: 'CloudAlbum/App' },
  logging: { MODULE_LOGGING: 'on', LOG_DRIVER: 'cloudwatch', LOG_CW_GROUP_APP: '/cloudalbum/lab/app', LOG_CW_GROUP_NGINX: '/cloudalbum/lab/nginx' },
  identityPool: {
    MODULE_IDENTITY_POOL: 'on', IDENTITY_POOL_ID: 'ap-northeast-1:12345678-1234-1234-1234-123456789012',
    IDENTITY_STAGING_BUCKET: 'cloudalbum-lab-upload-staging-123456789012',
  },
  waf: {
    MODULE_WAF: 'on', WAF_MODE: 'aws', WAF_SCOPE: 'CLOUDFRONT',
    WAF_WEB_ACL_ARN: 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/cloudalbum-lab-acl/0000', WAF_IP_SET_ID: 'ipset-0000',
    WAF_IP_SET_NAME: 'cloudalbum-blocklist',
  },
  shellAccess: { MODULE_SHELL_ACCESS: 'on', SHELL_ACCESS_MODE: 'ssm', SSM_SESSION_LOG_GROUP: '/cloudalbum/lab/ssm-sessions', SSM_SESSION_RUN_AS: 'cloudalbum-ops' },
  dns: {
    MODULE_DNS: 'on', DNS_PROVIDER: 'route53', APP_BASE_URL: 'http://album.example.com', DNS_HOSTED_ZONE_ID: 'Z0123456789ABCDEFGHIJ',
    DNS_RECORD_NAME: 'album.example.com', DNS_TARGET_TYPE: 'eip',
  },
  tlsAcme: {
    MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', TLS_ACME: 'on',
    TLS_ACME_DIRECTORY_URL: 'https://acm-acme-enroll.ap-northeast-1.api.aws/0000/directory',
  },
  cost: { MODULE_COST: 'on', COST_MODE: 'budgets', COST_BUDGET_NAMES: 'cloudalbum-lab-project-monthly,cloudalbum-lab-account-monthly' },
} as const satisfies Record<string, Env>;
