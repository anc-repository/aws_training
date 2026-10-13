# SAA-C03 考点覆盖

本文把 SAA-C03 的考点映射到 CloudAlbum 的 40 个模块（ec2 基础 + 39 个可插拔模块）与 Lab 0～25。模块与开关以 [modular-design.md](modular-design.md)（下称“总纲”）第 3 节为准，Lab 顺序与档位以总纲第 10 节为准，每个 Lab 的做法见 [labs.md](labs.md)，每个模块的对比实验与考点细节见 `docs/modules/0N-<group>.md` 中对应章节的第 5 节与第 7 节。

阅读方式：先看第 1 节（四个考试领域分别在哪些 Lab 练到），再用第 3 节“有 vs 没有对比实验速查”挑感兴趣的服务；第 4～6 节是复习用的易混概念、故障演练与典型考题。

---

## 1. 四大考试领域对照

| 考试领域（权重） | 在本项目中对应的内容 | 主要模块 | Lab |
|---|---|---|---|
| **设计安全的架构（30%）** | IAM 实例角色与 STS 临时凭证、每个模块一条客户托管策略（最小权限随模块增减）、IMDSv2；Session Manager 取代 22 端口；Cognito User Pool 与 Identity Pool（IAM 策略变量）；KMS 信封加密与密钥策略、Secrets Manager、Parameter Store SecureString；S3 Block Public Access、桶策略 `aws:SecureTransport`、OAC；ACM 证书；WAF 与 Shield；安全组链、NACL、私有子网、VPC Endpoint；CloudTrail、GuardDuty、Config、Inspector | iam、shell-access、auth、identity-pool、kms、secrets、config、storage、cdn、tls、waf、network、audit、threat-detection、compliance、vuln-scan | 1、2、4、5、6、7、8、13、14、20、23、25 |
| **设计弹性的架构（26%）** | 单点故障与独立数据卷；多 AZ（ALB + ASG、RDS Multi-AZ、ElastiCache Multi-AZ）；SQS 解耦与 DLQ、SNS 扇出、EventBridge 事件路由；Scheduler + 队列的补跑；Step Functions 的重试与 redrive；无状态设计；健康检查与失效开放；Route 53 故障转移；AWS Backup 跨区域复制与恢复演练；RPO / RTO 与四种灾备策略 | ec2、load-balancer、autoscaling、database、cache、queue、notification、scheduler、workflow、dns、backup | 0、6、9、10、11、12、15、16、19、21、24 |
| **设计高性能的架构（24%）** | CloudFront 边缘缓存与微缓存；ElastiCache cache-aside；只读副本；RDS Proxy 连接池化；DynamoDB 键设计、原子计数与热点；Lambda 内存与并发、冷启动；ASG 伸缩策略与黄金 AMI；S3 预签名直传与分段上传；Firehose + Athena 分区与列式格式；EBS、EFS、S3 的选择 | cdn、cache、database、db-proxy、social-store、image-processing、autoscaling、ami、storage、analytics、shared-fs | 4、5、11、15、16、17、18、21 |
| **设计成本优化的架构（20%）** | 成本护栏（Budgets、Cost Explorer、成本分配标签）与“按小时计费资源”的识别；T 系列 CPU 积分；Graviton（arm64）；Spot 混合实例；S3 生命周期与存储类别；Gateway Endpoint 省 NAT 费用；DynamoDB 按需与预置；Lambda 按调用与 EC2 按小时的成本模型；Athena 按扫描量计费；Savings Plans | cost、ec2、image-processing、autoscaling、storage、network、social-store、social-api、analytics | 0、1、4、11、14、17、18、20、21 |

---

## 2. 服务覆盖清单

✅ = 有独立模块，做“有 vs 没有”对比 ◐ = 作为辅助服务、变体或配置出现 ○ = 只在文档中了解

