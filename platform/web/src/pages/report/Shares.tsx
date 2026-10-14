/**
 * 分享链接（08 P08“分享对话框”、§5.4 ShareDialog / ShareList；04 §9.5）。只对学员。
 * - 创建：说明脱敏范围、任何拿到链接的人都能打开、搜索引擎不收录；有效期 7 / 30（默认）/ 90 天 / 不过期；平台卸载后失效；
 *   `POST …/report/shares {expiresInDays}` → 202（正在发布），列表随后显示“有效”；
 * - 列表：`GET …/report/shares`：链接、状态（发布中 / 有效 / 已撤销 / 已过期）、创建与过期时间、[复制] [打开] [撤销]；发布或撤销进行中时 5 秒刷新；
 * - 撤销：确认（alertdialog，默认焦点在“取消”）后 `DELETE …/shares/{shareId}`，说明“撤销后链接在短时间内失效（CDN 缓存刷新需要时间）”。
 */
import { useEffect, useState } from 'react';
import { useServices } from '../../app/context';
import { announce } from '../../lib/announce';
import { copyText } from '../../lib/clipboard';
import { formatDate } from '../../lib/format';
import { Button, Dialog, Icon, Skeleton, Status, type StatusMeta } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { useAction } from '../errors/useAction';
import { useApiData } from '../sessions/data';

import { msg, rich, t, withText } from '../../i18n';
import { RP } from './strings';
export interface ReportShare {
  shareId: string;
  url?: string;
  status?: 'publishing' | 'active' | 'revoked' | 'expired' | 'revoking';
  createdAt?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  publishedAt?: string | null;
  revision?: number | null;
}

export const SHARE_STATUS_META: Readonly<Record<string, StatusMeta>> = withText(
  {
    publishing: { shape: 'clock', tone: 'pend' },
    revoking: { shape: 'clock', tone: 'pend' },
    active: { shape: 'dot', tone: 'pass' },
    revoked: { shape: 'dash', tone: 'mut' },
    expired: { shape: 'dash', tone: 'mut' },
  },
  RP.share.status,
);

export function shareHref(s: Pick<ReportShare, 'shareId' | 'url'>): string {
  return s.url ?? `/share/${s.shareId}/index.html`;
}

