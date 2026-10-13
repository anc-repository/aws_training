# 实现说明（implementation notes）

本文件记录实现阶段的约定、文件分工与“设计文档有歧义时的取舍”。权威契约仍是 [modular-design.md](modular-design.md)（总纲）；
每个实现者在自己的小节（`## <标签>`）里追加内容，不改动别人的小节。

---

## scaffold

脚手架（monorepo、契约包、注册表、后端骨架、全部依赖）。其他实现者都从这里开始填充。

### 1. 目录约定

```
package.json               npm workspaces：packages/*、backend、frontend、lambdas/*、experiments、scripts/module-cli
tsconfig.base.json         Node 22 / ES2023 / NodeNext / strict / verbatimModuleSyntax（类型导入必须写 import type）
tsconfig.json              tsc -b 的解决方案文件（contracts、image-core、backend、lambdas/image-thumbnail、experiments、module-cli）；
                           compilerOptions.paths 只给 tsx 用（工作区包解析到 TS 源码，无需先 build）
eslint.config.js           ESLint 9 flat config；no-restricted-imports：@aws-sdk/* 只允许在 backend/src/adapters/、
                           backend/src/modules/detectors/、scripts/、lambdas/ 与测试中出现
vitest.config.ts           每个工作区一个 project（各自有 vitest.config.ts）；vitest.shared.ts 把 @cloudalbum/* 指向源码
docker-compose.test.yml    postgres:16（55432）、valkey:8（56379）、localstack（4566）——只供 *.int.test.ts 使用
modules/registry.yaml      40 个模块的元数据（单一事实来源）；registry.schema.json 是它的 JSON Schema（§3.5 字段）
packages/contracts/        前后端共享：ModuleId、BypassKey、capabilities 类型、X-CloudAlbum-Path 与 Server-Timing 的格式化器 / 解析器、
                           注册表类型；src/generated/registry.ts 由 npm run gen:registry 从 YAML 生成（已提交，registry:check 校验是否过期），
                           经子路径 @cloudalbum/contracts/registry 导入
packages/image-core/       sharp 渲染核心（类型与常量已定义，render() 为桩）
backend/src/               严格按总纲 §11：config/ rules/ ports/ adapters/<module>/<driver>.ts modules/ observability/ db/ repositories/
                           http/（app.ts、middleware/、routes/）、container.ts、server.ts、worker.ts、cli.ts
backend/test/              unit 风格的测试按目录分组：rules/（表驱动 + registry 交叉检查）、config/、observability/、modules/、db/、http/、adapters/
frontend/                  React 18 + Vite 7 占位页面（只读 /api/capabilities）
lambdas/image-thumbnail/   handler 桩 + build.mjs（esbuild，nodejs22.x arm64，sharp 不打包）
experiments/               运行器桩（_lib/runner.ts）
scripts/registry/          gen:registry（build.ts）与 registry:check（check.ts / checks.ts）
scripts/module-cli/        scripts/module 的命令登记桩（commander）
```

### 2. 核心约定（实现者必读）

- **端口与驱动**：端口接口在 `backend/src/ports/*.ts`（总纲 §4.2 照录）。驱动文件固定为 `backend/src/adapters/<module>/<driver>.ts`，
  导出一个实现端口的类，构造函数统一为 `new X(deps: AdapterDeps)`（`adapters/types.ts`；`storage/local.ts` 另有第二个参数
  `LocalStorageOptions`，供 shared-fs 的 efs 复用）。**构造函数不做 I/O**，建连放在 `init()`。container 的工厂表
  （`container.ts` 的 `FACTORIES`，键 `<module>:<driver>`）全部动态 import，L0 永远不加载 AWS SDK。
- **AWS SDK**：只经 `adapters/aws/clients.ts` 的懒加载工厂取客户端（`deps.aws.s3()` 等，凭证来自 iam 的 `AwsCredentialsPort.provider()`）。
  需要新的 SDK 客户端时在工厂里追加一个方法（只用 `import type` + 动态 `import()`）。测试用 `aws-sdk-client-mock`（示例见
  `backend/test/adapters/aws-clients.test.ts`）。**不要调用真实 AWS API。**
- **可观测性**：模块代码不得自己拼 `X-CloudAlbum-Path` / `Server-Timing`。container 给适配器套 `observability/instrument.ts` 代理，
  自动累加耗时并写入 `<module>=<driver>`；需要主机类别与结果时调用 `markPath(module, 'redis@elasticache:hit')` 或
  `markOutcome(module, 'hit')`（`observability/request-context.ts`）。`CachePort.wrap` 等不计时的方法见 `UNTIMED_METHODS`，
  缓存驱动应自行用 `addTiming('cache', ms)` 记录 get / set。database 没有端口，`db/knex.ts` 的 `instrumentKnex()` 已记录每次查询。
- **请求上下文**：`currentContext()` 里有 requestId、principal、userId、isAdmin、bypass、experiment；路由可以设置 `ctx.route`
  （路由模板）供 LabMetricsStore 分组。旁路判断用 `isBypassed('cache')`。
- **错误**：未实现抛 `NotImplementedError`（HTTP 501）；业务错误抛 `HttpError(status, code, message)`；配置错误用
  `ConfigValidationError`（入口以 78 退出）。
- **数据库**：SQL 只写在 `backend/src/repositories/*.ts`。方言差异集中在 `db/dialect.ts`：时间一律 ISO 8601 UTC 字符串，
  JSON 列用 `jsonb`（SQLite 为文本，读用 `jsonIn()`），布尔读用 `boolIn()`，计数用 `countOf()`。新迁移放
  `db/migrations/<yyyymmdd>_<nnnn>_<name>.ts` 并追加到 `db/migrations/index.ts` 的 `MIGRATIONS`（静态清单，不扫描目录）；
  已提交的迁移不得修改。两种方言都要能跑（`migrations.int.test.ts`）。
- **配置**：开关与子配置都在 `config/schema.ts`（zod 分段）。新键必须先在这里声明（否则 registry:check 报错）；
  `modules.d/<id>.env` 只能出现该模块 `ownsEnv` 中的键（CFG-002）。路由与服务读取 `c.config`，**不要读 process.env**。
  运行时热键经 `c.runtimeConfig()`（ConfigPort 未实现时返回 `DEFAULT_RUNTIME_CONFIG`）。
- **规则**：全部规则只在 `backend/src/rules/rules.ts`；模块间依赖只写在 registry 的 `requires` / `conflicts`。新增规则时同时补
  `backend/test/rules/rules.test.ts` 的正反用例，并跑 `npm run registry:check`。
- **已实现驱动清单**：`config/implemented.ts`。实现了新驱动后在 `IMPLEMENTED_DRIVERS` 中追加；未列出的驱动在启动时以 CFG-001
  （退出码 78）拒绝并给出提示。

### 3. 各实现者应该填充的文件

（全部桩文件都在文件头注明了负责人。“桩”= 方法抛出 NotImplementedError 或路由返回 501。）

**L0 本地实现者**

- 本地驱动：`adapters/iam/none.ts`、`secrets/env.ts`、`logging/file.ts`（pino）、`storage/local.ts`、`cache/none.ts`、`queue/sync.ts`、
  `auth/local.ts`（流程辅助代码可放 `adapters/auth/local/`）、`image-processing/inline.ts`、`workflow/inline.ts`、`notification/db.ts`、
  `email/outbox.ts`、`scheduler/cron.ts`、`social-store/db.ts`、`tagging/none.ts`、`config/file.ts`、`kms/local.ts`、`monitoring/local.ts`、
  `tracing/none.ts`、`analytics/db.ts`、`identity-pool/none.ts`、`cdn/direct.ts`、`waf/nginx.ts`、`autoscaling/single.ts`、`lock/file.ts`。
- `packages/image-core/src/index.ts` 的 `render()` / `sniffImageType()`（Lambda 与 worker 复用）。
- `repositories/`：扩展 `users.ts`，新增 albums、photos、notifications、outbox、social-db、audit、job-runs、click-events；
  `lab.ts` 中补 lab_runs / lab_results / lab_origin_samples 的读写。
- `services/`（photo-pipeline、feed、media-url、user-directory、mailer、share、report、notifications、cost-estimate、compliance-check）
  与 `jobs/`（8 个 ScheduledJobName + 5 个 JobName 的 handler，`jobs/index.ts` 的 `bindJobs()`）。
- 路由：`http/routes/` 下 auth、jwks、albums、photos、uploads、media、social、notifications、me、admin、lab（含 `/api/lab/self-check`：
  用 `awsSdkLoadReport()`；`/api/lab/metrics`：`repositories/lab.ts` 的 `queryRollups()` + `c.labMetrics.summarizeRecent()`；
  `/api/lab/faults`：`c.faults`）。保持各文件 `register(app, c)` 的签名。
- `server.ts` 的 `startApiLoops()`、`worker.ts` 的 `startWorkerLoops()`（scheduler.register / start、memory 队列消费者）；
  `http/app.ts` 中 bypass 守卫的审计回调改为写 `audit_log`；`modules/detectors/ec2.ts` 补齐 00-ec2-base.md 第 7 节的其余检查项。

**8 个 MVP 模块的实现者**（AWS 驱动 + 本模块的本地档 + 探针；CloudFormation 模板与 profiles 由 infra 实现者或模块实现者按分工）

- iam：`adapters/iam/role.ts`、`keys.ts`、`modules/detectors/iam.ts`（不需要时可从 `detectors/index.ts` 去掉）。
- storage：`adapters/storage/s3.ts`（含 `importObject`、分片辅助）；uploads / media 路由的 s3 分支。
- cdn：`adapters/cdn/cloudfront.ts`、`modules/detectors/cdn.ts`（被动计数 + `observations()` 供 SEC-001）。
- auth：`adapters/auth/cognito.ts`（aws-jwt-verify）；`http/middleware/auth.ts` 的 Principal → users.id 映射（JIT 建档）。
- queue：`adapters/queue/memory.ts`、`sqs.ts`；api / worker 的消费循环。
- image-processing：`adapters/image-processing/worker.ts`、`lambda.ts`；`lambdas/image-thumbnail/`；`http/routes/internal-hooks.ts`
  的 HMAC 回调（原始请求体在 `req.rawBody`）。
- cache：`adapters/cache/memory.ts`、`redis.ts`（ioredis）、`adapters/lock/redis.ts`。
- database：`modules/database-probe.ts` 的深度探针（`rds:DescribeDBInstances`，经 `aws.rds()`）、`adapters/lock/pg.ts`。

**前端实现者**：`frontend/src/**`（按总纲 §11 / §12；`App.tsx`、`main.tsx` 只是占位）。

**infra 与工具实现者**：`infra/**`、`profiles/**`、`scripts/module`（Bash 包装）、`scripts/module-cli/src/**`、`scripts/migrate/**`、
`scripts/selfhost/**`。计划校验可直接调用 `node backend/dist/cli.js check-config --env-dir <暂存目录> --plan`（退出码 78 = 不通过）。

**experiments 实现者**：`experiments/**`（每个模块一个目录，实验 id 与 registry 的 `lab.experiments` 一致）。

### 4. 需要其他文件配合的事项

- **Nginx 入口段**：`infra/nginx/cloudalbum_proxy.conf` 需要加一行 `proxy_set_header X-CloudAlbum-Entry $ca_entry;`。Node 只信任来自回环地址的
  这个头，没有时路径头记为 `entry=direct`（开发机直连）。
- **LabMetricsStore 的 instanceId**：`autoscaling/single.ts` 的 `identity()` 实现后，路径头会自动带 `inst` / `az`，汇总行也会用实例 ID。
- **SEC-001/002/003/005 的输入**：感知器 `observations()` 返回的键名约定为 `cdn.originVerifyMismatch5m`、`cdn.listener8080Missing`、
  `load-balancer.directPublicRequests5m`、`shell-access.port22Open`、`auth.plaintextAuthRequests5m`（见 `rules/rules.ts`）。
- **部署范围的规则**：DEP-014、DEP-016、DEP-037、MUTEX-004 的 `deployCheck()` 目前返回 false，由 scripts/module 实现者接入云端状态。

### 5. 如何运行

```bash
npm install                      # 统一由脚手架 / 集成阶段执行（本轮用 --before=2026-09-29 安装，避开刚发布的版本）
npm run build                    # gen:registry + tsc -b + frontend 与 scripts/registry 类型检查
npm test                         # vitest（全部 unit 测试；pretest 会先 gen:registry）
npm run lint                     # eslint
npm run registry:check           # registry.yaml 的 schema / 规则交叉引用 / doc 锚点 / ownsEnv / 变量声明 / MVP 完整性
node backend/dist/cli.js check-config            # L0 默认配置下返回 0；--env-dir <dir> 指定目录；--plan 额外跑部署范围规则

# 需要真实服务行为的集成测试（*.int.test.ts）
npm run test:services:up && CLOUDALBUM_IT=1 npm test && npm run test:services:down

# 开发机上跑起来（Windows / macOS / Linux 均可）
npm run dev:init                 # 生成 .cloudalbum/dev/{etc,data}（随机机密 + ES256 密钥）并打印要设置的 CLOUDALBUM_ENV_DIR
export CLOUDALBUM_ENV_DIR=$PWD/.cloudalbum/dev/etc NODE_ENV=development
npm run build                                    # 先构建一次：backend 的 tsx 经 node_modules 解析 @cloudalbum/contracts 的 dist
npm run dev --workspace @cloudalbum/backend      # tsx watch；NODE_ENV≠production 时自动执行数据库迁移
npm run dev --workspace @cloudalbum/frontend     # Vite，代理 /api、/social、/media、/.well-known 到 :3000
node backend/dist/cli.js admin:create --email admin@example.com   # 打印生成的初始密码
```

### 6. 设计有歧义时的取舍（偏离或细化总纲之处）

1. **APP_BASE_URL 有默认值** `http://localhost:3000`（总纲为必填）。理由：`check-config` 在没有 `/etc/cloudalbum` 的机器上也要能对 L0 默认配置返回 0；
   EC2 上引导脚本总会写入 `cloudalbum.env`。
2. **on/off 开关保持字符串**（不 transform 成布尔），便于与 registry 表达式比较；`CLOUDALBUM_ALLOW_UNSAFE` 仍解析为数组。
3. **Core 新增键**：`CLOUDALBUM_PROFILE`（capabilities.app.profile）、`CLOUDALBUM_ENV_DIR`、`CLOUDALBUM_DATA_DIR`（数据卷挂载点）、
   `LOCK_FILE_DIR`、`NODE_ENV`、`PORT`、`HOST`。`STORAGE_LOCAL_ROOT`、`SQLITE_PATH`、`OUTBOX_DIR`、`LOG_DIR`、`JWT_SIGNING_KEY_FILE`
   的默认值由数据目录 / 配置目录派生（L0 下与总纲的字面默认值完全一致），开发机只需改一个 `CLOUDALBUM_DATA_DIR`。
4. **其余模块的 zod 分段**（总纲 4.4 写了“同理”）：iam、secrets、config、logging、monitoring、notification、email、scheduler、social、tagger、
   analytics、kms 按各组文档第 3 节补齐；非 MVP 模块的 AWS 分支变量一律可选，保证报出的是“未实现”而不是“缺变量”。
5. **未实现的驱动**：结构校验通过后由 `config/implemented.ts` 拒绝，报告为 CFG-001（section=`implementation`），退出码 78。
   `parseConfig(env, { checkImplemented: false })` 只做结构校验（规则单元测试与将来的计划校验用）。
6. **registry.yaml**：40 个条目逐字摘自各组文档第 0 节（ec2 为 00-ec2-base.md 第 1 节）；MVP 模块补了 `version: 1` 与 lab 卡片文案
   （summary / keyMetrics / diagram / badges，文案取自总纲 12.3 与各模块文档）。为让文档中的条目通过 schema，schema 放宽了三处：
   `hostSetup` 允许 `scripts/` 下的脚本（db-proxy 复用 `scripts/selfhost/pgbouncer.sh`）、`stacks[].region` 允许 `param:<参数名>`
   （backup 的灾备区域）、`port` 允许 `null`（social-api）。
7. **注册表内联位置**：总纲写“后端构建时内联为 JSON”，这里生成到 `packages/contracts/src/generated/registry.ts`（前后端共用，
   经 `@cloudalbum/contracts/registry` 导入），并提交到仓库；`registry:check` 发现过期即失败。
