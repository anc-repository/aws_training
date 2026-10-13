/**
 * API 错误（01 §8.1、§8.6；08 §2.6“错误”、P13）：统一解析 `application/problem+json`
 * `{ type, title, status, code, detail, requestId }`；网络错误与无法识别的响应也落到同一个类型，界面按 code 查文案表。
 */
import type { ErrorCode, ProblemDetails } from '@atl/shared';

/** 前端自己的错误码：网络不可达、响应无法解析。 */
export type ClientErrorCode = 'NETWORK' | 'BAD_RESPONSE';
/** 待 01 登记、但界面已预置文案的错误码（08 §9.2 #1、#22、#26）。 */
export type PendingErrorCode = 'TARGET_ALREADY_SATISFIED' | 'HARD_PREREQ_UNMET' | 'LAB_DEPRECATED' | 'CURSOR_EXPIRED' | 'RESIDUAL_BLOCKING';

export type AnyErrorCode = ErrorCode | ClientErrorCode | PendingErrorCode | (string & {});

export class ApiError extends Error {
  readonly status: number;
  readonly code: AnyErrorCode;
  readonly title: string;
  readonly detail: string | null;
  readonly requestId: string | null;
  /** `Retry-After`（秒）；`429`、`503` 没有时按 30 秒（08 P13 #4、§9.2 #19）。 */
  readonly retryAfterSec: number | null;
  readonly problem: ProblemDetails | null;

  constructor(init: {
    status: number;
    code: AnyErrorCode;
    title?: string;
    detail?: string | null;
    requestId?: string | null;
    retryAfterSec?: number | null;
    problem?: ProblemDetails | null;
  }) {
    super(init.detail ?? init.title ?? init.code);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title ?? init.code;
    this.detail = init.detail ?? null;
    this.requestId = init.requestId ?? null;
    this.retryAfterSec = init.retryAfterSec ?? null;
    this.problem = init.problem ?? null;
  }

  get isNetwork(): boolean {
    return this.code === 'NETWORK';
  }

  /** 服务端或网络的暂时性故障：网络错误、5xx（含 UPSTREAM_*）。用于退避与离线判定（P13 #1、#2）。 */
  get isTransient(): boolean {
    return this.isNetwork || this.status >= 500;
  }

  /** 会话状态类冲突：刷新会话视图后按新状态重绘，不弹错误框（08 §4.0）。 */
  get isStateConflict(): boolean {
    return this.code === 'INVALID_STATE' || this.code === 'SESSION_EXPIRING_OR_ENDED' || this.code === 'PRECONDITION_FAILED';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

function isProblem(v: unknown): v is ProblemDetails {
  return !!v && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string' && typeof (v as { status?: unknown }).status === 'number';
}

export function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
}

/** 由非 2xx / 304 的响应构造 ApiError（body 已读出的文本）。 */
export function errorFromResponse(status: number, headers: Headers, bodyText: string): ApiError {
  const retryAfterSec = parseRetryAfter(headers.get('retry-after')) ?? (status === 429 || status === 503 ? 30 : null);
  let body: unknown = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = null;
  }
  if (isProblem(body)) {
    return new ApiError({
      status,
      code: body.code,
      title: body.title,
      detail: body.detail ?? null,
      requestId: body.requestId ?? headers.get('x-request-id'),
      retryAfterSec,
      problem: body,
    });
  }
  const fallbackCode = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN_ROLE' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'INTERNAL' : 'BAD_RESPONSE';
  return new ApiError({ status, code: fallbackCode, title: `HTTP ${status}`, requestId: headers.get('x-request-id'), retryAfterSec });
}

export function networkError(cause: unknown): ApiError {
  const err = new ApiError({ status: 0, code: 'NETWORK', title: 'network error', detail: cause instanceof Error ? cause.message : String(cause) });
  return err;
}
