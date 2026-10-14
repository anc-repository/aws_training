/**
 * 架构图的状态模型（纯函数，I6 b）：由卡片的起始模块（startProfile）与目标模块（targetModules），或任意模块集合，
 * 推出“开始时 / 完成后”两个状态的节点、连线与差异。
 *
 * - 开始时 = ec2 ∪ start ∪ 依赖闭包；完成后 = 开始时 ∪ targets ∪ 依赖闭包。依赖取 registry 的 hard（gen-glyph-registry.mjs）。
 * - 完成后节点状态：new（新增）/ optional（选做目标）/ changed（目标已在开始时存在，只改配置）/ implied（依赖带入）/ present。
 * - 开始时，目标模块若有本地实现（from 不是 none），在它完成后的位置画 ghost（虚线框 + 驱动名，如 sqlite、local）。
 * - 连线规则见 edgesFor()：主请求路径、附着关系（WAF / ACM 挂在 CloudFront 或 ALB 上）、registry 硬依赖补充的虚线。
 *   运维与安全泳道是横切关注点，不画连线。
 * 输出与输入顺序无关（集合排序后处理），同样的输入总得到同样的结果。
 */
import { glyphModule, resolveModuleId } from '../glyphs/data';
import { FRAME_MODULES, LANE_RANK, LANES, laneOf, rankOf } from './lanes';

export interface ArchTarget {
  id: string;
  optional?: boolean;
  /** 目标模块开始时的驱动（本地实现：sqlite、local、nginx …；none 表示没有）。 */
  from?: string | null;
  to?: string | null;
}

export interface ArchInput {
  /** 开始时已启用的模块（startProfile 中 kind: module 的条目）；ec2 总是存在。 */
  start?: readonly string[];
  /** 目标模块（targetModules）；字符串等价于 { id }。 */
  targets?: readonly (string | ArchTarget)[];
  /** 影响连线的选项（例如 CDN_MEDIA_ORIGIN=s3、CDN_ORIGIN_TYPE=alb）。 */
  options?: Readonly<Record<string, string>>;
}

export type NodeStatus = 'present' | 'new' | 'changed' | 'optional' | 'implied' | 'ghost';
export type EdgeKind = 'flow' | 'attach' | 'aux' | 'dep';
export type StateKey = 'before' | 'after';

export interface StateNode {
  id: string;
  status: NodeStatus;
  /** ghost 的标签：开始时的本地驱动名（不翻译）。 */
  local?: string;
}

export interface StateEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** 连到新增 / 选做节点的连线（强调色）。 */
  highlight: boolean;
  /** 连到选做节点（虚线）。 */
  optional: boolean;
}

export interface ArchState {
  key: StateKey;
  nodes: StateNode[];
  edges: StateEdge[];
  /** VPC 边界框（network 模块）。 */
  frame: NodeStatus | null;
}

export interface ArchModel {
  before: ArchState;
  after: ArchState;
  /** 两个状态出现过的全部节点（布局用；含 browser、nginx 与 ghost）。 */
  union: string[];
  added: string[];
  changed: string[];
  optional: string[];
  /** 认不出的 id（不画）。 */
  unknown: string[];
}

const byRank = (a: string, b: string) => {
  const la = laneOf(a);
  const lb = laneOf(b);
  const d = (la ? LANES.indexOf(la) : 99) - (lb ? LANES.indexOf(lb) : 99);
  return d || rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0);
};

function closure(ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const queue = [...out];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const dep of glyphModule(id)?.deps.hard ?? []) {
      if (!out.has(dep)) {
        out.add(dep);
        queue.push(dep);
      }
    }
  }
  return out;
}

const NO_LOCAL = new Set(['none', '']);

export function normalizeInput(input: ArchInput): { start: string[]; targets: ArchTarget[]; unknown: string[] } {
  const unknown = new Set<string>();
  const norm = (raw: string) => {
    const id = resolveModuleId(raw);
    if (!id) unknown.add(raw);
    return id;
  };
  const start = [...new Set((input.start ?? []).map(norm).filter((x): x is string => !!x))].sort(byRank);
  const tmap = new Map<string, ArchTarget>();
  for (const raw of input.targets ?? []) {
    const t = typeof raw === 'string' ? { id: raw } : raw;
    const id = norm(t.id);
    if (!id) continue;
    const prev = tmap.get(id);
    // 同一模块出现多次：只要有一次是必做就算必做
    tmap.set(id, { ...prev, ...t, id, optional: prev ? !!prev.optional && !!t.optional : !!t.optional });
  }
  const targets = [...tmap.values()].sort((a, b) => byRank(a.id, b.id));
  return { start, targets, unknown: [...unknown].sort() };
}

