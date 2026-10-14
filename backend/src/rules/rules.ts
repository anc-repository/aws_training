// backend/src/rules/rules.ts —— 全项目唯一的规则表（总纲 §5.2 全表照录；不存在 deps.ts）
//
// - DEP / MUTEX 规则的条件由 registry 的 requires / conflicts 表达式给出（fromRegistry: true）；本表只写 ID、级别、
//   可覆盖性、范围、消息与修复命令。need: [] 的条目由这里的 check() / deployCheck() 给出条件。
// - CFG、CRED、ASG、SEC 类规则不属于模块间依赖，条件直接写在 check() 中。
// - 部署范围（deploy）的规则只由 scripts/module 检查（涉及云端资源状态）；进程启动只运行 startup 范围。
// - DEP-008 废止（由 DEP-022～025 取代），ASG-015 作废、不复用：两者都不出现在本表。
import { MODULE_IDS, moduleVersionKey, type ModuleId } from '@cloudalbum/contracts';
import { isLoopback } from '../config/net.js';
import {
  REGISTRY, driverOf, isOwnedValue, isSelfHosted, moduleFlagKey, registryVersion, switchOf,
} from '../modules/registry.js';
import type { Rule, RuleContext, RuleHit } from './engine.js';
import { validatePlatformEnv } from '../platform/env-schema.js';
import { atlKeys, readLocalProbeSecret } from '../platform/mode.js';

const list = (ids: readonly string[]) => ids.join('、');
const asgOnly = { asgOnly: true } as const;
const env = (ctx: RuleContext, key: string) => ctx.env[key] ?? '';

/** 模块的凭证前置分类（registry credentials） */
function withCredentials(ctx: RuleContext, kind: 'required' | 'optional'): ModuleId[] {
  return ctx.enabled().filter((m) => ctx.registry[m].credentials === kind);
}

/** CRED-003 的例外清单：registry stacks[].region 声明了其他区域的模块，以及 cdn（全局分配）、cost（全局类资源） */
function regionExceptions(): Set<ModuleId> {
  const out = new Set<ModuleId>(['cdn', 'cost']);
  for (const id of MODULE_IDS) if ((REGISTRY[id].stacks ?? []).some((s) => s.region)) out.add(id);
  return out;
}

