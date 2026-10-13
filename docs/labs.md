# 实验路线（Labs）

本文把 CloudAlbum 的 26 个 Lab（Lab 0～25）串成一条从“只有一台 EC2”到 `l9-full` 的学习路线。每个 Lab 启用一到两个模块，用“有 vs 没有”的对比实验看清这个 AWS 服务到底带来了什么。

- **权威来源**：Lab 顺序、启用的模块、预设档位以 [modular-design.md](modular-design.md)（下称“总纲”）第 10 节为准（D12）；模块的开关、依赖、实验细节以 `docs/modules/0N-<group>.md` 中对应模块的章节为准。本文与它们不一致时，以总纲和模块文档为准。
- **本文不重复模块文档**：每个 Lab 只写“做什么、按什么顺序做、看什么、怎样算做完”。实验脚本的参数、预期结果的细节、费用维度都在链接的模块章节里。
- **数字与价格**：本文的时长是学习时间的粗略估计；所有性能结论只写方向和数量级，价格只写计费维度，以官方定价页为准（D14）。

---

## 1. Lab 总表

“预设档位”是 `profiles/` 中按顺序累加的档位（总纲 10.2）；“依赖”一列先写**单独开始时的最小依赖**（L0 之外还要启用什么），再写**按顺序做时建议的前序 Lab**。“+iam”表示会自动并入 `IAM_CREDENTIALS=role`（凭证前置，D1）。预计时长不含等待云端生效的时间（CloudFront 部署、RDS 创建、DNS 委派、账单数据刷新、扫描周期等），这类等待在各 Lab 的前置条件中单独说明。

