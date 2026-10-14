# 学习卡片目录与学习路径（Track）

> **文档定位**：AWS Training Lab（ATL）卡片模型中**学习路径、掌握度、徽章与路径证书**的权威定义，以及卡片模型的基本规则。本文负责：卡片 id 与命名规范、目标与起始状态的规则（落实主设计者裁决 C3）、9 条学习路径、掌握度模型（徽章、服务掌握度、路径证书、证据权重、漂移与证据失效）、路径数据文件 `labs/_tracks/<track-id>.yaml`（`atl.track/v2`），以及场景卡对服务格的计入。
>
> **与其他文档的分工**（主设计者裁决 C1、C2）：
> - [05-lab-catalog.md](../05-lab-catalog.md)（卡片目录，权威）：目录页信息架构（卡片网格、服务地图、路径视图、筛选）、56 张卡片的元数据汇总、原 Lab 0～25 → 卡片 id 的映射、目录总则（难度、时长、费用档位、部署等级）、分类法 `taxonomy.yaml`、生成的 `catalog.yaml` 与目录 API 的响应。本文第 2 轮中属于这些主题的内容（原 §2.1、§3.1 总表，§3.2 逐卡要点，§6 目录页，§7.4、§7.5 的数据格式）已移交 05，本文只留指针。
> - [04-lab-format-checks-reports.md](../04-lab-format-checks-reports.md)：`lab.yaml` v2 的字段与 JSON Schema、lint 与 `labs:derive`（DRV-1～11）、检测引擎、进度、报告与证书的**格式**。本文只定义模型与规则，字段名一律以 04 §3 为准。
> - [01-architecture.md](../01-architecture.md) §14：唯一的名称表（实体、API 路由、事件、标签、档位名等）。
> - [06-cloudalbum-platform-mode.md](../06-cloudalbum-platform-mode.md)：`scripts/module plan --start-of <card>` 的命令与算法、registry 的机器可读数据、测试数据种子等 CloudAlbum 侧要求。
>
> **状态**：设计稿 · 第 3 轮（落实主设计者裁决 C1～C8，见文末“修订记录”）· 2026-10-13
>
> **依据**（只读引用，本文不修改它们）：[README.md](../../../README.md) 的机能与服务对照表、学习路线；[modular-design.md](../../modular-design.md) §3.2 模块总表、§5.2 规则表、§10 档位与单模块模式；[docs/modules/00～06](../../modules/)；[labs.md](../../labs.md)；平台设计 01～06。本文与它们不一致的地方写进 §8（接口与回写状态）和 §9（发现的问题）。
>
> **同目录文档**：逐卡设计见 [service-cards-1-base-edge-identity.md](service-cards-1-base-edge-identity.md)（ec2、A 组、B 组，14 张）、[service-cards-2-data-compute.md](service-cards-2-data-compute.md)（C 组、D 组，14 张）、[service-cards-3-ops-governance.md](service-cards-3-ops-governance.md)（E 组、F 组，12 张）与 [scenario-cards.md](scenario-cards.md)（16 张场景卡）。逐卡文档定义步骤、检查、手册与小测；卡片的标题、难度、时长、起始状态、费用档位等目录级取值以 05 §4 的汇总表为准，最终由 `lab.yaml` 经 `labs:catalog` 生成并核对。本文规则与逐卡文档冲突的地方集中在 §3.3。
>
> **约定**：“L0”即档位 `l0-ec2`。不写价格与精确的性能数字，费用只写档位（低 / 中 / 高）和主要计费来源；新近的 AWS 事实注明“以官方文档为准”。文档语言为简体中文，技术名词保留英文。

---

## 目录

