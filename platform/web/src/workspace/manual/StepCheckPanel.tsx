/**
 * 本步检测 StepCheckPanel（08 P05.5；03 §7.2）：CheckResultRow（compact）× N、[检测]（手册聚焦时 R、任何位置 ⌃. R；Shift+点击检测整张卡片）、
 * 等待型检查的 WaitTimer（浏览器驱动重测：15、30、45、60 秒之后每 60 秒，页面不可见时停止，04 §5.6）、
 * “命令已完成（退出码 0）· [检测本步]”建议条（不自动检测）、漂移提示与“我是有意改动的”、手动确认入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useServices } from '../../app/context';
import { announce } from '../../lib/announce';
import { formatClock, formatCountdown } from '../../lib/format';
import { Button, CheckResultRow, Shape, useSecondTick } from '../../ui';
import { useWorkbench, useWorkspace } from '../context';
import { useResource } from '../data/resource';
import type { CheckRunsResponse } from '../data/types';
import { latestResults, runSummaryText, stepCheckRows, waitDelayMs, type CheckRowModel } from '../model/checks';
import { checkLocalId, type LabStep } from '../model/lab';

import { t } from '../../i18n';
import { W } from '../strings';

const WS = W.stepCheck;
export function StepCheckPanel({ step, only }: { step: LabStep; only?: string }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const { api } = useServices();
  const lab = ws.data.lab.data!;
  const runner = wb.checks;
  const rs = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  const runs = useResource<CheckRunsResponse>(`runs:${ws.sid}:${step.id}`, () => api.get<CheckRunsResponse>('listCheckRuns', { params: { sid: ws.sid }, query: { stepId: step.id, limit: 10 } }), {
    enabled: !ws.preparing,
  });
  const refreshRuns = runs.refresh;
  // 结果到达：事件 check_run.completed（WorkspaceData 递增 tick）或补查到 done
  useEffect(() => {
    if (ws.data.checkRunTick) void refreshRuns();
  }, [ws.data.checkRunTick, refreshRuns]);
  useEffect(
    () =>
      runner.onDone((run, result) => {
        void refreshRuns();
        void ws.data.steps.refresh();
        void ws.data.progress.refresh();
        if (run.stepId === step.id && result?.results) announce(runSummaryText(result.results), { topic: `check:${step.id}` });
      }),
    [runner, refreshRuns, step.id, ws.data.steps, ws.data.progress],
  );
  const inflight = runner.inflightFor(step.id);
  const latest = useMemo(() => latestResults(runs.data?.items ?? []), [runs.data]);
  const allIds = useMemo(() => new Set((step.checks ?? []).map(checkLocalId)), [step.checks]);
  const inflightKey = inflight === 'all' ? '*' : inflight ? [...inflight].sort().join(',') : '';
  const running = useMemo(() => (inflightKey === '*' ? allIds : new Set(inflightKey ? inflightKey.split(',') : [])), [inflightKey, allIds]);
  const stepResult = ws.data.stepMap.get(step.id) ?? null;
  const rows = useMemo(() => stepCheckRows(lab, step, stepResult, latest, running), [lab, step, stepResult, latest, running]);
  const shown = only ? rows.filter((r) => r.checkId === only) : rows;

  // 事件里带 summary 时播报（本标签页没有发起的运行也播报一次）
  const lastEvt = ws.data.lastCheckRun;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    const d = lastEvt?.data as { runId?: string; stepId?: string | null; summary?: Record<string, number> } | undefined;
    if (!d?.runId || d.stepId !== step.id || announced.current === d.runId || only) return;
    announced.current = d.runId;
    runner.complete(d.runId);
    if (d.summary) {
      const s = d.summary;
      announce(s.fail ? t(WS.doneFail, { pass: s.pass ?? 0, fail: s.fail }) : t(WS.done, { pass: s.pass ?? 0 }), { topic: `check:${step.id}` });
    }
  }, [lastEvt, step.id, runner, only]);

  const canRun = ws.role === 'L' || ws.role === 'A';
  const runBlocked = ws.preparing ? WS.afterReady : !ws.live ? WS.ended : null;
  void rs;
  const onRun = (e: React.MouseEvent) => {
    if (e.shiftKey) wb.runLabCheck();
    else wb.runStepCheck(step.id);
  };

  // 命令结束后的建议（只对当前步骤；不自动检测）
  const [finished, setFinished] = useState<{ exitCode: number | null } | null>(null);
  useEffect(() => wb.onCommandFinished((e) => (e.stepId === step.id ? setFinished({ exitCode: e.exitCode }) : undefined)), [wb, step.id]);
  useEffect(() => setFinished(null), [step.id]);

  const drifted = stepResult?.state === 'drifted';
  const driftAt = stepResult?.lastPassedAt ?? stepResult?.firstPassedAt ?? null;
  const badRows = rows.filter((r) => r.result === 'fail' || r.result === 'error');
  const [acking, setAcking] = useState(false);

  if (!shown.length && only) return null;
  return (
    <section className="stack-8 chksec" aria-labelledby={`chk-h-${step.id}${only ?? ''}`} data-step-checks={step.id}>
      {!only ? (
        <div className="row between">
          <h3 id={`chk-h-${step.id}`} className="small">
            {WS.title}
          </h3>
          {canRun ? (
            <Button size="sm" onClick={onRun} disabledReason={runBlocked} busy={inflight !== null} busyText={WS.verifying} data-run-check="">
              {WS.run}
              <span className="kbd-hint">
                {' '}
                <kbd>⌃.</kbd>
                <kbd>R</kbd>
              </span>
            </Button>
          ) : null}
        </div>
      ) : (
        <h3 id={`chk-h-${step.id}${only}`} className="sr">
          {WS.checks}
        </h3>
      )}
      {drifted && !only ? (
        <div className="note amber" role="note" data-drift="">
          <Shape name="tri" />
          <div className="stack-4">
            <span>
              {t(WS.drift, { t: driftAt ? formatClock(driftAt) : WS.before, what: badRows.length ? t(WS.quoted, { list: badRows.map((r) => r.title).join(WS.quoteSep) }) : WS.someChecks })}
            </span>
            {ws.learner && ws.live ? (
              <div className="row">
                <Button
                  size="sm"
                  onClick={(e) => {
                    const d = (e.currentTarget.closest('.stepcard') as HTMLElement | null)?.querySelector<HTMLDetailsElement>('details[data-pitfalls]');
                    if (d) {
                      d.open = true;
                      d.scrollIntoView({ block: 'nearest' });
                      d.querySelector('summary')?.focus();
                    } else announce(WS.noPitfalls);
                  }}
                >
                  {WS.troubleshoot}
                </Button>
                <Button
                  size="sm"
                  busy={acking}
                  onClick={async () => {
                    setAcking(true);
                    try {
                      await api.call('ackDrift', { params: { sid: ws.sid, stepId: step.id }, body: {} });
                      announce(WS.ackDone);
                    } catch {
                      announce(WS.ackFailed);
                    } finally {
                      setAcking(false);
                    }
                  }}
                >
                  {WS.intended}
                </Button>
                <span className="small muted">{WS.ackNote}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {finished && !only ? (
        <div className={finished.exitCode === 0 ? 'note blue' : 'note amber'} role="status" data-suggest="">
          <Shape name={finished.exitCode === 0 ? 'check' : 'tri'} />
          <span>
            {finished.exitCode === 0 ? WS.cmdOk : t(WS.cmdFailed, { code: finished.exitCode ?? WS.unknown })}
            {canRun && ws.live ? (
              <>
                {' · '}
                <button type="button" className="linkbtn" onClick={() => wb.runStepCheck(step.id)}>
                  {WS.checkStep}
                </button>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {shown.length ? (
        <div className="chks" role="list">
          {shown.map((r) => (
            <CheckLine key={r.checkId} row={r} stepId={step.id} startedAt={stepResult?.startedAt ?? null} />
          ))}
        </div>
      ) : (
        <p className="small muted">{WS.noAuto}</p>
      )}
      {stepResult?.state === 'failed' && !only ? <p className="small muted">{WS.failedNote}</p> : null}
      <WaitDriver rows={rows} stepId={step.id} />
    </section>
  );
}

function CheckLine({ row, stepId, startedAt }: { row: CheckRowModel; stepId: string; startedAt: string | null }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const outage = ws.outage && row.reason === 'CHANNEL_DOWN' ? 'EXPECTED_OUTAGE' : null;
  const result = outage ? 'unavailable' : row.result;
  return (
    <div className="chkline" data-check={row.checkId}>
      <CheckResultRow
        title={row.title}
        result={result}
        reason={outage ?? row.reason}
        how={row.how}
        source={row.source}
        sourceSub={row.sub}
        trust={row.trust}
        summary={row.waiting ? <WaitText row={row} startedAt={startedAt} /> : row.summary}
        at={row.at}
        review={row.review}
        stale={row.stale}
        onOpen={() => wb.openCheck(row.checkId)}
        focusKey={`chk-${stepId}-${row.checkId}`}
      />
      {row.canManual && ws.learner && ws.live ? (
        <div className="chk-act">
          <button type="button" className="linkbtn small" onClick={() => wb.openManualConfirm(stepId, row.checkId)} aria-label={t(WS.manualLabel, { title: row.title })}>
            {WS.manual}
          </button>
        </div>
      ) : null}
      {row.review === 'rejected' && row.reviewComment ? <p className="small muted chk-act">{t(WS.reviewComment, { text: row.reviewComment })}</p> : null}
    </div>
  );
}

function WaitText({ row, startedAt }: { row: CheckRowModel; startedAt: string | null }) {
  const ws = useWorkspace();
  useSecondTick(true);
  const since = startedAt ? Date.parse(startedAt) : row.at ? Date.parse(row.at) : null;
  const typical = row.decl?.wait?.typicalMinutes;
  return (
    <span aria-live="off">
      {since ? t(WS.waited, { t: formatCountdown(ws.now() - since) }) : WS.waiting}
      {typical ? t(WS.typical, { n: typical }) : ''}
    </span>
  );
}

/** 等待型检查的重测（只在页面可见、会话可检测、角色可检测时；节奏 15、30、45、60 秒之后每 60 秒）。 */
function WaitDriver({ rows, stepId }: { rows: CheckRowModel[]; stepId: string }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const waiting = rows.filter((r) => r.waiting).map((r) => r.checkId);
  const key = waiting.join(',');
  const inflightNow = rows.some((r) => r.result === 'running');
  const n = useRef(0);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const can = (ws.role === 'L' || ws.role === 'A') && ws.live && waiting.length > 0 && !inflightNow;
  useEffect(() => {
    if (!waiting.length && !inflightNow) n.current = 0;
  }, [waiting.length, inflightNow]);
  useEffect(() => {
    n.current = 0;
  }, [stepId]);
  const fire = useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    wb.runStepCheck(stepId, { checkIds: key.split(',') });
  }, [wb, stepId, key]);
  useEffect(() => {
    if (!can) {
      setNextAt(null);
      return undefined;
    }
    const delay = waitDelayMs(n.current);
    setNextAt(Date.now() + delay);
    const t = setTimeout(() => {
      n.current += 1;
      fire();
    }, delay);
    return () => clearTimeout(t);
  }, [can, key, fire]);
  useSecondTick(can);
  if (!can || nextAt === null) return null;
  return (
    <p className="small muted" aria-live="off" data-wait-next="">
      <Shape name="clock" /> {t(WS.nextCheck, { t: formatCountdown(Math.max(0, nextAt - Date.now())) })}
    </p>
  );
}
