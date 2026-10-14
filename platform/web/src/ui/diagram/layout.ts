/**
 * 架构图的确定性布局（纯函数，I6 b）：分层泳道，自左向右为 客户端 → 边缘 → 入口 → 计算 → 数据与消息 → 运维与安全。
 *
 * - 布局按两个状态的并集（ArchModel.union）计算，“开始时 / 完成后”两张图共用同一套坐标，差异一眼可见；
 * - 并集中没有节点的泳道折叠；泳道内按 LANE_RANK 自上而下排，超过 maxRows 时按列折行（列优先）；
 * - load-balancer 与 nginx 共用入口主位置（SHARED_SLOT）；
 * - 坐标只取决于输入集合，整数像素，便于快照测试。
 */
import { FRAME_LANES, LANE_RANK, LANES, SHARED_SLOT, laneOf, type LaneId } from './lanes';
import type { ArchModel, StateEdge } from './model';

export type DiagramSize = 'mini' | 'full';

export interface SizeSpec {
  colW: number;
  rowH: number;
  glyph: number;
  padX: number;
  padTop: number;
  padBottom: number;
  maxRows: number;
  /** 泳道标题高度（mini 没有标题）。 */
  header: number;
  laneGap: number;
}

export const SIZE_SPECS: Readonly<Record<DiagramSize, SizeSpec>> = {
  full: { colW: 120, rowH: 76, glyph: 36, padX: 8, padTop: 14, padBottom: 6, maxRows: 6, header: 30, laneGap: 4 },
  mini: { colW: 30, rowH: 26, glyph: 18, padX: 4, padTop: 5, padBottom: 5, maxRows: 4, header: 0, laneGap: 2 },
};

export interface LaidLane {
  id: LaneId;
  /** 左边界与宽度（含泳道内的多列）。 */
  x: number;
  width: number;
  cols: number;
}

export interface LaidNode {
  id: string;
  lane: LaneId;
  /** 全局列号（折叠后的泳道、泳道内的子列）。 */
  col: number;
  row: number;
  /** 图标中心。 */
  cx: number;
  cy: number;
}

export interface ArchLayout {
  size: DiagramSize;
  spec: SizeSpec;
  width: number;
  height: number;
  lanes: LaidLane[];
  nodes: Record<string, LaidNode>;
  /** VPC 边界框（并集中有 network 时）。 */
  frame: { x: number; y: number; width: number; height: number } | null;
}