| 类别 | 服务 | 程度 | 模块 / 出现位置 | Lab |
|---|---|---|---|---|
| 计算 | Amazon EC2（含 EBS 数据卷、弹性 IP） | ✅ | ec2（基础模块） | 0 |
| 计算 | EC2 Auto Scaling | ✅ | autoscaling | 21 |
| 计算 | AWS Lambda | ✅ | image-processing（主服务）；social-api 集成、Cognito 触发器、轮换函数、workflow 任务（辅助） | 11、17 |
| 计算 | EC2 Image Builder | ✅ | ami | 21（前置或扩展） |
| 计算 | Elastic Beanstalk、ECS / Fargate | ○ | 与自建 ASG、与 EC2 的取舍 | — |
| 存储 | Amazon S3 | ✅ | storage；另有 identity-pool 暂存桶、analytics 事件桶、audit 日志桶 | 4 |
| 存储 | Amazon EBS | ◐ | ec2 的独立数据卷、快照、加密卷更换 | 0、13、24 |
| 存储 | Amazon EFS | ✅ | shared-fs（变体 `x-efs-asg`） | 21 |
| 存储 | FSx、Storage Gateway、Snow 系列 | ○ | — | — |
| 数据库 | Amazon RDS for PostgreSQL | ✅ | database | 15 |
| 数据库 | Amazon RDS Proxy | ✅ | db-proxy | 15（扩展） |
| 数据库 | Amazon DynamoDB | ✅ | social-store | 17 |
| 数据库 | Amazon ElastiCache（Valkey / Redis OSS） | ✅ | cache | 16 |
| 数据库 | Aurora、DAX、Redshift | ○ | 选型对比 | 15、16、18 |
| 网络 | Amazon VPC（NAT、VPC Endpoint、Flow Logs） | ✅ | network | 14、20 |
| 网络 | Elastic Load Balancing（ALB） | ✅ | load-balancer | 19 |
| 网络 | Amazon CloudFront（含 CloudFront Functions、VPC Origin） | ✅ | cdn | 5 |
| 网络 | Amazon Route 53 | ✅ | dns | 6 |
| 网络 | AWS PrivateLink / Interface Endpoint、EC2 Instance Connect Endpoint | ◐ | network 的参数 | 20 |
| 网络 | NLB、GWLB、Transit Gateway、Direct Connect、VPN、Global Accelerator | ○ | 与 ALB、CloudFront 的对比 | — |
| 身份与安全 | AWS IAM（含 STS） | ✅ | iam | 1 |
| 身份与安全 | IAM Identity Center | ◐ | 部署者身份 | 0、1 |
| 身份与安全 | Amazon Cognito User Pool | ✅ | auth | 8 |
| 身份与安全 | Amazon Cognito Identity Pool | ✅ | identity-pool | 8 |
| 身份与安全 | AWS KMS | ✅ | kms | 13 |
| 身份与安全 | AWS Secrets Manager | ✅ | secrets | 13 |
| 身份与安全 | AWS Certificate Manager | ✅ | tls | 6 |
| 身份与安全 | AWS WAF | ✅ | waf | 7 |
| 身份与安全 | AWS Shield（Standard 默认开启） | ○ | 与 WAF 的分工 | 7 |
| 身份与安全 | Amazon GuardDuty | ✅ | threat-detection | 23 |
| 身份与安全 | AWS Config | ✅ | compliance | 25 |
| 身份与安全 | Amazon Inspector | ✅ | vuln-scan | 25 |
| 身份与安全 | Amazon Macie | ○ | 可选扩展（见 2.1） | — |
| 身份与安全 | Security Hub、Detective、Firewall Manager、IAM Access Analyzer、Organizations / SCP | ○ | 与 GuardDuty、Inspector、Config 的区分；SCP 作为预防型控制 | 23、25 |
| 应用集成 | Amazon SQS | ✅ | queue（另有各模块自带的辅助队列） | 10 |
| 应用集成 | Amazon SNS | ✅ | notification（另有 monitoring、threat-detection 等自带主题） | 9 |
| 应用集成 | Amazon SES | ✅ | email | 9 |
| 应用集成 | Amazon API Gateway（HTTP API） | ✅ | social-api | 17 |
| 应用集成 | Amazon EventBridge（事件总线与规则） | ◐ | S3 事件路由（storage、image-processing）、安全与合规事件路由 | 4、11、23 |
| 应用集成 | Amazon EventBridge Scheduler | ✅ | scheduler | 12 |
| 应用集成 | AWS Step Functions | ✅ | workflow（变体 `x-workflow`） | 11（扩展） |
| 分析 | Amazon Data Firehose | ✅ | analytics | 18 |
| 分析 | Amazon Athena、AWS Glue Data Catalog | ◐ | analytics 的辅助服务 | 18 |
| 分析 | Kinesis Data Streams、Redshift | ○ | 与 Firehose、SQS 的选型 | 18 |
| 分析 | Amazon OpenSearch Service | ○ | 可选扩展（见 2.1） | — |
| 管理与监控 | Amazon CloudWatch（指标、告警、仪表板、Agent） | ✅ | monitoring | 3 |
| 管理与监控 | Amazon CloudWatch Logs | ✅ | logging | 3 |
| 管理与监控 | AWS X-Ray | ✅ | tracing | 22 |
| 管理与监控 | AWS CloudTrail | ✅ | audit | 23 |
| 管理与监控 | Systems Manager Session Manager | ✅ | shell-access | 2 |
| 管理与监控 | Systems Manager Parameter Store | ✅ | config | 13 |
| 管理与监控 | Systems Manager Run Command、Patch Manager、Automation | ◐ / ○ | Run Command 是 `scripts/module` 的投递通道与 scheduler 的 ssm 目标；Automation 是 Config 修复；Patch Manager 了解 | 2、12、25 |
| 管理与监控 | AWS CloudFormation | ◐ | 每个模块一个栈，跨栈不使用 `Export` / `ImportValue` | 全部 |
| 管理与监控 | AWS Backup | ✅ | backup | 24 |
| 管理与监控 | Trusted Advisor、Compute Optimizer | ○ | 成本与选型建议 | 1、25 |
| AI | Amazon Rekognition | ✅ | tagging | 11 |
| AI | Textract、Comprehend、Transcribe、Augmented AI | ○ | AI 服务定位与内容审核人工复核 | 11 |
| 成本 | AWS Budgets | ✅ | cost | 1 |
| 成本 | Cost Explorer、成本分配标签 | ◐ | cost 的辅助服务 | 1 |
| 成本 | Savings Plans、预留实例、Cost Anomaly Detection、Pricing Calculator | ○ | 降本手段与工具的区分 | 1、21 |

### 2.1 可选扩展（不建模块）

- **Amazon OpenSearch Service**：可以把 tagging 的“按标签搜索”扩展为照片全文检索（本地对照为 SQLite FTS5 或 PostgreSQL 全文索引），但它按小时计费、成本较高，本项目不建模块，只在复习“搜索与日志分析”场景时了解。
- **Amazon Macie**：原图中的 EXIF GPS、日报 CSV 中的邮箱都是现成的敏感数据样例，可以用来理解 Macie 的 S3 敏感数据发现；本项目不建模块，复习时与 GuardDuty、Inspector 一起区分。

---

## 3. 有 vs 没有对比实验速查

