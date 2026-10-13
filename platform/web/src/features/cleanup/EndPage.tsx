/**
 * P07 结束与回收进度（含 P07-K 保留中的环境）`/sessions/:sid/end`（08 §4 P07；02 §6～§8）。
 * 脚手架：订阅本会话（SessionSync），按 endRender()（§2.4 表 2）重定向回工作台或选择 P07 / P07-K / 结束摘要；
 * `#manual` 定位到待人工处理清单。观察者只看结束阶段与结论（§1.5），由画面实现者处理。
 */
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useWatchedSession } from '../../app/context';
import { endRender } from '../../app/sessionRouting';
import { PageStub } from '../../components/PageStub';
import { SessionStatePill, Skeleton } from '../../ui';

export default function EndPage() {
  const { sid = '' } = useParams();
  const { hash } = useLocation();
  const view = useWatchedSession(sid);
  if (!view) return <Skeleton lines={4} block />;
  const r = endRender(view);
  if (r.kind === 'redirect') return <Navigate to={r.to} replace />;
  const screen = r.kind === 'P07-K' ? 'P07-K' : 'P07';
  return (
    <PageStub screen={screen} title={r.kind === 'P07-K' ? '保留中的环境' : '结束与回收进度'} spec="08 §4 P07；02 §6～§8">
      <dl className="kv">
        <dt>会话</dt>
        <dd className="mono">{sid}</dd>
        <dt>状态</dt>
        <dd>
          <SessionStatePill state={view.state} size="sm" />
        </dd>
        <dt>渲染</dt>
        <dd className="mono">
          {r.kind}
          {'anchor' in r && r.anchor ? ` #${r.anchor}` : hash ? ` ${hash}` : ''}
          {'report' in r ? ` · report=${String(r.report)}` : ''}
        </dd>
      </dl>
    </PageStub>
  );
}