export function absoluteUrl(path: string): string {
  return /^https?:/i.test(path) ? path : `${window.location.origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

const EXPIRY: readonly [number | null, 'd7' | 'd30' | 'd90' | 'never'][] = [
  [7, 'd7'],
  [30, 'd30'],
  [90, 'd90'],
  [null, 'never'],
];

export function ShareDialog({ sid, onClose, onCreated }: { sid: string; onClose: () => void; onCreated: () => void }) {
  const [days, setDays] = useState<number | null>(30);
  const create = useAction<ReportShare>('createReportShare', { sid, onSuccess: () => onCreated() });
  const created = create.data;
  return (
    <Dialog
      open
      onClose={onClose}
      title={RP.share.createTitle}
      size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {created ? RP.share.close : RP.share.cancel}
          </button>
          {!created ? (
            <Button variant="primary" busy={create.busy} busyText={RP.share.creating} onClick={() => void create.run({ params: { sid }, body: { expiresInDays: days } })}>
              {RP.share.create}
            </Button>
          ) : null}
        </>
      }
    >
      <p className="small">{RP.share.redactNote}</p>
      <p className="small">{RP.share.publicNote}</p>
      <fieldset className="stack-4 plain-fieldset" disabled={!!created}>
        <legend className="flabel">{RP.share.expiresIn}</legend>
        <div className="radio-row" role="radiogroup" aria-label={RP.share.expiresIn}>
          {EXPIRY.map(([v, k]) => (
            <label key={k}>
              <input type="radio" name="share-exp" checked={days === v} onChange={() => setDays(v)} />
              {RP.share.expiry[k]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="small muted">{RP.share.uninstallNote}</p>
      {created ? (
        <div className="note green" role="status">
          <Icon name="link" />
          <span className="wrap-any">
            {rich(RP.share.created, { url: <span className="mono">{absoluteUrl(shareHref(created))}</span> })}
          </span>
        </div>
      ) : null}
      {create.error ? <InlineProblem error={create.error} onRetry={() => void create.retry()} overrides={{ INVALID_STATE: RP.share.notGenerated }} /> : null}
    </Dialog>
  );
}

export function ShareList({ sid, reloadKey }: { sid: string; reloadKey: number }) {
  const { clock } = useServices();
  const [busyPoll, setBusyPoll] = useState(false);
  const list = useApiData<{ items?: ReportShare[] }>(`shares:${sid}:${reloadKey}`, 'listReportShares', { params: { sid }, conditional: false }, busyPoll ? 5_000 : null);
  const [revoking, setRevoking] = useState<ReportShare | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const items = [...(list.data?.items ?? [])].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const pending = items.some((s) => s.status === 'publishing' || s.status === 'revoking');
  useEffect(() => setBusyPoll(pending), [pending]);
  const now = clock.now();
  if (!list.loaded && list.status === 'error') return <InlineProblem error={list.error} onRetry={() => void list.refresh()} title={RP.share.listTitle} />;
  if (!list.loaded) return <Skeleton lines={2} />;
  if (!items.length) return <p className="small muted">{RP.share.none}</p>;
  return (
    <>
      <div className="sharelist" data-shares={items.length}>
        {items.map((s) => {
          const href = shareHref(s);
          const live = s.status === 'active' || s.status === 'publishing';
          return (
            <div key={s.shareId} className="sharerow" data-share={s.shareId} data-status={s.status}>
              <span className="url mono small">{href}</span>
              <Status meta={SHARE_STATUS_META[s.status ?? 'publishing'] ?? SHARE_STATUS_META.publishing!} />
              <span className="small muted">
                {s.createdAt ? t(RP.share.createdAt, { t: formatDate(s.createdAt, now) }) : ''}
                {s.expiresAt ? t(RP.share.expiresAt, { t: formatDate(s.expiresAt, now) }) : RP.share.noExpiry}
              </span>
              {live ? (
                <span className="row">
                  <Button
                    size="sm"
                    icon="copy"
                    aria-label={t(RP.share.copyLabel, { url: href })}
                    onClick={() =>
                      void copyText(absoluteUrl(href)).then((ok) => {
                        setCopied(ok ? s.shareId : null);
                        announce(ok ? RP.share.copied : RP.share.copyFailed);
                      })
                    }
                  >
                    {copied === s.shareId ? RP.share.copied : RP.share.copy}
                  </Button>
                  {s.status === 'active' ? (
                    <a className="btn sm" href={href} target="_blank" rel="noopener noreferrer">
                      {RP.share.open} <Icon name="ext" />
                      <span className="sr">{msg.app.newTab}</span>
                    </a>
                  ) : null}
                  <Button size="sm" variant="danger" onClick={() => setRevoking(s)} aria-label={t(RP.share.revokeLabel, { url: href })}>
                    {RP.share.revoke}
                  </Button>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {revoking ? (
        <RevokeShareDialog
          sid={sid}
          share={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null);
            setBusyPoll(true);
            void list.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function RevokeShareDialog({ sid, share, onClose, onDone }: { sid: string; share: ReportShare; onClose: () => void; onDone: () => void }) {
  const revoke = useAction<{ status?: string }>('deleteReportShare', {
    sid,
    onSuccess: () => {
      announce(RP.share.revokedAnnounce);
      onDone();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={RP.share.revokeTitle}
      size="narrow"
      alert
      initialFocus="[data-cancel]"
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={onClose}>
            {RP.share.cancel}
          </button>
          <Button variant="danger-solid" busy={revoke.busy} busyText={RP.share.revoking} onClick={() => void revoke.run({ params: { sid, shareId: share.shareId } })}>
            {RP.share.revoke}
          </Button>
        </>
      }
    >
      <p>{RP.share.revokeNote}</p>
      <p className="mono small wrap-any">{shareHref(share)}</p>
      {revoke.error ? <InlineProblem error={revoke.error} onRetry={() => void revoke.retry()} /> : null}
    </Dialog>
  );
}
