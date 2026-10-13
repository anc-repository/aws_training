/** P11-D 会话详情（08 §4 P11-D；04 §9.3）。脚手架桩：后续实现者按画面规格替换。 */
import { useParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function SessionDetailPage() {
  const params = useParams();
  return (
    <PageStub screen="P11-D" title="会话详情" spec="08 §4 P11-D；04 §9.3">
      <dl className="kv">
        <dt>sid</dt>
        <dd className="mono">{params.sid ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
