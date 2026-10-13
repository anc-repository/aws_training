// /lab/results（总纲 8.1）：全部实验结果列表（lab_results，由 npm run exp -- … --upload 上传），可勾选两条进入对比。
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { LabResultRow } from '../api/types';
import { useAuth } from '../auth/context';
import { fmtTime } from '../util/format';
import { LabTabs, useLabResults } from './LabHome';
import { headlineMetric } from './labUtil';

export function ResultsTable({ rows, selectable = false, selected = [], onToggle }: {
  rows: readonly LabResultRow[];
  selectable?: boolean;
  selected?: readonly string[];
  onToggle?: (runId: string) => void;
}) {
  if (!rows.length) return <p className="muted">还没有实验结果。用 <code>npm run exp -- &lt;module&gt; --label before --upload</code> 上传。</p>;
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {selectable && <th><span className="visually-hidden">选择</span></th>}
            <th>开始时间</th><th>模块</th><th>实验</th><th>标签</th><th>关键指标</th><th>环境</th><th>runId</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const h = headlineMetric(r.result);
            return (
              <tr key={r.runId} className={selected.includes(r.runId) ? 'selected' : ''}>
                {selectable && (
                  <td><input type="checkbox" aria-label={`选择 ${r.runId}`} checked={selected.includes(r.runId)} onChange={() => onToggle?.(r.runId)} /></td>
                )}
                <td className="num">{fmtTime(r.startedAt)}</td>
                <td><Link to={`/lab/m/${r.module}`} className="mono">{r.module}</Link></td>
                <td className="mono">{r.experiment}</td>
                <td>{r.label}{r.forced ? <span className="badge badge-red badge-plain" style={{ marginLeft: 4 }} title="--force：前置断言不满足仍强制运行">forced</span> : null}</td>
                <td className="num">{h ? `${h.name} = ${h.stats.p95?.toFixed(1)} ms` : '—'}</td>
                <td className="mono wrap-any">{r.result?.environment?.drivers ? Object.entries(r.result.environment.drivers).map(([k, v]) => `${k}=${v}`).join(' ') : r.result?.environment?.profile ?? '—'}</td>
                <td className="mono">{r.runId.slice(-10)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LabResults() {
  const auth = useAuth();
  const navigate = useNavigate();
  const results = useLabResults(auth.isAdmin);
  const [module, setModule] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const rows = useMemo(() => {
    const all = [...(results.data?.items ?? [])].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return module ? all.filter((r) => r.module === module) : all;
  }, [results.data, module]);
  const modules = [...new Set((results.data?.items ?? []).map((r) => r.module))].sort();
  const toggle = (runId: string) => setSelected((cur) => (cur.includes(runId) ? cur.filter((x) => x !== runId) : [...cur, runId].slice(-2)));

  return (
    <>
      <div className="page-head"><h1>实验结果</h1></div>
      <LabTabs />
      {!auth.isAdmin && <p className="notice">实验结果列表仅管理员可见。</p>}
      {auth.isAdmin && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <label htmlFor="res-module" className="subtle">模块</label>
            <select id="res-module" className="input" style={{ width: 'auto' }} value={module} onChange={(e) => setModule(e.target.value)}>
              <option value="">全部</option>
              {modules.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button
              type="button"
              className="btn btn-primary"
              disabled={selected.length !== 2}
              onClick={() => navigate(`/lab/compare?a=${encodeURIComponent(selected[0]!)}&b=${encodeURIComponent(selected[1]!)}`)}
            >
              对比所选两条
            </button>
            <span className="subtle">已选 {selected.length} / 2</span>
          </div>
          {results.loading && !results.data && <div className="skeleton" style={{ height: 160 }} />}
          {results.error && <p className="notice notice-error" role="alert">{results.error}</p>}
          {results.data && <ResultsTable rows={rows} selectable selected={selected} onToggle={toggle} />}
        </>
      )}
    </>
  );
}