export const RULES: Rule[] = [
  // ===========================================================================================
  // 配置结构（CFG）
  // ===========================================================================================
  {
    id: 'CFG-001', category: 'CFG', severity: 'error', overridable: false, scope: 'startup', modules: [],
    // 开关取值不在 values 中 / 缺少驱动必需变量（zod 失败）与“未实现的驱动”由 parseConfig 报告（engine.parseErrorsToFindings）；
    // 这里只检查 CLOUDALBUM_ALLOW_UNSAFE 中出现不可覆盖的规则。
    check: (ctx) => {
      const ids = ctx.cfg.core.CLOUDALBUM_ALLOW_UNSAFE;
      const bad = ids.filter((id) => !RULES.some((r) => r.id === id && r.overridable && !r.abolished));
      return bad.length ? { message: `CLOUDALBUM_ALLOW_UNSAFE 中出现不可覆盖或不存在的规则：${list(bad)}` } : false;
    },
    message: () => '配置结构错误',
    fix: '重新执行 scripts/module enable <id> 生成完整 env；CLOUDALBUM_ALLOW_UNSAFE 只能列出“可覆盖”的规则（ASG-001/004/005/006/007/008）',
  },
  {
    id: 'CFG-002', category: 'CFG', severity: 'error', overridable: false, scope: 'startup', modules: [],
    check: (ctx) => ctx.layers.issues.filter((i) => i.code === 'CFG-002').map((i): RuleHit => ({
      message: i.message, ...(i.module && isModuleIdSafe(i.module) ? { modules: [i.module] } : {}),
    })),
    message: () => 'env 文件中出现不属于该模块的键，或出现机密类键',
    fix: '模块不得改写别的模块的配置；机密值只能在 secrets.env 与 keys/*.pem，modules.d 只写 *_SECRET_ARN 或逻辑名',
  },
  {
    id: 'CFG-003', category: 'CFG', severity: 'error', overridable: false, scope: 'startup', modules: [],
    check: (ctx) => ctx.layers.issues.filter((i) => i.code === 'CFG-003').map((i): RuleHit => ({ message: i.message })),
    message: () => '同一个键在两个模块 env 文件中定义',
    fix: '删除其中一处；通常是模块文档设计冲突',
  },
  {
    id: 'CFG-004', category: 'CFG', severity: 'error', overridable: false, scope: 'startup', modules: [],
    check: (ctx) => {
      const hits: RuleHit[] = [];
      for (const id of MODULE_IDS) {
        const sw = switchOf(id);
        if (!sw) continue;
        const flag = ctx.flagOn(id);
        const owned = isOwnedValue(ctx.env, id);
        const value = env(ctx, sw.var);
        if (flag && !owned) {
          hits.push({ modules: [id], message: `${moduleFlagKey(id)}=on，但 ${sw.var}=${value || '(空)'} 仍是本地值` });
        } else if (!flag && owned && !isSelfHosted(ctx.env, id)) {
          hits.push({ modules: [id], message: `${sw.var}=${value} 是 ${id} 的 AWS 取值，但缺少 ${moduleFlagKey(id)}=on` });
        }
      }
      return hits;
    },
    message: () => '模块半启用（MODULE_<ID> 与开关取值不一致）',
    fix: 'scripts/module status <id> --repair',
  },
  {
    id: 'CFG-005', category: 'CFG', severity: 'warn', overridable: false, scope: 'startup', modules: [],
    check: (ctx) => ctx.layers.localOverride,
    message: () => '存在 local.override.env（临时实验文件），/lab 顶部常驻提示',
    fix: '实验结束后删除 /etc/cloudalbum/local.override.env',
  },
  {
    id: 'CFG-006', category: 'CFG', severity: 'warn', overridable: false, scope: 'startup', modules: [],
    check: (ctx) => MODULE_IDS.filter((id) => {
      const v = ctx.env[moduleVersionKey(id)];
      return v !== undefined && v !== '' && Number(v) !== registryVersion(id);
    }).map((id): RuleHit => ({
      modules: [id],
      message: `${moduleVersionKey(id)}=${ctx.env[moduleVersionKey(id)]}，注册表版本为 ${registryVersion(id)}`,
    })),
    message: () => 'env 中的模块版本与注册表版本不一致（模板已升级但栈未重新部署）',
    fix: 'scripts/module enable <id>（重新部署栈）',
  },
  {
    id: 'CFG-007', category: 'CFG', severity: 'error', overridable: false, scope: 'startup', modules: ['kms'],
    enforcedBy: 'container.checkKeyFingerprint（需要数据库 system_meta）',
    message: () => 'LOCAL_MASTER_KEY 的指纹与数据库 system_meta 中记录的不一致：已加密字段将无法解密',
    fix: '从数据卷 / 备份恢复 etc/secrets.env，不要删除指纹记录',
  },
  {
    id: 'CFG-008', category: 'CFG', severity: 'warn', overridable: false, scope: 'startup', modules: ['ec2'],
    check: (ctx) => ctx.layers.exists && ctx.layers.envDir === '/etc/cloudalbum' && !ctx.layers.isSymlink,
    message: () => '/etc/cloudalbum 不是指向数据卷 etc/ 的符号链接（机密与本地配置在根卷上，换实例或迁移时密钥会丢失）',
    fix: '重新执行 l0-bootstrap.sh postattach',
  },
  {
    id: 'CFG-009', category: 'CFG', severity: 'warn', overridable: false, scope: 'runtime', modules: ['config'],
    enforcedBy: 'ConfigPort（file / ssm 驱动加载运行时配置时报告）',
    message: () => '运行时配置源中出现 RuntimeConfig 之外的键（例如 *_DRIVER），已忽略',
    fix: 'ConfigPort 只管运行时热键，模块开关只能由 scripts/module 修改（D7）',
  },
  {
    id: 'CFG-010', category: 'CFG', severity: 'warn', overridable: false, scope: 'startup', modules: ['cost'],
    check: (ctx) => {
      const cr = ctx.layers.costRates;
      if (!cr) return false;
      if (cr.parseError) return { message: `cost-rates.yaml 解析失败：${cr.parseError}` };
      const known = new Set(MODULE_IDS.flatMap((id) => (REGISTRY[id].billing ?? []).map((b) => b.resource)));
      const bad = cr.entries.filter((e) => !e.source || !e.retrievedAt || !known.has(String(e.resource ?? '')));
      return bad.length ? { message: `${bad.length} 个条目缺少 source / retrievedAt，或 resource 与 registry billing.resource 对不上` } : false;
    },
    message: () => 'cost-rates.yaml 中有未注明出处的单价，这些条目不参与金额估算',
    fix: '为每个条目填写 source（官方定价页 URL）与 retrievedAt（抄录日期）',
  },

  // ===========================================================================================
  // 凭证（CRED）
  // ===========================================================================================
  {
    id: 'CRED-001', category: 'CRED', severity: 'error', overridable: false, scope: 'startup', modules: ['iam'],
    check: (ctx) => {
      if (ctx.cfg.core.IAM_CREDENTIALS !== 'none') return false;
      const req = withCredentials(ctx, 'required');
      return req.length ? { modules: ['iam', ...req], message: list(req) } : false;
    },
    message: () => '以下模块需要调用 AWS API，但 IAM_CREDENTIALS=none',
    fix: 'scripts/module enable iam          # 推荐 role；--mode keys 只作反面教材（CRED-002）',
  },
  {
    id: 'CRED-002', category: 'CRED', severity: 'warn', overridable: false, scope: 'startup', modules: ['iam'],
    check: (ctx) => {
      if (ctx.cfg.core.IAM_CREDENTIALS !== 'keys') return false;
      // 05 组约定 2：Agent 不读 secrets.env 的 IAM_KEYS_*，本项目也不为它另写凭证文件 → 依赖 Agent 的子功能关闭（wave1-prep）
      const agent: string[] = [];
      if (ctx.isEnabled('logging') && env(ctx, 'LOG_CW_SHIPPER') === 'agent') agent.push('logging 的 agent 投递方式');
      if (ctx.isEnabled('monitoring')) agent.push(`monitoring 的内存 / 磁盘指标${env(ctx, 'METRICS_CW_MODE') === 'emf' ? '与 EMF 方式' : ''}`);
      if (ctx.isEnabled('tracing')) agent.push('tracing 的 xray 档（本机 Collector）');
      return agent.length ? { message: `依赖 Agent 的子功能不可用：${list(agent)}` } : true;
    },
    message: () => 'IAM_CREDENTIALS=keys：长期访问密钥（AKIA…）落盘在 secrets.env；SSM Agent、CloudWatch Agent 不读取这份密钥',
    fix: 'scripts/module enable iam --mode role',
  },
  {
    id: 'CRED-003', category: 'CRED', severity: 'error', overridable: false, scope: 'startup', modules: [],
    check: (ctx) => {
      const exceptions = regionExceptions();
      const region = ctx.cfg.core.AWS_REGION;
      const hits: RuleHit[] = [];
      for (const layer of ctx.layers.layers) {
        if (layer.kind !== 'module' || !layer.module || exceptions.has(layer.module)) continue;
        for (const [k, v] of Object.entries(layer.values)) {
          const m = /^arn:aws[a-z-]*:[a-z0-9-]+:([a-z0-9-]*):/.exec(v);
          if (m && m[1] && m[1] !== region) hits.push({ modules: [layer.module], message: `${k} 的区域为 ${m[1]}，AWS_REGION=${region}` });
        }
      }
      return hits;
    },
    message: () => '模块 env 中资源 ARN 的区域与 AWS_REGION 不同（栈部署到了错误区域）',
    fix: '在 AWS_REGION 重新部署该模块栈（例外：tls-edge、waf-edge、cdn、cost 的全局类资源）',
  },
  {
    id: 'CRED-004', category: 'CRED', severity: 'warn', overridable: false, scope: 'startup', modules: ['iam'],
    check: (ctx) => {
      if (ctx.cfg.core.IAM_CREDENTIALS !== 'none') return false;
      const opt = withCredentials(ctx, 'optional');
      return opt.length ? { modules: opt, message: list(opt) } : false;
    },
    message: () => 'credentials: optional 的模块已启用但 IAM_CREDENTIALS=none：控制面感知降为 observed / inferred，失效按钮等子功能关闭',
    fix: 'scripts/module enable iam',
  },

  // ===========================================================================================
  // 硬依赖（DEP）—— 条件见 registry requires
  // ===========================================================================================
  {
    id: 'DEP-001', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['shell-access', 'iam'], fromRegistry: true,
    message: () => 'SHELL_ACCESS_MODE=ssm 需要 IAM_CREDENTIALS=role：Session Manager 需要实例角色（SSM Agent 不使用应用的访问密钥）',
    fix: 'scripts/module enable iam --mode role',
  },
  {
    id: 'DEP-002', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['identity-pool', 'storage', 'auth'], fromRegistry: true,
    message: () => 'identity-pool 需要 STORAGE_DRIVER=s3，且 AUTH_DRIVER=cognito 或配置了开发者认证身份（IDENTITY_DEV_PROVIDER）',
    fix: 'scripts/module enable storage && scripts/module enable auth',
  },
  {
    id: 'DEP-003', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['image-processing', 'storage'], fromRegistry: true,
    message: () => 'IMAGE_PROCESSOR=lambda 需要 STORAGE_DRIVER=s3：Lambda 读不到 EC2 本地盘或 EFS',
    fix: 'scripts/module enable storage      # 或改回 IMAGE_PROCESSOR=inline / worker',
  },
  {
    id: 'DEP-004', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['image-processing', 'queue'], fromRegistry: true,
    message: () => 'IMAGE_PROCESSOR=worker 与 QUEUE_DRIVER=sync 自相矛盾：sync 队列会把 worker 档退化成 inline（静默降级）',
    fix: 'scripts/module enable queue --driver memory   # 或 scripts/module enable queue（sqs）',
  },
  {
    id: 'DEP-005', category: 'DEP', severity: 'error', overridable: false, scope: ['startup', 'deploy'], modules: ['tls'], fromRegistry: true,
    message: () => 'TLS_MODE=acm 需要 TLS_DOMAIN；TLS_ACME=off（ACME 端点不可用或选择考试形态）时，ACM 证书只能由 CloudFront / ALB 使用',
    fix: 'scripts/module enable tls --domain album.example.com   # TLS_ACME=off 时先启用 cdn 或 load-balancer，并启用 dns 或配置外部 DNS',
  },
  {
    id: 'DEP-006', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['waf'], fromRegistry: true,
    message: () => 'WAF_MODE=aws 需要 cdn 或 load-balancer：WAF 只能关联到 CloudFront、ALB 等资源，不能关联 EC2 / EIP',
    fix: 'scripts/module enable cdn          # 或 scripts/module enable load-balancer',
  },
  {
    id: 'DEP-007', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['autoscaling', 'iam', 'load-balancer'], fromRegistry: true,
    message: () => 'DEPLOY_MODE=asg 需要 IAM_CREDENTIALS=role 与 load-balancer：实例启动时要用实例角色拉取引导配置包，流量经 ALB 分发',
    fix: 'scripts/module enable load-balancer && scripts/module enable iam --mode role',
  },
  {
    id: 'DEP-009', category: 'DEP', severity: 'error', overridable: false, scope: 'deploy', modules: ['network'], fromRegistry: true,
    message: () => 'NETWORK_PLACEMENT=private 缺少入口、出网路径或运维通道之一（私有子网的实例没有公网入口，引导期出不了网时 cfn-signal 超时）',
    fix: 'scripts/module enable load-balancer；NatMode≠none 或 Interface Endpoint（含 cloudformation）+ 工具链栈；shell-access 或 EIC Endpoint',
  },
  {
    id: 'DEP-010', category: 'DEP', severity: 'error', overridable: false, scope: 'deploy', modules: ['cdn', 'storage'], fromRegistry: true,
    message: () => 'CDN_MEDIA_ORIGIN=s3 需要 STORAGE_DRIVER=s3',
    fix: 'scripts/module enable storage      # 否则 CDN_MEDIA_ORIGIN=ec2',
  },
  {
    id: 'DEP-011', category: 'DEP', severity: 'warn', overridable: false, scope: 'startup', modules: ['load-balancer', 'auth', 'tls'], fromRegistry: true,
    message: () => 'load-balancer 已启用，但 AUTH_DRIVER≠cognito 或 ALB 没有 HTTPS 监听器：F12 的 ALB authenticate-cognito 子功能关闭（应用层 RBAC 照常）',
    fix: 'scripts/module enable auth && scripts/module enable tls',
  },
  {
    id: 'DEP-012', category: 'DEP', severity: 'warn', overridable: false, scope: 'startup', modules: ['auth', 'database'],
    // 总纲修订记录（第 3 轮）：Post Confirmation 触发器还没有对应的开关变量与 registry 引用（待 02 组定名），
    // 因此本规则暂无可求值的条件；registry:check 对它做了显式豁免。
    check: () => false,
    message: () => 'auth 的 Post Confirmation 触发器开关打开，但 database 未启用：触发器不部署，F2 退回 JIT 建档',
    fix: 'scripts/module enable database',
  },
  {
    id: 'DEP-013', category: 'DEP', severity: 'warn', overridable: false, scope: 'startup', modules: ['auth', 'email'], fromRegistry: true,
    message: () => 'AUTH_DRIVER=cognito 且 EMAIL_DRIVER=outbox：Cognito 自己发送验证码邮件，不经过 EmailPort，outbox 里看不到验证码（这本身就是对比点）',
    fix: 'scripts/module enable email（可选）',
  },
  {
    id: 'DEP-014', category: 'DEP', severity: 'error', overridable: false, scope: 'deploy', modules: ['cdn', 'ec2'], fromRegistry: true,
    deployCheck: async () => false,   // scripts/module 实现：基础栈 AssociateEip=true 且实例有公网 DNS 名
    message: () => 'CDN_ORIGIN_TYPE=ec2，但实例没有关联 EIP：源站只能填域名，没有 EIP 时实例停止再启动后公网 DNS 会变',
    fix: 'scripts/module base set AssociateEip=true',
  },
  {
    id: 'DEP-015', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['tls'], fromRegistry: true,
    message: () => 'TLS_FORCE_HTTPS=true，但直连监听器使用自签名证书：自签名 + HSTS 会把用户锁在站外',
    fix: 'scripts/module enable tls --driver letsencrypt   # 或 TLS_FORCE_HTTPS=false',
  },
  {
    id: 'DEP-016', category: 'DEP', severity: 'error', overridable: false, scope: 'deploy', modules: ['network'], fromRegistry: true,
    deployCheck: async () => false,   // scripts/module 实现：VpcId 变化且仍有已部署的 VPC 绑定模块
    message: () => 'network 的启用 / 禁用会改变 VpcId，而仍有已部署的 VPC 绑定模块（load-balancer、database、db-proxy、cache、shared-fs、autoscaling、VPC 内 Lambda）',
    fix: '加 --cascade 先禁用它们、迁移后再启用',
  },
  {
    id: 'DEP-017', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['load-balancer', 'auth'], fromRegistry: true,
    message: () => 'LB_ADMIN_AUTH=cognito，但 AUTH_DRIVER≠cognito 或 ALB 没有 HTTPS 监听器',
    fix: 'scripts/module enable auth && scripts/module enable tls   # 或改回 LB_ADMIN_AUTH=app',
  },
  {
    id: 'DEP-018', category: 'DEP', severity: 'warn', overridable: false, scope: 'runtime', modules: ['waf'], fromRegistry: true,
    check: (ctx) => {
      if (env(ctx, 'WAF_MODE') !== 'aws') return false;
      const scope = env(ctx, 'WAF_SCOPE') || 'CLOUDFRONT';
      if (scope === 'CLOUDFRONT') return env(ctx, 'CDN_DIRECT_ACCESS') === 'open';
      return env(ctx, 'LB_LOCK_ORIGIN') !== 'on';
    },
    message: () => 'WAF_MODE=aws，但对应入口没有锁定：攻击者可以直连 EC2 绕过 WAF（waf 为 degraded）',
    fix: 'CDN_DIRECT_ACCESS=admin-ip|closed（CLOUDFRONT 范围）或 LB_LOCK_ORIGIN=on（REGIONAL 范围）',
  },
  {
    id: 'DEP-019', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['image-processing', 'load-balancer'], fromRegistry: true,
    message: () => 'IMAGE_PROCESSOR=lambda、IMAGE_RESULT_CHANNEL=callback、DEPLOY_MODE=asg 时回调地址必须是负载均衡地址（否则回调会打到某一台实例）',
    fix: 'scripts/module enable load-balancer   # 或改用 IMAGE_RESULT_CHANNEL=queue',
  },
  {
    id: 'DEP-020', category: 'DEP', severity: 'warn', overridable: false, scope: 'startup', modules: ['image-processing', 'cdn'], fromRegistry: true,
    message: () => 'IMAGE_RESULT_CHANNEL=callback 且 cdn 已启用：cdn 的源站校验会挡住回调',
    fix: 'scripts/module enable image-processing --param ResultChannel=queue',
  },
  {
    id: 'DEP-021', category: 'DEP', severity: 'warn', overridable: false, scope: 'startup', modules: ['image-processing'], fromRegistry: true,
    check: (ctx) => env(ctx, 'IMAGE_PROCESSOR') === 'lambda' && env(ctx, 'IMAGE_RESULT_CHANNEL') === 'callback'
      && env(ctx, 'IMAGE_CALLBACK_URL').startsWith('http://'),
    message: () => 'IMAGE_CALLBACK_URL 以 http:// 开头：回调走明文，HMAC 能防伪造、防篡改，不能防窃听（载荷只含对象键和宽高）',
    fix: '启用 tls 后改用 https 回调地址，或改用 IMAGE_RESULT_CHANNEL=queue',
  },
  {
    id: 'DEP-022', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['social-api', 'social-store'], fromRegistry: true,
    message: () => 'social-api 集成档为 lambda，但 SOCIAL_DRIVER≠dynamodb：Lambda 访问不到 EC2 上的 SQLite',
    fix: 'scripts/module enable social-store',
  },
  {
    id: 'DEP-023', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['social-api', 'auth'], fromRegistry: true,
    message: () => 'social-api 授权器为 jwt，但 AUTH_DRIVER≠cognito：HTTP API 的 JWT 授权器只支持 RSA 系列算法，本地令牌是 ES256',
    fix: '改用 SOCIAL_API_AUTHORIZER=lambda，或 scripts/module enable auth',
  },
  {
    id: 'DEP-024', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['social-api'], fromRegistry: true,
    message: () => 'social-api 集成档为 lambda，但授权器为 none：Lambda 后端拿不到“当前用户是谁”',
    fix: 'SOCIAL_API_AUTHORIZER=lambda（auth=local）或 jwt（auth=cognito）',
  },
  {
    id: 'DEP-025', category: 'DEP', severity: 'warn', overridable: false, scope: 'startup', modules: ['social-api', 'notification', 'queue'], fromRegistry: true,
    message: () => 'social-api 集成档为 lambda，且 NOTIFY_DRIVER≠sns、QUEUE_DRIVER≠sqs：经 Lambda 写入的评论不产生通知（notification 为 degraded）',
    fix: 'scripts/module enable notification   # 或 scripts/module enable queue',
  },
  {
    id: 'DEP-026', category: 'DEP', severity: 'error', overridable: false, scope: 'deploy', modules: ['scheduler', 'iam'], fromRegistry: true,
    message: () => 'SCHEDULER_TARGET=ssm，但实例不是 SSM 托管节点',
    fix: 'scripts/module enable shell-access（IAM_CREDENTIALS=role 且角色带托管节点权限）',
  },
  {
    id: 'DEP-027', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['tagging', 'storage'], fromRegistry: true,
    message: () => 'TAGGER_INPUT=s3 需要 STORAGE_DRIVER=s3（字节方式 bytes / auto 不需要 S3）',
    fix: 'scripts/module enable storage      # 或 TAGGER_INPUT=auto',
  },
  {
    id: 'DEP-028', category: 'DEP', severity: 'warn', overridable: false, scope: 'startup', modules: ['cdn', 'storage'], fromRegistry: true,
    message: () => 'CDN_MEDIA_ORIGIN=ec2 而 STORAGE_DRIVER=s3：CloudFront 会缓存 /media 返回的、指向会过期预签名 URL 的 302（cdn 为 degraded）',
    fix: 'scripts/module enable cdn --param MediaOrigin=s3',
  },
  {
    id: 'DEP-029', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['auth', 'cdn', 'tls'], fromRegistry: true,
    message: () => 'COGNITO_LOGIN_MODE=managed 需要受信 HTTPS（托管登录的回调地址）',
    fix: 'scripts/module enable cdn（默认证书）或 scripts/module enable tls',
  },
  {
    id: 'DEP-030', category: 'DEP', severity: 'warn', overridable: false, scope: 'startup', modules: ['identity-pool', 'tls', 'cdn'], fromRegistry: true,
    check: (ctx) => ctx.isEnabled('identity-pool') && env(ctx, 'APP_BASE_URL').startsWith('http://'),
    message: () => 'identity-pool 已启用而 APP_BASE_URL 是 http://：STS 临时凭证会经明文下发（identity-pool 为 degraded）',
    fix: 'scripts/module enable tls          # 或 scripts/module enable cdn',
  },
  {
    id: 'DEP-031', category: 'DEP', severity: 'error', overridable: false, scope: ['startup', 'deploy'], modules: ['auth'], fromRegistry: true,
    message: () => 'AUTH_MIGRATION=lazy 需要 COGNITO_TRIGGERS=on、registry 声明的 /internal/legacy-auth 与 VPC 内的迁移 Lambda',
    fix: 'scripts/module enable auth --migration lazy   # 默认 bulk 不需要 Lambda（D8）',
  },
  {
    id: 'DEP-032', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['db-proxy', 'database', 'secrets'], fromRegistry: true,
    message: () => 'DB_PROXY_MODE=rds-proxy 需要 database（RDS）；默认 DB_PROXY_AUTH=secrets 还需要 SECRETS_DRIVER=secretsmanager',
    fix: 'scripts/module enable database && scripts/module enable secrets   # 或 DB_PROXY_AUTH=iam（DEP-036）',
  },
  {
    id: 'DEP-033', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['db-proxy', 'database'], fromRegistry: true,
    message: () => 'DB_PROXY_MODE≠none 需要 DB_DRIVER=postgres：连接池代理只对 PostgreSQL 有意义',
    fix: 'scripts/module enable database --self-hosted   # 或 DB_PROXY_MODE=none',
  },
  {
    id: 'DEP-034', category: 'DEP', severity: 'error', overridable: false, scope: ['startup', 'deploy'], modules: ['workflow', 'storage'], fromRegistry: true,
    message: () => 'WORKFLOW_DRIVER=stepfunctions 需要 STORAGE_DRIVER=s3 与工具链栈：状态机由 S3 → EventBridge 启动',
    fix: 'scripts/module bootstrap && scripts/module enable storage',
  },
  {
    id: 'DEP-035', category: 'DEP', severity: 'error', overridable: false, scope: 'deploy', modules: ['vuln-scan', 'iam'], fromRegistry: true,
    message: () => 'VULN_SCAN_MODE=inspector 需要 IAM_CREDENTIALS=role：Inspector 的 EC2 扫描依赖 SSM 托管节点',
    fix: 'scripts/module enable iam --mode role',
  },
  {
    id: 'DEP-036', category: 'DEP', severity: 'error', overridable: false, scope: ['startup', 'deploy'], modules: ['db-proxy', 'database'], fromRegistry: true,
    message: () => 'DB_PROXY_MODE=rds-proxy 且 DB_PROXY_AUTH=iam 需要 database（RDS 开启 IAM 数据库认证、应用用户授予 rds_iam）',
    fix: 'scripts/module enable database',
  },
  {
    id: 'DEP-037', category: 'DEP', severity: 'error', overridable: false, scope: 'deploy', modules: ['ami'], fromRegistry: true,
    deployCheck: async () => false,   // scripts/module 实现：每个所需架构都有 AVAILABLE 的已晋升黄金 AMI
    message: () => 'AMI_SOURCE=golden，但某个所需架构没有已晋升的黄金 AMI',
    fix: 'scripts/module ami build --arch <arch> && scripts/module ami promote',
  },
  {
    id: 'DEP-038', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['cdn', 'load-balancer'], fromRegistry: true,
    message: () => 'CDN_ORIGIN_TYPE=alb 需要 load-balancer',
    fix: 'scripts/module enable load-balancer   # 或 CDN_ORIGIN_TYPE=ec2',
  },
  {
    id: 'DEP-039', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['cdn', 'network'], fromRegistry: true,
    message: () => 'CDN_ORIGIN_TYPE=vpc-origin 需要 NETWORK_PLACEMENT=private',
    fix: 'scripts/module enable network --driver private',
  },
  {
    id: 'DEP-040', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['dns', 'load-balancer'], fromRegistry: true,
    message: () => 'DNS_TARGET_TYPE=alb 需要 load-balancer（Alias 目标不存在）',
    fix: 'scripts/module enable load-balancer   # 或 DNS_TARGET_TYPE=eip',
  },
  {
    id: 'DEP-041', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['dns', 'cdn', 'tls'], fromRegistry: true,
    message: () => 'DNS_TARGET_TYPE=cloudfront 需要 cdn 与 tls（备用域名需要 us-east-1 的 ACM 证书）',
    fix: 'scripts/module enable cdn && scripts/module enable tls',
  },
  {
    id: 'DEP-042', category: 'DEP', severity: 'error', overridable: false, scope: 'startup', modules: ['load-balancer', 'cdn'], fromRegistry: true,
    message: () => 'LB_ORIGIN_VERIFY=on 需要 CDN_ORIGIN_TYPE=alb（否则全部请求被挡成 403）',
    fix: 'scripts/module enable cdn --param OriginType=alb   # 或 LB_ORIGIN_VERIFY=off',
  },

  // ===========================================================================================
  // 互斥（MUTEX）
  // ===========================================================================================
  {
    id: 'MUTEX-001', category: 'MUTEX', severity: 'error', overridable: false, scope: 'startup', modules: ['storage', 'shared-fs'], fromRegistry: true,
    message: () => 'storage 与 shared-fs 同时启用：STORAGE_DRIVER 只能有一个值',
    fix: '先 scripts/module disable <其中一个>（含数据迁回）',
  },
  {
    id: 'MUTEX-002', category: 'MUTEX', severity: 'error', overridable: false, scope: 'startup', modules: ['database'], fromRegistry: true,
    check: (ctx) => ctx.flagOn('database') && (env(ctx, 'DB_DRIVER') !== 'postgres' || isLoopback(env(ctx, 'DB_HOST'))),
    message: () => 'database 已启用（RDS），但 DB_DRIVER=sqlite 或 DB_HOST 不是 RDS 端点：自建 PostgreSQL（本地档）与 RDS 二选一',
    fix: 'scripts/module status database --repair',
  },
  {
    id: 'MUTEX-003', category: 'MUTEX', severity: 'error', overridable: false, scope: 'startup', modules: ['cache'], fromRegistry: true,
    check: (ctx) => ctx.flagOn('cache') && env(ctx, 'CACHE_DRIVER') === 'redis' && isLoopback(env(ctx, 'REDIS_URL')),
    message: () => 'cache 已启用（ElastiCache），但 REDIS_URL 指向本机：自建 Valkey（本地档）与 ElastiCache 二选一',
    fix: 'scripts/module status cache --repair',
  },
  {
    id: 'MUTEX-004', category: 'MUTEX', severity: 'error', overridable: false, scope: 'deploy', modules: ['storage'], fromRegistry: true,
    deployCheck: async () => false,   // scripts/module 实现：检查原图桶 / 媒体桶模板的 NotificationConfiguration
    message: () => '原图桶或媒体桶的 NotificationConfiguration 中出现 EventBridgeConfiguration 以外的配置',
    fix: '所有 S3 事件消费者必须在自己的栈里建 EventBridge 规则（3.2 决定 1）',
  },
  {
    id: 'MUTEX-005', category: 'MUTEX', severity: 'error', overridable: false, scope: 'startup', modules: ['workflow', 'image-processing'], fromRegistry: true,
    message: () => 'WORKFLOW_DRIVER=stepfunctions 与 IMAGE_PROCESSOR=lambda 互斥：二者消费同一个 S3 事件，会重复处理',
    fix: 'scripts/module disable image-processing   # 或 disable workflow',
  },
  {
    id: 'MUTEX-006', category: 'MUTEX', severity: 'error', overridable: false, scope: 'startup', modules: ['db-proxy'], fromRegistry: true,
    message: () => 'db-proxy 已启用（RDS Proxy），但 DB_PROXY_ENDPOINT 是回环地址（本机 PgBouncer）：二者二选一',
    fix: 'scripts/module status db-proxy --repair',
  },

  // ===========================================================================================
  // 多实例安全（ASG，仅 DEPLOY_MODE=asg）
  // ===========================================================================================
  {
    id: 'ASG-001', category: 'ASG', severity: 'error', overridable: true, scope: 'startup', modules: ['storage', 'autoscaling'], ...asgOnly,
    check: (ctx) => env(ctx, 'STORAGE_DRIVER') === 'local' || env(ctx, 'STORAGE_DRIVER') === '',
    message: () => 'DEPLOY_MODE=asg 时 STORAGE_DRIVER=local：照片只存在于上传时命中的那台实例，其他实例返回 404',
    fix: 'scripts/module enable storage      # 或 shared-fs',
  },
  {
    id: 'ASG-002', category: 'ASG', severity: 'error', overridable: false, scope: 'startup', modules: ['database', 'autoscaling'], ...asgOnly,
    check: (ctx) => env(ctx, 'DB_DRIVER') !== 'postgres',
    message: () => 'DEPLOY_MODE=asg 时不能使用 DB_DRIVER=sqlite：每台实例各有一个 SQLite 文件，数据会分叉',
    fix: 'scripts/module enable database',
  },
  {
    id: 'ASG-003', category: 'ASG', severity: 'error', overridable: false, scope: 'startup', modules: ['database', 'autoscaling'], ...asgOnly,
    check: (ctx) => env(ctx, 'DB_DRIVER') === 'postgres' && isLoopback(env(ctx, 'DB_HOST')),
    message: () => 'DEPLOY_MODE=asg 时 DB_HOST 是回环地址：自建库在某台被伸缩的实例上，数据会分叉',
    fix: 'scripts/module enable database（RDS）',
  },
  {
    id: 'ASG-004', category: 'ASG', severity: 'error', overridable: true, scope: 'startup', modules: ['cache', 'autoscaling'],
    check: (ctx) => {
      const driver = env(ctx, 'CACHE_DRIVER');
      if (env(ctx, 'DEPLOY_MODE') === 'asg') {
        return driver === 'memory' || (driver === 'redis' && isLoopback(env(ctx, 'REDIS_URL')));   // 回环 = 每台实例各自的自建 Valkey
      }
      // 单机多进程（LB_LOCAL_WORKERS=2）时 memory 分支以 warn 级别同样检查；回环 Valkey 被两个进程共享，不触发
      if (Number(env(ctx, 'LB_LOCAL_WORKERS') || 1) >= 2 && driver === 'memory') {
        return { severity: 'warn', message: 'LB_LOCAL_WORKERS=2：两个 api 进程的 memory 缓存各自为政' };
      }
      return false;
    },
    message: () => '多实例时进程内缓存各自为政：实例 A 更新数据后，实例 B 仍返回旧时间线',
    fix: 'scripts/module enable cache        # 或改回 CACHE_DRIVER=none',
  },
  {
    id: 'ASG-005', category: 'ASG', severity: 'error', overridable: true, scope: 'startup', modules: ['queue', 'autoscaling'], ...asgOnly,
    check: (ctx) => env(ctx, 'QUEUE_DRIVER') === 'memory',
    message: () => 'DEPLOY_MODE=asg 时 QUEUE_DRIVER=memory：实例缩容时队列中的任务随进程消失',
    fix: 'scripts/module enable queue',
  },
  {
    id: 'ASG-006', category: 'ASG', severity: 'error', overridable: true, scope: 'startup', modules: ['scheduler', 'autoscaling'], ...asgOnly,
    check: (ctx) => (env(ctx, 'SCHEDULER_DRIVER') || 'cron') === 'cron' && ctx.lockScope() === 'host',
    message: () => 'DEPLOY_MODE=asg、SCHEDULER_DRIVER=cron 且 LockPort 的 scope=host：每台实例各跑一次日报，管理员收到 N 封邮件',
    fix: 'scripts/module enable database（pg advisory lock）或 cache（redis 锁），或 scripts/module enable scheduler',
  },
  {
    id: 'ASG-007', category: 'ASG', severity: 'error', overridable: true, scope: 'startup', modules: ['auth', 'secrets', 'autoscaling'], ...asgOnly,
    check: (ctx) => driverOf(ctx.env, 'auth') === 'local' && ctx.cfg.core.SECRETS_ORIGIN === 'instance',
    message: () => 'DEPLOY_MODE=asg、AUTH_DRIVER=local 且 SECRETS_ORIGIN=instance：每台实例的 JWT 签名密钥不同，用户随机掉线',
    fix: '经 autoscaling 的引导配置包共享密钥（SECRETS_ORIGIN=bundle），或 scripts/module enable secrets / auth',
  },
  {
    id: 'ASG-008', category: 'ASG', severity: 'error', overridable: true, scope: 'startup', modules: ['secrets', 'kms', 'autoscaling'], ...asgOnly,
    check: (ctx) => ctx.cfg.core.SECRETS_ORIGIN === 'instance' && !ctx.cfg.core.KMS_KEY_ID,
    message: () => 'DEPLOY_MODE=asg 时上传 / 媒体 / 回调 HMAC 密钥或 LOCAL_MASTER_KEY 来自本机（instance）：A 签发的上传 URL 在 B 上验签失败',
    fix: 'SECRETS_ORIGIN=bundle（引导配置包）或 scripts/module enable secrets；字段加密改用 kms',
  },
  {
    id: 'ASG-009', category: 'ASG', severity: 'warn', overridable: false, scope: 'startup', modules: ['logging', 'autoscaling'], ...asgOnly,
    check: (ctx) => (env(ctx, 'LOG_DRIVER') || 'file') === 'file',
    message: () => 'LOG_DRIVER=file：日志分散在各实例，实例终止后日志随之消失',
    fix: 'scripts/module enable logging',
  },
  {
    id: 'ASG-010', category: 'ASG', severity: 'warn', overridable: false, scope: 'startup', modules: ['monitoring', 'autoscaling'], ...asgOnly,
    check: (ctx) => (env(ctx, 'METRICS_DRIVER') || 'local') === 'local',
    message: () => 'METRICS_DRIVER=local：原始样本按实例分散；分钟级汇总写入共享数据库，/lab 仍可用',
    fix: 'scripts/module enable monitoring',
  },
  {
    id: 'ASG-011', category: 'ASG', severity: 'warn', overridable: false, scope: 'startup', modules: ['email', 'autoscaling'], ...asgOnly,
    check: (ctx) => (env(ctx, 'EMAIL_DRIVER') || 'outbox') === 'outbox',
    message: () => 'EMAIL_DRIVER=outbox：.eml 文件分散在各实例；outbox_emails 表是共享的',
    fix: 'scripts/module enable email',
  },
  {
    id: 'ASG-012', category: 'ASG', severity: 'warn', overridable: false, scope: 'startup', modules: ['config', 'autoscaling'], ...asgOnly,
    check: (ctx) => (env(ctx, 'CONFIG_DRIVER') || 'file') === 'file',
    message: () => 'CONFIG_DRIVER=file：各实例的 runtime.json 可能不一致（配置漂移）',
    fix: 'scripts/module enable config',
  },
  {
    id: 'ASG-013', category: 'ASG', severity: 'warn', overridable: false, scope: 'startup', modules: ['cache', 'waf', 'autoscaling'], ...asgOnly,
    check: (ctx) => {
      const hits: RuleHit[] = [];
      if (env(ctx, 'CACHE_DRIVER') !== 'redis') hits.push({ modules: ['cache'], message: '应用层：CACHE_DRIVER≠redis' });
      if (env(ctx, 'WAF_MODE') === 'nginx') hits.push({ modules: ['waf'], message: 'Nginx 层：WAF_MODE=nginx' });
      return hits;
    },
    message: () => '限速计数按实例分别统计：实际限额 = 单实例限额 × 实例数',
    fix: 'scripts/module enable cache；scripts/module enable waf',
  },
  {
    id: 'ASG-014', category: 'ASG', severity: 'error', overridable: false, scope: 'startup', modules: ['tls', 'autoscaling'], ...asgOnly,
    check: (ctx) => env(ctx, 'TLS_MODE') === 'letsencrypt',
    message: () => 'DEPLOY_MODE=asg 时 TLS_MODE=letsencrypt：HTTP-01 验证请求会被 ALB 分到随机实例，各实例重复签发会触发 CA 频率限制',
    fix: 'TLS 在 ALB 或 CloudFront 终止：scripts/module enable tls（acm）',
    platformFix: '当前 TLS_MODE=letsencrypt 来自平台预览方案 B：执行 scripts/module tls-preview off；卡片应在 lab.yaml 中关闭 preview.directHttps（06 PM-21）',
  },
  {
    id: 'ASG-016', category: 'ASG', severity: 'warn', overridable: false, scope: 'startup', modules: ['db-proxy', 'autoscaling'], ...asgOnly,
    check: (ctx) => env(ctx, 'DB_PROXY_MODE') === 'pgbouncer',
    message: () => 'DB_PROXY_MODE=pgbouncer：每台实例各有一个 PgBouncer，总连接数仍随实例数线性增长（这正是 RDS Proxy 要解决的问题）',
    fix: 'scripts/module enable db-proxy（rds-proxy）',
  },

  // ===========================================================================================
  // 安全提示（SEC）
  // ===========================================================================================
  {
    id: 'SEC-001', category: 'SEC', severity: 'warn', overridable: false, scope: 'runtime', modules: ['cdn'],
    check: (ctx) => ctx.isEnabled('cdn') && Boolean(ctx.observed?.cdn?.originVerifyMismatch5m || ctx.observed?.cdn?.listener8080Missing),
    message: () => 'cdn 已启用，但 8080 监听器缺失，或最近 5 分钟出现 X-Origin-Verify 不匹配的回源请求（有人用自己的 CloudFront 分配指向我们的源站）',
    fix: '检查 slot-origin-verify.inc 与 cdn 的 hostSetup；轮换 origin-verify',
  },
  {
    id: 'SEC-002', category: 'SEC', severity: 'warn', overridable: false, scope: 'runtime', modules: ['load-balancer'],
    check: (ctx) => ctx.isEnabled('load-balancer') && Boolean(ctx.observed?.['load-balancer']?.directPublicRequests5m),
    message: () => 'load-balancer 已启用，但最近 5 分钟仍有不经 ALB 的公网请求（用户绕过 ALB 直连 EIP）',
    fix: 'LB_LOCK_ORIGIN=on（基础栈 PublicHttpIngress=closed）',
  },
  {
    id: 'SEC-003', category: 'SEC', severity: 'warn', overridable: false, scope: 'runtime', modules: ['shell-access'],
    check: (ctx) => env(ctx, 'SHELL_ACCESS_MODE') === 'ssm' && Boolean(ctx.observed?.['shell-access']?.port22Open),
    message: () => 'SHELL_ACCESS_MODE=ssm 但安全组仍开放 22（SHELL_ACCESS_KEEP_SSH=true 时为预期的过渡状态）',
    fix: 'scripts/module base set SshIngressCidr=',
  },
  {
    id: 'SEC-004', category: 'SEC', severity: 'warn', overridable: false, scope: 'startup', modules: [],
    check: (ctx) => {
      if (ctx.cfg.core.EXPOSE_PATH_HEADERS !== 'all') return false;
      try {
        const u = new URL(ctx.cfg.core.APP_BASE_URL);
        return u.protocol === 'https:' && !isLoopback(u.hostname) && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) && u.hostname.includes('.');
      } catch {
        return false;
      }
    },
    message: () => 'EXPOSE_PATH_HEADERS=all 且站点是 HTTPS 公网地址：路径头会暴露内部架构',
    fix: 'EXPOSE_PATH_HEADERS=admin（或应用覆盖层 overlay-public-demo）',
  },
  {
    id: 'SEC-005', category: 'SEC', severity: 'warn', overridable: false, scope: 'runtime', modules: ['auth', 'tls'],
    check: (ctx) => driverOf(ctx.env, 'auth') === 'local' && Boolean(ctx.observed?.auth?.plaintextAuthRequests5m),
    message: () => 'AUTH_DRIVER=local 且观测到经明文 HTTP 提交的 /api/auth/* 请求（前端显示“当前连接未加密”横幅）',
    fix: 'scripts/module enable tls',
  },
];

