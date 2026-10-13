/** P06 对比实验（08 §4 P06；04 §3.2.10、§7、§9.2）。脚手架桩：后续实现者按画面规格替换。 */
import { useParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function ExperimentPage() {
  const params = useParams();
  return (
    <PageStub screen="P06" title="对比实验" spec="08 §4 P06；04 §3.2.10、§7、§9.2">
      <dl className="kv">
        <dt>experimentId</dt>
        <dd className="mono">{params.experimentId ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
