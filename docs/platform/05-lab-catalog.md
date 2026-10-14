# ATL 平台设计 05：卡片目录（权威）

> **文档定位**：AWS Training Lab（ATL，中文“实验平台”）平台设计的第 05 篇，**卡片目录的唯一权威**。定义：目录页的信息架构（卡片网格、服务地图、路径视图、筛选维度、卡片视觉字段）；56 张卡片（40 张单服务卡片 + 16 张场景卡片）的元数据汇总表；原 Lab 0～25 到卡片 id 的映射；目录总则（难度、时长、费用档位、部署等级的判定）；分类法（服务格、缩写、类别）；目录数据文件、构建产物与目录 API 的响应；卡片简介页的模板。
>
> **状态**：设计稿 · 第 2 轮 · 2026-10-13。按主设计者裁决 C1～C8 由“Lab 0～25 的实验目录”改写为“卡片目录”。第 1 轮的审稿修订见 §10.1～§10.4，本轮改动见 §10.5。
>
> **同组文档**（只引用主题，不在本文展开）：
> - [01-architecture](01-architecture.md)：**唯一的名称表**（实体、DynamoDB 键、API 路由、函数、状态机、`ATL_OP`、角色、标签、事件名）、一键安装与卸载、IAM 角色与权限边界。
> - [02-lab-lifecycle](02-lab-lifecycle.md)：会话状态机、报价与费用确认、开始与结束两条短编排、起始档位的解析（§3.6）、倒计时、保留与复用、回收器。
> - [03-workspace-terminal](03-workspace-terminal.md)：分屏工作台、实验机终端与工作台终端、控制台联合登录、应用预览。
> - [04-lab-format-checks-reports](04-lab-format-checks-reports.md)：`lab.yaml` v2（以卡片为单位）、手册、检测引擎、对比实验、进度、报告与证书的**格式**。
> - [06-cloudalbum-platform-mode](06-cloudalbum-platform-mode.md)：平台模式下 CloudAlbum 侧的唯一清单（`scripts/module plan --start-of`、测试数据种子、实验变体标签等）。
> - [07-aws-verification-plan](07-aws-verification-plan.md)：需要真实 AWS 才能确认的事项。
> - [cards/](cards/)：卡片模型（用户已确认）。[tracks-and-catalog.md](cards/tracks-and-catalog.md) 定义卡片 id 规则、学习路径、掌握度、徽章与路径证书的**模型**；[service-cards-1](cards/service-cards-1-base-edge-identity.md)、[service-cards-2](cards/service-cards-2-data-compute.md)、[service-cards-3](cards/service-cards-3-ops-governance.md)、[scenario-cards.md](cards/scenario-cards.md) 定义每张卡片的步骤、检查、手册与小测。
>
> **约定**：“学员”指平台的使用者；“实验机”指平台为会话创建的 CloudAlbum EC2；“工作台”指每个会话的 workstation EC2；“L0”即档位 `l0-ec2`。不写价格与精确的性能数字，费用只写档位（低 / 中 / 高）与主要计费来源；不确定的 AWS 行为写“以官方文档为准”。文档语言为简体中文，技术名词保留英文。

---

## 目录

