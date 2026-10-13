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

export const SHARE_STATUS_META: Readonly<Record<string, StatusMeta>> = {
  publishing: { text: '正在发布', shape: 'clock', tone: 'pend' },
  revoking: { text: '正在撤销', shape: 'clock', tone: 'pend' },
  active: { text: '有效', shape: 'dot', tone: 'pass' },
  revoked: { text: '已撤销', shape: 'dash', tone: 'mut' },
  expired: { text: '已过期', shape: 'dash', tone: 'mut' },
};

export function shareHref(s: Pick<ReportShare, 'shareId' | 'url'>): string {
  return s.url ?? `/share/${s.shareId}/index.html`;
}

export function absoluteUrl(path: string): string {
  return /^https?:/i.test(path) ? path : `${window.location.origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

const EXPIRY: readonly [number | null, string][] = [
  [7, '7 天'],
  [30, '30 天'],
  [90, '90 天'],
  [null, '不过期'],
];

export function ShareDialog({ sid, onClose, onCreated }: { sid: string; onClose: () => void; onCreated: () => void }) {
  const [days, setDays] = useState<number | null>(30);
  const create = useAction<ReportShare>('createReportShare', { sid, onSuccess: () => onCreated() });
  const created = create.data;
  return (
    <Dialog
      open
      onClose={onClose}
      title="创建分享链接"
      size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {created ? '关闭' : '取消'}
          </button>
          {!created ? (
            <Button variant="primary" busy={create.busy} busyText="正在创建…" onClick={() => void create.run({ params: { sid }, body: { expiresInDays: days } })}>
              创建链接
            </Button>
          ) : null}
        </>
      }
    >
      <p className="small">分享的是一份脱敏副本：账号 ID（含 ARN、桶名、URL 中嵌入的）只留后 4 位，公网 IP、资源 ID 的中段、会话 id 与环境名一律打码，不含手动确认备注。</p>
      <p className="small">任何拿到链接的人都能打开，无需登录；搜索引擎不收录。</p>
      <fieldset className="stack-4 plain-fieldset" disabled={!!created}>
        <legend className="flabel">有效期</legend>
        <div className="radio-row" role="radiogroup" aria-label="有效期">
          {EXPIRY.map(([v, t]) => (
            <label key={t}>
              <input type="radio" name="share-exp" checked={days === v} onChange={() => setDays(v)} />
              {t}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="small muted">平台卸载后链接随之失效。</p>
      {created ? (
        <div className="note green" role="status">
          <Icon name="link" />
          <span className="wrap-any">
            已创建：<span className="mono">{absoluteUrl(shareHref(created))}</span>（正在发布，通常几秒后可以打开）
          </span>
        </div>
      ) : null}
      {create.error ? <InlineProblem error={create.error} onRetry={() => void create.retry()} overrides={{ INVALID_STATE: '报告还没有生成，生成后才能分享' }} /> : null}
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
  if (!list.loaded && list.status === 'error') return <InlineProblem error={list.error} onRetry={() => void list.refresh()} title="分享链接" />;
  if (!list.loaded) return <Skeleton lines={2} />;
  if (!items.length) return <p className="small muted">还没有分享链接。</p>;
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
                {s.createdAt ? `创建 ${formatDate(s.createdAt, now)}` : ''}
                {s.expiresAt ? ` · ${formatDate(s.expiresAt, now)} 过期` : ' · 不过期'}
              </span>
              {live ? (
                <span className="row">
                  <Button
                    size="sm"
                    icon="copy"
                    aria-label={`复制分享链接 ${href}`}
                    onClick={() =>
                      void copyText(absoluteUrl(href)).then((ok) => {
                        setCopied(ok ? s.shareId : null);
                        announce(ok ? '已复制' : '复制失败，请手动选中链接');
                      })
                    }
                  >
                    {copied === s.shareId ? '已复制' : '复制'}
                  </Button>
                  {s.status === 'active' ? (
                    <a className="btn sm" href={href} target="_blank" rel="noopener noreferrer">
                      打开 <Icon name="ext" />
                      <span className="sr">（新标签页）</span>
                    </a>
                  ) : null}
                  <Button size="sm" variant="danger" onClick={() => setRevoking(s)} aria-label={`撤销分享链接 ${href}`}>
                    撤销
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
      announce('已撤销分享链接');
      onDone();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="撤销分享链接"
      size="narrow"
      alert
      initialFocus="[data-cancel]"
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={onClose}>
            取消
          </button>
          <Button variant="danger-solid" busy={revoke.busy} busyText="正在撤销…" onClick={() => void revoke.run({ params: { sid, shareId: share.shareId } })}>
            撤销
          </Button>
        </>
      }
    >
      <p>撤销后链接在短时间内失效（CDN 缓存刷新需要时间）。</p>
      <p className="mono small wrap-any">{shareHref(share)}</p>
      {revoke.error ? <InlineProblem error={revoke.error} onRetry={() => void revoke.retry()} /> : null}
    </Dialog>
  );
}
