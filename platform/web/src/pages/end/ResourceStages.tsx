/**
 * 回收阶段 S0～S6 的资源区块 ReclaimStageList（08 §5.4；P07 资源区块、P11-D 资源页签）。
 * - 每组一行汇总“已删除 / 总数”（形状 + 文字），展开为资源表：状态、类型与名称（打码显示，等宽可折行）、来源、计费、说明；
 * - 轮询带来的更新只替换内容：`<details>` 的展开状态受控，按 `sid + 阶段` 记住；学员没碰过的阶段只在首次渲染时用默认规则（§7.6 第 5 条）；
 * - [显示完整值] 临时还原 30 秒（只对学员）；复用环境时标题注明“另含交接链中其他会话的资源 N 项”（§9.2 #28 回写前不逐行展开）。
 */
import { useEffect, useRef, useState } from 'react';
import { redact } from '../../lib/redact';
import { announce } from '../../lib/announce';
import { Status, BILLING_TEXT, CLEANUP_STATE_META, SEVERITY_META } from '../../ui';
import { ProgressRing } from '../../ui/charts';
import { STAGE_TEXT } from '../sessions/sessionText';
import { MiniBar, StackBar, type StackSeg } from '../sessions/visuals';
import { countLedger, groupByStage, slowHint, type LedgerCounts, type LedgerItem } from './resources';

import { msg, t } from '../../i18n';

const RR = msg.end.resources;
const openMemory = new Map<string, boolean>();

/** 测试用。 */
export function resetStageMemory(): void {
  openMemory.clear();
}

/** 资源删除进度的堆叠条（I6 f）：已删除 / 删除中 / 等待 / 保留 / 需人工，色调取 CLEANUP_STATE_META。 */
export function ledgerSegments(c: LedgerCounts): StackSeg[] {
  const M = CLEANUP_STATE_META;
  return [
    { key: 'deleted', value: c.deleted, tone: M.DELETED.tone, label: M.DELETED.text },
    { key: 'deleting', value: c.deleting, tone: M.DELETING.tone, label: M.DELETING.text },
    { key: 'waiting', value: c.waiting, tone: M.TRACKED.tone, label: M.TRACKED.text },
    { key: 'retained', value: c.retained, tone: M.RETAINED.tone, label: M.RETAINED.text },
    { key: 'attention', value: c.attention, tone: M.MANUAL_REQUIRED.tone, label: M.MANUAL_REQUIRED.text },
  ];
}

export interface ResourceStagesProps {
  sid: string;
  items: readonly LedgerItem[];
  /** 标题前缀（“资源（本次实验创建或接管的 n 项）”）。 */
  heading?: string;
  /** 交接链中其他会话的资源条数。 */
  chainExtra?: number;
  /** 学员可以临时显示完整值。 */
  canUnmask?: boolean;
}

