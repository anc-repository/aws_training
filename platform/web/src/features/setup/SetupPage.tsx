/**
 * P00 首次进入与账号预检 `/setup?step=<1..7>&next=…`（08 §4 P00；01 §4.1、§4.3；02 §3.5、§10.4）。
 * 脚手架：七个步骤的导航占位（助教、观察者只有步骤 1 与 6），以及“完成”与“跳过，稍后在设置中看”——两者都写入
 * “首次设置已完成”（PATCH /me 的 onboarding；回写前用 localStorage atl.onboarded.v1 降级，§9.2 #4），然后回到 next 或 /labs。
 * 本画面不创建任何 AWS 资源。
 */
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../app/context';
import { useGlobalStatus } from '../../app/globalStatus';
import { safeNext } from '../../auth/authService';
import { PageStub } from '../../components/PageStub';
import { Button } from '../../ui';

export const SETUP_STEPS = ['平台是什么', '平台体检', '区域与限额', '预算与通知', '已有实验与残留', '个人资料', '选择学习路径'] as const;

export function setupStepsFor(role: 'L' | 'A' | 'O' | null): number[] {
  return role === 'L' ? [1, 2, 3, 4, 5, 6, 7] : [1, 6];
}

export default function SetupPage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { principal } = useAuth();
  const { markOnboarded } = useGlobalStatus();
  const steps = setupStepsFor(principal?.role ?? null);
  const step = Number(search.get('step') ?? steps[0]);
  const next = safeNext(search.get('next'), '/labs');
  const finish = async () => {
    await markOnboarded();
    navigate(next, { replace: true });
  };
  const keep = (n: number) => {
    const q = new URLSearchParams(search);
    q.set('step', String(n));
    return `/setup?${q.toString()}`;
  };
  return (
    <PageStub screen="P00" title="首次设置" spec="08 §4 P00；01 §4.1、§4.3；02 §3.5、§10.4">
      <p className="muted">这些信息都来自安装时的检查，不会在你的账号里创建任何资源。</p>
      <div className="sidenav-layout">
        <nav className="stepper" aria-label="首次设置">
          {steps.map((n) => (
            <Link key={n} to={keep(n)} aria-current={n === step ? 'step' : undefined}>
              {n} {SETUP_STEPS[n - 1]}
            </Link>
          ))}
        </nav>
        <section className="stack" aria-label={SETUP_STEPS[step - 1] ?? ''}>
          <h2>
            {step} {SETUP_STEPS[step - 1] ?? ''}
          </h2>
          <div className="row">
            <Button variant="primary" onClick={() => void finish()}>
              完成，去卡片目录
            </Button>
            <Button variant="ghost" onClick={() => void finish()}>
              跳过，稍后在设置中看
            </Button>
          </div>
        </section>
      </div>
    </PageStub>
  );
}
