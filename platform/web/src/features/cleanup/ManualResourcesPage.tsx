/** P07-M 待人工处理清单（08 §4 P07-M；02 §7.9）。脚手架桩：后续实现者按画面规格替换。 */
import { useSearchParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function ManualResourcesPage() {
  const [search] = useSearchParams();
  return (
    <PageStub screen="P07-M" title="待人工处理清单" spec="08 §4 P07-M；02 §7.9">
      <dl className="kv">
        <dt>severity</dt>
        <dd className="mono">{search.get('severity') ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
