/**
 * 检查结果行 CheckResultRow 与判定来源 SourceTag（08 §5.3；改造 ui-design CheckResultRow，原型 checkRow / srcTag）。
 *
 * 每行：结果形状、判定方式（自动 / 手动）、SourceTag、标题与期望 / 实际摘要、可信度（中 / 低时）、结果文字、时间、[详情]。
 * 布局用命名的 grid-template-areas（components.css `.chkrow.cr`）：桌面一行六区；≤ 560px 两行，判定方式与来源任何宽度都不隐藏。
 * 可见的结果文字 aria-hidden，读屏读标题后的视觉隐藏文字，避免重复。行可聚焦，Enter 打开证据抽屉（onOpen）。
 */
import type { CheckSource } from '@atl/shared';
import type { KeyboardEvent, ReactNode } from 'react';
import { formatClock, formatUtcTitle } from '../lib/format';
import { Shape } from './Shape';
import { checkResultMeta, MANUAL_SUB_TEXT, SOURCE_META, type CheckResult, type ManualSub } from './semantics';

import { msg, t } from '../i18n';
export type Trust = 'high' | 'medium' | 'low';

export interface SourceTagProps {
  source: CheckSource;
  sub?: ManualSub | null;
  trust?: Trust | null;
  /** 来源不可用（灰，划线）。 */
  unavailable?: boolean;
}

export function SourceTag({ source, sub, trust, unavailable }: SourceTagProps) {
  const m = SOURCE_META[source];
  const subText = sub ? MANUAL_SUB_TEXT[sub] : null;
  return (
    <span className={unavailable ? 'src off' : 'src'} title={subText ? t(msg.ui.check.sourceTitleSub, { source: m.text, sub: subText }) : t(msg.ui.check.sourceTitle, { source: m.text })} data-source={source}>
      <span aria-hidden="true">{m.symbol}</span> {m.text}
      {subText ? <span className="faint">·{subText}</span> : null}
      {trust && trust !== 'high' ? <span className="faint">{trust === 'medium' ? msg.ui.check.trustMedium : msg.ui.check.trustLow}</span> : null}
    </span>
  );
}

/** EvidenceMix：“□AWS 6 · ◇本地 1 · △实验 1”。 */
export function evidenceMix(counts: Partial<Record<CheckSource, number>>): string {
  return (Object.keys(SOURCE_META) as CheckSource[])
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${SOURCE_META[k].symbol}${SOURCE_META[k].text} ${counts[k]}`)
    .join(' · ');
}

export interface CheckResultRowProps {
  title: string;
  result: CheckResult;
  /** 结果原因码，例如 `OWNERSHIP_PENDING`、`EXPECTED_OUTAGE`、`CHANNEL_DOWN`。 */
  reason?: string | null;
  how: 'auto' | 'manual';
  source: CheckSource;
  sourceSub?: ManualSub | null;
  trust?: Trust | null;
  /** 期望 / 实际摘要，或等待型检查的“已等待 …”。 */
  summary?: ReactNode;
  /** 判定时间（ISO）。 */
  at?: string | null;
  /** 手动确认的助教复核。 */
  review?: 'pending' | 'approved' | 'rejected' | null;
  /** 结果已过期（“·过期”后缀）。 */
  stale?: boolean;
  /** 刚到达的结果：120ms 淡入。 */
  fresh?: boolean;
  onOpen?: () => void;
  /** 稳定的焦点键（局部重绘后恢复焦点，§8.3）。 */
  focusKey?: string;
}

export function CheckResultRow({
  title,
  result,
  reason,
  how,
  source,
  sourceSub,
  trust,
  summary,
  at,
  review,
  stale,
  fresh,
  onOpen,
  focusKey,
}: CheckResultRowProps) {
  const m = checkResultMeta(result, reason);
  const resultText = `${m.text}${stale ? msg.ui.check.stale : ''}${result === 'error' && reason ? t(msg.ui.check.withReason, { reason }) : ''}`;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onOpen && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <div
      className={['chkrow', 'cr', fresh ? 'fresh' : ''].filter(Boolean).join(' ')}
      role="listitem"
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onKey}
      data-k={focusKey}
      data-result={result}
    >
      <span className={`st ${m.tone}`}>
        <Shape name={m.shape} spin={m.spin} />
      </span>
      <span className="meta">
        <span className="how">{how === 'manual' ? msg.ui.check.manual : msg.ui.check.auto}</span>
        <span className="srcc">
          <SourceTag source={source} sub={sourceSub} trust={trust} />
        </span>
      </span>
      <span className="ttl">
        {title}
        {summary ? <span className="ea"> · {summary}</span> : null}
        {review === 'pending' ? (
          <span className="rv">
            {' '}
            <Shape name="clock" />
            {msg.ui.check.reviewPending}
          </span>
        ) : review === 'approved' ? (
          <span className="rv">
            {' '}
            <Shape name="check" />
            {msg.ui.check.reviewApproved}
          </span>
        ) : review === 'rejected' ? (
          <span className="rv">
            {' '}
            <Shape name="tri" />
            {msg.ui.check.reviewRejected}
          </span>
        ) : null}
        <span className="sr">{t(msg.ui.check.srResult, { text: resultText })}</span>
      </span>
      <span className={['small', 'res', m.tone === 'fail' ? 'st fail' : stale ? 'st stale' : 'faint'].join(' ')} aria-hidden="true">
        {resultText}
      </span>
      <span className="tm" title={at ? formatUtcTitle(at) : undefined}>
        {at ? formatClock(at) : '—'}
      </span>
    </div>
  );
}
