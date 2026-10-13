# platform/web — ATL SPA（`@atl/web`）

ATL 实验平台的单页应用：React 18 + Vite + react-router 7 + TypeScript。规格：`docs/platform/08-ui-design.md`（画面 P00～P13、
路由、组件、视觉、实时更新、无障碍）；视觉 token 与组件样式以已评审的原型 `docs/platform/prototype/index.html` 为准。
实现说明与取舍：`docs/implementation-notes.md` 的“platform-web-scaffold”小节。

## 目录

```text
platform/web/
├── index.html                 SPA 入口（无内联脚本与样式：CSP script-src / style-src 'self'，01 §10.6）
├── public/config.json         本地开发用的占位；安装时由 WebDeploy 覆盖（apiBase、region、userPoolId、clientId、domain、…）
├── scripts/dev.mjs            npm run platform:dev 的一键启动器
└── src/
    ├── main.tsx               读取 /config.json → createServices → <App/>
    ├── app/                   路由表（routeTable.ts）、守卫（guards.ts，表 1）、按会话状态渲染（sessionRouting.ts，表 2）、
    │                          服务容器（services.ts）、上下文与 hooks（context.tsx）、全局数据（globalStatus.tsx）、主题
    ├── api/                   ApiClient（路由常量 / Idempotency-Key / ETag / If-Match / problem+json）、SessionSync（全局事件轮询器）、
    │                          工作台心跳、serverClock、连接状态、响应类型
    ├── auth/                  Cognito 托管登录（授权码 + PKCE）、dev 令牌、访问令牌声明、/config.json
    ├── components/            全局框架：顶栏 GlobalBar、会话胶囊 SessionPill、账号菜单、横幅（globalBanners.ts）、离线条与页脚、
    │                          P13 错误页与对话框、页面骨架（Shells.tsx）、会话动作对话框注册点、画面桩 PageStub
    ├── features/<area>/       各画面（脚手架阶段是桩，P01 登录已实现）
    ├── i18n/zh-CN.ts          全部文案与错误码文案表（P13）
    ├── lib/                   存储（try/catch）、格式、打码器、剪贴板、播报、BroadcastChannel 包装、UUID
    ├── ui/                    设计系统：styles/（tokens、base、components、screens）、semantics.ts（状态的唯一映射）、
    │                          Shape / Icon（自绘 SVG）、Button、Pill、CostTierMark、Box、DataTable、Dialog / Drawer、Disclosure、
    │                          Banner / BannerStack、CommandBlock、CheckResultRow / SourceTag、ResourceRow / ManualItemCard、
    │                          EmptyState、Skeleton、ErrorPanel、Countdown、LiveRegion、Field
    └── test/                  Vitest 设置与假 fetch
```

## 命令

```bash
npm run platform:dev              # 一键：DynamoDB Local（Docker）→ 建表 → dev-server :8787 → Vite :5174
                                  #   选项：-- --no-db | --api-only | --web-only | --api-port N | --web-port N | --no-seed-catalog
npm run platform:dev:api          # 只启动 dev-server（原来的 platform:dev）
npm run dev -w @atl/web           # 只启动 Vite（需要 dev-server 已在 8787；ATL_API_URL 可改）
npm run build -w @atl/web         # tsc（浏览器 + Node 两份配置）+ vite build → platform/web/dist
npm run lint -w @atl/web          # ESLint（根配置；浏览器全局 + react-hooks 规则）
npm run test -w @atl/web          # Vitest（jsdom）；根目录 npm test 也会跑（项目名 atl-web）
```

本地登录：dev 模式下 `/login` 显示“开发模式登录”表单（角色 learner / assistant / observer + 用户标识），生成 dev-server 认可的
开发令牌 `dev.<group>.<sub>[.<authTime>]`（platform/api/src/dev/adapters/auth.ts）；勾选“模拟 60 分钟前登录”可测试“需要重新登录”。
开发令牌只在页面运行于本机地址（localhost、127.0.0.1、[::1]、*.localhost）且 config.json 为 `"auth": "dev"` 时启用。

`platform/web/dist` 存在时，`npm run platform:package` 会把它打进 `atl-web.zip`（否则用占位页）。
