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

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'string') return redact(v);
  try {
    return redact(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

const BASIS_TEXT: Record<string, string> = { stack: '栈成员', ledger: '台账', parent: '父资源', lookup: '定向扫描（CloudTrail）' };

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
    <Drawer open onClose={onClose} title={`检查详情：${decl?.title ?? checkId}`}>
      {!lab ? (
        <Skeleton lines={4} />
      ) : (
        <div className="stack drawer-body" data-check-drawer={checkId}>
          <section className="stack-8" aria-labelledby="cd-verdict">
            <h3 id="cd-verdict" className="small">
              结论
            </h3>
            <div className="chks" role="list">
              <CheckResultRow title={row.title} result={row.result} reason={row.reason} how={row.how} source={row.source} sourceSub={row.sub} trust={row.trust} summary={row.summary} at={row.at} review={row.review} stale={row.stale} />
            </div>
            <dl className="kv">
              <dt>判定方式</dt>
              <dd>{row.how === 'manual' ? `手动${row.sub ? `（${row.sub === 'native' ? '原生' : row.sub === 'degraded' ? '降级' : '带证据'}）` : ''}` : '自动'}</dd>
              <dt>来源</dt>
              <dd>
                <SourceTag source={row.source} sub={row.sub} trust={row.trust} />
              </dd>
              <dt>执行者</dt>
              <dd className="mono">{row.how === 'manual' ? '提交手动确认的学员' : ev?.executor?.role ? `${ev.executor.role}（atl-${ws.sid}-verify）` : (latest?.executor?.function ?? '—')}</dd>
              <dt>时间</dt>
              <dd>{row.at ? formatDate(row.at, ws.now()) : '—'}</dd>
              {manual?.review ? (
                <>
                  <dt>复核</dt>
                  <dd>
                    {manual.review.decision === 'approve' ? '助教已复核' : '被打回'}
                    {manual.review.comment ? `：${manual.review.comment}` : ''}
                  </dd>
                </>
              ) : null}
            </dl>
            {ws.role === 'A' && manual && !manual.review ? <ReviewBox confirmationId={manual.confirmationId} /> : null}
            {row.reason === 'OWNERSHIP_PENDING' ? <p className="small muted">正在确认这个资源是你在本次实验中创建的（CloudTrail 通常几分钟，不作保证）。平台会按 2、2、4、4、8 分钟的节奏复查。</p> : null}
            {row.result === 'error' ? <p className="small muted">检测器出错，不是你的问题。{latest?.error?.message ? redact(latest.error.message) : ''}</p> : null}
          </section>
          {assertions.length ? (
            <section className="stack-8" aria-labelledby="cd-ea">
              <h3 id="cd-ea" className="small">
                期望与实际
              </h3>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">断言</th>
                      <th scope="col">期望</th>
                      <th scope="col">实际</th>
                      <th scope="col">结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assertions.map((a, i) => (
                      <tr key={i}>
                        <td>{a.label}</td>
                        <td className="mono small">{fmt(a.expected)}</td>
                        <td className="mono small">{fmt(a.actual)}</td>
                        <td>
                          <span className={a.ok ? 'st pass' : 'st fail'}>{a.ok ? '✓ 符合' : '✕ 不符合'}</span>
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
                佐证
              </h3>
              <ul className="small mlist">
                {latest.corroboration.map((c) => (
                  <li key={c.id}>
                    <span className={c.ok ? 'st pass' : 'st fail'}>{c.ok ? '✓' : '✕'}</span> {c.id}（{c.via}）{c.required ? '' : ' · 可选'}
                    {c.observed !== undefined ? <span className="mono faint"> · {fmt(c.observed)}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {latest?.ownership ? (
            <section className="stack-8" aria-labelledby="cd-own">
              <h3 id="cd-own" className="small">
                归属
              </h3>
              <p className="small">
                {latest.ownership.basis ? `依据：${BASIS_TEXT[latest.ownership.basis] ?? latest.ownership.basis}` : '尚未确认'}
                {latest.ownership.pending ? ' · 确认中' : ''}
                {latest.ownership.detail ? ` · ${redact(latest.ownership.detail)}` : ''}
              </p>
            </section>
          ) : null}
          <section className="stack-8" aria-labelledby="cd-raw">
            <h3 id="cd-raw" className="small">
              原始证据
            </h3>
            {latest?.evidence ? (
              <details className="disc">
                <summary>脱敏后的 JSON（已打码）</summary>
                <pre className="mono small evjson">{redact(JSON.stringify(latest.evidence, null, 2))}</pre>
              </details>
            ) : latest?.evidenceKey ? (
              <p className="small muted">证据较大，摘要已显示；完整证据可在报告导出中查看。</p>
            ) : (
              <p className="small muted">还没有证据。</p>
            )}
          </section>
          {decl?.reproduce ? (
            <section className="stack-8" aria-labelledby="cd-rep">
              <h3 id="cd-rep" className="small">
                复现命令
              </h3>
              <ManualCommand node={{ type: 'code', lang: 'bash', attributes: { runsOn: decl.reproduce.runsOn }, value: decl.reproduce.run }} env={{ lab, step, vars: ws.data.vars.data, blockIndex: new WeakMap() }} />
            </section>
          ) : null}
          {pitfallIds.length ? (
            <section className="stack-8" aria-labelledby="cd-pit">
              <h3 id="cd-pit" className="small">
                常见错误
              </h3>
              <ul className="small mlist">
                {pitfallIds.map((id) => {
                  const p = lab.pitfalls?.[id];
                  return (
                    <li key={id}>
                      <b>● {p?.title ?? id}</b>
                      {p?.cause ? `：${p.cause}` : ''}
                      {p?.fix ? <span className="muted"> 处理：{p.fix}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          <section className="stack-8" aria-labelledby="cd-hist">
            <h3 id="cd-hist" className="small">
              历史（最近 10 次）
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
                      {it.error?.code ? `（${it.error.code}）` : ''}
                      {drift ? <b> [!] 漂移</b> : null}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="small muted">还没有检测记录。</p>
            )}
          </section>
          {row.canManual && ws.learner && ws.live && step ? (
            <div>
              <Button onClick={() => wb.openManualConfirm(step.id, checkId)}>手动确认…</Button>
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
      announce(decision === 'approve' ? '已通过' : '已打回');
      void ws.data.steps.refresh();
    } catch (e) {
      setErr(isApiError(e) ? (e.detail ?? e.title) : '没能提交复核');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="box inset stack-8" data-review="">
      <b className="small">助教复核</b>
      <Field label="评语（打回时学员会看到）">
        <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      <div className="row">
        <Button size="sm" variant="primary" busy={busy === 'approve'} onClick={() => void send('approve')}>
          通过
        </Button>
        <Button size="sm" busy={busy === 'reject'} onClick={() => void send('reject')}>
          打回…
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
