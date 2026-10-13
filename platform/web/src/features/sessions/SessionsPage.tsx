/** P11 我的实验（08 §4 P11；01 §8.2；02 §10.2）。脚手架桩：后续实现者按画面规格替换。 */
import { useSearchParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function SessionsPage() {
  const [search] = useSearchParams();
  return (
    <PageStub screen="P11" title="我的实验" spec="08 §4 P11；01 §8.2；02 §10.2">
      <dl className="kv">
        <dt>state</dt>
        <dd className="mono">{search.get('state') ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
