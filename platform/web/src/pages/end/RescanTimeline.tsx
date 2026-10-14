/** 复扫时间线（08 §5.4 RescanTimeline：`<ol>`，复扫 1/2/3：未到、进行中、完成、发现残留）。 */
import { formatClock, formatUtcTitle } from '../../lib/format';
import { Status } from '../../ui';
import type { RescanItem } from './rescan';

import { msg, rich, t } from '../../i18n';

const R = msg.end.rescan;
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
      <h2 id="rescan-h">{R.title}</h2>
      <ol className="timeline">
        {items.map((r) => {
          const m = META[r.status];
          const text =
            r.status === 'done'
              ? r.doneAt
                ? t(R.doneAt, { t: formatClock(r.doneAt) })
                : R.done
              : r.status === 'found'
                ? r.doneAt
                  ? t(R.foundAt, { t: formatClock(r.doneAt) })
                  : R.found
                : r.status === 'running'
                  ? R.running
                  : r.status === 'due'
                    ? t(R.due, { t: formatClock(r.at) })
                    : t(R.planned, { t: formatClock(r.at) });
          return (
            <li key={r.index} data-rescan={r.index} data-status={r.status}>
              <span className="t" title={formatUtcTitle(r.at)}>
                {r.offset || formatClock(r.at)}
              </span>
              <span className="what">
                {rich(R.item, { n: r.index, status: <Status meta={{ text, shape: m.shape, tone: m.tone }} /> })}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
