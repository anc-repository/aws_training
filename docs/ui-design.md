# 学习控制台（Learning Console）UI 设计

> 版本：v1.1（评审修订）· 2026-10-13。修订内容见文末“修订记录”。
> 范围：CloudAlbum Web 应用中 `/console/*` 下的全部画面（仅管理员可访问）。原 `/lab` 对比实验室整体并入。
> 读者与用法：
> - 前端按第 3、7、8、11、13 章实现画面。
> - 后端按第 4、6、9、10 章实现进度判定、检测引擎、API 和数据表。
> - 指南作者按第 5 章编写 `guides/*.yaml`。
>
> 上游文档：本文建立在 [modular-design.md](modular-design.md)（以下称“总纲”，2026-10-13 第 2 轮修订版）之上，直接沿用总纲已定的以下内容，不再重复定义：
> - 模块注册表 `modules/registry.yaml`（共 40 个模块，A～F 六组加 ec2，§3.2）
> - `/api/capabilities` 的字段（§6.1）
> - `X-CloudAlbum-Path` 与 `Server-Timing` 规范（§7）
> - 实验框架与 `npm run exp`（§8.2）
> - 运行时 A/B 与 `X-Compare-Bypass`（§8.3）
> - `scripts/module` 的执行流程（§9.2）
> - 预设档位 `profiles/l0-ec2 … l9-full` 及变体 `x-named-comparisons`、`x-efs-asg`、`x-workflow`、覆盖层 `overlay-public-demo`（§10.2）
> - Lab 0–25 的顺序（§10.3，Lab 顺序与档位的唯一权威来源，D12）
> - 统一决策 D1～D13，其中运行时为 Node.js 22 LTS（D4）、凭证开关 `IAM_CREDENTIALS=none|role|keys`（D1）
>
> 模块细节以 `docs/modules/0N-<group>.md` 七篇分组文档为准（`00-ec2-base`、`01-edge-network-scaling`、`02-identity-security`、`03-data-storage`、`04-compute-async`、`05-ops-observability`、`06-governance-cost`）。本文引用模块文档一律写成“分组文件#锚点”（锚点 = 模块 id，与 registry 的 `doc` 字段一致，D10），例如 `03-data-storage.md#storage`。§5.10 的 cdn 指南示例与 `01-edge-network-scaling.md#cdn` 逐项对齐；§7 S08 的实验 id 与各组文档的 `experiments/<module>/` 对齐。
>
> 本文需要总纲补充或微调的地方，集中列在附录 B。按总纲文首的约定，这些条目要先写入总纲的修订记录才能落地；在总纲采纳之前，实现以总纲现行文字为准，本文相应的功能标为“待总纲确认”。

## 目录

1. [目标、用户与设计原则](#1-目标用户与设计原则)
2. [方案评审结论](#2-方案评审结论)
3. [信息架构](#3-信息架构)
4. [进度模型](#4-进度模型)
5. [配置指南内容模型](#5-配置指南内容模型)
6. [自动检测引擎](#6-自动检测引擎)
7. [画面规格](#7-画面规格)
8. [组件清单](#8-组件清单)
9. [API 契约](#9-api-契约)
10. [数据表 DDL](#10-数据表-ddl)
11. [视觉规范](#11-视觉规范)
12. [与相册主应用的关系](#12-与相册主应用的关系)
13. [可访问性与响应式](#13-可访问性与响应式)
- [附录 A：课程编排与总纲 §10.3 对照](#附录-a课程编排与总纲-103-对照)
- [附录 B：需要同步到总纲与其他文档的补充](#附录-b需要同步到总纲与其他文档的补充)
- [附录 C：术语与文案词表](#附录-c术语与文案词表)
- [附录 D：实现里程碑](#附录-d实现里程碑)
- [修订记录](#修订记录)

---

## 1. 目标、用户与设计原则

### 1.1 要解决的问题

| # | 问题 | 本设计的回答 |
|---|---|---|
| P1 | 学员需要一眼看到“我目前完成了哪些任务的配置” | 顶栏常驻“配置 x/y”（y 由学员所选路线与 course.yaml 推导，§4.10）。总览页的“你在这里”卡片右侧直接放精简完成度（分段条 + 全课程 + Lab 进度），1280×800 下首屏可见。模块目录用 A–F 矩阵展示每个模块的完成状态，紧凑密度下 40 个格子基本一屏放下，每一项都附带判定证据 |
| P2 | Web 里需要配置指南（guidance），一步一步带着做 | 每个模块的“配置指南”页是一个步骤播放器：左侧是步骤列表，中间是做法（控制台 / CLI / 脚本 / 代码），右侧是本步检测结果。所有内容由 `guides/<id>.yaml` 驱动 |
| P3 | 推荐下一步做什么 | 一个纯函数，根据课程顺序、注册表依赖、当前运行状态和费用状况，给出 1 个主推荐和 2 个备选，每条都写明理由 |
| P4 | 费用提醒和清理 | 顶栏费用灯常驻；费用页列出按小时计费的资源及其已运行时长；清理向导按依赖倒序生成步骤，执行后自动验证 |
| P5 | 直观看到某个模块“有”和“没有”的差别 | 每个模块都按“before 基线 →（本地档）→ 配置 → after”的固定节奏进行。对比实验页把各档指标和请求路径并排展示；请求路径检查器可以看到每个请求实际经过了哪些组件 |

### 1.2 用户与场景

| 用户 | 典型场景 | 关键诉求 |
|---|---|---|
| 备考学员（唯一的直接用户，也是管理员） | A. **首次使用**：L0 刚启动，没有 IAM 角色，也没有域名 | 不需要 AWS 凭证也能开始，几分钟内取得第一个成果 |
| | B. **隔天回来**：距上次学习已有几天 | 几秒内找回上下文，知道这段时间花了多少钱 |
| | C. **跳着学**：只想先看“有/无 SQS”的对比 | 直接进入目标模块，系统说明缺哪些前置模块；也可以整体切换到“重点对比快速路线”（§4.12） |
| | D. **收尾**：考前复习、导出学习成果、清理到 L0 或彻底拆除 | 可以导出学习报告；清理过程有引导，并能确认资源已删干净 |
| 讲师或同伴（间接用户） | 查看学员导出的学习报告 | 报告离线可读，账号 ID 默认打码 |
| 相册的普通用户 | 正常使用相册 | 完全看不到学习控制台；只能在页面上看到总纲 §12.3 定义的架构徽章 |

学员画像：具备基本的 Linux 和 SSH 能力，用过 AWS 控制台但经验不多；使用单个 AWS 账号，环境从一台 EC2 起步；手边有一台“运维机”（自己的电脑，或者 CloudShell），用来执行 `scripts/module` 和 `npm run exp`（总纲 §9.2）。

### 1.3 设计原则

1. **证据优先。** 是否完成由系统判定，界面上没有“标记完成”按钮。每个结论都要带上来源标签、时间和复现方法。确实只能人工确认的事项，必须要求学员填写“看到的值”，不能只点一下勾选框。
2. **学习进度、运行状态、费用是三个互相独立的维度。** 资源清理掉之后，学习进度不会减少；之前通过的检查后来不通过，标记为“漂移”，而不是改回“没做”。后续 Lab 的正当变更（例如 l8-ha 把 CloudFront 源站换成 ALB）不算漂移，记为“被 Lab N 取代”（§4.5、§5.3 `supersededWhen`）。
3. **以学习路径为主线，架构图和检测报告是另外两种视图。** 主导航围绕“你在这里 → 继续”展开；架构图和检测报告展示的是同一份数据，只是换了观察角度。
4. **L0 是一等公民。** 没有 AWS 凭证时，每个画面都要完整可用。降级必须明确显示出来，告诉学员怎样解锁；凭证到位后，系统自动重新核验。
5. **控制台对 AWS 只读，而且只读的范围也要最小。** 控制台不创建、不删除、不修改任何 AWS 资源。它只做三件事：生成命令、执行只读检查、记录证据。所有变更都由学员在运维机或 AWS 控制台中亲手完成（总纲 §9.2 规定 `scripts/module` 在运维机上运行）。只读检查使用单独的 Verifier 角色，资源收窄到本项目，响应按白名单投影，会回显密钥的字段一律丢弃（§6.7）。
6. **每个模块都按同一个节奏推进。** 依次是：基线（before）→（可选的本地档）→ 配置 → 接入应用 → after → 考点。做到第三个模块时，学员已经不需要再看说明。
7. **命令里填的是学员自己的真实值。** 命令和控制台深链接中的区域、实例、桶名、分配 ID 都已替换成学员环境的实际值；密钥一律不回显；代入命令的值一律做 shell 转义（§5.6）。
8. **注明运行位置。** 每条命令都标明在哪里执行：运维机（你的电脑或 CloudShell）、EC2（SSH 或 Session Manager），还是浏览器。
9. **费用随时可见。** 顶栏有费用灯；会开始按小时计费的步骤，执行前给出提醒；清理时提供向导，并在清理后自动验证。金额只来自学员自己维护的 `cost-rates.yaml`（总纲 §2.4、cost 模块），没有价格时只显示计费中的资源和时长。
10. **工具感，不是模板感。** 信息密度适中，颜色只用来表达语义，不模仿 AWS 官方控制台的配色（详见第 11 章）。

### 1.4 范围边界（不做的事）

- 不代替学员执行任何 AWS 变更，包括“一键修复”。
- v1 不支持多学员，也不提供讲师后台：每套环境只有一个管理员，学习报告可以导出。实验运行器使用范围受限的“实验上传令牌”，不另设管理员账号（§6.10）。
- 不做实时账单：费用只做估算，另提供按需调用的 Cost Explorer 查询（默认关闭，§6.7 可选账号级读取）。
- 不在浏览器里提供 shell。
- 普通用户不能访问 `/console`。总纲中“登录用户可以只读访问 `/lab`”的设定，随 `/lab` 并入控制台一起取消（见附录 B-1）。

---

## 2. 方案评审结论

### 2.1 评分表

参评方案：A = 课程路线式（journey）、B = LitMap 架构图主导（map）、C = Ops 合规式（console）。每项 1–5 分。

| 维度 | A 课程路线式 | B 架构图主导 | C Ops 合规式 |
|---|:-:|:-:|:-:|
| (a) “我完成了什么”是否一眼可见 | **5** | 4 | 4 |
| (b) 配置指南是否好用、可执行 | **5** | 4 | **5** |
| (c) L0（仅 EC2、没有凭证）下是否完整可用 | **5** | 4 | **5** |
| (d) 是否能直观呈现模块有/无的对比 | 4 | **5** | 4 |
| (e) 实现成本与可行性（分数越高越容易实现） | **3** | 2 | 2 |
| (f) 对 SAA 学习的价值 | **5** | 4 | 3 |
| **合计** | **27** | 23 | 23 |
| 加权合计（a、b、c 是用户的核心诉求，权重 ×2） | **42** | 35 | 37 |

不管是否加权，A 都排第一。B 和 C 同分，但长处不同：B 擅长“看见”，C 擅长“验证”。

### 2.2 各维度评分理由

| 维度 | A 课程路线式 | B 架构图主导 | C Ops 合规式 |
|---|---|---|---|
| (a) | 顶栏常驻“继续”和“配置 x/y”。首页直接回答三个问题：我在哪、下一步做什么、做完了什么。完成度有服务矩阵、按 Lab、证据台账、架构四种视图，并按证据质量分层（自动 / 手动 / 待确认） | 节点亮灭、外环、角标都很直观。但“点亮”不等于“学完”，需要图例解释；40 个节点同时显示时信息很密；要逐项精确核对，还得切到表格清单 | 概览卡片加上模块表“学习进度 / 当前运行”两列，信息最准确。但图标、来源标签、计数同时出现，第一眼看到的是一张报表，而不是答案 |
| (b) | 三栏步骤播放器，提供四种做法，标注运行位置，自动代入模板变量。等待型步骤会自动轮询，例如等 CloudFront 部署或 RDS 创建。常见错误能匹配到具体原因，并可跳回对应的小步骤 | 同样提供四种做法，另有 map_delta 局部图。但等待型步骤、运行位置等细节没有展开 | 最容易照着执行：变量注明来源，变量没解析时拦截复制，修改 env 后自动轮询，提供复现命令，可导出 Markdown |
| (c) | 首次向导的体检结果直接作为 Lab 0 的证据；手动确认采用“填写看到的值”的方式；把 iam 安排在 Lab 1，学员会亲身经历一次“降级 → 解锁” | 可以使用，但连线依赖真实流量；L0 时架构图很空，需要手动发探测请求 | 最完整：把降级原因分成无角色、缺少 action、API 不可达、时钟偏差几类；支持粘贴证据（[M+]）；能诊断 Verifier 并生成所需策略 |
| (d) | 并排对比表、实时 A/B、结论卡。固定节奏保证不会漏做 before。缺少“请求路径”的可视化 | 最强：本地实现以“芯片”形式画在 EC2 里，启用模块后芯片飞出；有局部路径图；用路径头判定实验是否有效（≥95%）；请求路径透视能直接暴露“绕过了 CDN”“回退到本地实现”这类问题 | 提供四种对比方式，并把费用放在旁边一起比较，但全部是表格形式，直观性一般 |
| (e) | 12 个画面，技术栈常规。课程内容（编排、痛点故事、题库）的维护量偏大 | 成本最高：节点坐标要手工排布，SVG 动画、路径聚合、回放重算，附件型徽章还要写特例 | 16 个画面，审计哈希链、策略生成、证据断言、定时调度，工程量很大 |
| (f) | 痛点故事 → 配置 → 考点卡 → 小测，小测的解析会回链到学员自己做过的步骤，并按四个考试领域统计。最贴近考试 | 读图和画图本身就是考试题干的形式，但没有题目，也没有复习环节 | 复现命令和运维模式有价值，但缺少“为什么选这个服务”的叙述；沿用旧 labs.md 的顺序，与 L0 原则冲突 |

### 2.3 结论与选择理由

- **骨架采用 A（课程路线式）。** A 的得分最高，而且最直接回答了用户的两个问题：“完成了什么”和“下一步怎么配”。
- **从 B 嫁接“看得见”的能力：** 架构图视图、请求路径检查器、用路径头判定实验是否有效、指南中每一步的“之前 / 之后”小图。
- **从 C 嫁接“可验证、管住钱”的能力：** 检测报告、检查详情与复现命令、证据粘贴、Verifier 诊断、清理中心、按数据来源分级的费用核算。
- 评分结论与任务建议的导航方向一致：以学习路径为主线，同时提供架构图视图，并具备运维控制台的检测与费用能力。因此不需要推翻这个方向。
- **课程编排完全采用总纲 §10.3，不在本文另立一套。** A 原本的 Lab 编排（storage 在 Lab 2、cdn 在 Lab 3……）以及本文 v1.0 的“Lab k ↔ 档位 Lk”都已作废。现行编排是 Lab 0–25 对应档位 `l0-ec2 → l0-plus-local-tiers → l1-ops → l2-edge → l3-identity → l4-async → l5-security → l6-data → l7-serverless-social → l8-ha → l9-full`（一个档位覆盖若干个 Lab，§4.12、附录 A）。界面上不写死任何档位名、Lab 数或模块数：档位徽章在运行时读取 `profiles/*.env` 计算（§3.4.2），必做数和模块数由 registry 与 course.yaml 推导（§4.10）。A 方案“把 iam 放在 Lab 1，体验降级 → 解锁”的意图保留：总纲本来就把 iam 与 cost 放在 Lab 1。
- **为用户点名的七组对比提供“重点对比快速路线”。** 它对应总纲变体 `x-named-comparisons`（ec2、iam、storage、cdn、auth、queue、image-processing、cache、database），在默认 VPC 中一次完成 Cognito、SQS、CloudFront、Lambda、ElastiCache、S3、RDS 七组有/无对比；路线中另加 cost（成本护栏，总纲建议所有路线都先就位）。学员在首次向导或 S13 中选择路线，界面按路线计算必做集合与推荐（§4.12）。

### 2.4 各方案被采纳的要点

| 来源 | 要点 | 落在本文哪里 |
|---|---|---|
| A | 顶栏“继续”按钮、“你在这里”总览、课程大纲侧栏、Ctrl+K 跳转 | §3.3、§7 S02 |
| A | Lab 级前置是软门槛，模块级依赖是硬门槛（硬依赖取自注册表） | §4.6、§4.12 |
| A | 每个模块的固定节奏：before →（本地档）→ 配置 → 接入应用 → after → 考点 | §5.4 |
| A | 手动确认采用“填写看到的值”的方式；凭证到位后自动复核 | §4.8、§7 S10 |
| A | “已完成·已清理”（[z]）：清理后不扣减进度 | §4.5 |
| A | 推荐算法写成纯函数，并区分“学过即可”和“当前必须在运行”两类依赖 | §4.11 |
| A | 费用提醒结合课程位置判断后续 Lab 是否还需要该资源；回访摘要 | §7 S02、S11 |
| A | 首次启动向导：L0 体检结果直接写成 Lab 0 的证据 | §7 S00 |
| A | 痛点故事、考点卡、Lab 小测（解析回链到学员做过的步骤） | §5.2、§7 S04、S06-4 |
| B | 架构图视图：用“本地芯片”表示本地实现、镜头切换、简洁模式、节点抽屉 | §7 S07 |
| B | 用 `X-CloudAlbum-Path` 的占比判定实验是否有效（边缘模块改用客户端证据） | §4.7 |
| B | 请求路径检查器：按路径签名聚合、多入口探测、标记“绕过 CDN”和“回退到本地” | §7 S09 |
| B | 指南每一步的 `mapDelta`：本步完成后架构图怎样变化 | §5.3、§7 S06-2 |
| B | 学习报告中的“L0 vs 现在”两张架构快照，以及成长时间线 | §7 S12 |
| C | 检测报告（Trusted Advisor 风格的检查清单） | §7 S10 |
| C | 检查详情抽屉：期望值与实际值逐字段对照、复现命令、错误码细分 | §7 S10、§6.9 |
| C | 证据粘贴 [M+]；不允许批量手动确认 | §4.8 |
| C | Verifier 诊断；由 guides 汇总生成只读策略，并做差异比对 | §6.7、§7 S13 |
| C | 未解析的变量拦截复制；修改 env 后自动轮询，直到驱动切换完成 | §8 CommandBlock、§5.6 |
| C | 清理中心：按依赖倒序、提示数据风险、清理后验证、拆除前强制导出 | §7 S11 |
| C | 费用数据来源分级：估算 / AWS 核实 / Cost Explorer 按需查询 | §7 S11 |
| C | 检查 `/console*` 和 `/api/*` 不被 CDN 缓存；标明“非 AWS 官方控制台” | §5.10 示例、§11 |

### 2.5 调整与未采纳

| 原方案中的做法 | 本文的处理 | 理由 |
|---|---|---|
| A：小测 ≥70% 才算 Lab 通关 | 小测成绩只作为独立的“考点掌握”指标，不影响“配置完成” | 用户的核心诉求是“完成了哪些配置”，混入分数会让完成度失真；即使题库缺失也不影响主流程 |
| A：Lab 0–12 自定编排 | 采用总纲 §10.3 的 Lab 0–25 与档位 `l0`～`l9`（D12）；另提供“重点对比快速路线”（`x-named-comparisons`） | 总纲是 Lab 顺序的唯一权威来源；UI 文档不另立编排 |
| A：`scripts/module enable --use-existing` | 改为模板约定 `--param Existing<Res>Id=…`（接管手动创建的资源），作为对总纲 §9.1 的补充 | 总纲已经有 `--param`，不需要新增 CLI 选项（附录 B-3） |
| B：架构图作为主导航 | 架构图只作为视图之一；L0 默认简洁模式；窄屏时退化为分层列表 | 降低信息密度和“剧透”；线性的学习流程由路线承担 |
| B：成长回放动画 | 学习报告中改用静态时间线加两张快照 | 实现成本高，学习收益有限 |
| B：连线只画观测到的同步请求，其余靠推断 | 架构图连线取自 LabMetricsStore 的路径签名聚合；异步链路用“推断”样式，并标注来源 | 复用总纲 §7.3 已有的数据，不新建采集管道 |
| C：审计日志哈希链 | 不做；保留只追加写入（按保留策略压缩）的 `console_events` 和 `check_runs` | 单人学习环境中防篡改的收益太低 |
| C：每 6 小时定时跑一遍 AWS 检查 | 默认关闭（可在设置中开启）；只在打开页面时、模块启停后、学员手动触发时运行；多实例时由数据库租约保证只跑一份 | 节省 API 调用，避免触发限流 |
| C：scripts/module 回调 localhost 钩子 | 不新增回调端点。api 监视实例上的 `/etc/cloudalbum/modules.state.json`（inotify，另以 30 秒一次的 mtime 与校验和轮询兜底），并读取 `scripts/module` 在第 7 步写入的“进行中操作”（pending op）；判定漂移前有宽限期（§4.13，附录 B-8） | 总纲 §9.2 在第 9 步重启、第 11 步才写状态文件，只在启动时比对会读到旧历史 |
| 三个方案：控制台复用相册会话 | 控制台使用专用会话 `ca_console`：由已登录的相册管理员（或应急票据）换取，本地 ES256 签名、TTL ≤ 1 小时、不可刷新、作用域限 `/console` 与 `/api/console/*`（§3.8） | 相册在 auth=cognito 时只认 Cognito 访问令牌，应急票据换不出这种令牌；独立会话让校验顺序和审计都清楚 |

---
## 3. 信息架构

### 3.1 站点地图

```text
CloudAlbum Web（同一个应用、同一个前端构建；控制台是按需加载的独立 chunk）
├─ /                          相册（公开）。管理员可以看到“学习控制台”入口和请求路径条（第 12 章）
├─ /console/setup             S00 首次启动向导（未初始化时，所有 /console/* 都 302 到这里；初始化后 setup API 一律 410）
├─ /console/login             S01 管理员登录（应急登录票据放在 URL 片段 #ticket=…）
├─ /console/403               S01 无权限页（已登录但不是管理员）
└─ /console                   仅管理员可访问
   ├─ （根）                   S02 总览「你在这里」
   ├─ /path                    S03 学习路线（Lab 路线图，主线 / 重点对比快速路线）
   │  └─ /:labId               S04 Lab 概览（/quiz 为 Lab 小测）
   ├─ /modules                 S05 模块目录（矩阵 / 表格）
   │  └─ /:id                  S06 模块详情，共 5 个子页（导航式标签）：
   │     ├─ （根）              S06-1 概览
   │     ├─ /guide[/:stepId]    S06-2 配置指南（步骤播放器）
   │     ├─ /compare            S06-3 对比实验（摘要）
   │     ├─ /exam               S06-4 考点
   │     └─ /cleanup            S06-5 清理
   ├─ /map                     S07 架构图视图
   ├─ /experiments             S08a 实验记录本（原 /lab/results）
   │  └─ /:module              S08 对比实验详情（原 /lab/compare）
   ├─ /traffic                 S09 请求路径检查器（原 /lab/trace）
   ├─ /checks                  S10 检测报告；?check=<id> 打开检查详情抽屉
   ├─ /cost                    S11 费用与清理
   │  └─ /cleanup/:scope       S11b 清理向导
   ├─ /report                  S12 学习报告（可导出 Markdown / JSON，可打印）
   └─ /settings/:tab           S13 设置（检测能力 | 学习路线 | 指南 | 数据 | 账号）
```

### 3.2 路由表

| 路由 | 画面 | 访问条件 | 查询参数 | 说明 |
|---|---|---|---|---|
| `/console/setup` | S00 | 未初始化时公开（默认只接受回环地址或 HTTPS 来源，§6.10）；已初始化时 302 到 `/console/login` | — | 当前步骤由服务端决定；刷新页面后从断点继续 |
| `/console/login` | S01 | 公开 | `?next=/console/...`；应急票据放在片段 `#ticket=<一次性票据>` | `next` 只接受以 `/console` 开头的站内相对路径。票据不进查询串，避免经 Referer、访问日志、浏览器历史泄露；前端读取片段后立即 `history.replaceState` 清掉，再 POST 兑换 |
| `/console/403` | S01 | 已登录 | — | 非管理员访问任何 `/console/*` 时显示 |
| `/console` | S02 | admin | — | 默认落地页 |
| `/console/path` | S03 | admin | `?view=graph\|list`、`?optional=1`、`?track=main\|named` | 窄屏默认 `list`；`track` 只切换显示，不改设置 |
| `/console/path/:labId` | S04 | admin | — | `labId` = course.yaml 中的 Lab 编号（当前为 `0` … `25`），不写成固定枚举 |
| `/console/path/:labId/quiz` | S04 小测 | admin | `?mode=preview` | 预习模式不计成绩 |
| `/console/modules` | S05 | admin | `?view=matrix\|table`、`?density=compact\|comfortable`、`?filter=focus\|todo\|manual\|drift\|billing`、`?group=A..F` | — |
| `/console/modules/:id` | S06-1 | admin | — | `id` 取自注册表（当前 40 个模块） |
| `/console/modules/:id/guide` | S06-2 | admin | `?method=console\|cli\|script\|code` | 自动定位到第一个未达成的步骤 |
| `/console/modules/:id/guide/:stepId` | S06-2 | admin | `?method=`、`?sub=<k>` | 可分享的深链接；`sub` 高亮第 k 小步并切到控制台做法 |
| `/console/modules/:id/compare` | S06-3 | admin | — | 完整工作台在 S08 |
| `/console/modules/:id/exam` | S06-4 | admin | — | — |
| `/console/modules/:id/cleanup` | S06-5 | admin | — | — |
| `/console/map` | S07 | admin | `?lens=run\|progress\|cost\|traffic`、`?node=<moduleId>`、`?full=1` | 默认 `lens=run`，L0 时为简洁模式 |
| `/console/experiments` | S08a | admin | `?filter=focus\|all\|invalid` | — |
| `/console/experiments/:module` | S08 | admin | `?before=<runId>&after=<runId>`、`?stage=<label>`、`?tab=runs\|ab\|matrix` | 默认取最新的一组有效记录（多档模块按 stages 顺序） |
| `/console/traffic` | S09 | admin | `?window=1m\|5m\|1h\|24h`、`?sig=<路径签名哈希>` | — |
| `/console/checks` | S10 | admin | `?status=`、`?source=`、`?module=`、`?lab=`、`?required=1`、`?group=flat\|module\|lab\|source` | 默认显示“需要处理” |
| 任意控制台页面 + `?check=<checkId>` | S10d 抽屉 | admin | — | 可叠加在 S02、S06、S10 上 |
| 任意控制台页面 + `?confirm=<checkId>` | S10m 手动确认对话框 | admin | — | — |
| `/console/cost` | S11 | admin | — | — |
| `/console/cost/cleanup/:scope` | S11b | admin | — | `scope` = `module:<id>` \| `lab:<n>` \| `idle` \| `l0` \| `all` |
| `/console/report` | S12 | admin | `?print=1`、`?mask=0` | `mask=0` 表示不打码账号 ID，需要二次确认 |
| `/console/settings/:tab` | S13 | admin | — | `tab` = `detection` \| `route` \| `guides` \| `data` \| `account` |
| `/lab` | — | — | — | 301 → `/console/map` |
| `/lab/m/:id` | — | — | — | 301 → `/console/modules/:id` |
| `/lab/results` | — | — | — | 301 → `/console/experiments` |
| `/lab/compare?a=&b=` | — | — | — | 服务端按 runId 查出所属模块，再 301 → `/console/experiments/:module?before=a&after=b` |
| `/lab/trace` | — | — | — | 301 → `/console/traffic` |

URL 约定：
- 筛选、视图、镜头、标签页、密度这类状态一律写进 URL，刷新和分享后保持不变。
- 抽屉和对话框用查询参数表示，浏览器“后退”可以关闭它们。
- 只有纯个人偏好存 `localStorage`，例如左栏是否折叠、大纲展开状态、指南默认做法、主题、矩阵密度、单键快捷键开关。所有读写都要包在 try/catch 里，读不到时使用默认值。

#### 3.2.1 原型与 Artifact 版的路由映射

交互原型 `docs/ui-prototype/index.html` 会发布为 claude.ai Artifact，受两条约束：页面路由只能用 `location.hash` 的纯 token（字母、数字、`.` `_` `~` `-`，不能出现 `?`、`=`、`/`），并且不能提供打印按钮。原型因此做如下映射；**正式产品仍按 §3.2 与 §13.7 实现**，下表只用于评审时对照。

| 正式路由（§3.2） | 原型 hash | 原型中的差异 |
|---|---|---|
| `/console` | `#overview`（空 hash、`#console` 同） | — |
| `/console/setup`、`/login`、`/403` | `#setup`、`#login`、`#forbidden` | 应急票据在原型中不演示兑换 |
| `/console/path?view=` | `#path` | 视图（依赖图 / 列表）、路线切换、只看未完成存于内存，刷新后丢失 |
| `/console/path/:labId[/quiz]` | `#lab.<n>`、`#lab.<n>.quiz` | — |
| `/console/modules?view=&density=&filter=` | `#modules` | 视图与筛选存于内存；密度存 `localStorage` |
| `/console/modules/:id[/guide/:stepId]` | `#module.<id>`、`#module.<id>.guide.<stepId>` | `?method=` 存 `localStorage`；`?sub=k` 用内存中的“待高亮”状态代替，跨过 hashchange 后再应用 |
| `/console/modules/:id/compare\|exam\|cleanup` | `#module.<id>.compare` 等 | — |
| `/console/map?lens=&node=` | `#map` | 镜头与选中节点存于内存 |
| `/console/experiments[/:module]` | `#experiments`、`#exp.<module>` | `?tab=` 存于内存 |
| `/console/checks?status=…` | `#checks` | 筛选存于内存；`?check=` 抽屉、`?confirm=` 对话框只存于内存，浏览器“后退”不会关闭它们（Esc 关闭） |
| `/console/cost/cleanup/:scope` | `#cleanup.<scope>`（例如 `#cleanup.l0`、`#cleanup.lab-8`、`#cleanup.cdn`） | — |
| `/console/report?print=1` | `#report` | **没有打印按钮**，改为“导出 Markdown / JSON”后由学员自行复制 |
| `/console/settings/:tab` | `#settings.<tab>` | 设置只保存在页面内存中 |

如果以后需要在原型中保留这些状态，可以继续用 token 子路由表达，例如 `#checks.drift`、`#module.cache.guide.network.ck-sg-ingress`、`#map.traffic`、`#modules.table.focus`；不得引入 `key=value` 形式。原型右上角的“原型画面索引”另有“示例状态”切换（检测能力：自动 / 部分 / 仅本地；学习路线：快速路线 / 主线），用于评审 L0 无凭证降级等状态，正式产品没有这个控件。

### 3.3 全局框架

```text
+--------------------------------------------------------------------------------------------------------------+
| ▣ CloudAlbum 学习控制台  非 AWS 官方控制台 | [继续：Lab 8 › auth › 步骤 3 托管登录 →] | 档位 l2-edge +2 | 配置 7/10 ▕████▁▏ |
|                                                     检测 ◐ 部分 | 费用 ▲ ≈$0.08/h | Ctrl+K 搜索 | 管理员 ▾        |
+------------------------+-------------------------------------------------------------------------------------+
| 学习                    | ┌ 横幅区（最多同时显示 2 条，其余收进“还有 n 条提醒”；总览页只显示 1 条）──────────┐ |
|   总览                  | │ [!] 漂移：cache 的“缓存安全组允许 6379”曾于 10/10 通过，现在未通过    [排错] [×] │ |
|   学习路线              | └─────────────────────────────────────────────────────────────────────────────────┘ |
|   模块目录              | 学习路线 › Lab 8 用户身份 › auth · Amazon Cognito User Pool                         |
|   架构图                |                                                                                     |
| 验证                    |                                  〈页面内容〉                                        |
|   对比实验              |                                                                                     |
|   检测报告      4       |                                                                                     |
|   请求路径              |                                                                                     |
| 运维                    |                                                                                     |
|   费用与清理    !       |                                                                                     |
|   学习报告              |                                                                                     |
|   设置                  |                                                                                     |
| ─────────────────────── |                                                                                     |
| 课程大纲 · 快速路线 [收起] |                                                                                    |
| [v] Lab 0 L0 基线        |                                                                                     |
| [v] Lab 1 身份与成本护栏  |                                                                                     |
| [v] Lab 4 照片存进 S3    |                                                                                     |
| [v] Lab 5 CloudFront    |                                                                                     |
| [v] Lab 15 关系数据库    |                                                                                     |
| [!] Lab 16 缓存          |                                                                                     |
| [>] Lab 8 用户身份       |                                                                                     |
|   [>] auth  3/9         |                                                                                     |
|   [#] identity-pool *   |                                                                                     |
| [ ] Lab 10 解耦：SQS    |                                                                                     |
| …                      |                                                                                     |
+------------------------+-------------------------------------------------------------------------------------+
| 上次检测 10:42 · 指南 9f3c1e2 · i-0abc123 · t4g.small · apne1-az4 · single · app 1.0.0 · 实时 ● SSE           |
+--------------------------------------------------------------------------------------------------------------+
```

布局尺寸：
- 顶栏目标高度 48px，内容过多时允许折成两行。实际高度由 `ResizeObserver` 写入 CSS 变量 `--topbar-h`，所有吸顶元素（左栏、指南的步骤栏与检测栏）的 `top` 都用 `calc(var(--topbar-h) + 12px)`，不写死像素。
- 1700px 以下隐藏顶栏各项的标签文字（只留数值、短状态词和 `aria-label`），“继续”按钮最大 300px 并截断，保证 1280–1440px 的常见宽度下单行显示。
- 767px 以下顶栏不吸顶（随页面滚走），“继续”按钮独占一行；把可视区域留给内容和底部操作栏。
- 左栏宽 248px，可以折叠为 56px 的图标栏；1023px 以下变为抽屉。
- 内容区最大宽度 1440px。
- 页脚状态条高 28px。

### 3.4 页头元素规格

#### 3.4.1 继续按钮 `ContinueButton`

| 项 | 规格 |
|---|---|
| 目标 | `GET /api/console/state` 返回的 `cursor.continue` 深链（计算方法见 §4.11 第 4–7 条） |
| 文案模式 | `继续：Lab {n} › {moduleId} › 步骤 {k} {步骤标题}`。k 是步骤编号，与指南左栏一致，基线为第 0 步。超过 36 个字时截断，悬停显示全文 |
| 变体 | 继续步骤（默认）；`运行 after 实验`（模块处于 verifying 且缺对比）；`先修复：{moduleId}`（存在漂移且阻塞，按钮变为橙色描边）；`查看学习报告`（全部完成）；向导未完成时隐藏 |
| 加载 | 先用 `localStorage` 中上次的文案渲染（灰字），`/state` 返回后替换 |
| 键盘 | 全局快捷键 `G` 然后 `C`（单键快捷键关闭时不可用） |

#### 3.4.2 档位徽章 `TierBadge`（当前档位，运行时计算）

档位描述的是**当前运行状态**，不是学习进度。它在运行时读取总纲 §10 的档位文件计算，界面与代码里都不写死档位名或档位数：

1. 启动时（以及 `profiles/` 目录变化时）读取 `profiles/*.env`，按 `PROFILE_EXTENDS` 建出阶梯链 `l0-ec2 → l0-plus-local-tiers → l1-ops → … → l9-full`；文件名以 `x-` 开头的是变体，以 `overlay-` 开头的是覆盖层，`single/` 下的是单模块档位，都不进入阶梯链。
2. 每个阶梯档位的**判定集合** = 它的 `PROFILE_MODULES`，减去 `PROFILE_OPTIONAL`，再减去学员路线中不适用的模块（没有域名时去掉 dns、tls，否则 l2-edge 永远达不到）。`PROFILE_DRIVERS` 中的取值作为附加条件：例如 l8-ha 要求 `NETWORK_PLACEMENT=private`，l6-data 要求 network 为 `public` 或 `private`。
3. **当前档位** = 满足条件的最深档位，条件是从 l1 起每一档的判定集合都处于 capabilities `ok` 或 `degraded`，并满足附加条件。`l0-plus-local-tiers` 的判定是“仍只有 ec2，且至少一个开关取本地档”（`CACHE_DRIVER=memory`、`QUEUE_DRIVER=memory`、`IMAGE_PROCESSOR=worker`、自建 PostgreSQL 等）。
4. 额外徽标 `+N`：N = 正在运行、但不属于已满足档位判定集合的模块数。例如 `l2-edge +2` 表示 l2-edge 已凑齐，另外还有 database、cache 在运行（学员走的是快速路线）。
5. **变体**：对每个 `x-*.env` 计算“运行中 / 集合总数”，在悬停浮层中单列一行，例如“x-named-comparisons：6/9 在运行，还差 auth、queue、image-processing”。学员选择了重点对比快速路线时，徽章主文案仍是阶梯档位，变体进度在浮层第一行。
6. capabilities 中 `app.profile` 有值（学员用过 `profile apply`）时，浮层同时显示“上次应用的档位文件：l6-data”。如果它和计算结果不一致，加注“已有模块被单独禁用或启用”。

- **悬停浮层**（纯说明，不含可操作链接，用 `role="tooltip"`，同时可由键盘聚焦触发）列出：当前档位已满足的模块；下一档还差哪些模块（例如“l3-identity 还差：auth、identity-pool、email、notification”）；额外运行中的模块；变体进度。点击徽章进入 `/console/map`。
- 外观：等宽字体的档位名加 `+N`；没有颜色语义；docked 时加 1px 描边。
- 原型中档位链、判定集合与变体集合是 registry 与 profiles 的静态快照，算法与上面一致。

#### 3.4.3 整体进度 `OverallProgress`

- 主文案：`配置 {done}/{required}`。`done` 包含 `done`、`done_manual`、`cleaned` 三种状态的必做模块；`required` 由当前路线与 course.yaml 推导（§4.10），界面不写死。例如主线（没有域名）为 32，重点对比快速路线为 10。
- 分段条宽 96px，三段分别表示：全自动完成（实心，`--st-pass`）、含手动完成（斜纹，`--st-manual`）、进行中（浅色，`--st-pending-soft`）。
- 点击按钮展开进度浮层（disclosure：按钮带 `aria-expanded` 与 `aria-controls`，Esc 或点击外部收起；不在悬停时自动展开，也不用 `role="tooltip"`，因为浮层里有链接）。浮层内容：`全课程 11/32 · Lab 9/24 · 选做 0/8 · 检查：自动通过 116 项 · 手动 3 项 · 待确认 1 项 · 异常 1`，以及“去确认”“去排错”链接（分别进入 S10 的对应筛选）和“模块目录”链接。数量的单位一律写明（“项”指检查，“个”指模块）。

#### 3.4.4 检测能力徽章 `CredentialBadge`（凭证状态）

| 状态 | 判定 | 显示 | 色 |
|---|---|---|---|
| `full` 自动 | 已用实例角色取得凭证，能 AssumeRole 到 Verifier 角色，并且 Verifier 自检全部通过 | `检测 ● 自动` | pass |
| `partial` 部分 | 能取得 Verifier 凭证，但缺少部分 action，或策略版本落后 | `检测 ◐ 部分（缺 3 项权限）` | stale |
| `local` 仅本地 | `IAM_CREDENTIALS=none`；或 `keys` 模式（检测器不使用长期密钥，见 §6.8，同时显示 CRED-002 提示） | `检测 ○ 仅本地` | locked |
| `unreachable` 不可达 | 有凭证，但 AWS API 不可达，例如私有子网里没有 NAT 或 VPC 端点 | `检测 ✕ AWS 不可达` | fail |
| `clock` 时钟偏差 | 最近一次调用返回 `RequestExpired` 或 `SignatureDoesNotMatch`，且本机时钟偏差超过 5 分钟 | `检测 ✕ 时钟偏差` | fail |

- 圆点只是辅助，状态必须同时由**形状**（●◐○✕）和**短文字**（自动 / 部分 / 仅本地 / 不可达 / 时钟）表达。窄屏隐藏“检测”标签，但保留短文字；按钮带完整的 `aria-label`，例如“检测能力：部分，缺 3 项权限”。
- 检测能力只影响 AWS 只读检查能否自动执行，**不影响模块能否启用**：模块的 locked 只在 `IAM_CREDENTIALS=none` 且模块 `credentials: required` 时出现（CRED-001，§4.5）。
- 点击进入 `/console/settings/detection`。L0 时悬停文案：“AWS 只读检查暂不可用：实例没有 IAM 角色。完成 Lab 1 · iam 后自动复核 14 项。”

#### 3.4.5 费用灯 `CostLight`

| 灯 | 条件（满足任一即可） | 显示（有 cost-rates.yaml 时 / 没有时） |
|---|---|---|
| 绿 | 只有 L0 的基础费用在产生（EC2、公网 IPv4、EBS） | `费用 ● ≈$0.03/h` / `费用 ● 基础 3 项` |
| 黄 | 有按小时计费的模块资源正在运行，并且都属于当前 Lab 或后续 2 个 Lab 需要的资源 | `费用 ▲ ≈$0.08/h` / `费用 ▲ 计费中 5 项` |
| 红 | ① 有按小时计费的资源闲置超过 24 小时，且后续 2 个 Lab 用不到；② 本月估算超过预算的 80%；③ 发现未纳管的计费资源 | `费用 ■ ≈$0.14/h · 有闲置` / `费用 ■ 有闲置` |

- **价格来源只有一个**：学员从官方定价页抄录的 `/etc/cloudalbum/cost-rates.yaml`（总纲 §2.4 与 cost 模块）。文件不存在时不显示任何金额，只显示计费中的资源与时长；S11 提供“生成 cost-rates.yaml 模板”的命令（只列计费维度，不填价格）。仓库不内置示例价。
- “闲置”的判定：最近 24 小时没有任何检查、实验或请求路径涉及该模块（数据来自 LabMetricsStore 的端口调用计数）。
- 金额前一律加 `≈`。形状（●▲■）加文字表达状态，窄屏保留金额或“计费中 n 项”，并带 `aria-label`（例如“费用：黄灯，约 0.08 美元每小时，估算”）。悬停时显示数据来源：“估算（cost-rates.yaml，2026-10-01 更新）”或“已用 AWS 只读核实资源”。点击进入 `/console/cost`。

#### 3.4.6 管理员菜单

显示用户名或邮箱，以及登录方式（本地账号 / Amazon Cognito / 应急链接）。菜单是一个 disclosure：按钮带 `aria-expanded`，点击展开一个普通的链接与按钮列表（不使用 `role="menu"` / `menuitem`，因此按 Tab 顺序导航即可），Esc 或点击外部收起，不在悬停或获得焦点时自动展开。列表项：
- 主题：跟随系统 / 亮 / 暗（三个按钮，带 `aria-pressed`）
- 重放新手引导
- 键盘快捷键与图例
- 回到相册
- 退出

### 3.5 左栏：导航与课程大纲

- **导航分 4 组**：学习（总览、学习路线、模块目录、架构图）、验证（对比实验、检测报告、请求路径）、运维（费用与清理、学习报告）、设置。
- **计数徽标**：
  - 检测报告的徽标 = 必需检查中 `fail` 和 `error` 的数量。
  - 费用与清理的徽标在费用灯为红时显示 `!`。
- **课程大纲**是 Lab → 模块两级树，按学员所选路线排列（快速路线按 `x-named-comparisons` 的推荐顺序，主线按 Lab 编号）：
  - 默认只展开当前 Lab；展开状态存 `localStorage`。
  - 每行显示状态符号、模块 id 和步骤进度 `2/5`，选做模块加注“选做”（`*`）。
  - 当前位置用左侧 2px 的 `--accent` 竖条标出。
  - 采用 WAI-ARIA tree 模式：容器 `role="tree"`，Lab 行 `role="treeitem" aria-level="1" aria-expanded`，模块行 `role="treeitem" aria-level="2"`；roving tabindex（树只占一个 Tab 停靠点）。↑↓ 在可见行间移动，→ 展开（已展开时进入第一个子项），← 折叠（在子项上时回到父项），Home / End 到首尾，Enter 进入 Lab 概览或模块，空格切换展开。
- **折叠后**左栏只显示图标；课程大纲改由顶栏左侧的 `≡` 打开抽屉。

状态符号表（全站统一，每个符号都配有文字或 `aria-label`）：

| 符号 | 含义 | 符号 | 含义 |
|---|---|---|---|
| `[v]` | 已完成（全自动）；步骤级为“已达成” | `[M]` | 已完成（含手动确认）；步骤级为“已达成（含手动）” |
| `[>]` | 进行中 / 当前位置 | `[ ]` | 可开始 |
| `[#]` | 未解锁（缺少硬依赖） | `[-]` | 建议稍后（Lab 软门槛）/ 已跳过 / 选做 Lab |
| `[~]` | 核验中（检测运行中或等待资源就绪） | `[?]` | 待手动确认 |
| `[x]` | 未通过 | `[e]` | 检测器出错（不是学员的问题） |
| `[!]` | 漂移（之前通过，现在不通过） | `[z]` | 已完成·已清理 |
| `[^]` | 被后续 Lab 取代（不算漂移） | `·过期` | 证据已超过新鲜期（后缀） |
| `*` | 选做 | | |

### 3.6 横幅

| 优先级 | 类型 | 触发条件 | 文案示例 | 主操作 |
|---|---|---|---|---|
| 1 | 配置校验（红） | capabilities 的 `validation.errors` 非空或 `overridden` 非空 | 不安全实验模式：ASG-004 已被覆盖，cache 被固定为 degraded | 查看规则 |
| 2 | 控制台被缓存（红） | `/api/console/*` 的响应带 `X-Cache: Hit from cloudfront` | CloudFront 缓存了控制台 API。请把 `/api/*` 行为改为 CachingDisabled | 打开 cdn 步骤 4 |
| 3 | 漂移（橙） | 任一模块带有 `drifted` 标记（被取代的检查不算） | 漂移：cache 的“缓存安全组允许 6379”曾于 10/10 通过，现在未通过 | 排错 |
| 4 | 费用（红/黄） | 费用灯为红 | ElastiCache 已闲置 26 小时，后续 2 个 Lab 用不到 | 去清理 |
| 5 | 降级（灰） | 检测能力为 `local` 或 `partial` | 14 项 AWS 检查改为手动确认。完成 Lab 1 · iam 后自动复核 | 去解锁 |
| 6 | 连接不安全（黄） | 通过 HTTP 明文，或经自签名证书访问 | 正在通过 HTTP 访问，密码会明文传输。建议改用 SSH 隧道或 https:// | 怎么做 |
| 7 | 指南更新（蓝） | 已完成模块的 guide 主版本号变化 | cdn 指南 v3 → v4：新增 1 个步骤 | 查看 |

- 关闭操作只在当前会话内有效：关闭记录存在 `sessionStorage`，读写都包在 try/catch 里；内容发生变化后横幅会再次出现。
- 红色横幅不能关闭。
- **同一件事在一屏里只说一次。** 总览页自己有“先修复”区块，因此总览页不再显示全局的漂移和费用横幅，横幅区最多 1 条（通常是降级或连接不安全）；其他页面最多 2 条，其余收进“还有 n 条提醒”。
- **读屏播报只在首次出现时进行。** 横幅区只在内容变化时重绘；红色与漂移横幅第一次出现时带 `role="alert"`，之后的渲染（例如切换路由）去掉该角色，避免每换一页重复播报。
- 767px 以下横幅改为纵向排列：图标隐藏，正文在上，操作按钮在下并允许换行。

### 3.7 全局搜索与快捷键

- 按 `Ctrl+K`（macOS 上为 `⌘K`）打开命令面板。可以搜索：
  - 模块：按 id、服务名、机能名
  - 步骤：按步骤标题
  - Lab
  - 检查：按检查名或检查 ID。选中后**直接打开该检查的详情抽屉**（S10d），而不只是跳到检测报告
  - 页面
  - 常用命令：例如“复制 cdn 的 enable 命令”。选中后**直接复制**（走 CommandBlock 的同一套变量拦截与转义；删除类命令不出现在命令面板里）
- 结果按类型分组，↑↓ 选择，回车执行。

| 快捷键 | 动作 |
|---|---|
| `G` `O` / `G` `P` / `G` `M` / `G` `A` / `G` `C` | 依次跳到：总览、学习路线、模块目录、架构图、继续 |
| `R` | 在指南页运行本步检测 |
| `J` / `K` | 在指南页切换到下一步 / 上一步 |
| `?` | 快捷键与图例 |
| `Esc` | 关闭抽屉、对话框或浮层 |

上表中的单键快捷键（G、R、J、K、?）可以在 S13 › 账号中关闭（满足 WCAG 2.1.4）；`Ctrl+K` 与 `Esc` 始终可用。输入框、文本域、下拉框获得焦点时单键快捷键不生效。

### 3.8 访问控制与首访流转

```mermaid
flowchart TD
  A[访问 /console/*] --> B{GET /api/console/setup/status<br/>initialized?}
  B -- 否 --> S[302 /console/setup]
  B -- 是 --> C{有有效的 ca_console 会话?}
  C -- 是 --> P[渲染页面]
  C -- 否 --> E{有相册会话<br/>且是管理员?}
  E -- 是 --> X[POST /api/console/session<br/>换取 ca_console] --> P
  E -- 已登录但不是管理员 --> F[/console/403]
  E -- 未登录 --> L[302 /console/login?next=原路径]
  L -- 本地账号 / Cognito 托管登录 --> E
  L -- 应急票据 #ticket= --> T[POST /api/console/session/ticket] --> P
```

- **会话**：控制台使用专用会话 `ca_console`（HttpOnly、`Secure`（HTTPS 时）、`SameSite=Strict` Cookie，`Path=/`，服务端只在 `/console` 与 `/api/console/*` 上接受它）。会话令牌由应用的本地 ES256 密钥签名（与总纲 D8 的本地 JWT 同一套 JWKS，`aud=cloudalbum-console`），TTL ≤ 1 小时，不可刷新，过期后重新从相册会话或登录页换取。
- **校验顺序**（auth 中间件）：`/api/console/*` 先找 `ca_console`，验签并检查 `aud`、`exp`，以及令牌中的 `gen` 声明等于当前的 `setup_state.token_generation`（重置管理员或重新生成 setup token 后，旧会话全部失效）；找不到时不回退到相册会话，直接 401，由前端走上面的换取流程。相册自身的 API 不接受 `ca_console`。
- **管理员判定**（换取 `ca_console` 时）：`provider=local` 时看 `users.role = 'admin'`；`auth=cognito` 时只看**已验签的 Cognito 访问令牌**中的 `cognito:groups` 是否包含 `admin`，不读本地 `users.role`；`AUTH_DUAL_STACK=on` 的迁移窗口内，两种令牌都可以换取，但都必须各自满足上面的条件，每次换取都写入 `console_events`（类型 `session.issued`，记录 provider）。
- **写操作的 CSRF 防护**：所有改动状态的请求都要带 `X-CloudAlbum-CSRF` 请求头（双提交 Cookie），并校验 `Origin`。`Origin` 白名单由以下几项组成：`cap.app.entry.baseUrl`（`APP_BASE_URL`）、CloudFront 分配域名（cdn 启用时）、EIP 与 publicDns（`http://` 与 `https://`）、回环地址 `http://localhost:<端口>` 与 `http://127.0.0.1:<端口>`（SSH 隧道或 Session Manager 端口转发），以及请求自身的 `Host`。白名单的组装逻辑要有单元测试覆盖这四类入口。
- **跨入口的会话**：Cookie 只对单个主机有效，学员换一个入口（例如从隧道换到 CloudFront 域名）需要重新换取 `ca_console`；auth=cognito 的托管登录回调必须是 HTTPS（CloudFront 或自定义域名），因此 cognito 模式下请从 HTTPS 入口打开控制台，http://EIP 只能使用应急票据。
- **应急登录**：auth 切到 Cognito 后，如果 Cognito 出了故障或管理员被登出后收不到重置邮件，管理员可以在实例上执行 `sudo -u cloudalbum node /opt/cloudalbum/backend/dist/cli.js console:login-link`。命令打印一个 10 分钟内有效、只能使用一次的链接 `…/console/login#ticket=…`。票据放在 URL 片段里，不会出现在 Referer、CloudFront/ALB 访问日志和服务器日志中；前端读到后立即用 `history.replaceState` 清掉片段，再 `POST /api/console/session/ticket` 兑换为 `ca_console`（附录 B-4）。能拿到这个链接，就说明此人能登录这台 EC2。
- **auth 指南的预检**：auth 的 wire 步骤之前有一个预检步骤（`guides/auth.yaml` 的 `precheck`）：确认管理员邮箱可以收信（`AdminEmail` 不能是 `example.com` 这类占位地址）、`admin` 组已同步到 User Pool、学员知道应急登录命令；步骤声明 `impact: {logout: true}`，界面在执行前提示“接入后所有会话失效，你会被登出”。

---
## 4. 进度模型

### 4.1 三个互相独立的维度

| 维度 | 回答的问题 | 数据来源 | 会不会倒退 | 画在哪里 |
|---|---|---|---|---|
| **学习进度** | 我完成了哪些任务的配置？ | 本章定义的检查、步骤、模块、Lab 状态，存放在应用数据库中（单实例为 SQLite 或 RDS；多实例只能是共享的 RDS，§6.2） | 基本不会。完成时刻会被永久记录；之后出问题只加“漂移”标记，不撤销完成 | 状态徽章、进度环、配置 x/y |
| **运行状态** | 现在实际在跑什么？ | `/api/capabilities`（总纲 §6）以及档位计算（§3.4.2） | 会，随启用和禁用变化 | 档位徽章、架构图节点颜色、模块详情里的“当前运行” |
| **费用** | 现在在为什么付钱？ | 模块的费用声明、启停记录、AWS 只读核实结果、`cost-rates.yaml` | 会 | 费用灯、费用页、架构图的费用镜头 |

三个维度在界面上永远分开显示，不能合成一个颜色。例如“已完成·已清理”的模块：学习维度显示 `[z]`，运行维度显示 `off`，费用维度显示 `$0`。

### 4.2 判定来源

五类判定来源沿用基础决策，另把“浏览器回传的结果”单独列为 ①′，防止客户端数据冒充服务端事实。

| 编号 | 来源 | 检查类型（§5.7） | 需要 AWS 凭证 | 执行位置 | 证明了什么 | 证据强度 | 默认新鲜期 |
|---|---|---|---|---|---|---|---|
| ① | 本地检查 `LOCAL` | `local`、`http-header`、`path-seen`、`session` | 否 | EC2 后端进程（多实例时按 `instanceScope` 在指定实例上执行，§6.2） | **行为事实**：请求实际经过了谁、端口和进程是什么状态、响应头里有什么、当前管理员会话的声明 | 高 | 1 小时 |
| ①′ | 浏览器回传 `LOCAL_CLIENT` | `http-header`（`from: browser`） | 否 | 学员的浏览器，结果回传服务端 | **客户端观察**：例如浏览器经 CloudFront 访问时看到的响应头 | 中。结果必须绑定服务端下发的一次性任务 nonce；**必需检查不能只靠它满足**，至少还要有一项 ① 或 ③ | 1 小时 |
| ② | 能力探针 `PROBE` | `capability` | 否 | EC2 后端进程（读取本进程的能力注册表；多实例时按多数实例聚合） | **应用自报**：当前用的是哪个驱动、健康状态如何、感知器的置信度 | 中 | 5 分钟 |
| ③ | AWS 只读 `AWS` | `aws-readonly` | 是（实例角色 → AssumeRole `cloudalbum-<env>-lab-verifier-role`，§6.7） | EC2 后端进程 | **配置事实**：资源上的具体属性，例如 BPA、OAC、Multi-AZ | 高 | 24 小时 |
| ④ | 对比实验 `EXP` | `experiment` | 否（少数指标可选用 CloudWatch） | 运维机（`npm run exp --upload`）；浏览器运行器的结果只作参考 | **有/无的差异已经被实际测量过** | — | 不过期（模块配置变化后标记“可能过期”） |
| ⑤ | 手动确认 `MANUAL` | `manual`，以及 `aws-readonly` 的降级形态 | 否 | 学员 | **学员声明**（可以附带证据） | 低 | 不过期；凭证可用后自动复核 |

### 4.3 检查结果（一次检查执行后的取值）

| 结果 | 图标 | 含义 | 算不算通过 |
|---|---|---|---|
| `pass` | `[v]` | 自动来源判定为满足期望 | 是 |
| `fail` | `[x]` | 检查本身执行成功，但实际值不符合期望，说明配置有问题 | 否 |
| `pending` | `[~]` | 资源仍在创建或部署中，例如 CloudFront 状态为 `InProgress`、RDS 状态为 `creating`；检查声明了 `waitable: true` 时会自动轮询 | 否，但不算失败 |
| `error` | `[e]` | 检查本身没能完成。错误码只取 §6.9 的统一错误码表（`TIMEOUT`、`THROTTLED`、`ACCESS_DENIED`、`UNREACHABLE`、`CLOCK_SKEW`、`NOT_FOUND_VAR`、`NOT_ALLOWED`、`ASSERT_TYPE`、`INTERNAL`）。这是检测器的问题，不是学员的问题 | 否，但不算失败；也不会覆盖之前的通过结果 |
| `unavailable` | `[?]` | `aws-readonly` 检查因为没有凭证，或检测能力为 `local`/`unreachable`，无法执行 | 否，转为待手动确认 |
| `manual_pending` | `[?]` | 原生 `manual` 检查还没有被确认（它不会被“执行”，所以没有 `not_run` 以外的自动结果） | 否 |
| `manual` | `[M]` | 已手动确认（填写了看到的值） | 是（计入“含手动”） |
| `manual_evidence` | `[M+]` | 已手动确认，并且粘贴的 CLI 输出用同一套断言校验通过 | 是（计入“含手动”） |
| `not_run` | `[ ]` | 从未执行 | 否 |
| `skipped` | `[-]` / `[^]` | 检查当前不适用，不执行，也不计入分母。原因有两种：`when` 条件不成立（例如 `CDN_MEDIA_ORIGIN=s3` 时 EC2 媒体源站的检查），显示 `[-]`；`supersededWhen` 条件成立（后续 Lab 的正当变更改变了它检查的对象，例如 l8-ha 把源站换成 ALB 之后 cdn 的 `eip-associated`），显示 `[^] 被 Lab 19 取代` | 不计入分母 |

`PRECONDITION` 不是检查结果：前置条件不成立的检查根本不执行。模块或步骤因此处于 `locked`（§4.4、§4.5），或检查因 `when` 而 `skipped`。

**有效结果（effective result）**：一项检查当前采用哪个结果。`effectiveResult(check, runs, confirmations, detection)` 需要检查类型作为输入，按以下顺序决定：

```text
1. when 不成立或 supersededWhen 成立                  → skipped（不再看历史结果）
2. 在“决定性结果”中取时间最新的一条：
     自动 pass / fail（来自 ① ② ③；①′ 只在同一步骤另有 ① 或 ③ 时计入）
     有效的手动确认（manual / manual_evidence）
   特例：手动确认晚于自动 fail 时，只有在“现在无法自动执行”（检测能力为 local/unreachable，
   或该检查最近一次结果为 unavailable/error）时才采用手动结果，并加“冲突待复核”标记；
   一旦可以自动执行，立即复核，新的自动结果按时间覆盖手动确认。
3. 没有决定性结果时，取最新的 pending / error / unavailable
4. 原生 manual 检查且未确认                              → manual_pending
5. 其余                                                   → not_run
```

- `error` 和 `unavailable` 不会覆盖更早的 `pass`。这种情况下有效结果仍是 `pass`，界面上加注“最近一次检测未能完成（10:42 · 超时）”。仅本地模式下，之前自动通过的 AWS 检查同样保持 `pass`，加注“当前无凭证，未复核”。
- **多实例**：声明了 `instanceScope: all` 的检查，先按 `(check_id, instance_id)` 分别求有效结果，再聚合：全部实例 `pass` 才算 `pass`，任一实例 `fail` 即 `fail`，界面列出各实例的结果。`any` / `serving` 的检查只保留一条有效结果，并记录执行它的实例 ID（§6.2）。

### 4.4 步骤状态

步骤状态**完全由其中适用的必需检查推导**（`required` 默认为 true）。学员没有勾选按钮。

| 状态 | 中文 | 判定条件（按从上到下的优先级，命中第一条即停） | 计入“已达成” | 徽章 |
|---|---|---|---|---|
| `skipped` | 已跳过 | 选做步骤被学员跳过（可以撤销），或者步骤的 `when` 条件不成立 | 不计入分母 | `[-]` |
| `cleaned` | 已达成·已清理 | 步骤曾经达成，且模块的生命周期为 `cleaned` | 是 | `[z]` |
| `locked` | 未解锁 | **从未达成**，并且所在模块处于 `locked`，或步骤的 `requires.runtime` 表达式不成立。已达成的步骤不会变回 locked，只加附加标记“重建需要先恢复 X” | 否 | `[#]` |
| `drifted` | 漂移 | 步骤曾经达成（`first_passed_at` 有值），现在某项适用的必需检查的有效结果为 `fail` | 是（保留达成记录，并加异常标记） | `[!]` |
| `failed` | 未通过 | 从未达成，且某项适用的必需检查的有效结果为 `fail` | 否 | `[x]` |
| `verifying` | 核验中 | 有检查正在运行，或有 `pending` 结果 | 否 | `[~]` |
| `error` | 检测器出错 | 有 `error` 结果，并且该检查之前没有通过，也没有被手动确认 | 否 | `[e]` |
| `needs_manual` | 待手动确认 | 只剩下 `unavailable` 或 `manual_pending` | 否 | `[?]` |
| `done` | 已达成 | 全部适用的必需检查的有效结果都为 `pass` | 是 | `[v]` |
| `done_manual` | 已达成（含手动） | 全部适用的必需检查都已满足，其中至少一项是 `manual`/`manual_evidence` | 是 | `[M]` |
| `available` | 可开始 | 以上条件都不满足，即从未执行过 | 否 | `[ ]` |
| `read` | 已读 | `type: read` 的纯阅读步骤，学员点过“已读” | 不计入分母 | `[v]`（灰） |

步骤级的文案一律用“已达成”，模块级才用“完成”（附录 C）：`done` → 已达成，`done_manual` → 已达成（含手动），`cleaned` → 已达成·已清理，`drifted` → 漂移。

附加标记（与状态叠加显示，不改变状态）：
- `stale`：证据超过新鲜期，显示为“·过期”。
- `overridden_by_script`：该步骤由一键脚本一次性完成，显示为“·脚本”。这只是学习记录，不影响判定。
- `rebuild_needs`：已达成的步骤所依赖的模块当前不在运行（例如 database 被清理后 autoscaling 的步骤），显示“重建需要先恢复 database”。

```ts
// backend/src/console/progress/step-state.ts —— 纯函数，配套表驱动单元测试
export function stepState(s: StepInput): StepState {
  if (s.skipped || s.whenFalse) return 'skipped';
  const achieved = s.firstPassedAt != null;
  if (achieved && s.moduleLifecycle === 'cleaned') return 'cleaned';
  if (!achieved && (s.moduleLocked || !s.runtimeReqsMet)) return 'locked';
  if (s.type === 'read') return s.readAt ? 'read' : 'available';
  // 先剔除不适用的检查（when 不成立、supersededWhen 成立），它们既不阻塞也不计入
  const eff = s.requiredChecks
    .map(c => effectiveResult(c))                                // §4.3，需要检查类型作为输入
    .filter(r => r !== 'skipped');
  if (eff.length === 0) return achieved ? 'done' : 'available';  // 全部不适用：保留历史，不新增达成
  if (eff.some(r => r === 'fail')) return achieved ? 'drifted' : 'failed';
  if (s.running || eff.some(r => r === 'pending')) return 'verifying';
  if (eff.some(r => r === 'error')) return 'error';
  if (eff.some(r => r === 'unavailable' || r === 'manual_pending')) return 'needs_manual';
  if (eff.every(r => r === 'pass')) return 'done';
  if (eff.every(r => r === 'pass' || r === 'manual' || r === 'manual_evidence')) return 'done_manual';
  return 'available';
}
// 每当某一步首次进入 done 或 done_manual，就写入 first_passed_at；之后只更新 last_passed_at。
// rebuild_needs 标记由调用方另行计算：achieved && (s.moduleLocked || !s.runtimeReqsMet)。
```

### 4.5 模块状态

模块状态由两部分组成：**生命周期**（持久化保存，基本只进不退）和**健康标记**（实时计算，可以同时存在多个）。

**生命周期**

| 状态 | 中文 | 判定条件 |
|---|---|---|
| `locked` | 未解锁 | 只用于**从未完成**的模块。条件任一成立：① 注册表 `requires` 表达式里的硬依赖当前没有在运行；② 模块 `credentials: required`，而 `IAM_CREDENTIALS=none`（CRED-001）；③ 模块要求 role（shell-access 的 DEP-001、vuln-scan 的 DEP-035），而 iam 不是 role 模式；④ 人工前置不成立，例如路线中没有域名时的 dns、tls。**`keys` 模式不锁模块**：模块照常可用，只显示 CRED-002 提示，并且 AWS 只读检查降级为手动确认（检测器不使用长期密钥，§6.8） |
| `available` | 可开始 | 硬依赖已满足，但还没有任何步骤达成 |
| `in_progress` | 进行中 | 至少一个必需步骤已达成，但还没有全部达成 |
| `verifying` | 核验中 | 全部必需的配置步骤和“接入应用”步骤都已达成，但对比条件还不满足（缺有效的 before 或 after，§4.7）。界面文案：“配置已生效，待对比” |
| `done` | 已完成 | 全部必需步骤都已达成，对比条件满足（§4.7），并且所有必需检查都由自动来源满足 |
| `done_manual` | 已完成（含手动） | 同上，但至少一项必需检查是手动确认的 |
| `cleaned` | 已完成·已清理 | 曾经达到 done 或 done_manual（`completed_at` 有值），之后出现了模块禁用事件（§4.13），且当前运行状态为 `off` |

**健康标记**（只在 `in_progress` 及之后的状态出现）

| 标记 | 条件 | 显示 |
|---|---|---|
| `failing` | 在 in_progress 或 verifying 状态下，有适用的必需检查的有效结果为 `fail` | 状态徽章改为 `[x] 未通过` |
| `drifted` | 在 done、done_manual 或 verifying 状态下：已达成的步骤出现 `drifted`（被取代的检查不算）；或 capabilities 的 `status=error`；或在没有禁用事件、也没有进行中的操作，且宽限期已过的情况下 `status=off`（§4.13） | 状态徽章改为 `[!] 漂移` |
| `needs_confirmation` | 有步骤处于 `needs_manual`（任何生命周期都可以出现） | 小角标“待确认 n” |
| `degraded` | capabilities 的 `status=degraded` 持续超过 10 分钟 | 小角标“降级” |
| `stale` | 有已达成步骤的证据超过新鲜期 | 小角标“过期” |
| `checking` | 有检测正在运行 | 状态徽章叠加转圈动画 |
| `guide_updated` | 完成后，指南主版本号变化并新增了必需步骤 | 小角标“指南有更新” |
| `rebuild_needs` | 已完成或已清理的模块，其硬依赖当前不在运行 | 小角标“重建需要先恢复 X” |

**徽章的取值顺序**：`drifted` → `failing` → 生命周期状态（`cleaned`、`done`、`done_manual` 优先于 `locked`，因为 `locked` 只用于从未完成的模块）。`checking` 只是叠加在徽章上的动画；`needs_confirmation`、`degraded`、`stale`、`guide_updated`、`rebuild_needs` 以小角标形式显示。

**“接入应用”必须真的接入。** 每个模块都恰好有一个 `type: wire` 的步骤（§5.4），它的必需检查至少包括：
1. `capability`：`modules.<id>.status ∈ {ok, degraded}`。适配器型和参数型模块还要求 `driver` 等于 AWS 实现；纯基础设施型模块还要求 `confidence ∈ {confirmed, observed}`（总纲 §3.3）。
2. 一项**实际流量证据**，按模块的路径段出现在哪里选择检查类型：
   - 段出现在 GET 请求上（cache、storage、cdn 的 `entry` 等）：`http-header`，由引擎带探测令牌请求 `GET /api/console/probe/now` 或指南指定的白名单路由，断言 `X-CloudAlbum-Path` 中出现该模块的 AWS 段（例如 `cache=redis@elasticache:hit`、`entry=cloudfront>nginx`）。持有探测令牌的请求不论 `EXPOSE_PATH_HEADERS` 取何值都返回路径头（附录 B-12）。
   - 段只出现在 POST 或异步路径上（`queue=sqs:queued`、`image-processing=lambda:async`，以及 email、notification、tagging）：`path-seen`，查询 LabMetricsStore 的汇总，断言最近 `window` 内真实请求（排除探测请求）中出现过匹配的段。
   - auth：`session`，断言服务端解析出的当前管理员会话 `provider=cognito`、`groups` 含 `admin`（MFA 打开时 `amr` 含 `mfa`）。
   - 参数型模块没有自己的路径段时用相关段代替：autoscaling 用 `path-seen` 断言最近窗口内出现 ≥ 2 个不同的 `inst`（`distinct: {segment: inst, min: 2}`）。
   - 纯基础设施型模块：路径头里没有对应段时，用感知器的 `observed` 证据；感知器的判据必须是外部无法伪造的（附录 B-11）。

这样，“资源配好了，但应用没用上”就不会被算成完成。

**特殊模块 ec2**：没有对比实验，也没有 wire 步骤。必需步骤是“L0 体检”（首次启动向导写入）与几项账号护栏（根账号 MFA、统一标签、EBS 默认加密）。体检中的本地检查不需要凭证；AWS 类检查（EBS 加密、弹性 IP、22 端口、根账号 MFA 的 `iam:GetAccountSummary` 等）没有凭证时降级为手动确认，因此 L0 时 ec2 是 `done_manual`，完成 Lab 1 · iam 后自动复核升级为 `done`。“用 Identity Center 用户登录过控制台”是原生手动检查，属于选做步骤，不影响 ec2 的完成状态。Budgets 属于 cost 模块（Lab 1），其中“收到测试告警邮件”是原生手动检查，所以 cost 最多达到 `done_manual`，这是预期行为。

### 4.6 Lab 状态

| 状态 | 中文 | 判定条件 |
|---|---|---|
| `suggested_later` | 建议稍后 | `course.yaml` 中声明的前置 Lab（`after`）尚未完成。这是软门槛：可以点“仍要开始”，模块级的硬依赖照常生效 |
| `available` | 可开始 | 前置 Lab 已完成，本 Lab 还没有模块开始 |
| `in_progress` | 进行中 | 有模块处于 in_progress 及之后的状态 |
| `done` | 已完成 | 本 Lab 的必做模块全部为 done，或为 cleaned 且原本是 done |
| `done_manual` | 已完成（含手动） | 必做模块全部完成，其中至少一个是 done_manual |
| `cleaned` | 已完成·已清理 | 已完成，并且本 Lab 中按小时计费的资源都已清理 |
| `opt_lab` | 选做 Lab | 本 Lab 在当前路线中没有必做模块：Lab 25（compliance、vuln-scan 都是可选），没有域名时的 Lab 6。显示 `[-] 选做`，不计入 Lab 进度的分母 |

- Lab 的“必做模块”= `course.yaml` 中该 Lab 的模块，减去选做模块（§4.10），再与当前路线取交集。
- 重点对比快速路线只包含 9 个 Lab（Lab 0、1、4、5、15、16、8、10、11）；其余 Lab 在路线图上显示“不在当前路线”，状态照常计算，学员切回主线时进度不丢。
- 小测成绩**不影响** Lab 状态。成绩只作为独立的“考点掌握”指标显示（§2.5）。

### 4.7 对比实验的有效性（判定来源 ④）

一个模块的对比条件满足 = 同一个实验（`experiments/<id>/experiment.json` 中的同一 `id`）的**第一档（基线）**和**最后一档**各有一条有效记录。多数模块只有两档（`before`、`after`）；queue 与 image-processing 按 04 文档是多档：queue 为 `before`（sync）→ `memory` → `after`（sqs），image-processing 为 `before`（inline）→ `worker-memory` → `worker-sqs` → `after`（lambda）。中间档是选做，记录了就在对比表中并列显示，不影响完成判定。档位由指南的 `compare.stages` 声明（§5.3），运行器用 `npm run exp -- <id> --label <stage>`。

| 校验项 | 规则 | 数据来源 |
|---|---|---|
| 驱动一致 | 每一档的驱动必须匹配该档声明的 `drivers`（例如 before 匹配注册表中的本地值或本地档，after 匹配模块拥有的 AWS 值；纯基础设施型看感知器的结论）。**不信任运行器自报的 `environment.drivers` 与 `forced`**：以服务端在 `POST /api/lab/runs` 登记该 run 时保存的 capabilities 快照为准，并检查运行时间窗内的 `capability_events`，窗口内该模块驱动发生过变化即无效 | 服务端快照 + `capability_events` |
| 路径占比 | 实验时间窗内，该模块路径段命中该档模式的请求占比 ≥ 95%。模式写在 `compare.stages[].validity` 中，例如 cache 的 before = `none\|memory*`、after = `redis@elasticache:*` | 回源请求：LabMetricsStore 按 runId 分组的路径签名（总纲 §7.3）。**边缘模块**（cdn）：见下文“客户端证据” |
| 可比性 | 两档运行的场景、`params`、实例类型相同，并且服务端快照中都没有 `forced` 覆盖 | 服务端快照 |
| 样本量 | 达到实验清单中的 `minSamples` 或指南中的同名字段，默认 100。边缘模块按客户端样本计数 | 同上 |
| 分布 | `validity.distinct` 声明时，样本中该段的不同取值数达到下限，例如 autoscaling 的 after 要求 `inst` 至少 2 个 | 同上 |
| 模拟基线 | 模块已经启用后才补测 before 时，如果实验支持 `--ab` 且注册表声明了旁路键，可以用 `X-Compare-Bypass` 补测。此时 before 被标为 `simulated`，有效，但界面注明“模拟基线” | 路径头中的 `bypass=` 段 |

**边缘模块的客户端证据。** cdn 命中边缘缓存的请求不回源，`/assets/*`、`/media/*` 的缓存策略也不转发 `X-Experiment-Run`，Nginx 直接返回的静态文件不经过 Node，所以服务端样本既不完整也无法归属到 runId。因此 cdn 的有效性改用客户端证据：

1. 运行器对每个响应记录 `X-Cache`、`X-Amz-Cf-Id` 与 `X-CloudAlbum-Path`（缓存命中的响应带着回源时生成的路径头），按目标分组。
2. 指南用 `validity.byTarget` 为每个目标声明期望：`direct`（EIP 直连）的 `entry` 段为 `nginx`，`cdn` 的 `entry` 段为 `cloudfront>*`；占比和 `minSamples` 按各目标分别计算。也可以把两条路径拆成 `after-direct`、`after-cdn` 两档。
3. 结果用运行器的实验上传令牌上传（§6.10），服务端校验 runId 已登记、令牌有效、样本时间落在 run 的时间窗内。

**延迟校验。** LabMetricsStore 每 10 秒把汇总写入 `lab_metric_rollups`（总纲 §7.3），多实例时各实例写入的时间不同步。上传后的记录先显示“校验中”；后台任务在 `运行结束时间 + 汇总周期 + 实例数 × 5 秒` 之后（rollups 补齐）再计算占比与样本数，结果通过 SSE `exp.recorded` 推送。

- **浏览器运行器**的结果（`runner: browser`）一律标为“参考”，显示在对比表中，但不计入完成判定：它的样本与驱动都来自客户端，且跨域时读不到 `X-Amz-Cf-Id`。
- **定性模块**（`lab.compare: functional | fault`，例如 audit、kms、shell-access）：before 和 after 各用一次“现象对比卡”记录（§7 S08）。记录内容是一组 `local`/`aws-readonly`/`manual` 观察检查的结果，由服务端生成并写入 `experiment_runs`（`runner='console'`，§10.2）。
- **无效记录**会保留，并标出原因，例如“after 时 cache.driver=memory”“运行期间 cdn 驱动变化”，但不计入完成。

### 4.8 手动确认与复核

| 种类 | 什么时候出现 | 记录 | 统计口径 |
|---|---|---|---|
| 原生手动 | 检查的类型就是 `manual`，例如“收到了 Budgets 测试告警邮件”（cost）、“用 Identity Center 用户登录过控制台”（ec2，选做） | `manual_confirmations.kind='native'` | 计入“含手动” |
| 降级手动 | `aws-readonly` 检查结果为 `unavailable`，学员按 `manualFallback` 的提示自行核对 | `kind='degraded'`，并记录 `degraded_reason` | 计入“含手动”；凭证可用后自动复核 |

确认时的要求：

1. 必须**填写看到的值**：从 `observed.options` 中选择，或按 `input.pattern` 输入。只有选中期望值才能提交；选了其他值，界面直接显示对应的修复提示（`fixHint`）。
2. 备注为必填项，至少 6 个字。
3. 可以粘贴 `evidence.command` 的输出。证据命令一律带 `--query`，只投影要校验的字段（例如 `--query 'DistributionConfig.Origins.Items[0].CustomOriginConfig'`），不让学员粘贴含密钥的完整输出。后端用与自动检查**完全相同的断言**来校验：校验通过记为 `manual_evidence` [M+]；不通过时提示具体哪个字段不符合，且不允许提交。粘贴内容只用于校验，入库前按 §6.6 的投影与打码规则处理。
4. **不支持批量确认**：任何列表都没有“全部确认”按钮。
5. 凭证可用后（检测能力从 `local` 变为 `full`/`partial`），引擎会自动重新执行所有 `degraded` 确认对应的原始检查：
   - 结果为 `pass`：该检查的有效结果变为自动 `pass`，确认记录标记为 `upgraded`。
   - 结果为 `fail`：确认记录标记为 `conflict`，有效结果为 `fail`（自动结果更新）。步骤因此变为 drifted 或 failed，并显示红色提示“手动确认与自动检测不一致”。
   - 处理完成后汇总成一条通知，例如：“复核 14 项：12 项升级为自动，1 项冲突，1 项缺少权限”。
6. 凭证被撤销后，学员新做的手动确认如果晚于最近一次自动 `fail`，按 §4.3 的特例生效，并标“冲突待复核”；凭证恢复后再按第 5 条复核。

### 4.9 来源优先级与冲突裁决

1. **同一项检查**：按 §4.3 的有效结果规则——自动结果与手动确认按时间比较，较新的为准；手动确认晚于自动 `fail` 时只在无法自动执行期间生效；`error`、`unavailable` 不覆盖 `pass`。
2. **同一步骤内的多项检查**：全部适用的必需检查都要满足。完成质量取所有检查中最弱的来源，只要有一项 ⑤，就是 `done_manual`。①′（浏览器回传）不能单独满足任何必需检查。
3. **不同来源对同一事实给出相反结论**时，按“谁更接近事实”裁决：
   - ③ 配置事实和 ① 行为事实都优先于 ② 应用自报。
   - 典型例子：② 显示 `cdn.status=ok`，但 ① 发现最近真实请求的 `entry=nginx` 占比 100%，说明用户还在直连 EIP。这时 wire 步骤判为 `fail`，并匹配到常见错误“仍在用 EIP 访问”。
   - wire 步骤同时要求 ② 和 ① 都满足，正是为了让这类冲突暴露出来。
4. ④ 只用于判定对比条件，不能替代任何配置检查。
5. ⑤ 不能覆盖时间更新的 ③ 或 ①。

### 4.10 整体指标

| 指标 | 定义 | 显示位置 |
|---|---|---|
| **配置完成度**（主指标） | 处于 done、done_manual，以及原本已完成、现在为 cleaned 的**必做**模块数，除以必做模块数。必做集合由当前路线推导，不写死：**主线** = registry 中出现在 course.yaml 里的模块，减去选做模块；**重点对比快速路线** = `x-named-comparisons` 的模块集合加 cost。选做模块 = 需要域名而路线没有域名的（dns、tls）、变体专用的（shared-fs，按 `x-efs-asg` 练习）、Lab 扩展（db-proxy、workflow、ami）、可选 Lab 25 的（compliance、vuln-scan）。按当前 registry（40 个模块），主线没有域名时为 32，有域名时为 34；快速路线为 10。学员可以把选做模块“加入路线”，分母随之变化 | 顶栏、S02、S05、S12 |
| 全课程完成度 | 快速路线下另显示主线口径的完成度，例如“全课程 11/32”，让学员知道离完整课程还有多远 | 顶栏浮层、S02 |
| 证据质量 | 全自动完成的模块数 ÷ 已完成的模块数；另外统计各来源的检查数量（单位“项”） | S02、S05、S10 |
| Lab 完成 | 已完成的 Lab 数 / 非选做 Lab 数（course.yaml 推导；当前没有域名时为 24） | 顶栏浮层、S03 |
| 选做完成 | 已完成的选做模块数 / 选做模块总数 | 顶栏浮层 |
| 当前档位 | §3.4.2 | 顶栏 |
| 考点掌握 | 各 Lab 小测的最好成绩，按 SAA 四个领域（安全 / 弹性 / 高性能 / 成本）拆分。领域划分沿用 saa-coverage.md | S02、S12 |
| 异常数 | 带 drifted 或 failing 标记的模块数，加上有冲突的确认数 | 顶栏浮层、S10 |

界面上凡是同时出现模块数和检查数的地方，必须写明单位（“个模块”“项检查”），例如“已完成 7/10 · 检查：自动通过 116 项 · 手动 3 项 · 待确认 1 项”。

### 4.11 推荐下一步（`GET /api/console/next`）

实现为一个纯函数 `recommend(state, course, registry, track, now)`，可以做表驱动的单元测试。按下面的顺序逐条匹配，**第一个命中的作为主推荐**；其余命中项按顺序最多取 2 条作为“也可以先做”。被阻塞的模块单独列出，并说明原因（带规则编号）。

| # | 规则 | 推荐内容 | 理由文案示例 |
|---|---|---|---|
| 1 | 向导没有完成 | 首次启动向导 | 先完成初始化 |
| 2 | 某个模块带 `drifted` 标记，或存在冲突的确认，并且它是当前模块的运行时依赖，或者本身就是当前模块 | 修复该模块 | storage 是 cdn `/media` 回源的依赖，现在 BPA 有 2 项被关闭 |
| 3 | 按小时计费的资源闲置超过 24 小时，且接下来 2 个 Lab 都不需要；或者当日估算超过阈值 | 清理该资源（进入 S11b） | ElastiCache 已闲置 26 小时，后续 2 个 Lab 用不到 |
| 4 | 当前位置（最近活动的 in_progress 模块）有尚未达成的步骤 | 第一个未达成的步骤 | 继续上次的进度 |
| 5 | 当前模块处于 verifying | 运行缺少的那一档实验（通常是 after）；如果缺 before 且支持旁路，就提示用旁路补测模拟基线 | 配置已生效，还差 after 实验 |
| 6 | 当前模块带 `needs_confirmation` 标记 | 有凭证时自动复核；没有凭证时进入手动确认 | 还有 2 项待确认 |
| 7 | iam 还没有完成，并且全站累计 `unavailable` 的检查达到 5 项 | Lab 1 · iam | 完成后 14 项检查可以自动执行 |
| 8 | 按当前路线的顺序（主线按 Lab 编号，快速路线按 `TRACKS.named.labs` 的顺序；再按 Lab 内的顺序），找到第一个可开始、未完成、属于必做的模块 | 该模块的第 0 步（before） | Lab 10 的下一个模块，依赖已满足 |
| 9 | 当前 Lab 的必做模块已经全部完成，但还没做小测 | Lab 小测（只出现在备选里） | 巩固本 Lab 考点 |
| 10 | 全部完成 | 学习报告与清理 | 完成 32/32 |

第 8 条的同序裁决依次比较：
1. 软依赖 `learning.after` 是否满足；
2. 是否属于用户点名的重点模块（auth、queue、cdn、image-processing、cache、storage、database），属于则优先；
3. 是否**不**开始按小时计费，不开始的优先；
4. 是否能让一块“本地芯片”迁出 EC2（§7 S07），能的优先。

**被阻塞的模块**：列出依赖不满足的模块和原因，原因直接引用规则编号，例如“network：DEP-016，database、cache 已部署在默认 VPC，迁入自定义 VPC 前要先清理它们（快速路线保持默认 VPC）”“db-proxy：需要 secrets（secretsmanager）在运行（DEP-032）”。

**费用护栏**：候选模块会开始按小时计费，并且 cost 模块的 Budgets 步骤还没有达成时，推荐照常给出，但附上提示“先完成预算告警（Lab 1 · cost · 步骤 budgets）”，并把该步骤插入备选的第一位。

**当前位置的确定**：取最近 7 天内最后一次交互的 in_progress 或 verifying 模块。交互包括运行检查、记录实验、在指南页停留超过 30 秒。没有符合条件的模块时，取主推荐的目标。

**输出结构**：每条推荐都包含以下字段：

```text
kind      推荐类型
target    深链
reason    理由
estMinutes  预计耗时
billing   是否开始计费：none / usage / hourly / fixed-monthly
labId     所属 Lab
moduleId  所属模块
stepId    所属步骤
```

学员可以对单条推荐点“稍后”，该条会被隐藏 24 小时（保存在 `console_settings`）。

### 4.12 课程编排与依赖

`course.yaml`（§5.2）是控制台读取 Lab 编排的唯一文件，它的内容**照抄总纲 §10.3**，不另行编排；CI 检查两者一致（`npm run guides:lint` 读取总纲导出的 `course.snapshot.json` 比对）。下表是当前快照：

| Lab | 标题 | 模块（* 选做 / 扩展） | 软前置 | 档位 | 预计 | 会开始按小时计费的模块 |
|---|---|---|---|---|---|---|
| 0 | L0 基线：只有一台 EC2（含本地档） | ec2 | — | `l0-ec2` → `l0-plus-local-tiers` | 1.5h | —（只有 EC2 本身） |
| 1 | 服务器身份与成本护栏 | iam、cost | Lab 0 | `l1-ops` | 2h | — |
| 2 | 不开 22 端口的运维登录 | shell-access | Lab 1 | `l1-ops` | 1h | — |
| 3 | 看得见：日志、指标与告警 | logging、monitoring | Lab 1 | `l1-ops` | 2h | — |
| 4 | 照片存进 S3 | storage | Lab 1 | `l2-edge` | 2h | — |
| 5 | 边缘缓存：CloudFront | cdn | Lab 4 | `l2-edge` | 2h | — |
| 6 | 域名与受信 HTTPS（需要域名；没有域名时为选做 Lab） | dns*、tls* | Lab 5 | `l2-edge` | 1.5h | — |
| 7 | Web 应用防护：Nginx 限速 vs WAF | waf | Lab 5 | `l2-edge` | 1h | —（WAF 按 Web ACL 和规则数按月计费） |
| 8 | 用户身份：Cognito | auth、identity-pool | Lab 5 | `l3-identity` | 3h | — |
| 9 | 邮件与通知扇出：SES + SNS | email、notification | Lab 8 | `l3-identity` | 2h | — |
| 10 | 解耦：SQS | queue | Lab 4 | `l4-async` | 1.5h | — |
| 11 | 照片流水线：Lambda 与 Rekognition（扩展：Step Functions） | image-processing、tagging、workflow* | Lab 10 | `l4-async`；扩展 `x-workflow` | 3h | — |
| 12 | 定时任务：EventBridge Scheduler | scheduler | Lab 10 | `l4-async` | 1h | — |
| 13 | 数据保护与配置：KMS + Secrets + Parameter Store | kms、secrets、config | Lab 1 | `l5-security` | 2.5h | —（密钥按月计费） |
| 14 | 自定义 VPC（public 放置） | network | Lab 13 | `l6-data` | 2h | —（public 放置不建 NAT） |
| 15 | 关系数据库：RDS（扩展：RDS Proxy） | database、db-proxy* | Lab 14 | `l6-data`（`--with-optional`） | 3h | database；扩展 db-proxy |
| 16 | 缓存：ElastiCache | cache | Lab 14 | `l6-data` | 2h | cache |
| 17 | Serverless 社交：DynamoDB + API Gateway | social-store、social-api | Lab 8 | `l7-serverless-social` | 3h | — |
| 18 | 点击流：Firehose + S3 + Athena | analytics | Lab 4 | `l6-data` | 1.5h | — |
| 19 | 负载均衡：Nginx vs ALB | load-balancer | Lab 14 | `l8-ha` | 2h | load-balancer |
| 20 | 私有化：network 切换为 private | network（private） | Lab 19 | `l8-ha` | 2h | network（NAT 网关或接口端点） |
| 21 | 弹性伸缩与无状态设计（前置或扩展：黄金 AMI；变体：EFS） | autoscaling、ami*、shared-fs* | Lab 20、Lab 15 | `l8-ha`（`--with-optional`）/ `x-efs-asg` | 3h | autoscaling（多台实例） |
| 22 | 链路追踪：X-Ray | tracing | Lab 3 | `l9-full` | 1.5h | — |
| 23 | 审计与威胁检测：CloudTrail + GuardDuty | audit、threat-detection | Lab 1 | `l9-full` | 2h | — |
| 24 | 备份与灾备：AWS Backup | backup | Lab 15 | `l9-full` | 2h | — |
| 25（选做） | 合规与漏洞：Config + Inspector | compliance*、vuln-scan* | Lab 23 | `l9-full`（`--with-optional`） | 2h | — |

- network 在两个 Lab 中出现：Lab 14 以 public 放置迁入自定义 VPC（必须在任何 VPC 绑定模块之前，DEP-016），Lab 20 在同一 VPC 内切换为 private。network 模块的步骤按 `NETWORK_PLACEMENT` 分成两段，Lab 14 只计 public 段，Lab 20 计 private 段。
- 软前置（`after`）与预计耗时是 UI 的补充字段，写在 `course.yaml` 中；模块集合与档位只能来自总纲。

**学习路线**（`console_settings.track`，在 S00 与 S13 选择）：

| 路线 | 模块集合 | Lab 顺序 | 说明 |
|---|---|---|---|
| 主线 `main` | 上表全部非选做模块 | Lab 0 → 25 | 按档位逐级累加，对应 `profile apply l0-ec2 … l9-full` |
| 重点对比快速路线 `named` | ec2、iam、cost、storage、cdn、database、cache、auth、queue、image-processing（`x-named-comparisons` + cost） | Lab 0、1、4、5、15、16、8、10、11 | 一次完成 Cognito、SQS、CloudFront、Lambda、ElastiCache、S3、RDS 七组有/无对比；留在默认 VPC，跳过 Lab 13 与 Lab 14。database、cache 按小时计费，练完建议回到 `l0-ec2`。快速路线中 Lab 15、16 只做 database、cache 本身（不含 db-proxy，它依赖 secrets） |

切换路线不清除任何进度。路线只决定必做集合、推荐顺序、课程大纲的排列和顶栏的分母。

**模块硬依赖**由注册表的 `requires` 决定，另外加上凭证前提（`credentials: required` 的模块要求 `IAM_CREDENTIALS≠none`，CRED-001）。下表是编写本文时的快照，**以 `modules/registry.yaml` 与总纲 §3.2、§5.2 为准**，控制台运行时会直接读取注册表：

| 模块 | 硬依赖（当前必须处于运行状态） | 前置条件 / 互斥 | 指南附加的软依赖 `learning.after` |
|---|---|---|---|
| ec2 | — | — | — |
| iam | — | — | — |
| cost | — | 人工前置：激活成本分配标签 | — |
| shell-access | iam（必须 role，DEP-001） | — | — |
| logging、monitoring | iam（CRED） | monitoring：确认告警订阅 | — |
| storage | iam（CRED） | 与 shared-fs 互斥（MUTEX-001） | — |
| cdn | —（源站类型条件：DEP-010、014、028） | — | iam、storage（`CDN_MEDIA_ORIGIN=s3` 时） |
| dns | — | 人工前置：域名 | — |
| tls | 域名；ACME 端点不可用时 dns 与 cdn \| load-balancer（DEP-005） | 同 dns | — |
| waf | cdn \| load-balancer（DEP-006） | — | — |
| auth | iam（CRED；子选项条件 DEP-029、031） | 托管登录要求 HTTPS 的 `APP_BASE_URL` | cdn 或 tls |
| identity-pool | iam、storage（s3）、auth（cognito）（DEP-002） | — | — |
| email | iam（CRED） | 人工前置：SES 发件身份 | — |
| notification | iam（CRED） | 人工前置：确认订阅 | — |
| queue、scheduler、tagging | iam（CRED） | scheduler `Target=ssm` 时 DEP-026；tagging `TAGGER_INPUT=s3` 时 DEP-027 | queue：storage |
| image-processing | lambda 档：iam、storage（s3）、可用的回写通道（DEP-003、019～021）；worker 档：`QUEUE_DRIVER≠sync`（DEP-004） | cdn 已启用时固定 `IMAGE_RESULT_CHANNEL=queue`（DEP-020） | queue |
| workflow | iam、storage（s3）、工具链栈（DEP-034） | 与 `IMAGE_PROCESSOR=lambda` 互斥（MUTEX-005） | image-processing |
| kms、secrets、config | iam（CRED） | kms 的 `orderBefore`：storage、database、shared-fs、secrets | — |
| network | public：—；private：入口 + 出网 + 运维通道（DEP-009）；换 VPC 时不得有已部署的 VPC 绑定模块（DEP-016） | — | kms |
| database | — | — | kms、secrets、network（主线） |
| db-proxy | iam、database（RDS）、secrets（secretsmanager）（DEP-032、033） | — | — |
| cache | — | — | kms、network（主线） |
| social-store | iam（CRED） | — | — |
| social-api | proxy 集成档：—；lambda 集成档：iam、social-store（dynamodb）+ 授权器（DEP-022～025） | — | social-store |
| analytics | iam（CRED） | — | storage |
| load-balancer | — | — | network |
| autoscaling | iam（role）、load-balancer、database，以及 storage \| shared-fs（DEP-007、ASG-001～014） | — | cache（ASG-004） |
| shared-fs | — | 与 storage 互斥；按 `x-efs-asg` 变体练习 | — |
| ami | — | 单实例切换会替换实例（走 `rebuild-instance`） | autoscaling |
| tracing | xray 档：iam（CRED） | — | logging |
| audit、threat-detection | — | 已有 trail / detector 时只读接入 | iam（这样相关检查可以自动执行） |
| backup | — | 区域资源类型 opt-in、灾备区域备份库 | storage 或 database |
| compliance | — | 已有配置记录器时只读接入 | audit |
| vuln-scan | iam（必须 role，DEP-035） | — | — |

“当前必须处于运行状态”的含义：依赖模块被清理后，**尚未完成**的下游模块重新变为 `locked`；已完成的下游模块保持完成，只加 `rebuild_needs` 角标；推荐里会附带一句“需要先重建 X（约 N 分钟，是否按小时计费）”。

### 4.13 启停事件与配置漂移

**启停事件怎么采集。** `scripts/module` 在运维机上运行。按总纲 §9.2，它在第 7 步投递配置、第 9 步重启应用、第 10 步做健康探针、第 11 步才更新实例上的 `/etc/cloudalbum/modules.state.json`；disable 流程同样是先删 env、重启，最后才“记录”。因此控制台**不能只在应用启动时比对一次**，否则会读到旧历史。采集方式如下：

1. **进行中操作（pending op）**：`scripts/module` 在第 7 步（投递配置时）先在 `modules.state.json` 的 `pending` 字段写入一条 `{opId, module, action: enable|disable, startedAt}`，第 11 步写入历史并清除 `pending`（附录 B-8，待总纲确认；确认前用第 3 条的宽限期兜底）。
2. **持续监视**：api 用 inotify 监视状态文件，另以 30 秒一次的 mtime 与校验和轮询兜底（网络文件系统或容器中 inotify 不可靠）。文件变化时重新比对历史与 `module_events`，补写新的 `enabled`/`disabled` 事件，`actor` 记为 `scripts/module`。
3. **宽限期**：capabilities 出现“off 且没有 disabled 事件”时，先等待：存在 pending op 时等到它结束；没有 pending op 时等 5 分钟，期间状态文件更新了就按新历史判定。宽限期内显示“状态变化中”，不判漂移。
4. **去重**：每条历史都带唯一的 `opId`，`module_events` 以 `op_id` 唯一去重；没有 opId 的推断事件（例如宽限期过后仍无记录、按漂移处理的 `inferred` 事件）按 `(module_id, type, 发现批次)` 去重。
5. **单点执行**：多实例时由数据库租约（§6.4）保证只有一个实例做比对与补写，其他实例只读结果。
6. capabilities 的状态变化写入总纲已有的 `capability_events` 表。

**启停后的复检**：收到新的 enabled/disabled 事件后，引擎在租约保护下对该模块及其反向依赖的已达成步骤各复检一次（带速率限制，§6.4）。

**判定规则：**

| 情况 | 判定 | 界面处理 |
|---|---|---|
| 有 `disabled` 事件，之后 capabilities 为 `off` | 主动清理 | 已完成的模块变为 `cleaned [z]`；未完成的显示“进行中 · 已停用”；不做漂移检测，也不再自动运行该模块的检查 |
| 存在 pending op，或 off 的宽限期未过 | 状态变化中 | 显示“状态变化中”，不判漂移 |
| 没有 `disabled` 事件，但已达成步骤的某项**仍然适用**的必需检查变为 `fail` | **漂移** | 步骤显示 `[!]`，模块加 `drifted` 标记，出现横幅，推荐规则 2 生效 |
| 检查变为不适用：`supersededWhen` 成立（例如 `env.cdn.CDN_ORIGIN_TYPE == 'alb'` 之后的 `eip-associated`），或 `when` 不成立 | **被取代**，不算漂移 | 检查显示 `[^] 被 Lab 19 取代`，步骤保持已达成 |
| 没有 `disabled` 事件，capabilities 变为 `error` | **漂移**（运行故障） | 同漂移，detail 中显示 capabilities 的说明 |
| 宽限期过后仍没有 `disabled` 事件，env 文件消失导致状态为 `off` | **漂移**（配置被手动改动） | 同漂移，修复建议为 `scripts/module status <id> --repair`（总纲 CFG-004） |
| capabilities 为 `degraded` 超过 10 分钟 | 降级，不算漂移 | 显示黄色角标 |

**漂移处理流程：**
1. **只标记，不撤销。** `completed_at` 和完成度都保留；顶栏浮层的“异常”计数加 1。
2. **给出对比证据。** 检查详情中并排显示“上次通过时的证据”和“现在的证据”，并高亮差异字段。
3. **给出修复路径。** 匹配常见错误（`pitfalls`），提供“跳回第 k 步第 j 小步”（自动切到控制台做法并高亮该小步）和“再测一次”。
4. **允许有意为之。** 学员可以点“我是有意改动的（24 小时内不提醒）”，例如为了做故障演练而临时关闭 BPA。这会在 `module_progress.drift_ack_until` 中记录时间。确认期间不显示横幅，但徽章仍然是 `[!]`。
5. **复测通过后自动解除。** 修复后再测一次，结果为 `pass` 时漂移标记自动消失，时间线记一笔“已恢复”。

### 4.14 新鲜度与失效

| 来源 | 新鲜期（TTL） | 进入页面时自动重测 | 失效事件（命中后结果立即标记为过期） |
|---|---|---|---|
| ① 本地检查 | 1h | 上次检测超过 10 分钟就重测 | 模块 env 文件的校验和变化；driver 变化；guide 中该检查定义的哈希变化；执行它的实例被替换（`instanceScope: all` 时） |
| ①′ 浏览器回传 | 1h | 不自动重测（需要学员的浏览器在场） | 同 ① |
| ② 能力探针 | 5min | 每次都重测（开销很小） | 同 ① |
| ③ AWS 只读 | 24h | 上次检测超过 1 小时，且检测能力不为 `local` 时重测 | 同 ①；Verifier 策略版本变化 |
| ④ 对比实验 | 不过期 | — | 最后一档之后 env 校验和变化时，只加“可能过期”标记，不影响完成 |
| ⑤ 手动确认 | 不过期 | — | 凭证从无到有时自动复核（§4.8） |

- 过期的 `pass` 仍然算作已达成，只显示“·过期”；过期的 `fail` 仍然算作失败。
- 打开页面时只自动重测“当前可见的模块”；“复核全部”需要手动触发，并且有速率限制（§6.4）；检测能力为“仅本地”时“复核全部”禁用。

### 4.15 指南版本升级

每个 `guides/<id>.yaml` 都有语义化版本号 `version`。

| 变化 | 影响 |
|---|---|
| 修订号或次版本号变化（文案、常见错误、SAA 提示、新增变体分支） | 无 |
| 主版本号变化：某项检查的定义哈希变了 | 该检查的结果标记为过期；进入页面时自动重测 |
| 主版本号变化：新增了必需步骤 | 未完成的模块直接把新步骤计入分母。已完成的模块**保留完成状态**，加 `guide_updated` 角标，新步骤显示为“新增 · 可选补做”，推荐会以低优先级提示补做。理由：不能因为内容更新而让进度倒退 |
| 删除步骤或检查 | 已达成的记录保留在历史中，不再计入分母 |

结果迁移按 `stepId` 和 `checkId` 对应。证据中保存着 `guide_version` 和 `check_hash`，便于追溯。

### 4.16 状态转移

```mermaid
stateDiagram-v2
    direction LR
    state "步骤" as S {
      [*] --> locked: 模块未解锁
      [*] --> available
      locked --> available: 依赖满足（仅未达成的步骤）
      available --> verifying: 运行检测
      verifying --> done: 适用的必需检查全部 pass
      verifying --> done_manual: 含手动确认
      verifying --> failed: 有 fail
      verifying --> needs_manual: 只剩 unavailable / manual_pending
      verifying --> error: 检测器出错
      failed --> verifying: 再测一次
      error --> verifying: 重试
      needs_manual --> done_manual: 填写看到的值并确认
      done_manual --> done: 凭证可用，复核通过
      done_manual --> drifted: 复核冲突
      done --> drifted: 之前通过，现在 fail（检查仍适用）
      drifted --> done: 修复后复测通过
      done --> cleaned: 模块被禁用（有 disabled 事件）
      cleaned --> done: 模块重新启用并复测通过
    }
```

```mermaid
stateDiagram-v2
    direction LR
    state "模块生命周期" as M {
      [*] --> locked
      locked --> available: 硬依赖满足
      available --> locked: 依赖被清理（从未完成）
      available --> in_progress: 第一个步骤达成
      in_progress --> verifying: 配置步骤和 wire 步骤全部达成
      verifying --> done: 第一档与最后一档有效，且全自动
      verifying --> done_manual: 第一档与最后一档有效，但含手动
      done_manual --> done: 复核升级
      done --> cleaned: disabled 事件，且状态为 off
      done_manual --> cleaned: disabled 事件，且状态为 off
      cleaned --> done: 重新启用（completed_at 保留）
    }
```

已完成或已清理的模块在依赖被清理时**不会**回到 `locked`，只加 `rebuild_needs` 角标。

---
## 5. 配置指南内容模型

### 5.1 文件与职责

配置指南完全由数据驱动：前端只负责渲染，后端负责解析、代入变量和执行检查。同一份事实只在一个地方定义：

| 文件 | 职责 | 谁读 | 与总纲的关系 |
|---|---|---|---|
| `modules/registry.yaml` | 模块元数据，包括机能、主服务、类型、开关、硬依赖、互斥、旁路键、是否按小时计费、`lab.compare`、实验清单、徽章文案、`doc` 锚点 | 后端、`scripts/module`、实验运行器、控制台 | 总纲 §3.4 定义的**单一事实来源**。指南**不得**重复这些字段 |
| `profiles/*.env` | 档位、变体与覆盖层 | `scripts/module`、控制台（档位徽章，§3.4.2） | 总纲 §10.1–10.2，原样读取 |
| `course.yaml` | Lab 编排：Lab 编号、模块集合与档位**照抄总纲 §10.3**；另加痛点故事、学习目标、软前置、预计耗时、选做规则、题库路径、学习路线定义 | 控制台 | 本文新增；CI 比对总纲（§4.12） |
| `guides/<id>.yaml` | 一个模块的学习内容：步骤、做法、检查、常见错误、SAA 提示、对比设计、考点、清理 | 控制台 | 本文新增；内容与 `docs/modules/0N-<group>.md#<id>` 对应 |
| `guides/_schema.json` | 指南的 JSON Schema，由 zod 生成 | lint、后端启动校验 | 本文新增 |
| `guides/_probe-fixtures/<service>.<action>.json` | 每个只读 action 的示例响应，lint 用它对断言做模拟评估（§5.11） | lint | 本文新增 |
| `/etc/cloudalbum/cost-rates.yaml`（实例上，学员维护） | 计费维度的单价与 `asOf` 日期 | cost 模块、控制台费用页 | 总纲 §2.4 与 cost 模块定义，**唯一的价格来源**。仓库不内置价格；S11 提供“生成模板”命令（只列计费维度，单价留空），学员从官方定价页抄录。文件不存在时界面不显示金额 |
| `console/topology.yaml` | 架构图的节点坐标、框、本地芯片和连线规则 | 控制台 S07 | 取代总纲 §8.1 `ArchDiagram` 中写死的布局 |
| `quizzes/lab-<n>.yaml`（可选） | Lab 级的综合题 | 控制台 S04 | 本文新增 |
| `experiments/<id>/experiment.json` | 实验场景、档位（stages）与有效性前提 | 实验运行器、控制台 | 总纲 §8.2，原样沿用 |

所有 YAML 都用安全模式加载：不允许自定义标签，不允许锚点合并超过 1 层，单文件不超过 256 KB。

### 5.2 `course.yaml`

```ts
// packages/contracts/src/course.ts
export interface Course {
  version: string;
  source: { doc: 'docs/modular-design.md'; section: '10.3'; revision: string };  // 照抄的总纲版本，CI 比对
  labs: Lab[];
  tracks: Track[];
}
export interface Lab {
  n: number;                      // Lab 编号，取自总纲 §10.3（当前 0–25）。不使用固定枚举
  title: string;                  // “边缘缓存：CloudFront”
  profiles: string[];             // 总纲中的档位文件名，例如 ['l2-edge']、['l0-ec2','l0-plus-local-tiers']、['l8-ha','x-efs-asg']；不使用 L0–L7 枚举
  optional?: boolean | { when: string; reason: string };   // 选做 Lab：Lab 25；Lab 6 为 { when: '!profile.hasDomain' }
  story: string;                  // 痛点故事，2–4 句话，Markdown
  goals: { text: string; domain: SaaDomain; relatesTo?: string /* <moduleId>.<stepId> */ }[];
  after?: number[];               // 软前置 Lab（UI 补充字段）
  estHours: number;               // UI 补充字段
  modules: {
    id: ModuleId;
    optional?: boolean | { when: string; reason: string };   // 表达式见 §5.6
    kind?: 'core' | 'extension' | 'variant';                  // extension：db-proxy、workflow、ami；variant：shared-fs
    part?: string;                // 同一模块在多个 Lab 出现时的分段，例如 network 的 'public' / 'private'
    note?: string;
  }[];
  steps?: GuideStep[];            // 只有“没有模块”的 Lab 使用（当前课程没有），结构同 §5.3
  quiz?: string;                  // quizzes/lab-5.yaml
}
export interface Track {
  id: string;                     // 'main' | 'named'
  title: string;                  // '主线' | '重点对比快速路线'
  profile?: string;               // 'x-named-comparisons'
  extraModules?: ModuleId[];      // 变体之外追加的模块，例如 cost
  labs: number[];                 // 推荐顺序
  note?: string;
}
export type SaaDomain = 'secure' | 'resilient' | 'performance' | 'cost';
```

```yaml
# course.yaml（节选）
version: 2.0.0
source: { doc: docs/modular-design.md, section: '10.3', revision: '2026-10-13 第 2 轮' }
labs:
  - n: 5
    title: 边缘缓存：CloudFront
    profiles: [l2-edge]
    story: |
      大阪的朋友打开你的相册，每张缩略图都要从东京这台 EC2 的 Nginx 读一次 EBS 再传过去，
      首页要等将近两秒。照片已经在 S3 里了，可浏览器还是绕道 EC2 去取。
    goals:
      - { text: 理解缓存策略（缓存键）与源请求策略（回源带什么）的区别, domain: performance, relatesTo: cdn.behaviors }
      - { text: 用 CloudFront 前缀列表与自定义头保护源站, domain: secure, relatesTo: cdn.create-distribution }
      - { text: 用 OAC 让 CloudFront 读取私有的 S3 媒体桶, domain: secure, relatesTo: cdn.media-origin }
    after: [4]
    estHours: 2
    modules:
      - { id: cdn }
    quiz: quizzes/lab-5.yaml
  - n: 6
    title: 域名与受信 HTTPS
    profiles: [l2-edge]
    optional: { when: '!profile.hasDomain', reason: 需要域名 }
    after: [5]
    estHours: 1.5
    modules:
      - { id: dns, optional: { when: '!profile.hasDomain', reason: 需要域名 } }
      - { id: tls, optional: { when: '!profile.hasDomain', reason: 需要域名 } }
tracks:
  - { id: main, title: 主线, labs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] }
  - id: named
    title: 重点对比快速路线
    profile: x-named-comparisons
    extraModules: [cost]
    labs: [0, 1, 4, 5, 15, 16, 8, 10, 11]
    note: 一次完成七组有/无对比；留在默认 VPC；database、cache 按小时计费，练完回到 l0-ec2
```

### 5.3 `guides/<id>.yaml` 的 Schema

以下 TypeScript 类型是规范定义：用 zod 实现，再由 `npm run guides:lint` 生成 `guides/_schema.json`。

```ts
// packages/contracts/src/guide.ts
import type { ModuleId, SaaDomain } from './index';

export interface Guide {
  id: ModuleId;                   // 必须存在于 registry.yaml
  version: string;                // semver；主版本号变化的影响见 §4.15
  title: string;                  // “边缘缓存：EC2 直出 → CloudFront”
  intro: {
    without: string;              // 没有它时：一句话
    with: string;                 // 有它时：一句话
    why: string;                  // 为什么现在学它（与课程位置相关）
  };
  learning?: {
    after?: ModuleId[];           // 软依赖：只影响推荐排序与提示
    estMinutes: number;
    focus?: boolean;              // 用户点名的重点对比模块
  };
  variants?: VariantDecl[];       // 同一模块按 env 子选项分支，例如 cdn 的源站类型
  map?: MapDecl;                  // 本模块对架构图的影响
  variables?: Record<string, VariableDecl>;
  steps: GuideStep[];
  compare: CompareDecl;
  exam: ExamDecl;
  cleanup: CleanupDecl;
}

export interface VariantDecl {
  id: string;                     // 'media-s3'
  when: string;                   // 表达式，例如 "env.cdn.CDN_MEDIA_ORIGIN == 's3'"
  label: string;                  // 界面上的说明：“媒体走 S3（storage 已启用，l2-edge 默认）”
  lab?: number;                   // 哪个 Lab 会切到这个分支，用于“被 Lab N 取代”的文案
}

export interface MapDecl {
  chip: string;                   // EC2 内的本地芯片 id（topology.yaml）
  node: string;                   // 启用后点亮的 AWS 节点 id
  edgesAfter?: string[];          // 'browser->cloudfront'
  edgesRemoved?: string[];
}

export interface VariableDecl {
  label: string;
  from: 'input' | 'imds' | 'cap' | 'env' | 'derived' | 'profile';
  key?: string;                   // from=cap: 'cdn.data.distributionId'；from=env: 'cdn.CDN_BASE_URL'
  fillFrom?: string;              // 有值时优先采用（例如接入应用后从 cap 读取，不再需要学员输入）
  snapshot?: boolean;             // 默认 true：wire 达成与每次 enable 事件时，把 fillFrom 解析出的值固化到 guide_variables（source='snapshot'），供 disable 之后的清理验证使用
  list?: boolean;                 // 值是空格分隔的列表（例如 sgIds）；代入命令时逐项转义
  pattern?: string;               // RE2。from='input' 时必填（lint 强制）；导入进度时也按它重新校验
  example?: string;
  help?: string;
  secret?: false;                 // 只能是 false：密钥永远不能成为模板变量（lint 强制）
}

export type StepType = 'experiment' | 'config' | 'wire' | 'code' | 'manual' | 'read';
export type RunsOn = 'ops' | 'ec2' | 'browser' | 'cloudshell';
// ops = 运维机（你的电脑或 CloudShell，部署者身份）；ec2 = 实例上（SSH 或 Session Manager）；cloudshell 只在必须用 CloudShell 时单独标注

export interface GuideStep {
  id: string;                     // kebab-case，模块内唯一；URL 中使用
  type: StepType;
  title: string;
  why?: string;                   // 1–2 句话，说明为什么要做这一步
  estMinutes?: number;
  optional?: boolean | { when: string; reason: string };   // when 为表达式，§5.6
  when?: string;                  // 表达式为假时步骤 skipped（不计入分母）。例如 media-origin 步骤：driver.storage == 's3'
  variant?: string;               // 只属于某个 VariantDecl 的步骤
  localTier?: boolean;            // 本地档准备步骤（例如 QUEUE_DRIVER=memory）：允许排在基线之前或两档实验之间（§5.4）
  requires?: { runtime?: string };   // §5.6 表达式，例如 "runtime.load-balancer && (runtime.storage || runtime.shared-fs)"
  impact?: {                      // 执行前界面弹出页内确认条，写明影响
    logout?: boolean;             // 会让所有会话失效（auth 的 wire）
    restartApp?: boolean;         // 会重启 api 与 worker（多数 wire）
    replacesInstance?: boolean;   // 会替换实例：network 迁移、ami 切换、iam 实例配置文件变更、autoscaling 的 wire（替换正在运行控制台的实例）
    readOnlyWindowMinutes?: number;   // 数据迁移的只读窗口
    note?: string;
  };
  startsBilling?: { class: 'hourly' | 'fixed-monthly' | 'usage'; rateKeys: string[]; note?: string };   // rateKeys 指向 cost-rates.yaml 的计费维度
  waitHint?: { typicalMinutes: number; maxMinutes: number; text: string };
  stage?: string;                 // 仅 type=experiment：CompareDecl.stages 中的 label，例如 'before'、'memory'、'after'
  experiment?: string;            // 仅 type=experiment：experiment.json 中的 id
  methods?: {
    console?: ConsoleMethod;
    cli?: CliMethod;
    script?: ScriptMethod;
    code?: CodeMethod;
  };
  defaultMethod?: keyof NonNullable<GuideStep['methods']>;
  expected: { text: string; sample?: string };   // 预期结果与示例输出
  checks: CheckDecl[];            // type=read 时可为空
  pitfalls?: Pitfall[];
  saa?: SaaTip[];
  mapDelta?: { chipOut?: string; nodeOn?: string; edgeAdd?: string[]; edgeRemove?: string[]; caption: string };
  readWhileWaiting?: string;      // 等待型步骤右栏的“等待时读一读”（Markdown）
}

export interface ConsoleMethod {
  region: 'app' | 'us-east-1' | 'global';   // 语义见 §5.5
  regionReason?: string;          // region='us-east-1' 时必填：为什么必须切到 us-east-1
  breadcrumb: string[];           // ['CloudFront', '分配', '创建分配']
  deepLink?: string;              // 模板：'https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions/create'
  instructions: string[];         // 每条一小步，Markdown；可以引用 {{var}}
  fields?: { name: string; value: string; why?: string }[];   // 关键字段表
  tagsRequired?: boolean;         // 要求打 Project/Env/Module/ManagedBy=manual 标签（默认 true）
}
export interface CliMethod {
  runsOn: RunsOn;
  commands: Command[];
}
export interface ScriptMethod {
  runsOn: RunsOn;                 // 多数为 ops；自建档的安装脚本（valkey、pg）与 cli.js migrate-module 为 ec2
  command: string;                // 'scripts/module enable cdn'
  preview?: string;               // 'scripts/module enable cdn --dry-run'
  creates: string[];              // 人能读懂的资源清单
  completesSteps?: string[];      // 一键脚本会同时满足哪些步骤（UI 用于提示“脚本已完成此步，点检测确认”）
}
export interface CodeMethod {
  files: { path: string; lang: string; snippet: string; explain: string[] }[];
  restart?: Command;
}
export interface Command {
  run: string;                    // 模板字符串；变量不得写在引号内部（§5.6）
  runsOn?: RunsOn;                // 覆盖 CliMethod.runsOn
  explain?: string;
  expectOutput?: string;          // 示例输出
  dangerous?: boolean;            // 删除类命令：UI 显示红色左边框，第一次点“复制”时在命令块内展开确认条
  dangerNote?: string;            // dangerous 时必填：“将删除 CloudFront 分配，重建约 15 分钟”
}

export interface Pitfall {
  id: string;
  symptom: string;                // 学员看到的现象
  match: {                        // 全部条件同时满足才算命中；按 weight 降序排列
    check?: string;               // 检查 id
    result?: 'fail' | 'error' | 'pending';
    errorCode?: string;           // §6.9 的统一错误码，或 AWS 错误码
    field?: string;               // 断言路径
    actual?: unknown;
    evidenceRegex?: string;       // 对已脱敏的证据文本做匹配（RE2，≤200 字符）
    sinceStepStartMinutes?: { lt?: number; gt?: number };
  };
  cause: string;
  fix: {
    text: string;
    command?: Command;
    gotoStep?: string;
    gotoSub?: number;             // 跳到该步骤控制台做法的第 k 小步（自动切到控制台做法并高亮）
    action?: 'poll' | 'open-console' | 'rerun';
  };
  weight?: number;                // 默认 1
}
export interface SaaTip { domain: SaaDomain; text: string; confusable?: string }

export interface CompareDecl {
  required: boolean;              // 默认 true；ec2 为 false
  kind: 'metric' | 'phenomenon';  // 对应 registry lab.compare：runtime-ab/before-after → metric；functional/fault → phenomenon
  experiment?: string;            // kind=metric：experiment.json 的 id
  stages: StageDecl[];            // 至少 2 档；第一档为基线，最后一档为目标。完成判定只看首尾两档（§4.7）
  evidence: 'server' | 'client';  // server：LabMetricsStore 按 runId 的路径签名；client：运行器记录的响应头（边缘模块，如 cdn）
  runners: ('cli' | 'browser')[]; // 允许的运行器；cli = npm run exp --upload；browser 的结果只作参考
  liveCompare: {
    mode: 'bypass-header' | 'dual-url' | 'none';
    bypassKey?: string;
    request?: { method: 'GET' | 'POST'; path: string };   // 只能是 registry 旁路白名单中的路由；POST 使用 _probe 数据，事后清理
    reason?: string;
  };
  metrics: MetricDecl[];          // 指标展示顺序与“好坏方向”
  phenomenon?: { action: string; observe: CheckDecl[] };   // kind=phenomenon
  explain: string;                // 解读模板（Markdown，可引用 {{metrics.<id>}}）
}
export interface StageDecl {
  label: string;                  // 'before' | 'memory' | 'worker-sqs' | 'after' ……，运行器用 --label <label>
  title: string;                  // “同步处理（基线）”
  drivers: Record<ModuleId, string[]>;   // 本档要求的驱动模式，例如 { queue: ['sqs'] }、{ image-processing: ['worker'], queue: ['memory'] }
  validity: {
    segment: string;              // 路径段名，例如 'cache'、'entry'
    pattern: string[];            // 本档的期望模式，例如 ['none', 'memory*']、['redis@elasticache:*']
    byTarget?: Record<string, { segment: string; pattern: string[] }>;   // 客户端证据按目标分组，例如 { direct: {segment:'entry', pattern:['nginx']}, cdn: {segment:'entry', pattern:['cloudfront>*']} }
    distinct?: { segment: string; min: number };   // 例如 autoscaling 的 { segment: 'inst', min: 2 }
    minRatio?: number;            // 默认 0.95
    minSamples?: number;          // 默认 100
  };
}
export interface MetricDecl {
  id: string; label: string;
  unit: 'ms' | '%' | 'count' | 'bytes' | 's' | 'usd/h';
  source: string;                 // 结果 JSON 路径，如 'client.latencyMs./media/*.p95'、'server.host.netTxBytes'
  better: 'lower' | 'higher' | 'neutral';
  requiresAws?: boolean;          // 需要 CloudWatch 时，无凭证则显示“已省略”
}
export interface ExamDecl {
  points: { title: string; body: string; domain: SaaDomain; relatesTo?: string }[];
  confusables?: { a: string; b: string; rule: string }[];
  quiz?: { id: string; domain: SaaDomain; stem: string; options: string[]; answer: number | number[]; explain: string; relatesTo?: string }[];
}
export interface CleanupDecl {
  commands: Command[];            // 默认 runsOn ops；删除类命令必须 dangerous: true 并写 dangerNote
  choices?: { id: string; label: string; options: { value: string; label: string; effect: string }[]; default: string }[];
  dataRisk: string[];
  manual?: ManualSpec[];          // 手动创建、被接管的资源，disable 不会删除
  verify: CheckDecl[];            // 引用的变量优先取快照值（VariableDecl.snapshot），界面注明“取自 10/13 启用时的记录”
  reEnableMinutes?: number;       // 重建大约需要多久（显示在费用页）
}
```

`CheckDecl` 与 `ManualSpec` 的定义见 §5.7。

### 5.4 固定节奏与步骤类型

每个模块的步骤按以下骨架排列，lint 会强制校验：

```text
（可选）    type=config localTier=true     切到本地档的准备步骤（例如 IMAGE_PROCESSOR=worker），允许排在基线之前
步骤 0      type=experiment stage=<第一档>  记录基线（启用之前，通常 stage=before）
（可选）    localTier 步骤 + type=experiment stage=<中间档>   多档模块的中间档（例如 queue 的 memory），选做
步骤 1…k    type=config | code | manual | read   接入前的配置（至少 1 个 config）
步骤 k+1    type=wire                      接入应用：scripts/module enable <id>（每个模块恰好一个）
步骤 k+2…n  type=config | code | manual | read   必须在已接入的环境中才能验证的配置（例如 cdn 的缓存行为）
步骤 n+1    type=experiment stage=<最后一档>  记录目标档（通常 stage=after），是最后一个必做步骤
（之后）    optional: true 的加固步骤        会改变实验条件的可选加固，例如 cdn 的 lock-direct（收紧直连后 after 的直连一路会被拦截），只能排在最后一档之后
（随后）    考点标签页                      不算步骤，不计入分母
```

lint 规则：除 `localTier` 步骤外，第一个步骤必须是第一档实验；实验步骤按 `stages` 顺序出现；恰好一个 wire；最后一个必做步骤必须是最后一档实验，它之后只允许 `optional` 步骤；`localTier` 步骤只能是 `type: config`。

| 类型 | 含义 | 计入分母 | 必填字段 | 例子 |
|---|---|---|---|---|
| `experiment` | 记录某一档。点“检测”时检查 `experiment_runs` 中是否有该档的有效记录 | 首尾两档是；中间档是选做 | `stage`、`experiment`，`checks` 中有 1 个 experiment 检查 | 记录基线 |
| `config` | 在 AWS 中创建或修改资源；`localTier: true` 时是在实例上切换本地档 | 是 | `methods.console` 与 `methods.cli` 至少有一个；建议同时提供 `script` | 创建分配 |
| `wire` | 接入应用：在运维机上执行 `scripts/module enable <id>`，由它写 env、重启应用并检查探针 | 是，**每个模块恰好一个** | `methods.script`；`checks` 至少包含 capability 检查和一项实际流量证据（`http-header`、`path-seen`、`session` 或感知器，§4.5）；声明 `impact` | 接入应用 |
| `code` | 读懂或修改仓库代码 / 模板 | 有检查时计入 | `methods.code` | 读懂 cache-aside 的实现 |
| `manual` | 只能人工确认的事项 | 是 | `checks` 中有 manual 检查 | 收到 Budgets 测试邮件 |
| `read` | 纯阅读 | 否（点“已读”只记录时间） | — | 原理说明 |

**两条做法路线，检查完全相同。**

- **路线 M：先手动，再接管**（控制台优先，首次推荐，沿用 labs.md“先在控制台手动做一遍”的节奏）
  1. 学员在控制台或用 CLI 手动建好资源，并按约定打上标签 `Project=CloudAlbum`、`Env=<env>`、`Module=<id>`、`ManagedBy=manual`。
  2. 在 wire 步骤中执行 `scripts/module enable <id> --param Existing<Res>Id=<id>`。模块栈不再新建该资源，只创建策略和辅助资源，然后写入 env（附录 B-3）。
  3. 清理时，这些手动资源要按 `cleanup.manual` 手动删除。
- **路线 S：直接用脚本**
  1. 学员在第一个 config 步骤直接选择“一键脚本”，执行 `scripts/module enable <id>`。
  2. 脚本一次满足 `completesSteps` 中列出的全部步骤。
  3. 之后的 config 步骤变成“核对”：读懂模板片段（code 做法），然后点“检测”确认。

两条路线最终验证的都是**同一组资源**：接入应用之后，变量从 `cap`/`env` 中读取，不再使用学员输入的值。wire 达成时以及之后每次 enable 事件，引擎把这些值固化为快照（`guide_variables.source='snapshot'`）。disable 会删除 `modules.d/<id>.env`，路线 S 的学员也从未手动填写过资源 ID，清理验证因此优先使用快照值。界面会记录学员走的是哪条路线，并显示“·脚本”标签，但这不影响判定。

### 5.5 做法与运行位置

| 做法 Tab | 显示内容 | 运行位置标签 |
|---|---|---|
| 控制台 | 面包屑（例如 `CloudFront › 分配 › 创建分配`）、带区域参数的深链接、编号的小步骤、关键字段表（填什么、为什么）、必须打的标签 | 浏览器（AWS 控制台） |
| CLI | 已代入变量的命令块，每块都有复制按钮，并附示例输出 | 运维机 / EC2 / CloudShell |
| 一键脚本 | 先显示变更预览（`--dry-run`）：栈名、会创建的资源、是否开始按小时计费、需要附加的策略；然后是命令 | 运维机（自建档的安装脚本为 EC2） |
| 代码 | 文件路径、代码或模板片段、逐行讲解；如有重启命令，执行后自动轮询 capabilities，直到 driver 切换完成（最长 120 秒） | EC2 |

- 默认显示哪个做法，由学习路线偏好决定（S13）：控制台优先 / CLI 优先 / 脚本快速通道。
- 选择“控制台优先”时，脚本 Tab 上方会提示：“建议先手动做一遍，再用脚本重建一次。”
- **控制台区域提示**按 `ConsoleMethod.region` 区分三种情况：
  - `global`（IAM、Budgets、根账号设置、Route 53 托管区域、CloudFront 分配本身）：不需要切换区域，**不显示提示**；深链接不带区域参数。
  - `us-east-1`：必须切换区域，提示写明原因（取自 `regionReason`），例如“CloudFront 使用的 ACM 证书必须在 us-east-1 申请”“CLOUDFRONT 范围的 Web ACL 必须在 us-east-1 创建”。深链接带 `region=us-east-1`。
  - `app`：显示应用所在区域，例如“在 ap-northeast-1（东京）中操作”，深链接带该区域。S3 桶、RDS、ElastiCache、SQS、Lambda、Cognito 都属于 `app`。
- 步骤声明了 `impact` 时，步骤卡顶部始终显示 `ImpactNotice`（重启、只读窗口、登出、替换实例）。其中 `logout` 或 `replacesInstance` 的步骤，复制命令前在命令块内展开确认条（与删除类命令同一机制，不使用浏览器的 `confirm()`），例如“执行前确认：执行后所有会话失效，你会被登出（应急登录：cli.js console:login-link）”。

### 5.6 模板变量与表达式

| 变量 | 来源 | 示例 |
|---|---|---|
| `{{region}}` | `AWS_REGION`（`/etc/cloudalbum/cloudalbum.env`），并与 IMDS 中的 placement/region 交叉校验 | `ap-northeast-1` |
| `{{accountId}}` | IMDS 动态数据 `instance-identity/document`（不需要凭证） | `123456789012`（报告中默认打码） |
| `{{instanceId}}` `{{az}}` `{{instanceType}}` | IMDS | `i-0abc123…` |
| `{{publicIp}}` `{{publicDns}}` `{{privateIp}}` | IMDS `public-ipv4`、`public-hostname`、`local-ipv4` | `ec2-54-12-34-56.ap-northeast-1.compute.amazonaws.com` |
| `{{baseSgId}}` | 实例的基础安全组：在 IMDS `network/interfaces/macs/<mac>/security-group-ids` 返回的列表中，选组名为 `cloudalbum-<env>-ec2-sg` 的那个（名称经 `ec2:DescribeSecurityGroups` 或基础栈输出 `InfoBaseSecurityGroupId` 确认；没有凭证时取基础栈输出写入 cloudalbum.env 的值） | `sg-0aa41c7e9b2d3f581` |
| `{{sgIds}}` | 实例上挂的**全部**安全组（列表变量）。cdn 通过 `ExtraSecurityGroupIds` 挂上第二个组之后，这里会有多个 ID | `sg-0aa41c7e9b2d3f581 sg-07c1d2e3f4a5b6c7d` |
| `{{appBaseUrl}}` | 应用配置 | `http://54.12.34.56` |
| `{{env}}` | 实例上 `/etc/cloudalbum/cloudalbum.env` 的 `CLOUDALBUM_ENV`（运维机上的 `.cloudalbum/state.json` 在实例上读不到），默认 `lab` | `lab` |
| `{{cap.<module>.<path>}}` | 管理员视图的 `/api/capabilities` | `{{cap.cdn.public.baseUrl}}` |
| `{{envfile.<module>.<KEY>}}` | `modules.d/<id>.env` 中的**非密钥**键 | `{{envfile.storage.STORAGE_S3_MEDIA_BUCKET}}` |
| `{{var.<name>}}` | 指南声明的变量（`input` / `derived` 等）；有快照时清理验证取快照值 | `{{var.distributionId}}` |
| `{{sample.<name>}}` | 检测引擎临时生成的探测样本，由代码中的白名单定义 | `{{sample.assetPath}}`（一个带哈希的 JS 文件名）、`{{sample.privateMediaPath}}`（`_probe` 私有图片的路径，带 `exp`/`sig`）、`{{sample.nonce}}`（每次检测生成的随机串） |
| `{{profile.domain}}` | 学习路线偏好 | `album.example.com` |

- **未解析的变量**：命令块中显示为红色虚线框占位 `‹分配 ID›`。复制按钮带 `(!)` 标记，点击后先提示“有 1 个变量未填写”，并定位到变量面板。
- **密钥**：键名匹配 `/(SECRET|PASSWORD|TOKEN|PRIVATE|_KEY)$/i` 的值永远不能成为变量，lint 拒绝。界面上一律显示 `‹secret: 在实例上读取›`，并附读取命令。
- **防注入**（变量值会被代入学员在运维机上执行的命令，运维机持有部署者权限）：
  1. `from: input` 的变量必须声明 `pattern`（lint 强制），保存时和**导入进度文件时**都按它校验，不合法的值丢弃并提示。
  2. CommandBlock 代入任何变量时都做 shell 转义：值只含安全字符 `[A-Za-z0-9._:/@=,+~-]` 时原样代入，否则用单引号包裹（值中的 `'` 写成 `'\''`）；列表变量逐项转义后用空格连接。
  3. 指南作者不得把变量写在引号内部（lint 拒绝 `'…{{…}}…'` 与 `"…{{…}}…"` 形式）；JSON 参数用 `--cli-input-json` 文件或 `jq -n --arg` 生成。
  4. `http-header` 检查的地址用 `new URL(path, origin)` 构造，构造后断言 `url.origin` 等于 target 解析出的 origin；渲染后的 `path` 必须以单个 `/` 开头，不能以 `//` 开头，不能含 `@`、`\`、换行。
- **表达式**：用于 `when`、`supersededWhen`、`optional.when`、`requires.runtime`、`VariantDecl.when`，只允许以下语法，用一个自写的小解析器求值，**不使用** `eval`：
  - `profile.hasDomain`、`profile.track == 'named'`
  - `runtime.<id>`（模块处于运行状态）
  - `done.<id>`
  - `driver.<id> == '<v>'`
  - `env.<module>.<KEY> == '<v>'`、`env.<module>.<KEY> != '<v>'`：模块 env 文件中的**非密钥**键，例如 `env.cdn.CDN_ORIGIN_TYPE == 'alb'`、`env.cdn.CDN_MEDIA_ORIGIN == 's3'`、`env.auth.COGNITO_LOGIN_MODE == 'managed'`、`env.image-processing.IMAGE_RESULT_CHANNEL == 'queue'`；键不存在时取空串
  - `cap.<module>.<path> == '<v>'`：capabilities 中的字段，例如 `cap.network.data.placement == 'private'`
  - 运算符 `!`、`&&`、`||`、`==`、`!=`、括号
  - lint 校验表达式中出现的模块 id 存在于 registry、`env` 键属于该模块的 `ownsEnv` 且不是机密类键

### 5.7 检查类型

所有检查都继承以下公共字段：

```ts
interface CheckBase {
  id: string;                     // 步骤内唯一；全局 ID = <module>.<stepId>.<id>
  title: string;                  // “响应头含 X-Amz-Cf-Id”
  required?: boolean;             // 默认 true
  when?: string;                  // §5.6 表达式；为假时 skipped
  supersededWhen?: { expr: string; byLab: number; text?: string };   // 成立时 skipped（显示“被 Lab N 取代”），不算漂移
  instanceScope?: 'any' | 'all' | 'serving';   // 多实例时在哪台执行（§6.2）。默认：local/capability 为 serving，其余为 any
  waitable?: boolean;             // pending 时自动轮询（§6.5）
  timeoutMs?: number;             // 默认 10000，上限 30000
  ttl?: string;                   // 覆盖 §4.14 的默认新鲜期，例如 '6h'
  explain?: string;               // 一句话说明判定逻辑（检查详情中显示）
  reproduce: Command;             // 必填（lint 强制）：学员可以自己执行的等价只读命令，附运行位置
  saaDomain?: SaaDomain;
}
type CheckDecl = LocalCheck | HttpHeaderCheck | PathSeenCheck | SessionCheck | CapabilityCheck
               | AwsReadonlyCheck | ExperimentCheck | ManualCheck;
```

`reproduce` 对除 `manual`、`experiment` 外的所有检查都是必填项；检查详情抽屉只显示检查自己声明的复现命令，不使用任何兜底示例。例如 cache 的路径检查：`curl -s -D - -o /dev/null https://{{cdnDomain}}/api/feed | grep -i x-cloudalbum-path`（运维机，需要管理员会话 Cookie；或在实例上带探测令牌请求 `/api/console/probe/now`）。

| 类型 | 来源 | 参数 | 执行位置 | 安全约束 |
|---|---|---|---|---|
| `local` | ① | `probe` 取值见下表，`params` 必须符合该 probe 的 schema，`assert[]` | EC2 后端 | 每种 probe 由代码实现，YAML 只能传参数；不支持任意命令或 SQL |
| `http-header` | ① / ①′ | `from: server\|browser`；`target`；`path`；`method: GET\|HEAD`（`POST` 只允许发往 `/api/console/probe/*`）；`headers`（只允许 `X-Compare-Bypass`、`Accept`；服务端发出的请求自动带探测令牌 `X-CloudAlbum-Probe`，不再使用哑值 `Authorization`）；`forwardTest: true`（只允许用于 `/api/console/probe/echo`：额外带 `Cookie: ca_probe=<nonce>` 与 `Authorization: Probe <nonce>`，用于验证 CDN 回源转发）；`repeat`（≤5）；`stripQuery`；`assert[]` | EC2 后端；`from: browser` 时由浏览器执行并回传（①′，§4.2） | `target` 只能是枚举值，由服务端解析为具体主机，学员和 YAML 都不能写任意 URL（防 SSRF）；地址用 `new URL()` 构造并校验 origin（§5.6）；不跟随重定向；响应体最多读取 64 KB |
| `path-seen` | ① | `segment`（路径段名）、`pattern`（RE2 或通配）、`window`（≤ 24h）、`minCount`（默认 1）、`distinct?: {segment, min}`、`excludeProbe: true`（固定为 true） | EC2 后端（查询 LabMetricsStore 的汇总表，多实例时汇总全部实例） | 只读汇总数据，不发请求；带探测令牌的请求不计入 |
| `session` | ① | `assert[]`，作用于 `{provider, groups, amr, tokenUse, authTime}`（服务端解析出的当前管理员 Principal 与令牌声明，不含令牌本身） | EC2 后端 | 只读当前请求的已验签 Principal |
| `capability` | ② | `module`、`assert[]`（作用于 `{driver,status,confidence,detail,public,data}`） | EC2 后端 | 只读本进程的能力注册表；多实例时按多数实例聚合 |
| `aws-readonly` | ③ | `service`、`action`、`region: app\|us-east-1\|global`、`params`、`assert[]` 或 `expectError`、`manualFallback` | EC2 后端（Verifier 角色） | `service:action` 必须在 Verifier 白名单中（§6.7），lint 和运行时各校验一次；响应先按该 action 的投影白名单裁剪再求值（§6.6） |
| `experiment` | ④ | `experiment`、`stage: <label>\|pair` | EC2 后端（读数据库） | — |
| `manual` | ⑤ | `spec: ManualSpec` | 学员 | — |

`local` 的 probe 白名单：

| probe | 参数 | 证据示例 |
|---|---|---|
| `imds` | `path`：**逐段精确匹配**白名单 `meta-data/instance-id`、`meta-data/placement/availability-zone`、`meta-data/placement/availability-zone-id`、`meta-data/placement/region`、`meta-data/public-ipv4`、`meta-data/iam/security-credentials/`（**只允许末尾带 `/` 的列表请求**，只返回角色名，永远不请求 `security-credentials/<角色名>`）、`meta-data/network/interfaces/macs/<mac>/vpc-id`、`…/macs/<mac>/security-group-ids`。`<mac>` 只匹配一段 `[0-9a-f:]+`，任何含 `..`、`%`、`//` 的路径直接拒绝；`checkV1Rejected: true` | `{"v1Status":401,"value":"ap-northeast-1a"}` |
| `process` | `unit`（白名单：`cloudalbum-api`、`cloudalbum-worker`、`nginx`、`amazon-ssm-agent`、`amazon-cloudwatch-agent`、`sshd`）。实现为固定参数的 `execFile('systemctl', ['show', unit, '-p', 'ActiveState,ActiveEnterTimestamp'])`，unit 先过白名单，不经过 shell | `{"active":"active","since":"…"}` |
| `port` | `port`、`bind: local\|any`（读取 `/proc/net/tcp*`） | `{"listening":true,"address":"0.0.0.0"}` |
| `disk` | `mount`（白名单：`/`、`/var/lib/cloudalbum`、`/mnt/efs/cloudalbum`） | `{"usedPct":18,"fstype":"xfs"}` |
| `file` | `path`：先 `realpath` 规范化，再比对白名单前缀 `/etc/cloudalbum/`、`/var/lib/cloudalbum/`、`/etc/nginx/cloudalbum.`；`mode: exists\|absent\|perm`。**不读取文件内容** | `{"exists":true,"mode":"0640"}` |
| `env-key` | `module`、`key`：判断 `modules.d/<id>.env` 中的键是否存在，以及非密钥键的值 | `{"present":true,"value":"redis"}` |
| `dns-resolve` | `host`（只能是模板变量） | `{"addresses":["54.12.34.56"]}` |
| `tls-handshake` | `target`（同 http-header 的枚举） | `{"issuer":"Amazon RSA 2048 M02","notAfter":"…"}` |
| `nginx-log` | `window`、`groupBy: server-port\|ca-entry`。按 Nginx 记录的 `$server_port` 与 `$ca_entry`（由 Nginx 依据监听端口和已校验的源站头计算）分组，**不看** `X-Amz-Cf-Id`、`Via` 等可以伪造的请求头；带探测令牌的请求不计入 | `{"80":3,"8080":412}` |
| `net-bytes` | `window`、`iface: primary` | `{"rxBytes":…,"txBytes":…}` |
| `app-stat` | `stat`（代码注册表中的命名统计：`photos.withLabels`、`jobs.pending`、`outbox.count`、`users.withLocalPassword`……） | `{"value":0}` |
| `leaked-keys` | —。扫描范围：`/etc/cloudalbum/` 下的文件（不含 `secrets.env`，keys 模式本来就把密钥写在那里，由 CRED-002 提示）、`cloudalbum` 用户自己的进程环境（`/proc/self/environ` 与 worker 进程）。以 `cloudalbum` 用户身份读不到 nginx、sshd、ssm-agent 的进程环境，因此**不扫描**它们；结果只返回计数 | `{"count":0,"scanned":["/etc/cloudalbum","api","worker"]}` |

`ManualSpec`：

```ts
interface ManualSpec {
  where: { breadcrumb: string[]; deepLink?: string; region?: 'app' | 'us-east-1' | 'global' };
  // deepLink 缺省时，由 CONSOLE 映射按模块和 region 生成；不允许写死别的模块的页面
  confirm?: string[];             // 逐条勾选的核对清单（全部勾选后才能提交）
  observed?: { question: string; options: { value: string; label: string; expected?: boolean; fixHint?: string }[] };
  input?: { label: string; pattern: string; verify?: 'format' | `equals:${string}` };   // equals:{{var.distributionId}}
  evidence?: { command: Command; parse: 'json'; assert: Assertion[] };   // 可选：粘贴 CLI 输出，校验后记为 [M+]；command 必须带 --query 投影
}
interface AwsReadonlyCheck extends CheckBase {
  type: 'aws-readonly';
  service: string; action: string; region?: 'app' | 'us-east-1' | 'global';
  params: Record<string, unknown>;
  assert?: Assertion[]; expectError?: string;   // 例如清理验证：expectError: NoSuchDistribution
  manualFallback: ManualSpec;     // 必填：没有凭证时怎么手动核对
}
```

### 5.8 断言语言

```ts
interface Assertion {
  path: string;                   // JSONPath 子集加管道变换，见下
  where?: Record<string, unknown | { op: Op; value: unknown }>;  // 当 path 指向数组时，先用它过滤元素
  whereMode?: 'all' | 'any';      // where 的多个条件之间：all = 同时满足（默认），any = 满足任一
  op: Op;
  value?: unknown;                // 可以是模板字符串
  label?: string;                 // 逐字段对照中显示的名称
}
type Op = 'eq' | 'neq' | 'in' | 'nin' | 'exists' | 'absent' | 'contains' | 'icontains' | 'startsWith'
        | 'matches' /* RE2，≤200 字符 */ | 'gte' | 'lte' | 'len_gte' | 'len_eq' | 'every' | 'some' | 'none';
```

- **路径**：JSONPath 子集 `$.a.b`、`$.a[0].b`、`$.items[*].x`，不支持过滤表达式。
- **管道变换**：路径中可以用 `|json`、`|urldecode`、`|number` 把字符串字段变成可继续取值的结构，再接 `.` 取子字段。例如 SQS 的 `$.Attributes.RedrivePolicy|json.maxReceiveCount`、IAM `GetPolicyVersion` 的 `$.PolicyVersion.Document|urldecode|json.Statement`、S3 `GetBucketPolicy` 的 `$.Policy|json.Statement`、KMS `GetKeyPolicy`、Lambda `GetPolicy`、SNS `GetTopicAttributes` 的 `Policy`。变换失败（不是合法 JSON 或 URL 编码）时结果为 `error/ASSERT_TYPE`。
- **数值比较**：`gte`、`lte` 先对两侧做 `Number()` 转换（SQS 属性值都是字符串，例如 `"5"`），转换得到 `NaN` 时结果为 `error/ASSERT_TYPE`，不判 pass 也不判 fail。
- **字段缺失**：path 取不到值时，除 `absent`（判 pass）、`exists`（判 fail）以外的所有运算一律判 **fail**，证据中标注“字段缺失”；`neq` 也不例外。自引用断言（例如 `'{{$.first.json.now}}'`）引用的字段缺失时同样判 fail，并提示“第一次请求没有返回 now 字段（状态码 401）”。
- **数组量词**：`every`、`some`、`none` 作用于 path 指向的数组，`where` 中的条件作用于每个元素；`whereMode: any` 表示元素满足任一条件即可。示例：“不存在这样的入站规则：（协议为全部流量，或端口区间与 80/443 有交集）且（来源为 0.0.0.0/0 或 ::/0）”——见 §5.10 的 `sg-no-world`。
- `where` 的键可以是点分子路径，例如 `AllowedMethods.Quantity: 7`；值为对象 `{op, value}` 时，按指定运算符比较。
- `where` 中也可以写**具名条件组**：键是任意组名（不与字段名冲突），值为 `{op: some | every, value: [子条件, …]}`，每个子条件本身是一个小的 `where`。组内按 `some`（任一）或 `every`（全部）合并，组与组、组与普通字段之间同时满足。§5.10 的 `sg-no-world` 用它表达“（全部流量或端口相交）且（IPv4 全网或 IPv6 全网）”。
- **证据中只保存断言用到的字段**：`assertions_json` 的 `actual` 只存标量或计数，并经过 Redactor（§6.10）。数组过滤的结果只记录命中条数与命中元素的非敏感标识字段（例如 `GroupId`、`FromPort`），不存整个元素。

- `http-header` 检查的证据结构为 `{request, status, headers, json?, pathSegments, timing, first?, last?, unsigned?}`：
  - `request`：`{host, path, target}`，本次请求实际使用的主机名与路径，可在断言中以 `'{{$.request.host}}'` 自引用。
  - `headers`：头名一律小写，例如 `$.headers.x-cache`。
  - `json`：只适用于 JSON 响应，例如 `$.json.<字段>`。
  - `pathSegments`：`X-CloudAlbum-Path` 解析后的段，例如 `$.pathSegments.cache`，复用总纲 `packages/contracts` 中的解析器（总纲 §7.2 的语法：键只能是模块 id 与 `entry`、`inst`、`az`、`bypass`、`more`，值以驱动名开头，例如 `storage=s3:presign`、`auth=local:verify`、`cache=redis@elasticache:error-bypass`、`cdn=cloudfront`）。
  - `timing`：`Server-Timing` 解析结果。
  - `repeat > 1` 时，另外提供 `first` 和 `last`。
  - `stripQuery: true` 时，引擎会再请求一次去掉查询串的同一路径，结果放在 `unsigned` 中。
- `http-header` 的 `target` 枚举值，以及服务端如何解析成具体地址：

  | target | 解析结果 |
  |---|---|
  | `self` | `http://127.0.0.1`，Host 设为 `{{publicDns}}` |
  | `origin-private` | `http://{{privateIp}}`，不带校验头 |
  | `cdn-origin` | `http://{{privateIp}}:{{envfile.cdn.CDN_ORIGIN_PORT}}`，不带校验头，用于验证 8080 源站监听器拒绝非 CloudFront 请求 |
  | `public-ip` | `http://{{publicIp}}`（直连被收紧时，相关检查用 `when: "env.cdn.CDN_DIRECT_ACCESS == 'open'"` 限定） |
  | `cdn` | `https://` 加分配域名，取自 `cap.cdn.public.baseUrl` 或 `var.cdnDomain` |
  | `app-base-url` | `{{appBaseUrl}}` |
  | `alb` | ALB 的 DNS 名，取自 capabilities |
  | `apigw` | `cap.social-api.public.baseUrl` |
  | `s3-object` | 探测对象的 S3 直链 |

  解析不出地址时，结果为 `error/NOT_FOUND_VAR`。

### 5.9 常见错误的匹配

检查结果不是 `pass` 时，引擎按以下流程处理该步骤的 `pitfalls`：

1. 逐条计算是否命中（`match` 中的全部条件都满足才算命中）。
2. 把命中的条目按 `weight` 降序排列，取前 3 条。
3. 第一条在检查详情和步骤卡中自动展开。
4. 每条都带一个动作：跳回某一步（可以精确到第 k 小步：自动切到控制台做法、高亮该小步并滚动到它）、开启轮询、打开控制台位置，或复制修复命令。
5. 一条都没有命中时，显示通用排查顺序：安全组与网络 → 实例角色权限 → `modules.d` 环境变量 → capabilities detail → 应用日志（`/var/lib/cloudalbum/logs/api.log` 的末尾 50 行，已脱敏）。

### 5.10 完整示例：`guides/cdn.yaml`（从 L0 启用 CloudFront）

**对齐说明**

本示例与 `01-edge-network-scaling.md#cdn` 保持一致：
- 源站（`CDN_ORIGIN_TYPE=ec2`，课程默认，直到 Lab 19/20）：EC2 公网 DNS，回源端口为专用的 **8080 监听器**，协议 `http-only`，并带 `X-Origin-Verify` 自定义头。cdn 栈自带源站安全组，只放行 CloudFront 托管前缀列表。
- 媒体源站：按总纲顺序 storage（Lab 4）早于 cdn（Lab 5），l2-edge 使用 `CDN_MEDIA_ORIGIN=s3`。如果 `/media/*` 仍回源 EC2，会命中 DEP-028（cdn 为 degraded），因此 storage 为 s3 时多一个“/media 改为 S3 源站（OAC）”的步骤（`when: driver.storage == 's3'`）。
- 后续 Lab 的正当变更：l8-ha 把源站换成 ALB（`CDN_ORIGIN_TYPE=alb`）或 VPC Origin，并把 network 切到 private（不再关联 EIP）；dns/tls 启用后分配带上别名。受影响的检查都声明了 `supersededWhen`，变化后显示“被 Lab N 取代”，不算漂移（§4.13）。
- 行为表：`/assets/*`、`/media/*`（自定义缓存策略 `cloudalbum-media`，S3 源站时改为 S3 源 + OAC）、`/api/public/*`、`/api/*`（CachingDisabled + Managed-AllViewer）、默认行为（UseOriginCacheControlHeaders）。
- env 键：`CDN_BASE_URL`、`CDN_DISTRIBUTION_ID`、`CDN_ORIGIN_TYPE`、`CDN_ORIGIN_PORT`、`CDN_MEDIA_ORIGIN`、`CDN_DIRECT_ACCESS`、`CDN_ORIGIN_DIRECT_URL`。
- 实验场景：`ttfb`、`media-load`。
- 路径段：`entry=cloudfront>nginx`、`cdn=cloudfront`。
- 引擎发出的探测请求一律带探测令牌，请求 `GET /api/console/probe/now`（§9.2），不再使用总纲中没有定义的 `/api/lab/now`。

**步骤顺序**

8080 监听器和源站校验由 `scripts/module enable cdn` 投放，所以 wire 步骤排在“行为配置”之前：先接入，才能在真实的回源链路上验证行为。选做的“收紧直连”会让 after 实验中的直连对照失败，所以排在 after 之后（§5.4）。

| 路线 | 做法 | 覆盖的步骤 |
|---|---|---|
| 路线 S | 在步骤 2 直接执行 `scripts/module enable cdn` | 一次完成步骤 2–5 |
| 路线 M | 手动建好分配后，在步骤 3 用 `--param ExistingDistributionId` 接管（附录 B-3） | 步骤 2 手动，步骤 3 接管，步骤 4、5 手动配置行为与媒体源站 |

```yaml
# guides/cdn.yaml
id: cdn
version: 4.1.0
title: 边缘缓存：EC2 直出 → CloudFront
intro:
  without: 浏览器直接从东京这台 EC2 的 Nginx 取页面、JS 和缩略图，每个字节都由实例发出；入口只有 http://EIP 和自签名 https。
  with: 同样的资源由离用户最近的边缘节点返回，命中时根本不回源；同时得到受信任的 HTTPS（*.cloudfront.net 默认证书）。
  why: Lab 8 的 Cognito 托管登录要求 HTTPS 回调地址；没有域名时，CloudFront 默认证书是最便宜的受信任 HTTPS。
learning:
  after: [iam, storage]           # iam：分配配置类检查才能自动执行；storage：媒体走 S3 源站（l2-edge 默认）
  estMinutes: 90
  focus: true
map:
  chip: nginx-static
  node: cloudfront
  edgesAfter: [browser->cloudfront, cloudfront->ec2]

variants:
  - { id: origin-ec2, when: "env.cdn.CDN_ORIGIN_TYPE == 'ec2' || env.cdn.CDN_ORIGIN_TYPE == ''", label: 源站为 EC2 的 8080 监听器（课程默认） }
  - { id: origin-alb, when: "env.cdn.CDN_ORIGIN_TYPE == 'alb'", label: 源站为 ALB（l8-ha）, lab: 19 }
  - { id: origin-vpc, when: "env.cdn.CDN_ORIGIN_TYPE == 'vpc-origin'", label: 源站为 VPC Origin（private 放置）, lab: 20 }
  - { id: media-s3, when: "driver.storage == 's3'", label: 媒体走 S3 源站（storage 已启用，l2-edge 默认） }

variables:
  distributionId:
    label: 分配 ID
    from: input
    fillFrom: envfile.cdn.CDN_DISTRIBUTION_ID      # 接入应用后自动读取；wire 达成时固化为快照，清理验证使用（snapshot 默认 true）
    pattern: '^E[A-Z0-9]{8,20}$'
    example: E2QWRUHAPOMQZL
    help: CloudFront 控制台“分配”列表中的 ID 列
  cdnDomain:
    label: 分配域名
    from: input
    fillFrom: cap.cdn.public.baseUrl               # https://d111abcdef8.cloudfront.net，引擎去掉协议头
    pattern: '^d[a-z0-9]+\.cloudfront\.net$'
    example: d111abcdef8.cloudfront.net
  myCidr:
    label: 你的公网 IP（/32）
    from: input
    pattern: '^(\d{1,3}\.){3}\d{1,3}/32$'
    help: 运维机上执行 curl -s https://checkip.amazonaws.com 得到 IP，再加上 /32

steps:
  # ── 步骤 0：基线 ──────────────────────────────────────────────
  - id: baseline
    type: experiment
    stage: before
    experiment: ttfb
    title: 记录基线（before）：从运维机直连 EC2，测首字节时间
    why: 先量出“没有 CDN”时的首字节时间和源站流量，after 才有对照。最好在离东京较远的区域的 CloudShell 中运行。
    estMinutes: 5
    methods:
      cli:
        runsOn: ops
        commands:
          - run: npm run exp -- cdn --label before --scenario ttfb --upload
            explain: 实验 ttfb 每次新建连接，请求直连地址 20 次 × 10 轮；运行器记录每个响应的 X-CloudAlbum-Path 作为客户端证据。cdn 未启用时只测直连这一路。
            expectOutput: "OK  cdn/ttfb before  requests=20 errors=0  uploaded run=01JA…"
          - run: npm run exp -- cdn --label before --scenario media-load --upload
            explain: （选做）源站负载基线：加载相册 JSON、30 张缩略图和 1 张展示图，持续 5 分钟。
    expected:
      text: 实验记录本中出现一条有效的 before 记录（entry=nginx 占比 100%）。
    checks:
      - { id: exp-before, type: experiment, title: 有一条有效的 before 记录, experiment: ttfb, stage: before }
    pitfalls:
      - id: already-enabled
        symptom: 运行器拒绝运行，提示 requires.before 不满足
        match: { check: exp-before, evidenceRegex: 'requires' }
        cause: cdn 已经启用，before 无法再按正常方式录制
        fix:
          text: '改用旁路补测模拟基线（X-Compare-Bypass: cdn，媒体 URL 改回源站）'
          command: { run: 'npm run exp -- cdn --label before --scenario ttfb --ab --upload', runsOn: ops }

  # ── 步骤 1：准备源站 ──────────────────────────────────────────
  - id: prepare-origin
    type: config
    title: 确认 EC2 可以作为 CloudFront 的源站
    why: CloudFront 的自定义源站只接受域名；EC2 的公网 DNS 只有在关联 EIP 时才稳定；源站的 Cache-Control 决定边缘缓存多久。
    estMinutes: 10
    methods:
      cli:
        runsOn: ec2
        commands:
          - run: getent hosts {{publicDns}}
            expectOutput: "{{publicIp}}  {{publicDns}}"
          - run: curl -sI http://localhost/assets/{{sample.assetPath}} | grep -i cache-control
            expectOutput: "cache-control: public, max-age=31536000, immutable"
          - run: curl -sI http://localhost/api/me | grep -i cache-control
            explain: 需要认证的 API（包括未登录时的 401 响应）都带 private, no-store。
            expectOutput: "cache-control: private, no-store"
    expected:
      text: 公网 DNS 解析到你的 EIP；带哈希的静态资源返回一年的 immutable；需要认证的 API 返回 private, no-store；index.html 返回 no-cache。
    checks:
      - id: public-dns
        type: local
        title: 公网 DNS 名解析到 EIP
        probe: dns-resolve
        params: { host: '{{publicDns}}' }
        assert: [{ path: $.addresses, op: contains, value: '{{publicIp}}', label: 解析结果 }]
        supersededWhen: { expr: "env.cdn.CDN_ORIGIN_TYPE == 'alb' || env.cdn.CDN_ORIGIN_TYPE == 'vpc-origin'", byLab: 19, text: 源站改为 ALB 或 VPC Origin 后，EC2 公网 DNS 不再是源站 }
        reproduce: { run: 'getent hosts {{publicDns}}', runsOn: ec2 }
      - id: eip-associated
        type: aws-readonly
        title: 弹性 IP 已关联到本实例（公网 DNS 才稳定）
        service: ec2
        action: DescribeAddresses
        params: { Filters: [{ Name: instance-id, Values: ['{{instanceId}}'] }] }
        supersededWhen: { expr: "env.cdn.CDN_ORIGIN_TYPE == 'alb' || env.cdn.CDN_ORIGIN_TYPE == 'vpc-origin' || cap.network.data.placement == 'private'", byLab: 19, text: 源站改为 ALB / VPC Origin，或 network 切换为 private（AssociateEip=false）之后不再需要 EIP }
        assert: [{ path: $.Addresses, op: len_eq, value: 1, label: 关联的 EIP 数 }]
        reproduce: { run: "aws ec2 describe-addresses --filters Name=instance-id,Values={{instanceId}} --region {{region}}", runsOn: ops }
        manualFallback:
          where: { breadcrumb: [EC2, 弹性 IP], deepLink: 'https://{{region}}.console.aws.amazon.com/ec2/home?region={{region}}#Addresses:' }
          observed:
            question: '{{publicIp}} 的“关联的实例 ID”是什么？'
            options:
              - { value: self, label: '{{instanceId}}', expected: true }
              - { value: none, label: 空（未关联）, fixHint: 关联 EIP 后公网 DNS 才固定；L0 基础栈默认会关联，可用 scripts/module status ec2 --repair 修复 }
      - id: asset-cache-header
        type: http-header
        title: 静态资源返回长缓存头
        from: server
        target: self
        path: /assets/{{sample.assetPath}}
        assert:
          - { path: $.status, op: eq, value: 200 }
          - { path: $.headers.cache-control, op: contains, value: immutable, label: Cache-Control }
        reproduce: { run: 'curl -sI http://localhost/assets/{{sample.assetPath}} | grep -i cache-control', runsOn: ec2 }
      - id: api-private
        type: http-header
        title: 认证 API 返回 private, no-store（探测端点）
        from: server
        target: self
        path: /api/console/probe/now          # 引擎带探测令牌，以“探测主体”身份得到 200 与 {now, nonce}
        assert:
          - { path: $.status, op: eq, value: 200 }
          - { path: $.headers.cache-control, op: contains, value: no-store, label: Cache-Control }
        reproduce: { run: 'curl -sI http://localhost/api/me | grep -i cache-control', runsOn: ec2 }
    pitfalls:
      - id: no-public-dns
        symptom: getent 没有输出
        match: { check: public-dns, result: fail }
        cause: 实例没有公网 DNS 主机名（VPC 未开启 DNS 主机名，或没有公网 IP）
        fix: { text: 默认 VPC 默认开启 DNS 主机名；自定义 VPC 需要开启 enableDnsHostnames }
    saa:
      - { domain: performance, text: 是否缓存、缓存多久由“缓存策略 + 源站 Cache-Control”共同决定；带哈希的文件名可以放心设长 TTL，不需要失效。, confusable: 缓存失效 vs 版本化文件名 }

  # ── 步骤 2：创建分配 ──────────────────────────────────────────
  - id: create-distribution
    type: config
    title: 创建 CloudFront 分配（源站 = 这台 EC2 的 8080 源站监听器）
    estMinutes: 15
    startsBilling: { class: usage, rateKeys: [cloudfront.requests, cloudfront.dto], note: 按量计费；学习流量通常在免费额度内（以官方为准） }
    waitHint: { typicalMinutes: 5, maxMinutes: 20, text: 分配状态会从“正在部署”变为“已启用” }
    readWhileWaiting: |
      **为什么回源用 8080，而不是 80？** 80/443 是给浏览器直连用的；8080 是只给 CloudFront 用的源站监听器：
      安全组只放行 CloudFront 托管前缀列表，Nginx 再校验 X-Origin-Verify 密钥头。
      只靠前缀列表不够——别人的 CloudFront 分配也来自同一批网段。
    defaultMethod: console
    methods:
      console:
        region: global                    # CloudFront 分配是全局资源，不需要切换区域，界面不显示区域提示
        breadcrumb: [CloudFront, 分配, 创建分配]
        deepLink: https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions/create
        instructions:
          - 在运维机生成源站密钥：`mkdir -p ~/.cloudalbum && openssl rand -hex 24 > ~/.cloudalbum/cf-origin-secret`（不要贴进聊天或截图）。
          - 源：选择“其他”，源站域名填 `{{publicDns}}`（**不要填 IP**）；协议选“仅 HTTP”，HTTP 端口填 **8080**。
          - 添加自定义标头：名称 `X-Origin-Verify`，值为上一步生成的内容。
          - 默认缓存行为：查看器协议策略选“将 HTTP 重定向到 HTTPS”；缓存策略选 **UseOriginCacheControlHeaders**（让 index.html 的 no-cache 生效）。
          - 响应头策略：先不选，步骤 4 再配置。WAF：先不启用（waf 模块再做）。
          - 价格级别：选择包含日本的级别（PriceClass_200，“北美、欧洲、亚洲、中东和非洲”）。
          - 标签：Project=CloudAlbum、Env={{env}}、Module=cdn、ManagedBy=manual。
          - 创建后，把分配 ID 和域名填入右侧变量面板。**8080 监听器要到步骤 3 才会出现，在那之前经分配访问返回 502，这是预期的。**
        fields:
          - { name: 源站域名, value: '{{publicDns}}', why: 自定义源站只能是域名 }
          - { name: 源站协议 / 端口, value: 仅 HTTP / 8080, why: 'L0 的证书是自签名，CloudFront 回源不接受；*.compute.amazonaws.com 拿不到公共 CA 证书' }
          - { name: 自定义标头, value: X-Origin-Verify, why: 证明请求来自“我们的”分配 }
          - { name: 价格级别, value: PriceClass_200, why: 价格级别决定使用哪些边缘位置，是成本考点 }
      cli:
        runsOn: ops
        commands:
          - run: |
              POL=$(aws cloudfront list-cache-policies --type managed \
                --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='Managed-UseOriginCacheControlHeaders'].CachePolicy.Id" --output text)
              SECRET=$(cat ~/.cloudalbum/cf-origin-secret)
              cat > cdn-dist.json <<EOF
              { "CallerReference": "cloudalbum-{{env}}-$(date +%s)", "Comment": "cloudalbum-{{env}}-cdn (manual)",
                "Enabled": true, "PriceClass": "PriceClass_200", "HttpVersion": "http2and3", "IsIPV6Enabled": true,
                "Origins": { "Quantity": 1, "Items": [{ "Id": "ec2-origin", "DomainName": "{{publicDns}}",
                  "CustomHeaders": { "Quantity": 1, "Items": [{ "HeaderName": "X-Origin-Verify", "HeaderValue": "$SECRET" }] },
                  "CustomOriginConfig": { "HTTPPort": 8080, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only",
                    "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }, "OriginReadTimeout": 30 } }] },
                "DefaultCacheBehavior": { "TargetOriginId": "ec2-origin", "ViewerProtocolPolicy": "redirect-to-https",
                  "AllowedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }, "CachePolicyId": "$POL", "Compress": true } }
              EOF
              aws cloudfront create-distribution-with-tags --distribution-config-with-tags \
                "{\"DistributionConfig\": $(cat cdn-dist.json), \"Tags\": {\"Items\": [
                  {\"Key\":\"Project\",\"Value\":\"CloudAlbum\"},{\"Key\":\"Env\",\"Value\":\"{{env}}\"},
                  {\"Key\":\"Module\",\"Value\":\"cdn\"},{\"Key\":\"ManagedBy\",\"Value\":\"manual\"}]}}" \
                --query "Distribution.[Id,DomainName,Status]" --output text
            explain: 托管策略在 API 中的名称带“Managed-”前缀；按名称查询 ID，避免写死。
            expectOutput: "E2QWRUHAPOMQZL  d111abcdef8.cloudfront.net  InProgress"
      script:
        runsOn: ops
        command: scripts/module enable cdn
        preview: scripts/module enable cdn --dry-run
        creates:
          - CloudFront 分配（源站 = EC2 公网 DNS:8080，含全部行为与响应头策略 cloudalbum-lab）
          - 源站安全组 cloudalbum-{{env}}-cdn-origin-sg（8080 只放行 CloudFront 前缀列表），挂到实例上
          - Nginx 片段 /etc/nginx/cloudalbum.d/cdn-origin.conf 与 cdn-realip-ranges.inc
          - X-Origin-Verify 密钥（启用 secrets 时存入 Secrets Manager）
          - modules.d/cdn.env
        completesSteps: [create-distribution, wire, behaviors]
    expected:
      text: 分配状态为“已启用”；源站为 {{publicDns}}:8080，协议为仅 HTTP，带 X-Origin-Verify 头。
    checks:
      - id: deployed
        type: aws-readonly
        title: 分配已部署
        service: cloudfront
        action: GetDistribution
        region: global
        params: { Id: '{{var.distributionId}}' }
        waitable: true
        assert: [{ path: $.Distribution.Status, op: eq, value: Deployed, label: 状态 }]   # 投影白名单只保留 Status、Id、DomainName、LastModifiedTime
        reproduce: { run: "aws cloudfront get-distribution --id {{var.distributionId}} --query Distribution.Status", runsOn: ops }
        manualFallback:
          where: { breadcrumb: [CloudFront, 分配, '{{var.distributionId}}'], deepLink: 'https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions/{{var.distributionId}}' }
          observed:
            question: “上次修改”一栏显示什么？
            options:
              - { value: date, label: 一个日期时间, expected: true }
              - { value: deploying, label: 正在部署, fixHint: 再等几分钟；超过 20 分钟仍在部署时，检查是否刚修改过配置 }
          input: { label: 分配 ID, pattern: '^E[A-Z0-9]{8,20}$', verify: 'equals:{{var.distributionId}}' }
      - id: origin-config
        type: aws-readonly
        title: 源站为公网 DNS:8080、仅 HTTP、带校验头
        service: cloudfront
        action: GetDistributionConfig
        region: global
        params: { Id: '{{var.distributionId}}' }
        # 响应先按投影白名单裁剪：CustomHeaders.Items[] 只保留 HeaderName，HeaderValue（源站密钥）在进入断言之前就被丢弃（§6.6）
        assert:
          - { path: '$.DistributionConfig.Origins.Items', where: { Id: ec2-origin }, op: len_eq, value: 1, label: EC2 源站 }
          - { path: '$.DistributionConfig.Origins.Items[0].DomainName', op: eq, value: '{{publicDns}}', label: 源站域名 }
          - { path: '$.DistributionConfig.Origins.Items[0].CustomOriginConfig.HTTPPort', op: eq, value: 8080, label: HTTP 端口 }
          - { path: '$.DistributionConfig.Origins.Items[0].CustomOriginConfig.OriginProtocolPolicy', op: eq, value: http-only, label: 源站协议 }
          - { path: '$.DistributionConfig.Origins.Items[0].CustomHeaders.Items', where: { HeaderName: X-Origin-Verify }, op: len_eq, value: 1, label: 校验头（只记录条数） }
          - { path: $.DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy, op: eq, value: redirect-to-https, label: 查看器协议 }
        supersededWhen: { expr: "env.cdn.CDN_ORIGIN_TYPE == 'alb' || env.cdn.CDN_ORIGIN_TYPE == 'vpc-origin'", byLab: 19, text: 源站改为 ALB 或 VPC Origin }
        reproduce:
          run: "aws cloudfront get-distribution-config --id {{var.distributionId}} --query 'DistributionConfig.Origins.Items[0].{Domain:DomainName,Port:CustomOriginConfig.HTTPPort,Policy:CustomOriginConfig.OriginProtocolPolicy,Headers:CustomHeaders.Items[].HeaderName}'"
          runsOn: ops
        manualFallback:
          where: { breadcrumb: [CloudFront, 分配, '{{var.distributionId}}', 源, ec2-origin, 编辑] }
          confirm: ['源站域名 = {{publicDns}}', 协议 = 仅 HTTP，端口 = 8080, 自定义标头中有 X-Origin-Verify, 默认行为的查看器协议策略 = 重定向到 HTTPS]
          evidence:
            # 只投影要校验的字段，不让学员粘贴含 HeaderValue 的完整输出
            command:
              run: "aws cloudfront get-distribution-config --id {{var.distributionId}} --query 'DistributionConfig.Origins.Items[0].{Port:CustomOriginConfig.HTTPPort,Policy:CustomOriginConfig.OriginProtocolPolicy,Headers:CustomHeaders.Items[].HeaderName}'"
              runsOn: ops
            parse: json
            assert:
              - { path: $.Port, op: eq, value: 8080 }
              - { path: $.Policy, op: eq, value: http-only }
              - { path: $.Headers, op: contains, value: X-Origin-Verify }
      - id: domain-resolves
        type: local
        title: 分配域名可以解析
        probe: dns-resolve
        params: { host: '{{var.cdnDomain}}' }
        assert: [{ path: $.addresses, op: len_gte, value: 1 }]
        reproduce: { run: 'getent hosts {{var.cdnDomain}}', runsOn: ec2 }
    pitfalls:
      - id: ip-origin
        symptom: 创建时报错，提示源站名称必须是域名
        match: { check: origin-config, field: '$.DistributionConfig.Origins.Items[0].DomainName' }
        cause: 源站填了 IP
        fix: { text: '源站改为 {{publicDns}}', gotoStep: create-distribution, action: open-console }
        weight: 2
      - id: origin-https
        symptom: 源站协议不是“仅 HTTP”
        match: { check: origin-config, field: '$.DistributionConfig.Origins.Items[0].CustomOriginConfig.OriginProtocolPolicy' }
        cause: 选了 HTTPS 或“匹配查看器”；CloudFront 不信任自签名证书，回源会 502
        fix: { text: 源站协议改为仅 HTTP、端口 8080, gotoStep: create-distribution }
    saa:
      - { domain: performance, text: CloudFront 回源到 EC2/ALB 属于“自定义源站”，回源到 S3 属于“S3 源站”（用 OAC）。, confusable: 自定义源站 vs S3 源站 }
      - { domain: cost, text: 价格级别限制使用哪些边缘位置；从 AWS 源站回源到 CloudFront 的流量免费，所以 CDN 还能降低 EC2 出网流量费。 }
    mapDelta: { nodeOn: cloudfront, edgeAdd: [browser->cloudfront], caption: 边缘节点出现了，但还没有接到源站（下一步） }

  # ── 步骤 3：接入应用 ──────────────────────────────────────────
  - id: wire
    type: wire
    title: 接入应用：投放 8080 源站监听器与校验，媒体 URL 改写到 CloudFront
    estMinutes: 10
    impact: { restartApp: true, note: 重启 api 与 worker，约 10 秒不可用 }
    methods:
      script:
        runsOn: ops
        command: scripts/module enable cdn
        preview: scripts/module enable cdn --dry-run
        creates: [同步骤 2 的一键脚本（路线 S 已经完成）]
      cli:
        runsOn: ops
        commands:
          - run: |
              scripts/module enable cdn \
                --param ExistingDistributionId={{var.distributionId}} \
                --param OriginVerifySecret="$(cat ~/.cloudalbum/cf-origin-secret)"
            explain: |
              路线 M（接管手动建的分配）：栈不再新建分配，只创建源站安全组、PolicyArn，并投放 Nginx 8080 监听器、写入 cdn.env。
              OriginVerifySecret 是 NoEcho 参数；启用 secrets 后它会被存进 Secrets Manager。分配本身仍属于手动管理的资源。
            expectOutput: "OK cdn: off → ok (cloudfront)  CDN_BASE_URL=https://{{var.cdnDomain}}"
    expected:
      text: scripts/module 打印 cdn 从 off 变为 ok；经分配访问 /api/health/live 得到 entry=cloudfront>nginx；相册返回的图片 URL 改为 https://{{var.cdnDomain}}/media/…
      sample: |
        $ sudo -u cloudalbum node /opt/cloudalbum/backend/dist/cli.js console:probe /api/console/probe/now --via cdn
        HTTP/2 200
        x-cache: Miss from cloudfront
        x-amz-cf-pop: NRT57-P2
        x-cloudalbum-path: entry=cloudfront>nginx;inst={{instanceId}};az={{az}}
    checks:
      - id: cap-ok
        type: capability
        title: 能力探针：cdn 为 ok，驱动为 cloudfront
        module: cdn
        assert:
          - { path: $.status, op: in, value: [ok, degraded] }
          - { path: $.driver, op: eq, value: cloudfront }
        reproduce: { run: 'curl -s http://127.0.0.1/api/capabilities | jq .modules.cdn', runsOn: ec2 }
      - id: entry-cloudfront
        type: http-header
        title: 经分配访问探测端点时，入口链为 cloudfront>nginx（证明 8080 监听器与密钥都正确）
        from: server
        target: cdn
        path: /api/console/probe/now          # 带探测令牌：不论 EXPOSE_PATH_HEADERS 取何值都返回路径头；不计入感知器与 real-traffic
        waitable: true
        assert:
          - { path: $.status, op: eq, value: 200 }
          - { path: $.headers.x-amz-cf-id, op: exists, label: X-Amz-Cf-Id }
          - { path: $.pathSegments.entry, op: startsWith, value: cloudfront, label: 入口链 }
        reproduce: { run: 'sudo -u cloudalbum node /opt/cloudalbum/backend/dist/cli.js console:probe /api/console/probe/now --via cdn', runsOn: ec2 }
      - id: origin-verify-enforced
        type: http-header
        title: 不带校验头直接请求 8080 返回 403
        from: server
        target: cdn-origin
        path: /api/health/live
        assert: [{ path: $.status, op: eq, value: 403 }]
        supersededWhen: { expr: "env.cdn.CDN_ORIGIN_TYPE == 'alb' || env.cdn.CDN_ORIGIN_TYPE == 'vpc-origin'", byLab: 19, text: 8080 监听器随源站类型变化而移除 }
        reproduce: { run: 'curl -s -o /dev/null -w "%{http_code}\n" http://{{privateIp}}:8080/api/health/live', runsOn: ec2 }
      - id: media-rewritten
        type: http-header
        title: API 返回的媒体 URL 已改写到 CloudFront
        from: server
        target: self
        path: /api/console/probe/media-url
        assert:
          - { path: $.json.url, op: startsWith, value: 'https://{{var.cdnDomain}}/media/' }
          - { path: $.pathSegments.cdn, op: startsWith, value: cloudfront }
        reproduce: { run: 'sudo -u cloudalbum node /opt/cloudalbum/backend/dist/cli.js console:probe /api/console/probe/media-url', runsOn: ec2 }
      - id: real-traffic
        type: path-seen
        title: 最近 15 分钟真实请求中出现 entry=cloudfront>*（不计探测请求）
        segment: entry
        pattern: 'cloudfront>*'
        window: 15m
        minCount: 1
        explain: 打开一次带图片的相册页面即可。统计依据是 Nginx 按监听端口与已校验的源站头计算的 $ca_entry，不看可以伪造的 X-Amz-Cf-Id、Via 请求头。
        reproduce: { run: 'curl -s "http://127.0.0.1/api/lab/metrics?groupBy=path&from=-15m" -H "Authorization: Bearer $TOKEN" | jq ''[.signatures[]|select(.sig|startswith("entry=cloudfront>"))|.count]|add''', runsOn: ec2 }
    pitfalls:
      - id: wire-502
        symptom: 经分配访问返回 502
        match: { check: entry-cloudfront, field: $.status, actual: 502 }
        cause: 8080 监听器没有投放，或者源站安全组没有挂到实例上（scripts/module 中途失败）
        fix: { text: 运维机上执行 scripts/module status cdn 查看失败的阶段，然后重跑 enable, command: { run: scripts/module status cdn, runsOn: ops } }
        weight: 3
      - id: wire-403
        symptom: 经分配访问返回 403
        match: { check: entry-cloudfront, field: $.status, actual: 403 }
        cause: 分配上的 X-Origin-Verify 值与实例上的值不一致
        fix: { text: 确认两边使用的是同一个文件 ~/.cloudalbum/cf-origin-secret，必要时重跑接管命令, gotoStep: wire }
        weight: 3
      - id: still-direct
        symptom: 能力探针为 ok，但最近没有经 CloudFront 的请求
        match: { check: real-traffic, result: fail }
        cause: 还没有打开过带图片的页面
        fix: { text: 用浏览器打开一次相册首页，然后再测一次, action: rerun }
    mapDelta: { chipOut: nginx-static, edgeAdd: [cloudfront->ec2], caption: “Nginx 直出”芯片迁出 EC2，图片改由边缘节点提供 }

  # ── 步骤 4：缓存行为 ──────────────────────────────────────────
  - id: behaviors
    type: config
    title: 为静态资源、媒体、API 分别设置缓存行为
    why: 动态接口绝不能被缓存（否则 A 用户会看到 B 的时间线）；私有媒体的签名参数必须进入缓存键；个性化 API 必须把 Authorization 和 Cookie 带到源站。
    estMinutes: 20
    waitHint: { typicalMinutes: 3, maxMinutes: 15, text: 修改行为后分配会重新部署 }
    methods:
      console:
        region: global
        breadcrumb: [CloudFront, 分配, '{{var.distributionId}}', 行为, 创建行为]
        instructions:
          - 先建自定义缓存策略 `cloudalbum-media`（策略 › 缓存 › 创建）：最小 TTL 0、默认 86400、最大 31536000；缓存键只包含查询参数 `exp`、`sig`；不包含 Cookie 和请求头。
          - '`/assets/*`：缓存策略 Managed-CachingOptimized；压缩：是。'
          - '`/media/*`：缓存策略 cloudalbum-media；压缩：否（图片本身已经压缩）。'
          - '`/api/*`：缓存策略 Managed-CachingDisabled；源请求策略 **Managed-AllViewer**；允许的方法选全部 7 种。'
          - （选做）`/api/public/*`：自定义 `cloudalbum-api-micro`（最小 0、默认 0、最大 60 秒，缓存键包含全部查询参数），用来观察 `s-maxage` 微缓存。
          - 行为优先级：上面这些都要排在默认 (*) 之前。
          - 响应头策略：新建 `cloudalbum-lab`，开启 Server-Timing 头，并配置 CORS（暴露 X-Cache、Age、X-Amz-Cf-Pop、Server-Timing、X-CloudAlbum-Path），挂到所有行为上。
      cli:
        runsOn: ops
        commands:
          - run: |
              aws cloudfront get-distribution-config --id {{var.distributionId}} > cfg.json
              ETAG=$(jq -r .ETag cfg.json); jq '.DistributionConfig' cfg.json > dist.json
              # 编辑 dist.json 中的 .CacheBehaviors（完整 jq 片段见 01-edge-network-scaling.md#cdn 的行为表）
              aws cloudfront update-distribution --id {{var.distributionId}} --if-match "$ETAG" --distribution-config file://dist.json
            explain: 更新分配必须带上一次读取得到的 ETag（乐观锁）。
      code:
        files:
          - path: infra/modules/cdn.yaml
            lang: yaml
            snippet: |
              - PathPattern: /api/*
                TargetOriginId: ec2-origin
                ViewerProtocolPolicy: redirect-to-https
                AllowedMethods: [GET, HEAD, OPTIONS, PUT, PATCH, POST, DELETE]
                CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad        # Managed-CachingDisabled
                OriginRequestPolicyId: !Ref ManagedAllViewerPolicyId        # 由 scripts/module 按名称查询后传入
            explain:
              - 路线 S 的学员在这里读懂模板，然后点“检测”核对。
              - CachingDisabled 不允许把 Authorization 放进缓存键，只能靠“转发全部查看器请求头”的源请求策略把它带到源站。
              - X-Compare-Bypass 只在 /api/* 中随请求转发；可缓存的行为既不转发它，也不把它放进缓存键（总纲 §8.3 第 5 条）。
    expected:
      text: /api/* 始终 Miss，且源站收到了 Cookie 和 Authorization；静态资源第二次请求命中；去掉签名的私有媒体 URL 返回 403。
    checks:
      - id: behaviors-config
        type: aws-readonly
        title: /assets/*、/media/*、/api/* 三个行为存在，/api/* 允许 7 种方法
        service: cloudfront
        action: GetDistributionConfig
        region: global
        params: { Id: '{{var.distributionId}}' }
        reproduce: { run: "aws cloudfront get-distribution-config --id {{var.distributionId}} --query 'DistributionConfig.CacheBehaviors.Items[].[PathPattern,AllowedMethods.Quantity]'", runsOn: ops }
        assert:
          - { path: $.DistributionConfig.CacheBehaviors.Items, where: { PathPattern: /assets/* }, op: len_eq, value: 1, label: /assets/* }
          - { path: $.DistributionConfig.CacheBehaviors.Items, where: { PathPattern: /media/* }, op: len_eq, value: 1, label: /media/* }
          - { path: $.DistributionConfig.CacheBehaviors.Items, where: { PathPattern: /api/*, AllowedMethods.Quantity: 7 }, op: len_eq, value: 1, label: /api/*（7 种方法） }
        manualFallback:
          where: { breadcrumb: [CloudFront, 分配, '{{var.distributionId}}', 行为] }
          confirm: [/assets/* → CachingOptimized, /media/* → cloudalbum-media, /api/* → CachingDisabled + AllViewer，允许 7 种方法, 这些行为都排在 Default (*) 之前]
      - id: api-not-cached
        type: http-header
        title: 认证 API 不被缓存（探测端点请求两次）
        from: server
        target: cdn
        path: /api/console/probe/now          # 带探测令牌，返回 200 与 {now, nonce}，Cache-Control: private, no-store
        repeat: 2
        waitable: true
        assert:
          - { path: '$.first.status', op: eq, value: 200, label: 第一次的状态码 }
          - { path: '$.last.headers.x-cache', op: icontains, value: miss, label: 第二次的 X-Cache }
          - { path: '$.last.json.now', op: neq, value: '{{$.first.json.now}}', label: 两次时间戳不同 }   # 字段缺失时判 fail（§5.8）
        reproduce: { run: 'for i in 1 2; do curl -s -D - -o /dev/null https://{{var.cdnDomain}}/api/me | grep -i x-cache; done', runsOn: ops }
      - id: console-not-cached
        type: http-header
        title: 控制台 API 不被缓存
        from: server
        target: cdn
        path: /api/console/ping
        repeat: 2
        assert:
          - { path: '$.last.headers.x-cache', op: icontains, value: miss }
          - { path: '$.last.headers.cache-control', op: contains, value: no-store }
        reproduce: { run: 'for i in 1 2; do curl -sI https://{{var.cdnDomain}}/api/console/ping | grep -iE "x-cache|cache-control"; done', runsOn: ops }
      - id: forwarding
        type: http-header
        title: 回源时带上了 Cookie、Authorization，且源站看到的 Host 就是本次请求的主机名
        from: server
        target: cdn
        path: /api/console/probe/echo
        forwardTest: true                     # 引擎额外带 Cookie: ca_probe=<nonce> 与 Authorization: Probe <nonce>，只允许用于这个端点
        assert:
          - { path: $.json.hasCookie, op: eq, value: true, label: 回源带 Cookie }
          - { path: $.json.hasAuthorization, op: eq, value: true, label: 回源带 Authorization }
          - { path: $.json.hostSeen, op: eq, value: '{{$.request.host}}', label: 源站看到的 Host（AllViewer 会转发查看器的 Host） }
        explain: Host 与“本次请求的主机名”比较，而不是写死分配域名；dns/tls 启用、分配带上别名之后这项检查仍然成立。
        reproduce: { run: 'curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <你的访问令牌>" https://{{var.cdnDomain}}/api/me', runsOn: ops }
      - id: assets-hit
        type: http-header
        title: 静态资源第二次请求命中边缘缓存
        from: server
        target: cdn
        path: /assets/{{sample.assetPath}}?lab={{sample.nonce}}
        repeat: 2
        assert: [{ path: '$.last.headers.x-cache', op: icontains, value: hit, label: 第二次的 X-Cache }]
        explain: lab 参数不在缓存键中，只用来绕过浏览器缓存；边缘仍然会命中。
        reproduce: { run: 'for i in 1 2; do curl -sI "https://{{var.cdnDomain}}/assets/{{sample.assetPath}}?lab=$RANDOM" | grep -i x-cache; done', runsOn: ops }
      - id: media-private-not-leaked
        type: http-header
        title: 去掉签名的私有媒体 URL 拿不到图片
        from: server
        target: cdn
        path: '{{sample.privateMediaPath}}'
        stripQuery: true
        assert: [{ path: '$.unsigned.status', op: in, value: [401, 403], label: 去掉签名后的状态码 }]
        explain: 引擎先用带 exp/sig 的 URL 请求一次，再去掉查询参数请求同一路径。
        reproduce: { run: 'curl -s -o /dev/null -w "%{http_code}\n" "https://{{var.cdnDomain}}{{sample.privateMediaPath}}"', runsOn: ops }
    pitfalls:
      - id: api-401-via-cdn
        symptom: 直连正常，经 CDN 的 API 返回 401，或者登录后又被跳回登录页
        match: { check: forwarding, field: $.json.hasAuthorization, actual: false }
        cause: /api/* 没有配置转发全部查看器值的源请求策略，Authorization 或 Cookie 没有到达源站
        fix: { text: /api/* 的源请求策略改为 Managed-AllViewer, gotoStep: behaviors }
        weight: 3
      - id: method-not-allowed
        symptom: 'POST 返回 403：This distribution is not configured to allow the HTTP request method'
        match: { evidenceRegex: 'not configured to allow the HTTP request method' }
        cause: /api/* 的允许方法只有 GET、HEAD
        fix: { text: 允许方法改为全部 7 种, gotoStep: behaviors }
      - id: api-cached
        symptom: 时间线显示的是别人的数据，或者数据一直不更新
        match: { check: api-not-cached, result: fail }
        cause: /api/* 落到了会缓存的行为（例如 CachingOptimized 最小 TTL 1 秒会无视 private/no-store），或者行为顺序不对
        fix: { text: /api/* 必须使用 CachingDisabled，并排在默认行为之前, gotoStep: behaviors }
        weight: 3
      - id: private-leak
        symptom: 去掉签名仍然拿到了图片
        match: { check: media-private-not-leaked, result: fail }
        cause: /media/* 的缓存键不包含 exp、sig，带不同签名的链接被当成同一个对象
        fix: { text: /media/* 改用 cloudalbum-media 缓存策略, gotoStep: behaviors }
        weight: 3
    saa:
      - { domain: performance, text: 缓存策略决定“缓存键 + TTL”；源请求策略决定“回源时额外带什么”；响应头策略管 CORS、安全头和 Server-Timing。最小 TTL 大于 0 时会无视 no-cache/private。, confusable: Cache Policy vs Origin Request Policy }
      - { domain: secure, text: 动态内容必须 CachingDisabled；缓存了带用户身份的响应，就等于泄露数据。 }

  # ── 步骤 5：/media 改为 S3 源站（storage 为 s3 时）──────────────
  - id: media-origin
    type: config
    variant: media-s3
    when: "driver.storage == 's3'"
    title: /media/* 改为 S3 源站（OAC，三阶段）
    why: storage 已经是 s3（Lab 4）。如果 /media/* 仍回源 EC2，CloudFront 会缓存指向会过期预签名 URL 的 302（DEP-028），cdn 为 degraded。
    estMinutes: 15
    methods:
      script:
        runsOn: ops
        command: scripts/module enable cdn --param MediaOrigin=s3
        preview: scripts/module enable cdn --param MediaOrigin=s3 --dry-run
        creates:
          - 把 CdnDistributionArn 注入 storage 栈：展示桶策略只允许 cloudfront.amazonaws.com 读取 variants/*（AWS:SourceArn = 本分配）
          - 分配新增 s3-media 源站（OAC，签名行为“始终”）与去掉 /media 前缀的 CloudFront Function
          - modules.d/cdn.env：CDN_MEDIA_ORIGIN=s3
      console:
        region: global
        breadcrumb: [CloudFront, 源访问, 创建控制设置]
        instructions:
          - （路线 M）先创建 OAC（源类型 S3，签名行为“始终”）。
          - 在分配里新增源：展示桶 `{{envfile.storage.STORAGE_S3_MEDIA_BUCKET}}` 的区域 REST 端点，选择刚建的 OAC。
          - 把 /media/* 行为的源改为该 S3 源，并挂 viewer-request 函数去掉 /media 前缀。
          - 按控制台提示复制桶策略：只授权 variants/*，条件 AWS:SourceArn = 分配 ARN。
    expected: { text: CDN_MEDIA_ORIGIN=s3；分配有一个带 OAC 的 S3 源；展示桶策略只授权 CloudFront 读取 variants/*；cdn 不再 degraded。 }
    checks:
      - id: env-media
        type: local
        title: CDN_MEDIA_ORIGIN = s3
        probe: env-key
        params: { module: cdn, key: CDN_MEDIA_ORIGIN }
        assert: [{ path: $.value, op: eq, value: s3 }]
        reproduce: { run: 'grep ^CDN_MEDIA_ORIGIN= /etc/cloudalbum/modules.d/cdn.env', runsOn: ec2 }
      - id: oac
        type: aws-readonly
        title: S3 源站带 OAC
        service: cloudfront
        action: GetDistributionConfig
        region: global
        params: { Id: '{{var.distributionId}}' }
        assert: [{ path: '$.DistributionConfig.Origins.Items', where: { Id: s3-media, OriginAccessControlId: { op: exists } }, op: len_eq, value: 1, label: 带 OAC 的 S3 源 }]
        reproduce: { run: "aws cloudfront get-distribution-config --id {{var.distributionId}} --query 'DistributionConfig.Origins.Items[?Id==`s3-media`].OriginAccessControlId'", runsOn: ops }
        manualFallback:
          where: { breadcrumb: [CloudFront, 分配, '{{var.distributionId}}', 源] }
          observed: { question: s3-media 源的“源访问”一栏是什么？, options: [{ value: oac, label: 源访问控制设置（OAC）, expected: true }, { value: public, label: 公开, fixHint: 选择 OAC，并按提示更新桶策略 }] }
      - id: bucket-policy
        type: aws-readonly
        title: 展示桶策略只允许本分配读取 variants/*
        service: s3
        action: GetBucketPolicy
        params: { Bucket: '{{envfile.storage.STORAGE_S3_MEDIA_BUCKET}}' }
        assert:
          - { path: '$.Policy|json.Statement', where: { Principal.Service: cloudfront.amazonaws.com }, op: len_gte, value: 1, label: CloudFront 服务主体 }
          - { path: '$.Policy|json.Statement[0].Resource', op: matches, value: '/variants/\*$', label: 资源范围 }
          - { path: '$.Policy|json.Statement[0].Condition.StringEquals.AWS:SourceArn', op: contains, value: '{{var.distributionId}}', label: SourceArn }
        reproduce: { run: 'aws s3api get-bucket-policy --bucket {{envfile.storage.STORAGE_S3_MEDIA_BUCKET}} --query Policy --output text', runsOn: ops }
        manualFallback:
          where: { breadcrumb: [S3, '{{envfile.storage.STORAGE_S3_MEDIA_BUCKET}}', 权限, 存储桶策略], region: app }
          confirm: [Principal 为 cloudfront.amazonaws.com, Resource 以 /variants/* 结尾, 条件 AWS:SourceArn 为本分配]
      - id: not-degraded
        type: capability
        title: cdn 状态为 ok（没有 DEP-028 警告）
        module: cdn
        assert: [{ path: $.status, op: eq, value: ok }]
        reproduce: { run: 'curl -s http://127.0.0.1/api/capabilities | jq ".modules.cdn.status, .validation.warnings"', runsOn: ec2 }
    saa:
      - { domain: secure, text: OAC 的请求由 CloudFront 服务主体签名，不属于“公有访问”，所以桶的阻止公有访问 4 项全开也能用；新建一律用 OAC，不用 OAI。, confusable: OAC vs OAI }

  # ── 步骤 6：after ─────────────────────────────────────────────
  - id: after
    type: experiment
    stage: after
    experiment: ttfb
    title: 记录 after：同一实验分别测直连与经 CloudFront 两个目标
    estMinutes: 10
    methods:
      cli:
        runsOn: ops
        commands:
          - run: npm run exp -- cdn --label after --scenario ttfb --upload
            explain: 运行器按目标（direct、cdn）分组记录每个响应的 X-Cache、X-Amz-Cf-Id 与 X-CloudAlbum-Path（缓存命中的响应也带着回源时生成的路径头），用实验上传令牌上传。建议在 us-east-1、eu-west-1 等远离东京的区域的 CloudShell 中各跑一次，差异会更明显。
          - run: npm run exp -- cdn --label after --scenario media-load --upload
            explain: （选做）源站负载对比。
    expected: { text: 出现一条有效的 after 记录：直连目标 entry=nginx、CloudFront 目标 entry=cloudfront>*，各自占比 ≥ 95%；实验详情页自动生成三列对比：before（直连）、after·直连、after·CloudFront。 }
    checks:
      - { id: exp-pair, type: experiment, title: before 与 after 都有效且可比（按目标分组校验）, experiment: ttfb, stage: pair }

  # ── 步骤 7：收紧直连（选做加固，排在 after 之后）────────────────
  - id: lock-direct
    type: config
    title: （选做加固）收紧 EIP 直连，只允许你的 IP
    optional: { when: 'true', reason: 收紧后直连入口只有你自己能用；after 实验从 CloudShell 直连对照，所以本步排在 after 之后 }
    why: 只要 EIP 对全网开放，攻击者就可以绕过 CloudFront（以及之后的 WAF）直连 EC2。CloudShell 的出口 IP 不在你的 /32 内，实例自己请求 public-ip 也会被拦截，所以要等 after 实验做完再收紧；之后如需补测，先临时追加 CloudShell 出口 IP。
    estMinutes: 5
    methods:
      cli:
        runsOn: ops
        commands:
          - run: scripts/module enable cdn --param DirectAccess=admin-ip --param AdminCidr={{var.myCidr}}
            explain: 映射为 CDN_DIRECT_ACCESS=admin-ip，并重算基础栈的 PublicHttpIngress（参数名以 cdn 模块模板为准）。之后请用 https://{{var.cdnDomain}}/console 访问控制台。
    expected: { text: '实例安全组的 80/443 只对 {{var.myCidr}} 开放；经 CloudFront 访问照常。' }
    checks:
      - id: direct-access-env
        type: local
        title: CDN_DIRECT_ACCESS 已收紧
        probe: env-key
        params: { module: cdn, key: CDN_DIRECT_ACCESS }
        assert: [{ path: $.value, op: in, value: [admin-ip, closed] }]
        reproduce: { run: 'grep ^CDN_DIRECT_ACCESS= /etc/cloudalbum/modules.d/cdn.env', runsOn: ec2 }
      - id: sg-no-world
        type: aws-readonly
        title: 挂在实例上的所有安全组都没有对全网开放 80/443 的规则
        service: ec2
        action: DescribeSecurityGroupRules
        params: { Filters: [{ Name: group-id, Values: '{{sgIds}}' }] }   # 列表变量：实例上挂的全部安全组，不只是基础组
        assert:
          - path: $.SecurityGroupRules
            where:
              IsEgress: false
              # 端口条件：全部流量（IpProtocol = -1，FromPort = ToPort = -1），或端口区间与 80/443 有交集
              port: { op: some, value: [{ IpProtocol: '-1' }, { FromPort: { op: lte, value: 80 }, ToPort: { op: gte, value: 80 } }, { FromPort: { op: lte, value: 443 }, ToPort: { op: gte, value: 443 } }] }
              # 来源条件：IPv4 全网或 IPv6 全网
              source: { op: some, value: [{ CidrIpv4: 0.0.0.0/0 }, { CidrIpv6: '::/0' }] }
            op: len_eq
            value: 0
            label: 对全网开放 80/443 的入站规则条数
        explain: '“port”和“source”是 where 的具名条件组，组内 some 表示满足任一子条件，组与组之间同时满足。'
        reproduce:
          run: "aws ec2 describe-security-group-rules --filters Name=group-id,Values=$(echo {{sgIds}} | tr ' ' ',') --query 'SecurityGroupRules[?!IsEgress && (CidrIpv4==`0.0.0.0/0` || CidrIpv6==`::/0`)].[GroupId,IpProtocol,FromPort,ToPort]' --region {{region}}"
          runsOn: ops
        manualFallback:
          where: { breadcrumb: [EC2, 安全组, 入站规则], region: app }
          observed:
            question: 实例上挂的每个安全组中，80、443 或“全部流量”的来源里还有 0.0.0.0/0 或 ::/0 吗？
            options:
              - { value: no, label: '没有，只有 {{var.myCidr}} 与 CloudFront 前缀列表', expected: true }
              - { value: yes, label: 还有, fixHint: 重跑本步命令；不要手工修改基础栈管理的规则 }
    saa:
      - { domain: secure, text: 保护自定义源站：托管前缀列表 + 自定义头 + 收紧直连；更彻底的做法是内部 ALB + VPC Origin（Lab 19–20）。, confusable: 前缀列表 vs 自定义头 }

compare:
  required: true
  kind: metric
  experiment: ttfb
  evidence: client                # 边缘命中不回源，服务端样本既不完整也无法按 runId 归属（§4.7）
  runners: [cli, browser]         # browser 的结果只作参考
  stages:
    - label: before
      title: 直连 EC2（基线）
      drivers: { cdn: ['off'] }
      validity: { segment: entry, pattern: ['nginx'], minRatio: 0.95, minSamples: 100 }
    - label: after
      title: 直连 与 经 CloudFront
      drivers: { cdn: ['cloudfront'] }
      validity:
        segment: entry
        pattern: ['nginx', 'cloudfront>*']
        byTarget:
          direct: { segment: entry, pattern: ['nginx'] }
          cdn: { segment: entry, pattern: ['cloudfront>*'] }
        minRatio: 0.95
        minSamples: 100           # 按每个目标的客户端样本分别计数
  liveCompare:
    mode: dual-url
    request: { method: GET, path: '/assets/{{sample.assetPath}}?lab={{sample.nonce}}' }
    reason: 'CDN_ORIGIN_DIRECT_URL 与 CDN_BASE_URL 同时在线；API 层还可以用 X-Compare-Bypass: cdn 让图片 URL 改回源站。双 URL 对比由服务端执行（引擎分别请求 target=public-ip 与 target=cdn，结果推回页面），不要求学员从 http://EIP 打开控制台，因此 HTTPS 入口与 cognito 模式下照常可用'
  metrics:
    - { id: ttfb-hit-p50, label: 首字节时间 p50（命中）, unit: ms, source: 'client.latencyMs.ttfb.hit.p50', better: lower }
    - { id: ttfb-p95, label: 首字节时间 p95, unit: ms, source: 'client.latencyMs.ttfb.all.p95', better: lower }
    - { id: hit-ratio, label: 边缘命中率, unit: '%', source: 'client.cdnHitRatio', better: higher }
    - { id: origin-reqs, label: 源站请求数, unit: count, source: 'server.originOffload.requests', better: lower }
    - { id: origin-tx, label: EC2 出站字节, unit: bytes, source: 'server.host.netTxBytes', better: lower }
  explain: |
    命中时首字节时间 {{metrics.ttfb-hit-p50.before}} → {{metrics.ttfb-hit-p50.after}} ms；源站请求数从 {{metrics.origin-reqs.before}} 降到 {{metrics.origin-reqs.after}}。
    在东京本地测，两者差别可能很小；离东京越远，收益越明显。第一次（Miss）经 CDN 与直连接近，甚至略慢。

exam:
  points:
    - { title: CloudFront 的证书必须在 us-east-1, body: 给分配绑定自定义域名时，ACM 证书只能来自 us-east-1；CLOUDFRONT 范围的 WAF 也一样。, domain: secure, relatesTo: tls.request-cert }
    - { title: 自定义源站只能是域名, body: EC2/ALB 源站用托管前缀列表 + 自定义头保护；VPC Origin 让源站完全私有。, domain: secure, relatesTo: cdn.create-distribution }
    - { title: 三种策略分工, body: 缓存策略（缓存键与 TTL）、源请求策略（转发什么）、响应头策略（CORS、安全头、Server-Timing）。, domain: performance, relatesTo: cdn.behaviors }
  confusables:
    - { a: 缓存失效（Invalidation）, b: 版本化文件名, rule: 发布频繁时用带哈希的文件名；失效有配额和费用，生效也有延迟 }
    - { a: CloudFront, b: Global Accelerator, rule: 可缓存的 HTTP 内容选 CloudFront；TCP/UDP、静态 Anycast IP、快速区域故障转移选 Global Accelerator }
    - { a: OAC, b: OAI, rule: 新建一律用 OAC；它支持 SSE-KMS 和所有区域 }
  quiz:
    - id: cdn-q1
      domain: secure
      stem: 你要给 CloudFront 分配绑定 album.example.com，应用部署在 ap-northeast-1。ACM 证书应该在哪个区域申请？
      options: [ap-northeast-1, us-east-1, 任意区域，CloudFront 会自动复制, 不需要证书]
      answer: 1
      explain: CloudFront 只能使用 us-east-1 的 ACM 证书。
      relatesTo: tls.request-cert
    - id: cdn-q2
      domain: performance
      stem: 经 CloudFront 访问时，已登录用户调用 /api/me 返回 401，直连 EC2 正常。最可能的原因是？
      options: [价格级别太低, /api/* 没有转发 Authorization 和 Cookie 的源请求策略, 没有开启压缩, 源站协议是 http-only]
      answer: 1
      explain: CachingDisabled 下，Authorization 只能靠转发全部查看器值的源请求策略（如 AllViewer）带到源站。
      relatesTo: cdn.behaviors

cleanup:
  commands:
    - { run: scripts/module disable cdn, runsOn: ops, dangerous: true, dangerNote: 将删除 CloudFront 分配（路线 S 创建的）；已发出的 CDN 链接会失效, explain: 路线 S：禁用并删除分配（需要数分钟）；移除 8080 监听器、源站安全组与刷新定时器；媒体 URL 改回源站 }
  dataRisk: [没有业务数据；已发出的含 CDN 绝对链接的邮件会失效]
  manual:
    - where: { breadcrumb: [CloudFront, 分配, '{{var.distributionId}}'], region: global }
      confirm: [（路线 M）先“禁用”分配，等待状态变为已部署（约 5–15 分钟）, 再“删除”分配]
  verify:
    - { id: cap-off, type: capability, title: cdn 已回到 off, module: cdn, assert: [{ path: $.status, op: eq, value: 'off' }], reproduce: { run: 'curl -s http://127.0.0.1/api/capabilities | jq .modules.cdn.status', runsOn: ec2 } }
    - id: dist-gone
      type: aws-readonly
      title: 分配已删除
      service: cloudfront
      action: GetDistribution
      region: global
      params: { Id: '{{var.distributionId}}' }  # disable 会删除 cdn.env；这里取 wire 达成时固化的快照值，界面注明“取自 10/05 启用时的记录”
      expectError: NoSuchDistribution
      waitable: true
      reproduce: { run: 'aws cloudfront get-distribution --id {{var.distributionId}} --query Distribution.Status', runsOn: ops }
      manualFallback:
        where: { breadcrumb: [CloudFront, 分配] }
        observed: { question: '列表里还有 {{var.distributionId}} 吗？', options: [{ value: gone, label: 没有了, expected: true }, { value: exists, label: 还在, fixHint: 先禁用，等部署完成后再删除 }] }
  reEnableMinutes: 15
```

断言中的 `'{{$.first.json.now}}'` 表示引用同一检查中第一次响应的值，`'{{$.request.host}}'` 表示本次请求实际使用的主机名；这是 `http-header` 检查唯一允许的两种自引用形式。被引用的字段缺失时断言判 fail（§5.8）。`where` 中的具名条件组（例如 `sg-no-world` 的 `port`、`source`）是 `{op: some, value: [子条件…]}` 的简写：组内满足任一子条件即可，组与组之间同时满足。

### 5.11 内容质量门禁（`npm run guides:lint`，CI 中执行；服务启动时也会执行一次）

1. 通过 schema 校验；`id` 在注册表中存在；`course.yaml` 的 Lab 编号、模块集合与档位和总纲 §10.3 的快照一致（§4.12）；模块所属的 Lab 与注册表、档位文件一致。
2. 步骤骨架符合 §5.4：除 `localTier` 步骤外第一档实验在最前；实验步骤按 `stages` 顺序出现；恰好一个 wire；wire 之前至少有一个 config；最后一档实验是最后一个必做步骤，之后只允许 `optional` 步骤（ec2 例外：没有实验与 wire）。
3. wire 步骤至少包含一项 capability 检查和一项实际流量证据（`http-header`、`path-seen`、`session`，或纯基础设施型模块的感知器检查），并声明 `impact`。
4. 除 `manual`、`experiment` 外的每个检查都声明了 `reproduce`；每个 `aws-readonly` 检查都声明了 `manualFallback`，`manualFallback.evidence.command` 带 `--query` 投影；`service:action` 在 Verifier 白名单中，并且有对应的响应投影白名单（§6.6、§6.7）。
5. 所有检查用到的 `service:action` 汇总后，与 `npm run guides:policy` 生成的 `cloudalbum-<env>-lab-verifier` 策略文档做差异比对：有缺失时 CI 失败，并打印需要添加的 action；各组指南写完后都要重新生成一次。
6. 变量引用都能解析；不允许出现密钥类变量；`from: input` 的变量都声明了 `pattern`，且是合法的 RE2；命令中的变量没有写在引号内部；表达式语法合法，引用的模块、env 键（属于该模块 `ownsEnv` 且不是机密类键）都存在。
7. **断言模拟评估**：用 `guides/_probe-fixtures/<service>.<action>.json` 中的示例响应（先经投影白名单裁剪）对每个 `aws-readonly` 断言求值一次，确认路径存在、管道变换可用、类型匹配；`http-header` 断言用指南中的 `expected.sample` 求值。模拟结果出现“字段缺失”或 `ASSERT_TYPE` 时 CI 失败。
8. 每个 `pitfalls[].fix.gotoStep` 都指向存在的步骤，`gotoSub` 不超过该步骤控制台做法的小步数。
9. 每个模块都有 `cleanup.verify`；删除类命令都标了 `dangerous` 并写了 `dangerNote`；`startsBilling.rateKeys` 都是 cost 模块定义的计费维度（不要求有单价）。
10. `ConsoleMethod.region` 为 `us-east-1` 时必须写 `regionReason`；S3、RDS 等区域性资源的步骤不得标为 `global`。
11. `supersededWhen.byLab` 必须是 course.yaml 中存在、且晚于本模块所在 Lab 的编号。
12. 出错时，界面在 S13 的“指南”标签页显示文件名、行号和错误信息；出错的模块显示“指南不可用”，不影响其他模块。还没有手写指南、由注册表生成占位步骤的模块，在 S06-2 和 S13 中明确标为“占位指南”，不与真实指南混在一起展示。

---
## 6. 自动检测引擎

### 6.1 结构

```text
 浏览器（控制台）                         EC2：cloudalbum-api 进程（ASG 时每台都有，状态只在共享库）
 ┌──────────────┐  POST /checks/run   ┌──────────────────────────────────────────────────────────────┐
 │ 指南 / 检测   │ ──────────────────▶ │ CheckRunner                                                    │
 │ 报告 / 抽屉   │                     │  ├ 解析：guides/*.yaml（启动时校验 + 内存缓存）                  │
 │              │ ◀── SSE 事件 ─────── │  ├ 变量：VariableResolver（IMDS / capabilities / env / 快照 / 输入）│
 │              │   /api/console/events│  ├ 调度：按来源分池 + 速率限制 + 去抖；周期任务走数据库租约        │
 │ 浏览器执行器  │ ── browser-results ▶ │  ├ 执行器：                                                     │
 └──────────────┘   （①′，带任务 nonce）│  │   LocalExecutor ─ probe 白名单（imds/port/disk/nginx-log…）    │
                                      │  │   HttpHeaderExecutor ─ target 枚举 → 主机；探测令牌；不跟随重定向│
 运维机                                │  │   PathSeenExecutor ─ 查询 LabMetricsStore 汇总（排除探测请求）  │
 ┌──────────────┐  POST /api/lab/runs │  │   SessionExecutor ─ 读当前请求的已验签 Principal               │
 │ npm run exp  │  POST /api/lab/results  │   CapabilityExecutor ─ 读能力注册表（多实例按多数聚合）        │
 │ --upload     │ ──────────────────▶ │  │   AwsReadonlyExecutor ─ AssumeRole Verifier → 白名单 SDK 调用  │
 │（实验上传令牌）│                     │  │   ExperimentExecutor ─ 读 experiment_runs + 有效性校验         │
 └──────────────┘                     │  │   ManualExecutor ─ 读 manual_confirmations                     │
                                      │  ├ 投影：Projector（按 service:action 的响应投影白名单裁剪）       │
                                      │  ├ 断言：Assertion 求值（无 eval；管道变换、数值转换、缺失语义）   │
                                      │  ├ 匹配：Pitfall 匹配                                             │
                                      │  ├ 脱敏：Redactor（键名 + Name/Value 数组 + URL 内嵌口令）         │
                                      │  └ 写入：check_runs（只追加，按保留策略压缩）→ ProgressEvaluator  │
                                      │                     → step/module/lab → console_events（自增序列）│
                                      │                                         └→ SSE 总线              │
                                      └──────────────────────────────────────────────────────────────┘
```

**代码位置与依赖边界：**
- 代码放在 `backend/src/console/`，包括 `checks/`、`progress/`、`verifier/`、`recommend/`、`routes/`、`leases/`。
- AWS SDK 只允许出现在 `console/verifier/` 中，需要加入总纲 ESLint `no-restricted-imports` 的白名单（附录 B-6）。
- `AwsReadonlyExecutor` 通过动态 `import()` 加载 SDK，只在检测能力不为 `local` 时才会加载。因此 L0 进程**不加载 AWS SDK，也不发出任何 AWS API 调用**，满足总纲目标 G1。IMDS 是链路本地地址，不属于 AWS API。
- 检测器的 AWS 调用一律先用实例角色 `sts:AssumeRole` 到 `cloudalbum-<env>-lab-verifier-role`（`RoleSessionName=console-verifier`），再用这份临时凭证调用只读 API；应用本身的 SDK 客户端从不持有 Verifier 权限（§6.7）。

### 6.2 执行位置

| 执行位置 | 用于 | 说明 |
|---|---|---|
| EC2 后端 | `aws-readonly`、`experiment`、`manual`、`path-seen`、`session`；`from: server` 的 `http-header` | 证据中记录执行它的 `instanceId`、`az` |
| EC2 后端，按 `instanceScope` 选择实例 | `local`、`capability` | `serving`（默认）：处理这次请求的实例；`any`：任意一台；`all`：逐台执行——引擎经各实例私有 IP 上的内部端点 `POST /api/console/internal/run-local`（只绑定 VPC 内网地址，HMAC 签名，密钥来自引导配置包）调用，没有直连路由时改用 SSM Run Command；有效结果按 `(check_id, instance_id)` 分别计算后再聚合（§4.3）。capabilities 按多数实例聚合，少数实例不一致时加注“2/3 台为 ok” |
| 浏览器 | `from: browser` 的 `http-header`（①′）；浏览器运行器（S08 的轻量实验，只作参考） | 服务端在 run 中下发带一次性 `taskNonce` 的 browser task；前端用 `fetch` 执行后，回传到 `POST /api/console/checks/runs/:runId/browser-results`。服务端校验结构、nonce 与时间窗，并标记 `LOCAL_CLIENT` |
| 运维机 | 对比实验的正式运行（`npm run exp … --upload`） | 先 `POST /api/lab/runs` 登记（服务端此时保存 capabilities 快照），运行结束后用实验上传令牌写入 `POST /api/lab/results`（总纲 §8.2）。有效性校验延后到 rollups 补齐之后（§4.7） |

**多实例（ASG）下的状态一致性**：
1. 进度、检查结果、确认记录、实验记录、控制台事件**只存共享数据库**。`DEPLOY_MODE=asg` 时数据库必然是 RDS（总纲 ASG-002），各实例不在本地盘写任何进度数据；`progress-snapshot.json` 只在单实例模式下写，ASG 模式下不写（或改写到 S3 的 `console/snapshots/` 前缀，由 storage 模块的桶提供）。
2. 单实例使用的内存状态（轮询计划、去抖表、AWS 响应缓存）在多实例下允许各自独立，但所有“只应发生一次”的任务都通过数据库租约执行（§6.4）。
3. 探测令牌的 HMAC 密钥放在 `secrets.env`（单实例）或引导配置包（ASG），所有实例一致；一次性 nonce 记录在共享库（或 Redis），并允许同一个 nonce 在 30 秒窗口内被**幂等复用**（CloudFront 回源重试会重复送达同一请求）。

### 6.3 触发方式

| 触发 | 范围 | 说明 |
|---|---|---|
| 学员点击“检测”（步骤卡底部、检查行） | 本步 / 单项 | 主路径。快捷键 `R` |
| 在“检测”上按 Shift+单击，或模块详情中的“检测整个模块” | 模块 | — |
| 进入步骤页 | 本步 | 上次检测超过 10 分钟（③ 为 1 小时）时自动执行，见 §4.14 |
| 模块启停事件 | 该模块及其反向依赖的已达成步骤 | 由状态文件监视发现（§4.13），不依赖应用重启；租约保证只执行一次 |
| capability 状态变化 | 该模块 wire 步骤中的检查 | 订阅总纲的状态机事件 |
| 凭证从无到有 | 所有降级确认对应的原始检查 | §4.8 第 5 条 |
| 等待型轮询 | pending 的检查 | §6.5 |
| 实验记录的延迟校验 | 刚上传的实验记录 | rollups 补齐后重新计算（§4.7） |
| “复核全部”（S10、S13） | 全部已达成的步骤 | 每 10 分钟最多 1 次；检测能力为“仅本地”时禁用 |
| 定时检测（默认关闭） | 已完成的模块 | 可在 S13 开启：①② 每 15 分钟一次，③ 每 6 小时一次；计费类读取（§6.7）不参与定时检测 |

### 6.4 并发、超时、速率限制与租约

| 项 | 值 |
|---|---|
| 单项检查超时 | 默认 10 秒，最长 30 秒（`timeoutMs`） |
| 单次 run 总超时 | 120 秒；超时后剩余的检查记为 `error/TIMEOUT` |
| 每个实例同时运行的 run | 最多 2 个；超出的进入排队，并通过 SSE 推送 `run.queued` |
| 池：local | 并发 4 |
| 池：http-header | 并发 4；同一个目标主机并发 2 |
| 池：aws-readonly | 并发 2；令牌桶限速：全局 5 次/秒，每个服务 2 次/秒，`cloudtrail:LookupEvents` 1 次/秒（官方限制为每账号每区域 2 次/秒）。多实例时全局配额按在线实例数均分 |
| 去抖 | 同一检查 10 秒内重复触发时，复用正在运行的 run（多实例时以 `check_runs` 中 running 状态的行为准） |
| 限流重试 | 遇到 `Throttling*` 或 `TooManyRequests` 时按指数退避（0.5s、1s、2s）最多重试 3 次，仍失败则记为 `error/THROTTLED` |
| 会话限速 | 每个管理员每分钟最多 30 次 `checks/run`，超出返回 429 |

**租约（单点执行）**：以下任务在多实例下只允许一台执行，用数据库租约保证——PostgreSQL 上用 `pg_try_advisory_lock`，SQLite（单实例）上用 `console_leases` 表（§10.2，`name` 主键、`holder`、`expires_at`，持有者每 20 秒续约，60 秒未续约即可被抢占）：

| 租约名 | 任务 |
|---|---|
| `poll-scheduler` | 等待型检查的轮询调度（§6.5） |
| `state-diff` | 比对 `modules.state.json` 与 `module_events`、启停后复检（§4.13） |
| `scheduled-detect` | 定时检测 |
| `startup-recheck` | 应用启动后的复检（N 台实例同时启动时只跑一次） |
| `compact` | `console.compact` 保留策略压缩（§10.3） |
| `exp-validate` | 实验记录的延迟校验 |

### 6.5 等待型检查的轮询

- 声明了 `waitable: true` 的检查，以下几种情况都记为 `pending`，而不是 `fail`：
  - 结果为 `pending`；
  - 结果为超时或 5xx，并且距离步骤开始的时间小于 `waitHint.maxMinutes`。
- 复测计划写在共享库（`check_polls` 表，§10.2），由持有 `poll-scheduler` 租约的实例执行，间隔依次为 15、30、45、60 秒，之后每 60 秒一次，直到结果不再是 pending，或者达到 `maxMinutes`（默认 30 分钟）。达到上限时记为 `fail`，并匹配“等待超时”类的常见错误。实例被替换（autoscaling 实验本身就会触发）时，租约转移到其他实例，计划不丢失。
- 浏览器端显示 `WaitTimer`：“已等待 2:10 · 通常 5 分钟 · 下次检测 0:15”。等待期间显示 `readWhileWaiting` 内容。
- **暂停条件**：所有实例上都没有 SSE 订阅者超过 5 分钟时暂停轮询，下次进入页面时再恢复，以免学员关掉页面后仍在持续调用 AWS API。订阅者计数由各实例每 30 秒写入共享库（`console_leases` 中 `presence:<instanceId>` 行，`data_json` 记录订阅数），持有租约的实例汇总全部实例的计数后判断，不按单实例判断。

### 6.6 结果缓存与响应投影

| 缓存 | 键 | TTL | 说明 |
|---|---|---|---|
| AWS 响应缓存 | (region, service, action, 规范化后的 params) | 60 秒 | 每个实例的内存 LRU，最多 500 条，**只缓存投影之后的结果**。“再测一次”带 `force=true` 时跳过缓存，但仍受速率限制 |
| 变量解析缓存 | 变量名 | IMDS 5 分钟、capabilities 5 秒、env 文件按 mtime | — |
| 检测能力诊断（§6.8） | — | 10 分钟 | 点击“重新探测”时清空 |
| 结果新鲜期 | — | 见 §4.14 | 不是缓存，用于显示“过期”标记和决定是否自动重测 |

**响应投影白名单。** 白名单中的 action 虽然都是只读，但有一些会回显密钥或会话。引擎拿到 AWS 响应后，**先按该 `service:action` 的投影白名单只保留断言用得到的字段**，再交给断言、缓存和证据；不在白名单中的字段从不进入内存缓存、数据库或界面。投影白名单由 `guides:lint` 从所有指南的断言路径自动汇总，再与下面的“默认丢弃清单”求差（丢弃清单优先）：

| 默认丢弃（即使断言引用了也不保留，lint 直接报错） | 来自 |
|---|---|
| `Origins.Items[].CustomHeaders.Items[].HeaderValue`（X-Origin-Verify 源站密钥） | `cloudfront:GetDistributionConfig`、`GetDistribution` |
| `Environment.Variables`（Lambda 环境变量，lazy 迁移变体的 internal-hmac-key 在这里） | `lambda:GetFunctionConfiguration`、`GetFunction` |
| `LaunchTemplateData.UserData` | `ec2:DescribeLaunchTemplateVersions` |
| `UserPoolClient.ClientSecret` | `cognito-idp:DescribeUserPoolClient` |
| `Headers[].Value`、`Cookies`、`Authorization` 任何形式的请求头值 | 任何返回请求样本的 action（本项目不授予这类 action，见 §6.7） |
| `SecretString`、`SecretBinary`、`Parameter.Value`（SecureString） | 本项目不授予 `GetSecretValue` 与带解密的 `GetParameter`；列在这里作为兜底 |

- `assertions_json` 中的 `actual` 只存标量或计数（例如“校验头 ×1”“对全网开放的规则 0 条”），不存对象或数组；数组过滤的结果只存命中条数和非敏感的标识字段。
- 证据粘贴（[M+]）走同一个 Projector：粘贴内容按 `evidence.command` 对应的 action 投影后才求值，原文不入库。
- Redactor 是第二道防线（§6.10 第 3 条）。

### 6.7 检测器的只读身份：Verifier 角色与策略

**身份结构。** 检测器不直接使用应用的实例角色，而是扮演一个单独的只读角色。这样应用本身（以及能访问 IMDS 的任何主机进程）拿不到检测器的读取范围；CloudTrail 中检测器的每次调用都能按会话名审计。

| 资源（由 iam 栈创建，B 组文档 `02-identity-security.md#iam`） | 内容 |
|---|---|
| 角色 `cloudalbum-<env>-lab-verifier-role` | 信任策略只允许 `CloudAlbumAppRole` 执行 `sts:AssumeRole`，并要求 `sts:RoleSessionName = console-verifier`；`MaxSessionDuration` 3600 秒；通过 `ManagedPolicyArns` 引用下面的托管策略 |
| 托管策略 `cloudalbum-<env>-lab-verifier` | 只读策略本体，由 `npm run guides:policy` 生成。名称带环境前缀，同一账号的多套环境、多个区域不会冲突 |
| 托管策略 `cloudalbum-<env>-lab-verifier-account`（可选） | 账号级读取：`cloudtrail:LookupEvents`（audit 的“谁改了安全组”）、`ce:GetCostAndUsage`（按次计费）。默认不创建；学员在 S13 勾选后，控制台生成命令 `scripts/module enable iam --param VerifierAccountReads=on`，由学员在运维机执行 |
| `CloudAlbumAppRole` 上的一条内联语句 | `sts:AssumeRole`，Resource 只有上面那个 Verifier 角色 |

- 遵守总纲原则 8 与 §9.1：托管策略模板**不写** `Roles:`/`Users:`，由角色自身的 `ManagedPolicyArns` 引用；托管策略配额的统计相应多出 1–2 个（附录 B-7）。
- 策略的 `Description` 固定不变（`AWS::IAM::ManagedPolicy` 的 Description 改动需要替换资源，而指定了 `ManagedPolicyName` 的资源无法被替换，栈更新会失败）。**版本号写在第一条语句的 `Sid` 中**（例如 `VerifierV3ScopedRead`），更新时只改 `PolicyDocument`，CloudFormation 会为托管策略创建新版本并设为默认版本。
- 版本比对：诊断时用 `iam:GetPolicy` 取 `DefaultVersionId`，再用 `iam:GetPolicyVersion` 读取文档（URL 编码，用 `|urldecode|json` 解析），计算规范化后的哈希，与仓库生成文档的哈希比较；不一致即 `POLICY_OUTDATED`，并显示逐条差异。
- **结课后移除**：清理向导（S11b）的最后一步提供 `scripts/module enable iam --param LabVerifier=off`（删除 Verifier 角色与两条策略，标为删除类命令）。删除后检测能力回到“仅本地”，已完成的检查不倒退。

**策略内容。** 只授予 `Describe*`/`Get*`/`List*` 以及 `budgets:ViewBudget`、`tag:GetResources`、`apigateway:GET` 这几个只读调用，**每个 action 都逐条列出，不使用通配符**。按资源是否支持资源级权限分成几条语句：

```yaml
# infra/modules/iam.yaml（节选）—— 由 npm run guides:policy 生成，请勿手改
  LabVerifierPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Sub 'cloudalbum-${Env}-lab-verifier'
      Description: 'CloudAlbum Learning Console read-only verifier (generated from guides/*.yaml; version in Sid)'
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Sid: VerifierV3ScopedRead          # 支持资源级权限的 action：Resource 收窄到本环境的资源
            Effect: Allow
            Action:
              - s3:GetBucketPolicy
              - s3:GetBucketPublicAccessBlock
              - s3:GetBucketVersioning
              - s3:GetEncryptionConfiguration
              - sqs:GetQueueAttributes
              - lambda:GetFunctionConfiguration    # 投影白名单丢弃 Environment（§6.6）
              - lambda:GetPolicy
              - dynamodb:DescribeTable
              - firehose:DescribeDeliveryStream
              - sns:GetTopicAttributes
              - cloudformation:DescribeStacks
              - logs:DescribeLogStreams
              - secretsmanager:DescribeSecret
              # …… 完整列表由 guides:policy 生成
            Resource:
              - !Sub 'arn:${AWS::Partition}:s3:::cloudalbum-${Env}-*'
              - !Sub 'arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:cloudalbum-${Env}-*'
              - !Sub 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:cloudalbum-${Env}-*'
              - !Sub 'arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/cloudalbum-${Env}-*'
              - !Sub 'arn:${AWS::Partition}:firehose:${AWS::Region}:${AWS::AccountId}:deliverystream/cloudalbum-${Env}-*'
              - !Sub 'arn:${AWS::Partition}:sns:${AWS::Region}:${AWS::AccountId}:cloudalbum-${Env}-*'
              - !Sub 'arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/cloudalbum-${Env}-*/*'
              - !Sub 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/cloudalbum/${Env}/*'
              - !Sub 'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:cloudalbum/${Env}/*'
          - Sid: VerifierV3TaggedRead          # 支持标签条件的 action：只能读打了本项目标签的资源
            Effect: Allow
            Action:
              - cloudfront:GetDistribution
              - cloudfront:GetDistributionConfig   # 投影白名单丢弃 CustomHeaders.Items[].HeaderValue；WAF 关联也从这里的 WebACLId 读取
              - cognito-idp:DescribeUserPool
              - cognito-idp:DescribeUserPoolClient # 投影白名单丢弃 ClientSecret
              - cognito-idp:DescribeUserPoolDomain
              - kms:DescribeKey
              - kms:GetKeyPolicy
              - rds:DescribeDBInstances
              # ……
            Resource: '*'
            Condition:
              StringEquals:
                'aws:ResourceTag/Project': CloudAlbum
                'aws:ResourceTag/Env': !Ref Env
          - Sid: VerifierV3DescribeAll         # 不支持资源级权限的 Describe/List：只能 Resource '*'，靠投影白名单控制返回内容
            Effect: Allow
            Action:
              - autoscaling:DescribeAutoScalingGroups
              - autoscaling:DescribeInstanceRefreshes
              - cloudfront:GetVpcOrigin
              - cloudfront:ListVpcOrigins
              - config:DescribeConfigurationRecorderStatus
              - ec2:DescribeAddresses
              - ec2:DescribeSecurityGroupRules
              - ec2:DescribeLaunchTemplateVersions # 投影白名单丢弃 UserData
              - elasticloadbalancing:DescribeTargetGroupAttributes
              - iam:GetAccountSummary              # 只返回计数（根账号 MFA 等）
              - imagebuilder:GetImagePipeline
              - inspector2:BatchGetAccountStatus
              - states:DescribeStateMachine
              - wafv2:GetWebACL
              - wafv2:ListWebACLs
              # ……
            Resource: '*'
          - Sid: VerifierV3Self                # 只能查看 Verifier 自身
            Effect: Allow
            Action: [iam:GetRole, iam:ListAttachedRolePolicies, iam:GetPolicy, iam:GetPolicyVersion, iam:SimulatePrincipalPolicy]
            Resource:
              - !Sub 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cloudalbum-${Env}-lab-verifier-role'
              - !Sub 'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/cloudalbum-${Env}-lab-verifier'
          - Sid: VerifierV3ApiGateway          # 只能读 HTTP API 的配置
            Effect: Allow
            Action: apigateway:GET
            Resource:
              - !Sub 'arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis'
              - !Sub 'arn:${AWS::Partition}:apigateway:${AWS::Region}::/apis/*'
```

- **计数口径统一**：“action 数”一律指主策略各语句合计（不含可选的账号级策略），诊断时按同一口径模拟。当前生成结果为 162 个；去掉空白后约 5.6K 字符，低于客户托管策略 6,144 字符的上限。接近上限时拆成 `cloudalbum-<env>-lab-verifier` 与 `…-lab-verifier-2`，都由 Verifier 角色的 `ManagedPolicyArns` 引用。
- 白名单要随指南补齐：各组指南写完后都要重新运行 `guides:policy`，并核对新增的 action（例如实例刷新、VPC Origin、目标组属性、F 组的 Step Functions、Config、Inspector、Image Builder）。
- **WAF 关联**：`wafv2:GetWebACLForResource` 不适用于 CloudFront，因此不授予；CLOUDFRONT 范围的 Web ACL 是否关联到分配，从 `cloudfront:GetDistributionConfig` 的 `WebACLId` 判断。CLOUDFRONT 范围的 `wafv2` 调用一律发往 us-east-1（指南中 `region: us-east-1`）。WAF 的拦截数从 CloudWatch 指标 `AWS/WAFV2 BlockedRequests` 读取。

**按量计费的读取**：`ce:GetCostAndUsage`、`cloudwatch:GetMetricData`、`xray:GetTraceSummaries`、`xray:GetServiceGraph` 在白名单中标记 `billable: true`。引擎只在学员手动触发时调用它们（点“检测”、点“查询 Cost Explorer”），进入页面的自动重测和定时检测都跳过；界面在按钮旁注明“按次计费”。

**刻意没有授予的权限**：这些权限要么会读到数据内容、密钥值或会话，要么本身是数据面操作。下面每一项都写进 `guides:lint` 的禁止列表：

| 不授予 | 理由 |
|---|---|
| `s3:GetObject`、`s3:ListBucket` | 会读取或列出用户照片。桶是否存在用 `GetBucketLocation` 判断 |
| `secretsmanager:GetSecretValue`、`ssm:GetParameter*` | 会读取密钥值或参数值。改用 `DescribeSecret`、`DescribeParameters` |
| `kms:Decrypt`、`kms:GenerateDataKey*` | 属于数据面加解密操作 |
| `dynamodb:GetItem`/`Query`/`Scan`、`sqs:ReceiveMessage` | 会读取业务数据或消息内容 |
| `lambda:GetFunction`、`lambda:GetLayerVersion` | 响应中包含代码包的下载 URL 与环境变量 |
| `lambda:ListFunctions` | 返回账号内**所有**函数的环境变量，且不支持资源级权限，无法收窄。需要的函数配置改用收窄到 `cloudalbum-<env>-*` 的 `GetFunctionConfiguration` |
| `cloudfront:ListDistributions` | `DistributionSummary` 中包含全部分配的源站自定义头（含源站密钥）。分配 ID 从 `cdn.env` 或快照中取得 |
| `wafv2:GetSampledRequests` | 返回采样请求的全部请求头，包括相册用户和管理员的 Cookie（`ca_at`、`ca_rt`）与 Authorization |
| `logs:GetLogEvents`、`logs:FilterLogEvents` | 会读取日志正文。日志是否送达用 `DescribeLogStreams` 判断 |
| `cognito-idp:ListUsers`、`cognito-idp:AdminGetUser` | 会读取用户个人信息。管理员组是否映射成功，用 `session` 检查从当前会话的 `cognito:groups` 判断 |
| `rekognition:*` | 会处理图片内容（数据面），调用也按次收费；tagging 的效果由 `app-stat: photos.withLabels` 判断 |

另有两点说明：
- `sts:GetCallerIdentity` 不需要任何权限，显式 Deny 也拦不住它（B 组文档 `02-identity-security.md#iam`），所以没有写进策略。
- 代码层面再加一道白名单：`backend/src/console/verifier/allowlist.ts` 由同一份汇总生成，同时包含每个 action 的响应投影白名单与 `billable` 标记。`AwsReadonlyExecutor` 遇到白名单之外的 `service:action` 时直接返回 `error/NOT_ALLOWED`，不会发出请求。

### 6.8 凭证探测与降级

诊断流程（`GET /api/console/diagnostics`，结果缓存 10 分钟）：

```text
1. IMDSv2 取 token                    失败 → 检测能力 = local（原因 IMDS_UNREACHABLE：跳数限制或 IMDS 已禁用）
2. iam 模块的模式                      none → local（NO_ROLE）
                                      keys → local（KEYS_MODE：检测器只用实例角色，不使用长期密钥；模块照常可用，只显示 CRED-002 提示）
3. IMDS iam/security-credentials/      404 → local（NO_ROLE）；有角色名 → 继续（检测器不读取凭证内容，交给 SDK 的 fromInstanceMetadata 处理）
4. sts:GetCallerIdentity               网络错误 → unreachable（私有子网没有 NAT 或终端节点，链接到 network 模块）
                                      RequestExpired 或 SignatureDoesNotMatch，且本机时钟与 Date 头相差超过 5 分钟 → clock
5. sts:AssumeRole(cloudalbum-<env>-lab-verifier-role, SessionName=console-verifier)
                                      AccessDenied 或角色不存在 → partial（NO_VERIFIER_ROLE）
6. iam:GetPolicy + GetPolicyVersion   策略不存在 → partial（NO_VERIFIER_POLICY）；文档哈希与仓库不一致 → partial（POLICY_OUTDATED）
7. iam:SimulatePrincipalPolicy        以 Verifier 角色为主体，对生成的 162 个 action 逐一模拟。资源级语句中的 action 按 action
                                      传入对应的 ResourceArns（由当前变量解析出的具体 ARN，例如 cloudalbum-lab-storage-media-…），
                                      不传 ResourceArns 只适用于 Resource '*' 的语句——否则 apigateway:GET（限定 /apis*）、
                                      iam:GetRole（限定具体 ARN）这类语句会被误判为“缺失”。
                                      有缺失 → partial（MISSING_ACTIONS），否则 full
   （模拟结果只用于预判；以实际调用为准：实际调用返回 AccessDenied 时，该 action 记入缺失清单）
```

| 检测能力 | `aws-readonly` 检查的结果 | 学员看到的内容 |
|---|---|---|
| `full` | 正常执行 | — |
| `partial` | 有权限的照常执行；缺权限的返回 `error/ACCESS_DENIED`，并提供手动确认 | “检测器缺少 cognito-idp:DescribeUserPoolDomain。修复：在运维机上执行 `scripts/module enable iam`，把策略更新到 VerifierV3。本次可以先手动核对。” |
| `local` | `unavailable`，进入待手动确认；之前自动通过的检查保持通过（§4.3） | 横幅：“14 项 AWS 检查改为手动确认，完成 Lab 1 · iam 后会自动复核。”每个检查都给出控制台路径、深链接、应该看到什么，以及“去核对”按钮 |
| `unreachable` | `error/UNREACHABLE`，提供手动确认 | “检测器无法访问 AWS API。实例在私有子网中，需要 NAT 或 STS 等接口终端节点。”并链接到 network 模块（这本身也是 SAA 考点） |
| `clock` | `error/CLOCK_SKEW` | “本机时钟偏差 7 分钟，签名被拒绝。请检查 chronyd：`chronyc tracking`” |

### 6.9 统一错误码与学员看到的文案

本表是 `error` 结果错误码的**唯一来源**，§4.3、§8、§9 都引用它。

| 错误码 | 含义 | 结果 | 文案示例 | 动作 |
|---|---|---|---|---|
| `TIMEOUT` | 超时 | error | “10 秒内没有响应。可能是资源还在创建，也可能是网络不通。” | 重试；可等待的检查自动转入轮询 |
| `THROTTLED` | 被限流 | error | “AWS 限流，已重试 3 次。请 30 秒后再试。” | 重试 |
| `ACCESS_DENIED` | 检测器缺少权限 | error | “检测器缺少 `elasticache:DescribeReplicationGroups`。这不是你的配置问题。” | 查看策略差异；本次改为手动确认 |
| `UNREACHABLE` | 无法连接 AWS API | error | “无法连接 AWS API。” | 打开检测能力页面 |
| `CLOCK_SKEW` | 时钟偏差 | error | 见 §6.8 | — |
| `NOT_FOUND_VAR` | 变量缺失或不符合 pattern | error | “还没有填写“分配 ID”。” | 定位到变量面板 |
| `NOT_ALLOWED` | action 不在白名单中 | error | “指南中的检查使用了不允许的 API（内容错误）。” | 查看指南校验结果 |
| `ASSERT_TYPE` | 断言的类型转换失败（`gte` 的值不是数字、`\|json` 解析失败等） | error | “字段 RedrivePolicy 不是合法的 JSON（指南或 API 返回格式有变化）。” | 复制诊断包 |
| `INTERNAL` | 引擎内部错误 | error | “检测器内部错误（已记录 req-id）。” | 复制诊断包 |
| AWS 资源不存在（`NoSuchDistribution` 等） | — | **fail**（检查声明了 `expectError` 时则为 pass） | “分配 E2QW… 不存在。可能是 ID 填错了，也可能已经被删除。” | 匹配常见错误 |

`PRECONDITION` 不是错误码：前置条件不成立时检查不执行，按 §4.3 记为 `skipped`（`when` 不成立或被取代），或由步骤、模块的 `locked` 状态表达（“storage 没有在运行，此项不适用”）。

### 6.10 安全

1. **只读，且只读范围最小。** 控制台后端不包含任何会修改 AWS 资源的调用。检测器扮演单独的 Verifier 角色，策略按资源收窄，响应按投影白名单裁剪（§6.6、§6.7）。实验中的服务端请求只发给本应用自己（总纲 §8.3 防滥用规则）。
2. **仅管理员，另有两种范围受限的令牌。**
   - 公开接口只有：`setup/status`、`setup/verify-token`、`setup/admin`（仅在未初始化时；初始化完成后一律 `410 Gone`）、`session/ticket`、`ping`。其余所有 `/api/console/*` 接口都要求有效的 `ca_console` 会话（§3.8）。
   - **探测令牌**（`probe/*` 与引擎发出的检查请求）：请求头 `X-CloudAlbum-Probe: <nonce>.<exp>.<hmac>`，60 秒内有效。HMAC 密钥放在 `secrets.env`（ASG 时在引导配置包中），所有实例共享；nonce 记录在共享库，同一 nonce 在 30 秒内可以被幂等复用（CloudFront 回源重试）。**权限范围**：不论 `EXPOSE_PATH_HEADERS` 取何值都返回 `X-CloudAlbum-Path`；可以在 registry 旁路白名单中的路由上使用 `X-Compare-Bypass`；以“探测主体”身份访问 `probe/*`；**没有其他管理员能力**。带探测令牌的请求在 LabMetricsStore 中打上 `probe` 标记，不计入感知器窗口、`path-seen`、`nginx-log` 与源站卸载统计（防止自我证明）。
   - **实验上传令牌**：在 S13 签发，范围只有 `lab:runs`、`lab:results`、`X-Experiment-*` 请求头，以及旁路白名单路由上的 `X-Compare-Bypass`；默认 TTL 7 天，可随时撤销，库中只存哈希，与 auth 驱动无关。`npm run exp:login` 改为输入这个令牌，运维机或 CloudShell 上不再保存完整的管理员令牌，也不需要“实验专用管理员账号”（附录 B-13）。
   - **实例间内部调用**（`instanceScope: all`）：`POST /api/console/internal/run-local` 只绑定 VPC 内网地址，用与探测令牌相同的 HMAC 密钥签名，只能执行 local/capability 检查。
   - 写操作还要求通过 CSRF 校验和 `Origin` 白名单校验（§3.8）。
3. **不回显密钥。** 证据先经投影白名单裁剪（§6.6），写入数据库之前再经过 `Redactor` 处理：
   - 请求头：`Authorization`、`Cookie`、`Set-Cookie`、`X-Amz-Security-Token`、`X-Origin-Verify`、`X-CloudAlbum-Probe` 的值替换为 `‹redacted›`。
   - URL 中的 `X-Amz-Signature`、`X-Amz-Credential`、`X-Amz-Security-Token`、`sig`、`token` 参数打码；URL 中内嵌的口令（`scheme://user:pass@host`）打码。
   - JSON 中键名匹配 `/(secret|password|token|key|credential)/i` 的值打码；**Name/Value 形式的数组**（`HeaderName`/`HeaderValue`、`Name`/`Value`、`Key`/`Value`）中，名称匹配同一模式或属于请求头黑名单时，对应的值打码；`HeaderValue` 一律打码。`AKIA` 或 `ASIA` 开头的字符串只保留前 4 位。
   - env 文件只展示非密钥键；`file` probe 不读取文件内容；`imds` probe 不返回凭证内容。
   - 账号 ID 在导出的报告中默认打码。
4. **防命令注入。** 检查只能从仓库中定义的检查类型和 probe 白名单中选择，YAML 中不能写 shell、SQL 或任意 URL：
   - 模板变量代入前，先按 `pattern` 校验，不匹配记为 `NOT_FOUND_VAR`；导入进度文件时也重新校验。
   - 引擎内部，变量值只作为参数传入 SDK、`fetch` 或 probe，**从不拼接进 shell**；交给学员复制的命令按 §5.6 做 shell 转义。
   - 引擎只在 `process` probe 中调用一次子进程：固定参数的 `execFile('systemctl', ['show', <白名单 unit>, '-p', …])`，不经过 shell。除此之外不调用 `child_process`。实验运行器是独立的 CLI 工具，在运维机上运行。
5. **防 SSRF。** `http-header` 检查的目标主机由 `target` 枚举值在服务端解析得到，只可能是本机、EIP、分配域名、ALB、API Gateway 这几类；地址用 `new URL(path, origin)` 构造并断言 origin 不变（§5.6）。不跟随重定向；响应体最多读 64 KB。
6. **指南来源可信。** 指南只从仓库目录加载，启动时校验；运行中不能通过 API 修改指南。“重新加载指南”只是重新读取磁盘上的文件，需要管理员权限。
7. **不暴露在 CDN 缓存里。** 所有 `/api/console/*` 响应都带 `Cache-Control: no-store`。cdn 指南的步骤 4（缓存行为）会检查这一点；运行时如果发现 `X-Cache: Hit`，显示红色横幅（§3.6）。
8. **Setup token 与首次启动向导。**
   - 文件 `/var/lib/cloudalbum/setup-token` 属于 `cloudalbum:cloudalbum`，权限 0600。token 为 32 字节随机值（256 位熵），24 小时内有效，验证成功后文件立即删除。
   - **不做全局锁定**（全局锁定只会让任何人都能通过连续输错来阻止学员初始化，而 256 位熵本身已足够）。改为按来源 IP 限速：Nginx `limit_req`（每分钟 5 次，突发 3）加应用层按 IP 的令牌桶；超限返回 429 与等待秒数，不影响其他来源。
   - **默认只接受回环地址或 HTTPS 来源的 setup 请求**：SSH 隧道（`ssh -L 8080:localhost:80 …`）或 Session Manager 端口转发到 `http://localhost:8080` 时来源是回环地址；经 HTTPS 访问时链路加密。通过 HTTP 从公网初始化时，必须先在实例上执行 `sudo -u cloudalbum node …/cli.js setup:token --allow-remote`，该开关 1 小时后自动失效。这样 L0 默认的 HTTP 明文不会把 token 暴露给链路上的攻击者。
   - **证书指纹核对**：HTTPS（自签名证书）访问时，`setup:token` 命令在实例上打印证书的 SHA-256 指纹，向导引导学员在**浏览器的证书查看器**中比对；页面自己不显示指纹（同一连接上显示的指纹可以被中间人一起篡改，不能作为证据）。
   - **向导会话**：`setup/verify-token` 成功后签发向导会话 Cookie，其哈希存入 `setup_state.wizard_session_hash`，并绑定当前的 `setup_state.token_generation`。重新生成 token 时代际号加一，旧的向导会话全部失效。步骤 `admin` 之后丢失 Cookie（换了浏览器等）时，在实例上重新生成 token 再验证一次即可从断点继续。
   - `setup/admin` 成功后：签发 `ca_console` 会话、作废向导会话、写入 `audit_log`；此后所有 `setup/*` 接口返回 `410 Gone`，页面路由 302 到登录页。
   - `setup/status` 在验证 token 之前只返回 `{initialized, step}`，**不返回**已有管理员的邮箱（接管场景也不例外）。
9. **结课后收回检测器权限。** 清理向导的最后一步提供删除 Verifier 角色与策略的命令（§6.7），并在学习报告中注明“检测器权限已收回”。

### 6.11 SSE 推送

- **端点**：`GET /api/console/events`，需要 `ca_console` 会话。
- **响应头**：`Content-Type: text/event-stream`、`Cache-Control: no-store`、`X-Accel-Buffering: no`（关闭 Nginx 缓冲，不需要修改 Nginx 主配置）。
- **心跳**：每 15 秒发送一次注释行 `: ping`。这低于 Nginx 默认 `proxy_read_timeout` 的 60 秒，也低于 ALB 默认的 60 秒空闲超时。
- **事件 ID 与补发**：事件 ID 是 `console_events.seq`——数据库中单调递增的序列（PostgreSQL 用 `bigserial`；SQLite 用 `INTEGER PRIMARY KEY AUTOINCREMENT`），**不使用** ULID 等时间序，避免多个写入方之间的时钟偏差导致漏发。浏览器带 `Last-Event-ID` 重连时，服务端从数据库查询 `seq > Last-Event-ID` 的事件补发（内存中只保留一个小缓存加速）；保留期之外（§10.3）发送 `event: resync`，前端收到后重新拉取 `/state`。
- **降级**：连续 3 次连接失败后，前端改为每 30 秒轮询一次 `GET /api/console/state`，页脚显示“实时更新已暂停”。
- **多实例**：`CACHE_DRIVER=redis` 时，写入方在提交事务后把 `seq` 发布到 Redis（pub/sub 只作唤醒信号，事件内容仍以数据库为准）；否则每个实例每 2 秒查询一次 `seq > 本实例已推送的最大 seq`。订阅者计数写入共享库（§6.5），不按单实例判断。
- **与总纲的关系**：能力状态的变化仍由总纲的 `GET /api/capabilities/stream` 推送。控制台事件流会转发其中与模块相关的部分（`capability.changed`），所以前端只需要订阅一个流。

事件格式见 §9.4。

---
## 7. 画面规格

约定：

- 线框图中的符号见 §3.5，组件见第 8 章，API 见第 9 章。
- 每个画面的“状态”至少覆盖：加载、空、部分完成、错误、无凭证降级。
- 文案统一用简体中文，技术名词保留英文。

### 画面一览

| ID | 画面 | 路由 |
|---|---|---|
| S00 | 首次启动向导 | `/console/setup` |
| S01 | 登录 / 无权限 | `/console/login`、`/console/403` |
| S02 | 总览「你在这里」 | `/console` |
| S03 | 学习路线 | `/console/path` |
| S04 | Lab 概览与小测 | `/console/path/:labId`（`/quiz`） |
| S05 | 模块目录 | `/console/modules` |
| S06 | 模块详情（概览 / 配置指南 / 对比实验 / 考点 / 清理） | `/console/modules/:id/*` |
| S07 | 架构图视图 | `/console/map` |
| S08 | 对比实验详情（含 S08a 实验记录本） | `/console/experiments/:module` |
| S09 | 请求路径检查器 | `/console/traffic` |
| S10 | 检测报告（含 S10d 检查详情抽屉、S10m 手动确认对话框） | `/console/checks` |
| S11 | 费用与清理（含 S11b 清理向导） | `/console/cost` |
| S12 | 学习报告 | `/console/report` |
| S13 | 设置与检测能力 | `/console/settings/:tab` |

---

### S00 首次启动向导 `/console/setup`

**目的**

L0 第一次启动时，学员在这里完成四件事，进入课程时 Lab 0 已经自动完成了一部分：
1. 证明自己能登录这台 EC2；
2. 创建（或接管）本地管理员；
3. 定制学习路线（主线 / 重点对比快速路线、有没有域名、预算、默认做法）；
4. 完成 L0 体检。

**前置（需要同步到总纲）**

- 总纲 §2.7 第 10 步改为生成 setup token，不再把初始密码打印到 `/root/cloudalbum-admin.txt`。
- 为了兼容旧做法：如果检测到已有 `role='admin'` 的用户，第 2 步自动改为“接管”（附录 B-2）。

**线框**

```text
+-- CloudAlbum 学习控制台 · 首次启动 ---------------------------------------- 非 AWS 官方控制台 --+
| (1)验证身份 ━━━━ (2)管理员 ──── (3)学习路线 ──── (4)L0 体检                                     |
+-----------------------------------------------------------------------------------------------+
| [!] 连接：你正通过 http://54.12.34.56 访问。为了防止链路上的人截获 token，初始化默认只接受        |
|     经 SSH 隧道（localhost）或 HTTPS 发来的请求：                                                 |
|     A. SSH 隧道（推荐）：ssh -i ~/.ssh/cloudalbum.pem -L 8080:localhost:80 ec2-user@54.12.34.56 [复制] |
|        然后打开 http://localhost:8080/console/setup                                             |
|     B. 改用 https://54.12.34.56（自签名证书）：先在实例上算出证书指纹，                            |
|        sudo openssl x509 -in /etc/cloudalbum/tls/server.crt -noout -fingerprint -sha256  [复制] |
|        再在浏览器地址栏的证书查看器里看 SHA-256 指纹，两者一致才继续（本页不显示指纹）             |
|     C. 一定要经 HTTP 远程初始化时，在实例上执行 setup:token --allow-remote（1 小时后自动失效）     |
+-----------------------------------------------+-----------------------------------------------+
| 第 1 步  证明这台 EC2 是你的                     | 你的架构（正在组装）                              |
| 读取方式 [ SSH* ] [ EC2 Instance Connect ]      | ┌ AWS 账号 · ap-northeast-1 ───────────────┐ |
|          [ Session Manager（需要 iam +          | │ ┌ 默认 VPC ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐  │ |
|            shell-access，L0 不可用）]            | │ ┆ ┌ EC2 ○ ────────────────────────┐ ┆  │ |
| SSH 私钥文件 [~/.ssh/cloudalbum.pem      ]       | │ ┆ │ Nginx · cloudalbum-api/worker   │ ┆  │ |
| ┌───────────────────────────────────────────┐  | │ ┆ │ 本地芯片（灰，待体检）：           │ ┆  │ |
| │ 运维机 ▸ ssh -i ~/.ssh/cloudalbum.pem      │  | │ ┆ │ [EBS 上传][SQLite][本地账号]      │ ┆  │ |
| │   ec2-user@54.12.34.56 \                   │  | │ ┆ │ [sync 队列][inline sharp][cron] … │ ┆  │ |
| │   sudo cat /var/lib/cloudalbum/setup-token │[复制]│ ┆ └─[EBS ○]──[EIP ○]────────────────┘ ┆  │ |
| └───────────────────────────────────────────┘  | │ └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘  │ |
| Setup token [______________________________]    | └────────────────────────────────────────────┘ |
| 一次性 · 24 小时内有效 · 按来源 IP 限速            | 已点亮 0 · 待点亮 39                              |
|                              [ 验证并继续 → ]   |                                                 |
+-----------------------------------------------+-----------------------------------------------+
| 第 2 步  创建本地管理员                                                                          |
|   邮箱 [you@yourmail.example]（取自 CloudFormation 参数 AdminEmail；接入 Cognito 后要靠它收      |
|        重置密码的验证码，请填真实地址）  密码 [************] 强度 ███░                              |
|   说明：这是相册应用 users 表中 role=admin 的本地账号。创建后立即签发管理员会话，向导会话作废；    |
|   初始化完成后 /api/console/setup/* 一律返回 410。                                               |
| 第 3 步  学习路线                                                                               |
|   区域       ap-northeast-1（从 IMDS 读取，只读）                                                |
|   路线       (•) 主线（Lab 0–25，对应 l0-ec2 … l9-full）                                         |
|              ( ) 重点对比快速路线（x-named-comparisons + cost，必做 10 个模块）                    |
|   自有域名   ( ) 有 [album.example.com]   (•) 暂时没有 → dns、tls 改为选做（主线必做 32 个）       |
|   月预算     [ 30 ] USD → 用作费用灯阈值，并预填 cost 模块（Lab 1）的预算                           |
|   默认做法   (•) 控制台优先（首次推荐）  ( ) CLI 优先  ( ) 脚本快速通道                            |
|   考试日期   [2026-12-20]（可选）→ 建议节奏：每周 4 个 Lab                                       |
| 第 4 步  L0 体检（结果逐项实时出现）                                                             |
|   [v] 本地  IMDSv2 必需：不带 token 的请求返回 401                    12ms                      |
|   [v] 本地  cloudalbum-api / worker / nginx 均为 active                                       |
|   [v] 本地  :80 / :443 监听；GET /api/health/ready 200                 38ms                      |
|   [v] 本地  数据卷 /var/lib/cloudalbum 为 xfs，已用 6%                                           |
|   [v] 探针  /api/capabilities：ec2=ok，其余 39 个 off，validation 无错误                          |
|   [?] AWS   EBS 已加密 / 弹性 IP 已关联 / 根账号 MFA → 没有实例角色，改为手动核对                    |
|   结果：Lab 0（ec2）本地检查 5 项通过，AWS 类 3 项待手动确认（完成 Lab 1 · iam 后自动复核）        |
|                                                                        [ 进入课程 → ]           |
+-----------------------------------------------------------------------------------------------+
```

**组件**
- `WizardStepper`：4 个步骤（当前步骤带 `aria-current="step"`）。页面有一个视觉隐藏的 `h1`“首次启动向导”，路由切换后焦点落在它上面。
- 连接安全提示 `Banner(type=http|selfsigned)`：三种方式（SSH 隧道、HTTPS + 证书查看器核对指纹、`--allow-remote`）。**页面不显示证书指纹**。
- 读取方式 `MethodTabs`（真正的 tablist，配 tabpanel）：命令中已代入 EIP。SSH 方式的私钥路径是输入型变量 `{{var.keyFile}}`（默认 `~/.ssh/cloudalbum.pem`，`pattern: ^[~./A-Za-z0-9_-]+$`），走统一的“未填写变量拦截复制”，不再使用 `<你的密钥>.pem` 这种复制后会被 shell 当成重定向的占位符。EC2 Instance Connect 的 Tab 注明“需要安全组为 EC2 Instance Connect 服务前缀列表放行 22 端口”。
- `CommandBlock`（runsOn=ops）。
- Token 输入框（等宽字体，粘贴时自动去掉首尾空白）。
- 管理员表单：邮箱、密码；密码强度按 zxcvbn 评分 ≥ 3，至少 12 个字符。邮箱字段提示“请填可以收信的真实地址”。
- 学习路线表单（路线、域名、预算、默认做法、考试日期）。
- 体检清单 `CheckResultRow`：每行带来源标签。
- 右侧 `ArchMap(mode=assemble)`：体检每通过一项，就点亮对应的节点或芯片。
- 结论区。

**数据来源**
- `GET /api/console/setup/status`（验证前只返回 `{initialized, step}`）
- `POST /api/console/setup/verify-token`
- `POST /api/console/setup/admin`
- `PUT /api/console/profile`
- `POST /api/console/checks/run {scope:"baseline"}`，结果通过 `GET /api/console/events`（SSE）推送
- `GET /api/console/topology`
- IMDS（由后端读取）：`public-ipv4`、`placement/region`

**状态**

| 状态 | 表现 |
|---|---|
| 加载 | 先请求 `setup/status`，期间显示骨架；已初始化则 302 到 `/console/login` |
| 来源不被接受 | 经 HTTP 从公网访问且没有 `--allow-remote` 时，`verify-token` 返回 403 `SETUP_REMOTE_DISABLED`；页面突出显示连接横幅中的 A、B 两种方式 |
| token 错误 | 输入框下方用红字显示“token 不正确。请确认是从 /var/lib/cloudalbum/setup-token 原样复制的”。**没有剩余次数，也不会锁定** |
| 请求过于频繁 | 同一来源 IP 超过每分钟 5 次时返回 429：“请求过于频繁，30 秒后再试（限速按来源 IP 计算，不会锁死初始化）” |
| token 文件不存在或已过期 | “token 已失效。请在实例上运行 `sudo -u cloudalbum node /opt/cloudalbum/backend/dist/cli.js setup:token` 重新生成。”重新生成会让旧的向导会话失效 |
| 已有管理员（旧版 bootstrap 创建） | 第 2 步改为“接管管理员：设置新密码”。邮箱只在 token 验证之后显示；`/root/cloudalbum-admin.txt` 中的旧密码随之作废 |
| 中途刷新 | 进度保存在服务端的 `setup_state` 表；向导会话 Cookie 仍有效时直接从断点继续。Cookie 丢失时（换了浏览器）重新生成 token 再验证一次 |
| 体检部分失败 | 失败项不阻止进入课程，会成为 Lab 0 中未通过的步骤，并标明在哪一步修复 |
| 无凭证（L0 的常态） | AWS 类检查显示 `[?]`，注明“完成 Lab 1 · iam 后自动复核” |
| 后端不可达 | SPA 已加载，但 `/api` 返回 502。页面显示诊断命令：`sudo systemctl status cloudalbum-api`、`sudo journalctl -u cloudalbum-api -n 50`、`sudo -u cloudalbum node /opt/cloudalbum/backend/dist/cli.js check-config` |
| 已初始化后再访问 | 页面 302 到登录页；`/api/console/setup/*` 返回 410 |
| 窄屏 | 右侧架构图折叠成一行文字：“已点亮：EC2 · EBS · EIP”；连接横幅改为纵向排列，命令块头部换行 |

**交互**
- 切换读取方式时，替换命令（←→ 在 tab 之间移动，焦点留在新选中的 tab 上）。
- 修改私钥路径后，命令块中的 `{{var.keyFile}}` 随之更新；为空时复制被拦截并定位到输入框。
- 粘贴 token 后按 Enter 提交。
- 选择路线或“暂时没有域名”时，右侧实时预览必做模块数（主线 32 / 快速路线 10）。
- 体检按 SSE 事件逐项出现；点击 `[?]` 项可以展开“去哪里核对”。
- 点击“进入课程”后跳转到 `/console`，并播放 3 个新手引导气泡：顶栏“继续”、检测能力徽章、费用灯。

**文案示例**
- 第 1 步标题：“证明这台 EC2 是你的”。
- 说明：“token 只在这台实例的磁盘上，能读到它，就说明你能登录这台机器。”
- 完成页：“Lab 0（ec2）：本地检查 5 项通过，AWS 类 3 项待手动确认。下一步：Lab 1 · iam 与 cost（预算告警，约 30 分钟）。”

---

### S01 登录 `/console/login` 与无权限 `/console/403`

**目的**

只允许管理员进入控制台。登录方式与相册当前的 auth 驱动一致，登录后换取控制台专用会话 `ca_console`（§3.8），另外保留应急通道。

**线框**

```text
+-- CloudAlbum 学习控制台 ------------------------------------------------+
| 管理员登录                                                    （h1）    |
| 当前登录方式：本地账号（auth=local）                                     |
| 邮箱 [admin@example.com      ]                                          |
| 密码 [************           ]                                          |
| [ 登录 ]                                                               |
| ─────────────────────────────────────────────────────────────────────── |
| 忘记密码或 Cognito 不可用？在实例上运行：                                   |
|   sudo -u cloudalbum node /opt/cloudalbum/backend/dist/cli.js \        |
|     console:login-link                                       [复制]    |
|   命令会打印一个 10 分钟内有效、只能使用一次的登录链接                       |
|   （…/console/login#ticket=…，票据在 # 之后，不会进入日志）               |
| [!] 当前为 HTTP 明文连接，建议经 SSH 隧道或 https:// 访问                   |
+-------------------------------------------------------------------------+

auth=cognito 时，表单替换为：
| [ 使用 Amazon Cognito 登录（需要 admin 组） ]                              |
| 托管登录的回调必须是 HTTPS：请从 https://d111….cloudfront.net/console 打开；  |
| 经 http://EIP 访问时只能使用应急链接。                                       |

/console/403：
| 无权限（h1）                                                              |
| 学习控制台仅对管理员开放。当前账号：bob@example.com（member）   [返回相册] |
```

**组件**：登录表单（复用相册的 `LocalAuthProvider`，Cognito 时复用 `CognitoAuthProvider`）、应急登录说明 `CommandBlock`、连接安全横幅。两个画面都有可见的 `h1`（“管理员登录”“无权限”），路由切换后焦点落在 `h1` 上。

**数据来源**：
- 相册的认证接口 `POST /api/auth/login`，或 Cognito 登录流程（B 组文档 `02-identity-security.md#auth`：BFF + HttpOnly Cookie）
- `POST /api/console/session`（用相册会话换取 `ca_console`）
- `GET /api/console/session`
- `POST /api/console/session/ticket`（应急票据兑换；前端从 `location.hash` 读取 `ticket` 后立即 `history.replaceState` 清除片段，再在请求体中提交）

**状态**

| 状态 | 表现 |
|---|---|
| 密码错误 | 统一提示“邮箱或密码不正确”，不区分是用户不存在还是密码错误 |
| 连续失败 | 显示“稍后再试（剩余 3 分钟）”，沿用相册 `/api/auth/*` 的限速 |
| 票据无效或已使用 | “链接已失效，请重新生成” |
| Cognito 用户不在 admin 组 | 跳到 403，并提示“请在 User Pool 中把该用户加入 admin 组”（这也是 auth 指南预检步骤中的一项） |
| 从 http://EIP 选择 Cognito 登录 | 提示“托管登录的回调必须是 HTTPS”，给出 HTTPS 入口链接与应急链接说明 |
| auth 模块为 degraded | Cognito 按钮旁标注“Cognito 当前异常”，并突出显示应急链接说明 |
| 会话过期 | `ca_console` 最长 1 小时且不可刷新。任何 `/api/console/*` 返回 401 时，前端先静默用相册会话换取一次；失败再弹出模态框重新登录，不离开当前页面，未提交的手动确认草稿保留在内存中 |

---

### S02 总览「你在这里」 `/console`

**目的**

每次打开都回答四个问题：我在哪、下一步做什么、我完成了什么、现在在花什么钱。其中“我完成了什么”必须在 1280×800 的首屏内可见。

**线框**（示例数据：重点对比快速路线，学员做到 Lab 8）

```text
+--------------------------------------------------------------------------------------------------------------+
| ▣ 学习控制台 | [继续：Lab 8 › auth › 步骤 3 托管登录 →] | 档位 l2-edge +2 | 配置 7/10 ▕████▁▏ | 检测 ◐ 部分 | 费用 ▲ ≈$0.08/h |
+------------------------+-------------------------------------------------------------------------------------+
| （左栏：导航 + 大纲）   | 总览                                         [示例数据：重点对比快速路线 · 档位 l2-edge +2] |
|                        | ▸ 欢迎回来  距上次 1 天 11 小时 · 期间 ≈$2.83 · cache 漂移 · cdn 指南 v4.1.0     （一行，可展开）|
|                        | [!] 先修复：cache 缓存安全组的 6379 入站规则缺失。不阻塞 auth；它是 autoscaling 的软依赖，  [排错] |
|                        |     而且仍在按小时计费。                                                                |
|                        | ┌ 你在这里 ─────────────────────────────────────────┬ 完成度 · 重点对比快速路线 ──────┐ |
|                        | │ Lab 8 用户身份 › auth · Amazon Cognito User Pool    │ 7/10 必做模块                   │ |
|                        | │ › 步骤 3「配置托管登录域与 HTTPS 回调地址」            │ ▕██████░▏                       │ |
|                        | │ 上次检测 3 分钟前：                                  │ 自动 6 · 含手动 1 · 进行中 1      │ |
|                        | │  [e] 托管登录域已创建（检测器缺权限，可改为手动核对）   │ 全课程 11/32 · Lab 9/24          │ |
|                        | │  [ ] 回调地址为 HTTPS                                │ 0─1─4─5─15─16─[8]─10─11          │ |
|                        | │ 预计剩余 1 小时 50 分钟 · 按量计费   [ 继续 → ]        │ 模块目录 →                       │ |
|                        | └────────────────────────────────────────────────────┴─────────────────────────────────┘ |
|                        | ── 接下来 ──────────────────────────────  ── 也可以先做（依赖已满足）─────────────────── |
|                        | auth 步骤 3 托管登录 → 4 预检 → 5 接入应用     Lab 9 › email（约 60 分钟 · 按量）     [稍后] |
|                        |   （步骤 5 执行后会被登出）                    Lab 10 › queue ★（约 90 分钟 · 按量）  [稍后] |
|                        | 原因：继续上次的进度                          ▸ 被阻塞 5（network：DEP-016 …）               |
|                        | ── 需要关注 ─────────────── [检测报告 →]  ── 费用 ─────────────────── [黄灯 · 估算]    |
|                        | [!] cache · 缓存安全组允许 6379   [排错]      计费中（按小时）：EC2 t4g.small、公网 IPv4、EBS ·  |
|                        | [e] auth · 托管登录域已创建   [改为手动核对]    RDS db.t4g.micro · ElastiCache cache.t4g.micro  |
|                        | ·过期 iam · 1 项证据超过 24h  [复核]           现在 ≈$0.080/h · 本月 ≈$14.80 / 预算 $30（49%） |
|                        |                                                [!] ElastiCache 9 小时没有有效请求，仍在计费       |
|                        | ── 最近完成 ─────────────────────────  ── 当前架构 · 档位 l2-edge +2 ────── [打开架构图] |
|                        | 10/13 10:31 cache 漂移 · 10/11 auth 开始 …    [迷你架构图]                                      |
+------------------------+-------------------------------------------------------------------------------------+
```

“你在这里”卡片之后的区块不再套卡片，只用标题加细分隔线分组（§11.1“表格为主、卡片只用来分组”）。

**组件**
- `ReturnSummary`：回访摘要，**默认折叠成一行**（`<details>`），只在距上次 > 24 小时时出现；展开后是一段文字，不是卡片。
- `FixFirstBanner`：总览页唯一的“先修复”横幅。总览页有它时，不再显示全局的漂移和费用横幅（§3.6）。
- `YouAreHereCard`：左侧是位置、本步检查摘要、预计剩余与“继续”；**右侧是精简完成度** `CompletionPanel(compact)`：配置 x/y 与 `SegmentedProgress`、图例、全课程 x/y、Lab x/y、`LabRail`（按当前路线排列的 Lab 缩略条）。767px 以下右侧移到下方。
- `RecommendationCard`：1 个主推荐（“接下来”，列出当前模块接下来的 3–4 步，并标出 `impact`）+ 2 个备选（“也可以先做”，每条可“稍后”隐藏 24 小时）+ 折叠的“被阻塞”清单（带规则编号）。
- `AttentionList`：最多 5 条，排序为漂移 → 未通过 → 检测器出错 → 待确认 → 过期；每条带对应动作（排错 / 改为手动核对 / 去核对 / 复核）。
- `CostCard`：计费中的资源、当前估算、本月估算与预算；没有 `cost-rates.yaml` 时只列资源与时长。
- `Timeline(limit=6)`。
- `ArchMap(mode=mini)`。

**数据来源**
- `GET /api/console/state`：包括 profile、track、cursor、完成度、检测能力、档位、横幅、回访摘要。
- `GET /api/console/next`
- `GET /api/console/cost/summary`
- `GET /api/console/map/state?mini=1`
- `GET /api/console/timeline?limit=6`
- SSE：`step.changed`、`module.changed`、`capability.changed`、`cost.changed`、`recommendation.changed`

**状态**

| 状态 | 表现 |
|---|---|
| 空（刚完成向导） | “你在这里”= Lab 1 · iam 第 0 步；完成度 1/32（ec2 为 done_manual）；最近完成中列出体检自动通过的项目。显示新手引导气泡 |
| 加载 | 顶栏“继续”先用缓存的文案渲染；各区块显示骨架，按接口返回的顺序逐个替换 |
| 部分完成 | 同线框 |
| 回访（距上次 > 24 小时） | 顶部一行回访摘要：期间的估算费用、状态有变化的模块、更新过的指南、继续位置；点击展开详情 |
| 漂移 | “你在这里”上方的“先修复”横幅，并说明是否阻塞下一步、是否仍在计费 |
| 费用告警 | 费用区块标题变为红灯，主推荐变为“清理 ElastiCache” |
| 无凭证 | 横幅区显示降级横幅“14 项 AWS 检查改为手动确认 [去解锁]”（总览页唯一的全局横幅）；需要关注中的 AWS 检查显示“去核对” |
| 全部完成 | “你在这里”换成结业卡：配置 32/32 · Lab 24/24 · 考点均分 84，提供 [导出学习报告]、[清理回 L0]、[错题复习] |
| 错误 | `/state` 请求失败时，显示横幅“后端未运行或数据库不可达”及诊断命令。单实例模式下进度库在 RDS 且不可达时，用 `/var/lib/cloudalbum/console/progress-snapshot.json` 渲染只读快照，并标注快照时间（ASG 模式不写本地快照，§6.2） |

**交互**
- “继续”进入 S06-2 的精确步骤。
- 点击完成度数字进入 S05；点击“改为手动核对 / 去核对”打开 S10m；点击“排错”打开 S10d。
- 点击路线缩略条上的节点进入 S04。
- 点击迷你架构图进入 S07。
- 悬停“也可以先做”时，显示推荐理由和依赖满足情况。

**文案示例**
- “也可以先做：queue 依赖已满足，按量计费；它是你点名的重点对比之一。”
- 回访：“你离开了 1 天 11 小时（上次 10/11 23:40）。期间按小时计费的资源：EC2、公网 IPv4、EBS、RDS、ElastiCache，约 $2.83（估算，单价取自 cost-rates.yaml）。”

---

### S03 学习路线 `/console/path`

**目的**

用一张图展示 Lab 0–25 之间的关系：哪些已完成、哪些可以并行、哪些建议稍后、哪些不在当前路线，以及每个 Lab 是否会产生按小时计费的费用。

**线框**（依赖图按总纲 §10.2 的档位分列，每列是一个档位；Lab 数、档位名都来自 course.yaml，不写死）

```text
 学习路线   [重点对比快速路线 | 主线]   视图 [依赖图 | 列表]   [只看未完成] [显示选做]
 图例 [v]完成 [M]完成·含手动 [>]进行中 [ ]可开始 [-]建议稍后 / 选做 Lab   $/h = 会开始按小时计费
      ━━ 软前置   ┅┅ 快速路线顺序（青瓷色虚线）   灰色节点 = 不在当前路线

 l0-ec2   l1-ops      l2-edge     l3-identity  l4-async    l5-security  l6-data      l7-…   l8-ha        l9-full
 [v]0 ━━▶ [v]1 ━━━━▶ [v]4 ━━━▶  [>]8         [ ]10 ┅┅▶  [ ]13        [v]15 $/h    [ ]17  [ ]19 $/h    [ ]22
           [M]2       [v]5 ┅┅┅┅▶ [ ]9          [ ]11       （灰）       [!]16 $/h    （灰）  [ ]20 $/h    [ ]23
           [v]3       [-]6 选做                [ ]12                    [ ]14 （灰）        [#]21 $/h    [ ]24
                      [v]7                                              [ ]18                            [-]25 选做

 ┌ 侧栏：Lab 10 解耦：SQS ─────────────────────────────────────────────┐
 │ 状态     可开始（前置已完成）                                         │
 │ 路线     快速路线第 8 站                                              │
 │ 预计     1.5h          档位  l4-async                                │
 │ 模块     [ ] queue  重点                                              │
 │ 费用     —（按量计费）                                                │
 │ 自动检测 需要 AWS 只读 3 项（当前：部分 · 缺 3 项）                      │
 │ 解锁     完成后建议开始 Lab 11、Lab 12                                 │
 │ [ 进入 Lab 10 ]                                                      │
 └──────────────────────────────────────────────────────────────────┘
```

**组件**：`TrackToggle`（主线 / 快速路线，只切换显示，不改 S13 的设置）、`LabNode`（状态、编号、标题、`$/h` 标记，不在路线中的灰显）、`LabEdge`（软前置；悬停时显示依赖理由）、快速路线的顺序虚线、`LabSidePanel`、`ViewToggle`、过滤器。

**数据来源**：`GET /api/console/course`（course.yaml + 路线 + 状态 + 费用类别）、`GET /api/console/next`（高亮推荐节点）。

**状态**

| 状态 | 表现 |
|---|---|
| 加载 | 节点骨架 |
| 空（刚完成向导） | Lab 0 为完成（含手动），Lab 1 为可开始，其余为建议稍后。侧栏默认显示 Lab 1 |
| 已清理 | 节点显示 `[z]`，并注明“重建约 25 分钟” |
| 路线定制 | 没有域名时，Lab 6 显示为“选做 Lab”；快速路线下不在路线中的 Lab 灰显，侧栏注明“不在当前路线（主线中仍可以学）” |
| 无凭证 | 节点角标显示“n 项需手动确认”；Lab 1 注明“完成后解锁自动检测” |
| 错误 | course.yaml 或某个指南校验失败时，顶部红条显示文件名、行号和错误；受影响的节点灰显，其他节点正常显示 |
| 窄屏 | 默认使用列表视图：每个 Lab 一行（Lab、标题、档位、状态、必做进度、模块、计费、预计），表格放在横向滚动容器中；依赖图同样放在横向滚动容器中 |

**交互**
- 单击节点打开侧栏；侧栏随选中节点更新。
- 选中后再按 Enter（或双击）进入 S04。
- 键盘：依赖图是一组 `role="button"` 的节点，采用 roving tabindex（只有选中节点可 Tab 到）；←→↑↓ 按屏幕几何位置移动到该方向上最近的节点，同时更新侧栏，焦点留在新节点上。
- “建议稍后”的 Lab 在侧栏中显示 [仍要开始]：只跳过 Lab 级的软门槛，模块级硬依赖照常生效，例如 Lab 11 的 image-processing 仍然要求 storage 以 s3 运行。

---

### S04 Lab 概览与小测 `/console/path/:labId`、`/quiz`

**目的**

作为 Lab 的开头页：先讲为什么需要这些服务（痛点故事），再列出模块、通关条件、费用和清理提示。

**线框**

```text
 学习路线 › Lab 15 关系数据库：RDS（扩展：RDS Proxy）· l6-data      状态：已完成 · 必做 1/1 · 预计 3h
 ┌ 痛点 ───────────────────────────────────────────────────────────────────────────────────┐
 │ 照片元数据、用户和时间线都在 EBS 上的一个 SQLite 文件里。实例一坏，数据库跟着一起不可用；           │
 │ 想再加一台 EC2 分担流量，第二台根本读不到这个文件……                                             │
 └────────────────────────────────────────────────────────────────────────────────────────┘
 学习目标  [v] SQLite → 自建 PG → RDS：各自的运维边界        [v] Multi-AZ 与只读副本的区别
           [v] 子网组与安全组引用（只允许应用安全组）         [ ] 连接池：PgBouncer → RDS Proxy（扩展）
 阶段条    (v)基线 ──── (v)配置 ──── (v)接入 ──── (v)对比 ──── ( )考点

 模块                 机能          步骤    证据构成                    对比              状态           费用
 database RDS ★       关系数据库     7/7     □AWS 9 · ◇本地 3 · △实验 2   before ✓ after ✓   [v] 完成        $/h
 db-proxy RDS Proxy 扩展 数据库连接池  0/5     —                           —                 [#] 未解锁      $/h
                                                   需要 secrets（secretsmanager）在运行（DEP-032）

 完成条件  必做模块全部完成（步骤 + 第一档与最后一档实验有效）。扩展模块与小测不影响完成
 小测      6 题 · 最好成绩 5/6                                         [ 做 Lab 小测 ]
 清理提示  database 按小时计费。快速路线下 Lab 16、Lab 8 还会用到它；全部练完后建议清理（进度保留）
                                                                         [ 继续：Lab 8 › auth → ]
```

**小测（`/quiz`）线框**

```text
 Lab 15 小测 · 6 题 · 考点掌握统计                                             第 3/6 题 ▕███░░░▏
 [弹性] 你的 RDS 启用了 Multi-AZ。下面哪项描述是正确的？            （radiogroup，方向键选择，Enter 提交）
  ( ) 备库可以分担读流量
  ( ) 主备之间是异步复制，可能丢数据
  ( ) 故障转移时 DNS 端点不变，应用需要重连            ← 正确
  ( ) 需要手动提升备库
                                                                                    [ 提交 ]
 ── 提交后 ──
 正确。你在 database 步骤「带故障转移的重启」中实际测过中断时长（23 秒）。          [ 回看步骤 ]
 考点：Multi-AZ 用于高可用（同步复制、自动故障转移）；只读副本用于扩展读能力（异步复制）
```

**组件**
- 概览页：`StoryCard`、`GoalList`（达成后自动打勾）、`PhaseBar`、`ModuleTable`（证据构成用来源形状标签 `□AWS 6 · ◇本地 1 · △实验 1`，不用字母代码）、`CompletionRule`、`CleanupHint`、`PrimaryAction`（按钮文案随状态变化）。
- 小测页：`QuizCard`（`role="radiogroup"`，用 `aria-labelledby` 指向题干；←→↑↓ 选择，Enter 提交，提交后焦点移到“下一题”）、`QuizResult`（按领域统计掌握度，错题“加入复习”）。

**数据来源**
- `GET /api/console/labs/:labId`
- `GET /api/console/quiz/:labId`
- `POST /api/console/quiz/:labId/attempts`
- `GET /api/console/experiments?lab=:labId`
- `GET /api/console/cost/catalog?lab=:labId`

**状态**

| 状态 | 表现 |
|---|---|
| 建议稍后 | 顶部显示“建议先完成 Lab 14（未完成：network）[仍要开始]” |
| 不在当前路线 | 顶部注明“不在重点对比快速路线中；主线中仍可以学”，主按钮照常可用 |
| 选做 Lab | 顶部注明“选做 Lab（Lab 25 / 没有域名时的 Lab 6）：不计入 Lab 进度” |
| 未开始 | 阶段条停在“基线”，主按钮为“先记录基线（before）”，并说明为什么要先测 |
| 待小测 | 必做模块全部完成后，主按钮变为“做 Lab 小测（可选）”，次按钮为“清理本 Lab 的按小时资源” |
| 已完成 | 顶部显示结业卡：各模块对比结论摘要、小测成绩、清理建议 |
| 已完成·已清理 | 模块行显示 `[z]`。如果后续 Lab 依赖这些模块在运行，显示“重建以继续 Lab 21（约 25 分钟，$/h）” |
| 无凭证 | 证据列显示“待确认 n” |
| 小测：没有题库 | “本 Lab 暂无题库，只按配置完成情况统计” |
| 小测：预习模式 | 顶部标注“预习，成绩不计入” |
| 错误 | 某个指南加载失败时，只有该行显示错误和文件位置，其他行正常 |

**交互**：点击模块行进入 S06；点击对比列进入 S06-3；小测可以中断，下次从上次的题目继续（服务端保存）；重测时打乱题目和选项顺序，成绩取最好的一次。

---

### S05 模块目录 `/console/modules`

**目的**

一眼看到“我完成了哪些任务的配置”：40 个模块按基础与 A–F 机能分组排成矩阵，同时显示学习进度和当前运行状态。紧凑密度下，1280×800 的首屏基本能放下全部格子。

**线框（矩阵视图，紧凑密度）**

```text
 模块目录（40）                视图 [矩阵|表格]  密度 [紧凑|标准]                                  [复核全部]
 重点对比快速路线：已完成 7/10 个必做模块 · 全课程 11/32 · 选做 0/8
 检查：自动通过 116 项 · 手动 3 项 · 待确认 1 项 · 异常模块 1 个
 筛选 [全部 40] [当前路线 10] [只看重点 7] [待做 …] [待确认/含手动 …] [漂移 1] [计费中 …]
 图例：格子底色 = 学习进度；右上角圆点 = 当前运行（● ok ◐ degraded ✕ error ○ off）；$ = 正在按小时计费；★ 重点 · * 选做/扩展

 基础         [ec2 [v]▕██▏6/6 ●]
 A 入口、网络 [network [#] ○][cdn★ [v] 7/7 ●][dns* [-] ○][tls* [-] ○][waf [v] 5/5 ●][load-bal… [ ] ○][autosc… [#] ○]
 B 身份与安全  [iam [v] ●][auth★ [>] 3/9 ○][identity-pool [#] ○][secrets [ ] ○][config [ ] ○][kms [ ] ○]
 C 数据与存储  [storage★ [v] ●][shared-fs* [#] ○][database★ [v] 7/7 ●$][cache★ [!] 7/7 ◐$][social-store [ ] ○]…
 D 计算与异步  [image-proc★ [ ] ○][queue★ [ ] ○][notification [ ] ○][email [ ] ○][scheduler [ ] ○][tagging …]…
 E 运维与安全  [shell-access [M] ●][logging [v] ●][monitoring [v] ●][tracing [ ] ○][audit [ ] ○][threat-det… [ ] ○]
 F 治理与成本 [compliance* [ ] ○][vuln-scan* [ ] ○][cost [M] ●][db-proxy* [#] ○][workflow* [ ] ○][ami* [ ] ○]

 ┌ 模块详情：cache · Amazon ElastiCache（Lab 16）────────────────────────────── （矩阵下方）┐
 │ 学习   [!] 漂移 · 7/7 步 · 检查：□AWS 4 · ◇本地 3 · ○探针 2 · △实验 2       当前运行  degraded（redis@elasticache）│
 │ 对比   before ✓ 10/09 · after ✓ 10/10                                     费用      $/h（cache.t4g.micro） │
 │ 依赖   硬依赖 —；软依赖 kms、network（快速路线跳过）                        被依赖    autoscaling（软，ASG-004）│
 │ [ 排错 ] [ 对比实验 ] [ 在架构图中查看 ]                                                                     │
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **紧凑格子**：最小宽约 108px、高约 58px；状态徽章、步骤条与 `n/m` 合在一行，格子里只放 id、服务短名与这一行。“标准”密度（最小宽约 150px）多显示一行说明（例如“需要 load-balancer”“选做 · 无域名”“6379 规则缺失”）。密度存 `localStorage`。
- **侧栏放在矩阵下方**（不在右侧挤占宽度）；选中格子后更新侧栏，焦点保持在格子上。
- 页头同时出现模块数和检查数时一律写单位：“已完成 7/10 个必做模块”“检查：自动通过 116 项”。侧栏的“进行中”徽章与“3/8 步”只出现一次。

**表格视图的列**：模块 id、主服务、Lab、学习进度（含 `n/m` 步）、当前运行（status + driver）、证据构成（来源形状标签加计数，例如 `□AWS 3 · ◇本地 2 · ⬚手动 1`，与 §8.1 的 `SourceTag` 图例一致）、对比（before/after）、费用类别、最近检测时间。表格放在横向滚动容器中。

**组件**：`ModuleTile`（变体见 §8）、`DensityToggle`、`DataTable`、`ModuleSidePanel`、`FilterBar`。

**数据来源**：`GET /api/console/modules`、`GET /api/capabilities`（30 秒轮询，或接收 SSE `capability.changed`）。

**状态**

| 状态 | 表现 |
|---|---|
| 空（只有 ec2） | 大部分格子为 `[ ]` 或 `[#]`，顶部提示“推荐从 Lab 1 · iam 开始” |
| 加载 | 40 个格子的骨架 |
| 有异常 | `[!]` 的格子加橙色描边，并在页头汇总 |
| 已清理 | 格子使用斜纹底，并显示 `[z]` |
| 被取代 | 格子保持已完成，悬停说明“2 项检查被 Lab 19 取代” |
| 无凭证 | “复核全部”按钮禁用，悬停说明原因；`[?]` 的格子高亮 |
| 全部完成 | 页头显示“32/32 完成”，并提供“导出学习报告” |
| capabilities 不可达 | 运行圆点显示为“?”，悬停说明“探针不可达，学习进度不受影响” |
| 窄屏 | 每组的组名在上、格子在下，格子最小宽约 100px |

**交互**：单击格子（或 Enter / 空格）选中并更新下方侧栏；双击进入 S06；筛选条件与密度写入 URL；“复核全部”会重跑所有已达成步骤的检查（带速率限制），用来发现漂移。

---

### S06 模块详情 `/console/modules/:id/*`

**公共页头（5 个子页共用）**

```text
 学习路线 › Lab 5 边缘缓存 › cdn · Amazon CloudFront ★                      [在架构图中查看] [检测整个模块]
 学习 [v] 完成 7/7（已达成 7 步，共 7 步；选做 1 步）  ·  运行 ok（cloudfront）  ·  对比 before ✓ after ✓  ·  费用 按量
 <nav aria-label="模块详情">[ 概览 ] [ 配置指南 • ] [ 对比实验 ] [ 考点 ] [ 清理 ]</nav>
```

- 5 个子页是**导航式标签**：每个都是普通链接，当前页带 `aria-current="page"`，不使用 `role="tab"`（它们会改变 URL，按方向键切换会触发导航并把焦点移到 `h1`）。选中样式用 `box-shadow: inset 0 -2px 0 var(--accent)` 表示下划线，不用负外边距（避免在横向滚动的标签栏里产生 1px 纵向溢出和多余的滚动条）。
- 标签上的圆点表示需要关注：配置指南有未通过的步骤；对比实验缺最后一档；清理标签页在资源闲置时提示。

#### S06-1 概览 `/console/modules/:id`

**目的**：用一屏讲清楚这个模块。启用前后各是什么、依赖什么、现在运行得怎样、花多少钱、做过什么。

```text
 有/无                                         当前运行（/api/capabilities）
 ┌ 没有它（EC2 本地实现）────────────┐          status  ok       driver  cloudfront   置信度 observed
 │ Nginx 直接发送页面、JS 和缩略图；    │          detail  最近 15 分钟 1,240 次经 CloudFront 的真实请求
 │ 入口只有 http://EIP 和自签名 https  │                  （按 $ca_entry 统计，不计探测请求）
 └──────────────────────────────────┘          路径样本 entry=cloudfront>nginx;inst=i-0abc…;cdn=cloudfront
 ┌ 有它（Amazon CloudFront）──────────┐          env 文件 /etc/cloudalbum/modules.d/cdn.env
 │ 边缘缓存，只有未命中才回源；          │            MODULE_CDN=on · CDN_BASE_URL=https://d111…cloudfront.net
 │ 受信任的 HTTPS（*.cloudfront.net）   │            CDN_ORIGIN_TYPE=ec2 · CDN_MEDIA_ORIGIN=s3 · CDN_DIRECT_ACCESS=open
 └──────────────────────────────────┘            密钥类键已隐藏
 架构变化（取自 registry lab.diagram）           依赖（注册表）
 之前：[浏览器]──▶[EC2 Nginx :80]               硬依赖  无（源站类型条件 DEP-010、014、028）
 之后：[浏览器]──▶[CloudFront]─┬▶[EC2 :8080]     学习顺序  iam [v] · storage [v]（媒体走 S3 源站）
                              └▶[S3 媒体桶（OAC）]  被依赖  waf、tls、auth（HTTPS 回调）
                                                费用  按量：请求数 + 流出流量
 时间线                                          重建约 15 分钟（栈部署 + 分配部署）
 10/04 21:03 before 实验（有效）· 10/05 10:31 接入应用 [v] · 11:20 after 实验（有效）· 模块完成
```

**数据来源**：`GET /api/console/modules/:id`（合并注册表、指南、进度、capabilities 管理员视图、最近一个路径样本、费用类别、时间线）。

**状态**

| 状态 | 表现 |
|---|---|
| 未解锁 | 依赖区标红，并写明规则编号，提供“先去 iam”的跳转；配置指南可以预览 |
| 运行 error | 运行区变红，显示 detail 和应用日志的最后 20 行（已脱敏） |
| 已清理 | 显示“当前未运行；学习记录保留；重新启用：`scripts/module enable cdn`” |
| 被后续 Lab 取代 | 显示“2 项检查已被 Lab 19 取代（源站改为 ALB），不算漂移” |
| 无凭证 | 控制面信息（栈状态、资源 ID）显示“需要 AWS 只读”，并给出控制台位置 |

#### S06-2 配置指南 `/console/modules/:id/guide/:stepId`

**目的**：配置指南的核心。在同一屏里看到“怎么做 / 预期结果 / 系统检测结果 / 常见错误 / SAA 提示 / 本步完成后架构怎样变化”。

下图（以及 S06-4 的示例）是学员 10/05 第一次做到步骤 4、认证 API 检查未通过时的样子，与上面页头的“已完成”是不同时刻。

```text
 [ 概览 ] [ 配置指南 • ] [ 对比实验 ] [ 考点 ] [ 清理 ]                      路线：(•)先手动后接管 ( )直接用脚本
 变量  publicDns=ec2-54-12-34-56.ap-northeast-1.compute.amazonaws.com [IMDS] · distributionId=E2QW…ZL [cdn.env]
       cdnDomain=d111abcdef8.cloudfront.net [capabilities] · myCidr=‹未填› [输入 ✎]（仅步骤 7 选做用到）
 本指南按 CDN_ORIGIN_TYPE=ec2（课程默认，直到 Lab 19/20）编写；storage 已是 s3 时会出现步骤 5。
+-------------------------+---------------------------------------------------+------------------------------+
| 步骤                     | 步骤 4  为静态资源、媒体、API 分别设置缓存行为  约 20 分钟 | 本步检测   [ 检测 R ]  轮询:关  |
| [v] 0 基线 before   10/04 | 为什么：动态接口绝不能被缓存；私有媒体的签名参数必须  | [x] 本地  认证 API 不被缓存      |
| [v] 1 准备源站       09:40 |        进入缓存键；Authorization、Cookie 要带到源站。  |     期望 第 2 次 X-Cache: Miss   |
| [v] 2 创建分配       10:02 | 做法 [控制台*] [CLI] [代码]       运行于：浏览器      |     实际 Hit from cloudfront    |
| [v] 3 接入应用       10:31 | 路径 CloudFront › 分配 › E2QW…ZL › 行为 › 创建行为 [打开 ↗]| [v] 本地  控制台 API 不被缓存     |
| [x] 4 缓存行为  ◀         | （全局服务，不需要切换区域，不显示区域提示）             | [v] 本地  回源带 Cookie/Authorization|
| [ ] 5 媒体改为 S3 源站     | 1. 新建缓存策略 cloudalbum-media（键只含 exp、sig）    | [v] 本地  静态资源第 2 次命中     |
| [ ] 6 after              | 2. /assets/*：CachingOptimized                       | [ ] 本地  私有媒体不泄露（未运行）  |
| [ ] 7 收紧直连（选做加固） | 3. /media/*：cloudalbum-media，不压缩   ← 高亮的小步   | [?] AWS   三个行为存在且方法正确   |
| ─────────────            | 4. /api/*：CachingDisabled + AllViewer，7 种方法      |     无凭证 → [去核对]            |
| 对比实验  before ✓        | 5. 全部排在 Default (*) 之前；挂响应头策略 cloudalbum-lab| 上次 10:58:03 · 2.1s · i-0abc…  |
| 考点卡    4 条            | 预期结果  /api/* 始终 Miss；去掉签名的媒体 URL 返回 403 | [ 查看详情与排错 ]                |
|                         | ▼ 常见错误（已命中 1 条）                             | ──────────────────────────── |
|                         |   ● /api/* 落到了会缓存的行为，或行为顺序不对 [跳到第 5 小步]| 本步完成后架构变化               |
|                         |   ○ 经 CDN 返回 401（Authorization 没转发）            | [CloudFront]─/api/* 不缓存─▶[EC2]|
|                         |   ○ POST 返回 403（允许方法只有 GET/HEAD）             |  └─/media/* 按签名缓存─▶[EC2]   |
|                         | ▶ 为什么（SAA）：缓存策略 vs 源请求策略 vs 响应头策略    |                              |
+-------------------------+---------------------------------------------------+------------------------------+
| [← 上一步]          本步尚未通过：可以先看下一步，但下一步的检测结果仅供参考                    [ 下一步 → ] |
+-----------------------------------------------------------------------------------------------------------+
```

**组件**

- **页头**
  - `VariableStrip`：每个变量标注来源（IMDS、cap、env、快照、输入、查询命令）。未填的变量标红；点击 ✎ 可以编辑，按 `pattern` 校验。
  - 路线切换：先手动后接管 / 直接用脚本（§5.4），选择保存在服务端 `guide_variables` 中。
  - `VariantNote`：指南声明了 `variants` 时，说明当前走的是哪个分支、哪个 Lab 会切换分支。
  - 占位指南（还没有手写、由注册表生成）在页头显示“占位指南：只有骨架步骤与通用检查”，不与真实指南混在一起展示。
- **左栏 `StepRail`**（`.railcol` 吸顶，`top: calc(var(--topbar-h) + 12px)`）
  - 步骤的状态符号与达成时间；步骤级文案用“已达成”（§4.4）。
  - 当前步骤用 `◀` 标出；`localTier` 步骤加“本地档”小标，`optional` 步骤加“选做”。
  - 底部有“对比实验”和“考点卡”的入口。
- **中栏 `StepCard`**
  - 标题、预计时长；“为什么”；`CostNotice`（只在 `startsBilling` 的步骤显示）；`ImpactNotice`（只在声明了 `impact` 的步骤显示，例如“执行后所有会话失效，你会被登出”）。
  - `when` 不成立的步骤显示“本步不适用：storage 不是 s3”，不计入分母。
  - 做法 Tab（`MethodTabs`，真正的 tablist：每个 tab 有稳定 id，内容区是 `role="tabpanel"` 并用 `aria-labelledby` 关联；←→ 切换后焦点留在新选中的 tab 上）和 `RunsOnTag`。
  - 控制台做法：`ConsolePath`（区域提示按 §5.5：global 不提示，us-east-1 写明原因，app 显示应用区域）加编号小步骤；CLI / 脚本做法：`CommandBlock`；代码做法：`CodeSnippet`。
  - 预期结果，附示例输出（可折叠）。
  - `PitfallList`：命中的条目会自动展开；“跳到第 k 小步”自动切到控制台做法、高亮并滚动到该小步（跨页面时先保存“待高亮”，渲染完成后再应用）。
  - `SaaTip`：可折叠。
- **右栏 `CheckPanel`**（`.checkcol` 吸顶，同样使用 `--topbar-h`）
  - `CheckResultRow` 列表；被取代的检查显示 `[^] 被 Lab 19 取代`；`WaitTimer`（等待型步骤）。
  - 上次检测的时间、耗时、执行实例。
  - “查看详情与排错”：打开 S10d 抽屉。
  - `MapDelta` 小图。
  - 等待时显示“等待时读一读”。
- **底栏**：上一步 / 下一步。下一步不要求本步通过，但会提示。

**数据来源**
- `GET /api/console/guides/:id`：解析后的指南，变量已代入，secret 已打码，并附带路线与当前分支。
- `GET /api/console/modules/:id/progress`
- `PUT /api/console/guides/:id/variables`
- `POST /api/console/checks/run {module, stepId}` → SSE `check.*`
- `POST /api/console/steps/:module/:stepId/skip`、`/read`

**状态**

| 状态 | 表现 |
|---|---|
| 加载 | 三栏骨架；检测栏显示“尚未检测” |
| 未开始 | 定位到步骤 0“记录基线”，突出 before 命令。如果模块已经启用，提示“补测模拟基线（旁路）”或“先禁用再测” |
| 检测中 | 检查行依次显示转圈，结果按 SSE 逐个出现；步骤符号变为 `[~]` |
| 等待中 | 蓝色时钟加 `WaitTimer`，不算失败 |
| 未通过 | 红色；显示期望值和实际值；自动展开命中的常见错误；“跳到第 k 小步”会切到控制台做法并高亮中栏对应的小步 |
| 检测器出错 | 灰色扳手图标，文案“这不是你的配置问题”，并给出修复方法；如果有 `manualFallback`，同时提供“改为手动核对” |
| 无凭证 | AWS 类检查显示 `[?]` 和“去核对”（打开 S10m）；页头提示“完成 Lab 1 · iam 后自动复核”；之前自动通过的检查保持通过并注明“当前无凭证，未复核” |
| 本步通过 | 本步折叠，自动展开下一步，`MapDelta` 播放 400ms 的变化动画（减少动态效果时不播放） |
| 全部通过（verifying） | 顶部横幅“cdn 配置已生效 → 运行 after 实验”，并直达 S06-3 |
| 已完成 | 顶部横幅“cdn 已完成（全自动）· 10/05 11:20”，并提供“下一个推荐” |
| 未解锁（预览模式） | 内容只读，检测按钮禁用，顶部 `DependencyLock` 说明“需要先启用 iam”（带规则编号）并提供跳转 |
| 已清理 | 步骤显示 `[z]` 和达成时间；顶部提供重建命令 |
| 漂移 | 步骤显示 `[!]`，标注“曾于 10/10 通过 · 现在未通过”，并提供证据对比 |
| 被取代 | 检查显示 `[^]`，步骤保持已达成，悬停说明取代它的 Lab 与原因 |
| 脚本路线 | 脚本覆盖的步骤显示“脚本已完成此步，点击检测确认”，并显示模板片段（代码做法） |
| 指南更新 | 新增步骤标记“新增”；已完成的模块标注“可选补做” |
| 占位指南 | 页头说明“占位指南”，控制台做法只有一句“在 X 控制台完成：…”，并链接到 `docs/modules/0N-<group>.md#<id>` |
| 指南加载错误 | 显示 `guides/cdn.yaml:142 断言 path 无效`，并给出 `docs/modules/01-edge-network-scaling.md#cdn` 作为备用链接 |

**交互**
- `R` 运行本步检测；Shift+点击“检测”运行整个模块。
- `J`/`K` 切换步骤（单键快捷键可在 S13 关闭）。
- 复制命令时，如果有未解析的变量，先提示并定位到变量面板；删除类命令在命令块内展开确认条（§8.3）。
- 切换做法后记住偏好（`localStorage`）。
- “在架构图上预览”：打开 S07，并叠加显示本步的 `mapDelta`。

**文案示例**
- 运行位置标签：“运行于：运维机（你的电脑或 CloudShell，需要部署权限）”。
- 计费提示：“从这一步开始按小时计费：RDS db.t4g.micro ≈$0.025/h（cost-rates.yaml）。练完可以在“清理”页生成清理步骤，学习进度不受影响。”没有 cost-rates.yaml 时：“从这一步开始按小时计费：RDS db.t4g.micro（按实例小时与存储计费，单价见官方定价页）。”

#### S06-3 对比实验（摘要）`/console/modules/:id/compare`

**目的**：在模块页内完成各档实验的记录与查看。完整的分析在 S08。

```text
 有/无 CloudFront（实验 ttfb：每次新建连接，直连与经 CloudFront 各请求 20 次 × 10 轮）
 ┌ before：EC2 直出 ───────────────┐ ┌ after：直连 与 经 CloudFront ──────────────┐
 │ ✓ 10/04 21:03 · 有效 · 200 次     │ │ ✓ 10/05 11:20 · 有效（客户端证据，按目标分组） │
 │ direct：entry=nginx 100%         │ │ direct：entry=nginx 100% · cdn：cloudfront>* 99% │
 │ TTFB p50 182ms · p95 410ms       │ │ cdn 命中时 TTFB p50 38ms                      │
 └─────────────────────────────────┘ └──────────────────────────────────────────┘
 实时 A/B（仅管理员，不计入完成判定） [ 双 URL：源站 vs CloudFront ×20 ]（由服务端执行，HTTPS 入口下照常可用）
 [ 打开完整对比 → ]
```

多档模块（queue、image-processing）按 `stages` 顺序并列显示各档，中间档标“选做”；完成判定只看第一档与最后一档（§4.7）。

**状态**：没有记录（显示该档的运行命令）/ 只有第一档 / 首尾两档都有（显示 3 个关键指标的 Δ 和结论的第一句）/ 校验中（rollups 补齐前，§4.7）/ 记录无效（红，附原因，例如“运行期间 cdn 驱动变化”）/ 模拟基线（标注）/ 浏览器运行器的结果（标“参考”）/ 定性模块（显示“现象对比卡”的两列）。这些措辞与 S08 完全一致，没有“没有对比实验”这种说法：模块没有任何记录时，两处都显示“还没有记录”并给出 before 命令。

**数据来源**：`GET /api/console/experiments?module=:id&limit=4`

#### S06-4 考点 `/console/modules/:id/exam`

```text
 考点卡（4）                                              与你的操作关联
 [安全] CloudFront 的证书必须在 us-east-1                   → tls（Lab 6，选做）
 [安全] 自定义源站只能是域名                                 → 你在步骤 2 中配置过（已达成）
 [性能] 三种策略分工                                         → 你在步骤 4 中配置过（未通过）
 [安全] S3 源站用 OAC                                        → 你在步骤 5 中配置过（未开始）
 易混概念
   缓存失效 vs 版本化文件名：发布频繁时用带哈希的文件名
   CloudFront vs Global Accelerator：可缓存的 HTTP 内容选 CloudFront；TCP/UDP、固定 IP 选 GA
   OAC vs OAI：新建一律用 OAC
 本模块练习题（2）        [ 开始 ]      Lab 5 小测 [ 去做 → ]
 我的笔记 [________________________________________________]（写进学习报告）
```

**数据来源**：`GET /api/console/guides/:id`（exam 段）、`GET /api/console/quiz/:labId/summary`、`PUT /api/console/modules/:id/notes`。

**状态**：没有考点（显示“本模块暂无考点卡”）；关联步骤未完成时，显示灰色关联链接。

#### S06-5 清理 `/console/modules/:id/cleanup`

```text
 清理 cdn（Amazon CloudFront）                      当前：运行中 · 按量计费 · 闲置 0h
 影响  学习进度保留（模块变为 [z] 已完成·已清理）；下游依赖：waf（运行中）→ 需要先清理 waf，或用 --cascade
 数据风险  无业务数据；已发出的含 CDN 绝对链接的邮件会失效
 1  scripts/module disable waf            [复制]  删除类命令 · 运行于：运维机（下游先清理）
 2  scripts/module disable cdn            [复制]  删除类命令 · 运行于：运维机
    （点“复制”后在命令块内展开确认条：“将删除 CloudFront 分配（路线 S 创建的），已发出的 CDN 链接会失效。
      [确认复制] [取消]”）
 手动收尾（路线 M 接管的资源，disable 不会删除）
    [ ] 在 CloudFront 中先“禁用”分配 E2QW…ZL，等待部署完成后再“删除”      [打开控制台 ↗]
 验证  [ 运行清理验证 ]   [ ] cdn 能力为 off   [ ] 分配 E2QW…ZL 不存在（AWS 只读 · 等待型）
       分配 ID 取自 10/05 10:31 启用时固化的快照值（disable 会删除 cdn.env）
```

**组件**：`CleanupPlan`（与 S11b 相同，范围固定为本模块）。

**数据来源**：`GET /api/console/cleanup/plan?scope=module:cdn`、`POST /api/console/cleanup/verify`。

**状态**

| 状态 | 表现 |
|---|---|
| 未启用 | “当前没有运行中的资源” |
| 有下游依赖 | 先列出下游模块（取自总纲 §9.2 disable 第 1 步的反向依赖） |
| 验证中 | 等待型轮询 |
| 验证失败 | 列出残留资源，并给出常见原因 |
| 快照缺失 | 学员从未让 wire 达成时，验证所需的资源 ID 改为输入（按 pattern 校验） |
| 无凭证 | 验证项改为手动核对清单 |

---
### S07 架构图视图 `/console/map`

**目的**

用一张固定布局、实时点亮的架构图，展示“我已经搭出了什么”：
- L0 时只有 EC2 亮着，EC2 内画满“本地芯片”（本地实现）。
- 每启用一个模块，对应芯片就从 EC2 中迁出，变成一个亮起的 AWS 节点，并加上一条真实的请求连线。

这张图是同一份数据的空间视图，不承担主导航（§2.5）。

**线框（镜头 = 运行，完整蓝图）**

```text
 架构图   镜头 [运行*] [进度] [费用] [流量]    [ ] 完整蓝图（默认简洁）   窗口 5m ▾   [发送探测请求]   图例 ?
+----------------------------------------------------------------------------------------------------------+
| ┌ AWS 账号 · ap-northeast-1 ── 护栏 [Budgets ●][根 MFA ●][CloudTrail ○][GuardDuty ○][Config ○][Inspector ○] ┐ |
| │ [学员终端]══SSH:22══┐   ┌ 观测平面 ─────────────────────┐                                       │ |
| │          ┄┄SSM ○┄┄┄┤   │ [CW Logs ●] [CloudWatch ◐] [X-Ray ○] │                                       │ |
| │                    │   └──────────────────────────────┘                                       │ |
| │ [浏览器 你在这里]═▶[Route53 ○]┄▶[CloudFront ◐ ⓦ○ ⓣ○]══/assets hit 82%══╗                       │ |
| │        ║                                  ║ /api/*                      ║                       │ |
| │        ║ 预签名直传（未启用）               ║                             ▼                       │ |
| │        ║   ┌ 默认 VPC ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄║┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐  [S3 ○]   [Cognito ○]         │ |
| │        ║   ┆ [ALB ○]                         ▼                ┆  [DynamoDB ○] [IdPool ○]       │ |
| │        ╚══▶┆ ┌ EC2 i-0abc ● ─[iam ●]──────────────────────┐   ┆  [RDS ○]  [ElastiCache ○]      │ |
| │            ┆ │ Nginx · api · worker                         │   ┆  [EFS ○]  [Backup ○]           │ |
| │            ┆ │ 本地芯片：[EBS 上传][SQLite][无缓存][本地账号]   │   ┆                               │ |
| │            ┆ │ [sync 队列][inline sharp][node-cron][outbox]   │   ┆  [Secrets ●][Param ●][KMS ○]   │ |
| │            ┆ │ [站内信表][likes 表][click_events][fail2ban]    │   ┆                               │ |
| │            ┆ └──[EBS ●]──[EIP ●]──────────────────────────┘   ┆                               │ |
| │            └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘                               │ |
| │ 异步  [SQS ○]→[Lambda ○]→[Rekognition ○]  [SNS ○]→[SES ○]  [Scheduler ○]  [API GW ○]  [Firehose ○] │ |
| └───────────────────────────────────────────────────────────────────────────────────────────────┘ |
| 当前档位 l2-edge +2 · 已点亮 15 · 本地芯片 24 · ASG 提示：进程内 LRU、memory 队列芯片仍在 EC2 内          |
+----------------------------------------------------------------------------------------------------------+
 ┌ 节点抽屉 ?node=cdn ───────────────────────────────────────────────┐
 │ cdn · Amazon CloudFront ★   Lab 5                                  │
 │ 运行  ● ok · cloudfront · 最近 15 分钟仍有 37 次请求直连 EIP（绕过 CDN）│
 │ 学习  [v] 7/7 · 已完成                  对比  before ✓ after ✓        │
 │ 费用  按量                              连线  浏览器→CF 1,240 次/15m   │
 │ 替代了  EC2 芯片“Nginx 直出”                                         │
 │ [ 继续指南 ] [ 对比实验 ] [ 请求路径 ]                                 │
 └────────────────────────────────────────────────────────────────────┘
```

**镜头（几何布局不变，只换编码）**

| 镜头 | 节点填充 | 外环 / 角标 | 连线 |
|---|---|---|---|
| 运行（默认） | capabilities：`ok` 实心、`degraded` 琥珀、`error` 红、`off` 灰色虚线（幽灵节点） | `[!]` 漂移；`$` 正在按小时计费 | 观测到的请求 |
| 进度 | 学习生命周期的颜色（§11.3） | 外环弧长 = 已达成步骤 / 必需步骤；自动部分用实线，手动部分用斜纹 | 无 |
| 费用 | 按小时计费的节点颜色按单价由浅到深；按量计费为浅色；免费为空心 | `≈$0.025/h` 标签；闲置节点加红框 | 无 |
| 流量 | 与“运行”相同 | — | 线宽 = 窗口内的请求数；标签为结果（hit 82%）；红线表示 `error-bypass`；紫线表示旁路 |

**元素约定**（取自 `console/topology.yaml`）

- **框**：AWS 账号框（标题栏挂账号级护栏：cost 的 Budgets、ec2 的根账号 MFA、audit、threat-detection、compliance、vuln-scan）；VPC 框（network 启用后标题从“默认 VPC”变为“CloudAlbum VPC”，并画出子网分栏）；AZ 列（autoscaling 启用后，EC2 节点复制成多实例堆叠）。
- **跳点节点**：位于请求路径上的服务，例如 Route 53、CloudFront、ALB、API Gateway、Cognito。
- **附件徽章**：挂在宿主节点上，包括 waf `ⓦ`、tls `ⓣ`（挂在 CloudFront / ALB 上）、kms 钥匙（挂在 S3 / RDS / EBS / Secrets 上）、iam 角色牌（挂在 EC2 上）、backup 环、identity-pool（挂在“浏览器→S3”连线上）。徽章的点击区域至少 24×24px。
- **本地芯片**：每个未启用模块的本地实现，以芯片形式画在 EC2 框内。对应关系见下表，取自总纲 §2.8。

| 模块 | 芯片 | 模块 | 芯片 | 模块 | 芯片 |
|---|---|---|---|---|---|
| storage | EBS 上传 | database | SQLite | cache | 无缓存 / 进程内 LRU |
| auth | 本地账号 | secrets | secrets.env | config | runtime.json |
| kms | 本地主密钥 | queue | sync / memory 队列 | image-processing | inline sharp |
| tagging | 基础属性标签 | notification | 站内信表 | email | outbox |
| scheduler | node-cron | social-store | likes 表 | social-api | Express /social |
| analytics | click_events | backup | 同卷备份 | logging | 日志文件 |
| monitoring | 本地指标库 | tracing | 单跳 Server-Timing | audit | audit_log 表 |
| threat-detection | fail2ban | waf | Nginx 限速 | cdn | Nginx 直出 |
| tls | 自签名证书 | dns | http://EIP | load-balancer | Nginx 反代 |
| autoscaling | 单实例 | network | 默认 VPC | shell-access | SSH:22 |
| iam | 无身份 | identity-pool | 本地前缀上传令牌 | shared-fs | 本地盘 |
| cost | 本地估算 | compliance | 本地自检器 | vuln-scan | dnf 安全更新 |
| db-proxy | Knex 连接池 | workflow | 进程内编排 | ami | User Data 安装 |

- **连线来源**：
  - 实线：取自 LabMetricsStore 按路径签名聚合的数据（`GET /api/lab/metrics?groupBy=path`，总纲 §7.3），窗口内实际观测到的请求。
  - 点线：异步与控制面连线（SQS → Lambda、读取 Secrets），来自配置推断，悬停时说明“由配置推断”。
  - 虚线：模块已启用，但窗口内没有观测到流量。
- **你在这里**：根据当前浏览器同源请求的 `X-CloudAlbum-Path` 中的 `entry` 段，判断控制台本身是经哪个入口访问的。“发送探测请求”产生的请求带探测令牌，只用于点亮“你在这里”和入口链，不计入连线的流量统计。
- **ASG 提示**：只要 SQLite、EBS 上传、进程内 LRU、memory 队列等“有状态芯片”还在 EC2 内，autoscaling 节点就显示“有状态芯片阻止横向扩展”，并链接到总纲的 ASG-001～014 规则。

**组件**：`ArchMap`（SVG）、`ArchBox`、`ArchNode`、`ArchBadge`、`LocalChip`、`ArchEdge`、`LensSwitch`、`NodeDrawer`、`MapLegend`。

**数据来源**：
- `GET /api/console/topology`
- `GET /api/console/map/state?lens=`（合并 capabilities、模块进度、费用、档位）
- `GET /api/lab/metrics?groupBy=path&from=&to=`
- SSE：`capability.changed`、`module.changed`、`traffic.agg`

**状态**

| 状态 | 表现 |
|---|---|
| 空 / L0 | 默认简洁模式：只显示已点亮的节点，以及推荐的 3 个幽灵节点（带脉冲光环）。EC2 内画满芯片。中央提示“这就是 L0：一台 EC2 跑起整个相册”。唯一的连线是“浏览器 → EC2（entry=nginx）” |
| 加载 | 先画账号框和 VPC 框，节点显示灰色骨架 |
| 部分完成 | 同线框 |
| 无流量 | 节点已经点亮，但连线全是虚线。提示“点击‘发送探测请求’，或打开一次相册首页” |
| 实验进行中 | 被测节点加“实验中”角标；探测请求暂停，避免污染实验数据 |
| 漂移 / 故障 | 节点变红；相关连线变红，标注 `storage=s3:error`；待处理事项置顶 |
| capabilities 不可达 | 保留最后已知状态，节点叠加斜纹，标注“过期 · 2 分钟前” |
| 已清理 | 节点变暗，保留金色 ◇ 轮廓（表示学过但已拆除）；芯片回到 EC2 内 |
| 窄屏（<768px） | 不渲染 SVG，改为分层列表：账号 → 入口链 → VPC → EC2 → 数据 → 异步 → 运维。状态编码与图上一致 |
| topology.yaml 加载失败 | 整页报错，并给出“模块目录”作为替代入口 |

**交互**
- 单击节点、徽章或框，打开抽屉（`?node=`）；只高亮该节点及其一跳邻居。
- 双击进入 S06-2。
- 单击连线，显示请求数、p50、最近 5 条样本，以及“这条线为什么在这里”（来自 topology 中的 `edge.explain`）。
- 镜头和“完整蓝图”开关写入 URL。
- “发送探测请求”：浏览器经当前入口发出同源请求，服务端经其他入口发起探测（同 S09）。
- 模块启停事件到达时播放动画：启用时芯片迁出、节点点亮；禁用时节点熄灭（尊重 `prefers-reduced-motion`）。
- 键盘：Tab 进入图后只停在一个节点上（roving tabindex）；←→↑↓ 按屏幕几何位置移动到该方向上最近的节点；Enter 打开抽屉；Esc 关闭抽屉并把焦点还给节点。

---

### S08 对比实验详情 `/console/experiments/:module`（含 S08a 实验记录本 `/console/experiments`）

**目的**

把同一模块“无（EC2 本地实现）”和“有（AWS 实现）”的差别量化，并排展示，生成结论卡。同时完成判定来源 ④ 的有效性校验。这个页面取代原来的 `/lab/compare` 和 `/lab/m/:id` 的实验部分。

**线框（标签页：实验记录）**

```text
 对比实验 › queue · 有/无 Amazon SQS ★                 [实验记录*] [实时 A/B] [现象/功能矩阵]      [导出本对比 MD]
 实验  upload-burst：10 VU × 60s 上传 + 完成回调（experiments/queue/upload-burst.k6.js）
 档位  before（sync）[ 10/13 09:12 · 有效 ▾ ] → memory（选做）[ — ] → after（sqs）[ 10/13 11:40 · 有效 ▾ ]   运行于：运维机（cli）
 有效性 [v] 驱动 before=sync / after=sqs（取自服务端登记 run 时的 capabilities 快照）  [v] 运行期间驱动未变化
        [v] 路径占比 100% / 99.6%（rollups 已补齐）  [v] 参数一致  [v] 实例类型一致  [v] 未强制

                            无：sync（请求内同步处理）      有：Amazon SQS + worker          Δ
 上传完成接口 p50 / p95      420 / 2,900 ms                  38 / 95 ms                      ▼ 97%（更快）
 缩略图就绪 p95              3.1 s                           3.6 s                           ▲ 16%（更慢，预期内）
 5xx 错误率                  6.5%（120/1840）                0%                              ▼
 EC2 CPU p95                 98%                             61%                             ▼
 kill -9 worker 后丢失任务    —（sync 档不适用）              0                               —
 DLQ 最大深度                 —                               0                               —
 新增费用                     —                               按量（请求数），≈$0.00/h          —
 分布  [上传完成接口延迟直方图：before 灰 / after 青，叠加，对数轴]
 典型请求 Server-Timing
   before  total 2,870 |image-processing ███████████████████ 2,610|database █ 120|app ▏40
   after   total 41    |queue ██ 22|database ▏9|app ▏10
 路径     before  entry=nginx;…;queue=sync:inline;image-processing=inline:sync
          after   entry=nginx;…;queue=sqs:queued;image-processing=worker:async
 结论（自动生成，可编辑）
   上传接口不再等待缩略图生成，p95 从 2.9s 降到 95ms；缩略图就绪时间略有增加（排队 + 轮询）。
   worker 被杀后，SQS 重新投递，任务 0 丢失。
 SAA：SQS 解耦与削峰；可见性超时 ≥ 6 × 消费者处理时间；DLQ 的 maxReceiveCount       [ 去考点 ] [ 写笔记 ]
```

**线框（标签页：实时 A/B，仅管理员，不计入完成判定）**

```text
 模式  旁路头（X-Compare-Bypass: queue）   请求  POST /api/photos/:id/complete（实验专用测试照片）   次数 [10]
 [ 发送 10 对 ]   自动探测已暂停
  #  旁路   X-CloudAlbum-Path                                       Server-Timing                   总耗时
  1  否     entry=nginx;queue=sqs:queued;image-processing=worker:async   queue;dur=21 app;dur=9           41ms
  1  是     entry=nginx;queue=sqs:bypass-inline;image-processing=inline:sync  image-processing;dur=2611   2,700ms
 汇总  正常 p50 40ms · 旁路 p50 2,650ms    （旁路请求带 Cache-Control: no-store，并写入 audit_log）
```

**多档实验**：queue 与 image-processing 按 04 文档是多档（queue：sync → memory → sqs；image-processing：inline → worker-memory → worker-sqs → lambda）。页头的档位选择器按 `compare.stages` 排列，对比表按档位并列显示；中间档是选做，完成判定只看首尾两档（§4.7）。

**重点模块的对比设计**（与总纲 §8.2 的“核心对比实验一览”一致；指标、档位和运行器由各 `guides/<id>.yaml` 的 compare 段声明）

| 模块 | 实验（示例 id） | 运行器 | 实时对比 | 指标（展示顺序） | 页面上的特别呈现 |
|---|---|---|---|---|---|
| auth（Cognito） | `auth-flow` | cli + 浏览器（真实登录） | 无（权威数据，不能旁路） | 登录全流程耗时、`auth` 段耗时（首次拉 JWKS / 缓存后）、本地库中有密码哈希的用户数（`app-stat`，→ 0）、前端包体积变化 | “功能矩阵”标签页：MFA、邮箱验证、找回密码、托管登录页、验证码去向（outbox / Cognito）；并排解码令牌（`iss` 从本地变为 `cognito-idp.<region>.amazonaws.com/<pool>`，多出 `cognito:groups`） |
| queue（SQS） | `upload-burst`（档位 before=sync → memory → after=sqs） | cli | 旁路头 `queue`（`POST /api/photos/:id/complete`，在旁路白名单内） | 上传接口 p50/p95、缩略图就绪 p95、5xx、CPU p95、`kill -9` 后丢失的任务、DLQ 深度（需要 AWS 只读 `GetQueueAttributes`） | 三档并列；故障注入结果单独成行：“memory 档丢 N 个 / SQS 丢 0 个” |
| cdn（CloudFront 缓存） | `ttfb`、`media-load` | cli（运维机，客户端证据按目标分组）；浏览器运行器只作参考 | 双 URL（由服务端执行）+ 旁路头 `cdn` | TTFB p50/p95、边缘命中率（运行器记录的 `X-Cache`）、源站请求数（`lab_origin_samples`，按 `$ca_entry` 统计）、EC2 出站字节 | after 一条记录里分成“after·直连”“after·CloudFront”两列；浏览器运行器在页面里发 50 次请求，读取 Resource Timing 中的 `serverTiming`，结果标“参考” |
| image-processing（Lambda） | `upload-burst`（档位 before=inline → worker-memory → worker-sqs → after=lambda） | cli | 旁路头 `image` | 上传接口 p95、EC2 CPU 峰值与 steal、缩略图就绪 p95（含冷启动尾部）、Lambda Init Duration（需要 CloudWatch，没有凭证时省略；按量计费的读取只在手动触发时调用） | 四档并列；就绪时间分布中，冷启动尾部单独着色 |
| cache（ElastiCache） | `feed-read`、`cache-stampede` | cli | 旁路头 `cache` | `GET /api/feed` p50/p95、每请求 database 调用次数、命中率 | 支持四列：none / memory / 自建 Valkey / ElastiCache（总纲：四档对比） |
| storage（S3） | `upload-burst`、`ebs-growth`、`upload-sidebyside` | cli | 无（权威数据） | EC2 网卡入站字节（直传后显著下降）、数据卷占用增长、上传路径中 `storage` 段（写盘 → 签名） | 两列柱状图：“上传字节经过 EC2 吗？” |
| database（RDS） | `mixed-rw`、`failover`；扩展 db-proxy：`conn-storm` | cli | 无 | 单查询延迟（RDS 多一次网络往返，可能更慢——这本身就是考点）、并发写吞吐、`SQLITE_BUSY` 次数、故障转移中断秒数（Multi-AZ 演练） | Δ 列不预设好坏；结论卡解释“更慢但换来了什么” |
| 定性模块（kms、audit、shell-access、iam……） | `functional` / `fault` | 浏览器 + 检查 | 无 | — | **现象对比卡**：同一个动作，左列“无”、右列“有”，各记录看到了什么。例如 audit：删除一个测试对象后能不能查到是谁删的；iam：`whoami` 从“无凭证”变为 `assumed-role/CloudAlbumAppRole/i-…`（ASIA 开头，带过期时间） |

**S08a 实验记录本**：每个模块一行，列包括：主题、before 时间、after 时间、关键差异、状态（完成 / 待 after / 校验中 / 无效 / 模拟基线 / 参考）。“只看重点对比”预设筛选上表中的 7 个模块。可以导出 CSV。没有任何记录的模块显示“还没有记录”并给出 before 命令，与 S06-3 的措辞一致。

**组件**：`CompareHeader`、`ValidityChecklist`、`CompareTable`（含 `DeltaCell`）、`DistributionChart`、`ServerTimingBar`、`PathSignature`、`EnvDiff`、`ConclusionCard`、`LiveAbPanel`、`PhenomenonCard`。

**数据来源**：
- `GET /api/console/experiments?module=`
- `GET /api/console/experiments/:runId`
- `POST /api/lab/runs`（运行器登记；服务端保存 capabilities 快照，§4.7）
- `POST /api/lab/results`（运行器上报，使用实验上传令牌，总纲 §8.2）
- `POST /api/console/experiments/browser`（浏览器运行器上报，结果只作参考）
- `PUT /api/console/experiments/:module/conclusion`
- 实时 A/B 由浏览器直接发出同源 `fetch`，带 `X-Compare-Bypass`（总纲 §8.3）

**状态**

| 状态 | 表现 |
|---|---|
| 没有记录 | 显示“还没有记录”，先引导记录 before：“实验要在启用模块**之前**先跑 before”，给出命令；如果模块已经启用，提供“旁路补测模拟基线” |
| 校验中 | 上传后、rollups 补齐之前：该列显示“校验中（约 30 秒）”，校验完成后由 SSE `exp.recorded` 更新 |
| 只有 before | 右列显示占位和 after 命令；模块尚未接入时，按钮禁用并说明原因 |
| 运行中 | 运行器在 `POST /api/lab/runs` 登记后，页面显示进度和预计剩余时间（来自 SSE `exp.progress`），可以取消 |
| 完成 | 两列都有数据，显示结论卡；所属模块阶段条中的“对比”打勾 |
| 无效 | 整列标红，并说明原因，例如“after 时 cache.driver=memory”“参数不一致：vus 10 vs 20” |
| 结果可能过期 | after 之后模块 env 发生了变化：“记录后模块配置有变化，建议重跑” |
| 实验脚本失败 | 显示退出码和最后 20 行输出（来自上报的 `notes`），给出常见原因：目标 URL 不通、实验上传令牌过期或被撤销（在 S13 重新签发，再 `npm run exp:login`） |
| 浏览器运行器的结果 | 列头标“参考”，说明“样本与驱动来自浏览器，不计入完成判定” |
| 无凭证 | 需要 CloudWatch 的指标显示“需要 AWS 只读，已省略”，不影响完成判定 |
| 不支持实时 A/B | A/B 标签页灰显，并说明原因（权威数据端口不能按请求切换） |

---

### S09 请求路径检查器 `/console/traffic`

**目的**

把 `X-CloudAlbum-Path` 和 `Server-Timing` 变成看得见的路径：
- 按路径签名聚合真实请求；
- 从多个入口发起探测；
- 暴露“绕过 CloudFront 直连 EIP”“驱动出错后按未命中处理”“管理员旁路”这类问题。

这个页面取代 `/lab/trace`。

**线框**

```text
 请求路径检查器                         窗口 [5m ▾]  [ ] 只看异常   [ ] 包含实验流量   [暂停实时]
 入口探测   [ 全部探测 ]（探测请求带探测令牌，不计入下面的路径签名统计）
  直连 EIP  http://54.12.34.56      200  entry=nginx            [!] 未经 CDN（cdn 已启用，源站仍对公网开放）
  CloudFront d111…cloudfront.net    200  entry=cloudfront>nginx  X-Cache: Hit · cdn-pop NRT57
  自定义域名 album.example.com      —    dns 未启用
  ALB        —                      —    load-balancer 未启用
+----------------------------------------------------------+-------------------------------------------------+
| 路径签名（LabMetricsStore，最近 5 分钟）                    | 选中 #2  GET /api/feed                           |
| #  次数  p50   p95   错误  签名                            | [浏览器]══▶[CloudFront]══▶[Nginx]══▶[api]         |
| 1  812   6ms   18ms  0%    entry=cloudfront>nginx;          |                       └─▶[ElastiCache] miss      |
|                            cache=redis@elasticache:hit       |                       └─▶[RDS]                   |
| 2  143   41ms  90ms  0%    …;cache=redis@elasticache:miss;    | Server-Timing（平均）                            |
|                            database=postgres@rds              |  cdn-*   ▏ 4ms（边缘）                           |
| 3  37    45ms  95ms  0%    entry=nginx;…  [!] 绕过 CDN         |  auth    ▏▏ 2ms                                 |
| 4  12    —     —     100%  …;cache=redis@elasticache:         |  cache   ▏ 1ms                                  |
|                            error-bypass  [!] 降级               |  database ▏▏▏▏▏▏▏ 31ms                         |
| 5  20    8ms   —     0%    …;bypass=cache  [旁路·管理员]        |  app     ▏ 3ms                                  |
| 异步（作业记录 job_runs）                                    | 最近样本  10:44:02 200 41ms req-01JA…  [展开头部] |
| 6  20    2.8s  —     0%    queue=sqs → worker → image:worker   | [ 在架构图上显示 ]                               |
+----------------------------------------------------------+-------------------------------------------------+
 单请求检查  方法 GET  路径 [/api/feed______]  入口 [当前 ▾]  旁路 [ ]cache [ ]cdn [ ]queue   [ 发送 ]
  → 200 · 43ms · entry=cloudfront>nginx;inst=i-0abc;az=apne1-az4;cache=redis@elasticache:miss;database=postgres@rds
    响应头（已脱敏）x-cache: Miss from cloudfront · age: — · via: 1.1 …cloudfront.net (CloudFront) · server-timing: …
```

**组件**：`EntryProbeList`、`PathSignatureTable`、`PathDiagram`（局部 ArchMap）、`ServerTimingBar`、`RequestInspector`、`HeaderTable`（已脱敏）。

**数据来源**：
- `GET /api/lab/metrics?groupBy=path&from=&to=`（总纲 §7.3）
- `GET /api/lab/requests/recent?limit=200`
- `POST /api/console/traffic/probe {entries:[...]}`：服务端按 target 枚举发起探测
- 浏览器同源 `fetch`（单请求检查）
- SSE：`traffic.agg`（每 10 秒推送前 20 个签名）

**状态**

| 状态 | 表现 |
|---|---|
| 空（L0 刚启动） | “还没有流量。打开相册首页，或点击‘全部探测’” |
| 只有直连入口 | 其他入口灰显，并标注对应模块，例如“需要 cdn” |
| 有异常签名 | `error`、`error-bypass`、绕过 CDN 的签名置顶标红，并链接到对应模块的检查 |
| 实验进行中 | 默认隐藏实验流量（按 runId 分组）；勾选“包含实验流量”后才显示 |
| 路径头可见性为 `admin` | 正常显示（控制台本来就只有管理员能用）；入口探测带探测令牌，不论取值都能看到路径头。如果是 `off`，单请求检查提示“EXPOSE_PATH_HEADERS=off，路径头只在访问日志和 LabMetricsStore 中可见” |
| 数据库不可用 | 只显示内存中最近的请求，并提示“分钟级汇总不可用” |
| 窄屏 | 签名表在上，详情在下 |

**交互**：
- 点击签名，更新右侧详情。
- “在架构图上显示”跳到 `/console/map?lens=traffic`，只高亮这条路径。
- 单请求检查中，路径只允许填写站内路径（以 `/` 开头）。
- 旁路复选框只在注册表声明了该旁路键的路由上可用，其余灰显。

---

### S10 检测报告 `/console/checks`（含 S10d 检查详情抽屉、S10m 手动确认对话框）

**目的**

以 Trusted Advisor 风格的清单，列出所有检查的最新结果。这是“完成度”的明细账，也是排错入口。

**线框**

```text
 检测报告                                   上次全量检测 10:42 · 检测能力：部分     [ 复核全部 ] [ 导出 JSON ] [ 导出 CSV ]
 ┌ 必需检查 309 ─────────┐ ┌ 按结果 ──────────────────────────────────────────────┐ ┌ 按来源 ──────────────────┐
 │ 已满足 119（39%）      │ │ ✓通过 116 · M含手动 3 · ✕未通过 1 · !漂移 3            │ │ ◇本地 66 · ○探针 43       │
 │ ▕██████░░░░░░░░░▏      │ │ ⚙检测器出错 1 · ?待核对 0 · ◷等待中 0 · 过期 1 · 未运行 185│ │ □AWS 116 · △实验 79 · ⬚手动 5│
 └───────────────────────┘ └────────────────────────────────────────────────────┘ └──────────────────────────┘
 筛选 状态 [需要处理 ▾]  来源 [全部 ▾]  模块 [全部 ▾]  Lab [全部 ▾]  [x] 仅必需   分组 (•)平铺 ( )模块 ( )Lab ( )来源
 状态  检查                                    模块·步骤                 来源    上次      摘要                       操作
 [!]   缓存安全组允许来自应用安全组的 6379       cache · 2 网络             AWS     3 分钟前   入站规则 0 条（曾于 10/10 通过）[排错]
 [!]   请求路径命中 ElastiCache                 cache · 4 接入应用          本地    3 分钟前   cache=redis@elasticache:error-bypass [排错]
 [x]   回调地址为 HTTPS                          auth · 3 托管登录           AWS     3 分钟前   CallbackURLs 中有 http://     [排错]
 [e]   托管登录域已创建                          auth · 3 托管登录           AWS     3 分钟前   ACCESS_DENIED（检测器缺权限）  [改为手动核对]
 [?]   Budgets 测试告警邮件已收到                cost · budgets             手动    —         待你确认                     [确认]
 ·过期 实例角色已附加并能扮演 Verifier 角色       iam · 3 verifier           AWS     26 小时前  通过（已过期）                [复核]
```

- “按结果”汇总的每一项都同时有形状、短文字和数字，汇总整体带 `aria-label`（例如“通过 116 项、含手动 3 项、未通过 1 项……”），不只靠图标。
- 默认排序：漂移 → 未通过 → 检测器出错 → 待核对 → 等待中 → 过期 → 其余。
- 不适用（`when` 不成立）与被取代的检查默认不显示，状态筛选选“全部”时才出现，分别显示 `[-]` 和 `[^] 被 Lab N 取代`。
- 检测能力为“仅本地”时，之前自动通过的 AWS 检查仍显示通过并加注“当前无凭证，未复核”；其余 AWS 检查显示 `[?]` 与“AWS→手动”。

**S10d 检查详情抽屉（`?check=cdn.behaviors.api-not-cached`）**

```text
 ┌ 检查详情 ─────────────────────────────────────────────────────────── [再测一次] [复制诊断包] [×] ┐
 │ [x] 认证 API 不被缓存（/api/console/probe/now）                                                      │
 │ cdn.behaviors.api-not-cached · 必需 · 来源：本地（http-header，服务端执行，带探测令牌）· 指南 v4.1.0  │
 │ 10:44:03 · 2.1s · run 01JA3… · 执行于 i-0abc123（apne1-az4）· 触发：进入步骤时自动                     │
 │ 期望 vs 实际                                                                                    │
 │   第 2 次请求的 X-Cache   期望 包含 “miss”   实际 “Hit from cloudfront”   [x]                       │
 │ 判定逻辑  经 CloudFront 请求探测端点两次，第二次不得命中缓存，且两次时间戳不同                          │
 │ 复现命令（运维机）for i in 1 2; do curl -s -D - -o /dev/null https://d111…cloudfront.net/api/me \      │
 │                     | grep -i x-cache; done                                              [复制]    │
 │ 证据（已脱敏）▸ 两次请求的状态码、响应头                                                           │
 │ 可能原因（命中 1 条，按匹配度排序）                                                                 │
 │   1. /api/* 落到了带缓存的默认行为，或者行为顺序不对      → [跳到步骤 4 第 5 小步]（切到控制台做法并高亮）│
 │ 历史  10:44 [x] · 10:30 [x] · 10/12 21:15 —                                                       │
 │ ─────────────────────────────────────────────────────────────────────────────────────────────── │
 │ （AWS 类检查且无凭证时，这里显示手动核对区，见 S10m）                                               │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- “复现命令”区块只显示检查自己声明的 `reproduce`（附运行位置）；没有声明时整个区块隐藏，不使用任何兜底示例（lint 要求声明，§5.11）。
- “跳到步骤 k 第 j 小步”会关闭抽屉，切到该步骤的控制台做法，高亮并滚动到第 j 小步；同一步骤内也能生效（不依赖 URL 变化）。

**S10m 手动确认对话框（`?confirm=ec2.baseline.ebs-encrypted`）**

```text
 ┌ 手动核对：EBS 数据卷已加密 ──────────────────────────────────────────────────────────────────┐
 │ 类型  降级手动 · 原本是 AWS 只读检查 ec2:DescribeVolumes                                       │
 │ 原因  实例没有 IAM 角色（完成 Lab 1 · iam 后会自动复核此项）                                     │
 │ 去哪里看  EC2 › 卷 › 筛选“附加到 i-0abc123” › 加密 列      区域：ap-northeast-1  [打开控制台 ↗]   │
 │           （链接取自 ManualSpec.where.deepLink；没有时按模块与区域生成，不会跳到别的服务）          │
 │ 你看到的是                                                                                    │
 │   ( ) 两个卷（根卷与数据卷）都显示“已加密”                                                       │
 │   ( ) 至少一个显示“未加密”  → 提示：加密只能在创建卷时决定；需要“快照 → 复制时加密 → 用快照建卷”     │
 │   ( ) 找不到这台实例的卷                                                                       │
 │ 可选：粘贴证据（用与自动检查相同的断言校验）                                                       │
 │   运维机 ▸ aws ec2 describe-volumes --filters Name=attachment.instance-id,Values=i-0abc123 \      │
 │            --query "Volumes[].Encrypted" --region ap-northeast-1              [复制]             │
 │   [ [true, true]                                                       ]   [ 校验 ] → [v] 通过   │
 │ 备注（必填）[ 两个卷都显示已加密，10/13 核对                ]                                     │
 │ 说明：手动确认计入“含手动”，不计入“全自动”；凭证可用后会自动复核，结果不一致时会标红提示。               │
 │                                                                 [ 取消 ]  [ 记录手动确认 ]      │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**组件**：`SummaryTiles`、`FilterBar`、`DataTable` + `CheckResultRow`、`CheckDrawer`、`ExpectedActualTable`、`PitfallList`、`ResultHistory`、`ManualConfirmDialog`、`EvidencePaste`。

**数据来源**：
- `GET /api/console/checks?…`
- `GET /api/console/checks/:checkId?history=10`
- `POST /api/console/checks/run`
- `POST /api/console/manual-confirmations`
- `POST /api/console/manual-confirmations/evaluate`
- `DELETE /api/console/manual-confirmations/:id`
- `GET /api/console/logs/tail?module=&n=20`（已脱敏）
- `GET /api/console/checks/export?format=json|csv`

**状态**

| 状态 | 表现 |
|---|---|
| 空（筛选无结果） | “没有符合条件的检查” + [清除筛选] |
| 加载 | 10 行骨架 |
| 检测中 | 排队的行显示“排队”，运行中的行显示计时，结果逐行替换 |
| 无凭证 | AWS 来源列显示“AWS→手动”；顶部提示“启用 iam 后这 14 项会自动执行” |
| 冲突 | 行内显示 `[!] 冲突`；抽屉顶部红条写明“你在 10/13 手动确认过，但自动检测发现……”，并要求重新处理 |
| 手动确认晚于自动 fail（当前无凭证） | 按 §4.3 以手动确认为准，行内加“冲突待复核”；凭证恢复后自动复核 |
| 已手动确认 | 抽屉显示确认人、时间、填写的值、备注、证据校验结果，提供 [撤销]（需要填写原因） |
| 指南错误 | 来自出错指南的检查整行灰显，标注“指南不可用” |

**交互**
- 筛选写入 URL。
- **没有任何批量确认入口**；批量操作只有“检测所选”。
- “复制诊断包”会复制：检查定义、脱敏证据、指南版本、capabilities 片段、实例信息，便于向他人求助。
- 撤销手动确认会写入 `console_events`。

---

### S11 费用与清理 `/console/cost`（含 S11b 清理向导 `/console/cost/cleanup/:scope`）

**目的**

告诉学员现在有哪些资源在按小时计费、运行了多久、后续 Lab 还需不需要，以及怎样清理。清理只改变运行状态，不清除学习进度。

**线框**

```text
 费用与清理        数据来源 [估算 ●] [AWS 核实 ●] [Cost Explorer ○ 查询（按次计费，需要可选的账号级读取）]   10:44 [刷新]
 价格来源 /etc/cloudalbum/cost-rates.yaml（cost 模块；你从官方定价页抄录）· 更新于 2026-10-01
 ┌ 现在 ────────────────┐ ┌ 本月（估算）──────────────┐ ┌ 预算（cost 模块 · AWS Budgets）────┐
 │ ≈ $0.080 / 小时        │ │ ≈ $14.80 / $30（49%）      │ │ 已配置 [M] · 阈值 50/80/100%       │
 │ 若一直运行 ≈ $58 / 月   │ │ 来源：估算 + 启停记录        │ │ 本月实际：需要 Cost Explorer 查询   │
 └──────────────────────┘ └───────────────────────────┘ └───────────────────────────────────┘
 按小时计费中
 资源                       模块         已运行    单价(≈)    后续需要                      闲置     操作
 EC2 t4g.small i-0abc        ec2（必需）   12d 4h   $0.022/h   一直需要                      —        —
 公网 IPv4（EIP）             ec2（必需）   12d 4h   $0.005/h   一直需要                      —        —
 RDS db.t4g.micro           database     5d 2h    $0.025/h   快速路线 Lab 8 之后仍在用       —        [清理] 重建约 15 分钟
 ElastiCache t4g.micro      cache        3d 21h   $0.024/h   autoscaling（Lab 21）的软依赖   9h       [清理（建议）]
 固定月费   WAF Web ACL + 规则 · Secrets Manager（未启用）· KMS（未启用）
 按量       S3 1.2 GB · CloudFront 请求与流出 · Lambda（未启用）
 未纳管资源（带 Project=CloudAlbum 标签，但不属于任何模块栈）
   CloudFront 分配 E2QW…ZL（ManagedBy=manual，已被 cdn 接管）     disable cdn 不会删除它   [控制台 ↗]
   安全组 sg-0aa… “practice-sg”（ManagedBy=manual，未被任何模块接管） 需要手动删除           [控制台 ↗]
 清理  [ 清理一个模块 ] [ 清理闲置资源 ] [ 回到 L0（保留 EC2 和学习进度）] [ 彻底拆除（先导出学习报告）]
```

- **价格只来自 `cost-rates.yaml`**（§1.3 原则 9、§5.1）。文件不存在时，“现在”“本月”两块只显示计费中的资源与已运行时长，单价列显示“—（cost-rates.yaml 未配置）”，并提供“生成 cost-rates.yaml 模板”的命令（只列计费维度，单价留空，学员自己从官方定价页抄录）。
- Cost Explorer 查询需要可选的账号级读取（§6.7）；没有开启时按钮旁说明“在 设置 › 检测能力 中开启账号级读取”。

**S11b 清理向导（`scope=l0`，即“回到 L0”）**

```text
 清理向导 · 回到 L0                         命令：scripts/module profile apply l0-ec2（总纲 §10）
 影响  学习进度全部保留，10 个模块变为 [z]。照片和数据库会迁回 EC2（disable 的数据迁回步骤，期间有只读窗口）
 进度保护 [v] 已导出学习报告 report-20261013.md      [ 立即导出 ]
 计划（按依赖倒序自动生成，与 profile apply 的执行顺序一致）
  1 cache      scripts/module disable cache          删除类命令  [复制]  验证 [~] 集群删除中 3:10
  2 database   scripts/module disable database       删除类命令  [复制]  验证 [ ]
               数据：迁回 SQLite（只读窗口约 1–3 分钟）。RDS 实例因 Retain 保留 → 选择：
               (•) 保留（停止后仍按存储计费，可在费用页再删）   ( ) --purge（verify 通过后删除，删除前自动创建最终快照）
  3 waf / cdn / storage / …  （按依赖倒序继续）
  …
  手动收尾  [ ] CloudFront 分配 E2QW…ZL（路线 M 接管的资源）先禁用再删除   [控制台 ↗]
  结课后（可选）scripts/module enable iam --param LabVerifier=off   删除类命令：删除检测器只读角色与策略
 [ 复制全部命令（已按顺序排好）]（含删除类命令：第一次点击变为“确认复制”，再点一次才写入剪贴板）  [ 运行清理验证 ]
 完成后  费用灯 → 绿 · 档位 → l0-ec2 · Lab 4、5、7、15、16 … → [z]
```

- 删除类命令（`dangerous: true`）每条都有红色左边框和“删除类命令”文字标签；复制时在命令块内展开确认条，写明 `dangerNote`（例如“将删除 CloudFront 分配，已发出的 CDN 链接会失效”），确认后才写入剪贴板。不使用浏览器的 `confirm()`。
- 清理验证引用的资源 ID 取自启用时固化的快照（§5.4），界面注明“取自 10/05 10:31 启用时的记录”。

**组件**：`CostSourceChips`、`CostTiles`、`HourlyResourceTable`、`UnmanagedList`、`CleanupEntry`、`CleanupPlan`、`DataRiskNote`、`ChoiceGroup`、`CheckResultRow`、`CommandBlock(dangerous)`。

**数据来源**：
- `GET /api/console/cost`：合并以下来源：
  - 注册表的 `hourlyBilled`
  - 指南的 `startsBilling`（`rateKeys`）
  - `cost-rates.yaml`（经 cost 模块读取；不存在时不出金额）
  - `module_events` 启停时长
  - AWS 只读核实结果：`tag:GetResources`（`Project=CloudAlbum`）、`rds:DescribeDBInstances`、`elasticache:DescribeReplicationGroups`、`elasticloadbalancing:DescribeLoadBalancers`、`ec2:DescribeNatGateways`、`ec2:DescribeAddresses`、`ec2:DescribeInstances`、`cloudformation:ListStackResources`
- `POST /api/console/cost/actuals`（Cost Explorer，按次计费，需要确认）
- `GET /api/console/cleanup/plan?scope=`
- `POST /api/console/cleanup/verify`

**状态**

| 状态 | 表现 |
|---|---|
| 只有 L0 | “当前只有基础费用。不练习时可以停止实例（停止后 EBS 和公网 IPv4 仍然计费），或者整体拆除” |
| 有闲置资源 | 对应行高亮，标“建议清理”，并同步到总览的主推荐 |
| 超预算预测 | 本月估算超过预算的 80% 时，显示红色横幅 |
| 没有 cost-rates.yaml | 不显示金额；费用灯显示“计费中 n 项”；提供生成模板的命令 |
| 无凭证 | 数据来源只亮“估算”，提示“根据 modules.d 推断，可能遗漏你手动创建的资源”，并列出核对位置：Billing › 账单、Resource Groups › Tag Editor（搜索 `Project=CloudAlbum`）、各服务列表页 |
| 价格过期 | `cost-rates.yaml` 的 `asOf` 超过 180 天时，提示学员重新核对官方定价 |
| AWS 调用失败 | 回退到估算，并显示失败原因，例如“缺少 tag:GetResources” |
| 清理：计划为空 | “范围内没有运行中的资源” |
| 清理：验证中 | 等待型轮询（RDS 删除约 5–10 分钟；VPC 内 Lambda 的 ENI 释放可能超过 20 分钟） |
| 清理：验证失败 | 列出残留资源和常见原因：桶非空（含旧版本）、ENI 未释放、开启了删除保护、KMS 密钥处于待删除期 |
| 彻底拆除 | 必须先导出学习报告，才显示最后一步（`scripts/teardown`）；说明“EC2 删除后本控制台将无法访问，后续验证请在运维机执行 `aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=CloudAlbum`” |

---

### S12 学习报告 `/console/report`

**目的**

生成一份可导出、可打印的成果总结，用于复习、作品集，或交给讲师。

**线框**

```text
 学习报告                    [ 导出 Markdown ] [ 导出 JSON ] [ 打印 / PDF ]   [x] 账号 ID 打码  [x] 包含笔记
 ┌ 摘要 ────────────────────────────────────────────────────────────────────────────────────┐
 │ CloudAlbum · SAA-C03 实战   2026-10-01 → 2026-10-13（13 天）· 当前档位 l2-edge +2 · 重点对比快速路线 │
 │ 配置完成 7/10（全自动 6 · 含手动 1）· 全课程 11/32 · Lab 9/24 · 对比实验 7 对有效                   │
 │ 考点 安全 90 弹性 75 性能 84 成本 70 · 估算花费 ≈$14.80（按启停记录与 cost-rates.yaml）              │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
 架构快照   [ L0 · 10/01 ]                       [ 现在 · 10/13 ]
            （ArchMap 静态 SVG，本地芯片 39 个）   （ArchMap 静态 SVG，已点亮 15 个，芯片 24 个）
 模块成果
  模块        完成        路线      检查（证据构成）          对比结论（关键指标）
  storage     10/04 [v]   手动+接管 □AWS 8 · ◇本地 2           EC2 网卡入站字节 ▼ 98%；数据卷不再增长
  cdn         10/05 [v]   脚本      □AWS 6 · ◇本地 9 · △实验 2   命中时 TTFB 182 → 38ms；源站请求 ▼ 80%
  database    10/08 [v]   手动+接管 □AWS 9 · ◇本地 3 · △实验 2   单查询略慢；SQLITE_BUSY 37 → 0；故障转移 23 秒
  cache       10/10 [v]   脚本      □AWS 4 · ◇本地 3 · △实验 2   /api/feed p95 120 → 18ms（当前漂移中）
  …
 成长时间线  10/01 l0-ec2 上线 · 10/02 iam + cost（检测：仅本地 → 自动）· 10/03 l1-ops · 10/04 storage ·
            10/05 cdn、waf（l2-edge）· 10/06 切换到重点对比快速路线 · 10/08 database · 10/10 cache · 10/11 auth 开始
 考点与错题  错题 4 道（已复习 2）· 易混概念 11 组 · Lab 15 小测最好 5/6
 我的笔记    …
 附录：证据清单（每个模块的检查 ID、指南版本、最后通过时间、来源）
```

**组件**：`ReportSummary`、`ArchMap(mode=static)`（两张）、`ModuleOutcomeTable`（证据构成用来源形状标签，不用字母代码）、`Timeline(mode=milestones)`、`QuizSummary`、`NotesBlock`、`EvidenceAppendix`。打印时使用 `@media print` 样式：隐藏导航，A4 纵向，表格不跨页断行。

Artifact 版原型**不提供“打印 / PDF”按钮**（Artifact 约束），只提供“导出 Markdown / JSON”后由学员复制；正式产品按本节与 §13.7 实现打印（§3.2.1）。

**数据来源**：`GET /api/console/report?format=json|md`、`GET /api/console/timeline?milestones=1`、`GET /api/console/map/snapshot?at=`（按事件重放出某一时刻的运行状态，用于“L0 时”的快照）。

**状态**

| 状态 | 表现 |
|---|---|
| 进度很少 | 照常生成，标注“进行中”，未完成的部分不显示空表 |
| 没有实验 | 对比结论列显示“还没有记录”，并链接到 S08a |
| 账号 ID 不打码 | 需要二次确认：“导出文件会包含你的 AWS 账号 ID” |
| 生成中 | 进度条；超过 10 秒提示“正在汇总证据” |
| 彻底拆除前 | 由 S11b 强制引导到这里导出 |
| 检测器权限已收回 | 摘要中注明“结课后已删除检测器只读角色（10/20）” |

---

### S13 设置与检测能力 `/console/settings/:tab`

**目的**

让学员清楚系统现在能自动检测什么、不能检测什么、怎样解锁；同时管理学习路线、指南、进度数据和账号。

**线框（detection 标签页）**

```text
 设置   <nav>[ 检测能力* ] [ 学习路线 ] [ 指南 ] [ 数据 ] [ 账号 ]</nav>
 凭证链   IMDSv2 [v] → 实例角色 CloudAlbumAppRole [v] → STS 身份 [v]
          → 扮演 cloudalbum-lab-lab-verifier-role（会话 console-verifier）[v]
          → Verifier 策略与仓库一致 [!]（文档哈希 3f2a… ≠ 9c41…）→ 权限 159/162
          调用身份 arn:aws:sts::1234••••9012:assumed-role/cloudalbum-lab-lab-verifier-role/console-verifier
          （ASIA…，55 分钟后轮换；CloudTrail 中可以按会话名审计检测器的每一次调用）
 缺少的权限（影响的检查）                       诊断时按 action 传入对应的 ResourceArns 模拟
   cognito-idp:DescribeUserPoolDomain    auth · 1 项必需检查       → 检测器出错，可改为手动核对
   autoscaling:DescribeInstanceRefreshes autoscaling · 1 项（未解锁，暂无影响）
   cloudfront:GetVpcOrigin               cdn · vpc-origin 分支（Lab 20）
 修复    运维机 ▸ scripts/module enable iam    （iam 栈按仓库重新生成 cloudalbum-lab-lab-verifier；
                                               版本写在 Sid（VerifierV3），Description 不变）            [复制]
         [ 查看所需策略 JSON / 与当前版本对比 ]                                          [ 重新探测 ]
 账号级读取（可选，默认关闭）
   [ ] 允许检测器做账号级读取：cloudtrail:LookupEvents（audit 的“谁改了安全组”）、ce:GetCostAndUsage（按次计费）
       控制台不修改 IAM。勾选后生成命令，在运维机上执行才会生效：
       scripts/module enable iam --param VerifierAccountReads=on                               [复制]
 手动确认 已确认 4 项（原生 3 · 附证据 1）· 降级待复核 0 项                    [ 立即用 AWS 只读复核 ]
 定时检测 [ ] 开启（①② 每 15 分钟、③ 每 6 小时；默认关闭以节省 API 调用；多实例时由数据库租约保证只有一台执行）
 实验上传令牌  范围：lab:runs、lab:results、X-Experiment-*、白名单路由上的旁路 · 7 天有效 · 库中只存哈希
          [ 签发新令牌 ] [ 撤销 ]   签发后只显示一次：ca_exp_…   运维机 ▸ npm run exp:login（粘贴该令牌）
```

**各标签页**

| 标签页 | 内容 | 关键交互 |
|---|---|---|
| 检测能力 | 见线框。“检测能力：仅本地”时凭证链停在实例角色，并显示解锁路径 | “重新探测”会清除诊断缓存；凭证从无到有时，自动触发 §4.8 的复核，并汇总成一条通知；账号级读取与实验上传令牌见线框 |
| 学习路线 | 路线（主线 / 重点对比快速路线）、自有域名、月预算与每日费用阈值、默认做法、考试日期、加入路线的选做模块 | 修改路线或“有无域名”时，实时预览受影响的模块和必做数（主线 32 ↔ 34；快速路线 10）；切换路线不清除任何进度 |
| 指南 | 每个模块的指南版本、检查数、校验结果（文件:行号:错误）；手写指南与“占位指南”分开列出；course.yaml（与总纲 §10.3 的比对结果）与 topology.yaml 的状态 | “重新加载指南”（重新读取磁盘上的文件） |
| 数据 | 进度存储位置：单实例 SQLite 时为 `/var/lib/cloudalbum/db/cloudalbum.sqlite`；database 为 RDS 时为 RDS 端点（`cloudalbum-lab-database.xxxx.ap-northeast-1.rds.amazonaws.com`，`console_*` 表），并注明“RDS 不可达时单实例模式使用 progress-snapshot.json 只读快照；ASG 模式不写本地快照”。快照时间、导出 / 导入进度（按 `first_passed_at` 合并，预览冲突；导入的变量值按指南 pattern 重新校验，不合法的丢弃）、按模块重置进度（只清除证据，不动 AWS，需要二次确认） | 重置时需要输入模块 id 确认；导入用的文件选择框获得键盘焦点时，它的标签显示可见的焦点环 |
| 账号 | 当前管理员与登录方式、应急登录链接的说明、主题、重放新手引导、**启用单键快捷键**（G、J、K、R、?；关闭后只保留 Ctrl+K 与 Esc） | 快捷键开关存 `localStorage` |

**数据来源**：
- `GET /api/console/diagnostics`
- `POST /api/console/diagnostics/reprobe`
- `GET /api/console/verifier/policy`（生成的 JSON 与当前版本的差异）
- `GET/PUT /api/console/profile`
- `GET /api/console/guides/_meta`
- `GET /api/console/progress/export`
- `POST /api/console/progress/import`
- `DELETE /api/console/modules/:id/progress`
- `POST /api/console/exp-tokens`、`DELETE /api/console/exp-tokens/:id`

**状态**：

| 状态 | 表现 |
|---|---|
| 没有角色（L0） | 凭证链停在“实例角色 [ ]”，给出解锁路径“Lab 1 · iam”，并显示受影响的检查数 |
| keys 模式 | 凭证链停在“iam：keys 模式”；提示“检测器不使用长期密钥（CRED-002 的教学点），credentials: required 的模块照常可用；AWS 只读检查改为手动确认”，建议切换到 role 模式 |
| 没有 Verifier 角色 | 凭证链停在“扮演 Verifier 角色 [x]”，提示执行 `scripts/module enable iam` |
| 策略落后 / 缺少权限 | 同线框 |
| AWS 不可达 / 时钟偏差 | 见 §6.8 |
| IMDS 不可达 | 在开发机本地运行时，“本地检查”降级并说明原因 |
| 导入冲突 | 列出差异，由学员选择保留哪一份 |
| 实验上传令牌已签发 | 只显示一次明文；之后只显示前缀、签发时间、过期时间与“撤销” |

---
## 8. 组件清单

约定：
- 组件放在 `frontend/src/console/components/`，统一使用 §11 的 token。
- 每个组件都要有 Storybook 用例，覆盖下表列出的全部变体和状态。
- 只有符合 §5.1 的模块数据才能进入组件（类型来自 `packages/contracts`）。

### 8.1 状态与指标

| 组件 | 用途 | 变体 | 状态 | 关键 props / 无障碍 |
|---|---|---|---|---|
| `StatusBadge` | 显示步骤、模块、Lab 的状态 | `size: sm\|md`；`kind: step\|module\|lab`；`tone`：取自 §4.4–4.6 的状态表。`kind=step` 使用步骤级文案（已达成 / 已达成（含手动）/ 已达成·已清理） | 静态；`checking`（叠加 12px 转圈）；带后缀（`·过期`、`·脚本`、`·选做`）；`superseded`（`[^] 被 Lab N 取代`） | `state`、`suffix[]`。必须同时有图标和文字；`sm` 尺寸只显示图标时，要加 `aria-label="已完成（含手动确认）"`；“待核对”（unavailable / manual_pending）使用问号形状 |
| `SourceTag` | 表示判定来源 | `local`（本地）、`client`（浏览器回传，参考）、`probe`（探针）、`aws`（AWS）、`exp`（实验）、`manual`（手动）、`aws→manual`（降级） | 默认；不可用（灰，划线） | 等宽字体的 2–4 字文字标签加形状：本地 ◇、探针 ○、AWS □、实验 △、手动 ⬚（虚线框），不只靠颜色区分。证据构成（`EvidenceMix`）用同一套形状加计数，例如 `□AWS 6 · ◇本地 1 · △实验 1`，不使用 `A6 L1 E1` 这类字母代码 |
| `ModuleTile` | 模块目录矩阵中的格子 | `density: compact\|comfortable`（紧凑约 108×58px，状态徽章、步骤条与 `n/m` 在同一行；标准多一行说明） | 学习状态底色；右上角运行圆点；`$` 计费标记；选中；不匹配筛选时淡化 | `<button aria-pressed>`，`aria-label` 包含学习状态、步骤数、运行状态与是否按小时计费 |
| `ProgressRing` | 显示模块的步骤完成度（矩阵格子、架构图外环） | `size: 20\|32\|48` | 分三段：自动（实线）、手动（斜纹）、进行中（浅色）；`cleaned`（金色 ◇ 轮廓）；`locked`（虚线空环） | `achieved`、`manual`、`total`；`role="img"`，`aria-label="2/7 步，其中 1 步手动确认"` |
| `SegmentedProgress` | 显示整体配置完成度 | `inline`（顶栏，96px）、`block`（总览） | 同上；分母变化时播放 200ms 过渡 | `auto`、`manual`、`inProgress`、`total`；顶栏中它是进度 disclosure 按钮的一部分，浮层内容见 §3.4.3 |
| `TierBadge` | 显示当前档位 | `compact`（顶栏）、`full`（S07 底栏，列出每档缺少的模块） | 档位名取自 `profiles/*.env`（当前为 `l0-ec2` … `l9-full`），加 `+N`；变体进度；与上次应用的档位不一致时加小点提示 | 算法见 §3.4.2；浮层是纯说明（`role="tooltip"`，键盘聚焦也能触发），不含链接 |
| `CredentialBadge` | 显示检测能力 | `full`、`partial`、`local`、`unreachable`、`clock` | 探测中（转圈） | 形状（●◐○✕）加短文字（自动 / 部分 / 仅本地 / 不可达 / 时钟），窄屏也保留短文字；完整 `aria-label`；点击跳转到 `/console/settings/detection` |
| `CostLight` | 费用提醒 | 绿 / 黄 / 红 | 估算（`≈`）；已核实（✓）；没有 cost-rates.yaml（只显示“计费中 n 项”） | 形状（●▲■）加文字和金额；颜色是辅助信息；窄屏保留金额或“计费中 n 项”，带 `aria-label` |
| `StatTile` | KPI 小卡 | `number`、`fraction`、`money` | 加载骨架；无数据显示“—” | 数字使用 `font-variant-numeric: tabular-nums` |

### 8.2 导航与推荐

| 组件 | 用途 | 变体 | 状态 |
|---|---|---|---|
| `ContinueButton` | 顶栏的“继续” | 继续步骤、运行 after、先修复、查看报告 | 加载（显示缓存文案）；隐藏（向导未完成） |
| `RecommendationCard` | 主推荐和备选 | `primary`（大卡，带理由、时长、计费信息）、`alt`（单行） | 可“稍后”（24 小时后恢复）；带费用护栏提示 |
| `YouAreHereCard` | 总览的当前位置 | 正常、先修复、结业 | 上次检测的结果摘要 |
| `CourseOutline` | 左栏课程大纲 | 展开、折叠（抽屉）；按当前路线排列 | 当前项高亮；有未通过项的 Lab 显示红点；采用 tree 模式（`role="tree"`/`treeitem`、roving tabindex，键盘模型见 §3.5） |
| `LabNode` / `LabEdge` | 学习路线图 | 节点：done、done_manual、in_progress、available、suggested_later、opt_lab（选做 Lab）、cleaned；不在当前路线的节点灰显；边：软前置（实线）、快速路线顺序（虚线） | 悬停边显示依赖理由；`$/h` 标记；节点 `role="button"`，方向键按几何位置移动 |
| `DependencyLock` | 依赖锁提示（模块或步骤未解锁时显示在顶部） | `module`（缺少硬依赖模块）、`runtime`（依赖已被清理）、`credentials`（`IAM_CREDENTIALS=none`，CRED-001；keys 模式不锁）、`precondition`（没有域名、发件身份未验证） | 显示缺少什么（带规则编号）、对应命令或跳转、重建需要多久以及是否按小时计费 |
| `CommandPalette` | Ctrl+K 搜索 | — | 结果分组：模块、步骤、Lab、检查、页面、命令；检查结果直接打开检查详情抽屉；命令结果直接复制 |
| `Banner` | 全局横幅 | `validation`、`cache-misconfig`、`drift`、`cost`、`degrade`、`insecure`、`guide-updated` | 可关闭（红色不可关闭）；超过 2 条时折叠；总览页最多 1 条且不重复页内的“先修复”；只在内容变化时重绘，`role="alert"` 只在首次出现时使用；窄屏纵向排列 |
| `Disclosure` | 顶栏的进度浮层、管理员菜单、原型画面索引 | — | 按钮带 `aria-expanded`/`aria-controls`，点击展开，Esc 或点击外部收起；不在悬停或聚焦时自动展开；内部是普通链接与按钮（不用 `role="menu"`） |

### 8.3 指南

| 组件 | 用途 | 变体 | 状态 | 说明 |
|---|---|---|---|---|
| `StepRail` | 指南左栏的步骤列表 | — | 每行显示 §4.4 的状态、达成时间、当前标记 `◀` | 键盘 ↑↓ 切换，Enter 打开 |
| `StepCard` | 中栏的步骤内容 | `type`：experiment、config、wire、code、manual、read | 折叠（已达成）、展开（当前）、只读（未解锁 / 预览） | 包含：为什么、`CostNotice`、`MethodTabs`、预期结果、`PitfallList`、`SaaTip` |
| `MethodTabs` | 切换做法 | 控制台、CLI、脚本、代码；只显示指南中声明了的做法 | 默认做法来自偏好；在“控制台优先”下，脚本 Tab 带提示 | 真正的 tablist：每个 tab 有稳定 id，内容区 `role="tabpanel"` + `aria-labelledby`；←→/Home/End 切换，重绘后焦点留在新选中的 tab 上 |
| `RunsOnTag` | 标注运行位置 | 运维机、EC2、浏览器、CloudShell | — | 图标 + 文字，例如“运行于：EC2（SSH 或 Session Manager）” |
| `CommandBlock` | 命令块（带复制按钮） | `single`、`multi`（heredoc）、`dangerous`（红色左边框 + “删除类命令”文字标签） | 正常；**含未解析变量**（占位符显示红色虚线框，复制按钮带 `(!)`，点击先提示并定位到变量面板）；**含密钥占位**（`‹secret›`，复制时给出读取命令）；**删除类命令**：第一次点“复制”在命令块内展开确认条（写明 `dangerNote`，[确认复制] [取消]，焦点移到“确认复制”），确认后才写入剪贴板，不使用 `confirm()`；已复制（按钮显示“已复制”1.5 秒）；剪贴板不可用时选中命令文本并提示按 Ctrl+C | 等宽字体 13px；命令区可横向滚动，不自动换行；头部（运行位置 + 复制按钮）在窄屏换行；复制的是代入变量并按 §5.6 做了 shell 转义的纯文本；`aria-live` 播报“已复制” |
| `ConsolePath` | 控制台面包屑和深链接 | `region: app\|us-east-1\|global` | global：不显示区域提示；us-east-1：提示必须切换区域并写明原因（`regionReason`）；app：显示应用区域（例如 ap-northeast-1） | 深链接在新标签页打开；没有声明 deepLink 时按模块与区域生成 |
| `ImpactNotice` | 步骤影响提示（`impact`） | `logout`、`restartApp`、`replacesInstance`、`readOnlyWindow` | 步骤卡顶部提示；`logout`/`replacesInstance` 时，复制命令前在命令块内展开“执行前确认”条 | 例如“执行后所有会话失效，你会被登出；应急登录命令：…” |
| `VariableStrip` / `VariableChip` | 变量面板 | 来源：IMDS、cap、env、输入、查询命令 | 已解析；未填（红）；校验失败（红字显示 pattern 提示）；需要凭证（灰，给出查询命令） | 输入框 `inputmode="text"`，失去焦点时校验 |
| `CostNotice` | 开始计费提示 | `hourly`（琥珀）、`fixed-monthly`、`usage` | 有 / 没有 cost-rates.yaml | “从这一步开始按小时计费：≈$0.025/h（cost-rates.yaml）。练完可以清理，进度保留。”没有价格时只写计费维度 |
| `PitfallItem` | 常见错误 | 命中（实心圆点，自动展开）、未命中（空心圆点） | — | 带动作按钮：跳到某步（或第 k 小步：自动切到控制台做法并高亮）、轮询、打开控制台、复制命令 |
| `SaaTip` | “为什么（SAA）”折叠块 | 显示领域标签：安全 / 弹性 / 性能 / 成本 | — | 可以链接到易混概念 |
| `MapDelta` | 本步完成后的架构变化小图 | — | 动画（减少动态效果时不播放） | 局部 ArchMap，最多 5 个节点 |

### 8.4 检测

| 组件 | 用途 | 变体 | 状态 |
|---|---|---|---|
| `CheckResultRow` | 检查结果行 | `compact`（指南右栏）、`table`（检测报告）、`wizard`（向导体检） | 包括 not_run、queued、running（转圈 + 计时）、pass、fail、pending（`WaitTimer`）、error（扳手）、unavailable（`[?]` + “去核对”）、manual_pending、manual、manual_evidence、stale（`·过期`）、conflict（`[!]`）、superseded（`[^]`）、noCred（之前通过、当前无凭证未复核）。每行显示：图标、标题、`SourceTag`、期望 / 实际摘要、时间、操作 |
| `WaitTimer` | 等待型检查的计时 | — | 已等待 mm:ss、通常需要 N 分钟、下次检测倒计时；超过 `maxMinutes` 转为失败 |
| `CheckDrawer` | 检查详情抽屉 | 右侧滑出，宽 560px；窄屏时全屏 | 加载、无历史、通过、未通过、等待中、出错、降级、已确认、冲突；“复现命令”只显示检查声明的 `reproduce`，没有时隐藏该区块 |
| `ExpectedActualTable` | 期望值与实际值逐字段对照 | — | 每个字段一个对错标记；超长值折叠 |
| `EvidenceViewer` | 显示脱敏后的证据 JSON | — | 折叠；超过 64 KB 时截断并提示 |
| `ResultHistory` | 最近 10 次结果的时间线 | — | 漂移点标为 `[!]` |
| `ManualConfirmDialog` | 手动确认对话框 | `native`、`degraded` | 未满足（提交按钮禁用）；选了非期望值（显示 fixHint）；证据校验通过、未通过或无法解析；提交中；失败后可重试（保留已填内容） |
| `EvidencePaste` | 粘贴 CLI 输出 | — | 最多 256 KB；只解析 JSON；校验结果逐条断言显示 |

### 8.5 对比

| 组件 | 用途 | 变体 | 状态 |
|---|---|---|---|
| `CompareTable` | 各档指标对照 | 按 `compare.stages` 生成列：2 列（默认）、3–4 列（cache 四档、queue 三档、image-processing 四档）；cdn 的 after 按目标拆成两列 | 某列缺数据（占位）；某列校验中；某列无效（列头标红）；浏览器运行器的列标“参考” |
| `DeltaCell` | 显示差值 | `better: lower\|higher\|neutral` | 显示 ▼/▲、百分比，以及文字“更快 / 更慢 / 持平 / 差异小于噪声”；**颜色不表示好坏**，统一用 `--text-2`，只有箭头和文字区分方向 |
| `DistributionChart` | 延迟直方图叠加 | 线性轴、对数轴 | before 用 `--viz-before`，after 用 `--viz-after`；悬停显示分桶数值；提供表格替代视图 |
| `ServerTimingBar` | Server-Timing 瀑布图 | `single`、`paired`（before/after 上下对齐） | 段名使用模块 id；`cdn-*` 段用浅色；超过 12 段合并为 other |
| `PathSignature` | 路径签名芯片串 | `chips`、`text` | 芯片：本地驱动（灰）、AWS 驱动（实色描边）、命中（`hit`，加粗）、错误（红）、旁路（紫，虚线） |
| `ValidityChecklist` | 实验有效性清单 | — | 每项显示 [v]/[x] 和原因 |
| `ConclusionCard` | 自动结论 + 学员笔记 | — | 编辑中；已保存 |
| `LiveAbPanel` | 实时 A/B 面板 | `bypass-header`、`dual-url` | 运行中（显示进度 n/N）；不支持时显示原因 |
| `PhenomenonCard` | 定性模块的“现象对比卡” | — | 左右两列，各包含一组观察检查的结果 |

### 8.6 架构图

| 组件 | 用途 | 变体 | 状态 |
|---|---|---|---|
| `ArchMap` | 渲染整张架构图 | `full`、`mini`（总览）、`assemble`（向导）、`static`（报告）、`delta`（指南） | 加载骨架；过期斜纹；简洁模式或完整蓝图 |
| `ArchNode` | 服务节点 | `hop`（跳点）、`data`、`async`、`plane`（观测平面） | 运行 ok/degraded/error/off（幽灵节点）；被推荐（脉冲光环）；未解锁（锁）；已清理（金色 ◇）；漂移（`!`）；计费中（`$`）；选中、高亮、变暗 |
| `ArchBox` | 账号、VPC、EC2、AZ 框 | — | 默认 VPC 与 CloudAlbum VPC 两种标题 |
| `ArchBadge` | 附件型模块徽章 | waf、tls、kms、iam、backup、identity-pool | 点击区域至少 24×24px |
| `LocalChip` | EC2 内的本地芯片 | — | 存在于 EC2 内；迁出动画；已迁出（隐藏）；有状态芯片（加粗边框，ASG 提示） |
| `ArchEdge` | 连线 | `observed`（实线，宽度表示请求量）、`inferred`（点线）、`idle`（虚线）、`error`（红）、`bypass`（紫） | 悬停显示标签；选中后显示详情 |
| `NodeDrawer` | 节点抽屉 | — | 同 S07 |

### 8.7 通用

| 组件 | 说明 |
|---|---|
| `DataTable` | 表头固定；列可排序；筛选写入 URL；窄屏时表格放在横向滚动容器中（页面本身不横向滚动）；支持行选择（只有批量“检测”，**没有**批量“确认”）；可点击的行同时可用键盘聚焦并按 Enter 打开 |
| `FilterBar` | 筛选控件；“清除筛选”按钮 |
| `Drawer` / `Dialog` | 用 URL 查询参数控制开关（原型中存于内存，§3.2.1）；焦点被限制在内部；Esc 关闭；关闭后焦点回到触发元素；确认步骤一律做成页面内 UI，不使用 `alert`/`confirm`/`prompt` |
| `EmptyState` | 统一格式：为什么是空的 + 下一步做什么（一个主按钮）；不用插画 |
| `Skeleton` | 骨架的形状与真实布局一致；不用闪光动画，用 1.2 秒的透明度呼吸 |
| `Toast` | 只用于非关键的确认（例如“已复制”）；重要的结果写在页面里，不用 Toast |
| `LiveRegion` | SSE 带来的结果变化通过 `aria-live="polite"` 播报，同一步骤 3 秒内合并为一条（例如“本步检测完成：3 项通过，1 项未通过”） |
| `Timeline` | `compact`（总览）、`milestones`（报告）、`full`（模块概览） |
| `CodeSnippet` | 只读代码片段，带行号和高亮行，支持复制 |

---

## 9. API 契约

### 9.1 约定

| 项 | 约定 |
|---|---|
| 基础路径 | `/api/console/*`。复用总纲中已有的 `/api/capabilities`、`/api/capabilities/stream`、`/api/lab/runs`、`/api/lab/results`、`/api/lab/metrics`、`/api/lab/requests/recent` |
| 鉴权 | 控制台专用会话 `ca_console`（HttpOnly，ES256 签名，TTL ≤ 1 小时，不可刷新，§3.8），由相册管理员会话或应急票据换取。例外（公开接口、探测令牌、实验上传令牌、实例间内部调用）见 §6.10 第 2 条 |
| CSRF | 非 GET 请求必须带 `X-CloudAlbum-CSRF` 头，值与 Cookie `ca_csrf` 一致；同时按 §3.8 的白名单校验 `Origin`（`APP_BASE_URL`、CloudFront 域名、EIP/publicDns、回环地址含端口、请求自身的 Host） |
| 缓存 | 所有响应带 `Cache-Control: no-store` |
| 时间 | ISO 8601 UTC，例如 `2026-10-13T02:44:03.120Z`；前端按浏览器时区显示 |
| ID | 运行、确认等记录的 ID 使用 ULID；**控制台事件的 ID 是数据库单调序列 `seq`**（SSE 补发游标，§6.11）；检查的全局 ID 为 `<module>.<stepId>.<checkId>` |
| 分页 | `?limit=&cursor=`，响应中返回 `nextCursor` |
| 错误 | `{"error":{"code":"VALIDATION","message":"…","detail":{…},"requestId":"01JA…"}}`。HTTP 状态：400 校验、401 未登录或会话过期、403 非管理员 / CSRF 不通过 / setup 来源不被接受、404、409 冲突、410 已初始化（setup 接口）、429 限速、503 只读窗口。检查结果中的错误码另见 §6.9 |
| 版本 | 响应头 `X-Console-Api: 1` |

### 9.2 端点一览

| 方法 | 路径 | 说明 | 画面 |
|---|---|---|---|
| GET | `/setup/status` | 验证前只返回 `{initialized, step}`（无需登录；不返回邮箱）；初始化完成后返回 410 | S00 |
| POST | `/setup/verify-token` | 验证 setup token（无需登录；只接受回环地址或 HTTPS 来源，除非实例上开启了 `--allow-remote`；按来源 IP 限速；成功后签发向导会话并记录 `wizard_session_hash` 与 `token_generation`）；初始化完成后返回 410 | S00 |
| POST | `/setup/admin` | 创建或接管管理员（需要向导会话）；成功后签发 `ca_console`、作废向导会话；初始化完成后返回 410 | S00 |
| POST | `/session` | 用相册管理员会话换取 `ca_console`（无需 `ca_console`；需要相册会话） | 全局、S01 |
| GET | `/session` | 当前登录者、登录方式、会话剩余时间 | 全局 |
| POST | `/session/ticket` | 兑换应急登录票据（票据在请求体中，来自前端读取的 URL 片段） | S01 |
| GET / PUT | `/profile` | 学习路线偏好（含路线 `track`） | S00、S13 |
| GET | `/state` | 页头数据：cursor、完成度、档位、检测能力、费用灯、横幅、回访摘要 | 全局、S02 |
| GET | `/next` | 推荐下一步 | S02、S03 |
| POST | `/next/:recoId/snooze` | 推荐“稍后” | S02 |
| GET | `/course` | 课程编排、学习路线与状态 | S03 |
| GET | `/labs/:labId` | Lab 概览 | S04 |
| GET | `/modules` | 全部模块（当前 40 个）的汇总 | S05 |
| GET | `/modules/:id` | 模块概览（注册表 + 指南元数据 + 进度 + 运行 + 费用 + 时间线） | S06-1 |
| GET | `/modules/:id/progress` | 步骤状态与检查的有效结果 | S06-2 |
| PUT | `/modules/:id/notes` | 学员笔记 | S06-4 |
| POST | `/modules/:id/drift-ack` | 标记“有意改动”（`{hours:24}`） | S10d |
| DELETE | `/modules/:id/progress` | 重置模块进度（`{confirm:"<id>"}`） | S13 |
| GET | `/guides/:id` | 解析后的指南（变量已代入、密钥已打码、包含路线） | S06-2 |
| PUT | `/guides/:id/variables` | 保存输入型变量和路线选择 | S06-2 |
| GET | `/guides/_meta` | 指南版本与校验结果 | S13 |
| POST | `/guides/_reload` | 重新读取磁盘上的指南 | S13 |
| POST / DELETE | `/steps/:module/:stepId/skip` | 跳过或撤销跳过选做步骤 | S06-2 |
| POST | `/steps/:module/:stepId/read` | 阅读步骤标记为已读 | S06-2 |
| POST | `/checks/run` | 发起检测 | 多处 |
| DELETE | `/checks/runs/:runId` | 取消检测 | 多处 |
| POST | `/checks/runs/:runId/browser-results` | 回传浏览器执行的检查结果（必须携带服务端下发的 `taskNonce`；记为 `LOCAL_CLIENT`） | 多处 |
| GET | `/checks` | 检测报告列表（支持筛选） | S10 |
| GET | `/checks/:checkId` | 检查详情与历史 | S10d |
| GET | `/checks/export` | 导出检测报告（`?format=json\|csv`） | S10 |
| POST | `/manual-confirmations` | 记录手动确认 | S10m |
| POST | `/manual-confirmations/evaluate` | 校验粘贴的证据（不落库） | S10m |
| DELETE | `/manual-confirmations/:id` | 撤销确认（`{reason}`） | S10d |
| GET | `/logs/tail` | 应用日志末尾，已脱敏（`?module=&n=20`，n 最大 50） | S10d、S06-1 |
| GET | `/experiments` | 实验记录（`?module=&lab=&filter=`） | S08、S08a |
| GET | `/experiments/:runId` | 单次实验详情 | S08 |
| POST | `/experiments/browser` | 浏览器运行器上报（结果只作参考） | S08 |
| POST | `/exp-tokens` | 签发实验上传令牌（明文只返回一次） | S13 |
| GET / DELETE | `/exp-tokens`、`/exp-tokens/:id` | 列出 / 撤销实验上传令牌 | S13 |
| PUT | `/experiments/:module/conclusion` | 结论笔记 | S08 |
| GET | `/topology` | 架构图布局 | S07 |
| GET | `/map/state` | 架构图状态（`?lens=&mini=1`） | S07、S02 |
| GET | `/map/snapshot` | 某一时刻的运行状态快照（`?at=`） | S12 |
| POST | `/traffic/probe` | 多入口探测 | S09、S07 |
| GET | `/cost`、`/cost/summary`、`/cost/catalog` | 费用 | S11、S02、S03 |
| POST | `/cost/actuals` | 调用 Cost Explorer（`{confirm:true}`） | S11 |
| GET | `/cleanup/plan` | 清理计划（`?scope=`） | S11b、S06-5 |
| POST | `/cleanup/verify` | 运行清理验证 | S11b、S06-5 |
| GET | `/quiz/:labId`、`/quiz/:labId/summary` | 小测题目与成绩汇总 | S04 |
| POST | `/quiz/:labId/attempts` | 提交答题 | S04 |
| GET | `/report` | 学习报告（`?format=json\|md&mask=1`） | S12 |
| GET | `/timeline` | 事件时间线（`?limit=&milestones=1`） | S02、S12 |
| GET | `/diagnostics` | 检测能力诊断 | S13 |
| POST | `/diagnostics/reprobe` | 重新探测 | S13 |
| GET | `/verifier/policy` | 由指南汇总生成的策略，以及与线上版本的差异 | S13 |
| GET | `/progress/export` | 导出进度 | S13 |
| POST | `/progress/import` | 导入进度（`?dryRun=1` 时只预览冲突） | S13 |
| GET | `/ping` | 健康检查（无需登录，`no-store`） | cdn 检查 |
| GET | `/probe/now` | 探测端点：校验探测令牌后以“探测主体”身份返回 `{now, nonce}`，带 `Cache-Control: private, no-store`，经过 CdnPort 与路径头中间件（替代未定义的 `/api/lab/now`） | cdn 等模块的检查 |
| GET | `/probe/echo`、`/probe/media-url` | 探测端点（只接受探测令牌）：回显源站看到的 Host 与是否收到 Cookie/Authorization；返回改写后的媒体 URL | 检查引擎 |
| POST | `/internal/run-local` | 实例间内部调用，执行 `instanceScope: all` 的 local/capability 检查（只绑定 VPC 内网地址，HMAC 签名） | 检查引擎 |
| GET | `/events` | SSE 事件流 | 全局 |

### 9.3 请求与响应示例

**`GET /api/console/setup/status`**（无需登录）

```json
// 未验证 token 之前：只返回布尔值与步骤，不返回邮箱、指纹或任何账号信息
{ "initialized": false, "step": "verify-token",
  "connection": { "scheme": "http", "loopback": false, "remoteAllowed": false } }
// 已初始化：410 Gone
{ "error": { "code": "SETUP_DONE", "message": "已初始化，请登录" } }
```

**`POST /api/console/setup/verify-token`**

```json
// 请求
{ "token": "q7m3…（32 字节，base64url）" }
// 200：之后的向导请求都带向导会话 Cookie（服务端只存其哈希与当前 token_generation）
{ "ok": true, "next": "admin", "existingAdmin": { "email": "admin@example.com", "createdBy": "bootstrap" } }
// 401：没有剩余次数，也不会锁定
{ "error": { "code": "SETUP_TOKEN_INVALID", "message": "token 不正确" } }
// 403：HTTP 远程来源且未开启 --allow-remote
{ "error": { "code": "SETUP_REMOTE_DISABLED", "message": "请经 SSH 隧道或 HTTPS 访问",
             "detail": { "howto": ["ssh -L 8080:localhost:80 …", "https://<EIP>", "setup:token --allow-remote"] } } }
// 429：按来源 IP 限速
{ "error": { "code": "RATE_LIMITED", "message": "请求过于频繁", "detail": { "retryAfterSec": 30 } } }
```

**`GET /api/console/state`**

```json
{
  "profile": { "track": "named", "hasDomain": false, "domain": null, "budgetUsdMonthly": 30, "method": "console", "examDate": "2026-12-20" },
  "cursor": {
    "labId": 8, "moduleId": "auth", "stepId": "hosted-ui", "stepIndex": 3, "stepCount": 9,
    "continue": { "kind": "step", "href": "/console/modules/auth/guide/hosted-ui",
                  "label": "继续：Lab 8 › auth › 步骤 3 配置托管登录域与 HTTPS 回调地址" }
  },
  "completion": {
    "track": "named", "required": 10, "done": 7, "doneAuto": 6, "doneManual": 1, "inProgress": 1,
    "course": { "required": 32, "done": 11 },
    "optional": { "total": 8, "done": 0 },
    "labs": { "done": 9, "total": 24 },
    "checks": { "autoPass": 116, "manual": 3, "toConfirm": 1 },
    "anomalies": 1
  },
  "tier": { "name": "l2-edge", "extra": 2, "extraModules": ["database", "cache"],
            "next": { "name": "l3-identity", "missing": ["auth", "identity-pool", "email", "notification"] },
            "variants": [{ "name": "x-named-comparisons", "running": 6, "total": 9, "missing": ["auth", "queue", "image-processing"] }],
            "appliedProfile": null },
  "detection": { "mode": "partial", "reason": "POLICY_OUTDATED", "missingActions": 3 },
  "cost": { "light": "yellow", "hourlyUsd": 0.08, "priced": true, "verified": true, "monthEstimateUsd": 14.8 },
  "banners": [
    { "type": "drift", "severity": "warn", "moduleId": "cache", "checkId": "cache.network.sg-ingress",
      "text": "漂移：cache 的“缓存安全组允许 6379”曾于 10/10 通过，现在未通过", "action": { "label": "排错", "href": "/console/checks?check=cache.network.sg-ingress" },
      "alertedAt": "2026-10-13T01:31:00Z" }
  ],
  "returnSummary": { "awayHours": 35, "estimatedSpendUsd": 2.83, "guideUpdates": [{ "module": "cdn", "from": "3.2.1", "to": "4.1.0" }], "capabilityChanges": ["cache"] },
  "instance": { "id": "i-0abc123…", "az": "ap-northeast-1d", "type": "t4g.small", "deployMode": "single" },
  "guidesVersion": "9f3c1e2", "serverTime": "2026-10-13T02:44:05.002Z", "lastEventSeq": 18342
}
```

- `labId` 是 course.yaml 中的 Lab 编号（整数），不是 `lab-k` 形式的固定枚举；`tier.name` 取自档位文件名。
- `banners[].alertedAt` 记录该横幅第一次出现的时间：前端只在首次出现时使用 `role="alert"`。

**`GET /api/console/next`**

```json
{
  "track": "named",
  "primary": {
    "id": "rec-cont-auth-hosted-ui", "kind": "continue", "rule": 4,
    "labId": 8, "moduleId": "auth", "stepId": "hosted-ui",
    "href": "/console/modules/auth/guide/hosted-ui", "title": "继续 auth · 托管登录",
    "reason": "继续上次的进度", "estMinutes": 110, "billing": "usage"
  },
  "alternatives": [
    { "id": "rec-new-email", "kind": "new-module", "rule": 8, "labId": 9, "moduleId": "email", "stepId": "baseline",
      "href": "/console/modules/email/guide/baseline", "title": "开始 email", "reason": "依赖已满足；不会产生按小时费用", "estMinutes": 60, "billing": "usage" },
    { "id": "rec-new-queue", "kind": "new-module", "rule": 8, "labId": 10, "moduleId": "queue", "stepId": "baseline",
      "href": "/console/modules/queue/guide/baseline", "title": "开始 queue", "reason": "依赖已满足；重点对比模块", "estMinutes": 90, "billing": "usage" }
  ],
  "blocked": [
    { "moduleId": "network", "rule": "DEP-016", "reason": "database、cache 已部署在默认 VPC；迁入自定义 VPC 前要先清理它们" },
    { "moduleId": "db-proxy", "rule": "DEP-032", "reason": "rds-proxy 需要 secrets（secretsmanager）在运行" }
  ],
  "guards": []
}
```

**`GET /api/console/guides/cdn`**（节选；结构即 §5.3，下面只列出额外字段）

```json
{
  "id": "cdn", "version": "4.1.0", "handwritten": true,
  "registry": { "group": "A", "function": "内容分发与边缘缓存", "awsService": "Amazon CloudFront", "type": "param",
                "requires": [], "bypass": ["cdn"], "hourlyBilled": false, "compare": "runtime-ab",
                "doc": "docs/modules/01-edge-network-scaling.md#cdn" },
  "route": "manual-adopt",
  "activeVariants": ["origin-ec2", "media-s3"],
  "variables": {
    "publicDns": { "value": "ec2-54-12-34-56.ap-northeast-1.compute.amazonaws.com", "source": "imds", "resolved": true },
    "distributionId": { "value": "E2QWRUHAPOMQZL", "source": "env", "snapshot": { "value": "E2QWRUHAPOMQZL", "at": "2026-10-05T01:31:00Z" }, "resolved": true },
    "myCidr": { "value": null, "source": "input", "resolved": false, "pattern": "^(\\d{1,3}\\.){3}\\d{1,3}/32$",
                "hint": "运维机上执行 curl -s https://checkip.amazonaws.com，再加上 /32" }
  },
  "steps": [ { "id": "behaviors", "type": "config", "title": "为静态资源、媒体、API 分别设置缓存行为",
               "state": "done", "firstPassedAt": "2026-10-05T01:58:00Z",
               "methods": { "console": { "region": "global", "breadcrumb": ["CloudFront", "分配", "E2QWRUHAPOMQZL", "行为", "创建行为"], "…": "…" } },
               "checks": [ { "id": "cdn.behaviors.api-not-cached", "type": "http-header", "source": "local",
                             "result": "pass", "at": "2026-10-13T01:58:03Z", "summary": "Miss from cloudfront ×2" } ] } ]
}
```

**`POST /api/console/checks/run`**

```json
// 请求（scope 取值：check | step | module | lab | reverify-all | manual-only | baseline）
{ "scope": "step", "module": "auth", "stepId": "hosted-ui", "force": false }
// 202
{ "runId": "01JA3QK5W8B2C9D0E1F2G3H4J5", "queued": 3, "position": 0,
  "browserTasks": [],
  "events": "/api/console/events?run=01JA3QK5W8B2C9D0E1F2G3H4J5" }
// 429
{ "error": { "code": "RATE_LIMITED", "message": "检测太频繁，请 8 秒后再试", "detail": { "retryAfterSec": 8 } } }
```

`browserTasks[]` 不为空时，每个任务带 `taskNonce` 与过期时间；浏览器回传结果时必须原样带上。

**`GET /api/console/checks/cache.network.sg-ingress?history=10`**

```json
{
  "check": { "id": "cache.network.sg-ingress", "title": "缓存安全组允许来自应用安全组的 6379", "type": "aws-readonly", "source": "aws",
             "required": true, "module": "cache", "stepId": "network", "guideVersion": "1.4.0", "checkHash": "sha256:7a1…",
             "explain": "DescribeSecurityGroupRules：缓存安全组中存在 6379/tcp 入站规则，来源为 {{baseSgId}}",
             "reproduce": { "run": "aws ec2 describe-security-group-rules --filters Name=group-id,Values=sg-0c4c2e7d1f9a8b603 --query 'SecurityGroupRules[?FromPort==`6379`]' --region ap-northeast-1", "runsOn": "ops" } },
  "effective": { "result": "fail", "drifted": true, "at": "2026-10-13T01:31:00Z", "runId": "01JA3QK5…", "instanceId": "i-0abc123…", "durationMs": 820 },
  "assertions": [ { "label": "6379 入站规则（来源为应用安全组）", "path": "$.SecurityGroupRules", "op": "len_gte",
                    "expected": 1, "actual": 0, "ok": false } ],
  "evidence": { "projected": { "SecurityGroupRules": { "count": 0 } } },
  "lastPass": { "at": "2026-10-10T05:12:00Z", "assertions": [ { "label": "6379 入站规则（来源为应用安全组）", "actual": 1, "ok": true } ] },
  "pitfalls": [ { "id": "sg-rule-removed", "symptom": "缓存连不上，路径头显示 error-bypass", "cause": "有人删除了 6379 入站规则",
                  "fix": { "text": "重新添加规则", "gotoStep": "network", "gotoSub": 3 }, "score": 3 } ],
  "manual": null,
  "history": [ { "at": "2026-10-13T01:31:00Z", "result": "fail" }, { "at": "2026-10-10T05:12:00Z", "result": "pass" } ]
}
```

- `assertions[].actual` 只存标量或计数（§6.6）；`evidence` 是投影之后的结果，不含任何被丢弃的字段。

**`POST /api/console/manual-confirmations`**

```json
// 请求
{ "checkId": "ec2.baseline.ebs-encrypted",
  "observed": "both-encrypted",
  "input": null,
  "confirmList": [],
  "evidence": "[true, true]",
  "note": "两个卷都显示已加密，10/13 核对" }
// 201
{ "id": "01JA3R…", "kind": "degraded", "degradedReason": "NO_ROLE",
  "result": "manual_evidence", "evidenceVerdict": "pass", "evidenceHash": "sha256:c41…",
  "reviewState": "pending_review", "stepState": "done_manual", "conflictPending": false }
// 422：选了非期望值
{ "error": { "code": "OBSERVED_NOT_EXPECTED", "message": "当前观察值不满足要求",
             "detail": { "fixHint": "加密只能在创建卷时决定：快照 → 复制时加密 → 用快照建卷" } } }
```

**`POST /api/console/experiments/browser`**（浏览器运行器；结果只作参考。正式运行走 `POST /api/lab/runs` + `POST /api/lab/results`）

```json
{ "module": "cdn", "experiment": "ttfb", "stage": "after", "runner": "browser",
  "params": { "requests": 100, "paths": ["/assets/index-3f2a.js", "/media/…"] },
  "client": { "latencyMs": { "/assets/*": { "p50": 21, "p95": 64 } }, "cdnHitRatio": 0.96 } }
// 201：浏览器结果不参与完成判定
{ "runId": "01JA3S…", "reference": true, "valid": null, "note": "浏览器运行器的结果只作参考" }
```

**`POST /api/lab/results`**（运维机运行器，带实验上传令牌；节选）

```json
// 请求头：Authorization: Bearer ca_exp_…（实验上传令牌）
{ "runId": "01JA4C…", "module": "cdn", "experiment": "ttfb", "stage": "after",
  "clientEvidence": { "byTarget": {
      "direct": { "samples": 200, "segments": { "entry": { "nginx": 200 } } },
      "cdn":    { "samples": 200, "segments": { "entry": { "cloudfront>nginx": 198, "nginx": 2 } }, "xCache": { "Hit": 161, "Miss": 39 } } } },
  "metrics": { "…": "…" } }
// 202：先进入“校验中”，rollups 补齐后经 SSE exp.recorded 推送结果
{ "runId": "01JA4C…", "validation": "pending", "validateAfter": "2026-10-05T02:20:40Z" }
```

**`GET /api/console/cost`**（节选）

```json
{
  "source": { "estimate": true, "awsVerified": true, "costExplorer": null,
              "rates": { "file": "/etc/cloudalbum/cost-rates.yaml", "present": true, "asOf": "2026-10-01" },
              "refreshedAt": "2026-10-13T02:44:00Z" },
  "hourlyUsd": 0.08, "monthEstimateUsd": 14.8, "budget": { "usd": 30, "configured": true, "configuredBy": "cost" },
  "hourly": [
    { "resource": "db.t4g.micro", "arn": "arn:aws:rds:ap-northeast-1:…:db:cloudalbum-lab-database", "module": "database",
      "runningSince": "2026-10-08T01:30:00Z", "usdPerHour": 0.025, "idleHours": 0,
      "neededBy": [{ "labId": 21, "moduleId": "autoscaling", "kind": "runtime" }], "suggestCleanup": false, "rebuildMinutes": 15 },
    { "resource": "cache.t4g.micro", "module": "cache", "usdPerHour": 0.024, "idleHours": 9,
      "neededBy": [{ "labId": 21, "moduleId": "autoscaling", "kind": "soft" }], "suggestCleanup": true }
  ],
  "fixedMonthly": [{ "module": "waf", "item": "Web ACL ×1 + 规则", "usdPerMonth": null, "dimension": "waf.webacl-month" }],
  "unmanaged": [{ "type": "AWS::EC2::SecurityGroup", "id": "sg-0aa…", "tags": { "ManagedBy": "manual" }, "adoptedBy": null,
                  "consoleUrl": "https://ap-northeast-1.console.aws.amazon.com/ec2/home?region=ap-northeast-1#SecurityGroup:groupId=sg-0aa…" }]
}
```

`cost-rates.yaml` 不存在时，`rates.present=false`，所有 `usdPerHour`、`hourlyUsd`、`monthEstimateUsd` 为 `null`，只保留资源、维度与时长。

**`GET /api/console/cleanup/plan?scope=lab:16`**（节选）

```json
{
  "scope": "lab:16", "progressKept": true, "exportRecommended": false,
  "steps": [
    { "order": 1, "moduleId": "cache", "command": "scripts/module disable cache", "runsOn": "ops",
      "dangerous": true, "dangerNote": "将删除 ElastiCache 复制组，缓存数据丢失",
      "dataRisk": ["缓存数据丢失（可接受）"], "choices": [],
      "verify": [{ "checkId": "cache.cleanup.cap-off" }, { "checkId": "cache.cleanup.rg-gone", "vars": { "replicationGroupId": { "value": "cloudalbum-lab-cache", "source": "snapshot", "at": "2026-10-10T05:12:00Z" } } }] }
  ],
  "manual": [],
  "after": { "tier": "l2-edge", "costLight": "yellow" }
}
```

**`GET /api/console/diagnostics`**

```json
{ "mode": "partial", "checkedAt": "2026-10-13T02:40:00Z",
  "chain": { "imds": "ok", "iamMode": "role", "role": "CloudAlbumAppRole",
             "caller": "arn:aws:sts::1234…:assumed-role/CloudAlbumAppRole/i-0abc123…",
             "verifier": { "role": "cloudalbum-lab-lab-verifier-role", "session": "console-verifier", "assumed": true,
                           "credentialExpiresAt": "2026-10-13T03:35:00Z" },
             "verifierPolicy": { "name": "cloudalbum-lab-lab-verifier", "defaultVersionId": "v3", "sid": "VerifierV3",
                                 "docHash": "sha256:3f2a…", "repoDocHash": "sha256:9c41…", "upToDate": false },
             "accountReads": false, "clockSkewSec": 0.2, "network": "ok" },
  "simulated": { "total": 162, "allowed": 159 },
  "missingActions": [ { "action": "cognito-idp:DescribeUserPoolDomain", "checks": ["auth.hosted-ui.domain"], "modules": ["auth"] } ],
  "fix": { "runsOn": "ops", "command": "scripts/module enable iam" } }
```

### 9.4 SSE 事件格式

```text
GET /api/console/events            （可以带 ?run=<runId> 只接收某次检测的事件）
Content-Type: text/event-stream
X-Accel-Buffering: no

retry: 3000

id: 18343
event: check.result
data: {"v":1,"runId":"01JA3QK5…","checkId":"auth.hosted-ui.domain","module":"auth","stepId":"hosted-ui",
       "result":"error","code":"ACCESS_DENIED","source":"aws","summary":"检测器缺少 cognito-idp:DescribeUserPoolDomain","durationMs":410,"at":"2026-10-13T02:44:03Z"}

: ping
```

`id` 是 `console_events.seq`（数据库单调序列，§6.11），浏览器重连时带 `Last-Event-ID`，服务端从数据库补发。

| 事件 | data 字段 | 前端处理 |
|---|---|---|
| `run.queued` | `runId`、`position` | 显示“排队中” |
| `run.started` | `runId`、`scope`、`total`、`checkIds[]` | 对应检查行开始转圈 |
| `check.started` | `runId`、`checkId`、`instanceId` | — |
| `check.waiting` | `runId`、`checkId`、`waitedSec`、`nextPollSec`、`typicalMinutes`、`maxMinutes` | 刷新 `WaitTimer` |
| `check.result` | 见上例；另有 `pitfallIds[]`、`instanceId` | 更新行；通过 LiveRegion 合并播报 |
| `run.finished` | `runId`、`counts{pass,fail,pending,error,unavailable}`、`durationMs` | 结束转圈；本步全部通过时自动折叠，进入下一步 |
| `step.changed` | `module`、`stepId`、`from`、`to`、`firstPassedAt?` | 更新 `StepRail` |
| `module.changed` | `module`、`lifecycle{from,to}`、`flags[]` | 更新徽章、矩阵、大纲；完成时显示一次轻提示 |
| `lab.changed` | `labId`、`from`、`to` | 更新路线图 |
| `capability.changed` | `module`、`from{status,driver}`、`to{status,driver}`、`detail` | 更新运行状态；架构图播放芯片迁出或熄灭动画 |
| `module.event` | `module`、`type: enabled\|disabled\|pending`、`opId`、`actor`、`at` | 写入时间线；`pending` 时显示“状态变化中”；清理向导自动验证 |
| `exp.progress` | `runId`、`module`、`stage`、`done`、`total` | 刷新实验进度条 |
| `exp.recorded` | `runId`、`module`、`stage`、`validation: pending\|valid\|invalid`、`invalidReason?` | 刷新对比页；有效时更新模块状态 |
| `manual.reviewed` | `confirmationId`、`checkId`、`outcome: upgraded\|conflict\|access_denied` | 汇总成一条通知 |
| `detection.changed` | `mode`、`reason` | 刷新检测能力徽章；从 `local` 变为 `full`/`partial` 时提示“正在复核 n 项” |
| `cost.changed` | `hourlyUsd`、`light`、`reason?` | 刷新费用灯 |
| `traffic.agg` | `window`、`signatures[{sig,count,p50,p95,errors}]`（前 20 条，不含探测请求） | 刷新 S09 和架构图连线 |
| `recommendation.changed` | `primaryId` | 重新拉取 `/next` |
| `guide.reloaded` | `module`、`version`、`errors[]` | 提示刷新指南 |
| `session.expiring` | `expiresAt` | 会话剩余 5 分钟时提示；到期后静默换取 |
| `resync` | — | 重新拉取 `/state` 和当前页面的数据 |

---
## 10. 数据表 DDL

### 10.1 兼容性约定（SQLite 与 PostgreSQL 共用同一份 DDL）

| 项 | 约定 | 理由 |
|---|---|---|
| 主键 | 记录型表用应用生成的 ULID（`TEXT`，26 字符）；状态型表用自然键。**例外**：`console_events` 用数据库自增序列 `seq` 作主键（SSE 补发游标，§6.11），迁移文件按方言分别写 `INTEGER PRIMARY KEY AUTOINCREMENT`（SQLite）与 `BIGSERIAL PRIMARY KEY`（PostgreSQL） | ULID 按时间有序，但多个写入方之间有时钟偏差，不能当游标 |
| 时间 | `TEXT`，固定格式 ISO 8601 UTC（`YYYY-MM-DDTHH:MM:SS.sssZ`） | 两种库都能按字典序正确排序；不受 SQLite 日期函数的限制 |
| 布尔 | `SMALLINT`，并加 `CHECK (x IN (0,1))` | SQLite 没有布尔类型 |
| JSON | `TEXT`，由应用负责序列化和反序列化 | 保持 DDL 完全相同。PostgreSQL 如果需要 JSON 索引，可以在后续迁移中改为 `jsonb`（仓储层不受影响） |
| 浮点 | `DOUBLE PRECISION` | SQLite 按 REAL 亲和性处理 |
| 枚举 | `TEXT` + `CHECK (... IN (...))`。会随课程或指南变化的值（Lab 编号、实验档位、档位名）**不写 CHECK**，由应用按 course.yaml 与指南校验 | 两种库通用；避免课程调整时改 DDL |
| Upsert | `INSERT … ON CONFLICT (…) DO UPDATE` | SQLite ≥ 3.24 与 PostgreSQL 都支持 |
| 外键 | 声明 `REFERENCES`；SQLite 连接时执行 `PRAGMA foreign_keys=ON`（总纲 `db/knex.ts`） | — |
| 迁移 | Knex 迁移文件 `backend/src/db/migrations/20261013_01_console.ts`（v1.1 的变化在 `20261013_02_console_v11.ts`），内部用 `knex.raw()` 执行本节 DDL；`backend/test/dialect/` 中在两种库上各跑一遍 | 总纲 §11：“双方言可执行” |
| 随 database 模块迁移 | database 的 `up`/`down` 按外键顺序逐表复制（总纲 §9.3），`console_*` 等表一并迁移，不需要特殊处理；`console_events.seq` 迁移后把序列重置到最大值 + 1 | 学习进度跟着应用数据库走 |
| 只读兜底 | **只在单实例模式下**：每次写入进度后（节流到每 30 秒最多一次），把汇总状态写入 `/var/lib/cloudalbum/console/progress-snapshot.json`；数据库不可达时，S02、S05 用它只读渲染。`DEPLOY_MODE=asg` 时不写本地快照（各实例的快照会不一致），可选写到 S3 的 `console/snapshots/` 前缀 | §6.2 |
| 多实例 | `DEPLOY_MODE=asg` 时数据库必然是共享的 RDS（总纲 ASG-002），本节所有表都在共享库中；没有任何进度状态只存在实例内存或本地盘 | §6.2 |

与总纲中已有表的关系：
- `capability_events`：直接复用，用于运行状态的时间线，也用于判断实验运行期间驱动是否变化（§4.7）。
- `lab_metric_rollups`、`lab_host_samples`、`lab_origin_samples`：直接复用，用于请求路径和实验指标；带探测令牌的请求打上 `probe` 标记，不计入统计（§6.10）。
- `audit_log`：控制台中的敏感操作（setup、会话签发、确认、撤销、重置、应急登录、实验上传令牌的签发与撤销）**同时**写入它。
- 总纲 §8.2 的 `lab_results` 由本节的 `experiment_runs` 取代（附录 B-5）。

### 10.2 DDL

```sql
-- ── 设置与向导 ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS console_settings (
  key            TEXT PRIMARY KEY,                 -- 'profile'（含 track）| 'prefs' | 'schedule' | 'snooze:<recoId>' | 'cost.thresholds'
  value_json     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setup_state (
  id                    SMALLINT PRIMARY KEY CHECK (id = 1),
  step                  TEXT NOT NULL CHECK (step IN ('verify-token','admin','route','baseline','done')),
  token_generation      INTEGER NOT NULL DEFAULT 1,  -- 每次 setup:token 重新生成时加一；向导会话与 ca_console 都绑定它
  wizard_session_hash   TEXT,                        -- 当前向导会话 Cookie 的 sha256；生成新 token 或完成初始化时清空
  token_verified_at     TEXT,
  remote_allowed_until  TEXT,                        -- setup:token --allow-remote 打开的远程窗口（1 小时）
  admin_user_id         TEXT,                        -- users.id（相册 users 表，内部 UUID）
  admin_mode            TEXT CHECK (admin_mode IN ('created','claimed')),
  baseline_batch_id     TEXT,
  completed_at          TEXT,                        -- 有值后 setup/* 一律 410
  updated_at            TEXT NOT NULL
);
-- 不再有 failed_attempts / locked_until：失败只按来源 IP 限速（内存令牌桶 + Nginx limit_req），不做全局锁定（§6.10）

CREATE TABLE IF NOT EXISTS console_login_tickets (     -- 应急登录票据（cli.js console:login-link）
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,                 -- sha256，不保存明文
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);

CREATE TABLE IF NOT EXISTS console_exp_tokens (        -- 实验上传令牌（S13 签发，§6.10）
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,                 -- sha256，明文只在签发时返回一次
  prefix       TEXT NOT NULL,                        -- 'ca_exp_3k9…'，用于界面识别
  scope_json   TEXT NOT NULL,                        -- ["lab:runs","lab:results","x-experiment","bypass:whitelist"]
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

-- ── 进度（状态型）───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lab_progress (
  lab_id             INTEGER PRIMARY KEY,            -- course.yaml 中的 Lab 编号（当前 0–25），不写 CHECK
  state              TEXT NOT NULL CHECK (state IN ('suggested_later','available','in_progress','done','done_manual','cleaned','opt_lab')),
  started_at         TEXT,
  started_early      SMALLINT NOT NULL DEFAULT 0 CHECK (started_early IN (0,1)),   -- “仍要开始”
  completed_at       TEXT,
  cleaned_at         TEXT,
  quiz_best_score    DOUBLE PRECISION,               -- 0–1；小测不影响 state
  quiz_best_at       TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS module_progress (
  module_id            TEXT PRIMARY KEY,             -- 注册表 id
  lifecycle            TEXT NOT NULL CHECK (lifecycle IN ('locked','available','in_progress','verifying','done','done_manual','cleaned')),
  flags_json           TEXT NOT NULL DEFAULT '[]',   -- ["drifted","needs_confirmation","rebuild_needs","stale",…]，由求值器维护（便于列表查询）
  route                TEXT CHECK (route IN ('manual-adopt','script')),
  started_at           TEXT,
  completed_at         TEXT,                         -- 一旦写入，永不清空
  completion_quality   TEXT CHECK (completion_quality IN ('auto','manual')),
  guide_version_done   TEXT,                         -- 按哪个版本的指南完成
  cleaned_at           TEXT,
  drift_since          TEXT,
  drift_ack_until      TEXT,
  last_activity_at     TEXT,
  snapshot_json        TEXT,                         -- 完成时各必需检查的有效结果快照
  notes                TEXT,                         -- 学员笔记（S06-4）
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS step_progress (
  module_id            TEXT NOT NULL,                -- 没有模块的 Lab 用 'lab:<n>' 作为伪模块 id（当前课程没有）
  step_id              TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN ('locked','available','verifying','failed','error','needs_manual',
                                                     'done','done_manual','drifted','cleaned','skipped','read')),
  first_passed_at      TEXT,
  last_passed_at       TEXT,
  last_result_at       TEXT,
  source_mix_json      TEXT NOT NULL DEFAULT '{}',   -- {"local":2,"aws":1,"manual":1}
  stale                SMALLINT NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  by_script            SMALLINT NOT NULL DEFAULT 0 CHECK (by_script IN (0,1)),
  skipped_at           TEXT,
  read_at              TEXT,
  guide_version        TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (module_id, step_id)
);

CREATE TABLE IF NOT EXISTS guide_variables (
  module_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('input','snapshot')),
  value        TEXT NOT NULL,                        -- 非密钥；input 按 pattern 校验；snapshot 是 wire 达成 / enable 事件时 fillFrom 解析出的值
  op_id        TEXT,                                 -- snapshot 来自哪次启用（module_events.op_id）
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (module_id, name, source)
);

-- ── 检测（记录型：只追加，不更新；按 §10.3 的保留策略压缩）──────────────────────
CREATE TABLE IF NOT EXISTS check_batches (
  id             TEXT PRIMARY KEY,                   -- runId（ULID）
  scope          TEXT NOT NULL CHECK (scope IN ('check','step','module','lab','reverify-all','manual-only','baseline','poll','cleanup')),
  module_id      TEXT,
  step_id        TEXT,
  trigger        TEXT NOT NULL CHECK (trigger IN ('user','page-enter','module-event','capability','credentials','poll','schedule','setup','startup')),
  actor_user_id  TEXT,
  instance_id    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('queued','running','finished','cancelled','timeout')),
  counts_json    TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS check_runs (                -- 每项检查每次执行（每台实例）一行
  id               TEXT PRIMARY KEY,
  batch_id         TEXT NOT NULL REFERENCES check_batches(id),
  check_id         TEXT NOT NULL,                    -- <module>.<stepId>.<checkId>
  module_id        TEXT NOT NULL,
  step_id          TEXT NOT NULL,
  check_type       TEXT NOT NULL CHECK (check_type IN ('local','http-header','path-seen','session','capability','aws-readonly','experiment','manual')),
  source           TEXT NOT NULL CHECK (source IN ('local','client','probe','aws','exp','manual')),
  result           TEXT NOT NULL CHECK (result IN ('pass','fail','pending','error','unavailable','skipped')),
  skip_reason      TEXT CHECK (skip_reason IN ('when','superseded')),
  superseded_by_lab INTEGER,
  error_code       TEXT,                             -- 取值见 §6.9：TIMEOUT | THROTTLED | ACCESS_DENIED | UNREACHABLE | CLOCK_SKEW | NOT_FOUND_VAR | NOT_ALLOWED | ASSERT_TYPE | INTERNAL
  assertions_json  TEXT,                             -- [{label,path,op,expected,actual,ok}]；actual 只存标量或计数
  evidence_json    TEXT,                             -- 投影 + 脱敏后，最大 64 KB
  pitfall_ids_json TEXT,
  duration_ms      INTEGER,
  executed_by      TEXT NOT NULL DEFAULT 'server' CHECK (executed_by IN ('server','browser')),
  task_nonce       TEXT,                             -- 浏览器回传时绑定的任务 nonce
  instance_scope   TEXT NOT NULL DEFAULT 'serving' CHECK (instance_scope IN ('any','all','serving')),
  instance_id      TEXT,
  az               TEXT,
  guide_version    TEXT NOT NULL,
  check_hash       TEXT NOT NULL,                    -- 检查定义的哈希；变化后旧结果视为过期
  env_checksum     TEXT,                             -- 模块 env 文件的校验和（失效判断用）
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_check_runs_check_time  ON check_runs (check_id, created_at);
CREATE INDEX IF NOT EXISTS ix_check_runs_check_inst  ON check_runs (check_id, instance_id, created_at);
CREATE INDEX IF NOT EXISTS ix_check_runs_module_time ON check_runs (module_id, created_at);
CREATE INDEX IF NOT EXISTS ix_check_runs_batch       ON check_runs (batch_id);

CREATE TABLE IF NOT EXISTS check_polls (               -- 等待型检查的轮询计划（状态型；由持有 poll-scheduler 租约的实例执行）
  check_id       TEXT PRIMARY KEY,
  batch_id       TEXT NOT NULL,
  step_started_at TEXT NOT NULL,
  next_poll_at   TEXT NOT NULL,
  attempt        INTEGER NOT NULL DEFAULT 0,
  give_up_at     TEXT NOT NULL                       -- step_started_at + maxMinutes
);

CREATE TABLE IF NOT EXISTS manual_confirmations (
  id                TEXT PRIMARY KEY,
  check_id          TEXT NOT NULL,
  module_id         TEXT NOT NULL,
  step_id           TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('native','degraded')),
  degraded_reason   TEXT,                            -- NO_ROLE | KEYS_MODE | NO_VERIFIER_ROLE | ACCESS_DENIED | UNREACHABLE | CLOCK_SKEW
  observed_value    TEXT,
  input_value       TEXT,
  confirm_list_json TEXT,
  note              TEXT NOT NULL,
  evidence_hash     TEXT,                            -- 只保存粘贴内容的哈希
  evidence_verdict  TEXT NOT NULL DEFAULT 'none' CHECK (evidence_verdict IN ('none','pass','fail','unparsable')),
  confirmed_by      TEXT NOT NULL,                   -- users.id
  confirmed_at      TEXT NOT NULL,
  review_state      TEXT NOT NULL DEFAULT 'none' CHECK (review_state IN ('none','pending_review','upgraded','conflict','conflict_pending','access_denied')),
  reviewed_at       TEXT,
  review_run_id     TEXT,
  revoked_at        TEXT,
  revoked_reason    TEXT
);
CREATE INDEX IF NOT EXISTS ix_manual_check ON manual_confirmations (check_id, confirmed_at);

-- ── 对比实验（取代总纲 §8.2 的 lab_results）─────────────────────────────────────
CREATE TABLE IF NOT EXISTS experiment_runs (
  id                   TEXT PRIMARY KEY,             -- 运行器生成的 runId（ULID）；console 生成的现象记录由服务端生成
  module_id            TEXT NOT NULL,
  experiment_id        TEXT NOT NULL,                -- experiment.json 的 id
  stage                TEXT NOT NULL,                -- 'before' | 'memory' | 'worker-sqs' | 'after' | 'after-direct' …；按指南 compare.stages 校验，不写 CHECK
  runner               TEXT NOT NULL CHECK (runner IN ('cli','browser','console')),   -- console：定性模块的现象对比卡，由服务端检查生成
  status               TEXT NOT NULL CHECK (status IN ('registered','running','completed','failed')),
  simulated            SMALLINT NOT NULL DEFAULT 0 CHECK (simulated IN (0,1)),   -- 旁路补测的模拟基线
  reference_only       SMALLINT NOT NULL DEFAULT 0 CHECK (reference_only IN (0,1)),   -- 浏览器运行器：只作参考
  target               TEXT,
  params_json          TEXT NOT NULL DEFAULT '{}',   -- runner='console' 时取服务端生成的默认值
  params_hash          TEXT NOT NULL DEFAULT '',
  reported_env_json    TEXT,                         -- 运行器自报的 environment（只作显示，不用于判定）
  capabilities_snapshot_json TEXT NOT NULL DEFAULT '{}',   -- 服务端在 POST /api/lab/runs 登记时保存（判定驱动与 forced 用）
  client_evidence_json TEXT,                         -- 边缘模块的客户端证据（按目标分组的头部统计）
  metrics_json         TEXT,                         -- 结果 JSON 的 client/server/business 段
  sample_count         INTEGER,
  path_ratio_json      TEXT,                         -- {"direct":1.0,"cdn":0.99} 或 {"all":0.996}
  validation           TEXT NOT NULL DEFAULT 'pending' CHECK (validation IN ('pending','valid','invalid','reference')),
  validate_after       TEXT,                         -- rollups 补齐后才校验（§4.7）
  invalid_reason       TEXT,
  may_be_stale         SMALLINT NOT NULL DEFAULT 0 CHECK (may_be_stale IN (0,1)),
  conclusion_auto      TEXT,
  conclusion_note      TEXT,
  uploaded_by          TEXT,                         -- 实验上传令牌 id 或 users.id
  started_at           TEXT NOT NULL,
  finished_at          TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_exp_module ON experiment_runs (module_id, experiment_id, stage, finished_at);
CREATE INDEX IF NOT EXISTS ix_exp_validate ON experiment_runs (validation, validate_after);

-- ── 事件 ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS module_events (             -- 模块启停事件（来自 modules.state.json 的监视与比对，§4.13）
  id              TEXT PRIMARY KEY,
  module_id       TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('pending','enabled','disabled','driver_changed','repaired')),
  op_id           TEXT,                              -- 取自状态文件历史 / pending 记录；同一次操作的 pending 与完成事件共用
  actor           TEXT NOT NULL,                     -- 'scripts/module' | 'profile:<name>' | 'manual-edit' | 'unknown'
  source          TEXT NOT NULL CHECK (source IN ('state-watch','startup-diff','inferred')),
  discovery_batch TEXT,                              -- 推断事件（没有 op_id）的发现批次
  detail_json     TEXT,                              -- {driver, params, stack, operator, snapshotVars}
  occurred_at     TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  UNIQUE (op_id, type),                              -- 有 op_id 时按它去重（NULL 不参与唯一约束）
  UNIQUE (module_id, type, discovery_batch)          -- 推断事件按发现批次去重
);
CREATE INDEX IF NOT EXISTS ix_module_events_time ON module_events (occurred_at);

CREATE TABLE IF NOT EXISTS console_events (            -- 时间线 + SSE 补发与多实例扇出
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- PostgreSQL：BIGSERIAL PRIMARY KEY（迁移按方言生成）；SSE 的事件 id
  id             TEXT NOT NULL UNIQUE,               -- ULID，便于外部引用
  type           TEXT NOT NULL,                      -- 与 §9.4 的事件名一致
  module_id      TEXT,
  lab_id         INTEGER,
  ref_id         TEXT,                               -- runId / confirmationId / experiment runId / opId
  actor_user_id  TEXT,
  payload_json   TEXT NOT NULL,
  milestone      SMALLINT NOT NULL DEFAULT 0 CHECK (milestone IN (0,1)),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_console_events_time ON console_events (created_at);
CREATE INDEX IF NOT EXISTS ix_console_events_milestone ON console_events (milestone, created_at);

-- ── 多实例协调 ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS console_leases (            -- 租约与在线计数（§6.4、§6.5）；PostgreSQL 上租约优先用 advisory lock，本表用于在线计数与 SQLite
  name         TEXT PRIMARY KEY,                     -- 'poll-scheduler' | 'state-diff' | … | 'presence:<instanceId>'
  holder       TEXT NOT NULL,                        -- instanceId
  data_json    TEXT,                                 -- presence 行：{"subscribers":2}
  expires_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS console_probe_nonces (      -- 探测令牌的 nonce（共享，30 秒内允许幂等复用）
  nonce        TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- ── 小测与费用 ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id                  TEXT PRIMARY KEY,
  lab_id              INTEGER NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('graded','preview')),
  current_index       INTEGER NOT NULL DEFAULT 0,
  answers_json        TEXT NOT NULL DEFAULT '[]',     -- [{questionId, choice, correct}]
  score               DOUBLE PRECISION,
  domain_scores_json  TEXT,                           -- {"secure":0.9,"resilient":0.75,…}
  started_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE INDEX IF NOT EXISTS ix_quiz_lab ON quiz_attempts (lab_id, finished_at);

CREATE TABLE IF NOT EXISTS cost_snapshots (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL CHECK (source IN ('estimate','aws-verified','cost-explorer')),
  rates_as_of         TEXT,                           -- cost-rates.yaml 的 asOf；没有价格文件时为 NULL，金额字段也为 NULL
  hourly_usd          DOUBLE PRECISION,
  month_estimate_usd  DOUBLE PRECISION,
  resources_json      TEXT NOT NULL,
  taken_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cost_time ON cost_snapshots (taken_at);
```

### 10.3 保留与清理

`check_runs`、`check_batches`、`console_events` 是“只追加、不更新”的记录型表，但会按下面的保留策略**压缩**（删除旧行）；除此之外不做任何 UPDATE。压缩由 worker 中的定时任务 `console.compact` 每天执行一次，多实例时由 `compact` 租约保证只有一台执行（§6.4）。

| 表 | 保留策略 |
|---|---|
| `check_runs` | 每项检查（多实例时每项检查 × 每台实例）保留最近 50 条，加上“首次通过”和“最近一次通过”两条（漂移对比要用）；超过 90 天的其余记录删除 |
| `check_batches` | **在删除 `check_runs` 之后**再删除：只删已经没有任何 `check_runs` 引用的批次（外键约束要求先删子表） |
| `check_polls` | 检查不再 pending 或超过 `give_up_at` 时删除 |
| `console_events` | 保留 180 天；`milestone=1` 的事件永久保留（学习报告要用）。超出保留期的游标在 SSE 重连时触发 `resync` |
| `console_probe_nonces` | 过期 10 分钟后删除 |
| `console_leases` | 过期 1 天的行删除（presence 行随实例消失自然过期） |
| `console_exp_tokens` | 过期或撤销 30 天后删除（`audit_log` 中的记录保留） |
| `cost_snapshots` | 每天只保留 1 条，保留 1 年 |
| `experiment_runs`、`manual_confirmations`、`module_events`、各类 progress 表、`guide_variables` | 永久保留 |

---

## 11. 视觉规范

### 11.1 取向

**工程笔记本**：中性浅灰纸面（`#F6F6F4`，刻意避开“奶油底 + 衬线体 + 赤陶色”的组合），墨色文字，细线分隔，信息密度中等偏高，颜色只表达语义。只属于这个主题的细节：真实的 AWS 服务名、ARN 片段、区域代码 `ap-northeast-1`、可用区 ID `apne1-az4`、计费单位（`$/h`、按量、按月）、`X-CloudAlbum-Path` 路径签名、档位名 `l2-edge`。

| 要 | 不要（避免“AI 模板感”） |
|---|---|
| 左对齐、网格清楚、表格为主，卡片只用来分组（总览只有“你在这里”一张卡，其余区块用标题加细分隔线） | 居中的大标题 Hero、插画、“欢迎来到…”式空洞开场 |
| 1px 细线和底色区分层级，只有浮层带阴影 | 每张卡都是大圆角 + 投影 + 渐变 |
| 单一强调色（青瓷），只用于“你在这里 / 当前 / 推荐” | 紫蓝渐变、霓虹发光、玻璃拟态、默认的 Indigo 主色 |
| 图标配文字，状态用形状加文字 | emoji、星星闪光“✨ AI”图标、只靠颜色区分状态 |
| 真实数据与真实命令（示例值也像真的） | “Lorem ipsum”、“这是一段说明文字”、夸张的营销文案（“轻松”“一键搞定”“赋能”） |
| 数字用等宽表格数字，单位紧跟数字 | 大号空心数字和无单位的“98%” |
| 明确标出“非 AWS 官方控制台”，配色与 AWS 不同 | AWS 深海军蓝 `#232F3E` 加橙色 `#FF9900` 的组合 |

### 11.2 色彩 token

定义在 `frontend/src/console/styles/tokens.css`。控制台根节点 `.ca-console` 内使用，不影响相册本身的样式。

| token | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--bg` | `#F6F6F4` | `#141517` | 页面背景（中性浅灰 / 近黑） |
| `--surface` | `#FFFFFF` | `#1B1C1F` | 卡片、表格、抽屉 |
| `--surface-2` | `#EFEEE8` | `#232428` | 次级面板、代码块、表头 |
| `--border` | `#DAD8D0` | `#34363B` | 细线 |
| `--border-strong` | `#8A867B` | `#6E7179` | 输入框、chip、分段按钮的边界（对 `--surface` ≥ 3:1，WCAG 1.4.11） |
| `--text` | `#1C1D1F` | `#E9E7E2` | 正文 |
| `--text-2` | `#4A4D55` | `#B6B4AE` | 次要文字 |
| `--text-3` | `#63666E` | `#96948F` | 辅助说明（在 `--bg`、`--surface`、`--surface-2` 上对比度 ≥ 4.5:1；高亮行与 `--accent-soft`、`--st-*-soft` 底上的辅助文字改用 `--text-2`） |
| `--ink` | `#1C1D1F` | `#E9E7E2` | 主按钮底色（墨色） |
| `--on-ink` | `#FFFFFF` | `#141517` | 主按钮文字 |
| `--accent` | `#0F6E6E` | `#4FB3A9` | 青瓷：你在这里、当前步骤、推荐、焦点环 |
| `--accent-soft` | `#DDEFEC` | `#16302D` | 当前行背景 |
| `--code-bg` | `#EFEFEC` | `#1F2023` | 命令块（中性灰，不用米色） |
| `--danger-edge` | `#B3261E` | `#F0716A` | 危险命令左边框 |
| `--topbar-h` | 运行时写入 | 同左 | 顶栏实际高度（`ResizeObserver` 写入），吸顶元素的偏移都用它 |

### 11.3 状态语义色

每个状态都对应：主色、浅底、图标形状、文字。不能只用颜色区分。

| 语义 | 主色（亮 / 暗） | 浅底（亮 / 暗） | 图标形状 | 用于 |
|---|---|---|---|---|
| `--st-pass` | `#1B703F` / `#4CB97A` | `#E2F2E7` / `#163222` | 实心圆 + 勾 | done、pass、运行 ok |
| `--st-manual` | `#6A3EA1` / `#B08BE0` | `#EFE7F8` / `#2A2138` | 虚线方框 + M | done_manual、手动确认、进度条斜纹 |
| `--st-fail` | `#B3261E` / `#F0716A` | `#FBE5E3` / `#3A1C1A` | 方框 + 叉 | failed、fail、运行 error |
| `--st-drift` | `#A8380A` / `#F08A4B` | `#FCE9DD` / `#3A2214` | 三角 + ! | drifted、冲突（在自身浅底上 ≥ 4.5:1） |
| `--st-pending` | `#1F5FAD` / `#6FA3E6` | `#E3ECF8` / `#172A40` | 时钟 | verifying、pending、进行中 |
| `--st-error` | `#5A606B` / `#9AA0AA` | `#EAEBED` / `#26282C` | 扳手 | 检测器出错（不是学员的问题） |
| `--st-needs` | `#6A3EA1` / `#B08BE0` | 透明 + 虚线边 | 问号 | needs_manual、unavailable、manual_pending |
| `--st-stale` | `#8A6100` / `#D9A93A` | `#F7EED6` / `#33290F` | 半透明时钟 | 过期后缀、运行 degraded |
| `--st-locked` | `#8C9098` / `#6F737B` | `#EFEFEC` / `#202124` | 锁 | locked、未解锁、off（幽灵节点） |
| `--st-cleaned` | `#7A5E2E` / `#C9AE7A` | 斜纹 | 空心菱形 ◇ | cleaned（学过·已拆） |
| `--st-available` | `--text-2` | 无 | 空心圆 | available |
| 被取代 | `--text-2` | 无 | 上箭头 `^` | superseded（被后续 Lab 取代，不算漂移） |

**运行状态**（架构图、能力圆点）复用同一套颜色：
- `ok` 用 `--st-pass`；`degraded` 用 `--st-stale`；`error` 用 `--st-fail`；`off` 用 `--st-locked`，并画成虚线。
- 运行状态的圆点是实心小圆（6px），学习状态是图标加文字，两者在形状上就能区分。

### 11.4 数据可视化

| token | 亮 / 暗 | 用途 |
|---|---|---|
| `--viz-before` | `#8C8F96` / `#7D8088` | 对比实验的 before（本地实现） |
| `--viz-after` | `#0F6E6E` / `#4FB3A9` | 对比实验的 after（AWS 实现） |
| `--viz-third` | `#9A6B1F` / `#D1A45A` | 第三列（本地档，例如 memory、自建 Valkey） |
| `--viz-grid` | `#E4E2DA` / `#2C2E32` | 网格线 |

- before / after 用中性灰对青瓷，**不用红绿**，因为“启用后变慢”也可能是正确结论（例如 RDS 的单次查询延迟）。
- 差值方向用 ▲▼ 加文字表示。
- 直方图用细线叠加，不用两块大面积填色。
- 所有图表都提供“查看数据表”切换。

### 11.5 字体

```css
.ca-console {
  --font-sans: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Mono", "SFMono-Regular", Consolas, "Noto Sans Mono CJK SC", monospace;
}
```

- 不加载任何网络字体：L0 下控制台不应依赖外部 CDN，所有资源都随前端一起构建。
- 中文正文 14px / 行高 1.6；表格 13px / 1.5；辅助说明 12px；页面标题 20px / 600；区块标题 15px / 600。**不用超过 24px 的字号**。
- 数字一律 `font-variant-numeric: tabular-nums`。
- 模块 id、检查 ID、ARN、命令一律用等宽字体；过长的 ARN 用 `overflow-wrap: anywhere`。

### 11.6 间距、尺寸、圆角、阴影

| 类 | 值 |
|---|---|
| 间距刻度 | 4 · 8 · 12 · 16 · 24 · 32 · 48（px） |
| 内容边距 | 桌面 24px；≤768px 时 16px |
| 圆角 | 控件 4px；卡片和抽屉 6px；徽章 3px；架构图节点 6px；本地芯片 2px |
| 边框 | 1px `--border`；选中 / 当前用 2px `--accent` 左边条 |
| 阴影 | 只有抽屉、对话框、浮层使用：`0 8px 24px rgb(0 0 0 / .12)`（暗色 `.4`） |
| 行高 | 表格行 36px（紧凑 32px）；检查结果行 40px |
| 点击区域 | ≥ 32×32px（桌面），≥ 44×44px（触屏） |

### 11.7 图标

- 使用 `lucide-react`（MIT 许可，随前端一起打包），描边 1.5px，尺寸 16px 或 20px。
- 状态图标的形状映射见 §11.3。来源标签用几何形状：◇ 本地、○ 探针、□ AWS、△ 实验、⬚ 手动。
- 架构图节点**不使用 AWS 官方架构图标**：用文字服务名、类别字母 A–E 和细色条。这样既避免被误认为官方控制台，也方便在窄屏下退化成列表。
- 产品图标（标签页图标）：一个简单的方格“相册”图案，墨色加青瓷色。

### 11.8 动效

| 场景 | 动效 |
|---|---|
| 状态切换 | 150ms 颜色过渡 |
| 抽屉 | 200ms 从右侧滑入，`ease-out` |
| 检测结果逐项出现 | 无位移，只有 120ms 淡入 |
| 本地芯片迁出 + 节点点亮 | 400ms；同一时刻最多 1 组 |
| 推荐节点脉冲 | 2s 周期，透明度 0.4 → 0 |

- `prefers-reduced-motion: reduce` 时，关闭所有位移和脉冲动画，只保留颜色变化。
- 不用弹跳、抖动、彩带等“庆祝”动画。完成时只给一行文字反馈，例如“cdn 已完成（全自动）”。

### 11.9 主题切换的实现

```css
.ca-console { color-scheme: light; background: var(--bg); color: var(--text); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ca-console { color-scheme: dark; /* 覆盖为 §11.2–11.4 的暗色值 */ }
}
:root[data-theme="dark"] .ca-console { color-scheme: dark; /* 同上 */ }
```

主题偏好存在 `localStorage`（读写都包在 try/catch 里），默认跟随系统。

---

## 12. 与相册主应用的关系

### 12.1 一个应用，两种界面

| 方面 | 约定 |
|---|---|
| 构建 | 同一个 Vite 工程。控制台位于 `frontend/src/console/`，按路由懒加载（`React.lazy`）。普通用户的首屏包不包含控制台代码。L0 构建产物仍然不包含任何 AWS SDK（总纲 §12.1） |
| 路由 | 同一个 SPA；Nginx 的 `try_files … /index.html` 已经覆盖 `/console/*`，不需要新增 location |
| 会话 | 账号与 RBAC 共用相册的；控制台使用由相册管理员会话换取的专用会话 `ca_console`（§3.8），不另设账号体系 |
| 数据 | 共用应用数据库，控制台的表见第 10 章 |
| 样式 | 控制台的 token 只在 `.ca-console` 内生效；相册保持自己的视觉风格。两者共享的只有 `packages/contracts`（类型、路径头解析器、Server-Timing 解析器） |
| 实时 | 相册使用 `/api/capabilities`（每 60 秒轮询）；控制台额外订阅 `/api/console/events` |

### 12.2 从相册进入控制台的入口

| 位置 | 谁能看到 | 内容 |
|---|---|---|
| 页头用户菜单 | 管理员 | “学习控制台”，后面跟一个小状态点（颜色取自费用灯和漂移状态） |
| 页脚状态条（总纲 §12.3） | 管理员 | 在原有的“入口：… · 实例 …”之后追加 `档位 l2-edge +2 · 配置 7/10 · 继续 →`，点击“继续”直达当前步骤 |
| 页脚 | 所有访客，仅在**未初始化**时显示 | 一行小字“首次使用：初始化学习控制台 →”（链接到 `/console/setup`，需要 setup token，对访客无害） |
| 管理后台 `/admin` | 管理员 | 侧栏增加“学习控制台”链接 |
| 404 / 502 错误页 | 管理员 | “去学习控制台查看运行状态” |

### 12.3 能力徽章

- 徽章组件沿用总纲 §12.3 的 `ModuleBadge`，文案来自注册表 `lab.badges`，例如“图片由 CloudFront 提供 · HIT”。
- **管理员**：
  - 点击徽章跳到 `/console/modules/<id>`（原来是 `/lab/m/<id>`）。
  - 悬停浮层在原有的 `status · detail` 之外，追加一行学习状态，例如“学习：[>] 4/7 · 继续指南 →”。
  - 模块已漂移时，徽章右上角加一个 `!`。
- **普通用户**：徽章不可点击，只显示 title（取决于 `EXPOSE_PATH_HEADERS` 和用户设置中的“显示架构徽章”）。
- 徽章 → 控制台的对应关系：

| 相册中的位置 | 徽章 | 进入控制台 |
|---|---|---|
| 缩略图角标 | Nginx 直出 / CloudFront · HIT | `/console/modules/cdn` |
| 上传按钮 | 上传到 EC2 / 直传 S3 | `/console/modules/storage` |
| 登录页 | 本地账号 / Cognito | `/console/modules/auth` |
| 时间线标题 | 未缓存 / ElastiCache HIT | `/console/modules/cache` |
| 照片详情 · 缩略图 | EC2 生成 / Lambda 生成 · 冷启动 | `/console/modules/image-processing` |
| 评论区 | Express + DB / API Gateway + DynamoDB | `/console/modules/social-api` |

### 12.4 路径追踪抽屉

总纲 §7.4 的 `TraceDrawer` 仍然留在相册中，管理员默认可见。每行增加一个“在请求路径检查器中打开”的链接（跳到 `/console/traffic?sig=`）。

控制台的 S09 是它的全屏版，并增加了入口探测和签名聚合。

### 12.5 控制台对相册的副作用（必须为零或可清理）

- **探测对象**：引擎使用 `_probe/<instanceId>/…` 下的测试图片（总纲已有探针前缀），不出现在任何相册中，不计入用户数据。
- **实验数据**：实验产生的测试照片由运行器的 `cleanup` 清除（总纲 §8.2 中的 `DELETE /api/lab/runs/{runId}/photos`）。
- **旁路请求**：一律带 `Cache-Control: no-store`，并写入 `audit_log`（总纲 §8.3）。
- **探测流量**：带探测令牌的请求被标记为 `probe`，LabMetricsStore 把它排除在请求路径聚合、感知器窗口、`path-seen`、`nginx-log` 与源站卸载统计之外（§6.10），避免检测器“自己证明自己”。
- **实验流量**：按 runId 分组，S09 默认隐藏，勾选“包含实验流量”后才显示。

---

## 13. 可访问性与响应式

### 13.1 标准

- 目标：WCAG 2.2 AA。
- CI 中对每个画面的 Storybook 用例运行 axe，不允许有 serious 或 critical 级别的问题。

### 13.2 颜色与非颜色编码

- 所有状态都同时用**形状、文字、颜色**表达（§11.3）。在灰度截图中，所有状态仍然可以区分。
- 对比度：正文 ≥ 4.5:1；大字和图形边界（输入框、chip、分段按钮的边框，即 `--border-strong` 对 `--surface`）≥ 3:1。亮色和暗色两套 token 都要逐对验证，CI 中用脚本检查以下组合：`--text-3` 对 `--bg`/`--surface`/`--surface-2`；`--st-*` 对 `--surface` 与各自的 `-soft` 底；`--accent` 对 `--accent-soft`。当前行、警告行等高亮背景上的辅助文字一律用 `--text-2`。
- 窄屏也不能只靠颜色：顶栏的检测能力与费用灯在窄屏隐藏标签时，仍保留形状和短文字，并带 `aria-label`。
- 图表都提供数据表视图；架构图提供分层列表视图（S07 窄屏视图同时也是读屏视图）。

### 13.3 键盘

| 场景 | 要求 |
|---|---|
| 全局 | 页面顶部提供“跳到主要内容”链接；快捷键见 §3.7；`?` 显示快捷键帮助；**单键快捷键可以在 S13 › 账号中关闭**（WCAG 2.1.4，避免与读屏软件冲突），关闭后只保留 `Ctrl+K` 与 `Esc` |
| 焦点 | 可见焦点环：2px `--accent` + 2px 偏移（视觉隐藏的文件选择框获得焦点时，焦点环画在它的标签上）；抽屉和对话框把焦点限制在内部，关闭后焦点回到触发元素 |
| 重绘后的焦点 | 交互导致局部或整页重绘时，按“焦点键”（元素 id，或 `data-act` 加其余 data 属性，单选框再加 value）恢复焦点；单选组用方向键改变选择后，焦点落在新选中的那一项上。不允许焦点掉回 `body` |
| 表格 | 行可以聚焦；Enter 打开详情；排序按钮带 `aria-sort` |
| 标签 | 会改变 URL 的“导航式标签”（模块详情、设置）用 `<nav>` + 链接 + `aria-current="page"`，不用 `role="tab"`；不改变 URL 的真正 tablist（做法、对比实验视图、向导读取方式）有 `tabpanel`，←→/Home/End 切换后焦点留在新 tab 上 |
| 浮层 | 含链接的浮层（进度、管理员菜单）是 disclosure：按钮 `aria-expanded`，点击展开，Esc 收起并把焦点还给按钮；纯说明的浮层（档位）才用 `role="tooltip"` |
| 课程大纲 | tree 模式（§3.5）：↑↓ 移动，←→ 折叠 / 展开，Home/End，Enter 进入 |
| 指南 | `J`/`K` 切换步骤，`R` 运行检测；复制按钮可以聚焦；删除类命令的确认条出现后焦点移到“确认复制” |
| 学习路线、架构图 | roving tabindex（整张图只占一个 Tab 停靠点）；←→↑↓ 按屏幕几何位置移动到该方向最近的节点；Enter 打开侧栏 / 抽屉 |
| 小测 | `role="radiogroup"`，方向键选择；在选项上按 Enter 提交；提交后焦点移到“下一题” |

### 13.4 读屏

- **页面标题**：每个画面都有 `h1`（S00 的“首次启动向导”可以视觉隐藏，S01 的“管理员登录”、403 的“无权限”可见）；路由切换后焦点移到 `h1`。
- **语言**：控制台根节点或 `document.documentElement` 设置 `lang="zh-CN"`，保证中文按正确的语言朗读。
- **实时结果**：检测结果通过 `LiveRegion`（`aria-live="polite"`）播报，同一步骤在 3 秒内合并为一条。错误和漂移横幅使用 `role="alert"`，只在首次出现时播报；横幅区只在内容变化时重绘，路由切换不会让同一条横幅再次播报。
- **图形元素**：进度环和分段条带 `role="img"` 与完整的 `aria-label`；架构图 SVG 带 `<title>`/`<desc>`，节点为 `role="button"`，`aria-label` 写为“cdn，Amazon CloudFront，运行中降级，学习进行中 4/7”。
- **命令块**：用 `<pre><code>` 包裹，复制按钮的 `aria-label` 写为“复制命令：scripts/module enable cdn”。
- **符号**：状态符号 `[v]`、`[M]` 等只是视觉元素，读屏读出的是 `aria-label` 中的中文含义。

### 13.5 动效

遵守 `prefers-reduced-motion`（§11.8）。自动轮询带来的界面更新不能造成页面跳动：位置固定，只改变内容。

### 13.6 响应式断点

| 断点 | 布局 |
|---|---|
| ≥ 1700px | 顶栏各项带标签文字；左栏 248px + 内容区；指南三栏（240 / 自适应 / 320） |
| 1280–1699px | 顶栏隐藏标签文字，“继续”最多 300px 并截断，保证单行；其余同上 |
| 1024–1279px | 左栏可以折叠为 56px 图标栏；指南的右栏（检测）收到中栏下方，作为可折叠面板 |
| 768–1023px | 左栏变为抽屉（顶栏 `≡`）；顶栏只保留：继续、档位、配置 x/y、检测徽章（形状 + 短文字）、费用灯（形状 + 金额）；指南为单栏，用“步骤 / 内容 / 检测”三个 Tab 切换 |
| < 768px | 内容区用 `padding-inline` 留出 16px 左右边距，页面不出现横向滚动（不靠 `overflow-x: hidden` 掩盖）；所有网格与 stack 容器的子项设 `min-width: 0`；顶栏不吸顶，“继续”独占一行；表格放在各自的横向滚动容器中；架构图变为分层列表；对比表改为“指标卡片”（每个指标一张，显示各档 / Δ）；命令块在块内横向滚动，头部换行；横幅纵向排列；抽屉和对话框全屏 |

各画面在窄屏下的重点：

| 画面 | 窄屏处理 |
|---|---|
| S02 总览 | 顺序：你在这里（完成度移到卡片下半部分）→ 接下来 → 也可以先做 → 需要关注 → 费用 → 最近完成 → 迷你架构图（文字摘要） |
| S03 学习路线 | 默认列表视图；依赖图在横向滚动容器中 |
| S05 模块目录 | 组名在上、格子在下（格子最小宽约 100px）；侧栏在矩阵下方 |
| S06-2 配置指南 | 三 Tab；底部固定操作栏（上一步 / 检测 / 下一步），高度 56px；变量面板收进“变量”抽屉 |
| S08 对比实验 | 指标卡片；分布图可以横向滚动 |
| S10 检测报告 | 卡片列表；筛选收进“筛选”抽屉 |
| S11 费用 | 资源表变为卡片；清理计划按步骤卡片纵向排列 |

### 13.7 打印

- 学习报告（S12）提供打印样式：A4 纵向，隐藏导航和按钮，架构快照使用静态 SVG，表格不跨页断行，页脚显示导出时间与“账号 ID 已打码”。
- 检测报告提供“打印当前筛选”。
- Artifact 版原型不提供打印按钮（§3.2.1），这不改变正式产品的打印要求。

### 13.8 语言

- v1 只提供简体中文，文案全部放在 `frontend/src/console/i18n/zh-CN.ts`，不硬编码在组件中。
- 技术名词（服务名、API、命令、头名）保持英文原样。
- 日期显示为 `10/13 10:42`（当年）或 `2026-10-13`（跨年）；时长显示为 `3d 4h`、`2:10`。

---

## 附录 A：课程编排与总纲 §10.3 对照

控制台的 `course.yaml` 照抄总纲 §10.3（Lab 0–25 与档位 `l0-ec2` … `l9-full`），本文 §4.12 是它的快照，不另立编排。总纲已规定 labs.md、saa-coverage.md 只保留指向总纲 §10 的引用。下面两张表只用于追溯：旧 labs.md 的内容去了哪里，以及本文 v1.0（已作废的 Lab 0–8 编排）的 Lab 对应到现在的哪个 Lab。

**旧 labs.md → 现行 Lab**

| 旧 Lab（labs.md） | 现行位置（总纲 §10.3） |
|---|---|
| 0 账号安全与成本护栏 | Lab 0 · ec2 的账号护栏步骤（根账号 MFA、标签；Identity Center 为选做手动步骤）；Budgets → Lab 1 · cost；CloudTrail → Lab 23 · audit |
| 1 VPC 网络 | Lab 14 · network（public 放置）与 Lab 20 · network（private 放置）；L0 先用默认 VPC |
| 2 前端：S3 + CloudFront + Route 53 + ACM | Lab 4 · storage、Lab 5 · cdn（含 S3 媒体源站 + OAC）、Lab 6 · dns、tls（需要域名） |
| 3 Cognito | Lab 8 · auth、identity-pool |
| 4 单台 EC2 跑通 API | Lab 0（L0 本身就是）；实例角色 → Lab 1 · iam；Session Manager → Lab 2 · shell-access |
| 5 RDS + Secrets Manager + ElastiCache | Lab 15 · database（扩展 db-proxy）、Lab 16 · cache；secrets → Lab 13 |
| 6 上传与 Lambda | Lab 4 · storage + Lab 11 · image-processing |
| 7 ASG + ALB | Lab 19 · load-balancer、Lab 21 · autoscaling（前置或扩展：ami；变体：shared-fs） |
| 8 SNS 扇出 + SQS + Rekognition | Lab 9 · email、notification，Lab 10 · queue，Lab 11 · tagging（S3 事件统一经 EventBridge，总纲 §3.2 决定 1） |
| 9 API Gateway + Lambda + DynamoDB | Lab 17 · social-store、social-api |
| 10 安全加固与可观测性 | waf → Lab 7；kms、secrets、config → Lab 13；logging、monitoring → Lab 3；tracing → Lab 22；audit、threat-detection → Lab 23；compliance、vuln-scan → Lab 25（选做） |
| 11 灾备与成本优化 | backup（含复制到大阪）→ Lab 24；成本护栏 → Lab 1 · cost |
| 12 IaC 与 CI/CD | 总纲 §10.3 没有安排，不计入进度；学习报告中作为“延伸阅读”链接 |

**本文 v1.0 的 Lab（已作废）→ 现行 Lab**

| v1.0 | 现行 |
|---|---|
| Lab 0 单机起步与账号护栏 | Lab 0（Budgets 移到 Lab 1 · cost） |
| Lab 1 运维与身份 | Lab 1–3（iam、cost、shell-access、logging、monitoring）；secrets、config 移到 Lab 13 |
| Lab 2 边缘接入 | Lab 5（cdn）、Lab 6（dns、tls）、Lab 7（waf） |
| Lab 3 数据上云 | Lab 4（storage）、Lab 13（kms）、Lab 15（database）、Lab 16（cache）、Lab 24（backup） |
| Lab 4 托管身份 | Lab 8（auth、identity-pool）、Lab 9（email） |
| Lab 5 异步解耦 | Lab 9（notification）、Lab 10（queue）、Lab 11（image-processing、tagging）、Lab 12（scheduler） |
| Lab 6 Serverless 社交 | Lab 17（social-store、social-api）、Lab 18（analytics） |
| Lab 7 高可用与全量 | Lab 14、20（network）、Lab 19（load-balancer）、Lab 21（autoscaling）、Lab 22（tracing）、Lab 23（audit、threat-detection） |
| Lab 8 加分：IaC 与 CI/CD | 不计入课程（见上表） |

---

## 附录 B：需要同步到总纲与其他文档的补充

以下各项是本设计对总纲的**细化或补充**，不推翻总纲的任何决定。按总纲文首的约定，它们要先写入总纲的修订记录，再在对应位置或相关模块文档的“与总纲的偏差”小节中落地；总纲采纳之前，实现以总纲现行文字为准，本文相应功能标为“待总纲确认”。

| # | 位置 | 补充内容 | 理由 |
|---|---|---|---|
| B-1 | 总纲 §8.1、§12 | `/lab` 整体并入 `/console`（301 映射见 §3.2）。控制台**仅管理员**可访问，原“登录用户只读 `/lab`”取消；普通用户仍可以使用相册中的徽章和 `?trace=1` 路径条 | 任务决策 4：学习控制台只有管理员能访问 |
| B-2 | 总纲 §2.7 第 10 步 | 改为 `node dist/cli.js setup:token --out /var/lib/cloudalbum/setup-token`（cloudalbum:cloudalbum 0600），不再执行 `admin:create --print-password`。保留 `admin:create` 作为恢复工具。setup 请求默认只接受回环地址或 HTTPS 来源，`setup:token --allow-remote` 打开 1 小时的远程窗口；重新生成 token 时 `token_generation` 加一。向导兼容旧做法（检测到已有 admin 时改为“接管”） | 任务决策 4；§6.10 第 8 条 |
| B-3 | 总纲 §9.1 模板约定 | 可选参数 `Existing<Resource>Id`（为空表示新建）。有值时不创建该资源，Outputs 改用参数值；被接管的资源要求带 `ManagedBy=manual` 标签，`disable` 不删除它，并在清理计划中列为手动收尾项。通过已有的 `--param` 传入，不新增 CLI 选项 | 支持“先手动，再接管”的路线（§5.4） |
| B-4 | 总纲 §11 `cli.ts`；B 组文档 `02-identity-security.md#auth` | 新增子命令：`console:login-link`（打印 `…/console/login#ticket=…`，票据在 URL 片段中）、`setup:token [--allow-remote]`、`console:probe <path> [--via cdn\|self]`（带探测令牌发请求，供学员复现引擎的检查）。auth 中间件增加控制台会话 `ca_console` 的校验分支（本地 ES256、`aud=cloudalbum-console`、TTL ≤ 1h、不可刷新，§3.8）；cognito 模式下管理员只取自已验签访问令牌的 `cognito:groups`，dual-stack 期间两侧都要求 admin 并写审计日志；auth 指南在 wire 之前增加预检步骤（管理员邮箱可收信、admin 组已同步、会被登出） | §3.8 |
| B-5 | 总纲 §8.2 | `lab_results` 表由 `experiment_runs`（§10.2）取代；`POST /api/lab/runs`（登记，服务端保存 capabilities 快照）和 `POST /api/lab/results` 保留为运行器的写入接口。实验支持多档 `--label <stage>`（queue、image-processing 的中间档）；运行器自报的 `environment.drivers`、`forced` 只作显示，判定以服务端快照与 `capability_events` 为准；有效性在 rollups 补齐后延迟校验；边缘模块（cdn）上传按目标分组的客户端证据 | §4.7 |
| B-6 | 总纲 §11 `.eslintrc` | `@aws-sdk/*` 的允许目录增加 `backend/src/console/verifier/`（只能动态 `import()`） | 检测引擎的 AWS 只读调用 |
| B-7 | B 组文档 `02-identity-security.md#iam`；总纲 §9.1 托管策略配额统计 | iam 栈增加检测器只读角色 `cloudalbum-<env>-lab-verifier-role`（只信任 `CloudAlbumAppRole`，会话名 `console-verifier`）与客户托管策略 `cloudalbum-<env>-lab-verifier`（由角色的 `ManagedPolicyArns` 引用，模板不写 `Roles:`）；可选策略 `cloudalbum-<env>-lab-verifier-account`（`--param VerifierAccountReads=on`）；`CloudAlbumAppRole` 增加一条只指向该角色的 `sts:AssumeRole` 内联语句；`--param LabVerifier=off` 删除检测器角色与策略。策略 Description 固定，版本写在 Sid 中。托管策略配额：Verifier 角色上 1–2 个，`CloudAlbumAppRole` 不变 | §6.7 |
| B-8 | 总纲 §9.2 第 7、11 步与 disable 第 7 步 | `/etc/cloudalbum/modules.state.json` 的格式至少包含：`modules{id:{enabled,driver,version,enabledAt}}`、`history[{opId,op,module,at,operator,profile?}]`，以及 `pending{opId,module,op,startedAt}`：第 7 步（投递配置）写入 `pending`，第 11 步写入历史并清除；disable 同理。控制台用 inotify 加 mtime/校验和轮询监视它，并对“off 且没有 disabled 事件”设 5 分钟宽限期 | §4.13：避免把正常的 disable 误判为漂移 |
| B-9 | 总纲 §3.4 注册表 | **撤回** v1.0 提出的 `requiresAwsCredentials` 字段：总纲已有 `credentials: required\|optional\|none`，控制台直接使用它（locked 只对应 `none` 模式下的 `required`，CRED-001） | 与总纲 D1 一致 |
| B-10 | 总纲 §6.1 | 管理员视图的 `data` 中，需要包含指南变量会引用、但不在 env 文件中的资源 ID（例如复制组 ID、Web ACL ARN、`network.data.placement`）；cdn 的分配 ID 已在 `CDN_DISTRIBUTION_ID` 中，不需要重复。这些值在 wire 达成与每次 enable 事件时由控制台固化为快照 | 指南变量的 `fillFrom: cap.*`；清理验证（§5.4） |
| B-11 | docs/labs.md | 按总纲 §10.3 调整（总纲已规定 labs.md 只保留指向 §10 的引用）；旧内容的去向见附录 A | 原则冲突 |
| B-12 | README | 文档导航增加 `docs/ui-design.md` 与 `docs/ui-prototype/` | — |
| B-13 | 总纲 §8.2 运行器第 1 步 | 运行器不再使用 `CLOUDALBUM_ADMIN_TOKEN` 或“实验专用管理员账号”。`npm run exp:login` 改为输入 S13 签发的**实验上传令牌**：范围只有 `lab:runs`、`lab:results`、`X-Experiment-*` 与旁路白名单路由上的 `X-Compare-Bypass`，带 TTL，可撤销，库中只存哈希，与 auth 驱动无关 | §6.10 第 2 条：v1 每套环境只有一个管理员；运维机上不保存完整管理员令牌 |
| B-14 | 总纲 §7.2（`EXPOSE_PATH_HEADERS`、SEC-004）、§10.1 `overlay-public-demo` | 持有有效探测令牌（`X-CloudAlbum-Probe`）的请求，无论 `EXPOSE_PATH_HEADERS` 取何值都返回 `X-CloudAlbum-Path`。探测令牌的权限范围：读路径头、在旁路白名单路由上使用旁路、访问 `/api/console/probe/*`，没有其他管理员能力 | 站点改为 admin 可见路径头后，引擎的 wire 检查不会被批量误判为漂移（§4.5） |
| B-15 | 总纲 §3.3 感知器（waf、dns 两行）、§7.3 源站卸载统计 | 防伪造：① WAF 插入的头带一个随机密钥值（存于 `secrets.env`），Nginx 校验后才计入 `$ca_entry`；Web ACL 增加“拦截外部携带 `x-amzn-waf-` 前缀请求头”的规则。② dns 的生效证据改为“引擎解析域名，再经该域名发起请求，观测到的 entry 一致”，不再只看 Host 头。③ 源站卸载与 nginx-log 分组按 `$server_port`/`$ca_entry` 统计，不看 `X-Amz-Cf-Id`、`Via` 请求头。④ 带探测令牌的请求不计入感知器窗口与 real-traffic 统计 | 本文不能修改总纲，这些改动作为提议记录在这里；控制台侧已按 ③④ 实现（§5.7 `nginx-log`、`path-seen`） |
| B-16 | 总纲各处、`01-edge-network-scaling.md#cdn` | 引用 `/api/lab/now` 的地方改为 `GET /api/console/probe/now`（§9.2）：校验探测令牌后以“探测主体”身份返回 `{now, nonce}`，带 `Cache-Control: private, no-store`，经过 CdnPort 与路径头中间件 | `/api/lab/now` 在总纲与模块文档中都没有定义 |
| B-17 | 总纲 §2.4、`06-governance-cost.md#cost` | 控制台只使用 `cost-rates.yaml` 一个价格来源，不内置示例价；cost 模块提供生成模板的命令（只列计费维度、单价留空）。没有价格文件时，界面只显示计费中的资源与时长 | 与总纲“不写价格”的写作约束一致 |
| B-18 | 总纲 §9.2 引导配置包、`01-edge-network-scaling.md#autoscaling` | ASG 模式：探测令牌的 HMAC 密钥纳入 `secretParams` / 引导配置包，所有实例一致；探测 nonce 存于共享库或 Redis；控制台不在实例本地盘写进度快照；`instanceScope: all` 的实例间内部调用需要安全组允许同组实例访问 api 端口（VPC 内） | §6.2 |

---

## 附录 C：术语与文案词表

| 术语 | 用法 | 不要写成 |
|---|---|---|
| 完成 | 模块级：步骤 + 对比都满足 | 通关、搞定 |
| 达成 | 步骤级：适用的必需检查都满足（已达成 / 已达成（含手动）/ 已达成·已清理） | 完成（步骤级不用“完成”，避免和模块级混淆） |
| 已完成·已清理 | 学过，资源已删除；进度保留 | 已删除、未完成 |
| 漂移 | 之前通过，现在不通过，且不是主动清理或后续 Lab 的正当变更造成的 | 失败、回退 |
| 被取代 | 后续 Lab 的正当变更让某项检查不再适用（例如 Lab 19 把源站换成 ALB）；不算漂移 | 失效、漂移 |
| 降级 | 因为没有凭证或权限，AWS 只读检查改为手动核对 | 跳过 |
| 含手动 | 完成判定中至少一项来自手动确认 | 半完成 |
| 检测器出错 | 检查本身没能跑完 | 失败 |
| 接入应用 | wire 步骤：让应用真正用上 AWS 实现 | 启用（“启用”指 `scripts/module enable`，只是接入的手段） |
| 运维机 | 执行 `scripts/module` 和 `npm run exp` 的机器（你的电脑或 CloudShell） | 本地、客户端 |
| 档位 | 运行状态，名称取自总纲档位文件（`l0-ec2` … `l9-full`），加 `+N` | 等级、关卡、L0–L7 |
| 学习路线 | 主线（Lab 0–25）/ 重点对比快速路线（`x-named-comparisons` + cost） | 难度、模式 |
| 本地实现 / AWS 实现 | 模块关闭时和开启时的驱动 | 旧版 / 新版 |
| 本地档 | 不产生 AWS 费用的中间实现（memory 队列、自建 Valkey、worker 等） | 简化版 |
| 第一档 / 最后一档 | 对比实验的基线档与目标档（通常是 before / after） | 前测 / 后测 |
| 检测器 | 控制台的只读检查引擎，扮演 Verifier 角色 | 扫描器、机器人 |
| ≈$ | 所有估算金额前都加；金额只来自 cost-rates.yaml | 不加约等号的精确金额 |

---

## 附录 D：实现里程碑

| 里程碑 | 范围 | 验收 |
|---|---|---|
| M1 骨架（L0 可用） | 数据表；`setup`（回环 / HTTPS 限制、按 IP 限速、410）与 `ca_console` 会话；全局框架；S02、S05、S06-2；检查类型 `local`、`http-header`（探测令牌、`/probe/now`）、`capability`、`session`、`manual`；SSE（`seq` 游标）；ec2、iam、cost 的指南 | 在一台全新的 L0 上经 SSH 隧道完成向导，Lab 0 本地检查自动通过；完成 iam 后，降级的确认被自动复核为 `done` |
| M2 检测完整 | `aws-readonly`、Verifier 角色与策略生成、投影白名单、诊断（按 ResourceArns 模拟）、S10、S13；Lab 1–3 的指南 | 缺权限、无角色、keys 模式（模块不锁）、时钟偏差、策略落后五种情况都有正确的界面表现；任何证据中都找不到 `HeaderValue`、`ClientSecret`、`UserData` |
| M3 对比 | `experiment_runs`（多档、服务端快照、延迟校验、客户端证据）、实验上传令牌、S06-3、S08、S08a、S09；重点对比的 7 个模块（storage、cdn、database、cache、auth、queue、image-processing）的手写指南 | 7 个模块都能完成首尾两档；cdn 的 after 用客户端证据判为有效；无效记录能正确标出原因 |
| M4 看得见 | S07 架构图、S03 路线（主线 / 快速路线）、S04、费用与清理 S11/S11b、`supersededWhen` 与状态文件监视 | L0 → l2-edge 的芯片迁出、费用灯变化；disable cdn 不产生漂移横幅；Lab 19 把源站换成 ALB 后 cdn 显示“被取代”而不是漂移；清理回 L0 后显示 `[z]`，进度不变 |
| M5 收尾 | 其余指南（没有手写的明确标为占位）、小测、S12 报告、无障碍与窄屏测试 | axe 无 serious 问题；400px 宽下所有画面没有页面级横向滚动；40 个模块都有指南（手写或占位）且通过 lint |
| M6 多实例 | 租约、`instanceScope`、实例间内部调用、共享 nonce、ASG 下不写本地快照 | 3 台实例的 ASG 下：漂移标记不来回跳；替换实例后等待型轮询继续；SSE 重连不丢事件 |

---

## 修订记录

### 2026-10-13 · v1.1（评审修订）

对齐总纲第 2 轮修订（40 个模块、Lab 0–25、档位 `l0`～`l9`、Node.js 22），并按评审意见修订：

1. **进度模型对齐总纲**：废弃“Lab k ↔ 档位 Lk”与 L0–L7；course.yaml 照抄总纲 §10.3；档位徽章在运行时读取 `profiles/*.env`；必做数与模块数由路线推导；新增“重点对比快速路线”（`x-named-comparisons` + cost）；Budgets 移到 cost 模块；文档引用改为“分组文件#锚点”（§2.3、§3.4、§4.10–4.12、§5.2、附录 A）。
2. **启停事件**：监视状态文件 + pending op + opId 去重 + 宽限期，不再只在启动时比对（§4.13、附录 B-8）。
3. **检测器安全**：独立 Verifier 角色；资源收窄与标签条件；响应投影白名单与默认丢弃清单；删除 `wafv2:GetSampledRequests`、`lambda:ListFunctions`、`cloudfront:ListDistributions`；版本写在 Sid、Description 固定；名称带环境前缀、通过 `ManagedPolicyArns` 引用；可选账号级读取；结课后移除（§6.6–6.8、附录 B-7）。
4. **会话与鉴权**：`ca_console` 专用会话；cognito 模式的管理员判定；auth 预检步骤；应急票据放在 URL 片段；Origin 白名单（§3.8）。
5. **多实例一致性**：共享库、`instanceScope`、数据库租约、`seq` 游标、共享探测密钥与 nonce、ASG 不写本地快照（§6.2–6.5、§6.11、§10）。
6. **后续 Lab 的正当变更不算漂移**：`supersededWhen`、表达式 `env.*`/`cap.*`、cdn 指南的源站 / 媒体源站分支（§4.13、§5.6、§5.10）。
7. **Schema 补齐**：多档实验 `stages`、`localTier`、`path-seen`、`session`、`impact`、`requires.runtime` 表达式、`instanceScope`、`distinct`、`ScriptMethod.runsOn`、断言管道与数值转换与缺失语义、lint 模拟评估、清理变量快照、`reproduce` 必填（§5.3–5.11）。
8. **客户端数据不冒充事实**：`LOCAL_CLIENT` 来源、服务端能力快照、浏览器运行器只作参考、cdn 的客户端证据（§4.2、§4.7）。
9. **其他**：setup token 不再全局锁定；`/api/console/probe/now`；变量防注入与 `{{env}}`、`{{baseSgId}}`/`{{sgIds}}`；`sg-no-world` 断言修正；状态判定的 7 处漏洞；DDL 与保留策略；实验上传令牌；价格来源统一为 cost-rates.yaml；probe 白名单收紧；有效性延迟校验；lock-direct 移到 after 之后；原型与 Artifact 版的路由映射（§3.2.1）。
10. **界面**：总览首屏可见完成度并去掉重复的漂移提示；模块目录紧凑密度；顶栏高度用 `--topbar-h`；窄屏不只靠颜色；导航式标签与 tablist 区分；disclosure 浮层；横幅只播报一次；单键快捷键可关闭；课程大纲 tree 模式；颜色 token 调整以满足对比度（§3、§7、§8、§11、§13）。