8. **规则引擎的 when 语义细化**：一个 `when` 如果在“全部默认值”（纯 L0）下就成立、且没有引用本模块自己的开关变量（例如 cdn 的
   `CDN_MEDIA_ORIGIN: ec2`、identity-pool 的 `IDENTITY_DEV_PROVIDER: ""`），只在本模块离开本地默认值时生效——否则 L0 本身就会违反
   DEP-028、DEP-002。`enabled()` 由开关取值推导（取本模块拥有的 AWS 值且没命中 `selfHosted.match`；selfHosted 只在开关取
   `selfHosted.driver` 时生效），`MODULE_<ID>=on` 的一致性由 CFG-004 保证；MUTEX-001/002/003 看 `MODULE_<ID>` 标志。
   `need: []` 的条目由 rules.ts 的 `check()` 给条件（DEP-018、021、030）或 `deployCheck()`（DEP-014、016、037、MUTEX-004，目前为桩）。
   DEP-012 没有可求值的条件（总纲修订记录：触发器子选项待 02 组定名），`registry:check` 对它显式豁免。DEP-008 与 ASG-015 不出现在规则表中。
9. **状态机的滞回**：error → degraded 之后重新计数，需要再连续 2 次健康才回到 ok。
10. **container**：配置错误时抛出 `ConfigValidationError`（带完整报告），由 server / worker / cli 以退出码 78 退出（总纲写的是在
    buildContainer 内 `process.exit(78)`，改为抛出以便测试）。容器额外暴露 `inlineImages`（X-Compare-Bypass: image）、`labMetrics`、
    `faults`、`runtimeConfig()`、`startBackground()`、`env`、`layers`、`verdict`、`detectors`、`aws`。为了让桩阶段也能启动：
    `provider()` 未实现时不建 AWS 客户端；LoggerPort 未实现时日志退回 stderr JSON；SecretsPort 未实现时跳过 CFG-007 并告警；
    `identity()` 未实现时用主机名。`NODE_ENV≠production` 时启动自动执行数据库迁移（EC2 上仍由引导脚本执行 `cli db:migrate`）。
11. **端口的细化**（在“照录”之外追加，均为可选或纯类型）：`ImageFailure`（04 组登记）、`CdnPort.mediaUrl?`（01 组约定 12）、
    `TempAwsCredentials`（§4.2 引用但未定义）、`SECRET_NAMES` / `secretEnvName()`、`DEFAULT_RUNTIME_CONFIG`。
12. **capabilities**：响应体多一个 `view: 'public' | 'admin'` 字段；`/api/capabilities`、`/api/capabilities/stream`、`/api/health/*`、`/metrics`
    由脚手架实现（它们只是能力注册表与 LabMetricsStore 的薄包装），其余路由是 501 桩。
13. **路径头 entry**：没有 Nginx 时为 `direct`（总纲的 entry 词表里没有它，只在开发机出现）。
14. **CLI**：除总纲列出的子命令外新增 `admin:create`（任务要求）与 `dev:init`；`admin:ensure` 按 00-ec2-base.md 实现。
    `db:migrate` 不经 SecretsPort（PostgreSQL 密码取分层配置中的 `DB_PASSWORD`；只配置了 `DB_PASSWORD_SECRET_ARN` 时需由 database 实现者补上）。
15. **依赖版本**：TypeScript 5.9（未用刚发布的 7.x）、ESLint 9（flat config 写在 `eslint.config.js`）、Vitest 3.2、React 18.3、
    react-router-dom 7、Vite 7、zod 4、Express 5、Knex 3 + better-sqlite3 12 + pg 8、ioredis 5、pino 9、AWS SDK v3。
    `otplib@12` 安装时有弃用提示（v13 已发布，API 不同），auth 实现者可改用自写的 RFC 6238 TOTP。
16. **ESLint 的 @aws-sdk 限制**对测试文件放开（aws-sdk-client-mock 需要导入客户端类）。

---

## local-identity

L0 的身份、账号、相册、通知、发件箱、审计、管理员、能力 / 健康接口与 `/api/lab/*`。只装配本地驱动；AWS 驱动（cognito 等）由各模块实现者负责。

### 1. 文件

- 适配器：`adapters/auth/local.ts`（+ `adapters/auth/local/` 下 hash、keys、totp、password-policy、emails）、`secrets/env.ts`、
  `config/file.ts`、`kms/local.ts`、`email/outbox.ts`、`notification/db.ts`、`logging/file.ts`、`monitoring/local.ts`、`tracing/none.ts`、`lock/file.ts`。
- 仓储：`repositories/users.ts`（扩展，含 auth_tokens）、`albums.ts`、`notifications.ts`、`outbox.ts`、`audit.ts`、`lab.ts`（追加 runs / results / 采样读取）。
- 服务：`services/user-directory.ts`（Principal → users.id、JIT 建档、`toMe()` / `toAdminUser()`）、`services/notifications.ts`
  （`notify()`、`notifyFanoutHandler()`、`toNotificationItem()`、`toOutboxSummary()`）。
- HTTP：`middleware/auth.ts`（认证 + CSRF + 受限会话）、新增 `middleware/audit.ts`（`audit()`、`auditBypass()`）；
  路由 `auth.ts`、`albums.ts`、`notifications.ts`、`admin.ts`、`lab.ts`、`capabilities.ts`（加 `config=file:vN` 路径段）。
- 测试：`test/contract/<port>.contract.ts`（契约）+ `*.local.test.ts`（本地驱动）、`test/repositories/identity*.ts`（SQLite + PostgreSQL 16）、
  `test/http/{identity-flow,albums-notifications,admin-lab}.test.ts`（`test/helpers/identity-harness.ts` 只装配本组驱动与路由，
  其余端口用内存假实现，不依赖其他实现者的进行中代码）。

### 2. HTTP 接口（JSON 形状与 `frontend/src/api/types.ts` 对齐：camelCase、`Page<T> = {items, nextCursor}`）

- `/api/auth/*`：register（201，并签发未验证的受限会话）、confirm、resend、login（`{kind:'tokens',user}` | `{kind:'mfa_required',challengeId}`）、
  mfa/verify（带 challengeId = 完成登录挑战；不带 = 确认 MFA 绑定）、mfa/enroll、refresh、logout、forgot、reset、session（`?for=social` 另返回 `{token,expiresAt}`）。
  `AuthPort.flows` 为 null（cognito）时这些流程接口返回 404 `AUTH_FLOW_UNAVAILABLE`；session 两种驱动都可用。
- `/api/albums*`、`/api/notifications*`、`/api/admin/*`、`/api/lab/*`：见各路由文件头注释。
- `/api/me/outbox`、`/api/me/outbox/:id`：处理器由 `routes/auth.ts` 的 `registerSelfOutbox(app, c)` 提供，**需要在 `routes/me.ts` 中调用**
  （总纲 §11 把 /me/outbox 放在 me.ts；me.ts 先于本组以外的路由注册，`/api/me/*rest` 的桩会挡住它）。

### 3. 设计有歧义时的取舍

1. **受限会话**：未验证邮箱的用户也能登录（注册后自动登录），但 `Principal.emailVerified=false` 时认证中间件只放行 `/api/auth/*`、`/api/me`、
   `/api/me/outbox*`（外加 `/api/capabilities*`、`/api/health*`），其余 `/api/*`、`/social/*` 返回 403 `EMAIL_NOT_VERIFIED`。验证状态取数据库
   （按主键查询、进程内缓存 5 秒，确认时立即失效），不取令牌声明，所以验证后不必重新登录。
2. **CSRF**：02#auth 写“双提交 token”。为了对前端透明，改为在认证中间件中校验同源：以 Cookie 认证的写请求必须带同源 `Origin`
   （APP_BASE_URL、CDN_BASE_URL 或请求自身的 Host）或不带 Origin，且 `Sec-Fetch-Site≠cross-site`；否则 403 `CSRF_ORIGIN_MISMATCH`。
   Bearer 令牌不受影响。Cookie 本身仍是 SameSite=Lax。
3. **注册防枚举**：登录、找回密码、重发验证码统一提示 / 静默；注册对已存在的邮箱返回 409 `EMAIL_TAKEN`（注册后要立即签发会话，无法做到完全不可区分）。
4. **只有一个 kid 是正常状态**：总纲 6.2 写“只剩一个 kid → degraded”，但 L0 从未轮换时本来就只有一个；改为“上一版本私钥文件存在但无法解析”才 degraded。
   上一版本私钥 = 当前私钥同目录的 `<name>.prev.pem`；EnvSecrets 的 PEM 按 (mtime, size) 缓存，轮换后下一次读取即生效；遇到未知 kid 最多每 30 秒强制重载一次。
5. **验证码 / 重置码**：随机 18 字节 base64url（库里只存 sha256），邮件中给出前端链接 `/verify?email&code`、`/reset?email&code`；
   验证 24 小时、重置 60 分钟有效；重发时同类旧码作废。TOTP 自写（RFC 6238，SHA1/30s/6 位，±1 步），没用已弃用的 otplib@12。
6. **Principal.expiresAt** 为 epoch 秒（与 JWT `exp` 一致；cognito 适配器相同）。
7. **登出**：删除刷新令牌整族 + `token_version+1`；只有 access token 而没有 `ca_rt`（Path=/api/auth）时只清 Cookie。
8. **邮件发送不经队列**：auth 流程直接调用 EmailPort（outbox 档就是写文件 + 写表）；`email.send` 任务留给 mailer / jobs 实现者。
   `notify()` 入队 `notify.fanout`；入队失败（例如 handler 尚未绑定）时直接调用 NotifierPort 并告警——站内信已写好，通知是非权威端口。
9. **ConfigPort 未知键**：02#config 写“拒绝整次变更”，总纲 4.2 写“忽略并告警（CFG-009）”；按总纲：忽略未知键、其余合法键生效、探针 degraded。
   值不合法或 JSON 损坏时整次拒绝、沿用上一份快照。`featureFlags['email.selfPreview']` 缺省视为 true（L0 默认开启）。
10. **kms 密文格式**：`ca1.<base64url(keyRef)>.<edk>.<iv>.<ct>.<tag>`（keyRef 也做 base64url，因为 KMS ARN 含 `:` 与 `/`）；
    AAD = `ca1|app|purpose|rowId`，包裹数据密钥时 AAD 不含 rowId。`CRYPTO_LOCAL_PLAINTEXT=on` 的密文 keyRef 为 `local:plain`。
    local 驱动遇到 KMS 密文返回 503 `CRYPTO_KEY_REF_UNSUPPORTED`。路径段：`kms=local:encrypt|local:decrypt|local:plaintext`。
11. **outbox**：`.eml` 由本文件自建的 MIME 构造（multipart/alternative、base64 正文；没有引入 nodemailer / handlebars），`eml_path`
    只存相对 OUTBOX_DIR 的逻辑路径；`status=sent`、`delivery_status=none`、`delivered=false`。投递记录的 outbox 状态记为 `stored`。
12. **审计**：`audit()` 自动补 actor、IP、UA、request_id；同一行以 `source=audit` 镜像到 `LOG_DIR/audit.log`；写入失败只记 error 日志。
    哈希链 PostgreSQL 用 `pg_advisory_xact_lock` 串行化；`AUDIT_HASH_CHAIN=off` 写入的行 prev_hash 为空，校验会指出断点（对照实验）。
13. **相册**：列表走 `cache.wrap`（键 `albums:v1:owner:<id>`，TTL = 运行时 `feedCacheTtlSec`），写操作 `cache.del`；照片增删由 photos 路由调用
    `albumCacheKeys(ownerId)` 失效。详情页的媒体 URL = `StoragePort.createReadUrl` + `CdnPort.mediaUrl`（cdn 旁路时不改写），与 MediaUrlBuilder 规则一致。
14. **文件锁**：`LOCK_FILE_DIR` 不可创建时（开发机没有 /run）退回系统临时目录并告警；`lock/pg.ts`、`lock/redis.ts` 按 scaffold 分工留给 database / cache 实现者。
15. **/api/lab/self-check** 的 `ok`：`IAM_CREDENTIALS=none` 时要求没有加载任何 `@aws-sdk/*`；另返回 ec2 检查项、密钥指纹比对、进程心跳。
    `/api/lab/metrics` 先 flush 本进程的 LabMetricsStore，刚跑完的实验立即可查；端口汇总按 driver 分组。

### 4. 需要其他文件配合

- `http/app.ts`：`bypassGuard({ …, audit: auditBypass(c) })`（`http/middleware/audit.ts`），把旁路请求写进 audit_log（总纲 8.3 第 6 条）。
- `http/routes/me.ts`：在 `register()` 开头调用 `registerSelfOutbox(app, c)`（`routes/auth.ts`）；`GET /api/me` 可用
  `toMe(await new UserDirectory(c.db).ensureUser(principal), principal)`（`services/user-directory.ts`）。
- `http/routes/jwks.ts`：`GET /.well-known/jwks.json` 返回 `c.auth.jwks()`，为 null（cognito）时 404；`Cache-Control: public, max-age=300`。
- `jobs/`：`bindJobs()` 中 `'notify.fanout': notifyFanoutHandler({ notifier: c.notifier, logger: c.logger })`；`outbox.retention` 用
  `deleteOutboxBefore()` 并删除返回的 `.eml`（`OutboxEmail.resolveEmlPath()`）；`audit.retention` 用 `deleteAuditBefore()`。
- photos / social 路由：写审计用 `audit(c, {action:'photo.delete', …})`；评论 / 点赞通知用 `notify()`；照片增删后 `c.cache.del(albumCacheKeys(ownerId))`。

---

## aws-adapters

8 个 MVP 模块的 AWS 侧代码（适配器、探针、感知器、Lambda）。L0 下这些文件都不会被加载（container 动态 import），也不加载任何 `@aws-sdk/*`。

### 1. 文件

- `adapters/aws/clients.ts`：在懒加载工厂之外追加 `loadAwsPackage()`（适配器动态加载 presigner 等包时登记，`awsSdkLoadReport()` 可见）、
  错误分类 `awsErrorName / awsHttpStatus / isAwsNotFound / isAwsAccessDenied / describeAwsError`，以及只读控制面查询 `describeDbInstance()`
  （`modules/` 下按 ESLint 规则不能直接引用 `@aws-sdk/*`，database 探针经它调用 `rds:DescribeDBInstances`）。
- 适配器：`storage/s3.ts`、`queue/sqs.ts`、`cache/redis.ts`、`auth/cognito.ts`、`image-processing/lambda.ts`。
- 探针 / 感知器：`modules/database-probe.ts`、`modules/detectors/{ec2,iam,cdn}.ts`（ec2.ts 同时导出 IMDSv2 小客户端 `ImdsClient`）。
- Lambda：`lambdas/image-thumbnail/src/handler.ts`（`createHandler(deps)` 便于测试，`handler` 为入口）、`src/wire.ts`（回写线上格式）。
- 测试：`backend/test/adapters/aws/**`（内存版 S3 / SQS / Redis + 与驱动无关的契约套件 `contracts/{storage,queue,cache}.contract.ts`）、
  `backend/test/modules/{detector-ec2,detector-iam-cdn,database-probe}.test.ts`、`*.int.test.ts`（Valkey 8、PostgreSQL 16）、
  `lambdas/image-thumbnail/test/handler.test.ts`。

### 2. 对外约定（infra、worker、路由实现者请按此对接）

- **Lambda 环境变量**（`infra/modules/image-processing.yaml`）：`MEDIA_BUCKET`（必填）、`RESULT_CHANNEL=callback|queue`、`CALLBACK_URL`、
  `CALLBACK_HMAC_KEY`（secrets=env，NoEcho 参数）或 `CALLBACK_SECRET_ARN`（secrets=secretsmanager）、`RESULT_QUEUE_URL`、`MAX_PIXELS`（默认 40000000）、
  `MAX_BYTES`（默认 30 MB）、`RAW_PREFIX`（默认 `raw/`）、`CALLBACK_TIMEOUT_MS`。buffer-queue 触发时 ESM 需开 `ReportBatchItemFailures`。
- **S3 Object Created 规则名**固定为 `cloudalbum-<env>-image-processing-raw-created`（探针 `events:DescribeRule` 按这个名字查；没有新增 env 键）。
- **回写线上格式**：`{ v: 1, kind: 'result' | 'failure', photoId, rawKey, variants | error, meta, processedBy: { driver: 'lambda', durationMs, coldStart, host }, finishedAt }`；
  callback 请求头 `X-CloudAlbum-Timestamp`、`X-CloudAlbum-Signature: v1=<hex(HMAC-SHA256(key, ts + "." + rawBody))>`。
  衍生图对象元数据：`width`、`height`、`src-width`、`src-height`、`src-format`、`dominant-color`、`taken-at`、`photo-id`（对账补记 READY 用）。
- **S3 桶路由**：`variants/`、`reports/` → 展示桶，其余（`raw/`、`lab/`、`_probe/`）→ 原图桶；键不变。
- **SQS**：消息体 = `JobEnvelope` JSON，消息属性 `name`；失败按接收次数退避 10s / 60s / 300s；心跳 = 可见性超时的一半；`attempt` = `ApproximateReceiveCount`。
- **Redis**：键前缀 `REDIS_KEY_PREFIX`，值 JSON；路径头主机类别 `local`（回环）/ `elasticache` / `remote`。
- **Principal.expiresAt** = JWT `exp`（epoch 秒，与 local-identity 一致）。