每个模块一行：没有它时由哪个本地实现提供同一机能、启用后换成什么、最值得看的观察点、主要实验场景（`npm run exp -- <id> --scenario <场景>` 或模块目录下的脚本）、对应的 Lab。实验细节与预期结果见各模块文档第 5 节。

| 模块 | 主服务 | 没有它（本地实现） | 有它 | 核心观察点 | 主要实验 | Lab |
|---|---|---|---|---|---|---|
| ec2 | Amazon EC2 | —（基础，不可禁用） | 单台 EC2 + 独立数据卷 + EIP | 完整功能在单机上可用；停止实例 = 全站不可用；换实例不重新生成密钥 | `smoke`、`single-point-of-failure`、`rebuild-drill` | 0 |
| network | Amazon VPC | 默认 VPC 公有子网 + EIP | 分层自定义 VPC（先 public、后 private） | 外部扫描到的开放端口数；出网 IP（实例 EIP → NAT EIP）；删 NAT 路由后 S3 / DynamoDB 仍可达 | `surface-scan`、`egress-path`、`endpoint-only` | 14、20 |
| cdn | Amazon CloudFront | Nginx 直出 | 边缘缓存 | `X-Cache` 与 `Age`；远端首字节从数百毫秒量级降到数十毫秒量级；源站请求数与 EC2 出网字节；失效 vs 版本化键 | `ttfb`、`media-load`、`invalidation` | 5 |
| dns | Amazon Route 53 | IP 或 EC2 主机名 | 域名 + 健康检查 + 路由策略 | 换 IP 后旧链接是否失效；故障转移时间；加权比例 | `ip-change-drill`、`failover-drill`、`weighted-sample` | 6 |
| tls | AWS Certificate Manager | 自签名（本地档 Let's Encrypt） | ACME 证书装 Nginx；集成证书挂 CloudFront / ALB | 浏览器是否信任、签发者、续期方式、远端握手时间 | `inspect`、`handshake`、`renew-drill` | 6 |
| waf | AWS WAF | Nginx 限速 + 特征拦截 + 封禁列表 | 托管规则组 + 速率规则 | 拦截发生在哪里；限速生效延迟；攻击期间源站请求数；载荷检出率与误杀 | `flood`、`payloads`、`false-positive`、`bypass` | 7 |
| load-balancer | Elastic Load Balancing（ALB） | Nginx 单机（本地档：本机双进程） | ALB | 滚动重启期间的错误数；单目标健康检查失效开放；`entry=alb>nginx` | `rolling-restart`、`health-fail`、`latency` | 19 |
| autoscaling | EC2 Auto Scaling | 单实例 | 多 AZ 的 ASG | `inst` / `az` 轮换；扩容与自愈；实例刷新接近零错误；不安全组合的症状 | `stateless-check`、`scale-out`、`terminate-drill`、`refresh` | 21 |
| iam | AWS IAM | 不调用 AWS（反面教材：长期访问密钥） | 实例角色临时凭证 | AKIA vs ASIA；明文凭证落盘位置；撤销会话后 GetCallerIdentity 仍成功而 GetRole 被拒 | `whoami`、`leak-scan`、`aws-ping` 撤销 | 1 |
| auth | Amazon Cognito User Pool | 本地账号（argon2id + ES256 JWT） | Cognito | 密码哈希不再存于本地；功能矩阵；登录压测时 EC2 CPU；登出后旧 access token 是否仍有效 | `login-storm`、`brute-force`、`revoke` | 8 |
| identity-pool | Amazon Cognito Identity Pool | 应用自签的前缀上传令牌 | STS 临时凭证分片直传 | 越权由谁拒绝（应用 403 vs S3 AccessDenied）；后端请求数与分片数是否相关 | `cross-prefix`、`upload-bench`、`resume` | 8 |
| secrets | AWS Secrets Manager | 数据卷上的 `secrets.env` 与 `keys/*.pem` | Secrets Manager | 明文落盘位置；不重启轮换、用户不掉线；读取可审计 | `leak-scan`、`rotate-under-load` | 13 |
| config | SSM Parameter Store | `runtime.json` + 文件监听 | Parameter Store（只管业务热键） | 远程热键的传播时间；版本与回滚；非法值与模块开关键被拒绝 | `propagation`、`reject-invalid` | 13 |
| kms | AWS KMS | 本地主密钥信封加密 | 客户托管密钥信封加密 | CloudTrail 中的 Decrypt 与加密上下文；禁用密钥后各层缓存依次失效；Bucket Key 降低调用量 | `disable-demo`、`decrypt-count`、`field-read` | 13 |
| storage | Amazon S3 | EBS 上的本地目录（上传经 EC2 中转） | 预签名 URL 直传 S3 | EC2 网卡入站字节；并发上传时其他接口的 P95；磁盘写满返回 507 | `upload-burst`、`upload-sidebyside`、`ebs-growth` | 4 |
| shared-fs | Amazon EFS | 本机 EBS（不共享） | EFS 共享目录 | 跨实例可见性；小文件元数据操作变慢 | `fs-bench`、`cross-instance` | 21（变体） |
| database | Amazon RDS for PostgreSQL | SQLite（本地档：EC2 自建 PostgreSQL） | RDS | 事件循环延迟 P99；单次查询多一次网络往返；故障转移的写失败区间；PITR；副本延迟 | `mixed-rw`、`failover`、`replica-read`、`replica-lag` | 15 |
| cache | Amazon ElastiCache | 无缓存（本地档：进程内 LRU、自建 Valkey） | ElastiCache | 每请求 DB 查询数与 P95；多进程陈旧读比例；fail-open 时错误率为 0 | `feed-read --ab`、`stale-read`、`ttl-sweep` | 16 |
| social-store | Amazon DynamoDB | 关系表 + 定时清理 | DynamoDB 单表 | 并发点赞的计数正确性；“先读后写”丢失更新；TTL 后台回收；热点项限流 | `like-storm`、`naive-counter`、`share-ttl` | 17 |
| backup | AWS Backup | 同盘 systemd timer 备份 | 独立备份库 + 跨区域复制 | 卷丢失演练的 RPO / RTO；本地备份与数据一起丢失；Vault Lock 阻止删除 | `drill.sh`（before / after） | 24 |
| analytics | Amazon Data Firehose | 业务库 `click_events` 表 | Firehose → S3 → Athena | 业务库写锁与膨胀；数据新鲜度；报表耗时随数据量增长；Athena 扫描字节 | `clickstream-load`、`report-scale`、`freshness` | 18 |
| image-processing | AWS Lambda | 请求内 sharp（本地档：worker 后台处理） | Lambda | “上传完成”接口延迟；EC2 CPU 与 CPU 积分；缩略图就绪时间；冷启动；限流 | `upload-burst --ab`、`cold-start`、`throttle` | 11 |
| queue | Amazon SQS | 同步执行（本地档：内存队列） | SQS + DLQ | 接口只含入队；CPU 削峰；`kill -9` worker 不丢任务；坏消息进 DLQ | `upload-burst`、`poison` | 10 |
| notification | Amazon SNS | 写站内信 + 逐个发邮件 | SNS 扇出 | 扇出耗时与接收人数无关；订阅需要确认；过滤策略；worker 停止时仍送达 | `fanout`、`filter` | 9 |
| email | Amazon SES | outbox（不真正发信） | SES | 是否真正送达；DKIM；沙盒拒信；退信与投诉回流 | `send-matrix`、`sandbox` | 9 |
| scheduler | Amazon EventBridge Scheduler | worker 内的 node-cron | Scheduler → 模块自带 tick 队列 | 停机漏跑 vs 补跑；多实例重复执行 vs 只执行一次；目标失败进 DLQ | `heartbeat`、`missed-run`、`second-worker` | 12 |
| tagging | Amazon Rekognition | 基础属性标签（元数据启发式） | Rekognition 内容标签与审核 | 按内容搜索的命中；自动审核与误判；TPS 限流 | `eval`（`X-Compare-Bypass: tagger`）、`upload-and-search` | 11 |
| social-api | Amazon API Gateway | EC2 上的 Express `/social` | HTTP API（proxy / lambda 集成） | 多一跳的开销；429 与 401 在网关层返回；EC2 停机时社交功能是否可用 | `compare`（按 URL A/B）、`throttle`、`ec2-down` | 17 |
| shell-access | SSM Session Manager | SSH 22 + 密钥对 | Session Manager | 22 端口 open → filtered；命令可按 IAM 身份审计 | `probe-port`、`session-audit` | 2 |
| logging | Amazon CloudWatch Logs | 本地文件 + logrotate | CloudWatch Logs | 摄取延迟；实例终止后能否查到；跨实例查询 | `ingest-lag`、`query-compare`、`instance-loss` | 3 |
| monitoring | Amazon CloudWatch | 本地指标库 + 本地告警评估器 | CloudWatch 指标与告警 | 实例宕机时谁还能告警；内存指标需要 Agent；基础监控与详细监控的粒度 | `time-to-alert`、`kill-test`、`mem-visibility` | 3 |
| tracing | AWS X-Ray | 仅 Server-Timing（本地档：本机 span） | X-Ray | 定位根因的步数；api → SQS → worker 同一条 trace，Lambda 另一条、用 `photo_id` 关联；追踪开销 | `slow-hunt`、`propagation`、`overhead --ab` | 22 |
| audit | AWS CloudTrail | 应用 `audit_log` + Event History | CloudTrail trail | “谁删了这张照片”可追溯矩阵；S3 数据事件；日志完整性验证 | `who-deleted`、`validate-logs` | 23 |
| threat-detection | Amazon GuardDuty | fail2ban + 本地安全分析器 | GuardDuty | 覆盖矩阵（应用层爆破与扫描 vs DNS、凭证外泄、异常 API）；只告警不阻断 | `sample-findings`、`web-scan` | 23 |
| compliance | AWS Config | 本机配置自检 | Config 托管规则 | 覆盖矩阵（主机侧 vs AWS 资源侧）；金丝雀安全组的检出与修复；配置时间线 | `coverage-matrix`、`open-ssh-canary` | 25 |
| vuln-scan | Amazon Inspector | `dnf` 安全公告 + `npm audit` | Inspector 持续扫描 | 覆盖对象（所有实例与函数）；金丝雀包的发现时延；网络可达性 | `coverage-matrix`、`plant-canary` | 25 |
| cost | AWS Budgets | 按计费维度 × 启用时长的本地清单 | Budgets + Cost Explorer | 本地“快而粗”vs Budgets“准而慢”；无标签费用；预测告警 | `visibility-lag`、`threshold-alert`、`tag-coverage` | 1 |
| db-proxy | Amazon RDS Proxy | 应用内连接池（本地档：PgBouncer） | RDS Proxy | 数据库连接数峰值；短连接建连延迟；故障转移写失败区间；钉住 | `conn-storm`、`conn-churn`、`failover-proxy` | 15（扩展） |
| workflow | AWS Step Functions | 进程内 `PhotoPipeline` 编排 | Standard 状态机 | 重试在执行图上可见；worker 停机时流程是否继续；Standard vs Express；redrive | `retry-visibility`、`worker-down`、`redrive` | 11（扩展） |
| ami | EC2 Image Builder | User Data 现场安装 | 黄金 AMI | 开机到可服务的耗时；扩容与实例刷新时长；启动时的外部依赖；镜像老化 | `boot-time`、`scale-out`、`dependency-failure` | 21（前置或扩展） |

