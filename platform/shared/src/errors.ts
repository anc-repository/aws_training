/**
 * Error codes — 01 §8.6 (general + agent route codes), 03 §9.1 (terminal / console codes and preview reason codes),
 * 02 §13.2 (`LabSession.failure.code`). All use `application/problem+json` `{ type, title, status, code, detail, requestId }`.
 */

export interface ErrorCodeDef {
  http: number;
  meaning: string;
}

/** 01 §8.6 main table. */
export const API_ERROR_CODES = {
  UNAUTHENTICATED: { http: 401, meaning: '令牌缺失或无效' },
  FORBIDDEN_ROLE: { http: 403, meaning: '角色无权执行（5.2）' },
  REAUTH_REQUIRED: { http: 403, meaning: '敏感操作要求最近登录' },
  CALLER_MISMATCH: { http: 403, meaning: 'internal 路由的调用方 ARN 与路径中的会话或 runId 不符' },
  NOT_FOUND: { http: 404, meaning: '—' },
  SESSION_ACTIVE_EXISTS: { http: 409, meaning: '已有活动会话（PROVISIONING～ENDING）' },
  ENV_KEPT_EXISTS: { http: 409, meaning: '有保留中的环境：先释放或复用' },
  CLEANUP_IN_PROGRESS: { http: 409, meaning: '上一个环境正在回收' },
  RESIDUAL_ACK_REQUIRED: { http: 409, meaning: '存在按小时计费的 BLOCKING 残留，需带 residualAck' },
  REUSE_IN_PROGRESS: { http: 409, meaning: '保留环境已被新会话预留复用，不能立即释放' },
  INVALID_STATE: { http: 409, meaning: '当前会话状态不允许此操作（浏览器路由）' },
  SESSION_EXPIRING_OR_ENDED: { http: 409, meaning: '已到期或进入结束流程，不能延长' },
  EXTENSION_LIMIT: { http: 409, meaning: '延长次数或累计时长已用完' },
  KEEP_NOT_ALLOWED: { http: 409, meaning: '本卡片不允许保留环境' },
  MAINTENANCE_MODE: { http: 409, meaning: '平台处于维护模式' },
  PLATFORM_UNINSTALLING: { http: 409, meaning: '平台正在卸载' },
  BUDGET_BLOCKED: { http: 409, meaning: '预算超限，按 BudgetEnforcement 拒绝' },
  PRECONDITION_FAILED: { http: 412, meaning: 'If-Match 或 expectedDeadlineVersion 不符' },
  COST_ACK_REQUIRED: { http: 422, meaning: '未确认费用' },
  QUOTE_EXPIRED: { http: 422, meaning: '报价过期，需重新报价' },
  QUOTE_MISMATCH: { http: 422, meaning: '报价后价格表、卡片版本或变体发生变化' },
  LIMIT_EXCEEDED: { http: 422, meaning: '超过时长或保留上限' },
  OP_NOT_ALLOWED: { http: 422, meaning: 'actionId 不在本卡片允许的平台动作中' },
  VARIANT_UNKNOWN: { http: 422, meaning: '卡片没有这个变体' },
  PROFILE_DIGEST_MISMATCH: { http: 422, meaning: '起始档位与平台携带的 CloudAlbum 工具包版本不匹配' },
  CERT_NOT_ELIGIBLE: { http: 422, meaning: '不满足领取条件（附原因）' },
  VALIDATION_FAILED: { http: 400, meaning: '请求体不符合 schema' },
  RATE_LIMITED: { http: 429, meaning: '应用级限速' },
  UPSTREAM_THROTTLED: { http: 503, meaning: 'AWS API 被限流（已退避重试）' },
  UPSTREAM_UNAVAILABLE: { http: 503, meaning: '依赖的 AWS 服务暂时不可用' },
  INTERNAL: { http: 500, meaning: '—' },
} as const satisfies Record<string, ErrorCodeDef>;

/** 01 §8.6 agent-route codes (semantics 04 §7.2, §7.5). */
export const AGENT_ERROR_CODES = {
  SESSION_MISMATCH: { http: 403, meaning: '调用方会话名中的 sid 与路径不一致，或不是 -ws 通道' },
  SESSION_NOT_RUNNING: { http: 409, meaning: '会话不在该 agent 路由允许的状态' },
  RUN_NOT_FOUND: { http: 404, meaning: 'runId 未登记' },
  RUN_MISMATCH: { http: 409, meaning: '上传内容与登记不一致' },
  ALREADY_SUBMITTED: { http: 409, meaning: '同一 runId 重复提交' },
  SCHEMA_INVALID: { http: 400, meaning: '结果 JSON 结构错误' },
  DIGEST_MISMATCH: { http: 400, meaning: 'integrity.digest 与复算结果不一致' },
  TOO_LARGE: { http: 413, meaning: '请求体超限' },
  EXPERIMENT_NOT_IN_LAB: { http: 422, meaning: '本卡未声明该实验' },
  LABEL_NOT_IN_LAB: { http: 422, meaning: 'label 不是本卡为该实验声明的变体' },
} as const satisfies Record<string, ErrorCodeDef>;

