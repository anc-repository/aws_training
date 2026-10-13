// 管理后台 · 用户：搜索、设为管理员 / 成员、停用 / 启用（auth=cognito 时后端改调 Admin* API，需要 AWS 凭证）。
import { useCallback, useState } from 'react';
import { describeError } from '../../api/client';
import { adminApi } from '../../api/endpoints';
import type { AdminUser } from '../../api/types';
import { useAuth } from '../../auth/context';
import { useAsync } from '../../hooks/useAsync';
import { fmtTime } from '../../util/format';

export function AdminUsers() {
  const auth = useAuth();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const load = useCallback(() => adminApi.users(query || undefined), [query]);
  const users = useAsync(load);
  const [error, setError] = useState<string | null>(null);

  const update = async (u: AdminUser, patch: { role?: 'admin' | 'member'; disabled?: boolean }) => {
    setError(null);
    try {
      const next = await adminApi.updateUser(u.id, patch);
      users.setData((cur) => (cur ? { ...cur, items: cur.items.map((x) => (x.id === u.id ? next : x)) } : cur));
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <section aria-label="用户">
      <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <label className="visually-hidden" htmlFor="user-q">搜索邮箱或昵称</label>
        <input id="user-q" className="input" style={{ maxWidth: 280 }} placeholder="搜索邮箱或昵称" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn">搜索</button>
      </form>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {users.error && <p className="notice notice-error" role="alert">{users.error}</p>}
      {users.loading && !users.data && <div className="skeleton" style={{ height: 160 }} />}
      {users.data && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>邮箱</th><th>昵称</th><th>角色</th><th>套餐</th><th>来源</th><th>验证</th><th>MFA</th><th>状态</th><th>注册时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id}>
                  <td className="mono wrap-any">{u.email}</td>
                  <td>{u.displayName}</td>
                  <td>{u.role === 'admin' ? '管理员' : '成员'}</td>
                  <td>{u.plan}</td>
                  <td>{u.provider}</td>
                  <td>{u.emailVerified ? '是' : '否'}</td>
                  <td>{u.mfaEnabled ? '开' : '关'}</td>
                  <td>{u.disabled ? <span className="status-err">已停用</span> : u.lockedUntil && Date.parse(u.lockedUntil) > Date.now() ? '锁定中' : '正常'}</td>
                  <td className="num">{fmtTime(u.createdAt)}</td>
                  <td>
                    <div className="row">
                      {u.id !== auth.user?.id && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => void update(u, { role: u.role === 'admin' ? 'member' : 'admin' })}>
                            {u.role === 'admin' ? '设为成员' : '设为管理员'}
                          </button>
                          <button type="button" className={`btn btn-sm ${u.disabled ? '' : 'btn-danger'}`} onClick={() => void update(u, { disabled: !u.disabled })}>
                            {u.disabled ? '启用' : '停用'}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
