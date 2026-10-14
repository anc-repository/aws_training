/**
 * 证据抽屉 CheckDrawer（08 P05.5；URL `?check=<checkId>`，右侧 560px，窄屏全屏）：
 * 结论（结果、来源、可信度、判定方式、执行者、时间、复核状态；助教“通过 / 打回…”）→ 期望与实际 → 佐证 → 归属 → 原始证据（脱敏 JSON，
 * 显示前再经界面打码器；大于 4 KB 时只有摘要，§9.2 #13 的降级）→ 复现命令（可粘贴，规则同 P05.4）→ 命中的常见错误 → 最近 10 次历史 → 手动确认入口。
 */
import { useMemo, useState } from 'react';
import { useServices } from '../../app/context';
import { isApiError } from '../../api/errors';
import { announce } from '../../lib/announce';
import { formatClock, formatDate } from '../../lib/format';
import { redact } from '../../lib/redact';
import { Button, CheckResultRow, Drawer, Field, Skeleton, SourceTag } from '../../ui';
import { useWorkbench, useWorkspace } from '../context';
import { useResource } from '../data/resource';
import type { CheckRunsResponse } from '../data/types';
import { checkRow, latestResults, type CheckResultItemView } from '../model/checks';
import { checkLocalId, checkRefRequired } from '../model/lab';
import { ManualCommand } from './ManualCommand';

