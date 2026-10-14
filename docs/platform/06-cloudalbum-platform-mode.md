# 06 · 平台模式下 CloudAlbum 侧要求（唯一清单）

> 版本：第 1 版 · 2026-10-13（主设计者裁决 C5）。
>
> **本文是什么**：ATL（AWS Training Lab）平台模式下，**CloudAlbum 一侧**（应用、`scripts/module`、实验框架、发布包与引导脚本、Nginx、模块模板）需要实现的全部改动的**唯一清单**。每一项写明需求、接口或配置规格、涉及的代码位置、测试方法和优先级，交给代码实现。
>
> **与其他文档的关系**：
> - 名称（实体、标签、路径、角色、会话名、SSM 文档、状态桶与锁表、API 路由）以 [01-architecture.md](01-architecture.md) §14 名称表为准。本文只新增 CloudAlbum 内部的名称（CLI 子命令、环境变量、令牌格式、文件格式），需要 01 登记的条目列在 §15。
> - 01 §9 写平台侧的接口与约定；本文写 CloudAlbum 侧的实现规格。两处不一致时，接口名以 01 为准，CloudAlbum 内部实现以本文为准（01 §9 开头已写明）。
> - [modular-design.md](../modular-design.md) 与 `docs/modules/0N-*.md` 中的“平台模式（ATL）”小节是本文的摘要回写。平台模式部分三者不一致时以本文为准（总纲 1.4 D16）。
> - 平台侧如何调用这些能力：开始与结束编排见 [02-lab-lifecycle.md](02-lab-lifecycle.md)；工作台接线见 [03-workspace-terminal.md](03-workspace-terminal.md)；检查、对比实验上传与 `lab.yaml` v2 见 [04-lab-format-checks-reports.md](04-lab-format-checks-reports.md)；卡片见 [cards/](cards/)；需要真实 AWS 才能确认的事项见 [07-aws-verification-plan.md](07-aws-verification-plan.md)。
>
> **不变的部分**：独立模式（在自己的电脑或 CloudShell 上直接用 `scripts/module`）的行为不变。本文的改动只在平台模式开关打开时生效；少数两种模式都生效的改动（例如 Nginx 日志末尾追加字段、cdn 源请求策略转发实验头）在条目中单独注明。
>
> 写作约束：不写价格与精确的性能数字，只写计费维度与“以官方文档为准”；文档为简体中文，技术名词保留英文。

## 目录

