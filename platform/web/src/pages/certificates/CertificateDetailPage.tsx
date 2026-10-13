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
import { InlineProblem } from '../errors/InlineProblem';
import { Missing } from '../errors/NotFoundPage';
import { useAction } from '../errors/useAction';
import { cardTitle, useApiData, useCatalogIndex } from '../sessions/data';
import { saveText } from '../sessions/download';
import '../sessions/pages.css';
import { certLabs, decodeJws, type CertPayload } from '../verify/verifyCore';
import { BADGE_LEVEL_META, pct, REVOKE_REASON_TEXT, revokeReasonText } from './certText';
import type { CertificateItem } from './CertificatesPage';

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
        announce(ok ? '已复制' : '复制失败，请手动选中');
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
      announce('已提交，正在更新公开状态');
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

  if (cert.status === 'missing') return <Missing title="没有这张证书" back={{ to: '/certificates', label: '回到证书与徽章' }} />;
  if (cert.status === 'error' && !cert.loaded) return <ErrorPanel error={cert.error ?? { code: 'INTERNAL' }} onRetry={() => void cert.refresh()} title="证书详情" />;
  if (!c) return <Skeleton lines={6} block label="正在读取证书" />;

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
      announce('已开始下载离线验证包');
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
        <nav className="crumbs-row" aria-label="面包屑">
          <Link to="/certificates">证书与徽章</Link>
          <span aria-hidden="true">›</span>
          <span className="mono">{certId}</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>
              {title} · <span className="mono">{certId}</span>
            </h1>
            <span className="sub">
              持有人 {payload?.subject?.displayName ?? c.displayName ?? '—'}
              {a.trackId ? (
                <>
                  {' '}
                  · 路径 <span className="mono">{a.trackId}</span>
                  {a.trackVersion ? ` v${a.trackVersion}` : ''}
                </>
              ) : null}
              {a.verifiedRatio != null ? ` · “已核验”占比 ${pct(a.verifiedRatio)}` : ''}
            </span>
          </div>
          <span className="acts">
            {valid ? (
              <Status meta={{ text: `有效 · 签发于 ${c.issuedAt ? formatDate(c.issuedAt, now) : '—'}`, shape: 'dot', tone: 'pass' }} />
            ) : (
              <Status meta={{ text: `已吊销（${revokeReasonText(c.revokeReason)}${c.revokedAt ? ` · ${formatDate(c.revokedAt, now)}` : ''}）`, shape: 'xbox', tone: 'fail' }} />
            )}
          </span>
        </div>
      </div>

      <div className="note">
        <Icon name="shield" />
        <span>本证明由你的自托管 ATL 实例签发，是自托管平台的完成证明，不是 AWS 官方认证，也不代表任何 AWS 认证资格。</span>
      </div>
      {successor ? (
        <div className="note blue">
          <Shape name="dot" />
          <span>
            已被新证书取代：<Link className="mono" to={`/certificates/${successor.certId}`}>{successor.certId}</Link>
          </span>
        </div>
      ) : null}
      {c.revokeReason === 'evidence-invalidated' ? (
        <div className="note amber">
          <Shape name="tri" />
          <span>证书所依据的徽章被撤回（例如对比实验的交叉核验转为无效），证书已吊销。请重做相关卡片后重新领取。</span>
        </div>
      ) : null}

      <section className="sec" aria-labelledby="cd-labs" data-section="labs">
        <h2 id="cd-labs">包含的卡片（{labs.length}）</h2>
        <div className="tbl-wrap cardify">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">卡片</th>
                <th scope="col">等级</th>
                <th scope="col">判定</th>
                <th scope="col">完成于</th>
                <th scope="col">报告摘要</th>
                <th scope="col">
                  <span className="sr">报告</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {labs.map((l, i) => {
                const sid = c.sessionIds?.[i] ?? null;
                return (
                  <tr key={l.labId}>
                    <td data-label="卡片">
                      <span className="mono">
                        {l.labId}
                        {l.labVersion ? ` v${l.labVersion}` : ''}
                      </span>
                      {cardTitle(index, l.labId) ? <span className="small faint block-line">{cardTitle(index, l.labId)}</span> : null}
                    </td>
                    <td data-label="等级">{l.badgeLevel ? (BADGE_LEVEL_META[l.badgeLevel]?.text ?? l.badgeLevel) : '—'}</td>
                    <td className="small" data-label="判定">
                      {l.checks ? `自动 ${l.checks.auto ?? 0} · 手动 ${l.checks.manual ?? 0}` : '—'}
                    </td>
                    <td className="small" data-label="完成于">
                      {l.completedAt ? <span title={formatUtcTitle(l.completedAt)}>{formatDate(l.completedAt, now)}</span> : '—'}
                    </td>
                    <td className="mono small" data-label="报告摘要">
                      {l.reportDigest ? `${l.reportDigest.slice(0, 15)}…` : '—'}
                    </td>
                    <td data-label="报告">
                      {sid ? (
                        <Link className="btn sm" to={`/sessions/${sid}/report`} aria-label={`查看 ${l.labId} 的报告`}>
                          报告
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted">核对报告需要证书引用的那一版报告 JSON（未经导出打码），平台支持后在此下载；打码导出的报告或更新过的版本在验证页会显示“不一致”。</p>
      </section>

      <dl className="kv" data-section="links">
        <dt>验证链接</dt>
        <dd>
          <span className="mono wrap-any">{verifyUrl}</span>{' '}
          <Button size="sm" icon="copy" onClick={() => copy('verify', verifyUrl)}>
            {copied === 'verify' ? '已复制' : '复制'}
          </Button>{' '}
          <a className="btn sm" href={verifyUrl} target="_blank" rel="noopener noreferrer">
            打开 <Icon name="ext" />
            <span className="sr">（新标签页）</span>
          </a>
        </dd>
        <dt>公开</dt>
        <dd>
          {c.public ? (
            <>
              已公开证书文件（<span className="mono">/public/certs/{certId}.jws</span>）
            </>
          ) : (
            '未公开：对方需要使用你提供的证书文件，或带 #jws= 的链接'
          )}
          {L && valid ? (
            <>
              {' '}
              <Button
                size="sm"
                busy={publish.busy || waitingPublic !== null}
                busyText="正在更新…"
                onClick={() => {
                  const target = !c.public;
                  void publish.run({ params: { certId }, body: { public: target } }).then((r) => {
                    if (r) setWaitingPublic(target);
                  });
                }}
              >
                {c.public ? '取消公开' : '公开'}
              </Button>
            </>
          ) : null}
          {L && !c.public && fragmentLink ? (
            <>
              {' '}
              <Button size="sm" variant="ghost" icon="link" onClick={() => copy('frag', fragmentLink)}>
                {copied === 'frag' ? '已复制' : '复制带 #jws= 的链接'}
              </Button>
            </>
          ) : null}
          {publish.error ? <InlineProblem error={publish.error} onRetry={() => void publish.retry()} /> : null}
        </dd>
        <dt>签名</dt>
        <dd>
          ES256 · kid <span className="mono">{kid ? `${kid.slice(0, 6)}…` : '—'}</span> · 公钥指纹{' '}
          <Button size="sm" icon="copy" onClick={() => copy('kid', kid)} aria-label="复制公钥指纹">
            {copied === 'kid' ? '已复制' : '复制'}
          </Button>
          {L && c.jws ? (
            <>
              {' '}
              <Button size="sm" icon="copy" onClick={() => copy('jws', c.jws!)}>
                {copied === 'jws' ? '已复制' : '复制 JWS'}
              </Button>{' '}
              <Button size="sm" icon="down" busy={bundleBusy} busyText="正在准备…" onClick={() => void downloadBundle()}>
                下载离线验证包
              </Button>
            </>
          ) : null}
          {bundleError ? <InlineProblem error={bundleError} onRetry={() => void downloadBundle()} /> : null}
        </dd>
      </dl>
      <div className="note">
        <Icon name="user" />
        <span>建议在你的公开主页（例如 GitHub 个人页）同时公布这个公钥指纹，第三方即可对照。</span>
      </div>
      {L && valid ? (
        <div className="no-print">
          <Button variant="danger" onClick={() => setRevokeOpen(true)}>
            吊销证书…
          </Button>
        </div>
      ) : null}
      <p className="small faint">平台卸载后在线验证页失效；请先下载离线验证包。</p>
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
const REASON_HELP: Record<(typeof REASONS)[number], string> = {
  'learner-request': '持有人申请',
  'content-defect': '内容缺陷：所依据的内容版本已标记为有缺陷',
  misissued: '误签',
};

export function RevokeDialog({ certId, onClose, onDone }: { certId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<(typeof REASONS)[number]>('learner-request');
  const revoke = useAction<{ status?: string }>('revokeCertificate', {
    onSuccess: () => {
      announce('证书已吊销');
      onDone();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="吊销证书"
      size="narrow"
      alert
      initialFocus="[data-cancel]"
      dismissible={!revoke.busy}
      footer={
        <>
          <button type="button" className="btn" data-cancel="" onClick={onClose} disabled={revoke.busy}>
            取消
          </button>
          <Button variant="danger-solid" busy={revoke.busy} busyText="正在吊销…" onClick={() => void revoke.run({ params: { certId }, body: { reason } })}>
            吊销
          </Button>
        </>
      }
    >
      <p>吊销不可撤销；吊销后验证页显示“已吊销”与原因。</p>
      <fieldset className="stack-4 plain-fieldset">
        <legend className="flabel">原因</legend>
        {REASONS.map((r) => (
          <label key={r} className="chk">
            <input type="radio" name="revoke-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
            <span>
              {REASON_HELP[r]}（<span className="mono">{r}</span>）
            </span>
          </label>
        ))}
      </fieldset>
      <p className="small muted">密钥泄露（{REVOKE_REASON_TEXT['key-compromise']}）不在这里逐张处理：由密钥轮换流程停用旧密钥并批量吊销。</p>
      {revoke.error ? <InlineProblem error={revoke.error} onRetry={() => void revoke.retry()} /> : null}
    </Dialog>
  );
}
