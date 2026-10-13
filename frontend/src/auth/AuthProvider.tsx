// 按 capabilities.modules.auth.driver 选择认证实现：local 直接渲染；cognito 经 React.lazy 动态加载（单独的代码块）。
import { lazy, Suspense, type ReactNode } from 'react';
import { BootSkeleton } from '../capabilities/CapabilitiesProvider';
import { useCaps } from '../capabilities/useCapability';
import { authPublic } from './config';
import { LocalAuthProvider } from './LocalAuthProvider';

const CognitoAuthProvider = lazy(() => import('./CognitoAuthProvider'));

export function AuthProvider({ children }: { children: ReactNode }) {
  const caps = useCaps();
  if (authPublic(caps).driver === 'cognito') {
    return (
      <Suspense fallback={<BootSkeleton />}>
        <CognitoAuthProvider>{children}</CognitoAuthProvider>
      </Suspense>
    );
  }
  return <LocalAuthProvider>{children}</LocalAuthProvider>;
}
