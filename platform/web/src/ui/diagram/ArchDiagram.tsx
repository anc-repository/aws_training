/**
 * <ArchDiagram>：根据卡片的 startProfile / targetModules（或任意模块集合）自动画“开始时 → 完成后”架构图（I6 b）。
 *
 * - size="full"：泳道标题 + 图标 + 短标签（产品名不翻译，浏览器等走 i18n 键）；默认 mode="pair"（两张图左右并排，窄屏上下排列）。
 *   fit="scroll"（默认）时每张图在自己的横向滚动容器里（页面本身不横向滚动）；fit="scale" 时按容器宽度缩放。
 * - size="mini"：卡片缩略图，只有图标与连线，默认 mode="after"（新增服务用强调色圈出）。
 * - 纯 SVG；颜色只来自 token 类（亮暗主题都可读），不写 style 属性（CSP style-src 'self'）。
 * - 可访问性：每张图 role="img" + <title>/<desc>（各泳道的服务与新增服务的文字摘要）；decorative 时 aria-hidden。
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { MOTIFS, PSEUDO_MOTIFS } from '../glyphs/motifs';
import { glyphModule, groupClass } from '../glyphs/data';
import { useVisualI18n, type VisualI18n, type VisualKey } from '../glyphs/visualI18n';
import { layoutArch, routeEdges, type ArchLayout, type DiagramSize } from './layout';
import { buildArchModel, stateNodeIds, type ArchInput, type ArchModel, type ArchState, type NodeStatus, type StateKey } from './model';
import '../glyphs/glyphs.css';
import './diagram.css';

export type DiagramMode = 'pair' | 'before' | 'after';

export interface ArchDiagramProps {
  /** 起始模块与目标模块（adapters.ts 可以从目录卡片、简介页数据或 lab.yaml 生成）。 */
  input?: ArchInput;
  /** 已经算好的模型（与 input 二选一）。 */
  model?: ArchModel;
  size?: DiagramSize;
  mode?: DiagramMode;
  /** 可访问标题（默认“构成图 / Architecture / 架构图”）。 */
  title?: string;
  /** 卡片里旁边已有文字说明时设为 true（aria-hidden）。 */
  decorative?: boolean;
  fit?: 'scroll' | 'scale';
  /** 显示图例（full 默认显示）。 */
  legend?: boolean;
  className?: string;
}

export function nodeName(id: string, i18n: Pick<VisualI18n, 't'>): string {
  if (id === 'browser') return i18n.t('visual.node.browser');
  if (id === 'nginx') return 'Nginx';
  return glyphModule(id)?.short ?? id;
}

/** 读屏摘要：“完成后：浏览器、CloudFront、Nginx、EC2、IAM。追加：CloudFront”。 */
export function describeState(model: ArchModel, key: StateKey, i18n: VisualI18n): string {
  const state = model[key];
  const names = stateNodeIds(state).map((id) => nodeName(id, i18n));
  if (state.frame && state.frame !== 'ghost') names.push('VPC');
  const parts = [i18n.t('visual.diagram.state', { state: i18n.t(`visual.diagram.${key}`), nodes: i18n.list(names) })];
  if (key === 'after') {
    const added = [...model.added, ...model.optional];
    parts.push(added.length ? i18n.t('visual.diagram.added', { nodes: i18n.list(added.map((id) => nodeName(id, i18n))) }) : i18n.t('visual.diagram.noChange'));
  }
  return parts.join(i18n.lang === 'en' ? '. ' : '。');
}

/** “标题（开始时）”/“Title (At start)”。 */
export function titled(i18n: VisualI18n, title: string, key: StateKey): string {
  const state = i18n.t(`visual.diagram.${key}`);
  return i18n.lang === 'en' ? `${title} (${state})` : `${title}（${state}）`;
}

const HL: ReadonlySet<NodeStatus> = new Set(['new', 'optional', 'changed']);

function GlyphAt({ id, cx, cy, size, ghost }: { id: string; cx: number; cy: number; size: number; ghost?: boolean }): ReactElement {
  const pseudo = id === 'browser' || id === 'nginx';
  const mod = glyphModule(id);
  const motif = pseudo ? PSEUDO_MOTIFS[id as 'browser' | 'nginx'] : mod ? MOTIFS[mod.id] : null;
  const cls = ['sg', pseudo ? 'pseudo' : groupClass(mod?.group), ghost ? 'ghost' : ''].filter(Boolean).join(' ');
  const s = size / 24;
  return (
    <g className={cls} transform={`translate(${cx - size / 2} ${cy - size / 2}) scale(${s})`}>
      <rect className="sg-tile" x=".5" y=".5" width="23" height="23" rx="5" />
      {motif ? <g className="sg-motif">{motif}</g> : null}
    </g>
  );
}

interface PanelProps {
  model: ArchModel;
  layout: ArchLayout;
  stateKey: StateKey;
  title: string;
  decorative?: boolean;
  i18n: VisualI18n;
  uid: string;
}

