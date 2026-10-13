// 照片缩略图：处理中显示灰色占位；角标是 cdn 徽章（全局：capabilities 的 cdn；请求级：该图片 Resource Timing 中的 cdn-* 项）。
import { Link } from 'react-router-dom';
import type { Photo } from '../api/types';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { useCapability } from '../capabilities/useCapability';
import { useResourceCdnState } from '../trace/resourceTiming';

const STATUS_TEXT: Record<string, string> = {
  UPLOADING: '上传中…',
  PROCESSING: '处理中…（生成缩略图）',
  FAILED: '处理失败',
  BLOCKED: '已被屏蔽',
};

export function CdnBadge({ url, outcome, plain = false }: { url: string | null | undefined; outcome?: string | undefined; plain?: boolean }) {
  const cdn = useCapability('cdn');
  const state = useResourceCdnState(cdn && cdn.status !== 'off' ? url : null);
  let o = outcome;
  if (!o && cdn && cdn.status !== 'off' && state) o = state === 'unknown' ? 'unknown' : state.toLowerCase();
  return <ModuleBadge module="cdn" outcome={o} plain={plain} />;
}

export function PhotoTile({ photo, cdnOutcome, showOwner = false }: { photo: Photo; cdnOutcome?: string | undefined; showOwner?: boolean }) {
  const ready = photo.status === 'READY' && photo.urls.thumb;
  return (
    <Link to={`/photos/${photo.id}`} className="photo-tile" aria-label={photo.title || photo.filename || '照片'}>
      {ready ? (
        <img src={photo.urls.thumb ?? ''} alt={photo.title || photo.filename} loading="lazy" decoding="async" />
      ) : (
        <>
          <div className="placeholder-img" style={photo.dominantColor ? { background: photo.dominantColor } : undefined} />
          <div className="tile-status">{STATUS_TEXT[photo.status] ?? photo.status}</div>
        </>
      )}
      {(showOwner || photo.counters) && (
        <div className="tile-meta">
          <span>{showOwner ? (photo.ownerName ?? '') : ''}</span>
          {photo.counters && <span className="num">赞 {photo.counters.likes} · 评论 {photo.counters.comments}</span>}
        </div>
      )}
      {ready && (
        <div className="tile-badge"><CdnBadge url={photo.urls.thumb} outcome={cdnOutcome} plain /></div>
      )}
    </Link>
  );
}

export function PhotoGrid({ photos, cdnOutcome, showOwner }: { photos: Photo[]; cdnOutcome?: string | undefined; showOwner?: boolean }) {
  return (
    <div className="grid-photos">
      {photos.map((p) => <PhotoTile key={p.id} photo={p} cdnOutcome={cdnOutcome} {...(showOwner !== undefined ? { showOwner } : {})} />)}
    </div>
  );
}
