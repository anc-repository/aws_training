/**
 * P04 准备进度的阶段图示（09 I6：准备进度用阶段图示代替文字列表）：六个阶段画成一条横向的节点链（窄容器里改为竖排），
 * 每个节点是阶段图形 + 右下角的状态形状（形状 + 颜色 + 读屏文字，08 §6.2），节点下方是阶段名与用时。
 * 当前阶段的细节（模块 i/n、CloudFormation 资源、重试原因、排队、慢资源、接近部署预算）只在图下方的一个细节框里显示。
 *
 * 仍是一个 `<ol>`：当前阶段 `aria-current="step"`，每项带 `data-phase` / `data-status`（测试与 e2e 依赖）；不显示进度百分比（02 §11.3）。
 */
import { formatCountdown } from '../../lib/format';
import { redact } from '../../lib/redact';
import { Shape } from '../../ui';
import type { PhaseRowModel } from '../model/phases';
import { PhaseIcon } from '../visual/icons';

import { withText } from '../../i18n';
import { W } from '../strings';
const WP = W.provision;

export const PHASE_SHAPE: Readonly<Record<PhaseRowModel['status'], { shape: 'check' | 'spin' | 'ring' | 'retry' | 'clock' | 'xbox' | 'dash'; tone: string; readonly text: string }>> = withText(
  {
    done: { shape: 'check', tone: 'pass' },
    running: { shape: 'spin', tone: 'pend' },
    todo: { shape: 'ring', tone: 'faint' },
    retrying: { shape: 'retry', tone: 'drift' },
    queued: { shape: 'clock', tone: 'pend' },
    failed: { shape: 'xbox', tone: 'fail' },
    skipped: { shape: 'dash', tone: 'mut' },
  } as const,
  WP.phase,
);

export function isCurrentPhase(r: Pick<PhaseRowModel, 'status'>): boolean {
  return r.status === 'running' || r.status === 'retrying' || r.status === 'queued';
}

export function PhaseDiagram({ rows, now, near }: { rows: readonly PhaseRowModel[]; now: number; near: boolean }) {
  const focus = rows.find(isCurrentPhase) ?? rows.find((r) => r.status === 'failed') ?? null;
  const notes: string[] = [];
  if (focus) {
    for (const d of focus.details) notes.push(redact(d));
    if (focus.status === 'queued') notes.push(WP.queued);
    if (focus.slowHint) notes.push(focus.slowHint);
    if (isCurrentPhase(focus) && near) notes.push(WP.slow);
  }
  return (
    <div className="phd-wrap">
      <ol className="phd" aria-label={WP.phases}>
        {rows.map((r) => {
          const m = PHASE_SHAPE[r.status];
          const current = isCurrentPhase(r);
          const tm = r.status === 'done' && r.startedAt && r.endedAt ? formatCountdown(r.endedAt - r.startedAt) : current && r.startedAt ? formatCountdown(now - r.startedAt) : '';
          return (
            <li
              key={r.key}
              className={`phd-step ${m.tone}`}
              aria-current={current ? 'step' : undefined}
              data-phase={r.key}
              data-status={r.status}
              title={r.details.length ? r.details.map((d) => redact(d)).join(' · ') : undefined}
            >
              <span className="phd-node" aria-hidden="true">
                <PhaseIcon phase={r.key} />
                <span className={`phd-badge st ${m.tone}`}>
                  <Shape name={m.shape} spin={m.shape === 'spin'} />
                </span>
              </span>
              <span className="phd-text">
                <span className="phd-t">{r.title}</span>
                <span className="sr">{m.text}</span>
                {tm ? <span className="phd-tm mono">{tm}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {focus && notes.length ? (
        <div className={`phd-detail ${PHASE_SHAPE[focus.status].tone}`} data-phase-detail={focus.key}>
          <PhaseIcon phase={focus.key} />
          <ul className="small mlist">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
