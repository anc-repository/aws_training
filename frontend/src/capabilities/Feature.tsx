// <Feature id="F12.albAuth" fallback={...}>：按 capabilities.features[id] 显示子树或说明（总纲 12.2）。
import type { ReactNode } from 'react';
import type { FeatureId } from '@cloudalbum/contracts';
import { useFeature } from './useCapability';

export function Feature({ id, children, fallback = null }: { id: FeatureId | string; children: ReactNode; fallback?: ReactNode }) {
  const f = useFeature(id);
  if (!f) return null;
  return <>{f.enabled ? children : fallback}</>;
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="subtle">{children}</p>;
}
