/**
 * 对比实验视图 ExperimentCompare（08 P06）的抽屉形态：`/workspace/:sid?exp=<module>/<id>`，右侧 720px，窄屏全屏。
 *
 * 变体列（标签、角色、状态、记录选择）→ 上传进度（已登记 → 已上传 → 交叉校验中 → 有效 / 模拟基线 / 无效）→ 指标对照（服务端值优先，
 * 客户端与服务端差异 > 10% 时标注）→ 条形对照 / 数据表切换 → 成对比较 → 有效性校验 → 怎么运行（工作台终端）→ 跨会话对比。
 * 数值只来自实际记录，差异小于噪声带时写“差异不明显”；颜色不表示好坏（before 中性灰，after 青瓷）。
 */
import { useMemo, useState } from 'react';
import { useServices } from '../../app/context';
import { formatClock, formatDate } from '../../lib/format';
import { Drawer, EmptyState, ErrorPanel, Shape, Skeleton, Status } from '../../ui';
import { useWorkspace } from '../context';
import { useResource } from '../data/resource';
import type { ExperimentRunsResponse } from '../data/types';
import { variantMeta } from '../manual/ExperimentCard';
import { ManualCommand } from '../manual/ManualCommand';
import { comparability, metricRows, reasonText, runCommand, trackIndex, variantColumns, type ExperimentRunView, type MetricRow, type VariantColumn } from '../model/experiments';
import { findExperiment } from '../model/lab';

const ROLE_TEXT: Record<string, string> = { baseline: 'baseline · 基线', treatment: 'treatment · 处理', single: 'single · 一次性' };
const TRACK = ['已登记', '已上传', '交叉校验中', '结论'];

export function ExperimentCompareDrawer({ expKey, onClose }: { expKey: string; onClose: () => void }) {
  return (
    <Drawer open onClose={onClose} title={`对比实验 · ${expKey}`} wide>
      <ExperimentCompare expKey={expKey} />
    </Drawer>
  );
}

