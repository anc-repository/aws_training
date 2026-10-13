# SAA-C03 考点覆盖

## 1. 四大考试领域对照

| 考试领域（权重） | 在本项目中对应的内容 | Lab |
|---|---|---|
| **设计安全的架构（30%）** | IAM 角色与最小权限、Cognito User Pool 和 Identity Pool、KMS、Secrets Manager、安全组链、网络 ACL、私有子网、VPC 终端节点、OAC、WAF、GuardDuty、CloudTrail、Config、S3 桶策略 | 0, 1, 2, 3, 10 |
| **设计弹性的架构（26%）** | 多 AZ、ASG + ALB、RDS Multi-AZ、SQS 解耦、SNS 扇出、DLQ、无状态设计、Route 53 故障转移、S3 跨区域复制、AWS Backup、Pilot Light 灾备 | 5, 7, 8, 11 |
| **设计高性能的架构（24%）** | CloudFront 缓存、ElastiCache、只读副本、RDS Proxy、DynamoDB 分区键设计、Lambda 内存调优和预置并发、ASG 扩缩容策略、S3 直传 | 2, 5, 6, 7, 9 |
| **设计成本优化的架构（20%）** | Spot 混合实例、Graviton（arm64）、S3 生命周期和 Intelligent-Tiering、Gateway Endpoint 节省 NAT 费用、DynamoDB 按需与预置对比、Savings Plans、Budgets、Cost Explorer | 0, 6, 7, 11 |

## 2. 服务覆盖清单

✅ = 动手实践 ◐ = 配置或对比 ○ = 只在文档中了解

| 类别 | 服务 |
|---|---|
| 计算 | ✅ EC2 ✅ Auto Scaling ✅ Lambda ◐ EC2 Image Builder ○ Elastic Beanstalk ○ ECS/Fargate |
| 存储 | ✅ S3 ✅ EBS ○ EFS ○ FSx ○ Storage Gateway ○ Snow 系列 |
| 数据库 | ✅ RDS ✅ DynamoDB ✅ ElastiCache ◐ RDS Proxy ○ Aurora ○ Redshift |
| 网络 | ✅ VPC ✅ ALB ✅ CloudFront ✅ Route 53 ◐ VPC 终端节点 ○ NLB ○ Transit Gateway ○ Direct Connect ○ VPN ○ Global Accelerator |
| 身份与安全 | ✅ IAM ✅ Cognito ✅ KMS ✅ Secrets Manager ✅ WAF ◐ GuardDuty ◐ Config ◐ Identity Center ○ Shield Advanced ○ Macie ○ Inspector |
| 应用集成 | ✅ SQS ✅ SNS ✅ API Gateway ✅ EventBridge ○ Step Functions ○ Kinesis |
| 管理与监控 | ✅ CloudWatch ✅ CloudTrail ✅ Systems Manager ✅ CloudFormation ◐ X-Ray ◐ AWS Backup ◐ Trusted Advisor ○ Organizations / SCP |
| AI | ◐ Rekognition |
| 成本 | ✅ Budgets ◐ Cost Explorer ◐ Compute Optimizer |

**可选的扩展 Lab**（用来补上考试里也常出现的服务）：
- **EFS**：多台 EC2 共享一个上传临时目录，对比 EFS 和 EBS。
- **Kinesis Data Firehose → S3 → Athena**：收集前端点击流，用 SQL 分析。
- **Organizations + SCP**：建一个 Sandbox 组织单元（OU），用 SCP 禁止在非指定区域创建资源。
- **ECS Fargate**：把 Express API 容器化，对比 EC2 和 Fargate。
- **Step Functions**：把图片处理流程编排成状态机。

## 3. 容易混淆的概念（结合本项目）

