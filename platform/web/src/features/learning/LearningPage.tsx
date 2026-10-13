/** P10 我的学习（08 §4 P10；tracks §4、§5；05 §2.5）。脚手架桩：后续实现者按画面规格替换。 */
import { useSearchParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function LearningPage() {
  const [search] = useSearchParams();
  return (
    <PageStub screen="P10" title="我的学习" spec="08 §4 P10；tracks §4、§5；05 §2.5">
      <dl className="kv">
        <dt>tab</dt>
        <dd className="mono">{search.get('tab') ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
