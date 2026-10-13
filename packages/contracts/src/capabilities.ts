/**
 * `/api/capabilities` response types (modular-design.md §6.1).
 *
 * - 匿名与普通用户看到精简视图；管理员看到完整视图（`data`、`probeHistory`、`checks` 明细）。
 * - `status` 是“这个模块（AWS 实现）”的状态；`off` = 模块未启用、正在使用本地实现（含本地档）。
 *   本地实现自身的健康放在 `localHealth`。ec2 是 base，不会出现 `off`，也不输出 `localHealth`。
 * - `driver` 永远等于开关取值（参数型模块为推导出的驱动名：cdn `direct|cloudfront`、identity-pool `none|cognito`、
 *   autoscaling `single|asg`、social-api `express|apigw`、kms `local|kms`）。
 */
import type {
  BypassKey, CredentialsRequirement, HealthStatus, ModuleId, ModuleStatus, ModuleType,
} from './module-ids.js';
import type { PlatformInfo } from './platform.js';

export const CAPABILITIES_SCHEMA_VERSION = 2;

export type Confidence = 'confirmed' | 'observed' | 'inferred';
export type ProcessRole = 'api' | 'worker' | 'cli';

export interface ValidationFinding {
  rule: string;
  modules: ModuleId[];
  message: string;
  /** 修复命令（管理员视图） */
  fix?: string;
}

export interface CapabilitiesValidation {
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  /** CLOUDALBUM_ALLOW_UNSAFE 降级为警告的规则（前端红色“不安全实验模式”横幅） */
  overridden: ValidationFinding[];
}

export interface ProbeHistoryEntry {
  at: string;
  status: HealthStatus;
  latencyMs?: number;
  detail: string;
}

export interface CapabilityCheck {
  id: string;
  status: HealthStatus;
  detail: string;
}

export interface ModuleCapability {
  driver: string;
  awsService: string;
  type: ModuleType;
  status: ModuleStatus;
  /** 仅在 status=off 时出现：本地实现的健康 */
  localHealth?: HealthStatus;
  detail: string;
  latencyMs?: number;
  confidence?: Confidence;
  since?: string;
  lastProbeAt?: string;
  switch?: { var: string; value: string; localValue: string };
  deps?: { requires: string[]; credentials: CredentialsRequirement; satisfied: boolean };
  bypass?: BypassKey[];
  stats?: Record<string, number>;
  /** 前端需要的公开配置（例如 auth 的 User Pool ID、cdn 的 baseUrl） */
  public?: Record<string, unknown>;
  /** 仅管理员：ARN、端点、计数 */
  data?: Record<string, unknown>;
  /** 仅管理员：最近 20 次探针 */
  probeHistory?: ProbeHistoryEntry[];
  /** ec2 等基础检查项（00-ec2-base.md 第 7 节） */
  checks?: CapabilityCheck[];
}

/** 功能开关：F1–F14 / X1–X30 的子功能，例如 `F6.upload`、`F12.albAuth`、`F14.directUpload`。 */
export type FeatureId = `${'F' | 'X'}${number}.${string}`;

export interface FeatureState {
  enabled: boolean;
  /** 由哪些 `module:driver` 提供 */
  via?: string[];
  reason?: string;
  detail?: string;
}

export interface CapabilitiesApp {
  version: string;
  profile: string;
  deployMode: 'single' | 'asg';
  region: string;
  instance: { id: string; az: string; type: string; role: ProcessRole };
  /** 有效入口 URL：dns > cdn > load-balancer > 基础值 */
  entry: { baseUrl: string; source: 'dns' | 'cdn' | 'load-balancer' | 'base' };
  configHash: string;
  startedAt: string;
  /** ATL 平台模式（06 PM-03）：平台模式开启时出现；公开视图只有 { mode: 'on' } */
  platform?: PlatformInfo;
}

export interface CapabilitiesResponse {
  schemaVersion: typeof CAPABILITIES_SCHEMA_VERSION;
  generatedAt: string;
  /** 'public' = 精简视图；'admin' = 完整视图 */
  view: 'public' | 'admin';
  app: CapabilitiesApp;
  /** “受信 HTTPS”的唯一判定（DEP-029、TLS_FORCE_HTTPS、ALB authenticate-cognito 都用它） */
  https: { trusted: boolean; via: string; hostKind?: 'ip' | 'dns' };
  validation: CapabilitiesValidation;
  modules: Record<ModuleId, ModuleCapability>;
  features: Record<string, FeatureState>;
  lab: { bypassEnabled: boolean; bypassKeys: BypassKey[] };
  /** `?fields=` 投影超过上限时按模块 id 字母序截断（06 PM-03） */
  truncated?: boolean;
  nextModules?: string[];
}

/** SSE `GET /api/capabilities/stream` 推送的状态变化事件（§6.3） */
export interface CapabilityTransitionEvent {
  at: string;
  module: ModuleId;
  from: ModuleStatus | HealthStatus;
  to: ModuleStatus | HealthStatus;
  /** 'status' = 模块（AWS 实现）状态；'localHealth' = 本地实现健康 */
  field: 'status' | 'localHealth';
  detail: string;
  instanceId?: string;
}
