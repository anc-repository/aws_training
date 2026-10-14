/** P01 已退出 `/auth/signed-out`（08 §4 P01）：“你已退出 ATL 实验平台。”[重新登录]。 */
import { Link } from 'react-router-dom';
import { msg } from '../../i18n';
import { LoginCard } from './LoginPage';
import './login.css';

export default function SignedOutPage() {
  return (
    <LoginCard>
      <h1 tabIndex={-1}>{msg.frame.login.signedOut}</h1>
      <p data-signed-out="">{msg.auth.signedOut}</p>
      <div>
        <Link className="btn primary" to="/login">
          {msg.p13.signInAgain}
        </Link>
      </div>
    </LoginCard>
  );
}