### 3. 设计有歧义时的取舍

1. **Cognito 登录方式按总纲**：总纲 4.2 规定 cognito 的 `flows = null`（浏览器经 Amplify / 托管登录直接与 Cognito 交互，EC2 不经手密码），
   与 02#auth 的 BFF 写法冲突，以总纲为准：`COGNITO_LOGIN_MODE=sdk` = 前端动态 import aws-amplify 直连 User Pool，`managed` = 托管登录页；
   后端只用 aws-jwt-verify 校验 access token。因此 SPA 用的 App Client 必须是**公有客户端（不生成密钥）**，深度探针发现带密钥时报 degraded；
   `cognito-client-secret` 只在 managed 子模式由服务端换 token 时才需要。
2. **access token 不含 email**：首次见到某个用户名时用 `AdminGetUser` 取 email / email_verified / custom:plan（缓存 10 分钟，失败时 email 为空、请求照常）。
3. **bulk 迁移**：`importBatch()` 之外提供 `importIdentities()`（返回每个身份的 Cognito sub，供迁移脚本回写 users.auth_subject）与
   `ensurePasswordReset(email)`（迁移用户首次登录时对 FORCE_CHANGE_PASSWORD 账号发重置码）。
4. **lambda 写回**：`acceptCallback / acceptResult` 只校验与解析，写回由调用方执行（与端口“返回 ImageResult | ImageFailure”一致）。
   `lambda.ts` 自带 `PhotoStateStore` 接口与 Knex 默认实现（对账、结果队列消费用），语义与 `repositories/photos.ts` 的
   `applyImageResult / applyImageFailure / findStuckProcessing / touchProcessing` 相同；集成阶段可改为直接调用后者（提交时它尚未入库，故未依赖）。
5. **SQS 最老消息年龄**需要 CloudWatch（`ApproximateAgeOfOldestMessage`），为避免新增依赖，`stats()` 不返回 `oldestAgeSec`。
6. **按任务名限并发**：超出并发的消息留在本进程（心跳续租）等待，而不是放回队列——放回会增加接收次数，可能被误送进 DLQ。
7. **queue 旁路**（`X-Compare-Bypass: queue`）在 `SqsQueue.enqueue()` 内处理（instrument 代理不改写调用），需要本进程已 `bind()` 该任务。
8. **S3 流式 putObject** 在没有 `@aws-sdk/lib-storage` 时先缓冲（上限 64 MB；原图上限 30 MB）。S3 故障统一映射为 503 `STORAGE_UNAVAILABLE`，
   GetObject 不存在为 404 `OBJECT_NOT_FOUND`；403 的 HeadObject 不当作“不存在”。
9. **cdn 的 X-Origin-Verify 不匹配**：Nginx 对不匹配的请求直接 403，Node 看不到；感知器把“带 `X-Amz-Cf-Id` / `X-Origin-Verify` 但 entry 不是
   `cloudfront>…`”的请求计为不匹配（经别人的分配打到 80 端口）。`listener8080Missing` 由 `observations()` 每 60 秒在后台刷新一次本机 8080 检查
   （cdn 的主探针在 CdnPort 适配器里，detect() 未必被调用）。
10. **iam 感知器**：capabilities 以 `adapters/iam/{role,keys}.ts` 的探针为准（已注册适配器时不调用感知器），感知器负责“凭证来源”与 `observations()`，
    并导出 `checkCallerAndAuthorization / residualKeyFindings / classifyCallerArn` 供 role / keys 驱动的探针复用。
11. **ec2 感知器**在非 EC2 主机（开发机、CI）只报告 disk / memory（以及存在快照时的派生项），保证 L0 开发环境为 ok；`attach({ keyFingerprint, heartbeats })`
    为可选注入。快照路径 `<DATA_DIR>/security/snapshot.json`，备份记录 `<DATA_DIR>/backup/last-run.json`。
12. **database 探针**：只读副本不可达报 degraded（不是 error）；SQLite 数据卷剩余 < 15% 报 degraded（03#database 第 10 节）——在磁盘很满的开发机上，
    `test/http/app.test.ts` 中“database localHealth = ok”的断言会因此失败（本机磁盘剩余约 7%）。
13. **Lambda 错误分类**：`permanent === true`（image-core 的 PermanentImageError）与超过 MAX_BYTES 为永久错误；回调 404 / 410 视为照片已删除、不重试；
    其余（回调 5xx、网络、S3、render 意外错误）抛出。

### 4. 需要其他文件配合

- `container.ts`：`databaseProbe(db, cfg, { …, dbRead, aws })`（深度探针需要 `aws`）；可选 `(detectors.find(d => d.module === 'ec2') as Ec2Detector).attach({ keyFingerprint, heartbeats: () => labMetrics.heartbeatsSnapshot() })`。
- `http/routes/internal-hooks.ts`：`c.images.acceptCallback!(req.rawBody, { signature: req.get('X-CloudAlbum-Signature') ?? '', timestamp: req.get('X-CloudAlbum-Timestamp') ?? '' })`，
  再按结果写回（`applyImageResult / applyImageFailure`，或 `LambdaImageProcessor.applyWriteback()`）。
- `worker.ts`：`IMAGE_PROCESSOR=lambda` 时运行 `(c.images as LambdaImageProcessor).consumeResults({ signal })`（结果队列 + 失败队列）。
- `adapters/lock/redis.ts`、`lock/pg.ts` 仍是桩：redis 锁可复用 `RedisCache.redisClient()`（同一条连接与键前缀 `keyPrefix`）。
- `adapters/iam/role.ts`、`keys.ts`（provider() 未实现时所有 AWS 适配器都拿不到客户端）可复用 `detectors/iam.ts` 的辅助函数与 `ImdsClient`；
  `adapters/cdn/cloudfront.ts` 的 probe 可合并 `CdnDetector.stats()`。
- 依赖：Lambda 的 `CALLBACK_SECRET_ARN` 分支动态 import `@aws-sdk/client-secrets-manager`（Lambda 运行时自带，build.mjs 已 external；
  如需在 package.json 声明，加到 `lambdas/image-thumbnail` 的 dependencies `^3.900.0`）。可选：`@aws-sdk/lib-storage`（大对象流式上传）、
  `@aws-sdk/client-cloudwatch`（队列最老消息年龄）。

### 5. 如何运行

```bash
npx vitest run --project backend test/adapters/aws test/modules/detector-ec2.test.ts test/modules/detector-iam-cdn.test.ts test/modules/database-probe.test.ts
npx vitest run --project lambda-image-thumbnail
# 集成（Valkey 8、PostgreSQL 16）：npm run test:services:up 后
CLOUDALBUM_IT=1 npx vitest run --project backend test/adapters/aws/cache-redis.int.test.ts test/modules/database-probe.int.test.ts
# 端口可用 CLOUDALBUM_IT_REDIS_URL / CLOUDALBUM_IT_PG_URL 覆盖。S3 / SQS 用内存版（aws-sdk-client-mock）跑端口契约；未使用 LocalStack。
```

## frontend

`frontend/src/**`：相册的全部页面、capabilities 驱动的功能开关与徽章、请求级路径追踪、`/lab`、开发用模拟后端。

### 1. 文件

```
main.tsx  App.tsx                 入口（主题、Resource Timing 采集、仅 DEV 时安装模拟后端）与路由；/lab、/admin 按路由懒加载
styles/global.css  prefs.ts       亮 / 暗两套 token（:root、prefers-color-scheme、[data-theme]）；主题 / 徽章 / 追踪抽屉偏好（localStorage，try/catch）
api/client.ts                     唯一的 fetch 出口：Server-Timing、X-CloudAlbum-Path、请求 ID、X-CloudAlbum-Bypass → TraceStore；401 单飞刷新；旁路 / 实验头
api/endpoints.ts  api/social.ts   类型化端点；normPage / normPhoto / normCounters 统一后端各路由的写法；social 按 social-api.public.baseUrl 选址
api/types.ts                      前端使用的 JSON 形状（camelCase）
capabilities/                     CapabilitiesProvider（骨架屏、60 秒 + 焦点刷新、管理员 /lab 用 SSE）、useCapability、Feature、ModuleBadge、badges.ts、registry.ts
auth/                             AuthProvider → LocalAuthProvider | CognitoAuthProvider（React.lazy 单独成块；Amplify 再动态 import）、guards
upload/                           signedUrlUpload（F6）、prefixTokenUpload（F14 前缀令牌）、identityPoolUpload（STS，只留接口）、策略选择与轮询
trace/                            TraceStore、resourceTiming（cdn-* → HIT/MISS/RefreshHit）、PathChips、Waterfall、TraceDrawer（/lab/trace 全屏版）
pages/                            Feed、Album、Photo、Upload、Notifications、Share、MyOutbox、Login（含 forgot/reset）、Register（含 /verify）、admin/
lab/                              LabHome、ModuleCard、ModuleDetail、Results、Compare、AbRunner、SwitchHowTo、StatusTimeline
mock/                             浏览器内的 L0 模拟后端（fixtures.ts 的 L0 capabilities、server.ts、install.ts）；生产构建不含
test/  *.test.ts(x)               vitest + @testing-library/react（jsdom）；test/helpers.tsx 用模拟后端驱动 fetch
```

### 2. 接口约定（前端一侧）

- 路径以总纲 2.8 / 2.9 / 7.3 / 8.x、各组文档与**后端已有的路由代码**为准；文档没写死的形状由 `api/types.ts` 约定，同时兼容后端现有写法：
  分页游标 `nextCursor` 或 `next`；照片 `ownerName` 或 `owner.displayName`；计数 `{counters:{likes,comments}, likedByMe}` 或扁平；
  新评论 `{comment}` 或评论本身；分享打开 `{share:{expiresAt}, photo}` 或 `{photo, expiresAt}`。
- 社交路径跟随 `backend/src/http/routes/social.ts`：`GET /social/photos/:id`（计数）、`POST|DELETE /social/photos/:id/likes`、
  `GET|POST /social/photos/:id/comments`、`DELETE /social/photos/:id/comments/:commentId`、`POST /api/shares`、`GET /api/shares/:token`
  （04 组文档 social-api 一节写的是 `/counters`、`/like`、`/social/comments/:id`、`/social/shares`，二者需由后端 / 04 组统一；API Gateway 的路由表要与 Express 一致）。
- F6：`POST /api/photos` 同时发 `size` 与 `sizeBytes`；响应的 `upload` 或 `uploadTarget` 原样执行 PUT（URL + 头），前端没有驱动分支。
- F14（none 驱动）：`POST /api/uploads/session` 取令牌（多个文件共用）；每个文件 `POST /api/photos` 建档；后端没有返回 `rawKey` / `uploadId` 时，
  约定 `rawKey = <session.prefix><photoId>.<jpg|png|webp>`（与 image-core 的 `extensionFor` 一致）、`uploadId = photoId`；
  local：`PUT /api/storage/upload?key&uploadId&part` + `Authorization: CA-Upload <令牌>`，续传先查 `GET /api/storage/upload/parts`（数字数组或 `[{part,size}]`）；
  s3：每片先 `POST /api/uploads/parts:sign` 再 PUT（ETag 用于合并）；最后 `POST /api/photos/:id/complete {uploadId, parts}`。
- 认证（BFF）：`/api/auth/{register,confirm,resend,login,mfa/verify,mfa/enroll,refresh,logout,forgot,reset}`、`GET /api/auth/session?for=social`、`GET /api/me`；
  验证 / 重置链接是前端路由 `/verify?email&code`、`/reset?email&code`；managed 子模式跳 `GET /api/auth/login?returnTo=`。
- `/lab`：`GET /api/lab/results?full=1`（卡片的 before / after 差值需要结果 JSON）、`/api/lab/results/:runId`、`/api/capabilities/stream`（SSE）。

### 3. 设计有歧义时的取舍

1. **Cognito 与 aws-amplify**：02#auth 决定 (a) 为 BFF + HttpOnly Cookie，Amplify 只作 lab 选读；任务要求“Cognito 登录时动态 import aws-amplify”。
   折中：`CognitoAuthProvider` 本身经 `React.lazy` 单独成块（L0 首屏包没有任何 Cognito / Amplify 代码）；sdk 子模式仍用本站表单走 BFF，managed 跳转托管登录页；
   只有 `auth.public.loginMode = 'amplify'`（需要不带密钥的公开 App Client `publicClientId`）时才动态 `import('aws-amplify')` 与 `aws-amplify/auth`，
   令牌经 `Authorization: Bearer` 发给 API（后端认证中间件已支持 Bearer）。sdk / managed 由 `auth.public.loginMode` 区分，缺省按 sdk。
2. **注册表按需加载**：`@cloudalbum/contracts/registry`（约 110 KB）不进主包，由 `capabilities/registry.ts` 动态 import，与 `/api/capabilities` 并行请求。
3. **徽章选词**（`capabilities/badges.ts`，不为单个模块写分支）：off → 与驱动同名的键 → `selfHosted`（EC2 自建档）→ `local`；启用 → 与驱动同名的键 → `aws`；
   `variant`（storage 的 `upload` → `uploadLocal/uploadAws`，ec2 的 `footer`）优先；请求级 `bypass` 紫、`error-bypass|error-basic|error-fallback` 黄、`hit` 绿、
   `unknown` 灰虚线；模块状态 degraded / error 覆盖请求级结果（与 capabilities 一致）。registry 没有 badges 的模块退回“机能（本地实现 · 驱动）”/ awsService。
   占位符缺值时连同前面的分隔符去掉（例如 `{cacheState}`）；database 启用时 `{multiAz}` 取 `public|data.multiAz`，没有就显示“未知”（前端不猜）。
4. **CDN 角标**：图片的 Resource Timing 中有 `cdn-cache-hit|miss|refresh` → HIT / MISS / RefreshHit；有记录但没有依据（无 Timing-Allow-Origin 或没有 cdn-* 项）→ “状态未知”。
5. **路径追踪抽屉**：管理员默认可见；其他人 `?trace=1`（存为偏好，`?trace=0` 关闭）。浏览器侧耗时记到响应头为止；瀑布图的浏览器分阶段时间来自同 URL、起点相近的 Resource Timing 条目，
   服务端各段只有耗时没有起点，所以从服务端开始处画“耗时条”。
6. **A/B 运行器**（卡片按钮，仅管理员 + `lab.bypassEnabled` + 模块已启用 + 有旁路键）：只对无副作用的只读路由交替发送 A / B（cache、replica、cdn、tracing、analytics → `GET /api/feed`；
   kms → `GET /api/photos/<时间线第一张>`；identity-pool → `POST /api/uploads/session`）；queue / image / tagger 需要上传，提示改用 experiments 运行器。
7. **时间线范围**：后端 `GET /api/feed?scope=mine|public`；前端已登录默认“我的照片”，可切到“公开照片”；未登录看公开照片并显示登录入口（后端返回 401 时只显示欢迎卡片）。
8. **上传类型**：只接受 image-core 的 `ACCEPTED_TYPES`（JPEG / PNG / WebP）；上限由服务端按运行时 `maxUploadMb` 校验（capabilities 不下发运行时配置）。
9. **邮件预览**：`iframe sandbox="allow-popups allow-popups-to-escape-sandbox"` + `srcdoc`，CSP `default-src 'none'`；正文里的 http(s) 链接另外列出，
   本站链接（`/verify?…`）用路由在当前标签页打开。
10. **开发用模拟后端**（`src/mock`，只在 `import.meta.env.DEV` 时动态加载）：`?mock=all|auto|off` 或 `VITE_CLOUDALBUM_MOCK`；auto 先探测 `GET /api/health/live`，
    可达时只有 501（脚手架桩）与网络错误的接口改由模拟处理，不可达时全部模拟。种子账号与密码见 `mock/server.ts` 的 `seed()`（仅本机开发与测试使用）。
    没有用 MSW（未安装）；模拟只包装 `fetch`，所以模拟模式下上传 PUT 也改用 fetch。
11. **capabilities 刷新**：登录 / 登出后立即刷新（管理员与普通用户视图不同）；SSE 打开期间暂停 60 秒轮询，连接失败自动退回轮询。

### 4. 需要其他文件配合

- registry（scaffold）：identity-pool、social-store、network 等模块还没有 `lab.badges`，前端只能显示通用文案；02#identity-pool 第 11 节给了
  “应用自签令牌（EC2）/ STS 临时凭证”，04#social-api / 03#social-store 也有徽章表，建议补进 `modules/registry.yaml`。
