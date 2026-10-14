/**
 * 报告的“逐步证据”与“检查记录”（08 P08 章节表；§5.4 StepEvidenceList / CheckHistoryTable）。
 * SPA 在 §9.2 #12 回写前取不到 `atl.report/v1` 正文，所以用会话内可取得的数据渲染（08 P08“数据来源”的降级）：
 * 步骤 `GET /sessions/{sid}/steps`、检测历史 `GET /sessions/{sid}/check-runs`；步骤与检查的标题取手册 JSON。
 */
import type { CheckSource } from '@atl/shared';
import { useMemo, useState } from 'react';
import { formatDate, formatSpan, formatUtcTitle } from '../../lib/format';
import { redact } from '../../lib/redact';
import { CHECK_RESULT_META, CheckResultRow, Skeleton, Status, STEP_STATE_META, type CheckResult, type StepState } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { stepCheckRefs, useApiData, type LabContent, type LabStep } from '../sessions/data';

import { t } from '../../i18n';
import { RP } from './strings';
export interface CheckState {
  effective?: string;
  required?: boolean;
  type?: string;
  lastAuto?: { result?: string; at?: string; errorCode?: string | null; evidenceDigest?: string };
  lastPass?: { at?: string; evidenceDigest?: string; provenance?: string };
  firstPassAt?: string;
  lastManual?: { observed?: string; at?: string; result?: string; kind?: string; review?: { decision?: string } };
  stale?: boolean;
  ownershipPending?: boolean;
}

export interface StepResult {
  stepId: string;
  state?: string;
  checks?: Record<string, CheckState>;
  firstPassedAt?: string | null;
  firstViewedAt?: string | null;
  startedAt?: string | null;
  driftEvents?: unknown[];
  skipped?: boolean;
  provenance?: string | null;
}

export function sourceOfType(type: string | undefined): CheckSource {
  switch (type) {
    case 'capability':
      return 'PROBE';
    case 'aws-readonly':
      return 'AWS';
    case 'experiment':
      return 'EXP';
    case 'manual':
      return 'MANUAL';
    default:
      return 'LOCAL';
  }
}

const CHECK_RESULTS = new Set(Object.keys(CHECK_RESULT_META));

export function asCheckResult(v: string | undefined): CheckResult {
  return v && CHECK_RESULTS.has(v) ? (v as CheckResult) : 'not_run';
}

