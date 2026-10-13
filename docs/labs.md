# 实验路线（Labs）

每个 Lab 都按同样的结构写：**目标 → 动手步骤 → SAA 考点 → 验收标准**。

建议的练习节奏：**先在控制台手动搭一遍，再用 IaC 重写一遍，最后做故障演练**。第一次在控制台点，是为了搞懂每个配置项是什么意思；第二次写成代码，是为了能反复搭建、反复销毁，也能省钱。

| Lab | 主题 | 预计时长 | 依赖 |
|---|---|---|---|
| 0 | 账号安全与成本护栏 | 1h | — |
| 1 | VPC 网络 | 3h | 0 |
| 2 | 前端：S3 + CloudFront + Route 53 | 3h | 0 |
| 3 | Cognito 身份认证 + Lambda 触发器 | 4h | 2 |
| 4 | 单台 EC2 跑通 API | 3h | 1, 3 |
| 5 | RDS + Secrets Manager + ElastiCache | 4h | 4 |
| 6 | 照片上传：预签名 URL + S3 事件 + Lambda | 4h | 5 |
| 7 | 高可用：AMI + 启动模板 + ASG + ALB | 4h | 6 |
| 8 | 解耦：SNS 扇出 + SQS + Rekognition | 3h | 6 |
| 9 | Serverless API：API Gateway + Lambda + DynamoDB | 4h | 3 |
| 10 | 安全加固与可观测性 | 4h | 7, 9 |
| 11 | 灾备与成本优化 | 4h | 10 |
| 12 | IaC 与 CI/CD（加分项） | 6h+ | 全部 |

---

## Lab 0：账号安全与成本护栏

**步骤**
1. 给根账号开启 MFA，删除根账号的访问密钥（Access Key）。
2. 开启 IAM Identity Center，创建管理员用户，日常都用它登录。
3. 在 AWS Budgets 建一个月度预算（比如 30 美元），在实际花费达到 50%、80%、100% 时发邮件告警。
4. 在 CloudTrail 建一个多区域 trail，日志写入一个专门的 S3 桶。
5. 给所有资源统一打上标签 `Project=CloudAlbum`，并在账单设置里激活成本分配标签。

**考点**：根账号的最佳实践；IAM 用户、组、角色、策略的区别；CloudTrail 管理事件和数据事件的区别。

**验收**：用 Identity Center 用户登录控制台；Budgets 发出的测试告警邮件能收到。

---

## Lab 1：VPC 网络

