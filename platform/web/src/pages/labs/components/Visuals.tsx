/**
 * 目录、简介页、路径与“我的学习”共用的视觉小部件（I6 c、d、f；09「视觉组件」V9）：
 * - CardGlyph：卡片的服务图标（单服务卡 = 主服务；场景卡 = 主服务叠放，最多 3 个 + “+N”）；
 * - CardArch：目录卡片的迷你架构图（完成后，新增服务用强调色圈出；旁边有标题与简介，所以是装饰图形）；
 * - CardMetrics：难度 · 时长 · 费用 · 部署等级的图标 + 短标签（选做步骤会提高费用档位时加一个“→ $$$”记号）；
 * - More：长段落折叠到“詳しく / Details”。
 * 全部只用视觉组件与已有 token；不写 style 属性（CSP style-src 'self'）。
 */
import { useMemo, type ReactNode } from 'react';
import { msg, t } from '../../../i18n';
import { COST_TIER_META } from '../../../ui';
import { MetricStrip } from '../../../ui/charts';
import { ArchDiagram, archInputFromCatalogCard } from '../../../ui/diagram';
import { ServiceGlyph } from '../../../ui/glyphs';
import type { CatalogCard } from '../types';

/** 卡片的主服务 id（taxonomy 服务 id；ServiceGlyph 会把它解析到模块）。 */
export function primaryServices(card: Pick<CatalogCard, 'services'>): string[] {
  const p = card.services.filter((s) => s.role === 'primary').map((s) => s.id);
  return p.length ? p : card.services.map((s) => s.id).slice(0, 1);
}

export function CardGlyph({ card, size = 40, max = 3 }: { card: Pick<CatalogCard, 'id' | 'kind' | 'services'>; size?: number; max?: number }) {
  const ids = primaryServices(card);
  if (card.kind === 'service' || ids.length <= 1) {
    return (
      <span className="cglyph" aria-hidden="true">
        <ServiceGlyph id={ids[0] ?? card.id.replace(/^svc-/, '')} size={size} />
      </span>
    );
  }
  const small = Math.round(size * 0.7);
  return (
    <span className="cglyph stack" aria-hidden="true">
      {ids.slice(0, max).map((id) => (
        <ServiceGlyph key={id} id={id} size={small} />
      ))}
      {ids.length > max ? <span className="cglyph-more">+{ids.length - max}</span> : null}
    </span>
  );
}

/** 目录卡片的迷你架构图（I6 c）：完成后的构成，新增服务圈出。 */
export function CardArch({ card }: { card: CatalogCard }) {
  const input = useMemo(() => archInputFromCatalogCard(card), [card]);
  return (
    <div className="ct-arch" data-arch={card.id}>
      <ArchDiagram input={input} size="mini" decorative />
    </div>
  );
}

export function CardMetrics({ card, provision = true }: { card: CatalogCard; provision?: boolean }) {
  const opt = card.costTier.withOptional && card.costTier.withOptional !== card.costTier.required ? card.costTier.withOptional : null;
  return (
    <span className="ct-metrics">
      <MetricStrip difficulty={card.difficulty} minutes={card.estimatedMinutes} cost={card.costTier.required} provision={provision ? card.provisionClass : undefined} />
      {opt ? (
        <span className="mi-opt" title={t(msg.ui.costTier.optional, { tier: COST_TIER_META[opt].text })}>
          <span aria-hidden="true">→ {COST_TIER_META[opt].symbol}</span>
          <span className="sr">{t(msg.ui.costTier.optional, { tier: COST_TIER_META[opt].text })}</span>
        </span>
      ) : null}
    </span>
  );
}

/** 长段落折叠（I6 d）：summary 默认“詳しく / Details / 详细”。 */
export function More({ summary, children, className, open }: { summary?: ReactNode; children: ReactNode; className?: string; open?: boolean }) {
  return (
    <details className={['disc', 'more', className ?? ''].filter(Boolean).join(' ')} open={open}>
      <summary>{summary ?? msg.labs.ui.visual.more}</summary>
      <div className="more-body">{children}</div>
    </details>
  );
}
