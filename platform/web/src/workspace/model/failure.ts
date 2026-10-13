/**
 * P04 失败面板（08 P04“失败面板”；码表 02 §13.2，处理建议取自 02 §12）：`failure.code` → 标题、说明与操作。
 * 启动失败不计入尝试次数（04 §8.4 `void`）；“重新开始”回到 P03 并打开开始对话框（必须重新报价）。
 */

export type FailureAction = 'restart' | 'fresh' | 'current' | 'diagnostics' | 'copy-diagnostics' | 'copy-command';

export interface FailureMeta {
  title: string;
  description: string;
  actions: FailureAction[];
}

const T = (title: string, description: string, actions: FailureAction[]): FailureMeta => ({ title, description, actions });

const TABLE: readonly [readonly string[], FailureMeta][] = [
  [['QUOTE_EXPIRED', 'QUOTE_MISMATCH'], T('费用信息已更新', '报价在开始前失效。没有创建任何资源。', ['restart'])],
  [['LOCK_BUSY'], T('环境被占用', '另一个实验正持有环境。没有创建资源。', ['current', 'fresh'])],
  [['ENV_NOT_AVAILABLE'], T('要复用的环境已不可用', '要复用的保留环境已释放或不可用。没有创建资源。', ['current', 'fresh'])],
  [
    ['PREFLIGHT_NO_DEFAULT_VPC', 'PREFLIGHT_QUOTA', 'PREFLIGHT_PREREQ', 'PREFLIGHT_DR_REGION'],
    T('账号预检未通过', '逐项检查默认 VPC、配额、缺少的学员输入与灾备区域设置。没有创建任何资源。', ['copy-command', 'restart']),
  ],
  [['CAPACITY'], T('可用区容量不足', '已换可用区重试一次仍失败。请稍后再试。', ['restart'])],
  [
    ['ACCOUNT_RESTRICTED', 'ACCOUNT_QUOTA', 'ACCESS_DENIED'],
    T('账号受限', '下面是 AWS 返回的原始错误。可能是组织 SCP 的限制或账号配额不足，建议联系账号管理员或申请提高配额。', ['copy-diagnostics']),
  ],
  [['BASE_DEPLOY_FAILED', 'BASE_BOOTSTRAP_FAILED'], T('实验机启动失败', '实验机没能完成引导。诊断信息中有引导日志摘要与实例控制台输出。', ['diagnostics', 'restart'])],
  [
    ['PROFILE_RULES', 'PROFILE_DIGEST_MISMATCH'],
    T('实验定义有误', '这是卡片内容或平台版本的问题，不是你的操作问题，已通知管理员（你）。可以在 设置 › 内容版本 中查看。', ['copy-diagnostics']),
  ],
  [
    ['PROFILE_STACK_FAILED', 'PROFILE_MIGRATION_FAILED', 'PROFILE_PROBE_FAILED', 'EXTRA_STACK_FAILED'],
    T('起始状态部署失败', '部署起始状态时失败。诊断信息中有失败的模块或栈与 CloudFormation 原因。', ['diagnostics', 'restart']),
  ],
  [
    ['RUNNER_TIMEOUT', 'RUNNER_QUEUE_TIMEOUT', 'RUNNER_ERROR', 'ENV_LOCK_TIMEOUT'],
    T('平台运行器出错', '平台运行器没能完成部署（已按规则重试）。排队超时时，可以申请提高 CodeBuild 并发配额。', ['restart']),
  ],
  [['WORKSTATION_FAILED'], T('工作台创建失败', '工作台实例没能创建。卡片允许时，可以选择“不启动工作台（CloudShell 省钱模式）”重新开始。', ['restart'])],
  [['SSM_NOT_REGISTERED'], T('实验机无法连接管理通道', '常见原因：实例配置文件、出网路径、私有放置缺 NAT 或终端节点。', ['diagnostics', 'restart'])],
  [['HEALTH_FAILED'], T('健康检查未通过', '修复一次后仍未通过。诊断信息中列出了未通过的检查项。', ['diagnostics', 'restart'])],
  [['START_TIMEOUT', 'PROVISION_TIMEOUT'], T('准备超时', '准备时间超过上限，平台已自动停止并释放已创建的资源。', ['restart'])],
  [['WORKFLOW_ERROR'], T('平台编排出错', '平台编排出错，已生成待人工处理清单；平台会自动重试回收。', ['copy-diagnostics'])],
];

const BY_CODE = new Map<string, FailureMeta>();
for (const [codes, meta] of TABLE) for (const c of codes) BY_CODE.set(c, meta);

export function failureMeta(code: string | null | undefined): FailureMeta {
  return (code && BY_CODE.get(code)) || T('启动失败', '平台没能完成准备。下面是原始错误。', ['copy-diagnostics', 'restart']);
}

export function isKnownFailure(code: string | null | undefined): boolean {
  return !!code && BY_CODE.has(code);
}

/** “复制诊断信息”：code、phase、requestId、会话 id（§5.2 FailurePanel）+ 原始消息。 */
export function diagnosticsText(sid: string, failure: { code?: string | null; phase?: string | null; message?: string | null; requestId?: string | null } | null | undefined): string {
  const f = failure ?? {};
  return [
    `sessionId=${sid}`,
    `code=${f.code ?? 'UNKNOWN'}`,
    f.phase ? `phase=${f.phase}` : null,
    f.requestId ? `requestId=${f.requestId}` : null,
    f.message ? `message=${f.message}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 诊断条目（`failure.diagnostics[]`：运行器日志摘要、CloudFormation 失败事件、实例控制台输出、SSM 命令输出，02 §2.6）。 */
export function diagnosticLines(diagnostics: unknown[] | null | undefined): string[] {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.slice(0, 50).map((d) => {
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>;
      const kind = typeof o.kind === 'string' ? o.kind : typeof o.source === 'string' ? o.source : typeof o.type === 'string' ? o.type : null;
      const text = typeof o.summary === 'string' ? o.summary : typeof o.message === 'string' ? o.message : typeof o.reason === 'string' ? o.reason : JSON.stringify(o);
      return kind ? `${kind}: ${text}` : text;
    }
    return String(d);
  });
}

/** 预检失败时给出的修复命令（`PREFLIGHT_NO_DEFAULT_VPC`：创建默认 VPC）。 */
export function preflightCommand(code: string | null | undefined, region: string | null | undefined): string | null {
  if (code === 'PREFLIGHT_NO_DEFAULT_VPC') return `aws ec2 create-default-vpc --region ${region ?? '<区域>'}`;
  return null;
}
