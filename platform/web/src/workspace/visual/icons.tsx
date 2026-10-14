/**
 * 工作台专用的线性图标（09 I6 e：倒计时、费用、阶段图示用图标 + 数字表示）。与 ui/Icon.tsx 同一套画法：20 × 20 网格、描边 1.6、
 * currentColor、圆头（复用 `.ico` 类）；一律装饰（aria-hidden），含义由旁边的文字或按钮的可访问名称表达。
 * 只放 ui/Icon.tsx 中没有的图形，不复制已有图标。
 */
import type { ReactElement } from 'react';
import type { PhaseKey } from '../model/phases';

export type WsIconName = 'coin' | 'sum' | 'hourglass' | 'stop' | 'extend' | 'target' | 'leave' | 'billing' | 'outage';

const WS: Readonly<Record<WsIconName, ReactElement>> = {
  // 硬币（每小时费用）
  coin: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M12.2 7.6c-.4-.7-1.2-1.1-2.2-1.1-1.3 0-2.2.7-2.2 1.7 0 2.3 4.5 1.2 4.5 3.6 0 1-1 1.7-2.3 1.7-1 0-1.9-.4-2.3-1.2M10 5v1.5M10 13.5V15" />
    </>
  ),
  // 累计（已产生的费用）：叠起的硬币
  sum: (
    <>
      <ellipse cx="10" cy="5.5" rx="5.5" ry="2" />
      <path d="M4.5 5.5v3c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-3M4.5 8.5v3c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-3M4.5 11.5v3c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-3" />
    </>
  ),
  hourglass: <path d="M5.5 2.5h9M5.5 17.5h9M6.5 2.5c0 4 3.5 5 3.5 7.5S6.5 13.5 6.5 17.5M13.5 2.5c0 4-3.5 5-3.5 7.5s3.5 3.5 3.5 7.5" />,
  stop: <rect x="5" y="5" width="10" height="10" rx="1.5" />,
  // 时钟 + 加号（延长）
  extend: (
    <>
      <path d="M16.6 9A6.8 6.8 0 1 0 10 16.8" />
      <path d="M9.5 6v4l2.5 1.5M15 12.5v5M12.5 15h5" />
    </>
  ),
  // 靶心（预期结果）
  target: (
    <>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3.6" />
      <circle className="fill" cx="10" cy="10" r="1" />
    </>
  ),
  // 离开页面（门 + 箭头）
  leave: (
    <>
      <path d="M11 3.5H4.5v13H11" />
      <path d="M8.5 10h9M14.5 7l3 3-3 3" />
    </>
  ),
  // 计费开始（硬币 + 播放）
  billing: (
    <>
      <circle cx="8.5" cy="10" r="6" />
      <path d="M8.5 7.2v5.6M10.3 8.2c-.4-.5-1-.8-1.8-.8-.9 0-1.6.5-1.6 1.2 0 1.6 3.5.8 3.5 2.5 0 .7-.8 1.2-1.8 1.2-.8 0-1.5-.3-1.9-.9" />
      <path className="fill" d="M15.5 12.5v5l3.5-2.5z" />
    </>
  ),
  // 预期中断（断开的连线）
  outage: <path d="M2.5 10h4M13.5 10h4M8 6.5l-1.5 7M13.5 6.5l-1.5 7" />,
};

export function WsIcon({ name, large }: { name: WsIconName; large?: boolean }) {
  return (
    <svg className={large ? 'ico lg ws-ico' : 'ico ws-ico'} viewBox="0 0 20 20" aria-hidden="true" focusable="false" data-ws-icon={name}>
      {WS[name]}
    </svg>
  );
}

/** P04 六个准备阶段的图形（阶段图示的节点）。 */
const PHASE: Readonly<Record<PhaseKey, ReactElement>> = {
  // 校验与预检：夹板 + 勾
  validate: (
    <>
      <rect x="4.5" y="3.5" width="11" height="14" rx="1.2" />
      <path d="M8 3.5V2.5h4v1M7.5 11l2 2 3.5-4" />
    </>
  ),
  // 创建基础环境：两台服务器
  base: (
    <>
      <rect x="3.5" y="3.5" width="13" height="5" rx="1" />
      <rect x="3.5" y="11.5" width="13" height="5" rx="1" />
      <path d="M6.5 6h.01M6.5 14h.01M9.5 6h4M9.5 14h4" />
    </>
  ),
  // 部署起始状态：叠层
  profile: <path d="M10 3l7 3.5-7 3.5-7-3.5zM3 10l7 3.5 7-3.5M3 13.5l7 3.5 7-3.5" />,
  // 连接实验机（SSM）：链环
  connect: <path d="M8 12l4-4M6.6 9.4l-1.9 1.9a2.6 2.6 0 0 0 3.7 3.7l1.9-1.9M13.4 10.6l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-1.9 1.9" />,
  // 健康检查：脉搏线
  health: <path d="M2.5 10.5h3.5l1.6-4.5 3 9 1.7-4.5h5.2" />,
  // 就绪：旗
  ready: <path d="M5 17.5V3M5 3.5h9.5l-2.2 3.2 2.2 3.3H5" />,
};

export function PhaseIcon({ phase }: { phase: PhaseKey }) {
  return (
    <svg className="ico lg ws-ico" viewBox="0 0 20 20" aria-hidden="true" focusable="false" data-phase-icon={phase}>
      {PHASE[phase]}
    </svg>
  );
}