**对比方式**：可以在同一部署中**运行时 A/B** 的有 cache、queue、image-processing、tagging、tracing、analytics、kms、identity-pool、database 的只读副本（管理员请求头 `X-Compare-Bypass`，总纲 8.3），以及 cdn、social-api、load-balancer（两个入口同时在线，按 URL 对比）、scheduler（`lab.heartbeat` 双触发）；storage、social-store、analytics 另有 lab 命名空间的侧路对比。其余模块属于权威数据、全局状态或纯基础设施，一律做“切换前 / 切换后”两次测量，或两侧同时运行的功能对比（audit、threat-detection、compliance、vuln-scan、cost）。

---

## 4. 容易混淆的概念（结合本项目）

| 对比 | 本项目怎么选 | 原因 | Lab |
|---|---|---|---|
| IAM 实例角色 vs 访问密钥 | 实例角色；访问密钥只作反面教材 | 临时凭证自动轮换、不落盘；长期密钥会随数据卷快照与备份扩散 | 1 |
| 预签名 URL vs 应用自签前缀令牌 vs Identity Pool 临时凭证 | 单张上传（F6）用预签名 URL；多文件分片（F14）在 L0 用前缀令牌，启用 identity-pool 后用临时凭证 | 预签名 URL 由服务端控制文件名与有效期；临时凭证让 S3 按 IAM 策略变量执行授权，但 IAM 管不了大小和类型，要靠 `complete` 校验兜底 | 4、8 |
| User Pool vs Identity Pool | 两个都用 | User Pool 回答“你是谁”；Identity Pool 用身份换 AWS 临时凭证 | 8 |
| Session Manager vs 堡垒机 vs EC2 Instance Connect（Endpoint） | Session Manager；私有实例可选 EIC Endpoint | 不开 22 端口、按 IAM 身份授权与审计；EC2 Instance Connect（浏览器方式）仍需要 22 端口 | 2、20 |
| 安全组 vs NACL | 主要用安全组；data 子网额外加 NACL | 安全组有状态、作用于 ENI；NACL 无状态、作用于子网，要放行临时端口 | 14 |
| NAT Gateway vs Gateway Endpoint vs Interface Endpoint | S3 / DynamoDB 走 Gateway Endpoint；其他 AWS API 走 NAT 或按需建 Interface Endpoint | Gateway Endpoint 免费；NAT 与 Interface Endpoint 都按小时计费 | 14、20 |
| Multi-AZ vs 只读副本 | 两个都用 | Multi-AZ 同步复制、自动故障转移、备库不可读；只读副本异步复制、分担读、可跨区域 | 15 |
| 应用内连接池 vs PgBouncer vs RDS Proxy | 默认应用内连接池；扩展对比 PgBouncer 与 RDS Proxy | RDS Proxy 解决扩容与 Lambda 打满连接、缩短故障转移，凭证来自 Secrets Manager；不支持 EC2 自建数据库 | 15 |
| RDS vs DynamoDB | 关系数据放 RDS；点赞、评论、计数、分享链接放 DynamoDB | 需要关联查询的用 RDS；高并发简单读写、需要 TTL、要脱离 EC2 运行的用 DynamoDB | 15、17 |
| ElastiCache vs DAX vs 只读副本 vs CloudFront | 时间线用 ElastiCache；媒体与静态资源用 CloudFront | DAX 只服务 DynamoDB；只读副本不是缓存；CloudFront 缓存在边缘 | 5、15、16 |
| EBS vs EFS vs S3 | 照片用 S3；变体对比 EFS；数据卷用 EBS | 一次写入、多次读取、HTTP 分发首选 S3；需要多实例共享 POSIX 目录又不改代码时选 EFS | 4、21 |
| SSE-S3 vs SSE-KMS vs Bucket Key；AWS 托管密钥 vs 客户托管密钥 | 原图桶 SSE-KMS + Bucket Key，客户托管密钥 | 可控的密钥策略、可审计、可禁用；Bucket Key 大幅降低 KMS 调用量；共享加密快照需要 CMK | 4、13 |
| Secrets Manager vs Parameter Store（vs AppConfig） | 机密放 Secrets Manager；运行时业务热键放 Parameter Store；模块开关不放进任何远程配置 | Secrets Manager 内置轮换与版本标签；Parameter Store 标准参数不额外收费；AppConfig 提供带验证器与部署策略的功能开关 | 13 |
| 缓存失效 vs 带版本号的键 | 主要用版本化键 | 失效有延迟、超出免费额度要收费；版本化键立即生效 | 5 |
| ACM 集成证书 vs ACM ACME 证书 vs Let's Encrypt | CloudFront / ALB 用集成证书；只有 L0 时用 ACME 证书或 Let's Encrypt 装到 Nginx | **考试结论**：ACM 证书不能装到 EC2，只能挂集成服务；**2026 新能力**：ACME 端点为自管服务器签发证书，但这类证书不能挂集成服务 | 6 |
| WAF vs Shield vs 安全组 / NACL | WAF（CloudFront 范围）+ Shield Standard | WAF 管七层；Shield 管 DDoS；安全组与 NACL 管三四层 | 7 |
| ALB vs API Gateway 作为 API 入口 | 主业务用 ALB；社交功能用 API Gateway | ALB 适合稳定的长连接与高流量；API Gateway 自带授权、限流，按调用计费 | 17、19 |
| HTTP API vs REST API；JWT 授权器 vs Lambda 授权器 | HTTP API；Cognito 时用 JWT 授权器，本地账号时用 Lambda 授权器 | REST API 才有 API Key、使用计划、缓存、WAF 关联、X-Ray；JWT 授权器只支持 RSA 系列算法 | 17 |
| EC2 vs Lambda | 主 API 在 EC2；缩略图在 Lambda | 稳定长期负载用 EC2 更便宜；突发、事件驱动的处理用 Lambda | 11 |
| Lambda 失败目标（Destination）vs DLQ | 异步调用用失败目标 | 失败目标带更完整的上下文，并支持成功目标；事件源映射的失败处理靠队列的 redrive 策略 | 11 |
| 预留并发 vs 预置并发 | 两个都练 | 预留并发是“上限 + 保底”（设为 0 等于暂停函数）；预置并发是提前预热、消除冷启动，按时长计费 | 11 |
| S3 事件通知 vs S3 → EventBridge | 统一用 EventBridge | 同一桶同一事件类型不能有前缀重叠的多个通知目标；EventBridge 允许多个规则各自消费 | 4、11 |
| 编排（Step Functions）vs 编舞（EventBridge / SQS 串联） | 默认编舞；变体用 Standard 状态机编排 | 编排让重试与失败在执行图上可见、可 redrive；编舞让模块互不依赖 | 11 |
| Step Functions Standard vs Express | Standard | Standard 恰好一次、执行历史在服务中、可 redrive；Express 至少一次（异步）、只在日志中、按请求与时长计费 | 11 |
| SQS vs SNS vs EventBridge vs Kinesis | 四个各有位置 | SQS 拉取式、削峰；SNS 推送式、扇出；EventBridge 基于规则路由与定时；Kinesis / Firehose 面向数据流 | 9、10、11、18 |
| EventBridge Scheduler vs EventBridge 定时规则 vs 实例上的 cron | Scheduler → 队列 → worker | 实例上的 cron 停机漏跑、多实例重复执行；Scheduler 支持时区、一次性调度与更多目标 | 12 |
| Firehose vs Kinesis Data Streams vs SQS | 点击流用 Firehose | Firehose 全托管、按缓冲投递、不管理分片；KDS 实时、可多消费者重放；SQS 是任务队列 | 18 |
| CloudWatch vs CloudTrail vs AWS Config | 三个都用 | CloudWatch 看“运行得怎样”；CloudTrail 看“谁调用了 API”；Config 看“资源配置是什么状态、是否违规” | 3、23、25 |
| X-Ray vs CloudWatch vs CloudTrail | 三个都用 | X-Ray 看一次请求跨服务的耗时；CloudWatch 看指标与日志；CloudTrail 看 API 审计 | 22 |
| GuardDuty vs Inspector vs Macie vs Detective vs Security Hub | GuardDuty 与 Inspector 有模块；Macie 只作了解 | 威胁检测 / 漏洞扫描 / S3 敏感数据 / 调查 / 汇总 | 23、25 |
| AWS Budgets vs Cost Explorer vs CloudWatch 账单告警 | Budgets + Cost Explorer | Budgets 设阈值与预测告警并可执行动作；Cost Explorer 分析与预测；账单告警只看 `EstimatedCharges`（us-east-1） | 1 |
| 黄金 AMI vs User Data 现场安装 | 默认 User Data；可选黄金 AMI | 黄金 AMI 启动快、一致、不依赖外部仓库，但会老化，需要重建与晋升节奏 | 21 |
| 复制 vs 备份 | 用 AWS Backup 做备份；复制只作了解 | S3 跨区域复制、只读副本、全局表会把逻辑错误一起复制过去 | 24 |

