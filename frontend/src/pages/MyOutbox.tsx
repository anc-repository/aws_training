// /me/outbox（email=outbox 档）：只显示收件人是本人的邮件（不含 password-reset 类别）。注册后的受限会话也能访问，
// 所以“注册 → 打开 /me/outbox → 点击验证链接”一个人就能走完（总纲 2.9 第 2 条）。
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { meApi } from '../api/endpoints';
import type { OutboxEmailDetail } from '../api/types';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { useCaps } from '../capabilities/useCapability';
import { MailPreview } from '../components/MailPreview';
import { useAsync } from '../hooks/useAsync';
import { timeAgo } from '../util/format';

const CATEGORY: Record<string, string> = {
  verification: '邮箱验证', 'password-reset': '重置密码', notification: '通知', report: '日报', system: '系统',
};

export function MyOutboxPage() {
  const caps = useCaps();
  const load = useCallback(() => meApi.outbox(20), []);
  const list = useAsync(load);
  const [open, setOpen] = useState<OutboxEmailDetail | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const ses = caps.modules.email?.driver === 'ses';
  const disabled = list.errorObj instanceof ApiError && list.errorObj.status === 403 || list.data?.selfPreview === false;

  const show = async (id: string) => {
    setOpenError(null);
    try {
      setOpen(await meApi.outboxMessage(id));
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1>我的邮件</h1>
          <ModuleBadge module="email" />
        </div>
        <button type="button" className="btn" onClick={() => void list.reload()}>刷新</button>
      </div>
      {ses ? (
        <p className="notice">邮件已由 Amazon SES 发出，请查收邮箱；这里只列出发送记录（被沙箱策略改写进 outbox 的邮件才有正文）。</p>
      ) : (
        <p className="notice notice-warn"><strong>本地实现，未真正发信：</strong>这些邮件只保存在本站服务器上，没有发到你的邮箱。</p>
      )}
      {disabled && <p className="notice notice-error" role="alert">本站关闭了本人邮件预览（featureFlags['email.selfPreview']=false），请联系管理员在 /admin/outbox 查看。</p>}
      {list.loading && !list.data && <div className="skeleton" style={{ height: 120 }} />}
      {list.error && !disabled && <p className="notice notice-error" role="alert">{list.error}</p>}
      {list.data && list.data.items.length === 0 && <p className="muted">还没有发给你的邮件。注册后的验证邮件会出现在这里。</p>}
      <div className="photo-layout">
        <div>
          {list.data && list.data.items.length > 0 && (
            <ul className="list-plain card" aria-label="邮件列表">
              {list.data.items.map((m) => (
                <li key={m.id}>
                  <button type="button" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'space-between', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => void show(m.id)}>
                    <span><span className="badge badge-gray badge-plain">{CATEGORY[m.category] ?? m.category}</span> {m.subject}</span>
                    <span className="subtle">{timeAgo(m.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside>
          {openError && <p className="notice notice-error">{openError}</p>}
          {open ? <div className="card"><MailPreview mail={open} /></div> : list.data && list.data.items.length > 0 && <p className="subtle">点一封邮件查看正文。</p>}
          <p className="subtle" style={{ marginTop: 12 }}>完成验证后 <Link to="/login">登录</Link>。</p>
        </aside>
      </div>
    </>
  );
}
