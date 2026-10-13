/** P03 卡片简介（08 §4 P03（含开始实验对话框 P03-D）；05 §7；02 §3、§10.1）。脚手架桩：后续实现者按画面规格替换。 */
import { useParams } from 'react-router-dom';
import { PageStub } from '../../components/PageStub';

export default function CardIntroPage() {
  const params = useParams();
  return (
    <PageStub screen="P03" title="卡片简介" spec="08 §4 P03（含开始实验对话框 P03-D）；05 §7；02 §3、§10.1">
      <dl className="kv">
        <dt>labId</dt>
        <dd className="mono">{params.labId ?? '—'}</dd>
      </dl>
    </PageStub>
  );
}