// ATL 平台模式规则（06 PM-48）：只在平台模式下求值（ATL-CFG-001 另外在 platform.env 存在时求值）
RULES.push(
  {
    id: 'ATL-CFG-001', category: 'ATL', severity: 'error', overridable: false, scope: 'startup', modules: [],
    check: (ctx) => {
      if (!ctx.layers.platformEnv && (ctx.env.ATL_PLATFORM_MODE ?? 'off') === 'off') return false;
      const v = validatePlatformEnv(atlKeys(ctx.env), {
        cloudalbumEnv: ctx.cfg.core.CLOUDALBUM_ENV, ...(ctx.layers.platformEnv ? { rawKeys: ctx.layers.platformEnv.keys } : {}),
      });
      return v.errors.map((message): RuleHit => ({ message }));
    },
    message: () => '平台配置 platform.env 损坏（只允许 ATL_ 键；平台模式开启时必填变量齐全且格式正确；ATL_ENV_NAME 等于 CLOUDALBUM_ENV）',
    fix: '由平台执行“环境修复”（ATL_OP=repair 重新写入 platform.env：cloudalbum platform:apply-env）',
  },
  {
    id: 'ATL-CFG-002', category: 'ATL', severity: 'warn', overridable: false, scope: 'startup', modules: [], platformOnly: true,
    check: (ctx) => {
      if ((ctx.env.ATL_PLATFORM_MODE ?? 'off') !== 'on') return false;
      const secret = readLocalProbeSecret({ envDir: ctx.cfg.core.CLOUDALBUM_ENV_DIR, probeTokenFile: ctx.env.ATL_PROBE_TOKEN_FILE ?? '' });
      return secret === null;
    },
    message: () => '平台模式开启，但本机探测密钥不存在或不可读：探测主体不可用，平台检测会失败',
    fix: 'cloudalbum probe-token --init（root）',
  },
  {
    id: 'ATL-NET-001', category: 'ATL', severity: 'error', overridable: false, scope: ['startup', 'deploy'], modules: ['network'], platformOnly: true,
    check: (ctx) => env(ctx, 'NETWORK_PLACEMENT') === 'private' && env(ctx, 'NETWORK_NAT_MODE') === 'none'
      && !['ssm', 'ops', 'all'].includes(env(ctx, 'NETWORK_INTERFACE_ENDPOINTS')),
    message: () => 'NETWORK_PLACEMENT=private、NatMode=none，且没有 ssm / ssmmessages / ec2messages 接口终端节点：平台管理通道会断（P7）',
    fix: '保留 NAT，或 InterfaceEndpoints=ssm / ops / all（平台模式下 ops 含 ec2messages，PM-M01）',
  },
  {
    id: 'ATL-IAM-001', category: 'ATL', severity: 'error', overridable: false, scope: 'deploy', modules: ['iam', 'ec2'], platformOnly: true,
    enforcedBy: 'scripts/module（06 PM-31：基础栈 InstanceProfileName 恒为 CloudAlbumAppRole，iam 栈 AppRoleMode=existing）',
    message: () => '平台管理通道依赖实例配置文件 CloudAlbumAppRole：不得改为其他值或删除，iam 栈必须使用 AppRoleMode=existing',
    fix: 'iam 的平台模式由 scripts/module --platform 自动处理；keys 模式经平台动作 iam-keys-on',
  },
);

function isModuleIdSafe(id: string): id is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(id);
}

export const RULE_IDS: ReadonlySet<string> = new Set(RULES.map((r) => r.id));

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id);
}
