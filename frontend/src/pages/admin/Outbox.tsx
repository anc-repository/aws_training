// 管理后台 · 邮件（/admin/outbox，email=outbox 时出现；ses 时显示发送记录与投递状态，沙箱拒信标红）。
import { useCallback, useState } from 'react';
import { describeError } from '../../api/client';
import { adminApi } from '../../api/endpoints';
import type { OutboxEmailDetail } from '../../api/types';
import { ModuleBadge } from '../../capabilities/ModuleBadge';
import { MailPreview } from '../../components/MailPreview';
import { useAsync } from '../../hooks/useAsync';
import { timeAgo } from '../../util/format';

export function AdminOutbox() {
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState<{ to?: string; category?: string; status?: string }>({});
  const load = useCallback(() => adminApi.outbox(filter), [filter]);
  const list = useAsync(load);
  const [open, setOpen] = useState<OutboxEmailDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = async (id: string) => {
    setError(null);
    try {
      setOpen(await adminApi.outboxMessage(id));
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <section aria-label="邮件">
      <div className="row" style={{ marginBottom: 12 }}><ModuleBadge module="email" /></div>
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          setFilter({ ...(to.trim() ? { to: to.trim() } : {}), ...(category ? { category } : {}), ...(status ? { status } : {}) });
        }}
      >
        <label className="visually-hidden" htmlFor="ob-to">收件人</label>
        <input id="ob-to" className="input" style={{ maxWidth: 220 }} placeholder="收件人" value={to} onChange={(e) => setTo(e.target.value)} />
        <label className="visually-hidden" htmlFor="ob-cat">类别</label>
        <select id="ob-cat" className="input" style={{ width: 'auto' }} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">全部类别</option>
          <option value="verification">邮箱验证</option>
          <option value="password-reset">重置密码</option>
          <option value="notification">通知</option>
          <option value="report">日报</option>
          <option value="system">系统</option>
        </select>
        <label className="visually-hidden" htmlFor="ob-status">状态</label>
        <select id="ob-status" className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="queued">queued</option>
          <option value="sent">sent</option>
          <option value="failed">failed</option>
        </select>
        <button type="submit" className="btn">筛选</button>
      </form>
      {list.error && <p className="notice notice-error" role="alert">{list.error}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="photo-layout">
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>时间</th><th>收件人</th><th>主题</th><th>类别</th><th>方式</th><th>状态</th></tr></thead>
            <tbody>
              {list.data?.items.map((m) => (
                <tr key={m.id} className={`clickable ${open?.id === m.id ? 'selected' : ''}`} onClick={() => void show(m.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') void show(m.id); }}>
                  <td className="num">{timeAgo(m.createdAt)}</td>
                  <td className="mono wrap-any">{m.to.join(', ')}</td>
                  <td>{m.subject}</td>
                  <td>{m.category}</td>
                  <td>{m.transport}</td>
                  <td className={m.status === 'failed' || ['bounced', 'complained', 'rejected'].includes(m.deliveryStatus) ? 'status-err' : ''}>
                    {m.status}{m.deliveryStatus !== 'none' ? ` · ${m.deliveryStatus}` : ''}
                  </td>
                </tr>
              ))}
              {list.data && list.data.items.length === 0 && <tr><td colSpan={6} className="muted">没有邮件。</td></tr>}
            </tbody>
          </table>
        </div>
        <aside>{open ? <div className="card"><MailPreview mail={open} /></div> : <p className="subtle">点一行预览正文（iframe sandbox，禁止脚本与外部资源）。</p>}</aside>
      </div>
    </section>
  );
}
