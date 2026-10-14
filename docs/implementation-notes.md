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

## platform-api

ATL 平台 API（01 §8.2 全部 `/api/v1` 路由）：HTTP 层、DynamoDB 仓储、目录 / 会话 / 事件服务、路由表、本地 dev-server 与测试。
名称、键、路由 id、状态、事件、错误码一律取自 `@atl/shared`；键只经 `src/data/keys.ts`。

### 1. 目录

```
platform/api/src/
  http/          router.ts（鉴权 → RBAC → 最近登录 → Idempotency-Key → IdempotencyRecord 重放 → 处理函数；problem+json；
                 429/503 带 Retry-After；Atl.NotImplemented / PortError NotImplemented → 501）、responses.ts（ETag/304、202+Location）、
                 validate.ts（zod → 400 VALIDATION_FAILED + errors[]{path,message}）、pagination.ts（limit + HMAC 游标）、rate-limit.ts
  repositories/  table.ts（Get/Put/Update/Query/Transact/BatchGet，条件失败归一为 ConditionFailedError）、sessions.ts（LabSession 与
                 SESSION# 子项；T01 createRequested、Transition 条件转换 + 同事务事件 + GSI2 重算）、events.ts（SessionEvent、单调 ULID、AP5）、
                 platform.ts（PlatformConfig、ActiveEnvironmentLock 的 acquire/reserve/transferTx/release、CatalogRelease）、users.ts（Learner/Member、
                 LabProgress、QuizAttempt、CostQuote）、environments.ts（Environment、SessionResource、ReclaimPass）、certificates.ts、audit.ts
                 （AuditEvent、IdempotencyRecord）
  services/catalog/   内容发布读取（store.ts）、变体 / cardFacts / 时长与保留上限（labs.ts）、报价 API 层（quotes.ts）、路径进度与证书条件、掌握度（progress.ts）
  services/sessions/  lifecycle-client.ts（atl-lifecycle 动作与短编排的唯一入口）、guards.ts（开始前快速预判）、view.ts（会话视图）、start.ts
                      （报价 START/REUSE、复用差异计划、POST /sessions）、control.ts（心跳、EXTEND/KEEP 报价、延长、结束、保留、释放、重试回收、“我已处理”）、
                      cleanup.ts（回收报告 json/md、人工清单、费用计）、agent.ts（agent context、实验登记/上传/轮询/附件、模块操作上报、运行器进度与凭证登记）
  services/events/    写事件 + 发总线、events?after= 轮询、workspace.* 事件清洗、审计
  routes/        platform / catalog / sessions / workspace / progress / reports / agent（含 internal、回退与 atl-public）；index.ts 的
                 createApiHttpHandler / createAgentHttpHandler / createPublicHttpHandler；extensions.ts（可插拔 provider 与下游动作名）
  dev-server.ts  Express ↔ Lambda 事件适配器（见第 4 节）
platform/api/test/  api-units.test.ts、api-flows.test.ts（内存表）、api-flows.it.test.ts（DynamoDB Local）、dev-server.test.ts、api-support/
```

### 2. 接线（集成时的一行改动）

`functions/api|agent|public/handler.ts` 仍是脚手架桩（不在本节负责范围内）。集成时改为
`createApiHandler = (getDeps) => createApiHttpHandler(getDeps)`，agent、public 同理（`src/routes/index.ts`）。这三个工厂已带上
`IdempotencyRecord` 存取与 403 审计。dev 运行时的 `createFunctionTable` 经这三个工厂自动生效；`dev-server.ts` 现在就会替换注册。

### 3. 与其他函数的契约（动作名未登记的需 01 收录）

| 调用 | 方式 | 载荷 `{ action, … }` | 期望结果 |
|---|---|---|---|
| atl-lifecycle `CreateSession` | 同步 | `sessionId, sub, labId, variant, quoteId, reuseEnvId, session:<LabSession 草稿>, actor:'user', requestedBy` | `{ sessionId, state, ver }`（T01 写 REQUESTED） |
| atl-lifecycle `Transition` | 同步 | `sessionId, from[], to, reason, expectedVer?` | 会话项（T04 取消、T07 首次心跳、T08 心跳发现剩余 ≤ 15 分钟） |
| atl-lifecycle `Extend` | 同步 | `sessionId, minutes, quoteId, expectedDeadlineVersion` | 会话项（02 §5.4，含 T09 与调度） |
| atl-lifecycle `ExtendKeep` | 同步 | `sessionId, hours, quoteId, expectedKeepVersion` | 会话项（T13 + 保留调度，**新动作名**） |
| `atl-session-start` | StartExecution | 名 `start-<sid>`，输入 `{ sessionId }` | — |
| `atl-session-end` | StartExecution | `end-<sid>-1` / `-rel` / `-retry-<k>`；输入 `{ sessionId, reason, disposition, keep?, keepPrerequisites?, actor, requestedBy }`，`keep = { hours, quoteId, saveMode, confirmedAt }` | 同阶段同输入重复启动视为已在进行 |
| `atl-module-op` | StartExecution | `modop-<sid>-<n>`，输入 `{ sessionId, n, envId, actionId 或 op:'repair', opId?, requestId, requestedBy }` | n 从现有 ModuleOp 数 +1 起，名字被占用则递增 |
| `atl-platform-uninstall` | StartExecution | `uninstall-<n>`（运行中的复用，已结束的跳过），输入 `{ mode:'prepare', requestedBy, requestedAt }` | — |
| atl-pricing `PriceQuote` | 同步 | `purpose, region, labId, labVersion, catalogVersion, variant, alternativeVariants?, lines[], durationMinutes, maxTotalMinutes, envId?, keepHours?` | `{ currency, priceAsOf, lines, hourly{start,completed}, retainHourly, platformOverhead, maxSession, incomplete[], freeTierNote, notes[] }` |
| atl-checks `RunChecks` / `StepAction`（read、drift-ack、skip、unskip）/ `SubmitAttempt` / `ApplyManualConfirmation` / `ApplyManualReview` / `CrossCheckExperiment` | 异步 | 见 `routes/progress.ts`、`services/sessions/agent.ts` | 写 CheckRun / StepResult / LabAttempt / ExperimentRun.validity |
| atl-certs `GenerateReport` / `ExportReport` / `CreateShare` / `RevokeShare` / `PublishCertificate` / `ExportArchive` | 异步 | 见 `routes/reports.ts`、`routes/platform.ts` | — |
| atl-certs `IssueCertificate` / `RevokeCertificate` | **同步** | `sub, scope, trackId 或 labId, labs[], catalogVersion, displayName?, public?` / `certId, reason` | `{ certId, jws, payload }`（01 §8.3 示例直接返回 JWS）/ 吊销后的证书 |
| atl-reaper `VerifyResolved` | 异步 | `envId, resourceKey, sessionId, note, actor, requestedBy` | 复核“我已处理” |

错误：同步调用抛出的 `Atl.<CODE>`（大写下划线）或 `Atl.<CamelCase>`（如 `Atl.QuoteExpired`）都映射到 01 §8.6 的码；`Atl.TransitionRejected`、
`Atl.AlreadyTerminal`、`Atl.SessionNotRunning` → 409 `INVALID_STATE`；`Atl.LockBusy` 取消息前缀中的码；`Atl.NotImplemented` → 501。

### 4. dev-server（`platform/api/src/dev-server.ts`）

```bash
npm run platform:db:up && npm run platform:db:init
npx tsx platform/api/src/dev-server.ts --dev-mode --seed-catalog labs --port 8788
```

- `/api/*` → 三个 HTTP 函数（payload 2.0）；浏览器路由用 `Authorization: Bearer dev.<group>.<sub>`，agent / internal 路由用
  `X-ATL-Dev-Caller: <assumed-role ARN>`（与脚手架 dev/server.ts 一致）；对 `localhost` / `127.0.0.1` 来源加 CORS（前端 vite 开发用）。
- `/content/*` 读 dev `atl-web` 桶；`--seed-catalog <dir>` 或 `POST /__dev/catalog/seed` 把 `labs/<id>/lab.yaml`、`quiz.yaml`、`_tracks/*.yaml`
  （有 `_catalog/catalog.yaml` 时用它作索引）发布为内容版本 `dev` 并写 `CatalogRelease`。
- `POST /__dev/sessions/<sid>/advance { to, minutes? }` 按 T01～T21 推进会话（填 readyAt / deadlineAt、dev Environment、锁）；其余 `/__dev/*` 沿用脚手架。
- atl-lifecycle 对 `CreateSession`、`Transition`、`Extend`、`ExtendKeep` 抛 `Atl.NotImplemented` 时，dev-server 用仓储层的 dev 实现兜底
  （`DEV_LIFECYCLE_ACTIONS`，只在 dev / 测试中使用，不建调度）。

### 5. 取舍与偏离

1. **SessionEvent 的 `type`**：按 `@atl/shared` 的 `SessionEventRecord` 存事件类型，实体名放 `entity`（01 §7.1 的通用属性 `type` 与 §7.3 的事件 `type`
   重名）；读取时兼容 `eventType`。
2. **事件轮询**：`{ events[], next, hasMore, pollAfterMs }`；ULID 时间晚于“现在 − 2 秒”的事件留到下一轮（防止慢写入者的较早 id 被游标跳过）；进程内 ULID
   单调（同毫秒递增，时钟远远落后时重置）。`after` 必须是 ULID，否则 400（08 §9.2 #22 的 `CURSOR_EXPIRED` 未登记）。
3. **幂等**：只保存 2xx 响应；同键处理中 → 409 `INVALID_STATE`（`reason: IDEMPOTENCY_IN_PROGRESS`，`Retry-After: 1`）；同键不同请求 → 422
   （01 未给码，用 `VALIDATION_FAILED` + `reason: IDEMPOTENCY_KEY_REUSED`）；agent / internal 路由的作用域为 `ws-<sid>` / `prov-<sid>`；
   `heartbeat`、`createExport` 仍要求请求头但不存记录（后者按同键轮询，08 §9.2 #16）。
4. **未登记的错误码**放在已登记码的 `reason` 中：`TARGET_ALREADY_SATISFIED` → 409 `INVALID_STATE`；`LAB_DEPRECATED`、`HARD_PREREQ_UNMET` → 400
   `VALIDATION_FAILED`（startability 的 `reasons[]` 直接用这些码）。
5. **单活动会话**：`POST /sessions` 前强一致读锁、持有者、5 分钟内的 `REQUESTED` 会话（GSI2）与按小时计费的 `BLOCKING` 残留（AP13），按 02 §3.4、§9.2
   给 409；权威仍是编排中的 `AcquireLock`。锁的条件写（acquire / reserve / transferTx / release）在 `repositories/platform.ts`，供 atl-lifecycle 复用。
6. **报价**：API 从 `cost.basis` 生成明细（含“平台开销”行），交 atl-pricing 定价；atl-pricing 不可用（未实现 / 不存在）时报价照样生成，但每行
   `unknown: true`、`incomplete` 列出全部定价键、金额区间为 `null`（04 §3.4“不允许按 0 计”），不编造价格。`CostQuote` 另存 `catalogVersion`、
   `startProfile`、`startProfileDigest`、`reusePlan`、`sessionId`（EXTEND / KEEP）、`minutes` / `keepHours`、`costTier`。
7. **LabSession 草稿**（CreateSession）在 01 §7.3 之外增加：`cardFacts.testUsersSeeded`（platform-scaffold 第 11 条的建议）、`cardLimits`
   （timeLimit、extensions、retain、provision、workstationRequired，随 catalogVersion 固定）、`learnerInputs`、`requestedBy`。
8. **atl-api 写的会话描述字段**（不改 ver，不在 01 §7.5 的生命周期字段表中）：`preferredDisposition`（对象 `{ disposition, keepHours, quoteId,
   keepPrerequisites, saveMode, confirmedAt }`，与 lifecycle 的模型一致；@atl/shared 的类型写的是字符串，需要统一）、`lastHeartbeatAt` / `lastWorkbenchAt`
   （30 秒内只写一次）、`cleanupRetryCount`（条件递增后启动 `end-<sid>-retry-<k>`）、`startExecutionArn`。
9. **助教 / 观察者**看到的“我的…”数据（会话列表、当前会话、进度、掌握度、报告、实验、证书）是唯一学员的数据（08 §9.2 #21），学员 sub 取自
   `MEMBERS / learner#`；学员资料在其首次 `GET /me` 时建立。学员只能看到自己的会话（其他 sid 一律 404）。
10. **当前会话**：本人非终态会话中，活动状态 > `REQUESTED` > `KEPT` > `CLEANUP_FAILED`（08 §9.2 #23 尚未登记，暂按 01 / 02 的“非终态含 KEPT”）。
11. **证书**：`POST /certificates` 先由 API 判定条件（路径：tracks §5.5 的纯函数；`scope: lab`：卡片 `certificate.enabled: true` 且徽章有效，07 V5-3 5a），
    再**同步**调用 atl-certs 返回 `{ certId, jws, payload }`（201）；吊销也同步；公开、分享、报告、导出异步（202）。离线验证包由 API 直接组装。
12. **输入变量**：`PUT /vars/{name}` 按卡片 `variables.<name>.pattern` 校验后写 `LabAttempt.variables`（01 只把 LabAttempt 记为 atl-checks 写入，这是一个
    属性级例外；尝试未开始时 409）。
13. **工作台**：终端、控制台、管理员密码与实时预览探测由 03 的 `WorkspaceProvider` 完成（路由层已做状态 / 截止时间 / 吊销闸门、限速、审计、`terminal.*`
    与 `console_link.issued` 事件）；没有 provider 时这些路由 501。`GET /workspace` 的 targets 在无 provider 时取 `Environment.instances` 缓存（`cached: true`）；
    `GET /preview` 无 provider 时按 `LabSession.app` / `Environment.endpoints` 判定（http → `MIXED_CONTENT`，自签 → `UNTRUSTED_CERT`）。
14. **成员**：`POST` / `DELETE /members` 需要 Cognito 管理端口（`MemberDirectory` provider）；没有时 501。学员本人不能删除（403）。
15. **限速**：函数容器内存中的一分钟固定窗口；默认值见 `RATE_LIMIT_DEFAULTS`，可由 `PlatformConfig.rateLimits` 覆盖（设置页可改）；超限 429 + `Retry-After`。
16. **游标**：HMAC 密钥取 `ATL_CURSOR_SECRET`（可选环境变量），否则由账号与表名派生；游标绑定列表作用域，换列表解码失败。
17. **内容路径**：索引先找 `content/<v>/catalog/index.json`（05 §8.4），再找 `content/<v>/index.json`（04 §2.5）；卡片 `content/<v>/labs/<id>.json`；
    题库 `atl-artifacts/releases/<catalogVersion>/private/quiz/<id>.json`；档位摘要依次取卡片 `startProfileDigests[variant]`、索引
    `startProfiles[].planDigest`、`manifest.json`，都没有时记 `sha256:unknown`。atl-agent 登记实验时读卡片校验实验与标签（需要 `atl-web/content/*/labs/*`
    的读权限）。
18. **实验运行**：登记时写 `ExperimentRun`（`status: registered`，窗口 = 现在 − 1 分钟 ～ min(现在 + 60 分钟, deadline + 10 分钟)）；上传时校验 schema、
    RFC 8785 摘要、与登记一致、只收一次，结果存 `atl-data/experiments/<sid>/<runId>.json`，GSI1 `EXP#<module>#<experiment>#<finishedAt>` 在上传时写入；
    附件键 `experiments/<sid>/<runId>/<name>`。回退路由按 `runTokenHash` 校验（只在 `agent.lateUploadFallback=on` 时可用）。
19. **GET /platform** 按 08 §9.2 #3 给出可得的字段；`PATCH /me` 接受 08 §9.2 #4 的 `onboarding`。08 §9.2 的新路由（preflight、runner-runs、evidence、
    cost/actual、exports/{id}、manual-confirmations 队列）未实现，等 01 登记。

### 6. 测试

```bash
npx vitest run --project atl-api test/api-units.test.ts test/api-flows.test.ts test/dev-server.test.ts   # 无需 Docker
npm run platform:db:up && CLOUDALBUM_IT=1 npx vitest run --project atl-api test/api-flows.it.test.ts      # 或 ATL_IT=1；每个用例一张临时表
```

同一组 17 个端到端场景分别跑在内存表（`api-support/memory-ddb.ts`）与 DynamoDB Local 上。

### 7. 需要配合

- 集成：第 2 节的 handler 接线；`platform/api/package.json` 补 `express`、`yaml`（dev-server），开发依赖 `@types/express`、`supertest`、`@types/supertest`
  （目前由根 node_modules 提供）；可加脚本 `platform:dev:api`。
- atl-lifecycle：实现第 3 节的 `CreateSession`、`Transition`、`Extend`、`ExtendKeep` 载荷；`BeginEnd` 读取 `keep`、`keepPrerequisites`；
  EXPIRE 读取对象形式的 `preferredDisposition`。
- atl-checks / atl-certs / atl-reaper / atl-pricing：第 3 节的动作名与载荷（`IssueCertificate`、`RevokeCertificate` 为同步）。
- 03：实现 `WorkspaceProvider`（终端、控制台、管理员密码、预览探测、实例发现）。成员管理需要 Cognito 管理端口。
- 01：登记第 3 节的新动作名、`IDEMPOTENCY_*` / `TARGET_ALREADY_SATISFIED` 等码、LabSession 的新增属性（第 5 节第 7、8 条）、CostQuote 的扩展字段、
  atl-agent 读取内容包的权限。

## platform-infra

平台单栈模板 `atl`（01 §3～§6）、IAM 策略生成与校验、SSM 文档、安装自定义资源、打包与发布工具、工作台引导与工具（03 §4）。
本节只记录取舍；名称一律取自 `@atl/shared`，权威仍是 01。

### 1. 交付内容

```
platform/infra/
  src/00-meta.yaml … 90-install.yaml   模板片段（参数 = INSTALL_PARAMETERS；表结构 = ATL_MAIN_SPEC / LAB_LOCKS_SPEC，测试比对）
  policies/*.json.tmpl                 三条边界、两条护栏、ATLProvisionerPolicy-Core/-Guards、ATLLearnerIam、ATLAgentApi、Verifier
  policies/verifier-readonly.base.json 04 §5.7 基础白名单（SDK 名已换成 IAM 动作）；labs:policy 写出 generated/verifier-readonly.json 后优先用它
  policies/generated/                  gen-policies 输出：<Name>.cfn.json（模板用）、<Name>.example.json（渲染示例）、sizes.json（字符预算）
  ssm/*.yaml                           ATL-RunCheck、ATL-SessionShell(-Logged)、ATL-PrepareInstance、ATL-WorkstationSetup
  custom-resources/src/                atl-custom-resources（Preflight、SeedData、WebDeploy、JwksPublish、SchemaMigrator、StackGuard、
                                       UninstallGuard、BucketEmptier + 动作 UninstallRoleCleanup；端口 ports.ts，生产实现 aws-ports.ts）
  custom-resources/copy-artifacts.cjs  atl-copy-artifacts 内联代码（esbuild 压缩后 2,980 字符，测试上限 4,096）
  build/                               merge-template、template-parts（12 个函数 + 6 个状态机由表生成）、gen-policies、intrinsics（CFN
                                       内置函数求值）、package、archive、publish-s3、launch-link、cfn-lint、workstation-template
  release.config.json                  GitHub 仓库、已验证区域、EC2 信任是否带 aws:SourceAccount、模板桶
platform/workstation/
  src/agent-call.ts + src/cli/         atl-agent-call（SigV4 execute-api，2/4/8/16/30 s 退避，退出码 3/4）
  bin/                                 atl-workstation-setup.sh（03 §4.6 第 1～7 步）、atl-credentials、atl-lab-proxy
  bootstrap/                           user-data.sh（Fn::Sub 模板）、profile.d-atl.sh
  templates/atl-workstation.src.yaml   → atl-workstation.yaml（生成并提交，嵌入 user data；测试校验是最新的）
```

命令：`npm run template|policies|package|publish:s3|launch-link|cfn-lint|check -w @atl/infra`（见 `platform/infra/src/README.md`）。
cfn-lint 不是 npm 依赖：`pip install cfn-lint` 或设 `ATL_CFN_LINT=<路径>`；`test/template.test.ts` 在找到它时对平台模板与工作台模板跑一遍，零错误。

### 2. 设计取舍与偏离

1. **位置**：SSM 文档放 `platform/infra/ssm/`（04 §6.1 的路径；01 §13 写的是 `platform/workflows/ssm/`），工作台栈模板放
   `platform/workstation/templates/atl-workstation.yaml`（01 §13、03 §4.4 写的是 `platform/workflows/templates/`），按本轮分工。
   `cloudalbum-infra.zip` 收录 `platform/workstation/templates/` 与 `platform/workflows/runner/`，运行器按这两个路径读取。
2. **atl-custom-resources 的代码在 infra**：Lambda 包由 `build/package.ts` 从 `platform/infra/custom-resources/src/index.ts` 打包；
   `platform/api/src/functions/{custom-resources,copy-artifacts}` 的桩不再进入发布包（集成时可删除或改为再导出）。dev 运行时里
   这两个桩不变（UninstallRoleCleanup 在 dev 下仍是 NotImplemented）。
3. **一个 Lambda 包**：全部函数共用 `atl-lambdas.zip`（01 §4.5“每个函数一个子目录”），`Handler = <函数名>/index.handler`；
   `Code.S3ObjectVersion` 取自 CopyArtifacts 返回的对象版本，`ReleaseVersion=dev` 重复发布时函数也会更新。
4. **安装 ID = `AWS::StackId` 的 UUID 部分**：安装前即已知，可直接用于 Cognito 域名前缀 `atl-<前 8 位>`，并写入 `/atl/installation-id`、
   PlatformConfig 与输出 `InstallationId`（01 说“UUID v4、安装时生成”，栈 ID 的 UUID 满足唯一性）。
5. **Provisioner 边界超限**：01 §6.7 的完整边界约 7,900 字符。桶前缀保护、DenyPlatformByArn、账号级 IAM、实例规格限制等 Deny 外移到
   身份策略 `ATLProvisionerPolicy-Guards`（符合 `ATLProvisionerPolicy-*` 命名；对该角色自身会话与放在边界中效果相同，同学员护栏的做法），
   允许部分为 `ATLProvisionerPolicy-Core`（服务级通配，不是 `*:*`）。`atl-data` 用精确桶名（`atl-data-*` 会连同 `runs/` 对象一起匹配）。
6. **字符预算**（ap-northeast-1 + DR ap-northeast-3，非空白字符）：学员边界 5,833、工作负载边界 5,909、Provisioner 边界 5,159、护栏
   5,120（上限 6,144）；Verifier 内联 7,352 / 10,240；学员角色内联 1,091，另为运行期 `ATLRevokedSessions` 预留 2,000（约 12 条吊销条目）。
   为此 DenyPlatformByName 把 role/policy/instance-profile 合并为 `arn:aws:iam::*:*/ATL*`、规则与总线合并为 `events:*:*:*/atl-*`（超集）。
   列表参数（`AllowedInstanceTypes` 等）每多一项约 +15 字符；工作负载边界余量 235，测试确认再加 3 种实例类型仍不超限。CI 超限即失败。
7. **工作负载边界与 SSM Agent**：实验机的 Agent 要读关联与 `ATL-PrepareInstance`、要写录制日志，所以工作负载边界的 DenyPlatformByArn
   不含关联，改由 `ProtectSsmPlatform` 只拒绝修改 / 删除关联与 `ATL-*` 文档；SSM 文档与录制日志组只打 `Project=ATL`，不打
   `atl:component=platform`（否则会被工作负载边界的 DenyPlatformByTag 拦截）。
8. **标签**：`CloudAlbumAppRole` 不打 `atl:component`（学员在工作台给它附加模块策略，按 platform 标签会被拒绝；由 ProtectAppRole /
   KeepPlatformChannel 保护）；`ATLWorkstationRole` 打 `workstation`（Provisioner 边界只拒 `platform`，可以 PassRole）。
9. **小幅补充**：`ProtectLabStateStore` 的 NotAction 加 `s3:GetBucketPolicy`（07 V5-2 G3 期望只读允许）；`ATLLearnerIam` 加
   `UpdateAssumeRolePolicy`、`PutRolePermissionsBoundary`、`Tag/UntagPolicy`、`Tag/UntagInstanceProfile`（CloudFormation 传播栈标签、
   LabIamResourcesOnly 的前提），仍受边界与护栏约束；`ATLRunnerServiceRole` 加 `atl-data` 的 `runs/`、`archive/` 写入（02 §4.3 post_build）
   与 S3 源所需的 `GetBucketLocation/Acl/Versioning`；`ATLCustomResourceRole` 加 `cognito-idp:AdminCreateUser/AdminAddUserToGroup/AdminGetUser`
   （`AssistantEmails` 由 SeedData 创建）与预检只读。atl-agent 的写入限 `LeadingKeys` = `SESSION#*`、`IDEMP#*`、`AUDIT#*`，atl-pricing 限
   `PRICE#*`、`USER#*`，atl-public 限 `CERT#*`、`KEY#*`。`test/inventory.test.ts` 按 01 §6.9 的清单核对每个函数角色。
10. **EC2 信任的 `aws:SourceAccount`**：由 `release.config.json` 的 `ec2TrustSourceAccount` 控制（默认按 01 加上）；07 V1-6 不成立时改为 false
    重新打包。工作台的 `atl:active-session-id` 信任回退（`UpdateAssumeRolePolicy`）未预授权，07 V1-1 失败时再加到 atl-lifecycle 角色。
11. **事件载荷**（atl-lifecycle / atl-tagger 是按 `action` 分派的）：`atl-sfn-failed` 投递 `{"action":"ExecutionFailed","event":<事件>}`；
    `atl-budget` 以 SNS 订阅直接调用 atl-lifecycle（SNS 信封，`Records[0].EventSource = aws:sns`，需映射到 `BudgetAlert`）；
    `atl-tagger-api-calls` 投递 `{"action":"TagFromCloudTrail","event":…}`。
12. **函数环境变量**：`PLATFORM_ENV_VARS` 全部（`ATL_DEV_MODE` 永不出现），另加 `ATL_RELEASE`、`ATL_HTTP_API_ID`、`ATL_AGENT_API_ENDPOINT`、
    `ATL_PLATFORM_URL`、`ATL_DISTRIBUTION_ID`、`ATL_STACK_NAME`、`ATL_INSTALLATION_ID`、`ATL_TERMINAL_RECORDING`。CodeBuild 项目的静态变量：
    `ATL_RELEASE`、`ATL_RELEASE_PREFIX`、`ATL_REGION`、`ATL_ACCOUNT_ID`、`ATL_DR_REGION`、桶 / 表名、`ATL_PROVISIONER_ROLE_ARN`、`ATL_AGENT_API_ENDPOINT`、
    `ATL_WORKLOAD_BOUNDARY_ARN`、`ATL_ASG_MAX_SIZE_LIMIT`、`ATL_WORKSTATION_{INSTANCE_TYPE,INSTANCE_PROFILE,BUNDLE_URI,BUNDLE_SHA256}`、
    `ATL_CHECKS_BUNDLE_DIGEST`；`ATL_OP` 等由编排逐次覆盖。
13. **DefinitionSubstitutions**：由 `DEV_SUBSTITUTIONS` 的取值推导（函数名 → 函数 ARN；状态机 ARN → 本账号本区域同名状态机；其他键查
    `KNOWN_SUBSTITUTIONS`），每个状态机只传自己用到的占位符；ASL 用了没有映射的占位符时构建失败。
14. **卸载守卫**：Create / Update 只把“属于栈的策略”清单（`KeepPolicies`，测试核对与三个角色声明的一致）写入 `PlatformConfig.uninstallGuard`。
    Delete 先置 `mode = UNINSTALLING`；没有非终态会话、复扫窗口内的会话、未释放的环境，且 `ATLLearnerRole` 上没有 `ATLRevokedSessions` 时
    走快速路径（直接清理角色并回调，也覆盖安装失败的回滚）；否则以 `uninstall-<PlatformConfig.uninstallSeq>` 启动 `atl-platform-uninstall`，
    输入 `{trigger: 'guard', cfn: {responseUrl, requestId, stackId, logicalResourceId, physicalResourceId}, keep, deadlineAt}`，守卫自己不回调。
    `UninstallRoleCleanup` 核对 `mode = UNINSTALLING` 且无非终态会话后才清理，保留清单优先取输入 `keep`，其次 PlatformConfig；任何失败回调 FAILED。
15. **StackGuard**：先开终止保护再写栈策略；`SetStackPolicy` 若在 `CREATE_IN_PROGRESS` 被拒，不让整个安装回滚，记录到
    `PlatformConfig.stackGuard`（07 V5-1 第 2 步核对）。
16. **JwksPublish** 只发布 `jwks.json` 与 `SigningKey`；空的签名吊销列表需要 `kms:Sign`（01 §6.9 只给 atl-certs），由 atl-certs 首次运行时发布。
17. **WebDeploy**：没有 `atl-web.zip` 内容时发布占位页（`platform/web` 下一轮）；内容包根目录 `manifest.json` 的 `catalogVersion`（缺省用
    `contentDigest`）决定 `content/<catalogVersion>/`；`private/` 写入 `atl-artifacts releases/<ver>/private/`；写 `CatalogRelease` 与 `CATALOG/CURRENT`；
    从不删除对象，也不写 `.well-known/`、`public/`、`share/`。
18. **Cognito**：功能层级 `LITE` + 经典托管登录（`ManagedLoginVersion: 1`，TOTP 可用，以 07 为准）；回调 `<PlatformUrl>/auth/callback`（08），
    登出 `<PlatformUrl>/`；邀请邮件不含平台地址（避免 User Pool ↔ CloudFront 的循环依赖），写“打开栈输出 PlatformUrl”。
19. **发布**：`ReleaseVersion` = `v<VERSION>`；Rule 只接受它或 `dev`；已验证区域暂只有 `ap-northeast-1`。GitHub 源为
    `https://github.com/<githubRepository>/releases/download/<ReleaseVersion>/<file>`。`build/package.ts` 输出 `dist/release/<tag>/`（全部资产 +
    `SHA256SUMS` + `release-manifest.json` + 模板 + `launch-stack.md`），模板内嵌清单；`SHA256SUMS` 另有 `# checks-bundle-digest <hex>` 行（dev 安装用）。
    模板大于 51,200 字节，01 §4.9 的 `aws cloudformation deploy` 需要加 `--s3-bucket`（`publish-s3.ts` 打印完整命令）。
20. **工作台引导包**：`atl-agent-call`、`atl-write-session-files` 用 esbuild 打成单文件 CJS；session-manager-plugin、k6、检查包、arm64
    `node_modules` 由参数或环境变量提供（`--ssm-plugin-rpm`、`--k6-tarball`、`--checks-dir`、`--workstation-node-modules`），缺失时只告警。
    不含 `node_modules` 的源码构建由 user data 在启动时 `npm ci`（需访问 npm 源，偏离 03 §4.5“启动时不访问第三方源”，正式发布应传入预构建结果）。

### 3. 需要其他实现者配合

- **02 / workflows**：atl-lifecycle 登记 `ExecutionFailed`，把 SNS 信封映射为 `BudgetAlert`；卸载编排按第 14 条的输入结束时调用
  `UninstallRoleCleanup`（`{action, cfn, outcome, reason}`）；`POST /platform/uninstall/prepare` 用同一个 `uninstallSeq`；运行器 `workstation-up`
  以 `platform/workstation/templates/atl-workstation.yaml` 建栈，参数 `SessionId, EnvName, EnvId, LabId, InstanceType, VpcId, SubnetId, BundleUri,
  BundleSha256`（后三项取 CodeBuild 的 `ATL_WORKSTATION_*`），VpcId / SubnetId 为默认 VPC 的公有子网。
- **API**：可读取第 12 条的附加环境变量；平台准备卸载时 `UpdateTerminationProtection` 的栈名用 `ATL_STACK_NAME`。
- **检查包（06 PM-04）**：构建输出 `platform/infra/checks-bundle/dist/{checks/<digest>/…, bin/atl-check}`（或 `ATL_CHECKS_BUNDLE_DIR`）；
  CloudAlbum 发布包 `build/release/cloudalbum-<ver>-<arch>.tgz`（`scripts/release`）由 package.ts 自动拾取。
- **labs**：`labs:policy` 写 `platform/infra/policies/generated/verifier-readonly.json`（IAM 动作形式的策略文档）；`labs:build` 的
  `dist/content/<digest>/manifest.json` 带 `catalogVersion`。
- **根 / platform 的 package.json（不在本节路径内）**：`platform/package.json` 的 `publish:s3` 改为转发到 `npm run publish:s3 -w @atl/infra --`；
  `platform:build` 可追加 `npm run package -w @atl/infra`。

## platform-checks

04 的检测引擎、进度、报告与证书（`atl-checks`、`atl-certs`、`atl-public`）以及实验机检查包。名称一律取自 `@atl/shared`。

### 1. 目录

```
platform/checks/                     实验机检查包（只用 Node 内置模块；README.md 写明构建与发布契约）
  bin/atl-check                      /opt/atl/bin/atl-check：复核 SSM_* 参数 → 按摘要选目录 → 复算 manifest 摘要 → exec node runner
  bin/atl-check.mjs                  同一启动器的 Node 版（ATL_DEV_CHECK_RUNNER 与测试用，不进发布包）
  src/runner.mjs                     参数第三道复核、逐文件 SHA-256、batch（≤ 10）、args schema、ATL-RESULT-V1 行（≤ 16 KB 截断）
  src/checks/<checkId>.mjs           04 §6.4 的 25 个 checkId（别名 atl.capabilities、atl.lab-metrics、cloudalbum-probe-token）
  src/args-schemas.mjs src/lib/      args schema、宿主上下文（CloudAlbum CLI、IMDSv2、探测令牌）、HTTP 探测、capabilities 投影
  build.mjs                          → dist/atl/{bin/atl-check, checks/<bundleDigest>/…}、dist/bundle.json
platform/api/src/functions/checks/   atl-checks
  handler.ts index.ts flows.ts       动作：RunChecks、SubmitAttempt、FinalizeAttempt、HealthGate / RunHealthGate、Preflight、StepAction、
                                     ApplyManualConfirmation / ApplyManualReview、CrossCheckExperiment、ExperimentRegistered、ExpiringPrecheck、
                                     LateOwnership、CleanupVerify、DriftPatrol；EventBridge 事件 session.state_changed、reclaim.pass_completed
  lifecycle-gates.ts                 atl-lifecycle 的 Preflight / RunHealthGate 契约（按 lifecycle 的请求与结果形状）
  types.ts                           04 §5.1 检查定义、结果、证据信封、CheckRun 结果项
  engine/                            jsonpath、template（{{ ns.path | filter }}、{{$.…}}、{{$check.…}}）、expr（when）、assert（21 个运算符 +
                                     where / anyOf / severity / pendingIf）、healthy、redact、evidence、runcheck（ATL-RunCheck 客户端）、discovery、
                                     ownership（栈 → 台账 → 父资源 → OwnershipLookup）、targets、safe-fetch + net（出站防护）、builtins、
                                     experiments（§7.4）、context（变量命名空间、白名单调用、缓存、重试）、executors、run、facts
  verifier/allowlist.ts iam-map.ts   04 §5.7 白名单、禁止清单、SDK 操作 → IAM 动作
  aws/engine-ports.ts                生产端口：扮演 ATLVerifierRole（会话名 atl-<sid>-verify + 会话标签）调用白名单 SDK、SafeFetch、ip-ranges.json
  dev/engine-ports.ts                ATL_DEV_MODE 端口：FakeAws（dev 约定 + fixtures）、DevHttp（*.dev.atl.test → 本地 CloudAlbum）
platform/api/src/functions/certs/    atl-certs（报告、导出、分享、证书、吊销列表、JWKS、验证页）；invalidate.ts（CloudFront 失效）
platform/api/src/functions/public/   atl-public：publicHealth、publicGetCertificate、publicListKeys、publicGetKey
platform/api/src/services/progress/  store（ItemStore + 乐观锁 mutate）、model（有效结果、步骤状态、完成规则、证据分、徽章等级）、evaluator（折叠结果、
                                     漂移、步骤重算）、attempt（LabAttempt、LabProgress、徽章、计入）、tracks（路径进度、掌握度）、events
platform/api/src/services/reports/   report（atl.report/v1 + RFC 8785 摘要、修订）、html（自包含 HTML）、charts（内联 SVG）、publish（导出、分享）
platform/api/src/services/certificates/  jws（ES256）、service（密钥、资格、载荷、签发、吊销、公开）、static-site（验证页、jwks、离线包）、
                                     verify-core（验证算法的 JS 源码，验证页 / 离线工具 / 测试共用）
```

### 2. 关键实现

- **检测流程**：`RunChecks` 由 atl-checks 自己写 `CheckRun`（atl-api 只派发 runId）→ 按 `dependsOn` 排序执行 → 结果只追加 → ProgressEvaluator
  折叠进 `StepResult.checks`（`lastAuto`、`lastDecisive`、`lastPass`、`passEvidence`、`lastManual`）→ 重算全部步骤 → 事件 `check_run.completed`、
  `step.state_changed`、`step.drifted`。单次运行预算 180 秒，超出的检查记 `error/TIMEOUT`。
- **六种类型**：`local`（ATL-RunCheck，`instances: all` 逐台判定）、`capability`（每次运行每实例一份快照，`op: healthy` 用卡片 / 检查级
  `expectedWarnings`）、`http-header`（`from: platform` 走控制面解析的目标 + SafeFetch，`/api/lab/probe/*` 先经 `probe-token` 取一次性令牌；
  `from: lab` 走 http-probe；`browser` 只展示，记 `skipped`）、`aws-readonly`（代码白名单 → 扮演 ATLVerifierRole → 分页 ≤ 5 → `expectError` →
  `ownership`）、`experiment`（ExperimentRun.validity + 变体角色 + 成对可比）、`manual`（运行中记 `not_run`，有效结果来自手动确认）。
- **伪造响应头的防护**（04 §11.4）：平台探测只连控制面解析出的主机（直连已校验的 IP，SNI / Host 用主机名），佐证 `ip-in-aws-ranges`、`tls-san`、
  源站日志 nonce 计数、源站直连不得带 CDN 头（失败记 `SPOOF_SUSPECTED`）。探测令牌只在内存中使用，证据中打码。
- **归属**：栈成员（栈 CreationTime ≥ 边界、带本环境 `atl:env-id`、非导入）→ `SessionResource`（创建者会话名属于本会话 / 同一学员的交接链 /
  `session-or-start` 的运行器 / 本环境栈中的角色）→ 父资源（`aws:cloudformation:stack-name`、`aws:autoscaling:groupName`）→ atl-reaper
  `OwnershipLookup`（02 §7.12 的请求与结果）。查不到为 `pending/OWNERSHIP_PENDING`，节奏 2、2、4、4、8 分钟记在 `LabAttempt.ownershipLookups`；
  超过 `maxWaitMinutes`（从步骤开始起算）→ `fail/OWNERSHIP_MISMATCH`。证据记 `provenance`。
- **漂移**：must-hold 检查 pass → fail 记 `driftEvents`（config / runtime / behavior / ownership），步骤 `drifted`；`once` 检查通过后保持通过（实验检查
  除外：对比实验被判无效会让步骤回到 failed）；`supersedes` 生效后被取代步骤的 must-hold 降为 once。最终复核只重测 must-hold 与尚未通过的 once 检查。
- **定稿** `FinalizeAttempt`：幂等（`LabAttempt.finalize`）、不抛出（失败 → `unverified`）、READY 之前结束 → `void`；重测 → 等在途上传（≤ 预算一半）→
  完成规则 → 徽章（证据分、等级、计入的服务格）→ 同步调用 atl-certs `GenerateReport` 得到 `reportRevision` → 证书资格。
- **证书**：载荷 RFC 8785 规范化，JWS `{alg: ES256, typ: atl-cert+jws, kid}`，签名经 `SignerPort`（生产 KMS DIGEST + DER→P1363；dev 本地 P-256）。
  `kid` = JWK 指纹；`SigningKey` 首次使用时登记，换密钥时旧密钥 `validTo` 关闭；`/.well-known/atl/jwks.json` 含全部用过的公钥与 origins；吊销列表
  `typ: atl-revocations+jws`、`seq` 递增、全量重签。验证算法只有一份 JS 源码（`verify-core.ts`），验证页 `verify/verify.js`、离线 `verify.mjs` 与测试
  共用；同一路径重新领取时旧证书以 `superseded` 吊销。

### 3. 设计有歧义时的取舍（偏离或细化 04）

1. **代码位置**：检查包源码在 `platform/checks/`（任务指定；04 §6.2、06 PM-04 写的是 `platform/infra/checks-bundle/`）；检查定义与引擎在
   `functions/checks/`（04 写的 `platform/api/src/checks/…`、`content/check.ts`）；白名单与映射在 `functions/checks/verifier/`；出站防护库在
   `engine/safe-fetch.ts`（01 写的 `src/net/safe-fetch.ts`，供 atl-api 预览探测共用，集成时可移动）。
2. **内容格式** `content/<v>/labs/<id>.json`：接受两种形状——`{schema: 'atl.card/v1', lab, checks, sources?, checkHashes?, pitfalls?}`，或展开后的
   `atl.lab/v2` 顶层对象另带 `checks`（或 `checkDefs`，按本地 id 的展开检查）、`pitfalls`、`checkSources`、`checkHashes`、`contentDigest`。`checkKey`
   一律为 `<本卡 id>/<本地 id>`；`finalChecks` 存在伪步骤 `_final`，`cleanup.verify` 的结果只进报告。路径定义取 `content/<v>/tracks/<id>.json`，
   没有时取 `catalog/index.json` / `index.json` 的 `tracks[]`。
3. **检查包摘要与文档钉扎**：取 `PlatformConfig.checks.{bundleDigest, runCheckDocumentVersion, runCheckDocumentHash}`，没有时取函数环境变量
   `ATL_CHECK_BUNDLE_DIGEST`、`ATL_RUNCHECK_DOCUMENT_VERSION`、`ATL_RUNCHECK_DOCUMENT_HASH`（需 01 登记其一）。
4. **dev 引擎接线**：生产入口传 `prodEnginePorts`；`createChecksHandler(getDeps)` 的缺省也是生产端口，但它在 `ATL_DEV_MODE` 下直接拒绝运行（不会碰
   AWS）。dev 运行时需要改一行：`createChecksHandler(getDeps, undefined, createDevCheckEngine({ dataDir: cfg.dataDir }))`。
5. **sample.***：`nonce` 每次运行生成；`assetPath` 取应用首页引用的第一个 `/assets/` 文件名（平台经公网入口自己 GET `/`）；`privateMediaPath` 取
   `/api/lab/probe/media-url`（06）的 `path` 或 `url` 的路径部分。
6. **步骤开始时间**：`StepResult.firstViewedAt`，其次第一次检测时写入的 `startedAt`；等待型检查与归属等待都以它起算。
7. **结果取值**：`manual` 检查在运行中记 `not_run`；`http-header from: browser` 记 `skipped/PRECONDITION`；声明了 `expectError` 但调用成功 → `fail`。
   步骤状态在 04 §8.3 的函数上补两点：`skipped` 的检查不进分母；没有必需检查的步骤在“已读”后为 `done`。
8. **证据**：脱敏后 ≤ 4 KB 内联，否则写 `atl-data/evidence/<sid>/<runId>/<checkKey>.json`（checkKey 含 `/`，即子目录）；`CheckRun.results[]` 另带
   `keyAssertions`、`drift`、`pitfalls`、`pendingCrosscheck`、`simulated`。常见错误按 `pitfalls[id].match` 匹配。
9. **subject.ref / attemptRef**：HMAC-SHA256，密钥由 `PlatformConfig.installationId` 派生（01 未给 installSalt；它与 installId 都公开，只能避免直接
   暴露 sub / sid，不能防字典比对；建议 01 增加不公开的盐）。
10. **健康门**：`caps.profile` 的期望 = 起始档位中 `kind: module` 的条目（驱动 `*`，只判健康）；目标模块不参与（02 §3.6）。卡片内容缺失时健康门照常
    执行（最小卡片）。`RunHealthGate` 的 `NOT_READY` = 失败全部是通道 / 运行器 / 超时类错误。
11. **Preflight**：默认 VPC（FAIL `PREFLIGHT_NO_DEFAULT_VPC`）、目标涉及 GuardDuty / Config / CloudTrail 时的已有单例（WARN）、配额只提示；预检型变体的
    预检键只认 `preflight.tlsAcme`，取 `PlatformConfig.preflight.keys.tlsAcme`，未知时视为可用；基线清点用 `tag:GetResources` 的高成本类型（只覆盖带
    标签的资源），写 `InventorySnapshot`。
12. **对比实验交叉校验**：第 4 步的登记时快照由 `ExperimentRegistered`（atl-agent 登记后异步调用）写入 `ExperimentRun.platformDrivers.registration`；
    第 5 步按 `client.byTarget[kind].requests`（只有一个目标时用总数）与 `lab-metrics` 的 `app.byTarget` 核对；CloudFront 指标未接入；服务端指标不可得
    或窗口未关闭 → `pending-crosscheck`；最少样本数缺省 5。由 pending 变 invalid 且该次尝试已完成 → 撤回徽章并通知 atl-certs 吊销引用它的路径证书
    （`evidence-invalidated`）。
13. **报告**：内容（去掉 revision / generatedAt）不变时不产生新修订；费用一节只列报价与按台账计算的资源时长，不写任何单价或金额（单价归 atl-pricing）；
    分享副本强制打码（账号、公网 IP、实例 / 分配等 ID 中段、入口主机名、会话名），不显示手动确认备注；分享到期调度 `atl-share-<id>-exp`（组
    atl-system，载荷 `{kind: SHARE_EXPIRE, shareId}`），shareId → sid 的指针存 `atl-data/reports/_shares/<id>.json`。
14. **CloudFront 失效**：分配 ID 取 `ATL_WEB_DISTRIBUTION_ID`；未设置或 dev 模式时跳过（这些文件本身短 TTL）。
15. **ATL-RunCheck 启动器**：`ArgsB64` 的长度单独检查（部分正则引擎的 `{m,n}` 上限为 255）。

### 4. 测试

```bash
npx vitest run --project atl-api test/checks-pure.test.ts test/checks-bundle.test.ts test/checks-engine.test.ts \
  test/progress-reports.test.ts test/certs.test.ts                                   # 无需 Docker
npm run platform:db:up && ATL_IT=1 npx vitest run --project atl-api test/checks-store.int.test.ts
```

`checks-engine.test.ts` 用真实构建的检查包、dev `LocalRunCommand`、dev 引擎与一个本地 CloudAlbum 替身，覆盖全部检查类型、归属（pending → found、not
owned）、伪造响应头、一次性探测令牌、漂移、手动确认、对比实验、提交 / 定稿 / 徽章、健康门与预检；`certs.test.ts` 覆盖签名与验证往返（服务端
WebCrypto、验证页核心、离线工具）、篡改、未知密钥、吊销、取代与 atl-public 路由。

### 5. 需要配合

- 集成：dev 运行时接线（第 3 节第 4 条）；`platform:build` 与 `scripts/release` 调用 `node platform/checks/build.mjs`，发布包放 `atl/bin/atl-check` 与
  `atl/checks/<digest>/`，`.release-manifest.json` 写 `atlBundleDigest`，平台发布登记同一摘要；dev 设
  `ATL_DEV_CHECK_RUNNER=platform/checks/dist/atl/bin/atl-check.mjs`。
- labs:build / dev 内容发布：`labs/<id>.json` 带上展开后的 `checks`（第 3 节第 2 条），否则引擎没有检查可执行。
- infra：atl-checks 设 `ATL_CHECK_BUNDLE_DIGEST`、`ATL_RUNCHECK_DOCUMENT_VERSION/HASH`（或写 `PlatformConfig.checks`）；atl-certs 设
  `ATL_WEB_DISTRIBUTION_ID`；`atl-events` 规则把 `session.state_changed`、`reclaim.pass_completed` 投给 atl-checks；`ATLVerifierRole` 的只读语句用
  `verifierIamActions()` 生成。
- atl-api：`IssueCertificate` / `RevokeCertificate` / `ExportReport` / `OfflineBundle` 用同步调用（证书错误抛 `Atl.CERT_NOT_ELIGIBLE` 等，带 `reasons`）；
  `GET …/progress` 轮询时可异步调用 `DriftPatrol`（10 分钟惰性巡检）；trackProgress / mastery 可复用 `services/progress/tracks.ts`。
- atl-agent：登记实验后异步调用 `ExperimentRegistered { sessionId, runId }`（第 4 步的登记时快照）。
- atl-reaper：实现 02 §7.12 的 `OwnershipLookup`；台账键用资源所在区域（全局服务为 us-east-1）计算 `resourceKey`。
- atl-timer：`SHARE_EXPIRE` 把载荷原样转给 atl-certs（handler 按 `kind` 识别）。
- 06：CloudAlbum CLI（`platform-status`、`capabilities`、`probe-token --count`、`lab-metrics`、`path-seen`、`app-stat`、`module-state`）按 06 的 JSON
  输出；`/api/lab/probe/media-url` 返回 `path` 或 `url`。
- 01：登记第 1 节的新动作名、`PlatformConfig.checks`、`ATL_WEB_DISTRIBUTION_ID` 等变量、`LabAttempt` 的新增属性（`ownershipLookups`、`finalize`、
  `checksSummary`、`evidenceScore`、`missing`、`lastExpiringPrecheckAt`、`lastDriftPatrolAt`）、`InventorySnapshot` 字段、不公开的引用盐。

## platform-lifecycle

会话生命周期（02 全文，01 §3.3～§3.5、§6.3、§6.7）：六个状态机、atl-lifecycle（唯一状态写入者）、atl-timer（含 SWEEP）、atl-reaper（回收器与
OwnershipLookup）、atl-runner（buildspec + 运行器）。名称一律取自 `@atl/shared`。

### 1. 目录

```
platform/workflows/statemachines/*.asl.json  六个状态机按 02 §4.4、§6.6、§7.6～§7.7、§10.5 展开（全部 DefinitionSubstitutions 见 DEV_SUBSTITUTIONS）
platform/workflows/src/asl/load.ts           DEV_SUBSTITUTIONS 增加 6 个 *StateMachineArn；definitionPlaceholders()
platform/workflows/src/simulator/engine.ts   addListener()（dev 用它模拟 atl-sfn-failed 规则）
platform/workflows/src/runner/               运行器：context（ATL_* + atl-main 三条记录 → buildAgentContext/toSessionEnv）、plan（ATL_OP → 步骤）、
                                             policy（会话策略）、execute（执行与 result.json）、sigv4、secrets（argon2id PHC）、main（pre|build|post|credentials）
platform/workflows/runner/buildspec.yml      01 §3.4 的 buildspec；runner/build.mjs 打包到 runner/dist/atl-runner.mjs（发布包内）
platform/api/src/functions/lifecycle/        handler（动作表）、start / end / requests / module-op / uninstall / ops、rules（预算、分类、延长）、
                                             timers、store/*（atl-main 访问）、cloud/port.ts（本目录专用端口）、cloud/aws.ts（生产实现）、cloud/sdk.ts
platform/api/src/functions/timer/            kinds（一次性调度）、sweeper（SWEEP）
platform/api/src/functions/reaper/           handler + reclaimer/（discovery、actions、ledger、rules、extractors、identity、derived、rate、arn、aws.ts）
platform/api/src/functions/{rescan,ownership}/  ConcludeRescan / FinishFollowUp；OwnershipLookup（atl-reaper 的动作）
platform/api/src/orchestrator-dev/           dev 实现（DevLifecycleCloud、DevReclaimCloud）、installLifecycleDev(rt)、server.ts
platform/api/test/lifecycle/                 状态机端到端（真实 ASL + 模拟器 + 虚拟时钟 + 内存表，ATL_IT=1 可改用 DynamoDB Local）与纯规则测试
```

### 2. 接线与隔离

- 生产：`functions/{lifecycle,timer,reaper}/index.ts` 调 `setProductionClouds(awsClouds)`；`test/lifecycle/prod-isolation.test.ts` 断言三个
  bundle 不含 `src/orchestrator-dev`、`src/dev`、模拟器与测试代码。生产代码不 import dev 代码；dev 只经 `provideClouds(deps, …)` 注入。
- dev：集成阶段在 `src/dev/runtime.ts` 建好运行时后调用 `installLifecycleDev(rt)`（结构化类型，不依赖 dev 内部类型）；它注入两个 dev 云、
  在 atl-checks / atl-custom-resources 返回 `Atl.NotImplemented` 时提供 Preflight / RunHealthGate / FinalizeAttempt / UninstallRoleCleanup 的
  兜底，并用 `sim.addListener` 模拟 EventBridge 规则 `atl-sfn-failed` → `HandleExecutionFailure`。独立入口：
  `npx tsx platform/api/src/orchestrator-dev/server.ts --dev-mode`。
- 故障注入：模拟器的 `faults`（按状态 / 状态机 / 次数），ScriptedRunner 的 `fail(op|runId 前缀, {exitCode, cfnFailures, status, noResult})`，
  DevReclaimCloud 的资源行为 `ok | pending | retry | denied | protected`，FakeTrailLookup 的投递延迟。

### 3. 动作契约（atl-lifecycle，载荷 `{ action, … }`，错误 `name = Atl.*`，映射见 errors.ts 的 LIFECYCLE_ERROR_CODES）

- API：`CreateSession`（扁平形式或 lifecycle-client 的 `{sessionId, sub, labId, variant, quoteId, reuseEnvId, session}`；返回
  `{sessionId, state, ver, executionArn}`，同时启动 `start-<sid>`，API 再启动时得到 ExecutionAlreadyExists）、`Transition`（RUNNING / EXPIRING /
  REQUESTED→ENDED 返回会话项；PROVISIONING、CLEANING 只给状态机用）、`Heartbeat`、`Extend`、`RequestEnd`、`KeepExtend`（别名 `ExtendKeep`，
  `expectedKeepVersion` 不符 → `Atl.PreconditionFailed`）、`ReleaseKept`、`RetryCleanup`（`expectedRetryCount` 防并发）、`ResolveCleanup`、
  `Open/CloseOutageWindow`、`BudgetAlert`（SNS 事件亦可）、`HandleExecutionFailure`（EventBridge 事件亦可）。
- atl-checks（04）：`Preflight {sessionId, envId, fresh, labId, variant, startProfile, preflightVariants, regions, …}` → `{result: PASS|WARN|FAIL,
  items, warnings, variant}`；`RunHealthGate {sessionId, envId, profile, gates, expectedWarnings, targetModules}` → `{status: PASS|FAIL|NOT_READY,
  report}`；`FinalizeAttempt {sessionId}`（600 s，失败只记阶段）。
- 状态机内部动作见 handler.ts 的 ACTIONS（ValidateQuote … FinishUninstall）；atl-reaper：CaptureLedger、PlanDiscovery、DiscoverPage、
  RecordDiscoverGap、BuildDeletionPlan、DeleteItem、PollItem、MarkManual、Verify、OwnershipLookup、ResolveItem、PurgeEnvState。

### 4. 有歧义处的取舍（选最简单且符合文档的）

1. **运行 ID**：`<sid>-<缩写>-<n>[-<m>]`；工作台删除 `{sid}-wsdown-{endSeq}`、拆除 `{sid}-destroy-{endSeq}-{attempt}`、步骤部署的卡片自带栈
   `{sid}-xstk-{100+n}`；结束阶段 endSeq：首次 1、释放 2、第 k 次重试 2+k。回收执行名 `reclaim-<envId>-<mode>-<endSeq>`；清扫器补做的复扫
   `reclaim-<envId>-rescan-<10+k>`；卸载的即时复扫 `reclaim-<envId>-uninstall-1`。
2. **节省模式**：02 的 SuspendEnvironment Lambda 改为运行器 `suspend` 的 `.sync` 构建（lifecycle 角色没有 StartBuild 权限）。
3. **atl-checks 动作名** 用 `Preflight` / `RunHealthGate` / `FinalizeAttempt`（04 已按此实现，见 platform-checks 节）。
4. **回收器规则表与提取器** 放在 `platform/api/src/functions/reaper/`（01 §13 写 `platform/workflows/reclaimer/`）：生产 bundle 不得包含
   platform/workflows（build.mjs 的守卫）。
5. **CloudTrail 扫描** 只用 `ReadOnly=false` 查询，客户端按事件名过滤；`LookupEvents` 令牌桶 2/s，同一调用内最多等待 3 s，否则
   `THROTTLED` / `Atl.Throttled`（ASL 重试）。
6. **时间** 一律存 ISO 字符串；阶段名取 08 §9.2 第 8 条。**T19 保留 endReason**；**清扫器** 单次即关闭过期的中断窗口。
7. **ATLRevokedSessions** 不保存撤销时间；修剪按 `LabSession.revokedAt` 与 CredentialGrant 到期时间。
8. **回收删除的会话策略**（02 §7.6）：按条目 ARN 生成；栈与 Cloud Control 额外允许 `aws:CalledVia=cloudformation`；无法用 ARN 收窄的删除进入
   人工清单（REVIEW），条目 `meta.learnerConfirmed=true` 后才以 `Resource:*` 放行。没有专用处理程序的类型走 Cloud Control API。
9. **S6 复位**：持有（或空闲）环境锁时摘除 CloudAlbumAppRole 上全部 `cloudalbum-*` 策略与 `cloudalbum-*` 内联策略，否则只摘台账登记的附加。
10. **运行器凭证**：01 §3.4 的 `role_arn + credential_source` 配置文件无法携带会话策略（01 §6.7 第 6 条），改用 `credential_process`
    （`atl-runner.mjs credentials` 以容器凭证 AssumeRole，CLI/SDK 自动续期）。**会话策略超长**：01 的示例超过 AssumeRole 内联会话策略的
    2 048 字符上限，与会话无关的语句（只读、SSM 文档、internal 路由、CalledVia、registry 带外操作）放入托管策略
    `ATLProvisionerPolicy-RunnerSession`（`staticRunnerStatements()`，以 `--policy-arns` 传入），内联部分只含环境范围语句；CloudFormation 写操作
    收窄到 `stack/cloudalbum-<envName>-*` 与 `stack/atl-ws-<sid>`（extra-stack 只到 `-x-*`）。
11. **环境锁与 state.json** 由 `scripts/module` 自己处理（06 PM-27/28，运行器传 `--lock-wait 900`）；运行器不重复实现。`module-op`：
    `op: enable|disable` → `scripts/module <op> <module>`，其他 → `scripts/module <module> <op>`，卡片 `platformOps[].args` 转为 `--param K=V`。
    卡片自带栈的输出写入 `result.json` 的 `variables`（会话变量的持久化待 04/API 约定）。工作台模板路径取 `platform/workflows/workstation/workstation.yaml`。
12. **result.json** 增加 `schema: atl.runner-result/v1`、`step`、`warnings`、`variables`、`steps[]`；分类所需字段与 02 §4.3 一致。

### 5. 需要其他部分配合

- infra：创建托管策略 `ATLProvisionerPolicy-RunnerSession`（语句 = `staticRunnerStatements({region, accountId, apiId})`）；
  `ATLRunnerServiceRole` 需要 `dynamodb:GetItem` 于 `atl-main`（读三条记录）与对 `atl-web` `content/*/manifest.json`、`labs/*`、`stacks/*`、
  `profiles/*` 的读取；CodeBuild 源包需包含 `SHA256SUMS`、`runner/dist/atl-runner.mjs`、`cloudalbum-<ver>-<arch>.tgz`；
  DefinitionSubstitutions 取 DEV_SUBSTITUTIONS 的全部键。ReaperFunctionRole 还需 Cloud Control 读、`sts:AssumeRole`（已有）。
- API：会话视图读取 `cleanup`、`reclaim.followUp`、`phases`；动作契约见第 3 节（已适配 lifecycle-client 的 CreateSession / ExtendKeep /
  Transition 返回值）。
- 集成：`installLifecycleDev(rt)` 接入 `src/dev/runtime.ts`；`test/dev-runtime.test.ts` 的 NotImplemented 断言已改用未知的 timer kind。
- 06：确认 `scripts/module` 平台动作参数的写法（本实现用 `--param K=V`）与 `bootstrap --release-file` 的包名。

### 6. 测试

`npx vitest run --project atl-api platform/api/test/lifecycle/`（状态转换、补偿、CLEANUP_FAILED 与人工清单、延长上限、到期回收、复扫 T21、
卸载守卫、模块操作、OwnershipLookup、契约、生产隔离）、`npx vitest run --project atl-workflows`（含运行器）、`npm run platform:validate`。

## platform-cloudalbum-mode

CloudAlbum 侧的平台模式（docs/platform/06 的 P0 项）。总开关只有一个判断点：后端 `platformMode()`（backend/src/platform/mode.ts），
scripts/module 的 `isPlatform()`（`--platform` 或 `CLOUDALBUM_PLATFORM_MODE=1`）。平台模式关闭时行为与此前一致（smoke:l0 / smoke:selfhost 不变）。

### 实现范围

| 范围 | 位置 |
|---|---|
| `ATL_PLATFORM_MODE` 与 platform.env（配置层 1b，只接受 `ATL_` 键；非 ATL 键 ATL-CFG-001，其他层出现 ATL_ 键忽略并告警），SIGHUP 只重载展示字段 | backend/src/platform/{env-schema,mode}.ts、config/load-env.ts、config/schema.ts、rules/rules.ts（ATL-CFG-001/002、ATL-NET-001、ATL-IAM-001） |
| `X-ATL-Probe-Token`（本机 atlpk1、OTP atlpt1 + nonce 表防重放、实验 atllt1）与 `/api/lab/probe/{now,echo,media-url,kms,auth}`；探测流量不进 lab 指标；capabilities `?fields=` / `?modules=` 投影 | backend/src/platform/probe-token.ts、http/middleware/atl-probe.ts、http/routes/lab-probe.ts、routes/capabilities.ts、packages/contracts/src/{platform,canonical-json,capabilities-projection}.ts |
| CSP `frame-ancestors`（应用响应头 + Nginx slot 文件），平台模式去掉 X-Frame-Options | http/middleware/frame-ancestors.ts、platform/env-schema.ts `renderFrameAncestorsSlot` |
| CLI：`atl-check`（=platform-status / capabilities / module-state / path-seen / app-stat）、`probe-token`、`lab-token`、`lab-metrics`、`platform:validate-env` / `platform:apply-env`、`admin:ensure --password-hash`、`seed <id>` | backend/src/cli/platform/*.ts、backend/src/cli.ts、infra/host/cloudalbum（root 子命令包装） |
| 检查包随发行包：scripts/release 把 platform/checks 打进 `atl/`，写 `.release-manifest.json`（atlBundleDigest、ssmAgentMinVersion）；主机端 install-atl-bundle.sh 校验摘要并保留 3 份 | scripts/release、infra/host/install-atl-bundle.sh |
| Nginx：日志 `run=` 只记 ULID、`probe=`，`X-CA-Server-Port` 透传；平台 apply-env 原子写 + `nginx -t` 失败回滚 | infra/nginx/**、infra/host/platform/apply-env.sh |
| cdn 源请求策略转发 `X-Experiment-Run` / `X-Experiment-Label` / `X-ATL-Probe-Nonce`（default、/assets/*、/media/*、/api/public/*、jwks） | infra/modules/cdn.yaml |
| scripts/module 平台模式：S3 状态桶（条件写，冲突退出码 8）、DynamoDB 租约锁（300s/续约 60s，退出码 7）、标签 `atl:component=env` / `atl:session-id` / `atl:lab-id` / `atl:env-id`、SSM-only 投递（标签发现实例，密钥走 SecureString 交接参数）、进度 jsonl / result json / 模块操作上报 | scripts/module-cli/src/platform/*.ts、context.ts、deliver.ts、stack.ts |
| `plan --start-of <card> [--variant]`、`plan --profile atl/<card>/<variant>`（重新推导并比对摘要，RFC 8785 规范 JSON）、`profile gen-atl`、`PROFILE_EXTRA_STACKS`、`profile apply --mode fresh|additive --repair` | scripts/module-cli/src/{plan-start,platform-cmds,profile-cmd}.ts |
| base-deploy 平台步骤：`bootstrap --release-file`、`base deploy --delivery ssm --instance-profile CloudAlbumAppRole --key-name … --disable-rollback --retry-az`、`env destroy --fast --ledger-out`（部分失败退出码 6）、`env suspend|resume`、`wait-stable`、`status --repair`（无 id 时修复全部模块）、`status --json`、`hooks run --pending`、`iam revoke-older-sessions|refresh-instance-credentials` | scripts/module-cli/src/{index,bootstrap,platform-cmds}.ts |
| 测试数据种子：`cognito-test-users`（只接受 argon2id 哈希、保留域名、atl-test-N，幂等）、`gps-sample-photos`（运行时确定性生成带 GPS EXIF 的 JPEG，按 seed_id + digest 幂等） | backend/src/lab/seeds/*.ts、scripts/module-cli `seed` |
| 实验标签为任意变体：结果 `variant` 记录 `{label, role?, cardVariant?}`（兼容旧字符串），lab_runs.variant / window_sec；PM-40 匿名 `X-Experiment-Run` 归因 | experiments/_lib/{types,manifest,runner,collect,report}.ts、schema/result.schema.json、backend/src/observability/bypass.ts |
| L0 Let's Encrypt IP 证书预览开关：`TLS_LE_PROFILE` / `TLS_PUBLIC_IP` / `TLS_PREVIEW`，`tls-preview on --ip|off|renew|status`（失败不阻断，输出 `{"preview":"failed"}`），续期 timer | infra/host/platform/tls-preview.sh、infra/systemd/cloudalbum-tls-renew.*、backend/src/config/base-url.ts、scripts/module-cli/src/platform/tls-preview.ts |

数据库迁移 20261014_0005_atl_platform：atl_probe_nonces；lab_runs.variant / window_sec；lab_metric_rollups.status_class；users.seed_id；photos.seed_id / seed_digest。

### 有歧义处的取舍

- 检查包来源目录用 `platform/checks`（脚手架实际位置），不是文档中的 `platform/infra/checks-bundle`。
- GPS 样例照片在 `seed` 时用 sharp 确定性生成，没有在发行包里放 `seed/` 二进制资源。
- `path-seen` 的模式用 JS 正则的安全子集（拒绝反向引用、环视、嵌套量词）代替 RE2，避免新增原生依赖。
- 平台模式密钥交接：写 SecureString `/cloudalbum/<env>/handoff/<opId>-<n>`，远端脚本读后删除；脚本正文不含明文密钥（`containsInlineSecrets` 断言）。
- 平台模式不从实例回读已有密钥（`readRemoteSecrets` 返回空），重新启用 cdn / database 会生成新密钥。
- `iam:install-keys`（keys 模式）未实现，返回 NOT_IMPLEMENTED（退出码 2）；平台模式 `enable iam --mode keys` 拒绝（PLATFORM_ACTION_REQUIRED）。
- `--delivery` 是全局选项：平台模式只接受 ssm（ssh 报 DELIVERY_SSH_FORBIDDEN）；非平台模式覆盖 state.json 中的通道。
- `disable` / `iam …` 接受运行器传入的 `--param K=V`（卡片 platformOps args）但不使用；`enable` 的 `--param` 仍是栈参数。
- scripts/release 不在原分工路径内，但检查包随发行包是 P0 必需，故修改并在此说明。

### 需要其他部分配合

- 01（平台 IAM）：学员 / 运行器角色需 `ssm:PutParameter` / `ssm:DeleteParameter` 于 `/cloudalbum/<env>/handoff/*`，实例角色读取用 AmazonSSMManagedInstanceCore + 对应 KMS 解密；状态桶与锁表的权限按 PM-26 的名字。
- modules/registry.yaml（PM-34 扩展字段 `platformActions` / remedy 表）不在本标签路径，SINGLE_LOCAL_SETTINGS 仍在代码中。
- experiments/ec2/smoke.ts 的 S02 / S28 / S29 不存在，未添加；PM-22 cookie/CSRF、PM-46 保留域名邮件（SES 驱动仍为桩）、identity-pool 探测、DEP-029 平台解释未做。

### 依赖

scripts/module-cli 动态导入 `@aws-sdk/client-dynamodb`、`@aws-sdk/client-cognito-identity-provider`、`@aws-sdk/client-rds`、`@aws-sdk/s3-request-presigner`、`@smithy/signature-v4`、`@node-rs/argon2`（当前在根 node_modules 中已提升可用，未写入 package.json，需集成阶段补到 scripts/module-cli/package.json）。cfn-lint 本机未安装，cdn.yaml 只做了模板单元测试。

### 如何测试

```
npm run build
npx vitest run --project backend backend/test/platform     # 平台 HTTP / 单元 / 种子
npx vitest run --project module-cli                         # 含 platform、templates-platform、runner-argv
npx vitest run --project experiments
npm run smoke:l0 && npm run smoke:selfhost
```

## platform-content

ATL 内容部分（labs/**、scripts/labs/**）：把 docs/platform/cards/ 转成 `atl.lab/v2` 内容，并实现 `labs:schema / lint / derive / build / catalog / policy`。
不调用任何 AWS API；start-state 推导调用本仓库的 `scripts/module plan --start-of`（只读，不部署）。

### 实现范围

| 范围 | 位置 |
|---|---|
| 第一批 10 张完整卡片：lab.yaml、manual/*.md（00 overview / 步骤 / 90 wrap-up / 95 cleanup）、checks/*.yaml、quiz.yaml、assets/badge.svg、CHANGELOG.md | labs/{svc-ec2,svc-iam,svc-storage,svc-cdn,svc-queue,svc-image-processing,svc-cache,svc-database,svc-auth,sc-static-acceleration}/ |
| 其余 46 张：只有目录元数据的 lab.yaml，`status: planned`（目录可见、不可开始），版本 0.1.0 | labs/<id>/lab.yaml，schema 由 `plannedLabSchema()` 从 LAB_SCHEMA_V2 派生 |
| 学习路径 9 条（tracks-and-catalog §4）、目录分类与费用档位权重、计费维度（不写单价）、跨卡共享检查 no-world-ssh | labs/_tracks/*.yaml、labs/_catalog/{taxonomy,catalog}.yaml、labs/_pricing/dimensions.yaml、labs/_shared/checks/ |
| 工具：lint（04 §3.5 A1–A20、B21–B25，05 C-1–C-15，ajv JSON Schema）、derive（DRV-1…11，先用 `scripts/module plan --start-of`，再用 `plan --profile` 交叉核对；不可用时退回内置参考推导）、build、catalog、policy、schema | scripts/labs/src/**，CLI `npx tsx scripts/labs/src/cli.ts <cmd>`（`npm run labs:*`） |
| build 产物（dist/content/<catalogVersion>/）：index.json 与 catalog/index.json（atl.catalog-index/v2）、catalog/cards/<id>.json、labs/<id>.json（展开后的 v2 + checks / checkSources / checkHashes / pitfalls / manuals{frontMatter, ast(atl.mdast/v1), source} / startProfileDigests）、tracks/<id>.json、profiles/atl/<card>/<variant>.env、assets/、private/quiz/<id>.json（答案不进公开文档）、manifest.json（files sha256、contentDigest） | scripts/labs/src/build.ts |

### 有歧义处的取舍

- 学习路径放在 `labs/_tracks/`（04 §2.1，dev-server 也从这里读），没有另建根目录 `tracks/`。
- 未完成的卡片用 `status: planned` + 精简 schema（无 steps / checks / quiz），目录显示“即将推出”；`catalog.yaml` 不含 planDigest / gitCommit / contentDigest（构建期才有）。
- 计费维度在 05 的基础上增加 `base`、`workstation`、`modules` 三段与 `scaleBy {key, values, default}`（Multi-AZ、NAT 模式），只写 Price List 过滤条件，不写金额。
- 摘要与 `scripts/module` 完全一致：`registryVersion = <version>+<sha256(RFC 8785 registry)[0..12]>`，模块项总带 `value`（null）；参考推导与 CLI 推导的 10 张卡摘要逐一相同。
- lint 放宽：A3 接受 iam 的凭证证据（aws-cred-source + 带 ownership 的 aws-readonly）；C-10 对 group 放宽；A9 去掉规则 ③；可选步骤只在它是某必需标签的唯一记录者时报 A11 警告；B24 接受 `service` 与服务 id 相同的 aws-readonly 检查。
- 跨卡引用 `<card>/<check>`：被引用检查的 dependsOn 与 pitfalls 在来源卡中解析（refFromOwner），本卡检查可以 dependsOn 被引用检查的本地 id。
- 检查引擎的 gt / lt 只比较数值：涉及时间先后的断言（SSM Agent 启动时间晚于演练开始、Throttles 指标时间窗）改为 CloudTrail 事件、配置状态或手动观察。
- 手工实验（`scenario.tool: manual`）与离线 shell 实验不能上传结果：改为 cli / console 步骤，以 aws-readonly、local、manual 检查判定。
- 逐卡差异（文件头注释也写了）：
  - svc-ec2：仓库没有 experiments/ec2 与 `rebuild-instance`，不声明实验；单点故障演练以 CloudTrail StopInstances / StartInstances、EIP 关联与恢复后的 capability 判定。
  - svc-iam：平台模式下 iam keys 一律被 scripts/module 拒绝，keys 反面教材不设步骤；撤销会话是 module 命令，而 v2 `platformOps.op` 只允许 enable / disable，无法声明，不设步骤。
  - svc-auth：模板是公有 SPA 客户端（只允许 SRP），experiments/auth 的 cognito 登录要 USER_PASSWORD_AUTH，运行器在 cognito 下也只会本地登录 → after 实验不设步骤，after 侧以 capability、探测端点、DescribeUserPool / DescribeUserPoolClient 与手动观察判定；预期警告 DEP-013。
  - svc-cache：起始状态不含 `LB_LOCAL_WORKERS=2`（SINGLE_LOCAL_SETTINGS 只有 queue，服务卡声明的 local 预置不被采用），memory 对照改为选做，stale-read 不设步骤；卡片中的 `lab:seed` 在 backend CLI 中不存在，改为观察步骤。
  - svc-database：同样没有 `lab:seed`；pitr 改为选做 cli 步骤（restore-db-instance-to-point-in-time → 检查 → 删除）；故障转移前主库 AZ 用 once 检查保留证据，故障转移后以 `{{$check…}}` 比较。
  - svc-image-processing：throttle / cold-start 改为 cli 步骤；`FAULT_RATE` 暂时错误改为选读，保留 must-hold 检查“环境变量中没有 FAULT_RATE”。
  - svc-queue：poison、dlq-replay 改为 AWS CLI 步骤。
  - sc-static-acceleration：tls、dns 模块未实现，v1 只保留 cdn（S3 媒体源站 + OAC），预览方案 B 保持开启；cdn 公共检查引用 svc-cdn。

### 需要其他部分配合

- 06（scripts/module）：`parseAtlProfile` 只按 ownsEnv 归属 PROFILE_DRIVERS 的键，`STORAGE_DRIVER`（storage / shared-fs 共用的开关变量）被丢弃，`plan --profile` 的摘要与 `plan --start-of` 不同 → svc-image-processing、sc-static-acceleration 在运行器中会报 PROFILE_DIGEST_MISMATCH。修法：解析时也按 `switch.var` 归属。labs:derive 以 DRV-10 警告报告。
- 06：`SINGLE_LOCAL_SETTINGS` / registry `singleLocalSettings` 加入 cache 的 `LB_LOCAL_WORKERS=2`；tls、dns 模块；backend CLI `lab:seed`（卡片文档引用）。
- 04 / shared：`platformOps.op` 需要允许 module 命令（如 `revoke-older-sessions`），svc-iam 才能声明撤销会话步骤。
- experiments：auth 的 cognito 登录改用 SRP 或由 infra 给客户端开 `ALLOW_USER_PASSWORD_AUTH`，运行器在 cognito 下需要取得管理员令牌；experiments/ec2 未实现。
- API：`status: planned` 的卡片应像 LAB_DEPRECATED 一样拒绝开始会话；dev-server 应从 build 产物（展开后的 checks）播种。
- 03：控制台深链接注册表还没有落到 platform/api/contracts，scripts/labs/src/console-links.ts 暂存 03 的表。

### 依赖

scripts/labs 使用根 node_modules 中的 `ajv`（2020 方言）与 `yaml`；`ajv` 未写入 scripts/labs/package.json（并行阶段不运行 npm install，避免锁文件不同步），集成阶段补上。

### 如何测试

```bash
npx tsx scripts/labs/src/cli.ts lint                  # 56 张卡片，0 error / 0 warning
npx tsx scripts/labs/src/cli.ts derive                # 10 张完整卡片；scripts/module 推导 + plan --profile 交叉核对
npx tsx scripts/labs/src/cli.ts derive --deriver reference
npx tsx scripts/labs/src/cli.ts catalog --check && npx tsx scripts/labs/src/cli.ts build
npx vitest run --project atl-labs-tools
npx tsc -b scripts/labs && npx eslint scripts/labs/src scripts/labs/test
```

## platform-integration

平台集成与本地端到端自测：把 api、lifecycle、checks、infra、cloudalbum-mode、content 六个实现的提交接到一起，补齐依赖，修复各部分之间的契约
不一致，接通 ATL_DEV_MODE 的完整运行时，固化 `npm run smoke:platform`。全程没有调用真实 AWS API，没有部署任何东西；Docker 只用了本机已有的
`amazon/dynamodb-local:3.3.1`、`postgres:16-alpine`、`valkey/valkey:8`。

### 1. 补齐与修复

**依赖**（`npm install --before=2026-09-29`，lockfile 只新增 11 个包）：
- `platform/api`：`express`、`yaml`、`@aws-sdk/client-cloudfront` 与 lifecycle 按名动态加载的 13 个 SDK 客户端（sqs、sns、rds、elasticache、efs、
  elastic-load-balancing-v2、auto-scaling、cloudcontrol、cloudwatch、cloudwatch-logs、secrets-manager、ecr、ecs，全部锁定 3.1142.0，与已有客户端同版本）；
  开发依赖 `@types/express`、`supertest`、`@types/supertest`。
- `platform/workflows`：`@noble/hashes`，开发依赖 `esbuild`。`platform/workstation`：`@smithy/signature-v4`、`@aws-sdk/credential-provider-node`、
  `@aws-crypto/sha256-js`。`platform/infra`：开发依赖 `@atl/workflows`。`scripts/module-cli`：`@aws-sdk/client-dynamodb`、`-cognito-identity-provider`、
  `-rds`、`@aws-sdk/s3-request-presigner`、`@smithy/signature-v4`、`@node-rs/argon2`。`scripts/labs`：`ajv`。

**接线**：
- `functions/{api,agent}/handler.ts` 改用 `routes/index.ts` 的 `createApiHttpHandler` / `createAgentHttpHandler`（可传 `ApiExtensions`）。
  atl-public 原有两份实现：保留 atl-certs 一侧的 `functions/public/handler.ts`（它读写的正是 atl-certs 写的证书与密钥项），`routes/agent.ts` 中的副本删除，
  `publicRouteHandlers()` 直接返回这张表。
- `src/dev/runtime.ts`：函数表使用 dev 检查引擎（`createDevCheckEngine`）；`installLifecycleDev` 在运行时内调用，与 dev 运行器共用同一个
  `DevReclaimCloud`（新增 `reclaim` 选项）；模拟 `atl-events` 上的规则（`session.state_changed`、`reclaim.pass_completed` → atl-checks，EventBridge 事件形状）；
  新增选项 `tables`（每次自测一套表）、`gates`、`ext`、`lifecycle`；返回值增加 `reclaim`、`lifecycleDev`、`l0`、`checks`。
  `orchestrator-dev/server.ts` 不再重复安装 lifecycle。`npm run platform:dev` 改为 `dev-server.ts --dev-mode --seed-catalog`。
- dev 运行器（`dev/adapters/runner.ts`）在各模式下都把 op 的 AWS 副作用写进 dev 账号（与测试用 ScriptedRunner 相同：base-deploy 的 toolchain / ec2 栈、
  密钥对与 `/cloudalbum/<envName>/atl/*` 参数，workstation-up/-down，destroy 删栈并写 `ledger.json`）。`local-l0` 模式下 base-deploy 启动的本地 L0
  处于平台模式（`etc/platform.env`、`etc/atl/probe.token`、应用管理员，初始密码写 `etc/atl/app-admin-password`，相当于 SSM 参数）；回收器删除实验机
  `i-dev-<envName>-lab` 时停止对应的本地 L0（`DevReclaimCloud.onDeleted`）。
- `dev/adapters/custom-resources.ts`：在 dev 端口上运行 `platform/infra/custom-resources` 的真实处理器（DynamoDB Local、目录桶、dev 签名密钥、模拟器、
  lifecycle 的 dev IAM 状态），CloudFormation 回调记录在内存中。smoke 与 dev-server 用它替换 atl-custom-resources 的桩。
- `dev/adapters/clock.ts`：`ScaledClock.skip()` 现在让跳过的定时器立即触发、其余按剩余平台时间重排（原来定时器保持原来的真实时间，快进后调度不会触发）。
- `dev-server.ts`：`publishDevContent()` 按 WebDeploy 的布局发布 `labs:build` 产物（含展开后的检查、档位、私有题库），`--seed-catalog` 优先用它。

**契约不一致（各自测试都通过、接起来才出现的问题）**：
1. CreateSession：lifecycle 要求费用确认，API 的草稿里没有 → API 草稿 `costQuote.acknowledgedAt`，lifecycle-client 同时传 `costAcknowledged`。
2. 保留环境：API 直接以 `{ keep: {hours, quoteId, saveMode, confirmedAt} }` 启动 `atl-session-end`、到期处置写对象形式的 `preferredDisposition`，而
   lifecycle 的 BeginEnd 只认 `LabSession.keepRequest`（只有 lifecycle 自己的 RequestEnd 会写）→ 立即保留与到期保留都会变成销毁。
   `end.ts` 新增 `keepRequestOf()`：两种 API 形式都转成 `keepRequest`，在 ENDING 转换中写入。新测试 `test/lifecycle/api-lifecycle-e2e.test.ts` 用真实 ASL、
   模拟器与 lifecycle 跑 API 路由（保留 / 延长保留 / 释放、到期保留、平台动作、PROVISIONING 中取消），去掉修复后有两项失败。
3. “我已处理”：API 异步调用 atl-reaper `VerifyResolved`，reaper 没有这个动作 → 改为异步调用 atl-lifecycle `ResolveCleanup`（它调 reaper `ResolveItem`
   并执行 T20，状态只由 lifecycle 写）。`DOWNSTREAM_ACTIONS.reaper` 换成 `lifecycle.resolveCleanup`。
4. 离线验证包：API 自己拼了一份（没有 `verifyScript`，jwks 也不是发布的 jwks.json）→ 改为同步调用 atl-certs `OfflineBundle`（04 §10.5 的形状）。
5. 验证页：只有 atl-certs 的 `PublishVerifyPage` 动作会发布 `verify/`，没有任何调用方 → 签发证书时检查并（重新）发布验证页，第一次签发时发布空的签名
   吊销列表（因此第一次吊销的序号是 2）。
6. 题库位置：WebDeploy 写 `releases/<ReleaseVersion>/private/quiz/`（01 §3.7），API 读 `releases/<catalogVersion>/…`（两者在生产中不同）→ WebDeploy 在
   `CatalogRelease` 记 `quizPrefix`，API 优先用它。
7. atl-sfn-failed 规则投递 `{"action":"ExecutionFailed","event":…}`，lifecycle 没有这个动作 → `normalizeLifecycleEvent` 映射为 `HandleExecutionFailure`。
8. atl-checks 需要的 `session.state_changed` / `reclaim.pass_completed` 在模板里没有规则 → `45-events.yaml` 新增 `atl-checks-session-events`
   （总线 atl-events → ChecksFunction）与权限；`inventory.test.ts` 相应放宽。
9. 函数环境：atl-checks 读 `ATL_CHECK_BUNDLE_DIGEST`，模板只给 CodeBuild 设了 `ATL_CHECKS_BUNDLE_DIGEST` → 函数环境增加 `ATL_CHECK_BUNDLE_DIGEST`
   （`CopyArtifacts.ChecksBundleDigest`）；atl-certs 的 CloudFront 失效同时接受模板设置的 `ATL_DISTRIBUTION_ID`。
10. 运行器：会话策略的托管部分 `ATLProvisionerPolicy-RunnerSession` 模板里没有 → `template-parts.ts` 由 `staticRunnerStatements()` 生成
    （`@atl/workflows` 导出）；`ATLRunnerServiceRole` 增加 `dynamodb:GetItem`（atl-main，`LeadingKeys` 限 `SESSION#*`、`ENV#*`、`PLATFORM`）。
    工作台栈：运行器用的是不存在的 `platform/workflows/workstation/workstation.yaml`、只传两个参数 → 改用 `platform/workstation/templates/atl-workstation.yaml`，
    并传齐模板声明的参数（默认 VPC 及其按 AZ 排序的第一个默认子网、CodeBuild 变量 `ATL_WORKSTATION_*`）。
11. 运行器源码包 `cloudalbum-infra.zip`：缺 buildspec 要用的 `runner/dist/atl-runner.mjs` 与根目录 `SHA256SUMS`，也没有 `cloudalbum-<ver>-<arch>.tgz` →
    `package.ts` 打进运行器 bundle、按 scripts/release 的文件名放入 CloudAlbum 发行包（有时），并写出覆盖全部条目的 `SHA256SUMS`；检查包默认取
    `platform/checks/dist/atl`（`bin/atl-check.mjs` 不进包）。
12. 06：`parseAtlProfile` 丢掉 `STORAGE_DRIVER`（storage 与 shared-fs 共用的开关）→ 按开关的 `ownedValues` 归属。`labs:derive` 的两条警告消失
    （svc-image-processing、sc-static-acceleration 不再 PROFILE_DIGEST_MISMATCH）。
13. `status: planned` 的卡片（46 张）：简介页 `startability.reasons` 带 `LAB_PLANNED`，报价与开始返回 400 `VALIDATION_FAILED`（`reason: LAB_PLANNED`）。
14. 实验登记后异步调用 atl-checks `ExperimentRegistered`（04 §7.4 第 4 步的登记时快照）。
15. DevReclaimCloud 的 RDS ARN 改为真实格式（否则标签发现与 CloudTrail 发现的是两个条目）。

**其他**：`backend/test/http/media-flow.test.ts` 的日报日期改按 `SCHEDULER_TIMEZONE`（UTC 15:00～24:00 运行时失败）；`frontend/src/App.test.tsx` 的页脚
断言改为等待（全量并行时偶发）；`.gitignore` 增加 `!platform/infra/build/`；`platform/package.json` 的 `publish:s3`、`package`、`smoke` 转发到实际脚本；
`platform:build` 先构建检查包；根脚本增加 `platform:package`、`smoke:platform`。

### 2. 如何运行

```bash
npm install && npm run build && npm run lint && npm test
npm run platform:db:up                 # DynamoDB Local（127.0.0.1:58000）
npm run smoke:platform                 # 约 2 分钟；-- --keep 保留数据与表，--time-scale 5（默认），--skip-package
#   结果：.atl-dev/smoke/last-platform.json；运行目录 .atl-dev/smoke/platform-<时间>/（失败或 --keep 时保留）
npm run smoke:l0 && npm run smoke:selfhost
npm run platform:validate              # 6 个状态机的结构校验 + asl-validator
npm run labs:lint && npm run labs:derive
ATL_CFN_LINT=<cfn-lint 路径> npm run cfn-lint -w @atl/infra     # 本轮用 1.57.2
npm run platform:package -- --out <dir>                         # 发布包 + SHA256SUMS，不上传
npm run platform:dev                   # dev API（127.0.0.1:8787），ATL_DEV_RUNNER_MODE=local-l0 时每个环境起一个本地 L0
ATL_IT=1 npx vitest run --project atl-api                       # 含 DynamoDB Local 集成测试
```

### 3. 自测结果（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28）

| 自测 | 命令 | 结果 |
|---|---|---|
| 构建 / 检查 | `npm run build`、`npm run lint`、`cd platform && npm run build`、`npm run registry:check` | 通过；0 个 lint 问题；平台模板 156 个资源 |
| 单元测试 | `npm test` | 127 个文件、1523 个测试通过；18 个跳过（集成测试，另需服务） |
| 集成测试 | `CLOUDALBUM_IT=1 npx vitest run`（PostgreSQL 16、Valkey 8、DynamoDB Local）；`ATL_IT=1` 平台三项目 | 133 个文件、1569 个测试通过（1 个跳过）；平台 399 个通过 |
| 平台端到端 | `npm run smoke:platform` | 106 / 106 通过，约 126 秒（见第 4 节） |
| CloudAlbum | `npm run smoke:l0`、`npm run smoke:selfhost` | 85 / 85、31 / 31 |
| ASL | `npm run platform:validate` | 6 个状态机全部通过 |
| 内容 | `labs:lint`、`labs:derive` | 56 张卡 0 错误 0 警告；10 张完整卡推导 0 错误 0 警告（摘要与 `plan --profile` 一致） |
| cfn-lint 1.57.2 | 平台模板 + 工作台模板；`infra/modules/*.yaml` | 0 错误（平台模板 2 条警告：W3037 `access-analyzer:ListFindingsV2` 不在 cfn-lint 的动作表中、W1030 自定义域名证书参数）；10 个模块模板 0 发现 |
| 打包 | `npm run platform:package -- --out …` | 生成 `atl-lambdas.zip`、`atl-web.zip`（占位页）、`atl-content.zip`、`cloudalbum-infra.zip`（963 个条目，内部 SHA256SUMS 全部可核对）、`atl-workstation.tar.gz`、模板、`SHA256SUMS`（含 `# checks-bundle-digest`）、`release-manifest.json`、`launch-stack.md` |

### 4. smoke:platform 的内容

运行时：DynamoDB Local（每次一套 `atl-main-smoke-<时间>` 表，结束后删除）、真实的 6 个 ASL 在进程内模拟器中执行、12 个函数进程内调用、dev 运行器
`local-l0`、dev 检查运行器（`platform/checks` 的 Node 启动器，ATL-RunCheck 直接对本地 L0 执行）、`ScaledClock`（默认 ×5，倒计时用 `skip` 快进）、
本地 ECDSA P-256 签名、假 CloudTrail。经 HTTP 调用 dev-server（Express → Lambda 事件）。

| 阶段 | 验证内容 |
|---|---|
| 0 构建 | 构建产物存在；检查包构建；没有内容包时 `labs:build`；`package.ts` 打包并逐个核对 `SHA256SUMS` |
| 1 平台初始化 | 在 dev 端口上执行安装自定义资源 SeedData → WebDeploy（`atl-content.zip`）→ JwksPublish → UninstallGuard Create，均回调 SUCCESS；`GET /platform`、`/me`、`/catalog`；目录索引 56 张卡，10 张可开始、46 张 planned；planned 卡不可开始、报价 400 `LAB_PLANNED`；9 条学习路径 |
| 2 开始 svc-storage | 报价（atl-pricing 不可用：各行 `unknown`、金额 null，不编价格）→ `POST /sessions` → REQUESTED → PROVISIONING（PROVISIONING 中 agent context 可读、别的会话名 403 `SESSION_MISMATCH`）→ READY；运行器 base-deploy（本地 L0，平台模式，`platform-status` 核对）、workstation-up、profile-apply；健康门经 ATL-RunCheck 在本地 L0 上执行；w15 / w5 / exp 调度；截止时间取整分钟；心跳 → RUNNING |
| 3 第 1 步检查 | capability `storage-local-baseline` 与 local `data-volume-usage` 均 pass，步骤 orient 完成 |
| 4 手动确认 | `put-target-answer` 确认 201，助教复核，StepResult 带 `lastManual` |
| 5 对比实验 | `upload-burst` 的 before / after 两个变体：agent 登记 → 应用登记（`CA-Lab` 实验令牌）→ 带 `X-Experiment-Run` 的请求 → RFC 8785 摘要上传 → 轮询：before `valid`（`lab-metrics` 服务端佐证），after `invalid / DRIVER_MISMATCH: storage=local (expected s3)`（目标模块需要真实 S3） |
| 6 延长与到期 | 报价 EXTEND → 延长 30 分钟（deadlineVersion 2，v2 调度）→ 快进到截止前 16 分钟 → w15 → EXPIRING 与 `session.expiry_warning` → 快进到截止 → ENDING → CLEANING → ENDED（`EXPIRED`）；dev 账号中环境的栈与资源全部删除、本地 L0 停止；回收报告；已安排复扫 |
| 7 报告与证书 | 结束编排生成的报告（第 2 版，`atl.report/v1`）；svc-storage 的真实尝试记为 `attempted`；夹具补齐 quick-compare 7 张必修卡的完成记录与 verified 徽章 → 路径可领证 → `POST /certificates` 201，JWS ES256 / `atl-cert+jws`；离线工具 `verify.mjs` 与发布的 `verify/verify.js`（vm 中以发布的 jwks.json、revocations.jws 运行）都判 `valid`，篡改载荷被拒；吊销后离线工具与验证页都判 `revoked`，公开查询为 revoked |
| 8 失败路径 | 第二个会话；注入学员在控制台创建、删除保护无法解除的 RDS 实例（假账号资源 + CloudTrail `CreateDBInstance`）→ 结束 → CLEANUP_FAILED（hourlyBlocking 1）→ `GET /resources/manual` 1 项、回收报告（含 Markdown 中的删除命令）→ 学员删除后“我已处理”→ ResolveCleanup → ENDED，清单清空 |
| 9 卸载守卫 | 第三个会话处于 READY：`UninstallRoleCleanup` 拒绝（“1 session(s) are not finished yet”，回调 FAILED）；UNINSTALLING 时开始会话 409；`/platform/uninstall/status` 列出阻塞项；UninstallGuard Delete 不走快速路径、启动 `uninstall-1`，结束会话后回调 SUCCESS |

### 5. 设计有歧义时的取舍

1. **dev 健康门豁免**：本地 L0 是开发机上的一个 api 进程，没有 systemd 的 worker / nginx、没有单独的数据卷；dev 运行器也不部署起始档位中需要 AWS 的
   模块（svc-storage 的 iam=role 需要 IMDS + STS）。`devHealthGateWaiver()`（只在 `local-l0` 模式）在检查照常执行之后，只豁免这些开发机缺口，并把豁免项写入
   `report.devWaived`；模块 `error` / `degraded`、api 不在线、缺 platform.env 或本机探测密钥都不豁免。生产代码不变。
2. **svc-storage 在本地不能“完成”**：接入步骤要求 storage=s3 与本环境的桶，本地 L0 做不到；真实的 FinalizeAttempt 把尝试记为 `attempted`，报告照常生成。
   任务允许 dev 模式用夹具补齐其余卡片的完成记录，本自测把 svc-storage 的完成记录也放进夹具（徽章带 `fixture: smoke:platform` 标记），其后的路径资格、
   签发、验证、吊销全部走真实代码。
3. **对比实验的两个变体**：before 在本地 L0 上有效；after 声明 `requires: storage=s3`，本地只能得到 `DRIVER_MISMATCH`，自测把这一结论作为期望。
4. **平台初始化**：用 infra 的安装自定义资源（而不是 `platform:db:init` 的 dev 配置）初始化，覆盖 SeedData、WebDeploy、JwksPublish、UninstallGuard 的代码。
5. **atl-events 规则** `atl-checks-session-events`：01 的规则表只有 `atl-sfn-failed` 与 `atl-tagger-api-calls`，04 §12.3 要求 atl-checks 消费这两类事件，
   取最简单的做法新增一条规则（需 01 登记）。
6. **LAB_PLANNED**：未登记的错误码按 api 的约定放在 `VALIDATION_FAILED` 的 `reason` 中。

### 6. 与 07 验证计划的对应

| 07 条目 | 本地已覆盖 | 必须在真实 AWS 上验证 |
|---|---|---|
| V0-6 代码就绪 | `npm run build` / `npm test` / `registry:check`、`cd platform && npm run build`、labs:lint / derive（10 张完整卡；svc-waf、svc-tls、svc-autoscaling 仍是 planned，无法推导） | — |
| 阶段 1、2（IAM/STS、SSM 协议 PoC） | 模拟器语义、IAM 策略求值器（infra 测试）只是离线近似 | 全部（V1-1～V1-15、V2-1～V2-7） |
| V3-1、V3-2 L0 部署与冒烟 | smoke:l0 / selfhost 覆盖应用逻辑；`scripts/module --dry-run` | 部署本身、Nginx、systemd、EBS、IMDS；`scripts/release` 须在 Linux 上产出 `cloudalbum-<ver>-<arch>.tgz` |
| V3-3 平台模式自检 | smoke:platform 第 2、5 步：platform.env、本机探测密钥、`platform-status`、检查包入口（Node 版）、`lab-token`、`/api/lab/runs`、`lab-metrics` 佐证 | Nginx 日志字段、CSP 头、`PROBE_LOCAL_ONLY`（经 EIP）、真实检查包安装路径；第 8 步引用的 `experiments/ec2` 不存在（可改用 storage 的标签） |
| V3-4～V3-6 | — | 全部 |
| 阶段 4 模块启停 | cfn-lint 10 个模块模板 0 发现、module-cli 单元测试、档位摘要 | 全部 |
| V5-1 安装 | 模板构建 + cfn-lint 0 错误、清单测试、打包与 SHA256SUMS、SeedData / WebDeploy / JwksPublish / UninstallGuard 的 dev 执行 | CopyArtifacts、StackGuard、真实建栈、Cognito 首次登录、CloudFront 转发 Authorization |
| V5-2 护栏 | infra 的离线 IAM 求值测试 | 全部用例 |
| V5-3 主路径 | smoke 第 2～7 步（以 svc-storage 代替 svc-ec2）：开始 / 健康门 / 倒计时 / 检查 / 手动确认 / 实验 / 结束 / 回收 / 报告 / 证书签名与验证 / 吊销 | 真实 CodeBuild 运行器与 scripts/module、SSM、`kms:Sign`、终端 / 控制台 / 预览（见第 7 节）、吊销条目的巡检删除 |
| V5-4、V5-5 保留与复用 | `api-lifecycle-e2e.test.ts`（API × 真实 lifecycle：立即保留、到期保留、延长、释放）、lifecycle 的 keep-reuse 测试 | 节省模式停机、状态桶与锁表、标签、复用时的实例发现 |
| V5-6 延长与到期 | smoke 第 6 步 | 真实 EventBridge Scheduler（V1-11） |
| V5-7、V5-7a、V5-8 | — | 全部（svc-waf 未实现） |
| V5-9 卸载 | smoke 第 9 步（UninstallRoleCleanup 拒绝、守卫启动卸载编排、回调 SUCCESS） | 真实删栈顺序、BucketEmptier、角色清理 |
| 阶段 6 | — | 全部 |

### 7. 已知问题与仍需配合

- **没有实现者认领的生产实现**：
  - `atl-pricing`（Price List Query API + `PriceCache`）仍是桩：报价全部 `unknown`，金额 null（04 §3.4 不允许按 0 计）；
  - 03 的 `WorkspaceProvider`（终端 StartSession、控制台联合登录、`app-credentials`、预览实时探测）与 Cognito `MemberDirectory`：这些路由在生产中返回 501，
    V5-3 第 4 步（终端、控制台）在实现前无法执行；
  - `platform/web` 仍是占位（`atl-web.zip` 只有占位页），阶段 5 只能用 API 调用驱动；
  - 08 §9.2 请求的新路由未实现（等 01 登记）。
- **发布包的前提**：`cloudalbum-<ver>-<arch>.tgz` 要在 Linux 上运行 `scripts/release` 后经 `--app-archive` 传入；工作台引导包缺 session-manager-plugin、k6、
  预构建的 `node_modules`（启动时 `npm ci`，偏离 03 §4.5）；检查包摘要只有设置 `SOURCE_DATE_EPOCH` 时才可复现。
- **需 01 登记**：规则 `atl-checks-session-events`、函数环境变量 `ATL_CHECK_BUNDLE_DIGEST`、托管策略 `ATLProvisionerPolicy-RunnerSession` 与运行器的
  `GetItem`、`CatalogRelease.quizPrefix`、错误原因 `LAB_PLANNED`，以及 API → atl-lifecycle `ResolveCleanup`、API → atl-certs `OfflineBundle` 两个调用。
- **dev 模式的边界**：健康门豁免（第 5 节第 1 条）；`noop` / `dry-run` 运行器模式下 Preflight 与健康门直接 PASS（没有实验机）；dev 运行器的 profile-apply
  不改本地 L0 的模块配置；dev 的 `DevReclaimCloud` 只是内存中的账号。
- **未在本地验证**：模块操作（平台动作）只在模拟器测试中覆盖；svc-auth 的 Cognito 测试用户、需要 AWS 的检查（`aws-readonly` 只由 FakeAws 回答）。
- **git**：本轮只提交自己改动的路径；工作区中 `docs/` 下其他文件与未跟踪的 `docs/platform/` 不是本轮的改动，没有提交。

## platform-review-fixes

本节记录对审查发现（报告分享、导出、实验时间窗、CloudFront 护栏、回收证据、删除会话策略、基线清单、定向扫描限流、模块操作记录、函数角色权限）的修复，以及修复中做出的取舍。

### 1. 报告分享链接（04 §9.5）

- **同一个 shareId**：`POST /sessions/{sid}/report/shares` 由 atl-api 生成 `shareId`（`@atl/shared` 的 `newShareId()`：128 位随机数的 base64url，22 字符）
  和 `expiresAt`，异步交给 atl-certs `CreateShare` 原样使用；202 响应里的 `shareId`、`url`（`/share/<shareId>/index.html`，按 04 §9.5 带 `index.html`）
  与 `expiresAt` 就是最终发布的链接。atl-certs 只接受未来 91 天以内的 `expiresAt`。
- **请求体**：04 §9.5 与 08 的分享对话框只有“7 / 30（默认）/ 90 天 / 不过期”，请求体改为 `{ expiresInDays: 7 | 30 | 90 | null }`；原来的
  `expiresInHours` 与 `mask` 删除（分享副本一律强制打码）。
- **幂等与顺序**：`CreateShare` 按 shareId 幂等，顺序为“到期调度 → 标记对象（`reports/_shares/<id>.json`）→ `ReportShare`（`status=publishing`）→
  公开对象（固定键名，重试只覆盖）→ `status=active`”。异步重试不会再发布副本；发布过程中被撤销会立即删掉刚写的对象；撤销或到期之后到达的重试什么都不发布。
- **撤销与到期**：`DELETE …/shares/{shareId}` 的校验与 `SHARE_ID_RE` 一致（已撤销时直接返回当前状态）；atl-timer 对 `SHARE_EXPIRE` 改发
  `{ action: 'ExpireShare', shareId }`。删除对象按记录的 `objectKeys`（不需要 atl-web 的 `ListBucket`）。
- **ReportShare 新属性**（需 01 登记）：`status`（`publishing | active | revoked | expired`）、`publishedAt`、`revokeReason`。列表接口按
  `revokedAt` / `expiresAt` 推出状态，到期但调度尚未触发的也显示为 `expired`；不返回 `objectKeys`。
- **谁创建调度**：01 没有规定分享到期调度由谁创建，选最简单的做法——atl-certs 在发布前自己创建、撤销时删除。`ATLCertsFunctionRole` 增加
  `scheduler:CreateSchedule`、`DeleteSchedule`（仅 `schedule/atl-system/atl-share-*`）与对 `ATLSchedulerRole` 的 `iam:PassRole`（条件
  `iam:PassedToService=scheduler.amazonaws.com`）。**需 01 §6.9 登记**。

### 2. 报告导出（04 §9.4）

- 导出一律由 atl-certs 渲染：按修订版本、格式和打码方式写入确定的键 `exports/<sid>/report-v<n>-<format><Variant>.<format>`（`Variant` 为
  `Masked` / `Unmasked`），并记到 Report 项的新属性 `exports.{jsonMasked, htmlMasked, jsonUnmasked, htmlUnmasked}`（需 01 登记）。
- `GET /report/export?format=&mask=on|off`：该槽位已有键时才签发下载链接（`status: ready`），否则派发 `ExportReport` 并返回 202 `rendering`；
  从不为 `s3Keys.json/html` 签名。`mask` 只接受 `on` / `off`；atl-certs 同时接受字符串和 `{ accountId, ip }`。
- `GET /sessions/{sid}/report` 的 `downloads` 仍是权威报告（08 P09-C 的“核验用报告 JSON”需要未打码的原件），没有改。

### 3. 对比实验时间窗（04 §7.4 第 3 步）

- 登记写入的 `window` 是 `{ notBefore, notAfter }`；`validateRun` 改用它（第一版记录的 `{ from, to }` 也能读）。无法解析或缺少的时间一律视为窗外。
- 上传时就按登记窗口判定：窗外的结果**保留记录**并直接标为 `invalid: OUT_OF_WINDOW`（04 §7.4 “任一步失败都保留记录并标明原因”，所以不是 4xx 拒收），
  响应 `202 { status: 'invalid', validity }`；交叉核对得出同样结论。
- 功能型实验的佐证区间取“客户端时间与登记窗口的交集”（+10 分钟），学员把 `startedAt` 写成会话开始时间也借不到窗口外的通过记录；没有窗口的记录不计佐证。

### 4. CloudFront 护栏（01 §3.8、§6.5、§6.6）

- `DenyPlatformByArn`（学员护栏、Provisioner 护栏、工作负载边界）加入平台的 CloudFront 资源：分配、`function/atl-*`、三个响应头策略、短 TTL
  缓存策略、OAC（`gen-policies.ts` 的 `PLATFORM_CLOUDFRONT_ARNS`）。这几类资源 CloudFormation 无法打 `atl:component` 标签。
- **大小**：工作负载边界原本只剩 235 字符余量。ID 全局唯一，所以这些 ARN（以及原有的用户池、HTTP API、签名密钥、ProtectSsmPlatform 中的关联）
  改用 `*` 代替账号 / 区域 / 资源类型段：`arn:aws:cloudfront::*:*/<id>`、`apigateway:*::/apis/<id>*`（API ID 定长 10 位）、`kms:*:*:key/<keyId>`。
  对 Deny 而言这是等价或更宽的写法；01 §6.5 的示例仍是完整 ARN，以生成结果为准。14 字符区域名的场景下工作负载边界余量为 65 字符。
- infra 测试新增清单校验：模板中每个 `AWS::CloudFront::*` 资源都必须被名称、标签或 ARN 中的一种拒绝覆盖（学员 / Provisioner 与工作负载两组）；
  离线求值测试覆盖 `UpdateFunction`、`PublishFunction`、`UpdateResponseHeadersPolicy`、`UpdateCachePolicy`、`UpdateOriginAccessControl`。

### 5. 回收证据：覆盖式写入（02 §7.2 第 1 条、§7.3）

- 提取器把“创建或覆盖”的事件标为 `overwrite`：`monitoring:PutMetricAlarm`、`PutDashboard`、`events:PutRule`、`config:PutConfigurationRecorder`、
  `PutDeliveryChannel`、`PutConfigRule`、`inspector2:Enable`，以及 Route 53 `ChangeResourceRecordSets` 中的 `UPSERT`（`CREATE` 仍是创建证据）。
- 这类条目以 `CLOUDTRAIL` 来源、**不带 `eventId`**（台账 `weak` 输入）写入 `REVIEW`，`meta.possiblyPreexisting = true`，原因文字以
  “可能是会话前已存在的资源”开头；弱证据不会把 REVIEW 改回 TRACKED，也不会被自动删除。定向扫描对这类事件仍回答 FOUND（检查只关心“本会话写过”），
  但台账同样按弱证据记录。
- 取舍：没有实现“开始前基线快照 / DescribeAlarmHistory / Route 53 变更历史”来证明资源原本不存在（需要额外的读权限与按类型的实现）。代价是学员在控制台
  新建的告警、规则、Config 记录器会进入待人工处理清单，而不是自动删除；模块栈创建的同类资源（STACK）与 `state.json` 的带外记录（OUT_OF_BAND）不受影响。

### 6. 删除会话策略（02 §7.6、01 §6.7）

- Cloud Control 回退路径不再带 `aws:CalledVia` 通配，只保留 `ReapItem`（`[arn, arn/*]`）与 `cloudformation:DeleteResource / GetResource /
  GetResourceRequestStatus`；需要更宽权限的类型会被拒绝并进入人工清单。只有 `AWS::CloudFormation::Stack` 保留 `ReapViaService`（原来附带的
  `ReapControl` 对删栈没有用，一并去掉）。
- IAM 处理器不再对 `role/*`、`user/*`、`group/*`、`instance-profile/*` 给 `Action: *`：会话策略在第一次写操作前由 `Handler.scope` 读取当前关系后生成，
  只含具体动作与具体 ARN——`DetachRolePolicy` / `DetachUserPolicy` / `DetachGroupPolicy`（按 `ListEntitiesForPolicy`，路径未知所以每个名称给
  `<kind>/<name>` 与 `<kind>/*/<name>` 两种形式，并加 `iam:PolicyARN` 条件）、`RemoveRoleFromInstanceProfile`、`RemoveUserFromGroup`。
  超过 100 个关联或策略超过 AssumeRole 的 2,048 字符上限时，该项进入人工清单（`REVIEW`）。`sessionPolicyFor()` 导出供测试与 07 核对。

### 7. 基线清单（02 §3.5、§7.1 INVENTORY）

- Preflight 写入的 `InventorySnapshot` 改为 `items: [{ type, id, arn, region }]`（`refFromArn` 解析），同时保留 `resourceArns`，并覆盖扫描区域
  （平台区域 ∪ `us-east-1` ∪ 卡片 `regions.extra`）；类型补上 `rds:cluster` 与 `elasticache:replicationgroup`，与回收器的清点一致。
- 回收器的 `baselineKeys()` 两种形状都读（`type|id` 与 ARN）。
- **已知缺口**：基线来自 Tagging API `GetResources`，它只返回带过标签的资源；从未打过标签的既有高费用资源仍会作为 `INVENTORY` 的 REVIEW 项出现。
  完整的基线需要 Preflight 以 Describe* 列举，而 `ATLVerifierRole` 的策略由内容（`labs:policy`）生成，目前不包含这些操作；留给 07 阶段 5 实测后决定。

### 8. 其他

- **OwnershipLookup 限流**：每翻一页 `LookupEvents` 都取一个令牌；令牌不足或 AWS 返回限流（`PortError('Throttled')`、`Throttling*`、
  `Rate exceeded`）时回答 `{ status: 'THROTTLED', retryAfterSeconds }`（AWS 限流时 30 秒），不再让检查报错。
- **模块操作记录**：`finished` 只能结束同一来源的记录（条件 `attribute_not_exists(PK) OR #source = :src`）；工作台改写平台或运行器的记录返回
  409 `INVALID_STATE`，不发事件。
- **函数角色**：`ATLPublicFunctionRole` 增加 `atl-main/index/GSI1` 资源与 LeadingKeys `KEYS`（`GET /public/keys`）；`ATLApiFunctionRole` 的
  `DataDownloads` 增加 `atl-data/experiments/*`（实验结果下载链接与对比）。infra 的 `inventory.test.ts` 新增“路由 / 动作 → AWS 调用 → 权限”核对表。
- **smoke:platform** 第 7 步增加：打码导出（只签发 `exports/` 副本）、创建分享（列表为 active、调度存在）、撤销（副本与调度删除）。
- 新增测试：`report-shares.test.ts`（创建 → 列表 → 撤销 → 调度到期全链路、重试幂等、导出）、`lifecycle/reclaim-evidence.test.ts`、
  `lifecycle/reclaim-session-policy.test.ts`、`lifecycle/ownership-throttle.test.ts`，以及 API 场景中的“窗口外上传”和“改写平台模块操作”回归用例。

## platform-web-scaffold

`platform/web` 的脚手架：Vite 7 + React 18 + TypeScript + react-router 7，按 08-ui-design.md 的路由表注册 P00～P13 的全部路由（页面先放桩），
从已评审的原型 `docs/platform/prototype/index.html` 提取设计系统，基于 `@atl/shared` 路由常量的 API 客户端，全局事件轮询器 SessionSync，
Cognito 托管登录 / dev 令牌，顶栏会话胶囊、横幅与 P13 的错误与降级框架，以及 `npm run platform:dev` 一键联调。全程没有调用真实的 AWS API，
没有部署任何东西。

### 1. 实现范围

| 部分 | 位置 | 内容 |
|---|---|---|
| 路由 | `src/app/routeTable.ts`、`App.tsx` | 08 §2.1 站点地图中属于 SPA 的 20 条路径（含 `/` 重定向）；`public`（/login、/auth/callback、/auth/signed-out）、`app`（顶栏 + 横幅 + 页脚）、`workspace`（无顶栏）三种布局；页面 `React.lazy` 按需加载；`/settings` → `/settings/profile`；`*` → 框架内的“页面不存在” |
| 守卫 | `src/app/guards.ts` | §2.4 表 1 的 7 条，拆成 `evaluateAccess`（1～4，渲染顶栏之前）与 `evaluateRoute`（5～7，每个路由）；首次设置豁免 /setup、/settings/*、/sessions/*、/resources/manual、/workspace/*，工作台内改为一次可关闭的提示 |
| 按状态渲染 | `src/app/sessionRouting.ts` | §2.4 表 2：`workspaceRender`（P04 / P05 的 10 个变体）、`endRender`（重定向 / P07 / P07-K / 结束摘要，`#manual`）、`pillTarget`、`rootRedirect`、“从未就绪”判定；`allowedActionsOf`（优先用会话视图的字段，没有时按 §3.3 推导）、`extendBlockReason` |
| 设计系统 | `src/ui/` | `styles/tokens.css`（亮色、暗色、状态语义色、`--host-*`、`--term-*`、`--cat-*`、`--ses-*`、`--urg-*`，取值逐项取自原型 `:root`）、`base.css`、`components.css`（原型的通用组件规则）、`screens.css`（原型的画面专属规则，供各画面直接用）；`semantics.ts` 是 §6.2 的“全站唯一映射”（会话状态、倒计时 U0～U4 / K1～K2、检查结果含原因码、步骤、尝试、资源清理、严重级别、计费、有效性、预算、费用档位）；组件：Shape（20 种状态形状）、Icon（自绘线性图标）、Status / SessionStatePill、Button（置灰原因 aria-describedby、处理中）、CostTierMark、Box / Section、DataTable（aria-sort、行可聚焦、窄屏卡片化）、Dialog / Drawer（焦点锁定、Esc、焦点回位、#root inert、alertdialog）、Disclosure（Esc 回到触发按钮、账号菜单焦点落在容器）、Banner / BannerStack（最多 2 条、红色不可关闭、关闭只在本标签页、首次 role=alert）、CommandBlock（打码显示 / 原文复制、未解析变量 `(!)`、危险命令二次确认、剪贴板兜底、按 runsOn 的粘贴按钮、16KB 限制）、CheckResultRow / SourceTag（命名网格区域、读屏文字不重复）、ResourceRow / ManualItemCard（01 字段名，兼容 02 §7.9 写法）、EmptyState、Skeleton（10 秒后“仍在加载…”）、ErrorPanel、Countdown（每次渲染由 deadlineAt − serverNow 重算、role=timer、aria-live=off、页面隐藏不刷新）、LiveRegion、Field |
| API 客户端 | `src/api/client.ts`、`errors.ts`、`types.ts` | 只按 `@atl/shared` 的 `ROUTES` 调用（路由 id → 方法与路径；只允许 jwt / public 路由族，08 §9.2 未登记的路由无法调用）；`POST` 与 `PUT …/result` 自动带 `Idempotency-Key`，`operation()` 让同一次用户操作的重试复用同一个键；`ifMatch` → `If-Match: "<ver>"`；GET 默认条件请求（按 URL 缓存 ETag 与响应体，304 返回缓存）；problem+json → `ApiError`（code、title、detail、requestId、Retry-After，429 / 503 缺省 30 秒）；401 先静默刷新一次再重试；钩子：onUnauthenticated、onReauthRequired（带可重放的原请求）、onTransientFailure / onSuccess（离线判定） |
| SessionSync | `src/api/sessionSync.ts` | §7.2 的 9 条：BroadcastChannel('atl-session') 主标签页选举（先到先得、选举心跳 5 秒、15 秒接管、隐藏 15 秒且有可见标签页时交出、冲突时 id 小者保留、从标签页把自己 watch 的会话随选举心跳告诉主标签页）；当前会话发现（启动、state_changed、进入终态、无会话时 60 秒）；游标存 sessionStorage `atl.events.<sid>`，首次从头按页消费、广播收到的事件也推进游标；按 id 去重排序、界面只拿最近 200 条；`ver` 更小的迟到视图丢弃；`session.*` 事件立即补拉视图；§7.3 的节奏（`viewIntervalMs` / `eventsIntervalMs`，P13 #18 的 5 秒、全部隐藏 60 秒、无 BroadcastChannel 加倍）；退避 1→60 秒；事件 4xx 丢弃游标重建 |
| 心跳、对时、连接 | `heartbeat.ts`、`serverClock.ts`、`connectivity.ts` | 每个可见的工作台标签页各自发心跳（首次立即，之后 60 秒，回到前台补发，只对学员）；serverClock（往返中点估偏差、偏差 > 2 分钟提示、睡眠检测）；离线 = navigator.onLine 为 false 或连续 3 次网络错误 / 5xx，恢复时立即刷新 |
| 认证 | `src/auth/` | 生产：Cognito 托管登录（授权码 + PKCE S256，state / verifier / next 存 sessionStorage 并在回调后删除，next 只允许站内相对路径）；访问令牌只在内存，刷新令牌在 sessionStorage；退出时撤销刷新令牌、BroadcastChannel('atl-auth') 通知其他标签页。dev：`config.json` 为 `"auth": "dev"` 且页面在本机地址时，登录页显示开发身份表单，生成 dev-server 认可的 `dev.<group>.<sub>[.<authTime>]`（可模拟 61 分钟前登录以测试 REAUTH） |
| 全局框架 | `src/components/` | Shells（跳转链接、header / nav / main / footer 地标、路由切换后焦点到 h1、错误边界随路由复位）；GlobalBar（标志 + 非 AWS 官方、一级导航 aria-current、≡ 抽屉、--topbar-h）；SessionPill（§3.3 的 10 种外观，模型 `sessionPillModel.ts` 纯函数；会话菜单：回到工作台 / 查看回收进度 / 管理保留 / 取消… / 延长 n 分钟（置灰原因）/ 结束实验… / 会话详情）；AccountMenu（区域、`••••后 4 位`、学员“显示”10 秒、主题、退出）；`globalBanners.ts`（§3.6 九种横幅的来源与优先级，纯函数）；OfflineBar 与页脚（轮询状态、时钟偏差）；P13：ErrorBoundary、NotFound、RoleDenied、NoRole、PlatformUnavailable、登录过期与 ReauthDialog；useExpiryAnnouncements（15 / 5 / 1 分钟与 0 各播报一次）、useEnvDegraded、G 序列快捷键；SessionActions（取消 / 延长 / 结束对话框的注册点，默认是说明对话框） |
| 全局数据 | `src/app/globalStatus.tsx` | GET /platform（3 次失败 → 平台不可用）、/me、/platform/guardrails（5 分钟）、/catalog（60 秒，版本变化 → 横幅 8）、/resources/manual（学员与助教 60 秒）、目录索引中的费用档位（胶囊用）；首次设置完成写 PATCH /me `onboarding` 并在本机记降级标记 |
| 画面 | `src/features/*` | P01 登录、回调、已退出已实现；P00 桩带“完成 / 跳过”（否则学员会被守卫一直送回 /setup）；P04/P05 桩已接 SessionSync 订阅、心跳与 `workspaceRender`；P07 桩按 `endRender` 重定向；P12 桩按页签与角色裁剪；其余是 PageStub。xterm 的按需加载与创建参数在 `features/workspace/terminal/xterm.ts` |
| 联调 | `scripts/dev.mjs` | `npm run platform:dev`：DynamoDB Local 不可达时 `docker compose … up -d --wait` → 建表（幂等，不加 --seed，不覆盖已有 PlatformConfig）→ dev-server（--dev-mode --seed-catalog，等 /api/v1/public/health）→ Vite（127.0.0.1:5174，代理 /api、/content、/__dev）；选项 --no-db、--api-only、--web-only、--api-port、--web-port、--no-seed-catalog |

根目录的改动：`platform:dev` 改为上面的启动器，原来的命令改名 `platform:dev:api`；新增 `build:web`；`build` 增加 web 的两份 tsc 检查；
`platform:test` 与根 `vitest.config.ts` 增加项目 `atl-web`；`eslint.config.js` 给 `platform/web/src` 加浏览器全局与 react-hooks 规则。

### 2. 如何运行

```bash
npm run platform:dev                 # 浏览器打开 http://127.0.0.1:5174/ ，开发模式登录 learner / u1
npm run build -w @atl/web            # → platform/web/dist（npm run platform:package 会把它打进 atl-web.zip）
npm run lint -w @atl/web && npm run test -w @atl/web
```

### 3. 自测结果（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28）

| 自测 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build`（含 web 的两份 tsc）、`npm run build -w @atl/web` | 通过；首屏 JS 291 kB（gzip 96 kB），各画面按需加载 |
| 检查 | `npm run lint` | 0 个问题 |
| 单元 / 组件测试 | `npm test` | 143 个文件、1743 个测试通过（18 个跳过，需外部服务）；其中 atl-web 12 个文件、191 个测试 |
| 联调 | `npm run platform:dev` + 系统 Chrome 无头（Playwright） | 28/28：未登录 → /login?next；dev 登录 → 首次设置 → 目录；顶栏、打码账号、aria-current、页脚轮询状态；经 API 开始 svc-storage（noop 运行器）后胶囊出现（正在准备环境 · 已用 m:ss）→ 点击进入工作台（无顶栏）→ 工作台心跳让会话 READY → RUNNING → 回目录胶囊“实验中 · 1:30:51”、会话菜单与 Esc 焦点回位、结束对话框桩；暗色主题；经 API 结束后胶囊转到 /sessions/:sid/end，P07 桩渲染；观察者进入 /resources/manual 为“角色不足”；未知路由在框架内；375px 无横向滚动；无控制台错误、无 5xx |

### 4. 设计有歧义时的取舍

1. **设计系统的位置**：任务要求放在 `src/ui/`，08 §6.1 写 `src/styles/tokens.css`、§6.9 写 `src/components/icons/`。token 放在 `src/ui/styles/tokens.css`，
   图标与状态形状是 `src/ui/Icon.tsx`、`Shape.tsx`；跨画面的全局框架组件仍按 §2.6 放在 `src/components/`。
2. **token 的根节点**：08 §6.1 说根节点改为 `.atl-app`。token 声明在 `:root`（body 的显式背景与挂到 body 的对话框、抽屉也能取到），SPA 容器 `#root` 带
   `.atl-app` 类名；暗色选择器沿用 `:root:not([data-theme="light"])` 与 `:root[data-theme="dark"]`。原型的 `.proto-*` 不移植。
3. **API 客户端不是生成的**：08 §2.6 要求由 `@atl/contracts` 的 openapi.yaml 生成，但该契约尚不存在。客户端直接用 `@atl/shared` 的路由表，
   响应类型按 platform/api 当前实现手写在 `api/types.ts`（只声明框架用到的字段）。
4. **dev 令牌**：dev-server 没有“签发令牌”的端点，它的契约是 `dev.<group>.<sub>[.<authTime>]` 这一格式（DevAuth）。SPA 按这个格式在本地生成；
   只在 config.json 为 `"auth": "dev"` 且页面在本机地址时启用，生产 API 也只认 Cognito 令牌。
5. **退出后的去向**：模板把 Cognito 的 LogoutURLs 与 config.json 的 `logoutUri` 登记为平台根地址，08 要求回到 `/auth/signed-out`。退出前在 sessionStorage
   记一个标记，`/` 看到标记就转到 `/auth/signed-out`。
6. **登录过期**：启动时刷新失败 → 守卫重定向 `/login?reason=expired`；使用中刷新失败 → 保留页面、标记过期、弹出“登录已过期”（P13 #5），
   不再发出带令牌的请求，SessionSync 暂停。
7. **需要最近登录后的重放**：ReauthDialog 把原请求（含同一个 Idempotency-Key）存 sessionStorage；结果属于发起请求的画面，所以不做全局自动重放，
   画面在挂载时调用 `takeReauthReplay(routeId)` + `api.replay()`（15 分钟内有效）。
8. **公开验证页 P09-V 不在 SPA 构建中**：01 §13 列有 `web/verify/index.html`，但验证页由 atl-certs 生成并发布（`platform/api/src/services/certificates/static-site.ts`），
   而 WebDeploy 发布 atl-web.zip 时不保护 `verify/` 前缀；若 SPA 也打包 `verify/`，每次安装 / 升级都会用占位页覆盖 atl-certs 发布的页面。因此 web 只有一个入口。
9. **轮询细节**：没有 BroadcastChannel 时间隔加倍（P13 #30）；KEPT、CLEANUP_FAILED 的事件间隔取 max(pollAfterMs, 60 秒)；终态会话只在画面显式 watch
   时 60 秒轮询（会话视图没有“复扫已结束”的字段，停止条件留给 P07 实现者）；页脚的轮询秒数按当前会话状态用同一个函数计算；`/resources/manual` 的间隔
   08 没有规定，取 60 秒。
10. **选举的细节**（08 只规定了 5 秒心跳与 15 秒接管）：新标签页先等 1.2 秒；主标签页看到新标签页时立即宣告自己并发送当前会话与已有视图；收到主标签页的
    任何广播都算“主标签页存活”；冲突时 tabId（时间戳前缀）小者保留。
11. **会话胶囊的费用档位**取目录索引 `costTier.required`（静态 `/content/<v>/catalog/index.json`，GlobalStatus 读取一次）；读不到时不显示档位。
12. **没有实现、留给画面实现者的全局件**：ProgressDisclosure 的内容（GET /me/progress、recommendNext）、命令面板 Ctrl+K、`?` 快捷键与图例、
    浏览器通知与 T-15 / T-5 本地兜底定时器（SessionSync 快照 + `urgencyOf` 已可用）、取消 / 延长 / 结束对话框（`SessionActionsProvider` 的 `dialogs` 注册点）。
13. **Storybook 与 axe**（08 §2.6、§8.1）：本轮不引入；§5 组件的变体与状态用 Vitest + Testing Library 覆盖（role、aria-*、焦点、键盘）。
14. **构建产物**带 sourcemap；不内联任何资源（`assetsInlineLimit: 0`），CSP `script-src 'self'`、`style-src 'self'` 下可用；组件不写 style 属性
    （SVG 的反色笔画改用类名）。xterm.js 6 运行时创建 `<style>` 的问题（08 V-4、03 §3.7.6）未处理。
15. 任务说明写“§9.2 列有 24 处 API 缺口”，08 当前版本（v1.1）为 34 项；客户端只能调用已登记的路由，这些缺口一律按各条的“回写前降级”处理。

### 5. 需要其他部分配合

- **infra**：① Cognito 客户端 LogoutURLs 与 config.json `logoutUri` 增加 `/auth/signed-out`（之后可删去第 4 节第 5 条的标记）；② `platform:build` /
  打包前执行 `npm run build:web`（`platform/web/dist` 存在时 package.ts 才打真实 SPA）；③ 决定 `verify/` 的归属：WebDeploy 是否把 `verify/` 列入受保护前缀，
  package.ts 的占位 zip 目前也带 `verify/` 占位页。
- **01 / api**：`GET /platform` 目前对助教、观察者也返回完整 `accountId`（08 §9.2 #3 要求只对学员）；`GET /resources/manual` 的条目没有 `labId` 与会话时间，
  横幅只能写“之前的实验”；事件游标失效的错误码（§9.2 #22，前端已按“任何 4xx 都重建”降级）；`allowedActions` 的枚举（§9.2 #27，API 另有 `reuse`）。
- **contracts**：`@atl/contracts` 的 openapi.yaml 生成后，用生成的类型替换 `api/types.ts`。
- **各画面实现者**：替换 `features/*` 的桩；会话动作对话框经 `<AppRoutes dialogs={…}>` 注册；需要重放的敏感操作在挂载时调用 `takeReauthReplay`。

### 6. 依赖

`npm install --before=2026-09-29` 只新增 `@xterm/xterm` 6.0.0 与 `@xterm/addon-fit` 0.11.0；react、react-dom、react-router-dom、vite、
@vitejs/plugin-react、@testing-library/react、jsdom 等已在 lockfile 中（CloudAlbum 前端在用），`@atl/web` 声明为自己的依赖。
没有引入：Storybook、axe-core（无障碍自动检查）、@testing-library/user-event。

## platform-ssm-client

新的 workspace 包 `platform/ssm-client`（`@atl/ssm-client`）：浏览器端 Session Manager 数据通道协议客户端（03 §3.5）、xterm.js 适配器，
以及一个按同一协议工作的本地模拟服务器（Node，`ws`），供 web 的 dev 模式和测试使用。全程没有调用真实的 AWS API，也没有部署任何东西；
模拟服务器只监听 127.0.0.1，不访问 AWS。

### 1. 协议依据（2026-10-14 用 WebFetch 核实，源码注释逐处注明）

| 来源 | 用到的内容 |
|---|---|
| aws/session-manager-plugin（Apache-2.0，最新标签 1.2.896.0，2026-10-09）`src/message/clientmessage.go`、`messageparser.go` | 帧头各字段长度与偏移；HeaderLength 写 116（PayloadLength 的偏移）；`putString` 用空格右填充、`getString` 去掉首尾 0x00 与空白；`putUuid` 先放低 64 位；摘要是原始 SHA-256；`Validate` 的检查顺序（start/pause_publication 跳过，PayloadLength 为 0 时不验摘要）；确认消息为 SequenceNumber 0、Flags 3、PayloadType 0 |
| 同上 `handshakemessage.go`、`src/service/service.go` | HandshakeRequest/Response/Complete 的字段与 JSON 名，ActionType、ActionStatus（1/2/3）；OpenDataChannelInput 的五个字段 |
| 同上 `src/datachannel/streaming.go`、`src/config/config.go` | 输入 Flags 0、单独的 `\n` 改成 `\r`、序列号在发送并入缓冲后加 1；收到 seq == expected 时处理、确认、排空乱序缓冲，seq > expected 时确认并缓冲（满则丢弃且不确认），seq < expected 时丢弃且不确认；握手请求、握手完成先确认后处理；只看缓冲队首、超过 RTO 就重发；RTO 初值 200ms、RTT 100ms、系数 1/8 与 1/4、时钟粒度 10ms、上限 1s；缓冲容量 10000；每 100ms 扫描、最多重发 3000 次；载荷最大 1024 字节；重连参数为初始 100～199ms、倍率 2、上限 5s、5 次；ping 间隔 5 分钟；start/pause_publication 忽略 |
| 同上 `src/sessionmanagerplugin/session/session.go`、`sessionhandler.go`、`RELEASENOTES.md` | `ProcessFirstMessage`（第一条消息是 Output 即视为跳过握手）；`ResumeSessionHandler`（换新令牌和 StreamUrl 后 `Reconnect`，序列号不重置）；StreamUrl 校验（只接受 wss/ws、拒绝 userinfo、主机须为可识别的端点；1.2.889.0 起）；OpenDataChannel 签名的历次变化（1.2.688.0 加入、1.2.694.0 回滚、1.2.764.0 恢复） |
| aws/amazon-ssm-agent `agent/session/datachannel/datachannel.go` | 模拟服务器里 Agent 一侧的行为：先发 HandshakeRequest、等 HandshakeResponse、再发 HandshakeComplete；握手期间其他输入照常确认但忽略；重复消息会再次确认 |
| bertrandmartel/aws-ssm-session `src/ssm.js` | 只作对照：它在 MessageType 左侧填 0x00、把 32 个十六进制字符当摘要、序列号是模块级全局变量；本实现不采用这些写法 |

`PROTOCOL_COMPAT_VERSION = '1.2.896.0'`（OpenDataChannel 与 HandshakeResponse 的 `ClientVersion`）。对齐新版插件时，先重读上表文件、重跑测试，再改这个常量。

### 2. 实现范围

| 部分 | 位置 | 内容 |
|---|---|---|
| 编解码 | `src/codec.ts`、`uuid.ts`、`constants.ts` | ClientMessage 编码、解码与校验（`ProtocolError` 带错误码）；UUID 线上字节序；同步 SHA-256（`@noble/hashes/sha2.js`，不用 WebCrypto 的异步 digest，以免打乱处理顺序） |
| 载荷 | `src/payloads.ts`、`handshake.ts` | OpenDataChannel 文本帧；AcknowledgeContent；SizeData；ChannelClosed（解析失败时按零值处理，与插件一致）；握手做成纯函数：只接受 `Standard_Stream`，KMSEncryption 回 Failed 并附 `ATL web terminal does not support KMS session encryption`，其他会话类型与未知动作回 Unsupported |
| 可靠传输 | `src/channel.ts` | `DataChannel`（`role: 'client' \| 'agent'`，与 WebSocket 无关）：发送缓冲与 RTO 重发、乱序缓冲、重复丢弃（`reackDuplicates` 可选）、摘要错误时丢弃且不确认、确认可以延后（由 sink 的 `ack()` 触发）、发不出去的确认留到续连后补发、`resendUnacknowledged()`、诊断事件与计数 |
| 连接 | `src/connection.ts` | `SsmTerminalConnection` 实现 03 §3.5.9 状态机：requesting → connecting → authenticating → handshaking → ready；ready → reconnecting → resuming → connecting → ready（标记 resumed）；failed / closed。失败原因有 open-failed、invalid-stream-url、connect-failed、handshake-timeout、kms-unsupported、session-type-unsupported、gone、resume-rejected、reconnect-exhausted、connection-lost。还包括：15 秒握手超时（也限制建立 socket 的时间）；Ready 之前的按键与尺寸排队（上限 1 MiB）；按 1024 字节、不切断 UTF-8 字符地分片；尺寸只在变化时发送，进入 Ready 与续连后各发一次；channel_closed 带出 Output 文本（由 UI 结合 `readyAt` 与 `lastInputAt` 区分空闲断开还是到达最长时长）；`close('user' \| 'access-revoked')`；`connectBy` 已过时不用这个令牌，直接走 resume；离线时暂停计数，`online` 后继续；`retryNow()`；可选的 `sizeNudgeIntervalMs`（对应 `terminal.keepalive = size-nudge`）；`getTabClientId()`（存 sessionStorage；存储不可用时每次新生成 UUID） |
| 适配器 | `src/xterm.ts` | `attachXterm`：onData / onBinary 进 `sendInput`；输出调用 `term.write(bytes, ack)`，在回调里确认，形成背压；onResize 进 `resize`；结束或失败后把终端设为只读。另有 `pasteText`（走 `term.paste`）和 `observeContainerResize`（ResizeObserver，去抖 150ms，拖动分隔条时暂停）。只用结构类型，不 import `@xterm/xterm`；测试里用 tsc 检查它与 xterm 6 的 `Terminal` 兼容 |
| 模拟服务器 | `src/mock/*` | `MockSsmService` 模拟服务与 Agent：StartSession / ResumeSession / TerminateSession，令牌一次性、60 秒有效；Agent 一侧复用 `DataChannel`（role agent，重复消息会再次确认）；握手可选 session-type、none、kms；空闲超时与最长时长；输出按固定字节数切分，可能切断 UTF-8 字符，与 pty 读取一致；故障注入可模拟丢包、重复、乱序、摘要损坏、丢确认；`dropConnection` 模拟断网。`FakeShell` 是假的 shell：tty 回显、退格、^C、^D、^U，`echo`、`printf`、`stty size`、`tput`、`whoami`、`id`、`hostname`、`pwd`、`cd`、`date`、`uname`、`seq`、`sleep`、`clear`、`exit`，带 03 §3.7.5 的 OSC 133/7 标记与主机角色提示符，**不提供 `aws`**。`EchoShell` 原样回显。`startMockSsmServer` 提供 ws 数据通道 `/v1/data-channel/{SessionId}`，以及按 SSM 动作命名的 JSON 控制接口（`/StartSession`、`/ResumeSession`、`/TerminateSession`、`/DropConnection`、`/sessions`、`/health`）；CLI 为 `src/mock/cli.ts`。另有内存 socket 对（`memoryWebSocketFactory`），在假定时器下测试结果确定 |

### 3. 如何运行与自测结果（2026-10-14，Windows 11 / Node 22.14.0）

```bash
npx tsc -b platform/ssm-client/tsconfig.json platform/ssm-client/tsconfig.mock.json   # 构建 → dist/（已被 .gitignore 忽略）
npx tsc -p platform/ssm-client/tsconfig.test.json                                      # 源码 + 测试类型检查（含 xterm 6 兼容性）
npx eslint platform/ssm-client
npx vitest run --root platform/ssm-client
npx tsx platform/ssm-client/src/mock/cli.ts --port 8790                                # dev 用的本地模拟服务器
```

| 自测 | 结果 |
|---|---|
| 构建与类型检查 | 通过。核心项目设置 `types: []`、lib 为 DOM：只要用到 Buffer、process 或 `node:*` 就编译不过。另用 esbuild 以 `--platform=browser` 打包核心：36.7 kB，gzip 后 12.7 kB，没有引入 Node 内置模块 |
| ESLint | 0 个问题 |
| Vitest | 6 个文件、88 个测试全部通过：编解码往返与手工拼出的黄金帧（摘要用 node:crypto 独立计算）、UUID 字节序、填充、摘要与校验错误；载荷与握手；StreamUrl 与退避；序列号与确认、RTO 公式、只重发队首、发送失败不计次、重发次数用尽、乱序、重复、缓冲区满、摘要损坏、确认延后与续连后补发；在 25% 丢包、5% 重复并轻度乱序的链路上双向各发几百条，全部按序恰好送达一次；连接部分覆盖两条握手路径、KMS 被拒、握手超时、错误令牌、非法 StreamUrl、输入排队、尺寸变化、`\n` → `\r`、64 KB 中文粘贴、背压、乱序/重复/损坏的输出、channel_closed（空闲、exit、TerminateSession）、access-revoked、断网续连后输出无丢失无重复且序列号连续、gone、resume-rejected、退避 100/200/400/800/1600ms 后失败、离线暂停、retryNow、重发次数用尽后续连、connectBy 已过期、没有 resume 函数；xterm 适配器；FakeShell；基于真实 ws 的模拟服务器（HTTP 控制接口、端到端 shell、`seq 1 2000` 时断网后续连、令牌重用被拒、TerminateSession） |
| 浏览器 | 用系统 Chrome 无头模式（Playwright）跑打包后的客户端，连本地模拟服务器：握手 → ready、`stty size` 正确、中文回显正确；`seq 1 3000` 时断网，续连后 3000 行无丢失、无重复，状态序列中出现 `ready(resumed)`；`exit` 后收到 channel_closed |

### 4. 设计有歧义时的取舍（偏离 03 §3.5 之处）

1. **位置**：03 §3.5.12 把协议层放在 `platform/web/src/workspace/terminal/ssm/`。本任务要求做成独立包 `platform/ssm-client`；模块划分沿用 03 的
   constants、codec、handshake、channel、connection，另拆出 payloads、uuid、bytes、streamUrl、backoff、socket、timers、xterm。这样 07 V2-2 的 Node PoC
   可以直接复用：Node 22 自带全局 WebSocket，不需要 `ws`。
2. **续连后立即进入 Ready**：03 §3.5.9 的图是 Resuming → Connecting → Authenticating → 等 Output。但空闲的 shell 不会输出，照图实现会在 15 秒后误报超时。
   因此发出 OpenDataChannel 后立即 Ready：先重发未确认的消息，再发一次尺寸，然后发出排队的输入。如果 Agent 随后又发起握手，照常应答（进入 handshaking，期间输入排队）。
   续连的尝试次数在新 socket 收到第一帧时清零；重发的尺寸一定会被确认，所以总能收到这一帧。
3. **首次 Ready 之前 socket 断开 → `connect-failed`**，不续连（图上 Authenticating 没有指向 Reconnecting 的边）。
4. **断线期间的输入照样编号并进入发送缓冲**，续连后补发（插件在发送出错时直接丢弃这条输入）。sink 回调里发不出去的确认先暂存，续连后先补发确认，再重发数据。
5. **重发次数用尽只报告一次**（`resend-exhausted`），连接按“已失效”处理并走续连（03 §3.5.8）。插件此时会继续重发，并调用 TerminateSession。
6. **重复消息默认不再确认**，与插件和 03 §3.5.5 一致，可用 `reackDuplicates` 打开。在丢包链路测试里，只有打开它才会收敛：确认一旦丢失，Agent 会一直重发。真实环境里是否发生，列为 PoC 项（第 5 节第 6 条）。
7. **握手中的未知动作**回 `ActionStatus: 3` 并附错误文本。插件的做法是不设状态，而在 ActionResult 里写 Unsupported。
8. **握手进行中收到 Output**：照常显示，但不结束握手。payload 类型 Error(2)、StdErr(11) 按 Output 显示；ExitCode(12) 只作为诊断事件。
9. **StreamUrl 客户端校验**：不给 region 时接受任意 `ssmmessages.<region>.amazonaws.com(.cn)`；双栈或其他主机通过 `additionalHosts` 显式加入；
   `ws://` 只在 `allowLoopback` 且主机为回环地址时接受（dev 模式）。服务端校验（03 §3.2 第 8 步）属于 api。
10. **没有 Go 生成的互操作黄金样本**（03 §3.5.13 要求 `fixtures/*.bin`）：需要 Go 工具链和插件源码，本机没有。测试里的黄金帧按 clientmessage.go 的布局逐字段手工拼出，
    摘要用 node:crypto 独立计算。拿到 Go 环境后，应补上“Go 序列化 → JS 解码”和“JS 编码 → Go 解码”两个方向的比对。
11. **模拟服务器中真实情况未知的部分**（代码里标注 `mock:`）：错误或重复使用的令牌以 1008 关闭；channel_closed 帧的 PayloadType 用 0；空闲断开、最长时长的 Output 文案由模拟服务器自拟，不冒充 AWS 原文；
    续连时 Agent 重发全部未确认的输出；令牌 60 秒有效。
12. **`ws` 的类型**：@types/ws 没有安装，模拟服务器用 `createRequire` 加载 ws，接口类型在 `server.ts` 里本地声明。

### 5. 必须到真实 AWS 上验证的行为（对应 07 阶段 2、03 §10 P0）

| # | 行为 | 本实现的假设 | 07 / 03 |
|---|---|---|---|
| 1 | 未签名的 OpenDataChannel（只靠 TokenValue）能否连上；预签名 URL 能否连上 | 只用令牌；StreamUrl 原样使用（预签名的 URL 也能直接传入） | V2-3 第 2 步；P0 ①② |
| 2 | `ssmmessages` 是否校验浏览器的 `Origin` | 不校验 | V2-3 第 3 步；P0 ⑨ |
| 3 | ATL-SessionShell（Standard_Stream）会话里 Agent 是否发起握手，HandshakeRequest 的实际内容（AgentVersion、Properties、是否带其他动作） | 两条路径都支持；只接受 Standard_Stream | V2-2 第 2 步；P0 ③ |
| 4 | 帧头逐字段与官方插件一致（MessageType 填充、UUID 字节序、摘要、确认消息的 Flags 3 / PayloadType 0），以及 Agent 是否校验这些字段 | 按插件源码实现 | V2-2 第 6 步（官方插件对照）；03 §3.5.13 黄金样本 |
| 5 | Size 生效：改尺寸后 `stty size` 正确 | `{"cols","rows"}` 作为 input_stream_data / PayloadType 3 | V2-2 第 2 步；P0 ④ |
| 6 | ResumeSession 续连：新 StreamUrl 和令牌能否连上；Agent 是否重发未确认的输出、是否重新握手；`seq 1 20000` 无丢失无重复；确认丢失后 Agent 是否持续重发（决定 `reackDuplicates` 的默认值） | 序列号和缓冲保持不变；续连后立即 Ready；重复消息不再确认 | V2-2 第 3 步；P0 ⑤ |
| 7 | channel_closed 的载荷结构与 Output 文案：exit、空闲超时、TerminateSession、最长时长；TerminateSession 之后多久收到关闭 | 按 clientmessage.go 的 ChannelClosed 解析；UI 用 Output 加时间判断原因 | V2-2 第 5 步、V2-4 c；P0 ⑥ |
| 8 | 中文输出与 64 KB 粘贴（按 1024 字节分片，不切断 UTF-8 字符） | 已在模拟服务器上通过 | V2-2 第 4 步；P0 ⑦ |
| 9 | 私有放置（只有 VPC 终端节点）时，浏览器拿到的 StreamUrl 主机名是否仍是公共的 `ssmmessages.<region>.amazonaws.com` | 是；否则用 `additionalHosts`，CSP 也要同步 | P0 ⑧ |
| 10 | 错误、过期或重复使用的令牌时服务端的表现（关闭码、是否发文本帧）；TokenValue 的实际有效期是否覆盖 30 秒的 `connectBy` | socket 在 Ready 前关闭 → connect-failed；超过 connectBy 就走 resume | V2-2 |
| 11 | 浏览器不能发 WebSocket ping：长时间空闲（超过 5～10 分钟）的连接是否会被服务端或中间网络断开；`size-nudge` 是否会重置 `idleSessionTimeout` | 不做保活，断开后靠续连恢复；size-nudge 默认关闭 | 03 §3.5.8；V2-2 第 5 步 |
| 12 | start_publication / pause_publication 是否会发给浏览器客户端，频率如何 | 只计数，不做流控 | V2-2 |
| 13 | 背压：确认延后到 xterm 解析之后，Agent 是否会因此放慢（`cat` 大文件），且不会触发 Agent 的重发超时 | RTO 上限 1 秒，xterm 回调通常在毫秒级 | V2-2 第 3 步 |
| 14 | `ClientVersion = 1.2.896.0` 时，Agent 是否会在 Standard_Stream 会话里发 StdErr / ExitCode（PayloadType 11 / 12） | 11 按输出显示，12 只记诊断 | V2-2 第 2 步 |
| 15 | 15 秒握手超时对真实的冷启动 Agent 是否够用 | 平台参数，可通过 `handshakeTimeoutMs` 调整 | V2-2 |

### 6. 需要其他部分配合

- **根目录（集成负责人）**：并行阶段我没有改根文件，下面几项需要登记，之后再 `npm install`，让 lockfile 链接 `@atl/ssm-client`：
  - `package.json`：workspaces 加 `platform/ssm-client`；`platform:test` 加 `--project atl-ssm-client`；`build` 或 `platform:build` 加 `tsc -b platform/ssm-client/tsconfig.json platform/ssm-client/tsconfig.mock.json`；
  - `vitest.config.ts`：projects 加 `platform/ssm-client`；
  - `vitest.shared.ts`：别名 `@atl/ssm-client` → `src/index.ts`，`@atl/ssm-client/mock` → `src/mock/index.ts`；
  - `tsconfig.json`：references 加这两个 tsconfig；
  - `eslint.config.js`：可以给 `platform/ssm-client/src/**`（不含 `src/mock/**`）加浏览器全局变量，并禁止导入 `node:*`。
- **web**：
  - 把 `@atl/ssm-client` 登记为依赖，用 vite alias 和 tsconfig paths 指向源码；目前 `platform/web/src/workspace/terminal/channel.ts` 用 `import.meta.glob` 加载，接口与本包一致；
  - `scripts/dev.mjs` 启动模拟服务器（`tsx platform/ssm-client/src/mock/cli.ts --port 8790`）；
  - 生产环境传 `streamUrlPolicy: { region }`，dev 传 `{ allowLoopback: true }`；`clientVersion` 取 API 返回的字段；
  - xterm 在 CSP 下的样式问题（03 §3.7.6）仍未处理。
- **api**：
  - dev 模式的 `WorkspaceProvider.openTerminal`、`resumeTerminal`、`closeTerminal` 改为调用模拟服务器：可以在进程内 `new MockSsmService()`，也可以调它的 HTTP 控制接口；`sessionName` 传 `atl-<sid>-term`，`role` 按 target；
  - `DoesNotExistException` 映射为 `409 TERMINAL_GONE`；
  - 响应里带上 `connectBy`，以及 `clientVersion = PROTOCOL_COMPAT_VERSION`；
  - 生产环境的 StreamUrl 主机校验仍归 api。
- **07 PoC 执行者**：V2-2 的 Node 驱动可以直接用 `SsmTerminalConnection`（Node 22 全局 WebSocket，传入 `open` 和 `resume`）；第 5 节的结论回写 03 §3.5，以及本节第 4 部分第 2、6、11 条。

### 7. 依赖

没有运行 npm install。`package.json` 声明的 `@noble/hashes` ^1.8.0（@atl/workflows 已在用）、`ws` ^8.18.0（lockfile 里是 jsdom 的依赖，8.22.0），以及开发依赖
`@xterm/xterm` ^6.0.0（只用于类型兼容检查），都已经提升到根目录的 node_modules。lockfile 里还没有 `@atl/ssm-client` 这个 workspace 条目。
缺少：@types/ws（目前用本地声明代替）；Go 工具链和插件源码（用于生成互操作黄金样本）。

## platform-web-catalog

`platform/web/src/pages/{setup,login,labs,tracks,card,quiz,learning,settings}`：P00 首次设置、P01 登录、P02 卡片目录（网格 / 服务地图 / 路径、筛选）、
P02-T 路径详情、P03 卡片简介页（P03-D 开始对话框、报价与费用确认）、P03-Q 小测、P10 我的学习、P12 设置（含升级、卸载三步）。
全程没有调用真实的 AWS API，没有部署；dev 联调只用本机的 DynamoDB Local 与 dev-server。

### 1. 实现范围

| 画面 | 位置 | 要点 |
|---|---|---|
| 共用 | `pages/labs/{types,model,data,strings,keys}.ts`、`components/`、`catalog.css` | 静态内容（index.json、cards/<id>.json）按地址缓存；`useResource`（可见时轮询、失败保留旧数据）；纯函数：查询串 ⇄ 目录状态、卡片状态（05 §2.9）、筛选与计数（同维并集、跨维交集、“其他维度不变”的计数）、搜索（原 Lab 编号精确匹配）、排序、分组、路径进度与证书条件（与 api `trackProgress` 同规则）、`recommendNext`（05 §2.11）、服务格、几何方向键；组件 CardTile / CardRowCompact、EnvironmentBar、ContinueStrip、FacetBar、ServiceMap + ServiceCellPanel、TrackHead / TrackStageList / TrackNode、BadgeMark、ProgressRing、SegmentedProgress（全部内联 SVG，不写 style 属性） |
| P00 | `pages/setup/` | 学员 7 步、助教 / 观察者 2 步；体检项映射（`preflight.ts`）；只复制的修复命令、危险命令放在“我确认要删除”折叠区；完成 = PATCH /me（显示名、证书署名、当前路径）+ `markOnboarded`，去 next / 当前会话 / 目录；跳过同样写入完成并让目录页提示一次 |
| P01 | `pages/login/` | 从脚手架移植并补齐：原因提示（形状 + 文字）、全宽按钮、回调的“登录未完成”三种失败、已退出页 |
| P02 | `pages/labs/CatalogPage.tsx` | 查询串是唯一状态，URL 没有参数时恢复 localStorage `atl.catalog.v1`；`/` 聚焦搜索、Esc 清空；结果数 3 秒合并播报；个人进度失败时卡片照常显示、“状态”维度置灰；服务地图掌握度失败时只画格子；planned 卡片显示“即将推出”标签 |
| P02-T | `pages/tracks/` | 证书条件表、领取对话框（422 原因回显，REAUTH 交给全局对话框重放）、阶段列表、历史证书 |
| P03 / P03-D | `pages/card/` | 开始按钮由 `startModel`（startability + 本地预判：维护 / 卸载 / 预算 / 其他会话 / 回收中 / 保留环境 / 残留 ack-block-ignore）决定；概览 mdast 按二级标题放入对应区块（链接只允许站内与 AWS 文档）；生成区块按 05 §7.3 句式；开始对话框：打开即报价、选项变化重新报价并清除勾选、报价倒计时（≤ 2 分钟琥珀、过期“重新计算费用”）、未估算 / 预算 WARN / 残留各自的额外勾选、学员输入即时校验与草稿、`POST /sessions` 同一操作复用 Idempotency-Key、202 立即进入工作台、错误按 08 P03-D 表处理；`?start=1` 打开后移除；“释放后全新开始”与“计算当前价格” |
| P03-Q | `pages/quiz/` | 抽题、每次选择自动保存、交卷后只给正确率与按领域正确率，焦点到结果标题；单选是 radiogroup |
| P10 | `pages/learning/` | 四个页签（链接 + aria-current，窄屏下拉）；路径进度行、服务地图、徽章墙（等级 / 状态筛选、详情抽屉）、最近实验；收到 badge./track./certificate./mastery. 事件时刷新 |
| P12 | `pages/settings/` | 9 个页签按角色裁剪，卸载中只读；平台设置只 PATCH 变化字段并带 If-Match（412 刷新提示、字段错误回填）；成员邀请 / 删除；内容版本“标记为有缺陷”；审计（来源 IP 学员打码可还原、助教不显示）；升级四步；卸载：导出（同一键每 10 秒重试，最多 10 分钟）+ 清单 Markdown / JSON、阻塞项每 10 秒、输入 atl 确认后 prepare、ready 且终止保护关闭后出现第 3 步 |

### 2. 偏离设计与取舍

1. 页面按本阶段的分工放在 `src/pages/<area>/`（08 §2.6 写的是 `src/features/*`）；`src/app/routeTable.ts` 仍指向脚手架的 `features/*` 桩，本阶段不能改它。
2. 文案放在各目录的 `strings.ts`（`labs/`、`card/`、`learning/`、`settings/`、`setup/`），没有并入 `src/i18n/zh-CN.ts`（不在本阶段范围）；共用文案仍取 zh-CN.ts。
3. 跨画面的目录组件放在 `pages/labs/components/`（08 §5 写的是 `src/components/`）；`ClaimCertificateDialog` 放在 `pages/tracks/`，P09 可直接复用。
4. 报价：API 的报价请求不接受工作台模式，选 CloudShell 时不重新报价，只把“工作台”一行改为“—”；`perSession` 缺失时构建行写“未提供”，Price List 不可用时写“未知”；`pricing: fixture`（dev 示例单价）在明细上方注明“不是 AWS 价格”；服务端说明里提到内部组件名的句子不显示（§1.6）。
5. “最近尝试”排序另读 `GET /sessions?limit=100`（`GET /labs` 的条目没有时间）。
6. 服务格侧栏不拆“单服务 60 / 场景 25 / 小测 15”：`/me/mastery` 不返回分项，改为显示徽章等级、计入的场景卡数与小测正确率。窄屏的服务地图是按类别分行的单列列表（没有折叠）。
7. 小测：没有“今日剩余次数”与读取作答的路由，剩余次数不显示（429 时说明用完）；本标签页的作答存 sessionStorage `atl.quiz.v1.<labId>`，`?attempt=` 只用于本标签页刷新后继续。“回看步骤”有本卡进行中的会话时去工作台 `?step=`，否则去简介页步骤概览。
8. P10 最近实验没有“尝试结果”列（列表项没有 `attemptStatus`，§9.2 #15）。
9. P12 个人资料：终端偏好写入工作台使用的 `atl.ws.terminal.v1`（`{fontSize, screenReader, leader}`），浏览器通知只保存偏好 `atl.notify.v1` 并申请权限（发送尚无人实现，§3.9）；邮件偏好不显示（§9.2 #24）。
10. P00：infra 写入的体检项是 `{id, status: ok|warn|info|unknown, detail, hint}`；`default-vpc`、`residual-stacks` 的 warn 视为“需处理”，其余 warn / info 为“提示”；未知 id 显示 detail。“重新体检”不显示（§9.2 #5）。
11. 维护或卸载中，目录页环境条位置只显示“平台维护中 / 正在卸载”（与原型一致，进行中的会话仍在顶栏胶囊里）。
12. 没有 Storybook 与 axe（缺依赖）：组件状态由 RTL 测试与无头 Chrome 检查覆盖。

### 3. 自测结果（2026-10-14）

| 自测 | 结果 |
|---|---|
| `npm run lint -w @atl/web` | 0 个问题 |
| `npm run test -w @atl/web` | 450 个通过（本组 11 个文件 119 个：纯函数、开始按钮与报价、设置模型、各画面的 RTL 测试） |
| `npm run build -w @atl/web` | 通过 |
| dev 联调（私有 DynamoDB Local + dev-server + Vite，临时入口把本组画面挂进与 App 相同的框架，系统 Chrome 无头） | 25/25：首次设置 → 目录 56 张（46 张“即将推出”）、搜索 lab 10、筛选、服务地图 40 格与侧栏、路径视图、简介页、开始对话框（dev 报价“未知”）→ 202 进入工作台、环境条、其他卡片置灰、小测交卷焦点、路径证书条件、我的学习四页签、设置九页签、375px 无横向滚动、暗色、观察者无开始按钮且设置受限；控制台只有一条 404（临时入口没有 favicon） |

### 4. 需要别人配合

- **web 集成**：`routeTable.ts` 改为 `pages/setup/SetupPage`、`pages/login/{LoginPage,AuthCallbackPage,SignedOutPage}`、`pages/labs/CatalogPage`、`pages/card/CardIntroPage`、`pages/quiz/QuizPage`、`pages/tracks/TrackPage`、`pages/learning/LearningPage`、`pages/settings/SettingsPage`（都是 default export），删除对应的 `features/*` 桩；可选：把各 `strings.ts` 并入 i18n。环境条的“取消… / 延长… / 结束实验…”依赖 SessionActions 注册的对话框。
- **api**：`GET /labs` 条目带最近一次会话的时间；`/me/mastery` 返回分数分项；`GET /sessions` 列表项带 `attemptStatus` 与费用摘要（§9.2 #15）；小测的剩余次数与读取作答；报价接受 `workstation`；`GET /audit-events` 对助教去掉 `sourceIp`；`POST /platform/preflight`（§9.2 #5）。

## platform-web-workspace

`/workspace/:sid` 的 P04 准备模式与 P05 分屏工作台，以及 P06 对比实验的抽屉形态（08 P04、P05、P06；03 全文；04 §4、§5.6、§8）。全程没有调用真实的 AWS API，
也没有部署任何东西；终端在 dev 联调中连接 `platform/ssm-client` 的本地模拟服务器。

### 1. 实现范围

| 部分 | 位置 | 内容 |
|---|---|---|
| 路由组件 | `src/pages/workspace/WorkspacePage.tsx` | 订阅会话视图（SessionSync），视图未到时骨架，4 秒后直接读一次拿错误码（404“没有找到这个实验会话”）；之后交给 `workspace/Workspace` |
| 画面主体 | `src/workspace/Workspace.tsx` | 按 §2.4 表 2 渲染 P04 / P05；03 §2.1 的 Workbench 上下文（focusTab、pasteToTerminal、openConsole、runStepCheck……）；前导键 `Ctrl+.`（可换 `Ctrl+\``、`Ctrl+Shift+.`）的 03 §8.2 全表；分隔条与断点（≥ 1280 / 1024～1279 / 768～1023 分段 / < 768）；T-5 提醒（终端有焦点时先显示 2 秒提示条）、到期覆盖层（alertdialog、背后 inert、焦点到主按钮、2 分钟后“补触发”说明）、到期 / 结束时自动关闭延长、结束、T-5 对话框；T-15 / T-5 浏览器通知（页面隐藏且已授权时本地定时器兜底）；就绪后 3 秒的“✓ 环境已就绪（用时 …），倒计时 … 已开始”；心跳（沿用 `WorkbenchHeartbeat`）；`?step=`、`?panel=`、`?check=`、`?exp=` |
| 数据 | `workspace/data/` | 卡片内容 `/content/<v>/labs/<labId>.json` 与目录索引（服务缩写方块）；`/vars`、`/steps`、`/progress`、`/workspace`（60 秒，准备阶段 provision.ssm 之后 15 秒）、`/experiment-runs`、`/cost`（L A，5 分钟）、`/module-ops`；按 §7.4 的事件刷新 |
| 手册 | `workspace/manual/` | mdast 渲染器（不用 dangerouslySetInnerHTML；指令 why / tip / warning / danger / method 标签组 / expected / wait / reveal / saa / code-ref / checks / check / console-link / open-tab / var-input / platform-action / experiment，行内 kbd / term）；变量代入（04 §4.4 的命名空间与过滤器，未解析红色虚线，密钥占位）；变量条（来源标签、刚更新 2 秒高亮、input 变量编辑与 pattern 校验、账号 ID 打码）；步骤下拉 StepRail 与底栏、J / K / R；步骤卡（计费提示、预期中断说明、常见错误与命中、选做跳过、阅读型“我已读完”）；本步检测（CheckResultRow、核验中、等待型检查按 15 / 30 / 45 / 60 秒之后每 60 秒由浏览器重测、命令结束建议条、漂移提示与“我是有意改动的”）；证据抽屉；手动确认；提交实验（先 final-preview）；平台动作；实验卡 |
| 命令块 | `manual/ManualCommand.tsx`、`model/paste.ts`、`workbench/PasteDialogs.tsx` | 复制（scaffold 的 CommandBlock）；“粘贴到终端”按 03 §7.1 / 08 P05.4 的确认矩阵：单行普通直接粘贴；粘贴并执行确认（可“本卡片内不再询问”）；多行在 bracketed paste 下确认 N 行、否则拒绝；危险命令红色确认、不允许执行；未解析变量拒绝并定位变量条；密钥占位拒绝并给出读取命令；终端正忙提供“在新的终端子标签中粘贴”；tmux 不判断忙闲；目标与 runsOn 不一致提示；目标终端未打开时先打开并等 Ready（15 秒），超时则复制并提示；超过 16KB 只能复制；粘贴后焦点到终端、标签闪 150ms、播报；上报 `workspace.command_pasted`（只有 textSha256） |
| 终端 | `workspace/terminal/` | `TerminalController` 建在 ssm-client 的 `SsmTerminalConnection` 上（open / resume 回调走 `POST …/terminals`、`…/resume`；握手超时与连不上时 `DELETE`；access_revoked 立即关闭；OSC 133 忙闲与退出码、OSC 7 当前目录）；`TerminalView`（按需加载 xterm 6 + fit，等容器有宽度后再 fit 并接上连接，避免先发出过小的尺寸；拖动分隔条时不重算）；`TerminalPane`（子标签 #1 #2 +，每实例最多 3 个；身份条；覆盖层 15 种；状态栏；< 768px 按键条，Ctrl / Alt 粘滞；终端菜单：复制选中、清屏、新子标签、结束会话；ENDED 时列出本会话的终端）；dev 模式（config `auth: dev` 且本机地址）传 `streamUrlPolicy.allowLoopback`，生产传 `region` |
| 控制台 | `workspace/console/ConsoleLauncher.tsx` | 点击时同步 `window.open('about:blank', 'atl-aws-console-<随机>')` 并置 `opener = null`，再 `POST …/console-link` 取 form 以 POST 提交到该窗口；被拦截时内联提示，10 分钟内 `target=_blank` 提交同一表单、之后重新获取；签发 / 到期时间取 `/workspace` 的 `console.*`；剩余 ≤ 10 分钟琥珀 + 续期；“最长 1 小时，到期后需要续期”；深链列表；50 分钟内签发过且知道深链 URL 时直接新标签页；错误码文案 |
| 预览 | `workspace/preview/PreviewFrame.tsx` | 懒加载 `/preview`（60 秒）；只把 `embeddable=true` 的 URL 设为 iframe（03 §6.4 的 sandbox、no-referrer、title）；没有受信 HTTPS（MIXED_CONTENT、UNTRUSTED_CERT、FRAME_ANCESTORS_MISSING、X_FRAME_OPTIONS、UNREACHABLE）时改为“在新标签页打开”卡片；< 768px 默认新标签页；入口选择存 sessionStorage；视口 375 / 768 / 自适应；管理员账号对话框（遮盖、显示 10 秒、关闭即清除） |
| 倒计时、延长、结束 | `workspace/timer/`、`model/expiry.ts`、`model/cost.ts` | ExtendDialog（打开与提交前检查 allowedActions 与剩余 > 30 秒；报价 15 分钟倒计时，过期主按钮“重新计算费用”；预算 WARN 追加勾选；If-Match + 同一 Idempotency-Key；409 / 412 / 422 各自处理；“这是最后一次延长”按剩余次数与 maxDeadlineAt 计算）；EndDialog（释放 / 保留 1、4、12、24 小时（上限 min(会话上限, retain.maxHours)）、现在 / 到期时；释放分支给出“回收完成前仍计费 + 本次已产生 ≈ x”；保留置灰原因 6 种；KEEP 报价与勾选；requiresTypedConfirm 时输入卡片 id；前置资源；now → `/sessions/:sid/end`）；CancelDialog（P04）；ExpiryDialog（T-5）；ExpiredOverlay |
| P04 | `workspace/provision/ProvisionPanel.tsx`、`model/phases.ts`、`model/failure.ts` | 6 个可见阶段（名称前缀匹配，未知 phase 进当前阶段的细节行；开始时间取事件时间戳或上一阶段完成时间；排队、重试、80% 部署预算、慢资源提示；阶段完成时播报）；等级说明；计费与“可以离开这个页面”；浏览器通知开关；取消；补偿中 / 已取消（已删除 n/m）；FailurePanel（02 §13.2 码表 → 标题、说明、操作；诊断；复制诊断信息前提示含原文；“这次尝试不计入次数”） |
| P06 | `workspace/experiments/ExperimentCompare.tsx`、`model/experiments.ts` | 变体列（任意标签与角色、记录选择、四段上传进度）、指标对照（服务端值优先、客户端与服务端差异 > 10% 标注）、条形对照 / 数据表切换、差异方向（噪声带 10%）、成对可比性、有效性校验、功能型实验的检查、运行命令（只对学员）、跨会话对比、省钱模式与 ENDING 提示 |
| 其他 | `workbench/` | SessionBar（卡片标识、状态、倒计时 / 已用、费用计（O 只显示每小时估算）、延长（原因节点总在）/ 结束 / 取消、⋯ 菜单：快捷键、终端设置（字号、读屏模式、前导键、粘贴并执行开关）、主题、会话详情、管理员账号）、横幅（T-15、到期预检、保留中、释放未完成、只读存档、环境异常、预算 end-active、平台动作进行中、提交结果）、CostDrawer、Splitter、事件上报器（10 秒或页面隐藏时批量） |
| 样式 | `workspace/workspace.css` | 原型的工作台规则已在 `ui/styles/screens.css`；这里只补实现需要的规则（只用 token；手册栏用容器查询：< 400px 做法标签改下拉，< 640px 检查行改两行） |

### 2. 如何运行

```bash
npm run test -w @atl/web            # 含 workspace/model、workspace/terminal、pages/workspace 的测试
npm run lint -w @atl/web && npm run build -w @atl/web
# 本地联调（路由表接入前用 vite alias 把 ../features/workspace/WorkspacePage 指到 pages/workspace/WorkspacePage）：
npx tsx platform/ssm-client/src/mock/cli.ts --port 8790          # 终端模拟服务器（dev-server 的工作台提供者经 ATL_DEV_SSM_MOCK_URL 使用它）
```

### 3. 自测结果（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28）

| 自测 | 结果 |
|---|---|
| 类型检查与构建 | `tsc -p platform/web/tsconfig.json` 通过；`npm run build -w @atl/web` 通过；另用 alias 把工作台接入路由后 vite build 通过（WorkspacePage 214 kB、xterm 329 kB、ssm-client 38 kB，均按需加载） |
| ESLint | `platform/web/src/workspace`、`src/pages/workspace` 0 个问题 |
| Vitest | 新增 3 个文件 56 个测试：模型 33（变量、确认矩阵、阶段、到期与延长 / 保留、分隔条、检查行、实验对比、失败码、费用）、终端控制器 6（打开参数、API 拒绝 → 覆盖层、协议层缺失、握手超时后 DELETE、重连 n/5、空闲断开、OSC 133、收回）、画面 17（P04 阶段与取消、失败面板、P05 心跳与检测、按需打开终端后粘贴、危险命令确认、延长、结束释放、到期保留、T-15 与 T-5、到期覆盖层、观察者只读、`?exp=` / `?check=` 抽屉、404、控制台同步开窗与表单、弹窗被拦截、预览嵌入与原因、降级手动确认、分隔条键盘与前导键）；atl-web 全部 450 个测试通过 |
| 联调 | 独立的 DynamoDB Local + dev-server（noop 运行器，`ATL_DEV_SSM_MOCK_URL` 指向自己启动的 ssm-client 模拟服务器）+ vite（alias 接入）+ 系统 Chrome 无头，29/29 项通过、无控制台错误：P04 六个阶段、倒计时未开始、手册可读而粘贴禁用、取消对话框、就绪 3 秒过渡 → P05、心跳 READY → RUNNING、取消后的补偿视图（10 项）；P05 工作台终端经 API → 模拟服务器连上（`stty size` = 49 109、回显正确）、命令块粘贴、`⌃. M` 回到手册、控制台标签、预览（HTTP 入口 → 新标签页卡片）、检测与证据抽屉、延长与结束对话框、P06 抽屉、375px 无横向滚动、暗色（15 项）；控制台按钮先开命名空白窗口、POST 表单把它导航到 dev 的联合登录桩、签发时间显示，实验机终端提示符与 `whoami`（4 项）。dev-server 没有工作台提供者时，`POST …/terminals` 返回 501，终端显示“终端暂时不可用” |

### 4. 设计有歧义时的取舍

1. **路由未接入**：路由表仍指向脚手架的 `features/workspace/WorkspacePage`（不在本任务路径内）。接入只需把 `/workspace/:sid` 的组件改为 `pages/workspace/WorkspacePage`。
2. **协议层的加载**：`@atl/ssm-client` 还不是 web 的依赖（根 workspaces、web 的 tsconfig paths 与 vite alias 都未登记），`terminal/channel.ts` 用 `import.meta.glob('../../../../ssm-client/src/index.ts')`
   按需加载、按结构类型使用；包不存在时构建照常，终端显示“终端暂时不可用”。登记依赖后改为直接 import 即可。`clientVersion` 取包内默认值。
3. **步骤级预期中断的“开始本步骤”不显示**：§9.2 #25 的路由未登记，按回写前的降级在步骤卡写“检测会显示通道不可达，属预期”；窗口来自 `/workspace` 的 `expectedOutage` 或会话视图的 `outageWindow`，
   窗口内 `CHANNEL_DOWN` 显示为“预期中断”，实验机终端覆盖层为“预期中断”并每 15 秒自动重试。
4. **“重启实验机”不提供**：没有登记的路由；Agent 不在线的覆盖层给 [重试] [查看排障步骤] [修复环境]（`POST /environments/{envId}/repair`）。
5. **到截止时间与访问收回分开**：本地到期只出覆盖层（终端区 inert、只读），收到 `session.access_revoked` 或会话离开 READY～EXPIRING 才断开终端；浏览器不调用“结束”，只立即补拉视图。
6. **T-15 不重复播报**：全局 `useExpiryAnnouncements` 已在 15 / 5 / 1 分钟与 0 播报，横幅不再带 `role="status"`。
7. **阶段时间**：lifecycle 的 `phases[]` 只保留最近一次状态变化的 `at`；开始时间取 `session.phase_changed` 事件的时间，没有事件时取上一阶段的完成时间（第一阶段取 createdAt）。部署预算按 02 §11.1 的等级默认值（A 30、B 45、C 90、D 120 分钟）只用于“比通常更久”提示，不显示分钟数。
8. **费用**：只显示服务端给的数（会话视图 `env.hourlyEstimate`、`/cost` 的 `estimate`、报价的 `hourly.completed` / `retainHourly`）；字符串估算或取不到时写“未提供 / 单价暂不可得”。界面没有任何价格常量。
9. **手动确认的证据**：04 §8.8 写 ≤ 256 KB，API 当前 `evidence` 上限 4096 字符，按 API 校验。复核状态：`kind = degraded` 且未复核时显示“等待助教复核”（API 只为降级确认建复核队列）。
10. **差异的噪声带**取相对 10%（与 `npm run exp:report` 的默认 `--noise 0.1` 及原型 deltaCell 一致）；变体角色显示为 baseline / treatment / single。
11. **控制台深链直开**：50 分钟内签发过登录且本标签页已知该 linkId 的深链 URL（console-link 响应的 `deepLink`）时直接新标签页打开，否则走联合登录。
12. **终端会话清理**：组件卸载与 `pagehide` 时尽力 `DELETE`（不等待）；03 §3.5.9 的“新页面按 clientId 清理残留”依赖 `GET …/terminals` 返回 clientId，未实现。
13. **xterm 与 CSP**：xterm 6 运行时注入 `<style>`（08 V-4、03 §3.7.6）仍未处理；分隔条比例经 CSSOM 设置 `--split`（不受 `style-src 'self'` 限制），组件不写 style 属性。
14. **未做**：右栏“拆分”（P2，按钮置灰）；前导键首次自检；终端读屏模式以外的高对比度主题；子标签重命名；web-links / search / unicode11 / webgl / clipboard 插件（未安装）；漂移提示中的“跳回第 k 步”；
    “查看部署日志”（§9.2 #11 未登记，按降级不显示）；CloudShell 引导环境变量（§9.2 #29，只给打开控制台的说明）。
15. **i18n**：工作台文案写在各组件内（`i18n/zh-CN.ts` 不在本任务路径内），之后可以统一迁入。

### 5. 需要其他部分配合

- **web 集成**：路由表 `/workspace/:sid` 改为 `pages/workspace/WorkspacePage`，删除 `features/workspace/WorkspacePage.tsx` 桩（`features/workspace/terminal/xterm.ts` 仍被使用）；`@atl/ssm-client` 登记为依赖并加 vite alias / tsconfig paths 后，把 `terminal/channel.ts` 的 glob 改为直接 import；
  `scripts/dev.mjs` 同时启动 ssm-client 模拟服务器；SessionActions 的取消 / 延长 / 结束对话框目前只在工作台内使用，若要在会话胶囊菜单中复用，需要把 `timer/` 的三个对话框包成脱离 WorkspaceContext 的版本。
- **api**：`GET …/terminals` 返回 `clientId`（新页面清理本标签页的残留终端）；§9.2 #25 的步骤级预期中断入口；
  重启实验机的路由（03 §3.9）；会话视图 `phases[]` 带开始时间；KEEP 报价返回 `requiresTypedConfirm`（§9.2 #7）。
- **infra**：CSP 的 `form-action` 需允许 `https://signin.aws.amazon.com`、`https://*.signin.aws.amazon.com`（控制台 POST 表单，03 §5.5）；xterm 样式与 `style-src 'self'` 的处理（03 §3.7.6 PoC）。

### 6. 依赖

没有运行 npm install，没有新增依赖：用到的 `@xterm/xterm`、`@xterm/addon-fit` 已由脚手架加入；`@atl/ssm-client` 按源码路径按需加载。缺少：03 §3.7.1 列出的 xterm 插件（web-links、search、unicode11、webgl、clipboard）、axe-core（无障碍自动检查）、Storybook。

## platform-web-results

`platform/web/src/pages/{experiments,end,manual,report,share,certificates,verify,sessions,errors}` 与 `platform/web/public-pages/`：P06 对比实验独立页、
P07 回收进度 / P07-K 保留环境 / P07-M 待人工处理清单、P08 实验报告（导出、分享、撤销、到期）、P09 证书与徽章 / P09-C 证书详情 / P09-V 公开验证页、
P11 / P11-D 会话历史与费用、P13 就地错误与 404。全程没有调用真实的 AWS API，没有部署；联调只用本机 DynamoDB Local 与 dev-server（noop 运行器）。

### 1. 实现范围

| 画面 | 位置 | 要点 |
|---|---|---|
| 共用 | `sessions/{data,sessionText,eventText,download}.ts`、`sessions/pages.css`、`errors/{problems.ts,InlineProblem.tsx,useAction.ts}` | `useSessionView`（GET 会话后交给 SessionSync，未到结论时 watch）、`useApiData`（可见时轮询、失败保留旧数据）、静态内容缓存（先取会话自己的 catalogVersion，读不到退回当前版本）、带令牌的下载（401 刷新一次）；`describeProblem` 把 ApiError 分为网络 / 不可用 / 限流 / 角色 / 重新登录 / 状态冲突 / 前置条件等类并给出重试倒计时；`useAction`：同一操作重试复用 Idempotency-Key、409 / 412 后刷新视图、REAUTH 后 `takeReauthReplay` 重放；金额只显示 API 给出的数字，缺失写“未知” |
| P06 | `experiments/` | `ExperimentPage`（`?a=&b=&across=`）与 `ExperimentCompare`（页面 / 抽屉 / 报告三种模式）：按实验声明列出各 label 的运行，默认取最近一条有效运行；上传四段进度；指标表（优先用 compare API，否则对比数值叶子；10% 内视为噪声，形状 + 文字）与窄屏指标卡；SVG 柱图与 p50 / p95 / p99 阶梯图（`compareModel.ts` 纯函数，分享副本复用）；可比性与 validity 原因、客户端 / 服务端不一致提示；运行命令只对学员且会话进行中显示；跨会话对比 |
| P07 | `end/` | 按 `endRender` 重定向 / 回收进度 / P07-K；`phases[]` → 7（+1 保留分支）个可见阶段（`phases.ts`，未知 phase 写入当前阶段细节）；复扫时间线（取 `reclaim.rescanAt[]`）；按阶段分组的资源（打码，“显示”30 秒）；清理清单导出 md / json；“立即重试回收”；观察者只读；清理每 30 / 60 秒轮询并在事件到达时刷新 |
| P07-K | `end/KeptView.tsx`、`KeepDialogs.tsx` | 保留中的环境与费用；延长保留（KEEP 报价、确认项含“未估算”与预算 WARN、报价过期“重新计算费用”、`extendKeep {hours, quoteId}`）；释放（alertdialog，初始焦点在“取消”） |
| P07-M | `manual/` | `ManualList`：每项控制台链接 + 逐项 CLI + “我已处理，重新核对”（resolve 202 后每 4 秒读 cleanup，90 秒仍无变化提示“仍在核对”，已确认项留到下次刷新）；`ManualResourcesPage`：`?severity` / `?billing` 筛选、按会话分组、逐会话导出 |
| P08 | `report/` | 无报告 / 生成中 / 失败 / 预览 / 就绪；摘要、目录、逐步证据（内容 + listSteps，`CheckResultRow`）、检查历史（listCheckRuns，按结果筛选）、必做实验（报告模式的对比）、小测、费用、清理、附录、打印页脚；导出对话框（json / html，mask on / off，关闭打码需确认，rendering 时轮询）；分享（7 / 30 / 90 天 / 永不，发布中 5 秒轮询，复制 / 打开 / 撤销，publishing / active / revoked / expired） |
| P09 / P09-C | `certificates/` | 路径证书（可领取在前）、历史证书、领取对话框（证书署名有改动先 PATCH /me；422 原因逐条显示；REAUTH 重放）、徽章墙（按目录分类分组，详情抽屉，事件到达时刷新）；证书详情：卡片表与报告链接、验证链接、公开开关（PATCH 202 后轮询）、复制 JWS / kid、离线验证包、撤销（三种原因） |
| P09-V | `verify/`、`public-pages/verify/` | 独立静态页，不加载 SPA、不访问 API：读 `/.well-known/atl/jwks.json`、`/public/revocations.jws`、`/public/certs/<id>.jws`；WebCrypto ES256（P1363）+ RFC 8785；kid、密钥有效期与用途、issuer.origin 校验；吊销列表验签与 seq 防回滚（localStorage `atl.verify.revocations-seq.v1`）；14 种结果（含“未公开 → 粘贴证书”“浏览器不支持”“吊销列表不可用 / 回滚”“来源不符”）；粘贴 JWS、选择 .jws 或离线验证包 JSON；逐卡片在本地核对报告 JSON 的摘要；显示前对账号 ID、IP、ARN 打码；04 §10.1 自签名说明；只改 textContent 与类名 |
| 分享副本 | `share/` | `renderShareHtml(report, meta)` → 独立 HTML（CSP meta、noindex、内联样式、亮 / 暗色）与 `shareReportJson`（`redactedCopy: true`）；share 级打码（邮箱、CloudFront / ELB / API Gateway / EC2 域名、实例与分发 ID、会话 ID 等），手动备注清空，图表用 `compareModel` 重新生成（不用报告内的 svg） |
| P11 / P11-D | `sessions/` | 列表：状态 / 卡片筛选走服务端，时间范围 `?range=` 在前端，概览，加载更多；详情页签 时间线 / 资源 / 费用 / 平台动作 / 审计（`?tab=`），时间线按页读事件（最多 25 × 200 条，截断提示）；观察者打开学员 / 助教专属页签时页内说明 |
| P13 | `errors/` | `NotFoundPage`（显示路径 + 两个出口）、`Missing`（会话 / 证书不存在）、`InlineProblem`（就地错误 + 重试倒计时） |

`public-pages/build.mjs`（vite 程序化构建，不读 vite.config）→ `public-pages/dist/`（被 .gitignore 忽略）：`verify/{index.html,verify.js,verify.css}`、
`share/render-share.mjs`（ESM，导出 `renderShareHtml` / `shareReportJson`）、`share/sample/`；构建后检查没有内联脚本、style 属性与外部地址。

### 2. 如何运行

```bash
npm run test -w @atl/web            # 本组测试在 src/pages/{experiments,end,manual,report,share,certificates,verify,sessions,errors}
node platform/web/public-pages/build.mjs
node platform/web/public-pages/build.mjs --share <report.json> --out <dir> [--published-at ISO] [--expires-at ISO|none]
```

### 3. 自测结果（2026-10-14）

| 自测 | 结果 |
|---|---|
| `tsc -p platform/web`、`npm run build -w @atl/web`、`node platform/web/public-pages/build.mjs` | 通过；verify.js 18.9 KB、render-share.mjs 32.4 KB |
| `npx eslint .`（platform/web） | 0 个问题 |
| `npm run test -w @atl/web` | 37 个文件 452 个测试通过；本组 11 个文件 86 个 |
| 模拟 API 的临时入口（与 App 相同的框架）+ 系统 Chrome 无头 | 23 个画面状态 × 亮 / 暗 / 375px：无横向滚动、无控制台错误（只有临时入口没有 favicon 的 404）、组件不写 style 属性 |
| 验证页与分享副本（本机静态服务器模拟 CloudFront 的 verify/ 改写与 CSP 头，现签证书） | 有效、已吊销、未公开 → 粘贴、篡改、无输入、报告摘要一致 / 不一致、打码、暗色、375px、CSP 下无报错；19/20（余下 1 条是未公开证书预期的 403 控制台记录） |
| 真实 API（本机 dev-server，svc-storage 开始 → 结束 / 保留） | 13 个画面经真实 API 渲染；发现并修复：发布内容中步骤的检查可以是 `{ref, required, as}`，原实现只认字符串，报告页崩溃 |

### 4. 偏离设计与取舍

1. 页面放在 `src/pages/<area>/`（08 §2.6 写 `src/features/*`）；`routeTable.ts` 不在本组范围，仍指向脚手架的桩。
2. P09-V 与分享副本不进 atl-web.zip（与 platform-web-scaffold 第 4 节第 8 条一致），单独构建后交给 atl-certs 发布；发布路径与 `static-site.ts` 相同，
   另加 `verify/verify.css`（infra 的验证页 CSP 没有 style-src，内联 `<style>` 会被拦）。
3. 验证页不做 API 交叉核对（公开页不访问 API）；“来源不符”（issuer.origin 既不在 jwks.origins 也不是本页来源）单列为一种结果；不支持 WebCrypto 时提示改用离线验证包。
4. 导出只有“打码 / 不打码”：API 只接受 `mask=on|off`，账号 ID 与公网 IP 不能分开，08 的“隐藏手动备注”“包含历史”不显示。
5. 报告页只显示最新版（getReport 不支持 `?version=`，§9.2 #12）；正文取自会话数据，完整报告用下载的 HTML。
6. P11 列表的“尝试结果”“费用”列显示“—”（列表项没有 attemptStatus / 费用，§9.2 #15）；时间范围筛选在前端。
7. P07-M 的会话分组标题逐个 getSession 取得（清单条目没有 labId 与会话时间）。
8. 分享副本用本组的打码器与重新生成的图表，没有用 api 的 `renderReportHtml(…, { share: true })`；两者需要择一（见第 5 节）。
9. 结束阶段：没有 `end.workstation-down` 等记录时，后面的阶段已开始即视为完成。实验命令格式 `npm run exp -- <module> <id> --label <label> --upload`。
10. 没有 Storybook、axe-core、user-event（缺依赖），组件状态由 RTL 测试与无头 Chrome 覆盖。

### 5. 需要别人配合

- **web 集成**：`routeTable.ts` 改为 `pages/sessions/{SessionsPage,SessionDetailPage}`、`pages/end/EndPage`、`pages/report/ReportPage`、`pages/experiments/ExperimentPage`、
  `pages/manual/ManualResourcesPage`、`pages/certificates/{CertificatesPage,CertificateDetailPage}`（default export），`*` → `pages/errors/NotFoundPage`，删除对应桩；
  package.json 增加 `build:public`（`node public-pages/build.mjs`）并在打包时执行。
- **atl-certs / api**：`publishVerifyPage` 发布构建产物 `verify/index.html`、`verify.js`、`verify.css`（替换 `verifyPageHtml` / `VERIFY_PAGE_JS`）；CreateShare 改用
  `render-share.mjs`（或保留 `renderReportHtml`，则删除本组的分享渲染）；getReport `?version=`；listSessions 带 attemptStatus 与费用；manual 条目带 labId 与会话时间；
  resolve 的结果事件；导出时账号 ID 与 IP 分开打码。
- **infra**：WebDeploy 把 `verify/` 与 `share/` 列为受保护前缀。

### 6. 依赖

没有新增依赖。

## platform-backend-gaps

补齐生产中返回 501 或缺失的后端功能：atl-pricing（Price List 报价）、03 的 `WorkspaceProvider`（终端、控制台联合登录、预览、管理员密码）、
Cognito `MemberDirectory`，以及 08 §9.2 中能实现的路由与字段。全程没有调用真实的 AWS API，没有部署任何东西：AWS 调用只在 aws-sdk-client-mock
或注入的假 SDK / fetch 下测试；dev 模式接 `@atl/ssm-client` 的本地模拟服务器和本地联合登录桩，只监听 127.0.0.1。

### 1. 实现范围

| 部分 | 位置 | 内容 |
|---|---|---|
| atl-pricing | `functions/pricing/handler.ts`、`services/pricing/*` | 动作 `PriceQuote`。`dimensions.ts` 是 `labs/_pricing/dimensions.yaml` 的转录（不含价格；测试逐项比对 YAML，防漂移）。`price-list.ts`：`PriceListSource`（生产为 `pricing:GetProducts`，TERM_MATCH 过滤 + `regionCode`，按 NextToken 翻页，端点区域按平台区域取 us-east-1 / eu-central-1 / ap-south-1，可用 `ATL_PRICING_ENDPOINT_REGION` 覆盖）、Price List JSON 解析（OnDemand、首档价，多产品或多档给区间，免费首档后取最低付费档）。`price-book.ts`：`PriceCache`（`PRICE#<region>` / `<serviceCode>#<pricingKey>@<占位值>`，24 小时；无匹配的维度缓存 1 小时；`expiresAt` 判定新鲜度；项带来源，夹具价不会被生产读到）。`estimate.ts`：`ref` 展开（`start-profile` → L0 基础项 + START/REUSE 时起始档位模块；`workstation`；`target-modules`；EXTEND/KEEP 的 `ref: module`；`extra-stacks` 每个栈一行“未知”），占位符（`{instanceType}` 等取模块参数或模板默认值，`{regionPrefix}`、`{edgeLocationGroup}` 由区域推出，取不到 → 未知），04 §3.4 算法（hourly、monthly ÷ 730、usage 典型值与 3 倍上界、retainHourly），`maxSession`（完成后 × 总时长 + 起始状态 × 部署与回收预算 + 工作台 × 全程；KEEP 为保留每小时 × 小时）。预检型变体逐个估算，取较高者并注明（`pricedVariant`）。`fixture.ts`：dev 与测试用的 Price List 夹具（占位单价，报价 `pricing: 'fixture'` 并注明“开发夹具，不是 AWS 价格”） |
| 报价结构（08 §9.2 #6） | `services/catalog/quotes.ts` | `PricedQuote` 增加 `platformOverhead{perHour, perSession, qualitative[]}`（`low`/`high` 保留为 `perHour` 的旧写法）、`retainHourlyRange`、`pricePublication`、`oneTime`；行增加 `base`、`unitPrice`、`reason`；`pricing` 透传 `fixture`。atl-pricing 不可用时仍是原来的“全部未知、金额 null” |
| WorkspaceProvider | `services/workspace/provider.ts`、`access.ts` | 终端（03 §3.2）：`AssumeRole ATLLearnerRole`（`atl-<sid>-term`、`SourceIdentity` = Cognito 用户名（不合 STS 字符集时用 sub）、§3.2 会话策略、`DurationSeconds = clamp(deadline − now + 60 s, 900, 3600)`），凭证在容器内复用到剩 5 分钟，每次签发写 `CredentialGrant(term)`；按 `atl:env-id` + `atl:role` + `running` 反查，再核对 `aws:cloudformation:stack-name` / `aws:autoscaling:groupName`（`cloudalbum-<envName>-*` 或 `atl-ws-<sid>`）；对账（`DescribeSessions` Active + Owner 为本会话名，超过空闲 + 5 分钟且 SSM 已无的条目标 CLOSED）后计数（每实例 3、每会话 6 → 429 `TERMINAL_LIMIT`）；`DescribeInstanceInformation` 非 Online → 409 `TERMINAL_TARGET_NOT_CONNECTED`；`TerminalRecording=cloudwatch` 时用 `ATL-SessionShell-Logged`；`StartSession` 后校验 StreamUrl（`wss://ssmmessages.<region>.amazonaws.com[.cn]` 或 `.api.aws`，无 userinfo；不合格则立即 Terminate 并 503）；写 `TerminalSession`（只存 ID，不存令牌）；响应含 `connectBy`（+30 s）与 `clientVersion`（= `@atl/ssm-client` 的 `PROTOCOL_COMPAT_VERSION` 1.2.896.0，有测试核对）。续连 `ResumeSession`（`DoesNotExistException` → 409 `TERMINAL_GONE` 并标 CLOSED），结束 `TerminateSession`（会话已收回访问时只标记）。控制台（03 §5）：`atl-<sid>-console`，不传 `DurationSeconds` 与会话策略，`CredentialGrant(console)`；先区域联合端点、失败再全局端点，`getSigninToken` 用 POST 且不传 `SessionDuration`；返回 `form{action, method, fields{Action, Issuer, Destination, SigninToken}}`、`url`、`expiresAt`（15 分钟）、`consoleSessionExpiresAt`、`deepLink`；令牌与凭证不落库、不进日志。`app-credentials`：函数角色 `GetParameter WithDecryption` 读 `/cloudalbum/<envName>/atl/app-admin-password`，用户名 `atl-admin@example.com`（06 PM-46），未写入 → 404。`describeTargets`（`GET /workspace` 的 `targets`）：同一组学员凭证，给出 tab、primary、runAs、awsIdentity、ssmPing、prepared、placement |
| 深链接注册表 | `services/workspace/console-links.ts` | 03 §5.4 的 19 个 `linkId`（模板、参数正则、服务首页、标签）；参数不合法 → 退回服务首页（`fallback: true`）；自由 `destination` 只接受注册表用到的控制台主机、https、无端口与 userinfo（422 `CONSOLE_DESTINATION_NOT_ALLOWED`）；与 `scripts/labs/src/console-links.ts` 的 id 集合一致（测试） |
| 预览探测 | `services/workspace/preview.ts` | 入口来自 `Environment.endpoints`（`baseUrl`/`direct`、`cdn`、`alb`/`loadBalancer`、`customDomain`）与 `LabSession.app.entryUrl`，按 URL 去重；http → `MIXED_CONTENT`；https：先解析，任一地址为回环 / 私有 / 链路本地 / CGNAT / 保留 → `UNREACHABLE`，只连 443，用解析得到的地址连接（自定义 `lookup`，防 DNS 重绑定），Node 默认信任库，3 秒，不跟随重定向，只读响应头；TLS 错误 → `UNTRUSTED_CERT`；`X-Frame-Options` DENY/SAMEORIGIN → `X_FRAME_OPTIONS`；`frame-ancestors` 不含平台来源 → `FRAME_ANCESTORS_MISSING`；每容器缓存 60 秒；`default` 取第一个可嵌入的入口 |
| MemberDirectory | `services/members/index.ts` | `AdminCreateUser`（邮箱为用户名，`DesiredDeliveryMediums: EMAIL`，Cognito 寄临时密码）+ `AdminAddUserToGroup`（用返回的 Username，即 sub）；加组失败时删掉刚建的用户；`UsernameExistsException` → 400 `USER_EXISTS`；删除先查组（`learner` → 403），用户名即 sub，找不到时 `ListUsers` 按 sub 查，已不存在视为成功。dev 版本只返回 `dev-<uuid>` |
| 生产接线 | `functions/api/index.ts` | atl-api 入口创建 `WorkspaceProvider`（AWS）与 Cognito `MemberDirectory`；不再返回 501 |
| 08 §9.2 路由 | `routes/gaps.ts`、`@atl/shared` 路由表 | 新路由（路由表中带 `pending01`）：#11 `GET …/runner-runs`（L A O）与 `…/runner-runs/{runId}/log`（L A，读 `atl-data/runs/<runId>/result.json`、`progress.jsonl`，按键名去掉机密、按模式打码账号 ID 与公网 IP，最多 200 行）；#13 `GET …/check-runs/{runId}/evidence/{checkKey}`（L A O，内联证据或 `atl-data/evidence/<sid>/<runId>/<checkKey>.json`，键必须正好是这个位置）；#16 `GET /platform/exports/{exportId}`（L，`pending` / `ready` + 15 分钟下载链接）；#18 `GET /manual-confirmations?status=pending`（A，AP20 `REVIEW#PENDING`，附卡片 id 与会话状态）；#25 `POST …/steps/{stepId}/outage`（L，202，只接受声明了 `expectedOutage` 的步骤，同步调用 atl-lifecycle `OpenOutageWindow`）；#28 `GET /environments/{envId}/resources?state=`（L A，整条交接链的台账，学员只能看自己会话链上的环境）。已登记路由的细化：#3 `GET /platform` 只对 L 返回完整 `accountId`，A / O 为 `••••后 4 位`（`accountIdMasked`）；#7 `PATCH /settings` 的 `cost.highHourlyThreshold`，KEEP 报价返回 `highHourlyThreshold`、`requiresTypedConfirm`、`typedConfirmValue`；#12 `GET …/report?version=<n>&view=full`（同源返回该版本存储的权威 JSON 原文，头 `x-atl-report-version`、`x-atl-report-digest`）与 `versions[]`；#22 `after=` 游标的时间晚于现在 10 分钟以上或早于会话创建 1 天以上 → 410 `CURSOR_EXPIRED`；`GET /resources/manual` 的条目加 `labId`、`sessionCreatedAt`、`sessionEndedAt`、`sessionState`（web 脚手架的请求）。#8 阶段名表 `SESSION_PHASE_NAMES` 登记到 `@atl/shared`（atl-lifecycle 已在使用，测试核对源码中的阶段名都在表内） |
| infra | `platform/infra/src/50-iam.yaml` | `ATLApiFunctionRole`：成员管理加 `cognito-idp:ListUsers`；`DataDownloads` 加 `atl-data/runs/*`。`ATLPricingFunctionRole`：`LeadingKeys` 加 `PLATFORM`（读工作台实例类型），新增 `s3:GetObject` 于 `atl-web/content/*`（读展开后的卡片）。函数环境变量沿用模板已给每个函数设置的 `ATL_*`，没有新增；`inventory.test.ts` 的白名单与“路由 → 调用 → 权限”表补了 10 行 |
| dev 接线 | `dev/adapters/workspace.ts`、`services/workspace/dev-access.ts`、`dev-federation.ts`、`dev-server.ts`、`dev/runtime.ts` | `npm run platform:dev` / `platform:dev:api`：`ATL_DEV_SSM_MOCK_URL`（默认 `http://127.0.0.1:8790`）上已有模拟服务器就复用，否则在进程内按源码路径加载 `platform/ssm-client/src/mock/server.ts` 启动；dev `WorkspaceAccess`：假的学员凭证、dev 实例 ID（带真实反查要核对的标签）、Online、`StartSession`/`ResumeSession`/`TerminateSession`/`GET /sessions` 走模拟服务器的 HTTP 控制接口（StreamUrl 为 `ws://127.0.0.1:<port>/…`，dev 才接受回环）；联合登录桩挂在 dev-server 的 `/__dev/federation`（`getSigninToken` 发一次性令牌、拒绝 `SessionDuration`；`login` 渲染“将以 ATLLearnerRole 打开 <Destination>”，不跳转 AWS）；管理员密码取本地 L0 的 `etc/atl/app-admin-password`，noop 模式下在 `.atl-dev/workspace/` 生成一个；dev 预览不离开本机（http → MIXED_CONTENT，https → 不探测）。dev 运行时的 atl-pricing 用夹具 |

### 2. 如何运行

```bash
npx vitest run --project atl-api test/pricing.test.ts test/workspace-provider.test.ts test/members.test.ts test/dev-workspace.test.ts test/ui-gaps.test.ts
npm run smoke:platform        # 新增 [2w] 阶段：终端（真实协议客户端经模拟服务器回显、续连、结束）、控制台联合登录桩、管理员密码登录本地 L0、预览
npm run platform:dev:api      # dev-server 启动时打印 “SSM mock http://127.0.0.1:8790” 或复用已有的模拟服务器
```

### 3. 自测结果（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28）

| 自测 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build`（含 web 的两份 tsc） | 通过 |
| 检查 | `npm run lint` | 0 个问题 |
| 单元测试 | `npm test` | 174 个文件：2076 通过、19 跳过、1 失败。失败项是 `platform/infra/test/package.test.ts` 的“工作台模板与 user-data.sh 一致”，原因是另一个并行任务尚未提交的 `platform/workstation/bootstrap/user-data.sh` 改动，与本任务无关（本任务开始时该项通过，本任务不涉及这两个文件） |
| 新增测试 | `pricing.test.ts`、`workspace-provider.test.ts`、`members.test.ts`、`dev-workspace.test.ts`、`ui-gaps.test.ts` | 64 个：63 通过；1 个 aws-sdk-client-mock 用例等 `@aws-sdk/client-pricing` 安装后运行。STS / EC2 / SSM / Cognito 用 aws-sdk-client-mock，Price List 用结构相同的假 SDK，联合端点用注入的 fetch；dev 端到端用真实的 `SsmTerminalConnection` 经模拟服务器回显、断线后经 `resume` 路由续连、`DELETE` 后收到 channel_closed |
| 平台端到端 | `npm run smoke:platform` | 120 / 120，190 秒。新增 `[2w]` 10 项（实时目标、终端打开 / 回显 / 续连 / 结束、控制台登录桩、管理员密码并用它登录本地 L0、预览 MIXED_CONTENT）；第 2 阶段的报价检查改为“按 dev 夹具定价并注明不是 AWS 价格” |
| 生产包 | `bundleFunction('atl-api' / 'atl-pricing')` | 不含 `src/dev/**`、dev 访问层与价格夹具 |

### 4. 设计有歧义时的取舍

1. **新路由登记在 `@atl/shared` 路由表**：路由器与 SPA 客户端都只认这张表，08 §9.2 的路由只能放进去。条目带 `pending01: '08 §9.2 #n'`，`name-table.test.ts` 的 01 §8.2 转录比对排除它们；未实现的 #5（预检的执行身份需 01 决定）、#14（缺 Cost Explorer 客户端）、#29 ③（03 §4.9 的引导变量未定义）留在 `UI_REQUESTED_ROUTES`。错误码 `CURSOR_EXPIRED`（410）从 `UI_REQUESTED_ERROR_CODES` 移入 `ERROR_CODES`。这是本任务对 `platform/shared` 的全部改动（`routes.ts`、`errors.ts`、`events.ts` 与 `name-table.test.ts` 一行过滤）。
2. **对已登记路由的细化放在 `routes/gaps.ts`**，按相同的路由 id 包装原处理器（解析其 JSON 后补字段），不改 `reports.ts`、`sessions.ts`、`services/sessions/*`；只有 `routes/platform.ts`（设置项 `cost`）、`routes/workspace.ts`（`params`、链接标签、实时发现的失败回退与只对学员发现）直接改。
3. **维度映射编译进函数**：内容发布包没有 `dimensions.yaml`，Lambda 包也读不到仓库，只能转录；测试保证与 YAML 一致。等 registry 提供 `billing.pricingKeys`（06 PM-34）或内容包带上该文件后可改为读取。
4. **atl-pricing 自己读卡片**：`ref` 展开需要起始档位、目标模块与卡片自带栈，按 quotes.ts 的约定由 atl-pricing 展开，所以函数需要读 `atl-web/content/*`（新增权限）。START 报价时还不知道学员选不选省钱模式，平台开销按工作台 EC2 计并注明。
5. **不估的部分**：卡片自带栈（不从模板推导，单列“未知”）；CodeBuild 构建（没有历史数据与维度，`perSession: null` + 定性说明）；按量计费项用卡片假设的用量折算（典型值），上界 3 倍；免费额度不计。区域到用量类型前缀、CloudFront 价格地区的映射表只覆盖常见区域，未覆盖的区域对应维度为“未知”，不猜产品。
6. **Price List 全部失败才算不可用**：每次报价若所有维度都调用失败（SDK 缺失、无权限、限流）就抛 `Atl.PricingUnavailable`，API 退回原来的全部未知报价；部分失败只把那几行标为未知。错误细节只写日志，不进报价。
7. **终端状态**：`StartSession` 成功后直接写 `OPEN`（浏览器没有“已连上”的回报），续连时写 `lastResumedAt` 与 `resumeCount`；03 的 `OPENING` 只作为对账时的兼容状态。`prepared` 只在 `Environment.instances[].prepared === false` 时拦截（目前没有写入方，见第 6 节），未知不拦。
8. **凭证复用**：`GET /workspace` 每 60 秒刷新一次，如果每次都 AssumeRole 会产生大量 CloudTrail 记录与 `CredentialGrant`。终端凭证在函数容器内复用到剩 5 分钟，每次真正签发才写一条 grant；控制台每次都重新签发（会话时长 = 凭证剩余时间，03 §5.3）。助教、观察者调用 `GET /workspace` 时不做实时发现（否则会以他们的身份扮演学员角色，违背 01 §5.2），看到的是缓存的实例。
9. **`SourceIdentity`**：用访问令牌的 `username`；不符合 STS 的 `[\w+=,.@-]{2,64}` 时用 sub（01 需保证所选用户标识符合，03 §3.2）。
10. **预览不回写 `LabSession.app`**：03 §6.1 要求把判定写回 `LabSession.app`，但 `LabSession` 只由 atl-lifecycle 写（01）；改为每容器缓存 60 秒。
11. **控制台深链接参数**：`console-link` 请求体增加 `params`（按注册表正则校验）；只给 `linkId` 时自动代入环境的实验机 ID，其余参数缺失则退回服务首页。注册表放在 `services/workspace/console-links.ts`，03 §5.4 指定的 `platform/api/contracts/console-links.ts`（`@atl/contracts`）尚不存在。
12. **管理员用户名**：生产固定为 06 的 `atl-admin@example.com`；dev 的本地 L0 用 `atl-admin@<envName>.example.test`。
13. **`cost.highHourlyThreshold`**：02 §8.1 写“安装时设置”，模板没有该参数；先作为平台设置（`PATCH /settings` 的 `cost.highHourlyThreshold`，美元/小时，默认不设）。估算未知或不完整时，只要设置了阈值就要求输入卡片 id（无法证明低于阈值）。服务端不校验输入的卡片 id（02 只要求界面确认）。
14. **游标失效**：`SessionEvent` 没有 TTL，不会因保留期被清理；“无效”按时间判断（晚于现在 10 分钟以上或早于会话创建 1 天以上）。格式错误仍是 400。
15. **dev 模拟服务器的加载方式**：`@atl/ssm-client` 还不是 lockfile 中的 workspace，`@atl/api` 不能依赖它；dev 与测试按源码路径动态加载（tsx / vitest 转译）。

### 5. 必须到真实 AWS 上验证（07）

`pricing:GetProducts` 的过滤属性名与取值（`dimensions.yaml` 中每个维度至少命中一条，04 §3.4 要求的集成测试）、`regionCode` 属性在各服务中的可用性；`AssumeRole` + 会话策略 + `SourceIdentity` 对 `ssm:StartSession` / `ResumeSession` / `TerminateSession` 的实际放行（03 §10 ⑪：会话 ID 是否以会话名开头）；`DescribeSessions` 按 Owner 过滤所需的 ARN 形式；角色链凭证在区域联合端点的 `getSigninToken`（D8）；预览探测在 Lambda 中对 Let's Encrypt IP 证书、CloudFront 默认域名的结果。

### 6. 需要其他部分配合

- **01**：登记 `pending01` 的 7 条路由、错误码 `CURSOR_EXPIRED`（410）与 `RATE_LIMITED` 外的 `TERMINAL_*`/`CONSOLE_*`（03 §9.1 已列）、`SESSION_PHASE_NAMES`、设置项 `cost.highHourlyThreshold`（或安装参数）、`GET /platform` 的 `accountIdMasked`、`console-link` 请求体的 `params`、`TerminalSession` 的 `resumeCount`/`lastResumedAt`/`target`；IAM：`ATLApiFunctionRole` 的 `cognito-idp:ListUsers` 与 `atl-data/runs/*`，`ATLPricingFunctionRole` 的 `atl-web/content/*` 与 `PLATFORM` 读取。
- **02 / lifecycle**：`Environment.instances[].prepared`（`ATL-PrepareInstance` 的结果）目前无人写入，终端的 `TERMINAL_TARGET_NOT_PREPARED` 因而只在写入 `false` 时生效。
- **web**：终端请求体与响应按 03 §3.2 已对齐（`clientVersion`、`connectBy`）；控制台响应 `form.method = 'POST'`；`GET /workspace` 的 `console.links[]` 带 `label`；新路由可经 `routeById` 调用；KEEP 报价的 `requiresTypedConfirm`；`platform:dev` 启动 SSM 模拟服务器时用 8790 端口（dev-server 会复用）。
- **contracts**：`@atl/contracts` 建立后把深链接注册表移到 `platform/api/contracts/console-links.ts`，并与 `scripts/labs/src/console-links.ts` 合并。
- **集成**：安装 `@aws-sdk/client-pricing`（3.1142.0，与其他客户端同版本）后，`pricing.test.ts` 中的 aws-sdk-client-mock 用例会自动运行；Lambda 运行时自带该包，生产不受影响。

### 7. 依赖

没有运行 npm install。缺少 `@aws-sdk/client-pricing`：生产经 `import()` 加载 Lambda 运行时自带的包，单元测试用结构相同的假 SDK；`aws-sdk-client-mock` 用例在包安装后才运行（目前跳过 1 个）。缺少 `@aws-sdk/client-cost-explorer`（08 §9.2 #14 未实现）。

## platform-release

为明天的真实部署准备制品：CloudAlbum 两种架构的发行包、完整的平台 Release 布局与 SHA-256 清单、工作台引导包的改造、部署前的
只读预检，以及 L0 User Data 的离线安装演练。全程没有调用任何 AWS API（本机没有凭证；演练容器里的 `aws` 与 `cfn-signal` 换成了
记录器），没有部署、没有上传任何东西。用到网络的只有：构建镜像与演练准备阶段从 AL2023 官方软件源下载 RPM，`npm ci` / `npm install`
访问 npm 源，better-sqlite3 的 prebuild-install 从 GitHub 下载预编译二进制。session-manager-plugin 没有下载（见 4.6）。

### 1. 交付内容

| 部分 | 位置 | 内容 |
|---|---|---|
| CloudAlbum 发行包 | `scripts/release` | 新增两步用法：`--prepare-only` 生成与架构无关的 stage（构建产物、host 文件、registry 元数据、检查包），`--from-prepared <dir> --arch <a>` 在目标架构的 Linux 中装生产依赖并打包；不带这两个选项时与原来一样一步完成。`node_modules` 中每个 `*.node` 按 ELF e_machine 分类，better-sqlite3、`@img/sharp-linux-<cpu>`、`@node-rs/argon2-linux-<cpu>-gnu` 缺失或架构不符即失败；宿主就是目标架构时再实际加载（内存 SQLite 查询、sharp 编码 PNG、argon2id 散列与校验）。交叉安装（宿主 ≠ 目标）传 `npm_config_arch` 让 prebuild-install 取目标二进制，只做 ELF 检查。`.release-manifest.json` 增加 `build{node, platform, sourceCommit, sourceDirty}` 与 `nativeModules[]`；设置 `SOURCE_DATE_EPOCH` 时 `createdAt`、检查包 `createdAt` 与归档内全部 mtime 固定（GNU tar `--sort=name --owner=0 --group=0 --mtime`，`gzip -n`） |
| Docker 构建 | `scripts/release-docker/Dockerfile.builder`、`build.sh`、`in-container.sh` | 构建环境 = amazonlinux:2023 + `dnf nodejs22`（与 L0、工作台同一 Node 包，原生模块按实际运行时取得）；amd64 原生、arm64 经 QEMU。`build.sh`：`git bundle` 指定提交（默认 HEAD；只用已提交的源码，`--overlay` 可叠加发布工具路径的未提交改动做测试）→ amd64 容器 `npm ci`、`build`、`build:frontend`、`build:web`、`labs:build`、检查包（`SOURCE_DATE_EPOCH` = 提交时间）→ `scripts/release --prepare-only` + x86_64 包 → arm64 容器 `--from-prepared` 出 arm64 包、预构建 node_modules → amd64 容器 `npm run platform:package -- --app-archive …` → `preflight.mjs --artifacts-only`。输出 `dist/release/app/`、`dist/release/v<平台版本>/`、`dist/release/build-report.json`；中间文件 `dist/release-work/`，npm 缓存 `dist/release-cache/`（都在 D 盘、都被忽略） |
| 平台打包 | `platform/infra/build/package.ts`、`archive.ts`、`workstation-tools.json`、`publish-s3.ts` | ① app 包的 `atlBundleDigest` 与检查包摘要不同即拒绝打包（实验机上的 ATL-RunCheck 按平台的摘要找检查包；`--allow-checks-mismatch` 仅供调试），架构字段不符也拒绝。② `--runner-node-modules <tar.gz>`：把 linux-arm64 的 node_modules（工作区链接已解引用、去掉 `.bin`、`*.d.ts`、`*.map`）放进 `cloudalbum-infra.zip`，并计入其内部 `SHA256SUMS`；超过 65,535 个条目（ZIP 无 ZIP64）时报错。③ 工作台引导包：新增 `atl-ws-install.sh`、`atl-install-node-modules.sh`；`manifest.json` 增加 `tools.sessionManagerPlugin`（官方下载地址按机器类型 + 固定的 SHA-256）、`tools.k6`（`optional: true`）、`nodeModulesInfo`；`--workstation-node-modules` 现在也接受 tar.gz（原样放入包中，旁边的 `<file>.json` 记录架构、Node 版本、lock 摘要）。④ 版本与固定值：`workstation-tools.json` 的 `pin`，`--ssm-plugin-version` / `--ssm-plugin-sha256 <arch>=<hex>` 覆盖；未固定时版本取 `platform/ssm-client` 的 `PROTOCOL_COMPAT_VERSION`。⑤ `package-report.json`（输入、各包摘要、警告；不是发布资产，`publish-s3` 跳过它）。⑥ `--emit-source <file>` 只写出工作台 / 运行器的源码子集（node_modules 预构建的输入）。`readTarGz` 支持 GNU 长文件名（`L`）与 pax `path` |
| 工作台引导 | `platform/workstation/bootstrap/user-data.sh`、`install.sh`、`install-node-modules.sh`；`templates/atl-workstation.yaml`（重新生成） | User Data 只做 dnf 安装、下载并校验引导包（`BundleSha256` + 包内逐文件），然后执行包里的 `atl-ws-install.sh`。安装脚本：session-manager-plugin 优先用包内 rpm，否则从官方地址下载，SHA-256 与固定值一致才 `dnf install`，未固定或不一致都不安装并在 `installed.json` 写明原因；k6 只在包内有时安装；node_modules 优先用预构建包（机器类型不符时改为现装），否则 `atl-install-node-modules.sh` 从 npm 源安装；`installed.json` 增加 `tools`、`nodeModules`、`machine`。`install-node-modules.sh` 把根 package.json 的工作区收窄为实际存在的（包、module-cli、labs、experiments、shared），只保留 `tsx` 一个开发依赖（`npm run exp` 用），按原 lockfile 安装后恢复原 package.json / package-lock.json；预构建与启动时现装用的是同一个脚本 |
| 部署前预检 | `scripts/verify/preflight.mjs` | 见第 2 节；`--json` 输出，退出码 0 / 1 / 2 |
| 离线安装演练 | `scripts/release-docker/drill.sh`、`drill/`（`Dockerfile`、`Dockerfile.helper`、`run-drill.sh`、`imds.py`、`render-user-data.mjs`、`stubs/`） | 见第 3 节 |
| 工作台演练 | `scripts/release-docker/ws-drill.sh`、`drill/run-ws-drill.sh` | 无网络容器里运行渲染后的工作台 User Data（`aws s3 cp` 由记录器从发布目录取包），再用本地服务器验证插件下载路径：错误摘要 → 不安装，正确摘要 → 下载、校验、安装 |
| 固定插件摘要 | `scripts/release-docker/pin-ssm-plugin.sh` | 维护者在部署前运行：下载指定版本两种架构的官方 rpm（HTTPS），把版本、摘要、日期写入 `workstation-tools.json`；`--dry-run` 只打印地址 |
| 测试 | `scripts/verify/preflight.test.mjs`、`scripts/release-docker/test/release-tools.test.mjs` | node:test，21 个：预检对合成发布目录的全部检查与篡改、摘要不一致、未固定插件；凭证来源判断；只读白名单；User Data 渲染；插件固定规则；GNU 长文件名；运行器 node_modules 过滤；工作台包清单；全部 shell 脚本 `bash -n` 与 LF |

### 2. 预检 `scripts/verify/preflight.mjs`

```bash
node scripts/verify/preflight.mjs [--release-dir dist/release/v0.1.0-dev] [--profile <name>] [--region <r>] [--cfn-lint] [--online] [--strict] [--json]
node scripts/verify/preflight.mjs --artifacts-only --release-dir <dir>     # 只查制品（构建容器里就是这么跑的）
```

- 本机环境：Node ≥ 22.12；`aws --version`（v2 才通过）；`~/.aws/config`、`~/.aws/credentials`（或 `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`）是否存在、有哪些 profile；
  凭证来源只在本地判断（环境变量、IAM Identity Center、assume-role、credential_process、长期密钥），从不打印密钥；没有凭证时 FAIL 并给出
  `aws configure sso --profile …` / `aws sso login` 的中英文提示；默认区域（`--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > profile）是否在
  `release.config.json` 的已验证区域里；cfn-lint 是否可用（Windows 下只认 .exe，不经 shell）；发布包是否由当前提交构建。
- 制品：`SHA256SUMS` 逐个核对、目录中没有清单外的资产；模板内嵌清单（`CopyArtifacts.Manifest`）与文件的摘要和大小一致、`ChecksBundleDigest` 一致；
  两个 CloudAlbum 包的架构、`atlBundleDigest`、三个原生模块的 ELF 机器类型；`cloudalbum-infra.zip` 内部 `SHA256SUMS` 全部条目、运行器需要的文件、
  `scripts/module` 可执行、两个 `.tgz`、检查包、linux-arm64 的 node_modules；工作台包逐文件摘要、插件是否已固定（未固定为 WARN）、k6（可选）、
  预构建 node_modules 的架构；网页包与内容包是否是占位。`--cfn-lint` 对发布模板跑一次 cfn-lint（本地）。
- AWS：默认不调用。`--online` 只运行 `sts get-caller-identity`、`ec2 describe-vpcs`（默认 VPC，01 §4.1）、`cloudformation describe-stacks --stack-name atl`
  （是否已安装），三个都经白名单 `assertReadOnly`，其他任何操作在启动进程前就被拒绝（有测试）。

### 3. L0 离线安装演练 `scripts/release-docker/drill.sh`

```bash
bash scripts/release-docker/drill.sh [--archive dist/release/app/cloudalbum-<ver>-x86_64.tgz] [--arch x86_64|arm64] [--platform-mode off|on]
```

- “实例”= `drill/Dockerfile`：amazonlinux:2023 + AMI 上有而容器镜像没有的（systemd 作为 PID 1、systemd-udev、tar、gzip、util-linux、iproute、procps、
  openssh-server、aws-cfn-bootstrap）+ 演练工具（python3、nftables、createrepo_c）。`cfn-signal` 换成记录器，`aws` 换成“记录后失败”的桩，`swapon` 换成空操作。
- 准备（唯一联网的一步，结果缓存）：从发行包自己的 `l0-bootstrap.sh` 取出所有 `dnf -y install` 的包名，`dnf --downloadonly` + `createrepo_c` 做成离线源（已签名的
  AL2023 包，演练中 `gpgcheck=1`）。User Data 由 `drill/render-user-data.mjs` 从发行包自己的 `infra/modules/ec2.yaml`（InstanceA）渲染，`${…}` 全部代入，漏一个就失败。
- 演练容器：`--privileged --network none`。IMDSv2 模拟（`drill/imds.py`，令牌必需，未知路径 404，逐条记录请求），169.254.169.254 地址与 nft DNAT（:80 → 本机 8169）由宿主架构的旁路容器（`drill/Dockerfile.helper`）加入演练容器的网络命名空间后设置（QEMU 用户态模拟不支持 netfilter netlink）；
  发行包由本机 HTTP 提供（`AppArchiveUrl=http://127.0.0.1:8080/…`，与 GitHub 下载同一路径）；数据卷 = 4 GiB 稀疏文件 + loop 设备，链接为 `/dev/sdf`（AL2023 的
  udev 规则在真实实例上做同样的事），`/dev/disk/by-label/cadata` 也由演练建立。然后像 cloud-init 一样以 root 运行 User Data，并检查 36 项（见第 5 节），
  最后再运行一次 `l0-bootstrap.sh all`，要求成功、`KEY_FINGERPRINT` 不变、健康检查仍为 200。结束时卸载并释放 loop 设备（容器已不在时用特权容器按 backing file 释放）。

### 4. 设计有歧义时的取舍

1. **构建只用已提交的源码**：`build.sh` 从 `git bundle` 克隆指定提交，不读工作区（并行任务的未提交改动不会混进发布包），`sourceCommit` 与 `repoCommit` 都是真实提交。
   `--overlay` 只为测试发布工具本身。
2. **arm64 用 QEMU 而不是交叉安装**：better-sqlite3 的预编译包按宿主架构选择，交叉安装容易混入 x64 二进制；arm64 的 stage 在 arm64 容器（QEMU）中装依赖并实际加载。
   与架构无关的部分只构建一次（`--prepare-only`），两种架构的 JS、检查包完全相同。
3. **检查包摘要的一致性**：同一 `SOURCE_DATE_EPOCH`（提交时间）构建 CloudAlbum 包里的检查包与平台的检查包，摘要相同；`package.ts` 不一致就拒绝打包（而不是只告警）。
4. **运行器的 node_modules**（本任务新发现的缺口）：CodeBuild（`ARM_CONTAINER`，`amazonlinux-aarch64-standard:3.0`）从 `cloudalbum-infra.zip` 直接运行 `scripts/module`，
   buildspec 没有安装步骤，原来的包里没有 node_modules，`scripts/module` 第一条 `import` 就会失败。改为由打包把 linux-arm64 的 node_modules 放进 zip（ZIP 不支持链接，
   工作区链接解引用为普通文件；`.bin` 不需要，`scripts/module` 按路径启动）。工作台的同一套 node_modules 保留链接，作为单独的 tar.gz 放进引导包。
5. **工作台安装逻辑随引导包发布**：03 §4.5 把全部安装写在 User Data 里；改为 User Data 只校验并调用包内的 `atl-ws-install.sh`。安装脚本因此受 `BundleSha256` 保护，
   以后改安装逻辑不必重新生成工作台模板（这次重新生成了一次 `templates/atl-workstation.yaml`，它是 `bootstrap/user-data.sh` 的生成物）。
6. **session-manager-plugin 在启动时下载**（任务要求，偏离 03 §4.5“启动时不访问第三方源”；AWS 官方下载地址不是第三方）：地址是安装指南中 `latest` 地址的带版本形式
   `https://s3.amazonaws.com/session-manager-downloads/plugin/<ver>/{linux_arm64|linux_64bit}/session-manager-plugin.rpm`（以官方文档为准，07 复核）。校验依据是维护者用
   `pin-ssm-plugin.sh` 固定的 SHA-256（首次经 HTTPS 下载时记录；摘要写进引导包清单，受 `BundleSha256` 保护）；没有固定就不安装，绝不安装未经校验的二进制。
   本任务没有下载插件（规则是不调用 AWS），所以当前 `pin` 为空、预检对此告警。官方是否提供 rpm 的签名校验方式没有核实，未采用。版本默认跟随 `PROTOCOL_COMPAT_VERSION`
   （浏览器协议层对齐的版本），固定值与它不同时打包告警。
7. **k6 可选**：实验运行器是 Node 实现（`experiments/_lib/load.ts`，`tool: k6` 的场景本来就会被拒绝），卡片的 `workstation.tools` 也没有 k6；没有 k6 时安装照常完成，
   `installed.json` 记 `absent`，`ws.ready` 与 `tool-versions` 原本就允许为空。仍可用 `--k6-tarball` 放进包里。
8. **node_modules 的两种来源**：默认预构建（arm64，`build.sh` 生成），启动时不访问 npm；没有预构建包或机器类型不符时现装（需要 npm 源，ws.ready 会晚几分钟）。
   现装不用 `npm ci`：工作台源码子集不含 backend、frontend 等工作区，原 lockfile 与收窄后的 package.json 不一致，`npm ci` 会拒绝；改为按原 lockfile `npm install`
   （版本仍被锁定），装完恢复原文件。只保留 `tsx` 一个开发依赖，因为 `npm run exp` 经 tsx 运行实验场景。
9. **演练中的退化**（容器做不到、与实例无关的部分）：`swapon` 为空操作（overlayfs 不能做交换，交换属于 Docker VM 的内核）——交换文件、mkswap、fstab 照常检查；
   `systemd-networkd-wait-online`、`systemd-remount-fs`、udevd 被屏蔽（无网络 / 根文件系统是 overlay / 容器没有 udev）；只在 QEMU 模拟（arm64）时：
   chronyd 换成替身单元、`xfs_growfs` 换成空操作、数据卷由宿主架构的旁路容器 `mkfs.xfs -L cadata`、nginx 补一行 `map_hash_bucket_size 64`（QEMU 用户态模拟跑不了
   chronyd 的时钟系统调用，不转发块设备 / XFS 的 ioctl，模拟的缓存行是 32 字节；前三次 arm64 演练依次停在 `systemctl enable --now chronyd`、
   `mkfs.xfs: cannot set blocksize`、`nginx: could not build map_hash`），所以 arm64 走的是“已有文件系统的数据卷”分支；`/dev/sdf` 与 by-label 链接由演练建立；
   `cfn-signal` 只记录（检查记录到 `-e 0 --resource InstanceA`）；`systemd` 检查只看 User Data 开始之后失败的单元。其余（dnf、Node 22、nginx、用户、systemd 单元与定时器、
   XFS 数据卷、机密、迁移、服务、经 nginx 的健康检查、HTTPS 自签名证书、fail2ban、sshd -t、检查包安装、原生模块）都是真实执行的。
10. **版本号**：CloudAlbum 发行包版本为 `<package.json version>-g<短提交号>`（如 `0.1.0-g7171e20`），可用 `--version` 覆盖；平台标签仍为 `v<platform/VERSION>`。

### 5. 自测结果（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28.3.2，WSL2 内核 + QEMU）

| 自测 | 命令 | 结果 |
|---|---|---|
| 构建 / 检查 | `npm run build`、`npm run lint` | 通过；0 个问题（`platform/infra/build` 被 eslint 配置忽略，由 `tsc -p platform/infra/tsconfig.json` 类型检查） |
| 单元测试 | `npm test` | 173 个文件通过（1 个跳过）：2077 个测试通过、19 个跳过；其中 `atl-infra` 与 `atl-workstation` 共 165 个（含“工作台模板与 user-data.sh 一致”） |
| 新增测试 | `node --test "scripts/verify/*.test.mjs"`；`node --import tsx --test "scripts/release-docker/test/*.test.mjs"` | 10 + 11 个，全部通过 |
| 全流程构建 | `bash scripts/release-docker/build.sh`（提交 ef0726e = 本任务第一个提交，无 overlay；之后的提交只改演练脚本与本节，制品未重建，预检会提示提交不同） | 879 秒：x86_64 包 3 分钟内完成，arm64 包（QEMU）4 分 23 秒，arm64 node_modules 7 分钟；两个包里 better-sqlite3 / sharp 0.34.5（libvips 8.17.3）/ argon2 都在各自架构上加载成功（Node 22.23.2，与 AL2023 的 nodejs22 相同）；检查包摘要 `70882506…b83b4` 在两个包与平台发布中一致 |
| 发布布局 | `dist/release/v0.1.0-dev/` | `atl-lambdas.zip`、`atl-web.zip`（真实 SPA 构建）、`atl-content.zip`（目录 0.1.0-dev）、`cloudalbum-app-{arm64,x86_64}.tar.gz`（各约 30 MB）、`cloudalbum-infra.zip`（6,492 个条目，约 87 MB，含 linux-arm64 node_modules）、`atl-workstation.tar.gz`（约 29 MB，含预构建 node_modules）、模板（382 KiB）、`SHA256SUMS`（含 `# checks-bundle-digest`）、`release-manifest.json`、`launch-stack.md`、`package-report.json`；CloudAlbum 包另在 `dist/release/app/`（带 `.sha256`） |
| 预检（制品） | `preflight.mjs --artifacts-only`（构建容器内与本机各一次） | 11 通过、1 警告（插件未固定）、0 失败 |
| 预检（本机） | `node scripts/verify/preflight.mjs` | aws-cli 2.34.45 通过；没有 `~/.aws/config`、没有凭证、没有默认区域 → 2 个 FAIL，均给出配置命令；cfn-lint 未安装 → 警告；没有发起任何 AWS 调用 |
| 运行器包 | arm64 容器（QEMU，`--network none`）解开 `cloudalbum-infra.zip` | `sha256sum --check --strict` 通过（6,491 行，与 buildspec 相同）；`scripts/module --help` 启动；argon2 散列；module-cli 能解析 `@aws-sdk/client-cloudformation` |
| L0 离线演练 x86_64 | `bash scripts/release-docker/drill.sh` | 36 通过、0 失败、1 退化（swap）：User Data 30 秒退出 0；Node v22.23.2（alternatives 指向 node-22）、nginx 1.30.5；nginx、api、worker、5 个定时器 / path 单元 active + enabled；经 nginx 的 `/api/health/ready?scope=instance` 200，HTTPS 自签名 200；XFS `LABEL=cadata` 数据卷挂载、`/etc/cloudalbum` 链接、机密 0640 root:cloudalbum、ES256 密钥、SQLite、`.initialized`、`KEY_FINGERPRINT`、管理员密码文件 0600；检查包装到 `/opt/atl`；以 cloudalbum 用户加载三个原生模块；fail2ban 1.1.0 active（AL2023 现在有这个包）；`sshd -t` 接受加固配置；cfn-signal 记录为 `-e 0 --resource InstanceA`；AWS CLI 从未被调用；IMDS 只被读了 mac、vpc-ipv4-cidr-blocks、两个实例标签与 services/partition；第二次运行 7 秒退出 0、指纹不变 |
| L0 离线演练（平台模式） | `drill.sh --platform-mode on` | 36 通过、0 失败、1 退化、1 信息：不创建管理员（PM-07）；`.ssm-agent-check.json` 写出（见第 7 节 infra 一条） |
| L0 离线演练 arm64 | `drill.sh --arch arm64`（QEMU） | 35 通过、0 失败、3 退化（chronyd 替身、swap、数据卷由旁路容器格式化），约 15 分钟：User Data 590 秒退出 0；arm64 的 nginx、Node 22、三个原生模块（以 cloudalbum 用户加载）、服务与定时器、经 nginx 的健康检查 200、fail2ban、cfn-signal `-e 0`、第二次运行 227 秒退出 0 且指纹不变。前三次尝试暴露的都是 QEMU 的限制（见 4.9），其中缓存行一条对 infra 有参考价值（第 7 节） |
| 工作台演练 x86_64 | `bash scripts/release-docker/ws-drill.sh` | 12 通过：`BundleSha256` 与逐文件校验、`atl-ws-install.sh`、5 个工具、检查包、labuser 与仓库、插件未固定 → 跳过并写明原因、k6 缺省、机器类型不符 → 选择现装（无网络所以失败，符合预期）、错误摘要 → 不安装、正确摘要 → 下载校验安装；唯一的 `aws` 调用是 mock 的 `s3 cp` |
| 磁盘 | `dist/release` / `dist/release-work` / `dist/release-cache` | 约 268 MB / 70 MB / 257 MB，都在 D 盘；Docker 镜像 `atl-release-builder:{amd64,arm64}`（各约 1.1–1.2 GB）、`atl-l0-drill:{amd64,arm64}`（444 / 574 MB）、`atl-l0-drill-helper:amd64`（290 MB）在 Docker Desktop 的虚拟磁盘（C 盘），不再需要时 `docker image rm` |

### 6. 必须在真实 AWS 上验证（07）

- 插件下载地址（带版本的路径）与 `pin-ssm-plugin.sh` 记录的摘要；工作台实例上 `atl-ws-install.sh` 的完整运行（含 `dnf install` 官方 rpm、`session-manager-plugin --version`）。
- CodeBuild `amazonlinux-aarch64-standard:3.0` 中 `scripts/module` 用 zip 里的 node_modules 启动（Node 22 运行时与 AL2023 的 glibc 一致，本地只在 AL2023 arm64 容器中验证过）。
- L0 实例上演练做不到的部分：真实的 EBS / NVMe 设备与 udev 链接、交换、cfn-signal 到 CreationPolicy、IMDS 标签读取（`InstanceMetadataTags=enabled`）、经 EIP 的访问、
  平台模式（`--platform-mode on` 只覆盖 ssm-agent 检查与不建管理员）。
- 发布包大小与 `CopyArtifacts`（Lambda 15 分钟内下载并校验约 190 MB 的全部资产）。

### 7. 需要其他部分配合

- **根 package.json（不在本节路径内）**：建议增加 `"release:docker": "bash scripts/release-docker/build.sh"`、`"preflight": "node scripts/verify/preflight.mjs"`、
  `"test:release": "node --import tsx --test \"scripts/verify/*.test.mjs\" \"scripts/release-docker/test/*.test.mjs\""`，并把后者加入 CI；`platform:build` 打包前加 `npm run build:web`（web 脚手架已提）。
- **维护者（部署前）**：`bash scripts/release-docker/pin-ssm-plugin.sh` → 提交 `workstation-tools.json` → 重新 `build.sh`；07 PM-06 确认最低 SSM Agent 版本后以
  `SSM_AGENT_MIN_VERSION=<v>` 重新构建；`release.config.json` 的 `templateBucket` 仍是占位。
- **infra（`infra/userdata/l0-bootstrap.sh`，演练发现）**：`ssm_agent_check` 用 `ver=$(rpm -q --qf '%{VERSION}' amazon-ssm-agent 2>/dev/null || true)`，
  rpm 把 “package amazon-ssm-agent is not installed” 写到 stdout，于是被当成版本号写进 `.ssm-agent-check.json`（`meetsMinimum` 也因此不是 false）。应改为
  `ver=$(rpm -q --qf '%{VERSION}' amazon-ssm-agent 2>/dev/null) || ver=''`。AMI 上预装了 Agent，正常路径不受影响。
- **infra（`infra/nginx/nginx.conf`，演练发现）**：nginx 的 `map_hash_bucket_size` 默认取 CPU 缓存行长度；`cloudalbum.conf` 的 `$ca_block` map 在 32 字节时
  建不起来（`could not build map_hash`）。Graviton 与 x86_64 是 64 字节，所以真实实例不受影响；QEMU 下的 arm64 报 32（`getconf LEVEL1_DCACHE_LINESIZE`）。
  建议在 `http {}` 中显式写 `map_hash_bucket_size 128;`，不依赖硬件。演练只在 QEMU 下用 `conf.d/00-drill-qemu.conf` 补上这一行。
- **workflows / 02**：buildspec 可在 install 阶段校验 `node_modules` 存在（现在缺失时 `scripts/module` 的报错不直观）；运行器默认架构 arm64，与默认实验机一致。
- **01 / 03**：登记 `atl-workstation.tar.gz` 的新文件（`atl-ws-install.sh`、`atl-install-node-modules.sh`、`cloudalbum-node_modules.tar.gz`）与清单字段 `tools`、`nodeModulesInfo`；
  03 §4.5 的“启动时不访问第三方源”改为“插件从 AWS 官方地址下载并按固定摘要校验”；01 §4.5 的 `cloudalbum-infra.zip` 内容加上 linux-arm64 node_modules。
- **web**：`verify/` 由谁发布仍未定（占位包里有 `verify/`，真实 web 构建没有）。

### 8. 依赖

没有在仓库中运行 npm install，lockfile 未变；新脚本只用 Node 内置模块（测试用已有的 tsx 加载 TypeScript）。Docker 镜像：`amazonlinux:2023`（本机已有，arm64 变体为本次拉取）。
可选：cfn-lint（本机没有，预检对此告警）。

## platform-web-integration

把 web-catalog、web-workspace、web-results、ssm-client、backend-gaps、release 六份实现接到一起：补齐依赖与根目录登记，路由接入真实画面，
新增浏览器端到端自测 `npm run e2e:platform`，并修复联调中发现的问题。全程没有调用真实的 AWS API，没有部署任何东西；浏览器只访问 127.0.0.1。

### 1. 如何本地运行平台

```bash
npm install --before=2026-09-29 && npm run build      # 一次即可（local-l0 运行器要用 backend/dist）
npm run platform:dev        # 一条命令：DynamoDB Local（Docker）+ 建表 + dev-server(:8787) + Vite(:5174)；浏览器打开 http://127.0.0.1:5174/ ，开发模式登录 learner / u1
npm run e2e:platform        # 浏览器端到端自测（约 4 分钟）；-- --keep 保留表与数据，--serve-only 只起服务供手动探索，--headed 显示浏览器，--no-build 复用构建产物
```

`platform:dev` 默认是 noop 运行器、×1 时钟；要像 e2e 一样跑真实检查，设 `ATL_DEV_RUNNER_MODE=local-l0`、`ATL_DEV_CHECK_RUNNER=platform/checks/dist/atl/bin/atl-check.mjs`
（先 `node platform/checks/build.mjs`）、`ATL_DEV_TIME_SCALE=5`。dev-server 现在把 `PlatformConfig.platformUrl` 设为 Vite 的地址（`ATL_DEV_PLATFORM_URL`），
证书签发者来源、分享链接与验证页在浏览器里是同源的。

`e2e:platform`（`scripts/e2e/platform.mjs` + `scripts/e2e/platform_e2e.py`）：每次一套表（`atl-main-e2e-<时间>`）；`vite build` 与 P09-V 公开页构建；
dev-server（`local-l0`、dev 检查引擎、ssm-client 模拟服务器、联合登录桩、×5 时钟）；Vite dev（主流程）；另起 `vite preview`，以 70-web.yaml 的
atl-web-spa CSP 头提供生产构建（CSP 检查）。Python Playwright 用系统 Chrome（`channel="chrome"`，无头）。结果在 `.atl-dev/e2e/run-<时间>/`（截图、
`results.json`、各服务日志）与 `.atl-dev/e2e/last.json`；全部通过时删表、删数据目录与本地 L0 目录，失败时保留数据（表照常删除，`--keep` 全部保留）。

新增的 dev 控制端点（只在 ATL_DEV_MODE=1 的 dev-server）：`POST /__dev/clock/scale {scale}`（改变时钟倍速）、`POST /__dev/fixtures/completions {sub, trackId|labIds}`
（路径必修卡片的完成记录与 verified 徽章，标 `fixture: dev`）、`POST /__dev/reclaim/protected-resource {sessionId}`（学员在控制台建了删除保护无法解除的 RDS 实例：
假账号资源 + CloudTrail，与 smoke 第 8 阶段相同）、`POST /__dev/reclaim/delete-resource`（学员手动删除）。dev-server 还按 CloudFront 的规则提供 `/verify/*`（改写到
`verify/index.html`）、`/.well-known/`、`/public/`、`/share/`，带 atl-web-verify / atl-web-share 的 CSP 头，缺失对象回 403（与 OAC 下的 S3 一致）；Vite 代理这些路径。

### 2. 自测结果（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28 / 系统 Chrome）

| 自测 | 命令 | 结果 |
|---|---|---|
| 依赖 | `npm install --before=2026-09-29` | 新增 2 项：`@aws-sdk/client-pricing` 3.1142.0（@atl/api）与 `@atl/ssm-client` 的 workspace 链接；`ws` 不再标为 dev |
| 构建 | `npm run build`（含 web 两份 tsc 与 ssm-client 两个工程）、`npm run build -w @atl/web`（现在也构建 public-pages） | 通过 |
| 检查 | `npm run lint` | 0 个问题 |
| 单元 / 组件测试 | `npm test` | 179 个文件、2169 个测试通过，18 个跳过（需外部服务）；新纳入 atl-ssm-client 项目（88 个）；`pricing.test.ts` 的 aws-sdk-client-mock 用例现在运行 |
| 发布工具测试 | `npm run test:release` | 21 / 21 |
| CloudAlbum | `npm run smoke:l0`、`npm run smoke:selfhost` | 85 / 85、31 / 31 |
| 平台端到端（API） | `npm run smoke:platform` | 120 / 120，128 秒 |
| 浏览器端到端 | `npm run e2e:platform` | **49 / 49**，241 秒；无控制台错误、无 5xx / 429 / 意外 4xx |

`e2e:platform` 的内容（都经页面操作；括号内是 dev 替身）：

| 阶段 | 验证内容 |
|---|---|
| 1 登录 | 未登录 `/labs` → `/login?next=`；dev 令牌登录 → P00 七步首次设置（勾选“我已了解”、选 quick-compare）→ 目录 |
| 2 目录 | 56 张（40 + 16）；筛选“场景”→ 16 / 56 且写入查询串；搜索“Lab 4”命中 svc-storage；planned 标“即将推出”；服务地图（40 格）与路径视图；顶栏“进度”浮层 |
| 3 开始 | P03 简介 → P03-D 报价（dev 夹具，标“不是 AWS 价格”）→ 勾选费用确认才可开始 → 202 进入 P04（阶段、计费说明、倒计时未开始）→ READY 进入 P05 → 心跳 RUNNING（本地 L0、工作台、健康门） |
| 4 工作台 | 左：第 1 步“检测”→ 两项检查 pass（dev 检查引擎对本地 L0）；右：实验机终端经 ssm-client ↔ 模拟数据通道输入输出、`stty size`；控制台按钮先开命名空白页再 POST 表单到 dev 联合登录桩（不留空白页）；应用预览在新标签页打开本地 CloudAlbum |
| 5 延长与到期 | 延长对话框（报价、勾选）→ 截止 +30 分钟（deadlineVersion 2）；时钟跳到截止前 16 分钟 → EXPIRING 与 T-15 琥珀横幅；截止前 4.5 分钟 → 一次性 T-5 对话框；切 ×1 后越过截止 → 覆盖层（alertdialog）→ P07 回收进度（阶段列表）→ ENDED |
| 6 报告与分享 | P08 定稿报告；创建分享链接 → 无需登录可打开 `/share/<id>/index.html` → 撤销 → 列表“已撤销”、副本 403 |
| 7 证书 | dev 夹具补齐 quick-compare 必修卡片 → P09“领取…”并公开 → P09-C；公开验证页 P09-V（WebCrypto + jwks + 签名吊销列表）“签名有效”→ P09-C 吊销 → 验证页“已吊销” |
| 8 清理失败 | 第二个会话；注入删除保护的 RDS 实例 → 在目录页经顶栏会话菜单“结束实验…”（真实 EndDialog）释放 → CLEANUP_FAILED → P07-M 清单（控制台链接、CLI）→ 学员删除 →“我已处理，重新核对”→ ENDED |
| 9 截图 | 400px 与 1280px 下 16 个主要画面（目录两视图、简介、路径、工作台存档、会话列表与详情、回收、报告、待人工处理、证书两页、我的学习、设置、验证页、404）无横向滚动，全页截图 |
| 9b CSP | `vite preview` 的生产构建在 atl-web-spa CSP（`script-src 'self'; style-src 'self'` 等）下打开 9 个画面，没有 `securitypolicyviolation` |
| 10 控制台 | 全程（含验证页、分享副本、生产构建）无 console error / pageerror；4xx 只允许白名单（本次为空），5xx 与 429 一律失败 |

### 3. 集成与修复

**登记与接线**

1. `@atl/ssm-client` 登记为 workspace：根 `workspaces`、`tsconfig.json`（references 两个工程 + paths）、`vitest.config.ts`（项目）、`vitest.shared.ts`（别名）、`platform:test`、
   `platform:build`；`eslint.config.js` 给 `platform/ssm-client/src/**`（不含 mock）浏览器全局，并禁止导入 `node:*`、`ws`、`@aws-sdk/*`。web 增加依赖、vite alias 与 tsconfig paths，
   `terminal/channel.ts` 由 `import.meta.glob` 改为按需 `import('@atl/ssm-client')`。
2. `routeTable.ts` 全部指向 `pages/*` 的默认导出，`*` → `pages/errors/NotFoundPage`；删除 `features/*` 桩与 `PageStub`，`features/workspace/terminal/xterm.ts` 移到 `workspace/terminal/xterm.ts`。
3. 会话动作对话框：`app/sessionActionDialogs.tsx` 按需加载 `workspace/timer/StandaloneDialogs.tsx`（在工作台之外为 Cancel / Extend / EndDialog 准备 WorkspaceContext），
   `AppRoutes` 默认注册；顶栏会话菜单与目录环境条不再弹“这个画面将在后续实现”。
4. 顶栏“进度”浮层原来只有占位文字：新增 `pages/labs/components/ProgressPanel.tsx`（当前路径的必修、已核验、分段条、recommendNext 与链接），展开时按需加载。
5. P09-V（web-results 的设计版验证页）由 atl-certs 发布：`platform/api/build.mjs` 把 `public-pages/dist/verify/*` 以 `__ATL_VERIFY_PAGE__` 嵌入函数包；`static-site.ts` 的
   `verifyPageAssets()` 在没有构建产物时退回原来的简版页；`publishVerifyPage` 发布 index.html、verify.js、verify.css；dev-server 从构建目录设置；`npm run build -w @atl/web`
   现在同时构建 public-pages；`package.ts` 在未构建时告警。分享副本仍由 api 的 `renderReportHtml` 生成（web 的 `render-share.mjs` 暂不使用）。
6. 根脚本：`e2e:platform`、`build:web:public`，以及 release 提出的 `release:docker`、`preflight`、`test:release`。dev 运行时：`ATL_DEV_TABLE_MAIN` / `ATL_DEV_TABLE_LOCKS`
   （每次一套表，`create-tables.ts --drop`）、`ATL_DEV_PLATFORM_URL`、`ScaledClock.setScale`；`npm run platform:dev` 把 Vite 地址作为 platformUrl 传给 dev-server。

**联调发现并修复的问题**

1. **dev-server 一调用 `/__dev/*` 就崩溃**（`EADDRINUSE`）：`dev/server.ts` 的入口判断只看文件名后缀 `server.ts`，`dev-server.ts` 也满足，按需导入时会再起一个运行时监听同一端口。
   改为只匹配 `dev/server.ts` 这个路径。
2. **dev 模式终端 400**：dev 实例 ID（`i-dev-<env>-lab`）不符合 `POST …/terminals` 对 `instanceId` 的校验，而浏览器会带上 `/workspace` 返回的 ID。dev 的 WorkspaceAccess 改为给出
   EC2 形式的别名（`i-0` 加 16 位十六进制）；`dev-workspace.test.ts` 增加断言。
3. **会随时间失效的测试**：`dev-workspace.test.ts` 用固定虚拟时钟（2026-10-14T01:00Z）签发 `connectBy`，客户端按墙钟判断，01:00:30Z 之后必然失败。测试开头把虚拟时钟推到真实时间。
4. 分享副本与简版验证页的 `<meta>` CSP 含 `frame-ancestors`，浏览器每次打开都报控制台错误（它只能由响应头生效，CloudFront 已经发送）。从 meta 中去掉。
5. 工作台没有 `h1`（08 §8.2 要求每个画面一个）：会话栏加只给读屏的 `h1`“工作台 · <卡片标题>”。1280px 下卡片 id 在连字符处折行：`.wsbar .ttl .mono` 不折行。
6. dev 的应用预览入口是 `http://<env>.dev.invalid`：`local-l0` 模式下 `stackOutputs` 改为返回本地 L0 的地址，新标签页能打开。
7. ESLint 会扫描 `.claude/worktrees/`（其他代理会话的 git worktree），报 53 个错误：加入 ignores。
8. App 测试按真实工作台更新（会话栏是本画面的 banner，断言改为“没有主导航”）。

### 4. 设计有歧义时的取舍

1. **到期覆盖层与 ×5 时钟**：×5 下 ENDING → ENDED 只有约 9 秒，客户端 5～10 秒的轮询会直接看到 ENDED（只读存档），覆盖层不出现。生产中 ENDING / CLEANING 持续数分钟，
   前端不改；e2e 在越过截止前把时钟切回 ×1（`/__dev/clock/scale`）。时钟跳跃后页脚提示“本机时钟与服务器相差约 n 分钟”，是 dev 时钟的预期表现。
2. **P09-V 的发布者**：04 §10.6 规定由 atl-certs 发布验证页，所以不放进 atl-web.zip，而是嵌入 atl-certs 的函数包（同一份构建产物）；构建缺失时退回简版页，验证逻辑一致。
3. **证书夹具**：路径必修卡片的完成记录用 dev 夹具补齐（任务允许）；签发、公开、验证、吊销全部走真实代码。
4. **CSP 检查不含终端**：生产 CSP 的 `connect-src` 只允许 `wss://ssmmessages.<region>`，dev 的 `ws://127.0.0.1` 模拟服务器在 CSP 下本来就连不上，所以 CSP 检查只覆盖不开终端的画面；
   xterm 6 运行时注入 `<style>` 与 `style-src 'self'` 的冲突（03 §3.7.6）仍待 07 V2-3 决定。

### 5. 与 07 验证计划的对应

| 07 条目 | 本地已覆盖（本节） | 仍须在真实 AWS 上验证 |
|---|---|---|
| V0-6 代码就绪 | build、lint、test、三项 smoke、e2e:platform | — |
| V1-5 控制台联合登录 | 浏览器侧：同步打开命名窗口 + POST 表单（dev 桩），不留空白页 | 角色链、区域端点、`SessionDuration` |
| V2-2 / V2-3 浏览器终端 | 浏览器里 ssm-client ↔ 模拟数据通道（握手、输入输出、尺寸）；生产构建在 CSP 下无违规（不含终端） | 真实 `ssmmessages`、Origin、xterm 在 `style-src 'self'` 下（V2-3 第 4 步）、输入法与前导键 |
| V3-3 平台模式自检 | 本地 L0 平台模式下的检查（经 UI 触发） | 实例上的 Nginx、CSP、探测 |
| V5-1 安装与首次登录 | P00 首次设置、dev 令牌登录 | Cognito 托管登录、CloudFront 回源、WebDeploy 发布真实 SPA，atl-certs 发布 P09-V |
| V5-3 / V5-4 主路径 | 目录 → 报价 → 开始 → P04 → P05（检查、终端、控制台、预览）→ 结束 → 回收 → 报告 | 真实运行器、SSM、kms:Sign、Price List 价格 |
| V5-6 延长与到期 | 延长对话框、T-15 横幅、T-5 对话框、到期覆盖层、自动回收 | 真实 EventBridge Scheduler 时序 |
| 证书（V5-3 收尾） | 领取、公开、P09-V 验证、吊销后“已吊销” | CloudFront 改写 `/verify/*`、缓存失效、KMS 签名 |
| 清理失败（V5-7、V6） | CLEANUP_FAILED → P07-M →“我已处理”→ ENDED | 真实不可删资源、CloudTrail 投递延迟 |
| V5-9 卸载 | 只在 smoke:platform 第 9 阶段（API） | 全部 |

### 6. 明天真实验证前需要人工准备的事项

1. **凭证与区域**：本机没有 `~/.aws/config` 与凭证（`npm run preflight` 报 2 个 FAIL）。按 07 §1 用 IAM Identity Center 配置 profile 与默认区域（`ap-northeast-1`，
   `release.config.json` 只验证了这个区域），并先设好预算告警（V0-2）。
2. **重新构建发布包**：`dist/release/` 是 ef0726e 构建的，那时路由还是桩，也没有本节的修复。提交本节后在新提交上运行 `npm run release:docker`，再
   `npm run preflight -- --artifacts-only --release-dir dist/release/v0.1.0-dev` 核对；确认 `atl-web.zip` 是接入后的 SPA，`package-report.json` 中没有“P09-V 未构建”的告警。
3. **固定 session-manager-plugin**：`bash scripts/release-docker/pin-ssm-plugin.sh` → 提交 `workstation-tools.json` → 重建；`SSM_AGENT_MIN_VERSION` 确认后再设置。
4. `release.config.json` 的 `templateBucket` 仍是 `<release-bucket>` 占位；`githubRepository` 能否公开下载需确认（atl-copy-artifacts 从 GitHub Release 取资产）。
5. **cfn-lint**：本机没有；安装后运行 `ATL_CFN_LINT=<路径> npm run cfn-lint -w @atl/infra`。
6. **浏览器**：控制台联合登录用单独的浏览器配置文件（会替换已登录的 AWS 身份）；准备 Edge / Firefox 与中文输入法，做 V2-3 第 5、7 步。
7. **需要用户在场确认的操作**：07 §12 列出的建栈、删除与费用相关操作；助教邮箱（Cognito 邀请会真实发信）。

### 7. 仍然存在的问题

- **web 尚未使用的 API 细化**（backend-gaps 已实现）：报告 `?version=`、`/resources/manual` 条目的 `labId` 与会话时间（P07-M 仍逐个读会话）、`GET …/terminals` 的 `clientId` 清理、
  步骤级预期中断入口（§9.2 #25）、运行器日志与证据路由；会话列表的 `attemptStatus` 与费用 API 仍未提供。
- 顶栏“进度”按钮只显示“进度”，没有 `进度 23/40` 计数，也没有“切换当前路径”；服务格侧栏不拆分数（API 不给分项）。
- web 的 `render-share.mjs` 与 api 的 `renderReportHtml` 两份分享渲染并存，生产只用后者。
- xterm 的 CSP 冲突、终端在生产 CSP 下的表现、真实 `ssmmessages` 都未验证；缺 Storybook、axe-core、xterm 插件（web-links、search、unicode11、webgl、clipboard）、cfn-lint、Go 工具链。
- dev 替身：价格是夹具；实验机终端是模拟 shell（没有 `aws`）；控制台是本地登录桩；回收在内存账号中，`/__dev/reclaim/*` 注入资源的 CLI 提示是注释，不是可执行命令。
- 本节只提交了自己改动的路径；`docs/` 下的其他文件（含 `docs/platform/`）由并行的提交 bc171f5 加入，本节没有修改。

## platform-web-review-fixes

修复审查提出的 5 个问题（1 个 high、3 个 medium、1 个 low，全部修复）。全程没有调用真实的 AWS API，也没有部署任何东西；没有运行 `npm install`。

### 1. 修复内容

| 级别 | 问题 | 修复 | 主要文件 |
|---|---|---|---|
| high | xterm.js 6 在生产 CSP `style-src 'self'` 下运行时注入的 3 个 `<style>` 被浏览器拦截：主题、字体、光标与滚动条样式丢失，行文字回退为比例字体，列、光标与选区错位 | 采用 03 §3.7.6 的首选方案，CSP 不变，以运行时补丁实现（不使用 patch-package）。`term.open()` 期间临时替换 `document.createElement`：`'style'` 改为返回不渲染的 `<template>` 替身，其 textContent 写入可构造样式表（`new CSSStyleSheet()` + `replaceSync()`）并挂到 `document.adoptedStyleSheets`，`remove()` 时摘下；open 结束后恢复 createElement。审查没有提到、但同样会被拦截的 `DomRendererRowFactory._addStyle`（真彩色与最低对比度调整用 `setAttribute('style')`）改为 `style.setProperty`（CSSOM）。xterm 内部结构变化导致补丁未生效时，控制台警告一次 | `web/src/workspace/terminal/cspStyles.ts`（新）、`xterm.ts` |
| medium | 确认框选“在新的终端子标签中粘贴”后，沿用了旧终端的判定，没有对新终端重新判定，多行或危险命令在新终端里被逐行执行 | 新增 `terminal/pasteFlow.ts`（`runPaste`）。流程为 Ready → `waitForPrompt` → 按要粘贴进去的那个终端判定；选 newtab 后，新子标签 Ready 且出现提示符，再用新终端的状态重新判定（reject 或 confirm 照常处理，危险命令会再次弹出红色确认）。等不到提示符、终端仍不是 bracketed 模式时，多行一律拒绝并自动复制，拒绝框显示“命令已复制到剪贴板”。“目标终端未打开”的分支同样先等提示符，不会误拒。`TerminalController.waitForPrompt`：OSC 133 B 或 bracketedPasteMode 开启即视为提示符出现；只收到 A 时再等 300ms 宽限；时限 5 秒，从 Ready 且 xterm 接上时起算，因此已经用了一阵的终端不会每次都等；新的 SSM 会话会重置，resume 不重置 | `terminal/pasteFlow.ts`（新）、`controller.ts`、`Workspace.tsx`、`workbench/PasteDialogs.tsx` |
| medium | `connectBy` 按服务端时钟签发，客户端却用本机时钟比较；本机时钟快 30 秒以上时永远连不上（5 次 resume 后进入 reconnect-exhausted） | ssm-client 的 `StreamCredentials` 增加 `serverNow`，`localConnectDeadline` 把 connectBy 换算成“收到时刻 +（connectBy − serverNow）”的相对期限。API 的 `POST …/terminals` 与 `…/resume` 响应带回 `serverNow`；web 的 TerminalController 优先用响应里的 serverNow，没有时用 `serverClock.now()`（`useServices().clock`）。不改协议层的 `now`，DataChannel 的重传计时与空闲判断仍用本机单调时间 | `ssm-client/src/connection.ts`、`api/src/services/workspace/provider.ts`、`web/…/terminal/controller.ts`、`channel.ts`、`TerminalPane.tsx` |
| medium | EXTEND/KEEP 报价的 `ref: module` 按模板默认参数展开（NAT 为 0、Single-AZ、最小规格），少算且不标 unknown | `Environment.moduleParams`（可选，模块 → 启用参数）由 `quoteLinesForEnvironment` 随 `ref: module` 行传给 atl-pricing（`line.params`，只保留 `pricingParamKeys()` 中的键：scaleBy 的键与 InstanceType / DbInstanceClass / CacheNodeType）。`expandLines` 把它作为 sources；没有记录时，带 scaleBy 或模块参数占位符的条目输出 unknown 行，并把 pricingKey 加入 `incomplete`，不查价也不套用默认值，因此 KEEP 的 `requiresTypedConfirm` 也会生效 | `api/src/services/pricing/estimate.ts`、`catalog/quotes.ts`、`functions/lifecycle/store/model.ts`、`shared/src/entities.ts` |
| low | `ATLPricingFunctionRole` 对整个 PLATFORM 分区有写权限 | 拆成两条语句：`PriceAndQuoteItems` 只保留 `PRICE#*`、`USER#*` 的读写；新增 `PlatformConfigRead`，PLATFORM 只允许 `dynamodb:GetItem`。IAM 只能限定分区键，限定不到 CONFIG 这一条，所以只读是可行的最小权限 | `infra/src/50-iam.yaml` |

测试：`cspStyles.test.ts`（替身与样式表；jsdom 中真实打开 xterm 6.0.0，确认 0 个 `<style>`、3 个替身，并找到行工厂内部路径）；`pasteFlow.test.ts`（审查给出的触发路径：忙碌加多行，选 newtab 后被拒绝、命令被复制、没有粘贴；新终端开启 bracketed paste 后再次确认才粘贴；未打开的终端先等提示符）；`controller.test.ts`（waitForPrompt 的 A/B、bracketed、宽限、时限与断开；时钟偏差 +60 秒仍能连接）；ssm-client `connection.test.ts`（本机时钟快 60 秒时直接连接，不走 resume；`localConnectDeadline`）；`pricing.test.ts`（有参数时 NAT 按 1 计、Multi-AZ ×2、按记录的规格查价；无参数时 4 项 unknown 进入 incomplete、不查价；参数白名单）；`workspace-provider.test.ts`（serverNow）；`inventory.test.ts`（定价角色对 PLATFORM 只读）。

e2e：新增“4b csp-live”阶段。工作台阶段结束后，在 `vite preview` 的生产构建（70-web.yaml 的 CSP）中打开同一个 live 会话的工作台与实验机终端，输入 `printf` 输出真彩色和蓝色文字，然后断言：`securitypolicyviolation` 为 0、页面没有 `<style>`、adoptedStyleSheets ≥ 2、行字体为 JetBrains Mono（不同于页面字体）、真彩色单元格已上色。为了让终端能在 CSP 下连接，e2e 只在 `connect-src` 中追加本地 SSM 模拟服务器的地址（`withMockSsm`），`script-src`、`style-src` 与 70-web.yaml 完全一致。

### 2. 自测结果（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28 / 系统 Chrome）

| 自测 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过 |
| 检查 | `npm run lint` | 0 个问题 |
| 单元 / 组件测试 | `npm test` | 182 个文件（181 个通过、1 个跳过），2193 个测试通过、18 个跳过（需要外部服务）；本节新增或扩充 7 个测试文件 |
| 平台端到端（API） | `npm run smoke:platform` | 120 / 120，128 秒 |
| 浏览器端到端 | `npm run e2e:platform` | **51 / 51**，206 秒（新增“4b csp-live”的 2 项）；没有控制台错误，也没有 5xx / 429 / 意外 4xx。反向对照：临时去掉补丁后，csp-live 报告 `style-src-elem` 违规并失败（已恢复） |

### 3. 设计有歧义时的取舍

1. **CSP 方案**：03 §3.7.6 首选给 xterm 打补丁并保持 CSP 不变；文档写的是用 patch-package 修改源码，这里改为在 `createXterm` 中做运行时补丁，因为当前阶段不能 `npm install`，且补丁只依赖 3 处 `createElement('style')` 都在 `open()` 中同步执行这一点。`_addStyle` 的替换依赖 xterm 6.0 的内部路径 `_core._renderService._renderer.value._rowFactory`，由 jsdom 中的真实 xterm 测试守住；升级 xterm 时这个测试会失败。可构造样式表是否受 `style-src` 约束，以本地 Chrome 实测为准（07 U43 仍需在 Edge、Firefox 和真实 ssmmessages 上确认）。
2. **connectBy**：审查给了两种做法。这里选“相对期限”而不是给协议层传 `now: serverClock.now`，因为 `now` 同时驱动 DataChannel 的重传计时和 `readyAt`/`lastInputAt`，而控制器按本机时间判断空闲断开，混用两种时钟会把空闲断开误判为其他原因；serverClock 的样本更新时还会让重传计时跳变。
3. **提示符信号**：03 §3.7.5 的 shell 集成在 PROMPT_COMMAND 中输出 OSC 133 A，这发生在 readline 输出 `ESC[?2004h` 之前；PS1 末尾的 B 在它之后。因此以 B 为准，只收到 A 时给 300ms 宽限。本地模拟 shell 只输出 A/B，不开启 bracketed paste，所以 dev 模式下多行粘贴依旧被拒绝，现在会自动复制。
4. **moduleParams**：目前没有任何代码写入 `Environment.enabledModules`（lifecycle start 写 `[]`），所以现阶段 EXTEND/KEEP 报价实际上没有模块行。本节只定义 moduleParams 字段、读取方式和“无记录即 unknown”的规则；负责写入 enabledModules 的一方要同时写入 moduleParams（模块栈参数中的定价键）。卡片 variant 中目标模块的 `set` 只是期望值，不能代表学员实际启用时的参数，因此不作为来源。
5. **e2e 的 T-5 对时**：第一次运行时 T-5 对话框在截止前没有出现。原因是 dev 时钟跳跃后会话状态不变，轮询返回 304，没有 serverNow 样本；60 秒一次的心跳样本又可能因往返时间较长被 ServerClock 丢弃，而 ×5 时钟在 T-4.5 到截止之间只剩 54 秒。上一轮通过时也等了 30 秒。e2e 在这次跳跃后派发一次 `visibilitychange`，相当于标签页回到前台，页面会立即对时。产品代码不改，生产环境的时钟不会跳跃。

### 4. 需要其他部分配合

- 写入 `Environment.enabledModules` 的一方（module-op 或运行器回报）要同时写入 `moduleParams[module]`（例如 `NETWORK_NAT_MODE`、`MultiAz`、`DbInstanceClass`、`CacheNodeType`、`InstanceType`），否则这些模块的报价会一直显示“未知”。
- 03 §3.2 的接口表：`POST …/terminals` 与 `…/resume` 的响应新增 `serverNow`（只增加字段，旧客户端不受影响）。按规定本节不修改 docs/platform，请文档负责人补上。
- 07 V2-3 / U43：在真实 CloudFront CSP 与 ssmmessages 下，用 Chrome、Edge、Firefox 复核终端显示和 0 个 CSP 违规；WebGL 插件目前没有使用，如果以后引入，它的 `<style>` 也要走同一个补丁。
- `npm test` 中 ssm-client 的 `mock.test.ts`“survives a dropped connection”在全量并行时偶尔超过 15 秒（本节第一次全量运行出现过一次，单独运行和第二次全量运行都通过），与本节改动无关。

### 5. 提交范围

只提交本节改动的路径（第 1 节所列文件、对应测试、`scripts/e2e/`）和本节笔记；工作区中其他会话的改动不在提交范围内。

---

## wave1-prep

第 1 波模块补齐的准备阶段：notification、email、monitoring、cost、logging、shell-access、dns、tls、waf、identity-pool 共用的文件、依赖与 hook 机制。各模块的实现者从这里开始，只改自己负责的路径（见第 2 节）。

### 1. 本阶段完成的内容

| 范围 | 文件 | 内容 |
|---|---|---|
| registry | `modules/registry.yaml`、`packages/contracts/src/generated/registry.ts` | 10 个条目都补齐了 `version: 1`、`lab.summary / keyMetrics / diagram / badges / experiments` 和 `billing`（不写单价）。文案取自各模块文档第 5、11 节。其他字段与各模块文档第 0 节逐项比对一致，唯一例外是 shell-access 的 `baseParams`（见第 5 节第 3 条） |
| registry:check | `scripts/registry/checks.ts` | 第 7 项“条目写完整”同时检查 MVP 模块和 `WAVE1_MODULES` |
| 配置 | `backend/src/config/schema.ts` | logging、monitoring、notification、email 的 AWS 分支按文档第 3 节收紧：栈 Outputs 写入的标识必填，其余取文档默认值。新增分段 `dns`、`tls`、`waf`、`shellAccess`、`cost`（声明型开关 + 子选项；开关取 AWS 值时检查必需键）。`identity` 分段在 `IDENTITY_POOL_ID` 非空时要求 `IDENTITY_STAGING_BUCKET`。ARN 只校验 `arn:aws…:` 前缀 |
| 已实现驱动 | `backend/src/config/implemented.ts` | `WAVE1_MODULES`、`IMPLEMENTED_MODULES`；10 个模块的 AWS 驱动标记为已实现，dns 另含本地档 external。驱动文件仍是桩时，启动后探针报“未实现”，不再报 CFG-001 |
| 容器 | `backend/src/container.ts` | 未改动。FACTORIES 已包含 `notification:sns`、`email:ses`、`monitoring:cloudwatch`、`logging:cloudwatch`、`identity-pool:cognito`、`waf:aws`，路径均已核对 |
| 感知器 | `backend/src/modules/detectors/{dns,tls,waf,shell-access,cost}.ts`、`index.ts` | 可编译的桩（`detect()` 抛 NotImplemented）已在 `DETECTORS` 中登记。只有模块启用时才会运行，L0 不受影响 |
| SDK 客户端 | `backend/src/adapters/aws/clients.ts` | 新增 `sns`、`sesv2`、`cloudwatch`、`cloudwatchLogs`、`budgets`、`costExplorer`、`cognitoIdentity`、`wafv2`、`route53`、`acm`、`ec2`，用法同前：懒加载，`{ region: 'us-east-1' }` 覆盖区域。另外提供 `withAwsRetry()`（每次尝试单独超时，只对瞬时错误重试）、`isAwsTransient()`，以及几个 wave1 服务的 NotFound 名称 |
| 探针状态机 | `backend/src/modules/capabilities.ts`、`backend/src/ports/common.ts` | 落实 2026-10-14 实机验证的教训：首次探针遇到瞬时失败（整体超时，或 `ProbeResult.transient=true`）时记为 degraded，连续 3 次失败才进入 error。确定性失败（AccessDenied 等）仍然立即报 error |
| 规则 | `backend/src/rules/rules.ts` | 本波相关的规则在规则表中都已有判定（DEP-001/002/005/006/015/018/030/040/041、SEC-003、ASG-009～014、CFG-010）。CRED-002 补了 detail：keys 模式下列出不可用的 Agent 子功能（05 组约定 2）。DEP-005 ②（集成证书挂载）属于部署范围，按 plan.ts 的约定由 scripts/module 检查（tls hook），rules.ts 不加 `deployCheck` |
| contracts | `packages/contracts` | 没有新增 ModuleId 或类型（40 个模块与 `stacks[].region / when` 的类型已经存在） |
| scripts/module 公共部分 | `scripts/module-cli/src/**` | hook 机制（第 3 节）；多栈、多区域部署（registry `stacks[].when / region`，例如 tls-edge、waf-edge 在 us-east-1）；目标模块有多个栈时，注入对每个栈分别更新；多个 `PolicyArn` 都会附加；enable 或 disable 某个模块后，如果另一个模块的条件栈因此需要增减，会提示重新执行 `enable <那个模块>`（例如先启用 tls、后启用 cdn）；baseParams 中字面量 `''` 表示“清空”；新增选项 `enable/plan --domain --zone-id --target --no-acme` 与 `disable --reopen-ssh`；`AwsService` 增加 route53、acm、wafv2、sesv2、ce、budgets、sns、logs、cloudfront（全局服务默认 us-east-1）；计划校验的占位值能通过新的 zod 校验（IDENTITY_POOL_ID、`*_ARN_*`、数字、枚举）；`SINGLE_TARGET_SETTINGS`（tls 的单模块档位 `TLS_ACME=on`，10.4）；模板缺失时给出可读的错误 |
| 档位 | `profiles/single/<id>.env`（10 个） | 由 `profile gen-single` 生成（cli.test 校验文件与生成器的输出一致） |
| 目录 | `labs/_catalog/catalog.yaml` | 只重新生成了其中的 registryVersion 摘要（`npm run labs:catalog`） |
| 依赖 | `backend/package.json`、`scripts/module-cli/package.json`、`package-lock.json` | `npm install --before=2026-09-29`：backend 新增 client-sns、sesv2、cloudwatch、cloudwatch-logs、budgets、cost-explorer、cognito-identity、wafv2、route-53、acm、ec2；module-cli 新增 client-route-53、acm、wafv2、sesv2、cost-explorer、budgets、sns、cloudwatch-logs、cloudfront。版本都是 3.1142.0，与已有客户端相同 |

### 2. 各实现者负责的文件

每个模块 `<id>` 的实现者负责下列路径，以及 `docs/implementation-notes.md` 中自己的 `## wave1-<标签>` 小节：

- `infra/modules/<id>.yaml`，以及 `infra/modules/<id>/**`（`host-setup.sh`、`nginx/*.tpl`、`systemd/50-<id>.conf`、`cwagent.json`）。主机侧片段只能使用 00-ec2-base.md 规定的扩展点，经 `infra/host/run-hostsetup.sh` 投放。
- `scripts/module-cli/src/module-hooks/<id>.ts`，测试放在 `scripts/module-cli/test/module-hooks-<id>.test.ts`。
- `experiments/<id>/**`，以及 `labs/svc-<id>/**`。
- 应用侧，按模块类型：

| 模块 | 应用侧文件（桩已存在） | 测试（建议路径） |
|---|---|---|
| notification | `backend/src/adapters/notification/sns.ts` | `backend/test/adapters/aws/notification-sns.test.ts`（契约：`backend/test/contract/email-notifier.contract.ts`） |
| email | `backend/src/adapters/email/ses.ts` | `backend/test/adapters/aws/email-ses.test.ts`（同一个契约文件） |
| monitoring | `backend/src/adapters/monitoring/cloudwatch.ts` | `backend/test/adapters/aws/monitoring-cloudwatch.test.ts` |
| logging | `backend/src/adapters/logging/cloudwatch.ts` | `backend/test/adapters/aws/logging-cloudwatch.test.ts` |
| identity-pool | `backend/src/adapters/identity-pool/cognito.ts` | `backend/test/adapters/aws/identity-pool-cognito.test.ts` |
| waf | `backend/src/adapters/waf/aws.ts`、`backend/src/modules/detectors/waf.ts` | `backend/test/adapters/aws/waf-aws.test.ts`、`backend/test/modules/detector-waf.test.ts` |
| cost / shell-access / dns / tls | `backend/src/modules/detectors/<id>.ts` | `backend/test/modules/detector-<id>.test.ts` |

- waf 同时有适配器（BlocklistPort）和感知器：capabilities 的状态取适配器的 `probe()`，感知器只提供 `observe()` / `observations()`。
- 修改共享文件（registry、schema.ts、implemented.ts、container.ts、ports、`backend/src/http/**`、`server.ts` / `worker.ts`、contracts、`scripts/module-cli` 中 `module-hooks/<id>.ts` 以外的文件、根目录 package.json）需要写进自己小节的“需要配合”，由集成阶段处理。

### 3. hook 机制（`scripts/module-cli/src/module-hooks/`）

- `types.ts` 是契约，`index.ts` 是登记表（`hookFor(id)`）。10 个模块各有一个空 hook 文件，文件头列出了文档要求的特殊步骤。MVP 模块的逻辑仍在 `hooks.ts`，不迁移。
- 调用点（enable，9.2）：
  1. `plan()`：步骤 1 运行，`scripts/module plan` 也会调用。作用是补充 settings（例如由 `--domain` 得到 TLS_DOMAIN / DNS_RECORD_NAME），打印 notes，返回未满足的人工前置 `missing`。`enable` 遇到 `missing` 时以退出码 2 结束并打印 hint；`plan` 打印 hint 后跳过该模块，退出码 0。
  2. `prepare()`：在部署栈之前运行，与 `hooks.ts` 的 `prepareModule` 是同一套契约（`p.params`、`secretParams`、`secrets`、`settings`、`remote`、`notes`），registry 的 `preflight` 检查也放在这里。
  3. `stacks()`：缺省部署 registry `stacks[]` 中 `when` 成立的栈（字符串 when 按 need 表达式求值，例如 `cdn`、`load-balancer | social-api`），区域取 registry 中的值。hook 可以给栈加参数（例如 `Scope`），也可以去掉某个栈。
  4. `afterDeploy()`：栈部署完成后、写 env 之前运行，用来做带外步骤，例如 tls 的 EAB 与 certbot、waf 首次导入 IP 集合、cost 激活标签。带外资源记入 `ctx.state.outOfBand`（可附 `region`、`detail`）。
  - disable：`beforeDisable()` 可以抛 CliError 拒绝，也可以返回 `keepBaseParams`（例如没有 `--reopen-ssh` 时保持 SshIngressCidr 关闭）；`afterDisable()` 用来清理带外资源，并提醒处理悬空 NS 委派、外部 DNS 记录等。
  - `planHints(target)`：纯函数，不访问 AWS。它的结果会出现在 `plan --start-of` 的 warnings 和 `plan --single` 的输出中，例如“需要自有域名（人工前置）”。
- 所有 AWS 调用都经 `ctx.aws.send()`。`--dry-run` 下这个调用只打印、返回 undefined，hook 要能处理 undefined（可用 `ctx.ph()` 的占位值）。`args.planOnly` 时不得创建任何资源。机密只放在 `p.secrets` 或 NoEcho 参数中。
- 本机自测：`scripts/module enable <id> --dry-run`、`scripts/module disable <id> --dry-run`、`scripts/module plan <id> --single --dry-run`、`scripts/module plan --start-of svc-<id> --no-rules`。机制本身的测试在 `scripts/module-cli/test/module-hooks.test.ts`，其中用 `setModuleHookForTest()` 临时替换 hook。

### 4. 给实现者的约定（本阶段新增）

- 探针和感知器调用控制面时，用 `withAwsRetry()` 包一层；遇到瞬时失败返回 `{ status: 'degraded', transient: true }`。无凭证时降为 observed / inferred（CRED-004），不报 error。
- us-east-1 的资源：CLOUDFRONT 范围的 WAF 与 IP 集合、tls-edge 证书、Route 53、Budgets、Cost Explorer，SDK 客户端都要传 `{ region: 'us-east-1' }`。CRED-003 的例外清单由 registry `stacks[].region` 自动生成（tls、waf），cost 另外手工列入。
- 模板的枚举型 `Env*` 输出（例如 `EnvWafScope`、`EnvDnsTargetType`、`EnvTlsAcme`）尽量写成 `!Ref 参数` 或只依赖参数的 `!If`，这样 `--dry-run` 的计划校验能得到确定的值（`staticOutputValue`）。实在做不到时，`plan.ts` 的 `ENUM_PLACEHOLDERS` 会给出一个合法的占位值。
- 同一模板部署成多个栈时（tls 的 main / edge / regional、waf 的 edge / regional），IAM 资源名要带上栈的区别（例如 `cloudalbum-${Env}-tls-${StackRole}`）。每个栈可以各自输出 `PolicyArn`，scripts/module 会全部附加。templates.test 要求每个模板只有一个 ManagedPolicy，策略名包含 `cloudalbum-${Env}-<id>`。
- shell-access 的 hook 必须显式写出 `SHELL_ACCESS_KEEP_SSH=false|true`：registry 的 `SshIngressCidr: { value: '', when: { SHELL_ACCESS_KEEP_SSH: "false" } }` 只在它为 false 时下发。
- `backend/test/helpers/config.ts` 的 `ENABLE` 中新增了 10 个模块的“已启用”片段，供规则和配置测试使用。

### 5. 设计有歧义时的取舍

1. **registry 的 `platform` 字段（06 PM-34）**：registry.schema.json 中还没有这个字段，MVP 模块也都没写，所以本波不加。平台模式的带外调用白名单由各 hook 在注释中说明，等 schema 增加该字段后统一补上。
2. **tls 徽章**：文档第 11 节把 `local` 写成嵌套对象，但前端 `badgesOf()` 只读取字符串值，并按驱动名选键。因此 registry 中写成扁平的 `selfsigned`、`letsencrypt`、`local`、`aws`、`note`。
3. **shell-access 的 baseParams**：文档写的是 `{ SshIngressCidr: '' }`，注释说明 `KEEP_SSH=true` 时不下发。这里改用条件写法 `{ value: '', when: { SHELL_ACCESS_KEEP_SSH: "false" } }`，同时 `base-params.ts` 把字面量 `''` 当作“清空”（以前空值一律被忽略）。引用求值得到的 `''`，例如 dns 没有健康检查安全组时，仍然忽略。
4. **plan 遇到缺失的人工前置**：`enable` 以退出码 2 结束；`plan`（包括 `--single`）打印 hint 后跳过，退出码 0，对应 10.4 冒烟矩阵中的“需人工”。
5. **条件栈的重新评估**：其他模块启用或禁用后，scripts/module 不会自动改动别的模块的栈，只打印“重新执行 `enable <id>`”。重新执行时会部署新选中的栈，并在注入更新完成后删除不再选中的栈，以免 ACM 拒绝删除仍在使用的证书。
6. **单模块档位 single/tls**：10.4 规定 tls 单独启用时“需域名，且 `TLS_ACME=on`”，因此 `SINGLE_TARGET_SETTINGS.tls = { TLS_ACME: 'on' }`。启用时 hook 仍会探测 ACME 端点，不可用就回退为 `TLS_ACME=off`，并带上 DEP-005 ③ 要求的依赖。
7. **首次探针的宽限**：总纲 6.3 只规定“连续 3 次失败 → error”，原实现对首次探针的任何失败都直接报 error。现在只有瞬时失败享受宽限，确定性失败照旧，现有状态机测试不受影响。

### 6. 需要集成阶段处理的事项

- 全部 wave1 模板到位后，把 `scripts/module-cli/test/helpers.ts` 的 `ALLOW_PENDING_WAVE1_TEMPLATES` 改为 false。在此之前，基于模板的测试会跳过尚不存在的 wave1 模板。
- 实现者如果需要改 registry（例如 `preflight` 名称、`internalEndpoints`、`auxQueues`），合并后要重新执行 `npm run gen:registry`、`npm run labs:catalog`；`profile gen-single <id>` 只在依赖或档位相关字段变化时需要。
- `migrate-module`（backend/src/cli.ts）仍是脚手架桩，这一点对所有模块都一样，storage 实机验证时用的也是 `--no-migrate`。notification 声明了 `migration: scripts/migrate/notification`，在迁移框架实现之前，启用时要加 `--no-migrate`。
- 各适配器桩文件头仍写着“本轮 MVP 不实现”，由各实现者在填充时更新。

### 7. 自测（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28.3.2）

| 命令 | 结果 |
|---|---|
| `npm run registry:check` | OK：40 个模块，85 条规则，52 处规则引用，2 个警告（已有的 DEP-012 豁免与 DB_ 前缀重叠） |
| `npm run build` | 通过 |
| `npm run lint` | 0 个问题 |
| `npm test` | 183 个文件（182 个通过、1 个跳过），2242 个测试通过、18 个跳过（需要外部服务）；本阶段新增 `scripts/module-cli/test/module-hooks.test.ts`，扩充规则、配置、能力状态机、SDK 客户端的测试 |
| `npm run smoke:l0` | 85 通过，0 失败 |
| `npm run smoke:selfhost` | 31 通过，0 失败 |
| `npm run labs:lint` / `labs:derive` | 56 张卡片 0 错误 0 警告 / 10 张卡片 0 错误 |

## wave1-sns-ses

第 1 波 notification（Amazon SNS）与 email（Amazon SES）两个应用适配器型模块：AWS 驱动、模板、scripts/module hook、对比实验与卡片
svc-notification / svc-email。全程没有调用真实 AWS API、没有部署任何东西（aws-sdk-client-mock、内存替身、`--dry-run`、cfn-lint）。

### 1. 完成的内容

| 范围 | 文件 | 内容 |
|---|---|---|
| notification 驱动 | `backend/src/adapters/notification/sns.ts` | `publish`：一次 Publish（MessageStructure=json：default / email 纯文本 / sqs 完整事件 JSON），消息属性 eventType、userId（admin 广播为 `*`）、audience、origin、eventId；写一行 `notification_deliveries`（channel=sns），同一 eventId 不重复发布；失败抛 503、路径段 `sns:error`，不回退逐个发信。`subscribeEmail`：`Subscribe(ReturnSubscriptionArn=true, FilterPolicyScope=MessageAttributes)`，普通用户 `{"userId":[id]}`、管理员 `{"$or":[{"userId":[id]},{"audience":["admin"]}]}`；已用不同属性订阅过时改写过滤策略；保留域名不建订阅。`unsubscribe` / `dropSubscription`。`syncSubscriptions`：pending → confirmed；订阅消失 → `email_enabled=false` + 站内信；角色变化 → 改写过滤策略。`consume({signal})`：收件队列长轮询 + 每 `NOTIFY_STATUS_SYNC_SEC` 秒同步一次（有 LockPort 时只在一台上执行）。探针见第 2 节 |
| | `notification/inbox.ts`、`sqs-poll.ts` | 收件队列消息：每个 eventId 记一行 `sqs-copy`；`origin≠ec2` 代写站内信（管理员广播按 `adminRowEventId`）；探针消息只记账；坏消息不删除（maxReceiveCount 后进 DLQ）。`sqs-poll.ts` 是 notification 收件队列与 email 反馈队列共用的长轮询循环 |
| | `notification/compare.ts`、`migrate.ts` | `/api/lab/notification/compare` 的实现函数；迁移 plan / up / down / verify（总纲 9.3，供 `migrate-module notification` 接入） |
| email 驱动 | `backend/src/adapters/email/ses.ts` | 与 outbox 同一份 MIME（`buildMime`，`X-CloudAlbum-Transport: ses`）经 `SendEmail(Content.Raw)` 发出，配置集与 `category` 标签；每封写一行 `outbox_emails`（transport=ses、provider_message_id，不存正文）。发送前：保留域名（PM-46）→ 本机 outbox + “保留域名，未发送”（`outbox:reserved`）；`email_status=bounced/complained` 的地址只发 verification / password-reset（`ses:suppressed`）；进程内按 `EMAIL_SEND_RATE_PER_SEC` 限速。失败不抛出：记 failed、`ses:rejected` / `ses:error`；`EMAIL_SANDBOX_POLICY=outbox` 时被拒的改写进本机 outbox。`consume({signal})` 长轮询反馈队列。`readBody` / `resolveEmlPath` 委托给 outbox（改写进 outbox 的邮件可预览） |
| | `email/feedback.ts`、`reserved.ts`、`compare.ts` | SES 事件（Delivery / Bounce / Complaint / Reject / DeliveryDelay）→ `delivery_status`（只升级不降级）与 `users.email_status`；保留域名判断；`/api/lab/email/compare` 的实现函数 |
| 模板 | `infra/modules/notification.yaml`、`infra/modules/email.yaml` | 见第 3 节；cfn-lint 1.57.2 零发现 |
| scripts/module | `scripts/module-cli/src/module-hooks/{notification,email}.ts` | 见第 4 节 |
| 实验 | `experiments/notification/`（fanout、filter、compare、worker-stop + seed-users / subscribe-users）、`experiments/email/`（send-matrix、compare、sandbox、register-latency） | 服务端证据：`/api/admin/notifications/deliveries`、`/api/admin/outbox`（投递状态由反馈队列更新）、Server-Timing 的 notification / email 段、管理员视图 capabilities |
| 卡片 | `labs/svc-notification/**`、`labs/svc-email/**` | lab.yaml v2（status planned → beta，1.0.0）、手册、检查、小测、徽章；labs:lint 两张卡 0 错误 0 警告，labs:derive 通过 |
| 测试 | `backend/test/adapters/aws/{notification-sns,email-ses}.test.ts`、`fake-sns.ts`；`scripts/module-cli/test/module-hooks-{notification,email}.test.ts`；`experiments/test/notification-email.test.ts` | 端口契约（`email-notifier.contract.ts`）+ 驱动细节；`fake-sns.ts` 是 SNS 的内存替身（订阅、确认、`$or` 过滤策略、按协议取文本、SQS 原始消息投递到 FakeSqs），用来验证扇出与过滤的真实行为 |

### 2. 探针（落实 2026-10-14 的教训）

- 控制面读取全部经 `withAwsRetry`（单次 3 秒超时，只对瞬时错误重试）；瞬时失败返回 `{status: 'degraded', transient: true}`，由能力注册表的状态机决定何时升级为 error；确定性失败（NotFound、AccessDenied）直接 error。
- notification：`GetTopicAttributes` + `ListSubscriptionsByTopic` + 收件队列 / 订阅级 DLQ 的 `GetQueueAttributes`。degraded：运维订阅待确认（detail 以“运维订阅待确认”开头，卡片用 `pendingIf` 等待）、收件队列未订阅、DLQ 深度 > 0、最近 5 分钟 Publish 失败。用户订阅待确认只计数，不影响状态（否则用户不点确认邮件就永远是黄色）。深度探针另读 CloudWatch 的 `NumberOfNotificationsFilteredOut / Failed / Delivered`，并发布一条 `probe=true` 的探针消息（每 60 秒最多一次；过滤策略挡住所有邮件订阅，只进收件队列）。
- email：`GetAccount` + `GetEmailIdentity` + 反馈队列 / DLQ（DLQ 由 RedrivePolicy 推出）。error：`SendingEnabled=false`、身份未验证、NotFound / AccessDenied；degraded：沙盒（detail 以“沙盒：只能发给已验证地址 · 今日已发 n / 上限 m”开头，上限取自 GetAccount）、最近 5 分钟被拒或出错、反馈 DLQ 深度 > 0、EnforcementStatus 不是 HEALTHY。深度探针向 `success@simulator.amazonses.com` 发探针邮件（每 10 分钟最多一次）。

### 3. 模板

- notification：主题（`KmsKeyArn` 非空时 SSE-KMS）、收件队列（长轮询 20 秒、SSE-SQS、RedrivePolicy → DLQ）、订阅级 DLQ、队列策略（`sns.amazonaws.com` + `aws:SourceArn` = 本主题）、收件队列订阅（原始消息传递、订阅级 RedrivePolicy）、可选运维订阅（参数 `AdminEmail`，过滤 `audience=admin`）、`AppPolicy`。Outputs：`EnvNotifyDriver/TopicArn/InboxQueueUrl/DlqUrl`、`InfoTopicArn`（registry injects → social-api）等。
- email：`SenderIdentity`（邮箱或域名二选一，用 Rules 断言；域名时 Easy DKIM RSA_2048；`MailFromDomain` 可选；`AdoptExistingIdentity=true` 时不创建）、`HostedZoneId`（dns 注入）非空时写 3 条 DKIM CNAME / MAIL FROM MX + SPF / 可选 DMARC、配置集（信誉指标、配置集级抑制 BOUNCE / COMPLAINT）、事件主题 + 主题策略（`ses.amazonaws.com`，`aws:SourceAccount` 与 `aws:SourceArn` 限定本配置集）、反馈队列 + DLQ + 队列策略 + 订阅（原始消息传递）、SNS 与 CloudWatch（`category` 维度）两个事件目标、`AppPolicy`（`ses:SendEmail` / `SendRawEmail` 只限本身份与配置集，`ses:FromAddress` 条件）。Outputs：`EnvEmailDriver/EmailFrom/SesIdentity/SesConfigurationSet/SesFeedbackQueueUrl/EmailForCognito`、`InfoIdentityArn`（registry injects → auth）、`InfoDkimRecords` 等。
- 标签：两份模板都依赖 scripts/module 的栈级标签（会传播到资源），主题与队列另带 `Name` 标签；没有承载权威数据的资源，DeletionPolicy 为 Delete（身份的 UpdateReplacePolicy 为 Retain：替换会丢失已验证状态）。

### 4. scripts/module hook

- notification：`--param AdminEmail` 可选；格式错误或保留域名 → CliError（退出码 2）；重新 enable 不带 `--param` 时沿用已部署的 AdminEmail。plan 提示人工前置 confirm-email 与“迁移尚未接入，用 `--no-migrate`”。
- email：没有 `--param Email` / `--param Domain`（或 `--domain`）→ 人工前置 ses-identity 未满足（enable 退出码 2，plan 打印 hint 后跳过）；保留域名同样视为未满足。plan 写入 `SES_IDENTITY`（与输出同值，使 `--dry-run` 的 check-config --plan 能通过）、`EMAIL_SANDBOX_POLICY`（默认 fail）、`EMAIL_SEND_RATE_PER_SEC`（默认 1）。prepare：`GetEmailIdentity` 发现身份已存在 → `AdoptExistingIdentity=true`（已部署的栈从不翻转该值）；`GetAccount` 打印沙盒提示。afterDeploy：每 15 秒轮询 `GetEmailIdentity` 直到 `VerifiedForSendingStatus=true`，超过 `--param VerifyTimeoutSec`（默认 900）以退出码 5 结束、不写 env、栈保留。disable：`EMAIL_FOR_COGNITO=on` 与只读接入身份的提示；域名身份提醒删除外部 DNS 中手动添加的 DKIM 记录。

### 5. 设计有歧义时的取舍

1. **SNS Subject 的字符集**：官方对 Subject 的字符限制以文档为准，为避免 Publish 失败，Subject 只用可打印 ASCII：标题本身是 ASCII 时保留，否则用英文事件名（例如 `CloudAlbum: New comment on your photo`），中文标题放在邮件正文第一行。
2. **用户订阅待确认不算 degraded**：文档的 degraded 判据是“管理员订阅仍为待确认”。运维订阅由“待确认的邮件订阅中，地址不属于 `notification_prefs` 记录的用户”识别。
3. **管理员过滤策略的更新**：文档要求用户进出 admin 组时调用 `SetSubscriptionAttributes`；为不改共享的管理路由，由 worker 的周期同步（`syncSubscriptions`）按当前角色校正过滤策略，最长延迟一个同步周期。
4. **收件队列的坏消息**：收件队列本身也配 RedrivePolicy（maxReceiveCount 5）指向同一个 DLQ，所以“订阅级 DLQ 深度 > 0”同时覆盖 SNS 投递失败与 worker 解析不了的消息。
5. **队列不随 kms 改用 CMK**：notification 只对主题应用 `KmsKeyArn`；两条队列保持 SSE-SQS（CMK 需要密钥策略授权 sns.amazonaws.com，否则投递静默失败，属于 kms 模块的范围）。email 不接收 `KmsKeyArn`（SES → SNS → SQS 全链路的 CMK 授权同理）。
6. **Cognito 发送授权**：CloudFormation 没有 SES 身份策略资源，且 User Pool 现行做法经服务关联角色发送（以官方文档为准），所以 `ForCognito` 只决定 `EnvEmailForCognito` 与 registry 对 auth 的 `SesIdentityArn` 注入，不建身份策略。
7. **SES 失败不抛出**：auth=local 的注册在请求内直接调用 EmailPort，抛错会让注册失败；非权威端口一律记 failed 并返回 `delivered=false`（SDK 自身的重试之外不再由队列重试）。
8. **保留域名（PM-46）只在 ses 驱动中拦截**：outbox 驱动本来就不发信，行为不变（避免改动 L0 的路径段）。
9. **register-latency** 是 Node 场景（运行器不执行 k6）；**sandbox** 是 `npm run exp` 场景（文档原写 `npx tsx … --to`）；两个 `compare` 场景也可以直接用 `npx tsx experiments/<id>/compare.ts` 运行（转交给运行器）。
10. **卡片 svc-notification 的“迁移”步骤**改用 `experiments/notification/subscribe-users.ts`（经 `PUT /api/notifications/prefs` 走同一个 `subscribeEmail`），enable 带 `--no-migrate`；卡片把 filter 拆成独立的实验步骤（lint A11：必需标签要有自己的实验步骤）。
11. **svc-email 的保留身份冲突（附录 C-12）**：由模板参数 `AdoptExistingIdentity` + hook 预检解决，卡片保留 `keepablePrerequisites: [ses-identity]`；域名身份步骤为选做，`when: learner.inputs.domain != ''`。

### 6. 需要集成阶段处理（共享文件）

- `backend/src/worker.ts`：notifier / email 驱动提供 `consume({signal})` 时在 worker 中启动（`if (typeof (c.notifier as {consume?}).consume === 'function') void c.notifier.consume({ signal })`，email 同理）。`consume` 已在 `instrument.ts` 的 UNTIMED_METHODS 中，不需要改 instrument。
- 路由（仅管理员）：`POST /api/lab/notification/compare` → `compareNotificationDrivers(deps, c.notifier)`；`POST /api/lab/email/compare {to}` → `compareEmailDrivers(deps, c.email, to)`（deps 需要 db、email、cfg、aws）。在登记之前，实验与卡片把它们当作选读，返回 404 时记 note。
- `backend/src/cli.ts` 的 `migrate-module notification up|down|verify` 接到 `adapters/notification/migrate.ts`（target 为 SnsNotifier）；接入后卡片与 hook 中的 `--no-migrate` / subscribe-users 说明可以去掉。
- `experiments/test/manifest.test.ts` 的 “exist for all 8 MVP modules” 断言模块目录恰好是 8 个 MVP 模块；新增 experiments/notification、email（以及其他 wave1 模块）后失败，需要改为包含 wave1 模块。`scripts/labs/test/{lint,derive,build}.test.ts` 假设“10 张完整卡片、46 张占位”，同理需要更新；`labs/_catalog/catalog.yaml` 需要 `npm run labs:catalog` 重新生成。
- `scripts/module-cli/test/helpers.ts` 的 `ALLOW_PENDING_WAVE1_TEMPLATES`：notification.yaml、email.yaml 已就位。
- （可选）`scripts/module-cli/src/enable.ts` 的 `previewEnv` 计算静态输出时没有传入用户参数；email 的 hook 用 `SES_IDENTITY` 设置绕过了这一点。

### 7. 自测（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28.3.2）

| 命令 | 结果 |
|---|---|
| backend / module-cli / experiments 的 `tsc --noEmit`；本模块文件的 `eslint` | 通过；0 个问题 |
| `npx vitest run`（backend 中本模块的适配器测试与契约） | notification-sns 23、email-ses 18 个测试通过 |
| `npx vitest run`（module-cli：hook 与模板） | module-hooks-notification 5、module-hooks-email 12、templates 54、templates-platform 19 个测试通过 |
| `npx vitest run test/notification-email.test.ts`（experiments） | 10 个测试通过（清单校验 + 8 个场景对 mock 服务器） |
| `cfn-lint infra/modules/notification.yaml infra/modules/email.yaml`（1.57.2） | 0 个发现 |
| `scripts/module enable/disable/plan --dry-run`、`plan --single`、`plan --start-of svc-<id>` | 均通过；email 没有身份时 enable 退出码 2、plan 跳过并给出 hint |
| `npm run labs:lint` / `labs:derive` | 两张卡 0 错误 0 警告 / derive 通过；全仓库剩余问题来自其他模块的进行中卡片与 `_catalog`（见第 6 节） |
| `npm test`（全仓库，含其他实现者的进行中改动） | 2504 通过、18 跳过、6 失败（均为第 6 节所列的数量假设：experiments manifest、labs 工具的 10 / 46 张卡片假设与 catalog） |
| `npm run smoke:l0` / `smoke:selfhost` | 85 通过 0 失败 / 31 通过 0 失败 |

## wave1-route53-acm

第 1 波模块补齐中的 dns（Amazon Route 53）与 tls（AWS Certificate Manager）。只修改了本组负责的路径；没有调用任何真实 AWS API，
`scripts/module` 只用 `--dry-run`。用户没有自有域名：两个模块都把“自有域名”当作人工前置处理，代码、模板与卡片照常完整实现。

### 1. 完成的内容

| 范围 | 文件 | 内容 |
|---|---|---|
| dns 模板 | `infra/modules/dns.yaml` | 公有托管区域（新建时 `DeletionPolicy: Retain`，或 `ExistingHostedZoneId`）；目标 `eip`（A 记录）/ `alb`、`cloudfront`（A + AAAA Alias，ALB 用注入的 `TargetHostedZoneId`，CloudFront 用固定的 `Z2FDTNDATAQYW2`）；路由策略 `simple` / `failover`（PRIMARY = EIP + 健康检查，SECONDARY = 与记录同名的 S3 网站桶）/ `weighted`（EIP + Alias 或第二个 IP）；健康检查查 `origin.<域名>`（同时建 origin 记录）；可选健康检查器安全组（`com.amazonaws.<region>.route53-healthchecks` 前缀列表，`InfoHealthCheckSecurityGroupId` 经 baseParams 追加）。Outputs：`EnvAppBaseUrl`（`AppScheme` 由 hook 决定 http/https）、`EnvDnsHostedZoneId`、`EnvDnsRecordName`、`EnvDnsTargetType`、`EnvDnsTtl`、`EnvDnsRoutingPolicy`、`EnvDnsHealthCheckId`、`EnvDnsTargetIp`、`Info*`；PolicyArn 只读（GetHostedZone / ListResourceRecordSets 限定本区域，GetHealthCheckStatus） |
| dns 主机侧 | `infra/modules/dns/nginx/dns-canonical.conf.tpl`、`infra/modules/dns/host-setup.sh` | `DNS_CANONICAL_REDIRECT=on` 时 IP / EC2 主机名访问 301 到 `APP_BASE_URL`；`/api/health/*`、ACME HTTP-01、`/_ca/`、回环地址不跳转（变量 `$ca_dns_canonical`，只放 `cloudalbum.server.d/`）。hostSetup 校验填进 Nginx 的值，并写 `/var/lib/cloudalbum/dns/state.json` |
| tls 模板 | `infra/modules/tls.yaml` | 一个模板三个栈（`StackRole=main|edge|regional`，由 hook 按 registry 栈名传入）：main = `AWS::CertificateManager::AcmeEndpoint`（PRE_APPROVED，EC_prime256v1 / RSA_2048，CertificateTags）+ `AcmeDomainValidation`（ExactDomain，`HostedZoneId` 有值时自动建 CNAME）+ EAB 签发角色 `cloudalbum-<env>-acme-issuer`（信任 `acm-acme.amazonaws.com`，`acm:RequestCertificate` 用 `acm:DomainNames` 限定 TLS_DOMAIN，支持 PermissionsBoundaryArn）；edge / regional = DNS 验证的集成证书（edge 有 `AWS::Region = us-east-1` 的 Rules 断言）。每个栈各自一个 `cloudalbum-<env>-tls-<StackRole>` 只读策略。另输出 `InfoEdgeAliases` / `InfoRegionalDomainName`（见第 4 节） |
| tls 主机侧 | `infra/modules/tls/host-setup.sh` | `/opt/certbot` 虚拟环境（pip，失败时回退 dnf；回放时装不上不影响启动）；按 `TLS_MODE` / `TLS_ACME` 切换 `/etc/cloudalbum/tls/server.*` 符号链接（ACME lineage `cloudalbum-acm`，本地档 Let's Encrypt `cloudalbum-le`）；certbot 目录都在数据卷（`/etc/cloudalbum/letsencrypt`、`/var/lib/cloudalbum/certbot/work`、`/var/lib/cloudalbum/logs/certbot`）；子命令 `issue-acme`（EAB 注册 + 签发，`--issuance-timeout 120`，EAB 只经环境变量或 SecureString 参数传入）、`renew`（定时器入口，写 `/var/lib/cloudalbum/tls/renew-status.json`）、`deploy-hook`、`renew-drill`、`revoke-acme`、`purge-acme`、`status`；`TLS_FORCE_HTTPS=true` 且 Nginx 已是受信证书时投放 80→443 跳转（只用 ec2 的 `$ca_https_redirect`）与 HSTS（`TLS_HSTS_MAX_AGE`，回环不输出） |
| 感知器 | `backend/src/modules/detectors/{dns,tls}.ts` | dns：被动统计 Host（记录名 / IP / EC2 主机名）；`Resolver.resolve4(…, {ttl:true})` 与目标比较（eip = IMDS `public-ipv4`，缺省 `DNS_TARGET_IP`；alb = `LB_DNS_NAME` 的地址；cloudfront = PTR 落在 `*.cloudfront.net` 或与分配域名相交）；NXDOMAIN 持续超过 max(TTL, 60 s) 才 error；解析器超时 / SERVFAIL = degraded + transient；deep：GetHostedZone（不存在 = error）、委派 NS 核对、ListResourceRecordSets、GetHealthCheckStatus（us-east-1，经 `withAwsRetry`）。tls：对 direct / cdn / alb / 有效入口 URL 握手（每次 1.5 s 超时，结果缓存 300 s，deep 重测），签发者、SAN、剩余天数、协议、ALPN、链校验；ACME 下直连不是 Amazon = degraded；过期 / 域名不匹配 = error；网络类握手失败带 transient；续期窗口（短期证书寿命 1/3 - 2 天，集成证书 30 天）；`renew-status.json` 失败 = degraded；deep：DescribeCertificate（edge 在 us-east-1）、SearchCertificates（CertificateKeyPairOrigin=ACME）；`data.via` / `data.trusted` 给出观测到的终止点 |
| hook | `scripts/module-cli/src/module-hooks/{dns,tls}.ts` | 见第 2 节 |
| 实验 | `experiments/dns/**`、`experiments/tls/**` | dns：ip-change-drill（`faults/reassociate-eip.sh` 在运行器所在机器上用部署者身份 swap / restore 临时 EIP，after 另 UPSERT 记录）、failover-drill（stop/start-nginx）、weighted-sample（直查权威 NS）；tls：inspect、handshake、cipher-scan（nmap ssl-enum-ciphers 解析）、renew-drill（hostSetup `renew-drill --force`，轮询直连证书序列号）。全部附服务端证据（`/api/lab/echo` 的 Host、dns / tls 感知器数据、`capabilities.https`） |
| 卡片 | `labs/svc-dns/**`、`labs/svc-tls/**` | `status: beta`、1.0.0：lab.yaml v2、手册、检查、小测、徽章；svc-tls 含回退变体 `acme-off`（起始状态 iam + cdn，部署等级 B） |
| 测试 | `backend/test/modules/detector-{dns,tls}.test.ts`、`scripts/module-cli/test/module-hooks-{dns,tls}.test.ts`、`experiments/test/dns-tls.test.ts` | aws-sdk-client-mock（Route 53、ACM）、注入的解析器与握手；hook 全部在 dry-run / 脚本化网关上运行 |

### 2. hook 的行为

- **没有域名**：dns / tls 的 `plan()` 返回 `missing: [{ prerequisite: 'domain' }]`，`enable` 在部署任何东西之前以退出码 2 结束并打印
  `scripts/module enable <id> --domain album.example.com …` 与“没有域名时跳过本模块”；`plan`（含 `--single`）打印后跳过，退出码 0。
  `planHints()` 只在目标没有写出域名时给出提示（卡片的 `targetModules[].set` 写了 `learner.inputs.domain`，见第 3 节第 4 条）。
  IP、`*.amazonaws.com`、`*.cloudfront.net` 与保留顶级域直接拒绝（`DOMAIN_INVALID`）。
- **dns**：`--zone-id` 经 GetHostedZone 核对（私有区域、不包含该域名都拒绝）；目标自动选择 cdn + tls → cloudfront、load-balancer → alb、否则 eip
  （只有 cdn 没有 tls 时选 eip 并说明 DEP-041）；`RoutingPolicy=failover` 自动开启健康检查；新建托管区域时打印 NS 并轮询公共解析器
  （`--param DelegationWaitMin`，默认 15，超时只告警）；禁用时新建的托管区域保留（Retain，按月计费）并记入 `outOfBand`，下次 enable 自动复用
  （NS 不变），`--param PurgeHostedZone=true` 删除；提醒删除注册商处的 NS 委派（平台模式另记一条 `dangling-delegation` 安全项）。tls 的验证记录
  还在本托管区域时拒绝禁用（`DNS_IN_USE`，文档第 6 节“被 tls 依赖的验证 CNAME 阻止删除”；`--param Force=true` 覆盖），否则 tls 栈会以空的
  `HostedZoneId` 更新并替换域验证与证书（create-only 属性）。本地档
  `--driver external --domain x` 只写 `APP_BASE_URL=http://x`。
- **tls**：preflight `acme-endpoint` = 部署者身份的 `acm:ListAcmeEndpoints`（只读，`plan` 也调用）；成功 → `TLS_ACME=on`，失败 → off 并按 DEP-005 ③
  检查依赖；`--no-acme` 不探测；`--dry-run` 不调用 AWS，按 on 计划并说明。`stacks()` 给每个栈传 `StackRole`；main 部署后：
  DescribeAcmeDomainValidation 打印验证 CNAME（没有托管区域时由学员添加）→ 等待 VALID（`--param ValidationWaitMin`，默认 30；超时 /
  INVALID 时给出“添加后重跑”的提示，重跑时栈不变）→ 1 天 EAB（RoleArn = 签发角色）→ 实例上 `host-setup.sh issue-acme`
  （ssh：EAB 只在 stdin 脚本里并注册为机密；SSM：`/cloudalbum/<env>/handoff/tls-eab-*` SecureString，结束即删）→ 删除 EAB →
  SearchCertificates 记录证书 ARN。`TLS_FORCE_HTTPS=true` 与 `TLS_ACME=off` 同时出现直接拒绝（直连仍是自签名）。禁用：`--param RevokeAcme=true`
  先 `certbot revoke`；栈删除后 `purge-acme` 删除本端点的 lineage 与 ACME 账户；清理 `outOfBand` 的 tls 记录，提醒删除外部 DNS 中的 CNAME。

### 3. 设计有歧义时的取舍

1. **续期定时器单元的归属**：`cloudalbum-tls-renew.{service,timer}` 已由 ec2 的 install-host-files.sh 为预览方案 B 安装（指向 tls-preview.sh）。
   tls 的 hostSetup 不改 ec2 的文件，改为写 drop-in `cloudalbum-tls-renew.service.d/50-tls.conf` 把 `ExecStart` 指向自己的 `renew`
   （方案 B 时再转交 tls-preview.sh renew）；单元不存在（旧发布包）时自己写出两个单元。
2. **ACME 证书的续期窗口**：45 天证书在 renewal conf 中写 `renew_before_expiry = 15 days`（寿命的 1/3）；感知器按同一窗口判断“到期未续”。
3. **签发角色多一个 `acm:AddTagsToCertificate`**：端点带 CertificateTags，申请时打标签需要该权限（以官方文档为准）；仍限定本账号本区域的证书。
4. **卡片里的域名**：`targetModules[].set` 写 `DNS_RECORD_NAME` / `TLS_DOMAIN: '{{ learner.inputs.domain }}'`。这样 DEP-005 ① 在推导时由学员的前置输入满足，
   `plan --start-of` 不会产生自由文本警告（labs:derive 的 DRV-6 把每条警告都当作规则 ID）。
5. **svc-tls 的回退变体**：DEP-005 ③ 的两条 need 都属于同一规则 ID，`branches` 无法分别选择（选 cdn 会把 dns 那一步判为“选错分支”而不收敛）。
   变体的 `targetModules` 另含 `dns`（本地档 external，学员在第 2 步启用），闭包因此只加 cdn，与卡片设计一致。
6. **托管区域保留**：模块文档要求默认保留（避免重新委派），模板用 `DeletionPolicy: Retain`，hook 记录并在下次复用；`--purge` 尚未传给 hook，
   先用 `--param PurgeHostedZone=true`。
7. **健康检查对象**：按模块文档检查 `origin.<域名>`（A → EIP，不参与故障转移），模板同时建 origin 记录，避免健康检查跟着故障转移切走。

### 4. 偏离设计之处

- 卡片 svc-dns 第 3 步的“`LOCAL dns-resolve`（域名）”改为管理员视图的 capability 检查（dns 感知器 `data.resolution.answers` 含 EIP）；svc-tls 直连证书的
  `tls-handshake` 不带 `servername`。原因：`labs:lint` 校验本机检查参数时把 `{{ … }}` 替换成不带点的样本值，`host` / `servername` 的主机名正则必然失败。
- svc-dns 的归属证据用本会话 dns 栈（DescribeStacks + ownership），对新建与已有托管区域两种做法都成立；Route 53 记录没有 ARN，不能带 ownership。
- `scripts/tls/letsencrypt.sh`、`/opt/cloudalbum/scripts/tls/deploy-hook.sh`（模块文档第 1 节）合并进 `infra/modules/tls/host-setup.sh` 的子命令
  （本组负责的路径）；本地档 letsencrypt 的签发在 hostSetup apply 中按需执行。
- 报价：`labs/_pricing/dimensions.yaml` 没有 ACM ACME 的计费维度（`tls: []`），svc-tls 的 cost.basis 只写起始状态与工作台，假设中说明。

### 5. 需要集成阶段处理（共享文件）

1. `modules/registry.yaml` tls 的 injects：`cdn.Aliases` 改为 `"${Out.InfoEdgeAliases}"`、`load-balancer.DomainName` 改为 `"${Out.InfoRegionalDomainName}"`。
   现在的 `${TLS_DOMAIN}` 在没有 edge 栈时也会注入，cdn 模板的 `AliasNeedsCertificate` 规则会让“先 tls（ACME）、后 cdn”的 cdn 部署失败。改后 `npm run gen:registry`、`labs:catalog`。
2. `experiments/test/manifest.test.ts`：“exist for all 8 MVP modules” 用 `toEqual(MVP)`，第 1 波任何模块加了 `experiments/<id>/experiment.json` 都会失败；
   建议改为“包含 MVP，且每个目录都在 IMPLEMENTED_MODULES 中”，并把第 1 波模块并入逐模块清单校验（本组另有 `experiments/test/dns-tls.test.ts`）。
3. `scripts/labs/src/registry.ts` 的 `replaceTemplates`：样本值改成带点的主机名（例如 `x0a1b2c3d4.example.com`），`dns-resolve` / `tls-handshake` 的参数才能写变量。
4. `scripts/labs/src/derive/index.ts` DRV-6：只比较形如规则 ID 的警告；hook 的 `planHints` 自由文本会被当作“不在 expectedWarnings 中的规则”。
5. `labs/_catalog/catalog.yaml` 需要 `npm run labs:catalog`（两张卡片从 planned 变为 beta）；`labs/_pricing/dimensions.yaml` 增加 ACM ACME 证书的计费维度。
   `scripts/labs/test/{derive,lint,build}.test.ts` 写死了“10 张完整卡片”与 catalog 为最新，第 1 波卡片改为可开始后需要同步更新。
6. `backend/src/container.ts`：tls 感知器的 `data.via` / `data.trusted` 是观测结果，可以在探针后调用 `CapabilityRegistry.setHttps()` 覆盖配置推断的 `https`。
7. `disable --purge` 传入 `HookArgs`（dns 的托管区域删除现在用 `--param PurgeHostedZone=true`）。
8. `scripts/module-cli/test/helpers.ts`：两个模板已就位（ALLOW_PENDING_WAVE1_TEMPLATES 由集成阶段统一改）。

### 6. 自测（2026-10-14，Windows 11 / Node 22.14.0；没有调用 AWS）

| 命令 | 结果 |
|---|---|
| `cfn-lint --regions ap-northeast-1 us-east-1 -- infra/modules/{dns,tls}.yaml`（1.57.2，D 盘 venv） | 0 发现（dns 的 VpcId 默认空导致的 W1030 以资源级 Metadata 忽略并写明理由） |
| `npx tsc -p backend/tsconfig.json --noEmit`、`npx tsc -p scripts/module-cli/tsconfig.json --noEmit`、`npx tsc -p experiments/tsconfig.test.json` | 通过 |
| `npx eslint`（本组文件） | 0 个问题 |
| `vitest`：detector-dns（11）、detector-tls（13）、module-hooks-dns（12）、module-hooks-tls（8）、dns-tls 实验（10）、templates / templates-platform | 全部通过 |
| `scripts/module enable|plan dns|tls --dry-run`（无域名） | enable 退出码 2 + 提示；plan / plan --single 打印提示后跳过，退出码 0 |
| `scripts/module enable dns --domain album.example.com --dry-run`、`enable tls --domain … --dry-run`、`plan --single`、`plan --start-of svc-dns|svc-tls [--variant acme-off] --no-rules` | 通过；tls 回退变体起始状态 = iam + cdn（DEP-005） |
| `npm run labs:lint` / `labs:derive --card svc-dns,svc-tls`（scripts/module 用源码，`ATL_LABS_PLAN_CMD`） | 两张卡片 0 错误 0 警告（其他实现者进行中的卡片与 `_catalog` 的 C-2 不属于本组） |
| `bash -n infra/modules/{dns,tls}/host-setup.sh`、`experiments/*/faults/*.sh` | 通过；本机与现有镜像都没有 jq，未在容器内实际运行 hostSetup |
| `scripts/module disable dns|tls --dry-run`（scratchpad 中的模拟 state.json） | 通过；tls 的验证记录在托管区域中时 disable dns 以 `DNS_IN_USE` 拒绝 |
| `npm run build` | 通过 |
| `npm test` | 只有共享测试失败：experiments/test/manifest.test.ts（列表写死 8 个 MVP 模块）、scripts/labs 的 derive / lint / build 测试（写死 10 张完整卡片与 catalog）——第 1 波各模块新增实验目录、卡片改为可开始所致，见第 5 节 |
| `npm run smoke:l0` / `smoke:selfhost` | 85 通过 0 失败 / 31 通过 0 失败 |

## wave1-logs-ssm

第 1 波：logging（CloudWatch Logs）与 shell-access（SSM Session Manager）。设计依据 05-ops-observability.md#logging、#shell-access，
卡片依据 cards/service-cards-3 的 svc-logging、svc-shell-access。全程没有调用真实 AWS API；scripts/module 只用 `--dry-run`。

### 1. 实现内容

| 范围 | 文件 | 内容 |
|---|---|---|
| logging 写入侧 | `backend/src/adapters/logging/cloudwatch.ts`、`cw-sender.ts`、`nginx-tail.ts`、`file.ts` | `CwLogger` 继承 `FileLogger`：本地文件照写；`file.ts` 新增 `tee()` 钩子，pino multistream 把与文件逐字节相同的 JSON 行交给进程内发送器。发送器：每 `LOG_CW_FLUSH_MS` 或满约 1 MiB / 5000 条发一批（批内按时间排序、跨度小于 23 小时、单条截断到 256 KiB）；第一次发送前 `CreateLogStream`（已存在则忽略），日志流 `{instanceId}/{role}`（实例身份在发送时求值）；失败按 1～60 秒指数退避；积压超过 `LOG_CW_MAX_BACKLOG` 时丢弃最旧的并计入 dropped，`rejectedLogEventsInfo` 也计入 dropped；在途期间按序号出队。worker 进程另外增量读取 `nginx-access.json`（inode 轮转时先读完 `.1`，被截断时从头读，不完整的行留到下一轮，事件时间取行内 `ts`），转发到 `LOG_CW_GROUP_NGINX` 的 `{instanceId}/access`。`LOG_CW_SHIPPER=agent` 时不启动发送器 |
| logging 探针 | 同上 | 常规探针不调用 AWS，只看发送器状态：日志组不存在、连续 2 次 AccessDenied → error；发送失败、自上次探针有丢弃、积压接近上限、有积压且 2 分钟没有成功 → degraded（瞬时失败带 `transient`）。深度探针先写 canary（`logging.canary`），用 `FilterLogEvents` 查到后以 `ingestionTime − timestamp` 记摄取延迟；2.5 秒内查不到就在后台继续（最多 90 秒），结果写进以后的 detail；再用 `DescribeLogStreams` 数最近 24 小时的实例数（`data.instances`，即徽章的 `{instances}`）。agent 方式：keys 模式 → error；缓存的 `DescribeLogStreams`（后台刷新，60 秒）与本地文件修改时间比较，文件比摄取新 2 分钟以上 → degraded |
| logging 只读侧 | `backend/src/adapters/logging/readers.ts`、`lab-routes.ts` | `FileLogReader`：倒序扫描当前文件与 `.1`，扫描上限 50 MiB，返回 `truncated`。`CwLogReader`：requestId、traceId 与关键字走 `FilterLogEvents`（应用行用 `requestId`，Nginx 行用 `rid`），Insights 语句走 `StartQuery`，`results()` 取 `statistics.bytesScanned`；行带 `eventTs` 与 `ingestedAt`。`GET /api/lab/logs` 与 `GET /api/lab/logs/results/:queryId`（仅管理员）的路由模块与 monitoring 的 `lab-routes.ts` 形状相同，**尚未挂载**（第 4 节） |
| shell-access 感知器 | `backend/src/modules/detectors/shell-access.ts` | ssh：读安全快照的 `sshd` 段（未监听 → error；快照超过 5 分钟 → inferred + degraded）。ssm：从 IMDS 取实例 ID 与安全组，在后台刷新（55 秒有效；常规探针最多等 1.5 秒，深度 2.5 秒）`DescribeInstanceInformation`、`DescribeSecurityGroups`（覆盖 22 的规则，含协议 -1）、`GetDocument SSM-SessionManagerRunShell`；还没有结果 → degraded + transient；AccessDenied 或非 Online → error；22 仍开放、会话首选项的日志组不是本模块的或文档不存在 → degraded；ok 时 detail 含“无管理端口入站”。深度探针并行查 `DescribeSessions`（排除 `ATL-SessionShell*` 与 `atl-<sid>-term-*`）和会话日志流。`observations().port22Open` 是 SEC-003 的输入 |
| 模板 | `infra/modules/logging.yaml`、`infra/modules/shell-access.yaml` | logging：两个日志组（Retain、STANDARD、保留期参数、可选 KMS、`DataClass=logs` 标签）、指标过滤器 AppErrors、AuthLoginFailed、Nginx5xx（命名空间 `CloudAlbum/Logs`）、4 条 QueryDefinition、一条托管策略；Outputs 有 `EnvLogDriver`、`EnvLogCwShipper`（`!Ref Shipper`）、`EnvLogCwGroupApp`、`EnvLogCwGroupNginx`、`EnvLogCwRetentionDays`、`InfoMetricNamespace`（注入 monitoring 的来源）。shell-access：会话日志组（Retain）与一条托管策略（Agent 核心权限受 `ManagedCore` 条件控制、会话日志写入、DescribeLogGroups 与 DescribeLogStreams 用 `*`、感知器只读、可选 KMS）；Outputs 有 `EnvShellAccessMode`、`EnvSsmSessionLogGroup`、`EnvSsmSessionRunAs`。两个模板都有 `CreateLogGroup(s)` 参数，用于复用保留的日志组。cfn-lint 1.57.2 零发现 |
| 主机侧 | `infra/modules/logging/{cwagent.json,host-setup.sh}`、`infra/modules/shell-access/{host-setup.sh,session-preferences.json,operator-policy.json}` | logging：sdk 方式什么也不装（并移除残留的 agent 片段）；agent 方式拒绝 keys 模式，按需 `dnf install amazon-cloudwatch-agent`，把片段渲染为 `/opt/aws/amazon-cloudwatch-agent/etc/cloudalbum-logging.json` 后 `append-config`；revert 时还有其他片段就 `remove-config -s`，移除最后一个片段后 `-a stop`。shell-access：创建 `cloudalbum-*` 系统用户与 `/etc/sudoers.d/40-cloudalbum-ops`（`visudo -cf` 校验后安装；只读命令带 NOEXEC，防止 pager 逃逸；restart 只列出具体单元，不用通配），revert 时删除。两个脚本都在本机 AL2023 容器中用桩（visudo、agent-ctl）跑过 apply、revert、重复执行与拒绝分支 |
| scripts/module hook | `scripts/module-cli/src/module-hooks/{logging,shell-access}.ts` | 见第 2 节 |
| 对比实验 | `experiments/logging/**`、`experiments/shell-access/**` | logging：`ingest-lag`、`query-compare`、`instance-loss`、`overhead` 是 node 场景，`debug-volume` 是手工实验（`faults/log-level.sh`）；服务端证据都经 `/api/lab/logs` 取得。shell-access：`probe-port`、`session-audit` 是 node 场景（控制面证据经工作台 AWS CLI 只读调用），`ssh-noise`、`private-subnet` 是手工实验 |
| 卡片 | `labs/svc-logging/**`、`labs/svc-shell-access/**` | lab.yaml v2（status beta，1.0.0）、手册、检查、小测与徽章；与卡片文档的差异写在各自 lab.yaml 的文件头 |
| 测试 | `backend/test/adapters/aws/{logging-cloudwatch.test.ts,fake-cwlogs.ts}`、`backend/test/modules/detector-shell-access.test.ts`、`backend/test/http/lab-logs.test.ts`、`scripts/module-cli/test/module-hooks-{logging,shell-access}.test.ts`、`experiments/test/logs-ssm.test.ts` | LoggerPort 契约（cloudwatch）与内存 CloudWatch Logs（aws-sdk-client-mock）；感知器（桩 IMDS + mock SDK）；路由（supertest）；hook（dry-run 全流程与桩网关）；实验场景（伪造上下文与 AWS CLI） |

### 2. scripts/module hook

- **logging**：`plan` 总是写出 `LOG_CW_SHIPPER`（优先级：`--param Shipper`、`--set LOG_CW_SHIPPER`、当前值、sdk）；`Shipper=agent` 遇到 keys 模式以退出码 2 拒绝（`DEP-AGENT-ROLE`）。`prepare` 发现 `/cloudalbum/<env>/app` 与 `/nginx` 都已存在（上次 disable 保留下来的）时传 `CreateLogGroups=false` 复用；只存在一个时拒绝，并给出删除命令。disable 时提示保留的日志组与删除命令。
- **shell-access 的 enable（防锁死顺序）**：`plan` 总是写出 `SHELL_ACCESS_KEEP_SSH`（`--param KeepSsh=true` 或 `--set`）。`prepare` 做 preflight `policy-quota`（ListAttachedRolePolicies，平台策略不计）与 `ssm-session-preferences`（只读），并复用保留的会话日志组。`afterDeploy` 在第 4b 步清空 `SshIngressCidr` 之前执行：① 先把 `PolicyArn` 附加到 CloudAlbumAppRole 并记入 `state.attachments`（第 5 步因此不再重复附加）；`--param ManagedCore=true` 时另外附加 `AmazonSSMManagedInstanceCore`（记为带外资源，平台模式不做）。② 独立模式下经**当前的 ssh 通道**重启 `amazon-ssm-agent`；这里单独构造 SshDeliverer，不用 `ctx.deliverer()`，因为它会被缓存，而同一次运行的第 7 步必须走 SSM。③ 轮询 `PingStatus=Online`（最多 5 分钟），再用 Run Command 冒烟（`id; systemctl is-active cloudalbum-api`）；失败时分离已附加的策略并以退出码 5 中止，22 端口不变。④ 备份并写入 `SSM-SessionManagerRunShell`：已存在则 UpdateDocument `$LATEST` 再 UpdateDocumentDefaultVersion，不存在则 CreateDocument（类型 Session）；kms 注入了 `KmsKeyArn` 时打开 `cloudWatchEncryptionEnabled` 并写 `kmsKeyId`。第一次修改之前的状态记入 `outOfBand`（`previousDefaultVersion`、`existed`）。之后由通用流程关闭 22 端口、经 SSM 投递 hostSetup（创建 `cloudalbum-ops`）并重启。
- **shell-access 的 disable**：独立模式下 22 已经关闭又没有 `--reopen-ssh` → 拒绝，因为分离策略之后不会剩下任何运维通道。`--reopen-ssh` 先把 `SshIngressCidr` 恢复为记录的原值（运维 IP 变了用 `--param SshIngressCidr=<ip>/32`；不接受 `0.0.0.0/0`），**先用 ssh 验证**：失败就重新关闭 22 并中止，模块仍启用、SSM 通道保留；成功后还原会话首选项（默认版本改回原值；原本不存在则删除），再走通用流程。`afterDisable` 分离 hook 附加的托管策略，删除只由本模块贡献的 `baseParams` 记录，把投递通道改回 ssh。平台模式下 SSM 通道与本模块无关：不带 `--reopen-ssh` 时 22 保持关闭（`keepBaseParams`）。
- **会话首选项的备份**：独立模式写在 state.json 旁边的 `backup/` 目录（默认 `.cloudalbum/backup/`）；平台模式写到状态桶 `<envName>/backups/ssm-document-SSM-SessionManagerRunShell-<UTC>.json`，内容是 PM-27 的 `{existed, defaultVersion, content}`。两种模式都登记到 `state.backups`。
- **测试接缝**：`shellAccessDeps`（ssh / SSM 投递、时钟、等待）。

### 3. 设计有歧义时的取舍

1. **LogReader 的细化类型放在适配器目录**（`readers.ts`）：ports 是共享文件，总纲的 `LogReader` 形状不变，细化只追加字段。
2. **/api/lab/logs 的路由放在 `adapters/logging/lab-routes.ts`**，由集成阶段挂载，与 monitoring 的做法相同。对比实验只经这个端点取服务端证据，工作台不需要 `logs:*` 权限。
3. **Nginx 访问日志由 logging 自带的读取器转发**（在 worker 进程中），不改 worker 的源站卸载统计（共享代码），两者各读一次同一个文件。读取器启动时从文件末尾开始，不回填。
4. **应用不按请求写日志行，error5xx 故障也不写应用日志**：查询对比、摄取延迟与卡片第 5 步都基于 Nginx 访问日志（`run` 字段圈定本次实验，`rid` 就是 `X-CloudAlbum-Request-Id`）。保存的查询相应改为 Nginx 组上的“按路由统计 5xx”“按路由统计 p95（`rt`）”“缓存命中（`path`）”，以及两组联合的“单个请求”；卡片第 5 步看 `Nginx5xx`，不看 `AppErrors`。
5. **保留的日志组与再次 enable**：日志组是 Retain，同名重建会失败，所以 hook 先探测，存在时传 `CreateLogGroups=false` 复用（保留期与加密维持原样）。`--purge` 仍未实现，disable 只打印删除命令。
6. **CloudWatch Agent 片段的合并**：片段只含 `logs.logs_collected.files`（不写 `agent` 段，也不写 logs 的其他顶层键），渲染后的文件名唯一（`cloudalbum-logging.json`，Agent 内部保存为 `file_cloudalbum-logging.json`）。`append-config` 以文件名区分片段，如果两个模块都叫 `cwagent.json` 会互相覆盖。monitoring 的实现（`cloudalbum-monitoring.json`）与此兼容。registry 的 `cwAgentFragment` 指向的是带 `${LOG_CW_GROUP_*}` 占位符的模板。
7. **PM-M29（Agent 日志组前缀）**：Agent 写入的是栈创建的 `/cloudalbum/<env>/…` 日志组，不会自己建组，所以不产生“派生日志组”，名称沿用模块文档的写法。
8. **运维者策略不由栈创建**：9.1 与 templates.test 要求每个模块栈只有一条托管策略，所以 `OperatorPolicy` 改为随发布包提供的策略文档 `infra/modules/shell-access/operator-policy.json`（占位符 `${Region}`、`${AccountId}`），栈输出 `InfoOperatorPolicyDocument`。
9. **`--keep-ssh` 与 `--managed-core`**：HookArgs 没有这两个选项，改用 `--param KeepSsh=true`（只给 hook 看，不是栈参数）与栈参数 `--param ManagedCore=true`。`--stop-sshd` 没有实现（默认保留 sshd，便于回滚）。
10. **探针预算**：常规探针 2 秒，深度探针 5 秒（`cli probe --deep` 也是 5 秒）。两个模块的控制面读取都按这个预算设置单次超时与重试，并在后台刷新，避免“首个请求慢就报 error”（2026-10-14 的教训）。
11. **probe-port 的私网目标**：`--param target=private-ip` 由运行器用 `aws ec2 describe-instances` 查私网地址；安全组的 22 端口规则（`describe-security-group-rules`）是服务端证据。`session-audit` 同样经工作台 AWS CLI 只读调用（实验包不含 AWS SDK，并行阶段也不安装依赖）。
12. **安全快照没有 `sshd.effective`**：00 的快照脚本目前只写 `listening`、`failures24h`、`recentLogins`，感知器把 `effective` 当作可选字段。
13. **debug-volume 是手工实验**：本版应用在请求路径上几乎不写 debug 日志，自动化的摄取量对比没有意义；README 写明了步骤和这一点。

### 4. 需要集成阶段处理

- `backend/src/http/app.ts`：把 `adapters/logging/lab-routes.ts` 的 `register(app, c)` 加入 `ROUTE_MODULES`（先于 `routes/lab.ts`）。experiments/logging 的四个 node 场景与卡片的对比实验都依赖 `GET /api/lab/logs`。
- （可选）`container.close()` 目前只调 `loggerPort.flush()`；如果要停掉发送器与读取器的定时器，可以改为调用 `loggerPort.close?.()`。这些定时器都已 unref，不影响进程退出。
- `experiments/test/manifest.test.ts` 的“exist for all 8 MVP modules”需要接受第 1 波的实验目录。
- `scripts/labs/test`：
  - “10 张完整卡片 / 46 个占位”的数量假设需要更新；
  - `labs/_catalog/catalog.yaml` 需要重新生成（`npm run labs:catalog`，对应 lint C-2）；
  - labs:build 的参考推导器不读取单服务卡片声明的 `kind: runtime` 预置，svc-logging 与 svc-monitoring 因此报 DRV-1。scripts/module 的 `plan --start-of` 会读取，所以 labs:derive 只给出 DRV-10 的摘要差异警告。二选一：在 registry 的 logging、monitoring 条目加 `singleRuntime: { featureFlags.lab.faults: true }`，或让 `scripts/labs/src/derive/reference.ts` 对 service 卡片也接受声明的 runtime 项。
- 把 `ALLOW_PENDING_WAVE1_TEMPLATES` 改为 false（本组两个模板已经就位）。
- 发布包：`scripts/release` 已按 `experiments/<module>/{lab,faults}/*.sh` 打包，`experiments/logging/faults/log-level.sh` 会自动带上。

### 5. 自测（2026-10-14，Windows 11 / Node 22.14 / Docker 28）

| 命令 | 结果 |
|---|---|
| `npm run build` / `npm run lint` / `npm run registry:check` | 通过 / 0 个问题 / OK |
| backend、module-cli、experiments 的 vitest（含本组新增的 5 个测试文件，约 70 个用例） | 只有 `experiments/test/manifest.test.ts` 的 MVP 数量假设失败（第 4 节）；scripts/labs 另有 4 个数量、catalog 与参考推导器相关的失败（第 4 节） |
| `npm run smoke:l0` / `smoke:selfhost` | 85 通过 0 失败 / 31 通过 0 失败 |
| `cfn-lint infra/modules/logging.yaml infra/modules/shell-access.yaml`（1.57.2） | 0 个发现 |
| `scripts/module enable logging` 与 `enable shell-access`（`--dry-run --with-deps`）、`plan <id> --single --dry-run`、`plan --start-of svc-logging` 与 `svc-shell-access`（`--no-rules`）、`disable … --dry-run`（含预置 state.json 与 `--reopen-ssh`） | 全部退出码 0；shell-access 不带 `--reopen-ssh` 的 disable 按设计以退出码 2 拒绝 |
| `npm run labs:lint` / `labs:derive` | 两张卡 0 错误 0 警告 / svc-shell-access 通过，svc-logging 只有 DRV-10 摘要差异警告（第 4 节）；全仓库的其余问题来自其他模块的进行中卡片与 `_catalog` |

## wave1-cw-budgets

第 1 波：monitoring（Amazon CloudWatch：自定义指标、告警、仪表板）与 cost（AWS Budgets + Cost Explorer）。设计依据
05-ops-observability.md#monitoring、06-governance-cost.md#cost，卡片依据 cards/service-cards-3 的 svc-monitoring、svc-cost。
全程没有调用真实 AWS API；scripts/module 只用 `--dry-run`；没有安装任何依赖；没有编造任何价格。

### 1. 实现内容

| 范围 | 文件 | 内容 |
|---|---|---|
| monitoring 写入侧 | `backend/src/adapters/monitoring/{cloudwatch.ts,cw-buffer.ts,emf.ts}` | `CwMetrics` 继承 `LocalMetrics`：本地 rollup 照写（`/lab` 与本地告警不变），另外缓冲一份按分钟上报。`putmetricdata` 方式：`PutMetricData` 批量（每批 ≤150 个 datum、≤200 KB），延迟类用 `Values/Counts`（CloudWatch 能算 p95/p99）；单个序列超过 150 个不同值后按对数分桶（每个二倍程 4 桶）压缩。`emf` 方式：按 EMF 文档经 TCP 写给 CloudWatch Agent（`METRICS_CW_EMF_ENDPOINT`，默认 `tcp://127.0.0.1:25888`），requestId、pathSig、runId 只作属性不作维度。维度白名单 `Route/Module/Driver/Outcome/Job`，路由最多 50 个，其余归入 `other`（控制基数与费用）。每分钟补写 `AppHeartbeat`（api）与 `WorkerHeartbeat`（worker），供 AWS 侧的“心跳缺失”告警使用。上报失败按 `withAwsRetry`（2 次、5 秒预算）重试，不阻塞请求路径 |
| monitoring 探针 | `cloudwatch.ts`、`local.ts` | 常规探针不调用 PutMetricData：还没有上报过 → ok + inferred（“等待首次上报”，首个探针不判错）；连续 2 次 AccessDenied → error；积压超过 2 个上报周期 → degraded；keys 模式 → degraded；SNS `GetTopicAttributes`（60 秒缓存）`SubscriptionsPending>0` → degraded“订阅未确认：告警只在控制台可见”。Agent 状态取安全快照 `host.units['amazon-cloudwatch-agent']`，快照没有这个单元时记为 unknown（第 4 节）。深度探针：`DescribeAlarms`（前缀过滤）缺少 `app-heartbeat`/`worker-heartbeat` → error、`INSUFFICIENT_DATA` 超过 10 分钟 → degraded；写 `LabProbe` 并用 `GetMetricData` 读回；查 `CWAgent mem_used_percent` 是否有数据。local 驱动的探针读取本地评估器心跳，超过 2 个周期没有运行 → degraded“本地告警沉默” |
| 本地告警评估器 | `backend/src/adapters/monitoring/{alert-rules.ts,alert-evaluator.ts}` | L0 的“告警”：`<envDir>/alerts.yaml`（不存在时用内置 6 条：5xx 比例、p95 延迟、数据盘、内存、api 心跳、错误日志），规则类型 ratio/quantile/gauge/absent/sum，数据来自本地 rollup 与 `lab_host_samples`。在 worker 中运行，`LockPort` 单例（`monitoring.alerts`），状态变化写 `alert_events`，并发站内通知（`monitoring.alarm`，事件 ID 取哈希去重）与邮件；心跳写 `system_meta`。第一次评估在一个周期之后。导出 `startAlertEvaluator(c, signal)` 供 worker 挂载 |
| monitoring 只读侧 | `backend/src/adapters/monitoring/{reader.ts,lab-routes.ts}` | `LocalMetricsReader`（alert_events、rollup、主机采样）与 `CloudWatchMetricsReader`（`DescribeAlarms`、`DescribeAlarmHistory`、`GetMetricData`，60 秒缓存）。`GET /api/lab/monitoring/{alarms,history,series}` 与 `/synthetic`（合成 5xx，见第 3 节）仅管理员可用，**尚未挂载**（第 4 节）。对比实验的服务端证据都经这些端点取得 |
| cost 本地估算 | `backend/src/adapters/cost/estimate.ts` | `estimateCost()`：EC2 实例按运行时长、已启用模块按 registry `billing` 与 `modules.state.json` 的启停记录累计本月小时；`cost-rates.yaml` 只接受注明 https 出处（`source`）与抄录日期（`retrievedAt`）、`resource` 与 registry 逐字一致的条目，只对 `unit: hour` 计算金额；没有单价时 detail 只列资源与小时数，明确写“不显示金额”。平台模式另列工作台自身的计费项（不估算） |
| cost 读取与提醒 | `backend/src/adapters/cost/{budgets.ts,idle.ts,lab-routes.ts}` | `BudgetsReader`：Budgets 与 Cost Explorer 客户端固定 us-east-1；`DescribeBudget`（60 秒缓存）、`ListCostAllocationTags`（30 分钟）、订阅状态；`GetCostAndUsage` 不带确认就抛 `ConfirmationRequired`，结果缓存 12 小时，按 `Module` 标签分组并计算无标签占比。空开提醒：按小时计费的模块连续运行超过 `COST_LOCAL_IDLE_HOURS` 且没有实验活动、或超过 `COST_LOCAL_HOURS_BUDGET` 的 80%/100% 时发通知（`cost.idle`，每资源每天、每级每月一次），worker 中 `LockPort` 单例。`GET /api/lab/cost`、`POST /api/lab/cost/refresh`（未带 `{confirm:"ce-charges"}` → 428；local → 409 `COST_MODE_LOCAL`；`COST_CE_QUERY=off` → 409），**尚未挂载** |
| cost 感知器 | `backend/src/modules/detectors/cost.ts` | local：本地估算作为 detail（输入有问题 → degraded）。budgets：没有凭证 → degraded + inferred（CRED-004）；AccessDenied 或预算不存在 → error；瞬时失败 → degraded + transient；订阅未确认 → degraded；深度探针查成本分配标签，`Project` 未激活 → degraded“尚未生效”；超支只写进 detail（护栏告警由 Budgets 发出，不是模块故障） |
| 模板 | `infra/modules/monitoring.yaml`、`infra/modules/cost.yaml` | monitoring：模块自带的 SNS 主题 `cloudalbum-<env>-ops-alarms`（主题策略允许 CloudWatch、AWS Backup 发布，带 SourceAccount 条件；可选 KMS；邮件订阅），23 个指标告警与 1 个复合告警（`cloudalbum-<env>-<name>`）（EC2 状态检查含 recover 动作、CPU、CPU 积分、内存、数据盘、5xx 比例（指标数学）、p95、`app-heartbeat`/`worker-heartbeat`（`TreatMissingData: breaching`）、复合告警 `app-unhealthy`、错误日志，以及按注入参数条件创建的 ALB/RDS/ElastiCache/SQS/Lambda/API Gateway/Step Functions 告警），仪表板 `CloudAlbum-<env>-Overview`，emf 方式的日志组，一条托管策略（`PutMetricData` 限定命名空间 `CloudAlbum/App` 与 `CWAgent`）。cost：主题（只允许 `budgets.amazonaws.com`，带 SourceAccount/SourceArn）、项目预算（`TagKeyValue user:Project$CloudAlbum`、`IncludeCredit: false`、实际与预测通知）、账号预算、可选的预算动作（`EnableBudgetAction=true` 时把 `AWSDenyAll` 附加到无人使用的金丝雀角色，支持 `PermissionsBoundaryArn`）、一条只读托管策略。预算金额没有默认值。两个模板 cfn-lint 1.57.2 零发现；没有 Export/ImportValue；Outputs 为 `PolicyArn`、`Env*`、`Info*` |
| 主机侧 | `infra/modules/monitoring/{cwagent.json,cwagent-emf.json,host-setup.sh}` | 只在 `modules.d/iam.env` 为 `IAM_CREDENTIALS=role` 时安装 Agent；片段渲染为 `cloudalbum-monitoring.json`（与 logging 的 `cloudalbum-logging.json` 文件名不同，`append-config` 不会互相覆盖）；内存、数据盘（`InstanceId+path`）与 ASG 聚合维度；emf 方式另加 `cloudalbum-monitoring-emf.json`。revert 时 `remove-config`，没有其他片段时停止 Agent |
| scripts/module hook | `scripts/module-cli/src/module-hooks/{monitoring,cost}.ts` | 第 2 节 |
| 对比实验 | `experiments/monitoring/**`、`experiments/cost/**` | monitoring：`time-to-alert`、`kill-test`、`mem-visibility`、`resolution` 是 node 场景，`notify-path` 是手工实验；故障脚本 `faults/{stop-app,stop-instance,cpu-spike}.sh`。cost：`visibility-lag`、`tag-coverage` 是 node 场景，`threshold-alert`、`idle-reminder`、`budget-action-canary` 是手工实验 |
| 卡片 | `labs/svc-monitoring/**`、`labs/svc-cost/**` | lab.yaml v2（status beta，1.0.0）、手册、检查、小测与徽章；与卡片文档的差异写在各自 lab.yaml 的文件头 |
| 测试 | `backend/test/adapters/aws/monitoring-cloudwatch.test.ts`、`backend/test/adapters/monitoring-local-alerts.test.ts`、`backend/test/modules/detector-cost.test.ts`、`backend/test/http/lab-monitoring-cost.test.ts`、`scripts/module-cli/test/module-hooks-{monitoring,cost}.test.ts`、`experiments/test/monitoring-cost.test.ts` | 7 个文件 72 个用例：MetricsPort 契约（aws-sdk-client-mock）、EMF 文档、评估器、感知器状态机、路由（supertest）、hook dry-run 与桩网关、实验场景 |

### 2. scripts/module hook

- **monitoring**：`plan` 校验 `Mode`（putmetricdata|emf）与 `AlertEmail`（不合法 → 退出码 2）；`Mode=emf` 遇到 keys 模式以退出码 2 拒绝（EMF 需要 Agent 与实例角色）；没有 `AlertEmail` 时提示“告警只在控制台与 /lab 可见”；计费提示只说明计费维度，不给金额。`afterDeploy` 用 `GetTopicAttributes` 检查订阅是否待确认，并打印仪表板链接。disable 时提示：已上报的自定义指标不能删除，只能按保留期过期；告警、仪表板与主题随栈删除；`DetailedMonitoring` 随 baseParams 改回 false。
- **cost**：`plan` 校验 `ProjectBudgetLimit`、`AccountBudgetLimit`（正数，没有默认值）、`AlertEmail` 与 `EnableBudgetAction`；缺少金额时只输出计划并给出提示（不替学员决定预算）。`prepare` 做只读 preflight `ListCostAllocationTags`（只警告）。`afterDeploy` 激活成本分配标签 `Project`、`Module`（`ce:UpdateCostAllocationTagsStatus`，记入 `state.outOfBand`）；平台模式下学员与控制台身份跳过并提示平台动作 `cost-activate-tags`，只有 provisioner 执行。disable 不停用标签（停用会破坏按标签分组的历史）。
- 两个 hook 都没有 `planHints`：labs:derive 的 DRV-6 会把 hook 的计划警告当作“未声明的 expectedWarnings”，改为 notes 输出。

### 3. 设计有歧义时的取舍

1. **路由放在适配器目录**（`adapters/monitoring/lab-routes.ts`、`adapters/cost/lab-routes.ts`），由集成阶段挂载，与 logging 的做法相同；读取器类型放在 `adapters/monitoring/reader.ts`（ports 是共享文件）。
2. **成本估算放在 `adapters/cost/estimate.ts`**，不是总纲写的 `services/cost-estimate.ts`（services 是共享目录）。
3. **CwMetrics 接入 LabMetricsStore 的方式**：共享的 `LabMetricsStore` 没有观察者接口，`CwMetrics.init()` 用 `Symbol.for('cloudalbum.monitoring.cwTap')` 防重复地包装 `recordRequest`/`onCall`，不改共享代码；集成阶段可以换成正式的订阅接口。
4. **EMF 自己拼文档**，不引入 `aws-embedded-metrics`（并行阶段不安装依赖）；只支持 TCP 端点。
5. **time-to-alert 的故障源是合成 5xx 端点** `/api/lab/monitoring/synthetic?rate&status`，不用共享的 error5xx 故障：后者作用于所有路由，`healthcheck.sh` 看到 `/api/health/*` 失败会重启 api，实验因此测不到告警。判定只看服务端记录的告警状态变化（本地 `alert_events`、CloudWatch `DescribeAlarmHistory`），不看客户端响应头。
6. **长时间的故障脱离运行器执行**：运行器对故障脚本有 300 秒超时，`stop-app.sh` 用 `systemd-run --on-active` 安排自动恢复，`stop-instance.sh` 用 `nohup` 后台执行并 `trap` 恢复（实例 ID 自动发现或 `--param instanceId`）。
7. **kill-test 的 phase 约束在场景内检查**（平台模式 before/after 只接受 `phase=service`，`--label stop-instance` 只接受 `phase=instance`）：experiment.json 的参数模式无法表达随 label 变化的约束，所以违反时场景以错误退出（退出码 1，不是参数校验的 2）。
8. **探针“首次不判错”**：还没有上报、SNS 查询失败、Budgets 瞬时失败都给 degraded（transient）或 ok + inferred，不给 error；控制面读取都有超时与缓存（2026-10-14 的教训）。
9. **Agent 状态未知**：安全快照的单元列表没有 `amazon-cloudwatch-agent`，探针记为 unknown，只在深度探针里用 `CWAgent` 指标是否有数据来判断；卡片的 `agent-active` 检查用本机 `systemd-unit` 检查。
10. **Cost Explorer 必须显式确认**：应用不轮询；`POST /api/lab/cost/refresh` 需要确认词 `ce-charges`；实验 `tag-coverage` 需要 `--param confirmCharges=yes`。
11. **cost-rates.yaml 采用文档格式** `{currency, region, entries: [...]}`，同时兼容 `rates: [...]` 与顶层数组；共享的 `load-env.ts`（CFG-010 的输入）目前只读 `rates` 与顶层数组（第 4 节）。
12. **预算动作只指向金丝雀角色**（`AWSDenyAll`），默认关闭；卡片第 8 步只核对配置（`DescribeBudgetActionsForBudget`），不等待触发。
13. **卡片步骤拆分**：svc-monitoring 第 2、6 步各含两个实验，拆成 `baseline-alert`/`baseline-kill`/`after-alert`/`after-kill`；“停实例”是单独的选做步骤并声明 `expectedOutage`。svc-cost 的 visibility-lag 改为“同一时刻两侧快照”。
14. **学员输入变量不写 `fillFrom`**（`projectBudgetLimit`、`accountBudgetLimit`）：labs:lint 遇到带 `fillFrom` 的变量会崩溃（第 4 节）。

### 4. 需要集成阶段处理

- `backend/src/http/app.ts`：把 `adapters/monitoring/lab-routes.ts` 与 `adapters/cost/lab-routes.ts` 的 `register(app, c)` 加入 `ROUTE_MODULES`（先于 `routes/lab.ts`）。monitoring 的四个 node 实验与 cost 的两个实验都依赖这些端点。
- `backend/src/worker.ts`：调用 `startAlertEvaluator(c, signal)`（`adapters/monitoring/alert-evaluator.ts`）与 `startCostIdle(c, signal)`（`adapters/cost/lab-routes.ts`）。不挂载时 local 驱动的探针会报“本地告警沉默”（degraded）。
- `backend/src/container.ts`：cost 的感知器只在 `COST_MODE=budgets` 时被 capabilities 调用（`sourceFor` 要求 enabled）。卡片检查 `cost-local-baseline` 需要 local 模式下也有估算 detail：请在创建感知器之后加 `caps.registerProbe('cost', (o) => costDet.detect(o))`（`costDet` 即 `costDetectorOf(container)` 取到的实例），或让 capabilities 对 `type: infra` 的模块在 local 时也调用感知器。
- `infra/host/security-snapshot.sh`：单元列表加入 `amazon-cloudwatch-agent`（探针与 `/lab` 才能看到 Agent 状态）。
- （建议）error5xx 故障豁免 `/api/health/*` 与 `/api/lab/*`，否则与 `healthcheck.sh` 的自动重启冲突。
- `backend/src/config/load-env.ts`：cost-rates 解析同时接受文档格式的 `entries`，并尊重 `COST_RATES_FILE`（否则 CFG-010 看不到 `entries` 格式的条目）。
- scripts/module 公共部分：增加 `cost activate-allocation-tags --keys …` 子命令（调用 `module-hooks/cost.ts` 的 `activateCostAllocationTags`），作为平台动作 `cost-activate-tags` 的执行体。
- `scripts/labs/src/lint/card.ts` 第 608 行：`lintVariables` 在声明 `const inputs` 之前调用 `checkExpr`，任何带 `fillFrom` 的变量都会触发 TDZ 错误。
- `scripts/labs/src/derive/cli.ts` 第 63 行把 runtime 项的 `value` 转成字符串，scripts/module 的摘要用的是布尔值 `true`，所以带 `featureFlags.lab.faults` 的卡片（svc-logging、svc-monitoring）报 DRV-10 摘要差异警告。
- 数量假设：`experiments/test/manifest.test.ts`（8 个 MVP 模块）、`scripts/labs/test`（10 张完整卡片 / 46 个占位）；`labs/_catalog/catalog.yaml` 需要 `npm run labs:catalog`（C-2）。
- `scripts/module-cli/test/helpers.ts`：`ALLOW_PENDING_WAVE1_TEMPLATES` 可以改为 false（本组两个模板已经就位）。
- git 可执行位：`infra/modules/monitoring/host-setup.sh` 与 `experiments/monitoring/faults/*.sh` 已用 `git update-index --chmod=+x` 登记。

### 5. 自测（2026-10-14，Windows 11 / Node 22.14）

| 命令 | 结果 |
|---|---|
| `npm run build` / `npm run lint` / `npm run registry:check` | 通过 / 0 个问题 / OK（2 个既有警告） |
| backend vitest | 61 个文件 798 个用例全部通过 |
| module-cli、experiments、atl-labs-tools 的 vitest | 本组 7 个测试文件 72 个用例全部通过；失败的只有第 4 节列出的数量假设、catalog 与 DRV-10 相关的 5 个共享用例 |
| `npm run smoke:l0` / `smoke:selfhost` | 85 通过 0 失败 / 31 通过 0 失败 |
| `cfn-lint infra/modules/monitoring.yaml infra/modules/cost.yaml`（1.57.2） | 0 个发现 |
| `scripts/module enable monitoring --with-deps --dry-run`、`enable cost --dry-run`、`disable … --dry-run`、`plan <id> --single --dry-run`、`plan --start-of svc-monitoring`/`svc-cost` | 全部退出码 0（monitoring 不带 `--with-deps` 时按设计以 CRED-001 退出码 2 拒绝） |
| `npm run labs:lint` / `labs:derive` | 全仓库只剩 `_catalog` 的 C-2；svc-cost 通过，svc-monitoring 只有 DRV-10 摘要差异警告（第 4 节） |

## wave1-waf

第 1 波 waf（AWS WAF）模块：BlocklistPort 的 `aws` 驱动、感知器、CLOUDFRONT 范围的 Web ACL 模板、scripts/module hook、对比实验与卡片 svc-waf。
全程没有调用真实 AWS、没有部署（aws-sdk-client-mock、内存 IP 集合替身、`--dry-run`、cfn-lint 1.57.2）。

### 1. 实现的内容

| 范围 | 文件 | 内容 |
|---|---|---|
| 感知器 | `backend/src/modules/detectors/waf.ts` | 被动：经 CloudFront/ALB 入口的请求中 entry 含 `waf>` 的比例（只信任回环地址传来的 `X-CloudAlbum-Entry`），`viaEdge≥20` 且被检查数为 0 → degraded（未关联）。主动（有凭证，缓存 55 秒）：`wafv2:GetWebACL`（托管规则组动作 vs `WAF_RULE_ACTION`）、关联（CLOUDFRONT：`cloudfront:ListDistributionsByWebACLId`；REGIONAL：`wafv2:ListResourcesForWebACL`）；深度：`GetIPSet`（与 denylist 一致）+ CloudWatch 按规则计数。NotFound/未关联/AccessDenied → error；瞬时失败经 `withAwsRetry`（单次 900ms×2）→ degraded+transient。DEP-018 不在探针里判定（它是带规则 ID 的 warn 级运行期规则）。 |
| 适配器 | `backend/src/adapters/waf/{aws,ipset}.ts` | `AwsBlocklist`：add/remove 先写本地 denylist（nginx 驱动），再把“未过期的 IPv4 条目”整体同步到 IP 集合（`GetIPSet` 取 LockToken → `UpdateIPSet`，乐观锁重试；CLOUDFRONT 范围在 us-east-1）。非权威端口：同步失败只 degraded、本地照常生效，状态写 `security/waf-sync.json`。worker `init()` 启动每分钟同步循环（经 LockPort 只在一台上执行）。IPv6 条目只在本地 Nginx 生效。`probe()` 合并感知器 detect + nginx 驱动的 denylist 状态 + 同步状态。`ipset.ts` 是纯函数（CIDR 对齐、diff、Web ACL ARN 解析、区域推断）。 |
| 管理 / lab 路由 | `backend/src/adapters/waf/lab-routes.ts` | `GET/POST/DELETE /api/admin/security/blocklist`（封禁，aws 驱动返回“正在传播”）、`POST /api/lab/waf/sync`、`GET /api/lab/waf/origin?run=&nonce=`（源站 Nginx 日志按 runId / nonce 计数——被 WAF 在边缘拦截的请求不进源站日志，这是服务端证据）。`register()` 顺带把登记表里的 waf 感知器 `attachDetector` 到 aws 驱动。 |
| 模板 | `infra/modules/waf.yaml`、`infra/modules/waf/host-setup.sh` | 一份模板两个 registry 栈（edge/us-east-1/CLOUDFRONT，regional/REGIONAL）：allow-lab(0)/block-ip-set(1)/rate-login(2,缩小到 POST /api/auth/)/rate-global(3) + 四个 AWS 托管规则组（`OverrideAction` 随 `RuleAction` 在 Count/None 间切；CRS 的 `SizeRestrictions_BODY` 恒为 Count）；默认动作插入 `cloudalbum: inspected`；两个 IP 集合（`cloudalbum-blocklist`、`cloudalbum-lab-allow`）；LoggingConfiguration 屏蔽 authorization/cookie、只留 BLOCK/COUNT；日志组 DeletionPolicy Retain，`CreateLogGroup=false` 时接管；`AppPolicy` 名含 `-${StackRole}` 两栈并存。host-setup 只渲染 `WAF_LAB_ALLOW_CIDR` 的 Nginx `.inc`。cfn-lint 0 发现。 |
| scripts/module hook | `scripts/module-cli/src/module-hooks/waf.ts` | 参数校验与沿用上次部署值（RuleAction/RateLimit/LoginRateLimit/RateWindowSec/LabAllowCidr，拒绝未替换的 `${atl:}` 占位符）；`stacks()` 按 cdn/load-balancer 选 edge/regional（两者都在时默认只 edge，`--param AlsoRegional=true` 加 regional 且 REGIONAL 用 FORWARDED_IP）；`prepare()` 用 `logs:DescribeLogGroups` 决定是否接管日志组；`afterDeploy()` 读 denylist.conf 首次全量导入 IP 集合（乐观锁重试，失败只告警）；plan 打印 DEP-018 提示（含锁定命令）；disable 提示先解除关联、日志组保留。 |
| 实验 | `experiments/waf/`（flood、payloads、false-positive、bypass + lib） | 短轮次（rate 封顶 50、duration 封顶 120 且不超过运行器窗口）。攻击流量匿名、只带 `?atlprobe=<nonce>`；服务端证据用 `/api/lab/waf/origin` 的 nonce 计数，不看客户端响应头。刻意不提供绕过 WAF 的旁路头。 |
| 卡片 | `labs/svc-waf/**` | lab.yaml v2（status planned → beta，1.0.0）、12 步手册、检查（capability / http-header / aws-readonly / experiment / local / manual）、4 题小测、徽章。labs:lint 0 错误 0 警告，labs:derive 0 错误（digest 复现）。 |
| 测试 | `backend/test/adapters/aws/waf-aws.test.ts`、`backend/test/modules/detector-waf.test.ts`、`backend/test/contract/blocklist.contract.ts`、`scripts/module-cli/test/module-hooks-waf.test.ts`、`experiments/test/waf.test.ts` | 端口契约（nginx 与 aws）+ 驱动细节 + 感知器 + hook + 实验端到端（对 mock 服务器）。 |

### 2. 设计有歧义时的取舍

1. **BlocklistPort 的返回值**：端口契约里 `add/remove` 声明为 `Promise<void>`（总纲 §4.2 照录，不改共享 ports 文件）。aws 驱动另外提供 `block()/unblock()` 返回 `{ effective, synced, detail }`，管理路由据此显示“正在传播到 AWS WAF / reload 后生效”。
2. **被动比例的归属**：能力注册表对 waf 调用的是适配器 `probe()`；适配器内部自带一个 `WafDetector` 实例，但请求的 `observe()` 发给的是登记表里的那个实例。所以 `lab-routes.register()` 把登记表实例 `attachDetector` 给适配器，api 进程的探针才有被动比例。集成阶段需要把 waf 的 lab-routes 加入 `http/app.ts` 的 `ROUTE_MODULES`（见第 3 节），否则被动比例不可用（控制面的“未关联”判定仍有效，不影响正确性）。
3. **托管规则组 Block 的证据**：托管规则组 Block 返回 CloudFront 的 403，不带 `X-CloudAlbum-Path`——无法用客户端响应头把它和 Nginx 正则的 403 区分开（R-16）。卡片的 block 检查用服务端证据（源站 Nginx 日志里该 nonce 计数为 0），路径头只作 warn；检查里不再放 `via: self` 的断言（04 的 corroborate 只支持 local/aws-readonly/builtin）。
4. **锁定源站的命令**：cdn 的 hook 读 `--set CDN_DIRECT_ACCESS` / `--set CDN_ADMIN_CIDR`（ownsEnv 键），不是卡片文档写的 `--param DirectAccess`；卡片按代码写成 `scripts/module enable cdn --set …`。
5. **切到 Block**：§9.2 没有 `set` 子命令（附录 B-27），实现为以新参数重新 `enable`：`scripts/module enable waf --param RuleAction=block`。
6. **起始状态**：`plan --start-of svc-waf` 把 cdn 作为 DEP-006 的闭包以默认值启用（`CDN_DIRECT_ACCESS` 默认就是 open），所以卡片的 cdn provision 不写 `set`、不写 `branches`（否则 DRV-1/DRV-8 与 plan 不一致）；“open 让学员看到可绕过”写进 reason。
7. **IP 集合与 pricing**：`labs/_pricing/dimensions.yaml` 只有 `waf.web-acl`、`waf.requests`、`logs.ingestion`，没有单独的 `waf.rule`；卡片用这三个键，规则费用并进 web-acl 的 note。
8. **REGIONAL 的速率键**：ALB 在 CloudFront 后面时看到的是 CloudFront 地址，regional 栈的速率规则与 IP 集合用 `FORWARDED_IP`（读 X-Forwarded-For）。

### 3. 需要别人配合的事项（共享文件，集成阶段处理）

- **`backend/src/http/app.ts`**：把 waf 的 lab-routes `register` 加入 `ROUTE_MODULES`（先于 `routes/lab.ts`），端点 `/api/admin/security/blocklist`、`/api/lab/waf/sync`、`/api/lab/waf/origin` 才生效；它同时把登记表的 waf 感知器接到 aws 驱动（见第 2 节第 2 条）。在登记之前，卡片的 `block-not-at-origin` 与选做 `blocklist-synced` 检查会拿不到数据。
- **`backend/src/worker.ts`**：worker 里启动 waf 的 IP 集合同步循环——`if (c.blocklist.meta.driver === 'aws') (c.blocklist as AwsBlocklist).startSyncLoop()`（或在 `AwsBlocklist.init()` 里已按 role=worker 自启，只需确认 worker 容器给 blocklist 注入了 `lock`）。
- **`labs/_catalog/catalog.yaml`**：svc-waf 由 planned 变为完整卡片后要 `npm run labs:catalog` 重新生成（C-2/C-4）；这是全仓库共享文件，和其他 wave1 卡片一起在集成阶段统一重算。
- **`scripts/module-cli/test/helpers.ts` 的 `ALLOW_PENDING_WAVE1_TEMPLATES`**：waf.yaml 已就位；全部 wave1 模板到位后由集成阶段改为 false。
- **`scripts/labs/test/{lint,derive,build}.test.ts`**：仍假设“10 张完整卡片、46 张占位”，加入 svc-waf（及其他 wave1 卡片）后这些数量断言需要更新（与 wave1-sns-ses 第 6 节同一处）。

### 4. 自测（2026-10-14，Windows 11 / Node 22.14.0）

| 命令 | 结果 |
|---|---|
| `tsc --noEmit`（backend / module-cli / experiments）；本模块文件的 `eslint` | 通过；0 个问题 |
| `npx vitest run`（backend：waf-aws、detector-waf、blocklist 契约） | waf-aws 20、detector-waf 12 个测试通过（含 nginx + aws 两个契约） |
| `npx vitest run`（capabilities、rules、integration-drivers 回归） | 146 个测试通过 |
| `npx vitest run`（module-cli：module-hooks-waf、templates、templates-platform） | module-hooks-waf 14、templates/templates-platform 93 个测试通过 |
| `npx vitest run test/waf.test.ts`（experiments） | 7 个测试通过（清单 + lib + 4 个场景对 mock 服务器） |
| `cfn-lint infra/modules/waf.yaml`（1.57.2，--regions us-east-1 ap-northeast-1） | 0 个发现 |
| `scripts/module enable waf --with-deps --dry-run`、`disable waf --dry-run`、`plan waf --single --dry-run`、`plan --start-of svc-waf` | 全部退出码 0（enable 先建 cdn 再 waf-edge[us-east-1]、注入 WebAclArn、首次导入 denylist；disable 先解除关联再删栈、保留日志组） |
| `npm run build` | 通过（gen:registry up to date） |
| `npm run labs:lint` / `labs:derive --card svc-waf` | svc-waf 0 错误 0 警告 / derive 0 错误（digest 复现）。全仓库剩余问题来自 `_catalog` 与其他 wave1 进行中卡片 |
| `npm run smoke:l0` / `smoke:selfhost` | 85 通过 0 失败 / 31 通过 0 失败 |

## wave1-identity-pool

第 1 波模块补齐中的 identity-pool（Amazon Cognito Identity Pool，F14 的 AWS 实现：STS 临时凭证直传暂存桶 + 服务端 CopyObject 导入）。
只修改了本组负责的路径；没有调用任何真实 AWS API，`scripts/module` 只用 `--dry-run`。

### 1. 完成的内容

| 范围 | 文件 | 内容 |
|---|---|---|
| cognito 驱动 | `backend/src/adapters/identity-pool/cognito.ts` | `openSession`：`{mode:'sts', region, bucket, prefix, partSize, credentialsUrl}`（`identity-pool=cognito:sts`；已有 `users.identity_id` 时前缀带 identityId）；管理员旁路 → none 驱动的前缀令牌（`cognito:bypass`）；故障回退（最近一次探针 error、连续 3 次探针失败、或 60 秒内换取凭证失败）→ 前缀令牌 `fallback:true`（`cognito:error-fallback`）。`credentials`：先本地核对 ID 令牌声明（`token_use=id`、iss = 本站 User Pool、aud = 客户端、sub = 当前登录者、未过期；签名由 Cognito 校验）→ `GetId(Logins)` → `GetCredentialsForIdentity`（两者不签名；各经 `withAwsRetry` 单次 5 秒、最多 2 次）→ 写 `users.identity_id`；auth=local + `IDENTITY_DEV_PROVIDER` 走 `GetOpenIdTokenForDeveloperIdentity` → `Logins['cognito-identity.amazonaws.com']`。Cognito 拒绝过期令牌 → 401（不计失败）；其余失败 → 503 `IDENTITY_POOL_UNAVAILABLE`。`complete`：暂存对象 `private/<identityId>/<photoId>.<ext>` → HeadObject（≤ maxUploadMb、Content-Type 在白名单）→ Range GetObject 读文件头 → 不合规删除暂存对象、照片 FAILED、抛 413 / 415；合规 `StoragePort.importObject`（CopyObject，`storage=s3:import`）→ 删除暂存对象；暂存桶没有对象时交给 none 驱动（令牌会话）。`authorizePart` 委托 none 驱动。另有 `labProbe()`、`stagingObject(key)`、`lastIssued(userId)`、`exchangeStats()` |
| none 驱动 | `backend/src/adapters/identity-pool/none.ts` | 只加 `labProbe()`：为 `_probe/` 签发并校验一个前缀令牌（`identity-pool=none:token`），L0 行为不变 |
| /lab 侧路 | `backend/src/adapters/identity-pool/lab-routes.ts` | `GET /api/lab/identity-pool/whoami`（none：令牌前缀与有效期；cognito：identityId、暂存前缀、最近一次 ASIA 凭证的剩余秒数、策略资源模板、是否在回退）、`GET /api/lab/identity-pool/staging-object?key=`（服务端证据：暂存对象是否存在，只限暂存前缀）；导出 `identityPoolLabProbe(c)`（/api/lab/probe/identity-pool 的处理函数）与 `idTokenOf(req)`（Cookie `ca_it`，没有时取请求头 `X-CloudAlbum-Id-Token`）。注册见第 5 节 |
| 模板 | `infra/modules/identity-pool.yaml` | 身份池（`AllowUnauthenticatedIdentities: false`、`AllowClassicFlow: false`；`UserPoolId` 非空时 User Pool 提供方，`DeveloperProviderName` 非空时开发者提供方，Rules 断言二者至少一个）；Uploader 角色 `cloudalbum-<env>-identity-pool-uploader`（信任 `cognito-identity.amazonaws.com`，`StringEquals aud = 本池` + `ForAnyValue:StringLike amr = authenticated`；`PutObject / AbortMultipartUpload / ListMultipartUploadParts` 限 `private/${cognito-identity.amazonaws.com:sub}/*`，`ListBucket` 限同一 `s3:prefix`；`KmsKeyArn` 非空时 `kms:GenerateDataKey` + `kms:Decrypt`；`PermissionsBoundaryArn`）；`IdentityPoolRoleAttachment`（只有 authenticated）；暂存桶 `cloudalbum-<env>-upload-staging-<acct>`（BPA、BucketOwnerEnforced、SSE-S3 / SSE-KMS、拒绝非 TLS、CORS = `AppOrigins` 的 PUT/POST/DELETE/GET/HEAD + 暴露 ETag、`private/` 1 天过期、未完成分片 1 天中止、**没有任何 NotificationConfiguration**）；`AppPolicy` `cloudalbum-<env>-identity-pool`（暂存对象 Get/Delete、ListBucket、DescribeIdentityPool；开发者提供方时 GetOpenIdTokenForDeveloperIdentity；kms 时 Decrypt）。Outputs：`EnvIdentityPoolId / StagingBucket / UploadPrefix / DevProvider`、`InfoUploaderRoleArn / RoleName / StagingBucketArn / UploaderResource`。cfn-lint 0 发现 |
| hook | `scripts/module-cli/src/module-hooks/identity-pool.ts` | 见第 2 节 |
| 前端 | `frontend/src/upload/identityPoolUpload.ts`、`sigv4.ts`、`index.ts`、`types.ts`、`auth/CognitoAuthProvider.tsx` | 浏览器内 SigV4（WebCrypto，UNSIGNED-PAYLOAD，x-amz-security-token）直接调用 CreateMultipartUpload / UploadPart / ListParts / Complete / Abort；凭证缓存（剩余 < 5 分钟刷新，一批文件共用），分片 `ExpiredToken` 时刷新重试一次；续传（`ResumeState.stagingKey` + ListParts）；凭证接口 503 时重新开会话走前缀令牌；读不到 ETag 时提示 CORS。Amplify 子模式由 `setIdTokenProvider` 提供 ID 令牌（请求头 `X-CloudAlbum-Id-Token`） |
| 实验 | `experiments/identity-pool/**` | `cross-prefix`、`upload-bench`、`resume`（Node）、`policy-sim`（手工，README）；见第 3 节 |
| 卡片 | `labs/svc-identity-pool/**` | lab.yaml v2（planned → beta，1.0.0）、11 页手册、13 + 5 项检查、6 道小测、徽章；labs:lint 本卡 0 错误 0 警告 |
| 测试 | `backend/test/adapters/aws/identity-pool-cognito.test.ts`（16）、`scripts/module-cli/test/module-hooks-identity-pool.test.ts`（6）、`experiments/test/identity-pool.test.ts`（11）、`frontend/src/upload/identityPool.test.ts`（11） | aws-sdk-client-mock（Cognito Identity）+ 内存 S3（FakeS3，CopyObject 真实复制字节）；hook 全部在 dry-run / 脚本化网关上运行；实验对一个本地替身（两种授权 + 按策略变量判定的路径式假 S3）完整运行三个场景；前端 SigV4 用 AWS 文档的 4 个 S3 示例签名核对 |

### 2. scripts/module hook

- `plan()`：`--param DeveloperProviderName=<name>` 校验后写入 `IDENTITY_DEV_PROVIDER`（于是 DEP-002 接受 auth=local）；APP_BASE_URL 为 http 时打印 DEP-030 说明；
  说明重启后 F14 从 `none:token` 切到 `cognito:sts`。没有 `planHints()`（不给 `plan --start-of` 增加自由文本警告）。
- `prepare()`：平台预览方案 B 开启（`state.platform.preview` issued / pending）时，把 `https://<EIP>` 并入暂存桶 CORS（在通用注入的 AppOrigins 之上取并集）；
  重新 enable 时沿用已部署的 `DeveloperProviderName`。UserPoolId / UserPoolClientId 完全来自 auth 的 injects。
- `beforeDisable()`：中止暂存桶里所有未完成的分片上传、分页删除全部对象（`ListMultipartUploads` / `AbortMultipartUpload` / `ListObjectsV2` / `DeleteObjects`，部署者身份），
  然后才分离 PolicyArn、删除栈；提醒 `users.identity_id` 保留、两步之间若有新上传导致删除失败就再执行一次 disable。
- 自测：`enable identity-pool --dry-run`（依赖已启用）退回码 0；只有基础栈时 CRED-001 + 两条 DEP-002，退出码 2；`--with-deps` 依次 iam、auth、storage；
  `disable` 先清空暂存桶再 DeleteStack；`plan identity-pool --single --dry-run`、`plan --start-of svc-identity-pool --no-rules` 均退出码 0（起始状态 iam + auth(cognito) + storage(s3)，preview on）。

### 3. 实验

- 测试用户：`--param users=<文件>`（平台种子的 JSON 或 CSV）→ 环境变量 `CLOUDALBUM_TEST_USERS_PARAM`（AWS CLI 读 SecureString）→ `EXP_USERS_FILE`。
  auth=local 用 `/api/auth/login`；auth=cognito 用 **USER_SRP_AUTH**（`cognito-srp.ts`，按 amazon-cognito-identity-js 的算法；N 为 RFC 3526 3072 位素数，已按 RFC 公式核对）——
  SPA 客户端只允许 SRP，auth 实验用的 USER_PASSWORD_AUTH 在这里不可用。
- 服务端证据：用户请求不能带实验头（非管理员 403），所以三个实验在卡片中是 `validity: functional`，以服务端 path-seen 检查（`f14-path-seen`、`sts-path-seen`）佐证；
  场景另以管理员身份读服务端证据：`cross-prefix` 用 `/api/lab/identity-pool/staging-object` 确认自己的对象存在、写到别人前缀的对象不存在、别人的对象没被删（token 模式确认 B 的照片仍是 UPLOADING）；
  `upload-bench` 读每张照片的服务端状态并抽查暂存对象已在导入后删除；`resume` 记录续传前服务端（`/api/storage/upload/parts`）或 S3（ListParts）报告的已收分片。
- `--param s3Endpoint=` 改用路径式 S3（LocalStack / 测试替身）；S3 请求用 Node 版 SigV4（`s3.ts`）。

### 4. 设计有歧义时的取舍

1. **Uploader 角色名**：文档写 `CloudAlbumUploaderRole`；IAM 角色名在账号内全局唯一，平台一个账号里有多个会话，因此用 `cloudalbum-<env>-identity-pool-uploader`
   （templates.test 的命名约定），卡片与手册写明它就是文档中的 CloudAlbumUploaderRole，检查用栈输出 `InfoUploaderRoleName`。
2. **前端不引入 `@aws-sdk/client-s3` + `lib-storage`**：并行阶段不能 `npm install`；只需要 5 个 S3 REST 调用，手写 SigV4（WebCrypto）没有新依赖、不增加首屏包，
   用 AWS 文档的 4 个签名示例核对。
3. **ID 令牌的来源**：auth=cognito 的实现是 Amplify 子模式（`flows = null`，令牌在浏览器内存里），后端没有 `ca_it` Cookie，现有路由会 401。
   前端改为在请求头 `X-CloudAlbum-Id-Token` 里带 ID 令牌，`idTokenOf(req)` 兼容两种来源；路由的改动见第 5 节。驱动在本地核对声明（sub 必须是当前登录者），防止把别人的 identityId 写进 `users.identity_id`。
4. **故障回退的判据**：文档只说“不可用时退回”。为避免每次开会话都同步调用 Cognito，取：最近一次探针 error、连续 3 次探针失败（含瞬时，与状态机一致）、或 60 秒内换取凭证失败。
   单次慢探针（重启后 IMDS / SDK 首个请求慢）只记 degraded + transient，不触发回退。
5. **深度探针**：文档写“用测试身份走一遍 GetId + GetCredentialsForIdentity，写-删 `private/_probe/`”——探测主体没有 ID 令牌，Uploader 角色也写不了 `private/_probe/`。
   改为列出暂存前缀（ListObjectsV2），真实换取凭证的证据由 path-seen（`cognito:sts`）给出（与 06 PM-11 的做法一致）。
6. **暂存桶 DeletionPolicy: Delete**：只存放 1 天过期的临时对象，不是权威数据；disable 先清空再删栈（文档第 6 节）。
7. **没有感知器**：identity-pool 是带端口的参数型模块，状态由适配器探针给出，不加 `detectors/identity-pool.ts`。
8. **令牌会话在 cognito 驱动下的路径段**：会话请求记 `cognito:bypass` / `cognito:error-fallback`，其后的 `parts:sign` 与 complete 由 none 驱动处理，记 `none:token`。
9. **模板级 cfn-lint 忽略 W1030**：`ClientId` 只在 HasUserPool 时使用且 Rules 断言非空，但 cfn-lint 按参数默认值 '' 解析并把警告挂在参数上，资源级 Metadata 忽略不到，只能放在模板级并写明理由。
10. **卡片**：第 5 步拆为 after-bench 与 after-cross 两个实验步骤；resume 只登记 `after`（卡片设计为 `resume --mode sts`）；auth 起始状态的 `set` 按 `plan --start-of` 的输出只写 `AUTH_DRIVER`。

### 5. 需要集成阶段处理（共享文件）

1. `backend/src/http/app.ts`：把 `adapters/identity-pool/lab-routes.ts` 加入 ROUTE_MODULES（先于 routes/lab.ts）。
2. `backend/src/http/routes/lab-probe.ts`：在 404 兜底之前登记 `app.get('/api/lab/probe/identity-pool', (_req, res) => guarded(res, () => identityPoolLabProbe(c)))`，并把 PROBE_UNKNOWN 的端点列表补上 identity-pool。
   卡片检查 `identity-pool-probe` 依赖它。
3. `backend/src/http/routes/uploads.ts` 的 `GET /api/uploads/credentials`：ID 令牌改用 `idTokenOf(req)`（Cookie `ca_it` 或请求头 `X-CloudAlbum-Id-Token`）；
   `IDENTITY_DEV_PROVIDER` 非空且登录者是本地账号时允许空令牌（驱动走开发者认证身份），否则现在一律 401 `ID_TOKEN_REQUIRED`。
   在此之前：BFF 子模式可用；Amplify 子模式的浏览器拿不到凭证，会话会停在 STS（实验脚本同时带 Cookie 与请求头，不受影响）。
4. `modules/registry.yaml`：identity-pool 的 `lab.badges.degraded` 是“已退回逐文件上传”，与实现（以及文档第 11 节“临时凭证不可用，已改用应用自签令牌（EC2）”）不符：
   回退的是 F14 的前缀令牌，不是 F6。改后 `npm run gen:registry`、`labs:catalog`。
5. `labs/_catalog/catalog.yaml`（`npm run labs:catalog`）；`experiments/test/manifest.test.ts` 的 “exactly 8 MVP modules”；`scripts/labs/test/{lint,derive,build}.test.ts` 的完整卡片数。
6. `scripts/labs` 的 DRV-6：`plan --start-of` 对起始状态的规则警告输出 `rules: DEP-013`（带前缀），derive 按原字符串比较 expectedWarnings，svc-identity-pool（起始状态含 auth=cognito）因此报
   “warning rules: DEP-013 … not in expectedWarnings”。建议 derive 去掉 `rules: ` 前缀再比较（或 plan-start 只输出规则 ID）。
7. `scripts/module-cli/src/ops.ts`（可选）：平台预览方案 B 下浏览器的源是 `https://<EIP>`，通用的 AppOrigins 只含 `http://<EIP>`。本 hook 在 identity-pool 首次部署时补上，
   但之后其他模块的 injects 重算 AppOrigins 会去掉它；storage 原图桶的 CORS 同样缺这个源。建议 `injectedParams` 的 baseLists 在 preview 开启时同时包含两者。
8. `scripts/module-cli/test/helpers.ts` 的 `ALLOW_PENDING_WAVE1_TEMPLATES`：identity-pool.yaml 已就位。
9. （可选）前端 `/lab` 的 identity-pool 卡片（显示 whoami、四个越权按钮）没有做：越权测试由实验脚本完成，服务端数据已由 `/api/lab/identity-pool/whoami` 提供。

### 6. 自测（2026-10-14，Windows 11 / Node 22.14.0；没有调用 AWS）

| 命令 | 结果 |
|---|---|
| `cfn-lint --regions ap-northeast-1 us-east-1 -- infra/modules/identity-pool.yaml`（1.57.2，D 盘 venv） | 0 发现（模板级忽略 W1030，理由见第 4 节第 9 条） |
| `npm run build`；`tsc` backend / module-cli / experiments / frontend | 通过 |
| `npx eslint .` | 0 个问题 |
| `vitest`：identity-pool-cognito（16）、module-hooks-identity-pool（6）、templates + templates-platform（97）、experiments identity-pool（11）、frontend upload（21） | 全部通过 |
| `scripts/module enable identity-pool --dry-run`（scratchpad 中的模拟 state.json：iam + auth + storage 已启用） | 退出码 0；只有基础栈时 CRED-001 + DEP-002 ×2，退出码 2 |
| `scripts/module disable identity-pool --dry-run`、`plan identity-pool --single --dry-run`、`plan --start-of svc-identity-pool --no-rules` | 退出码 0；disable 先清空暂存桶再 DeleteStack |
| `npm run labs:lint` | 本卡 0 错误 0 警告；全仓库只剩 `_catalog` 的 C-2（第 5 节第 5 条） |
| `npm run labs:derive -- --card svc-identity-pool` | 起始状态 iam + auth(cognito) + storage(s3)、preview on、部署等级 B；只剩 DRV-6 的 `rules: DEP-013`（第 5 节第 6 条）；参考推导器（labs build 测试）对本卡无错误 |
| `npm test` | 2630 通过、18 跳过、5 失败——全部是第 5 节第 5 条的共享数量假设（experiments manifest、labs lint ×2 / derive / build） |
| `npm run smoke:l0` / `smoke:selfhost` | 85 通过 0 失败 / 31 通过 0 失败 |
| `npm run registry:check` | OK（2 个已有警告） |

## wave1-scenarios

第 1 波完成后模块已齐全的两张场景卡片：`sc-edge-protection`（cdn + waf）与 `sc-event-fanout`（email + notification）由 planned 改为 beta，
内容以 docs/platform/cards/scenario-cards.md §3.2、§3.5 为准，命令、端点与开关按已实现的代码核对。同时核对了 `labs/_tracks/*.yaml` 中第 1 波单服务卡片的引用，
并重新生成 `labs/_catalog/catalog.yaml`。全程没有调用 AWS；`scripts/module` 只用 `--dry-run`（scratchpad 中的临时 state 文件）。

### 1. 完成的内容

| 卡片 | 文件 | 内容 |
|---|---|---|
| sc-edge-protection 1.0.0 | `labs/sc-edge-protection/**` | 10 个步骤：直连基线（flood、payloads）→ 建分配并锁定直连（wire：cdn）→ 验证锁定 → 挂 Web ACL（wire：waf，Count）→ 观察误杀 → 切 Block → after（flood、payloads，`target=both`）→ 分层（Shield、GuardDuty 讲解）。检查 4 个文件；小测 5 题（3 道场景题，含文档的 2 道场景题）；开始 / 完成两张自绘架构图（`assets/arch-start.svg`、`arch-end.svg`）与徽章 |
| sc-event-fanout 1.0.0 | `labs/sc-event-fanout/**` | 9 个步骤：种子用户 → fanout before → 接入 SES（wire：email）→ 沙盒 → 接入 SNS 与用户订阅（wire：notification）→ filter → fanout after → worker 停机 →（选做）退信回流。检查 2 个文件；小测 5 题（4 道场景题）；两张架构图与徽章 |
| 路径 | `labs/_tracks/*.yaml` | 核对 tracks-and-catalog §4：第 1 波 10 张单服务卡与两张场景卡在 9 条路径中的阶段、角色、选修组、`legacyLab` 与“需要域名”的说明都与设计一致，各卡 `tracks` 字段与实际包含关系一致（B23）。**没有改动** |
| 目录 | `labs/_catalog/catalog.yaml` | `npm run labs:catalog` 重新生成：startable 22、planned 34 |

两张卡片的公共检查尽量引用单服务卡（`svc-cdn/*`、`svc-waf/*`、`svc-notification/*`、`svc-email/*`），变量名与它们保持一致；
单服务卡主版本变化时两张场景卡要同步提升版本（CHANGELOG 已注明）。

### 2. 设计有歧义或与代码不一致时的取舍

1. **GuardDuty（sc-edge-protection 选做目标）**：threat-detection 本轮没有实现（implemented.ts 没有它的 AWS 驱动，experiments/ 没有对应实验），
   删去选做目标与 `threat-detection/sample-findings`，改为第 10 步“分层”中的讲解与手动确认（`guardduty-layer`）。费用档位因此是“低”（不再是“低（选做 → 中）”）。
   模块实现后以选做目标补回（版本 +1）。
2. **不使用 `waf/bypass` 实验**：卡片设计让 `CDN_ADMIN_CIDR` = 工作台公网出口，而 bypass 从工作台探测 80 端口，必然可达（`originLocked=false`）。
   “无法绕过”改用服务端证据：实验机安全组 80/443 只有工作台 /32（`origin-locked-sg`，也是最终检查）、源站安全组 8080 只引用托管前缀列表（`origin-sg-prefix-list`）、
   实验机本机不带校验头请求 8080 得 403（`svc-cdn/origin-direct-denied`），以及学员在 CloudShell 直连超时的手动记录。
3. **锁定的时机**：文档第 2 步就以 `CDN_DIRECT_ACCESS=admin-ip` 建分配，本卡照此实现（`scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR={{ workstation.publicIp }}/32`），
   所以 waf 一启用就应是 ok。卡片级 `expectedWarnings` 仍登记 DEP-018：registry 中它的 `need` 为空、运行期条件在 rules.ts，labs:derive 的参考推导器只要 waf=aws 就报它；
   waf 的 capability 检查 `cap-waf-healthy` 用检查级 `expectedWarnings: []` 保持严格。
4. **第 1 步的源站证据**：文档写“entry=nginx 的 429 数 > 0”。被 `limit_req` 拒绝的请求没有上游响应，访问日志的 `path` 为空、按 entry 分组只能落到 unknown，
   `nginx-log-summary` 也只按 2xx/4xx 分类，所以改为“最近 30 分钟到达实例的登录请求数 ≥ 20、其中 4xx ≥ 1”（`origin-load-before`，drift once）。
5. **切 Block、Web ACL 检查**：`scripts/module set` 不存在，用 `enable waf --param RuleAction=block`（与 svc-waf 相同）。`webacl-count`、`webacl-block` 在本卡重写：
   svc-waf 的同名检查用了 `[?(@.Name==…)]`，检测引擎的 JSONPath 子集（`platform/api/src/functions/checks/engine/jsonpath.ts`）不支持过滤表达式，会抛 SyntaxError；
   本卡改用 `where`（同名，svc-waf/entry-waf、block-not-at-origin 的 dependsOn 解析到本卡的版本）。另加 `webacl-rules`（8 条规则）与 `distribution-webacl`（WebACLId = 本会话 Web ACL ARN）。
6. **学员输入**：sc-event-fanout 文档的 `recipient-emails`（两个邮箱）改为 `notify-email` 的 `+u1`、`+u2` 别名——`seed-users.ts` 只接受一个 `--email`。
   种子用 `--count 2 --no-admins`，过滤策略只有 `userId`（与文档一致）。`ses-identity` 是能收信的邮箱地址（email hook 用 `--param Email=`）。
7. **SES 身份**：文档第 2 步“在 SES 控制台验证身份”并入第 3 步：`enable email --param Email=…` 由栈创建身份并轮询到“已验证”（已存在则只读接入，`keepablePrerequisites`）。
   种子用户在 outbox 档用验证码完成邮箱验证；SNS 邮件不经 SES，所以沙盒期不需要验证收件人。“验证码真正到达收件箱”用 ses-identity 地址注册（已注册时用“忘记密码”）。
8. **“SNS 邮件 vs SES 邮件”**：`POST /api/lab/notification/compare` 对比的是 db 与 sns 两个驱动，不是两种邮件；改为学员在邮箱里对照两封邮件（`sns-vs-ses-mail`，手动）。
   两个功能对照端点只在手册中作选读（不上传），端点由集成阶段登记。
9. **用户订阅**：迁移框架未接入，`enable notification` 带 `--no-migrate`，用户订阅用 `experiments/notification/subscribe-users.ts`；
   文档的 `sns:GetSubscriptionAttributes`（FilterPolicy）需要订阅 ARN，静态无法给出，改为 `ListSubscriptionsByTopic`（`user-subscriptions`：收件队列订阅 + ≥ 2 个已确认邮件订阅）+ 手动确认过滤策略。
10. **`notification-wired`、`email-wired` 在本卡重写**：检测引擎的 `pendingIf` 是“任一成立即等待”（`assert.ts isPending`），svc-notification 的写法会把任何 degraded 都当等待；
    本卡只用 detail 含“订阅待确认”判定等待。同名，svc-notification / svc-email 被引用检查的 dependsOn 解析到本卡的版本。
11. **选做步骤**：sc-event-fanout 增加“退信与投诉回流”（SES 邮箱模拟器，手动确认），对应文档的场景题 1 与“退信的地址要自动停止发送”。

### 3. 需要集成阶段处理的事项（共享文件或他人路径）

1. **labs:derive 的 DRV-6 与 hook 的 planHints**：`plan --start-of` 把 `module-hooks/*.planHints()` 的说明文字放进 `warnings`，derive 按字符串与 expectedWarnings 比较，
   所以 waf、email、notification 为目标的卡片（svc-waf、svc-email、svc-notification 与本节两张场景卡）在 `labs:derive`（scripts/module 推导器）与 `labs:build` 中各报 1～2 条 DRV-6 错误。
   建议 derive 只比较规则 ID 形式的警告（`^[A-Z]{2,5}-\d{3}$`，或去掉 `rules: ` 前缀后再比较；svc-identity-pool 的 `rules: DEP-013` 同源），说明文字另列为 note。
2. **参考推导器的 DEP-018**：`scripts/labs/src/derive/reference.ts` 对 `need: []` 的 warn 规则一律报警告；若按 rules.ts 的条件（入口未锁定）建模，sc-edge-protection 可以去掉卡片级的 DEP-018。
3. **svc-waf（labs/svc-waf，waf 实现者的路径）**：① `checks/waf.yaml` 的 `webacl-count`、`webacl-block` 用了引擎不支持的 `[?(@.Name==…)]`（见 2.5）；
   ② `assets/badge.svg` 是 svc-notification 的 SNS 徽章的复制品；③ `bypass` after 从工作台运行时，工作台就是 `CDN_ADMIN_CIDR`，80 端口必然可达（见 2.2）。
4. **scripts/labs 的数量测试**：`test/{lint,derive,build}.test.ts` 写死 10 张完整卡片 / 46 个占位；现在是 22 / 34。参考推导器下 build 测试另有 svc-logging、svc-monitoring 的 DRV-1（logs-ssm 已报告）。
5. **功能对照端点**：`/api/lab/notification/compare`、`/api/lab/email/compare` 与 `/api/lab/waf/origin`（waf 实验的服务端证据）都依赖集成阶段在 `http/app.ts` 登记 lab-routes（sns-ses、waf 已报告）。

### 4. 自测（2026-10-14，Windows 11 / Node 22.14.0；没有调用 AWS）

| 命令 | 结果 |
|---|---|
| `npm run labs:lint` | 56 张卡片 0 错误 0 警告（重新生成 catalog 之后） |
| `npm run labs:derive -- --card sc-edge-protection,sc-event-fanout` | 起始状态都是 iam（role）、preview on、部署等级 A、费用档位 低 / 低；只有第 3 节第 1 条的 DRV-6（hook 说明文字）。参考推导器（`--deriver reference`）0 错误 |
| `npm run labs:build` | 产物 195 个文件（dist/content/0.1.0-dev）；两张卡片的检查全部解析（31、32 项）；退出码 1，全部来自第 3 节第 1 条的 DRV-6（6 张卡片） |
| `npm run labs:catalog` | startable 22、planned 34 |
| `scripts/module --dry-run --state <scratch>`：`enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR=…/32`、`enable waf --with-deps [--param RuleAction=block]`、`enable email --with-deps --param Email=…`、`enable notification --with-deps --param AdminEmail=… --no-migrate`、`disable waf`、`disable email`、`plan --start-of sc-edge-protection / sc-event-fanout --platform --json` | 全部退出码 0（PublicHttpIngress open → admin-ip、AdminIngressCidr 写入基础栈参数）；空 state 下不带 `--with-deps` 时 waf 报 DEP-006、email / notification 报 CRED-001（卡片起始状态已预置 iam，按手册顺序 cdn 先于 waf） |
| `scripts/labs` vitest | 14 通过、3 失败——第 3 节第 4 条的数量假设（build 测试的参考推导器另报 svc-logging、svc-monitoring 的 DRV-1，与本节无关） |
| `npm run smoke:l0` / `smoke:selfhost` | 85 通过 0 失败 / 31 通过 0 失败（本节只改 labs/ 内容） |

## wave1-integration

第 1 波（notification、email、monitoring、cost、logging、shell-access、dns、tls、waf、identity-pool，以及场景卡片 sc-edge-protection、
sc-event-fanout）的集成与自测：处理各实现者小节“需要配合”中的共享文件改动，跑通全部回归，并用本地替身做一次 notification / email /
logging / monitoring 的集成冒烟。全程没有调用真实 AWS API、没有部署任何东西；`scripts/module` 只用 `--dry-run`（另把 AWS 凭证环境变量指向
无效值，即使误调用也不会到达 AWS）。没有新增 npm 依赖（`npm ls --workspaces` 无缺失，`package-lock.json` 未改）。

### 1. 处理的共享文件改动

| 来源 | 文件 | 内容 |
|---|---|---|
| sns-ses、cw-budgets、logs-ssm、waf、identity-pool | `backend/src/http/app.ts` | `ROUTE_MODULES` 加入 `adapters/{waf,monitoring,cost,logging,identity-pool}/lab-routes.ts`，放在 `admin.ts` **之前**（waf 的 `/api/admin/security/blocklist` 必须先于 admin.ts 的 `/api/admin/*` 404 兜底；实现者写的是“先于 lab.ts”，不够），因此也先于 lab.ts 的 501 兜底。waf 的 `register()` 同时把登记表的感知器接到 aws 驱动 |
| sns-ses | `backend/src/http/routes/lab-modules.ts` | `POST /api/lab/notification/compare`、`POST /api/lab/email/compare {to}`（仅管理员）；`adapterDepsOf(c)` 由容器拼出 compare 函数需要的 AdapterDeps；lab.ts 501 兜底的注释同步 |
| identity-pool | `backend/src/http/routes/lab-probe.ts` | `GET /api/lab/probe/identity-pool`（`identityPoolLabProbe`，经 `guarded()`），`PROBE_UNKNOWN` 的端点列表补上 |
| identity-pool | `backend/src/http/routes/uploads.ts` | `/api/uploads/credentials` 用 `idTokenOf(req)`（Cookie `ca_it` 或请求头 `X-CloudAlbum-Id-Token`）；令牌为空时交给驱动判断（`IDENTITY_DEV_PROVIDER` 下的本地账号走开发者身份，其余由驱动返回 401 `ID_TOKEN_REQUIRED`） |
| sns-ses、cw-budgets | `backend/src/worker.ts` | `startWorkerLoops` 第 4、5 步：sns / ses 驱动提供 `consume()` 时启动（收件队列与订阅同步、反馈队列）；`startAlertEvaluator`（本地告警，L0 也运行）与 `startCostIdle`。waf 的 IP 集合同步与 logging 的 Nginx 日志转发由驱动 `init()` 按 role=worker 自启（已确认 `d.lock` 在 waf 驱动创建之前注入） |
| cw-budgets | `backend/src/container.ts` | `caps.registerProbe('cost', …)`：cost 感知器在 local 档也给出本地估算的 detail（`localHealth`），svc-cost 的 `cost-local-baseline` 依赖它 |
| cw-budgets | `backend/src/config/load-env.ts` | CFG-010 的 cost-rates 读取：`COST_RATES_FILE` 覆盖默认位置；接受文档格式 `entries:`，兼容 `rates:` 与顶层数组（与 `adapters/cost/estimate.ts` 一致） |
| cw-budgets | `infra/host/security-snapshot.sh` | 单元列表加入 `amazon-cloudwatch-agent`（ec2 感知器只评估 api / worker / 定时器，不受影响） |
| sns-ses | `backend/src/cli.ts`、新增 `backend/src/cli/migrate-module.ts` | `migrate-module notification plan|up|down|verify [--dry-run]` 接到 `adapters/notification/migrate.ts`，见第 2 节第 1 条；其余模块仍以退出码 2 报“尚未实现” |
| route53-acm、identity-pool | `modules/registry.yaml` → `gen:registry` | tls 的 injects：cdn `Aliases: ${Out.InfoEdgeAliases}`、load-balancer `DomainName: ${Out.InfoRegionalDomainName}`（只有对应证书栈存在时才有值，先 tls 后 cdn 不再触发 `AliasNeedsCertificate`）；identity-pool 的 degraded 徽章改为“临时凭证不可用，已改用应用自签令牌（EC2）”（与实现、模块文档第 11 节表格一致） |
| route53-acm | `scripts/module-cli/src/{module-hooks/types.ts,disable.ts,index.ts}`、`module-hooks/dns.ts` | `disable --purge` 传入 `HookArgs.purge`；dns 在 `--purge` 或 `--param PurgeHostedZone=true` 时删除自己新建的托管区域（通用流程的 `--purge` 仍未实现，提示文字已说明） |
| cw-budgets | `scripts/module-cli/src/index.ts`、`module-hooks/cost.ts` | 新子命令 `scripts/module cost activate-allocation-tags [--keys Project,Module]`：平台动作 cost-activate-tags 的执行体；学员身份退出码 2（`PLATFORM_ACTION_REQUIRED`）；某个键暂时不能激活时逐键报告，退出码 1 |
| identity-pool | `scripts/module-cli/src/ops.ts` | 平台预览方案 B 开启时，通用注入的 `AppOrigins` 同时含 `http://<EIP>` 与 `https://<EIP>`（storage 原图桶等所有浏览器侧 CORS；此前只有 identity-pool 的 hook 给自己补上） |
| sns-ses | `scripts/module-cli/src/module-hooks/notification.ts` | 迁移说明随第 2 节第 1 条更新 |
| cw-budgets | `scripts/labs/src/lint/card.ts` | A12：`inputs` 在 `fillFrom` 检查之前声明（原先任何带 `fillFrom` 的变量都会触发 TDZ 错误） |
| cw-budgets、logs-ssm | `scripts/labs/src/derive/plan.ts` | DRV-10：摘要对象中 runtime 项的值按 scripts/module 解析 `PROFILE_RUNTIME` 的方式取类型（`true` 而不是 `"true"`），见第 2 节第 3 条 |
| logs-ssm | `scripts/labs/src/derive/reference.ts` | 参考推导器在单服务卡片上也接受声明的 `kind: runtime` 项（与 plan-start 第 6 步相同），消除 svc-logging、svc-monitoring 的 DRV-1；runtime 项的缺省值为 `true`（与 plan-start 相同） |
| route53-acm、identity-pool、scenarios | `scripts/labs/src/derive/index.ts` | DRV-6 只比较规则形式的警告（`warningRuleId`：`DEP-018`、`rules: DEP-013`、`waf: DEP-018 …`、`DRV-5: …`），hook `planHints` 等自由文本不再被当作“未声明的 expectedWarnings” |
| 全部 | `scripts/labs/test/{lint,derive,build}.test.ts`、`experiments/test/manifest.test.ts`、`scripts/module-cli/test/helpers.ts`、`platform/api/src/dev/smoke-platform.ts` | 数量假设改为 22 张可开始、34 张规划中，实验清单覆盖 18 个模块；`ALLOW_PENDING_WAVE1_TEMPLATES = false`（10 个模板都已就位） |
| 全部 | `labs/_catalog/catalog.yaml` | `npm run labs:catalog`：startable 22、planned 34（registry 改动后重新生成） |
| scenarios（他人路径） | `labs/svc-waf/**`、`experiments/waf/{bypass.ts,lib.ts,README.md}`、`backend/src/modules/detectors/cdn.ts` | ① `webacl-count`、`webacl-block` 改用 `where`（检测引擎不支持 `[?(...)]`）；② 徽章换成本卡自己的 WAF 徽章；③ `bypass` after 的误报：cdn 感知器在 admin-ip 时于管理员视图的 data 中给出 `adminCidr`，场景经直连请求 `/api/lab/echo` 取源站看到的客户端地址，落在白名单内记 `directAllowedAsAdmin=true`，仍判为已锁定（服务端证据，不只看客户端能否连上）；手册 45 与 CHANGELOG 同步（版本仍为 1.0.0，属发布前修订） |

### 2. 设计有歧义时的取舍

1. **notification 的迁移只接通一半**：通用迁移框架（`scripts/migrate/_lib`：同时实例化源驱动与目标驱动）还不存在，而 `enable` 的第 6 步在写入
   modules.d 之前运行，实例上的进程仍是 `NOTIFY_DRIVER=db`，构造不出 SnsNotifier。因此 `migrate-module notification up` 要求当前驱动是 sns
   （否则退出码 2 并给出做法）；`enable notification` 仍需 `--no-migrate`，切换后在实例上执行 `node dist/cli.js migrate-module notification up`
   （或照旧用 `experiments/notification/subscribe-users.ts`）。`disable` 的第 3 步此时仍是 sns，可以直接运行 `down` + `verify`。`verify` 不带方向，
   取最近一次 up / down 写在 `system_meta`（`migrate.notification.lastDirection`）的方向，没有记录时按当前驱动推断。卡片与 hook 的 `--no-migrate` 用法不变。
2. **路由位置**：第 1 波的 lab-routes 一律放在 admin.ts 之前（见第 1 节），各文件自带 `requireAuth + requireAdmin`，不依赖 lab.ts 的 `app.use('/api/lab', …)`。
3. **DRV-10 的修法**：cw-budgets 建议改 `derive/cli.ts`，但 `PlanEntry.value` 本来就是字符串，问题在于“同一个值在两边类型不同”：scripts/module 从
   lab.yaml 读到布尔值 `true`，从档位文件读回时也用 `runtimeValue()` 转成布尔值。因此在 labs 侧的 `digestObject()` 对 runtime 项做同样的类型化，
   参考推导器与 scripts/module 两条路径得到相同的摘要。
4. **DRV-6 只认规则 ID**：说明文字里带规则 ID（例如 waf hook 提示末尾的 `(DEP-018)`）不算规则警告；规则本身由规则引擎或参考推导器以 ID 形式给出。
5. **svc-waf 的 bypass**：不改成“从工作台以外的地址探测”（工作台本身就是管理 IP，换不了源地址），而是用服务端看到的客户端地址判定；
   sc-edge-protection 仍按其小节第 2.2 条不使用 bypass。
6. **identity-pool 的徽章文字**：模块文档第 11 节的表格与同一节的 registry 摘录互相矛盾（摘录写“已退回逐文件上传”），取与故障语义一致的表格文字。

### 3. 没有处理、留给后续的事项（均为“可选”项，或需要实机资料）

- `labs/_pricing/dimensions.yaml` 的 ACM ACME 计费维度：Price List 的 serviceCode 与过滤属性要以实际返回为准（07 要求每个维度由 atl-pricing 的集成测试命中价格），
  本机不能调用 AWS，猜测属性名等于编造，所以没有加；svc-tls 的 cost.basis 照旧只写起始状态与工作台。
- `scripts/labs/src/registry.ts` 的 `replaceTemplates` 样本值带点：dns / tls 卡片已改用不需要它的写法，改样本值会影响全部卡片的检查参数校验，没有动。
- 参考推导器按 rules.ts 的运行期条件建模 DEP-018（之后 sc-edge-protection 可以去掉卡片级的 DEP-018）：没有做，卡片声明不影响结果。
- tls 感知器的 `via` / `trusted` 覆盖 `capabilities.https`（`setHttps()`）：握手瞬时失败时观测值会来回变化，且 `cf-default` 的语义与 `httpsState()` 不同，
  需要先统一约定，没有做。
- error5xx 故障豁免 `/api/health/*` 与 `/api/lab/*`：会改变 MVP 实验以及将来 ALB 健康检查实验对故障的预期；monitoring 已改用合成 5xx 端点，没有做。
- `enable.ts` 的 `previewEnv` 静态输出不读用户参数（email hook 已绕过）、`container.close()` 调用 `loggerPort.close?.()` 与 `blocklist.close?.()`（相关定时器都已 unref）、
  前端 `/lab` 的 identity-pool 卡片：没有做。
- `platform/infra/policies/generated/verifier-readonly.json` 不在仓库中：`npm run labs:policy` 对当前内容生成 53 个只读动作、0 个被拒（含 wafv2、sesv2、sns、logs、
  cloudwatch、budgets、ce、route53、acm、cognito-identity），平台部署前要按平台发布流程生成。

### 4. 本地集成冒烟（notification、email、logging、monitoring）

- **LocalStack 不可用**：本机没有 `localstack/localstack` 镜像（已用 `docker images` 核对），本阶段不拉取镜像（下载需要用户同意，C 盘剩余空间也只有约 22 GB）。
  `scripts/smoke/minicloud.mjs` 只实现了 S3（经 MinIO）、SQS、STS、IAM，没有 SNS、SES v2、CloudWatch、CloudWatch Logs 的协议。
- **改用本地替身**：新增 `backend/test/integration/wave1-local-smoke.test.ts`（随 `npm test` 运行）。替身是内存 SNS / SQS / CloudWatch Logs（各实现者的 `fake-*.ts`），
  加上 aws-sdk-client-mock 的 SES v2、CloudWatch、STS、IAM。modules.d 用 `scripts/module enable --dry-run` 计划出的同一组键（栈输出换成真实形状的值，
  `IAM_CREDENTIALS=keys` 的测试密钥只交给 mock），走完整装配：分层加载 + zod + 规则引擎 → api 与 worker 两个容器（共用 SQLite）→ createApp →
  `startWorkerLoops`。结果 6/6：
  - capabilities（管理员视图）：notification `sns` ok；email `ses` degraded（“沙盒：只能发给已验证地址 · 今日已发 0 / 上限 200…”）；logging `cloudwatch` ok；
    monitoring `cloudwatch` degraded（keys 模式 CRED-002：Agent 不可用）；iam degraded（CRED-002）；第 1 波模块都不是 error。
  - email：本地注册的验证邮件经 `SendEmail(Content.Raw)` 发出（配置集 `cloudalbum-lab-email`，MIME 含 `X-CloudAlbum-Transport: ses`），路径头 `email=ses:…`，
    `outbox_emails.transport=ses`；反馈队列中的 Permanent Bounce 由 worker 的 `consume()` 处理，`delivery_status` 与 `users.email_status` 变为 bounced。
  - notification：评论 → 站内信 + 一次 Publish（消息属性 `userId` = 照片主人、`eventType=comment.created`），路径头 `notification=sns:…`；SNS → 收件队列
    （原始消息传递）→ worker `consume()` 记 `sqs-copy`，队列清空。
  - logging：应用日志经发送器进入 `/cloudalbum/lab/app` 的 `{instanceId}/api` 流，内容与本地 JSON 行相同。
  - monitoring：`PutMetricData` 全部写入命名空间 `CloudAlbum/App`。
- 另有 `backend/test/http/wave1-routes.test.ts`：经 `createApp` 访问各模块的侧路端点（管理员 200、普通用户 403），两个功能对照端点在 L0 下的行为，
  以及 cost 在 local 档的探针 detail。

### 5. 自测（2026-10-14，Windows 11 / Node 22.14.0 / Docker 28.3.2；没有调用 AWS）

| 命令 | 结果 |
|---|---|
| `npm run build` / `npm run lint` | 通过 / 0 个问题 |
| `npm test` | 216 个文件通过、1 个跳过；2684 个测试通过、18 个跳过（需要外部服务），0 失败（集成前为 4 个文件失败，都是第 1 波各小节列出的数量假设） |
| `npm run registry:check` | OK：40 个模块，85 条规则，52 处规则引用，2 个既有警告 |
| `cfn-lint --regions ap-northeast-1 us-east-1 -- infra/modules/*.yaml`（1.57.2，`D:/workspace/.tools/cfnlint-venv`） | 20 个模板 0 发现 |
| `npm run labs:lint` / `labs:derive` / `labs:build` / `labs:catalog` / `labs:policy` | 56 张卡 0 错误 0 警告 / 22 张卡 0 错误 0 警告（scripts/module 推导器）/ 56 张卡 0 错误、195 个文件 / startable 22、planned 34 / 53 个动作、0 个被拒 |
| `scripts/module --dry-run`：10 个模块各执行 `enable <id> --with-deps`、`disable <id>`（状态文件由同一代码的 dry-run enable 生成）、`plan <id> --single`、`plan --start-of svc-<id>` | 40 次全部退出码 0（notification 带 `--no-migrate --param AdminEmail=…`；email 带 `--param Email=…`；cost 带两个预算金额参数；dns / tls 带 `--domain album.example.com`；shell-access 的 disable 带 `--reopen-ssh --param SshIngressCidr=…`）。核对计划：waf 先 cdn 再 `waf-edge [us-east-1]`；notification 的 disable 第 3 步运行 `migrate-module notification down` + `verify`；identity-pool 依次 iam、auth、storage |
| 同上，按设计应拒绝或跳过的情形 | email 没有身份、dns / tls 没有域名时 enable 退出码 2 并给出提示；dns / tls 没有域名时 `plan --single` 打印提示后跳过（0）；shell-access 22 已关闭且没有 `--reopen-ssh` 时 disable 退出码 2；monitoring 不带 `--with-deps` 退出码 2（CRED-001）；`disable dns --purge` 删除托管区域（0）；`plan --start-of sc-edge-protection`、`sc-event-fanout`、`svc-tls --variant acme-off` 退出码 0 |
| `scripts/module --dry-run cost activate-allocation-tags` | 打印 `ce:UpdateCostAllocationTagsStatus`（Project、Module），退出码 0；非法键退出码 2 |
| `npm run smoke:l0` / `smoke:selfhost` | 85 通过 0 失败 / 31 通过 0 失败 |
| `npm run smoke:platform` | 120 / 120 通过（目录：22 张可开始、34 张规划中） |
| `npm run e2e:platform` | 51 / 51 通过 |

### 6. 与 07 验证计划的对应关系

07 是按 MVP 与 6 张走查卡片编写的，第 1 波模块大多没有专门条目。下表列出已有条目与实现的对应，以及执行时要按代码改写的地方（07 本身不在本阶段修改）：

| 模块 | 07 中的条目 | 对应关系与差异 |
|---|---|---|
| waf | V5-7a（`waf-edge` 栈，Count 模式）；3.5 的 us-east-1 WAF 残留核对；修订记录 Y-2 | `enable waf` 部署 `cloudalbum-<env>-waf-edge`（us-east-1，CLOUDFRONT 范围），与 07 一致。差异：07 第 4 步的“`DirectAccess=admin-ip`”在代码中是 `scripts/module enable cdn --set CDN_DIRECT_ACCESS=admin-ip --set CDN_ADMIN_CIDR=<ip>/32`；第 6 步的 `scripts/module set waf WAF_RULE_ACTION=block` 在代码中是 `scripts/module enable waf --param RuleAction=block`（没有 set 子命令）。日志组 `aws-waf-logs-cloudalbum-<env>` 为 Retain，disable 后保留，再次 enable 时接管 |
| tls | V0-4、V3-5（ACME 端点）；V5-8 第 6 步（`tls-edge`，有域名时）；U47 | hook 的 preflight `acme-endpoint` 调用 `acm:ListAcmeEndpoints`，结果写成 `TLS_ACME=on|off`（对应 02 预检键 `preflight.tlsAcme` 与 svc-tls 的 `acme-off` 变体）；V3-5 的签发与吊销对应 `infra/modules/tls/host-setup.sh` 的 `issue-acme`、`revoke-acme`、`purge-acme` |
| dns | V5-8 第 5～7 步（有域名时）；第 11 节的 Route 53 托管区域 | 新建的托管区域默认 Retain 并记入 `outOfBand`，`disable dns --purge` 才删除；没有域名时 enable 退出码 2、plan 跳过 |
| cost | V0-2（预算）、V0-3 与 U59（成员账号下 Budgets / Cost Explorer 的可用性）、D17、V6-4、13.3 第 11 条 | 模块创建项目预算与账号预算（金额由学员决定）；Cost Explorer 只在显式确认（`ce-charges`）后调用；标签激活经 `scripts/module cost activate-allocation-tags`（Organizations 中只有管理账号能激活）；svc-cost 的 `tag-active` 检查调用 `ce:ListCostAllocationTags`（结果缓存 30 分钟，drift once） |
| email | 1.3 的“SES 沙箱”、V0-3（`sesv2 get-account`） | 发件身份是人工前置（`--param Email=` 或 `--param Domain=`）；沙盒期收件人也要验证；身份可以保留，再次 enable 时接管（`AdoptExistingIdentity`） |
| notification | 第 11 节的 SNS；C9（发送通知需用户确认） | 运维订阅与用户订阅都要收件人点确认链接（人工前置 confirm-email） |
| logging、monitoring | 第 11 节的 CloudWatch Logs | 没有专门条目；monitoring 的 SNS 主题、告警与仪表板随栈删除，已上报的自定义指标只能等保留期过期 |
| shell-access | 阶段 2（V2-x）验证的是平台自己的浏览器 SSM 通道，不是本模块；D23 | 没有专门条目；本模块的防锁死顺序（附加策略 → Agent Online → Run Command 冒烟 → 才关闭 22）只在 dry-run 与桩中验证过 |
| identity-pool | 修订记录 Y-2（身份池的残留核对）；U48 属于 auth | 没有专门条目；暂存桶的 DeletionPolicy 为 Delete，disable 先清空 |

### 7. 下一次真实 AWS 验证建议覆盖的项（按风险排序）

沿用 2026-10-14 简易实机验证的方式（L0 → 逐个 enable → 冒烟 → disable → 全量回收），每项都按 07 第 12 节先取得用户同意：

1. **shell-access 的防锁死顺序**（风险最高）：在真实 AL2023 上 `enable shell-access`（SSM Agent 为 Online、Run Command 冒烟成功后才关闭 22），
   用 Session Manager 以 `cloudalbum-ops` 登录并核对 sudoers 规则（`visudo -cf` 只在容器里用桩跑过），`disable shell-access --reopen-ssh` 先经 ssh 验证再撤销。
   任一步失败都要能回到“22 仍开放”的状态。
2. **主机侧脚本第一次在真实实例上运行**：logging / monitoring 的 CloudWatch Agent（`dnf install amazon-cloudwatch-agent`、两个片段 `append-config` 共存、
   `remove-config`），tls 的 certbot 虚拟环境（`pip` 与 `dnf` 回退）与续期定时器 drop-in，dns 的 canonical 跳转片段。这些脚本只做过 `bash -n` 或容器内的桩测试；
   同时核对 security-snapshot 中 `amazon-cloudwatch-agent` 的单元状态出现在 monitoring 探针里。
3. **notification + email**（需要用户的真实邮箱作为 SES 身份并点击验证；沙盒）：Publish 与过滤策略、订阅确认、收件队列与反馈队列由 worker 消费、
   SES 邮箱模拟器的退信回流；`enable notification --no-migrate` 后在实例上执行 `migrate-module notification up`，`disable notification` 第 3 步的 `down` + `verify`；
   两个功能对照端点。
4. **waf**：按 07 V5-7a 做独立模式版：`waf-edge` 在 us-east-1 的创建与更新（count → block）、CloudFront 关联、worker 的 IP 集合同步、
   `bypass` after 从管理 IP 运行时 `directAllowedAsAdmin=true`、CloudShell 直连超时、disable 后日志组保留与再次 enable 时接管。
5. **logging / monitoring 的时间特性**：摄取延迟、Logs Insights 扫描字节、PutMetricData 到指标可见的延迟、心跳缺失告警的触发时间
   （time-to-alert、kill-test），把实测值回写模块文档。
6. **identity-pool**：auth=cognito 下浏览器 SigV4 直传暂存桶（CORS、`X-CloudAlbum-Id-Token`）、`CopyObject` 导入、写别人前缀被拒；平台预览方案 B 下
   `https://<EIP>` 已在 CORS 中（本阶段 ops.ts 的改动）。
7. **cost**：预算与通知（金额由用户决定）、标签激活（当前账号是 Organizations 的管理账号，可以激活）、预算动作只指向金丝雀角色；Cost Explorer 的调用逐次征得同意。
8. **dns / tls**：用户没有自有域名时，只验证“没有域名时 enable 退出码 2、plan 跳过并提示”，以及 V3-5 的无域名路径（ACME 端点、EAB、账户注册需要用户同意服务条款）；
   有了域名再补 Route 53 委派、ACME 签发与 `tls-edge`。
9. **平台模式**：目录显示 22 张可开始卡片；部署前按发布流程生成 `verifier-readonly.json`（第 3 节最后一条），核对学员边界与护栏是否放行第 1 波卡片
   用到的服务（wafv2、sns、sesv2、logs、cloudwatch、budgets、ssm、route53、acm、cognito-identity）；至少走查 svc-waf 与一张不需要域名的第 1 波卡片。

## wave1-fix

第 1 波评审意见的修复（5 项 medium、9 项 low）。全程没有调用真实 AWS API、没有部署任何东西：只用单元测试、aws-sdk-client-mock、
cfn-lint 1.57.2（`D:/workspace/.tools/cfnlint-venv`）与 `scripts/module --dry-run`。

### 1. 修复一览

| 严重度 | 问题 | 修复 | 位置 |
|---|---|---|---|
| medium | 独立模式下 shell-access 之后启用 tls：EAB 的 SecureString 交接参数实例读不到（AgentCore 没有 Parameter Store 读取） | 采用评审方案 (b)：shell-access 的 AppPolicy 增加无条件语句 `HandoffRead`（`ssm:GetParameter`，只限 `parameter/cloudalbum/${Env}/handoff/*`）；tls 的 `host-setup.sh issue-acme` 读不到参数时输出明确的 JSON 原因，不再被 `set -e` 直接打断；07 V3-5 增加“先 shell-access 再 tls”的组合步骤 | `infra/modules/shell-access.yaml`、`infra/modules/tls/host-setup.sh`、`module-hooks-tls.test.ts`（独立模式 + SSM 通道 + 实例策略）、07 V3-5 第 4 步 |
| medium | sudoers 参数位置的 `*` 可以匹配包括空格在内的任意字符（`journalctl -u cloudalbum-*` 等于放行 `--vacuum-time`、`-u sshd`） | 逐条列出完整命令（单元只有 `cloudalbum-api`、`cloudalbum-worker`；`--no-pager` 必带，root 身份的 pager 可以打开其他文件）；渲染时拒绝任何通配符；新增 `host-setup.sh render` 供审阅与测试 | `infra/modules/shell-access/host-setup.sh`、`module-hooks-shell-access.test.ts`、实验 README、05 第 433 行与第 226 行、卡片 40-session |
| medium | waf 应用策略可以改写 allow-lab IP 集合（优先级 0 的 Allow） | `SyncIpSets` 只授予 `BlockIpSet`；allow-lab 只由栈参数 `LabAllowCidr` 维护；测试断言应用策略不引用 `LabAllowIpSet` | `infra/modules/waf.yaml`、`module-hooks-waf.test.ts` |
| medium | degraded + transient 永远不会升级为 error；`enable` 第 10 步把它当作通过 | 评审方案 (a)：状态机对 `transient` 结果（无论适配器报 error 还是 degraded）累计连续失败，连续 3 次进入 error；管理员视图的 `data.transient=true` 标出最近一次是瞬时失败；`parseProbe` 把 degraded + transient 当作未通过，继续轮询到超时（失败信息提示 NAT / 端点 / 出站 / `AWS_ENDPOINT_URL` / IMDS hop limit） | `backend/src/modules/capabilities.ts`、`scripts/module-cli/src/health.ts`、`enable.ts`、`capabilities.test.ts`、`scripts/module-cli/test/health.test.ts` |
| medium | SES、SNS、identity-pool、waf、cost、dns 的探针在 2 秒预算里直接 await `withAwsRetry`（单次 3 秒），内部重试跑不到 | 新增 `adapters/aws/background-probe.ts`（`BackgroundProbe`，与 shell-access / logging 相同的 stale-while-revalidate）：慢探针函数放进后台 Promise，常规探针最多等 1.5 秒、深度 4 秒；没等到时返回上一次结果（不超过 2 分钟，detail 注明“显示 n 秒前的结果”，`data.staleMs`）或 degraded + transient 占位；超过 60 秒仍未结束的调用视为挂起。SES、SNS、identity-pool、dns 包住整个探针；cost 只包 budgets 档的控制面部分（本地清单每次重算并覆盖）；waf 在感知器的 `controlPlane()` 内做后台刷新（完整重试 3 × 3 秒，失败的视图不缓存），深度事实与控制面等待并行。另外启动后的前 120 秒是宽限期：瞬时失败不累计连续失败次数 | `backend/src/adapters/aws/background-probe.ts` 与 6 个适配器 / 感知器、`background-probe.test.ts`、`detector-waf.test.ts` |
| low | regional ACL 用 X-Forwarded-For 的第一个地址（客户端可控） | IP 集合引用改为 `Position: LAST`（CloudFront 追加的是真实查看者地址）；`RateKey=FORWARDED_IP` 时去掉两条限速规则（WAF 的 FORWARDED_IP 聚合取第一个地址），限速留在 CLOUDFRONT ACL；hook 与输出 `InfoRateKey` 说明 | `infra/modules/waf.yaml`、`module-hooks/waf.ts` |
| low | `x-amzn-waf-cloudalbum: inspected` 可以由客户端伪造 | 部分修复（见第 2 节）：svc-waf 增加控制面检查 `distribution-webacl`（`GetDistributionConfig` 的 `WebACLId` 等于本会话 ACL）；感知器的被动信号改为比例（经入口的请求中带头的比例 < 0.5 才判“未关联？”），一个伪造的请求不再抵消它 | `labs/svc-waf`、`backend/src/modules/detectors/waf.ts` |
| low | `openSession` 就标记 `cognito:sts`，`sts-path-seen` 只开会话也能通过 | `openSession` 改标 `cognito:session`；`cognito:sts` 只在 `credentials()` 成功与 `complete()` 导入时出现；卡片 70-ab、`bypass-paths` 选项与 `sts-path-seen` 的说明同步 | `adapters/identity-pool/cognito.ts`、`labs/svc-identity-pool` |
| low | 重新启用后 `users.identity_id` 属于已删除的旧池 | 存成 `<IdentityPoolId>|<identityId>`，池 ID 不一致（或旧格式）视为没有；开发者认证身份收到 `ResourceNotFoundException` / `InvalidParameterException` 时去掉 IdentityId 重试一次并覆盖存储值；whoami 只显示当前池的 identityId；hook 与卡片 95-cleanup 的提示改正 | `cognito.ts`、`lab-routes.ts`、`module-hooks/identity-pool.ts` |
| low | SNS 应用策略的 Subscribe / SetSubscriptionAttributes 不限协议 | `Subscribe` 单独成句并加 `StringEquals sns:Protocol = email`；`SetSubscriptionAttributes` 没有这个条件键，只授予订阅 ARN（`${EventsTopic}:*`），适配器 `setFilterPolicy()` 先确认订阅协议为 email | `infra/modules/notification.yaml`、`adapters/notification/sns.ts` |
| low | 运维策略缺少会话数据密钥的 `kms:GenerateDataKey`；复用未加密的日志组时 `cloudWatchEncryptionEnabled=true` 会让会话日志写入失败 | `operator-policy.json` 增加可选语句 `SessionDataKms`（启用 kms 时替换 `${KmsKeyArn}`，否则删除），plan notes 与 afterDeploy 提示；复用日志组时用 `logs:DescribeLogGroups` 看 `kmsKeyId`，未加密就不打开 `cloudWatchEncryptionEnabled`（`kmsKeyId` 仍用于会话数据）并提示 `associate-kms-key` | `infra/modules/shell-access/operator-policy.json`、`module-hooks/shell-access.ts` |
| low | dns 的 beforeDisable 没有防护 email 的 DKIM / MAIL FROM 记录 | 比照 tls：email 为 aws 档、Domain 非空且 `HostedZoneId` 等于本区域时拒绝（`DNS_IN_USE`）；`--param Force=true` 时打印需要在外部 DNS 补回的 DKIM 记录（`InfoDkimRecords`）与 MAIL FROM 提示 | `module-hooks/dns.ts` |
| low | SES 进程内限速，api + worker 合计可能超过账号速率，被节流的邮件不重试 | 对 `Throttling` / `ThrottlingException` / `TooManyRequestsException` / HTTP 429（“Maximum sending rate exceeded”）退避重试最多 3 次（1、1.5、2 秒；SES 没有接受这封邮件，重试是安全的），其他错误不重试；探针 data 增加 `throttledRetries` | `adapters/email/ses.ts` |
| low | 独立模式下 shell-access 之后，需要机密的模块一律以 “carries secret values” 失败 | 三种做法都做了一部分：(1) 独立模式的 SSM 通道也启用 SecureString 交接（`SsmDeliverer` 第 5 个参数，前缀 `/cloudalbum/<env>/handoff/<随机>`，实例靠 `HandoffRead` 读取），只写 `secrets.env` 的步骤可以经 SSM 完成；(2) shell-access 的 plan notes 与卡片 30-wire 写明“只写不读”的限制与替代做法（`KeepSsh=true` + `--delivery ssh`，或 `disable --reopen-ssh`）；(3) `readRemoteSecrets()` 在独立模式 + SSM 通道时提前给出 `SECRETS_READBACK_OVER_SSM` 与指引 | `context.ts`、`deliver.ts`、`hooks.ts`、`module-hooks/shell-access.ts`、`cli.test.ts` |

### 2. 决定与遗留

1. **后台刷新的放置位置**：没有放进能力注册表统一包装所有探针源（会改变 L0 模块与现有测试的时序语义，永不返回的探针也需要另外的放弃策略），
   而是做成 `BackgroundProbe` 辅助类，由评审列出的 6 个模块各自使用。monitoring 的告警主题读取本来就带 15 分钟缓存且只影响 notes，未改；
   tls 的常规探针只做 TLS 握手（不经 `withAwsRetry`），未改。
2. **宽限期与 cli probe**：`node dist/cli.js probe` 每次是新进程，始终处于启动宽限期，所以瞬时失败在 cli 中只会是 degraded + transient；
   `enable` 第 10 步据 `data.transient` 继续轮询（最多 120 秒），不再误判成功。
3. **`x-amzn-waf-cloudalbum` 的伪造只做了部分修复**。彻底的做法是让 WAF 插入一个带机密的令牌（栈参数 NoEcho），Nginx 只认这个精确值——但
   `$ca_entry` 的 map 在 ec2 所有的 `00-entry.conf` 中，模块只能填写 ec2 预留的槽位（00 的 6.7、E9），需要 ec2 新增槽位
   `slot-waf-inspected.inc`（map 数据，root 0600，由 waf hostSetup 从 `secrets.env` 渲染）并改写 `$ca_entry` 的判断，`install-host-files.sh`
   预建空槽位。这是 ec2 基础契约的修改，**交集成阶段处理**；在那之前，入口链里的 waf 段只是“源站收到了这个头”，关联由控制面检查证明。
4. **identity-pool 的路径段新增 `cognito:session`**：总纲 §7 的路径值表与 02 第 85 行、第 1016 行仍写着会话请求为 `cognito:sts`，**需要集成阶段同步设计文档**
   （值表增加 `cognito:session`；A/B 对照的“不带旁路头”改为 `cognito:session`）。02 第 1023 行“`users.identity_id` 列保留，重新启用时可以继续使用”
   也应改为“保留但绑定池 ID，重新启用后自动视为没有”。
5. **共享文件的改动**（本轮为修复评审意见直接修改，提请集成阶段复核）：`scripts/module-cli` 公共部分的 `context.ts`、`deliver.ts`、`hooks.ts`、
   `health.ts`、`enable.ts`；`backend/src/modules/capabilities.ts`。没有修改 `modules/registry.yaml`、`backend/src/config/schema.ts`、
   `implemented.ts`、`container.ts`、`packages/contracts`、根目录 `package.json`。
6. **sudoers 未在真实 sudo 上校验**：本机的 Docker 镜像都没有 sudo / visudo（安装需要下载，未做）；`host-setup.sh apply` 仍先 `visudo -cf` 再安装。
   第 7 节第 1 条的实机验证应补一条 `sudo -l -U cloudalbum-ops` 与 `sudo journalctl -u cloudalbum-api --vacuum-time=1s` 被拒绝。

### 3. 验证

| 命令 | 结果 |
|---|---|
| `npm run build`、`npm run lint` | 通过 |
| `npm test` | 本节改动涉及的 backend、module-cli、experiments 三个项目 100 个文件 1361 项全部通过；全量运行时 ssm-client 的 `mock.test.ts`“survives a dropped connection”在并行负载下等待超时（前文已记录的偶发项，单独运行通过），另有一次 atl-web 的 `App.test.tsx` 超时（同一工作区里另一个会话正在修改 `platform/web` 的 i18n，单独运行通过）；两者都不在本节的改动范围内 |
| `npm run smoke:l0`、`npm run smoke:selfhost`、`npm run smoke:platform` | 通过（smoke:platform 120 / 120） |
| `npm run labs:lint`、`npm run labs:derive` | 56 张卡 0 错误 0 警告；22 张卡推导 0 错误 |
| `cfn-lint --regions ap-northeast-1 us-east-1 -- infra/modules/*.yaml` | 0 发现 |
| `scripts/module plan shell-access|waf|tls --single --dry-run`、`plan --start-of svc-shell-access|svc-waf --dry-run` | 退出码 0；tls 没有域名时给出提示并跳过 |

## i18n-prep-visual

视觉组件（I6 a、b，以及 e / f 用到的基础图形）：服务图标集、自动架构图、步骤类型 / 指标图标、进度环、条形图、组件展示页。
规格见 docs/platform/09-i18n-and-visual.md「视觉组件」。只新增 `platform/web/src/ui/{glyphs,diagram,charts}/**`、
`platform/web/src/dev-gallery/**`、`platform/web/scripts/gen-glyph-registry.{mjs,d.mts}`，没有修改任何页面。

有歧义时的取舍（都取最简单的做法）：

| 问题 | 决定 |
|---|---|
| “40 个模块按 A～F 六组配色”，但 registry 中 ec2 的组是 `base` | 用已有的 7 个类别 token：A～F 六色 + 中性的 `--cat-base`（ec2）；不新增 token |
| 组色在色觉模拟下不能两两区分（dataviz 校验器：deutan ΔE 2.0） | 组色只作辅助编码（与 05 §2.10 一致）；服务身份靠图案，组靠几何符号（≥ 40px 徽章左上角）。对比度全部 ≥ 3:1（文字 ≥ 4.5:1） |
| 16px 下缩写不可读 | < 40px 只画图案；≥ 40px 徽章模式才带缩写与组符号 |
| “registry 中的依赖”怎么用 | 生成脚本把 requires 推成 hard / cond / anyOf：hard 用于依赖闭包（缺的模块以“依赖带入”画出）与补充点线；`severity: warn` 不算硬依赖。主请求路径与附着关系是 `model.ts` 中手写的固定规则 |
| “入口类型”没有现成字段 | 同一状态里有 load-balancer 就以 ALB 为入口，否则画 EC2 上的 Nginx（两者共用一个格位）；CloudFront 在边缘泳道 |
| VPC 画在哪条泳道 | 不占泳道，画成包住入口～数据泳道的边界框 |
| “开始时”怎样体现“有 vs 没有” | 目标模块有本地实现（`from` ≠ none）时，在完成后的同一格位画 ghost（虚线框 + 驱动名）；两张图共用并集布局 |
| 运维与安全泳道的连线 | 横切关注点，不画连线（否则线太多） |
| 组件展示页 `/__dev/gallery` | `/__dev` 已代理给 API；改为独立的开发入口 `/src/dev-gallery/`，不改路由表与 vite.config.ts |
| i18n 框架并行开发 | 视觉组件自带 `visual.*` 键的三语词典与 `VisualI18nProvider`（外部 translate → 内置所选语言 → en → zh-CN）；没有 Provider 时跟随 `<html lang>`，默认 ja |
| 生成脚本要“构建时生成” | 生成文件提交进仓库；单元测试逐字比较、`--check` 供 CI；没有改 `platform/web/package.json`（不在范围内），建议集成时挂进 build |
| BarChart 的“查看数据表” | 直接用 `<table>` 画条形图（行标题 + 装饰条 + 数值），图表本身就是数据表；条宽用 SVG 属性（CSP 不允许 style 属性），因此条端不做圆角 |

自测：`npx vitest run src/ui/glyphs src/ui/diagram src/ui/charts`（3 个文件 36 个用例通过，含 7 个快照；platform/web 全量运行时 workspace / App 的部分用例在并行负载下 1 秒超时——这些文件正由 i18n 会话修改，单独运行 61 / 61 通过）、`npx eslint` 本节路径 0 问题、`tsc -p platform/web/tsconfig.json`
与 `tsconfig.node.json` 通过、`vite build` 通过（展示页不进产物）；`shoot.py` 在亮 / 暗 × 1280 / 400px × ja / en / zh-CN 下截图，
页面无横向滚动、无控制台错误。

需要别人配合：页面接入（目录卡片、简介页、手册、报告与学习，见 09 V9）；i18n 框架在根部包 `VisualI18nProvider`（可选）并决定
`visual.fn.*` 是否改由术语表 / 主词典提供；`platform/web/package.json` 增加 `gen:glyphs`（与 CI 的 `--check`）；08-ui-design.md 顶部指向 09 的说明（I7）。

## i18n-prep-i18n

多语言基础设施（I1～I5、I7 的多语言部分）：界面词典与运行时（ja 默认、en、zh-CN）、全部页面文案迁入词典、Intl 格式化、
回退与“未翻訳”标记、`i18n:sync` / `i18n:check`；内容侧 lab.yaml v2 等文件的本地化对象、`manual/<lang>/`、按语言的
lint / build / catalog、API 与 dev-server 的语言协商。规格见 docs/platform/09-i18n-and-visual.md「多语言」。

有歧义时的取舍（都取最简单的做法）：

| 问题 | 决定 |
|---|---|
| 用哪个 i18n 框架 | 自写的小运行时（不加依赖）：页面原本就从各目录 `strings.ts` 的常量取文案，`msg` 保持同一结构、切换时原地改写叶子，页面代码只换数据源；复数与格式化用 Intl |
| 切换后怎样刷新界面 | `LocaleRoot` 以语言为 key 重新挂载应用（不整页刷新），API 缓存丢弃后按新语言重取 |
| “同步到用户偏好 API” | 已登录时切换后尽力 `PATCH /me {locale}`；不回读（服务器默认值仍是 zh-CN，回读会破坏“第一次访问一律日语”），localStorage 为准。`PATCH /me` 的枚举加了 `ja`（platform/api/src/routes/platform.ts 一行） |
| ja / en 的“空键” | 词典骨架里的空字符串 = 未翻译，运行时按回退链取值；`i18n:check` 默认把它算作失败，`--allow-empty` 只计数 |
| 回退标记加在哪里 | 只加在内容（卡片标题、简介、手册步骤、小测题干）；界面文案的回退只在开发模式警告（否则未翻译期间到处是标记） |
| 内容中哪些字段可以翻译 | 由 schema 决定：带 `$defs/l10n` 分支的字段（`textPatterns()` 从 schema 推出），不另列清单 |
| 长度限制对哪种语言生效 | 只对 zh-CN（lint 先解析成 zh-CN 再校验）；ja / en 只要求非空 |
| `i18n.fallback` 指针怎么算 | 同一语言渲染两遍（第二遍给回退值加不可见前缀），比较输出差异；派生字段也能标出，构建代码不必跟踪来源 |
| 按语言的文件放哪里 | 根目录保持 zh-CN 不变（旧客户端、API 执行路径不受影响），ja / en 放 `content/<v>/<lang>/` 与 `private/quiz/<lang>/` |
| API 用哪种语言的文档执行会话与检查 | 一律根目录（zh-CN）；语言只影响目录索引、学习路径与小测的文字 |
| `manual/zh-CN/` | 也接受为源语言（与 `manual/` 二选一，两处都有同名文件是 I3 错误） |
| 公开验证页（无 React 的独立包） | 页面自带 ja / en / zh-CN 的 verify 命名空间，`?lang=` → 已保存的选择 → ja；静态 HTML 用 `data-i18n` |
| e2e 在哪种语言下跑 | 显式选 zh-CN：`scripts/e2e/platform_e2e.py` 的每个浏览器上下文写入 `atl.locale.v1`（断言用的是源文案）；公开页面顶部多了语言 `<select>`，登录步骤改用 `main select` |
| `labs/_schema/*.json` | 由 `npm run labs:schema` 从修改后的 schema 重新生成并提交（编辑器校验需要接受本地化对象） |

自测（2026-10-14）：`npm run build`、`npm run lint`（0 问题）、`npm test`（225 个文件 / 2776 个用例通过）、`npm run labs:lint`
（56 张卡片 0 错误 0 警告）、`npm run labs:catalog -- --check`、`npm run i18n:check -- --allow-empty`（3482 键，ja / en 各译 15，
结构问题 0）、`npm run labs:i18n`、`labs:build --out <临时目录>`（483 个文件，含 ja / en）、`npm run e2e:platform`（zh-CN，51 / 51 通过）。
新增测试：`platform/web/src/i18n/i18n.test.tsx`、`platform/shared/test/l10n.test.ts`、`scripts/labs/test/i18n.test.ts`、
`platform/api/test/content-i18n.test.ts`。

需要别人配合：翻译界面词典（ja / en 各 3467 键，`i18n/ja|en/<ns>.ts`）与卡片内容（4281 个文本字段、231 个手册文件），按
`platform/web/src/i18n/glossary.md`；服务器端生成的报告 / 分享 HTML（`platform/api/src/services/reports/html.ts`）与 API 错误
`detail` 的本地化；`users.ts` 建档时的默认 `locale`（若要回读）；页面接入视觉组件时用 `useLocale()` / `<html lang>`；
CloudAlbum 前端（`frontend/`）不在本轮。

## i18n-web-workspace

工作台（P04 准备模式、P05 分屏工作台、P06 对比实验抽屉）的 ja / en 翻译与图形化（I5、I6 e）。只改了
`platform/web/src/workspace/**`、`platform/web/src/pages/workspace/**` 与 `i18n/{zh-CN,ja,en}/workspace.ts`。

**翻译**：`workspace` 命名空间 993 个键，ja / en 全部填写（`i18n:check` 对这些键 0 缺键、0 空值、0 占位符不一致，骨架与
`i18n:sync` 输出逐字相同）。英语在数量会变化的地方用复数（`{n, plural, …}`）。zh-CN 源文案按图形化的需要增删了少量键（见下）。

**图形化**（新文件在 `workspace/visual/`、`workspace/provision/PhaseDiagram.tsx`、`workspace/model/stepServices.ts`）：

| 位置 | 做法 |
|---|---|
| P04 准备进度 | 6 个阶段画成节点链（阶段图形 + 状态形状 + 用时，窄容器竖排；仍是 `<ol>`、`aria-current`、`data-phase/status`）；只有当前阶段的细节放在图下的细节框；部署等级用速度表 `MetricIcon`；大号已用时间；卡片有起始 / 目标模块时画 `<ArchDiagram mode="pair" fit="scale">`；计费 / 倒计时 / 可离开页面改为三块图标提示，完整句子折叠在“詳しく” |
| 顶栏 | 服务缩写方块换成 `ServiceGlyph`；场景卡的目标模块是图标链（已接入打勾）；准备中“沙漏 m:ss ‖”；费用“硬币 a～b/h · 叠币 x”；延长“时钟+ +30 分 · 残り n 回”；结束带停止图标。可见文字变短，可访问名称仍是完整句子（`aria-label`，e2e 与测试按名称查找不受影响） |
| 手册头 / 步骤列表 | 进度环（`ProgressRing` 20px）+ n/m；步骤下拉每项带 `StepTypeIcon` |
| 步骤卡 | 预计耗时 `MetricIcon duration` + `StepTypeTag`；标题下“本步相关服务”图标行（见下）；计费提示用“硬币+播放”图标；预期中断改为图标 + 一行要点 + 可折叠的说明 |
| 手册正文 | 做法标签带步骤类型图标；`:::expected` 带靶心图标，其中没有 runsOn 的代码块显示为“期待看到的输出”，响应头 / YAML 键 / JSON 键与 HTTP 状态码高亮（`<mark>`）、值加粗；`:::wait` 先给“通常约 n 分（最长 m 分）”的沙漏行；超过 3 行的段落默认折叠（`Clamp`） |

有歧义时的取舍（都取最简单的做法）：

| 问题 | 决定 |
|---|---|
| “与本步相关的服务”从哪里来 | 不新增内容字段，按步骤已有数据推：接入目标（`wireStep`）→ 对比实验模块 → `scripts/module <动作> <模块>` → 检查的 `module` / `service` / `target` → 控制台深链前缀 → 命令中的 `aws <service>` → 计费价格键；只认 registry 的 40 个模块，认不出就忽略，最多 6 个（`stepModules`，有单元测试） |
| `aws ssm` 属于哪个模块 | 参数类子命令（get/put/delete/describe/label-parameter…）→ config，其余 → shell-access |
| “超过 3 行”怎么判断 | 90 字符以上的段落才包 `Clamp`（CSS `line-clamp: 3`），布局后用 scrollHeight 比较决定是否显示“詳しく / Details / 展开全文”；已在折叠块（why / reveal / saa / 概览）里的不再折叠；全文始终在 DOM 中 |
| 预期结果里哪些代码块算“示例输出” | `:::expected` 中没有 runsOn（且不是 shell 语言）的代码块；冒号后有空格才算“名称: 值”（ARN、URL 不高亮）；不再提供复制按钮 |
| P04 的阶段细节 | 只显示当前（或失败）阶段的细节；已完成阶段的细节放在该节点的悬停提示里 |
| 部署等级的文字 | `labText.provisionName` 的 ja / en 与视觉组件的 `visual.metric.provision.*` 一致（速い / 普通 / 遅め / かなり遅い；Fast / Moderate / Slow / Very slow） |
| 工作台主机“工作台”的译名 | 按用语表译作 ワークベンチ / workbench（与 end 命名空间一致），实验机为 ラボ用インスタンス / lab instance |
| zh-CN 词典的增删 | 删除不再使用的 `provision.elapsed`、`bar.elapsed`、`bar.accrued`、`manual.progress(Sr)`、`md.wait`、`step.est`、`step.optional`；新增 P04 的提示瓦片与构成图标题、顶栏的短文案与 `aria-label`、`manual.progressAria`、`md.waitTypical/waitAuto/more/less`、`step.services/outageHead(Open)` |

自测（2026-10-14）：`npx vitest run`（platform/web 45 个文件 / 538 个用例通过；新增 `workspace/visual/visual.test.tsx` 7 个用例，
`WorkspacePage.test.tsx` 新增 4 个：步骤卡图形、顶栏图标与可访问名称、P04 构成图、ja / en 渲染）、`eslint`（本节路径 0 问题）、
`tsc -p platform/web/tsconfig.json`、`npm run build -w @atl/web`、`npm run i18n:check -- --allow-empty`（workspace 0 问题）。
另在 `npm run e2e:platform -- --serve-only --no-build` 起的独立端口上（没有碰 5174 / 8787）用系统 Chrome 截图：P04 / P05 / P06 抽屉 ×
ja / en / zh-CN × 亮 / 暗 × 1280 / 400px，400px 下 `scrollWidth = clientWidth = 400`。

需要别人配合：工作台里仍是中文的部分来自共用组件（`ui/` 的 CommandBlock、Countdown、SessionStatePill、CheckResultRow、步骤状态与
尝试状态），属 `ui` 命名空间；卡片内容（手册、步骤标题、检查名）待内容翻译；用语表建议新增：预期中断 想定内の中断 / expected outage、
管理通道 管理チャネル / management channel、运行器 ランナー / runner、平台动作 プラットフォーム操作 / platform action、佐证 裏付け /
corroboration、归属 所有の確認 / ownership、漂移 ドリフト / drift、前导键 プレフィックスキー / leader key、费用计 費用メーター /
cost meter、变体 バリアント / variant、起始档位 開始構成 / start profile、交叉校验 クロスチェック / cross-check、降级（手动）格下げ /
degraded、待人工处理清单 手動対応リスト / manual cleanup list。
