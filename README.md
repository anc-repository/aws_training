# AWS Training Lab：像云起实验室一样学 AWS SAA

一个面向 **AWS Certified Solutions Architect – Associate（SAA-C03）** 学习者的动手实验项目，由两部分组成：

- **实验平台 AWS Training Lab（ATL）**：一个类似阿里云云起实验室的网站，部署在**学员自己的 AWS 账号**里。它提供：
  - 学习卡片目录；
  - 一键开始，自动部署实验环境；
  - 左手册、右终端的分屏工作台；
  - 倒计时，到期自动释放资源；
  - 自动检测、实验报告和证书。
- **实验对象 CloudAlbum**：一个云相册网站。**只有一台 EC2 时就能完整运行**，其余 39 个 AWS 服务都是可插拔模块。启用一个模块，对应的功能就从“EC2 本地实现”切换成“AWS 实现”，并且能直观看到有它和没有它的区别。

> **项目状态**
> - 设计已完成。
> - CloudAlbum 的 MVP 和实验平台的代码已实现，并通过本地自测（单元测试、集成测试、端到端冒烟测试、浏览器端到端测试、cfn-lint）。
> - 部署到真实 AWS 账号的验证还在进行，计划见 [docs/platform/07-aws-verification-plan.md](docs/platform/07-aws-verification-plan.md)。
> - 在验证完成之前，请不要把它当作可以直接上线的工具使用。

---

## 目录