function DiagramSvg({ model, layout, stateKey, title, decorative, i18n, uid }: PanelProps) {
  const state: ArchState = model[stateKey];
  const full = layout.size === 'full';
  const { spec } = layout;
  const g = spec.glyph;
  const tid = `${uid}-${stateKey}-t`;
  const did = `${uid}-${stateKey}-d`;
  const mk = `${uid}-${stateKey}-m`;
  const desc = describeState(model, stateKey, i18n);
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-labelledby': `${tid} ${did}` };
  const ringPad = full ? 4 : 2.5;
  const paths = routeEdges(layout, state.edges);
  return (
    <svg
      className={`arch-svg ${layout.size}`}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      focusable="false"
      data-state={stateKey}
      {...a11y}
    >
      {decorative ? null : (
        <>
          <title id={tid}>{titled(i18n, title, stateKey)}</title>
          <desc id={did}>{desc}</desc>
        </>
      )}
      <defs>
        <marker id={`${mk}-n`} viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth={full ? 7 : 4} markerHeight={full ? 7 : 4} orient="auto-start-reverse">
          <path className="am" d="M0 0L8 4L0 8z" />
        </marker>
        <marker id={`${mk}-h`} viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth={full ? 8 : 4.5} markerHeight={full ? 8 : 4.5} orient="auto-start-reverse">
          <path className="am hl" d="M0 0L8 4L0 8z" />
        </marker>
      </defs>
      {layout.lanes.map((lane, i) => (
        <g key={lane.id} className="al" data-lane={lane.id}>
          <rect className={i % 2 ? 'al-bg odd' : 'al-bg'} x={lane.x} y={0} width={lane.width} height={layout.height} rx={full ? 6 : 3} />
          {full ? (
            <text className="al-title" x={lane.x + lane.width / 2} y={19} textAnchor="middle">
              {i18n.t(`visual.lane.${lane.id}` as VisualKey)}
            </text>
          ) : null}
        </g>
      ))}
      {layout.frame && state.frame ? (
        <g className={`af st-${state.frame}`}>
          <rect x={layout.frame.x} y={layout.frame.y} width={layout.frame.width} height={layout.frame.height} rx={full ? 8 : 4} />
          {full ? (
            <g>
              <GlyphAt id="network" cx={layout.frame.x + 12} cy={layout.frame.y + 2} size={16} />
              <text className="af-label" x={layout.frame.x + 24} y={layout.frame.y + 6}>
                VPC
              </text>
            </g>
          ) : null}
        </g>
      ) : null}
      <g className="ae-layer">
        {state.edges.map((e) => {
          const d = paths[`${e.from}>${e.to}`];
          if (!d) return null;
          const arrow = e.kind === 'flow' || e.kind === 'aux';
          const cls = ['ae', e.kind, e.highlight ? 'hl' : '', e.optional ? 'opt' : ''].filter(Boolean).join(' ');
          return <path key={`${e.from}>${e.to}`} className={cls} d={d} markerEnd={arrow ? `url(#${mk}-${e.highlight ? 'h' : 'n'})` : undefined} data-edge={`${e.from}>${e.to}`} />;
        })}
      </g>
      {state.nodes.map((n) => {
        const p = layout.nodes[n.id];
        if (!p) return null;
        const ghost = n.status === 'ghost';
        const label = ghost ? (n.local ?? '') : nodeName(n.id, i18n);
        return (
          <g key={n.id} className={`an st-${n.status}`} data-node={n.id}>
            {full && ghost ? <title>{`${i18n.t('visual.diagram.local')}: ${n.local ?? ''}`}</title> : null}
            {HL.has(n.status) || n.status === 'implied' ? (
              <rect className="an-ring" x={p.cx - g / 2 - ringPad} y={p.cy - g / 2 - ringPad} width={g + ringPad * 2} height={g + ringPad * 2} rx={full ? 9 : 5} />
            ) : null}
            {ghost ? (
              <g className="an-ghost">
                <rect x={p.cx - g / 2 + 0.5} y={p.cy - g / 2 + 0.5} width={g - 1} height={g - 1} rx={full ? 7 : 4} />
                {full ? <path d={`M${p.cx - 8} ${p.cy - 5}h16M${p.cx - 8} ${p.cy}h16M${p.cx - 8} ${p.cy + 5}h10`} /> : null}
              </g>
            ) : (
              <GlyphAt id={n.id} cx={p.cx} cy={p.cy} size={g} />
            )}
            {n.status === 'new' && full ? (
              <g className="an-badge">
                <circle cx={p.cx + g / 2} cy={p.cy - g / 2} r={7} />
                <path d={`M${p.cx + g / 2 - 3.5} ${p.cy - g / 2}h7M${p.cx + g / 2} ${p.cy - g / 2 - 3.5}v7`} />
              </g>
            ) : null}
            {full ? (
              <text className={ghost ? 'an-label local' : 'an-label'} x={p.cx} y={p.cy + g / 2 + 16} textAnchor="middle">
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

const LEGEND_ITEMS: readonly { key: string; status: NodeStatus | 'ghost'; text: VisualKey }[] = [
  { key: 'new', status: 'new', text: 'visual.diagram.new' },
  { key: 'changed', status: 'changed', text: 'visual.diagram.changed' },
  { key: 'optional', status: 'optional', text: 'visual.diagram.optional' },
  { key: 'implied', status: 'implied', text: 'visual.diagram.implied' },
  { key: 'ghost', status: 'ghost', text: 'visual.diagram.local' },
];

function Legend({ model, mode, i18n }: { model: ArchModel; mode: DiagramMode; i18n: VisualI18n }) {
  const shown = new Set<string>();
  if (mode !== 'before') {
    for (const n of model.after.nodes) shown.add(n.status);
    if (model.after.frame) shown.add(model.after.frame);
  }
  if (mode !== 'after') for (const n of model.before.nodes) if (n.status === 'ghost' || n.status === 'implied') shown.add(n.status);
  const items = LEGEND_ITEMS.filter((it) => shown.has(it.status));
  if (!items.length) return null;
  return (
    <ul className="arch-legend" aria-label={i18n.t('visual.diagram.legend')}>
      {items.map((it) => (
        <li key={it.key} className={`st-${it.status}`}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false" className="arch-legend-mark">
            {it.status === 'ghost' ? <rect className="lg-ghost" x="2" y="2" width="14" height="14" rx="3" /> : <rect className="lg-ring" x="1.5" y="1.5" width="15" height="15" rx="4" />}
            {it.status === 'new' ? <path className="lg-plus" d="M9 5.5v7M5.5 9h7" /> : null}
          </svg>
          {i18n.t(it.text)}
        </li>
      ))}
    </ul>
  );
}

/**
 * full 图的横向滚动容器（窄屏，I6 b）：只有内容真的溢出时才是可聚焦的滚动区（tabIndex、role、名称），不多出 Tab 停留点；
 * 第一次溢出时把第一个新增 / 变更 / 选做 / ghost 节点滚进视口（窄屏首屏就能看到本卡新增的服务，左侧尽量保留入口与 EC2）。
 */
function ScrollBox({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const scrolled = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => {
      const o = el.scrollWidth > el.clientWidth + 1;
      setOver(o);
      if (!o || scrolled.current) return;
      scrolled.current = true;
      const target = el.querySelector('.an.st-new, .an.st-changed, .an.st-optional, .an.st-ghost');
      if (!target) return;
      const box = target.getBoundingClientRect();
      const host = el.getBoundingClientRect();
      const right = box.right - host.left + el.scrollLeft;
      el.scrollLeft = Math.max(0, right + 16 - el.clientWidth);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="arch-scroll" data-overflow={over ? '' : undefined} {...(over ? { tabIndex: 0, role: 'group', 'aria-label': label } : {})}>
      {children}
    </div>
  );
}

export function ArchDiagram({ input, model: givenModel, size = 'full', mode, title, decorative, fit = 'scroll', legend, className }: ArchDiagramProps) {
  const i18n = useVisualI18n();
  const model = useMemo(() => givenModel ?? buildArchModel(input ?? {}), [givenModel, input]);
  const layout = useMemo(() => layoutArch(model, size), [model, size]);
  const uid = `ad${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const m: DiagramMode = mode ?? (size === 'mini' ? 'after' : 'pair');
  const heading = title ?? i18n.t('visual.diagram.title');
  const keys: StateKey[] = m === 'pair' ? ['before', 'after'] : [m];
  const showLegend = legend ?? size === 'full';
  const scroll = size === 'full' && fit === 'scroll';
  const cls = ['arch', `arch-${size}`, m === 'pair' ? 'arch-pair' : '', fit === 'scale' ? 'arch-scale' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <figure className={cls} data-mode={m} {...(decorative ? { 'aria-hidden': true } : {})}>
      <div className="arch-panels">
        {keys.map((k, i) => (
          <div key={k} className="arch-panel" data-state={k}>
            {i > 0 ? (
              <span className="arch-arrow" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 20 20" focusable="false">
                  <path d="M4 10h11M11 6l4 4-4 4" />
                </svg>
              </span>
            ) : null}
            <div className="arch-body">
              {size === 'full' ? (
                <div className="arch-cap" aria-hidden="true">
                  {i18n.t(`visual.diagram.${k}`)}
                </div>
              ) : null}
              {scroll ? (
                <ScrollBox label={i18n.t('visual.diagram.scroll', { title: titled(i18n, heading, k) })}>
                  <DiagramSvg model={model} layout={layout} stateKey={k} title={heading} decorative={decorative} i18n={i18n} uid={uid} />
                </ScrollBox>
              ) : (
                <DiagramSvg model={model} layout={layout} stateKey={k} title={heading} decorative={decorative} i18n={i18n} uid={uid} />
              )}
            </div>
          </div>
        ))}
      </div>
      {showLegend ? <Legend model={model} mode={m} i18n={i18n} /> : null}
    </figure>
  );
}
