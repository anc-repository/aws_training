/** P09-C 证书详情（08 §4 P09-C；04 §10）。脚手架桩：后续实现者按画面规格替换。 */
import { useParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function CertificateDetailPage() {
  const params = useParams();
  return (
    <PageStub screen="P09-C" title="证书详情" spec="08 §4 P09-C；04 §10">
      <dl className="kv">
        <dt>certId</dt>
        <dd className="mono">{params.certId ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
