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