/** 03 §9.1 terminal / console codes (“待 01 登记到 §8.6”; HTTP statuses from 03 §3.2, §5.2). */
export const WORKSPACE_ERROR_CODES = {
  TERMINAL_SESSION_STATE: { http: 409, meaning: '会话状态不允许打开终端（或访问已收回）' },
  TERMINAL_TARGET_NOT_IN_SESSION: { http: 404, meaning: '目标实例不属于本环境' },
  TERMINAL_TARGET_NOT_CONNECTED: { http: 409, meaning: '目标实例的 SSM PingStatus 不是 Online' },
  TERMINAL_TARGET_NOT_PREPARED: { http: 409, meaning: '目标实例的平台准备未完成' },
  TERMINAL_LIMIT: { http: 429, meaning: '终端数量超出上限' },
  TERMINAL_GONE: { http: 409, meaning: 'SSM 会话已终止，不能续连' },
  CONSOLE_SESSION_STATE: { http: 409, meaning: '会话状态不允许获取控制台链接' },
  CONSOLE_DESTINATION_NOT_ALLOWED: { http: 422, meaning: '控制台目标不在深链接注册表中' },
  CONSOLE_FEDERATION_FAILED: { http: 503, meaning: '联合登录端点调用失败' },
} as const satisfies Record<string, ErrorCodeDef>;

export const ERROR_CODES = { ...API_ERROR_CODES, ...AGENT_ERROR_CODES, ...WORKSPACE_ERROR_CODES } as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export function httpStatusOf(code: ErrorCode): number {
  return ERROR_CODES[code].http;
}

/** Preview embeddability reason codes (03 §6.1, §9.1). */
export const PREVIEW_REASON_CODES = ['MIXED_CONTENT', 'UNTRUSTED_CERT', 'FRAME_ANCESTORS_MISSING', 'X_FRAME_OPTIONS', 'UNREACHABLE'] as const;

/**
 * Codes the UI (08 §9.2 #1) asks 01 to register; not part of ERROR_CODES yet.
 * `TARGET_ALREADY_SATISFIED` is already used by 02 §13.1 in `POST /sessions`.
 */
export const UI_REQUESTED_ERROR_CODES = ['TARGET_ALREADY_SATISFIED', 'HARD_PREREQ_UNMET', 'LAB_DEPRECATED', 'CURSOR_EXPIRED'] as const;

/** `LabSession.failure.code` (02 §13.2). */
export const FAILURE_CODES = [
  'QUOTE_EXPIRED',
  'QUOTE_MISMATCH',
  'VARIANT_UNKNOWN',
  'LOCK_BUSY',
  'ENV_NOT_AVAILABLE',
  'START_TIMEOUT',
  'PREFLIGHT_NO_DEFAULT_VPC',
  'PREFLIGHT_QUOTA',
  'PREFLIGHT_PREREQ',
  'PREFLIGHT_DR_REGION',
  'CAPACITY',
  'ACCOUNT_RESTRICTED',
  'ACCOUNT_QUOTA',
  'ACCESS_DENIED',
  'BASE_DEPLOY_FAILED',
  'BASE_BOOTSTRAP_FAILED',
  'PROFILE_RULES',
  'PROFILE_DIGEST_MISMATCH',
  'PROFILE_STACK_FAILED',
  'PROFILE_MIGRATION_FAILED',
  'PROFILE_PROBE_FAILED',
  'EXTRA_STACK_FAILED',
  'ENV_LOCK_TIMEOUT',
  'RUNNER_TIMEOUT',
  'RUNNER_QUEUE_TIMEOUT',
  'RUNNER_ERROR',
  'WORKSTATION_FAILED',
  'SSM_NOT_REGISTERED',
  'HEALTH_FAILED',
  'PROVISION_TIMEOUT',
  'WORKFLOW_ERROR',
  'CLEANUP_TIMEOUT',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** RFC 7807 body used by every platform API error. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  [extension: string]: unknown;
}

export function problem(code: ErrorCode, detail?: string, extra: Record<string, unknown> = {}): ProblemDetails {
  const def = ERROR_CODES[code];
  return {
    type: `urn:atl:error:${code}`,
    title: def.meaning,
    status: def.http,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...extra,
  };
}

/** Error thrown by platform code; the HTTP layer turns it into problem+json. */
export class AtlError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(code: ErrorCode, detail?: string, extra: Record<string, unknown> = {}) {
    super(detail ?? ERROR_CODES[code].meaning);
    this.name = 'AtlError';
    this.code = code;
    this.status = ERROR_CODES[code].http;
    this.extra = extra;
  }
  toProblem(requestId?: string): ProblemDetails {
    return problem(this.code, this.message, { ...this.extra, ...(requestId ? { requestId } : {}) });
  }
}

/** Error names thrown from Lambda tasks to Step Functions (`Atl.*`, e.g. 02 §4.4 `Atl.LockBusy`, `Atl.TransitionRejected`). */
export function workflowErrorName(name: string): string {
  return name.startsWith('Atl.') ? name : `Atl.${name}`;
}
