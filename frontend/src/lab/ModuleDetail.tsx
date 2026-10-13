// /lab/m/:id（总纲 8.1）：状态时间线、开关与依赖、切换前后架构示意、实验列表、本模块历史结果。
import { useParams, Link } from 'react-router-dom';
import { isModuleId, type ModuleId } from '@cloudalbum/contracts';
import { useAuth } from '../auth/context';
import { ModuleBadge } from '../capabilities/ModuleBadge';
import { GROUP_LABEL, MVP_MODULES, typeMark } from '../capabilities/registry';
import { useCapabilities, useCapabilityStream, useCaps } from '../capabilities/useCapability';
import { fmtTime } from '../util/format';
import { AbRunner } from './AbRunner';
import { LabTabs, useLabResults } from './LabHome';
import { COMPARE_LABEL } from './labUtil';
import { DepChips, statusText } from './ModuleCard';
import { ResultsTable } from './Results';
import { StatusTimeline } from './StatusTimeline';
import { SwitchHowTo } from './SwitchHowTo';

export function ModuleDetail() {
  const { id = '' } = useParams();
  const caps = useCaps();
  const { registry } = useCapabilities();
  const auth = useAuth();
  useCapabilityStream(auth.isAdmin);
  const valid = isModuleId(id);
  const results = useLabResults(auth.isAdmin && valid, valid ? id : undefined);

  if (!valid) return <div className="card panel-narrow" role="alert"><h1>没有这个模块</h1><Link to="/lab">返回实验室</Link></div>;
  if (!registry) return <div className="skeleton" style={{ height: 320 }} />;
  const mid = id as ModuleId;
  const reg = registry.modules[mid];
  const cap = caps.modules[mid];
  if (!reg || !cap) return <p className="notice notice-error">capabilities 中没有 {id}</p>;
  const lab = reg.lab ?? {};
  const bypassKeys = cap.bypass ?? reg.bypass ?? [];

  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 4 }}>
          <h1>{reg.function} <span className="mono subtle">{id}</span> <span className="type-mark">{typeMark(reg)}</span></h1>
          <span className="subtle">{GROUP_LABEL[reg.group]} · {reg.awsService}{reg.auxServices.length ? `（辅助：${reg.auxServices.join('、')}）` : ''}</span>
        </div>
        <Link className="btn btn-sm" to="/lab">返回全部模块</Link>
      </div>
      <LabTabs />
      {id !== 'ec2' && !MVP_MODULES.includes(mid) && (
        <p className="notice notice-warn">本轮（MVP）还没有实现这个模块的 AWS 适配器：registry 保留元数据，启用后应用启动时以退出码 78 拒绝。</p>
      )}
      <div className="photo-layout">
        <div className="stack">
          <section className="card stack" aria-label="当前状态">
            <div className="row">
              <ModuleBadge module={mid} always plain />
              <span><span className={`status-dot ${cap.status}`} />{statusText(cap)}</span>
              <span className="subtle">驱动 <span className="mono">{cap.driver || '—'}</span></span>
              {cap.confidence && <span className="subtle">置信度 {cap.confidence}</span>}
              {cap.latencyMs !== undefined && <span className="subtle num">探针 {cap.latencyMs} ms</span>}
            </div>
            <p className="wrap-any" style={{ margin: 0 }}>{cap.detail}</p>
            <dl className="kv">
              {cap.switch && (<><dt>开关</dt><dd className="mono">{cap.switch.var}={cap.switch.value || '""'}（本地取值 {cap.switch.localValue || '""'}）</dd></>)}
              <dt>状态起始</dt><dd>{fmtTime(cap.since)}</dd>
              <dt>最近探针</dt><dd>{fmtTime(cap.lastProbeAt)}</dd>
              <dt>旁路键</dt><dd className="mono">{bypassKeys.length ? bypassKeys.join(', ') : '无（不支持运行时 A/B）'}</dd>
              <dt>对比方式</dt><dd>{lab.compare ? COMPARE_LABEL[lab.compare] ?? lab.compare : '—'}{lab.sideBySide ? ' · 另有同部署侧路对比' : ''}</dd>
            </dl>
            <DepChips id={mid} reg={reg} cap={cap} caps={caps} />
            {cap.checks && cap.checks.length > 0 && (
              <div className="table-scroll">
                <table className="table">
                  <thead><tr><th>检查项</th><th>状态</th><th>说明</th></tr></thead>
                  <tbody>{cap.checks.map((c) => <tr key={c.id}><td className="mono">{c.id}</td><td>{c.status}</td><td>{c.detail}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card stack" aria-label="本地实现与 AWS 实现">
            <h2 style={{ marginTop: 0 }}>有 vs 没有</h2>
            {lab.summary?.local && <div className="summary-line"><b>本地实现</b>{lab.summary.local}</div>}
            {lab.summary?.aws && <div className="summary-line"><b>AWS 实现</b>{lab.summary.aws}</div>}
            {lab.diagram && (
              <div className="row" style={{ alignItems: 'stretch' }}>
                {lab.diagram.before && <div style={{ flex: 1, minWidth: 0 }}><span className="subtle">切换前</span><pre>{lab.diagram.before}</pre></div>}
                {lab.diagram.after && <div style={{ flex: 1, minWidth: 0 }}><span className="subtle">切换后</span><pre>{lab.diagram.after}</pre></div>}
              </div>
            )}
            {lab.keyMetrics && lab.keyMetrics.length > 0 && (
              <>
                <strong>关键指标</strong>
                <ul style={{ margin: 0, paddingLeft: 18 }}>{lab.keyMetrics.map((k) => <li key={k}>{k}</li>)}</ul>
              </>
            )}
            {lab.experiments && lab.experiments.length > 0 && (
              <>
                <strong>实验</strong>
                <pre>{lab.experiments.map((e) => `npm run exp -- ${id} --scenario ${e} --label before|after${lab.compare === 'runtime-ab' ? ' [--ab]' : ''}`).join('\n')}</pre>
              </>
            )}
          </section>

          {auth.isAdmin && caps.lab.bypassEnabled && bypassKeys.length > 0 && cap.status !== 'off' && (
            <section className="card" aria-label="运行 A/B">
              <h2 style={{ marginTop: 0 }}>运行 A/B</h2>
              <AbRunner keys={bypassKeys} />
            </section>
          )}

          <section aria-label="历史结果">
            <h2>本模块的实验结果</h2>
            {!auth.isAdmin && <p className="subtle">实验结果仅管理员可见。</p>}
            {results.error && <p className="subtle">{results.error}</p>}
            {results.data && <ResultsTable rows={results.data.items} />}
          </section>
        </div>
        <aside className="stack">
          <section className="card" aria-label="如何切换">
            <h2 style={{ marginTop: 0 }}>如何切换</h2>
            <SwitchHowTo id={mid} reg={reg} cap={cap} />
          </section>
          <section className="card" aria-label="状态时间线">
            <h2 style={{ marginTop: 0 }}>状态时间线</h2>
            <StatusTimeline cap={cap} />
          </section>
          {auth.isAdmin && cap.data && (
            <section className="card" aria-label="管理员数据">
              <h2 style={{ marginTop: 0 }}>探针数据（管理员）</h2>
              <pre className="wrap-any" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(cap.data, null, 2)}</pre>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
