/**
 * P04 失败面板（08 P04“失败面板”；码表 02 §13.2，处理建议取自 02 §12）：`failure.code` → 标题、说明与操作。
 * 启动失败不计入尝试次数（04 §8.4 `void`）；“重新开始”回到 P03 并打开开始对话框（必须重新报价）。
 */

import { msg } from '../../i18n';
export type FailureAction = 'restart' | 'fresh' | 'current' | 'diagnostics' | 'copy-diagnostics' | 'copy-command';

export interface FailureMeta {
  title: string;
  description: string;
  actions: FailureAction[];
}

type FailureKey = Exclude<keyof typeof msg.workspace.failure, 'regionPlaceholder'>;
const T = (key: FailureKey, actions: FailureAction[]): FailureMeta => ({
  get title() {
    return msg.workspace.failure[key].title;
  },
  get description() {
    return msg.workspace.failure[key].description;
  },
  actions,
});

const TABLE: readonly [readonly string[], FailureMeta][] = [
  [['QUOTE_EXPIRED', 'QUOTE_MISMATCH'], T('quote', ['restart'])],
  [['LOCK_BUSY'], T('lockBusy', ['current', 'fresh'])],
  [['ENV_NOT_AVAILABLE'], T('envGone', ['current', 'fresh'])],
  [
    ['PREFLIGHT_NO_DEFAULT_VPC', 'PREFLIGHT_QUOTA', 'PREFLIGHT_PREREQ', 'PREFLIGHT_DR_REGION'],
    T('preflight', ['copy-command', 'restart']),
  ],
  [['CAPACITY'], T('capacity', ['restart'])],
  [
    ['ACCOUNT_RESTRICTED', 'ACCOUNT_QUOTA', 'ACCESS_DENIED'],
    T('account', ['copy-diagnostics']),
  ],
  [['BASE_DEPLOY_FAILED', 'BASE_BOOTSTRAP_FAILED'], T('base', ['diagnostics', 'restart'])],
  [
    ['PROFILE_RULES', 'PROFILE_DIGEST_MISMATCH'],
    T('definition', ['copy-diagnostics']),
  ],
  [
    ['PROFILE_STACK_FAILED', 'PROFILE_MIGRATION_FAILED', 'PROFILE_PROBE_FAILED', 'EXTRA_STACK_FAILED'],
    T('profile', ['diagnostics', 'restart']),
  ],
  [
    ['RUNNER_TIMEOUT', 'RUNNER_QUEUE_TIMEOUT', 'RUNNER_ERROR', 'ENV_LOCK_TIMEOUT'],
    T('runner', ['restart']),
  ],
  [['WORKSTATION_FAILED'], T('workstation', ['restart'])],
  [['SSM_NOT_REGISTERED'], T('ssm', ['diagnostics', 'restart'])],
  [['HEALTH_FAILED'], T('health', ['diagnostics', 'restart'])],
  [['START_TIMEOUT', 'PROVISION_TIMEOUT'], T('timeout', ['restart'])],
  [['WORKFLOW_ERROR'], T('workflow', ['copy-diagnostics'])],
];

const BY_CODE = new Map<string, FailureMeta>();
for (const [codes, meta] of TABLE) for (const c of codes) BY_CODE.set(c, meta);

export function failureMeta(code: string | null | undefined): FailureMeta {
  return (code && BY_CODE.get(code)) || T('fallback', ['copy-diagnostics', 'restart']);
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
  if (code === 'PREFLIGHT_NO_DEFAULT_VPC') return `aws ec2 create-default-vpc --region ${region ?? msg.workspace.failure.regionPlaceholder}`;
  return null;
}
