// backend/src/ports/instance-lifecycle.ts   （autoscaling 模块；驱动 single | asg，由 DEPLOY_MODE 推导；总纲 §4.2，照录）
import type { Adapter } from './common.js';

export interface InstanceLifecyclePort extends Adapter {           // autoscaling：single | asg
  identity(): Promise<{ instanceId: string; az: string; asgName?: string }>;
  onTerminating(cb: (deadline: Date) => Promise<void>): void;     // 生命周期钩子 / Spot 中断通知
  complete(action: 'CONTINUE' | 'ABANDON'): Promise<void>;
}
// single 驱动的 identity() 在启动时从 IMDS 读出 inst / az，供 X-CloudAlbum-Path 的 inst、az 段使用（00-ec2-base.md 第 5 节）。