- auth 实现者：`AuthPort.publicConfig()` 增加 `loginMode: 'sdk' | 'managed'`（前端据此决定是否跳托管登录页）；Amplify 变体另需 `publicClientId`。
- photos / social 实现者：与 04 组文档统一社交路径（见第 2 节）；`POST /api/photos` 如能直接返回 `rawKey` 与 F14 的 `uploadId` 最好（前端已有约定兜底）；
  `GET /api/photos/:id` 若带 `workflow`（执行 ID、重试次数）会显示在“处理流程”徽章上。
- 后端 `/api/me` 仍在 `routes/me.ts` 的桩后面（local-identity 小节已登记）；未接上之前前端按未登录处理。

### 5. 运行

```bash
npm run dev --workspace @cloudalbum/frontend          # :5173，代理 /api 等到 :3000；后端没起时自动全部模拟（?mock=off 关闭）
npm run build --workspace @cloudalbum/frontend        # tsc --noEmit + vite build（L0 主包不含 AWS / Amplify / 模拟后端代码）
npx vitest run --project frontend                     # 组件与流程测试
```

---

## local-media

L0 的照片全流程：签名直传 → 缩略图 → 标签 → 时间线 → 点赞评论分享 → 定时任务 → 点击流（以及本组端口的本地档）。

### 1. 文件

- `packages/image-core`：`render()`（sharp：limitInputPixels、`.rotate()`、thumb_200 / display_1080 WebP、主色取自最小衍生图）、`sniffImageType()`（魔数）、
  `readExif()`（exifr：拍摄时间、相机、GPS；GPS 只在 `RenderOutput.exif.location`，不进 ImageMeta、不进衍生图）、`makeTestImage()`、`selfTest()`。
- 适配器：`storage/local.ts`（含 F6 签名 `verifyUploadSignature / writeUpload`、媒体签名 `verifyMediaSignature`、F14 分片辅助 `LocalMultipartUpload`）、
  `image-processing/{inline,worker}.ts`、`queue/{sync,memory}.ts`、`tagging/none.ts`（`basicLabels()` 供 rekognition 复用）、`social-store/db.ts`、
  `scheduler/cron.ts`、`cache/{none,memory}.ts`、`analytics/db.ts`。
- 仓储：`repositories/{photos,social-db,job-runs,click-events}.ts`；服务：`services/{photo-pipeline,feed,media-url,share,report}.ts`；
  任务：`jobs/{index,handlers,schedule,notify,enqueue}.ts`；路由：`http/routes/{photos,uploads,media,social,internal-hooks}.ts`；`worker.ts`。
- 测试：`backend/test/adapters/{storage-local,cache,queue,tagging,social-store,analytics,scheduler}.test.ts`（每个端口一组可复用的契约函数
  `xxxContract(name, make)`）、`test/services/photo-pipeline.test.ts`、`test/jobs/jobs.test.ts`、`test/http/media-flow.test.ts`（完整容器 + supertest 的 L0 全流程）、
  `packages/image-core/test/render.test.ts`；辅助 `test/helpers/media-fixtures.ts`。

### 2. API（前端与实验脚本按此调用）

- `GET /api/feed?scope=mine|public&limit&cursor` → `{ scope, items: PhotoDto[], next? }`；`GET /api/photos?albumId=`（相册内）；`GET /api/search?tag=`、`GET /api/search/tags`。
- `POST /api/photos {contentType, filename?, size?, albumId?, visibility?, title?, caption?}` → 201 `{ photoId, rawKey, uploadId(=photoId), photo, uploadTarget, upload, maxBytes }`；
  没给 albumId 用默认相册，可见性默认取相册的可见性。
- `POST /api/photos/:id/complete` → inline 档 200（READY）；worker / lambda 档 202（PROCESSING）；重复调用幂等（`already: true`）。
  原图不在原图键上时先调 `DirectUploadPort.complete(photoId, principal)`（F14）；然后校验大小（`maxUploadMb`）与魔数，不合格删原图、FAILED、413 / 415。
- `GET /api/photos/:id`（主人另有 `urls.original`、`moderation`、`location`；均有 `workflow`、`storage.driver`）、`GET /api/photos/:id/pipeline`（job_runs 步骤）、
  `PATCH`、`DELETE`（审计 photo.delete）、`POST /api/photos/:id/moderation {action: block|unblock}`（管理员）。
- `PUT /api/storage/upload`（F6 签名 / F14 分片 + `Authorization: CA-Upload`）、`GET /api/storage/upload/parts?uploadId&key`、`POST /api/uploads/session`、
  `POST /api/uploads/parts:sign`（正则路由）、`GET /api/uploads/credentials`。
- `GET /media/<key>`；`GET|POST /api/reports/daily`、`GET /api/reports/daily/:day`（管理员；日报签名 URL / 立即生成）。
- `/social/health`、`/social/photos/:id`（计数）、`/social/photos/:id/likes`（POST / DELETE）、`/social/photos/:id/comments`（GET / POST）、
  `/social/photos/:id/comments/:commentId`（DELETE）、`/social/me/comments`；`POST /api/shares {photoId, ttlSec?}`、`GET /api/shares/:token`（410 = 不存在或过期）；
  `POST /api/events {events: [...≤50]}`（202）、`GET /api/events/report?from&to&groupBy`（管理员）、`GET /api/events/report/:queryId`。

### 3. 设计有歧义时的取舍

1. **写回统一在 PhotoPipeline**：inline / worker 适配器只渲染并写衍生图，返回 ImageResult；“状态只前进”的写回、打标签入队、通知都在
   `services/photo-pipeline.ts` 的 `handleImageOutcome()`（三种驱动共用；lambda 的回调路由与 worker 的 `consumeResults({apply})` 也调用它）。
   inline 档的永久错误抛 `ImageProcessingFailedError`（带 ImageFailure），因为端口的 `submit()` 没有失败分支。
2. **WorkflowPort(inline)**：`InlineWorkflow.start(photo)` 应直接 `return runInlinePipeline(pipelineDepsFromAdapter(this.deps), photo)`。
   该驱动仍是桩时，`completeUpload` 捕获 NotImplementedError 后直接运行进程内编排（只对“未实现”生效，不是运行时降级）。
3. **流水线步骤**：先写回 READY，再 `image.tag` → `decide`（block 且 `TAGGER_MODERATION_ACTION≠log` → BLOCKED）→ `notify`；每步一行 job_runs
   （`pipeline.thumbnail|tag|decide|notify`）。sync 队列下整条流水线在 complete 请求内完成。暂时性错误按 `WORKFLOW_LOCAL_MAX_ATTEMPTS` 指数退避；
   端口抛 HttpError（例如 lambda 档 503）时照片退回 UPLOADING、不重试。
4. **本地死信不建 failed_jobs 表**（迁移不归本组）：sync / memory 的失败任务写 `job_runs`（`name=queue.<任务名>`、`trigger=queue`、`detail={payload,attempts,source}`）；
   定时任务被跳过的触发另写一行（`scheduled_at` 为空，原计划时间在 `detail.scheduledAt`）。
5. **memory 队列在“入队的进程”内消费**：api 消费 api 入队的任务；worker 消费定时任务产生的任务（内存队列不能跨进程）。同一 dedupKey 排队中不重复入队；
   每个任务名的并发取 `QUEUE_CONCURRENCY`（未列出的取 `QUEUE_MEMORY_CONCURRENCY`；worker 档的 image.process 取 `IMAGE_WORKER_CONCURRENCY`）。
6. **cron 的计划时间**取 node-cron 的计划时刻（截到整秒），所以同一时刻的重复触发被 `(name, scheduled_at)` 唯一索引吸收（skipped-duplicate）；
   LockPort 未实现时退回进程内互斥（告警一次）。`SCHEDULER_CATCHUP` 用自带的 5 段 cron 匹配器回溯上一个计划时刻。锁名 `job-<任务名>`（Windows 文件名不能含冒号）。
7. **媒体输出**：经 Nginx（请求带回环来的 `X-CloudAlbum-Entry`）或 `NODE_ENV=production` 时返回 `X-Accel-Redirect`（`storage=local:accel`）；
   开发机直连时流式返回并支持 304（`storage=local:stream`，路径头词表新增值）。s3 驱动 302 到预签名 GET。
8. **私有媒体 URL** 的 `exp` 向上取整到 60 秒（同一分钟签出的 URL 相同，浏览器可缓存）；不回拨签名时间。签名 = HMAC(media-hmac-key, `GET\n<key>\n<exp>`)。
9. **超限上传**：流超过 max 时不再写盘但读完请求体（Nginx 已限 30 MB），这样客户端能收到 413 而不是连接重置；Content-Length 超限直接 413 不读。
10. **ipHash** = HMAC(HMAC(media-hmac-key, "analytics:ip-hash:v1"), IP) 的前 32 位十六进制；会话 ID 取请求头 `X-CloudAlbum-Session` / Cookie `ca_sid`，
    没有时由 IP + UA 派生。`POST /api/events` 只接受 1 天内、不超前 5 分钟的客户端时间。
11. **拍摄时间**：EXIF 没有时区（无 OffsetTimeOriginal）时按 UTC 解释；年份 / 季节标签按 UTC 月份（北半球）。基础标签另加 `camera:<品牌>`（EXIF 启发式）。
12. **拍摄地点**：渲染时读出的 GPS 经 CryptoPort 信封加密写 `photos.location_enc`（序列化 `ca1.<keyRef>.<edk>.<iv>.<ct>.<tag>`，rowId 进 AAD）；
    `CRYPTO_LOCAL_PLAINTEXT=on` 时写 `plain.<base64url>`；CryptoPort 未实现或失败时不保存位置。详情页解密失败返回 503 `CRYPTO_UNAVAILABLE`。
13. **通知**：本组事件经 `jobs/notify.ts` → `services/notifications.ts` 的 `notify()`（站内信 + notify.fanout）；`notify.fanout` handler 用它的 `fanout()`。
    事件 ID：`comment.created:<ULID>`、`like.created:<sha256 前 40 位>`、`photo.blocked:<photoId>`、`report.daily:<日期>`。
14. **分享链接**：不存在与过期都返回 410 `SHARE_GONE`（dynamodb 驱动 TTL 删除后也是“不存在”，两种驱动一致）；有效期夹紧到 [60 秒, 30 天]，默认 24 小时。
15. **评论删除**：只有作者本人能删（端口只有 byUserId）；管理员处理违规内容用照片的 moderation。
16. **日报**：`POST /api/reports/daily` 可立即生成（管理员）；SOCIAL_DRIVER=dynamodb 时点赞 / 评论数改由点击流近似。日报 CSV 为 `metric,value` 两列。
17. **缓存失效**：照片写操作对 `ver:{u:<owner>}`、`ver:{pub}`、`ver:{a:<album>}` 执行 incr，并删除相册列表键 `albums:v1:{owner,public}:<owner>`（与 albums 路由一致）。
18. **保留期**：outbox.retention 用 `deleteOutboxBefore()` 并删除 OUTBOX_DIR 内的 .eml 与早于保留期的日期目录，另删 7 天前的 processed_jobs；
    audit.retention 用 `deleteAuditBefore()`（截止时间多留 1 分钟）；lab.compact 调 `repositories/lab.ts` 的 `compactRollups(db, before)`，没有时跳过。

### 4. 需要其他文件配合

- `adapters/workflow/inline.ts`：`start()` 调 `runInlinePipeline(pipelineDepsFromAdapter(this.deps), photo)`；`describe()` 可用 `listSteps(db, photoId)`。
- `adapters/identity-pool/none.ts`：`authorizePart(token, key, uploadId, part)` 校验前缀与“属于本人、UPLOADING 的照片”，失败抛 `HttpError(403, 'UPLOAD_PREFIX_DENIED')`；
  GET parts 用 part=1 做授权检查；`complete(photoId)` 对 storage=local 调 `asLocalMultipart(storage).completeParts(uploadId, rawKey, {maxBytes})`
  （约定 uploadId = photoId），返回 `{ok, rawKey}`。
- `server.ts` 的 `startApiLoops`：`startJobConsumers(c, signal)`（`jobs/index.ts`；路由注册时的 `ensureJobs()` 已兜底）。
- `http/routes/admin.ts`：失败任务列表可读 `listQueueFailures()`（job_runs 的 queue.* 行）；`POST /api/admin/queue/drain` → `c.queue.drain(60)`。
- `repositories/lab.ts`：导出 `compactRollups(db, before: Date)`（lab.compact）。
- `observability/instrument.ts`：建议不把 `permanent: true` 或 4xx 的 HttpError 计入被动健康信号（目前删除别人评论的 403 等会累计到 social-store）；
  `consumeResults` 这类阻塞方法建议加入 `UNTIMED_METHODS`。
- `config/net.ts` 的 `isLoopback()`：`::ffff:127.0.0.1`（IPv4 映射地址）也应视为回环；否则监听 `::` 时 Nginx 传来的 `X-CloudAlbum-Entry` 不被信任。
- `backend/test/http/app.test.ts`：`POST /api/photos/abc/complete` 现在返回 401（不再是 501 桩）；database 探针在系统盘剩余 < 15% 的机器上为 degraded。

---

## experiments

总纲 §8.2 的实验框架（Node 22 + undici，不依赖 k6）与 8 个 MVP 模块的实验。只改 `experiments/**`；运行时只经 HTTP 访问 CloudAlbum，
实验机上不加载任何 `@aws-sdk/*`（ESLint 规则不允许 experiments 引入；需要云端操作的步骤用 AWS CLI 脚本或手工步骤，均由学员执行，测试中从不调用）。

### 1. 文件

- `_lib/`：`runner.ts`（`npm run exp`）、`collect.ts`（capabilities 断言、`/api/lab/runs`、`/api/lab/metrics` → 结果 `server` 段）、`report.ts`（`npm run exp:report`，
  Markdown + JSON，可选 HTML）、`login.ts`（`npm run exp:login`）、`http.ts`（实验头、A/B 旁路交替与限流、Server-Timing / 路径头解析）、`stats.ts`、`load.ts`、
  `metrics.ts`（指标键解析）、`faults.ts`、`app.ts`（上传三步、就绪轮询、登录）、`images.ts`、`probe.ts`（新建连接的分阶段计时）、`session.ts`、
  `scenario.ts`、`schema.ts`、`types.ts`、`util.ts`、`scenarios/{upload-burst,feed-read}.ts`、`leak-scan.sh`、`schema/{experiment,result}.schema.json`。
- 模块：`iam/ auth/ storage/ cdn/ database/ cache/ image-processing/ queue/`，各含 `experiment.json`、场景脚本、`faults/*.sh`、`README.md`。
- 测试：`test/mock-server.ts`（本地 mock CloudAlbum）+ `lib / manifest / report / runner / scenarios.test.ts`（每个 node 场景都对 mock 跑一次）。
  `tsconfig.json` 不编译 `test/`；`tsconfig.test.json`（`npm run typecheck -w @cloudalbum/experiments`）检查全部源码与测试。

### 2. 设计有歧义时的取舍

1. **experiment.json 是模块级清单** `{ module, default, experiments: [...] }`，每个元素即总纲 §8.2 示例的实验对象；也接受示例那样的单个对象。
   新增可选字段：`labels`、`params`（`--param` 的类型 / 范围）、`ab.bypass`、`pair`（报告缺省对比的两个标签）、`description`、`doc`；
   `scenario.tool` 取 `node | shell | manual`（`k6` 只为兼容示例保留在 schema 中，运行器拒绝）；`faults[]` 另支持 `api`（`POST /api/lab/faults`）、
   `manual`（到点提示人工操作）、`args`（可写 `{参数名}`）、`via`、`at: start|end`。
2. **实验 id 以 registry `lab.experiments` 为准**（scaffold 约定）。任务中的示例名对应：cdn `ttfb-compare` → `ttfb`；cache `bypass-ab` → `feed-read --ab`；
   queue `kill-worker` → `upload-burst` 在 after 标签第 30 秒的 `faults/kill-worker.sh`；image-processing `upload-burst-neighbor` → `neighbor`；
   auth `token-inspect` → `token-claims`；iam `credential-source` → `whoami`。必须在控制台或云端操作的实验写成 `manual`（README 给步骤）：
   cache `ttl-sweep`、queue `poison` / `dlq-replay`、image-processing `cold-start` / `throttle` / `cost`、database `conn-storm` / `pitr`、cdn `invalidation`。
   iam `leak-scan` / `imds-ssrf` 是 `shell` 场景（在实例上运行，stdout 最后一行 `EXP-RESULT:<json>`）。
3. **A/B 的方向**：A = 带 `X-Compare-Bypass`（相当于“没有该模块”），B = 不带（“有”），标签 `<label>:A` / `<label>:B`，使 A→B 与 before→after 的 expect 方向一致。
   服务端旁路限额（每管理员每分钟 120、每实例 4 在途）在客户端用令牌桶（≤110/分钟）+ 信号量主动限流。报告 `--pair after:A,after:B` 用 `client.byVariant`，
   服务端路由按路径签名中有无 `bypass=` 近似拆分。