**步骤**
1. 按 [architecture.md §4](architecture.md#4-网络设计vpc) 创建 VPC 和 6 个子网，分布在 2 个 AZ。
2. 创建 IGW、NAT Gateway（先只建 1 个），以及公有、私有两张路由表。
3. 为 S3 和 DynamoDB 创建 Gateway Endpoint，并关联到私有路由表。
4. 创建三个安全组 `sg-alb`、`sg-app`、`sg-db`，入站规则引用上一层的安全组。
5. 开启 VPC Flow Logs。
6. 在 app 子网启动一台临时 EC2，**不分配公网 IP，也不开 22 端口**，用 SSM Session Manager 连进去，执行 `curl https://aws.amazon.com` 验证能通过 NAT 访问公网。

**考点**：CIDR 规划；公有子网和私有子网的区别；NAT GW 和 NAT 实例的区别；Gateway Endpoint 和 Interface Endpoint 的区别；安全组（有状态）和网络 ACL（无状态）的区别；VPC 对等连接和 Transit Gateway（只需了解）。

**验收**：私有子网里的实例能出公网，但公网访问不进来；把私有路由表里指向 NAT 的路由删掉后，`aws s3 ls` 仍然能用（走的是 Gateway Endpoint）。

---

## Lab 2：前端（S3 + CloudFront + Route 53 + ACM）

**步骤**
1. 用 Vite 构建 React 前端，上传到 `cloudalbum-web` 桶，桶保持“阻止所有公有访问”。
2. 创建 CloudFront 分配，源站选 S3，访问控制用 **OAC**；然后按控制台提示更新桶策略。
3. 配置 SPA 路由兜底：自定义错误响应，把 403 和 404 都返回 `/index.html`，状态码改为 200。
4. 在 **us-east-1** 申请 ACM 证书（DNS 验证），给 CloudFront 绑定自定义域名，并在 Route 53 创建 **Alias A 记录**。
5. 发布新版本时，练习两种更新方式：缓存失效（Invalidation），以及给文件名加内容哈希。

**考点**：CloudFront 使用的证书必须在 us-east-1；OAC 和旧的 OAI 的区别；Alias 记录和 CNAME 的区别（根域名只能用 Alias）；S3 静态网站托管端点和 REST 端点的区别；TTL 与缓存失效。

**验收**：通过 `https://album.example.com` 能打开页面；直接访问 S3 对象 URL 返回 403。

---

## Lab 3：Cognito 身份认证

**步骤**
1. 创建 User Pool：邮箱登录、可选 MFA、建 `admin` 和 `member` 两个组、加自定义属性 `custom:plan`。
2. 创建 App Client：不生成客户端密钥，使用授权码 + PKCE 流程，回调地址填 CloudFront 域名。
3. 开启托管登录页（Managed Login），配置 Cognito 域名前缀。
4. 前端用 `aws-amplify` 的 Auth 模块实现登录和退出，在浏览器开发者工具里解码 ID Token 和 Access Token，看里面有哪些字段。
5. 编写并挂载 **Pre Sign-up** 触发器（邮箱域名白名单）和 **Pre Token Generation** 触发器（加 `plan` 声明）。
   **Post Confirmation** 触发器（写 RDS）要依赖数据库，留到 Lab 5 完成之后再补。
6. **进阶**：创建 Identity Pool，配置已登录用户的 IAM 角色，策略里使用 `${cognito-identity.amazonaws.com:sub}` 变量。然后在前端用临时凭证直接上传文件到 `private/{identityId}/` 前缀下。

**考点**：User Pool（认证，回答“你是谁”）和 Identity Pool（授权，换取 AWS 临时凭证）的区别；三种 Token 各自的用途；身份联合（Federation）；Cognito 和 IAM Identity Center 分别用在什么场景。

**验收**：注册时收到验证邮件；用白名单以外的域名注册会被拒绝；Token 里能看到 `cognito:groups` 和 `plan`；用 Identity Pool 凭证往别人的前缀写文件会返回 AccessDenied。

---

## Lab 4：单台 EC2 跑通 API

**步骤**
1. 创建 IAM 角色 `CloudAlbumAppRole`，附加 `AmazonSSMManagedInstanceCore` 和 `CloudWatchAgentServerPolicy`。对 S3 的权限只给它真正需要的桶。
2. 在 app 子网启动 Amazon Linux 2023 实例：IMDSv2 设为必需，EBS 用 gp3 并加密。
3. 写 User Data 脚本：安装 Node.js，从 `artifacts` 桶拉取 `backend.zip`，用 systemd 启动服务。
4. Express 里实现 `/api/health` 和 `/api/me` 两个接口；`/api/me` 用 `aws-jwt-verify` 校验 Cognito 的 Access Token。
5. 先验证接口能用：用 SSM **端口转发**把实例的 3000 端口映射到本地测试。
   然后用 CloudFront **VPC Origin** 直接指向这台私有实例，让 `/api/*` 走通整条链路（Lab 7 会改成指向 ALB）。

**考点**：EC2 实例类型的命名规则；EBS 卷类型（gp3、io2、st1）；实例存储和 EBS 的区别；User Data 和实例元数据（IMDS）；为什么要用实例配置文件，而不是把访问密钥写进代码；按需、预留、Savings Plans、Spot、专用主机几种购买方式的区别。

**验收**：不带 Token 访问 `/api/me` 返回 401，带有效 Token 返回用户信息；实例上没有任何 AWS 访问密钥文件。

---

## Lab 5：数据层

**步骤**
1. 创建 DB 子网组（2 个 data 子网），然后创建 RDS PostgreSQL：先用 Single-AZ，并开启 KMS 加密。
2. 主账号密码交给 Secrets Manager 管理；应用启动时读取（读取后在内存里缓存）。
3. 执行建表脚本；实现 `/api/albums` 的增删改查。
4. 开启 Multi-AZ，在控制台点**带故障转移的重启**，记录应用中断了多少秒。
5. 创建一个只读副本，把时间线查询路由到只读副本。
6. 创建 RDS Proxy；补完 Lab 3 留下的 **Post Confirmation** 触发器（把 Lambda 放进 VPC，通过 Proxy 连库）。
7. 创建 ElastiCache Redis，按旁路缓存（cache-aside）模式缓存时间线数据。

**考点**：Multi-AZ（高可用、同步复制）和只读副本（扩展读能力、异步复制）的区别；RDS、Aurora、DynamoDB 怎么选；RDS Proxy 解决了什么问题；已经创建的未加密实例要通过“快照 → 复制时加密 → 用快照恢复”来加密；ElastiCache 里 Redis 和 Memcached 的区别。

**验收**：新用户注册后 `users` 表里自动出现记录；故障转移期间应用能自动重连；第二次请求时间线明显更快（命中缓存）。

---

## Lab 6：照片上传与 Lambda 处理

**步骤**
1. 创建 `raw` 和 `media` 两个桶。`raw` 桶开启版本控制和 SSE-KMS，并配置 CORS 允许浏览器 PUT。
2. 实现 `POST /api/photos`：后端在 RDS 插入一行记录，然后用 `@aws-sdk/s3-request-presigner` 生成一个 5 分钟有效的 PUT URL 返回给前端。
3. 编写 `image-thumbnail` Lambda：
   - 把 sharp 打包成 Layer，架构选 arm64。
   - 内存 1024MB，超时 30 秒。
   - 配置 S3 `ObjectCreated:*` 事件通知（后缀过滤 `.jpg`、`.png`），把 Lambda 设为目标。
   - 异步调用配置：重试 2 次，失败目标设为一个 SQS 队列。
4. 在 `media` 桶前加一条 CloudFront 行为 `/media/*`。
5. **Lambda 调优练习**：
   - 用 Lambda Power Tuning 分别测试 512、1024、2048MB 下的耗时和费用。
   - 故意写一个 bug，让函数失败，确认失败事件进入了失败目标队列。
   - 把预留并发设为 0，观察函数被限流（Throttle）时的表现。
6. **进阶**：发布版本 v1、v2，建一个别名 `live`，配置 90/10 加权分流。

**考点**：预签名 URL；S3 事件通知的目标类型（Lambda、SQS、SNS、EventBridge）；Lambda 同步调用、异步调用、事件源映射三种调用模型的区别；执行角色（函数能做什么）和资源策略（谁能调用函数）的区别；并发相关配置；Layer；`/tmp` 存储空间；最长超时 15 分钟。

**验收**：上传照片后几秒内就能在前端看到缩略图；失败的事件可以在失败目标队列里找到；CloudWatch Logs 中能看到冷启动的 `Init Duration`。

---

## Lab 7：高可用（ASG + ALB）

**步骤**
1. 从 Lab 4 的实例制作 AMI，然后创建启动模板（Launch Template）。
2. 创建 ALB（放在公有子网）和目标组，健康检查路径 `/api/health`，配置 HTTPS 监听器和 HTTP→HTTPS 重定向。
3. 创建 ASG：min 2、desired 2、max 6，分布在 2 个 AZ，健康检查类型选 ELB。
4. 配置扩缩容策略：
   - 目标跟踪：CPU 50%。
   - 第二条目标跟踪：每个目标的 ALB 请求数。
   - 预定操作：工作日 9 点扩到 3 台。
5. 用 `hey` 或 `k6` 压测，观察扩容、冷却、缩容的全过程。
6. 改用混合实例策略：1 台按需实例，其余用 Spot。
7. 保护源站，两种方案都做一遍：
   - 方案 A：公网 ALB。`sg-alb` 的入站规则只允许 CloudFront 前缀列表，ALB 监听器规则检查 `X-Origin-Verify` 头。
   - 方案 B：**内部（internal）ALB** + CloudFront VPC Origin。ALB 完全不暴露到公网。
8. 在 ALB 上添加 `/admin*` 规则：先执行 authenticate-cognito 动作，再转发到管理后台。
9. 更新代码，打出新 AMI，用**实例刷新（Instance Refresh）**滚动发布。

**考点**：ALB、NLB、GWLB 的区别；跨区负载均衡；粘性会话（为什么本项目不用）；ASG 的几种扩缩容策略（目标跟踪、步进、简单、预定、预测）；冷却时间和预热时间；生命周期钩子；终止策略；Spot 中断。

**验收**：手动终止一台实例，ASG 会自动补上，用户访问不中断；压测时实例数会上升，压测停止后会降回 2；直接访问 ALB 的 DNS 名称会被拒绝。

---

## Lab 8：解耦（SNS 扇出 + SQS）

**步骤**
1. 现在需要给同一个上传事件再加一个处理方（打标签）。先尝试在 S3 上再加一条后缀重叠的事件通知，看到报错。
2. 重构：S3 → SNS `photo-events`，然后由 SNS 分发给缩略图 Lambda 和 SQS `image-label-queue` 两个订阅者。
   （也可以改用 S3 → EventBridge 规则，两种做法对比一下。）
3. 编写 `image-labeler` Lambda：
   - 事件源映射（Event Source Mapping）：批大小 10，批处理窗口 5 秒。
   - 启用 `ReportBatchItemFailures`，只重试处理失败的消息。
   - 队列的可见性超时设为 360 秒，DLQ 最大接收次数设为 3。
   - 调用 Rekognition 的 `DetectLabels` 和 `DetectModerationLabels`。
4. 用脚本一次上传 200 张图片，观察队列积压情况和 Lambda 并发数的变化。

**考点**：SQS 标准队列和 FIFO 队列的区别；可见性超时；长轮询；DLQ；SNS 的扇出和消息过滤；SQS、SNS、EventBridge、Kinesis 分别适合什么场景；紧耦合和松耦合的区别。

**验收**：照片会出现 AI 标签；手动造一条“坏消息”，它最终会进入 DLQ；批量上传时 RDS 没有被压垮。

---

## Lab 9：Serverless API（点赞、评论、分享）

**步骤**
1. 按 [architecture.md §6.3](architecture.md#63-dynamodb社交数据) 创建 DynamoDB 表和 GSI，先使用按需容量模式。
2. 创建 API Gateway **HTTP API**，配置 JWT 授权器（issuer 填 Cognito User Pool 的地址）。
3. 编写 `social-api` Lambda：
   - 点赞：用条件写入（`attribute_not_exists`）保证不能重复点赞。
   - 计数：用原子操作 `ADD` 更新计数器。
   - 评论：写入后发布到 SNS `notifications`。
4. 分享链接：写入一条带 `expireAt` 的记录，在表上开启 TTL。
5. 在 CloudFront 上添加 `/social/*` 行为。
6. 给 API 配置限流（速率和突发上限），给 Lambda 设置预留并发 50。
7. **进阶**：把同样的接口用 REST API 再实现一次，对比使用计划（Usage Plan）、API Key、缓存、请求校验这几项功能。

**考点**：API Gateway 的 HTTP API 和 REST API 的区别；集成超时 29 秒的限制；DynamoDB 的分区键设计；GSI 和 LSI 的区别；按需和预置容量模式的区别；DAX；Streams；TTL；全局表。

**验收**：并发对同一张照片点 100 次赞，计数结果准确；不带 Token 调用返回 401；过期的分享链接会在 TTL 生效后被自动删除（注意可能有延迟）。

---

## Lab 10：安全加固与可观测性

**步骤**
1. 在 CloudFront 上挂载 WAF：AWS 托管规则组，外加限速规则；用脚本触发限速规则，确认会被拦截。
2. 开启 GuardDuty、AWS Config（加若干托管规则）和 Security Hub（可选）。
3. 给 S3 桶策略添加：拒绝 `aws:SecureTransport=false` 的请求；拒绝未使用 KMS 加密的上传。
4. 用 IAM Access Analyzer 检查有没有资源被意外公开。
5. 安装 CloudWatch Agent，采集内存、磁盘指标和应用日志；用指标过滤器统计错误，并配置告警，告警发到 SNS。
6. 搭建 `CloudAlbum-Overview` 仪表板。
7. Lambda 和 Express 都接入 X-Ray，查看服务地图（Service Map）。

**考点**：KMS 信封加密；密钥策略；SSE-S3、SSE-KMS、SSE-C 三种加密方式的区别；Secrets Manager 和 Parameter Store 的区别；WAF、Shield、Firewall Manager 的区别；GuardDuty、Inspector、Macie 的区别；CloudWatch 和 CloudTrail 的区别；Config 规则。

**验收**：触发限速后返回 403；X-Ray 中能看到 CloudFront → ALB → EC2 → RDS 的完整链路；人为制造 5XX 错误，5 分钟内能收到告警邮件。

---

## Lab 11：灾备与成本优化

**步骤**
1. 给 `raw` 桶配置 S3 **跨区域复制（CRR）**到灾备区域（前提是两边都开启了版本控制）。
2. 配置 S3 生命周期规则（Standard → Standard-IA → Glacier），在 `media` 桶上启用 Intelligent-Tiering。
3. 建立 AWS Backup 计划：每天备份 RDS 和 DynamoDB，备份副本复制到灾备区域。
4. 搭建 **Pilot Light** 环境：
   - 在灾备区域创建 RDS 跨区域只读副本。
   - 用同一份 CloudFormation 模板部署一个最小化的 ASG（desired=0）。
5. 配置 Route 53 **故障转移路由**和健康检查；在 CloudFront 中配置源站组（Origin Group）。
6. **演练**：把主区域的 ASG 缩到 0，然后提升灾备区的只读副本、扩容灾备区的 ASG。记录实际的 RTO 和 RPO。
7. 成本分析：
   - 打开 Cost Explorer，按 `Project` 标签查看费用。
   - 打开 Compute Optimizer，看看 EC2 的规格建议。
   - 用 Trusted Advisor 做一次检查。
   - 写一段对比：当前架构的费用 vs “全部改成 Serverless”的费用。

**考点**：RTO 和 RPO；四种灾备策略；S3 各存储类别及其最低存储期限；Route 53 的路由策略（简单、加权、延迟、故障转移、地理位置、地理邻近、多值）；Savings Plans 和预留实例的区别；Spot 实例的适用场景。

**验收**：完成一次有记录的故障切换演练（附截图和时间线）；产出一份成本分析报告。

---

## Lab 12：IaC 与 CI/CD（加分项）

**步骤**
1. 用 CloudFormation 按层拆分模板：`01-network`、`02-security`、`03-data`、`04-compute`、`05-edge`。层与层之间用 **Exports / ImportValue** 传递资源 ID。
2. Serverless 部分改用 AWS SAM 管理（`sam build && sam deploy`）。
3. 使用 CodePipeline：
   - 源码：GitHub（通过 CodeConnections 连接）。
   - 构建：CodeBuild。
   - 部署：CodeDeploy，对 ASG 做**蓝绿部署**，对 Lambda 做**金丝雀部署**（Canary10Percent5Minutes）。
4. 编写 `scripts/teardown`，按依赖关系倒序删除所有栈，最后清空并删除桶。

**考点**：CloudFormation 的栈、变更集、漂移检测、DeletionPolicy、StackSets；Elastic Beanstalk 和自己搭 ASG 的区别（了解）；部署策略（滚动、蓝绿、金丝雀）。

**验收**：在一个全新的账号里，一条命令就能拉起整套环境，也能一条命令全部删干净。