- [一次实验是什么样的](#一次实验是什么样的)
- [学习卡片](#学习卡片)
- [CloudAlbum：一台 EC2 起步](#cloudalbum一台-ec2-起步)
- [机能与 AWS 服务对照表](#机能与-aws-服务对照表)
- [重点对比实验](#重点对比实验)
- [在本机运行](#在本机运行)
- [部署到自己的 AWS 账号](#部署到自己的-aws-账号)
- [技术栈与仓库结构](#技术栈与仓库结构)
- [文档导航](#文档导航)
- [费用与安全提醒](#费用与安全提醒)
- [路线图](#路线图)

---

## 一次实验是什么样的

1. **安装平台**：在自己的 AWS 账号里，用一个 CloudFormation 栈安装 ATL。平台全部使用 Serverless 服务，没人用时几乎不产生费用。
2. **选卡片**：在目录里按服务、考试领域、难度、时长、费用档位筛选；也可以切换到“服务地图”，看哪些服务已经掌握。
3. **开始实验**：
   - 平台先报价，你确认费用后再部署；
   - 部署内容是这张卡片的起始环境：一台 EC2 上的 CloudAlbum，加上必需的前置服务；
   - 倒计时从这时开始，可以延长。
4. **分屏工作台**：
   - 左边是实验手册：命令可以一键复制，或者发送到终端，每一步都有“检测”按钮；
   - 右边有四个标签：实验机终端（浏览器通过 Session Manager 直连，不开 22 端口）、工作台终端（预装 AWS CLI）、AWS 控制台（联合登录）、应用预览。
5. **对比实验**：在“有这个服务”和“没有这个服务”两种状态下各测一次，平台并排展示指标。
6. **结束**：
   - 可以手动结束，也可以等到期自动结束；
   - 平台按依赖倒序回收这次会话创建的全部资源，包括你在控制台里手动创建的资源（通过 CloudTrail 找出归属）；
   - 无法自动删除的资源，会列进“待人工处理清单”。
7. **报告和证书**：
   - 报告包含每一步的证据、对比数据和用时；
   - 完成一张卡片获得徽章，完成一条学习路径获得证书；
   - 证书用 KMS 签名，有公开验证页。证书是自托管平台签发的，不是 AWS 官方认证。

可点击的界面原型：[docs/platform/prototype/index.html](docs/platform/prototype/index.html)（下载后用浏览器打开，内容是示例数据）。

---

## 学习卡片

卡片是目录的基本单位。每张卡片都是一个独立的小实验，可以单独开始。

- **单服务卡片 40 张**（`svc-<模块>`）：一个服务一张。开始时自动预置“L0 + 实例角色 + 硬依赖”，学员只需要专注于这一个服务。
- **组合场景卡片 16 张**（`sc-<场景>`）：几个服务一起解决一个真实场景，接近 SAA 的场景题。例如：
  - 静态资源全球加速：S3 + CloudFront + Route 53 + ACM
  - 无服务器图片流水线：S3 + EventBridge + Lambda + SQS + Rekognition
  - 高可用 Web 层：ALB + Auto Scaling + RDS Multi-AZ
  - 备份与灾备：AWS Backup + S3 跨区域复制 + Route 53 故障转移
- **学习路径 9 条**：
  - SAA 主线（原 Lab 0～25）；
  - 安全、弹性、高性能、成本优化四个考试领域专项；
  - 点名对比快速路径：Cognito、SQS、CloudFront、Lambda、ElastiCache、S3、RDS；
  - 其他专题路径。

**第一批已实现、可以开始的 10 张卡片**：

| 卡片 | 内容 |
|---|---|
| svc-ec2 | EC2 基线：只用一台 EC2 跑通全部功能 |
| svc-iam | 应用使用实例角色 vs 使用访问密钥 |
| svc-storage | Amazon S3：照片从 EBS 搬到 S3，预签名 URL 直传 |
| svc-cdn | Amazon CloudFront：边缘缓存命中与首字节时间 |
| svc-queue | Amazon SQS：削峰，worker 重启时任务不丢 |
| svc-image-processing | AWS Lambda：缩略图从 EC2 移到 Lambda |
| svc-cache | Amazon ElastiCache：时间线缓存与运行时 A/B |
| svc-database | Amazon RDS：SQLite → 自建 PostgreSQL → RDS |
| svc-auth | Amazon Cognito：本地账号 vs Cognito |
| sc-static-acceleration | 静态资源全球加速（组合场景） |

其余 46 张已经写好设计（在 [docs/platform/cards/](docs/platform/cards/)），目前在目录里显示为“规划中”。

---

## CloudAlbum：一台 EC2 起步

CloudAlbum 的功能有：注册登录、上传照片、自动生成缩略图和标签、浏览时间线、点赞评论、分享链接、通知和每日报告。

设计原则：

- **EC2 是唯一必需的组件。** 默认 VPC 的公有子网、弹性 IP 和一块独立的 EBS 数据卷，就构成完整的运行环境，这个状态叫 **L0**。
- **一个机能对应一个 AWS 主服务。** 每个模块定义一个接口，本地实现和 AWS 实现各写一个适配器（端口-适配器架构）。
- **依赖显式声明，启动时校验。** 例如 Lambda 生成缩略图需要先启用 S3，因为 Lambda 读不到 EC2 的本地磁盘。不满足依赖时，应用以退出码 78 拒绝启动，并说明缺什么。
- **不静默降级。** AWS 服务出故障时，应用不会悄悄退回本地实现。
- **差异可观测。** 每个响应都带 `X-CloudAlbum-Path` 和 `Server-Timing` 头，标明这次请求经过了哪些模块、各花了多少时间。

同一个上传请求，在 L0 和启用模块后的响应头对比：

```
# L0
X-CloudAlbum-Path: storage=local;image-processing=inline;queue=sync;auth=local

# 启用 CloudFront、ALB、S3、Lambda、Cognito、ElastiCache 之后
X-CloudAlbum-Path: entry=cloudfront>alb>nginx;storage=s3@cloudalbum-raw:presigned;
                   image-processing=lambda:queued;auth=cognito;cache=redis@elasticache:hit
```

---

## 机能与 AWS 服务对照表

一共 1 个基础模块加 39 个可插拔模块。“已实现”一列标 ✅ 的模块，AWS 适配器、CloudFormation 模板和对比实验都已写好；其余模块目前只有本地实现和设计文档。

### 基础

| 机能 | 本地实现 | AWS 服务 | 已实现 |
|---|---|---|---|
| 运行整个应用 | — | **Amazon EC2**（含 EBS、弹性 IP） | ✅ |

### A 入口、网络与扩展 · [01-edge-network-scaling.md](docs/modules/01-edge-network-scaling.md)

| 机能 | 没有它时（L0） | 有了它 | 已实现 |
|---|---|---|---|
| 网络隔离 | 默认 VPC 公有子网 | **Amazon VPC** | |
| 内容分发与边缘缓存 | Nginx 直接提供 | **Amazon CloudFront** | ✅ |
| 域名解析 | 弹性 IP 或 EC2 公网 DNS | **Amazon Route 53** | |
| HTTPS 证书 | 自签名或 Let's Encrypt | **AWS Certificate Manager** | |
| Web 应用防护 | Nginx 限速 + 黑名单 | **AWS WAF** | |
| 负载均衡 | Nginx 单机 | **Elastic Load Balancing（ALB）** | |
| 弹性伸缩 | 单实例 | **Amazon EC2 Auto Scaling** | |

### B 身份与安全 · [02-identity-security.md](docs/modules/02-identity-security.md)

| 机能 | 没有它时（L0） | 有了它 | 已实现 |
|---|---|---|---|
| 访问 AWS 的凭证 | 不调用任何 AWS API | **AWS IAM**（实例角色） | ✅ |
| 用户注册登录 | 本地账号（argon2id + ES256 JWT） | **Amazon Cognito User Pool** | ✅ |
| 终端用户直接访问 AWS 资源 | 应用签发的前缀上传令牌 | **Amazon Cognito Identity Pool** | |
| 密码与密钥管理 | 权限受限的 `secrets.env` | **AWS Secrets Manager** | |
| 集中配置与运行时开关 | 本地 `runtime.json` | **AWS Systems Manager Parameter Store** | |
| 数据加密密钥 | 本地主密钥 | **AWS KMS** | |

### C 数据与存储 · [03-data-storage.md](docs/modules/03-data-storage.md)

| 机能 | 没有它时（L0） | 有了它 | 已实现 |
|---|---|---|---|
| 照片对象存储 | EBS 上的本地目录 | **Amazon S3** | ✅ |
| 多实例共享文件系统 | 本地目录 | **Amazon EFS** | |
| 关系数据库 | SQLite（可选：自建 PostgreSQL） | **Amazon RDS for PostgreSQL** | ✅ |
| 缓存 | 不缓存或进程内 LRU（可选：自建 Valkey） | **Amazon ElastiCache** | ✅ |
| 点赞、评论、分享链接 | 关系数据库中的表 | **Amazon DynamoDB** | |
| 备份 | cron + `sqlite .backup` | **AWS Backup** | |
| 点击流采集与投递 | 事件写入 SQLite | **Amazon Data Firehose** | |

### D 计算、异步与通知 · [04-compute-async.md](docs/modules/04-compute-async.md)

| 机能 | 没有它时（L0） | 有了它 | 已实现 |
|---|---|---|---|
| 图片处理（缩略图） | 请求内同步生成，或 EC2 上的 worker | **AWS Lambda** | ✅ |
| 异步任务队列 | 同步执行，或进程内队列 | **Amazon SQS** | ✅ |
| 通知扇出 | 站内通知表 | **Amazon SNS** | |
| 邮件发送 | 本地发件箱 | **Amazon SES** | |
| 定时任务 | 进程内 node-cron | **Amazon EventBridge Scheduler** | |
| 图片识别与审核 | EXIF 和基础属性标签 | **Amazon Rekognition** | |
| 社交 API 托管 | Express 路由 | **Amazon API Gateway** | |

### E 运维、监控与安全检测 · [05-ops-observability.md](docs/modules/05-ops-observability.md)

| 机能 | 没有它时（L0） | 有了它 | 已实现 |
|---|---|---|---|
| 运维登录 | SSH + 22 端口 | **AWS Systems Manager Session Manager** | |
| 日志 | 本地文件 + logrotate | **Amazon CloudWatch Logs** | |
| 指标、告警、仪表板 | 应用内置的指标存储 | **Amazon CloudWatch** | |
| 分布式链路追踪 | 请求 ID + `Server-Timing` | **AWS X-Ray** | |
| AWS 操作审计 | 应用内审计日志 | **AWS CloudTrail** | |
| 威胁检测 | fail2ban | **Amazon GuardDuty** | |

### F 治理、成本与交付 · [06-governance-cost.md](docs/modules/06-governance-cost.md)

| 机能 | 没有它时（L0） | 有了它 | 已实现 |
|---|---|---|---|
| 成本护栏 | 按已启用模块估算 | **AWS Budgets** | |
| 配置合规检查 | 应用内配置自检 | **AWS Config** | |
| 漏洞扫描 | 安全公告检查 + 依赖审计 | **Amazon Inspector** | |
| 数据库连接池 | 本机 PgBouncer | **Amazon RDS Proxy** | |
| 流程编排 | worker 代码里的流程控制 | **AWS Step Functions** | |
| 黄金镜像 | User Data 在启动时现场安装 | **EC2 Image Builder** | |

---

## 重点对比实验

| 服务 | 没有它 | 有了它 | 怎么看出差别 |
|---|---|---|---|
| **CloudFront** | 所有请求都由东京的 EC2 响应 | 静态资源和图片由边缘节点返回 | 响应头出现 `X-Cache: Hit from cloudfront`、`Age` 逐渐增大；EC2 的出网流量明显下降 |
| **SQS** | 进程内队列，worker 重启时任务会丢 | 任务持久化在队列里，失败后进入死信队列 | 突发上传时比较接口响应时间；在处理途中重启 worker，统计丢失的任务数 |
| **Lambda** | 缩略图占用 EC2 的 CPU，拖慢上传接口 | 上传立即返回，缩略图异步生成 | 并发上传时比较 API 延迟和 EC2 CPU；在日志中观察冷启动 |
| **Cognito** | 注册、登录、MFA 全部自己实现 | MFA、托管登录页、账号锁定开箱即用 | 比较代码量和安全责任；在令牌查看器里对比签发方和签名算法 |
| **ElastiCache** | 每次都查数据库，或使用各进程独立的缓存 | 多实例共享缓存 | 用请求头 `X-Compare-Bypass: cache` 做同一请求的 A/B |
| **S3** | 照片经过 API 进程写到 EBS | 浏览器直传 S3 | 上传大文件时比较 API 的内存和带宽 |
| **RDS** | 单文件 SQLite | 托管 PostgreSQL，支持 Multi-AZ 和只读副本 | 演练故障转移；做时间点恢复 |

---

## 在本机运行

需要 Node.js 22、npm 10 和 Docker。全部命令在仓库根目录执行，不需要 AWS 账号。

```bash
npm install
npm run build
npm test
```

**CloudAlbum 端到端自测**：

```bash
npm run smoke:l0
```

这条命令依次测试三种配置：L0 默认配置、worker 加内存队列、内存缓存；另外还会验证规则引擎拒绝 7 种不合法的配置组合。

```bash
npm run smoke:selfhost
```

用 Docker 启动 PostgreSQL 16 和 Valkey 8，测试自建档。

```bash
npm run smoke:localstack
```

测试 S3 + SQS。本机有 LocalStack 镜像就用它，没有就改用 MinIO 加内置的 SQS 替身。

**实验平台（开发模式）**：DynamoDB Local + 进程内编排模拟器 + 本地 CloudAlbum。

```bash
npm run platform:dev
```

启动后用浏览器打开 http://127.0.0.1:5174/ ，开发模式的登录账号是 `learner`、密码 `u1`。

```bash
npm run smoke:platform
```

在本机把完整流程跑一遍：开始实验 → 检测 → 对比实验 → 延长 → 到期回收 → 报告 → 证书签发、验证、吊销。

```bash
npm run e2e:platform
```

用无头浏览器做端到端测试。

**其他检查**：

```bash
npm run labs:lint
npm run platform:validate
```

`labs:lint` 校验全部 56 张卡片的格式，`platform:validate` 校验全部状态机定义。

---

## 部署到自己的 AWS 账号

> 这一部分正在用真实账号验证。

步骤概要：

1. 准备一个**独立的练习账号**，先设好预算告警。
2. 在本机配置 AWS CLI 的配置文件，推荐用 IAM Identity Center：

   ```bash
   aws configure sso --profile aws-training
   ```

3. 运行部署前检查（只读，不会修改任何资源）：

   ```bash
   node scripts/verify/preflight.mjs --profile aws-training
   ```

4. 按 [07-aws-verification-plan.md](docs/platform/07-aws-verification-plan.md) 的阶段顺序执行：
   - 阶段 0：账号检查
   - 阶段 1～2：IAM 机制和终端协议的 PoC
   - 阶段 3：部署 CloudAlbum L0
   - 阶段 4：模块启停
   - 阶段 5：安装平台并走查卡片
   - 阶段 6：全量回收

   每个阶段都写明了会创建的资源、费用档位和回收方法。

---

## 技术栈与仓库结构

- **CloudAlbum**：
  - 后端：Node.js 22、TypeScript、Express 5、Knex（SQLite / PostgreSQL）；
  - 前端：React + Vite；
  - Lambda：Node.js 22 arm64。
- **ATL 平台**：
  - 前端：React + Vite + xterm.js；
  - 后端：API Gateway HTTP API + Lambda、DynamoDB 单表、Step Functions、EventBridge Scheduler、CodeBuild、SSM、KMS；
  - 模板：单个 CloudFormation 栈。
- **测试**：vitest、aws-sdk-client-mock、Docker（PostgreSQL、Valkey、DynamoDB Local）、cfn-lint、playwright。
- **默认区域**：`ap-northeast-1`（东京）。

```
.
├── backend/                 # CloudAlbum 后端（ports/、adapters/、rules/、observability/ …）
├── frontend/                # CloudAlbum 前端
├── lambdas/                 # 缩略图等 Lambda
├── packages/                # contracts（共享类型）、image-core
├── infra/                   # CloudAlbum 的 CloudFormation 模板、L0 引导脚本、nginx、systemd
├── modules/registry.yaml    # 40 个模块的注册表（开关、依赖、栈、探针）
├── profiles/                # 预设档位
├── experiments/             # 对比实验运行器和实验脚本
├── scripts/                 # module CLI、冒烟测试、发布构建、部署前检查、卡片工具
├── platform/
│   ├── shared/              # 名称表、键设计、lab.yaml v2 schema
│   ├── api/                 # 全部 Lambda 函数 + 本地 dev-server
│   ├── workflows/           # 状态机定义、编排模拟器、运行器
│   ├── checks/              # 实验机检查包
│   ├── infra/               # 平台模板、IAM 策略、SSM 文档、打包脚本
│   ├── workstation/         # 工作台引导与工具
│   ├── ssm-client/          # 浏览器端 Session Manager 协议客户端
│   └── web/                 # 平台前端
├── labs/                    # 56 张卡片的内容（lab.yaml v2）
└── docs/                    # 设计文档
```

---

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/platform/01-architecture.md](docs/platform/01-architecture.md) | 平台架构、唯一名称表、IAM 与权限边界、API、数据模型 |
| [docs/platform/02-lab-lifecycle.md](docs/platform/02-lab-lifecycle.md) | 一键开始、倒计时、回收、卸载 |
| [docs/platform/03-workspace-terminal.md](docs/platform/03-workspace-terminal.md) | 分屏工作台、终端、控制台联合登录 |
| [docs/platform/04-lab-format-checks-reports.md](docs/platform/04-lab-format-checks-reports.md) | 卡片内容格式、检测引擎、报告与证书 |
| [docs/platform/05-lab-catalog.md](docs/platform/05-lab-catalog.md) | 卡片目录与 56 张卡片的元数据 |
| [docs/platform/cards/](docs/platform/cards/) | 每张卡片的详细设计、学习路径 |
| [docs/platform/06-cloudalbum-platform-mode.md](docs/platform/06-cloudalbum-platform-mode.md) | 平台对 CloudAlbum 侧的要求 |
| [docs/platform/07-aws-verification-plan.md](docs/platform/07-aws-verification-plan.md) | 真实 AWS 验证计划 |
| [docs/platform/08-ui-design.md](docs/platform/08-ui-design.md) | 平台界面规格 |
| [docs/modular-design.md](docs/modular-design.md) | CloudAlbum 总纲：L0、模块、端口、规则、能力探针、档位 |
| [docs/modules/](docs/modules/) | 40 个模块的详细设计（00～06） |
| [docs/implementation-notes.md](docs/implementation-notes.md) | 实现说明、自测结果、已知问题 |
| [docs/architecture.md](docs/architecture.md) | 全部模块启用后的目标架构 |
| [docs/labs.md](docs/labs.md) | 原 Lab 0～25（现在是 SAA 主线路径） |
| [docs/saa-coverage.md](docs/saa-coverage.md) | SAA-C03 考试领域对照与考点 |

---

## 费用与安全提醒

- **使用独立的练习账号**，并先设预算告警。不要在生产账号里练习。
- **不要把访问密钥发给任何人**，也不要写进仓库。推荐用 IAM Identity Center 的临时凭证。
- **注意按小时计费的资源**：NAT Gateway、ALB、RDS、ElastiCache、Interface VPC Endpoint、运行中的 EC2，即使没人访问也在计费。平台开始实验前会报价，结束时自动回收。
- **价格以 [AWS 官方定价页](https://aws.amazon.com/pricing/) 为准。** 本项目只说明计费维度，不写具体价格。

---

## 路线图

- [x] 设计：CloudAlbum 模块化架构、40 个模块、实验平台、56 张卡片、学习路径、界面规格
- [x] CloudAlbum MVP：L0 全部功能，以及 8 个模块的 AWS 实现（iam、storage、cdn、auth、queue、image-processing、cache、database）
- [x] 实验平台：API、生命周期编排、检测、报告、证书、平台模板、工作台、Session Manager 客户端、网页前端
- [x] 第一批 10 张卡片的完整内容
- [x] 本地自测：单元测试、集成测试、冒烟测试、浏览器端到端测试、cfn-lint
- [ ] 真实 AWS 验证（按 07 验证计划）
- [ ] 其余 32 个模块的 AWS 实现，以及对应的 46 张卡片
- [ ] 平台的升级流程与多学员支持

---

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
