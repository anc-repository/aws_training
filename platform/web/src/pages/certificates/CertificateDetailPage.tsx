/**
 * P09-C 证书详情 `/certificates/:certId`（08 P09-C；04 §10.3～§10.8）。
 * - 页头：证书名 · 证书号；状态（有效 · 签发于 / 已吊销（原因、时间），被新证书取代时链接到新证书）；持有人、路径与版本、“已核验”占比；
 * - 包含的卡片：卡片与版本、徽章等级、自动 / 手动、完成于、报告摘要、[报告]；“核验用报告 JSON”回写前不提供（§9.2 #12、#31），页面说明；
 * - 验证链接 [复制] [打开]；公开 / 取消公开（`PATCH /certificates/{certId}`，202 后刷新）；未公开时说明对方需要证书文件或带 #jws= 的链接；
 * - 签名：ES256 · kid · 公钥指纹 [复制]、[复制 JWS]、[下载离线验证包]（`GET …/offline-bundle`）；建议公布指纹；
 * - [吊销证书…]：原因 learner-request（默认）/ content-defect / misissued；key-compromise 由密钥轮换流程处理；
 * - 页脚：平台卸载后在线验证页失效，请先下载离线验证包；A、O 只读（没有公开、吊销、下载离线包）；打印样式。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError, type ApiError } from '../../api/errors';
import { useAuth, useServices } from '../../app/context';
import { announce } from '../../lib/announce';
import { copyText } from '../../lib/clipboard';
import { formatDate, formatUtcTitle } from '../../lib/format';
import { Button, Dialog, ErrorPanel, Icon, Shape, Skeleton, Status } from '../../ui';
import { ProgressRing } from '../../ui/charts';
import { InlineProblem } from '../errors/InlineProblem';
import { Missing } from '../errors/NotFoundPage';
import { useAction } from '../errors/useAction';
import { ServiceGlyph } from '../../ui/glyphs';
import { cardTitle, primaryServiceOf, useApiData, useCatalogIndex } from '../sessions/data';
import { saveText } from '../sessions/download';
import '../sessions/pages.css';
import { CertSeal } from '../sessions/visuals';
import { certLabs, decodeJws, type CertPayload } from '../verify/verifyCore';
import { BadgeGlyph, type BadgeState } from './BadgeGlyph';
import { BADGE_LEVEL_META, pct, REVOKE_REASON_TEXT, revokeReasonText } from './certText';
import type { CertificateItem } from './CertificatesPage';

import { msg, rich, t } from '../../i18n';
import { CT } from './strings';

const CD = CT.detail;
export function decodePayload(jws: string | undefined): CertPayload | null {
  if (!jws) return null;
  try {
    const p = decodeJws(jws).payload;
    return p && typeof p === 'object' ? (p as CertPayload) : null;
  } catch {
    return null;
  }
}

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return [
    copied,
    (key, text) =>
      void copyText(text).then((ok) => {
        setCopied(ok ? key : null);
        announce(ok ? CD.copied : CD.copyFailed);
      }),
  ];
}

export default function CertificateDetailPage() {
  const { certId = '' } = useParams();
  const { api, clock } = useServices();
  const auth = useAuth();
  const L = auth.principal?.role === 'L';
  const [reload, setReload] = useState(0);
  const cert = useApiData<CertificateItem>(`cert:${certId}:${reload}`, 'getCertificate', { params: { certId }, conditional: false });
  const all = useApiData<{ items?: CertificateItem[] }>(L || auth.principal ? `certs-for:${certId}:${reload}` : null, 'listCertificates', { conditional: false });
  const index = useCatalogIndex();
  const [copied, copy] = useCopy();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [bundleError, setBundleError] = useState<ApiError | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [waitingPublic, setWaitingPublic] = useState<boolean | null>(null);
  const publish = useAction<{ public?: boolean }>('patchCertificate', {
    onSuccess: (_d) => {
      announce(CD.publishSubmitted);
    },
  });
  const c = cert.data;
  const payload = useMemo(() => decodePayload(c?.jws), [c?.jws]);
  // 公开 / 取消公开是异步的：每 3 秒刷新，直到状态变化（最多 30 秒）
  const refreshCert = cert.refresh;
  const isPublic = c?.public;
  useEffect(() => {
    if (waitingPublic === null) return undefined;
    if (isPublic === waitingPublic) {
      setWaitingPublic(null);
      return undefined;
    }
    const started = Date.now();
    const id = setInterval(() => {
      if (Date.now() - started > 30_000) {
        setWaitingPublic(null);
        return;
      }
      void refreshCert();
    }, 3_000);
    return () => clearInterval(id);
  }, [waitingPublic, isPublic, refreshCert]);

  if (cert.status === 'missing') return <Missing title={CD.missing} back={{ to: '/certificates', label: CD.backToList }} />;
  if (cert.status === 'error' && !cert.loaded) return <ErrorPanel error={cert.error ?? { code: 'INTERNAL' }} onRetry={() => void cert.refresh()} title={CD.title} />;
  if (!c) return <Skeleton lines={6} block label={CD.reading} />;

  const now = clock.now();
  const a = payload?.achievement ?? {};
  const title = a.title ?? c.trackId ?? certId;
  const verifyUrl = payload?.verify ?? `${window.location.origin}/verify/${certId}`;
  const valid = c.status === 'valid';
  const successor = !valid && c.revokeReason === 'superseded' ? (all.data?.items ?? []).find((x) => x.certId !== certId && x.trackId === c.trackId && x.status === 'valid') : null;
  const labs = certLabs(payload);
  const kid = c.kid ?? payload?.issuer?.kid ?? '';
  const fragmentLink = c.jws ? `${verifyUrl}#jws=${c.jws}` : null;

  const downloadBundle = async () => {
    setBundleBusy(true);
    setBundleError(null);
    try {
      const r = await api.call<unknown>('getOfflineBundle', { params: { certId }, conditional: false });
      saveText(`${JSON.stringify(r.data, null, 2)}\n`, `${certId}.atl-bundle.json`, 'application/json');
      announce(CD.bundleStarted);
    } catch (e) {
      if (isApiError(e)) setBundleError(e);
      else throw e;
    } finally {
      setBundleBusy(false);
    }
  };

  return (
    <div className="stack-16" data-screen="P09-C" data-status={c.status}>
      <div>
        <nav className="crumbs-row" aria-label={CD.crumbs}>
          <Link to="/certificates">{CD.certsAndBadges}</Link>
          <span aria-hidden="true">›</span>
          <span className="mono">{certId}</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>
              {rich(CD.heading, { title, id: <span className="mono">{certId}</span> })}
            </h1>
            <span className="sub">
              {t(CD.holder, { name: payload?.subject?.displayName ?? c.displayName ?? '—' })}
              {a.trackId ? (
                <>
                  {rich(CD.track, { id: <span className="mono">{a.trackId}</span> })}
                  {a.trackVersion ? ` v${a.trackVersion}` : ''}
                </>
              ) : null}
              {a.verifiedRatio != null ? t(CD.ratio, { ratio: pct(a.verifiedRatio) }) : ''}
            </span>
          </div>
          <span className="acts">
            {valid ? (
              <Status meta={{ text: t(CD.validIssued, { t: c.issuedAt ? formatDate(c.issuedAt, now) : '—' }), shape: 'dot', tone: 'pass' }} />
            ) : (
              <Status meta={{ text: c.revokedAt ? t(CD.revokedAt, { reason: revokeReasonText(c.revokeReason), t: formatDate(c.revokedAt, now) }) : t(CD.revoked, { reason: revokeReasonText(c.revokeReason) }), shape: 'xbox', tone: 'fail' }} />
            )}
          </span>
        </div>
      </div>

      <figure className={valid ? 'certcard' : 'certcard revoked'} aria-hidden="true" data-visual="certificate">
        <CertSeal tone={valid ? 'pass' : 'fail'} mark={valid ? 'check' : 'x'} size={72} />
        <div className="certcard-body">
          <span className="certcard-kicker">ATL · {a.trackId ?? a.labId ?? ''}</span>
          <span className="certcard-title">{title}</span>
          <span className="certcard-name">{payload?.subject?.displayName ?? c.displayName ?? '—'}</span>
          <span className="certcard-date">{c.issuedAt ? formatDate(c.issuedAt, now) : ''}</span>
          {labs.length ? (
            <span className="certcard-labs">
              {labs.map((l) => {
                const card = index?.cards?.find((x) => x.id === l.labId);
                const st: BadgeState = l.badgeLevel === 'attested' ? 'attested' : l.badgeLevel === 'self-reported' ? 'self-reported' : 'verified';
                return <BadgeGlyph key={l.labId} labId={l.labId} kind={card?.kind ?? (l.labId.startsWith('sc-') ? 'scenario' : 'service')} category={card?.category} state={st} size={24} />;
              })}
            </span>
          ) : null}
        </div>
        {a.verifiedRatio != null ? (
          <span className="certcard-ring">
            <ProgressRing value={a.verifiedRatio} size={64} label={CT.visual.verified} decorative />
          </span>
        ) : null}
      </figure>

      <div className="note">
        <Icon name="shield" />
        <span>{CD.notice}</span>
      </div>
      {successor ? (
        <div className="note blue">
          <Shape name="dot" />
          <span>
            {rich(CD.superseded, {
              id: (
                <Link className="mono" to={`/certificates/${successor.certId}`}>
                  {successor.certId}
                </Link>
              ),
            })}
          </span>
        </div>
      ) : null}
      {c.revokeReason === 'evidence-invalidated' ? (
        <div className="note amber">
          <Shape name="tri" />
          <span>{CD.evidenceInvalidated}</span>
        </div>
      ) : null}

      <section className="sec" aria-labelledby="cd-labs" data-section="labs">
        <h2 id="cd-labs">{t(CD.labs, { n: labs.length })}</h2>
        <div className="tbl-wrap cardify">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{CD.colCard}</th>
                <th scope="col">{CD.colLevel}</th>
                <th scope="col">{CD.colVerdict}</th>
                <th scope="col">{CD.colCompleted}</th>
                <th scope="col">{CD.colDigest}</th>
                <th scope="col">
                  <span className="sr">{CD.colReport}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {labs.map((l, i) => {
                const sid = c.sessionIds?.[i] ?? null;
                return (
                  <tr key={l.labId}>
                    <td data-label={CD.colCard}>
                      {primaryServiceOf(index?.cards?.find((x) => x.id === l.labId)) ? <ServiceGlyph id={primaryServiceOf(index?.cards?.find((x) => x.id === l.labId))!} size={20} tooltip className="h-glyph" /> : null}{' '}
                      <span className="mono">
                        {l.labId}
                        {l.labVersion ? ` v${l.labVersion}` : ''}
                      </span>
                      {cardTitle(index, l.labId) ? <span className="small faint block-line">{cardTitle(index, l.labId)}</span> : null}
                    </td>
                    <td data-label={CD.colLevel}>{l.badgeLevel ? (BADGE_LEVEL_META[l.badgeLevel]?.text ?? l.badgeLevel) : '—'}</td>
                    <td className="small" data-label={CD.colVerdict}>
                      {l.checks ? t(CD.checks, { auto: l.checks.auto ?? 0, manual: l.checks.manual ?? 0 }) : '—'}
                    </td>
                    <td className="small" data-label={CD.colCompleted}>
                      {l.completedAt ? <span title={formatUtcTitle(l.completedAt)}>{formatDate(l.completedAt, now)}</span> : '—'}
                    </td>
                    <td className="mono small" data-label={CD.colDigest}>
                      {l.reportDigest ? `${l.reportDigest.slice(0, 15)}…` : '—'}
                    </td>
                    <td data-label={CD.colReport}>
                      {sid ? (
                        <Link className="btn sm" to={`/sessions/${sid}/report`} aria-label={t(CD.viewReport, { labId: l.labId })}>
                          {CD.report}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted">{CD.digestNote}</p>
      </section>

      <dl className="kv" data-section="links">
        <dt>{CD.verifyLink}</dt>
        <dd>
          <span className="mono wrap-any">{verifyUrl}</span>{' '}
          <Button size="sm" icon="copy" onClick={() => copy('verify', verifyUrl)}>
            {copied === 'verify' ? CD.copied : CD.copy}
          </Button>{' '}
          <a className="btn sm" href={verifyUrl} target="_blank" rel="noopener noreferrer">
            {CD.open} <Icon name="ext" />
            <span className="sr">{msg.app.newTab}</span>
          </a>
        </dd>
        <dt>{CD.public}</dt>
        <dd>
          {c.public ? (
            rich(CD.publicFile, { path: <span className="mono">/public/certs/{certId}.jws</span> })
          ) : (
            CD.notPublic
          )}
          {L && valid ? (
            <>
              {' '}
              <Button
                size="sm"
                busy={publish.busy || waitingPublic !== null}
                busyText={CD.updating}
                onClick={() => {
                  const target = !c.public;
                  void publish.run({ params: { certId }, body: { public: target } }).then((r) => {
                    if (r) setWaitingPublic(target);
                  });
                }}
              >
                {c.public ? CD.unpublish : CD.publish}
              </Button>
            </>
          ) : null}
          {L && !c.public && fragmentLink ? (
            <>
              {' '}
              <Button size="sm" variant="ghost" icon="link" onClick={() => copy('frag', fragmentLink)}>
                {copied === 'frag' ? CD.copied : CD.copyFragment}
              </Button>
            </>
          ) : null}
          {publish.error ? <InlineProblem error={publish.error} onRetry={() => void publish.retry()} /> : null}
        </dd>
        <dt>{CD.signature}</dt>
        <dd>
          ES256 · kid <span className="mono">{kid ? `${kid.slice(0, 6)}…` : '—'}</span>
          {CD.fingerprint}{' '}
          <Button size="sm" icon="copy" onClick={() => copy('kid', kid)} aria-label={CD.copyFingerprint}>
            {copied === 'kid' ? CD.copied : CD.copy}
          </Button>
          {L && c.jws ? (
            <>
              {' '}
              <Button size="sm" icon="copy" onClick={() => copy('jws', c.jws!)}>
                {copied === 'jws' ? CD.copied : CD.copyJws}
              </Button>{' '}
              <Button size="sm" icon="down" busy={bundleBusy} busyText={CD.preparing} onClick={() => void downloadBundle()}>
                {CD.downloadBundle}
              </Button>
            </>
          ) : null}
          {bundleError ? <InlineProblem error={bundleError} onRetry={() => void downloadBundle()} /> : null}
        </dd>
      </dl>
      <div className="note">
        <Icon name="user" />
        <span>{CD.fingerprintTip}</span>
      </div>
      {L && valid ? (
        <div className="no-print">
          <Button variant="danger" onClick={() => setRevokeOpen(true)}>
            {CD.revoke}
          </Button>
        </div>
      ) : null}
      <p className="small faint">{CD.uninstallNote}</p>
      {revokeOpen ? (
        <RevokeDialog
          certId={certId}
          onClose={() => setRevokeOpen(false)}
          onDone={() => {
            setRevokeOpen(false);
            setReload((x) => x + 1);
          }}
        />
      ) : null}
    </div>
  );
}

const REASONS = ['learner-request', 'content-defect', 'misissued'] as const;
const REASON_HELP: Readonly<Record<(typeof REASONS)[number], string>> = CT.detail.reasonHelp;

export function RevokeDialog({ certId, onClose, onDone }: { certId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<(typeof REASONS)[number]>('learner-request');
  const revoke = useAction<{ status?: string }>('revokeCertificate', {
    onSuccess: () => {
      announce(CD.revokedAnnounce);
      onDone();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={CD.revokeTitle}
      size="narrow"
      alert
      initialFocus="[data-cancel]"
      dismissible={!revoke.busy}
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={onClose} disabled={revoke.busy}>
            {CD.cancel}
          </button>
          <Button variant="danger-solid" busy={revoke.busy} busyText={CD.revoking} onClick={() => void revoke.run({ params: { certId }, body: { reason } })}>
            {CD.revokeOk}
          </Button>
        </>
      }
    >
      <p>{CD.revokeNote}</p>
      <fieldset className="stack-4 plain-fieldset">
        <legend className="flabel">{CD.reason}</legend>
        {REASONS.map((r) => (
          <label key={r} className="chk">
            <input type="radio" name="revoke-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
            <span>
              {rich(CD.reasonItem, { text: REASON_HELP[r], code: <span className="mono">{r}</span> })}
            </span>
          </label>
        ))}
      </fieldset>
      <p className="small muted">{t(CD.keyCompromise, { text: REVOKE_REASON_TEXT['key-compromise'] })}</p>
      {revoke.error ? <InlineProblem error={revoke.error} onRetry={() => void revoke.retry()} /> : null}
    </Dialog>
  );
}
