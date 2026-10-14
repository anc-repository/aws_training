/**
 * 结束阶段列表（08 P07“结束阶段”，§5.2 ProvisionPanel / PhaseRow 的 `end` 变体）：`<ol>`，当前阶段 aria-current="step"；
 * 阶段完成时由 LiveRegion 播报（同一阶段 10 秒内合并）。轮询更新只替换内容，列表本身保留（§7.6 第 5 条）。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { announce } from '../../lib/announce';
import { formatClock, formatUtcTitle } from '../../lib/format';
import { Icon, Shape, type IconName } from '../../ui';
import { STAGE_STATUS_META, type EndStage, type EndStageDef } from './phases';

/** 阶段图示的图标（I6 f：回收进度用阶段图示）。 */
export const STAGE_ICON: Readonly<Record<EndStageDef['id'], IconName>> = {
  stop: 'pause',
  revoke: 'key',
  finalize: 'doc',
  workstation: 'term',
  suspend: 'clock',
  destroy: 'cloud',
  reclaim: 'refresh',
  conclude: 'shield',
};

import { msg, t } from '../../i18n';
export interface EndPhaseListProps {
  stages: readonly EndStage[];
  /** 每个阶段附加的说明（报告链接、收回访问说明……）。 */
  extra?: Partial<Record<EndStage['def']['id'], ReactNode>>;
}

export function EndPhaseList({ stages, extra = {} }: EndPhaseListProps) {
  const prev = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const s of stages) {
      const before = prev.current[s.def.id];
      if (before && before !== s.status && s.status === 'done') announce(t(msg.end.phaseDone, { title: s.def.title }), { topic: `end-phase-${s.def.id}` });
      prev.current[s.def.id] = s.status;
    }
  }, [stages]);
  return (
    <section className="sec" aria-labelledby="end-phases-h" data-section="phases">
      <h2 id="end-phases-h">{msg.end.phasesTitle}</h2>
      <ol className="prov endflow" data-phases="">
        {stages.map((s) => {
          const m = STAGE_STATUS_META[s.status];
          const todo = s.status === 'todo';
          const settled = s.status === 'done' || s.status === 'failed';
          const detail = [extra[s.def.id], ...s.details.map((d, i) => <span key={i}>{d}</span>)].filter(Boolean);
          return (
            <li key={s.def.id} className={todo ? 'phrow todo' : 'phrow'} aria-current={s.current ? 'step' : undefined} data-stage={s.def.id} data-status={s.status}>
              <span className={`efnode vtone ${m.tone}${settled ? ' fill' : ''}${todo ? ' todo' : ''}`}>
                <Icon name={STAGE_ICON[s.def.id]} />
                {!todo ? (
                  <span className={`efst st ${m.tone}`}>
                    <Shape name={m.shape} spin={m.spin} />
                  </span>
                ) : null}
                <span className="sr">{m.text}</span>
              </span>
              <span className="pt">
                {s.def.title}
                {s.def.id === 'reclaim' ? <span className="small muted">{msg.end.reclaimFlow}</span> : null}
              </span>
              <span className="tm" title={s.at ? formatUtcTitle(s.at) : undefined}>
                {s.at && !todo ? formatClock(s.at) : ''}
              </span>
              {detail.length ? (
                <span className="pd">
                  {detail.map((d, i) => (
                    <span key={i}>
                      {i ? ' · ' : ''}
                      {d}
                    </span>
                  ))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
