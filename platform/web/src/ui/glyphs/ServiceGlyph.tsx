/**
 * <ServiceGlyph id="storage" size={24} />：40 个模块各一个的服务图标（I6 a）。
 *
 * - 组色圆角方块（--cat-*）+ --on-ink 线条图案；两种主题下图案与方块、方块与页面底色的对比度都 ≥ 4:1（见 09 文档）。
 * - size < 40：只画图案（16 / 24 / 32px）；size ≥ 40：徽章模式，缩小的图案 + 等宽缩写 + 左上角组符号（不依赖颜色区分组）。
 * - 默认是装饰图形（aria-hidden）；label 为 true 时 role="img" + “服务名（机能）”，为字符串时用该字符串。
 * - tone：solid（默认）/ ghost（虚线框、无底色，用于“开始时还没有”的位置）/ muted（降低不透明度）。
 * - 认不出的 id 画中性方块 + 前 3 个字符，不抛错（目录数据比前端新时不至于白屏）。
 */
import { GROUP_SYMBOLS, MOTIFS, PSEUDO_MOTIFS } from './motifs';
import { glyphGroup, glyphModule, groupClass } from './data';
import { useVisualI18n, type VisualKey } from './visualI18n';
import './glyphs.css';

export type GlyphTone = 'solid' | 'ghost' | 'muted';
export type GlyphVariant = 'auto' | 'icon' | 'badge';

export interface ServiceGlyphProps {
  /** 模块 id（registry：storage、cdn …）或 taxonomy 服务 id（s3、cloudfront …）。 */
  id: string;
  /** 像素尺寸（默认 24）。 */
  size?: number;
  variant?: GlyphVariant;
  /** 可访问名称：true = 自动生成；字符串 = 自定义；省略 = 装饰（aria-hidden）。 */
  label?: boolean | string;
  /** 悬停提示（SVG <title>）：“服务名 · 组名”。 */
  tooltip?: boolean;
  tone?: GlyphTone;
  className?: string;
}

/** 徽章模式的阈值（px）：16 / 24 / 32 只画图案，40 / 48 起带缩写。 */
export const GLYPH_BADGE_MIN = 40;

export function ServiceGlyph({ id, size = 24, variant = 'auto', label, tooltip, tone = 'solid', className }: ServiceGlyphProps) {
  const { t } = useVisualI18n();
  const mod = glyphModule(id);
  const group = mod?.group ?? 'base';
  const badge = variant === 'badge' || (variant === 'auto' && size >= GLYPH_BADGE_MIN);
  const motif = mod ? MOTIFS[mod.id] : undefined;
  const abbr = mod?.abbr ?? id.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase();
  const groupName = t(`visual.group.${group}` as VisualKey);
  const fn = mod ? t(`visual.fn.${mod.id}` as VisualKey) : '';
  const service = mod?.awsService ?? id;
  const name = typeof label === 'string' ? label : label ? (mod ? t('visual.glyph.label', { service, fn }) : id) : null;
  const cls = ['sg', groupClass(group), tone !== 'solid' ? tone : '', mod ? '' : 'unknown', badge ? 'badge' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const a11y = name ? { role: 'img', 'aria-label': name } : { 'aria-hidden': true as const };
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 24 24" focusable="false" data-glyph={mod?.id ?? id} data-group={group} {...a11y}>
      {tooltip ? <title>{mod ? t('visual.glyph.title', { service, group: groupName }) : id}</title> : null}
      <rect className="sg-tile" x=".5" y=".5" width="23" height="23" rx="5" />
      {motif && !badge ? <g className="sg-motif">{motif}</g> : null}
      {motif && badge ? (
        <>
          <g className="sg-sym" transform="translate(2.4 2.4) scale(.6)">
            {GROUP_SYMBOLS[group]}
          </g>
          <g className="sg-motif" transform="translate(5.5 2.2) scale(.54)">
            {motif}
          </g>
          <text className="sg-abbr" x="12" y="21.4" textAnchor="middle" fontSize={abbr.length >= 4 ? 4.4 : 5.2}>
            {abbr}
          </text>
        </>
      ) : null}
      {!motif ? (
        <text className="sg-abbr" x="12" y="14.6" textAnchor="middle" fontSize={abbr.length >= 3 ? 6.4 : 8}>
          {abbr}
        </text>
      ) : null}
    </svg>
  );
}

export interface PseudoGlyphProps {
  kind: 'browser' | 'nginx';
  size?: number;
  className?: string;
}

/** 架构图里的非模块节点（浏览器、Nginx 入口）：中性底色，始终装饰（名称写在旁边）。 */
export function PseudoGlyph({ kind, size = 24, className }: PseudoGlyphProps) {
  return (
    <svg className={['sg', 'pseudo', className ?? ''].filter(Boolean).join(' ')} width={size} height={size} viewBox="0 0 24 24" focusable="false" aria-hidden="true" data-glyph={kind}>
      <rect className="sg-tile" x=".5" y=".5" width="23" height="23" rx="5" />
      <g className="sg-motif">{PSEUDO_MOTIFS[kind]}</g>
    </svg>
  );
}

/** 组的几何符号（6px 起）：图例、服务地图的组标题。 */
export function GroupSymbol({ group, size = 8, label }: { group: string; size?: number; label?: boolean }) {
  const { t } = useVisualI18n();
  const g = glyphGroup(group)?.id ?? 'base';
  const a11y = label ? { role: 'img', 'aria-label': t(`visual.group.${g}` as VisualKey) } : { 'aria-hidden': true as const };
  return (
    <svg className={`sg-group ${groupClass(g)}`} width={size} height={size} viewBox="0 0 6 6" focusable="false" data-group={g} {...a11y}>
      {GROUP_SYMBOLS[g]}
    </svg>
  );
}

export interface ServiceChipProps {
  id: string;
  size?: number;
  /** 显示机能短句（i18n）。 */
  showFunction?: boolean;
  tone?: GlyphTone;
}

/** 图标 + 短名（产品名不翻译）+ 可选的机能短句：用于“你将学到”、服务清单等图标列表。 */
export function ServiceChip({ id, size = 20, showFunction, tone }: ServiceChipProps) {
  const { t } = useVisualI18n();
  const mod = glyphModule(id);
  return (
    <span className="sg-chip" data-glyph={mod?.id ?? id}>
      <ServiceGlyph id={id} size={size} tone={tone} />
      <span className="sg-chip-text">
        <span className="sg-chip-name">{mod?.short ?? id}</span>
        {showFunction && mod ? <span className="sg-chip-fn">{t(`visual.fn.${mod.id}` as VisualKey)}</span> : null}
      </span>
    </span>
  );
}
