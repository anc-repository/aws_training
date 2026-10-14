/**
 * 横幅与横幅区（08 §3.6；改造 ui-design Banner，原型 renderBanners / bannerList）。
 * - 同一屏最多显示 2 条，其余收进“还有 n 条提醒”；
 * - 红色横幅不可关闭；其他横幅的关闭只在当前标签页内有效（sessionStorage），内容变化后重新出现（键 = id + 内容）；
 * - 红色与琥珀横幅首次出现时用 role="alert" 播报，之后路由切换不再重复播报（记在模块级集合中）。
 * 横幅的来源与优先级由全局框架计算（src/components/globalBanners.ts），这里只负责呈现。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { msg, t } from '../i18n';
import { ssGet, ssSet, STORAGE_KEYS } from '../lib/storage';
import { Icon } from './Icon';
import { Shape, type ShapeName } from './Shape';

export type BannerTone = 'red' | 'amber' | 'grey' | 'blue' | 'kept';

export interface BannerSpec {
  /** 稳定 id（同一类横幅同一个 id）。 */
  id: string;
  /** 优先级：数字小的在上（§3.6 表）。 */
  priority: number;
  tone: BannerTone;
  shape: ShapeName;
  /** 正文（纯文本，用于关闭记录的内容比较与播报）。 */
  text: string;
  /** 主操作（链接或按钮）。 */
  action?: ReactNode;
  /** 是否可关闭；红色横幅一律不可关闭。 */
  dismissible?: boolean;
}

export interface BannerProps {
  spec: BannerSpec;
  onDismiss?: () => void;
  /** 首次出现时以 role="alert" 播报。 */
  announce?: boolean;
}

export function Banner({ spec, onDismiss, announce }: BannerProps) {
  const closable = spec.dismissible !== false && spec.tone !== 'red' && !!onDismiss;
  return (
    <div className={`banner ${spec.tone}`} data-banner={spec.id} role={announce ? 'alert' : undefined}>
      <span className="b-shape">
        <Shape name={spec.shape} />
      </span>
      <div className="b-body">{spec.text}</div>
      <div className="b-act">
        {spec.action}
        {closable ? (
          <button type="button" className="btn sm ghost icon" aria-label={msg.banners.dismiss} onClick={onDismiss}>
            <Icon name="x" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

const announced = new Set<string>();

/** 测试用。 */
export function resetBannerAnnouncements(): void {
  announced.clear();
}

const keyOf = (b: BannerSpec) => `${b.id}|${b.text}`;

export interface BannerStackProps {
  banners: readonly BannerSpec[];
  max?: number;
}

export function BannerStack({ banners, max = 2 }: BannerStackProps) {
  const [dismissed, setDismissed] = useState<string[]>(() => ssGet<string[]>(STORAGE_KEYS.dismissedBanners, []));
  const [expanded, setExpanded] = useState(false);
  const visible = useMemo(
    () =>
      [...banners]
        .filter((b) => b.tone === 'red' || b.dismissible === false || !dismissed.includes(keyOf(b)))
        .sort((a, b) => a.priority - b.priority),
    [banners, dismissed],
  );
  const shown = expanded ? visible : visible.slice(0, max);
  const shownKeys = JSON.stringify(shown.map(keyOf));
  // 记录已播报的横幅放在提交之后（StrictMode 的双重渲染不会吞掉第一次的 role="alert"）
  useEffect(() => {
    for (const k of JSON.parse(shownKeys) as string[]) announced.add(k);
  }, [shownKeys]);
  if (!visible.length) return null;
  const dismiss = (b: BannerSpec) => {
    const next = [...dismissed.filter((k) => !k.startsWith(`${b.id}|`)), keyOf(b)];
    setDismissed(next);
    ssSet(STORAGE_KEYS.dismissedBanners, next);
  };
  return (
    <div className="banners no-print" role="region" aria-label={msg.banners.region}>
      {shown.map((b) => {
        const k = keyOf(b);
        const first = (b.tone === 'red' || b.tone === 'amber') && !announced.has(k);
        return <Banner key={b.id} spec={b} announce={first} onDismiss={b.tone === 'red' || b.dismissible === false ? undefined : () => dismiss(b)} />;
      })}
      {visible.length > max ? (
        <button type="button" className="linkbtn more-banners" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? msg.banners.collapse : t(msg.banners.more, { n: visible.length - max })}
        </button>
      ) : null}
    </div>
  );
}
