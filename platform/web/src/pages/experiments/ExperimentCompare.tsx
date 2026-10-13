/**
 * ExperimentCompare（08 P06；§5.4 ExperimentCompare / VariantColumnHeader / UploadStatusTrack / CompareTable / DeltaCell /
 * VariantBarChart / LadderChart / PairComparability / ValidityChecklist / RunHistoryList）。
 * 独立页面、工作台抽屉（`?exp=`，工作台实现者可直接使用本组件并传入 onPaste）与报告只读形态共用。
 *
 * - 变体由卡片声明（任意标签，baseline / treatment / single），不假设只有 before / after；
 * - 数据：手册 `experiments[]`（静态内容）、`GET /sessions/{sid}/experiment-runs`、两次并排 `GET /experiment-runs/compare?a=&b=`、
 *   跨会话 `GET /experiment-runs?module=&experiment=`；`experiment_run.*` 事件到达时刷新；
 * - 数值只来自实际记录；差异小于噪声带写“差异不明显”；方向不代表好坏；图表有数据表视图；
 * - 会话结束、助教与观察者：只读，运行命令隐藏。
 */
import { useMemo, useState } from 'react';
import type { SessionView } from '../../api/types';
import { useAuth, useServices, useSessionEvents } from '../../app/context';
import { formatClock, formatDate, formatUtcTitle } from '../../lib/format';
import { CommandBlock, EmptyState, Shape, Skeleton, Status, VALIDITY_META, type CommandBlockProps, type StatusMeta } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { useApiData, useLabContent, viewX } from '../sessions/data';
import '../sessions/pages.css';
import { COMPARE_REASON_TEXT, validityReasonText } from '../sessions/sessionText';
import { BarsChartSvg, LadderChartSvg } from './Charts';
import { buildBarsChart, buildLadderChart, deltaText, formatMetricValue, variantClass, type VariantDecl } from './compareModel';
import { clientServerMismatch, declVariants, defaultRun, maybeUploadFailed, metricRows, runLabel, runsOf, runStatus, type CompareResult, type ExperimentRun, type VariantStatus } from './runs';

export interface CompareSelection {
  a?: string | null;
  b?: string | null;
  across?: boolean;
}

export interface ExperimentCompareProps {
  view: SessionView;
  module: string;
  experimentId: string;
  mode?: 'page' | 'drawer' | 'report';
  selection?: CompareSelection;
  onSelect?: (sel: CompareSelection) => void;
  /** 工作台抽屉：粘贴到终端。 */
  onPaste?: CommandBlockProps['onPaste'];
}

const LIVE = ['READY', 'RUNNING', 'EXPIRING'];

const STATUS_META: Record<VariantStatus, StatusMeta> = {
  none: { text: '还没有记录', shape: 'ring', tone: 'faint' },
  running: { text: '运行中或未上传', shape: 'clock', tone: 'pend' },
  'pending-crosscheck': VALIDITY_META['pending-crosscheck'],
  valid: VALIDITY_META.valid,
  simulated: { ...VALIDITY_META.simulated, text: '模拟基线（旁路补测）' },
  invalid: VALIDITY_META.invalid,
};

const TRACK = ['已登记', '已上传', '交叉校验中'] as const;

function UploadTrack({ status }: { status: VariantStatus }) {
  const last = status === 'invalid' ? '无效' : status === 'simulated' ? '模拟基线' : '有效';
  const steps = [...TRACK, last];
  const cur = status === 'none' ? -1 : status === 'running' ? 0 : status === 'pending-crosscheck' ? 2 : 3;
  return (
    <ol className="track4" aria-label="上传进度">
      {steps.map((t, i) => (
        <li key={t} className={i < cur || (i === 3 && cur === 3) ? 'done' : i === cur ? 'cur' : ''} aria-current={i === cur ? 'step' : undefined}>
          {t}
        </li>
      ))}
    </ol>
  );
}

