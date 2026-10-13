// /lab/compare?a=<runId>&b=<runId>（总纲 8.1）：两次运行的并排对比——环境差异（哪些驱动变了）与关键指标差值。
// before / after 用中性灰对青瓷，不用红绿：“启用后变慢”也可能是正确结论（例如 RDS 的单查询延迟）。
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { labApi } from '../api/endpoints';
import type { ExperimentResult, LabResultRow, LatencyStats } from '../api/types';
import { useAsync } from '../hooks/useAsync';
import { LabTabs } from './LabHome';

interface Row {
  group: string;
  name: string;
  a?: number;
  b?: number;
  unit: string;
}

function statRows(group: string, a: Record<string, LatencyStats> | undefined, b: Record<string, LatencyStats> | undefined): Row[] {
  const names = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out: Row[] = [];
  for (const n of names) {
    for (const k of ['p50', 'p95', 'p99'] as const) {
      const va = a?.[n]?.[k];
      const vb = b?.[n]?.[k];
      if (va === undefined && vb === undefined) continue;
      out.push({ group, name: `${n} ${k}`, ...(va !== undefined ? { a: va } : {}), ...(vb !== undefined ? { b: vb } : {}), unit: 'ms' });
    }
  }
  return out;
}

function numRows(group: string, a: Record<string, number> | undefined, b: Record<string, number> | undefined): Row[] {
  const names = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...names].map((n) => ({ group, name: n, ...(a?.[n] !== undefined ? { a: a[n] } : {}), ...(b?.[n] !== undefined ? { b: b[n] } : {}), unit: '' }));
}

export function compareRows(a: ExperimentResult | undefined, b: ExperimentResult | undefined): Row[] {
  return [
    ...statRows('客户端', a?.client?.latencyMs, b?.client?.latencyMs),
    ...statRows('服务端路由', a?.server?.routes, b?.server?.routes),
    ...statRows('端口', a?.server?.ports, b?.server?.ports),
    ...numRows('主机', a?.server?.host, b?.server?.host),
    ...numRows('业务', a?.server?.business, b?.server?.business),
  ];
}

export function driverDiff(a: ExperimentResult | undefined, b: ExperimentResult | undefined): Array<{ module: string; a?: string; b?: string }> {
  const da = a?.environment?.drivers ?? {};
  const db = b?.environment?.drivers ?? {};
  const names = new Set([...Object.keys(da), ...Object.keys(db)]);
  return [...names].filter((n) => da[n] !== db[n]).map((n) => ({ module: n, ...(da[n] ? { a: da[n] } : {}), ...(db[n] ? { b: db[n] } : {}) }));
}

export function LabCompare() {
  const [params] = useSearchParams();
  const aId = params.get('a') ?? '';
  const bId = params.get('b') ?? '';
  const load = useCallback(async (): Promise<[LabResultRow, LabResultRow]> => Promise.all([labApi.result(aId), labApi.result(bId)]), [aId, bId]);
  const pair = useAsync(load, { enabled: Boolean(aId && bId) });
  const [a, b] = pair.data ?? [];
  const rows = compareRows(a?.result, b?.result);
  const diff = driverDiff(a?.result, b?.result);
  const comparable = a && b && a.experiment === b.experiment && a.module === b.module;

  return (
    <>
      <div className="page-head"><h1>对比两次运行</h1></div>
      <LabTabs />
      {!aId || !bId ? <p className="notice">请在“实验结果”中勾选两条。</p> : null}
      {pair.loading && <div className="skeleton" style={{ height: 200 }} />}
      {pair.error && <p className="notice notice-error" role="alert">{pair.error}</p>}
      {a && b && (
        <div className="stack">
          {!comparable && <p className="notice notice-warn">两次运行不是同一模块的同一实验，差值只供参考。</p>}
          {(a.forced || b.forced) && <p className="notice notice-error">其中一次是 --force 运行（前置断言不满足），结论不可靠。</p>}
          <dl className="kv">
            <dt>A</dt><dd className="mono">{a.module} · {a.experiment} · {a.label} · {a.runId}</dd>
            <dt>B</dt><dd className="mono">{b.module} · {b.experiment} · {b.label} · {b.runId}</dd>
          </dl>
          <h2>环境差异</h2>
          {diff.length === 0 ? <p className="muted">驱动没有变化。</p> : (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>模块</th><th>A</th><th>B</th></tr></thead>
                <tbody>{diff.map((d) => <tr key={d.module}><td className="mono">{d.module}</td><td className="mono">{d.a ?? '—'}</td><td className="mono">{d.b ?? '—'}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <h2>指标</h2>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>类别</th><th>指标</th><th>A</th><th>B</th><th>差值</th><th>比值</th><th>示意</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const max = Math.max(r.a ?? 0, r.b ?? 0, 1e-9);
                  const delta = r.a !== undefined && r.b !== undefined ? r.b - r.a : undefined;
                  return (
                    <tr key={`${r.group}-${r.name}`}>
                      <td>{r.group}</td>
                      <td className="mono">{r.name}</td>
                      <td className="num">{r.a?.toFixed(2) ?? '—'}</td>
                      <td className="num">{r.b?.toFixed(2) ?? '—'}</td>
                      <td className="num">{delta === undefined ? '—' : `${delta > 0 ? '▲' : delta < 0 ? '▼' : '＝'} ${Math.abs(delta).toFixed(2)}${r.unit ? ` ${r.unit}` : ''}`}</td>
                      <td className="num">{r.a && r.b !== undefined ? `×${(r.b / r.a).toFixed(2)}` : '—'}</td>
                      <td style={{ minWidth: 120 }}>
                        <div className="bars">
                          <span className="bar-track"><span className="bar-fill before" style={{ width: `${((r.a ?? 0) / max) * 100}%` }} /></span>
                          <span className="bar-track"><span className="bar-fill after" style={{ width: `${((r.b ?? 0) / max) * 100}%` }} /></span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && <tr><td colSpan={7} className="muted">结果里没有可比较的指标。</td></tr>}
              </tbody>
            </table>
          </div>
          {(a.result?.notes || b.result?.notes) && <p className="subtle">备注：A {a.result?.notes ?? '—'} · B {b.result?.notes ?? '—'}</p>}
        </div>
      )}
    </>
  );
}
