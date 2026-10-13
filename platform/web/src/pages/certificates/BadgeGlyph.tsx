/**
 * 徽章图形（08 §5.1 BadgeMark；05 §2.10：平台自绘，不使用 AWS 官方图标与认证徽章造型）。
 * 单服务卡圆角方块、场景卡六边形；外环：实线 = 已核验、虚线 = 含手动、点线 = 自述为主；核验中 = 虚线（转动，减少动效时静止）+ 文字；
 * 已撤回 = 灰色斜线 + 文字；未获得 = 空心轮廓。图形 aria-hidden，含义由旁边的文字表达。颜色只用类别色 token（--cat-*）。
 */
export type BadgeState = 'none' | 'verified' | 'attested' | 'self-reported' | 'pending' | 'withdrawn';

const CAT_CLASS: Record<string, string> = { base: 'cat-base', A: 'cat-a', B: 'cat-b', C: 'cat-c', D: 'cat-d', E: 'cat-e', F: 'cat-f' };

export function badgeAbbr(labId: string): string {
  const scenario = labId.startsWith('sc-');
  const core = labId.replace(/^(svc|sc)-/, '').split('-');
  const s = core.length > 1 ? core.map((p) => p[0]).join('') : core[0]!.slice(0, scenario ? 3 : 4);
  return s.toUpperCase().slice(0, scenario ? 3 : 4);
}

export function BadgeGlyph({ labId, kind, category, state, size = 40 }: { labId: string; kind?: string; category?: string; state: BadgeState; size?: 24 | 40 }) {
  const cls = ['bglyph', CAT_CLASS[category ?? ''] ?? 'cat-base', state === 'none' ? 'off' : state === 'attested' ? 'l-attested' : state === 'self-reported' ? 'l-self' : state, size === 24 ? 'sm' : '']
    .filter(Boolean)
    .join(' ');
  const scenario = kind === 'scenario';
  return (
    <svg className={cls} viewBox="0 0 40 40" width={size} height={size} aria-hidden="true" focusable="false" data-badge={state}>
      {scenario ? <path className="bg-shape" d="M20 3l14.7 8.5v17L20 37 5.3 28.5v-17z" /> : <rect className="bg-shape" x="4" y="4" width="32" height="32" rx="7" />}
      {state === 'withdrawn' ? <path className="slash" d="M8 32L32 8" /> : null}
      <text x="20" y="24" textAnchor="middle">
        {badgeAbbr(labId)}
      </text>
    </svg>
  );
}