| 对比 | 本项目怎么选 | 原因 |
|---|---|---|
| 预签名 URL 和 Identity Pool 临时凭证 | 主要用预签名 URL | 由服务端控制文件名、大小和有效期，前端拿不到任何 AWS 凭证 |
| User Pool 和 Identity Pool | 两个都用 | User Pool 负责“你是谁”，Identity Pool 负责“你能用哪些 AWS 资源” |
| Multi-AZ 和只读副本 | 两个都用 | 前者解决高可用，后者分担读流量 |
| ALB 和 API Gateway 作为 API 入口 | 主业务用 ALB，社交功能用 API Gateway | ALB 适合长连接、稳定的高流量；API Gateway 自带授权、限流，按调用次数收费 |
| EC2 和 Lambda | 主 API 用 EC2，事件处理用 Lambda | 稳定的长期负载用 EC2 更便宜；突发的、事件驱动的工作用 Lambda |
| RDS 和 DynamoDB | 关系数据放 RDS，计数器和评论放 DynamoDB | 需要关联查询的放 RDS；高并发简单读写、需要 TTL 的放 DynamoDB |
| SQS 和 SNS 和 EventBridge | 三个都用 | SQS 是拉取式队列，适合削峰；SNS 是推送式，适合扇出；EventBridge 适合基于规则的路由和定时任务 |
| Lambda 失败目标（Destination）和 DLQ | 用失败目标 | 失败目标能拿到更完整的上下文，而且还支持成功目标 |
| 预留并发和预置并发 | 两个都练 | 预留并发是“上限 + 保底”，预置并发是“提前预热、消除冷启动” |
| NAT Gateway 和 Gateway Endpoint | 两个都用 | 访问 S3/DynamoDB 的流量走 Endpoint，不用付 NAT 的流量费 |
| 安全组和网络 ACL | 主要用安全组，data 子网额外加 ACL | 安全组有状态，作用在实例级；ACL 无状态，作用在子网级 |
| 缓存失效和带版本号的文件名 | 主要用带哈希的文件名 | 每次发布都做缓存失效会产生费用，而且生效有延迟 |

## 4. 故障演练清单

每一项都要记录：**操作 → 预期结果 → 实际观察 → 恢复时间**。

| # | 演练 | 验证的能力 |
|---|---|---|
| 1 | 手动终止 ASG 中的一台实例 | 自愈、ELB 健康检查 |
| 2 | 在实例上用 `stress` 把 CPU 打满 | 目标跟踪扩容 |
| 3 | RDS 执行带故障转移的重启 | Multi-AZ 故障转移，以及应用能否自动重连 |
| 4 | 把 NAT Gateway 的路由删掉 | 私有子网对公网的依赖；Endpoint 仍然可用 |
| 5 | 在 Lambda 里抛出异常 | 重试、失败目标、DLQ |
| 6 | 把 Lambda 预留并发设为 0 | 限流时上游怎么表现（SQS 积压、S3 事件重试） |
| 7 | 一次性上传 500 张照片 | SQS 削峰；RDS Proxy 保护数据库连接 |
| 8 | 用同一个 IP 在短时间内大量请求 | WAF 限速规则 |
| 9 | 让主区域的健康检查失败 | Route 53 故障转移，实测 RTO |
| 10 | 删除 S3 对象之后再恢复 | 版本控制、删除标记 |
| 11 | 把某个桶临时改成公开 | Config 规则和 Access Analyzer 能否发现 |
| 12 | 删掉 EC2 角色上的 S3 权限 | 排查 AccessDenied 的完整思路（CloudTrail） |

## 5. 学完能回答的典型考题

- 用户上传大文件，怎样不经过应用服务器？→ S3 预签名 URL（大文件再加分段上传）。
- 同一个 S3 事件要给多个消费者处理，怎么做？→ SNS 扇出，或者 EventBridge。
- 大量 Lambda 并发把 RDS 的连接数打满了，怎么办？→ RDS Proxy。
- 私有子网里的 EC2 访问 S3，怎样不走公网、还能省钱？→ S3 Gateway Endpoint。
- 怎样只允许 CloudFront 访问 S3？→ OAC 加桶策略。
- 怎样只允许 CloudFront 访问 ALB？→ 托管前缀列表加自定义头，或者内部 ALB 加 CloudFront VPC Origin。
- Web 应用怎样给每个用户只开放自己的 S3 目录？→ Cognito Identity Pool 加 IAM 策略变量。
- 要求跨区域灾备，同时成本尽量低？→ Pilot Light（跨区域只读副本加最小化的基础设施）。
- 偶尔访问的照片，怎样自动降低存储费用？→ S3 生命周期规则，或者 Intelligent-Tiering。