export function layoutArch(model: ArchModel, size: DiagramSize): ArchLayout {
  const spec = SIZE_SPECS[size];
  const ids = new Set(model.union);
  // 共用位置：nginx 与 load-balancer 只占一个格
  const slots = new Map<LaneId, string[]>();
  for (const lane of LANES) {
    const inLane = LANE_RANK[lane].filter((id) => ids.has(id) && !(SHARED_SLOT[id] && ids.has(SHARED_SLOT[id])));
    if (inLane.length) slots.set(lane, inLane);
  }
  const usedLanes = LANES.filter((l) => slots.has(l));
  const rowsUsed = Math.max(1, ...usedLanes.map((l) => Math.min(spec.maxRows, (slots.get(l) ?? []).length)));

  const lanes: LaidLane[] = [];
  const nodes: Record<string, LaidNode> = {};
  let x = spec.padX;
  let col = 0;
  for (const lane of usedLanes) {
    const list = slots.get(lane) ?? [];
    const cols = Math.ceil(list.length / spec.maxRows);
    const width = cols * spec.colW;
    lanes.push({ id: lane, x, width, cols });
    list.forEach((id, i) => {
      const sub = Math.floor(i / spec.maxRows);
      const row = i % spec.maxRows;
      const n: LaidNode = {
        id,
        lane,
        col: col + sub,
        row,
        cx: Math.round(x + sub * spec.colW + spec.colW / 2),
        cy: Math.round(spec.header + spec.padTop + row * spec.rowH + spec.glyph / 2),
      };
      nodes[id] = n;
      const shared = Object.keys(SHARED_SLOT).find((k) => SHARED_SLOT[k] === id);
      if (shared && ids.has(shared)) nodes[shared] = { ...n, id: shared };
    });
    x += width + spec.laneGap;
    col += cols;
  }
  const width = Math.round(x - spec.laneGap + spec.padX);
  let height = Math.round(spec.header + spec.padTop + (rowsUsed - 1) * spec.rowH + spec.glyph + (size === 'full' ? 22 : 0) + spec.padBottom);
  // 同一行跨两列以上的连线向下弓（routeEdges 的 bow，贝塞尔最低点约为 0.75 × bow）：最下一行也有这样的连线时，图要留出空间，
  // 否则弧线被 SVG 裁掉（例如 svc-storage 的 浏览器 → S3 直传）
  const bowDepth = spec.rowH * (size === 'full' ? 0.85 : 0.65) * 0.75 + (size === 'full' ? 4 : 2);
  for (const e of [...model.before.edges, ...model.after.edges]) {
    const a = nodes[e.from];
    const b = nodes[e.to];
    if (a && b && a.row === b.row && Math.abs(a.col - b.col) > 1) height = Math.max(height, Math.ceil(a.cy + bowDepth + spec.padBottom));
  }

  let frame: ArchLayout['frame'] = null;
  if (model.union.includes('network') || model.before.frame || model.after.frame) {
    const inFrame = lanes.filter((l) => FRAME_LANES.includes(l.id));
    if (inFrame.length) {
      const first = inFrame[0];
      const last = inFrame[inFrame.length - 1];
      const inset = size === 'full' ? 2 : 1;
      frame = {
        x: first.x + inset,
        y: spec.header + inset,
        width: last.x + last.width - first.x - inset * 2,
        height: height - spec.header - inset * 2,
      };
    }
  }
  return { size, spec, width, height, lanes, nodes, frame };
}

/**
 * 连线的路径（三次贝塞尔，水平切线），一次算一个状态的全部连线：
 * - 向右：源的右侧 → 目标的左侧；向左（回流）：源的左侧 → 目标的右侧；
 * - 同一节点同一侧有多条连线时按对端的纵坐标错开端口（扇出不挤在一个点上）；
 * - 同列：相邻两行画竖线（full 从标签下方起止，不穿过标签）；不相邻时从右侧绕弧，避免穿过中间的节点；
 * - 跨两列以上且同一行：向下弓到两行之间的空隙，避免穿过中间格位（含 ghost）与主路径重叠。
 */
