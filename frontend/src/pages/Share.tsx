// 分享链接的公开页（F11）：/s/:token。读取时校验 expires_at；过期或不存在时给出明确说明。
import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useSocialApi } from '../capabilities/useCapability';
import { CdnBadge } from '../components/PhotoTile';
import { useAsync } from '../hooks/useAsync';
import { fmtTime, timeAgo } from '../util/format';

export function SharePage() {
  const { token = '' } = useParams();
  const social = useSocialApi();
  const load = useCallback(() => social.getShare(token), [social, token]);
  const share = useAsync(load);

  if (share.loading && !share.data) return <div className="skeleton" style={{ height: 360 }} />;
  if (share.errorObj) {
    const gone = share.errorObj instanceof ApiError && (share.errorObj.status === 404 || share.errorObj.status === 410);
    return (
      <div className="card panel-narrow" role="alert">
        <h1>{gone ? '链接已过期或不存在' : '无法打开分享链接'}</h1>
        <p className="muted">{gone ? '分享链接带有效期，过期后不能再访问。请联系分享者重新生成。' : share.error}</p>
        <Link to="/">返回首页</Link>
      </div>
    );
  }
  if (!share.data) return null;
  const { photo, expiresAt, sharedBy } = share.data;
  const src = photo.urls.display ?? photo.urls.thumb ?? null;
  return (
    <div className="stack" style={{ maxWidth: 960, margin: '0 auto' }}>
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1>{photo.title || photo.filename || '分享的照片'}</h1>
          <span className="subtle">{sharedBy ? `${sharedBy} 分享 · ` : ''}链接 {timeAgo(expiresAt)}过期（{fmtTime(expiresAt)}）</span>
        </div>
        {src && <CdnBadge url={src} />}
      </div>
      <div className="photo-stage">{src ? <img src={src} alt={photo.title || photo.filename} /> : <p className="muted">照片尚未就绪。</p>}</div>
      {photo.caption && <p>{photo.caption}</p>}
    </div>
  );
}
