/**
 * Types for `modules/registry.yaml` (modular-design.md §3.4, §3.5). The JSON Schema lives in
 * `modules/registry.schema.json`; `scripts/registry/build.ts` validates the YAML against it and
 * inlines the result into `src/generated/registry.ts` (import it via `@cloudalbum/contracts/registry`).
 */
import type { BypassKey, CredentialsRequirement, ModuleGroup, ModuleId, ModuleType } from './module-ids.js';

/** 枚举型开关：`values[0]` = 本地实现 = 默认 */
export interface EnumSwitch {
  var: string;
  values: string[];
  /** 写 `MODULE_<ID>=on` 的取值（本模块负责的 AWS 取值） */
  ownedValues: string[];
  /** 不需要 AWS 资源的中间档 */
  localTiers: string[];
  kind?: undefined;
}

/** 参数型开关：空 = 本地驱动，非空 = AWS 驱动 */
export interface ParamSwitch {
  var: string;
  kind: 'param';
}

export type ModuleSwitch = EnumSwitch | ParamSwitch;

export function isParamSwitch(s: ModuleSwitch): s is ParamSwitch {
  return (s as ParamSwitch).kind === 'param';
}

/** `when` 只能引用 env 变量：`{ VAR: value }`（全部相等时触发）。 */
export type WhenClause = Record<string, string>;

/**
 * 依赖表达式（§5.1）。`need` 中每一项：模块 id、`a | b`（任选其一）、`VAR=value`、`VAR!=value`、
 * `VAR!=`（非空）、`VAR=`（为空）、`VAR!=loopback` / `VAR=loopback`（主机部分是否为回环地址）。
 */
export interface RequireExpr {
  rule: string;
  when?: WhenClause;
  need: string[];
  severity?: 'error' | 'warn';
}

export interface ConflictExpr {
  rule: string;
  /** 与另一个模块互斥（两者同时启用即违规） */
  module?: ModuleId;
  when?: WhenClause;
  need?: string[];
}

export interface StackDecl {
  name: string;
  template: string;
  region?: string;
  /** 模块 id 表达式（如 `cdn`、`load-balancer | social-api`）或 `{ VAR: value }` */
  when?: string | WhenClause;
}

export interface InjectDecl {
  target: ModuleId | '*';
  stack?: string;
  params: Record<string, string>;
  when?: WhenClause;
}

export type BaseParamValue = string | { value: string; when: WhenClause };

export interface InternalEndpointDecl {
  path: string;
  exposure: 'public-hmac' | 'vpc-hmac';
  secret: string;
  when?: WhenClause;
}

export interface AuxQueueDecl {
  name: string;
  purpose: string;
}

export interface SelfHostedDecl {
  driver: string;
  installer: string;
  /** 例如 `{ REDIS_URL: loopback }`：命中时视为本地档，CFG-004 豁免 */
  match: Record<string, string>;
}

export interface ProbeDecl {
  kind: 'active' | 'passive' | 'detector' | string;
  method?: string;
  intervalSec?: number;
  [k: string]: unknown;
}

export interface BillingDecl {
  resource: string;
  dimension: 'hour' | 'usage' | 'request';
  hourly?: boolean;
}

export interface LabDecl {
  summary?: { local?: string; aws?: string; [k: string]: string | undefined };
  compare?: 'runtime-ab' | 'before-after' | 'functional' | 'fault' | string;
  sideBySide?: boolean;
  keyMetrics?: string[];
  hourlyBilled?: boolean;
  diagram?: { before?: string; after?: string };
  experiments?: string[];
  badges?: Record<string, unknown>;
}

export interface RegistryModule {
  group: ModuleGroup;
  function: string;
  awsService: string;
  auxServices: string[];
  type: ModuleType;
  /** 端口名；参数型 / 纯基础设施型可省略或为 null */
  port?: string | null;
  switch?: ModuleSwitch;
  ownsEnv?: string[];
  credentials: CredentialsRequirement;
  prerequisites?: string[];
  requires?: RequireExpr[];
  soft?: ModuleId[];
  conflicts?: ConflictExpr[];
  orderBefore?: ModuleId[];
  authoritative?: boolean;
  multiInstanceSafe?: Record<string, boolean>;
  bypass?: BypassKey[];
  stacks: StackDecl[];
  secretParams?: string[];
  baseParams?: Record<string, BaseParamValue>;
  injects?: InjectDecl[];
  internalEndpoints?: InternalEndpointDecl[];
  auxQueues?: AuxQueueDecl[];
  nginxFragments?: string[];
  systemdDropIns?: string[];
  cwAgentFragment?: string;
  hostSetup?: string;
  preflight?: string[];
  selfHosted?: SelfHostedDecl;
  probe?: ProbeDecl;
  detector?: string;
  migration?: string | null;
  billing?: BillingDecl[];
  lab: LabDecl;
  doc: string;
  /** 写入栈 Outputs，与 env 中的 `MODULE_<ID>_VERSION` 比对（CFG-006）；缺省视为 1 */
  version?: number;
}

export interface RegistryDocument {
  version: number;
  modules: Record<ModuleId, RegistryModule>;
}
