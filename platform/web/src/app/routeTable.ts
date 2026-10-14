/**
 * 路由表（08 §2.1～§2.3）：全部画面 P00～P13 的路径、布局与角色。页面组件在 `src/pages/<区域>/`（默认导出），按需加载（React.lazy），
 * 公开静态入口 /verify/*（verify/index.html，独立打包）与 /share/*（atl-certs 生成的静态 HTML）不属于 SPA，不在这里。
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { Role } from '../auth/jwt';
import { msg } from '../i18n/core';

/** `*`（P13 #33“页面不存在”，在全局框架内）。 */
export const NotFoundRoute = lazy(() => import('../pages/errors/NotFoundPage'));

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
  {
    screen: 'P01',
    path: '/login',
    get title() {
      return msg.frame.routes.login;
    },
    layout: 'public',
    roles: NONE,
    component: lazy(() => import('../pages/login/LoginPage')),
  },
  {
    screen: 'P01',
    path: '/auth/callback',
    get title() {
      return msg.frame.routes.callback;
    },
    layout: 'public',
    roles: NONE,
    component: lazy(() => import('../pages/login/AuthCallbackPage')),
  },
  {
    screen: 'P01',
    path: '/auth/signed-out',
    get title() {
      return msg.frame.routes.signedOut;
    },
    layout: 'public',
    roles: NONE,
    component: lazy(() => import('../pages/login/SignedOutPage')),
  },
  // 需要登录
  {
    screen: 'P00',
    path: '/setup',
    get title() {
      return msg.frame.routes.setup;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/setup/SetupPage')),
  },
  {
    screen: 'P02',
    path: '/labs',
    get title() {
      return msg.frame.routes.catalog;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/labs/CatalogPage')),
  },
  {
    screen: 'P03',
    path: '/labs/:labId',
    get title() {
      return msg.frame.routes.card;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/card/CardIntroPage')),
  },
  {
    screen: 'P03-Q',
    path: '/labs/:labId/quiz',
    get title() {
      return msg.frame.routes.quiz;
    },
    layout: 'app',
    roles: L,
    component: lazy(() => import('../pages/quiz/QuizPage')),
  },
  {
    screen: 'P02-T',
    path: '/tracks/:trackId',
    get title() {
      return msg.frame.routes.track;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/tracks/TrackPage')),
  },
  {
    screen: 'P04/P05',
    path: '/workspace/:sid',
    get title() {
      return msg.frame.routes.workspace;
    },
    layout: 'workspace',
    roles: LAO,
    component: lazy(() => import('../pages/workspace/WorkspacePage')),
  },
  {
    screen: 'P11',
    path: '/sessions',
    get title() {
      return msg.frame.routes.sessions;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/sessions/SessionsPage')),
  },
  {
    screen: 'P11-D',
    path: '/sessions/:sid',
    get title() {
      return msg.frame.routes.session;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/sessions/SessionDetailPage')),
  },
  {
    screen: 'P07',
    path: '/sessions/:sid/end',
    get title() {
      return msg.frame.routes.end;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/end/EndPage')),
  },
  {
    screen: 'P08',
    path: '/sessions/:sid/report',
    get title() {
      return msg.frame.routes.report;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/report/ReportPage')),
  },
  {
    screen: 'P06',
    path: '/sessions/:sid/experiments/:module/:experimentId',
    get title() {
      return msg.frame.routes.experiment;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/experiments/ExperimentPage')),
  },
  {
    screen: 'P07-M',
    path: '/resources/manual',
    get title() {
      return msg.frame.routes.manual;
    },
    layout: 'app',
    roles: LA,
    component: lazy(() => import('../pages/manual/ManualResourcesPage')),
  },
  {
    screen: 'P09',
    path: '/certificates',
    get title() {
      return msg.frame.routes.certificates;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/certificates/CertificatesPage')),
  },
  {
    screen: 'P09-C',
    path: '/certificates/:certId',
    get title() {
      return msg.frame.routes.certificate;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/certificates/CertificateDetailPage')),
  },
  {
    screen: 'P10',
    path: '/learning',
    get title() {
      return msg.frame.routes.learning;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/learning/LearningPage')),
  },
  {
    screen: 'P12',
    path: '/settings/:tab',
    get title() {
      return msg.frame.routes.settings;
    },
    layout: 'app',
    roles: LAO,
    component: lazy(() => import('../pages/settings/SettingsPage')),
  },
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
