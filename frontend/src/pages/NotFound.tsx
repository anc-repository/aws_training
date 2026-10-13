import { Link } from 'react-router-dom';
import { useAuthOptional } from '../auth/context';

export function NotFound() {
  const auth = useAuthOptional();
  return (
    <div className="card panel-narrow">
      <h1>页面不存在</h1>
      <p className="muted">地址可能有误，或者对应的功能还没有启用。</p>
      <div className="row">
        <Link className="btn" to="/">返回首页</Link>
        {auth?.isAdmin && <Link className="btn" to="/lab">去实验室查看运行状态</Link>}
      </div>
    </div>
  );
}