4. **实验头只随管理员令牌发送**：没有注入管理员令牌的请求（登录、测试用户令牌、S3 预签名 PUT、CDN 媒体、Cognito）不带 `X-Experiment-*` / `X-Compare-Bypass`
   （否则后端 403），它们只进客户端统计。平台模式的“已登记 runId 免令牌归属”未实现。预热请求不带实验头、不计入结果。
5. **前置断言**：`requires[label]` 的键为 `<模块>.<字段>`（取 capabilities.modules）或根路径（`app.deployMode`）；值可为数组（任选其一）、`null`、`!x`（不等于）、`*`（非空）。
   `--label` 必须是 `requires` 的键；不匹配退出码 3；`--force` 时只有确实不匹配才记 `forced: true`。shell / 离线场景不校验（记警告）。
6. **结果 JSON**：在 §8.2 字段之外增加 `variant`、`requiresCheck`、`spec`（metrics / expect 快照）、`scenario.findings`、`repeats`、`warnings`、`runner`；
   客户端路由键统一为 `METHOD 路由模板`（`POST /api/photos/:id/complete`），指标解析器按“去掉方法与 :参数 段”宽松匹配总纲写法 `{route:/api/photos/complete}`。
   `server.business` 由场景在客户端计算（缩略图就绪时间 = 服务端 readyAt − createdAt、jobsLost = 排空时限内未就绪的照片、排空时间等）——后端没有 `lab_job_ledger` / 业务统计接口。
7. **主机指标**：`/api/lab/metrics` 的主机采样按时间窗（运行前后各放宽 60 秒）取；`host.cpu` = 同一 10 秒桶内 api + worker 的进程 CPU 之和；
   `netRxBytes` / `netTxBytes` = 同一实例累计计数器的首尾差；`eventLoopDelayP99` = api 进程各采样 p99 的最大值。
8. **报告**：文件名 `_reports/<module>/<UTC>__<实验>.{md,json,html}`（加实验 id 避免同秒冲突）；缺省格式 md,json；HTML 为可选（内联 SVG 条形图）。
   噪声带 = max(`--noise`（默认 10%）× 两者较大值, 多轮区间的一半, 毫秒类指标 1 ms)。同一指标的不同写法在报告中去重。
9. **令牌**：`--token` > `CLOUDALBUM_ADMIN_TOKEN` > `.cloudalbum/experiments/admin-token.json`（`exp:login` 写入，0600，按目标区分）> 用
   `CLOUDALBUM_ADMIN_EMAIL` / `CLOUDALBUM_ADMIN_PASSWORD` 现场登录。令牌不写入结果、不打印；`exp:login` 不接受命令行密码（只读环境变量或 `--password-stdin`）。
10. **故障投递**：缺省按 `--ssh` > 实例 ID（ssm，经 AWS CLI `ssm send-command`）> Linux 上本地执行 > 跳过（Windows 开发机）；需要部署者凭证的故障
    （`rds-failover.sh`、`revoke-sg.sh`）声明 `via: local`，在运维机执行。到测量结束仍未触发的故障记为 skipped。
11. **cognito 登录**：auth 实验用 User Pool 的公开 JSON 接口 `InitiateAuth`（USER_PASSWORD_AUTH，无需凭证与 SDK）模拟浏览器登录；App Client 只允许 SRP 时不可用（README 说明）。
12. **cdn ttfb** 用 node:http(s) 新建连接并记录 DNS / TCP / TLS / 首字节（只有 HTTP/1.1；h2 / h3 对比在浏览器 /lab 做）。
13. **清理**：先请求 `cleanup`（`DELETE /api/lab/runs/{runId}/photos`），失败（目前 501）时逐个删除场景登记的资源（照片、相册）；`--keep` 跳过。
14. 平台模式（ATL）的 `--on lab`、`~/.atl/session.json` 上传、`CA-Lab` 令牌未实现（不在 MVP 范围）；`--label` 已支持任意变体标签。

### 3. 需要其他文件配合

场景调用了下列尚未实现的接口（目前返回 501 / 404，场景记录 `endpointAvailable=false` 或注记后结束）。响应形状是本组的约定，实现者请按此提供：

- `DELETE /api/lab/runs/:runId/photos`（清理本次运行上传的照片；实验头已标出归属）。
- iam：`GET /api/lab/iam/whoami` → `{ arn, accessKeyPrefix, expiration, source }`；`GET /api/lab/aws-ping` → `{ sts: { ok, error? }, iam: { ok, error? } }`；
  `POST /api/lab/iam/refresh`（`forceRefresh()`）。capabilities 的 `modules.iam.data` 带 `arn` / `accessKeyPrefix` / `expiration` 时 whoami 也能用。
- storage：`POST /api/lab/storage/upload-target?driver=local|s3`（body `{contentType,size}`）→ `{ uploadTarget }`（lab/ 命名空间）。
- database：`POST /api/lab/db/read-after-write` → `{ visible: boolean, lagMs?: number }`。
- cdn：`GET /api/lab/now`（private, no-store）与 `GET /api/public/now`（`s-maxage=10`）→ `{ now }`；capabilities 的 `modules.cdn.public.baseUrl` 与
  `modules.cdn.data.originDirectUrl`（缺省时用 `--param cdn= / direct=`）。
- 根 `package.json`（可选）：`"exp": "npm run exp -w @cloudalbum/experiments --"`、`"exp:report": "npm run exp:report -w @cloudalbum/experiments --"`，
  让总纲里的 `npm run exp -- <module> …` 在仓库根目录也能用（现在需在 `experiments/` 下或加 `-w`）。

### 4. 如何运行

```bash
npm run build                                            # 运行器经 node_modules 使用 @cloudalbum/contracts 的 dist
cd experiments && npm run exp -- cache --list
npm run exp -- queue --label before --scenario upload-burst --fault-via ssh --ssh ec2-user@<EIP>
npm run exp:report -- queue
npx vitest run --project experiments                     # mock 服务器上的全部测试（约 10 秒）
npm run typecheck -w @cloudalbum/experiments
```

---

## infra

ec2 基础栈与 8 个 MVP 模块的 CloudFormation 模板、L0 引导脚本与主机文件（Nginx / systemd / logrotate / 辅助脚本）、`scripts/module` 工具（TypeScript）与档位文件。全部 AWS 调用都经一个网关，`--dry-run` 时只打印、不执行（包括只读调用），本机不需要凭证。

### 1. 文件

- `infra/modules/`：`ec2.yaml`（00-ec2-base.md 6.2 的 29 个参数 + `PlatformMode` = 30 个；独立数据卷、EIP、安全组的条件化入站规则、`InstanceA/B` 两个槽位、`CreationPolicy`、User Data 引导段、`Rules`）、`iam.yaml`、`storage.yaml`、`cdn.yaml`、`auth.yaml`、`queue.yaml`、`image-processing.yaml`、`cache.yaml`、`database.yaml`、`toolchain.yaml`（工具链栈，不是应用模块）；模块主机产物 `cdn/nginx/cdn-origin.conf.tpl`、`cdn/host-setup.sh`、`image-processing/systemd/50-image-processing.conf`。
- `infra/userdata/l0-bootstrap.sh`（00 6.5 合并骨架的完整实现）、`infra/install-host-files.sh`、`infra/nginx/`（nginx.conf、cloudalbum.conf、locations、proxy、upstream、`cloudalbum.d/00-entry.conf` 与三个槽位、`cloudalbum.server.d/00-acme-challenge.conf`、vpc-cidr 占位、`_ca_errors/upstream.html`）、`infra/systemd/`（api、api@、worker、4 组 timer、denylist path、nginx 加固 drop-in、journald 上限）、`infra/logrotate/cloudalbum`、`infra/host/`（render-fail2ban、render-vpc-cidr、security-snapshot、vuln-scan、healthcheck、denylist-apply / denylist-edit、nginx-reload、run-hostsetup、`cloudalbum-{postattach,predetach,runtime}`、sshd 加固片段、fail2ban 过滤器 / 动作 / jail 模板）、`infra/defaults/{runtime.json,alerts.yaml}`。
- `scripts/module`（Bash 包装 → `scripts/module-cli/dist/index.js`，未构建时用 tsx）、`scripts/module-cli/src/*`（index、context、aws、stack、outputs、deps、plan、ops、hooks、injects、base-params、policy、deliver、health、package、profiles、profile-cmd、status、bootstrap、meta、state…）、`scripts/teardown`、`scripts/release`、`scripts/local-backup.sh`、`scripts/selfhost/{postgres,valkey,pgbouncer}.sh`。
- `profiles/l0-ec2.env`、`profiles/single/{iam,storage,cdn,auth,queue,image-processing,cache,database}.env`（`scripts/module profile gen-single --all` 生成；测试保证提交的文件与生成器一致）。

### 2. 如何运行

```bash
npm run build -w @cloudalbum/module-cli          # 或 npx tsc -b scripts/module-cli
npx vitest run --project module-cli               # 输出 -> env、依赖规划、模板约定、baseParams / injects、dry-run 流程、档位
scripts/module --dry-run enable storage --with-deps    # 打印 iam -> 基础栈 InstanceProfileName -> storage 的全部调用与投递脚本
scripts/module --dry-run enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR=198.51.100.7/32
scripts/module --dry-run plan queue --single | profile diff single/queue | status
scripts/module nginx-internal-endpoints [--write]   # cloudalbum_locations.conf 的内部端点块与 registry 一致
scripts/release <version> --arch arm64              # 发布包（含 modules/registry.json、hostsetup-order.txt），打印 AppArchiveSha256
pip install cfn-lint && cfn-lint infra/modules/*.yaml   # 0 个错误 / 警告（两处 W1030 / W1011 以资源级 Metadata 说明理由后忽略）
```

主机脚本已在 `amazonlinux:2023` 容器中实测（nginx 1.30：install-host-files.sh → `nginx -t`；denylist 校验与 last-good 恢复；`run-hostsetup.sh cdn apply/revert`、`--all`；坏片段回滚；security-snapshot / vuln-scan / runtime / healthcheck；systemctl 用桩代替）。

### 3. 设计有歧义时的取舍

1. **iam 栈不输出 `PolicyArn`**：总纲 9.1“iam 栈自身只输出 Info*：它创建的角色在自己的定义中引用同栈的只读基础策略”优先于 02#iam 第 2 节。只读策略 `cloudalbum-<env>-iam` 由 `CloudAlbumAppRole`（与 keys 模式的演示用户）的 `ManagedPolicyArns` 直接引用；`AppRoleMode=existing`（平台模式）时用策略的 `Roles` 附加到已有角色。策略资源 ARN 用拼接字符串，避免角色 ↔ 策略循环依赖。
2. **auth 模板**：SPA 客户端为公有客户端（`GenerateSecret=false`，与 `## aws-adapters` 取舍 1 一致）；OAuth（授权码 + PKCE）只配置 https 入口——`scripts/module` 从 `AppOrigins` 中过滤出 https 源，L0 的 `http://<EIP>` 不能做回调（Cognito 要求 https），此时只有 sdk 子模式。`AUTH_MIGRATION=lazy`（VPC 内 User Migration 触发器 + `/internal/legacy-auth`）不在本轮，CLI 拒绝。触发器（F3 / F4）用 `Code.ZipFile` 内联、CommonJS。
3. **Lambda 代码包**：不用 `aws cloudformation package` 改写模板，而是由 CLI 构建（`npm run build -w lambda` + linux-arm64 sharp）、自写的最小 zip、按 sha256 内容寻址上传到工具链桶 `lambda/image-thumbnail/<sha256>.zip`，模板参数 `CodeS3Bucket` / `CodeS3Key`。效果等价，且同一代码不会重复部署。
4. **cdn**：源站只实现 `ec2` / `alb`（`vpc-origin` 需要 network(private)，不在本轮）；`CDN_SIGNED_MEDIA=on` 拒绝。`CDN_DIRECT_ACCESS`、`CDN_ADMIN_CIDR`、`CDN_ORIGIN_DIRECT_URL` 不是栈输出，由 `--set` / 默认值写进 cdn.env（registry baseParams 从 env 读取）；额外输出 `EnvCdnOriginPort` 供 8080 片段渲染。`OriginVerifySecret` 复用 secrets.env 中已有的 `ORIGIN_VERIFY`，没有时现场生成。
5. **database**：`ClientSecurityGroupIds` 最多支持 2 个来源（CloudFormation 没有循环）；参数组固定 `postgres16`，`EngineVersion` 约束为 16.x。只读副本 `DeletionPolicy: Delete`（没有独有数据）。RDS CA 包由投递脚本下载到 `/etc/cloudalbum/rds-ca.pem`。
6. **image-processing**：未指定 `IMAGE_RESULT_CHANNEL` 时，若 cdn 已启用自动选 `queue`（DEP-020）并打印原因；失败队列策略里的规则 ARN 用拼接字符串（规则名固定），避免循环。cache 的 `AuthToken` 用 `--param AuthToken=generate` 现场生成并写 `REDIS_AUTH_TOKEN`。
7. **drop-in 白名单**：在 00 6.8 的允许指令外增加 `CPUWeight`、`Nice`、`MemoryMax`、`MemoryHigh`（04#image-processing 的 worker 隔离 drop-in 需要）。drop-in 文件首行 `# units: worker` 指定投放到哪些单元（缺省 api + worker；api 的同时复制到 `cloudalbum-api@.service.d/`）。Nginx 片段模板首行 `# target: server` 投放到 `cloudalbum.server.d/`（缺省 `cloudalbum.d/`），`# defaults: K=V` 为 env 中缺失的占位符给缺省值；只替换 `${已知键}`。
8. **重放顺序**：`run-hostsetup.sh --all` 按发布包中的 `modules/hostsetup-order.txt` 执行，它由 `scripts/module release-meta` 从 registry 计算（requires 中的模块 id 与“另一模块开关变量”的 `=` / `!=` 都算依赖边、凭证 required → iam、再加 orderBefore；平手时 ec2、iam 优先，其余按注册表顺序）。
9. **Nginx**：`00-entry.conf` 同时包含平台修订 PM-18～20 的 map（`$ca_log_args`、`$ca_log_run`、`$ca_probe`、`$ca_https_redirect`、`$ca_frame_csp`，两种模式都生效），访问日志在原字段后追加 4 个字段；`cloudalbum_proxy.conf` 加 `X-CloudAlbum-Entry`（脚手架要求）与 `X-CA-Received-XFF`。`http2 on` 在 nginx < 1.25.1 时由 install-host-files.sh 改写为 `listen … http2`。内部端点的 `location =` 写在 `cloudalbum_locations.conf` 的 BEGIN / END 标记之间，由 `scripts/module nginx-internal-endpoints --write` 从 registry 生成（测试校验一致；“构建期生成”改为“生成后提交”）。`/_ca/nginx-health` 同时允许 `::1`。
10. **reload 结果**：`nginx-reload.sh` / `denylist-apply.sh` 把结果写进 `security/nginx-state.json`（`lastReloadAt`、`lastReloadOk`、`denylistRejectedLines`，另加持久的 `lastRejectedAt` / `lastRejectedLines`，避免恢复 last-good 后证据立即消失），`security-snapshot.sh` 并入 `snapshot.json` 的 `host.nginx`；快照另加 `host.timers`（各 timer 最近 / 下次触发）与 `fail2ban.httpBanaction`。
11. **logrotate**：全部 `copytruncate`、以 root 运行（日志目录 0750 无组写，logrotate 不要求 `su`；pino 与 Nginx 都以 O_APPEND 打开）。
12. **state.json**（v1，`.cloudalbum/state.json`，不含任何机密值）：env、region、base（实例、EIP、DNS、安全组、默认 VPC 子网、基础栈参数）、delivery、toolchain、iam 模式、baseConfig、modules（tier / 值 / modules.d 内容 / Outputs / 非机密栈参数 / 本模块写入的 secrets.env 键）、attachments、baseParams（原值与贡献方）、outOfBand、history。`--dry-run` 从不写 state.json，但同一次调用中后面的步骤会在内存中看到前面步骤的效果（例如 `--with-deps` 先启用 iam 后，storage 的 PolicyArn 附加到 `CloudAlbumAppRole`）。
13. **计划校验在运维机本地运行**：总纲写“在实例上运行 check-config --plan”；这里把“启用后的 env 集合”暂存到临时目录（尚未产生的输出用能通过 zod 的占位值；字面量输出与 `!Ref` 参数默认值直接使用），用仓库里同一份 `backend/dist/cli.js check-config --plan --json` 求值，部署前就能给出规则结论。实例上第 8 步仍会对真实值再跑一次 `check-config`，失败则恢复 `.bak`（退出码 2）。
14. **投递通道**：ssh（脚本经 stdin 交给 `sudo bash -s`，机密不出现在命令行）。SSM Run Command 会在命令历史中保留参数，所以携带或读回机密的脚本在 SSM 通道上被拒绝（shell-access 不在本轮；以后可经 secrets 模块解决）。
15. **健康探针**：在实例上执行 `cli.js probe <id> --deep --json`（与 `/api/capabilities?deep=1` 管理员视图同一探针，不需要管理员令牌），先等 `/api/health/ready`（60 秒），再等模块 `ok|degraded`（120 秒）；失败则恢复 `.bak`、重启，退出码 5，栈保留。disable 后要求 `off` 且 `localHealth=ok`。
16. **部署范围规则**：DEP-014（cdn 的 ec2 源站要求基础栈 `AssociateEip=true`）与 MUTEX-004（storage 模板的桶通知只允许 `EventBridgeConfiguration`）在 `scripts/module` 中检查；DEP-016 / DEP-037 属于 network / ami（不在本轮）。`rules.ts` 的 `deployCheck()` 桩保持不变（不是本组文件）。
17. **未实现（打印提示或 exit 2）**：托管策略超配额的打包模式（超配额时 exit 2，提示申请提额）、`disable --purge` / `teardown --purge-data`、`base set`、`rebuild-instance` / `replaceInstance()`、平台模式（`--platform`）。ec2 preflight 中：`ec2-ssh-cidr`、`ec2-public-ipv4-at-boot` 在 `base deploy` 中实现；`ec2-replacement-staged` 由 baseParams 合并拒绝替换类参数实现；`ec2-ami-pin` 由首次部署把 AMI 固定到 `/cloudalbum/<env>/ec2/image-id` 落实。
18. **单模块档位**：registry 没有 `singleLocalSettings` 字段，10.4 规则 3 的本地档调整（queue → `IMAGE_PROCESSOR=worker`）写在 `deps.ts` 的 `SINGLE_LOCAL_SETTINGS`，档位文件用 `PROFILE_LOCAL_SETTINGS` 表达（`PROFILE_DRIVERS` 中某个未列入 `PROFILE_MODULES` 的模块取本地档 / 自建值时同样按本地档处理）。`toolchain` 前置由 bootstrap 自动满足，不写进 `PROFILE_PREREQUISITES`。
19. **自建本地档**：PostgreSQL 16 数据目录放在数据卷 `/var/lib/cloudalbum/pgsql`（随数据卷保留；postgres 用户加入 cloudalbum 组以穿越 0750 的卷根），只监听回环、scram-sha-256，密码取 secrets.env 的 `DB_PASSWORD`；Valkey（旧 AL2023 退回 redis6）不持久化、带内存上限；PgBouncer 单元名 `cloudalbum-pgbouncer`，userlist 渲染到 `/run`。
20. **local-backup.sh**：sqlite `.backup` + `PRAGMA integrity_check` + gzip；回环 PostgreSQL 用 `pg_dump -Fc`；RDS 跳过（托管备份 / PITR）；上传清单；保留 7 天；结果写 `backup/last-run.json`。
21. **ec2.yaml 细节**：安全组不设 `GroupName`（只打 Name 标签，避免同 VPC 内替换时重名）；`AdminIngressCidr` 默认空导致的 W1030、NoEcho 参数的 W1011 以资源级 `Metadata.cfn-lint` 忽略并写明理由；User Data 中不出现任何机密与部署后会变化的值，EIP 地址在实例之前分配（不导致 User Data 变化）。
22. **数据迁移**：`enable` 对声明了 `migration: scripts/migrate/…` 的模块默认在只读窗口内调用实例上的 `cli.js migrate-module <id> up` + `verify`（`--no-migrate` 跳过）。