- [0. 摘要：关键决策](#0-摘要关键决策)
- [1. 卡片模型与命名规范](#1-卡片模型与命名规范)
- [2. 单服务卡片：分支选择与特殊情况](#2-单服务卡片分支选择与特殊情况)
- [3. 场景卡片：计入规则与裁决](#3-场景卡片计入规则与裁决)
- [4. 学习路径（Track）](#4-学习路径track)
- [5. 掌握度模型](#5-掌握度模型)
- [6. 目录页信息架构（已移至 05）](#6-目录页信息架构已移至-05)
- [7. 数据文件](#7-数据文件)
- [8. 与 docs/platform/01～06 的接口与回写状态](#8-与-docsplatform0106-的接口与回写状态)
- [9. 发现的现有设计问题](#9-发现的现有设计问题)
- [修订记录](#修订记录)
- [审稿修订记录](#审稿修订记录)

---

## 0. 摘要：关键决策

| # | 决策 | 理由 |
|---|---|---|
| T1 | 目录的基本单位是**卡片**：单服务卡片（`kind: service`，id `svc-<module-id>`）40 张，场景卡片（`kind: scenario`，id `sc-<slug>`）16 张，共 56 张。每张卡片都能单独开始。原 Lab 0～25 是学习路径 `saa-main` 中的步骤（映射见 05 §5） | 用户确认的卡片化要求；主设计者裁决 C2 |
| T2 | **技术标识沿用 lab**：卡片 id 就是 `labId`；`labs/<id>/lab.yaml`、`LabSession.labId`、`LabProgress`、`/api/v1/labs/*`、标签 `atl:lab-id` 都不改名，界面上称“卡片” | 卡片是 lab 的一种组织方式。改名会波及 01～04 的实体、API、权限边界与回收器，收益只是措辞（01 §14 已按此登记） |
| T3 | id 规则：`svc-<模块 id>`、`sc-<slug>`。单服务卡标题写成“服务：机能”，场景卡标题写成“场景名”，副标题是服务组合 | 用户要求；id 前缀直接表明类型 |
| T4 | 每个目标写成“起始取值 → 目标取值”。`lab.yaml` 用 04 §3.2.4 的 `targetModules[]{id, driver, fromDriver?, set?, params?, wireStep}` 表达；单服务卡的目标取值 = 该模块在 `profiles/single/<id>.env` 中的取值 | 一种写法同时覆盖“本地档基线”“前驱取值”“对起始模块改参数”三类情况（04 DRV-5 取代 v1 lint 第 4 条） |
| T5 | **起始状态 = L0 + iam(role) + 目标模块硬依赖的闭包**（裁决 C3）；`svc-ec2` 与 `svc-iam` 不预置 iam。不直接使用 `single/<id>` 档位（它包含目标模块本身），由 `scripts/module plan --start-of <card>` 推导（06），构建期逐项核对（04 DRV-1～11）。场景卡可以另加写明理由的背景模块（四类）与卡片自带的 `extraStacks` | 起始状态的口径全平台只有一个；“只因没有凭证而 `degraded`”从此不再出现 |
| T6 | **svc-network 的目标是 `public`**（原 Lab 14）；`private` 放置归场景卡 `sc-private-network`（原 Lab 20） | 严格闭包；private 必须同时具备入口、出网、运维通道（DEP-009），天然是组合场景。与批次 1 的写法不同，见 §2.3、P-1 |
| T7 | 9 条路径：`saa-main`、`secure`、`resilient`、`performant`、`cost-optimized`、`quick-compare`，以及新增的 `serverless`、`networking`、`operations`。`saa-main` 覆盖全部 56 张卡片 | 用户要求的 6 条 + 3 条按技术方向组织的路径 |
| T8 | 完成单张卡片 → **徽章**（不签名，记在 `LabProgress` 中）。**徽章只看卡片是否完成，小测成绩只记录在徽章上，不影响完成**（裁决 C3）。完成路径 → **路径证书**（签名，格式见 04 §10）。卡片默认不签发证书 | 用户要求“完成单张卡片获得徽章”；每卡只有 3 道小测；证书只给可对外出示的成果 |
| T9 | **服务掌握度**按 40 个“服务格”（= 模块）计算：等级按规则判定，分数只用于进度环。只有本卡的目标步骤（或声明的 `creditBy` 步骤）以**本会话证据**通过，才计入该服务 | 规则可解释；防止复用环境中继承来的配置被算作学员本人的成果 |
| T10 | 证据权重：自动判定 1.0、原生手动 1.0、带证据手动 0.9、`simulated` 基线 0.8、降级手动 0.5。徽章分“已核验 / 含手动 / 自述为主”三级 | 区分“设计上就只能手动”与“平台没能自动核验” |
| T11 | 徽章一经授予**不因配置漂移撤销**；只有完成所依据的证据后来被判无效时才撤回 | 会话结束时资源全部回收，完成时刻的证据已固化（04 §8.4“只升不降”） |
| T12 | 目录页（卡片网格、服务地图、路径视图、筛选）、卡片视觉规范与图标规则由 **05 §2** 定义；本文只保留徽章图形（§5.8） | 裁决 C2 的分工：目录页信息架构在 05 |
| T13 | 路径数据 `labs/_tracks/<track-id>.yaml`（`atl.track/v2`）由本文定义（§7.3）；`taxonomy.yaml` 与生成的 `catalog.yaml` 由 05 定义；`lab.yaml` 由 04 定义 | 同一事实只写一次 |

---

## 1. 卡片模型与命名规范

### 1.1 术语

| 术语 | 含义 |
|---|---|
| 卡片 | 一个可以单独开始、单独完成的小实验，对应一个 `labs/<card-id>/` 目录 |
| 单服务卡片 | 只讲一个模块（一个主 AWS 服务）的“有 vs 没有”。每个模块一张，另有 ec2 基线一张 |
| 场景卡片 | 2～5 个服务一起解决一个真实场景，写法接近 SAA 场景题；服务可以来自目标模块、起始状态中的模块（经 `creditBy` 计入）或卡片自带的 `extraStacks` |
| 服务格 | 服务地图上的一格。一格 = 一个模块 = 一个“服务：机能”，共 40 格。同一 AWS 服务对应两个模块时分成两格（例如 Cognito 的 User Pool 与 Identity Pool）。服务格的 id、缩写与类别由 05 的 `taxonomy.yaml` 定义 |
| 目标 | 学员在卡内亲手完成的切换：起始取值 → 目标取值（§1.4；`lab.yaml` 字段见 04 §3.2.4） |
| 起始状态（startProfile） | 点“开始实验”后平台自动部署的状态：Step Functions 部署 L0，再由 CodeBuild `atl-runner`（`ATL_OP=profile-apply`）应用构建期生成的档位 `atl/<card-id>/<variant>`（默认变体 `default`）。内容 = L0 + iam(role) + 目标硬依赖的闭包（§1.5，裁决 C3） |
| 背景模块（context） | 场景卡起始状态中不属于目标闭包、为了场景真实性或缩短等待而加入的模块，必须写理由（四类，§1.5） |
| 前驱取值 | 目标模块在起始状态中的非默认取值，例如 `sc-private-network` 中 network 先是 `public`（`lab.yaml` 写 `fromDriver`） |
| 预期警告 | 卡片声明的、设计上预期出现的 warn 级规则（`expectedWarnings`，04 §3.2.5）。只由它们导致的 `degraded` 视为正常 |
| 计入（credit） | 一张卡片的完成对某个服务格掌握度的贡献（§5.4） |
| 徽章 / 路径证书 | 完成卡片 / 完成路径的成果（§5） |

### 1.2 id 与命名

| 对象 | 规则 | 例子 |
|---|---|---|
| 单服务卡 id | `svc-<模块 id>`，模块 id 取自 `modules/registry.yaml`（40 个，含 ec2） | `svc-storage`、`svc-load-balancer` |
| 场景卡 id | `sc-<slug>`，slug 用 kebab-case，≤ 24 字符，描述场景而不是服务清单 | `sc-edge-protection` |
| id 正则 | `^(svc\|sc)-[a-z0-9]+(-[a-z0-9]+)*$`，前缀之后 ≤ 24 字符（不允许首尾或连续的 `-`）；旧的 `lab-NN` 只在迁移期保留（04 §3.6） | — |
| 目录 | `labs/<card-id>/`，内部结构见 04 §2.1 | `labs/sc-ha-web/lab.yaml` |
| 单服务卡标题 | `<AWS 服务全称>：<机能>`（`lab.yaml` 的 `service`、`function` 两字段拼成 `title`，04 §3.1）。机能取 README 对照表的“机能”列，也可以做 ≤ 12 字的口语化改写 | Amazon S3：照片对象存储 |
| 场景卡标题 | `<场景名>`（≤ 10 字）；副标题是 `<服务> + <服务> + …` | 边缘防护 / CloudFront + WAF |
| 标题长度 | ≤ 48 字（04 §3.1；服务全称不能缩写，例如 `AWS Systems Manager Parameter Store：运行时配置`） | AWS Systems Manager Session Manager：运维登录 |
| 徽章名 | ≤ 6 字的机能短语（`badge.title`） | “对象存储”“边缘防护” |
| 起始档位名 | `atl/<card-id>/<variant>`，默认变体 `default`，生成文件 `profiles/atl/<card-id>/<variant>.env`（名称以 01 §14 为准；02 §3.6、05 §8.5 同此）；起始变体是学员选择（`select: learner`）或预检选择（`select: preflight`）的另一种起始状态 | `atl/sc-ha-web/default`、`atl/sc-ha-web/efs`、`atl/svc-tls/acme-off` |
| 资源标签 | `atl:lab-id=<card-id>`（键不变），加上 `atl:session-id`、`atl:env-id`、`Project=CloudAlbum`；`scripts/module` 在平台模式下给模块栈另打 `atl:component=env`（裁决 C4(d)，06）；卡片自带栈另打 `atl:card-stack=<stack id>`（01 §3.9） | `atl:lab-id=sc-decoupling` |
| 路径 id | kebab-case，≤ 32 字符 | `saa-main`、`cost-optimized` |

### 1.3 两类卡片的区别

| 方面 | 单服务卡片 | 场景卡片 |
|---|---|---|
| 目标模块 | 恰好 1 个非选做目标（svc-ec2 为 0） | 1～5 个非选做目标（个别是同一模块的参数变更；只有 1 个模块目标时，必须另有经 `creditBy` 计入的服务，04 §3.5 第 22 条），可以带选做的“扩展”目标 |
| 起始状态 | L0 + iam(role) + 目标闭包（§1.5）；不允许背景模块 | L0 + iam(role) + 全部非选做目标的闭包 + 写明理由的背景模块 + 卡片自带的 `extraStacks`；可以有起始变体 |
| 对比实验 | 本模块 `experiments/<id>/` 中声明的实验变体（04 §3.2.10：`before`、`after` 之外还可以有 `l0`、`local`、`pgbouncer` 等） | 复用各目标模块的实验，强调组合后的现象 |
| 小测 | 本服务的概念题与易混题 | 场景题（给出约束，选架构），至少一半是 `kind: scenario` 的题 |
| 难度 | 初级～高级（入门只有 svc-ec2，判定见 05 目录总则） | 至少中级 |
| 简介页多一块 | — | “场景”：考题式描述、约束、常见的错误方案（`scenario`） |
| 徽章图形 | 服务缩写方块 | 六边形 + 场景短名 + 服务数圆点（§5.8） |

### 1.4 目标的写法：起始取值 → 目标取值

`lab.yaml` 的写法以 04 §3.2.4 为准（第 2 轮本文自拟的 `from` / `to` 已改为 04 的字段）：

```yaml
targetModules:
  # ① 目标模块不在起始状态（svc-storage）
  - { id: storage, driver: s3, wireStep: wire-s3 }
  # ② 目标模块以本地档出现在起始状态（svc-queue）
  - { id: queue, driver: sqs, fromDriver: memory, params: { MaxReceiveCount: 3 }, wireStep: wire-sqs }
  # ③ 目标模块以前驱取值出现在起始状态（sc-private-network）
  - { id: network, driver: private, fromDriver: public, set: { NETWORK_NAT_MODE: gateway, NETWORK_INTERFACE_ENDPOINTS: ops }, wireStep: go-private }
  # ④ 对起始状态中的模块改参数（sc-db-performance）
  - { id: database, driver: postgres, fromDriver: postgres, params: { CreateReadReplica: true }, wireStep: add-replica }
```

规则（04 DRV-5）：目标必须真的改变什么——`driver ≠ fromDriver`，或 `set` / `params` 中至少一项与起始状态不同；目标模块出现在起始状态时 `fromDriver` 必填且等于起始取值。这条取代 v1 lint 第 4 条“目标模块不得出现在起始状态中”。场景卡文档第 1 轮的 `reconfigure: true` 已删除（§3.3 C-2）。

**单服务卡的目标取值** = 该模块在 `profiles/single/<id>.env` 中的取值（gen-single 的默认档，总纲 §10.4）。注意 `single/<id>` 包含目标模块本身，所以它只能用来确定**目标取值**，不能当作起始状态（裁决 C3）。不显然的几项：

| 模块 | 目标取值 | 说明 |
|---|---|---|
| network | `public` | §10.4 把“network（public 放置）”列为可单独启用；private 是场景卡 |
| tls | `acm`（`TLS_ACME=on`） | 预检判定 ACME 端点不可用时用起始变体 `acme-off`（§1.5 规则 8） |
| social-api | `execute-api`，`Integration=proxy` | lambda 集成需要 social-store，归场景卡 sc-serverless-api |
| image-processing | `lambda`（`IMAGE_TRIGGER=eventbridge`，模块默认） | 本地档 worker 在卡内作对照；`buffer-queue` 触发方式只在 sc-decoupling 中使用 |
| tracing | `xray` | 本地档 local 在卡内作对照（实验变体 `local`） |
| db-proxy | `rds-proxy`，`DB_PROXY_AUTH=secrets` | 模块默认认证方式（DEP-032）；本机 PgBouncer 作为实验变体 `pgbouncer` |
| cache / database | ElastiCache / RDS | 本地档（memory、自建 Valkey、自建 PostgreSQL）在卡内作对照 |

### 1.5 startProfile 的计算规则

**通用规则**（主设计者裁决 C3；在 `lab.yaml` 中的落实见 04 §3.2.3，推导命令见 06，构建期核对见 04 §3.5 C 组）：

1. 起点是 `l0-ec2`。平台固定部分不计入闭包，但在简介页列出（`provisions[]` 中 `kind: platform` 的条目）：只挂 `AmazonSSMManagedInstanceCore` 的 `CloudAlbumAppRole`（平台管理通道，01 §6.6）、工作台、方案 B 的 Let's Encrypt IP 证书（若未关闭）、随发布包安装的检查包，以及运行器 `base-deploy` 创建的工具链栈（01 §3.4）。
2. **iam(role)**：除 `svc-ec2`（“没有任何 AWS 模块”的基线）与 `svc-iam`（目标就是 iam）外，每张卡片都预置 `iam`（`IAM_CREDENTIALS=role`；平台模式下 `AppRoleMode=existing`），`basis: credential`。目标模块是 `credentials: optional` 的卡片同样预置——第 1、2 轮“optional 模块不并入 iam”的写法与随之而来的 CRED-004 预期警告、“wire 步骤中由学员先执行 `enable iam`”的例外一并废止。
3. **闭包**：目标取值触发的全部 error 级条件，递归求解。来源包括 registry 的 `requires`，**也包括** rules.ts 中不写在 `requires` 里、但“启用某个模块即可满足”的条件（ASG-001～008、DEP-009 的复合条件等）。这需要 registry 提供机器可读的 `remedy`（06，P-4）。条目写 `basis: closure` 与成因规则 ID。
4. **不能直接用 `single/<id>`**：它包含目标模块本身（L0 + 该模块 + 依赖）。起始状态由 `scripts/module plan --start-of <card-id> [--variant <id>] --platform --json` 推导，构建期生成 `profiles/atl/<card-id>/<variant>.env`（05 §8.5），`labs:derive` 要求 `lab.yaml` 的 `startProfile.provisions` 与推导结果逐项相同（04 DRV-1、DRV-2）。
5. **任选分支**（`a | b`）：默认取 registry 中第一个能自动满足的分支（gen-single 规则 1）。卡片可以改选，写在 `startProfile.branches` 并给理由（04 DRV-8）。
6. **本地档调整**（gen-single 规则 3）：只有为了让对比有意义、或为了满足规则（如 DEP-004）时才加，写成 `kind: local` 的条目，不部署 AWS 资源、不写 `MODULE_<ID>=on`。单服务卡的这类调整要能由 registry 推导（`singleLocalSettings`，06，§7.6）。运行时热键（例如 `featureFlags.lab.faults`）写成 `kind: runtime`；测试数据种子（例如已确认的 Cognito 测试用户、带 GPS 信息的示例照片）写成 `kind: seed`，由 06 的种子登记表定义，运行器在 `profile-apply` 之后执行，不参与推导。
7. **人工前置**（域名、SES 发件身份、确认订阅、成本分配标签）不预置，写进 `prerequisites.learnerInputs`（取值集合见 05 §1.2）。
8. **部署前探测决定的分支**（目前只有 tls 的 `TLS_ACME`）：写成 `startProfile.variants[]` 中 `select: preflight` 的起始变体，由 02 的账号预检选择（04 §3.2.3）。

**场景卡另有三条**：

9. 起始状态 ⊇ 全部非选做目标在目标取值下的闭包 − 目标本身；前驱取值保留（例如 network 的 `public`）。多出的模块都是**背景模块**（`basis: context`），理由只允许四类（`contextKind`）：**提供受信 HTTPS 入口**（`https-entry`）、**提供被保护或被分析的数据**（`protected-data`）、**把慢资源移到开始阶段以缩短卡内等待**（`shorten-wait`）、**场景真实性**（`realism`）。第 2 轮的第五类 `control-plane`（只为让 optional 模块的控制面可用而加 iam）随规则 2 废止。背景模块自身的闭包随它一起视为合法；闭包内模块的非默认参数（例如 sc-ha-web 的 `database.MultiAz=true`）同样按参数写理由（04 DRV-4）。
10. 卡内启用目标的顺序 = `plan` 给出的拓扑序（含 registry 的 `orderBefore`），手册步骤顺序必须与之一致（04 DRV-7）。同一模块需要两段取值才能解开依赖环时（sc-static-acceleration 的 dns：先 `eip`、后 `cloudfront`），`plan` 要支持按手册顺序给出同一模块的两段取值（06，P-4）。
11. **起始变体**：模块集合不同的两种做法（目前只有 sc-ha-web 的 S3 / EFS）写成 `startProfile.variants[]` 中 `select: learner` 的变体，属于同一张卡、同一个徽章，开始前由学员选择。选做目标（扩展）不计入闭包，也不计入预计时长；它的依赖必须已经在起始状态或必做目标中。
12. **卡片自带栈**（`extraStacks`，格式见 04 §3.2.15 与 scenario-cards.md §2.4）：只用于模块设计不覆盖、但用户指定的服务组合必须亲手做的资源（目前是 sc-backup-dr 的 S3 跨区域复制目标桶、复制角色、灾备维护站点、选做的 RDS 跨区域只读副本，sc-cost-optimization 的 Spot / Graviton 基准机群）。它们不是模块、不进 `modules.d`、应用不读取；由 `atl-runner` 部署；计入费用档位与部署等级；回收顺序写在 `reclaim.phase`。每个 extraStack 必须被至少一个步骤使用，且不能替代某个已有模块（04 §3.5 第 20 条）。

**平台段**（`startProfile.platform`，不属于模块闭包）：`preview.directHttps`（方案 B 开关）。方案 B 会写入 `TLS_MODE=letsencrypt`，所以起始或目标含 autoscaling 的卡片（ASG-014 不可覆盖）与含 tls 的卡片必须为 `off`（04 §3.5 第 6 条，裁决 C5）；切换为 private 放置后实例没有公网 IPv4、IP 证书无法续期，sc-private-network 也为 `off`。目前为 `off` 的卡片：svc-autoscaling、svc-tls、sc-ha-web、sc-static-acceleration、sc-private-network（03 §6.2、05 §4）。

**SSH 基线**不在起始状态中写占位符，而是由 `workstation.sshFromWorkstation: true` 驱动：运行器按 03 §4.8 的规则取工作台私网 /32（实验机与工作台同在默认 VPC 时）或公网出口 /32（实验机已迁入自定义 VPC 时，sc-private-network）。需要在参数中引用工作台地址时，使用 04 §3.2.3 的占位符 `${atl:workstationPrivateCidr}` 或 `${atl:workstationPublicCidr}`；第 1 轮的 `${atl:workstationCidr}` 含义有歧义，已废止（§3.3 C-13）。

### 1.6 难度、时长、费用档位、部署等级

这四项的判定规则是**目录总则**，权威定义在 05 §3（裁决 C2 的分工）。本节只保留部署等级判定的摘要，使 02 §11、04 §3.2.7 中“按 tracks-and-catalog §1.6 推导”的引用仍然可达；与 05 不一致时以 05 为准。

- **难度**四级，id 用 `intro | beginner | intermediate | advanced`（入门 / 初级 / 中级 / 高级）；入门只用于不启用任何 AWS 模块的卡片（只有 svc-ec2）；场景卡至少为中级。
- **时长**：`estimatedMinutes` 取 15 分钟的整数倍，不含环境准备；`timeLimitMinutes` ≥ 预计时长 × 1.5，取 30 分钟的整数倍。
- **费用档位**按计费结构：起始状态、`extraStacks` 与目标中“基础之外的按小时计费单位”= 0 且没有账号级按量服务为**低**，恰好 1 个单位或含账号级按量服务（GuardDuty、Config、Inspector）为**中**，≥ 2 个单位为**高**。起始状态中的模块计入单位；卡内临时创建的 EC2 也各计 1 个单位。选做步骤抬高档位时写成“低（选做 → 中）”。iam 不计费，C3 预置 iam 不改变任何卡片的费用档位。
- **部署等级**（02 §11.1 的 A～D）由起始状态推导：只有快资源为 A；含 CloudFront、ALB、实例替换、Cognito 用户池（托管登录或迁移）等“中/慢”资源中的一两个为 B；含 RDS 或 ElastiCache 之一为 C；RDS / ElastiCache 再叠加 ALB、另一个 RDS / ElastiCache 或实例替换为 D。卡内创建的慢资源不影响等级，只影响时长与回收预算（`provision.cleanupBudgetMinutes`，04 §3.2.7）。iam 是快资源，C3 预置 iam 不改变部署等级。

---

## 2. 单服务卡片：分支选择与特殊情况

### 2.1 总表（已移至 05）

40 张单服务卡片的标题、目标、起始状态、难度、时长、费用档位、部署等级、领域与人工前置，以 **05 §4 的元数据汇总表**为准（裁决 C2）。本文第 2 轮的总表已删除，避免目录与卡片出现第三份取值。按裁决 C3，第 2 轮表中“凭证可选、不并入 iam”的 16 张卡片（network、cdn、dns、tls、waf、load-balancer、shared-fs、database、cache、backup、social-api、audit、threat-detection、compliance、cost、ami）的起始状态都增加了 `iam(role)`；iam 是快资源、不计费，这些卡片的部署等级与费用档位不变。

### 2.2 分支选择与特殊情况

下表是 `plan --start-of` 推导时需要卡片显式声明（`startProfile.branches`）或需要读者注意的情况；取值以 05 §4 与逐卡文档为准。

| 卡片 | 依据 | 选择与理由 |
|---|---|---|
| svc-waf | DEP-006：`WAF_MODE=aws` 需要 cdn 或 load-balancer | **选 cdn**。① 它是 registry 中 `cdn \| load-balancer` 的第一个分支（gen-single 规则 1）；② CLOUDFRONT 范围的 Web ACL 正是“边缘防护”的考试形态；③ 不引入按小时计费的 ALB，费用档位保持“低”。代价：起始状态含 CloudFront 分配，部署等级为 B；Web ACL 必须建在 us-east-1（`regions.alsoUses`） |
| svc-autoscaling | DEP-007（iam role、load-balancer）；ASG-001（storage 或 shared-fs）；ASG-002、003（RDS） | storage 与 shared-fs 二选一时**选 storage**：S3 不占用 VPC 挂载目标、与 `l8-ha` 一致；EFS 归 sc-ha-web 的 `efs` 变体。ASG-007、008 靠 `SECRETS_ORIGIN=bundle` 满足，不加 secrets 模块；`bundle` 是 autoscaling **启用时**写入的取值（引导配置包由 autoscaling 栈创建），**不能**放进起始状态。方案 B 关闭（ASG-014）；部署等级 D（RDS + ALB，与 02 §11.2 一致）；`expectedWarnings: [ASG-009, ASG-010, ASG-011, ASG-012, ASG-013]`（04 §3.2.5） |
| svc-tls | DEP-005：`TLS_ACME=on` 时只需域名；`off` 时需要 {dns 或外部 DNS, cdn 或 load-balancer} | 默认起始状态 = L0 + iam；预检型起始变体 `acme-off` = L0 + iam + cdn（05 §4.5 D-15）。“外部 DNS”是 dns 模块开关的本地取值 `DNS_PROVIDER=external`，由卡内第 2 步写入：DEP-005 ③ 只在启用 tls 时检查，`plan --start-of` 不会把它放进起始状态（第 2 轮本文把它写进回退档，已按 05 更正）。两者都关闭方案 B，因为本卡要从自签名讲起 |
| svc-identity-pool | DEP-002：auth=cognito，或 auth=local + 开发者认证身份 | **选 cognito**（`COGNITO_LOGIN_MODE=sdk`，不触发 DEP-029）：开发者认证身份需要额外的服务端代码路径，且不是考试主流形态。部署等级 B；`APP_BASE_URL` 仍为 http 时 DEP-030 写进 `expectedWarnings` |
| svc-db-proxy | DEP-032（默认 `DB_PROXY_AUTH=secrets`）或 DEP-036（IAM 变体） | **选 secrets**：模块默认值；IAM 端到端认证变体在卡内作为选读。secrets 先于 database 启用（registry `secrets.orderBefore: [database]`，06） |
| svc-queue、svc-workflow、svc-tracing | DEP-004：`IMAGE_PROCESSOR=worker` 要求 `QUEUE_DRIVER≠sync` | 起始状态加本地档 worker + memory：没有它们就看不到“任务交给后台”的基线（svc-tracing 另加自建 PostgreSQL，让本地 span 跨进程、跨数据库） |
| svc-cache、svc-db-proxy | gen-single 规则 3 | 本地档 `LB_LOCAL_WORKERS=2`：陈旧读与连接风暴需要多个 api 进程（单机多进程的唯一机制），不产生 AWS 资源 |
| svc-image-processing | DEP-020、021：callback 通道会被 cdn 挡住，或走明文 | 目标固定 `IMAGE_RESULT_CHANNEL=queue` |
| svc-shell-access | P7：平台管理通道始终是 SSM | 基线改为“只对工作台开放的 SSH”：`workstation.sshFromWorkstation: true`，运行器按 03 §4.8 取工作台私网 /32；见 P-10 |
| svc-network | §1.4：单服务卡目标取 `single/network` 的 public | 起始 L0 + iam；卡内经历“默认 VPC → 分层自定义 VPC”的实例替换与密钥指纹核对（labs.md Lab 14） |
| 原“凭证可选”的 16 张 | 裁决 C3 | 一律预置 `iam(role)`，`basis: credential`；原先写进 `acceptedWarnings` 的 CRED-004 删除；原先“wire 步骤中由学员先执行 `enable iam`”的例外（svc-compliance、svc-threat-detection）删除 |

### 2.3 与第 1～3 批卡片文档的差异

- **svc-network**：第 1 批把目标定为 `public → private`，起始状态预置 `network(public) + load-balancer`。这违反严格闭包，也让原 Lab 14 的“默认 VPC → 自定义 VPC 迁移”没有任何卡片承载。本模型把 svc-network 定为 public，private 由 sc-private-network 承担（P-1，§3.3 C-12）。第 1 批 svc-network 的 private 部分（EIC Endpoint 运维通道、NAT、`endpoint-only`）可以移进 sc-private-network 的选做步骤。是否已在 service-cards-1 中改写，以该文件为准。
- **字段写法**：三批文档第 2 轮各自扩展了 `lab.yaml`（`modules{primary, preset}`、`startProfile.items/derive/runtime`、`badge{id, awardOn, requireQuiz}`、`acceptedWarnings`、`experiment.variant` 等）。第 3 轮统一以 04 §3（`atl.lab/v2`）为准，对照见 §7.2 与 04 §14 K-1～K-8。第 3 批（service-cards-3）已在本轮改写；第 1、2 批由其负责流程改写。

---

## 3. 场景卡片：计入规则与裁决

### 3.1 总表（已移至 05）

16 张场景卡片的标题、服务组合、目标顺序、起始状态、难度、时长、费用档位、部署等级与领域，以 **05 §4 的元数据汇总表**为准；步骤、检查、小测与场景题见 [scenario-cards.md](scenario-cards.md)。本文第 2 轮的总表（§3.1）与逐卡要点（§3.2）已删除：它们与 scenario-cards.md、05 构成三份取值，第 2 轮审稿已因此出现 12 处不一致（P-18）。本节只保留属于掌握度模型的内容——每张场景卡对服务格的计入（§3.2）——以及本文规则与逐卡文档的裁决（§3.3）。

### 3.2 场景卡对服务格的计入

“计入”的规则见 §5.4：目标模块的服务格经该目标的 wire 步骤计入；其他服务格只有在 `services[].creditBy` 声明了学员亲手完成的步骤时才计入，且这些步骤必须有针对该服务、不只描述起始状态的自动检查（04 §3.5 第 24 条）。步骤名以 scenario-cards.md 为准。

| 场景卡 | 经目标计入 | 经 `creditBy` 计入（步骤） | 条件计入 | 出现但不计入 |
|---|---|---|---|---|
| sc-static-acceleration | cloudfront | s3（以 OAC 接入媒体桶、证明桶仍私有） | 有域名时 acm、route53 | ec2 |
| sc-edge-protection | cloudfront、waf | — | 选做通过时 guardduty | iam（起始） |
| sc-image-pipeline | lambda、rekognition | — | 扩展通过时 stepfunctions | s3、iam（起始）；eventbridge、sqs（附属） |
| sc-decoupling | sqs、lambda | ec2（kill-worker 演练：EC2 worker 作为可替换的消费者） | — | s3、iam（起始） |
| sc-event-fanout | sns、ses | — | — | sqs（模块自带队列） |
| sc-user-identity | cognito-user-pool、cognito-identity-pool、apigateway | s3（越权前缀测试） | — | cloudfront（背景，`https-entry`） |
| sc-serverless-api | dynamodb、apigateway | — | 选做通过时 sqs | lambda 格（代表 image-processing 的缩略图机能） |
| sc-ha-web | elb、autoscaling | rds（故障转移演练）；efs 变体另计 efs（跨实例读写） | 扩展通过时 imagebuilder | s3（起始，default 变体） |
| sc-db-performance | rds（只读副本参数变更）、elasticache、rds-proxy | — | — | secretsmanager（起始闭包） |
| sc-private-network | vpc、ssm-session-manager | — | — | elb（起始闭包） |
| sc-security-baseline | kms、secretsmanager、cloudtrail、config | — | 选做的“长期密钥反面教材”通过时 iam（§3.3 C-14） | iam 的 role 状态本身（起始，C3） |
| sc-observability | cloudwatch-logs、cloudwatch、xray | — | — | s3、sqs（背景，`realism`） |
| sc-backup-dr | backup | s3（原图桶跨区域复制规则） | 有域名时 route53 | rds、dynamodb（背景，`protected-data`） |
| sc-analytics | firehose | s3（数据湖分区布局与生命周期：Firehose 前缀、事件桶生命周期规则） | — | athena、glue（附属服务） |
| sc-cost-optimization | budgets | s3（新增 Intelligent-Tiering 生命周期规则）、ec2（换 Graviton 与 Spot 基准） | — | autoscaling（只在 extraStack 中） |
| sc-threat-compliance | cloudtrail、guardduty、inspector、config | — | — | — |

没有场景卡计入的服务格：ssm-parameter-store（svc-config）、scheduler（svc-scheduler）；iam 只能经 sc-security-baseline 的选做步骤计入；route53、acm 只在有域名时由场景卡计入（P-7）。

### 3.3 与逐卡文档的差异与裁决

第 2 轮列出的裁决 C-1～C-13 在第 3 轮的处理状态如下；C-14 是本轮因裁决 C3 新增的。

| # | 涉及 | 裁决 | 第 3 轮状态 |
|---|---|---|---|
| C-1 | 三批单服务卡、scenario-cards 的 `schema`、`modules`、`badge` 写法 | 字段以 04 §3（`atl.lab/v2`）为准 | 04 已定稿；service-cards-3 与 scenario-cards 已按 04 改写；第 1、2 批由其负责流程改写 |
| C-2 | scenario-cards `targetModules[].reconfigure` | 删除，用 `fromDriver` 表达“起始状态中已有该模块”（04 DRV-5） | scenario-cards 已改写 |
| C-3 | scenario-cards 中为控制面观察点而加入的 iam | 第 2 轮要求写成背景模块 `control-plane` | **作废**：裁决 C3 后 iam 一律以 `basis: credential` 预置，背景模块不再有 `control-plane` 一类 |
| C-4 | sc-threat-compliance “紧接 sc-security-baseline 时 wire 检查直接通过” | 不允许：目标在环境中已经等于目标取值时，卡片不能在该环境开始（04 §8.11、02 §8.4） | scenario-cards 已删除该说法 |
| C-5 | sc-event-fanout 难度 | 中级（场景卡至少中级） | scenario-cards 已改 |
| C-6 | sc-analytics 的 parquet | 必做（否则与 svc-analytics 的模块集合、目标完全相同，P-6） | scenario-cards 已改；时长 90 / 150 待实测 |
| C-7 | capability 判定 | 用 04 §5.3 的 `op: healthy` 与 `expectedWarnings`：`degraded` 只由本卡声明的预期警告导致时视为正常（裁决 C3） | 04 已定稿；service-cards-3、scenario-cards 已改；第 2 批由其负责流程改写 |
| C-8 | sc-cost-optimization、sc-backup-dr 学员写在模块管理的原图桶上的规则 | 采纳，`acceptedDrift: [storage.RawBucket.LifecycleConfiguration]`、`[storage.RawBucket.ReplicationConfiguration]`（04 §5.8 的格式） | 04 已收录；scenario-cards 已写入 |
| C-9 | sc-private-network 方案 B | 关闭 | scenario-cards 已改 |
| C-10 | 生成档位名 | `atl/<card-id>/<variant>`，默认变体 `default`，文件 `profiles/atl/<card-id>/<variant>.env`（01 §14 名称表；02 §3.6、05 §4.5 D-13 同此） | 本文、scenario-cards、service-cards-3 已改；04 §3.2.3 与 K-3 写默认档位 `atl/<card-id>`（不带变体名），需与 01 对齐（§8.7 第 1 条） |
| C-11 | sc-ha-web 的 EFS 做法 | 用 `startProfile.variants[]`（`select: learner`），同一张卡、同一个徽章 | 04 已收录；scenario-cards 已改 |
| C-12 | 第 1 批 svc-network | 目标 `default → public`，private 归 sc-private-network | 由 service-cards-1 的负责流程处理 |
| C-13 | `${atl:workstationCidr}` 的两种含义 | 拆为 `${atl:workstationPrivateCidr}`、`${atl:workstationPublicCidr}`（04 §3.2.3）；SSH 基线由 `workstation.sshFromWorkstation` 驱动，按 03 §4.8 自动取私网或公网出口地址 | 04、03 已定稿；scenario-cards、service-cards-3 已改 |
| C-14（新） | sc-security-baseline 的 iam 目标（none → role） | 裁决 C3 只给 svc-ec2、svc-iam 例外，本卡起始状态预置 iam，iam 不再是目标；“没有凭证 vs 实例角色”的对比留给 svc-iam，本卡改为可选的“长期密钥 vs 临时凭证”反面教材（平台动作切到 keys 模式再切回），选做通过时计入 iam | scenario-cards 已改。**与 05 §4.5 D-8 不一致**：05 选择“本卡不预置 iam、iam 仍是第一个目标”（与 svc-iam 同理），并标为“需主设计者确认”；本文按 C3 的字面（例外只有 svc-ec2、svc-iam）处理。主设计者二选一后，05 §3.5、§4.3 与 scenario-cards §3.11 同步；若选 05 的做法，还需修改 04 §3.5 第 5 条 **第 4 轮**：05 §3.5、§4.3、§4.5 D-8 已按 C3 字面改为预置 iam，分歧消除。 |

---

## 4. 学习路径（Track）

### 4.1 路径一览

“必修时长”= 必修卡片 + 每个选修组取用时最短的卡片；“全部时长”= 路径内全部卡片。都不含环境准备。所有证书都写明“由自托管平台签发，不是 AWS 官方认证”（04 §10.1）。

| id | 名称 | 适合谁 | 最少完成卡片数 / 路径内卡片数 | 必修时长 | 全部时长 | 证书 |
|---|---|---|---|---|---|---|
| `saa-main` | SAA 主线 | 备考 SAA-C03，按原 Lab 0～25 的顺序系统学习 | 40 / 56 | 约 52 小时（3105 分钟） | 约 80 小时（4785 分钟） | SAA 主线结业证书 |
| `secure` | 安全专项 | 补强“设计安全的架构”领域 | 12 / 19 | 约 16 小时（975） | 约 26 小时（1575） | 安全架构专项证书 |
| `resilient` | 弹性专项 | 补强“设计弹性的架构”领域 | 10 / 16 | 约 15 小时（900） | 约 25 小时（1485） | 弹性架构专项证书 |
| `performant` | 高性能专项 | 补强“设计高性能的架构”领域 | 10 / 16 | 约 15 小时（885） | 约 23.5 小时（1410） | 高性能架构专项证书 |
| `cost-optimized` | 成本优化专项 | 补强“设计成本优化的架构”领域 | 8 / 13 | 约 10 小时（600） | 约 18 小时（1095） | 成本优化专项证书 |
| `quick-compare` | 点名对比快速路径 | 只想看 Cognito、SQS、CloudFront、Lambda、ElastiCache、S3、RDS 七组“有 vs 没有” | 7 / 8 | 约 10 小时（585） | 约 11 小时（645） | 七项点名对比证书 |
| `serverless` | Serverless 应用 | 想系统掌握事件驱动与无服务器 | 9 / 14 | 约 11.5 小时（690） | 约 18 小时（1065） | Serverless 应用路径证书 |
| `networking` | 网络与边缘 | 网络隔离、入口与边缘防护 | 6 / 9 | 约 9 小时（525） | 约 13 小时（765） | 网络与边缘路径证书 |
| `operations` | 运维与可观测 | 运维登录、日志指标追踪、审计、镜像与备份 | 8 / 12 | 约 10 小时（615） | 约 17 小时（1020） | 运维与可观测路径证书 |

时长按 05 §4 汇总表中的卡片时长计算（括号内为分钟）；构建期由 `labs:catalog` 生成的 `catalog.yaml` 计算，本表只是摘要，不一致时以生成结果为准。第 3 轮的裁决 C3 只给部分卡片的起始状态增加了 iam，没有改变卡片时长；svc-ami 的预计时长按 05 §4（service-cards-3）更正为 135 分钟（第 2 轮本文用了 120，05 §4.5 D-3），saa-main、resilient、operations 的全部时长随之各加 15 分钟，必修时长不变（svc-ami 在这三条路径中是可选或选修组中较长的一张）。

### 4.2 saa-main：SAA 主线

#### 4.2.1 原 Lab 编号 → 卡片

原 Lab 0～25 与扩展 Lab 到卡片 id 的映射以 **05 §5** 为准（裁决 C2）；`labs/_tracks/saa-main.yaml` 各条目的 `legacyLab` 由该映射生成，本文不再保留第二份映射表。与路径编排有关的三点在这里说明：

- **Lab 0 的“第二部分：本地档”**不单独成卡，拆进各单服务卡的 before 基线与实验变体：svc-cache（memory、自建 Valkey）、svc-queue（memory）、svc-database（自建 PostgreSQL）、svc-db-proxy（变体 `pgbouncer`）、svc-tracing（变体 `local`）、svc-load-balancer（本机多进程）。
- **Lab 1 的成本分配标签**不在 svc-cost 卡内激活：它是平台动作 `cost-activate-tags`（01 registry `platformActions` 的 `activateCostAllocationTags`），标签出现在可激活列表约需 24 小时、激活生效约再需 24 小时（以官方文档为准）。路径页在学员开始 `saa-main`、`cost-optimized` 时提示执行；svc-cost 与最后的 sc-cost-optimization 都依赖它，学员前置输入 `cost-tags-active` 记录是否已激活。
- **Lab 20（私有化）**是场景卡 sc-private-network：private 放置需要入口、出网、运维通道同时具备。

#### 4.2.2 阶段与卡片顺序

标记：● 必修；◇ 选修组（选 1 张）；○ 可选（可跳过，不计入完成条件）。时长为分钟。

| 阶段 | 原 Lab | 卡片（推荐顺序） | 必修时长 |
|---|---|---|---|
| 1 基线与运维 | 0～3 | ● svc-ec2 60 → ● svc-iam 60 → ● svc-cost 45 → ● svc-shell-access 60 → ● svc-logging 45 → ● svc-monitoring 75 | 345 |
| 2 存储与边缘 | 4～7 | ● svc-storage 60 → ● svc-cdn 75 → ○ svc-dns 60 → ○ svc-tls 75 → ● svc-waf 90 → ◇ sc-edge-protection 90 / sc-static-acceleration 105 | 315 |
| 3 身份与消息 | 8～9 | ● svc-auth 90 → ● svc-identity-pool 90 → ● svc-notification 60 → ● svc-email 60 → ◇ sc-user-identity 120 / sc-event-fanout 75 | 375 |
| 4 异步与事件 | 10～12 | ● svc-queue 60 → ● svc-image-processing 90 → ● svc-tagging 45 → ○ svc-workflow 75 → ● svc-scheduler 75 → ◇ sc-decoupling 90 / sc-image-pipeline 105 | 360 |
| 5 数据保护 | 13 | ● svc-kms 75 → ● svc-secrets 60 → ● svc-config 45 | 180 |
| 6 网络与数据 | 14～16、18 | ● svc-network 90 → ● svc-database 120 → ○ svc-db-proxy 90 → ● svc-cache 90 → ● svc-analytics 75 → ◇ sc-db-performance 150 / sc-analytics 90 | 465 |
| 7 Serverless | 17 | ● svc-social-store 60 → ● svc-social-api 60 → ● sc-serverless-api 90 | 210 |
| 8 高可用与私有化 | 19～21 | ● svc-load-balancer 60 → ● sc-private-network 120 → ● svc-autoscaling 120 → ○ sc-ha-web 150（推荐）→ ○ svc-shared-fs 75 → ○ svc-ami 135 | 300 |
| 9 可观测、审计与恢复 | 22～25 | ● svc-tracing 75 → ● svc-audit 75 → ● svc-threat-detection 45 → ● svc-backup 120 → ○ svc-compliance 75 → ○ svc-vuln-scan 75 → ◇ sc-observability 120 / sc-security-baseline 120 / sc-threat-compliance 120 / sc-backup-dr 150 | 435 |
| 10 结业 | — | ● sc-cost-optimization 120 | 120 |

必修 35 张 + 5 个选修组，最少完成 40 张，约 3105 分钟（约 52 小时）；路径内全部 56 张约 4785 分钟（约 80 小时）。

**推荐顺序与可跳过**：
- 阶段之间建议按顺序；阶段内的必修卡片可以任意顺序，因为每张卡片都从自己的起始状态开始，不依赖前一张卡片留下的环境。
- 可以跳过：svc-dns、svc-tls（需要域名）；svc-workflow、svc-db-proxy、svc-shared-fs、svc-ami（原 Lab 的扩展或变体）；svc-compliance、svc-vuln-scan（原 Lab 25 本就可选）；sc-ha-web（与 svc-autoscaling 重叠、费用高，但最接近考试的高可用题）。
- 阶段 6、8 与阶段 9 的 sc-backup-dr 含按小时计费的资源，建议一张卡片做完立即结束，不要保留环境过夜。
- 开始本路径前（或至少在 svc-cost 前一到两天）执行平台动作 `cost-activate-tags`；新账号要先有一次带 `Project=CloudAlbum` 标签的会话（例如 svc-ec2），标签才会出现在可激活列表中。
- 证书条件：必修全部、每组 1 张，徽章全部有效，“已核验”徽章占比 ≥ 0.7（§5.5）。主线放宽到 0.7，是因为它包含原生手动检查较多的邮件、订阅类卡片。

### 4.3 四条考试领域专项路径

考试领域的权重以官方 SAA-C03 考试指南为准。专项路径的证书条件：必修全部、每组 1 张、“已核验”徽章占比 ≥ 0.8。

**secure：安全专项**（证书：安全架构专项证书）

| 顺序 | 卡片 | 角色 | 分钟 |
|---|---|---|---|
| 1 | svc-iam | ● | 60 |
| 2 | svc-shell-access | ● | 60 |
| 3 | svc-kms | ● | 75 |
| 4 | svc-secrets | ● | 60 |
| 5 | svc-audit | ● | 75 |
| 6 | sc-security-baseline | ● | 120 |
| 7 | svc-auth | ● | 90 |
| 8 | ◇ 身份：svc-identity-pool / sc-user-identity | ◇ | 90 / 120 |
| 9 | svc-waf | ● | 90 |
| 10 | ◇ 网络：svc-network / sc-private-network | ◇ | 90 / 120 |
| 11 | ◇ 检测：svc-threat-detection / svc-compliance / svc-vuln-scan | ◇ | 45 / 75 / 75 |
| 12 | sc-threat-compliance | ● | 120 |
| — | 可选：svc-config、svc-tls（需要域名）、sc-edge-protection | ○ | 45、75、90 |

推荐顺序是“身份与凭证 → 数据保护 → 审计 → 用户身份 → 边界防护 → 检测”。sc-security-baseline 包含了 kms、secrets、audit、compliance 的启用（iam 按裁决 C3 已在起始状态中），已完成前面单服务卡的学员会觉得前半段较快，这是有意的复习；“没有凭证 → 实例角色”的对比只在 svc-iam 中做。

**resilient：弹性专项**（证书：弹性架构专项证书）

| 顺序 | 卡片 | 角色 | 分钟 |
|---|---|---|---|
| 1 | svc-ec2（单点与可替换的实例） | ● | 60 |
| 2 | svc-queue | ● | 60 |
| 3 | ◇ 消息：svc-notification / sc-event-fanout | ◇ | 60 / 75 |
| 4 | sc-decoupling | ● | 90 |
| 5 | svc-load-balancer | ● | 60 |
| 6 | svc-database | ● | 120 |
| 7 | svc-autoscaling | ● | 120 |
| 8 | sc-ha-web | ● | 150 |
| 9 | svc-backup | ● | 120 |
| 10 | ◇ 灾备：sc-backup-dr / svc-dns（故障转移，需要域名） | ◇ | 150 / 60 |
| — | 可选：svc-monitoring、svc-shared-fs、svc-workflow、svc-ami | ○ | 75、75、75、135 |

费用提示：第 6～8 张与 sc-backup-dr 含 RDS、ALB 与多台实例，是本路径的费用高点。

**performant：高性能专项**（证书：高性能架构专项证书）

| 顺序 | 卡片 | 角色 | 分钟 |
|---|---|---|---|
| 1 | svc-storage | ● | 60 |
| 2 | svc-cdn | ● | 75 |
| 3 | svc-image-processing | ● | 90 |
| 4 | sc-image-pipeline | ● | 105 |
| 5 | svc-social-store | ● | 60 |
| 6 | ◇ API：svc-social-api / sc-serverless-api | ◇ | 60 / 90 |
| 7 | svc-cache | ● | 90 |
| 8 | svc-database | ● | 120 |
| 9 | sc-db-performance | ● | 150 |
| 10 | ◇ 分析：svc-analytics / sc-analytics | ◇ | 75 / 90 |
| — | 可选：sc-static-acceleration、svc-db-proxy、svc-tracing、svc-shared-fs | ○ | 105、90、75、75 |

**cost-optimized：成本优化专项**（证书：成本优化专项证书）

| 顺序 | 卡片 | 角色 | 分钟 |
|---|---|---|---|
| 1 | svc-cost（平台动作 `cost-activate-tags` 需在本卡前一到两天执行） | ● | 45 |
| 2 | svc-ec2（Graviton、突发积分、公网 IPv4 计费） | ● | 60 |
| 3 | svc-storage（存储类别与生命周期） | ● | 60 |
| 4 | svc-image-processing（按调用计费 vs 常开实例） | ● | 90 |
| 5 | svc-social-store（按需容量） | ● | 60 |
| 6 | ◇ 网络费用：svc-network（网关终端节点免费）/ sc-private-network（NAT vs 接口终端节点） | ◇ | 90 / 120 |
| 7 | ◇ 数据费用：svc-cdn（减少源站出网）/ svc-analytics / sc-analytics（扫描量） | ◇ | 75 / 75 / 90 |
| 8 | sc-cost-optimization（Graviton 与 Spot 在本卡亲手做） | ● | 120 |
| — | 可选：svc-autoscaling（混合实例策略，费用高）、svc-db-proxy | ○ | 120、90 |

本路径刻意优先选择费用档位为“低”的卡片；sc-cost-optimization 为“中（选做 → 高）”（一台临时 Spot 实例），sc-private-network 与 svc-autoscaling 为“高”，只作为选修或可选。

### 4.4 quick-compare：点名对比快速路径

对应原档位 `x-named-comparisons`。证书：七项点名对比证书。

| 顺序 | 卡片 | 对比的服务 | 角色 | 分钟 | 费用 |
|---|---|---|---|---|---|
| 0 | svc-ec2 | L0 本身 | ○（熟悉 L0 可跳过） | 60 | 低 |
| 1 | svc-storage | S3 | ● | 60 | 低 |
| 2 | svc-cdn | CloudFront | ● | 75 | 低 |
| 3 | svc-queue | SQS | ● | 60 | 低 |
| 4 | svc-image-processing | Lambda | ● | 90 | 低 |
| 5 | svc-auth | Cognito | ● | 90 | 低 |
| 6 | svc-cache | ElastiCache | ● | 90 | 中 |
| 7 | svc-database | RDS | ● | 120 | 高 |

- 顺序按费用从低到高排列，最后两张连续做、做完立即结束。
- 与原档位的区别：`x-named-comparisons` 是在一个累加环境里依次开启；卡片模型中每张卡片都从自己的起始状态开始，“没有它”的基线更干净。想节省部署时间可以用 02 §8.4 的环境复用，但只在目录标出的 `reuseFrom` 组合中使用（05 §8.6），例如 svc-storage → svc-image-processing。
- 证书条件：7 张必修，“已核验”徽章占比 ≥ 0.8。

### 4.5 新增的三条路径

**serverless：Serverless 应用**（证书：Serverless 应用路径证书）

● svc-storage 60 → ● svc-image-processing 90 → ● svc-queue 60 → ● sc-image-pipeline 105 → ● sc-decoupling 90 → ● svc-social-store 60 → ● svc-social-api 60 → ● sc-serverless-api 90 → ◇ 编排：svc-workflow 75 / svc-scheduler 75。可选：svc-notification 60、sc-event-fanout 75、sc-user-identity 120、svc-tagging 45。

价值：把分散在原 Lab 4、10、11、12、17 中的无服务器内容连成一条线，覆盖 SAA 常考的“事件驱动、按请求付费、托管扩展”。

**networking：网络与边缘**（证书：网络与边缘路径证书）

● svc-network 90 → ● svc-load-balancer 60 → ● sc-private-network 120 → ● svc-cdn 75 → ● svc-waf 90 → ● sc-edge-protection 90。可选（需要域名或部分需要域名）：svc-dns 60、svc-tls 75、sc-static-acceleration 105。

价值：VPC、子网、路由、NAT、终端节点、ALB、CloudFront、WAF 是 SAA 网络题的主体；需要域名的内容全部放在可选，没有域名也能拿到证书。sc-edge-protection 与 svc-waf 有一半内容重叠（Web ACL 关联、误杀调优），前者从 L0 出发多了“建分配 + 锁源站”，二者都保留为必修是有意的复习。

**operations：运维与可观测**（证书：运维与可观测路径证书）

● svc-shell-access 60 → ● svc-logging 45 → ● svc-monitoring 75 → ● svc-tracing 75 → ● sc-observability 120 → ● svc-config 45 → ● svc-audit 75 → ◇ 运维弹性：svc-backup 120 / svc-ami 135。可选：svc-scheduler 75、svc-compliance 75、sc-threat-compliance 120。

价值：把 Systems Manager、CloudWatch、X-Ray、CloudTrail、Image Builder、Backup 串成“日常运维”视角，费用全部为“低”或“中”。

### 4.6 路径的通用规则

1. **进度跨路径共享**：卡片的完成只记一次（`LabProgress`），在包含它的每条路径中都计入。
2. **不需要报名**：所有路径的进度随时可算。学员可以把一条路径设为“当前路径”（`Learner.currentTrackId`，默认 `saa-main`），只影响首页的“继续学习”与推荐。
3. **选修组只计数，不替代**：完成场景卡不会自动视为完成同组外的单服务卡；需要“二选一”的地方一律写成选修组。
4. **可选卡片**不计入完成条件与必修时长，但计入掌握度。
5. **路径版本**：路径的主版本号变化（增删必修卡片）不影响已签发的证书；进行中的学员按新版本计算进度，已完成的卡片照常计入。
6. **环境复用**：路径页在两张相邻卡片之间显示目录生成的 `reuseFrom` 提示（05 §8.6）；不满足条件的组合不显示，以免破坏下一张卡片的“没有它”基线。

---

## 5. 掌握度模型

### 5.1 三层结构

```text
路径证书（签名，可对外出示）      ← 路径内必修与选修组的徽章都有效
 └─ 徽章（每张卡片一枚，不签名）   ← 卡片完成（最终复核通过）；小测成绩只记在徽章上
     └─ 卡片的一次尝试            ← 04 §8.4 的完成规则
服务掌握度（服务地图上的 40 格）    ← 由徽章和小测成绩推导，不单独存储
```

### 5.2 徽章

**授予条件**：

1. 某次尝试的状态为 `completed` 或 `completed_manual`（04 §8.4）；
2. 每个非选做目标的 wire 检查，其证据来源（provenance）是**本会话**（04 §8.11 的 `this-session`）。

两条同时满足即授予。**徽章只看卡片是否完成，小测成绩只记录在徽章上，不影响完成**（裁决 C3、04 §3.2.11）：小测可以在会话结束后作答，历次最好成绩记在徽章上，并进入 §5.4 的 Q。第 1 轮曾把“小测 ≥ 70 分”列为条件，已删除（每卡只有 3 道小测，≥ 70 分等于必须全对）。

条件 2 的落实方式：目标在当前环境中已经等于目标取值的卡片**不能在该环境中开始**，开始对话框只提供“全新开始”（04 §8.11 第 2 条、02 §8.4）；`reuseFrom`（05 §8.6 第 2 条）本来也不会推荐这种组合。这样“完成”与“获得徽章”始终等价，不会出现“完成了却没有徽章”。

**写入的数据**：徽章写在 `LabProgress.badge`（字段以 01 §7.3 为准，写入时机与来源见 04 §8.6）：等级、状态、获得时间、依据的尝试、内容版本、起始变体、证据分与小测成绩。授予与撤回时发事件 `badge.earned`、`badge.withdrawn`（01 §8.4）。

**徽章等级**（由 §5.3 的证据分 E 决定）：

| 等级 | 条件 | 图形 |
|---|---|---|
| 已核验 | E ≥ 0.95 | 实线外环 |
| 含手动 | 0.8 ≤ E < 0.95 | 虚线外环 |
| 自述为主 | E < 0.8 | 点线外环；不计入路径证书，也不计入“熟练” |

**徽章状态**：`valid`（有效）、`pending`（依据的对比实验仍在交叉核验中，01 `ExperimentRun.validity=pending-crosscheck`）、`withdrawn`（撤回，§5.6）。同一张卡片以后取得更高等级时，徽章自动升级，不降级。

### 5.3 手动确认与自动判定的权重

每条必需检查按有效结果的来源取权重（`skipped` 步骤中的检查不计入）：

| 有效结果来源（04 §8.8） | 权重 | 理由 |
|---|---|---|
| 自动判定（local、capability、http-header、aws-readonly、有效的对比实验） | 1.0 | 平台独立核验 |
| 对比实验 `simulated`（内容允许时） | 0.8 | 场景是模拟的，现象真实性较弱 |
| 原生手动（检查本身就是 manual，例如“收到确认订阅邮件”） | 1.0 | 设计上只能手动；所有学员都一样，不应拉开差距。证书上单列“学员自述 N 项” |
| 带证据的手动（`manual_evidence`，后端用同一断言校验了粘贴的输出） | 0.9 | 断言相同，但输出可能被编辑 |
| 降级手动（aws-readonly 因权限或白名单失败而改为手动） | 0.5 | 平台没能核验；助教复核通过后提升为 0.8 |

卡片的证据分 E = 必需检查权重的平均值。路径证书的“已核验占比”= 计入的卡片中“已核验”徽章的比例，对应 04 `completion.minAutoRatio`。

**发布前提**：标 [白名单+] 的 `aws-readonly` 检查不能进入必需步骤（04 §3.5 第 8 条）；若临时改写为手动，按本表只能取 0.5，会拉低证据分，`secure` 路径（`minAutoRatio` 0.8）可能无法颁证。第 2 轮列出的缺口（`config:*`、`inspector2:*`、`states:*`、`imagebuilder:*`、`glue:GetTable`、`athena:*`、`backup:ListCopyJobs`、`route53:GetHealthCheckStatus`、`ssm:DescribeSessions`、`ce:ListCostAllocationTags` 等）与灾备区域的 `region: dr-region` 已由 04 §5.7 收录（W-04-9）。剩余缺口：API Gateway v2 的 `GetIntegrations`、`GetAuthorizers`（sc-serverless-api、sc-user-identity 的集成类型与授权器核对），在 04 收录之前这两项只作选做步骤中的辅助检查（P-24）。

### 5.4 服务掌握度

**计入规则**：卡片 C 计入服务格 S，当且仅当 C 的徽章有效，且 S 的计入步骤全部以本会话证据达成。计入步骤默认是 S 对应模块在 `targetModules` 中的 wire 步骤；对不是目标、但卡内有实际操作的辅助服务（例如 sc-static-acceleration 中的 S3 OAC 策略），可以在 `services[].creditBy` 中显式声明，lint 要求这些步骤至少有一条针对该服务的自动检查，且这条检查不能只描述起始状态（04 §3.5 第 24 条）。起始状态中的模块默认不计入（`services[].role: context`）；只有经 `creditBy` 声明了卡内由学员亲手完成的步骤时才计入（例如 sc-ha-web 中 RDS 的故障转移演练、sc-backup-dr 中 S3 的跨区域复制规则）。只描述起始状态的检查（例如“`MultiAZ=true`”，由平台预置）不能作为计入依据。按裁决 C3 预置的 iam(role) 同样不计入 iam 服务格；iam 由 svc-iam 与 sc-security-baseline 的选做步骤计入。各场景卡的计入见 §3.2。

**分数**（0～100，只用于服务格上的进度环）：

```text
有场景卡的服务：  M = 60 × E_svc + 25 × min(1, Σ E_sc) + 15 × Q
没有场景卡的服务：M = 75 × E_svc + 25 × Q
  E_svc = 该服务单服务卡最好一次尝试的证据分（没有有效徽章为 0）
  E_sc  = 计入该服务的各场景卡的证据分（每张卡取最好一次）
  Q     = 学员在标注了该服务的小测题上的最好正确率（作答少于 3 题时为 0）
```

**等级**（按规则判定，与分数无关，界面上显示文字和形状）：

| 等级 | 条件 |
|---|---|
| 熟练 | 单服务卡徽章为“已核验”或“含手动”，至少 1 张场景卡计入该服务，且 Q ≥ 0.8。没有场景卡的服务：单服务卡徽章为“已核验”且 Q ≥ 0.8 |
| 已掌握 | 单服务卡徽章有效；或至少 2 张场景卡计入该服务（显示“经场景”） |
| 已接触 | 有任何一次非作废的尝试涉及该服务（含背景），或 1 张场景卡计入，或作答过相关小测 |
| 未开始 | 以上都没有 |

**没有场景卡的服务格**：ssm-parameter-store（svc-config）、scheduler（svc-scheduler）。iam 只能经 sc-security-baseline 的选做步骤由场景卡计入；route53、acm 只在有域名时才能由场景卡计入。没有场景卡、或场景卡只在条件满足时才计入的服务格，“熟练”按下面的备用规则判定（只看单服务卡与小测）。见 P-7。

### 5.5 路径证书

在 04 §10.2 的基础上改为以徽章为单位：

1. 路径的每张必修卡片都有**有效**徽章（`pending` 的徽章要等交叉核验结束）；
2. 每个选修组至少有 `pick` 张有效徽章；
3. “自述为主”的徽章不计入；“已核验”占比 ≥ `completion.minAutoRatio`（saa-main 0.7，其余 0.8）；
4. 计入的尝试所用的内容版本都未被标记为“有缺陷”（04 §10.7）；
5. 满足条件后在路径页显示“领取证书”（`POST /api/v1/certificates { scope: track, trackId }`，01 §8.2），签名、载荷与验证见 04 §10.3～10.8。证书载荷的 `achievement.labs` 引用徽章所依据的尝试（04 §10.4），不再引用 Lab 证书；同一路径只保留一张有效证书，成绩提高后重新领取时旧证书以 `superseded` 吊销（04 §10.2）。路径完成时发事件 `track.completed`（01 §8.4）。
6. 所有证书都写明“由自托管平台签发的完成证明，不是 AWS 官方认证”（04 §10.1）；卡片默认不签发证书（`certificate.enabled: false`）。

### 5.6 配置漂移与证据失效对徽章的影响

| 时间点 | 发生了什么 | 对徽章的影响 |
|---|---|---|
| 会话中、完成前 | must-hold 检查从 pass 变为 fail（04 §5.8） | 尝试不能完成，因此没有徽章；修复后复测通过即可 |
| 会话中、完成后 | 学员继续探索时改坏了配置 | 无影响（04 §8.4 只升不降），界面只提示漂移 |
| 会话结束后 | 资源已全部回收 | 漂移不再有意义；徽章基于完成时固化的证据，**永久有效** |
| 复用的环境中做下一张卡片 | 上一张卡片已获徽章的模块，在新卡片的检查中被发现漂移（例如 capability 变为 error、aws-readonly 由 pass 变 fail） | 不撤销徽章，不改变掌握度等级；在新尝试中记录一条 `regression`，服务格显示“需复习”，直到之后某张计入该服务的卡片在**全新环境**中完成 |
| 内容主版本升级 | 卡片的检查语义改变 | 徽章保留，标注“旧版”；仍计入路径证书（证书载荷记录版本） |
| 证据被判无效 | 完成所依据的对比实验，交叉核验结果由 `pending-crosscheck` 变为 `invalid` | 徽章 `withdrawn`，通知学员重做；已签发、引用它的路径证书按 04 §10.7 以 `evidence-invalidated` 为原因吊销 |

### 5.7 计算位置与接口

- 掌握度是纯函数 `mastery(labProgress[], quizStats, catalog)`，在 `atl-api` 中按需计算（56 张卡片、40 个服务格，数据量很小），不新增实体（04 §8.6）。路径进度是纯函数 `trackProgress(track, labProgress[])`（04 §8.7）。
- 徽章写在 `LabProgress.badge`，计入记录写在 `LabProgress.credits[]`，回归记录写在 `LabProgress.regressions[]`，小测按服务的最好成绩写在 `LabProgress.quizByService`（01 §7.3、04 §8.6）。
- 接口（名称以 01 §8.2 为准）：`GET /api/v1/me/mastery`（掌握度与服务地图）、`GET /api/v1/me/progress`（全部 `LabProgress` 与路径进度）、`GET /api/v1/tracks`、`GET /api/v1/tracks/{trackId}`（路径定义与进度）、`PATCH /api/v1/me`（`currentTrackId`）、`POST /api/v1/certificates`（领取路径证书）。事件：`badge.earned`、`badge.withdrawn`、`mastery.regression`、`track.completed`（01 §8.4，`source: atl.progress`）。

### 5.8 徽章图形（已移至 05）

徽章与服务图标一样**不使用 AWS 官方素材**，也不使用与 AWS 认证徽章相似的造型与配色。图形规格（单服务卡的圆角方块、场景卡的六边形与 `badge.short`、外环按等级为实线 / 虚线 / 点线、旧版 / 核验中 / 已撤回的修饰）见 05 §2.10；本节第 2 轮的规格已移交 05。本文只定义图形所表达的含义：等级见 §5.2、§5.3，状态见 §5.2、§5.6。

---|---|
| 单服务卡 | 40 px 圆角方块，内容同服务缩写方块；外环按等级为实线（已核验）/ 虚线（含手动）/ 点线（自述为主） |
| 场景卡 | 40 px 六边形，中间是 ≤ 4 个汉字的场景短名（`badge.short`，例如“边缘防护”），下方 N 个小圆点表示服务数；外环规则同上 |
| 状态修饰 | 旧版：右上角小角标“旧”；核验中（`pending`）：外环旋转虚线（尊重 `prefers-reduced-motion`，减少动画时改为静态“核验中”文字）；撤回（`withdrawn`）：灰色斜线填充 + 文字“已撤回” |
| 读屏 | 写成“徽章：<徽章名>，已核验”这类文字；图形本身 `aria-hidden` |

---

## 6. 目录页信息架构（已移至 05）

按裁决 C2，目录页的信息架构由 **05 §2** 定义（卡片网格、服务地图、路径视图、筛选与搜索、卡片视觉字段、图标与类别色、推荐下一步、可访问性）。本文第 2 轮的 §6 已删除；其他文档中对本文 §6.x 的引用按下表改读 05（03 第 2 轮引用了 §6.6、§6.7）。

| 原小节 | 内容 | 现在的位置 |
|---|---|---|
| §6.1 | 路由（`/labs`、`?view=map`、`?view=tracks`、`/labs/:cardId`、`/tracks/:trackId`）与三种视图 | 05 §2 |
| §6.2、§6.3 | 卡片网格线框；筛选、搜索与排序（类型、服务、考试领域、难度、时长、费用档位、完成状态、“只看无需人工前置”） | 05 §2 |
| §6.4、§6.5 | 服务地图（40 格、侧栏、附属服务）；路径视图（阶段、选修组、证书条件区） | 05 §2；服务格的等级与分数来自本文 §5.4，路径的完成规则来自本文 §4.6、§5.5 |
| §6.6 | 卡片视觉规范（类型标记、类别色条、服务图标排、难度、时长、费用档位、环境准备、提示标记、状态、徽章位、读屏） | 05 §2 |
| §6.7 | 不使用 AWS 官方素材；服务缩写方块、类别符号与缩写表（`taxonomy.yaml` 的 `services[].abbr`）；徽章图形 | 05 §2.10 与 `taxonomy.yaml`（05 §8.2） |
| §6.8 | 推荐下一步 | 05 §2.11；推荐所需的路径顺序与选修组来自本文 §4，`reuseFrom` 见 05 §8.6 |
| §6.9 | 可访问性与响应式 | 05 §2 |

---

## 7. 数据文件

分工（裁决 C2）：`lab.yaml` 的格式归 04 §3；`taxonomy.yaml`、生成的 `catalog.yaml`、生成的起始档位文件、`reuseFrom` 与目录构建产物归 05 §8；**路径文件 `labs/_tracks/<track-id>.yaml` 归本文**（§7.3）；起始档位的推导命令与档位文件的键名归 06。本节只保留路径文件的定义，以及本文规则在其他数据文件中的落点。

### 7.1 文件布局

```text
labs/
├── _schema/                 # lab、track、taxonomy、catalog 的 JSON Schema（由 zod 生成，04 §2.5）
├── _catalog/
│   ├── taxonomy.yaml        # 手写：类别、服务格、缩写、领域、时长分段、费用档位参数、模块部署速度（05）
│   └── catalog.yaml         # 生成：npm run labs:catalog 的输出，提交到仓库，CI 校验与重新生成的结果一致（05）
├── _tracks/
│   └── <track-id>.yaml      # 手写：学习路径（atl.track/v2，本文 §7.3）
├── svc-<module-id>/lab.yaml # 40 张单服务卡（atl.lab/v2，04 §3）
└── sc-<slug>/lab.yaml       # 16 张场景卡
profiles/atl/<card-id>/<variant>.env   # 生成：起始档位（默认变体 default；sc-ha-web 的 efs、svc-tls 的 acme-off），随内容发布，不提交（05 §8.5、06）
```

### 7.2 lab.yaml 字段（以 04 §3 为准）

第 2 轮本文自拟了一组 `lab.yaml` 字段；04 第 2 轮把它们与 05、三批卡片的提议合并成 `atl.lab/v2`，**字段名一律以 04 §3 为准**。本文旧写法到 04 字段的对照（同 04 §14 K-2）：

| 本文第 2 轮的写法 | 04 `atl.lab/v2` 的字段 |
|---|---|
| `targetModules[].{from, to, reconfigure}` | `targetModules[].{driver, fromDriver, set, params, wireStep, optional, adoptsExisting}`（04 §3.2.4） |
| `startProfile.{derive, extends, add, drivers, params, localSettings, context, runtime, fallbacks}` | `startProfile.provisions[]{item, kind, basis, set, params, value, rule, contextKind, reason}` + `branches` + `platform` + `variants[]`（04 §3.2.3）；`fallbacks` → `variants[]` 中 `select: preflight` 的变体 |
| 顶层 `variants` | `startProfile.variants[]`（`select: learner`） |
| `startProfile.platform.sshFromWorkstation` | `workstation.sshFromWorkstation`（04 §3.2.15） |
| `acceptedWarnings` | `expectedWarnings`（04 §3.2.5） |
| `modules{target, start, context, related}` | 同名（04 §3.1） |
| `services[]{id, role, module, featureOf, optional, creditBy}` | 同名；`role` 含 `context`（04 §3.2.2） |
| `badge{title, short}` | 同名，另有可选 `icon`；完成即授予，小测不是条件（04 §3.2.11） |
| `acceptedDrift`、`extraStacks`、`scenario`、`tracks`、`kind` | 同名（04 §3.1、§3.2.15） |
| `regions.extra: ['${atl:drRegion}']`、`extraStacks[].region: extra:${atl:drRegion}` | `regions.extra: [dr-region]`、`extraStacks[].region: dr-region`（04 §3.2.2、§3.2.15） |
| `prerequisites.soft` | `prerequisites.cards[]{id, kind: soft \| hard}` |

**示例 1：单服务卡 `labs/svc-waf/lab.yaml`（只列与本文规则相关的字段）**

```yaml
schema: atl.lab/v2
id: svc-waf
kind: service
service: AWS WAF
function: Web 应用防护
title: AWS WAF：Web 应用防护
version: 1.0.0
difficulty: intermediate
estimatedMinutes: 90
timeLimitMinutes: 150
services:
  - { id: waf, role: primary, module: waf }
  - { id: cloudfront, role: context, module: cdn }      # 闭包中的 Web ACL 关联对象，不计入
  - { id: iam, role: context, module: iam }             # 裁决 C3 预置，不计入
  - { id: shield, role: observed, featureOf: waf }
modules: { target: [waf], start: [iam, cdn], context: [], related: [load-balancer, threat-detection] }
startProfile:
  provisions:
    - { item: iam, kind: module, basis: credential, set: { IAM_CREDENTIALS: role },
        reason: 平台为每张卡片预置实例角色（裁决 C3）；waf 的 IP 集合同步与拦截计数也需要它 }
    - { item: cdn, kind: module, basis: closure, rule: DEP-006, set: { CDN_DIRECT_ACCESS: open },
        reason: WAF 不能直接关联 EC2，需要 CloudFront 或 ALB 作为挂载点 }
    - { item: preview-direct-https, kind: platform, reason: 预览使用 Let's Encrypt IP 证书 }
  branches:
    DEP-006: { choose: cdn, reason: registry 第一个分支；CLOUDFRONT 范围是边缘防护的考试形态；不引入按小时计费的 ALB }
  platform: { preview: { directHttps: 'on' } }
  reason: WAF 只能关联到 CloudFront、ALB 等资源；平台先为你部署好 CloudFront 分配与实例角色
targetModules:
  - { id: waf, driver: aws, params: { Scope: CLOUDFRONT }, wireStep: associate-webacl }
expectedWarnings: [DEP-018]                # before 基线（源站未锁定），卡内修复；C3 之后不再出现 CRED-004
badge: { title: Web 防护 }
tracks: [saa-main, secure, networking]
saa: { domains: [secure] }
regions: { supported: [ap-northeast-1], alsoUses: [global, us-east-1] }
cost: { tier: low, mainDrivers: [Web ACL 与规则的按月折算费, WAF 请求数, CloudFront 请求与流量] }
provision: { class: B }
```

**示例 2：场景卡 `labs/sc-ha-web/lab.yaml`（带学员可选的起始变体）**

```yaml
schema: atl.lab/v2
id: sc-ha-web
kind: scenario
title: 高可用 Web 层
subtitle: ALB + Auto Scaling + S3 或 EFS + RDS Multi-AZ
version: 1.0.0
difficulty: advanced
estimatedMinutes: 150
timeLimitMinutes: 240
scenario:
  question: 单台 EC2 停机即全站不可用。要求跨两个 AZ、自动替换故障实例、按负载伸缩，数据库自动故障转移，照片在任何实例上都能访问。
  constraints: [不改业务代码, 不在实例本地保存状态]
  antiPatterns: [只开 Multi-AZ 数据库而 Web 层仍是单实例, 用实例本地盘存照片再做 rsync]
services:
  - { id: elb, role: primary, module: load-balancer }
  - { id: autoscaling, role: primary, module: autoscaling }
  - { id: rds, role: supporting, module: database, creditBy: [failover-drill] }   # Multi-AZ 由平台预置，计入靠学员做的故障转移演练
  - { id: s3, role: context, module: storage }          # efs 变体中为 { id: efs, role: supporting, module: shared-fs, creditBy: [cross-instance] }
  - { id: iam, role: context, module: iam }
  - { id: imagebuilder, role: supporting, module: ami, optional: true }
modules: { target: [load-balancer, autoscaling, ami], start: [iam, storage, database], context: [], related: [shared-fs, cache, monitoring] }
startProfile:
  provisions:
    - { item: iam, kind: module, basis: credential, set: { IAM_CREDENTIALS: role },
        reason: 裁决 C3；autoscaling 也要求实例角色（DEP-007） }
    - { item: storage, kind: module, basis: closure, rule: ASG-001, set: { STORAGE_DRIVER: s3 },
        reason: 多实例必须共享照片存储 }
    - { item: database, kind: module, basis: closure, rule: ASG-002, set: { DB_DRIVER: postgres },
        params: { MultiAz: true }, contextKind: shorten-wait,
        reason: 多实例必须共享数据库；Multi-AZ 实例创建最慢，放在开始阶段不占学员计时，卡内只做故障转移演练 }
    - { item: preview-direct-https, kind: platform, reason: 方案 B 关闭（ASG-014），预览在新标签页打开 ALB 地址 }
  branches:
    ASG-001: { choose: storage, reason: 与 l8-ha 一致；EFS 做法见 efs 变体 }
  platform: { preview: { directHttps: 'off' } }
  variants:
    - id: efs
      title: 用 EFS 作共享存储
      select: learner
      provisions:
        - { item: iam, kind: module, basis: credential, set: { IAM_CREDENTIALS: role }, reason: 同默认 }
        - { item: shared-fs, kind: module, basis: closure, rule: ASG-001, set: { STORAGE_DRIVER: efs }, reason: 对照 S3 与 EFS 两种共享存储 }
        - { item: database, kind: module, basis: closure, rule: ASG-002, set: { DB_DRIVER: postgres },
            params: { MultiAz: true }, contextKind: shorten-wait, reason: 同默认 }
      branches: { ASG-001: { choose: shared-fs, reason: 对照原 x-efs-asg 档位 } }
      reason: 共享存储换成 EFS，其余相同
  reason: 自动伸缩要求共享存储、共享数据库与实例角色；Multi-AZ 的 RDS 创建很慢，平台在开始阶段先部署好
targetModules:
  - { id: load-balancer, driver: alb, wireStep: wire-alb }
  - { id: autoscaling, driver: asg, params: { MinSize: 2, DesiredCapacity: 2, MaxSize: 4, AzCount: 2 }, wireStep: wire-asg }   # SECRETS_ORIGIN=bundle 由 enable autoscaling 写入
  - { id: ami, driver: golden, optional: true, wireStep: golden-ami }
expectedWarnings: [SEC-002, ASG-009, ASG-010, ASG-011, ASG-012, ASG-013]   # SEC-002 在锁定入口（LB_LOCK_ORIGIN=on）之前出现
badge: { title: 高可用 Web, short: 高可用 }
tracks: [saa-main, resilient]
saa: { domains: [resilient, performance, cost] }
cost: { tier: high, mainDrivers: [RDS Multi-AZ 实例小时, ALB 小时与 LCU, ASG 实例小时] }
provision: { class: C }
```

### 7.3 `labs/_tracks/<track-id>.yaml`（`atl.track/v2`）

本文定义路径文件的字段与语义；04 §8.7 负责生成 `track.schema.json`、`labs:lint` 的校验（04 §3.5 第 23 条）与 `trackProgress` 的实现。相对 v1（`labs` + `groups`）：改为“阶段 → 条目”，条目分三种角色；增加 `legacyLab`、`note`；时长与卡片数由构建计算，不手写。`atl.track/v1` 只在迁移期可读。

| 字段 | 说明 |
|---|---|
| `schema`、`id`、`version`、`title`、`summary` | 同 v1；`id` 规则见 §1.2 |
| `audience` | 适合谁，显示在路径页 |
| `domain` | 领域专项路径填对应领域（`secure \| resilient \| performance \| cost`），其余省略 |
| `stages[]` | `{ id, title, legacyLabs?, items[] }`；`legacyLabs` 由 05 §5 的映射生成 |
| `items[]` | `{ card, role: required \| optional, legacyLab?, note? }` 或 `{ group, title, pick, cards[] }`（选修组） |
| `completion` | `{ allowManual: true, minAutoRatio, excludeSelfReported: true }`（§5.5） |
| `certificate` | `{ enabled: true, title }` |

**完整示例：`labs/_tracks/quick-compare.yaml`**

```yaml
schema: atl.track/v2
id: quick-compare
version: 1.0.0
title: 点名对比快速路径
summary: 七个服务的“有 vs 没有”：Cognito、SQS、CloudFront、Lambda、ElastiCache、S3、RDS
audience: 已经熟悉 L0、只想看这七组对比的学员
stages:
  - id: compare
    title: 七项对比（按费用从低到高）
    items:
      - { card: svc-ec2, role: optional, note: 熟悉 L0 可以跳过 }
      - { card: svc-storage, role: required }
      - { card: svc-cdn, role: required }
      - { card: svc-queue, role: required }
      - { card: svc-image-processing, role: required }
      - { card: svc-auth, role: required }
      - { card: svc-cache, role: required, note: 按小时计费，做完立即结束 }
      - { card: svc-database, role: required, note: 按小时计费，做完立即结束 }
completion: { allowManual: true, minAutoRatio: 0.8, excludeSelfReported: true }
certificate: { enabled: true, title: 七项点名对比证书 }
```

**片段：`labs/_tracks/saa-main.yaml` 的阶段 2**

```yaml
  - id: s2-edge
    title: 存储与边缘
    legacyLabs: [4, 5, 6, 7]
    items:
      - { card: svc-storage, role: required, legacyLab: 4 }
      - { card: svc-cdn, role: required, legacyLab: 5 }
      - { card: svc-dns, role: optional, legacyLab: 6, note: 需要域名 }
      - { card: svc-tls, role: optional, legacyLab: 6, note: 需要域名 }
      - { card: svc-waf, role: required, legacyLab: 7 }
      - { group: s2-scenario, title: 阶段综合, pick: 1, cards: [sc-edge-protection, sc-static-acceleration] }
```

**路径文件的校验**（`labs:lint`；与 04 §3.5 第 23 条一起执行）：

1. 每个 `card` 与 `cards[]` 中的 id 都存在；同一路径中同一卡片只出现一次（04 第 23 条）。
2. 选修组的 `pick` ≥ 1 且 ≤ 组内卡片数；选修组内的卡片不得同时作为必修条目出现。
3. `completion.minAutoRatio` ∈ [0, 1]。
4. 必修条目与选修组中的卡片不得依赖**必填**的 `domain` 输入（需要域名的卡片只能是可选条目；域名可选的场景卡不受限），保证没有域名也能拿到证书。
5. 每张卡片 `lab.yaml` 的 `tracks` 等于实际包含它的路径集合（04 第 23 条，`labs:fix` 可自动改写）。

### 7.4 `taxonomy.yaml`（已移至 05）

类别、服务格与附属服务（id、名称、缩写、类别、`module`、`iamPrefix`、`featureOf`、控制台深链）、考试领域、时长分段、费用档位参数、模块部署速度的定义见 05 §8.2；本文与卡片文档中的服务格 id 以它为准（例如 Session Manager 的服务格 id 是 `ssm-session-manager`，05 §4.5 D-16）。本文用到的约定只有两条：服务格 id 不直接用 IAM 前缀（shell-access 与 config 都是 `ssm`），`iamPrefix` 单独保存；考试领域 id 用 `secure | resilient | performance | cost`，与路径 id `performant`、`cost-optimized` 的对应写在 taxonomy 中。

### 7.5 `catalog.yaml` 与 `reuseFrom`（已移至 05）

生成的 `catalog.yaml` 的格式、构建与核对见 05 §8.3；其中 `cards[].reuseFrom`（02 §8.4 的环境复用推荐）的生成规则见 05 §8.6。本文只依赖其中的第 2 条——“B 的每个目标在 A 结束时的取值都不等于 B 的目标取值”——它与 02 §8.4 的“目标已生效的卡片不能在该环境开始”一起，保证 §5.2 的“完成即得徽章”成立。按裁决 C3，iam(role) 在所有卡片（svc-ec2、svc-iam 除外）的起始状态中，复用时 iam 不构成冲突。

### 7.6 startProfile 的推导与校验

- **命令与算法**：`scripts/module plan --start-of <card-id> [--variant <id>] --platform --json`（06）。输入只来自 `lab.yaml`，是纯计算命令，CI 不需要 AWS 凭证。按手册顺序启用目标的合法性用 `plan --profile atl/<card-id>/<variant> --then <目标…>` 核对。
- **构建期核对**：04 §3.5 C 组 DRV-1～DRV-11（`provisions` 与推导结果逐项相同、`basis` 与成因一致、背景模块理由合法、目标真的改变什么、按顺序启用只出现预期警告、拓扑序、分支、变体、摘要、部署等级与费用档位）。
- **生成的档位文件**：`profiles/atl/<card-id>/<variant>.env`，格式与示例见 05 §8.5，键名以 06 为准。
- **运行期复核**：02 的运行器在 `profile-apply` 时重算摘要，不一致即 `PROFILE_DIGEST_MISMATCH`（02 §3.6）。
- **前置工作**（06）：registry 为“启用某模块即可满足”的 error 级规则提供机器可读的 `remedy`，为单服务卡的本地档调整与运行时热键提供 `singleLocalSettings`、`singleRuntime`，并增加 `secrets.orderBefore: [database]`；否则 DRV-1 对 svc-queue、svc-workflow、svc-tracing、svc-cache、svc-db-proxy、svc-scheduler 等必然失败（P-4，04 M-8）。

**推导结果示意**（`plan --start-of svc-autoscaling --platform --json`，只为说明闭包中不在 `requires` 里的部分；输出格式以 06 为准）：

```json
{
  "schema": "cloudalbum.plan/v1",
  "request": { "startOf": "svc-autoscaling", "variant": "default", "targets": [ { "module": "autoscaling", "driver": "asg" } ] },
  "provisions": [
    { "item": "iam", "kind": "module", "basis": "credential", "set": { "IAM_CREDENTIALS": "role" }, "because": ["C3", "DEP-007"] },
    { "item": "load-balancer", "kind": "module", "basis": "closure", "set": { "LB_MODE": "alb" }, "because": ["DEP-007"] },
    { "item": "database", "kind": "module", "basis": "closure", "set": { "DB_DRIVER": "postgres" }, "because": ["ASG-002", "ASG-003"] },
    { "item": "storage", "kind": "module", "basis": "closure", "set": { "STORAGE_DRIVER": "s3" }, "because": ["ASG-001"],
      "branch": { "rule": "ASG-001", "chosen": "storage", "alternatives": ["shared-fs"] } }
  ],
  "companions": { "target": "autoscaling", "set": { "SECRETS_ORIGIN": "bundle" }, "because": ["ASG-007", "ASG-008"] },
  "platform": { "preview.directHttps": "off", "because": ["ASG-014"] },
  "warningsAfterTargets": ["ASG-009", "ASG-010", "ASG-011", "ASG-012", "ASG-013"],
  "order": ["iam", "storage", "database", "load-balancer", "autoscaling"],
  "provision": { "slowResources": ["rds"], "mediumResources": ["alb"], "class": "D" },
  "digest": "sha256:…"
}
```

`companions` 是随**目标**写入的取值（`enable autoscaling` 时写入），不进入起始状态（P-17）。

### 7.7 lint 规则（已并入 04）

第 2 轮本节提出的 10 条卡片目录规则已由 04 §3.5 收录，编号对照如下；路径文件自身的校验见 §7.3。

| 本文第 2 轮 | 04 §3.5 |
|---|---|
| 1（id 前缀与 `kind`、primary / supporting 数量） | A-1、B-21 |
| 2（目标数量与 `creditBy`） | B-22 |
| 3（`tracks` 与 `_tracks/` 一致） | B-23 |
| 4（`creditBy` 步骤要有针对该服务、不只描述起始状态的自动检查） | B-24 |
| 5（场景题） | B-25、A-17 |
| 6（选做目标的依赖） | 04 §3.2.4 的 `optional` 规则 |
| 7（路径中的卡片存在、唯一） | B-23；`pick` 的范围见本文 §7.3 |
| 8（需要域名的步骤带 `when`） | A-19 |
| 9（白名单、before 状态一律 `once`） | A-8、A-9 |
| 10（`extraStacks` 被使用、不替代模块） | A-20 |

---

## 8. 与 docs/platform/01～06 的接口与回写状态

本文不修改其他文档。第 2 轮列出的回写项（W-*、X-*）在第 3 轮由各文档的负责流程处理，状态如下；8.7 是本轮新发现、仍需其他文档配合的事项。

### 8.1 05-lab-catalog.md

第 2 轮的“取代与保留”清单已被裁决 C2 取代：05 改写为**卡片目录（权威）**，接管目录页信息架构、56 张卡片的元数据汇总、原 Lab → 卡片映射、目录总则、分类法、`catalog.yaml` 与目录 API；学习路径、掌握度、徽章、证书的模型只引用本文（05 §6）。本文相应删去 §2.1、§3.1、§3.2、§6、§7.4、§7.5 的内容，只留指针。05 的路径视图与服务地图所需的数据（路径阶段、选修组、`reuseFrom`、服务格等级）来自本文 §4、§5、§7.5。

### 8.2 01-architecture.md

| # | 内容 | 状态 |
|---|---|---|
| W-01-1 | `LabSession` 增加 `labKind`、`variant`、`startProfileDigest`、`startProfileResolved`、`targetModules[]{id, from, to}`、`trackId` | 已落实（01 §7.3） |
| W-01-2 | `LabProgress` 的徽章、计入、回归、`quizByService` | 已落实（01 §7.3）；徽章小测字段已统一为 04 的 `quiz{bestScore, byDomain, attempts}`，另有 `variant`（第 4 轮） |
| W-01-3 | `Learner.currentTrackId` | 已落实 |
| W-01-4 | `Certificate.scope` 以 `track` 为主，`revokeReason` 含 `evidence-invalidated` | 已落实 |
| W-01-5 | `CatalogRelease` 的版本字段 | 已落实（01 第二轮 S-10） |
| W-01-6 | `GET /catalog`、`GET /me/mastery`、`GET /tracks`、`/tracks/{trackId}`；报价与开始请求接受 `variant` | 已落实（01 §8.2；报价接口为 `POST /labs/{labId}/quotes`，`/estimate` 已废弃） |
| W-01-7 | 事件 `badge.earned`、`badge.withdrawn`、`mastery.regression`（另有 `track.completed`） | 已落实（01 §8.4） |
| W-01-8 | 错误码 `VARIANT_UNKNOWN`、`PROFILE_DIGEST_MISMATCH` | 已落实 |
| W-01-9 | `atl:lab-id` 取卡片 id；`atl:card-stack` | 已落实；01 第三轮启用 `ATL_OP=extra-stack` 与标签 `atl:card-stack` |
| W-01-10 | 灾备区域放行 sc-backup-dr 所需资源；Provisioner 部署 extraStacks | 已落实（01 §6.5 `DrRegionLimited`、`DrRegionLabStacksOnly`）；但后者把灾备区域的栈限定为 `stack/cloudalbum-*`，与 02 的卡片自带栈名 `atl-<envName>-<cardId>-<stackId>` 冲突（8.7 第 3 条） **第 4 轮**：栈名已统一为 `cloudalbum-<envName>-x-<stackId>`，与 `DrRegionLabStacksOnly` 一致。 |

### 8.3 02-lab-lifecycle.md

| # | 内容 | 状态 |
|---|---|---|
| W-02-1 | 报价按所选变体计算；有预检型变体时报较高的一档 | 已落实（02 §3.2） |
| W-02-2 | 账号预检选择回退档 | 已落实（02 §3.5、§3.6）；02 的字段写 `startProfile.fallbacks`，04 写 `startProfile.variants[]`（`select: preflight`），需 02 按 04 的字段名改写（8.7 第 1 条） |
| W-02-3、W-02-4 | 环境上下文携带档位名与摘要；运行器下载档位、`plan --start-of` 复核、`PROFILE_DIGEST_MISMATCH` | 已落实（02 §3.6、§4.3） |
| W-02-5 | 目标已等于目标取值的卡片不能在该环境开始 | 已落实（02 §8.4） |
| W-02-6 | 部署等级由构建期计算 | 已落实（02 §11） |
| W-02-7 | 消费的目录字段 | 已落实，字段名以 04 §3.1 的对照表为准 |
| W-02-8、W-02-9 | extraStacks 的部署、回收与报价 | 已落实（02 §4.3、§7）；栈名问题见 8.7 第 3 条 |

### 8.4 03-workspace-terminal.md

W-03-1（顶栏显示类型标记、服务缩写方块与目标顺序）、W-03-2（方案 B 的开关来自 `startProfile.platform.preview.directHttps`）、W-03-3（控制台深链可由 `taxonomy.yaml` 生成）均已落实（03 §2.2、§6.2、§5.4）。03 引用的本文 §6.6、§6.7 已移至 05（见本文 §6 的对照表）。

### 8.5 04-lab-format-checks-reports.md

W-04-1～W-04-10 均已由 04 第 2 轮落实：卡片 id 与目录布局（§2.1）、`atl.lab/v2` 字段（§3）、`startProfile.provisions`（§3.2.3）、lint 与 `labs:derive`（§3.5）、徽章与路径进度（§8.6、§8.7）、漂移与证据来源（§8.9、§8.11）、路径证书条件与载荷（§10.2、§10.4）、`when: learner.inputs.domain`（§3.5 第 19 条）、只读白名单与 `region: dr-region`（§5.7）、`acceptedDrift`（§5.8）。剩余：API Gateway v2 的 `GetIntegrations`、`GetAuthorizers` 尚未收录（8.7 第 4 条）。

### 8.6 docs/platform 之外与卡片文档的配合

| # | 内容 | 状态 |
|---|---|---|
| X-1 | `scripts/module plan --start-of`、档位格式、registry 的 `remedy`、`singleLocalSettings`、`singleRuntime`、`secrets.orderBefore: [database]` | 归 06（唯一清单，04 M-5、M-8），再由 06 的流程回写 modular-design |
| X-2 | service-cards-1 的 svc-network 改为 public 目标 | 由 service-cards-1 的负责流程处理（§3.3 C-12） |
| X-3 | 第 2、3 批字段与 capability 判定统一 | 第 3 批已在本轮改写；第 2 批由其负责流程处理 |
| X-4 | README 学习路线增加“学习路径与卡片”的对照 | 不在本轮范围（裁决 C8：不修改 README） |
| X-5 | storage 的 CRR 与生命周期参数、database 的跨区域副本、基础栈的 Spot 选项 | 长期可选；实现后 sc-backup-dr、sc-cost-optimization 的 `extraStacks` 可以换回模块 |
| X-6 | scenario-cards 按 §3.3 修改 | 已在本轮改写 |

### 8.7 仍需其他文档配合的事项（第 3 轮新增）

1. **起始档位名与预检型变体的写法**：01 §14 名称表、02 §3.6、05 §8.5 与本文都用 `atl/<card-id>/<variant>`（默认变体 `default`）；04 §3.2.3 与 K-3 写默认档位 `atl/<card-id>`（不带变体名），需按 01 改写（裁决 C1：名称以 01 为准）。另外 02 的字段写 `startProfile.fallbacks`，04 的字段是 `startProfile.variants[]`（`select: learner | preflight`），需 02 按 04 改写（字段格式以 04 为准）。
2. **徽章中的小测字段**：01 §7.3 写 `LabProgress.badge.quizScore`，04 §8.6 写 `badge.quiz{bestScore, byDomain, attempts}` 并多一个 `variant`。按裁决 C1 名称以 01 为准，需要 01 与 04 二选一并统一。
3. **卡片自带栈的名称**：02 §4.3 与 scenario-cards §2.4 写栈名 `atl-<envName>-<cardId>-<stackId>`，但 01 学员边界的 `DenyPlatformByName` 拒绝学员访问 `stack/atl*`、`arn:aws:s3:::atl-*`，`DrRegionLabStacksOnly` 只允许灾备区域的 `stack/cloudalbum-*`。sc-backup-dr 的灾备区域栈因此无法部署或被学员查看，学员也无法在控制台核对名称以 `atl-` 开头的目标桶。建议栈名改为 `cloudalbum-<envName>-x-<stackId>`，模板内显式命名的资源一律以 `cloudalbum-<envName>-` 开头，并由 01 启用 `ATL_OP=extra-stack`（02、01 配合）。
4. **只读白名单**：API Gateway v2 的 `GetIntegrations`、`GetAuthorizers`（04 §5.7）。在收录之前，sc-serverless-api 与 sc-user-identity 中核对集成类型与授权器的检查只作辅助（`severity: warn`），不作为必需判据。
5. **06 的实现前置**（CloudAlbum 侧）：06 已收录测试数据种子（PM-43～PM-45）、`app-stat` 的 `runId`、`probe-port --target private-ip`、vuln-scan 的 `ScanTypes`、`worker-down --fault stop-app`、`dependency-failure --egress none`、平台模式下 `enable cost` 跳过标签激活（PM-M28、PM-M34～PM-M36）。仍缺：`plan --start-of` / `--then` 支持同一模块的两段取值（sc-static-acceleration 的 dns：先 `eip` 后 `cloudfront`）；`monitoring/kill-test` 的 `--phase service | instance`（06 PM-M30 现写“模块侧无改动”）。
6. **与 05 的两处分歧**：① sc-security-baseline 是否预置 iam（05 §4.5 D-8 选“不预置、iam 仍是目标”并待主设计者确认；本文与 scenario-cards 按 C3 字面预置，§3.3 C-14）；② 05 §4.7 仍写 01 的 `DrRegionBackupOnly` 阻塞灾备区域，而 01 已改为 `DrRegionLimited` 并放行 `cloudalbum-*` 栈，sc-backup-dr 剩余的阻塞是第 3 条的栈名问题，05 §4.7 需按 01 更新。


**第 4 轮（跨文档审计）后的状态**：第 1 条已解决——04 统一为 `atl/<card-id>/<variant>`（文件 `profiles/atl/<card-id>/<variant>.env`），02 改读 `startProfile.variants[]`；第 2 条已解决——01 §7.3 采纳 04 的 `badge.quiz{bestScore, byDomain, attempts}` 与 `badge.variant`，`quizScore` 废弃；第 3 条已解决——01 启用 `ATL_OP=extra-stack`，栈名统一为 `cloudalbum-<envName>-x-<stackId>`（01 §3.9、02 §9.3、scenario-cards §2.4），灾备区域与 `us-east-1` 的护栏只放行 `stack/cloudalbum-*`，两者一致；第 6 条两处分歧都已消除——05 §4.3 按 C3 字面让 sc-security-baseline 预置 iam（目标 kms → secrets → audit → compliance），05 §4.7 改为依赖 01 的 `DrRegionLimited`。第 4、5 条不在本轮范围，状态不变。
---

## 9. 发现的现有设计问题

| # | 严重度 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| P-1 | 高 | 批次 1 的 **svc-network** 以 `public → private` 为目标，起始状态预置 `network(public) + load-balancer`：违反严格闭包与 04 lint 第 4 条，而且原 Lab 14“默认 VPC → 分层自定义 VPC 迁移（实例替换、密钥指纹、网关终端节点、Flow Logs）”没有任何卡片承载 | svc-network、sc-private-network、saa-main 的 Lab 14 | svc-network 改为 public（起始 L0、费用低）；private 移入 sc-private-network |
| P-2 | 高 | **sc-backup-dr** 指定的“S3 跨区域复制”与“RDS 跨区域只读副本”没有模块实现（storage 栈没有 Replication 配置；database 只支持同区域副本）；灾备区域的权限边界只放行备份，连在灾备区域恢复 EBS 卷都做不到（第 2 批 C-6）；dns 模块的故障转移没有“备用目标”参数 | sc-backup-dr、svc-backup | **审稿修订**：不再降为讲解（用户指定的组合中 CRR 是必选项）。按 scenario-cards.md 用卡片自带的 `extraStacks` 提供灾备区域目标桶、复制角色、维护站点与选做的跨区域只读副本（§1.5 规则 12）；前提是 W-01-10（灾备区域边界放行带会话标签的资源）、W-02-8（运行器部署与回收 extraStacks）、W-04-9（aws-readonly 的 `extra` 区域）。长期方案仍是给 storage、database 增加跨区域参数（X-5） |
| P-3 | 中 | **成本类实验无法在卡片时间内看到效果**：Budgets 与 Cost Explorer 数据滞后数小时到一天；成本分配标签出现在可激活列表约 24 小时、激活生效再约 24 小时，且激活是平台动作，不能在 svc-cost 卡内完成；S3 生命周期转换由 S3 异步执行；storage 栈没有 Intelligent-Tiering 选项；基础栈不支持 Spot（只有 autoscaling 的混合实例支持） | sc-cost-optimization、svc-cost（`visibility-lag` 本来就是跨会话实验） | 卡内只检查配置；利用此前各次实验留下的账单数据做跨会话复盘，并把本卡放在路径最后；平台动作 `cost-activate-tags` 在路径开始前执行（§4.2.1）；Spot 与 Graviton 改由 extraStack 基准机群与 `rebuild-instance` 亲手做（审稿修订） |
| P-4 | 高 | **自动推导缺口**：总纲 §10.4 的 gen-single 规则只读 registry 的 `requires`，但 autoscaling 的 database、storage 来自 ASG-001～003（rules.ts 中的 check 函数），DEP-009 是带出网与运维通道分支的复合部署规则，DEP-029 取决于运行时的 `https.trusted`，tls 的分支取决于部署前探测 | `plan --single` 会少算依赖，CI 与 §10.4 的手写表不一致 | rules.ts 中凡是“启用某模块即可满足”的 error 级规则都增加 `remedy`；DEP-029 这类依赖运行时能力的条件由卡片显式声明背景模块；部署前探测走回退档。**审稿补充**：gen-single 规则 3 的本地档调整与 `lab.faults` 热键也只写在卡片文档里，registry 要增加 `singleLocalSettings`、`singleRuntime`，否则 DRV-1 对 svc-queue、svc-workflow、svc-tracing、svc-cache、svc-db-proxy、svc-scheduler 等必然失败（§7.6、X-1） |
| P-5 | 中 | **卡内多个慢资源只能串行部署**：sc-db-performance 要在卡内创建只读副本、ElastiCache 复制组与 RDS Proxy；`scripts/module` 的环境操作锁使它们无法并行，等待时间叠加（scenario-cards.md 估约 50 分钟） | sc-db-performance | `scripts/module enable --no-wait` 加 `status --wait` 的异步模式，或允许在一次 `apply` 中并行部署互不依赖的栈；在此之前卡片的时间上限按串行估算；实测超出时把 ElastiCache 移进起始状态（`shorten-wait`）。sc-ha-web 已改为 Multi-AZ 预置，不再受此影响 |
| P-6 | 低 | **sc-analytics 与 svc-analytics 模块集合完全相同**：analytics 模块已经内含 S3、Athena、Glue 作为辅助服务 | 两张卡片区分度低 | 场景卡专注 Parquet 变体、分区与查询成本；或把 svc-analytics 收窄为“写入路径”对比 |
| P-7 | 低 | **Parameter Store（svc-config）与 EventBridge Scheduler（svc-scheduler）不在任何场景卡中**；Route 53、ACM 只在有域名时才能由场景卡计入 | 这些服务格的“熟练”只能走无场景卡的备用规则 | 后续可增补场景卡（例如“定时报表：EventBridge Scheduler + Athena + SES”“配置发布与回滚：Parameter Store + AppConfig”） |
| P-8 | 低 | **sc-decoupling 的“Lambda + DLQ”**用的是 image-processing 自带的缓冲队列（`IMAGE_TRIGGER=buffer-queue`）与失败队列，不是 queue 模块的任务队列；按现有设计 Lambda 不消费 queue 模块的队列 | 学员可能混淆两条队列 | 手册明确区分；或在 queue 模块增加 Lambda 消费者档 |
| P-9 | 低（审稿下调） | **Cognito 托管登录与 IP 证书**：初稿认为方案 B 的 Let's Encrypt IP 证书能否作为 Cognito 回调地址未核实。审稿核实：CreateUserPoolClient API 参考只要求回调地址是绝对 URI、使用 HTTPS（localhost / 127.0.0.1 / [::1] 例外）、不含片段，没有排斥 IP 主机名；剩下的风险是 IP 证书有效期短、签发失败会回退自签名（03 §6.2） | sc-user-identity、svc-auth 的托管登录选做步骤 | sc-user-identity 保留背景 cdn（理由改为“整卡稳定的受信 HTTPS”），部署等级 B；实测方案 B 的续期稳定性后，可以去掉背景 cdn |
| P-10 | 中 | **平台管理通道削弱了 Session Manager 的“没有它”基线**：平台模式下实验机从一开始就能经 SSM 登录（P7）；sc-private-network 若在 SSM 接口终端节点就绪前删除 NAT 路由，会切断平台管理通道与实验机终端 | svc-shell-access、sc-private-network | 前者沿用原 05 K12（Lab 2）的改写：SSH 只对工作台开放；后者必做部分保留 NAT，`endpoint-only` 选做前用 must-hold 前置检查保护，并在平台动作中提供“检查管理通道终端节点” |
| P-11 | 中 | **卡内等待偏长**：Inspector 的 Linux 深度检查默认每 6 小时采集一次应用（语言包）清单；GuardDuty 真实发现的生成时间不确定；Image Builder 构建与晋升后才能切换（DEP-037）；故障转移、ASG 实例引导、Config 首次评估都要等待 | sc-threat-compliance、svc-vuln-scan、svc-threat-detection、svc-ami、sc-ha-web | 必需检查只用示例发现、覆盖状态与对照实验，等不到的金丝雀（Inspector 语言包）降为选做；时间上限按串行等待估算；平台积累实测耗时后再校准（02 §11.2） |
| P-12 | 中 | **04 的 `targetModules.driver` 与 lint 第 4 条无法表达**本地档基线（svc-queue）、前驱取值（sc-private-network）、对起始模块改参数（sc-db-performance） | 多张卡片无法通过 lint | 本文 §1.4 的 from → to 与 DRV-5（同第 1 批 B-2、第 2 批 C-2 的方向） |
| P-13 | 低 | 总纲 §10.1 的档位格式没有本地设置、运行时热键、卡片自带栈与平台段的位置 | 生成的档位无法完整表达起始状态 | 新增 `PROFILE_LOCAL_SETTINGS`、`PROFILE_RUNTIME`、`PROFILE_EXTRA_STACKS`、`PROFILE_PLATFORM`、`PROFILE_PLAN_DIGEST`（X-1） |
| P-14 | 低 | 命名与取整不一致：难度 id（05 用 `intro`，第 2 批曾建议 `foundational`）；`schema` 版本（本文初稿 `v1.1`，第 1、3 批 `v2`）；`modules`、`badge` 字段写法三批不同 | lint 失败或文案不一致 | 统一用 `intro`、`atl.lab/v2` 与 §7.2 的字段（§3.3 C-1）。第 1、2 批的 `45 / 75` 已在其审稿修订中改正 |
| P-15 | 中 | 04 §10.2 的 Track 证书条件要求必修 Lab 都有 Lab 证书，与“卡片只发徽章”冲突 | 路径证书无法签发 | W-04-7 |
| P-16 | 高（审稿新增） | **必需检查使用了白名单之外的只读动作**：`config:DescribeConfigurationRecorderStatus` / `DescribeComplianceByConfigRule`、`inspector2:*`、`glue:GetTable`、`backup:ListCopyJobs`、`route53:GetHealthCheckStatus` 都不在 04 §5.7 中（04 中根本没有 config、inspector2、glue 三个服务），初稿也未标注 | 04 `labs:policy` 会让构建失败；临时改为手动则证据分只有 0.5，`secure` 路径无法颁证（§5.3 发布前提） | W-04-9 扩充白名单后再上线 sc-security-baseline、sc-threat-compliance、sc-analytics、sc-backup-dr 与第 3 批的 compliance、vuln-scan |
| P-17 | 高（审稿新增） | **`SECRETS_ORIGIN=bundle` 被写进起始状态**（初稿 §7.2 示例 2、§7.6 档位文件、§3.2.8）：它由 `enable autoscaling` 写入，引导配置包是 autoscaling 栈的资源；起始阶段只有单实例、没有引导配置包，`SECRETS_ORIGIN=bundle` 时机密“不在本机也不生成”（总纲 §2.7、§4.4） | sc-ha-web 起始状态部署后应用无法读到机密 | 已改为随 autoscaling 目标写入；plan 的 `companions` 标明属于目标 |
| P-18 | 中（审稿新增） | **初稿的场景卡元数据与 scenario-cards.md 大面积不一致**：12 张时长、5 张起始模块集合（sc-edge-protection、sc-ha-web、sc-observability、sc-backup-dr、sc-cost-optimization）、2 张费用档位不同，且 §3.2 声称逐卡设计“另行编写”；E、F 组 12 张暂定值与第 3 批有 9 处不同，第 1、2 批审稿修订后也有 13 处不同 | 目录、路径时长、费用筛选都会与实际卡片不符 | 已按逐卡文档同步（§2.1、§3.1、§4），本文规则与逐卡文档冲突处列在 §3.3；最终以 `catalog.yaml` 由 lab.yaml 生成为准 |
| P-19 | 中（审稿新增） | **若干检查不可实现或可被绕过**：`image-processing=lambda:queued` 不在结果词表中；POST / 异步路径的段用了 `HTTP` 检查；“直连 EIP 被拒”可以靠停掉 Nginx 通过；“只有 401”无法区分网关与 Express；`DescribeSecret` 的 `RotationEnabled` 与卡内的手动轮换不符；`DescribeComplianceByConfigRule` 看不到单个资源；`DescribeTable` 不含 TTL；“确认订阅”可以自动判定却写成手动 | 卡片无法完成，或不做操作也能完成 | 已逐条改写（§3.2 各卡“关键检查”中的审稿修订说明） |
| P-20 | 中（审稿新增） | **难度与 05 §2.7.1 不符**：初稿把启用了 AWS 模块的 svc-storage、svc-notification、svc-tagging 定为入门（入门的定义是“不启用任何 AWS 模块”），把 svc-database 定为中级（05 的 Lab 15 为高级）、svc-cdn、svc-dns、svc-load-balancer、svc-audit 定为初级（05 的 Lab 5、6、19、23 为中级） | 难度筛选与学习顺序误导学员 | 已按 05 §2.7.1 与三批文档改正 |
| P-21 | 中（审稿新增） | **徽章条件与用户要求冲突**：初稿要求“小测 ≥ 70 分”，并允许“完成但不授予徽章” | 违反“完成单张卡片获得徽章” | 已改为完成即授予；复用环境中目标已生效的卡片不能在该环境开始（§5.2、W-02-5） |
| P-22 | 中（第 3 轮新增） | **sc-security-baseline 与裁决 C3 冲突**：本卡第 2 轮以 L0（`IAM_CREDENTIALS=none`）起步、把 iam 作为第一个目标，而 C3 只给 svc-ec2、svc-iam 不预置 iam 的例外，04 §3.5 第 5 条也会让本卡 lint 失败 | sc-security-baseline、iam 服务格的计入 | 已按 C3 改写：iam 预置，目标为 kms → secrets → audit → compliance；“长期密钥 vs 临时凭证”作为选做的平台动作反面教材，选做通过时计入 iam（§3.3 C-14）。若主设计者希望保留 none → role 的起点，需要扩大 C3 的例外 **第 4 轮：已解决**——05 同步为预置 iam，C3 例外清单不扩大。 |
| P-23 | 高（第 3 轮新增） | **卡片自带栈的名称与 01 的学员边界冲突**：栈名 `atl-<envName>-<cardId>-<stackId>` 落在 `DenyPlatformByName`（`stack/atl*`）范围内，灾备区域的 `DrRegionLabStacksOnly` 只放行 `stack/cloudalbum-*` | sc-backup-dr 的灾备区域栈部署与学员核对；sc-cost-optimization 的基准机群 | 见 §8.7 第 3 条：栈名改为 `cloudalbum-<envName>-x-<stackId>`，模板内显式命名的资源以 `cloudalbum-<envName>-` 开头（01、02 配合） **第 4 轮：已解决**——01 启用 `extra-stack`，栈名 `cloudalbum-<envName>-x-<stackId>`（01 §3.9、02 §9.3、scenario-cards §2.4）。 |
| P-24 | 低（第 3 轮新增） | **只读白名单剩余缺口**：API Gateway v2 的 `GetIntegrations`、`GetAuthorizers` 不在 04 §5.7 中 | sc-serverless-api、sc-user-identity 无法自动核对集成类型与授权器配置 | 04 收录前只作 `severity: warn` 的辅助检查；必需判据改用“网关 401 + `apigw-requestid` + 请求未到达 EC2”的组合 |
| P-25 | 中（第 3 轮新增） | **档位名与预检型变体的写法不一**：01、02、05 与本文用 `atl/<card-id>/<variant>`（默认变体 `default`），04 写默认档位 `atl/<card-id>`；02 写 `startProfile.fallbacks`，04 写 `startProfile.variants[]` | 运行器下载的档位文件名、`LabSession.startProfileResolved` 的取值不一致，DRV-9/10 与 02 的摘要复核对不上 | 名称按 01（裁决 C1）、字段按 04：04 改档位名，02 改字段名（§8.7 第 1 条） **第 4 轮：已解决**——04 改档位名，02 改字段名。 |

**第 2 轮问题的第 3 轮状态**：已解决——P-2（01 `DrRegionLimited` 放行灾备区域资源，04 `region: dr-region`，02 部署与回收 extraStacks；剩 P-23 的命名问题）、P-12（04 `fromDriver` 与 DRV-5）、P-13（档位格式归 06）、P-14（04 `atl.lab/v2` 与四级难度）、P-15（04 §10.2 以徽章为条件）、P-16（04 §5.7 已收录，剩 P-24）、P-17、P-19、P-20、P-21（已在第 2 轮改写）；P-18 随 §2.1、§3.1 移交 05 而消解（取值只在 05 与 `lab.yaml`）。仍成立——P-1（待 service-cards-1 改写）、P-3、P-5、P-6、P-7、P-8、P-9、P-10、P-11（设计取舍或待实测）；P-4 归 06 的实现前置（04 M-8）。

---

## 修订记录

### 2026-10-13 · 第 1 轮

- 新建。定义卡片 id 与命名规范、from → to 目标写法、startProfile 的计算规则；给出 40 张单服务卡片与 16 张场景卡片的目录级元数据；设计 9 条学习路径与 saa-main 的 Lab 0～25 对照；定义徽章、服务掌握度、路径证书、证据权重与漂移规则；设计卡片网格、服务地图、路径三种视图与视觉规范；定义 `lab.yaml` 新字段、`atl.track/v2`、生成的 `catalog.yaml`、`scripts/module plan` 与 CI 推导检查；列出对 01～05 与平台外文档的回写清单和 15 项设计问题。

### 2026-10-13 · 第 2 轮

- 对抗式审稿修订：按三批单服务卡文档与 scenario-cards.md 同步目录取值，修正闭包、检查、难度、部署等级、徽章条件与路径时长，新增 §3.3、P-16～P-21 与若干回写项。逐条见下方“审稿修订记录”。

### 2026-10-13 · 第 3 轮（落实主设计者裁决 C1～C8）

依据：主设计者裁决 C1～C8；平台评审的统一取值（档位名 `atl/<labId>`、标签、实例发现键等）；卡片审稿中本文的 open_issues；04 第 2 轮定稿的 `atl.lab/v2`。

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| V3-1 | 文首、§0 | 文档定位改为“学习路径、掌握度、徽章、路径证书与路径数据文件的权威 + 卡片模型基本规则”；写明与 05、04、01、06 的分工；决策表按 C2、C3 改写（T4、T5、T8、T12、T13） | C1、C2 |
| V3-2 | §1.2、§1.4、§1.5、§1.6 | 起始状态改为 L0 + iam(role) + 闭包（svc-ec2、svc-iam 除外），由 `plan --start-of` 推导，不用 `single/<id>`；背景模块去掉 `control-plane` 一类；目标写法改用 04 的 `driver`/`fromDriver`/`set`/`params`；预检型分支改为 `startProfile.variants[]`（`select: preflight`）；档位名按 01 定为 `atl/<card-id>/<variant>`（默认变体 `default`）；SSH 基线由 `workstation.sshFromWorkstation` 驱动、占位符拆分；标签增加 `atl:env-id` 与模块栈的 `atl:component=env`；§1.6 改为 05 目录总则的摘要 | C3、C4(d)、C5，04 §3.2.3～3.2.5 |
| V3-3 | §2、§3 | 删除两张总表与 16 张场景卡的逐卡要点（移交 05 §4 与 scenario-cards）；§2.2 分支表按 C3 更新；§3.2 改为“场景卡对服务格的计入”一览；§3.3 给出 C-1～C-13 的处理状态，新增 C-14（sc-security-baseline 的 iam） | C2、C3 |
| V3-4 | §4 | §4.2.1 的 Lab → 卡片映射改为指向 05 §5，保留与路径编排有关的说明；secure 路径对 sc-security-baseline 的说明按 C3 改写 | C2 |
| V3-5 | §5 | 徽章“只看完成、小测只记录”的表述按 C3；写入字段、接口与事件改为引用 01、04；路径证书补齐 04 §10 的条件与 `superseded`；白名单发布前提更新为剩余缺口；徽章图形移交 05 §2.10（§5.8 留指针） | C1、C3 |
| V3-6 | §6 | 目录页信息架构移交 05 §2，留下原小节 → 新位置的对照表 | C2 |
| V3-7 | §7 | `lab.yaml` 字段以 04 为准，给出旧写法对照与两个 v2 示例；保留并补充路径文件 `atl.track/v2` 的定义与校验；`taxonomy.yaml`、`catalog.yaml`、生成的档位文件与 `reuseFrom` 规则移交 05 §8；推导与校验改为引用 06 与 04 DRV；lint 对照 04 §3.5 | C2、C3 |
| V3-8 | §8、§9 | 回写清单改为状态表（W-01～W-04 已落实项、仍待项）；新增 §8.7 仍需配合的 5 项；新增 P-22～P-25 与第 2 轮问题的状态 | C1～C5 |
| V3-9 | §2.2、§4、§3.3、§7、§8、§9 | 与同轮改写的 05 对齐：svc-ami 时长 135 分钟及三条路径的全部时长；svc-tls 回退档不含 `DNS_PROVIDER=external`（05 D-15）；服务格 id 以 05 taxonomy 为准；`reuseFrom`、生成档位文件、徽章图形移交 05；记录与 05 D-8（sc-security-baseline）、04 档位名的分歧 | C1、C2 |

**未采纳的意见**：tracks 审稿 open_issues 中“`plan --targets` 支持同一模块两段取值”“registry 的 `remedy` / `singleLocalSettings`”“`app-stat` 的 `runId`”属于 CloudAlbum 侧实现，本文只登记为 06 的前置（§8.7 第 5 条），不在本文展开；“sc-db-performance 的卡内串行等待”“sc-analytics 改为必做后的时长”“`ec2messages` 是否仍需”需要真实环境实测，留给 07 的验证计划。

---

## 审稿修订记录

### 2026-10-13 · 第 2 轮（对抗式审稿）

审稿范围：逐卡核对 startProfile 闭包（对照总纲 §3.2、§5.2、§10.4 与各模块文档）、检查的可实现性与可伪造性（对照 04 §5.2.3 的目标枚举、§5.7 白名单与各模块的 `X-CloudAlbum-Path` 词表）、对比实验是否存在于模块文档与时间上限、AWS 事实、id / 字段 / 费用档位 / 难度是否符合约定。本文不含小测题（小测在逐卡文档中），所以第 5 项只核对了 §7.7 第 5 条与 scenario-cards.md 的题量。本文只修改了自身；对 01～05、总纲与逐卡文档的要求写在 §3.3、§8。

**核对结论（未发现问题的部分）**：本文引用的对比实验在模块文档的 `experiments` 列表中全部存在；单服务卡的硬依赖闭包除下列 R-1、R-2 外均与总纲 §5.2、§10.4 一致，凭证前置（`credentials: required` → iam）没有多也没有少；svc-waf 选 cdn、svc-autoscaling 选 storage、svc-identity-pool 选 cognito、svc-db-proxy 选 secrets 四个分支选择有据；saa-main 恰好覆盖 56 张卡片（必修 35 + 5 个选修组）；各路径的卡片数与 id 正确。

| # | 位置 | 问题 | 修正 |
|---|---|---|---|
| R-1 | §3.2.8、§7.2 示例 2、§7.6 | `SECRETS_ORIGIN=bundle` 写进 sc-ha-web 起始状态；它由 enable autoscaling 写入，引导配置包不存在时单实例读不到机密 | 改为随 autoscaling 目标写入（P-17） |
| R-2 | §2.1、§2.2 | svc-tls 回退档选“外部 DNS”，却没有写本地设置 `DNS_PROVIDER=external`，DEP-005 ③ 不满足 | 补上 |
| R-3 | §2.1 | 声称 28 张“与批次 1、2 一致”，实际有 13 张（svc-cdn、svc-dns、svc-load-balancer、svc-autoscaling、svc-identity-pool、svc-config、svc-storage、svc-database、svc-social-store、svc-analytics、svc-image-processing、svc-notification、svc-tagging）的难度、时长、部署等级或费用显示不同；E、F 组 12 张暂定值与已存在的第 3 批有 9 张不同（含 svc-tracing、svc-db-proxy 的本地档） | 全部按逐卡文档同步；合计时长 3000 → 2955 分钟 |
| R-4 | §1.6、§2.1 | 难度违反 05 §2.7.1：svc-storage、svc-notification、svc-tagging 定为入门，svc-database 定为中级，svc-cdn、svc-dns、svc-load-balancer、svc-audit 定为初级 | 改正（P-20） |
| R-5 | §1.6、§2.1、§7.6 | 部署等级定义漏了 Cognito，svc-autoscaling（RDS + ALB）定为 C，与 02 §11.2、第 1 批的 D 不符 | 定义按 02 §11.1 改写；svc-autoscaling 改为 D，svc-identity-pool 改为 B |
| R-6 | §1.2、§2.1 | 标题 ≤ 40 字、机能 ≤ 8 字的规则被本文自己的标题打破（svc-shell-access 49 字，svc-config 41 字；多张机能超过 8 字） | 标题 ≤ 48 字、机能 ≤ 12 字；svc-shell-access 标题与第 3 批一致 |
| R-7 | §3.1、§3.2 | 场景卡元数据是目录层自拟的，与已存在的 scenario-cards.md 有 12 张时长、5 张起始模块集合、2 张费用档位、1 张部署等级不同，且声称逐卡设计“另行编写” | 同步；规则冲突列入 §3.3（C-1～C-13）；合计 2025 → 1815 分钟 |
| R-8 | §3.2.13、P-2 | 用户指定的“S3 跨区域复制”被降为只讲解 | 采纳 scenario-cards.md 的 `extraStacks`：CRR 必做，RDS 跨区域副本选做；本文模型增加 `extraStacks`（§1.5、§7.2）与对应回写（W-01-10、W-02-8、W-04-9） |
| R-9 | §3.2.15 | Spot / Graviton 只作讨论，用户指定的组合没有亲手操作 | 采纳 scenario-cards.md：extraStack 基准机群 + `rebuild-instance`；费用改为中（选做 → 高） |
| R-10 | §3.2.10、W-02-4 | sc-private-network 依赖 `profile apply --fresh`，而 02 §11.4 明确不在 v1 范围；阶段 B 删除 NAT 有切断平台管理通道的风险 | 改为 v1 的实例替换（B 级）；必做保留 NAT，`endpoint-only` 选做；补方案 B 关、`sshFromWorkstation`（公网出口 /32） |
| R-11 | §3.2.3 | `image-processing=lambda:queued` 不在 04#image-processing 的结果词表中（应为 `lambda:async`）；POST / 异步段用了 `HTTP` 检查；主要步骤写成 buffer-queue 链路；“失败队列的重驱策略”概念错误 | 改为 `LOCAL path-seen` + `events:*` + `lambda:GetFunctionEventInvokeConfig`；链路按默认 `IMAGE_TRIGGER=eventbridge` |
| R-12 | §3.2.4 | sc-decoupling 要求 Lambda 从缓冲队列消费，却没有写 `IMAGE_TRIGGER=buffer-queue`（模块默认是 eventbridge 直接异步调用） | 补上，并增加 `lambda:ListEventSourceMappings` 检查 |
| R-13 | §3.2.2 | 用 `HTTP` target public-ip“直连被拒”判定锁源站：停掉 Nginx 也能通过，不可靠；cdn 预置在起始状态使 CloudFront 不是学员亲手搭建 | 改为安全组规则 + 本机无校验头探测；cdn 改为目标、起始 A 级，iam 作为 `control-plane` 背景模块 |
| R-14 | §3.2.6 | 401 检查无法区分网关与 Express；“模块文档只在 lambda 集成写了 jwt”与 04#social-api 组合矩阵第 3 行不符；“IP 证书能否作回调地址未核实” | 增加 nonce 未到达 EC2 的佐证；删除错误疑问；按 CreateUserPoolClient API 参考核实回调地址规则（P-9 下调为低） |
| R-15 | §3.2.7 | `dynamodb:DescribeTable` 不含 TTL；lambda 集成下平台拿不到路径头 | 改为 `DescribeTimeToLive`、网关 401 + `apigw-requestid` + 集成类型；增加选做 queue 消除 DEP-025 |
| R-16 | §3.2.11 | 场景写“数据库密码可以轮换”而起始是 SQLite；`DescribeSecret`（已配置轮换）与手动轮换不符；`DescribeComplianceByConfigRule` 看不到单个金丝雀，且 must-hold 会因修复而漂移 | 改写场景与检查 |
| R-17 | §3.2.16 | 必需检查 `inspector2:ListFindings`（金丝雀语言包）在会话内通常等不到：Linux 深度检查默认每 6 小时采集一次应用清单（Inspector 用户指南，2026-10-13 核实） | 改为覆盖状态 + coverage-matrix 对照；金丝雀包选做；顺序与 scenario-cards.md 一致 |
| R-18 | §3.2 多卡、§8.5 | 多个 aws-readonly 动作不在 04 §5.7 白名单且未标注（config、inspector2、glue、`backup:ListCopyJobs`、`route53:GetHealthCheckStatus`）；`s3:GetBucketLifecycleConfiguration` 用了 SDK 名 | 标 [白名单+]，新增 W-04-9 与 §5.3 发布前提（P-16）；改用 IAM 动作名 |
| R-19 | §3.2.5、§3.2.12 | 订阅是否确认可以用 `sns:ListSubscriptionsByTopic` 自动判定，却写成原生手动 | 改为自动检查，手动只保留无法自动判定的“邮件到达时刻” |
| R-20 | §5.1、§5.2、§7.2、W-02-5 | 徽章要求小测 ≥ 70 分；复用环境中“完成但不授予徽章”——都与“完成单张卡片获得徽章”冲突 | 完成即授予，小测只记录；目标已生效的卡片不能在该环境开始（P-21） |
| R-21 | §4.2.1、§4.3、§3.2.15 | 写“svc-cost 中激活成本分配标签”，而第 3 批把激活定为需提前 24～48 小时执行的平台动作 | 改为路径开始前执行平台动作 `cost-activate-tags` |
| R-22 | §1.5 规则 4 | capability 判定“detail 含‘无凭证’”会误判 DEP-013、DEP-018、DEP-030 等预期警告，也会放过意外警告 | 改为 `acceptedWarnings` 集合判定（与第 1 批审稿修订一致） |
| R-23 | §7.6 | 单服务卡的本地档调整与 `lab.faults` 热键不在 registry 中，`plan --single` 算不出，DRV-1 必然失败；档位格式没有运行时热键与卡片自带栈的位置 | registry 增加 `singleLocalSettings`、`singleRuntime`（X-1）；档位文件增加 `PROFILE_RUNTIME`、`PROFILE_EXTRA_STACKS` |
| R-24 | §7.7 | “场景卡 2～5 个目标”使 sc-analytics、sc-cost-optimization 无法通过 lint；`creditBy` 不允许以对比实验为证据，也没有排除只描述起始状态的检查 | 改为 1～5 个目标且“目标 + creditBy 服务”≥ 2；补第 9、10 条 |
| R-25 | §3.2.8 | sc-ha-web 卡内把 RDS 改为 Multi-AZ，等待叠加在 ASG 引导上；RDS 作为主服务计入，却没有学员亲手操作的证据 | 与 scenario-cards.md 一致：Multi-AZ 预置（`shorten-wait`），RDS 经 `creditBy` 故障转移演练计入；时长 150 / 240 |
| R-26 | §4 | 路径时长随上述同步全部变化 | 用脚本重算：saa-main 3105 / 4770 分钟，其余见 §4.1 |
| R-27 | §7.2 | `schema: atl.lab/v1.1` 与第 1、3 批的 `atl.lab/v2` 不一致；字段有不兼容变化 | 改为 `atl.lab/v2` |

**已核实的 AWS 事实（2026-10-13）**：Cognito App Client 回调地址要求绝对 URI、HTTPS（localhost / 127.0.0.1 / [::1] 例外）、不含片段（CreateUserPoolClient API 参考）；Inspector 对 Linux EC2 的深度检查默认每 6 小时采集一次应用清单（Inspector 用户指南“Deep inspection”）；CloudFront VPC Origin 在 ap-northeast-1 不支持 AZ `apne1-az3`（CloudFront 开发者指南“VPC origins”）。

**仍未解决、需要实现前验证或由其他文档决定的事项**：P-2 的灾备区域权限边界（W-01-10）、P-16 的白名单扩充（W-04-9）、P-4 的 registry 数据化（X-1）是上线前提；§3.3 C-1～C-13 需要逐卡文档修改；sc-db-performance 的卡内串行等待（P-5）与各卡时长需平台积累实测后校准；sc-analytics 改为 parquet 必做后的时长需实测。

### 2026-10-13 · 第 4 轮（跨文档审计后的状态同步）

- 本文的模型与数据不变；只同步 §8.7 第 1、2、3、6 条与 W-01-2、W-01-9、W-01-10、C-14、P-22、P-23、P-25 的状态：档位名与 `startProfile.variants[]`（04、02）、徽章小测字段（01 采纳 04）、卡片自带栈的启用与栈名（01、02、scenario-cards）、sc-security-baseline 预置 iam（05 改为与本文一致）、05 §4.7 的灾备区域说法均已在同一轮落实。
- **没有采纳的意见**：无。**仍需其他文件配合**：§8.7 第 4、5 条（不在本轮范围）。
