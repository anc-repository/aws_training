/** P01 已退出 `/auth/signed-out`：“你已退出 ATL 实验平台。” [重新登录]。 */
import { Link } from 'react-router-dom';
import { zhCN } from '../../i18n/zh-CN';
import { LoginCard } from './LoginPage';

export default function SignedOutPage() {
  return (
    <LoginCard>
      <h1 tabIndex={-1}>{zhCN.auth.signedOut}</h1>
      <div>
        <Link className="btn primary" to="/login">
          {zhCN.p13.signInAgain}
        </Link>
      </div>
    </LoginCard>
  );
}
