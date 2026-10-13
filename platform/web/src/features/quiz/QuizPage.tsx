/** P03-Q 小测（08 §4 P03-Q；04 §3.2.11）。脚手架桩：后续实现者按画面规格替换。 */
import { useParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function QuizPage() {
  const params = useParams();
  return (
    <PageStub screen="P03-Q" title="小测" spec="08 §4 P03-Q；04 §3.2.11">
      <dl className="kv">
        <dt>labId</dt>
        <dd className="mono">{params.labId ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
