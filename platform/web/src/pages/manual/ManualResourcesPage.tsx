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

interface ManualView {
  items?: Record<string, unknown>[];
  total?: number;
  hourlyBlocking?: number;
}

const SEVERITIES = [
  ['', '全部'],
  ['BLOCKING', '阻塞'],
  ['REVIEW', '需复核'],
  ['INFO', '信息'],
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
        <nav className="crumbs-row" aria-label="面包屑">
          <Link to="/sessions">我的实验</Link>
          <span aria-hidden="true">›</span>
          <span>待人工处理清单</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>待人工处理清单</h1>
            <span className="sub">跨会话汇总 · 每项都有控制台链接与 CLI 命令，处理后可重新核对</span>
          </div>
          {L && items.length ? (
            <span className="acts">
              <button type="button" className="linkbtn" aria-pressed={unmasked} onClick={() => setUnmasked((v) => !v)}>
                {unmasked ? '恢复打码' : '显示完整名称'}
              </button>
            </span>
          ) : null}
        </div>
      </div>

      <div className="filters" role="group" aria-label="筛选">
        <span className="fi">
          <label className="small muted" htmlFor="mf-sev">
            严重级别
          </label>
          <select id="mf-sev" className="input" value={severity} onChange={(e) => setFilter('severity', e.target.value)}>
            {SEVERITIES.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </span>
        <span className="fi">
          <label className="small muted" htmlFor="mf-bill">
            计费方式
          </label>
          <select id="mf-bill" className="input" value={billing} onChange={(e) => setFilter('billing', e.target.value)}>
            <option value="">全部</option>
            {BILLINGS.map((b) => (
              <option key={b} value={b}>
                {BILLING_TEXT[b]}
              </option>
            ))}
          </select>
        </span>
        {data.loaded ? (
          <span className="small muted" role="status">
            共 {items.length} 项{hourly ? `，其中 ${hourly} 项阻塞且按小时计费` : ''}
          </span>
        ) : null}
      </div>

      {!data.loaded && data.status === 'error' ? (
        <InlineProblem error={data.error} onRetry={() => void data.refresh()} title="待人工处理清单" />
      ) : !data.loaded ? (
        <Skeleton lines={4} block />
      ) : !items.length ? (
        <EmptyState
          title="没有未释放的资源。"
          action={
            <Link className="btn" to="/sessions">
              查看我的实验
            </Link>
          }
        >
          回收失败或复扫发现的残留会出现在这里。
        </EmptyState>
      ) : !filtered.length ? (
        <EmptyState
          title="没有符合筛选条件的条目。"
          action={
            <button type="button" className="btn" onClick={() => setSearch(new URLSearchParams(), { replace: true })}>
              清除筛选
            </button>
          }
        />
      ) : (
        <>
          <p className="small muted">这些资源都带有 atl:env-id 标签，可以在控制台按标签查找。处理后点“我已处理，重新核对”，平台会复核并在全部处理后结束回收。</p>
          {groups.map(([sid, list]) => {
            const h = heads[sid];
            return (
              <section key={sid} className="sec" aria-labelledby={`mg-${sid}`} data-group={sid}>
                <h2 id={`mg-${sid}`}>
                  {h?.labId ?? '之前的实验'}
                  {h?.createdAt ? ` · ${formatDate(h.createdAt, clock.now())}` : ''} · 会话 <span className="mono">{sid === '—' ? '—' : `${sid.slice(0, 4)}…`}</span>
                  <span className="aside">
                    {sid !== '—' ? (
                      <>
                        <Link to={`/sessions/${sid}/end#manual`}>回收进度</Link> · <CleanupExport sid={sid} label="导出" compact />
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
