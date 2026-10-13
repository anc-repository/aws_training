// 路径追踪抽屉（总纲 7.4 第 2～4 条）：页面底部可折叠；管理员默认可见，其他人用 ?trace=1 打开（EXPOSE_PATH_HEADERS=all 时才有内容）。
// 每行一个请求：方法、路由、状态、总耗时与路径芯片；点开一行看瀑布图；勾选两行并排比较各段耗时。
// /lab/trace 是它的全屏版（同一个 TracePanel）。
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthOptional } from '../auth/context';
import { useCapabilities } from '../capabilities/useCapability';
import { usePrefs } from '../prefs';
import { PathChips } from './PathChips';
import { clearTraces, useTraces, type TraceEntry } from './TraceStore';
import { compareSegments, Waterfall } from './Waterfall';

function statusClass(s: number): string {
  return s >= 200 && s < 400 ? 'status-ok' : 'status-err';
}

function fmtMs(v: number | undefined): string {
  return v === undefined ? '—' : `${v.toFixed(1)}`;
}

export function TracePanel({ full = false, onClose }: { full?: boolean; onClose?: () => void }) {
  const { entries } = useTraces();
  const { caps } = useCapabilities();
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [filter, setFilter] = useState('');

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? entries.filter((e) => `${e.method} ${e.route} ${e.pathRaw}`.toLowerCase().includes(f)) : entries;
  }, [entries, filter]);
  const sel = entries.find((e) => e.id === selected) ?? null;
  const pair = checked.map((id) => entries.find((e) => e.id === id)).filter((e): e is TraceEntry => Boolean(e));

  const toggleCheck = (id: number) => {
    setChecked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2)));
  };

  return (
    <>
      <div className="trace-head">
        <strong>路径追踪</strong>
        <span className="subtle">最近 {entries.length} 个请求 · 灰=本地 橙=AWS 绿=命中 红=错误 紫=旁路</span>
        <span className="header-spacer" />
        <input
          className="input"
          style={{ width: 180, minHeight: 28 }}
          placeholder="筛选路由或路径"
          aria-label="筛选请求"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="btn btn-sm" onClick={() => { clearTraces(); setSelected(null); setChecked([]); }}>清空</button>
        {!full && <Link className="btn btn-sm" to="/lab/trace" onClick={onClose}>全屏</Link>}
        {onClose && <button type="button" className="btn btn-sm" onClick={onClose} aria-expanded="true">收起</button>}
      </div>
      <div className="trace-body" style={full ? { minHeight: '60vh' } : undefined}>
        <div className="trace-list" role="list" aria-label="请求列表">
          {list.length === 0 && <p className="subtle" style={{ padding: 12 }}>还没有请求。浏览页面后，这里会列出每个 API 请求经过的路径。</p>}
          {list.map((e) => {
            const total = e.serverTiming.find((m) => m.name === 'total')?.dur;
            return (
              <div
                key={e.id}
                role="listitem"
                className={`trace-row ${selected === e.id ? 'selected' : ''}`}
                onClick={() => setSelected(e.id)}
                onKeyDown={(ev) => { if (ev.key === 'Enter') setSelected(e.id); }}
                tabIndex={0}
                aria-label={`${e.method} ${e.route} ${e.status}`}
              >
                <input
                  type="checkbox"
                  aria-label="选中以对比"
                  checked={checked.includes(e.id)}
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={() => toggleCheck(e.id)}
                />
                <span className="mono">{e.method}</span>
                <span className="route">{e.route}{e.label ? <span className="badge badge-blue badge-plain" style={{ marginLeft: 4 }}>{e.label}</span> : null}</span>
                <span className={`num ${statusClass(e.status)}`}>{e.status || 'ERR'}</span>
                <span className="num" style={{ textAlign: 'right' }} title="服务端 total / 浏览器侧">{fmtMs(total ?? e.durationMs)} ms</span>
                <span className="chips"><PathChips path={e.path} caps={caps} showMeta={false} /></span>
              </div>
            );
          })}
        </div>
        <div className="trace-detail">
          {pair.length === 2 ? <ComparePair a={pair[0]!} b={pair[1]!} /> : sel ? <TraceDetail entry={sel} /> : (
            <p className="subtle">点一行看瀑布图；勾选两行并排比较（例如同一接口带与不带 X-Compare-Bypass: cache）。</p>
          )}
        </div>
      </div>
    </>
  );
}

function TraceDetail({ entry }: { entry: TraceEntry }) {
  const { caps } = useCapabilities();
  return (
    <div className="stack">
      <div className="row">
        <strong className="mono">{entry.method} {entry.route}</strong>
        <span className={statusClass(entry.status)}>{entry.status || '网络错误'}</span>
        {entry.bypassed.length > 0 && <span className="badge badge-purple">已旁路：{entry.bypassed.join(',')}</span>}
      </div>
      <PathChips path={entry.path} caps={caps} />
      <Waterfall entry={entry} caps={caps} />
      <dl className="kv">
        <dt>请求 ID</dt><dd className="mono">{entry.requestId ?? '—'}</dd>
        <dt>X-CloudAlbum-Path</dt><dd className="mono">{entry.pathRaw || '（无，或 EXPOSE_PATH_HEADERS 不允许当前用户看到）'}</dd>
        <dt>Server-Timing</dt>
        <dd className="mono">{entry.serverTiming.map((m) => `${m.name}${m.dur !== undefined ? `;dur=${m.dur}` : ''}${m.desc ? `;desc="${m.desc}"` : ''}`).join(', ') || '—'}</dd>
        <dt>浏览器侧</dt><dd className="num">{entry.durationMs.toFixed(1)} ms（至响应头）</dd>
        {entry.error && (<><dt>错误</dt><dd>{entry.error}</dd></>)}
        <dt>URL</dt><dd className="mono wrap-any">{entry.url}</dd>
      </dl>
    </div>
  );
}

function ComparePair({ a, b }: { a: TraceEntry; b: TraceEntry }) {
  const rows = compareSegments(a, b);
  return (
    <div className="stack">
      <strong>两两对比</strong>
      <p className="subtle">A：{a.method} {a.route} {a.label ?? ''} · B：{b.method} {b.route} {b.label ?? ''}</p>
      <div className="table-scroll">
        <table className="table">
          <thead><tr><th>段</th><th>A ms</th><th>B ms</th><th>B − A</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td className="mono">{r.name}</td>
                <td className="num">{fmtMs(r.a)}</td>
                <td className="num">{fmtMs(r.b)}</td>
                <td className="num">{r.delta === undefined ? '—' : `${r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : ''} ${Math.abs(r.delta).toFixed(1)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="stack">
        <span className="subtle">A 的路径</span><PathChips path={a.path} />
        <span className="subtle">B 的路径</span><PathChips path={b.path} />
      </div>
    </div>
  );
}

export function TraceDrawer() {
  const auth = useAuthOptional();
  const prefs = usePrefs();
  const { entries } = useTraces();
  const [open, setOpen] = useState(false);
  const visible = Boolean(auth?.isAdmin) || prefs.traceEnabled;
  if (!visible) return null;
  if (!open) {
    return (
      <button type="button" className="btn trace-toggle" onClick={() => setOpen(true)} aria-expanded="false">
        路径追踪 · {entries.length}
      </button>
    );
  }
  return (
    <section className="trace-drawer" aria-label="路径追踪">
      <TracePanel onClose={() => setOpen(false)} />
    </section>
  );
}
