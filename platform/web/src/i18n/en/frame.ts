/**
 * en（English）：命名空间 frame。由 `npm run i18n:sync` 按 zh-CN 词典维护结构：
 * 只填写引号内的译文（空字符串 = 未翻译，运行时按 en → en → zh-CN 回退）；行尾注释是 zh-CN 原文。
 * 术语与风格见 ../glossary.md（不翻译 AWS 服务名、CLI 命令、代码、资源名、API 路径、环境变量）。
 */
import type { Dict } from '../dict';
import type zh from '../zh-CN/frame';

export default {
  routes: {
    login: '', // 登录
    callback: '', // 正在完成登录
    signedOut: '', // 已退出
    setup: '', // 首次设置
    catalog: '', // 卡片目录
    card: '', // 卡片简介
    quiz: '', // 小测
    track: '', // 学习路径
    workspace: '', // 工作台
    sessions: '', // 我的实验
    session: '', // 会话详情
    end: '', // 结束与回收进度
    report: '', // 实验报告
    experiment: '', // 对比实验
    manual: '', // 待人工处理清单
    certificates: '', // 证书与徽章
    certificate: '', // 证书详情
    learning: '', // 我的学习
    settings: '', // 设置
  },
  bar: {
    progress: '', // 进度
    learning: '', // 我的学习 →
    certificates: '', // 证书 →
  },
  notFound: {
    mySessions: '', // 我的实验
    body: '', // {notFound} 地址 {path} 没有对应的画面；链接可能已过期，或输入有误。
    back: '', // 回到我的实验
    missingBody: '', // 它可能已被删除，或者不属于这个平台安装。
    canRetry: '', // 可以重试了。
  },
  residualOf: '', // {labId}（{t} 的实验）
  actions: {
    cancel: '', // 取消实验
    extend: '', // 延长实验
    end: '', // 结束实验
  },
  pill: {
    session: '', // 会话 {sid} · {state}
    tier: '', // ，费用档位{tier}
  },
  onboarding: '', // 首次设置还没有完成：可以先继续实验，之后在 设置 › 平台 中重看。
  footerCatalog: '', // 目录 {v}
  login: {
    devSubInvalid: 'Only letters, digits, - and _ (1–64 characters)', // 只能包含字母、数字、- 与 _（1～64 个字符）
    redirecting: 'Redirecting…', // 正在跳转…
    callbackFailed: 'Sign-in not completed', // 登录未完成
    signedOut: 'Signed out', // 已退出
  },
  crumbs: 'Breadcrumb', // 面包屑
  catalog: 'Card catalog', // 卡片目录
  about: ' · about {n} min ·', //  · 约 {n} 分钟 ·
  otherParams: '… (other parameters: UsePreviousValue=true)', // …（其余参数 UsePreviousValue=true）
  ws: {
    catalog: '', // ‹ 目录
    title: '', // 工作台
    notFoundTitle: '', // 没有找到这个实验会话
    notFound: '', // 它可能已被删除，或者地址有误。可以在“我的实验”中查看全部会话。
  },
  manualPage: {
    severity: {
      all: '', // 全部
      BLOCKING: '', // 阻塞
      REVIEW: '', // 需复核
      INFO: '', // 信息
    },
    crumbs: '', // 面包屑
    mySessions: '', // 我的实验
    title: '', // 待人工处理清单
    sub: '', // 跨会话汇总 · 每项都有控制台链接与 CLI 命令，处理后可重新核对
    remask: '', // 恢复打码
    unmask: '', // 显示完整名称
    filters: '', // 筛选
    severityLabel: '', // 严重级别
    billing: '', // 计费方式
    all: '', // 全部
    count: '', // 共 {n} 项
    countHourly: '', // 共 {n} 项，其中 {h} 项阻塞且按小时计费
    emptyTitle: '', // 没有未释放的资源。
    viewSessions: '', // 查看我的实验
    emptyBody: '', // 回收失败或复扫发现的残留会出现在这里。
    noMatch: '', // 没有符合筛选条件的条目。
    clear: '', // 清除筛选
    tagNote: '', // 这些资源都带有 atl:env-id 标签，可以在控制台按标签查找。处理后点“我已处理，重新核对”，平台会复核并在全部处理后结束回收。
    previous: '', // 之前的实验
    session: '', //  · 会话 {sid}
    reclaim: '', // 回收进度
    export: '', // 导出
    confirmed: '', // 已确认：资源已不存在
    still: '', // 资源仍然存在
    verifying: '', // 正在核对…
    safe: '', // 安全
    safeNote: '', // {safe} 这不是计费资源，但留着会让域名指向已删除的托管区域。
    confirmedNote: '', // 已确认：资源已不存在。
    stillNote: '', // 资源仍然存在，请确认删除已完成；CloudFront、RDS 等删除较慢，可以稍后再核对。
    slowNote: '', // 核对仍在进行，结果出来后清单会自动更新；也可以稍后刷新本页。
  },
  preflight: {
    verdict: {
      fix: 'Fix', // 需处理
      warn: 'Notice', // 提示
      pass: 'Passed', // 通过
      unknown: 'Can’t detect', // 无法检测
    },
    openQuotas: 'Open Service Quotas', // 打开 Service Quotas
    stackNamePlaceholder: '<stack name to delete>', // <要删除的栈名>
    items: {
      region: {
        ok: 'The Region is on the verified list', // 区域在已验证列表中
        title: 'The Region isn’t on the verified list', // 区域不在已验证列表中
        body: 'Some services or instance types that cards rely on may be unavailable in this Region (see the official documentation).', // 部分卡片依赖的服务或实例类型在这个区域可能不可用（以官方文档为准）。
      },
      'default-vpc': {
        ok: 'Default VPC and default subnets', // 默认 VPC 与默认子网
        title: 'Default VPC: this Region has no default VPC', // 默认 VPC：这个区域中没有默认 VPC
        body: 'The L0 lab instance and the workbench go into public subnets of the default VPC. Run the command below yourself (the platform neither creates nor reclaims the default VPC):', // L0 实验机与工作台都放在默认 VPC 的公有子网中。请自己执行下面的命令（平台不会代为创建，也不会回收默认 VPC）：
      },
      'vcpu-quota': {
        ok: 'On-Demand instance vCPU quota', // 按需实例 vCPU 配额
        title: 'The EC2 On-Demand vCPU quota may be low', // EC2 按需实例 vCPU 配额可能较低
        body: 'The lab instance and the workbench run at the same time; high cost tier cards run several more instances at once.', // 实验机与工作台同时运行；高费用卡片还会同时运行多台实例。
      },
      'existing-trail': {
        ok: 'No existing CloudTrail trail', // 没有已有的 CloudTrail trail
        title: 'The account already has a CloudTrail trail', // 账号已有 CloudTrail trail
        body: 'Audit cards such as svc-audit run in “read-only attach” mode.', // svc-audit 等审计类卡片会以“只读接入”方式运行。
      },
      guardduty: {
        ok: 'GuardDuty isn’t enabled', // 没有已启用的 GuardDuty
        title: 'GuardDuty is already enabled in the account', // 账号已启用 GuardDuty
        body: 'Threat detection cards (svc-threat-detection, sc-threat-compliance) run in “read-only attach” mode.', // 威胁检测类卡片（svc-threat-detection、sc-threat-compliance）会以“只读接入”方式运行。
      },
      'config-recorder': {
        ok: 'No existing Config recorder', // 没有已有的 Config 记录器
        title: 'The account already has an AWS Config recorder', // 账号已有 AWS Config 记录器
        body: 'Compliance cards (svc-compliance, sc-security-baseline) run in “read-only attach” mode.', // 合规类卡片（svc-compliance、sc-security-baseline）会以“只读接入”方式运行。
      },
      inspector: {
        ok: 'Inspector isn’t activated', // Inspector 未激活
        title: 'Amazon Inspector is already activated in the account', // 账号已激活 Amazon Inspector
        body: 'The vulnerability scanning card (svc-vuln-scan) runs in “read-only attach” mode.', // 漏洞扫描类卡片（svc-vuln-scan）会以“只读接入”方式运行。
      },
      'access-analyzer': {
        ok: 'External access analyzer', // 外部访问分析器
        title: 'The account already has an external access analyzer', // 账号已有外部访问分析器
        body: 'Set ExternalAccessAnalyzer to existing the next time you update the platform stack.', // 建议在下次更新平台栈时把 ExternalAccessAnalyzer 设为 existing。
      },
      'ses-sandbox': {
        ok: 'SES is out of the sandbox', // SES 已移出沙箱
        title: 'SES is in the sandbox', // SES 处于沙箱
        body: 'Email cards (svc-email, sc-event-fanout) also need their recipients verified first.', // 邮件类卡片（svc-email、sc-event-fanout）的收件人也要先验证。
      },
      organizations: {
        ok: 'No organization SCP restrictions detected (can’t be fully detected)', // 未检测到组织 SCP 限制（无法完全检测）
        title: 'The account belongs to AWS Organizations and may be restricted by SCPs', // 账号属于 AWS Organizations，可能受 SCP 限制
        body: 'Some lab operations may be denied by the organization’s service control policies (can’t be fully detected).', // 部分实验操作可能被组织的服务控制策略拒绝（无法完全检测）。
      },
      'codebuild-concurrency': {
        ok: 'CodeBuild concurrency quota', // CodeBuild 并发配额
        title: 'The CodeBuild concurrency quota is low', // CodeBuild 并发配额较低
        body: 'Starting a lab may have to wait in a queue.', // 开始实验时可能出现排队。
      },
      'lambda-concurrency': {
        ok: 'Lambda concurrency quota', // Lambda 并发配额
        title: 'The Lambda concurrency quota is low', // Lambda 并发配额较低
        body: 'Starting a lab may have to wait in a queue.', // 开始实验时可能出现排队。
      },
      'residual-stacks': {
        ok: 'No name conflicts and no leftover cloudalbum-* stacks', // 没有同名资源冲突、没有残留的 cloudalbum-* 栈
        title: 'The account has leftover cloudalbum-* stacks', // 账号中有残留的 cloudalbum-* 栈
        body: 'List them first, make sure they were left by self-use mode, then delete them (deletion can’t be undone).', // 请先列出它们，确认是自用模式留下的再删除（删除不可撤销）。
      },
      'borrowable-compute': {
        ok: 'No compute resources with highly privileged roles', // 没有挂着高权限角色的计算资源
        title: 'The account has compute resources with highly privileged roles', // 账号中有挂着高权限角色的计算资源
        body: 'A permissions boundary can’t stop “borrowing existing resources”. We strongly recommend a dedicated practice account.', // 权限边界拦不住“借用已有资源”。强烈建议使用专门的练习账号。
      },
    },
  },
} satisfies Dict<typeof zh>;
