// 管理后台 · 审计（audit_log，AUDIT_MODE=app 只记录应用内操作；aws_principal 用来和 CloudTrail 对照）。
// “校验哈希链”调用 GET /api/admin/audit/verify。
import { useCallback, useState } from 'react';
import { describeError } from '../../api/client';
import { adminApi } from '../../api/endpoints';
import type { AuditVerifyResult } from '../../api/types';
import { ModuleBadge } from '../../capabilities/ModuleBadge';
import { useAsync } from '../../hooks/useAsync';
import { fmtTime } from '../../util/format';

export function AdminAudit() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [filter, setFilter] = useState<{ actor?: string; action?: string }>({});
  const load = useCallback(() => adminApi.audit(filter), [filter]);
  const list = useAsync(load);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runVerify = async () => {
    setError(null);
    try {
      setVerify(await adminApi.auditVerify());
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <section aria-label="审计" className="stack">
      <div className="row spread">
        <ModuleBadge module="audit" />
        <button type="button" className="btn btn-sm" onClick={() => void runVerify()}>校验哈希链</button>
      </div>
      {verify && (
        <p className={`notice ${verify.ok ? 'notice-ok' : 'notice-error'}`}>
          {verify.ok ? `哈希链完整：已校验 ${verify.checked} 条` : `哈希链在 ${verify.brokenAt ?? '未知位置'} 处断开（已校验 ${verify.checked} 条）`}
          {verify.detail ? ` · ${verify.detail}` : ''}
        </p>
      )}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); setFilter({ ...(actor.trim() ? { actor: actor.trim() } : {}), ...(action.trim() ? { action: action.trim() } : {}) }); }}>
        <label className="visually-hidden" htmlFor="au-actor">操作者</label>
        <input id="au-actor" className="input" style={{ maxWidth: 220 }} placeholder="操作者（ID 或邮箱）" value={actor} onChange={(e) => setActor(e.target.value)} />
        <label className="visually-hidden" htmlFor="au-action">动作</label>
        <input id="au-action" className="input" style={{ maxWidth: 220 }} placeholder="动作，例如 lab.bypass" value={action} onChange={(e) => setAction(e.target.value)} />
        <button type="submit" className="btn">筛选</button>
      </form>
      {list.error && <p className="notice notice-error" role="alert">{list.error}</p>}
      <div className="table-scroll">
        <table className="table">
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th><th>来源 IP</th><th>AWS 身份</th><th>请求 ID</th><th>详情</th></tr></thead>
          <tbody>
            {list.data?.items.map((a) => (
              <tr key={String(a.id)}>
                <td className="num">{fmtTime(a.ts)}</td>
                <td>{a.actorType}{a.actorEmail ? <div className="mono subtle wrap-any">{a.actorEmail}</div> : null}</td>
                <td className="mono">{a.action}</td>
                <td className="mono wrap-any">{a.targetType ? `${a.targetType}:${a.targetId ?? ''}` : '—'}</td>
                <td className={a.result === 'success' ? '' : 'status-err'}>{a.result}</td>
                <td className="mono">{a.sourceIp ?? '—'}</td>
                <td className="mono wrap-any">{a.awsPrincipal ?? '—'}</td>
                <td className="mono">{a.requestId ?? '—'}</td>
                <td className="mono wrap-any" style={{ maxWidth: 280 }}>{a.details ? (typeof a.details === 'string' ? a.details : JSON.stringify(a.details)) : ''}</td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && <tr><td colSpan={9} className="muted">没有记录。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