export function StepEvidence({ sid, lab, steps, loaded, error, onRetry, nowMs }: { sid: string; lab: LabContent | null; steps: readonly StepResult[]; loaded: boolean; error: Parameters<typeof InlineProblem>[0]['error']; onRetry: () => void; nowMs: number }) {
  if (!loaded && error) return <InlineProblem error={error} onRetry={onRetry} title={RP.evidence.title} />;
  if (!loaded) return <Skeleton lines={4} label={RP.evidence.readingSteps} />;
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const order: LabStep[] = lab?.steps?.length ? lab.steps : steps.map((s) => ({ id: s.stepId, title: s.stepId, checks: Object.keys(s.checks ?? {}).map((k) => k.split('/').pop()!) }));
  if (!order.length) return <p className="small muted">{RP.evidence.noSteps}</p>;
  return (
    <div data-steps={order.length}>
      {order.map((st, i) => {
        const r = byId.get(st.id);
        const state = (r?.skipped ? 'skipped' : (r?.state ?? 'available')) as StepState;
        const meta = STEP_STATE_META[state] ?? STEP_STATE_META.available;
        const resultOf = (k: string) => r?.checks?.[`${lab?.id ?? ''}/${k}`] ?? r?.checks?.[k] ?? Object.entries(r?.checks ?? {}).find(([key]) => key.endsWith(`/${k}`))?.[1];
        const checks = stepCheckRefs(st).map(({ id, key, required }) => ({ cid: id, key, required, c: resultOf(key) ?? (key !== id ? resultOf(id) : undefined) }));
        const spent = r?.firstViewedAt && r.firstPassedAt ? formatSpan(Date.parse(r.firstPassedAt) - Date.parse(r.firstViewedAt)) : null;
        return (
          <div key={st.id} className="stepev" id={`step-${sid}-${st.id}`} data-step={st.id} data-state={state}>
            <div className="row">
              <Status meta={meta} shapeOnly />
              <b>
                {i + 1} {st.title ?? st.id}
              </b>
              <span className="small faint">
                {st.type ? `${st.type} · ` : ''}
                {meta.text}
                {r?.firstPassedAt ? (
                  <span title={formatUtcTitle(r.firstPassedAt)}>{t(RP.evidence.firstPassed, { t: formatDate(r.firstPassedAt, nowMs) })}</span>
                ) : null}
                {spent ? t(RP.evidence.spent, { t: spent }) : ''}
                {r?.driftEvents?.length ? t(RP.evidence.drift, { n: r.driftEvents.length }) : ''}
              </span>
            </div>
            {checks.length ? (
              <div className="chks" role="list" aria-label={t(RP.evidence.stepChecks, { n: i + 1 })}>
                {checks.map(({ cid, key, required, c }) => {
                  const decl = lab?.checks?.[cid];
                  const manual = c?.lastManual && (c.effective === 'manual' || c.effective === 'manual_evidence');
                  const digest = c?.lastPass?.evidenceDigest ?? c?.lastAuto?.evidenceDigest ?? null;
                  const prov = c?.lastPass?.provenance;
                  const summary = [
                    prov && prov !== 'this-session' ? RP.evidence.inherited : c?.lastPass ? RP.evidence.thisSession : null,
                    c?.ownershipPending ? RP.evidence.ownershipPending : null,
                    manual && c?.lastManual?.observed ? t(RP.evidence.manualObserved, { v: redact(c.lastManual.observed) }) : null,
                    digest ? t(RP.evidence.digest, { d: digest.slice(0, 15) }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <CheckResultRow
                      key={key}
                      title={`${decl?.title ?? cid}${required ? '' : RP.evidence.optional}`}
                      result={asCheckResult(c?.effective)}
                      reason={c?.ownershipPending ? 'OWNERSHIP_PENDING' : (c?.lastAuto?.errorCode ?? null)}
                      how={manual ? 'manual' : 'auto'}
                      source={sourceOfType(decl?.type ?? c?.type)}
                      sourceSub={manual ? (c?.lastManual?.result === 'manual_evidence' ? 'evidence' : c?.lastManual?.kind === 'degraded' ? 'degraded' : 'native') : null}
                      summary={summary || undefined}
                      at={c?.lastPass?.at ?? c?.lastAuto?.at ?? c?.lastManual?.at ?? null}
                      stale={!!c?.stale}
                      review={c?.lastManual?.review ? (c.lastManual.review.decision === 'reject' ? 'rejected' : 'approved') : null}
                      focusKey={`${st.id}/${key}`}
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface CheckRunItem {
  runId: string;
  stepId?: string | null;
  trigger?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  results?: { checkKey: string; checkId?: string; result?: string; error?: { code?: string } | null; at?: string }[];
}

const TRIGGER_TEXT: Readonly<Record<string, string>> = RP.evidence.trigger;

export function CheckHistory({ sid, lab, nowMs }: { sid: string; lab: LabContent | null; nowMs: number }) {
  const data = useApiData<{ items?: CheckRunItem[]; next?: string | null }>(`runs:${sid}`, 'listCheckRuns', { params: { sid }, query: { limit: 100 }, conditional: false });
  const [filter, setFilter] = useState('');
  const rows = useMemo(
    () =>
      (data.data?.items ?? []).flatMap((run) =>
        (run.results ?? []).map((r) => ({
          key: `${run.runId}/${r.checkKey}`,
          at: r.at ?? run.finishedAt ?? run.startedAt ?? run.createdAt ?? '',
          checkId: r.checkId ?? r.checkKey.split('/').pop() ?? r.checkKey,
          result: asCheckResult(r.result),
          code: r.error?.code ?? null,
          trigger: run.trigger ?? '',
        })),
      ),
    [data.data],
  );
  if (!data.loaded && data.status === 'error') return <InlineProblem error={data.error} onRetry={() => void data.refresh()} title={RP.evidence.historyTitle} />;
  if (!data.loaded) return <Skeleton lines={3} />;
  if (!rows.length) return <p className="small muted">{RP.evidence.noHistory}</p>;
  const shown = rows.filter((r) => !filter || r.result === filter);
  return (
    <div className="stack-8">
      <div className="filters">
        <label className="small muted" htmlFor={`ch-f-${sid}`}>
          {RP.evidence.filterByResult}
        </label>
        <select id={`ch-f-${sid}`} className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">{RP.evidence.all}</option>
          {[...new Set(rows.map((r) => r.result))].map((r) => (
            <option key={r} value={r}>
              {CHECK_RESULT_META[r].text}
            </option>
          ))}
        </select>
        {data.data?.next ? <span className="small muted">{RP.evidence.recentOnly}</span> : null}
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <caption className="sr">{RP.evidence.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{RP.evidence.colTime}</th>
              <th scope="col">{RP.evidence.colCheck}</th>
              <th scope="col">{RP.evidence.colResult}</th>
              <th scope="col">{RP.evidence.colCode}</th>
              <th scope="col">{RP.evidence.colTrigger}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key}>
                <td className="tnum nowrap" title={r.at ? formatUtcTitle(r.at) : undefined}>
                  {r.at ? formatDate(r.at, nowMs) : '—'}
                </td>
                <td>{lab?.checks?.[r.checkId]?.title ?? <span className="mono small">{r.checkId}</span>}</td>
                <td>
                  <Status meta={CHECK_RESULT_META[r.result]} />
                </td>
                <td className="mono small">{r.code ?? '—'}</td>
                <td className="small">{TRIGGER_TEXT[r.trigger] ?? (r.trigger ? RP.evidence.other : '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
