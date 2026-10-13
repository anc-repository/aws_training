/** P08 实验报告（08 §4 P08；04 §9）。脚手架桩：后续实现者按画面规格替换。 */
import { useParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function ReportPage() {
  const params = useParams();
  return (
    <PageStub screen="P08" title="实验报告" spec="08 §4 P08；04 §9">
      <dl className="kv">
        <dt>sid</dt>
        <dd className="mono">{params.sid ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