### 4. 需要其他文件配合

- `scripts/migrate/**` 与 backend `cli.js migrate-module`（目前是桩）：在它们实现之前，`enable storage|database|auth` 需要加 `--no-migrate`，否则第 6 步以退出码 4 停止（env 不写、栈保留）。
- backend `cli.js probe <id> --deep --json` 的输出形状（`status`、`localHealth`、`detail`）被 `scripts/module-cli/src/health.ts` 解析。
- `experiments/ec2/smoke.ts`：`base deploy` / `profile apply l0-ec2` 结束时打印 `npm run exp -- ec2 --scenario smoke --label l0`，未自动执行。
- 平台模式文件 `infra/host/install-atl-bundle.sh` 不在本轮：`l0-bootstrap.sh` 只在它存在时调用。`scripts/deploy`（发布新版本）不在本轮。
- `rules.ts`：DEP-014、MUTEX-004 的部署范围检查已由 `scripts/module` 实现，`deployCheck()` 可继续保持桩或改为文档引用。

---

## integration

集成与本地自测：把六个实现者的提交接到一起，补齐没有人认领的桩，固化三套端到端自测脚本（`npm run smoke:l0 / smoke:selfhost / smoke:localstack`）。
全程没有调用真实 AWS API、没有部署任何东西；只用单元测试、aws-sdk-client-mock、cfn-lint 与本机 Docker。

### 1. 补齐与修复（按文件）

- **依赖**：各摘要都写“无缺少的依赖”；按 aws-adapters 的建议在 `lambdas/image-thumbnail/package.json` 声明 `@aws-sdk/client-secrets-manager ^3.900.0`
  （`npm install --before=2026-09-29`，lockfile 只多一行，版本与 backend 已装的 3.1142.0 相同）。
- **没有人认领的桩驱动**（scaffold 第 3 节分给“L0 本地实现者 / 模块实现者”，但各自的提交里都没有）：
  - `adapters/iam/none.ts`（provider() = null，探针 ok）、`role.ts`（`fromInstanceMetadata` + memoize，过期前 5 分钟刷新、`forceRefresh()`）、
    `keys.ts`（secrets.env 的 `IAM_KEYS_*` 静态 provider），探针复用 `modules/detectors/iam.ts`（新增 `adapters/iam/shared.ts`）；
  - `adapters/cdn/direct.ts`、`cloudfront.ts`（mediaUrl 按可见性 / 媒体源站改写、DEP-028 时不改写、CreateInvalidation、经 CDN 的 `/api/health/live` 边缘探针
    + 合并 cdn 感知器的被动统计与 GetDistribution）；
  - `adapters/identity-pool/none.ts`（F14 前缀令牌：HMAC 签名、前缀 / 照片归属 / UPLOADING 校验、local 合并 `.incoming/<photoId>/`、s3 代建分片上传并逐片预签名）；
  - `adapters/waf/nginx.ts`（denylist.conf 读写，格式与 `infra/host/denylist-apply.sh` 的逐行校验一致）、`autoscaling/single.ts`（EC2 上 IMDSv2，开发机主机名 + `az=local`）、
    `workflow/inline.ts`（`start()` = `runInlinePipeline`，`describe()` 读 job_runs）、`lock/pg.ts`（会话级 advisory lock）、`lock/redis.ts`（SET NX PX + 带令牌释放）。
- **路由**：`me.ts`（`GET /api/me` + `registerSelfOutbox`）、`jwks.ts`；新增 `lab-modules.ts`（experiments 约定的侧路端点：`/api/public/now`、`/api/lab/now`、
  `/api/lab/iam/whoami|refresh`、`/api/lab/aws-ping`、`/api/lab/db/read-after-write`、`/api/lab/storage/upload-target`）；`app.ts` 的旁路审计改为 `auditBypass(c)`。
- **进程与容器**：`server.ts` 的 `startApiLoops`（bind + 登记定时任务 + memory 消费者）；`cli.ts` 实现 `job run <name>` 与 `lab:compact`；
  `repositories/lab.ts` 新增 `compactRollups()`；`container.ts`：`AWS_ENDPOINT_URL`、database 深度探针传 `aws`、ec2 感知器的密钥指纹检查项、
  `workflow.attachPipeline()`（inline 编排拿到完整的 PipelineDeps，含 X-Compare-Bypass: image 的 inline 处理器）、`cdn.attachDetector()`、cdn 的 `public.baseUrl`、
  关闭时释放 images / iam 的客户端。
- **其他实现者登记的配合项**：`instrument.ts` 不把 4xx / permanent / 对象不存在计入被动健康信号，`consumeResults`、`redisClient` 等不计时；`config/net.ts` 把
  `::ffff:127.0.0.1` 视为回环；cognito 的 `publicConfig()` 增加 `loginMode`（sdk → `amplify`，managed → `managed`）与 `publicClientId`（前端据此动态 import aws-amplify）。
- **缺陷修复**：
  - `config/validate.ts`：只有 CFG-001（未实现的驱动）时规则引擎也照常运行，`DEPLOY_MODE=asg` + SQLite 会同时报 CFG-001 与 ASG-002（以前只报前者）；
  - `logging/file.ts`：同一行 JSON 中 `role` / `pid` 出现两次；
  - `scripts/module-cli/src/template.ts`：`staticOutputValue()` 能求值“条件只依赖参数”的 `!If`——以前 `--dry-run enable auth` / `enable cache` 的计划校验把
    `EnvCognitoTriggers`、`EnvRedisClientMode` 写成占位符，zod 枚举校验失败、以退出码 2 中止；
  - 测试：`app.test.ts`（photos 已实现 → 401；database 断言跟随本机磁盘水位）、`jobs.test.ts`（lab.compact 不再跳过）、cognito publicConfig；
    根 `vitest.config.ts` 在 `CLOUDALBUM_IT=1` 时按文件串行（多个 `*.int.test.ts` 共用一个 PostgreSQL 库并各自 `drop schema public`，并行时互相删表；
    `fileParallelism` 只在根配置生效）。
- **新增测试**：`test/adapters/integration-drivers.test.ts`（上面的驱动，AWS 调用全部 mock）、`locks.int.test.ts`（PostgreSQL 16 / Valkey 8）、
  `test/http/lab-modules.test.ts`、`test/repositories/lab-compact.test.ts`、module-cli 的 `staticOutputValue` 用例。
- **根 package.json**：`smoke:l0`、`smoke:selfhost`、`smoke:localstack`，以及 experiments 小节建议的 `exp` / `exp:report` 转发。

### 2. 如何在本机运行

```bash
npm install && npm run build                      # 自测脚本使用构建产物（backend/dist）
npm run lint && npm test                          # 单元测试
docker compose -f docker-compose.test.yml up -d --pull never postgres valkey   # 只用本机已有镜像（test:services:up 会尝试拉 localstack）
CLOUDALBUM_IT=1 npm test                          # 集成测试（PostgreSQL 16、Valkey 8；按文件串行）

npm run smoke:l0          # L0 默认 + worker/memory + cache=memory 三档全流程，外加规则引擎 7 个不合法组合（退出码 78）
npm run smoke:selfhost    # Docker 起 postgres:16 + valkey:8（--pull never），DB_DRIVER=postgres + CACHE_DRIVER=redis 再跑一遍
npm run smoke:localstack  # storage=s3 + queue=sqs + iam=keys + worker：有 localstack 镜像就用 LocalStack，否则 MinIO + minicloud
#   通用参数：--keep 保留 .cloudalbum/smoke/<档位>-<时间>/（配置、数据、api.log / worker.log）；l0.mjs 另有 --only l0,worker-memory,cache-memory,rules
#   结果 JSON：.cloudalbum/smoke/last-{l0,selfhost,localstack}.json

cfn-lint infra/modules/*.yaml                     # pip install cfn-lint（本轮用 1.57.2）
AWS_EC2_METADATA_DISABLED=true scripts/module --dry-run -y bootstrap
AWS_EC2_METADATA_DISABLED=true scripts/module --dry-run -y enable <id> --with-deps [--no-migrate]
```

