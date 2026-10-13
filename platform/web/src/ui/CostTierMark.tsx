/**
 * 费用档位 `$ 低` / `$$ 中` / `$$$ 高`（08 §6.6、05 §2.8）：等宽 `$` + 文字，统一 --text-2，不用红绿；
 * 选做步骤更贵时写“低（选做 → 中）”。悬停说明主要计费来源与“金额在开始前计算”。不出现任何金额。
 */
import { COST_TIER_META, type CostTier } from './semantics';

export interface CostTierMarkProps {
  tier: CostTier;
  withOptional?: CostTier | null;
  /** 主要计费来源（悬停说明）。 */
  sources?: string;
}

export function CostTierMark({ tier, withOptional, sources }: CostTierMarkProps) {
  const m = COST_TIER_META[tier];
  const opt = withOptional && withOptional !== tier ? COST_TIER_META[withOptional] : null;
  const label = `费用档位${m.text}${opt ? `（选做 → ${opt.text}）` : ''}`;
  const tip = `${sources ? `主要计费来源：${sources}。` : ''}具体金额在开始前按当前价格计算。`;
  return (
    <span className="cost" title={tip} aria-label={label} data-tier={tier}>
      {m.symbol} {m.text}
      {opt ? `（选做 → ${opt.text}）` : null}
    </span>
  );
}
