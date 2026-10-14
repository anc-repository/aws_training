// backend/src/config/implemented.ts —— 已实现的驱动清单
//
// L0 的全部本地实现 + 8 个 MVP 模块（iam、storage、cdn、auth、queue、image-processing、cache、database）的 AWS 实现
// 及其本地档 + 第 1 波模块（WAVE1_MODULES，docs/implementation-notes.md ## wave1-prep）。其余模块在 registry 中保留元数据，
// 配置了它们的非本地驱动时以 CFG-001（退出码 78）拒绝启动。后续版本实现新驱动时，只需在 IMPLEMENTED_DRIVERS 中追加。
import { MODULE_IDS, type ModuleId } from '@cloudalbum/contracts';
import { REGISTRY, driverOf, localDriverOf, switchOf, type EnvView } from '../modules/registry.js';

export const MVP_MODULES: readonly ModuleId[] = [
  'iam', 'storage', 'cdn', 'auth', 'queue', 'image-processing', 'cache', 'database',
];

/** 第 1 波补齐的模块（registry 条目写完整、驱动标记为已实现；scripts/registry/checks.ts 的完整性检查同样覆盖它们） */
export const WAVE1_MODULES: readonly ModuleId[] = [
  'notification', 'email', 'monitoring', 'cost', 'logging', 'shell-access', 'dns', 'tls', 'waf', 'identity-pool',
];

/** 已实现 AWS 驱动的全部模块（MVP + 第 1 波） */
export const IMPLEMENTED_MODULES: readonly ModuleId[] = [...MVP_MODULES, ...WAVE1_MODULES];

/** 已实现的驱动（未列出的模块 = 只有本地驱动）。 */
export const IMPLEMENTED_DRIVERS: Readonly<Partial<Record<ModuleId, readonly string[]>>> = {
  ec2: ['single'],
  iam: ['none', 'role', 'keys'],
  storage: ['local', 's3'],
  'shared-fs': ['local', 's3'],          // STORAGE_DRIVER 与 storage 共用；efs 未实现
  cdn: ['direct', 'cloudfront'],
  auth: ['local', 'cognito'],
  queue: ['sync', 'memory', 'sqs'],
  'image-processing': ['inline', 'worker', 'lambda'],
  cache: ['none', 'memory', 'redis'],
  database: ['sqlite', 'postgres'],
  // —— 第 1 波（wave1-prep）：应用适配器型
  notification: ['db', 'sns'],
  email: ['outbox', 'ses'],
  monitoring: ['local', 'cloudwatch'],
  logging: ['file', 'cloudwatch'],
  'identity-pool': ['none', 'cognito'],      // 参数型开关 IDENTITY_POOL_ID（空 = none）
  waf: ['nginx', 'aws'],                     // 纯基础设施型，但带管理用小端口 BlocklistPort
  // —— 第 1 波：纯基础设施型 / 声明型开关（应用侧只有感知器；资源由 scripts/module 部署）
  cost: ['local', 'budgets'],
  'shell-access': ['ssh', 'ssm'],
  dns: ['none', 'external', 'route53'],      // external：外部注册商 A 记录（本地档，不涉及 AWS）
  // tls 本地档 letsencrypt：平台预览方案 B 的 Let's Encrypt IP 证书（06 PM-21；证书由 Nginx 使用，应用只读 TLS_* 计算有效入口）；
  // acm：ACME 端点（TLS_ACME=on，证书装到 Nginx）或回退分支（TLS_ACME=off，仅 CloudFront / ALB 的集成证书）
  tls: ['selfsigned', 'letsencrypt', 'acm'],
};

export function implementedDriversOf(id: ModuleId): readonly string[] {
  return IMPLEMENTED_DRIVERS[id] ?? [localDriverOf(id)];
}

export function isDriverImplemented(id: ModuleId, driver: string): boolean {
  return implementedDriversOf(id).includes(driver);
}

/**
 * 已实现驱动中“本轮未实现的子模式 / 变体”：配置了就和未实现的驱动一样以 CFG-001（退出码 78）拒绝，
 * 不能启动成功后才在运行时 404（例如托管登录跳到不存在的 /api/auth/login）。
 */
export const UNIMPLEMENTED_VARIANTS: ReadonlyArray<{ module: ModuleId; driver: string; key: string; value: string; detail: string; fix: string }> = [
  { module: 'auth', driver: 'cognito', key: 'COGNITO_LOGIN_MODE', value: 'managed',
    detail: '托管登录（GET /api/auth/login 与 /api/auth/callback，授权码 + PKCE）', fix: '改用 COGNITO_LOGIN_MODE=sdk（scripts/module enable auth --param LoginMode=sdk）' },
  { module: 'auth', driver: 'cognito', key: 'AUTH_MIGRATION', value: 'lazy',
    detail: '惰性迁移（User Migration 触发器 + /internal/legacy-auth）', fix: '改用默认的 AUTH_MIGRATION=bulk' },
  { module: 'auth', driver: 'cognito', key: 'AUTH_DUAL_STACK', value: 'on',
    detail: '迁移窗口内的本地 + Cognito 双栈认证', fix: '删除该键（默认 off）' },
];

/** 返回“配置了未实现驱动”的错误（每个开关变量最多一条），以及已实现驱动中未实现的子模式（UNIMPLEMENTED_VARIANTS）。 */
export function implementationErrors(env: EnvView): Array<{ section: string; path: string; message: string }> {
  const errors: Array<{ section: string; path: string; message: string }> = [];
  const seenVars = new Set<string>();
  for (const id of MODULE_IDS) {
    if (id === 'ec2') continue;
    const sw = switchOf(id);
    if (!sw || seenVars.has(sw.var)) continue;
    const driver = driverOf(env, id);
    if (isDriverImplemented(id, driver)) continue;
    // STORAGE_DRIVER 由 storage 与 shared-fs 共用：把错误归到拥有该取值的模块
    const owner = MODULE_IDS.find((m) => {
      const s = switchOf(m);
      return s && s.var === sw.var && !('kind' in s && s.kind === 'param') && 'ownedValues' in s && s.ownedValues.includes(driver);
    }) ?? id;
    seenVars.add(sw.var);
    const value = env[sw.var] ?? '';
    const allowed = implementedDriversOf(owner).join(' | ');
    errors.push({
      section: 'implementation',
      path: sw.var,
      message:
        `${sw.var}=${value}：${owner}（${REGISTRY[owner].awsService}）的“${driver}”驱动在本轮尚未实现，` +
        `只能使用 ${allowed}。请改回本地实现：scripts/module disable ${owner}（或删除 modules.d/${owner}.env 中的该键）`,
    });
  }
  for (const v of UNIMPLEMENTED_VARIANTS) {
    if (driverOf(env, v.module) !== v.driver || (env[v.key] ?? '') !== v.value) continue;
    errors.push({
      section: 'implementation',
      path: v.key,
      message: `${v.key}=${v.value}：${v.module} 的${v.detail}在本轮尚未实现。${v.fix}`,
    });
  }
  return errors;
}
