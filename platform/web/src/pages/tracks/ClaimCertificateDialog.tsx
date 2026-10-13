/**
 * ClaimCertificateDialog 领取路径证书（08 §5.4；P02-T“领取证书”；04 §10；tracks-and-catalog §5.5）。
 * 状态：填写 → 签发中 → 成功（转到证书详情）/ 不满足（422 CERT_NOT_ELIGIBLE 的原因）。
 * 签发要求最近 60 分钟内登录：服务端返回 REAUTH_REQUIRED 时由全局 ReauthDialog 处理并以同一 Idempotency-Key 重放。
 * P09 的证书页也需要同一个对话框；P09 的实现者可以直接复用本组件（路径参数化，没有画面专属依赖）。
 */
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isApiError } from '../../api/errors';
import { useServices } from '../../app/context';
import { t, zhCN } from '../../i18n/zh-CN';
import { Button, Dialog, Field, Shape } from '../../ui';
import { S } from '../labs/strings';

type Reason = { code: string; [k: string]: unknown };

/** 证书条件不满足的原因 → 一句话（与 platform/api trackProgress 的原因码对应）。 */
export function reasonsText(reasons: readonly Reason[]): string {
  const missing = reasons.filter((r) => r.code === 'REQUIRED_CARD_MISSING');
  const groups = reasons.filter((r) => r.code === 'GROUP_PICK_UNMET');
  const parts: string[] = [];
  if (missing.length) {
    const ids = missing.map((r) => r.labId).filter((x): x is string => typeof x === 'string');
    parts.push(`${t(S.track.reasonRequired, { n: missing.length })}${ids.length ? `（${ids.slice(0, 5).join('、')}${ids.length > 5 ? '…' : ''}）` : ''}`);
  }
  if (groups.length) parts.push(t(S.track.reasonGroups, { n: groups.length }));
  const ratio = reasons.find((r) => r.code === 'VERIFIED_RATIO_LOW');
  if (ratio) {
    const r = typeof ratio.ratio === 'number' ? `${Math.round(ratio.ratio * 100)}%` : '';
    const m = typeof ratio.min === 'number' ? `${Math.round(ratio.min * 100)}%` : '';
    parts.push(r && m ? `${S.track.reasonRatio}（${r} < ${m}）` : S.track.reasonRatio);
  }
  if (reasons.some((r) => r.code === 'BADGE_PENDING')) parts.push(S.track.reasonPending);
  if (reasons.some((r) => r.code === 'CONTENT_DEFECTIVE')) parts.push(S.track.reasonDefect);
  if (reasons.some((r) => r.code === 'CERTIFICATE_DISABLED')) parts.push(S.track.reasonDisabled);
  return parts.join('、') || '—';
}

export interface ClaimCertificateDialogProps {
  trackId: string;
  certTitle: string;
  defaultName: string;
  onClose: () => void;
  onIssued: (certId: string | null) => void;
}

export function ClaimCertificateDialog({ trackId, certTitle, defaultName, onClose, onIssued }: ClaimCertificateDialogProps) {
  const { api } = useServices();
  const navigate = useNavigate();
  const [name, setName] = useState(defaultName);
  const [isPublic, setPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const op = useRef<ReturnType<typeof api.operation> | null>(null);
  const submit = async () => {
    if (!op.current) op.current = api.operation('issueCertificate');
    setBusy(true);
    setError(null);
    try {
      const r = await op.current.run<{ certId?: string }>({ body: { scope: 'track', trackId, ...(name.trim() ? { displayName: name.trim() } : {}), public: isPublic } });
      const certId = r.data?.certId ?? null;
      onIssued(certId);
      onClose();
      if (certId) navigate(`/certificates/${encodeURIComponent(certId)}`);
    } catch (e) {
      if (isApiError(e)) {
        if (e.code === 'CERT_NOT_ELIGIBLE') {
          const reasons = ((e.problem as { reasons?: unknown } | null)?.reasons ?? []) as Reason[];
          setError(t(S.claim.notEligible, { list: reasonsText(Array.isArray(reasons) ? reasons : []) }));
          op.current = null;
        } else if (e.code !== 'REAUTH_REQUIRED') {
          setError(e.detail ?? e.title);
          if (!e.isTransient) op.current = null;
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t(S.claim.title, { cert: certTitle })}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {zhCN.app.cancel}
          </Button>
          <Button variant="primary" busy={busy} busyText={S.claim.busy} onClick={() => void submit()}>
            {S.claim.submit}
          </Button>
        </>
      }
    >
      <Field label={S.claim.name}>
        <input className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
      </Field>
      <label className="chk">
        <input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
        <span>{S.claim.public}</span>
      </label>
      <p className="small">{S.claim.records}</p>
      <p className="small">{S.claim.notRecords}</p>
      <p className="small muted">{S.claim.nature}</p>
      {error ? (
        <div className="note red" role="alert">
          <Shape name="xbox" />
          <span>{error}</span>
        </div>
      ) : null}
    </Dialog>
  );
}