export function ExperimentCompare({ expKey }: { expKey: string }) {
  const ws = useWorkspace();
  const { api } = useServices();
  const lab = ws.data.lab.data;
  const exp = findExperiment(lab, expKey);
  const runs = ws.data.experiments;
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [crossFor, setCrossFor] = useState<string | null>(null);
  const [crossRun, setCrossRun] = useState<ExperimentRunView | null>(null);
  const cross = useResource<ExperimentRunsResponse>(crossFor && exp ? `xexp:${expKey}` : null, () => api.get<ExperimentRunsResponse>('listExperimentRuns', { query: { module: exp!.module, experiment: exp!.id } }));
  const all = useMemo(() => {
    const own = runs.data?.items ?? [];
    return crossRun ? [...own.filter((r) => r.runId !== crossRun.runId), crossRun] : own;
  }, [runs.data, crossRun]);
  const cols = useMemo(() => (exp ? variantColumns(exp, all, selection, ws.now()) : []), [exp, all, selection, ws]);
  const rows = useMemo(() => (exp ? metricRows(exp, cols) : []), [exp, cols]);
  if (!lab) return <Skeleton lines={4} />;
  if (!exp) return <EmptyState title="没有找到这个实验">卡片 {ws.view.labId} 没有声明对比实验 {expKey}。</EmptyState>;
  if (runs.error && !runs.data) return <ErrorPanel error={runs.error as never} onRetry={() => void runs.refresh()} />;
  if (runs.loading && !runs.data) return <Skeleton lines={5} />;

  const pair = exp.pairs?.[0];
  const a = pair ? cols.find((c) => c.label.id === pair[0])?.selected : cols[0]?.selected;
  const b = pair ? cols.find((c) => c.label.id === pair[1])?.selected : cols[1]?.selected;
  const cmp = cols.length > 1 ? comparability(a ?? null, b ?? null) : null;
  const canRun = ws.learner && ws.live;
  const noRecords = cols.every((c) => !c.runs.length);
  const env = { lab, step: null, vars: ws.data.vars.data, blockIndex: new WeakMap() };

  return (
    <div className="stack expcmp" data-exp-compare={expKey}>
      <div className="row between small">
        <span>
          {ws.view.labId} › 对比实验 · <span className="mono">{expKey}</span>（{exp.required ? '必做' : '选做'}）
        </span>
        <span className="muted">会话 {ws.sid}</span>
      </div>
      {ws.data.workspace.data?.features?.workstation === 'cloudshell' ? (
        <div className="note amber">
          <Shape name="tri" />
          <span>省钱模式下对比实验结果无法上传，相关检查只能按规则降级。</span>
        </div>
      ) : null}
      {ws.view.state === 'ENDING' ? <p className="note">实验已结束：进入结束前已登记的运行仍会接收上传。</p> : null}
      {noRecords ? (
        <EmptyState title="还没有运行这个实验">
          先在工作台终端运行{cols[0] ? ` ${cols[0].label.id}` : ''}，再完成接入应用后运行{cols[1] ? ` ${cols[1].label.id}` : ''}。
        </EmptyState>
      ) : null}
      <div className={`vcols n${cols.length}`}>
        {cols.map((c) => (
          <VariantHeader key={c.label.id} col={c} onSelect={(runId) => setSelection((s) => ({ ...s, [c.label.id]: runId }))} />
        ))}
      </div>
      {exp.validity === 'functional' ? (
        <FunctionalChecks checkIds={exp.corroborateWith ?? []} />
      ) : rows.length ? (
        <>
          <div className="seg" role="group" aria-label="图表">
            <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
              条形对照
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
              查看数据表
            </button>
          </div>
          {view === 'table' ? <CompareTable cols={cols} rows={rows} /> : <BarChart cols={cols} rows={rows} />}
          <p className="small muted">差异方向只说明变化，不代表好坏：启用托管服务后单次延迟变高也可能是正确结论。</p>
        </>
      ) : !noRecords ? (
        <p className="small muted">所选记录还没有可比较的指标（上传与交叉校验完成后显示）。</p>
      ) : null}
      {cmp ? (
        <div className="stack-4" data-pair="">
          <b className="small">
            成对比较 {pair ? `${pair[0]} ↔ ${pair[1]}` : `${cols[0]?.label.id} ↔ ${cols[1]?.label.id}`}
          </b>
          {cmp.comparable === null ? (
            <span className="small muted">
              缺少{' '}
              {[!a ? (pair?.[0] ?? cols[0]?.label.id) : null, !b ? (pair?.[1] ?? cols[1]?.label.id) : null].filter(Boolean).join(' 和 ')}
            </span>
          ) : cmp.comparable ? (
            <span className="small st pass">
              <Shape name="check" /> 可比（场景、参数、实例类型、起始变体一致；都不是强制运行）
            </span>
          ) : (
            <span className="small st fail">
              <Shape name="xbox" /> 不可比：{cmp.reasons.join('、')}
            </span>
          )}
        </div>
      ) : null}
      <ValidityList cols={cols} />
      {canRun ? (
        <div className="stack-8">
          <b className="small">怎么运行（在工作台终端）</b>
          {cols.map((c) => (
            <ManualCommand key={c.label.id} node={{ type: 'code', lang: 'bash', attributes: { runsOn: 'workstation' }, value: runCommand(exp, c.label.id) }} env={env} />
          ))}
        </div>
      ) : !ws.learner ? (
        <p className="small muted">只读：你的角色不能使用工作台终端。</p>
      ) : null}
      {cols.length > 1 ? (
        <details className="disc" onToggle={(e) => (e.currentTarget.open ? setCrossFor(cols[0]!.label.id) : undefined)}>
          <summary>跨会话对比（与之前会话的 {cols[0]!.label.id} 比较）</summary>
          {cross.loading && !cross.data ? (
            <Skeleton lines={2} />
          ) : (
            <CrossSession
              runs={(cross.data?.items ?? []).filter((r) => r.label === cols[0]!.label.id && r.sessionId !== ws.sid)}
              selected={crossRun?.runId ?? null}
              onPick={(r) => {
                setCrossRun(r);
                if (r) setSelection((s) => ({ ...s, [cols[0]!.label.id]: r.runId }));
              }}
            />
          )}
        </details>
      ) : null}
    </div>
  );
}

