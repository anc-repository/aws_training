// 运行 A/B（总纲 8.3）：同一部署里交替发送不带 / 带 X-Compare-Bypass 的请求（标签 A / B），比较服务端 total 与浏览器侧耗时。
// 只覆盖“无副作用”的只读路由；需要上传的键（queue、image、tagger）请用 experiments 运行器。
import { useState } from 'react';
import { HEADERS, parseServerTiming, type BypassKey } from '@cloudalbum/contracts';
import { apiFetch, describeError } from '../api/client';
import { photosApi } from '../api/endpoints';
import { percentile } from './labUtil';

interface Sample {
  label: 'A' | 'B';
  total: number;
  browser: number;
  status: number;
  path: string;
}

/** 每个旁路键用哪个只读请求做 A/B（与后端 BYPASS_ROUTES 白名单一致） */
export async function abTarget(key: BypassKey | string): Promise<{ method: string; path: string } | null> {
  switch (key) {
    case 'cache':
    case 'replica':
    case 'cdn':
    case 'tracing':
    case 'analytics':
      return { method: 'GET', path: '/api/feed' };
    case 'kms': {
      const feed = await photosApi.feed();
      const p = feed.items[0];
      return p ? { method: 'GET', path: `/api/photos/${encodeURIComponent(p.id)}` } : null;
    }
    case 'identity-pool':
      return { method: 'POST', path: '/api/uploads/session' };
    default:
      return null;
  }
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function AbRunner({ keys, defaultKey }: { keys: readonly string[]; defaultKey?: string }) {
  const [key, setKey] = useState(defaultKey ?? keys[0] ?? 'cache');
  const [rounds, setRounds] = useState(10);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setSamples([]);
    try {
      const target = await abTarget(key);
      if (!target) throw new Error(`旁路键 ${key} 没有可以直接重复调用的只读路由；请用 npm run exp -- <module> --ab`);
      const out: Sample[] = [];
      for (let i = 0; i < rounds; i += 1) {
        for (const label of (i % 2 === 0 ? ['A', 'B'] : ['B', 'A']) as Array<'A' | 'B'>) {
          const t0 = now();
          const res = await apiFetch(target.path, {
            method: target.method,
            traceLabel: label === 'A' ? 'A/B · A' : `A/B · B（旁路 ${key}）`,
            ...(label === 'B' ? { bypass: [key] } : {}),
          });
          const browser = now() - t0;
          await res.text().catch(() => '');
          if (res.status === 403 || res.status === 400) throw new Error(`后端拒绝了旁路请求（HTTP ${res.status}）：需要管理员身份，且 runtime 配置 labBypassEnabled=true`);
          const total = parseServerTiming(res.headers.get(HEADERS.serverTiming)).find((m) => m.name === 'total')?.dur ?? browser;
          out.push({ label, total, browser, status: res.status, path: res.headers.get(HEADERS.path) ?? '' });
          setSamples([...out]);
        }
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRunning(false);
    }
  };

  const stats = (label: 'A' | 'B') => {
    const xs = samples.filter((s) => s.label === label);
    return {
      n: xs.length,
      p50: percentile(xs.map((s) => s.total), 50),
      p95: percentile(xs.map((s) => s.total), 95),
      b50: percentile(xs.map((s) => s.browser), 50),
      path: xs[xs.length - 1]?.path ?? '',
    };
  };
  const a = stats('A');
  const b = stats('B');
  const max = Math.max(1, a.p95, b.p95);

  return (
    <div className="stack">
      <p className="subtle">交替发送 A（正常）与 B（带 <code>X-Compare-Bypass: {key}</code>）请求；旁路请求写入审计日志，每个管理员每分钟最多 120 个。</p>
      <div className="row">
        <label htmlFor="ab-key" className="subtle">旁路键</label>
        <select id="ab-key" className="input" style={{ width: 'auto' }} value={key} onChange={(e) => setKey(e.target.value)}>
          {keys.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <label htmlFor="ab-rounds" className="subtle">轮数</label>
        <input id="ab-rounds" className="input" type="number" min={1} max={50} style={{ width: 80 }} value={rounds} onChange={(e) => setRounds(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
        <button type="button" className="btn btn-primary" disabled={running} onClick={() => void run()}>{running ? `运行中…（${samples.length}/${rounds * 2}）` : '开始'}</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {samples.length > 0 && (
        <>
          <div className="bars" aria-label="服务端 total p95">
            {([['A', a], ['B', b]] as const).map(([label, s]) => (
              <div key={label} className="bar-row">
                <span>{label === 'A' ? 'A 正常' : 'B 旁路'}</span>
                <span className="bar-track"><span className={`bar-fill ${label === 'A' ? 'after' : 'before'}`} style={{ width: `${(s.p95 / max) * 100}%` }} /></span>
                <span className="num">{s.p95.toFixed(1)} ms</span>
              </div>
            ))}
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th /><th>次数</th><th>服务端 p50</th><th>服务端 p95</th><th>浏览器 p50</th><th>最后一次路径</th></tr></thead>
              <tbody>
                {([['A', a], ['B', b]] as const).map(([label, s]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="num">{s.n}</td>
                    <td className="num">{s.p50.toFixed(1)}</td>
                    <td className="num">{s.p95.toFixed(1)}</td>
                    <td className="num">{s.b50.toFixed(1)}</td>
                    <td className="mono wrap-any">{s.path || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="subtle">逐请求明细在“路径追踪”抽屉中（标签 A/B · A、A/B · B），可勾选两行并排对比各段耗时。</p>
        </>
      )}
    </div>
  );
}