export function ResourceStages({ sid, items, heading, chainExtra = 0, canUnmask }: ResourceStagesProps) {
  const groups = groupByStage(items);
  const counts = countLedger(items);
  const [unmasked, setUnmasked] = useState(false);
  const [, force] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // 首次见到的阶段记下默认展开状态（之后的轮询不再改变它）
  for (const g of groups) {
    const k = `${sid}|${g.stage}`;
    if (!openMemory.has(k)) openMemory.set(k, g.defaultOpen);
  }
  const toggleUnmask = () => {
    if (timer.current) clearTimeout(timer.current);
    const next = !unmasked;
    setUnmasked(next);
    announce(next ? RR.unmasked : RR.masked);
    if (next) timer.current = setTimeout(() => setUnmasked(false), 30_000);
  };
  const show = (s: string) => (unmasked ? s : redact(s));
  const title = heading ?? (chainExtra > 0 ? t(RR.titleChain, { n: items.length, m: chainExtra }) : t(RR.title, { n: items.length }));
  return (
    <section className="sec" aria-labelledby={`res-h-${sid}`} data-section="resources">
      <h2 id={`res-h-${sid}`}>
        {title}
        <span className="aside">
          <span data-counts="">
            {t(RR.counts, { deleted: counts.deleted, deleting: counts.deleting, waiting: counts.waiting, retained: counts.retained, attention: counts.attention })}
          </span>
          {canUnmask ? (
            <>
              {' · '}
              <button type="button" className="linkbtn" aria-pressed={unmasked} onClick={toggleUnmask}>
                {unmasked ? RR.remask : RR.unmask}
              </button>
            </>
          ) : null}
        </span>
      </h2>
      {counts.total > 0 ? (
        <div className="vres-sum" data-visual="ledger">
          <ProgressRing value={counts.deleted} max={counts.total} size={44} label={msg.end.visual.deleted} tone="pass" />
          <StackBar segments={ledgerSegments(counts)} total={counts.total} />
        </div>
      ) : null}
      {groups.length === 0 ? <p className="small muted">{RR.none}</p> : null}
      {groups.map((g) => {
        const k = `${sid}|${g.stage}`;
        const open = openMemory.get(k) ?? g.defaultOpen;
        const sum = g.done === g.total ? { text: `${g.done}/${g.total}`, shape: 'check' as const, tone: 'pass' as const } : g.bad ? { text: `${g.done}/${g.total}`, shape: 'tri' as const, tone: 'fail' as const } : g.busy ? { text: `${g.done}/${g.total}`, shape: 'clock' as const, tone: 'pend' as const } : { text: `${g.done}/${g.total}`, shape: 'ring' as const, tone: 'mut' as const };
        return (
          <details
            key={g.stage}
            className="disc rstage"
            open={open}
            data-stage={g.stage}
            onToggle={(e) => {
              const now = (e.currentTarget as HTMLDetailsElement).open;
              if (openMemory.get(k) !== now) {
                openMemory.set(k, now);
                force((x) => x + 1);
              }
            }}
          >
            <summary>
              <b>{STAGE_TEXT[g.stage] ?? g.stage}</b> <Status meta={sum} />
              <MiniBar done={g.done} total={g.total} tone={sum.tone} />
              <span className="sr">{t(RR.stageSr, { done: g.done, total: g.total })}</span>
            </summary>
            <div className="tbl-wrap">
              <table className="tbl rtable">
                <thead>
                  <tr>
                    <th scope="col">{RR.colState}</th>
                    <th scope="col">{RR.colName}</th>
                    <th scope="col">{RR.colSource}</th>
                    <th scope="col">{RR.colBilling}</th>
                    <th scope="col">{RR.colNote}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((r) => {
                    const hint = slowHint(r);
                    return (
                      <tr key={r.resourceKey} data-resource={r.resourceKey} data-state={r.cleanupState}>
                        <td data-label={RR.colState}>
                          <Status meta={CLEANUP_STATE_META[r.cleanupState]} />
                          {r.severity && r.severity !== 'INFO' && r.cleanupState !== 'DELETED' ? (
                            <>
                              <br />
                              <Status meta={SEVERITY_META[r.severity]} />
                            </>
                          ) : null}
                        </td>
                        <td data-label={RR.colName}>
                          <span className="mono small">{r.resourceType}</span>
                          <br />
                          <span className="mono small wrap-any">{show(r.name ?? r.arn ?? r.resourceKey)}</span>
                        </td>
                        <td className="small" data-label={RR.colSource}>
                          {r.discoveredBy ?? '—'}
                        </td>
                        <td className="small" data-label={RR.colBilling}>
                          {r.billing ? BILLING_TEXT[r.billing] : '—'}
                        </td>
                        <td className="small muted" data-label={RR.colNote}>
                          {[hint, r.reason ? show(r.reason) : null, r.attempts ? t(RR.attempts, { n: r.attempts }) : null].filter(Boolean).join(' · ') || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </section>
  );
}
