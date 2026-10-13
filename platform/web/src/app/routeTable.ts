/**
 * 路由表（08 §2.1～§2.3）：全部画面 P00～P13 的路径、布局与角色。页面组件按需加载（React.lazy），
 * 公开静态入口 /verify/*（verify/index.html，独立打包）与 /share/*（atl-certs 生成的静态 HTML）不属于 SPA，不在这里。
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { Role } from '../auth/jwt';

export type Layout = 'public' | 'app' | 'workspace';

export interface RouteSpec {
  /** 画面编号（08 §4.0）。 */
  screen: string;
  path: string;
  title: string;
  layout: Layout;
  /** 可进入的角色（公开路由为空）。`/settings/:tab` 的页签级角色由页面判断。 */
  roles: readonly Role[];
  component: LazyExoticComponent<ComponentType>;
}

const LAO: readonly Role[] = ['L', 'A', 'O'];
const LA: readonly Role[] = ['L', 'A'];
const L: readonly Role[] = ['L'];
const NONE: readonly Role[] = [];

export const ROUTE_TABLE: readonly RouteSpec[] = [
  // 公开（P01）
  { screen: 'P01', path: '/login', title: '登录', layout: 'public', roles: NONE, component: lazy(() => import('../features/auth/LoginPage')) },
  { screen: 'P01', path: '/auth/callback', title: '正在完成登录', layout: 'public', roles: NONE, component: lazy(() => import('../features/auth/AuthCallbackPage')) },
  { screen: 'P01', path: '/auth/signed-out', title: '已退出', layout: 'public', roles: NONE, component: lazy(() => import('../features/auth/SignedOutPage')) },
  // 需要登录
  { screen: 'P00', path: '/setup', title: '首次设置', layout: 'app', roles: LAO, component: lazy(() => import('../features/setup/SetupPage')) },
  { screen: 'P02', path: '/labs', title: '卡片目录', layout: 'app', roles: LAO, component: lazy(() => import('../features/catalog/CatalogPage')) },
  { screen: 'P03', path: '/labs/:labId', title: '卡片简介', layout: 'app', roles: LAO, component: lazy(() => import('../features/catalog/CardIntroPage')) },
  { screen: 'P03-Q', path: '/labs/:labId/quiz', title: '小测', layout: 'app', roles: L, component: lazy(() => import('../features/quiz/QuizPage')) },
  { screen: 'P02-T', path: '/tracks/:trackId', title: '学习路径', layout: 'app', roles: LAO, component: lazy(() => import('../features/catalog/TrackPage')) },
  { screen: 'P04/P05', path: '/workspace/:sid', title: '工作台', layout: 'workspace', roles: LAO, component: lazy(() => import('../features/workspace/WorkspacePage')) },
  { screen: 'P11', path: '/sessions', title: '我的实验', layout: 'app', roles: LAO, component: lazy(() => import('../features/sessions/SessionsPage')) },
  { screen: 'P11-D', path: '/sessions/:sid', title: '会话详情', layout: 'app', roles: LAO, component: lazy(() => import('../features/sessions/SessionDetailPage')) },
  { screen: 'P07', path: '/sessions/:sid/end', title: '结束与回收进度', layout: 'app', roles: LAO, component: lazy(() => import('../features/cleanup/EndPage')) },
  { screen: 'P08', path: '/sessions/:sid/report', title: '实验报告', layout: 'app', roles: LAO, component: lazy(() => import('../features/reports/ReportPage')) },
  {
    screen: 'P06',
    path: '/sessions/:sid/experiments/:module/:experimentId',
    title: '对比实验',
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../features/experiments/ExperimentPage')),
  },
  { screen: 'P07-M', path: '/resources/manual', title: '待人工处理清单', layout: 'app', roles: LA, component: lazy(() => import('../features/cleanup/ManualResourcesPage')) },
  { screen: 'P09', path: '/certificates', title: '证书与徽章', layout: 'app', roles: LAO, component: lazy(() => import('../features/certificates/CertificatesPage')) },
  { screen: 'P09-C', path: '/certificates/:certId', title: '证书详情', layout: 'app', roles: LAO, component: lazy(() => import('../features/certificates/CertificateDetailPage')) },
  { screen: 'P10', path: '/learning', title: '我的学习', layout: 'app', roles: LAO, component: lazy(() => import('../features/learning/LearningPage')) },
  { screen: 'P12', path: '/settings/:tab', title: '设置', layout: 'app', roles: LAO, component: lazy(() => import('../features/settings/SettingsPage')) },
];

/** 08 §2.1 站点地图中属于 SPA 的全部路径（测试用：路由表必须逐一覆盖）。 */
export const SITEMAP_PATHS = [
  '/login',
  '/auth/callback',
  '/auth/signed-out',
  '/',
  '/setup',
  '/labs',
  '/labs/:labId',
  '/labs/:labId/quiz',
  '/tracks/:trackId',
  '/workspace/:sid',
  '/sessions',
  '/sessions/:sid',
  '/sessions/:sid/end',
  '/sessions/:sid/report',
  '/sessions/:sid/experiments/:module/:experimentId',
  '/resources/manual',
  '/certificates',
  '/certificates/:certId',
  '/learning',
  '/settings/:tab',
] as const;
