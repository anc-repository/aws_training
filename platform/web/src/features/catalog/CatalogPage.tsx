/** P02 卡片目录（08 §4 P02；05 §2、§8.8）。脚手架桩：后续实现者按画面规格替换。 */
import { useSearchParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function CatalogPage() {
  const [search] = useSearchParams();
  return (
    <PageStub screen="P02" title="卡片目录" spec="08 §4 P02；05 §2、§8.8">
      <dl className="kv">
        <dt>view</dt>
        <dd className="mono">{search.get('view') ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