/** 一个状态的连线（确定性：按规则顺序生成，再按 from/to 排序去重）。 */
export function edgesFor(present: ReadonlySet<string>, options: Readonly<Record<string, string>> = {}): Omit<StateEdge, 'highlight' | 'optional'>[] {
  const has = (id: string) => present.has(id);
  const out: Omit<StateEdge, 'highlight' | 'optional'>[] = [];
  const add = (from: string, to: string, kind: EdgeKind) => {
    if (from !== to && has(from) && has(to)) out.push({ from, to, kind });
  };
  const entry = has('load-balancer') ? 'load-balancer' : 'nginx';
  const front = has('cdn') ? 'cdn' : entry;
  // 主请求路径：浏览器 →（CloudFront）→ 入口 → EC2
  add('browser', front, 'flow');
  if (has('cdn')) add('cdn', entry, 'flow');
  if (has('cdn') && options.CDN_MEDIA_ORIGIN === 's3') add('cdn', 'storage', 'flow');
  add(entry, 'ec2', 'flow');
  // 边缘的附着与解析
  const shield = has('cdn') ? 'cdn' : entry;
  add('waf', shield, 'attach');
  add('tls', shield, 'attach');
  add('browser', 'dns', 'aux');
  // 身份
  add('browser', 'auth', 'aux');
  add('browser', 'identity-pool', 'aux');
  add('identity-pool', 'storage', 'flow');
  // 无服务器 API
  add('browser', 'social-api', 'flow');
  add('social-api', 'social-store', 'flow');
  add('social-api', 'auth', 'aux');
  if (has('notification')) add('social-api', 'notification', 'flow');
  else add('social-api', 'queue', 'flow');
  // 计算
  add('autoscaling', 'ec2', 'attach');
  add('scheduler', 'ec2', 'flow');
  // EC2 → 数据与消息
  if (has('db-proxy')) {
    add('ec2', 'db-proxy', 'flow');
    add('db-proxy', 'database', 'flow');
  } else add('ec2', 'database', 'flow');
  for (const d of ['cache', 'storage', 'shared-fs', 'social-store', 'queue', 'notification', 'analytics']) add('ec2', d, 'flow');
  if (!has('notification')) add('ec2', 'email', 'flow');
  add('notification', 'email', 'flow');
  add('notification', 'queue', 'flow');
  add('analytics', 'storage', 'flow');
  // 图片处理流水线
  if (has('queue')) add('queue', 'image-processing', 'flow');
  else add('storage', 'image-processing', 'flow');
  // Lambda 与 Step Functions 两条路径（MUTEX-005：同一时刻只启用其一；选做的另一条也画出来）
  add('ec2', 'workflow', 'flow');
  add('image-processing', 'tagging', 'flow');
  add('workflow', 'tagging', 'flow');
  if (!has('image-processing') && !has('workflow')) add('ec2', 'tagging', 'flow');
  // registry 硬依赖：还没有连线的两个非运维节点之间补一条虚线
  const linked = new Set(out.flatMap((e) => [`${e.from}>${e.to}`, `${e.to}>${e.from}`]));
  for (const id of [...present].sort(byRank)) {
    if (laneOf(id) === 'ops' || !laneOf(id)) continue;
    for (const dep of glyphModule(id)?.deps.hard ?? []) {
      if (has(dep) && laneOf(dep) !== 'ops' && laneOf(dep) && !linked.has(`${id}>${dep}`)) {
        out.push({ from: id, to: dep, kind: 'dep' });
        linked.add(`${id}>${dep}`).add(`${dep}>${id}`);
      }
    }
  }
  const seen = new Set<string>();
  return out
    .filter((e) => {
      const k = `${e.from}>${e.to}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => byRank(a.from, b.from) || byRank(a.to, b.to));
}

function stateOf(
  key: StateKey,
  nodes: StateNode[],
  options: Readonly<Record<string, string>>,
  frame: NodeStatus | null,
): ArchState {
  const drawn = new Set(nodes.filter((n) => n.status !== 'ghost').map((n) => n.id));
  const status = new Map(nodes.map((n) => [n.id, n.status]));
  const edges = edgesFor(drawn, options).map((e) => {
    const a = status.get(e.from);
    const b = status.get(e.to);
    const optional = a === 'optional' || b === 'optional';
    const highlight = key === 'after' && (optional || a === 'new' || b === 'new');
    return { ...e, highlight, optional };
  });
  return { key, nodes, edges, frame };
}

export function buildArchModel(input: ArchInput): ArchModel {
  const { start, targets, unknown } = normalizeInput(input);
  const options = input.options ?? {};
  const before = closure(['ec2', ...start]);
  const required = targets.filter((t) => !t.optional).map((t) => t.id);
  const after = closure([...before, ...required, ...targets.filter((t) => t.optional).map((t) => t.id)]);
  // 选做：不在开始时、也不是必做目标的依赖
  const requiredClosure = closure([...before, ...required]);
  const optional = targets.filter((t) => t.optional && !requiredClosure.has(t.id)).map((t) => t.id);
  const targetIds = new Set(targets.map((t) => t.id));
  const explicitAfter = new Set([...before, ...targetIds]);

  const afterStatus = (id: string): NodeStatus => {
    if (before.has(id)) return targetIds.has(id) ? 'changed' : start.includes(id) || id === 'ec2' ? 'present' : 'implied';
    if (optional.includes(id)) return 'optional';
    if (targetIds.has(id)) return 'new';
    return explicitAfter.has(id) ? 'present' : 'implied';
  };
  const beforeStatus = (id: string): NodeStatus => (start.includes(id) || id === 'ec2' ? 'present' : 'implied');

  const lanesOnly = (ids: Iterable<string>) => [...ids].filter((id) => laneOf(id) !== null);
  const entryNode = (set: Set<string>) => (set.has('load-balancer') ? [] : ['nginx']);

  // 开始时：浏览器、入口（Nginx 或 ALB）、模块；目标模块的本地实现画 ghost（位置被占用时不画）
  const beforeNodes: StateNode[] = [
    { id: 'browser', status: 'present' },
    ...entryNode(before).map((id) => ({ id, status: 'present' as const })),
    ...lanesOnly(before).map((id) => ({ id, status: beforeStatus(id) })),
  ];
  for (const t of targets) {
    if (before.has(t.id) || laneOf(t.id) === null) continue;
    const local = (t.from ?? '').trim();
    const slotTaken = t.id === 'load-balancer' && !before.has('load-balancer');
    if (!NO_LOCAL.has(local) && !slotTaken) beforeNodes.push({ id: t.id, status: 'ghost', local });
  }
  const afterNodes: StateNode[] = [
    { id: 'browser', status: 'present' },
    ...entryNode(after).map((id) => ({ id, status: 'present' as const })),
    ...lanesOnly(after).map((id) => ({ id, status: afterStatus(id) })),
  ];
  const sortNodes = (ns: StateNode[]) => ns.sort((a, b) => byRank(a.id, b.id));
  sortNodes(beforeNodes);
  sortNodes(afterNodes);

  const frameStatus = (set: Set<string>, st: (id: string) => NodeStatus): NodeStatus | null => {
    const id = FRAME_MODULES.find((m) => set.has(m));
    return id ? st(id) : null;
  };
  const union = [...new Set([...beforeNodes, ...afterNodes].map((n) => n.id))].sort(byRank);
  return {
    before: stateOf('before', beforeNodes, options, frameStatus(before, beforeStatus)),
    after: stateOf('after', afterNodes, options, frameStatus(after, afterStatus)),
    union,
    added: [...after].filter((id) => !before.has(id) && !optional.includes(id)).sort(byRank),
    changed: [...before].filter((id) => targetIds.has(id)).sort(byRank),
    optional: [...optional].sort(byRank),
    unknown,
  };
}

/** 读屏摘要用：一个状态里按泳道顺序排列的节点 id（不含 ghost）。 */
export function stateNodeIds(state: ArchState): string[] {
  return state.nodes.filter((n) => n.status !== 'ghost').map((n) => n.id);
}

export { LANE_RANK };
