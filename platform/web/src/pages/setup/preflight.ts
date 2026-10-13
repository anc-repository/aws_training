/**
 * 平台体检项（08 P00 第 2 步；01 §4.1）：`PlatformConfig.preflight.items[]` → 结论（需处理 / 提示 / 通过 / 无法检测）与说明。
 * 安装时的体检由 platform/infra 的 preflight 自定义资源写入（字段 `{ id, status: ok|warn|info|unknown, detail, hint? }`；
 * 08 §9.2 #3 的写法是 `{ id, status: ok|warn|fail|unknown, message, fix{command?, url?} }`，两种都接受）。
 * 未知 id 显示服务端返回的说明（§9.2 #3 的降级）。
 */
export interface PreflightItem {
  id: string;
  status: string;
  message?: string;
  detail?: string;
  hint?: string;
  fix?: { command?: string; url?: string } | null;
  resources?: { type?: string; name?: string; role?: string }[];
}

export type Verdict = 'fix' | 'warn' | 'pass' | 'unknown';

/** 这些检查不满足时会让开始实验失败（“需处理”）；其余不满足的是“提示”。 */
const FIX_IDS = new Set(['default-vpc', 'residual-stacks', 'name-conflicts', 'name-conflict']);

export function verdictOf(i: PreflightItem): Verdict {
  if (i.status === 'ok' || i.status === 'pass') return 'pass';
  if (i.status === 'fail') return 'fix';
  if (i.status === 'warn' || i.status === 'info') return FIX_IDS.has(i.id) && i.status === 'warn' ? 'fix' : 'warn';
  return 'unknown';
}

export const VERDICT_META: Readonly<Record<Verdict, { text: string; shape: 'sq' | 'tri' | 'check' | 'q'; tone: 'fail' | 'drift' | 'pass' | 'needs' }>> = {
  fix: { text: '需处理', shape: 'sq', tone: 'fail' },
  warn: { text: '提示', shape: 'tri', tone: 'drift' },
  pass: { text: '通过', shape: 'check', tone: 'pass' },
  unknown: { text: '无法检测', shape: 'q', tone: 'needs' },
};

export interface PreflightText {
  /** 通过时的一句话（折叠行）。 */
  ok: string;
  /** 需处理 / 提示时的标题。 */
  title: string;
  /** 说明。 */
  body?: string;
  /** 新标签页打开的链接（学员自己的登录）。 */
  link?: { label: string; url: (region: string) => string };
  /** 只复制、不粘贴的命令（此时没有终端）。 */
  command?: (region: string) => string;
  /** 放在“我确认要删除”折叠区内的危险命令。 */
  dangerCommand?: (region: string) => string;
}

const quotas = { label: '打开 Service Quotas', url: (r: string) => `https://console.aws.amazon.com/servicequotas/home?region=${encodeURIComponent(r)}` };

export const PREFLIGHT_TEXT: Readonly<Record<string, PreflightText>> = {
  region: { ok: '区域在已验证列表中', title: '区域不在已验证列表中', body: '部分卡片依赖的服务或实例类型在这个区域可能不可用（以官方文档为准）。' },
  'default-vpc': {
    ok: '默认 VPC 与默认子网',
    title: '默认 VPC：这个区域中没有默认 VPC',
    body: 'L0 实验机与工作台都放在默认 VPC 的公有子网中。请自己执行下面的命令（平台不会代为创建，也不会回收默认 VPC）：',
    command: (r) => `aws ec2 create-default-vpc --region ${r}`,
  },
  'vcpu-quota': { ok: '按需实例 vCPU 配额', title: 'EC2 按需实例 vCPU 配额可能较低', body: '实验机与工作台同时运行；高费用卡片还会同时运行多台实例。', link: quotas },
  'existing-trail': { ok: '没有已有的 CloudTrail trail', title: '账号已有 CloudTrail trail', body: 'svc-audit 等审计类卡片会以“只读接入”方式运行。' },
  guardduty: { ok: '没有已启用的 GuardDuty', title: '账号已启用 GuardDuty', body: '威胁检测类卡片（svc-threat-detection、sc-threat-compliance）会以“只读接入”方式运行。' },
  'config-recorder': { ok: '没有已有的 Config 记录器', title: '账号已有 AWS Config 记录器', body: '合规类卡片（svc-compliance、sc-security-baseline）会以“只读接入”方式运行。' },
  inspector: { ok: 'Inspector 未激活', title: '账号已激活 Amazon Inspector', body: '漏洞扫描类卡片（svc-vuln-scan）会以“只读接入”方式运行。' },
  'access-analyzer': { ok: '外部访问分析器', title: '账号已有外部访问分析器', body: '建议在下次更新平台栈时把 ExternalAccessAnalyzer 设为 existing。' },
  'ses-sandbox': { ok: 'SES 已移出沙箱', title: 'SES 处于沙箱', body: '邮件类卡片（svc-email、sc-event-fanout）的收件人也要先验证。' },
  organizations: { ok: '未检测到组织 SCP 限制（无法完全检测）', title: '账号属于 AWS Organizations，可能受 SCP 限制', body: '部分实验操作可能被组织的服务控制策略拒绝（无法完全检测）。' },
  'codebuild-concurrency': { ok: 'CodeBuild 并发配额', title: 'CodeBuild 并发配额较低', body: '开始实验时可能出现排队。', link: quotas },
  'lambda-concurrency': { ok: 'Lambda 并发配额', title: 'Lambda 并发配额较低', body: '开始实验时可能出现排队。', link: quotas },
  'residual-stacks': {
    ok: '没有同名资源冲突、没有残留的 cloudalbum-* 栈',
    title: '账号中有残留的 cloudalbum-* 栈',
    body: '请先列出它们，确认是自用模式留下的再删除（删除不可撤销）。',
    command: (r) => `aws cloudformation list-stacks --region ${r} --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE --query "StackSummaries[?starts_with(StackName,'cloudalbum-')].StackName"`,
    dangerCommand: (r) => `aws cloudformation delete-stack --region ${r} --stack-name <要删除的栈名>`,
  },
  'borrowable-compute': {
    ok: '没有挂着高权限角色的计算资源',
    title: '账号中有挂着高权限角色的计算资源',
    body: '权限边界拦不住“借用已有资源”。强烈建议使用专门的练习账号。',
  },
};

export function preflightTitle(i: PreflightItem): string {
  const m = PREFLIGHT_TEXT[i.id];
  if (!m) return i.message ?? i.detail ?? i.id;
  return verdictOf(i) === 'pass' ? m.ok : m.title;
}
