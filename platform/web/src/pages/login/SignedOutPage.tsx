/** P01 已退出 `/auth/signed-out`（08 §4 P01）：“你已退出 ATL 实验平台。”[重新登录]。 */
import { Link } from 'react-router-dom';
import { zhCN } from '../../i18n/zh-CN';
import { LoginCard } from './LoginPage';
import './login.css';

export default function SignedOutPage() {
  return (
    <LoginCard>
      <h1 tabIndex={-1}>已退出</h1>
      <p data-signed-out="">{zhCN.auth.signedOut}</p>
      <div>
        <Link className="btn primary" to="/login">
          {zhCN.p13.signInAgain}
        </Link>
      </div>
    </LoginCard>
  );
}