---

## 5. 故障演练清单

每一项都要记录：**操作 → 预期结果 → 实际观察 → 恢复时间**。“实验”一列是 `experiments/<模块>/` 中的场景或脚本，结果用 `--upload` 写入 `/lab/results`。所有攻击类演练只针对自己的资源，并遵守 AWS 渗透测试政策。

| # | 演练 | 实验 | 验证的能力 | Lab |
|---|---|---|---|---|
| 1 | 停止唯一的实例 | ec2 `single-point-of-failure` | 单点故障；EIP 与数据卷在实例停止后保持不变 | 0 |
| 2 | 替换实例（新 AMI / 新子网） | ec2 `rebuild-drill`；network 迁移 | 数据卷与机密随卷走，密钥指纹不变 | 0、14 |
| 3 | 撤销实例角色的会话 | iam `aws-ping.k6.js` + Revoke sessions | STS 会话撤销；GetCallerIdentity 不能作为权限探针 | 1 |
| 4 | 停服务、停实例 | monitoring `kill-test` | 告警与实例解耦（心跳 `TreatMissingData=breaching`、状态检查） | 3 |
| 5 | 删除一张原图后恢复 | 手工（原图桶已开版本控制） | 版本控制与删除标记 | 4 |
| 6 | 把数据卷压到写满 | storage `ebs-growth` | 磁盘容量风险；S3 不受影响而 SQLite 仍在同一块盘上 | 4 |
| 7 | 用同一个 IP 大量请求、发送攻击载荷 | waf `flood`、`payloads` | WAF 速率规则与托管规则；入口锁定 | 7 |
| 8 | 让源站健康检查失败 | dns `failover-drill` | Route 53 故障转移，实测 RTO | 6 |
| 9 | 一次上传数百张照片 | queue / image-processing `upload-burst` | SQS 削峰；Lambda 并发 | 10、11 |
| 10 | `kill -9` worker；内存队列下重启 api | queue `upload-burst`（故障注入） | 至少一次投递与可见性超时；内存队列会丢任务 | 0、10 |
| 11 | 投递一条坏消息 | queue `poison.ts`、`dlq-replay.ts` | DLQ、`maxReceiveCount` 与 redrive | 10 |
| 12 | 在 Lambda 里制造永久与暂时错误 | image-processing `failures.ts` | 异步重试、失败目标；永久错误不白白重试 | 11 |
| 13 | 把 Lambda 预留并发设为 0 | image-processing `throttle.ts` | 限流时上游的表现（异步队列重试、照片停在 PROCESSING） | 11 |
| 14 | 状态机模式下停掉 worker | workflow `worker-down` | 编排状态保存在服务中，恢复后补写 | 11（扩展） |
| 15 | worker 停机跨过一个定时点；模拟第二台主机 | scheduler `missed-run.sh`、`second-worker.sh` | Scheduler + 队列补跑；多实例 cron 重复执行 | 12 |
| 16 | 禁用 KMS 密钥再启用 | kms `disable-demo.sh` | 撤销的边界；各层缓存依次失效 | 13 |
| 17 | RDS 带故障转移的重启（直连与经 RDS Proxy 各一次） | database `failover`；db-proxy `failover-proxy` | Multi-AZ 故障转移、应用自动重连、RDS Proxy 缩短写失败区间 | 15 |
| 18 | 逐步调大连接池与进程数 | database / db-proxy `conn-storm` | 数据库连接数上限与连接池化 | 15 |
| 19 | 删除缓存安全组的入站规则 | cache `faults/revoke-sg.sh` | 非权威端口 fail-open，错误率为 0 | 16 |
| 20 | 停掉 EC2 上的 api 进程 | social-api `ec2-down.sh`（lambda 集成） | Serverless 路径独立于 EC2 | 17 |
| 21 | 单目标时让健康检查失败 | load-balancer `health-fail` | ALB 失效开放；单目标不等于高可用 | 19 |
| 22 | 删除私有子网的 NAT 路由 | network `endpoint-only` | 私有子网对出网路径的依赖；Gateway Endpoint 仍可用 | 20 |
| 23 | 手动终止 ASG 中的一台实例；压测 | autoscaling `terminate-drill`、`scale-out` | 自愈、ELB 健康检查、目标跟踪扩容 | 21 |
| 24 | 故意使用不安全的多实例组合 | autoscaling `stateless-check --label unsafe` | 无状态设计；启动校验为什么要拒绝这些组合 | 21 |
| 25 | 启动时外部仓库不可用 | ami `dependency-failure` | 黄金 AMI 消除启动时的外部依赖 | 21 |
| 26 | 临时分离 EC2 角色上的某个模块策略 | audit `who-deleted`（场景 4） | 用 CloudTrail 排查 AccessDenied 的完整思路 | 23 |
| 27 | 篡改应用审计表 | audit `faults/tamper-audit.sh` | 本地哈希链能发现篡改但挡不住有 root 权限的人；审计日志要放在应用之外 | 23 |
| 28 | 数据卷丢失（克隆环境） | backup `drill.sh`（before / after） | RPO / RTO；同盘备份与数据一起丢失；跨区域恢复 | 0、24 |
| 29 | 建一个对全网开放 22 端口的金丝雀安全组 | compliance `open-ssh-canary.sh` | Config 规则检出与修复（检测型控制） | 25 |
| 30 | 植入一个带已知漏洞的依赖包 | vuln-scan `plant-canary.sh` | Inspector 持续扫描与本地扫描的覆盖差异 | 25 |

