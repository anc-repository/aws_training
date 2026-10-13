// /lab（总纲 8.1）：顶栏（档位、部署模式、校验横幅、cost 的“当前计费资源”提示）+ 按 A～F 分组的模块卡片网格。
// 登录用户只读；按钮仅管理员。管理员打开时改用 SSE 实时接收状态变化。
import { useCallback, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { MODULE_IDS, type ModuleGroup, type ModuleId } from '@cloudalbum/contracts';
import { labApi } from '../api/endpoints';
import type { LabResultRow } from '../api/types';
import { useAuth } from '../auth/context';
import { GROUP_LABEL, GROUP_ORDER, MVP_MODULES } from '../capabilities/registry';
import { useCapabilities, useCapabilityStream, useCaps } from '../capabilities/useCapability';
import { useAsync } from '../hooks/useAsync';
import { timeAgo } from '../util/format';
import { ModuleCard } from './ModuleCard';

type Filter = 'all' | 'mvp' | 'enabled';

export function LabTabs() {
  const { isAdmin } = useAuth();
  return (
    <nav className="tabs" aria-label="实验室">
      <NavLink to="/lab" end>模块</NavLink>
      <NavLink to="/lab/results">实验结果</NavLink>
      <NavLink to="/lab/trace">路径追踪</NavLink>
      {isAdmin && <span className="subtle" style={{ padding: '8px 12px' }}>管理员</span>}
    </nav>
  );
}

export function useLabResults(enabled: boolean, module?: string) {
  const load = useCallback(() => labApi.results(module ? { module } : {}), [module]);
  return useAsync(load, { enabled });
}

export function LabHome() {
  const caps = useCaps();
  const { registry, refresh, updatedAt } = useCapabilities();
  const auth = useAuth();
  useCapabilityStream(auth.isAdmin);
  const [filter, setFilter] = useState<Filter>('all');
  const [probing, setProbing] = useState(false);
  const results = useLabResults(auth.isAdmin);

  const byModule = useMemo(() => {
    const m = new Map<string, LabResultRow[]>();
    for (const r of results.data?.items ?? []) {
      const list = m.get(r.module) ?? [];
      list.push(r);
      m.set(r.module, list);
    }
    for (const list of m.values()) list.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return m;
  }, [results.data]);

  if (!registry) return <div className="skeleton" style={{ height: 320 }} aria-busy="true" />;

  const groups = new Map<ModuleGroup, ModuleId[]>();
  for (const id of MODULE_IDS) {
    const reg = registry.modules[id];
    const cap = caps.modules[id];
    if (!reg || !cap) continue;
    if (filter === 'mvp' && id !== 'ec2' && !MVP_MODULES.includes(id)) continue;
    if (filter === 'enabled' && id !== 'ec2' && cap.status === 'off') continue;
    const list = groups.get(reg.group) ?? [];
    list.push(id);
    groups.set(reg.group, list);
  }
  const enabledCount = MODULE_IDS.filter((id) => id !== 'ec2' && caps.modules[id]?.status !== 'off').length;
  const degraded = MODULE_IDS.filter((id) => ['degraded', 'error'].includes(caps.modules[id]?.status ?? '') || ['degraded', 'error'].includes(caps.modules[id]?.localHealth ?? ''));
  const cost = caps.modules.cost;

  const deepProbe = async () => {
    setProbing(true);
    try {
      await refresh({ deep: true });
    } finally {
      setProbing(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>对比实验室</h1>
        <div className="row">
          {auth.isAdmin && <button type="button" className="btn btn-sm" disabled={probing} onClick={() => void deepProbe()}>{probing ? '探测中…' : '深度探针'}</button>}
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>刷新</button>
        </div>
      </div>
      <LabTabs />
      <div className="lab-top">
        <span>档位 <strong className="mono">{caps.app.profile}</strong></span>
        <span>部署 <strong>{caps.app.deployMode}</strong></span>
        <span>区域 <span className="mono">{caps.app.region || '—'}</span></span>
        <span>入口 <span className="mono wrap-any">{caps.app.entry.baseUrl}</span>（{caps.app.entry.source}）</span>
        <span>HTTPS {caps.https.trusted ? `受信 · ${caps.https.via}` : '未受信'}</span>
        <span>已启用 {enabledCount} / {MODULE_IDS.length - 1} 个模块</span>
        {degraded.length > 0 && <span className="status-err">异常：{degraded.join('、')}</span>}
        <span className="subtle">更新于 {timeAgo(new Date(updatedAt).toISOString())}{auth.isAdmin ? ' · SSE 推送（不可用时每 60 秒刷新）' : ' · 每 60 秒刷新'}</span>
      </div>
      {cost && <p className="notice">{cost.status === 'off' ? '费用（本地估算，不是账单）' : '费用（AWS Budgets）'}：{cost.detail}</p>}
      {caps.validation.overridden.length > 0 && <p className="notice notice-error">不安全实验模式：{caps.validation.overridden.map((f) => f.rule).join('、')}</p>}
      {caps.validation.warnings.length > 0 && (
        <details className="notice notice-warn">
          <summary>{caps.validation.warnings.length} 条校验提示</summary>
          <ul>{caps.validation.warnings.map((w) => <li key={`${w.rule}-${w.message}`}><span className="mono">{w.rule}</span> {w.message}</li>)}</ul>
        </details>
      )}
      <div className="row" role="radiogroup" aria-label="筛选模块">
        {([['all', '全部 40 个'], ['mvp', '本轮实现的 8 个 + ec2'], ['enabled', '已启用']] as Array<[Filter, string]>).map(([v, label]) => (
          <label key={v} className="checkbox">
            <input type="radio" name="lab-filter" value={v} checked={filter === v} onChange={() => setFilter(v)} />{label}
          </label>
        ))}
      </div>
      {results.error && auth.isAdmin && <p className="subtle">实验结果暂不可用：{results.error}</p>}
      {GROUP_ORDER.filter((g) => groups.has(g)).map((g) => (
        <section key={g} className="lab-group" aria-label={GROUP_LABEL[g]}>
          <h2>{GROUP_LABEL[g]} <span className="subtle">{groups.get(g)!.length}</span></h2>
          <div className="grid-cards">
            {groups.get(g)!.map((id) => (
              <ModuleCard
                key={id}
                id={id}
                reg={registry.modules[id]}
                cap={caps.modules[id]}
                caps={caps}
                results={byModule.get(id) ?? []}
                isAdmin={auth.isAdmin}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
