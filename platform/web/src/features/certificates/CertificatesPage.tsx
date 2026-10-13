/** P09 证书与徽章（08 §4 P09；04 §10；tracks §5）。脚手架桩：后续实现者按画面规格替换。 */
import { useSearchParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function CertificatesPage() {
  const [search] = useSearchParams();
  return (
    <PageStub screen="P09" title="证书与徽章" spec="08 §4 P09；04 §10；tracks §5">
      <dl className="kv">
        <dt>tab</dt>
        <dd className="mono">{search.get('tab') ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
