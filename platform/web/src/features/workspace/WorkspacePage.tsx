/**
 * P04 开始实验进度页 / P05 分屏工作台（08 §4 P04、P05；03 全文）。`/workspace/:sid` 按会话状态渲染（§2.4 表 2）。
 *
 * 脚手架已接好的部分（后续实现者在此基础上替换画面内容）：
 * - SessionSync 订阅本会话（视图与事件轮询、多标签页广播）；
 * - 每个可见的工作台标签页各自发送心跳（学员，READY～EXPIRING，§7.2 第 9 条）；
 * - 按 workspaceRender() 选择 P04 / P05 及其变体；顶栏 SessionBar 的占位（左端“‹ 目录”回到全站导航，§3.1）。
 */
import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { WorkbenchHeartbeat } from '../../api/heartbeat';
import { useAuth, useServices, useWatchedSession } from '../../app/context';
import { workspaceRender } from '../../app/sessionRouting';
import { zhCN } from '../../i18n/zh-CN';
import { BrandMark, Countdown, SessionStatePill, Skeleton, displayState } from '../../ui';

export default function WorkspacePage() {
  const { sid = '' } = useParams();
  const [search] = useSearchParams();
  const { api, sync, clock } = useServices();
  const { principal } = useAuth();
  const view = useWatchedSession(sid);
  const render = view ? workspaceRender(view) : null;
  const live = render?.screen === 'P05' && render.variant === 'live';
  const learner = principal?.role === 'L';

  useEffect(() => {
    if (!sid || !learner || !live) return undefined;
    const hb = new WorkbenchHeartbeat({ api, sync, sid });
    hb.start();
    return () => hb.stop();
  }, [api, sync, sid, learner, live]);

  const remaining = view?.deadlineAt ? Date.parse(view.deadlineAt) - clock.now() : null;
  return (
    <div className="ws" data-screen={render?.screen ?? 'P04'} data-variant={render?.variant}>
      <div className="wsbar">
        <div className="ttl">
          <Link className="brand" to="/labs" aria-label={zhCN.nav.catalog}>
            <BrandMark />
          </Link>
          <Link to="/labs">‹ 目录</Link>
          <span className="t mono">{view?.labId ?? sid}</span>
          {view ? <SessionStatePill state={displayState(view.state, remaining)} size="sm" /> : null}
        </div>
        <div className="clock">{view && render?.screen === 'P05' ? <Countdown deadlineAt={view.deadlineAt} now={clock.now} variant="bar" /> : null}</div>
      </div>
      <div className="mpane">
        <div className="mscroll">
          {!view ? (
            <Skeleton lines={4} block />
          ) : (
            <div className="ph">
              <h1 tabIndex={-1}>{render?.screen === 'P04' ? '开始实验' : '工作台'}</h1>
              <span className="sub">{zhCN.app.todo}</span>
            </div>
          )}
          {view ? (
            <dl className="kv">
              <dt>画面</dt>
              <dd className="mono">
                {render?.screen} · {render?.variant}
              </dd>
              <dt>会话</dt>
              <dd className="mono">{sid}</dd>
              <dt>state / ver</dt>
              <dd className="mono">
                {view.state} / {view.ver}
              </dd>
              <dt>step / panel</dt>
              <dd className="mono">
                {search.get('step') ?? '—'} / {search.get('panel') ?? '—'}
              </dd>
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  );
}
