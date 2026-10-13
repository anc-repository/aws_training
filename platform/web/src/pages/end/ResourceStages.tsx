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
import { STAGE_TEXT } from '../sessions/sessionText';
import { countLedger, groupByStage, slowHint, type LedgerItem } from './resources';

const openMemory = new Map<string, boolean>();

/** 测试用。 */
export function resetStageMemory(): void {
  openMemory.clear();
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
    announce(next ? '已显示完整的账号 ID 与 IP，30 秒后恢复打码' : '已恢复打码');
    if (next) timer.current = setTimeout(() => setUnmasked(false), 30_000);
  };
  const show = (s: string) => (unmasked ? s : redact(s));
  const title = heading ?? `资源（本次实验创建或接管的 ${items.length} 项${chainExtra > 0 ? `，另含交接链中其他会话的资源 ${chainExtra} 项` : ''}）`;
  return (
    <section className="sec" aria-labelledby={`res-h-${sid}`} data-section="resources">
      <h2 id={`res-h-${sid}`}>
        {title}
        <span className="aside">
          <span data-counts="">
            已删除 {counts.deleted} · 删除中 {counts.deleting} · 等待 {counts.waiting} · 保留 {counts.retained} · 需人工 {counts.attention}
          </span>
          {canUnmask ? (
            <>
              {' · '}
              <button type="button" className="linkbtn" aria-pressed={unmasked} onClick={toggleUnmask}>
                {unmasked ? '恢复打码' : '显示完整值'}
              </button>
            </>
          ) : null}
        </span>
      </h2>
      {groups.length === 0 ? <p className="small muted">没有记录到本次实验创建的资源。</p> : null}
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
              <span className="sr">已删除 {g.done} 项，共 {g.total} 项</span>
            </summary>
            <div className="tbl-wrap">
              <table className="tbl rtable">
                <thead>
                  <tr>
                    <th scope="col">状态</th>
                    <th scope="col">类型与名称</th>
                    <th scope="col">来源</th>
                    <th scope="col">计费</th>
                    <th scope="col">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((r) => {
                    const hint = slowHint(r);
                    return (
                      <tr key={r.resourceKey} data-resource={r.resourceKey} data-state={r.cleanupState}>
                        <td data-label="状态">
                          <Status meta={CLEANUP_STATE_META[r.cleanupState]} />
                          {r.severity && r.severity !== 'INFO' && r.cleanupState !== 'DELETED' ? (
                            <>
                              <br />
                              <Status meta={SEVERITY_META[r.severity]} />
                            </>
                          ) : null}
                        </td>
                        <td data-label="类型与名称">
                          <span className="mono small">{r.resourceType}</span>
                          <br />
                          <span className="mono small wrap-any">{show(r.name ?? r.arn ?? r.resourceKey)}</span>
                        </td>
                        <td className="small" data-label="来源">
                          {r.discoveredBy ?? '—'}
                        </td>
                        <td className="small" data-label="计费">
                          {r.billing ? BILLING_TEXT[r.billing] : '—'}
                        </td>
                        <td className="small muted" data-label="说明">
                          {[hint, r.reason ? show(r.reason) : null, r.attempts ? `已尝试 ${r.attempts} 次` : null].filter(Boolean).join(' · ') || '—'}
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
