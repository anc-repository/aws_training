/**
 * experiments/_lib/types.ts —— 实验清单（experiment.json）与结果（_results/…json）的类型（总纲 §8.2）。
 * JSON Schema 在 `_lib/schema/experiment.schema.json`、`_lib/schema/result.schema.json`，两者保持一致。
 */
import type { BypassKey, CapabilitiesResponse } from '@cloudalbum/contracts';

/** 对比方式（registry `lab.compare`，总纲 §8.1）。 */
export type ExperimentKind = 'before-after' | 'runtime-ab' | 'functional' | 'fault';

/**
 * 场景工具：
 * - `node`   —— `<module>/<script>.ts`，默认导出 `ScenarioModule`（本实现的主力，不依赖 k6）；
 * - `shell`  —— 在实例上执行 `<module>/<script>.sh`，stdout 最后一行 `EXP-RESULT:<json>` 作为发现；
 * - `manual` —— 手工步骤（见模块 README），运行器只打印指引；
 * - `k6`     —— 仅为兼容总纲 §8.2 的示例而保留在 schema 中，运行器拒绝执行（改写为 node 场景）。
 */
export type ScenarioTool = 'node' | 'shell' | 'manual' | 'k6';

export interface ScenarioSpec {
  tool: ScenarioTool;
  script?: string;
  /** 并发虚拟用户数；`--vus 10,50,200` 时按阶段依次运行 */
  vus?: number;
  /** 测量阶段时长（`60s`、`2m`） */
  duration?: string;
  /** 预热时长（不计入结果、不带实验头） */
  warmup?: string;
  /** 不需要目标服务（例如 auth 的 cloc） */
  offline?: boolean;
  /** shell 场景必须在实例上执行 */
  runsOn?: 'client' | 'instance';
}

/** requires[label] 中的单个断言值：标量或“任选其一”的数组。 */
export type RequireValue = string | number | boolean | null | Array<string | number | boolean | null>;

export interface FaultSpec {
  /** 相对测量阶段开始的时刻：`30s`；`start` = 0；`end` = 场景结束后、采集服务端指标之前 */
  at: string;
  /** 相对模块目录的脚本（`faults/kill-worker.sh`） */
  script?: string;
  args?: string[];
  /** 共享故障注入接口（总纲 §8.4）：POST /api/lab/faults 的请求体 */
  api?: Record<string, unknown>;
  /** 需要人工操作的故障（例如控制台 Revoke sessions）：到点时打印提示 */
  manual?: string;
  /** 只在这些标签下执行 */
  onlyFor?: string[];
  /** 投递方式；缺省按 --fault-via / 环境推断 */
  via?: FaultVia;
  description?: string;
}

export type FaultVia = 'auto' | 'local' | 'ssh' | 'ssm' | 'api' | 'skip';

export type ExpectDirection = 'down' | 'up' | 'flat' | 'up-or-flat' | 'down-or-flat' | 'zero' | 'nonzero';

export interface ExpectSpec {
  metric: string;
  direction: ExpectDirection;
  note?: string;
}

export interface ParamSpec {
  type?: 'string' | 'number' | 'boolean';
  default?: string | number | boolean;
  min?: number;
  max?: number;
  enum?: Array<string | number>;
  description?: string;
}

export interface LabelSpec {
  title?: string;
  role?: 'baseline' | 'treatment' | 'single';
}

/** 结果与运行登记中的变体（06 PM-37；平台模式下原样写回登记响应） */
export interface VariantInfo {
  label: string;
  role?: 'baseline' | 'treatment' | 'single';
  /** 卡片的起始变体（平台模式） */
  cardVariant?: string;
}

export interface ExperimentDef {
  module: string;
  id: string;
  title: string;
  kind: ExperimentKind;
  description?: string;
  requires?: Record<string, Record<string, RequireValue>>;
  labels?: Record<string, LabelSpec>;
  /** 运行时 A/B：`--ab` 时交替带 / 不带 `X-Compare-Bypass: <bypass>` */
  ab?: { bypass: BypassKey; note?: string };
  scenario: ScenarioSpec;
  params?: Record<string, ParamSpec>;
  metrics?: string[];
  faults?: FaultSpec[];
  expect?: ExpectSpec[];
  /** 结束后的清理请求，例如 `DELETE /api/lab/runs/{runId}/photos` */
  cleanup?: string;
  /** 默认对比的两个标签（缺省 before,after；A/B 结果缺省 <label>:A,<label>:B） */
  pair?: [string, string];
  /** 模块文档锚点 */
  doc?: string;
}

/** experiment.json：一个模块的实验清单。也接受总纲 §8.2 示例那样的单个实验对象。 */
export interface ExperimentManifest {
  $schema?: string;
  module: string;
  title?: string;
  default?: string;
  experiments: ExperimentDef[];
}

