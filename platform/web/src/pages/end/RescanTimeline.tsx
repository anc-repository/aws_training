/** 复扫时间线（08 §5.4 RescanTimeline：`<ol>`，复扫 1/2/3：未到、进行中、完成、发现残留）。 */
import { formatClock, formatUtcTitle } from '../../lib/format';
import { Status } from '../../ui';
import type { RescanItem } from './rescan';

const META = {
  pending: { shape: 'ring', tone: 'faint' },
  due: { shape: 'clock', tone: 'pend' },
  running: { shape: 'clock', tone: 'pend' },
  done: { shape: 'check', tone: 'pass' },
  found: { shape: 'tri', tone: 'fail' },
} as const;

export function RescanTimeline({ items }: { items: readonly RescanItem[] }) {
  if (!items.length) return null;
  return (
    <section className="sec" aria-labelledby="rescan-h" data-section="rescan">
      <h2 id="rescan-h">复扫时间线</h2>
      <ol className="timeline">
        {items.map((r) => {
          const m = META[r.status];
          const text =
            r.status === 'done'
              ? `完成${r.doneAt ? ` ${formatClock(r.doneAt)}` : ''}`
              : r.status === 'found'
                ? `发现残留${r.doneAt ? ` ${formatClock(r.doneAt)}` : ''}`
                : r.status === 'running'
                  ? '进行中'
                  : r.status === 'due'
                    ? `已到计划时间 ${formatClock(r.at)}`
                    : `计划 ${formatClock(r.at)}`;
          return (
            <li key={r.index} data-rescan={r.index} data-status={r.status}>
              <span className="t" title={formatUtcTitle(r.at)}>
                {r.offset || formatClock(r.at)}
              </span>
              <span className="what">
                复扫 {r.index} · <Status meta={{ text, shape: m.shape, tone: m.tone }} />
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
