/**
 * P07-M 待人工处理清单（跨会话）`/resources/manual`（08 P07-M；02 §7.9；01 `GET /resources/manual`，L A）。
 * - 按会话分组，组标题“svc-cdn · 10/13 · 会话 s4k7…”：卡片与日期取各会话的视图（清单条目只有 sessionId，见 §9.2 #32 / scaffold 的配合事项）；
 * - 筛选：严重级别、计费方式（查询串 `severity`、`billing`）；导出：每个会话的回收清单 Markdown / JSON；
 * - 每项有控制台链接与 CLI 命令，处理后可重新核对（学员）；助教只读；
 * - 空状态：“没有未释放的资源。”；60 秒刷新（页面可见时），核对结果出来后立即刷新。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { SessionView } from '../../api/types';
import { useAuth, useServices } from '../../app/context';
import { formatDate } from '../../lib/format';
import { BILLING_TEXT, EmptyState, Skeleton } from '../../ui';
import { CleanupExport } from '../end/CleanupExport';
import { isOpen, normalizeResource, type LedgerItem } from '../end/resources';
import { InlineProblem } from '../errors/InlineProblem';
import { useApiData } from '../sessions/data';
import '../sessions/pages.css';
import { ManualList } from './ManualList';

import { msg, rich, t } from '../../i18n';
interface ManualView {
  items?: Record<string, unknown>[];
  total?: number;
  hourlyBlocking?: number;
}

const MP = msg.frame.manualPage;
const SEVERITIES = [
  ['', 'all'],
  ['BLOCKING', 'BLOCKING'],
  ['REVIEW', 'REVIEW'],
  ['INFO', 'INFO'],
] as const;

const BILLINGS = ['hourly', 'storage', 'monthly', 'usage', 'none'] as const;

/** 各会话的卡片与开始时间（清单条目没有这两项）。 */
function useSessionHeads(sids: readonly string[]): Record<string, Pick<SessionView, 'labId' | 'createdAt' | 'state'>> {
  const { api } = useServices();
  const [heads, setHeads] = useState<Record<string, Pick<SessionView, 'labId' | 'createdAt' | 'state'>>>({});
  const key = sids.join(',');
  useEffect(() => {
    let cancelled = false;
    for (const sid of key ? key.split(',') : []) {
      api
        .get<SessionView>('getSession', { params: { sid } })
        .then((v) => {
          if (!cancelled && v) setHeads((h) => ({ ...h, [sid]: { labId: v.labId, createdAt: v.createdAt, state: v.state } }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [api, key]);
  return heads;
}

export default function ManualResourcesPage() {
  const { clock } = useServices();
  const auth = useAuth();
  const L = auth.principal?.role === 'L';
  const [search, setSearch] = useSearchParams();
  const severity = search.get('severity') ?? '';
  const billing = search.get('billing') ?? '';
  const data = useApiData<ManualView>('manual', 'listManualResources', { conditional: false }, 60_000);
  const items = useMemo(() => (data.data?.items ?? []).map(normalizeResource).filter(isOpen), [data.data]);
  const filtered = items.filter((r) => (!severity || (r.severity ?? 'BLOCKING') === severity) && (!billing || r.billing === billing));
  const groups = useMemo(() => {
    const m = new Map<string, LedgerItem[]>();
    for (const r of filtered) {
      const k = r.sessionId ?? '—';
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()];
  }, [filtered]);
  const heads = useSessionHeads(groups.map(([sid]) => sid).filter((s) => s !== '—'));
  const [unmasked, setUnmasked] = useState(false);
  useEffect(() => {
    if (!unmasked) return undefined;
    const t = setTimeout(() => setUnmasked(false), 30_000);
    return () => clearTimeout(t);
  }, [unmasked]);
  const setFilter = (k: 'severity' | 'billing', v: string) => {
    const next = new URLSearchParams(search);
    if (v) next.set(k, v);
    else next.delete(k);
    setSearch(next, { replace: true });
  };
  const hourly = items.filter((r) => r.severity === 'BLOCKING' && r.billing === 'hourly').length;

  return (
    <div className="stack-16" data-screen="P07-M">
      <div>
        <nav className="crumbs-row" aria-label={MP.crumbs}>
          <Link to="/sessions">{MP.mySessions}</Link>
          <span aria-hidden="true">›</span>
          <span>{MP.title}</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>{MP.title}</h1>
            <span className="sub">{MP.sub}</span>
          </div>
          {L && items.length ? (
            <span className="acts">
              <button type="button" className="linkbtn" aria-pressed={unmasked} onClick={() => setUnmasked((v) => !v)}>
                {unmasked ? MP.remask : MP.unmask}
              </button>
            </span>
          ) : null}
        </div>
      </div>

      <div className="filters" role="group" aria-label={MP.filters}>
        <span className="fi">
          <label className="small muted" htmlFor="mf-sev">
            {MP.severityLabel}
          </label>
          <select id="mf-sev" className="input" value={severity} onChange={(e) => setFilter('severity', e.target.value)}>
            {SEVERITIES.map(([v, k]) => (
              <option key={v} value={v}>
                {MP.severity[k]}
              </option>
            ))}
          </select>
        </span>
        <span className="fi">
          <label className="small muted" htmlFor="mf-bill">
            {MP.billing}
          </label>
          <select id="mf-bill" className="input" value={billing} onChange={(e) => setFilter('billing', e.target.value)}>
            <option value="">{MP.all}</option>
            {BILLINGS.map((b) => (
              <option key={b} value={b}>
                {BILLING_TEXT[b]}
              </option>
            ))}
          </select>
        </span>
        {data.loaded ? (
          <span className="small muted" role="status">
            {hourly ? t(MP.countHourly, { n: items.length, h: hourly }) : t(MP.count, { n: items.length })}
          </span>
        ) : null}
      </div>

      {!data.loaded && data.status === 'error' ? (
        <InlineProblem error={data.error} onRetry={() => void data.refresh()} title={MP.title} />
      ) : !data.loaded ? (
        <Skeleton lines={4} block />
      ) : !items.length ? (
        <EmptyState
          title={MP.emptyTitle}
          action={
            <Link className="btn" to="/sessions">
              {MP.viewSessions}
            </Link>
          }
        >
          {MP.emptyBody}
        </EmptyState>
      ) : !filtered.length ? (
        <EmptyState
          title={MP.noMatch}
          action={
            <button type="button" className="btn" onClick={() => setSearch(new URLSearchParams(), { replace: true })}>
              {MP.clear}
            </button>
          }
        />
      ) : (
        <>
          <p className="small muted">{MP.tagNote}</p>
          {groups.map(([sid, list]) => {
            const h = heads[sid];
            return (
              <section key={sid} className="sec" aria-labelledby={`mg-${sid}`} data-group={sid}>
                <h2 id={`mg-${sid}`}>
                  {h?.labId ?? MP.previous}
                  {h?.createdAt ? ` · ${formatDate(h.createdAt, clock.now())}` : ''}
                  {rich(MP.session, { sid: <span className="mono">{sid === '—' ? '—' : `${sid.slice(0, 4)}…`}</span> })}
                  <span className="aside">
                    {sid !== '—' ? (
                      <>
                        <Link to={`/sessions/${sid}/end#manual`}>{MP.reclaim}</Link> · <CleanupExport sid={sid} label={MP.export} compact />
                      </>
                    ) : null}
                  </span>
                </h2>
                <ManualList items={list} sid={sid === '—' ? undefined : sid} canAct={L} unmasked={unmasked} onChanged={() => void data.refresh()} />
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
