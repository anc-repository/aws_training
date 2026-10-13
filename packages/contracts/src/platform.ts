/**
 * ATL 平台模式下 CloudAlbum 侧的共享契约（docs/platform/06-cloudalbum-platform-mode.md）：
 * `app.platform`（PM-03）、探测令牌与探测端点（PM-09～PM-11）、本机 CLI 的 JSON 输出形状（PM-12～PM-16）。
 * 检查包（platform/checks）与 scripts/module 共用这些名称。
 */

/** capabilities 的 `app.platform`（平台模式开启时出现；公开视图只有 mode） */
export interface PlatformInfo {
  mode: 'on';
  sessionId?: string;
  envId?: string;
  envName?: string;
  labId?: string;
  variant?: string;
  origin?: string;
  release?: string;
  probe?: { localToken: 'present' | 'missing' };
  checkBundle?: { installed: string[]; releaseDigest: string | null };
}

/** 请求头（06 PM-09、PM-10、PM-17、PM-18） */
export const PLATFORM_HEADERS = {
  /** 本机令牌 atlpk1.* 与一次性令牌 atlpt1.* 都放在这里，按前缀区分 */
  probeToken: 'X-ATL-Probe-Token',
  /** 平台 http-header 检查附带的非鉴权 nonce：只把请求标记为探测流量 */
  probeNonce: 'X-ATL-Probe-Nonce',
  /** Nginx 收到的原始 X-Forwarded-For（只在 /api/lab/probe/echo 中读取） */
  receivedXff: 'X-CA-Received-XFF',
} as const;

/** 令牌前缀与格式（PM-09、PM-17） */
export const PROBE_LOCAL_TOKEN_RE = /^atlpk1\.[A-Za-z0-9_-]{43}$/;
export const PROBE_OTP_TOKEN_RE = /^atlpt1\.[A-Za-z0-9_-]{22}\.[0-9]{10}\.[A-Za-z0-9_-]{43}$/;
export const LAB_TOKEN_RE = /^atllt1\.[A-Za-z0-9_-]{22}\.[0-9]{10}\.[A-Za-z0-9_-]{43}$/;
export const PROBE_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** 探测主体 / 实验主体 */
export const ATL_PROBE_PRINCIPAL = 'atl-probe';
export const ATL_LAB_PRINCIPAL = 'atl-lab';

/** 探测端点（PM-11） */
export const PROBE_ENDPOINTS = ['now', 'echo', 'media-url', 'auth', 'identity-pool', 'kms'] as const;
export type ProbeEndpoint = (typeof PROBE_ENDPOINTS)[number];

/** 新增端点与 CLI 的错误体（06 §1.5 第 4、5 条） */
export interface PlatformErrorBody { error: { code: string; message: string } }

/** `cloudalbum platform-status --json`（PM-02） */
export interface PlatformStatus {
  schema: 'cloudalbum.platform-status/v1';
  platformMode: 'on' | 'off';
  platformEnv: { present: boolean; valid: boolean; errors: string[] };
  probeToken: { present: boolean };
  admin: { present: boolean | null };
  checkBundle: { installed: string[]; releaseDigest: string | null };
  ssmAgent: { version: string | null; meetsMinimum: boolean | null };
  services: { api: string; worker: string; nginx: string };
  dataVolumeMounted: boolean | null;
  session: { sessionId: string | null; labId: string | null; envName: string | null };
}

/** `cloudalbum lab-metrics --run <runId> --json`（PM-14） */
export interface LabMetricsRun {
  schema: 'cloudalbum.lab-metrics-run/v1';
  runId: string;
  registered: { module: string; experiment: string; label: string; startedAt: string; windowSec: number; variant?: unknown };
  window: { from: string; to: string; padSec: number };
  open?: boolean;
  app: {
    requests: number;
    byTarget: { direct: number; cdn: number; alb: number; apigw: number };
    byStatus: { '2xx': number; '4xx': number; '5xx': number };
    pathSignatures: Array<{ signature: string; count: number }>;
    routes: Record<string, { count: number; p50: number; p95: number }>;
  };
  origin: {
    source: 'nginx-access-log';
    requests: number;
    byPort: Record<string, number>;
    viaCloudfront: number;
    viaAlb: number;
  };
  host: { cpuP95: number; netTxBytes: number; netRxBytes: number };
  excludedProbeRequests: number;
}

/** `cloudalbum module-state --json`（PM-15）；/etc/cloudalbum/modules.state.json 的格式 */
export interface ModuleStateFile {
  modules: Record<string, { enabled: boolean; driver: string; version: number; enabledAt: string }>;
  history: Array<{ opId: string; op: string; module: string; at: string; operator: string; profile?: string }>;
  pending: { opId: string; module: string; op: string; startedAt: string } | null;
}

/** `path-seen` 的结果（PM-16） */
export interface PathSeenResult {
  count: number;
  distinctValues: string[];
  firstTs: string | null;
  lastTs: string | null;
  samples: Array<{ ts: string; route: string; value: string }>;
}

/** 测试数据种子登记表（06 §11 PM-43） */
export const SEED_IDS = ['cognito-test-users', 'gps-sample-photos'] as const;
export type SeedId = (typeof SEED_IDS)[number];
export function isSeedId(x: string): x is SeedId {
  return (SEED_IDS as readonly string[]).includes(x);
}
export const SEED_TEST_USERS = ['atl-test-1', 'atl-test-2', 'atl-test-3'] as const;

/** 保留域名（PM-46）：这些地址不真正发信 */
export function isReservedEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  const domain = (at === -1 ? email : email.slice(at + 1)).trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return false;
  return /(^|\.)example\.(com|net|org)$/.test(domain) || /(^|\.)(example|invalid|test|localhost)$/.test(domain);
}
