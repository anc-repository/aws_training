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