export function routeEdges(layout: ArchLayout, edges: readonly Pick<StateEdge, 'from' | 'to'>[]): Record<string, string> {
  const full = layout.size === 'full';
  const g = layout.spec.glyph;
  const r = g / 2 + (full ? 4 : 2);
  const below = full ? g / 2 + 23 : r;
  const f = (n: number) => Math.round(n * 10) / 10;
  type Kind = 'h' | 'vadj' | 'varc';
  const kinds = new Map<string, Kind>();
  const ports = new Map<string, { cy: number; list: { key: string; end: 'a' | 'b'; y: number; x: number }[] }>();
  const addPort = (node: string, side: string, key: string, end: 'a' | 'b', other: LaidNode) => {
    const k = `${node}|${side}`;
    const entry = ports.get(k) ?? { cy: layout.nodes[node].cy, list: [] };
    entry.list.push({ key, end, y: other.cy, x: other.cx });
    ports.set(k, entry);
  };
  for (const e of edges) {
    const a = layout.nodes[e.from];
    const b = layout.nodes[e.to];
    if (!a || !b) continue;
    const key = `${e.from}>${e.to}`;
    if (a.col === b.col) {
      const kind: Kind = Math.abs(a.row - b.row) === 1 ? 'vadj' : 'varc';
      kinds.set(key, kind);
      if (kind === 'varc') {
        addPort(e.from, 'R', key, 'a', b);
        addPort(e.to, 'R', key, 'b', a);
      }
    } else {
      kinds.set(key, 'h');
      const dir = b.col > a.col;
      addPort(e.from, dir ? 'R' : 'L', key, 'a', b);
      addPort(e.to, dir ? 'L' : 'R', key, 'b', a);
    }
  }
  const offset = new Map<string, number>();
  const step = full ? 7 : 2.5;
  const limit = g / 2 - (full ? 4 : 2);
  // 与本节点同一行的连线（主路径）保持在中心；上方的往上、下方的往下依次错开
  for (const { cy, list } of ports.values()) {
    list.sort((p, q) => p.y - q.y || p.x - q.x || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
    const same = list.filter((p) => p.y === cy);
    const above = list.filter((p) => p.y < cy).reverse();
    const below = list.filter((p) => p.y > cy);
    const hasCenter = same.length > 0;
    const sideMax = Math.max(above.length, below.length) + (same.length > 1 ? same.length - 1 : 0);
    const st = sideMax ? Math.min(step, limit / sideMax) : 0;
    same.forEach((p, i) => offset.set(`${p.key}|${p.end}`, i * st));
    const sameExtra = Math.max(0, same.length - 1);
    above.forEach((p, i) => offset.set(`${p.key}|${p.end}`, -(i + (hasCenter ? 1 : 0.5)) * st));
    below.forEach((p, i) => offset.set(`${p.key}|${p.end}`, (i + sameExtra + (hasCenter ? 1 : 0.5)) * st));
  }
  const out: Record<string, string> = {};
  for (const e of edges) {
    const a = layout.nodes[e.from];
    const b = layout.nodes[e.to];
    const key = `${e.from}>${e.to}`;
    const kind = kinds.get(key);
    if (!a || !b || !kind) continue;
    if (kind === 'vadj') {
      const down = b.row > a.row;
      out[key] = down ? `M${f(a.cx)} ${f(a.cy + below)}V${f(b.cy - r)}` : `M${f(a.cx)} ${f(a.cy - r)}V${f(b.cy + below)}`;
      continue;
    }
    const ya = a.cy + (offset.get(`${key}|a`) ?? 0);
    const yb = b.cy + (offset.get(`${key}|b`) ?? 0);
    if (kind === 'varc') {
      const x = a.cx + r;
      const k = layout.spec.colW * 0.3;
      out[key] = `M${f(x)} ${f(ya)}C${f(x + k)} ${f(ya)} ${f(x + k)} ${f(yb)} ${f(x)} ${f(yb)}`;
      continue;
    }
    const dir = b.col > a.col ? 1 : -1;
    const x1 = a.cx + dir * r;
    const x2 = b.cx - dir * r;
    const dx = Math.abs(x2 - x1);
    const bow = a.row === b.row && Math.abs(b.col - a.col) > 1 ? layout.spec.rowH * (full ? 0.85 : 0.65) : 0;
    const c = bow ? 0.3 : 0.5;
    out[key] = `M${f(x1)} ${f(ya)}C${f(x1 + dir * dx * c)} ${f(ya + bow)} ${f(x2 - dir * dx * c)} ${f(yb + bow)} ${f(x2)} ${f(yb)}`;
  }
  return out;
}

/** 单条连线的路径（不考虑端口错开；整张图请用 routeEdges）。 */
export function edgePath(layout: ArchLayout, edge: Pick<StateEdge, 'from' | 'to'>): string | null {
  return routeEdges(layout, [edge])[`${edge.from}>${edge.to}`] ?? null;
}

/** 节点所在泳道（ghost 与共用位置的节点也能查到）。 */
export function laneOfNode(layout: ArchLayout, id: string): LaneId | null {
  return layout.nodes[id]?.lane ?? laneOf(id);
}