自测脚本（`scripts/smoke/`）：`lib.mjs`（配置目录与 EC2 同构：cloudalbum.env + modules.d/*.env + secrets.env + ES256 密钥 + runtime.json；子进程去掉全部 `AWS_*`）、
`flow.mjs`（全流程）、`f14.mjs`、`rules.mjs`、`run.mjs`（起 api + worker → 跑流程 → 扫 error 级日志 → 停）、`minicloud.mjs`、三个入口。流程中的“真实 JPEG”由 sharp
生成（1600×1200，渐变 + 噪点 + EXIF）。开发机直连 Node、没有 Nginx：路径头 `entry=direct`，媒体由 Node 流式返回。

### 3. 自测结果（2026-10-13，Windows 11 / Node 22.14.0 / Docker 28.3.2）

| 自测 | 命令 | 结果 |
|---|---|---|
| 构建 / 检查 / 单元测试 | `npm run build`、`npm run lint`、`npm test` | 通过；0 个 lint 问题；68 个文件 860 个测试全部通过 |
| 集成测试 | `CLOUDALBUM_IT=1 npm test` | 73 个文件 889 个测试全部通过 |
| 前端 / Lambda 构建 | `npm run build -w @cloudalbum/frontend`、`npm run build:lambdas` | 通过 |
| L0 + 两个本地档 + 规则 | `npm run smoke:l0` | 85 / 85 通过。每档：注册 → outbox 验证 → 登录 → 相册 → F6 直传真实 JPEG → 缩略图（200 宽 WebP）→ 时间线 → 用户 B 点赞评论 → A 收到通知 → 分享链接（含 410）→ 日报（立即生成 + 定时任务手动触发）→ capabilities 驱动 / 状态 → 路径头与 Server-Timing → 旁路只对管理员生效 → audit_log + 哈希链 → self-check 不加载 AWS SDK；L0 另跑 F14 分片续传；规则 13 步 |
| 自建档 | `npm run smoke:selfhost` | 31 / 31 通过（PostgreSQL 16.14 + Valkey 8.1.4；路径头 `database=postgres@local`、`cache=redis@local:hit/bypass`；LockPort = pg，scope=cluster） |
| S3 直传 + SQS 消费 | `npm run smoke:localstack` | 30 / 30 通过（MinIO + minicloud：预签名 PUT 直传、image.process 经 SQS 由 worker 进程消费、DeleteMessageBatch、主队列 / DLQ 清空、F14 经 parts:sign 直传 S3） |
| 规则引擎 | 包含在 `smoke:l0`（`--only rules`） | lambda + local 存储 → DEP-003；asg + SQLite → ASG-002（+ CFG-001）；queue=sqs / storage=s3 而 IAM_CREDENTIALS=none → CRED-001；未实现驱动 → CFG-001；modules.d 混入别的模块的键 → CFG-002；半启用 → CFG-004。check-config 与 api / worker 进程都以 78 退出，报告带规则 ID 与修复提示 |
| cfn-lint | `cfn-lint infra/modules/*.yaml`（1.57.2） | 10 个模板 0 个发现 |
| scripts/module | `--dry-run bootstrap`、`--dry-run enable <8 个模块> --with-deps` | 全部退出 0；计划校验均 OK（cdn / auth / cache / database 各 1 个警告）；没有写 `.cloudalbum/state.json` |
| 前端 × 真实后端 | Vite dev（`?mock=off`）→ L0 后端，浏览器窗格 | 注册 → /me/outbox 预览 → 验证链接 → 时间线 / 照片详情（徽章、标签、EXIF）→ 点赞、评论、生成分享链接 → /lab 卡片，均正常 |

### 4. 设计有歧义时的取舍

1. **`AWS_ENDPOINT_URL`（新增核心键，可选 URL）**：只用于开发机上的 LocalStack / MinIO 自测，覆盖全部 SDK 客户端端点并让 S3 用路径风格；EC2 上留空，
   `NODE_ENV=production` 下设置时容器告警。没有拆成按服务的端点键（与 LocalStack 的单端点一致）。
2. **LocalStack 不可用时的替身**：本机没有 `localstack/localstack` 镜像，下载镜像需要人工同意，所以没有拉取；`smoke:localstack` 自动改用本机已有的 MinIO（S3 兼容）+
   `scripts/smoke/minicloud.mjs`（同一端点上实现 SQS JSON 协议的收发 / 删除 / 可见性 / redrive、STS GetCallerIdentity、IAM GetUser，其余请求原样转发给 MinIO）。
   有 LocalStack 镜像时脚本走 docker-compose 的 localstack 服务（`--emulator localstack`；这条路径本轮没有实际运行过）。
3. **iam=none 的 provider()** 返回 null（总纲 4.2），不按 02#iam 第 1 节抛出 `AwsCredentialsUnavailable`；拒绝创建客户端的断言在 `adapters/aws/clients.ts`。
4. **Cognito 登录方式的对齐**：后端 `flows = null`（aws-adapters 取舍 1），而前端 `sdk` 模式走 BFF 表单。integration 把 cognito 的 `publicConfig().loginMode` 设为
   `amplify`（`COGNITO_LOGIN_MODE=sdk`）或 `managed`，并下发 `publicClientId`（SPA 客户端无密钥），前端据此动态 import aws-amplify。
5. **F14 + storage=s3**：约定 uploadId = photoId，S3 的 UploadId 记在 api 进程内存中（单实例；多实例时 F14 应由 identity-pool=cognito 承担）；`jti` 黑名单未实现（令牌 15 分钟过期）。
6. **PgLock** 用会话级 `pg_try_advisory_lock`，持有期间占用连接池的一条连接；`ttlSec` 到期自动释放（保险），进程崩溃时会话结束即释放。
7. **`/api/lab/storage/upload-target`** 只为当前驱动签发（另一驱动返回 409）：local 与 s3 并排对比需要两套部署。`DELETE /api/lab/runs/:id/photos` 没有实现
   （照片不记录 runId），experiments 会退回逐个删除。
8. **WorkflowPort(inline)** 经 `attachPipeline()` 拿到完整依赖；`photo-pipeline.ts` 中“workflow 仍是桩时直接编排”的兜底保留（现在不会触发）。

### 5. 仍然存在的问题

- **数据迁移**：`cli.js migrate-module` 与 `scripts/migrate/**` 仍未实现。真实 `enable storage|database|auth` 需要 `--no-migrate`，此时已有照片 / 数据留在本地
  （启用 s3 后旧照片的原图与衍生图读不到）；disable 同理。
- **LocalStack** 没有实测（见取舍 2）；minicloud 只覆盖适配器用到的 SQS 子集，不能代替 SQS 的全部语义（FIFO、消息属性 MD5 等）。
- **Cognito managed 子模式**：前端跳 `GET /api/auth/login`（BFF 授权码 + PKCE），后端没有这个端点（cognito 档 flows = null）。amplify 子模式没有对真实 User Pool 验证过。
- **管理后台**：`POST /api/admin/jobs/failed/:id/replay` 仍是 501（本地死信重放）。
- **registry**：identity-pool、social-store 等非 MVP 模块没有 `lab.badges`，前端显示通用文案。
- **开发机磁盘**：C: 盘剩余约 6%，凡是把 SQLite / 上传目录放在 `os.tmpdir()` 的测试都会遇到 degraded（< 15%）或 507（< 10%）；相关测试已按水位断言或降低阈值。
  自测脚本的运行目录在仓库内 `.cloudalbum/smoke/`（D: 盘）。
- **能力明细的计数**（例如 email “0 封”）只在 30 秒一轮的探针后更新，不是实时值。
- **AWS 档的 SDK 加载清单**里会出现 `@aws-sdk/credential-provider-node`（客户端包静态 import 默认凭证链模块；实际使用的是 iam 驱动显式传入的 provider）。
- **git**：提交 `ca540ee` 的提交信息被并发的 aws-adapters 覆盖（正确信息在 `git notes show ca540ee`），本轮没有改写历史；工作区里 `docs/` 下其他文件与 `docs/platform/`
  的改动不是本轮的，没有提交。docker-compose 的 postgres 与 valkey 容器保持运行（`npm run test:services:down` 可停止）。

## review-fixes

审查发现（1 个 high、5 个 medium、6 个 low，全部修复）的实现取舍。没有调用真实 AWS API；验证 = build、lint、单元 / 集成测试（CLOUDALBUM_IT=1）、
smoke:l0、smoke:selfhost、cfn-lint 1.57.2（10 个模板 0 发现）、amazonlinux:2023 容器内的 denylist-apply.sh 脚本测试。

1. **cognito JIT 按 email 绑定**（`services/user-directory.ts`）：只在“令牌 / AdminGetUser 的 email_verified=true”且目标行 `auth_provider='local'` 时绑定，
   用 `where auth_provider='local'` 的条件更新防并发改绑。未验证 → 403 `EMAIL_NOT_VERIFIED`；目标行已绑定其他 sub → 409 `ACCOUNT_LINK_CONFLICT`（都不新建，
   因为 email 唯一）。没有同邮箱行时，未验证的 email 不占用真实地址：以 `<sub>@cognito.invalid` 占位建档，验证后的请求改成真实地址（地址被占用时保持占位）。
   认证中间件对 JIT 被拒的 4xx：`/api/capabilities`、`/api/health` 照常匿名，其余返回该错误。`auth.yaml` 的 UserPool 加
   `UserAttributeUpdateSettings.AttributesRequireVerificationBeforeUpdate: [email]` 与 `UserPoolTags: { DataClass: metadata }`（不加 Backup=true）。
2. **MFA 锁定**（`adapters/auth/local.ts`）：开启 MFA 时密码正确只签发挑战、不清零 `failed_logins`（只在 completeMfa 成功或无 MFA 登录时清零）；completeMfa 先查
   `locked_until`（锁定中 → 423 并作废挑战）；另加单挑战尝试上限 `MFA_CHALLENGE_MAX_ATTEMPTS=3`（进程内计数，用完即 `used_at`，账号级计数仍跨挑战累计）。
3. **F14 分片**：`authorizePart` 要求 `uploadId === photoId`（403 `UPLOAD_ID_MISMATCH`，s3 分支同样要求）、分片号 ≤ ceil(上限 / 分片大小)（413 `TOO_MANY_PARTS`）；
   上限 = min(令牌 `maxBytesPerFile`, 运行时 maxUploadMb)。端口返回值加了**加性可选字段** `{ maxBytes?, partSize? }`（总纲 4.2 照录的签名只扩展、不改名）。
   uploads 路由按“已落盘的其他分片 + 本进程内正在写入的预留”限制单片（≤ partSize）与累计（≤ maxBytes），超出立即 413 `UPLOAD_TOO_LARGE`。
   仍然存在：每个用户可建多张 UPLOADING 照片（每张最多 maxBytes），没有按用户的待上传配额，`.incoming` 仍按 24 小时清理。
4. **DB TLS**（`db/knex.ts`）：`DB_SSL` 增加显式取值 `no-verify`。`require` + 配置了 CA 但读不到 / 不是 PEM → `ConfigValidationError`（报告写 CFG-001，退出码 78）；
   `require` 且未配置 CA → 用 Node 内置根证书校验（RDS Proxy 的 Amazon Trust Services 证书可过）；回环地址（自建档）无 CA 时加密不校验。database 探针：CA 在运行中
   丢失 → error；非回环地址上的 `no-verify` → degraded；到远程库的 `disable` → degraded；detail 增加 `TLS <模式>`。没有新增规则 ID（规则表以总纲 §5 为准）。
5. **cdn**：分配增加 `/social/*` → app-origin（全部方法、CachingDisabled、AllViewer），与 `/api/*` 相同；social-api 启用后由它的 injects 改指 API Gateway。
6. **认证中间件**：`verifyAccessToken` 只有 4xx 才按匿名处理；5xx / 非 HTTP 错误（JWKS 不可达、数据库故障）`next(e)` → 503 / 500。公开端点
   `/api/capabilities`、`/api/health` 例外（继续匿名响应，否则依赖故障时前端连 auth 模块的状态都看不到）。
7. **`--regenerate-secrets`**：新增 `cli keys:reset-fingerprint --confirm-data-loss`（不经 buildContainer，直接取分层 env 的 LOCAL_MASTER_KEY）：一个事务内清空
   `users.mfa_secret_enc`（并关闭 MFA）、`photos.location_enc`、未完成的 MFA 挑战，再写新指纹；指纹已一致时什么都不做。引导脚本在 `--regenerate-secrets`
   真正重新生成 secrets.env 时（single 模式）写标记 `etc/.secrets-regenerated`，`db:migrate` 之后执行该命令并删除标记——中途失败重跑时仍会完成恢复。
   本轮 kms 只有本地驱动，因此全部 `ca1.*` 密文都清空；KMS 驱动实现后应只清空 keyRef 为本地密钥的行。
8. **未实现的子模式**：`config/implemented.ts` 的 `UNIMPLEMENTED_VARIANTS`（cognito 下的 `COGNITO_LOGIN_MODE=managed`、`AUTH_MIGRATION=lazy`、
   `AUTH_DUAL_STACK=on`）在 implementationErrors 中报 CFG-001（退出码 78）；`scripts/module enable auth` 的 hook 同样在部署前拒绝 managed 与 dual-stack（lazy 原本就拒绝）。
9. **LabMetricsStore 汇总键**：`routeTemplate(req, ctx, status)`——没有匹配路由的 404 记为 `<unmatched>`；路由前被中间件拒绝的请求按一级前缀
   （`/api/*`、`/social/*` …，其余 `/<other>/*`）；通配 / 正则路由失败时按路由模式本身、成功时按路径段（ID 与 “ID.扩展名” 归一为 `:id`）。
   `lab.compact` 压缩后删除 14 天前的全部汇总行（`LAB_ROLLUP_RETENTION_DAYS`，总纲 7.3“保留 14 天”）。
10. **发布包解压**（l0-bootstrap.sh）：先解压到同一文件系统的 `$rel.tmp.$$`，成功后写 `.extract-complete` 再 `mv -T`；没有标记的旧目录视为不完整，替换后删除。
11. **denylist 信任边界**：Nginx 改为 include root 所有的 `/etc/nginx/cloudalbum-denylist.conf`（0644），只由 `denylist-apply.sh` 在逐行校验通过后写入；校验在
    root-only 目录中的快照上进行（没有“校验后被替换”的窗口），符号链接、非普通文件、超过 4 MiB、FIFO（timeout 5s）一律视为无效。这个副本同时是 last-good：
    旧的 `security/denylist.conf.last-good`（cloudalbum 可写）每次运行都会删除；校验失败时从 root 副本（再校验一次）恢复应用侧文件。新增 `--sync`
    （只更新副本、不 reload、永远退出 0），由 nginx.service drop-in 的 `ExecStartPre=-` 与 postattach（`nginx -t` 之前）调用；install-host-files.sh 播种空副本。
    文档 00-ec2-base.md 中 include 路径与 last-good 的描述需要按此回写（本轮不改 docs）。

---

## platform-scaffold

ATL 平台（`docs/platform/01～08`）的脚手架：工作区、名称表代码化（`@atl/shared`）、端口与 dev 模式运行时、ASL 校验与进程内编排模拟器、
DynamoDB Local 与建表脚本、第一批工具。其他平台实现者都从这里开始填充。权威仍是 01 的名称表（§14）；本节只记录目录约定与取舍。

### 1. 目录约定

```
package.json              根 workspaces 增加 platform/shared、platform/api、platform/workflows、platform/infra、platform/workstation、
                          platform/web（占位）、scripts/labs；新增脚本 platform:*、labs:*（见第 4、5 节）
tsconfig.json             tsc -b 引用增加 platform/shared、workflows、api、workstation、scripts/labs；paths 增加 @atl/*（只给 tsx 用）
vitest.config.ts          projects 增加 6 个平台项目（atl-shared、atl-api、atl-workflows、atl-infra、atl-workstation、atl-labs-tools）
vitest.shared.ts          @atl/shared、@atl/shared/node、@atl/workflows 指向 TS 源码（测试无需先 build）
eslint.config.js          平台规则：见第 2 节“生产与 dev 隔离”
docker-compose.platform.yml  amazon/dynamodb-local:3.3.1（-inMemory，127.0.0.1:58000）；不改 docker-compose.test.yml
platform/package.json     不是工作区根，只转发脚本（cd platform && npm run build|test|dev|validate|db:*）
platform/VERSION          平台版本（0.1.0-dev），merge-template 写入模板 Metadata
platform/shared/          @atl/shared：01 §14 名称表的代码形态（浏览器可用；Node 专用的在 @atl/shared/node）
  src/ids.ts              sid（s + 12 位小写 Crockford）、ULID、envId、envName、卡片 ID、变体、档位名 atl/<card>/<variant>、证书 ID、runId
  src/session-states.ts   11 个状态、T01～T21 转换表、canTransition、锁持有、endReason、agent 路由状态闸门、结束阶段
  src/entities.ts         33 个实体名与废弃名、SessionResource 等枚举、LabSession / Environment / PlatformConfig 的跨文档字段
  src/keys.ts             atl-main 的 PK/SK、GSI1、GSI2（稀疏）、TTL、查询前缀与 AP12 / AP13 分区（唯一的键构造处）
  src/tables.ts           atl-main 与 cloudalbum-lab-locks 的 CreateTable 形态（建表脚本与模板共用）、envLockKey
  src/routes.ts           01 §8.2 全部路由（id、方法、路径、鉴权列、函数、幂等、敏感操作）、matchRoute、08 §9.2 待登记路由
  src/events.ts errors.ts 8.4 事件类型与 source、8.5 审计动作、8.6 错误码（含 agent 码与 03 的终端 / 控制台码）、02 §13.2 失败码、AtlError
  src/runner.ts workflows.ts functions.ts scheduler.ts roles.ts tags.ts resources.ts
                          ATL_OP、状态机与执行名、Lambda 与动作名、调度名与载荷、角色 / 策略 / 会话名、标签、桶 / 栈 / SSM / 安装参数等资源名
  src/agent-context.ts    atl.agent-context/v1：zod schema、buildAgentContext（唯一组装处）、toSessionEnv、toSessionJson、renderEnvFile
  src/lab/                lab.yaml v2：JSON Schema（04 §3.3 照录，lab-schema.generated.ts）、TS 类型、ajv 校验
  src/ports/              端口接口：Clock、Orchestrator、Runner、RunCommand、Scheduler、Signer、TrailLookup、Auth、Invoker、EventPublisher、ObjectStore
  src/encoding.ts jcs.ts  base64url、ATL_ARGS 编解码、DER → P1363、RFC 8785 JCS；node.ts：resourceKey、JWK 指纹
platform/api/             @atl/api
  src/functions/<fn>/     12 个函数；handler.ts = 工厂（接收 DepsProvider），index.ts = 生产入口（只接 aws/deps.ts）
  src/aws/                生产端口实现（SDK v3，按需动态 import）与 prodDeps
  src/runtime/            FunctionDeps（ports + DynamoDB 文档客户端 + env）、环境变量表 PLATFORM_ENV_VARS、{action} 分派器
  src/http/ src/auth/     路由分派（按 @atl/shared 路由表）、problem+json、rbac、SigV4 调用方校验
  src/data/keys.ts        01 §7.1 指定的键入口：从 @atl/shared 再导出
  src/dev/                ATL_DEV_MODE=1 运行时（第 4 节）；生产代码不得引用
  build.mjs               esbuild：nodejs22 ESM，dist-lambda/<fn>/index.mjs；@aws-sdk/* external；发现 dev 代码即失败
  contracts/              01 §13 的 @atl/contracts（openapi 等）占位 README
platform/workflows/       @atl/workflows
  statemachines/*.asl.json  6 个状态机（本轮为合法的占位 Fail 定义）
  src/asl/                结构校验（转移目标、可达性、终止、Retry/Catch、States.ALL、<<占位>>）+ asl-validator 包装、加载与 DEV_SUBSTITUTIONS
  src/simulator/          进程内 Step Functions 模拟器（JSONPath、内置函数、Retry/Catch、超时、Parallel/Map、.sync、故障注入）、VirtualClock
platform/infra/           @atl/infra：src/NN-*.yaml 片段（本轮只有 README）、build/merge-template.ts（含 CFN 短标签解析）、test/
platform/workstation/     @atl/workstation：session.env / session.json 写出工具（atl-write-session-files）
platform/web/             @atl/web 占位（下一轮）
scripts/labs/             @atl/labs-tools：labs:schema、labs:lint（本轮实现 A1 / A2 / A5），derive / build / catalog / policy 为桩（退出码 2）
.atl-dev/                 dev 运行时数据（桶目录、签名密钥、运行器产物、本地 L0、测试临时目录），已加入 .gitignore
```

### 2. 核心约定（平台实现者必读）

- **名称只从 @atl/shared 取**：实体、键、路由 id、状态、事件、错误码、ATL_OP、调度名、执行名、角色会话名、标签、资源名都有常量或构造函数，
  不要在代码里手拼。`platform/shared/test/name-table.test.ts` 把常量与 01 §14、§8.2、§8.4～§8.6 的表逐项比对（文档存在时），名称表改了测试会失败。
- **键**：只经 `Keys` / `Gsi1` / `Gsi2` / `SkPrefix`（API 内从 `src/data/keys.ts` 导入）。GSI2 是稀疏索引：`Gsi2.*` 返回 `null` 时更新必须
  REMOVE `GSI2PK` / `GSI2SK`。`resourceKey()` 在 `@atl/shared/node`。
- **状态转换**：`canTransition(from, to)` 与 `TRANSITIONS` 是 02 §2.3 的代码形态；`atl-lifecycle.Transition` 只能接受其中的边。
- **agent context**：`atl-agent` 用 `buildAgentContext()`，工作台用 `toSessionEnv()` / `toSessionJson()`（`@atl/workstation` 已封装写文件），
  运行器 buildspec 用同一 builder 的 `toSessionEnv(ctx, { opsReport: 'internal' })`——01 §8.2“两处不得各自拼接”。
- **函数结构**：`handler.ts` 导出工厂 `createXHandler(getDeps, table?)`。动作型函数在 `ACTIONS` 里按 `action`（atl-timer 按 `kind`）登记，
  未登记的动作抛 `Atl.NotImplemented`；HTTP 函数在 `ROUTE_HANDLERS` 里按路由 id 登记，未登记的路由返回 501 `NOT_IMPLEMENTED`。
- **HTTP 分派**（`src/http/router.ts`）已经做了：路由匹配（静态段优先）、按路由族鉴权（JWT 经 AuthPort；agent 只认
  `ATLLearnerRole/atl-<sid>-ws` 且 sid 与路径一致，否则 `SESSION_MISMATCH`；internal 只认 `ATLProvisionerRole/atl-<sid>-prov-*` 且 sid
  与路径或 runId 一致，否则 `CALLER_MISMATCH`）、rbac（路由表的鉴权列）、敏感路由的 `auth_time` ≤ 60 分钟、POST 与 `PUT …/result` 必须带
  `Idempotency-Key`、`AtlError` → problem+json。**没有做**（API 实现者负责）：IdempotencyRecord 存取、agent 路由的会话状态闸门
  （用 `AGENT_STATE_GATES`）、审计写入（`onDenied` 钩子已留）、限速。
- **端口**：业务代码只用 `deps.ports.*` 与 `deps.db`，不自己 new SDK 客户端。需要新端口时：接口加到 `platform/shared/src/ports/`，生产实现加到
  `src/aws/adapters.ts`，dev 实现加到 `src/dev/adapters/`，并在 `aws/deps.ts` 与 `dev/runtime.ts` 各接一次。
- **生产与 dev 隔离**：生产入口只经 `src/aws/deps.ts` 取依赖；ESLint 在 `platform/api/src/**`（`src/dev/**` 除外）禁止导入 `**/dev/**` 与
  `@atl/workflows`；`platform/api/test/prod-bundle.test.ts` 用 esbuild 打包 12 个入口并断言 metafile 中没有 dev 代码（`build.mjs` 发现即失败）。
  `@aws-sdk/*` 在 `platform/shared`、`platform/workflows/src`、`platform/web`、`platform/api/src/domain` 中禁止使用。
- **ASL**：状态机写在 `platform/workflows/statemachines/<name>.asl.json`（JSONPath）；02 骨架中的 `"<<LambdaRetry>>"` 等占位必须展开
  （结构校验会报错）。`${Name}` 是 DefinitionSubstitutions，dev 取值在 `src/asl/load.ts` 的 `DEV_SUBSTITUTIONS`，新增占位要同时加在这里与模板中。
  `npm run platform:validate` 与 `test/asl-files.test.ts` 对每个文件跑结构校验与 asl-validator。
- **Lambda 环境变量**（模板必须设置，名称见 `src/runtime/env.ts` 的 `PLATFORM_ENV_VARS`）：`ATL_ACCOUNT_ID`、`ATL_TABLE`、`ATL_LOCKS_TABLE`、
  `ATL_WEB_BUCKET`、`ATL_DATA_BUCKET`、`ATL_ARTIFACTS_BUCKET`、`ATL_LAB_STATE_BUCKET`、`ATL_USER_POOL_ID`、`ATL_WEB_CLIENT_ID`、`ATL_SIGNING_KEY_ID`、
  `ATL_SCHEDULER_ROLE_ARN`、`ATL_TIMER_FUNCTION_ARN`、`ATL_TIMER_DLQ_ARN`、`ATL_PLATFORM_VERSION`；`ATL_DEV_MODE` 永不出现在模板中。

### 3. 各实现者要填的文件

- **API（atl-api / atl-agent / atl-public，01、03、04 的 API 部分）**：`platform/api/src/functions/{api,agent,public}/handler.ts` 的 `ROUTE_HANDLERS`；
  仓储放 `src/data/repositories/`，纯领域逻辑放 `src/domain/`（不依赖 SDK）；`contracts/`（openapi、entities/*.schema.json 等）；
  `atl-pricing`、`atl-certs`（JWS：`canonicalJson` + `SignerPort.sign` + `jwkThumbprint`）。
- **生命周期与编排（02）**：`functions/{lifecycle,timer,reaper}/handler.ts` 的 `ACTIONS`；`platform/workflows/statemachines/*.asl.json`（替换占位）；
  `platform/workflows/runner/buildspec.yml` 与 `runner/ops/*.sh`；`platform/workflows/reclaimer/`。dev 下用 `createDevRuntime()` 跑完整编排
  （`platform/api/test/dev-runtime.test.ts` 是范例：VirtualClock + 注入失败）。
- **检查、报告、证书（04）**：`functions/{checks,certs}/handler.ts`；检查包源码按 06 PM-04 放 `platform/infra/checks-bundle/`；
  `scripts/labs/src/` 的其余 lint 规则（A3、A4、A6～A20、B21～B25）与 derive / build / catalog / policy。
- **基础设施（01 §3～§6）**：`platform/infra/src/NN-*.yaml`、`policies/*.json.tmpl`、`build/{gen-policies,package,manifest}.ts`、`test/inventory.test.ts`；
  `platform/package.json` 的 `publish:s3`；SSM 文档按 01 §13 放 `platform/workflows/ssm/`（04 §6.1 写的 `platform/infra/ssm/` 以 01 为准）；
  表定义请直接用 `ATL_MAIN_SPEC` / `LAB_LOCKS_SPEC` 的键结构。
- **工作台（03）**：`platform/workstation/`（`bin/`：atl-workstation-setup.sh、atl-agent-call、atl-credentials、atl-lab-proxy；`bootstrap/`：
  user-data、profile.d），工作台栈模板 `platform/workflows/templates/atl-workstation.yaml`，SSM 文档 ATL-SessionShell(-Logged)、
  ATL-PrepareInstance、ATL-WorkstationSetup。
- **CloudAlbum 平台模式（06 P0）**：不在 platform/ 下；dev 模式需要它提供检查包的 Node 入口（设为 `ATL_DEV_CHECK_RUNNER`），以及
  `scripts/module` 的平台模式子命令（dev 运行器 `dry-run` 档的命令表可用 `ATL_DEV_RUNNER_COMMANDS` 覆盖）。
- **卡片内容**：`labs/<card-id>/`（04 §2.1）；`npm run labs:schema` 生成 `labs/_schema/lab.schema.json`，`npm run labs:lint` 校验。
- **前端（下一轮）**：`platform/web/`；可直接用 `@atl/shared` 的路由表、状态、事件、错误码与 lab 类型。

### 4. dev 模式（ATL_DEV_MODE=1）怎么启动

```bash
npm run build                    # 或 npm run platform:build（另外生成 Lambda 包与合并模板）
npm run platform:db:up           # DynamoDB Local（docker，127.0.0.1:58000，内存模式）
npm run platform:db:init         # 建 atl-main、cloudalbum-lab-locks，并写入 dev 用 PLATFORM/CONFIG（加 -- --reset 可重建）
npm run platform:dev             # http://127.0.0.1:8787（脚本带 --dev-mode，等价于 ATL_DEV_MODE=1）

curl -H "Authorization: Bearer dev.learner.u1" http://127.0.0.1:8787/api/v1/time
curl -H "X-ATL-Dev-Caller: arn:aws:sts::000000000000:assumed-role/ATLLearnerRole/atl-s4k7m2q9x1abc-ws" \
     http://127.0.0.1:8787/api/v1/agent/sessions/s4k7m2q9x1abc/context
curl http://127.0.0.1:8787/__dev/state                       # 时钟、执行、调度、构建、事件
curl -X POST http://127.0.0.1:8787/__dev/faults -d '{"state":"AcquireLock","error":"Atl.LockBusy"}'
curl -X POST http://127.0.0.1:8787/__dev/trail/events -d @events.json
curl -X POST http://127.0.0.1:8787/__dev/clock/skip -d '{"minutes":15}'
curl -X POST http://127.0.0.1:8787/__dev/invoke/atl-timer -d '{"kind":"SWEEP"}'
npm run platform:db:down
```

| 生产 | dev 实现（`platform/api/src/dev/adapters/`） | 相关变量 |
|---|---|---|
| DynamoDB | DynamoDB Local | `ATL_DEV_DDB_ENDPOINT`（默认 http://127.0.0.1:58000） |
| Step Functions | `SimulatedOrchestrator`：同一份 ASL 在进程内解释执行；`lambda:invoke` → 进程内函数表；`.sync` 构建 → dev 运行器；`injectFault()` | — |
| CodeBuild atl-runner | `LocalProcessRunner`：`noop`（默认，按平台时间睡眠后成功）/ `dry-run`（`scripts/module … --dry-run`，无需凭证）/ `local-l0`（`base-deploy` 起本地 CloudAlbum，`destroy` 停止）；写 `runs/<runId>/result.json`、`progress.jsonl` | `ATL_DEV_RUNNER_MODE`、`ATL_DEV_RUNNER_NOOP_SECONDS`、`ATL_DEV_RUNNER_COMMANDS` |
| SSM Run Command | `LocalRunCommand`：ATL-RunCheck 先按 allowedPattern 校验，再以 `SSM_<参数>` 环境变量本地运行检查包入口，`ATL_DEV_APP_BASE_URL` 指向本环境的本地 CloudAlbum；ATL-WorkstationSetup 模拟成功 | `ATL_DEV_CHECK_RUNNER` |
| EventBridge Scheduler | `InProcessScheduler`：一次性调度 = dev 时钟上的定时器，触发后删除；`atl-sweeper` 启用时每 5 分钟 | `ATL_DEV_TIME_SCALE`（如 60：1 秒 = 1 平台分钟） |
| KMS | `LocalEcdsaSigner`：`.atl-dev/keys/<keyId>.pem`（P-256，首次使用时生成） | `ATL_DEV_SIGNING_KEY_ID` |
| CloudTrail LookupEvents | `FakeTrailLookup`：注入的事件，可模拟投递延迟 | `ATL_DEV_TRAIL_FILE`、`ATL_DEV_TRAIL_DELAY_SECONDS` |
| Cognito | `DevAuth`：`dev.<learner/assistant/observer>.<sub>[.<auth_time>]` | — |
| Lambda / EventBridge / S3 | 进程内函数表 / 内存总线 / `.atl-dev/buckets/<bucket>/` | `ATL_DEV_DATA_DIR`、`ATL_DEV_PORT` |

测试中用 `createDevRuntime(cfg, { clock: new VirtualClock(), db, definitions, faults })`；`VirtualClock` 在进程空闲时跳到最早的定时器，
重试退避、超时、倒计时都能瞬时、确定地跑完。

### 5. 测试

```bash
npm test                                       # 全部（含 CloudAlbum 原有测试）
npm run platform:test                          # 只跑 6 个平台项目
npm run platform:db:up && ATL_IT=1 npx vitest run --project atl-api   # 含 DynamoDB Local 集成测试 *.int.test.ts
```

### 6. 设计有歧义时的取舍（偏离或细化 01～08 之处）

1. **工作区布局**：01 §13 / §4.9 把 platform/ 写成独立的 npm workspaces 根（`cd platform && npm ci`）；按本轮任务改为仓库根的工作区，
   `platform/package.json` 只转发脚本。`npm ci` 必须在仓库根执行；07 V0-6、V5-1 的 `cd platform && npm run build` 仍可用。
2. **@atl/shared**：01 §13 没有这个包，名称表常量、键构造与端口接口放在这里（web、工具共用）。01 §7.1 规定键构造只在
   `platform/api/src/data/keys.ts`：该文件保留为 API 的唯一入口，实现再导出自 @atl/shared。
3. **lab.yaml v2 schema 的来源**：04 §3.3 说源头是 `platform/api/src/content/lab.ts` 的 zod 定义；本轮把 04 的 YAML 块逐字转成
   `platform/shared/src/lab/lab-schema.generated.ts`，测试逐项比对文档（04 §11.1 的 svc-cdn 示例必须通过）。卡片工具放 `scripts/labs`
   （04 §2.5 写的是 `platform/api/src/content/`），根 package.json 提供 `labs:*` 脚本。
4. **工作台工具位置**：01 §13 的 `platform/workflows/workstation/` 改为独立工作区 `platform/workstation/`（任务要求）；工作台栈模板仍在
   `platform/workflows/templates/`。
5. **Lambda 打包**：与 `lambdas/image-thumbnail` 一致，`@aws-sdk/*` 不打包（用 Lambda 运行时自带的 SDK v3）；新增 SDK 依赖锁定为 3.1142.0
   （与仓库已有客户端同版本，避免重复的 @aws-sdk/core）。
6. **runId 中的 op 缩写**：02 只出现 `base`、`ws`、`apply`、`xstk`、`destroy`；其余定为 `resume`、`wsdown`、`modop`、`suspend`、`repair`、`diag`
   （`RUN_ID_OP_ABBREV`）。`reclaim-<envId>-<mode>-<n>` 中的 mode 用小写。
7. **错误码**：03 §9.1 的终端 / 控制台码尚未登记到 01 §8.6，已按 03 §3.2 的状态码收录（`WORKSPACE_ERROR_CODES`）；03 未给状态码的
   `CONSOLE_DESTINATION_NOT_ALLOWED` 取 422、`CONSOLE_FEDERATION_FAILED` 取 503。脚手架桩路由返回 501 `NOT_IMPLEMENTED`（不在 8.6 中，实现后消失）。
   08 §9.2 #1 请求的 `TARGET_ALREADY_SATISFIED` 等只列在 `UI_REQUESTED_ERROR_CODES`。
8. **GSI2 排序键**：`LabSession` 非终态时，倒计时中的 READY / RUNNING / EXPIRING 用 `deadlineAt`，其余用 `stateEnteredAt`；复扫窗口内
   `FOLLOWUP#PENDING` 的排序键在 `revokedAt` 为空（从未发放访问）时用 `stateEnteredAt`。`Environment` 只有 `RELEASED` 不进 GSI2。
9. **TTL**：01 只说 `CostQuote` 的 TTL“清理用”，取 24 小时；判定一律比较 `expiresAt`。
10. **session.json 字段**：01 §8.2 与 03 §4.6 第 4 步不一致，以 01 为准（含 `envName` 与 `cloudalbum.adminPasswordParam`）。
11. **testUsersParam**：01 规定“起始档位含种子 cognito-test-users 时非空”，但 atl-agent 不读内容包；`buildAgentContext` 由调用方传
    `testUsersSeeded`（建议 02 在 `LabSession` 中记录，例如 `cardFacts` 增加一项，需 01 登记）。
12. **envName 派生**：`e` + envId（小写 ULID）的后 7 位（随机部分）；碰撞时重新生成 envId。03 §4.6 示例中的 envId 含 `u`、`i`，不是 Crockford Base32。
13. **08 §9.2 的新路由**（`/platform/preflight`、`runner-runs`、证据下载等）只列在 `UI_REQUESTED_ROUTES`，不在路由表中，01 登记后再实现。
14. **dev 运行器**：默认 `noop`；`dry-run` 的默认命令表只调用现有子命令（bootstrap、base deploy、profile diff、status），06 的平台模式子命令
    （`env destroy --fast`、`profile apply --platform` 等）实现后再改默认表。`local-l0` 复用 `scripts/smoke/lib.mjs`，需要先 `npm run build`。
15. **模拟器的边界**：只支持 JSONPath；不支持 JSONata、变量（Assign）、`.waitForTaskToken`（ATL 不用）、分布式 Map；`startExecution.sync:2`
    的子执行失败时抛 `States.TaskFailed`；被取消的 `.sync` 构建会调用 `stopBuild`（真实行为由 07 V1-12 验证）。一次性调度的 `at()` 已过时立即触发（07 V1-11 验证）。
16. **asl-validator**（4.0.0，无类型声明，会改写输入）只在校验时以深拷贝调用，模拟器不依赖它。

### 7. 需要其他文件配合的事项

- 01：登记 03 的终端 / 控制台错误码与 08 §9.2 的路由、错误码、`session.phase_changed.phase` 取值；说明 `testUsersParam` 的数据来源；
  §13 的目录树按本节第 1～4 条更新（或确认维持）。
- 04：§6.1 的 SSM 文档源路径与 01 §13 不一致（本轮按 01）。
- 06（CloudAlbum 平台模式）：检查包的 Node 入口路径（供 `ATL_DEV_CHECK_RUNNER`），以及 dev 运行器可调用的平台模式子命令。
- infra：模板为每个函数设置第 2 节列出的环境变量；状态机的 DefinitionSubstitutions 键与 `DEV_SUBSTITUTIONS` 一致。
