/**
 * `/workspace/:sid`（08 §2.3；P04 开始实验进度页 / P05 分屏工作台）：订阅会话视图（SessionSync），视图到达前显示骨架，
 * 读取失败（404 / 403）时显示区块错误；之后交给 `workspace/Workspace` 按会话状态渲染（§2.4 表 2）。
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../../api/errors';
import { useServices, useWatchedSession } from '../../app/context';
import { BrandMark, EmptyState, ErrorPanel, Skeleton } from '../../ui';
import { Workspace } from '../../workspace/Workspace';

export default function WorkspacePage() {
  const { sid = '' } = useParams();
  const view = useWatchedSession(sid);
  const { api } = useServices();
  const [error, setError] = useState<unknown>(null);
  // 视图迟迟没有到达：直接读一次，拿到错误码（404 不存在、403 无权访问）
  useEffect(() => {
    if (view || !sid) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      api.get('getSession', { params: { sid } }).catch((e) => alive && setError(e));
    }, 4000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [api, sid, view]);
  if (view && view.sessionId === sid) return <Workspace sid={sid} view={view} key={sid} />;
  return (
    <div className="ws ws-main" data-screen="loading">
      <header className="wsbar">
        <Link className="brand" to="/labs" title="ATL 实验平台（非 AWS 官方）">
          <BrandMark />
        </Link>
        <Link className="btn sm ghost" to="/labs">
          ‹ 目录
        </Link>
        <div className="ttl">
          <span className="t mono small">{sid}</span>
        </div>
      </header>
      <div className="ws-loading">
        <h1 className="sr" tabIndex={-1}>
          工作台
        </h1>
        {error ? (
          isApiError(error) && error.status === 404 ? (
            <EmptyState title="没有找到这个实验会话">它可能已被删除，或者地址有误。可以在“我的实验”中查看全部会话。</EmptyState>
          ) : (
            <ErrorPanel error={error as never} onRetry={() => setError(null)} />
          )
        ) : (
          <Skeleton lines={6} block />
        )}
      </div>
    </div>
  );
}