---

## 6. 学完能回答的典型考题

| 问题 | 答案要点 | Lab |
|---|---|---|
| EC2 上的应用怎样安全地调用 AWS API？ | 实例配置文件（IAM 角色），STS 临时凭证自动轮换；不要把访问密钥放在实例上；强制 IMDSv2 | 1 |
| 怎样不开 22 端口、不建堡垒机就能登录实例？ | Systems Manager Session Manager（实例角色 + SSM Agent + 到 SSM 端点的网络）；私有子网用 Interface Endpoint 或 NAT | 2 |
| 实例停止或挂掉时，怎样仍然能收到告警？ | CloudWatch 告警与实例解耦：心跳指标设 `TreatMissingData=breaching`、状态检查告警；经 SNS 通知 | 3 |
| EC2 的内存使用率在哪里看？ | 默认没有，需要安装 CloudWatch Agent | 3 |
| 用户上传大文件，怎样不经过应用服务器？ | S3 预签名 URL（大文件用分段上传） | 4 |
| 怎样只允许 CloudFront 访问 S3？ | OAC 加桶策略（`AWS:SourceArn` 条件）；SSE-KMS 对象还要在密钥策略中授权 CloudFront | 5 |
| 怎样只允许 CloudFront 访问 ALB / EC2 源站？ | 托管前缀列表 + 自定义请求头；或 CloudFront VPC Origin + internal ALB | 5、19、20 |
| 更新了同名文件但用户仍看到旧版本？ | 缓存失效（有延迟、可能收费），或改用带版本号的文件名 | 5 |
| 想给 EC2 上的 Nginx 用 ACM 证书？ | 考试口径：ACM 证书不能安装到 EC2，在前面加 ALB 或 CloudFront，或导入第三方证书；2026 起 ACM 的 ACME 端点可以为自管服务器签发证书（题库可能尚未覆盖） | 6 |
| CloudFront 使用的证书要在哪个区域申请？ | us-east-1（Cognito 托管登录自定义域名同样）；ALB 用所在区域的证书 | 6 |
| 根域名指向 CloudFront 用什么记录？ | Alias 记录（根域名不能用 CNAME，指向 AWS 资源的 Alias 查询免费） | 6 |
| AWS WAF 能挂在哪里？ | CloudFront、ALB、API Gateway REST API、AppSync、Cognito User Pool 等；不能挂在 EC2、EIP、NLB 上 | 7 |
| Web 应用怎样给每个用户只开放自己的 S3 目录？ | Cognito Identity Pool + IAM 策略变量 `${cognito-identity.amazonaws.com:sub}` | 8 |
| 同一个 S3 事件要给多个消费者处理？ | S3 → EventBridge 多条规则（或 S3 → SNS 扇出）；同一事件类型不能配置前缀重叠的多个通知目标 | 4、11 |
| 突发流量压垮后端处理？ | 用 SQS 解耦削峰，按“每实例积压”扩缩容；坏消息进 DLQ | 10 |
| Lambda 处理失败的事件怎么保留下来？ | 异步调用配置失败目标（Destination）或 DLQ；事件源映射用队列的 redrive 策略 | 11 |
| 多步骤处理流程需要可视化的重试和失败处理？ | Step Functions Standard 工作流（`Retry` / `Catch`，失败执行可 redrive） | 11 |
| 多台实例上的定时任务重复执行？ | 用 EventBridge Scheduler 把触发集中到 AWS，经队列交给一个消费者执行 | 12 |
| 应用的数据库密码怎样轮换而不重启？ | Secrets Manager（版本标签 AWSCURRENT / AWSPREVIOUS，可配轮换 Lambda）；RDS 托管主密码 | 13 |
| 已经创建的未加密 RDS 实例怎样加密？ | 快照 → 复制快照时加密（CMK）→ 从快照恢复新实例 | 13、15 |
| 降低 SSE-KMS 的请求费用？ | S3 Bucket Key（以及应用侧的数据密钥缓存） | 13 |
| 私有子网里的 EC2 访问 S3，怎样不走公网、还能省钱？ | S3 Gateway Endpoint | 14、20 |
| 大量 Lambda 或 ASG 扩容把 RDS 的连接数打满了？ | RDS Proxy | 15 |
| 读多写少，主库压力大？ | 只读副本分担读（异步复制、有延迟），热点数据放 ElastiCache | 15、16 |
| 需要高可用的关系数据库？ | RDS Multi-AZ（同步复制、自动故障转移、备库不可读） | 15 |
| 高并发计数，并让分享链接自动过期？ | DynamoDB 原子 `ADD` 与条件写入；TTL 自动删除（后台异步，读取时仍需校验） | 17 |
| 想让 API 的限流和鉴权在到达服务器之前完成？ | API Gateway（限流返回 429、授权器返回 401）；HTTP API 用 JWT 授权器 | 17 |
| 点击流分析拖慢了业务数据库？ | Firehose → S3 → Athena（分区 + 列式格式降低扫描量），把 OLAP 从 OLTP 中剥离 | 18 |
| ALB 后面只有一个目标且健康检查失败会怎样？ | 所有目标都不健康时 ALB 失效开放，仍向它们转发 | 19 |
| 需要固定 IP 的负载均衡？ | NLB 或 Global Accelerator（ALB 的 IP 会变化） | 19 |
| 私有子网中的实例怎样对外提供服务又不暴露自己？ | 公有子网的 ALB（或 CloudFront VPC Origin）做入口，实例无公网地址，出网经 NAT | 20 |
| 扩容太慢，因为启动时要现场安装软件？ | 黄金 AMI（EC2 Image Builder）或暖池 | 21 |
| 多台实例需要共享同一个文件目录？ | Amazon EFS（Linux、NFS）；Windows 用 FSx for Windows File Server | 21 |
| 怎样让 ASG 中的实例可以随时被替换？ | 无状态设计：会话、缓存、文件、数据库都放到实例之外 | 21 |
| 一个请求慢在了哪个服务？ | AWS X-Ray 的服务地图与 trace；注意 S3 事件触发的 Lambda 是另一条 trace | 22 |
| 是谁删除了这个 S3 对象？ | CloudTrail trail 开启 S3 数据事件（Event History 只有管理事件） | 23 |
| 怎样防止审计日志被篡改？ | 日志文件完整性验证、S3 对象锁、单独的日志账号 | 23 |
| 实例在访问挖矿域名、凭证在 AWS 外部被使用？ | Amazon GuardDuty（只告警，自动响应靠 EventBridge） | 23 |
| 要求跨区域灾备，同时成本尽量低？ | 备份与恢复（AWS Backup 跨区域复制）；RTO 要求更高时选 Pilot Light | 24 |
| 防止勒索软件删除备份？ | AWS Backup Vault Lock（compliance 模式不可绕过） | 24 |
| 发现安全组对全网开放了 22 端口？ | AWS Config 托管规则 `restricted-ssh`，可配置自动修复 | 25 |
| 持续发现 EC2 与 Lambda 中的已知漏洞？ | Amazon Inspector（EC2 扫描依赖 SSM 托管节点，或无代理扫描） | 25 |
| 发现 S3 中的个人敏感数据？ | Amazon Macie（本项目只作可选扩展了解） | — |
| 月中就想知道这个月会不会超支？ | AWS Budgets 预测告警（需要足够的用量历史）；成本分配标签必须先激活 | 1 |
| 偶尔访问的照片，怎样自动降低存储费用？ | S3 生命周期转 Standard-IA（注意最短存储期与 128 KB 最小计费尺寸）；Intelligent-Tiering 对小于 128 KB 的对象不分层 | 4 |
