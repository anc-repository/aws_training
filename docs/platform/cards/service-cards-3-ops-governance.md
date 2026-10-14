# 单服务卡片 · 第 3 批：运维观测与治理成本（E 组 + F 组）

> **文档定位**：ATL 卡片模型中 `kind: service` 的第 3 批，共 12 张：E 组 shell-access、logging、monitoring、tracing、audit、threat-detection；F 组 cost、compliance、vuln-scan、db-proxy、workflow、ami。本文定义每张卡片的步骤、检查、对比实验、手册要点与小测。
>
> **分工**（主设计者裁决 C1、C2）：卡片的目录级元数据（标题、难度、时长、起始状态、费用档位、部署等级）以 [05-lab-catalog](../05-lab-catalog.md)（卡片目录，权威）§4 为准，本文的总表只是摘要；目录总则（难度、时长、费用档位、部署等级的判定）在 05 §3；学习路径、掌握度、徽章与证书的模型以 [tracks-and-catalog.md](tracks-and-catalog.md) 为准；`lab.yaml` 字段以 [04](../04-lab-format-checks-reports.md) §3（`atl.lab/v2`）为准；实体、路由、标签、档位名等名称以 [01](../01-architecture.md) §14 为准；本批需要的 CloudAlbum 侧改动（实验脚本参数、registry 数据、`scripts/module` 平台模式）以 [06](../06-cloudalbum-platform-mode.md) 为唯一清单。
>
> **依据**（本文只读引用，不修改它们）：[modular-design.md](../../modular-design.md) §3 模块目录、§5 规则表、§10 档位；[05-ops-observability.md](../../modules/05-ops-observability.md)；[06-governance-cost.md](../../modules/06-governance-cost.md)；平台设计 01～06。
>
> **状态**：设计稿 · 第 3 轮（落实主设计者裁决 C1～C8，见文末“修订记录”）· 2026-10-13。不写具体价格和性能数字；费用只写档位与主要计费来源；不确定的 AWS 行为写“以官方文档为准”。

## 本批卡片总表

本表是摘要，取值以 05 §4 与各卡 `lab.yaml` 为准。按裁决 C3，12 张卡片的起始状态都是 **L0 + iam(role) + 目标硬依赖的闭包**，由 `scripts/module plan --start-of <card-id>` 推导（档位 `atl/<card-id>/<variant>`，本批都只有默认变体 `default`）。

