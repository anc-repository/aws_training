/**
 * P06 对比实验视图（独立页面）`/sessions/:sid/experiments/:module/:experimentId`（08 P06）。
 * 查询串：`a=<runId>`、`b=<runId>`（两列选用的记录）、`across=1`（跨会话）；会话结束后从报告、会话详情进入。
 * 组件 ExperimentCompare 与工作台抽屉（`/workspace/:sid?exp=`）共用。
 */
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ErrorPanel, SessionStatePill, Skeleton } from '../../ui';
import { ServiceGlyph } from '../../ui/glyphs';
import { Missing } from '../errors/NotFoundPage';
import { useLabContent, useSessionView } from '../sessions/data';
import '../sessions/pages.css';
import { ExperimentCompare, type CompareSelection } from './ExperimentCompare';

import { rich, t } from '../../i18n';
import { EX } from './strings';
export default function ExperimentPage() {
  const { sid = '', module = '', experimentId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const { view, status, error, retry } = useSessionView(sid);
  const { lab } = useLabContent(view?.catalogVersion, view?.labId);
  if (status === 'missing') return <Missing title={EX.page.noSession} />;
  if (status === 'error' && !view) return <ErrorPanel error={error ?? { code: 'INTERNAL' }} onRetry={retry} title={EX.page.title} />;
  if (!view) return <Skeleton lines={5} block label={EX.page.reading} />;
  const decl = lab?.experiments?.find((x) => x.module === module && x.id === experimentId);
  const selection: CompareSelection = { a: search.get('a'), b: search.get('b'), across: search.get('across') === '1' };
  const onSelect = (sel: CompareSelection) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of [
      ['a', sel.a],
      ['b', sel.b],
      ['across', sel.across ? '1' : null],
    ] as const) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSearch(next, { replace: true });
  };
  return (
    <div className="stack-16" data-screen="P06">
      <div>
        <nav className="crumbs-row" aria-label={EX.page.crumbs}>
          <Link to="/sessions">{EX.page.mySessions}</Link>
          <span aria-hidden="true">›</span>
          <Link className="mono" to={`/sessions/${sid}`}>
            {sid}
          </Link>
          <span aria-hidden="true">›</span>
          <span>{EX.page.title}</span>
        </nav>
        <div className="ph">
          <div className="ttl">
            <h1 tabIndex={-1}>
              <ServiceGlyph id={module} size={24} tooltip className="h-glyph" />{' '}
              {t(EX.page.heading, { labId: view.labId, key: `${module}/${experimentId}` })}
              {decl?.required ? EX.page.required : decl ? EX.page.optional : ''}
            </h1>
            <span className="sub">
              {rich(EX.page.session, { sid: <span className="mono">{sid}</span>, state: <SessionStatePill state={view.state} size="sm" /> })}
            </span>
          </div>
        </div>
      </div>
      <ExperimentCompare view={view} module={module} experimentId={experimentId} selection={selection} onSelect={onSelect} />
    </div>
  );
}