import { t } from '../../i18n';
import { W } from '../strings';
function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'string') return redact(v);
  try {
    return redact(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

const CD = W.checkDrawer;
const BASIS_TEXT: Readonly<Record<string, string>> = CD.basis;

export function CheckDrawer({ checkId, onClose }: { checkId: string; onClose: () => void }) {
  const ws = useWorkspace();
  const wb = useWorkbench();
  const { api } = useServices();
  const lab = ws.data.lab.data;
  const step = lab?.steps?.find((s) => (s.checks ?? []).some((r) => checkLocalId(r) === checkId)) ?? null;
  const ref = step?.checks?.find((r) => checkLocalId(r) === checkId);
  const decl = lab?.checks?.[checkId] ?? null;
  const hist = useResource<CheckRunsResponse>(step ? `hist:${ws.sid}:${step.id}:${ws.data.checkRunTick}` : null, () =>
    api.get<CheckRunsResponse>('listCheckRuns', { params: { sid: ws.sid }, query: { stepId: step!.id, limit: 20 } }),
  );
  const items = useMemo(() => {
    const out: CheckResultItemView[] = [];
    for (const r of hist.data?.items ?? []) for (const it of r.results ?? []) if (it.checkId === checkId) out.push(it);
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  }, [hist.data, checkId]);
  const st = step ? (ws.data.stepMap.get(step.id)?.checks?.[checkId] ?? null) : null;
  const latest = latestResults(hist.data?.items ?? []).get(checkId) ?? null;
  const row = checkRow(checkId, decl, ref ? checkRefRequired(ref, decl ?? undefined) : true, st, latest, false);
  const ev = (latest?.evidence ?? null) as { executor?: { role?: string; function?: string }; assertions?: { label?: string; path: string; expected?: unknown; actual?: unknown; ok: boolean }[]; observed?: unknown } | null;
  const assertions = ev?.assertions?.length ? ev.assertions.map((a) => ({ label: a.label ?? a.path, expected: a.expected, actual: a.actual, ok: a.ok })) : (latest?.keyAssertions ?? []);
  const pitfallIds = latest?.pitfalls ?? [];
  const manual = st?.lastManual ?? null;

  return (
    <Drawer open onClose={onClose} title={t(CD.title, { name: decl?.title ?? checkId })}>
      {!lab ? (
        <Skeleton lines={4} />
      ) : (
        <div className="stack drawer-body" data-check-drawer={checkId}>
          <section className="stack-8" aria-labelledby="cd-verdict">
            <h3 id="cd-verdict" className="small">
              {CD.verdict}
            </h3>
            <div className="chks" role="list">
              <CheckResultRow title={row.title} result={row.result} reason={row.reason} how={row.how} source={row.source} sourceSub={row.sub} trust={row.trust} summary={row.summary} at={row.at} review={row.review} stale={row.stale} />
            </div>
            <dl className="kv">
              <dt>{CD.how}</dt>
              <dd>{row.how === 'manual' ? (row.sub ? t(CD.manualSub, { sub: CD.sub[row.sub] }) : CD.manual) : CD.auto}</dd>
              <dt>{CD.source}</dt>
              <dd>
                <SourceTag source={row.source} sub={row.sub} trust={row.trust} />
              </dd>
              <dt>{CD.executor}</dt>
              <dd className="mono">{row.how === 'manual' ? CD.manualLearner : ev?.executor?.role ? t(CD.executorRole, { role: ev.executor.role, sid: ws.sid }) : (latest?.executor?.function ?? '—')}</dd>
              <dt>{CD.time}</dt>
              <dd>{row.at ? formatDate(row.at, ws.now()) : '—'}</dd>
              {manual?.review ? (
                <>
                  <dt>{CD.review}</dt>
                  <dd>
                    {manual.review.decision === 'approve' ? CD.reviewed : CD.rejected}
                    {manual.review.comment ? t(CD.comment, { text: manual.review.comment }) : ''}
                  </dd>
                </>
              ) : null}
            </dl>
            {ws.role === 'A' && manual && !manual.review ? <ReviewBox confirmationId={manual.confirmationId} /> : null}
            {row.reason === 'OWNERSHIP_PENDING' ? <p className="small muted">{CD.ownershipPending}</p> : null}
            {row.result === 'error' ? <p className="small muted">
                {CD.checkerError}
                {latest?.error?.message ? redact(latest.error.message) : ''}
              </p> : null}
          </section>
          {assertions.length ? (
            <section className="stack-8" aria-labelledby="cd-ea">
              <h3 id="cd-ea" className="small">
                {CD.expectedActual}
              </h3>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{CD.colAssertion}</th>
                      <th scope="col">{CD.colExpected}</th>
                      <th scope="col">{CD.colActual}</th>
                      <th scope="col">{CD.colResult}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assertions.map((a, i) => (
                      <tr key={i}>
                        <td>{a.label}</td>
                        <td className="mono small">{fmt(a.expected)}</td>
                        <td className="mono small">{fmt(a.actual)}</td>
                        <td>
                          <span className={a.ok ? 'st pass' : 'st fail'}>{a.ok ? CD.matches : CD.mismatch}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          {latest?.corroboration?.length ? (
            <section className="stack-8" aria-labelledby="cd-cor">
              <h3 id="cd-cor" className="small">
                {CD.corroboration}
              </h3>
              <ul className="small mlist">
                {latest.corroboration.map((c) => (
                  <li key={c.id}>
                    <span className={c.ok ? 'st pass' : 'st fail'}>{c.ok ? '✓' : '✕'}</span> {c.id}
                    {t(CD.via, { via: c.via })}
                    {c.required ? '' : CD.optionalTail}
                    {c.observed !== undefined ? <span className="mono faint"> · {fmt(c.observed)}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {latest?.ownership ? (
            <section className="stack-8" aria-labelledby="cd-own">
              <h3 id="cd-own" className="small">
                {CD.ownership}
              </h3>
              <p className="small">
                {latest.ownership.basis ? t(CD.basisLine, { basis: BASIS_TEXT[latest.ownership.basis] ?? latest.ownership.basis }) : CD.notConfirmed}
                {latest.ownership.pending ? CD.confirming : ''}
                {latest.ownership.detail ? ` · ${redact(latest.ownership.detail)}` : ''}
              </p>
            </section>
          ) : null}
          <section className="stack-8" aria-labelledby="cd-raw">
            <h3 id="cd-raw" className="small">
              {CD.raw}
            </h3>
            {latest?.evidence ? (
              <details className="disc">
                <summary>{CD.redactedJson}</summary>
                <pre className="mono small evjson">{redact(JSON.stringify(latest.evidence, null, 2))}</pre>
              </details>
            ) : latest?.evidenceKey ? (
              <p className="small muted">{CD.large}</p>
            ) : (
              <p className="small muted">{CD.noEvidence}</p>
            )}
          </section>
          {decl?.reproduce ? (
            <section className="stack-8" aria-labelledby="cd-rep">
              <h3 id="cd-rep" className="small">
                {CD.reproduce}
              </h3>
              <ManualCommand node={{ type: 'code', lang: 'bash', attributes: { runsOn: decl.reproduce.runsOn }, value: decl.reproduce.run }} env={{ lab, step, vars: ws.data.vars.data, blockIndex: new WeakMap() }} />
            </section>
          ) : null}
          {pitfallIds.length ? (
            <section className="stack-8" aria-labelledby="cd-pit">
              <h3 id="cd-pit" className="small">
                {CD.pitfalls}
              </h3>
              <ul className="small mlist">
                {pitfallIds.map((id) => {
                  const p = lab.pitfalls?.[id];
                  return (
                    <li key={id}>
                      <b>● {p?.title ?? id}</b>
                      {p?.cause ? t(CD.cause, { cause: p.cause }) : ''}
                      {p?.fix ? <span className="muted">{t(CD.fix, { fix: p.fix })}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          <section className="stack-8" aria-labelledby="cd-hist">
            <h3 id="cd-hist" className="small">
              {CD.history}
            </h3>
            {hist.loading && !hist.data ? (
              <Skeleton lines={2} />
            ) : items.length ? (
              <ol className="small mlist hist">
                {items.map((it, i) => {
                  const prev = items[i + 1];
                  const drift = prev && prev.result === 'pass' && it.result === 'fail';
                  return (
                    <li key={`${it.at}-${i}`}>
                      <span className="mono">{formatClock(it.at)}</span> {it.result}
                      {it.error?.code ? t(CD.errorCode, { code: it.error.code }) : ''}
                      {drift ? <b>{CD.drift}</b> : null}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="small muted">{CD.noHistory}</p>
            )}
          </section>
          {row.canManual && ws.learner && ws.live && step ? (
            <div>
              <Button onClick={() => wb.openManualConfirm(step.id, checkId)}>{CD.manualConfirm}</Button>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

function ReviewBox({ confirmationId }: { confirmationId: string }) {
  const ws = useWorkspace();
  const { api } = useServices();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const send = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setErr(null);
    try {
      await api.call('reviewManualConfirmation', { params: { sid: ws.sid, confirmationId }, body: { decision, comment } });
      announce(decision === 'approve' ? CD.approvedAnnounce : CD.rejectedAnnounce);
      void ws.data.steps.refresh();
    } catch (e) {
      setErr(isApiError(e) ? (e.detail ?? e.title) : CD.reviewFailed);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="box inset stack-8" data-review="">
      <b className="small">{CD.assistantReview}</b>
      <Field label={CD.commentLabel}>
        <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <div className="row">
        <Button size="sm" variant="primary" busy={busy === 'approve'} onClick={() => void send('approve')}>
          {CD.approve}
        </Button>
        <Button size="sm" busy={busy === 'reject'} onClick={() => void send('reject')}>
          {CD.reject}
        </Button>
      </div>
      {err ? (
        <p className="small st fail" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