| id | 标题 | 难度 | 时长（预计 / 上限） | startProfile（L0 + iam(role) 之外） | 费用档位 | 人工前置 |
|---|---|---|---|---|---|---|
| [`svc-shell-access`](#svc-shell-access) | AWS Systems Manager Session Manager：运维登录 | 初级 | 60 / 90 分钟 | —；SSH 22 只对工作台**私网**地址 /32 开放（`workstation.sshFromWorkstation: true`，由运行器设置） | 低 | 无 |
| [`svc-logging`](#svc-logging) | Amazon CloudWatch Logs：集中日志 | 初级 | 45 / 90 分钟 | 运行时热键：故障注入开关打开 | 低 | 无 |
| [`svc-monitoring`](#svc-monitoring) | Amazon CloudWatch：指标、告警与仪表板 | 初级 | 75 / 120 分钟 | 运行时热键：故障注入开关打开 | 低 | 告警邮箱，并确认 SNS 订阅 |
| [`svc-tracing`](#svc-tracing) | AWS X-Ray：分布式链路追踪 | 中级 | 75 / 120 分钟 | 本地档（自建 PostgreSQL、memory 队列 + worker）；故障注入开关打开 | 低 | 无 |
| [`svc-audit`](#svc-audit) | AWS CloudTrail：AWS API 操作审计 | 中级 | 75 / 120 分钟 | —（audit 没有硬依赖） | 低 | 无（账号已有 trail 时以只读接入方式完成） |
| [`svc-threat-detection`](#svc-threat-detection) | Amazon GuardDuty：威胁检测 | 中级 | 45 / 90 分钟 | —（threat-detection 没有硬依赖） | 中 | 发现通知邮箱，并确认订阅 |
| [`svc-cost`](#svc-cost) | AWS Budgets：费用护栏与告警 | 初级 | 45 / 90 分钟 | —（cost 没有硬依赖） | 低 | 成本分配标签已激活（平台动作 `cost-activate-tags`，需提前 24～48 小时）；账号已开启“IAM 用户和角色访问账单信息”；确认订阅；自定两个预算金额 |
| [`svc-compliance`](#svc-compliance) | AWS Config：配置合规与漂移检测 | 中级 | 75 / 120 分钟 | —（compliance 没有硬依赖） | 中 | 确认订阅 |
| [`svc-vuln-scan`](#svc-vuln-scan) | Amazon Inspector：漏洞扫描 | 中级 | 75 / 150 分钟 | —（iam 同时是 DEP-035 的硬依赖） | 中 | 确认“账号级激活”（本卡只启用 EC2 扫描类型；本区域全部 EC2 实例都会被扫描、计费，包括工作台） |
| [`svc-db-proxy`](#svc-db-proxy) | Amazon RDS Proxy：数据库连接池 | 高级 | 90 / 180 分钟 | secrets(secretsmanager) + database(RDS，单 AZ) + 本地档 `LB_LOCAL_WORKERS=2` | 高 | 无 |
| [`svc-workflow`](#svc-workflow) | AWS Step Functions：照片处理流程编排 | 中级 | 75 / 120 分钟 | storage(s3) + 本地档（worker + memory 队列）；故障注入开关打开（工具链栈由运行器 `base-deploy` 创建，是平台固定部分） | 低 | 无 |
| [`svc-ami`](#svc-ami) | EC2 Image Builder：黄金 AMI 构建 | 中级 | 135 / 210 分钟 | —（ami 没有硬依赖） | 中 | 无（切换时有一次停机窗口） |

“时长”不含平台部署起始状态的时间（倒计时从 READY 开始，02 §5）。12 张卡片都允许延长；可延长次数与每次时长见各卡元数据（平台默认上限为 2 次、每次 30 分钟，02 §5.4）。第 2 轮中 audit、threat-detection、cost、compliance、ami 五张“不并入 iam”的卡片按 C3 增加了 iam(role)；iam 是快资源、不计费，部署等级与费用档位不变。

---

## 本批约定

### 1. `lab.yaml` 的写法：以 04 §3（`atl.lab/v2`）为准

第 2 轮本批在 04 v1 的基础上自拟了一组卡片字段；04 第 2 轮已把卡片模型并入 `atl.lab/v2`，本批一律改用 04 的字段（04 §14 K-1～K-8）。对照如下，完整示例见 [svc-shell-access 的 lab.yaml](#svc-shell-access-labyaml)：

| 本批第 2 轮的写法 | 04 `atl.lab/v2` 的字段 |
|---|---|
| `modules{primary, preset[], related[]}` | `modules{target[], start[], context[], related[]}` |
| `startProfile.{extends, add, drivers, runtime, equivalentTo, items[].source}` | `startProfile.provisions[]{item, kind, basis, set, params, value, rule, reason}`（`kind`：`module \| local \| runtime \| seed \| platform`；`basis`：`credential \| closure \| precursor`）+ `startProfile.platform.preview.directHttps` |
| `targetModules[]{id, driver, params}` | 同名，另有 `fromDriver`、`set`、`wireStep` |
| “预期警告集合” | `expectedWarnings[]`（04 §3.2.5）；capability 用 `op: healthy`（04 §5.3） |
| `experiments[].labels: [before, after]`、`allowSimulatedBefore` | `labels[]{id, role: baseline \| treatment \| single}`、`pairs`、`requiredLabels`、`allowSimulatedBaseline`、`validity: functional` + `corroborateWith`（04 §3.2.10）；三段式对比用声明的变体（`local`、`pgbouncer` 等，裁决 C5） |
| `quiz{passScore, requiredForCertificate}` | `quiz{file, draw}`：成绩只记录在徽章上，不影响完成（裁决 C3） |
| `badge{id, title, icon, awardOn, requireQuiz}` | `badge{title, short?, icon?}`：完成即授予 |
| `platform.preview` | `startProfile.platform.preview.directHttps` |
| `platform.accountImpact[]{resource, scope, handling}` | `platform.accountImpact[]{id, scope, resource, preexisting, revert, note}`（04 §3.2.15） |
| 共享检查 `lab2-no-world-ssh` | `no-world-ssh`（04 K-8） |
| 探测端点 `/api/console/probe/now` | `/api/lab/probe/now`，请求头 `X-ATL-Probe-Token`（06） |

`id`（`svc-<模块 id>`）、`kind`、`service` / `function`、标题 ≤ 48 字、四级难度、`cost.tier`、`provision.class`（必填）、`workstation.sshFromWorkstation`、`workstation.tools` 中的 `session-manager-plugin`、`certificate: { enabled: false }`、`platformOps[]{id, op, module, args, title, …}` 都已是 04 的正式字段。

### 2. 难度、时长与费用档位

判定规则以 05 目录总则（05 §3）为准，摘要见 tracks-and-catalog §1.6；本节只列与本批有关的部分。

| 难度 | 判定（满足任一条即归入较高一级） | 本批卡片 |
|---|---|---|
| 入门 | 不启用任何 AWS 模块，只观察与运行脚本 | 无（单服务卡片都要启用一个模块） |
| 初级 | 概念集中在单个服务；没有 VPC 绑定资源与数据迁移风险；步骤以脚本与控制台为主 | shell-access、logging、monitoring、cost |
| 中级 | 多个服务相互配合（事件路由、编排）；或需要等待云端生效（trail 投递、镜像构建）；或涉及网络与权限的交互；或会开启账号级按量服务（GuardDuty、Config、Inspector）。“账号级影响”本身不抬高难度：svc-shell-access 修改区域级会话首选项、svc-cost 创建预算，仍是初级 | tracing（三段式对比 + 等待 trace）、audit（等待投递与 digest）、threat-detection、compliance、vuln-scan（账号级按量服务）、workflow（事件路由 + 编排）、ami（等待镜像构建 + 替换实例） |
| 高级 | 多个按小时计费的托管资源同时运行、出错代价高；或实例替换后的故障演练、多 AZ 故障转移 | db-proxy |

- **预计时长**：熟练学员完成全部**必需**步骤的典型用时，包含卡片内的云端等待，不含起始状态的部署；取 15 分钟的整数倍。**时间上限**：取 30 分钟的整数倍，且 ≥ 预计时长 × 1.5（04 §3.5 第 16 条）。
- **费用档位**只看计费结构、不看单价：
  - **低**：除“基础”（实验机与工作台的 EC2、EBS、公网 IPv4）外没有额外的按小时计费资源，也没有账号级按量服务；其余是按量或按月折算的小额项。
  - **中**：额外的按小时计费资源恰好 1 个单位（含一台临时 EC2），**或**会话期间开启了账号级按量服务（GuardDuty、Config、Inspector）。05 的算法按 `cost.basis` 中按小时计费项的 `quantity` 求和，不看运行时长：同一卡片里先后出现的临时 EC2 只有声明为“同一时刻至多 1 台”的单项时才算 1 个单位（svc-ami）。
  - **高**：额外的按小时计费资源 ≥ 2 个单位（例如 RDS + RDS Proxy）。
  金额区间由平台报价接口（`POST /api/v1/labs/{labId}/quotes`，02 §3.2）按示例价给出，本文不写价格。iam 不计费，C3 预置 iam 不改变任何一张卡片的档位。

### 3. startProfile 的计算规则

1. **起始状态 = `l0-ec2` + iam(role) + 目标模块硬依赖的闭包**（裁决 C3，04 §3.2.3）。本批 12 张卡片都预置 iam（`IAM_CREDENTIALS=role`；平台模式下 iam 栈为 `AppRoleMode=existing`，01 §9.6），写成 `{ item: iam, kind: module, basis: credential }`。对 shell-access、vuln-scan 来说它同时是硬依赖（DEP-001、DEP-035 要求必须是 role）。
2. 闭包：目标模块 `requires` 表达式与规则表中“启用某模块即可满足”的 error 级条件（总纲 §5.2），`a | b` 取默认分支并写明理由；闭包内各模块自己的硬依赖一并计入。
3. **不直接用 `single/<id>`**：它包含目标模块本身。起始状态由 `scripts/module plan --start-of <card-id> --platform --json`（06）推导，构建期生成 `profiles/atl/<card-id>/default.env`（05 §8.5），`labs:derive` 要求 `provisions` 与推导结果逐项相同（04 DRV-1、DRV-2）。第 2 轮各卡写的“等价于 `single/<id>`”已删除。
4. **第 2 轮“`credentials: optional` 的模块不并入 iam”的口径作废**（附 B-14、B-17）：audit、threat-detection、cost、compliance、ami 五张卡片的起始状态增加 iam；随之删除的有——capability 检查中的预期警告 CRED-004、svc-compliance 与 svc-threat-detection “wire 步骤中由学员先执行 `scripts/module enable iam`”的例外、audit / cost / ami 的“选做 `enable iam`”步骤。应用内依赖控制面的展示（`/admin/audit` 的“AWS 事件”页签、`/lab` 安全面板右栏、合规覆盖矩阵的 Config 列、顶栏的 Budgets 一侧、ami 感知器读取晋升参数）从起始状态起就可用，必需实验 `coverage-matrix`、`ssh-canary`、`sample-findings` 因此在 after 一侧能拿到数据。
5. **本地档取值**（总纲 10.4 规则 3）：为了让对比有意义而加的零 AWS 费用的取值，例如自建 PostgreSQL、`QUEUE_DRIVER=memory`、`LB_LOCAL_WORKERS=2`，写成 `kind: local`。它们不写 `MODULE_<ID>=on`，不算“启用了模块”。单服务卡的这类调整要能由 registry 推导（`singleLocalSettings`，06）。
6. **运行时热键**：需要故障注入的卡片把 `featureFlags['lab.faults']` 设为 `true`，写成 `{ item: featureFlags.lab.faults, kind: runtime, value: true }`（registry `singleRuntime`，06）。
7. 目标取值不得在起始状态中生效（04 DRV-5）；人工前置不能由运行器自动满足的，写进 `prerequisites.learnerInputs` 与元数据的“人工前置”。
8. **平台固定部分**（不是模块，不计入闭包，写成 `kind: platform` 的说明条目）：`CloudAlbumAppRole`（只挂 `AmazonSSMManagedInstanceCore`）、工作台、方案 B 的 Let's Encrypt IP 证书、随发布包安装的检查包，以及运行器 `base-deploy` 创建的**工具链栈**（01 §3.4：会话开始时把发布包与预构建 Lambda 包复制到工具链桶）。workflow 的 DEP-034“工具链栈存在”因此在平台模式下天然满足，不是 startProfile 项。`scripts/module` 的 `state.json` 与环境操作锁不在工具链桶中，而在平台栈创建的环境状态桶 `cloudalbum-lab-state-<acct>-<region>`（`<envName>/state.json`）与锁表 `cloudalbum-lab-locks`（01 §3.11，裁决 C4(c)）。
9. **不用平台占位符**：本批没有卡片需要 04 §3.2.3 的 `${atl:workstationPrivateCidr}` / `${atl:workstationPublicCidr}`。svc-shell-access 的 SSH 基线由 `workstation.sshFromWorkstation: true` 驱动，运行器按 03 §4.8 取工作台私网 /32（实验机与工作台同在默认 VPC）。第 1 轮的 `${atl:workstationCidr}` 已废止。

### 4. 平台模式下影响本批全部卡片的事实

- 实验机从 L0 起就挂着实例配置文件 `CloudAlbumAppRole`，其中只有 `AmazonSSMManagedInstanceCore`（平台管理通道，01 §6.6）；应用自己的凭证来自 C3 预置的 iam。所以**实例从一开始就是 SSM 托管节点**：shell-access 对比的是“运维者走 SSH 22”与“运维者走 Session Manager”，vuln-scan 的托管节点前提在 L0 已经满足。平台模式下 `scripts/module` 的投递通道始终是 SSM Run Command（01 §9.6），模块文档中“投递通道从 ssh 切换为 ssm”的步骤不适用。
- 工作台与 L0 实验机同在默认 VPC 的公有子网（03 §4.4）。需要 SSH 基线的卡片声明 `workstation.sshFromWorkstation: true`，运行器把 `SshIngressCidr` 设为工作台**私网** IP/32（03 §4.8），`ssh lab` 经 `atl-lab-proxy` 现查地址后走私网。
- 平台自己的终端会话使用 Session 文档 `ATL-SessionShell` / `ATL-SessionShell-Logged`（会话 ID 形如 `atl-<sid>-term-<随机串>`），不读写账号级单例 `SSM-SessionManagerRunShell`（03 §3.3）；统计学员会话时要排除平台终端会话。平台终端的可选录制写入 `/atl-recordings/terminal-sessions`（不是 `/atl/*`）。
- 账号级、区域级单例（CloudTrail trail、GuardDuty detector、Config 客户托管记录器、Inspector 账号激活、`SSM-SessionManagerRunShell`）一律由 `scripts/module` 的 preflight 决定“新建 / 只读接入”（成本分配标签例外：由平台动作激活，回收时不撤销，06 约定 8）；一个安装同时只有一个活动环境（01 的 `ActiveEnvironmentLock`），所以这些卡片不会互相干扰。回收器只处理“本会话开启的”账号级开关（02 §7）；被修改的单例原值备份到环境状态桶的 `<envName>/backups/`（`cloudalbum-lab-state-<acct>-<region>`，01 §3.11；06 PM-27、PM-M28），回收器兜底复位时可以读到（02 §7.5 S6）。
- **标签与发现**：资源标签 `atl:session-id`、`atl:env-id`、`atl:lab-id`（= 卡片 id）、`Project=CloudAlbum`；`scripts/module` 在平台模式下给模块栈另打 `atl:component=env`（裁决 C4(d)，06）；实验机另有 `atl:role=lab-app`。平台按 `atl:env-id` + `atl:role=lab-app` + 栈名发现实验机（01 §9.8、04 §5.2.1），所以卡片中临时启动的实例（ami 的构建实例与实验实例）**不得**带 `atl:role`。
- 告警、发现、合规通知的收件邮箱统一使用学员前置输入 `notify-email`（取值集合见 05 §1.2），只用于本会话的 SNS 订阅。
- **纯基础设施型模块不在请求路径上**（shell-access、audit、threat-detection、compliance、vuln-scan、cost、ami 都不出现在 `X-CloudAlbum-Path` 中）。04 §3.5 第 3 条允许这类模块的 wire 步骤用 `local`（`module-state`）加一项带 `ownership` 的 `aws-readonly` 作为“真的接入了”的证据。workflow 是适配器型，但它的路径段 `workflow=stepfunctions:started` 只出现在 `POST /api/photos/:id/complete` 上，`http-header` 只能发 GET/HEAD；本卡用 `local`（`path-seen`，04 §6.4 已登记，读 LabMetricsStore 中真实请求的路径签名）。
- **只读接入时的归属**：账号级单例（trail、detector、配置记录器、Inspector 激活）在 preflight 判定为“只读接入”时不是本会话创建的，对它们的 `aws-readonly` 检查不带 `ownership`，并用条件限定只在“本项目创建”时断言配置细节。04 §4.4 规则 5 已允许 `when` 直接引用非密钥的 `envfile.<module>.<KEY>`（例如 `when: envfile.audit.CLOUDTRAIL_MANAGED == 'true'`），第 2 轮经派生变量中转的写法不再需要（附 B-20）。本会话一定会创建的模块栈资源（规则、主题、策略）照常带 `ownership: { mode: session }`。
- **手工资源的归属**：学员在控制台或 CLI 中创建、又要被检查认领的资源（例如 compliance 的金丝雀安全组、audit 场景 2 的无害 SSM 参数），按 04 §5.2.4 先查栈成员与 02 台账，查不到时由 02 的定向扫描（CloudTrail 事件历史 `LookupEvents`，不需要 trail；全局服务的事件在 us-east-1 查询）补齐。事件历史有分钟级投递延迟（以官方文档为准），这类检查第一次常为 `OWNERSHIP_PENDING`，按 04 §5.2.4 的间隔等待与重试（裁决 C4(e)）。
- **预期中断**：会有意中断平台管理通道的步骤（monitoring 的“停实例”、ami 的替换实例）声明 `expectedOutage`（04 §3.2.8），窗口内的 `CHANNEL_DOWN` 显示为“预期中断”，02 的巡检也据此不把它当作“环境被改动”。

### 5. 检查的写法

步骤大纲中的检查写成“**类型**：判定要点”，类型为 04 §5 的 6 种：`capability`、`local`（括号内是 ATL-RunCheck 的 `checkId`）、`http-header`（括号内是 `from` 与 `target`）、`aws-readonly`（括号内是 `service:Action`，`action` 写 SDK 操作名，04 §5.7）、`experiment`、`manual`。

- **“正常”的判定**：capability 检查中的“`status=ok`”一律按 04 §5.3 的 `op: healthy` 实现——`status=ok`，或 `degraded` 只由本卡 `expectedWarnings` 中的规则导致，且 `validation.errors` 为空。C3 之后本批卡片不应再出现 CRED-004。订阅未确认、首轮评估或首轮覆盖未完成这类**没有规则 ID** 的 `degraded` 不算正常：等待型的用 `pendingIf`；会话内等不到、设计上就会持续的（cost 的“标签尚未生效”、workflow 的“最近 1 小时有故意制造的失败执行”）用 `anyOf` 显式允许，并写明 detail 关键词。
- 第 2 轮标 **⚠** 的 `aws-readonly` 动作（config、inspector2、states、imagebuilder、`ec2:DescribeImages`、`ssm:DescribeSessions`、`ce:ListCostAllocationTags`、`budgets:DescribeBudgetActionsForBudget`）已由 04 §5.7 收录，标记已删除，相应的“带证据的手动确认”改回自动判定。
- **before 状态一律 `once`**（裁决 C3，04 §3.5 第 9 条）：描述起始状态或中间档的检查（目标模块的 `driver` 仍是本地值、`status=off`、tracing 的 `local` 档、db-proxy 的 `pgbouncer` 档、cost 的本地估算等）必须写 `drift: { policy: once }`，否则后续步骤改变它们后最终复核会判为漂移。下文第 1 步“观察”中的检查都属于这一类。其余未注明时，`aws-readonly`、`capability`、`local`、`http-header` 检查为 `must-hold`；`experiment`、`manual` 为 `once`（04 §5.8）。
- `aws-readonly` 检查默认带 `ownership: { mode: session }`；起始状态创建的资源用 `session-or-start`；只读接入的账号级单例不带 `ownership`（第 4 节）。
- 对比实验用 `npm run exp -- <模块> <实验 id> --label <变体> --upload`；变体在 `experiments[].labels` 中声明，结果中标注 `variant`（04 §3.2.10，裁决 C5）。

---

<a id="svc-shell-access"></a>

## svc-shell-access：AWS Systems Manager Session Manager：运维登录

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-shell-access` |
| kind | `service` |
| 标题 | AWS Systems Manager Session Manager：运维登录 |
| 一句话简介 | 把运维登录从“SSH 22 + 密钥对”换成 Session Manager：安全组零管理端口入站，用 IAM 身份登录和端口转发，会话里的命令写进 CloudWatch Logs。 |
| 涉及的 AWS 服务 | AWS Systems Manager Session Manager（主）；Amazon CloudWatch Logs（会话日志）；Amazon EC2 与安全组、AWS IAM 实例角色（辅助）；AWS CloudTrail Event History（观察 `StartSession`） |
| 对应的模块 | `shell-access`（[05#shell-access](../../modules/05-ops-observability.md#shell-access)） |
| 难度 | 初级（`beginner`） |
| 预计时长 | 60 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表：L0 + iam(role)（裁决 C3；iam 同时是 DEP-001 的硬依赖），档位 `atl/svc-shell-access/default`；SSH 基线由 `workstation.sshFromWorkstation: true` 打开 |
| 目标模块 | `shell-access` → `SHELL_ACCESS_MODE=ssm`（默认不保留 22 端口，`KeepSsh=false`） |
| 费用档位与主要计费来源 | **低**：实验机与工作台的 EC2、EBS、公网 IPv4；会话日志的 CloudWatch Logs 摄取与存储（量极小）。Session Manager 对 EC2 实例不额外收费（以官方定价为准）；本卡不创建 Interface Endpoint |
| 人工前置 | 无 |
| SAA 考试领域 | 安全（secure） |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`（软依赖） |
| 起始部署等级 | A（02 §11.1：只有 L0 与“快”类模块） |
| 完成徽章 | 「零入站运维」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | 实验机、EBS 数据卷、弹性 IP；平台模式下实例配置文件只含平台管理通道 |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3，`basis: credential`）；同时是硬依赖 DEP-001（必须是 role） | SSM Agent 使用实例配置文件（或账号级 DHMC）的凭证，不读应用的 `IAM_KEYS_*`；平台模式下 iam 栈为 `AppRoleMode=existing`（01 §9.6），只附加自己的只读策略 |
| 基础栈参数 `SshIngressCidr` | 工作台**私网** IP/32（由 `workstation.sshFromWorkstation: true` 驱动运行器设置，不用占位符） | 对比基线 | “没有 Session Manager”的一侧需要一条可用的 SSH 22 通道。工作台与实验机同在默认 VPC，`ssh lab` 经 `atl-lab-proxy` 走私网地址（02 §4.3、03 §4.4、§4.8）；会话密钥对的私钥由 `ATL-WorkstationSetup` 写到工作台（03 §4.6），只在工作台上 |

不预置任何软依赖（logging、kms）：会话日志组由本模块自建，不需要 logging。

### 实验简介

**背景**：CloudAlbum 出了问题，你要登录 EC2 排障。L0 的做法是 SSH：安全组为运维 IP 开放 22 端口，私钥要分发、轮换、防丢；事后只知道“哪把公钥从哪个 IP 登录过”，不知道登录后做了什么。平台模式下实验机的 SSM Agent 已经因为“平台管理通道”在线，所以本卡比较的不是“有没有 SSM Agent”，而是**运维者通过哪条路登录、谁能登录、事后能不能追溯**。

**你将学到**

- SSM 托管节点的三个前提：SSM Agent、实例配置文件（或 DHMC）、到 `ssm` / `ssmmessages` 端点的出站通路。
- 安全组没有任何入站规则也能登录：连接由 Agent 主动向外建立，安全组有状态，回包自动放行。
- 会话首选项中的 `runAs` 与受限 sudoers：默认的 `ssm-user` 和 AL2023 的 `ec2-user` 都有免密 sudo，降权要靠专用用户。
- 用端口转发访问实例上的服务，取代“临时开放 3000 / 5432 端口”或堡垒机。
- 审计链：CloudTrail 的 `StartSession`（谁、何时）+ 会话日志（执行了什么）。
- `AmazonSSMManagedInstanceCore` 与最小权限策略的取舍。

**实验资源**

- **实验机**（L0 + iam）：22 端口只对工作台私网地址 /32 开放；sshd 已按 05 §1 加固（禁止密码与 root 登录）。
- **工作台**：AWS CLI v2、session-manager-plugin、SSH 私钥、`scripts/module` 与 `npm run exp`。
- **你将创建**：shell-access 栈（实例策略 `PolicyArn`、会话日志组 `/cloudalbum/<env>/ssm-sessions`、运维者策略 `cloudalbum-<env>-operator-session`）；实例上的用户 `cloudalbum-ops` 与 sudoers 片段；对区域级单例 `SSM-SessionManagerRunShell` 的修改（脚本先备份到 `state.json`）；基础栈更新（删除 22 规则）。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察起始状态：22 对工作台开放，SSM Agent 已因平台管理通道 Online；区分“平台通道”与“运维通道” | 观察 | `capability`：shell-access `driver=ssh`、`status=off`；`local`（`sshd-state`）：`active=true`、`port22Listening=true`、`passwordAuth=false`；`aws-readonly`（`ec2:DescribeSecurityGroupRules`，实例安全组）：存在覆盖 22 的入站规则且来源是 /32，不存在 `0.0.0.0/0`（三项都描述起始状态，`drift: once`） |
| 2 | 记录 before：从工作台探测实验机**私网地址**的 22 端口，并用 `ssh lab` 登录一次 | 对比实验 | `experiment`：`shell-access/probe-port` 的 before 有效（22 为 open） |
| 3 | 接入：`scripts/module enable shell-access --dry-run` 预览，再正式执行（建 `cloudalbum-ops` 与受限 sudoers、写会话首选项、删除 22 规则） | 脚本（wire） | `capability`：`driver=ssm`、`status=ok`，detail 含“无管理端口入站”；`local`（`module-state`）：shell-access 已启用；`aws-readonly`（`ec2:DescribeSecurityGroupRules`）：没有任何覆盖 22 的入站规则，也没有协议为“全部流量”（`-1`）的入站规则；`aws-readonly`（`logs:DescribeLogGroups`）：会话日志组存在且设置了保留期 |
| 4 | 在工作台用 `aws ssm start-session --target <实验机>` 登录（不带 `--document-name`，即默认文档）：`id` 应为 `cloudalbum-ops`；`sudo systemctl status cloudalbum-api` 允许、读取 `secrets.env` 被拒绝 | CLI | `aws-readonly`（`cloudtrail:LookupEvents`，`EventName=StartSession`）：存在用户名以 `atl-<sid>-ws` 开头的事件；事件内容含本实验机 ID 为辅助断言（`warn`）（等待型，最长 20 分钟）；`manual`（带证据）：粘贴命令输出，断言含 `cloudalbum-ops` 且读取机密的返回码非 0（学员自报，可信度低，只作手动确认） |
| 5 | 端口转发：本机 13000 → 实验机 127.0.0.1:3000，访问 `/api/health/ready` | CLI | `manual`（带证据）：粘贴 `curl` 输出，断言 HTTP 状态码为 200 |
| 6 | 记录 after：再次从工作台探测私网地址的 22 端口 | 对比实验 | `experiment`：`shell-access/probe-port` 的 pair 有效（before open，after 超时） |
| 7 | 对齐审计链：会话历史、会话日志、`StartSession` 按会话 ID 对齐 | 对比实验 | `aws-readonly`（`logs:DescribeLogStreams`，前缀 `atl-<sid>-ws`）：至少一个日志流；`experiment`：`shell-access/session-audit` 的 after 有效 |

**最终复核**（`finalChecks`）：实验机安全组没有对 `0.0.0.0/0` 开放 22（`_shared` 的 `no-world-ssh`）；shell-access 为 `ok`；安全组没有任何覆盖 22 的入站规则。

### 对比实验

引用 [05#shell-access §5](../../modules/05-ops-observability.md#shell-access)（`experiments/shell-access/`）。

| 场景 | 标签 | 本卡 | 没有它（SSH 基线） | 有它（Session Manager） |
|---|---|---|---|---|
| `probe-port` | before / after | 必需 | 从工作台探测实验机私网地址的 22 为 open | 超时（filtered）；443 不受影响 |
| `session-audit` | after | 必需 | 只能从 journal 看到“公钥指纹 + 来源 IP”，无法回答“谁执行了什么命令” | 会话 ID ↔ 会话日志（命令与输出）↔ `StartSession`（IAM 身份 `atl-<sid>-ws`、时间） |
| `ssh-noise` | — | 不纳入 | 需要观察 24 小时，并临时对 `0.0.0.0/0` 开放 22，超出卡片时长且违反最终复核的安全底线 | — |
| `private-subnet` | — | 不纳入 | 需要 network(private) 与 `ssm`、`ssmmessages` 端点 | 移到组合场景 `sc-private-network` |

观察点（05 §5 对照表）：管理端口入站从“22 ← 工作台 /32”变为“无”；需要分发轮换的长期凭证从“SSH 私钥”变为 0；授权从“有私钥就能登录”变为“IAM 策略 + 资源标签条件”；登录审计从 journal 变为 CloudTrail；新增命令级审计；建立会话比 SSH 稍慢（秒级以内）。

`session-audit` 调用 `DescribeSessions` 时必须排除平台终端会话（文档 `ATL-SessionShell*`、会话 ID 前缀 `atl-<sid>-term-`，03 §3.3），只统计会话 ID 前缀为 `atl-<sid>-ws-` 的学员会话，否则“已有会话”会因平台终端而直接成立。

**平台模式下的 `probe-port`**：SSH 基线只放行工作台私网地址，模块文档中“探测 `<EIP>:22`”在平台模式下 before 就会超时（同一 VPC 内经公网地址互访时，对端看到的源地址是工作台的公网 IP，03 §4.8），所以本卡的探测目标是 `{{ target.privateIp }}`（需要 `probe-port.ts` 支持 `--target private-ip`，列入 06，见附 B-5）。从平台外部探测 EIP 的 22 端口，before 与 after 都是超时，与原 05 lab-02 的结论一致：在平台模式下“对公网关闭”一开始就成立，本卡的变化是“连运维机也不再需要 22 端口与私钥”。

### 小测

1. （单选）公司要求运维人员登录私有子网中的 EC2 实例，不得开放任何入站端口、不分发 SSH 密钥，并且要记录会话中执行的命令。最合适的方案是：
   A. 在公有子网部署堡垒机，安全组只放行公司出口 IP 的 22 端口
   B. 为实例配置带 SSM 托管节点权限的实例角色，创建 `ssm`、`ssmmessages` 接口端点，使用 Session Manager 并把会话日志写入 CloudWatch Logs 或 S3
   C. 使用浏览器方式的 EC2 Instance Connect
   D. 在安全组中开放 22 端口，用 CloudTrail 记录登录后执行的命令

   **答案**：B。**解析**：Session Manager 由 Agent 主动出站建立通道，安全组无需入站规则，身份来自 IAM，会话日志记录命令与输出。A 需要入站端口和密钥；C 需要 22 端口对 Instance Connect 的服务地址段开放；D 错在 CloudTrail 只记录 AWS API 调用，不记录操作系统内执行的命令。

2. （多选，选三项）要让 EC2 实例成为 SSM 托管节点并能打开 Session Manager 会话，必须满足哪些条件？
   A. 实例上运行 SSM Agent
   B. 实例有带 SSM 托管节点权限的 IAM 角色（或启用了默认主机管理配置）
   C. 实例能以 HTTPS 访问 `ssm` 与 `ssmmessages` 端点（经 NAT 或接口端点）
   D. 安全组放行来自 Systems Manager 服务的 443 入站
   E. 实例必须有公网 IPv4 地址

   **答案**：A、B、C。**解析**：所有连接都由实例上的 Agent 发起，安全组有状态，回包自动放行，所以不需要任何入站规则（D 错）；私有子网实例经 NAT 或接口端点即可（E 错）。

3. （单选）开发者需要从笔记本临时访问私有子网中的 RDS for PostgreSQL 排障，要求不把数据库暴露到公网、不新建堡垒机。最佳做法是：
   A. 把 RDS 改为可公开访问，并在安全组中只放行开发者 IP
   B. 通过 Session Manager 的 `AWS-StartPortForwardingSessionToRemoteHost`，经同一 VPC 中的托管实例把本地端口转发到 RDS 端点
   C. 建立 Site-to-Site VPN
   D. 在 RDS 实例上安装 SSM Agent

   **答案**：B。**解析**：端口转发到远程主机让托管实例充当跳板，数据库安全组只需放行该实例；A 增加暴露面；C 运维成本高、属于长期网络方案；D 不可行，RDS 是托管服务，不能安装代理。

### 清理说明

- 自动回收先由运行器执行 `scripts/module disable shell-access` 的等价流程：按备份**还原** `SSM-SessionManagerRunShell`、删除 `cloudalbum-ops` 与 sudoers 片段、分离策略、删除栈；运行器失败时由回收器 S6 阶段的“共享对象复位”兜底（02 §7.5）。会话日志组是 `DeletionPolicy: Retain`，回收器按 `RETAINED` 来源删除（02 §7.1）。
- `SSM-SessionManagerRunShell` 是**账号 × 区域级单例**，影响同区域所有使用默认文档的会话。不要在控制台的 Session Manager“首选项”页手工修改它；如果改过，回收只会还原到脚本备份的版本，结束前在报告的“清理”一节确认已还原。模块修改前把原值（或“原本不存在”）备份到环境状态桶的 `<envName>/backups/`（`cloudalbum-lab-state-<acct>-<region>`，01 §3.11；06 PM-27、PM-M28），运行器失败时回收器也能读到它兜底复位（附 B-6 已解决）。
- 如果为了排障临时在安全组加过 22 规则，结束前删除（最终复核会检查）。
- 端口转发会话在工作台按 Ctrl+C 结束；用默认文档打开的 shell 会话空闲 20 分钟会自动断开（会话首选项 `idleSessionTimeout`）。端口转发使用 AWS 自有文档 `AWS-StartPortForwardingSession`，是否受这份首选项约束以官方文档为准，结束前自己关掉。

### 对应 SAA 考点

- Session Manager、堡垒机、EC2 Instance Connect、EC2 Instance Connect Endpoint 的对比：谁需要 22 端口、谁需要公网 IP、各自怎么审计。
- SSM 托管节点的三个前提；最小暴露面：零入站规则、安全组有状态。
- 私有子网访问 AWS 服务：NAT Gateway 与 Interface Endpoint（PrivateLink）；Session Manager 需要的端点（为 `sc-private-network` 铺垫）。
- 会话日志（S3 / CloudWatch Logs）+ CloudTrail `StartSession` 构成审计链。
- 用 IAM 条件键（`ssm:resourceTag/*`）控制谁能登录哪些实例；按 Session 文档控制能否做端口转发。
- Systems Manager 家族的分工：Session Manager、Run Command、Patch Manager、Parameter Store、State Manager。
- AWS 托管策略（`AmazonSSMManagedInstanceCore`）与客户托管最小权限策略的取舍。

<a id="svc-shell-access-labyaml"></a>

### 附：完整 lab.yaml 示例（`labs/svc-shell-access/lab.yaml`）

按 04 §3 的 `atl.lab/v2` 书写（字段名以 04 为准；第 2 轮本批自拟的写法见“本批约定”§1 的对照表）。注释只说明与本卡有关的取舍。

```yaml
schema: atl.lab/v2
id: svc-shell-access
kind: service
service: AWS Systems Manager Session Manager
function: 运维登录
title: AWS Systems Manager Session Manager：运维登录      # title = service + "：" + function，≤ 48 字
version: 1.0.0
status: beta
subtitle: SSH 22 + 密钥对 → IAM 身份登录、零入站端口、命令级审计
summary: 把实验机的运维登录从 SSH 22 换成 Session Manager：安全组不再有管理端口入站，用 IAM 身份登录与端口转发，会话命令写进 CloudWatch Logs，并能与 CloudTrail 的 StartSession 对上。
story: |
  凌晨三点 CloudAlbum 报错，你得登录 EC2 看日志。安全组里那条“22 ← 运维 IP”因为换网络改了好几次，
  私钥也拷到过别人的电脑上；事后只能查到“某把钥匙从某个 IP 登录过”，登录后做了什么，没人说得清。
objectives:
  - { text: 说出 SSM 托管节点的三个前提, domain: secure, relatesTo: orient }
  - { text: 在安全组零入站的情况下登录实例并做端口转发, domain: secure, relatesTo: session }
  - { text: 用 CloudTrail 与会话日志回答“谁在何时执行了什么命令”, domain: secure, relatesTo: audit-chain }
  - { text: 区分 Session Manager、堡垒机与 EC2 Instance Connect, domain: secure, relatesTo: after }
difficulty: beginner                        # 初级（intro | beginner | intermediate | advanced）
estimatedMinutes: 60
timeLimitMinutes: 90
extensions: { maxCount: 2, minutesEach: 30 }
retain: { allowed: false }                  # 会话首选项是区域级单例，保留环境会持续影响同区域其他会话（说明写在手册里）
regions:
  supported: [ap-northeast-1]
services:                                   # id 取分类法（05 taxonomy）
  - { id: ssm-session-manager, name: AWS Systems Manager Session Manager, role: primary, module: shell-access }   # 服务格 id 以 05 §8.2 为准（05 D-16）
  - { id: cloudwatch-logs, name: Amazon CloudWatch Logs（会话日志）, role: supporting, featureOf: shell-access }
  - { id: ec2, name: Amazon EC2（实验机与安全组）, role: supporting, module: ec2 }
  - { id: iam, name: AWS IAM（实例角色）, role: context, module: iam }   # 裁决 C3 预置，不计入掌握度
  - { id: cloudtrail, name: AWS CloudTrail Event History, role: observed }
modules: { target: [shell-access], start: [iam], context: [], related: [network, threat-detection, compliance, vuln-scan] }
prerequisites:
  cards: [ { id: svc-ec2, kind: soft }, { id: svc-iam, kind: soft } ]
  learnerInputs: []
  knowledge: [SSH 密钥对登录, 安全组是有状态的]

startProfile:                               # 与 plan --start-of svc-shell-access 的输出逐项相同（04 DRV-1）
  provisions:
    - { item: iam, kind: module, basis: credential, set: { IAM_CREDENTIALS: role },
        reason: 平台为每张卡片预置实例角色（裁决 C3）；Session Manager 也要求 role（DEP-001），SSM Agent 用实例配置文件凭证，不读应用的访问密钥 }
    - { item: mgmt-channel, kind: platform,
        reason: 实验机从 L0 起只挂 AmazonSSMManagedInstanceCore（平台管理通道），SSM Agent 一开始就在线 }
    - { item: ssh-from-workstation, kind: platform,
        reason: SSH 基线——运行器按 03 §4.8 把 SshIngressCidr 设为工作台私网 IP/32，ssh lab 走私网 }
    - { item: preview-direct-https, kind: platform, reason: 预览使用 Let's Encrypt IP 证书 }
  platform: { preview: { directHttps: 'on' } }
  reason: L0 + iam(role)；shell-access 没有其他硬依赖，不预置软依赖 logging、kms

targetModules:
  - { id: shell-access, driver: ssm, params: { KeepSsh: false }, wireStep: wire }
expectedWarnings: []                        # C3 之后不再有 CRED-004
workstation:
  required: true
  sshFromWorkstation: true                  # 运行器把 SshIngressCidr 设为工作台私网 IP/32（03 §4.8）
  tools: [aws-cli, node, jq, session-manager-plugin]
  savingsMode: unsupported                  # SSH 基线与 probe-port 都要从工作台发起（03 §4.9）
variables: {}

cost:
  tier: low
  mainDrivers: [会话日志的 CloudWatch Logs 摄取与存储（量极小）]
  currency: USD
  basis:
    - { ref: start-profile, note: 实验机 EC2、EBS（根卷与数据卷）、公网 IPv4；iam 不计费 }
    - { ref: workstation, note: 工作台 EC2、EBS、公网 IPv4 }
    - { key: session-logs, pricingKey: logs.ingest.standard, billing: usage, quantity: 1, unit: GB,
        assumedUsagePerHour: 0.001, source: target, whenRetained: false, note: 会话日志量极小 }
  assumptions:
    - Session Manager 对 EC2 实例不额外收费（以官方定价为准）
    - 本卡不创建 Interface Endpoint；私有子网场景见 sc-private-network
provision: { class: A }                     # 02 §11.1：只有 L0 与“快”类模块

steps:
  - id: orient
    type: observe
    title: 观察起始状态：22 对工作台开放，SSM Agent 已因平台管理通道在线
    manual: manual/10-orient.md
    estMinutes: 5
    checks: [cap-ssh-baseline, sshd-listening, sg-22-workstation-only]   # 都是 before 状态，drift: once
  - id: baseline
    type: experiment
    title: 记录 before：从工作台探测私网地址的 22 端口并用 SSH 登录
    manual: manual/20-baseline.md
    experiment: { module: shell-access, id: probe-port, label: before }
    estMinutes: 6
    checks: [exp-probe-before]
  - id: wire
    type: script
    wire: true
    title: 接入：enable shell-access（关闭 22 端口、写入会话首选项）
    manual: manual/30-wire.md
    methods: [script]
    estMinutes: 10
    wait: { typicalMinutes: 3, maxMinutes: 10, text: 脚本先确认 Agent Online 并做 send-command 冒烟，再删除 22 规则 }
    checks: [cap-ssm-ok, module-state-ssm, sg-no-22, session-log-group]
  - id: session
    type: cli
    title: 用 Session Manager 登录：验证 runAs 用户与受限 sudo
    manual: manual/40-session.md
    requires: { steps: [wire] }
    panel: terminal-workstation
    estMinutes: 8
    checks: [start-session-trailed, runas-ops]
  - id: port-forward
    type: cli
    title: 端口转发：不开放 3000 也能在工作台访问应用
    manual: manual/50-port-forward.md
    requires: { steps: [wire] }
    estMinutes: 5
    checks: [port-forward-ok]
  - id: after
    type: experiment
    title: 记录 after：再次从工作台探测 22 端口
    manual: manual/60-after.md
    experiment: { module: shell-access, id: probe-port, label: after }
    requires: { steps: [wire] }
    estMinutes: 5
    checks: [exp-probe-pair]
  - id: audit-chain
    type: experiment
    title: 对齐审计链：会话历史、会话日志与 StartSession
    manual: manual/70-audit-chain.md
    experiment: { module: shell-access, id: session-audit, label: after }
    requires: { steps: [session] }
    estMinutes: 8
    wait: { typicalMinutes: 5, maxMinutes: 20, text: CloudTrail 事件有分钟级延迟，脚本会轮询 }
    checks: [session-logged, exp-session-audit]

finalChecks:
  - { ref: no-world-ssh }                   # labs/_shared/checks：安全组没有对 0.0.0.0/0 开放 22（04 K-8 的共享检查名）
  - { ref: cap-ssm-ok, as: final-cap-ssm-ok }
  - { ref: sg-no-22, as: final-sg-no-22 }

experiments:
  - module: shell-access
    id: probe-port
    labels:
      - { id: before, role: baseline }
      - { id: after, role: treatment }
    required: true
    runner: workstation
    allowSimulatedBaseline: false
    validity: functional                    # 端口探测不产生可按 runId 归属的业务请求
    corroborateWith: [sg-22-workstation-only, sg-no-22]
  - module: shell-access
    id: session-audit
    labels: [ { id: after, role: single } ]
    required: true
    runner: workstation
    validity: functional
    corroborateWith: [session-logged]

quiz: { file: quiz.yaml, draw: 3 }          # 成绩只记录在徽章上，不影响完成（裁决 C3）
badge: { title: 零入站运维, icon: assets/badge.svg }
tracks: [saa-main, secure, operations]      # 与 labs/_tracks/ 的实际包含关系一致（labs:fix 可改写）
certificate: { enabled: false }             # 卡片不发证书，证书由学习路径颁发

cleanup:
  summary: 结束后平台会还原 Session Manager 会话首选项、删除 cloudalbum-ops 用户与 shell-access 栈，并删除会话日志组。会话首选项是区域级单例，请不要在控制台手工修改它。
  autoReclaim: true
  dataRisk: [没有业务数据；会话日志随会话删除，报告中保留证据摘要]
  learnerCreatedHints:
    - { resourceType: 'AWS::SSM::Document', how: SSM-SessionManagerRunShell 不删除，按环境状态桶 <envName>/backups/ 中的原值还原 }
    - { resourceType: 'AWS::Logs::LogGroup', how: 会话日志组 DeletionPolicy=Retain，回收器按 RETAINED 来源删除（02 §7.1） }
  verify: [shell-access-stack-gone]

saa:
  domains: [secure]
  topics:
    - { id: ssm-managed-node, title: SSM 托管节点的三个前提, domain: secure, relatesTo: orient }
    - { id: zero-inbound, title: 零入站规则也能管理实例（出站通道 + 有状态安全组）, domain: secure, relatesTo: wire }
    - { id: session-audit-chain, title: 会话日志与 StartSession 构成审计链, domain: secure, relatesTo: audit-chain }
    - { id: port-forward, title: 端口转发访问私有资源，取代堡垒机, domain: secure, relatesTo: port-forward }
    - { id: managed-vs-least, title: AmazonSSMManagedInstanceCore 与最小权限, domain: secure, relatesTo: wire }
  confusables:
    - { a: Session Manager, b: EC2 Instance Connect, rule: 前者不需要入站 22 与公网 IP；后者浏览器方式需要 22 对服务地址段开放 }
    - { a: Session Manager, b: 堡垒机, rule: 堡垒机本身要开放入站并管理密钥；Session Manager 用 IAM 授权与出站通道 }
    - { a: CloudTrail StartSession, b: 会话日志, rule: CloudTrail 记录谁开了会话；会话中执行的命令只在会话日志里 }
tags: [shell-access, ssm, session-manager, least-privilege, audit]

permissions:
  learner:
    - ssm:StartSession
    - ssm:TerminateSession
    - ssm:ResumeSession
    - ssm:DescribeSessions
    - ssm:GetConnectionStatus
    - ssm:DescribeInstanceInformation
    - ssm:SendCommand                       # 工作台上 scripts/module 的投递（文档限定 AWS-RunShellScript，由 01 的边界条件限定）
    - ssm:GetCommandInvocation
    - ssm:GetDocument                       # 会话首选项的读取与更新
    - ssm:UpdateDocument
    - ssm:UpdateDocumentDefaultVersion
    - ssm:CreateDocument
    - logs:DescribeLogStreams
    - logs:GetLogEvents                     # 学员自己查看会话日志；验证角色不授予
    - cloudtrail:LookupEvents
    - ec2:DescribeSecurityGroupRules
    - ec2:DescribeInstances
    - cloudformation:CreateChangeSet
    - cloudformation:ExecuteChangeSet
    - cloudformation:DescribeChangeSet
    - cloudformation:DescribeStacks
    - iam:AttachRolePolicy                  # 只限 CloudAlbumAppRole 与 cloudalbum-* 策略（01 §6.6 的条件）
    - iam:DetachRolePolicy
    - s3:GetObject                          # scripts/module 读写环境状态桶 cloudalbum-lab-state-<acct>-<region>/<envName>/（01 §3.11）
    - s3:PutObject
    - dynamodb:PutItem                      # 环境操作锁 cloudalbum-lab-locks（条件写）
    - dynamodb:DeleteItem                   # 状态桶与锁表的具体操作以 06 的实现为准
  notes: 运维者策略 cloudalbum-<env>-operator-session 由栈输出，平台模式下不挂到 ATLLearnerRole；学员身份的会话权限来自 ATLLearnerRole 本身

platform:
  consoleLinks: [ec2.securityGroup, ssm.sessions, logs.group]
  accountImpact:
    - { id: ssm-session-prefs, scope: region, resource: SSM-SessionManagerRunShell, preexisting: not-applicable, revert: restore,
        note: 模块修改前把原值（或“原本不存在”）备份到环境状态桶的 <envName>/backups/（06 PM-M28），回收时还原；运行器失败时由回收器 S6 兜底复位（02 §7.5） }
# 本卡没有平台动作：省略 platformOps

owners: [cloudalbum-maintainers]
```

本卡专属检查的节选（`labs/svc-shell-access/checks/shell-access.yaml`；字段以 04 §5.1 为准）：

```yaml
checks:
  - id: cap-ssh-baseline
    title: 起始状态：运维通道仍是 SSH，shell-access 未启用
    type: capability
    module: shell-access
    assert:
      - { path: '$.driver', op: eq, value: ssh }
      - { path: '$.status', op: eq, value: off }
    drift: { policy: once }                 # before 状态一律 once（裁决 C3，04 §3.5 第 9 条）

  - id: sg-22-workstation-only
    title: 实例安全组的 22 端口只对工作台 /32 开放
    type: aws-readonly
    service: ec2
    action: DescribeSecurityGroupRules
    params: { Filters: [ { Name: group-id, Values: ['{{ target.sgId }}'] } ] }
    assert:
      - { path: '$.SecurityGroupRules[*]', where: { IsEgress: false, FromPort: { op: lte, value: 22 }, ToPort: { op: gte, value: 22 } },
          op: len_gte, value: 1, label: 存在覆盖 22 的入站规则 }
      - { path: '$.SecurityGroupRules[*]', where: { IsEgress: false, FromPort: { op: lte, value: 22 }, ToPort: { op: gte, value: 22 } },
          op: every, value: { CidrIpv4: { op: endsWith, value: '/32' } }, label: 覆盖 22 的规则来源都是 /32 }
      - { path: '$.SecurityGroupRules[*].CidrIpv4', op: nin, value: ['0.0.0.0/0'], label: 没有对全网开放 }
    drift: { policy: once }                 # 第 3 步会删除这条规则，起始状态的事实只需成立一次
    ownership: { mode: session-or-start }
    manualFallback: { where: EC2 控制台 → 安全组 → 入站规则, confirm: 22 端口来源为 x.x.x.x/32 }
    reproduce: { run: "aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ target.sgId }}", runsOn: workstation }

  - id: sg-no-22
    title: 安全组没有任何覆盖 22 的入站规则
    type: aws-readonly
    service: ec2
    action: DescribeSecurityGroupRules
    params: { Filters: [ { Name: group-id, Values: ['{{ target.sgId }}'] } ] }
    assert:
      - { path: '$.SecurityGroupRules[*]', where: { IsEgress: false, FromPort: { op: lte, value: 22 }, ToPort: { op: gte, value: 22 } },
          op: len_eq, value: 0, label: 22 端口无入站 }
      - { path: '$.SecurityGroupRules[*]', where: { IsEgress: false, IpProtocol: '-1' },
          op: len_eq, value: 0, label: 没有“全部流量”入站规则 }   # 协议为 -1 的规则 FromPort/ToPort 都是 -1，上一条断言匹配不到，却同样放开了 22
    drift: { policy: must-hold, monitor: true }
    ownership: { mode: session-or-start }
    manualFallback: { where: EC2 控制台 → 安全组 → 入站规则, confirm: 没有 22 端口的规则 }
    reproduce: { run: "aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ target.sgId }}", runsOn: workstation }
    saaDomain: secure

  - id: cap-ssm-ok
    title: 应用确认运维通道已是 Session Manager 且无管理端口入站
    type: capability
    module: shell-access
    assert:
      - { path: '$.driver', op: eq, value: ssm }
      - { path: '$', op: healthy }          # 04 §5.3：ok，或只由本卡 expectedWarnings 导致的 degraded（本卡为空）
      - { path: '$.detail', op: contains, value: 无管理端口入站 }
    drift: { policy: must-hold, monitor: true }

  - id: module-state-ssm
    title: 实验机上 shell-access 已启用（平台模式下投递通道始终是 SSM，不作为判据）
    type: local
    checkId: module-state
    assert:
      - { path: '$.enabled', op: contains, value: shell-access }

  - id: start-session-trailed
    title: CloudTrail 记录了你从工作台发起的 StartSession
    type: aws-readonly
    service: cloudtrail
    action: LookupEvents
    params: { LookupAttributes: [ { AttributeKey: EventName, AttributeValue: StartSession } ], MaxResults: 50 }
    wait: { typicalMinutes: 5, maxMinutes: 20 }
    drift: { policy: once }
    pendingIf:
      - { path: '$.Events[*]', where: { Username: { op: startsWith, value: 'atl-{{ session.id }}-ws' } }, op: len_eq, value: 0 }
    assert:
      - { path: '$.Events[*]', where: { Username: { op: startsWith, value: 'atl-{{ session.id }}-ws' } }, op: len_gte, value: 1, label: 发起者是你的工作台会话 }
      - { path: '$.Events[*].CloudTrailEvent', op: some, value: { op: contains, value: '{{ target.instanceId }}' }, label: 目标是本实验机,
          severity: warn }                  # 实例 ID 在事件的 requestParameters.target 中；LookupEvents 的 Resources 是否填充实例以实测为准，所以只作辅助断言
    manualFallback: { where: CloudTrail 控制台 → 事件历史 → 事件名称 StartSession, confirm: 用户名为 atl-…-ws 的事件 }
    reproduce: { run: "aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StartSession --max-results 5", runsOn: workstation }
    saaDomain: secure

  - id: session-logged
    title: 会话日志组中有你的会话日志流
    type: aws-readonly
    service: logs
    action: DescribeLogStreams
    params: { logGroupName: '/cloudalbum/{{ session.env }}/ssm-sessions', logStreamNamePrefix: 'atl-{{ session.id }}-ws' }   # 日志流名 = 会话 ID，前缀为发起者的会话名（以实测为准，07）
    wait: { typicalMinutes: 1, maxMinutes: 10 }
    assert: [ { path: '$.logStreams', op: len_gte, value: 1, label: 至少一个会话日志流 } ]
    manualFallback: { where: CloudWatch 控制台 → 日志组 /cloudalbum/<env>/ssm-sessions, confirm: 有以 atl-<sid>-ws 开头的日志流 }
    reproduce: { run: "aws logs describe-log-streams --log-group-name /cloudalbum/{{ session.env }}/ssm-sessions --log-stream-name-prefix atl-{{ session.id }}-ws", runsOn: workstation }

  - id: runas-ops
    title: 会话以 cloudalbum-ops 身份打开，读取 secrets.env 被拒绝
    type: manual
    spec:
      where: 工作台终端中用 aws ssm start-session 打开的会话
      confirm: 粘贴下面命令的输出
      evidence:
        command: "id; sudo -n cat /etc/cloudalbum/secrets.env >/dev/null 2>&1; echo rc=$?"
        assert:
          - { path: '$.text', op: contains, value: cloudalbum-ops }
          - { path: '$.text', op: matches, value: 'rc=[1-9]' }
```

其余检查从略：`sshd-listening`（local `sshd-state`：`active=true`、`port22Listening=true`、`passwordAuth=false`，`drift: once`）、`session-log-group`（aws-readonly `logs:DescribeLogGroups`：日志组存在且 `retentionInDays` 已设置）、`port-forward-ok`（manual 带证据：`curl -s -o /dev/null -w '%{http_code}' http://localhost:13000/api/health/ready` 输出 200）、`exp-probe-before` / `exp-probe-pair` / `exp-session-audit`（experiment）、`shell-access-stack-gone`（aws-readonly `cloudformation:DescribeStacks`，`expectError: ValidationError`，回收后执行）。

---

<a id="svc-logging"></a>

## svc-logging：Amazon CloudWatch Logs：集中日志

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-logging` |
| kind | `service` |
| 标题 | Amazon CloudWatch Logs：集中日志 |
| 一句话简介 | 把只躺在 EBS 文件里的日志批量送进 CloudWatch Logs：跨实例检索、Logs Insights 聚合、指标过滤器把日志变成指标。 |
| 涉及的 AWS 服务 | Amazon CloudWatch Logs（主）；Amazon CloudWatch 指标（指标过滤器的输出，辅助）；Amazon EC2、AWS IAM 实例角色（辅助） |
| 对应的模块 | `logging`（[05#logging](../../modules/05-ops-observability.md#logging)） |
| 难度 | 初级（`beginner`） |
| 预计时长 | 45 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表：L0 + iam(role) + 运行时热键 `lab.faults`，档位 `atl/svc-logging/default`（由 `plan --start-of` 推导） |
| 目标模块 | `logging` → `LOG_DRIVER=cloudwatch`（`Shipper=sdk`，`RetentionInDays=14`）；选做步骤切换为 `Shipper=agent` |
| 费用档位与主要计费来源 | **低**：日志摄取量（GB）、存储量（GB-月）与 Logs Insights 扫描量；调成 debug 级别会让摄取量明显上升。CloudWatch Agent 本身免费 |
| 人工前置 | 无 |
| SAA 考试领域 | 弹性（集中日志支撑可替换的实例）；安全（排障与留存） |
| 推荐的前置卡片 | `svc-iam`（软依赖）；后续 `svc-monitoring`、`sc-observability` |
| 起始部署等级 | A |
| 完成徽章 | 「日志不随实例消失」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | 日志写在数据卷 `/var/lib/cloudalbum/logs/`（`api.log`、`worker.log`、`audit.log`、`nginx-access.json`） |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；logging 本身也是 `credentials: required`（CRED-001） | 应用内发送器调用 `PutLogEvents`；选做的 agent 方式还要求必须是 role |
| 运行时热键 | `featureFlags['lab.faults']=true` | 运行时（v2 `startProfile.runtime`） | `query-compare` 要先用 `error5xx` 故障制造错误日志 |

### 实验简介

**背景**：L0 的日志只在 EBS 数据卷上，`/lab` 日志查看器在本机线性扫描当前文件和 `.1`；多实例时每台各看各的，Lambda 的日志根本不在本地。启用后应用把同一份结构化日志批量发送到 CloudWatch Logs，本地文件照写，可以回滚而没有数据缺口。

**你将学到**

- 日志组、日志流、保留期（默认永不过期）与日志类别。
- EC2 上的应用日志默认不会进入 CloudWatch Logs，需要 SDK 或 CloudWatch Agent；Lambda 日志会自动进入。
- 指标过滤器把日志变成指标，只对创建之后摄取的日志生效。
- Logs Insights（交互式查询、按扫描量计费）、订阅过滤器（近实时）、导出到 S3（批量）的区别。
- 摄取延迟：本地立即可见，CloudWatch 侧要等几秒到几十秒。

**实验资源**

- **实验机**（L0 + iam）：pino JSON 日志与 Nginx JSON 访问日志写在数据卷上；`/lab` 日志查看器只有“本地”页签。
- **工作台**：`npm run exp`（k6 负载与查询脚本）、AWS CLI。
- **你将创建**：logging 栈——日志组 `/cloudalbum/<env>/app` 与 `/cloudalbum/<env>/nginx`（保留 14 天）、指标过滤器 `AppErrors`、`Nginx5xx`、`AuthLoginFailed`（命名空间 `CloudAlbum/Logs`）、4 条保存的 Logs Insights 查询、实例策略 `PolicyArn`。
- **平台说明**：`/atl-recordings/terminal-sessions` 是平台终端的可选录制日志组（03 §3.3），不属于 CloudAlbum，本卡不使用。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察本地日志查看器：“本地文件 · 仅 i-…”；点击 requestId，在 Nginx 与 api 日志中找到同一个请求 | 观察 | `capability`：logging `driver=file`；`local`（`file-stat`，`/var/lib/cloudalbum/logs/api.log`）：存在、属主 `cloudalbum`、权限 0640；`manual`：记录一次本地查询的用时与扫描字节 |
| 2 | 记录 before：`error5xx` 故障 + 恒定负载，`query-compare` 只能跑本地一侧 | 对比实验 | `experiment`：`logging/query-compare` 的 before 有效 |
| 3 | 接入：`scripts/module enable logging --param RetentionInDays=14` | 脚本（wire） | `capability`：`driver=cloudwatch`、`status=ok`（detail 含最近一次探针测得的摄取延迟）；`local`（`module-state`）：logging 已启用；`aws-readonly`（`logs:DescribeLogGroups`，前缀 `/cloudalbum/<env>/`）：`app` 与 `nginx` 两个日志组存在，`retentionInDays=14`；`aws-readonly`（`logs:DescribeMetricFilters`）：`AppErrors` 存在，命名空间为 `CloudAlbum/Logs` |
| 4 | 记录 after：`ingest-lag`，20 个请求从完成到在 CloudWatch 可查的时间 | 对比实验 | `experiment`：`logging/ingest-lag` 的 after 有效 |
| 5 | 再次注入 5xx；在控制台 Logs Insights 运行保存的查询“按路由统计错误”，并找到指标过滤器生成的 `AppErrors` 指标 | 控制台 | `aws-readonly`（`cloudwatch:ListMetrics`，`CloudAlbum/Logs` / `AppErrors`）：至少 1 条（等待型，最长 10 分钟）；`manual`（带证据）：粘贴 Insights 的统计信息（匹配行数、扫描字节） |
| 6 | 记录 after：`query-compare` 在本地与 CloudWatch 两侧并排执行 | 对比实验 | `experiment`：`logging/query-compare` 的 pair 有效 |
| 7 | （选做）改用 agent 方式：`scripts/module enable logging --param Shipper=agent` | 脚本 | `local`（`systemd-unit`，`amazon-cloudwatch-agent`）：`active=true`；`capability`：`driver=cloudwatch`、`status=ok` |

**最终复核**：logging 为 `ok`；两个日志组都设置了保留期（不是“永不过期”）。

### 对比实验

引用 [05#logging §5](../../modules/05-ops-observability.md#logging)（`experiments/logging/`）。

| 场景 | 标签 | 本卡 | 没有它（本地文件） | 有它（CloudWatch Logs） |
|---|---|---|---|---|
| `ingest-lag` | after | 必需 | 立即可见，但只在本机 | 有秒级到数十秒的摄取延迟（sdk 方式取决于 `LOG_CW_FLUSH_MS`） |
| `query-compare` | before / after | 必需 | 线性扫描当前文件与 `.1`，耗时随文件大小增长，只覆盖本机最近两天 | `FilterLogEvents` 精确查找；Insights 聚合通常几秒返回，并报告扫描字节（计费依据） |
| `overhead` | after | 选做 | — | 发送器开销在 CPU 曲线上通常看不出差别 |
| `debug-volume` | after | 选做 | — | 把 `runtime.json` 的 `logLevel` 改为 debug 10 分钟，摄取量明显上升（费用感知） |
| `instance-loss` | — | 不纳入 | 单实例下用 `rebuild-instance` 模拟“旧实例没了”时，数据卷（含 `logs/`）会改挂到新实例，本地日志并不会丢，看不出差别 | 移到 `svc-autoscaling` / `sc-ha-web`：ASG 实例终止后本机文件随之消失，CloudWatch 中仍可查 |

观察点：数据源徽章从“本地文件 · 仅 i-0abc”变为“CloudWatch Logs · N 个实例”；多出“Logs Insights”页签与“错误数（指标过滤器）”小图；每次查询显示 engine、用时、扫描字节与覆盖实例数。

### 小测

1. （单选）Auto Scaling 组缩容后，被终止实例上的应用日志再也查不到。要求日志集中存放、实例终止后仍可查询，并能按字段聚合统计，运维开销最小的做法是：
   A. 每台实例定时把日志 rsync 到一个 EFS 文件系统
   B. 用 CloudWatch Agent（或应用内 SDK）把日志发送到 CloudWatch Logs，用 Logs Insights 查询
   C. 启用 CloudTrail 数据事件
   D. 定期为每台实例的 EBS 卷创建快照

   **答案**：B。**解析**：CloudWatch Logs 与实例生命周期解耦，Logs Insights 直接按字段聚合；A 需要自己维护同步与检索；C 记录的是 AWS API 调用而不是应用日志；D 快照不便检索，且实例终止前的最后一段日志可能来不及进入快照。

2. （单选）团队新建了一个指标过滤器统计 `level = "error"` 的日志行，却发现过去 7 天的错误没有出现在指标中。最可能的原因是：
   A. 日志组没有用 KMS 加密
   B. 指标过滤器只对创建之后摄取的日志生效，不会回溯历史日志
   C. 没有先开启 Logs Insights
   D. 日志组保留期太短

   **答案**：B。**解析**：指标过滤器在摄取时匹配，不回溯；要统计历史数据应使用 Logs Insights 查询。其余选项与指标过滤器的生效范围无关。

3. （多选，选两项）需要把 CloudWatch Logs 中的应用日志**近实时**地投递给下游系统（一个用于实时处理，一个用于在 S3 中低成本归档）。可以实现近实时投递的两项是：
   A. 订阅过滤器 → Amazon Data Firehose → Amazon S3
   B. 每分钟执行一次 `CreateExportTask` 导出到 S3
   C. 订阅过滤器 → Kinesis Data Streams 或 Lambda 做近实时处理
   D. 把日志组保留期设为“永不过期”
   E. 用 Logs Insights 定时查询并把结果保存到本地

   **答案**：A、C。**解析**：订阅过滤器是近实时投递的方式，目标可以是 Kinesis Data Streams、Firehose、Lambda（以及 OpenSearch Service）；Firehose 写入 S3 适合低成本归档。导出任务是批量、非实时的，同一时间只能有一个导出任务在运行（以官方文档为准）；保留期永不过期只会让存储费持续增长，不解决投递；Logs Insights 是交互式查询，不是投递机制。

### 清理说明

- 两个日志组是 `DeletionPolicy: Retain`，回收器按 `RETAINED` 来源删除（02 §7.1）；CloudWatch Agent 片段随 `hostSetup revert` 移除，实例随会话删除。
- 如果为了保留日志手工执行过 `CreateExportTask` 或创建过订阅过滤器、Firehose 流，这些不是 logging 栈的资源，回收器依赖 CloudTrail 台账找回，可能要等投递沉淀窗口；不需要时结束前自己删除。
- 改过 `runtime.json` 的 `logLevel` 不需要还原（实例随会话删除），但同一会话里继续做其他实验前请改回 info，避免摄取量偏大。

### 对应 SAA 考点

- 日志组、日志流、保留期（默认永不过期）、KMS 加密；日志类别 Standard 与 Infrequent Access。
- EC2 上的应用日志需要 CloudWatch Agent 或 SDK 才能进入 CloudWatch Logs；Lambda 日志自动进入。
- 统一 CloudWatch Agent（同时采集日志与指标）与旧版 Logs Agent 的区别。
- 指标过滤器 → 指标 → 告警；指标过滤器不回溯。
- Logs Insights、订阅过滤器（Kinesis Data Streams / Firehose / Lambda）、导出到 S3 三者的区别。
- 集中式日志对无状态、可替换实例（ASG）的意义。
- CloudWatch Logs（运行日志）与 CloudTrail（API 审计）的区别；VPC Flow Logs、ALB 访问日志、CloudFront 日志各自可以投递到哪里。

---

<a id="svc-monitoring"></a>

## svc-monitoring：Amazon CloudWatch：指标、告警与仪表板

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-monitoring` |
| kind | `service` |
| 标题 | Amazon CloudWatch：指标、告警与仪表板 |
| 一句话简介 | 让告警与实例解耦：指标双写到 CloudWatch，Agent 补上内存与磁盘，告警在 AWS 侧评估并经 SNS 送达——实例停了也能报警。 |
| 涉及的 AWS 服务 | Amazon CloudWatch 指标、告警与仪表板（主）；Amazon SNS（模块自带 `ops-alarms` 主题）、CloudWatch Agent（辅助）；EC2 状态检查与 CPU 积分（观察） |
| 对应的模块 | `monitoring`（[05#monitoring](../../modules/05-ops-observability.md#monitoring)） |
| 难度 | 初级（`beginner`） |
| 预计时长 | 75 分钟 |
| 时间上限 | 120 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表：L0 + iam(role) + 运行时热键 `lab.faults`，档位 `atl/svc-monitoring/default` |
| 目标模块 | `monitoring` → `METRICS_DRIVER=cloudwatch`（`Mode=putmetricdata`，`AlertEmail={{ learner.inputs.notify-email }}`，`DetailedMonitoring=false`） |
| 费用档位与主要计费来源 | **低**：自定义指标数（由维度组合决定）、告警数、超出免费数量的仪表板、`GetMetricData` 等 API 调用；选做的详细监控按实例另计。基础监控与状态检查指标免费 |
| 人工前置 | 告警邮箱（学员前置输入 `notify-email`），并点击确认 SNS 订阅邮件（`confirm-email`） |
| SAA 考试领域 | 弹性（与实例解耦的告警、EC2 recover）；高性能（指标粒度、Agent 指标）；成本（自定义指标与维度基数） |
| 推荐的前置卡片 | `svc-iam`、`svc-logging`（软依赖）；后续 `sc-observability` |
| 起始部署等级 | A |
| 完成徽章 | 「实例倒下也报警」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | LabMetricsStore 与 worker 内的本地告警评估器始终开启，规则在数据卷上的 `alerts.yaml` |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；monitoring 本身也是 `credentials: required` | `PutMetricData` 需要凭证；内存、磁盘指标依赖的 CloudWatch Agent 只用实例角色（keys 模式下这部分不可用） |
| 运行时热键 | `featureFlags['lab.faults']=true` | 运行时 | `time-to-alert`、`mem-visibility`、`resolution` 要注入 `error5xx`、`mem`、`cpu` 故障 |

### 实验简介

**背景**：L0 的告警由 worker 进程里的评估器判断，通知走站内信与 outbox——评估器与被监控的应用在同一台机器上，进程或实例一挂，告警也跟着沉默；EC2 默认也没有内存指标。启用后同样的指标再批量上报一份到 CloudWatch，Agent 补上内存与磁盘，告警在 AWS 侧评估。

**你将学到**

- EC2 基础监控（5 分钟）与详细监控（1 分钟）；EC2 默认没有内存和磁盘使用率指标。
- 告警的三种状态、周期与 M of N、`TreatMissingData`（心跳告警必须是 `breaching`）、指标数学与复合告警。
- 告警动作：SNS 通知、EC2 `recover`（挂在 `StatusCheckFailed_System` 上；复合告警不能执行 EC2 动作）。
- 自定义指标的维度与基数：高基数字段当维度会让指标数与费用暴涨。

**实验资源**

- **实验机**（L0 + iam）：`/lab/monitoring` 有本地曲线与告警面板，送达路径标注“本地（实例宕机即失效）”。
- **工作台**：k6 负载、`npm run exp`、AWS CLI。
- **你将创建**：monitoring 栈——SNS 主题 `cloudalbum-<env>-ops-alarms` 与邮件订阅、仪表板 `CloudAlbum-<env>-Overview`、约 11 个告警（状态检查、CPU、CPU 积分、内存、磁盘、5xx 比率、p95、两个心跳、复合告警）、实例策略；实例上的 CloudWatch Agent 与 monitoring 片段。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察 `/lab/monitoring`：本地 10 秒样本、`alerts.yaml` 规则、告警面板的“送达路径” | 观察 | `capability`：monitoring `driver=local`；`local`（`systemd-unit`，`amazon-cloudwatch-agent`）：`active=false`（L0 不装 Agent） |
| 2 | 记录 before：`time-to-alert`（本地一侧）；`kill-test --phase service`（第一阶段：停 api 与 worker，本地评估器随之沉默；平台模式下这也是缺省值） | 对比实验 | `experiment`：`monitoring/time-to-alert` 与 `monitoring/kill-test` 的 before 有效 |
| 3 | 接入：`scripts/module enable monitoring --param AlertEmail={{ learner.inputs.notify-email }}` | 脚本（wire） | `capability`：`driver=cloudwatch`，`op: healthy`；订阅未确认导致的 `degraded`（探针结果，不是规则警告）用 `pendingIf` 写成等待型，最终复核要求 `healthy`；`local`（`systemd-unit`）：Agent `active=true`；`local`（`module-state`）：monitoring 已启用；`aws-readonly`（`cloudwatch:DescribeAlarms`，前缀 `cloudalbum-<env>-`）：存在 `app-heartbeat`，`TreatMissingData=breaching` 且 `AlarmActions` 非空 |
| 4 | 在邮箱中确认 SNS 订阅 | 观察 | `manual`（原生）：已点击确认链接；`aws-readonly`（`sns:ListSubscriptionsByTopic`，主题取栈输出 `EnvMetricsCwAlarmTopicArn`）：存在不是 `PendingConfirmation` 的订阅 |
| 5 | 记录 after：`time-to-alert`，`error5xx` 故障下本地与 CloudWatch 并排计时 | 对比实验 | `experiment`：`monitoring/time-to-alert` 的 pair 有效 |
| 6 | 记录 after：`kill-test --phase service`（与 before 相同，只做“停服务”阶段），停服务后 `app-heartbeat` 进入 ALARM 并经 SNS 送达；（选做）另跑一次 `kill-test --label stop-instance --phase instance`（“停实例”阶段），记为一次性变体 `stop-instance`（`role: single`），本步骤声明 `expectedOutage: { channel: lab, maxMinutes: 10 }`，见下方平台说明 | 对比实验 | `experiment`：`monitoring/kill-test` 的 pair 有效；`manual`：收到 ALARM 邮件并记录到达时间 |
| 7 | 内存可见性：注入 `mem` 故障，对比 `AWS/EC2`（没有内存指标）、`CWAgent mem_used_percent` 与本地 `host.memUsedRatio` | 观察 | `aws-readonly`（`cloudwatch:ListMetrics`，`CWAgent` / `mem_used_percent`，维度 `InstanceId={{ target.instanceId }}`）：至少 1 条；`experiment`（选做）：`monitoring/mem-visibility` 的 after |
| 8 | （选做）粒度：`--param DetailedMonitoring=true` 后，同一段 3 分钟 CPU 尖峰在基础与详细监控下的曲线 | 对比实验 | `experiment`（选做）：`monitoring/resolution` 的 after |

**最终复核**：monitoring 为 `ok`（Agent 运行、订阅已确认）；`app-heartbeat` 告警存在。

**平台说明**：`kill-test` 的停实例阶段会让平台管理通道暂时不可达。第 6 步声明了 `expectedOutage`（04 §3.2.8），窗口内的 `CHANNEL_DOWN` 记为 `unavailable/EXPECTED_OUTAGE`、界面显示“预期中断”，02 §5.8 的巡检也不再提示“环境被改动”（附 B-11 已解决）；实验脚本结束时会自动启动实例（EIP 不变、实例 ID 不变），等实例恢复后点“再测一次”。两个阶段分开运行用 `kill-test` 的 `--phase service | instance`（06 PM-M30 已补充：平台模式缺省 `service`；`stop-instance` 变体只接受 `--phase instance`，附 B-23）。

### 对比实验

引用 [05#monitoring §5](../../modules/05-ops-observability.md#monitoring)（`experiments/monitoring/`）。

| 场景 | 标签 | 本卡 | 没有它（本地评估器） | 有它（CloudWatch 告警） |
|---|---|---|---|---|
| `time-to-alert` | before / after | 必需 | 30 秒一次评估，检测快；通知走站内信与 outbox，依赖实例存活 | 分钟级（周期 × 评估期 + 指标出现延迟），经 SNS 送达 |
| `kill-test` | before / after | 必需（pair 只用第一阶段“停服务”；第二阶段“停实例”是选做的附加观察，单独运行、不参与 pair，因为 04 §7.4 第 8 步要求 pair 两侧的场景参数一致） | 停服务或停实例时完全沉默 | `app-heartbeat`（`TreatMissingData=breaching`）进入 ALARM，邮件照常送达 |
| `mem-visibility` | after | 选做（步骤 7 的检查由 `ListMetrics` 完成） | 本机读 `/proc/meminfo` | `AWS/EC2` 没有内存指标；`CWAgent` 提供 `mem_used_percent` |
| `resolution` | after | 选做 | 本地 10 秒样本 | 基础监控 5 分钟一个点可能把 3 分钟尖峰“平均”成小坡；详细监控 1 分钟 |
| `notify-path` | after | 选做 | — | `set-alarm-state` 验证通知链路；下一次评估会按真实数据改回 |

观察点：图表右上角出现“本地 / CloudWatch / 并排”；CloudWatch 曲线 1 分钟一个点、最新的点晚一两分钟出现；多出内存、磁盘、状态检查、CPU 积分几张图；告警面板中每个告警标注送达路径。

### 小测

1. （单选）运维希望 EC2 实例内存使用率超过 90% 时告警，却在 CloudWatch 控制台的 `AWS/EC2` 命名空间里找不到内存指标。应该：
   A. 为实例开启详细监控
   B. 在实例上安装 CloudWatch Agent 采集 `mem_used_percent`，再对该指标创建告警
   C. 启用 CloudTrail 并创建指标过滤器
   D. 使用 AWS Compute Optimizer

   **答案**：B。**解析**：EC2 只提供虚拟化层可见的指标（CPU、网络、磁盘 I/O、状态检查），内存与文件系统使用率必须由操作系统内的 Agent 上报；详细监控只提高粒度，不增加内存指标。

2. （单选）应用每分钟上报一次心跳自定义指标。实例停止后，心跳告警一直停留在 `INSUFFICIENT_DATA`，没有发出通知。应如何修改？
   A. 改为 10 秒的高分辨率指标
   B. 把告警的 `TreatMissingData` 设为 `breaching`
   C. 改用复合告警
   D. 为实例开启详细监控

   **答案**：B。**解析**：`TreatMissingData` 默认是 `missing`，数据缺失时告警不会进入 ALARM；心跳类告警要把“缺数据”视为违规。其他选项都不改变缺数据时的判定。

3. （多选，选两项）一台只使用 EBS 的 t3 实例偶发底层硬件故障。要求自动恢复实例并通知运维，同时不希望应用 5xx 升高触发恢复动作。应选择：
   A. 在 `StatusCheckFailed_System` 告警上配置 EC2 `recover` 动作
   B. 让同一个告警同时通知 SNS 主题
   C. 在复合告警上配置 `recover` 动作
   D. 在 `Http5xx` 告警上配置 `reboot` 动作
   E. 在 `CPUUtilization` 告警上配置 `terminate` 动作

   **答案**：A、B。**解析**：系统状态检查失败对应 AWS 侧的硬件或宿主问题，`recover` 会在新硬件上恢复同一实例；复合告警只能执行通知类动作，不能执行 EC2 动作；D、E 会被应用层问题误触发。

### 清理说明

- 回收会删除 monitoring 栈（告警、仪表板、SNS 主题与订阅随之删除）并移除 Agent 片段；已经上报的自定义指标无法删除，停止上报后按保留策略自然过期，不再产生费用。
- 做过选做步骤 8 的，结束前把 `DetailedMonitoring` 改回 `false`（`scripts/module enable monitoring --param DetailedMonitoring=false`），否则在会话剩余时间里按实例计费。
- 用过 `--sqs-probe` 的，确认脚本已删除临时 SQS 订阅与队列。
- 停实例实验后如果实例仍处于 stopped，回收照常进行；但继续做其他步骤前要先启动它。

### 对应 SAA 考点

- EC2 基础监控与详细监控；默认没有内存与磁盘使用率，需要 CloudWatch Agent；系统与实例状态检查。
- 自定义指标：标准与高分辨率、维度与基数、`PutMetricData` 与 EMF；统计集拿不到百分位。
- 告警：三种状态、周期与评估期（M of N）、`TreatMissingData`、指标数学、复合告警。
- 告警动作：SNS、EC2 stop / terminate / reboot / recover、Auto Scaling 策略；ASG 的各类扩缩容策略依赖 CloudWatch 指标。
- T 系列的 CPU 积分余额与无限模式。
- CloudWatch（性能）、CloudTrail（API 审计）、AWS Config（配置合规）的区别。
- 监控系统要与被监控对象解耦：心跳缺失告警与状态检查告警能发现实例死亡。

---

<a id="svc-tracing"></a>

## svc-tracing：AWS X-Ray：分布式链路追踪

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-tracing` |
| kind | `service` |
| 标题 | AWS X-Ray：分布式链路追踪 |
| 一句话简介 | 从单跳的 Server-Timing 到本机 span 树，再到 X-Ray 服务地图：同一套 OpenTelemetry 插桩只换导出后端，找出“慢在哪一段”。 |
| 涉及的 AWS 服务 | AWS X-Ray（主）；CloudWatch Agent 的 traces 段（辅助，本机收集器）；Amazon EC2、AWS IAM 实例角色（辅助） |
| 对应的模块 | `tracing`（[05#tracing](../../modules/05-ops-observability.md#tracing)） |
| 难度 | 中级（`intermediate`） |
| 预计时长 | 75 分钟 |
| 时间上限 | 120 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表：L0 + iam(role) + 本地档 + 运行时热键 `lab.faults`，档位 `atl/svc-tracing/default`（本地档要由 registry 的 `singleLocalSettings` 推导，06） |
| 目标模块 | `tracing` → `TRACING_DRIVER=xray`（`TRACING_LOCAL_SPANS=on`，便于并排比较）；中间先经过本地档 `local` |
| 费用档位与主要计费来源 | **低**：X-Ray 记录的 trace 数与检索、扫描的 trace 数（由采样规则决定）；本地档与 CloudWatch Agent 不产生 AWS 费用。不要开启 X-Ray Insights 或 Transaction Search（另行计费） |
| 人工前置 | 无 |
| SAA 考试领域 | 高性能（定位瓶颈）；弹性（分布式系统的可观测性） |
| 推荐的前置卡片 | `svc-logging`、`svc-monitoring`（软依赖）；后续 `sc-observability`、`sc-image-pipeline` |
| 起始部署等级 | A（自建 PostgreSQL 的安装让部署多几分钟） |
| 完成徽章 | 「慢点猎手」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | `Server-Timing` 与 `X-CloudAlbum-Path` 在任何档位都存在 |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；xray 档本身也要求凭证，实际要求 role | 本机 Collector（CloudWatch Agent）用实例角色写 X-Ray，keys 模式下 trace 永远不会出现 |
| 本地档：自建 PostgreSQL | `DB_DRIVER=postgres`、`DB_HOST=127.0.0.1` | 本地档（总纲 10.4 规则 3；database 的 `selfHosted`） | pg 插桩生成 client span，X-Ray 中出现独立的数据库远端节点；SQLite 只有进程内的 knex span，服务地图上只剩一个节点，`slow-hunt` 没有可看的对象 |
| 本地档：memory 队列 + worker | `QUEUE_DRIVER=memory`、`IMAGE_PROCESSOR=worker` | 本地档；DEP-004（worker 要求 `QUEUE_DRIVER≠sync`） | 上传后的缩略图任务经 `JobEnvelope.traceparent` 续接在同一条 trace 中，span 树不止一层 |
| 运行时热键 | `featureFlags['lab.faults']=true` | 运行时 | `slow-hunt` 要注入数据库延迟故障 |

不预置 queue(sqs) 与 image-processing(lambda)：它们是软依赖，“api → SQS → worker 同一条 trace”“Lambda 是另一条 trace”放在组合场景中演示。

### 实验简介

**背景**：`Server-Timing` 只能说明本进程内各端口花了多少时间；链路一旦跨进程、跨 AWS 服务，就需要把调用串成一条 trace。CloudAlbum 用同一套 OpenTelemetry 插桩，`local` 档写本地 span 文件，`xray` 档经本机 CloudWatch Agent 导出到 X-Ray。

**你将学到**

- trace、segment、subsegment；annotation（建索引，可用于过滤）与 metadata（不建索引）。
- 采样规则（蓄水池 + 固定比例）集中修改，不需要重新部署；健康检查要用 `FixedRate=0` 的规则排除。
- 服务地图定位“慢在哪一段”；过滤表达式（如 `responsetime > 0.3`）。
- ALB、CloudFront 不产生 segment；API Gateway HTTP API 不支持 X-Ray；X-Ray SDK 与 Daemon 已进入维护模式，新项目用 ADOT / CloudWatch Agent。

**实验资源**

- **实验机**（L0 + iam + 本地档）：自建 PostgreSQL、memory 队列；`/lab/trace` 只有单跳瀑布图。
- **工作台**：`npm run exp`（slow-hunt、walkthrough、overhead 脚本）、k6。
- **你将创建**：本地档阶段只投放 systemd drop-in（`50-tracing.conf`）；xray 档的 tracing 栈——采样规则 `cloudalbum-<env>-default` 与 `cloudalbum-<env>-health`、X-Ray 组 `cloudalbum-<env>`、实例策略；实例上的 CloudWatch Agent traces 片段。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察 none 档：单跳 Server-Timing；路径头中没有 tracing 段 | 观察 | `capability`：tracing `driver=none`；`http-header`（`from: platform`，`target: public-ip`，`/api/capabilities`）：`server-timing` 存在，路径头中没有 tracing 段（04 §5.3 没有“不包含”运算符，断言写成 `$.pathSegments.tracing` 为 `absent`，`pathSegments` 是 04 §5.2.3 证据中解析好的路径段） |
| 2 | 记录 before：数据库延迟故障（`latency`，`target=database`）+ `slow-hunt` 第一轮，只用 Server-Timing 定位，记录步骤数 | 对比实验 | `experiment`：`tracing/slow-hunt` 的 before 有效 |
| 3 | 本地档：`scripts/module enable tracing --driver local`，在 `/lab/tracing` 看本机 span 树 | 脚本 | 以下三项都标（once）——第 4 步切到 xray 后它们必然不再成立：`capability`：`driver=local`；`local`（`file-stat`，`/var/lib/cloudalbum/logs/spans`）：存在；`http-header`（`from: lab`，`target: self`，`/api/capabilities`）：`x-cloudalbum-path` 含 `tracing=local:` |
| 4 | 接入：`scripts/module enable tracing`（xray） | 脚本（wire） | `capability`：`driver=xray`、`status=ok`；`http-header`（`from: platform`，`target: public-ip`）：`x-cloudalbum-path` 含 `tracing=xray:`；`local`（`systemd-unit`）：`amazon-cloudwatch-agent` 为 `active`；`aws-readonly`（`xray:GetSamplingRules`）：有 `cloudalbum-<env>-default` 与 `FixedRate=0` 的 `cloudalbum-<env>-health` |
| 5 | `walkthrough`：带强制采样令牌上传一张图片，记录 trace 出现在 X-Ray 中的耗时 | 对比实验 | `experiment`：`tracing/walkthrough` 的 after 有效；`aws-readonly`（`xray:GetTraceSummaries`，最近 30 分钟，`service("cloudalbum-api")`）：至少 1 条 |
| 6 | 记录 after：`slow-hunt` 第二轮，用服务地图与过滤表达式 `responsetime > 0.3` 定位 | 对比实验 | `experiment`：`tracing/slow-hunt` 的 pair 有效；`aws-readonly`（`xray:GetServiceGraph`）：至少 2 个节点（`cloudalbum-api` 与数据库远端节点；节点名以实测为准，断言级别 `warn`） |
| 7 | （选做）追踪开销：同一压测中交替发送强制采样与 `X-Compare-Bypass: tracing` 两组请求 | 对比实验 | `experiment`（选做）：`tracing/overhead` 的 after（`ab: true`） |

**最终复核**：tracing 为 `ok`。

### 对比实验

引用 [05#tracing §5](../../modules/05-ops-observability.md#tracing)（`experiments/tracing/`）。本卡是三段式：none（变体 `before`，baseline）→ local（变体 `local`，baseline，选做记录）→ xray（变体 `after`，treatment）。`pairs: [[before, after]]`、`requiredLabels: [before, after]`；第 3 步可以再跑一次 `npm run exp -- tracing slow-hunt --label local --upload`，结果标注 `variant: local`（04 §3.2.10，裁决 C5）。

| 场景 | 标签 | 本卡 | 没有它（none / local） | 有它（xray） |
|---|---|---|---|---|
| `slow-hunt` | before / after | 必需 | none：只有本进程各端口的累计耗时；local：本机 span 树，数据来自 i-xxxx | 服务地图上数据库节点变色，`GetTraceSummaries` 按条件直接筛出慢 trace |
| `walkthrough` | after | 必需 | local：扫描本地 jsonl 文件 | trace 要几秒到几十秒才出现在 X-Ray 中，可在控制台打开 |
| `overhead` | after（A/B） | 选做 | none 档为“完全没有 OTel”的基准 | 开销相对请求很小，通常在亚毫秒到数毫秒量级（以实测为准） |
| `propagation` | — | 不纳入 | 本卡没有 SQS 与 Lambda | 移到 `sc-observability`（api → SQS → worker 同一 trace）与 `sc-image-pipeline`（S3 → EventBridge → Lambda 是另一条 trace，用 `photo_id` 关联） |

观察点：`X-CloudAlbum-Path` 的 tracing 段从缺省 → `local:recorded` → `xray:sampled` / `xray:not-sampled`；`/lab/tracing` 多出“在 X-Ray 中打开”与嵌入的服务地图。

### 小测

1. （单选）一个应用的调用链为 ALB → EC2 → SQS → worker → RDS，偶发高延迟。团队需要知道慢在哪一段，并查看各组件之间的服务地图。最合适的工具是：
   A. CloudWatch Logs Insights
   B. AWS X-Ray：应用插桩，实例上运行收集器，经 SQS 传播追踪上下文
   C. AWS CloudTrail
   D. VPC Flow Logs

   **答案**：B。**解析**：X-Ray 把跨进程、跨服务的调用串成 trace 并汇总成服务地图；Logs Insights 能查日志但不提供调用拓扑；CloudTrail 记录控制面 API；Flow Logs 只有网络五元组。

2. （单选）团队希望在 X-Ray 中按 `customer_id` 过滤 trace。应该把 `customer_id` 记录为：
   A. metadata
   B. annotation
   C. segment 名称
   D. 采样规则的服务名

   **答案**：B。**解析**：annotation 会建索引，可用于过滤表达式；metadata 不建索引，只能在 trace 详情中查看。

3. （多选，选两项）关于 AWS X-Ray，正确的两项是：
   A. ALB 会作为独立节点出现在服务地图中
   B. 修改采样规则不需要重新部署应用
   C. API Gateway HTTP API 支持 X-Ray 主动追踪
   D. Lambda 可以开启主动追踪，执行角色需要 X-Ray 写权限
   E. CloudFront 会把 segment 发送给 X-Ray

   **答案**：B、D。**解析**：采样规则由 X-Ray 集中下发；ALB 只注入 `X-Amzn-Trace-Id` 头，不产生 segment；HTTP API 不支持 X-Ray，REST API 才支持 stage 追踪；CloudFront 不参与 X-Ray。

### 清理说明

- 回收会删除 tracing 栈（采样规则与组随之删除），`hostSetup revert` 删除 drop-in 与 Agent 片段；自建 PostgreSQL 随实验机删除。X-Ray 中已有的 trace 按保留期自然过期。
- X-Ray Insights、CloudWatch Transaction Search 是账号级设置，不在 tracing 栈中；如果你在控制台开启过，结束前自己关闭，回收器不会替你关。
- 选做的 `overhead` 实验做完后确认没有遗留正在运行的 k6 进程（工作台随会话删除，但长时间压测会持续产生 trace 费用）。

### 对应 SAA 考点

- trace、segment、subsegment；annotation 与 metadata；组。
- 采样规则：蓄水池 + 固定比例，集中修改无需重新部署。
- 服务地图（Trace Map）定位延迟与错误。
- Lambda 主动追踪；API Gateway REST API 支持 stage 追踪、HTTP API 不支持；SQS 的追踪头传播。
- ALB、CloudFront 不产生 segment，ALB 只注入 `X-Amzn-Trace-Id`。
- X-Ray（链路）、CloudWatch（指标与日志）、CloudTrail（API 审计）的区别。
- 采集方式：X-Ray Daemon（维护模式）、ADOT / OpenTelemetry、CloudWatch Agent；EC2 上需要实例角色有 X-Ray 写权限。

---

<a id="svc-audit"></a>

## svc-audit：AWS CloudTrail：AWS API 操作审计

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-audit` |
| kind | `service` |
| 标题 | AWS CloudTrail：AWS API 操作审计 |
| 一句话简介 | 在“知道最终用户”的应用审计表旁边加上“知道 AWS 身份”的 CloudTrail trail：多区域长期留存、日志文件完整性验证，并把两层审计对齐。 |
| 涉及的 AWS 服务 | AWS CloudTrail（主）；Amazon S3（模块自带日志桶）、Amazon CloudWatch Logs（trail 投递，辅助）；AWS IAM（观察：调用者身份） |
| 对应的模块 | `audit`（[05#audit](../../modules/05-ops-observability.md#audit)） |
| 难度 | 中级（`intermediate`） |
| 预计时长 | 75 分钟 |
| 时间上限 | 120 分钟（含等待首个 digest 文件，见步骤 8） |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表 |
| 目标模块 | `audit` → `AUDIT_MODE=cloudtrail`（`DeliverToLogs=true`，`ExcludeKmsEvents=false`，`ObjectLockDays=0`）；账号已有多区域或组织 trail 时 preflight 进入只读接入（`CreateTrail=false`） |
| 费用档位与主要计费来源 | **低**：本区域第一份管理事件副本的 trail 投递免费（以官方定价为准）；日志桶的 S3 存储与请求；投递到 CloudWatch Logs 的摄取费。本卡不开数据事件、不开 Insights |
| 人工前置 | 无。账号里已有 trail（包括平台安装参数 `PlatformTrail=enabled` 创建的 `atl-trail`）时以只读接入方式完成，步骤 8 改为选做 |
| SAA 考试领域 | 安全（secure） |
| 推荐的前置卡片 | `svc-iam`（软依赖）；后续 `svc-threat-detection`、`sc-security-baseline`、`sc-threat-compliance` |
| 起始部署等级 | A |
| 完成徽章 | 「谁动了 AWS」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | 应用审计表 `audit_log`（哈希链）是 L0 核心机能 |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；audit 是 `credentials: optional`，第 2 轮不并入，本轮按 C3 预置 | 应用有了凭证（iam 策略含 `cloudtrail:LookupEvents`），`/admin/audit` 的“AWS 事件”页签在基线下就读取 Event History（标注“仅管理事件 · 90 天 · 本区域”），启用后改读 trail，前后对比更直观（05#audit） |

不预置 storage：S3 数据事件因此不在本卡范围内（见“对比实验”）。

### 实验简介

**背景**：应用审计表能回答“哪个最终用户在 CloudAlbum 里做了什么”，却看不到绕过应用的 AWS 操作；AWS 默认的 Event History 只有管理事件、只保留 90 天、要逐个区域查看。trail 把事件长期投递到专用 S3 桶，带日志文件完整性验证。

**你将学到**

- Event History 与 trail 的区别；管理事件、数据事件、Insights 事件。
- 多区域 trail；IAM、CloudFront 等全局服务（以及调用 STS 全局端点）的事件记录在 us-east-1。
- 日志文件完整性验证（digest 文件）、SSE-KMS、S3 对象锁、单独的日志账号。
- 用 CloudTrail 排查 AccessDenied：看 `errorCode` 与调用者身份（`AssumedRole CloudAlbumAppRole/i-…`）。
- 应用内哈希链只能“发现”篡改，防不住拥有 root 的人整体重写——这正是审计日志要放在应用之外的原因。

**实验资源**

- **实验机**（L0 + iam）：`/admin/audit` 有“应用审计”与“AWS 事件”两个页签，后者此时来自 Event History。
- **工作台**：`npm run exp`（who-deleted、validate-logs）、AWS CLI。
- **你将创建**：audit 栈——日志桶 `cloudalbum-<env>-trail-<acct>-<region>`（阻止公共访问、版本控制、SSE-S3）、多区域 trail `cloudalbum-<env>-trail`（日志文件验证开启）、投递日志组 `/cloudalbum/<env>/cloudtrail` 与指标过滤器、实例只读策略。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察 `/admin/audit` 的应用审计（哈希链校验通过）；在控制台 CloudTrail → 事件历史中查看同一时段的管理事件（仅管理事件 · 90 天 · 本区域） | 观察 | `capability`：audit `driver=app`、`localHealth=ok`；`manual`：记录哈希链校验结果与 Event History 的三条限制 |
| 2 | 记录 before：`who-deleted` 四个场景（按本卡起始状态适配，见“对比实验”） | 对比实验 | `experiment`：`audit/who-deleted` 的 before 有效 |
| 3 | 接入：`scripts/module enable audit --param DeliverToLogs=true`（preflight `existing-trail`） | 脚本（wire） | `capability`：`driver=cloudtrail`，`op: healthy`（只读接入时 detail 标注“外部 trail”）；`local`（`module-state`）：audit 已启用；`aws-readonly`（`cloudtrail:DescribeTrails`，`cloudalbum-<env>-trail`，`ownership: session`）：`IsMultiRegionTrail=true`、`LogFileValidationEnabled=true`、`IncludeGlobalServiceEvents=true`（`when: envfile.audit.CLOUDTRAIL_MANAGED == 'true'`，04 §4.4 规则 5，见约定 4）；`aws-readonly`（`cloudtrail:GetTrailStatus`，trail 取 `envfile.audit.CLOUDTRAIL_TRAIL_ARN`；只读接入时不带 `ownership`）：`IsLogging=true` |
| 4 | 等待首次投递（读一读：投递延迟与 Event History 的区别） | 观察 | `aws-readonly`（`cloudtrail:GetTrailStatus`）：`LatestDeliveryTime` 存在（等待型：通常 10 分钟，最长 30 分钟） |
| 5 | 观察 `/admin/audit`：“AWS 事件”页签已改读 trail（标注“多区域 · 完整性已验证”），在“关联视图”中找到第 2 步场景 3 的安全组变更 | 观察 | `manual`：在关联视图中找到第 2 步场景 3 的安全组变更（`drift: once`） |
| 6 | 记录 after：再跑一次 `who-deleted`，脚本轮询两侧直到事件出现 | 对比实验 | `experiment`：`audit/who-deleted` 的 pair 有效；`aws-readonly`（`cloudtrail:LookupEvents`，`EventName=AuthorizeSecurityGroupIngress`）：存在用户名以 `atl-<sid>` 开头的事件 |
| 7 | 哈希链篡改：`faults/tamper-audit.sh`（经投递通道以 root 执行）后，`/admin/audit` 报告断点；再演示“重算整条链”也能骗过本地校验 | 对比实验 | `experiment`：`audit/chain-tamper` 的 after 有效；`manual`：记录报告的断点行号 |
| 8 | `validate-logs`：校验最近一小时的日志文件，并在测试副本上演示篡改被发现 | CLI + 对比实验 | `aws-readonly`（`cloudtrail:GetTrailStatus`）：`LatestDigestDeliveryTime` 存在（digest 文件大约每小时投递一次，等待型：通常 30 分钟，最长 60 分钟）；`experiment`：`audit/validate-logs` 的 after 有效（只读接入时选做） |

**最终复核**：audit 的 `driver=cloudtrail`，`op: healthy`；trail 正在记录。

### 对比实验

引用 [05#audit §5](../../modules/05-ops-observability.md#audit)（`experiments/audit/`）。

| 场景 | 标签 | 本卡 | 没有它（应用审计 + Event History） | 有它（trail） |
|---|---|---|---|---|
| `who-deleted` | before / after | 必需 | 应用审计回答“哪个最终用户”；绕过应用的操作只在 Event History（管理事件、90 天、本区域） | 管理事件长期留存在日志桶、多区域汇总；关联视图按 request_id、时间窗对齐两层审计 |
| `chain-tamper` | after | 必需 | 哈希链能发现被修改的行，但 root 可以重算整条链 | 说明为什么要外部不可变存储（S3 + 对象锁、单独账号） |
| `validate-logs` | after | 必需（只读接入时选做） | 应用表没有外部可验证的完整性证明 | digest 文件证明日志未被修改或删除；篡改后的测试副本校验失败 |

**`who-deleted` 在本卡中的适配**（起始状态没有 storage）：

| 场景 | 模块文档原文 | 本卡 |
|---|---|---|
| 1 最终用户删照片 | alice 调用 `DELETE /api/photos/:id` | 同左（照片在本地磁盘） |
| 2 绕过应用的 AWS 操作 | 运维者 `aws s3 rm` 原图桶对象 | 删除一条无害的 SSM 参数（05 原文 storage=local 时的备选之一，例如脚本先 `put-parameter` 建 `/cloudalbum/<env>/lab/who-deleted-canary` 再删除；不能用 `/cloudalbum/<env>/atl/` 路径）。05 原文的另一个备选“给日志桶打标签”在 before 时日志桶还不存在，本卡不用 |
| 3 安全组规则 | 加一条无害规则随即撤销 | 同左（例如对文档保留地址段 `203.0.113.0/24` 开放 443，随即撤销） |
| 4 制造 AccessDenied | 临时分离 storage 的 `PolicyArn` 再恢复 | 由运行器经投递通道（SSM Run Command）在实验机上用实例角色执行一个未授权的只读调用（例如 `aws s3 ls`：`AmazonSSMManagedInstanceCore` 与 iam 模块的只读策略都不含 `s3:ListAllMyBuckets`，以 iam 模块策略的实际内容为准），CloudTrail 中 `errorCode=AccessDenied`、身份为 `CloudAlbumAppRole/i-…`；不需要改动任何策略。学员在实验机终端手动执行同一命令只用于观察（第 1 批 §1.4 第 3 条） |

“S3 对象级操作（数据事件）”一行在本卡固定为“不适用”：数据事件桶由 storage 经 `injects` 注入 `DataEventBuckets`，本卡不预置 storage。完整的“谁删了这张照片”放在含 storage 的组合场景中做。

### 小测

1. （单选）安全团队要调查 6 个月前是谁删除了某个 S3 对象，而账号从未配置过 trail。能否从 CloudTrail 得到答案？
   A. 能，Event History 保留一年并包含数据事件
   B. 不能：Event History 只保留 90 天且只有管理事件，S3 对象级操作是数据事件，必须事先配置 trail 并选择数据事件
   C. 能，S3 服务器访问日志默认开启
   D. 能，用 AWS Config 的资源时间线即可查到

   **答案**：B。**解析**：Event History 默认存在但只有 90 天的管理事件；S3 对象级的 `DeleteObject` 是数据事件，只有事先建 trail 并选择数据事件才会记录。S3 服务器访问日志默认关闭；Config 记录资源配置，不记录对象级 API 调用。

2. （多选，选两项）需要证明 CloudTrail 日志没有被篡改，并防止日志被删除。应选择：
   A. 为 trail 开启日志文件完整性验证
   B. 日志桶启用 S3 对象锁（或 MFA Delete），并把日志集中到单独的日志账号
   C. 用生命周期规则把日志转换到 S3 Glacier
   D. 开启 CloudTrail Insights
   E. 把 trail 改为单区域

   **答案**：A、B。**解析**：digest 文件用来验证日志是否被修改或删除；对象锁、MFA Delete 与独立账号防止删除。C 只影响存储成本；D 检测 API 调用量异常；E 反而缩小覆盖面。

3. （单选）安全团队希望有人使用 root 账号登录或修改安全组时，在几分钟内收到通知。最合适的做法是：
   A. 每天导出一次 Event History 并人工检查
   B. 把 trail 投递到 CloudWatch Logs，为这些事件建指标过滤器和告警并发到 SNS（或用 EventBridge 规则匹配对应的 CloudTrail 事件）
   C. 在 GuardDuty 中生成示例发现
   D. 用 AWS Config 每日记录配置

   **答案**：B。**解析**：指标过滤器 + 告警（或 EventBridge 规则）是 CIS 基准中的做法，延迟在分钟级；A 不及时；C 只是演示；D 的每日记录频率太低，也不是为 root 登录设计的。

### 清理说明

- 回收会删除 trail；日志桶与投递日志组是 `DeletionPolicy: Retain`，由回收器清空全部版本后删除（02 §7.5 的 S2 阶段）。
- 本卡把 `ObjectLockDays` 设为 0：**不要**自己给日志桶开启对象锁，合规模式下的对象在保留期内连 root 都删不掉，会让回收失败并持续产生存储费。
- `validate-logs` 演示用的“测试副本”放在日志桶的测试前缀下，随桶删除。
- 只读接入时本卡不改动已有 trail；结束后确认账号里没有因本卡产生第二个收费的 trail。

### 对应 SAA 考点

- CloudTrail Event History（默认开启、90 天、仅管理事件）与 trail（长期留存、多区域、组织级）的区别。
- 管理事件、数据事件（S3 对象级、Lambda Invoke、DynamoDB 条目级等）、Insights 事件；读事件与写事件。
- 保护审计日志：完整性验证、SSE-KMS、S3 对象锁（可在已有桶上开启且开启后不可关闭）、MFA Delete、单独的日志账号。
- trail 投递到 CloudWatch Logs，用指标过滤器与告警监控敏感 API。
- 用 Athena 查询 CloudTrail 日志；CloudTrail Lake（了解）。
- CloudTrail（谁调用了 API）、AWS Config（配置与合规）、CloudWatch（性能）的区别。
- 用 CloudTrail 的 `errorCode` 与调用者身份排查 AccessDenied；IAM 等全局服务的事件在 us-east-1（STS 区域端点的调用记在该区域）。

---

<a id="svc-threat-detection"></a>

## svc-threat-detection：Amazon GuardDuty：威胁检测

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-threat-detection` |
| kind | `service` |
| 标题 | Amazon GuardDuty：威胁检测 |
| 一句话简介 | 在主机内的 fail2ban 旁边启用 GuardDuty：用覆盖矩阵看清两者各自能发现什么、谁能阻断、谁不怕实例宕机。 |
| 涉及的 AWS 服务 | Amazon GuardDuty（主）；Amazon EventBridge、Amazon SNS（模块自带 `security-findings` 主题，辅助）；AWS CloudShell（攻击模拟的来源，辅助） |
| 对应的模块 | `threat-detection`（[05#threat-detection](../../modules/05-ops-observability.md#threat-detection)） |
| 难度 | 中级（`intermediate`） |
| 预计时长 | 45 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表 |
| 目标模块 | `threat-detection` → `THREAT_DETECTION_MODE=guardduty`（`AlertEmail={{ learner.inputs.notify-email }}`，S3 Protection、Runtime Monitoring、Malware Protection 保持关闭） |
| 费用档位与主要计费来源 | **中**（会话期间开启了账号级按量服务）：GuardDuty 按分析的 CloudTrail 事件、VPC 流日志与 DNS 日志量计费；新账号或新区域首次开启有试用期（以控制台与官方定价为准）；SNS、EventBridge 在此量级下可忽略 |
| 人工前置 | 发现通知邮箱（`notify-email`），并确认订阅；账号已有 detector 时只读接入（见步骤 5 的说明） |
| SAA 考试领域 | 安全（secure） |
| 推荐的前置卡片 | `svc-shell-access`、`svc-audit`（软依赖）；后续 `sc-edge-protection`、`sc-threat-compliance` |
| 起始部署等级 | A |
| 完成徽章 | 「威胁瞭望」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | fail2ban（sshd、nginx-limit-req、cloudalbum-auth、cloudalbum-scan 四个 jail）与本地分析器由 ec2 安装；直连时封禁方式为 nftables |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；threat-detection 是 `credentials: optional`，第 2 轮不并入，本轮按 C3 预置 | 必需实验 `sample-findings` 的脚本轮询 `/lab` 安全面板右栏（05#threat-detection §5 第 1 步），右栏要靠应用凭证读取 GuardDuty；第 2 轮“第 3 步由学员先执行 `enable iam`”的例外随之删除 |

### 实验简介

**背景**：fail2ban 与本地分析器只看得见本机日志：能在秒级封禁登录爆破和扫描路径，却看不见 DNS 查询、网络流量模式、AWS API 调用和凭证滥用；实例一旦宕机或被攻陷，检测也随之失效。GuardDuty 在 AWS 侧独立分析 CloudTrail 管理事件、VPC 流日志与 DNS 日志——但它只告警、不阻断。

**你将学到**

- GuardDuty 的基础数据源由它独立采集，不需要自己开 VPC Flow Logs，也不需要建 trail。
- 只检测、不阻断；自动响应靠 EventBridge → SNS / Lambda（例如更新 WAF IP 集合或网络 ACL）。
- 发现的严重度分级与示例发现（`[SAMPLE]`）；每个账号每个区域一个 detector，多账号用委派管理员。
- GuardDuty、Inspector、Macie、Detective、Security Hub 的分工；GuardDuty、WAF、Shield、安全组 / NACL 各管哪一层。

**实验资源**

- **实验机**（L0 + iam）：`/lab` 安全面板只有左栏“主机内视角”；第 3 步启用 GuardDuty 之后出现右栏“AWS 视角”。
- **AWS CloudShell**（经控制台联合登录打开）：作为“不在 fail2ban `ignoreip` 中”的攻击来源。工作台的地址可能被写进 `ignoreip`（运维 IP），而且工作台被封禁会影响后续的 HTTP 检查，所以本卡的攻击模拟一律从 CloudShell 发起，只针对本会话的实验机。
- **你将创建**：threat-detection 栈——detector（preflight 判定新建、恢复或只读接入）、EventBridge 规则 `cloudalbum-<env>-guardduty-findings`（严重度 ≥ 4）、SNS 主题 `cloudalbum-<env>-security-findings` 与邮件订阅、实例策略。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察安全面板左栏：jail 列表、封禁方式 nftables、本地 `security_findings` | 观察 | `capability`：threat-detection `driver=fail2ban`、`localHealth=ok` |
| 2 | 从 CloudShell 对实验机 EIP 请求 `/.env`、`/wp-login.php`、`/phpmyadmin` 等路径（可选：用错误密码连续登录） | CLI（`runsOn=cloudshell`） | `local`（`app-stat`，统计名 `security.localFindings24h{type=Recon:WebScan}` 需在 06 的 app-stat 登记表中登记，04 M-10）：计数 ≥ 1（本地分析器每 5 分钟运行一次，等待型：通常 5 分钟，最长 15 分钟；`drift: once`）；`manual`：记录 CloudShell 请求开始被拒绝（超时）的时刻 |
| 3 | 接入：`scripts/module enable threat-detection --param AlertEmail={{ learner.inputs.notify-email }}`（preflight `existing-detector`） | 脚本（wire） | `capability`：threat-detection `driver=guardduty`，`op: healthy`；订阅未确认导致的 `degraded` 用 `pendingIf` 等待；`local`（`module-state`）：threat-detection 已启用；`aws-readonly`（`guardduty:GetDetector`，`DetectorId={{ envfile.threat-detection.GUARDDUTY_DETECTOR_ID }}`，不带 `ownership`：只读接入时 detector 不是本会话创建的）：`Status=ENABLED`；`aws-readonly`（`events:DescribeRule`，`ownership: session`）：`cloudalbum-<env>-guardduty-findings` 为 `ENABLED` |
| 4 | 确认发现通知的订阅邮件 | 观察 | `manual`（原生）；`aws-readonly`（`sns:ListSubscriptionsByTopic`，主题取 `stack.threat-detection.EnvGuarddutyFindingsTopicArn`）：存在已确认的订阅 |
| 5 | `sample-findings`：在工作台运行实验，生成 SSH 爆破、端口探测、挖矿 DNS、实例凭证外泄四类示例发现；脚本轮询 `/lab` 右栏与邮件到达时间，结束时归档这些示例发现 | 对比实验 | `experiment`：`threat-detection/sample-findings` 的 after 有效；`aws-readonly`（`guardduty:ListFindings`，类型为上述四类、`updatedAt` 晚于本步骤开始，**不按归档状态过滤**——脚本结束时会归档它们）：至少 1 条（`drift: once`）；`manual`：收到 EventBridge → SNS 的发现邮件 |
| 6 | 看覆盖矩阵：Web 扫描只有左栏打勾，DNS、凭证外泄、异常 API 调用只有右栏打勾；（选做）DNS 金丝雀：经投递通道在实验机上 `dig guarddutyc2activityb.com`（官方文档给出的测试域名，以官方文档为准），等待真实的 `Backdoor:EC2/C&CActivity.B!DNS` 发现 | 观察 | `manual`：截取或粘贴覆盖矩阵；（选做）`aws-readonly`（`guardduty:ListFindings`，非示例、DNS 类）：至少 1 条（等待型，最长 60 分钟） |
| 7 | 确认示例发现与 DNS 金丝雀发现都已归档（脚本没归档完的手工归档） | CLI | `aws-readonly`（`guardduty:ListFindings`，四类示例类型与 DNS 金丝雀、`updatedAt` 晚于会话开始、未归档）：0 条 |

**最终复核**：threat-detection 的 `driver=guardduty`、`op: healthy`（订阅已在第 4 步确认）。

**只读接入时**（账号已有不归本项目管理的 detector）：本模块只建规则、主题与策略，不改 detector。生成示例发现会写入别人的 detector，步骤 5 在只读接入时要求学员显式确认，否则改为观察已有发现。

### 对比实验

引用 [05#threat-detection §5](../../modules/05-ops-observability.md#threat-detection)（`experiments/threat-detection/`）。

| 场景 | 标签 | 本卡 | 没有它（fail2ban + 本地分析器） | 有它（GuardDuty） |
|---|---|---|---|---|
| `sample-findings` | after | 必需 | 不能检测 DNS、凭证外泄、异常 API 调用 | 示例发现出现在右栏并经 EventBridge → SNS 送达，与实例状态无关 |
| `web-scan` | before / after | 选做（从 CloudShell 执行，不能经工作台运行器上传，由步骤 2 的检查替代） | `cloudalbum-scan` 秒级封禁，本地分析器记 `Recon:WebScan` | 不检测 HTTP 内容（属于 WAF 的范畴） |
| `login-bruteforce` | before | 选做（同上） | `cloudalbum-auth` jail 秒级封禁 | 无发现 |
| `dns-canary` | after | 选做 | 不能 | 产生真实的 DNS 类发现（出现时间以官方文档为准），实验后归档 |
| `ssh-bruteforce` | — | 不纳入 | 需要 22 对公网开放并承受一定规模的真实攻击，不可复现，且违反最终复核的安全底线 | 用示例发现演示 |

覆盖矩阵（05 §5）：SSH 爆破两侧都能检测（fail2ban 秒级封禁，GuardDuty 分钟级只告警）；端口扫描左栏部分、右栏能；应用登录爆破与 Web 扫描只有左栏；挖矿或 C&C 域名、实例凭证外泄、异常 API 调用只有右栏。

### 小测

1. （单选）公司想发现 EC2 实例与已知挖矿或 C&C 域名通信、实例凭证在 AWS 之外被使用的情况，要求不在实例上安装代理、运维开销最小。应使用：
   A. Amazon Inspector
   B. Amazon GuardDuty
   C. AWS WAF
   D. Amazon Macie

   **答案**：B。**解析**：GuardDuty 分析 DNS 日志、VPC 流日志与 CloudTrail 事件，能发现这两类威胁，基础检测不需要代理。Inspector 找漏洞，WAF 过滤 Web 请求，Macie 发现 S3 中的敏感数据。

2. （单选）GuardDuty 报告了 `Recon:EC2/PortProbeUnprotectedPort`。团队希望自动把攻击来源 IP 加入 WAF 的 IP 集合。最合适的做法是：
   A. 在 GuardDuty 中开启“自动阻断”
   B. 创建 EventBridge 规则匹配 GuardDuty 发现，触发 Lambda 更新 WAF IP 集合（或网络 ACL）
   C. 用 AWS Config 的修复动作
   D. 订阅 Shield Advanced 后由其自动处理

   **答案**：B。**解析**：GuardDuty 只检测、不阻断，自动响应用 EventBridge 驱动 Lambda 等目标完成。Config 修复针对配置不合规；Shield Advanced 主要应对 DDoS。

3. （多选，选两项）关于 Amazon GuardDuty，正确的两项是：
   A. 必须先自己开启 VPC Flow Logs 并创建 CloudTrail trail
   B. 基础数据源包括 CloudTrail 管理事件、VPC 流日志与 DNS 日志，由 GuardDuty 独立采集
   C. 能检测应用层的登录爆破（大量 HTTP 401）
   D. 每个账号每个区域只有一个 detector，多账号可以通过委派管理员集中管理
   E. 发现恶意流量时会自动阻断

   **答案**：B、D。**解析**：GuardDuty 不需要你开启流日志或建 trail；它不分析应用日志与 HTTP 内容；它只告警不阻断。

### 清理说明

- 回收会删除 threat-detection 栈（规则、主题随之删除）；本会话新建的 detector 由回收器按“本会话开启的账号级开关”处理（02 §7）。只读接入时不改动已有 detector。
- **归档**本卡生成的示例发现与 DNS 金丝雀发现（步骤 7），尤其是只读接入时，以免与别人的真实发现混在一起。
- 起始状态中的 iam 随会话回收（平台模式下 iam 栈只附加只读策略，`CloudAlbumAppRole` 由回收器复位，02 §7.5 S6）。
- CloudShell 的出口地址被实验机的 fail2ban 封禁属于预期，封禁随实验机删除而消失；不要从 CloudShell 或工作台去扫描任何不属于本会话的地址（遵守 AWS 渗透测试政策）。
- 本卡没有开启任何保护计划；如果你在控制台手动开启过 S3 Protection、Runtime Monitoring 等，结束前关闭。

### 对应 SAA 考点

- GuardDuty 的基础数据源（CloudTrail 管理事件、VPC 流日志、DNS 日志）由它独立采集。
- 只检测、不阻断；EventBridge → SNS / Lambda 的自动响应。
- 发现的严重度、示例发现；多账户下的委派管理员；按区域启用。
- GuardDuty、Inspector、Macie、Detective、Security Hub 的区别。
- GuardDuty、AWS WAF、AWS Shield、Network Firewall、安全组 / 网络 ACL 各管哪一层。
- 可选保护计划：S3 Protection、Runtime Monitoring、Malware Protection 等。
- 在 CloudFront / ALB 后面获取真实客户端 IP（`X-Forwarded-For`）的意义。

---

<a id="svc-cost"></a>

## svc-cost：AWS Budgets：费用护栏与告警

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-cost` |
| kind | `service` |
| 标题 | AWS Budgets：费用护栏与告警 |
| 一句话简介 | 给项目装上费用护栏：本地计费资源清单“快而粗”，AWS Budgets 与 Cost Explorer“准而慢”，把两者并排看清。 |
| 涉及的 AWS 服务 | AWS Budgets（主）；AWS Cost Explorer、成本分配标签（AWS Billing）、Amazon SNS（模块自带 cost 主题，辅助） |
| 对应的模块 | `cost`（[06#cost](../../modules/06-governance-cost.md#cost)） |
| 难度 | 初级（`beginner`） |
| 预计时长 | 45 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 1 次，30 分钟 |
| startProfile | 见下表 |
| 目标模块 | `cost` → `COST_MODE=budgets`（`ProjectBudgetLimit`、`AccountBudgetLimit` 由学员填写、无默认值；`AlertEmail={{ learner.inputs.notify-email }}`；`EnableBudgetAction=false`，选做步骤改为 true） |
| 费用档位与主要计费来源 | **低**：普通预算的监控与通知免费；Cost Explorer API 按请求计费（本卡最多手动刷新一次）；启用了 Actions 的预算每月前两个免费（以官方定价为准） |
| 人工前置 | ① 成本分配标签 `Project`（建议同时激活 `atl:lab-id`、`atl:session-id`）已激活（学员前置输入 `cost-tags-active`）。学员边界只有 `ce:Get*/List*/Describe*`，激活走平台动作 `cost-activate-tags`（01 registry `platformActions` 的 `activateCostAllocationTags`；本卡在 `platformOps` 中声明它，选做）；`scripts/module enable cost` 的带外“激活标签”一步在平台模式下必须跳过或容忍拒绝，否则学员身份执行会因 `ce:UpdateCostAllocationTagsStatus` 被拒而中断（附 B-21）。标签出现在可激活列表约需 24 小时、激活后生效约再需 24 小时（以官方为准），Organizations 成员账号只能由管理账号激活，应在安装平台时或至少提前一天完成；② 账号已由根用户开启“IAM 用户和角色访问账单信息”，否则联合登录后的 Billing / Budgets 页面显示拒绝访问（原 05 lab-01 的说明；手册同时给出 CLI 路径）；③ 确认订阅邮件；④ 自定两个预算金额（本项目不提供参考价格） |
| SAA 考试领域 | 成本（cost） |
| 推荐的前置卡片 | `svc-ec2`（软依赖）；后续 `sc-cost-optimization` |
| 起始部署等级 | A |
| 完成徽章 | 「费用护栏」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | 本地估算从 L0 起就在运行：按 registry 的 `billing` × 模块启用时长列出计费资源 |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；cost 是 `credentials: optional`，第 2 轮不并入，本轮按 C3 预置 | 启用 cost 后 `/lab` 顶栏直接并排显示本地清单与 Budgets 的实际 / 预测 / 上限；Cost Explorer 也可以在工作台 CLI 中以学员身份查询（学员边界有 `ce:Get*`） |

**变量**：`projectBudgetLimit`、`accountBudgetLimit`（`from: input`，`fillFrom: learner.inputs.budget-amounts.project` / `.account`——学员前置输入 `budget-amounts`，05 §1.2；`pattern: '^[0-9]{1,6}(\.[0-9]{1,2})?$'`，单位为账单币种）。

### 实验简介

**背景**：本地估算启用即出现（“RDS 刚被打开”），但看不到真实账单、数据传输与请求类费用、手工创建的资源；Budgets 与 Cost Explorer 依据实际账单数据，准确但滞后数小时到一天，预测告警还需要足够的用量历史。本卡在一个会话内能看到的是“护栏怎么搭、两侧为什么不一致”；“告警真正响起”通常发生在会话结束之后（见“对比实验”）。

**你将学到**

- Budgets（成本、用量、RI / Savings Plans 预算；实际与预测告警；Budgets Actions）与 Cost Explorer、Cost Anomaly Detection 的分工。
- 成本分配标签：用户定义标签必须激活、激活有延迟、不追溯激活前的费用；组织中由管理账号激活。
- 抵扣额度会掩盖真实用量：预算要设为不计入抵扣额度。
- CloudWatch `EstimatedCharges` 账单告警（旧做法，us-east-1）与 Budgets 的对比；“按小时计费资源”的识别。

**实验资源**

- **实验机**（L0 + iam）：`/lab` 顶栏是本地计费资源清单。
- **工作台**：AWS CLI。
- **你将创建**：cost 栈——两个月度预算 `cloudalbum-<env>-project-monthly`（按 `Project=CloudAlbum` 筛选）与 `cloudalbum-<env>-account-monthly`（不筛选），实际 80%、预测 100% 两档通知，SNS 主题 `cloudalbum-<env>-cost` 与订阅；选做的预算动作与金丝雀角色 `cloudalbum-<env>-cost-canary`（本项目没有任何组件使用它）。
- **平台说明**：平台安装时可能已经创建了月度预算 `atl-platform-guard`（01 §3.10、02 §10.4），它属于平台，不属于本卡，不要修改或删除。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察顶栏本地清单：EC2 实例、公网 IPv4、EBS，“未填写单价，不显示金额”；注意清单里没有工作台与平台资源 | 观察 | `capability`：cost `driver=local`，detail 含“EC2”（`drift: once`）；`manual`：写出本地清单看不到的两类费用 |
| 2 | （选做）从官方定价页抄录单价到 `/etc/cloudalbum/cost-rates.yaml`，注明 `source` 与 `retrievedAt` | 代码 | `capability`：detail 含“估算”（once：第 4 步后 detail 改为 Budgets 的文案）；`manual`：缺 `source` 或 `retrievedAt` 的条目不参与估算（CFG-010） |
| 3 | 检查成本分配标签是否已激活：`aws ce list-cost-allocation-tags --tag-keys Project`；未激活时执行平台动作 `cost-activate-tags`（当场不会生效） | CLI | `aws-readonly`（`ce:ListCostAllocationTags`，`region: global`；04 §5.7 已收录，Cost Explorer API 可能按请求计费，检查结果缓存 30 分钟，`drift: once`）：`Project` 的 `Status=Active`；未激活也可以继续，项目预算会显示 0——这本身就是观察点 |
| 4 | 接入：`scripts/module enable cost --param ProjectBudgetLimit={{ var.projectBudgetLimit }} --param AccountBudgetLimit={{ var.accountBudgetLimit }} --param AlertEmail=…` | 脚本（wire） | `capability`：`driver=budgets`；`anyOf`：`op: healthy`，或 `status=degraded` 且探针 detail 只指向“成本分配标签尚未生效”（会话内通常等不到，又不是规则警告，不能写进 `expectedWarnings`）；订阅未确认用 `pendingIf` 等待；`local`（`module-state`）：cost 已启用；`aws-readonly`（`budgets:DescribeBudgets`，SDK 操作名，`labs:policy` 换算为 IAM 动作 `budgets:ViewBudget`，04 §5.7；`region: global`，Budgets 走 us-east-1 端点；`ownership: session`，预算是 cost 栈的成员）：两个预算存在、`TimeUnit=MONTHLY` |
| 5 | 确认订阅邮件 | 观察 | `manual`（原生）；`aws-readonly`（`sns:ListSubscriptionsByTopic`）：存在已确认的订阅 |
| 6 | 并排对照：`/lab` 顶栏的本地清单（立即）与 Billing 控制台中 Budgets 的本月实际 / 预测（滞后；新账号没有预测）；iam 已在起始状态中，启用 cost 后顶栏直接显示两侧 | 观察 | `manual`：记录同一时刻两侧的数值与差异原因；`experiment`（选做）：`cost/visibility-lag` 的 after（适配为同一时刻的快照） |
| 7 | （选做）在工作台执行一次 `aws ce get-cost-and-usage`（按请求计费），按 `Module` 标签分组，看“无标签”一组的大小（也可以用 `/lab` 的手动刷新，同样按请求计费） | 对比实验 | `experiment`（选做）：`cost/tag-coverage` 的 after |
| 8 | （选做）预算动作：`--param EnableBudgetAction=true`，查看动作配置（只作用于金丝雀角色），不等待触发 | 脚本 | `aws-readonly`（`budgets:DescribeBudgetActionsForBudget`，04 §5.7 已收录）：动作类型为附加 IAM 策略、目标是金丝雀角色 |

**最终复核**：cost 的 `driver=budgets`；`op: healthy`，或只因“成本分配标签尚未生效”而 `degraded`（与第 4 步相同的 `anyOf`；订阅已在第 5 步确认）。本卡没有必需的对比实验：模块文档的五个场景要么依赖账单数据的天级延迟、要么需要按小时计费的模块空开数小时（见“对比实验”），04 的完成条件也不要求每张卡片都有必需实验（`experiments` 为可选字段，04 §3.1）。

### 对比实验

引用 [06#cost §5](../../modules/06-governance-cost.md#cost)（`experiments/cost/`）。

| 场景 | 标签 | 本卡 | 没有它（本地估算） | 有它（Budgets + Cost Explorer） |
|---|---|---|---|---|
| `visibility-lag` | after | 选做，适配为“同一时刻两侧快照” | 资源启用即出现在清单中 | 费用出现在 Budgets / Cost Explorer 中要滞后数小时到一天；会话内通常只能看到“还没有” |
| `tag-coverage` | after | 选做 | 只知道经 `scripts/module` 启用的本项目模块 | 无标签费用只进入账号预算；按 `Module` 分组能看到“无标签”一组 |
| `threshold-alert` | — | 不纳入 | — | 账单数据至少每天更新一次，告警可能次日才到；会话回收时预算已被删除，学员收不到这封邮件 |
| `idle-reminder` | — | 不纳入 | 需要一个按小时计费的模块空开 1 小时以上 | 移到含按小时计费资源的卡片（如 `svc-db-proxy`）的“读一读” |
| `budget-action-canary` | after | 选做，只做配置部分 | 只能提醒 | 超过阈值时自动附加拒绝策略；触发同样受账单数据延迟影响 |

核心对照（06 §5）：依据（registry 计费维度 × 时长 vs 实际账单）、时效（启用即出现 vs 滞后）、金额（只在学员抄录单价后估算 vs 实际 + 预测）、覆盖（本项目模块 vs 账号全部费用）、告警（依赖实例 vs 与实例无关）、动作（只提醒 vs Budgets Actions）。

### 小测

1. （单选）财务要求在某个项目的月度费用**预计**将超出预算时提前收到邮件，并能按项目区分费用。最合适的做法是：
   A. 在 us-east-1 创建 CloudWatch `EstimatedCharges` 告警
   B. 激活项目的成本分配标签，用 AWS Budgets 按该标签建成本预算，并配置“预测花费超过 100%”的通知
   C. 每天在 Cost Explorer 中手工查看
   D. 使用 AWS Trusted Advisor 的成本检查

   **答案**：B。**解析**：Budgets 支持按成本分配标签筛选，并能基于预测发出告警（需要约 5 周的用量历史才会生成预测）；`EstimatedCharges` 账单指标只有账号总额与按服务的估算值，不能按标签区分，也不做预测（告警只在当前估算超过阈值时触发）；C 靠人工；D 的 Trusted Advisor 只给优化建议，不按项目做预算告警。

2. （单选）给资源打上 `Project` 标签后，在 Cost Explorer 中按 `Project` 分组却看不到任何费用。最可能的原因是：
   A. 标签值里含有中文
   B. 用户定义的标签必须先在 Billing 中激活为成本分配标签，激活有延迟，且不追溯激活前的费用
   C. 需要为实例开启详细监控
   D. 资源必须部署在 us-east-1

   **答案**：B。**解析**：只有激活后的成本分配标签才会出现在成本数据的分组中，并且从激活生效之后开始累计。

3. （单选）一个开发账号要求在月度花费超过阈值时，自动阻止开发者继续创建资源，而不仅仅是发通知。最合适的是：
   A. 配置 AWS Budgets Actions，在超过阈值时附加拒绝策略（IAM 策略或 SCP）
   B. 创建 CloudWatch 告警并配置 `terminate` 动作
   C. 启用 Cost Anomaly Detection
   D. 购买预留实例

   **答案**：A。**解析**：Budgets Actions 可以附加 IAM 策略或 SCP、停止 EC2 / RDS 实例；需要注意它依据的账单数据有延迟，适合作为月度护栏。B 只能作用于单个实例；C 只做异常检测与通知；D 与阻止创建无关。

### 清理说明

- 回收会删除两个预算、预算动作、金丝雀角色与 SNS 主题（预算是全局资源，回收器按 CloudTrail 台账在 us-east-1 侧核对）。
- **成本分配标签保持激活**，不随卡片停用（06 约定 8：停用会让按标签的历史分组出现断档）。
- `cost-rates.yaml` 在实验机数据卷上，随实验机删除；如果想保留抄录的单价，结束前自己复制一份到工作台以外的地方。
- Cost Explorer API 每次调用都计费，本卡只在步骤 7 手动刷新一次，不要反复刷新。
- 平台的 `atl-platform-guard` 预算不属于本卡，不要修改。

### 对应 SAA 考点

- AWS Budgets（成本、用量、RI / Savings Plans 预算；实际与预测告警；Budgets Actions）与 Cost Explorer、成本与使用情况报告、Cost Anomaly Detection、Pricing Calculator 的区分。
- 成本分配标签：用户定义与 AWS 生成；必须激活；有延迟；组织中由管理账号激活。
- CloudWatch 账单告警（`EstimatedCharges`，us-east-1）与 Budgets 的对比。
- 降本手段：按需 / Savings Plans / 预留实例 / Spot；Compute Optimizer；Trusted Advisor；关闭空闲资源。
- AWS Organizations 的合并账单与 SCP（Budgets Actions 可以附加 SCP）。
- 公网 IPv4、NAT Gateway、Interface Endpoint 都按小时计费——识别“按小时计费的资源”。

---

<a id="svc-compliance"></a>

## svc-compliance：AWS Config：配置合规与漂移检测

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-compliance` |
| kind | `service` |
| 标题 | AWS Config：配置合规与漂移检测 |
| 一句话简介 | 本地自检只看得到本机，AWS Config 只看得到 AWS 资源：用覆盖矩阵、SSH 金丝雀与主机漂移三个实验看清两者的互补。 |
| 涉及的 AWS 服务 | AWS Config（主）；Config 托管规则、Amazon EventBridge、Amazon SNS、Systems Manager Automation（修复，辅助）；Amazon EC2 安全组（观察） |
| 对应的模块 | `compliance`（[06#compliance](../../modules/06-governance-cost.md#compliance)） |
| 难度 | 中级（`intermediate`） |
| 预计时长 | 75 分钟 |
| 时间上限 | 120 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表 |
| 目标模块 | `compliance` → `COMPLIANCE_MODE=config`（`RecordingFrequency=CONTINUOUS`，只记录 6 类资源；`UseConformancePack=false`；`CanaryRemediation=true`；`AlertEmail={{ learner.inputs.notify-email }}`） |
| 费用档位与主要计费来源 | **中**（会话期间开启了账号级按量服务）：记录的配置项数量、规则评估次数、交付桶的 S3 存储与请求、SNS 邮件；不按小时计费。本卡只记录与项目有关的资源类型 |
| 人工前置 | 确认订阅邮件；账号已有客户托管的配置记录器时只读接入（不新建、不修改），若它没有记录规则所需的资源类型，模块为 `degraded`，覆盖矩阵中对应格子会一直“数据不足” |
| SAA 考试领域 | 安全（secure） |
| 推荐的前置卡片 | `svc-shell-access`、`svc-audit`（软依赖）；后续 `sc-security-baseline`、`sc-threat-compliance` |
| 起始部署等级 | A |
| 完成徽章 | 「合规守门」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | 本地配置自检规则集（C-L01～C-L16）每 5 分钟运行一次，读 root 安全快照 |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；compliance 是 `credentials: optional`，第 2 轮不并入，本轮按 C3 预置 | 必需实验 `coverage-matrix` 只调用 `/api/lab/compliance`、`ssh-canary` 轮询它直到 `restricted-ssh` 出现金丝雀（06#compliance §5 第 1、2 步），覆盖矩阵的“AWS Config”一列要靠应用凭证读取；第 2 轮“第 3 步由学员先执行 `enable iam`”的例外随之删除。compliance 仍为 `local` 时，账号层面的 4 项照样是“未知”，before 不受影响 |

### 实验简介

**背景**：L0 的本地自检能发现“sshd 允许密码登录”“机密文件权限不对”，但安全组、EBS 加密、S3 桶策略、CloudTrail 这些账号层面的配置，本机一概看不到，只能显示“未知”。AWS Config 记录资源的配置变化，用托管规则持续评估，不合规时经 EventBridge 通知，还能回放某个资源的配置时间线。

**你将学到**

- 配置记录器（每个账号每个区域一个客户托管记录器）、记录的资源类型、`CONTINUOUS` 与 `DAILY` 记录频率。
- 托管规则与自定义规则；配置变更触发与周期触发；按标签限定规则范围。
- 修复：修复配置调用 SSM Automation，手动或自动；自动修复会与 CloudFormation 管理的资源“拉锯”。
- Config 是**检测型**控制；SCP、IAM、S3 阻止公共访问是**预防型**控制。
- `restricted-ssh` 只认对全网开放的 22：对管理员 IP/32 开放不算违规。

**实验资源**

- **实验机**（L0 + iam）：`/lab` 合规卡片是一张覆盖矩阵，“AWS Config”一列全灰；第 3 步启用 Config 之后由应用填上。
- **工作台**：`npm run exp`、`faults/*.sh` 投递脚本、AWS CLI。
- **你将创建**：compliance 栈——配置记录器、交付通道与交付桶（只读接入时不建）、8 条托管规则（前缀 `cloudalbum-<env>-`，支持标签范围的按 `Project=CloudAlbum` 限定）、只挂在 `restricted-ssh` 上的手动修复配置、EventBridge 规则、SNS 主题 `cloudalbum-<env>-compliance` 与订阅；实验中临时创建的金丝雀安全组 `cloudalbum-<env>-canary-ssh`（不挂到任何实例）。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察合规卡片：本地自检“可评估 12 / 未知 4”，未知项是 C-L02、C-L04、C-L14、C-L15 | 观察 | `capability`：compliance `driver=local`、`localHealth=ok` |
| 2 | 记录 before：`coverage-matrix`（保存矩阵快照） | 对比实验 | `experiment`：`compliance/coverage-matrix` 的 before 有效 |
| 3 | 接入：`scripts/module enable compliance --param CanaryRemediation=true --param AlertEmail=…`（preflight `existing-config-recorder`） | 脚本（wire） | `capability`：compliance `driver=config`，`op: healthy`；“首轮评估未完成 / 订阅未确认”导致的 `degraded` 用 `pendingIf` 等待（等待型：通常 10 分钟，最长 30 分钟）；`local`（`module-state`）：compliance 已启用；`aws-readonly`（`config:DescribeConfigurationRecorderStatus`，不带 `ownership`：只读接入时记录器不是本会话创建的）：`recording=true`；`aws-readonly`（`config:DescribeConfigRules`）：前缀为 `cloudalbum-<env>-` 的规则 8 条 |
| 4 | 确认订阅邮件 | 观察 | `manual`（原生）；`aws-readonly`（`sns:ListSubscriptionsByTopic`，主题取 `stack.compliance.EnvComplianceTopicArn`）：存在已确认的订阅 |
| 5 | 记录 after：`coverage-matrix`，“未知”格子被 Config 列填上 | 对比实验 | `experiment`：`compliance/coverage-matrix` 的 pair 有效 |
| 6 | SSH 金丝雀：`faults/open-ssh-canary.sh` 建一个入站 22 对 `0.0.0.0/0` 开放的安全组（打 `Project=CloudAlbum` 标签、不挂实例）→ `restricted-ssh` 变为不合规并发邮件 → 只对它执行修复 → 回到合规 → 删除金丝雀 | 对比实验 | `experiment`：`compliance/ssh-canary` 的 after 有效；`manual`：记录不合规邮件的到达时间 |
| 7 | 主机漂移：`faults/sshd-password-on.sh` 放入允许密码登录的 sshd 片段 → 本地自检发现、Config 看不到 → 立即恢复 | 对比实验 | `experiment`：`compliance/host-drift` 的 after 有效；`local`（`sshd-state`）：恢复后 `passwordAuth=false` |
| 8 | （选做）时间线：在 Config 控制台或 `/api/lab/compliance/timeline` 查看金丝雀安全组的资源时间线（创建 → 加入 22/0.0.0.0/0 → 修复删除该规则 → 删除；已删除资源的历史仍保留，配置项的个数以实测为准） | 控制台 | `aws-readonly`（`config:GetResourceConfigHistory`，04 §5.7 已收录，`drift: once`）：金丝雀安全组至少有创建、加入规则、删除规则三个配置项 |

**最终复核**：compliance 的 `driver=config`、`op: healthy`（只读接入且外部记录器没有记录所需资源类型时允许 `degraded`，detail 须列出缺少的类型——这种情况属于“人工前置”中写明的已知限制）；`sshd-state` 的 `passwordAuth=false`；金丝雀安全组已删除（`aws-readonly`，`ec2:DescribeSecurityGroups`，按名称过滤结果为 0）；实验机安全组没有对全网开放 22。

### 对比实验

引用 [06#compliance §5](../../modules/06-governance-cost.md#compliance)（`experiments/compliance/`）。两侧同时运行，属于功能对比。

| 场景 | 标签 | 本卡 | 没有它（本地自检） | 有它（AWS Config） |
|---|---|---|---|---|
| `coverage-matrix` | before / after | 必需 | 只覆盖主机侧（sshd、文件权限、IMDSv2、应用开关），账号层面的 4 项为“未知” | 覆盖安全组、卷、桶、trail 等 AWS 资源侧；两侧交集很小（IMDSv2 是少数两边都看得到的项） |
| `ssh-canary` | after | 必需 | 完全看不到金丝雀安全组 | `CONTINUOUS` 记录下通常分钟级变为不合规（以实测为准），邮件随后到达；手动修复后回到合规 |
| `host-drift` | after | 必需 | 一个评估周期内发现 sshd 漂移 | 看不到操作系统内部——Config 不是主机加固工具 |
| `timeline` | after | 选做（步骤 8） | 只有本机检查项的状态变化 | 每个资源的配置时间线，可与 CloudTrail 关联回答“谁改的” |
| `tls-canary-bucket` | after | 选做 | 看不到 | `s3-bucket-ssl-requests-only` 对不带 TLS 拒绝语句的金丝雀桶判为不合规 |

### 小测

1. （单选）审计要求持续检查账号中所有安全组是否对 `0.0.0.0/0` 开放 22 端口，保留每个安全组配置随时间的变化，并在违规时通知。最合适的方案是：
   A. 启用 CloudTrail 并定期搜索 `AuthorizeSecurityGroupIngress`
   B. 启用 AWS Config 配置记录器与托管规则 `restricted-ssh`，经 EventBridge 把不合规事件发到 SNS
   C. 启用 Amazon GuardDuty
   D. 使用 Amazon Inspector 的网络可达性发现

   **答案**：B。**解析**：Config 持续评估规则并保留资源配置时间线。CloudTrail 记录 API 调用但不评估“当前是否合规”；GuardDuty 检测威胁行为；Inspector 的网络可达性关注实例端口是否可达，不提供安全组的配置历史与合规评估。

2. （单选）团队需要回答“这个安全组在什么时候被改成对全网开放 22、是谁改的”。应组合使用：
   A. AWS Config 资源时间线回答“改成了什么、何时”，CloudTrail 回答“谁调用了哪个 API”
   B. 只用 CloudWatch Logs
   C. 只用 GuardDuty
   D. VPC Flow Logs

   **答案**：A。**解析**：Config 记录配置项的变化，CloudTrail 记录调用者身份与 API；两者关联才能完整回答。

3. （多选，选两项）关于 AWS Config，正确的两项是：
   A. Config 规则能在不合规的配置变更发生前阻止它
   B. 每个账号每个区域只能有一个客户托管的配置记录器
   C. 可以通过修复配置调用 SSM Automation 文档，手动或自动修复不合规资源
   D. Config 可以评估 EC2 操作系统内部的 sshd 配置
   E. Config 规则只能周期触发

   **答案**：B、C。**解析**：Config 是检测型控制，不能阻止变更（预防要靠 SCP、IAM 等）；它看不到操作系统内部；规则可以由配置变更触发，也可以周期触发。

### 清理说明

- 回收会删除规则、修复配置、EventBridge 规则与 SNS 主题；本会话新建的记录器与交付通道由回收器停止并删除（“本会话开启的账号级开关”），交付桶清空后删除。只读接入时不碰已有记录器。
- **金丝雀必须当场删除**：`ssh-canary` 结束后确认 `cloudalbum-<env>-canary-ssh` 已删除；做过 `tls-canary-bucket` 的也要删除金丝雀桶。最终复核会检查安全组。
- `host-drift` 放入的 `/etc/ssh/sshd_config.d/99-canary.conf` 必须立即删除并 `systemctl reload sshd`；最终复核要求 `passwordAuth=false`。
- 不要把修复配置改为自动执行：它会修改基础栈管理的安全组，下一次栈更新又会改回去，形成拉锯。
- 起始状态中的 iam 随会话回收（平台模式下 iam 栈只附加只读策略，`CloudAlbumAppRole` 由回收器复位，02 §7.5 S6）。

### 对应 SAA 考点

- Config、CloudTrail、CloudWatch 的分工：配置与合规 / API 审计 / 指标与日志。
- 配置记录器：每账号每区域一个客户托管记录器；记录的资源类型；全局资源只在一个区域记录；`CONTINUOUS` 与 `DAILY`。
- 托管规则与自定义规则（Lambda、Guard）；变更触发与周期触发；规则范围（资源类型、标签）。
- 一致性包与组织级部署；聚合器汇总多账号多区域。
- 修复：SSM Automation，手动或自动；自动修复的副作用。
- Config 是检测型控制，SCP、IAM、S3 阻止公共访问是预防型控制；与 Security Hub 的关系（了解）。

---

<a id="svc-vuln-scan"></a>

## svc-vuln-scan：Amazon Inspector：漏洞扫描

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-vuln-scan` |
| kind | `service` |
| 标题 | Amazon Inspector：漏洞扫描 |
| 一句话简介 | 本机每天一次的 dnf 安全公告与 npm audit，对比 Amazon Inspector 对 EC2 的持续扫描与集中覆盖视图（Lambda、ECR 扫描作为讲解）。 |
| 涉及的 AWS 服务 | Amazon Inspector（主）；AWS Systems Manager 托管节点与 Inventory（辅助）；Amazon EventBridge、Amazon SNS（可选通知，本卡默认不建） |
| 对应的模块 | `vuln-scan`（[06#vuln-scan](../../modules/06-governance-cost.md#vuln-scan)） |
| 难度 | 中级（`intermediate`） |
| 预计时长 | 75 分钟 |
| 时间上限 | 150 分钟（含等待首轮覆盖与扫描） |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表：L0 + iam(role)（裁决 C3；iam 同时是 DEP-035 的硬依赖），档位 `atl/svc-vuln-scan/default` |
| 目标模块 | `vuln-scan` → `VULN_SCAN_MODE=inspector`（`VULN_SCAN_RESOURCE_TYPES=ec2`：本卡的起始状态没有 CloudAlbum 的 Lambda 函数，区域里的函数只有平台自身的，开启 Lambda 扫描只会扫描、计费平台函数而没有教学价值，与原 05 lab-25 的平台模式默认一致；模块文档的 enable 写死 `--resource-types EC2 LAMBDA`，06 PM-M34 已增加参数 `ScanTypes`（平台模式缺省只启用 EC2），附 B-19。深度检查自定义路径 `/opt/cloudalbum-releases`；`NotifyEmail` 为空，不建主题） |
| 费用档位与主要计费来源 | **中**（会话期间开启了账号级按量服务）：Inspector 按被扫描的 EC2 实例（按月折算）计费；新激活通常有试用期（以官方定价为准）。**激活是账号级的**：本区域所有 EC2 实例都会被扫描和计费，包括工作台 |
| 人工前置 | 在确认步骤中显式同意账号级激活；账号已启用 Inspector 时只读接入（不改深度检查路径，金丝雀相关的覆盖可能为 `degraded`） |
| SAA 考试领域 | 安全（secure） |
| 推荐的前置卡片 | `svc-shell-access`（软依赖）；后续 `svc-ami`、`sc-threat-compliance` |
| 起始部署等级 | A |
| 完成徽章 | 「漏洞雷达」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | root 定时器 `cloudalbum-vuln-scan.timer` 每天执行 `dnf updateinfo` 与 `npm audit`，写 `security/vuln-scan.json` |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；同时是硬依赖 DEP-035（必须是 role） | 基于代理的扫描与深度检查依赖 SSM Agent 把实例注册为托管节点；应用读取 Inspector 结果也需要凭证。平台模式下实例已因管理通道是托管节点，DEP-035 仍按 `IAM_CREDENTIALS` 判定 |

### 实验简介

**背景**：本地扫描只覆盖这一台机器、一天一次，还要实例能访问软件仓库与 npm registry；它看不到实际部署的 Lambda 函数。Inspector 在账号层面持续扫描 EC2 与 Lambda，新漏洞公布时自动重新评估，不需要手动发起。

**你将学到**

- Inspector（新版）对 EC2 的基于代理（SSM）与无代理（EBS 快照）扫描、对 Lambda 与 ECR 的扫描；扫描是持续的。
- Inspector Classic（评估模板、Inspector 代理）已停止支持，题库里的旧说法属于旧版。
- 深度检查默认只扫 `/usr/lib` 等路径，应用依赖装在 `/opt` 下要加自定义路径——这是本模块最重要的坑。
- Inspector 只发现，修补由 Patch Manager 完成；黄金 AMI 要定期重建并扫描。
- Inspector、GuardDuty、Macie、Config、Detective、Security Hub 的区分。

**实验资源**

- **实验机**（L0 + iam）：`/lab` 漏洞卡片左栏是本机扫描结果，可以点“立即扫描”。
- **工作台**：`npm run exp`、AWS CLI。
- **你将创建**：vuln-scan 栈（实例策略；可选的 EventBridge 规则与主题本卡不建）；带外操作——本区域 Inspector 的 EC2 扫描激活、深度检查自定义路径（由 `scripts/module` 记入 `state.json`）。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察漏洞卡片：本机扫描的生成时间、系统包公告数、npm 各级漏洞数；点“立即扫描” | 观察 | `capability`：vuln-scan `driver=dnf`、`localHealth=ok`；`local`（`file-stat`，`/var/lib/cloudalbum/security/vuln-scan.json`）：存在 |
| 2 | 记录 before：`coverage-matrix` | 对比实验 | `experiment`：`vuln-scan/coverage-matrix` 的 before 有效 |
| 3 | 接入：`scripts/module enable vuln-scan`（preflight `existing-inspector`、`inspector-deep-paths`；确认账号级激活） | 脚本（wire） | `capability`：`driver=inspector`、`op: healthy`（首轮覆盖前的 `degraded` 用 `pendingIf` 等待：通常 15 分钟，最长 45 分钟）；`local`（`module-state`）：vuln-scan 已启用；`aws-readonly`（`ssm:DescribeInstanceInformation`）：本实验机 `PingStatus=Online`（平台模式下从 L0 起就成立，只是前提的旁证，见约定 4）；`aws-readonly`（`inspector2:BatchGetAccountStatus`，不带 `ownership`：账号级开关）：EC2 为 `ENABLED`；`aws-readonly`（`inspector2:ListCoverage`，`resourceId={{ target.instanceId }}`）：`scanStatus.statusCode=ACTIVE` |
| 4 | 记录 after：`coverage-matrix`（EC2：本实验机；OS 包发现；Lambda 一栏为空，因为本卡没有部署 CloudAlbum 的函数） | 对比实验 | `experiment`：`vuln-scan/coverage-matrix` 的 pair 有效 |
| 5 | 对照两侧计数：为什么不一致（AL2023 发布版本锁定、深度检查路径、扫描节奏） | 观察 | `manual`：写出一条两侧都有、或只有一侧有的发现，并解释原因 |
| 6 | （选做）金丝雀包：`faults/plant-canary.sh` 安装一个已公开通告漏洞的旧版本依赖到不被应用加载的目录；本地扫描几分钟内发现 | 对比实验 | `experiment`（选做）：`vuln-scan/canary-package` 的 after；`aws-readonly`（`inspector2:GetEc2DeepInspectionConfiguration`，`when: envfile.vuln-scan.VULN_SCAN_ACTIVATION == 'project'`：只读接入时本卡不改别人的路径设置）：自定义路径含 `/opt/cloudalbum-releases` |
| 7 | （选做，做了第 6 步则必做）删除金丝雀：`faults/remove-canary.sh` | 脚本 | `manual`（带证据）：`ls /opt/cloudalbum-releases/canary` 返回不存在 |

**最终复核**：vuln-scan 的 `driver=inspector`、`status=ok`（只读接入、且账号原有的深度检查路径不含 `/opt/cloudalbum-releases` 时允许 `degraded`，detail 须指向该原因——这是“人工前置”中写明的已知限制）。

### 对比实验

引用 [06#vuln-scan §5](../../modules/06-governance-cost.md#vuln-scan)（`experiments/vuln-scan/`）。两侧同时运行，属于功能对比。

| 场景 | 标签 | 本卡 | 没有它（dnf + npm audit） | 有它（Inspector） |
|---|---|---|---|---|
| `coverage-matrix` | before / after | 必需 | 本实例系统包 + 发布包中 npm 生产依赖（随附的 Lambda 锁文件只能静态审计） | 本项目 EC2（本卡没有部署 Lambda，“已部署函数”一栏为空，组合场景中才有）；OS 包清单默认约 30 分钟评估一次（以官方文档为准） |
| `canary-package` | after | 选做 | 下一次运行（手动触发则几分钟内）发现 | 语言包属于深度检查，默认每 6 小时采集一次清单，**本卡时长内通常看不到**；只验证自定义路径已配置 |
| `time-to-detect` | — | 不纳入 | 每天一次 | 需要持续观察一周 |
| `network-reachability` | — | 不纳入 | 没有这一维度 | 网络可达性扫描每 12 小时一次，且需要临时实例与对全网开放 22 的金丝雀安全组，超出卡片时长 |

差别不在“谁更快”，而在**覆盖面与持续性**：Inspector 同时覆盖所有实例与函数，新漏洞公布时不用重新扫描就能更新结论。

### 小测

1. （单选）公司希望持续发现 EC2 实例与 Lambda 函数中的已知软件漏洞，并在新的 CVE 公布时自动重新评估，不想维护扫描计划。应使用：
   A. Amazon Inspector
   B. Amazon GuardDuty
   C. Amazon Macie
   D. AWS Config

   **答案**：A。**解析**：Inspector 持续扫描 EC2、Lambda 与 ECR 镜像中的漏洞。GuardDuty 检测威胁行为，Macie 发现 S3 中的敏感数据，Config 评估资源配置。

2. （单选）Inspector 显示某台 EC2 实例没有被基于代理的扫描覆盖（未由 SSM 管理）。最可能缺少的是：
   A. 安全组中允许 443 的入站规则
   B. 带 SSM 托管节点权限的实例角色，或 SSM Agent 未运行、无法访问 SSM 端点
   C. 账号没有启用 GuardDuty
   D. 实例没有公网 IP

   **答案**：B。**解析**：基于代理的扫描依赖实例是 SSM 托管节点：Agent、实例角色、到 SSM 端点的出站通路。不需要入站规则，也不需要公网 IP（私有子网可用 NAT 或接口端点）。

3. （多选，选两项）Inspector 报告了大量高危的操作系统包漏洞。要修补现有实例，并避免新启动的实例再次带着这些漏洞，应选择：
   A. 用 Systems Manager Patch Manager 在维护时段修补
   B. 让 Inspector 自动修补
   C. 用 EC2 Image Builder 定期重建并扫描黄金 AMI，再刷新 Auto Scaling 组
   D. 停用 Inspector 以减少发现数量
   E. 启用 Amazon Macie

   **答案**：A、C。**解析**：Inspector 只发现、不修补；Patch Manager 修补运行中的实例，定期重建的黄金 AMI 让新实例从一开始就是最新的。

### 清理说明

- 由本会话激活的 Inspector，回收时按“本会话开启的账号级开关”停用，并恢复原来的深度检查路径。**停用是账号级的**，会停止本区域所有实例与函数的扫描；只读接入时完全不动账号设置。
- 做过选做步骤 6 的，必须执行第 7 步删除金丝雀目录（它不被应用加载，但留在实例上会一直产生发现）。
- 激活期间工作台（以及账号里的其他 EC2 实例）也被扫描，这部分费用计入本会话（报告的费用一节单独列出）。本卡只启用 EC2 扫描类型，平台自身的 Lambda 函数不会被扫描；不要在控制台手动打开 Lambda 扫描。

### 对应 SAA 考点

- Inspector、GuardDuty、Macie、Config、Detective、Security Hub 的区分：漏洞 / 威胁 / 敏感数据 / 配置合规 / 调查 / 汇总。
- Inspector（新版）对 EC2（基于代理与无代理）、Lambda、ECR 的持续扫描；不需要手动发起评估。
- Inspector Classic 已停止支持，“评估模板、Inspector 代理”属于旧版。
- 发现经 EventBridge 驱动自动化；修补由 Patch Manager 完成。
- 网络可达性分析与安全组、NACL、路由的关系。
- 黄金 AMI 的漏洞管理：Image Builder 管道定期重建并扫描。

---

<a id="svc-db-proxy"></a>

## svc-db-proxy：Amazon RDS Proxy：数据库连接池

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-db-proxy` |
| kind | `service` |
| 标题 | Amazon RDS Proxy：数据库连接池 |
| 一句话简介 | 从“每个进程一个连接池”到本机 PgBouncer，再到托管的 RDS Proxy：数据库实际连接数从随进程线性增长变成一条平线。 |
| 涉及的 AWS 服务 | Amazon RDS Proxy（主）；Amazon RDS for PostgreSQL、AWS Secrets Manager（起始状态预置，辅助）；Amazon CloudWatch（代理指标，观察） |
| 对应的模块 | `db-proxy`（[06#db-proxy](../../modules/06-governance-cost.md#db-proxy)） |
| 难度 | 高级（`advanced`） |
| 预计时长 | 90 分钟 |
| 时间上限 | 180 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表：L0 + iam(role) + secrets + database（闭包，DEP-032）+ 本地档 `LB_LOCAL_WORKERS=2`，档位 `atl/svc-db-proxy/default` |
| 目标模块 | `db-proxy` → `DB_PROXY_MODE=rds-proxy`（`ProxyAuth=secrets`）；中间可选经过本地档 `pgbouncer` |
| 费用档位与主要计费来源 | **高**：RDS 实例按小时计费（起始状态就绪即开始）；RDS Proxy 按底层数据库实例的 vCPU 计时，状态变化后有最低计费时长；Secrets Manager 密钥按月折算与 API 调用；PgBouncer 不产生 AWS 费用 |
| 人工前置 | 无 |
| SAA 考试领域 | 高性能（连接复用）；弹性（故障转移时保持连接）；安全（Secrets Manager 与 IAM 认证） |
| 推荐的前置卡片 | `svc-database`、`svc-secrets`（软依赖）；后续 `sc-db-performance` |
| 起始部署等级 | C（含 RDS，02 §11.1） |
| 完成徽章 | 「连接池调度」 |

**startProfile（自动预置）**

按依赖顺序：iam → secrets → database（kms 不在闭包内）。

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | api、`api@3001`、worker 三个进程各有一个 Knex 连接池 |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；db-proxy、secrets 也都是 `credentials: required`（CRED-001） | 深度探针 `rds:DescribeDBProxy*`；应用经 SecretsPort 读数据库密码 |
| secrets | `SECRETS_DRIVER=secretsmanager` | 硬依赖 DEP-032（默认 `DB_PROXY_AUTH=secrets` 时） | 代理从 Secrets Manager 读取数据库凭证，应用必须用同一份密码连代理，避免轮换时两份分叉 |
| database | `DB_DRIVER=postgres`，RDS 单 AZ（`database.MultiAz=false`） | 硬依赖 DEP-032（RDS Proxy 只能代理 RDS / Aurora）；同时满足 DEP-033 | 单 AZ 控制部署时间与费用；故障转移对比为选做（见步骤 8） |
| 本地档 | `LB_LOCAL_WORKERS=2` | 本地档（总纲 10.4 规则 3，统一值 C18） | `conn-storm` 需要单机多进程，客户端连接数才会随进程数增长 |

使用默认 VPC 的默认子网（每个可用区一个），满足“代理子网至少覆盖两个 AZ”；不预置 network。端到端 IAM 认证变体（`ProxyAuth=iam`，最小依赖为 {iam, database}，DEP-036）不在本卡范围内。

### 实验简介

**背景**：没有代理时，数据库看到的连接数约等于“实例数 ×（api + worker 进程数）× `DB_POOL_MAX`”，扩容或连接风暴时容易打满 `max_connections`；故障转移时每个进程都要自己发现断连、等 DNS 指向新主库。本机 PgBouncer 能把一台机器上的连接收拢到一个池里，但多台实例仍各有一个池；RDS Proxy 把所有客户端连接收拢到托管的代理端点，在事务之间复用少量数据库连接。

**你将学到**

- RDS Proxy 解决的问题：Lambda 或 Auto Scaling 扩容时连接数暴涨、频繁建连的开销、故障转移绕过 DNS 传播。
- 约束：与数据库同一 VPC、不能公开访问；RDS 实例的代理只能关联写实例；默认端点跨两个 AZ；不支持 EC2 上自建的数据库（那是 PgBouncer 的位置）。
- 与 Secrets Manager、IAM 认证的集成（考试口径与 2025 端到端 IAM 新能力两栏）。
- 连接复用与“钉住”（pinning）：会话级 `SET`、advisory lock、临时表会让复用失效。
- 代理不是“让查询变快”的工具：单次查询多一跳网络延迟。

**实验资源**

- **实验机**（L0 + iam + 本地档 2 个 api 进程）：连接 RDS for PostgreSQL；`/lab` db-proxy 卡片显示“进程数 × 池上限 = 理论最大连接数”。
- **RDS**：单 AZ 的 PostgreSQL 实例，主密码在 Secrets Manager。
- **工作台**：k6、`npm run exp`（conn-storm、conn-churn、hop-latency、pinning）。
- **你将创建**：（选做）本机 PgBouncer；db-proxy 栈——代理 `cloudalbum-<env>-db-proxy`（`RequireTLS=true`）、目标组、代理安全组与代理角色、实例策略；database 栈经注入放行代理安全组的 5432；实例上的 Amazon Trust Services 根证书 `/etc/cloudalbum/amazon-trust-ca.pem`。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察 db-proxy 卡片与 `GET /api/lab/db-proxy/compare`：`pg_stat_activity` 的客户端地址是 EC2 的私有 IP | 观察 | `capability`：db-proxy `driver=none`；`capability`：database `driver=postgres`；`http-header`（`from: lab`，`target: self`，带探测令牌 `X-ATL-Probe-Token` 请求 `/api/lab/probe/now`，06 统一的探测端点）：`x-cloudalbum-path` 含 `database=postgres@rds`（以上三项描述起始状态，`drift: once`） |
| 2 | 记录 before：`conn-storm`（`DB_POOL_MAX` 依次 10、30、60）与 `conn-churn`（每次新建连接的短连接风暴） | 对比实验 | `experiment`：`db-proxy/conn-storm` 与 `db-proxy/conn-churn` 的 before 有效 |
| 3 | （选做）本地档：`scripts/module enable db-proxy --driver pgbouncer`，再跑一次 `conn-storm --label pgbouncer`（实验变体 `pgbouncer`，baseline，不进入必需的 pair，见下方说明），看单机收拢 | 脚本 | 以下三项都标（once）——第 4、5 步会撤下本地档：`capability`：`driver=pgbouncer`；`local`（`port-listen`，6432）：只监听 127.0.0.1；`http-header`（`from: lab`，`target: self`，`/api/lab/probe/now`）：含 `database=postgres@pgbouncer`；`experiment`（选做）：`db-proxy/conn-storm` 的 `pgbouncer` 变体 |
| 4 | （选做，做了第 3 步则必做）撤下本地档：`scripts/module disable db-proxy` | 脚本 | `local`（`port-listen`，6432）：不再监听 |
| 5 | 接入：`scripts/module enable db-proxy`（部署代理 → 等待目标可用 → 下载根证书 → `db:verify` → 滚动重启） | 脚本（wire） | `capability`：`driver=rds-proxy`、`status=ok`；`aws-readonly`（`rds:DescribeDBProxies`）：`Status=available`、`RequireTLS=true`、`EngineFamily=POSTGRESQL`；`aws-readonly`（`rds:DescribeDBProxyTargets`）：目标 `TargetHealth.State=AVAILABLE`；`http-header`（`from: lab`，`target: self`，`/api/lab/probe/now`）：含 `database=postgres@rds-proxy`（等待型：通常 15 分钟，最长 30 分钟） |
| 6 | 记录 after：`conn-storm` 与 `conn-churn`；同时看 `hop-latency`（直连与经代理各 N 次 `select 1`） | 对比实验 | `experiment`：`db-proxy/conn-storm`、`db-proxy/conn-churn` 的 pair 有效；`experiment`（选做）：`db-proxy/hop-latency` 的 pair |
| 7 | `pinning`：会话级 `SET` 后反复查询，被钉住的会话数上升；改为事务内 `SET LOCAL` 后回落 | 对比实验 | `experiment`：`db-proxy/pinning` 的 after 有效；`aws-readonly`（`cloudwatch:GetMetricData`，`AWS/RDS` 的 `DatabaseConnectionsCurrentlySessionPinned`，维度 `ProxyName`（取 `stack.db-proxy.InfoDbProxyName`），统计 `Sum`，1 分钟粒度；以官方文档为准，断言级别 `warn`）：步骤期间大于 0 |
| 8 | （选做）故障转移：把 RDS 修改为 Multi-AZ（耗时长，费用翻倍）后，直连与经代理各跑一次 `failover-probe`，比较写失败区间 | 对比实验 | `experiment`（选做）：`db-proxy/failover-proxy` 的 pair |

**最终复核**：db-proxy 为 `ok`；数据库请求经代理（`/api/lab/probe/now` 的路径头含 `database=postgres@rds-proxy`）。

### 对比实验

引用 [06#db-proxy §5](../../modules/06-governance-cost.md#db-proxy)（`experiments/db-proxy/`）。切换前 / 切换后对比，不做一半一半的运行时 A/B。

| 场景 | 标签 | 本卡 | 没有它（应用内连接池；本地档 PgBouncer） | 有它（RDS Proxy） |
|---|---|---|---|---|
| `conn-storm` | before / after | 必需 | 数据库连接数随进程数与池上限线性增长，超过 `max_connections` 后新连接失败；PgBouncer 把单机收拢为一个池 | 数据库连接数基本平稳，超出能力时在代理层排队，超过借用超时才拒绝 |
| `conn-churn` | before / after | 必需 | 每次建连都在数据库上做 TLS 握手与认证 | 握手终止在代理，建连延迟与数据库 CPU 更低（以实测为准） |
| `hop-latency` | before / after | 选做 | 直连 | 多一跳，亚毫秒到毫秒级（以实测为准） |
| `pinning` | after | 必需 | — | 会话状态让代理把会话钉在一个数据库连接上，复用失效 |
| `failover-proxy` | before / after | 选做（需 Multi-AZ） | 每个进程自己发现断连、等 DNS | 代理保持客户端连接并转给新主库，写失败区间更短（以实测为准） |

`conn-storm` 在模块文档中是三段式（`before | pgbouncer | after`）。04 v2 允许卡片声明任意实验变体（04 §3.2.10，裁决 C5）：本卡声明 `labels: [{ id: before, role: baseline }, { id: pgbouncer, role: baseline }, { id: after, role: treatment }]`、`pairs: [[before, after], [pgbouncer, after]]`、`requiredLabels: [before, after]`——必需的是 before / after 一对，PgBouncer 阶段作为选做变体记录，结果标注 `variant: pgbouncer`（附 B-1 已解决）。

### 小测

1. （单选）Lambda 函数在流量高峰时打满了 RDS for PostgreSQL 的 `max_connections`。在尽量少改代码的前提下，最合适的做法是：
   A. 把数据库实例规格调大
   B. 在 Lambda 与 RDS 之间加入 RDS Proxy，数据库凭证放在 Secrets Manager
   C. 把数据迁移到 DynamoDB
   D. 把 Lambda 的预留并发设为 0

   **答案**：B。**解析**：RDS Proxy 复用少量数据库连接，吸收客户端连接的突增，应用只需把连接端点改为代理端点。A 只能提高上限、治标不治本；C 改造量大；D 会让函数完全不可用。

2. （多选，选两项）关于 Amazon RDS Proxy，正确的两项是：
   A. 可以代理 EC2 上自建的 PostgreSQL
   B. Multi-AZ 故障转移时保持客户端连接，减少应用感知到的中断
   C. 必须与数据库位于同一个 VPC，且不能公开访问
   D. RDS 实例的只读副本可以作为代理目标被池化
   E. 可以替代缓存，让查询本身更快

   **答案**：B、C。**解析**：RDS Proxy 只支持 RDS 与 Aurora；RDS 实例的代理只能关联写实例；代理会多一跳延迟，不是缓存。

3. （单选）应用在每个连接建立后执行会话级 `SET`。改用 RDS Proxy 后，被钉住的会话数持续升高，连接复用效果很差。应该：
   A. 调大代理的 `MaxConnectionsPercent`
   B. 改为在事务内使用 `SET LOCAL`，或把这些设置改为数据库用户级默认值，避免会话状态
   C. 关闭客户端到代理的 TLS
   D. 让应用改连只读副本

   **答案**：B。**解析**：会话级状态会让代理把会话固定在一个数据库连接上；消除会话状态才能恢复复用。A 只是放宽上限；C、D 与钉住无关。

### 清理说明

- 回收顺序（02 §7.5 的 S2 阶段）：RDS Proxy → RDS 实例（关闭删除保护、跳过最终快照、删除自动备份）→ Secrets Manager（立即删除，不进入恢复窗口）。代理是按小时计费资源，练完建议尽快“结束实验”，不要保留环境。
- 做过选做步骤 8 的：Multi-AZ 让 RDS 费用翻倍，做完立即结束实验。
- 读一读（承接 svc-cost 的 `idle-reminder`）：`/lab` 顶栏的本地计费清单从起始状态就列出“RDS 实例 ×1”，启用代理后多出“RDS Proxy ×1”，并显示各自已启用的时长；本地空开提醒默认在按小时计费的资源空开 4 小时后才触发，本卡时长内不会出现，它提醒的正是“练完忘了关”这种情况。
- 不要创建额外的代理端点（经 PrivateLink 另行计费），也不要修改或删除代理自动创建的 `rdsproxyadmin` 数据库用户。
- 做过选做步骤 3 但没有做第 4 步的，`scripts/module enable db-proxy` 会因 MUTEX-006（RDS Proxy 与本机 PgBouncer 二选一）拒绝继续——先 `disable` 再启用。

### 对应 SAA 考点

- RDS Proxy 解决的问题：Lambda / Auto Scaling 扩容时的连接数暴涨、频繁建连的开销、故障转移时间。
- 支持的引擎（RDS for MySQL、MariaDB、PostgreSQL、SQL Server 与 Aurora，以官方支持表为准）；不支持 EC2 自建数据库。
- 与 Secrets Manager、IAM 认证的集成；2025 起支持端到端 IAM 认证。
- 约束：同一 VPC、不能公开访问、RDS 实例只能关联写实例、默认端点跨两个 AZ。
- 连接复用与钉住；事务级复用。
- 与自建 PgBouncer、应用内连接池、Aurora Serverless / Data API 的取舍（了解）。
- 计费：按底层实例 vCPU 计时，属于按小时计费的资源。

---

<a id="svc-workflow"></a>

## svc-workflow：AWS Step Functions：照片处理流程编排

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-workflow` |
| kind | `service` |
| 标题 | AWS Step Functions：照片处理流程编排 |
| 一句话简介 | 把“缩略图 → 决定 → 写回”的编排从 EC2 进程内搬到 Step Functions：每一步的重试都看得见，EC2 上的应用中断时流程照样跑完。 |
| 涉及的 AWS 服务 | AWS Step Functions（主）；AWS Lambda（缩略图任务）、Amazon EventBridge（启动与失败回报规则）、Amazon SQS（模块自带结果队列与 DLQ）、Amazon S3（起始状态预置）（辅助） |
| 对应的模块 | `workflow`（[06#workflow](../../modules/06-governance-cost.md#workflow)） |
| 难度 | 中级（`intermediate`） |
| 预计时长 | 75 分钟 |
| 时间上限 | 120 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表：L0 + iam(role) + storage（闭包，DEP-034）+ 本地档 + 运行时热键 `lab.faults`，档位 `atl/svc-workflow/default` |
| 目标模块 | `workflow` → `WORKFLOW_DRIVER=stepfunctions`（`StateMachineType=STANDARD`，`FaultRate=0`；tagging 未启用，状态机跳过 Rekognition 分支） |
| 费用档位与主要计费来源 | **低**：Standard 状态机按状态转换次数；缩略图 Lambda 按请求与时长；结果队列按请求；S3 存储与请求；状态机日志组的摄取 |
| 人工前置 | 无（工具链栈由运行器 `base-deploy` 在会话开始时创建，约定 3 第 8 条） |
| SAA 考试领域 | 弹性（编排状态与实例解耦、重试与 redrive）；高性能（把 CPU 密集任务移出 EC2） |
| 推荐的前置卡片 | `svc-storage`、`svc-image-processing`（软依赖）；后续 `sc-image-pipeline` |
| 起始部署等级 | A（起始状态只有 iam 与 storage 两个“快”类栈；缩略图任务 Lambda 属于目标模块，在卡片内部署，与原 05 lab-11-x-workflow 的 A 级一致） |
| 完成徽章 | 「流程编排」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | 进程内 `PhotoPipeline` 编排，每步写 `job_runs` |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；storage、workflow 也都是 `credentials: required`（CRED-001） | worker 轮询结果队列、`describe()` 读执行历史 |
| storage | `STORAGE_DRIVER=s3` | 硬依赖 DEP-034 | 状态机由 S3 → EventBridge 启动，Lambda 读不到 EBS |
| （工具链栈） | 平台固定部分，不是 startProfile 项 | 硬依赖 DEP-034（部署检查）；`prerequisites: [toolchain]` | 平台模式下运行器 `base-deploy` 已创建工具链栈并把预构建 Lambda 包复制进工具链桶（01 §3.4、§4.5），DEP-034 的部署检查天然满足；列在这里只为说明闭包已完整 |
| 本地档：worker + memory 队列 | `IMAGE_PROCESSOR=worker`、`QUEUE_DRIVER=memory` | 本地档（与档位 `x-workflow` 的 worker 取值一致）；DEP-004；满足 MUTEX-005（`IMAGE_PROCESSOR≠lambda`） | “没有 Step Functions”一侧的缩略图在 EC2 上异步处理，才能和状态机比较 EC2 CPU 与中断后的行为 |
| 运行时热键 | `featureFlags['lab.faults']=true` | 运行时 | inline 一侧的重试对照要对 image 端口注入 `error5xx` |

不预置 tagging（Rekognition 并行分支）与 queue(sqs)：前者放在 `sc-image-pipeline`，后者不是本模块的依赖（结果队列是模块自带的 `auxQueues`）。

### 实验简介

**背景**：L0 的照片处理由 EC2 进程内的 `PhotoPipeline` 编排，编排状态只在进程里：api 或 worker 在两步之间倒下，照片就停在 `PROCESSING`，要靠对账任务兜底，重试过几次只能查表。启用后 S3 → EventBridge 直接启动 Standard 状态机：缩略图 Lambda → 结果写进自带的结果队列 → worker 消费后用与 inline 相同的纯函数决定 READY / BLOCKED。

**你将学到**

- 编排（Step Functions）与编舞（EventBridge / SNS / SQS 串联）的区别。
- Standard 与 Express：最长时长、执行语义（恰好一次 / 至少一次）、计费维度、执行历史的位置。
- `Retry` / `Catch` 与内置错误名；为什么不能用 `Catch: [States.ALL]` 把失败“吞掉”；失败执行在 14 天内可以 redrive。
- S3 事件通知不能直接以 Step Functions 为目标，要经 EventBridge；写回必须幂等。

**实验资源**

- **实验机**（L0 + iam + storage(s3) + 本地档）：照片详情页“处理流程”抽屉画出 `job_runs` 时间线（`executor=worker`）。
- **工作台**：k6、`npm run exp`（upload-burst、worker-down、retry-visibility、redrive）。
- **你将创建**：workflow 栈——缩略图 Lambda `cloudalbum-<env>-workflow-thumb`（`nodejs22.x`、arm64）、状态机 `cloudalbum-<env>-photo-pipeline` 与执行角色、启动规则与失败回报规则、结果队列 `cloudalbum-<env>-workflow-results` 与两个 DLQ、日志组 `/aws/vendedlogs/states/cloudalbum-<env>-photo-pipeline`、实例策略。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察照片详情的“处理流程”抽屉：`job_runs` 时间线，`executor=worker` | 观察 | `capability`：workflow `driver=inline`（`drift: once`）；`capability`：storage `driver=s3`；`capability`：image-processing `driver=worker` |
| 2 | 记录 before：`upload-burst`（EC2 CPU、缩略图就绪时间）；`worker-down`（按本卡适配：上传 20 张后立即停 api 与 worker 2 分钟再启动——memory 队列在 api 进程内，任务随进程消失，照片停在 `PROCESSING`，等 `image.reconcile` 兜底）。两个实验做完后，对 image 端口注入 `error5xx` 再上传 5 张，留下 inline 的重试记录供第 7 步对照 | 对比实验 | `experiment`：`workflow/upload-burst` 与 `workflow/worker-down` 的 before 有效 |
| 3 | 接入：`scripts/module enable workflow` | 脚本（wire） | `capability`：`driver=stepfunctions`、`status=ok`；`local`（`module-state`）：workflow 已启用；`aws-readonly`（`events:DescribeRule`）：启动规则 `ENABLED`；`aws-readonly`（`lambda:GetFunctionConfiguration`）：`Runtime=nodejs22.x`、`Architectures` 含 `arm64`；`aws-readonly`（`sqs:GetQueueAttributes`）：结果队列存在且配置了 DLQ；`aws-readonly`（`states:DescribeStateMachine`）：`status=ACTIVE`、`type=STANDARD`；`local`（`path-seen`，段 `workflow=stepfunctions:started`，窗口 30 分钟，排除探测流量；04 §6.4 已登记，见约定 4）：至少 1 次（等待型，由第 4 步的冒烟上传触发，最长 15 分钟） |
| 4 | 冒烟：上传一张照片，在控制台打开这次执行的执行图；照片详情显示“由 AWS Step Functions 编排” | 控制台 | `aws-readonly`（`cloudwatch:GetMetricData`，`AWS/States` / `ExecutionsSucceeded`，维度 `StateMachineArn` 取 `stack.workflow.EnvWorkflowStateMachineArn`）：最近 30 分钟之和 ≥ 1（等待型，最长 10 分钟；`drift: once`）；`manual`：记录执行 ID 与各步骤耗时 |
| 5 | 记录 after：`upload-burst` | 对比实验 | `experiment`：`workflow/upload-burst` 的 pair 有效 |
| 6 | 记录 after：`worker-down`——与 before 相同的故障（上传 20 张后立即停 api 与 worker 2 分钟再启动）：执行全部成功，结果在队列里等着，worker 启动后补写 | 对比实验 | `experiment`：`workflow/worker-down` 的 pair 有效 |
| 7 | 重试可见性：`--param FaultRate=0.3` 重新 enable，上传 20 张，在执行图中数出重试；对照 inline 档 `job_runs` 中的重试记录（这份记录要在第 2 步的 before 实验做完、接入之前留下：用 `POST /api/lab/faults` 对 image 端口注入 `error5xx` 后上传几张，06#workflow §5 第 2 步）；做完以 `FaultRate=0` 再 enable 一次 | 对比实验 | `experiment`：`workflow/retry-visibility` 的 after 有效；`aws-readonly`（`lambda:GetFunctionConfiguration`）：函数环境变量中的故障率已回到 0（变量名以模板为准，断言级别 `warn`） |
| 8 | （选做）redrive：`FaultRate=1` 让执行以 `FAILED` 结束、照片被置为 `FAILED` → `FaultRate=0` → `aws stepfunctions redrive-execution`，执行从 `Thumbnail` 继续，照片变为 `READY` | 对比实验 | `experiment`（选做）：`workflow/redrive` 的 after |

**最终复核**：workflow 的 `driver=stepfunctions`；`anyOf`：`op: healthy`，或 `status=degraded` 且 detail 只指向“最近 1 小时有失败执行”（步骤 7、8 故意制造的失败会让模块在 1 小时内显示 `degraded`；这是探针结果，不是规则警告，不能写进 `expectedWarnings`，见附 B-10）；启动规则为 `ENABLED`。

### 对比实验

引用 [06#workflow §5](../../modules/06-governance-cost.md#workflow)（`experiments/workflow/`）。切换前 / 切换后对比（workflow 属于不做运行时 A/B 的模块）。

| 场景 | 标签 | 本卡 | 没有它（进程内编排） | 有它（Step Functions Standard） |
|---|---|---|---|---|
| `upload-burst` | before / after | 必需 | 缩略图在 EC2 上算，突发时 EC2 CPU 尖峰 | EC2 只做结果写回，CPU 平稳；就绪时间包含 Lambda 冷启动的尾部 |
| `worker-down` | before / after | 必需（两侧都按本卡适配为“停 api 与 worker”） | 编排状态与进程同生共死：重启后照片停在 `PROCESSING`，等对账任务 | 执行照常跑完，结果留在队列里，worker 恢复后几秒内补写 |
| `retry-visibility` | after | 必需 | 重试只能查 `job_runs` | 执行图上逐次可见，`ExecutionsFailed` 等指标同步变化 |
| `redrive` | after | 选做 | 无对应机制 | 失败执行 14 天内从失败步骤继续 |
| `express-vs-standard` | — | 不纳入 | — | 作为延伸阅读：Express 的执行历史只在日志组，不发送执行状态变更事件，失败要靠 `image.reconcile` 兜底；在 `sc-image-pipeline` 中对照 |

**`worker-down` 的适配**：模块文档的 before 以 `x-workflow`（`QUEUE_DRIVER=sqs`）为前提，故障是“停 worker”。本卡没有 queue 模块，memory 队列在 api 进程内消费（DEP-004 的说明），只停 worker 看不到问题，所以故障改为“上传后停 api 与 worker 2 分钟再启动”（`faults/stop-app.sh`，与 monitoring 的 `kill-test` 共用）。**before 与 after 用同一个故障**：04 §7.4 第 8 步要求 pair 两侧的场景与参数一致，两侧故障不同会被判为不可比。after 侧停掉 api 不影响结论——执行由 S3 → EventBridge 启动，与 EC2 无关。需要 `worker-down` 脚本支持 `--fault stop-app`（列入 06，附 B-10）。

### 小测

1. （单选）图片上传后要依次生成缩略图、识别内容、决定是否公开，每一步都需要可见的重试与失败处理，且流程状态不能因为 EC2 重启而丢失。最合适的方案是：
   A. 在 EC2 上用 cron 定时扫描新照片并顺序处理
   B. 用 AWS Step Functions Standard 状态机编排各步骤，由 S3 事件经 EventBridge 启动执行
   C. 把 S3 事件通知的目标直接设为 Step Functions 状态机
   D. 用一个 Lambda 函数依次同步调用其他 Lambda 函数

   **答案**：B。**解析**：Standard 状态机在服务端保存执行状态，Retry / Catch 与执行图让重试可见。S3 事件通知不能直接以 Step Functions 为目标，要经 EventBridge（C 错）；A 的状态仍在 EC2 上；D 的编排状态在函数内存里，超时与重试难以管理。

2. （单选）一个流程每秒触发数千次，每次在几秒内完成，可以接受至少一次语义，希望成本最低。应选择：
   A. Step Functions Standard 工作流
   B. Step Functions Express 工作流
   C. Amazon SWF
   D. 由 Lambda 递归调用自身

   **答案**：B。**解析**：Express 面向高频、短时（最长 5 分钟）的流程，按请求与时长计费，异步执行为至少一次语义；Standard 按状态转换计费，适合长时间、需要恰好一次语义与执行历史的流程。

3. （多选，选两项）Standard 状态机中的缩略图任务偶发失败。团队希望暂时性错误自动重试；修复函数后能让失败的执行从失败的那一步继续；并且失败在指标与告警中可见。应选择：
   A. 在 Task 状态上为暂时性错误配置 `Retry`
   B. 用 `Catch: [States.ALL]` 接住所有错误，然后转到 Succeed 状态结束
   C. 修复后对失败的执行使用 redrive
   D. 改用 Express 工作流以获得执行历史
   E. 删除状态机后重建

   **答案**：A、C。**解析**：用 `Catch: [States.ALL]` 接住后正常结束会让执行显示 `SUCCEEDED`，失败指标不涨、也无法 redrive；Express 的执行历史只在 CloudWatch Logs，不支持 redrive。

### 清理说明

- 回收会先禁用启动规则、等待进行中的执行结束，再删除 workflow 栈；状态机日志组按 `Retain` 保留，回收器按 `RETAINED` 来源删除（02 §7.1）；缩略图 Lambda 自动创建的 `/aws/lambda/…` 日志组按派生规则删除（02 §7.4）。起始状态的 S3 桶（storage）与工具链栈也属于本会话，由回收器删除（桶先清空全部版本）。
- 结束前把 `FaultRate` 恢复为 0（步骤 7 已要求）；如果做了 redrive 实验，确认没有仍处于 `RUNNING` 的执行。
- 不要手动给原图桶加 S3 事件通知（MUTEX-004：只允许 EventBridge 投递），也不要再启用 `IMAGE_PROCESSOR=lambda`（MUTEX-005：会重复处理）。

### 对应 SAA 考点

- 编排（Step Functions）与编舞（EventBridge / SNS / SQS）的取舍。
- Standard 与 Express：最长一年 vs 五分钟；恰好一次 vs 至少一次；按状态转换 vs 按请求与时长计费；执行历史的位置。
- 状态类型（Task、Choice、Parallel、Map、Wait、Pass、Succeed、Fail）；`Retry` / `Catch`；`States.ALL`、`States.TaskFailed`、`States.Timeout`。
- 服务集成模式：请求响应、`.sync`、`.waitForTaskToken`；优化集成与 AWS SDK 集成。
- 触发方式：EventBridge 规则、API Gateway、SDK；S3 事件通知不能直接以 Step Functions 为目标。
- 幂等与重复投递；DLQ；redrive；Step Functions 的 X-Ray 集成。

---

<a id="svc-ami"></a>

## svc-ami：EC2 Image Builder：黄金 AMI 构建

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-ami` |
| kind | `service` |
| 标题 | EC2 Image Builder：黄金 AMI 构建 |
| 一句话简介 | 把“公共 AMI + 开机现场安装”换成 Image Builder 烘焙、测试、晋升的黄金 AMI：开机更快、启动不再依赖外部仓库，但镜像会老化。 |
| 涉及的 AWS 服务 | EC2 Image Builder（主）；AWS Systems Manager Parameter Store（AMI ID 参数）、Amazon EC2 与 EBS 快照（辅助） |
| 对应的模块 | `ami`（[06#ami](../../modules/06-governance-cost.md#ami)） |
| 难度 | 中级（`intermediate`） |
| 预计时长 | 135 分钟（含镜像构建与测试、实例替换的等待；临时实例串行启动，见费用一行） |
| 时间上限 | 210 分钟 |
| 可延长次数 | 2 次，每次 30 分钟 |
| startProfile | 见下表 |
| 目标模块 | `ami` → `AMI_SOURCE=golden`（`Architectures=arm64`，与 t4g 实验机一致；`PipelineSchedule=manual`；`KeepImages=2`；`EnableImageScanning=false`） |
| 费用档位与主要计费来源 | **中**：Image Builder 本身不收费；临时 EC2——构建实例、测试实例、`boot-time`（与选做的 `dependency-failure`）的实验实例——**同一时刻至多 1 台**，在 `cost.basis` 中按 1 个单位声明（实验脚本串行启动，不要在镜像构建期间跑 `boot-time`；并行运行时按 05 目录总则的费用档位算法应计 2 个单位、档位为“高”）；黄金 AMI 的 EBS 快照存储（按版本数累加） |
| 人工前置 | 无；切换时有一次停机窗口（替换实例） |
| SAA 考试领域 | 弹性（不可变基础设施、扩容速度）；高性能（缩短启动时间）；安全（镜像一致性与补丁节奏） |
| 推荐的前置卡片 | `svc-ec2`、`svc-shell-access`（软依赖）；后续 `svc-autoscaling`、`svc-vuln-scan`、`sc-ha-web` |
| 起始部署等级 | A（起始状态快；卡片内的镜像构建与实例替换都较慢） |
| 完成徽章 | 「黄金镜像」 |

**startProfile（自动预置）**

| 预置项 | 取值 | 依据 | 原因 |
|---|---|---|---|
| ec2（L0） | 基础栈 | base | 基础栈 `ImageId` 指向首次部署时固定的 AL2023 公共 AMI 参数；引导脚本把各阶段耗时写进 `bootstrap-timing.json` |
| iam | `IAM_CREDENTIALS=role` | 凭证（裁决 C3）；ami 是 `credentials: optional`，第 2 轮不并入，本轮按 C3 预置 | ami 感知器能读取晋升参数，不再因 CRED-004 停在 `degraded`；“切换是否生效”仍以 `ec2:DescribeInstances` 的 `ImageId` 检查为准 |

不预置 autoscaling：黄金 AMI 对扩容速度的影响放在 `svc-autoscaling` 与 `sc-ha-web`；本卡只做单实例替换。

### 实验简介

**背景**：每台新实例都从 AL2023 公共 AMI 启动，再由 `l0-bootstrap.sh` 现场 `dnf install` 并下载发布包（独立模式下来自 GitHub Release；平台模式下来自同区域工具链桶的预签名 URL，01 §4.5）——启动慢、依赖软件仓库与发布包地址在那一刻可用，不同时间启动的实例软件版本可能不同。Image Builder 管道把同样的安装步骤提前烘焙进 AMI，测试通过后写入 SSM 参数；显式“晋升”后基础栈才改用它。

**你将学到**

- Image Builder 的组成：组件、配方、基础设施配置、分发配置、管道；测试阶段。
- 黄金 AMI 与 User Data 现场安装的取舍：启动速度、一致性、灵活性；不可变基础设施（替换而不是修补）。
- 用 SSM 参数发布 AMI ID；CloudFormation 中 SSM 参数类型在每次栈更新时重新解析——只能指向“已晋升”参数。
- AMI 是区域性的；注销 AMI 不会删除快照；共享加密 AMI 需要共享 KMS 密钥权限。
- 镜像会老化：管道要定期重建并扫描。

**实验资源**

- **实验机**（L0 + iam）：ec2 卡片显示“AMI 来源：AL2023 公共 AMI”与上次引导的安装耗时。
- **工作台**：`npm run exp`（boot-time、dependency-failure 会以学员身份启动临时实例）、`scripts/module ami build | promote`。
- **你将创建**：ami 栈——组件 `cloudalbum-runtime` 与 `cloudalbum-validate`、arm64 配方、基础设施配置（自带构建角色）、分发配置（写 `/cloudalbum/<env>/ami/latest-arm64`）、管道 `cloudalbum-<env>-golden-arm64`；带外的晋升参数 `/cloudalbum/<env>/ami/promoted-arm64`；黄金 AMI 与快照；实验用的临时实例与实验安全组（脚本用完即删）。
- **平台说明**：
  - 切换会替换实验机（实例 ID 变化，数据卷与 EIP 保留）。平台不缓存实例 ID，每次检测按标签 `atl:env-id` + `atl:role=lab-app` + 栈名重新发现（01 §9.8、04 §5.2.1）；第 5 步声明 `expectedOutage: { channel: lab, maxMinutes: 25 }`，替换期间的 `CHANNEL_DOWN` 显示为“预期中断”；实例 ID 变化后 `local`、`capability`、`http-header(lab)` 的旧证据自动过期（04 §5.8、01 §9.8；04 R-27 已撤销 `atl.session.target-changed` 事件）。新实例由引导脚本从发布包装好检查包（04 §6.2），并由 State Manager 关联 `atl-prepare-instance` 重建 `labuser` 与终端集成（03 §3.4）。
  - **临时实例与构建实例的标签**：实验脚本启动的临时实例、Image Builder 的构建与测试实例都必须带 `atl:session-id`、`atl:env-id`（回收器与归属）与实验专用标签，但**绝不能**带 `atl:role=lab-app` 或 `workstation`：前者会让平台“按标签发现实验机”同时命中多台（`target.*`、第 5 步的 `DescribeInstances` 检查都会出错），两者都会让 `atl-prepare-instance` 在其上执行，把 `labuser` 与 `/opt/atl` 烘焙进黄金 AMI（附 B-13）。

### 步骤大纲

| # | 步骤 | 类型 | 检查（类型：判定要点） |
|---|---|---|---|
| 1 | 观察 ec2 / ami 卡片：AMI 来源、上次引导的安装阶段耗时 | 观察 | `capability`：ami `driver=userdata`（`drift: once`）；`manual`：记录 `bootstrap-timing.json` 中安装阶段的秒数 |
| 2 | 记录 before：`boot-time`，用公共 AMI 启动临时实例（每轮 1 台、串行 3 轮，06#ami §5 第 1 步“重复 3 次”），从控制台输出读 `CLOUDALBUM_TIMING` 行 | 对比实验 | `experiment`：`ami/boot-time` 的 before 有效 |
| 3 | 构建与晋升（不切换）：`scripts/module enable ami --no-switch`（部署栈 → `ami build --arch arm64` → `ami promote`） | 脚本 | `aws-readonly`（`cloudformation:DescribeStacks`，`cloudalbum-<env>-ami`）：`CREATE_COMPLETE` 或 `UPDATE_COMPLETE`；`aws-readonly`（`imagebuilder:ListImagePipelineImages`）：最近一次构建为 `AVAILABLE`（等待型：通常 40 分钟，最长 60 分钟）；`manual`（带证据）：`aws ssm get-parameter --name /cloudalbum/<env>/ami/promoted-arm64` 的值以 `ami-` 开头 |
| 4 | （选做）在切换前执行一次 `scripts/module rebuild-instance`，记录 userdata 下替换实例的停机时长 | 对比实验 | `experiment`（选做）：`ami/rebuild-swap` 的 before |
| 5 | 接入：`scripts/module enable ami`（基础栈 `ImageId` 改为晋升参数 → 替换实例的流程，有停机窗口） | 脚本（wire） | `capability`：`driver=golden`，`op: healthy`；`local`（`module-state`）：ami 已启用；`aws-readonly`（`ec2:DescribeInstances`，标签 `atl:env-id`、`atl:role=lab-app`，运行中）：恰好 1 台，且 `ImageId` 等于 `{{ envfile.ami.AMI_EXPECTED_IMAGE_ID }}`；`http-header`（`from: platform`，`target: public-ip`，`/api/health/ready`）：状态码 200（等待型：通常 10 分钟，最长 25 分钟）；`experiment`（选做）：`ami/rebuild-swap` 的 after |
| 6 | 记录 after：`boot-time`，公共 AMI 与黄金 AMI 各启动 1 台、串行、共 3 轮 | 对比实验 | `experiment`：`ami/boot-time` 的 pair 有效 |
| 7 | （选做）`dependency-failure`：临时实例使用**出站全部拒绝**的实验安全组——公共 AMI 的 `dnf install` 与发布包下载都失败，黄金 AMI（发布版本一致）照常完成。平台模式下发布包来自同区域工具链桶，模块文档的“只放行 S3 托管前缀列表”挡不住它，公共 AMI 也会成功，看不出差别（附 B-18） | 对比实验 | `experiment`（选做）：`ami/dependency-failure` 的 after |
| 8 | （选做）老化：讨论重建与晋升节奏；用 `dnf check-update` 对照黄金 AMI 构建时间与当前仓库 | 观察 | `manual`（选做）：写出本项目的重建节奏建议 |

**最终复核**：ami 的 `driver=golden`，`op: healthy`；实验脚本启动的临时实例已全部终止（`aws-readonly`，`ec2:DescribeInstances`，按实验脚本打的标签过滤、状态为 pending / running 的结果为 0；标签名以 `experiments/ami/` 为准）。

### 对比实验

引用 [06#ami §5](../../modules/06-governance-cost.md#ami)（`experiments/ami/`）。切换前 / 切换后对比；`boot-time` 与 `dependency-failure` 用临时实例，不影响实验机。

| 场景 | 标签 | 本卡 | 没有它（公共 AMI + 现场安装） | 有它（黄金 AMI） |
|---|---|---|---|---|
| `boot-time` | before / after | 必需 | 开机到“安装完成”包含软件包安装与发布包下载 | 只剩配置与启动（发布版本一致时）；具体秒数以实测为准 |
| `dependency-failure` | after | 选做（平台模式下按本卡适配为“出站全部拒绝”） | 模块文档（独立模式）：`dnf install` 成功（仓库在区域 S3 上），下载 GitHub 上的发布包失败。平台模式：发布包也在区域 S3（工具链桶）上，所以改为出站全部拒绝，`dnf install` 与下载都失败 | 软件包与发布包都已烘焙，不需要出网，照常完成 |
| `rebuild-swap` | before / after | 选做 | 替换实例的停机时长包含现场安装 | 停机时长缩短（以实测为准） |
| `scale-out` | — | 不纳入 | 需要 autoscaling | 移到 `svc-autoscaling` / `sc-ha-web` |
| `staleness` | — | 只做讨论（步骤 8） | 每次都装到当时的最新 | 需要一个 30 天前的黄金 AMI，会话内没有 |

### 小测

1. （单选）Auto Scaling 组扩容时，新实例的 User Data 现场安装软件要十多分钟，高峰期扩容跟不上，偶尔还因外部软件仓库不可用而启动失败。最合适的改进是：
   A. 换用更大的实例类型
   B. 用 EC2 Image Builder 构建并测试黄金 AMI，启动模板引用它
   C. 改为人工提前扩容
   D. 给实例挂更大的 EBS 卷

   **答案**：B。**解析**：把安装步骤提前烘焙进镜像，启动时只剩配置与启动，也消除了对外部仓库的依赖；A、D 不解决安装耗时与依赖；C 不具弹性。

2. （多选，选两项）关于 AMI，正确的两项是：
   A. AMI 是区域性资源，跨区域使用需要先复制
   B. 注销 AMI 会自动删除它的 EBS 快照
   C. 共享用客户托管 KMS 密钥加密的 AMI 时，还需要授予对方使用该密钥的权限
   D. EC2 Image Builder 按管道数量收取月费
   E. 用公共 AMI 启动的实例会自动获得安全补丁

   **答案**：A、C。**解析**：注销 AMI 不会删除快照，要单独清理；Image Builder 本身不收费，只为构建实例与存储付费；实例启动后的补丁需要自己安装或定期重建镜像。

3. （单选）团队用 SSM 参数发布最新的黄金 AMI ID，CloudFormation 中实例的 `ImageId` 直接引用这个“latest”参数。某次与 AMI 无关的栈更新，却让生产实例被替换了。原因与改进是：
   A. CloudFormation 的 SSM 参数类型在每次栈更新时都会重新解析；应只引用经过显式“晋升”的参数，或固定 AMI ID
   B. Image Builder 管道会自动替换正在运行的实例
   C. SSM 参数过期后会被自动删除
   D. 实例刷新功能出现故障

   **答案**：A。**解析**：参数在栈更新时重新解析，指向会变的参数就会让任意一次更新顺带替换实例；把“构建产物”与“生产使用的版本”分开（latest 与 promoted 两个参数）。

### 清理说明

- 回收会删除 ami 栈，并按 `state.json` 的带外记录注销本会话构建的 AMI、**删除其快照**、删除 `/cloudalbum/<env>/ami/*` 参数（注销 AMI 不会自动删除快照）。
- 确认实验脚本启动的临时实例与实验安全组已删除（最终复核会检查实例）；如果实验中途失败，手动终止它们。
- 不要手动启动 Image Builder 的“在栈创建时直接构建镜像”资源，也不要把管道改成定时构建：会话结束前没有完成的构建会留下构建实例。
- 被替换下来的旧实验机由替换流程终止；数据卷与 EIP 始终保留在新实例上。

### 对应 SAA 考点

- 黄金 AMI 与 User Data 现场安装的取舍；与暖池、容器镜像的对比。
- EC2 Image Builder 的组成：组件、配方、基础设施配置、分发配置、管道、测试；跨区域、跨账号分发；服务本身免费。
- AMI 的区域性；共享加密 AMI 需要共享 CMK；注销 AMI 不删除快照。
- 用 SSM 参数发布 AMI ID（含 AWS 发布的公共 AMI 参数）；启动模板版本与实例刷新。
- 启动模板中 `resolve:ssm:` 的解析时机；CloudFormation 中 SSM 参数类型在每次栈更新时重新解析。
- 不可变基础设施：替换而不是修补；镜像要定期重建与扫描。

---

## 附 A：本批卡片在学习路径中的位置

学习路径的正式清单以 [tracks-and-catalog.md](tracks-and-catalog.md) §4 为准，原 Lab → 卡片的映射以 05 §5 为准。下表按 tracks-and-catalog §4 摘出本批卡片的位置，各卡 `lab.yaml` 的 `tracks` 字段应等于“所在路径”一列（04 §3.5 第 23 条，`labs:fix` 可自动改写）。标记：● 必修；◇ 选修组；○ 可选。

| 卡片 | `saa-main`（原 Lab） | 所在路径（`tracks`） |
|---|---|---|
| `svc-cost` | ● 阶段 1（Lab 1，与 `svc-iam` 同一节） | `saa-main`、`cost-optimized`（●） |
| `svc-shell-access` | ● 阶段 1（Lab 2） | `saa-main`、`secure`（●）、`operations`（●） |
| `svc-logging` | ● 阶段 1（Lab 3） | `saa-main`、`operations`（●） |
| `svc-monitoring` | ● 阶段 1（Lab 3） | `saa-main`、`operations`（●）、`resilient`（○） |
| `svc-tracing` | ● 阶段 9（Lab 22） | `saa-main`、`operations`（●）、`performant`（○） |
| `svc-audit` | ● 阶段 9（Lab 23） | `saa-main`、`secure`（●）、`operations`（●） |
| `svc-threat-detection` | ● 阶段 9（Lab 23） | `saa-main`、`secure`（◇ 检测） |
| `svc-compliance` | ○ 阶段 9（Lab 25） | `saa-main`、`secure`（◇ 检测）、`operations`（○） |
| `svc-vuln-scan` | ○ 阶段 9（Lab 25） | `saa-main`、`secure`（◇ 检测） |
| `svc-db-proxy` | ○ 阶段 6（Lab 15 的扩展） | `saa-main`、`performant`（○）、`cost-optimized`（○） |
| `svc-workflow` | ○ 阶段 4（Lab 11 的扩展） | `saa-main`、`serverless`（◇ 编排）、`resilient`（○） |
| `svc-ami` | ○ 阶段 8（Lab 21 的扩展） | `saa-main`、`operations`（◇ 运维弹性）、`resilient`（○） |

第 2 轮本附录建议增补的 `ops-observability`、`governance` 两条路径，前者已由 tracks-and-catalog 的 `operations` 路径覆盖，后者未单独设立（其卡片分布在 `secure` 与 `operations` 中）。本批卡片都不属于 `quick-compare`。

## 附 B：发现的现有设计问题

以下问题在设计本批卡片时发现；本文没有修改任何被引用的文件，请负责对应文件的流程处理。

1. **04 的 `lab.yaml` 不足以表达卡片**（04 §3.1、§3.3）：`title` ≤ 24 字放不下“服务：机能”的全称；`difficulty` 只有三档；`id` 只允许 `lab-NN`；没有地方写运行时热键（故障注入总开关；05-lab-catalog 改为由手册步骤打开，二者需统一）；实验标签只有 before / after，无法表达三段式对比（tracing 的 none → local → xray、db-proxy 的 none → pgbouncer → rds-proxy）；`learnerInputs` 没有“成本分配标签已激活”这类可预检的前置；`workstation.tools` 没有 `session-manager-plugin`；证书挂在每个 Lab 上，与“路径发证书、卡片发徽章”不符。建议的 v2 字段见本文“本批约定”§1；部署等级、平台动作、SSH 接线沿用 04 已有的 `provision`、`platformOps`、`workstation.sshFromWorkstation`，`platform` 段只放 05 K10 列出的三项。（审稿修订：初稿另把 `provisionClass`、`actions`、`sshFromWorkstation` 放进 `platform` 段，并把 `${atl:workstationCidr}` 当作“工作台私网地址”写进 `startProfile.params`，与 05 K10、S10 的审稿结论冲突，已撤回。）
2. **aws-readonly 白名单缺口**（04 §5.7）：缺 `config:DescribeConfigurationRecorderStatus`、`DescribeConfigRules`、`DescribeComplianceByConfigRule`、`GetResourceConfigHistory`；`inspector2:BatchGetAccountStatus`、`ListCoverage`、`ListFindingAggregations`、`GetEc2DeepInspectionConfiguration`；`states:DescribeStateMachine`、`ListExecutions`；`imagebuilder:GetImagePipeline`、`ListImagePipelineImages`、`GetImage`；`ec2:DescribeImages`；`ssm:DescribeSessions`；`ce:ListCostAllocationTags`；`budgets:DescribeBudgetActionsForBudget`。06 组模块的探针本来就用这些只读动作，验证角色却没有，导致 svc-compliance、svc-vuln-scan、svc-workflow、svc-ami 的关键检查只能降级为手动确认。ATL-RunCheck 的检查目录（04 §6.4）同样有缺口：`systemd-unit` 白名单没有 `fail2ban`、`cloudalbum-pgbouncer`；`imds-get` 不能读 `ami-id`；`file-stat` 不允许 `/opt/cloudalbum*`；`app-stat` 没有登记安全发现类统计。
3. **wire 检查规则不适用于纯基础设施型模块**（04 §3.5 第 3 条）：shell-access、audit、threat-detection、compliance、vuln-scan、cost、ami 不在请求路径上，不可能有 `http-header` 路径检查。建议允许以 `local`（`module-state`）加 `aws-readonly` 作为“真的接入”的证据。
4. **对比实验有效性规则不适用于功能对比**（04 §7.4 第 5、6 步）：`probe-port`、`coverage-matrix`、`sample-findings`、`who-deleted`、`ssh-canary`、`boot-time` 等不产生业务请求，`lab-metrics-run` 佐证与路径占比都无从计算，这些实验永远无法成为 `valid`。建议增加 `validity: functional`，改用控制面或实验机事实佐证。
5. **平台模式与模块设计的冲突**：① SSH 基线只放行工作台私网地址（02 §4.3、03 §4.4、05 S10），而 05#shell-access 的 `probe-port.ts` 写死探测 `<EIP>:22`——同一 VPC 内经公网地址互访时源地址是工作台的公网 IP，before 就会超时。05-lab-catalog 已在审稿中改为“工作台探测私网地址、外部探针 before/after 都超时”，平台文档之间口径一致；剩下的是模块侧：`probe-port.ts` 需要支持 `--target private-ip`（或读取 `~/.atl/session.json` 自动选择），本卡据此探测 `target.privateIp`。② 01 让 `CloudAlbumAppRole` 从 L0 起就带 `AmazonSSMManagedInstanceCore`：实例从一开始就是托管节点，shell-access 的 `--managed-core` 对照与 vuln-scan 的 DEP-035 前提在平台模式下失去意义，config(ssm) 的“实例只能读自己的参数”这一最小权限论点也不成立（托管策略允许读取全部参数；01 的 `DenySessionSecrets` 只保护 `/cloudalbum/lab/atl/*`）。建议管理通道改用 05#shell-access AppPolicy 第 ① 部分那样的最小集合，或在相关卡片的手册中如实说明。
6. **shell-access 修改区域级单例 `SSM-SessionManagerRunShell`**（05#shell-access §2）：`runAsDefaultUser=cloudalbum-ops` 影响同区域所有使用默认文档的会话。02 §7.5 S6 把它列为“共享对象”，回收器会做复位；但模块把备份写在执行 `scripts/module` 的机器上的 `.cloudalbum/backup/SSM-SessionManagerRunShell-<时间>.json`，state.json 只记“备份位置”——平台模式下执行者是工作台，工作台在回收时被删除，运行器 teardown 失败后回收器拿不到备份内容。其他没有 `cloudalbum-ops` 用户的实例（包括学员自建实例）将无法打开默认会话。建议二选一：① state.json（在工具链桶中，01 §9.6）直接记录修改前的 `DefaultVersion`（或“原本不存在”），复位只需 `update-document-default-version` 或删除文档；② 模块像平台的 `ATL-SessionShell` 一样创建自己的 Session 文档，运维者策略只允许该文档，彻底不碰单例。
7. **卡片时长内无法完成的实验**：shell-access `ssh-noise`（24 小时且需全网开放 22）；vuln-scan `canary-package` 的 Inspector 一侧（深度检查默认每 6 小时采集）、`network-reachability`（每 12 小时）、`time-to-detect`（一周）；cost `visibility-lag`、`threshold-alert`（账单数据至少每天更新一次，预测需约 5 周历史，标签激活需 24 + 24 小时，且预算在回收时被删除，告警永远到不了学员）、`idle-reminder`；audit `validate-logs` 要等首个 digest 文件（约每小时一次），本卡为此把等待上限设为 60 分钟；ami 的镜像构建接近 04 `wait.maxMinutes ≤ 60` 的上限。cost 卡片的核心现象建议改由平台级机制观察（例如报告在 24 小时后经学员同意回访一次 Cost Explorer，或把 cost 的预算作为平台级常驻资源演示）。
8. **logging 的 `instance-loss` 实验在单实例下不成立**（05#logging §5 第 3 步）：`rebuild-instance` 会把数据卷（含 `/var/lib/cloudalbum/logs`）改挂到新实例，本地日志不会丢，看不出与 CloudWatch 的差别；只有 ASG 终止实例时才成立。
9. **threat-detection 的攻击实验与平台运行器冲突**：工作台作为运维机可能在 fail2ban 的 `ignoreip` 中，从工作台发起攻击要么不被封禁，要么封掉工作台、影响后续 HTTP 检查；而必需实验必须由工作台运行器上传（04 §3.3 `runner: workstation`）。本卡改由 CloudShell 发起、用检查替代实验记录。建议增加 `runner: cloudshell`（带上传凭证），或由平台提供受控的“攻击来源”。
10. **workflow 的两处语义问题**：① `worker-down` 的 before 以 `QUEUE_DRIVER=sqs` 为前提，单服务卡片中 memory 队列在 api 进程内消费，只停 worker 看不到问题。本卡把两侧的故障统一为“停 api 与 worker”（若只改 before 一侧，04 §7.4 第 8 步会把 pair 判为不可比），需要 `experiments/workflow/worker-down` 支持 `--fault stop-app`（复用 `faults/stop-app.sh`）；② 模块状态把“最近 1 小时有失败执行”判为 `degraded`，重试与 redrive 实验故意制造的失败会让最终复核的 `status=ok` 在 1 小时内无法满足，建议探针区分“实验期间注入的故障”。
11. **monitoring 的停实例实验与平台 watchdog**：`kill-test` 第二阶段停实例时，平台 watchdog 会把管理通道不可达当作“环境被改动”（02 §12），建议实验能声明“预期中断窗口”以抑制误报。
12. **Inspector 账号级激活的影响范围**：平台模式下激活 EC2 扫描后，工作台与账号里的其他 EC2 实例也被扫描和计费（若按模块文档同时激活 Lambda，还会扫描、计费平台自身的函数，见 B-19），停用又会影响整个区域；建议 vuln-scan 的 preflight 在平台模式下明确列出受影响的资源，费用估算把它们单列。
13. **Image Builder 构建实例与实验临时实例的标签**：State Manager 关联 `atl-prepare-instance` 的目标是 `tag:atl:role ∈ {lab-app, workstation}`（03 §3.4；初稿写的 `atl:managed=true` 已被 03 R10 删除）。构建、测试实例与 `boot-time` / `dependency-failure` 的临时实例都不能带这两个 `atl:role` 值：否则关联会在构建过程中创建 `labuser` 与终端集成并被烘焙进黄金 AMI；带 `lab-app` 的临时实例还会让平台“按标签发现实验机”（01 §9.8）同时命中多台。它们仍需带 `atl:session-id` 供归属与回收。06#ami 的基础设施配置与 `boot-time.ts` 应明确写出这条标签规则；构建角色还必须带 `ATLWorkloadBoundary`（01 §9.6）。
14. **`credentials: optional` 模块是否并入 iam，现有文档有两种口径**：总纲 10.4 规则 2 不并入；04 §11.1 的 lab-05 与 05-lab-catalog 原则 S2 并入。本批与第 1、2 批卡片一致选择不并入（iam 不是硬依赖），代价是这些模块在卡片中最高只能是 `degraded`，应用内的 AWS 侧展示要学员自己补上 iam 才能看到；svc-compliance、svc-threat-detection 的必需实验离不开应用侧展示，因此在 wire 步骤中由学员执行 `enable iam`（B-17）。需要在总纲 10.4 或 04 §3.2.3 中二选一并写明，否则 `single/<id>` 档位与卡片起始状态会不一致。
15. **零散不一致与权限**：svc-compliance 的 SSH 金丝雀与 vuln-scan 的可达性金丝雀需要学员创建“入站 22 对全网开放”的安全组规则，01 的学员边界需要对 `cloudalbum-*-canary-*` 这类带 `Project` 标签的安全组精确放行；svc-audit 的“谁删了这张照片”在没有 storage 的起始状态下无法演示 S3 数据事件。
16. **单服务卡片与 05-lab-catalog 的起始状态口径不同**：05-lab-catalog 为让对比更完整，在 lab-11-x 预置了 queue(sqs)、lab-22 预置了 queue + image-processing(lambda)、lab-23 预置了 storage、VPC 绑定的 Lab 预置了 network(public)（原则 S5）；这些都是软依赖或非依赖模块。卡片按“L0 + 硬依赖闭包”严格计算，本批因此改写了 `worker-down`、`propagation`、`who-deleted` 等实验的适配方式。建议明确：单服务卡片用硬依赖闭包，需要软依赖的完整链路交给组合场景卡片。
17. **依赖应用内控制面视图的实验在无凭证时退化**：`compliance/coverage-matrix`、`compliance/ssh-canary` 读 `GET /api/lab/compliance` 的 Config 列，`threat-detection/sample-findings` 轮询 `/lab` 安全面板右栏，覆盖矩阵右列也由应用读取 GuardDuty 自动打勾；按“不并入 iam”的口径，这些在应用里都是空的，必需实验永远无法有效。本文审稿后的处理：svc-compliance、svc-threat-detection 在 wire 步骤中由学员先执行 `scripts/module enable iam`（不进 startProfile，见约定 3 的例外）。长期建议：实验脚本在应用无凭证时以运行者身份读取 Config / GuardDuty 结果补齐（`experiments/_lib` 已有 `cloudtrail.ts` 这类用 CLI 凭证工作的辅助脚本），届时两张卡片可以去掉这一步。
18. **ami 的 `dependency-failure` 在平台模式下失效**：06#ami 用“出站只放行区域 S3 托管前缀列表”的安全组制造“GitHub 不可达”，而平台模式下发布包来自同区域工具链桶的预签名 URL（01 §4.5），同样落在 S3 前缀列表内，公共 AMI 的安装会成功，看不出差别。本卡把它改为选做并使用“出站全部拒绝”的安全组（`dnf` 仓库与发布包都不可达，黄金 AMI 不需要出网）；需要 `experiments/ami/dependency-failure` 支持 `--egress none`。
19. **vuln-scan 的扫描资源类型写死**：06#vuln-scan 的 enable 写死 `inspector2 enable --resource-types EC2 LAMBDA`。单服务卡片里没有 CloudAlbum 的 Lambda 函数，开启 Lambda 扫描只会扫描、计费平台自身的函数；05 lab-25 也规定平台模式默认只启用 EC2。需要 `scripts/module enable vuln-scan` 按 `VULN_SCAN_RESOURCE_TYPES`（或 `--resource-types`）决定激活范围，disable 时只停用本会话激活的类型。
20. **`when` 表达式不含 `envfile.*`**：04 §4.4 规则 5 的 `when` 语法只列了 `runtime`、`done`、`driver`、`var`、`learner.inputs`、`session.region`。“只读接入时跳过配置细节断言”这类条件需要读模块 env（`CLOUDTRAIL_MANAGED`、`VULN_SCAN_ACTIVATION`、`GUARDDUTY_MANAGED`），本文经 `variables`（`from: derived`，`fillFrom: envfile.<module>.<KEY>`）中转。建议 04 在 `when` 中直接允许 `envfile.*`，或把这种中转写成推荐写法。
21. **cost 的标签激活在平台模式下会被边界拒绝**：06#cost 的 enable 带外第 1 步是 `aws ce update-cost-allocation-tags-status`，平台模式下由学员身份执行，而学员边界只有 `ce:Get*/List*/Describe*`（05 lab-01）。`scripts/module enable cost` 在 `CLOUDALBUM_PLATFORM_MODE=1` 时应跳过这一步（只做 `cost-allocation-tag-active` 预检并提示平台动作 `cost-activate-tags`），否则整个 enable 会因 AccessDenied 中断。
22. **capability 公开视图的字段投影缺 `localHealth`**：04 §5.2.2 写明 capability 检查作用于 `{driver,status,confidence,detail,public,data?}`，而总纲 6.1 规定本地实现的健康放在 `localHealth`（`status=off` 时唯一能说明“本地实现是否正常”的字段）。本批 audit、threat-detection、compliance、vuln-scan 的观察步骤都断言 `localHealth=ok`；需要 04 把 `localHealth` 加进公开视图的投影（它不含敏感信息），否则这些断言只能改为 `view: admin`。

### 附 B 的第 3 轮处理状态与新增问题

上面 1～22 条是第 2 轮的原文，保留以便追溯；第 3 轮（主设计者裁决 C1～C8 之后）的状态如下。“列入 06”表示 CloudAlbum 侧的实现要求已交给 06（平台模式唯一清单）。

| # | 状态 | 说明 |
|---|---|---|
| 1 | 已解决 | 04 `atl.lab/v2`：标题 ≤ 48 字、四级难度、`svc-`/`sc-` id、`provisions[] kind: runtime`、声明式实验变体、`cost-tags-active` 学员输入、`session-manager-plugin`、卡片不发证书（本批约定 §1） |
| 2 | 已解决 | 04 §5.7 收录全部列出的只读操作；04 §6.4 扩充 `systemd-unit`、`imds-get`、`file-stat` 的白名单（具体条目以 04 为准）；`app-stat` 的统计名登记列入 06（04 M-10） |
| 3 | 已解决 | 04 §3.5 第 3 条：纯基础设施型模块用 `module-state` + 带 `ownership` 的 `aws-readonly` |
| 4 | 已解决 | 04 §3.2.10 的 `validity: functional` + `corroborateWith` |
| 5 | ① 已列入 06；② 仍成立 | ① `probe-port.ts --target private-ip`（06 PM-M28）；② 平台管理通道让实例从 L0 起就是托管节点，削弱 shell-access、vuln-scan 与 config(ssm) 的部分对比，是 P7 的设计取舍，手册如实说明（01 的 `DenySessionSecrets` 已改为保护 `/cloudalbum/*/atl/*`） |
| 6 | 已解决 | `state.json` 与备份改放在平台栈创建的环境状态桶（01 §3.11，裁决 C4(c)），学员、运行器与回收器都能读写；模块把会话首选项的原值备份到 `<envName>/backups/`（06 PM-27、PM-M28），回收时还原（02 §7.5 S6） |
| 7 | 仍成立 | 卡片时长内看不到的现象（cost 的账单延迟与标签激活、Inspector 语言包、audit digest 等）是 AWS 行为；“24 小时后回访”之类的平台机制不在本轮范围 |
| 8 | 仍成立 | logging 的 `instance-loss` 移到 svc-autoscaling / sc-ha-web |
| 9 | 不采纳长期方案 | 04 不采纳 `runner: cloudshell`（CloudShell 没有本会话的 agent 凭证）；本卡继续用 local / manual 代替攻击类实验记录 |
| 10 | 部分列入 06 | ① `worker-down --fault stop-app`（06 PM-M36）；② workflow 探针区分“实验注入的失败”尚未列入 06。在此之前最终复核用 `anyOf` 允许“最近 1 小时有失败执行”的 `degraded` |
| 11 | 已解决 | 04 §3.2.8 的 `expectedOutage` 与 02 §5.8 的预期中断窗口；“停实例”阶段分开运行列入 06（新增 B-23） |
| 12 | 仍成立 | Inspector 账号级激活的影响范围；preflight 在平台模式下列出受影响资源、报价单列（02 §3.2 已在确认对话框中说明） |
| 13 | 已调整、已列入 06 | 实例发现改为 `atl:env-id` + `atl:role=lab-app` + 栈名；临时实例与构建实例带 `atl:session-id`、`atl:env-id`，不得带 `atl:role`；06 PM-M36 写明“构建实例不得带 `atl:role`”，构建角色带权限边界 |
| 14 | 已由裁决解决 | C3：一律预置 iam（svc-ec2、svc-iam 除外） |
| 15 | 仍待 01 | 学员边界对 `cloudalbum-*-canary-*` 安全组“入站 22 对全网开放”的精确放行 |
| 16 | 已由裁决解决 | C3 与 05 卡片目录：单服务卡只用 L0 + iam + 硬依赖闭包，完整链路交给场景卡 |
| 17 | 已由裁决解决 | C3 预置 iam 后，应用内控制面视图从起始状态就可用 |
| 18 | 已列入 06 | `dependency-failure --egress none`（06 PM-M36） |
| 19 | 已列入 06 | vuln-scan 新增参数 `ScanTypes`，平台模式缺省只启用 EC2，回收时只停用本环境激活的类型（06 PM-M34） |
| 20 | 已解决 | 04 §4.4 规则 5 允许 `when` 引用非密钥的 `envfile.<module>.<KEY>`；本批已改为直接写 |
| 21 | 已列入 06 | 平台模式下 `scripts/module enable cost` 跳过标签激活（06 PM-M35、PM-30），只做 `cost-allocation-tag-active` 预检并提示平台动作 `cost-activate-tags` |
| 22 | 已解决 | 04 V-12：`capability-snapshot` 的投影含 `localHealth` 与警告 |

**第 3 轮新增**

23. **已解决（第 3 轮跨文档审计）**：06 PM-M30 已规定 `experiments/monitoring/kill-test` 支持 `--phase service | instance | all`（平台模式缺省 `service`），`stop-instance` 登记为一次性变体并只接受 `--phase instance`，`phase` 写入结果参数；并回写到 docs/modules/05-ops-observability.md 的 monitoring 第 12 节。原问题：pair 只比较“停服务”阶段，“停实例”阶段作为一次性变体 `stop-instance` 单独运行（04 §7.4 要求 pair 两侧场景参数一致），需要 `kill-test` 能分阶段运行（sc-observability 同样依赖）。
24. **会话 ID 与日志流名的前缀规则**：svc-shell-access 的 `session-audit` 与 `session-logged` 依赖“会话 ID 以角色会话名开头”（`atl-<sid>-ws-…`），平台终端会话以 `atl-<sid>-term-` 开头。这一行为列入 07 的 PoC；不成立时改按 `DescribeSessions` 的 `DocumentName` 与 `Owner` 区分。
25. **学员前置输入的命名**：本批的告警与发现邮箱用 `notify-email`，场景卡用 `alert-email`；两者都在 05 §1.2 的取值集合中。若 05 决定合并为一个，本批与 scenario-cards 一起改名。

## 审稿修订记录

### 2026-10-13 · 第 2 轮（对抗式审稿）

审稿依据：modular-design §3.2 / §5.2 / §10.4，05-ops-observability.md、06-governance-cost.md 各模块的第 0～11 节，平台 01～05（只读），第 1、2 批卡片的通用约定；AWS 事实以官方文档核对（Systems Manager 的 CloudTrail 记录、RDS Proxy 的 CloudWatch 指标、CloudWatch 账单指标、GuardDuty 测试域名）。

**起始状态闭包核对（逐张）**：12 张卡片的硬依赖闭包全部成立，没有多也没有少——shell-access {iam(role)}（DEP-001）；logging、monitoring、tracing(xray) {iam}（CRED-001）；vuln-scan {iam(role)}（DEP-035）；db-proxy {iam, secrets(secretsmanager), database(RDS)}（DEP-032、033；kms 只是 `orderBefore`，不在闭包内）；workflow {iam, storage(s3)} + 工具链栈（DEP-034；与 `IMAGE_PROCESSOR=lambda` 互斥由本地档 worker 满足 MUTEX-005）；audit、threat-detection、cost、compliance、ami 为空集（`credentials: optional`，按总纲 10.4 规则 2 不并入 iam）。本地档（tracing 的自建 PG 与 memory + worker、db-proxy 的 `LB_LOCAL_WORKERS=2`、workflow 的 memory + worker）都有对比实验上的理由，零 AWS 费用。

**已在正文中修正的问题**

| # | 严重度 | 位置 | 问题 | 修正 |
|---|---|---|---|---|
| R-1 | 高 | 约定 §1、§4，svc-shell-access 元数据、startProfile 表与 lab.yaml | 把 05 S10 的 `${atl:workstationCidr}` 当作“工作台私网地址”写进 `startProfile.params`；05 S10（审稿修订）明确它是工作台**公网** IPv4/32，Lab 2 的 SSH 基线由 04 已有字段 `workstation.sshFromWorkstation` 驱动运行器设为私网 IP/32。按原写法 SSH 基线会放行公网地址，经私网的 `ssh lab` 与 `probe-port` before 都会超时 | 删除占位符；改用 `workstation.sshFromWorkstation: true`；约定 §3 增加第 9 条“不用平台占位符” |
| R-2 | 高 | 约定 §1，lab.yaml | `platform` 段重复定义 04 已有字段（`provisionClass`、`actions`、`sshFromWorkstation`），且 lab.yaml 缺 04 必填的 `provision`，按 04 schema 校验会失败（05 K10、R-3 已指出同类问题） | `provision: { class: A }`、`workstation.sshFromWorkstation` 回到 04 字段；`platform` 只留 `preview`、`consoleLinks`、`accountImpact`；`retain` 去掉 04 没有的 `reason` |
| R-3 | 高 | svc-compliance、svc-threat-detection | 必需实验 `coverage-matrix`、`ssh-canary`（只调用 `GET /api/lab/compliance`）与 `sample-findings`（轮询 `/lab` 右栏）都经应用读取控制面，而起始状态按约定不含 iam，应用无凭证时 after 永远拿不到数据，卡片无法完成；初稿只在附 B-17 中寄希望于“改实验脚本” | wire 步骤改为“先 `enable iam` 再启用目标模块”（iam 仍不进 startProfile）；最终复核改为 `status=ok`；约定 §3 第 4 条写明这一例外；threat-detection 原选做第 6 步合并进第 3 步 |
| R-4 | 高 | svc-vuln-scan | 目标取值 `VULN_SCAN_RESOURCE_TYPES=ec2,lambda`，步骤与对比实验写“EC2 + 本项目 Lambda 函数”，但起始状态（L0 + iam）根本没有 CloudAlbum 的 Lambda；开启 Lambda 扫描只会扫描、计费平台自身的函数（05 lab-25 也规定平台模式默认只启用 EC2） | 改为只启用 EC2 扫描类型；wire 检查只断言 EC2 `ENABLED`；覆盖矩阵、费用、清理同步；模块文档写死资源类型的问题记为附 B-19 |
| R-5 | 高 | svc-ami `dependency-failure` | 平台模式下发布包来自同区域工具链桶（01 §4.5），“只放行 S3 托管前缀列表”的安全组挡不住它，公共 AMI 也会安装成功，必需实验看不出差别 | 改为选做，并改用“出站全部拒绝”的实验安全组；附 B-18 |
| R-6 | 高 | svc-ami 费用档位与时长 | `boot-time` 写成“3 台 / 各 3 台临时实例”，与 06#ami“各 1 台、重复 3 次”不符；按 05 §2.7.3 的算法，构建实例与实验临时实例同时计入会得到“高”，与卡片的“中”矛盾 | 写明临时 EC2 串行、同一时刻至多 1 台，在 `cost.basis` 中按 1 个单位声明；预计时长 120 → 135 分钟（上限 210 不变，仍 ≥ 1.5 倍） |
| R-7 | 高 | svc-workflow `worker-down` | before 改成“重启 api 与 worker”、after 仍“只停 worker”，两侧故障不同，04 §7.4 第 8 步会把 pair 判为不可比，必需实验无法有效 | 两侧统一为“上传后停 api 与 worker 2 分钟再启动”（复用 `faults/stop-app.sh`）；附 B-10 写明脚本需支持 `--fault stop-app` |
| R-8 | 中 | 约定 §3 第 4 条及各卡 capability 检查 | capability 检查写成“detail 含‘无凭证’”，第 1 批审稿已指出它会漏掉其他预期警告、放过意外警告 | 统一为“规则警告 ⊆ 预期警告集合、`validation.errors` 为空”，探针类 `degraded`（订阅未确认、首轮评估）单独处理；monitoring 的“status 不为 error”同样收紧 |
| R-9 | 中 | 约定 §2 难度表 | 中级判定写“或有账号级影响”，05 §2.7.1 审稿已删去（否则 Lab 1、2 会变成中级） | 改为“开启账号级按量服务”，并注明各张中级卡片的具体理由 |
| R-10 | 中 | lab.yaml `badge.requireQuiz: true` | 与第 1 批 §1.5、第 2 批 §1.6、04 §3.2.10（小测不影响完成状态）不一致 | 改为 `false`，约定 §1 同步 |
| R-11 | 中 | svc-shell-access 检查 `sg-no-22` | 只匹配 FromPort ≤ 22 ≤ ToPort 的规则；协议为“全部流量”（`-1`）的规则 FromPort/ToPort 都是 -1，同样放开 22 却能通过检查（可被绕过） | 增加“没有 `IpProtocol=-1` 的入站规则”断言；`sg-22-workstation-only` 增加“来源都是 /32” |
| R-12 | 中 | svc-shell-access `start-session-trailed` | 断言 `Resources[*].ResourceName` 含实例 ID；官方 StartSession 事件示例只保证 `requestParameters.target`，LookupEvents 的 `Resources` 是否填充实例无保证，且 `contains` 对 ARN 数组的语义不清 | 改为对 `CloudTrailEvent` 的辅助断言（`warn`），主判据保留会话名 |
| R-13 | 中 | 约定 §4、svc-shell-access | 平台终端文档写成 `ATL-Shell*`，平台录制日志组写成 `/atl/terminal-sessions`；03 §3.3 定稿为 `ATL-SessionShell` / `ATL-SessionShell-Logged` 与 `/atl-recordings/terminal-sessions` | 全文改正；`session-audit` 按会话 ID 前缀 `atl-<sid>-ws-` / `atl-<sid>-term-` 区分 |
| R-14 | 中 | svc-ami 平台说明、附 B-13 | 引用已被 04 R-27 撤销的 `atl.session.target-changed` 事件，以及已被 03 R10 删除的 `atl:managed=true` 标签 | 改为“按标签重新发现、实例 ID 变化即证据过期”；标签规则改为“不得带 `atl:role=lab-app` 或 `workstation`”，并补上临时实例会让实验机发现命中多台的风险；wire 检查断言“恰好 1 台” |
| R-15 | 中 | svc-tracing 第 3 步、svc-db-proxy 第 3 步、svc-cost 第 2 步、svc-threat-detection 第 5 步 | 描述中间档或会被后续步骤改变的检查默认 `must-hold`，最终复核必然判为漂移（第 1 批 §1.4 第 1 条）；threat-detection 第 5 步“未归档示例发现 ≥ 1”与第 8 步“未归档 = 0”自相矛盾，且实验脚本结束时本就会归档 | 逐项标 `once`；第 5 步改为不按归档状态过滤；约定 §5 增加书写规则 |
| R-16 | 中 | svc-audit `who-deleted` 适配 | 场景 2 写“给安全组加标签（05 原文 storage=local 时的备选）”，05 原文的备选是“删除无害的 SSM 参数或给日志桶打标签”；日志桶在 before 时还不存在 | 改为删除无害 SSM 参数；场景 4 改为经投递通道执行（第 1 批 §1.4 第 3 条） |
| R-17 | 中 | 账号级单例的 `aws-readonly` 检查 | 约定“默认 `ownership: session`”会让只读接入（外部 trail、detector、记录器、Inspector 激活）时检查必然 `OWNERSHIP_MISMATCH`；`when: envfile…` 不在 04 §4.4 的 `when` 语法内 | 约定 §4 增加“只读接入时的归属”；条件改经派生变量中转（附 B-20）；compliance、vuln-scan 的最终复核允许“只读接入的已知限制”导致的 `degraded` |
| R-18 | 中 | svc-cost 人工前置 | 漏了“账号已开启 IAM 访问账单信息”（05 lab-01）；`scripts/module enable cost` 的带外“激活标签”在平台模式下会被学员边界拒绝 | 补上前置；声明 `platformOps: cost-activate-tags`（选做）；附 B-21 |
| R-19 | 中 | svc-workflow 起始部署等级、startProfile | 部署等级写“A～B（部署包经工具链桶上传）”，但缩略图 Lambda 属于目标模块；工具链栈写成“运行器执行 `scripts/module bootstrap`”，平台模式下它由 `session-bootstrap` 创建 | 部署等级改为 A（与 05 lab-11-x 一致）；工具链栈列为平台固定部分（约定 §3 第 8 条）；wire 步骤补 `local（path-seen）` 路径证据（`workflow=` 段只出现在 POST 上）；第 7 步对照所需的 inline 重试记录补到第 2 步 |
| R-20 | 中 | svc-db-proxy 路径检查 | 用 `/api/health/ready` 取 `database=` 路径段，与第 2 批 svc-database 的 `/api/console/probe/now` 写法不一致 | 统一为探测端点；pinning 指标写明 `AWS/RDS` 的 `DatabaseConnectionsCurrentlySessionPinned`（维度 `ProxyName`，已核对官方文档）；补上 svc-cost 承诺的 `idle-reminder` “读一读” |
| R-21 | 中 | svc-monitoring `kill-test` | after 加入“停实例”阶段而 before 没有，pair 参数不一致 | pair 只用“停服务”阶段，“停实例”作为单独的附加观察 |
| R-22 | 低 | svc-cost 小测第 1 题 | 解析称 `EstimatedCharges`“只能看账号总额”；官方文档：账单指标有账号总额与按服务的估算值，且不做预测 | 改写解析 |
| R-23 | 低 | svc-logging 小测第 3 题 | 题干要求“近实时处理 + 低成本长期保存”，C 本身不满足后者，“选两项”有歧义 | 题干改为“可以实现近实时投递的两项”，解析补全订阅过滤器目标 |
| R-24 | 低 | svc-audit SAA 考点 | “全局服务（IAM、STS）的事件记录在 us-east-1”：STS 区域端点的调用记在该区域 | 改为“IAM 等全局服务（以及 STS 全局端点）” |
| R-25 | 低 | 多处清理说明 | 把 `DeletionPolicy: Retain` 的日志组说成“按派生资源删除”；02 §7.1 中它们属于 `RETAINED` 来源 | 改正（Lambda 自动创建的日志组才是派生规则） |
| R-26 | 低 | 附 B-5、B-6、B-12、B-15 | B-5 ① 与 05 已修订的 lab-02、S10 不符；B-6 忽略了 02 §7.5 S6 的共享对象复位；B-15 称 04 写作 `atl:role=app`（04 §5.2.1 实为 `lab-app`） | 改写为当前仍成立的问题；新增 B-18～B-22 |
| R-27 | 低 | svc-tracing 第 1 步 | 断言“路径头不含 `tracing=`”，04 §5.3 没有“不包含”运算符 | 改为对证据 `pathSegments.tracing` 断言 `absent` |
| R-28 | 低 | svc-shell-access 清理说明 | 称端口转发会话也按 `idleSessionTimeout` 断开；端口转发用 AWS 自有文档，是否受首选项约束不确定 | 改为“以官方文档为准”，提示自己关掉 |

**核对后保留的判断**

- 小测 36 题的答案与解析逐题核对，除 R-22、R-23 外均正确且符合 SAA 风格（场景题 + 干扰项各有明确错因）。
- 对比实验全部存在于模块文档的 registry `lab.experiments` 中；“不纳入”的理由（`ssh-noise` 24 小时、`time-to-detect` 一周、`network-reachability` 12 小时、`threshold-alert` 账单延迟、`instance-loss` 单实例下数据卷随迁等）成立。
- 费用档位：只有 svc-db-proxy 为高（RDS + RDS Proxy），GuardDuty / Config / Inspector 三张为中（账号级按量服务），svc-ami 为中（前提见 R-6），其余为低，与 05 §2.7.3 一致。
- id、`kind`、四级难度与时长取整（15 / 30 分钟倍数、上限 ≥ 1.5 倍）全部符合约定。svc-audit 的等待上限之和（30 + 60 分钟）超过时间上限的 50%，04 lint 会给出警告（不是错误）；digest 的等待与第 5～7 步并行，实际剩余等待较短，保留。

## 修订记录

### 2026-10-13 · 第 1～2 轮

- 第 1 轮新建 12 张卡片；第 2 轮对抗式审稿修订（见上方“审稿修订记录”）。

### 2026-10-13 · 第 3 轮（落实主设计者裁决 C1～C8）

依据：主设计者裁决 C1～C8；平台评审的统一取值（档位名、标签与学员权限、实例发现键、名称表）；本文第 2 轮审稿的 open_issues；04 第 2 轮定稿的 `atl.lab/v2` 与其 §14 K-1～K-8。

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| V3-1 | 文首、总表 | 写明与 05（元数据汇总权威）、tracks-and-catalog、04、01、06 的分工；总表的起始状态列按 C3 改写，audit、threat-detection、cost、compliance、ami 五张增加 iam(role) | C1、C2、C3 |
| V3-2 | 本批约定 §1～§5 | §1 改为“本批旧写法 → 04 v2 字段”对照；§3 改为 L0 + iam(role) + 闭包、由 `plan --start-of` 推导、不用 `single/<id>`，废止“optional 模块不并入 iam”与“wire 步骤中先 `enable iam`”的例外；工具链栈由 `base-deploy` 创建，`state.json` 与锁在环境状态桶与锁表；§4 增加 `atl:env-id`、`atl:component=env`、按 `atl:env-id` 发现实验机、手工资源经定向扫描认领、`when` 直接引用 `envfile.*`、预期中断窗口；§5 统一 `op: healthy`、before 状态一律 `once`、删除 ⚠ 标记、实验变体标签 | C3、C4(c)(d)(e)、C5；04 §3、§4.4、§5 |
| V3-3 | svc-shell-access | 元数据与起始状态按 C3；完整 `lab.yaml` 改写为 04 v2（`provisions`、`modules`、`expectedWarnings`、声明式实验变体、`badge`、`tracks`、`platform.accountImpact`、`no-world-ssh`、状态桶与锁表的权限）；检查改用 `op: healthy`，before 检查标 `once`；会话首选项原值备份到环境状态桶 | C3、C4(c)、C5 |
| V3-4 | svc-audit、svc-threat-detection、svc-cost、svc-compliance、svc-ami | 起始状态预置 iam；删除 CRED-004 预期警告、`enable iam` 的例外与选做步骤；svc-audit 的“AWS 事件”页签基线改读 Event History；svc-cost 的 `ce:ListCostAllocationTags`、`DescribeBudgetActionsForBudget` 改为自动检查，预算名改为 `atl-platform-guard`；svc-ami 的实例发现改用 `atl:env-id` 并声明预期中断 | C1、C3 |
| V3-5 | svc-monitoring、svc-tracing、svc-db-proxy、svc-workflow、svc-vuln-scan、svc-logging | 起始状态写法；探测端点改为 `/api/lab/probe/now`；tracing 的 `local`、db-proxy 的 `pgbouncer` 改为声明的实验变体；monitoring 的“停实例”阶段改为一次性变体并声明 `expectedOutage`；workflow 的最终复核用 `anyOf` 显式允许探针型 `degraded`；`when` 直接引用 `envfile.*` | C3、C5 |
| V3-6 | 附 A、附 B | 附 A 改为按 tracks-and-catalog §4 摘出的路径位置（即各卡 `tracks` 字段）；附 B 增加第 3 轮处理状态表与新增 B-23～B-25 | C2 |

**未采纳的意见**：第 2 轮 open_issues 中“增加 `runner: cloudshell`”未采纳（04 的结论，见附 B-9）；“平台管理通道改用最小权限集合以恢复 shell-access / vuln-scan 的对比”属于 P7 的设计取舍，本轮只在手册中如实说明（附 B-5 ②）；“cost 卡片的 24 小时回访机制”不在本轮范围（附 B-7）。实验脚本参数（`--target private-ip`、`--fault stop-app`、`--egress none`、`--phase`、vuln-scan 资源类型、平台模式下跳过标签激活）属于 CloudAlbum 侧实现，交给 06。

### 2026-10-13 · 第 4 轮（跨文档审计修复）

- **`kill-test` 分阶段**（审计低严重度）：svc-monitoring 第 6 步写明 `--phase service` 与 `--label stop-instance --phase instance`；附 B-23 标为已解决（06 PM-M30 已补充参数与变体，并回写模块文档）。
- **没有采纳的意见**：无。**仍需其他文件配合**：无。
