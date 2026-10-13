// backend/src/modules/detectors/types.ts   （纯基础设施型模块的感知器；总纲 §4.2 照录 + 工厂类型）
import type { IncomingHttpHeaders } from 'node:http';
import type { AwsClients } from '../../adapters/aws/clients.js';
import type { AppConfig } from '../../config/schema.js';
import type { ModuleId, ProbeResult } from '../../ports/common.js';

export interface Detector {
  readonly module: ModuleId;
  /** 被动感知：每个请求调用一次，只能做 O(1) 计数，禁止 I/O */
  observe?(req: { headers: IncomingHttpHeaders; remoteAddr: string }): void;
  /** 主动感知：IMDS / 控制面只读 API；无凭证时降为 inferred */
  detect(opts: { deep?: boolean }): Promise<ProbeResult>;
  /** 运行期规则（SEC-*、DEP-018）的输入：最近 5 分钟的观测计数（可选） */
  observations?(): Record<string, unknown>;
}

export interface DetectorContext {
  cfg: AppConfig;
  env: Readonly<Record<string, string>>;
  aws: AwsClients;
}

/** detectors/index.ts 的登记项：container 对每一项调用 create(ctx) */
export interface DetectorFactory {
  readonly module: ModuleId;
  create(ctx: DetectorContext): Detector;
}
