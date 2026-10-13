/** P02-T 学习路径（08 §4 P02-T；05 §2.6；cards/tracks-and-catalog §4、§5）。脚手架桩：后续实现者按画面规格替换。 */
import { useParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function TrackPage() {
  const params = useParams();
  return (
    <PageStub screen="P02-T" title="学习路径" spec="08 §4 P02-T；05 §2.6；cards/tracks-and-catalog §4、§5">
      <dl className="kv">
        <dt>trackId</dt>
        <dd className="mono">{params.trackId ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
