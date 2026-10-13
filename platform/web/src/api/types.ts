/**
 * 前端用到的响应结构（01 §8.3、02 §13.1）。字段名以 platform/api 当前实现为准（services/sessions/view.ts、routes/platform.ts）；
 * 契约 `@atl/contracts` 的 openapi.yaml 尚未生成（08 §2.6 要求由它生成客户端），这里只声明框架层需要的字段，
 * 其余字段保留为可选，画面实现者按需补充。
 */
import type { BudgetState, CleanupState, CognitoGroup, PlatformMode, ResourceBilling, ResourceSeverity, SessionEventType, SessionState } from '@atl/shared';

/** 会话视图 `allowedActions` 的取值（08 §9.2 #27；API 另返回 `reuse`）。 */
export type AllowedAction = 'cancel' | 'end' | 'end-keep' | 'extend' | 'keep-extend' | 'keep-release' | 'cleanup-retry' | 'reuse';

export interface SessionLimitsView {
  extensionsLeft?: number;
  extensionMinutes?: number;
  extensionMinutesLeft?: number;
  maxDeadlineAt?: string | null;
  keepAllowed?: boolean;
  keepMaxHours?: number;
}

/** `GET /sessions/{sid}`、`GET /sessions/current`（200）、开始 / 结束等返回的会话视图。 */
export interface SessionView {
  sessionId: string;
  labId: string;
  labKind?: 'service' | 'scenario' | null;
  variant?: string;
  trackId?: string | null;
  catalogVersion?: string | null;
  state: SessionState;
  stateReason?: string | null;
  stateEnteredAt?: string;
  ver: number;
  serverNow?: string;
  createdAt: string;
  readyAt?: string | null;
  runningAt?: string | null;
  deadlineAt?: string | null;
  deadlineVersion?: number | null;
  extensions?: unknown[];
  limits?: SessionLimitsView | null;
  keep?: { until?: string | null; hours?: number; saveMode?: boolean } | null;
  outageWindow?: { until?: string | null; channel?: string } | null;
  phases?: { name: string; status: string; startedAt?: string; endedAt?: string }[];
  env?: {
    envId: string;
    envName?: string | null;
    status?: string | null;
    appUrl?: string | null;
    /** 01 是字符串、02 是对象（08 §9.2 #30）：两种写法都接受。 */
    hourlyEstimate?: unknown;
    keepUntil?: string | null;
  } | null;
  allowedActions?: AllowedAction[];
  endReason?: string | null;
  failure?: { code?: string; phase?: string; message?: string; diagnostics?: unknown[] } | null;
  revokedAt?: string | null;
  endedAt?: string | null;
  cleanup?: { deleted?: number; total?: number; manual?: number; hourlyBlocking?: number; status?: string } | null;
  reclaim?: Record<string, unknown> | null;
  progress?: { stepsDone: number; stepsTotal: number; status: string | null };
  resources?: { tracked: number; hourlyBilled: number };
  links?: Record<string, string>;
}

export interface SessionEvent {
  id: string;
  type: SessionEventType | string;
  source?: string;
  at: string;
  data: Record<string, unknown>;
}

/** `GET /sessions/{sid}/events?after=` → `{ events[], next, hasMore, pollAfterMs }`。 */
export interface EventsPage {
  events: SessionEvent[];
  next: string | null;
  hasMore?: boolean;
  pollAfterMs?: number;
}

export interface HeartbeatResult {
  serverNow: string;
  state: SessionState;
  ver: number;
  deadlineAt: string | null;
  deadlineVersion: number | null;
}

export interface MeView {
  sub: string;
  email?: string | null;
  groups: CognitoGroup[] | string[];
  role?: string | null;
  displayName?: string | null;
  certName?: string | null;
  locale?: string;
  notify?: Record<string, boolean>;
  currentTrackId?: string;
  onboarding?: { completedAt?: string | null; version?: string } | null;
}

export interface PlatformView {
  version: string;
  catalogVersion?: string | null;
  region: string;
  drRegion?: string | null;
  /** 只对学员返回完整值（08 §9.2 #3）；界面一律先打码。 */
  accountId?: string | null;
  installationId?: string;
  platformUrl?: string;
  maintenance: boolean;
  mode: PlatformMode;
  limits?: Record<string, unknown> | null;
  allowedInstanceTypes?: string[];
  preflight?: { checkedAt?: string | null; items?: { id: string; status: string; message?: string }[] } | null;
  update?: { latest?: string; notesUrl?: string; templateUrl?: string } | null;
  features?: Record<string, unknown>;
}

export interface GuardrailsView {
  budget: { amount: number | null; enforcement: string; state: BudgetState; stateAt?: string | null; blocksStart?: boolean } | null;
  limits?: Record<string, unknown> | null;
  mode: PlatformMode;
  maintenance: boolean;
  reclaim?: { blockStartOnResidual?: 'ack' | 'block' | 'ignore' } | null;
  uninstalling: boolean;
  serverNow?: string;
}

export interface CatalogView {
  catalogVersion: string;
  indexUrl?: string;
  cardIntroUrlTemplate?: string;
  region?: string;
  drRegion?: string | null;
  [k: string]: unknown;
}

/** `GET /resources/manual` 的条目（01 §7.3 SessionResource 的字段名，兼容 02 §7.9，§9.2 #32）。 */
export interface ManualResource {
  resourceKey: string;
  sessionId?: string;
  labId?: string;
  sessionCreatedAt?: string;
  resourceType: string;
  name?: string | null;
  arn?: string | null;
  region?: string | null;
  cleanupState: CleanupState;
  severity?: ResourceSeverity | null;
  billing?: ResourceBilling | null;
  [k: string]: unknown;
}

export interface ManualResourcesView {
  items: (ManualResource & { envId?: string })[];
  total?: number;
  /** 按小时计费的 BLOCKING 残留条数。 */
  hourlyBlocking?: number;
}

export interface TimeView {
  serverNow: string;
}

export interface PublicHealthView {
  version?: string;
  status?: string;
  [k: string]: unknown;
}
