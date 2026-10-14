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

import { rich, t, withText } from '../../i18n';
import { EX } from './strings';
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

const XC = EX.compare;
const STATUS_TEXT = withText(
  {
    none: { shape: 'ring', tone: 'faint' },
    running: { shape: 'clock', tone: 'pend' },
    simulated: { shape: VALIDITY_META.simulated.shape, tone: VALIDITY_META.simulated.tone },
  } as const,
  XC.status,
);

const STATUS_META: Record<VariantStatus, StatusMeta> = {
  none: STATUS_TEXT.none,
  running: STATUS_TEXT.running,
  'pending-crosscheck': VALIDITY_META['pending-crosscheck'],
  valid: VALIDITY_META.valid,
  simulated: STATUS_TEXT.simulated,
  invalid: VALIDITY_META.invalid,
};

const TRACK = ['registered', 'uploaded', 'crosscheck'] as const;

function UploadTrack({ status }: { status: VariantStatus }) {
  const last = status === 'invalid' ? 'invalid' : status === 'simulated' ? 'simulated' : 'valid';
  const steps = [...TRACK, last] as const;
  const cur = status === 'none' ? -1 : status === 'running' ? 0 : status === 'pending-crosscheck' ? 2 : 3;
  return (
    <ol className="track4" aria-label={XC.uploadProgress}>
      {steps.map((k, i) => (
        <li key={k} className={i < cur || (i === 3 && cur === 3) ? 'done' : i === cur ? 'cur' : ''} aria-current={i === cur ? 'step' : undefined}>
          {XC.track[k]}
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

  if (!runsData.loaded && runsData.status !== 'error') return <Skeleton lines={5} block label={XC.readingRuns} />;
  if (runsData.status === 'error' && !runsData.loaded) return <InlineProblem error={runsData.error} onRetry={() => void runsData.refresh()} title={EX.page.title} />;
  if (labLoaded && !decl && !runs.length) {
    return (
      <EmptyState title={XC.notDeclaredTitle}>
        {t(XC.notDeclared, { key: `${module}/${experimentId}` })}
      </EmptyState>
    );
  }

  const commands = canRun
    ? variants
        .filter((v) => runStatus(chosen[v.label]) !== 'valid')
        .map((v) => (
          <CommandBlock key={v.label} text={expCommand(module, experimentId, v.label)} runsOn="workstation" copyOnly={!onPaste} onPaste={onPaste} label={t(XC.runLabel, { label: v.label })} />
        ))
    : [];

  if (!runs.length) {
    return (
      <div className="stack-16" data-compare="empty">
        <Notes view={view} role={role} mode={mode} />
        <EmptyState title={XC.noRunsTitle}>{single ? XC.noRunsSingle : t(XC.noRunsPair, { a: variants[0]?.label ?? 'before', b: variants[1]?.label ?? 'after' })}</EmptyState>
        {commands.length ? <div className="stack-8">{commands}</div> : <p className="small faint">{XC.commandsHidden}</p>}
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
                    {r.finishedAt ? formatClock(r.finishedAt) : r.registeredAt ? t(XC.registeredAt, { t: formatClock(r.registeredAt) }) : ''} · runId <span className="mono">{r.runId.slice(0, 4)}…{r.runId.slice(-4)}</span>
                  </span>
                ) : null}
              </div>
              <UploadTrack status={st} />
              {st === 'pending-crosscheck' ? <p className="small muted">{XC.crosscheckDelay}</p> : null}
              {r && maybeUploadFailed(r, now) ? <p className="small st drift">{XC.uploadFailed}</p> : null}
              {st === 'invalid' && r?.validity?.reasons?.length ? (
                <ul className="small checklist">
                  {r.validity.reasons.map((c) => (
                    <li key={c}>
                      <Status meta={{ text: t(XC.invalid, { reason: validityReasonText(c) }), shape: 'xbox', tone: 'fail' }} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {r && r.sessionId && r.sessionId !== sid ? <p className="small muted">{rich(XC.fromSession, { sid: <span className="mono">{r.sessionId}</span>, kind: i === 0 ? XC.handover : XC.crossSession })}</p> : null}
              {list.length > 1 && onSelect ? (
                <label className="small row">
                  {t(XC.runs, { n: list.length })}
                  <select className="input" value={r?.runId ?? ''} onChange={(e) => select(i, e.target.value)} aria-label={t(XC.pickRun, { label: v.label })}>
                    {list.map((x) => (
                      <option key={x.runId} value={x.runId}>
                        {x.finishedAt ? formatDate(x.finishedAt, now) : XC.notUploaded} · {STATUS_META[runStatus(x)].text}
                        {x.sessionId && x.sessionId !== sid ? t(XC.sessionShort, { sid: x.sessionId.slice(0, 5) }) : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="small faint">
                  {t(XC.runs, { n: list.length })}
                  {list.length > 1 ? XC.latestValid : ''}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {functional ? (
        <div className="stack-8">
          <b>{XC.functional}</b>
          <p className="small">{XC.functionalNote}</p>
          <ul className="small mono">
            {(decl?.corroborateWith ?? []).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="stack-8">
          <div className="row between">
            <b>{XC.metrics}</b>
            <span className="small muted">{XC.metricsNote}</span>
          </div>
          {rows.length ? (
            <>
              <div className="tbl-wrap compare-tbl">
                <table className="tbl">
                  <caption className="sr">
                    {t(XC.caption, { key: `${module}/${experimentId}` })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{XC.colMetric}</th>
                      {variants.map((v) => (
                        <th key={v.label} scope="col" className="num">
                          {v.label}
                        </th>
                      ))}
                      {!single ? <th scope="col">{XC.colDelta}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <span className={m.label === m.id ? 'mono small' : undefined}>{m.label}</span>
                          {m.id === 'client.requests' && pair && clientServerMismatch(chosen[pair[1]] ?? null) ? (
                            <span className="small st drift" title={t(XC.clientServer, { client: clientServerMismatch(chosen[pair[1]] ?? null)!.client, server: clientServerMismatch(chosen[pair[1]] ?? null)!.server })}>
                              {' '}
                              <Shape name="tri" /> {XC.mismatch}
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
                        {t(XC.valueLine, { label: v.label, value: formatMetricValue(m.values[v.label], m.unit) })}
                      </span>
                    ))}
                    {!single && pair ? <span className="small muted">{t(XC.deltaLine, { delta: deltaText(m.values[pair[0]], m.values[pair[1]], m.unit, m.label) })}</span> : null}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="small muted">{XC.noMetrics}</p>
          )}
        </div>
      )}

      {!functional && (bars || ladder) ? (
        <div className="stack-8">
          <div className="seg" role="group" aria-label={XC.charts}>
            <button type="button" aria-pressed={!table} onClick={() => setTable(false)}>
              {XC.chartsView}
            </button>
            <button type="button" aria-pressed={table} onClick={() => setTable(true)}>
              {XC.tableView}
            </button>
          </div>
          {table ? (
            <p className="small muted">{XC.tableNote}</p>
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
          <details className="disc">
            <summary>{EX.visual.details}</summary>
            <p className="small muted">{t(XC.directionNote, { a: variants[0]?.label, b: variants[1]?.label ?? XC.others })}</p>
          </details>
        </div>
      ) : null}

      {!single && pair ? (
        <div className="stack-4" data-section="pair">
          <b className="small">{XC.pair}</b>
          <span className="small">
            {t(XC.pairLabel, { a: pair[0], b: pair[1] })}
            {!ra || !rb ? (
              <Status meta={{ text: t(XC.missing, { label: !ra ? pair[0] : pair[1] }), shape: 'ring', tone: 'faint' }} />
            ) : cmp.loaded && cmp.data ? (
              cmp.data.comparable ? (
                <>
                  <Status meta={{ text: XC.comparable, shape: 'check', tone: 'pass' }} />
                  {XC.comparableNote}
                </>
              ) : (
                <>
                  <Status meta={{ text: XC.notComparable, shape: 'xbox', tone: 'fail' }} />
                  {t(XC.reasons, { list: (cmp.data.reasons ?? []).map((c) => COMPARE_REASON_TEXT[c] ?? c).join(XC.reasonSep) })}
                </>
              )
            ) : cmp.status === 'error' ? (
              XC.unknown
            ) : (
              XC.comparing
            )}
          </span>
          {decl?.compareAcross?.length ? <span className="small muted">{t(XC.across, { list: decl.compareAcross.join(XC.listSep) })}</span> : null}
        </div>
      ) : null}

      <div className="stack-4" data-section="validity">
        <b className="small">{variants.length > 1 && pair ? t(XC.validityOf, { label: pair[1] }) : XC.validity}</b>
        <ValidityList run={pair ? (rb ?? null) : (chosen[variants[0]?.label ?? ''] ?? null)} />
      </div>

      {commands.length ? (
        <div className="stack-8">
          <b className="small">{XC.howToRun}</b>
          {commands}
        </div>
      ) : mode !== 'report' ? (
        <p className="small faint">{canRun ? XC.allValid : XC.commandsHidden}</p>
      ) : null}

      <div className="stack-4" data-section="history">
        <b className="small">{XC.history}</b>
        <ul className="small checklist">
          {[...runs]
            .sort((x, y) => (y.registeredAt ?? '').localeCompare(x.registeredAt ?? ''))
            .map((r) => (
              <li key={r.runId}>
                <span className="mono">
                  {r.runId.slice(0, 4)}…{r.runId.slice(-4)}
                </span>{' '}
                {runLabel(r)} · <Status meta={STATUS_META[runStatus(r)]} /> · {r.finishedAt ? formatDate(r.finishedAt, now) : r.registeredAt ? t(XC.registeredAt, { t: formatDate(r.registeredAt, now) }) : '—'}
              </li>
            ))}
        </ul>
        {!single && onSelect && mode !== 'report' ? (
          <label className="small row">
            <input type="checkbox" checked={!!selection.across} onChange={(e) => onSelect({ ...selection, across: e.target.checked || undefined, b: e.target.checked ? selection.b : null })} />
            {XC.crossToggle}
          </label>
        ) : null}
        {selection.across && across.loaded && !otherRuns.length ? <span className="small muted">{XC.noOther}</span> : null}
      </div>
    </div>
  );
}

function ValidityList({ run }: { run: ExperimentRun | null }) {
  const st = runStatus(run);
  if (!run) return <span className="small faint">{XC.noRun}</span>;
  if (st === 'valid') return <Status meta={{ text: XC.validAll, shape: 'check', tone: 'pass' }} />;
  if (st === 'simulated') return <Status meta={{ text: XC.simulatedLow, shape: 'half', tone: 'stale' }} />;
  if (st === 'pending-crosscheck') return <Status meta={{ text: XC.crosscheckWait, shape: 'clock', tone: 'pend' }} />;
  if (st === 'running') return <Status meta={{ text: XC.waitUpload, shape: 'clock', tone: 'pend' }} />;
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
          <span>{XC.cloudshell}</span>
        </div>
      ) : null}
      {view.state === 'ENDING' ? <div className="note">{XC.ending}</div> : null}
      {mode !== 'report' && role !== 'L' ? <div className="note">{XC.readOnly}</div> : null}
    </>
  );
}