function VariantHeader({ col, onSelect }: { col: VariantColumn; onSelect: (runId: string) => void }) {
  const ws = useWorkspace();
  const idx = trackIndex(col.status);
  const r = col.selected;
  return (
    <div className="box stack-4 vhead" data-variant={col.label.id}>
      <b>
        {col.label.id}
        <span className="small muted">（{ROLE_TEXT[col.label.role ?? ''] ?? col.label.role}{col.label.title ? ` · ${col.label.title}` : ''}）</span>
      </b>
      <span className="small">
        <Status meta={variantMeta(col.status)} />
        {r ? <span className="faint"> · {formatClock(r.finishedAt ?? r.registeredAt ?? ws.now())} · runId {r.runId.slice(0, 6)}…{r.runId.slice(-4)}</span> : null}
        {r && r.sessionId && r.sessionId !== ws.sid ? <span className="faint"> · 来自会话 {r.sessionId}</span> : null}
      </span>
      {col.status === 'invalid' && r?.validity?.reasons?.length ? <span className="small st fail">无效：{r.validity.reasons.map(reasonText).join('、')}</span> : null}
      {col.runs.length > 1 ? (
        <label className="small row">
          记录 {col.runs.length} 次
          <select className="input" value={r?.runId ?? ''} onChange={(e) => onSelect(e.target.value)} aria-label={`选择 ${col.label.id} 的记录`}>
            {col.runs.map((x) => (
              <option key={x.runId} value={x.runId}>
                {formatDate(x.finishedAt ?? x.registeredAt ?? x.runId, ws.now())} · {x.validity?.status ?? x.status ?? '已登记'}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {idx >= 0 ? (
        <ol className="track4" aria-label="上传进度">
          {TRACK.map((t, i) => (
            <li key={t} className={i < idx ? 'done' : i === idx ? 'cur' : undefined} aria-current={i === idx ? 'step' : undefined}>
              {i === 3 && idx === 3 ? variantMeta(col.status).text : t}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function num(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
}

function CompareTable({ cols, rows }: { cols: VariantColumn[]; rows: MetricRow[] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl cmptable">
        <thead>
          <tr>
            <th scope="col">指标</th>
            {cols.map((c) => (
              <th key={c.label.id} scope="col">
                {c.label.id}
              </th>
            ))}
            {cols.length > 1 ? <th scope="col">差异</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="mono small">
                {r.label}
              </th>
              {r.values.map((v, i) => (
                <td key={i} className="num" title={v?.mismatch ? `客户端 ${num(v.client)} · 服务端 ${num(v.server)}` : undefined}>
                  {num(v?.value)}
                  {v?.mismatch ? <span className="st drift"> ▲ 客户端与服务端统计不一致</span> : null}
                </td>
              ))}
              {r.delta ? <td>{r.delta.text}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 条形对照：每个指标按变体各一根条（before 中性灰、after 青瓷、第三列另一色），不用红绿；role="img" + 文字说明。 */
function BarChart({ cols, rows }: { cols: VariantColumn[]; rows: MetricRow[] }) {
  const shown = rows.filter((r) => r.values.some((v) => v?.value !== null && v?.value !== undefined)).slice(0, 12);
  const barH = 12;
  const gap = 4;
  const groupH = cols.length * (barH + gap) + 14;
  const H = shown.length * groupH + 10;
  const W = 640;
  const LABEL = 180;
  const desc = shown.map((r) => `${r.label}：${r.values.map((v, i) => `${cols[i]?.label.id} ${num(v?.value)}`).join('，')}`).join('；');
  const cls = ['b', 'a', 't3', 'a'];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`条形对照：${desc}`}>
      <title>条形对照</title>
      <desc>{desc}</desc>
      {shown.map((r, gi) => {
        const max = Math.max(...r.values.map((v) => Math.abs(v?.value ?? 0)), 1e-9);
        const y0 = gi * groupH + 10;
        return (
          <g key={r.key}>
            <text x={0} y={y0 + 10}>
              {r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label}
            </text>
            {r.values.map((v, i) => {
              const w = v?.value === null || v?.value === undefined ? 0 : (Math.abs(v.value) / max) * (W - LABEL - 80);
              const y = y0 + i * (barH + gap);
              return (
                <g key={i}>
                  <rect className={cls[i] ?? 'a'} x={LABEL} y={y} width={Math.max(w, v?.value ? 1 : 0)} height={barH} />
                  <text x={LABEL + w + 6} y={y + barH - 2}>
                    {cols[i]?.label.id} {num(v?.value)}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function ValidityList({ cols }: { cols: VariantColumn[] }) {
  const withRuns = cols.filter((c) => c.selected);
  if (!withRuns.length) return null;
  return (
    <div className="stack-4">
      <b className="small">有效性校验</b>
      <ul className="small mlist">
        {withRuns.map((c) => {
          const v = c.selected!.validity;
          return (
            <li key={c.label.id}>
              <span className="mono">{c.label.id}</span>：
              {!v ? (
                <span className="st pend">◷ 等待上传与校验</span>
              ) : v.status === 'valid' ? (
                <span className="st pass">✓ 结构、登记、时间窗、驱动与服务端佐证都通过</span>
              ) : v.status === 'simulated' ? (
                <span className="st stale">◐ 模拟基线（旁路补测），证据权重较低</span>
              ) : v.status === 'pending-crosscheck' ? (
                <span className="st pend">◷ 服务端佐证等待中（指标可能有数分钟延迟）</span>
              ) : (
                <span className="st fail">✕ {(v.reasons ?? []).map(reasonText).join('、') || '无效'}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FunctionalChecks({ checkIds }: { checkIds: string[] }) {
  const ws = useWorkspace();
  const lab = ws.data.lab.data;
  return (
    <div className="stack-4">
      <p className="small">功能型实验：以下检查在实验时间窗内通过即视为有效。</p>
      <ul className="small mlist">
        {checkIds.map((id) => {
          let eff: string | null = null;
          for (const st of ws.data.stepMap.values()) if (st.checks?.[id]) eff = st.checks[id]!.effective ?? null;
          return (
            <li key={id}>
              {lab?.checks?.[id]?.title ?? id} · {eff === 'pass' ? '✓ 通过' : eff ? eff : '未检测'}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CrossSession({ runs, selected, onPick }: { runs: ExperimentRunView[]; selected: string | null; onPick: (r: ExperimentRunView | null) => void }) {
  const ws = useWorkspace();
  if (!runs.length) return <p className="small muted">之前的会话里没有这个变体的记录。</p>;
  return (
    <label className="small row">
      选择之前会话的记录
      <select
        className="input"
        value={selected ?? ''}
        onChange={(e) => onPick(runs.find((r) => r.runId === e.target.value) ?? null)}
      >
        <option value="">（不使用）</option>
        {runs.map((r) => (
          <option key={r.runId} value={r.runId}>
            {formatDate(r.finishedAt ?? r.registeredAt ?? r.runId, ws.now())} · 会话 {r.sessionId ?? '—'} · {r.validity?.status ?? r.status ?? ''}
          </option>
        ))}
      </select>
    </label>
  );
}
