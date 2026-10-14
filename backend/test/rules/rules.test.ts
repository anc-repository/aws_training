// 规则表的表驱动测试（总纲 §5、backend/test/rules/）：本轮 MVP 模块（iam、storage、cdn、auth、queue、image-processing、
// cache、database）相关的规则各有正反两个用例；另有 L0 基线、覆盖（CLOUDALBUM_ALLOW_UNSAFE）与“默认值成立时的作用域”用例。
import { describe, expect, it } from 'vitest';
import { RULES } from '../../src/rules/rules.js';
import { ENABLE, evaluate, outcomeOf, type Env, type Outcome } from '../helpers/config.js';

interface Case {
  rule: string;
  name: string;
  env: Env;
  expect: Outcome;
  phases?: Array<'startup' | 'deploy' | 'runtime'>;
}

const { iamRole, iamKeys, s3, cdn, cognito, sqs, lambdaQueue, lambdaCallback, elasticache, valkeyLocal, rds, pgLocal, asg } = ENABLE;
const { notification, email, monitoring, logging, identityPool, waf, shellAccess, dns, tlsAcme, cost } = ENABLE;

const CASES: Case[] = [
  // —— CRED ——
  { rule: 'CRED-001', name: 'storage(s3) 启用但 IAM_CREDENTIALS=none', env: { ...s3 }, expect: 'error' },
  { rule: 'CRED-001', name: 'storage(s3) + iam(role)', env: { ...s3, ...iamRole }, expect: 'none' },
  { rule: 'CRED-001', name: 'cache(redis) 是 optional，不触发', env: { ...elasticache }, expect: 'none' },
  { rule: 'CRED-002', name: 'IAM_CREDENTIALS=keys 是反面教材', env: { ...iamKeys }, expect: 'warn' },
  { rule: 'CRED-002', name: 'IAM_CREDENTIALS=role', env: { ...iamRole }, expect: 'none' },
  { rule: 'CRED-004', name: 'cdn（optional）启用但无凭证', env: { ...cdn }, expect: 'warn' },
  { rule: 'CRED-004', name: 'cdn + iam(role)', env: { ...cdn, ...iamRole }, expect: 'none' },
  { rule: 'CRED-004', name: 'database（optional，RDS）启用但无凭证', env: { ...rds }, expect: 'warn' },

  // —— CFG ——
  { rule: 'CFG-004', name: 'MODULE_STORAGE=on 但 STORAGE_DRIVER 仍是 local（半启用）', env: { MODULE_STORAGE: 'on', ...iamRole }, expect: 'error' },
  { rule: 'CFG-004', name: 'STORAGE_DRIVER=s3 却没有 MODULE_STORAGE=on', env: { ...s3, MODULE_STORAGE: '', ...iamRole }, expect: 'error' },
  { rule: 'CFG-004', name: '自建 PostgreSQL（回环）命中 selfHosted.match，不要求 MODULE_DATABASE', env: { ...pgLocal }, expect: 'none' },
  { rule: 'CFG-004', name: '自建 Valkey（回环）命中 selfHosted.match', env: { ...valkeyLocal }, expect: 'none' },
  { rule: 'CFG-004', name: '本地档 CACHE_DRIVER=memory（localTiers）', env: { CACHE_DRIVER: 'memory' }, expect: 'none' },
  { rule: 'CFG-004', name: 'CDN_BASE_URL 非空却没有 MODULE_CDN', env: { CDN_BASE_URL: 'https://d1.cloudfront.net' }, expect: 'error' },
  { rule: 'CFG-005', name: 'local.override.env 不存在', env: {}, expect: 'none' },
  { rule: 'CFG-006', name: 'MODULE_STORAGE_VERSION 与注册表不一致', env: { ...s3, ...iamRole, MODULE_STORAGE_VERSION: '2' }, expect: 'warn' },
  { rule: 'CFG-006', name: 'MODULE_STORAGE_VERSION 与注册表一致', env: { ...s3, ...iamRole, MODULE_STORAGE_VERSION: '1' }, expect: 'none' },
  { rule: 'CFG-001', name: 'CLOUDALBUM_ALLOW_UNSAFE 列出不可覆盖的规则', env: { CLOUDALBUM_ALLOW_UNSAFE: 'CRED-001' }, expect: 'error' },
  { rule: 'CFG-001', name: 'CLOUDALBUM_ALLOW_UNSAFE 列出可覆盖的规则', env: { CLOUDALBUM_ALLOW_UNSAFE: 'ASG-004' }, expect: 'none' },

  // —— DEP（MVP 模块相关）——
  { rule: 'DEP-003', name: 'IMAGE_PROCESSOR=lambda 但 STORAGE_DRIVER=local', env: { ...lambdaQueue, ...iamRole }, expect: 'error' },
  { rule: 'DEP-003', name: 'IMAGE_PROCESSOR=lambda + storage(s3)', env: { ...lambdaQueue, ...s3, ...iamRole }, expect: 'none' },
  { rule: 'DEP-004', name: 'IMAGE_PROCESSOR=worker + QUEUE_DRIVER=sync', env: { IMAGE_PROCESSOR: 'worker' }, expect: 'error' },
  { rule: 'DEP-004', name: 'IMAGE_PROCESSOR=worker + QUEUE_DRIVER=memory（本地档组合）', env: { IMAGE_PROCESSOR: 'worker', QUEUE_DRIVER: 'memory' }, expect: 'none' },
  { rule: 'DEP-004', name: 'IMAGE_PROCESSOR=worker + queue(sqs)', env: { IMAGE_PROCESSOR: 'worker', ...sqs, ...iamRole }, expect: 'none' },
  { rule: 'DEP-010', name: 'CDN_MEDIA_ORIGIN=s3 但 STORAGE_DRIVER=local（部署范围）', env: { ...cdn, CDN_MEDIA_ORIGIN: 's3' }, phases: ['startup', 'deploy'], expect: 'error' },
  { rule: 'DEP-010', name: '部署范围的规则不在启动时检查', env: { ...cdn, CDN_MEDIA_ORIGIN: 's3' }, phases: ['startup'], expect: 'none' },
  { rule: 'DEP-010', name: 'CDN_MEDIA_ORIGIN=s3 + storage(s3)', env: { ...cdn, ...s3, ...iamRole, CDN_MEDIA_ORIGIN: 's3' }, phases: ['startup', 'deploy'], expect: 'none' },
  { rule: 'DEP-013', name: 'auth(cognito) + EMAIL_DRIVER=outbox 提示', env: { ...cognito, ...iamRole }, expect: 'warn' },
  { rule: 'DEP-013', name: 'auth=local 不提示', env: {}, expect: 'none' },
  { rule: 'DEP-020', name: 'lambda callback 通道 + cdn 已启用', env: { ...lambdaCallback, ...s3, ...cdn, ...iamRole }, expect: 'warn' },
  { rule: 'DEP-020', name: 'lambda queue 通道 + cdn', env: { ...lambdaQueue, ...s3, ...cdn, ...iamRole }, expect: 'none' },
  { rule: 'DEP-021', name: 'IMAGE_CALLBACK_URL 为 http://', env: { ...lambdaCallback, ...s3, ...iamRole, IMAGE_CALLBACK_URL: 'http://203.0.113.10/internal/hooks/image-processed' }, expect: 'warn' },
  { rule: 'DEP-021', name: 'IMAGE_CALLBACK_URL 为 https://', env: { ...lambdaCallback, ...s3, ...iamRole }, expect: 'none' },
  { rule: 'DEP-028', name: 'cdn 启用、媒体源站默认 ec2，而 storage=s3', env: { ...cdn, ...s3, ...iamRole }, expect: 'warn' },
  { rule: 'DEP-028', name: '默认值成立的 when 只在 cdn 启用时生效（storage=s3、cdn 未启用）', env: { ...s3, ...iamRole }, expect: 'none' },
  { rule: 'DEP-029', name: 'COGNITO_LOGIN_MODE=managed 但没有受信 HTTPS', env: { ...cognito, ...iamRole, COGNITO_LOGIN_MODE: 'managed' }, expect: 'error' },
  { rule: 'DEP-029', name: 'COGNITO_LOGIN_MODE=managed + cdn（默认证书）', env: { ...cognito, ...cdn, ...iamRole, COGNITO_LOGIN_MODE: 'managed' }, expect: 'none' },
  { rule: 'DEP-031', name: 'AUTH_MIGRATION=lazy 但 COGNITO_TRIGGERS=off', env: { ...cognito, ...iamRole, AUTH_MIGRATION: 'lazy' }, expect: 'error' },
  { rule: 'DEP-031', name: 'AUTH_MIGRATION=lazy + COGNITO_TRIGGERS=on', env: { ...cognito, ...iamRole, AUTH_MIGRATION: 'lazy', COGNITO_TRIGGERS: 'on' }, expect: 'none' },
  { rule: 'DEP-038', name: 'CDN_ORIGIN_TYPE=alb 但 load-balancer 未启用', env: { ...cdn, CDN_ORIGIN_TYPE: 'alb' }, expect: 'error' },
  { rule: 'DEP-038', name: 'CDN_ORIGIN_TYPE=ec2（默认）', env: { ...cdn }, expect: 'none' },
  { rule: 'DEP-002', name: 'identity-pool 的 when 在 L0 默认值下成立，但只在模块启用时生效', env: {}, expect: 'none' },
  { rule: 'DEP-033', name: 'DB_PROXY_MODE=pgbouncer 而 DB_DRIVER=sqlite', env: { DB_PROXY_MODE: 'pgbouncer' }, expect: 'error' },
  { rule: 'DEP-033', name: 'DB_PROXY_MODE=pgbouncer + 自建 PostgreSQL', env: { ...pgLocal, DB_PROXY_MODE: 'pgbouncer', DB_PROXY_ENDPOINT: '127.0.0.1', DB_PROXY_PORT: '6432' }, expect: 'none' },

  // —— MUTEX ——
  { rule: 'MUTEX-001', name: 'storage 与 shared-fs 同时声明启用', env: { ...s3, ...iamRole, MODULE_SHARED_FS: 'on' }, expect: 'error' },
  { rule: 'MUTEX-001', name: '只有 storage', env: { ...s3, ...iamRole }, expect: 'none' },
  { rule: 'MUTEX-002', name: 'database 已启用（RDS）但 DB_HOST 指向本机', env: { ...rds, DB_HOST: '127.0.0.1' }, expect: 'error' },
  { rule: 'MUTEX-002', name: 'database 指向 RDS 端点', env: { ...rds }, expect: 'none' },
  { rule: 'MUTEX-003', name: 'cache 已启用（ElastiCache）但 REDIS_URL 指向本机', env: { ...elasticache, REDIS_URL: 'redis://localhost:6379' }, expect: 'error' },
  { rule: 'MUTEX-003', name: 'cache 指向 ElastiCache', env: { ...elasticache }, expect: 'none' },
  { rule: 'MUTEX-005', name: 'IMAGE_PROCESSOR=lambda 与 WORKFLOW_DRIVER=stepfunctions 互斥', env: {
    ...lambdaQueue, ...s3, ...iamRole, MODULE_WORKFLOW: 'on', WORKFLOW_DRIVER: 'stepfunctions',
    WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:ap-northeast-1:123456789012:stateMachine:x',
    WORKFLOW_RESULT_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/wf',
  }, expect: 'error' },
  { rule: 'MUTEX-005', name: 'lambda 单独启用', env: { ...lambdaQueue, ...s3, ...iamRole }, expect: 'none' },

  // —— ASG（DEPLOY_MODE=asg；autoscaling 本轮未实现，规则层仍可求值）——
  { rule: 'ASG-001', name: 'asg + STORAGE_DRIVER=local', env: { ...asg }, expect: 'error' },
  { rule: 'ASG-001', name: 'asg + storage(s3)', env: { ...asg, ...s3, ...iamRole }, expect: 'none' },
  { rule: 'ASG-001', name: 'single 不检查', env: {}, expect: 'none' },
  { rule: 'ASG-001', name: 'CLOUDALBUM_ALLOW_UNSAFE=ASG-001 降级为 overridden', env: { ...asg, CLOUDALBUM_ALLOW_UNSAFE: 'ASG-001' }, expect: 'overridden' },
  { rule: 'ASG-002', name: 'asg + sqlite', env: { ...asg }, expect: 'error' },
  { rule: 'ASG-002', name: 'asg + RDS', env: { ...asg, ...rds }, expect: 'none' },
  { rule: 'ASG-003', name: 'asg + 自建 PostgreSQL（回环）', env: { ...asg, ...pgLocal }, expect: 'error' },
  { rule: 'ASG-003', name: 'asg + RDS', env: { ...asg, ...rds }, expect: 'none' },
  { rule: 'ASG-004', name: 'asg + CACHE_DRIVER=memory', env: { ...asg, CACHE_DRIVER: 'memory' }, expect: 'error' },
  { rule: 'ASG-004', name: 'asg + 每台实例各自的自建 Valkey（回环）', env: { ...asg, ...valkeyLocal }, expect: 'error' },
  { rule: 'ASG-004', name: 'asg + ElastiCache', env: { ...asg, ...elasticache }, expect: 'none' },
  { rule: 'ASG-004', name: '单机两进程（LB_LOCAL_WORKERS=2）+ memory 为警告', env: { LB_LOCAL_WORKERS: '2', CACHE_DRIVER: 'memory' }, expect: 'warn' },
  { rule: 'ASG-004', name: '单机两进程 + 回环 Valkey 被两个进程共享，不触发', env: { LB_LOCAL_WORKERS: '2', ...valkeyLocal }, expect: 'none' },
  { rule: 'ASG-004', name: 'CLOUDALBUM_ALLOW_UNSAFE=ASG-004（教学：故意在 ASG 下用 memory 缓存）', env: { ...asg, CACHE_DRIVER: 'memory', CLOUDALBUM_ALLOW_UNSAFE: 'ASG-004' }, expect: 'overridden' },
  { rule: 'ASG-005', name: 'asg + QUEUE_DRIVER=memory', env: { ...asg, QUEUE_DRIVER: 'memory' }, expect: 'error' },
  { rule: 'ASG-005', name: 'asg + queue(sqs)', env: { ...asg, ...sqs, ...iamRole }, expect: 'none' },
  { rule: 'ASG-006', name: 'asg + cron + 文件锁（scope=host）', env: { ...asg }, expect: 'error' },
  { rule: 'ASG-006', name: 'asg + cron + pg advisory lock（RDS，scope=cluster）', env: { ...asg, ...rds }, expect: 'none' },
  { rule: 'ASG-007', name: 'asg + auth=local + SECRETS_ORIGIN=instance', env: { ...asg }, expect: 'error' },
  { rule: 'ASG-007', name: 'asg + auth=local + SECRETS_ORIGIN=bundle', env: { ...asg, SECRETS_ORIGIN: 'bundle' }, expect: 'none' },
  { rule: 'ASG-007', name: 'asg + auth(cognito)', env: { ...asg, ...cognito, ...iamRole }, expect: 'none' },
  { rule: 'ASG-013', name: 'asg + 进程内限速计数', env: { ...asg }, expect: 'warn' },
  { rule: 'ASG-013', name: 'asg + ElastiCache 计数 + AWS WAF', env: { ...asg, ...elasticache, ...cdn, ...waf }, expect: 'none' },

  // —— 第 1 波模块相关（wave1-prep）——
  { rule: 'CRED-002', name: 'keys + monitoring：Agent 子功能不可用（detail）', env: { ...iamKeys, ...monitoring }, expect: 'warn' },
  { rule: 'CRED-001', name: 'notification(sns) 启用但 IAM_CREDENTIALS=none', env: { ...notification }, expect: 'error' },
  { rule: 'CRED-001', name: 'notification(sns) + iam(role)', env: { ...notification, ...iamRole }, expect: 'none' },
  { rule: 'DEP-001', name: 'SHELL_ACCESS_MODE=ssm 但 IAM_CREDENTIALS=keys', env: { ...shellAccess, ...iamKeys }, expect: 'error' },
  { rule: 'DEP-001', name: 'shell-access(ssm) + iam(role)', env: { ...shellAccess, ...iamRole }, expect: 'none' },
  { rule: 'DEP-002', name: 'identity-pool 启用但 STORAGE_DRIVER=local', env: { ...identityPool, ...cognito, ...iamRole }, expect: 'error' },
  { rule: 'DEP-002', name: 'identity-pool + storage(s3) + auth(cognito)', env: { ...identityPool, ...cognito, ...s3, ...iamRole }, expect: 'none' },
  { rule: 'DEP-005', name: 'TLS_MODE=acm 但 TLS_DOMAIN 为空（没有自有域名）', env: { ...tlsAcme, TLS_DOMAIN: '' }, expect: 'error' },
  { rule: 'DEP-005', name: 'TLS_ACME=off（回退分支）而没有 cdn / load-balancer', env: { MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', TLS_ACME: 'off', DNS_PROVIDER: 'external' }, expect: 'error' },
  { rule: 'DEP-005', name: 'TLS_ACME=on：只有 L0 + 域名即可', env: { ...tlsAcme }, expect: 'none' },
  { rule: 'DEP-005', name: 'TLS_ACME=off + 外部 DNS + cdn', env: { MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', TLS_ACME: 'off', DNS_PROVIDER: 'external', ...cdn, ...iamRole }, expect: 'none' },
  { rule: 'DEP-006', name: 'WAF_MODE=aws 但没有 cdn / load-balancer', env: { ...waf }, expect: 'error' },
  { rule: 'DEP-006', name: 'waf(aws) + cdn', env: { ...waf, ...cdn, ...iamRole }, expect: 'none' },
  { rule: 'DEP-015', name: 'TLS_FORCE_HTTPS=true 而证书是自签名', env: { TLS_FORCE_HTTPS: 'true' }, expect: 'error' },
  { rule: 'DEP-015', name: 'TLS_FORCE_HTTPS=true + acm', env: { ...tlsAcme, TLS_FORCE_HTTPS: 'true' }, expect: 'none' },
  { rule: 'DEP-018', name: 'waf(aws, CLOUDFRONT) 而 CDN_DIRECT_ACCESS=open（运行期）', env: { ...waf, ...cdn, ...iamRole }, phases: ['runtime'], expect: 'warn' },
  { rule: 'DEP-018', name: 'waf(aws) + CDN_DIRECT_ACCESS=closed', env: { ...waf, ...cdn, ...iamRole, CDN_DIRECT_ACCESS: 'closed' }, phases: ['runtime'], expect: 'none' },
  { rule: 'DEP-030', name: 'identity-pool 启用而 APP_BASE_URL 是 http://', env: { ...identityPool, ...cognito, ...s3, ...iamRole, APP_BASE_URL: 'http://203.0.113.10' }, expect: 'warn' },
  { rule: 'DEP-030', name: 'identity-pool + https 入口', env: { ...identityPool, ...cognito, ...s3, ...iamRole, APP_BASE_URL: 'https://album.example.com', EXPOSE_PATH_HEADERS: 'admin' }, expect: 'none' },
  { rule: 'DEP-040', name: 'DNS_TARGET_TYPE=alb 但 load-balancer 未启用', env: { ...dns, DNS_TARGET_TYPE: 'alb' }, expect: 'error' },
  { rule: 'DEP-040', name: 'DNS_TARGET_TYPE=eip', env: { ...dns }, expect: 'none' },
  { rule: 'DEP-041', name: 'DNS_TARGET_TYPE=cloudfront 但没有 tls', env: { ...dns, DNS_TARGET_TYPE: 'cloudfront', ...cdn, ...iamRole }, expect: 'error' },
  { rule: 'DEP-041', name: 'DNS_TARGET_TYPE=cloudfront + cdn + tls', env: { ...dns, DNS_TARGET_TYPE: 'cloudfront', ...cdn, ...tlsAcme, ...iamRole }, expect: 'none' },
  { rule: 'ASG-009', name: 'asg + LOG_DRIVER=file', env: { ...asg }, expect: 'warn' },
  { rule: 'ASG-009', name: 'asg + logging(cloudwatch)', env: { ...asg, ...logging, ...iamRole }, expect: 'none' },
  { rule: 'ASG-011', name: 'asg + EMAIL_DRIVER=outbox', env: { ...asg }, expect: 'warn' },
  { rule: 'ASG-011', name: 'asg + email(ses)', env: { ...asg, ...email, ...iamRole }, expect: 'none' },
  { rule: 'CFG-004', name: 'COST_MODE=budgets 却没有 MODULE_COST', env: { ...cost, MODULE_COST: '' }, expect: 'error' },
  { rule: 'CFG-004', name: 'cost(budgets) 声明启用', env: { ...cost }, expect: 'none' },

  // —— SEC ——
  { rule: 'SEC-004', name: 'EXPOSE_PATH_HEADERS=all 且站点是 HTTPS 公网域名', env: { APP_BASE_URL: 'https://album.example.com' }, expect: 'warn' },
  { rule: 'SEC-004', name: 'L0：http://<EIP>', env: { APP_BASE_URL: 'http://203.0.113.10' }, expect: 'none' },
  { rule: 'SEC-004', name: 'EXPOSE_PATH_HEADERS=admin', env: { APP_BASE_URL: 'https://album.example.com', EXPOSE_PATH_HEADERS: 'admin' }, expect: 'none' },
];

describe('rules.ts 表驱动测试', () => {
  it.each(CASES.map((c) => [c.rule, c.name, c] as const))('%s — %s', (_rule, _name, c) => {
    const { parsed, verdict } = evaluate(c.env, { ...(c.phases ? { phases: c.phases } : {}) });
    expect(parsed.errors, JSON.stringify(parsed.errors)).toEqual([]);
    expect(outcomeOf(verdict, c.rule)).toBe(c.expect);
  });

  it('每条 MVP 相关规则都有正反两个用例', () => {
    const byRule = new Map<string, Set<Outcome>>();
    for (const c of CASES) {
      const set = byRule.get(c.rule) ?? new Set<Outcome>();
      set.add(c.expect === 'none' ? 'none' : 'error');
      byRule.set(c.rule, set);
    }
    for (const [rule, outcomes] of byRule) {
      if (rule === 'CFG-005') continue;   // 只验证“不触发”：正例在 load-env 中
      expect(outcomes, rule).toEqual(new Set(['none', 'error']));
    }
  });

  it('规则 ID 唯一，DEP-008 与 ASG-015 不出现（废止 / 作废编号）', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('DEP-008');
    expect(ids).not.toContain('ASG-015');
  });
});

describe('L0 基线与 MVP 组合', () => {
  it('L0（全部默认值）：0 个错误、0 个警告', () => {
    const { parsed, verdict } = evaluate({}, { checkImplemented: true });
    expect(parsed.errors).toEqual([]);
    expect(verdict).toEqual({ errors: [], warnings: [], overridden: [] });
  });

  it('8 个 MVP 模块全部启用（x-named-comparisons 的形态）：没有错误', () => {
    const env = { ...iamRole, ...s3, ...cdn, ...cognito, ...sqs, ...lambdaQueue, ...elasticache, ...rds, CDN_MEDIA_ORIGIN: 's3' };
    const { parsed, verdict } = evaluate(env, { checkImplemented: true, phases: ['startup', 'deploy'] });
    expect(parsed.errors).toEqual([]);
    expect(verdict?.errors).toEqual([]);
    expect(verdict?.warnings.map((w) => w.rule)).toEqual(['DEP-013']);   // Cognito 自己发验证码（对比点）
  });

  it('本地档组合（l0-plus-local-tiers 中已实现的部分）：没有错误', () => {
    const env = { CACHE_DRIVER: 'memory', QUEUE_DRIVER: 'memory', IMAGE_PROCESSOR: 'worker', ...pgLocal };
    const { parsed, verdict } = evaluate(env, { checkImplemented: true });
    expect(parsed.errors).toEqual([]);
    expect(verdict?.errors).toEqual([]);
  });
});

describe('未实现的驱动（CFG-001，退出码 78）', () => {
  it.each([
    ['TRACING_DRIVER', 'local'],
    ['SECRETS_DRIVER', 'secretsmanager'],
    ['DEPLOY_MODE', 'asg'],
    ['SCHEDULER_DRIVER', 'eventbridge'],
    ['SOCIAL_DRIVER', 'dynamodb'],
  ])('%s=%s 被拒绝并给出明确提示', (key, value) => {
    const { parsed } = evaluate({ [key]: value }, { checkImplemented: true });
    expect(parsed.config).toBeUndefined();
    const e = parsed.errors.find((x) => x.section === 'implementation');
    expect(e?.path).toBe(key);
    expect(e?.message).toContain('尚未实现');
  });

  it('TLS_MODE=letsencrypt（tls 本地档，平台预览方案 B 的 IP 证书）已实现', () => {
    const { parsed } = evaluate({ TLS_MODE: 'letsencrypt', TLS_LE_PROFILE: 'shortlived', TLS_PUBLIC_IP: '203.0.113.10', TLS_PREVIEW: 'letsencrypt-ip' }, { checkImplemented: true });
    expect(parsed.errors).toEqual([]);
  });

  it('KMS_KEY_ID（参数型，kms 驱动，未实现）被拒绝', () => {
    const { parsed } = evaluate({ KMS_KEY_ID: 'alias/cloudalbum-lab' }, { checkImplemented: true });
    expect(parsed.errors.map((e) => e.path)).toContain('KMS_KEY_ID');
  });

  it('第 1 波模块的 AWS 驱动不被拒绝（wave1-prep：驱动标记为已实现）', () => {
    const env = { ...iamRole, ...cdn, ...s3, ...cognito, ...notification, ...email, ...monitoring, ...logging, ...identityPool, ...waf,
      ...shellAccess, ...dns, ...tlsAcme, ...cost };
    const { parsed } = evaluate(env, { checkImplemented: true });
    expect(parsed.errors).toEqual([]);
  });

  it('第 1 波模块缺少栈 Outputs 写入的必需键时，报告的是缺键而不是“未实现”', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['NOTIFY_TOPIC_ARN', { MODULE_NOTIFICATION: 'on', NOTIFY_DRIVER: 'sns' }],
      ['SES_IDENTITY', { MODULE_EMAIL: 'on', EMAIL_DRIVER: 'ses' }],
      ['LOG_CW_GROUP_APP', { MODULE_LOGGING: 'on', LOG_DRIVER: 'cloudwatch' }],
      ['IDENTITY_STAGING_BUCKET', { MODULE_IDENTITY_POOL: 'on', IDENTITY_POOL_ID: 'ap-northeast-1:12345678-1234-1234-1234-123456789012' }],
      ['WAF_WEB_ACL_ARN', { MODULE_WAF: 'on', WAF_MODE: 'aws' }],
      ['SSM_SESSION_LOG_GROUP', { MODULE_SHELL_ACCESS: 'on', SHELL_ACCESS_MODE: 'ssm' }],
      ['DNS_HOSTED_ZONE_ID', { MODULE_DNS: 'on', DNS_PROVIDER: 'route53' }],
      ['TLS_ACME_DIRECTORY_URL', { MODULE_TLS: 'on', TLS_MODE: 'acm', TLS_DOMAIN: 'album.example.com', TLS_ACME: 'on' }],
      ['COST_BUDGET_NAMES', { MODULE_COST: 'on', COST_MODE: 'budgets' }],
    ];
    for (const [key, env] of cases) {
      const { parsed } = evaluate({ ...iamRole, ...env }, { checkImplemented: true });
      expect(parsed.errors.map((e) => e.path), key).toContain(key);
      expect(parsed.errors.some((e) => e.section === 'implementation'), key).toBe(false);
    }
  });

  it('STORAGE_DRIVER=efs 归到 shared-fs', () => {
    const { parsed } = evaluate({ STORAGE_DRIVER: 'efs', STORAGE_LOCAL_ROOT: '/mnt/efs/cloudalbum/uploads', EFS_FILE_SYSTEM_ID: 'fs-0abc' }, { checkImplemented: true });
    const e = parsed.errors.find((x) => x.section === 'implementation');
    expect(e?.message).toContain('shared-fs');
  });

  it('MVP 模块的 AWS 驱动不被拒绝', () => {
    const env = { ...iamRole, ...s3, ...cdn, ...cognito, ...sqs, ...lambdaQueue, ...elasticache, ...rds };
    const { parsed } = evaluate(env, { checkImplemented: true });
    expect(parsed.errors).toEqual([]);
  });
});
