/**
 * 架构图的分层泳道（I6 b）：客户端 → 边缘 → 入口 → 计算 → 数据与消息 → 运维与安全。
 *
 * 每个模块固定落在一条泳道、泳道内的先后顺序固定（RANK），布局因此是确定的。network（VPC）不占泳道，
 * 画成包住“入口～数据”三条泳道的边界框。nginx（EC2 上的 Nginx）与 load-balancer（ALB）共用入口的主位置：
 * 同一个状态里入口是 ALB 就不画 Nginx（registry：LB_MODE=nginx 是本地实现）。
 */
export type LaneId = 'client' | 'edge' | 'entry' | 'compute' | 'data' | 'ops';

export const LANES: readonly LaneId[] = ['client', 'edge', 'entry', 'compute', 'data', 'ops'];

/** 非模块节点。 */
export type PseudoNodeId = 'browser' | 'nginx';
export const PSEUDO_NODES: readonly PseudoNodeId[] = ['browser', 'nginx'];

/** 每条泳道内自上而下的顺序（主请求路径放在第 0 行：浏览器 → CloudFront → 入口 → EC2 → 第一个数据服务）。 */
export const LANE_RANK: Readonly<Record<LaneId, readonly string[]>> = {
  client: ['browser'],
  edge: ['cdn', 'waf', 'tls', 'dns'],
  entry: ['nginx', 'load-balancer', 'social-api', 'auth', 'identity-pool'],
  compute: ['ec2', 'autoscaling', 'scheduler', 'image-processing', 'workflow', 'tagging'],
  data: ['db-proxy', 'database', 'cache', 'storage', 'shared-fs', 'social-store', 'queue', 'notification', 'email', 'analytics'],
  ops: ['iam', 'secrets', 'kms', 'config', 'shell-access', 'logging', 'monitoring', 'tracing', 'audit', 'threat-detection', 'compliance', 'vuln-scan', 'backup', 'cost', 'ami'],
};

/** 画成边界框而不是节点的模块。 */
export const FRAME_MODULES: readonly string[] = ['network'];
/** VPC 边界框包住的泳道。 */
export const FRAME_LANES: readonly LaneId[] = ['entry', 'compute', 'data'];

/** 共用同一个位置的节点（同一状态里最多出现其一）。 */
export const SHARED_SLOT: Readonly<Record<string, string>> = { 'load-balancer': 'nginx' };

const LANE_OF_NODE: ReadonlyMap<string, LaneId> = new Map(LANES.flatMap((lane) => LANE_RANK[lane].map((id) => [id, lane] as const)));

export function laneOf(id: string): LaneId | null {
  return LANE_OF_NODE.get(id) ?? null;
}

export function rankOf(id: string): number {
  const lane = laneOf(id);
  return lane ? LANE_RANK[lane].indexOf(id) : Number.MAX_SAFE_INTEGER;
}
