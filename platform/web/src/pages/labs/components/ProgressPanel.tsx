/**
 * 顶栏“进度”浮层的内容（08 §3.4 ProgressDisclosure）：当前路径的必修 / 选修组 / 已核验占比与分段条、下一张推荐（recommendNext）、
 * 我的学习与证书入口。数据与目录页同源（目录索引 + GET /labs），由 GlobalBar 在浮层展开时按需加载本模块，不进首屏包。
 * 没有做的：按钮文案上的 `进度 23/40`（需要首屏就读 GET /labs）、“切换当前路径”（在目录的路径视图与路径详情中切换）。
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalStatus } from '../../../app/globalStatus';
import { Skeleton } from '../../../ui';
import { progressMap, useCatalog, useHolder, useLabs } from '../data';
import { recommendNext, trackSummary } from '../model';
import { TrackHead } from './TrackView';

export default function ProgressPanel({ onNavigate }: { onNavigate?: () => void }) {
  const status = useGlobalStatus();
  const { index, cards } = useCatalog();
  const labs = useLabs();
  const holder = useHolder(labs.data);
  const progress = useMemo(() => progressMap(labs.data), [labs.data]);
  const currentTrackId = status.me?.currentTrackId ?? labs.data?.currentTrackId ?? index?.defaults?.track ?? 'saa-main';
  const track = index?.tracks.find((x) => x.id === currentTrackId) ?? index?.tracks[0] ?? null;
  const summary = useMemo(() => (track ? trackSummary(track, progress, holder?.labId) : null), [track, progress, holder]);
  const rec = useMemo(() => recommendNext(track, progress, holder, cards), [track, progress, holder, cards]);
  if (!track || !summary || (!labs.data && !labs.error)) return <Skeleton lines={3} label="正在读取学习进度…" />;
  const recCard = rec ? (cards.get(rec.labId) ?? null) : null;
  return (
    <div className="stack-8 progress-panel" data-progress-panel="">
      <b>
        当前路径：
        <Link to={`/tracks/${track.id}`} onClick={onNavigate}>
          {track.title ?? track.id}
        </Link>
      </b>
      <TrackHead track={track} summary={summary} cert={summary.eligible ? 'eligible' : 'not-yet'} canSetCurrent={false} isCurrent busy={false} onSetCurrent={() => undefined} />
      {recCard ? (
        <span className="small">
          下一张推荐：
          <Link to={`/labs/${recCard.id}`} onClick={onNavigate}>
            {recCard.id}
          </Link>{' '}
          · 约 {recCard.estimatedMinutes} 分钟
        </span>
      ) : summary.completed ? (
        <span className="small">这条路径的必修卡片都已完成{summary.eligible ? '，可以领取证书' : ''}。</span>
      ) : null}
    </div>
  );
}
