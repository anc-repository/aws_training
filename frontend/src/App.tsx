// 脚手架占位页面：只读取 /api/capabilities 并显示各模块的驱动与状态，用于验证前后端联通与路径头解析。
import { useEffect, useState } from 'react';
import { HEADERS, MODULE_IDS, parsePathHeader, type CapabilitiesResponse } from '@cloudalbum/contracts';

export function App() {
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [path, setPath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/capabilities', { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return;
        setPath(res.headers.get(HEADERS.path) ?? '');
        setCaps((await res.json()) as CapabilitiesResponse);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p role="alert">无法读取 /api/capabilities：{error}</p>;
  if (!caps) return <p>加载中…</p>;
  const entry = parsePathHeader(path).entry ?? '未知';
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1>CloudAlbum</h1>
      <p>
        档位 {caps.app.profile} · 部署模式 {caps.app.deployMode} · 入口 {entry}
      </p>
      <table>
        <thead>
          <tr><th>模块</th><th>驱动</th><th>状态</th><th>说明</th></tr>
        </thead>
        <tbody>
          {MODULE_IDS.map((id) => {
            const m = caps.modules[id];
            return (
              <tr key={id}>
                <td>{id}</td>
                <td>{m.driver}</td>
                <td>{m.status === 'off' ? `off（本地：${m.localHealth ?? 'ok'}）` : m.status}</td>
                <td>{m.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
