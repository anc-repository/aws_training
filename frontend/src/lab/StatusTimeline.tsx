// 状态时间线：管理员视图的 probeHistory（最近 20 次探针）；普通用户只看到当前状态与起始时间。
import type { ModuleCapability } from '@cloudalbum/contracts';
import { fmtTime } from '../util/format';

export function StatusTimeline({ cap }: { cap: ModuleCapability }) {
  const history = cap.probeHistory ?? [];
  if (!history.length) {
    return (
      <p className="subtle">
        当前 {cap.status === 'off' ? `off（本地实现 ${cap.localHealth ?? 'ok'}）` : cap.status}，自 {fmtTime(cap.since)} 起。
        {cap.probeHistory === undefined ? '探针历史仅管理员可见。' : '还没有探针记录。'}
      </p>
    );
  }
  return (
    <ul className="timeline" aria-label="探针历史">
      {history.map((h) => (
        <li key={`${h.at}-${h.detail}`}>
          <span className="num">{fmtTime(h.at)}</span>
          <span><span className={`status-dot ${h.status}`} />{h.status}{h.latencyMs !== undefined ? ` · ${h.latencyMs} ms` : ''}</span>
          <span className="wrap-any">{h.detail}</span>
        </li>
      ))}
    </ul>
  );
}
