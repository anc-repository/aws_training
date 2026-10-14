/**
 * P02-T 路径详情 `/tracks/:trackId`（08 §4 P02-T；05 §2.6；tracks-and-catalog §4、§5.5）：
 * 路径进度头 + 证书区（条件表与“领取证书”）+ 阶段列表（与目录的路径视图同一组件）+ 历史证书。
 * - 证书条件：回写前由前端按进度与 `completion.minAutoRatio` 计算，以服务端（GET /tracks/{trackId} 的 certificate、
 *   POST /certificates 的 422 CERT_NOT_ELIGIBLE）为准（08 §9.2 #17）；
 * - “领取证书”打开 ClaimCertificateDialog（只对学员）；签发要求最近 60 分钟内登录（全局 ReauthDialog 处理并重放）。
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth, useServices } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { msg, t } from '../../i18n';
import { announce } from '../../lib/announce';
import { formatDate } from '../../lib/format';
import { Button, EmptyState, ErrorPanel, Shape, Skeleton } from '../../ui';
import '../labs/catalog.css';
import { CertStateText, TrackHead, TrackStageList, type CertState } from '../labs/components/TrackView';
import { progressMap, useCatalog, useHolder, useLabs, useResource, useSetCurrentTrack } from '../labs/data';
import { pct, recommendNext, trackSummary } from '../labs/model';
import { S } from '../labs/strings';
import type { CertificateItem, LabItem, TrackDetailView } from '../labs/types';
import { ClaimCertificateDialog, reasonsText } from './ClaimCertificateDialog';

const REVOKE_REASON: Readonly<Record<string, string>> = msg.pages.tracks.revokeReason;

function CondState({ ok, text, warn }: { ok: boolean; text: string; warn?: boolean }) {
  return (
    <span className={`st ${ok ? 'pass' : warn ? 'drift' : 'faint'}`}>
      <Shape name={ok ? 'check' : warn ? 'tri' : 'ring'} />
      <span className="t">{text}</span>
    </span>
  );
}

export default function TrackPage() {
  const { trackId = '' } = useParams();
  const { api, clock } = useServices();
  const auth = useAuth();
  const role = auth.principal?.role ?? null;
  const status = useGlobalStatus();
  const catalog = useCatalog();
  const labs = useLabs();
  const holder = useHolder(labs.data);
  const track = catalog.tracks.get(trackId) ?? null;
  const detail = useResource<TrackDetailView>(track ? `track:${trackId}` : null, () => api.get<TrackDetailView>('getTrack', { params: { trackId } }), { refreshOnVisible: true });
  const certs = useResource<{ items: CertificateItem[] }>(track ? 'certificates' : null, () => api.get<{ items: CertificateItem[] }>('listCertificates'), { refreshOnVisible: true });
  const setCurrentTrack = useSetCurrentTrack();
  const [busy, setBusy] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const progress = useMemo(() => progressMap(labs.data), [labs.data]);
  const items = useMemo(() => new Map<string, LabItem>((labs.data?.items ?? []).map((i) => [i.labId, i])), [labs.data]);

  if (catalog.error && !catalog.index) return <ErrorPanel error={catalog.error} onRetry={catalog.reload} />;
  if (!catalog.index) return <Skeleton lines={6} block />;
  if (!track) {
    return (
      <EmptyState
        page
        title={S.track.notFoundTitle}
        action={
          <Link className="btn" to="/labs?view=tracks">
            {S.catalog.title}
          </Link>
        }
      >
        {t(S.track.notFound, { id: trackId })}
      </EmptyState>
    );
  }

  const summary = trackSummary(track, progress, holder?.labId);
  const rec = recommendNext(track, progress, holder, catalog.cards);
  const server = detail.data;
  const eligible = server ? server.certificate.eligible : summary.eligible;
  const reasons = server?.certificate.reasons ?? [];
  const mine = (certs.data?.items ?? []).filter((c) => c.trackId === track.id);
  const valid = server?.certificate.current ?? (mine.find((c) => c.status === 'valid') ? { certId: mine.find((c) => c.status === 'valid')!.certId, status: 'valid' } : null);
  const history = mine.filter((c) => c.certId !== valid?.certId);
  const cert: CertState = valid ? 'claimed' : eligible ? 'eligible' : history.some((c) => c.status === 'revoked') && !mine.length ? 'revoked' : 'not-yet';
  const currentTrackId = status.me?.currentTrackId ?? labs.data?.currentTrackId ?? 'saa-main';
  const ratio = server?.progress.verifiedRatio ?? summary.ratio;
  const counted = summary.verified + summary.attested;
  const groupsMissing = summary.unmetGroups.map((g) => g.stageTitle);
  const defect = reasons.some((r) => r.code === 'CONTENT_DEFECTIVE');
  const pendingIds = server ? reasons.filter((r) => r.code === 'BADGE_PENDING').map((r) => String(r.labId ?? '')) : summary.pending;
  const L = role === 'L';
  const certTitle = track.certificate?.title ?? track.title ?? track.id;

  const onSetCurrent = async () => {
    setBusy(true);
    try {
      await setCurrentTrack(track.id);
      await status.refreshMe();
      announce(t(S.track.setCurrentDone, { name: track.title ?? track.id }));
    } catch {
      /* 失败时保持原样 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-16" data-screen="P02-T" data-track={track.id}>
      <nav className="crumbs-nav" aria-label={msg.pages.tracks.crumbs}>
        <ol>
          <li>
            <Link to={`/labs?view=tracks&track=${encodeURIComponent(track.id)}`}>{S.catalog.viewTracks}</Link>
          </li>
          <li>{track.title ?? track.id}</li>
        </ol>
      </nav>
      <div className="ph">
        <div className="stack-4">
          <h1 tabIndex={-1}>
            {track.title ?? track.id} <span className="mono small faint">{track.id}</span>
          </h1>
          {track.audience || track.summary ? <span className="sub">{[track.audience, track.summary].filter(Boolean).join(' · ')}</span> : null}
        </div>
      </div>
      <TrackHead track={track} summary={summary} cert={cert} canSetCurrent={L} isCurrent={currentTrackId === track.id} busy={busy} onSetCurrent={() => void onSetCurrent()} />
      <div className="small muted">
        {t(S.track.hours, { who: track.audience ?? '', req: Math.round((track.requiredMinutes ?? 0) / 60), all: Math.round((track.totalMinutes ?? 0) / 60) })}
      </div>

      <section className="sec" aria-labelledby="cert-h" data-cert-section="">
        <h2 id="cert-h">
          {t(S.track.certTitle, { title: certTitle })}
          <span className="aside">{S.track.certAside}</span>
        </h2>
        {detail.error && !server ? <ErrorPanel error={detail.error} onRetry={detail.reload} /> : null}
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{S.track.condition}</th>
                <th scope="col">{S.track.status}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{S.track.condRequired}</td>
                <td>
                  <CondState ok={summary.requiredDone === summary.requiredTotal} text={`${summary.requiredDone} / ${summary.requiredTotal}`} />
                </td>
              </tr>
              <tr>
                <td>{t(S.track.condGroups, { pick: 1 })}</td>
                <td>
                  {summary.groups ? (
                    <CondState
                      ok={summary.groupsDone === summary.groups}
                      text={`${summary.groupsDone} / ${summary.groups}${groupsMissing.length ? t(S.track.condGroupsMissing, { list: groupsMissing.join('、') }) : ''}`}
                    />
                  ) : (
                    S.track.condGroupsNone
                  )}
                </td>
              </tr>
              <tr>
                <td>{t(S.track.condRatio, { min: pct(summary.minRatio) })}</td>
                <td>
                  {ratio === null ? (
                    '—'
                  ) : (
                    <CondState ok={ratio >= summary.minRatio} warn={ratio < summary.minRatio} text={`${pct(ratio)}（${summary.verified} / ${counted}）`} />
                  )}
                </td>
              </tr>
              <tr>
                <td>{S.track.condDefect}</td>
                <td>{defect ? <CondState ok={false} warn text={S.track.no} /> : <CondState ok text={S.track.yes} />}</td>
              </tr>
              <tr>
                <td>{S.track.condPending}</td>
                <td>{pendingIds.length ? t(msg.pages.tracks.pending, { n: pendingIds.length, list: pendingIds.join(msg.pages.tracks.listSep) }) : S.track.none}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {valid ? (
          <p className="small">
            {t(S.track.currentCert, { id: valid.certId })} <Link to={`/certificates/${encodeURIComponent(valid.certId)}`}>{S.track.certDetail}</Link>
          </p>
        ) : null}
        {L ? (
          <div className="row">
            <Button
              variant="primary"
              disabledReason={eligible ? null : t(S.track.claimBlocked, { list: reasonsText(reasons.length ? reasons : localReasons(summary)) })}
              onClick={() => setClaimOpen(true)}
              data-claim=""
            >
              {S.track.claim}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="sec" aria-labelledby="stages-h">
        <h2 id="stages-h">{S.track.stages}</h2>
        <TrackStageList track={track} cards={catalog.cards} items={items} progress={progress} holder={holder} recommendedId={rec?.labId ?? null} />
      </section>

      <section className="sec" aria-labelledby="hist-h">
        <h2 id="hist-h">{S.track.history}</h2>
        {certs.data ? (
          history.length ? (
            <ul className="stack-4">
              {history.map((c) => (
                <li key={c.certId} className="row">
                  <span className="mono">{c.certId}</span>
                  {c.status === 'revoked' ? (
                    <span className="st fail">
                      <Shape name="xbox" />
                      <span className="t">
                        {S.track.revokedTag}
                        {c.revocationReason || c.reason ? `（${REVOKE_REASON[String(c.revocationReason ?? c.reason)] ?? String(c.revocationReason ?? c.reason)}）` : ''}
                      </span>
                    </span>
                  ) : (
                    <CertStateText state="claimed" />
                  )}
                  {c.revokedAt || c.issuedAt ? <span className="small muted">{formatDate(String(c.revokedAt ?? c.issuedAt), clock.now())}</span> : null}
                  <Link to={`/certificates/${encodeURIComponent(c.certId)}`}>{S.track.certDetail}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">{S.track.historyNone}</p>
          )
        ) : certs.error ? (
          <p className="small muted">{S.catalog.statusUnavailable}</p>
        ) : (
          <Skeleton lines={1} />
        )}
      </section>

      {claimOpen ? (
        <ClaimCertificateDialog
          trackId={track.id}
          certTitle={certTitle}
          defaultName={status.me?.certName ?? status.me?.displayName ?? ''}
          onClose={() => setClaimOpen(false)}
          onIssued={() => {
            detail.reload();
            certs.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** 服务端原因到达之前的本地预判（与 platform/api trackProgress 的原因码一致）。 */
function localReasons(s: ReturnType<typeof trackSummary>): { code: string; [k: string]: unknown }[] {
  const out: { code: string; [k: string]: unknown }[] = [];
  for (let i = 0; i < s.requiredTotal - s.requiredDone; i++) out.push({ code: 'REQUIRED_CARD_MISSING' });
  for (const g of s.unmetGroups) out.push({ code: 'GROUP_PICK_UNMET', groupId: g.title });
  if (s.ratio !== null && s.ratio < s.minRatio) out.push({ code: 'VERIFIED_RATIO_LOW', ratio: s.ratio, min: s.minRatio });
  return out;
}
