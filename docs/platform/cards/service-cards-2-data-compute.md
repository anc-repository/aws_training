# 单服务卡片（第 2 批）：数据与存储（C 组）· 计算、异步与通知（D 组）

> **文档定位**：AWS Training Lab（ATL）“学习卡片实验室”目录的一部分，定义 14 张单服务卡片（`kind: service`）：C 组 storage、shared-fs、database、cache、social-store、backup、analytics，D 组 image-processing、queue、notification、email、scheduler、tagging、social-api。卡片模型取代 `05-lab-catalog.md` 中按 Lab 0～25 编排的目录；Lab 0～25 改由学习路径 `saa-main` 映射成卡片序列。
>
> **状态**：设计稿 · 第 3 轮（按主设计者裁决 C1～C5 修订，见文末“审稿修订记录”）· 2026-10-13
>
> **依据**（本文只读引用，不修改）：[modular-design.md](../../modular-design.md) §3 模块目录、§5 规则表、§10 档位；[03-data-storage.md](../../modules/03-data-storage.md)；[04-compute-async.md](../../modules/04-compute-async.md)；平台设计 [01](../01-architecture.md)～[04](../04-lab-format-checks-reports.md)（卡片格式 `atl.lab/v2` 以 04 §3 为准，C2）；名称（栈、角色、标签、路由）只引用 01 的名称表（C1）；CloudAlbum 侧的平台模式能力（探测端点 `/api/lab/probe/*`、CLI、种子、实验变体标签）只引用 [06-cloudalbum-platform-mode.md](../06-cloudalbum-platform-mode.md)（C5）；学习路径、掌握度与徽章以 [tracks-and-catalog.md](tracks-and-catalog.md) 为准。与这些文件不一致时以它们为准，本文发现的冲突列在 [附录 C](#附录-c本批发现的设计问题)。
>
> **名称约定**：`<envName>` 是本环境的 CloudAlbum Env 名（`e` 加 7 位小写字母数字，01）；栈名 `cloudalbum-<envName>-<模块>`，手册与检查中写作 `{{ session.env }}`。
>
> **写作约束**：不写精确的性能数字与价格；费用只写档位与主要计费来源；文档语言为简体中文，技术名词保留英文。

---

## 目录

- [0. 本批总表](#0-本批总表)
- [1. 本批共同约定](#1-本批共同约定)
- C 组：[svc-storage](#svc-storage) · [svc-shared-fs](#svc-shared-fs) · [svc-database](#svc-database) · [svc-cache](#svc-cache) · [svc-social-store](#svc-social-store) · [svc-backup](#svc-backup) · [svc-analytics](#svc-analytics)
- D 组：[svc-image-processing](#svc-image-processing) · [svc-queue](#svc-queue) · [svc-notification](#svc-notification) · [svc-email](#svc-email) · [svc-scheduler](#svc-scheduler) · [svc-tagging](#svc-tagging) · [svc-social-api](#svc-social-api)
- [附录 A：svc-storage 的完整 lab.yaml](#附录-asvc-storage-的完整-labyaml)
- [附录 B：卡片相对 04 lab.yaml 格式的扩展](#附录-b卡片相对-04-labyaml-格式的扩展)
- [附录 C：本批发现的设计问题](#附录-c本批发现的设计问题)
- [审稿修订记录](#审稿修订记录)

---

## 0. 本批总表

“时长”写作“预计 / 上限”；所有卡片默认可延长 2 次、每次 30 分钟（02 的平台默认值）。startProfile 中的 `iam(role)` 指 `IAM_CREDENTIALS=role`；“本地档”不部署 AWS 资源、不写 `MODULE_<ID>=on`。“预期警告”是 04 §3.2.5 的 `expectedWarnings`。难度与时长按 05 目录总则判定，费用档位按 05 的结构算法判定（见 1.4、1.5）。

| id | 标题 | 难度 | 时长 | startProfile | 预期警告 | 费用档位 | 人工前置 |
|---|---|---|---|---|---|---|---|
| `svc-storage` | Amazon S3：照片对象存储 | 初级 | 60 / 90 分钟 | `l0-ec2` + iam(role) | — | 低 | 无 |
| `svc-shared-fs` | Amazon EFS：多实例共享文件系统 | 中级 | 75 / 120 分钟 | `l0-ec2` + iam(role) | — | 中 | 无 |
| `svc-database` | Amazon RDS for PostgreSQL：托管关系数据库 | 高级 | 120 / 180 分钟 | `l0-ec2` + iam(role) | — | 高 | 无 |
| `svc-cache` | Amazon ElastiCache：共享缓存 | 中级 | 90 / 150 分钟 | `l0-ec2` + iam(role) + 本地档 `LB_LOCAL_WORKERS=2` | —（memory 对照步骤见附录 C-17、C-19） | 中 | 无 |
| `svc-social-store` | Amazon DynamoDB：点赞、评论与分享链接 | 初级 | 60 / 90 分钟 | `l0-ec2` + iam(role) | — | 低（选做 → 中） | 无 |
| `svc-backup` | AWS Backup：盘外备份与恢复演练 | 高级 | 120 / 180 分钟 | `l0-ec2` + iam(role) | — | 中 | 平台安装时已配置灾备区域（`DrRegion`）；会自动修改账号级 Backup 区域设置（见卡片）。灾备区域的边界放行依赖 01 第 2 轮的 `DrRegionLimited`（附录 C-6） |
| `svc-analytics` | Amazon Data Firehose：点击流采集与投递 | 中级 | 75 / 120 分钟 | `l0-ec2` + iam(role) | — | 低 | 无 |
| `svc-image-processing` | AWS Lambda：缩略图生成 | 中级 | 90 / 150 分钟 | `l0-ec2` + iam(role) + storage(s3) | — | 低（选做 → 中） | 无 |
| `svc-queue` | Amazon SQS：异步任务队列与死信队列 | 初级 | 60 / 90 分钟 | `l0-ec2` + iam(role) + 本地档 `IMAGE_PROCESSOR=worker`、`QUEUE_DRIVER=memory` | — | 低 | 无 |
| `svc-notification` | Amazon SNS：通知扇出与订阅过滤 | 初级 | 60 / 90 分钟 | `l0-ec2` + iam(role) | —（订阅待确认时的 `degraded` 用 `pendingIf` 等待，附录 C-18） | 低 | 能收信且支持 `+` 别名的邮箱；点击确认订阅邮件 |
| `svc-email` | Amazon SES：真实发信与退信回流 | 初级 | 60 / 90 分钟 | `l0-ec2` + iam(role) | —（SES 沙盒的 `degraded` 单独判定，附录 C-18） | 低 | SES 发件身份（邮箱验证；可选自有域名） |
| `svc-scheduler` | Amazon EventBridge Scheduler：不漏跑的定时任务 | 初级 | 75 / 120 分钟 | `l0-ec2` + iam(role) + 本地设置 `SCHEDULER_COMPARE_HEARTBEAT=on` | — | 低 | 无 |
| `svc-tagging` | Amazon Rekognition：图片识别与审核 | 初级 | 45 / 90 分钟 | `l0-ec2` + iam(role) | — | 低 | 无 |
| `svc-social-api` | Amazon API Gateway：社交 API 托管入口 | 初级 | 60 / 90 分钟 | `l0-ec2` + iam(role) | — | 低 | 无 |

**本批起始状态的部署等级**（02 §11.1）：全部为 A 级（L0 + iam + 快速模块；svc-image-processing 多一个 S3 栈，仍属 A 级）。RDS、ElastiCache、EFS 这类慢资源都由学员在卡片内亲手启用，等待时间已计入各卡片的时间上限。

---

## 1. 本批共同约定

### 1.1 起始状态的计算规则

本节落实主设计者裁决 C3（规范写法见 04 §3.2.3），与第 1 批 §1.1 相同。

1. **起始状态 = `l0-ec2` + iam(role) + 目标模块硬依赖的闭包**。平台模式下实验机从一开始就带 `CloudAlbumAppRole`（只有 `AmazonSSMManagedInstanceCore`），这是平台管理通道（`mgmt-channel`），**不算 iam 模块**；iam 模块是 `IAM_CREDENTIALS=role` 加 iam 自己的只读策略（`enable iam` 走 `AppRoleMode=existing`，01）。
2. **iam(role) 一律预置**，`basis: credential`。本批第 2 轮“`credentials: optional` 的模块不并入 iam”的写法作废：shared-fs、database、cache、backup、social-api 现在也预置 iam，深度探针与控制面感知（`rds:DescribeDBInstances`、ElastiCache / EFS 的 Describe、Backup 恢复点、`apigateway:GET`）可用，不再出现 CRED-004，`/lab` 中能直接看到 Multi-AZ 状态、恢复点等控制面事实。shared-fs 因此按模块文档自动采用 `IamAuth=true`（挂载要带 `iam` 选项，见该卡）。
3. **硬依赖闭包**：按目标模块在 registry 中的 `requires`、`conflicts` 与总纲 §5.2 规则表计算；`a | b` 的选择写进 `startProfile.branches` 并在卡片中说明理由。起始状态由 `scripts/module plan --start-of <卡片 id> --platform --json` 推导，档位 `atl/<卡片 id>/<variant>`（默认变体写全为 `atl/<卡片 id>/default`，文件 `profiles/atl/<卡片 id>/<variant>.env`，01 §3.9）；不能直接用 `single/<id>`（它包含目标模块本身）。
4. **“正常”允许预期警告**：capability 检查用 `op: healthy`（04 §5.3）——`status=ok`，或 `status=degraded` 且导致降级的规则全部属于卡片的 `expectedWarnings`、`validation.errors` 为空。本批卡片的 `expectedWarnings` 都为空；没有规则 ID 的 `degraded`（SNS 订阅待确认、SES 沙盒）不算正常，分别用 `pendingIf` 或单独的断言处理（附录 C-18）。
5. **本地档与本地设置**：为了让对比有意义而需要的本地档取值，写成 `startProfile.provisions` 中 `kind: local` 的条目（04 §3.2.3），不部署 AWS 资源、不写 `MODULE_<ID>=on`。目标模块以本地档出现在起始状态时（svc-queue 的 `QUEUE_DRIVER=memory`、svc-scheduler 的 `SCHEDULER_COMPARE_HEARTBEAT=on`）写 `targetModules[].fromDriver`，取代 v1 lint 第 4 条（04 §3.2.4 的 DRV-5）。
6. **人工前置**：不能自动满足的前置（`ses-identity`、`confirm-email`）写进 `prerequisites.learnerInputs`，开始前由学员填写，不进起始状态；`toolchain` 在平台模式下由 `base-deploy` 创建的工具链栈 `cloudalbum-<envName>-toolchain` 满足。
7. **平台固定部分**（不参与推导，只向学员说明）：`mgmt-channel`、`workstation`、`check-bundle`、`preview-direct-https`（方案 B 的 Let's Encrypt IP 证书，`startProfile.platform.preview.directHttps: 'on'`）。本批没有需要关闭方案 B 的卡片（C5 只要求 autoscaling、tls 类卡片关闭）。
8. **平台占位符**：灾备区域一律写 `${atl:drRegion}`（取平台安装参数 `DrRegion`，默认 `ap-northeast-3` 大阪），不在卡片中写死；用到灾备区域的卡片声明 `regions.extra: [dr-region]`，检查用 `region: dr-region` 与 `when: platform.drRegion != ''`（04 §3.2.2、§5.2.4）。
9. **与 05 起始状态原则的关系**：S2（`credentials: optional` 的目标模块也加入 iam）已由 C3 采纳为通则；S5（VPC 绑定的卡片以 `network(public)` 起步）不采用——单服务卡片只预置闭包，shared-fs、database、cache 都在默认 VPC 中完成，卡片内不换 VPC，不会触发 DEP-016。

### 1.2 运行位置与身份

| 位置 | 用途 | 身份 |
|---|---|---|
| 工作台终端（workstation） | `scripts/module`、AWS CLI、`npm run exp … --upload`（k6 负载机） | `ATLLearnerRole`（会话名 `atl-<sid>-ws`） |
| 实验机终端（SSM） | 查看本机状态、`node dist/cli.js …`、`psql` / `valkey-cli` 连接 VPC 内的托管服务 | `labuser`（sudo） |
| 控制台（联合登录，新标签页） | 查看与修改资源 | `ATLLearnerRole`（会话名 `atl-<sid>-console`） |
| 应用预览 | 浏览 CloudAlbum、DevTools 观察请求 | CloudAlbum 管理员（初始密码见平台） |

- 工作台（栈 `atl-ws-<sid>`）与 L0 实验机**同在默认 VPC 的公有子网**（03 §4.4），但它的安全组是平台的 `atl-ws-<sid>-sg`。RDS、ElastiCache、EFS 的安全组只放行**实验机的安全组**，所以从工作台直接连 5432 / 6379 / 2049 会超时——拦住它的是安全组链，不是 VPC 边界（这正是本批要讲的考点：同一 VPC 内也要靠安全组引用来限定来源）。需要时用实验机终端，或 Session Manager 端口转发（03 §4.8）。
- `scripts/module` 在平台模式下给栈打 `atl:component=env`、`atl:session-id`、`atl:lab-id`、`atl:env-id`、`Project=CloudAlbum` 标签（C4(d)）；`state.json` 在环境状态桶 `cloudalbum-lab-state-<acct>-<region>` 的 `<envName>/` 前缀下，环境操作锁在 `cloudalbum-lab-locks` 表中（C4(c)）。
- **归属只认创建证据，不认标签**（04 §5.2.4）：学员手工创建的资源（第二台 EC2 的栈、PITR 恢复出的实例、演练 AMI 等）由 CloudTrail 中学员会话的创建事件认领——检查时先查 02 的台账，查不到就请求 02 的**定向扫描** `OwnershipLookup`（C4(e)：CloudTrail 事件历史 `LookupEvents`，在资源所在区域查询，管理事件有分钟级投递延迟，首次检测通常是 `OWNERSHIP_PENDING`，之后按 2、2、4、4、8 分钟重试，默认最多 20 分钟）。手册**不要求**补打标签；创建时可以顺手带上 `atl:session-id`、`atl:env-id`（学员边界允许设置会话类标签），只用于发现候选资源。临时实例**不得**带 `atl:role=lab-app`，否则实验机发现会命中多台（04 §5.2.1）。

### 1.3 检查类型的写法

步骤表中的检查按“类型 · 判定要点”书写，类型沿用 04 §5：`local`（括号内为 ATL-RunCheck 的 `checkId`）、`capability`（“healthy”即 `op: healthy`）、`http-header`（`from: platform | lab`，目标为 04 §5.2.3 的枚举）、`aws-readonly`（判定会话资源时带 `ownership`：学员在本卡创建的为 `session`，起始状态预置的为 `session-or-start`）、`experiment`、`manual`。描述起始（before）状态的检查一律 `drift: once`（C3；04 §3.5 第 9 条把漏写列为 lint 错误）。

- **路径证据**：段出现在 GET 上的模块，用 `http-header`（`from: lab`，`target: self`）请求 CloudAlbum 的探测端点 `/api/lab/probe/now` 或 `/api/lab/probe/media-url`（C5：探测端点统一为 `/api/lab/probe/*`，请求头 `X-ATL-Probe-Token`，引擎自动附带本机令牌；端点清单与各端点经过的端口以 06 为准，附录 C-15）；段只出现在 POST 或异步路径上的模块（queue、image-processing、email、notification、tagging、social-store、analytics），用 `local（path-seen）`：读取 LabMetricsStore 最近窗口内**真实请求**（排除探测请求）的路径签名，断言出现指定段。`path-seen` 已列入 04 §6.4 的检查目录（参数 `segment`、`pattern`、`window` ≤ 24h、`minCount`、`distinct?`，`excludeProbe` 固定为 true）。路径签名由应用按**实际调用的驱动**生成，学员用 curl 自己发请求也只能得到与当前驱动一致的段，伪造不了 AWS 段。
- **对比实验**：在工作台运行 `npm run exp -- <module> --label <变体> --scenario <id> [--param k=v] --upload`（参数形式以 06 为准）。`--label` 接受卡片 `experiments[].labels` 中声明的**任意变体**（`before`、`after`，以及本批的 `memory`、`l0` 等），平台在结果中标注 `variant`（C5，04 §3.2.10）。平台用实验机上 LabMetricsStore 按 `runId` 的统计做佐证（04 §7.4）。必需实验一律 `runner: workstation`。**只有经 `npm run exp … --upload` 运行的场景才会登记 `runId` 并上传结果**；模块文档中直接调用的 `npx tsx experiments/<module>/<scenario>.ts`、`bash experiments/<module>/<scenario>.sh`、`k6 run …` 在卡片中一律改写为 `npm run exp -- <module> --scenario <scenario> --upload`（运行器执行同一脚本），只有不产生实验结果的辅助脚本（seed、poison、dlq-replay、faults、drill）才直接调用。
- **aws-readonly 的 action 名**：按 04 §5.7 第 2 轮的统一约定，`action` 写 **SDK 操作名**（例如 S3 的 `GetPublicAccessBlock`、`GetBucketNotificationConfiguration`、`GetBucketEncryption`），由 `labs:policy` 的映射表换算成 IAM 动作（C1；附录 C-14 已解决）。

### 1.4 费用档位

采用 05 §2.7.3 的判定（只看计费结构，与第 1 批 §1.2 相同）。“基础”不计入：实验机（t4g.small + 根卷 + 20 GiB 数据卷 + 公网 IPv4）+ 工作台（t4g.small + 根卷 + 公网 IPv4），每张卡片都有，开始实验时平台按 02 §10.1 单独报价；起始状态中预置的模块**计入**。

| 档位 | 判定 |
|---|---|
| 低 | 除“基础”外没有额外的按小时计费资源；其余全是按量（请求、存储、扫描量）或按月折算的小额固定项，也没有开启账号级按量服务（GuardDuty、Config、Inspector） |
| 中 | 额外的按小时计费资源恰好 1 个单位（单个 RDS 实例、单个 ElastiCache 节点、一台临时 EC2 等），或会话期间开启了账号级按量服务 |
| 高 | 额外的按小时计费资源 ≥ 2 个单位（例如 RDS + Multi-AZ 备库） |

卡片显示必需步骤的档位；选做步骤会抬高档位时追加“（选做 → 中/高）”（05 §2.7.3）。本批两处：svc-social-store 的限流实验短时切到预置容量、svc-image-processing 的冷启动对照临时配置预置并发，二者都按时长计费。

### 1.5 难度与时长

难度采用 05 §2.7.1 的四级（满足任一条即归入较高一级）：**入门** = 不启用任何 AWS 模块（本批没有入门卡，入门只有 `svc-ec2`）；**初级** = 1～2 个模块、概念集中在单个服务、没有 VPC 绑定资源；**中级** = 多个服务相互配合（事件路由、数据湖）、需要等待云端生效、或涉及网络与权限的交互；**高级** = 多 AZ 与故障转移、灾备恢复，或同时运行多个按小时计费的资源。据此本批：初级 storage、social-store、queue、notification、email、scheduler、tagging、social-api；中级 shared-fs、cache、analytics、image-processing；高级 database、backup。

时长按 05 §2.7.2：预计时长取 15 分钟的整数倍，含实验中的云端等待（RDS、ElastiCache 创建），不含环境准备；时间上限取 30 分钟的整数倍且 ≥ 预计 × 1.5（04 lint 第 12 条）。

### 1.6 每张卡片的结构

元数据表 → 实验简介（背景、你将学到、实验资源）→ 步骤大纲（5～8 步，含步骤类型与检查）→ 对比实验 → 小测（3 题）→ 清理说明 → 对应 SAA 考点。**徽章只看完成**（C3）：完成卡片（最终复核通过）即获得徽章（元数据表“徽章”一行）；小测不影响完成，也不影响徽章，历次最好成绩只记录在徽章上；证书只由学习路径颁发（模型以 tracks-and-catalog 为准）。两批的不一致已统一（附录 C-16）。

---

<a id="svc-storage"></a>

## svc-storage · Amazon S3：照片对象存储

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-storage` |
| kind | `service` |
| 标题 | Amazon S3：照片对象存储 |
| 一句话简介 | 把照片从 EC2 的 EBS 数据卷搬进 S3，上传改为浏览器拿预签名 URL 直传，亲眼看到 EC2 网卡不再承载上传流量。 |
| 涉及的 AWS 服务 | 主：Amazon S3；辅助：AWS IAM（实例角色，起始状态预置）；观察：Amazon EventBridge（桶级事件投递，本卡只开启不消费）、Amazon EC2 / EBS（对照组） |
| 对应的模块 | `storage`（[03#storage](../../modules/03-data-storage.md#storage)） |
| 难度 | 初级（启用 1 个 AWS 模块并有数据迁移，05 §2.7.1 不能归为入门；与 `saa-main` 中原 Lab 4 一致） |
| 预计时长 | 60 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`：起点（档位 `atl/svc-storage/default`）。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则；storage 本身也是 `credentials: required`，缺凭证时 CRED-001 拒绝启动。**未并入**：kms、cdn（registry `soft`，只影响子功能）；shared-fs 与本模块互斥（MUTEX-001）。storage 的 `requires` 为空 |
| 目标模块 | `storage`：`STORAGE_DRIVER=s3`，默认参数（含 `migrate-module storage up`） |
| 费用档位 | 低。主要计费来源：S3 存储（GB-月，版本控制保留的旧版本同样计费）、PUT / GET 请求、流出互联网的流量；没有按小时计费的资源 |
| 人工前置 | 无 |
| SAA 考试领域 | 高性能、弹性、安全、成本 |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`（软依赖） |
| 预期警告 | 无（`expectedWarnings: []`） |
| 徽章 | “S3 直传” |

完整的 `lab.yaml` 见 [附录 A](#附录-asvc-storage-的完整-labyaml)。

### 实验简介

**背景**：L0 中原图字节经 Nginx 流进 Node 进程，再写进 20 GiB 的 EBS 数据卷；同一块盘上还有 SQLite、日志、outbox 和本地备份。上传一多，EC2 的网卡与 CPU 被上传占满，其他接口跟着变慢；盘一满，连发评论（SQLite 写入）都会失败。

**你将学到**
- 预签名 PUT / GET：为什么“应用只签名、浏览器直传”能把上传负载从服务器上拿走；预签名 PUT 为什么限制不了大小（`complete` 时 `HeadObject` 校验）。
- S3 桶的安全基线：Block Public Access、`BucketOwnerEnforced`（禁用 ACL）、只允许 HTTPS 的桶策略、默认加密。
- 版本控制 + 生命周期：防误删与成本的平衡（转 Standard-IA 的最短天数、中止未完成的分段上传、非当前版本过期）。
- S3 事件统一经 EventBridge 投递，避免“同一事件类型不能有重叠通知目标”的冲突（MUTEX-004）。
- S3 与 EBS 的耐久性、容量与多实例共享方式的差别。

**实验资源**
- 起始状态（平台预置）：实验机（L0，照片在 `/var/lib/cloudalbum/uploads`）、iam 模块的只读基础策略。
- 本卡创建：栈 `cloudalbum-<envName>-storage`——原图桶（版本控制、生命周期、只开 EventBridge 投递）、展示桶、客户托管策略（附加到 `CloudAlbumAppRole`）。
- 工作台：k6 负载机（与实验机同在默认 VPC，但请求发往实验机的公网入口，与真实用户路径一致）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `orient` 观察起始状态 | 观察 | 在应用预览上传 1 张照片，DevTools 中 PUT 的目标是本站 `/api/storage/upload`；实验机终端 `df -h /var/lib/cloudalbum` | capability · `storage.driver=local`、`status=off`、`localHealth=ok`（once）；local（`disk-usage`）· 记录数据卷 `usedPct`（warn，只展示） |
| 2 | `baseline` 记录基线 | 对比实验 | `FILE_MB=5 npm run exp -- storage --label before --scenario upload-burst --vus 10 --duration 60s --upload` | experiment · `upload-burst` before 有效（服务端按 runId 统计的请求数 ≥ 客户端声称的 90%） |
| 3 | `enable` 接入 S3（wire） | 脚本 | `scripts/module enable storage --dry-run` 看变更 → `scripts/module enable storage`（部署两个桶与策略 → 只读窗口内迁移 → 重启 → 深度探针）；然后在预览中上传 1 张 | capability · `storage.driver=s3`、healthy；http-header（lab，`self`，`/api/lab/probe/media-url`）· 返回的 URL 主机为本会话原图 / 展示桶的 S3 区域端点、带 `X-Amz-Signature`，路径段 `storage` 以 `s3` 开头；local（`path-seen`，15 分钟）· 真实上传请求出现 `storage=s3:presign` |
| 4 | `inspect-bucket` 检查桶配置 | 控制台 | S3 控制台打开原图桶：“权限”（BPA、对象所有权、桶策略）、“属性”（版本控制、默认加密、Amazon EventBridge 通知）、“管理”（生命周期规则） | aws-readonly（SDK 操作名，04 §5.7）· `GetPublicAccessBlock` 四项均为 true（must-hold）；`GetBucketVersioning` 为 Enabled；`GetBucketEncryption` 为 SSE-S3 或 SSE-KMS；`GetBucketNotificationConfiguration` 只有 `EventBridgeConfiguration`（MUTEX-004）；`ownership: session` |
| 5 | `observe-direct-upload` 观察直传 | 观察 | 预览中再传 3 张；DevTools 看 PUT 主机与 `X-Amz-Signature`；工作台 `aws s3api list-objects-v2 --bucket {{ var.rawBucket }} --prefix raw/ --max-items 5` | manual · “PUT 请求发往哪里”选对（S3 区域端点）；local（`net-bytes`，5 分钟）· 记录实验机收字节数（warn，只展示） |
| 6 | `after` 记录 after | 对比实验 | 同第 2 步参数，`--label after` | experiment · `upload-burst` pair（before 与 after 均有效，`environment.drivers.storage` 分别为 local / s3） |
| 7 | `sidebyside`（选做） | 对比实验 | `--scenario upload-sidebyside`：同一时间、同一实例交替走 local 与 s3 两条路径，只写 `lab/` 前缀，结束后自动清理 | experiment · `upload-sidebyside` after（非必需） |
| 8 | `ebs-growth`（选做） | 对比实验 | `--scenario ebs-growth`：balloon 把数据卷压到阈值以下，观察上传仍成功、评论却写失败；脚本结束时自动 `balloon.sh release` | experiment（非必需）；local（`disk-usage`）· 结束后 `usedPct` 回到压测前水平（must-hold，防止占位文件残留） |

> **取舍**：模块文档的压测默认 `FILE_MB=20`、120 秒。卡片改为 `FILE_MB=5`、60 秒：L0 的 before 轮会把原图写进 20 GiB 的数据卷，默认参数可能逼近 507 阈值，污染后续步骤；方向与数量级的结论不受影响。

### 对比实验

引用 [03#storage 第 5 节](../../modules/03-data-storage.md#storage)：`experiments/storage/upload-burst.k6.js`（必需）、`upload-sidebyside`、`ebs-growth`（选做）。

| 观察点 | 没有 S3（EBS + Node 落盘） | 有 S3（预签名直传） |
|---|---|---|
| 上传字节路径 | 浏览器 → Nginx → Node → EBS | 浏览器 → S3，EC2 只签发 URL |
| 实验机网卡收字节（`/proc/net/dev`） | 与上传总量同一数量级 | 只有 KB 级的签名请求，不随上传量增长 |
| API 进程 CPU、事件循环延迟 | 并发大文件时明显升高 | 基本不变 |
| 同时段 `GET /api/feed` p95 | 被上传拖慢 | 不受影响 |
| 容量与写满 | 受 20 GiB 限制，写满时 507 且 SQLite 写失败 | 无需预置；但 SQLite 仍在这块盘上（ebs-growth 中评论仍会失败） |
| 路径头 | `storage=local:sign` / `local:write` / `local:accel` | `storage=s3:presign` / `s3:redirect` |
| 耐久性 | EBS 在单个 AZ 内冗余 | S3 Standard 跨多个 AZ 存储（以官方文档为准） |

### 小测

1. **单选**：一个照片网站把上传请求先发给 EC2 上的应用，再由应用写入存储。高峰时 EC2 的网络与 CPU 被上传占满。用最少的运维改动卸载这部分负载，应该：
   - A. 把实例换成更大的规格
   - B. 由应用签发 S3 预签名 URL，浏览器直接把文件上传到 S3
   - C. 把上传目录改到 EFS
   - D. 在 EC2 前加 CloudFront 缓存上传请求

   **答案**：B。**解析**：预签名 URL 让应用只做鉴权与签名，字节不再经过服务器；A 只是推迟问题；C 仍由应用接收字节；CloudFront 不缓存 PUT，上传仍会回源。
2. **多选（选两项）**：原图处理完成后很少再读，但要防误删并控制成本。原图约数 MB，缩略图大多小于 128 KB。应该：
   - A. 开启版本控制，并配置非当前版本在 30 天后过期的生命周期规则
   - B. 用生命周期规则把原图（`raw/` 前缀）的当前版本在 30 天后转为 S3 Standard-IA
   - C. 把缩略图转为 S3 Intelligent-Tiering 以自动节省费用
   - D. 把桶设为公开读取，减少预签名 GET 的请求费

   **答案**：A、B。**解析**：版本控制能恢复误删，非当前版本过期避免旧版本无限累积；Standard-IA 适合 MB 级、低频访问的原图（有 30 天最短存储期与 128 KB 最小计费尺寸，生命周期转换到 Standard-IA 也至少要在创建 30 天后）。Intelligent-Tiering 对小于 128 KB 的对象不做自动分层，缩略图得不到收益；公开桶是安全风险。
3. **单选**：私有子网中的 EC2 需要读写 S3，要求流量不经互联网，并且不产生 NAT 网关的数据处理费。最合适的是：
   - A. 为 S3 创建网关型 VPC 终端节点，并关联私有子网的路由表
   - B. 部署 NAT 网关
   - C. 与 S3 建立 VPC 对等连接
   - D. 给实例分配公网 IP

   **答案**：A。**解析**：S3（以及 DynamoDB）的网关型终端节点不按小时收费、不经 NAT；接口型终端节点也能私有访问 S3，但按小时计费；S3 不是 VPC，无法对等。

### 清理说明

- 平台回收会清空两个桶的**全部版本**与删除标记后删桶（桶的 `DeletionPolicy: Retain` 只影响栈删除，不影响回收）。不需要在卡片内执行 `disable storage`（反向迁移耗时，且没有必要）。
- 不要上传私人照片：版本控制会保留旧版本，直到回收时才被删除。
- 做过 `ebs-growth` 而脚本中途被中断时，在实验机执行 `sudo experiments/storage/faults/balloon.sh release`，否则选择“保留环境”时数据卷仍是满的。
- 选择“保留环境”期间 S3 存储继续按量计费（很小）。

### 对应 SAA 考点

预签名 URL 与浏览器直传（有效期上限、临时凭证签名的 URL 会随凭证提前失效）；Block Public Access、`BucketOwnerEnforced`、桶策略 `aws:SecureTransport`；SSE-S3 / SSE-KMS / Bucket Key；版本控制、生命周期与存储类别（Standard-IA 的最短存储期、Intelligent-Tiering 的 128 KB 门槛、Glacier 各档）；S3 事件通知 vs EventBridge；分段上传与 CORS；S3 网关终端节点；S3 与 EBS 的耐久性对比。

---

<a id="svc-shared-fs"></a>

## svc-shared-fs · Amazon EFS：多实例共享文件系统

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-shared-fs` |
| kind | `service` |
| 标题 | Amazon EFS：多实例共享文件系统 |
| 一句话简介 | 把上传目录从 EBS 换到 EFS，不改一行业务代码，让第二台实例读到第一台刚写入的照片，并量一量 NFS 的小文件延迟。 |
| 涉及的 AWS 服务 | 主：Amazon EFS；辅助：Amazon EC2（临时第二台实例 B，t4g.micro）；观察：Amazon VPC（默认 VPC、`sg-efs` 的 TCP 2049 规则） |
| 对应的模块 | `shared-fs`（[03#shared-fs](../../modules/03-data-storage.md#shared-fs)） |
| 难度 | 中级 |
| 预计时长 | 75 分钟 |
| 时间上限 | 120 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2` + ② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`；档位 `atl/svc-shared-fs/default`）：shared-fs 的 `requires` 为空，iam 按 C3 预置；挂载目标放在默认 VPC 中实例所在 AZ 与另一个 AZ 的默认子网（默认 VPC 已开启 DNS 解析）。有了实例角色，`scripts/module` 按模块文档自动采用 `IamAuth=true`：文件系统策略只保留“拒绝非 TLS”、不再允许匿名客户端，挂载必须带 `tls,iam` 选项，挂载权限由附加到 `CloudAlbumAppRole` 的模块策略授予（IAM 授权的 NFS 客户端是 SAA 考点）。**未并入**：storage——与本模块互斥（MUTEX-001），起始状态里**不能**有它；network——不是硬依赖，卡片内不换 VPC（DEP-016 不触发） |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | `shared-fs`：`STORAGE_DRIVER=efs`，`IamAuth=true`（起始状态带实例角色时的模块默认），`ThroughputMode=elastic` |
| 费用档位 | 中。主要计费来源：临时实例 B（t4g.micro，1 个按小时计费单位，做完即删）；EFS 存储（GB-月）与 Elastic 吞吐的读写量。B 必须放在第二个挂载目标所在的 AZ 并挂载本 AZ 的挂载目标，这样不产生跨 AZ 数据传输费 |
| 人工前置 | 无 |
| SAA 考试领域 | 弹性、高性能、成本 |
| 推荐的前置卡片 | `svc-ec2`；建议先做 `svc-storage`（两者是“多实例共享照片”的两种方案） |
| 徽章 | “共享目录” |

### 实验简介

**背景**：单实例时上传目录在本机 EBS 上，一切正常；一旦出现第二台实例（Auto Scaling），在 A 上传的照片到了 B 就是 404。S3 是一种解法（需要改存储接口），EFS 是另一种：同一套 `LocalStorage` 代码只换根目录。

**你将学到**
- EFS 的挂载目标按 AZ 部署，安全组放行 TCP 2049（来源写实例安全组，而不是 CIDR）；一个文件系统同一时间只能在一个 VPC 里有挂载目标。
- 访问点强制 POSIX 身份（uid/gid 2001）与根目录；文件系统策略一旦存在，默认的匿名完全访问就失效；`IamAuth=true` 时挂载要带 `tls,iam`，由实例角色的身份策略授权（IAM 授权的 NFS 客户端）；TLS 挂载依赖 amazon-efs-utils。
- 吞吐模式（Bursting / Provisioned / Elastic）与存储类别；为什么 SQLite 不能放在 NFS 上。
- EBS、EFS、S3 怎么选：块存储 / 共享 POSIX / 对象存储 + HTTP 分发。

**实验资源**
- 起始状态：实验机 A（L0）、iam 基础策略（C3）。
- 本卡创建：栈 `cloudalbum-<envName>-shared-fs`（文件系统、两个挂载目标、`sg-efs`、访问点、客户托管策略）；主机侧安装 amazon-efs-utils、写 fstab、投放 systemd drop-in（含 `cloudalbum-api@` 模板单元）。
- 学员手工创建：临时实例 B（`experiments/shared-fs/second-instance.yaml`，t4g.micro，**第二个挂载目标所在的 AZ**，同一实例安全组，实例配置文件 `CloudAlbumAppRole`——既用于经 SSM 投递命令，也用于 `IamAuth=true` 的 IAM 授权挂载；**不带** `atl:role=lab-app`）。东京区域有 3 个 AZ，而挂载目标只建 2 个：B 若落在第三个 AZ，文件系统 DNS 名解析不到本 AZ 的挂载目标，挂载会失败。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `orient` 观察起始状态 | 观察 | `/lab` 共享文件系统卡片：根目录在 EBS、类型 `xfs`、跨实例可见性“不可见” | capability · `shared-fs.status=off`、`storage.driver=local`（once）；local（`disk-usage`，数据卷）· `fstype=xfs` |
| 2 | `deploy-peer` 启动实例 B | CLI | 先执行 `scripts/module enable shared-fs --dry-run`，记下计划中**第二个挂载目标的子网**（与实验机不同 AZ）；再在工作台 `aws cloudformation deploy --template-file experiments/shared-fs/second-instance.yaml --stack-name cloudalbum-{{ session.env }}-exp-peer --parameter-overrides SubnetId=<该子网> FileSystemId= AccessPointId= --tags atl:session-id={{ session.id }} atl:env-id={{ session.envId }} atl:lab-id=svc-shared-fs Project=CloudAlbum`（文件系统参数先留空，B 上只建空目录；标签只用于发现） | aws-readonly · `ec2:DescribeInstances`：B 为 running、`t4g.micro`、AZ ≠ `{{ target.az }}`（`ownership: session`：B 带 `aws:cloudformation:stack-name`，按“父资源”规则归属于学员本会话创建的 `exp-peer` 栈，栈本身经台账或定向扫描确认）；aws-readonly · `ssm:DescribeInstanceInformation`：B 的 `PingStatus=Online` |
| 3 | `baseline` 跨实例可见性（before） | 对比实验 | `npm run exp -- shared-fs --label before --scenario cross-instance --param peer=<B 的实例 ID> --upload`：经 A 上传 1 张，在 B 上每 200 ms `stat` 一次 | experiment · `cross-instance` before 有效（结果应为“不可见”） |
| 4 | `enable` 接入 EFS（wire） | 脚本 | `scripts/module enable shared-fs`（建文件系统与挂载目标 → 主机侧挂载并确认 `nfs4` → 迁移 → 重启） | capability · `shared-fs.driver=efs`、healthy；local（`disk-usage`，`/mnt/efs/cloudalbum`）· `fstype=nfs4`；http-header（lab，`self`，`/api/lab/probe/media-url`）· 路径段 `shared-fs` 以 `efs` 开头 |
| 5 | `inspect` 看懂网络与权限 | 控制台 | EFS 控制台：挂载目标（每 AZ 一个）、`sg-efs` 入站规则、访问点的 POSIX 用户、加密、吞吐模式、文件系统策略 | aws-readonly · `elasticfilesystem:DescribeMountTargets`：≥ 2 个，且分别覆盖 `{{ target.az }}` 与 B 所在的 AZ（`dependsOn` 第 2 步检查，引用其证据中的 AZ）；`DescribeFileSystems`：`Encrypted=true`、`ThroughputMode=elastic`；`ec2:DescribeSecurityGroupRules`：2049 的来源是实例安全组、没有 CIDR；`elasticfilesystem:DescribeAccessPoints`（04 §5.7 第 2 轮已收录）：`PosixUser` 为 2001:2001；manual · 文件系统策略中是否还有允许匿名客户端的语句（期望没有：`IamAuth=true`） |
| 6 | `after` 跨实例可见性（after） | 对比实验 | 用 `--parameter-overrides FileSystemId=… AccessPointId=…`（取自 `stack.shared-fs` 输出）**替换** B（模板应把这两个参数用于 `cfn-init` / SSM 挂载命令，或以“参数变化 → 替换实例”的方式实现：EC2 的 User Data 只在首次启动时执行，单纯更新 User Data 不会让已运行的 B 去挂载）；B 以 `tls,iam` 选项挂载同一个访问点后再跑 `--label after` | aws-readonly · `ssm:DescribeInstanceInformation`：B 仍为 `Online`；experiment · `cross-instance` pair（after 应为“可见”，并给出首次可见耗时） |
| 7 | `fs-bench` 小文件基准 | 对比实验 | `npm run exp -- shared-fs --label after --scenario fs-bench --upload`：同机对比 EBS 旧目录与 EFS（1000 个 64 KB 文件，并发 1 与 16） | experiment · `fs-bench` after 有效 |
| 8 | `sg-fault`（选做） | 脚本 | `experiments/shared-fs/faults/revoke-2049.sh`：临时删除 2049 规则，在 B 上重新挂载（会卡到超时），再恢复 | aws-readonly · 恢复后 2049 规则仍在（must-hold） |

### 对比实验

引用 [03#shared-fs 第 5 节](../../modules/03-data-storage.md#shared-fs)：`cross-instance`（必需）、`fs-bench`（必需）、安全组故障演示（选做）。

| 观察点 | 没有 EFS（EBS） | 有 EFS |
|---|---|---|
| 实例 B 能否读到 A 刚上传的照片 | 不能（B 上是空目录） | 能；写入并关闭后，B 下一次打开即可见（通常在一次轮询间隔内） |
| `/lab` 卡片的文件系统类型 | `xfs` | `nfs4`（TLS 挂载时来源显示为 `127.0.0.1:/`，那是 efs-utils 的本地代理） |
| 单个小文件操作延迟（写、stat、读、删） | 最低（亚毫秒到毫秒级） | 毫秒级，元数据操作更明显；单线程顺序处理大量小文件时差距被放大 |
| 并发提高后的总吞吐 | 受卷类型与实例限制 | 多客户端并行时可以扩展 |
| 业务代码 | `LocalStorage` | 同一个 `LocalStorage`，只换根目录 |
| 路径头 | `storage=local:accel` | `shared-fs=efs:accel`（段名取适配器的 `meta.module`） |
| 挂载丢失时 | — | 上传返回 503，模块 `error`，不会悄悄写到 EBS 上 |

### 小测

1. **单选**：Web 层在两个 AZ 中各有若干 Linux EC2 实例，需要共享同一个 POSIX 目录存放用户上传的文件，希望尽量不改代码。应选择：
   - A. EBS Multi-Attach
   - B. Amazon EFS
   - C. 每台实例的实例存储，加 rsync 定时同步
   - D. Amazon FSx for Windows File Server

   **答案**：B。**解析**：EFS 是跨 AZ、多实例共享的 NFS 文件系统。EBS Multi-Attach 只支持特定卷类型、同一 AZ，且需要集群感知的文件系统；实例存储不持久；FSx for Windows 面向 SMB / Windows。
2. **多选（选三项）**：某实例挂载 EFS 时超时或解析失败，可能的原因有：
   - A. 该实例所在 AZ 没有挂载目标，而挂载命令使用的是文件系统 DNS 名
   - B. 挂载目标的安全组没有放行来自实例安全组的 TCP 2049
   - C. 文件系统没有开启版本控制
   - D. 实例所在 VPC 没有开启 DNS 解析

   **答案**：A、B、D。**解析**：文件系统 DNS 名解析到同一 AZ 的挂载目标，该 AZ 没有挂载目标时解析失败；NFS 走 TCP 2049；自定义 VPC 必须开启 DNS 支持。EFS 没有“版本控制”这个设置。
3. **单选**：一个 HPC 作业需要极高吞吐、亚毫秒延迟的并行文件系统，并能直接加载 S3 中的数据集。应选择：
   - A. Amazon EFS（Max I/O）
   - B. Amazon FSx for Lustre
   - C. Amazon S3 Glacier Instant Retrieval
   - D. EBS io2 卷

   **答案**：B。**解析**：FSx for Lustre 面向 HPC，可与 S3 数据仓库关联；EFS 面向通用共享文件；Glacier 是归档存储类别；EBS 卷不是跨实例的并行文件系统。

### 清理说明

- **实例 B 按小时计费**：第 7 步做完（要做选做第 8 步则在第 8 步之后，它需要在 B 上重新挂载）就删除 `cloudalbum-<envName>-exp-peer` 栈（`aws cloudformation delete-stack …`）；忘了也会被平台回收，但期间一直计费。
- 文件系统 `DeletionPolicy: Retain`，平台回收会先删挂载目标再删文件系统；不需要在卡片内 `disable shared-fs`（反向迁移耗时）。
- 做过 `sg-fault` 时确认 2049 规则已恢复，否则“保留环境”后应用会因挂载丢失返回 503。

### 对应 SAA 考点

EBS / EFS / S3 的选择；挂载目标按 AZ 部署与安全组 2049；一个文件系统只属于一个 VPC；性能模式与吞吐模式（Elastic 避免积分耗尽）；存储类别（Standard、IA、Archive、One Zone）与生命周期；访问点、文件系统策略、IAM 授权挂载、TLS 传输加密、静态加密只能在创建时开启；FSx for Windows / Lustre 的定位；EFS 是 AWS Backup 支持的资源，可跨区域复制。

---

<a id="svc-database"></a>

## svc-database · Amazon RDS for PostgreSQL：托管关系数据库

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-database` |
| kind | `service` |
| 标题 | Amazon RDS for PostgreSQL：托管关系数据库 |
| 一句话简介 | 把 SQLite 换成 Multi-AZ 的 RDS for PostgreSQL，同一套 Knex 仓储代码换来托管备份、时间点恢复与自动故障转移，并亲手触发一次故障转移。 |
| 涉及的 AWS 服务 | 主：Amazon RDS for PostgreSQL；观察：Amazon VPC（DB 子网组、`sg-db`）、Amazon CloudWatch（`DatabaseConnections`） |
| 对应的模块 | `database`（[03#database](../../modules/03-data-storage.md#database)）；扩展 db-proxy 不在本卡（见 `svc-db-proxy`、`sc-db-performance`） |
| 难度 | 高级（Multi-AZ + 故障转移演练 + 数据迁移，且同时运行 2 个按小时计费的实例；05 §2.7.1，与 `saa-main` 中原 Lab 15 一致） |
| 预计时长 | 120 分钟（含 RDS 创建等待） |
| 时间上限 | 180 分钟 |
| 可延长次数 | 2 次 × 30 分钟（每次需要确认按小时计费的费用） |
| startProfile | ① `l0-ec2` + ② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`；档位 `atl/svc-database/default`）：database 的 `requires` 为空，iam 按 C3 预置——深度探针 `rds:DescribeDBInstances` 因此可用，`/lab` 直接显示 Multi-AZ 状态与主库 AZ；DB 子网组取默认 VPC 中至少两个 AZ 的默认子网。**未并入**：network——不是硬依赖（DEP-016 只约束“先建 RDS 再换 VPC”，卡片内不换 VPC）；kms、secrets——软依赖：存储用 `aws/rds` 默认密钥加密，主密码写在 `secrets.env`（`db-password`）；自建 PostgreSQL 本地档——作为选做步骤，不放进起始状态 |
| 目标模块 | `database`：`DB_DRIVER=postgres`（RDS），`--param MultiAz=true`，`db.t4g.micro`，PostgreSQL 16；`CreateReadReplica=false`（选做时改为 true） |
| 费用档位 | 高。主要计费来源：RDS 实例小时（Multi-AZ 的备库也按实例计，约为单 AZ 的两倍）、gp3 存储、超出免费额度的备份存储；选做的只读副本、PITR 恢复出的新实例各按一个实例小时计 |
| 人工前置 | 无 |
| SAA 考试领域 | 弹性、高性能、安全、成本 |
| 推荐的前置卡片 | `svc-ec2`（软）；之后：`svc-db-proxy`、`sc-db-performance` |
| 预期警告 | 无（`expectedWarnings: []`） |
| 徽章 | “托管数据库” |

### 实验简介

**背景**：L0 的用户、相册、照片元数据在 EBS 上的一个 SQLite 文件里，与 Node 同进程读写：单写者，高并发写时同步驱动阻塞事件循环；EC2 一停，数据库跟着停；备份和数据在同一块盘上。

**你将学到**
- Multi-AZ 实例部署（同步复制、自动故障转移、备库不可读）与只读副本（异步复制、扩展读、可跨区域）的区别。
- 自动备份与时间点恢复（恢复为**新实例**）；加密只能在创建时开启。
- 安全组链（实例 → 数据库只开 5432）、`PubliclyAccessible=false`、`rds.force_ssl`。
- “换成 RDS 不会让单次查询变快”：多一次网络往返，换来的是运维属性与高可用。

**实验资源**
- 起始状态：实验机（L0，SQLite）、iam 基础策略（C3）。
- 本卡创建：栈 `cloudalbum-<envName>-database`——DB 子网组、`sg-db`、参数组（`rds.force_ssl=1`、慢查询日志）、`db.t4g.micro` Multi-AZ 实例（gp3 20 GiB、加密、保留 7 天自动备份、删除时留最终快照）；实验机上的 RDS CA 包。
- 学员手工创建（选做）：PITR 恢复出的新实例。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `seed` 准备数据 | 脚本 | 实验机终端 `node dist/cli.js lab:seed --users 200 --albums-per-user 5 --photos 20000`（只写元数据行） | capability · `database.driver=sqlite`（once）；local（`app-stat`，`photos.count`）· ≥ 20000 |
| 2 | `baseline` 记录基线 | 对比实验 | `npm run exp -- database --label before --scenario mixed-rw --vus 10,50 --upload`；再跑 `--scenario failover --label before`（故障注入只做 `systemctl restart cloudalbum-api`） | experiment · `mixed-rw` before 有效；experiment · `failover` before 有效 |
| 3 | `enable` 接入 RDS（wire） | 脚本 | `scripts/module enable database --param MultiAz=true`：建 RDS（等待）→ 下载 CA → 只读窗口内迁移（停 worker）→ 重启 | capability · `database.driver=postgres`、healthy（detail 含 Multi-AZ 与主库 AZ）；http-header（lab，`self`，`/api/lab/probe/now`）· 路径段 `database=postgres@rds`；aws-readonly · `rds:DescribeDBInstances`：`MultiAZ=true`、`StorageEncrypted=true`、`PubliclyAccessible=false`、`DBInstanceStatus=available`（创建中为 pending，等待 typical 20 / max 45 分钟） |
| 4 | `inspect` 看懂网络与备份 | 控制台 | RDS 控制台：主库与备库所在 AZ、`sg-db` 入站、参数组、自动备份与“最近可恢复时间”；实验机终端用 `psql "sslmode=verify-full …"` 连一次 | aws-readonly · `ec2:DescribeSecurityGroupRules`：5432 的来源是实例安全组、无 CIDR；aws-readonly（检查 id `db-backup-az`）· `rds:DescribeDBInstances`：`BackupRetentionPeriod ≥ 1`、`LatestRestorableTime` 存在，证据中保留主库 `AvailabilityZone`（`evidence.keep`）；manual · “从工作台直接连 5432 的结果”（期望：超时。工作台与实验机同在默认 VPC，挡住它的是 `sg-db` 只放行实验机安全组；`PubliclyAccessible=false` 则让端点只解析到私有地址） |
| 5 | `after` 混合读写（after） | 对比实验 | 同第 2 步，`--label after` | experiment · `mixed-rw` pair |
| 6 | `failover` 故障转移 | 对比实验 | `npm run exp -- database --label after --scenario failover --upload`：运行器在第 30 秒执行 `aws rds reboot-db-instance --force-failover`，记录写失败区间 | experiment · `failover` pair；aws-readonly · `rds:DescribeDBInstances`：主库 `AvailabilityZone` 不等于 `{{$check.db-backup-az.$.DBInstances[0].AvailabilityZone}}`（04 §5.3 的跨检查引用，`dependsOn: [db-backup-az]`，即第 4 步记录 AZ 的那项检查），且 `DBInstanceStatus=available`（`pendingIf` 为 `rebooting`） |
| 7 | `pitr`（选做） | 脚本 | `experiments/database/pitr.sh`：恢复到 10 分钟前的**新实例**（同子网组、同 `sg-db`、`--tags` 带会话标签）→ `db:verify` → 立即删除。恢复出新实例本身还要十几分钟以上，剩余时间不足 40 分钟时跳过 | aws-readonly · 恢复实例存在且 `ownership: session`、`createdAfter: step.startedAt`；cleanup.verify · 该实例已删除 |
| 8 | `replica`（选做） | 脚本 / 对比实验 | `scripts/module enable database --param MultiAz=true --param CreateReadReplica=true`（创建副本同样要十几分钟以上，并成为第 3 个按小时计费的实例），再跑 `replica-read --ab` 与 `replica-lag` | experiment · `replica-read`、`replica-lag` after（非必需） |

> **取舍**：模块文档的故障转移基线还包括“停止实例 → 启动实例”。卡片不执行这一步：停机会中断平台管理通道与倒计时内的其他检查，改为在手册中作为思考题说明“SQLite 与 EC2 同生共死”。`mixed-rw` 只跑 10 与 50 两档并发，200 档留给 `sc-db-performance`。

### 对比实验

引用 [03#database 第 5 节](../../modules/03-data-storage.md#database)：`mixed-rw`、`failover`（必需），`pitr`、`replica-read`、`replica-lag`、`conn-storm`（选做；`conn-storm` 需要 `LB_LOCAL_WORKERS=2`，留给 `sc-db-performance`）。

| 观察点 | 没有 RDS（SQLite） | 有 RDS（Multi-AZ） |
|---|---|---|
| 低负载单次查询 | 进程内，最快 | 多一次同 VPC 网络往返；一个请求多次查询时累加 |
| 高并发写 | 单写者，同步驱动阻塞事件循环，事件循环延迟 P99 出现尖峰 | 异步 I/O，不阻塞事件循环，延迟随并发平缓上升 |
| 故障 | 跟着 EC2 一起停摆，人工恢复 | 自动故障转移，应用经历一段写失败后自动重连（以官方文档为准）；故障转移后主库换了 AZ，与实验机跨 AZ，延迟略升 |
| 备份 | 每天一次本地 `.backup`，与数据同盘 | 自动备份 + 保留期内任意时间点恢复 |
| 页面与路径头 | `database=sqlite`；管理后台“SQLite（EBS 文件）” | `database=postgres@rds`；故障转移期间顶部“数据库重连中” |

### 小测

1. **单选**：一个 RDS for PostgreSQL Multi-AZ 实例部署，报表查询拖慢了主库。最合适的做法是：
   - A. 把报表查询指向 Multi-AZ 的备库
   - B. 创建只读副本，报表查询改连副本的端点
   - C. 在前面加 RDS Proxy
   - D. 把存储从 gp3 改为 io2

   **答案**：B。**解析**：Multi-AZ **实例**部署的备库不可读，只用于故障转移；只读副本异步复制、可分担读。（Multi-AZ **集群**部署有两个可读备库，是另一种部署形态。）RDS Proxy 解决连接数问题，不分担查询负载。
2. **单选**：一个未加密的 RDS 实例需要改为静态加密。正确的做法是：
   - A. 在控制台修改实例，勾选“启用加密”
   - B. 创建快照 → 复制快照时选择 KMS 密钥加密 → 从加密快照恢复新实例 → 切换应用
   - C. 创建加密的只读副本，再提升为主库
   - D. 在参数组中设置 `rds.force_ssl=1`

   **答案**：B。**解析**：加密只能在创建时决定；未加密实例不能直接创建加密的只读副本；`rds.force_ssl` 是传输加密，与静态加密无关。
3. **多选（选两项）**：关于 RDS 自动备份与时间点恢复，正确的是：
   - A. 时间点恢复会创建一个新的数据库实例
   - B. 自动备份的保留期最长可设为 35 天
   - C. 时间点恢复会原地覆盖现有实例的数据
   - D. 手动快照会在自动备份保留期结束后自动删除

   **答案**：A、B。**解析**：PITR 总是恢复为新实例（需要指定子网组与安全组）；手动快照不会自动过期，需要手工删除。

### 清理说明

- **按小时计费**：做完必需步骤就可以提前结束实验；延长与“保留环境”都会继续按 Multi-AZ 的两个实例计费。
- 栈的 `DeletionPolicy: Snapshot` 会留下最终快照；平台回收按 02 §7.4 删除实例（跳过最终快照、删除自动备份）并删除已产生的最终快照，不需要在卡片内 `disable database`。
- 选做 PITR / 只读副本创建的实例：验证完立即删除（`pitr.sh` 末尾会删除；中断时手动执行 `aws rds delete-db-instance --skip-final-snapshot --delete-automated-backups`）。
- **不要开启删除保护**：它会让回收失败，会话进入 `CLEANUP_FAILED`。

### 对应 SAA 考点

Multi-AZ 实例部署 vs Multi-AZ 集群部署 vs 只读副本；自动备份（最长 35 天）、PITR（恢复为新实例）、手动快照、跨区域复制快照；加密只能在创建时开启、加密快照跨区域复制需要目标区域的 KMS 密钥；RDS 托管主密码与轮换、IAM 数据库身份验证；RDS Proxy 的定位；安全组链、DB 子网组、`PubliclyAccessible`、`rds.force_ssl`；停止的实例超过最长停止时间会被自动启动；RDS / Aurora / DynamoDB / EC2 自建数据库的取舍。

---

<a id="svc-cache"></a>

## svc-cache · Amazon ElastiCache：共享缓存

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-cache` |
| kind | `service` |
| 标题 | Amazon ElastiCache：共享缓存 |
| 一句话简介 | 给时间线加上 ElastiCache（Valkey），用同一部署里的逐请求 A/B 看“命中省掉几次查库”，再用单机两个进程看清进程内缓存的不一致。 |
| 涉及的 AWS 服务 | 主：Amazon ElastiCache（Valkey，节点模式）；观察：Amazon VPC（`sg-cache`）、Amazon CloudWatch（`CacheHits`、`CacheMisses`） |
| 对应的模块 | `cache`（[03#cache](../../modules/03-data-storage.md#cache)） |
| 难度 | 中级（VPC 绑定资源 + 安全组链 + 云端等待；与 `saa-main` 中原 Lab 16 一致） |
| 预计时长 | 90 分钟 |
| 时间上限 | 150 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`：cache 的 `requires` 为空，子网与 `sg-cache` 在默认 VPC 中。② **本地档** `LB_LOCAL_WORKERS=2`（load-balancer 的本地档：只启动第二个 api 进程 `cloudalbum-api@3001`，不部署 ALB、不写 `MODULE_LOAD_BALANCER=on`）：`stale-read` 实验需要多进程才能显出 memory 档的不一致（gen-single 规则 3）。③ `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，ElastiCache 的深度探针（Describe）因此可用。档位 `atl/svc-cache/default`。**未并入**：database——缓存不依赖它，sqlite 已足够演示“命中时 DB 查询为 0”，RDS 下的收益留给 `sc-db-performance` |
| 目标模块 | `cache`：`CACHE_DRIVER=redis`（ElastiCache），`CacheMode=nodes`、`Replicas=0`、`cache.t4g.micro`、传输与静态加密开启；过程中先切到本地档 `memory` 作对照 |
| 费用档位 | 中。主要计费来源：ElastiCache 节点小时（单节点）；Serverless 变体只在手册中选读（有最低存储计费量） |
| 人工前置 | 无 |
| SAA 考试领域 | 高性能、弹性、成本 |
| 推荐的前置卡片 | `svc-ec2`（软）；之后：`sc-db-performance` |
| 预期警告 | 无（`expectedWarnings: []`）。第 3 步的 memory 对照会因 ASG-004（单机多进程下的 warn 分支）而 `degraded`，该步不判 `status`，见附录 C-17、C-19 |
| 徽章 | “缓存命中” |

### 实验简介

**背景**：L0 的时间线每次都查库（`CACHE_DRIVER=none`）。本地档 memory 让每个 Node 进程各有一份 LRU：单进程时最快，但两个进程时，写入后约一半请求在 TTL 内返回旧数据——这就是多实例下“刷新时新旧数据交替”的单机预演。

**你将学到**
- 旁路缓存（cache-aside）、TTL、用版本号失效而不是删键；single-flight 防击穿。
- 进程内缓存与共享缓存的取舍：命中延迟、命中率、一致性、重启影响。
- ElastiCache 只能在 VPC 内访问；传输加密（TLS）、AUTH / RBAC；fail-open：缓存故障不能让请求失败。
- Valkey / Redis OSS 与 Memcached、DAX、CloudFront 缓存各自的位置。

**实验资源**
- 起始状态：实验机（L0，两个 api 进程：3000 与 3001）、iam 基础策略（C3）。
- 本卡创建：栈 `cloudalbum-<envName>-cache`——子网组、`sg-cache`、复制组（单节点 `cache.t4g.micro`，`DeletionPolicy: Delete`）、客户托管策略（只含深度探针的 Describe 权限）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `seed` 准备数据并观察 | 脚本 | 实验机 `node dist/cli.js lab:seed --users 200 --albums-per-user 5 --photos 20000`；预览打开时间线，看性能徽章“未缓存 · DB n 次”与路径头 `X-CloudAlbum-Upstream` 在两个进程间轮换 | capability · `cache.driver=none`（once）；local（`env-key`，`load-balancer.LB_LOCAL_WORKERS`）· = 2 |
| 2 | `baseline` 无缓存基线 | 对比实验 | `npm run exp -- cache --label before --scenario feed-read --vus 20 --duration 120s --upload` | experiment · `feed-read` before 有效 |
| 3 | `memory` 进程内缓存对照 | 脚本 + 对比实验 | `scripts/module enable cache --driver memory`；以变体 `memory`（基线角色，C5）跑 `stale-read --label memory`（两个进程的陈旧读）；可选 `feed-read --label memory` | capability · `cache.driver=memory`（本地档，once；`status` 不作判定：总纲 §5.2 说 `LB_LOCAL_WORKERS=2` 时 ASG-004 的 memory 分支以 warn 检查，warn 会把模块置为 `degraded`，而 03#cache 说不设规则、只显示黄色提示，二者未统一；ASG-004 在规则表中是 error 级，也不能写进 `expectedWarnings`，附录 C-17、C-19）；experiment · `stale-read` 变体 `memory` 有效（陈旧比例 > 0） |
| 4 | `enable` 接入 ElastiCache（wire） | 脚本 | `scripts/module enable cache`（建复制组，等待 typical 10 / max 25 分钟 → 写 env → 重启 → SET/GET/DEL 探针） | capability · `cache.driver=redis`、healthy；http-header（lab，`self`，`/api/lab/probe/now`，repeat 2）· 第 2 次路径段 `cache=redis@elasticache:hit`；aws-readonly · `elasticache:DescribeReplicationGroups`：`Status=available`、`TransitEncryptionEnabled=true`、`AtRestEncryptionEnabled=true`（`ownership: session`） |
| 5 | `inspect` 谁能连到缓存 | CLI | 实验机终端 `valkey-cli --tls -h <主端点> -p 6379 PING`（客户端由模块的启用步骤安装，包名以 AL2023 仓库为准）；工作台没有 Redis 客户端，用 `timeout 5 bash -c 'exec 3<>/dev/tcp/<主端点>/6379' && echo open \|\| echo blocked` 只测 TCP 能否建立 | aws-readonly · `ec2:DescribeSecurityGroupRules`：6379 的来源是实例安全组；manual · 两处连接的结果（期望：实验机 PONG，工作台 blocked。两者同在默认 VPC，端点也只解析到私有地址，挡住工作台的是 `sg-cache` 只放行实验机安全组） |
| 6 | `after` A/B 与一致性 | 对比实验 | `npm run exp -- cache --label after --scenario feed-read --ab --upload`（交替带 / 不带 `X-Compare-Bypass: cache`）；`--scenario stale-read --label after` | experiment · `feed-read` pair `[before, after]`；experiment · `stale-read` pair `[memory, after]`（after 的陈旧比例为 0） |
| 7 | `ttl-sweep`（选做） | 对比实验 | 运行器依次把运行时热键 `feedCacheTtlSec` 改为 10、60、300（不重启），每档 2 分钟 | experiment · `ttl-sweep` after（非必需） |
| 8 | `fail-open`（选做） | 对比实验 | `experiments/cache/faults/revoke-sg.sh` 临时撤销 `sg-cache` 入站规则，期间跑 `feed-read`，再恢复 | experiment · `fail-open` after（错误率 0、结果 `error-bypass`）；aws-readonly · 恢复后 6379 规则仍在（must-hold） |

### 对比实验

引用 [03#cache 第 5 节](../../modules/03-data-storage.md#cache)：`feed-read`（运行时 A/B，必需）、`stale-read`（必需）、`ttl-sweep`、`fail-open`、`cache-stampede`（选做）。

| 观察点 | 没有 ElastiCache（none；本地档 memory） | 有 ElastiCache |
|---|---|---|
| 每次时间线请求的 DB 查询 | none：每次若干次；memory：命中时 0 次 | 命中时 0 次 |
| 命中延迟 | memory：微秒级（进程内） | VPC 内一次网络往返（TLS 略高）；单进程时 memory 反而更快 |
| 两个进程写后读 | memory：约一半请求在一个 TTL 内返回旧数据 | 版本号共享，陈旧比例为 0 |
| 重启 api | memory：缓存清空、冷启动 | 不受影响 |
| 缓存故障 | — | fail-open：错误率保持 0，延迟退回无缓存水平，路径头 `error-bypass`，模块 `degraded` |
| 时间线性能徽章 | “未缓存 · DB 3 次” | “ElastiCache HIT · DB 0 次” |

### 小测

1. **单选**：Auto Scaling 组中的 Web 实例把会话保存在本机内存里，缩容后用户被随机登出。要以最低延迟解决，应该：
   - A. 在 ALB 上开启粘性会话
   - B. 把会话放进 Amazon ElastiCache（Valkey / Redis OSS）
   - C. 把会话写进每台实例的 EBS 卷
   - D. 把会话写进 S3

   **答案**：B。**解析**：会话外置到共享的内存存储，实例才是无状态的。粘性会话在缩容或实例故障时仍会丢会话；EBS 不共享；S3 延迟高。
2. **多选（选两项）**：在自行设计的节点式集群（非 Serverless）中，与 ElastiCache for Memcached 相比，只有 Valkey / Redis OSS 引擎提供的能力是：
   - A. 副本与 Multi-AZ 自动故障转移
   - B. 多线程的简单键值缓存
   - C. 备份与恢复（快照）
   - D. 在 VPC 内通过安全组控制访问

   **答案**：A、C。**解析**：节点式 Memcached 是多线程、无复制、无持久化的纯缓存；两种引擎都部署在 VPC 内、都用安全组控制。题干限定节点式，是因为 ElastiCache Serverless（含 Memcached）会自动把数据复制到多个 AZ（以官方文档为准），不限定会让 A 选项有歧义。
3. **单选**：一个读多写少的 DynamoDB 表需要微秒级读延迟，并且希望不改写应用的缓存逻辑。应选择：
   - A. ElastiCache for Valkey 旁路缓存
   - B. DynamoDB Accelerator（DAX）
   - C. DynamoDB 全局表
   - D. 提高预置的读容量

   **答案**：B。**解析**：DAX 是 DynamoDB 专用、API 兼容的直通缓存；ElastiCache 需要应用自己实现缓存逻辑；全局表解决多区域，不解决延迟到微秒。

### 清理说明

- **按小时计费**：节点从创建开始计费；平台回收直接删除复制组（缓存没有权威数据）。
- 做过 `fail-open` 而脚本中途被中断时，确认 `sg-cache` 的 6379 规则已恢复（`revoke-sg.sh restore`），否则“保留环境”后时间线一直走 `error-bypass`。
- `LB_LOCAL_WORKERS=2` 是本地档，随实验机一起删除，无需处理。

### 对应 SAA 考点

cache-aside 与 write-through、TTL 与失效策略；击穿、雪崩与 single-flight；Valkey / Redis OSS 与 Memcached 的区别；集群模式与非集群模式、Serverless 与节点模式的计费差异；只能在 VPC 内访问、TLS、AUTH / RBAC；Multi-AZ 需要至少一个副本；缓存层次（CloudFront、API Gateway 缓存、ElastiCache、DAX、只读副本）；会话外置是 ASG 无状态化的前提。

---

<a id="svc-social-store"></a>

## svc-social-store · Amazon DynamoDB：点赞、评论与分享链接

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-social-store` |
| kind | `service` |
| 标题 | Amazon DynamoDB：点赞、评论与分享链接 |
| 一句话简介 | 把点赞、评论、分享链接从关系库搬进一张按需计费的 DynamoDB 单表，用条件写入与事务保证幂等计数，用 TTL 让过期链接自动离场。 |
| 涉及的 AWS 服务 | 主：Amazon DynamoDB；辅助：AWS IAM（实例角色）；观察：Amazon CloudWatch（`ConsumedWriteCapacityUnits`、`ThrottledRequests`、`TimeToLiveDeletedItemCount`） |
| 对应的模块 | `social-store`（[03#social-store](../../modules/03-data-storage.md#social-store)）；social-api 的 Lambda 集成依赖本模块（见 `sc-serverless-api`） |
| 难度 | 初级 |
| 预计时长 | 60 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，social-store 本身也是 `credentials: required`（CRED-001）。档位 `atl/svc-social-store/default`。social-store 的 `requires` 为空；公有子网直接访问 DynamoDB 区域端点。**未并入**：kms（软依赖，表用 AWS 拥有的密钥加密）、database（社交表在当前关系库 SQLite 中，迁移脚本从这里导出） |
| 目标模块 | `social-store`：`SOCIAL_DRIVER=dynamodb`，`BillingMode=PAY_PER_REQUEST`，PITR 开启，TTL 属性 `expireAt` |
| 费用档位 | 低（选做 → 中）。主要计费来源：按需读写请求单位、存储、PITR；事务写约消耗两倍写容量；选做的限流实验短时切到预置容量（按预置量与时长计费，做完改回） |
| 人工前置 | 无 |
| SAA 考试领域 | 高性能、弹性、成本 |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`；之后：`sc-serverless-api` |
| 预期警告 | 无（`expectedWarnings: []`） |
| 徽章 | “单表设计” |

### 实验简介

**背景**：L0 中点赞、评论、计数与分享链接是 SQLite 里的几张表：靠事务和 `ON CONFLICT` 保证计数正确，靠每 10 分钟一次的清理任务删除过期链接；SQLite 单写者，并发点赞在事件循环上排队。

**你将学到**
- 分区键 / 排序键与单表设计（`PHOTO#<id>` 下的 `LIKE#`、`C#<ulid>`、`COUNTER`、`META`；`SHARE#<token>`）、GSI。
- 条件写入实现幂等、`TransactWriteItems` 全有或全无、原子计数 `ADD`；热点键与写分片。
- TTL：不消耗写容量、异步删除、读取时必须自己过滤。
- 按需与预置容量、限流与 SDK 退避重试。

**实验资源**
- 起始状态：实验机（L0）、iam 基础策略。
- 本卡创建：栈 `cloudalbum-<envName>-social-store`——表 `cloudalbum-<envName>-social`（PK/SK、GSI1、TTL、PITR、`DeletionPolicy: Retain`）、客户托管策略。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `baseline` 并发点赞基线 | 对比实验 | `npm run exp -- social-store --label before --scenario like-storm --vus 200 --duration 60s --upload`；跑完 `GET /api/lab/social/verify?photoId=<lab 照片>` | capability · `social-store.driver=db`（once）；experiment · `like-storm` before 有效 |
| 2 | `enable` 接入 DynamoDB（wire） | 脚本 | `scripts/module enable social-store`（建表并等待 TTL 生效 → 只读窗口内迁移，计数器按点赞与评论重新计算 → 重启）；在预览中点赞一次 | capability · `social-store.driver=dynamodb`、healthy；local（`path-seen`，15 分钟）· 真实请求出现 `social-store=dynamodb`；aws-readonly · `dynamodb:DescribeTable`：`ACTIVE`、`PAY_PER_REQUEST`、键为 PK/SK、存在 GSI1（`ownership: session`）；`DescribeTimeToLive`：`ENABLED`、属性 `expireAt`；`DescribeContinuousBackups`：PITR `ENABLED` |
| 3 | `explore` 看懂单表 | 控制台 | DynamoDB 控制台“探索表项”：按 `PK = PHOTO#<id>` 查询，找到 `LIKE#…`、`C#…`、`COUNTER`、`META` 各类项 | manual · “计数器项的 SK 是什么”（期望 `COUNTER`）与“评论的 SK 为什么用 ULID” |
| 4 | `after` 并发点赞（after） | 对比实验 | 同第 1 步 `--label after`；可加 `--scenario like-storm-sbs`（同部署侧路对比，只操作 `lab-` 照片） | experiment · `like-storm` pair（两种驱动计数都正确，差别在并发表现） |
| 5 | `naive-counter` 丢失更新 | 对比实验 | `--scenario naive-counter`：lab 专用的“先读、加一、再写回”接口与原子操作对比 | experiment · `naive-counter` after 有效（两种存储上“先读后写”都丢更新） |
| 6 | `share-ttl` 过期链接 | 对比实验 | `npm run exp -- social-store --label after --scenario share-ttl --param count=20 --param ttl=60 --duration 10m --upload`（运行器调用 `share-ttl.ts`）：链接过期后读取一律 410；表中条目由 TTL 在后台删除 | experiment · `share-ttl` after 有效（只判定“过期后读取即 410”） |
| 7 | `throttle`（选做） | 脚本 + 对比实验 | `scripts/module enable social-store --param BillingMode=PROVISIONED --param WriteCapacity=5` → 重跑 `like-storm` → 改回 `PAY_PER_REQUEST`（用栈参数，不在控制台改）。按需 → 预置随时可切；预置 → 按需在 24 小时滚动窗口内最多 4 次（2025-08 起的配额，以官方文档为准），本步只来回一次 | aws-readonly · 结束时 `BillingModeSummary.BillingMode=PAY_PER_REQUEST`（must-hold） |

> **取舍**：模块文档的 `share-ttl` 持续数小时（`--detach`），而 DynamoDB TTL 的物理删除通常在过期后数天内完成（以官方文档为准），卡片时间内看不到“条目消失”。卡片只判定“读取即 410”，并在手册中说明物理删除的异步性；db 驱动对照组（暂停 `share.cleanup` 看残留增长）放到手册的选读。

### 对比实验

引用 [03#social-store 第 5 节](../../modules/03-data-storage.md#social-store)：`like-storm`（必需）、`naive-counter`、`share-ttl`（必需，缩短版）、`like-storm-sbs`、`throttle`（选做）。

| 观察点 | 没有 DynamoDB（关系库表） | 有 DynamoDB |
|---|---|---|
| 并发点赞 | SQLite 单写者，写入在事件循环上排队，长尾明显 | 按需模式写入延迟平稳；同一计数项是热点，并发足够高时可能被限流 |
| 幂等与计数 | 事务 + `ON CONFLICT` | 条件写入 + `TransactWriteItems` + `ADD`；重复点赞被拒绝，最终计数 = 去重后的人数 |
| “先读后写” | 丢更新 | 同样丢更新——原子操作才是答案，与存储无关 |
| 过期数据 | 定时任务分批删除，停掉任务就一直增长 | TTL 后台删除、不消耗写容量，但可能延后；读取时自己比较 `expiresAt` |
| 查询能力 | 任意 SQL、JOIN | 只能按键和索引查询，不能 JOIN |
| 页面 | 评论区“评论存于 EC2 数据库 · 经 Express” | “评论存于 DynamoDB · 经 Express”；路径头 `social-store=dynamodb` |

### 小测

1. **单选**：表使用 TTL 删除过期的分享链接，但用户偶尔还能打开已过期的链接。原因与做法是：
   - A. TTL 删除是异步的，过期条目在被删除前仍可读到；读取时应比较过期时间并拒绝
   - B. TTL 属性必须是 ISO 8601 字符串
   - C. 需要为 TTL 预置额外的写容量
   - D. 只有开启 Streams 时 TTL 才会生效

   **答案**：A。**解析**：TTL 属性是以秒为单位的 Number；删除在后台进行、不消耗 WCU，也不需要 Streams。
2. **单选**：一张热门照片的点赞计数项在活动期间频繁被限流。最合适的改进是：
   - A. 把表改为预置容量并调大 WCU
   - B. 把计数拆成多个分片项（如 `COUNTER#0`～`COUNTER#9`），写入随机分片，读取时求和
   - C. 为计数项建立 GSI
   - D. 改用强一致读

   **答案**：B。**解析**：单个分区键的吞吐有上限，写分片把热点分散到多个分区；加容量解决不了单项热点。
3. **多选（选两项）**：关于 DynamoDB 容量消耗，正确的是：
   - A. `TransactWriteItems` 中每个写操作消耗的写容量约为普通写入的两倍
   - B. 强一致读消耗的读容量是最终一致读的两倍
   - C. LSI 可以在建表之后随时添加
   - D. GSI 必须与基表使用同一个分区键

   **答案**：A、B。**解析**：LSI 只能建表时创建、与基表共享分区键；GSI 可以随时添加，键可以不同。

### 清理说明

- 表 `DeletionPolicy: Retain`，平台回收删除表（PITR 备份随表删除）。
- 做过 `throttle` 时请改回 `PAY_PER_REQUEST` 再结束（检查会提醒）；从预置改回按需在 24 小时滚动窗口内有次数上限（以官方文档为准），不要反复切换。预置容量按时长计费，所以选做时档位升为“中”。
- `share-ttl` 以 `--detach` 运行时随会话结束停止，无需处理。

### 对应 SAA 考点

分区键与排序键、单表设计、GSI 与 LSI；条件写入与幂等、`TransactWriteItems` / `TransactGetItems`；原子计数器、热点分区与写分片；TTL；按需与预置容量（含 Auto Scaling）；最终一致与强一致读；PITR、按需备份、全局表、Streams；DAX；DynamoDB 网关终端节点。

---

<a id="svc-backup"></a>

## svc-backup · AWS Backup：盘外备份与恢复演练

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-backup` |
| kind | `service` |
| 标题 | AWS Backup：盘外备份与恢复演练 |
| 一句话简介 | 对比“与数据同盘的本地备份”和“AWS Backup 盘外恢复点 + 灾备区域副本”，在克隆出的演练实例上模拟数据卷丢失，分别测 RPO 与 RTO。 |
| 涉及的 AWS 服务 | 主：AWS Backup；辅助：Amazon EBS（快照）、Amazon EC2（演练实例与 AMI）；观察：AWS KMS（AWS Backup 默认密钥）；跨区域：`${atl:drRegion}`（平台安装参数，默认 ap-northeast-3 大阪，灾备备份库） |
| 对应的模块 | `backup`（[03#backup](../../modules/03-data-storage.md#backup)） |
| 难度 | 高级 |
| 预计时长 | 120 分钟（含首个恢复点与跨区域复制的等待） |
| 时间上限 | 180 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`：backup 的 `requires` 为空；L0 数据卷由基础栈打上 `Backup=true`；区域资源类型 opt-in（`prerequisites: region-opt-in`）由 `scripts/module` 的 `preflight: backup-region-settings` 自动执行；灾备备份库是本模块自己的第二个栈。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，感知器因此能读取恢复点，置信度为 `confirmed`（附录 C-1 已解决）。档位 `atl/svc-backup/default`；`regions.extra: [dr-region]`。**未并入**：storage / database / social-store——不是依赖，L0 + backup 只纳入数据卷已足够对比“同盘 vs 盘外”，多资源纳入留给 `sc-backup-dr` |
| 目标模块 | `backup`：`BACKUP_MODE=aws`，`DrRegion=${atl:drRegion}`（平台未配置灾备区域时为空：不建灾备栈、计划不带 `CopyActions`，跨区域部分整体跳过，`saa-main` 中原 Lab 24 对应的卡片同样处理），`VaultLock=off`，`ContinuousBackup=false` |
| 费用档位 | 中。主要计费来源：演练实例（t4g.small，1 个按小时计费单位，做完即删）；备份存储（EBS 增量快照）、跨区域复制的传输与灾备区域存储、演练 AMI 的快照按量 |
| 人工前置 | 平台安装时已设置灾备区域（01 §4.3 `DrRegion`；留空时跨区域部分不可用，必需路径照常）。另外注意：preflight 会修改**账号级**的 AWS Backup 区域设置（资源类型 opt-in 与 DynamoDB 高级功能），回收不会改回。**灾备区域的前提**：01 第 2 轮把灾备区域语句改为 `DrRegionLimited`（放行 `cloudalbum-*` 栈与卷恢复，并以护栏拒绝 compliance 模式的 Vault Lock）；以 01 定稿为准，若仍是旧的 `DrRegionBackupOnly`，`enable backup` 部署灾备备份库栈会失败，本卡只能以 `DrRegion` 为空的形态运行（附录 C-6） |
| SAA 考试领域 | 弹性、安全、成本 |
| 推荐的前置卡片 | `svc-ec2`；之后：`sc-backup-dr` |
| 预期警告 | 无（`expectedWarnings: []`） |
| 徽章 | “恢复演练” |

### 实验简介

**背景**：L0 每天由 `cloudalbum-backup.timer` 把 SQLite 在线备份到**同一块数据卷**上。卷损坏、误删卷、实例被入侵或勒索加密时，数据和备份一起丢；数据卷上还有机密与本地配置（`etc/`），卷丢了密钥也丢了。

**你将学到**
- AWS Backup 的计划、规则、备份库、按标签选择资源；跨区域复制。
- RPO / RTO 的含义与测量；“从未演练过的备份等于没有备份”。
- 复制不是备份；Vault Lock 的 governance 与 compliance 模式（后者在宽限期后无法解除）。
- EBS 快照是增量、崩溃一致的；恢复点里包含机密，恢复权限要与数据访问权限一样严格。

**实验资源**
- 起始状态：实验机（L0，数据卷带 `Backup=true`）、iam 基础策略（C3）。
- 本卡创建：栈 `cloudalbum-<envName>-backup-dr`（灾备区域的备份库，部署在 `${atl:drRegion}`）、`cloudalbum-<envName>-backup`（备份库、计划、按标签的资源选择、服务角色、感知器策略）；一个按需恢复点。
- 学员手工创建：演练 AMI 与演练实例 `drill-i`（`experiments/backup/drill.sh clone`，同子网、无 EIP、全程不启动 api / worker）、从恢复点恢复出的卷。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `orient` 本地备份在哪 | 观察 | 实验机 `sudo systemctl start cloudalbum-backup.service`；`/lab` 备份卡片左栏标红“与数据在同一块盘上” | capability · `backup.driver=local`（once）；local（`file-stat`，`/var/lib/cloudalbum/backup/last-run.json`）· 存在 |
| 2 | `baseline` 基线演练 | 脚本 + 对比实验 | `drill.sh clone`（`create-image --no-reboot` → 起 `drill-i`）→ `drill.sh disaster --scenario volume-loss` → `drill.sh restore --from manual-snapshot`（从未做过手动快照 → 数据全部丢失）→ `npm run exp -- backup --label before --scenario drill --upload` | aws-readonly · `ec2:DescribeInstances`：`drill-i` 无公网 IPv4、**不带** `atl:role=lab-app`（否则实验机发现会命中多台，04 §5.2.1；`ownership: session`，由学员会话的 `RunInstances` 事件经台账或定向扫描认领）；experiment · `drill` before 有效 |
| 3 | `enable` 接入 AWS Backup（wire） | 脚本 | `scripts/module enable backup --param DrRegion=${atl:drRegion}`：preflight opt-in → 部署灾备区域备份库（依赖 01 第 2 轮的 `DrRegionLimited`，附录 C-6）→ 主栈（计划 `daily`、东京时区、复制到灾备区域）→ 立即对数据卷执行一次按需备份 | capability · `backup.driver=aws`、healthy、`confidence ∈ {confirmed, observed}`（起始状态带 iam，感知器能读恢复点）；local（`module-state`，`backup`）· 已由 `scripts/module` 启用；aws-readonly · `backup:GetBackupPlan`：规则带 `ScheduleExpressionTimezone=Asia/Tokyo`；`when: platform.drRegion != ''` 时另断言 `CopyActions` 指向灾备区域备份库（`ownership: session`）；aws-readonly · `backup:ListRecoveryPointsByResource`（数据卷 ARN）：存在 `COMPLETED` 且创建于会话开始之后的恢复点（等待 typical 10 / max 40 分钟）——它是本卡的“实际生效证据”（纯基础设施型模块按 04 §3.5 第 3 条用 `module-state` + 带 `ownership` 的控制面证据） |
| 4 | `inspect` 看懂计划与副本 | 控制台 | Backup 控制台：备份库、计划、按标签 `Backup=true` 的资源分配、恢复点、复制作业；切到灾备区域查看副本 | aws-readonly · `backup:GetBackupSelection`：`ListOfTags` 为 `Backup=true`；aws-readonly（`region: dr-region`，`when: platform.drRegion != ''`）· `backup:ListRecoveryPointsByBackupVault`（`cloudalbum-{{ session.env }}-backup-dr`）：出现 `COMPLETED` 的副本（等待 typical 15 / max 45 分钟；04 已支持 `dr-region`，附录 C-5 已解决） |
| 5 | `after` 盘外恢复演练 | 脚本 + 对比实验 | 在 `drill-i` 上再次 `disaster --scenario volume-loss` → `drill.sh restore --from aws-backup`（恢复点 → 新卷挂到 `drill-i`）→ `node dist/cli.js verify --all` → `--label after` 上传结果 | experiment · `drill` pair（after 的完整性校验通过，记录 RPO、RTO） |
| 6 | `vault-lock`（选做） | CLI | `scripts/module enable backup --param VaultLock=governance` → 尝试删除恢复点（观察被拒，以实测为准）→ **结束前用 `scripts/module enable backup --param VaultLock=off` 移除锁**（锁配置由栈管理，直接用 CLI 删除会造成栈漂移；CLI `delete-backup-vault-lock-configuration` 只作兜底） | aws-readonly · `backup:DescribeBackupVault`：结束时 `Locked=false`（must-hold）。governance 锁虽可解除，但留着它会让回收器删除恢复点失败，所以结束时不允许任何锁；`LockDate` 存在（compliance）属于严重违规，见清理说明 |
| 7 | `cleanup-drill` 清理演练资源 | 脚本 | `drill.sh cleanup`：删除 `drill-i`、演练 AMI 及其快照（含机密）、恢复出的卷 | aws-readonly · `ec2:DescribeInstances`：`drill-i` 已终止；`ec2:DescribeVolumes`：带本会话标签的恢复卷数为 0 |

> **取舍**：模块文档的第 4 步“在灾备区域用复制过去的恢复点恢复一次 EBS 卷”在本卡**不做**，卡片只验证“副本存在”：一是时间预算（副本复制本身就要等待），二是第 1 轮发现 01 的 `DrRegionBackupOnly` 在灾备区域拒绝 `cloudformation:*` 与 `ec2:CreateVolume` / `DeleteVolume`。01 第 2 轮已改为 `DrRegionLimited`（放行 `cloudalbum-*` 栈、卷恢复与删除），定稿后灾备区域的恢复演练可放进 `sc-backup-dr`；在 01 定稿前，本卡的第 3、4 步只能在 `DrRegion` 为空的形态下完成（附录 C-6）。

### 对比实验

引用 [03#backup 第 5 节](../../modules/03-data-storage.md#backup)：`experiments/backup/drill.sh`（只在克隆环境中执行，从不碰正在运行的实验机）。

| 观察点 | 没有 AWS Backup（本地 timer） | 有 AWS Backup |
|---|---|---|
| 备份位置 | 与数据同一块 EBS 卷 | 独立备份库 + 灾备区域副本 |
| 卷丢失演练的结果 | 本地备份随卷一起消失；没有手动快照时数据全部丢失 | 从恢复点恢复新卷，`verify --all` 通过（CFG-007 密钥指纹也通过，因为 `etc/` 在恢复点里） |
| RPO | 最多 1 天，卷丢失时等于全部丢失 | 不超过计划间隔（本卡用按需备份，接近 0） |
| RTO | 人工、小时级 | 分钟级（恢复卷 + 挂载 + 校验） |
| 能应对的故障 | 只有“应用写坏了数据、卷还在” | 卷丢失、误删、区域故障（副本）、勒索（配合 Vault Lock） |
| `/lab` 备份卡片 | 左栏标红“与数据在同一块盘上” | 右栏列出恢复点与灾备区域副本状态 |

### 小测

1. **单选**：公司希望对 EBS、RDS、DynamoDB、EFS 统一设置每日备份，按标签自动纳入新资源，并把副本复制到另一个区域。最合适的是：
   - A. Amazon Data Lifecycle Manager
   - B. AWS Backup 备份计划 + 基于标签的资源分配 + 复制操作
   - C. 每个服务各自的快照功能加一个 Lambda 定时脚本
   - D. S3 跨区域复制

   **答案**：B。**解析**：AWS Backup 集中管理多种服务的备份与跨区域 / 跨账号复制；DLM 只管 EBS 快照与 AMI。
2. **单选**：合规要求备份在保留期内任何人（包括管理员）都不能删除，以防勒索软件。应使用：
   - A. 备份库的访问策略拒绝删除
   - B. AWS Backup Vault Lock 的 compliance 模式
   - C. Vault Lock 的 governance 模式
   - D. 给备份库启用 KMS 客户托管密钥

   **答案**：B。**解析**：compliance 模式在宽限期结束后不可更改、不可删除（WORM）；governance 模式允许有特定权限的身份解除；访问策略可以被管理员修改。
3. **单选**：要求最多丢失 1 小时数据、4 小时内恢复，且成本尽可能低。最合适的灾备策略是：
   - A. 多站点主动 / 主动
   - B. Warm Standby
   - C. 备份与恢复：每小时备份（或对支持的资源开启连续备份），并复制到灾备区域
   - D. Pilot Light 并保持数据库实时复制

   **答案**：C。**解析**：备份与恢复成本最低，RPO 由备份频率决定，RTO 在小时级可以接受；其余策略都更贵。

### 清理说明

- 必须执行第 7 步 `drill.sh cleanup`：演练 AMI 与快照包含 `etc/secrets.env` 与 `keys/`，演练实例按小时计费。
- 平台回收按“恢复点 → 备份库 → 计划”的顺序删除两个区域的资源（02 §7.4、§7.5）。**绝不要**启用 compliance 模式的 Vault Lock：宽限期（最短 3 天）过后无法解除，恢复点会一直保留到期、持续计费，会话进入 `CLEANUP_FAILED`。
- 做过第 6 步时，结束前执行 `scripts/module enable backup --param VaultLock=off`；失败时兜底 `aws backup delete-backup-vault-lock-configuration --backup-vault-name cloudalbum-{{ session.env }}-backup`（之后再执行一次 `enable` 消除漂移）。
- 区域 opt-in 设置是账号级的，回收不会改回（通常无害，以官方文档为准）。

### 对应 SAA 考点

AWS Backup 的计划、规则、备份库、按标签分配；跨区域与跨账号复制；Vault Lock 的 governance / compliance；Restore Testing；EBS 快照（增量、区域级、可跨区域复制、崩溃一致）、Fast Snapshot Restore、Data Lifecycle Manager；RDS 自动备份 / 手动快照 / AWS Backup 的区别、DynamoDB PITR；复制 ≠ 备份；RPO、RTO 与四种灾备策略。

---

<a id="svc-analytics"></a>

## svc-analytics · Amazon Data Firehose：点击流采集与投递

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-analytics` |
| kind | `service` |
| 标题 | Amazon Data Firehose：点击流采集与投递 |
| 一句话简介 | 点击事件不再写进业务库，改由 EC2 批量转发给 Data Firehose 落到 S3 数据湖，再用 Athena 按分区查询，看清分析负载如何离开 OLTP 库。 |
| 涉及的 AWS 服务 | 主：Amazon Data Firehose；辅助：Amazon S3（本模块自建的事件桶）、Amazon Athena（报表查询）、AWS Glue Data Catalog（表结构与分区投影）、AWS IAM（实例角色）；观察：Amazon CloudWatch（`DeliveryToS3.Records`、`DeliveryToS3.DataFreshness`） |
| 对应的模块 | `analytics`（[03#analytics](../../modules/03-data-storage.md#analytics)） |
| 难度 | 中级（Firehose、S3、Glue、Athena 四个服务配合，且要等待缓冲投递；05 §2.7.1，与 `saa-main` 中原 Lab 18 一致） |
| 预计时长 | 75 分钟 |
| 时间上限 | 120 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，analytics 本身也是 `credentials: required`（CRED-001）。档位 `atl/svc-analytics/default`。analytics 的 `requires` 为空——**事件桶由本栈自建，不依赖 storage**。**未并入**：kms（软依赖）、network |
| 目标模块 | `analytics`：`ANALYTICS_DRIVER=firehose`，`OutputFormat=json`（GZIP），缓冲 60 秒 / 5 MB，Athena 工作组带扫描上限 |
| 费用档位 | 低。主要计费来源：Firehose 摄入量（每条记录按计费单位向上取整）、Athena 扫描量（工作组扫描上限兜底）、事件桶存储与请求；不按小时计费 |
| 人工前置 | 无 |
| SAA 考试领域 | 高性能、成本、弹性 |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`；之后：`sc-analytics`（Glue 爬网程序与 Parquet） |
| 预期警告 | 无（`expectedWarnings: []`） |
| 徽章 | “数据湖投递” |

### 实验简介

**背景**：L0 的点击事件批量写进业务库的 `click_events` 表，报表用 SQL 现查。事件越多，事件写入与业务写入争抢 SQLite 写锁，数据库文件和本地备份越来越大，报表越来越慢。

**你将学到**
- Firehose 的缓冲投递（按大小或间隔）、动态前缀、错误输出前缀；至少一次投递与按 `eventId` 去重。
- S3 数据湖 + Athena：按扫描量计费，分区条件、列式格式、压缩能把扫描量降几个数量级；工作组扫描上限。
- Glue Data Catalog 与分区投影（不需要爬网程序和 `MSCK REPAIR`）；分区时间是“到达时间”而不是事件时间。
- Firehose、Kinesis Data Streams、SQS 怎么选；OLTP 与 OLAP 分离。

**实验资源**
- 起始状态：实验机（L0）、iam 基础策略。
- 本卡创建：栈 `cloudalbum-<envName>-analytics`——事件桶（`events/`、`errors/`、`athena-results/` 各有生命周期）、DirectPut 投递流、Glue 数据库与表（分区投影）、Athena 工作组、客户托管策略。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `baseline` 写入负载与报表基线 | 对比实验 | `npm run exp -- analytics --label before --scenario clickstream-load --duration 5m --upload`（`--rate 200/s` + 背景读 `/api/feed`）；`node dist/cli.js lab:seed-events --target db --count 100000` 后跑 `report-scale --label before` | capability · `analytics.driver=db`（once）；experiment · `clickstream-load` before 有效 |
| 2 | `enable` 接入 Firehose（wire） | 脚本 | `scripts/module enable analytics`；在预览中浏览几页（前端每 5 秒批量上报） | capability · `analytics.driver=firehose`、healthy；local（`path-seen`，15 分钟）· `POST /api/events` 出现 `analytics=firehose`；aws-readonly · `firehose:DescribeDeliveryStream`：`ACTIVE`，前缀含 `events/dt=`，错误前缀含 `!{firehose:error-output-type}`，GZIP（`ownership: session`） |
| 3 | `freshness` 数据新鲜度 | 对比实验 | `--scenario freshness`：发一条带标记的事件，每 5 秒轮询报表，记录它多久出现 | experiment · `freshness` after 有效；aws-readonly · `cloudwatch:GetMetricData`：`AWS/Firehose DeliveryToS3.Records` 最近 15 分钟之和 > 0（等待 typical 3 / max 10 分钟） |
| 4 | `after` 写入负载（after） | 对比实验 | 同第 1 步 `--label after`（关掉影子写） | experiment · `clickstream-load` pair；local（`app-stat`，`click_events.count`）· 启用后不再增长（warn） |
| 5 | `athena` 分区与扫描量 | 控制台 | Athena 控制台选择工作组 `cloudalbum-{{ session.env }}-analytics`，对 `experiments/analytics/partition-scan.sql` 的同一条查询分别加 / 不加 `dt` 条件运行，记录 Data scanned | aws-readonly · `athena:GetWorkGroup`（`cloudalbum-{{ session.env }}-analytics`，`ownership: session`）：`EnforceWorkGroupConfiguration=true`、设置了 `BytesScannedCutoffPerQuery`；manual · 填写两次扫描量（期望：带 `dt` 条件的更小） |
| 6 | `glue` 看懂表结构 | 观察 | Glue 控制台查看表 `click_events` 的分区列与 `projection.*` 属性；手册解释“为什么不需要爬网程序” | aws-readonly · `glue:GetTable`（表 `click_events`）：`Parameters` 中 `projection.enabled=true`、存在 `storage.location.template`；manual · “`storage.location.template` 指向哪里” |
| 7 | `report-scale`（选做） | 对比实验 | `lab:seed-events --target s3 --count 1000000` 后跑 `report-scale --label after`；可加 `dedupe` | experiment · `report-scale` pair（非必需） |

> **取舍**：`clickstream-load` 从 10 分钟缩为 5 分钟，`report-scale` 的 db 档只做到 10^5（10^6 行在 t4g.small 的 SQLite 上写入耗时较长，放到选做的 s3 档）。Athena 工作组与 Glue 表的配置用 `aws-readonly` 判定（04 §5.7 第 2 轮已收录 `athena:GetWorkGroup`、`glue:GetTable`）；两次查询的扫描量仍由学员填写（`GetQueryExecution` 需要查询执行 ID）。

### 对比实验

引用 [03#analytics 第 5 节](../../modules/03-data-storage.md#analytics)：`clickstream-load`、`freshness`（必需），`report-scale`、`partition-scan`（手工）、`dedupe`（选做）。

| 观察点 | 没有 Firehose（db） | 有 Firehose（+ S3 + Athena） |
|---|---|---|
| 写入路径 | 浏览器 → EC2 → 业务库 `click_events` | 浏览器 → EC2 → Firehose → S3（压缩文件） |
| 注入点击流期间 `/api/feed` p95 | 上升（争抢写锁） | 基本不受影响 |
| 业务库文件大小 | 持续增长 | 不再增长 |
| 数据新鲜度 | 写入后立即可查 | 约一个缓冲间隔后才能查到 |
| 报表耗时 | 小数据量毫秒级，随数据量增长变慢 | 每次查询有秒级固定开销，随数据量增长很慢 |
| 报表费用 | 占用数据库资源 | 按扫描量计费；分区条件与列式格式显著降低 |
| 报表页 | “数据源：本地 SQL · 扫描 N 行 · 实时” | “数据源：Athena · 扫描 X MB · 延迟约一个缓冲间隔” |

### 小测

1. **单选**：网站要把点击流近实时地写入 S3 供后续分析，可以接受分钟级延迟，不想管理分片或容量。应选择：
   - A. Amazon Kinesis Data Streams + 自建消费者
   - B. Amazon Data Firehose，目标为 S3
   - C. Amazon SQS 标准队列 + EC2 消费者写 S3
   - D. 应用直接对每条事件调用 `PutObject`

   **答案**：B。**解析**：Firehose 全托管、按缓冲批量投递；KDS 需要管理容量与消费者；逐条 `PutObject` 会产生海量小文件与请求费。
2. **多选（选三项）**：降低 Athena 查询费用的有效做法是：
   - A. 按日期分区，并在查询中带分区条件
   - B. 把数据转为 Parquet 等列式格式
   - C. 压缩数据文件
   - D. 调大工作组的每查询扫描上限

   **答案**：A、B、C。**解析**：Athena 按扫描字节计费；分区裁剪、列式存储只读需要的列、压缩都减少扫描量；扫描上限是防误扫的护栏，调大不会省钱。
3. **单选**：多个独立应用需要实时消费同一事件流，并能在 7 天内重放历史数据。应选择：
   - A. Amazon Data Firehose
   - B. Amazon Kinesis Data Streams
   - C. Amazon SNS 标准主题
   - D. Amazon SQS 标准队列

   **答案**：B。**解析**：KDS 支持多消费者与按保留期重放；Firehose 只负责投递；SQS 消息消费后删除；SNS 不保存消息。

### 清理说明

- 事件桶 `DeletionPolicy: Retain`，平台回收会清空（含 `athena-results/`）后删桶；Glue 数据库与表、Athena 工作组随栈删除。
- 手工在 Athena 中执行查询时只用本卡的工作组（扫描上限与结果位置由工作组强制）。

### 对应 SAA 考点

Data Firehose（缓冲、格式转换、Lambda 转换、动态分区、目标类型）；Firehose / Kinesis Data Streams / SQS 的取舍；S3 数据湖 + Athena（分区、列式、压缩、工作组）；Glue Data Catalog、分区投影、爬网程序；Lake Formation（了解）；OLTP 与 OLAP 分离、Redshift 的定位；至少一次投递与幂等去重。

---

<a id="svc-image-processing"></a>

## svc-image-processing · AWS Lambda：缩略图生成

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-image-processing` |
| kind | `service` |
| 标题 | AWS Lambda：缩略图生成 |
| 一句话简介 | 缩略图从 EC2 上的 sharp 改由 S3 → EventBridge → Lambda 生成，批量上传时“上传完成”接口与 EC2 CPU 曲线的变化一目了然。 |
| 涉及的 AWS 服务 | 主：AWS Lambda；辅助：Amazon EventBridge（规则）、Amazon SQS（本模块自带的失败队列与结果队列）、Amazon S3（起始状态预置）、Amazon CloudWatch Logs（函数日志）、AWS IAM |
| 对应的模块 | `image-processing`（[04#image-processing](../../modules/04-compute-async.md#image-processing)）；扩展 workflow（Step Functions）不在本卡 |
| 难度 | 中级 |
| 预计时长 | 90 分钟 |
| 时间上限 | 150 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，lambda 档本身也是 `credentials: required`。档位 `atl/svc-image-processing/default`。③ `storage`（`STORAGE_DRIVER=s3`）：DEP-003——Lambda 读不到 EC2 的 EBS；storage 自身只需 iam，闭包到此为止。工具链栈（`prerequisites: toolchain`，存放部署包）由平台 `base-deploy` 创建。**未并入**：queue——lambda 档不经过 queue 模块（失败 / 结果队列是本模块自带的 `auxQueues`）；workflow——与 lambda 档互斥（MUTEX-005） |
| 目标模块 | `image-processing`：`IMAGE_PROCESSOR=lambda`，`Trigger=eventbridge`，**`ResultChannel=queue`**，`MemorySize=1024`，`ReservedConcurrency` 留空 |
| 费用档位 | 低（选做 → 中）。主要计费来源：Lambda 请求与 GB-秒（含 INIT 阶段）、S3 GET / PUT、SQS 请求、CloudWatch Logs 摄取与存储；选做的预置并发按时长计费，测完立即删除 |
| 人工前置 | 无 |
| SAA 考试领域 | 高性能、弹性、成本 |
| 推荐的前置卡片 | `svc-storage`（软）；之后：`svc-workflow`、`sc-image-pipeline` |
| 预期警告 | 无（`expectedWarnings: []`；选 `ResultChannel=queue` 正是为了不触发 DEP-021） |
| 徽章 | “事件驱动” |

**回写通道选 `queue` 而不是默认的 `callback`**：没有 load-balancer 注入时，`scripts/module` 用基础上下文的 `http://<EIP>` 拼回调地址（04#image-processing 第 2 节；平台方案 B 的 IP 证书只用于预览，不改变这个默认值），DEP-021（warn）会把模块置为 `degraded`，并且依赖实验机对公网开放入站端口；queue 通道不需要任何入站流量，EC2 停机时结果留在队列里，也与预设 `l4-async`、`x-named-comparisons` 一致。callback 的 HMAC 设计在手册中作为选读。

### 实验简介

**背景**：L0 的缩略图在“上传完成”请求内由 sharp 同步生成（inline，并发 2）。批量上传 200 张时，请求在信号量上排队，2 个 vCPU 被占满，浏览时间线也跟着卡，队尾请求可能被 Nginx 截成 504。

**你将学到**
- Lambda 的三种调用模型；本卡是 EventBridge → Lambda 的异步调用：重试（0～2 次）、最大事件年龄、失败目标。
- 事件驱动的“编舞”：S3 事件统一经 EventBridge，消费者在自己的栈里建规则；避免递归（输入原图桶 `raw/`，输出展示桶 `variants/`）。
- 并发：预留并发（既是保底也是上限）与预置并发（消除冷启动、按时长计费）；新账号的并发配额可能很低。
- 冷启动与 `Init Duration`；内存与 CPU 成比例；arm64 的性价比。
- Lambda 读不到 EBS 与 SQLite：一旦用 Lambda，状态必须外置。

**实验资源**
- 起始状态：实验机（L0）、iam 基础策略、storage（原图桶与展示桶，桶上只开 EventBridge 投递）。
- 本卡创建：栈 `cloudalbum-<envName>-image-processing`——缩略图函数（`nodejs22.x`、arm64）、显式日志组（保留 14 天）、异步调用配置、EventBridge 规则、失败队列、结果队列、执行角色、客户托管策略。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `baseline` inline 基线 | 对比实验 | `npm run exp -- image-processing --label before --scenario upload-burst --vus 20 --duration 60s --upload`；同时另开工作台终端跑 `neighbor.k6.js`（每秒 5 次读 `/api/feed`） | capability · `image-processing.driver=inline`（once）、`storage.driver=s3`；experiment · `upload-burst` before 有效 |
| 2 | `enable` 接入 Lambda（wire） | 脚本 | `scripts/module enable image-processing --param ResultChannel=queue`（打包上传到工具链桶 → 部署 → 先重启 worker 再重启 api → 端到端探针）；在预览上传 3 张 | capability · `image-processing.driver=lambda`、healthy；local（`path-seen`，15 分钟）· 出现 `image-processing=lambda:async`；aws-readonly · `lambda:GetFunctionConfiguration`：`nodejs22.x`、`arm64`、`State=Active`；`lambda:GetFunctionEventInvokeConfig`：`MaximumRetryAttempts=2`、`OnFailure` 指向本模块失败队列；`events:DescribeRule`：`ENABLED`（均 `ownership: session`） |
| 3 | `inspect` 看懂触发与权限 | 控制台 | Lambda 控制台：触发器、目标、执行角色（只读 `raw/*`、只写 `variants/*`）；EventBridge 规则的事件模式；CloudWatch Logs 中的 `REPORT` 行与 `Init Duration` | aws-readonly · `events:ListTargetsByRule`：目标为本函数且配置了 DLQ；manual · “为什么输出写到另一个桶” |
| 4 | `after` Lambda 生成（after） | 对比实验 | 同第 1 步 `--label after`（并跑 `neighbor.k6.js`）；可加 `--ab`（交替带 `X-Compare-Bypass: image`） | experiment · `upload-burst` pair |
| 5 | `failures` 失败路径 | 对比实验 | `npm run exp -- image-processing --label after --scenario failures --upload`（运行器调用 `failures.ts`）：损坏的 JPEG（永久错误，立即 FAILED、不重试）；`FAULT_RATE=0.5` 下上传 10 张（暂时错误 → 异步重试 2 次，间隔约 1、2 分钟 → 失败队列 → 对账处理），脚本结束时还原环境变量 | experiment · `failures` after 有效；aws-readonly · `lambda:GetFunctionConfiguration`：环境变量中没有 `FAULT_RATE`（must-hold） |
| 6 | `throttle` 紧急刹车 | 对比实验 | `npm run exp -- image-processing --label after --scenario throttle --param reserved=0 --param hold=120s --upload`（运行器调用 `throttle.ts`）：预留并发设为 0（等于暂停函数），上传 10 张，120 秒后删除预留并发。**观察点按 AWS 文档修正**：预留并发为 0 时，异步事件不会排队等到恢复，而是被丢弃并送往失败目标（Lambda 文档把“reserved concurrency set to 0”列为 `AsyncEventsDropped` 的原因之一）；所以看到的是 `Throttles`、`AsyncEventsDropped` 上升、失败队列出现 10 条记录、照片被 worker 标为 FAILED（以实测为准）——这正说明“预留并发 = 0”是紧急刹车，不是限流。要演示“被限流后排队、陆续消化”，用模块文档的 buffer-queue 变体（`--param Trigger=buffer-queue --param MaxConcurrency=2`，`sc-image-pipeline` 中做） | experiment · `throttle` after 有效；aws-readonly · `lambda:GetFunctionConcurrency`：没有预留并发（must-hold，防止函数一直被暂停） |
| 7 | `cold-start`（选做） | 对比实验 | `npm run exp -- image-processing --label after --scenario cold-start --param idle=15m --param samples=3 --upload`，用 Logs Insights 统计 `@initDuration`；闲置 15 分钟会占用较多倒计时，剩余时间不足 30 分钟时跳过；可选临时配置预置并发后再测，测完立即删除 | experiment · `cold-start` after（非必需） |

### 对比实验

引用 [04#image-processing 第 5 节](../../modules/04-compute-async.md#image-processing)：`upload-burst` + `neighbor`（必需），`failures`、`throttle`（必需），`cold-start`、`cost`（选做；`worker-memory`、`worker-sqs` 两档留给 `svc-queue` 与 `sc-decoupling`）。

| 观察点 | 没有 Lambda（inline） | 有 Lambda |
|---|---|---|
| “上传完成”接口 p95 | 包含 sharp 处理时间，并发 20 时到数秒级，可能 504 | 只含一次数据库更新，几十毫秒量级 |
| EC2 CPU（`lab_host_samples`） | 被打满 | 几乎是一条平线 |
| 同时段 `/api/feed` p95 | 明显上升 | 基本不受影响 |
| 缩略图就绪时间 | 等于接口响应时间 | 大多秒级、基本不随张数增长，首批有冷启动 |
| 失败处理 | 对账任务重试或标 FAILED | 异步重试 → 失败队列；永久错误直接回写 FAILED |
| 照片详情徽章 | “缩略图由 EC2 生成 · inline” | “缩略图由 AWS Lambda 生成 · 冷启动” |

### 小测

1. **单选**：一个由 EventBridge 异步调用的 Lambda 函数偶尔失败，团队希望在重试用尽后保留失败事件以便分析，且不写额外代码。应该：
   - A. 把函数超时改为 15 分钟
   - B. 在函数的异步调用配置中设置失败目标（如 SQS 队列），并设置重试次数
   - C. 改为同步调用
   - D. 为函数配置预置并发

   **答案**：B。**解析**：异步调用支持 0～2 次重试与失败目标（Destinations）或 DLQ；同步调用的错误由调用方处理；预置并发只解决冷启动。
2. **单选**：一个由 S3 上传触发的 Lambda 把缩略图写回同一个桶的同一前缀，很快产生大量调用与费用。根本的修复是：
   - A. 调大函数内存
   - B. 把输出写到另一个桶，或写到不在触发范围内的前缀
   - C. 关闭 S3 版本控制
   - D. 给函数配置预置并发

   **答案**：B。**解析**：输出再次触发函数形成递归；输入与输出分开是根本解法，预留并发上限只能兜底。
3. **单选**：一个面向用户的 Lambda API 在流量高峰时首个请求延迟明显升高（冷启动）。要消除这部分延迟，应使用：
   - A. 预留并发
   - B. 预置并发
   - C. 把函数放进 VPC
   - D. 增加函数超时时间

   **答案**：B。**解析**：预置并发预先初始化执行环境，按时长计费；预留并发只是保底与上限，不消除冷启动。

### 清理说明

- 函数、规则、队列、日志组随栈删除或由平台回收；原图与衍生图在 storage 的桶里，回收会清空后删桶。
- 确认第 6 步结束后预留并发已删除、第 5 步的 `FAULT_RATE` 已还原（检查会提醒）；做过冷启动对照时，删除预置并发。

### 对应 SAA 考点

Lambda 的同步、异步与事件源映射调用；异步调用的重试、最大事件年龄、Destinations 与 DLQ；S3 事件通知 vs EventBridge vs SNS 扇出；内存与 CPU、Power Tuning、arm64；预留并发与预置并发、账号并发配额；15 分钟超时、`/tmp`、部署包与 Layer / 容器镜像；VPC 内 Lambda 访问 S3 需要终端节点或 NAT、RDS Proxy；编排与编舞；避免递归；执行角色与资源策略的区别。

---

<a id="svc-queue"></a>

## svc-queue · Amazon SQS：异步任务队列与死信队列

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-queue` |
| kind | `service` |
| 标题 | Amazon SQS：异步任务队列与死信队列 |
| 一句话简介 | 把后台任务从 api 进程的内存队列换成 SQS + DLQ，在批量上传中途 `kill -9` worker 看任务一个不丢，再把“坏消息”送进死信队列并重放。 |
| 涉及的 AWS 服务 | 主：Amazon SQS（标准队列 + DLQ）；辅助：AWS IAM；观察：Amazon CloudWatch（`ApproximateAgeOfOldestMessage`、`NumberOfEmptyReceives`） |
| 对应的模块 | `queue`（[04#queue](../../modules/04-compute-async.md#queue)） |
| 难度 | 初级 |
| 预计时长 | 60 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`。② `iam`（`IAM_CREDENTIALS=role`）：`credentials: required`（CRED-001）。③ **本地档** `IMAGE_PROCESSOR=worker`：gen-single 规则 3——`experiments/queue/experiment.json` 的 `upload-burst` 要求 worker 档，否则缩略图仍在请求内生成，批量上传几乎看不出队列的作用（与 `single/queue.env` 相同）。④ **本地档** `QUEUE_DRIVER=memory`：DEP-004 不允许 worker + sync；且 `before` 标签要求 memory + worker。③④ 写成 `kind: local` 的 provisions，不部署 AWS 资源、不写 `MODULE_*=on`；目标模块因此写 `fromDriver: memory`（04 §3.2.4）。档位 `atl/svc-queue/default`。queue 的 `requires` 为空 |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | `queue`：`fromDriver: memory` → `QUEUE_DRIVER=sqs`，`VisibilityTimeout=120`，`MaxReceiveCount=3`，长轮询 20 秒 |
| 费用档位 | 低。主要计费来源：SQS 请求（每次 API 调用最多 10 条消息、每 64 KB 算一次；空队列的长轮询也计请求） |
| 人工前置 | 无 |
| SAA 考试领域 | 弹性、高性能、成本 |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`；之后：`svc-image-processing`、`sc-decoupling` |
| 徽章 | “削峰填谷” |

### 实验简介

**背景**：起始状态已经是“本地档异步”：任务放进 api 进程内的 `p-queue`，接口立即返回，但处理仍和 API 抢 CPU；进程一重启，排队和在途的任务全部丢失——缩略图靠对账任务分钟级找回，“上传成功”的通知邮件就真的丢了。

**你将学到**
- 标准队列的至少一次投递与幂等（`processed_jobs` 去重）；FIFO 的取舍。
- 可见性超时、心跳（`ChangeMessageVisibility`）、长轮询；DLQ、`maxReceiveCount`、`RedriveAllowPolicy`、DLQ 重放（`StartMessageMoveTask`）。
- 削峰填谷：CPU 曲线从尖峰变成平台；“每实例积压”指标驱动 ASG 扩缩容。
- 边界：queue 模块只管应用任务队列；其他模块自带的 SQS 队列（`auxQueues`）不属于它。

**实验资源**
- 起始状态：实验机（L0 + worker 档 + memory 队列）、iam 基础策略。
- 本卡创建：栈 `cloudalbum-<envName>-queue`——`queue-jobs`（SSE-SQS、长轮询、redrive）、`queue-jobs-dlq`（保留 14 天、只允许本队列 redrive）、客户托管策略。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `orient` 观察本地异步 | 观察 | 预览上传几张：先灰色占位、再出缩略图；`/admin/jobs` 顶部“任务在 api 进程内存中排队（重启即丢）” | capability · `queue.driver=memory`（once）、`image-processing.driver=worker` |
| 2 | `baseline` memory + 重启 | 对比实验 | `npm run exp -- queue --label before --scenario upload-burst --upload`（第 30 秒执行 `faults/restart-api.sh`） | experiment · `upload-burst` before 有效（`biz.jobs_lost > 0`） |
| 3 | `enable` 接入 SQS（wire） | 脚本 | `scripts/module enable queue`（先排空内存队列 → 部署 → **先重启 worker 再重启 api** → 探针任务） | capability · `queue.driver=sqs`、healthy；local（`path-seen`，15 分钟）· 出现 `queue=sqs:queued`；aws-readonly · `sqs:GetQueueAttributes`（主队列）：`RedrivePolicy.maxReceiveCount=3` 指向本会话 DLQ、`ReceiveMessageWaitTimeSeconds=20`、`SqsManagedSseEnabled=true`；DLQ 的 `MessageRetentionPeriod` 大于主队列（`ownership: session`） |
| 4 | `after` sqs + kill -9 | 对比实验 | 同第 2 步 `--label after`（第 30 秒执行 `faults/kill-worker.sh`，systemd 随后拉起 worker） | experiment · `upload-burst` pair（after 的 `biz.jobs_lost = 0`，重复执行被去重表吸收） |
| 5 | `poison` 坏消息进 DLQ | 脚本 | `npx tsx experiments/queue/poison.ts --count 1`：用学员凭证直接发一条格式错误的消息，每 10 秒查一次源队列与 DLQ | aws-readonly · `sqs:GetQueueAttributes`（DLQ）：`ApproximateNumberOfMessages ≥ 1`（等待 typical 8 / max 20 分钟） |
| 6 | `dlq-replay` 重放或导出 | 脚本 | `npx tsx experiments/queue/dlq-replay.ts`：把消息移回源队列（handler 没修，它会再次进入 DLQ）；或在 `/admin/jobs` 点“导出到 failed_jobs” | aws-readonly · `sqs:ListMessageMoveTasks`（`SourceArn` 为本会话 DLQ，04 §5.7 第 2 轮已收录）：选择重放时出现本会话发起的移动任务（once）；manual · 观察到的结果（再次进入 DLQ / 已导出） |
| 7 | `ab`（选做） | 对比实验 | `--scenario upload-burst --ab`：交替带 `X-Compare-Bypass: queue`，同一时段一半当场执行、一半进 SQS | experiment · `upload-burst` after（`--ab`，非必需） |

### 对比实验

引用 [04#queue 第 5 节](../../modules/04-compute-async.md#queue)：`upload-burst`（before = memory + worker，after = sqs + worker；可选变体 `l0`（sync + inline 的 L0 参照，基线角色）现在可以声明并上传，C5）、`poison`、`dlq-replay`。

| 观察点 | 没有 SQS（本地档 memory） | 有 SQS |
|---|---|---|
| “上传完成”接口延迟 | 只含入队，几十毫秒量级 | 多一次 SendMessage 往返，仍是几十毫秒量级 |
| 谁来执行 | api 进程后台（和 API 抢 CPU） | 独立的 worker 进程（`CPUWeight`、`Nice` 让 API 优先） |
| 第 30 秒的故障 | 重启 api：排队与在途任务全部丢失，`biz.jobs_lost > 0` | `kill -9` worker：未删除的消息在可见性超时后重新出现，不丢 |
| 重复执行 | 不会 | 可能，由 `processed_jobs` 吸收 |
| 坏消息 | 内存重试后写 `failed_jobs` | 接收 3 次后进入 DLQ，可重放 |
| CPU 曲线 | 尖峰 | 平台（削峰）；排空时间被拉长 |
| `/lab` queue 卡片 | “memory（本地档）” | “SQS · 可见 / 处理中 / DLQ / 最老”；第二栏列出其他模块自带的队列 |

### 小测

1. **单选**：worker 处理一条消息最长需要 3 分钟，队列的可见性超时是 30 秒，结果同一任务经常被处理两次。应该：
   - A. 改用短轮询
   - B. 把可见性超时调到大于最长处理时间，长任务处理中定期延长可见性
   - C. 把消息保留期调到 14 天
   - D. 把 `maxReceiveCount` 调到 1

   **答案**：B。**解析**：处理时间超过可见性超时，消息会重新可见并被其他消费者拿走；`maxReceiveCount=1` 会把正常的慢任务送进 DLQ。
2. **单选**：订单事件必须对同一个客户严格按顺序、且只处理一次。应选择：
   - A. SQS 标准队列 + 应用层去重
   - B. SQS FIFO 队列，以客户 ID 作为消息组 ID
   - C. SNS 标准主题
   - D. 两个 SQS 标准队列分别承载奇偶订单

   **答案**：B。**解析**：FIFO 在同一消息组内保证顺序，并提供去重；标准队列只尽力排序、至少一次投递。
3. **多选（选两项）**：处理“毒消息”反复失败、阻塞消费的问题，正确的做法是：
   - A. 配置重驱动策略，接收次数超过 `maxReceiveCount` 后移入 DLQ
   - B. 让 DLQ 的消息保留期长于源队列
   - C. 把源队列改为短轮询
   - D. 给所有消息设置 900 秒的投递延迟

   **答案**：A、B。**解析**：标准队列的消息进入 DLQ 后，过期时间仍从最初入队时算起，所以 DLQ 保留期要更长；短轮询与延迟投递都解决不了毒消息。

### 清理说明

- 两条队列随栈删除或由平台回收；DLQ 中的消息随队列删除（需要的话先 `node dist/cli.js queue export-dlq`）。
- 删除后同名队列要等一段时间才能重新创建（以官方文档为准），卡片内不要反复 `disable` / `enable`。
- 本地档设置随实验机删除。

### 对应 SAA 考点

标准队列与 FIFO；可见性超时与心跳；长轮询与短轮询；DLQ、`maxReceiveCount`、`RedriveAllowPolicy`、DLQ redrive；消息保留期与 1 MiB 消息上限、Extended Client 模式；削峰填谷、松耦合、竞争消费者、按积压扩缩容；SQS / SNS / EventBridge / Kinesis 的适用场景；Lambda ESM 消费 SQS；延迟队列；SSE-SQS 与 SSE-KMS。

---

<a id="svc-notification"></a>

## svc-notification · Amazon SNS：通知扇出与订阅过滤

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-notification` |
| kind | `service` |
| 标题 | Amazon SNS：通知扇出与订阅过滤 |
| 一句话简介 | 把“应用逐个发邮件”的站外通知换成一次 SNS Publish，按订阅过滤策略扇出到邮件订阅与模块自带的 SQS 收件队列。 |
| 涉及的 AWS 服务 | 主：Amazon SNS；辅助：Amazon SQS（本模块自带的收件队列与订阅级 DLQ）、AWS IAM；观察：Amazon CloudWatch（`NumberOfNotificationsDelivered`、`NumberOfNotificationsFilteredOut`） |
| 对应的模块 | `notification`（[04#notification](../../modules/04-compute-async.md#notification)） |
| 难度 | 初级（启用 1 个 AWS 模块，05 §2.7.1 不能归为入门） |
| 预计时长 | 60 分钟（含 4 封确认邮件与 SNS 邮件投递的等待，秒到分钟量级） |
| 时间上限 | 90 分钟（30 分钟的整数倍，05 §2.7.2） |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，notification 本身也是 `credentials: required`（CRED-001）。档位 `atl/svc-notification/default`。notification 的 `requires` 为空，不依赖 email 与 queue（SNS → SQS 扇出用的是本模块自带的收件队列）。`prerequisites: confirm-email` 是人工前置 |
| 目标模块 | `notification`：`NOTIFY_DRIVER=sns`，`AdminEmail=<你的邮箱的 +admin 别名>` |
| 费用档位 | 低。主要计费来源：SNS 发布与投递（邮件协议单价高于 SQS）、收件队列的 SQS 请求 |
| 人工前置 | 一个能收信、支持 `+` 别名的邮箱（`learnerInputs: notify-email`）；卡片中要点击约 4 封“AWS Notifications”确认订阅邮件 |
| SAA 考试领域 | 弹性、高性能 |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`；可与 `svc-email` 对照；之后：`sc-event-fanout` |
| 预期警告 | 无（`expectedWarnings: []`；订阅待确认时的 `degraded` 不是规则警告，见第 3 步） |
| 徽章 | “一发多收” |

### 实验简介

**背景**：L0 中“有人评论了你的照片”这类事件由 EC2 写站内信，再逐个调用 EmailPort 发邮件；接收人越多、渠道越多，EC2 干的活越多，sync 档下这些时间全部算在发评论的请求里。

**你将学到**
- SNS + SQS 扇出：推送式一对多，与 SQS 竞争消费（拉取式多选一）的区别。
- 订阅过滤策略（按消息属性或消息体）；邮件订阅必须确认；原始消息传递；订阅级 DLQ。
- SNS 与 SES 的分工：广播订阅 vs 事务性个性化邮件；SNS 不保存消息，站内信必须落库。
- 主题与队列策略中的 `aws:SourceArn`（防混淆代理人）。

**实验资源**
- 起始状态：实验机（L0）、iam 基础策略。
- 本卡创建：栈 `cloudalbum-<envName>-notification`——主题 `notification-events`、管理员邮件订阅（过滤 `audience=admin`）、收件队列与订阅（原始消息、订阅级 DLQ）、客户托管策略；`migrate-module notification up` 为测试用户创建的邮件订阅（过滤 `userId`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `seed` 准备测试用户 | 脚本 | `npx tsx experiments/notification/seed-users.ts --count 3 --email {{ learner.inputs.notifyEmail }}`：注册 3 个 `+u1`～`+u3` 用户并开启邮件通知，再设为管理员 | capability · `notification.driver=db`（once） |
| 2 | `baseline` 逐个发信 | 对比实验 | `npm run exp -- notification --label before --scenario fanout --upload`；到 `/admin/outbox` 核对邮件数 | experiment · `fanout` before 有效 |
| 3 | `enable` 接入 SNS（wire） | 脚本 | `scripts/module enable notification --param AdminEmail=<你的邮箱 +admin 别名>`；到邮箱点击管理员订阅的确认链接 | capability · `notification.driver=sns`、healthy；`pendingIf`：`status=degraded` 且 detail 为“订阅待确认”（点击确认邮件前记为等待，不判失败；附录 C-18）；local（`path-seen`，15 分钟）· 出现 `notification=sns:published`；aws-readonly · `sns:GetTopicAttributes`：`SubscriptionsConfirmed ≥ 2`（管理员 + 收件队列；确认前为 pending）；`sqs:GetQueueAttributes`（收件队列）：队列策略只允许本主题（`aws:SourceArn`）（`ownership: session`） |
| 4 | `subscribe-users` 迁移用户订阅 | 脚本 | `node dist/cli.js migrate-module notification up`：为 3 个用户各建一个带 `userId` 过滤策略的邮件订阅；逐个点击确认邮件 | aws-readonly · `sns:ListSubscriptionsByTopic`：订阅数 ≥ 5；manual · 在 SNS 控制台查看 `+u1` 订阅的过滤策略并填写 |
| 5 | `after` 一次 Publish 的扇出 | 对比实验 | `--label after --scenario fanout --upload`；`npm run exp -- notification --label after --scenario filter --param user=u1 --upload`（只有收件人为 `+u1` 的那封到达；所有别名都进同一个邮箱，按收件人地址区分） | experiment · `fanout` pair；experiment · `filter` after 有效；aws-readonly · `cloudwatch:GetMetricData`：`AWS/SNS NumberOfNotificationsFilteredOut`（`TopicName` 维度）最近 15 分钟之和 > 0（SNS 指标有分钟级延迟，`wait` typical 3 / max 10 分钟） |
| 6 | `worker-stop` worker 停机时 | 观察 | 实验机 `sudo systemctl stop cloudalbum-worker` → 发几条事件：邮件照常到达，收件队列积压上升 → `start` 后消费 | aws-readonly · `sqs:GetQueueAttributes`（收件队列）：停机期间可见消息数 > 0（warn）；manual · 停机期间是否收到邮件 |

### 对比实验

引用 [04#notification 第 5 节](../../modules/04-compute-async.md#notification)：`fanout`、`filter`（必需），`worker-stop`（观察），`compare`（手册中选读：`POST /api/lab/notification/compare`）。

| 观察点 | 没有 SNS（db 驱动） | 有 SNS |
|---|---|---|
| 一次事件的站外投递 | EC2 逐个调用 EmailPort，耗时与接收人数成正比 | EC2 调用一次 Publish（十几到几十毫秒量级），与订阅者数量无关 |
| 开通邮件通知 | 改一个开关，立即生效 | 先收到 AWS 的确认邮件，点击后才投递 |
| 邮件 | 应用模板（HTML），发件人 CloudAlbum | 纯文本，发件人 AWS Notifications，带退订链接 |
| 过滤 | 应用代码判断 | 订阅过滤策略；不相关的订阅者收不到 |
| worker 停止时 | 若 `notify.fanout` 由 worker 消费，邮件暂停 | 已发布的消息照常投递到邮箱，只有收件队列积压 |
| 站内信 | 本地表 | 仍是本地表（SNS 不保存消息） |

### 小测

1. **单选**：一个“照片已上传”事件需要分别触发缩略图、打标签、统计三个独立服务，各自按自己的速度处理，任何一个暂时不可用都不能丢消息。最合适的是：
   - A. 一个 SQS 队列，三个服务竞争消费
   - B. 一个 SNS 主题，三个服务各订阅一个自己的 SQS 队列
   - C. 应用依次同步调用三个服务
   - D. 一个 SNS 主题，三个服务都用 HTTP 端点订阅

   **答案**：B。**解析**：SNS + SQS 扇出让每个消费者拿到一份副本并在自己的队列里缓冲；竞争消费时每条消息只会被一个服务处理；HTTP 订阅在端点不可用时按重试策略重试后丢弃。
2. **单选**：同一个主题上有很多用户的邮件订阅，每位用户只应收到与自己有关的通知。应该：
   - A. 为每个用户创建一个主题
   - B. 在每个订阅上设置过滤策略（如按消息属性 `userId`），发布时带上该属性
   - C. 在邮件客户端设置收信规则
   - D. 使用 SNS FIFO 主题

   **答案**：B。**解析**：订阅过滤策略在 SNS 侧过滤；发布时忘了带属性，所有带过滤策略的订阅都收不到。
3. **单选**：注册后要给用户发送带个性化链接的 HTML 验证邮件，用户此前没有订阅过任何东西。应使用：
   - A. SNS 邮件订阅
   - B. Amazon SES
   - C. SNS 短信
   - D. CloudWatch 告警通知

   **答案**：B。**解析**：SNS 邮件订阅需要收件人先确认、只能发纯文本、所有订阅者内容相同；事务性个性化邮件用 SES。

### 清理说明

- 主题、订阅与队列随栈删除或由平台回收；待确认的订阅会自动过期。
- 邮箱里收到的确认与通知邮件保留在你的邮箱中，无需处理。

### 对应 SAA 考点

SNS + SQS 扇出与竞争消费的区别；订阅过滤策略（`FilterPolicyScope`）；订阅协议；邮件订阅确认、原始消息传递；SNS FIFO + SQS FIFO；投递重试与订阅级 DLQ；CloudWatch 告警 → SNS；SNS / SES / EventBridge 的对比；SSE-KMS 主题与服务主体授权；主题策略与 `aws:SourceArn` / `aws:SourceAccount`。

---

<a id="svc-email"></a>

## svc-email · Amazon SES：真实发信与退信回流

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-email` |
| kind | `service` |
| 标题 | Amazon SES：真实发信与退信回流 |
| 一句话简介 | 把只写进本地 outbox 的邮件改由 SES 真正发出，验证发件身份、查看 DKIM 签名，并用 SES 邮箱模拟器演练退信与投诉回流。 |
| 涉及的 AWS 服务 | 主：Amazon SES；辅助：Amazon SNS + Amazon SQS（本模块自带的反馈通道）、AWS IAM |
| 对应的模块 | `email`（[04#email](../../modules/04-compute-async.md#email)） |
| 难度 | 初级 |
| 预计时长 | 60 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，email 本身也是 `credentials: required`（CRED-001）。档位 `atl/svc-email/default`。email 的 `requires` 为空，不依赖 notification 与 queue（反馈通道自带）。`prerequisites: ses-identity` 是人工前置；不使用域名时不需要 dns |
| 目标模块 | `email`：`EMAIL_DRIVER=ses`，邮箱身份 `--param Email=<你的邮箱>`，`EMAIL_SANDBOX_POLICY=fail`，`EMAIL_FOR_COGNITO=off` |
| 费用档位 | 低。主要计费来源：SES 发送封数；反馈通道的 SNS / SQS 请求 |
| 人工前置 | SES 发件身份：一个能收信的邮箱（`learnerInputs: ses-identity`），在卡片中点击 AWS 的验证邮件；沙盒期收件人只能是已验证地址或 SES 邮箱模拟器。建议用 DMARC 策略不是 `reject` 的邮箱：以邮箱身份发信时 SPF 与 DKIM 都不与发件域对齐，发件域若发布了 `p=reject`，发给你自己的邮件可能被收件方拒收（以官方文档与实测为准）。可选：自有域名（域名身份 + Easy DKIM 需要写 3 条 CNAME）。结束时可勾选保留发件身份（`keepablePrerequisites: [AWS::SES::EmailIdentity]`，与 `saa-main` 中原 Lab 9 一致）；02 §3.5 的预检与“已保留身份再次部署”的冲突见附录 C-12 |
| SAA 考试领域 | 安全、弹性 |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`；可与 `svc-notification` 对照 |
| 预期警告 | 无（`expectedWarnings: []`；SES 沙盒的 `degraded` 不是规则警告，见第 2 步） |
| 徽章 | “真实投递” |

### 实验简介

**背景**：L0 的所有邮件（注册验证、找回密码、评论提醒、日报）只写进 EC2 上的 outbox（`.eml` + `outbox_emails` 表），本人在 `/me/outbox` 预览，页面标注“本地实现，未真正发信”。这也意味着 outbox 档的“邮箱已验证”证明不了邮箱归属。

**你将学到**
- SES 身份（邮箱 / 域名）、沙盒与生产访问（按区域）、发送配额与速率。
- 发信认证：Easy DKIM、SPF（自定义 MAIL FROM）、DMARC；为什么不从 EC2 直接用 25 端口发信。
- 配置集与事件目标；退信、投诉处理与抑制列表；信誉指标。
- 用“SNS + SQS”把 AWS 服务的异步事件安全地送回应用，不需要入站端口。

**实验资源**
- 起始状态：实验机（L0）、iam 基础策略。
- 本卡创建：栈 `cloudalbum-<envName>-email`——邮箱身份、配置集（信誉指标、配置集级抑制）、事件主题与反馈队列（+ DLQ）、CloudWatch 事件目标、客户托管策略（`ses:SendEmail` 用 `ses:FromAddress` 条件限定）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `baseline` 本地 outbox | 对比实验 | 在预览注册一个新用户 → `/me/outbox` 打开验证邮件；`npm run exp -- email --label before --scenario send-matrix --upload`（成功、退信、投诉三个模拟器地址 + 你的地址） | capability · `email.driver=outbox`（once）；experiment · `send-matrix` before 有效（全部写入 outbox） |
| 2 | `enable` 接入 SES（wire） | 脚本 | `scripts/module enable email --param Email={{ learner.inputs.sesIdentity }}` → 到邮箱点击验证链接 → 脚本轮询到“已验证”后写 env、重启、向模拟器发探针邮件 | capability · `email.driver=ses`；`anyOf`：healthy，或 `status=degraded` 且 detail 以“沙盒”开头（SES 沙盒不是规则表中的 warn，`healthy` 不接受它，附录 C-18）；local（`path-seen`，15 分钟）· 出现 `email=ses:sent`；aws-readonly · `ses:GetEmailIdentity`：`VerifiedForSendingStatus=true`（**不设 `ownership`**：发件身份是允许跨会话保留的前置资源，复用时它不是本会话创建的；接入的证明由 capability 与 `path-seen` 提供）；aws-readonly · `ses:GetAccount`：记录 `ProductionAccessEnabled`（warn，只展示） |
| 3 | `after` 发信矩阵 | 对比实验 | 同第 1 步 `--label after`：脚本轮询 `/api/admin/outbox`，记录每封的发送延迟与最终投递状态 | experiment · `send-matrix` pair（success → 已投递、bounce → 退信、complaint → 投诉）；aws-readonly · `sqs:GetQueueAttributes`（反馈 DLQ）：深度为 0 |
| 4 | `headers` 看原始邮件 | 观察 | 在邮箱客户端“显示原始邮件”：`DKIM-Signature`、`Authentication-Results` | manual · 选择看到的 DKIM 结果与签名域（邮箱身份由 SES 以自己的域签名，与发件域不对齐；域名身份 + Easy DKIM 才对齐） |
| 5 | `sandbox` 沙盒限制 | CLI | `npx tsx experiments/email/sandbox.ts --to <一个未验证的地址>` → `MessageRejected`；`aws sesv2 get-account` | manual · 被拒原因与 `ProductionAccessEnabled` 的值 |
| 6 | `register-latency`（选做） | 对比实验 | `QUEUE_DRIVER=sync` 下 `npm run exp -- email --label after --scenario register-latency --upload`（运行器调用 `register.k6.js`），对比 ses 驱动与第 1 步 outbox 时的注册接口延迟 | experiment · `register-latency` after（非必需） |
| 7 | `domain-identity`（选做） | 脚本 | 有自有域名时 `scripts/module enable email --param Domain=<域名>`，手动添加 3 条 DKIM CNAME，等待验证 | aws-readonly · `ses:GetEmailIdentity`：`DkimAttributes.Status=SUCCESS`（非必需） |

> **取舍**：生产访问需要人工审核（通常以天计），卡片始终在沙盒中完成；`/api/lab/email/compare` 的功能对照在手册中选读。

### 对比实验

引用 [04#email 第 5 节](../../modules/04-compute-async.md#email)：`send-matrix`（必需）、`sandbox`（观察）、`register-latency`、`compare`（选做）。

| 观察点 | 没有 SES（outbox） | 有 SES |
|---|---|---|
| 用户能否收到邮件 | 不能，本人在 `/me/outbox` 预览 | 能（沙盒期只能发给已验证地址） |
| 邮箱验证能否证明归属 | 不能 | 能（链接只发到真实收件箱） |
| 发送耗时 | 写文件与数据库，毫秒级 | 一次 HTTPS API 调用，几十到上百毫秒量级（放进队列后用户无感） |
| 退信 / 投诉 | 不存在 | 经 SNS → SQS 回流，`users.email_status` 更新，之后只发必要邮件 |
| 原始邮件 | 无签名 | 带 `DKIM-Signature`，`Authentication-Results` 中 `dkim=pass` |
| 发给未验证地址（沙盒） | 写入 outbox | `MessageRejected`，在 `/admin/outbox` 标红 |

### 小测

1. **单选**：新账号中的应用调用 SES 给注册用户发邮件，只有少数地址能收到，其余报“地址未验证”。原因与做法是：
   - A. 账号处于 SES 沙盒，只能发给已验证的身份；需要申请生产访问
   - B. 需要先为每个用户创建 SNS 订阅
   - C. EC2 的出站 25 端口被限制，需要申请解除
   - D. 需要为 SES 开启 VPC 终端节点

   **答案**：A。**解析**：沙盒按区域生效，收件人必须已验证；走 SES API 不涉及 25 端口。
2. **多选（选三项）**：提高从 SES 发出的邮件的认证与送达率，应该：
   - A. 为发件域开启 Easy DKIM
   - B. 配置自定义 MAIL FROM 域，使 SPF 与发件域对齐
   - C. 发布 DMARC 记录
   - D. 改为从 EC2 弹性 IP 用 25 端口直接投递

   **答案**：A、B、C。**解析**：DKIM、SPF、DMARC 三者配合；从 EC2 IP 直接投递信誉差、且 25 端口默认受限。
3. **单选**：要自动跟踪退信与投诉，并停止向无效地址发信，同时不让 EC2 开放入站端口。应该：
   - A. 定期登录控制台查看信誉面板
   - B. 为配置集添加事件目标到 SNS，再由 SQS 订阅，应用轮询处理；配合抑制列表
   - C. 让 SES 通过 HTTP 回调 EC2
   - D. 用 CloudWatch Logs 订阅 SES 的发送日志

   **答案**：B。**解析**：配置集事件经 SNS → SQS 回流，应用主动拉取，不需要入站端口；抑制列表兜底。

### 清理说明

- 身份、配置集、主题与队列随栈删除或由平台回收。结束对话框会询问是否保留 SES 发件身份（02 §7.2 允许保留的前置资源）；保留后它留在账号中。注意：email 栈用 `AWS::SES::EmailIdentity` 创建身份，下次再 `enable email` 时同名身份已存在，栈会创建失败——模块需要“接管已有身份”的参数，或卡片改为先删除再验证，修订前不建议勾选保留（附录 C-12）。
- 沙盒状态按区域保持不变；本卡不申请生产访问。
- 做过域名身份时，记得删除你在外部 DNS 服务商手动添加的 DKIM 记录。

### 对应 SAA 考点

SES 身份验证、Easy DKIM、SPF、DMARC、自定义 MAIL FROM；沙盒与生产访问、发送配额与速率；配置集与事件目标；退信与投诉、抑制列表、信誉指标；SES 与 SNS 邮件订阅的区别；EC2 出站 25 端口限制；Cognito 默认邮件与经 SES 发送；SMTP 接口与 API 接口。

---

<a id="svc-scheduler"></a>

## svc-scheduler · Amazon EventBridge Scheduler：不漏跑的定时任务

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-scheduler` |
| kind | `service` |
| 标题 | Amazon EventBridge Scheduler：不漏跑的定时任务 |
| 一句话简介 | 把 worker 里的 node-cron 换成 EventBridge Scheduler + 模块自带的 tick 队列，亲手制造一次“触发时刻 worker 不在线”，看 cron 漏跑、Scheduler 补跑。 |
| 涉及的 AWS 服务 | 主：Amazon EventBridge Scheduler；辅助：Amazon SQS（本模块自带的 tick 队列与两个 DLQ）、AWS IAM |
| 对应的模块 | `scheduler`（[04#scheduler](../../modules/04-compute-async.md#scheduler)） |
| 难度 | 初级 |
| 预计时长 | 75 分钟（含等待触发点） |
| 时间上限 | 120 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，scheduler 本身也是 `credentials: required`（CRED-001）。档位 `atl/svc-scheduler/default`。③ **本地设置** `SCHEDULER_COMPARE_HEARTBEAT=on`（`kind: local`；目标模块因此写 `fromDriver: cron`）（`scripts/module enable scheduler --driver cron --param CompareHeartbeat=on` 的效果：只写 `modules.d/scheduler.env`，不部署栈、不写 `MODULE_SCHEDULER=on`）：`lab.heartbeat` 每 5 分钟一次，部署期间就开始积累 cron 基线点，缩短卡片内的等待。scheduler 只有 DEP-026（仅 `Target=ssm` 时），本卡用默认 `Target=tick-queue`，不涉及 |
| 目标模块 | `scheduler`：`SCHEDULER_DRIVER=eventbridge`，`Target=tick-queue`，`CompareHeartbeat=on` |
| 费用档位 | 低。主要计费来源：Scheduler 调用次数（8 个 schedule，主要来自每分钟一次的对账任务）、tick 队列的 SQS 请求 |
| 人工前置 | 无 |
| SAA 考试领域 | 弹性、高性能 |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`；`svc-queue`（理解至少一次投递与幂等） |
| 预期警告 | 无（`expectedWarnings: []`） |
| 徽章 | “准时补跑” |

### 实验简介

**背景**：L0 的 8 个定时任务（日报、清理、对账……）由 worker 进程内的 node-cron 触发：触发那一刻 worker 不在线，这一次就漏了；多实例时每台各跑一次，管理员收到 N 封日报。

**你将学到**
- EventBridge Scheduler 与 EventBridge 定时规则的区别（时区、一次性调度、灵活时间窗口、每个调度的重试与 DLQ、通用目标）。
- `cron` / `rate` / `at` 表达式；EventBridge cron 是 6 个字段，日与星期必须有一个写成 `?`。
- “单一调度器 + 队列”：宕机后补跑、多实例只执行一次；按 `(name, scheduledAt)` 幂等。
- 调用目标的权限在 Scheduler 的执行角色上，不在 EC2 角色上；先以 DISABLED 预建、再切换的发布方式。

**实验资源**
- 起始状态：实验机（L0 + cron 档对照任务）、iam 基础策略。
- 本卡创建：栈 `cloudalbum-<envName>-scheduler`——调度组、8 个 schedule（东京时区）、tick 队列（+ redrive DLQ）、Scheduler DLQ、执行角色、客户托管策略；健康探针创建的一次性调度（执行后自动删除）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `orient` 观察 cron | 观察 | `/admin/jobs`：8 个任务、下次触发时间、trigger 列为 `cron`；`lab.heartbeat` 已有若干行 | capability · `scheduler.driver=cron`（once）；local（`app-stat`，`job_runs.heartbeat.cron`）· ≥ 1（统计名由 06 登记） |
| 2 | `baseline` 漏跑（before） | 对比实验 | `npm run exp -- scheduler --label before --scenario missed-run --param job=lab.heartbeat --upload`（运行器调用 `missed-run.sh`）：下一个触发点前 1 分钟停 worker，过点 3 分钟后再启动 | experiment · `missed-run` before 有效（该时刻缺失，红色占位行） |
| 3 | `enable` 接入 Scheduler（wire） | 脚本 | `scripts/module enable scheduler`：`scheduler export` 生成表达式 → 以 DISABLED 部署 → 写 env、重启 worker → 改为 ENABLED → 一次性调度探针 | capability · `scheduler.driver=eventbridge`、healthy；local（`app-stat`，`job_runs.trigger.eventbridge`）· ≥ 1；aws-readonly · `scheduler:GetSchedule`（`report-daily`）：`ScheduleExpressionTimezone=Asia/Tokyo`、`State=ENABLED`、`FlexibleTimeWindow.Mode=OFF`、目标为本会话 tick 队列且配置了 DLQ 与重试策略；`scheduler:ListSchedules`（本组）：名称不以 `probe-` 开头的 schedule 恰好 8 个（健康探针的一次性调度执行后才自动删除，检查时可能还在；`ownership: session`） |
| 4 | `inspect` 看懂表达式与目标 | CLI + 控制台 | `aws scheduler list-schedules --group-name cloudalbum-{{ session.env }}`、`get-schedule --name report-daily`；控制台对照 cron 字段、时区、灵活时间窗口 | manual · “`cron(0 9 * * ? *)` 中的 `?` 写在哪个字段、为什么” |
| 5 | `after` 补跑与双触发 | 对比实验 | 同第 2 步 `--label after`（同样跨过一个触发点）：eventbridge 档在 worker 恢复后补跑，`started_at − scheduled_at` 约 3 分钟；再跑 `npm run exp -- scheduler --label after --scenario heartbeat --duration 20m --upload`（同一时刻 cron 与 eventbridge 各一个点） | experiment · `missed-run` pair；experiment · `heartbeat` after 有效 |
| 6 | `second-worker` 重复执行 | 对比实验 | `npm run exp -- scheduler --label after --scenario second-worker --upload`（运行器调用 `second-worker.sh`）：临时启动第二个 worker（独立的文件锁目录，模拟另一台主机），观察 cron 档的 singleton 任务在同一时刻是否出现两次执行、eventbridge 档只有一次。注意 `job_runs` 的 `(name, scheduled_at)` 唯一索引同样会拦住 cron 档的第二次插入，预期结果取决于 cron 驱动如何取 `scheduledAt`，需模块文档澄清（附录 C-13） | experiment · `second-worker` after 有效；local（`systemd-unit`）· 结束后没有遗留的 `cloudalbum-worker-2`（04 §6.4 的白名单已含 `cloudalbum-worker-<n>`） |
| 7 | `dlq-fault`（选做） | 脚本 | `dlq-fault.sh`：给执行角色临时加一条拒绝 `sqs:SendMessage` 的内联策略，观察 Scheduler 重试；两个周期后删除 | aws-readonly · 结束时执行角色上没有该内联策略（must-hold） |

> **取舍**：模块文档的 `heartbeat` 基线与 after 各跑 60 分钟，卡片缩为“部署期间积累的 cron 点 + 20 分钟 after”；漏跑演示改以 `missed-run` 为主（一个触发点约 10 分钟）。`dlq-fault` 中事件进入 DLQ 的时间取决于 `MaximumEventAgeInSeconds`（模板默认 1 小时），卡片内只观察重试，不等待进入 DLQ（附录 C-7）。

### 对比实验

引用 [04#scheduler 第 5 节](../../modules/04-compute-async.md#scheduler)：`missed-run`（必需）、`heartbeat`（缩短版，必需）、`second-worker`（必需）、`dlq-fault`（选做）。

| 观察点 | 没有 Scheduler（node-cron） | 有 Scheduler（tick-queue） |
|---|---|---|
| 谁来计时 | worker 进程，依赖实例时钟 | AWS 托管的调度服务 |
| 触发时刻 worker 不在线 | 这一次漏跑（红色占位行） | tick 在队列里等待，恢复后补跑 |
| 两个 worker / 多实例 | singleton 任务每台各执行一次（ASG-006） | 每个计划时刻只执行一次 |
| 触发精度 | 单实例秒级准时 | 秒到数十秒量级（投递 + 长轮询，FLEXIBLE 任务被打散） |
| 重复投递 | 不会 | 可能，被 `(name, scheduledAt)` 唯一索引吸收（`skipped-duplicate`） |
| 修改计划 | 改代码、重启 | 改注册表后重新部署栈；控制台手改会被识别为漂移 |

### 小测

1. **单选**：每天东京时间 09:00 生成日报，并需要每个调度单独设置重试与死信队列，未来还要支持“某个时间点只执行一次”的提醒。最合适的是：
   - A. EventBridge 事件总线上的定时规则
   - B. Amazon EventBridge Scheduler
   - C. 在 EC2 上用 cron
   - D. CloudWatch 告警

   **答案**：B。**解析**：Scheduler 支持时区、一次性调度、每个调度的重试与 DLQ；定时规则按 UTC，没有一次性调度。
2. **单选**：一个 Auto Scaling 组的 3 台实例都配置了同一个 cron 任务，结果报表每天生成 3 次。在不引入分布式锁的前提下，最简单可靠的改法是：
   - A. 只在第一台实例上保留 cron
   - B. 由一个集中的调度器按时向 SQS 队列投递任务，实例上的 worker 竞争消费
   - C. 把 cron 时间错开
   - D. 把组的最小容量设为 1

   **答案**：B。**解析**：“单一调度器 + 队列”保证每个时刻只有一条消息、只被一个消费者处理；实例会被替换，“第一台”不可靠。
3. **单选**：Scheduler 调用 SQS 目标一直失败、事件进入 DLQ，错误是 AccessDenied。应检查：
   - A. EC2 实例角色是否有 `sqs:SendMessage`
   - B. Scheduler 执行角色是否有对该队列的 `sqs:SendMessage`（使用 CMK 时还要能用该密钥）
   - C. 队列是否开启了长轮询
   - D. 调度组是否为 default

   **答案**：B。**解析**：调用目标的权限在 Scheduler 的执行角色上，与 EC2 角色无关。

### 清理说明

- 删除调度组会一并删除其中全部 schedule；探针创建的一次性调度执行后自动删除（失败时用 `aws scheduler list-schedules --name-prefix probe-` 检查残留）。
- 做过 `dlq-fault` 时确认内联拒绝策略已删除（检查会提醒）；`second-worker` 的临时单元在脚本结束时停止。

### 对应 SAA 考点

EventBridge Scheduler 与 EventBridge 定时规则；`cron` / `rate` / `at` 表达式、时区与灵活时间窗口；重试策略与 DLQ；模板化目标与通用目标；上下文属性；执行角色；API Destination 与 Connection；多实例 cron 重复执行与“单一调度器 + 队列”；SSM Run Command；Lambda 作为定时目标的 15 分钟上限。

---

<a id="svc-tagging"></a>

## svc-tagging · Amazon Rekognition：图片识别与审核

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-tagging` |
| kind | `service` |
| 标题 | Amazon Rekognition：图片识别与审核 |
| 一句话简介 | 给照片加上 Rekognition 的内容标签与自动审核，用同一组 CC0 测试图并排比较“元数据标签”与“内容标签”的命中率，再看审核误判。 |
| 涉及的 AWS 服务 | 主：Amazon Rekognition（`DetectLabels`、`DetectModerationLabels`）；辅助：AWS IAM |
| 对应的模块 | `tagging`（[04#tagging](../../modules/04-compute-async.md#tagging)） |
| 难度 | 初级（启用 1 个 AWS 模块，05 §2.7.1 不能归为入门） |
| 预计时长 | 45 分钟 |
| 时间上限 | 90 分钟（30 分钟的整数倍且 ≥ 预计 × 1.5，05 §2.7.2） |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2`。② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`）：C3 通则，tagging 本身也是 `credentials: required`（CRED-001）。档位 `atl/svc-tagging/default`。tagging 只有 DEP-027（`TAGGER_INPUT=s3` 时需要 storage）；本卡用 `TAGGER_INPUT=auto`，storage=local 时自动走字节方式，**不需要 storage**。**未并入**：queue（sync 档下两次调用的延迟加在“上传完成”请求上，正好是观察点之一） |
| 目标模块 | `tagging`：`TAGGER_DRIVER=rekognition`，`TAGGER_INPUT=auto`（本卡为 bytes），`TAGGER_MODERATION_ACTION=log` 起步、第 5 步改为 `enforce` |
| 费用档位 | 低。主要计费来源：按分析的图片数计费，每张照片 2 次调用（约 30 张测试图 × 2 次 × 数轮）；启动探针每次重启 1 次调用 |
| 人工前置 | 无（开始前请了解：图片会发送给 AWS 的 AI 服务，数据使用与 Organizations 的 AI 服务退出策略见手册） |
| SAA 考试领域 | 高性能、安全 |
| 推荐的前置卡片 | `svc-ec2`、`svc-iam`；之后：`sc-image-pipeline`（S3Object 输入 + Lambda + SQS） |
| 预期警告 | 无（`expectedWarnings: []`） |
| 徽章 | “看懂图片” |

### 实验简介

**背景**：L0 的照片只有 EC2 从元数据算出的“基础属性标签”（横图 / 竖图、主色、分辨率档、年份、季节），搜不到“狗”；审核结论恒为通过，违规内容只能靠举报加人工复核。

**你将学到**
- 托管 AI 服务与自建模型的取舍；`DetectLabels` 与 `DetectModerationLabels`（三级分类、置信度阈值、review 与 block 两档）。
- 输入方式：`Bytes` 与 `S3Object`（以**调用者**的权限读取、桶必须同区域、只支持 JPEG / PNG）；尺寸与大小上限。
- TPS 配额与限流，用队列削峰；不支持资源级权限的 API 在策略中只能写 `Resource: *`。
- Rekognition、Textract、Comprehend 等 AI 服务的定位；Amazon A2I 人工复核。

**实验资源**
- 起始状态：实验机（L0）、iam 基础策略。
- 本卡创建：栈 `cloudalbum-<envName>-tagging`（只有一条客户托管策略，没有托管资源）。
- 测试数据：`experiments/tagging/fixtures/` 约 30 张 CC0 图片与人工标注 `labels.json`。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `baseline` 元数据标签 | 对比实验 | `npm run exp -- tagging --label before --scenario upload-and-search --upload`：上传测试集，按 `labels.json` 中的标签搜索 | capability · `tagging.driver=none`（once）；experiment · `upload-and-search` before 有效（按内容几乎搜不到） |
| 2 | `enable` 接入 Rekognition（wire） | 脚本 | `scripts/module enable tagging`（审核动作先用 `log`，参数名以模块模板为准）→ 重启 → 128×128 JPEG 启动探针；在预览上传 1 张 | capability · `tagging.driver=rekognition`、healthy；local（`path-seen`，15 分钟）· 出现 `tagging=rekognition:bytes` |
| 3 | `eval` 并排分析 | 对比实验 | `npm run exp -- tagging --label after --scenario eval --upload`（运行器调用 `eval.ts`）：每张图调用两次 `/api/lab/tagger/analyze`（带 / 不带 `X-Compare-Bypass: tagger`，结果不落库），输出命中率、延迟与误判样例 | experiment · `eval` after 有效 |
| 4 | `after` 上传与搜索 | 对比实验 | 同第 1 步 `--label after` | experiment · `upload-and-search` pair（搜到的比例明显提高） |
| 5 | `moderation` 审核与误判 | 脚本 | `moderation.ts --action log` 统计误判数 → 改为 `enforce` → 上传无害替代素材（如玩具枪图片，结果以实测为准），观察拦截占位图或进入 `/admin/reviews` | manual · log 模式下被标记的张数与 enforce 后的结论 |
| 6 | `throttle`（选做） | 对比实验 | 先 `scripts/module enable queue --driver memory`，再 `npm run exp -- tagging --label after --scenario throttle --param concurrency=20 --param count=100 --upload`：绕过队列直接并发调用 vs 经 `image.tag` 队列（200 次计费调用） | experiment · `throttle` after（非必需） |

### 对比实验

引用 [04#tagging 第 5 节](../../modules/04-compute-async.md#tagging)：`upload-and-search`、`eval`（运行时 A/B，必需），`moderation`（观察），`throttle`（选做）。

| 观察点 | 没有 Rekognition（none） | 有 Rekognition |
|---|---|---|
| 标签内容 | 只有元数据：方向、主色、分辨率、年份、季节 | 内容标签（物体、场景、动作）+ 基础标签 |
| 按内容搜索“狗” | 没有结果 | 列出含狗的照片 |
| 自动审核 | 没有，恒为通过 | 自动拦截 / 进入复核，存在误判 |
| 每张耗时 | 微秒到毫秒级 | 两次 API 调用，百毫秒到秒级（sync 档加在上传请求上） |
| EC2 负载 | 几乎为零 | 字节方式需要一次 JPEG 转码与上传 |
| 隐私 | 图片不出 EC2 | 图片发送给 AWS 的 AI 服务 |

### 小测

1. **单选**：社区网站要自动识别用户上传的不当图片，低置信度的结果交给人工复核。最合适的是：
   - A. Amazon Rekognition `DetectModerationLabels`，配合 Amazon Augmented AI（A2I）做人工复核
   - B. Amazon Comprehend
   - C. Amazon Textract
   - D. 在 EC2 上自己训练分类模型

   **答案**：A。**解析**：Rekognition 提供内容审核标签与置信度，A2I 提供人工复核工作流；Comprehend 处理文本，Textract 提取文档文字。
2. **单选**：应用调用 Rekognition 时传入 `S3Object`，返回 AccessDenied，而 Rekognition 本身的权限没问题。最可能的原因是：
   - A. Rekognition 以调用者的身份读取对象，调用者缺少该对象的 `s3:GetObject`（SSE-KMS 时还需要 `kms:Decrypt`），或桶不在同一区域
   - B. 桶没有开启版本控制
   - C. Rekognition 只能读取公开对象
   - D. 需要为 Rekognition 创建 VPC 终端节点

   **答案**：A。**解析**：S3Object 方式要求调用者对对象有读权限，且桶与 Rekognition 端点在同一区域。
3. **单选**：需要从扫描的收据中提取打印文字与表格结构。应选择：
   - A. Amazon Rekognition `DetectText`
   - B. Amazon Textract
   - C. Amazon Comprehend
   - D. Amazon Transcribe

   **答案**：B。**解析**：Textract 面向文档，能提取文字、表格与表单；Rekognition 的文字检测面向场景中的少量文字；Comprehend 做文本分析，Transcribe 做语音转文字。

### 清理说明

- 本模块只有一条策略，随栈删除；Rekognition 本身没有需要清理的资源（本项目不建人脸集合）。
- 标签数据在实验机的数据库中，随实验机删除。
- 选做 `throttle` 启用的 memory 队列是本地档，无需处理。

### 对应 SAA 考点

Rekognition 图像 API 与视频 API（异步作业 + SNS 通知）；托管 AI 服务与自建模型；以调用者权限读取 S3、同区域要求、SSE-KMS 需要 `kms:Decrypt`；字节与 S3 对象输入的上限、只支持 JPEG / PNG；TPS 配额与队列削峰；AI 服务退出策略；事件驱动处理链；Rekognition / Textract / Comprehend / Transcribe 的定位、A2I；不支持资源级权限的 API。

---

<a id="svc-social-api"></a>

## svc-social-api · Amazon API Gateway：社交 API 托管入口

### 元数据

| 项 | 内容 |
|---|---|
| id | `svc-social-api` |
| kind | `service` |
| 标题 | Amazon API Gateway：社交 API 托管入口 |
| 一句话简介 | 在点赞评论接口前加一层 API Gateway HTTP API（代理回源 EC2），把限流、授权与访问日志前移到网关，看 429 和 401 在哪一层发生。 |
| 涉及的 AWS 服务 | 主：Amazon API Gateway（HTTP API）；辅助：Amazon CloudWatch Logs（访问日志）；选做：AWS Lambda（Lambda 授权器） |
| 对应的模块 | `social-api`（[04#social-api](../../modules/04-compute-async.md#social-api)） |
| 难度 | 初级 |
| 预计时长 | 60 分钟 |
| 时间上限 | 90 分钟 |
| 可延长次数 | 2 次 × 30 分钟 |
| startProfile | ① `l0-ec2` + ② `iam`（`IAM_CREDENTIALS=role`，`basis: credential`；档位 `atl/svc-social-api/default`）：选 **proxy 集成**（组合矩阵第 1 行）——没有硬依赖，EC2 的弹性 IP 对网关公网可达即可；iam 按 C3 预置，EC2 侧的 `apigateway:GET` 控制面探针因此可用。**未并入**：social-store、auth——只有 lambda 集成（DEP-022、024）或 jwt 授权器（DEP-023）才需要。**lambda 集成**需要 {iam, social-store} + 授权器 + 工具链，属于多服务组合，放到场景卡 `sc-serverless-api` |
| 目标模块 | `social-api`：`Integration=proxy`，`Authorizer=none`，`ThrottleRate=20`，`ThrottleBurst=40`；选做：`Authorizer=lambda`（auth=local 的 ES256 + JWKS，组合矩阵第 2 行） |
| 费用档位 | 低。主要计费来源：HTTP API 请求数、访问日志的摄取与存储；选做的 Lambda 授权器请求与 GB-秒 |
| 人工前置 | 无 |
| SAA 考试领域 | 安全、高性能、弹性 |
| 推荐的前置卡片 | `svc-ec2`；之后：`sc-serverless-api`、`sc-edge-protection` |
| 预期警告 | 无（`expectedWarnings: []`） |
| 徽章 | “API 网关” |

### 实验简介

**背景**：L0 的点赞、评论、分享接口就是 Express 的 `/social/*` 路由，限流靠 Nginx 与 express-rate-limit：所有请求（包括恶意的、未登录的、超限的）都已经打到了 EC2 上，才被拒绝。

**你将学到**
- HTTP API 与 REST API 的区别（API Key、使用计划、缓存、WAF、X-Ray、私有端点只有 REST API 支持）。
- 集成类型：HTTP 代理、Lambda 代理、私有集成（VPC Link）；网关的阶段与路由级限流、429。
- 授权器：JWT 授权器（只支持 RSA 系列算法）、Lambda 授权器（结果缓存）、IAM 授权；401 发生在网关还是源站。
- 访问日志与 `Latency − IntegrationLatency`；proxy 回源 EC2 时绕过网关的风险与 `X-Origin-Verify`。

**实验资源**
- 起始状态：实验机（L0）、iam 基础策略（C3）。
- 本卡创建：栈 `cloudalbum-<envName>-social-api`——HTTP API、`$default` 阶段（限流）、每个接口一条显式路由、HTTP 代理集成（注入 `X-CloudAlbum-Via`、`X-Origin-Verify`）、访问日志组（保留 14 天）、客户托管策略；选做时增加 Lambda 授权器函数。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型 · 判定要点） |
|---|---|---|---|---|
| 1 | `baseline` Express 基线 | 对比实验 | `npm run exp -- social-api --label before --scenario mixed --upload`（读 70%、点赞 20%、发评论 10%，目标 `http://<EIP>/social`） | capability · `social-api.driver=express`（once）；experiment · `mixed` before 有效 |
| 2 | `enable` 接入 API Gateway（wire） | 脚本 | `scripts/module enable social-api --param Integration=proxy --param Authorizer=none --param ThrottleRate=20 --param ThrottleBurst=40`；刷新预览，DevTools 中社交请求的域名变为 `execute-api` | capability · `social-api.driver=apigw`、healthy；http-header（platform，`apigw`，`/social/health`）· 响应带 `apigw-requestid`、路径段 `entry=apigw>nginx`；aws-readonly · `apigateway:GET /apis/{id}`：`ProtocolType=HTTP`（`ownership: session`） |
| 3 | `compare` 多一跳的开销 | 对比实验 | `npm run exp -- social-api --label after --scenario compare --upload`：同一次运行中交替请求 `http://<EIP>/social` 与网关地址（按 URL 的 A/B，底层为 `compare.k6.js`） | experiment · `compare` after 有效 |
| 4 | `throttle` 429 在哪一层 | 对比实验 | `npm run exp -- social-api --label before --scenario throttle --param target=origin --upload`（`RATE=100` 直打 `http://<EIP>/social`），再 `--label after --param target=apigw`（同样速率打网关地址）；运行器同时调用 `origin-count.ts --since 2m` 读 EC2 实际收到的 `/social` 请求数 | experiment · `throttle` pair（before：429 由 EC2 返回、EC2 收到全部请求；after：EC2 收到的请求数被限在约 `ThrottleRate` 水平） |
| 5 | `logs` 访问日志 | 控制台 | CloudWatch Logs 打开 `/cloudalbum/{{ session.env }}/social-api/access`，找到 429 的记录，比较 `integrationLatency` 与 `responseLatency` | aws-readonly · `logs:DescribeLogGroups`：日志组存在、保留 14 天；manual · 429 记录中 `integrationLatency` 的值（期望为空或 `-`：请求没有到达源站） |
| 6 | `authorizer`（选做） | 脚本 + 对比实验 | `scripts/module enable social-api --param Integration=proxy --param Authorizer=lambda`（部署时读取实验机的 JWKS；Lambda 授权器的部署包经工具链桶上传）；`npm run exp -- social-api --label after --scenario unauth --upload`（运行器调用 `unauth.k6.js`） | experiment · `unauth` after（非必需）：401 的响应没有 `X-CloudAlbum-Path`（由网关返回） |
| 7 | `require-gateway`（选做） | 脚本 | 设置 `SOCIAL_API_REQUIRE_GATEWAY=true` 后，直连 `http://<EIP>/social/...` 返回 `403 GATEWAY_REQUIRED` | local（`env-key`，`social-api.SOCIAL_API_REQUIRE_GATEWAY`）· = true（非必需） |

### 对比实验

引用 [04#social-api 第 5 节](../../modules/04-compute-async.md#social-api)：`mixed`、`compare`、`throttle`（必需），`unauth`（选做）；`cold-start`、`ec2-down` 属于 lambda 集成，放到 `sc-serverless-api`。

| 观察点 | 没有 API Gateway（Express `/social`） | 有 API Gateway（proxy） |
|---|---|---|
| 入口 | 同源，经 Nginx 到 Express | `execute-api` 域名；响应头多了 `apigw-requestid` |
| 超限请求 | Nginx / Express 返回 429，但请求已到达 EC2 | 网关直接返回 429，EC2 的请求数与 CPU 不受影响 |
| 未登录的写请求（选做授权器） | EC2 返回 401 | 网关返回 401，没有 `X-CloudAlbum-Path` |
| 访问日志与指标 | Nginx JSON 日志 + 本地指标 | 网关访问日志 + CloudWatch（`Latency` 与 `IntegrationLatency` 分开） |
| 延迟 | 基线 | 多一跳，增加几毫秒到几十毫秒量级 |
| 路径头 | `entry=nginx` | `entry=apigw>nginx` |

### 小测

1. **单选**：一个对外 API 需要为每个合作方发放 API Key、按合作方设置用量配额，并在 API 上直接关联 AWS WAF。应选择：
   - A. API Gateway HTTP API
   - B. API Gateway REST API
   - C. Application Load Balancer
   - D. Lambda 函数 URL

   **答案**：B。**解析**：API Key、使用计划、WAF 关联、响应缓存都只有 REST API 支持；HTTP API 更便宜，适合不需要这些功能的场景。
2. **单选**：后端只能承受稳定的请求速率，突发流量会把它打垮。希望超出部分在到达后端之前就被拒绝。应该：
   - A. 给后端实例加 CPU 告警
   - B. 在 API Gateway 的阶段或路由上设置限流（速率与突发），超出时返回 429
   - C. 开启 API Gateway 访问日志
   - D. 把后端改为 Multi-AZ

   **答案**：B。**解析**：网关限流在请求到达集成之前拒绝；告警与日志只能发现问题。
3. **单选**：API Gateway 需要访问位于私有子网、不对公网开放的后端服务。应该使用：
   - A. 给后端分配弹性 IP
   - B. 私有集成：通过 VPC Link 连接到内部 ALB / NLB（或 Cloud Map）
   - C. 把 API 改为私有 API 端点
   - D. 在后端安全组放行 0.0.0.0/0

   **答案**：B。**解析**：VPC Link 让网关访问 VPC 内的私有资源；私有 API 端点解决的是“谁能调用 API”，不是“API 怎么访问后端”。

### 清理说明

- API、阶段、访问日志组、授权器函数随栈删除或由平台回收。
- 打开过 `SOCIAL_API_REQUIRE_GATEWAY` 时，若选择“保留环境”，记得网关被删除后直连会一直返回 403（`disable social-api` 会同时关掉它）。

### 对应 SAA 考点

HTTP API / REST API / WebSocket API 的区别；集成类型（Lambda 代理、HTTP 代理、VPC Link 私有集成）；授权方式（JWT、Lambda、IAM、REST API 的 Cognito 用户池授权器）；账号级、阶段级、路由级限流与 429；集成超时上限；CORS；在 API 前加 CloudFront 与 WAF；ALB 与 API Gateway 作为 API 入口的取舍；区域型自定义域名需要同区域的 ACM 证书；按请求付费与按小时付费。

---

## 附录 A：svc-storage 的完整 lab.yaml

格式以 04 §3 的 `atl.lab/v2` 为准（C2）；第 1 批附录 A.1 给出了第 1 轮写法与 04 v2 的对照。本卡专属检查的定义节选附在后面。

```yaml
# labs/svc-storage/lab.yaml
schema: atl.lab/v2
id: svc-storage
kind: service
version: 2.0.0                         # 第 3 轮：起始状态、“正常”判定与标签模型的语义变化 → 主版本 +1
status: beta
service: Amazon S3
function: 照片对象存储
title: Amazon S3：照片对象存储           # title = <service>：<function>，≤ 48 字
subtitle: 上传字节从 EC2 网卡移到浏览器直传 S3
summary: 把照片从 EC2 的 EBS 数据卷搬进 S3，上传改为预签名 URL 直传；用同一组压测对比 EC2 网卡入流量、API CPU 与数据卷水位的变化。
story: |
  CloudAlbum 只有一台 EC2：每张原图都要经 Nginx 流进 Node、写到 20 GiB 的数据卷上，
  同一块盘上还有 SQLite、日志和本地备份。上传一多，CPU 被占满；盘一满，连评论都写不进去。
  这一课把“存照片”交给 Amazon S3，EC2 只负责签发一个几 KB 的上传 URL。
objectives:
  - { text: 说清预签名 URL 直传为什么能卸载应用服务器, domain: performance, relatesTo: enable }
  - { text: 识别桶的安全基线：BPA、禁用 ACL、只允许 HTTPS、默认加密, domain: secure, relatesTo: inspect-bucket }
  - { text: 用版本控制与生命周期兼顾防误删与成本, domain: cost, relatesTo: inspect-bucket }
  - { text: 比较 S3 与 EBS 的耐久性与扩展方式, domain: resilient, relatesTo: after }
difficulty: beginner                   # 四级：intro（入门）| beginner（初级）| intermediate（中级）| advanced（高级）
estimatedMinutes: 60
timeLimitMinutes: 90                   # ≥ 60 × 1.5，且为 30 的整数倍
extensions: { maxCount: 2, minutesEach: 30 }
retain: { allowed: true, maxHours: 24, reason: 只有按量计费的 S3；保留后可以继续浏览相册 }
provision: { class: A }                # 起始状态 l0-ec2 + iam，只有“快”类资源（02 §11.1）
regions:
  supported: [ap-northeast-1]
  alsoUses: []
services:
  - { id: s3, name: Amazon S3, role: primary, module: storage }
  - { id: iam, name: AWS IAM（实例角色，起始状态预置）, role: context, module: iam }
  - { id: eventbridge, name: Amazon EventBridge（桶级事件投递，只开启不消费）, role: observed }
  - { id: ebs, name: Amazon EBS（对照组）, role: observed, module: ec2 }
  - { id: session-manager, name: AWS Systems Manager Session Manager（平台管理通道）, role: observed }

modules: { target: [storage], start: [iam], context: [], related: [cdn, kms, image-processing, shared-fs] }
  # 软依赖 kms、cdn 与互斥的 shared-fs（MUTEX-001）不预置，写在 related 与 saa.confusables 中

prerequisites:
  cards:
    - { id: svc-ec2, kind: soft }
    - { id: svc-iam, kind: soft }
  learnerInputs: []
  knowledge: [HTTP PUT 与 Content-Type, 浏览器开发者工具的 Network 面板]

startProfile:
  provisions:                          # 与 plan --start-of svc-storage 的输出逐项核对（04 §3.2.3）
    - { item: iam, kind: module, basis: credential, set: { IAM_CREDENTIALS: role },
        reason: '平台约定除 svc-ec2、svc-iam 外起始状态都带实例角色（C3）；storage 本身也是 credentials: required（CRED-001）。平台模式下 enable iam 走 AppRoleMode=existing，只附加只读基础策略' }
    - { item: mgmt-channel, kind: platform, reason: 实验机挂只含 AmazonSSMManagedInstanceCore 的 CloudAlbumAppRole，是平台的管理通道，不是应用权限 }
    - { item: workstation, kind: platform, reason: 每个会话一台工作台，用于运行 scripts/module、AWS CLI 与 k6 压测 }
    - { item: preview-direct-https, kind: platform, reason: 方案 B 的 Let's Encrypt IP 证书，供预览面板嵌入（03 §6.2）；本卡不涉及 tls，保持开启 }
  platform: { preview: { directHttps: 'on' } }
  reason: storage 的 requires 为空，起始状态只有 L0 与 C3 规定的实例角色（档位 atl/svc-storage/default）

targetModules:
  - { id: storage, driver: s3, wireStep: enable, adoptsExisting: false }
expectedWarnings: []

workstation: { required: true, tools: [aws-cli, node, k6, jq], savingsMode: degraded }   # CloudShell 下压测结果只供参考
platform:
  consoleLinks: [s3.buckets]           # 03 的深链接注册表 id（以 03 为准）

variables:
  rawBucket:   { label: 原图桶, from: derived, fillFrom: stack.storage.EnvStorageS3RawBucket }
  mediaBucket: { label: 展示桶, from: derived, fillFrom: stack.storage.EnvStorageS3MediaBucket }

cost:
  currency: USD
  tier: low                            # 构建期按 05 的结构算法复算，与此值不一致时构建失败
  mainDrivers: [S3 存储（含版本控制保留的旧版本）, S3 PUT / GET 请求, 流出到互联网的流量]
  basis:
    - { ref: start-profile, note: 实验机 EC2、EBS（根卷与数据卷）、公网 IPv4；iam 不计费 }
    - { ref: workstation, note: 工作台 EC2、EBS、公网 IPv4 }
    - { key: s3-storage, pricingKey: s3.standard.storage, billing: usage, quantity: 1, unit: GB-month,
        assumedUsagePerHour: 0.004, source: target, whenRetained: true, note: 约 3 GB 原图与缩略图留存，按小时折算 }
    - { key: s3-put, pricingKey: s3.requests.put, billing: usage, quantity: 1, unit: 1k-requests,
        assumedUsagePerHour: 2, source: target, whenRetained: false }
    - { key: s3-get, pricingKey: s3.requests.get, billing: usage, quantity: 1, unit: 1k-requests,
        assumedUsagePerHour: 5, source: target, whenRetained: false }
  assumptions:
    - 压测按 FILE_MB=5、10 VU × 60 秒两轮估算；浏览器直传 S3 的入站流量不收费；以官方定价为准
    - 预签名 GET 下载到浏览器与工作台的流出流量按量计费，学习规模下很小

steps:
  - id: orient
    type: observe
    title: 观察起始状态：照片写在 EC2 的数据卷上
    manual: manual/10-orient.md
    estMinutes: 5
    panel: preview
    checks:
      - storage-local-baseline          # before 断言，定义中写了 drift: once
      - { ref: data-volume-usage, required: false }

  - id: baseline
    type: experiment
    title: 记录基线（before）：上传经过 EC2
    manual: manual/20-baseline.md
    experiment: { module: storage, id: upload-burst, label: before }
    estMinutes: 8
    checks: [ exp-before ]

  - id: enable
    type: script
    wire: true
    title: 接入 S3：部署桶、迁移照片、切换驱动
    manual: manual/30-enable.md
    methods: [script]
    requires: { steps: [baseline] }
    estMinutes: 12
    startsBilling: { class: usage, pricingKeys: [s3.standard.storage, s3.requests.put, s3.requests.get], note: 按量计费 }
    wait: { typicalMinutes: 3, maxMinutes: 15, text: 部署两个桶、只读窗口内迁移已有照片、重启并跑深度探针 }
    checks:
      - storage-wired
      - media-url-s3
      - upload-presign-seen

  - id: inspect-bucket
    type: console
    title: 检查原图桶的安全与成本配置
    manual: manual/40-inspect-bucket.md
    methods: [console, cli]
    requires: { steps: [enable] }
    estMinutes: 10
    checks:
      - bucket-bpa
      - bucket-versioning
      - bucket-encryption
      - bucket-notification-eventbridge-only

  - id: observe-direct-upload
    type: observe
    title: 亲眼看到浏览器直传 S3
    manual: manual/50-observe-direct-upload.md
    requires: { steps: [enable] }
    estMinutes: 8
    panel: preview
    checks:
      - put-target-answer
      - { ref: lab-net-bytes, required: false }

  - id: after
    type: experiment
    title: 记录 after：同一压测，上传不再经过 EC2
    manual: manual/60-after.md
    experiment: { module: storage, id: upload-burst, label: after }
    requires: { steps: [enable] }
    estMinutes: 8
    checks: [ exp-pair ]

  - id: sidebyside
    type: experiment
    title: （选做）同部署侧路对比：local 与 s3 交替上传
    manual: manual/70-sidebyside.md
    optional: { reason: 与 before/after 结论方向一致，只看数量级 }
    experiment: { module: storage, id: upload-sidebyside, label: after }
    requires: { steps: [enable] }
    estMinutes: 8
    checks: [ { ref: exp-sidebyside, required: false } ]

  - id: ebs-growth
    type: experiment
    title: （选做）数据卷写满：上传不受影响，评论仍会失败
    manual: manual/80-ebs-growth.md
    optional: { reason: 会临时占满数据卷，结束时自动释放 }
    experiment: { module: storage, id: ebs-growth, label: after }
    requires: { steps: [enable] }
    estMinutes: 8
    checks:
      - { ref: exp-ebs-growth, required: false }
      - { ref: balloon-released, drift: { policy: must-hold } }

finalChecks:
  - no-world-ssh                        # labs/_shared/checks：安全组没有对 0.0.0.0/0 开放 22
  - { ref: storage-wired, as: final-storage-wired }
  - { ref: bucket-bpa, as: final-bucket-bpa }

experiments:
  - module: storage
    id: upload-burst
    labels:
      - { id: before, role: baseline, requires: { storage: local } }
      - { id: after,  role: treatment, requires: { storage: s3 } }
    pairs: [[before, after]]
    required: true
    runner: workstation
    allowSimulatedBaseline: false
    corroboration: { minServerRatio: 0.9 }
  - { module: storage, id: upload-sidebyside, labels: [after], required: false, runner: workstation }   # 只有 treatment，不成对
  - { module: storage, id: ebs-growth, labels: [after], required: false, runner: workstation }

quiz: { file: quiz.yaml, draw: 3 }      # 成绩只记录在徽章上，不影响完成（C3）
badge: { title: S3 直传, icon: assets/badge.svg }   # 完成即授予
tracks: [saa-main, performant, cost-optimized, quick-compare, serverless]   # 以 _tracks/ 的实际包含关系为准，labs:fix 自动改写

certificate: { enabled: false }        # 卡片不单独发证书

cleanup:
  summary: 结束实验后，平台会清空并删除本次会话创建的两个桶（含全部版本）与策略。不需要先 disable storage。
  autoReclaim: true
  dataRisk:
    - 上传到桶里的照片会被删除；版本控制保留的旧版本也会一起删除
    - 实验机与其上的数据卷随会话删除，报告中只保留证据摘要
  learnerCreatedHints: []
  verify:
    - buckets-gone

saa:
  domains: [performance, resilient, secure, cost]
  topics:
    - { id: presigned-url, title: 预签名 URL 直传卸载应用服务器, domain: performance, relatesTo: enable }
    - { id: bucket-baseline, title: BPA、BucketOwnerEnforced、SecureTransport、默认加密, domain: secure, relatesTo: inspect-bucket }
    - { id: lifecycle, title: 版本控制、生命周期与存储类别的最短天数和最小尺寸, domain: cost, relatesTo: inspect-bucket }
    - { id: durability, title: S3 跨多 AZ 与 EBS 单 AZ 的耐久性差别, domain: resilient, relatesTo: after }
  confusables:
    - { a: S3 事件通知, b: S3 → EventBridge, rule: 同一事件类型的重叠前缀不能配置多个通知目标；EventBridge 可以多个规则各自消费 }
    - { a: 网关型终端节点, b: 接口型终端节点, rule: S3 与 DynamoDB 的网关型不按小时计费；接口型按小时计费、可从本地网络访问 }

tags: [storage, s3, presigned-url, performance, beginner]

permissions:
  learner:                             # IAM 动作名（服务授权参考），lint 按“身份策略 ∩ 边界 − 护栏”求有效权限
    - cloudformation:CreateChangeSet          # scripts/module（栈名限定为 cloudalbum-*，见 01 的权限边界）
    - cloudformation:DescribeChangeSet
    - cloudformation:ExecuteChangeSet
    - cloudformation:DescribeStacks
    - cloudformation:DescribeStackEvents
    - s3:CreateBucket                         # 经 CloudFormation 以调用者身份创建
    - s3:PutBucketVersioning
    - s3:PutLifecycleConfiguration
    - s3:PutBucketPolicy
    - s3:PutBucketCORS
    - s3:PutBucketNotification
    - s3:PutBucketPublicAccessBlock
    - s3:PutBucketOwnershipControls
    - s3:PutEncryptionConfiguration
    - s3:PutBucketTagging
    - s3:GetBucketPublicAccessBlock
    - s3:GetBucketVersioning
    - s3:GetEncryptionConfiguration
    - s3:GetBucketNotification
    - s3:GetLifecycleConfiguration
    - s3:ListBucket
    - iam:CreatePolicy                        # 模块栈的客户托管策略
    - iam:AttachRolePolicy                    # scripts/module 附加到 CloudAlbumAppRole（带 ATLWorkloadBoundary）
    - ssm:SendCommand                         # 平台模式的投递通道
    - ssm:GetCommandInvocation
  notes: 平台模式下 scripts/module 给栈打 atl:component=env、atl:session-id、atl:lab-id、atl:env-id 标签（C4(d)），state.json 在 cloudalbum-lab-state 桶、锁在 cloudalbum-lab-locks 表（C4(c)）

owners: [cloudalbum-maintainers]
```

**本卡专属检查（节选）**——`labs/svc-storage/checks/storage.yaml`：

```yaml
checks:
  - id: storage-local-baseline
    title: 起始状态：照片由 EC2 本地磁盘提供
    type: capability
    module: storage
    drift: { policy: once }
    assert:
      - { path: $.driver, op: eq, value: local, label: 驱动 }
      - { path: $.status, op: eq, value: 'off', label: 模块状态 }
      - { path: $.localHealth, op: eq, value: ok, label: 本地实现健康 }
    explain: 起始状态中 storage 尚未启用，上传字节写在 /var/lib/cloudalbum/uploads。

  - id: storage-wired
    title: storage 已切换到 S3 并通过探针
    type: capability
    module: storage
    drift: { policy: must-hold, monitor: true }
    assert:
      - { path: $.driver, op: eq, value: s3, label: 驱动 }
      - { path: $, op: healthy, label: 状态正常（本卡 expectedWarnings 为空，即必须是 ok） }
    reproduce: { run: 'curl -s http://127.0.0.1/api/capabilities | jq ".modules.storage"', runsOn: lab }

  - id: media-url-s3
    title: 应用签发的媒体 URL 指向本会话的 S3 桶
    type: http-header
    from: lab
    target: self
    path: /api/lab/probe/media-url
    dependsOn: [storage-wired]
    drift: { policy: must-hold }
    assert:
      - { path: $.json.url, op: matches, value: '^https://({{ var.rawBucket }}|{{ var.mediaBucket }})\.s3\.{{ session.region }}\.amazonaws\.com/', label: 媒体 URL 的主机 }
      - { path: $.json.url, op: contains, value: X-Amz-Signature, label: 预签名 }
      - { path: $.pathSegments.storage, op: startsWith, value: s3, label: 路径段 storage }
    explain: 由实验机本地请求探测端点（引擎自动附带本机令牌 X-ATL-Probe-Token，06），不依赖浏览器；URL 的主机必须是 CloudFormation 输出中的桶名。
    reproduce: { run: 'curl -s -o /dev/null -D - "http://127.0.0.1/media/variants/<照片 ID>/thumb_200.webp" | grep -iE "^(location|x-cloudalbum-path):"', runsOn: lab }   # 公开的衍生图：302 到预签名 S3 地址，路径段 storage=s3:redirect

  - id: upload-presign-seen
    title: 最近的真实上传请求走了 S3 预签名
    type: local
    on: lab
    checkId: path-seen                  # 04 §6.4 已收录（第 2 轮）
    args: { window: 15m, segment: storage, pattern: 's3:presign', excludeProbe: true, minCount: 1 }
    dependsOn: [storage-wired]
    drift: { policy: once }
    assert:
      - { path: $.count, op: gte, value: 1, label: 出现次数 }
    explain: 在应用预览中上传任意一张照片即可满足；探测请求不计入。

  - id: bucket-bpa
    title: 原图桶的四项 Block Public Access 全部开启
    type: aws-readonly
    service: s3
    action: GetPublicAccessBlock        # SDK 操作名（04 §5.7 第 2 轮统一）；labs:policy 映射为 IAM 动作 s3:GetBucketPublicAccessBlock
    region: app
    params: { Bucket: '{{ var.rawBucket }}' }
    ownership: { resource: 'arn:aws:s3:::{{ var.rawBucket }}', mode: session, createdAfter: session.readyAt }
    drift: { policy: must-hold, monitor: true }
    assert:
      - { path: $.PublicAccessBlockConfiguration.BlockPublicAcls, op: eq, value: true }
      - { path: $.PublicAccessBlockConfiguration.IgnorePublicAcls, op: eq, value: true }
      - { path: $.PublicAccessBlockConfiguration.BlockPublicPolicy, op: eq, value: true }
      - { path: $.PublicAccessBlockConfiguration.RestrictPublicBuckets, op: eq, value: true }
    reproduce: { run: 'aws s3api get-public-access-block --bucket {{ var.rawBucket }}', runsOn: workstation }
    manualFallback:
      where: { breadcrumb: [S3, '{{ var.rawBucket }}', 权限, 阻止公有访问], region: app }
      observed:
        question: “阻止所有公有访问”显示什么？
        options:
          - { value: on, label: 开启, expected: true }
          - { value: off, label: 关闭, fixHint: 不要在控制台修改栈管理的配置；重新执行 scripts/module enable storage }

  - id: bucket-notification-eventbridge-only
    title: 原图桶只开启了 EventBridge 投递（MUTEX-004）
    type: aws-readonly
    service: s3
    action: GetBucketNotificationConfiguration   # SDK 操作名；IAM 动作为 s3:GetBucketNotification
    region: app
    params: { Bucket: '{{ var.rawBucket }}' }
    ownership: { resource: 'arn:aws:s3:::{{ var.rawBucket }}', mode: session }
    drift: { policy: must-hold }
    assert:
      - { path: $.EventBridgeConfiguration, op: exists, label: EventBridge 投递 }
      - { path: $.LambdaFunctionConfigurations, op: absent, label: 没有 Lambda 目标 }
      - { path: $.QueueConfigurations, op: absent, label: 没有 SQS 目标 }
      - { path: $.TopicConfigurations, op: absent, label: 没有 SNS 目标 }
    reproduce: { run: 'aws s3api get-bucket-notification-configuration --bucket {{ var.rawBucket }}', runsOn: workstation }
    manualFallback:
      where: { breadcrumb: [S3, '{{ var.rawBucket }}', 属性, 事件通知], region: app }
      observed:
        question: “Amazon EventBridge”一栏显示什么？
        options:
          - { value: on, label: 开启, expected: true }
          - { value: off, label: 关闭 }

  - id: exp-pair
    title: upload-burst 的 before 与 after 都有效
    type: experiment
    module: storage
    experiment: upload-burst
    pair: [before, after]               # 04 §5.1：label 与 pair 二选一
    accept: [valid]
```

`exp-before`、`data-volume-usage`（`disk-usage`）、`bucket-versioning`、`bucket-encryption`、`put-target-answer`（manual）、`lab-net-bytes`（`net-bytes`）、`exp-sidebyside`、`exp-ebs-growth`、`balloon-released`（`disk-usage` 回到基线）、`buckets-gone`（`s3:GetBucketLocation` 期望 `NoSuchBucket`）写在同一目录，此处从略。小测题目即本卡“小测”一节，写入 `quiz.yaml`。

---

## 附录 B：卡片相对 04 lab.yaml 格式的扩展

第 2 轮在这里列出了本批在第 1 批 v2 写法之上还需要的扩展。按裁决 C2，04 已把 `lab.yaml` 升级为以卡片为单位的 `atl.lab/v2`（04 §3），这些扩展**已全部并入**，本附录只保留对照，便于核对第 2 轮的写法：

| 第 2 轮提案 | 04 v2 的落地写法 | 状态 |
|---|---|---|
| `startProfile.localSettings: { <模块>.<KEY>: 值 }`，lint 第 4 条据此放行 | `startProfile.provisions[]` 的 `kind: local` 条目（`set` 写本地档取值）；目标模块以本地档出现在起始状态时写 `targetModules[].fromDriver`，DRV-5 取代 v1 lint 第 4 条 | **已由 C2 解决** |
| `experiments[].labels` 允许任意变体，`pairs` | `labels: [{id, role: baseline \| treatment \| single}]`、`pairs`、`requiredLabels`；运行器 `--label <变体>`，结果标注 `variant` | **已由 C5 解决**（04 §3.2.10） |
| aws-readonly 的 `region: dr` | `region: dr-region`，卡片须声明 `regions.extra: [dr-region]`；未配置时 `skipped/PRECONDITION` | **已由 C2 解决**（04 §5.1、§5.2.4） |
| 表达式命名空间 `platform.drRegion` | `platform.drRegion`（未配置时为空串），可用于 `when` | **已由 C2 解决**（04 §4.4） |
| `keepablePrerequisites` 用于 SES 发件身份 | 字段保留（04 §3.2.15）；与模块栈创建身份的冲突仍未解决 | 未解决（附录 C-12） |
| 第 1 批写法 `modules[{id, role}]`、`badge{id, requires}`、`quiz.requiredForBadge` | `modules{target, start, context, related}`、`badge{title, short?, icon?}`、`quiz{file, draw}` | **已由 C2、C3 解决**（附录 A 已按 04 v2 重写） |

---

## 附录 C：本批发现的设计问题

第 3 轮在每条“问题”开头标注处理状态：“已由 C# 解决”表示被主设计者本轮裁决（C1～C5）解决，正文已按裁决改写；其余为部分解决或未解决。C-18～C-20 为第 3 轮新增。

| # | 问题 | 影响的卡片 | 建议 |
|---|---|---|---|
| C-1 | **已由 C3 解决**：除 `svc-ec2`、`svc-iam` 外一律预置 iam(role)，本批 5 张卡片已改写，不再出现 CRED-004；纯基础设施型模块的 wire 证据按 04 §3.5 第 3 条用 `module-state` + 带 `ownership` 的 `aws-readonly`。原问题：**严格闭包与 CRED-004 的冲突**：`credentials: optional` 的模块按“硬依赖闭包”（总纲 §10.4 gen-single 规则 2）不并入 iam，但 CRED-004（warn）会把模块置为 `degraded` 并关闭深度探针；04 §11 的 Lab 5 示例与 05 §4.1 S2 则把 iam 放进起始状态以避免 degraded，两种做法并存（第 1 批附录 B-4 同样提出）。对纯基础设施型的 backup 影响更大：ui-design §4.5 要求这类模块的 wire 检查 `confidence ∈ {confirmed, observed}`，04 lint 第 3 条要求 wire 步骤有 `http-header` 或 `local` 路径检查，而无凭证时 backup 的感知器只能是 `inferred`、也没有路径段，svc-backup 的 wire 步骤只能用 `aws-readonly`（恢复点）作为实际生效证据 | shared-fs、database、cache、backup、social-api | 二选一并写入 05 / 卡片总约定：要么在平台模式下 CRED-004 不改变 `status`（只降 `confidence`），要么允许起始状态带“体验性 iam”并标注不是硬依赖。无论哪种，04 lint 第 3 条都应允许“`aws-readonly` + `ownership` 的控制面证据”作为纯基础设施型模块 wire 步骤的实际生效证据（它比感知器的 `observed` 更难伪造） |
| C-2 | **已由 C2 解决**：`kind: local` 的 provisions 与 `targetModules[].fromDriver`（04 §3.2.3、§3.2.4）。原问题：**lint 规则 4“目标模块不得出现在起始状态中”**没有区分本地档：svc-queue 需要 `QUEUE_DRIVER=memory`（DEP-004 + 实验前置），svc-scheduler 需要 `SCHEDULER_COMPARE_HEARTBEAT=on`。05 §4.1 S3/S4 与 05 §7.4 C-5 已允许“目标模块的本地档”，但 04 的 lint 文字未改 | queue、scheduler | 规则改为“目标模块的 `ownedValues` 不得出现在起始状态”；startProfile 增加 `localSettings`（附录 B） |
| C-3 | **已由 C2、C5 解决**：`path-seen` 已列入 04 §6.4，`systemd-unit` 白名单含 `cloudalbum-api@<端口>`、`cloudalbum-worker-<n>`；`app-stat` 的统计名由 06 登记。原问题：**ATL-RunCheck 检查目录缺项**：没有 `path-seen`（ui-design 的检查表已定义，用它判定 POST / 异步路径段），本批 8 张卡片（storage、social-store、analytics、image-processing、queue、notification、email、tagging）的 wire 检查依赖它；`systemd-unit` 白名单缺 `cloudalbum-api@3001`、`cloudalbum-worker-2`；`app-stat` 需要登记 `photos.count`、`click_events.count`、`job_runs.heartbeat.cron`、`job_runs.trigger.eventbridge` 等统计名 | storage、social-store、analytics、image-processing、queue、notification、email、tagging、scheduler、cache | 在 04 §6.4 增加 `path-seen`，参数与 ui-design 一致（`segment`、`pattern`、`window` ≤ 24h、`minCount`、`distinct?`、`excludeProbe` 固定为 true；第 1 轮本条写的 `valuePrefix`、`excludeProbes` 作废），并扩充两个白名单 |
| C-4 | **已由 C5 解决**：实验标签接受任意变体，结果标注 `variant`（04 §3.2.10）；svc-cache 的 `memory`、svc-queue 的 `l0` 已按此声明。原问题：**实验标签只允许 before / after**：cache 的四档（none / memory / selfhost / ElastiCache）、queue 的 `l0` 参照、database 的 `selfhost`、social-api 的 `proxy` 无法记录为有效实验 | cache、queue、database、image-processing | 见附录 B 的 `labels` / `pairs` 扩展；在此之前卡片只把 before / after 作为必需实验 |
| C-5 | **已由 C2 解决**：`region: dr-region`、`platform.drRegion` 与 04 §5.7 第 2 轮新增的只读操作（athena、glue、`DescribeAccessPoints`、`DescribeImages`/`DescribeSnapshots`、`ListMessageMoveTasks`）均已收录，svc-backup、svc-analytics、svc-shared-fs、svc-queue 的相应检查已从 manual 改为 aws-readonly。原问题：**aws-readonly 的限制**：`region` 只有 `app \| us-east-1 \| global`，读不到灾备区域的备份副本；白名单缺 `athena:GetWorkGroup` / `GetQueryExecution`、`glue:GetTable`、`elasticfilesystem:DescribeAccessPoints`、`ec2:DescribeImages` / `DescribeSnapshots`、`sqs:ListMessageMoveTasks`；表达式命名空间没有 `platform.drRegion` | backup、analytics、shared-fs、queue | `region` 增加 `dr`（取平台安装参数 `DrRegion`）；`platform.*` 增加 `drRegion`；按需补白名单（均为只读、不按次计费） |
| C-6 | **不属于本轮裁决，但 01 第 2 轮正在处理**：01 的修订稿把灾备区域语句改为 `DrRegionLimited`（放行 `cloudformation:*` 并以护栏收窄到 `cloudalbum-*` 栈、放行卷恢复与删除），并新增护栏拒绝 compliance 模式的 Vault Lock；以 01 定稿为准，定稿前 svc-backup 只能以 `DrRegion` 为空的形态完成。原问题：**灾备区域被权限边界挡住（阻塞）**：① 01 §6.5 的 `DrRegionBackupOnly` 在灾备区域对 `NotAction` 之外的一切操作 Deny，而 `NotAction` 不含 `cloudformation:*`；`ATLProvisionerBoundary` 的区域限制与学员边界相同，`ATLWorkloadBoundary` 也一样。所以 backup 模块的 `backup-dr` 栈（`stacks[].region: param:DrRegion`）无论由学员在工作台、还是由 `atl-runner` 部署都会被拒绝，回收器也删不掉它——**svc-backup 第 3 步与 05 的 lab-24 在 `DrRegion` 非空时都无法完成**。② 同一语句拒绝 `ec2:CreateVolume` / `DeleteVolume`，模块文档 backup 第 5 节第 4 步（在灾备区域恢复 EBS 卷）无法执行，回收也删不掉恢复出的卷。③ Vault Lock 的 compliance 模式一旦过了宽限期不可撤销，会让回收永久失败 | backup（及 `sc-backup-dr`、05 lab-24） | ① 在三条边界的 `DrRegionBackupOnly` 中放行 `cloudformation:*`（护栏中再按 `arn:aws:cloudformation:<DrRegion>:*:stack/cloudalbum-*-backup-dr/*` 收窄），或让 backup 模块在平台模式下改用 `backup:CreateBackupVault` 直接建灾备库（`backup:*` 已放行）、不用 CloudFormation；② 灾备区域放行“带会话标签的卷”的创建与删除，或在模块文档中把灾备区域恢复改为选读；③ 在 `ATLLearnerGuardrails` 中拒绝带 `ChangeableForDays`（即 compliance 模式）的 `PutBackupVaultLockConfiguration`（条件键以官方文档为准） |
| C-7 | **未解决**（scheduler 栈的卡片用参数需回写 04#scheduler 与总纲 §8.2）。原问题：**实验时长超出卡片**：scheduler 的 `heartbeat` 基线与 after 各 60 分钟、`dlq-fault` 等待 `MaximumEventAgeInSeconds`（默认 1 小时）；DynamoDB TTL 物理删除需要数天；database 的故障转移基线要求停止 / 启动实验机；`cold-start` 需要闲置 15 分钟 | scheduler、social-store、database、image-processing | 卡片已缩短或改为选做；建议 scheduler 栈增加卡片用参数（`LabHeartbeatExpression=rate(1 minute)`、较小的 `MaximumEventAgeInSeconds`），但要同步 `scheduler export` 以免被判为漂移 |
| C-8 | **未解决**（平台模式默认 `ResultChannel=queue` 需回写 04#image-processing；本卡已显式指定）。原问题：**image-processing 的默认回写通道**在 L0 是 `callback`（`http://<EIP>`），DEP-021 使模块 `degraded`，且依赖实验机对公网开放 80 | image-processing | 平台模式下 `enable image-processing` 默认 `ResultChannel=queue`（本卡已显式指定） |
| C-9 | **未解决**，且第 3 轮新增一项：起始状态带 iam 后 shared-fs 采用 `IamAuth=true`，`second-instance.yaml` 的挂载命令必须带 `tls,iam` 选项。原问题：**shared-fs 的第二台实例**：`second-instance.yaml` 需要支持“文件系统参数为空”（先做 before）、接收 `SubnetId`（必须是第二个挂载目标所在 AZ 的子网，否则 B 落在没有挂载目标的 AZ 时挂载失败，或跨 AZ 挂载产生数据传输费）、使用 `CloudAlbumAppRole` 实例配置文件（否则实验运行器无法经 SSM 在 B 上执行 `stat`）、带会话标签；文件系统参数从空改为有值时，单纯更新 User Data 不会让已运行的 B 去挂载（User Data 只在首次启动执行），模板要用 `cfn-init` / SSM 命令挂载或替换实例；`enable shared-fs --dry-run` 需要打印计划使用的两个子网；B 没有 `atl:role=lab-app`，`local` 检查无法在它上面执行 | shared-fs | 更新实验模板与 `--dry-run` 输出；B 上的事实改用 `aws-readonly`（`ssm:DescribeInstanceInformation`）与实验结果佐证 |
| C-10 | **未解决**（实验清单的平台模式默认值需回写 03#storage）。原问题：**storage 压测参数会逼近数据卷阈值**：默认 `FILE_MB=20`、120 秒的 before 轮把原图写进 20 GiB 数据卷，可能触发 507、污染后续步骤 | storage | 实验清单为平台模式提供较小的默认值（本卡用 `FILE_MB=5`、60 秒） |
| C-11 | **未解决**（需回写 04#image-processing 第 5 节）。原问题：**image-processing 的限流实验预期与 AWS 行为不符**：04#image-processing 第 5 节第 7 步写“预留并发设为 0 → 恢复后事件被异步队列重试、照片陆续 READY”。Lambda 文档在 `AsyncEventsDropped` 指标说明中把“reserved concurrency set to 0”列为事件被丢弃的原因之一（配置了 DLQ / 失败目标时先送往那里）——预留并发为 0 时异步事件不会等到恢复，而是进入失败队列，照片会被 worker 标为 FAILED | image-processing（及 `sc-image-pipeline`） | 模块文档改写预期：`reserved=0` 演示“紧急刹车”（`Throttles`、`AsyncEventsDropped`、失败队列）；“限流后排队消化”改用 buffer-queue 变体的 `MaxConcurrency`。本卡第 6 步已按此改写 |
| C-12 | **未解决**。原问题：**SES 发件身份的前置与保留**：① 02 §3.5 的账号预检把“SES 发件身份”列为 FAIL 级人工前置，而 email 模块与本卡是在实验中由栈创建身份、学员点击验证邮件，开始前账号里本来就没有身份；② email 栈用 `AWS::SES::EmailIdentity` 创建身份，学员按 `keepablePrerequisites` 保留身份后，下次 `enable email` 会因同名身份已存在而失败；③ 身份可跨会话保留，wire 检查不能对它要求 `ownership: session` | email（及 `sc-event-fanout`、05 lab-09） | 02 预检对 `ses-identity` 只检查“学员已填写邮箱输入”，不检查身份是否存在；email 模块增加“接管已有身份”的参数（如 `ExistingIdentity=true` 时不建身份资源），或保留身份时由平台从栈中移除（`DeletionPolicy: Retain` + 下次导入）；本卡的身份检查已去掉 `ownership` |
| C-13 | **未解决**。原问题：**scheduler 的 second-worker 实验与幂等键矛盾**：04#scheduler 规定 `job_runs` 在 `(name, scheduled_at)` 上有唯一索引，重复插入记为 `skipped-duplicate`；两个 worker 共用同一个 SQLite 时，cron 档的第二次触发同样会被唯一索引拦住，与“singleton 任务在同一时刻出现两行（ASG-006 的情形）”的预期矛盾——结果取决于 cron 驱动的 `scheduledAt` 是取计划时刻（会被拦住）还是实际触发时间（不会） | scheduler | 模块文档明确 cron 驱动的 `scheduledAt` 取值与 ASG-006 演示的判据（例如统计 handler 实际执行次数而不是 `job_runs` 行数） |
| C-14 | **已由 C1 解决**：04 §5.7 第 2 轮统一为 SDK 操作名 + 映射表，本批检查已改用 SDK 操作名。原问题：**04 §5.7 白名单的 S3 动作名混用**：S3 一行写的是 IAM 动作名（`GetBucketPublicAccessBlock`、`GetBucketNotification`、`GetEncryptionConfiguration`），而 §5.1 说 `action` 是 SDK 操作名（对应 `GetPublicAccessBlock`、`GetBucketNotificationConfiguration`、`GetBucketEncryption`）。不统一时，同一个检查要么过不了 lint 白名单，要么 `atl-checks` 找不到 SDK 命令 | storage（及所有读 S3 配置的卡片） | 白名单统一写 SDK 操作名，并由 `labs:policy` 映射到 IAM 动作生成策略；本批暂按白名单写法书写 |
| C-15 | **部分已由 C5 解决**：探测端点统一为 `/api/lab/probe/*`，端点清单与各端点经过的端口由 06 规定；仍需 06 明确 `probe/now` 会经过 DatabasePort 与 CachePort。原问题：**`/api/lab/probe/now` 是否经过 database、cache 端口**：ui-design §4.5 用它判定 cache 的 `redis@elasticache:hit`，本批 database、cache 的 wire 检查也用它；但该端点只返回 `{now, nonce}`，路径头只包含“本次请求实际调用过的端口”（总纲 §7.2） | database、cache | CloudAlbum 侧明确 `probe/now` 会执行一次 `select now()` 并经 CachePort 读写探测键；否则改为带探测令牌请求白名单 GET 路由（如时间线） |
| C-16 | **已由 C1、C3 解决**：徽章只看完成；延长次数统一为 2 次（02 平台默认）；共享检查名统一为 `no-world-ssh`（04 §2.2）。原问题：**与第 1 批的不一致**：① 徽章条件——第 1 批要求“完成 + 小测 ≥ 70”，本批只要求完成（用户要求为“完成单张卡片获得徽章”，04 也规定小测不影响完成状态）；② 可延长次数——第 1 批对费用档位“高”的卡片只给 1 次，本批与 05 §4.2 一致都给 2 次；③ 共享检查名——第 1 批写 `lab-no-world-ssh`，04 与本批写 `no-world-ssh` | 两批全部卡片 | 在卡片目录总约定中统一（建议徽章只看完成、延长次数沿用 05、共享检查名沿用 04） |
| C-17 | **未解决**，并且与 04 的 lint 冲突，见 C-19。原问题：**单机多进程时 ASG-004 是否检查**：总纲 §5.2 说 `LB_LOCAL_WORKERS=2` 时 ASG-004 的 memory 分支以 warn 级别检查（warn 会把相关模块置为 `degraded`），03#cache 说“按 01 的约定这里不设校验规则，只显示黄色提示，`localHealth` 保持 ok” | cache | 二者统一；在统一前 svc-cache 第 3 步不对 `status` 作判定 |
| C-18 | （第 3 轮新增）**没有规则 ID 的 `degraded` 与 `op: healthy` 不兼容**：04 §5.3 的 `healthy` 只接受“由预期警告规则导致的 `degraded`”，而 notification 在订阅待确认时、email 在 SES 沙盒中、kms 在重新加密进行中都是 `degraded` 却没有规则 ID。这些状态在卡片里属于正常过程或预期终态 | notification、email（及第 1 批 svc-kms） | 卡片已分别改用 `pendingIf`（待确认、迁移中）与 `anyOf` + detail 断言（沙盒）。建议总纲把“SES 沙盒”“订阅待确认”登记为 warn 级规则 ID（例如在 §5.2 新编号），这样它们可以进 `expectedWarnings`，不必依赖 detail 文案；或由 04 为 capability 断言增加 `expectedConditions`（按探针给出的稳定原因码放行） |
| C-19 | （第 3 轮新增）**ASG-004 的单机多进程分支不能进 `expectedWarnings`**：总纲 §5.2 说 `LB_LOCAL_WORKERS=2` 时 ASG-004 的 memory 分支以 warn 级别检查，但 ASG-004 在规则表中是 `error` 级，04 §3.2.5 的 lint 规定 `expectedWarnings` 只能列 warn 级规则 | cache | svc-cache 第 3 步只能继续“不对 `status` 判定”；建议总纲给单机多进程的情形单独编一个 warn 级规则 ID（或把 C-17 的结论定为“不设规则”），再决定是否写进 `expectedWarnings` |
| C-20 | （第 3 轮新增）**卡片内手建资源的归属依赖定向扫描**：svc-shared-fs 的 `exp-peer` 栈、svc-database 的 PITR 实例、svc-backup 的演练实例与 AMI 都是学员会话直接创建的，检查与回收都依赖 02 的台账或定向扫描 `OwnershipLookup`（C4(e)）；扫描有分钟级延迟，且受 `LookupEvents` 速率限制 | shared-fs、database、backup | 检查已写 `ownership: session` 并接受 `OWNERSHIP_PENDING` 的等待（默认 20 分钟）；实测延迟与速率列入 07 的验证计划；临时实例不得带 `atl:role=lab-app`（04 §5.2.1） |

---

## 审稿修订记录

### 2026-10-13 · 第 2 轮（对抗式审稿）

审稿依据：modular-design §3.2 / §3.4 / §5.2 / §10.4，03、04 模块文档，平台 01～05，第 1 批卡片的附录 A.1，以及 AWS 官方文档（Lambda 异步调用与 `AsyncEventsDropped`、DynamoDB 容量模式切换、ElastiCache Serverless 的多 AZ 复制）。起始状态的闭包逐项核对后**全部成立**：required 的 9 个模块只并入 iam(role)，image-processing 按 DEP-003 再加 storage(s3)（storage 自身只需 iam），optional 的 5 个模块不并入 iam（gen-single 规则 2）；queue / scheduler / cache 的本地档取值都有规则或实验前置作依据；没有多余项。下列问题已在正文修正：

**高**

1. **svc-backup 的灾备栈部署被边界拒绝**：01 §6.5 `DrRegionBackupOnly` 在灾备区域拒绝 `cloudformation:*`（Provisioner 边界同样），第 3 步 `enable backup` 部署 `backup-dr` 栈必然失败。元数据、总表、第 3 步与“取舍”中标为阻塞项，附录 C-6 补充修复建议；`DrRegion` 改为平台占位符 `${atl:drRegion}`，人工前置补“平台已配置灾备区域”，跨区域检查加 `when: platform.drRegion != ''`。
2. **工作台所在 VPC 写错**：工作台与实验机同在默认 VPC 公有子网（03 §4.4），不是独立的 `atl-ws` VPC。改写 §1.2、svc-storage 实验资源、svc-database 第 4 步与 svc-cache 第 5 步的预期理由：连不上 RDS / ElastiCache 是因为安全组链，不是 VPC 边界。
3. **svc-image-processing 第 6 步的预期与 AWS 行为相反**：预留并发为 0 时异步事件被丢弃并送往失败目标（Lambda `AsyncEventsDropped` 文档），不会在恢复后补跑。改写观察点，“限流后排队消化”改指 buffer-queue 变体；附录 C-11。
4. **实验结果不会上传**：多处步骤直接调用 `npx tsx …`、`bash …sh`、`k6 run …`，却用 `experiment` 检查判定；04 §7.1 只有 `npm run exp … --upload` 会登记 runId 并上传。§1.3 增加改写规则，social-store、image-processing、notification、email、scheduler、tagging、social-api 的相关步骤改为 `npm run exp -- <module> --scenario <id> --upload`。
5. **svc-shared-fs 的实例 B**：B 必须放在第二个挂载目标所在的 AZ（东京有 3 个 AZ，挂载目标只有 2 个），否则挂载失败；原费用说明“B 跨 AZ 挂载产生传输费”随之改正；更新 B 的栈参数不会让已运行的实例重新执行 User Data，改为替换或 `cfn-init` / SSM 挂载；第 5 步检查改为同时覆盖两台实例的 AZ；清理时机顺延到选做第 8 步之后。附录 C-9 同步。

**中**

6. **难度不符合 05 §2.7.1**：入门只适用于不启用 AWS 模块的卡片，storage、notification、tagging 改为初级；database（Multi-AZ + 故障转移）改为高级；analytics（Firehose + S3 + Glue + Athena）改为中级，均与 05 中对应的 lab 一致。新增 §1.5 写明判定标准。
7. **时间上限不是 30 分钟的整数倍**（05 §2.7.2）：notification 45 / 75 → 60 / 90（同时计入 4 封确认邮件的等待），tagging 45 / 75 → 45 / 90。
8. **费用档位的定义与 05 §2.7.3 不一致**：§1.4 改为按“额外按小时计费单位”判定；social-store、image-processing 追加“（选做 → 中）”；shared-fs、backup 的“中”改为由临时实例构成的 1 个单位。
9. **lab.yaml 字段与第 1 批及 04 不一致**：入门档写成 `difficulty: foundational`，与 05 §2.7.1 和第 1 批约定的 `intro` 不一致（storage 改为初级后取 `beginner`）；缺 04 §3.1 的必填字段 `provision`；`modules`、`prerequisites`、`badge` 的结构与第 1 批 A.1 不同。附录 A 改为 `atl.lab/v2` 写法，附录 B 改为只列本批在 v2 之上的增量。
10. **`path-seen` 参数名**与 ui-design 定义不一致（`valuePrefix`、`excludeProbes` → `pattern`、`excludeProbe`）；附录 A 与 C-3 同步。
11. **aws-readonly 的 S3 动作名**：附录 A 的 `GetPublicAccessBlock`、`GetBucketNotificationConfiguration` 不在 04 §5.7 白名单内，改为白名单写法并在附录 C-14 记录命名混用。
12. **svc-backup 的 wire 判定**：纯基础设施型模块无凭证时 `confidence=inferred`，不满足 ui-design §4.5；改为不对 `confidence` 判定，以恢复点的 `aws-readonly` 作为实际生效证据，附录 C-1 补充对 04 lint 第 3 条的要求。Vault Lock 的结束条件收紧为 `Locked=false`，并改用栈参数移除锁，避免漂移与回收失败。
13. **svc-email**：发件身份可跨会话保留，去掉 `ownership: session`；补充 DMARC `p=reject` 邮箱的风险提示、`keepablePrerequisites`，以及 02 预检与“保留后再部署”冲突（附录 C-12）。
14. **svc-database 第 6 步**：故障转移前后 AZ 比较改用 04 §5.3 的 `{{$check.<id>.…}}` 引用，并为第 4 步检查指定 id；PITR 与只读副本补充耗时说明。
15. **svc-scheduler**：`ListSchedules` 计数排除健康探针的一次性调度；second-worker 的预期与 `(name, scheduled_at)` 唯一索引矛盾，记入附录 C-13。

**低**

16. 小测：svc-storage 第 2 题 B 选项限定为原图前缀并补充“转 Standard-IA 至少 30 天”；svc-cache 第 2 题限定“节点式集群”（ElastiCache Serverless 也做多 AZ 复制）。
17. svc-social-store 的计费模式切换写明当前配额（按需 → 预置随时、预置 → 按需 24 小时内最多 4 次，以官方文档为准）。
18. svc-cache 第 3 步不再对 `status` 判定（ASG-004 在单机多进程下是否检查，总纲与 03 未统一，附录 C-17）；第 5 步工作台没有 Redis 客户端，改用 `/dev/tcp` 测 TCP。
19. svc-image-processing 选 queue 回写通道的理由写准确（`http://<EIP>` 来自 `scripts/module` 的默认值）；冷启动选做补充时间提示。
20. svc-social-api 第 4 步明确 before / after 两次运行分别对应 EIP 与网关，`throttle pair` 才可判定。
21. §1.1 补充平台固定部分（方案 B 预览证书）、`${atl:drRegion}` 占位符，以及与第 1 批一致地不采用 05 §4.1 的 S2、S5；附录 C 新增 C-11～C-17。

**核实过、无需修改的事实**：EFS 挂载目标按 AZ、一个文件系统同时只在一个 VPC；EBS Multi-Attach 限同 AZ 与特定卷类型；RDS 自动备份最长 35 天、PITR 恢复为新实例、未加密实例不能直接建加密副本；SQS 标准队列进入 DLQ 后过期时间仍按最初入队时间计算、消息上限 1 MiB；Lambda 异步调用 0～2 次重试；SNS 过滤策略默认作用于消息属性；SES 沙盒按区域、模拟器在沙盒可用；EventBridge Scheduler 支持时区与一次性调度、定时规则按 UTC；Rekognition `S3Object` 以调用者权限读取且要求同区域；HTTP API 不支持 API Key / 使用计划 / WAF 关联。

### 2026-10-13 · 第 3 轮（按主设计者裁决 C1～C5 修订）

依据：主设计者裁决 C1～C5；平台评审的统一取值；04 第 2 轮（`atl.lab/v2`、`op: healthy`、`expectedWarnings`、`path-seen`、`dr-region`、SDK 操作名白名单、定向扫描）；01 第 2 轮修订稿中的 `DrRegionLimited`（以 01 定稿为准）。

| # | 裁决 / 来源 | 位置 | 修改 |
|---|---|---|---|
| R3-1 | C3 | §0、§1.1，shared-fs、database、cache、backup、social-api | 起始状态改为“L0 + iam(role) + 硬依赖闭包”，5 张原先不并入 iam 的卡片加 iam，CRED-004 全部删除；深度探针与控制面感知（Multi-AZ 状态、恢复点、`apigateway:GET`）改为可用；shared-fs 随之采用 `IamAuth=true`（挂载带 `tls,iam`，C-9 补充）；起始状态由 `plan --start-of` 推导，档位 `atl/<卡片 id>` |
| R3-2 | C3 | §1.1 第 4 条、§0“预期警告”列、各卡 wire 检查 | 能力检查统一为 `op: healthy`，本批 `expectedWarnings` 全部为空；没有规则 ID 的 `degraded` 改用 `pendingIf`（notification 订阅待确认）或 `anyOf` + detail（email 沙盒），新增 C-18；svc-cache 的 memory 对照仍不判 `status`（C-17、新增 C-19） |
| R3-3 | C3 | 各卡第 1 步等 before 检查 | 描述起始状态的检查补齐 `once` |
| R3-4 | C3 | §1.6、附录 A | 徽章只看完成，小测成绩只记录；C-16 标为已解决 |
| R3-5 | C1 | 全文 | `cloudalbum-<env>-*` 改为 `cloudalbum-<envName>-*`；共享检查名 `no-world-ssh`；aws-readonly 的 `action` 改为 SDK 操作名（S3：`GetPublicAccessBlock`、`GetBucketNotificationConfiguration`、`GetBucketEncryption`），C-14 已解决 |
| R3-6 | C4(c)(d)(e) | §1.2 | 栈标签含 `atl:component=env`、`atl:env-id`；`state.json` 与锁在 `cloudalbum-lab-state-<acct>-<region>`、`cloudalbum-lab-locks`；手建资源的归属改为“只认创建证据”，删除“必须补打标签”的要求，说明定向扫描的延迟与重试；临时实例不得带 `atl:role=lab-app`（新增 C-20） |
| R3-7 | C5 | §1.3、storage、database、cache、shared-fs | 探测端点统一为 `/api/lab/probe/*`（`now`、`media-url`），令牌头 `X-ATL-Probe-Token`；实验标签改为任意变体（cache 的 `memory`、queue 的可选 `l0`），结果标注 `variant`，C-4 已解决 |
| R3-8 | C2、04 v2 | 附录 A、附录 B | svc-storage 的 `lab.yaml` 按 04 v2 重写（`modules` 对象、`provisions` 的 `kind/basis`、`targetModules.wireStep`、`expectedWarnings`、`labels` 对象写法与 `pairs`、`badge`、`tracks`）；附录 B 的扩展提案全部标为已并入 04 v2（C-2、C-5 已解决） |
| R3-9 | 04 §5.7、§6.4 | shared-fs、analytics、queue、backup、scheduler | 原先因白名单缺项只能 manual 的检查改为 aws-readonly：`DescribeAccessPoints`、`athena:GetWorkGroup`、`glue:GetTable`、`sqs:ListMessageMoveTasks`、`region: dr-region` 的 `ListRecoveryPointsByBackupVault`；`cloudalbum-worker-<n>` 已进 `systemd-unit` 白名单（C-3 已解决） |
| R3-10 | 01 第 2 轮（进行中） | svc-backup、C-6 | 灾备区域的阻塞改为“依赖 01 的 `DrRegionLimited`，定稿前只能以 `DrRegion` 为空的形态完成”；纯基础设施型 wire 证据加 `module-state`（C-1 已解决） |
| R3-11 | 附录 C | C-1～C-17 | 逐条标注处理状态；新增 C-18～C-20 |

**没有采纳的意见**：无。第 2 轮“`credentials: optional` 不并入 iam”的取舍按 C3 推翻。

**仍需其他文件配合**：06（`probe/now` 是否经过 DatabasePort 与 CachePort、`app-stat` 统计名登记、运行器参数形式）；总纲 modular-design（C-18 的“SES 沙盒”“订阅待确认”规则 ID，C-17/C-19 的单机多进程 ASG-004）；04（若采纳 C-18 的 `expectedConditions`）；01 定稿（C-6 的 `DrRegionLimited`）；模块文档回写（C-7、C-8、C-9、C-10、C-11、C-12、C-13）；07（定向扫描延迟与 `LookupEvents` 速率实测，C-20）；05 与 tracks-and-catalog（元数据汇总按本文同步：5 张卡片的起始状态加 iam）。

### 2026-10-13 · 第 4 轮（跨文档审计修复）

- **档位名**（审计中严重度）：元数据与附录中的起始档位名由 `atl/<card-id>` 改为 `atl/<card-id>/default`，§0 约定 3 写明 `atl/<card-id>/<variant>` 与文件 `profiles/atl/<card-id>/<variant>.env`。理由：运行器按 01 §3.4 从 `content/<ver>/profiles/atl/<card-id>/<variant>.env` 下载档位，短名对应的文件不存在；04 已在同一轮统一。
- **没有采纳的意见**：无。**仍需其他文件配合**：无。
