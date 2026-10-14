/**
 * 领取证书 ClaimCertificateDialog（08 P09-A；04 §10.2；tracks §5.5）。只对学员。
 * - 证书上显示的名字（默认取个人资料中的证书署名）；改了名字先 `PATCH /me {certName}`；
 * - 是否公开证书文件；会记录 / 不会记录的说明；同一路径只保留一张有效证书；自托管、非 AWS 官方；
 * - `POST /certificates {scope: track, trackId, displayName, public}`（敏感操作：403 REAUTH_REQUIRED 由全局 ReauthDialog 处理，
 *   重新登录回来后由证书页挂载时重放）；422 CERT_NOT_ELIGIBLE 在对话框内列出服务端给出的原因；成功后跳到证书详情。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServices } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { Button, Dialog, Field, Shape } from '../../ui';
import { InlineProblem } from '../errors/InlineProblem';
import { problemReasons } from '../errors/problems';
import { useAction } from '../errors/useAction';
import { eligibilityReasonText } from './certText';

import { t } from '../../i18n';
import { CT } from './strings';
export interface IssuedCert {
  certId?: string;
  certificate?: { certId?: string };
}

export function issuedCertId(d: IssuedCert | null | undefined): string | null {
  return d?.certId ?? d?.certificate?.certId ?? null;
}

export function ClaimDialog({ trackId, title, onClose, labTitle }: { trackId: string; title: string; onClose: () => void; labTitle?: (id: string) => string | null }) {
  const { api } = useServices();
  const { me, refreshMe } = useGlobalStatus();
  const navigate = useNavigate();
  const initial = me?.certName ?? me?.displayName ?? '';
  const [name, setName] = useState(initial);
  const [pub, setPub] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const issue = useAction<IssuedCert>('issueCertificate', {
    onSuccess: (d) => {
      const id = issuedCertId(d);
      onClose();
      if (id) navigate(`/certificates/${id}`);
    },
  });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setNameError(CT.claim.nameRequired);
      return;
    }
    if (n.length > 64) {
      setNameError(CT.claim.nameTooLong);
      return;
    }
    setNameError(null);
    if (n !== initial) {
      setSaving(true);
      try {
        await api.call('patchMe', { body: { certName: n } });
        void refreshMe();
      } catch {
        /* 个人资料没写进去也不阻塞领取：名字随请求一起提交 */
      } finally {
        setSaving(false);
      }
    }
    await issue.run({ body: { scope: 'track', trackId, displayName: n, public: pub } });
  };
  const reasons = issue.error?.code === 'CERT_NOT_ELIGIBLE' ? problemReasons(issue.error) : [];
  return (
    <Dialog
      open
      onClose={onClose}
      title={t(CT.claim.title, { title })}
      dismissible={!issue.busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={issue.busy}>
            {CT.claim.cancel}
          </button>
          <Button variant="primary" busy={issue.busy || saving} busyText={CT.claim.issuing} onClick={() => void submit()}>
            {CT.claim.issue}
          </Button>
        </>
      }
    >
      <Field label={CT.claim.nameLabel} hint={CT.claim.nameHint} error={nameError}>
        <input className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </Field>
      <label className="chk">
        <input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} />
        <span>{CT.claim.public}</span>
      </label>
      <p className="small">{CT.claim.records}</p>
      <p className="small">{CT.claim.notRecords}</p>
      <p className="small muted">{CT.claim.nature}</p>
      {reasons.length ? (
        <div className="note red" role="alert">
          <Shape name="xbox" />
          <div className="stack-4">
            <span>{CT.claim.notEligible}</span>
            <ul className="small">
              {reasons.map((r, i) => (
                <li key={i}>{eligibilityReasonText(r, labTitle)}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : issue.error ? (
        <InlineProblem error={issue.error} onRetry={() => void issue.retry()} />
      ) : null}
    </Dialog>
  );
}