| Lab | 主题 | 启用模块 | 预设档位 | 预计时长 | 依赖（最小集合；建议前序） |
|---|---|---|---|---|---|
| 0 | L0 基线：只有一台 EC2（含本地档） | [ec2](modules/00-ec2-base.md#ec2) | `l0-ec2` → `l0-plus-local-tiers` | 3h | —；— |
| 1 | 服务器以什么身份调用 AWS + 成本护栏 | [iam](modules/02-identity-security.md#iam)、[cost](modules/06-governance-cost.md#cost) | `l1-ops` | 2.5h（+账单数据最长一天） | —（cost 需激活成本分配标签）；Lab 0 |
| 2 | 不开 22 端口的运维登录 | [shell-access](modules/05-ops-observability.md#shell-access) | `l1-ops` | 1.5h | {iam(role)}；Lab 1 |
| 3 | 看得见：日志、指标与告警 | [logging](modules/05-ops-observability.md#logging)、[monitoring](modules/05-ops-observability.md#monitoring) | `l1-ops` | 2.5h | +iam；Lab 1 |
| 4 | 照片存进 S3 | [storage](modules/03-data-storage.md#storage) | `l2-edge` | 2h | +iam；Lab 1 |
| 5 | 边缘缓存：CloudFront | [cdn](modules/01-edge-network-scaling.md#cdn) | `l2-edge` | 3h（+分配部署数分钟） | —（OAC 阶段需 storage）；Lab 4 |
| 6 | 域名与受信 HTTPS：Route 53 + ACM（需要域名，可跳过） | [dns](modules/01-edge-network-scaling.md#dns)、[tls](modules/01-edge-network-scaling.md#tls) | `l2-edge` | 2.5h（+NS 委派） | 域名；ACME 端点不可用时 tls 需 {dns 或外部 DNS, cdn 或 load-balancer}；Lab 5 |
| 7 | Web 应用防护：Nginx 限速 vs AWS WAF | [waf](modules/01-edge-network-scaling.md#waf) | `l2-edge` | 2h | {cdn} 或 {load-balancer}；Lab 5 |
| 8 | 用户身份：Cognito User Pool 与 Identity Pool | [auth](modules/02-identity-security.md#auth)、[identity-pool](modules/02-identity-security.md#identity-pool) | `l3-identity` | 4h | auth：+iam（托管登录需受信 HTTPS）；identity-pool：{iam, storage, auth}；Lab 5 |
| 9 | 邮件与通知扇出：SES + SNS | [email](modules/04-compute-async.md#email)、[notification](modules/04-compute-async.md#notification) | `l3-identity` | 2.5h（+DKIM 验证） | +iam（SES 发件身份、确认订阅）；Lab 8 |
| 10 | 解耦：有/无 SQS | [queue](modules/04-compute-async.md#queue) | `l4-async` | 2h | +iam（本地档 `IMAGE_PROCESSOR=worker`）；Lab 4 |
| 11 | 照片流水线：Lambda + Rekognition；扩展：Step Functions | [image-processing](modules/04-compute-async.md#image-processing)、[tagging](modules/04-compute-async.md#tagging)；扩展 [workflow](modules/06-governance-cost.md#workflow) | `l4-async`；扩展 `x-workflow` | 4h（扩展 +1.5h） | lambda 档 {iam, storage} + 工具链栈；tagging +iam；workflow {iam, storage} + 工具链栈；Lab 10 |
| 12 | 定时任务：node-cron vs EventBridge Scheduler | [scheduler](modules/04-compute-async.md#scheduler) | `l4-async` | 2h（+两段 60 分钟心跳） | +iam；Lab 10 |
| 13 | 数据保护与配置：KMS + Secrets Manager + Parameter Store | [kms](modules/02-identity-security.md#kms)、[secrets](modules/02-identity-security.md#secrets)、[config](modules/02-identity-security.md#config) | `l5-security` | 3h | 各 +iam；Lab 4（必须早于 Lab 15） |
| 14 | 自定义 VPC（public 放置） | [network](modules/01-edge-network-scaling.md#network) | `l6-data` | 2.5h | —（不得有已部署的 VPC 绑定模块，DEP-016）；Lab 13 |
| 15 | 关系数据库：SQLite → 自建 PG → RDS；扩展：PgBouncer → RDS Proxy | [database](modules/03-data-storage.md#database)；扩展 [db-proxy](modules/06-governance-cost.md#db-proxy) | `l6-data`（扩展 `--with-optional`） | 4h（+RDS 创建；扩展 +1.5h） | —（RDS Proxy 需 {iam, database, secrets}）；Lab 13、14 |
| 16 | 缓存：有/无 ElastiCache | [cache](modules/03-data-storage.md#cache) | `l6-data` | 2h | —；Lab 14、15 |
| 17 | Serverless 社交：DynamoDB + API Gateway | [social-store](modules/03-data-storage.md#social-store)、[social-api](modules/04-compute-async.md#social-api) | `l7-serverless-social` | 3h（TTL 观察需数小时以上） | social-store +iam；social-api proxy 档 —，lambda 档 {iam, social-store}；Lab 8 |
| 18 | 点击流：Firehose + S3 + Athena | [analytics](modules/03-data-storage.md#analytics) | `l6-data` | 2.5h | +iam；Lab 15 |
| 19 | 负载均衡：Nginx 单机 vs ALB（含 F12 组合子功能） | [load-balancer](modules/01-edge-network-scaling.md#load-balancer) | `l8-ha` | 2h | —（HTTPS 与 F12 需 tls、auth）；Lab 14 |
| 20 | 私有化：network 切换为 private 放置 | [network](modules/01-edge-network-scaling.md#network) | `l8-ha` | 2.5h | 入口 {load-balancer 或 cdn(vpc-origin)} + 出网（NAT 或 Endpoint）+ 运维通道（shell-access 或 EIC Endpoint）；Lab 2、19 |
| 21 | 弹性伸缩与无状态设计（含 EFS 变体）；前置或扩展：黄金 AMI | [autoscaling](modules/01-edge-network-scaling.md#autoscaling)、[shared-fs](modules/03-data-storage.md#shared-fs)（变体）；[ami](modules/06-governance-cost.md#ami) | `l8-ha`（`--with-optional`）/ `x-efs-asg` | 4h（ami +1.5h） | {iam, load-balancer, database, storage 或 shared-fs}；Lab 15、19 |
| 22 | 链路追踪：Server-Timing → 本地 span → X-Ray | [tracing](modules/05-ops-observability.md#tracing) | `l9-full` | 2h | local 档 —；xray +iam；Lab 10、11 |
| 23 | 审计与威胁检测：CloudTrail + GuardDuty | [audit](modules/05-ops-observability.md#audit)、[threat-detection](modules/05-ops-observability.md#threat-detection) | `l9-full` | 2.5h（+trail 投递分钟级） | —（展示需 iam）；Lab 4 |
| 24 | 备份与灾备：AWS Backup | [backup](modules/03-data-storage.md#backup) | `l9-full` | 3h | —（区域 opt-in、灾备区域备份库）；建议最后做 |
| 25（可选） | 合规与漏洞：AWS Config + Amazon Inspector | [compliance](modules/06-governance-cost.md#compliance)、[vuln-scan](modules/06-governance-cost.md#vuln-scan) | `l9-full`（`--with-optional`） | 2h（+扫描周期 6～12 小时） | compliance —；vuln-scan {iam(role)}；Lab 23 |

**按小时计费与人工前置速查**（练完一个 Lab 就清理，或 `scripts/module profile apply l0-ec2` 回到基线；金额以官方定价页为准）：

| Lab | 引入的按小时计费资源 | 人工前置 |
|---|---|---|
| 0 | 无（L0 本身：一台小实例 + 两块小卷 + 一个公网 IPv4） | 部署者身份；SSH 密钥对 |
| 1 | 无 | 激活成本分配标签；确认预算告警订阅邮件 |
| 3 | 无（自定义指标、告警按数量计费） | 确认告警订阅邮件 |
| 6 | 无（托管区域按月、健康检查按月） | 拥有域名并能修改 NS |
| 9 | 无 | SES 发件身份（域名 DKIM 或邮箱）；沙盒期验证收件人；确认订阅邮件 |
| 11 | 无（预置并发只在冷启动实验中临时开启） | 工具链栈（`scripts/module bootstrap`，自动） |
| 14、20 | NAT Gateway、Interface Endpoint（只在 private 放置或显式选择时） | — |
| 15 | RDS 实例（Multi-AZ、只读副本、PITR 恢复实例各按一个实例计）；RDS Proxy | — |
| 16 | ElastiCache 节点 | — |
| 19、21 | ALB；ASG 中的多台实例；Image Builder 构建实例（构建期间） | 域名（HTTPS 监听器、F12） |
| 24 | 演练用的克隆实例与恢复出来的 RDS 实例 | 区域资源类型 opt-in；灾备区域备份库 |
| 25 | 无（Inspector 按实例与函数计费，Config 按配置项与评估计费） | 确认订阅邮件 |

`/lab` 顶栏从 Lab 0 起就显示 cost 模块本地实现推导出的“当前计费资源清单与启用时长”，Lab 1 之后再叠加 AWS Budgets 的实际与预测数据（[06#cost](modules/06-governance-cost.md#cost)）。

---

## 2. 每个 Lab 都可以从 L0 + 最小依赖单独开始

按 Lab 0→25 的顺序做是推荐路线：每一档都在上一档的基础上累加，后面的实验可以直接利用前面已经启用的模块（例如 Lab 11 的 Lambda 已经有 S3 可读、有 CloudFront 在前面）。但这不是硬性要求——模块化设计保证 **L0 + 任意单个模块（加上它的最小硬依赖、凭证前置与人工前置）都能启动并完成对比实验**（总纲目标 G4、10.4）。因此每个 Lab 都有两种起点：

| 起点 | 命令 | 适用场景 |
|---|---|---|
| 按顺序 | `scripts/module profile apply <本 Lab 的档位>`（例如 `l2-edge`） | 跟着路线走；档位只是“模块集合 + 取值 + 参数”的快捷方式，等价于逐个 `enable` |
| 单独开始 | `scripts/module profile apply single/<id>`，或 `scripts/module enable <id> --with-deps` | 只想练某个服务、重做某个 Lab、或在独立的沙箱账号里验证；`single/<id>.env` 由 `scripts/module profile gen-single` 从注册表自动生成 = `l0-ec2` + 该模块 + 最小硬依赖 + 凭证前置（`credentials: required` 时自动并入 `iam --mode role`）+ 让对比有意义的本地档（例如 `single/queue` 自带 `IMAGE_PROCESSOR=worker`） |

单独开始时需要注意三点：

1. **人工前置不会被自动满足**：域名（dns、tls、HTTPS 监听器）、SES 发件身份（email）、确认订阅邮件（notification、monitoring、cost、compliance）、激活成本分配标签（cost）。`scripts/module` 在计划阶段会列出它们，冒烟矩阵中标为“需人工”。
2. **少数对比依赖前序 Lab 提供的环境**：例如 Lab 20（private 放置）必须先有入口（Lab 19 的 ALB）和运维通道（Lab 2 的 Session Manager）；Lab 21 需要共享的数据库与对象存储。总表的“依赖”一列已经写明最小集合。
3. **顺序约束只有两条硬性的**：kms 必须早于创建 RDS、EFS（加密只能在创建时决定，registry `orderBefore`）；network 换 VPC 时不能有已部署的 VPC 绑定模块（DEP-016）。所以按顺序做时 Lab 13 在 Lab 15 之前、Lab 14 在 Lab 15～21 之前；单独做 Lab 15 时接受“RDS 不使用 CMK、留在默认 VPC”即可。

**只想做用户点名的七组对比**：变体档位 `x-named-comparisons`（iam、storage、cdn、auth、queue、image-processing、cache、database）在默认 VPC 中一次完成 Cognito、SQS、CloudFront、Lambda、ElastiCache、S3、RDS 的有/无对比，对应 Lab 1、4、5、8、10、11、15、16 的主实验。练完回到 `l0-ec2`；之后如果要走完整路线，先禁用 VPC 绑定模块再做 Lab 14（DEP-016）。

---

## 3. 通用约定

### 3.1 每个 Lab 的结构

**目标 → 启用的模块 → 前置条件 → 步骤 → 对比实验（有 vs 没有）→ SAA 考点 → 验收标准 → 清理**。

练习节奏建议：先用 `scripts/module` 启用并跑对比实验，再到控制台逐项核对模板创建了什么（每个模块文档第 2 节有资源清单），最后读模块文档的“常见坑”。所有资源都由 CloudFormation 模块栈创建（`infra/modules/<id>.yaml`，栈名 `cloudalbum-<env>-<id>`），跨栈不使用 `Export`/`ImportValue`（D2），因此任何一个模块都能单独启用、单独删除。

### 3.2 命令速查

| 目的 | 命令 |
|---|---|
| 首次部署 L0 | `scripts/module base deploy --ssh-cidr auto --admin-email you@example.com` |
| 启用 / 禁用模块 | `scripts/module enable <id> [--driver <本地档>] [--self-hosted] [--param K=V] [--with-deps]`；`scripts/module disable <id> [--cascade] [--purge]` |
| 看状态 | `scripts/module status [<id>]`（栈、env、capabilities、依赖、计费提示、已附加策略数） |
| 切换档位 | `scripts/module profile apply <档位> [--with-optional]`；`profile diff <档位>` 只打印计划 |
| 跑实验 | `npm run exp -- <id> --label before\|after [--scenario <场景>] [--ab] [--repeat N] --upload` |
| 出报告 | `npm run exp:report -- <id> [--before latest] [--after latest]` |
| 实例上校验配置 | `sudo -u cloudalbum node dist/cli.js check-config`（配置错误一律退出码 78） |

本文的 `npm run exp` 命令都应加 `--upload`（下文省略不写），这样结果会写入 `lab_results`，学习控制台才能据此判定验收标准。运行器会先比对 `/api/capabilities` 与 `experiment.json` 中该标签的前置条件，不匹配就拒绝运行，所以“切换前”的结果不会被误标成 after。

**基线的三个时刻**：Lab 0 跑的是“纯 L0”基线；进入某个 Lab 时，环境已经被前面的 Lab 改变，所以在启用本 Lab 的模块之前要**再跑一次 `--label before`**；启用后跑 `--label after`。报告默认比较后两者，L0 基线用 `--before <文件名>` 单独对比。

### 3.3 验收标准的写法

验收标准尽量写成学习控制台（`/lab`）可以用**已有接口**自动判定的条件。每条以判定来源开头：

| 前缀 | 判定来源 | 例子 |
|---|---|---|
| `[CAP]` | `GET /api/capabilities`（管理员视图）：`modules.<id>.driver / status / localHealth / detail`、`features`、`https`、`app` | `[CAP] storage.driver=s3，status=ok` |
| `[VAL]` | capabilities 的 `validation.errors / warnings / overridden`（规则 ID 见总纲 5.2） | `[VAL] errors 为空；warnings 不含 DEP-018` |
| `[PATH]` | `GET /api/lab/requests/recent` 中最近请求的 `X-CloudAlbum-Path`（语法见总纲 7.2） | `[PATH] GET /api/feed 出现 cache=redis@elasticache:hit` |
| `[RUN]` | `lab_results` 中的实验结果，以及 `/lab/compare` 按 `experiment.json` 的 `expect` 给出的“符合 / 不符合 / 差异小于噪声带” | `[RUN] storage/upload-burst 有 before 与 after，expect 无“不符合”` |
| `[MOD]` | 模块文档定义的只读实验接口（`GET /api/lab/<id>`、`/api/lab/iam/whoami`、`/api/admin/audit/verify` 等） | `[MOD] /api/lab/compliance 中 restricted-ssh 列出金丝雀安全组` |
| `[SMOKE]` | L0 冒烟测试 `experiments/ec2/smoke.ts`（检查项 S01～S27，[00#ec2](modules/00-ec2-base.md#ec2) 第 9 节） | `[SMOKE] 全部通过` |
| `[人工]` | 无法由应用自动判定：真实邮件到达、控制台中的执行图、外部 DNS、账单数据 | `[人工] 收到 AWS Budgets 的告警邮件` |

除非特别说明，每个 Lab 的验收都隐含两条通用条件：`[VAL] errors 为空`（否则进程根本起不来，退出码 78）；本 Lab 启用的模块 `status` 为 `ok`（个别模块在首轮评估完成前为 `degraded` 属正常，文中注明）。

### 3.4 清理的原则

- `disable` 会先做反向依赖校验，再按逆序迁回数据、撤销注入、分离策略、删除栈；承载数据的资源（桶、RDS、表、EFS、日志组、KMS 密钥）因 `DeletionPolicy: Retain` 保留，只有 `--purge` 才删除（总纲 9.1、9.2）。
- 按小时计费的模块练完立即处理；`scripts/module status` 不带参数时会列出所有仍在计费的资源。
- 彻底拆除用 `scripts/teardown`，它会打印因 `Retain` 留下的资源清单。

---

## Lab 0：L0 基线——只有一台 EC2（含本地档）

**目标**：只部署 ec2 一个栈，验证 F1～F14 与全部横切机能都能在单机上运行（总纲 2.8），并把它作为后续所有对比的基线；第二部分启用不花钱的本地档，把“架构模式带来的变化”与“托管服务带来的变化”拆开；最后亲手体会单点故障。

**启用的模块**：[ec2](modules/00-ec2-base.md#ec2)（基础模块，不可禁用）。全部开关取本地实现：`IAM_CREDENTIALS=none`，应用进程不加载 AWS SDK、不调用任何 AWS API。

**档位**：第一部分 `l0-ec2`；第二部分 `l0-plus-local-tiers`。

**前置条件**

- 一个可以长期使用的学习账号：根账号已开启 MFA 且没有访问密钥；日常使用 IAM Identity Center 用户或 CloudShell 作为**部署者身份**（`scripts/module` 用它部署 CloudFormation 与 IAM；应用自己的身份在 Lab 1 才出现）。
- 运维机（自己的电脑或 CloudShell）安装 AWS CLI v2、Node.js 22、k6；`ap-northeast-1` 为默认区域。
- 不要在这里创建 CloudTrail trail：CloudTrail 是 Lab 23 的 audit 模块，启用时会先检测已有 trail，避免产生第二份收费的管理事件副本。

**步骤**

第一部分：纯 L0

1. 部署：`scripts/module base deploy --ssh-cidr auto --admin-email you@example.com`。脚本解析默认 VPC 与子网、创建（或复用）密钥对、把当时的 AL2023 AMI 固定到参数 `/cloudalbum/<env>/ec2/image-id`、部署 `cloudalbum-<env>-ec2` 栈（EC2 + 独立 gp3 数据卷 + EIP + 安全组），等待 `cfn-signal` 后自动运行冒烟测试。
2. 控制台核对：实例强制 IMDSv2（跳数 1）；有两块 EBS 卷，数据卷 `DeleteOnTermination=false` 且带 `Backup=true` 标签；安全组 22 只对你的 IP 开放；实例**没有**实例配置文件。
3. 浏览器打开 `http://<EIP>/`：注册 → 在 `/me/outbox` 打开验证邮件（本地实现，没有真正发信）→ 登录 → 建相册、上传照片、等缩略图 → 点赞、评论、生成分享链接 → 多文件分片上传（F14 本地前缀令牌）。打开开发者工具，观察每个响应的 `Server-Timing` 与 `X-CloudAlbum-Path`（`entry=nginx`、`storage=local:accel` 等）。
4. 打开 `/lab`：除 ec2 外所有模块卡片都是灰色（`status=off`，`localHealth=ok`）；顶栏显示 cost 本地估算的计费资源（EC2 实例、公网 IPv4）。
5. 冒烟与 L0 性质实验：`npm run exp -- ec2 --label l0 --scenario smoke`，然后依次跑 `single-point-of-failure`（停止再启动实例，期间外部探测）、`imds-probe`、`cpu-credits`、`rebuild-drill`（`scripts/module rebuild-instance`：实例 ID 改变，密钥指纹不变，已有账号与 MFA 仍可用）。
6. 为后面的 Lab 先跑一轮 L0 基线（每条都是 `npm run exp -- <id> --label before --scenario <场景>`）：storage `upload-burst`；image-processing `upload-burst`；queue `upload-burst`（标签用 `l0`）；database `mixed-rw`；cache `feed-read`；social-store `like-storm`；analytics `clickstream-load`；shell-access `probe-port`；network `surface-scan`、`egress-path`；load-balancer `rolling-restart`；tls `inspect`；compliance、vuln-scan `coverage-matrix`。auth 的 `login-storm.k6.js`、`brute-force.k6.js` 与 identity-pool 的 `upload-bench.ts --mode token` 也在此时各跑一次并保存输出。

第二部分：本地档（仍然只有 ec2，不产生 AWS 费用）

7. `scripts/module profile apply l0-plus-local-tiers`。它等价于：`enable cache --driver memory`、`enable queue --driver memory`、`enable image-processing --driver worker`、`enable database --self-hosted`（EC2 上自建 PostgreSQL，`DB_HOST=127.0.0.1`）、load-balancer 本地档 `LB_LOCAL_WORKERS=2`、`enable tracing --driver local`；有域名时 tls 本地档 `TLS_MODE=letsencrypt`；可选 `enable db-proxy --driver pgbouncer`。本地档不写 `MODULE_<ID>=on`，由 `localTiers` / `selfHosted.match` 豁免 CFG-004。
8. 跑本地档对照（下表），重点体会：缓存、异步、换数据库引擎、单机多进程、链路追踪各自带来的变化，此时还没有任何托管服务参与。
9. 单点故障的另一半——数据卷损坏：按 [03#backup](modules/03-data-storage.md#backup) 的 `experiments/backup/drill.sh clone` 克隆一台演练实例，执行 `drill.sh disaster --scenario volume-loss --label before`，观察本地备份与数据同卷、一起丢失；`drill.sh cleanup` 删除克隆。（同一演练在 Lab 24 启用 AWS Backup 后再做一次。）
10. 回到纯 L0 进入 Lab 1：`scripts/module profile apply l0-ec2`（本地档会在后面的 Lab 中作为对照重新打开）。

**对比实验**

| 对比 | 场景（模块文档） | 观察点 |
|---|---|---|
| 单点故障 | ec2 `single-point-of-failure`（[00#ec2](modules/00-ec2-base.md#ec2) 9.2） | 停止期间全站不可用；EIP 不变、数据完整 |
| 实例可替换 | ec2 `rebuild-drill` | 机密与本地配置在数据卷上（`/etc/cloudalbum` → `/var/lib/cloudalbum/etc`），换实例不重新生成密钥（D5） |
| sync vs memory 队列 | queue `upload-burst`：`l0` 对 `before`（memory + worker，第 30 秒重启 api）（[04#queue](modules/04-compute-async.md#queue)） | 接口延迟从“包含处理时间”变为“只含入队”；重启 api 后 `biz.jobs_lost > 0` |
| 无缓存 vs 进程内缓存 | cache `feed-read`（`--label memory`）与 `stale-read`（两个 api 进程）（[03#cache](modules/03-data-storage.md#cache)） | 命中时 DB 查询降为 0；两个进程的 memory 缓存出现陈旧读 |
| SQLite vs 自建 PG | database `mixed-rw --label selfhost`（[03#database](modules/03-data-storage.md#database)） | SQLite 同步驱动阻塞事件循环，事件循环延迟 P99 尖峰；PG 不阻塞 |
| 单进程 vs 本机双进程 | load-balancer `rolling-restart`（配置 a 与 b）（[01#load-balancer](modules/01-edge-network-scaling.md#load-balancer)） | 单进程重启有数秒 502；双进程滚动重启接近零错误 |
| 单跳 vs 本机 span 树 | tracing `walkthrough`（local 档）（[05#tracing](modules/05-ops-observability.md#tracing)） | `Server-Timing` 只有单跳；local 档能看到 http → express → knex 的 span 树 |
| 自签名 vs Let's Encrypt（有域名时） | tls `inspect`（[01#tls](modules/01-edge-network-scaling.md#tls)） | 浏览器拦截页消失；证书 90 天、靠 certbot 定时器续期 |

**SAA 考点**：EC2 实例类型与 T 系列 CPU 积分（standard / unlimited）；AMI 与 SSM 公共参数；EBS gp3、加密、独立数据卷与 `DeleteOnTermination`；实例存储与 EBS 的持久性差异；弹性 IP 与公网 IPv4 计费（未关联的 EIP 也计费）；默认 VPC 与安全组（有状态、只有允许规则）；User Data 与 `cfn-signal`；IMDSv2 与 SSRF；购买方式（按需、Spot、Savings Plans、预留实例）。

**验收标准**

- `[SMOKE]` S01～S26 全部通过（S27 重启实例为可选）。
- `[CAP]` 除 ec2 外全部模块 `status=off` 且 `localHealth=ok`；ec2 `status=ok`，detail 含 “/etc/cloudalbum → 数据卷”。
- `[MOD]` `GET /api/lab/self-check` 报告的已加载模块中没有 `@aws-sdk/*`。
- `[PATH]` 出现过 `GET /media/variants/<photoId>/thumb_200.webp` 返回 200 且含 `storage=local:accel`（D6：nginx 能读取数据卷上的媒体文件）。
- `[RUN]` ec2 的 `smoke`、`single-point-of-failure`、`rebuild-drill` 各有一条结果；`rebuild-drill` 前后密钥指纹一致。
- 第二部分：`[CAP]` cache=`memory`、queue=`memory`、image-processing=`worker`、database=`postgres`（detail 主机分类为本机）、tracing=`local`，这些模块 `status=off`（本地档不算启用 AWS 实现）；`[VAL]` warnings 含 ASG-004（单机两进程 + memory 缓存，warn 级别）、不含 CFG-004。
- `[RUN]` queue/upload-burst 的 `before`（memory）结果中 `biz.jobs_lost > 0`；cache/stale-read 的 `memory` 结果陈旧读比例大于 0。

**清理**：`drill.sh cleanup` 删除克隆实例、AMI 与快照（快照里有机密，不要保留）；`scripts/module profile apply l0-ec2`。L0 本身保持运行。

---

## Lab 1：服务器以什么身份调用 AWS + 成本护栏（IAM 实例角色、AWS Budgets）

**目标**：让应用第一次获得 AWS 身份，并比较三种凭证形态（none、长期访问密钥、实例角色临时凭证）；同时在任何按小时计费的模块之前，先把成本护栏立起来。之后所有调用 AWS API 的模块都以 iam 为前置（CRED-001）。

**启用的模块**：[iam](modules/02-identity-security.md#iam)（`IAM_CREDENTIALS=role`；`keys` 只作反面教材）、[cost](modules/06-governance-cost.md#cost)（`COST_MODE=budgets`）。

**档位**：`l1-ops`（本 Lab 只启用其中的 iam、cost）。

**前置条件**

- 部署者身份需要 `iam:CreateRole`、`iam:PassRole`、`ec2:AssociateIamInstanceProfile` 等权限，部署时带 `CAPABILITY_NAMED_IAM`。
- 人工：在 Billing 控制台激活成本分配标签 `Project`（以及 `Module`），激活后需要一段时间才生效；准备一个能点击确认链接的邮箱。
- 账单数据有延迟：预算告警可能要到第二天才能观察到。

**步骤**

1. `scripts/module enable iam`：部署 iam 栈（`CloudAlbumAppRole` 与实例配置文件）、经基础栈参数挂载实例配置文件、写入 `IAM_CREDENTIALS=role`、重启。打开 `/lab` 的 iam 卡片：身份为 `assumed-role/CloudAlbumAppRole/i-…`，Key 以 ASIA 开头，显示过期倒计时；角色上目前只有 iam 自带的只读策略——之后每启用一个模块，就多一条 `cloudalbum-<env>-<id>` 客户托管策略（由 `scripts/module` 附加，记入 `state.json`）。
2. 身份对照：实例上运行 `npx tsx experiments/iam/whoami.ts`（或 `/lab` 卡片上的对照按钮，`GET /api/lab/iam/whoami`）。
3. 反面教材：`scripts/module enable iam --mode keys`，创建演示用户并把访问密钥写入 `secrets.env`（`IAM_KEYS_*`）；whoami 显示 AKIA 开头、永不过期，iam 卡片出现红色徽章（CRED-002）。运行 `sudo bash experiments/iam/leak-scan.sh`，记录长期密钥出现在哪些位置（数据卷上的 `secrets.env`、同盘本地备份、快照）。
4. 切回：`scripts/module enable iam --mode role`，按 [02#iam](modules/02-identity-security.md#iam) 第 6 节删除访问密钥、清除 `IAM_KEYS_*`、分离演示用户的策略，再跑一次 leak-scan 确认没有残留。
5. IMDSv2 与 SSRF：`bash experiments/iam/imds-ssrf.sh`。
6. 撤销会话：运行 `experiments/iam/aws-ping.k6.js` 低速持续请求 `/api/lab/aws-ping`（同时报告 GetCallerIdentity 与 `iam:GetRole` 两列），在控制台对角色执行 Revoke active sessions；观察两列的不同表现，再运行 `experiments/iam/refresh-role-creds.sh` 让实例换新会话。实验后删除 `AWSRevokeOlderSessions` 内联策略。
7. CloudTrail 对照：`npx tsx experiments/_lib/cloudtrail.ts --attr Username=<实例 ID>`，查看 `userIdentity.type=AssumedRole`（keys 模式时为 `IAMUser`）。
8. 成本护栏的本地实现：`/lab` 顶栏已经列出计费资源与启用时长；如果想看估算金额，自己从官方定价页抄录单价写入 `/etc/cloudalbum/cost-rates.yaml`，每条必须注明 `source` 与 `retrievedAt`（项目不内置任何价格）。
9. `scripts/module enable cost`：确认步骤中填写两个月度预算金额（按 `Project=CloudAlbum` 标签的项目预算、账号总额预算）；到邮箱确认订阅。
10. 阈值告警：把项目预算临时设成一个很小的金额后重新 `enable cost`，等待“实际花费超过阈值”的邮件与 SNS 消息（受账单刷新节奏影响，可能要等到第二天），实验后改回。
11. `visibility-lag`、`idle-reminder` 需要一个按小时计费的模块，在 Lab 15 或 Lab 16 启用 RDS / ElastiCache 时回来做；`tag-coverage` 在一两天后刷新 Cost Explorer 时做。

**对比实验**

| 对比 | 场景 | 观察点 |
|---|---|---|
| none / keys / role | iam whoami、leak-scan、aws-ping 撤销（[02#iam](modules/02-identity-security.md#iam) 第 5 节） | AKIA 长期密钥 vs ASIA 临时凭证；明文落盘位置数；撤销后 GetCallerIdentity 照常成功而 GetRole 被拒，实例需换新会话才恢复；CloudTrail 中 `userIdentity` 的差别 |
| 本地估算 vs Budgets | cost `threshold-alert`、`tag-coverage`、`visibility-lag`、`idle-reminder`（[06#cost](modules/06-governance-cost.md#cost) 第 5 节） | 本地清单“快而粗”、Budgets“准而慢”；无标签费用只出现在账号预算里；预测告警需要足够的用量历史 |

**SAA 考点**：IAM 用户、组、角色、策略；AWS 托管 / 客户托管 / 内联策略；实例配置文件与 `iam:PassRole`；STS 临时凭证、`aws:TokenIssueTime` 与撤销会话；策略评估逻辑（显式 Deny 优先，GetCallerIdentity 不需要权限）；IMDSv2 防 SSRF；最小权限（每个模块一条客户托管策略）；权限边界与 SCP（了解）。AWS Budgets（成本 / 用量 / RI 与 Savings Plans 预算、实际与预测告警、Budgets Actions）、Cost Explorer、成本分配标签（必须激活）、CloudWatch 账单告警的区别；按需、Savings Plans、预留实例、Spot。

**验收标准**

- `[CAP]` iam.driver=`role`，status=`ok`，detail 含 `assumed-role/CloudAlbumAppRole` 与 `ASIA`。
- `[VAL]` warnings 不含 CRED-002（已经切回 role）。
- `[MOD]` `GET /api/lab/iam/whoami` 返回角色身份；`GET /api/lab/aws-ping` 两列均成功（撤销实验结束后已恢复）。
- `[CAP]` cost.driver=`budgets`，status 为 `ok`（成本分配标签尚未生效时为 `degraded`，属正常）。
- `[人工]` leak-scan 在切回 role 后对 AKIA 的命中数为 0；收到 AWS 的预算告警邮件（可延后核对）。

**清理**：iam 与 cost 保留（后续所有 Lab 的前置与护栏）。确认演示用户的访问密钥已删除、`AWSRevokeOlderSessions` 已删除、项目预算金额已改回。成本分配标签不需要停用（[06#cost](modules/06-governance-cost.md#cost) 约定 8）。

---

## Lab 2：不开 22 端口的运维登录（Session Manager）

**目标**：把运维通道从“SSH 22 + 密钥对”换成 Session Manager，安全组不再有任何管理端口入站；`scripts/module` 的投递通道也随之从 ssh 切换为 SSM Run Command（后续各 Lab 沿用）。

**启用的模块**：[shell-access](modules/05-ops-observability.md#shell-access)（`SHELL_ACCESS_MODE=ssm`）。

**档位**：`l1-ops`。

**前置条件**：iam 为 `role`（DEP-001，SSM Agent 不读取应用的访问密钥）；运维机安装 Session Manager plugin；实例出站能访问 `ssm`、`ssmmessages` 端点（默认 VPC 公有子网满足）。L0 实例必须是带密钥对启动的（防锁死退路）。

**步骤**

1. before：`npm run exp -- shell-access --label before --scenario probe-port`（22 端口为 open）；可选 `ssh-noise` 观察 24 小时 sshd 失败次数（只对自己 IP 开放时接近 0）。
2. `scripts/module enable shell-access`：附加策略 → 实例 `PingStatus=Online` → `send-command` 冒烟 → 投递通道改为 ssm → 基础栈 `SshIngressCidr` 置空（删除 22 规则）。想保留过渡期可加 `--keep-ssh`。
3. 手工：`aws ssm start-session --target <实例 ID>`，执行 `id`（应为 `cloudalbum-ops`）、`sudo systemctl status cloudalbum-api`（允许）、`sudo cat /etc/cloudalbum/secrets.env`（拒绝）；再用端口转发访问 `http://localhost:13000/api/health/ready`。
4. after：`--label after --scenario probe-port`（filtered / 超时）；`--scenario session-audit`，把会话历史、会话日志与 CloudTrail 的 `StartSession` 按会话 ID 对齐。
5. `scripts/module status` 确认投递通道已是 `ssm`。

**对比实验**：[05#shell-access](modules/05-ops-observability.md#shell-access) 第 5 节——22 端口 open → filtered；“哪个 IAM 身份在什么时间执行了哪些命令”从“不能回答”变为“能回答”；需要分发轮换的长期凭证从私钥变为 0；端口转发取代临时开放端口。

**SAA 考点**：Session Manager、堡垒机、EC2 Instance Connect、EC2 Instance Connect Endpoint 的对比；SSM 托管节点的三个前提（Agent、实例配置文件或 DHMC、到 SSM 端点的网络）；Run Command；会话日志 + CloudTrail 审计链；`AmazonSSMManagedInstanceCore` 与最小权限的取舍；私有子网需要的 Interface Endpoint（为 Lab 20 铺垫）。

**验收标准**

- `[CAP]` shell-access.driver=`ssm`，status=`ok`（`--keep-ssh` 过渡期为预期内的 `degraded`）。
- `[VAL]` warnings 不含 SEC-003（22 端口已关闭）。
- `[RUN]` shell-access/probe-port：before 为 open，after 为 filtered / timeout；shell-access/session-audit 有 after 结果。
- `[人工]` CloudWatch Logs 的会话日志组中能看到第 3 步执行的命令。

**清理**：保留（Lab 20 的私有放置需要它作为运维通道）。确需回到 SSH：`scripts/module disable shell-access --reopen-ssh`。

---

## Lab 3：看得见——日志、指标与告警

**目标**：比较“本地文件 + 本地指标库 + 本地告警评估器”与 CloudWatch Logs / CloudWatch 的差别，重点是：实例没了日志还在不在、实例宕机时谁还能告警。本 Lab 也为后续实验提供 CloudWatch 侧的指标（例如 CPU 积分余额）。

**启用的模块**：[logging](modules/05-ops-observability.md#logging)（`LOG_DRIVER=cloudwatch`）、[monitoring](modules/05-ops-observability.md#monitoring)（`METRICS_DRIVER=cloudwatch`）。

**档位**：`l1-ops`（启用后即完整的 `l1-ops`）。

**前置条件**：iam（CRED-001）；monitoring 的告警邮箱需人工确认订阅；故障注入总开关 `featureFlags['lab.faults']` 打开（运行时配置，默认关闭）。

**步骤**

1. `scripts/module enable logging`（默认进程内 SDK 批量发送，本地文件照写）。
2. 摄取延迟：`npm run exp -- logging --label after --scenario ingest-lag`。
3. 查询对比：`POST /api/lab/faults {"type":"error5xx","rate":0.2,"durationSec":120}` 并施加负载，然后 `--scenario query-compare`（`store=local` 与 `store=cloudwatch` 并排）。
4. 实例丢失：`scripts/module rebuild-instance`，再用旧实例的 requestId 两侧查询（`--scenario instance-loss`）。
5. `scripts/module enable monitoring --param AlertEmail=you@example.com`，确认订阅邮件。
6. 告警时延：`npm run exp -- monitoring --label after --scenario time-to-alert`（本地评估器与 CloudWatch 告警并排计时）。
7. 宕机实验：`--scenario kill-test`，先停服务、再停实例，观察本地评估器沉默而 `app-heartbeat`（`TreatMissingData=breaching`）进入 ALARM 并经 SNS 送达。
8. 内存与粒度：`--scenario mem-visibility`（`AWS/EC2` 没有内存指标，CWAgent 有）；`--scenario resolution`（基础监控 5 分钟 vs 详细监控 1 分钟，后者需 `--param DetailedMonitoring=true`）。
9. 控制台：Logs Insights 运行保存的查询；仪表板 `CloudAlbum-<env>-Overview`；`aws cloudwatch set-alarm-state` 验证通知链路。

**对比实验**：[05#logging](modules/05-ops-observability.md#logging) 第 5 节（摄取延迟、跨实例覆盖、实例终止后可查、指标过滤器）；[05#monitoring](modules/05-ops-observability.md#monitoring) 第 5 节（告警与实例解耦、内存磁盘指标需 Agent、粒度与出现延迟、CPUCreditBalance）。

**SAA 考点**：CloudWatch 指标、维度、自定义指标与分辨率；告警（周期与 M of N、`TreatMissingData`、复合告警）；EC2 recover 动作；CloudWatch Agent（内存、磁盘）；基础监控与详细监控；日志组保留期（默认永不过期）；指标过滤器（不回溯）；Logs Insights；订阅过滤器与导出到 S3 的区别；EMF；CloudWatch、CloudTrail、Config 的分工。

**验收标准**

- `[CAP]` logging.driver=`cloudwatch`、monitoring.driver=`cloudwatch`，status=`ok`（未装 Agent 时 monitoring 为 `degraded`）。
- `[RUN]` logging/ingest-lag、logging/query-compare 有 after 结果；monitoring/kill-test 的 expect 符合（本地评估器未发出通知，`app-heartbeat` 进入 ALARM）。
- `[MOD]` `GET /api/lab/monitoring/alarms` 能列出本模块的告警及状态。
- `[人工]` 收到 SNS 告警邮件。

**清理**：保留两个模块（后续实验依赖 CloudWatch 侧指标）；`DetailedMonitoring` 改回 `false`；故障注入会自动过期，确认 `/lab` 顶部没有红色故障横幅。

---

## Lab 4：照片存进 S3（有/无 S3）

**目标**：把照片从 EBS 搬到 S3，上传从“经 EC2 中转写盘”变为“浏览器用预签名 URL 直传 S3”。

**启用的模块**：[storage](modules/03-data-storage.md#storage)（`STORAGE_DRIVER=s3`）。

**档位**：`l2-edge`。

**前置条件**：iam（CRED-001）；负载机最好是同区域的另一台机器（两次测量的客户端带宽必须一致）。

**步骤**

1. before：`npm run exp -- storage --label before --scenario upload-burst --vus 10 --duration 120s`；`--scenario ebs-growth`（balloon 把数据卷压到阈值以下，观察 507 与 SQLite 写失败）。
2. `scripts/module enable storage`：部署两个桶（原图桶开版本控制、媒体桶 Standard），附加策略，在只读窗口内经端口迁移 `uploads/` → S3（键不变，数据库不改），`verify` 后切换。
3. 控制台核对：Block Public Access 四项全开、`BucketOwnerEnforced`、桶策略强制 `aws:SecureTransport`、原图桶的 `NotificationConfiguration` **只有** EventBridge 投递（MUTEX-004）、生命周期规则、CORS。
4. after：同一命令 `--label after`；`npm run exp:report -- storage`。
5. 侧路对比：`--scenario upload-sidebyside`（lab 命名空间，同一实例同时比较两条路径）；`ebs-growth --label after`（上传不再受数据卷影响，但 SQLite 仍在这块盘上）。
6. 版本控制演练（手工）：删除一张原图（产生删除标记），再从非当前版本恢复。
7. DevTools：上传 PUT 的主机从本站变为 `*.s3.ap-northeast-1.amazonaws.com`。

**对比实验**：[03#storage](modules/03-data-storage.md#storage) 第 5 节——EC2 网卡入站字节从“与上传总量同量级”变为“只有 KB 级签名请求”；并发上传期间 `GET /api/feed` 的 P95；balloon 实验中上传返回 507 vs 不受影响。

**SAA 考点**：预签名 URL（PUT / GET，有效期与签名凭证的关系）；Block Public Access、`BucketOwnerEnforced`、桶策略 `aws:SecureTransport`；版本控制与删除标记；生命周期与存储类别（Standard-IA 最短存储期与最小计费尺寸、Intelligent-Tiering 对小于 128 KB 对象不分层）；SSE-S3 / SSE-KMS / Bucket Key；S3 事件通知 vs S3 → EventBridge；CORS；分段上传；S3 跨多 AZ 与 EBS 单 AZ 的耐久性差别。

**验收标准**

- `[CAP]` storage.driver=`s3`，status=`ok`。
- `[PATH]` `POST /api/photos` 出现 `storage=s3:presign`。
- `[RUN]` storage/upload-burst 有 before 与 after，expect 无“不符合”（`host.netRxBytes` 下降）；storage/ebs-growth 的 before 结果出现 507。
- `[人工]` 控制台中原图桶 `NotificationConfiguration` 只有 EventBridge 一项；版本恢复成功。

**清理**：保留（后续 Lab 依赖 S3）。需要回退时 `scripts/module disable storage` 会先把数据迁回数据卷（先检查剩余空间）。S3 不按小时计费。

---

## Lab 5：边缘缓存（有/无 CloudFront）

**目标**：在 EC2 前加 CloudFront，直连 URL 与 CDN URL 同时在线，做按 URL 的运行时 A/B；最后把媒体源站切到 S3（OAC），并锁定源站。

**启用的模块**：[cdn](modules/01-edge-network-scaling.md#cdn)（`CDN_BASE_URL` 指向分配；先 `CDN_MEDIA_ORIGIN=ec2`，最后 `s3`）。

**档位**：`l2-edge`。

**前置条件**：失效按钮与探针需要 iam（`credentials: optional`，缺失时 CRED-004 警告）；媒体源站切到 S3 需要 storage(s3)（DEP-010）。从单一 IP 压测前按 01 约定设置 `WAF_LAB_ALLOW_CIDR`。

**步骤**

1. `scripts/module enable cdn --origin ec2 --media-origin ec2`：生成 `origin-verify` 密钥（只进 `secrets.env`）、投放 8080 源站监听器片段、部署分配与源站安全组（只放行 CloudFront 托管前缀列表）。等待分配 `Deployed`（数分钟）。
2. 跨地域首字节：在 us-east-1、eu-west-1、ap-southeast-2、ap-northeast-1 的 CloudShell 中各跑 `npm run exp -- cdn --label after --scenario ttfb`。
3. 源站负载：`--scenario media-load`（`TARGET=direct` 与 `cdn` 各 5 分钟），观察 `/lab` 的“源站负载”面板；`--scenario origin-requests`。
4. 缓存失效：在 `/lab` 依次点“覆盖同名缩略图 → 创建失效 → 版本化键”，或 `--scenario invalidation`。
5. 动态 API 与压缩：`--scenario api-nocache`（`/api/lab/now` 永远 Miss，`/api/public/now` 在 `s-maxage` 内 Hit）；`--scenario compression`（br vs gzip）。
6. 管理员旁路：带 `X-Compare-Bypass: cdn` 请求相册接口，图片 URL 变回源站地址。
7. 媒体源站切到 S3（三阶段，[01#cdn](modules/01-edge-network-scaling.md#cdn) 第 6 节）：`scripts/module enable cdn --media-origin s3`——先注入分配 ARN 生成只授权 `variants/*` 的 OAC 桶策略，再切换媒体源站。切换前 capabilities 中会有 DEP-028 警告，切换后消失。
8. 收紧：`CDN_DIRECT_ACCESS=admin-ip`（直连只对实验机开放），基础栈 `PublicHttpIngress` 随之重算。

**对比实验**：[01#cdn](modules/01-edge-network-scaling.md#cdn) 第 5 节——`X-Cache`、`Age`、`cdn-*` Server-Timing；远离东京的区域命中时首字节从数百毫秒量级降到数十毫秒量级；源站请求数与 EC2 出网字节大幅下降；覆盖同名对象在 TTL 内仍是旧内容，失效需要数十秒到数分钟，版本化键立即生效；h2/h3 与 br。

**SAA 考点**：缓存策略、源请求策略、响应头策略的分工；TTL 与 `Cache-Control`、`s-maxage`；失效与版本化文件名；OAC 与 OAI；用托管前缀列表加自定义头保护源站、VPC Origin；签名 URL / 签名 Cookie 与 S3 预签名 URL；CloudFront Functions 与 Lambda@Edge；Origin Shield；价格等级；回源流量免费；与 Global Accelerator、S3 Transfer Acceleration 的对比；CloudFront 证书与 CLOUDFRONT 范围 WAF 在 us-east-1。

**验收标准**

- `[CAP]` cdn.driver=`cloudfront`，status=`ok`；`app.entry.source=cdn`；`https.trusted=true`（`default@cloudfront`）。
- `[VAL]` warnings 不含 DEP-028（媒体源站已是 s3）、不含 SEC-001。
- `[PATH]` 经 CDN 的请求 `entry=cloudfront>nginx`；带旁路头的请求出现 `cdn=cloudfront:bypass`。
- `[RUN]` cdn/ttfb 至少两个区域有结果；cdn/origin-requests、cdn/invalidation 有 after 结果。

**清理**：保留（Lab 8 的托管登录借用 CloudFront 的 HTTPS）。CloudFront 不按小时计费；注意每月免费失效路径配额。禁用分配需要先禁用再删除，耗时数分钟。

---

## Lab 6：域名与受信 HTTPS——Route 53 + ACM（需要域名，可跳过）

**目标**：用域名取代 IP 链接，体会 TTL、故障转移与加权路由；把自签名证书换成受信证书，并分清“考试结论”与“2026 新能力”。

**启用的模块**：[dns](modules/01-edge-network-scaling.md#dns)（`DNS_PROVIDER=route53`）、[tls](modules/01-edge-network-scaling.md#tls)（`TLS_MODE=acm`）。

**档位**：`l2-edge`（没有域名时跳过本 Lab，档位中去掉 dns 与 tls）。

**前置条件**

- 人工：拥有一个域名，能在注册商处修改 NS 或添加子域委派。
- tls 的 `preflight: acme-endpoint` 探测 ACM ACME 端点，`scripts/module` 把探测结果写成 `tls.env` 中的 `TLS_ACME=on|off`。`TLS_ACME=on` 时 tls 只需要域名；`TLS_ACME=off`（区域未上线、账号受限，或你用 `--no-acme` 选择按考试口径练习）时，tls 的最小依赖回退为 {dns 或外部 DNS, cdn 或 load-balancer}（DEP-005，启动时即按 `TLS_ACME` 求值）。
- 先把原有外部记录的 TTL 调低，等旧 TTL 过期后再切换。

**步骤**

1. 换 IP 演练（before）：`npm run exp -- dns --label before --scenario ip-change-drill`（临时换 EIP，IP 链接立即失效，脚本最后必须关联回原 EIP）。如果 cdn 的源站是 EC2 公网 DNS，先把源站改为 `origin.<域名>` 或暂时跳过。
2. `scripts/module enable dns --domain album.example.com --target cloudfront`：创建托管区域，到注册商委派 NS，`scripts/module` 轮询直到生效；记录指向 CloudFront（Alias）。
3. 换 IP 演练（after）：同一场景 `--label after`，记录域名链接在 TTL 过后恢复的时间；`--scenario failover-drill`（需要 `DNS_ROUTING_POLICY=failover` 与健康检查，健康检查路径为 `/api/health/ready?scope=instance`）；`--scenario weighted-sample`。手工对照 Alias 与 CNAME（根域名不能建 CNAME）。
4. tls before：`npm run exp -- tls --label before --scenario inspect`；浏览器打开 `https://<EIP>/` 记录拦截页。
5. `scripts/module enable tls --domain album.example.com`：`TLS_ACME=on` 时，在实例上用 certbot 经 ACM ACME 端点签发证书装到 Nginx（DNS 预先批准的域验证 + EAB，私钥留在实例上）；cdn 已启用时另在 us-east-1 签发集成证书，经 `injects` 挂到分配（`Aliases`）。
6. tls after：`inspect`、`--scenario handshake`（四个区域）、`--scenario cipher-scan`、`--scenario renew-drill`。
7. 对照两栏结论（[01#tls](modules/01-edge-network-scaling.md#tls) 第 7 节）：

   | 考试结论（答题以此为准） | 2026 新能力（已在 AWS 官方来源核实，题库可能尚未覆盖） |
   |---|---|
   | ACM 公有证书不能安装到 EC2，只能挂在 CloudFront、ALB、API Gateway 等集成服务上，由 ACM 托管续期；CloudFront 与 Cognito 托管登录自定义域名的证书必须在 us-east-1 | 2026-07 起 ACM 提供 ACME 端点：预先批准域名、发放 EAB，certbot 等客户端在自管服务器上签发短期公有证书，私钥在客户端、由客户端续期；这类证书**不能**绑定到 CloudFront / ELB / API Gateway |

**对比实验**：[01#dns](modules/01-edge-network-scaling.md#dns) 第 5 节（IP 链接 vs 域名、故障转移时间约为“检查间隔 × 阈值 + TTL + 缓存”、加权比例）；[01#tls](modules/01-edge-network-scaling.md#tls) 第 5 节（自签名 vs Let's Encrypt vs ACM：信任、签发者、有效期与续期方式、是否依赖入站 80、远端握手时间在边缘终止时明显下降）。

**SAA 考点**：公有与私有托管区域；Alias 与 CNAME（根域名只能 Alias，指向 AWS 资源的 Alias 查询免费）；路由策略（简单、加权、延迟、故障转移、地理位置、地理邻近、多值、基于 IP）；健康检查（端点、计算型、基于告警）；TTL；域名注册与 DNS 托管的区别；ACM DNS 验证与验证记录必须保留；证书区域要求；ACM 证书不可导出（可导出公有证书另行收费）；SNI；HSTS。

**验收标准**

- `[CAP]` dns.driver=`route53`，status=`ok`；`app.entry.source=dns`，`app.entry.baseUrl` 为 `https://album.example.com`。
- `[CAP]` tls.driver=`acm`，status=`ok`；`https.trusted=true`。
- `[PATH]` 直连入口出现 `tls=acm@nginx`（ACME 路径）或经 CDN 出现 `tls=acm@cloudfront`。
- `[RUN]` dns/ip-change-drill 有 before 与 after；tls/inspect 有 before 与 after，tls/handshake 至少两个区域。
- `[人工]` 证书查看器中签发者为 Amazon。

**清理**：先关闭 `TLS_FORCE_HTTPS` 与 HSTS，再按 `state.json` 的清理清单处理 ACME 端点、EAB 与证书（`scripts/module disable tls`）。托管区域按月计费，`disable dns` 默认保留它，确认不用时加 `--purge`。

---

## Lab 7：Web 应用防护——Nginx 限速 vs AWS WAF

**目标**：同一套攻击脚本分别打向直连入口（Nginx 处理）与 CloudFront 入口（AWS WAF 处理），比较拦截位置、限速精度、载荷识别与误杀。

**启用的模块**：[waf](modules/01-edge-network-scaling.md#waf)（`WAF_MODE=aws`，CLOUDFRONT 范围，Web ACL 在 us-east-1）。

**档位**：`l2-edge`。

**前置条件**：cdn 或 load-balancer（DEP-006；WAF 不能关联 EC2、EIP）；`CDN_DIRECT_ACCESS=admin-ip` 且包含实验机 IP，使两条路径都可达；`WAF_LAB_ALLOW_CIDR` 为空。所有攻击测试只针对自己的资源，保持低速率并遵守 AWS 渗透测试政策。

**步骤**

1. before（`WAF_MODE=nginx`）：`npm run exp -- waf --label before --scenario flood`、`--scenario payloads`、`--scenario false-positive`。
2. `scripts/module enable waf`：Web ACL 以 Count 模式部署并关联到分配（分配重新部署需数分钟）；BlocklistPort 切换到 `aws` 驱动，`denylist.conf` 同步到 IP 集合。
3. Count 模式下跑 `payloads` 与 `false-positive`，在 WAF 日志中检查误杀（CRS 会误杀大请求体上传）；按 [01#waf](modules/01-edge-network-scaling.md#waf) 第 6 节调整后，把 `WAF_RULE_ACTION` 切到 `block`。
4. after：`flood`（`TARGET=direct|edge` 两条路径）、`payloads`、`false-positive`；`--scenario bypass` 验证源站锁定。
5. 控制台：Web ACL 的 Sampled requests；Logs Insights `stats count() by terminatingRuleId, action`。

**对比实验**：[01#waf](modules/01-edge-network-scaling.md#waf) 第 5 节——Nginx 限速几乎立即生效但每个请求都到达 EC2；WAF 限速按窗口聚合、有检测延迟，被拦截的请求不到达源站，源站请求数保持平稳；托管规则对编码变体识别更强；Count → Block 的误杀；源站未锁定时的绕过（DEP-018）。

**SAA 考点**：WAF 的挂载点（CloudFront、ALB、API Gateway REST API、AppSync、Cognito User Pool 等；不能挂 EC2、EIP、NLB）；Web ACL、托管规则组、速率规则、IP 集合；Count 模式；WCU；日志目标与 `aws-waf-logs-` 前缀；Shield Standard 与 Advanced；Firewall Manager；安全组、NACL、WAF 的分层。

**验收标准**

- `[CAP]` waf.driver=`aws`，status=`ok`。
- `[VAL]` warnings 不含 DEP-018（入口已锁定）。
- `[PATH]` 被拦截的请求出现 `waf=aws:block-<规则名>`；直连路径上出现 `waf=nginx:ratelimit`。
- `[RUN]` waf/flood、waf/payloads 有 before 与 after；waf/bypass 有 after 结果。

**清理**：Web ACL 按月计费，不需要时 `scripts/module disable waf`（先解除关联再删除）；`WAF_LAB_ALLOW_CIDR` 保持为空。

---

## Lab 8：用户身份——Cognito User Pool 与 Identity Pool

**目标**：把本地账号体系换成 Cognito User Pool，比较安全责任、功能、性能与撤销语义；再用 Identity Pool 把 F14 的“应用自签前缀令牌”换成“STS 临时凭证 + IAM 策略变量”。

**启用的模块**：[auth](modules/02-identity-security.md#auth)（`AUTH_DRIVER=cognito`，`COGNITO_LOGIN_MODE=managed`，`AUTH_MIGRATION=bulk`）、[identity-pool](modules/02-identity-security.md#identity-pool)（设置 `IDENTITY_POOL_ID`，使用模块自带的暂存桶）。

**档位**：`l3-identity`。

**前置条件**：iam；托管登录需要受信 HTTPS（DEP-029）——借用 Lab 5 的 CloudFront 默认域名，或 Lab 6 的证书；identity-pool 需要 storage(s3) 与 auth(cognito)（DEP-002），在 http 站点上会得到 DEP-030 警告。

**步骤**

1. before（local）：`feature-matrix.ts`、`cloc` 统计自写代码量、`login-storm.k6.js`（同时看 CPU 与 CPU 积分）、`brute-force.k6.js`（记录响应码序列）、`revoke.ts`（登出后旧 access token 立即失效）。
2. `scripts/module enable auth`：部署 User Pool（App Client 的 `WriteAttributes` 不含 `custom:plan`）、批量迁移（`AdminCreateUser` 不发邀请；用户首次登录时走重置密码；不需要 Lambda）、`AUTH_DUAL_STACK=off`。
3. 用一个已迁移的账号登录，体验“首次登录重置密码”；新注册账号的验证邮件由 Cognito 发出，不再出现在 outbox（DEP-013 提示）。
4. after：重复第 1 步；Token 查看器对比 ES256（`iss=https://<host>`）与 RS256（`iss=https://cognito-idp…`）。如想运行时并排对比，临时开启 `AUTH_DUAL_STACK=on`，结束后关闭。
5. 托管登录：`COGNITO_LOGIN_MODE=managed`，登录跳转到 Cognito 托管登录页；路径头变为 `auth=cognito:managed`。
6. identity-pool before（token）：`npx tsx experiments/identity-pool/cross-prefix.ts --mode token`、`upload-bench.ts --mode token`。
7. `scripts/module enable identity-pool`（`UserPoolId` / `UserPoolClientId` 由 auth 的 `injects` 传入）。
8. after（sts）：`cross-prefix.ts --mode sts`（越权写入由 S3 返回 AccessDenied）、`upload-bench.ts --mode sts`、`resume.ts`；管理员带 `X-Compare-Bypass: identity-pool` 请求上传会话，对照本地前缀令牌。

**对比实验**：[02#auth](modules/02-identity-security.md#auth) 第 5 节——密码哈希不再存于本地库；功能矩阵（MFA、托管登录、锁定、威胁防护）；登录压测时 EC2 CPU 基本不受影响；暴力破解时的响应；登出后 refresh token 立即失效而本地验签的 access token 在过期前仍有效。[02#identity-pool](modules/02-identity-security.md#identity-pool) 第 5 节——授权由应用代码执行变为由 IAM 策略变量在 S3 端执行；每个文件对后端的请求数与分片数无关；服务端控制力变弱。

**SAA 考点**：User Pool（认证）与 Identity Pool（授权、换取临时凭证）；ID / access / refresh 令牌；授权码 + PKCE，公有客户端与机密客户端；Lambda 触发器（Pre Sign-up、Pre Token Generation、User Migration）；托管登录自定义域名需要 us-east-1 证书；Web 身份联合与 IAM 策略变量 `${cognito-identity.amazonaws.com:sub}`；预签名 URL、应用自签令牌与临时凭证的取舍；SSE-KMS 下分片上传还需要 `kms:Decrypt`；Cognito 与 IAM Identity Center；功能层级与共享责任模型。

**验收标准**

- `[CAP]` auth.driver=`cognito`，status=`ok`；identity-pool.driver=`cognito`，status=`ok`。
- `[CAP]` `features["F14.directUpload"].via` 为 `identity-pool:cognito`。
- `[VAL]` warnings 不含 DEP-030（站点是受信 HTTPS）；errors 不含 DEP-029。
- `[PATH]` 出现 `auth=cognito:managed`（或 `cognito:sdk`）与 `identity-pool=cognito:sts`。
- `[人工]` cross-prefix 的 sts 模式下，写别人前缀、列桶、删别人对象全部被 S3 拒绝；已迁移账号完成首次重置密码。

**清理**：确认 `AUTH_DUAL_STACK=off`；User Pool 按 MAU 计费，开了删除保护，`disable auth` 后需手动关闭删除保护再删除；`disable identity-pool` 会先清空暂存桶并中止未完成的分片上传。

---

## Lab 9：邮件与通知扇出——SES + SNS

**目标**：让邮件真正发出去（SES），并把“应用逐个发信”换成“一次 Publish、SNS 扇出”。

**启用的模块**：[email](modules/04-compute-async.md#email)（`EMAIL_DRIVER=ses`）、[notification](modules/04-compute-async.md#notification)（`NOTIFY_DRIVER=sns`）。

**档位**：`l3-identity`。

**前置条件**：iam；SES 发件身份（域名 + Easy DKIM，或单个邮箱）——dns 已启用时 DKIM 记录自动写入；沙盒期收件人也必须验证；notification 的管理员邮箱与每个用户订阅都需要点击确认邮件（人工）。

**步骤**

1. before：`npm run exp -- email --label before --scenario send-matrix`（SES 邮箱模拟器的 success / bounce / complaint 地址加一个你自己的邮箱，outbox 档全部写进 outbox）；`npm run exp -- notification --label before --scenario fanout`。
2. `scripts/module enable email --param Domain=mail.example.com`（或 `--param Email=you@example.com`），等待身份与 DKIM 验证成功。
3. email after：`send-matrix --label after`（退信、投诉经 SNS → SQS 回流并被标记）；`compare.ts`（`POST /api/lab/email/compare`）；`sandbox.ts`（发给未验证地址得到 `MessageRejected`）；在邮箱“显示原始邮件”检查 `dkim=pass`。
4. `scripts/module enable notification --param AdminEmail=you+admin@example.com`，确认订阅；`node dist/cli.js migrate-module notification up` 为已开启邮件通知的用户创建带 `userId` 过滤策略的订阅，逐个确认。
5. notification after：`fanout --label after`；`filter.ts --user u1`（只有 u1 收到，`NumberOfNotificationsFilteredOut` 增加）；`compare.ts`；停掉 worker 后发布事件，邮件照常到达，收件队列积压。

**对比实验**：[04#email](modules/04-compute-async.md#email) 第 5 节（邮件是否真正送达、DKIM/SPF、沙盒拒信、退信与投诉回流）；[04#notification](modules/04-compute-async.md#notification) 第 5 节（扇出耗时与接收人数的关系、订阅需要确认、过滤策略、worker 停止时仍能送达）。

**SAA 考点**：SES 身份验证、Easy DKIM、SPF、DMARC、自定义 MAIL FROM；沙盒与生产访问（按区域）；配置集与事件目标；抑制列表；EC2 默认限制出站 25 端口；SNS 扇出（SNS + SQS）、订阅过滤策略、原始消息传递、订阅级 DLQ、FIFO 主题；SNS、SES、EventBridge 的适用场景。

**验收标准**

- `[CAP]` email.driver=`ses`，status=`ok`（沙盒期 detail 标注“沙盒”）；notification.driver=`sns`，status=`ok`。
- `[RUN]` email/send-matrix 与 notification/fanout 都有 before 与 after。
- `[MOD]` `POST /api/lab/email/compare` 与 `POST /api/lab/notification/compare` 返回两种驱动的并排结果。
- `[人工]` 真实邮箱收到邮件且 `dkim=pass`；SNS 订阅状态为已确认。

**清理**：两个模块不按小时计费，可保留；`disable notification` 前确认 `migrate-module notification down` 已删除全部用户订阅；手工在外部 DNS 添加过的 DKIM 记录需手工删除。

---

## Lab 10：解耦——有/无 SQS

**目标**：比较 sync、memory、sqs 三档队列：接口延迟、CPU 削峰、进程崩溃时任务是否丢失、坏消息与 DLQ。

**启用的模块**：[queue](modules/04-compute-async.md#queue)（`QUEUE_DRIVER=sqs`），配合本地档 `IMAGE_PROCESSOR=worker`（否则缩略图仍在请求内生成，看不到队列的作用）。

**档位**：`l4-async`（单独开始用 `single/queue`，已自带 iam(role) 与 `IMAGE_PROCESSOR=worker`）。

**前置条件**：iam；`experiment.json` 要求 before（memory + worker）与 after（sqs + worker）两边都是 worker 档。

**步骤**

1. 参照：`QUEUE_DRIVER=sync`、`IMAGE_PROCESSOR=inline`，`npm run exp -- queue --label l0 --scenario upload-burst`（Lab 0 已跑过可跳过）。
2. before：`scripts/module enable queue --driver memory && scripts/module enable image-processing --driver worker`，`--label before`（第 30 秒重启 api）。
3. `scripts/module enable queue`（先重启 worker 再重启 api，从 memory 切换前自动排空），`--label after`（第 30 秒 `kill -9` worker）。
4. 坏消息：`npx tsx experiments/queue/poison.ts --count 1`，等它在 3 次接收后进入 DLQ；`dlq-replay.ts`（`StartMessageMoveTask`）或在 `/admin/jobs` 导出到 `failed_jobs`。
5. 运行时 A/B：`--label after --scenario upload-burst --ab`（`X-Compare-Bypass: queue`）。
6. 在 `/lab/m/queue` 卡片的第二栏查看“模块自带的 SQS 队列（不属于 queue 模块）”，理解它们与应用任务队列的区别。

**对比实验**：[04#queue](modules/04-compute-async.md#queue) 第 5 节——接口延迟从“包含处理”变为“只含入队”；CPU 曲线从尖峰变为平台；memory 档重启后 `jobs_lost > 0`，sqs 档 `kill -9` worker 不丢任务（可见性超时后重新出现，排空时间拉长）；坏消息进入 DLQ 后重放。

**SAA 考点**：标准队列与 FIFO；可见性超时与心跳；长轮询；DLQ、`maxReceiveCount`、`RedriveAllowPolicy` 与 redrive；消息保留期；消息大小上限（2025 年起 1 MiB，以官方文档为准）与 Extended Client 模式；竞争消费者；按“每实例积压”给 ASG 扩缩容；SQS、SNS、EventBridge、Kinesis 的选型；SSE-SQS 与 SSE-KMS。

**验收标准**

- `[CAP]` queue.driver=`sqs`，status=`ok`；image-processing.driver=`worker`。
- `[RUN]` queue/upload-burst：before 的 `biz.jobs_lost > 0`，after 的 `biz.jobs_lost = 0`，expect 无“不符合”。
- `[PATH]` 出现 `queue=sqs:queued` 与 `queue=sqs:bypass-inline`。
- `[人工]` 毒消息出现在 DLQ 后被导出或重放。

**清理**：SQS 不按小时计费，可保留；`disable queue` 时先只重启 api、等 worker 排空 SQS 再重启 worker，DLQ 导出到 `failed_jobs`。

---

## Lab 11：照片流水线——有/无 Lambda 与 Rekognition（扩展：Step Functions）

**目标**：把缩略图生成从 EC2 搬到 Lambda（inline、worker、lambda 三档对比），把“基础属性标签”换成 Rekognition 内容标签与自动审核；扩展部分用 Step Functions 编排整条流水线，比较“编舞”与“编排”。

**启用的模块**：[image-processing](modules/04-compute-async.md#image-processing)（`IMAGE_PROCESSOR=lambda`；cdn 已启用，固定 `IMAGE_RESULT_CHANNEL=queue`）、[tagging](modules/04-compute-async.md#tagging)（`TAGGER_DRIVER=rekognition`）；扩展 [workflow](modules/06-governance-cost.md#workflow)（`WORKFLOW_DRIVER=stepfunctions`）。

**档位**：`l4-async`；扩展用变体 `x-workflow`（`l4-async` + workflow，`IMAGE_PROCESSOR=worker`）。

**前置条件**：iam；lambda 档需要 storage(s3)（DEP-003）与工具链栈（`scripts/module bootstrap`，自动）；原图桶已开启 EventBridge 投递，Lambda 由 image-processing 栈自己的 EventBridge 规则异步调用（不在桶上配置通知，MUTEX-004）；cdn 已启用时 callback 回写会被源站校验挡住，`scripts/module` 自动选择 queue 通道（DEP-020）。workflow 与 `IMAGE_PROCESSOR=lambda` 互斥（MUTEX-005）。

**步骤**

1. 三档基线：`npm run exp -- image-processing --label before --scenario upload-burst`（inline）；同时另开终端运行 `neighbor.k6.js` 读 `/api/feed`；`--label worker-memory` 与 `--label worker-sqs` 各一次（Lab 10 已经是 worker + sqs）。
2. `scripts/module enable image-processing`，`--label after` 重复第 1 步；`npm run exp:report -- image-processing`。
3. 运行时 A/B：`--scenario upload-burst --ab`（`X-Compare-Bypass: image`，一半 EC2 当场处理，Lambda 随后的结果被幂等忽略）。
4. 冷启动：`cold-start.ts --idle 15m --samples 3`，用 Logs Insights 统计 `@initDuration`。
5. 限流：`throttle.ts --reserved 0 --hold 120s`（预留并发设为 0，照片停在 PROCESSING，恢复后被异步队列重试）；可选 buffer-queue 变体 `--param Trigger=buffer-queue --param MaxConcurrency=2`。
6. 失败路径：`failures.ts`（损坏的 JPEG 直接 FAILED 不重试；`FAULT_RATE=0.5` 时观察重试、失败队列与对账兜底）。
7. 费用：`cost.ts --run <runId> --price-request … --price-gbs … --price-ec2-hour …`（单价从官方定价页抄入，脚本不内置价格）。
8. tagging before：`npm run exp -- tagging --label before --scenario upload-and-search`（搜“狗”没有结果）。
9. `scripts/module enable tagging`；`npx tsx experiments/tagging/eval.ts`（同一张图带 / 不带 `X-Compare-Bypass: tagger`，经 `POST /api/lab/tagger/analyze` 并排分析，结果不落库）；`upload-and-search --label after`；`throttle.ts`；`moderation.ts --action log` 后切到 `enforce`；`migrate-module tagging up --backfill --dry-run` 估算调用次数。
10. 扩展（workflow）：`scripts/module profile apply x-workflow`——profile 的差异计划会先把 image-processing 从 lambda 档切到本地档 worker（避免 MUTEX-005），再启用 workflow；手工做法是 `scripts/module disable image-processing && scripts/module enable image-processing --driver worker && scripts/module enable workflow`（`disable` 没有 `--driver` 选项，禁用后会回到默认的 inline，所以要再显式启用 worker 档）→ `npm run exp -- workflow --label before|after --scenario upload-burst`；`retry-visibility`（`--param FaultRate=0.3`）；`worker-down`；`express-vs-standard`；`redrive`（仅 Standard，失败执行在 14 天内从失败步骤继续）。做完 `disable workflow` 并回到 `l4-async`。

**对比实验**：[04#image-processing](modules/04-compute-async.md#image-processing) 第 5 节（“上传完成”接口延迟、EC2 CPU 与 CPU 积分、缩略图就绪时间、冷启动、限流、失败目标）；[04#tagging](modules/04-compute-async.md#tagging) 第 5 节（标签 chips、按内容搜索、自动审核与误判、S3Object 与 Bytes 输入、TPS 限流）；[06#workflow](modules/06-governance-cost.md#workflow) 第 5 节（重试在执行图上逐次可见、worker 停机时状态机照常跑完、Standard 与 Express）。

**SAA 考点**：Lambda 三种调用模型（同步、异步、事件源映射）；异步调用的重试、最大事件年龄、Destinations 与 DLQ；预留并发与预置并发；内存与 CPU 成比例；arm64；冷启动与 INIT 计费；S3 事件通知、S3 → EventBridge、SNS 扇出三种路由与“重叠通知”限制；防递归；执行角色与资源策略；Rekognition 图像 API、TPS 配额、AI 服务数据使用与退出策略；Step Functions 的编排与编舞、Standard 与 Express、`Retry`/`Catch`、服务集成模式、S3 事件不能直接以 Step Functions 为目标。

**验收标准**

- `[CAP]` image-processing.driver=`lambda`，status=`ok`；tagging.driver=`rekognition`，status=`ok`。
- `[VAL]` warnings 不含 DEP-020（回写走 queue 通道）。
- `[PATH]` 出现 `image-processing=lambda:async`、`image-processing=inline:bypass` 与 `tagging=rekognition:s3-object`（或 `rekognition:bytes`）。
- `[RUN]` image-processing/upload-burst 有 before 与 after，expect 无“不符合”（complete 接口 p95 与 EC2 CPU 下降）；tagging/upload-and-search 有 before 与 after。
- 扩展：`[CAP]` workflow.driver=`stepfunctions`，status=`ok`，同时 image-processing.driver=`worker`；`[VAL]` errors 不含 MUTEX-005；`[RUN]` workflow/worker-down 有 after 结果；`[人工]` 控制台执行图中能数出重试次数。

**清理**：删除临时预置并发、预留并发与 `FAULT_RATE`；workflow 扩展做完后 `disable workflow`；Rekognition 按调用计费，backfill 前先 `--dry-run`；频繁重启的实验环境可设 `TAGGER_STARTUP_PROBE=off`。

---

## Lab 12：定时任务——node-cron vs EventBridge Scheduler

**目标**：让 `lab.heartbeat` 同时由两边触发，直观比较准时性、漏跑、重复执行与失败处理。

**启用的模块**：[scheduler](modules/04-compute-async.md#scheduler)（`SCHEDULER_DRIVER=eventbridge`，目标为模块自带的 tick 队列）。

**档位**：`l4-async`（启用后即完整的 `l4-async`）。

**前置条件**：iam；scheduler 自带 tick 队列，不依赖 queue 模块。

**步骤**

1. `scripts/module enable scheduler --driver cron --param CompareHeartbeat=on`（只写本地设置，不部署栈），重启 worker，跑 60 分钟基线：`npm run exp -- scheduler --label before --scenario heartbeat --duration 60m`。
2. `scripts/module enable scheduler`（所有 schedule 先以 DISABLED 创建，切换开关后再启用，避免两边都执行），`--label after --scenario heartbeat --duration 60m`。
3. 漏跑：`bash experiments/scheduler/missed-run.sh --job lab.heartbeat`（停 worker 跨过一个触发点）。
4. 重复执行：`bash experiments/scheduler/second-worker.sh`（第二个 worker 使用不同的锁目录模拟另一台主机）。
5. 目标失败：`bash experiments/scheduler/dlq-fault.sh`（执行角色临时拒绝 `sqs:SendMessage`，事件最终进入 `scheduler-dlq`）。
6. 在 `/admin/jobs` 查看 trigger 列（`cron` / `eventbridge`）与漏跑占位行。

**对比实验**：[04#scheduler](modules/04-compute-async.md#scheduler) 第 5 节——双触发时间线；cron 档停机漏跑、多实例重复执行，eventbridge 档恢复后补跑、每个计划时刻只执行一次；目标失败进入 DLQ。

**SAA 考点**：EventBridge Scheduler 与 EventBridge 定时规则的区别；`cron`、`rate`、`at` 表达式与时区；灵活时间窗口；模板化目标与通用目标；执行角色；重试与 DLQ；“单一调度器 + 队列”模式；SSM Run Command 作为目标；Lambda 作为定时任务目标的 15 分钟上限。

**验收标准**

- `[CAP]` scheduler.driver=`eventbridge`，status=`ok`。
- `[RUN]` scheduler/heartbeat 有 before 与 after，after 中每个计划时刻恰好一行。
- `[MOD]` `GET /api/admin/jobs/runs?name=lab.heartbeat` 中出现 `trigger=eventbridge` 的补跑记录（延迟约等于停机时长）。
- `[人工]` `scheduler-dlq` 中出现目标失败的事件。

**清理**：删除 dlq-fault 留下的内联策略（脚本会自动删除，确认即可）；不再对照时关闭 `CompareHeartbeat`。Scheduler 按调用计费，量级在免费额度之内。

---

## Lab 13：数据保护与配置——KMS + Secrets Manager + Parameter Store

**目标**：把本地主密钥换成 KMS 客户托管密钥（信封加密可审计、可撤销），把 `secrets.env` 换成 Secrets Manager（不重启轮换），把 `runtime.json` 换成 Parameter Store（远程热键）。**本 Lab 必须排在数据层之前**，使后面创建的 RDS、EFS 一开始就使用 CMK。

**启用的模块**：[kms](modules/02-identity-security.md#kms)（`KMS_KEY_ID=alias/cloudalbum`，`KMS_APPLY_TO=fields,ebs`：字段加密与数据卷换 CMK；S3 桶、Secrets Manager、引导配置包以及之后创建的 RDS、EFS 等，由 kms 的 `injects`（`target: "*"`）把 `KmsKeyArn` 注入所有声明了该参数的模块栈，因此 Lab 15 的 RDS 与 x-efs-asg 的 EFS 一创建就用 CMK）、[secrets](modules/02-identity-security.md#secrets)（`SECRETS_DRIVER=secretsmanager`，`SECRETS_ORIGIN=aws`）、[config](modules/02-identity-security.md#config)（`CONFIG_DRIVER=ssm`，只管运行时业务热键）。

**档位**：`l5-security`（`profile apply` 会按 `orderBefore` 先启用 kms）。

**前置条件**：iam；kms 的禁用演示必须用管理员自己的身份执行（应用角色没有禁用密钥的权限）。

**步骤**

1. before：`sudo bash experiments/secrets/leak-scan.sh --needle <前 8 位>`；kms 第 5 步的“本地主密钥风险”（主密钥与密文在同一数据卷上）；config 的 `propagation.ts --file`（登录实例改 `runtime.json` 计时）。
2. `scripts/module profile apply l5-security`（或依次 `enable kms`、`enable secrets`、`enable config`）。kms 启用后 `migrate-module kms up` 把字段从 `local-v1` 分批重新加密为 `kms-<KeyId>`；secrets 启用后数据卷上的 `secrets.env` 只剩 `SECRETS_ORIGIN=aws`（与 `IAM_KEYS_*`，若有）。
3. kms：`decrypt-count.ts --reupload`（Bucket Key 开 / 关各一次）；`field-read.k6.js` 带 / 不带 `X-Compare-Bypass: kms`；`disable-demo.sh`（禁用密钥后各层按缓存先后失败，重新启用后恢复）；在数据库中查看 `ca1.kms-…` 密文。
4. secrets：after 再跑 leak-scan；`rotate-under-load.k6.js`（env 档手工轮换与“直接覆盖”的失误 vs `/lab` 一键轮换，已登录用户不掉线）；`cloudtrail.ts --attr EventName=GetSecretValue`；`SECRETS_CACHE_TTL_SEC` 设为 0 与 300 比较调用次数。
5. config：`propagation.ts --key banner`；修改 `feedCacheTtlSec`、`logLevel`、`maintenanceMode` 观察热生效；`get-parameter-history` 后写回旧值；`reject-invalid`（写入非法值与 `CACHE_DRIVER` 这样的模块开关键，都被拒绝）；`GET /api/lab/config/diff`。

**对比实验**：[02#kms](modules/02-identity-security.md#kms) 第 5 节（CloudTrail 中可见 GenerateDataKey / Decrypt 与加密上下文；禁用密钥后各层缓存依次失效；Bucket Key 与数据密钥缓存让调用量下降一个数量级以上）；[02#secrets](modules/02-identity-security.md#secrets) 第 5 节（明文落盘位置、不重启轮换、读取审计、冷启动多一次调用）；[02#config](modules/02-identity-security.md#config) 第 5 节（远程热键的传播时间、版本与回滚、非法值与越权键被拒绝）。

**SAA 考点**：AWS 托管密钥、客户托管密钥、AWS 自有密钥；密钥策略与 IAM 策略（根主体语句）、`kms:ViaService`；信封加密与加密上下文；SSE-S3、SSE-KMS、DSSE-KMS、SSE-C；Bucket Key；只能在创建时加密的资源（RDS、EBS、EFS）与“快照复制再恢复”；共享加密快照需要 CMK；自动轮换；禁用与计划删除；Secrets Manager 与 Parameter Store（SecureString、标准 / 高级参数）的区别；轮换 Lambda 与版本标签；CloudFormation 动态引用；AppConfig（了解）。

**验收标准**

- `[CAP]` kms.driver=`kms`、secrets.driver=`secretsmanager`、config.driver=`ssm`，status 均为 `ok`。
- `[PATH]` 照片详情请求出现 `kms=kms:cache-hit` 与 `kms=kms:bypass`；出现 `config=ssm:v<n>`。
- `[VAL]` 第 5 步写入 `CACHE_DRIVER` 参数期间 warnings 出现 CFG-009，删除该参数后消失。
- `[MOD]` `GET /api/lab/config/diff` 显示 ssm 层为最终生效来源。
- `[人工]` CloudTrail 中能看到带加密上下文的 Decrypt 调用与 GetSecretValue 调用者；禁用演示后密钥已重新启用。

**清理**：确认 KMS 密钥处于 Enabled；删除 reject-invalid 写入的测试参数；Secrets Manager 删除默认有恢复窗口，反复练习时注意同名 secret 无法立即重建。三个模块都不按小时计费（CMK 与 secret 按月计费）。

---

## Lab 14：自定义 VPC（public 放置）

**目标**：把实例从默认 VPC 分阶段迁入分层的自定义 VPC（public 放置），获得 Gateway Endpoint、Flow Logs 与“没有默认路由的 data 子网”。**必须在启用任何 VPC 绑定模块之前完成**（DEP-016）。

**启用的模块**：[network](modules/01-edge-network-scaling.md#network)（`NETWORK_PLACEMENT=public`，`NatMode=none`）。

**档位**：`l6-data`。

**前置条件**：没有已部署的 VPC 绑定模块（load-balancer、database、db-proxy、cache、shared-fs、autoscaling、VPC 内 Lambda），否则加 `--cascade` 先禁用；迁移有分钟级停机窗口，需要提前告知。network 的 public 子网会自动分配公网 IPv4（`MapPublicIpOnLaunch=true`）：基础栈的 EIP 要等新实例发出 `cfn-signal` 后才关联，引导期间（`dnf`、下载发布包、`cfn-signal`）靠这个临时地址出网，否则 `CreationPolicy` 超时回滚（00 的 `preflight: ec2-public-ipv4-at-boot`）；如果改用已有 VPC 的子网，先确认该属性。

**步骤**

1. before：`npm run exp -- network --label before --scenario surface-scan --target <EIP>`（从 CloudShell）；`--scenario egress-path`。
2. `scripts/module enable network --placement public`：只读窗口 + 数据卷快照 → 记录密钥指纹 → 卸卷 → 基础栈在新子网替换实例（只安装、不挂卷、不启动）→ 改挂数据卷并执行 `cloudalbum-postattach` → 比对密钥指纹 → L0 冒烟测试；新实例先用自动分配的公网 IPv4 完成引导，收到信号后原 EIP 重新关联，公网地址与链接不变。
3. 控制台核对：VPC `10.0.0.0/16`，public / app / data 三层子网各两个 AZ（按 AZ ID 选择）；data 子网没有默认路由、只关联 Gateway Endpoint；data 子网的 NACL；Flow Logs。
4. after：`egress-path`（S3 / DynamoDB 走 Gateway Endpoint）、`surface-scan`（public 放置下攻击面与基线相同）、`cost-inventory`。
5. Flow Logs：用 Logs Insights 按 `dstport` 统计 REJECT、按 `traffic-path` 统计出站字节（查询见 `experiments/network/README.md`）。

**对比实验**：[01#network](modules/01-edge-network-scaling.md#network) 第 5 节——默认 VPC vs 分层自定义 VPC；实例迁移的停机窗口与“密钥指纹不变”；Gateway Endpoint；Flow Logs 中的 REJECT 与 `traffic-path`。private 放置的对比在 Lab 20。

**SAA 考点**：CIDR 规划与每个子网保留的 5 个地址；公有子网的定义（路由表指向 IGW）；路由表、IGW；安全组（有状态、作用于 ENI）与 NACL（无状态、作用于子网、要放行临时端口）；Gateway Endpoint 与 Interface Endpoint；Flow Logs 的目标与不记录的流量；实例不能在子网之间移动、EBS 绑定 AZ、跨 AZ 只能靠快照；AZ ID 与 AZ 名称；VPC Peering 与 Transit Gateway（了解）。

**验收标准**

- `[CAP]` network.driver=`public`，status=`ok`，detail 显示自定义 VPC。
- `[SMOKE]` 迁移后冒烟测试全部通过；`[MOD]` `GET /api/lab/self-check` 的密钥指纹检查项为 ok（与迁移前一致，`rebuild-drill` 同款校验）。
- `[RUN]` network/egress-path 有 before 与 after（after 中 S3、DynamoDB 经 Gateway Endpoint）；network/surface-scan 有 before 与 after。
- `[人工]` Flow Logs 中出现 REJECT 记录。

**清理**：public 放置默认没有 NAT 与 Interface Endpoint；Flow Logs 按摄取量计费，日志组保留 7 天。回退用 `scripts/module disable network`（反向迁移，同样受 DEP-016 约束）。

---

## Lab 15：关系数据库——SQLite → 自建 PG → RDS（扩展：PgBouncer → RDS Proxy）

**目标**：分清“换数据库引擎”与“换成托管服务”各自带来的变化；体验 Multi-AZ 故障转移、PITR 与只读副本；扩展部分比较应用内连接池、PgBouncer 与 RDS Proxy。

**启用的模块**：[database](modules/03-data-storage.md#database)（`DB_DRIVER=postgres`，`DB_HOST` 为 RDS 端点，单 AZ 起步，使用 CMK）；扩展 [db-proxy](modules/06-governance-cost.md#db-proxy)（`DB_PROXY_MODE=pgbouncer` → `rds-proxy`）。

**档位**：`l6-data`（扩展：`profile apply l6-data --with-optional`）。

**前置条件**：按顺序做时 kms（Lab 13，CMK 必须在创建前决定）与 network public（Lab 14）已完成；secrets 已启用时 RDS 使用托管主密码。**按小时计费**：RDS 实例（Multi-AZ、只读副本、PITR 恢复出来的实例各按一个实例计）、RDS Proxy。

**步骤**

1. 准备数据：`node dist/cli.js lab:seed --users 200 --albums-per-user 5 --photos 20000`。
2. 三档对比：`npm run exp -- database --label before --scenario mixed-rw --vus 10,50,200`（SQLite）；`scripts/module enable database --self-hosted` 后 `--label selfhost`（Lab 0 第二部分做过可跳过）；`scripts/module enable database`（RDS，只读窗口内停 worker、逐表迁移、`verify`）后 `--label after`；`npm run exp:report -- database --before before --after after`。
3. 故障转移：以 `MultiAz=true` 更新栈，`--scenario failover`（第 30 秒 `reboot-db-instance --force-failover`）；基线对照：`--label before` 时停止再启动实例。
4. PITR：`experiments/database/pitr.sh` 恢复到 10 分钟前的**新实例**（指定同一子网组与安全组），`db:verify` 比对行数后删除新实例。
5. 连接数：`--scenario conn-storm`（逐级调大 `DB_POOL_MAX`，配合 `LB_LOCAL_WORKERS=2`），在 CloudWatch 看 `DatabaseConnections`。
6. 只读副本（`CreateReadReplica=true`）：`--scenario replica-read --ab`（`X-Compare-Bypass: replica`）；`--scenario replica-lag`（写后立即从副本读）。
7. 回到 Lab 1 补做 cost 的 `visibility-lag`（RDS 刚创建时本地清单立即出现，Cost Explorer 数小时后才出现）与 `idle-reminder`。
8. 扩展（db-proxy）：`scripts/module enable db-proxy --driver pgbouncer` → `npm run exp -- db-proxy --label pgbouncer --scenario conn-storm`；`scripts/module enable db-proxy`（RDS Proxy，从 Secrets Manager 读取数据库凭证）→ `--label after` 重跑 `conn-storm`，再跑 `conn-churn`、`failover-proxy`、`pinning`、`hop-latency`。

**对比实验**：[03#database](modules/03-data-storage.md#database) 第 5 节——SQLite 单写者、同步驱动阻塞事件循环；RDS 每次查询多一次网络往返（亚毫秒到毫秒级），所以“换成 RDS 不会变快”；Multi-AZ 故障转移的写失败区间；PITR 恢复为新实例；只读副本的复制延迟。[06#db-proxy](modules/06-governance-cost.md#db-proxy) 第 5 节——数据库连接数从“进程数 × 池大小”变为平稳；短连接风暴的建连延迟；经代理的故障转移写失败区间更短；钉住；多一跳的延迟。

**SAA 考点**：Multi-AZ 实例部署、Multi-AZ 集群部署与只读副本；自动备份、PITR（恢复为新实例）、手动快照与跨区域复制；加密只能在创建时开启；托管主密码与 IAM 数据库认证；RDS Proxy（连接池化、缩短故障转移、凭证来自 Secrets Manager、不支持自建库）；安全组链与 `PubliclyAccessible=false`；停止的实例超过 7 天会自动启动；RDS、Aurora、DynamoDB、EC2 自建数据库的选型。

**验收标准**

- `[CAP]` database.driver=`postgres`，status=`ok`，detail 主机分类为 `rds`。
- `[PATH]` 出现 `database=postgres@rds`；只读副本实验期间出现 `database=postgres@rds:replica` 与 `postgres@rds:bypass`。
- `[RUN]` database/mixed-rw 有 before、selfhost、after；database/failover 有 after 结果。
- `[VAL]` errors 不含 MUTEX-002（自建 PG 与 RDS 二选一）。
- 扩展：`[CAP]` db-proxy.driver=`rds-proxy`，status=`ok`；`[PATH]` 出现 `database=postgres@rds-proxy`；`[RUN]` db-proxy/conn-storm 有 before（或 pgbouncer）与 after。

**清理**：练完立即处理按小时计费的资源：删除 PITR 恢复出的实例与只读副本，`MultiAz=false`，`disable db-proxy`；不再需要 RDS 时 `scripts/module disable database`（迁回 SQLite，删除栈时留下最终快照，快照需手工删除）。

---

## Lab 16：缓存——有/无 ElastiCache

**目标**：在同一部署中用 `X-Compare-Bypass: cache` 逐请求比较有缓存与无缓存；再比较 none、memory、自建 Valkey、ElastiCache 四档，看清“共享缓存”与“托管服务”各自的价值。

**启用的模块**：[cache](modules/03-data-storage.md#cache)（`CACHE_DRIVER=redis`，ElastiCache 节点模式）。

**档位**：`l6-data`。

**前置条件**：同一 VPC（按顺序做时已在 Lab 14 迁入自定义 VPC）；客户端启用 TLS；**按小时计费**：ElastiCache 节点。

**步骤**

1. `scripts/module enable cache`（部署后在实例上 `valkey-cli --tls … PING` 确认连通）。
2. 运行时 A/B：`npm run exp -- cache --label after --scenario feed-read --ab --vus 20 --duration 120s`；`/lab` 卡片上的“运行 A/B”按钮做同样的小样本对比。
3. 四档对比：同一 `feed-read`（不加 `--ab`）分别在 `before`（none）、`memory`、`selfhost`、`after` 下各跑一次。
4. TTL：`--scenario ttl-sweep`（运行器热改 `feedCacheTtlSec` 为 10、60、300，不重启）。
5. 陈旧读：`LB_LOCAL_WORKERS=2` 下 `--label memory --scenario stale-read`，启用 ElastiCache 后 `--label after` 重跑。
6. 击穿：`--scenario cache-stampede`。
7. 故障注入：`experiments/cache/faults/revoke-sg.sh` 期间运行 `feed-read`，确认请求全部成功、结果为 `error-bypass`、cache 变为 `degraded`，恢复后回到 `ok`。

**对比实验**：[03#cache](modules/03-data-storage.md#cache) 第 5 节——命中时每请求 DB 查询从若干次降到 0、P95 下降；单实例单进程时 memory 命中反而更快；多进程 memory 档出现陈旧读，redis 档陈旧比例为 0；TTL 与命中率；fail-open 时错误率保持为 0。

**SAA 考点**：cache-aside 与 write-through；TTL 与失效策略（删除 vs 版本号）；击穿、雪崩与 single-flight；Valkey / Redis OSS 与 Memcached；集群模式；Serverless 与节点模式；Multi-AZ 自动故障转移；只能在 VPC 内访问、TLS、AUTH / RBAC；缓存放在哪一层（CloudFront、API Gateway、ElastiCache、DAX）；会话与缓存外置是无状态化的前提。

**验收标准**

- `[CAP]` cache.driver=`redis`，status=`ok`，detail 显示 ElastiCache。
- `[PATH]` 出现 `cache=redis@elasticache:hit` 与 `cache=redis@elasticache:bypass`；故障注入期间出现 `cache=redis@elasticache:error-bypass`。
- `[RUN]` cache/feed-read 的 `--ab` 结果 expect 无“不符合”；cache/stale-read 的 after 陈旧比例为 0。
- `[VAL]` errors 不含 MUTEX-003（`REDIS_URL` 没有指向本机）。

**清理**：节点按小时计费，练完 `scripts/module disable cache`（缓存没有权威数据，直接删除）或把 `Replicas` 改回 0。

---

## Lab 17：Serverless 社交——DynamoDB + API Gateway

**目标**：把点赞、评论、分享链接从关系库搬到 DynamoDB，再把社交接口的入口从 EC2 上的 Express 换成 API Gateway；最终在 lambda 集成下停掉 EC2 的 api 进程，社交功能仍然可用。

**启用的模块**：[social-store](modules/03-data-storage.md#social-store)（`SOCIAL_DRIVER=dynamodb`）、[social-api](modules/04-compute-async.md#social-api)（`SOCIAL_API_BASE_URL` 指向 execute-api；先 `Integration=proxy`，最后 `Integration=lambda`、`Authorizer=jwt`）。

**档位**：`l7-serverless-social`。

**前置条件**：social-store 需要 iam；social-api 的 proxy 集成没有依赖，lambda 集成需要 social-store=dynamodb（DEP-022）与一个授权器（DEP-024），`jwt` 授权器要求 auth=cognito（DEP-023；auth=local 时用 Lambda 授权器读 `/.well-known/jwks.json`），以及工具链栈。auth=cognito 时 EC2 在 JIT 建档时写入 `custom:app_uid`。

**步骤**

1. social-store before：`npm run exp -- social-store --label before --scenario like-storm --vus 200 --duration 60s`，跑完 `GET /api/lab/social/verify` 校验计数。
2. `scripts/module enable social-store`（只读窗口内迁移，计数器项重新计算，写入照片摘要项）；`--label after` 重跑；`--scenario like-storm-sbs`（lab 命名空间侧路对比）；`--scenario naive-counter`（“先读后写”丢失更新）。
3. TTL：`--scenario share-ttl --detach`（持续数小时；db 对照组先 `scheduler:pause share.cleanup`）。
4. 限流：`scripts/module enable social-store --param BillingMode=PROVISIONED --param WriteCapacity=5`，重跑 like-storm，做完改回 `PAY_PER_REQUEST`。
5. social-api before：`npm run exp -- social-api --label before --scenario mixed`。
6. `scripts/module enable social-api --param Integration=proxy --param Authorizer=none`；按 URL 的 A/B：`compare.k6.js`（Express 与网关两个入口交替）；`throttle.k6.js` 与 `origin-count.ts`（超出限流的请求不到达 EC2）。
7. `scripts/module enable social-api --param Integration=lambda --param Authorizer=jwt`；`unauth.k6.js`（401 在网关层返回，没有 `X-CloudAlbum-Path`）；`cold-start.ts --idle 15m`；`ec2-down.sh`（停掉 `cloudalbum-api` 后点赞、评论、读评论仍成功）。

**对比实验**：[03#social-store](modules/03-data-storage.md#social-store) 第 5 节（并发点赞的计数正确性、丢失更新、TTL 后台回收、热点项与预置低 WCU 的限流）；[04#social-api](modules/04-compute-async.md#social-api) 第 5 节（多一跳的开销、429 与 401 发生在哪一层、EC2 停机时的可用性、冷启动）。

**SAA 考点**：分区键、排序键与单表设计；GSI 与 LSI；条件写入与事务；原子计数与热点、写分片；按需与预置容量；TTL；PITR、全局表、Streams；DAX；HTTP API 与 REST API；JWT 授权器（只支持 RSA 系列）与 Lambda 授权器；限流与 429；集成超时；VPC Link；在 API 前加 CloudFront 与 WAF；ALB 与 API Gateway 作为 API 入口的取舍。

**验收标准**

- `[CAP]` social-store.driver=`dynamodb`，status=`ok`；social-api.driver=`apigw`，status=`ok`。
- `[VAL]` errors 不含 DEP-022～024；warnings 不含 DEP-025（notification 为 sns 或 queue 为 sqs）。
- `[PATH]` 出现 `social-store=dynamodb`；proxy 集成阶段出现 `entry=apigw>nginx`。
- `[RUN]` social-store/like-storm 有 before 与 after；social-api/mixed 有 before 与 after。
- `[人工]` `ec2-down.sh` 输出的社交操作成功率接近 100%。

**清理**：确认计费模式已改回按需；share-ttl 的 detach 任务结束；两个模块都不按小时计费。

---

## Lab 18：点击流——Firehose + S3 + Athena

**目标**：把点击事件从业务库剥离出去，比较对主业务的影响、数据新鲜度、报表耗时随数据量的变化，以及 Athena 的扫描量。

**启用的模块**：[analytics](modules/03-data-storage.md#analytics)（`ANALYTICS_DRIVER=firehose`，模块自带事件桶、Athena 工作组、Glue 表）。

**档位**：`l6-data`（本 Lab 排在 Lab 17 之后，但模块属于 `l6-data`）。

**前置条件**：iam；事件桶由本模块自建，不依赖 storage。

**步骤**

1. before：`npm run exp -- analytics --label before --scenario clickstream-load --duration 10m`（背景同时读 `/api/feed`）；`node dist/cli.js lab:seed-events --target db --count 1000000` 后 `--scenario report-scale`。
2. `scripts/module enable analytics`。
3. after：`clickstream-load`；`lab:seed-events --target s3` 后 `report-scale`；`--scenario freshness`；`--scenario dedupe`；`--scenario clickstream-load --ab`（`X-Compare-Bypass: analytics` 测量采集开销）。
4. Athena 控制台：对 `experiments/analytics/partition-scan.sql` 加 / 不加 `dt` 条件各运行一次，记录 `Data scanned`；部署了 Parquet 变体时再对比格式。
5. 开启影子写（运行时 featureFlag `analytics.shadowDb`），在报表页一键切换数据源并排对比。

**对比实验**：[03#analytics](modules/03-data-storage.md#analytics) 第 5 节——db 驱动抢写锁、库文件持续膨胀 vs Firehose 只做批量转发；立即可查 vs 等一个缓冲间隔；报表耗时随 10^4～10^6 条数据的增长；分区条件与列式格式让扫描量下降几个数量级；至少一次投递与按 `eventId` 去重。

**SAA 考点**：Firehose、Kinesis Data Streams、SQS 的选型；缓冲与格式转换（Parquet 要求）；动态分区；S3 数据湖 + Athena + Glue Data Catalog 与分区投影；按扫描量计费与工作组扫描上限；OLTP 与 OLAP；Redshift（了解）。

**验收标准**

- `[CAP]` analytics.driver=`firehose`，status=`ok`。
- `[PATH]` `POST /api/events` 出现 `analytics=firehose`。
- `[RUN]` analytics/clickstream-load 与 analytics/report-scale 有 before 与 after；analytics/freshness、dedupe 有 after 结果。
- `[人工]` Athena 同一查询加分区条件后扫描量明显下降。

**清理**：不按小时计费；确认工作组扫描上限仍在；事件桶因 `Retain` 保留，`--purge` 才删除。

---

## Lab 19：负载均衡——Nginx 单机 vs ALB（含 F12 组合子功能）

**目标**：直连入口与 ALB 同时在线，比较滚动重启的可用性、健康检查与失效开放；挂上区域证书后启用 HTTPS 监听器与 `authenticate-cognito`；把 CloudFront 的源站切到 ALB，为 Lab 20、21 铺路。

**启用的模块**：[load-balancer](modules/01-edge-network-scaling.md#load-balancer)（`LB_MODE=alb`；有域名时 `LB_ADMIN_AUTH=cognito`）。

**档位**：`l8-ha`。

**前置条件**：同一 VPC 中至少两个 AZ 的子网；HTTPS 监听器需要 tls（区域证书）与域名；F12 需要 auth(cognito) + HTTPS 监听器（DEP-011 / DEP-017）。**没有域名**（跳过了 Lab 6）时不设 `LB_ADMIN_AUTH`、不建 HTTPS 监听器：F12 的 ALB 认证子功能按 DEP-011 关闭，应用层 RBAC 照常；`profiles/l8-ha.env` 把 `LB_ADMIN_AUTH=cognito` 写在 `PROFILE_GATED=domain:…` 中，域名前置不满足时自动跳过，不会触发 DEP-017。第 4 步与验收中的 F12 项相应跳过。**按小时计费**：ALB（另有每个节点的公网 IPv4）。

**步骤**

1. 滚动重启三种配置：`npm run exp -- load-balancer --label before --scenario rolling-restart`——(a) 单进程；(b) `LB_LOCAL_WORKERS=2` + 滚动重启（Lab 0 已做可跳过）。
2. `scripts/module enable load-balancer`：注册当前实例，投放 realip 片段；过渡期保留 EIP 直连用于对比。
3. (c) ALB 单目标：`--label after --scenario rolling-restart`（`TARGET=direct|alb`）；`--scenario health-fail`（单目标健康检查失败时 ALB 失效开放）；`--scenario latency`；`/lab` 的“请求头回显”对比 `X-Forwarded-For`。
4. HTTPS 与 F12：tls 注入区域证书后启用 HTTPS 监听器与基于 `$ca_proto` 的跳转；`LB_ADMIN_AUTH=cognito` 后访问 `/admin` 直接跳转 Cognito 登录（`/api/admin/*` 未认证时直接拒绝）。
5. 把 CloudFront 源站切到 ALB：`scripts/module enable cdn --origin alb`；然后 `LB_LOCK_ORIGIN=on` 锁定入口。
6. (d) ALB + 两台实例的滚动重启留到 Lab 21 完成后再跑一次。
7. 可选：用 Athena 查询 S3 中的 ALB 访问日志，或在 Logs Insights 查询 vended logs（新能力，考试题库可能仍按“只能 S3”出题）。

**对比实验**：[01#load-balancer](modules/01-edge-network-scaling.md#load-balancer) 第 5 节——入口链从 `nginx` 变为 `alb>nginx`；单目标时 ALB 本身不提供高可用；健康检查失效开放；ALB 增加的延迟在毫秒级；TLS 卸载。

**SAA 考点**：ALB、NLB、GWLB、CLB 的区别；监听器规则与目标组类型；健康检查与失效开放；跨区负载均衡；注销延迟；粘性会话的代价；`authenticate-cognito` / `authenticate-oidc`（只能用于 HTTPS 监听器）；用 ACM 做 TLS 卸载与 SNI；加权目标组；访问日志；ALB 至少两个 AZ、IP 会变化（需要固定 IP 时用 NLB 或 Global Accelerator）。

**验收标准**

- `[CAP]` load-balancer.driver=`alb`，status=`ok`；`features["F12.albAuth"].enabled=true`（有域名并完成第 4 步时；没有域名时为 false 且 warnings 中出现 DEP-011，属预期）。
- `[PATH]` 出现 `entry=alb>nginx`；CloudFront 源站切换后出现 `entry=cloudfront>waf>alb>nginx`（启用了 waf 时）。
- `[VAL]` 锁定入口后 warnings 不含 SEC-002；有域名时不含 DEP-011；errors 不含 DEP-017。
- `[RUN]` load-balancer/rolling-restart 有 before（a、b）与 after（c）；load-balancer/health-fail 有 after 结果。

**清理**：ALB 按小时计费。如果暂时不继续 Lab 20、21，先把 dns 与 cdn 源站切回 EIP，再 `scripts/module disable load-balancer`。

---

## Lab 20：私有化——network 切换为 private 放置

**目标**：在同一个 VPC 内把实例从 public 子网换到 app 私有子网：外部扫描再也碰不到实例，出网改走 NAT，S3 / DynamoDB 走 Gateway Endpoint；体会私有子网对“出网路径”的依赖。

**启用的模块**：[network](modules/01-edge-network-scaling.md#network)（`NETWORK_PLACEMENT=private`，NAT 或 Interface Endpoint 二选一）。

**档位**：`l8-ha`。

**前置条件**（DEP-009，缺一不可）：入口——load-balancer（Lab 19），或 cdn 且 `CDN_ORIGIN_TYPE=vpc-origin`；出网路径——`--nat gateway|instance`；或 `--nat none` 时同时满足：Interface Endpoint（`--endpoints ops|all`，都包含替换实例时 `cfn-signal` 需要的 `cloudformation`）覆盖每个需要调用 AWS / 公网 API 的模块、`IAM_CREDENTIALS=role`、工具链栈存在（`scripts/module` 先把发布包复制到工具链栈制品桶的 `releases/` 前缀，新实例经 S3 Gateway Endpoint 下载；GitHub Release 在没有 NAT 时不可达）；运维通道——shell-access（Lab 2），或 EC2 Instance Connect Endpoint。同一 VPC 内切换不触发 DEP-016。**按小时计费**：NAT Gateway（没有流量也计费）、Interface Endpoint（每个端点每个 AZ）。

**步骤**

1. before：`npm run exp -- network --label before --scenario surface-scan --target <EIP>`；`--scenario egress-path`；`--scenario scan-count`。
2. `scripts/module enable network --placement private --nat gateway`（或 `--nat instance`、`--nat none` 加 `--endpoints all`）：同一 VPC 内分阶段替换实例到 app 子网，ALB 目标改为新实例；密钥指纹前后一致。`--nat none` 时新实例的引导出网全部走 Endpoint：`dnf` 经 S3 Gateway Endpoint，发布包从工具链栈的镜像下载（`AppArchiveUrl` 随这次替换改为 `s3://` 地址），`cfn-signal` 经 `cloudformation` Interface Endpoint。
3. after：`surface-scan`（目标填 ALB DNS / CloudFront 域名与原 EIP）、`egress-path`（出网 IP 变为 NAT 的 EIP）、`scan-count`。
4. Endpoint 验证：`--label after --scenario endpoint-only`（第 10 秒删除 `0.0.0.0/0 → NAT` 路由，3 分钟后恢复）：S3 / DynamoDB 仍可访问，checkip 超时，依赖公网 API 而没有 Endpoint 的模块（例如 email、tagging）变为 `degraded` 或 `error`。
5. 运维：只能经 Session Manager（或 EIC Endpoint）登录；`scripts/module status` 的投递通道仍是 ssm。
6. 可选：CloudFront VPC Origin + internal ALB（东京的 `apne1-az3` 不支持 VPC Origin，network 默认不选它）。
7. `--scenario cost-inventory` 列出仍在计费的 NAT 与 Endpoint。

> 2026 新能力（仅作了解）：ACM 的 ACME 签发在 2026-10 起支持经 AWS PrivateLink（Interface Endpoint）访问，私有子网中的实例无需经公网即可续期 ACME 证书（AWS What's New 2026-10，核实于 2026-10-13）。本项目 private 放置时 TLS 在 CloudFront / ALB 终止，不依赖这一能力。

**对比实验**：[01#network](modules/01-edge-network-scaling.md#network) 第 5 节——外部 nmap 从“80/443 开放”变为扫不到实例；打到实例的扫描请求降到接近 0；出网 IP 变为 NAT EIP；删除 NAT 路由后 Gateway Endpoint 仍可用；NAT 是本组实验中最显著的固定成本之一。

**SAA 考点**：NAT Gateway 与 NAT 实例（托管、可用性、带宽、安全组、源/目标检查）；单 AZ NAT 的单点问题；Interface Endpoint（PrivateLink）按小时计费与 Gateway Endpoint 免费；Endpoint 策略；CloudFront VPC Origin；EC2 Instance Connect Endpoint；私有子网中 Lambda、SSM 的出网需求；IPv6 出网用 Egress-only Internet Gateway。

**验收标准**

- `[CAP]` network.driver=`private`，status=`ok`；network 的 detail 显示实例没有公网 IPv4（感知器经 IMDS 读取）。
- `[VAL]` errors 不含 DEP-009。
- `[RUN]` network/surface-scan 的 after 中实例开放端口数为 0；network/endpoint-only 有 after 结果（S3 / DynamoDB 成功、checkip 超时）。
- `[SMOKE]` 迁移后冒烟测试（经 ALB 或 SSM 端口转发执行）全部通过。

**清理**：NAT 与 Interface Endpoint 按小时计费。暂停学习时最省钱的做法是 `scripts/module profile apply l0-ec2`，或把放置方式改回 `public` 并设 `NatMode=none`、`InterfaceEndpoints=none`；只删 NAT 路由而保持 private 放置会让依赖公网 API 的模块失效。

---

## Lab 21：弹性伸缩与无状态设计（含 EFS 变体；前置或扩展：黄金 AMI）

**目标**：从单实例变成 ASG：路径头中 `inst` / `az` 在多台实例间轮换，压测时自动扩容，终止实例后自动补齐，实例刷新接近零错误；故意用不安全组合看清“为什么启动校验要拦住它们”；比较 User Data 现场安装与黄金 AMI 的扩容速度；变体比较 EFS 与 S3 作为共享存储。

**启用的模块**：[autoscaling](modules/01-edge-network-scaling.md#autoscaling)（`DEPLOY_MODE=asg`，引导配置包在 SSM SecureString）；前置或扩展 [ami](modules/06-governance-cost.md#ami)（`AMI_SOURCE=golden`）；变体 [shared-fs](modules/03-data-storage.md#shared-fs)（`STORAGE_DRIVER=efs`）。

**档位**：`l8-ha`（`--with-optional` 带上 ami）；变体 `x-efs-asg`。

**前置条件**：iam(role)、load-balancer（DEP-007）；database 为 RDS（ASG-002 / ASG-003 不可覆盖）；storage(s3) 或 shared-fs（ASG-001）；共享密钥 `SECRETS_ORIGIN=bundle` 或 `aws`（ASG-007 / ASG-008）。从单一 IP 压测前设置 `WAF_LAB_ALLOW_CIDR`。**按小时计费**：ASG 中的每台实例、构建黄金 AMI 时的构建实例、实验用的临时实例。

**步骤**

1. （前置，可选）黄金 AMI：`scripts/module enable ami --no-switch`（部署管道，`ami build` 每个所需架构 → `ami promote`，只注入 autoscaling、不替换 L0 实例）；`npm run exp -- ami --label before|after --scenario boot-time`；`--scenario dependency-failure`（只放行区域 S3 前缀列表时，公共 AMI 下载发布包失败，黄金 AMI 照常完成）；`--scenario staleness`。
2. 一致性基线：`npm run exp -- autoscaling --label before --scenario stateless-check`（single）。
3. `scripts/module enable autoscaling`：校验 `DEPLOY_MODE=asg` 下 error 清零 → 渲染引导配置包写入 SSM SecureString → 以 Desired=1 部署 → 注销 L0 实例 → Desired=2。之后其他模块的启停自动切换为“机群模式”（更新引导配置包 + 实例刷新）。
4. after：`stateless-check --label after`；`--scenario scale-out`（CPU 目标跟踪 50%）；`--scenario max-toggle`（运行时比较“固定一台”与“可以扩容”）；`--scenario terminate-drill`；`--scenario refresh`（`MinHealthyPercentage=100`、`MaxHealthyPercentage=200`）。回到 Lab 19 跑配置 (d) 的 `rolling-restart`。
5. 不安全组合（教学）：`CLOUDALBUM_ALLOW_UNSAFE=ASG-001,ASG-004,ASG-005,ASG-006,ASG-007`，把对应驱动改回本地实现，实例刷新后 `stateless-check --label unsafe`：随机 401、约 1/N 的图片 404、缓存新旧交替、日报重复、缩容丢任务。演示结束立即恢复。
6. （扩展）ami：分别在 `AMI_SOURCE=userdata` 与 `golden` 下重跑第 4 步的 `scale-out` 与 `refresh`，记录新实例从 `Pending` 到目标组 `healthy` 的耗时与刷新总时长。
7. （变体）`scripts/module profile apply x-efs-asg`（storage 与 shared-fs 互斥，MUTEX-001；按 [03#shared-fs](modules/03-data-storage.md#shared-fs) 第 6 节迁移）：`npm run exp -- shared-fs --label after --scenario fs-bench`（EBS / EFS / S3 小文件延迟）、`--scenario cross-instance`（跨实例可见性）、`faults/revoke-2049.sh`。

**对比实验**：[01#autoscaling](modules/01-edge-network-scaling.md#autoscaling) 第 5 节（实例数随负载变化、自愈、实例刷新、无状态一致性表、不安全组合的症状）；[06#ami](modules/06-governance-cost.md#ami) 第 5 节（开机到可服务的耗时、启动时的外部依赖、镜像老化）；[03#shared-fs](modules/03-data-storage.md#shared-fs) 第 5 节（跨实例可见性、小文件元数据操作变慢）。

**SAA 考点**：启动模板；伸缩策略（目标跟踪、步进、简单、预定、预测）；冷却与实例预热；健康检查类型（EC2 / ELB）与宽限期；生命周期钩子；实例刷新；暖池；混合实例与 Spot（中断通知、Capacity Rebalance）；无状态设计；按 SQS 积压伸缩；黄金 AMI 与 User Data 的取舍、EC2 Image Builder（组件、配方、管道、分发）、AMI 的区域性与共享加密 AMI；EBS、EFS、S3 的选择；EFS 挂载目标、访问点、性能与吞吐模式、One Zone。

**验收标准**

- `[CAP]` autoscaling.driver=`asg`，status=`ok`；`app.deployMode=asg`。
- `[PATH]` 最近 20 个请求的 `inst=` 至少出现两个不同实例，`az=` 至少两个不同 AZ。
- `[RUN]` autoscaling/stateless-check 有 before、after 与 unsafe；after 全部通过；autoscaling/terminate-drill 与 refresh 有结果。
- `[VAL]` 实验结束时 `validation.overridden` 为空（已撤销 `CLOUDALBUM_ALLOW_UNSAFE`）。
- 扩展：`[CAP]` ami.driver=`golden`，status=`ok`；`[RUN]` ami/boot-time 有 before 与 after。变体：`[CAP]` shared-fs.driver=`efs`，status=`ok`；`[RUN]` shared-fs/cross-instance 的 after 为“可见”。

**清理**：实验结束先把 desired 与 min 设为 0，或 `scripts/module disable autoscaling` 回到单实例；删除临时实例与 `second-instance` 栈；黄金 AMI 默认只保留最近几个版本，`disable ami --purge` 注销本项目的 AMI 并删除快照；SSM 高级参数（如使用）按月计费。

---

## Lab 22：链路追踪——Server-Timing → 本地 span → X-Ray

**目标**：比较 none、local、xray 三档能看到的范围；理解哪些链路能串成一条 trace（api → SQS → worker），哪些不能（上传 → S3 → EventBridge → 缩略图 Lambda 是另一条 trace，用 `photo_id` 关联）。

**启用的模块**：[tracing](modules/05-ops-observability.md#tracing)（`TRACING_DRIVER=xray`；image-processing 经注入开启 `Tracing=Active`）。

**档位**：`l9-full`。

**前置条件**：local 档不需要 AWS；xray 档需要 iam(role)（Collector 用实例角色写入）、本机 CloudWatch Agent（版本满足 W3C trace ID 转换）。

**步骤**

1. before：none 档下 `POST /api/lab/faults {"type":"latency","target":"database","ms":300,"rate":0.3,"durationSec":600}`，`npm run exp -- tracing --label before --scenario slow-hunt`（只用 Server-Timing 与本地瀑布图定位，记录步骤数）；`--scenario overhead`（none 档基准）。
2. `scripts/module enable tracing --driver local`（Lab 0 做过可跳过），`walkthrough` 看本机 span 树。
3. `scripts/module enable tracing`（xray）：`walkthrough`（记录 trace 出现在 X-Ray 中的耗时）；`slow-hunt --label after`（服务地图与过滤表达式 `responsetime > 0.3`）；`overhead --ab`（强制采样 vs `X-Compare-Bypass: tracing`）；`propagation`。
4. 控制台：Trace Map；确认 CloudFront 与 ALB 不以节点出现（ALB 只注入 `X-Amzn-Trace-Id`）。

**对比实验**：[05#tracing](modules/05-ops-observability.md#tracing) 第 5 节——单跳 Server-Timing vs 本机 span 树 vs 服务地图；跨进程、跨 AWS 服务的链路只有 X-Ray 能串起来；追踪开销在亚毫秒到数毫秒量级；trace 要几秒到几十秒才出现。

**SAA 考点**：trace、segment、subsegment；annotation 与 metadata；采样规则（不需要重新部署）；服务地图；Lambda 主动追踪；API Gateway REST API 支持 X-Ray、HTTP API 不支持；ALB 与 CloudFront 不产生 segment；X-Ray Daemon、ADOT、CloudWatch Agent；X-Ray、CloudWatch、CloudTrail 的分工。

**验收标准**

- `[CAP]` tracing.driver=`xray`，status=`ok`。
- `[PATH]` 出现 `tracing=xray:sampled`（以及 `xray:not-sampled`）；local 阶段出现 `tracing=local:recorded`。
- `[RUN]` tracing/propagation 的 expect 符合：api 与 worker 的 span 属于同一个 trace ID；Lambda 是另一条 trace，两者带同一个 `photo_id`。
- `[RUN]` tracing/slow-hunt 有 before 与 after。

**清理**：采样规则保持默认；如开启过 X-Ray Insights 或 Transaction Search，在控制台关闭。xray 按记录与检索的 trace 数计费。

---

## Lab 23：审计与威胁检测——CloudTrail + GuardDuty

**目标**：用“谁删了这张照片”演练两层审计的互补关系；用覆盖矩阵比较 fail2ban + 本地分析器与 GuardDuty 各自能发现什么。

**启用的模块**：[audit](modules/05-ops-observability.md#audit)（`AUDIT_MODE=cloudtrail`）、[threat-detection](modules/05-ops-observability.md#threat-detection)（`THREAT_DETECTION_MODE=guardduty`）。

**档位**：`l9-full`。

**前置条件**：`preflight: existing-trail` 与 `existing-detector`——账号里已有多区域 / 组织 trail 或 detector 时默认**只读接入**，不创建第二份收费的管理事件副本；S3 数据事件需要 storage(s3)；展示需要 iam。所有攻击测试只针对自己的资源，并遵守 AWS 渗透测试政策。

**步骤**

1. before：`npm run exp -- audit --label before --scenario who-deleted`（四个场景：最终用户删照片；运维者绕过应用 `aws s3 rm`；安全组加一条规则再撤销；临时分离 storage 的 `PolicyArn` 制造 AccessDenied 再恢复）。`--label before --scenario web-scan`（threat-detection）。
2. `scripts/module enable audit --param DeliverToLogs=true`（数据事件默认只记录写事件）。
3. audit after：`who-deleted --label after`（输出“场景 × 来源”的可追溯矩阵与首次可见时间）；`--scenario validate-logs`（在测试副本上演示 digest 校验）；`faults/tamper-audit.sh` 后 `GET /api/admin/audit/verify` 报告哈希链断点，再演示“重算整条链”也能骗过本地校验。
4. `scripts/module enable threat-detection --with-sample`。
5. threat-detection after：`--scenario sample-findings`（示例发现经 EventBridge → SNS 送达，结束后归档）；`login-bruteforce.k6.js`（`cloudalbum-auth` jail 秒级封禁，GuardDuty 一侧无发现）；`web-scan --label after`；可选 DNS 金丝雀（真实发现，实验后归档）。
6. 在 `/lab` 安全面板查看覆盖矩阵：应用层爆破与 Web 扫描只有左栏能检出；恶意 DNS、凭证外泄、异常 API 调用只有右栏能检出；GuardDuty 只告警不阻断。

**对比实验**：[05#audit](modules/05-ops-observability.md#audit) 第 5 节（Event History 90 天、仅管理事件 vs trail 长期留存、S3 数据事件、完整性验证）；[05#threat-detection](modules/05-ops-observability.md#threat-detection) 第 5 节（覆盖矩阵、能否阻断、实例被攻陷后检测是否失效）。

**SAA 考点**：CloudTrail Event History 与 trail；管理事件、数据事件、Insights 事件；多区域 trail 与组织 trail；日志文件完整性验证、S3 对象锁（可在已有桶上开启且不可逆）、SSE-KMS；trail 投递到 CloudWatch Logs + 指标过滤器告警；全局服务事件在 us-east-1；用 CloudTrail 排查 AccessDenied；GuardDuty 的数据源、发现严重度、示例发现、自动响应（EventBridge）；GuardDuty、Inspector、Macie、Detective、Security Hub 的区别；GuardDuty、WAF、Shield、Network Firewall 各管哪一层。

**验收标准**

- `[CAP]` audit.driver=`cloudtrail`，status=`ok`（detail 注明新建或复用已有 trail）；threat-detection.driver=`guardduty`，status=`ok`。
- `[RUN]` audit/who-deleted 有 before 与 after；after 中运维者的 `DeleteObject` 与 AccessDenied 都可追溯。
- `[MOD]` 篡改实验后 `GET /api/admin/audit/verify` 报告断点位置。
- `[RUN]` threat-detection/sample-findings 有 after 结果；`[人工]` 收到 EventBridge → SNS 的发现邮件。

**清理**：归档示例发现与 DNS 金丝雀发现；确认账号里没有第二个收费的 trail；GuardDuty 不用时 `disable threat-detection` 会暂停 detector（`--purge` 才删除）；日志桶对象锁保留期内删不掉，学习环境不要设长保留期。

---

## Lab 24：备份与灾备——AWS Backup

**目标**：在克隆环境中做“卷丢失”灾难演练，记录 RPO 与 RTO；用 AWS Backup 按 `Backup=true` 标签一次纳入 EBS、RDS、DynamoDB、EFS、S3，并从大阪区域的副本恢复。放在最后，是为了一次纳入全部数据资源。

**启用的模块**：[backup](modules/03-data-storage.md#backup)（`BACKUP_MODE=aws`，复制到 `ap-northeast-3`）。

**档位**：`l9-full`（启用后即完整的 `l9-full`）。

**前置条件**：区域资源类型 opt-in（跨区域复制 DynamoDB 需开启 AWS Backup 的 DynamoDB 高级功能，预检自动执行）；先部署灾备区域的备份库栈；部署者需要 `iam:CreateRole`、`iam:PassRole`。演练实例与恢复出来的 RDS 实例**按小时计费**；演练**只在克隆环境中执行**，从不碰正在运行的实例。

**步骤**

1. 克隆：`experiments/backup/drill.sh clone`（`create-image --no-reboot` 后起一台演练实例，全程不启动 api 与 worker，避免连上线上 RDS、消费线上队列）。
2. before：`drill.sh disaster --scenario volume-loss --label before`，只能用手动快照恢复（若有）：`drill.sh restore --from manual-snapshot`；记录 RPO、RTO（从未做过手动快照时结果是“数据全部丢失”）。
3. `scripts/module enable backup`，立即 `aws backup start-backup-job` 生成恢复点（或等待一个计划周期）。
4. after：同样制造灾难后 `drill.sh restore --from aws-backup`：EBS 恢复点 → 新卷挂到演练实例；RDS → 恢复为新实例并改 `DB_HOST`；DynamoDB → 恢复为新表；`node dist/cli.js verify --all` 比对数据（CFG-007 密钥指纹校验也会通过——EBS 恢复点里带着 `etc/` 中的原密钥）。
5. 区域故障演练：在 `ap-northeast-3` 用复制过去的恢复点恢复一次 EBS 卷，只验证数据可读。
6. 防误删：governance 模式的 Vault Lock 下尝试删除恢复点，观察被拒绝（具有特定权限的身份仍可绕过 governance，这正是它与 compliance 模式的区别）。
7. `drill.sh cleanup`。

**对比实验**：[03#backup](modules/03-data-storage.md#backup) 第 5 节——同盘本地备份在大多数灾难场景下与数据一起丢失 vs 独立备份库与跨区域副本；RPO 从“可能全丢 / 日级”到“不超过计划间隔，连续备份可到分钟级”；RTO 从依赖人工的小时级到几分钟到几十分钟（RDS 通常最慢）。

**SAA 考点**：AWS Backup 的计划、规则、备份库与按标签选择资源；跨区域、跨账号复制；Vault Lock（governance 与 compliance）；Restore Testing；EBS 快照（增量、可跨区域复制）与 Data Lifecycle Manager；RDS 自动备份 / 手动快照 / AWS Backup；DynamoDB PITR；复制不等于备份；RPO、RTO 与四种灾备策略（备份与恢复、Pilot Light、Warm Standby、多站点主动 / 主动）。

**验收标准**

- `[CAP]` backup.driver=`aws`，status=`ok`，detail 列出数据卷等资源的最近恢复点。
- `[RUN]` backup 演练的 before 与 after 结果都已上传（RPO、RTO、数据完整性）。
- `[人工]` 大阪区域存在复制的恢复点并成功恢复出可读的卷；Vault Lock 下删除恢复点被拒绝。

**清理**：`drill.sh cleanup` 删除演练实例、AMI 及其快照（含机密）、恢复出来的卷 / 实例 / 表；恢复点会计费到过期或被显式删除，`disable backup` 默认保留备份库与恢复点。

---

## Lab 25（可选）：合规与漏洞——AWS Config + Amazon Inspector

**目标**：用覆盖矩阵看清“本地自检只看得到本机、AWS Config 只看得到 AWS 资源”的互补关系；用金丝雀包比较本地 `dnf` 安全公告 + `npm audit` 与 Inspector 持续扫描。与 Lab 23 一起形成“CloudTrail、GuardDuty、Config、Inspector 四个安全服务”的对照（Macie 只作为可选扩展了解，见 [saa-coverage.md](saa-coverage.md)）。

**启用的模块**：[compliance](modules/06-governance-cost.md#compliance)（`COMPLIANCE_MODE=config`）、[vuln-scan](modules/06-governance-cost.md#vuln-scan)（`VULN_SCAN_MODE=inspector`）。

**档位**：`l9-full --with-optional`。

**前置条件**：`preflight: existing-config-recorder` 与 `existing-inspector`——已存在时只读接入；vuln-scan 需要 iam(role)（DEP-035，EC2 扫描依赖 SSM 托管节点）；**Inspector 的激活是账号级的**，本区域所有实例与函数都会被扫描和计费；确认订阅邮件（人工）；Inspector 语言包清单默认每 6 小时采集一次、网络可达性每 12 小时扫描一次，需要等待。

**步骤**

1. before：`npm run exp -- compliance --label before --scenario coverage-matrix`；`npm run exp -- vuln-scan --label before --scenario coverage-matrix`（Lab 0 已跑过可跳过）。
2. `scripts/module enable compliance`（首轮评估完成前为 `degraded`）；`scripts/module enable vuln-scan`（等待实例 `PingStatus=Online` 与首轮扫描）。
3. compliance：`coverage-matrix --label after`；`faults/open-ssh-canary.sh`（只建一个不挂到任何实例的金丝雀安全组，22 对全网开放）→ `restricted-ssh` 不合规 → 只对该安全组执行修复 → 回到合规 → 删除金丝雀；`faults/sshd-password-on.sh`（本地自检发现、Config 看不到，实验后立即恢复）；可选 `faults/tls-canary-bucket.sh`；`GET /api/lab/compliance/timeline?resource=<金丝雀安全组>` 查看配置时间线（有 audit 时关联 CloudTrail 事件）。
4. vuln-scan：`coverage-matrix --label after`；`faults/plant-canary.sh`（`--ignore-scripts` 安装一个已公开通告漏洞的旧版本依赖到不被应用加载的目录）→ 本地扫描与 Inspector 先后发现 → `faults/remove-canary.sh` 后两侧关闭；`reachability-canary.ts`（临时实例 + 金丝雀安全组，等待网络可达性发现后立即终止）。

**对比实验**：[06#compliance](modules/06-governance-cost.md#compliance) 第 5 节（覆盖矩阵、SSH 金丝雀、主机漂移、配置时间线）；[06#vuln-scan](modules/06-governance-cost.md#vuln-scan) 第 5 节（覆盖对象、持续性、网络可达性、深度检查自定义路径这个坑）。

**SAA 考点**：Config 记录器、托管规则、一致性包、聚合器、修复（SSM Automation）；Config 是检测型控制、SCP / IAM / Block Public Access 是预防型控制；Config、CloudTrail、CloudWatch 的分工；Inspector（新版）对 EC2（基于代理与无代理）、Lambda、ECR 的持续扫描；Inspector Classic 已停止支持（题库中“评估模板、Inspector 代理”属于旧版）；Inspector、GuardDuty、Macie、Detective、Security Hub 的区别；修补由 Patch Manager 完成；Trusted Advisor 与 Compute Optimizer（了解）。

**验收标准**

- `[CAP]` compliance.driver=`config`、vuln-scan.driver=`inspector`，status 为 `ok`（首轮评估 / 扫描完成前为 `degraded`）。
- `[MOD]` `GET /api/lab/compliance` 中 `restricted-ssh` 曾列出金丝雀安全组，修复后为合规。
- `[MOD]` `GET /api/lab/vuln-scan` 中本地与 Inspector 两侧都出现过金丝雀包的发现，删除后关闭。
- `[RUN]` compliance/coverage-matrix 与 vuln-scan/coverage-matrix 都有 before 与 after。

**清理**：删除所有金丝雀（安全组、桶、临时实例、`/opt/cloudalbum-releases/canary/`）；`disable compliance` 只删除本项目创建的记录器与规则；由本项目激活的 Inspector，`disable vuln-scan` 会提示“停用是账号级的”并恢复原来的深度检查路径。回到 `l0-ec2` 或执行 `scripts/teardown`。

---

## 附录：新旧 Lab 编号对照

旧版 labs.md 按“先建网络、再建完整三层架构”的顺序编排；新版从一台 EC2 出发、一次只加一个服务。旧内容在新版中的位置：

| 旧 Lab | 新版位置 | 主要变化 |
|---|---|---|
| 0 账号安全与成本护栏 | Lab 0 前置条件 + Lab 1（cost） | 不再在 Lab 0 建多区域 trail，CloudTrail 改为 Lab 23 的 audit 模块（启用前检测已有 trail）；Budgets 成为 cost 模块，本地实现从第一天起就在 |
| 1 VPC 网络 | Lab 14（public 放置）+ Lab 20（private 放置） | L0 在默认 VPC；自定义 VPC 由 network 模块分两步引入 |
| 2 前端 S3 + CloudFront + Route 53 | Lab 5、6 | SPA 由 EC2 上的 Nginx 提供，CloudFront 在前面缓存；媒体源站经 OAC 切到 S3 |
| 3 Cognito + Lambda 触发器 | Lab 8 | 默认 JIT 建档（F2），Post Confirmation 只是 database 启用后的可选增强；迁移默认 bulk |
| 4 单台 EC2 跑通 API | Lab 0、Lab 1 | 单台 EC2 本身就是完整的 L0；实例角色由 iam 模块引入 |
| 5 RDS + Secrets Manager + ElastiCache | Lab 13、15、16 | kms / secrets 提前到数据层之前；RDS Proxy 成为 db-proxy 模块（Lab 15 扩展） |
| 6 预签名 URL + S3 事件 + Lambda | Lab 4、11 | S3 事件统一经 EventBridge；Lambda 不直接写库，经结果队列或 HMAC 回调回写 |
| 7 AMI + ASG + ALB | Lab 19、21 | 黄金 AMI 成为 ami 模块（Lab 21 前置或扩展） |
| 8 SNS 扇出 + SQS + Rekognition | Lab 9、10、11 | 打标签默认由应用侧 TaggerPort 调用 Rekognition；SNS 扇出保留为 notification 的对照 |
| 9 API Gateway + Lambda + DynamoDB | Lab 17 | social-api 分 proxy 与 lambda 两档 |
| 10 安全加固与可观测性 | Lab 3、7、13、22、23、25 | X-Ray 验收改为“api → SQS → worker 同一条 trace、Lambda 为独立 trace 并以 `photo_id` 关联”（CloudFront 与 ALB 不产生 segment） |
| 11 灾备与成本优化 | Lab 24（灾备）+ Lab 1（成本护栏） | 灾备以 AWS Backup 跨区域复制与恢复演练为主；Pilot Light 等更高档位只在文档中比较 |
| 12 IaC 与 CI/CD | 贯穿全部 Lab | 每个模块一个 `infra/modules/<id>.yaml` 栈，由 `scripts/module` 部署；禁止 `Export` / `ImportValue`（D2）；CI/CD 不在本路线范围内 |

## 修订记录

### 2026-10-13 · 第 3 轮（审计修复）

- **Lab 6**：前置条件改为“`preflight: acme-endpoint` 的探测结果由 `scripts/module` 写成 `tls.env` 的 `TLS_ACME=on|off`”，DEP-005 的回退分支在启动时按 `TLS_ACME` 求值（与总纲 3.2 决定 9、5.2 一致）。
- **Lab 11**：第 10 步删除不存在的 `disable image-processing --driver worker`，改为 `scripts/module profile apply x-workflow`（差异计划自动完成 lambda → worker 的切换），手工做法为 `disable image-processing && enable image-processing --driver worker && enable workflow`。
- **Lab 13**：`KMS_APPLY_TO` 改为 `fields,ebs`；其余资源由 kms 的 `injects`（`target: "*"`）获得 CMK，因此 Lab 15 的 RDS 与 x-efs-asg 的 EFS 创建时就用 CMK（与总纲 3.4、10.2 一致）。
- **Lab 14**：前置条件注明 network 的 public 子网自动分配公网 IPv4（EIP 要等 `cfn-signal` 之后才关联，新实例引导期靠它出网）。
- **Lab 19**：没有域名时不设 `LB_ADMIN_AUTH`、不建 HTTPS 监听器（F12 的 ALB 认证按 DEP-011 关闭），`l8-ha` 档位用 `PROFILE_GATED=domain:LB_ADMIN_AUTH=cognito` 避免 DEP-017 拒绝启动；验收标准相应区分有无域名。
- **Lab 20**：`--nat none` 时的出网前置补上 `cloudformation` Interface Endpoint（`cfn-signal`）、`IAM_CREDENTIALS=role` 与工具链栈发布包镜像（DEP-009）。
