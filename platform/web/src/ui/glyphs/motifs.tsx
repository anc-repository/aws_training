/**
 * 40 个模块的服务图案（平台自绘，不使用 AWS 官方图标素材，05 §2.10、08 §6.9）。
 *
 * 视觉语言（docs/platform/09-i18n-and-visual.md「视觉组件」）：
 * - 24 × 24 网格；图案画在 4～20 的活动区（四边留 4，给圆角方块的底留出边距）；
 * - 线宽 2（24px 时 2px、16px 时 1.33px、48px 徽章模式缩放后约 2.6px），圆头圆角，不填充；
 * - 实心的小元素用 class "f"（填 --on-ink），需要遮住底线的“旋钮”用 class "k"（填组色、描边 --on-ink）；
 * - 每个图案是一个简单几何隐喻（芯片 = EC2、桶 = S3、圆柱 = RDS、闪电 = 缓存、密码框 = Secrets Manager……），16px 下也只靠轮廓区分，
 *   不依赖缩写文字；缩写只在 ≥ 40px 的徽章模式中出现。
 * 颜色全部由 glyphs.css 的类决定（不写 style 属性，CSP style-src 'self'）。
 */
import type { ReactElement } from 'react';

export const MOTIFS: Readonly<Record<string, ReactElement>> = {
  // ---- 基础 ----
  ec2: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3" />
    </>
  ),
  // ---- A 入口、网络与扩展 ----
  network: (
    <>
      <rect x="4" y="4.5" width="16" height="15" rx="2.5" />
      <rect className="f" x="7.5" y="8.5" width="3.5" height="7" rx=".8" />
      <rect className="f" x="13" y="8.5" width="3.5" height="7" rx=".8" />
    </>
  ),
  cdn: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M4.5 12h15M12 4.5c-2.6 2.2-3.6 4.7-3.6 7.5s1 5.3 3.6 7.5M12 4.5c2.6 2.2 3.6 4.7 3.6 7.5s-1 5.3-3.6 7.5" />
    </>
  ),
  dns: (
    <>
      <path d="M12 4v16" />
      <path d="M12 6h6l2 2.25-2 2.25h-6zM12 12.5H6l-2 2.25L6 17h6" />
    </>
  ),
  tls: (
    <>
      <circle cx="12" cy="10" r="4.5" />
      <path d="M9.3 13.6L8 20l4-2 4 2-1.3-6.4" />
    </>
  ),
  waf: (
    <>
      <rect x="4" y="5.5" width="16" height="13" rx="1" />
      <path d="M4 9.8h16M4 14.2h16M9 5.5v4.3M15 5.5v4.3M12 9.8v4.4M9 14.2v4.3M15 14.2v4.3" />
    </>
  ),
  'load-balancer': (
    <>
      <circle className="f" cx="5.5" cy="12" r="2" />
      <path d="M7.5 12h3.5M11 12l6.5-6M11 12h6.5M11 12l6.5 6" />
      <circle className="f" cx="18.5" cy="6" r="1.7" />
      <circle className="f" cx="18.5" cy="12" r="1.7" />
      <circle className="f" cx="18.5" cy="18" r="1.7" />
    </>
  ),
  autoscaling: (
    <>
      <rect x="9" y="7.5" width="6" height="9" rx="1" />
      <path d="M3.5 12H7M5.2 9.8L3 12l2.2 2.2M20.5 12H17M18.8 9.8L21 12l-2.2 2.2" />
    </>
  ),
  // ---- B 身份与安全 ----
  iam: (
    <>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H20M17 12v3M20 12v3" />
    </>
  ),
  auth: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c.9-3.6 3.6-5.5 7-5.5s6.1 1.9 7 5.5" />
    </>
  ),
  'identity-pool': (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c.7-3 2.8-4.5 5.5-4.5s4.8 1.5 5.5 4.5M18 19.5V6.5M15 9.5l3-3 3 3" />
    </>
  ),
  secrets: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="2.5" />
      <circle className="f" cx="7.8" cy="12" r="1.6" />
      <circle className="f" cx="12" cy="12" r="1.6" />
      <circle className="f" cx="16.2" cy="12" r="1.6" />
    </>
  ),
  config: (
    <>
      <path d="M4.5 8h15M4.5 16h15" />
      <circle className="k" cx="9" cy="8" r="2.3" />
      <circle className="k" cx="15" cy="16" r="2.3" />
    </>
  ),
  kms: (
    <>
      <rect x="6" y="11" width="12" height="8.5" rx="1.5" />
      <path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11" />
      <circle className="f" cx="12" cy="15.2" r="1.4" />
    </>
  ),
  // ---- C 数据与存储 ----
  storage: (
    <>
      <ellipse cx="12" cy="7" rx="7.5" ry="2.5" />
      <path d="M4.5 7l1.8 11.2c.2 1 2.7 1.8 5.7 1.8s5.5-.8 5.7-1.8L19.5 7" />
    </>
  ),
  'shared-fs': (
    <>
      <path d="M4 15V6.5a1 1 0 0 1 1-1h4.5l2 2H19a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M8 16v2M16 16v2" />
      <circle className="f" cx="8" cy="19.5" r="1.5" />
      <circle className="f" cx="16" cy="19.5" r="1.5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6.5" rx="6.5" ry="2.5" />
      <path d="M5.5 6.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11M5.5 12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" />
    </>
  ),
  cache: <path d="M13.5 3.5L6.5 13.5h5l-1 7 7-10h-5z" />,
  'social-store': (
    <>
      <rect x="4.5" y="5" width="15" height="14" rx="1.5" />
      <path d="M4.5 9.7h15M4.5 14.3h15M10 5v14" />
    </>
  ),
  backup: (
    <>
      <path d="M4.8 12a7.2 7.2 0 1 0 2.1-5.1" />
      <path d="M4.5 4.5v3.4h3.4M12 8.5V12l2.6 1.8" />
    </>
  ),
  analytics: <path d="M4 7c4 0 5 5 9 5M4 17c4 0 5-5 9-5M4 12h15.5M17 9.5l2.5 2.5-2.5 2.5" />,
  // ---- D 计算、异步与通知 ----
  'image-processing': (
    <>
      <rect x="4" y="5.5" width="16" height="13" rx="1.5" />
      <path d="M4 16l4.5-4.5 4 4 2.5-2.5 5 5" />
      <circle className="f" cx="15.5" cy="9.5" r="1.6" />
    </>
  ),
  queue: (
    <>
      <rect x="3.5" y="8.5" width="4.5" height="7" rx="1" />
      <rect x="9.75" y="8.5" width="4.5" height="7" rx="1" />
      <path d="M16 12h4.5M18.5 10l2 2-2 2" />
    </>
  ),
  notification: (
    <>
      <path d="M4.5 10v4h3l7.5 4.5v-13L7.5 10z" />
      <path d="M18 9.2a3.6 3.6 0 0 1 0 5.6" />
    </>
  ),
  email: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="1.5" />
      <path d="M4.5 7l7.5 6 7.5-6" />
    </>
  ),
  scheduler: (
    <>
      <rect x="4.5" y="6" width="15" height="13.5" rx="1.5" />
      <path d="M4.5 10.5h15M8.5 4v4M15.5 4v4" />
      <circle className="f" cx="12" cy="15" r="1.6" />
    </>
  ),
  tagging: (
    <>
      <path d="M4 8.5v-3a1 1 0 0 1 1-1h3M16 4.5h3a1 1 0 0 1 1 1v3M20 15.5v3a1 1 0 0 1-1 1h-3M8 19.5H5a1 1 0 0 1-1-1v-3" />
      <circle cx="12" cy="12" r="3" />
      <circle className="f" cx="12" cy="12" r="1" />
    </>
  ),
  'social-api': (
    <>
      <path d="M9 4.5c-1.8 0-2.5.8-2.5 2.5v2.4c0 1.3-.8 2.1-2 2.6 1.2.5 2 1.3 2 2.6V17c0 1.7.7 2.5 2.5 2.5M15 4.5c1.8 0 2.5.8 2.5 2.5v2.4c0 1.3.8 2.1 2 2.6-1.2.5-2 1.3-2 2.6V17c0 1.7-.7 2.5-2.5 2.5" />
      <circle className="f" cx="12" cy="12" r="1.6" />
    </>
  ),
  // ---- E 运维与监控 ----
  'shell-access': (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="M7 9.5l3 2.5-3 2.5M12 15h5" />
    </>
  ),
  logging: (
    <>
      <path d="M6 3.5h8.5L18 7v13.5H6z" />
      <path d="M9 10h6M9 13.5h6M9 17h4" />
    </>
  ),
  monitoring: <path d="M4.5 4.5v15h15M7.5 15l3.5-4 3 2.5 4.5-6" />,
  tracing: (
    <>
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <circle cx="11" cy="17.5" r="2.2" />
      <path d="M6.8 9.1l3.4 6.3M12.4 15.8l4.4-5" />
    </>
  ),
  audit: (
    <>
      <rect x="5.5" y="5" width="13" height="15.5" rx="1.5" />
      <path d="M9.5 3.5h5v3h-5zM9 13.2l2.2 2.2 4-4.4" />
    </>
  ),
  'threat-detection': (
    <>
      <path d="M12 3.5l7 2.8v5.2c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6.3z" />
      <path d="M12 8.5V13" />
      <circle className="f" cx="12" cy="16" r="1.2" />
    </>
  ),
  // ---- F 治理、成本与交付 ----
  compliance: (
    <>
      <path d="M4.5 7.2l1.6 1.6 2.9-3M4.5 13.2l1.6 1.6 2.9-3M12 7.5h7.5M12 13.5h7.5M12 19h7.5" />
      <rect x="4.8" y="17.2" width="3.6" height="3.6" rx=".6" />
    </>
  ),
  'vuln-scan': (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5M10.5 7.5V11" />
      <circle className="f" cx="10.5" cy="13.6" r="1.1" />
    </>
  ),
  cost: <path d="M15.5 8.3c-.6-1.2-1.9-1.9-3.5-1.9-2 0-3.4 1-3.4 2.6 0 3.6 7 1.9 7 5.4 0 1.6-1.5 2.7-3.6 2.7-1.7 0-3-.7-3.6-2M12 4v2.4M12 17.1V20" />,
  'db-proxy': (
    <>
      <path d="M3.5 6.5l6 5.5M3.5 17.5l6-5.5M3.5 12h9" />
      <ellipse cx="16.5" cy="8.5" rx="3.5" ry="1.4" />
      <path d="M13 8.5v7c0 .8 1.6 1.4 3.5 1.4s3.5-.6 3.5-1.4v-7" />
    </>
  ),
  workflow: (
    <>
      <rect x="9" y="3.5" width="6" height="4.5" rx="1" />
      <rect x="3.5" y="16" width="6" height="4.5" rx="1" />
      <rect x="14.5" y="16" width="6" height="4.5" rx="1" />
      <path d="M12 8v4M6.5 16v-4h11v4" />
    </>
  ),
  ami: <path d="M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4" />,
};