- [0. 摘要：关键决策](#0-摘要关键决策)
- [1. 范围、术语与权威来源](#1-范围术语与权威来源)
- [2. 目录页信息架构](#2-目录页信息架构)
- [3. 目录总则：难度、时长、费用档位、部署等级与起始状态](#3-目录总则难度时长费用档位部署等级与起始状态)
- [4. 56 张卡片的元数据汇总（权威）](#4-56-张卡片的元数据汇总权威)
- [5. 原 Lab 0～25 → 卡片映射](#5-原-lab-025--卡片映射)
- [6. 学习路径、掌握度、徽章与证书（引用）](#6-学习路径掌握度徽章与证书引用)
- [7. 卡片简介页](#7-卡片简介页)
- [8. 目录数据、构建产物与 API](#8-目录数据构建产物与-api)
- [9. 与其他文档的接口与待配合事项](#9-与其他文档的接口与待配合事项)
- [10. 审稿修订记录](#10-审稿修订记录)

---

## 0. 摘要：关键决策

| # | 决策 | 理由 |
|---|---|---|
| K1 | 目录的基本单位是**卡片**：40 张单服务卡片（`kind: service`，id `svc-<module-id>`）+ 16 张场景卡片（`kind: scenario`，id `sc-<slug>`）= 56 张，每张都能单独开始、单独完成。原 Lab 0～25 与 5 个扩展 Lab 不再是目录条目，而是学习路径 `saa-main` 中的步骤（§5） | 主设计者裁决 C2；用户已确认卡片模型 |
| K2 | 本文是卡片目录的**唯一权威**：目录页信息架构、56 张卡片的元数据汇总、原 Lab → 卡片映射、目录总则、分类法、目录数据与构建产物、目录 API 的响应。学习路径、掌握度、徽章、证书的模型只引用 tracks-and-catalog（§6）；`lab.yaml` 的格式只引用 04；名称只引用 01 | C1、C2：同一事实只写一次 |
| K3 | §4 的汇总表是 `lab.yaml` 的**摘要与期望值**，不是第二个事实来源：构建时 `labs:catalog` 从 `lab.yaml` 与 `scripts/module plan --start-of` 生成 `catalog.yaml`，CI 把计算结果与 `lab.yaml` 中作者声明的期望值比对（§8.7 C-7），而作者按本文 §4 填写声明。本轮的取值逐项取自 cards/ 各文件；文件之间或与裁决冲突之处（16 处）按 §4.5 裁决，并列出待同步的文件 | 目录与卡片不能各说各话 |
| K4 | **起始状态 = L0 + iam(role) + 目标模块硬依赖的闭包**；`svc-ec2`、`svc-iam` 不预置 iam。由 `scripts/module plan --start-of <card-id>` 推导，不直接用 `single/<id>`（它包含目标模块本身）。生成档位 `atl/<card-id>/<variant>`（默认变体 `default`） | C3；02 §3.6 |
| K5 | 目录页三种视图：**卡片网格**（默认）、**服务地图**、**路径视图**；考试领域从视图改为筛选与分组方式。筛选维度：类型、服务、考试领域、难度、时长、费用档位、完成状态，外加开关“只看无需人工前置” | 卡片从 31 个 Lab 增加到 56 张，按服务查找成为主要需求 |
| K6 | 卡片视觉字段：类型标记、类别色条、标题（单服务卡“服务：机能”，场景卡“场景名 + 服务组合”）、服务缩写方块、一句话简介、难度、预计时长与上限、费用档位、环境准备（部署等级的定性说明）、提示标记（≤ 3 个）、完成状态与尝试次数、徽章位。**不使用 AWS 官方图标** | 一眼看清“是什么、多难、多久、多贵、做没做完” |
| K7 | 难度四级 `intro`、`beginner`、`intermediate`、`advanced`（入门 / 初级 / 中级 / 高级）；入门只用于不启用任何 AWS 模块的卡片（只有 `svc-ec2`）；**场景卡至少中级**。时长的取整规则不变 | 04 的 `difficulty` 引用本文的目录总则 |
| K8 | 费用档位按**计费结构**判定（基础之外的按小时计费单位数 + 是否开启账号级按量服务），不看单价；部署等级由起始状态推导。两者都在构建期计算，与作者声明不一致时构建失败 | P13 不编价格；档位跨区域、跨价格表稳定 |
| K9 | 卡片简介页是**开始实验的唯一入口**；场景卡多一个“场景”区块；有学员可选的起始变体时，在“开始实验”按钮旁选择变体 | 开始前必须看到费用说明与起始状态 |
| K10 | 平台占位符四个：`${atl:workstationPrivateCidr}`、`${atl:workstationPublicCidr}`、`${atl:drRegion}`、`${atl:platformOrigin}`。第 1 轮的 `${atl:workstationCidr}` 在 02/03（私网）与 05（公网）中含义不同，**废止** | 一个占位符不能有两种含义（tracks-and-catalog §3.3 C-13） |
| K11 | 平台默认的 HTTPS 方案（方案 B：Let's Encrypt IP 短期证书，供预览嵌入）对绝大多数卡片开启；起始状态或目标含 autoscaling（ASG-014）、以 tls 为目标、或切换到 private 放置的卡片**关闭**，共 5 张（§4.6） | C5；ASG-014 不可覆盖 |
| K12 | 目录只用 01 名称表中的路由：`GET /api/v1/catalog`、`GET /api/v1/labs`、`GET /api/v1/labs/{labId}`、`POST /api/v1/labs/{labId}/quotes`、`GET /api/v1/me/mastery`、`PATCH /api/v1/me`。卡片 id 就是 `labId`。本文不新增实体与事件 | C1；tracks-and-catalog T2：技术标识沿用 lab |

---

## 1. 范围、术语与权威来源

### 1.1 本文负责与不负责

| 本文负责 | 不在本文（见） |
|---|---|
| 目录页、服务地图、路径视图、卡片简介页的信息架构、字段、状态与交互 | 平台前端的全局框架与视觉基线（01、03；视觉 token 沿用 ui-design §11，见 C6） |
| 56 张卡片的元数据**汇总与期望值**：标题、kind、难度、时长、时间上限、起始状态、目标、费用档位、部署等级、人工前置 | 每张卡片的步骤、检查、手册、小测（cards/ 各文件）；`lab.yaml` 的**格式**（04 §3） |
| 原 Lab 0～25 与扩展 Lab → 卡片 id 的映射（`saa-main` 条目的 `legacyLab` 由此生成） | 路径清单、阶段、必修与选修、证书条件（tracks-and-catalog §4）；掌握度、徽章、路径证书的模型（tracks-and-catalog §5） |
| 目录总则：难度、时长、费用档位、部署等级的判定规则与算法 | 报价金额、价格来源、费用确认对话框（02 §3.2、04 §3.4） |
| 分类法 `taxonomy.yaml`：类别、服务格 id、缩写、`iamPrefix`、考试领域、时长分段、费用档位参数、模块部署速度 | 证书签名、验证与吊销（04 §10） |
| 生成的 `catalog.yaml`、构建产物 `index.json` / `cards/<id>.json`、目录相关的 lint | `scripts/module plan --start-of` 的推导算法与命令格式（06）；起始档位在开始编排中的解析（02 §3.6） |
| 目录 API 的响应字段与缓存 | 路由、实体、错误码的**名称**（01 名称表） |

### 1.2 术语

| 术语 | 含义 |
|---|---|
| 卡片 | 一个可以单独开始、单独完成的小实验，对应 `labs/<card-id>/`。技术标识沿用 lab：卡片 id 就是 `labId`，`LabSession`、`LabProgress`、`/api/v1/labs/*`、标签 `atl:lab-id` 都不改名，界面上称“卡片” |
| 单服务卡片（`kind: service`） | 只讲一个模块（一个主 AWS 服务）的“有 vs 没有”。每个模块一张，另有 ec2 基线一张，共 40 张 |
| 场景卡片（`kind: scenario`） | 2～5 个服务一起解决一个真实场景，写法接近 SAA 场景题，共 16 张 |
| 服务格 | 服务地图上的一格。一格 = 一个模块 = 一个“服务：机能”，共 40 格（tracks-and-catalog §1.1） |
| 起始状态（`startProfile`） | 点“开始实验”后平台自动部署的状态：L0 + iam(role) + 目标模块硬依赖的闭包（C3），场景卡另有写明理由的背景模块与卡片自带栈。`lab.yaml` 用 `startProfile.provisions` 逐项列出（04 §3.2.3） |
| 目标（from → to） | 学员在卡内亲手完成的切换。`lab.yaml` 写作 `targetModules[]{id, driver, fromDriver?, set?, params?}`（04 §3.2.4）；本文表格写成“`开关` 起始取值 → 目标取值” |
| 起始变体 / 回退档 | 同一张卡片的另一种起始状态：学员开始前选择的（sc-ha-web 的 `efs`），或账号预检按探测结果选择的（svc-tls 的 `acme-off`）。同一卡片的所有变体共用一个徽章（04 §3.2.3） |
| 实验变体标签 | 对比实验的 `--label <变体>`（例如 `before`、`after`、`l0`、`unsafe`），结果中标注 `variant`（04 §3.2.10、06）。与“起始变体”无关 |
| 部署等级（`provision.class`） | A～D，决定开通与回收预算（02 §11.1）；本文 §3.4 给出由起始状态推导的规则 |
| 费用档位（`cost.tier`） | 低 / 中 / 高，按计费结构判定（§3.3）；选做步骤抬高档位时写“低（选做 → 中）” |
| 预期警告（`expectedWarnings`） | 卡片声明的、设计上预期出现的 warn 级规则；只由它们导致的 `degraded` 视为正常（C3、04 §3.2.5） |
| 账号级影响 | 改变账号或区域级单例与设置的操作（GuardDuty 检测器、Config 记录器、Inspector 激活、`SSM-SessionManagerRunShell`、成本分配标签、Backup 区域设置等），`lab.yaml` 的 `platform.accountImpact` |
| 平台动作 | 01 的 `module-ops`：学员权限边界不允许、或需要平台配套处理的操作，由平台代为执行；只有卡片 `platformOps` 中声明的才能调用，请求体只带 `actionId` |
| 学员输入 | 开始前由学员填写、平台无法代办的前置（`prerequisites.learnerInputs`，取值集合以 04 为准：`domain`、`hosted-zone`、`ses-identity`、`notify-email`、`recipient-emails`、`alert-email`、`budget-amounts`、`cost-tags-active`） |
| 路径 / 阶段 / 选修组 | tracks-and-catalog §4 的学习路径模型；本文只定义它们在目录页上的呈现 |
| 徽章 / 路径证书 | 完成单张卡片即获得徽章（小测成绩只记在徽章上）；完成路径获得签名的路径证书（tracks-and-catalog §5） |

### 1.3 权威来源与冲突处理

| 内容 | 权威来源 | 本文的做法 |
|---|---|---|
| 实体名、API 路由、标签、错误码、档位名 | 01 名称表（C1） | 只引用；本文需要的新名称列在 §9.1，由 01 收录 |
| `lab.yaml` 字段名与 schema | 04 §3（v2） | 只引用；目录读取的字段见 §8.1 |
| 学习路径、掌握度、徽章、路径证书的模型 | tracks-and-catalog §4、§5 | 只引用（§6） |
| 每张卡片的取值（标题、难度、时长、起始状态、目标、费用、人工前置、部署等级） | cards/ 逐卡文档的元数据表 | §4 逐项汇总 |
| 模块依赖与规则 | modular-design 第 5、10 节；`docs/modules/*.md` | 由 `plan --start-of` 推导，本文不手算 |
| 起始档位的解析与健康门 | 02 §3.6 | 只引用 |

**取值冲突的处理顺序**：主设计者裁决 C1～C8 → 01 名称表 → 04 字段格式 → tracks-and-catalog 的模型与裁决（§1、§3.3）→ 逐卡文档。§4 的取值等于逐卡文档的取值，除非前面几项有明确的不同规定；所有这类差异都列在 §4.5，由逐卡文档同步，同步之前以 §4 为准。

---

## 2. 目录页信息架构

### 2.1 页面与路由

路由沿用第 1 轮的 `/labs`（卡片 id 就是 `labId`，K12）；视图、分组、筛选、排序全部写进查询串，可分享、可后退。

| 路由 | 页面 | 说明 |
|---|---|---|
| `/labs` | 卡片目录，默认“卡片网格”视图 | 平台首页。有活动、保留中或释放未完成的环境时，页顶显示环境条（§2.2） |
| `/labs?view=map[&cell=<服务格 id>]` | 服务地图（§2.5） | `cell` 打开该服务格的侧栏（与卡片网格的服务筛选参数 `svc` 区分） |
| `/labs?view=tracks&track=<trackId>` | 路径视图（§2.6） | 默认取学员的当前路径 |
| `/labs/:cardId` | 卡片简介页（§7） | **开始实验的唯一入口**。目录中的卡片上没有“开始”按钮：开始前必须看到起始状态与费用说明 |
| `/tracks/:trackId` | 路径详情 | 与路径视图共用组件，多出证书区与历史；路径内容的模型见 tracks-and-catalog §4 |
| `/workspace/:sessionId` | 工作台 | 03；从简介页开始实验或从环境条“回到工作台”进入 |

全局导航（框架由 01、03 定义）中与本文有关的入口：“卡片目录”（`/labs`）、“学习路径”（`/tracks/<当前路径>`）、“我的实验”（会话列表，01 `GET /api/v1/sessions`）。导航栏左侧固定显示“ATL 实验平台（非 AWS 官方）”。

### 2.2 目录首页（桌面，≥ 1280px）

```text
 ATL 实验平台（非 AWS 官方）   卡片目录   学习路径   我的实验                          [搜索卡片、服务、考点、Lab 编号…  ]
 ┌ 当前环境 ─────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ svc-database · Amazon RDS for PostgreSQL · 实验中 · 剩余 01:12:40 · $$$ 高 · 按小时计费 2 项    [回到工作台] [结束实验] │
 └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 继续学习  SAA 主线 · 阶段 6 · 必修 21/35 · 当前环境之后推荐：svc-cache（中级 · 约 90 分钟 · $$ 中）            [查看 →]

 视图 (•) 卡片网格  ( ) 服务地图  ( ) 路径                          分组 [按类型 v]    排序 [推荐顺序 v]
 类型  [单服务 40] [场景 16]        领域  [安全] [弹性] [高性能] [成本]   [ ] 只看主领域
 难度  [入门 1] [初级 14] [中级 32] [高级 9]       时长  [≤ 1 小时 17] [1～2 小时 35] [> 2 小时 4]
 费用  [$ 低 38] [$$ 中 11] [$$$ 高 7]             状态  [未开始] [进行中] [已完成] [未完成]
 服务  [选择服务… v]  已选：SQS ×                   [ ] 只看无需人工前置                显示 5 / 56 张   [清除筛选]

 ── 单服务卡片 · D 计算、异步与通知 ──────────────────────────────────────────────────────────
 ┌──────────────────────────────────┐
 │▌单服务 · D 计算、异步与通知  初级 ▮▮▯▯ │
 │ ┌───┐ Amazon SQS                   │
 │ │SQS│ 异步任务队列与死信队列          │
 │ └───┘                              │
 │ 把后台任务从内存队列换成 SQS + DLQ，  │
 │ 中途 kill -9 worker 也一个不丢……      │
 │ 约 60 分钟 · 上限 1.5 小时             │
 │ $ 低 · 环境准备较快                   │
 │ ● 已完成 · 尝试 2 次          [SQS]✓ │
 └──────────────────────────────────┘
 ── 场景卡片 ─────────────────────────────────────────────────────────────────────────────────
 ┌──────────────────────────────────┐ ┌──────────────────────────────────┐ ┌──────────────────────────────────┐
 │ 场景 · 包含 4 个服务     中级 ▮▮▮▯ │ │ 场景 · 包含 3 个服务     中级 ▮▮▮▯ │ │ 场景 · 包含 3 个服务     中级 ▮▮▮▯ │
 │ 削峰与重试                         │ │ 事件扇出与通知                     │ │ Serverless API                   │
 │ SQS + EC2 worker + Lambda + DLQ  │ │ SNS + SQS + SES                  │ │ API Gateway + Lambda + DynamoDB  │
 │ 突发上传也不丢任务，坏消息……         │ │ 一条评论同时触发通知、邮件……         │ │ EC2 宕机时评论照常可用……            │
 │ [SQS] [λ] [EC2] [EB]               │ │ [SNS] [SES] [SQS]                 │ │ [APIG] [λ] [DDB] [SQS]┆          │
 │ 约 90 分钟 · 上限 2.5 小时           │ │ 约 75 分钟 · 上限 2 小时             │ │ 约 90 分钟 · 上限 2.5 小时           │
 │ $ 低 · 环境准备较快                  │ │ $ 低 · [需要邮箱确认]               │ │ $ 低 · 环境准备较快                  │
 │ ○ 未开始                 ⬡ 未获得   │ │ ◐ 未完成 · 尝试 1 次     ⬡ 未获得   │ │ ○ 未开始                 ⬡ 未获得   │
 └──────────────────────────────────┘ └──────────────────────────────────┘ └──────────────────────────────────┘
 ── 其他学习路径 ─────────────────────────────────────────────────────────────────────────────
 [点名对比快速路径 3/7 · 证书未领取]  [安全专项 2/12]  [弹性专项 1/10]  [Serverless 应用 4/9]  …
```

（筛选条中的计数是“全部 56 张、不加其他条件”时的值，取自 §4.4；选中服务 SQS 后结果为 svc-queue 与 4 张以 SQS 为 primary 或 supporting 的场景卡。`┆` 表示选做目标对应的服务，用虚线框。）

页面由 6 个区块组成：

| 区块 | 组件 | 出现条件 | 内容 |
|---|---|---|---|
| 环境条 | `EnvironmentBar` | 存在非终态会话、`KEPT` 环境或 `CLEANUP_FAILED` 残留（一个安装同一时刻只有一个环境，02 §3.4 的 `ActiveEnvironmentLock`） | 卡片 id 与标题、状态、剩余时间或保留截止时间、费用档位、按小时计费资源数；按钮随状态变化（§2.9） |
| 继续学习条 | `ContinueStrip` | 始终 | 当前路径（`Learner.currentTrackId`，默认 `saa-main`）的进度与推荐的下一张卡片（§2.11） |
| 工具栏 | `ViewSwitch`、`GroupSelect`、`SortSelect`、`SearchBox` | 始终 | 视图、分组方式、排序、搜索 |
| 筛选条 | `FacetBar` | 卡片网格视图；服务地图只保留“类型”“领域”“状态” | 七个维度 + 两个开关，每个取值带计数（§2.7） |
| 分组列表 | `CardSection` × N、`CardTile`、`CardRowCompact` | 卡片网格视图 | 按分组方式分区（§2.4） |
| 其他路径 | `TrackShelf` | 卡片网格视图底部 | 当前路径之外的路径进度与证书状态，点击进入 `/tracks/:trackId` |

### 2.3 三种视图

| 视图 | 用途 | 分组 / 布局 | 同一张卡片是否重复出现 |
|---|---|---|---|
| **卡片网格**（默认） | 浏览、筛选全部卡片 | 分组方式四选一：**按类型**（默认：先单服务卡片，按类别 基础 → A → F 分节；再场景卡片）、按服务类别、按考试领域、不分组 | 按考试领域分组时，卡片在其 `saa.domains` 的每个领域都出现：主领域放完整卡片，其他领域放紧凑行（标“也涉及”）；勾选“只看主领域”后只按主领域放置。其余分组方式不重复 |
| **服务地图** | 按服务查找卡片，查看自己的掌握度 | 7 行（基础、A～F）× 40 个服务格；点击服务格打开侧栏（§2.5） | 不适用 |
| **路径视图** | 按路径的阶段学习 | 路径选择器 + 阶段列表；卡片以紧凑行显示（§2.6） | 同一路径内不重复（tracks-and-catalog §7.7 第 7 条） |

成本优化考点分布在多个领域中；按考试领域分组时，“成本优化”分区默认同时显示主领域与次领域的卡片，勾选“只看主领域”后若该分区卡片过少，显示提示“成本优化考点分布在多张卡片中，取消‘只看主领域’查看”。

### 2.4 卡片网格

- **完整卡片**约 288 × 228 px；**紧凑行**高 40 px（领域分组的次领域、路径视图、服务地图侧栏中使用）：`[状态形状] svc-queue  Amazon SQS：异步任务队列与死信队列 · 初级 · 60 分钟 · $ 低`。
- 分节标题显示该节卡片数与“已完成 N / 总数”；按类型分组时，单服务卡片按类别分 7 节，节内按 taxonomy 的服务格顺序（与服务地图同序），场景卡片一节，节内按 §4.3 的编号。
- 卡片整体是一个链接，进入 `/labs/:cardId`；唯一的独立按钮是“回到工作台”，只在本卡持有环境时出现。
- 结果为空时显示“没有符合条件的卡片” + 当前条件摘要 + [清除筛选]（§2.12）。

### 2.5 服务地图

```text
 视图 ( ) 卡片网格  (•) 服务地图  ( ) 路径        图例：○ 未开始  ◔ 已接触  ◑ 已掌握  ● 熟练 · 虚线框 = 含手动 · ! = 需复习
 基础  ┌EC2 ◑┐
 A     ┌VPC ○┐ ┌CF ●┐ ┌R53 ○*┐ ┌ACM ○*┐ ┌WAF ◑┐ ┌ALB ◔┐ ┌ASG ○┐
 B     ┌IAM ●┐ ┌CUP ◑┐ ┌CIP ○┐ ┌SEC ◑┐ ┌PS ◑†┐ ┌KMS ◑┐
 C     ┌S3 ●┐ ┌EFS ○┐ ┌RDS ◔┐ ┌ELC ○┐ ┌DDB ◑┐ ┌BAK ○┐ ┌FH ○┐
 D     ┌λ ◑┐ ┌SQS ◑!┐ ┌SNS ◑┐ ┌SES ○┐ ┌SCH ○†┐ ┌REK ◑┐ ┌APIG ◔┐
 E     ┌SSM ◑┐ ┌CWL ◑┐ ┌CW ◑┐ ┌XR ○┐ ┌CT ○┐ ┌GD ○┐
 F     ┌CFG ○┐ ┌INS ○┐ ┌BUD ◑┐ ┌RDSP ○┐ ┌SFN ○┐ ┌IMB ○┐
 * 需要域名才能由场景卡计入   † 没有场景卡，“熟练”按单服务卡 + 小测判定（tracks-and-catalog §5.4）
```

- **服务格**（约 120 × 96 px）：缩写方块、服务短名、机能、进度环（掌握度分数）与等级文字（形状 + 文字，不只靠颜色），底行“单服务 ✓ · 场景 1/3”（已计入 / 可计入的场景卡数）。服务格的顺序、缩写、类别取自 `taxonomy.yaml`（§8.2）。
- **掌握度**的等级、分数、计入规则与“需复习”由 tracks-and-catalog §5.4、§5.6 定义；目录页只负责呈现，数据来自 `GET /api/v1/me/mastery`（§8.8）。助教与观察者看到的是学员的地图。
- **侧栏**（点击服务格或 `?cell=<id>`）：

```text
 ┌ Amazon SQS · 异步任务队列与死信队列 ─────────────────────────── [×] ┐
 │ 掌握度 ◑ 已掌握 · 62 / 100                                        │
 │   单服务卡 60 / 60（已核验）· 场景 0 / 25 · 小测 2 / 15              │
 │   ! 需复习：在 sc-observability（复用环境）中发现队列配置漂移           │
 │ 单服务卡    svc-queue · 初级 · 60 分钟 · $ 低 · ● 已完成              │
 │ 计入本服务的场景卡                                                  │
 │   sc-decoupling 削峰与重试 · 中级 · 90 分钟 · $ 低 · ○ 未开始          │
 │   sc-serverless-api（选做步骤）· 中级 · 90 分钟 · $ 低                 │
 │ 也出现在（不计入）                                                  │
 │   sc-event-fanout（收件队列）· sc-image-pipeline（失败与结果队列）     │
 │   · sc-observability（背景模块）                                    │
 │ 所在路径    saa-main · resilient · serverless · quick-compare        │
 │ 考点        可见性超时与至少一次投递 · 死信队列与重放 · 标准 vs FIFO     │
 │ 附属服务    —                                                      │
 └───────────────────────────────────────────────────────────────┘
```

  侧栏中“计入 / 也出现在”来自生成的 `catalog.yaml` 的 `serviceMap`（`creditedBy` 与 `appearsIn`，§8.3）；“附属服务”来自 taxonomy 的附属服务（例如 VPC 格列出 NAT 网关、VPC 终端节点；Firehose 格列出 Athena、Glue；Budgets 格列出 Cost Explorer；完整清单见 §8.2），附属服务不单独计算掌握度。
- 窄屏（< 768 px）改为按类别折叠的列表，每行一个服务格。

### 2.6 路径视图

```text
 路径 [SAA 主线 v]   必修 21/35 · 选修组 2/5 · 预计剩余约 28 小时 · 证书：未达成                     [设为当前路径]
 阶段 1 基线与运维（原 Lab 0～3）  6/6 ✓
   ● svc-ec2  ● svc-iam  ● svc-cost  ● svc-shell-access  ● svc-logging  ● svc-monitoring
 阶段 2 存储与边缘（原 Lab 4～7）  3/4
   ● svc-storage  ● svc-cdn  ◐ svc-waf   ◇ 选 1：○ sc-edge-protection / ○ sc-static-acceleration
   可选：○ svc-dns*  ○ svc-tls*                                   ↳ 可在 svc-storage 的保留环境中继续 svc-cdn
 阶段 3 …
```

- 路径、阶段、条目角色（必修 ●、选修组 ◇、可选 ○）、证书条件与时长汇总全部来自 tracks-and-catalog §4 的路径文件；本文只定义呈现。
- 每个阶段显示“原 Lab 编号”（§5 的映射，`legacyLabs`），方便对照 README 与 labs.md。
- 卡片以紧凑行显示：状态形状、id、标题、时长、费用；悬停或聚焦显示完整卡片。
- 相邻两张卡片满足 `reuseFrom`（§8.6）时，在后一张下方显示“↳ 可在 X 的保留环境中继续”；不满足的组合不显示。
- 证书区：逐条列出条件（必修、选修组、已核验占比，tracks-and-catalog §5.5），满足后出现“领取证书”（01 `POST /api/v1/certificates`，`{ scope: "track", trackId }`）。
- 窄屏下每个阶段默认折叠，只展开当前阶段。

### 2.7 筛选、搜索与排序

**筛选维度**

| 维度 | 取值 | 匹配规则 | 数据来源 | 查询串 |
|---|---|---|---|---|
| 类型 | 单服务、场景 | 等于 `kind` | `lab.yaml` | `kind=service,scenario` |
| 服务 | 多选；下拉按类别分组并可搜索（服务格 + 附属服务） | 卡片 `services` 中 `role ∈ {primary, supporting}` 的任一项属于所选集合（`context`、`observed` 不参与） | `lab.yaml` + taxonomy | `svc=sqs,lambda` |
| 考试领域 | 安全、弹性、高性能、成本 | `saa.domains` 包含所选领域；“只看主领域”时只比较第一个 | `lab.yaml` | `dom=secure&primary=1` |
| 难度 | 入门、初级、中级、高级 | 等于 `difficulty` | `lab.yaml` | `d=beginner,intermediate` |
| 时长 | ≤ 1 小时、1～2 小时、> 2 小时 | `estimatedMinutes` 落入的区间（≤ 60、61～120、> 120） | taxonomy 的时长分段 | `dur=short,medium,long` |
| 费用档位 | 低、中、高 | 必需步骤的档位 `costTier.required` | 构建期计算 | `cost=low,medium,high` |
| 完成状态 | 未开始、进行中、已完成、未完成 | §2.9 的映射 | `LabProgress` + 当前环境 | `st=not_started,in_progress,completed,incomplete` |

另有两个开关：**只看主领域**（考试领域维度的修饰）、**只看无需人工前置**（`nomanual=1`：隐藏 `prerequisites.learnerInputs` 中有必填项的卡片；域名为可选的场景卡不隐藏）。

**其他查询串**：`view`（`grid` | `map` | `tracks`）、`track`、`group`（`kind` | `category` | `domain` | `none`）、`sort`（`path` | `duration` | `cost` | `recent`）、`q`（搜索词）、`cell`（服务地图中打开的侧栏）。未出现的参数取默认值。

**规则**

1. 同一维度内取并集，不同维度之间取交集。
2. 每个取值旁的计数 = 其他维度保持不变时、选中该取值后的结果数；计数为 0 的取值置灰但仍可点。
3. 计数与结果在浏览器内计算（56 张卡片，无需服务端分页）；结果变化时，读屏通过 `aria-live="polite"` 区域播报“显示 5 / 56 张卡片”。
4. 上一次的视图、分组与筛选组合存在 `localStorage`（读写都包在 `try/catch` 中，不可用时照常工作）；URL 中有参数时以 URL 为准。

**搜索**：在浏览器内对预先拼好的索引做子串匹配（不分词、不区分大小写）。字段：标题、副标题、`service` 与 `function`、一句话简介、标签、服务全称与缩写、模块 id、场景卡的 `scenario.question`、SAA 考点标题、**原 Lab 编号**（输入“Lab 10”或“lab-10”命中 svc-queue 与 sc-decoupling，来自 §5 的映射）。命中的字段在卡片上高亮；只命中考点或 Lab 编号时，卡片底部显示“考点：……”或“原 Lab 10”。

**排序**

| 排序 | 规则 |
|---|---|
| 推荐顺序（默认） | 当前路径中的顺序；不在当前路径中的卡片排在后面，按类别与服务格顺序（场景卡按 §4.3 编号） |
| 预计时长 | `estimatedMinutes` 升序 |
| 费用档位 | 低 → 中 → 高，同档按推荐顺序 |
| 最近尝试 | 最近一次会话的开始时间降序；未尝试的排在最后 |

### 2.8 卡片视觉字段

| # | 字段 | 显示 | 来源 | 规则 |
|---|---|---|---|---|
| 1 | 类型标记 | 左上角文字：“单服务 · D 计算、异步与通知”或“场景 · 包含 4 个服务” | `kind`、taxonomy 的类别、`services` | 场景卡的 N 只数 `role` 为 primary 或 supporting 的服务（选做目标对应的服务计入，显示为虚线框） |
| 2 | 类别色条 | 单服务卡左侧 3 px；场景卡不用色条，改为顶部 1 px `--border` 分隔线 | taxonomy 的类别 token（§2.10） | 色条只是辅助，类型标记中已有文字 |
| 3 | 标题 | 单服务卡：服务全称（加粗）+ 机能，两行；场景卡：场景名 + 服务组合副标题，两行 | `service`、`function` / `title`、`subtitle` | 标题 ≤ 48 字（04 §3.1）；超出两行省略，悬停显示全文 |
| 4 | 服务缩写方块 | 单服务卡一个 32 px 方块；场景卡最多 5 个 20 px 方块，primary 在前、supporting 在后，超出显示 `+N` | `services` + taxonomy | `context`、`observed` 不显示；悬停显示全称列表 |
| 5 | 一句话简介 | 最多 2 行，超出省略；悬停或聚焦显示全文 | `summary` | 写作要求见 §7.2 |
| 6 | 难度 | 四段条 + 文字（`▮▮▯▯ 初级`），颜色 `--text-2` | `difficulty` | 形状加文字，不只靠颜色 |
| 7 | 预计时长与上限 | `约 60 分钟 · 上限 1.5 小时`；≥ 120 分钟写成小时 | `estimatedMinutes`、`timeLimitMinutes` | 不含环境准备时间（§3.2） |
| 8 | 费用档位 | `$ 低`、`$$ 中`、`$$$ 高`；选做会抬高档位时写 `$ 低（选做 → 中）` | 构建期计算（§3.3） | 悬停显示主要计费来源与“具体金额在开始前计算”；**不用红绿**（“高”不是错误，只是需要留意） |
| 9 | 环境准备 | 较快（A）、中等（B）、较慢（C）、很慢（D） | `provisionClass`（§3.4） | 不写分钟数 |
| 10 | 提示标记 | 最多 3 个，按下表优先级；悬停或聚焦列出全部 | 构建期计算 + 平台配置 | 见下表 |
| 11 | 完成状态与尝试次数 | 形状 + 文字（§2.9），`尝试 2 次` / `尚未尝试` | `LabProgress`、当前环境 | 尝试次数不含启动失败而作废的尝试（04 §8.4 `void`）；自托管平台只统计本人的尝试 |
| 12 | 徽章位 | 右下角 24 px：已获得时显示徽章图形（§2.10），未获得时显示空心轮廓与“未获得” | `LabProgress.badge` | 徽章的授予条件与等级见 tracks-and-catalog §5.2 |

**提示标记**（优先级从高到低）

| 标记 | 条件 |
|---|---|
| 需提前准备 | `prerequisites.learnerInputs` 含必填的 `cost-tags-active`（成本分配标签需提前 24～48 小时激活） |
| 部分不可用 | 当前平台配置使卡片的部分步骤被跳过：卡片 `regions.extra` 含 `dr-region` 而安装参数 `DrRegion` 为空（运行时由 `GET /api/v1/catalog` 的 `drRegion` 判定） |
| 需要域名 / 域名可选 | `learnerInputs` 含 `domain`：必填显示“需要域名”，可选（`when` 条件步骤）显示“域名可选” |
| 需要邮箱确认 | 含必填的 `ses-identity`、`notify-email`、`recipient-emails` 或 `alert-email` |
| 账号级影响 | `platform.accountImpact` 非空（悬停列出影响项与回收时的处理） |
| 等待较长 | 必需步骤的 `wait.typicalMinutes` 之和 ≥ `estimatedMinutes` 的 30% |
| 测试版 | `status: beta` |
| 有新版本 | 学员完成于旧主版本（04 §8.10） |

### 2.9 卡片状态与操作

一个安装同一时刻只有一个环境，所以最多只有一张卡片处于“进行中”类状态。状态按下表从上到下取第一个满足的（状态名以 02 §2.1 为准）：

| 显示（图标 + 文字） | 条件 | 卡片上的操作 | “状态”筛选归类 |
|---|---|---|---|
| 时钟 · 准备中 | 本卡持有环境，会话为 `REQUESTED`、`PROVISIONING` | 回到工作台 | 进行中 |
| 时钟 · 进行中 · 剩余 hh:mm | `READY`、`RUNNING`、`EXPIRING`（剩余 ≤ 15 分钟时改用 `--st-drift` 色） | 回到工作台 | 进行中 |
| 时钟 · 正在结束 / 正在释放 | `ENDING`、`CLEANING` | 查看进度 | 进行中 |
| 菱形 · 环境保留中 · 至 hh:mm | `KEPT` | 进入简介页选择“继续本卡片” | 进行中 |
| 三角 · 释放未完成 | 本卡最近一次会话为 `CLEANUP_FAILED` | 查看待人工处理清单（02 §7.9） | 进行中 |
| 实心圆 + 勾 · 已完成 | `LabProgress.status = completed` | — | 已完成 |
| 虚线方框 + M · 已完成（含手动） | `completed_manual` | — | 已完成 |
| 半圆 · 未完成 | `attempted`（有尝试但从未完成） | — | 未完成 |
| 空心圆 · 未开始 | `not_started` | — | 未开始 |

- 完成即获得徽章（C3、tracks-and-catalog §5.2），所以“已完成”的卡片徽章位一定有徽章；徽章处于 `pending`（对比实验仍在交叉核验）时，徽章位显示“核验中”。
- 其他卡片持有环境时，本卡不显示额外提示（避免 55 张卡片同时出现同一句话）；简介页的“开始实验”按钮置灰并说明原因（§7.1）。
- 已完成的卡片有新的主版本时，状态保持“已完成”，另加“有新版本”提示标记。
- 助教与观察者看到学员的状态，没有任何开始或结束操作（01）。

### 2.10 图标、类别色与徽章图形：不使用 AWS 官方素材

**原则**：不使用 AWS Architecture Icons、服务徽标、产品截图或任何仿制品，也不使用与 AWS 认证徽章相似的造型与配色。图标全部由平台自绘，以内联 SVG 实现，不引用外部图标库。

**服务缩写方块**：20 px（场景卡内、紧凑行）或 32 px（单服务卡、服务格），`--surface-2` 底色、3 px 圆角，中间是 ≤ 4 个字符的等宽缩写（`--text`），左侧 3 px 类别色条，左上角 6 px 的几何类别符号。缩写表在 `taxonomy.yaml`（§8.2），全部唯一。悬停或聚焦显示全称与类别，例如“Amazon SQS · D 计算、异步与通知”；图标本身 `aria-hidden`，服务全称写在视觉隐藏文本中。

**类别色与几何符号**（token 定义在 `platform/web/src/styles/tokens.css` 的 `.atl-app` 下；只用于 1～3 px 的色条与 6 px 的符号，不用于状态；取值可调，但与 `--surface-2` 的非文字对比度须 ≥ 3:1）：

| 类别 | token | 亮色 | 暗色 | 几何符号 |
|---|---|---|---|---|
| 基础（EC2） | `--cat-base` | `#4A4D55` | `#B6B4AE` | 实心方块 |
| A 入口、网络与扩展 | `--cat-a` | `#2F6690` | `#7FB2DE` | 三角形 |
| B 身份与安全 | `--cat-b` | `#8A3B5C` | `#D98AAE` | 菱形 |
| C 数据与存储 | `--cat-c` | `#6B7A2A` | `#B5C46A` | 圆 |
| D 计算、异步与通知 | `--cat-d` | `#A35A12` | `#E6A35E` | 六边形 |
| E 运维与监控 | `--cat-e` | `#56677A` | `#9FB0C2` | 加号 |
| F 治理、成本与交付 | `--cat-f` | `#7A5C2E` | `#C9A66B` | 两条横线 |

几何符号保证在不依赖颜色时也能区分类别（色觉障碍、灰度打印）。

**徽章图形**（徽章的授予、等级与状态由 tracks-and-catalog §5.2、§5.6 定义，这里只定图形）：

| 卡片类型 / 状态 | 图形 |
|---|---|
| 单服务卡 | 40 px 圆角方块，内容同缩写方块；外环按等级：已核验为实线、含手动为虚线、自述为主为点线 |
| 场景卡 | 40 px 六边形，中间是 ≤ 4 个汉字的场景短名（`badge.short`，例如“削峰重试”），下方 N 个小圆点表示服务数；外环规则同上 |
| 旧版 | 右上角小角标“旧” |
| 核验中（`pending`） | 外环为旋转虚线；`prefers-reduced-motion` 时改为静态文字“核验中” |
| 已撤回（`withdrawn`） | 灰色斜线填充 + 文字“已撤回” |

### 2.11 推荐下一步

```ts
// platform/web/src/catalog/recommend.ts（纯函数；目录页、路径视图、服务地图侧栏共用；表驱动单元测试）
export function recommendNext(track: TrackView, p: Map<LabId, LabProgressView>, env: EnvironmentView | null,
                              catalog: CatalogIndex): Recommendation | null {
  const done = (id: LabId) => id === env?.holderLabId || ['completed', 'completed_manual'].includes(p.get(id)?.status ?? '');
  for (const stage of track.stages) {                                            // ① 按阶段顺序找第一张未完成的必修卡片
    const todo = stage.items.filter(isCardItem).filter(i => i.role === 'required' && !done(i.card)).map(i => i.card);
    const ready = todo.find(id => softPrereqs(catalog, id).every(done));         // 建议前置都已完成的优先
    const pick = ready ?? todo[0];
    if (pick) return { labId: pick, stageId: stage.id, reason: ready ? 'next-in-path' : 'next-in-path-prereq-missing',
                       reuseFrom: reuseHint(catalog, env, pick) };
  }
  for (const stage of track.stages)                                              // ② 必修都完成：第一个未满足的选修组中最短的一张
    for (const g of stage.items.filter(isGroupItem))
      if (g.cards.filter(done).length < g.pick) {
        const pick = g.cards.filter(id => !done(id)).sort(byEstimatedMinutes(catalog))[0];
        return { labId: pick, stageId: stage.id, groupId: g.group, reason: 'elective', reuseFrom: reuseHint(catalog, env, pick) };
      }
  return null;                                                                   // ③ 路径已完成：提示领取证书，并推荐掌握度最低的服务格
}
```

- 有环境时，环境条显示持有环境的卡片，继续学习条显示“当前环境之后推荐”的下一张卡片。
- `reuseHint`：环境处于 `KEPT`、且推荐的卡片在 `catalog` 中把持有环境的卡片列为 `reuseFrom`（§8.6）时，提示“可以在保留的环境中继续”；目标已在该环境中生效的卡片不会出现在 `reuseFrom` 中（02 §8.4 `TARGET_ALREADY_SATISFIED`）。
- 不按费用档位过滤推荐，但推荐卡片上始终显示费用档位；需要域名的卡片在路径中都是可选，不会挡住推荐。

### 2.12 加载、空与错误状态

| 状态 | 表现 |
|---|---|
| 首次加载 | 先渲染静态索引（`index.json` 带版本号，可长缓存），状态区与徽章位显示骨架；个人进度到达后填充 |
| 个人进度加载失败 | 卡片照常显示，状态区显示“状态暂不可用 · 重试”；筛选中的“状态”维度置灰 |
| 掌握度加载失败 | 服务地图照常显示服务格，不显示进度环与等级，顶部提示“掌握度暂不可用 · 重试” |
| 筛选无结果 | “没有符合条件的卡片” + 当前条件摘要 + [清除筛选]；若是“只看无需人工前置”造成的，单独提示 |
| 新学员（全部未开始） | 继续学习条显示“从 svc-ec2 开始（SAA 主线第 1 张）”或“只想看七组点名对比？→ 快速路径” |
| 目录版本切换 | `GET /api/v1/catalog` 返回的 `catalogVersion` 与已加载的不同：顶部提示“卡片目录已更新 · 刷新”，不自动刷新（避免打断阅读） |
| 维护模式、平台卸载中 | 环境条位置显示“平台维护中（或正在卸载），暂时不能开始新实验” |

### 2.13 可访问性与响应式

- 每张卡片是 `<article>`，标题是 `<h3>`；卡片整体链接用“拉伸链接”实现，“回到工作台”按钮仍可单独聚焦。
- 筛选取值是 `aria-pressed` 的切换按钮；服务下拉是带搜索的多选 `listbox`。键盘：`/` 聚焦搜索，`Esc` 清空搜索，方向键在卡片网格与服务地图中移动。
- 状态、难度、费用、掌握度一律“形状 + 文字”，颜色只是辅助（ui-design §13.2）；徽章图形读作“徽章：已核验”等文字。
- 断点：≥ 1280px 三列；768～1279px 两列；< 768px 一列，筛选条收进“筛选（N）”抽屉，环境条固定在顶部且只显示卡片 id、状态、剩余时间与“回到工作台”；服务地图改为按类别折叠的列表；路径视图每个阶段默认折叠。页面放大到 200% 时落入窄屏布局。

---

## 3. 目录总则：难度、时长、费用档位、部署等级与起始状态

本节是 04 所说的“目录总则”：`lab.yaml` 的 `difficulty`、`estimatedMinutes`、`timeLimitMinutes`、`cost.tier`、`provision.class` 按这里的规则取值，构建期复算与核对（§8.7）。cards/ 各批的约定节引用的“05 §2.7”即本节。

### 3.1 难度

| 难度（id） | 判定标准（满足任一条即归入较高一级） | 本目录中的卡片 |
|---|---|---|
| 入门（`intro`） | 不启用任何 AWS 模块；只观察、运行脚本与冒烟测试；没有等待型步骤 | svc-ec2（1 张） |
| 初级（`beginner`） | 启用 1 个 AWS 模块，概念集中在单个服务；没有 VPC 绑定资源；数据迁移（如有）由模块脚本一次完成、可以回退（例如 storage、social-store 的 `migrate-module`）；步骤以脚本与控制台为主 | svc-iam、svc-config、svc-storage、svc-social-store、svc-queue、svc-notification、svc-email、svc-scheduler、svc-tagging、svc-social-api、svc-shell-access、svc-logging、svc-monitoring、svc-cost（14 张） |
| 中级（`intermediate`） | 多个服务相互配合（边缘、身份、事件路由、加密、编排）；或需要等待云端生效（分配部署、DNS、证书、trail 投递、镜像构建）；或需要理解网络与权限的交互（VPC 绑定资源、安全组链）；或有密钥、机密的迁移风险（secrets、kms）；或会开启账号级按量服务（GuardDuty、Config、Inspector） | 单服务 21 张：svc-network、svc-cdn、svc-dns、svc-tls、svc-waf、svc-load-balancer、svc-auth、svc-identity-pool、svc-secrets、svc-kms、svc-shared-fs、svc-cache、svc-analytics、svc-image-processing、svc-tracing、svc-audit、svc-threat-detection、svc-compliance、svc-vuln-scan、svc-workflow、svc-ami；场景 11 张：sc-static-acceleration、sc-edge-protection、sc-image-pipeline、sc-decoupling、sc-event-fanout、sc-serverless-api、sc-security-baseline、sc-observability、sc-analytics、sc-cost-optimization、sc-threat-compliance |
| 高级（`advanced`） | 数据迁移与实例替换后的故障演练、多 AZ 与故障转移、灾备恢复；或同时运行多个按小时计费的资源，出错的代价高 | 单服务 4 张：svc-autoscaling、svc-database、svc-backup、svc-db-proxy；场景 5 张：sc-user-identity、sc-ha-web、sc-db-performance、sc-private-network、sc-backup-dr |

- **场景卡至少中级**：场景卡按定义就是多个服务相互配合（tracks-and-catalog §1.3）。
- “账号级影响”本身不抬高难度（svc-shell-access 修改区域级会话首选项、svc-cost 创建预算仍是初级），由提示标记与简介页的“开始前准备”单独提示；只有“开启账号级按量服务”计入中级的判定。
- `labs:lint` 不能自动判定难度，但会给出提示（不阻断）：目标模块 ≥ 3 个、或费用档位为高、或部署等级为 C/D 而难度低于中级时警告；场景卡低于中级时报错。

### 3.2 时长

| 字段 | 定义 |
|---|---|
| `estimatedMinutes`（预计时长） | 熟练学员完成全部**必需**步骤的典型用时，**包含**卡内创建资源的云端等待（例如 RDS 创建、分配部署），**不包含**环境准备（`PROVISIONING`）。取 15 分钟的整数倍；选做步骤与扩展目标不计入 |
| `timeLimitMinutes`（时间上限） | 倒计时长度，从会话 `READY` 开始（02 §5.1）。取 30 分钟的整数倍，且 ≥ `estimatedMinutes` × 1.5（04 lint）；含长时间等待的卡片再加等待的上限；与平台 `MaxSessionMinutes`（01，默认 360）取较小值 |
| 延长与保留 | 全部卡片默认可延长 2 次、每次 30 分钟（02 §5.4 平台默认，目录不放宽）；保留环境：费用档位为高的卡片建议 `retain.maxHours ≤ 12`，其余 24（与平台上限取较小值，02 §8） |
| 环境准备时间 | 不写分钟数，用部署等级 A～D 的定性说明（“较快”“中等”“较慢”“很慢”）；02 在本平台积累足够的成功记录后可改用实测中位数 |

labs.md 中的时长是“自用模式、按全部步骤（含选做）”的估计；平台中起始状态由平台自动部署、选做步骤不计入，所以卡片的预计时长普遍短于 labs.md，二者不矛盾。

### 3.3 费用档位

档位只看**计费结构**，不看单价，因此在构建期就能确定，换区域、换价格表都不会变。金额（“约 $a～$b/小时”）只在简介页的“预计费用”区块与开始对话框中出现，由 02 的报价（`POST /api/v1/labs/{labId}/quotes`）按 04 §3.4 的计费维度与价格来源计算，附价格日期与“以官方定价为准”。

| 档位 | 显示 | 判定 |
|---|---|---|
| 低 | `$ 低` | 除“基础”外没有额外的按小时计费单位，也没有账号级按量服务；其余全是按量或按月折算的小额固定项 |
| 中 | `$$ 中` | 额外的按小时计费单位恰好 1 个，**或**会话期间开启了账号级按量服务（GuardDuty、Config、Inspector） |
| 高 | `$$$ 高` | 额外的按小时计费单位 ≥ 2 个 |

- **基础**是每个会话都有的资源，不计入单位：实验机 EC2 实例小时、实验机的 EBS（根卷与数据卷）与公网 IPv4、工作台的 EC2、EBS 与公网 IPv4（03）。
- **按小时计费单位**只指“按资源实例的运行时长计费、闲置也照常计费”的资源：EC2 实例（含卡内的临时第二台实例、演练实例、Image Builder 构建实例、ASG 实例、Spot 基准实例）、RDS 实例与备库、只读副本、RDS Proxy、ElastiCache 节点、负载均衡器、NAT 网关、接口终端节点（每个 AZ 一个单位）、Lambda 预置并发。附属在这些资源上的公网 IPv4（ALB 节点、NAT 网关的 EIP）不另计单位。按容量单位小时计费的小额项（DynamoDB 预置容量、按月折算的 KMS 密钥、Secrets Manager 密钥、Route 53 托管区域、Web ACL 等）在 taxonomy 的 `weights` 中取权重 0。
- **计入范围**：起始状态中的模块（例如 svc-db-proxy 起始的 RDS）、卡片自带栈（`extraStacks`）与目标模块都**计入**；只有 L0 部分标 `base: true`。卡内先后出现的临时 EC2，只有在 `cost.basis` 中声明为“同一时刻至多 1 台”的单项时才算 1 个单位（svc-ami）。
- **选做**：只在选做步骤中出现的项（`cost.basis[].optional: true`）只计入 `withOptional` 档位；两个档位不同时卡片写“低（选做 → 中）”。

**算法**（构建期执行，输入是 04 §3.4 展开后的 `cost.basis`）

```ts
// platform/api/src/content/catalog/cost-tier.ts
export type CostTier = 'low' | 'medium' | 'high';

export function costTier(items: ExpandedCostItem[], rules: CostTierRules, scope: 'required' | 'withOptional'): CostTier {
  const inScope = items.filter(i => scope === 'withOptional' || !i.optional);
  const weight = (key: string) =>                                   // weights 的键是 pricingKey 前缀，取最长匹配；可以为 0；缺省为 1
    Object.entries(rules.weights).filter(([p]) => key.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? 1;
  const units = inScope
    .filter(i => i.billing === 'hourly' && !i.base && i.source !== 'workstation' && i.source !== 'platform')
    .reduce((n, i) => n + weight(i.pricingKey) * i.quantity, 0);    // source 含 start-profile、extra-stack、target、step
  const accountScoped = inScope.some(i => rules.accountScopedKeys.some(k => i.pricingKey.startsWith(k)));
  if (units >= rules.highUnits) return 'high';                      // 默认 2
  if (units >= 1 || accountScoped) return 'medium';
  return 'low';
}
```

本目录的结果（§4.4）：低 35 张、低（选做 → 中）3 张、中 10 张、中（选做 → 高）1 张、高 7 张。

### 3.4 部署等级

部署等级（`provision.class`，02 §11.1 的 A～D）决定开通与回收预算，**由起始状态推导**（含卡片自带栈中 `deploy: start` 的栈）；卡内创建的慢资源不影响等级，只影响时长。模块的部署速度写在 taxonomy 的 `provisionSpeed`（取值来自 02 §11.1 的表）。

| 等级 | 显示 | 判定 |
|---|---|---|
| A | 环境准备较快 | 只有 L0 与“快”资源（iam、storage、secrets、config、kms、queue、social-store、工具链栈等） |
| B | 中等 | 含“中/慢”资源中的一两个：CloudFront 分配、ALB、迁入自定义 VPC 的实例替换、Cognito 用户池（托管登录或数据迁移） |
| C | 较慢 | 含 RDS 或 ElastiCache 之一 |
| D | 很慢 | RDS / ElastiCache 再叠加 ALB、另一个 RDS / ElastiCache 或实例替换（02 §11.2 把“RDS + ALB”定为 D） |

本目录：A 47 张、B 4 张（svc-waf、svc-identity-pool、sc-user-identity、sc-private-network）、C 4 张（svc-db-proxy、sc-ha-web、sc-db-performance、sc-backup-dr）、D 1 张（svc-autoscaling）。svc-tls 的回退档 `acme-off` 为 B。

`lab.yaml` 的 `provision.class` 是作者声明的期望值，`labs:catalog` 按本节复算，不一致即构建失败（04 DRV-11）；`provision.cleanupBudgetMinutes` 要覆盖目标模块与学员可创建的慢资源的删除期限（例如 CloudFront 分配，02 §2.5），由 02 定义取值规则。

### 3.5 起始状态在目录中的体现（裁决 C3）

规则以 02 §3.6、04 §3.2.3 为准，本节只摘要目录关心的部分：

1. **起始状态 = L0 + iam(role) + 目标模块硬依赖的闭包**。闭包包括 registry 的 `requires`，也包括规则表中“启用某模块即可满足”的 error 级条件（ASG-001～003、DEP-009 的复合条件等）、任选分支的选择、对比所需的本地档与运行时热键。
2. **iam 例外**：只有 `svc-ec2`（学习对象就是 L0）、`svc-iam`（目标就是 iam）不预置 iam（C3 字面）。其余卡片——包括目标模块 `credentials: optional` 的 16 张单服务卡与 `sc-security-baseline`——一律预置 iam，因此不再出现“只因无凭证而 `degraded`”（CRED-004）。第 3 轮修订：第 2 轮曾让 `sc-security-baseline` 也不预置 iam（iam 作为第一个目标），与 C3、06 PM-33 第 3 步、04 DRV-5 冲突（`plan --start-of` 会因“目标取值已在起始状态中生效”以退出码 2 失败），已撤回；该卡的“长期密钥 vs 临时凭证”改为平台动作演示（scenario-cards §3.11）。
3. **推导**：`scripts/module plan --start-of <card-id> [--variant <id>] --platform --json`（06）。**不能**直接用 `profiles/single/<id>.env`：它包含目标模块本身。构建期生成档位文件 `profiles/atl/<card-id>/<variant>.env`（默认变体 `default`，§8.5），CI 逐卡重算比对；`lab.yaml` 的 `startProfile.provisions` 必须与推导结果逐项相同（04 DRV-1）。
4. **场景卡的背景模块**只允许四类理由：`https-entry`、`protected-data`、`shorten-wait`、`realism`（04 §3.2.3 第 4 条）。tracks-and-catalog 的第五类 `control-plane`（为 optional 模块的控制面加 iam）在 C3 之后不再需要。
5. **起始变体与回退档**：`startProfile.variants[]`，`select: learner`（开始前由学员选择，目前只有 sc-ha-web 的 `efs`）或 `select: preflight`（由 02 的账号预检按探测结果选择，目前只有 svc-tls 的 `acme-off`）。同一卡片的所有变体共用一个徽章。目录卡片的费用档位取所有变体中较高者、部署等级取 `default` 变体；报价按所选变体计算，有预检型回退档时按两者中费用较高者报价（§4.6、02 §3.6）。
6. **平台段**（`startProfile.platform`）：
   - `preview.directHttps`：方案 B（Let's Encrypt IP 短期证书，写入 `TLS_MODE=letsencrypt`，06）默认 `on`。以下卡片必须为 `off`：起始状态或目标含 autoscaling（ASG-014，error 级且不可覆盖）、以 tls 为目标（要从自签名讲起）、切换到 private 放置（实例没有公网 IPv4，证书无法续期）。本目录共 5 张，见 §4.6。为 `off` 时预览优先选可嵌入的 cdn 入口，没有时“在新标签页打开”（03）。方案 B 的签发与续期要求 80/443 对公网可达（以 Let's Encrypt 官方文档为准）；卡内锁定源站的卡片（sc-edge-protection）在锁定后直连预览会被安全组挡住，预览改用分配域名，会话内无需续期。
   - `sshFromWorkstation`：由 02 的运行器设置基础栈 `SshIngressCidr`：实验机与工作台同在默认 VPC 时取工作台**私网** IP/32，实验机已迁入自定义 VPC 时取工作台**公网** IPv4/32（02 §3.6）。本目录有 2 张：svc-shell-access（私网）、sc-private-network（公网）。
7. **预期警告**：卡片声明 `expectedWarnings`；健康门（02 §3.6）与 `capability` 的“正常”断言只接受由它们导致的 `degraded`（04 §3.2.5）。目录不显示预期警告，但简介页的“实验资源”区块会把它们写成“开始时这些提示是预期的”。
8. **测试数据种子**：`provisions` 中 `kind: seed` 的条目，id 以 06 的种子登记表为准：`cognito-test-users`（auth 为 local 时是本地测试账号，auth 为 cognito 时另由工作台以学员身份设置已知密码）、`gps-sample-photos`（带 GPS 信息的示例照片）。运行器在 `profile-apply` 的最后一步执行（02 §4.3）；简介页“实验资源”区块列出。

**平台占位符**（`provisions` 的 `set` / `params` 中只允许这四个；取值由 02 的运行器在 `profile-apply` 前替换，`scripts/module` 拒绝含未替换占位符的档位，06）：

| 占位符 | 含义 | 使用者 |
|---|---|---|
| `${atl:workstationPrivateCidr}` | 工作台私网 IPv4/32 | 需要从工作台经私网访问实验机、但不能用 `sshFromWorkstation` 表达的取值（目前没有卡片使用，预留） |
| `${atl:workstationPublicCidr}` | 工作台公网 IPv4/32 | 经实验机公网入口放行工作台（sc-edge-protection 的 `CDN_ADMIN_CIDR`）。同一 VPC 内经弹性 IP 互访时对端看到的源地址需实测（07） |
| `${atl:drRegion}` | 安装参数 `DrRegion`（默认 `ap-northeast-3`，可为空） | svc-backup、sc-backup-dr；`regions.extra` 中写 `dr-region`（04 §3.1） |
| `${atl:platformOrigin}` | 平台站点的来源（CSP `frame-ancestors` 等，06） | 预览相关的本地档 |

第 1 轮的 `${atl:workstationCidr}` 废止：它在 02/03 中表示私网、在 05 第 1 轮中表示公网（tracks-and-catalog §3.3 C-13）。

---

## 4. 56 张卡片的元数据汇总（权威）

### 4.1 读表说明

- **来源**：每一行逐项取自 cards/ 逐卡文档的元数据表——svc-ec2～svc-kms 取自 service-cards-1，svc-storage～svc-social-api 取自 service-cards-2，svc-shell-access～svc-ami 取自 service-cards-3，sc-* 取自 scenario-cards.md；与之不同的取值都由 §1.3 的上位规定决定，在 §4.5 逐条列出（表中以 ‡ 标注）。
- **kind**：`service` 或 `scenario`，与 id 前缀一致。
- **时长**：预计 / 时间上限（分钟），规则见 §3.2。全部卡片可延长 2 次、每次 30 分钟。
- **startProfile**：只写 L0（`l0-ec2`）之外的部分，即构建期 `plan --start-of` 应得出的结果（§3.5）。`iam` 一律指 `IAM_CREDENTIALS=role`（平台模式下 `AppRoleMode=existing`）；第 2 轮用来标注“逐卡文档尚写不并入 iam”的星号标记已删除——三批逐卡文档已按 C3 改写（§4.5 D-1）。“方案 B 关”= `startProfile.platform.preview.directHttps: off`。“本地档 / 本地设置”不部署 AWS 资源、不写 `MODULE_<ID>=on`；“运行时”是 RuntimeConfig 热键；“背景”是场景卡的背景模块（括号内为理由类别）；“种子”是 06 定义的测试数据。
- **目标**：写成“模块：`开关` 起始取值 → 目标取值”，对应 `targetModules[]` 的 `fromDriver → driver` 与 `set`、`params`（04 §3.2.4）。场景卡按手册中 wire 步骤的顺序列出，`→` 表示先后，`、` 表示互不依赖；`*` 表示需要域名、没有域名时跳过的条件目标；“扩展”“选做”目标不计入预计时长。
- **费用档位、部署等级**：按 §3.3、§3.4 构建期复算的期望值。
- **人工前置**：括号内是 `prerequisites.learnerInputs` 的 id（04 的枚举）；“账号级”“平台动作”的明细见 §4.7。

### 4.2 单服务卡片（40 张）

| # | id | 标题 | kind | 难度 | 时长 | startProfile（L0 之外） | 目标（from → to） | 费用档位 | 部署等级 | 人工前置 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `svc-ec2` | Amazon EC2：运行整个应用 | service | 入门 | 60 / 90 | —（C3 例外，不预置 iam） | —（基础模块，只观察与演练；`targetModules: []`） | 低 | A | 无 |
| 2 | `svc-network` | Amazon VPC：网络隔离 | service | 中级‡ | 90 / 150 | iam | network：`NETWORK_PLACEMENT` default → public（`NatMode=none`；卡内分阶段替换实例迁入自定义 VPC）‡ | 低‡ | A‡ | 无 |
| 3 | `svc-cdn` | Amazon CloudFront：内容分发与边缘缓存 | service | 中级 | 75 / 120 | iam | cdn：`CDN_BASE_URL` 空 → 分配域名（`CDN_ORIGIN_TYPE=ec2`、`CDN_MEDIA_ORIGIN=ec2`、`CDN_DIRECT_ACCESS=open`） | 低 | A | 无 |
| 4 | `svc-dns` | Amazon Route 53：域名解析 | service | 中级 | 60 / 120 | iam | dns：`DNS_PROVIDER` none → route53（`DNS_TARGET_TYPE=eip`、simple；选做 failover） | 低 | A | 自有域名（`domain`；已有公有托管区域，或能做 NS 委派） |
| 5 | `svc-tls` | AWS Certificate Manager：HTTPS 证书 | service | 中级 | 75 / 120 | iam；方案 B 关；回退档 `acme-off`（预检选择）：+ cdn | tls：`TLS_MODE` selfsigned → acm（`TLS_ACME=on`；回退档 `TLS_ACME=off`，us-east-1 集成证书挂在 CloudFront） | 低 | A（回退档 B） | 自有域名（`domain`），能添加 CNAME 与 A 记录 |
| 6 | `svc-waf` | AWS WAF：Web 应用防护 | service | 中级 | 90 / 150 | iam、cdn（`CDN_DIRECT_ACCESS=open`；DEP-006 选 cdn） | waf：`WAF_MODE` nginx → aws（`CLOUDFRONT` 范围，先 count 后 block） | 低 | B | 无 |
| 7 | `svc-load-balancer` | Elastic Load Balancing：负载均衡（ALB） | service | 中级 | 60 / 90 | iam | load-balancer：`LB_MODE` nginx → alb（HTTP；选做 `LB_LOCK_ORIGIN=on`） | 中 | A | 无 |
| 8 | `svc-autoscaling` | Amazon EC2 Auto Scaling：弹性伸缩 | service | 高级 | 120 / 180 | iam、storage、database（RDS，单 AZ）、load-balancer；方案 B 关 | autoscaling：`DEPLOY_MODE` single → asg（Min 2 / Desired 2 / Max 4；`SECRETS_ORIGIN=bundle` 随目标写入） | 高 | D | 无 |
| 9 | `svc-iam` | AWS IAM：服务器访问 AWS 的凭证 | service | 初级 | 60 / 90 | —（C3 例外：iam 是目标） | iam：`IAM_CREDENTIALS` none → role（`keys` 只经平台动作演示） | 低 | A | 无（可选平台动作：长期密钥演示） |
| 10 | `svc-auth` | Amazon Cognito User Pool：用户注册登录 | service | 中级 | 90 / 150 | iam；种子 `cognito-test-users`（auth 为 local 时是本地测试账号，作为 bulk 迁移对象） | auth：`AUTH_DRIVER` local → cognito（`COGNITO_LOGIN_MODE=sdk`、`AUTH_MIGRATION=bulk`） | 低 | A | 能收信的邮箱 |
| 11 | `svc-identity-pool` | Amazon Cognito Identity Pool：终端用户直传 S3 | service | 中级 | 90 / 150 | iam、storage、auth（cognito、sdk、bulk；DEP-002 选 cognito）；种子 `cognito-test-users`（已确认、密码已知的 Cognito 测试用户） | identity-pool：`IDENTITY_POOL_ID` 空 → 身份池 | 低 | B | 无 |
| 12 | `svc-secrets` | AWS Secrets Manager：密码与密钥管理 | service | 中级 | 60 / 90 | iam | secrets：`SECRETS_DRIVER` env → secretsmanager | 低 | A | 无 |
| 13 | `svc-config` | AWS Systems Manager Parameter Store：运行时配置 | service | 初级 | 45 / 90 | iam | config：`CONFIG_DRIVER` file → ssm | 低 | A | 无 |
| 14 | `svc-kms` | AWS KMS：数据加密密钥 | service | 中级 | 75 / 120 | iam；种子 `gps-sample-photos`（带 GPS 信息的示例照片） | kms：`KMS_KEY_ID` 空 → CMK（`KMS_APPLY_TO=fields`，选做 `ebs`） | 低 | A | 无 |
| 15 | `svc-storage` | Amazon S3：照片对象存储 | service | 初级 | 60 / 90 | iam | storage：`STORAGE_DRIVER` local → s3 | 低 | A | 无 |
| 16 | `svc-shared-fs` | Amazon EFS：多实例共享文件系统 | service | 中级 | 75 / 120 | iam | shared-fs：`STORAGE_DRIVER` local → efs（卡内临时第二台实例） | 中 | A | 无 |
| 17 | `svc-database` | Amazon RDS for PostgreSQL：托管关系数据库 | service | 高级 | 120 / 180 | iam | database：`DB_DRIVER` sqlite → postgres（RDS，`MultiAz=true`） | 高 | A | 无 |
| 18 | `svc-cache` | Amazon ElastiCache：共享缓存 | service | 中级 | 90 / 150 | iam；本地档 `LB_LOCAL_WORKERS=2` | cache：`CACHE_DRIVER` none → redis（ElastiCache；卡内先经本地档 memory 对照） | 中 | A | 无 |
| 19 | `svc-social-store` | Amazon DynamoDB：点赞、评论与分享链接 | service | 初级 | 60 / 90 | iam | social-store：`SOCIAL_DRIVER` db → dynamodb | 低（选做 → 中） | A | 无 |
| 20 | `svc-backup` | AWS Backup：盘外备份与恢复演练 | service | 高级 | 120 / 180 | iam | backup：`BACKUP_MODE` local → aws（`DrRegion=${atl:drRegion}`） | 中 | A | 平台已配置灾备区域（依赖 01 §6.5 的 `DrRegionLimited` 放行灾备区域的 `cloudalbum-*` 栈与卷恢复）；账号级 Backup 区域设置 |
| 21 | `svc-analytics` | Amazon Data Firehose：点击流采集与投递 | service | 中级 | 75 / 120 | iam | analytics：`ANALYTICS_DRIVER` db → firehose（`OutputFormat=json`） | 低 | A | 无 |
| 22 | `svc-image-processing` | AWS Lambda：缩略图生成 | service | 中级 | 90 / 150 | iam、storage（DEP-003） | image-processing：`IMAGE_PROCESSOR` inline → lambda（eventbridge 触发，`ResultChannel=queue`） | 低（选做 → 中） | A | 无 |
| 23 | `svc-queue` | Amazon SQS：异步任务队列与死信队列 | service | 初级 | 60 / 90 | iam；本地档 `IMAGE_PROCESSOR=worker`、`QUEUE_DRIVER=memory` | queue：`QUEUE_DRIVER` memory → sqs（`MaxReceiveCount=3`） | 低 | A | 无 |
| 24 | `svc-notification` | Amazon SNS：通知扇出与订阅过滤 | service | 初级 | 60 / 90 | iam | notification：`NOTIFY_DRIVER` db → sns | 低 | A | 支持 `+` 别名的邮箱（`notify-email`），确认订阅 |
| 25 | `svc-email` | Amazon SES：真实发信与退信回流 | service | 初级 | 60 / 90 | iam | email：`EMAIL_DRIVER` outbox → ses | 低 | A | SES 发件身份（`ses-identity`，邮箱验证） |
| 26 | `svc-scheduler` | Amazon EventBridge Scheduler：不漏跑的定时任务 | service | 初级 | 75 / 120 | iam；本地设置 `SCHEDULER_COMPARE_HEARTBEAT=on` | scheduler：`SCHEDULER_DRIVER` cron → eventbridge | 低 | A | 无 |
| 27 | `svc-tagging` | Amazon Rekognition：图片识别与审核 | service | 初级 | 45 / 90 | iam | tagging：`TAGGER_DRIVER` none → rekognition（`TAGGER_INPUT=auto`） | 低 | A | 无（开始前提示：图片会发送给 AWS 的 AI 服务） |
| 28 | `svc-social-api` | Amazon API Gateway：社交 API 托管入口 | service | 初级 | 60 / 90 | iam | social-api：`SOCIAL_API_BASE_URL` 空 → execute-api（proxy 集成） | 低 | A | 无 |
| 29 | `svc-shell-access` | AWS Systems Manager Session Manager：运维登录 | service | 初级 | 60 / 90 | iam；`sshFromWorkstation`（工作台私网 /32） | shell-access：`SHELL_ACCESS_MODE` ssh → ssm | 低 | A | 无 |
| 30 | `svc-logging` | Amazon CloudWatch Logs：集中日志 | service | 初级 | 45 / 90 | iam；运行时 `lab.faults=true` | logging：`LOG_DRIVER` file → cloudwatch | 低 | A | 无 |
| 31 | `svc-monitoring` | Amazon CloudWatch：指标、告警与仪表板 | service | 初级 | 75 / 120 | iam；运行时 `lab.faults=true` | monitoring：`METRICS_DRIVER` local → cloudwatch | 低 | A | 告警邮箱（`notify-email`），确认订阅 |
| 32 | `svc-tracing` | AWS X-Ray：分布式链路追踪 | service | 中级 | 75 / 120 | iam；本地档：自建 PostgreSQL、`IMAGE_PROCESSOR=worker` + `QUEUE_DRIVER=memory`；运行时 `lab.faults=true` | tracing：`TRACING_DRIVER` none → xray（卡内先经本地档 local） | 低 | A | 无 |
| 33 | `svc-audit` | AWS CloudTrail：AWS API 操作审计 | service | 中级 | 75 / 120 | iam | audit：`AUDIT_MODE` app → cloudtrail | 低 | A | 无（账号已有 trail 时只读接入） |
| 34 | `svc-threat-detection` | Amazon GuardDuty：威胁检测 | service | 中级 | 45 / 90 | iam | threat-detection：`THREAT_DETECTION_MODE` fail2ban → guardduty | 中 | A | 发现通知邮箱（`notify-email`），确认订阅 |
| 35 | `svc-compliance` | AWS Config：配置合规与漂移检测 | service | 中级 | 75 / 120 | iam | compliance：`COMPLIANCE_MODE` local → config | 中 | A | 确认订阅（`notify-email`） |
| 36 | `svc-vuln-scan` | Amazon Inspector：漏洞扫描 | service | 中级 | 75 / 150 | iam | vuln-scan：`VULN_SCAN_MODE` dnf → inspector（只启用 EC2 扫描类型） | 中 | A | 显式同意账号级激活（本区域全部 EC2 含工作台都会被扫描、计费） |
| 37 | `svc-cost` | AWS Budgets：费用护栏与告警 | service | 初级 | 45 / 90 | iam | cost：`COST_MODE` local → budgets | 低 | A | 成本分配标签已激活（`cost-tags-active`，平台动作需提前 24～48 小时）；账号已开启 IAM 访问账单信息；确认订阅（`notify-email`）；两个预算金额（`budget-amounts`） |
| 38 | `svc-db-proxy` | Amazon RDS Proxy：数据库连接池 | service | 高级 | 90 / 180 | iam、secrets、database（RDS，单 AZ）；本地档 `LB_LOCAL_WORKERS=2` | db-proxy：`DB_PROXY_MODE` none → rds-proxy（`DB_PROXY_AUTH=secrets`；卡内可先经本地档 pgbouncer） | 高 | C | 无 |
| 39 | `svc-workflow` | AWS Step Functions：照片处理流程编排 | service | 中级 | 75 / 120 | iam、storage；本地档 `IMAGE_PROCESSOR=worker`、`QUEUE_DRIVER=memory`；运行时 `lab.faults=true` | workflow：`WORKFLOW_DRIVER` inline → stepfunctions | 低 | A | 无 |
| 40 | `svc-ami` | EC2 Image Builder：黄金 AMI 构建 | service | 中级 | 135 / 210 | iam | ami：`AMI_SOURCE` userdata → golden（卡内替换实例） | 中 | A | 无（切换时有一次停机窗口） |

‡ svc-network 的目标、难度、费用档位与部署等级按 tracks-and-catalog 的裁决（§4.5 D-2）。

### 4.3 场景卡片（16 张）

| # | id | 标题 / 服务组合 | kind | 难度 | 时长 | startProfile（L0 之外） | 目标（顺序） | 费用档位 | 部署等级 | 人工前置 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `sc-static-acceleration` | 静态资源全球加速 / S3 + CloudFront + Route 53 + ACM | scenario | 中级 | 105 / 180 | iam、storage；方案 B 关 | cdn（`CDN_MEDIA_ORIGIN=s3`，OAC）→ tls*（`TLS_ACME=off`，us-east-1 集成证书）→ dns*（先指向 eip，再改为 cloudfront） | 低 | A | 自有域名（`domain`，可选：没有时 tls、dns 两步跳过） |
| 2 | `sc-edge-protection` | 边缘防护 / CloudFront + WAF（+ Shield Standard 讲解，GuardDuty 选做） | scenario | 中级 | 90 / 150 | iam‡ | cdn（`CDN_DIRECT_ACCESS=admin-ip`，`CDN_ADMIN_CIDR=${atl:workstationPublicCidr}`）→ waf（`CLOUDFRONT` 范围，先 count 后 block）→ 选做 threat-detection | 低（选做 → 中） | A | 无（选做步骤需 `alert-email` 并确认订阅） |
| 3 | `sc-image-pipeline` | 无服务器图片流水线 / S3 + EventBridge + Lambda + SQS + Rekognition（扩展 Step Functions） | scenario | 中级 | 105 / 180 | iam、storage | image-processing（inline → lambda，eventbridge 触发）→ tagging（none → rekognition，`TAGGER_INPUT=s3`）；扩展 workflow | 低 | A | 无 |
| 4 | `sc-decoupling` | 削峰与重试 / SQS + EC2 worker + Lambda + DLQ | scenario | 中级 | 90 / 150 | iam、storage；本地档 `QUEUE_DRIVER=memory`、`IMAGE_PROCESSOR=worker` | queue（memory → sqs）→ image-processing（worker → lambda，`IMAGE_TRIGGER=buffer-queue`） | 低 | A | 无 |
| 5 | `sc-event-fanout` | 事件扇出与通知 / SNS + SQS + SES | scenario | 中级‡ | 75 / 120 | iam | email（outbox → ses）→ notification（db → sns，订阅过滤）‡ | 低 | A | SES 发件身份（`ses-identity`）、2 个收件邮箱（`recipient-emails`）、确认订阅 |
| 6 | `sc-user-identity` | 用户身份全链路 / Cognito User Pool + Identity Pool + S3 + API Gateway | scenario | 高级 | 120 / 180 | iam、storage；背景 cdn（`CDN_MEDIA_ORIGIN=s3`，`https-entry`）；种子 `cognito-test-users` | auth（local → cognito，托管登录）→ identity-pool → social-api（proxy 集成 + JWT 授权器） | 低 | B | 1 个收件邮箱（`recipient-emails`） |
| 7 | `sc-serverless-api` | Serverless API / API Gateway + Lambda + DynamoDB | scenario | 中级 | 90 / 150 | iam | social-store（db → dynamodb）→ social-api（lambda 集成 + lambda 授权器）；选做 queue | 低 | A | 无 |
| 8 | `sc-ha-web` | 高可用 Web 层 / ALB + Auto Scaling + S3 或 EFS + RDS Multi-AZ（扩展 Image Builder） | scenario | 高级 | 150 / 240 | iam、storage（`efs` 变体为 shared-fs）、database（`MultiAz=true`，`shorten-wait`）；方案 B 关 | load-balancer（nginx → alb）→ autoscaling（single → asg）；扩展 ami | 高 | C | 无 |
| 9 | `sc-db-performance` | 数据库提速 / RDS 只读副本 + ElastiCache + RDS Proxy | scenario | 高级 | 150 / 240 | iam、secrets、database（RDS，单 AZ；secrets 先于 database）；本地档 `LB_LOCAL_WORKERS=2` | database（`CreateReadReplica` false → true）、cache（none → redis）、db-proxy（none → rds-proxy） | 高 | C | 无 |
| 10 | `sc-private-network` | 私有网络 / VPC + NAT + VPC 终端节点 + Session Manager | scenario | 高级 | 120 / 180 | iam、network（public，前驱取值）、load-balancer；方案 B 关；`sshFromWorkstation`（工作台公网 /32） | shell-access（ssh → ssm）→ network（public → private，NAT 网关 + `ops` 接口终端节点） | 高 | B | 无 |
| 11 | `sc-security-baseline` | 安全基线 / IAM + KMS + Secrets Manager + CloudTrail + Config | scenario | 中级 | 120 / 180 | iam | kms → secrets → audit → compliance（选做：平台动作演示“长期密钥 vs 临时凭证”） | 中 | A | 确认订阅（`alert-email`，Config 不合规通知） |
| 12 | `sc-observability` | 可观测性 / CloudWatch Logs + 指标与告警 + X-Ray + SNS | scenario | 中级 | 120 / 180 | iam；背景 storage、queue（`realism`）；本地档 `IMAGE_PROCESSOR=worker` | logging → monitoring → tracing（卡内先经本地档 local） | 低 | A | 告警邮箱（`alert-email`），确认订阅 |
| 13 | `sc-backup-dr` | 备份与灾备 / AWS Backup + S3 跨区域复制 + Route 53 故障转移（+ RDS 跨区域只读副本） | scenario | 高级 | 150 / 240 | iam；背景 storage、database（单 AZ）、social-store（`protected-data`）；卡片自带栈 `dr-crr-target`、`dr-crr-role`（灾备区域） | backup（local → aws）→ dns*（failover）；非模块：原图桶 CRR 规则（必做）、卡片自带栈 `dr-rds-replica`（选做） | 高 | C | 域名（`domain`，可选）；平台已配置灾备区域（依赖 01 §6.5 的 `DrRegionLimited`，卡片自带栈名 `cloudalbum-<envName>-x-*`） |
| 14 | `sc-analytics` | 点击流分析 / Data Firehose + S3 + Athena（+ Glue） | scenario | 中级 | 90 / 150 | iam | analytics（db → firehose；`OutputFormat` json → parquet，parquet 必做‡） | 低 | A | 无 |
| 15 | `sc-cost-optimization` | 成本优化 / Budgets + Cost Explorer + S3 存储类别 + Spot / Graviton | scenario | 中级 | 120 / 180 | iam；背景 storage（`protected-data`）；实验机参数 x86（`t3.small`，`realism`）；卡片自带栈 `spot-graviton-bench`（期望容量 0） | cost（local → budgets）；非模块：`rebuild-instance --arch arm64`（换为 Graviton） | 中（选做 → 高） | A | 两个预算金额（`budget-amounts`）、`alert-email` 并确认订阅；成本分配标签已激活（`cost-tags-active`）‡；账号已启用 Cost Explorer 与 IAM 访问账单信息 |
| 16 | `sc-threat-compliance` | 威胁检测与合规 / GuardDuty + Inspector + Config + CloudTrail | scenario | 中级 | 120 / 180 | iam | audit → threat-detection → vuln-scan → compliance | 中 | A | `alert-email` 并确认订阅（GuardDuty 发现与 Config 不合规两个主题） |

‡ 见 §4.5：sc-edge-protection D-7、sc-event-fanout D-4/D-6、sc-analytics D-5、sc-cost-optimization D-9。

### 4.4 统计

| 项 | 单服务（40） | 场景（16） | 合计（56） |
|---|---|---|---|
| 难度 | 入门 1 · 初级 14 · 中级 21 · 高级 4 | 中级 11 · 高级 5 | 入门 1 · 初级 14 · 中级 32 · 高级 9 |
| 费用档位（必需步骤） | 低 29（其中“选做 → 中”2）· 中 8 · 高 3 | 低 9（其中“选做 → 中”1）· 中 3（其中“选做 → 高”1）· 高 4 | 低 38 · 中 11 · 高 7 |
| 部署等级 | A 36 · B 2 · C 1 · D 1 | A 11 · B 2 · C 3 | A 47 · B 4 · C 4 · D 1 |
| 时长分段（预计） | ≤ 1 小时 17 · 1～2 小时 22 · > 2 小时 1 | 1～2 小时 13 · > 2 小时 3 | 17 · 35 · 4 |
| 预计时长合计 | 2970 分钟（约 49.5 小时） | 1815 分钟（约 30 小时） | 4785 分钟（约 80 小时） |
| 时间上限合计 | 4860 分钟 | 2880 分钟 | 7740 分钟 |

- 所有卡片的预计时长都是 15 的整数倍，时间上限都是 30 的整数倍且 ≥ 预计 × 1.5（已用脚本逐行核对）。
- `saa-main` 覆盖全部 56 张卡片，所以它的“全部时长”= 4785 分钟，与 tracks-and-catalog §4.1 一致（D-3 已同步）。各路径的必修时长、证书条件以 tracks-and-catalog §4 为准，构建期由 `catalog.yaml` 计算。

### 4.5 与 cards/ 各文件的核对结果与裁决

本轮把 56 张卡片的上述 11 项逐项与逐卡文档、tracks-and-catalog 的总表核对。下表是全部不一致之处及本目录的取值；“待同步”一列记录当时需要改的文档，第 3 轮（跨文档审计）后的状态写在该列开头。

| # | 涉及 | 逐卡文档 / 其他文件的现状 | 本目录的取值 | 依据 | 待同步 |
|---|---|---|---|---|---|
| D-1 | 16 张 `credentials: optional` 的单服务卡：network、cdn、dns、tls、waf、load-balancer、shared-fs、database、cache、backup、social-api、audit、threat-detection、compliance、cost、ami | 起始状态“不并入 iam”；capability 接受 CRED-004 降级；svc-compliance、svc-threat-detection 在 wire 步骤中让学员先执行 `enable iam`；audit、cost、ami 提供选做的 `enable iam` | 一律预置 iam(role)；CRED-004 不再出现在 `expectedWarnings` 中 | C3 | **已同步**（三批逐卡文档已按 C3 改写）。当时的待改项：三批逐卡文档的元数据、startProfile 明细、§1.1 / 约定 3 的规则、capability 检查的预期警告集合；删除“无凭证”的叙述、选做 `enable iam` 步骤与 wire 步骤中的 `enable iam`；svc-shared-fs 复核有凭证时 `IamAuth` 的默认值（以 03-data-storage 为准） |
| D-2 | svc-network | service-cards-1 §3：目标 public → private，起始 network(public) + load-balancer，高级 / 高 / B | 目标 default → public（`NatMode=none`），起始 L0 + iam，中级 / 低 / A | tracks-and-catalog T6、§3.3 C-12：严格闭包；否则原 Lab 14 没有卡片承载，且与 sc-private-network 重复 | service-cards-1 §3 改写；原 private 部分（EIC Endpoint、NAT、`endpoint-only`）可移入 sc-private-network 的选做步骤 |
| D-3 | svc-ami 时长 | service-cards-3：135 / 210；tracks-and-catalog §2.1：120 / 210 | 135 / 210 | 逐卡文档（含镜像构建、测试与实例替换的等待） | **已同步**（tracks-and-catalog §4.1 已为 4785 分钟）。当时的待改项：tracks-and-catalog §2.1、§4.1、§4.2.2 的时长汇总 |
| D-4 | sc-event-fanout 难度 | scenario-cards：初级 | 中级 | §3.1“场景卡至少中级”；tracks-and-catalog §3.3 C-5 | scenario-cards 总表与 §3.5 元数据 |
| D-5 | sc-analytics | scenario-cards：改为 parquet 是第 8 步选做 | parquet 必做 | tracks-and-catalog §3.3 C-6：否则与 svc-analytics 的模块集合、目标完全相同 | scenario-cards §3.14 的步骤；若实测超时再上调时长 |
| D-6 | sc-event-fanout 目标顺序 | scenario-cards：email → notification；tracks-and-catalog：notification → email | email → notification | 逐卡手册的 wire 顺序；两者互不依赖，最终以 `plan` 的拓扑序核对（04 DRV-7） | tracks-and-catalog §3.1、§3.2.5 |
| D-7 | sc-edge-protection 的 iam | tracks-and-catalog：背景模块（`control-plane`）；scenario-cards：教学取舍③ | 凭证前置（`basis: credential`） | C3 已让 iam 一律预置；04 的背景理由只有四类 | tracks-and-catalog §1.5 场景卡规则 2 删除 `control-plane`、§3.3 C-3 改写；scenario-cards §2.2 |
| D-8 | sc-security-baseline 的 iam | 第 2 轮本表曾取“起始 L0，iam 是第一个目标”；scenario-cards §3.11 与 tracks-and-catalog C-14 按 C3 字面预置 iam | **预置 iam**；目标 kms → secrets → audit → compliance（第 3 轮改为与 cards 一致） | C3 只给 `svc-ec2`、`svc-iam` 两个例外；06 PM-33 第 3 步对其余卡片一律加入 iam，04 DRV-5 规定“目标取值已在起始状态中生效即报错”，按第 2 轮的写法 `plan --start-of` 会以退出码 2 失败 | **已同步**；撤回第 2 轮“请 04 为 lint 第 5 条开例外”的要求 |
| D-9 | sc-cost-optimization 的成本分配标签 | scenario-cards：“激活由模块提交，卡内只验证已提交” | 平台动作 `cost-activate-tags`，在开始路径前（至少提前 24～48 小时）执行；学员输入 `cost-tags-active` | 学员边界没有 `ce:UpdateCostAllocationTagsStatus`；与 svc-cost、tracks-and-catalog §4.2 一致 | scenario-cards §3.15 人工前置与相关步骤 |
| D-10 | SSH 基线与 `${atl:workstationCidr}` | scenario-cards §3.10：`ec2.SshIngressCidr: '${atl:workstationCidr}'`；第 3 批约定 §3 第 9 条、§4 关于占位符的说明 | 只用 `sshFromWorkstation`，由 02 按 VPC 取私网或公网 /32；`${atl:workstationCidr}` 废止 | K10；02 §3.6 | scenario-cards §3.10；service-cards-3 约定 §3、§4 |
| D-11 | sc-backup-dr 的区域写法 | `regions.extra: ['${atl:drRegion}']`、extraStack `region: extra:${atl:drRegion}` | `regions.extra: [dr-region]`；extraStack 的 `region: dr-region` | 04 §3.1 | scenario-cards §2.4、§3.13 |
| D-12 | 学员输入的 id | `notify-email`、`alertEmail`、`sesIdentity`、`recipientEmails`、`budgetProject` / `budgetAccount` 混用 | 04 的枚举：`notify-email`、`alert-email`、`ses-identity`、`recipient-emails`、`budget-amounts`、`cost-tags-active`、`domain`、`hosted-zone` | 04 §3.3 | scenario-cards §2.7 与各卡；手册中的 `{{ learner.inputs.* }}` |
| D-13 | 起始档位名 | 04 §3.2.3：默认 `atl/<card-id>`、变体 `atl/<card-id>/<variant>`；02 §3.6、tracks-and-catalog：一律 `atl/<card-id>/<variant>` | `atl/<card-id>/<variant>`，默认变体 `default` | 02 的运行器、会话记录与报价已按此设计；名称最终以 01 名称表为准 | **已同步**（01 §3.9 收录；04 §2、§3.2.3、K-3 已在第 3 轮对齐） |
| D-14 | 起始状态的推导与核对 | tracks-and-catalog §1.5、§7.6：单服务卡等于 `profiles/single/<id>.env`，用 `plan --single`，DRV-1/2 与 single 比对 | `plan --start-of <card-id>`，不与 `single/<id>` 比对 | C3 | tracks-and-catalog §1.5、§7.6、§8.6 X-1 |
| D-15 | svc-tls 回退档 | tracks-and-catalog §2.1、§2.2：回退档含本地设置 `DNS_PROVIDER=external`；service-cards-1：由卡内第 2 步写入 | 回退档 = L0 + iam + cdn；`DNS_PROVIDER=external` 由第 2 步写入 | 逐卡文档；DEP-005 ③ 只在启用 tls 时检查，`plan --start-of` 不会把它放进起始状态 | tracks-and-catalog §2.1、§2.2 |
| D-16 | 服务格 id | 04 §3.2.2 示例写 `session-manager`；tracks-and-catalog 写 `ssm-session-manager` | `ssm-session-manager`（§8.2） | 本文是分类法的权威 | **已同步**（04 §3.2.2、§11 示例已改） |

### 4.6 起始变体、回退档与方案 B 关闭清单

| 卡片 | 变体 / 回退档 | 选择方式 | 起始状态差异 | 报价与目录显示 |
|---|---|---|---|---|
| svc-tls | `default`（ACME 端点可用）、`acme-off`（不可用） | `preflight`：02 账号预检探测 ACME 端点 | `acme-off` 多一个 cdn，部署等级 B | 目录按 `default` 显示 A；报价取两者中费用较高者，并注明“若 ACME 端点不可用将改用回退档” |
| sc-ha-web | `default`（S3）、`efs`（EFS） | `learner`：简介页的“开始实验”旁选择 | `efs` 以 shared-fs 代替 storage | 两者费用档位与部署等级相同（高、C）；共用一个徽章 |

方案 B（`preview.directHttps`）为 `off` 的卡片：**svc-tls**（以 tls 为目标）、**svc-autoscaling**（目标含 autoscaling，ASG-014）、**sc-static-acceleration**（以 tls 为目标）、**sc-ha-web**（目标含 autoscaling）、**sc-private-network**（切换到 private 放置后无法续期）。其余 51 张为 `on`。lint 按 §8.7 C-9 核对。

### 4.7 账号级影响、平台动作与发布前提

| 卡片 | 账号级影响（`platform.accountImpact`） | 平台动作（`platformOps`） | 发布前提 / 已知阻塞 |
|---|---|---|---|
| svc-iam | `CloudAlbumAppRole` 上的撤销旧会话内联策略（回收时删除） | `iam-keys-on`、`iam-keys-off`（长期密钥演示，可选）、`iam-revoke-sessions`、`iam-refresh-credentials`（可选；撤销会中断管理通道） | — |
| sc-security-baseline | trail、Config 记录器（已有时只读接入） | `iam-keys-on`、`iam-keys-off`（可选） | —（Config 的只读动作已由 04 §5.7 收录） |
| svc-cost、sc-cost-optimization | 预算（回收时删除）；成本分配标签激活状态（不撤销） | `cost-activate-tags`（路径开始前执行；AWS Organizations 成员账号只能由管理账号激活，以官方文档为准） | — |
| svc-shell-access | 区域级 `SSM-SessionManagerRunShell`（备份后修改，回收时还原） | — | — |
| svc-audit、sc-threat-compliance、sc-security-baseline | CloudTrail trail（已有管理事件 trail 时只读接入或只建数据事件 trail） | — | — |
| svc-threat-detection、sc-edge-protection（选做）、sc-threat-compliance | GuardDuty 检测器（本会话创建的回收时删除；已有时只读接入） | — | — |
| svc-compliance、sc-security-baseline、sc-threat-compliance | Config 记录器与投递通道（本会话创建的回收时停止并删除） | — | —（04 §5.7 已收录 `DescribeConfigRules` 等 Config 只读动作） |
| svc-vuln-scan、sc-threat-compliance | Inspector 激活（本会话激活的扫描类型回收时停用；激活覆盖本区域全部 EC2，含工作台） | — | vuln-scan 需支持“只启用 EC2”参数（06 PM-M34 的 `ScanTypes`）；Inspector 的只读动作已由 04 §5.7 收录（`ListCoverage` 等） |
| svc-backup、sc-backup-dr | AWS Backup 区域设置（资源类型 opt-in、DynamoDB 高级功能；回收不改回） | — | 依赖 01 §6.5 的 `DrRegionLimited`：灾备区域放行 CloudFormation（护栏 `DrRegionLabStacksOnly` 限定 `stack/cloudalbum-*`）、卷的创建与删除、跨区域只读副本，Provisioner 边界同样放行，回收器能在灾备区域删除。sc-backup-dr 的卡片自带栈 `cloudalbum-<envName>-x-*` 由运行器 `extra-stack` 部署（01 §3.4）。`DrRegion` 为空时 svc-backup 只跳过跨区域部分、sc-backup-dr 的灾备步骤不可用（第 3 轮修订：原稿“被 01 的 `DrRegionBackupOnly` 阻塞”已过期） |
| svc-email、sc-event-fanout | SES 发件身份（本会话创建的删除；`keepablePrerequisites` 可保留） | — | 02 的预检不应把“尚未验证的 SES 身份”判为失败（第 2 批 C-12） |
| svc-dns、sc-static-acceleration、sc-backup-dr | 托管区域（可保留）；未保留时上级区域中的 NS 委派列入安全类待人工处理项 | — | — |
| sc-analytics、svc-analytics | — | — | —（`glue:GetTable`、`athena:GetQueryExecution` 已由 04 §5.7 收录） |

白名单类前提的处理以 04 为准：必需检查用到白名单之外的只读动作时，`labs:policy` 使构建失败，卡片不能发布（`status: draft`，不在目录中显示）；作者也可以临时改为手动确认，但证据权重只有 0.5（tracks-and-catalog §5.3），会影响路径证书。

---

## 5. 原 Lab 0～25 → 卡片映射

原学习路线（README、labs.md 的 Lab 0～25）与第 1 轮的 5 个扩展 Lab 不再是目录条目，而是学习路径 `saa-main` 中的步骤（C2）。本节是这一映射的**唯一来源**：`saa-main` 路径文件中每个条目的 `legacyLab`、路径视图中每个阶段的“原 Lab 编号”、目录搜索中的“Lab 编号”都由本表生成；路径的阶段划分、必修与选修、证书条件仍以 tracks-and-catalog §4.2 为准。

### 5.1 映射表

标记沿用 tracks-and-catalog §4.2.2：● 必修；◇ 选修组成员（每组选 1 张）；○ 可选（不计入完成条件）。“平台模式的主要改写”是第 1 轮 §4.5 的结论，现在已落在对应卡片中。

| 原 Lab | 第 1 轮 id | 主题 | 卡片（在 `saa-main` 中的角色） | 阶段 | 平台模式的主要改写（落在哪张卡片） |
|---|---|---|---|---|---|
| 0 | `lab-00` | 单机基线 | ● `svc-ec2` | 1 基线与运维 | 实验机从 L0 起挂着只含 `AmazonSSMManagedInstanceCore` 的实例配置文件（平台管理通道），应用仍是 `IAM_CREDENTIALS=none`；冒烟与单点故障是一次性实验（svc-ec2） |
| 0（第二部分） | `lab-00-x-local-tiers` | 本地档 | 不再单独成卡：拆进各单服务卡的 before 基线——svc-queue（memory 队列 + worker）、svc-cache（memory、`LB_LOCAL_WORKERS=2`）、svc-database（自建 PostgreSQL 对照）、svc-db-proxy（PgBouncer）、svc-tracing（local）、svc-load-balancer（本机多进程） | — | 本地档不部署 AWS 资源，作为各卡“没有它”的基线 |
| 1 | `lab-01` | 应用身份与成本护栏 | ● `svc-iam`、● `svc-cost` | 1 | 教学重点为“应用使用实例角色 vs 使用访问密钥”；长期密钥演示、撤销会话与刷新凭证、成本分配标签激活走平台动作（svc-iam、svc-cost）；`cost-activate-tags` 在开始 `saa-main` 时提示执行 |
| 2 | `lab-02` | 不开 22 端口的运维登录 | ● `svc-shell-access` | 1 | SSH 只对工作台私网地址开放；外部探针在 before 时就是 filtered；`scripts/module` 的投递通道始终是 SSM（svc-shell-access） |
| 3 | `lab-03` | 日志、指标与告警 | ● `svc-logging`、● `svc-monitoring` | 1 | `kill-test` 停止实例期间是预期中断窗口（02 §5.8）；故障注入热键在起始状态打开 |
| 4 | `lab-04` | 照片存进 S3 | ● `svc-storage` | 2 存储与边缘 | 负载机是同区域的工作台 |
| 5 | `lab-05` | 边缘缓存 | ● `svc-cdn` | 2 | 不做多区域首字节测量（边界只放行实验区域、us-east-1 与灾备区域）；有效性看边缘命中与源站请求数；cdn 源请求策略转发实验头（06） |
| 6 | `lab-06` | 域名与受信 HTTPS（可跳过） | ○ `svc-dns`、○ `svc-tls` | 2 | 需要域名，所以只作可选；svc-tls 关闭方案 B；结束时托管区域二选一（保留，或先删除上级区域的 NS 委派） |
| 7 | `lab-07` | Web 应用防护 | ● `svc-waf`；阶段综合 ◇ `sc-edge-protection` / ◇ `sc-static-acceleration` | 2 | `flood` 的请求量只略超过速率规则阈值（遵守 AWS 渗透测试政策）；sc-edge-protection 从 L0 出发自建分配并锁定源站 |
| 8 | `lab-08` | 用户身份 | ● `svc-auth`、● `svc-identity-pool`；◇ `sc-user-identity` | 3 身份与消息 | 测试账号来自 06 的种子；托管登录需要受信 HTTPS（sc-user-identity 预置背景 cdn） |
| 9 | `lab-09` | 邮件与通知扇出 | ● `svc-email`、● `svc-notification`；◇ `sc-event-fanout` | 3 | SES 沙盒期收件人也要验证 |
| 10 | `lab-10` | 解耦 | ● `svc-queue`；◇ `sc-decoupling` | 4 异步与事件 | 第 1 轮“同步参照只能作观察步骤”的限制取消：实验标签扩展为任意变体（`--label l0` 等，06） |
| 11 | `lab-11` | 照片流水线 | ● `svc-image-processing`、● `svc-tagging`；◇ `sc-image-pipeline` | 4 | 结果通道用 queue（避免 DEP-021）；预留并发为 0 时异步事件进入失败目标而不是重试（第 2 批 C-11） |
| 11（扩展） | `lab-11-x-workflow` | 流程编排 Step Functions | ○ `svc-workflow` | 4 | 工具链栈由平台创建 |
| 12 | `lab-12` | 定时任务 | ● `svc-scheduler` | 4 | 心跳实验缩短为卡片专用参数 |
| 13 | `lab-13` | 数据保护与配置 | ● `svc-kms`、● `svc-secrets`、● `svc-config` | 5 数据保护 | 带 GPS 信息的示例照片来自 06 的种子（svc-kms）；组合练习在阶段 9 的 sc-security-baseline |
| 14 | `lab-14` | 自定义 VPC（public 放置） | ● `svc-network` | 6 网络与数据 | v1 先在默认 VPC 部署 L0，卡内以分阶段实例替换迁入自定义 VPC（§4.5 D-2） |
| 15 | `lab-15` | 关系数据库 | ● `svc-database` | 6 | Multi-AZ 与故障转移演练在卡内完成 |
| 15（扩展） | `lab-15-x-db-proxy` | 连接池：PgBouncer vs RDS Proxy | ○ `svc-db-proxy` | 6 | 起始状态预置 RDS（部署等级 C） |
| 16 | `lab-16` | 缓存 | ● `svc-cache`；◇ `sc-db-performance` | 6 | — |
| 17 | `lab-17` | Serverless 社交 | ● `svc-social-store`、● `svc-social-api`、● `sc-serverless-api` | 7 Serverless | svc-social-api 只做 proxy 集成；Lambda 集成与 Lambda 授权器在 sc-serverless-api |
| 18 | `lab-18` | 点击流分析 | ● `svc-analytics`；◇ `sc-analytics` | 6 | sc-analytics 的 Parquet 为必做（§4.5 D-5） |
| 19 | `lab-19` | 负载均衡 | ● `svc-load-balancer` | 8 高可用与私有化 | — |
| 20 | `lab-20` | 私有化 | ● `sc-private-network` | 8 | private 放置需要入口、出网、运维通道同时具备，是场景卡；必做部分保留 NAT，`endpoint-only` 为选做且要求 SSM 接口终端节点先就绪；方案 B 关 |
| 21 | `lab-21` | 弹性伸缩与无状态 | ● `svc-autoscaling`；○ `sc-ha-web`（推荐） | 8 | 方案 B 关（ASG-014）；`SECRETS_ORIGIN=bundle` 随目标写入 |
| 21（扩展） | `lab-21-x-ami` | 黄金 AMI | ○ `svc-ami` | 8 | 单实例以 `rebuild-instance` 切换；临时实例串行 |
| 21（变体） | `lab-21-x-efs` | 共享文件系统 EFS | ○ `svc-shared-fs`；`sc-ha-web` 的 `efs` 变体 | 8 | 单实例 + 临时第二台实例 |
| 22 | `lab-22` | 链路追踪 | ● `svc-tracing` | 9 可观测、审计与恢复 | 本地档 local 在卡内作对照 |
| 23 | `lab-23` | 审计与威胁检测 | ● `svc-audit`、● `svc-threat-detection` | 9 | 已有 trail、detector 时只读接入；本会话创建的检测器回收时删除；攻击类实验从 CloudShell 发起 |
| 24 | `lab-24` | 备份与灾备 | ● `svc-backup` | 9 | 灾备区域部分依赖 01 的 `DrRegionLimited` 与安装参数 `DrRegion`（§4.7） |
| 25（可选） | `lab-25` | 合规与漏洞扫描 | ○ `svc-compliance`、○ `svc-vuln-scan` | 9 | Inspector 只启用 EC2 扫描；金丝雀发现为选做 |
| 22～25 的组合 | — | — | ◇ `sc-observability` / ◇ `sc-security-baseline` / ◇ `sc-threat-compliance` / ◇ `sc-backup-dr`（阶段 9 选修组） | 9 | — |
| —（新增） | — | 结业：成本复盘 | ● `sc-cost-optimization` | 10 结业 | 利用此前各次实验在账号中留下的账单数据做跨会话复盘 |

- 阶段 2、3、4、6 各有一个选修组：阶段 2 为 `sc-edge-protection` / `sc-static-acceleration`，阶段 3 为 `sc-user-identity` / `sc-event-fanout`，阶段 4 为 `sc-decoupling` / `sc-image-pipeline`，阶段 6 为 `sc-db-performance` / `sc-analytics`；阶段 9 的选修组见上表。合计必修 35 张 + 5 个选修组，最少完成 40 张；路径内全部 56 张（tracks-and-catalog §4.2.2）。
- 映射覆盖全部 56 张卡片：40 张单服务卡各对应一个原 Lab（或其扩展、本地档部分），16 张场景卡中 15 张对应原 Lab 的主题（sc-private-network 对应 Lab 20）或其组合练习，`sc-cost-optimization` 是新增的结业卡。
- 原 Lab 的“组合”不等于场景卡的拼接：每张卡片都从自己的起始状态开始，`saa-main` 中的顺序只是建议；想省开通时间的学员可以按目录给出的 `reuseFrom` 组合复用保留的环境（§8.6）。

### 5.2 旧 id 的处理

- 平台还没有实现，第 1 轮的 `lab-NN`、`lab-NN-x-*` 只存在于设计文档中，**不存在需要迁移的会话、进度、报告或证书数据**；本文不保留 `lab-NN` 形式的 id，04 的 v1 id 正则只在迁移期 schema 中保留（04 §3.6）。
- `saa-main` 的路径文件为每个条目写 `legacyLab`（例如 `{ card: svc-queue, role: required, legacyLab: 10 }`），由 `npm run labs:fix` 按本表核对与改写；目录构建把它写进 `catalog.yaml` 的 `legacyLabs[]`，供搜索与路径视图显示“原 Lab 10”。
- README、labs.md、saa-coverage.md 中按 Lab 编号书写的内容不改编号；需要回写的“Lab → 卡片”对照见 §9.7（由主设计者统一回写，本轮不修改这些文件）。

---

## 6. 学习路径、掌握度、徽章与证书（引用）

这些模型以 [tracks-and-catalog.md](cards/tracks-and-catalog.md) 为准，本文只引用、不重复：

| 内容 | 权威位置 | 目录页中的呈现（本文） |
|---|---|---|
| 9 条学习路径的清单、阶段、必修 / 选修组 / 可选、路径时长、证书标题与条件 | tracks-and-catalog §4、§5.5；路径文件格式 `atl.track/v2` 见 §7.3 | 路径视图（§2.6）、继续学习条（§2.2）、其他路径（§2.2 `TrackShelf`）、简介页“所属路径”（§7.1） |
| 徽章：授予条件（完成即授予，小测成绩只记录、不影响完成）、等级（已核验 / 含手动 / 自述为主）、状态（有效 / 核验中 / 已撤回） | tracks-and-catalog §5.2、§5.3、§5.6；裁决 C3 | 卡片徽章位与徽章图形（§2.8、§2.10）、简介页“徽章”区块 |
| 服务掌握度：计入规则、分数、等级、需复习 | tracks-and-catalog §5.4、§5.6 | 服务地图与侧栏（§2.5） |
| 路径证书：条件、签名与验证 | tracks-and-catalog §5.5；04 §10 | 路径视图的证书区（§2.6） |
| 进度的计算位置与接口 | tracks-and-catalog §5.7；04 §8 | `GET /api/v1/labs`、`GET /api/v1/me/mastery`（§8.8） |

目录为这些模型提供的输入：`catalog.yaml` 中每张卡片的 `tracks`、`legacyLabs`、`credits`（可计入的服务格）与 `serviceMap`（§8.3），以及本文 §5 的原 Lab 映射。路径 id 与名称只出现在路径文件中，目录页从构建产物读取，不在前端写死。

所有证书、验证页与导出文件都必须如实说明：这是**自托管平台自签的完成证明**，不是 AWS 官方认证，也不代表任何 AWS 认证资格（04 §10.1）；徽章同样只是平台内的进度记录。

---

## 7. 卡片简介页

### 7.1 页面结构

简介页（`/labs/:cardId`）是卡片的封面，也是**开始实验的唯一入口**：学员在这里读完背景、起始状态、费用与步骤，再点“开始实验”进入 02 的费用确认对话框（报价 → 确认 → `POST /api/v1/sessions`）。

```text
 卡片目录 › 单服务 · D 计算、异步与通知 › svc-queue
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ┌───┐ Amazon SQS：异步任务队列与死信队列                                           v1.0.0 · 测试版 │
 │ │SQS│ 单服务 · D 计算、异步与通知 · 原 Lab 10                                                     │
 │ └───┘ 初级 ▮▮▯▯ · 约 60 分钟 · 上限 1.5 小时（可延长 2 次）· $ 低 · 环境准备：较快                  │
 │ 状态：未开始 · 尚未尝试 · 徽章：未获得                    [ 开始实验 ]  [ 预习小测 ]  [ 设为当前路径 ▾ ] │
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
 ┌ 左栏（正文，约 2/3） ───────────────────────────────────┐ ┌ 右栏（摘要，约 1/3） ────────────────────────┐
 │ （场景卡：场景）                                        │ │ 开始前准备                                   │
 │ 背景                                                   │ │   建议先完成：svc-ec2 ● · svc-iam ●            │
 │ 你将学到                                               │ │   需要你提供：无                              │
 │ 实验资源                                               │ │   账号级影响：无 · 平台动作：无                 │
 │ 预计费用                                               │ │ 时间与结束                                   │
 │ 步骤概览                                               │ │   倒计时从环境就绪开始；上限 1.5 小时            │
 │ 对比实验预告                                            │ │   结束或到期后自动释放；可保留 ≤ 24 小时        │
 │ 考点                                                   │ │ 徽章                                         │
 │                                                        │ │   完成即获得“削峰填谷”；小测成绩只记录          │
 │                                                        │ │ 所属路径                                     │
 │                                                        │ │   SAA 主线（阶段 4）· 弹性 · Serverless · 点名对比 │
 │                                                        │ │ 可复用的保留环境                              │
 │                                                        │ │   svc-iam 的环境                              │
 │                                                        │ │ 历次尝试                                     │
 │                                                        │ │   （无）                                      │
 └────────────────────────────────────────────────────────┘ └─────────────────────────────────────────────┘
```

场景卡的页头改为“场景 · 包含 N 个服务”、场景名与服务组合副标题，以及至多 5 个缩写方块；左栏最前面多一个“场景”区块。卡片有 `select: learner` 的起始变体时（sc-ha-web），“开始实验”按钮旁出现变体选择（“共享存储：(•) Amazon S3  ( ) Amazon EFS”），所选变体随报价与开始请求提交（02 §3.2 的 `variant`）。“设为当前路径”只在本卡属于多条路径时出现，写入 `Learner.currentTrackId`。

**区块、来源与生成方式**

| 区块 | 内容 | 来源 | 作者写 / 生成 |
|---|---|---|---|
| 页头 | 类型标记、标题（场景卡另有副标题）、原 Lab 编号、难度、时长、上限、费用档位、环境准备、状态、徽章、版本 | `lab.yaml`、构建期计算值、§5 映射、`LabProgress` | 生成 |
| 场景（场景卡） | 考题式描述、约束、常见的错误方案 | `scenario.question`、`constraints[]`、`antiPatterns[]` | 作者 |
| 背景 | 2～5 句的痛点故事 | `story` 作导语；`manual/00-overview.md` 的 `## 背景` 作正文 | 作者 |
| 你将学到 | 3～6 条目标，每条带领域标签 | `objectives` | 生成 |
| 实验资源 | 平台自动准备的起始状态（逐项带理由）、你将亲手完成的目标、预期警告、测试数据、工作台与平台管理通道、结束时的回收范围 | `startProfile.provisions`、`targetModules`、`expectedWarnings`、registry 的模块显示名 | 生成（固定句式，§7.3） |
| 预计费用 | 费用档位、主要计费来源、选做步骤的影响、保留期间仍计费的资源、“计算当前价格”按钮、免责声明 | §3.3、`cost.basis`、`cost.mainDrivers`、02 的报价 | 生成 |
| 步骤概览 | 步骤标题、类型图标、选做、等待、开始计费的提示、预期中断 | `steps[]` | 生成 |
| 对比实验预告 | 每个必需实验：没有它时、有了它后、在哪里看到、结果不符合预期时先查什么 | `experiments[]` 的标题与方向 + `00-overview.md` 的 `## 对比实验预告` | 作者 + 生成 |
| 考点 | 考点列表与易混概念 | `saa` | 生成 |
| 开始前准备 | 建议的前置卡片及其状态、学员输入、账号级影响、平台动作、平台外的人工操作 | `prerequisites`、`platform.accountImpact`、`platformOps` | 生成 |
| 时间与结束 | 上限、延长、保留、结束时回收什么 | `timeLimitMinutes`、`extensions`、`retain`、`cleanup.summary` | 生成 |
| 徽章 | 徽章名、“完成即获得、小测只记录”、已获得时的等级 | `badge`、`LabProgress.badge` | 生成 |
| 所属路径 | 包含本卡的路径及其中的角色（必修 / 选修组 / 可选）与阶段 | `_tracks/*.yaml` | 生成 |
| 可复用的保留环境 | 哪些卡片的保留环境可以直接继续本卡（只是提示；以报价时 02 计算的差异计划为准） | 构建期 `reuseFrom`（§8.6） | 生成 |
| 历次尝试 | 每次会话的时间、结果、报告链接 | `GET /api/v1/labs/{labId}` | 生成 |

**“开始实验”按钮的状态**（由 `GET /api/v1/labs/{labId}` 返回的 `startability` 决定；这只是**预判**，权威判断在 02 的开始编排；原因码以 01 名称表为准，取值来自 02 §13.1）

| 情况（原因码） | 按钮 | 说明文字 |
|---|---|---|
| 可以开始 | “开始实验” | — |
| 其他会话在进行（`SESSION_ACTIVE_EXISTS`） | 置灰 | “svc-database 正在进行，结束后才能开始新的实验” + [回到工作台] |
| 有保留中的环境（`ENV_KEPT_EXISTS`） | “在保留的环境中开始” + 次按钮“释放后全新开始” | 02 §8.4：报价时给出差异计划；冲突时只能释放后全新开始 |
| 本卡的目标已在保留的环境中生效（`TARGET_ALREADY_SATISFIED`） | 只有“释放后全新开始” | “这个环境里 {模块} 已经是 {取值}，在这里开始拿不到本次会话的完成证据” |
| 回收中（`CLEANUP_IN_PROGRESS`） | 置灰 | 显示回收进度 |
| 有未确认的残留（`RESIDUAL_ACK_REQUIRED`） | “确认残留后开始” | 02 §9.2 |
| 维护模式（`MAINTENANCE_MODE`） | 置灰 | 01 |
| 预算已超（`BUDGET_BLOCKED`） | 置灰 | 02 §10.4 |
| 平台正在卸载（`PLATFORM_UNINSTALLING`） | 置灰 | 02 §10.5 |
| 硬前置未完成（`HARD_PREREQ_UNMET`，本文增补） | 置灰 | 目前所有前置卡片都是“建议”，此项为将来预留 |
| `status: deprecated`（`LAB_DEPRECATED`，本文增补） | 隐藏 | “本卡片已停用” |
| 当前用户是助教或观察者 | 隐藏 | — |

最后两个原因码请 01 收录（§9.1）。缺少学员输入（例如域名）**不**置灰按钮：开始对话框会要求填写，02 的账号预检再校验一次。

**学员输入的校验**（第 1 轮审稿结论，改为按 04 的输入 id 书写）：这些值会被代入手册命令与 CloudFormation 参数，开始对话框做即时提示，服务端（`POST /api/v1/sessions`）必须按固定的 RE2 模式校验后才保存，不符合时返回 400 `VALIDATION_FAILED`：

| 输入 id | 规则 |
|---|---|
| `domain` | 小写 FQDN：每段 1～63 个 `[a-z0-9-]`，不以 `-` 开头或结尾，总长 ≤ 253，至少两段；不接受 IP 与通配符 |
| `hosted-zone` | `^Z[0-9A-Z]{4,32}$` |
| `ses-identity` | 邮箱形式按下面的邮箱规则；域名形式同 `domain` |
| `notify-email`、`alert-email`、`recipient-emails` | 保守的邮箱模式（不含空白、引号与 shell 元字符）；`recipient-emails` 最多 2 个 |
| `budget-amounts` | 两个正数，最多两位小数；不给参考值，由学员按自己的承受能力填写 |
| `cost-tags-active` | 学员勾选“已执行并等待生效”的确认，不是自由文本 |

邮箱只用于本会话的订阅与身份验证，不写入证书、报告的公开分享与公开验证页。

### 7.2 作者撰写的部分：`manual/00-overview.md`

04 规定概览文件的 front matter 为 `section: overview`。本文规定它的二级标题与顺序（`labs:lint` 校验，§8.7 C-12）：

````markdown
---
section: overview
---

## 背景

<!-- 2～5 句。第二人称“你”，写一个具体场景：谁、在做什么、遇到了什么问题、这个问题在起始状态下为什么不好解决。
     不写“本实验将带你……”这类空话，不写营销词，不出现价格与性能数字（实验参数除外，例如“第 30 秒重启”）。 -->

:::why
<!-- 可选：用 3～5 句解释原理，默认折叠。 -->
:::

## 为什么组合在一起

<!-- 只有场景卡必填：每个服务在场景中负责什么、它们之间的协作关系、一个常见的错误组合及其问题。单服务卡不写本节。 -->

## 对比实验预告

### <实验标题>（<module>/<experiment-id>，必做 | 选做）

- **没有 <服务>（<本地实现或本地档>）**：<做什么操作>时会发生什么。
- **有了 <服务>**：同样的操作，变化是什么。
- **你会在哪里看到**：<报告中的指标名>、<响应头中的路径段>、<控制台中的位置>。只写方向，不写数值。
- **如果结果不符合预期**：先检查 <1～2 个最常见原因>。

<!-- experiments[] 中每个 required: true 的实验必须有一节；选做实验可以合并成一节。 -->

## 平台模式说明

<!-- 可选。只写平台模式与自用模式不同、且会影响理解的地方（例如 svc-iam 的实例角色、sc-private-network 的管理通道）。 -->
````

场景卡的“场景”区块不写在 `00-overview.md` 中，而由 `lab.yaml` 的 `scenario` 字段生成（考题式描述、约束、常见的错误方案），以便目录搜索与小测引用。

**写作规则**

| 规则 | 说明 |
|---|---|
| 一句话简介（`summary`） | 建议 40～80 字（lint 上限 200）；以动作开头，写清“把什么换成什么、能看到什么差别”；不以“本实验”“学习”开头 |
| 背景 | 场景必须能在 CloudAlbum 里复现；问题必须在起始状态下真实存在 |
| 方向词 | 只用“下降、上升、不变、变为 0、出现、消失、更早、更晚、能、不能”；不写百分比与毫秒数 |
| 术语 | 服务首次出现写全称（Amazon SQS），之后可用简称；模块 id 用代码格式 |
| 费用 | 只写计费维度与“按小时 / 按量 / 按月”，不写金额 |
| 不确定的限制 | 写“以官方文档为准” |
| 链接 | 只允许 `docs.aws.amazon.com`、`aws.amazon.com` 与仓库内文档（04 lint） |

### 7.3 生成部分的固定句式

生成部分由前端组件按下列句式渲染（变量来自构建产物 `cards/<cardId>.json` 与 `GET /api/v1/labs/{labId}`）。作者不能改写，只能通过 `lab.yaml` 的字段影响内容：

| 区块 | 句式 |
|---|---|
| 实验资源 · 起始状态 | “点‘开始实验’后，平台会在你的账号（`{region}`）中自动部署：L0（一台实验机 EC2、独立数据卷、弹性 IP）`{对每个 kind: module 的 provision：}`，并预先启用 **{模块显示名}**（{reason}）。实验机带有平台管理通道（实例角色 `CloudAlbumAppRole`，只含 Session Manager 所需权限，不属于应用权限）。”；`kind: local` 写成“{模块显示名}使用 {本地档名}，作为‘没有它’的基线”；`kind: runtime` 写成“已打开 {热键说明}”；`kind: seed` 写成“已准备 {种子说明}”；`basis: context` 追加“（场景需要：{reason}）”；卡片自带栈写成“另外部署本卡专用的 {栈说明}（不属于 CloudAlbum 模块，结束时一并删除）” |
| 实验资源 · 目标 | “你将亲手完成：**{目标显示名}**（{起始取值} → {目标取值}）。可以用控制台，也可以在工作台终端用 `scripts/module`，平台的检查对两种做法完全相同。”；`adoptsExisting: false` 时去掉控制台路线；选做目标标“（选做）” |
| 实验资源 · 预期警告 | `expectedWarnings` 非空时：“开始时 {模块显示名} 显示‘降级’是预期的：{规则的说明}。” |
| 实验资源 · 工作台 | “每个会话有一台工作台 EC2，预装 AWS CLI、Node.js、k6 与项目仓库；你在工作台终端中的身份是 `ATLLearnerRole`，受权限边界约束。”；`workstation.savingsMode = degraded` 时追加“选择不启动工作台（CloudShell 省钱模式）时，负载类实验的结果只供参考”；`unsupported` 时写“本卡片必须使用工作台” |
| 实验资源 · 回收 | “结束或到期后，平台删除本会话创建的全部资源，包括你在控制台手动创建的；无法自动删除的会列入‘待人工处理清单’。” + `cleanup.summary` |
| 预计费用 | “费用档位：**{档位}**。除实验机与工作台外，主要计费来源：{按小时项} · {按量项} · {按月折算项}。”；选做步骤抬高档位时追加“选做步骤‘{步骤标题}’会增加 {资源}，档位变为 {档位}。”；再追加“保留环境期间仍计费：{保留项}。[计算当前价格]”与免责声明“金额按 {价格表日期} 的价格估算，不含数据传输与部分按请求计费项，以 AWS 官方定价与账单为准” |
| 步骤概览 | 每行：类型图标 + 标题 + 标记（`选做`、`需等待约 N 分钟`（取 `wait.typicalMinutes`）、`开始按小时计费` / `开始按量计费`、`预期中断`（02 §5.8）） |
| 开始前准备 | 学员输入逐项列出（“需要你提供：一个可以修改 NS 记录的域名”）；`accountImpact` 逐项列出（“会修改：本区域的 Session Manager 首选项（结束时还原）”）；平台动作逐项列出（“平台会代你执行：创建演示用的长期访问密钥（结束时删除）”） |
| 时间与结束 | “倒计时从环境就绪开始，上限 {上限}，可延长 {次数} 次、每次 {分钟} 分钟。结束或到期后自动释放；如需改天继续，可以选择保留环境（最长 {小时} 小时，期间持续计费，需要你确认）。” |
| 徽章 | “完成本卡片（最终复核通过）即获得徽章‘{badge.title}’；小测成绩会记在徽章上，不影响完成。” |
| 起始变体 | `select: learner`：“本卡片有 {N} 种起始方式：{变体标题列表}。它们共用一个徽章。”；`select: preflight`：“开始前平台会检查 {探测说明}；不满足时自动改用‘{回退档标题}’，费用档位可能变为 {档位}。” |

### 7.4 示例：svc-queue 渲染后的简介页

以下内容全部取自 service-cards-2 中 svc-queue 的元数据、简介、步骤与对比实验；只有句式来自 §7.3。

> **Amazon SQS：异步任务队列与死信队列**
> 单服务 · D 计算、异步与通知 · 原 Lab 10
> 初级 · 约 60 分钟 · 上限 1.5 小时（可延长 2 次，每次 30 分钟）· 费用 $ 低 · 环境准备：较快

**背景**

起始状态已经是“本地档异步”：任务放进 api 进程内的队列，接口立即返回，但处理仍和 API 抢 CPU；进程一重启，排队和在途的任务全部丢失——缩略图靠对账任务分钟级找回，“上传成功”的通知邮件就真的丢了。这一课把任务放进 Amazon SQS，让“任务还在不在”与“哪个进程还活着”脱钩。

**你将学到**

- 标准队列的至少一次投递与幂等（`processed_jobs` 去重）；FIFO 的取舍（弹性）
- 可见性超时、心跳、长轮询；死信队列、`maxReceiveCount`、`RedriveAllowPolicy` 与重放（弹性）
- 削峰填谷：CPU 曲线从尖峰变成平台；“每实例积压”指标驱动 Auto Scaling（高性能）
- 边界：queue 模块只管应用任务队列，其他模块自带的 SQS 队列不属于它

**实验资源**

- **平台自动准备**：点“开始实验”后，平台会在你的账号（`ap-northeast-1`）中自动部署：L0（一台实验机 EC2、独立数据卷、弹性 IP），并预先启用 **IAM 实例角色**（应用调用 SQS 需要凭证）；缩略图交给 **worker**、任务队列使用 **memory 本地档**，作为“没有 SQS”的基线。实验机带有平台管理通道（实例角色 `CloudAlbumAppRole`，只含 Session Manager 所需权限，不属于应用权限）。
- **你将亲手完成**：**任务队列（Amazon SQS）**（memory → sqs），同时会创建一个死信队列。可以先在控制台手动创建队列与死信队列、再用 `scripts/module` 接管，也可以在工作台终端直接运行 `scripts/module enable queue`，平台的检查对两种做法完全相同。
- **工作台**：一台工作台 EC2，预装 AWS CLI、Node.js、k6 与项目仓库；你在工作台终端中的身份是 `ATLLearnerRole`。
- **回收**：结束或到期后，平台删除本会话创建的全部资源，包括任务队列、死信队列和你在控制台手动创建的队列；队列中未处理的消息随队列一起删除。无法自动删除的会列入“待人工处理清单”。

**预计费用**

费用档位：**低**。除实验机与工作台外，主要计费来源：Amazon SQS 请求（按量；每次 API 调用最多 10 条消息、每 64 KB 算一次；空队列的长轮询也计请求）。本卡片没有按小时计费的托管资源，选做步骤也不会改变档位。保留环境期间仍计费：数据卷与弹性 IP；实验机在节省模式（默认）下停止（02 §8.2）。[ 计算当前价格 ]

> 金额按价格表日期估算，不含数据传输与部分按请求计费项，以 AWS 官方定价与账单为准。

**步骤概览**

| # | 步骤 | 类型 | 标记 |
|---|---|---|---|
| 1 | 观察本地异步：memory 队列 + worker | 观察 | — |
| 2 | 记录 before：突发上传 + 第 30 秒重启 api | 对比实验 | — |
| 3 | 接入 SQS：部署任务队列与死信队列并切换驱动 | 脚本 | 开始按量计费 |
| 4 | 记录 after：同样的突发上传 + 第 30 秒 `kill -9` worker | 对比实验 | — |
| 5 | 投一条坏消息，看它进入死信队列 | 脚本 | 需等待（接收 3 次、每次等可见性超时） |
| 6 | 处理死信：重放回源队列，或导出到 `failed_jobs` | 脚本 | — |
| 7 | （选做）运行时 A/B：同一时段一半请求绕过 SQS | 对比实验 | 选做 |

**对比实验预告**

*突发上传 + 进程被杀（`queue/upload-burst`，必做）*

- **没有 SQS（memory 本地档）**：任务只在 api 进程的内存里，第 30 秒重启 api，排队与在途的任务一起消失。
- **有了 SQS**：同样的突发上传，第 30 秒直接 `kill -9` worker。未删除的消息在可见性超时后重新出现，重启后的 worker 接着处理；重复执行由去重表吸收。
- **你会在哪里看到**：对比报告中的“丢失任务数”（`biz.jobs_lost`）从大于 0 变为 0；EC2 的 CPU 曲线从尖峰变为平台，排空时间变长；响应头 `X-CloudAlbum-Path` 从 `queue=memory:queued` 变为 `queue=sqs:queued`。
- **如果结果不符合预期**：先确认 before 与 after 两次都是 worker 档；再确认 after 杀掉的是 worker 而不是 api。

*坏消息与死信队列（步骤 5、6）*

- **没有死信队列**：一条永远处理失败的消息会被反复接收、占用 worker。
- **有了死信队列**：接收 3 次仍失败后，消息被移到死信队列，源队列恢复畅通；你可以重放它（handler 没修时它会再次进入死信队列），或导出到应用的 `failed_jobs` 表。
- **你会在哪里看到**：死信队列的可用消息数出现 1。

**考点**

标准队列与 FIFO · 可见性超时与心跳 · 长轮询与短轮询 · 死信队列、`maxReceiveCount`、`RedriveAllowPolicy` 与重放 · 消息保留期 · 削峰填谷与按积压扩缩容 · 易混：SQS / SNS / EventBridge / Kinesis 的适用场景。

右栏：建议先完成 svc-ec2、svc-iam；需要你提供：无；账号级影响：无；徽章“削峰填谷”；所属路径：SAA 主线（阶段 4，必修）、弹性专项、Serverless 应用、点名对比快速路径；可复用的保留环境：以构建产物的 `reuseFrom` 为准（例如 svc-iam 的环境）。完整的 `lab.yaml` 写法见 04 §3 与 service-cards-2 附录 A（svc-storage 示例）。

---

## 8. 目录数据、构建产物与 API

### 8.1 文件布局与职责划分

```text
labs/                                     # 仓库根目录（04 §2）
├── _schema/                              # lab、track、taxonomy、catalog 的 JSON Schema（04 维护，由 zod 定义生成）
├── _catalog/
│   ├── taxonomy.yaml                     # 手写：本文 §8.2
│   └── catalog.yaml                      # 生成：npm run labs:catalog 的输出，提交到仓库，CI 重新生成后比较（§8.3）
├── _tracks/<track-id>.yaml               # 手写：学习路径（atl.track/v2，tracks-and-catalog §7.3）
├── svc-<module-id>/lab.yaml …            # 40 张单服务卡片
└── sc-<slug>/lab.yaml …                  # 16 张场景卡片
profiles/atl/<card-id>/<variant>.env      # 生成：随内容发布，不提交（§8.5）
```

**每个事实只写一次**

| 事实 | 唯一来源 | 其他地方 |
|---|---|---|
| 卡片的标题、简介、难度、时长、服务、起始状态、目标、计费依据、步骤、实验、考点、徽章名、所属路径、平台段 | `labs/<card-id>/lab.yaml` | `catalog.yaml` 与构建产物由它生成；本文 §4 是设计期的汇总 |
| 起始状态的推导结果 | `scripts/module plan --start-of`（06） | `lab.yaml` 的 `startProfile.provisions` 必须与之逐项相同（04 DRV-1） |
| 路径的成员、角色、阶段、证书 | `labs/_tracks/*.yaml` | `lab.yaml` 的 `tracks` 必须与之一致（`npm run labs:fix` 可改写） |
| 原 Lab 映射 | 本文 §5 → `_tracks/saa-main.yaml` 条目的 `legacyLab` | `catalog.yaml` 的 `legacyLabs` |
| 类别、服务格、缩写、`iamPrefix`、考试领域、时长分段、费用档位参数、模块部署速度 | `labs/_catalog/taxonomy.yaml` | — |
| 费用档位、部署等级、`reuseFrom`、服务地图、路径时长与卡片数 | 构建计算，写入 `catalog.yaml` | `lab.yaml` 中的 `cost.tier`、`provision.class` 是作者声明的期望值，必须与计算结果一致（04 DRV-11）；本文 §4 的取值按同一规则得出 |
| 学员状态、尝试次数、徽章、掌握度、当前环境 | DynamoDB（`LabProgress`、`LabSession` 等，01） | 运行时合并，不进构建产物 |

`catalog.yaml` 是生成文件，**禁止手改**：CI 重新生成后与仓库中的文件比较，不一致即失败。这样审稿人能在 diff 里直接看到一张卡片的改动对费用档位、部署等级、路径时长的影响。

**目录读取的 `lab.yaml` v2 字段**（字段定义以 04 §3 为准）：`schema`、`id`、`kind`、`version`、`status`、`service` / `function`、`title` / `subtitle`、`summary`、`story`、`scenario`、`objectives`、`difficulty`、`estimatedMinutes`、`timeLimitMinutes`、`extensions`、`retain`、`regions`、`services`、`modules`、`prerequisites`、`startProfile`（`provisions`、`branches`、`platform`、`variants`、`reason`）、`targetModules`（含 `fromDriver`）、`expectedWarnings`、`workstation`、`platform`、`cost`（含 `tier`、`tierWithOptional`、`mainDrivers`）、`provision`、`steps`（概览所需的标题、类型、选做、等待、计费、预期中断）、`experiments`（标题、是否必需、变体标签）、`badge`、`tracks`、`saa`、`tags`、`platformOps`、`extraStacks`。

### 8.2 `taxonomy.yaml`（手写）

内容：

| 段 | 字段 | 说明 |
|---|---|---|
| `categories[]` | `id`（`base`、`A`～`F`）、`label`、`token`（`--cat-*`）、`symbol` | §2.10 的类别、色条与几何符号 |
| `services[]` | `id`、`abbr`、`name`、`short`、`function`、`category`、`module?`、`iamPrefix`、`featureOf?`、`consoleHome?` | 40 个服务格（有 `module`）+ 附属服务（有 `featureOf` 或独立）；`id` 不直接用 IAM 前缀，因为两个模块可能共用一个前缀（shell-access 与 config 都是 `ssm`），`iamPrefix` 单独保存，供权限边界与回收器对照；`consoleHome` 是 03 深链接注册表中该服务“首页”的 `linkId`，卡片没有声明常用页面时控制台标签按卡片的 `services` 列出这些首页（03 §5.4） |
| `domains[]` | `id`（`secure`、`resilient`、`performance`、`cost`，04）、`label`、`weight`、`track` | `weight` 是考试指南给出的领域权重（安全 30、弹性 26、高性能 24、成本优化 20，以官方考试指南为准）；`track` 是对应的专项路径 id（`secure`、`resilient`、`performant`、`cost-optimized`） |
| `durationBuckets[]` | `id`（`short`、`medium`、`long`）、`label`、`maxMinutes?` | ≤ 60、61～120、> 120 |
| `costTier` | `highUnits`（2）、`weights`（`pricingKey` 前缀 → 权重，可为 0）、`accountScopedKeys`（`guardduty.`、`config.`、`inspector.`）、`labels` | §3.3 |
| `provisionSpeed` | 模块 id → `fast` \| `medium` \| `slow` | §3.4；取值来自 02 §11.1 |
| `provisionClasses[]` | `id`（A～D）、`label`、`hint` | 较快、中等、较慢、很慢 |

**服务格**（40 个，顺序即服务地图与卡片网格中的顺序）

| 类别 | 服务格 id | 缩写 | 服务全称 | 机能 | 模块 | `iamPrefix` |
|---|---|---|---|---|---|---|
| 基础 | `ec2` | EC2 | Amazon EC2 | 运行整个应用 | ec2 | `ec2` |
| A | `vpc` | VPC | Amazon VPC | 网络隔离 | network | `ec2` |
| A | `cloudfront` | CF | Amazon CloudFront | 内容分发与边缘缓存 | cdn | `cloudfront` |
| A | `route53` | R53 | Amazon Route 53 | 域名解析 | dns | `route53` |
| A | `acm` | ACM | AWS Certificate Manager | HTTPS 证书 | tls | `acm` |
| A | `waf` | WAF | AWS WAF | Web 应用防护 | waf | `wafv2` |
| A | `elb` | ALB | Elastic Load Balancing | 负载均衡（ALB） | load-balancer | `elasticloadbalancing` |
| A | `autoscaling` | ASG | Amazon EC2 Auto Scaling | 弹性伸缩 | autoscaling | `autoscaling` |
| B | `iam` | IAM | AWS IAM | 服务器访问 AWS 的凭证 | iam | `iam` |
| B | `cognito-user-pool` | CUP | Amazon Cognito User Pool | 用户注册登录 | auth | `cognito-idp` |
| B | `cognito-identity-pool` | CIP | Amazon Cognito Identity Pool | 终端用户直传 S3 | identity-pool | `cognito-identity` |
| B | `secretsmanager` | SEC | AWS Secrets Manager | 密码与密钥管理 | secrets | `secretsmanager` |
| B | `ssm-parameter-store` | PS | AWS Systems Manager Parameter Store | 运行时配置 | config | `ssm` |
| B | `kms` | KMS | AWS KMS | 数据加密密钥 | kms | `kms` |
| C | `s3` | S3 | Amazon S3 | 照片对象存储 | storage | `s3` |
| C | `efs` | EFS | Amazon EFS | 多实例共享文件系统 | shared-fs | `elasticfilesystem` |
| C | `rds` | RDS | Amazon RDS for PostgreSQL | 托管关系数据库 | database | `rds` |
| C | `elasticache` | ELC | Amazon ElastiCache | 共享缓存 | cache | `elasticache` |
| C | `dynamodb` | DDB | Amazon DynamoDB | 点赞、评论与分享链接 | social-store | `dynamodb` |
| C | `backup` | BAK | AWS Backup | 盘外备份与恢复演练 | backup | `backup` |
| C | `firehose` | FH | Amazon Data Firehose | 点击流采集与投递 | analytics | `firehose` |
| D | `lambda` | λ | AWS Lambda | 缩略图生成 | image-processing | `lambda` |
| D | `sqs` | SQS | Amazon SQS | 异步任务队列与死信队列 | queue | `sqs` |
| D | `sns` | SNS | Amazon SNS | 通知扇出与订阅过滤 | notification | `sns` |
| D | `ses` | SES | Amazon SES | 真实发信与退信回流 | email | `ses` |
| D | `scheduler` | SCH | Amazon EventBridge Scheduler | 不漏跑的定时任务 | scheduler | `scheduler` |
| D | `rekognition` | REK | Amazon Rekognition | 图片识别与审核 | tagging | `rekognition` |
| D | `apigateway` | APIG | Amazon API Gateway | 社交 API 托管入口 | social-api | `apigateway` |
| E | `ssm-session-manager` | SSM | AWS Systems Manager Session Manager | 运维登录 | shell-access | `ssm` |
| E | `cloudwatch-logs` | CWL | Amazon CloudWatch Logs | 集中日志 | logging | `logs` |
| E | `cloudwatch` | CW | Amazon CloudWatch | 指标、告警与仪表板 | monitoring | `cloudwatch` |
| E | `xray` | XR | AWS X-Ray | 分布式链路追踪 | tracing | `xray` |
| E | `cloudtrail` | CT | AWS CloudTrail | AWS API 操作审计 | audit | `cloudtrail` |
| E | `guardduty` | GD | Amazon GuardDuty | 威胁检测 | threat-detection | `guardduty` |
| F | `config` | CFG | AWS Config | 配置合规与漂移检测 | compliance | `config` |
| F | `inspector` | INS | Amazon Inspector | 漏洞扫描 | vuln-scan | `inspector2` |
| F | `budgets` | BUD | AWS Budgets | 费用护栏与告警 | cost | `budgets` |
| F | `rds-proxy` | RDSP | Amazon RDS Proxy | 数据库连接池 | db-proxy | `rds` |
| F | `stepfunctions` | SFN | AWS Step Functions | 照片处理流程编排 | workflow | `states` |
| F | `imagebuilder` | IMB | EC2 Image Builder | 黄金 AMI 构建 | ami | `imagebuilder` |

**附属服务**（不单独计算掌握度，只出现在筛选、卡片服务排与服务地图侧栏中）：`ebs`（EBS，属 ec2）、`nat-gateway`（NAT，属 vpc）、`vpc-endpoint`（VPCE，属 vpc）、`eventbridge`（EB）、`athena`（ATH，属 firehose）、`glue`（GLU，属 firehose）、`cost-explorer`（CE，属 budgets）、`shield`（SHD，属 waf）、`sts`（STS，属 iam）。它们的 `iamPrefix` 依次为 `ec2`、`ec2`、`ec2`、`events`、`athena`、`glue`、`ce`、`shield`、`sts`。

`lab.yaml` 的 `services[].id` 必须取自本表（04 §3.2.2）；单服务卡的 `primary` 服务格与 id 中的模块一一对应。

### 8.3 `catalog.yaml`（生成）

由 `npm run labs:catalog` 读取全部 `lab.yaml`、`_tracks/*.yaml`、`taxonomy.yaml` 与 `scripts/module plan --start-of` 的输出生成。

```yaml
# labs/_catalog/catalog.yaml —— 由 npm run labs:catalog 生成，请勿手改
schema: atl.catalog/v1
source: { gitCommit: 3f2a…, contentDigest: sha256:…, registryVersion: …, toolkitVersion: …, taxonomyVersion: … }
counts: { cards: 56, service: 40, scenario: 16, tracks: 9 }
cards:
  - id: svc-queue
    kind: service
    version: 1.0.0
    status: beta
    title: Amazon SQS：异步任务队列与死信队列
    service: Amazon SQS
    function: 异步任务队列与死信队列
    category: D
    services: [{ id: sqs, role: primary }]                     # context、observed 不进目录
    servicesCount: 1
    domains: [resilient, performance, cost]
    difficulty: beginner
    estimatedMinutes: 60
    timeLimitMinutes: 90
    durationBucket: short
    costTier: { required: low, withOptional: low, hourlyUnits: 0, accountScoped: [] }
    provisionClass: A
    startProfiles:
      - { name: atl/svc-queue/default, variant: default, select: default, modules: [iam],
          localSettings: { IMAGE_PROCESSOR: worker, QUEUE_DRIVER: memory }, platform: { previewDirectHttps: 'on' },
          provisionClass: A, costTier: low, planDigest: sha256:… }
    targets: [{ module: queue, from: memory, to: sqs }]
    learnerInputs: []
    accountImpact: []
    platformOps: []
    flags: []                                                   # needs-advance、limited、needs-domain、domain-optional、needs-email、account-impact、long-wait、beta
    credits: [sqs]
    badge: { title: 削峰填谷 }
    tracks: [saa-main, resilient, serverless, quick-compare]
    legacyLabs: [10]
    reuseFrom: [{ labId: svc-iam, extraModules: [] }]
  - id: sc-decoupling
    kind: scenario
    title: 削峰与重试
    subtitle: SQS + EC2 worker + Lambda + DLQ
    services: [{ id: sqs, role: primary }, { id: lambda, role: primary }, { id: ec2, role: supporting }, { id: eventbridge, role: supporting }]
    servicesCount: 4
    difficulty: intermediate
    estimatedMinutes: 90
    timeLimitMinutes: 150
    costTier: { required: low, withOptional: low, hourlyUnits: 0, accountScoped: [] }
    provisionClass: A
    startProfiles:
      - { name: atl/sc-decoupling/default, variant: default, select: default, modules: [iam, storage],
          localSettings: { QUEUE_DRIVER: memory, IMAGE_PROCESSOR: worker }, provisionClass: A, costTier: low, planDigest: sha256:… }
    targets: [{ module: queue, from: memory, to: sqs }, { module: image-processing, from: worker, to: lambda }]
    credits: [sqs, lambda, ec2]
    tracks: [saa-main, resilient, serverless]
    legacyLabs: [10]
    reuseFrom: [{ labId: svc-storage, extraModules: [] }]
    # 其余字段同上，从略
tracks:
  - { id: quick-compare, requiredCards: 7, totalCards: 8, requiredMinutes: 585, totalMinutes: 645 }
  # 其余 8 条从略；时长由构建计算
serviceMap:
  - { id: sqs, module: queue, category: D, abbr: SQS, serviceCard: svc-queue,
      creditedBy: [sc-decoupling, sc-serverless-api], appearsIn: [sc-event-fanout, sc-image-pipeline, sc-observability] }
  # 其余 39 格从略
```

- `startProfiles[]` 对每个变体与回退档各有一项；`select` 为 `default`、`learner` 或 `preflight`。卡片级的 `costTier` 取所有变体中**较高**的档位（费用宁可往高处提示），`provisionClass` 取 `default` 变体的等级；与之不同的变体在简介页单独注明（svc-tls 的 `acme-off` 为 B，§4.6）。
- `credits` 是本卡可计入的服务格（目标模块对应的服务格 + `services[].creditBy` 声明的服务）；`serviceMap.creditedBy` 与 `appearsIn` 由此反推。计入规则见 tracks-and-catalog §5.4。
- 示例中的 `tracks`、`reuseFrom` 只为说明格式，实际取值以构建结果为准。

### 8.4 构建产物

`npm run labs:build`（04 §2）在展开卡片内容之外，生成目录产物：

```text
dist/content/<catalogVersion>/
├── catalog/
│   ├── index.json               # 目录页、服务地图、路径视图所需的全部静态数据
│   └── cards/<cardId>.json      # 简介页所需的静态数据（不含手册正文的步骤 AST 与小测答案）
├── profiles/atl/<cardId>/<variant>.env   # 起始档位（§8.5）
└── manifest.json                # 全部文件的 SHA-256（02 的运行器据此校验档位）
```

发布时随内容包复制到平台站点桶的 `/content/<catalogVersion>/`（桶名与发布流程以 01 为准），路径带版本号、可长缓存。

```ts
// platform/api/contracts/catalog.ts（workspace 包 @atl/contracts，web 与 api 共用）
export type Difficulty = 'intro' | 'beginner' | 'intermediate' | 'advanced';
export type SaaDomain = 'secure' | 'resilient' | 'performance' | 'cost';
export type CostTier = 'low' | 'medium' | 'high';
export type CardKind = 'service' | 'scenario';

export interface CatalogIndex {
  schema: 'atl.catalog-index/v2';
  catalogVersion: string;                 // 01 CatalogRelease
  contentDigest: string;
  generatedAt: string;
  taxonomy: Taxonomy;                     // 原样来自 taxonomy.yaml
  defaults: { view: 'grid' | 'map' | 'tracks'; group: 'kind' | 'category' | 'domain' | 'none'; sort: 'path' | 'duration' | 'cost' | 'recent'; track: string };
  cards: CatalogCard[];
  tracks: TrackSummary[];                 // 路径文件的摘要；结构见 tracks-and-catalog §7.3
  serviceMap: ServiceCell[];
}

export interface CatalogCard {
  id: string;                             // svc-queue、sc-decoupling（即 labId）
  kind: CardKind;
  version: string;
  status: 'beta' | 'stable' | 'deprecated';
  title: string; subtitle?: string; service?: string; function?: string; summary: string;
  category?: string;                      // 单服务卡的类别（base、A～F）
  services: { id: string; role: 'primary' | 'supporting'; optional?: boolean }[];
  servicesCount: number;
  difficulty: Difficulty;
  estimatedMinutes: number;
  timeLimitMinutes: number;
  durationBucket: 'short' | 'medium' | 'long';
  costTier: { required: CostTier; withOptional: CostTier };
  costSources: { hourly: string[]; usage: string[]; monthly: string[] };      // 显示名，不含金额
  provisionClass: 'A' | 'B' | 'C' | 'D';
  variants: { id: string; title: string; select: 'default' | 'learner' | 'preflight'; provisionClass: 'A' | 'B' | 'C' | 'D'; costTier: CostTier }[];
  learnerInputs: { id: string; required: boolean }[];
  accountImpact: { id: string; resource: string; revert: string }[];
  platformOps: { id: string; title: string; optional: boolean }[];
  saa: { domains: SaaDomain[]; primaryDomain: SaaDomain; topicTitles: string[] };
  scenarioQuestion?: string;
  tags: string[];
  tracks: { trackId: string; stageId: string; role: 'required' | 'elective' | 'optional'; groupId?: string }[];
  legacyLabs: number[];
  flags: string[];
  badge: { title: string; short?: string };
  prerequisites: { id: string; kind: 'soft' | 'hard' }[];
  reuseFrom: { labId: string; extraModules: string[]; warn?: 'hourly' | 'baseline' }[];
  searchText: string;                     // 预先拼好的小写搜索文本（含原 Lab 编号）
}

export interface ServiceCell {
  id: string; module: string; category: string; abbr: string;
  serviceCard: string; creditedBy: string[]; appearsIn: string[];
}

export interface CardIntro {              // catalog/cards/<cardId>.json
  id: string;
  overview: unknown;                      // 00-overview.md 编译后的 mdast（04）
  scenario?: { question: string; constraints: string[]; antiPatterns: string[] };
  objectives: { text: string; domain: SaaDomain; relatesTo?: string }[];
  resources: {
    provisions: { item: string; kind: 'module' | 'local' | 'runtime' | 'seed' | 'platform'; displayName: string; reason: string; variant: string }[];
    extraStacks: { id: string; title: string }[];
    targets: { moduleId: string; displayName: string; from?: string; to: string; optional: boolean }[];
    expectedWarnings: { rule: string; text: string }[];
  };
  steps: { id: string; type: string; title: string; optional: boolean; wire: boolean;
           wait?: { typicalMinutes: number; maxMinutes: number }; startsBilling?: { class: string }; expectedOutage?: boolean }[];
  experiments: { module: string; id: string; title: string; required: boolean; labels: string[] }[];
  saa: { topics: { title: string; domain: SaaDomain }[]; confusables: { a: string; b: string; rule: string }[] };
  cleanupSummary: string;
  timing: { extensions: { maxCount: number; minutesEach: number }; retain: { allowed: boolean; maxHours?: number } };
}
```

### 8.5 生成的起始档位文件

`labs:build` 对每张卡片的每个变体执行 `scripts/module plan --start-of <card-id> --variant <id> --platform --json`（06），生成 `profiles/atl/<card-id>/<variant>.env`。键名与格式以 06（`scripts/module` 平台模式）为准，下例只示意：

```bash
# profiles/atl/svc-queue/default.env —— 由 labs:build 生成，请勿手改
PROFILE_NAME=atl/svc-queue/default
PROFILE_EXTENDS=l0-ec2
PROFILE_MODULES=iam
PROFILE_DRIVERS=IAM_CREDENTIALS=role
PROFILE_PARAMS=
PROFILE_LOCAL_SETTINGS=IMAGE_PROCESSOR=worker,QUEUE_DRIVER=memory
PROFILE_RUNTIME=
PROFILE_SEEDS=
PROFILE_EXTRA_STACKS=
PROFILE_PLATFORM=preview.directHttps=on
PROFILE_PLAN_DIGEST=sha256:…
PROFILE_SOURCE=labs/svc-queue/lab.yaml@1.0.0
```

规则：

1. 档位名一律 `atl/<card-id>/<variant>`，默认变体 `default`（§4.5 D-13）。
2. `PROFILE_PLATFORM` 只在 `--platform` 下生效：`preview.directHttps=on` 时由 `scripts/module` 附加方案 B 的 tls 本地档（06）。
3. `${atl:…}` 占位符原样保留，由 02 的运行器在 `profile-apply` 前替换（§3.5）。
4. 起始档位只做“加法”：`PROFILE_EXTENDS=l0-ec2`，不继承 `l1`～`l9`。
5. 文件不提交到仓库，随内容发布；SHA-256 记在 `manifest.json`，`PROFILE_PLAN_DIGEST` 写入 `startProfileDigest`。02 的运行器部署前下载、校验并用 `plan --profile atl/<card-id>/<variant>` 复核摘要（运行期没有 `lab.yaml`，两条命令的摘要算法相同，02 §3.6、06 PM-32；不一致为 `PROFILE_DIGEST_MISMATCH`）。
7. `PROFILE_EXTRA_STACKS` 列出 `deploy: start` 的卡片自带栈（格式 `<stackId>@<region>`，06 PM-33），由运行器 `extra-stack` 部署，例如 sc-backup-dr 为 `dr-crr-target@dr-region,dr-crr-role@app`。
6. 自用模式下也可以用 `scripts/module profile apply atl/svc-queue/default` 复现平台的起始状态；含 `${atl:…}` 占位符的档位需要用 `--param` 手动给值，否则 `scripts/module` 拒绝执行（06）。

### 8.6 `reuseFrom` 的生成规则

卡片 B 的 `reuseFrom` 列出卡片 A，当且仅当：

1. B 的起始模块集合 ⊆ A 结束时的模块集合（A 的起始 + A 的必做目标）；
2. B 的每个目标在 A 结束时的取值都**不等于** B 的目标取值（否则复用后拿不到本会话的完成证据，02 §8.4 `TARGET_ALREADY_SATISFIED`）；
3. A 结束时没有与 B 的起始状态冲突的取值（互斥规则、需要“降级”的变更，例如 network 从 private 回到 public，02 §8.4 第 1 条）。

A 结束时多出的模块中有按小时计费的资源（`warn: hourly`），或有会改变 B 的“没有它”基线的模块（`warn: baseline`：registry 中与 B 的目标模块处于同一请求路径的模块，例如 database 前面多了 cache）时，仍然列出但排在无影响的候选之后，简介页提示“可复用，但会带上 {模块}：持续计费，并可能影响基线”。每张卡片只保留路径顺序上最接近的 3 个。这只是提示；能否复用、增量计划是什么，由 02 在报价时按环境的真实状态计算（02 §8.4）。

### 8.7 目录相关的 lint 规则（`npm run labs:lint` 增补）

04 的 schema 校验、`labs:derive`（DRV-*）与 tracks-and-catalog §7.7 的规则之外，目录另有：

| # | 规则 | 级别 |
|---|---|---|
| C-1 | `taxonomy.yaml` 通过 schema 校验；服务格 id 与缩写唯一；registry 中的每个模块（含 ec2）恰好对应一个服务格；类别 token 在 `tokens.css` 中存在 | error |
| C-2 | `catalog.yaml` 与重新生成的结果完全相同（不允许手改） | error |
| C-3 | `lab.yaml` 的 `services[].id` 都在 taxonomy 中；`permissions` 中出现、而 `services` 中没有对应 `iamPrefix` 的服务给出警告 | error / warn |
| C-4 | id 前缀与 `kind` 一致；`svc-<module>` 中的模块存在于 registry，40 张单服务卡恰好覆盖全部模块各一次；`sc-<slug>` 的 slug ≤ 24 字符 | error |
| C-5 | 单服务卡：`title` 等于 `<service>：<function>`，`service` 等于 primary 服务格的全称 | error |
| C-6 | 难度：场景卡不得低于中级；`intro` 只用于没有目标模块的卡片；目标模块 ≥ 3 个、或费用档位为高、或部署等级为 C/D 而难度低于中级时警告 | error / warn |
| C-7 | 构建计算的费用档位（`required`、`withOptional`）与部署等级等于 `lab.yaml` 的 `cost.tier`、`cost.tierWithOptional`、`provision.class`（与 04 DRV-11 同一检查，未写 `tierWithOptional` 时断言它等于 `tier`） | error |
| C-8 | 时长：`estimatedMinutes` 为 15 的整数倍；`timeLimitMinutes` 为 30 的整数倍且 ≥ 预计 × 1.5（04 已有，目录构建复核） | error |
| C-9 | 方案 B：起始状态或目标含 autoscaling、目标含 tls、或某个目标把 network 改为 private 的卡片（含各变体），`startProfile.platform.preview.directHttps` 必须为 `off` | error |
| C-10 | 任何路径的必修卡片都不得有必填的 `domain` 学员输入（需要域名的卡片不能卡住路径证书）；邮箱类输入不在此列 | error |
| C-11 | `_tracks/saa-main.yaml` 中原 Lab 0～25 每个编号至少出现在一个条目的 `legacyLab` 中；`legacyLab` 的取值与本文 §5 一致（由 `labs:fix` 改写） | error |
| C-12 | `manual/00-overview.md` 含 `## 背景` 与 `## 对比实验预告`，场景卡另含 `## 为什么组合在一起`；每个必需实验在“对比实验预告”下有一个三级标题包含其 `<module>/<id>` | error |
| C-13 | `summary` 40～200 字；`title` ≤ 48 字（04） | error |
| C-14 | `platform.consoleLinks` 中的 id 都在 03 的深链注册表中 | error |
| C-15 | `prerequisites.learnerInputs` 含 `cost-tags-active` 的卡片，其简介页必须能找到执行 `cost-activate-tags` 的入口（本卡的 `platformOps` 或路径的准备说明） | warn |

### 8.8 API 与缓存

目录只用 01 名称表中的路由（K12），本文规定它们的响应内容。卡片 id 就是路径中的 `labId`。

| 端点 | 返回 | 缓存 |
|---|---|---|
| `GET /api/v1/catalog` | 当前目录版本与静态内容地址 | `ETag` = `catalogVersion`；`Cache-Control: private, max-age=60` |
| `GET /api/v1/labs` | 每张卡片的个人状态与徽章、当前环境、当前路径 | `ETag`（按 `LabProgress` 与锁的版本）；`Cache-Control: no-cache`；页面可见时每 60 秒、环境处于准备中或结束中时每 10 秒用 `If-None-Match` 轮询 |
| `GET /api/v1/labs/{labId}` | 简介页的个人部分：状态、徽章、历次尝试、`startability`；静态部分由前端另取 `cards/<cardId>.json` | 同上 |
| `POST /api/v1/labs/{labId}/quotes` | 开始前报价（`purpose: START \| REUSE`、`variant?`、`reuseEnvironmentId?`；`CostQuote` 有效 15 分钟，02 §3.2）；简介页的“计算当前价格”与开始对话框共用 | 不缓存 |
| `GET /api/v1/me/mastery` | 40 个服务格的掌握度（语义见 tracks-and-catalog §5.4） | `Cache-Control: no-cache`，与 `GET /api/v1/labs` 同步刷新 |
| `PATCH /api/v1/me` | 修改 `currentTrackId` 等个人设置 | — |

```http
GET /api/v1/catalog
```

```json
{
  "catalogVersion": "2026.10.1",
  "contentDigest": "sha256:9c1f…",
  "indexUrl": "/content/2026.10.1/catalog/index.json",
  "cardIntroUrlTemplate": "/content/2026.10.1/catalog/cards/{labId}.json",
  "region": "ap-northeast-1",
  "drRegion": "ap-northeast-3"
}
```

`drRegion` 为空字符串时，目录给相关卡片加“部分不可用”提示标记（§2.8）。

```http
GET /api/v1/labs
If-None-Match: "lp-57"
```

```json
{
  "catalogVersion": "2026.10.1",
  "currentTrackId": "saa-main",
  "environment": {
    "holderLabId": "svc-database",
    "sessionId": "s4k7m2q9x1abc",
    "state": "RUNNING",
    "deadlineAt": "2026-10-13T08:15:00Z",
    "keepUntil": null,
    "costTier": "high"
  },
  "items": [
    { "labId": "svc-queue", "status": "completed", "attempts": 2, "bestAttemptId": "s1x…", "firstCompletedAt": "2026-10-09T03:12:00Z",
      "completedMajorVersion": 1, "badge": { "level": "verified", "status": "valid", "earnedAt": "2026-10-09T03:12:00Z" },
      "lastSession": { "sessionId": "s1x…", "state": "ENDED" } },
    { "labId": "sc-event-fanout", "status": "attempted", "attempts": 1, "lastSession": { "sessionId": "s2p…", "state": "ENDED" } },
    { "labId": "svc-database", "status": "not_started", "attempts": 0, "lastSession": { "sessionId": "s4k7m2q9x1abc", "state": "RUNNING" } }
  ],
  "serverNow": "2026-10-13T07:02:41Z"
}
```

- `items` 只包含有记录的卡片；没有记录的视为 `not_started`、`attempts: 0`。`attempts` 不含启动失败而作废的尝试（04 §8.4 `void`）。`badge` 的字段以 01 的 `LabProgress.badge` 为准（tracks-and-catalog W-01-2）。
- `environment` 来自 `ActiveEnvironmentLock` 与持有者会话（02 §3.4）；没有环境时为 `null`。

```http
GET /api/v1/labs/svc-cache
```

```json
{
  "labId": "svc-cache",
  "catalogVersion": "2026.10.1",
  "progress": { "status": "not_started", "attempts": 0 },
  "attempts": [],
  "startability": {
    "canStart": false,
    "reasons": [ { "code": "SESSION_ACTIVE_EXISTS", "detail": "svc-database 正在进行，剩余 1 小时 12 分", "sessionId": "s4k7m2q9x1abc" } ],
    "reuse": null,
    "variants": [ { "id": "default", "select": "default" } ]
  }
}
```

`startability.reuse` 在存在 `KEPT` 环境时给出 `{ environmentId, fromLabId, compatible: true | false, reason? }`（`reason` 可以是 `TARGET_ALREADY_SATISFIED`），只是提示；差异计划在报价中计算（02 §8.4）。

```http
GET /api/v1/me/mastery
```

```json
{
  "catalogVersion": "2026.10.1",
  "services": [
    { "id": "sqs", "level": "mastered", "score": 62, "needsReview": true,
      "serviceCard": { "labId": "svc-queue", "badgeLevel": "verified" },
      "scenarioCredits": [], "quiz": { "correct": 2, "total": 15 } }
  ]
}
```

**事件**：本文不新增事件类型，也不订阅事件。目录页按轮询刷新；会话状态变化通过 `GET /api/v1/labs` 的 `environment` 字段反映。

---

## 9. 与其他文档的接口与待配合事项

本文只修改自身。下列事项由各文档的负责流程落实；与 §4.5 重复的卡片取值差异不再列出。

### 9.1 对 01（名称表、实体与权限）

| # | 要求 | 原因 |
|---|---|---|
| 1 | 名称表收录目录使用的路由：`GET /api/v1/catalog`（响应含 `indexUrl`、`cardIntroUrlTemplate`、`drRegion`）、`GET /api/v1/labs`（`items[].badge`、`environment`、`currentTrackId`）、`GET /api/v1/labs/{labId}`（`startability.variants`、`reuse`）、`POST /api/v1/labs/{labId}/quotes`（废弃 `/estimate`）、`GET /api/v1/me/mastery`（新增）、`PATCH /api/v1/me`（`currentTrackId`） | §8.8；平台评审统一取值（报价接口） |
| 2 | `Learner.currentTrackId`（默认 `saa-main`）；`LabProgress` 增加 `badge`、`credits[]`、`regressions[]`（tracks-and-catalog W-01-2）；`Certificate` 在 `scope: track` 时记录 `trackId` 与路径版本 | 继续学习条、徽章位、服务地图、路径证书 |
| 3 | 错误码表收录 `HARD_PREREQ_UNMET`、`LAB_DEPRECATED`（本文增补，§7.1），以及 02 已使用的 `TARGET_ALREADY_SATISFIED`、`VARIANT_UNKNOWN` | 简介页的 `startability` |
| 4 | 名称表收录起始档位名 `atl/<card-id>/<variant>`（默认 `default`）与档位文件路径 `profiles/atl/<card-id>/<variant>.env`；静态内容路径 `/content/<catalogVersion>/catalog/{index.json, cards/<cardId>.json}` | §4.5 D-13、§8.4 |
| 5 | 标签 `atl:lab-id` 的取值规则改为卡片 id 正则 `^(svc\|sc)-[a-z0-9]+(-[a-z0-9]+)*$`（键名不变；正则写法同 tracks-and-catalog §1.2） | 卡片 id 就是 `labId` |
| 6 | **已落实**：01 §6.5 的 `DrRegionLimited`（原 `DrRegionBackupOnly`）放行 svc-backup、sc-backup-dr 所需的 CloudFormation 栈（护栏限定 `stack/cloudalbum-*`）、S3 目标桶、EBS 卷恢复与 RDS 跨区域只读副本；`ATLProvisionerRole` 经 `ATL_OP=extra-stack` 部署卡片自带栈 `cloudalbum-<envName>-x-*`（tracks-and-catalog W-01-10、第 2 批 C-6） | §4.7 |
| 7 | `ATLProvisionerRole` 覆盖卡片声明的平台动作：长期密钥演示用户（`/cloudalbum/` 路径、强制 `ATLWorkloadBoundary`）、对 `CloudAlbumAppRole` 添加 / 删除撤销旧会话的内联策略、让实验机换新凭证（实测无效时以重启兜底，07）、`ce:UpdateCostAllocationTagsStatus`（成员账号调用失败时原样返回原因） | svc-iam、svc-cost、sc-security-baseline、sc-cost-optimization |
| 8 | `CloudAlbumAppRole` 复位时删除角色上**不属于平台栈**的全部内联策略（包括学员在 IAM 控制台“撤销活动会话”产生的 `AWSRevokeOlderSessions`），保留栈声明的 `atl-terminal-recording`（01 §6.6 第三轮）：学员边界允许对这个带 `ATLWorkloadBoundary` 的角色写内联策略 | svc-iam；平台管理通道不能因上一张卡片而失效 |

### 9.2 对 02

| # | 要求 |
|---|---|
| 1 | 起始档位名、变体与回退档的解析、健康门对 `expectedWarnings` 的处理已与本文一致（02 §3.6）；§3.5 的平台占位符四个名字即 02 §3.6 所说“由 04/05 统一命名”的结果，运行器在 `profile-apply` 前替换，缺值时失败并给出原因 |
| 2 | 每张卡片的部署等级以构建产物 `catalog.yaml` 的 `provisionClass` 为准（本文 §4 为设计期望值）；02 §11.2 按旧 Lab 编号的推导表由它取代（tracks-and-catalog W-02-6） |
| 3 | 回收器按卡片的 `platform.accountImpact` 还原账号级状态（§4.7）：GuardDuty 检测器、Config 记录器与投递通道、Inspector 扫描类型（本会话创建或激活的）、`SSM-SessionManagerRunShell`（还原备份）、SES 身份（本会话创建的删除）、预算（删除）、成本分配标签（不撤销）、`CloudAlbumAppRole` 上的撤销策略（删除）；未保留托管区域时，“删除上级区域中的 NS 委派”作为安全类条目进入待人工处理清单 |
| 4 | 账号预检：SES 发件身份尚未验证不判为失败（它在卡内验证，第 2 批 C-12）；`DrRegion` 为空时 svc-backup 只跳过跨区域部分，sc-backup-dr 的灾备步骤标为不可用（目录的“部分不可用”提示与此一致） |
| 5 | `reuseFrom` 只是目录与简介页的提示；能否复用、增量计划是什么，以报价时的差异计划为准（02 §8.4） |
| 6 | `POST /api/v1/sessions` 按 §7.1 的规则校验 `learnerInputs`，不符合时返回 400 `VALIDATION_FAILED`；邮箱类输入不写入证书与公开页面 |

### 9.3 对 03

| # | 要求 |
|---|---|
| 1 | 预览：`startProfile.platform.preview.directHttps` 为 `off` 的 5 张卡片（§4.6）与 03 §6.2 的清单一致；为 `off` 时优先嵌入 cdn 入口，没有时“在新标签页打开” |
| 2 | 深链接注册表为 taxonomy 的 40 个服务格各登记一个“服务首页” `linkId`（`taxonomy.yaml` 的 `consoleHome`，§8.2）；第 1 轮请求补充的常用页面 id 继续有效：`cloudwatch.alarms`、`route53.hostedZone`、`acm.certificates`（CloudFront 用的证书传 `us-east-1`）、`ses.identities`、`sns.topics`、`stepfunctions.stateMachines`、`scheduler.schedules`、`kms.keys`、`secretsmanager.secrets`、`ssm.parameters`、`elasticache.caches`、`apigateway.apis`、`firehose.streams`、`athena.editor`、`ec2.autoScalingGroups`、`imagebuilder.pipelines`、`efs.fileSystems`、`xray.traceMap`、`guardduty.findings`、`backup.vaults`、`config.rules`、`inspector.findings`（URL 模板以 03 的注册表与巡检为准） |
| 3 | CloudShell 省钱模式按卡片的 `workstation.savingsMode`；需要 SSH 基线的卡片（svc-shell-access 沿用第 1 轮 Lab 2 的结论，sc-private-network 同理：SSH 只放行工作台地址）应声明 `unsupported`，由卡片文档补写 |
| 4 | 工作台页头显示类型标记、服务缩写方块与所选变体（tracks-and-catalog W-03-1）；缩写与类别色取自 taxonomy（§2.10） |

### 9.4 对 04

| # | 要求 |
|---|---|
| 1 | ~~lint 第 5 条增加 `sc-security-baseline` 例外~~：第 3 轮撤回，该卡按 C3 预置 iam（§4.5 D-8） |
| 2 | **已落实**：起始档位名统一为 `atl/<card-id>/<variant>`（默认 `default`），§2 的生成物与 §3.2.3 第 3 条已对齐（§4.5 D-13） |
| 3 | **已落实**：§3.2.2 与 §11 示例中的服务格 id 已改为 `ssm-session-manager`（§8.2 是分类法的权威）；`services[].id` 的 lint 读取 `taxonomy.yaml` |
| 4 | `difficulty`、`estimatedMinutes`、`timeLimitMinutes`、`cost.tier`、`provision.class` 的判定引用本文 §3（04 已写“05 目录总则”）；`cost.basis[].source` 增加 `extra-stack`、`step` 两种来源，供 §3.3 的算法计入卡片自带栈与卡内临时 EC2 |
| 5 | **已落实**：04 §5.7 已收录 Config、Inspector、`glue:GetTable`、`athena:GetQueryExecution`、`backup` 与 `route53` 的若干只读动作（tracks-and-catalog W-04-9） |
| 6 | 场景卡的 `manual/00-overview.md` 增加必填二级标题 `## 为什么组合在一起`（§7.2，目录 lint C-12） |

### 9.5 对 06

| # | 要求 |
|---|---|
| 1 | `scripts/module plan --start-of <card-id> [--variant <id>] --platform --json` 的输出要包含目录需要的字段：起始模块与取值、本地设置、运行时热键、种子、卡片自带栈、平台段（`preview.directHttps` 的推导与原因）、部署等级所需的慢资源分类、`digest`（§3.4、§8.3、§8.5） |
| 2 | 测试数据种子的 id 与说明文字（本地测试账号、已确认的 Cognito 测试用户、带 GPS 信息的示例照片），供简介页“实验资源”区块显示（§3.5 第 8 条） |
| 3 | 实验变体标签扩展为 `--label <任意变体>` 后，简介页“对比实验预告”的变体名取自 `experiments[].labels[]`（04），不再限于 before / after |

### 9.6 对 cards/ 各文件

| 文件 | 要求 |
|---|---|
| service-cards-1 | §4.5 D-1（network、cdn、dns、tls、waf、load-balancer 加 iam）、D-2（svc-network 改为 public 目标）；总表与 §1.1 规则 3 按 C3 改写 |
| service-cards-2 | D-1（shared-fs、database、cache、backup、social-api 加 iam）；§1.1 第 4 条、附录 C-1 按 C3 关闭 |
| service-cards-3 | D-1（audit、threat-detection、cost、compliance、ami 加 iam；svc-compliance、svc-threat-detection 的 wire 步骤去掉 `enable iam`）、D-10（约定 §3 第 9 条、§4 的占位符措辞） |
| scenario-cards.md | D-4（sc-event-fanout 中级）、D-5（sc-analytics 的 parquet 必做）、D-9（sc-cost-optimization 的标签激活走平台动作）、D-10（sc-private-network 删除 `${atl:workstationCidr}`）、D-11（`regions.extra: [dr-region]`）、D-12（学员输入 id）；附录 A 的“与旧 Lab 的对应”改为引用本文 §5 |
| tracks-and-catalog.md | D-3（svc-ami 时长与路径时长）、D-6、D-7、D-14、D-15；**职责调整**：§6（目录页信息架构）、§7.4（`taxonomy.yaml`）、§7.5（`catalog.yaml`）改为引用本文 §2、§8.2、§8.3，§4.2.1 的“原 Lab 编号 → 卡片”改为引用本文 §5；§8.1“05 取代与保留”一节按本轮结果更新 |
| 全部 | 种子（svc-auth 的本地测试账号、svc-identity-pool 与 sc-user-identity 的 Cognito 测试用户、svc-kms 的 GPS 示例照片）改为引用 06 的种子 id，写进 `startProfile.provisions`（`kind: seed`） |

第 3 轮状态：D-1（三批逐卡文档已预置 iam）、D-3（tracks-and-catalog 已为 4785 分钟）、D-8（sc-security-baseline 按 C3 预置 iam，本文改为与 scenario-cards 一致）、D-13（档位名）、D-16（服务格 id）与“全部”一行的种子 id（`cognito-test-users`、`gps-sample-photos`，§4.2、§4.3 已同步）均已落实；其余各项的状态以对应文件的修订记录为准。

### 9.7 docs/platform 之外（只记录，由主设计者统一回写）

| 文档 | 改动 |
|---|---|
| README.md | 学习路线表下注明“平台模式下以卡片为单位学习，原 Lab 0～25 对应的卡片见 `docs/platform/05-lab-catalog.md` §5，学习路径见 `cards/tracks-and-catalog.md`”；预设档位中提到生成档位 `profiles/atl/<card-id>/<variant>.env`；Lab 1、Lab 2 的主题按 P7 调整（平台评审 writeback 第 35 条） |
| docs/labs.md | 每个 Lab 的开头加“对应卡片”一行（取 §5.1）；平台模式下的差异以卡片为准，手工清理只适用于自用模式 |
| docs/modular-design.md | `scripts/module plan --start-of` 与生成档位格式（由 06 统一回写，C5） |
| docs/saa-coverage.md | 增加“平台学习路径与卡片”一节，链接到本文 §5 与 tracks-and-catalog §4 |
| docs/ui-design.md | 顶部“已被平台方案取代”的说明中，注明四级难度、费用档位判定（本文 §3）、类别色 token `--cat-*` 与服务缩写方块（本文 §2.10）由平台界面沿用（C6 流程处理） |

---

## 10. 审稿修订记录

审稿日期 2026-10-13。审稿时对照了 README、01～04 的当前版本、modular-design 第 5 节规则表、labs.md 与 docs/modules/*；涉及 AWS 行为的结论在下文 10.3 标明核实来源，没能核实的列在 10.4。

### 10.1 已在正文中修正的问题

| # | 严重度 | 位置 | 问题 | 修正 |
|---|---|---|---|---|
| R-1 | 高 | §4.1 S9、§4.3 Lab 21、§4.4 | Lab 21 按默认的 `preview.directHttps: on` 会在起始状态附加 `TLS_MODE=letsencrypt`，启用 autoscaling 时触发 error 级规则 ASG-014，目标模块无法启用；§4.4 的人工核对和 lint C-6 的说明都写“通过” | Lab 21 改为 `off`；§4.4 补上 ASG-014 与 warn 级的 ASG-009～013 |
| R-2 | 高 | §4.1 S9、§4.3 Lab 7 | Lab 7 的起始状态 `CDN_DIRECT_ACCESS=admin-ip` 让直连入口只对工作台开放，Let's Encrypt 无法从公网验证（HTTP-01 / TLS-ALPN-01），学员浏览器也连不上直连入口，`directHttps: on` 没有意义 | Lab 7 改为 `off`，预览用 CloudFront 默认域名；S9 写明签发条件 |
| R-3 | 高 | §6.4、§3.3.2、§4.3、§6.7、§7.4、K10 | 04 在审稿中已新增 `provision`（必填）、`platformOps`、`keepablePrerequisites`（枚举 `route53-hosted-zone` 等）、`workstation.sshFromWorkstation`、`regions.extra`；本文的 `platform` 段重复定义了同一组信息，名称和取值格式都不同（`provisionClass`、`actions`、`AWS::Route53::HostedZone`、`alsoUses: dr`）；Lab 10 示例缺少必填的 `provision`，按 04 的 schema 校验会失败 | 改用 04 的字段；`platform` 段只保留 `preview`、`consoleLinks`、`accountImpact`；请 04 在 `workstation` 中加 `savingsMode`、在 `platformOps` 条目中加 `id` 等（F-1 改写，F-4 撤回） |
| R-4 | 高 | §7.5、§4.1 S10、§4.3 Lab 2、Lab 20、§9 MOD-3 | 原稿认为工作台在“平台自己的 VPC”，据此断言 02 的“工作台私网 IP/32”不可达，并把 Lab 2 的 SSH 改用 `${atl:workstationCidr}`。01、02、03 一致规定工作台在**默认 VPC** 公有子网、与 L0 同 VPC，`ssh lab` 走私网 | 沿用 02 的私网 IP/32（由 `workstation.sshFromWorkstation` 驱动）；`${atl:workstationCidr}` 明确为工作台公网 IPv4/32，只用于经实验机公网入口的放行（Lab 7） |
| R-5 | 高 | §6.7 C-10 | “Track 必修 Lab 不得有必填的学员输入”按字面会让 `saa-full` 失败：Lab 9 必修，且 `ses-identity`、`notify-email` 必填 | C-10 只针对必填的 `domain` |
| R-6 | 中 | §4.3 Lab 1、§4.5、§8 D-5、§7.6 | 原稿以“`CloudAlbumAppRole` 受保护”为由把撤销会话放进平台动作。按 01 §6.5，学员边界允许对带 `ATLWorkloadBoundary` 的这个角色写内联策略，学员在 IAM 控制台点“撤销活动会话”同样会切断管理通道 | 改写理由；`iam-refresh-credentials` 不依赖先执行平台撤销；要求复位时删除角色上的全部内联策略；补充“实例元数据服务在旧凭证到期前不会自动换新”，恢复失败时以重启兜底 |
| R-7 | 中 | §4.3 Lab 1、§6.4、§9 MOD-2 | 成本分配标签：新标签键最长约 24 小时后才可激活、激活后最长约 24 小时生效；AWS Organizations 成员账号不能激活，只能由管理账号激活。原稿把激活作为必走的平台动作 | `cost-activate-tags` 改为选做，失败转为平台外说明；另补“IAM 用户和角色访问账单信息”开关对 Budgets 控制台的影响（03 §5.4） |
| R-8 | 中 | §4.3 Lab 2、§4.5、§9 L-5 | `probe-port` 写“before：22 可达，平台外部探针与工作台各测一次”。平台模式下 22 从来只对工作台私网地址开放，外部探针 before 就是 filtered；工作台若探测弹性 IP，源地址是公网地址，也会是 filtered | 改为：工作台探测私网地址 open → filtered，外部探针前后都是 filtered，报告并排解释 |
| R-9 | 中 | §2.7.1 | 中级的判定“或有账号级影响”与 Lab 1（预算）、Lab 2（Session Manager 首选项）、Lab 9（SES 身份）定为初级相矛盾 | 改为“或会开启账号级按量服务”；账号级影响由徽章单独提示 |
| R-10 | 中 | §3.1 | `startability` 原因码写作 `MAINTENANCE`，01 §8.6 为 `MAINTENANCE_MODE`；漏了 02 已定义的 `BUDGET_BLOCKED`、`PLATFORM_UNINSTALLING`；新增的两个原因码被说成“沿用 01、02” | 更正并补齐；标明 `HARD_PREREQ_UNMET`、`LAB_DEPRECATED` 为本文增补 |
| R-11 | 中 | §4.3 Lab 6、§7.6、§9 MOD-12 | 会话结束删除托管区域后，上级区域的 NS 委派成为悬空委派，有子域被接管的风险；原稿只当作普通提醒。另把接入已有托管区域写成“只读接入”，但 dns 模块会在其中写记录 | 结束时必须二选一（保留托管区域或先删委派），清单条目标为安全类；改为“只增删本会话创建的记录” |
| R-12 | 中 | §7.2 | `learnerInputs`（域名、托管区域 ID、邮箱）会被代入手册命令与栈参数，原稿只写“按 Lab 声明校验”，没有给出模式 | 给出 RE2 校验规则与 400 返回；邮箱不进入证书与公开验证页 |
| R-13 | 中 | §4.3 Lab 23、§7.6 | Lab 23 声明 `alsoUses: [us-east-1]` 用于查看全局服务事件，但 01 的 `UsEast1EdgeOnly` 不放行 `cloudtrail:LookupEvents` | 请 01 增补该只读操作；未增补前这一观察只讲解 |
| R-14 | 中 | §4.3 Lab 25、§4.5、§9 MOD-6 | Inspector 激活后扫描本区域全部 EC2 与 Lambda；Lab 25 的起始状态没有 CloudAlbum 的 Lambda 函数，区域里只有平台自身的函数 | 默认只启用 EC2 扫描类型，Lambda 扫描为选做 |
| R-15 | 中 | §3.3.2 | Lab 10 的 `wire` 步骤只有 `[script, cli]`，与简介页“可以用控制台”和 P4“可以用控制台，也可以用命令”不符；`permissions.learner` 漏了 `scripts/module` 在工作台上以学员身份执行时的写操作（`iam:CreatePolicy`、`iam:AttachRolePolicy`、`ssm:SendCommand`、工具链桶读写、`DescribeChangeSet` 等），04 lint 第 11 条与手册写操作要求会漏检 | 增加路线 M（`adoptsExisting: true`、`methods: [script, console]`）；补全权限 |
| R-16 | 低 | §2.7.3、§6.3 | “按小时计费资源单位”只有举例没有定义，Lab 17 选做的“预置低 WCU”按字面会算 1 个单位；`weights` 的 schema 禁止 0；代码按完整键查权重，与“前缀”的注释不符；未写 `costTierWithOptional` 时的断言含义不明 | 给出定义；权重允许 0 并给出默认表；代码改为最长前缀匹配；C-7 写明缺省断言 |
| R-17 | 低 | §5.5、§6.5 | “15、16 可互相复用”：在 Lab 16 的保留环境中开始 Lab 15 会带着计费中的 ElastiCache，并污染“没有 RDS”的基线；`reuseFrom` 算法也会给出这个候选 | 只保留 15 → 16 方向；`reuseFrom` 对带计费或影响基线的多余模块加提示并降序 |
| R-18 | 低 | §3.3.1 | 保留期间仍计费写成“实验机、数据卷与弹性 IP”，与 02 §8.2 默认节省模式（停止实验机）不符 | 更正 |
| R-19 | 低 | §7.4 F-11 | 04 §11.1 的 Lab 5 示例 `provision: { class: B }`，与本文和 02 §11.2 的 A 不一致（起始状态只有 L0 + iam） | F-11 增加这一处修改要求 |
| R-20 | 低 | K1、§1.2、§1.3、Lab 0x、Lab 25 | “第二部分”与“可选”的出处写成 README，实际分别来自 labs.md（README 学习路线未标） | 更正出处 |
| R-21 | 低 | §4.3 Lab 7、§9 MOD-13 | `waf/flood` 的命名与“遵守渗透测试政策”的笼统表述不够：AWS 的政策禁止未经批准的请求洪泛与模拟 DoS | 写明请求量只略超过速率规则阈值，以官方政策为准 |
| R-22 | 低 | §7.3、§4.3 Lab 6 | `acm.certificates` 只用 `{region}`，Lab 6 给 CloudFront 用的证书在 `us-east-1` | 注明区域参数取值 |
| R-23 | 低 | §7.5 | 未列出 `deadlineAt` / `expiresAt`、Lab 级平台字段在 01、02、04 之间的命名差异 | 增加两行 |
| R-24 | 低 | §6.4 | `directHttps` 的取值 `on`/`off` 在 YAML 1.1 解析器中会变成布尔值，schema 的字符串枚举随之失配 | schema 中写成带引号的字符串，并规定按 YAML 1.2 解析 |

### 10.2 复核后保留的原文结论

- 31 个 Lab 的难度、时长、费用档位、部署等级与 §4.2 的统计（入门 1、初级 8、中级 17、高级 5；低 20、中 7、高 4；A 21、B 8、C 1、D 1），以及 §5.2 各 Track 的必修总时长与档位分布，按 §4 的取值逐项重算，一致。
- 所有 `timeLimitMinutes` 都是 30 的整数倍，且 ≥ `estimatedMinutes` × 1.5（04 lint 第 12 条）。
- §4.4 其余各行的规则编号与 modular-design 第 5 节规则表一致（DEP-001～035、MUTEX-001～005、ASG-001～008）。
- P11 的状态名、`/api/v1` 前缀、`atl-main` 只引用实体名：符合。P10 的“完成证明”措辞与 04 §10.1 的性质声明：符合。P13：全文没有价格与性能数字，考试领域权重注明以考试指南为准。

### 10.3 已核实的 AWS 事实（2026-10-13）

| 事实 | 结论 | 来源 |
|---|---|---|
| 成本分配标签的激活时间与成员账号限制 | 打标签后最长约 24 小时出现、激活后最长约 24 小时生效；只有管理账号与独立账号能使用成本分配标签管理 | AWS Billing 用户指南“Activating user-defined cost allocation tags”“Using user-defined cost allocation tags” |
| 撤销 IAM 角色会话 | 内联策略 `AWSRevokeOlderSessions` 拒绝撤销时刻之前签发的全部临时凭证，作用于该角色的所有使用者；之后签发的凭证不受影响 | IAM 用户指南“Revoke IAM role temporary security credentials” |
| HTTP API JWT 授权器 | 目前只支持基于 RSA 的算法 | API Gateway 开发者指南“Control access to HTTP APIs with JWT authorizers” |
| AWS Budgets 计费 | 监控与通知免费；带 Actions 的预算超出免费数量后按天计费；预算报告按次计费 | AWS Budgets 定价页 |

### 10.4 未能核实、需实现前验证的事项

- 撤销会话后，替换实例配置文件关联能否让实例元数据服务立即返回新凭证、SSM Agent 是否随之恢复（官方文档未说明；本文以重启实例兜底）。
- 同一 VPC 内经弹性 IP 互访时，对端安全组看到的源地址是否为发起方的公网 IPv4（Lab 7 的 `cdn.AdminCidr` 依赖这一点；按常见行为设计，需实测）。
- RDS Proxy 是否支持学员边界白名单中的 `db.t3.micro`、`db.t4g.micro`、`db.t4g.small`（Lab 15x）。
- Let's Encrypt IP 地址证书的有效期、可用的验证方式与频率限制（沿用 03 §6.2 的表述）。
- 学员账号是 AWS Organizations 成员账号时，Cost Explorer API 与 Budgets 控制台对 IAM 角色的可用性（取决于管理账号的设置）。

### 10.5 第 2 轮（2026-10-13）：按主设计者裁决改写为卡片目录

**依据**：主设计者裁决 C1～C8（尤其 C2、C3、C5）；平台评审结果（critique 的 inconsistencies、walkthrough_breaks、writeback 与 05 的审稿修正）；卡片审稿结果（cards/ 各文件的 corrections 与 open issues，以及各文件附录 B 对平台文档的问题）。10.1～10.4 是第 1 轮的记录，其中的节号指第 1 轮的结构（§4.3 逐 Lab 表等已删除）。

**改动**

| # | 位置 | 改动 |
|---|---|---|
| V-1 | 标题、文档定位、§0、§1 | 定位改为“卡片目录（权威）”；K1～K12 重写；明确本文负责的范围（目录页、56 张卡片汇总、原 Lab 映射、目录总则、分类法、目录数据与 API）与只引用的范围（路径、掌握度、徽章、证书 → tracks-and-catalog；格式 → 04；名称 → 01）；新增取值冲突的处理顺序 |
| V-2 | §2 | 目录页改为卡片网格（默认）、服务地图、路径视图三种视图；筛选维度增加类型、考试领域、费用档位，取消“显示扩展 Lab”；卡片视觉字段 12 项与提示标记 8 种；新增服务地图与侧栏、路径视图、徽章图形；状态映射与 02 的状态名对齐；推荐算法改为按路径阶段与选修组 |
| V-3 | §3 | 保留第 1 轮的难度判定、时长定义与费用档位算法（改为以卡片为单位，计入卡片自带栈与卡内临时 EC2）；新增部署等级的推导规则、C3 起始状态规则的摘要、方案 B 的关闭规则；平台占位符改为 `workstationPrivateCidr` / `workstationPublicCidr` / `drRegion` / `platformOrigin` 四个，废止 `workstationCidr` |
| V-4 | §4 | 新增 56 张卡片的元数据汇总表（id、标题、kind、难度、时长与上限、startProfile、目标、费用档位、部署等级、人工前置），逐项与 cards/ 各文件核对；按 C3 给 16 张 `credentials: optional` 的单服务卡预置 iam；统计（入门 1 · 初级 14 · 中级 32 · 高级 9；低 38 · 中 11 · 高 7；A 47 · B 4 · C 4 · D 1；预计合计 4785 分钟）；16 处差异的裁决表（D-1～D-16）；起始变体与方案 B 关闭清单；账号级影响、平台动作与发布前提 |
| V-5 | §5 | 新增原 Lab 0～25 与 5 个扩展 Lab → 卡片 id 的映射，标出 `saa-main` 中的角色与阶段，并把第 1 轮 §4.5“平台模式改写汇总”落到对应卡片 |
| V-6 | §6 | 学习路径（原 §5 的 6 条 Track）、Lab 证书改为引用 tracks-and-catalog 的 9 条路径、徽章与路径证书模型 |
| V-7 | §7 | 简介页改为以卡片为单位：场景卡增加“场景”区块与 `## 为什么组合在一起`；“证书”区块改为“徽章”；增加起始变体选择与 `TARGET_ALREADY_SATISFIED`；生成句式改为读取 `startProfile.provisions`、`expectedWarnings`、种子与卡片自带栈；保留第 1 轮的学员输入 RE2 校验规则（改用 04 的输入 id）；示例由 Lab 10 改为 svc-queue（内容取自 service-cards-2） |
| V-8 | §8 | 手写的 `catalog.yaml` 改为“手写 `taxonomy.yaml` + 生成 `catalog.yaml`”；给出 40 个服务格与附属服务的分类法表；构建产物路径改为 `catalog/cards/<cardId>.json`；起始档位改为 `profiles/atl/<card-id>/<variant>.env`（不提交，随内容发布）；`reuseFrom` 规则增加“目标已生效不推荐”；目录 lint 改写为 C-1～C-15；API 改用 `quotes`、增加 `GET /api/v1/me/mastery` |
| V-9 | §9 | 对 01、02、03、04、06、cards/ 各文件与仓库其他文档的待配合事项按本轮结果重写 |

**删除的第 1 轮内容**：31 个 Lab 的逐个元数据表与硬依赖核对（由 cards/ 逐卡文档与 `plan --start-of` 取代）；6 条 Track 与 Track 文件示例（由 tracks-and-catalog 取代）；Lab 10 的完整 `lab.yaml` 与专属检查（格式由 04 v2 定义，卡片示例见 cards/ 各文件附录）；`platform` 段的 schema 增补与 F-1～F-12（已被 04 v2 吸收：四级难度、`platform` 段、`savingsMode`、`platformOps[].id`、一次性实验与变体标签、平台占位符、分类法 id）；对 P1～P13 的细化表（结论已落入卡片，起始状态部分被 C3 取代）。

**评审意见的处理**

- 已采纳：报价接口统一为 `quotes`；锁名 `ActiveEnvironmentLock`；开始请求体带 `variant`；`lab.yaml` 以 04 v2 为准，本文不再给出与之并行的字段定义；方案 B 的关闭清单与 03 §6.2 一致；第 1 轮“05 的 `lab.yaml` 违反 04 schema”的走查断点随之消失；卡片审稿中与目录取值有关的结论（徽章只看完成、`expectedWarnings`、svc-autoscaling 为 D、难度与时长的取整）已在 §3、§4 中体现。
- 未采纳：平台评审 inconsistencies 第 38 条“v1 以 05 的 Lab 0～25 为准”——已被主设计者裁决 C2 推翻；tracks-and-catalog §1.5“单服务卡起始状态等于 `single/<id>`”与背景理由 `control-plane`——被 C3 推翻；scenario-cards 中 sc-event-fanout 的“初级”——违反“场景卡至少中级”；第 1 轮的 S5“VPC 绑定的卡片以 network(public) 起步”——超出“L0 + iam + 硬依赖闭包”，cards/ 各批也未采用。
- 待主设计者确认：sc-security-baseline 不预置 iam（§4.5 D-8）。

**仍需验证的 AWS 事实**（转入 07 的验证计划）：10.4 中撤销会话后的凭证刷新、同一 VPC 内经弹性 IP 互访的源地址、RDS Proxy 支持的实例类、Let's Encrypt IP 证书的有效期与验证方式、成员账号下 Cost Explorer 与 Budgets 的可用性；另加 ACM ACME 端点的可用性（svc-tls 回退档的触发条件）。

### 10.6 第 3 轮（2026-10-13）：跨文档审计修复

| # | 审计问题 | 位置 | 修订 |
|---|---|---|---|
| X-1 | （中）sc-security-baseline 的起始状态与 cards 矛盾：本文不预置 iam、以 iam 为第一个目标，而 C3 只给 svc-ec2、svc-iam 例外，06 PM-33 第 3 步对其余卡片一律加入 iam，04 DRV-5 会让 `plan --start-of` 以退出码 2 失败 | §3.5 第 2 条、§4.3 第 11 行、§4.3 脚注、§4.5 D-8、§9.4 第 1 条 | 按 C3 字面执行：起始 iam，目标 kms → secrets → audit → compliance（选做的“长期密钥 vs 临时凭证”走平台动作）；删除 §3.5 第 2 条的例外与 D-8 中请 04 开 lint 例外的要求 |
| X-2 | （低）灾备区域仍写“被 01 的 `DrRegionBackupOnly` 阻塞” | §4.2 第 20 行、§4.3 第 13 行、§4.7、§5.1 Lab 24、§9.1 第 6 条 | 改为依赖 01 §6.5 的 `DrRegionLimited`（放行 CloudFormation、卷恢复、跨区域只读副本，护栏限定 `stack/cloudalbum-*`）；sc-backup-dr 的卡片自带栈名 `cloudalbum-<envName>-x-*`、由运行器 `extra-stack` 部署 |
| X-3 | （低）只读白名单的“发布前提”已被 04 §5.7 收录 | §4.7、§9.4 第 5 条 | 删除 Config、Inspector、`glue:GetTable`、`athena:GetQueryExecution` 的“待进入白名单”前提 |
| X-4 | （低）`iam※` 标注与 D-1、D-3 的“待同步”已不成立 | §4.1、§4.2、§4.4、§4.5 | 删除星号标注，D-1、D-3（以及 D-8、D-13、D-16）标为已同步；§4.4 删除“4770 分钟待同步” |
| X-5 | （低）startProfile 列漏了种子 id | §3.5 第 8 条、§4.2（svc-auth、svc-identity-pool、svc-kms）、§4.3（sc-user-identity） | 统一写种子 id：`cognito-test-users`、`gps-sample-photos` |
| X-6 | 配合 01、02、06 的同轮修改 | §8.5 第 5、7 条、§9.1 第 8 条 | 运行期复核改为 `plan --profile`；登记 `PROFILE_EXTRA_STACKS`；`CloudAlbumAppRole` 复位保留栈声明的 `atl-terminal-recording` |

**没有采纳的意见**：无。审计给出的另一种做法（正式扩充 C3 的例外清单）需要同时修改 06 PM-33、04 DRV-5、01 §3.9 与 scenario-cards，本轮未采用。

**仍需其他文件配合**：无新增；§9 中其余未标“已落实”的事项状态不变。