export function expCommand(module: string, experimentId: string, label: string): string {
  return `npm run exp -- ${module} ${experimentId} --label ${label} --upload`;
}

export function ExperimentCompare({ view, module, experimentId, mode = 'page', selection = {}, onSelect, onPaste }: ExperimentCompareProps) {
  const sid = view.sessionId;
  const { clock } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const { lab, loaded: labLoaded } = useLabContent(view.catalogVersion, view.labId);
  const decl = lab?.experiments?.find((x) => x.module === module && x.id === experimentId) ?? null;
  const runsData = useApiData<{ items?: ExperimentRun[] }>(`exp:${sid}`, 'listSessionExperimentRuns', { params: { sid }, conditional: false });
  useSessionEvents(() => void runsData.refresh(), { sid, prefixes: ['experiment_run.'] });
  const across = useApiData<{ items?: ExperimentRun[] }>(selection.across ? `expx:${module}/${experimentId}` : null, 'listExperimentRuns', { query: { module, experiment: experimentId } });
  const [table, setTable] = useState(false);

  const runs = useMemo(() => (runsData.data?.items ?? []).filter((r) => r.module === module && r.experiment === experimentId), [runsData.data, module, experimentId]);
  const otherRuns = useMemo(() => (across.data?.items ?? []).filter((r) => r.sessionId !== sid), [across.data, sid]);
  const variants: VariantDecl[] = useMemo(() => declVariants(decl, runs), [decl, runs]);
  const byId = (id: string | null | undefined) => (id ? (runs.find((r) => r.runId === id) ?? otherRuns.find((r) => r.runId === id) ?? null) : null);
  const chosen: Record<string, ExperimentRun | null> = {};
  variants.forEach((v, i) => {
    const sel = i === 0 ? byId(selection.a) : i === 1 ? byId(selection.b) : null;
    chosen[v.label] = sel ?? defaultRun(runs, v.label);
  });
  const single = variants.length === 1 || variants.every((v) => v.role === 'single');
  const pair = decl?.pairs?.[0] ?? (variants.length >= 2 ? [variants[0]!.label, variants[1]!.label] : null);
  const ra = pair ? chosen[pair[0]] : null;
  const rb = pair ? chosen[pair[1]] : null;
  const cmp = useApiData<CompareResult>(ra && rb ? `cmp:${ra.runId}:${rb.runId}` : null, 'compareExperimentRuns', { query: { a: ra?.runId, b: rb?.runId } });
  const rows = metricRows(variants, chosen, pair && cmp.data ? { a: pair[0], b: pair[1], result: cmp.data } : null);
  const bars = buildBarsChart(rows, variants);
  const ladder = buildLadderChart(rows, variants);
  const live = LIVE.includes(view.state);
  const canRun = role === 'L' && live && mode !== 'report';
  const functional = decl?.validity === 'functional';
  const now = clock.now();
  const select = (i: number, runId: string) => onSelect?.({ ...selection, ...(i === 0 ? { a: runId } : { b: runId }) });

  if (!runsData.loaded && runsData.status !== 'error') return <Skeleton lines={5} block label="正在读取实验记录" />;
  if (runsData.status === 'error' && !runsData.loaded) return <InlineProblem error={runsData.error} onRetry={() => void runsData.refresh()} title="对比实验" />;
  if (labLoaded && !decl && !runs.length) {
    return (
      <EmptyState title="这张卡片没有声明这个实验。">
        实验 {module}/{experimentId} 不在本卡片的实验列表中，链接可能有误。
      </EmptyState>
    );
  }

  const commands = canRun
    ? variants
        .filter((v) => runStatus(chosen[v.label]) !== 'valid')
        .map((v) => (
          <CommandBlock key={v.label} text={expCommand(module, experimentId, v.label)} runsOn="workstation" copyOnly={!onPaste} onPaste={onPaste} label={`运行 ${v.label}`} />
        ))
    : [];

  if (!runs.length) {
    return (
      <div className="stack-16" data-compare="empty">
        <Notes view={view} role={role} mode={mode} />
        <EmptyState title="还没有运行这个实验。">
          {single ? '在工作台终端运行它，结果会自动上传并交叉校验。' : `先在工作台终端运行 ${variants[0]?.label ?? 'before'}，再完成接入应用后运行 ${variants[1]?.label ?? 'after'}。`}
        </EmptyState>
        {commands.length ? <div className="stack-8">{commands}</div> : <p className="small faint">运行命令已隐藏（会话已结束或你的角色不能使用工作台终端）。</p>}
      </div>
    );
  }

  return (
    <div className="stack-16" data-compare={`${module}/${experimentId}`}>
      <Notes view={view} role={role} mode={mode} />
      <div className="grid-2">
        {variants.map((v, i) => {
          const r = chosen[v.label];
          const st = runStatus(r);
          const list = i === 1 && selection.across ? [...runsOf(runs, v.label), ...otherRuns.filter((x) => runLabel(x) === v.label)] : runsOf(runs, v.label);
          return (
            <div key={v.label} className="box varcol" data-variant={v.label} data-status={st}>
              <div className="row between">
                <b className="mono">
                  <span className={`legend-sw ${variantClass(variants, v.label)}`} aria-hidden="true" /> {v.label}
                </b>
                <span className="small muted">
                  {v.role}
                  {v.description ? ` · ${v.description}` : ''}
                </span>
              </div>
              <div className="row small">
                <Status meta={STATUS_META[st]} />
                {r ? (
                  <span className="faint" title={r.finishedAt ? formatUtcTitle(r.finishedAt) : undefined}>
                    {r.finishedAt ? formatClock(r.finishedAt) : r.registeredAt ? `登记于 ${formatClock(r.registeredAt)}` : ''} · runId <span className="mono">{r.runId.slice(0, 4)}…{r.runId.slice(-4)}</span>
                  </span>
                ) : null}
              </div>
              <UploadTrack status={st} />
              {st === 'pending-crosscheck' ? <p className="small muted">服务端佐证有数分钟延迟（例如 CloudFront 指标），稍后自动复核。</p> : null}
              {r && maybeUploadFailed(r, now) ? <p className="small st drift">可能上传失败：请看工作台终端中运行器的输出。</p> : null}
              {st === 'invalid' && r?.validity?.reasons?.length ? (
                <ul className="small checklist">
                  {r.validity.reasons.map((c) => (
                    <li key={c}>
                      <Status meta={{ text: `无效：${validityReasonText(c)}`, shape: 'xbox', tone: 'fail' }} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {r && r.sessionId && r.sessionId !== sid ? <p className="small muted">来自会话 <span className="mono">{r.sessionId}</span>{i === 0 ? '（交接链中的会话）' : '（跨会话比较）'}</p> : null}
              {list.length > 1 && onSelect ? (
                <label className="small row">
                  记录 {list.length} 次
                  <select className="input" value={r?.runId ?? ''} onChange={(e) => select(i, e.target.value)} aria-label={`选择 ${v.label} 用于比较的记录`}>
                    {list.map((x) => (
                      <option key={x.runId} value={x.runId}>
                        {x.finishedAt ? formatDate(x.finishedAt, now) : '未上传'} · {STATUS_META[runStatus(x)].text}
                        {x.sessionId && x.sessionId !== sid ? ` · 会话 ${x.sessionId.slice(0, 5)}…` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="small faint">记录 {list.length} 次{list.length > 1 ? ' · 默认使用最近一次有效记录' : ''}</span>
              )}
            </div>
          );
        })}
      </div>

      {functional ? (
        <div className="stack-8">
          <b>功能型实验</b>
          <p className="small">以下检查在实验时间窗内通过即视为有效：</p>
          <ul className="small mono">
            {(decl?.corroborateWith ?? []).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="stack-8">
          <div className="row between">
            <b>指标</b>
            <span className="small muted">服务端校正后的值；客户端与服务端差异 &gt; 10% 时标注</span>
          </div>
          {rows.length ? (
            <>
              <div className="tbl-wrap compare-tbl">
                <table className="tbl">
                  <caption className="sr">
                    {module}/{experimentId} 的指标对照
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">指标</th>
                      {variants.map((v) => (
                        <th key={v.label} scope="col" className="num">
                          {v.label}
                        </th>
                      ))}
                      {!single ? <th scope="col">差异</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <span className={m.label === m.id ? 'mono small' : undefined}>{m.label}</span>
                          {m.id === 'client.requests' && pair && clientServerMismatch(chosen[pair[1]] ?? null) ? (
                            <span className="small st drift" title={`客户端 ${clientServerMismatch(chosen[pair[1]] ?? null)!.client} · 服务端 ${clientServerMismatch(chosen[pair[1]] ?? null)!.server}`}>
                              {' '}
                              <Shape name="tri" /> 客户端与服务端统计不一致
                            </span>
                          ) : null}
                        </td>
                        {variants.map((v) => (
                          <td key={v.label} className="num">
                            {formatMetricValue(m.values[v.label], m.unit)}
                          </td>
                        ))}
                        {!single ? <td>{pair ? deltaText(m.values[pair[0]], m.values[pair[1]], m.unit, m.label) : '—'}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="metric-cards" aria-hidden="true">
                {rows.map((m) => (
                  <div key={m.id} className="metric-card">
                    <b className={m.label === m.id ? 'mono small' : undefined}>{m.label}</b>
                    {variants.map((v) => (
                      <span key={v.label}>
                        {v.label}：{formatMetricValue(m.values[v.label], m.unit)}
                      </span>
                    ))}
                    {!single && pair ? <span className="small muted">差异：{deltaText(m.values[pair[0]], m.values[pair[1]], m.unit, m.label)}</span> : null}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="small muted">所选记录还没有可比较的指标（上传或交叉校验完成后显示）。</p>
          )}
        </div>
      )}

      {!functional && (bars || ladder) ? (
        <div className="stack-8">
          <div className="seg" role="group" aria-label="图表">
            <button type="button" aria-pressed={!table} onClick={() => setTable(false)}>
              条形对照与分位阶梯
            </button>
            <button type="button" aria-pressed={table} onClick={() => setTable(true)}>
              查看数据表
            </button>
          </div>
          {table ? (
            <p className="small muted">数据表即上方的指标表（读屏视图）。</p>
          ) : (
            <>
              {bars ? (
                <figure className="box">
                  <BarsChartSvg chart={bars} />
                </figure>
              ) : null}
              {ladder ? (
                <figure className="box">
                  <LadderChartSvg chart={ladder} />
                </figure>
              ) : null}
            </>
          )}
          <p className="small muted">差异方向只说明变化，不代表好坏：启用托管服务后单次延迟变高也可能是正确结论。不用红绿：{variants[0]?.label} 中性灰，{variants[1]?.label ?? '其余'} 青瓷。</p>
        </div>
      ) : null}

      {!single && pair ? (
        <div className="stack-4" data-section="pair">
          <b className="small">成对比较</b>
          <span className="small">
            {pair[0]} ↔ {pair[1]}：
            {!ra || !rb ? (
              <Status meta={{ text: `缺少 ${!ra ? pair[0] : pair[1]}`, shape: 'ring', tone: 'faint' }} />
            ) : cmp.loaded && cmp.data ? (
              cmp.data.comparable ? (
                <>
                  <Status meta={{ text: '可比', shape: 'check', tone: 'pass' }} />（场景、起始变体、实例类型一致；都不是强制运行）
                </>
              ) : (
                <>
                  <Status meta={{ text: '不可比', shape: 'xbox', tone: 'fail' }} />（{(cmp.data.reasons ?? []).map((c) => COMPARE_REASON_TEXT[c] ?? c).join('；')}）
                </>
              )
            ) : cmp.status === 'error' ? (
              '暂时无法判断'
            ) : (
              '正在比较…'
            )}
          </span>
          {decl?.compareAcross?.length ? <span className="small muted">允许跨维度比较：{decl.compareAcross.join('、')}（跨实例类型比较时显著标注）</span> : null}
        </div>
      ) : null}

      <div className="stack-4" data-section="validity">
        <b className="small">有效性校验{variants.length > 1 && pair ? `（${pair[1]}）` : ''}</b>
        <ValidityList run={pair ? (rb ?? null) : (chosen[variants[0]?.label ?? ''] ?? null)} />
      </div>

      {commands.length ? (
        <div className="stack-8">
          <b className="small">怎么运行（在工作台终端）</b>
          {commands}
        </div>
      ) : mode !== 'report' ? (
        <p className="small faint">{canRun ? '所有变体都已有有效记录。' : '运行命令已隐藏（会话已结束或你的角色不能使用工作台终端）。'}</p>
      ) : null}

      <div className="stack-4" data-section="history">
        <b className="small">历史记录（本会话）</b>
        <ul className="small checklist">
          {[...runs]
            .sort((x, y) => (y.registeredAt ?? '').localeCompare(x.registeredAt ?? ''))
            .map((r) => (
              <li key={r.runId}>
                <span className="mono">
                  {r.runId.slice(0, 4)}…{r.runId.slice(-4)}
                </span>{' '}
                {runLabel(r)} · <Status meta={STATUS_META[runStatus(r)]} /> · {r.finishedAt ? formatDate(r.finishedAt, now) : r.registeredAt ? `登记于 ${formatDate(r.registeredAt, now)}` : '—'}
              </li>
            ))}
        </ul>
        {!single && onSelect && mode !== 'report' ? (
          <label className="small row">
            <input type="checkbox" checked={!!selection.across} onChange={(e) => onSelect({ ...selection, across: e.target.checked || undefined, b: e.target.checked ? selection.b : null })} />
            跨会话对比：在第二列选择之前会话的同一实验记录
          </label>
        ) : null}
        {selection.across && across.loaded && !otherRuns.length ? <span className="small muted">之前的会话没有这个实验的记录。</span> : null}
      </div>
    </div>
  );
}

function ValidityList({ run }: { run: ExperimentRun | null }) {
  const st = runStatus(run);
  if (!run) return <span className="small faint">还没有记录。</span>;
  if (st === 'valid') return <Status meta={{ text: '结构与完整性、登记、时间窗、驱动、服务端佐证均通过', shape: 'check', tone: 'pass' }} />;
  if (st === 'simulated') return <Status meta={{ text: '模拟基线：证据权重较低', shape: 'half', tone: 'stale' }} />;
  if (st === 'pending-crosscheck') return <Status meta={{ text: '服务端佐证：等待中（指标有数分钟延迟）', shape: 'clock', tone: 'pend' }} />;
  if (st === 'running') return <Status meta={{ text: '等待上传', shape: 'clock', tone: 'pend' }} />;
  return (
    <ul className="small checklist">
      {(run.validity?.reasons ?? ['—']).map((c) => (
        <li key={c}>
          <Status meta={{ text: validityReasonText(c), shape: 'xbox', tone: 'fail' }} />
        </li>
      ))}
    </ul>
  );
}

function Notes({ view, role, mode }: { view: SessionView; role: 'L' | 'A' | 'O' | null; mode: string }) {
  const v = viewX(view);
  const savings = (v.workstation as { mode?: string } | null | undefined)?.mode === 'cloudshell';
  return (
    <>
      {savings ? (
        <div className="note amber">
          <Shape name="tri" />
          <span>省钱模式下对比实验结果无法上传，相关检查只能按规则降级。</span>
        </div>
      ) : null}
      {view.state === 'ENDING' ? <div className="note">实验已结束：进入结束前已登记的运行仍会接收上传。</div> : null}
      {mode !== 'report' && role !== 'L' ? <div className="note">只读：你的角色不能使用工作台终端。</div> : null}
    </>
  );
}
