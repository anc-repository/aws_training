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
      setNameError('请填写证书上显示的名字');
      return;
    }
    if (n.length > 64) {
      setNameError('名字最多 64 个字符');
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
      title={`领取：${title}`}
      dismissible={!issue.busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={issue.busy}>
            取消
          </button>
          <Button variant="primary" busy={issue.busy || saving} busyText="正在签发…" onClick={() => void submit()}>
            签发证书
          </Button>
        </>
      }
    >
      <Field label="证书上显示的名字" hint="默认取个人资料中的证书署名。" error={nameError}>
        <input className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </Field>
      <label className="chk">
        <input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} />
        <span>公开证书文件：任何人可以通过 /verify/ATL-… 直接验证；不公开时只能用你提供的文件或链接验证</span>
      </label>
      <p className="small">证书会记录：路径与版本、计入的卡片与徽章等级、“已核验”占比、每张卡片的报告摘要。</p>
      <p className="small">不会记录：你的邮箱、AWS 账号 ID、小测成绩。</p>
      <p className="small muted">同一路径只保留一张有效证书；以后成绩提高可以重新领取，旧证书会自动吊销（被新证书取代）。本证明由你的自托管 ATL 实例签发，不是 AWS 官方认证。</p>
      {reasons.length ? (
        <div className="note red" role="alert">
          <Shape name="xbox" />
          <div className="stack-4">
            <span>还不满足领取条件：</span>
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