- [0. 一页摘要](#0-一页摘要)
- [1. 范围、术语与约定](#1-范围术语与约定)
- [2. 平台模式开关与平台配置](#2-平台模式开关与平台配置)（PM-01～PM-03）
- [3. 实验机：引导、发布包与管理通道](#3-实验机引导发布包与管理通道)（PM-04～PM-08）
- [4. 探测令牌与探测端点](#4-探测令牌与探测端点)（PM-09～PM-11）
- [5. 本机 CLI](#5-本机-cli)（PM-12～PM-17）
- [6. Nginx](#6-nginx)（PM-18～PM-20）
- [7. HTTPS、预览嵌入与登录](#7-https预览嵌入与登录)（PM-21～PM-23）
- [8. cdn 模块](#8-cdn-模块)（PM-24～PM-25）
- [9. scripts/module 的平台模式](#9-scriptsmodule-的平台模式)（PM-26～PM-36）
- [10. 实验框架](#10-实验框架)（PM-37～PM-42）
- [11. 测试数据种子](#11-测试数据种子)（PM-43～PM-47）
- [12. 平台模式规则](#12-平台模式规则)（PM-48）
- [13. 模块级要求（逐模块）](#13-模块级要求逐模块)（PM-M01～PM-M36）
- [14. 实施顺序与测试矩阵](#14-实施顺序与测试矩阵)
- [15. 需要其他文档配合的事项](#15-需要其他文档配合的事项)
- [16. 回写记录与未采纳的意见](#16-回写记录与未采纳的意见)
- [修订记录](#修订记录)

---

## 0. 一页摘要

| ID | 主题 | 优先级 | 主要代码位置 | 回写到 |
|---|---|---|---|---|
| PM-01 | `ATL_PLATFORM_MODE` 与 `/etc/cloudalbum/platform.env` | P0 | `backend/src/config/`、`backend/src/platform/mode.ts` | 总纲 1.4 D16、4.4 |
| PM-02 | 平台配置的写入与更新（`platform:apply-env`、`platform-status`） | P0 | `infra/host/platform/`、`backend/src/cli/platform/` | 总纲 4.4；00-ec2-base §14 |
| PM-03 | capabilities 的 `app.platform` 段与 `?fields=` 投影 | P0 | `backend/src/modules/capabilities.ts` | 总纲 6.1 |
| PM-04 | 发布包携带检查包与 `atl-check` 入口，引导脚本安装到 `/opt/atl` | P0 | `scripts/release`、`infra/userdata/l0-bootstrap.sh` | 总纲 2.7；00-ec2-base §14 |
| PM-05 | 基础栈的平台模式参数与实例标签 | P0 | `infra/modules/ec2.yaml`、`scripts/module-cli/src/base.ts` | 总纲 2.7；00-ec2-base §14 |
| PM-06 | SSM Agent 版本满足 `interpolationType: ENV_VAR` | P0 | `infra/userdata/l0-bootstrap.sh` | 00-ec2-base §14 |
| PM-07 | 管理员非交互初始化（只收 argon2id 哈希） | P0 | `backend/src/cli/admin.ts` | 总纲 2.7；00-ec2-base §14 |
| PM-08 | 平台目录与用户的所有权；L0 冒烟测试的平台差异 | P0（S02）/ P1 | `experiments/ec2/smoke.ts`、`infra/host/` | 总纲 2.9；00-ec2-base §14 |
| PM-09 | 探测令牌：本机令牌与一次性令牌 | P0 | `backend/src/platform/probe-token.ts` | 总纲 6.1 |
| PM-10 | 只读主体 `atl-probe` 与探测流量标记 | P0 | `backend/src/http/middleware/atl-probe.ts` | 总纲 6.1、7.3 |
| PM-11 | `/api/lab/probe/*` 端点 | P0（now、echo、media-url）/ P1（auth、identity-pool、kms） | `backend/src/http/routes/lab-probe.ts` | 总纲 6.1；各模块文档第 12 节 |
| PM-12 | 本机 CLI 入口 `/opt/cloudalbum/bin/cloudalbum` 与通用约定 | P0 | `infra/host/cloudalbum`、`backend/src/cli.ts` | 总纲 §11 |
| PM-13 | `probe-token` | P0 | `backend/src/cli/platform/probe-token.ts` | 总纲 6.1 |
| PM-14 | `lab-metrics` | P0 | `backend/src/cli/platform/lab-metrics.ts` | 总纲 7.3 |
| PM-15 | `capabilities`、`platform-status`、`module-state` | P0 | `backend/src/cli/platform/` | 总纲 §11；00-ec2-base §14 |
| PM-16 | `path-seen`（P0）、`app-stat`（P1） | P0 / P1 | `backend/src/cli/platform/` | 总纲 7.3 |
| PM-17 | `lab-token` 与实验主体 `atl-lab` | P1 | `backend/src/platform/lab-token.ts` | 总纲 8.2 |
| PM-18 | Nginx 访问日志追加 `args`、`port`、`run`、`probe` | P0 | `infra/nginx/` | 总纲 2.5；00-ec2-base §14 |
| PM-19 | 来自回环地址的请求不做 HTTPS 跳转 | P0 | `infra/nginx/00-entry.conf` | 总纲 2.5；01#tls §12 |
| PM-20 | HTML 响应输出 CSP `frame-ancestors`，不发 `X-Frame-Options` | P1 | `infra/nginx/`、`backend/src/http/middleware/` | 总纲 2.5；00-ec2-base §14 |
| PM-21 | 平台默认 HTTPS 方案 B（Let's Encrypt IP 证书）与 ASG-014 的冲突处理 | P1 | `scripts/tls/`、`scripts/module-cli/src/tls-preview.ts` | 01#tls、01#autoscaling §12 |
| PM-22 | 登录 Cookie（`SameSite=None; Partitioned`）、CSRF `Origin` 校验、iframe 内的托管登录 | P1 | `backend/src/adapters/auth/`、`frontend/src/auth/` | 总纲 4.4；02#auth §12 |
| PM-23 | `Timing-Allow-Origin`、CORS 暴露头与预览桥 | P2 | `backend/src/observability/` | —（P2，实现时再回写总纲 7.1） |
| PM-24 | cdn 源请求策略转发实验头（两种模式都生效） | P0 | `infra/modules/cdn.yaml` | 01#cdn §12 |
| PM-25 | cdn 的其他平台模式要求 | P1 | `infra/modules/cdn.yaml`、`scripts/module-cli/` | 01#cdn §12 |
| PM-26 | `scripts/module` 平台模式的开启方式、环境变量与身份校验 | P0 | `scripts/module-cli/src/platform/` | 总纲 9.2 |
| PM-27 | 状态后端：状态桶 + S3 条件写 | P0 | `scripts/module-cli/src/state/` | 总纲 9.2 |
| PM-28 | 环境操作锁：锁表 + 租约 | P0 | `scripts/module-cli/src/lock/` | 总纲 9.2 |
| PM-29 | 栈标签、权限边界与命名 | P0 | `scripts/module-cli/src/stack.ts`、`infra/modules/*.yaml` | 总纲 9.1 |
| PM-30 | 投递通道、发布包地址与带外操作 | P0 | `scripts/module-cli/src/deliver/ssm.ts` | 总纲 9.2 |
| PM-31 | iam 与 keys 模式 | P0（`AppRoleMode=existing`）/ P1 | `infra/modules/iam.yaml`、`scripts/module-cli/src/iam.ts` | 总纲 9.2；02#iam §12 |
| PM-32 | 新增子命令与选项 | P0 | `scripts/module-cli/src/` | 总纲 9.2 |
| PM-33 | 起始状态推导 `plan --start-of` 与档位文件 | P0 | `scripts/module-cli/src/plan.ts` | 总纲 10.4、§11 |
| PM-34 | registry 扩展（`platform` 段、`remedy`、`singleLocalSettings`、`singleRuntime`） | P0 | `modules/registry.yaml`、`registry.schema.json`、`backend/src/rules/rules.ts` | 总纲 3.5 |
| PM-35 | 进度、结果、操作上报与退出码 | P0 | `scripts/module-cli/src/report/` | 总纲 9.2 |
| PM-36 | 平台钩子（等学员身份执行的后续步骤） | P1 | `scripts/module-cli/src/hooks.ts` | 总纲 9.2 |
| PM-37 | 实验变体标签 `--label <任意变体>` | P0 | `experiments/_lib/` | 总纲 8.2 |
| PM-38 | 平台模式上传：登记 → 执行 → 上传 → 轮询 | P0 | `experiments/_lib/platform.ts` | 总纲 8.2 |
| PM-39 | 按目标拆分的客户端统计与 `X-Cache` | P0 | `experiments/_lib/k6/common.js` | 总纲 8.2 |
| PM-40 | 运行归属（`X-Experiment-Run`）的平台模式规则 | P0 | `backend/src/observability/lab-metrics.ts` | 总纲 7.3 |
| PM-41 | 实验机侧实验 `--on lab` | P1 | `experiments/_lib/on-lab.ts` | 总纲 8.2 |
| PM-42 | 故障注入一律经 SSM；管理员凭据来源 | P0 | `experiments/_lib/` | 总纲 8.2 |
| PM-43 | 测试数据种子登记表与执行约定 | P1 | `backend/src/lab/seeds/` | 总纲 10.4（`PROFILE_SEEDS`） |
| PM-44 | 种子 `cognito-test-users` | P1 | 同上 | 02#auth §12 |
| PM-45 | 种子 `gps-sample-photos` | P1 | 同上、`scripts/release/seed-assets/` | 02#kms §12 |
| PM-46 | 保留域名的地址不真正发信 | P1 | `backend/src/services/mailer.ts` | 04#email §12 |
| PM-47 | 学员自助数据生成 `lab:seed`、`lab:seed-events` | P2 | `backend/src/cli/lab-seed.ts` | 03#analytics §12 |
| PM-48 | 平台模式规则（ATL-CFG、ATL-NET、ATL-IAM）与既有规则的平台解释 | P0 / P1 | `backend/src/rules/rules.ts` | 总纲 5.4 |
| PM-M01～M36 | 模块级要求（权限边界、平台动作、标签传播、清理与只读接入等） | P0～P2 | `infra/modules/<id>.yaml` 等 | 各模块文档第 12 节 |

**P0 实施顺序**（细节见 §14.1）：先让 `base-deploy` 与健康门通过（PM-01、02、04～07、09、10、12、13、15、26～35），再让检查与对比实验可判定（PM-03、08、11、14、16、18、19、24、37～40、42）。

---

## 1. 范围、术语与约定

### 1.1 本文负责与不负责

| 负责 | 不负责（只引用） |
|---|---|
| CloudAlbum 应用在平台模式下的行为差异（配置、端点、Cookie、CSP、指标归属） | 平台 API、状态机、IAM 角色与边界的定义（01、02） |
| 实验机上的引导步骤、发布包内容、本机 CLI | `ATL-RunCheck` 文档与检查包内部实现（04 §6；本文只规定 CloudAlbum 提供的 CLI 与安装位置） |
| `scripts/module` 的平台模式（状态、锁、标签、推导、上报） | 运行器的 buildspec 与失败分类（02 §4.3；本文只规定退出码与 `result.json`） |
| 实验框架的平台模式（变体标签、上传、按目标统计） | 上传协议的服务端与有效性判定（04 §7） |
| 测试数据种子的生成方式 | 卡片何时使用种子（04 `startProfile.provisions` 的 `kind: seed`） |
| 模块模板与模块文档中的平台模式差异 | 工作台的引导与接线（03 §4） |

### 1.2 术语

| 术语 | 含义 |
|---|---|
| 平台模式 | 应用侧：`ATL_PLATFORM_MODE=on`（PM-01）；工具侧：`CLOUDALBUM_PLATFORM_MODE=1` 或命令行选项 `--platform`（PM-26） |
| 独立模式 | 不在 ATL 中运行时的现有行为（总纲各节） |
| 实验机 | 带标签 `atl:role=lab-app` 的 CloudAlbum EC2 实例（单实例，或 ASG 中的实例） |
| 工作台 | 03 定义的 workstation EC2（`atl:role=workstation`）。学员在上面以 `ATLLearnerRole`、会话名 `atl-<sid>-ws` 运行 `scripts/module` 与实验 |
| 运行器 | CodeBuild 项目 `atl-runner`，以 `ATLProvisionerRole`、会话名 `atl-<sid>-prov-<op>` 运行 `scripts/module` |
| 管理通道 | 实验机上的 SSM Agent，凭证来自实例配置文件 `CloudAlbumAppRole`（只含 `AmazonSSMManagedInstanceCore`，P7）。它属于平台，不属于应用：应用仍是 `IAM_CREDENTIALS=none`，直到学员启用 iam 模块 |
| 探测主体 `atl-probe` | 持有有效探测令牌的请求在应用内的身份：只读，不能触发深度探针，没有任何写权限（PM-10） |
| 实验主体 `atl-lab` | 持有有效 `lab-token` 的请求在应用内的身份：等同于应用管理员，用于对比实验运行器（PM-17） |
| 方案 B | 平台默认的 HTTPS 方案：tls 本地档为实验机的 EIP 申请 Let's Encrypt IP 短期证书，让 L0 的直连入口也能在 iframe 中预览（03 §6.2，PM-21） |
| 种子 | 测试数据种子：已确认、密码已知的测试用户，带 GPS 信息的示例照片等（§11） |
| 卡片、变体 | 卡片 id `svc-<module>` / `sc-<slug>`；变体 `variant` 默认 `default`（01 §3.9） |

### 1.3 优先级

| 级别 | 定义 |
|---|---|
| **P0** | 平台跑通所必需：没有它，07 列出的示例卡片（`svc-ec2`、`svc-storage`、`svc-cdn`、`svc-queue`、`svc-image-processing`、`sc-static-acceleration`）的“开始 → 做步骤 → 检测 → 对比实验 → 结束回收”主流程至少有一步走不通 |
| **P1** | 平台能跑，但部分卡片无法完成、某些检查只能人工确认，或预览、登录体验退化 |
| **P2** | 改进项，可以放在 v1 之后 |

### 1.4 条目格式

每个条目按固定的五部分书写：**需求**（为什么要做、谁依赖它）→ **规格**（端点、请求与响应、环境变量、CLI 参数、文件格式）→ **代码位置**（参照总纲 §11 目录树；新增的路径标“新增”）→ **测试**（单元、契约、集成，以及交给 07 的实测项）→ **优先级**。

### 1.5 适用于全部条目的约定

1. **平台模式判定只有一处**：应用内一律调用 `backend/src/platform/mode.ts` 的 `platformMode()`；`scripts/module` 内一律调用 `scripts/module-cli/src/platform/mode.ts` 的 `isPlatform()`。代码中不得另行读取 `ATL_PLATFORM_MODE`。
2. **平台模式关闭时的等价性**：每个条目都必须有一个测试证明“平台模式关闭时行为与现状逐字节一致”（响应头、capabilities 快照、CLI 输出）。例外只有标注“两种模式都生效”的条目。
3. **机密不进参数、URL 与日志**：Run Command 的参数会留在命令历史中，URL 会进访问日志。本文中经命令参数下发的只有非机密值与不可逆的哈希；令牌只放在请求头里。
4. **新增端点**：JSON 响应；`Cache-Control: private, no-store`；错误体 `{"error":{"code":"…","message":"…"}}`，错误码写在各条目中。
5. **新增 CLI**：stdout 只输出一个 JSON 对象，诊断信息写 stderr；退出码见 PM-12。
6. **不写价格与精确的性能数字**；涉及 AWS 行为的事实标注“以官方文档为准”，需要实测的列入 §14.3 交给 07。

---

## 2. 平台模式开关与平台配置

### PM-01 `ATL_PLATFORM_MODE` 与 `/etc/cloudalbum/platform.env`（P0）

**需求**：平台需要把“这是哪个会话、哪个环境、哪张卡片、平台的来源是什么”告诉实验机上的应用，应用据此打开平台模式下的行为（探测主体、CSP、Cookie、运行归属等）。01 §9.2 规定由运行器在 `base-deploy` 中写入该文件。

**规格**

- 文件：`/etc/cloudalbum/platform.env`（`/etc/cloudalbum` 指向数据卷 `etc/`，所以实际在 `/var/lib/cloudalbum/etc/platform.env`；`root:cloudalbum 0640`）。只由 `cloudalbum platform:apply-env` 写入（PM-02），不得手工编辑。内容为 `KEY=VALUE` 行，不含机密。
- 变量：

| 变量 | 必填 | 格式（正则） | 缺省 | 含义与使用方 |
|---|---|---|---|---|
| `ATL_PLATFORM_MODE` | 是 | `on` \| `off`（同时接受 `1`/`true`、`0`/`false`，归一为 `on`/`off`） | `off` | 平台模式总开关。02 §4.3 示例写的 `=1` 合法 |
| `ATL_SESSION_ID` | 开启时必填 | `^s[0-9a-hjkmnp-tv-z]{12}$` | — | 当前会话（日志、`app.platform`、种子归属） |
| `ATL_ENV_ID` | 开启时必填 | `^[0-9a-hjkmnp-tv-z]{26}$` | — | 环境 ID（ULID，小写） |
| `ATL_ENV_NAME` | 开启时必填 | `^e[a-z0-9]{7}$` | — | 必须等于 `CLOUDALBUM_ENV`，否则 ATL-CFG-001 |
| `ATL_LAB_ID` | 开启时必填 | `^(svc\|sc)-[a-z0-9]+(-[a-z0-9]+)*$` | — | 当前卡片 |
| `ATL_VARIANT` | 否 | `^[a-z][a-z0-9-]{0,31}$` | `default` | 当前起始变体 |
| `ATL_PLATFORM_ORIGIN` | 开启时必填 | `^https://[a-z0-9.-]+(:[0-9]{1,5})?$`（精确来源，不带路径与结尾斜杠） | — | CSP `frame-ancestors`（PM-20）、`Timing-Allow-Origin` 与 CORS（PM-23）、预览桥的 `postMessage` 目标 |
| `ATL_PROBE_TOKEN_FILE` | 否 | `/etc/cloudalbum/atl/` 下的绝对路径 | `/etc/cloudalbum/atl/probe.token` | 本机探测密钥文件（PM-09） |
| `ATL_RELEASE` | 否 | semver | 空 | 平台版本，只用于展示 |

- **加载**：由 `config/load-env.ts` 作为第 1b 层加载——在 `cloudalbum.env`（第 1 层）之后、`modules.d/*.env`（第 2 层）之前。这个文件只允许出现 `ATL_` 前缀的键（否则 ATL-CFG-001）；`ATL_` 前缀的键出现在其他层时按 CFG-002 处理（不属于任何模块的 `ownsEnv`）。**不使用 systemd 的 `EnvironmentFile`**：总纲 4.4 规定启动配置“不依赖 systemd 的 `EnvironmentFile`”，CLI 也要读到同一组值（§16 未采纳意见第 1 条）。
- **多实例**：`DEPLOY_MODE=asg` 时，autoscaling 的引导配置包（`/cloudalbum/<envName>/bootstrap/bundle`）在第 1～3 层之外同时携带 `platform.env`（PM-M07）。
- **打开后改变的行为**（每一项的规格见对应条目）：探测主体与 `/api/lab/probe/*`（PM-09～PM-11）；`lab-token`（PM-17）；HTML 响应的 CSP（PM-20）；Cookie 与 CSRF（PM-22）；运行归属规则（PM-40）；capabilities 的 `app.platform`（PM-03）；保留域名不发信（PM-46）；规则 ATL-*（PM-48）。

**代码位置**：`backend/src/config/schema.ts`（新增 `Platform` 分段）、`backend/src/config/load-env.ts`（第 1b 层）、`backend/src/platform/mode.ts`（新增）、`packages/contracts`（`PlatformInfo` 类型）。

**测试**：zod 分段的正反用例（每个变量的合法与非法值、`1`/`true` 归一）；加载顺序测试（`platform.env` 中的非 `ATL_` 键 → ATL-CFG-001；`modules.d` 中的 `ATL_` 键 → CFG-002）；文件缺失时与现状一致的快照测试；`ATL_ENV_NAME ≠ CLOUDALBUM_ENV` → 退出码 78。

**优先级**：P0。

### PM-02 平台配置的写入、更新与自检（P0）

**需求**：运行器要在 `base-deploy` 第 4 步写入平台配置（02 §4.3），复用环境时下一个会话要更新 `ATL_SESSION_ID`、`ATL_LAB_ID`（01 §9.2 “更新方式见 06”），健康门 `base.ready` 要能判断 `platformEnvPresent`。

**规格**

1. `cloudalbum platform:apply-env --b64 <base64url(文件全文)> [--restart auto|always|never]`（root 执行，PM-12 的根子命令）：
   - 解码 → 按 PM-01 的 zod 分段校验（失败退出 2，不写文件）→ “临时文件 + `rename`”原子写入 → 渲染 Nginx 槽位文件 `/etc/nginx/cloudalbum.d/slot-atl-frame-ancestors.inc`（PM-20）→ `nginx -t && systemctl reload nginx`（`nginx -t` 失败则恢复旧文件与旧槽位，退出 5）。
   - 进程处理（`--restart auto`）：`ATL_PLATFORM_MODE`、`ATL_PLATFORM_ORIGIN`、`ATL_PROBE_TOKEN_FILE` 变化 → 重启 `cloudalbum-api`、`cloudalbum-worker`（`LB_LOCAL_WORKERS=2` 时逐个滚动）；只有 `ATL_SESSION_ID`、`ATL_LAB_ID`、`ATL_VARIANT`、`ATL_RELEASE` 变化 → 向两个进程发 `SIGHUP`，进程只重新加载 `Platform` 分段（这四个值只用于展示、日志与种子归属，不影响装配）。
   - 输出：`{"changed":["ATL_SESSION_ID",…],"action":"none|reload|restart","nginxReloaded":true}`。
   - 调用方：运行器 `base-deploy` 第 4 步；`profile-apply` 在复用环境时的第 0 步（先于 `profile apply`）；`repair`。ASG 模式下由 `scripts/module` 同时更新引导配置包中的 `platform.env` 并对全部 `InService` 实例执行本命令（PM-M07）。
2. `cloudalbum platform-status --json`（任何身份可执行，只读）：

```json
{
  "schema": "cloudalbum.platform-status/v1",
  "platformMode": "on",
  "platformEnv": { "present": true, "valid": true, "errors": [] },
  "probeToken": { "present": true },
  "admin": { "present": true },
  "checkBundle": { "installed": ["9f1c…"], "releaseDigest": "9f1c…" },
  "ssmAgent": { "version": "<版本>", "meetsMinimum": true },
  "services": { "api": "active", "worker": "active", "nginx": "active" },
  "dataVolumeMounted": true,
  "session": { "sessionId": "s4k7m2q9x1abc", "labId": "svc-cdn", "envName": "e7k2m9qx" }
}
```

   04 §6.4 的健康门 `base.ready` 读取它的 `platformEnv.valid`、`probeToken.present`、`services`、`dataVolumeMounted` 字段（也可以直接读文件，但字段语义以本命令为准）。

**代码位置**：`infra/host/platform/apply-env.sh`（新增，root 部分：写文件、渲染槽位、reload）、`backend/src/cli/platform/apply-env.ts`（校验，被脚本调用）、`backend/src/cli/platform/status.ts`（新增）、`backend/src/platform/mode.ts`（`SIGHUP` 处理）。

**测试**：在容器中执行两次 `apply-env`（幂等）；`nginx -t` 失败时回滚；只改会话 ID 时进程 PID 不变而 `app.platform.sessionId` 更新；`platform-status` 在缺文件、缺令牌、服务停止时的输出。

**优先级**：P0。

### PM-03 capabilities：`app.platform` 段与 `?fields=` 投影（P0）

**需求**：`ATL-RunCheck` 的 `capability-snapshot` 受 Run Command 标准输出长度限制（以官方文档为准），必须取投影（01 §9.3、04 §5.2.2）；平台要能读到当前会话与检查包信息；前端要知道是否处于平台模式（显示横幅、iframe 行为）。

**规格**

- **`app.platform`**（平台模式开启时出现）：

```json
"platform": {
  "mode": "on",
  "sessionId": "s4k7m2q9x1abc", "envId": "01jc9x3k9cq4m2x8n5b6c0d1e2", "envName": "e7k2m9qx",
  "labId": "svc-cdn", "variant": "default", "origin": "https://d1234abcd.cloudfront.net",
  "probe": { "localToken": "present" },
  "checkBundle": { "installed": ["9f1c…"], "releaseDigest": "9f1c…" }
}
```

  公开视图只有 `{ "mode": "on" }`；其余字段只对管理员、`atl-probe`、`atl-lab` 可见。平台模式关闭时整个 `platform` 键不出现。

- **`?fields=` 投影**：逗号分隔的点路径列表；`*` 只能用作模块 id 或功能 id 的通配段；数组元素的字段用 `[]` 表示。示例（01 §9.3 与 04 §5.2.2 的最小集合）：

```text
GET /api/capabilities?fields=app.profile,app.entry,app.configHash,app.instance,app.platform,https,
    validation.errors[].rule,validation.errors[].modules,validation.warnings[].rule,validation.warnings[].modules,
    modules.*.driver,modules.*.status,modules.*.localHealth,modules.*.confidence,modules.*.detail,features.*.enabled
    &modules=cdn,iam&view=admin
```

  - `modules=<id,…>` 只保留列出的模块；不存在的 id → 400 `MODULE_UNKNOWN`。
  - 不在白名单中的路径 → 400 `FIELDS_INVALID`（白名单 = capabilities schema 中的全部叶子路径，由 `packages/contracts` 生成）。
  - 投影结果超过 12 KB 时按模块 id 字母序截断，响应带 `"truncated": true` 与 `"nextModules": [...]`，调用方按模块分批再取（单行输出 ≤ 16 KB，04 §6.5）。
  - `view=admin` 需要管理员会话、`atl-probe` 或 `atl-lab`；`atl-probe` 带 `deep=1` → 403 `PROBE_DEEP_FORBIDDEN`。
- `validation.errors[]` 与 `validation.warnings[]` 的每一项都必须带 `{ rule, modules[] }`（04 的 `healthy` 判定按模块过滤，§5.3）；没有关联模块的规则 `modules` 为空数组。
- 所有模块（包括 `status=off` 的）都输出 `localHealth`。

**代码位置**：`backend/src/modules/capabilities.ts`、`backend/src/http/routes/capabilities.ts`、`packages/contracts/src/capabilities.ts`（投影白名单生成）。

**测试**：投影解析器的表驱动单元测试（通配、数组、非法路径）；截断与 `nextModules`；`atl-probe` 不能 `deep=1`；平台模式关闭时 `platform` 键不出现（快照）。

**优先级**：P0。

---

## 3. 实验机：引导、发布包与管理通道

### PM-04 发布包携带检查包与 `atl-check` 入口，引导脚本安装到 `/opt/atl`（P0）

**需求**：`ATL-RunCheck` 只调用固定入口 `/opt/atl/bin/atl-check`，检查包在 `/opt/atl/checks/<bundleDigest>/`（01 §9.3、04 §6.2）。实例被替换（network 迁移、`rebuild-instance`、ASG 扩容与实例刷新）后新实例上也必须有检查包，私有放置时也不能依赖预签名 URL，所以检查包**随 CloudAlbum 发布包分发**，凡是装得上 CloudAlbum 的实例就装好检查包（04 D-14）。

**规格**

- **发布包内容**：`scripts/release` 在打包时把 `platform/infra/checks-bundle/` 的构建产物放进发布包：

```text
cloudalbum-<ver>-<arch>.tgz
├── frontend/dist/ backend/dist/ infra/ scripts/ …        # 现有内容
├── experiments/<module>/lab/*.sh、experiments/<module>/faults/*.sh   # 只带实验机侧脚本（PM-41、PM-42）
├── seed/                                                 # 种子资产（PM-45）
├── atl/
│   ├── bin/atl-check                                     # 启动器（04 §6.3）
│   └── checks/<bundleDigest>/                            # manifest.json、runner.mjs、checks/、schemas/
└── .release-manifest.json                                # 新增字段 atlBundleDigest、ssmAgentMinVersion
```

  `bundleDigest` = `checks/<bundleDigest>/manifest.json` 的 SHA-256；`scripts/release` 校验目录名与摘要一致，否则构建失败。平台发布清单（01 §4.5 的 `SHA256SUMS`）登记同一个摘要。
- **安装**：`l0-bootstrap.sh` 的 `install` 阶段在安装应用之后调用 `infra/host/install-atl-bundle.sh`（root，幂等）：
  1. `install -d -o root -g root -m 0755 /opt/atl /opt/atl/bin /opt/atl/checks`；
  2. 把发布包中的 `atl/checks/<digest>/` 复制到 `/opt/atl/checks/<digest>/`（已存在且 `manifest.json` 摘要一致则跳过），文件 `root:root 0644`、目录 `0755`；
  3. `install -m 0755 atl/bin/atl-check /opt/atl/bin/atl-check`（先写临时文件再 `rename`）；
  4. 复算 `manifest.json` 的摘要，必须等于目录名；
  5. 只保留最近 3 个摘要目录（按 mtime），其余删除——复用环境时旧会话钉住的旧摘要短时间内仍可用。
- **适用范围**：两种模式都安装（检查包本身无害，独立模式下不会被调用）。golden AMI（ami 模块）在构建时执行同一脚本；`[ -f /opt/cloudalbum/.image-manifest.json ]` 时引导脚本仍执行第 4 步校验。ASG 实例经同一个 `l0-bootstrap.sh` 安装（PM-M07）。
- **修复**：运行器 `ATL_OP=repair`（02）重新部署当前发布包时，`cloudalbum atl-bundle:install`（PM-12 的根子命令，调用同一脚本）把新摘要装上。
- **所有权**：`/opt/atl/`、`/etc/atl/`、`/var/lib/atl/` 与 OS 用户 `labuser` 属于平台（03 §3.4）。CloudAlbum 的 `hostSetup`、`install-host-files.sh`、leak-scan、本地合规自检**只读**，唯一的写入就是本条的安装步骤（PM-08）。

**代码位置**：`scripts/release`（打包）、`infra/host/install-atl-bundle.sh`（新增）、`infra/userdata/l0-bootstrap.sh`（`install` 阶段）、`infra/install-host-files.sh`。

**测试**：发布构建测试（目录名 = 摘要；`.release-manifest.json` 字段）；在 AL2023 容器中执行两次引导（幂等、只保留 3 个目录）；篡改一个检查文件后 `atl-check` 返回 `RUNNER_INTEGRITY`（04 的契约测试）；ASG 新实例上有检查包（07 的 svc-autoscaling 走查）。

**优先级**：P0。

### PM-05 基础栈的平台模式参数与实例标签（P0）

**需求**：P7 要求实验机从 L0 起就带只含 `AmazonSSMManagedInstanceCore` 的实例配置文件（管理通道）；平台按标签发现实例（01 §9.8）；会话密钥对与发布包地址由运行器提供（02 §4.3 `base-deploy`）。

**规格**

| 基础栈参数 | 平台模式取值 | 说明 |
|---|---|---|
| `PlatformMode`（**新增**，`off`\|`on`，默认 `off`） | `on` | 写入 `/etc/cloudalbum-bootstrap/params.env` 的 `PLATFORM_MODE`。引导脚本据此：不在启动时创建管理员（PM-07）、不写 `/root/cloudalbum-admin.txt`、强制 SSM Agent 版本（PM-06）。该值在环境生命周期内不变（不违反总纲 2.7 不变量 4） |
| `Env` | `<envName>` | `e` + 7 位，01 §3.9 |
| `InstanceProfileName` | `CloudAlbumAppRole`（从首次部署起） | 平台模式下任何模块都不能把它改为空或其他值（ATL-IAM-001，PM-48）；应用仍是 `IAM_CREDENTIALS=none` |
| `KeyName` | `cloudalbum-<envName>-key` | 运行器以 `ec2:CreateKeyPair` 创建，私钥只写入 `/cloudalbum/<envName>/atl/ssh-key`（01 §9.2） |
| `SshIngressCidr` | 空；卡片声明 `sshFromWorkstation` 时由 `profile-apply` 设为工作台私网或公网地址 /32（02 §3.6、03 §4.8） | — |
| `AppArchiveUrl` | 工具链桶 `releases/<ver>/<arch>.tgz` 的预签名 HTTPS URL（PM-30） | 后续栈更新一律 `UsePreviousValue`；替换实例时生成新的 URL |

- **实例标签**：模板在 `PlatformMode=on` 时给 `AWS::EC2::Instance`（两个槽位）加资源级标签 `atl:role=lab-app`；其余标签（`atl:component=env`、`atl:session-id`、`atl:lab-id`、`atl:env-id`、`Project=CloudAlbum`）来自栈级标签（PM-29）。`atl:role` 只能经 CloudFormation 设置（01 护栏 `ProtectRoleTag`），`scripts/module` 不直接给任何资源打 `atl:role`。
- **首次部署**：`base deploy --platform` 使用 `--disable-rollback`；首次创建遇到容量不足（`InsufficientInstanceCapacity`）时删除失败栈，换同一默认 VPC 中另一个 AZ 的默认子网重试一次（02 §4.3 第 3 步）。

**代码位置**：`infra/modules/ec2.yaml`（参数、`Conditions: IsPlatform`、实例标签）、`scripts/module-cli/src/base.ts`、`infra/userdata/l0-bootstrap.sh`（读 `PLATFORM_MODE`）。

**测试**：cfn-lint；模板单元测试（`PlatformMode=on` 时实例有 `atl:role`，`off` 时没有）；`base deploy --platform` 的参数组装快照；ATL-IAM-001 的正反用例。

**优先级**：P0。

### PM-06 SSM Agent 版本（P0）

**需求**：`ATL-RunCheck` 与 `ATL-WorkstationSetup` 的参数全部用 `interpolationType: ENV_VAR`，对 SSM Agent 有最低版本要求（以官方文档为准，01 §3.6、04 §6.1）。AMI 自带的 Agent 版本不一定满足。

**规格**

- 最低版本写在 `.release-manifest.json` 的 `ssmAgentMinVersion`（取值以官方文档为准，07 实测确认后填入，不在文档中硬写）。
- `install` 阶段：读取 `rpm -q --qf '%{VERSION}' amazon-ssm-agent`；低于最低版本且 `PLATFORM_MODE=on` 时执行 `dnf -y upgrade amazon-ssm-agent`（AL2023 仓库提供时），否则按官方文档的区域安装方式升级；`systemctl restart amazon-ssm-agent`。结果写 `/opt/cloudalbum/.ssm-agent-check.json`（`{version, minimum, meetsMinimum, checkedAt}`），由 `platform-status` 汇报（PM-02）。
- 升级失败不中止引导（应用照常可用），但 `platform-status.ssmAgent.meetsMinimum=false`，健康门据此判失败并给出修复指引；`atl-check` 本身也会因缺少 `SSM_*` 环境变量返回 `RUNNER_UNAVAILABLE`（04 §6.3）。
- golden AMI 的构建管道执行同一检查（PM-M36）。

**代码位置**：`infra/userdata/l0-bootstrap.sh`、`scripts/release`（写最低版本）。

**测试**：在 AL2023 容器中模拟低版本（桩 `rpm` 输出）走升级分支；07 在真实实例上确认 `ENV_VAR` 参数到达脚本。

**优先级**：P0。

### PM-07 管理员非交互初始化（P0）

**需求**：01 §9.2 规定管理员初始密码的明文只写入 `/cloudalbum/<envName>/atl/app-admin-password`，下发给实例的只有 argon2id 哈希（Run Command 参数会留在命令历史中，哈希不可逆）。现有引导脚本在启动时创建管理员并把随机密码写入 `/root/cloudalbum-admin.txt`（总纲 2.7 第 12 步），平台模式下不适用。

**规格**

- 平台模式（`PLATFORM_MODE=on`）下引导脚本**跳过** `admin:ensure`，不写 `/root/cloudalbum-admin.txt`。
- 新增 CLI：`cloudalbum admin:ensure --email <email> --password-hash <PHC 字符串> [--reset]`：
  - 只接受 argon2id 的 PHC 字符串（`$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`），参数不得低于应用本身注册用户时使用的参数，否则退出 2；
  - 没有该邮箱的管理员 → 创建（`role=admin`、`email_verified=true`），输出 `{"created":true}`；
  - 已存在 → 不改动，输出 `{"created":false}`；带 `--reset` 时替换哈希并递增 `users.token_version`（已签发令牌立即失效），输出 `{"updated":true}`；
  - 平台模式下拒绝旧选项 `--print-password-if-created`（退出 2）。
- 管理员邮箱：运行器传入 `atl-admin@example.com`（保留域名，PM-46 保证不会真正发信）；学员之后可以在应用里修改。
- 认证驱动切换到 cognito 之后，管理员在 Cognito 中的密码由平台钩子同步（PM-36、PM-44），使 `app-admin-password` 始终可用于登录。

**代码位置**：`backend/src/cli.ts`（子命令登记）、`backend/src/cli/admin.ts`（新增）、`infra/userdata/l0-bootstrap.sh`。

**测试**：PHC 解析与参数下限；三种结果分支；`--reset` 后旧令牌失效；平台模式下引导脚本不创建管理员。

**优先级**：P0。

### PM-08 平台目录与用户的所有权；L0 冒烟测试的平台差异（S02 为 P0，其余 P1）

**需求**：平台模式下实验机上有不属于应用的东西（管理通道、`labuser`、`/opt/atl`），CloudAlbum 的本地自检与冒烟测试不能把它们误判为应用问题；L0 冒烟测试 S02“实例没有实例配置文件”在平台模式下必然失败（cards 第 1 批 B-13）。

**规格**

1. **所有权**（03 §3.4）：`/opt/atl/`、`/etc/atl/`、`/var/lib/atl/`、`labuser`（uid 2100）及其免密 sudo 属于平台。CloudAlbum 的 `hostSetup`、`install-host-files.sh` 不得修改（例外：PM-04 的安装步骤）。
2. **本地自检的平台例外**：`security-snapshot.sh`、compliance 的本地自检器、vuln-scan 的本地扫描、leak-scan 遇到上述对象时标注 `"owner":"platform"`，不计入应用的合规分数与“发现”计数（PM-M33、PM-M34）。
3. **冒烟测试的平台分支**（`experiments/ec2/smoke.ts`，以 `app.platform.mode` 判断）：

| # | 独立模式（不变） | 平台模式 |
|---|---|---|
| S02 | 无 `Export`；无 `AWS::IAM::*`；实例没有实例配置文件 | 无 `Export`；基础栈中无 `AWS::IAM::*`；实例配置文件为 `CloudAlbumAppRole`，角色上的托管策略只有 `AmazonSSMManagedInstanceCore`（平台栈参数 `TerminalRecording=cloudwatch` 时另有栈管理的 `atl-terminal-recording`）；capabilities 中 `iam.driver=none`（应用不使用这组凭证） |
| S09 | 对外只有 22、80、443 | 同左；`SshIngressCidr` 为空时 22 不对外 |
| S28（新增） | — | `platform-status`：`platformEnv.valid=true`、`probeToken.present=true`、`checkBundle.installed` 含 `releaseDigest` |
| S29（新增） | — | 本机带本机令牌请求 `/api/lab/probe/now` 返回 200；不带令牌返回 401 |
| S30（新增，P1） | — | `GET /` 与 `GET /index.html` 带 `Content-Security-Policy: frame-ancestors 'self' <ATL_PLATFORM_ORIGIN>`，没有 `X-Frame-Options` |

4. 冒烟测试的主机检查在平台模式下一律经 SSM 投递（PM-30），不使用 ssh。

**代码位置**：`experiments/ec2/smoke.ts`、`infra/host/security-snapshot.sh`、`backend/src/services/compliance-check.ts`、`infra/host/vuln-scan.sh`。

**测试**：smoke 的两个分支各一个夹具环境；本地自检对 `labuser` sudo 的标注。

**优先级**：S02、S28、S29 为 P0（svc-ec2 的 `exp-smoke` 依赖）；其余 P1。

---
## 4. 探测令牌与探测端点

### PM-09 探测令牌：本机令牌与一次性令牌（P0）

**需求**：平台需要以“只读的探测主体”访问 CloudAlbum：读取 capabilities 的管理员视图（04 §5.2.2）、请求 `/api/lab/probe/*`（04 §5.2.3）。实验机本机发起的请求用本机令牌；平台 Lambda 或实验机经 CloudFront、ALB 等入口回访时用一次性令牌（01 §9.4、04 §5.2.3）。

**规格**

- **请求头**：两种令牌都放在 `X-ATL-Probe-Token`，按前缀区分。令牌不出现在 URL、Nginx 日志、应用日志与证据中（04 §5.5 打码）。
- **本机密钥文件**：`ATL_PROBE_TOKEN_FILE`（默认 `/etc/cloudalbum/atl/probe.token`，在数据卷上；目录 `root:cloudalbum 0750`，文件 `root:cloudalbum 0640`）。内容一行：`atlpk1.<32 个随机字节的 base64url>`。由 `cloudalbum probe-token --init`（root）在不存在时生成；`--rotate` 重新生成（同时使未过期的一次性令牌与 `lab-token` 全部失效）；任何命令都不打印它的值，只打印 `{"present":true,"fingerprint":"sha256:<前 12 位十六进制>"}`。实例替换后随数据卷保留；ASG 模式下随引导配置包分发到每台实例（PM-M07）。
- **本机令牌**：请求头的值就是文件内容。有效条件（全部满足）：
  1. 平台模式开启；
  2. 与文件内容常量时间比较相等；
  3. 请求来自回环地址：`req.ip ∈ {127.0.0.1, ::1}`。`req.ip` 由 Express（`trust proxy=loopback`）取自 Nginx 写入的 `X-Forwarded-For`，即 realip 解析后的 `$remote_addr`；直接请求应用端口（`127.0.0.1:3000`，PM-15 的回退路径）时取 TCP 对端地址；
  4. 入口为直连：Nginx 经 `cloudalbum_proxy.conf` 传给应用的入口段为 `nginx`，或请求直接到达应用端口。经 8080（cdn）或 ALB 到达的请求一律不接受本机令牌。

  不满足第 3、4 条 → 401 `PROBE_LOCAL_ONLY`。
- **一次性令牌**：`atlpt1.<nonce>.<exp>.<sig>`
  - `nonce`：16 个随机字节的 base64url（22 个字符）；`exp`：Unix 秒；
  - `sig = base64url(HMAC-SHA256(K_otp, "atlpt1.<nonce>.<exp>"))`，`K_otp = HKDF-SHA256(ikm=本机密钥的 32 字节, salt=空, info="cloudalbum/atl-probe/otp/v1", L=32)`；
  - 有效条件：平台模式开启；格式匹配 `^atlpt1\.[A-Za-z0-9_-]{22}\.[0-9]{10}\.[A-Za-z0-9_-]{43}$`；`now - 5 ≤ exp ≤ now + 65`（容忍 5 秒时钟偏差，签发上限 60 秒）；签名常量时间比较相等；`nonce` 未被使用过。来源地址不限（经 CloudFront、ALB 到达源站）。
  - **一次性**：校验通过后向表 `atl_probe_nonces(nonce TEXT PRIMARY KEY, exp BIGINT NOT NULL, used_at BIGINT NOT NULL, instance_id TEXT)` 插入一行；主键冲突 → 401 `PROBE_TOKEN_REPLAYED`。数据库不可用 → 503 `PROBE_STORE_UNAVAILABLE`。worker 每 10 分钟删除 `exp < now - 600` 的行（定时任务 `atl-probe-nonce-gc`）。多实例时表在共享库中（ASG 必然已启用 database，ASG-002），各实例同一把密钥，所以令牌在任一实例上都可验证。
  - 失效时：401 `PROBE_TOKEN_INVALID` 或 `PROBE_TOKEN_EXPIRED`。
- **签发**：只能由本机 CLI `probe-token` 签发（PM-13）。平台经 `ATL-RunCheck` 的 `probe-token` 检查取得令牌，只在内存中使用（04 §5.2.3）；令牌会出现在该次 Run Command 的输出里，因为它短时有效且只能用一次，这一暴露可以接受。
- **安全说明**：能读到本机密钥的身份——实验机上的 root 与 `cloudalbum` 组、ASG 模式下能读引导配置包的身份（学员、实例角色）——都能签发令牌。它们本来就能控制这台实例，所以这不扩大权限；`atl-probe` 只读，`atl-lab` 等同于应用管理员（PM-17），都只在平台模式下生效。
- **迁移**：新增迁移 `NNNN_atl_probe_nonces`（SQLite 与 PostgreSQL 两种方言）。

**代码位置**：`backend/src/platform/probe-token.ts`（新增：解析、校验、HKDF）、`backend/src/db/migrations/`、`backend/src/repositories/atl-probe-nonces.ts`（新增）、`backend/src/jobs/atl-probe-nonce-gc.ts`（新增；ScheduledJobName 增加 `atl.probe-nonce-gc`）。

**测试**：令牌格式与签名的单元测试（篡改 `exp`、篡改签名、过期、未来过远）；重放返回 401；两台实例共享库时一台签发、另一台验证通过；回环判定（经 8080、经 ALB、`X-Forwarded-For` 伪造）；平台模式关闭时 401→404（端点不存在）。

**优先级**：P0。

### PM-10 只读主体 `atl-probe` 与探测流量标记（P0）

**需求**：持有有效令牌的请求要能读到管理员视图与路径头，但不能有任何写能力；平台的探测流量不能污染对比实验与感知器的统计（防止“检测器自己证明自己”）。

**规格**

- **主体**：`{ kind: "probe", id: "atl-probe", groups: ["probe"] }`。只在平台模式下存在。
- **权限**：

| 能力 | 是否允许 |
|---|---|
| `GET /api/capabilities?view=admin`（含 `fields`、`modules`） | 是；`deep=1` → 403 `PROBE_DEEP_FORBIDDEN` |
| `GET /api/lab/probe/*`（PM-11） | 是 |
| 路径头 `X-CloudAlbum-Path` 与 `Server-Timing` | 总是返回，不受 `EXPOSE_PATH_HEADERS` 影响 |
| 其他 `GET` 路由 | 按匿名用户处理（不提升权限），但路径头照常返回 |
| 任何非 `GET` 请求 | 按匿名用户处理 |
| `X-Compare-Bypass`、`X-Experiment-*` 的特权语义、`/api/lab/faults`、`/api/admin/*` | 否（`BYPASS_FORBIDDEN` 等既有错误码不变） |

- 同时带有用户会话 Cookie 与探测令牌时：只有 `/api/capabilities` 的管理员视图与 `/api/lab/probe/*` 采用探测主体，其余路由按 Cookie 中的用户处理。
- **探测流量标记**：请求上下文的 `probe=true` 当且仅当：持有有效探测令牌，或带请求头 `X-ATL-Probe-Nonce`（04 §5.2.3 中平台 `http-header` 检查自动附带的非鉴权头，值匹配 `^[A-Za-z0-9_-]{16,64}$`）。标记的效果：
  - LabMetricsStore 不把它计入分钟汇总、路由延迟分布、源站卸载、`path-seen`、`lab-metrics`（PM-14、PM-16），也不计入感知器的观测窗口（例如 cdn 的“最近 5 分钟回源比例”）；
  - 只计入指标 `cloudalbum_atl_probe_requests_total{kind="local|otp|nonce"}`；
  - 不写 `audit_log`（太频繁）；
  - Nginx 日志的 `probe` 字段为 1（PM-18）。
- **限速**：Nginx 的 `ca_api` 限速照常生效；应用层对 `atl-probe` 另限每分钟 120 个请求（超出 429 `RATE_LIMITED`）。

**代码位置**：`backend/src/http/middleware/atl-probe.ts`（新增，排在 `auth.ts` 之前）、`backend/src/observability/request-context.ts`、`backend/src/observability/lab-metrics.ts`、`backend/src/modules/detectors/*.ts`（统一用 `ctx.probe` 过滤）、`backend/src/observability/path-header.ts`（暴露判定）。

**测试**：权限表逐行一个用例；探测请求不改变 `lab_metric_rollups` 与感知器窗口；`X-ATL-Probe-Nonce` 不授予任何权限。

**优先级**：P0。

### PM-11 `/api/lab/probe/*` 端点（now、echo、media-url 为 P0；auth、identity-pool、kms 为 P1）

**需求**：已认证路径或异步路径上的模块（database、cache、config、storage、auth、identity-pool、kms）不会出现在匿名请求的路径头中，检查需要一组只读、可经任意入口到达、能经过指定端口的端点（01 §9.4、04 §5.2.3、cards 第 1 批 B-12、第 2 批 C-15）。统一命名为 `/api/lab/probe/*`，**取代** `/api/console/probe/*`、`/api/lab/now`、`/api/lab/echo` 等写法。

**通用规格**

- 只在平台模式下注册；平台模式关闭时返回 404（不暴露端点存在）。
- 只接受 `GET`（其他方法 405）；必须是 `atl-probe`（否则 401，错误码见 PM-09）。
- 响应：`Content-Type: application/json`、`Cache-Control: private, no-store`；总是带 `X-CloudAlbum-Path` 与 `Server-Timing`。
- 端口调用都经 instrument 代理，路径段与总纲 7.2 的词表一致；端口运行时故障 → 503，响应体 `{"ok":false,"error":{…}}`，路径头中对应段的结果为 `error`（检查以路径头作证据）。
- 未知端点 → 404 `PROBE_UNKNOWN`。
- 经 CloudFront 请求时：`/api/*` 行为转发全部查看器请求头（AllViewer 系列源请求策略），`X-ATL-Probe-Token` 能到达源站（PM-24）。

**端点清单**

| 端点 | 经过的端口与路径段 | 响应体 | 主要使用者 | 优先级 |
|---|---|---|---|---|
| `GET /api/lab/probe/now` | ConfigPort 读运行时热键 `featureFlags`（`config=file:v<n>` 或 `ssm:v<n>`）；主库 `db` 执行 `select now()`（`database=sqlite`、`postgres@local`、`postgres@pgbouncer`、`postgres@rds`、`postgres@rds-proxy`）；CachePort 以键 `probe:now:<instanceId>`、TTL 30 秒做一次 cache-aside（`cache=none`、`memory:hit/miss`、`redis@local:…`、`redis@elasticache:hit/miss`；数据库调用**不**放进 loader，每次都执行，所以 database 段总是出现） | `{ "now": "<数据库时间，ISO，毫秒>", "appNow": "<应用时间>", "nonce": "<22 字符随机>", "instanceId", "az", "cache": { "hit": true }, "db": { "driver": "postgres", "hostClass": "rds" } }` | svc-cdn 的 `api-not-cached`（两次请求的 `now` 不同、都不命中边缘缓存）；svc-database、svc-cache、svc-db-proxy、svc-config、sc-db-performance 的 wire 检查；健康门 | P0 |
| `GET /api/lab/probe/echo` | 无端口 | `{ "method", "host", "proto", "serverPort", "entry", "clientIp", "receivedXForwardedFor", "xAmznTraceId", "via", "cfIdPresent", "hasCookie", "hasAuthorization", "headerNames": [...] }`。`proto` = 应用看到的 `X-Forwarded-Proto`（Nginx 的 `$ca_proto`）；`receivedXForwardedFor` = Nginx 收到的原始 `X-Forwarded-For`（PM-18 新增转发头）；**从不回显** Cookie、Authorization 与任何令牌的值 | svc-load-balancer 第 4 步（回显 `X-Amzn-Trace-Id`、`X-Forwarded-Proto`）；svc-cdn 的回源转发检查（Cookie、Authorization、Host） | P0 |
| `GET /api/lab/probe/media-url?variant=thumb_200\|original&visibility=public\|private` | MediaUrlBuilder 为保留键 `_probe/<instanceId>/probe.jpg`（及其 `variants/` 键）生成 URL，不要求对象存在：StoragePort 签名（`storage=local:sign`、`s3:presign`；shared-fs 启用时 `shared-fs=efs:sign`），CdnPort 改写（`cdn=cloudfront`） | `{ "url", "host", "scheme", "signed": true, "expiresInSec", "provider": "storage:s3", "cdn": true }`（URL 中的签名参数由平台按 04 §5.5 打码） | svc-storage、svc-shared-fs、svc-cdn 的 wire 检查 | P0 |
| `GET /api/lab/probe/auth` | AuthPort：`local` 驱动用当前签名私钥签一个只在本次请求中使用的令牌（`sub=atl-probe`、`aud=probe`、30 秒有效）并经验证路径校验（`auth=local:verify`）；`cognito` 驱动检查 JWKS 缓存（过期则拉取，路径段追加 `cognito:jwks-fetch`）并调用 `DescribeUserPool`，路径段为 `auth=cognito:<COGNITO_LOGIN_MODE>`（`sdk` 或 `managed`） | `{ "driver", "loginMode", "kids": [...], "jwksAgeSec", "userPoolId" }` | svc-auth、sc-user-identity 的 wire 检查 | P1 |
| `GET /api/lab/probe/identity-pool` | DirectUploadPort：`none` 驱动为保留前缀 `_probe/` 签发一个前缀令牌后丢弃（`identity-pool=none:token`）；`cognito` 驱动调用 `DescribeIdentityPool` 并 `HeadBucket` 暂存桶，路径段为 `identity-pool=cognito:probe`（**新增结果词**：真正的 `cognito:sts` 需要终端用户的 ID 令牌，探测主体没有，见 §16 第 4 条） | `{ "driver", "mode", "bucket", "allowUnauthenticated": false }` | svc-identity-pool、sc-user-identity 的 wire 检查 | P1 |
| `GET /api/lab/probe/kms` | CryptoPort 对 32 个随机字节加密再解密，加密上下文 `{app:"cloudalbum", purpose:"atl-probe"}`（`kms=local:encrypt`、`kms:cache-hit`、`kms:call`） | `{ "driver", "keyRef", "cache": "hit\|miss" }` | svc-kms 的 wire 检查 | P1 |

- 不提供 `/api/lab/probe/config`：`now` 已经经过 ConfigPort。svc-config 第 2 步原写“请求 `/api/capabilities` 读 `config=` 段”，capabilities 不保证调用 ConfigPort，应改为 `/api/lab/probe/now`（§15）。
- 只出现在 POST 或异步路径上的模块（queue、image-processing、notification、email、tagging、social-store、analytics）不设探测端点，改用 `path-seen` 读取真实请求的路径签名（PM-16）。

**代码位置**：`backend/src/http/routes/lab-probe.ts`（新增）、`backend/src/http/app.ts`（平台模式下注册）、`packages/contracts`（响应类型、新增结果词 `cognito:probe`、`efs:sign`）。

**测试**：每个端点在本地驱动与 AWS 驱动下的路径段（契约测试，AWS 驱动用 LocalStack 或沙箱账号）；`now` 第二次请求 `cache=…:hit` 且仍有 `database` 段；`echo` 不回显 Cookie 值；平台模式关闭 404；07 中经 CloudFront 的 `now` 两次都不命中边缘缓存。

**优先级**：见表。

---

## 5. 本机 CLI

### PM-12 CLI 入口与通用约定（P0）

**需求**：`ATL-RunCheck` 的检查包、运行器（经 SSM）、学员（实验机终端）都需要调用 CloudAlbum 的本机命令；需要 CloudAlbum 配合的检查只调用这些 CLI 或回环接口，不直接读 CloudAlbum 的数据库（04 §6.4）。01 §9.3 中的 `/opt/cloudalbum/bin/cloudalbum atl-check --params-file` 写法作废：`atl-check` 就是检查包的启动器 `/opt/atl/bin/atl-check`（PM-04），CloudAlbum 负责打包、安装并提供它调用的子命令。

**规格**

- **入口**：`/opt/cloudalbum/bin/cloudalbum`（发布包 `infra/host/cloudalbum`，`root:root 0755`），另建符号链接 `/usr/local/bin/cloudalbum`。它是 Bash 包装：
  - **根子命令**（只能以 root 执行，由 Bash 脚本实现，不以 root 运行 Node）：`platform:apply-env`、`probe-token --init|--rotate`、`atl-bundle:install`；
  - **其余子命令**：`runuser -u cloudalbum -- env CLOUDALBUM_ENV_DIR=/etc/cloudalbum CLOUDALBUM_ROLE=cli node /opt/cloudalbum/backend/dist/cli.js <子命令> …`。
- **输出**：stdout 只有一个 JSON 对象（成功时为结果，失败时为 `{"error":{"code","message"}}`）；人读的信息写 stderr。
- **退出码**：0 成功；2 用法或参数错误；3 不可用（平台模式关闭、应用未就绪、数据库不可达）；4 对象不存在（例如未登记的 `runId`）；5 内部错误。
- **参数安全**：所有参数先按正则校验再使用；检查包以 `execFile` 固定 argv 调用（04 §6.4），不经过 shell。

**子命令一览**（本文新增或改动的）

| 子命令 | 身份 | 用途 | 主要调用方 | 条目 |
|---|---|---|---|---|
| `platform:apply-env` | root | 写入平台配置 | 运行器 | PM-02 |
| `platform-status` | 任意 | 平台模式自检 | 健康门 `base.ready` | PM-02 |
| `atl-bundle:install` | root | 安装或修复检查包 | 运行器 `repair` | PM-04 |
| `admin:ensure --password-hash` | cloudalbum | 非交互初始化管理员 | 运行器 | PM-07 |
| `probe-token` | cloudalbum（`--init`/`--rotate` 为 root） | 签发一次性探测令牌 | 检查包 `probe-token` | PM-13 |
| `lab-metrics` | cloudalbum | 按 `runId` 汇总服务端指标 | 检查包 `lab-metrics-run` | PM-14 |
| `capabilities` | cloudalbum | 本机读取 capabilities 投影 | 检查包 `capability-snapshot`、`caps.profile` | PM-15 |
| `module-state` | cloudalbum | 已启用模块摘要 | 检查包 `module-state` | PM-15 |
| `path-seen` | cloudalbum | 路径签名中某段的出现次数 | 检查包 `path-seen` | PM-16 |
| `app-stat` | cloudalbum | 登记的业务统计 | 检查包 `app-stat` | PM-16 |
| `lab-token` | cloudalbum | 签发实验主体令牌 | 实验运行器（经 SSM）、实验机侧脚本 | PM-17 |
| `seed <id>` | cloudalbum | 测试数据种子的实验机部分 | 运行器（经 SSM） | §11 |
| `iam:install-keys` | root | keys 模式交接访问密钥 | 运行器（平台动作） | PM-31 |

**代码位置**：`infra/host/cloudalbum`（新增）、`backend/src/cli.ts`（登记）、`backend/src/cli/platform/*.ts`（新增）、`infra/install-host-files.sh`。

**测试**：包装脚本的身份分派（以非 root 调用根子命令 → 退出 2）；每个子命令的 JSON 输出 schema 快照；参数注入用例（含空格、`;`、`$()`）。

**优先级**：P0。

### PM-13 `probe-token`（P0）

**规格**

```text
cloudalbum probe-token --ttl <1..60> [--count <1..5>]     # 签发一次性令牌
cloudalbum probe-token --status                            # {"present":true,"fingerprint":"sha256:…"}
cloudalbum probe-token --init | --rotate                   # root：生成或轮换本机密钥
```

- 签发输出：`{"tokens":["atlpt1.…"],"expiresAt":"<ISO>"}`；`--count` 用于 `repeat` 检查每次请求各用一个（04 §6.4）。
- 平台模式关闭或密钥不存在 → 退出 3。签发不访问数据库（`nonce` 在使用时才登记）。
- 旧名 `cloudalbum-probe-token`（检查目录第 1 轮的写法）在一个次版本内作为别名保留。

**代码位置**：`backend/src/cli/platform/probe-token.ts`、`infra/host/platform/probe-secret.sh`（`--init`/`--rotate`）。

**测试**：签发的令牌能通过 PM-09 的校验；`--ttl 61` 退出 2；轮换后旧令牌失效。

**优先级**：P0。

### PM-14 `lab-metrics`（P0）

**需求**：平台对对比实验做服务端佐证：核对时间窗、按目标的请求数、路径签名占比（01 §9.5、04 §7.4 第 5～7 步）。

**规格**

```text
cloudalbum lab-metrics --run <runId> [--pad <0..120 秒，默认 30>] --json
```

输出：

```json
{
  "schema": "cloudalbum.lab-metrics-run/v1",
  "runId": "01JB3M2C8Y3T5Q6W7E8R9T0Y1U",
  "registered": { "module": "cdn", "experiment": "media-load", "label": "after", "startedAt": "…", "windowSec": 600 },
  "window": { "from": "…", "to": "…", "padSec": 30 },
  "app": {
    "requests": 40,
    "byTarget": { "direct": 20, "cdn": 20, "alb": 0, "apigw": 0 },
    "byStatus": { "2xx": 40, "4xx": 0, "5xx": 0 },
    "pathSignatures": [ { "signature": "entry=cloudfront>nginx;storage=local:accel;cdn=cloudfront", "count": 6 } ],
    "routes": { "/media/variants/:id/:file": { "count": 26, "p50": 0, "p95": 0 } }
  },
  "origin": {
    "source": "nginx-access-log",
    "requests": 26,
    "byPort": { "80": 20, "443": 0, "8080": 6 },
    "viaCloudfront": 6, "viaAlb": 0
  },
  "host": { "cpuP95": 0, "netTxBytes": 0, "netRxBytes": 0 },
  "excludedProbeRequests": 2
}
```

（数值字段用 0 占位。）

- `app` 来自 LabMetricsStore 中带该 `runId` 的分钟汇总（总纲 7.3：实验请求按 runId 单独成组），`pathSignatures` 取前 20 项。
- `byTarget` 由路径签名中的 `entry` 段映射：`nginx` → `direct`；以 `cloudfront>` 开头 → `cdn`；以 `alb>` 开头 → `alb`；以 `apigw>` 开头 → `apigw`。
- `origin` 来自 Nginx 访问日志中 `run` 字段等于该 runId 的行（PM-18），覆盖 Nginx 直接返回的静态文件与经 8080 回源的请求；`byPort` 按 `port` 字段计数。
- 两部分都排除 `probe=1` 的请求（PM-10）。
- `runId` 未登记 → 退出 4；时间窗尚未结束时照样输出，并带 `"open": true`。

**代码位置**：`backend/src/cli/platform/lab-metrics.ts`（新增）、`backend/src/observability/lab-metrics.ts`（按 runId 查询）、`backend/src/repositories/lab.ts`。

**测试**：夹具数据（含探测请求、经 8080 与直连混合）的输出快照；Nginx 日志旧格式行（无 `run` 字段）被跳过而不是报错。

**优先级**：P0。

### PM-15 `capabilities`、`platform-status`、`module-state`（P0）

**规格**

- `cloudalbum capabilities [--fields <投影>] [--modules a,b] [--view public|admin] --json`：带本机令牌请求 `http://127.0.0.1/api/capabilities`（`Host: 127.0.0.1`）；连接被拒或 502/503 时退回 `http://127.0.0.1:3000`（01 §9.3 “80 端口不可用时退回应用端口”）。输出 `{"via":"nginx|direct","etag":"…","data":{…投影…}}`；`data.truncated=true` 时调用方按 `nextModules` 分批。
- `cloudalbum platform-status --json`：见 PM-02。
- `cloudalbum module-state [--module <id>] --json`：读取 `/etc/cloudalbum/modules.state.json` 与 `modules.d/*.env` 的开关取值，输出：

```json
{
  "schema": "cloudalbum.module-state/v1",
  "modules": { "cdn": { "enabled": true, "driver": "cloudfront", "version": 3, "enabledAt": "…", "envFile": true } },
  "pending": null,
  "history": [ { "opId": "01J…", "op": "enable", "module": "cdn", "at": "…", "operator": "atl-s4k7m2q9x1abc-ws" } ]
}
```

  `modules.state.json` 的格式以此为准：`modules{id:{enabled, driver, version, enabledAt}}`、`history[{opId, op, module, at, operator, profile?}]`、`pending{opId, module, op, startedAt}`（`scripts/module` 在投递配置时写入 `pending`，收尾时写入历史并清除）。`operator` 在平台模式下是调用者的角色会话名。

**代码位置**：`backend/src/cli/platform/capabilities.ts`、`status.ts`、`module-state.ts`（新增）；`scripts/module-cli/src/enable.ts`、`disable.ts`（写 `modules.state.json`）。

**测试**：Nginx 停止时退回应用端口；`module-state` 在 `pending` 存在时的输出。

**优先级**：P0。

### PM-16 `path-seen`（P0）与 `app-stat`（P1）

**需求**：只在 POST 或异步路径上出现的模块需要“真的接入”的证据（04 §6.4、cards 第 2 批 C-3、scenario-cards B-22）；按运行判定的业务计数（例如 `biz.jobs_lost`）需要 `runId` 参数（scenario-cards B-11）。

**规格**

```text
cloudalbum path-seen --segment <模块 id 或 entry> --pattern <RE2，≤128 字符> --window <1m..24h>
                     [--min-count <n，默认 1>] [--distinct] --json
cloudalbum app-stat --stat <统计名> [--run <runId>] --json
```

- `path-seen` 从 LabMetricsStore 的分钟汇总中查找真实请求（排除 `probe=1`）的路径签名，对指定段的值（`driver[@host][:outcome]`）做 RE2 匹配。输出 `{"count":12,"distinctValues":["s3:presign"],"firstTs":"…","lastTs":"…","samples":[{"ts":"…","route":"POST /api/photos","value":"s3:presign"}]}`，`samples` 最多 3 条。窗口超过汇总保留期（总纲 7.3）时退出 2。模式用 RE2 求值，拒绝回溯类构造。
- `app-stat` 的统计名白名单（新增统计名须同时更新本表与 04 §6.4）：

| 统计名 | 含义 | 支持 `--run` |
|---|---|---|
| `photos.count`、`users.count`、`albums.count` | 当前行数 | 否 |
| `jobs.pending`、`jobs.failed` | `job_runs` 中的待处理、失败数 | 是（时间窗内新增） |
| `biz.jobs_lost` | 时间窗内入队、窗口结束后 10 分钟内仍未完成也未进入失败或 DLQ 的任务数 | 只按运行 |
| `biz.photo_time_to_ready_p95` | 时间窗内创建的照片从创建到 `READY` 的 p95（毫秒） | 只按运行 |
| `queue.dlq_depth` | 模块自带 DLQ 的深度（`QUEUE_DRIVER=sqs` 时） | 否 |
| `outbox.count`、`notifications.count` | 本地 outbox 与站内信数量 | 是 |
| `security.findings` | 本地安全分析器的未关闭发现数（不含 `owner=platform` 的项，PM-08） | 否 |
| `cache.hit_ratio_1m` | 最近 1 分钟缓存命中率 | 否 |
| `lab.seed.photos` | `lab:seed` 生成的照片数（PM-47） | 否 |

  输出 `{"stat":"biz.jobs_lost","value":0,"unit":"count","at":"…","runId":"…","scope":"run"}`；未知统计名退出 2。

**代码位置**：`backend/src/cli/platform/path-seen.ts`、`app-stat.ts`（新增）、`backend/src/lab/app-stats.ts`（新增：统计名登记表）。

**测试**：`path-seen` 排除探测请求；RE2 拒绝回溯模式；`biz.jobs_lost` 在“memory 队列重启丢任务”夹具中为正、在 SQS 夹具中为 0。

**优先级**：`path-seen` P0（svc-queue、svc-image-processing 的 wire 检查依赖）；`app-stat` P1。

### PM-17 `lab-token` 与实验主体 `atl-lab`（P1）

**需求**：对比实验运行器需要管理员权限（`POST /api/lab/runs`、`GET /api/lab/metrics?run=`、`X-Compare-Bypass`）。auth 从 local 切换到 cognito 之后，现有管理员令牌全部失效，bulk 迁移又不迁移密码（总纲 9.3），运行器靠密码重新登录不可靠；托管登录模式下也无法无界面登录。实验机侧脚本（PM-41）同样需要管理员身份，但不能经命令参数传递令牌。

**规格**

```text
cloudalbum lab-token [--ttl <60..14400 秒，默认 3600>] --json   # {"token":"atllt1.…","expiresAt":"…"}
```

- 格式 `atllt1.<nonce>.<exp>.<sig>`，`K_lab = HKDF-SHA256(本机密钥, info="cloudalbum/atl-lab/v1")`，签名方式同 PM-09；**不是一次性的**，在有效期内可重复使用；`probe-token --rotate` 使其全部失效。
- 使用：请求头 `Authorization: CA-Lab <token>`。只在平台模式下接受，来源地址不限。
- 主体：应用中最早创建的管理员账号（`users.role='admin'`，按 `created_at` 取第一个），附加 `amr: ["atl-lab"]`。权限等同于该管理员，但拒绝修改凭证类操作（改密码、改 MFA、改邮箱、改角色）→ 403 `LAB_TOKEN_SCOPE`。`audit_log` 的 actor 记为 `atl-lab`。
- 与 auth 驱动无关：中间件在 AuthPort 之前识别 `CA-Lab`，所以 local 与 cognito 下都可用。
- CSRF：使用请求头令牌的请求不需要 CSRF 令牌（与 `CA-Upload` 相同）。
- 取得方式：工作台上的运行器以学员身份经 SSM Run Command（`AWS-RunShellScript`，按实例 ID 投递，03 §4.11 已有的权限）执行 `cloudalbum lab-token --ttl 3600 --json`，结果缓存在 `~/.atl/cloudalbum-admin-token`（0600）；实验机侧脚本在本机直接调用。令牌会出现在该次 Run Command 的输出中，能读到它的身份本来就能在实例上执行命令，所以不扩大权限。

**代码位置**：`backend/src/platform/lab-token.ts`（新增）、`backend/src/http/middleware/auth.ts`（识别 `CA-Lab`）、`backend/src/cli/platform/lab-token.ts`。

**测试**：local 与 cognito 两种驱动下都能调用 `/api/lab/runs`；凭证类操作被拒；平台模式关闭时 401；轮换后失效。

**优先级**：P1（auth 切换类卡片 svc-auth、sc-user-identity 依赖；示例卡片的认证驱动不变，可以用密码登录，见 PM-42）。

---

## 6. Nginx

### PM-18 访问日志追加字段（P0，两种模式都生效）

**需求**：`nginx-log-summary` 要按查询串中的 nonce 计数、按端口区分入口（04 M-1，svc-cdn 的 `edge-cache-observed`）；`lab-metrics` 要按运行统计源站请求（PM-14）；探测流量要可识别（PM-10）；`/api/lab/probe/echo` 要回显 Nginx 收到的原始 `X-Forwarded-For`（PM-11）。

**规格**

- `log_format cloudalbum_json` 在现有字段**之后**追加四个字段（不改变 fail2ban 依赖的既有字段顺序）：

```nginx
log_format cloudalbum_json escape=json
  '{"ts":"$time_iso8601","rid":"$request_id","ip":"$remote_addr","xff":"$http_x_forwarded_for",'
  '"method":"$request_method","uri":"$uri","status":$status,"bytes":$body_bytes_sent,'
  '"rt":$request_time,"urt":"$upstream_response_time","cf_id":"$http_x_amz_cf_id",'
  '"via":"$http_via","alb_trace":"$http_x_amzn_trace_id","path":"$upstream_http_x_cloudalbum_path",'
  '"args":"$ca_log_args","port":"$server_port","run":"$ca_log_run","probe":"$ca_probe"}';
```

- `00-entry.conf`（ec2 所有）新增三个 map：

```nginx
# 查询串可能含签名与授权码：出现敏感参数时整段替换（atlprobe 等探测参数所在的请求不会带这些参数）
map $args $ca_log_args {
    default $args;
    "~*(^|&)(sig|signature|token|code|state|x-amz-[a-z-]+)=" "[redacted]";
}
# 只记录格式合法的实验运行 ID（ULID）
map $http_x_experiment_run $ca_log_run {
    default "";
    "~^[0-9A-HJKMNP-TV-Z]{26}$" $http_x_experiment_run;
}
# 平台探测流量：带探测令牌或平台探测 nonce 头
map "$http_x_atl_probe_token$http_x_atl_probe_nonce" $ca_probe {
    default 1;
    ""      0;
}
```

- `cloudalbum_proxy.conf`（ec2 所有）新增一行：`proxy_set_header X-CA-Received-XFF $http_x_forwarded_for;`。应用只在 `/api/lab/probe/echo` 中读取它，并且在所有其他路由上忽略它（不得用于任何信任判断）。
- `nginx-log-summary` 的计数规则（04 §6.4）：`nonce` 计数在全部行中查找查询串参数 `atlprobe=<nonce>`（**包括** `probe=1` 的行——带 nonce 的检查请求本身就是平台发出的）；`counts` 类汇总排除 `probe=1` 的行。
- worker 的源站卸载统计（总纲 7.3 `lab_origin_samples`）按 `port` 与 `$ca_entry` 统计，并排除 `probe=1`。
- fail2ban 过滤器不得以最后一个字段锚定（例如不写 `"path":"[^"]*"}$`）；CI 用 `fail2ban-regex` 对新格式的样例行回归。

**代码位置**：`infra/nginx/cloudalbum.conf`、`infra/nginx/00-entry.conf`、`infra/nginx/cloudalbum_proxy.conf`、`infra/host/fail2ban/`、`backend/src/observability/lab-metrics.ts`（日志解析兼容新旧格式）。

**测试**：`nginx -t`；样例请求的日志行快照（含敏感参数被替换、非法运行 ID 为空）；`fail2ban-regex` 回归；日志解析器读取旧格式行不报错。

**优先级**：P0。

### PM-19 来自回环地址的请求不做 HTTPS 跳转（P0）

**需求**：`ATL-RunCheck` 与本机 CLI 以 `http://127.0.0.1/` 访问应用（P9）。tls 模块开启 `TLS_FORCE_HTTPS=true`（80→443 跳转）后，本机请求会被跳转到 `https://127.0.0.1/`，证书不匹配，检查失败。

**规格**

- `00-entry.conf` 新增 map（ec2 所有，模块不得自行定义跳转条件）：

```nginx
map "$ca_proto|$ca_entry|$remote_addr|$uri" $ca_https_redirect {
    default 0;
    "~^http\|nginx\|(127\.0\.0\.1|::1)\|"                     0;   # 本机请求不跳转
    "~^http\|nginx\|[^|]*\|/\.well-known/acme-challenge/"     0;   # HTTP-01 验证不跳转
    "~^http\|nginx\|"                                         1;   # 其余直连明文请求跳转
}
```

- tls 模块投放的跳转片段（`cloudalbum.server.d/tls-force-https.conf`，只在 `TLS_FORCE_HTTPS=true` 时存在）改为只使用这个变量：`if ($ca_https_redirect) { return 301 https://$host$request_uri; }`；HSTS 头同样不对回环请求输出。
- 两种模式都生效（对独立模式无副作用：本机请求本来就不该被跳转）。

**代码位置**：`infra/nginx/00-entry.conf`、`infra/modules/tls/nginx/tls-force-https.conf.tpl`。

**测试**：`TLS_FORCE_HTTPS=true` 时 `curl http://127.0.0.1/api/health/ready` 为 200、经 EIP 明文请求为 301、ACME 验证路径不跳转。

**优先级**：P0。

### PM-20 HTML 响应输出 CSP `frame-ancestors`，不发 `X-Frame-Options`（P1）

**需求**：工作台的“应用预览”用 iframe 嵌入 CloudAlbum，需要 CloudAlbum 的 HTML 响应允许平台来源嵌入（01 §9.7、03 §6.3）。

**规格**

- 平台模式下，**所有 HTML 响应**带 `Content-Security-Policy: frame-ancestors 'self' <ATL_PLATFORM_ORIGIN>`；任何模式下都**不发送** `X-Frame-Options`（现有设计本来就不发送；CI 断言两种模式都没有）。
- Nginx 侧（ec2 所有）：
  - `00-entry.conf` 新增 `map "" $ca_frame_csp { default ""; include /etc/nginx/cloudalbum.d/slot-atl-frame-ancestors.inc; }`；
  - 槽位文件 `slot-atl-frame-ancestors.inc` 由 `platform:apply-env` 渲染（PM-02）：平台模式开启时内容为 `"" "frame-ancestors 'self' https://d1234abcd.cloudfront.net";`，关闭时为空文件；
  - `cloudalbum_locations.conf` 中返回 HTML 的位置——`location = /index.html`、SPA 回退（内部跳转到 `/index.html`，因此只需在 `/index.html` 处设置）、`/_ca_errors/upstream.html`——各加 `add_header Content-Security-Policy $ca_frame_csp always;`（取值为空时不输出该头，实现时用 `nginx -t` 与集成测试确认）。注意 `add_header` 不继承到已有 `add_header` 的 location，所以必须逐个 location 写。
- 应用侧：中间件对 `Content-Type` 为 `text/html` 的响应（例如 OAuth 回调页）设置同一个头。
- cdn 的响应头策略不得添加 `X-Frame-Options`，也不覆盖源站的 CSP（PM-25）。

**代码位置**：`infra/nginx/00-entry.conf`、`infra/nginx/cloudalbum_locations.conf`、`infra/host/platform/apply-env.sh`（渲染槽位）、`backend/src/http/middleware/frame-ancestors.ts`（新增）。

**测试**：平台模式开关前后的响应头对比；冒烟测试 S30（PM-08）；03 的预览可嵌入判定（`FRAME_ANCESTORS_MISSING` 不出现）。

**优先级**：P1（缺少时预览退化为新标签页，平台仍能运行）。

---

## 7. HTTPS、预览嵌入与登录

### PM-21 平台默认 HTTPS 方案 B 及与 ASG-014 的冲突处理（P1）

**需求**：iframe 预览要求受信 HTTPS。平台默认用 tls 本地档为实验机 EIP 申请 Let's Encrypt IP 短期证书（方案 B，03 §6.2、01 §9.7）。方案 B 写入 `TLS_MODE=letsencrypt`，与 `DEPLOY_MODE=asg` 冲突（规则 ASG-014，不可覆盖），也与 svc-tls “从自签名讲起”的叙事冲突，所以 autoscaling、tls 类卡片必须关闭（C5）。cards 第 1 批 B-5 还要求明确方案 B 下 `APP_BASE_URL` 与 `https.trusted` 的取值。

**规格**

1. **开关来源**：卡片 `lab.yaml` v2 的 `startProfile.platform.preview.directHttps`（`on`/`off`）。`plan --start-of`（PM-33）按下列规则计算期望值，04 的 lint 要求卡片声明与之一致：
   - 起始状态或目标含 autoscaling → `off`（ASG-014）；
   - 目标含 tls → `off`（叙事）；
   - 起始状态中 `PublicHttpIngress≠open`，或起始状态、目标把 network 切到 `private` → `off`（HTTP-01 验证需要公网可达 80 端口，续期会失败）；
   - 其余 → `on`。
   档位文件中写为 `PROFILE_PLATFORM=preview.directHttps=on|off`。
2. **执行**：`scripts/module profile apply --platform` 在全部模块应用完成后，若档位为 `on` 且实例有 EIP、`DEPLOY_MODE=single`，执行 `scripts/module tls-preview on --platform`：
   - 经 SSM 在实验机上运行 `scripts/tls/letsencrypt.sh --ip <EIP> --profile shortlived --preview`（webroot 方式，HTTP-01；certbot 目录沿用 01#tls 的数据卷位置）；
   - 成功：写 `modules.d/tls.env`（本地档，不写 `MODULE_TLS`）：`TLS_MODE=letsencrypt`、`TLS_LE_PROFILE=shortlived`、`TLS_DOMAIN=`（空）、`TLS_PUBLIC_IP=<EIP>`、`TLS_PREVIEW=letsencrypt-ip`、`TLS_FORCE_HTTPS=false`；切换证书符号链接、`nginx -t && reload`；启用 `cloudalbum-tls-renew.timer`；重启应用；
   - 失败（限额、80 端口不可达等）：保持自签名，**不报错**（退出 0），输出 `{"preview":"failed","reason":"…"}`，`state.json` 记 `platform.preview={status:"failed",reason}`；预览退化为新标签页。
   - `tls.env` 的 `ownsEnv` 增加 `TLS_PUBLIC_IP`、`TLS_PREVIEW`（tls 的前缀 `TLS_` 已覆盖）。
3. **续期**：`cloudalbum-tls-renew.timer` 每 12 小时运行一次，剩余有效期不足一半时续期（certbot 的配置项以官方文档为准）。IP 证书有效期约 160 小时（Let's Encrypt 公告），保留环境与复用环境可能超过一次会话，所以续期必须自动。续期失败时 tls 感知器为 `degraded` 并写明原因；证书过期后 `https.trusted=false`，预览不再可嵌入（03 处理）。
4. **有效入口与 `APP_BASE_URL`**：`cloudalbum.env` 中的 `APP_BASE_URL` 保持 `http://<EIP>` 不变（基础配置只由引导脚本写入）。`config/base-url.ts` 计算“基础值”时：`TLS_MODE ∈ {letsencrypt, acm}`、`TLS_DOMAIN` 为空且 `TLS_PUBLIC_IP` 等于 `APP_BASE_URL` 的主机时，协议改为 `https`。于是 `app.entry.baseUrl=https://<EIP>`、`https.trusted=true`（`via=letsencrypt@nginx`），DEP-030 不再触发；auth 等模块的 `AppOrigins` 注入同时包含 `https://<EIP>`。
5. **Cognito 回调地址**：Cognito 是否接受以 IP 为主机名的 HTTPS 回调地址需实测（07）。在确认之前，平台模式下 auth 栈的回调地址列表**排除** IP 主机名的来源；capabilities 的 `https` 增加 `hostKind: "ip" | "dns"`，DEP-029 在平台模式下要求 `trusted=true` 且 `hostKind=dns`（托管登录仍需 cdn 的默认域名或自定义域名）。07 确认可用后，把这两处放开即可。
6. **与 ASG-014 的冲突处理**：
   - 卡片层面由第 1 条的规则与 04 的 lint 保证 autoscaling、tls 卡片关闭方案 B；
   - 运行时兜底：平台模式下 `scripts/module enable autoscaling` 发现 `tls.env` 中 `TLS_PREVIEW=letsencrypt-ip` 时，先自动执行 `tls-preview off`（打印说明），再继续；`enable tls`（ACM 路径）同样先关闭方案 B，由 tls 模块接管 `tls.env`；
   - ASG-014 在平台模式下的修复提示改为：“当前 `TLS_MODE=letsencrypt` 来自平台预览方案 B：执行 `scripts/module tls-preview off`；卡片应在 `lab.yaml` 中关闭 `preview.directHttps`”。
7. `tls-preview off`：只在 `tls.env` 带 `TLS_PREVIEW=letsencrypt-ip` 时执行（否则退出 2，避免误删学员自己配置的 letsencrypt 档）：删除 `tls.env`、切回自签名证书、停用续期定时器、删除本地证书目录中的该证书、重启应用。不涉及任何 AWS 资源。
8. **副作用**（如实告知，03 §6.2）：L0 的路径段 `tls` 从 `selfsigned@nginx` 变为 `letsencrypt@nginx`；svc-auth 的“需要受信 HTTPS”叙事在 L0 已满足（但托管登录见第 5 条）；证书进入证书透明度日志。

**代码位置**：`scripts/module-cli/src/tls-preview.ts`（新增）、`scripts/tls/letsencrypt.sh`（`--ip`、`--preview`）、`backend/src/config/base-url.ts`、`backend/src/modules/detectors/tls.ts`（`hostKind`）、`backend/src/rules/rules.ts`（DEP-029 平台解释、ASG-014 提示）、`infra/modules/auth.yaml`（回调地址过滤）。

**测试**：`plan --start-of` 对 svc-autoscaling、svc-tls、sc-private-network 输出 `off`，对 svc-cdn 输出 `on`；签发失败时 `profile apply` 仍成功；`enable autoscaling` 自动关闭方案 B；07 实测 IP 证书签发、续期与 Cognito 回调。

**优先级**：P1。

### PM-22 登录 Cookie、CSRF 与 iframe 内的托管登录（P1）

**需求**：CloudAlbum 采用 BFF + HttpOnly Cookie（02#auth）。跨站 iframe 中 `SameSite=Lax` 的 Cookie 不随请求发送，登录后会立即“掉线”；改为 `SameSite=None` 后不能再依赖 Lax 的 CSRF 缓解（03 §6.3、01 §9.7）。

**规格**

- 新增启动配置 `AUTH_COOKIE_SAMESITE=auto|lax|none-partitioned`，默认 `auto`：
  - `auto`：平台模式开启且请求为 HTTPS（`req.secure`，由 `$ca_proto` 决定）→ `none-partitioned`；否则 `lax`（独立模式下与现状一致）；
  - `none-partitioned`：`ca_at`、`ca_rt`、`ca_it` 与 CSRF 双提交 Cookie 设为 `Secure; SameSite=None; Partitioned; Path=/`（登录 Cookie 保持 `HttpOnly`）；
  - PKCE `state` Cookie 一律保持 `SameSite=Lax; Secure`（托管登录必须是顶层导航）。
  - 登出时同时下发两种属性组合的删除 Cookie（分区与不分区），避免残留。
- **CSRF**：平台模式下，所有使用 Cookie 认证的状态改变请求（`POST`/`PUT`/`PATCH`/`DELETE`）除双提交令牌外还必须通过 `Origin` 校验：`Origin` 必须属于应用自身的来源集合（`APP_BASE_URL`、有效入口、`https://<EIP>`（方案 B）、cdn、ALB、自定义域名，即 auth 的 `AppOrigins` 并集）；没有 `Origin` 时取 `Referer` 的来源；两者都没有 → 403 `CSRF_ORIGIN_REQUIRED`。`ATL_PLATFORM_ORIGIN` **不在**允许集合中（平台页面本身不向应用发起状态改变请求；iframe 内的请求来源是应用自身）。不需要 CSRF 的请求：请求头令牌认证（`CA-Upload`、`CA-Lab`、探测令牌）、HMAC 内部端点。
- **iframe 内的行为**（前端，`window.top !== window.self`）：
  - 本地账号登录表单照常可用（Cookie 在 iframe 的分区中保持）；
  - 托管登录（`COGNITO_LOGIN_MODE=managed`）的“登录”按钮改为在新标签页打开，并提示“托管登录后的登录状态只在新标签页中有效，预览框内仍是未登录状态”；
  - 登录请求成功后随即 `GET /api/me` 仍为 401 → 判定浏览器不支持或关闭了分区 Cookie，提示“请在新标签页中打开应用”。
- “弹窗回传授权码”方案（03 §6.3）列为 P2，先做 PoC。

**代码位置**：`backend/src/config/schema.ts`（`AUTH_COOKIE_SAMESITE`）、`backend/src/adapters/auth/local.ts`、`backend/src/adapters/auth/cognito.ts`（Cookie 属性）、`backend/src/http/middleware/csrf.ts`（`Origin` 校验）、`frontend/src/auth/`（`isEmbedded()` 与提示）。

**测试**：三种取值下 `Set-Cookie` 的快照；`Origin` 校验的正反用例；Chrome、Firefox 的 iframe 登录 E2E；Safari 按当时的 CHIPS 状态记录结果（07）。

**优先级**：P1。

### PM-23 跨源观测头与预览桥（P2）

**规格**

- 平台模式下 `Timing-Allow-Origin` 与 social-api 的 `Access-Control-Expose-Headers` 的允许来源加入 `ATL_PLATFORM_ORIGIN`（总纲 7.1）。v1 不启用浏览器观察位置（01 D-19），所以只作为预备。
- 预览桥：嵌入时应用前端在路由变化与 API 响应后执行 `parent.postMessage({ type: "atl:path", path, xCloudAlbumPath, serverTiming }, ATL_PLATFORM_ORIGIN)`；目标来源必须是精确值（不得用 `*`）；只发送这四个字段。

**代码位置**：`backend/src/observability/server-timing.ts`、`frontend/src/trace/previewBridge.ts`（新增）。

**测试**：目标来源为精确值；平台模式关闭时不发送。

**优先级**：P2。

---

## 8. cdn 模块

### PM-24 源请求策略转发实验头（P0，两种模式都生效）

**需求**：源站只能从请求头 `X-Experiment-Run` 认出实验流量，而 CloudFront 只转发源请求策略中列出的请求头。不转发时，对比实验经 CloudFront 的请求无法按运行归属，服务端佐证退化为“按时间窗归属”（04 §7.4、E-4）。

**规格**

- cdn 栈新增客户托管的源请求策略 `cloudalbum-<env>-cdn-experiment`：`HeadersConfig` 为白名单 `X-Experiment-Run`、`X-Experiment-Label`、`X-ATL-Probe-Nonce`；查询串与 Cookie 的设置复制该行为原先使用的源请求策略（保持既有行为，例如 `/api/public/*` 的查询串转发）。
- 以 EC2（8080）或 ALB 为源的**可缓存行为**（`/media/*`、`/assets/*`、`/api/public/*` 等）改用这个策略（每个原先设置不同的行为各一份，命名 `cloudalbum-<env>-cdn-exp-<行为名>`）。源请求策略中的头不进入缓存键，不影响命中率；缓存策略不变。
- `/api/*` 行为保持转发全部查看器请求头的源请求策略（已包含实验头与 `X-ATL-Probe-Token`），不改。
- 以 S3 为源的行为（`CDN_MEDIA_ORIGIN=s3`）不转发这些头：S3 无法记录运行 ID，佐证改用 CloudFront 指标（04 §7.4 第 5 步 ②）。
- `X-Compare-Bypass` 仍然只在 `/api/*` 行为中转发（总纲 8.3 防滥用第 5 条不变）。

**代码位置**：`infra/modules/cdn.yaml`、`docs/modules/01-edge-network-scaling.md#cdn`（第 12 节）。

**测试**：模板单元测试（每个 EC2/ALB 源的可缓存行为都引用实验策略、缓存策略未变）；07 实测：经 CloudFront 未命中的请求在源站日志中 `run` 字段等于运行 ID，命中率与改动前一致。

**优先级**：P0。

### PM-25 cdn 的其他平台模式要求（P1）

| 要求 | 规格 |
|---|---|
| 响应头策略 | `cloudalbum-<env>-lab` 不设置 `FrameOptions`；不设置 `ContentSecurityPolicy`（源站的 CSP 原样透传，PM-20） |
| `X-Origin-Verify` 打码 | `GetDistribution`/`GetDistributionConfig` 的响应含 `CustomHeaders.Items[*].HeaderValue` 原文：`scripts/module status cdn`、`/lab` 管理员视图、capabilities 的 `data` 一律打码为 `‹redacted›`（平台证据的打码由 04 §5.5 负责） |
| `/api/public/*` 微缓存 | 平台模式下默认开启（参数 `PublicMicroCache=on`），svc-cdn 的边缘命中佐证依赖它（04 E-1） |
| 管理 IP | `CDN_DIRECT_ACCESS=admin-ip` 时的 `AdminCidr` 接受平台占位符 `${atl:workstationPublicCidr}`（由运行器在 `profile-apply` 前替换） |
| 测量说明 | 卡片的对比实验从工作台（与实验机同区域）运行，首字节时间差异可能很小，`media-load` 与源站卸载是主要观察点（04 E-3） |

**代码位置**：`infra/modules/cdn.yaml`、`scripts/module-cli/src/status.ts`（打码）、`backend/src/modules/detectors/cdn.ts`。

**测试**：响应头策略模板测试；`status cdn` 输出不含密钥原文。

**优先级**：P1。

---
## 9. scripts/module 的平台模式

`scripts/module` 在平台模式下有两个调用方：运行器（`ATLProvisionerRole`，会话名 `atl-<sid>-prov-<op>`）与工作台上的学员（`ATLLearnerRole`，会话名 `atl-<sid>-ws`）。两者共享状态桶中的 `state.json`，用锁表互斥（01 §3.11、02 §9.5）。本节规定 `scripts/module` 自己的行为；运行器怎样调用它见 02 §4.3、§6.5。

### PM-26 开启方式、环境变量与身份校验（P0）

**规格**

- **开启**：环境变量 `CLOUDALBUM_PLATFORM_MODE=1` 或命令行选项 `--platform`（两者等价，任一出现即为平台模式）。工作台的 `/etc/atl/session.env`（03 §4.6）与运行器的 buildspec（02 §4.3）都会设置。
- **环境变量**（变量名以本表为准；值由 03 的接线脚本与 02 的运行器从同一份 agent context / `Environment` 记录写入，两处不得各自拼接；每个变量对应的 context 字段见 01 §8.2 的 `atl.agent-context/v1` 字段表）：

| 变量 | 必填 | 示例 | 含义 |
|---|---|---|---|
| `CLOUDALBUM_PLATFORM_MODE` | 是 | `1` | 平台模式 |
| `CLOUDALBUM_ENV` | 是 | `e7k2m9qx` | `Env` 参数（`^e[a-z0-9]{7}$`） |
| `CLOUDALBUM_STATE_URI` | 是 | `s3://cloudalbum-lab-state-111122223333-ap-northeast-1/e7k2m9qx/state.json` | 状态文件（PM-27） |
| `CLOUDALBUM_LOCK_TABLE` | 是 | `cloudalbum-lab-locks` | 锁表（PM-28） |
| `CLOUDALBUM_PLATFORM_TAGS` | 是 | `atl:component=env,atl:session-id=s4k7m2q9x1abc,atl:lab-id=svc-cdn,atl:env-id=01jc…,Project=CloudAlbum` | 平台标签（PM-29）；`键=值` 以逗号分隔，键与值都匹配 `^[A-Za-z0-9:._-]{1,128}$` |
| `CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN` | 是 | `arn:aws:iam::111122223333:policy/ATLWorkloadBoundary` | 新建 IAM 角色与用户的权限边界（PM-29） |
| `CLOUDALBUM_ADMIN_PASSWORD_PARAM` | 是 | `/cloudalbum/e7k2m9qx/atl/app-admin-password` | 管理员初始密码的参数名（PM-36、PM-42） |
| `CLOUDALBUM_TEST_USERS_PARAM` | 否 | `/cloudalbum/e7k2m9qx/atl/test-users` | 测试用户密码的参数名（PM-44） |
| `CLOUDALBUM_OPS_REPORT` | 否 | `agent`（工作台）、`internal`（运行器）、`off` | 模块操作上报的路由类别（PM-35），缺省 `off` |
| `CLOUDALBUM_ASG_MAX_SIZE_LIMIT` | 否 | `4` | 平台安装参数 `AsgMaxSizeLimit`；autoscaling 的 `MaxSize` 不得超过它（PM-M07） |
| `CLOUDALBUM_DR_REGION` | 否 | `ap-northeast-3` | 平台安装参数 `DrRegion`；backup 的复制目标区域必须等于它（PM-M19），为空时拒绝启用跨区域复制 |
| `ATL_AGENT_API` | 上报时必填 | `https://<apiId>.execute-api.ap-northeast-1.amazonaws.com` | 平台 API 地址（不经 CloudFront，SigV4 直连） |
| `ATL_SESSION_ID`、`ATL_ENV_ID`、`ATL_LAB_ID`、`ATL_VARIANT` | 是（`ATL_VARIANT` 可缺省为 `default`） | — | 会话事实 |
| `ATL_RUN_ID` | 运行器必填 | `s4k7m2q9x1abc-apply-1-0` | 运行器的运行 ID；工作台上不设置 |
| `AWS_REGION` | 是 | `ap-northeast-1` | 区域 |

  缺少必填变量 → 退出 2，错误码 `PLATFORM_ENV_INCOMPLETE`，列出缺少的变量。
- **身份校验**：每次执行先调用 `sts:GetCallerIdentity`，调用者 ARN 必须匹配

  ```text
  ^arn:aws:sts::[0-9]{12}:assumed-role/(ATLLearnerRole/atl-(?<sid>s[0-9a-hjkmnp-tv-z]{12})-(ws|console)
                                       |ATLProvisionerRole/atl-(?<sid>s[0-9a-hjkmnp-tv-z]{12})-prov-[a-z0-9-]+)$
  ```

  且 `sid == ATL_SESSION_ID`；否则退出 2，错误码 `PLATFORM_IDENTITY_MISMATCH`。理由：回收器按会话名归属资源（P5），用其他身份创建的资源无法自动回收。`-console` 用于 CloudShell 省钱模式（03 §4.9）。开发调试可以用 `--allow-any-identity` 跳过（CI 与平台都不得使用；该选项在 `state.json` 的历史中留痕）。
- 平台模式下不读取 `~/.aws` 中的命名配置文件以外的特殊凭证来源；凭证一律走默认凭证链（工作台为角色链，运行器为 CLI 配置文件，01 §3.4、03 §4.6）。

**代码位置**：`scripts/module-cli/src/platform/mode.ts`、`platform/env.ts`、`platform/identity.ts`（新增）。

**测试**：缺变量、身份不符、`sid` 不一致三个拒绝用例；独立模式下不调用 STS 以外的新逻辑。

**优先级**：P0。

### PM-27 状态后端：状态桶与 S3 条件写（P0）

**需求**：`state.json` 必须放在学员与运行器都能访问、名称不以 `atl-` 开头的状态桶中（C4(c)，01 §3.11）；两处执行之间用乐观并发防止互相覆盖。

**规格**

- **位置**：`CLOUDALBUM_STATE_URI`（`s3://cloudalbum-lab-state-<acct>-<region>/<envName>/state.json`）。独立模式仍是本地 `.cloudalbum/state.json`，不变。
- **读**：`GetObject`，记下 `ETag`；对象不存在时只有 `bootstrap` 与 `base deploy` 可以创建，其余命令退出 2（`STATE_MISSING`）。
- **写**：更新用 `PutObject` + `If-Match: <ETag>`，创建用 `If-None-Match: *`（S3 条件写的支持范围以官方文档为准，07 实测）；返回 412 → 退出 8（`STATE_CONFLICT`），打印“有其他操作绕过了环境操作锁，请执行 `scripts/module status --repair`”。对象元数据写 `x-amz-meta-writer=<角色会话名>`、`x-amz-meta-op=<命令>`。
- **写入时机**：每个改变环境的阶段结束后立即写一次（部署栈后、附加策略后、投递配置后、收尾），不是只在命令结束时写，保证中途崩溃时记录不丢；始终在持有环境操作锁时写。
- **本地缓存**：`~/.cloudalbum/cache/<envName>/state.json`，只供 `status` 离线显示，任何写操作都以状态桶为准。
- **备份**：修改账号级单例之前（例如 shell-access 修改 `SSM-SessionManagerRunShell`），先把原值写入 `<envName>/backups/<对象类型>-<对象名>-<UTC 时间>.json`（例如 `ssm-document-SSM-SessionManagerRunShell-20261013T051230Z.json`，内容 `{"existed":true,"defaultVersion":"3","content":{…}}` 或 `{"existed":false}`），并登记到 `state.backups[]`，回收器复位时据此还原（02 §6.5 第 6 条）。
- **`state.json` v2**（平台模式与独立模式共用同一 schema，平台模式多出 `platform` 段）：

```json
{
  "schemaVersion": 2,
  "mode": "platform",
  "env": "e7k2m9qx", "region": "ap-northeast-1", "accountId": "111122223333",
  "platform": {
    "envId": "01jc9x3k9cq4m2x8n5b6c0d1e2",
    "platformTags": { "Project": "CloudAlbum", "atl:component": "env", "atl:env-id": "01jc9x3k9cq4m2x8n5b6c0d1e2" },
    "sessionChain": ["s4k7m2q9x1abc"],
    "preview": { "directHttps": "on", "status": "issued" },
    "lastApply": { "profile": "atl/svc-cdn/default", "digest": "sha256:…", "mode": "fresh", "at": "…", "by": "atl-s4k7m2q9x1abc-prov-profile-apply" },
    "pendingHooks": [],
    "seeds": { "cognito-test-users": { "instance": "done", "cognito": "pending" } }
  },
  "baseStack": "cloudalbum-e7k2m9qx-ec2", "toolchainStack": "cloudalbum-e7k2m9qx-toolchain",
  "delivery": "ssm",
  "modules": { "iam": { "enabled": true, "driver": "role", "stack": "cloudalbum-e7k2m9qx-iam", "version": 4 } },
  "policyAttachments": [ { "policyArn": "arn:aws:iam::…:policy/cloudalbum-e7k2m9qx-iam", "principal": "role/CloudAlbumAppRole" } ],
  "packedPolicies": [],
  "outOfBand": [ { "type": "ssm-document-default-version", "id": "SSM-SessionManagerRunShell", "region": "ap-northeast-1",
                   "createdBy": "atl-s4k7m2q9x1abc-ws", "createdAt": "…", "backupKey": "e7k2m9qx/backups/…" } ],
  "imports": [],
  "backups": [],
  "suspended": null,
  "history": [ { "opId": "01J…", "command": "enable cdn", "actor": "atl-s4k7m2q9x1abc-ws", "runId": null, "at": "…", "exitCode": 0 } ]
}
```

  - `platformTags` 只保存环境级标签（`Project`、`atl:component`、`atl:env-id`），会话级标签每次取当前会话的值（PM-29）。
  - `outOfBand[].createdBy` 是创建者的角色会话名；回收器与 disable 按“谁创建谁清理”处理。
  - `imports[]` 记录经 CloudFormation 资源导入纳入栈的资源（04 §5.2.4 第 1 条：导入的资源不算栈创建）。
  - 独立模式读到 v1 文件时自动升级为 v2（`mode: "standalone"`，没有 `platform` 段）。

**代码位置**：`scripts/module-cli/src/state.ts` 拆为 `state/index.ts`、`state/local.ts`、`state/s3.ts`（新增）、`state/schema.ts`（新增）。

**测试**：模拟 S3 的 412 路径；创建时 `If-None-Match`；v1 → v2 升级；中途失败后状态文件包含已完成的阶段；07 实测条件写。

**优先级**：P0。

### PM-28 环境操作锁：锁表与租约（P0）

**需求**：同一环境同一时刻只能有一个 `scripts/module` 在改它（02 §9.5）。01 §3.11 定义了锁表与项的属性，“租约时长与续租间隔由 06 定义”。

**规格**

- **表与键**：`CLOUDALBUM_LOCK_TABLE`（`cloudalbum-lab-locks`），主键 `lockKey = "env#<envName>"`（以 01 为准）。
- **项属性**：`holderArn`（调用者的角色会话 ARN，例如 `arn:aws:sts::<acct>:assumed-role/ATLLearnerRole/atl-<sid>-ws`）、`holder`（角色会话名）、`op`（命令，例如 `enable cdn`）、`runId`（运行器为 `ATL_RUN_ID`，工作台为 `ws-<ULID>`）、`acquiredAt`、`leaseUntil`（Unix 秒）、`ver`（整数）、`ttl`（= `leaseUntil + 86400`，只用于清理）。
- **租约**：时长 **300 秒**；持有期间每 **60 秒**续租一次（`UpdateItem SET leaseUntil=:new, ver=ver+1`，条件 `holderArn = :me AND ver = :v`）。连续 2 次续租失败 → 设置中止标志，命令在下一个安全点（阶段之间）停止，退出 7（`ENV_LOCK_LOST`），且**不再写** `state.json`。
- **获取**：`PutItem`，条件 `attribute_not_exists(lockKey) OR leaseUntil < :now`。失败时读取当前项；`--lock-wait <秒>` 大于 0 时每 10 秒重试直到超时，否则立即退出 7（`ENV_LOCK_BUSY`），stdout 输出 `{"error":{"code":"ENV_LOCK_BUSY","holder":"atl-s4k7m2q9x1abc-prov-module-op","op":"module-op revokeOlderSessions","runId":"…","acquiredAt":"…","leaseUntil":"…"}}`。
- **缺省等待**：工作台上 `--lock-wait 0`（打印持锁者后退出，不排队，03 §4.12）；运行器传 `--lock-wait 900`（超时后由 02 归类为 `ENV_LOCK_TIMEOUT`，PM-35）。
- **释放**：`DeleteItem`，条件 `holderArn = :me AND ver = :v`；失败忽略（由租约过期兜底）。
- **接管**：只能在租约过期后接管，没有强制解锁命令。`destroy` 进入时学员访问已收回，若锁仍被已吊销的学员会话持有，运行器等租约过期后接管（02 §6.5 第 7 条）。
- **哪些命令持锁**：所有改变环境的命令（`enable`、`disable`、`profile apply`、`base deploy|set`、`rebuild-instance`、`env destroy|suspend|resume`、`seed`、`tls-preview`、`iam …`、`hooks run`、`status --repair`）；只读命令（`status`、`plan`、`profile diff`、`wait-stable`）不持锁。同一进程内嵌套调用（`profile apply` 内部启用多个模块）只持一次。
- **时钟**：`:now` 取调用方本地时间；判定过期时额外容忍 30 秒时钟偏差（`leaseUntil < now - 30`）。
- 独立模式仍用本地锁文件，不变。

**代码位置**：`scripts/module-cli/src/lock/index.ts`、`lock/dynamodb.ts`（新增）、`lock/file.ts`（现有逻辑迁入）。

**测试**：两个进程并发获取（一成一败）；持锁进程被杀后 300 秒内他人拿不到、之后可接管；续租失败触发中止；`--lock-wait` 的轮询。

**优先级**：P0。

### PM-29 栈标签、权限边界与命名（P0）

**需求**：归属与回收依赖会话标签（P5，01 §3.9）；学员边界要求新建的角色带工作负载边界（01 §6.5）；学员边界的 `ProtectComponentTag` 只保护 `atl:component` 的取值 `platform` 与 `workstation`，允许 `env`（C4(d)）。

**规格**

- **栈级标签**（`aws cloudformation deploy --tags`）：独立模式的 `Project=CloudAlbum`、`Env`、`Module`、`ModuleVersion`、`ManagedBy=scripts/module` 不变；平台模式另加 `atl:component=env`、`atl:session-id`、`atl:lab-id`、`atl:env-id`。
  - 取值：环境级标签来自 `state.platform.platformTags`，会话级标签（`atl:session-id`、`atl:lab-id`）来自 `CLOUDALBUM_PLATFORM_TAGS`。
  - **更新已有栈时保留创建时的会话级标签**：`deploy --tags` 会替换栈标签并传播到资源，所以更新栈时先读取该栈现有的 `atl:session-id`、`atl:lab-id` 并原样传回；只有新建的栈使用当前会话的值（02 §8.4 第 4 条：资源的 `atl:session-id` 保持创建时的值）。
- **带外资源**：`scripts/module` 自己创建的资源（快照、AMI 参数、打包策略、ACME 相关资源、EBS 卷副本等）在创建时打同一组标签，之后不再改写。
- **`atl:role`**：只由基础栈（PM-05）与 autoscaling 的启动模板（PM-M07）设置；`scripts/module` 不直接给任何资源打 `atl:role`；临时实例（shared-fs 的第二台实例、Image Builder 构建实例）不得带 `atl:role`（04 §5.2.1）。
- **权限边界**：所有包含 `AWS::IAM::Role` 或 `AWS::IAM::User` 的模块模板都声明参数 `PermissionsBoundaryArn`（`Type: String`，`Default: ''`），并写：

  ```yaml
  Conditions:
    HasBoundary: !Not [!Equals [!Ref PermissionsBoundaryArn, '']]
  # 每个 AWS::IAM::Role / AWS::IAM::User：
  PermissionsBoundary: !If [HasBoundary, !Ref PermissionsBoundaryArn, !Ref 'AWS::NoValue']
  ```

  `scripts/module` 在平台模式下传入 `CLOUDALBUM_PERMISSIONS_BOUNDARY_ARN`，独立模式传空。CI（`scripts/ci/check-templates.ts`，新增）断言：每个角色与用户资源都使用该条件；显式的 `RoleName` 以 `cloudalbum-` 或 `CloudAlbum` 开头（学员护栏 `LabIamResourcesOnly` 只允许这两种前缀）；没有显式名称的角色由 CloudFormation 以栈名（`cloudalbum-<env>-…`）生成名称，同样满足。
- **`Env` 与名称长度**：平台模式下 `Env=<envName>`（8 个字符）。CI 用最长的区域名与 8 字符的 `Env` 渲染全部模板中的全局唯一名称（S3 桶名、Cognito 域前缀、ElastiCache 复制组 ID 等），断言都在各服务的长度上限之内（上限以官方文档为准）。
- **参数路径**：CloudAlbum 模块自己的 SSM 参数不得使用 `/cloudalbum/<env>/atl/` 子路径（工作负载边界拒绝 `parameter/cloudalbum/*/atl/*`，01 §6.6）；CI 用正则检查模板与代码。
- **保留资源**：`DeletionPolicy: Retain` 的数据资源经栈标签传播同样带会话标签，由平台回收器删除（02 §7）；平台模式下不使用 `disable --purge`，模块的 `disable` 只做栈级拆除与记账。

**代码位置**：`scripts/module-cli/src/stack.ts`、`scripts/module-cli/src/tags.ts`（新增）、`infra/modules/*.yaml`（全部含 IAM 资源的模板）、`scripts/ci/check-templates.ts`（新增）。

**测试**：更新栈时会话级标签不变的用例；CI 模板检查对一个缺少边界的夹具模板报错；名称长度检查。

**优先级**：P0。

### PM-30 投递通道、发布包地址与带外操作（P0）

**规格**

- **投递通道**：平台模式下一律 `--delivery ssm`，不使用 ssh（即使 `SshIngressCidr` 非空）。
  - 目标发现：`ec2:DescribeInstances`，过滤 `tag:atl:env-id=<envId>`、`tag:atl:role=lab-app`、`instance-state-name=running`，再核对 AWS 保留标签 `aws:cloudformation:stack-name=cloudalbum-<envName>-ec2`（ASG 实例核对 `aws:autoscaling:groupName` 属于本环境的 ASG），不缓存实例 ID（01 §9.8）。
  - 执行：`ssm:SendCommand`，文档 `AWS-RunShellScript`，按实例 ID 投递；`commands` 只调用发布包中的固定脚本或 `cloudalbum` 子命令，参数先按正则校验，以 `export NAME=<值>` 形式写在命令开头；`Comment` 为 `cloudalbum <命令> <runId|opId>`；不配置 S3 或 CloudWatch 输出（那需要给 `CloudAlbumAppRole` 加权限，违背 P7）。
  - 等待：新实例先等 `DescribeInstanceInformation` 中 `PingStatus=Online`（最长 10 分钟），再投递；轮询 `GetCommandInvocation` 到终态；输出超过 Run Command 的截断长度（以官方文档为准）时只依赖最后一行 JSON。
- **发布包地址**：
  - `bootstrap --platform --release-file <cloudalbum-<ver>-<arch>.tgz>` 把发布包上传到工具链桶 `releases/<ver>/<arch>.tgz`（运行器从 `cloudalbum-infra.zip` 中取得发布包）；
  - `base deploy --platform` 把 `AppArchiveUrl` 设为该对象的预签名 HTTPS URL（有效期取 3600 秒与调用者凭证剩余有效期中的较小值）；之后的栈更新一律 `UsePreviousValue`，避免改动 User Data；替换实例（`rebuild-instance`、network 迁移、kms 换卷）时生成新的 URL；
  - ASG 实例与 `NatMode=none` 的私有放置仍按现有设计用 `s3://` 经实例角色下载（总纲 2.7、DEP-009）。
- **带外操作**：只执行 registry `platform.outOfBand` 中登记的带外 API 调用（PM-34）。学员身份执行时，`learnerAllowed: false` 的步骤跳过并提示对应的平台动作（退出 0，输出 `{"skipped":[{"api":"ce:UpdateCostAllocationTagsStatus","platformAction":"cost-activate-tags"}]}`）。
- **网络放置**：切换 network 放置或替换实例后，先确认管理通道恢复（`PingStatus=Online`），再继续后续步骤；10 分钟内不恢复 → 退出 5，提示检查 NAT 或接口终端节点（ATL-NET-001，PM-48）。

**代码位置**：`scripts/module-cli/src/deliver/ssm.ts`、`scripts/module-cli/src/discover.ts`（新增）、`scripts/module-cli/src/bootstrap.ts`、`scripts/module-cli/src/base.ts`、`scripts/module-cli/src/outofband.ts`（新增）。

**测试**：发现逻辑对多余实例（学员自建的同标签实例、停机的 L0 实例）的排除；参数注入用例；带外步骤在学员身份下被跳过。

**优先级**：P0。

### PM-31 iam 与 keys 模式（`AppRoleMode=existing` 为 P0，其余 P1）

**需求**：`CloudAlbumAppRole` 与实例配置文件由平台栈常驻创建（01 D-13），实例从 L0 起就挂着它；C3 规定几乎每张卡片的起始状态都含 `iam(role)`。如果 iam 栈仍按独立模式创建同名角色，`enable iam` 必然失败，所以这一条是 P0。学员边界禁止创建 IAM 用户与访问密钥，keys 模式只能经平台动作执行（01 §9.6、D-9）。

**规格**

- **iam 栈新增参数** `AppRoleMode=create|existing`（默认 `create`）。平台模式传 `existing`：模板不创建 `CloudAlbumAppRole` 与实例配置文件，只创建本模块的只读基础策略（`PolicyArn`），由 `scripts/module` 附加到已有的 `CloudAlbumAppRole`；输出 `InfoInstanceProfileName=CloudAlbumAppRole`、`InfoAppRoleName=CloudAlbumAppRole`。
- **实例配置文件**：平台模式下 iam 的 `baseParams.InstanceProfileName` 恒为 `CloudAlbumAppRole`，与 `IAM_CREDENTIALS` 取值无关；`disable iam` 只分离策略、写回 `IAM_CREDENTIALS=none`，不动实例配置文件（ATL-IAM-001）。
- **不能动的策略**：不得分离 `AmazonSSMManagedInstanceCore`；不得修改或删除 `CloudAlbumAppRole` 上名为 `atl-*` 的策略（例如 `atl-terminal-recording`）；托管策略配额统计与打包模式（总纲 9.1）忽略这些平台策略，打包时不得合并它们。
- **keys 模式**：
  - 学员身份执行 `enable iam --mode keys` 或从 keys 切回 role → 退出 2，错误码 `PLATFORM_ACTION_REQUIRED`，提示使用卡片中的平台动作（registry 操作 `keysModeOn` / `keysModeOff`，svc-iam 中的 `iam-keys-on` / `iam-keys-off`）；
  - 平台动作由运行器（`ATL_OP=module-op`）执行：创建用户 `cloudalbum-<envName>-demo-keys`（路径 `/cloudalbum/`，带 `ATLWorkloadBoundary` 与会话标签）→ 创建访问密钥 → 写入 SecureString `/cloudalbum/<envName>/iam/demo-keys` → 经 SSM 在实验机上执行 `cloudalbum iam:install-keys --from-param <参数名>`（root：以实例角色读取参数，写入 `secrets.env` 的 `IAM_KEYS_*`，重启应用）→ 成功后运行器删除该参数；`iam-keys-off` 反向执行并删除访问密钥与用户；
  - keys 模式生效期间，学员执行 `enable/disable <其他模块>` 时把模块策略附加到演示用户或从中分离，学员身份允许这一步（01 D-16）。
- **平台动作提供的命令**（只能由运行器以 `ATL_OP=module-op` 执行，registry `platform.platformActions` 登记，PM-34）：
  - `scripts/module iam revoke-older-sessions --platform`：在 `CloudAlbumAppRole` 上写入“拒绝早于当前时间签发的会话”的内联策略（与控制台“撤销活动会话”相同的语义，策略名 `AWSRevokeOlderSessions`）。这会同时切断管理通道（SSM Agent 用的是同一个角色的旧凭证），动作声明 `interruptsManagementChannel: true`；
  - `scripts/module iam refresh-instance-credentials --platform`：以同一个实例配置文件执行 `ReplaceIamInstanceProfileAssociation` 迫使实例取得新凭证，不行则重启实例；等待 `PingStatus=Online`。
- **感知器**：iam 感知器不再以“IMDS 中有没有角色”判断模块是否启用（平台模式下 IMDS 里总有 `CloudAlbumAppRole`），改为 `IAM_CREDENTIALS` 取值 + 应用实际使用的凭证来源（`role` 驱动是否成功取得凭证）。capabilities 的 iam `detail` 在平台模式下注明“实例角色属于平台管理通道，应用未使用”（`IAM_CREDENTIALS=none` 时）。
- 由指南生成的只读策略 `CloudAlbumLabVerifier` 在平台模式下不附加到应用角色（平台的 `ATLVerifierRole` 承担只读检查）。

**代码位置**：`infra/modules/iam.yaml`、`scripts/module-cli/src/iam.ts`（新增：`revoke-older-sessions`、`refresh-instance-credentials`、keys 切换）、`scripts/module-cli/src/policy.ts`（忽略 `atl-*`）、`backend/src/modules/detectors/iam.ts`、`backend/src/cli/platform/install-keys.ts`。

**测试**：`AppRoleMode=existing` 的模板测试（无 `AWS::IAM::Role`）；平台模式下 `enable iam` 不触碰实例配置文件；学员身份执行 keys 模式被拒；07 走查中 `enable iam` 在已有角色上成功。

**优先级**：`AppRoleMode=existing`、实例配置文件规则、平台策略保护为 P0；keys 模式与两个平台动作为 P1（svc-iam 使用）。

### PM-32 新增子命令与选项（P0）

| 命令 | 说明 | 持锁 | 只在平台模式 |
|---|---|---|---|
| `plan --start-of <card-id> [--variant <v>] [--lab-file <path>] --json` | 起始状态推导（PM-33） | 否 | 否（CI 无凭证可用） |
| `plan --profile <name> [--then <module[:KEY=VAL,…]>,…] --json` | 校验档位本身合法，并模拟按顺序启用目标的每一步（04 DRV-6）。`<name>` 为 `atl/<card-id>/<variant>` 时读取 `profiles/atl/<card-id>/<variant>.env`（运行器把从内容发布下载的档位放在工作目录的这个相对路径，01 §3.4）。**输出的 `digest` 与 `plan --start-of` 同一算法**（PM-33 第 11 步）：从档位文件的 `PROFILE_CARD`、`PROFILE_VARIANT`、`PROFILE_MODULES`、`PROFILE_DRIVERS`、`PROFILE_LOCAL_SETTINGS`、`PROFILE_RUNTIME`、`PROFILE_PARAMS`、`PROFILE_BASE_PARAMS`、`PROFILE_PLATFORM`、`PROFILE_EXTRA_STACKS` 重建同一个规范化对象，`registryVersion` 取**当前工具包**的 registry 版本——所以工具包与内容包版本不一致时摘要必然不同。运行器在运行期只用这条命令复核（不读 `lab.yaml`），04 DRV-10 在构建期校验两条命令的摘要相同 | 否 | 否 |
| `plan --single <module>`、`plan --targets <module>[:…] …` | 推导的构件，供 CI 交叉核对（tracks-and-catalog §7.6） | 否 | 否 |
| `profile gen-atl [--card <id>] --out profiles/atl/` | 为全部卡片的全部变体生成档位文件（`labs:build` 调用） | 否 | 否 |
| `profile apply <name> --mode fresh\|additive [--repair]` | `fresh`：完整差异（启用缺少的、禁用多余的、更新参数变化的）；`additive`：只启用缺少的与更新参数，从不禁用（复用环境，02 §8.4）；`--repair`：先 `status --repair` 再应用。拒绝含未替换 `${atl:…}` 占位符的档位（退出 2，`PROFILE_PLACEHOLDER`）；档位含 `PROFILE_PLATFORM` 时按 PM-21 处理方案 B；含 `PROFILE_SEEDS` 时**不**执行种子（由运行器在之后单独调用 `seed`） | 是 | 否（`--mode` 在独立模式下也可用） |
| `wait-stable [--timeout <秒，默认 1800>] [--skip-failed]` | 等待全部 `cloudalbum-<env>-*` 栈离开 `*_IN_PROGRESS`；`UPDATE_ROLLBACK_FAILED` 的栈执行 `continue-update-rollback`（`--skip-failed` 时跳过失败资源） | 否 | 否 |
| `env destroy --fast --ledger-out <file>` | 栈级拆除并记账（语义见 02 §6.5）：确定栈集合 → 按 `requires ∪ orderBefore ∪ injects` 的逆拓扑序分层删除 → 删除前分离策略、记录物理 ID → 跳过实例侧步骤 → `DELETE_FAILED` 时以 `--retain-resources` 删栈并记账 → 带外资源只记账。台账格式见下 | 是 | 是 |
| `env suspend` / `env resume` | 保留环境的节省模式（02 §8.2）：停止 / 启动单实例与 RDS（不能停止的记原因跳过）；不处理 ASG、ElastiCache、NAT、CloudFront；`resume` 等待 `running`/`available` 与 `PingStatus=Online` 后执行 `cloudalbum platform-status`；状态写 `state.suspended` | 是 | 是 |
| `status --json` | 机器可读的状态（见下）；`--repair` 以栈 Outputs 为准修复半启用 | `--repair` 时 | 否 |
| `seed <seed-id> [--cognito] [--params-b64 …]` | 测试数据种子（§11） | 是 | 是 |
| `tls-preview on\|off` | 方案 B（PM-21） | 是 | 是 |
| `iam revoke-older-sessions`、`iam refresh-instance-credentials`、`iam keys-on\|keys-off` | 平台动作（PM-31） | 是 | 是（只限运行器） |
| `hooks run --pending` | 执行等学员身份的平台钩子（PM-36） | 是 | 是 |
| `bootstrap --release-file <path>` | 创建工具链栈并上传发布包（PM-30） | 是 | 否（`--release-file` 只在平台模式使用） |
| `base deploy --instance-profile <name> --key-name <name> --disable-rollback --retry-az` | 平台模式的首次部署（PM-05） | 是 | 否 |

- `scripts/teardown` 在平台模式下只是 `env destroy` 的别名（独立模式行为不变）。
- **`env destroy` 的台账**（`--ledger-out`，运行器上传到 `atl-data/runs/<runId>/ledger.json`）：

```json
{
  "schema": "cloudalbum.ledger/v1",
  "env": "e7k2m9qx", "envId": "01jc…", "generatedAt": "…",
  "stacks": [ { "name": "cloudalbum-e7k2m9qx-cdn", "region": "ap-northeast-1", "result": "DELETED",
                "resources": [ { "logicalId": "Distribution", "physicalId": "E2QW…", "type": "AWS::CloudFront::Distribution", "retained": false } ] } ],
  "outOfBand": [ { "type": "ec2-key-pair", "id": "cloudalbum-e7k2m9qx-key", "region": "ap-northeast-1", "createdBy": "atl-s4k7m2q9x1abc-prov-base-deploy" } ],
  "policyAttachments": [ { "policyArn": "…", "principal": "role/CloudAlbumAppRole", "detached": true } ],
  "backups": [ "e7k2m9qx/backups/ssm-document-SSM-SessionManagerRunShell-20261013T051230Z.json" ]
}
```

  `result` ∈ {`DELETED`, `DELETED_WITH_RETAINED`, `DELETE_FAILED`, `NOT_FOUND`}；有任何栈不是 `DELETED`/`DELETED_WITH_RETAINED`/`NOT_FOUND` 时退出 6。
- **`status --json`**：

```json
{
  "schema": "cloudalbum.status/v1", "env": "e7k2m9qx", "mode": "platform", "stateEtag": "\"9f1c…\"",
  "lock": { "held": false },
  "modules": { "cdn": { "enabled": true, "driver": "cloudfront", "stack": { "name": "cloudalbum-e7k2m9qx-cdn", "status": "UPDATE_COMPLETE" },
                        "envFile": true, "capability": { "status": "ok", "driver": "cloudfront" }, "policyAttached": true } },
  "pendingHooks": [], "preview": { "directHttps": "on", "status": "issued" }
}
```

**代码位置**：`scripts/module-cli/src/plan.ts`、`profile.ts`、`env.ts`（新增：destroy、suspend、resume）、`wait-stable.ts`（新增）、`status.ts`、`seed.ts`（新增）、`tls-preview.ts`、`iam.ts`、`hooks.ts`、`bootstrap.ts`、`base.ts`。

**测试**：每个子命令的参数解析与 JSON 输出快照；`profile apply --mode additive` 不禁用多余模块；`env destroy` 在桶非空时 `DELETED_WITH_RETAINED` 并记账；`wait-stable` 的超时。

**优先级**：P0（`iam keys-*` 与 `hooks` 为 P1）。

### PM-33 起始状态推导 `plan --start-of` 与档位文件（P0）

**需求**：C3 规定起始状态 = L0 + iam(role) + 目标模块硬依赖的闭包（`svc-ec2`、`svc-iam` 不预置 iam），由 `scripts/module plan --start-of <card>` 推导，不能直接用包含目标模块本身的 `single/<id>` 档位。04 的 `labs:derive` 用它核对卡片的 `startProfile.provisions`（DRV-1～DRV-11）；运行器在 `profile-apply` 前用同一摘要算法的 `plan --profile` 复核（第 3 轮，02 §3.6）。

**算法**（纯计算，只读 `labs/<card-id>/lab.yaml`、`modules/registry.yaml` 与规则表，不读任何会话状态，CI 无需凭证）：

1. 读取卡片与所选变体（`--variant`，缺省 `default`；变体覆盖 `provisions`、`branches`、`platform`、`targetModules`）。
2. 目标集合 T：非选做的 `targetModules[]`，每项含 `id`、`driver`、`set`、`params`、`fromDriver`。
3. 基础集合 S：`l0-ec2`；卡片不是 `svc-ec2`、`svc-iam` 时加入 `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）。
4. 闭包：对 T 中每个目标，按目标取值求 registry `requires` 中的硬依赖（`a | b` 取 `branches` 指定的分支，否则取第一个可自动满足的分支）；再以“在 S 上启用该目标”为前提运行规则引擎（平台模式、`plan` 范围），对每条带 `remedy` 的 error 级规则加入它指定的模块与取值（PM-34）；迭代到不动点。加入的每个模块记录 `basis: closure` 与 `because`（规则 ID 列表）。
5. 前驱：`fromDriver` 非空的目标以前驱取值加入 S（`basis: precursor`；本地档时为 `kind: local`）。
6. 本地设置：单服务卡加入目标模块 registry 的 `singleLocalSettings`（`kind: local`）与 `singleRuntime`（`kind: runtime`）；场景卡加入 `provisions` 中声明的 `local`、`runtime` 条目（取值必须属于 registry 的 `localTiers` 或运行时热键）。
7. 背景模块（场景卡）：加入 `basis: context` 的模块及其闭包。
8. 校验：任一目标的目标取值已在 S 中生效 → 退出 2（DRV-5）；在 S 上运行规则引擎（启动与部署范围）→ 有 error 则退出 2；warn 记入输出 `warnings`。
9. 平台段：按 PM-21 第 1 条计算 `preview.directHttps`；卡片声明 `workstation.sshFromWorkstation` 时加入基础栈参数 `SshIngressCidr=${atl:workstationPrivateCidr}`（或 `…PublicCidr`，起始状态含 network 时）。
10. 排序：拓扑序，并遵守 registry 的 `orderBefore`。
11. 摘要：对下列对象按 RFC 8785 规范化后取 SHA-256：`{ schema, card, variant, registryVersion, modules: [按 id 排序的 {id, kind, set, params, value}], platform, baseParams, extraStacks: [按声明顺序的 {id, region}] }`（不含 `because`、`order`、`seeds` 等说明性字段，所以说明文字的修改不改变摘要）。`plan --profile` 从档位文件重建同一个对象并用同一函数计算（PM-32）。
12. 卡片自带栈：把 `extraStacks[]` 中 `deploy: start`（且 `when` 不为假）的条目按声明顺序写入输出的 `extraStacks` 与档位的 `PROFILE_EXTRA_STACKS`。

**输出**（`--json`）：

```json
{
  "schema": "cloudalbum.plan/v1",
  "registryVersion": "…", "toolkitVersion": "…",
  "card": "svc-image-processing", "variant": "default", "profileName": "atl/svc-image-processing/default",
  "start": [
    { "id": "ec2", "kind": "module", "basis": "base" },
    { "id": "iam", "kind": "module", "basis": "credential", "set": { "IAM_CREDENTIALS": "role" } },
    { "id": "storage", "kind": "module", "basis": "closure", "set": { "STORAGE_DRIVER": "s3" }, "because": ["DEP-003"] }
  ],
  "targets": [ { "id": "image-processing", "driver": "lambda", "fromDriver": "inline" } ],
  "branches": {},
  "platform": { "preview.directHttps": "on" },
  "baseParams": {},
  "warnings": [],
  "order": ["iam", "storage"],
  "provision": { "class": "A" },
  "extraStacks": [],
  "digest": "sha256:…"
}
```

**档位文件**：`profiles/atl/<card-id>/<variant>.env`（生成物，不提交，随内容发布，04 §2.5）。在总纲 10.1 的格式上增加平台字段：

```bash
PROFILE_NAME=atl/svc-image-processing/default
PROFILE_KIND=atl-start                      # 新增：起始档位
PROFILE_CARD=svc-image-processing
PROFILE_VARIANT=default
PROFILE_EXTENDS=l0-ec2
PROFILE_MODULES=iam,storage
PROFILE_DRIVERS=IAM_CREDENTIALS=role,STORAGE_DRIVER=s3
PROFILE_LOCAL_SETTINGS=                     # 新增：本地档与本地设置（不部署 AWS 资源）
PROFILE_RUNTIME=                            # 新增：运行时热键
PROFILE_PARAMS=
PROFILE_BASE_PARAMS=                        # 新增：例如 SshIngressCidr=${atl:workstationPrivateCidr}
PROFILE_SEEDS=                              # 新增：种子 id 列表（由运行器在 profile apply 之后执行，02 §4.3 第 ⑤ 步）
PROFILE_EXTRA_STACKS=                       # 新增：deploy: start 的卡片自带栈，格式见下（由运行器 ATL_OP=extra-stack 部署）
PROFILE_PLATFORM=preview.directHttps=on     # 新增：方案 B 开关
PROFILE_PLAN_DIGEST=sha256:…                # 新增：= plan 的 digest（04 DRV-10）
PROFILE_REGISTRY_VERSION=…
```

- **档位名**：以 01 为准：`atl/<card-id>/<variant>`（默认变体为 `atl/<card-id>/default`），文件 `profiles/atl/<card-id>/<variant>.env`。04 已在第 3 轮统一为这一写法，内容构建不再产生短名；`atl/<card-id>` 仍作为 `atl/<card-id>/default` 的别名被接受，只为手工调试方便，平台不使用。
- **`PROFILE_EXTRA_STACKS` 的格式**（第 3 轮定义，取代“预留”）：逗号分隔的条目，每项 `<stackId>@<region>`；`stackId` 匹配 `^[a-z][a-z0-9-]{1,23}$`，`region` ∈ {`app`, `us-east-1`, `dr-region`}（与 04 `extraStacks[].region` 相同，`dr-region` 由运行器替换为安装参数 `DrRegion`）；只列 `deploy: start` 的栈，顺序即部署顺序；没有时为空。例：`PROFILE_EXTRA_STACKS=dr-crr-target@dr-region,dr-crr-role@app`。`deploy: step:<id>` 的栈不进档位（它们不属于起始状态，经平台动作 `xstk-<stackId>` 部署）。**`scripts/module` 自己不部署这些栈**（`profile apply` 遇到该字段只校验格式），部署者是运行器的 `ATL_OP=extra-stack`（01 §3.4）；模板的完整性由内容发布的 `manifest.json` 保证，所以摘要只纳入 `{id, region}` 列表。
- **占位符**：`${atl:workstationPrivateCidr}`、`${atl:workstationPublicCidr}`、`${atl:drRegion}`、`${atl:platformOrigin}` 由运行器在 `profile apply` 之前替换到临时副本（02 §3.6）；`scripts/module` 遇到未替换的占位符一律拒绝。
- **运行时复核**（第 3 轮改为 01 选定的方案 (a)）：运行器执行 `plan --profile atl/<card-id>/<variant> --platform --json`，比较 `digest` 与档位中的 `PROFILE_PLAN_DIGEST`；不一致 → 运行器分类为 `PROFILE_DIGEST_MISMATCH`（02 §4.3）。运行器的源码包 `cloudalbum-infra.zip` 与内容发布都不含 `lab.yaml`，所以运行期不用 `plan --start-of`；两条命令的摘要算法相同（PM-32），04 的 DRV-10 在构建期核对。

**代码位置**：`scripts/module-cli/src/plan.ts`（重写）、`scripts/module-cli/src/profile.ts`（`gen-atl`、新字段）、`backend/src/rules/engine.ts`（plan 范围、平台模式求值）、`scripts/module-cli/src/canonical-json.ts`（新增，RFC 8785）。

**测试**：对 cards/ 中 56 张卡片的推导结果做快照（CI 中由 04 的 `labs:derive` 执行）；同一输入两次推导摘要相同；修改 `because` 说明不改变摘要；`svc-ec2`、`svc-iam` 不含 iam；svc-autoscaling 的 `preview.directHttps=off`。

**优先级**：P0。

### PM-34 registry 扩展（P0）

**需求**：01 的 Provisioner 白名单生成、`atl-pricing` 的报价、平台动作的参数白名单，以及 `plan --start-of` 的推导，都需要 registry 提供机器可读的数据（平台评审 writeback #14、tracks-and-catalog X-1、04 M-8）。

**规格**（`modules/registry.schema.json` 新增字段；总纲 3.5 同步）：

| 字段 | 取值 | 使用方 |
|---|---|---|
| `platform.outOfBand` | `[{ api: "<服务前缀>:<操作>", purpose, learnerAllowed: bool, resourcePattern? }]` | 01 §6.7 的 Provisioner 直接调用白名单生成；PM-30 的执行限制 |
| `platform.billing.pricingKeys` | `pricingKey` 列表（与 04 `labs/_pricing/dimensions.yaml` 的键一致） | `atl-pricing` 报价、费用档位计算 |
| `platform.platformActions` | `[{ id, command, args: <JSON Schema>, title, confirm, interruptsManagementChannel: bool }]` | 01 的 `module-op` 白名单；04 `lab.yaml` 的 `platformOps[].op` 只能引用这里的 `id` |
| `singleLocalSettings` | `{ <变量>: <本地档取值> }` | `plan --start-of` 第 6 步（原 `gen-single` 规则 3 的本地档调整，变成数据） |
| `singleRuntime` | `{ <运行时热键>: <值> }` | 同上（例如 `featureFlags.lab.faults: true`） |
| `orderBefore` | 已有字段；新增 `secrets.orderBefore: [database]` | 同一次 apply 中 secrets 先于 database（scenario-cards B-17） |

规则表（`backend/src/rules/rules.ts`）中“启用某模块即可满足”的 error 级规则增加 `remedy`：

```ts
{ id: 'ASG-002', level: 'error', /* … */,
  remedy: { enable: [{ module: 'database', set: { DB_DRIVER: 'postgres' } }] } },
{ id: 'ASG-001', level: 'error', /* … */,
  remedy: { choose: [[{ module: 'storage', set: { STORAGE_DRIVER: 's3' } }], [{ module: 'shared-fs' }]] } },   // a | b，按 branches 选择
```

初始登记的 `platformActions`。两层命名：registry 中是模块级操作 id（01 §3.4 与平台评审统一取值中的 `revokeOlderSessions` 等）；卡片 `lab.yaml` 的 `platformOps[]` 用自己的 `id`（例如 svc-iam 的 `iam-revoke-sessions`），以 `op` 引用这里的操作 id（04 §3.2.15）：

| 模块 | registry 操作 id | 命令 | 中断管理通道 | 卡片中常用的 `platformOps[].id` |
|---|---|---|---|---|
| iam | `revokeOlderSessions` | `iam revoke-older-sessions` | 是 | `iam-revoke-sessions` |
| iam | `refreshInstanceCredentials` | `iam refresh-instance-credentials` | 是（短暂） | `iam-refresh-credentials` |
| iam | `keysModeOn`、`keysModeOff` | `iam keys-on`、`iam keys-off` | 否 | `iam-keys-on`、`iam-keys-off` |
| cost | `activateCostAllocationTags` | `cost activate-allocation-tags --keys Project,atl:lab-id` | 否 | `cost-activate-tags` |

**代码位置**：`modules/registry.yaml`、`modules/registry.schema.json`、`backend/src/rules/rules.ts`、`backend/src/rules/engine.ts`。

**测试**：schema 校验；CI 交叉检查：每个 error 级且可由启用模块满足的规则都有 `remedy`；`platformActions` 的 `command` 在 `scripts/module` 中存在。

**优先级**：P0。

### PM-35 进度、结果、操作上报与退出码（P0）

**规格**

- **`--progress-jsonl <file|->`**：每行一个 JSON：`{ "ts", "runId", "opId", "phase", "module", "step", "status": "started|progress|succeeded|failed", "message", "pct" }`。`phase` 取值：`plan`、`lock`、`deploy-stack`、`injects`、`policy`、`migrate`、`deliver`、`check-config`、`restart`、`health`、`finalize`、`destroy`、`seed`、`preview`。运行器把它转发到 `POST /api/v1/internal/runs/{runId}/events`（02 §4.3）。
- **`--result-json <file>`**（运行器的失败分类依据，02 §4.3）：

```json
{
  "schema": "cloudalbum.module-result/v1",
  "runId": "s4k7m2q9x1abc-apply-1-0", "command": "profile apply atl/svc-database/default --mode fresh",
  "exitCode": 3, "phase": "deploy-stack", "module": "database",
  "cfnFailures": [ { "stack": "cloudalbum-e7k2m9qx-database", "logicalId": "DbInstance", "status": "CREATE_FAILED", "reason": "<StatusReason 原文>" } ],
  "stateEtag": "\"9f1c…\"",
  "lock": { "waitedSec": 0, "holder": null },
  "changed": { "enabled": ["iam"], "disabled": [], "updated": [] },
  "warnings": [], "skipped": []
}
```

  `classification` 由运行器计算，不写在这里。
- **模块操作上报**：每次 `enable`/`disable`/`profile apply`/`seed`/`tls-preview` 的开始与结束，当 `CLOUDALBUM_OPS_REPORT ≠ off` 时尽力调用：
  - 工作台（`agent`）：`POST {ATL_AGENT_API}/api/v1/agent/sessions/{sid}/module-ops`；
  - 运行器（`internal`）：`POST {ATL_AGENT_API}/api/v1/internal/sessions/{sid}/module-ops`；
  - 请求体：`{ "opId": "<ULID>", "phase": "started|succeeded|failed", "command": "enable", "module": "cdn", "driver": "cloudfront", "profile": null, "exitCode": null, "at": "…", "runId": null }`；
  - 用默认凭证链对 `execute-api` 做 SigV4 签名，超时 3 秒、重试 1 次；失败只写 stderr，不影响操作本身（01 §9.6）。
- **退出码**（在总纲 9.2 的 0、2、3、4、5 之外新增）：

| 退出码 | 含义 | 运行器建议分类（02 §4.3） |
|---|---|---|
| 6 | 部分栈未删除（`env destroy`，已记账） | 继续进入回收器 |
| 7 | 环境操作锁被占用（`ENV_LOCK_BUSY`）或续租丢失（`ENV_LOCK_LOST`） | `ENV_LOCK_TIMEOUT`，可重试 1 次 |
| 8 | 状态冲突（`STATE_CONFLICT`，S3 条件写失败） | 可重试 1 次（先 `status --repair`） |

**代码位置**：`scripts/module-cli/src/report/progress.ts`、`report/result.ts`、`report/module-ops.ts`（新增）、`scripts/module-cli/src/index.ts`（退出码）。

**测试**：JSONL 的 schema 校验；上报端点不可达时命令仍成功；各退出码的触发用例。

**优先级**：P0。

### PM-36 平台钩子：等学员身份执行的后续步骤（P1）

**需求**：有些步骤必须以学员身份执行，而触发它的操作可能由运行器完成。典型例子：起始状态含 `auth=cognito` 时，管理员与测试用户在 Cognito 中的密码需要设置为已知值，但 02 规定起始状态的部署不调用 `cognito-idp`，01 的运行器白名单也默认不含 `AdminSetUserPassword`（§16 第 3 条）。

**规格**

- `state.platform.pendingHooks[]`：`{ "id": "cognito-passwords", "reason": "auth=cognito enabled by atl-…-prov-profile-apply", "createdAt": "…", "requires": "learner" }`。
- 产生：平台模式下 `enable auth`（cognito 驱动）成功后——若调用者是学员身份，立即执行钩子；若是运行器，只登记 `pendingHooks`。
- 执行：`scripts/module hooks run --pending --platform`（学员身份）。03 的 `ATL-WorkstationSetup` 在写好学员 CLI 配置后以 `labuser` 身份执行一次；学员在工作台上执行的任何持锁命令结束前也会顺带执行；工作台为 CloudShell 时由卡片的第一步提示学员手动执行。
- 当前只有一个钩子 `cognito-passwords`：读取 `CLOUDALBUM_ADMIN_PASSWORD_PARAM` 与 `CLOUDALBUM_TEST_USERS_PARAM`，对本环境的 User Pool（`cloudalbum-<env>-auth` 栈的 `InfoUserPoolId`）中的管理员与测试用户执行 `AdminGetUser`，不存在则 `AdminCreateUser`（`MessageAction=SUPPRESS`，`email_verified=true`），然后 `AdminSetUserPassword(Permanent=true)`。幂等。
- 钩子失败不影响触发它的操作；`status` 显示仍在等待的钩子。

**代码位置**：`scripts/module-cli/src/hooks.ts`（新增）、`scripts/module-cli/src/enable.ts`（登记）。

**测试**：运行器身份只登记、学员身份执行；重复执行幂等；User Pool 不存在时退出 3。

**优先级**：P1。

---
## 10. 实验框架

本节改动 `experiments/_lib/` 的运行器（总纲 8.2）。平台模式的判定：工作台上存在 `~/.atl/session.json`（03 §4.6 写入，字段按 04 §7.2）且设置了 `ATL_AGENT_API`。

### PM-37 实验变体标签 `--label <任意变体>`（P0）

**需求**：模块文档使用 `l0`、`unsafe`、`selfhost`、配置 a～d、`workers-2` 等标签，04 §3.2.10 把实验标签改为卡片声明的任意变体（带角色 `baseline`、`treatment`、`single`）；原来的 `--label before|after` 记不下这些变体（cards 第 1 批 B-10、第 2 批 C-4）。

**规格**

- `--label` 接受 `^[a-z][a-z0-9-]{0,23}$`（与 04 的变体标签格式相同）。
- `experiment.json` 的 `requires` 的键就是该实验声明的标签（现有结构已支持任意键）；新增可选字段 `labels`，给每个标签补元数据：

```json
{
  "module": "queue", "id": "upload-burst",
  "requires": {
    "l0":     { "queue.driver": "sync",   "image-processing.driver": "inline" },
    "before": { "queue.driver": "memory", "image-processing.driver": "worker" },
    "after":  { "queue.driver": "sqs",    "image-processing.driver": "worker", "queue.status": ["ok", "degraded"] }
  },
  "labels": {
    "l0":     { "title": "同步处理（L0）",   "role": "baseline" },
    "before": { "title": "进程内队列",       "role": "baseline" },
    "after":  { "title": "SQS",              "role": "treatment" }
  },
  "params": { "vus": { "default": 10, "min": 1, "max": 50 }, "duration": { "default": "60s", "max": "10m" } }
}
```

- 校验：标签不在 `requires` 中 → 独立模式退出 2；平台模式下若登记响应（PM-38）给出了该标签的 `requires`（卡片声明），以登记响应为准，否则退出 2。
- **短轮次参数**（P1）：`--param <键>=<值>` 只接受 `experiment.json.params` 中声明的键，并按 `min`/`max` 校验（waf 的 `flood`、autoscaling 的 `scale-out` 在卡片中需要缩短，cards 第 1 批 B-10）。
- **实验自带的阶段参数**（第 3 轮）：个别实验有自己的命令行参数，例如 `monitoring/kill-test` 的 `--phase service|instance`（PM-M30）。这类参数同样写入结果的 `params`，参与 04 §7.4 第 8 步的可比性判断；实验可以规定某个标签只接受某个参数值（`stop-instance` 只接受 `--phase instance`）。
- 结果文件名不变：`_results/<module>/<UTC时间>__<label>__<runId>.json`；结果 JSON（`cloudalbum.result/v1`）新增可选字段 `variant: { label, role?, cardVariant? }`（独立模式只有 `label`）。
- `exp:report` 增加 `--pair <标签A>,<标签B>`（缺省 `before,after`）；多档对比时可以给多个 `--pair`；报告按 `variant.label` 显示，不再假设只有 before/after。
- 本地登记 `POST /api/lab/runs` 的请求体增加 `label`（任意变体）与可选的 `variant`（PM-40）。

**代码位置**：`experiments/_lib/runner.ts`、`experiments/_lib/report.ts`、`experiments/_lib/schema/experiment.schema.json`、`result.schema.json`、`backend/src/http/routes/lab.ts`。

**测试**：非法标签；`--param` 越界；`--pair l0,after` 的报告；旧结果文件（只有 `label`）仍能读取。

**优先级**：P0（`--param` 为 P1）。

### PM-38 平台模式上传：登记 → 执行 → 上传 → 轮询（P0）

**需求**：对比实验结果要进入平台并完成服务端佐证（01 §9.5、04 §7）。

**规格**（协议的服务端以 04 §7 为准，本条只写运行器一侧）

1. **登记**：`--upload` 且处于平台模式时，运行前以默认凭证链（工作台的角色链 `atl-<sid>-ws`）对 `execute-api` 做 SigV4 签名，`POST {agentApiBase}/api/v1/agent/sessions/{sid}/experiment-runs`，请求体 `{ module, experiment, label, scenario, params }`。响应给出 `runId`、`window`、`variant{label, role, cardVariant}`、要附带的请求头（`X-Experiment-Run`、`X-Experiment-Label`）与 `nonce`；422 `LABEL_NOT_IN_LAB` / `EXPERIMENT_NOT_IN_LAB` 时停止并提示。
2. **本地登记**：用同一个 `runId` 调用 CloudAlbum 的 `POST /api/lab/runs { runId, module, experiment, label, variant, windowSec }`（应用接受客户端给出的 ULID，重复则 409）——平台与应用使用同一个 runId，`lab-metrics` 才能对上（PM-14）。
3. **执行**：抓 capabilities 快照 → 预热 → 执行场景（所有请求带两个实验头）→ 读 `GET /api/lab/metrics?run=<runId>` → 写本地结果文件。
4. **上传**：按 `atl.experiment-result/v1`（04 §7.3）组装：在 `cloudalbum.result/v1` 的内容之外填 `schema`、`baseSchema`、`sessionId`、`labId`、`variant`（原样写回登记响应）、`targets`、`runner{name:"cloudalbum-exp", version, host:"workstation", instanceId, region, delivery}`、`artifacts`、`integrity`（RFC 8785 规范化后对去掉 `integrity` 的对象计算 SHA-256）；`PUT …/experiment-runs/{runId}/result`。k6 summary 等附件先 `POST …/attachments` 申请预签名 URL 再 PUT。
5. **轮询**：`GET …/experiment-runs/{runId}`，每 10 秒一次，直到 `validity.status` 不是 `pending-crosscheck` 或满 10 分钟；打印结论与原因。
6. **失败处理**：平台不可达或返回 5xx 时保留本地结果，打印 `npm run exp:upload -- <结果文件>` 供之后补传（补传只在会话仍接受上传时有效，04 §7.2）。409 `SESSION_NOT_RUNNING` 时打印“实验已结束，结果未上传”。
7. 独立模式（没有 `~/.atl/session.json`）的 `--upload` 行为不变（`POST /api/lab/results`）；平台模式下除上传到平台外，同样写 CloudAlbum 的 `POST /api/lab/results`（01 §9.5）。

**代码位置**：`experiments/_lib/platform.ts`（新增：SigV4 客户端、登记、上传、轮询）、`experiments/_lib/runner.ts`、`experiments/_lib/canonical-json.ts`（与 `scripts/module-cli` 共用实现，放在 `packages/contracts`）。

**测试**：用桩服务验证请求签名与请求体；`integrity.digest` 与 04 的服务端复算一致（共用测试向量）；平台不可达时保留本地结果。

**优先级**：P0。

### PM-39 按目标拆分的客户端统计与 `X-Cache`（P0）

**需求**：04 §7.4 第 5 步按目标分别核对服务端佐证：直连目标比较请求数，经 CDN 的目标比较源站请求数与客户端看到的 Miss/RefreshHit 数（04 M-4）。

**规格**

- 目标：`experiment.json` 的 `targets`（或命令行 `--target <名>=<URL>`，可多个）；目标类型 `direct`、`cdn`、`alb`、`apigw`，由 URL 与 capabilities 判断，结果中写 `targets[{kind, baseUrl}]`。
- `k6/common.js` 给每个请求打标签 `target`；读取响应头 `X-Cache`，归一为 `hit`、`miss`、`refresh-hit`、`error`、`none`（不经 CloudFront 时为 `none`）。
- 结果 `client` 段：

```json
"client": {
  "requests": 40, "errors": 0,
  "byTarget": { "direct": { "requests": 20, "errors": 0, "cache": { "none": 20 } },
                "cdn":    { "requests": 20, "errors": 0, "cache": { "hit": 14, "miss": 6 } } },
  "latencyMs": { "ttfb": { "direct": { "p50": 0, "p95": 0 }, "cdn.hit": { "p50": 0, "p95": 0 }, "cdn.miss": { "p50": 0, "p95": 0 } } },
  "cdnHitRatio": 0
}
```

（数值用 0 占位。）

**代码位置**：`experiments/_lib/k6/common.js`、`experiments/_lib/collect.ts`、`experiments/cdn/*.k6.js`。

**测试**：混合目标夹具的聚合结果；`X-Cache` 的各种取值归一。

**优先级**：P0。

### PM-40 运行归属（`X-Experiment-Run`）的平台模式规则（P0）

**需求**：现有设计中，`X-Experiment-*` 头只对携带管理员令牌的请求生效（总纲 7.3、8.3）。经 CloudFront 的媒体请求不转发登录 Cookie，匿名的静态与媒体请求也不带管理员令牌，结果这些请求无法按运行归属，佐证失败。

**规格**

- 平台模式下，LabMetricsStore 按 `X-Experiment-Run` 归属请求的条件改为：该 `runId` 已通过 `POST /api/lab/runs` 登记，当前时间在登记的时间窗内（加 120 秒宽限），且 `X-Experiment-Label` 等于登记的标签。**不要求**管理员身份。
- `X-Experiment-*` 头只影响指标分组，不授予任何权限；`X-Compare-Bypass` 仍然只对管理员与 `atl-lab` 生效（总纲 8.3 不变）。
- 未登记或不在时间窗内的 `runId` → 忽略该头（按普通流量统计），计数 `cloudalbum_lab_unregistered_run_header_total`。
- 独立模式不变。
- Nginx 日志的 `run` 字段（PM-18）不受此规则影响，总是记录格式合法的值；`lab-metrics` 只统计已登记的 runId。

**代码位置**：`backend/src/observability/lab-metrics.ts`、`backend/src/observability/request-context.ts`、`backend/src/repositories/lab.ts`（登记表增加 `label`、`variant`、`window_sec`）。

**测试**：匿名请求带已登记 runId 被归属；未登记、过期、标签不符的被忽略；独立模式下匿名请求不被归属。

**优先级**：P0。

### PM-41 实验机侧实验 `--on lab`（P1）

**需求**：svc-iam 的 `leak-scan`、`imds-ssrf`，svc-kms 的 `ciphertext-view`，svc-secrets 的 `key-file-risk`，svc-audit 的 `who-deleted` 场景 4 等必须在实验机上执行；结果要从工作台用学员身份上传（03 §4.11）。

**规格**

- `experiment.json` 新增 `runsOn: "workstation" | "lab"`（缺省 `workstation`）与 `labScript: "lab/<scenario>.sh"`。实验机侧脚本随发布包分发到 `/opt/cloudalbum/experiments/<module>/lab/`（PM-04），不从工作台临时上传（Run Command 参数长度有上限，以官方文档为准）。
- `npm run exp -- <module> <experiment> --label <变体> --on lab [--instance <id> | --instances all] --upload`：按 03 §4.11 的步骤登记、发现实例、以学员身份 `SendCommand(AWS-RunShellScript)`：

```text
export ATL_RUN_ID='<runId>' ATL_LABEL='<label>' ATL_EXP_PARAMS_B64='<base64url(JSON)>'
exec /opt/cloudalbum/experiments/<module>/lab/<scenario>.sh
```

  所有值先按正则校验；`Comment` 为 `atl-exp <runId>`；`executionTimeout` 取 `experiment.json` 的声明（缺省 600 秒）。
- **脚本约定**：过程输出写 stderr；stdout 最后一行且只有一行 `ATL-EXP-RESULT:<base64(gzip(JSON))>`，JSON 为 `{ "schema": "cloudalbum.lab-exp/v1", "runId", "label", "startedAt", "finishedAt", "metrics": {…}, "notes" }`，编码后不超过 16 KB；明细写 `/var/lib/atl/exp/<runId>/`（03 §4.11），随实例回收删除。
- **机密**：脚本不得依赖平台机密（实验机读不到 `/cloudalbum/<envName>/atl/*`）；需要应用管理员身份时在本机调用 `cloudalbum lab-token`（PM-17），不经命令参数传递令牌。
- 运行器取回结果后，`runner.delivery = "ssm"`、`runner.executedOn = { instanceId, commandId }`（请 04 在 schema 中登记，03 §9.6），再按 PM-38 上传。找不到标记行或被截断 → 结果标为失败（`OUTPUT_TRUNCATED`），不上传。

**代码位置**：`experiments/_lib/on-lab.ts`（新增）、`experiments/<module>/lab/*.sh`（新增）、`experiments/_lib/schema/experiment.schema.json`。

**测试**：标记行编码与解码；截断检测；参数注入；07 中 svc-iam `leak-scan` 的投递、取回、上传。

**优先级**：P1。

### PM-42 故障注入一律经 SSM；管理员凭据来源（P0）

**规格**

- **故障注入**（总纲 8.2 第 5 步）：平台模式下 `faults/*.sh` 一律经 SSM 投递（与 PM-41 同一套投递代码，学员身份、`AWS-RunShellScript`），不使用 ssh；脚本随发布包分发到 `/opt/cloudalbum/experiments/<module>/faults/`。会改动实验机状态的故障（停服务、`kill -9` worker）先获取环境操作锁（PM-28），避免与运行器的平台动作同时改动同一台实例（03 §4.11）。
- **管理员凭据**（平台模式下按顺序尝试）：
  1. 缓存的令牌 `~/.atl/cloudalbum-admin-token`（0600），未过期即用；
  2. 密码登录：以学员凭证读取 `CLOUDALBUM_ADMIN_PASSWORD_PARAM`（参数名来自 agent context，运行器不硬编码路径，04 §7.2），调用应用的登录接口取得管理员会话（auth=local，或 auth=cognito 的 `sdk` 模式且密码已由 PM-36 同步）；
  3. `lab-token`（PM-17）：经 SSM 在实验机上执行 `cloudalbum lab-token --ttl 3600 --json`，以 `Authorization: CA-Lab <token>` 访问（托管登录模式或密码登录失败时）。
  取得的令牌写回缓存文件。独立模式仍按总纲 8.2 第 1 步。

**代码位置**：`experiments/_lib/deliver.ts`（新增，与 `on-lab.ts` 共用）、`experiments/_lib/admin-auth.ts`（新增）、`experiments/<module>/faults/*.sh`。

**测试**：三种凭据来源的切换；故障脚本经 SSM 执行并持锁。

**优先级**：P0（第 3 种来源为 P1，随 PM-17）。

---

## 11. 测试数据种子

### PM-43 种子登记表与执行约定（P1）

**需求**：部分卡片需要起始状态中已有测试数据：svc-auth 的 `login-storm(after)`、svc-identity-pool 的越权测试需要已确认、密码已知的 Cognito 用户；svc-kms 需要带 GPS EXIF 的示例照片（cards 第 1 批 B-11）。04 在 `startProfile.provisions` 中以 `kind: seed` 引用种子 id，由运行器在 `profile-apply` 之后执行，种子不放在 `labs/`，随 CloudAlbum 发布包提供（04 §2.1、§3.2.3）。

**规格**

| 种子 id | 内容 | 实验机部分（运行器经 SSM） | 学员身份部分 | 幂等依据 | 回收 |
|---|---|---|---|---|---|
| `cognito-test-users` | 3 个测试用户 `atl-test-1`～`atl-test-3` | 创建本地用户与已知密码的哈希（PM-44） | auth 为 cognito 时，在 Cognito 中设置同样的密码（PM-36 钩子） | 用户名 + `users.seed_id` | 随环境删除；参数 `/cloudalbum/<envName>/atl/test-users` 由回收器删除（02 §6.5 第 6 条已覆盖 `/cloudalbum/<envName>/atl/*`） |
| `gps-sample-photos` | 3 张带 GPS EXIF 的示例照片 | 经应用的照片导入流程写入（PM-45） | 无 | `photos.seed_id` + 文件摘要 | 随环境删除 |

- **执行**：运行器在 `profile apply` 成功后，按档位 `PROFILE_SEEDS` 的顺序执行 `scripts/module seed <id> --platform`（持锁；即 02 §4.3 `profile-apply` 的第 ⑤ 步，01 §3.4 已把种子从 `base-deploy` 移出）。`scripts/module` 负责平台侧的步骤（生成密码、写 SSM 参数），实验机上的步骤经 SSM 调用 `cloudalbum seed <id> …`。
- **顺序**：`gps-sample-photos` 的照片属于 `atl-test-1`，所以必须排在 `cognito-test-users` 之后；单独使用时归属管理员。
- 种子失败时 `seed` 退出 3，运行器按“可重试 1 次、仍失败则继续但在健康门中报告”处理（种子不影响模块状态，04 §3.2.3）。
- 学员也可以在工作台上执行 `scripts/module seed <id>` 重新播种（幂等）。
- 新增种子须先在本表登记，再在卡片中引用；04 的 lint 检查 `kind: seed` 的 `item` 属于本表。

**代码位置**：`backend/src/lab/seeds/index.ts`（新增：登记表）、`backend/src/cli/seed.ts`（新增）、`scripts/module-cli/src/seed.ts`（新增）。

**测试**：重复执行不产生重复数据；顺序依赖；单独执行 `gps-sample-photos` 时归属管理员。

**优先级**：P1。

### PM-44 种子 `cognito-test-users`（P1）

**规格**

1. **平台侧**（`scripts/module seed cognito-test-users`，运行器身份）：为每个用户生成 24 个字符的随机密码（满足 Cognito 默认密码策略：大小写字母、数字、符号各至少一个）；明文写入 SecureString `/cloudalbum/<envName>/atl/test-users`（JSON：`[{ "username": "atl-test-1", "email": "atl-test-1@example.com", "password": "…" }]`，带会话标签；学员可读，工作负载身份读不到，01 §6.6）；用 argon2id 计算哈希。参数已存在时沿用其中的密码（幂等）。
2. **实验机部分**：经 SSM 执行 `cloudalbum seed cognito-test-users --users-b64 <base64url([{username,email,passwordHash}])>`（只下发哈希）：在 `users` 表中创建或更新用户（`role=user`、`email_verified=true`、`seed_id='cognito-test-users'`）。auth 已经是 cognito 时同样写入本地行（JIT 建档会在首次登录时关联 `auth_subject`），并登记钩子。
3. **Cognito 部分**（auth 为 cognito 时）：由 PM-36 的钩子 `cognito-passwords` 以学员身份执行。auth 从 local 切换到 cognito 时（bulk 迁移，`MessageAction=SUPPRESS`），迁移完成后同一钩子把密码设为已知值，所以“迁移后首次登录需要重置密码”不会挡住实验；需要演示“迁移账号首次登录”的卡片另用一个非种子账号。
4. **为什么不由运行器直接调用 `AdminSetUserPassword`**：02 规定起始状态的部署不调用 `cognito-idp`；01 把它列为“只在 06 选定由运行器播种时才启用”的有条件白名单。本文选择学员身份执行，01 的这条有条件权限保持关闭（§16 第 3 条）。
5. 邮箱一律使用保留域名 `example.com`，PM-46 保证不会真正发信（也不会给 SES 造成退信）。

**代码位置**：`backend/src/lab/seeds/cognito-test-users.ts`（新增）、`scripts/module-cli/src/seed.ts`、`scripts/module-cli/src/hooks.ts`。

**测试**：密码策略；参数已存在时幂等；auth=local 时可用种子账号登录；cognito 下钩子执行后可用同一密码登录（07）。

**优先级**：P1。

### PM-45 种子 `gps-sample-photos`（P1）

**规格**

- **资产**：3 张合成的 JPEG（由构建脚本用 sharp 生成确定性的图案，不使用第三方照片，避免版权问题），写入 EXIF 的 GPS 坐标（公开地标的近似坐标，例如东京站、东京塔、大阪城）与拍摄时间。构建产物放在发布包的 `seed/photos/gps-1.jpg`～`gps-3.jpg`，`seed/photos/manifest.json` 记录每个文件的 SHA-256 与预期的 EXIF 字段。
- **导入**：`cloudalbum seed gps-sample-photos [--owner <username>] [--album "ATL 示例（含 GPS）"]` 经应用的照片导入服务（与上传完成 `complete` 相同的流程：StoragePort 写入、缩略图、EXIF 解析、需要时经 CryptoPort 加密位置字段），所以在 local 与 s3 存储、inline 与 lambda 缩略图下都可用；`photos.seed_id='gps-sample-photos'`。
- **幂等**：按 `seed_id` 与文件摘要判断，已存在则跳过。
- 照片归属 `atl-test-1`（不存在时归属管理员）。

**代码位置**：`scripts/release/seed-assets/gen-gps-photos.ts`（新增）、`backend/src/lab/seeds/gps-sample-photos.ts`（新增）、`backend/src/services/photo-pipeline.ts`（导入入口）。

**测试**：生成的 EXIF 可被应用读出；在 s3 存储下导入成功；重复执行不重复。

**优先级**：P1。

### PM-46 保留域名的地址不真正发信（P1）

**规格**：EmailPort 的所有驱动在发送前检查收件人：域名属于 `example.com`、`example.net`、`example.org` 或顶级域 `.example`、`.invalid`、`.test`、`.localhost` 时，不调用 SES，只写 outbox 并标注“保留域名，未发送”，路径段 `email=outbox:reserved`（新增结果词）。两种模式都生效（独立模式下同样避免 SES 退信）。平台模式的管理员邮箱与种子用户都使用这些域名（PM-07、PM-44）。

**代码位置**：`backend/src/services/mailer.ts`、`packages/contracts`（结果词）。

**测试**：各保留域名被拦截；正常域名照常发送。

**优先级**：P1。

### PM-47 学员自助数据生成 `lab:seed`、`lab:seed-events`（P2）

**规格**：卡片中已经使用的两个 CLI 在总纲中登记：

- `cloudalbum lab:seed --users <n> --albums-per-user <n> --photos <n>`：只写元数据行（不生成图片文件），用户名前缀 `lab-seed-`，`photos.seed_id='bulk-feed'`；`app-stat` 的 `lab.seed.photos` 统计它（sc-db-performance、svc-database）。
- `cloudalbum lab:seed-events --target db|s3 --count <n>`：生成点击流事件（svc-analytics）。

两者都有上限（由参数校验给出），只在管理员或 root 本机执行。

**代码位置**：`backend/src/cli/lab-seed.ts`（新增）。

**测试**：上限校验；生成数据可被 `lab:cleanup` 删除。

**优先级**：P2。

---

## 12. 平台模式规则

### PM-48 平台模式规则与既有规则的平台解释（ATL-CFG 为 P0，其余 P1）

**规格**：`rules.ts` 新增下列规则（编号前缀 `ATL-`，只在平台模式下求值），总纲 5.4 同步登记：

| ID | 级别 | 可覆盖 | 范围 | 违规条件 | 说明与修复 |
|---|---|---|---|---|---|
| ATL-CFG-001 | error | 否 | 启动 | `platform.env` 中出现非 `ATL_` 前缀的键；平台模式开启但缺少必填变量或格式不符；`ATL_ENV_NAME ≠ CLOUDALBUM_ENV` | 平台配置损坏：由平台执行“环境修复”（`ATL_OP=repair` 重新写入，PM-02） |
| ATL-CFG-002 | warn | — | 启动 | 平台模式开启，但本机探测密钥不存在或不可读 | 探测主体不可用，检测会失败：`cloudalbum probe-token --init`（root） |
| ATL-NET-001 | error | 否 | 部署、启动 | `NETWORK_PLACEMENT=private`，且 `NatMode=none`，且 `InterfaceEndpoints` 不含 `ssm`、`ssmmessages`、`ec2messages` 三个接口终端节点 | 平台管理通道会断（P7）：保留 NAT，或 `InterfaceEndpoints=ssm`/`ops`/`all`（平台模式下 `ops` 含 `ec2messages`，PM-M01） |
| ATL-IAM-001 | error | 否 | 部署 | 任何操作会把基础栈的 `InstanceProfileName` 改为 `CloudAlbumAppRole` 以外的值（包括空），或会删除、替换 `CloudAlbumAppRole`，或 iam 栈未使用 `AppRoleMode=existing` | 平台管理通道依赖这个实例配置文件（PM-31） |

**既有规则在平台模式下的解释**（不改规则本身，只改判定输入或修复提示）：

| 规则 | 平台模式下 |
|---|---|
| DEP-009 | “运维通道”条件：平台管理通道可达（即 ATL-NET-001 满足）也算作运维通道，不再强制 shell-access 或 EC2 Instance Connect Endpoint（cards 第 1 批 B-6） |
| DEP-001、DEP-035 | 规则不变（仍要求 `IAM_CREDENTIALS=role`）；C3 已让几乎所有卡片预置 iam(role)，规则自然满足 |
| DEP-029 | 要求 `https.trusted=true` 且 `https.hostKind=dns`，直到 07 确认 Cognito 接受 IP 主机名的回调地址（PM-21 第 5 条） |
| ASG-014 | 修复提示改为“关闭方案 B：`scripts/module tls-preview off`；卡片应关闭 `preview.directHttps`”（PM-21 第 6 条） |
| CRED-004 | C3 之后不应在任何卡片的起始状态中出现（04 §3.2.5）；规则本身不变 |

**代码位置**：`backend/src/rules/rules.ts`、`backend/src/rules/engine.ts`（平台模式输入）、`backend/test/rules/`（每条规则正反两个用例）。

**测试**：表驱动的规则测试；平台模式关闭时 ATL-* 规则不求值。

**优先级**：ATL-CFG-001/002、ATL-IAM-001 为 P0；ATL-NET-001 与平台解释为 P1（只影响私有放置类卡片）。

---

## 13. 模块级要求（逐模块）

下表收录平台评审回写清单（writeback 第 5～25 条）、03 §13、04 §14 与 cards/ 各附录中针对模块的平台模式要求。每一项都已以“### 12. 平台模式（ATL）”小节回写到对应的模块文档（00-ec2-base 为 §14）。**所有含 IAM 角色或用户的模块**都必须满足 PM-29 的权限边界参数（P0），下表不再逐一重复。

| ID | 模块 | 要求（规格要点） | 代码位置 | 测试 | 优先级 |
|---|---|---|---|---|---|
| PM-M01 | network | `InterfaceEndpoints` 新增取值 `ssm`（= `ssm`、`ssmmessages`、`ec2messages`）；平台模式下 `ops` 额外包含 `ec2messages`；切到 `private` 后等待 `PingStatus=Online`（PM-30）；开启终端录制时还需要 `logs` 终端节点（`ops`、`all` 已含）；`endpoint-only` 实验先设 `InterfaceEndpoints=ssm` 再删 NAT 路由，并在卡片中声明预期中断窗口 | `infra/modules/network.yaml`、`scripts/module-cli/src/replace-instance.ts` | 模板测试；ATL-NET-001 用例；07 | P1 |
| PM-M02 | cdn | 源请求策略转发实验头（PM-24，P0）；响应头策略、`X-Origin-Verify` 打码、`/api/public/*` 微缓存、`AdminCidr` 占位符（PM-25） | `infra/modules/cdn.yaml` | 见 PM-24、PM-25 | P0 / P1 |
| PM-M03 | dns | 禁用 dns 或删除托管区域前提示先删除上级区域或注册商处的 NS 委派（否则形成悬空委派），平台模式下把它登记为待人工处理的安全项；`ip-change-drill` 在 `finally` 中关联回原 EIP（方案 B 的证书与 `target.publicIp` 在演练期间失效，手册提示不要点“检测”） | `scripts/module-cli/src/disable.ts`、`experiments/dns/` | 禁用前提示的用例 | P2 |
| PM-M04 | tls | 方案 B（PM-21）；`TLS_FORCE_HTTPS` 的跳转片段只用 `$ca_https_redirect`（PM-19）；平台模式下 ACME 证书由签发角色会话创建，归属由 04 按“本环境栈成员角色”认定，模块侧无需改动 | `scripts/tls/`、`infra/modules/tls/` | 见 PM-19、PM-21 | P0（PM-19）/ P1 |
| PM-M05 | waf | `flood` 实验的请求量只需略高于速率规则阈值，增加短轮次参数（`--param`，PM-37）并在手册中注明 AWS 的渗透测试政策；平台模式下 `WAF_LAB_ALLOW_CIDR` 接受 `${atl:workstationPublicCidr}` | `experiments/waf/` | 参数上限 | P2 |
| PM-M06 | load-balancer | `/api/lab/probe/echo` 回显 `X-Amzn-Trace-Id`、`X-Forwarded-Proto`（PM-11）；锁定入口（`PublicHttpIngress` 收紧）后方案 B 的续期会失败，预览改用 ALB 或 cdn 入口（PM-21） | — | 见 PM-11 | P1 |
| PM-M07 | autoscaling | 启动模板与 ASG 标签传播 `atl:session-id`、`atl:lab-id`、`atl:env-id`、`atl:component=env`、`atl:role=lab-app`、`Project`（`PropagateAtLaunch: true`），新实例才能被 State Manager 关联 `atl-prepare-instance` 选中、被终端连接、被回收；`MaxSize` 不超过平台参数（`CLOUDALBUM_ASG_MAX_SIZE_LIMIT`，由运行器传入，01 的 `AsgMaxSizeLimit`）；ASG 必须由 `scripts/module` 部署的栈创建；平台模式下引导配置包额外携带 `platform.env` 与 `atl/probe.token`（PM-01、PM-09）；`enable autoscaling` 先关闭方案 B（PM-21）；新实例经同一个引导脚本安装检查包（PM-04） | `infra/modules/autoscaling.yaml`、`scripts/module-cli/src/enable.ts` | 模板测试；07 的扩容走查 | P1 |
| PM-M08 | iam | `AppRoleMode=existing`、实例配置文件恒为 `CloudAlbumAppRole`、不动平台策略（PM-31，P0）；keys 模式经平台动作、演示用户名 `cloudalbum-<envName>-demo-keys`（路径 `/cloudalbum/`）、交接参数 `/cloudalbum/<envName>/iam/demo-keys`；平台动作 `revokeOlderSessions`、`refreshInstanceCredentials`；感知器不以 IMDS 判断启用；教学重点改为“应用使用实例角色 vs 使用访问密钥” | `infra/modules/iam.yaml`、`scripts/module-cli/src/iam.ts` | 见 PM-31 | P0 / P1 |
| PM-M09 | auth | Cookie 与 CSRF（PM-22）；Pre Sign-up 等触发器的执行角色带权限边界；平台模式下回调地址排除 IP 主机名（PM-21 第 5 条）；`enable auth`（cognito）后登记钩子 `cognito-passwords`（PM-36）；iframe 内托管登录改新标签页 | `infra/modules/auth.yaml`、`backend/src/adapters/auth/` | 见 PM-22 | P1 |
| PM-M10 | identity-pool | 已认证角色 `CloudAlbumUploaderRole` 带权限边界；`/api/lab/probe/identity-pool`（结果词 `cognito:probe`）；方案 B 下有效入口为 https，DEP-030 不再触发 | `infra/modules/identity-pool.yaml` | 见 PM-11 | P1 |
| PM-M11 | secrets | 轮换函数的执行角色带权限边界；模块参数不得使用 `/cloudalbum/<env>/atl/`；遇到“同名 secret 正在删除”（上一个环境的异步删除）时重试，超过等待上限给出明确错误（cards 第 1 批 B-8） | `infra/modules/secrets.yaml`、`scripts/module-cli/src/enable.ts` | 同名冲突的重试用例 | P1 |
| PM-M12 | config | 参数不得使用 `/cloudalbum/<env>/atl/`；迁移脚本跳过空值（`banner`、`allowedEmailDomains` 默认为空，Parameter Store 不接受空值，以官方 API 校验为准），diff 页标注“未写入（空值）”；`reject-invalid` 演练只删除 `CACHE_DRIVER`，`maxUploadMb` 用参数历史写回原值（cards 第 1 批 B-21） | `scripts/migrate/config/` | 空值迁移用例 | P2 |
| PM-M13 | kms | 演示脚本先 `describe-key --key-id <别名>` 解析出密钥 ARN，再调用只接受 ID 或 ARN 的 `DisableKey`、`EnableKey`、`GetKeyRotationStatus`（已按官方 API 参考核实，cards 第 1 批 B-14）；模板新增参数 `AliasName`（缺省 `alias/cloudalbum`，独立模式不变），平台模式传 `alias/cloudalbum-<envName>`（别名在账号内唯一，上一个环境回收失败时可能残留），`KMS_KEY_ID` 取栈输出；`/api/lab/probe/kms` | `infra/modules/kms.yaml`、`experiments/kms/`、`scripts/module-cli/` | 别名解析用例；平台模式下别名带环境名 | P1 |
| PM-M14 | storage | `/api/lab/probe/media-url`（PM-11）；种子照片经 StoragePort 导入（PM-45）；桶名长度预算（PM-29） | — | 见 PM-11 | P0 |
| PM-M15 | shared-fs | 实验模板 `second-instance.yaml` 支持“临时第二台实例”模式：接受 `SubnetId` 与空的文件系统参数，使用 `CloudAlbumAppRole`、带会话标签、**不带** `atl:role`；`enable shared-fs --dry-run` 打印计划使用的两个子网（cards 第 2 批 C-9） | `experiments/shared-fs/second-instance.yaml` | 模板测试 | P2 |
| PM-M16 | database | `/api/lab/probe/now` 执行 `select now()`（PM-11）；增强监控等服务角色（若启用）带权限边界 | — | 见 PM-11 | P0 |
| PM-M17 | cache | `/api/lab/probe/now` 的探测键（PM-11）；ASG-004 与 `LB_LOCAL_WORKERS=2` 的关系以总纲 5.2 为准（cards 第 2 批 C-17，模块文档对齐） | — | 见 PM-11 | P1 |
| PM-M18 | social-store | 无平台模式差异（路径证据用 `path-seen`） | — | — | — |
| PM-M19 | backup | Backup 服务角色带权限边界；跨区域副本的目标区域等于平台参数 `DrRegion`（`${atl:drRegion}`）；Vault Lock 只允许治理模式（合规模式会产生回收器删不掉、持续计费的存储，01 护栏已拒绝）；区域级设置在变更前备份到状态桶、回收时还原（PM-27） | `infra/modules/backup.yaml`、`backup-dr.yaml` | 模板测试 | P1 |
| PM-M20 | analytics | Firehose 角色带权限边界；Athena、Glue 只读操作需要 04 的白名单收录（04 侧） | `infra/modules/analytics.yaml` | 模板测试 | P1 |
| PM-M21 | image-processing | Lambda 执行角色带权限边界（学员在工作台上 `enable` 时，学员边界要求新角色带工作负载边界，否则 `CreateRole` 被拒，所以是 P0）；路径证据用 `path-seen` | `infra/modules/image-processing.yaml` | 模板测试；07 的 svc-image-processing 走查 | P0 |
| PM-M22 | queue | 无模块侧改动；路径证据用 `path-seen`，`biz.jobs_lost` 用 `app-stat --run`（PM-16） | — | — | — |
| PM-M23 | notification | `experiments/notification/seed-users.ts` 的收件人取学员前置输入的邮箱；测试用户邮箱为保留域名时不建订阅 | `experiments/notification/` | — | P2 |
| PM-M24 | email | SES 发件身份已存在时只读使用（`AdoptExistingIdentity=true`），禁用时不删除（02 的预检把“缺少身份”视为卡片内创建，cards 第 2 批 C-12）；保留域名不发信（PM-46） | `infra/modules/email.yaml` | 已有身份的用例 | P1 |
| PM-M25 | scheduler | Scheduler 执行角色带权限边界；平台模式下 `heartbeat` 实验缺省 `--duration 30m`；第二个 worker 的演示与 `(name, scheduled_at)` 唯一索引的关系在模块文档中写明（cards 第 2 批 C-13） | `infra/modules/scheduler.yaml`、`experiments/scheduler/` | — | P1 |
| PM-M26 | tagging | 无平台模式差异 | — | — | — |
| PM-M27 | social-api | Lambda 集成与授权器的执行角色带权限边界；平台模式下 `auth=local` 时缺省使用 Lambda 授权器（HTTP API 的 JWT 授权器不支持 ES256） | `infra/modules/social-api.yaml` | 模板测试 | P1 |
| PM-M28 | shell-access | 平台终端使用独立文档 `ATL-SessionShell`，模块不得修改它；感知器与检查统计会话时排除文档为 `ATL-SessionShell*` 或会话 ID 以 `atl-<sid>-term-` 开头的平台会话；`SSM-SessionManagerRunShell` 修改前的原值备份到状态桶 `<envName>/backups/`（PM-27），回收时还原；平台模式下 L0 的 SSM 已在线，模块只负责关闭 22 端口与会话首选项；SSH 从工作台发起；`probe-port` 支持 `--target private-ip` | `backend/src/modules/detectors/shell-access.ts`、`scripts/module-cli/src/enable.ts`、`experiments/shell-access/` | 会话过滤用例 | P1 |
| PM-M29 | logging | CloudWatch Agent 创建的日志组由回收器的派生资源规则处理（02 §7.4），模块侧给 Agent 配置的日志组名用 `cloudalbum-<env>-` 前缀，便于识别 | `infra/modules/logging/cwagent.json` | — | P2 |
| PM-M30 | monitoring | 停止实例的演练会让管理通道离线：卡片声明 `expectedOutage`（04）。**第 3 轮补充**（cards svc-monitoring 第 2、6 步、sc-observability 第 1、4 步，scenario-cards B-34）：`experiments/monitoring/kill-test` 增加参数 `--phase service\|instance\|all`（平台模式缺省 `service`；独立模式缺省 `all`，即现有的两阶段连跑，行为不变）。`service` 只做第一阶段（停 api 与 worker，等待后恢复）；`instance` 只做第二阶段（以调用者凭证 `ec2:StopInstances` 停止实验机、等待、`StartInstances` 启动并等到 `PingStatus=Online`，EIP 与实例 ID 不变；脚本在 `finally` 中保证实例被启动）。`experiment.json` 的 `labels` 登记一次性变体 `stop-instance`（`{ "title": "停止实验机", "role": "single" }`），`requires` 中 `stop-instance` 的条件与 `after` 相同；运行器校验（平台模式）：`--label stop-instance` 必须配 `--phase instance`，`before`、`after` 只接受 `--phase service`（或缺省），不符合时退出 2——这样 `before`/`after` 两侧的场景参数一致，04 §7.4 第 8 步判为可比。`phase` 写入结果的 `params.phase` | `experiments/monitoring/kill-test.ts`、`experiments/monitoring/experiment.json` | 两个阶段分别运行的用例；`stop-instance` 与 `--phase service` 组合被拒；`finally` 中恢复实例 | P1 |
| PM-M31 | audit | 已有记录管理事件的 trail（包括可选的平台 trail）时，只创建记录数据事件的 trail；平台模式下 `ObjectLockDays` 缺省 0；Object Lock 只允许治理模式 | `infra/modules/audit.yaml`、preflight `existing-trail` | preflight 用例 | P1 |
| PM-M32 | threat-detection | 本环境创建的检测器在 `disable` 与回收时删除（不是暂停）；“已存在则只读接入”时不删除；攻击模拟从工作台发起时注意 fail2ban 的 `ignoreip` | `scripts/module-cli/src/disable.ts` | 只读接入用例 | P1 |
| PM-M33 | compliance | 配置记录器的服务角色带权限边界；本环境创建的记录器与投递通道在 `disable` 与回收时停止并删除；本地自检把 `labuser` 的免密 sudo 与 `/opt/atl` 标注为平台管理通道（PM-08） | `infra/modules/compliance.yaml`、`backend/src/services/compliance-check.ts` | 平台例外用例 | P1 |
| PM-M34 | vuln-scan | 新增参数 `ScanTypes`（缺省全部；平台模式缺省只启用 EC2）——激活是账号级的，会扫描并计费平台的 Lambda 与工作台；本环境激活的扫描类型在回收时停用；本地扫描对 `/opt/atl` 的标注同 PM-08 | `infra/modules/vuln-scan.yaml` | 参数用例 | P1 |
| PM-M35 | cost | 区分 `Project=ATL` 与 `Project=CloudAlbum`；说明平台可选预算 `atl-platform-guard` 与学员自建预算的关系；成本分配标签的激活只能经平台动作 `activateCostAllocationTags`（学员身份执行时跳过并提示，PM-30），说明新标签键要等一段时间才可激活、激活后还要一段时间才生效（时长以官方文档为准）、Organizations 成员账号只能由管理账号激活；本地费用估算加入工作台 EC2、EBS、公网 IPv4 的计费维度 | `infra/modules/cost.yaml`、`backend/src/services/cost-estimate.ts` | 学员身份跳过激活的用例 | P2 |
| PM-M36 | db-proxy、workflow、ami | db-proxy：代理读取 Secrets 的服务角色带权限边界。workflow：状态机角色带权限边界；`worker-down` 增加 `--fault stop-app`。ami：Image Builder 实例角色带权限边界；构建实例不得带 `atl:role`；golden AMI 的管道执行 PM-04 与 PM-06 的检查；`dependency-failure` 增加 `--egress none`；平台模式下 `boot-time` 实验缺省走单实例 `rebuild-instance` | `infra/modules/db-proxy.yaml`、`workflow.yaml`、`ami.yaml`、`experiments/` | 模板测试 | P1 / P2 |

---

## 14. 实施顺序与测试矩阵

### 14.1 P0 实施顺序

| 批次 | 内容 | 验收 |
|---|---|---|
| 1. 基础部署 | PM-01、02、04、05、06、07、12（入口与根子命令）、15（`platform-status`、`capabilities`）、26、27、28、29、30、31（`AppRoleMode=existing` 等）、35、48（ATL-CFG、ATL-IAM） | 运行器的 `base-deploy` 六步全部成功；健康门 `base.ready` 通过；工作台上 `scripts/module enable storage` 写状态桶、拿锁、打标签 |
| 2. 起始状态 | PM-32、33、34 | 56 张卡片的 `plan --start-of` 结果稳定；`profile apply --mode fresh` 与 `--mode additive` 各走通一次 |
| 3. 检测 | PM-03、08（S02、S28、S29）、09、10、11（now、echo、media-url）、13、14、16（`path-seen`）、18、19 | 04 的 `capability-snapshot`、`http-probe`、`nginx-log-summary`、`path-seen` 在示例卡片上判定正确 |
| 4. 对比实验 | PM-24、37、38、39、40、42 | svc-cdn 的 `media-load` before/after 上传后 `validity=valid`；svc-queue 的 `upload-burst` 同样有效 |

P1 与 P2 按卡片需要逐步实现；PM-21（方案 B）与 PM-20（CSP）一起实现，预览才能嵌入。

### 14.2 契约测试与集成测试

- **契约测试**（`backend/test/contract/platform/`）：探测令牌（PM-09）、探测端点的响应与路径段（PM-11）、CLI 的 JSON 输出（PM-12～PM-17）都有 JSON Schema，与 04 共用（放在 `packages/contracts/schemas/`）；04 的检查包测试直接引用这些 schema。
- **平台模式关闭的等价性测试**：对现有冒烟测试、capabilities 快照、响应头快照各跑一次“没有 `platform.env`”的版本，结果必须与改动前一致（1.5 第 2 条）。
- **`scripts/module` 的集成测试**：S3 与 DynamoDB 用 LocalStack（或沙箱账号）验证条件写与锁；SSM 投递用桩替代。
- **规则测试**：ATL-* 规则与平台解释每条两个用例（`backend/test/rules/`）。

### 14.3 需要真实 AWS 确认的事项（交给 07）

| 事项 | 影响的条目 |
|---|---|
| S3 条件写（`If-Match`、`If-None-Match`）的支持范围与 412 行为 | PM-27 |
| SSM Agent 支持 `interpolationType: ENV_VAR` 的最低版本；AL2023 仓库中的 Agent 版本 | PM-06 |
| Let's Encrypt IP 短期证书在 EIP 上的签发与自动续期；签发限额 | PM-21 |
| Cognito 是否接受以 IP 为主机名的 HTTPS 回调地址 | PM-21 第 5 条、DEP-029 |
| 各浏览器对分区 Cookie（CHIPS）的支持；iframe 内本地登录能否保持 | PM-22 |
| CloudFront 自定义源请求策略转发实验头且不影响命中率；`/api/*` 行为转发 `X-ATL-Probe-Token` | PM-24、PM-11 |
| `ReplaceIamInstanceProfileAssociation` 用同一个实例配置文件能否让实例取得新凭证；撤销旧会话后管理通道的恢复时间 | PM-31 |
| Run Command 标准输出的截断长度与 `ATL-EXP-RESULT:` 标记行的取回 | PM-41 |
| `nginx` 的 `add_header` 取值为空时是否输出该头 | PM-20 |

---

## 15. 需要其他文档配合的事项

| 文档 | 需要配合的内容 |
|---|---|
| **01** | ① 名称表登记本文新增的 CloudAlbum 侧名称：CLI 子命令（`platform:apply-env`、`platform-status`、`capabilities`、`module-state`、`path-seen`、`app-stat`、`lab-token`、`seed`、`atl-bundle:install`、`iam:install-keys`）、请求头 `Authorization: CA-Lab`、实验主体 `atl-lab`、参数 `/cloudalbum/<envName>/atl/test-users`、`scripts/module` 的环境变量（PM-26 表）与退出码 7、8、基础栈参数 `PlatformMode`、种子 id。② §9.2 “systemd `EnvironmentFile=-` 可选加载”改为“由应用的 `load-env.ts` 作为第 1b 层加载”（§16 第 1 条）。③ 平台动作的 registry 操作 id 与 `ATLProvisionerRole` 的追加语句表按 PM-34 的表；“测试数据种子”一行的有条件 `cognito-idp` 权限保持关闭（PM-44）；运行器需要 `ssm:PutParameter` 于 `/cloudalbum/*/atl/test-users`（已在 `/cloudalbum/*/atl/*` 范围内）。④ capabilities 投影清单增加 `app.platform`、`validation.*[].modules`（PM-03）。⑤ `atl:role` 由基础栈在 `PlatformMode=on` 时以资源级标签设置（PM-05） |
| **02** | ① 运行器按 PM-35 的退出码分类：7 → `ENV_LOCK_TIMEOUT`（可重试 1 次），8 → 可重试 1 次（先 `status --repair`）。② `base-deploy` 第 4～6 步调用的命令以 PM-02、PM-09（`probe-token --init`）、PM-07 为准；第 4 步写入的值用 `ATL_PLATFORM_MODE=on`（`=1` 也被接受）。③ `profile-apply` 之后按 `PROFILE_SEEDS` 执行 `scripts/module seed`（PM-43）；复用环境时先 `platform:apply-env` 更新会话事实。④ 锁项的键为 `env#<envName>`（01 的写法；02 §9.3 表中写的是 `<envName>`）。⑤ 运行器传 `--lock-wait 900` |
| **03** | ① `/etc/atl/session.env` 中 CloudAlbum 变量的最终名称以 PM-26 表为准（新增 `CLOUDALBUM_TEST_USERS_PARAM`、`CLOUDALBUM_OPS_REPORT=agent`）。② `ATL-WorkstationSetup` 在写好学员 CLI 配置后以 `labuser` 执行一次 `scripts/module hooks run --pending --platform`（PM-36）。③ shell-access 的单例备份前缀写为 `<envName>/backups/`（01 的写法；03 §4.12 写的是 `backup/`）。④ 实验机侧脚本放在发布包 `/opt/cloudalbum/experiments/<module>/lab/`（PM-41） |
| **04** | ① `app-stat` 的统计名白名单以 PM-16 的表为准；`path-seen` 的参数与输出以 PM-16 为准。② `nginx-log-summary` 使用新字段 `run`、`probe`：`nonce` 计数包括 `probe=1` 的行，`counts` 排除它们（PM-18）。③ 起始档位名：01 的规范写法是 `atl/<card-id>/<variant>`（默认 `atl/<card-id>/default`），04 §2.1、§2.5 与 K-3 写的 `atl/<card-id>` 由本文作为别名接受，建议 04 按 01 统一。④ `lab-metrics-run` 的观测值以 PM-14 的输出为准。⑤ `atl.experiment-result/v1` 登记 `runner.delivery`、`runner.executedOn`（PM-41）。⑥ capability 投影字段名以 PM-03 为准 |
| **cards/** | ① svc-identity-pool 第 3 步：`/api/lab/probe/identity-pool` 的路径段改为断言 `identity-pool=cognito:probe`，“真的接入 STS”的证据改用 `path-seen`（`identity-pool` 段匹配 `^cognito:sts$`，学员在预览中上传一张照片之后）。② svc-config 第 2 步：`config=ssm:v<N>` 的路径证据改为请求 `/api/lab/probe/now`。③ svc-db-proxy、sc-db-performance 中残留的 `/api/console/probe/now` 改为 `/api/lab/probe/now`。④ 测试数据只引用 §11 登记的种子 id。⑤ svc-kms 中的别名 `alias/cloudalbum` 在平台模式下为 `alias/cloudalbum-{{ session.env }}`（PM-M13） |
| **07** | §14.3 的各项列入验证计划 |
| **modular-design、docs/modules** | 已由本文回写（§16） |

**第 3 轮状态**（跨文档审计后）：01 的 ②（`EnvironmentFile` 说法已删除）、③（运行器不获得 `cognito-idp:Admin*`）与 agent context 字段表（01 §8.2，覆盖 PM-26 全部变量）已落实；02 的 ①（退出码 6、7、8 的分类）、③（`profile-apply` 第 ⑤ 步种子、第 ⓪ 步 `platform:apply-env`）、④（锁键 `env#<envName>`）已落实；03 的 ①②（`session.env` 全部变量、`hooks run --pending`）已落实；04 的 ③（档位名统一为 `atl/<card-id>/<variant>`，文件 `profiles/atl/<card-id>/<variant>.env`）已落实；cards/ 的 ①②⑤（svc-identity-pool 的 `cognito:probe`、svc-config 的 `/api/lab/probe/now`、KMS 别名带 `envName`）已落实。

---

## 16. 回写记录与未采纳的意见

### 16.1 本轮回写到其他文件的内容

| 文件 | 位置 | 内容 |
|---|---|---|
| `docs/modular-design.md` | 1.4 | 新增 D16“平台模式”：开关、单一清单、优先级规则 |
| 同上 | 2.5、2.7、2.9、3.5、4.4、5.4（新增）、6.1、7.3、8.2、9.1、9.2、10.4、11、附录 A | 各节末尾的“平台模式（ATL）”小节：本文条目的摘要与编号引用 |
| `docs/modules/00-ec2-base.md` | §14（新增） | PM-01、02、04～08、12、18～20 的基础契约部分 |
| `docs/modules/01`～`06` | 各模块第 12 节（新增） | §13 中对应模块的条目 |
| `docs/ui-design.md` | 文首 | “已被平台方案取代”的说明（C6） |

### 16.2 没有采纳或做了调整的意见

1. **systemd `EnvironmentFile=-/etc/cloudalbum/platform.env`**（平台评审 writeback 第 5 条、01 §9.2）：改为由 `load-env.ts` 作为第 1b 层加载。理由：总纲 4.4 规定启动配置“不依赖 systemd 的 `EnvironmentFile`”；CLI（不在 systemd 下运行）也必须读到同一组值。
2. **Nginx 日志直接写 `"args":"$args"`**（04 M-1）：改为经 map 的 `$ca_log_args`——查询串含签名、授权码等敏感参数时整段替换为 `[redacted]`；另外追加 `run` 与 `probe` 两个字段。理由：F6 的签名上传 URL 与 OAuth 回调的 `code` 会进入日志，logging 模块还会把日志送到 CloudWatch；探测参数所在的请求不带敏感参数，不影响 nonce 计数。
3. **由运行器直接调用 `AdminSetUserPassword` 播种 Cognito 测试用户**（cards 第 1 批 B-11 的一个选项、01 的有条件白名单）：改为平台钩子以学员身份执行（PM-36、PM-44）。理由：02 规定起始状态的部署不调用 `cognito-idp`；学员身份本来就有该权限，不需要扩大运行器的白名单。
4. **`/api/lab/probe/identity-pool` 的路径段为 `cognito:sts`**（cards 第 1 批 svc-identity-pool 第 3 步）：改为新增结果词 `cognito:probe`。理由：真正签发 STS 凭证需要终端用户的 ID 令牌，探测主体没有，伪造一个 `cognito:sts` 会让检查失去意义；接入 STS 的证据改由 `path-seen` 读取真实上传。
5. **state.json 放在工具链桶、栈不加 `atl:component`**（平台评审 writeback 第 0、1 条，INC#4、#23）：已被主设计者裁决 C4(c)、C4(d) 取代——状态在平台栈的状态桶与锁表中，栈加 `atl:component=env`。
6. **`X-Experiment-*` 只对管理员生效**（总纲 7.3 现有规则）：平台模式下放宽为“已登记且在时间窗内的运行”（PM-40）。理由：经 CloudFront 的媒体请求与匿名请求无法携带管理员令牌，否则对比实验的服务端佐证无法成立；这些头只影响指标分组，不授予权限。
7. **`ATL_PLATFORM_MODE` 的取值**：01 写 `on`，02 写 `1`。本文以 `on`/`off` 为规范值，同时接受 `1`/`true`/`0`/`false`。
8. **起始档位名**：01 为 `atl/<card-id>/<variant>`，04 第 2 轮为 `atl/<card-id>`（默认）。按 C1 以 01 为准；04 已在第 3 轮统一，短名只作为手工调试的别名保留。
9. **单独的 `/api/lab/probe/config`、`/probe/<任意模块>`**（cards 第 1 批 B-12 “按模块补探测端点”）：只补了 auth、identity-pool、kms 三个确有需要的；config 由 `now` 覆盖，异步路径上的模块用 `path-seen`。理由：每个探测端点都是一个需要维护的只读入口，按需增加。
10. **停机保留的 L0 实例改 `atl:role=lab-app-standby`**（cards 第 1 批 B-16 的一个选项）：不采纳。04 §5.2.1 已规定发现时只取 `running` 且（ASG 模式下）`InService` 的实例，CloudAlbum 侧不改标签。

---

## 修订记录

### 2026-10-13 · 第 1 版（新建，主设计者裁决 C5）

- **依据**：主设计者裁决 C1～C8（尤其 C3 起始状态规则、C4(c) 状态桶与锁表、C4(d) 标签、C5 清单范围、C6、C8）；平台评审 `critique.writeback` 第 0～32 条中 CloudAlbum 侧的部分、`inconsistencies` 的统一取值、`walkthrough_breaks` 第 4、5、7 条、`security_cost_gaps`；01 §3.11、§9、§14（第二轮）、02 §3.6、§4.3、§6.5、§8.4、§9.5、03 §4.6、§4.11、§4.12、§6.2、§6.3、§13、04 §2～§7、§12.4、§14；cards/ 各文件附录 B/C 与 tracks-and-catalog §7.6、§8.6。
- **内容**：48 个平台模式条目（PM-01～PM-48）与 36 行模块级要求（PM-M01～PM-M36），每项写明需求、规格、代码位置、测试与优先级；P0 实施顺序与需要交给 07 的实测项；需要 01～04 与 cards/ 配合的事项。
- **新增的 CloudAlbum 侧名称**：本机 CLI 入口 `/opt/cloudalbum/bin/cloudalbum` 及其子命令；令牌格式 `atlpk1`/`atlpt1`/`atllt1`；实验主体 `atl-lab` 与 `Authorization: CA-Lab`；`scripts/module` 的环境变量、子命令、退出码 7、8；基础栈参数 `PlatformMode`；iam 栈参数 `AppRoleMode`；network 的 `InterfaceEndpoints=ssm`；种子 `cognito-test-users`、`gps-sample-photos`；结果词 `cognito:probe`、`efs:sign`、`outbox:reserved`；规则 ATL-CFG-001/002、ATL-NET-001、ATL-IAM-001。
- **回写**：见 §16.1。

### 2026-10-13 · 第 2 版（跨文档审计修复）

| # | 审计问题 | 位置 | 修订 |
|---|---|---|---|
| P-1 | （中）`PROFILE_EXTRA_STACKS` 只标“预留”，卡片自带栈的部署者与名字没有定论 | PM-33 档位文件、第 11、12 步与输出 | 定义格式 `<stackId>@<region>[,…]`（只列 `deploy: start` 的栈，顺序即部署顺序）；`scripts/module` 只校验格式、不部署，部署者是 01 启用的 `ATL_OP=extra-stack`（栈名 `cloudalbum-<envName>-x-<stackId>`）；摘要对象增加 `extraStacks: [{id, region}]`，`plan` 输出增加 `extraStacks` |
| P-2 | （中）运行期复核写成 `plan --start-of`，运行器拿不到 `lab.yaml` | PM-32、PM-33 | 改为 01 选定的方案 (a)：运行期 `plan --profile atl/<card-id>/<variant> --json`；PM-32 写明它从档位文件重建同一规范化对象、与 `--start-of` 同一摘要算法（`registryVersion` 取当前工具包）；档位名短写法降为调试别名 |
| P-3 | （低）`kill-test` 不能分阶段运行，卡片的成对比较会被判不可比 | PM-M30、PM-37 | `experiments/monitoring/kill-test` 增加 `--phase service\|instance\|all`（平台模式缺省 `service`，独立模式缺省 `all`）；登记一次性变体 `stop-instance`（`role: single`），平台模式下只接受 `--phase instance`；`phase` 写入结果的 `params`；回写 docs/modules/05-ops-observability.md 的 monitoring 第 12 节 |
| P-4 | （中，配合）测试数据种子的执行时机 | PM-26、PM-43 | 本文规格不变（`profile apply` 之后由运行器执行 `seed`，Cognito 部分由钩子以学员身份执行）；注明对应 02 §4.3 `profile-apply` 第 ⑤ 步、01 §3.4 已把种子移出 `base-deploy`；PM-26 的变量来源指向 01 §8.2 的 `atl.agent-context/v1` 字段表 |
| P-5 | §15 的配合事项 | §15、§16.2 第 8 条 | 增加“第 3 轮状态”：01、02、03、04、cards 中本文提出的配合项已在同一轮落实 |

**没有采纳的意见**：无。

**仍需其他文件配合**：无新增。07 的验证项（S3 条件写、`plan --profile` 摘要一致等）沿用 §14.3。
