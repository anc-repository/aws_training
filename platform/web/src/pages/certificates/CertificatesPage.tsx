/**
 * P09-A 证书与徽章 `/certificates?tab=tracks|badges`（08 P09-A；04 §10；tracks §5）。
 * - 常驻性质声明：自托管平台的完成证明，不是 AWS 官方认证；
 * - 路径证书：9 条路径各一行——未达成 ○（必修 x/y · 选修组 · 已核验占比）、可领取 ◎（置顶，主按钮“领取…”）、已领取 ●（证书号、日期、
 *   是否公开）、已吊销 ✕（原因）；被新证书取代的旧证书折叠到“历史证书”；核验中的徽章注明“结束后才能计入”；
 * - 卡片徽章：按类别分组的徽章墙（未获得为空心轮廓），“只看已获得”；点击打开 BadgeDetail 抽屉；
 * - 数据：`GET /certificates`、`GET /tracks` + `GET /tracks/{trackId}`（条件与进度）、`GET /me/progress`、目录索引；
 *   徽章与证书类事件到达时、页面重新可见时刷新；页面本身不轮询会话事件；A、O 只读。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, useServices, useSessionEvents } from '../../app/context';
import { formatDate } from '../../lib/format';
import { Button, Drawer, EmptyState, Icon, Skeleton, Status } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { useAction } from '../errors/useAction';
import { cardTitle, useApiData, useCatalogIndex, type CatalogCard } from '../sessions/data';
import '../sessions/pages.css';
import { BadgeGlyph, type BadgeState } from './BadgeGlyph';
import { BADGE_LEVEL_META, pct, revokeReasonText, TRACK_CERT_META, type TrackCertState } from './certText';
import { ClaimDialog, issuedCertId, type IssuedCert } from './ClaimDialog';

import { t as tr } from '../../i18n';
import { CT } from './strings';

const CL = CT.list;
export interface CertificateItem {
  certId: string;
  scope?: 'track' | 'lab';
  trackId?: string | null;
  labIds?: string[];
  sessionIds?: string[];
  issuedAt?: string;
  kid?: string;
  status?: 'valid' | 'revoked';
  revokedAt?: string | null;
  revokeReason?: string | null;
  public?: boolean;
  displayName?: string;
  jws?: string;
}

interface TrackSummary {
  id: string;
  title?: string;
  certificate?: { enabled?: boolean; title?: string };
  completion?: { minAutoRatio?: number };
  progress?: { requiredDone?: number; requiredTotal?: number; completed?: boolean; eligible?: boolean };
}

interface TrackDetail {
  track?: TrackSummary;
  progress?: { groups?: { groupId: string; pick: number; done: number }[]; verifiedRatio?: number | null; requiredDone?: number; requiredTotal?: number };
  certificate?: { eligible?: boolean; reasons?: unknown[]; current?: { certId: string; status: string } | null };
}

export interface LabBadge {
  level?: string;
  status?: string;
  earnedAt?: string;
  attemptId?: string;
  labVersion?: string;
  catalogVersion?: string;
  variant?: string;
  evidenceScore?: number;
  quiz?: { bestScore?: number; attempts?: number };
}

interface ProgressView {
  labs?: { labId: string; kind?: string; badge?: LabBadge | null; attempts?: number }[];
  subject?: { displayName?: string | null };
}

export function badgeState(b: LabBadge | null | undefined): BadgeState {
  if (!b) return 'none';
  if (b.status === 'withdrawn') return 'withdrawn';
  if (b.status === 'pending') return 'pending';
  return b.level === 'attested' ? 'attested' : b.level === 'self-reported' ? 'self-reported' : 'verified';
}

export function badgeStateText(s: BadgeState): string {
  return s === 'none' ? CL.none : s === 'pending' ? CL.pending : s === 'withdrawn' ? CL.withdrawn : (BADGE_LEVEL_META[s]?.text ?? s);
}

const CATEGORY_ORDER = ['base', 'A', 'B', 'C', 'D', 'E', 'F', 'scenario'];

function useTrackDetails(ids: readonly string[], reload: number): Record<string, TrackDetail> {
  const { api } = useServices();
  const [map, setMap] = useState<Record<string, TrackDetail>>({});
  const key = ids.join(',');
  useEffect(() => {
    let cancelled = false;
    for (const id of key ? key.split(',') : []) {
      api
        .get<TrackDetail>('getTrack', { params: { trackId: id }, conditional: false })
        .then((d) => {
          if (!cancelled && d) setMap((m) => ({ ...m, [id]: d }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [api, key, reload]);
  return map;
}

export default function CertificatesPage() {
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const L = role === 'L';
  const { clock } = useServices();
  const [search] = useSearchParams();
  const tab = search.get('tab') === 'badges' ? 'badges' : 'tracks';
  const [reload, setReload] = useState(0);
  const certs = useApiData<{ items?: CertificateItem[] }>(`certs:${reload}`, 'listCertificates', { conditional: false });
  const tracks = useApiData<{ items?: TrackSummary[] }>(`tracks:${reload}`, 'listTracks', { conditional: false });
  const progress = useApiData<ProgressView>(`progress:${reload}`, 'getMyProgress', { conditional: false });
  const details = useTrackDetails((tracks.data?.items ?? []).map((t) => t.id), reload);
  const index = useCatalogIndex();
  const [claim, setClaim] = useState<TrackSummary | null>(null);
  const [badge, setBadge] = useState<string | null>(null);
  const [onlyEarned, setOnlyEarned] = useState(false);
  const refresh = useCallback(() => setReload((x) => x + 1), []);
  // 徽章、路径、证书类事件（任一会话）→ 刷新
  useSessionEvents(refresh, { prefixes: ['badge.', 'certificate.'], types: ['track.completed'] });
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);
  // 需要最近登录之后回来：重放领取请求
  const navigate = useNavigate();
  const replay = useAction<IssuedCert>('issueCertificate', {
    replay: true,
    onSuccess: (d) => {
      const id = issuedCertId(d);
      if (id) navigate(`/certificates/${id}`);
      else refresh();
    },
  });
  const labTitle = (id: string) => cardTitle(index, id);
  const now = clock.now();

  const certList = useMemo(() => certs.data?.items ?? [], [certs.data]);
  const rows = useMemo(() => {
    const list = (tracks.data?.items ?? []).map((t) => {
      const mine = certList.filter((c) => c.scope !== 'lab' && c.trackId === t.id).sort((a, b) => String(b.issuedAt ?? '').localeCompare(String(a.issuedAt ?? '')));
      const valid = mine.find((c) => c.status === 'valid') ?? null;
      const revoked = !valid ? (mine.find((c) => c.status === 'revoked' && c.revokeReason !== 'superseded') ?? null) : null;
      const history = mine.filter((c) => c !== valid && c !== revoked);
      const d = details[t.id];
      const eligible = d?.certificate?.eligible ?? t.progress?.eligible ?? false;
      const state: TrackCertState = t.certificate?.enabled === false ? 'disabled' : valid ? 'issued' : eligible ? 'eligible' : revoked ? 'revoked' : 'not-eligible';
      return { t, valid, revoked, history, d, eligible, state };
    });
    return list.sort((a, b) => Number(b.state === 'eligible') - Number(a.state === 'eligible'));
  }, [tracks.data, certList, details]);

  const badges = progress.data?.labs ?? [];
  const badgeOf = (labId: string) => badges.find((p) => p.labId === labId)?.badge ?? null;
  const cards = useMemo(() => index?.cards ?? [], [index]);
  const earned = cards.filter((c) => badgeOf(c.id)).length;
  const groups = useMemo(() => {
    const g = new Map<string, CatalogCard[]>();
    for (const c of cards) {
      const k = c.kind === 'scenario' ? 'scenario' : (c.category ?? 'base');
      g.set(k, [...(g.get(k) ?? []), c]);
    }
    return CATEGORY_ORDER.filter((k) => g.has(k)).map((k) => [k, g.get(k)!] as const);
  }, [cards]);
  const catLabel = (k: string) => {
    if (k === 'scenario') return CL.scenario;
    const label = index?.taxonomy?.categories?.find((c) => c.id === k)?.label;
    return k === 'base' ? (label ?? CL.base) : label ? tr(CL.catLabel, { id: k, label }) : k;
  };
  const selected = badge ? cards.find((c) => c.id === badge) : null;
  const selectedBadge = badge ? badgeOf(badge) : null;

  return (
    <div className="stack-16" data-screen="P09">
      <div className="ph">
        <div className="ttl">
          <h1 tabIndex={-1}>{CL.title}</h1>
          {role !== 'L' ? <span className="sub">{progress.data?.subject?.displayName ? tr(CL.readOnlySubNamed, { name: progress.data.subject.displayName }) : CL.readOnlySub}</span> : null}
        </div>
        <nav className="tabs acts" aria-label={CL.title}>
          <Link to="/certificates" aria-current={tab === 'tracks' ? 'page' : undefined} replace>
            {CL.trackCerts}
          </Link>
          <Link to="/certificates?tab=badges" aria-current={tab === 'badges' ? 'page' : undefined} replace>
            {CL.cardBadges}
          </Link>
        </nav>
      </div>
      <div className="note">
        <Icon name="shield" />
        <span>{CL.notice}</span>
      </div>
      {replay.error ? <InlineProblem error={replay.error} /> : null}

      {tab === 'tracks' ? (
        <section className="sec" aria-labelledby="ct-h" data-section="tracks">
          <h2 id="ct-h">{CL.trackCerts}</h2>
          {tracks.status === 'error' && !tracks.loaded ? (
            <InlineProblem error={tracks.error} onRetry={refresh} title={CL.trackCerts} />
          ) : !tracks.loaded || !certs.loaded ? (
            <Skeleton lines={6} label={CL.readingTracks} />
          ) : (
            <div className="tbl-wrap cardify">
              <table className="tbl">
                <caption className="sr">{CL.trackCerts}</caption>
                <thead>
                  <tr>
                    <th scope="col">{CL.colCert}</th>
                    <th scope="col">{CL.colState}</th>
                    <th scope="col">{CL.colCond}</th>
                    <th scope="col">
                      <span className="sr">{CL.colActions}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ t, valid, revoked, history, d, state }) => {
                    const p = d?.progress ?? null;
                    const groupsDone = p?.groups ? p.groups.filter((g) => g.done >= g.pick).length : null;
                    const pending = (d?.certificate?.reasons ?? []).filter((r) => (r as { code?: string }).code === 'BADGE_PENDING').length;
                    return (
                      <tr key={t.id} data-track={t.id} data-state={state}>
                        <td data-label={CL.colCert}>
                          <b>{t.certificate?.title ?? t.title ?? t.id}</b>
                          <span className="small mono faint block-line">{t.id}</span>
                        </td>
                        <td data-label={CL.colState}>
                          <Status meta={TRACK_CERT_META[state]} />
                          {valid ? (
                            <span className="small block-line">
                              <span className="mono">{valid.certId}</span> · {valid.issuedAt ? formatDate(valid.issuedAt, now) : ''} · {valid.public ? CL.public : CL.notPublic}
                            </span>
                          ) : null}
                          {revoked ? <span className="small block-line">{revokeReasonText(revoked.revokeReason)}</span> : null}
                          {history.length ? (
                            <details className="disc small">
                              <summary>{tr(CL.history, { n: history.length })}</summary>
                              <ul>
                                {history.map((h) => (
                                  <li key={h.certId}>
                                    <Link className="mono" to={`/certificates/${h.certId}`}>
                                      {h.certId}
                                    </Link>{' '}
                                    · {h.status === 'revoked' ? tr(CL.revokedReason, { reason: revokeReasonText(h.revokeReason) }) : CL.valid}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                        </td>
                        <td className="small" data-label={CL.colCond}>
                          {tr(CL.required, { done: p?.requiredDone ?? t.progress?.requiredDone ?? '—', total: p?.requiredTotal ?? t.progress?.requiredTotal ?? '—' })}
                          {p?.groups?.length ? tr(CL.groups, { done: groupsDone, total: p.groups.length }) : ''}
                          {p && p.verifiedRatio != null ? tr(CL.ratio, { ratio: pct(p.verifiedRatio), min: pct(t.completion?.minAutoRatio ?? 0.8) }) : ''}
                          {pending ? <span className="block-line">{tr(CL.pendingBadges, { n: pending })}</span> : null}
                        </td>
                        <td data-label={CL.colActions}>
                          {valid ? (
                            <Link className="btn sm" to={`/certificates/${valid.certId}`}>
                              {CL.view}
                            </Link>
                          ) : state === 'eligible' && L ? (
                            <Button size="sm" variant="primary" onClick={() => setClaim(t)}>
                              {CL.claim}
                            </Button>
                          ) : revoked ? (
                            <Link className="btn sm" to={`/certificates/${revoked.certId}`}>
                              {CL.view}
                            </Link>
                          ) : (
                            <Link className="btn sm" to={`/tracks/${t.id}`}>
                              {CL.track}
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {certs.status === 'error' && !certs.loaded ? <InlineProblem error={certs.error} onRetry={refresh} title={CL.myCerts} /> : null}
        </section>
      ) : (
        <section className="sec" aria-labelledby="cb-h" data-section="badges">
          <h2 id="cb-h">
            {tr(CL.badgesCount, { earned, total: cards.length || '—' })}
            <span className="aside">
              <label className="chk">
                <input type="checkbox" checked={onlyEarned} onChange={(e) => setOnlyEarned(e.target.checked)} />
                <span>{CL.onlyEarned}</span>
              </label>
            </span>
          </h2>
          {progress.status === 'error' && !progress.loaded ? (
            <InlineProblem error={progress.error} onRetry={refresh} title={CL.cardBadges} />
          ) : !progress.loaded || !index ? (
            <Skeleton lines={4} label={CL.readingBadges} />
          ) : earned === 0 && onlyEarned ? (
            <EmptyState
              title={CL.firstBadge}
              action={
                <Link className="btn" to="/labs/svc-ec2">
                  {CL.startEc2}
                </Link>
              }
            />
          ) : (
            <div className="badgewall">
              {earned === 0 ? <p className="small muted">{CL.firstBadge}</p> : null}
              {groups.map(([k, list]) => {
                const shown = list.filter((c) => !onlyEarned || badgeOf(c.id));
                if (!shown.length) return null;
                return (
                  <div key={k} className="stack-8" data-category={k}>
                    <b className="small">{catLabel(k)}</b>
                    <div className="bw-row">
                      {shown.map((c) => {
                        const st = badgeState(badgeOf(c.id));
                        const title = typeof c.badge === 'object' ? c.badge?.title : typeof c.badge === 'string' ? c.badge : c.id;
                        return (
                          <button key={c.id} type="button" className={st === 'none' ? 'bw-item off' : 'bw-item'} onClick={() => setBadge(c.id)} aria-label={tr(CL.badgeLabel, { title: title ?? c.id, state: badgeStateText(st) })} data-badge={c.id}>
                            <BadgeGlyph labId={c.id} kind={c.kind} category={c.category} state={st} />
                            <span className="bw-name">{title}</span>
                            <span className="xs faint">{badgeStateText(st)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {claim ? <ClaimDialog trackId={claim.id} title={claim.certificate?.title ?? claim.title ?? claim.id} onClose={() => setClaim(null)} labTitle={labTitle} /> : null}
      <Drawer open={!!selected} onClose={() => setBadge(null)} title={tr(CL.badgeTitle, { title: selected ? ((typeof selected.badge === 'object' ? selected.badge?.title : selected.badge) ?? selected.id) : '' })}>
        {selected ? (
          <div className="stack-16">
            <div className="row">
              <BadgeGlyph labId={selected.id} kind={selected.kind} category={selected.category} state={badgeState(selectedBadge)} />
              <div className="stack-4">
                <b className="mono">{selected.id}</b>
                <span className="small">{selected.title}</span>
              </div>
            </div>
            {selectedBadge ? (
              <dl className="kv">
                <dt>{CL.level}</dt>
                <dd>{badgeStateText(badgeState(selectedBadge))}</dd>
                <dt>{CL.evidenceScore}</dt>
                <dd className="tnum">{typeof selectedBadge.evidenceScore === 'number' ? selectedBadge.evidenceScore.toFixed(2) : '—'}</dd>
                <dt>{CL.earnedAt}</dt>
                <dd>{selectedBadge.earnedAt ? formatDate(selectedBadge.earnedAt, now) : '—'}</dd>
                <dt>{CL.attempt}</dt>
                <dd>
                  {selectedBadge.attemptId ? (
                    <>
                      <Link to={`/sessions/${selectedBadge.attemptId}/report`}>{CL.viewReport}</Link> · <span className="mono">{selectedBadge.attemptId}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt>{CL.variant}</dt>
                <dd className="mono">{selectedBadge.variant ?? 'default'}</dd>
                <dt>{CL.contentVersion}</dt>
                <dd className="mono">
                  {selectedBadge.labVersion ?? '—'}
                  {selectedBadge.catalogVersion ? tr(CL.catalogVersion, { v: selectedBadge.catalogVersion }) : ''}
                </dd>
                <dt>{CL.quizBest}</dt>
                <dd>{selectedBadge.quiz?.bestScore != null ? tr(CL.quizScore, { score: selectedBadge.quiz.bestScore }) : CL.quizNone}</dd>
              </dl>
            ) : (
              <>
                <p>{CL.notEarned}</p>
                <Link className="btn" to={`/labs/${selected.id}`}>
                  {CL.openCard}
                </Link>
              </>
            )}
            {selectedBadge?.status === 'withdrawn' ? <p className="small st fail">{CL.withdrawnNote}</p> : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