// ------------------------------------------------------------------------------------- 结果

export interface LatencyStats {
  method?: string;
  route?: string;
  count: number;
  errors: number;
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
  mean?: number;
  ttfbP50?: number;
  ttfbP95?: number;
  bytes?: number;
}

export interface TimingStats {
  /** 出现该项的响应数 */
  count: number;
  p50?: number;
  p95?: number;
  mean?: number;
  /** desc 中 `xN` 的累计（端口调用次数） */
  calls: number;
  callsPerRequest?: number;
  /** desc 值（`redis@elasticache:hit`）→ 次数 */
  descs: Record<string, number>;
}

export interface ClientSlice {
  requests: number;
  errors: number;
  errorRate?: number;
  latencyMs: Record<string, LatencyStats>;
  statusCodes?: Record<string, number>;
  serverTiming?: Record<string, TimingStats>;
  /** 路径签名（去掉 inst / az）→ 次数 */
  paths?: Record<string, number>;
  /** 模块段 outcome 统计：`cache` → { `redis@elasticache:hit`: 12 } */
  outcomes?: Record<string, Record<string, number>>;
}

export interface ClientSummary extends ClientSlice {
  durationMs?: number;
  rps?: number;
  instances?: Record<string, number>;
  xCache?: Record<string, number>;
  byVariant?: Record<string, ClientSlice>;
  byTarget?: Record<string, ClientSlice>;
  byStage?: Record<string, ClientSlice>;
}

export interface ServerRouteStats {
  count: number;
  errors: number;
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
  avg?: number;
}

export interface ServerPortStats extends ServerRouteStats {
  calls: number;
  driver?: string;
  drivers?: Record<string, ServerRouteStats>;
}

export interface HostSummary {
  samples: number;
  cpuP95?: number;
  cpuMax?: number;
  eventLoopDelayP99?: number;
  eventLoopDelayP95?: number;
  netRxBytes?: number;
  netTxBytes?: number;
  rssMaxBytes?: number;
  memUsedRatioMax?: number;
  stealPctMax?: number;
  dataUsedPctMax?: number;
  byRole?: Record<string, { samples: number; cpuP95?: number; eventLoopDelayP99?: number; rssMaxBytes?: number }>;
}

export interface OriginSummary {
  samples: number;
  requests: number;
  bytes: number;
  viaCloudfront: number;
  viaAlb: number;
  direct: number;
}

export interface ServerSection {
  available: boolean;
  error?: string;
  routes: Record<string, ServerRouteStats>;
  paths?: Record<string, ServerRouteStats>;
  ports: Record<string, ServerPortStats>;
  host: HostSummary;
  origin?: OriginSummary;
  /** 业务指标（客户端观测 + 服务端可得的部分），例如 photoTimeToReadyP95、jobsLost */
  business: Record<string, number>;
}

export interface FaultRecord {
  at: string;
  script?: string;
  api?: Record<string, unknown>;
  manual?: string;
  via: string;
  exitCode: number | null;
  skipped?: boolean;
  startedAt?: string;
  durationMs?: number;
  output?: string;
  error?: string;
}

export interface RepeatSummary {
  index: number;
  startedAt: string;
  finishedAt: string;
  client: ClientSlice;
  business?: Record<string, number>;
}

export interface ResultDoc {
  schemaVersion: 1;
  runId: string;
  module: string;
  experiment: string;
  label: string;
  /**
   * 实验变体（06 PM-37）：{ label, role?, cardVariant? }；独立模式只有 label（role 取自 experiment.json labels）。
   * 旧结果文件中是字符串（= label），读取时用 variantLabelOf() 兼容。A/B 时子变体在 client.byVariant。
   */
  variant: VariantInfo | string;
  forced: boolean;
  startedAt: string;
  finishedAt: string;
  target: string;
  params: { vus: number | number[]; duration: string; warmup?: string; repeat: number; ab: boolean; extra?: Record<string, string | number | boolean> };
  environment: {
    profile?: string;
    deployMode?: string;
    instanceType?: string;
    region?: string;
    drivers: Record<string, string>;
    statuses?: Record<string, string>;
    capabilitiesHash: string;
  };
  requiresCheck?: { label: string; ok: boolean; mismatches: RequireMismatch[] };
  spec?: { title: string; kind: ExperimentKind; metrics?: string[]; expect?: ExpectSpec[]; ab?: ExperimentDef['ab'] };
  client: ClientSummary;
  server: ServerSection;
  scenario?: { findings: Record<string, unknown> };
  repeats?: RepeatSummary[];
  faults: FaultRecord[];
  notes: string;
  warnings?: string[];
  runner?: { version: string; node: string; platform: string };
}

export interface RequireMismatch {
  key: string;
  expected: RequireValue;
  actual: unknown;
}

export type Capabilities = CapabilitiesResponse;