/** 架构图中的非模块节点（中性底色）：浏览器、EC2 上的 Nginx 入口。 */
export const PSEUDO_MOTIFS: Readonly<Record<'browser' | 'nginx', ReactElement>> = {
  browser: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="M3.5 9h17" />
      <circle className="f" cx="6.3" cy="7" r=".9" />
      <circle className="f" cx="9" cy="7" r=".9" />
    </>
  ),
  nginx: (
    <>
      <rect x="5" y="4.5" width="14" height="15" rx="1.5" />
      <path d="M2.5 12h7M7 9.5l2.5 2.5L7 14.5M12.5 9h4M12.5 12h4M12.5 15h4" />
    </>
  ),
};

/** 组的几何符号（05 §2.10：不依赖颜色也能区分组），6 × 6 网格。 */
export const GROUP_SYMBOLS: Readonly<Record<string, ReactElement>> = {
  base: <rect x="1" y="1" width="4" height="4" />,
  A: <path d="M3 .6L5.6 5.4H.4z" />,
  B: <path d="M3 .4L5.6 3 3 5.6.4 3z" />,
  C: <circle cx="3" cy="3" r="2.4" />,
  D: <path d="M1.6.6h2.8L5.8 3 4.4 5.4H1.6L.2 3z" />,
  E: <path d="M2.2.5h1.6v1.7h1.7v1.6H3.8v1.7H2.2V3.8H.5V2.2h1.7z" />,
  F: <path d="M.4 1.2h5.2v1.2H.4zM.4 3.6h5.2v1.2H.4z" />,
};
