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
  if (!loaded && error) return <InlineProblem error={error} onRetry={onRetry} title="逐步证据" />;
  if (!loaded) return <Skeleton lines={4} label="正在读取步骤" />;
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const order: LabStep[] = lab?.steps?.length ? lab.steps : steps.map((s) => ({ id: s.stepId, title: s.stepId, checks: Object.keys(s.checks ?? {}).map((k) => k.split('/').pop()!) }));
  if (!order.length) return <p className="small muted">没有步骤记录。</p>;
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
                  <span title={formatUtcTitle(r.firstPassedAt)}> · 首次达成 {formatDate(r.firstPassedAt, nowMs)}</span>
                ) : null}
                {spent ? ` · 用时 ${spent}` : ''}
                {r?.driftEvents?.length ? ` · 漂移 ${r.driftEvents.length} 次` : ''}
              </span>
            </div>
            {checks.length ? (
              <div className="chks" role="list" aria-label={`第 ${i + 1} 步的检查`}>
                {checks.map(({ cid, key, required, c }) => {
                  const decl = lab?.checks?.[cid];
                  const manual = c?.lastManual && (c.effective === 'manual' || c.effective === 'manual_evidence');
                  const digest = c?.lastPass?.evidenceDigest ?? c?.lastAuto?.evidenceDigest ?? null;
                  const prov = c?.lastPass?.provenance;
                  const summary = [
                    prov && prov !== 'this-session' ? '继承自交接链中的会话' : c?.lastPass ? '本次完成' : null,
                    c?.ownershipPending ? '归属在会话结束后确认' : null,
                    manual && c?.lastManual?.observed ? `手动确认：看到的值 ${redact(c.lastManual.observed)}` : null,
                    digest ? `证据摘要 ${digest.slice(0, 15)}…` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <CheckResultRow
                      key={key}
                      title={`${decl?.title ?? cid}${required ? '' : '（选做）'}`}
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

const TRIGGER_TEXT: Record<string, string> = {
  learner: '学员',
  user: '学员',
  manual: '学员',
  auto: '自动',
  schedule: '自动',
  wait: '等待轮询',
  poll: '等待轮询',
  submit: '提交',
  'expiring-precheck': '到期预检',
  precheck: '到期预检',
  finalize: '定稿',
  final: '定稿',
  ownership: '延迟归属',
  'late-ownership': '延迟归属',
  assistant: '助教',
};

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
  if (!data.loaded && data.status === 'error') return <InlineProblem error={data.error} onRetry={() => void data.refresh()} title="检查记录" />;
  if (!data.loaded) return <Skeleton lines={3} />;
  if (!rows.length) return <p className="small muted">没有检查记录。</p>;
  const shown = rows.filter((r) => !filter || r.result === filter);
  return (
    <div className="stack-8">
      <div className="filters">
        <label className="small muted" htmlFor={`ch-f-${sid}`}>
          按结果筛选
        </label>
        <select id={`ch-f-${sid}`} className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部</option>
          {[...new Set(rows.map((r) => r.result))].map((r) => (
            <option key={r} value={r}>
              {CHECK_RESULT_META[r].text}
            </option>
          ))}
        </select>
        {data.data?.next ? <span className="small muted">显示最近 100 次检测；完整记录见 HTML 报告。</span> : null}
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <caption className="sr">完整检查记录</caption>
          <thead>
            <tr>
              <th scope="col">时间</th>
              <th scope="col">检查</th>
              <th scope="col">结果</th>
              <th scope="col">错误码</th>
              <th scope="col">触发方式</th>
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
                <td className="small">{TRIGGER_TEXT[r.trigger] ?? (r.trigger ? '其他' : '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
