// 通知（F10）：站内信列表、标记已读、通知设置（notification=sns 时出现“邮件通知需要点击确认邮件”与订阅状态）。
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeError } from '../api/client';
import { notificationsApi } from '../api/endpoints';
import type { NotificationItem } from '../api/types';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { useCaps } from '../capabilities/useCapability';
import { useAsync } from '../hooks/useAsync';
import { timeAgo } from '../util/format';

const TYPE_LABEL: Record<string, string> = {
  'comment.created': '新评论',
  'like.created': '新点赞',
  'photo.blocked': '照片被屏蔽',
  'report.ready': '日报',
};

export function NotificationsPage() {
  const caps = useCaps();
  const load = useCallback(() => notificationsApi.list(), []);
  const list = useAsync(load);
  const loadPrefs = useCallback(() => notificationsApi.prefs(), []);
  const prefs = useAsync(loadPrefs);
  const [error, setError] = useState<string | null>(null);
  const sns = caps.modules.notification?.driver === 'sns';

  const markRead = async (n: NotificationItem) => {
    if (n.readAt) return;
    try {
      await notificationsApi.markRead(n.id);
      list.setData((cur) => (cur ? { ...cur, items: cur.items.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) } : cur));
    } catch (e) {
      setError(describeError(e));
    }
  };
  const markAll = async () => {
    try {
      await notificationsApi.markAllRead();
      const now = new Date().toISOString();
      list.setData((cur) => (cur ? { ...cur, items: cur.items.map((x) => ({ ...x, readAt: x.readAt ?? now })) } : cur));
    } catch (e) {
      setError(describeError(e));
    }
  };
  const toggleEmail = async () => {
    if (!prefs.data) return;
    try {
      prefs.setData(await notificationsApi.setPrefs({ emailEnabled: !prefs.data.emailEnabled }));
    } catch (e) {
      setError(describeError(e));
    }
  };

  const unread = list.data?.items.filter((n) => !n.readAt).length ?? 0;

  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1>通知</h1>
          <div className="row"><ModuleBadge module="notification" /><ModuleBadge module="email" /></div>
        </div>
        <button type="button" className="btn" disabled={!unread} onClick={() => void markAll()}>全部标为已读</button>
      </div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>通知设置</h2>
        {prefs.error && <p className="subtle">{prefs.error}</p>}
        {prefs.data && (
          <div className="stack">
            <label className="checkbox">
              <input type="checkbox" checked={prefs.data.emailEnabled} onChange={() => void toggleEmail()} />
              有人评论或点赞我的照片时发邮件{sns ? '（需要点击确认邮件后才开始投递）' : ''}
            </label>
            {sns && prefs.data.sns && <span className="subtle">SNS 订阅状态：{prefs.data.sns.status}{prefs.data.sns.endpoint ? ` · ${prefs.data.sns.endpoint}` : ''}</span>}
            {caps.modules.email?.driver === 'outbox' && (
              <span className="subtle">本站未启用真实邮件：通知邮件写入本地 outbox，可在 <Link to="/me/outbox">我的邮件</Link> 查看。</span>
            )}
          </div>
        )}
      </div>

      {list.loading && !list.data && <div className="skeleton" style={{ height: 120 }} />}
      {list.error && <p className="notice notice-error" role="alert">{list.error}</p>}
      {list.data && list.data.items.length === 0 && <p className="muted">没有通知。</p>}
      {list.data && list.data.items.length > 0 && (
        <ul className="list-plain card" aria-label="通知列表">
          {list.data.items.map((n) => (
            <li key={n.id} className={n.readAt ? '' : 'unread'}>
              <div className="row spread">
                <span><span className="badge badge-gray badge-plain">{TYPE_LABEL[n.type] ?? n.type}</span> {n.title}</span>
                <span className="subtle">{timeAgo(n.createdAt)}</span>
              </div>
              <p className="muted" style={{ fontWeight: 400, margin: '4px 0' }}>{n.body}</p>
              <div className="row">
                {n.link && <Link to={n.link} onClick={() => void markRead(n)}>打开</Link>}
                {!n.readAt && <button type="button" className="btn btn-sm btn-ghost" onClick={() => void markRead(n)}>标为已读</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
