/**
 * 自动生成的架构图（I6 b）：模型（model.ts）→ 确定性布局（layout.ts）→ SVG（ArchDiagram.tsx）。
 */
export { ArchDiagram, describeState, nodeName, titled } from './ArchDiagram';
export type { ArchDiagramProps, DiagramMode } from './ArchDiagram';
export { buildArchModel, edgesFor, normalizeInput, stateNodeIds } from './model';
export type { ArchInput, ArchModel, ArchState, ArchTarget, EdgeKind, NodeStatus, StateEdge, StateKey, StateNode } from './model';
export { edgePath, layoutArch, routeEdges, SIZE_SPECS } from './layout';
export type { ArchLayout, DiagramSize, LaidLane, LaidNode, SizeSpec } from './layout';
export { FRAME_LANES, FRAME_MODULES, LANE_RANK, LANES, PSEUDO_NODES, SHARED_SLOT, laneOf, rankOf } from './lanes';
export type { LaneId, PseudoNodeId } from './lanes';
export { archInputFromCatalogCard, archInputFromIntro, archInputFromLab } from './adapters';
export type { CardIntroLike, CatalogCardLike, LabYamlLike } from './adapters';
