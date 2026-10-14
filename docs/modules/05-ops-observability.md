# E 组：运维、监控与安全检测

本组 6 个模块回答“系统运行起来以后发生了什么”：运维人员怎么登录（shell-access）、发生过什么（logging）、现在健康吗、坏了谁来报警（monitoring）、一次请求慢在哪一段（tracing）、谁动过 AWS 资源（audit）、有没有人在攻击（threat-detection）。在 L0（仅 EC2）下，这些机能全部由 EC2 本地实现：SSH 22 端口 + 密钥对、EBS 上的日志文件 + logrotate、LabMetricsStore + 本地告警评估器、Server-Timing（本地档可记录本机 span）、应用内 `audit_log` 表、fail2ban + 本地分析器。它们都不改变业务功能，所以对比点集中在三件事上：实例坏了、被替换了以后还看不看得见；出事时谁来报警；事后能不能追溯到人。

本文是 E 组的定稿设计手册，挂在 [modular-design.md](../modular-design.md)（下称“总纲”）的框架上；本轮按完整性评审的统一值与主设计者的统一决策 D1～D15 收敛，修订摘要见文末“修订记录”。

- **ec2 基础契约不在本文定义。** 基础栈参数（`SshIngressCidr`、`KeyName`、`DetailedMonitoring` 等）、`l0-bootstrap.sh`、sshd 加固片段、fail2ban 的安装、root 安全快照定时器、`denylist.conf` 与它的 path 单元、Nginx 与 systemd 的扩展点，统一以 [00-ec2-base.md](00-ec2-base.md) 为准。本文只声明：各模块经 `baseParams` 设置哪些基础栈参数、往哪个扩展点投放什么、以及 ec2 安装的那些主机文件中“内容归本组定义”的部分（sshd 片段、`render-fail2ban.sh`、fail2ban 过滤器与动作、安全快照的 `sshd` / `fail2ban` 段）。
- **锚点。** 每个模块的二级标题前有稳定锚点（`#shell-access`、`#logging`、`#monitoring`、`#tracing`、`#audit`、`#threat-detection`），registry 的 `doc` 字段写成 `docs/modules/05-ops-observability.md#<id>`（D10）。
- **每个模块的结构**（总纲附录 A 的新模板，与 01、03 组采用同一编号方式）：第 0 节“元数据（registry 摘录）”；第 1～9 节沿用原结构（基线实现、AWS 实现、开关与配置、依赖与组合、对比实验、切换迁移回滚、SAA 考点、费用与清理、常见坑）；第 10 节“探针”（附录 A 的 2.x 小节）；第 11 节“前端徽章”（附录 A 的 5.x 小节）。正文中“见第 N 节”的引用仍指原编号。
- **Lab 与档位**以总纲第 10 节为准：shell-access 是 Lab 2、logging 与 monitoring 是 Lab 3（档位 `l1-ops`）；tracing 的本地档在 Lab 0 第二部分（`l0-plus-local-tiers`），xray 档是 Lab 22；audit 与 threat-detection 是 Lab 23（`l9-full`）。

## 本组模块一览

“凭证”列即 registry 的 `credentials`（D1）：`required` = 开关取 AWS 值时必须 `IAM_CREDENTIALS≠none`，否则 CRED-001（error）；`optional` = 只有控制面展示需要凭证，缺失时这些子功能关闭并给出 CRED-004（warn）。

| 模块 id | 机能 | 主 AWS 服务 | 开关（首个取值 = 本地实现 = 默认） | 类型 | 凭证 | 硬依赖（最小集合） | 能否在 L0 上单独启用 |
|---|---|---|---|---|---|---|---|
| shell-access | 运维登录 | AWS Systems Manager Session Manager | `SHELL_ACCESS_MODE=ssh\|ssm` | I | required（必须 `role`） | iam(role)（DEP-001）；实例出站 443 可达 ssm、ssmmessages 端点 | 否：{iam(role)} |
| logging | 日志 | Amazon CloudWatch Logs | `LOG_DRIVER=file\|cloudwatch` | A | required | —（实例出站可达 logs 端点） | 是（+iam） |
| monitoring | 指标、告警、仪表板 | Amazon CloudWatch（辅：模块自带 SNS 告警主题、CloudWatch Agent） | `METRICS_DRIVER=local\|cloudwatch` | A | required | —（人工前置：确认告警订阅；内存、磁盘指标需要 Agent，缺失时 degraded） | 是（+iam） |
| tracing | 分布式链路追踪 | AWS X-Ray（辅：CloudWatch Agent / ADOT Collector） | `TRACING_DRIVER=none\|local\|xray`（本地档 `local`） | A | required（仅 xray 档） | —（xray 档：本机收集器 + 出站可达 xray 端点） | 是（local 档不需要 AWS；xray 档 +iam） |
| audit | AWS API 操作审计 | AWS CloudTrail（辅：模块自带日志桶） | `AUDIT_MODE=app\|cloudtrail` | I | optional | —（已有 trail 时只读接入） | 是 |
| threat-detection | 威胁检测 | Amazon GuardDuty（辅：EventBridge、模块自带 SNS 主题） | `THREAT_DETECTION_MODE=fail2ban\|guardduty` | I | optional | —（已有 detector 时只读接入） | 是 |

**“能否在 L0 上单独启用”的含义**：与总纲 10.4 一致——“是”表示 L0 + 本模块（加最小硬依赖、凭证前置与人工前置）就能启动、通过健康探针并做对比实验；标“+iam”的模块在 `single/<id>.env` 中由 `gen-single` 自动并入 `iam`（`IAM_CREDENTIALS=role`）。shell-access 是本组唯一的“否”：Session Manager 依赖 SSM Agent，Agent 只用实例配置文件的角色凭证，不读取 keys 模式写在 `secrets.env` 中的 `IAM_KEYS_*`（总纲 3.2 决定 6），所以必须是 `role`（DEP-001）。

**本组公共约定**

1. **与总纲对齐**（本组不再保留对总纲的偏差；上一轮提出的细化已由总纲第 2 轮收录，见文末修订记录）
   - (a) **端口**（总纲 4.1、4.2）：`LoggerPort`（`ports/logger.ts`，驱动 `adapters/logging/{file,cloudwatch}.ts`）、`MetricsPort`（`ports/metrics.ts`，`adapters/monitoring/{local,cloudwatch}.ts`）、`TracerPort`（`ports/tracer.ts`，`adapters/tracing/{none,local,xray}.ts`），三者都是**非权威端口**：远端故障只把状态置为 `degraded` 并计数，绝不阻塞请求。写入侧签名与总纲一致；只读侧 `LogReader`、`MetricsReader`、`TraceReader` 写在同一文件中，本组只追加可选字段与方法、签名与总纲兼容（见各模块第 3 节）。驱动 id 等于开关取值。
   - (b) **纯基础设施型也有声明型开关**（D9，总纲 3.1）：shell-access 用 `SHELL_ACCESS_MODE=ssh|ssm`、audit 用 `AUDIT_MODE=app|cloudtrail`、threat-detection 用 `THREAT_DETECTION_MODE=fail2ban|guardduty`，第一个取值是本地实现，也是默认值（Core zod 的 `decl()`）。开关不切换业务代码，只决定感知器的预期结果、主机片段与 capabilities 展示。`MODULE_<ID>=on` 只表示“AWS 实现已部署”，**只在开关取 AWS 值时**写入 `modules.d/<id>.env` 第一行；CFG-004 据此校验半启用。应用侧只写感知器 `backend/src/modules/detectors/<id>.ts`。上一轮的 `MODULE_<ID>` 单独作开关、`SHELL_ACCESS`、`AUDIT_TRAIL`、`THREAT_DETECTION` 等写法一律作废。
   - (c) **tracing 的本地档 `local` 已被总纲收录**（不再是偏差）。`TRACING_DRIVER=none|local|xray`，`local` 是本地档（registry `localTiers: [local]`），与 `CACHE_DRIVER=memory`、`QUEUE_DRIVER=memory` 性质相同：不需要任何 AWS 资源，写入 `modules.d/tracing.env` 但**不写** `MODULE_TRACING=on`（CFG-004 由 `localTiers` 豁免）。它与总纲的对应关系见 tracing 模块第 0 节的对照表。
   - (d) monitoring 与 threat-detection **各自带一个 SNS 主题**（总纲 3.2 的辅助服务列），不依赖 notification 模块；notification 的 SNS 主题只用于终端用户通知（F10）。
   - (e) 只读与实验接口统一放在 `/api/lab/` 下（仅管理员，例如 `/api/lab/logs`、`/api/lab/traces`、`/api/lab/metrics`、`/api/lab/monitoring/alarms`、`/api/lab/shell-access`、`/api/lab/threat-detection/*`），与总纲 7.3、8.x 一致；审计页面是 `/admin/audit`，接口 `GET /api/admin/audit`。
   - (f) **文件布局**以总纲 2.4 与 [00-ec2-base.md](00-ec2-base.md) 3.4 为准：`/var/lib/cloudalbum/logs/` 下的 `api.log`、`worker.log`、`audit.log`、`nginx-access.json`（总纲 2.5 的 `cloudalbum_json` 格式，字段顺序是 fail2ban 过滤器的契约）与 `logs/spans/`（tracing 的 local 档）；`/var/lib/cloudalbum/security/`（`root:cloudalbum 2770`，00 的 E8）存放 `snapshot.json`、`denylist.conf`、`denylist.lock`。Nginx 错误日志用 AL2023 默认路径 `/var/log/nginx/error.log`（00 的 `nginx.conf` 已设置）。
   - (g) **跨模块参数只用提供方声明的 `injects`**（D2，总纲 3.5、9.1）。monitoring、audit、tracing 的栈需要别的模块的资源 ID 时，由**提供方**在自己的 registry 条目里声明 `injects`，`scripts/module` 在提供方启用、输出变化或禁用时自动更新被注入的栈；被注入方不声明“我依赖谁”，也不需要“再执行一次 enable”去刷新。本组涉及的注入汇总在约定 11。

2. **共享一个 CloudWatch Agent。** monitoring（metrics 段：内存、磁盘；可选 EMF 接收端口）、tracing（traces 段：OTLP 接收 + X-Ray 采样代理）以及 logging 的可选 agent 投递方式，共用一个 `amazon-cloudwatch-agent` 进程。规则：
   - 每个模块的片段放在发布包的 `infra/modules/<id>/cwagent.json`，由 registry 字段 `cwAgentFragment` 声明（总纲 3.5 已收录）。
   - 安装与投递都在该模块的 `hostSetup` 脚本（`infra/modules/<id>/host-setup.sh apply|revert`，root、幂等，00 的 6.9）中完成：没有 Agent 时 `dnf install -y amazon-cloudwatch-agent`；然后 `amazon-cloudwatch-agent-ctl -a append-config -m ec2 -s -c file:/opt/cloudalbum/infra/modules/<id>/cwagent.json`。`revert` 执行 `-a remove-config -c file:<同一路径> -s`；最后一个片段被移除后执行 `-a stop`。L0 的 User Data **不安装** Agent，保持“只有 EC2”时的纯净。
   - **重放契约**（00 的 E12）：实例被替换（network 迁移、ami 切换、`rebuild-instance`）后根卷是全新的，`l0-bootstrap.sh postattach` 调用 `run-hostsetup.sh --all`，按 `modules.d/` 重新执行各模块的 `apply`，Agent 与片段随之恢复。片段只能由“发布包 + `modules.d/<id>.env`”渲染，不得手工修改后依赖它长期存在。
   - 各片段只写自己的段，不写 `agent` 全局段，避免合并冲突（多个片段同时含 `logs` 段时的合并行为以官方文档为准，在沙箱中先验证）。
   - **凭证**：Agent 使用实例配置文件（`IAM_CREDENTIALS=role`）的凭证。keys 模式下 Agent **不会**读取 `secrets.env` 中的 `IAM_KEYS_*`；按 D5（机密只在 `secrets.env` 与 `keys/*.pem`）本项目**不**为 Agent 另写一份 AWS 凭证文件，因此 keys 模式下 `hostSetup` 拒绝投放 Agent 片段，依赖 Agent 的子功能关闭（monitoring 的内存、磁盘指标与 EMF；logging 的 agent 方式；tracing 的 xray 档），对应模块为 `degraded` 或 `error`，CRED-002 的 detail 会点出这一点（总纲 5.2：“Agent 类功能需要 role”）。
   - 版本：X-Ray 接收 W3C 格式 trace ID 需要 Agent 1.300030.0 或更新（AWS What's New 2023-10-27，核实日期 2026-10-13）；`hostSetup` 安装后检查版本，低于要求时 tracing 为 `degraded`。

3. **root 安全快照（由 ec2 提供，本组定义其中两段）。** API 进程以 `cloudalbum` 用户运行，读不到 journal 和 fail2ban。`cloudalbum-security-snapshot.timer`（root，每 2 分钟）与 `/usr/local/lib/cloudalbum/security-snapshot.sh` 由 ec2 安装（00 的 3.5、6.5），原子写入 `/var/lib/cloudalbum/security/snapshot.json`（`root:cloudalbum 0640`，结构见 00 第 7 节）。本组定义其中的两段，字段只增不改：
   - `sshd`：`listening`；`failures24h`（`journalctl -u sshd --since -24h -o cat | grep -cE 'Failed|Invalid user'`）；`recentLogins[]`（最近 20 次 `Accepted publickey`，含公钥指纹与来源 IP）；`effective`（`sshd -T` 中 `passwordauthentication`、`permitrootlogin`、`maxauthtries`，供 compliance 的本地自检器复用）。
   - `fail2ban`：`available`（是否安装并在运行）；`banMode`（`nftables` 或 `denylist`，见 threat-detection）；`jails[]`（每个 jail 的当前封禁 IP 与累计封禁数，来自 `fail2ban-client status <jail>`）。
   感知器只读这个文件，不需要 root 权限；快照超过 5 分钟未更新时，依赖它的检查项降为 `inferred`（00 第 7 节的 `security-snapshot` 检查项）。

4. **告警与安全事件的送达路径**（对比点之一，见 monitoring 与 threat-detection）：

   | 场景 | 谁在判断 | 怎么送达 | 实例宕机时 |
   |---|---|---|---|
   | L0 | worker 中的本地告警评估器、本地安全分析器 | 管理员站内信（`notifications` 表）+ EmailPort（outbox 或 ses） | 全部沉默 |
   | monitoring 启用 | CloudWatch 告警 | 告警动作 → monitoring 自带的 SNS 主题 `cloudalbum-<env>-ops-alarms` → 邮件订阅 | 心跳告警、状态检查告警照常触发 |
   | threat-detection 启用 | GuardDuty | EventBridge 规则 → 自带的 SNS 主题 `cloudalbum-<env>-security-findings` → 邮件订阅 | 不受影响（检测在 AWS 侧） |

   SNS 主题如果要加密，必须用客户托管密钥（kms 模块经 `injects` 把 `KmsKeyArn` 注入本组各栈），并在密钥策略里允许 `cloudwatch.amazonaws.com`、`events.amazonaws.com` 使用；AWS 托管密钥 `aws/sns` 不行。邮件订阅需要收件人点击确认（registry `prerequisites: [confirm-email]`，单模块冒烟矩阵中标为“需人工”）。

5. **凭证（D1）。** 开关统一为 `IAM_CREDENTIALS=none|role|keys`：`none` 是 L0（应用不加载 AWS SDK），`role` 与 `keys` 都由 iam 栈提供；`keys` 是长期访问密钥的反面教材，密钥值只写在 `secrets.env` 的 `IAM_KEYS_*`（D5）。本组各模块的 `credentials`：shell-access `required` 且必须 `role`（DEP-001）；logging、monitoring `required`；tracing `required`（只在 xray 档；local 档不调用 AWS API）；audit、threat-detection `optional`（trail、detector 由部署者身份创建，即使应用没有凭证也照常工作，只有控制面展示需要凭证，缺失时 CRED-004）。启用了 `required` 模块而 `IAM_CREDENTIALS=none` → CRED-001（error，退出码 78）；`keys` → CRED-002（warn）。keys 模式下应用侧 SDK 调用照常，但依赖 Agent 的子功能关闭（约定 2）。各模块栈只输出 `PolicyArn`，由 `scripts/module` 附加到 `CloudAlbumAppRole`（keys 模式下附加到演示用户 `cloudalbum-app`），附加关系记入 `.cloudalbum/state.json`；模板**不写** `Roles` / `Users`（D2）。本组默认不附加任何 AWS 托管策略（shell-access 的 `--managed-core` 是唯一的对照选项）。

6. **私有子网（network 模块 `NETWORK_PLACEMENT=private`）所需的端点。** 统一走 NAT Gateway 时不需要额外配置；不用 NAT 时，由 network 栈的 `InterfaceEndpoints` 参数创建 Interface Endpoint（开启 Private DNS，01#network：`ops` 档含 `ssm`、`ssmmessages`、`logs`、`monitoring`，其余端点用 `all` 档）。network 的 DEP-009 部署检查逐模块探测端点可达性（01#network）；下表是本组模块需要的端点清单。

   | 模块 | 需要的端点 |
   |---|---|
   | shell-access | `ssm`、`ssmmessages`、`ec2messages`（Agent 3.3.40.0 起优先走 ssmmessages，官方称可不再需要 ec2messages，但本项目仍建议创建，以官方文档为准）；会话日志加 `logs`；会话加密加 `kms` |
   | logging | `logs` |
   | monitoring | `monitoring`；EMF 方式加 `logs`；Agent 读取 ASG 名称需要 `ec2` |
   | tracing | `xray` |
   | audit、threat-detection（仅应用侧只读展示） | `cloudtrail`、`guardduty`；CloudTrail 和 GuardDuty 本身的数据采集不经过你的 VPC |

7. **多实例（autoscaling）。** 本组所有基线数据都是“每台实例一份”：本地日志文件、本地 span 文件、fail2ban 封禁、sshd 记录；LabMetricsStore 的分钟汇总写入共享数据库，原始样本仍按实例分散。`/lab` 上凡是来自本地文件的数据都要显示“数据来自 i-xxxx”徽章，这正是 logging、monitoring、tracing 的核心对比点。审计表在数据库中，多实例需要 `DB_DRIVER=postgres`（ASG-002 本来就要求），哈希链需要串行写入。规则 ASG-009（`LOG_DRIVER=file`）、ASG-010（`METRICS_DRIVER=local`）只产生警告。多实例时本组的主机级产物（Agent 片段、tracing drop-in、`cloudalbum-ops` 用户）由 autoscaling 的引导配置包 + `run-hostsetup.sh --all` 在每台新实例上重放。

8. **远程执行通道。** 总纲 9.2 规定 `scripts/module` 在 L0 通过 ssh 投递配置、重启服务，`SHELL_ACCESS_MODE=ssm` 后改用 SSM Run Command（`AWS-RunShellScript`）。shell-access 的启用流程必须保证：在关闭 22 端口之前，SSM 通道已经验证可用。

9. **故障注入**使用总纲 8.4 的共享设施 `POST /api/lab/faults`（`GET` 列出、`DELETE` 撤销；总开关是运行时热键 `featureFlags['lab.faults']`，默认关闭；仅管理员；写 `audit_log`；被注入的请求在路径头对应段的 outcome 中带 `fault`）。本组用到的类型与细化：
   - `error5xx`（`rate`）、`latency`（`target=database|cache|storage`、`ms`、`rate`）、`mem`（分配上限 512 MiB，t3.small / t4g.small 只有 2 GiB 内存）、`cpu`（占满一个核）；`durationSec` 上限 900 秒，到期自动解除。
   - 实现：`backend/src/observability/faults.ts`，在 instrument 代理和 Express 中间件里生效，业务代码不感知。
   - 主机级故障（停服务、停实例、篡改审计表）放在 `experiments/<id>/faults/*.sh`，经投递通道执行。

10. **后台任务。** 告警评估（30 秒一次）和本地安全分析（5 分钟一次）是 worker 进程内的循环 + LockPort 单例，**不是**定时任务，不进 `ScheduledJobName`（总纲 2.6、4.2）；EventBridge Scheduler 的粒度与 tick 队列不适合 30 秒级任务。审计保留期清理是定时任务 `audit.retention`（每日一次，经 SchedulerPort；已在总纲 4.2 的 8 个任务中）。

11. **本组涉及的跨模块注入**（D2：只由提供方在自己的 registry 条目中声明 `injects`，格式 `{ target, stack?, params, when? }`，总纲 3.5）。被注入的参数在本组模板中一律可选、默认 `''`，用 `Condition` 判断；提供方禁用时 `scripts/module` 先用空值更新被注入的栈。

    | 提供方（声明方） | 目标栈 | 参数 | 条件 | 声明写在 |
    |---|---|---|---|---|
    | kms | 本组全部栈（`target: "*"`，即声明了该参数的模板） | `KmsKeyArn`：日志组、SNS 主题、trail 桶、会话数据加密 | — | 02#kms（密钥策略需授权的服务主体见约定 4 与各模块第 4 节） |
    | logging | monitoring | `LogErrorsNamespace` | — | 本文 logging 第 0 节 |
    | monitoring | audit | `AlarmTopicArn`（CloudTrail 指标过滤器告警发到 ops-alarms 主题） | — | 本文 monitoring 第 0 节 |
    | monitoring | backup | `AlarmTopicArn`（备份 / 复制作业失败通知发到 ops-alarms 主题） | — | 本文 monitoring 第 0 节 |
    | tracing | image-processing | `Tracing: Active`（Lambda 主动追踪 + 执行角色 X-Ray 写权限） | `TRACING_DRIVER=xray` | 本文 tracing 第 0 节 |
    | tracing | workflow | `Tracing: Active`（状态机 `TracingConfiguration`） | `TRACING_DRIVER=xray` | 本文 tracing 第 0 节 |
    | storage | audit | `DataEventBuckets`（原图桶、媒体桶，只记录写数据事件） | — | 03#storage（已声明） |
    | load-balancer、autoscaling、database、cache、queue、image-processing、social-api、workflow | monitoring | `AlbFullName`、`TargetGroupFullName`、`AsgName`、`DbInstanceId`、`CacheReplicationGroupId`、`QueueName`、`DlqName`、`ThumbFunctionName`、`SocialApiId`、`StateMachineArn` | — | 01、03、04、06 各模块条目（已声明） |

    ec2 基础栈的 `InstanceId`、`InstanceSecurityGroupId` 等属于框架提供的“基础上下文”（总纲 9.1），不算注入。各模块完整的 registry 摘录见各自第 0 节。

12. **启用顺序**以总纲 10.2、10.3 为准（本组不再自定顺序）：Lab 1～3 的 `l1-ops` 依次启用 iam、cost、shell-access、logging、monitoring；tracing 的本地档在 `l0-plus-local-tiers`，xray 档与 audit、threat-detection 在 `l9-full`（Labs 22～23）。tracing 放在最后，是因为它在 queue、storage、database 等模块启用之后才最有看头。

13. **对现有文档的修正**（已由总纲附录 B 第 12 行收录，labs.md 由主设计者按 10.3 改写）：
    - 旧 labs.md Lab 10（新编号 Lab 22）的验收标准“X-Ray 中能看到 CloudFront → ALB → EC2 → RDS 的完整链路”不成立：CloudFront 和 ALB 都不会成为 X-Ray 节点（ALB 只注入 `X-Amzn-Trace-Id` 头）。改为“服务地图中能看到 cloudalbum-api → RDS / S3 / SQS → cloudalbum-worker（同一条 trace）；Lambda 缩略图是另一条 trace，按 `photo_id` 注解关联”。另外 API Gateway HTTP API 不支持 X-Ray，只有 REST API 支持。
    - 旧 labs.md Lab 0 第 4 步创建多区域 trail；新 Lab 顺序不再在 Lab 0 建 trail，但账号里可能已有 trail（组织 trail、以前的练习），所以启用 audit 前仍先检测（registry `preflight: [existing-trail]`），避免在同一区域产生第二份**收费**的管理事件副本。
    - GuardDuty 不需要事先开启 VPC Flow Logs，也不需要创建 trail；CloudTrail Event History 不需要创建 trail 就存在（90 天管理事件）。
    - AL2023 默认没有 rsyslog，也没有 `/var/log/secure`，sshd 日志只在 journal 里；fail2ban 由 AL2023 核心仓库提供（见 threat-detection 第 1 节）。

14. **安全**：`/api/lab/*`、`/api/admin/*` 只允许管理员；`/metrics` 只允许本机访问（总纲 2.5）；日志、审计、span 的脱敏规则统一放在 `backend/src/observability/redact.ts`（Authorization、Cookie、密码、令牌、预签名 URL 的签名参数、`X-CloudAlbum-Trace` 强制采样令牌）。本组任何 env 文件都不含机密类键（CFG-002）；强制采样令牌由 `CALLBACK_HMAC_KEY`（在 `secrets.env`）每日派生，不新增机密。

15. 本文中的限额、价格、时延都只给定性描述和数量级，具体数值以官方文档为准；较新的事实注明核实日期（D14）。

```mermaid
flowchart LR
  subgraph EC2 [EC2（L0 已有）]
    APP[api / worker] -->|pino JSON| F[(logs/*.log)]
    APP -->|LabMetricsStore| DB[(lab_metric_rollups)]
    APP -->|Server-Timing / span| SP[(logs/spans)]
    APP -->|audit.record| AT[(audit_log)]
    SNAP[root 安全快照] --> SJ[(security/snapshot.json)]
    F2B[fail2ban] --> SJ
  end
  F -. logging .-> CWL[(CloudWatch Logs)]
  DB -. monitoring .-> CWM[(CloudWatch 指标 / 告警)]
  SP -. tracing .-> XR[(X-Ray)]
  AT -. 互补 .- CT[(CloudTrail · audit)]
  SJ -. 互补 .- GD[(GuardDuty · threat-detection)]
  OPS[运维] -->|SSH 22 / Session Manager| EC2
```

<a id="shell-access"></a>

## shell-access：运维登录 ↔ AWS Systems Manager Session Manager

> 一句话总结：没有它时，运维用 SSH（22 端口 + 密钥对）登录 EC2，安全组必须对运维 IP 开放 22 端口，事后只能知道“哪把钥匙从哪个 IP 登录过”；启用后，实例上的 SSM Agent 主动向外建立 443 长连接，运维用自己的 IAM 身份经 Session Manager 登录和做端口转发，安全组可以没有任何管理端口入站，每次会话都能追溯到 IAM 身份，会话内的命令和输出写进 CloudWatch Logs。最直观的区别：/lab 的 shell-access 卡片从红色徽章“入站 22/tcp ← 203.0.113.10/32”变成绿色“无管理端口入站 · SSM Agent Online”；从公网探测 22 端口，结果从 open 变成超时（filtered）。

### 0. 元数据（registry 摘录）

```yaml
# modules/registry.yaml 中 shell-access 的条目（摘录；不一致时以 registry 为准，并同步本节）
shell-access:
  group: E
  function: 运维登录
  awsService: AWS Systems Manager Session Manager
  auxServices: []                        # 会话日志组是本模块自建资源；Run Command 只作为 scripts/module 的投递通道
  type: infra                            # 无端口，只有感知器
  detector: detectors/shell-access.ts
  switch: { var: SHELL_ACCESS_MODE, values: [ssh, ssm], ownedValues: [ssm], localTiers: [] }
  ownsEnv: [SHELL_ACCESS_, SSM_SESSION_]
  credentials: required                  # 且必须是 role：SSM Agent 不读取 keys 模式的 IAM_KEYS_*
  prerequisites: []                      # AL2023 官方 AMI 预装 SSM Agent；自制 AMI 需自行安装（ami 模块的配方已包含）
  requires:
    - { rule: DEP-001, when: { SHELL_ACCESS_MODE: ssm }, need: ["IAM_CREDENTIALS=role"] }
  soft: [logging, kms]                   # logging：会话日志可与应用日志联合查询；kms：会话数据与日志组加密
  conflicts: []
  authoritative: false
  bypass: []
  baseParams: { SshIngressCidr: '' }     # 关闭 22 端口；SHELL_ACCESS_KEEP_SSH=true（过渡期）时 scripts/module 不下发，SEC-003 为预期内 warn
  hostSetup: infra/modules/shell-access/host-setup.sh   # apply：创建 cloudalbum-ops 与受限 sudoers；revert：删除（00 的 6.9）
  preflight: [ssm-session-preferences, policy-quota]    # 备份区域级单例文档 SSM-SessionManagerRunShell；托管策略配额
  stacks: [{ name: main, template: infra/modules/shell-access.yaml }]
  # 本栈接收的注入：KmsKeyArn（kms，target "*"）。本模块不向其他栈注入
  probe: { kind: detector, intervalSec: 60 }
  billing:
    - { resource: "会话日志（CloudWatch Logs 摄取与存储）", dimension: usage }
  lab: { compare: before-after, hourlyBilled: false, experiments: [probe-port, ssh-noise, session-audit, private-subnet] }   # 文案见第 11 节
  doc: docs/modules/05-ops-observability.md#shell-access
```

- 类型 I（纯基础设施型）：声明型开关 `SHELL_ACCESS_MODE=ssh|ssm`，`ssh` 是本地实现；只有 `ssm` 时写 `MODULE_SHELL_ACCESS=on`（CFG-004）。应用侧没有端口和驱动，只有感知器；capabilities 中 `driver` 等于开关取值（`ssh` / `ssm`）。
- 硬依赖只有一条 DEP-001（`SHELL_ACCESS_MODE=ssm` 而 `IAM_CREDENTIALS≠role`）；运行中若安全组仍开放 22，产生 SEC-003（warn）。
- 带外资源：会话首选项文档 `SSM-SessionManagerRunShell` 是账号 × 区域级单例，不由 CloudFormation 管理，`scripts/module` 修改前备份并记入 `.cloudalbum/state.json`，disable 时按记录还原（总纲 9.2 disable 第 6 步“谁创建谁清理”）。

### 1. 基线实现（仅 EC2）

- **入口与密钥**：基础栈参数 `KeyName`（默认 `cloudalbum-key`）与 `SshIngressCidr` 的类型、默认值、写入方与更新影响以 [00-ec2-base.md](00-ec2-base.md) 6.2 为准，这里只摘要：实例带密钥对启动；安全组的 22/tcp 入站规则由 `SshIngressCidr` 控制，首次部署时 `scripts/module` 填运维者公网 IP/32，模板默认 `''`、**不提供 `0.0.0.0/0`**（掩码短于 /32 时 preflight `ec2-ssh-cidr` 要求显式确认）；为空字符串时 Condition 不创建 22 端口规则。shell-access **不修改** `KeyName`（防锁死，见第 6 节）。
- **sshd 加固**（ec2 在 `install` 阶段写入 `/etc/ssh/sshd_config.d/40-cloudalbum.conf`，00 的 6.5；内容由本组定义）：

  ```text
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PermitRootLogin no
  MaxAuthTries 3
  AllowUsers ec2-user
  LogLevel VERBOSE          # 日志里记录登录所用公钥的指纹
  ```

  文件名用 `40-` 前缀：AL2023 自带 `50-redhat.conf`，而 sshd 对同一选项“先读到的值生效”，必须排在它前面。写入后执行 `sshd -t && systemctl reload sshd`。
- **审计**：AL2023 默认不装 rsyslog，没有 `/var/log/secure`，sshd 日志只在 systemd journal 里（`journalctl -u sshd`）；`last` 读取 wtmp 显示登录历史。能知道的只有“哪把公钥（指纹）从哪个 IP、什么时间登录”，**不知道登录后执行了什么**（bash history 由用户自己控制，不能算审计）。
- **防爆破**：`MaxAuthTries 3`，加上 threat-detection 基线中 fail2ban 的 `sshd` jail（`backend = systemd`）。
- **端口转发**：`ssh -i cloudalbum-key.pem -L 13000:127.0.0.1:3000 ec2-user@<EIP>`，然后在本机访问 `http://localhost:13000/api/health/ready`。
- **状态采集**：使用本组公共约定 3 的 root 安全快照（ec2 提供，每 2 分钟）中的 `sshd` 段：`listening`、`failures24h`、`recentLogins[]`（来自 `Accepted publickey` 行，含指纹与来源 IP）、`effective`。
- **感知器** `backend/src/modules/detectors/shell-access.ts`：`SHELL_ACCESS_MODE=ssh` 时 `status=off`，`localHealth` 由快照决定（sshd 在监听且快照不超过 5 分钟为 ok）。/lab 卡片显示“sshd 监听 22 · 近 24 小时失败 N 次 · 最近登录列表”。安全组规则只有在“有 AWS 凭证且有 `ec2:DescribeSecurityGroups` 权限”时才能确认（`confirmed`）；L0 没有凭证（`IAM_CREDENTIALS=none`），卡片按快照中的监听端口与开关取值推断（`inferred`）。
- **投递通道**：`scripts/module` 用 `ssh` 写 env 文件、重启服务（总纲 9.2）。
- **局限**：私钥要分发、轮换，丢了要换密钥对；运维 IP 一变就要改安全组；没有命令级审计；实例进了私有子网就要另建堡垒机。

### 2. AWS 实现

**前提**：AL2023 官方 AMI 预装并默认启用 `amazon-ssm-agent`（systemd 服务）。实例拿到角色凭证、并且能连上 SSM 端点后，会自动注册为“托管节点”，`PingStatus` 变为 `Online`。

**CloudFormation：`infra/modules/shell-access.yaml`**

| 资源 | 说明 |
|---|---|
| `AppPolicy`（`AWS::IAM::ManagedPolicy`，`cloudalbum-<env>-shell-access`） | 输出为 `PolicyArn`。**模板不写 `Roles` / `Users`，也不 `ImportValue` 任何角色名**（D2）：由 `scripts/module` 在 enable 第 5 步附加到 `CloudAlbumAppRole`，附加关系记入 `.cloudalbum/state.json`，disable 时据此分离。keys 模式不适用（DEP-001 要求 `role`）。内容：① Agent 核心权限，等价于 AWS 托管策略 `AmazonSSMManagedInstanceCore` 中会话所需的部分：`ssm:UpdateInstanceInformation`、`ssm:ListInstanceAssociations`、`ssm:DescribeAssociation`、`ssm:GetDocument`、`ssm:DescribeDocument`、`ssm:UpdateInstanceAssociationStatus`、`ssmmessages:CreateControlChannel/CreateDataChannel/OpenControlChannel/OpenDataChannel`、`ec2messages:*`；② 写会话日志：`logs:CreateLogStream`、`logs:PutLogEvents`（资源限定为会话日志组），`logs:DescribeLogGroups`、`logs:DescribeLogStreams`（这两个不支持限定到单个日志组，Resource 只能写 `*`）；③ 可选：会话加密密钥上的 `kms:Decrypt`、`kms:GenerateDataKey`，S3 归档的 `s3:PutObject`、`s3:GetEncryptionConfiguration`；④ 感知器只读：`ssm:DescribeInstanceInformation`、`ssm:DescribeSessions`、`ec2:DescribeSecurityGroups` |
| `SessionLogGroup` | `/cloudalbum/<env>/ssm-sessions`；`RetentionInDays` 用参数控制（默认 30）；参数 `KmsKeyArn`（由 kms 的 `injects` 注入，默认 `''`）非空时加密；`DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` |
| `OperatorPolicy` | 给“人”用的客户托管策略 `cloudalbum-<env>-operator-session`（见第 3 节），以 `InfoOperatorPolicyArn` 输出；由运维者自己挂到 Identity Center 权限集或自己的角色上，模板不挂 |
| Outputs | `ModuleId`、`ModuleVersion`、`PolicyArn`、`EnvShellAccessMode`（= `ssm`）、`EnvSsmSessionLogGroup`、`EnvSsmSessionRunAs`、`InfoOperatorPolicyArn`、`InfoSessionHistoryUrl`（控制台会话历史链接）。不使用 `Export` |

```yaml
# infra/modules/shell-access.yaml（AppPolicy 片段：上一轮草稿中的 Roles: [!ImportValue …] 写法作废）
  AppPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: !Sub 'cloudalbum-${Env}-shell-access'   # 不写 Roles / Users：由 scripts/module 附加（D2）
      PolicyDocument: { Version: '2012-10-17', Statement: [ ... ] }  # 内容见上表
Outputs:
  PolicyArn: { Value: !Ref AppPolicy }                         # 没有 Export
```

为什么不直接附加 `AmazonSSMManagedInstanceCore`：省事，但它还授予了对**所有** Parameter Store 参数的 `ssm:GetParameter(s)` 等权限，对一个只需要会话功能的实例来说过宽。`scripts/module enable shell-access --managed-core` 保留这个选项，用来对比“托管策略 vs 最小权限”。

**基础栈参数**：注册表声明 `baseParams: { SshIngressCidr: '' }`（写入规则见 00 的 6.3）。`scripts/module` 在 SSM 通道验证成功后更新基础栈，模板的 Condition 删除 22 端口入站规则；原来的 CIDR 记在 `.cloudalbum/state.json` 的 `baseParams` 段，供 `--reopen-ssh` 回滚使用。`SHELL_ACCESS_KEEP_SSH=true`（过渡期或并排对比）时不下发该参数，此时状态为 `degraded`，并触发 SEC-003 警告。

**会话首选项**：`SSM-SessionManagerRunShell` 是**每个账号每个区域一份**的单例文档，修改它会影响该区域所有会话；如果用 CloudFormation 直接创建，文档已存在时会冲突。所以由 `scripts/module` 处理（preflight `ssm-session-preferences`）：先 `aws ssm get-document` 备份到 `.cloudalbum/backup/SSM-SessionManagerRunShell-<时间>.json` 并把备份位置记入 state.json，存在则 `aws ssm update-document --document-version '$LATEST'`，不存在则 `create-document --document-type Session`，最后把新版本设为默认版本。写入的内容见第 3 节，要点：
- `cloudWatchLogGroupName` 指向会话日志组，`cloudWatchStreamingEnabled=true`（边执行边上传；false 则会话结束时一次性上传）。
- `cloudWatchEncryptionEnabled=false`：这个选项的含义是“只允许写入已加密的日志组”。日志组没有 KMS 加密时如果它为 true，会话日志会写入失败。启用 kms 模块并给日志组设置了 `KmsKeyId` 后再改为 true。
- `runAsEnabled=true`、`runAsDefaultUser=cloudalbum-ops`：默认的 `ssm-user` 有免密 sudo，AL2023 上的 `ec2-user` 同样有免密 sudo，**改成 ec2-user 并不能降低权限**。所以本模块的 `hostSetup`（`apply`）创建专用 OS 用户 `cloudalbum-ops`（00 的 6.9 允许创建 `cloudalbum-` 前缀的系统用户；实例替换后由重放契约重建），它的 sudoers 片段只允许 `systemctl status|restart cloudalbum-*`、`journalctl -u cloudalbum-*`、`nginx -t`、`systemctl reload nginx`。确实需要 root 的管理员，在自己的 IAM 角色（或身份中心会话标签）上加标签 `SSMSessionRunAs=ec2-user`，会话就以 ec2-user 身份打开（标签方式以官方文档为准）。
- `idleSessionTimeout=20`（分钟）、`maxSessionDuration=120`（分钟）。
- 可选 `kmsKeyId`：开启会话数据加密（kms 注入 `KmsKeyArn` 后由 `scripts/module` 写入首选项），此时实例角色需要该密钥的 `kms:Decrypt`，运维者需要 `kms:GenerateDataKey`。
- 注意：Run Command（`AWS-RunShellScript`）总是以 root 执行，不受 runAs 影响；`scripts/module` 的投递通道正是用它。

**感知器**：控制面三路信号（`DescribeInstanceInformation`、`DescribeSecurityGroups`、`DescribeSessions`）与状态判据见第 10 节。

**运维者使用方式**（运维侧需要 AWS CLI v2 和 Session Manager plugin）：

```bash
# 登录（以 cloudalbum-ops 身份打开 shell）
aws ssm start-session --target i-0123456789abcdef0

# 端口转发：本机 13000 → 实例 127.0.0.1:3000
aws ssm start-session --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["13000"]}'

# database=rds 时：经实例转发到私有 RDS，不必把 5432 开放给运维 IP
aws ssm start-session --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["15432"]}'

# scripts/module 的远程执行通道（Run Command，以 root 执行）
aws ssm send-command --instance-ids i-0123456789abcdef0 --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart cloudalbum-api cloudalbum-worker"]'
```

```mermaid
sequenceDiagram
  participant OP as 运维笔记本（CLI + plugin）
  participant SSM as Systems Manager（区域端点）
  participant AG as EC2 上的 SSM Agent
  participant CWL as CloudWatch Logs
  participant CT as CloudTrail
  AG->>SSM: 出站 443：注册、心跳（ssm）、控制通道（ssmmessages）
  OP->>SSM: StartSession（SigV4，IAM 鉴权 + 标签条件）
  SSM-->>CT: StartSession 管理事件（发起者 = 运维者 IAM 身份）
  SSM->>AG: 经已建立的控制通道下发“开会话”
  AG->>SSM: 出站建立数据通道
  OP->>AG: WebSocket 双向流（经 Systems Manager 中转；shell 或端口转发）
  AG-->>OP: 输出 / 转发的数据
  AG->>CWL: 会话日志（仅 shell 会话，端口转发不记录内容）
  Note over AG: 实例安全组没有任何入站规则也能工作：所有连接都由实例主动发起
```

**私有子网**（启用 network 后最有说服力的场景）：实例没有公网 IP、安全组没有入站规则，照样能登录。前提是有 NAT Gateway，或者有 `ssm`、`ssmmessages`（以及建议保留的 `ec2messages`）Interface Endpoint；写会话日志还要 `logs` 端点，会话加密还要 `kms` 端点。漏建 `ssmmessages` 时，实例可能显示 Online，但打不开会话。

### 3. 开关与配置

```bash
# /etc/cloudalbum/modules.d/shell-access.env（root:cloudalbum 0640，数据卷上）
# 由 scripts/module enable shell-access 写入；文件不存在 = SHELL_ACCESS_MODE=ssh（本地实现：SSH 22 + 密钥对）
MODULE_SHELL_ACCESS=on                              # 只在 SHELL_ACCESS_MODE=ssm 时写入（CFG-004）
MODULE_SHELL_ACCESS_VERSION=1
SHELL_ACCESS_MODE=ssm                               # ssh | ssm（第一个是本地实现）；来自 Outputs.EnvShellAccessMode
SSM_SESSION_LOG_GROUP=/cloudalbum/lab/ssm-sessions   # 来自 Outputs.EnvSsmSessionLogGroup
SSM_SESSION_RUN_AS=cloudalbum-ops                   # 来自 Outputs.EnvSsmSessionRunAs
SHELL_ACCESS_KEEP_SSH=false                         # true = 过渡期保留 22 端口（状态 degraded，SEC-003）
```

- 运维 IP（`SshIngressCidr`）是基础栈参数，不属于本模块的 env，记录在运维机 `.cloudalbum/state.json` 的 `baseParams` 段；fail2ban 的 `ignoreip` 另由 `scripts/module` 写入数据卷上的 `etc/fail2ban-ignoreip`（00 的 3.4）。
- 本模块是纯基础设施型，应用侧没有端口和驱动，只有感知器；env 中没有任何机密类键（CFG-002）。
- `X-CloudAlbum-Path` 中没有 shell-access 段（它不在请求路径上）。

会话首选项（`scripts/module` 写入 `SSM-SessionManagerRunShell`）：

```json
{
  "schemaVersion": "1.0",
  "description": "CloudAlbum session preferences (managed by scripts/module)",
  "sessionType": "Standard_Stream",
  "inputs": {
    "cloudWatchLogGroupName": "/cloudalbum/lab/ssm-sessions",
    "cloudWatchStreamingEnabled": true,
    "cloudWatchEncryptionEnabled": false,
    "s3BucketName": "",
    "s3EncryptionEnabled": false,
    "kmsKeyId": "",
    "runAsEnabled": true,
    "runAsDefaultUser": "cloudalbum-ops",
    "idleSessionTimeout": "20",
    "maxSessionDuration": "120"
  }
}
```

运维者的最小权限示例（`OperatorPolicy`；结构参照官方示例策略）：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "StartOnTaggedInstances",
      "Effect": "Allow", "Action": "ssm:StartSession",
      "Resource": "arn:aws:ec2:ap-northeast-1:<acct>:instance/*",
      "Condition": { "StringEquals": { "ssm:resourceTag/Project": "CloudAlbum" },
                     "BoolIfExists": { "ssm:SessionDocumentAccessCheck": "true" } } },
    { "Sid": "AllowedSessionDocuments",
      "Effect": "Allow", "Action": "ssm:StartSession",
      "Resource": [
        "arn:aws:ssm:ap-northeast-1:<acct>:document/SSM-SessionManagerRunShell",
        "arn:aws:ssm:ap-northeast-1::document/AWS-StartPortForwardingSession",
        "arn:aws:ssm:ap-northeast-1::document/AWS-StartPortForwardingSessionToRemoteHost" ] },
    { "Sid": "OwnSessionsOnly",
      "Effect": "Allow", "Action": ["ssm:TerminateSession", "ssm:ResumeSession"],
      "Resource": "arn:aws:ssm:*:*:session/${aws:userid}-*" },
    { "Sid": "ReadOnlyForConsoleAndCli",
      "Effect": "Allow",
      "Action": ["ssm:DescribeSessions", "ssm:GetConnectionStatus", "ssm:DescribeInstanceInformation", "ec2:DescribeInstances"],
      "Resource": "*" }
  ]
}
```

- AWS 自有文档（`AWS-StartPortForwardingSession*`）的 ARN 中账号字段为空。
- 会话 ID 的前缀取决于发起者的身份类型（IAM 用户、Identity Center、联合身份），`${aws:userid}` 是官方示例的写法，务必用自己的身份实测（以官方文档为准）。
- 用了会话数据加密（`kmsKeyId`）时，再加上该密钥的 `kms:GenerateDataKey`。

感知器要点：

```ts
// backend/src/modules/detectors/shell-access.ts（要点）
export const shellAccessDetector: DetectorFactory = (cfg, aws) => ({
  module: 'shell-access',
  async detect({ deep }) {
    const snap = await readSecuritySnapshot();                 // /var/lib/cloudalbum/security/snapshot.json
    if (cfg.core.SHELL_ACCESS_MODE === 'ssh') {                // 本地实现：capabilities 层把结果记为 localHealth，status=off
      return { status: 'ok', detail: `SSH 基线 · 近24h失败 ${snap.sshd.failures24h} 次`, confidence: 'inferred', data: { snap } };
    }
    const info = await aws.ssm().describeInstanceInformation({ Filters: [{ Key: 'InstanceIds', Values: [cfg.instanceId] }] });
    const ping = info.InstanceInformationList?.[0]?.PingStatus ?? 'NotRegistered';
    const open22 = await hasIngress22(aws.ec2(), cfg.instanceSecurityGroupId);
    const sessions = deep ? await recentSessions(aws.ssm(), cfg.instanceId, 20) : undefined;   // 结果缓存 60s
    if (ping !== 'Online') return { status: 'error', detail: `SSM Agent ${ping}`, confidence: 'confirmed' };
    if (open22) return { status: 'degraded', detail: 'Agent Online，但安全组仍开放 22（SEC-003）', confidence: 'confirmed' };
    return { status: 'ok', detail: `Agent Online · 无管理端口入站 · 会话日志 → ${cfg.env.SSM_SESSION_LOG_GROUP}`,
             confidence: 'confirmed', data: { sessions } };
  },
});
```

capabilities 示例：

```json
"shell-access": { "driver": "ssm", "awsService": "AWS Systems Manager Session Manager", "type": "infra",
  "status": "ok", "detail": "Agent Online · 无管理端口入站 · 会话日志 → /cloudalbum/lab/ssm-sessions",
  "confidence": "confirmed",
  "switch": { "var": "SHELL_ACCESS_MODE", "value": "ssm", "localValue": "ssh" },
  "deps": { "requires": ["IAM_CREDENTIALS=role"], "credentials": "required", "satisfied": true } }
```

### 4. 依赖与组合

**硬依赖**
- **iam（`IAM_CREDENTIALS=role`）**：实例挂着实例配置文件角色 `CloudAlbumAppRole`，`scripts/module` 把本模块的 `PolicyArn` 附加到它上面并记入 state.json（D2）。规则 DEP-001：`SHELL_ACCESS_MODE=ssm` 而 `IAM_CREDENTIALS≠role` → error。keys 模式不行：SSM Agent 在 EC2 上取的是 IMDS 中的角色凭证，不读 `secrets.env` 中的 `IAM_KEYS_*`。替代方案是账号级的 Default Host Management Configuration（DHMC）：它要求 IMDSv2 和较新的 Agent，并且影响整个区域的实例，不建议在共享账号中使用，本项目不采用。
- **SSM Agent 在运行**：AL2023 官方 AMI 已预装；自制 AMI 要自己安装并 `systemctl enable --now amazon-ssm-agent`。
- **IMDS 可用**：Agent 通过 IMDS 获取角色凭证，可以强制 IMDSv2，但不能关闭 IMDS（`HttpEndpoint=enabled`）。
- **出站网络**：实例能以 HTTPS 443 访问 `ssm`、`ssmmessages`（以及建议保留的 `ec2messages`）端点。L0 的默认 VPC 公有子网 + 弹性 IP 天然满足；私有子网见公共约定 6。
- **运维侧前提**（不属于模块依赖）：AWS CLI v2 + Session Manager plugin（只用控制台可以不装）；运维者的 IAM 身份要有 `OperatorPolicy` 中的权限。
- **启用校验**：关闭 22 端口之前，`scripts/module` 必须确认 `PingStatus=Online`，并用 `send-command` 冒烟成功，否则拒绝继续，22 端口保持不变（防止把自己锁在外面）。

**与其他模块组合**
- **iam**：启用后，CloudTrail 中 `StartSession` 的发起者是运维者的 IAM 身份，而不是“某一把 SSH 私钥”。
- **network**：私有子网中，实例没有公网 IP、没有任何入站规则也能登录（前提是 NAT 或端点）；否则 Agent 显示 `ConnectionLost`。
- **autoscaling**：ASG 中的实例没有固定 IP，也不应该分发私钥。按标签 `Project=CloudAlbum` 授权登录；Run Command 可以对整个 ASG 批量执行（`--targets Key=tag:aws:autoscaling:groupName,Values=<asg>`）。/lab 卡片按实例列出各自的 `PingStatus`。启动模板不再需要 `KeyName`。
- **threat-detection**：关闭 22 端口后，fail2ban 的 `sshd` jail 不再触发；GuardDuty 中 `UnauthorizedAccess:EC2/SSHBruteForce` 和针对 22 端口的 `Recon:EC2/PortProbeUnprotectedPort` 这类发现会逐渐消失。这是两个模块联动时最直观的对比。
- **audit**：`StartSession`、`ResumeSession`、`TerminateSession` 都是管理事件，Event History 默认就能查到；会话里执行的命令只在会话日志里，不进 CloudTrail。
- **logging**：会话日志写入本模块自建的日志组，不依赖 logging；logging 启用后可以在同一次 Logs Insights 查询中联合查询应用日志和会话日志。
- **kms**：会话数据加密和日志组加密；密钥策略要允许实例角色、运维者以及 `logs.ap-northeast-1.amazonaws.com` 服务主体。
- **database（RDS）**：用 `AWS-StartPortForwardingSessionToRemoteHost` 经实例转发到私有 RDS，取代“堡垒机”或“临时把 5432 开给运维 IP”。
- **config（ssm）**：config 只管运行时业务热键（D7），与本模块没有功能耦合；但注意 `--managed-core`（`AmazonSSMManagedInstanceCore`）会让实例能读取账号中**所有** Parameter Store 参数，包括 `/cloudalbum/<env>/runtime/*` 以外的参数，这正是默认用最小权限策略的原因。
- **vuln-scan（06）**：Amazon Inspector 的 EC2 扫描同样依赖“SSM 托管节点”（DEP-035），与本模块的前提相同；启用本模块后，vuln-scan 的托管节点前提自然满足。
- **compliance（06）**：AWS Config 托管规则 `restricted-ssh` 检查安全组是否对公网开放 22；本地自检器读安全快照的 `sshd.effective` 与监听端口。关闭 22 端口后两边的“SSH 暴露”项都转为合规。
- **load-balancer、cdn**：互不影响，它们只涉及 80/443。
- **scripts/module 与实验运行器**：本模块决定所有模块共用的远程执行通道和故障注入通道（总纲 §8.2 第 5 步）。

### 5. 对比实验：有 vs 没有

| 维度 | 没有 Session Manager（基线：SSH） | 有 Session Manager |
|---|---|---|
| 管理端口入站 | 22/tcp 对运维 IP 开放 | 无任何入站规则 |
| 长期凭证 | SSH 私钥（要分发、轮换、防丢） | 无；用 IAM 身份（Identity Center 临时凭证） |
| 授权粒度 | 有私钥就能登录 | IAM 策略 + 资源标签条件，可按实例、按文档（shell / 端口转发）授权 |
| 登录审计 | journal 中的“公钥指纹 + IP” | CloudTrail `StartSession`（IAM 身份、时间、来源） |
| 命令审计 | 无 | 会话日志（命令与输出，CloudWatch Logs / S3） |
| 运维 IP 变化 | 要改安全组 | 无影响 |
| 私有子网实例 | 需要堡垒机 | NAT 或端点即可 |
| 批量执行 | 自己写 ssh 循环 | Run Command 按标签批量 |
| 爆破噪声 | 22 端口暴露就会有 | 无（端口关闭） |
| 登录体验 | 直连，最快 | 需要先建立 WebSocket 通道，稍慢（秒级以内） |
| 费用 | 无 AWS 费用 | Session Manager 对 EC2 不额外收费；日志与端点另计 |

**页面上能直接看到的差异**
- /lab 的 shell-access 卡片：
  - 基线：红色徽章“入站 22/tcp ← 203.0.113.10/32”；“近 24 小时 sshd 失败 N 次”；“登录审计：仅 journal 中的 Accepted publickey，无命令记录”；最近登录列表（指纹 + IP）。
  - 启用后：绿色徽章“无管理端口入站”；“SSM Agent: Online（版本 x.y.z）”；最近会话列表（操作者 IAM ARN、开始和结束时间、时长、会话日志链接）。
  - 过渡期（`SHELL_ACCESS_KEEP_SSH=true`）：黄色徽章，两种记录并排列出。
- 控制台：Systems Manager → Session Manager → 会话历史；CloudWatch Logs 的 `/cloudalbum/<env>/ssm-sessions` 中有完整的命令和输出。
- `scripts/module status` 显示投递通道从 `ssh` 变成 `ssm`。

**测量指标**
1. 从公网探测 22 端口的结果（open / filtered）；2. 24 小时内 sshd 认证失败次数；3. 能否回答“哪个 IAM 身份在什么时间执行了哪些命令”（能 / 不能）；4. 需要分发和轮换的长期凭证数量；5. 私有子网中无公网 IP 实例能否登录（需要 network）；6. 同期 fail2ban `sshd` 封禁数与 GuardDuty 中 SSH 相关发现数（需要 threat-detection）；7. 建立会话所需时间（数量级）。

**操作步骤**（`experiments/shell-access/`，切换前后各跑一次；`--label before|after`）
1. 端口探测：在运维机上运行 `npm run exp -- shell-access --label before --scenario probe-port`。`probe-port.ts` 用 Node 的 `net.connect` 对 `<EIP>:22` 和 `:443` 各尝试 5 次（超时 3 秒），记录 open / refused / timeout。也可以手工执行 `nc -vz -w 3 <EIP> 22`。
2. 爆破噪声：`npm run exp -- shell-access --label before --scenario ssh-noise`。`ssh-noise.ts` 每小时读取一次 `GET /api/lab/shell-access`（快照中的 `failures24h` 与 fail2ban 封禁数），持续 24 小时后输出曲线。要观察“来自互联网的真实噪声”，必须把 `SshIngressCidr` 临时改为 `0.0.0.0/0`（基础栈 preflight `ec2-ssh-cidr` 要求显式加 `--i-understand-open-ssh`，并在 state.json 记下过期提醒，00 的 6.4），只能在自己的实验实例上做，做完立即改回。
3. 会话与端口转发（手工，步骤写在 `experiments/shell-access/README.md`）：`aws ssm start-session` 登录，执行 `id`（应为 `cloudalbum-ops`）和 `sudo systemctl status cloudalbum-api`（允许）、`sudo cat /etc/cloudalbum/secrets.env`（拒绝）；再用端口转发访问 `http://localhost:13000/api/health/ready`。
4. 审计链：`npm run exp -- shell-access --label after --scenario session-audit`。`session-audit.ts` 依次调用 `ssm:DescribeSessions --state History`、读取会话日志组最近 1 小时的事件、调用 `experiments/_lib/cloudtrail.ts --attr EventName=StartSession`（02 组共用的辅助脚本），把三者按会话 ID 对齐打印。CloudTrail 事件有几分钟延迟，脚本会轮询。
5. 私有子网（可选，需要 network）：在 app 子网启动一台没有公网 IP、安全组没有入站规则、挂着同一角色的临时实例，用 Session Manager 登录；再删掉 `ssmmessages` 端点，观察“Online 但打不开会话”。做完删除临时实例和端点。

**预期结果**
- 切换前：22 端口探测为 open。如果 CIDR 是 `0.0.0.0/0`，通常几小时内 journal 里就会出现来自互联网的扫描和爆破，每天数十到上千次，取决于所在 IP 段；只对自己 IP 开放时失败次数基本为零，但运维 IP 一变就要改安全组。
- 切换后：探测结果为超时（filtered），sshd 失败次数归零；每次会话都能追溯到 IAM 身份和时间，并有命令记录；不再需要分发私钥；端口转发取代“临时开放 3000 / 5432 端口”。
- 建立会话比 SSH 慢一点，差别在秒级以内。

**运行时 A/B 还是切换重启**：不涉及业务请求，不使用请求头 A/B。过渡模式（`SHELL_ACCESS_KEEP_SSH=true`）下两种登录方式同时可用，可以并排比较登录方式、端口转发和审计记录；“安全组没有任何入站规则”“爆破尝试归零”只能在关闭 22 端口之后测量，属于切换前 / 切换后对比。

### 6. 切换、数据迁移与回滚

**启用**：`scripts/module enable shell-access [--keep-ssh] [--managed-core]`（步骤编号对应总纲 9.2）
1. 计划校验：DEP-001（`IAM_CREDENTIALS=role`，`CloudAlbumAppRole` 已挂在实例上）；preflight `ssm-session-preferences`（读取并备份现有会话首选项）与 `policy-quota`；当前投递通道（ssh）可用。不满足即退出码 2。
2. 确认：提示将关闭 22 端口、投递通道将切换为 SSM。
3. 部署 `infra/modules/shell-access.yaml`（策略、会话日志组、运维者策略；`KmsKeyArn` 由 kms 的注入值提供，没有则为空）。
4. 生成 env 内容（`MODULE_SHELL_ACCESS=on`、`SHELL_ACCESS_MODE=ssm`、`SSM_SESSION_*`）。
5. 把 `PolicyArn` 附加到 `CloudAlbumAppRole`，记入 state.json（D2）。
6. 经当前通道（ssh）执行 `hostSetup apply`：创建 `cloudalbum-ops` 用户与 sudoers 片段（`visudo -cf` 校验）；`systemctl restart amazon-ssm-agent` 加快注册。轮询 `aws ssm describe-instance-information`，直到 `PingStatus=Online`（最长 5 分钟）；超时则中止，22 端口保持不变，退出码 5。
7. 冒烟：`aws ssm send-command` 执行 `AWS-RunShellScript`（`id; systemctl is-active cloudalbum-api`），确认返回成功。然后备份并更新会话首选项 `SSM-SessionManagerRunShell`（带外资源，记入 state.json）。
8. 原子写入 `modules.d/shell-access.env`，`cloudalbum check-config`；state.json 中的投递通道改为 `ssm`。
9. 经 SSM 重启 api 和 worker。如果没有 `--keep-ssh`（即 `SHELL_ACCESS_KEEP_SSH=false`）：按 `baseParams` 把 `SshIngressCidr` 置空，更新基础栈，删除 22 端口规则；原值记入 state.json 的 `baseParams` 段。可选 `--stop-sshd`：在实例上 `systemctl disable --now sshd`（默认不做，保留 sshd 便于回滚）。
10. 健康探针：从运维机探测 22 端口应为 filtered；发起一次测试会话；`/api/capabilities?deep=1` 中 shell-access 为 `ok`（`--keep-ssh` 时为预期内的 `degraded`）。

**禁用**：`scripts/module disable shell-access --reopen-ssh`（重新开放 22 端口必须显式确认，总纲 9.2 disable 第 5 步）
1. 读取 state.json 中记录的原 `SshIngressCidr`，询问当前运维 IP（可能已经变了），更新基础栈；同时更新 `etc/fail2ban-ignoreip`。用 ssh 验证可以连通，失败则中止并保留 SSM 通道。
2. 投递通道改回 `ssh`。
3. 用备份还原会话首选项（state.json 记录的带外资源）。
4. 删除 env（`SHELL_ACCESS_MODE` 回到 `ssh`），`hostSetup revert`（删除 `cloudalbum-ops` 与 sudoers 片段），重启服务。
5. 分离 `PolicyArn`；删除栈。会话日志组因 `DeletionPolicy: Retain` 保留，`--purge` 时才删除。

**迁移**：没有应用数据需要迁移。

**防锁死**：L0 实例必须带密钥对启动，否则禁用本模块后无法回到 SSH。万一 SSM 不可用、22 端口又已关闭：在控制台临时给安全组加一条 22 规则（只对自己的 IP）后用 SSH 登录；EC2 Instance Connect（浏览器方式）同样需要 22 端口对其服务地址段开放，不能救急；如果实例在私有子网，可以用 EC2 Instance Connect Endpoint（安全组只需放行来自端点安全组的 22）。最后手段是 `scripts/module rebuild-instance`（总纲 9.2“替换实例的流程”）：数据卷 `DeleteOnTermination: false`，机密与本地配置都在数据卷上，新实例沿用而不重新生成密钥。`KeyName` 不由本模块修改，就是为了保证这条退路。

### 7. SAA 考点

- Session Manager、堡垒机、EC2 Instance Connect、EC2 Instance Connect Endpoint 的对比：哪个需要开 22 端口、哪个需要公网 IP、各自怎么审计。
- SSM 托管节点的三个前提：SSM Agent、IAM 实例配置文件（或 DHMC）、到 SSM 端点的网络通路。
- 私有子网访问 AWS 服务：NAT Gateway 与 Interface Endpoint（PrivateLink）的区别；Session Manager 需要的端点。
- 最小暴露面：安全组没有任何入站规则也能管理实例；安全组是有状态的，Agent 主动发起的出站连接的回包自动放行。
- 会话日志（S3 / CloudWatch Logs）+ CloudTrail 记录 `StartSession`，构成完整的审计链。
- 用 IAM 条件键（`ssm:resourceTag/*`）控制谁能登录哪些实例；按文档控制能否做端口转发。
- 用 Session Manager 端口转发访问私有 RDS，取代堡垒机。
- Systems Manager 家族的分工：Session Manager、Run Command、Patch Manager、Parameter Store、Fleet Manager、State Manager。
- AWS 托管策略（`AmazonSSMManagedInstanceCore`）与客户托管策略的取舍。

### 8. 费用与清理

- Session Manager 对 EC2 实例不额外收费（以官方定价为准）。
- 可能产生费用的部分：会话日志写入 CloudWatch Logs 的摄取和存储（量很小），或写入 S3 的存储费；私有子网中的 Interface Endpoint（由 network 栈的 `InterfaceEndpoints` 参数创建，计入 network 的 `billing`）按“端点 × 可用区 × 小时”计费，另收数据处理费，三四个端点乘以 AZ 数，在学习环境中往往是“用 Session Manager 管私有实例”最大的成本；KMS 会话加密有少量 API 调用费。
- 对比基线：SSH 没有额外 AWS 费用，但要承担私钥管理和端口暴露的成本。
- 清理：`scripts/module disable shell-access --reopen-ssh` → 删除为实验创建的 Interface Endpoint 和临时实例 → 需要时 `--purge` 删除会话日志组。

### 9. 常见坑

- 关闭 22 端口之前必须确认 SSM 通道可用，否则会把自己锁在外面。脚本强制校验 `PingStatus=Online` 并做 `send-command` 冒烟。
- 给实例新挂角色或补充权限后，Agent 可能要等一段时间才注册成功，重启 `amazon-ssm-agent` 可以加快。反过来，撤掉权限后 Agent 也不会立刻掉线（官方说法是最长可能约一小时），实验时不要误判。
- `SSM-SessionManagerRunShell` 是区域级单例，修改会影响该区域所有会话；用 CloudFormation 直接创建会与已存在的文档冲突。由脚本更新，并保留旧版本以便回滚。
- 默认的 `ssm-user` 和 AL2023 的 `ec2-user` 都有免密 sudo，把 runAs 改成 ec2-user 不等于降权；要用专用用户 + 受限 sudoers。
- `cloudWatchEncryptionEnabled=true` 但日志组没有加密时，会话日志会写不进去（会话本身可能照常打开，日志却是空的）。
- 私有子网漏建 `ssmmessages` 端点时，实例显示 Online，但开不了会话。
- 会话日志不记录端口转发和 SSH-over-SSM 会话的数据内容；vim、top 这类全屏程序的日志会很乱。
- `logs:DescribeLogGroups` 不能限定到单个日志组，写成具体 ARN 会导致会话日志静默失败。
- 运维者策略漏掉 `SSM-SessionManagerRunShell` 文档或端口转发文档时，症状是 `AccessDeniedException`，与实例无关；先用 `aws iam simulate-principal-policy` 排查。
- 关闭 22 端口后，浏览器版 EC2 Instance Connect 也连不上。
- 运维笔记本需要安装 session-manager-plugin；公司代理可能拦截 WebSocket。
- sshd 加固片段放在 `50-redhat.conf` 之后不会生效（先读到的值生效）。
- Interface Endpoint 按小时计费，练完要删除。

### 10. 探针

shell-access 是纯基础设施型，探针就是感知器（`detectors/shell-access.ts`，第 3 节有代码要点），结论写入 capabilities 的 `shell-access` 条目。`SHELL_ACCESS_MODE=ssh` 时只评估本地实现，结果记为 `localHealth`，`status=off`。

| 探针 | 方式 | `degraded` 判据 | `error` 判据 | 所需权限（在 `PolicyArn` 中） | 无凭证时 |
|---|---|---|---|---|---|
| 本地（`ssh`，60 秒） | 读 `security/snapshot.json` 的 `sshd` 段与监听端口 | 快照超过 5 分钟（置信度降为 `inferred`）；`sshd.effective` 与加固片段不一致（例如 `passwordauthentication yes`） | sshd 未监听（L0 唯一的运维通道断了） | 不需要 | 照常（L0 本来就没有凭证） |
| 常规（`ssm`，60 秒） | `ssm:DescribeInstanceInformation`（过滤本实例 ID）：`PingStatus`、`AgentVersion`、`LastPingDateTime`；`ec2:DescribeSecurityGroups`：实例安全组是否还有 22 端口入站规则 | Agent Online 但 22 仍开放（`SHELL_ACCESS_KEEP_SSH=true` 的过渡期，或 SEC-003）；会话首选项的日志组不是本模块的（`ssm:GetDocument`，被别人改掉） | Agent 未注册或 `ConnectionLost`；AccessDenied | `ssm:DescribeInstanceInformation`、`ec2:DescribeSecurityGroups`、`ssm:GetDocument`（第 2 节 AppPolicy ①④） | 不适用：DEP-001 保证启用时一定是 `role` |
| 深度（管理员或 enable 第 10 步） | `ssm:DescribeSessions --state History` 最近 20 次会话（`Owner` 为运维者 IAM ARN，结果缓存 60 秒）；会话日志组最近一次写入时间 | 最近有会话但日志组没有对应日志流（`cloudWatchEncryptionEnabled` 与日志组加密不一致的典型症状） | — | `ssm:DescribeSessions`、`logs:DescribeLogStreams` | 同上 |

### 11. 前端徽章

全局徽章，数据来自 capabilities；shell-access 不在请求路径上，不出现在 `X-CloudAlbum-Path` 中。

| 位置 | 本地实现时（`ssh`） | AWS 实现时（`ssm`） | 降级时 |
|---|---|---|---|
| `/lab` shell-access 卡片 | 红色“入站 22/tcp ← 203.0.113.10/32”；“近 24 小时 sshd 失败 N 次”；“登录审计：仅 journal 中的 Accepted publickey，无命令记录”；最近登录列表（指纹 + IP） | 绿色“无管理端口入站 · SSM Agent Online（版本 x.y.z）”；最近会话列表（操作者 IAM ARN、开始与结束时间、会话日志链接） | 黄色“过渡期：22 仍开放（SEC-003）”，两种记录并排列出 |
| 管理后台 · 安全与合规 | 运维登录：SSH 密钥对 | 运维登录：Session Manager（IAM 身份） | 文案后附“降级” |
| `scripts/module status` | 投递通道：ssh | 投递通道：ssm | — |

```yaml
# registry.yaml：shell-access.lab（summary 与 badges）
summary:
  local: "SSH 22 + 密钥对；登录审计只有 journal 中的公钥指纹与来源 IP"
  aws: "Session Manager：IAM 身份登录与端口转发，安全组无管理端口入站，会话日志进 CloudWatch Logs"
keyMetrics: ["从公网探测 22 端口（open / filtered）", "24 小时 sshd 认证失败次数", "能否回答“谁在什么时间执行了什么命令”"]
badges:
  local: "运维登录：SSH 22 · 密钥对"
  aws: "运维登录：Session Manager · 无管理端口入站"
  degraded: "运维登录：Session Manager · 22 仍开放"
```

### 12. 平台模式（ATL）

> 第 4 轮新增（总纲 1.4 D16）。规格以 [docs/platform/06](../platform/06-cloudalbum-platform-mode.md) 为准（PM-27、PM-M28）。

- **“启用前”的含义改变**：平台模式下实验机从 L0 起就挂着只含 `AmazonSSMManagedInstanceCore` 的 `CloudAlbumAppRole`，SSM Agent 已在线（平台管理通道）。本模块只负责关闭 22 端口（基础栈 `SshIngressCidr` 置空）与修改会话首选项；对比的是“运维者走 SSH 22 端口”与“运维者走 Session Manager”。SSH 从平台工作台发起（`ssh lab`），`SshIngressCidr` 由平台设为工作台私网 IP/32（实验机在默认 VPC）或公网 IPv4/32（实验机已在自定义 VPC）。
- **平台终端与本模块互不影响**：平台终端使用独立的 Session 文档 `ATL-SessionShell`（录制时为 `ATL-SessionShell-Logged`），本模块不得修改它们；本模块修改的是账号 × 区域级的单例 `SSM-SessionManagerRunShell`，平台终端也不读写它。
- **统计会话时排除平台会话**：感知器与平台检查用 `DescribeSessions` 统计会话时，排除文档为 `ATL-SessionShell*`、或会话 ID 以 `atl-<sid>-term-` 开头的平台终端会话，只统计学员自己发起的会话（例如以 `atl-<sid>-ws-` 开头的工作台会话）；否则“已使用 Session Manager”会因平台终端而直接成立。
- **单例备份**：修改 `SSM-SessionManagerRunShell` 前，把原来的默认版本与内容（或“原本不存在”）写入状态桶 `<envName>/backups/ssm-document-SSM-SessionManagerRunShell-<时间>.json` 并登记到 `state.json`，平台回收器复位时据此还原；不再只写在运维机或工作台本地。
- **端口探测**：`probe-port` 增加 `--target private-ip`（从工作台探测实验机私网地址）。平台模式下 22 端口只对工作台开放，从外部探测在 before 时就是 `filtered`，这是预期结果。
- **SSM 投递**：平台模式下 `scripts/module` 的投递通道从 L0 起就是 SSM（不随 `SHELL_ACCESS_MODE` 切换），所以“投递方式本身体现本模块的差异”这一观察点在平台模式下不成立，手册中说明。

<a id="logging"></a>

## logging：日志 ↔ Amazon CloudWatch Logs

> 一句话总结：没有 CloudWatch Logs 时，API、worker、审计和 Nginx 的日志只写在 EBS 数据卷的文件里，/lab 日志查看器在本机线性扫描，实例被终止或数据卷损坏后日志就没了；启用后，应用把同一份结构化日志批量发送到 CloudWatch Logs（本地文件照写），可以跨实例检索、用 Logs Insights 聚合、用指标过滤器把日志变成指标，实例没了日志还在。最直观的区别：日志查看器顶部徽章从“本地文件 · 仅 i-0abc”变成“CloudWatch Logs · 3 个实例”，多出“Logs Insights”页签；搜索刚发出的请求 ID 时，本地立即可见，CloudWatch 侧要“等待摄取…”几秒。

### 0. 元数据（registry 摘录）

```yaml
# modules/registry.yaml 中 logging 的条目（摘录；不一致时以 registry 为准，并同步本节）
logging:
  group: E
  function: 日志
  awsService: Amazon CloudWatch Logs
  auxServices: []
  type: adapter
  port: LoggerPort                       # adapters/logging/{file,cloudwatch}.ts；只读侧 LogReader 在同一文件；非权威端口
  switch: { var: LOG_DRIVER, values: [file, cloudwatch], ownedValues: [cloudwatch], localTiers: [] }
  ownsEnv: [LOG_CW_]
  credentials: required
  prerequisites: []
  requires: []
  soft: [kms, monitoring]                # kms：日志组加密；monitoring：指标过滤器生成的指标可接告警
  conflicts: []
  authoritative: false
  multiInstanceSafe: { file: false, cloudwatch: true }    # file 只产生 ASG-009 警告
  bypass: []                             # 不做请求级 A/B；同一查询可在 store=local|cloudwatch 两侧并排执行
  stacks: [{ name: main, template: infra/modules/logging.yaml }]
  cwAgentFragment: infra/modules/logging/cwagent.json     # 仅 LOG_CW_SHIPPER=agent 时投递；keys 模式下拒绝（约定 2）
  hostSetup: infra/modules/logging/host-setup.sh          # 只在 agent 方式下安装 Agent 并 append-config
  injects:                               # D2：本模块作为提供方
    - { target: monitoring, params: { LogErrorsNamespace: "${Out.InfoMetricNamespace}" } }   # CloudAlbum/Logs
  # 本栈接收的注入：KmsKeyArn（kms，target "*"）
  probe: { kind: active, method: "发送器状态 + logs:DescribeLogStreams", intervalSec: 30 }
  billing:
    - { resource: "CloudWatch Logs 摄取、存储与 Logs Insights 扫描", dimension: usage }
  lab: { compare: before-after, hourlyBilled: false, experiments: [ingest-lag, query-compare, instance-loss, overhead, debug-volume] }   # 文案见第 11 节
  doc: docs/modules/05-ops-observability.md#logging
```

- 类型 A：驱动 id 等于开关取值（`file` / `cloudwatch`），非权威端口——远端故障只把状态置为 `degraded` 并计数，绝不阻塞请求（总纲 1.2 原则 4）。`cloudwatch` 档本地文件照写，所以回滚没有数据缺口。
- 不出现在 `X-CloudAlbum-Path` 中（LoggerPort 在 container 中以 `instrument: false` 装配，总纲 4.5）。
- 多实例：`LOG_DRIVER=file` 触发 ASG-009（warn）。

### 1. 基线实现（仅 EC2）

**写入**
- 日志库用 pino，每行一个 JSON 对象。字段约定（LoggerPort 自动附加，总纲 §4.2）：`ts`（ISO 8601，`timestamp: pino.stdTimeFunctions.isoTime` 并把键名改为 `ts`）、`level`（字符串 `debug|info|warn|error`，通过 `formatters.level` 输出标签而不是 pino 默认的数字）、`msg`、`role`（api / worker）、`instanceId`、`requestId`、`traceId`、`path`（`X-CloudAlbum-Path`）；HTTP 请求日志另有 `route`（路由模板）、`method`、`status`、`durMs`；业务事件有 `event`（如 `auth.login_failed`）和 `ip`（客户端 IP：只在 Nginx 用 realip 解析一次，经 `X-Forwarded-For $remote_addr` 传给 Node，Express `trust proxy=loopback`，总纲 2.5 约定 1）。Logger 保证 `event` 字段写在 `ip` 字段之前（fail2ban 过滤器依赖字段顺序，见 threat-detection）。
- 请求 ID 贯通：Nginx 生成 `$request_id`，经 `proxy_set_header X-Request-Id` 传给 Node（总纲 §2.5 已配置）；应用沿用它作为 `requestId`（没有这个头时自己生成 ULID），并在响应头 `X-CloudAlbum-Request-Id` 中返回。于是 Nginx 访问日志的 `rid` 字段与应用日志的 `requestId` 是同一个值，一个请求能在两边对上。
- 脱敏：`backend/src/observability/redact.ts` 统一定义 pino `redact` 路径（`req.headers.authorization`、`req.headers.cookie`、`*.password`、`*.token`、预签名 URL 的 `X-Amz-Signature` 查询参数等）。
- 文件（总纲 §2.4）：`/var/lib/cloudalbum/logs/api.log`、`worker.log`、`audit.log`（`audit_log` 表的镜像，见 audit 模块）、`nginx-access.json`（Nginx，总纲 §2.5 的 `cloudalbum_json` 格式）。Nginx 错误日志沿用 AL2023 默认的 `/var/log/nginx/error.log`。本模块**不重新定义** Nginx 的 `log_format`（重名会让 `nginx -t` 失败，也违反“模块不得改写主配置”的约定）。
- 写入方式：`pino.destination({ dest, sync: false, mkdir: true })` 异步写入；进程收到 `SIGUSR2` 时调用 `destination.reopen()`。stdout 只输出 warn 及以上，由 journald 收集，用于进程崩溃时排查（`journalctl -u cloudalbum-api`）。
- 轮转：`/etc/logrotate.d/cloudalbum` 与 journald 上限 `/etc/systemd/journald.conf.d/cloudalbum.conf`（`SystemMaxUse=200M`）都由 ec2 在 `install` 阶段安装（00 的 3.4、6.5），内容由本组定义。属主与权限遵循 D6（`cloudalbum` 固定 uid/gid 2001、文件 0640）：

  ```text
  /var/lib/cloudalbum/logs/api.log /var/lib/cloudalbum/logs/worker.log /var/lib/cloudalbum/logs/audit.log {
      daily
      rotate 14
      compress
      delaycompress
      missingok
      notifempty
      create 0640 cloudalbum cloudalbum
      sharedscripts
      postrotate
          systemctl kill -s USR2 cloudalbum-api cloudalbum-worker 'cloudalbum-api@*' >/dev/null 2>&1 || true
      endscript
  }
  /var/lib/cloudalbum/logs/nginx-access.json {
      daily
      rotate 14
      compress
      delaycompress
      missingok
      notifempty
      create 0640 nginx cloudalbum        # worker（cloudalbum 组）要读它统计源站卸载、转发到 CloudWatch；fail2ban 以 root 读取
      postrotate
          [ -f /run/nginx.pid ] && kill -USR1 "$(cat /run/nginx.pid)"   # Nginx 收到 USR1 重新打开日志文件
      endscript
  }
  ```

**查询**
- `backend/src/adapters/logging/file.ts` 同时实现 LoggerPort（写）和 LogReader（读）。读取时从文件尾部倒序扫描当前文件和已轮转的 `.1` 文件（不解压 `.gz`），逐行 `JSON.parse` 后过滤，达到 `limit` 或扫描字节上限（默认 50 MiB）就停止，并返回 `truncated: true`。
- 接口（仅管理员）：`GET /api/lab/logs?source=api|worker|audit|nginx&level=&q=&requestId=&traceId=&from=&to=&limit=&store=local|cloudwatch`；实时追踪用 SSE：`GET /api/lab/logs/stream`（`fs.watch` + 增量读取；通过 inode 变化识别轮转）。
- 错误计数：Logger 每写一条 warn / error，就给 LabMetricsStore 的计数器 `log.events{level}` 加一。monitoring 的本地告警规则读这个计数器，因此 logging 与 monitoring 之间没有代码耦合。

**/lab 日志查看器**（`frontend/src/lab/LogViewer.tsx`）：来源、级别、关键字、时间范围筛选；点击 `requestId` 一键过滤同一请求在 Nginx、api、worker 中的全部日志；点击 `traceId` 跳转到 /lab/tracing 的瀑布图；顶部徽章显示“本地文件 · 仅 i-0abc · 扫描 N MB · 用时 M ms”。

**局限**：只能看到本机日志；实例终止或数据卷损坏后日志随之丢失；检索靠线性扫描，耗时随文件大小线性增长；只覆盖最近两天（当前文件 + `.1`）；Lambda 的日志不在本地。

### 2. AWS 实现

**写入侧：`backend/src/adapters/logging/cloudwatch.ts`（`CwLogger`）**
- 本地文件**照写**（总纲 §4.2：cloudwatch 档以本地文件兜底），同时由进程内发送器批量调用 `PutLogEvents`：
  - 缓冲区按时间排序；每 `LOG_CW_FLUSH_MS`（默认 2 秒）或缓冲达到约 1 MiB / 5000 条时发送一批，低于 PutLogEvents 的单批上限（大小、条数、时间跨度上限以官方文档为准）。
  - 日志流名 `{instanceId}/{role}`（例如 `i-0abc…/api`），启动时 `CreateLogStream`（已存在则忽略）；日志组由 CloudFormation 创建，应用不建组。现在的 PutLogEvents 不再需要 sequence token。
  - 失败按指数退避重试；积压超过 `LOG_CW_MAX_BACKLOG`（默认 10000 条）时丢弃最旧的事件并计入 `dropped`。日志是非权威端口，远端故障绝不阻塞请求（总纲 §1.2 原则 4），只把状态置为 `degraded`。
  - 收到 SIGTERM 时 `flush()`（systemd 的 `TimeoutStopSec=20` 足够发送最后一批）。
- **Nginx 访问日志**：worker 已经在增量读取 `nginx-access.json`，用来统计源站卸载（总纲 §7.3 的 `lab_origin_samples`）；cloudwatch 档下，同一个读取器把这些行转发到 `/cloudalbum/<env>/nginx` 日志组的 `{instanceId}/access` 流。Nginx 错误日志在 sdk 方式下不上传。
- **可选的 agent 投递方式**（`LOG_CW_SHIPPER=agent`，需要 `IAM_CREDENTIALS=role`，约定 2）：用来学习 CloudWatch Agent（考点）。应用只写本地文件、不启动进程内发送器；本模块的 `hostSetup` 安装 Agent 并 `append-config`；Agent 片段 `infra/modules/logging/cwagent.json` 采集 `api.log`、`worker.log`、`audit.log`、`nginx-access.json` 和 `/var/log/nginx/error.log`。这时 LoggerPort 的 `stats()` 取不到积压数据，探针改用 `DescribeLogStreams` 的最近摄取时间判断。

```json
{"logs":{"logs_collected":{"files":{"collect_list":[
  {"file_path":"/var/lib/cloudalbum/logs/api.log","log_group_name":"/cloudalbum/lab/app","log_stream_name":"{instance_id}/api"},
  {"file_path":"/var/lib/cloudalbum/logs/worker.log","log_group_name":"/cloudalbum/lab/app","log_stream_name":"{instance_id}/worker"},
  {"file_path":"/var/lib/cloudalbum/logs/audit.log","log_group_name":"/cloudalbum/lab/app","log_stream_name":"{instance_id}/audit"},
  {"file_path":"/var/lib/cloudalbum/logs/nginx-access.json","log_group_name":"/cloudalbum/lab/nginx","log_stream_name":"{instance_id}/access"},
  {"file_path":"/var/log/nginx/error.log","log_group_name":"/cloudalbum/lab/nginx","log_stream_name":"{instance_id}/error"}]}}}}
```

（字段以 CloudWatch Agent 官方文档为准；`<env>` 由 scripts/module 渲染时替换，这里以 `lab` 为例。）

**CloudFormation：`infra/modules/logging.yaml`**

| 资源 | 说明 |
|---|---|
| `AppLogGroup` `/cloudalbum/<env>/app` | 日志流 `{instanceId}/api`、`/worker`、`/audit`；`RetentionInDays` 参数默认 14；日志类别 `STANDARD`（创建后不能改）；参数 `KmsKeyArn`（kms 注入，默认 `''`）非空时加密；`DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` |
| `NginxLogGroup` `/cloudalbum/<env>/nginx` | 日志流 `{instanceId}/access`、`/error`；同上 |
| 指标过滤器 | `AppErrors`：`{ $.level = "error" }` → 命名空间 `CloudAlbum/Logs`，指标值 1、默认值 0；`Nginx5xx`：`{ $.status >= 500 }`；`AuthLoginFailed`：`{ $.event = "auth.login_failed" }` |
| `AWS::Logs::QueryDefinition` × 4 | 按路由统计错误、按路由统计 p95 耗时、按 requestId 追踪单个请求、按 `path` 统计缓存命中（见第 3 节） |
| `AppPolicy` | 写：`logs:CreateLogStream`、`logs:PutLogEvents`、`logs:DescribeLogStreams`（限定两个日志组）；读：`logs:FilterLogEvents`、`logs:StartQuery`、`logs:StopQuery`（限定两个日志组，以及 `/aws/lambda/cloudalbum-<env>-*`），`logs:GetQueryResults`（不支持资源级限制，Resource 为 `*`）；agent 方式额外需要 Agent 的写权限（等价于 `CloudWatchAgentServerPolicy` 中 logs 部分，写进本策略，不附加 AWS 托管策略）。模板不写 `Roles` / `Users`（D2） |
| 参数 | `Env`、`ModuleVersion`、`RetentionInDays`（默认 14）、`Shipper`（`sdk` \| `agent`）、`KmsKeyArn`（由 kms 注入） |
| Outputs | `ModuleId`、`ModuleVersion`、`PolicyArn`、`EnvLogDriver`（= `cloudwatch`）、`EnvLogCwShipper`、`EnvLogCwGroupApp`、`EnvLogCwGroupNginx`、`EnvLogCwRetentionDays`、`InfoMetricNamespace`（= `CloudAlbum/Logs`，注入 monitoring 用）、`InfoInsightsUrl`。不使用 `Export` |

**读取侧：同一个 `cloudwatch.ts` 实现 LogReader**
- 按 `requestId` / `traceId` 精确查找：`FilterLogEvents`，过滤模式 `{ $.requestId = "<id>" }`，跨所有日志流。
- 聚合查询：Logs Insights，`StartQuery` 后轮询 `GetQueryResults`，从 `statistics.bytesScanned` 取扫描字节数。
- 精确查找是同步的（`mode: 'sync'`）；Insights 是异步的（`mode: 'async'`，返回 `queryId`，前端轮询 `results()`），与总纲 4.2 的 LogReader 返回形状一致。每个结果带 `meta`：`engine`（`filter-log-events` / `logs-insights`）、`tookMs`、`scannedBytes`、`instances`（结果中出现的实例 ID），供 /lab 对比。
- cloudwatch 档下 container 额外构造一个本地文件读取器，所以 /lab 能对同一个查询分别在“本地 / CloudWatch”执行（`store=local|cloudwatch`）。
- Lambda 日志：Lambda 总是自动写入 `/aws/lambda/<函数名>`（不受 `LOG_DRIVER` 控制）。cloudwatch 档的查看器可以把 `cloudalbum-<env>-*` 函数的日志组一并纳入查询。

**可选**：订阅过滤器把日志实时送到 Data Firehose → S3 做长期归档（与 analytics 模块的点击流分开）；或用 `CreateExportTask` 批量导出到 S3（非实时，同一时间只能有一个导出任务在运行，以官方文档为准）。

```mermaid
flowchart LR
  N[api / worker · pino] --> F[(本地文件 logs/*.log)]
  NG[Nginx] --> FA[(nginx-access.json)]
  F --> V1[/lab 查看器 · store=local · 本机线性扫描/]
  N -. LOG_DRIVER=cloudwatch · sdk .-> S[进程内发送器 PutLogEvents]
  FA -. worker 读取器转发 .-> S
  F -. 可选 agent 方式 .-> AG[CloudWatch Agent]
  S --> CWL[(CloudWatch Logs /cloudalbum/env/app · nginx)]
  AG --> CWL
  CWL --> MF[指标过滤器] --> M[(CloudAlbum/Logs 指标)] --> AL[monitoring 告警]
  CWL --> LI[Logs Insights / FilterLogEvents] --> V2[/lab 查看器 · store=cloudwatch/]
```

### 3. 开关与配置

```bash
# /etc/cloudalbum/modules.d/logging.env（root:cloudalbum 0640，数据卷上；启用时由 scripts/module 写入；不存在 = LOG_DRIVER=file）
MODULE_LOGGING=on
MODULE_LOGGING_VERSION=1
LOG_DRIVER=cloudwatch                    # file | cloudwatch（第一个是本地实现）；Outputs.EnvLogDriver
LOG_CW_SHIPPER=sdk                       # sdk（默认：应用内批量 PutLogEvents）| agent（CloudWatch Agent 采集文件，需 role）；Outputs.EnvLogCwShipper
LOG_CW_GROUP_APP=/cloudalbum/lab/app     # Outputs.EnvLogCwGroupApp
LOG_CW_GROUP_NGINX=/cloudalbum/lab/nginx # Outputs.EnvLogCwGroupNginx
LOG_CW_RETENTION_DAYS=14                 # 仅展示用；真正生效的是日志组的保留期
LOG_CW_FLUSH_MS=2000
LOG_CW_MAX_BACKLOG=10000
```

- 本地文件在两种驱动下都写：它是 cloudwatch 档的兜底，也是 fail2ban 的输入。
- 日志级别不是启动配置，而是运行时热键 `RuntimeConfig.logLevel`（总纲 4.2，D7）：file 档改 `runtime.json`，config=ssm 时改 `/cloudalbum/<env>/runtime/logLevel`，可以临时调成 debug，观察摄取量与费用的变化。
- env 中没有机密类键（CFG-002）；`LOG_CW_` 前缀在全项目唯一归属本模块（总纲 3.5 的 `ownsEnv` 检查）。

端口接口要点（写入侧就是总纲 4.2 的 LoggerPort；只读侧在总纲 LogReader 的基础上细化——保留总纲字段 `from`/`to`/`filter`/`limit` 与返回的 `mode`/`rows`/`queryId`，只追加可选字段与方法）：

```ts
// backend/src/ports/logger.ts（只读侧细化）
export type LogSource = 'api' | 'worker' | 'audit' | 'nginx' | 'lambda';
export interface LogRecord {
  ts: string; level: LogLevel; source: LogSource; instanceId?: string; msg: string;
  requestId?: string; traceId?: string; fields: Record<string, unknown>;
}
export interface LogQuery {
  from: string; to: string; filter?: string; limit: number;          // 总纲字段；filter：local 为关键字，cloudwatch 可为 Logs Insights 语句
  sources?: LogSource[]; minLevel?: LogLevel; requestId?: string; traceId?: string;   // 本组追加
}
export interface LogQueryMeta {
  engine: 'local-scan' | 'filter-log-events' | 'logs-insights';
  tookMs: number; scannedBytes?: number; instances: string[]; truncated: boolean;
}
export interface LogReader {
  readonly store: 'local' | 'cloudwatch';
  /** local：同步扫描（mode='sync'）；cloudwatch：requestId/traceId 精确查找走 FilterLogEvents（sync），Insights 语句走 StartQuery（async） */
  query(q: LogQuery): Promise<{ mode: 'sync' | 'async'; rows?: LogRecord[]; queryId?: string; meta?: LogQueryMeta }>;
  /** 仅 cloudwatch：轮询异步查询（GetQueryResults） */
  results?(queryId: string): Promise<{ done: boolean; rows: LogRecord[]; meta: LogQueryMeta }>;
  tail(q: Pick<LogQuery, 'sources' | 'minLevel'>, signal: AbortSignal): AsyncIterable<LogRecord>;
}
// container：c.logReaders = { local: FileLogReader, cloudwatch?: CwLogReader }；LoggerPort 本身不变
```

保存的 Logs Insights 查询（`QueryDefinition`）：

```text
# 按路由统计错误
fields @timestamp, route, status, requestId
| filter level = "error"
| stats count(*) as errors by route
| sort errors desc

# 按路由统计 p95 耗时（5 分钟一桶）
filter ispresent(durMs)
| stats pct(durMs, 95) as p95, count(*) as n by route, bin(5m)

# 单个请求的全部日志
fields @timestamp, @logStream, level, msg, path
| filter requestId = "REPLACE_ME"
| sort @timestamp asc

# 缓存命中情况（来自 X-CloudAlbum-Path）
filter ispresent(path)
| parse path /cache=(?<cache>[^;]+)/
| stats count(*) by cache
```

### 4. 依赖与组合

**硬依赖**
- 凭证（`credentials: required`，CRED-001）：推荐 `IAM_CREDENTIALS=role`；keys 模式下 sdk 方式照常（应用的 SDK 客户端工厂使用 `IAM_KEYS_*`，同时 CRED-002 warn），agent 方式不可用（不给 Agent 另写凭证文件，约定 2）。
- 实例能出站访问 `logs.ap-northeast-1.amazonaws.com`。L0 满足；私有子网需要 NAT 或 `logs` Interface Endpoint。
- 实例时钟准确（AL2023 默认 chronyd + Amazon Time Sync）。PutLogEvents 会拒绝时间戳太旧或在未来的事件。
- 日志组用 KMS 加密时需要 kms 模块（经 `injects` 注入 `KmsKeyArn`），密钥策略要允许 `logs.ap-northeast-1.amazonaws.com` 服务主体（02#kms 的密钥策略负责）。
- agent 方式需要 CloudWatch Agent（本模块 `hostSetup` 自动 `dnf install`）与 `IAM_CREDENTIALS=role`。

**与其他模块组合**
- **monitoring**：指标过滤器生成的 `CloudAlbum/Logs` 指标可以被 monitoring 用来告警和画仪表板：本模块经 `injects` 把 `LogErrorsNamespace` 注入 monitoring 栈（D2），monitoring 据此按 Condition 创建 `log-errors` 告警；本模块禁用时 `scripts/module` 先用空值更新 monitoring 栈。两者没有硬依赖；agent 方式下共用同一个 Agent 进程。
- **tracing**：pino 的 mixin 把 `traceId`、`spanId` 写进每行日志；cloudwatch 档下可以在 Logs Insights 中按 traceId 查日志，/lab 中可以从 trace 跳到日志。
- **autoscaling**：多实例时，本地查看器只能看到处理当前请求的那台实例（页面上标“仅 i-xxxx”），并触发 ASG-009 警告；CloudWatch 按 `{instanceId}` 分流，汇总所有实例，实例终止后日志仍在。这是本模块最核心的对比点。
- **threat-detection**：fail2ban 读本地 `api.log`、`nginx-access.json` 和 Nginx 错误日志，所以本地文件必须一直保留（本设计中总是保留）。
- **shell-access**：会话日志在它自建的日志组中，启用 logging 后可以一起查询。
- **image-processing（lambda）、social-api（lambda 集成）**：Lambda 日志不受 `LOG_DRIVER` 控制；file 档的查看器要明确提示“Lambda 日志不在本地”。
- **audit**：CloudTrail 可以投递到 `/cloudalbum/<env>/cloudtrail`，在同一个 Logs Insights 中查询。
- **waf**：WAF 日志如果写 CloudWatch Logs，日志组名必须以 `aws-waf-logs-` 开头（由 waf 模块负责）。
- **config（ssm）**：`logLevel` 远程热更新。
- **kms**：日志组加密及其密钥策略。
- **network**：私有子网需要 `logs` 端点或 NAT。
- **backup**：本地日志在数据卷上，会随 EBS 快照一起备份；CloudWatch 中的日志由保留期控制，不归 AWS Backup 管。
- **analytics**：两条独立的数据管道，互不依赖。

### 5. 对比实验：有 vs 没有

| 维度 | 没有 CloudWatch Logs（基线：本地文件） | 有 CloudWatch Logs |
|---|---|---|
| 存放位置 | EBS 数据卷 | CloudWatch Logs（本地文件仍保留） |
| 实例终止 / 数据卷损坏后 | 日志丢失 | 仍可查 |
| 多实例 | 每台各看各的 | 按实例分流、集中查询 |
| 检索 | 线性扫描，只覆盖最近两天 | FilterLogEvents、Logs Insights，按保留期 |
| 聚合分析 | 自己写代码 | Logs Insights 查询语言（stats、pct、bin） |
| 日志变指标、告警 | LabMetricsStore 本地计数 | 指标过滤器 → CloudWatch 指标 → 告警 |
| 可见延迟 | 立即 | 摄取延迟，秒级到数十秒 |
| 保留 | logrotate 14 天 | 日志组保留期（默认永不过期，本模块设为 14 天） |
| Lambda 日志 | 看不到 | 能一起查 |
| 费用 | 无 AWS 费用（占用数据卷空间） | 按摄取量、存储量、Insights 扫描量计费 |

**页面上能直接看到的差异**
- /lab 日志查看器顶部的数据源徽章：“本地文件 · 仅 i-0abc”或“CloudWatch Logs · 3 个实例”；结果每行带 `instanceId`。
- cloudwatch 档多出“Logs Insights”页签（可直接运行保存的查询）和“错误数（指标过滤器）”小图。
- 搜索刚发出的请求 ID：本地立即可见；CloudWatch 侧先显示“等待摄取… n 秒”，直到日志出现。
- 每次查询显示 `engine`、用时、扫描字节数、覆盖的实例数。
- 实例终止后，本地模式再也查不到该实例的日志，CloudWatch 模式仍然可以。

**测量指标**
摄取延迟（从请求完成到能在 CloudWatch 查到的秒数，中位数和最大值）；同一个聚合查询的耗时与扫描字节数；跨实例覆盖情况（能看到几个实例）；实例终止后日志是否可得；发送器开销（api 进程 CPU 和事件循环延迟的变化，agent 方式则看 Agent 的 CPU 和内存）；每日摄取量（GB，用来估算费用）。

**操作步骤**（`experiments/logging/`）
1. 摄取延迟：`npm run exp -- logging --label after --scenario ingest-lag`。`ingest-lag.ts` 发送 20 个带实验头 `X-Experiment-Run` 的请求，从响应头 `X-CloudAlbum-Request-Id` 取得每个请求的 ID（Nginx 的 `$request_id` 总是自己生成，客户端传入的 `X-Request-Id` 不会被沿用），然后轮询 `GET /api/lab/logs?store=cloudwatch&requestId=...`，记录每条日志首次出现的时间，输出中位数和最大值。
2. 查询对比：先用故障注入制造错误：`POST /api/lab/faults {"type":"error5xx","rate":0.2,"durationSec":120}`，同时用 `experiments/logging/load.k6.js` 施加恒定负载；然后 `npm run exp -- logging --label after --scenario query-compare`。`query-compare.ts` 对 `store=local` 和 `store=cloudwatch` 分别执行“近 1 小时按路由统计错误”和“按 requestId 查找”，打印 `tookMs`、`scannedBytes`、结果条数、实例数。切换前（`--label before`）只能跑 local 一侧。
3. 实例丢失：启用 autoscaling 时执行 `aws autoscaling terminate-instance-in-auto-scaling-group --instance-id <id> --no-should-decrement-desired-capacity`；单实例时执行 `scripts/module rebuild-instance`（总纲 9.2“替换实例的流程”：数据卷改挂到新实例），模拟“旧实例没了”。然后用旧实例上产生的 requestId 分别在两侧查询（`npm run exp -- logging --label after --scenario instance-loss -- --request-id <id>`）。
4. 控制台：CloudWatch → Logs Insights 运行保存的查询；命令行 `aws logs tail /cloudalbum/lab/app --follow --format short`。
5. 开销：sdk 方式比较开启前后 `/api/lab/metrics` 中 api 进程的 CPU 与事件循环延迟 p99；agent 方式用 `top -p $(pgrep -f amazon-cloudwatch-agent)`。
6. 费用感知（可选）：用 config 模块把 `logLevel` 改成 debug 10 分钟，对比 CloudWatch 控制台中该日志组的 `IncomingBytes` 指标。

**预期结果**
- 单实例、数据量小时，本地查询最快（毫秒到百毫秒级），而且没有延迟；本地扫描的耗时随文件大小线性增长，只覆盖本机最近两天。
- CloudWatch 有秒级到数十秒级的摄取延迟（sdk 方式取决于 `LOG_CW_FLUSH_MS`，agent 方式默认约 5 秒刷新一次）；Insights 查询一般需要几秒，并返回扫描字节数。
- CloudWatch 覆盖所有实例，实例终止后仍可查。
- 错误数在 CloudWatch 中以指标形式出现，可以直接接 monitoring 模块的告警。
- 发送器开销很小，在 CPU 曲线上通常看不出差别；Agent 的内存占用在数十 MB 量级。
- debug 级别会让摄取量上升一个数量级左右。

**运行时 A/B 还是切换重启**：`LOG_DRIVER` 的切换必须重启（总纲 §8.3：logging 不做请求级 A/B）。但启用后本地文件与 CloudWatch 两份数据同时存在，可以在同一部署中对同一查询并排对比（`store=local|cloudwatch`，仅管理员）。“实例终止后还能不能查到日志”需要替换实例，属于切换前 / 切换后对比。

### 6. 切换、数据迁移与回滚

**启用**：`scripts/module enable logging [--param RetentionInDays=14] [--param Shipper=agent]`（`Shipper` 是栈参数，经 Output `EnvLogCwShipper` 写成 `LOG_CW_SHIPPER`）
1. 计划校验：CRED-001（`IAM_CREDENTIALS≠none`）；`Shipper=agent` 时要求 `role`；私有子网时由 DEP-009 的部署检查确认 `logs` 端点或 NAT。
2. 部署 `infra/modules/logging.yaml`（日志组、保留期、指标过滤器、保存的查询、策略；`KmsKeyArn` 取 kms 的注入值）。
3. 生成 env；处理本模块的 `injects`：若 monitoring 已启用，用 `InfoMetricNamespace` 更新 monitoring 栈的 `LogErrorsNamespace`（新增 `log-errors` 告警）。
4. 附加 `PolicyArn`（记入 state.json）。
5. agent 方式：`hostSetup apply` 安装或复用 CloudWatch Agent，`append-config` 投递 logging 片段。
6. 原子写入 `modules.d/logging.env`，`check-config`，重启 api 和 worker（写入侧换成 CwLogger）。
7. 健康探针：写一条带唯一 ID 的 canary 日志，轮询 `FilterLogEvents` 直到查到；把测得的摄取延迟写入 capabilities 的 `detail`（第 10 节）。

**历史日志**：默认不迁移。确实需要时，`experiments/logging/backfill.ts` 可以把本地文件通过 PutLogEvents 回填，但 PutLogEvents 拒绝过旧的事件（大约两周以前，以官方文档为准），所以只能回填最近的部分。

**禁用**：`scripts/module disable logging`：`LOG_DRIVER` 改回 file（删除 env）→ 重启 → agent 方式 `hostSetup revert`（`remove-config`，没有其他片段时停止 Agent）→ 用空值更新 monitoring 栈的 `LogErrorsNamespace`（撤销注入）→ 分离策略 → 删除栈。日志组因 `DeletionPolicy: Retain` 保留，到保留期后自然过期；`--purge` 才删除。本地文件从未停止写入，回滚没有数据缺口。

### 7. SAA 考点

- 日志组、日志流、保留期（默认永不过期）、KMS 加密；日志类别 Standard 与 Infrequent Access。
- EC2 上的应用日志默认不会进入 CloudWatch，需要 CloudWatch Agent 或 SDK；Lambda 的日志会自动进入。
- 统一 CloudWatch Agent（可同时采集日志和指标）与旧的 CloudWatch Logs Agent 的区别。
- 指标过滤器把日志变成指标再接告警；指标过滤器只对创建之后摄取的日志生效，不回溯。
- Logs Insights（交互式查询，按扫描量计费）、订阅过滤器（实时送到 Kinesis Data Streams / Data Firehose / Lambda）、导出到 S3（批量、非实时）三者的区别。
- 集中式日志对无状态、可替换的 ASG 实例的意义。
- VPC Flow Logs、ALB 访问日志、CloudFront 日志、CloudTrail 各自可以投递到哪里（CloudWatch Logs、S3、Firehose）。
- CloudWatch Logs（应用和系统运行日志）与 CloudTrail（AWS API 调用审计）的区别。

### 8. 费用与清理

- 按摄取量（GB）、存储量（GB-月，压缩后计）和 Logs Insights 扫描量（GB）计费；订阅过滤器、导出另有下游费用。以官方定价为准。
- 单台 EC2、低流量时每月费用很少；打开 debug 级别、上传全量 Nginx 访问日志、使用 EMF（monitoring 的可选方式）都会让摄取量明显上升。
- 一定要给日志组设置保留期，否则默认永不过期，存储费只增不减。
- CloudWatch Agent 本身免费。
- 清理：`scripts/module disable logging --purge` 删除日志组；`--purge` 之前可以先 `CreateExportTask` 导出到 S3。

### 9. 常见坑

- 日志组默认永不过期，必须设置 `RetentionInDays`。
- 指标过滤器只对创建之后的日志生效；JSON 过滤模式中字符串要加引号（`{ $.level = "error" }`），数字比较不加。
- 日志类别在创建日志组后不能修改；Infrequent Access 不支持 Live Tail 等功能，指标过滤器、订阅过滤器的支持情况以官方的功能对照表为准。本模块统一用 Standard。
- Logs Insights 按扫描量计费：缩小时间范围、只选需要的日志组、先 `filter` 再 `stats`。
- PutLogEvents 对批大小、条数和批内时间跨度都有限制，sdk 方式在进程退出前必须 flush，否则会丢最后一批。
- logrotate 用 `create` 方式轮转时，Node 必须重新打开文件（SIGUSR2），否则会继续写已经改名的旧文件；改用 `copytruncate` 又可能丢几行。
- 日志里不能出现 Authorization、Cookie、密码和预签名 URL 的签名参数，统一在 `redact.ts` 中屏蔽；进入 CloudWatch 后就很难彻底删除。
- 多行堆栈会被 Agent 拆成多条事件。坚持输出单行 JSON（pino 默认如此），或者为 agent 方式配置 `multi_line_start_pattern`。
- 不要在模块里重新定义 Nginx 的 `log_format cloudalbum_json`，重名会让 `nginx -t` 失败；字段以总纲 §2.5 为准（请求 ID 字段叫 `rid`）。
- Nginx 的 `$request_id` 总是自己生成，不会沿用客户端传入的 `X-Request-Id`；实验脚本要从响应头 `X-CloudAlbum-Request-Id` 取 ID。
- 本地查看器只扫描当前文件和 `.1` 文件，查不到更早的日志。这本身就是对比点，但要在 UI 上写清楚。
- AL2023 的 SELinux 默认是 permissive；如果改成 enforcing，Nginx 写 `/var/lib/cloudalbum/logs` 需要正确的文件上下文。
- Lambda 日志总是自动进入 CloudWatch Logs，不受 `LOG_DRIVER` 控制；file 档要在 /lab 上明确提示“Lambda 日志不在本地”。
- `logs:GetQueryResults` 不支持资源级权限，写成具体日志组 ARN 会导致 Insights 查询 AccessDenied。
- keys 模式下选 `Shipper=agent`：Agent 读不到 `secrets.env` 中的密钥，`hostSetup` 会拒绝投放并提示改用 sdk 方式或切换到 `role`（约定 2）。

### 10. 探针

与总纲 6.2 的 logging 行一致；`LOG_DRIVER=file` 时结果记为 `localHealth`，`status=off`。

| 驱动 / 探针 | 方式 | `degraded` 判据 | `error` 判据 | 所需权限（在 `PolicyArn` 中） |
|---|---|---|---|---|
| `file`（本地，30 秒） | `logs/` 目录可写、`statfs` 剩余空间；`LoggerPort.stats()` 的 `written`；当前文件大小 | 数据卷剩余 < 15%；当前文件超过查看器的扫描上限（查询会被截断） | 目录不可写 | — |
| `cloudwatch` 常规（30 秒） | 发送器状态：`stats()` 的 `backlog`、`dropped`、`lastRemoteSuccessAt`；agent 方式改读 Agent 的本机状态 | 积压 > 10000 条，或超过 2 分钟没有成功发送；`dropped` 在增长 | 日志组不存在；连续 AccessDenied | `logs:PutLogEvents`、`logs:CreateLogStream` |
| `cloudwatch` 深度（管理员或 enable 第 7 步） | `DescribeLogStreams`（本实例日志流的 `lastIngestionTime`）；写 canary 后用 `FilterLogEvents` 测摄取延迟 | 摄取延迟超过 60 秒 | 日志组不存在 | `logs:DescribeLogStreams`、`logs:FilterLogEvents` |

### 11. 前端徽章

全局徽章来自 capabilities；查看器中的每次查询另带 `meta`（engine、用时、扫描字节、实例数）。

| 位置 | 本地实现时（`file`） | AWS 实现时（`cloudwatch`） | 降级时 |
|---|---|---|---|
| `/lab` 日志查看器顶栏 | 本地文件 · 仅 i-0abc · 扫描 N MB · 用时 M ms | CloudWatch Logs · 3 个实例 · Logs Insights 扫描 N MB | 黄色“CloudWatch 发送积压 N 条”（本地文件照常） |
| `/lab` 日志查看器页签 | 只有“本地”页签；提示“Lambda 日志不在本地” | 多出“Logs Insights”页签与“错误数（指标过滤器）”小图；`store=local\|cloudwatch` 切换 | — |
| `/lab` logging 卡片 | 本地实现：EBS 上的文件 + logrotate 14 天 | AWS 实现：CloudWatch Logs，保留 N 天，摄取延迟 n 秒（最近一次探针） | 文案后附“降级” |

```yaml
# registry.yaml：logging.lab（summary 与 badges）
summary:
  local: "日志只在 EBS 数据卷的文件里，本机线性扫描，实例没了日志就没了"
  aws: "同一份结构化日志批量送入 CloudWatch Logs：跨实例检索、Logs Insights、指标过滤器"
keyMetrics: ["摄取延迟（中位数 / 最大值）", "同一查询的耗时与扫描字节数", "实例终止后能否查到日志"]
badges:
  local: "日志：本地文件 · 仅 {instanceId}"
  aws: "日志：CloudWatch Logs · {instances} 个实例"
```

### 12. 平台模式（ATL）

> 第 4 轮新增（总纲 1.4 D16）。规格以 [docs/platform/06](../platform/06-cloudalbum-platform-mode.md) 为准（PM-M29）。

- **日志组的归属**：CloudWatch Agent 在运行时创建的日志组由 `CloudAlbumAppRole` 的会话创建，不在任何栈中；平台回收器按“派生资源”规则处理（docs/platform/02）。Agent 配置中的日志组名一律以 `cloudalbum-<env>-` 开头（平台模式下 `<env>` 为环境名），便于识别与回收。
- **平台日志组不受影响**：本模块不读写平台的日志组（`/atl-recordings/*`、`/aws/codebuild/atl-runner` 等）。
- Nginx 访问日志新增的 `args`、`port`、`run`、`probe` 字段随日志一起投递；其中查询串已对签名与授权码打码（06 PM-18）。

<a id="monitoring"></a>

## monitoring：指标、告警与仪表板 ↔ Amazon CloudWatch

> 一句话总结：没有 CloudWatch 时，指标由每个进程的 LabMetricsStore 写进本机数据库，worker 里的本地告警评估器判断阈值，再发站内信和 outbox 邮件——进程或实例一挂，告警也跟着沉默，而且看不到内存以外的虚拟化层信息（状态检查、CPU 积分）；启用后，同样的指标再批量发一份到 CloudWatch，CloudWatch Agent 补上内存和磁盘，告警由 AWS 侧评估，经模块自带的 SNS 主题发邮件，心跳缺失和状态检查告警在实例停止时照样触发。最直观的区别：做“停掉实例”实验时，基线没有任何通知；启用后几分钟内收到“cloudalbum-lab-app-heartbeat 进入 ALARM”的邮件，/lab/monitoring 也多出内存、磁盘、状态检查、CPU 积分几张图。

### 0. 元数据（registry 摘录）

```yaml
# modules/registry.yaml 中 monitoring 的条目（摘录；不一致时以 registry 为准，并同步本节）
monitoring:
  group: E
  function: 指标、告警与仪表板
  awsService: Amazon CloudWatch
  auxServices: [Amazon SNS（模块自带告警主题）, CloudWatch Agent]
  type: adapter
  port: MetricsPort                      # adapters/monitoring/{local,cloudwatch}.ts；只读侧 MetricsReader；非权威端口
  switch: { var: METRICS_DRIVER, values: [local, cloudwatch], ownedValues: [cloudwatch], localTiers: [] }
  ownsEnv: [METRICS_CW_]
  credentials: required
  prerequisites: [confirm-email]         # 告警邮件订阅需要收件人确认；单模块冒烟矩阵中标为“需人工”
  requires: []
  soft: [logging, kms]
  conflicts: []
  authoritative: false
  multiInstanceSafe: { local: false, cloudwatch: true }   # local 只产生 ASG-010 警告
  bypass: []                             # 不做请求级 A/B；本地与 CloudWatch 双写，可并排比较
  stacks: [{ name: main, template: infra/modules/monitoring.yaml }]
  baseParams: { DetailedMonitoring: "${Param.DetailedMonitoring}" }   # 栈参数，默认 'false'；写入规则见 00 的 6.3
  cwAgentFragment: infra/modules/monitoring/cwagent.json  # 内存、磁盘（EMF 方式另加 emf 段）；keys 模式下拒绝投放
  hostSetup: infra/modules/monitoring/host-setup.sh        # 安装 Agent、append-config / remove-config
  injects:                               # D2：本模块作为提供方
    - { target: audit,  params: { AlarmTopicArn: "${Out.EnvMetricsCwAlarmTopicArn}" } }   # CloudTrail 指标过滤器告警发到 ops-alarms
    - { target: backup, params: { AlarmTopicArn: "${Out.EnvMetricsCwAlarmTopicArn}" } }   # 备份 / 复制作业失败通知
  # 本栈接收的注入（都可选，默认 ''）：KmsKeyArn（kms）；LogErrorsNamespace（logging）；
  #   AlbFullName、TargetGroupFullName（load-balancer）、AsgName（autoscaling）、DbInstanceId（database）、
  #   CacheReplicationGroupId（cache）、QueueName、DlqName（queue）、ThumbFunctionName（image-processing）、SocialApiId（social-api）、
  #   StateMachineArn（workflow，失败执行数告警）
  probe: { kind: active, method: "最近一次 PutMetricData 成功时间；深度 DescribeAlarms", intervalSec: 30 }
  billing:
    - { resource: "CloudWatch 自定义指标、告警、仪表板与 API 调用", dimension: usage }
  lab: { compare: fault, hourlyBilled: false, experiments: [time-to-alert, kill-test, mem-visibility, resolution, notify-path] }   # 文案见第 11 节
  doc: docs/modules/05-ops-observability.md#monitoring
```

- 类型 A：驱动 id 等于开关取值（`local` / `cloudwatch`），非权威端口。LabMetricsStore 与本地告警评估器**始终开启**，与 `METRICS_DRIVER` 无关（总纲 7.3），所以 `cloudwatch = local + 批量上报`，回滚没有数据缺口。
- 本模块自带 SNS 主题 `cloudalbum-<env>-ops-alarms`，不依赖 notification（约定 1(d)）。其他模块的告警维度一律由提供方 `injects` 注入（约定 11），本模块不读取别的模块的状态。
- 多实例：`METRICS_DRIVER=local` 触发 ASG-010（warn）。

### 1. 基线实现（仅 EC2）

**采集：LabMetricsStore（总纲 §7.3，始终开启）**
- 每个进程内置，与 `METRICS_DRIVER` 无关：请求记录（路由模板、状态码、耗时、路径签名）、端口调用（模块、驱动、方法、耗时、错误）、进程与主机采样（每 10 秒：进程 CPU、RSS、事件循环延迟、`loadavg`、`/proc/stat` 的 steal、网卡收发字节、数据卷用量）、业务时延、源站卸载。分钟级汇总写入共享数据库的 `lab_metric_rollups`、`lab_host_samples`，保留 14 天，`lab.compact` 把 2 天前的数据压缩为小时级。
- 本模块对它的细化：主机采样增加内存使用率（读 `/proc/meminfo` 的 `MemTotal` 与 `MemAvailable`），写入 `host.memUsedRatio`。
- `MetricsPort` 的 local 驱动（`backend/src/adapters/monitoring/local.ts`）把业务自定义指标也写进 LabMetricsStore：`photo.uploads`、`thumbnail.generated{driver}`、`job.duration{job}`、`queue.depth`（worker 每 30 秒采样一次 `QueuePort.stats()`）、`cache.requests{outcome}`、`log.events{level}`（由 Logger 计数，见 logging 模块）、`process.heartbeat`（每个进程每 10 秒一次）。
- `GET /metrics` 输出 Prometheus 文本格式，只允许本机访问（Nginx `allow 127.0.0.1; deny all;`，总纲 §2.5）；管理员通过 `GET /api/lab/metrics` 查询汇总数据（总纲 §7.3）。

**告警：本地告警评估器**
- worker 进程内的循环（每 30 秒），用 LockPort 取单例锁（多实例时只有一个实例在评估）。规则来自 L0 文件 `/etc/cloudalbum/alerts.yaml`（`root:cloudalbum 0640`；实际在数据卷 `etc/` 上，随数据卷迁移，D5；不存在时由 ec2 引导脚本写入下面的默认规则），状态有 `OK`、`ALARM`、`INSUFFICIENT_DATA` 三种，状态变化写入 `alert_events` 表。
- 通知：状态变化时，给所有管理员写站内信（`notifications` 表），并调用 EmailPort 发给 `alertEmail`（基线是 outbox，即写一个 `.eml` 文件；email 模块启用后经 SES 真正发出）。

```yaml
# /etc/cloudalbum/alerts.yaml（L0 默认规则，阈值是示例）
evaluateEverySec: 30
alertEmail: admin@example.com
rules:
  - { name: app-5xx-rate,    kind: ratio,    num: "route.count{status=5xx}", den: "route.count", window: 5m, op: ">", threshold: 0.05 }
  - { name: app-p95-latency, kind: quantile, metric: "route.latency", q: 0.95, window: 5m, op: ">", threshold: 1000 }
  - { name: data-disk-high,  kind: gauge,    metric: "host.dataVolumeUsedRatio", window: 5m, op: ">", threshold: 0.85 }
  - { name: host-mem-high,   kind: gauge,    metric: "host.memUsedRatio", window: 5m, op: ">", threshold: 0.90 }
  - { name: api-heartbeat,   kind: absent,   metric: "process.heartbeat{role=api}", window: 2m }
  - { name: log-errors,      kind: sum,      metric: "log.events{level=error}", window: 5m, op: ">", threshold: 20 }
```

**仪表板**：`/lab/monitoring`（`frontend/src/lab/Monitoring.tsx`，uPlot 绘图），数据来自 `GET /api/lab/metrics` 与 `GET /api/lab/monitoring/alarms`；每张图标注“数据来自 i-xxxx”（主机类指标按实例分散）。

**局限**：评估器和被监控的应用跑在同一台机器上——worker 挂了没人评估，实例挂了没人报警（`api-heartbeat` 只能发现 api 进程死亡）；只有本机视角，没有 EC2 状态检查、CPU 积分余额这类虚拟化层指标；数据最多保留 14 天。

### 2. AWS 实现

**写入侧：`backend/src/adapters/monitoring/cloudwatch.ts`**
- `cloudwatch = local + 批量上报`（总纲 §4.2）：LabMetricsStore 和本地告警评估器继续工作，同样的指标每 `METRICS_CW_FLUSH_SEC`（默认 60 秒）批量 `PutMetricData` 一次，命名空间 `CloudAlbum/App`。
- 维度只允许总纲的白名单 `route | module | driver | outcome | job`（在 CloudWatch 中写作 `Route`、`Module`、`Driver`、`Outcome`、`Job`，`route` 是路由模板）。`requestId`、`userId`、`photoId` 这类高基数字段**永远不当维度**——每种维度组合都是一个单独计费的自定义指标。
- 延迟类直方图用 `Values` + `Counts` 数组上报原始分布，CloudWatch 才能算 p95；如果用 `StatisticValues`（统计集）上报，就拿不到百分位（以官方文档为准）。
- 上报的指标：`Requests`、`Http5xx`（各两份：不带维度的总量，以及按 `Route`）、`Latency`（毫秒，按 `Route`）、`PortLatency`（按 `Module`、`Driver`）、`CacheRequests`（按 `Outcome`）、`JobDuration`（按 `Job`）、`QueueDepth`、`AppHeartbeat`、`WorkerHeartbeat`（每个进程每分钟 1，不带维度）。
- 可选 `METRICS_CW_MODE=emf`：改用 `aws-embedded-metrics` 把同样的数据以 EMF 格式发到本机 CloudWatch Agent 的 `tcp://127.0.0.1:25888`，由 CloudWatch Logs 从日志中抽取指标（日志组 `/cloudalbum/<env>/metrics-emf`）。好处是 requestId、traceId 可以作为属性留在日志里供 Logs Insights 检索；代价是多一份日志摄取费。要显式设置 Agent 端点，不要依赖库的环境自动探测。
- 远端失败只把状态置为 `degraded`，本地数据不受影响（非权威端口）。

**CloudWatch Agent 片段：`infra/modules/monitoring/cwagent.json`**

```json
{"metrics":{"namespace":"CWAgent",
  "append_dimensions":{"InstanceId":"${aws:InstanceId}","AutoScalingGroupName":"${aws:AutoScalingGroupName}"},
  "aggregation_dimensions":[["AutoScalingGroupName"],["InstanceId"]],
  "metrics_collected":{
    "mem":{"measurement":["mem_used_percent"]},
    "disk":{"measurement":["used_percent"],"resources":["/","/var/lib/cloudalbum"],"ignore_file_system_types":["tmpfs","devtmpfs"]}}}}
```

`METRICS_CW_MODE=emf` 时再追加 `{"logs":{"metrics_collected":{"emf":{}}}}`（新版 Agent 文档把 `emf` 标为旧字段，是否仍需显式开启以官方文档为准）。`append_dimensions` 只支持 `ImageId`、`InstanceId`、`InstanceType`、`AutoScalingGroupName` 四个键，并且需要 `ec2:DescribeTags` 权限才能取到 ASG 名称。没有 Agent 时，适配器照常工作，但缺少内存和磁盘指标，状态为 `degraded`。

**CloudFormation：`infra/modules/monitoring.yaml`**

| 资源 | 说明 |
|---|---|
| `OpsAlarmTopic` | SNS 主题 `cloudalbum-<env>-ops-alarms`；参数 `AlertEmail` 不为空时创建邮件订阅（需要收件人确认）；参数 `KmsKeyArn`（kms 注入）不为空时用客户托管密钥加密（密钥策略须允许 `cloudwatch.amazonaws.com`） |
| `Dashboard` `CloudAlbum-<env>-Overview` | EC2 CPU、状态检查、CPU 积分；CWAgent 内存与磁盘；应用延迟、错误率、吞吐、心跳；其他模块启用后按 Condition 追加 ALB、RDS、SQS、Lambda、ElastiCache、API Gateway 部件 |
| 告警（见下表） | 名称前缀 `cloudalbum-<env>-`；所有告警的 `AlarmActions`、`OKActions` 指向 `OpsAlarmTopic` |
| `AppPolicy` | `cloudwatch:PutMetricData`（条件 `cloudwatch:namespace` 只允许 `CloudAlbum/App` 和 `CWAgent`）；`cloudwatch:GetMetricData`、`cloudwatch:DescribeAlarms`、`cloudwatch:DescribeAlarmHistory`（读，Resource `*`）；Agent 需要的 `ec2:DescribeTags`、`ec2:DescribeVolumes`；探针需要的 `sns:GetTopicAttributes`（限本模块主题）；EMF 方式加上 EMF 日志组的 `logs:CreateLogStream`、`logs:PutLogEvents`、`logs:DescribeLogStreams`。模板不写 `Roles` / `Users`，也不附加 `CloudWatchAgentServerPolicy`（D2，约定 5） |
| Outputs | `ModuleId`、`ModuleVersion`、`PolicyArn`、`EnvMetricsDriver`（= `cloudwatch`）、`EnvMetricsCwMode`、`EnvMetricsCwNamespace`、`EnvMetricsCwAlarmTopicArn`、`EnvMetricsCwAlarmPrefix`、`EnvMetricsCwDashboard`、`InfoDashboardUrl`。不使用 `Export` |

参数：`Env`、`ModuleVersion`、`InstanceId`（ec2 基础上下文，总纲 9.1）、`AlertEmail`、`Mode`（`putmetricdata` \| `emf`）、`DetailedMonitoring`；以及**由提供方注入**的可选参数（默认 `''`，模板用 Condition 判断是否创建对应告警与仪表板部件）：`KmsKeyArn`（kms）、`LogErrorsNamespace`（logging）、`AlbFullName`、`TargetGroupFullName`（load-balancer）、`AsgName`（autoscaling）、`DbInstanceId`（database）、`CacheReplicationGroupId`（cache）、`QueueName`、`DlqName`（queue）、`ThumbFunctionName`（image-processing）、`SocialApiId`（social-api）、`StateMachineArn`（workflow）。提供方在自己的 registry 条目里声明 `{ target: monitoring, params: {...} }`（约定 11）；提供方启用或禁用时，`scripts/module` 自动用新值或空值更新本栈，不需要“再执行一次 enable monitoring”，本模块也不读取别的模块的状态（D2）。基础栈参数 `DetailedMonitoring` 在 `--param DetailedMonitoring=true` 时经 `baseParams` 下发（开启 1 分钟粒度的 EC2 指标，单独计费；参数定义见 00 的 6.2）。

**告警清单**

| 告警 | 指标 | 配置要点 |
|---|---|---|
| `ec2-status-system` | `AWS/EC2 StatusCheckFailed_System` | 1 分钟 × 2；动作：EC2 `recover`（`arn:aws:automate:<region>:ec2:recover`）+ SNS |
| `ec2-status-instance` | `AWS/EC2 StatusCheckFailed_Instance` | 1 分钟 × 3；动作：SNS（可选 `reboot`） |
| `cpu-high` | `AWS/EC2 CPUUtilization` | 基础监控 5 分钟一个点，详细监控 1 分钟 |
| `cpu-credits-low` | `AWS/EC2 CPUCreditBalance` | 仅 T 系列；5 分钟粒度；与 image-processing 的 inline 档对比时很有用 |
| `mem-high` | `CWAgent mem_used_percent` | 必须有 Agent |
| `data-disk-high` | `CWAgent disk_used_percent`（path=/var/lib/cloudalbum） | SQLite、上传文件都在这块盘上 |
| `app-5xx-rate` | 指标数学 `Http5xx / Requests` | 1 分钟周期，5 个数据点中 3 个超阈值才告警 |
| `app-p95-latency` | `CloudAlbum/App Latency` p95 | 需要原始值上报（Values/Counts） |
| `app-heartbeat` | `CloudAlbum/App AppHeartbeat` 的 SampleCount | 1 分钟 × 3，`TreatMissingData=breaching`：进程死亡或实例停止时数据缺失即告警 |
| `worker-heartbeat` | `WorkerHeartbeat` | 同上 |
| `app-unhealthy` | 复合告警 | `ALARM(app-heartbeat) OR ALARM(ec2-status-system) OR (ALARM(app-5xx-rate) AND ALARM(app-p95-latency))`；复合告警只能发 SNS，不能执行 EC2 动作 |
| `log-errors` | `CloudAlbum/Logs AppErrors` | 仅当 logging 已启用（参数 `LogErrorsNamespace` 非空） |
| 按条件创建 | ALB `HTTPCode_Target_5XX_Count`、`TargetResponseTime`；SQS `ApproximateAgeOfOldestMessage`、DLQ 深度；RDS `CPUUtilization`、`FreeStorageSpace`；ElastiCache `CPUUtilization`、`Evictions`；Lambda `Errors`、`Throttles`；API Gateway `5xx`；Step Functions `ExecutionsFailed`（`StateMachineArn` 非空时；指标名以官方文档为准） | 对应提供方经 `injects` 注入资源标识后，由 `scripts/module` 自动更新本栈（约定 11） |

关于 `recover`：t3 / t4g 等只用 EBS 的实例支持恢复动作；较新的实例类型还默认启用了“简化自动恢复”（以官方文档为准），告警动作 `recover` 在这里主要用来演示 SAA 考点，并与 SNS 通知组合。

```mermaid
flowchart LR
  APP[api / worker] -->|LabMetricsStore| DB[(lab_metric_rollups)]
  DB --> EV[本地告警评估器（worker 内）] --> NP[站内信 + EmailPort]
  APP -.->|METRICS_DRIVER=cloudwatch · PutMetricData 批量| CW[(CloudWatch 指标)]
  AG[CloudWatch Agent] -->|mem / disk| CW
  EC2M[EC2 虚拟化层] -->|CPU · 状态检查 · CPU 积分| CW
  CW --> AL{CloudWatch 告警}
  AL -->|AlarmActions| SNS[ops-alarms 主题] --> MAIL[邮件订阅]
  AL -->|StatusCheckFailed_System| REC[EC2 recover]
  NOTE[实例停止：本地评估器沉默；app-heartbeat 因数据缺失进入 ALARM]
```

**/lab 的变化**：每张图右上角出现“本地 / CloudWatch / 并排”切换（`GET /api/lab/metrics?...&source=local|cloudwatch`，cloudwatch 一侧经 `GetMetricData` 读取，结果缓存 60 秒）；告警面板同时列出本地规则与 CloudWatch 告警的状态和最近的状态变化历史（`DescribeAlarmHistory`），并标出送达路径：“SNS（实例宕机也能发出）”或“本地（实例宕机即失效）”。

### 3. 开关与配置

```bash
# /etc/cloudalbum/modules.d/monitoring.env（root:cloudalbum 0640，数据卷上；启用时由 scripts/module 写入；不存在 = METRICS_DRIVER=local）
MODULE_MONITORING=on
MODULE_MONITORING_VERSION=1
METRICS_DRIVER=cloudwatch                     # local | cloudwatch（第一个是本地实现）；Outputs.EnvMetricsDriver
METRICS_CW_MODE=putmetricdata                 # putmetricdata | emf（emf 需要 Agent，即 role）；Outputs.EnvMetricsCwMode
METRICS_CW_NAMESPACE=CloudAlbum/App           # Outputs.EnvMetricsCwNamespace
METRICS_CW_FLUSH_SEC=60
METRICS_CW_EMF_ENDPOINT=tcp://127.0.0.1:25888 # 仅 emf
METRICS_CW_ALARM_PREFIX=cloudalbum-lab-
METRICS_CW_ALARM_TOPIC_ARN=arn:aws:sns:ap-northeast-1:<acct>:cloudalbum-lab-ops-alarms
METRICS_CW_DASHBOARD=CloudAlbum-lab-Overview
```

- 本地告警规则在 `/etc/cloudalbum/alerts.yaml`（L0 文件，在数据卷上，不属于模块 env）；worker 监听该文件变化后重新加载。阈值**不是** ConfigPort 的运行时热键：RuntimeConfig 的键集合由总纲 4.2 固定（D7），config=ssm 时也不从 Parameter Store 读阈值。
- env 中没有机密类键（CFG-002）；告警主题 ARN 不是机密。
- 告警邮件地址是栈参数 `AlertEmail`，由 `scripts/module enable monitoring --param AlertEmail=you@example.com` 传入。

端口接口要点（写入侧沿用总纲 §4.2 的 MetricsPort，只追加只读侧）：

```ts
// backend/src/ports/metrics.ts（追加部分）
export interface SeriesQuery {
  name: string; stat: 'avg' | 'sum' | 'max' | 'p95'; periodSec: number;
  since: Date; until?: Date; dims?: Dims; source: 'local' | 'cloudwatch';
}
export interface AlarmView {
  name: string; state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA'; since: string;
  source: 'local' | 'cloudwatch'; delivery: 'local' | 'sns'; reason?: string;
}
export interface MetricsReader {
  series(q: SeriesQuery): Promise<Array<{ t: number; v: number }>>;   // cloudwatch 源走 GetMetricData
  alarms(): Promise<AlarmView[]>;                                       // local：alert_events；cloudwatch：DescribeAlarms
  history(name: string, limit: number): Promise<Array<{ at: string; from: string; to: string; reason: string }>>;
}
```

```ts
// backend/src/adapters/monitoring/cloudwatch.ts（要点）
const DIM_NAMES = { route: 'Route', module: 'Module', driver: 'Driver', outcome: 'Outcome', job: 'Job' } as const;
histogram(name, value, unit, dims) {
  this.local.histogram(name, value, unit, dims);          // LabMetricsStore 照写
  this.buf.addValue(name, dims, value, unit);             // 按 (name, dims) 聚合成 Values/Counts
}
async flush() {                                            // 每 METRICS_CW_FLUSH_SEC 一次；SIGTERM 时也调用
  for (const batch of this.buf.drainBatches()) {           // 每批的指标数与负载大小低于官方上限
    await this.cw.putMetricData({ Namespace: this.ns, MetricData: batch }).catch((e) => this.health.remoteFailed(e));
  }
}
```

### 4. 依赖与组合

**硬依赖**
- 凭证（`credentials: required`，CRED-001）与上面列出的权限。推荐 `IAM_CREDENTIALS=role`；keys 模式下应用侧 `PutMetricData` 照常（CRED-002 warn），但 Agent 不读 `secrets.env` 中的密钥，本项目也不为它另写凭证文件（约定 2），所以内存、磁盘指标与 EMF 方式不可用，模块为 `degraded`。
- 实例能出站访问 `monitoring` 端点（EMF 方式还需要 `logs`）；私有子网需要 NAT 或对应的 Interface Endpoint。
- 软依赖（缺失时 `degraded`，不拒绝启动）：CloudWatch Agent（内存、磁盘指标）；`AlertEmail` 订阅已确认（否则告警只在控制台和 /lab 可见）。
- EC2 `recover` 动作要求实例类型支持且只使用 EBS 卷，t3 / t4g 满足（以官方文档为准）。

**与其他模块组合**
- **autoscaling**：ASG 的扩缩容策略依赖 CloudWatch 指标。`AWS/EC2 CPUUtilization` 和 `ALBRequestCountPerTarget` 不需要本模块就存在；要用应用自定义指标做目标跟踪（例如每实例在途请求数），就必须 `METRICS_DRIVER=cloudwatch`，并为这一个指标额外发布一份带 `AutoScalingGroupName` 维度的版本。这是对总纲 4.2 维度白名单 `route|module|driver|outcome|job` 的唯一例外，目前只在本文声明，需要总纲 4.2 的 `Dims` 注释收录（见修订记录“仍需配合”）；在收录之前，autoscaling 的目标跟踪使用 `ALBRequestCountPerTarget` 等内置指标。建议在启动模板中开启详细监控，扩容反应更快。目标跟踪策略自动创建的告警不要手动修改。多实例时 LabMetricsStore 的主机样本按实例分散（ASG-010 警告），CWAgent 指标按 `AutoScalingGroupName` 聚合。
- **logging**：logging 启用后，它的指标过滤器 `CloudAlbum/Logs AppErrors` 可以加入告警和仪表板；不启用时，本地规则用 `log.events{level=error}` 计数，两者之间没有硬依赖。agent 方式下两者共用一个 Agent 进程。
- **notification、email**：不需要 notification（告警主题由本模块自带）。基线的本地告警经 EmailPort 发出，email=ses 时真正送达邮箱；但这条路径仍然依赖实例存活。
- **load-balancer、autoscaling、queue、database、cache、image-processing、social-api**：这些模块作为提供方，在自己的 registry 条目中声明 `injects: [{ target: monitoring, params: {...} }]`（约定 11）；它们启用、输出变化或禁用时，`scripts/module` 自动更新本栈，按 Condition 追加或移除告警和仪表板部件。本模块先启用、提供方后启用，或者反过来，结果相同。
- **image-processing**：inline 档在 T 系列实例上会消耗 CPU 积分，`CPUCreditBalance` 曲线是“有无 Lambda”对比中的旁证。
- **tracing**：互补。指标回答“有没有问题、有多严重”，追踪回答“慢在哪一段”；EMF 方式下指标记录带 `traceId` 属性，可以从 Insights 跳到 trace。
- **config（ssm）**：config 只管运行时业务热键（D7），本地告警阈值与 Agent 片段都不归 ConfigPort 管。CloudWatch Agent 本身支持 `-c ssm:<参数名>` 从 Parameter Store 读配置（SAA 知识点），但本项目的片段一律随发布包由 `hostSetup` 投放，以满足重放契约。
- **audit**：本模块经 `injects` 把 ops-alarms 主题 ARN 注入 audit 栈的 `AlarmTopicArn`，audit 据此为 CloudTrail 指标过滤器（root 登录、安全组变更、IAM 策略变更、AccessDenied 激增）创建告警。
- **threat-detection**：GuardDuty 发现走它自带的 security-findings 主题，不经过本模块；需要时可以对 GuardDuty 的发现计数另建告警。
- **kms**：主题加密必须用客户托管密钥，并授权 `cloudwatch.amazonaws.com`。

### 5. 对比实验：有 vs 没有

| 维度 | 没有 CloudWatch（基线：LabMetricsStore + 本地评估器） | 有 CloudWatch |
|---|---|---|
| 谁评估告警 | worker 进程（与应用同机） | AWS 侧，与实例解耦 |
| 进程 / 实例宕机 | 告警沉默 | 心跳缺失告警（breaching）、状态检查告警照常触发 |
| 通知 | 站内信 + outbox（或 SES） | SNS 原生动作 → 邮件等订阅 |
| 内存、磁盘 | 本机读取 `/proc` 与 `statfs` | CWAgent 指标（EC2 默认没有内存指标） |
| 虚拟化层指标 | 没有（只能用 steal 时间近似） | 状态检查、CPU 积分、EBS 指标 |
| 粒度 | 主机样本 10 秒；汇总 1 分钟 | 自定义指标 1 分钟；EC2 基础监控 5 分钟 / 详细监控 1 分钟 |
| 出现延迟 | 秒级 | 分钟级 |
| 多实例 | 主机数据按实例分散 | 按 ASG 聚合 |
| 保留 | 14 天（后期为小时级） | 最长约 15 个月，粒度随时间降低（以官方文档为准） |
| 自动动作 | 无 | EC2 recover / reboot、ASG 策略 |
| 费用 | 无 AWS 费用 | 自定义指标、告警、详细监控、API 调用按量计费 |

**页面上能直接看到的差异**
- /lab/monitoring 每张图右上角“本地 / CloudWatch / 并排”：并排时，本地曲线的点更密且实时；CloudWatch 曲线 1 分钟一个点，最新的点要晚一两分钟才出现；EC2 CPU 在基础监控下 5 分钟一个点。
- cloudwatch 档多出的图：内存与磁盘（CWAgent）、EC2 状态检查、CPU 积分余额、按 ASG 聚合的指标。
- 告警面板中每个告警的状态、最近状态变化和“送达路径”标签。
- 收件箱：基线时 `/admin/outbox` 中出现告警邮件（`.eml`）；启用后真实邮箱收到 SNS 邮件。

**测量指标**
告警检测时间（从注入故障到进入 ALARM）；通知送达时间；进程宕机、实例停止两种情况下能否告警；指标粒度与出现延迟；内存、磁盘指标是否可得；Agent 开销；每月自定义指标数量（费用的主要驱动因素）。

**操作步骤**（`experiments/monitoring/`）
1. 告警时延：`npm run exp -- monitoring --label after --scenario time-to-alert`。`time-to-alert.ts` 调用 `POST /api/lab/faults {"type":"error5xx","rate":0.5,"durationSec":600}`，同时用 `load.k6.js` 施加恒定负载；记录注入时刻，轮询 `GET /api/lab/monitoring/alarms`（本地）与 `aws cloudwatch describe-alarm-history --alarm-name cloudalbum-lab-app-5xx-rate`（CloudWatch），以及管理员站内信、outbox 的到达时间。可选 `--sqs-probe`：脚本给 ops-alarms 主题临时加一个 SQS 订阅，自动记录 SNS 送达时间，结束后删除。切换前（`--label before`）只测本地一侧。
2. 宕机实验：`npm run exp -- monitoring --label after --scenario kill-test [--phase service|instance|all]`（缺省 `all`；平台模式见第 12 节）。第一阶段执行故障脚本 `faults/stop-app.sh`（经投递通道执行 `systemctl stop cloudalbum-api cloudalbum-worker`）；第二阶段执行 `faults/stop-instance.sh`（`aws ec2 stop-instances`）。分别观察：本地评估器是否发出通知（不会）、`app-heartbeat` 多久进入 ALARM、邮件何时到达。实验结束后脚本自动启动实例和服务。
3. 内存可见性：`POST /api/lab/faults {"type":"mem","durationSec":300}`，然后 `npm run exp -- monitoring --label after --scenario mem-visibility`：对比 `AWS/EC2` 命名空间（没有内存指标）、`CWAgent mem_used_percent` 和本地 `host.memUsedRatio` 三条曲线。
4. 粒度：`npm run exp -- monitoring --label after --scenario resolution`：施加一段 3 分钟的 CPU 尖峰（`{"type":"cpu","durationSec":180}`），并排画出本地 10 秒样本、`AWS/EC2 CPUUtilization` 在基础监控和详细监控（`--param DetailedMonitoring=true` 后重做一次）下的曲线。
5. 通知链路：`aws cloudwatch set-alarm-state --alarm-name cloudalbum-lab-app-5xx-rate --state-value ALARM --state-reason "lab test"`，确认邮件送达；随后告警会在下一个评估周期按真实数据回到 OK。
6. 控制台：CloudWatch → 告警；仪表板 `CloudAlbum-lab-Overview`。

**预期结果**
- 本地告警检测更快（秒级到数十秒，取决于 30 秒评估间隔和窗口），但进程或实例宕机时完全沉默。
- CloudWatch 告警的延迟是分钟级，由“周期 × 评估期”和指标出现延迟共同决定；心跳缺失告警和状态检查告警在实例停止或挂掉时仍会触发，经 SNS 送达。
- EC2 默认只有 CPU、网络、磁盘 I/O、状态检查等虚拟化层指标，内存和文件系统使用率必须靠 Agent。
- 同一个 3 分钟尖峰，在 5 分钟基础监控里可能被“平均”成不起眼的小坡；1 分钟详细监控和本地样本能看清。
- 自定义指标的数量取决于维度组合，坚持白名单时在几十个量级。

**运行时 A/B 还是切换重启**：`METRICS_DRIVER` 的切换需要重启（总纲 §8.3）。启用后本地与 CloudWatch 双写，可以在同一部署中并排比较粒度和出现延迟；“实例宕机时谁还能告警”、基础监控与详细监控的对比需要停服务、停实例或改基础栈参数，属于切换前 / 切换后测量。

### 6. 切换、数据迁移与回滚

**启用**：`scripts/module enable monitoring --param AlertEmail=you@example.com [--param DetailedMonitoring=true] [--param Mode=emf]`
1. 计划校验：CRED-001；`Mode=emf` 时要求 `role`；私有子网时由 DEP-009 的部署检查确认端点或 NAT；`prerequisites: [confirm-email]` 提示人工确认。
2. 确认：提示自定义指标、告警按量计费；`DetailedMonitoring=true` 另行计费。
3. 部署 `infra/modules/monitoring.yaml`：参数 = `AlertEmail` 等本模块参数 + **所有已启用提供方对本栈的注入值**（kms、logging、load-balancer、database 等，约定 11）。
4. 生成 env；处理本模块的 `injects`：若 audit 已启用，用 ops-alarms 主题 ARN 更新 audit 栈的 `AlarmTopicArn`；有 `DetailedMonitoring` 时按 `baseParams` 更新基础栈。
5. 附加 `PolicyArn`（记入 state.json）。
6. 不迁移数据。
7. `hostSetup apply`：安装或复用 CloudWatch Agent，`append-config` 投递 monitoring 片段（emf 方式额外投递 emf 段；keys 模式下跳过并标注 `degraded`）；原子写入 `modules.d/monitoring.env`。
8～9. `check-config`；重启 api 和 worker。
10. 探针：上报一个 `LabProbe` 指标，轮询 `GetMetricData` 直到它出现（分钟级）；`DescribeAlarms` 能列出本模块的告警（第 10 节）。提示收件人去确认 SNS 订阅邮件。

**迁移**：没有数据需要迁移。LabMetricsStore 与 `/metrics` 继续保留；本地历史数据不回填到 CloudWatch。

**禁用**：`scripts/module disable monitoring`：删除 env，`METRICS_DRIVER` 回到 local → 重启 → `hostSetup revert`（`remove-config` 移除 Agent 片段，没有其他片段时停止 Agent）→ 用空值更新 audit 栈的 `AlarmTopicArn`（撤销注入，audit 的告警随之删除、指标过滤器保留）→ 分离策略 → 删除栈（告警、仪表板、SNS 主题随之删除）→ 如开过详细监控，`baseParams` 还原为 false。已经上报的自定义指标无法删除，停止上报后按保留策略自然过期。

### 7. SAA 考点

- EC2 基础监控（5 分钟）与详细监控（1 分钟）；默认没有内存和磁盘使用率指标，需要 CloudWatch Agent；状态检查（系统 / 实例）。
- 自定义指标：标准分辨率与高分辨率、维度与基数、PutMetricData 与 EMF 的区别；统计集拿不到百分位。
- 告警的三种状态、周期与评估期（M of N）、缺失数据的处理（`TreatMissingData`）、指标数学告警、复合告警。
- 告警动作：SNS 通知；EC2 动作（stop / terminate / reboot / recover）；触发 Auto Scaling 策略。
- ASG 的扩缩容策略（目标跟踪、步进、简单、预定、预测）都依赖 CloudWatch 指标；目标跟踪的告警由 AWS 自动管理。
- T 系列的 CPU 积分余额指标与“无限模式”。
- CloudWatch（性能）、CloudTrail（API 审计）、AWS Config（配置合规）的区别。
- 指标保留期随粒度降低；仪表板可以跨区域、跨账户。
- 监控系统要和被监控对象解耦：用心跳缺失告警和状态检查告警发现实例死亡。

### 8. 费用与清理

- EC2 基础监控和状态检查指标免费。计费项：详细监控（按实例）；自定义指标（按指标数，维度组合越多指标越多）；告警（按告警数，标准、高分辨率、复合告警价格不同）；超出免费数量的仪表板；`GetMetricData` 等 API 调用；EMF 方式产生的日志摄取费；SNS 邮件通知在免费额度内通常可以忽略。CloudWatch Agent 本身免费。以官方定价为准。
- 最大的风险是把高基数字段当成维度，导致指标数量暴涨。
- 清理：`scripts/module disable monitoring`；详细监控记得关；如做过 `--sqs-probe` 实验，确认临时队列已删除。

### 9. 常见坑

- 把 userId、requestId、photoId 当作维度，自定义指标数量会爆炸，费用随之上升；高基数字段只能放在 EMF 属性或日志里。
- EC2 默认没有内存指标——这是常考点，也是新手最常见的疑问。
- CloudWatch 告警不能发布到用 AWS 托管密钥 `aws/sns` 加密的主题；要用客户托管密钥，并在密钥策略中授权 `cloudwatch.amazonaws.com`。
- SNS 邮件订阅需要收件人点击确认，否则告警发出去也收不到。
- `TreatMissingData` 默认是 `missing`。心跳告警必须设为 `breaching`，否则实例死掉后告警会停在 `INSUFFICIENT_DATA`。
- 用 `StatisticValues` 上报的指标算不出 p95；要用原始值或 `Values`/`Counts`。
- 不要手动修改或删除目标跟踪策略自动创建的告警。
- 复合告警只能执行 SNS 等通知类动作，不能执行 EC2 动作；`recover` 要挂在 `StatusCheckFailed_System` 这个指标告警上。
- EMF 本质上是日志，会产生 CloudWatch Logs 摄取费；EMF 日志组也要设置保留期。`aws-embedded-metrics` 在 EC2 上要显式配置 Agent 端点。
- Agent 的 `append_dimensions` 取 ASG 名称需要 `ec2:DescribeTags`；`PutMetricData` 的命名空间条件要同时放行 `CWAgent`，否则 Agent 的指标会 AccessDenied。
- 本地告警评估器和被监控的应用跑在同一台机器上，实例一死就不会告警，要在 UI 上明确标注。
- 同一组阈值在 1 分钟和 5 分钟粒度下的触发行为不同，对比实验时要固定周期。
- `set-alarm-state` 只是临时改状态，下一次评估会按真实数据改回来，不要误以为告警“自己恢复了”。
- 不要为了“刷新维度参数”去手动重新 enable monitoring：维度参数由提供方的 `injects` 维护，手工改栈参数会在下一次注入时被覆盖。

### 10. 探针

与总纲 6.2 的 monitoring 行一致；`METRICS_DRIVER=local` 时结果记为 `localHealth`，`status=off`。

| 驱动 / 探针 | 方式 | `degraded` 判据 | `error` 判据 | 所需权限（在 `PolicyArn` 中） |
|---|---|---|---|---|
| `local`（本地，30 秒） | LabMetricsStore 最近一次 flush 时间；本地告警评估器最近一次评估时间（读 `alert_events` 与 LockPort 持有者） | 评估器超过 2 个周期（60 秒）没有运行（worker 停了或拿不到锁） | `lab_metric_rollups` 不可写 | — |
| `cloudwatch` 常规（30 秒） | 最近一次 `PutMetricData` 成功时间；本机 Agent 是否在运行（读安全快照 `host.units` 中的 `amazon-cloudwatch-agent`，应用不需要 root） | 超过 2 个刷新周期未成功；Agent 未运行或缺少 mem/disk 片段（含 keys 模式）；告警订阅未确认（`sns:GetTopicAttributes` 的 `SubscriptionsPending > 0`） | 连续 AccessDenied | `cloudwatch:PutMetricData`、`sns:GetTopicAttributes` |
| `cloudwatch` 深度（管理员或 enable 第 10 步） | `DescribeAlarms` 各状态数量；`GetMetricData` 读回 `LabProbe` | 有本模块告警处于 `INSUFFICIENT_DATA` 超过 10 分钟（通常是维度参数不对） | 本模块的告警不存在（栈被手工删改） | `cloudwatch:DescribeAlarms`、`cloudwatch:GetMetricData` |

### 11. 前端徽章

| 位置 | 本地实现时（`local`） | AWS 实现时（`cloudwatch`） | 降级时 |
|---|---|---|---|
| `/lab/monitoring` 每张图右上角 | 数据来自 i-xxxx · 10 秒样本 | 本地 / CloudWatch / 并排 · 1 分钟粒度（EC2 基础监控 5 分钟） | 黄色“CloudWatch 上报落后 n 分钟” |
| `/lab/monitoring` 告警面板的“送达路径”标签 | 本地（实例宕机即失效） | SNS（实例宕机也能发出） | 黄色“订阅未确认：告警只在控制台可见” |
| `/lab` monitoring 卡片 | 本地实现：LabMetricsStore + worker 内评估器 | AWS 实现：CloudWatch 指标与告警 · 自带 ops-alarms 主题 | 文案后附“降级”，悬停显示 detail（例如“缺少内存、磁盘指标：Agent 未运行”） |

```yaml
# registry.yaml：monitoring.lab（summary 与 badges）
summary:
  local: "LabMetricsStore + worker 内的本地告警评估器：进程或实例一挂，告警也跟着沉默"
  aws: "同样的指标双写到 CloudWatch，Agent 补内存与磁盘；告警在 AWS 侧评估，经自带 SNS 主题送达"
keyMetrics: ["告警检测时间", "实例停止时能否告警", "内存、磁盘指标是否可得", "指标粒度与出现延迟"]
badges:
  local: "监控：本地评估器（实例宕机即失效）"
  aws: "监控：CloudWatch 告警 · SNS 送达"
```

### 12. 平台模式（ATL）

> 第 5 轮新增（总纲 1.4 D16）。规格以 [docs/platform/06](../platform/06-cloudalbum-platform-mode.md) 为准（PM-M30）。

- **`kill-test` 分阶段运行**：`experiments/monitoring/kill-test` 增加参数 `--phase service|instance|all`。`service` 只做第一阶段（停 api 与 worker，等待后恢复）；`instance` 只做第二阶段（停止实验机、等待、启动并等管理通道恢复，`finally` 中保证实例被启动）；`all` 即本节第 5 部分的两阶段连跑。平台模式缺省 `service`，独立模式缺省 `all`（行为不变）。
- **变体**：`experiment.json` 的 `labels` 登记一次性变体 `stop-instance`（`role: single`），平台模式下它只接受 `--phase instance`，`before`、`after` 只接受 `--phase service`。这样卡片的 before / after 成对比较两侧场景一致（docs/platform/04 §7.4），停实例作为单独的附加观察。
- **预期中断**：停实例会让平台管理通道暂时离线，卡片在对应步骤声明 `expectedOutage`（docs/platform/04），平台在窗口内不把它当作故障。

<a id="tracing"></a>

## tracing：分布式链路追踪 ↔ AWS X-Ray

> 一句话总结：没有 X-Ray 时，EC2 只能给每个响应加 `Server-Timing`，说明这次请求在本进程内各端口花了多少时间（单跳）；本地档 `local` 再加上 OpenTelemetry 的本地 span 文件和 /lab 瀑布图，但仍只看得到本机进程。启用 xray 后，同一套 OTel 插桩把 span 经本机 CloudWatch Agent 导出到 X-Ray：跨进程（api → SQS → worker）和跨 AWS 服务（S3、DynamoDB、RDS、Rekognition……）的调用被串成一条 trace，并汇总成服务地图。最直观的区别：响应头 `X-CloudAlbum-Path` 中出现 `tracing=xray:sampled`，/lab/tracing 出现“在 X-Ray 中打开”和服务地图；注入数据库延迟后，地图上的 PostgreSQL 节点变色，点进去就是那条慢 trace。

### 0. 元数据（registry 摘录）

```yaml
# modules/registry.yaml 中 tracing 的条目（摘录；不一致时以 registry 为准，并同步本节）
tracing:
  group: E
  function: 分布式链路追踪
  awsService: AWS X-Ray
  auxServices: [CloudWatch Agent（traces 段）或 ADOT Collector]
  type: adapter
  port: TracerPort                       # adapters/tracing/{none,local,xray}.ts；只读侧 TraceReader；非权威端口
  switch: { var: TRACING_DRIVER, values: [none, local, xray], ownedValues: [xray], localTiers: [local] }
  ownsEnv: [TRACING_]
  credentials: required                  # 仅 xray 档调用 AWS（由本机 Collector 用实例角色写 X-Ray；/lab 读 GetTraceSummaries）；none / local 不需要
  prerequisites: []
  requires: []
  soft: [queue, image-processing, workflow, logging]   # 有它们时才看得到跨进程、跨服务的链路
  conflicts: []
  authoritative: false
  multiInstanceSafe: { none: true, local: false, xray: true }   # local：span 文件按实例分散（没有对应的 ASG 规则，只在 /lab 标注）
  bypass: [tracing]                      # X-Compare-Bypass: tracing → 本次请求不导出 span（总纲 8.3）
  stacks: [{ name: main, template: infra/modules/tracing.yaml }]   # 只在 xray 档部署；local 是本地档，scripts/module 跳过部署、注入与授权（总纲 9.2 第 1 步）
  systemdDropIns:                        # local 与 xray 档都投放；none 档不投放，进程完全不加载 OTel
    - infra/modules/tracing/systemd/50-tracing.conf      # cloudalbum-api 与 cloudalbum-worker；api 的同时复制到 cloudalbum-api@.service.d/（00 的 6.8）
  cwAgentFragment: infra/modules/tracing/cwagent.json    # 仅 xray 档；keys 模式下拒绝投放（约定 2）
  hostSetup: infra/modules/tracing/host-setup.sh         # 投放 drop-in；xray 档安装 Agent、检查版本、append-config
  injects:                               # D2：本模块作为提供方
    - { target: image-processing, params: { Tracing: Active }, when: { TRACING_DRIVER: xray } }   # Lambda 主动追踪
    - { target: workflow,         params: { Tracing: Active }, when: { TRACING_DRIVER: xray } }   # 状态机 TracingConfiguration
  # 本栈接收的注入：无
  probe: { kind: active, method: "local：span 目录可写与最近导出；xray：本机 Collector 健康 + 导出错误计数", intervalSec: 30 }
  billing:
    - { resource: "X-Ray 记录与检索、扫描的 trace 数", dimension: usage }
  lab: { compare: runtime-ab, hourlyBilled: false, experiments: [walkthrough, slow-hunt, overhead, propagation] }   # 文案见第 11 节
  doc: docs/modules/05-ops-observability.md#tracing
```

- 类型 A：驱动 id 等于开关取值（`none` / `local` / `xray`），非权威端口。`local` 是本地档：写入 `modules.d/tracing.env`，但**不写** `MODULE_TRACING=on`，CFG-004 由 `localTiers` 豁免；只有 `xray` 档写 `MODULE_TRACING=on` 并部署栈。
- `credentials` 按模块标注为 `required`，只在开关取 AWS 值（`xray`）时触发 CRED-001（总纲 3.2 凭证列的定义）。xray 档的数据由本机 Collector 用实例配置文件凭证写入 X-Ray，所以实际上要求 `IAM_CREDENTIALS=role`：keys 模式下 Collector 拿不到凭证，第 10 节探针报 `error`（约定 2；是否在总纲增设一条部署规则见修订记录“仍需配合”）。

**本地档 `local` 与总纲的对应关系**（上一轮作为偏差提出，总纲第 2 轮已全部收录；本文与下表任何一处不一致时以总纲为准）：

| 总纲位置 | 总纲的规定 | 本文对应 |
|---|---|---|
| 1.3 术语“本地档” | 不需要任何 AWS 资源的驱动，用来把“架构模式”与“托管服务”的差异拆开 | `local` = OTel 插桩 + 本地 span 文件，与 `xray` 只差导出后端 |
| 2.4 目录布局 | `logs/spans/`：`TRACING_DRIVER=local` 的本地 span，保留 3 天 | 第 1 节 `FileSpanExporter`；`TRACING_LOCAL_RETENTION_DAYS=3` |
| 2.6 systemd 扩展 | 模块只能用 drop-in；tracing 写入 `Environment=NODE_OPTIONS=--import …/register.js`，在 registry `systemdDropIns`（复数）中声明 | 第 1 节预加载；本节 `systemdDropIns` |
| 2.8 X21 | `none` 仅单跳 `Server-Timing`；本地档 `local` 记录本机 span 树 | 第 1 节两档 |
| 3.2 总表 | `TRACING_DRIVER=none\|local\|xray`（本地档 local），凭证 required（xray 档） | 本节 registry 摘录 |
| 4.1 端口表 | TracerPort（含 TraceReader），驱动 `none`、`local`、`xray`，非权威 | 第 3 节端口要点 |
| 4.2 TracerPort 注释 | local = OTel SDK + FileSpanExporter；xray 经本机 Collector 导出；SQS→worker 经 `JobEnvelope.traceparent` 续接；S3→EventBridge→Lambda 是另一条 trace | 第 2 节“哪些环节能串成一条 trace” |
| 4.4 zod `Tracing` 段 | local 分支 `TRACING_LOCAL_RETENTION_DAYS`（默认 3）；xray 分支 `TRACING_OTLP_ENDPOINT`（默认 `http://127.0.0.1:4318`） | 第 3 节 env；本组另用的 4 个键已由总纲第 3 轮补进 zod |
| 6.2 探针表 | `tracing / local`、`tracing / xray` 两行 | 第 10 节 |
| 7.2 路径头词表 | `local:recorded`、`xray:sampled`、`xray:not-sampled` | 第 3 节词表（本组补充 `local:not-sampled`、`xray:bypass`） |
| 8.3 BypassKey | `tracing`：本次请求不导出 span，允许所有路由 | 第 5 节开销实验 |
| 10.2 档位 | `l0-plus-local-tiers` 含 `TRACING_DRIVER=local`；`l9-full` 为 xray，并给 image-processing 加 `Tracing=Active` | 第 6 节；本节 `injects` |
| 10.4 单模块 | tracing：local 档不需要 AWS；xray 档 +iam | 本组模块一览 |

### 1. 基线实现（仅 EC2）

**`TRACING_DRIVER=none`（L0 默认，总纲 §4.2）**
- 请求 ID：Nginx 的 `$request_id` → `X-Request-Id` → 应用 `requestId` → 响应头 `X-CloudAlbum-Request-Id`（与 logging 模块相同）。
- `Server-Timing` 与 `X-CloudAlbum-Path` 由 `observability/` 的 instrument 代理统一生成（总纲 §7.1、§7.2），**不依赖 TracerPort**，所以在任何档位都存在，例如：`Server-Timing: total;dur=48.7, database;dur=21.3;desc="sqlite x3", app;dur=16.4, storage;dur=9.8;desc="local:accel"`。
- TracerPort 的 none 驱动（`adapters/tracing/none.ts`）：span 是空操作，`currentTraceId()` 返回 undefined，`inject`/`extract` 什么也不做；进程不加载任何 OpenTelemetry 包。
- 前端 /lab/trace（总纲 §7.4）根据 `Server-Timing` 和浏览器 Resource Timing 画“浏览器 → 入口 → 本进程各模块”的单跳瀑布图。

**`TRACING_DRIVER=local`（本地档，不需要 AWS；总纲已收录，对应关系见第 0 节）**
- 用 OpenTelemetry Node SDK（`@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node`，覆盖 http、express、knex、pg、ioredis、aws-sdk、undici；关闭噪声很大的 fs 插桩）生成真正的 span。
- 导出器是自研的 `FileSpanExporter`（配合 `BatchSpanProcessor`），写入 `/var/lib/cloudalbum/logs/spans/spans-YYYYMMDD.jsonl`（`cloudalbum` 0640，D6），保留 `TRACING_LOCAL_RETENTION_DAYS` 天（默认 3，worker 每日清理）。
- 采样：`ParentBased(TraceIdRatioBased(TRACING_LOCAL_SAMPLE_RATIO))`，实验时默认 1.0。
- 跨进程：QueuePort 的 `JobEnvelope.traceparent`（总纲 §4.2 已预留）由 `TracerPort.inject` 写入、worker 消费时 `extract` 恢复，所以 `QUEUE_DRIVER=memory` 时也能在本地看到 api → worker 的链路。
- 预加载：OTel 必须在 express、pg 等模块被加载之前初始化。本模块的 `hostSetup` 投放 systemd drop-in `/etc/systemd/system/cloudalbum-{api,worker}.service.d/50-tracing.conf`（registry `systemdDropIns`；api 的那份由 `run-hostsetup.sh` 同时复制到 `cloudalbum-api@.service.d/`，保证 `LB_LOCAL_WORKERS=2` 的第二个进程一致，00 的 6.8）：

  ```ini
  [Service]
  Environment=NODE_OPTIONS=--import /opt/cloudalbum/backend/dist/telemetry/register.js
  ```

  L0 的单元文件保持不变（总纲 2.6：模块只能用 drop-in 扩展 systemd，`Environment=NODE_OPTIONS=…` 是 drop-in 白名单中唯一允许的环境变量，00 的 6.8）；`none` 档不投放这个 drop-in，进程完全不加载 OTel。实例被替换后由重放契约重新投放（约定 2）。
- 查询与展示：`GET /api/lab/traces?traceId=|requestId=|minDurMs=&limit=` 扫描 jsonl 文件；/lab/tracing 按父子关系和时间轴画瀑布图。

**局限**：只看得到本机进程内的 span；Lambda、API Gateway 等 AWS 侧的环节是空白；多实例时 span 文件分散在各台机器上；没有服务地图和按条件检索。

### 2. AWS 实现

**同一套插桩，只换后端。** `register.ts` 发现 `TRACING_DRIVER=xray` 时做以下替换：
1. **ID 生成器**：`AWSXRayIdGenerator`（`@opentelemetry/id-generator-aws-xray`），trace ID 的前 8 位十六进制是秒级时间戳，与 ALB 注入的 `X-Amzn-Trace-Id`、Lambda 的追踪头格式天然兼容。自 2023 年 10 月起，X-Ray 也接受随机生成的 W3C trace ID（由 CloudWatch Agent 1.300030.0+ 或 ADOT Collector 0.34.0+ 转换格式；AWS What's New 2023-10-27，核实日期 2026-10-13），所以它不是硬性要求，而是推荐做法。
2. **传播器**：`CompositePropagator([AWSXRayPropagator, W3CTraceContextPropagator])`，能识别 ALB 注入的 `X-Amzn-Trace-Id`，也能与 W3C `traceparent` 互通。
3. **导出器**：OTLP/HTTP 发到 `${TRACING_OTLP_ENDPOINT}/v1/traces`（默认 `http://127.0.0.1:4318`，总纲 4.4 zod），由本机 CloudWatch Agent 的 traces 段接收后用实例角色转发给 X-Ray（也可以改用 ADOT Collector）。
4. **资源**：`@opentelemetry/resource-detector-aws` 的 EC2 检测器（使用 IMDSv2）给 span 标注实例 ID、可用区；`service.name` 为 `cloudalbum-api` 或 `cloudalbum-worker`。
5. **采样**：X-Ray 中央采样规则（`@opentelemetry/sampler-aws-xray` 的远程采样器，经 Agent 在 `127.0.0.1:2000` 提供的采样代理拉取规则），外面再包一层 `LabSampler`：
   - 请求带 `X-CloudAlbum-Trace: <令牌>` 时强制采样（RECORD_AND_SAMPLED）。令牌 = `HMAC-SHA256(CALLBACK_HMAC_KEY, "tracing-force:" + 当天日期)` 的前 16 位，只在管理员的 /lab 页面上显示，每天自动更换。采样决策发生在 JWT 校验之前，所以必须用令牌，而不能靠“是否管理员”。
   - 请求带 `X-Compare-Bypass: tracing`（总纲 8.3 的旁路键）时不记录（NOT_RECORD），路径头为 `tracing=xray:bypass` 且带 `bypass=tracing` 段。之后的 `bypassGuard` 中间件会对非管理员返回 403，所以这个头无法被滥用。
   - 其余请求交给 X-Ray 规则。
6. **本地 span 文件可以同时保留**（`TRACING_LOCAL_SPANS=on`），用来并排比较“本地能看到几段、X-Ray 能看到几段”。
7. **注解**：`photo_id`、`route`、`drivers`（如 `database=postgres@rds`）作为可检索的属性写入 span。OTel 属性默认进入 X-Ray 的 metadata（不建索引），要成为 annotation 需要在收集器侧配置索引属性（具体配置项以 CloudWatch Agent / ADOT 官方文档为准）。

**哪些环节能串成一条 trace**

| 链路 | 能否同一条 trace | 说明 |
|---|---|---|
| ALB → EC2 | 是（ALB 不是节点） | ALB 只注入 `X-Amzn-Trace-Id` 头，本身不产生 segment；传播器沿用这个 ID，trace 能和 ALB 访问日志对上 |
| CloudFront → EC2 | 否 | CloudFront 不参与 X-Ray |
| api → S3 / DynamoDB / SQS / SNS / SES / Rekognition / Secrets Manager / KMS | 是 | aws-sdk 插桩生成 client span，服务地图上出现对应的 AWS 服务节点 |
| api → S3 预签名 | 不产生 S3 节点 | 预签名是本地计算，没有网络调用；浏览器直传 S3 的 PUT 不在 trace 里 |
| api → PostgreSQL（自建或 RDS）、Redis（自建或 ElastiCache） | 是 | pg、ioredis 插桩生成 client span，X-Ray 显示为远端节点 |
| api → SQLite | 只有进程内 span | knex span，没有独立节点 |
| api → SQS → worker（`QUEUE_DRIVER=sqs`） | 是 | `JobEnvelope.traceparent`（W3C）随消息体传递，X-Ray 头另放在 SQS 系统属性 `AWSTraceHeader`（04#queue），worker 接着同一条 trace 继续 |
| 上传 → S3 → EventBridge → 缩略图 Lambda（`IMAGE_PROCESSOR=lambda`） | **否，是两条 trace** | 总纲决定 S3 事件统一经 EventBridge 路由，S3 事件不携带追踪上下文。Lambda 开启主动追踪后自己开始一条新 trace；它的 HMAC 回调请求携带追踪头，EC2 上的回调处理接着 **Lambda 的** trace。两条 trace 用注解 `photo_id` 关联 |
| scheduler=eventbridge 的 tick → worker | 每次运行一条新 trace | — |
| social-api：API Gateway HTTP API | 不支持 X-Ray | proxy 集成时 trace 从 EC2 开始；lambda 集成时从 Lambda（主动追踪）开始。只有 REST API 才能开启 stage 追踪 |

**CloudFormation：`infra/modules/tracing.yaml`**

| 资源 | 说明 |
|---|---|
| `DefaultSamplingRule` | `cloudalbum-<env>-default`：`ServiceName: cloudalbum-*`，每秒 1 个蓄水池名额 + 较低的固定比例（示例 5%，不代表性能数据） |
| `HealthSamplingRule` | `cloudalbum-<env>-health`：`URLPath: /api/health/*`，`FixedRate: 0`、`ReservoirSize: 0`，排除健康检查（ALB 每个目标、每个周期都会请求一次） |
| `XRayGroup` | `cloudalbum-<env>`：过滤表达式 `service("cloudalbum-api") OR service("cloudalbum-worker")`；可选开启 Insights（额外计费） |
| `AppPolicy` | 写（Agent 用实例角色写入）：`xray:PutTraceSegments`、`xray:PutTelemetryRecords`、`xray:GetSamplingRules`、`xray:GetSamplingTargets`、`xray:GetSamplingStatisticSummaries`；读（/lab 用）：`xray:BatchGetTraces`、`xray:GetTraceSummaries`、`xray:GetServiceGraph`、`xray:GetTraceGraph`。模板不写 `Roles` / `Users`，也不附加 `AWSXRayDaemonWriteAccess` 托管策略（D2，约定 5） |
| Outputs | `ModuleId`、`ModuleVersion`、`PolicyArn`、`EnvTracingDriver`（= `xray`）、`EnvTracingXrayGroup`、`InfoTraceMapUrl`。不使用 `Export` |

**CloudWatch Agent 片段：`infra/modules/tracing/cwagent.json`**

```json
{"traces":{"traces_collected":{
  "otlp":{"grpc_endpoint":"127.0.0.1:4317","http_endpoint":"127.0.0.1:4318"},
  "xray":{"bind_address":"127.0.0.1:2000","tcp_proxy":{"bind_address":"127.0.0.1:2000"}}}}}
```

（字段与默认端口以 CloudWatch Agent 官方文档为准；只监听本机地址，不对外暴露。）

**跨模块设置（`injects`，D2）**：image-processing 的 lambda 档要开启 Lambda 主动追踪（`TracingConfig: Active`，执行角色需要 X-Ray 写权限），workflow 的状态机要开启 `TracingConfiguration`。这些是被注入方栈的参数（默认 `PassThrough` / 关闭）：本模块在 registry 中声明 `injects: [{ target: image-processing, params: { Tracing: Active }, when: { TRACING_DRIVER: xray } }, …]`，`scripts/module` 在本模块启用（或被注入方后启用）时自动更新它们的栈，本模块禁用时改回默认值；不需要学员手工重新 enable 别的模块，也不直接改别人的资源。被注入方需要在自己的模板中声明 `Tracing` 参数（见修订记录“仍需配合”）。

**/lab 的变化**：xray 档下，瀑布图页面显示“在 X-Ray 中打开”链接（trace ID 已经是 `1-xxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx` 格式），并嵌入根据 `GetServiceGraph` 画出的简化服务地图（节点、错误率、平均延迟，结果缓存 60 秒）。`X-CloudAlbum-Path` 中的 `tracing` 段取值见第 3 节；对管理员，`Server-Timing` 还会追加 `tracing;desc="1-…"`（没有 `dur`）。

**替代方案（了解）**：X-Ray 也提供 OTLP 端点（`https://xray.<region>.amazonaws.com/v1/traces`），需要先开启 CloudWatch Transaction Search，span 以结构化日志形式进入 `aws/spans` 日志组，计费方式不同（以官方文档为准）。本项目用本机 Agent 转发，便于与 monitoring 共用 Agent。旧的 X-Ray SDK（`aws-xray-sdk-express`）和 X-Ray Daemon 已于 2026-02-25 进入维护模式（只修关键安全问题），2027-02-25 结束支持（X-Ray 开发者指南“X-Ray SDK and Daemon Support timeline”，核实日期 2026-10-13），本项目不使用。

```mermaid
sequenceDiagram
  participant B as 浏览器
  participant API as cloudalbum-api（EC2）
  participant PG as PostgreSQL（RDS）
  participant Q as SQS
  participant W as cloudalbum-worker
  participant AG as CloudWatch Agent（127.0.0.1:4318）
  participant XR as X-Ray
  B->>API: POST /api/photos/:id/complete（X-CloudAlbum-Trace: 令牌）
  Note over API: LabSampler 强制采样，trace 1-6710…
  API->>PG: UPDATE photos（client span）
  API->>Q: SendMessage（JobEnvelope.traceparent）
  API-->>B: 202（路径头中 tracing=xray:sampled）
  Q->>W: ReceiveMessage
  Note over W: extract(traceparent)，同一 trace 继续
  W->>PG: UPDATE photos SET status=READY
  API-)AG: OTLP span 批量导出
  W-)AG: OTLP span 批量导出
  AG-)XR: PutTraceSegments
```

### 3. 开关与配置

```bash
# /etc/cloudalbum/modules.d/tracing.env（root:cloudalbum 0640，数据卷上）
# xray 档由 scripts/module enable tracing 写入；local 档由 enable tracing --driver local 写入（不部署栈）；
# 文件不存在 = none
MODULE_TRACING=on                       # 仅 xray 档写这一行；local 是本地档，不写（CFG-004 由 localTiers 豁免）
MODULE_TRACING_VERSION=1
TRACING_DRIVER=xray                     # none | local | xray（第一个是本地实现）；Outputs.EnvTracingDriver
TRACING_LOCAL_RETENTION_DAYS=3          # 本地 span 文件保留天数（总纲 4.4 zod 的 local 分支）
TRACING_LOCAL_SPANS=on                  # xray 档是否同时写本地 span 文件（并排比较用）
TRACING_LOCAL_SAMPLE_RATIO=1.0          # local 档或本地文件的采样比例
TRACING_OTLP_ENDPOINT=http://127.0.0.1:4318   # 总纲 4.4 zod 的默认值；导出器在后面拼 /v1/traces
TRACING_SAMPLING_ENDPOINT=http://127.0.0.1:2000
TRACING_XRAY_GROUP=cloudalbum-lab       # Outputs.EnvTracingXrayGroup
```

- 强制采样令牌不是配置项，而是每天由 `CALLBACK_HMAC_KEY` 派生，不需要新增密钥。
- `X-CloudAlbum-Path` 的 `tracing` 段（值以驱动名开头，总纲 7.2）：`none` 档不出现；`local:recorded`、`local:not-sampled`；`xray:sampled`、`xray:not-sampled`、`xray:bypass`（同时带 `bypass=tracing` 段）。上一轮的 `unsampled` 写法统一改为 `not-sampled`。
- local 档的采样比例是启动配置（改 env 后重启）：RuntimeConfig 的键集合由总纲 4.2 固定（D7），不含它。xray 档以 X-Ray 中央采样规则为准，修改规则不需要重启。
- 本组另用的键 `TRACING_LOCAL_SPANS`、`TRACING_LOCAL_SAMPLE_RATIO`、`TRACING_SAMPLING_ENDPOINT`、`TRACING_XRAY_GROUP` 已由总纲 4.4 zod 的 `Tracing` 段收录（第 3 轮；都在 `TRACING_` 前缀内，不违反 `ownsEnv`）。

端口接口要点（写入侧就是总纲 4.2 的 TracerPort，驱动 `none` / `local` / `xray`；只读侧 TraceReader 按总纲注释“local 读 span 文件，xray 读 GetTraceSummaries”细化）：

```ts
// backend/src/ports/tracer.ts（追加部分）
export interface SpanRecord {
  traceId: string; spanId: string; parentId?: string; name: string; service: string;
  startMs: number; durMs: number; kind: string; status: 'ok' | 'error'; attrs: Record<string, unknown>;
}
export interface TraceReader {
  readonly backend: 'none' | 'local' | 'xray';
  localTrace(q: { traceId?: string; requestId?: string }): Promise<SpanRecord[]>;   // 读本地 span 文件
  recent(q: { minDurMs?: number; limit: number }): Promise<Array<{ traceId: string; root: string; durMs: number; error: boolean; at: string }>>;
  consoleLink?(traceId: string): string;                                            // 仅 xray
  serviceGraph?(range: { since: Date; until?: Date }): Promise<{
    nodes: Array<{ name: string; type: string; errorRate: number; avgMs: number }>;
    edges: Array<{ from: string; to: string; count: number }>;
  }>;                                                                               // 仅 xray，GetServiceGraph
}
```

预加载入口（SDK 在这里初始化；container 只包装全局 tracer）：

```ts
// backend/src/telemetry/register.ts（草图）
import { register } from 'node:module';
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);   // ESM 下的自动插桩钩子（import-in-the-middle），以 OTel JS 官方文档为准

const driver = process.env.TRACING_DRIVER ?? 'none';
if (driver !== 'none') {
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const processors = [];
  if (driver === 'local' || process.env.TRACING_LOCAL_SPANS !== 'off')
    processors.push(new BatchSpanProcessor(new FileSpanExporter('/var/lib/cloudalbum/logs/spans')));
  if (driver === 'xray')
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${process.env.TRACING_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318'}/v1/traces` })));
  const sdk = new NodeSDK({
    serviceName: process.env.CLOUDALBUM_ROLE === 'worker' ? 'cloudalbum-worker' : 'cloudalbum-api',
    spanProcessors: processors,
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
    sampler: new LabSampler(driver === 'xray'
      ? new AWSXRayRemoteSampler({ endpoint: process.env.TRACING_SAMPLING_ENDPOINT })
      : new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(Number(process.env.TRACING_LOCAL_SAMPLE_RATIO ?? 1)) })),
    ...(driver === 'xray' ? {
      idGenerator: new AWSXRayIdGenerator(),
      textMapPropagator: new CompositePropagator({ propagators: [new AWSXRayPropagator(), new W3CTraceContextPropagator()] }),
      resourceDetectors: [awsEc2DetectorSync],
    } : {}),
  });
  sdk.start();
  process.once('SIGTERM', () => sdk.shutdown());   // 退出前导出最后一批 span
}
```

如果后端编译为 CommonJS，改用 `--require` 预加载，不需要 `hook.mjs`。

### 4. 依赖与组合

**硬依赖**
- `local` 档：无 AWS 依赖、不需要凭证；只需要 systemd drop-in（预加载）。
- `xray` 档：凭证（`credentials: required`，CRED-001），且实际上要求 `IAM_CREDENTIALS=role`（Collector 用实例角色写 X-Ray；keys 模式下 Collector 拿不到凭证，约定 2）；本机收集器（CloudWatch Agent 的 traces 段，由本模块 `hostSetup` 安装、检查版本与投递；或 ADOT Collector）；实例能出站访问 `xray` 端点（私有子网需要 NAT 或 `xray` Interface Endpoint）；进程以 `--import` 预加载 OTel。

**与其他模块组合**
- **queue**：sync / memory 档下，worker 的处理在同一进程或同一台机器上，本地瀑布图就能看到；sqs 档下，追踪上下文随消息传递，服务地图上出现 SQS 节点。
- **image-processing**：lambda 档时由本模块的 `injects` 把 `Tracing: Active` 注入 image-processing 栈（Lambda 主动追踪），服务地图上出现 Lambda 节点，但它是**另一条 trace**（见上表），用 `photo_id` 注解关联；inline / worker 档没有这个节点。
- **workflow（06）**：`WORKFLOW_DRIVER=stepfunctions` 时同样经 `injects` 打开状态机的 X-Ray 追踪；状态机由 S3 → EventBridge 启动，与 Lambda 档一样是独立于上传请求的另一条 trace，用 `photo_id` 关联。
- **social-api**：API Gateway HTTP API 不支持 X-Ray（REST API 才支持）。
- **load-balancer**：ALB 注入 `X-Amzn-Trace-Id`，不作为节点出现；**cdn**：CloudFront 不参与 X-Ray。
- **database、cache、storage、social-store、tagging、secrets、kms**：对应的插桩把 RDS、Redis、S3、DynamoDB、Rekognition、Secrets Manager、KMS 显示为下游节点；SQLite 只以进程内 knex span 出现。
- **logging**：pino 的 mixin 把 `traceId`、`spanId` 写进每行日志；cloudwatch 档可以在 Logs Insights 中按 traceId 查日志，/lab 中能从 trace 跳到日志。
- **monitoring**：互补，见 monitoring 模块。与 monitoring、logging（agent 方式）共用一个 Agent 进程。
- **autoscaling**：本地 span 文件每台实例一份，/lab 只能看到处理当前请求的那台；X-Ray 天然汇总所有实例。
- **config（ssm）**：无耦合。local 档的采样比例是启动配置，不是 RuntimeConfig 热键（D7）；xray 档的“远程调采样”由 X-Ray 中央采样规则完成，不经过 ConfigPort。

### 5. 对比实验：有 vs 没有

| 维度 | 没有 X-Ray（基线：none 仅 Server-Timing；本地档 local 加 OTel 本地 span） | 有 X-Ray（xray） |
|---|---|---|
| 能看到的范围 | none：本进程内各端口的累计耗时；local：本机进程内的 span 树，经队列到同机 worker | 跨进程、跨实例、跨 AWS 服务 |
| 服务地图 | 无 | 有（节点、错误率、延迟） |
| 跨实例 | none 不适用；local 每台实例各一份 span 文件 | 自动汇总 |
| Lambda / AWS 服务段 | none 看不到；local 只看到本进程发出的 client span | 看到 AWS 服务节点；Lambda 有自己的 trace，按 `photo_id` 关联 |
| 检索 | none 按请求 ID 看单个响应头；local 扫描本地文件 | 过滤表达式、按注解检索、组 |
| 采样 | none 不适用；local 固定比例 | 中央采样规则，改规则不重启 |
| 开销 | none 最小；local 增加 span 创建与本地写文件 | span 创建 + OTLP 导出（异步批量） |
| 费用 | 无 AWS 费用 | 按记录和检索的 trace 数计费 |

**页面上能直接看到的差异**
- 同一次“上传照片”请求：
  - none：/lab/trace 的单跳瀑布图——`total`、`database`、`storage`、`app` 几段。
  - local：/lab/tracing 的 span 树——http → express → knex/pg → aws-sdk（如有）；`QUEUE_DRIVER=memory` 时还能看到 worker 的 span；Lambda 那一段是空白。
  - xray：X-Ray 控制台和 /lab 嵌入的服务地图显示 `client → cloudalbum-api → RDS / S3 / SQS → cloudalbum-worker`，每个节点带错误和故障比例；Lambda 缩略图在另一条 trace 中，可按 `photo_id` 找到。
- 响应头 `X-CloudAlbum-Path` 中的 `tracing` 段从缺省变为 `local:recorded`，再变为 `xray:sampled` / `xray:not-sampled`。
- 注入延迟故障后，服务地图上对应的节点变色。

**测量指标**
定位慢请求根因所需的步骤数和时间；能看到的跨进程、跨服务段数；追踪带来的额外延迟（p50 / p95）与 CPU；trace 发出后多久能在 X-Ray 中查到；每天记录的 trace 数（由采样规则决定，直接决定费用）。

**操作步骤**（`experiments/tracing/`）
1. 走查：`npm run exp -- tracing --label after --scenario walkthrough`。`walkthrough.ts` 以管理员身份、带强制采样令牌上传一张图片，打印 trace ID、本地瀑布图 URL 和 X-Ray 控制台 URL，并轮询 `xray:BatchGetTraces` 直到这条 trace 出现，记录出现耗时。
2. 找慢点：先 `POST /api/lab/faults {"type":"latency","target":"database","ms":300,"rate":0.3,"durationSec":600}`，然后 `npm run exp -- tracing --label <before|after> --scenario slow-hunt`。脚本分两轮输出线索：第一轮只用 `Server-Timing` 和本地瀑布图（none / local 档），第二轮用 X-Ray 服务地图和 `GetTraceSummaries`（过滤表达式 `responsetime > 0.3`），由实验者记录各自定位到“数据库慢”所需的步骤。
3. 开销（运行时 A/B）：`npm run exp -- tracing --label after --scenario overhead --ab`。k6 脚本 `overhead.k6.js` 在同一次压测中交替发送 A 组（带强制采样令牌，100% 记录并导出）和 B 组（带 `X-Compare-Bypass: tracing`，完全不记录），按标签分别统计 p50 / p95；同时从 `/api/lab/metrics` 读取 api 进程 CPU。再在 `TRACING_DRIVER=none` 下跑一次同样的负载（`--label before`），得到“完全没有 OTel”的基准。
4. 传播检查：`npm run exp -- tracing --label after --scenario propagation`。`QUEUE_DRIVER=sqs` 时验证 worker 的 span 与 api 的 span 属于同一个 trace ID；`IMAGE_PROCESSOR=lambda` 时验证会得到两条 trace，且两者都带同一个 `photo_id`。
5. 控制台：CloudWatch → X-Ray traces → Trace Map；用组 `cloudalbum-lab` 过滤。

**预期结果**
- 单个进程内的慢点，三种方式都能找到，`Server-Timing` 已足够做粗略定位。
- 链路一旦跨进程、跨 AWS 服务（SQS、S3 重试、DynamoDB 限流），只有 X-Ray 能把它们串成一条 trace 并在服务地图上汇总。
- 追踪带来的延迟开销相对请求本身很小，通常在亚毫秒到数毫秒量级（导出是异步批量的）；100% 采样时 CPU 略有上升。
- trace 要过几秒到几十秒才会出现在 X-Ray 中。
- CloudFront、ALB 不会以节点的形式出现；上传到缩略图就绪会是两条 trace。

**运行时 A/B 还是切换重启**：追踪开销可以在同一部署中运行时 A/B（强制采样 vs `X-Compare-Bypass: tracing`，仅管理员）；修改 X-Ray 采样规则不需要重启。`none`、`local`、`xray` 之间的切换需要改配置并重启（OTel 在进程启动时初始化），属于切换前 / 切换后测量。

### 6. 切换、数据迁移与回滚

**启用本地档**：`scripts/module enable tracing --driver local`（本地档：跳过部署栈、注入与授权，总纲 9.2 第 1 步；不需要 iam）：`hostSetup apply` 投放 systemd drop-in → 写入 `TRACING_DRIVER=local`（不写 `MODULE_TRACING=on`）→ `check-config` → `systemctl daemon-reload` → 重启 api 和 worker → 探针：发一个请求，确认本地 span 文件中出现对应的 traceId。也可以由档位 `l0-plus-local-tiers` 一并启用。

**启用 xray**：`scripts/module enable tracing`
1. 计划校验：CRED-001；`IAM_CREDENTIALS=keys` 时提示 Collector 无法取得凭证并要求改用 `role`（约定 2）；私有子网时由 DEP-009 的部署检查确认 `xray` 端点或 NAT。
2. 确认：提示按记录与检索的 trace 数计费。
3. 部署 `infra/modules/tracing.yaml`（采样规则、组、策略）。
4. 生成 env；处理本模块的 `injects`：已启用的 image-processing（lambda 档）、workflow 栈更新为 `Tracing=Active`。
5. 附加 `PolicyArn`（记入 state.json）。
6. 不迁移数据。
7. `hostSetup apply`：安装或复用 CloudWatch Agent（检查版本 ≥ 1.300030.0），`append-config` 投递 traces 片段，投放 systemd drop-in；原子写入 env。
8～9. `check-config`；`daemon-reload`，重启 api 和 worker。
10. 探针：带强制采样令牌发一个请求，轮询 `BatchGetTraces` 直到这条 trace 出现（秒级到数十秒）；同时检查本机 Collector 健康状态和导出错误计数（第 10 节）。

**迁移**：没有数据需要迁移；本地 span 文件保留 `TRACING_LOCAL_RETENTION_DAYS` 天，可随时对比。

**禁用**：`scripts/module disable tracing`：删除 env → `hostSetup revert`（删除 drop-in；`remove-config` 移除 traces 片段，没有其他片段时停止 Agent）→ `daemon-reload` → 重启（回到 none，进程不再加载 OTel）→ 撤销注入（image-processing、workflow 栈的 `Tracing` 改回默认值）→ 分离策略 → 删除栈（采样规则和组随之删除）。X-Ray 中已有的 trace 按保留期自然过期（30 天，以官方文档为准）。从 xray 退回 local 档：`scripts/module enable tracing --driver local`（先撤销 AWS 侧，再保留 drop-in）。

### 7. SAA 考点

- X-Ray 的基本概念：trace、segment、subsegment；annotation（建索引，可用于过滤表达式）与 metadata（不建索引）的区别；组（Group）。
- 采样规则：蓄水池 + 固定比例，集中修改，不需要重新部署。
- 服务地图（Trace Map）：定位延迟和错误发生在哪一段。
- Lambda 主动追踪；API Gateway REST API 的 stage 追踪（HTTP API 不支持）；SQS 的追踪头传播。
- ALB 和 CloudFront 不产生 X-Ray segment，ALB 只注入 `X-Amzn-Trace-Id`。
- X-Ray（链路追踪）、CloudWatch（指标和日志）、CloudTrail（API 审计）的区别。
- 采集方式：X-Ray Daemon（维护模式）、ADOT / OpenTelemetry、CloudWatch Agent；在 EC2 上需要实例角色有 X-Ray 写权限。

### 8. 费用与清理

- 按记录的 trace 数和检索、扫描的 trace 数计费，有免费额度；采样规则直接决定费用。CloudWatch Agent、ADOT 免费；X-Ray Insights、Transaction Search 另行计费。学习环境流量低，用默认采样时通常在免费额度量级。以官方定价为准。
- local 档没有 AWS 费用，只占少量磁盘（span 文件默认保留 3 天）。
- 清理：`scripts/module disable tracing`（Lambda 与状态机的主动追踪随注入撤销而关闭）；如开启过 X-Ray Insights 或 Transaction Search，在控制台关闭。

### 9. 常见坑

- OTel 必须在 express、pg 等模块加载之前初始化：用 `NODE_OPTIONS=--import` 预加载，不要在 `server.ts` 中途 import。后端如果是 ESM，还要注册 `import-in-the-middle` 钩子，否则自动插桩对 ESM 模块无效。
- ALB 的健康检查会产生大量无用的 trace，要用 `FixedRate=0` 的采样规则排除 `/api/health/*`。
- 以为能在 X-Ray 中看到 CloudFront → ALB → EC2 的链路——实际上 CloudFront 和 ALB 都不会出现（旧 labs.md Lab 10、新编号 Lab 22 的验收标准已按总纲附录 B 第 12 行修正）。
- 以为“上传 → 缩略图 Lambda”是一条 trace：S3 事件不携带追踪上下文，Lambda 会开始新的 trace，要靠注解关联。
- API Gateway HTTP API 不支持 X-Ray。
- 异步边界（队列、定时器、部分连接池回调）可能丢失 AsyncLocalStorage 上下文，导致 trace 断开；队列消息要显式 inject / extract。
- 用了随机 W3C trace ID 又用了旧版 Agent / Collector 时，X-Ray 可能拒收；用 `AWSXRayIdGenerator` 或升级收集器（版本要求以官方文档为准）。
- 100% 采样只适合实验：费用和开销都随流量线性增长。
- 强制采样头必须校验令牌，否则任何人都能让每个请求都被采样、抬高费用；trace ID 只在管理员的 `Server-Timing` 中返回。
- 不要再用 `aws-xray-sdk-express` 和 X-Ray Daemon：已进入维护模式。
- trace 要过几秒到几十秒才出现在控制台，实验脚本要轮询，不能发完请求就立刻查。
- span 属性里不能放密码、令牌、完整的预签名 URL；`redact.ts` 同样作用于 span 属性。
- 在 keys 模式下启用 xray 档：应用侧不报错，但 Collector 拿不到凭证，trace 永远不会出现；探针会报 `error`，按约定 2 改用 `role`。
- 手工改了 `cloudalbum-api.service` 的 `ExecStart` 来加 `--import`：违反 drop-in 约定，实例替换后丢失；只能用 `50-tracing.conf`。

### 10. 探针

与总纲 6.2 的 tracing 两行一致；`none` / `local` 档的结果记为 `localHealth`，`status=off`。

| 驱动 / 探针 | 方式 | `degraded` 判据 | `error` 判据 | 所需权限（在 `PolicyArn` 中） |
|---|---|---|---|---|
| `none`（本地） | 进程中没有加载 OTel（`GET /api/lab/self-check` 的模块清单） | — | 进程意外加载了 OTel（drop-in 残留） | — |
| `local`（本地，30 秒） | `logs/spans/` 可写；`BatchSpanProcessor` 最近一次导出时间与队列长度；drop-in 是否生效（`NODE_OPTIONS` 中有 `--import`） | 导出积压（队列接近上限、开始丢 span）；数据卷剩余 < 15% | 目录不可写；drop-in 未生效（进程里没有 OTel） | — |
| `xray` 常规（30 秒） | 本机 Collector 健康检查端点（127.0.0.1）+ OTLP 导出错误计数；Agent 版本（`hostSetup` 写入的版本号） | 导出错误率 > 1%；Agent 版本低于 1.300030.0；采样规则拉取失败（退回本地默认采样） | Collector 不可达；连续导出失败（keys 模式下的典型症状） | 由 Collector 用实例角色写入：`xray:PutTraceSegments`、`xray:PutTelemetryRecords`、`xray:GetSamplingRules`、`xray:GetSamplingTargets` |
| `xray` 深度（管理员或 enable 第 10 步） | 强制采样一个请求，轮询 `BatchGetTraces` 直到出现 | 超过 60 秒仍未出现 | 采样规则或组不存在 | `xray:BatchGetTraces`、`xray:GetTraceSummaries` |

### 11. 前端徽章

全局徽章来自 capabilities；请求级徽章来自该请求的 `X-CloudAlbum-Path` 中的 `tracing` 段。

| 位置 | 本地实现时（`none` / `local`） | AWS 实现时（`xray`） | 降级时 |
|---|---|---|---|
| `/lab/trace` 路径追踪抽屉（总纲 7.4） | `none`：单跳瀑布图（Server-Timing）；`local`：本机 span 树 · 数据来自 i-xxxx | 多出“在 X-Ray 中打开”链接与嵌入的服务地图 | 黄色“X-Ray 导出失败，仅显示本地 span” |
| 路径芯片（请求级） | `tracing=local:recorded`（灰） | `tracing=xray:sampled`（橙）；`xray:bypass`（紫） | — |
| `/lab` tracing 卡片 | 本地实现：Server-Timing（none）/ OTel 本地 span（local） | AWS 实现：X-Ray 服务地图，按 `photo_id` 关联 Lambda 的 trace | 文案后附“降级” |

```yaml
# registry.yaml：tracing.lab（summary 与 badges）
summary:
  local: "none：只有单跳 Server-Timing；本地档 local：OTel 记录本机 span 树（不需要 AWS）"
  aws: "同一套 OTel 插桩经本机 Collector 导出到 X-Ray：跨进程、跨 AWS 服务的 trace 与服务地图"
keyMetrics: ["定位慢请求根因所需步骤", "可见的跨进程 / 跨服务段数", "追踪开销 p50 / p95（强制采样 vs 旁路）"]
badges:
  local: { none: "链路：Server-Timing（单跳）", local: "链路：本机 span（OTel 本地档）" }
  aws: "链路：AWS X-Ray · 服务地图"
```

<a id="audit"></a>

## audit：AWS API 操作审计 ↔ AWS CloudTrail

> 一句话总结：没有 CloudTrail trail 时，审计只有应用内的 `audit_log` 表（谁在 CloudAlbum 里做了什么，带哈希链防篡改），外加 AWS 默认就有的 Event History（只读、90 天、只有管理事件、按区域查看）；启用后，多区域 trail 把管理事件（可选 S3 数据事件）长期投递到专用 S3 桶，带日志文件完整性校验，还可以投递到 CloudWatch Logs 做告警。两层审计是互补关系：应用审计知道“哪个最终用户”，CloudTrail 知道“哪个 AWS 身份”。最直观的区别：在“谁删了这张照片”实验中，基线只能看到“alice 通过 API 删除了 photo 123”，运维用 CLI 直接删掉的对象无迹可寻；启用 trail + S3 数据事件后，几分钟后就能在 CloudTrail 中查到这次 `DeleteObject` 和调用者身份。

### 0. 元数据（registry 摘录）

```yaml
# modules/registry.yaml 中 audit 的条目（摘录；不一致时以 registry 为准，并同步本节）
audit:
  group: E
  function: AWS API 操作审计
  awsService: AWS CloudTrail
  auxServices: [Amazon S3（模块自带日志桶）]
  type: infra                            # 无端口；感知器 + 只读读取器
  detector: detectors/audit.ts           # 读取器 detectors/audit-reader.ts
  switch: { var: AUDIT_MODE, values: [app, cloudtrail], ownedValues: [cloudtrail], localTiers: [] }
  ownsEnv: [CLOUDTRAIL_]                 # AUDIT_RETENTION_DAYS、AUDIT_HASH_CHAIN 是 L0 核心配置，不属于本模块
  credentials: optional                  # trail 由部署者身份创建、照常记录；应用只在展示时调用 cloudtrail 只读 API（缺凭证 → CRED-004）
  prerequisites: []
  requires: []                           # S3 数据事件需要 storage=s3 才有桶可选，但桶名由 storage 注入，不构成硬依赖
  soft: [storage, monitoring, logging, kms]
  conflicts: []
  authoritative: false
  bypass: []
  preflight: [existing-trail, policy-quota]   # 已有多区域 / 组织 trail 时默认只读接入（CreateTrail=false）
  stacks: [{ name: main, template: infra/modules/audit.yaml }]
  # 本栈接收的注入（都可选，默认 ''）：DataEventBuckets（storage）、AlarmTopicArn（monitoring）、KmsKeyArn（kms）。本模块不向其他栈注入
  probe: { kind: detector, intervalSec: 60 }
  billing:
    - { resource: "CloudTrail 额外副本的管理事件与数据事件", dimension: usage }
    - { resource: "trail 日志桶的存储与请求；可选的 CloudWatch Logs 投递", dimension: usage }
  lab: { compare: functional, hourlyBilled: false, experiments: [who-deleted, validate-logs, chain-tamper] }   # 文案见第 11 节
  doc: docs/modules/05-ops-observability.md#audit
```

- 类型 I：声明型开关 `AUDIT_MODE=app|cloudtrail`，`app`（应用审计表 + 有凭证时只读 Event History）是本地实现；只有 `cloudtrail` 时写 `MODULE_AUDIT=on`。只读接入已有 trail 也是 `cloudtrail`（栈只含只读策略，`CLOUDTRAIL_MANAGED=false`）。
- 应用审计表 `audit_log`（X22）是 L0 核心机能，不随本模块启停；本模块只决定“AWS 层的审计记录在哪里、保留多久、能否验证完整性”。

### 1. 基线实现（仅 EC2）

**应用审计表 `audit_log`**（总纲 §2.8 X22；Knex 迁移，SQLite 与 PostgreSQL 都可执行）
- 只允许追加：
  - SQLite：`BEFORE UPDATE` 触发器一律拒绝；`BEFORE DELETE` 触发器只允许删除超过保留期的行（见第 3 节 DDL）。保留天数写在触发器里，修改 `AUDIT_RETENTION_DAYS` 时由迁移重建触发器。
  - PostgreSQL：同样的触发器；如果 database 模块使用独立的迁移账号，再对应用账号 `REVOKE UPDATE, DELETE`（应用账号就是表的所有者时，它可以删掉触发器——这正是下面“哈希链只能发现、不能防止”的原因）。
- 哈希链：每行保存 `prev_hash` 和 `hash = sha256(prev_hash || 规范化 JSON(本行业务字段))`。写入在一个事务中“读最后一行的 hash → 插入新行”：SQLite 天然单写者；PostgreSQL 用 `pg_advisory_xact_lock` 串行化。`GET /api/admin/audit/verify` 从头校验整条链，返回第一处断点。
- 写入点：`backend/src/services/audit.ts` 提供 `audit.record(action, target, result, details)`，由路由和管理操作显式调用；中间件自动补全 `actor_type`、`actor_id`、`actor_email`、`source_ip`（Nginx realip 解析后经 `X-Forwarded-For` 传入，Express `trust proxy=loopback`）、`user_agent`、`request_id`、`trace_id`，以及 `aws_principal`——本次请求中应用调用 AWS 时使用的身份（`AwsCredentialsPort.describe()` 的缓存值，例如 `assumed-role/CloudAlbumAppRole/i-0abc…`；`IAM_CREDENTIALS=none` 的 L0 为空）。
- 覆盖的事件：用户（`user.register`、`user.login`、`user.login_failed`、`user.logout`、`user.password_reset`、`user.mfa_enabled`）；相册与照片（`album.create/update/delete`、`photo.upload_requested`、`photo.upload_completed`、`photo.delete`、`photo.blocked`）；分享与评论（`share.create/revoke`、`comment.create/delete`）；管理（`admin.user.disable`、`admin.user.role_change`、`config.change`）；实验（`lab.bypass`——总纲 §8.3 要求每个旁路请求入审计、`lab.fault`）；模块启停（`module.enable`、`module.disable`，由 `scripts/module` 经投递通道调用 `node dist/cli.js audit:record` 写入）。
- 文件镜像：每条记录同时以 `source=audit` 写入 `/var/lib/cloudalbum/logs/audit.log`（总纲 §2.4），logging 启用后随之进入 CloudWatch Logs。这个文件参与 logrotate，所以**不**加 `chattr +a`（追加属性会让 logrotate 无法改名）。
- 保留期：定时任务 `audit.retention`（每日，经 SchedulerPort；总纲 4.2 的 8 个 `ScheduledJobName` 之一）删除超过 `AUDIT_RETENTION_DAYS` 的行。
- 页面 `/admin/audit`：“应用审计”页签按 actor、action、target、时间过滤，可导出 CSV；顶部显示哈希链校验结果。

**AWS Event History（只读，不属于本模块，但在基线中展示）**
- 只要 `IAM_CREDENTIALS≠none`（iam 栈的 `PolicyArn` 已包含 `cloudtrail:LookupEvents`，02#iam），`/admin/audit` 的“AWS 事件”页签就调用 `LookupEvents` 读取默认的 Event History，并标注“仅管理事件 · 90 天 · 仅本区域（IAM、STS 等全局服务事件在 us-east-1）”。`LookupEvents` 每个账号每个区域每秒只能调用约 2 次（以官方文档为准），所以结果缓存 60 秒并带退避。
- 纯 L0（`IAM_CREDENTIALS=none`）时这个页签隐藏，并说明原因。

**感知器** `backend/src/modules/detectors/audit.ts`：`AUDIT_MODE=app` 时 `status=off`，`localHealth` = 哈希链最近一次校验结果 + 表可写（判据见第 10 节）。

**局限**：看不到绕过应用的操作（运维用 CLI、控制台直接改 AWS 资源）；拥有 root 或数据库所有者权限的人可以把整条链重算一遍；Event History 没有数据事件、只有 90 天、要逐个区域查看。

### 2. AWS 实现

**先检查已有 trail**（preflight `existing-trail`）。账号里可能已有多区域 trail（旧 labs.md Lab 0 第 4 步、组织 trail、以前的练习）；同一区域的第二份管理事件副本是**收费**的。`scripts/module enable audit` 先执行 `aws cloudtrail describe-trails --include-shadow-trails`：
- 已有多区域 trail 或组织 trail：默认进入**只读接入**模式（模板参数 `CreateTrail=false`：不建桶、不建 trail，只创建应用只读策略并输出已有 trail 的信息；给已有 trail 加 CloudWatch Logs 投递属于修改别人的资源，本模块不做，需要时由该 trail 的所有者配置）。env 写 `CLOUDTRAIL_MANAGED=false` 和已有 trail 的 ARN、桶名。只要它正在记录，状态就是 `ok`（`detail` 标注“外部 trail”）。外部 trail 记为 state.json 中的“只读接入”带外资源，disable 时不动它（总纲 9.2“谁创建谁清理”）。
- 没有：创建本模块的 trail。

**CloudFormation：`infra/modules/audit.yaml`**

| 资源 | 说明 |
|---|---|
| `TrailBucket` `cloudalbum-<env>-trail-<acct>-<region>` | 阻止公有访问；`ObjectOwnership: BucketOwnerEnforced`；默认加密 SSE-S3，参数 `KmsKeyArn`（kms 注入）非空时 SSE-KMS；开启版本控制；生命周期：只设过期（例如 365 天）和旧版本过期，**不做存储类别转换**（CloudTrail 日志文件都很小，Standard-IA 等类别有最小计费对象大小和最短存储期，转换后反而更贵，以官方文档为准）；可选对象锁（参数 `ObjectLockDays`，治理模式，学习环境保留期设短）；`DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` |
| `TrailBucketPolicy` | 按官方模板：`cloudtrail.amazonaws.com` 的 `s3:GetBucketAcl`（桶）与 `s3:PutObject`（`AWSLogs/<acct>/*`，条件 `s3:x-amz-acl = bucket-owner-full-control` 且 `aws:SourceArn = <trail ARN>`）；另加拒绝非 TLS 访问 |
| `Trail` `cloudalbum-<env>-trail` | `IsMultiRegionTrail: true`、`IncludeGlobalServiceEvents: true`、`EnableLogFileValidation: true`、`IsLogging: true`；`DependsOn: TrailBucketPolicy`；`AdvancedEventSelectors` 见下 |
| 事件选择器 | ① 管理事件（读和写）；参数 `ExcludeKmsEvents`（默认 false，因为 kms 模块的实验要看 KMS 调用）为 true 时加 `eventSource NotEquals kms.amazonaws.com`。② 参数 `DataEventBuckets`（由 storage 的 `injects` 注入原图桶、媒体桶名，默认 `''`）非空时追加 S3 数据事件：`resources.type = AWS::S3::Object`、`resources.ARN StartsWith arn:aws:s3:::<桶>/`，默认只记录写事件（`readOnly = false`）——媒体桶会被 CloudFront 大量读取，记录读事件费用很高。**绝不能**把 trail 日志桶自己选为数据事件来源 |
| CloudWatch Logs 投递（参数 `DeliverToLogs=true`） | 日志组 `/cloudalbum/<env>/cloudtrail`（保留期参数化，Retain）+ 供 `cloudtrail.amazonaws.com` 承担的投递角色（`logs:CreateLogStream`、`logs:PutLogEvents`）；指标过滤器（命名空间 `CloudAlbum/Audit`）：root 账号使用、安全组变更、IAM 策略变更、`AccessDenied` / `UnauthorizedOperation` 激增、CloudTrail 配置变更 |
| 告警（可选） | 参数 `AlarmTopicArn`（由 monitoring 的 `injects` 注入 ops-alarms 主题 ARN，默认 `''`）非空时，对上述指标创建告警；为空则只有指标 |
| `AppPolicy` | 只读：`cloudtrail:LookupEvents`、`cloudtrail:DescribeTrails`、`cloudtrail:GetTrailStatus`、`cloudtrail:GetEventSelectors`；投递了 CloudWatch Logs 时加 `logs:StartQuery`、`logs:FilterLogEvents`（限定该日志组）与 `logs:GetQueryResults`。模板不写 `Roles` / `Users`（D2）；投递角色是 CloudTrail 服务承担的服务角色，属于本栈自己的资源 |
| 参数 | `Env`、`ModuleVersion`、`CreateTrail`（preflight 决定）、`ExcludeKmsEvents`、`DeliverToLogs`、`ObjectLockDays`，以及由提供方注入的 `DataEventBuckets`、`AlarmTopicArn`、`KmsKeyArn` |
| Outputs | `ModuleId`、`ModuleVersion`、`PolicyArn`、`EnvAuditMode`（= `cloudtrail`）、`EnvCloudtrailTrailArn`、`EnvCloudtrailBucket`、`EnvCloudtrailLogGroup`、`EnvCloudtrailManaged`、`InfoEventHistoryUrl`。不使用 `Export` |

可选：CloudTrail Insights（`ApiCallRateInsight`、`ApiErrorRateInsight`，额外计费）；用 Athena 建 CloudTrail 表做长期查询（可以与 analytics 模块共用工作组）；CloudTrail Lake 只作了解。

**应用侧（不改业务逻辑）**
- 感知器 `detectors/audit.ts`：`GetTrailStatus` 与 `GetEventSelectors`，判据见第 10 节。
- 读取器放在 `backend/src/modules/detectors/audit-reader.ts`（总纲原则 6：AWS SDK 只允许出现在适配器和感知器目录）：Event History 用 `LookupEvents`；投递了 CloudWatch Logs 时，数据事件用 Logs Insights 查询（`filter eventSource = "s3.amazonaws.com" and eventName = "DeleteObject"`）。
- **关联视图**：`/admin/audit` 的第三个页签把应用审计行与 CloudTrail 事件按 `request_id`、对象 key 和时间窗对齐。为此，`backend/src/adapters/aws/clients.ts` 给所有 SDK 客户端加一个 build 阶段的中间件，从 AsyncLocalStorage 取当前请求 ID，把 `cloudalbum/<requestId>` 追加到 User-Agent；CloudTrail 事件的 `userAgent` 字段会把它记录下来。浏览器凭预签名 URL 直接访问 S3 时，UA 是浏览器的，只能按对象 key 和时间窗关联。

```mermaid
flowchart LR
  U[最终用户 alice] -->|DELETE /api/photos/123| APP[Express]
  APP -->|audit.record| AT[(audit_log：alice 删除 photo 123 · request_id=r1)]
  APP -->|DeleteObject · UA 含 cloudalbum/r1| S3[(S3 raw 桶)]
  OPS[运维者 CLI / 控制台] -->|DeleteObject / AuthorizeSecurityGroupIngress| AWS[AWS API]
  S3 -->|数据事件| CT[(CloudTrail trail → S3 日志桶)]
  AWS -->|管理事件| CT
  AT <-.->|request_id / 对象 key / 时间窗| CT
  CT -.可选.-> CWL[(CloudWatch Logs)] --> MF[指标过滤器 → 告警]
```

### 3. 开关与配置

```bash
# /etc/cloudalbum/modules.d/audit.env（root:cloudalbum 0640，数据卷上；启用时由 scripts/module 写入；
# 不存在 = AUDIT_MODE=app：只有应用审计 + 有凭证时的 Event History）
MODULE_AUDIT=on                            # 只在 AUDIT_MODE=cloudtrail 时写入（CFG-004）
MODULE_AUDIT_VERSION=1
AUDIT_MODE=cloudtrail                      # app | cloudtrail（第一个是本地实现）；Outputs.EnvAuditMode
CLOUDTRAIL_MANAGED=true                    # false = 复用账号已有的 trail（只读接入）
CLOUDTRAIL_TRAIL_ARN=arn:aws:cloudtrail:ap-northeast-1:<acct>:trail/cloudalbum-lab-trail
CLOUDTRAIL_BUCKET=cloudalbum-lab-trail-<acct>-ap-northeast-1
CLOUDTRAIL_LOG_GROUP=/cloudalbum/lab/cloudtrail   # 可选，DeliverToLogs=true 时才有
```

应用审计属于 L0 核心机能，配置不属于本模块的 `ownsEnv`：默认值写在 Core zod 中（`AUDIT_RETENTION_DAYS=365`、`AUDIT_HASH_CHAIN=on`），一般不需要写进任何文件；确需修改时写在基础配置 `/etc/cloudalbum/cloudalbum.env`（总纲 4.4 第 1 层）。这两个键目前还没有出现在总纲 4.4 的 Core 段，需要总纲补上（见修订记录“仍需配合”）。

```bash
# /etc/cloudalbum/cloudalbum.env（只在需要覆盖默认值时添加）
AUDIT_RETENTION_DAYS=365
AUDIT_HASH_CHAIN=on
```

`audit_log` 的 SQLite DDL（Knex 迁移生成；PostgreSQL 版本用 `BIGSERIAL` 和 plpgsql 触发器）：

```sql
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,              -- ISO 8601 UTC
  actor_type    TEXT NOT NULL,              -- user | admin | system | anonymous
  actor_id      TEXT, actor_email TEXT,
  action        TEXT NOT NULL,              -- photo.delete、user.login_failed、module.enable ...
  target_type   TEXT, target_id TEXT,
  result        TEXT NOT NULL,              -- success | denied | error
  source_ip     TEXT, user_agent TEXT, request_id TEXT, trace_id TEXT,
  aws_principal TEXT,                       -- 应用这次调用 AWS 时使用的身份，用来和 CloudTrail 对照
  details       TEXT,                       -- JSON；不得含密码、令牌、完整预签名 URL
  prev_hash     TEXT,
  hash          TEXT NOT NULL
);
CREATE INDEX audit_log_ts ON audit_log(ts);
CREATE INDEX audit_log_actor ON audit_log(actor_id, ts);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_early_delete BEFORE DELETE ON audit_log
WHEN OLD.ts > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-365 days')   -- 由迁移按 AUDIT_RETENTION_DAYS 生成
BEGIN SELECT RAISE(ABORT, 'audit_log row within retention'); END;
```

本模块是纯基础设施型，应用侧没有端口和驱动，只有感知器与读取器；env 中没有机密类键（CFG-002）；不出现在 `X-CloudAlbum-Path` 中。

### 4. 依赖与组合

**硬依赖**
- 无模块级硬依赖。trail 由部署者身份创建（需要创建 trail、S3 桶和桶策略的权限，应用角色不需要这些权限），即使应用没有 AWS 凭证，trail 也照常记录。
- 应用侧展示（感知器、关联视图）需要 `IAM_CREDENTIALS≠none`（`credentials: optional`：缺凭证时 CRED-004，感知器降为 `inferred`，“AWS 事件”页签隐藏）和第 2 节列出的只读权限。
- 使用 SSE-KMS 时需要 kms 模块（注入 `KmsKeyArn`）：密钥策略要允许 `cloudtrail.amazonaws.com` 加密（带 `aws:SourceArn` 条件），并允许读取者解密。
- 开启 S3 数据事件的前提是 storage=s3（否则没有业务桶可选）：桶名由 storage 的 `injects` 写入本栈的 `DataEventBuckets`，本模块不读取 storage 的状态（D2）。
- 投递到 CloudWatch Logs 需要本栈创建的投递角色；对这些指标告警需要 monitoring 注入的告警主题（软依赖）。

**与其他模块组合**
- **iam**：凭证方式直接改变 CloudTrail 中的身份：keys 模式显示为 `IAMUser cloudalbum-…`（AKIA）；role 模式显示为 `AssumedRole CloudAlbumAppRole/i-0abc…`（ASIA，会话名是实例 ID）。访问密钥被盗用时，只有 CloudTrail 能看出“同一把钥匙在从陌生 IP 调用 API”。
- **storage**：开启 raw / media 桶的写数据事件后，浏览器通过预签名 URL 上传的 `PutObject` 也会被记录，身份是签发 URL 的那个角色。storage 作为提供方声明 `injects: [{ target: audit, params: { DataEventBuckets: … } }]`，storage 启用或禁用时 `scripts/module` 自动更新本栈，不需要重新 enable audit。
- **identity-pool**：浏览器直接用临时凭证上传时，CloudTrail 中的身份是 Identity Pool 已认证角色的会话（可追溯到 Cognito identity ID），这是唯一能在 AWS 层看到“最终用户”的场景。
- **auth（cognito）**：Cognito 用户池的 API 调用（包括 `SignUp`、`InitiateAuth` 等由终端用户触发的调用）会作为管理事件进入 CloudTrail，敏感字段会被隐去（以官方文档为准）；应用审计表照样记录 `user.login`，两者可以对照。
- **logging、monitoring**：trail 投递到 `/cloudalbum/<env>/cloudtrail` 后，在其上建指标过滤器并告警（root 登录、安全组变更、IAM 策略变更、AccessDenied 激增），即 CIS 基准中的做法。
- **threat-detection**：GuardDuty 独立读取 CloudTrail 管理事件，**不需要**本模块的 trail。两者互补：trail 负责留存和取证，GuardDuty 负责检测。
- **shell-access**：`StartSession` 等事件进入 CloudTrail；会话中执行的命令在会话日志里。
- **kms**：KMS 的 `Decrypt`、`GenerateDataKey` 是管理事件（读），数量可能很大；`ExcludeKmsEvents=true` 可降噪，但 Event History 不受 trail 选择器影响，kms 模块的实验照样能查。
- **analytics**：可以用同一个 Athena 工作组查询 trail 日志。
- **database、autoscaling**：应用审计表随 `DB_DRIVER` 存放；多实例必须是 postgres，哈希链用 advisory lock 串行写入。
- **backup**：审计表随数据库一起备份；trail 桶有版本控制，可加对象锁。
- **compliance（06）**：AWS Config 托管规则 `cloudtrail-enabled` 检查账号是否有正在记录的 trail；本地自检器在 `AUDIT_MODE=app` 时把这一项判为“不合规（只有 Event History）”。两者都只读，不修改 trail。

### 5. 对比实验：有 vs 没有

| 维度 | 没有 CloudTrail trail（基线：应用审计 + Event History） | 有 CloudTrail trail |
|---|---|---|
| 应用内操作（谁是最终用户） | 应用审计表能回答 | 应用审计表仍是唯一来源（CloudTrail 只知道 AWS 身份） |
| 绕过应用的 AWS 操作 | 只有 Event History 中的管理事件 | 管理事件 + 可选数据事件，全部长期留存 |
| S3 对象级操作 | 看不到 | 开启数据事件后可见 |
| 保留期 | Event History 90 天 | 由日志桶生命周期决定 |
| 区域 | Event History 按区域查看，全局服务在 us-east-1 | 多区域 trail 汇总到一个桶 |
| 完整性 | 应用表有哈希链（能发现，防不住 root 重写） | 日志文件完整性验证（digest 文件）+ 可选对象锁 |
| 告警 | 无 | 投递到 CloudWatch Logs 后用指标过滤器告警 |
| 查询 | `LookupEvents`（过滤条件有限、调用频率低） | Logs Insights、Athena、CloudTrail Lake |
| 费用 | 免费 | 第一份管理事件免费；数据事件、额外副本、S3 存储、CloudWatch Logs 摄取收费 |

**页面上能直接看到的差异**
- `/admin/audit` 三个页签：“应用审计”两种模式都有；“AWS 事件”基线下来自 Event History（标注“仅管理事件 · 90 天 · 本区域”），启用后改读 trail（标注“多区域 · 含 S3 写数据事件 · 保留期由桶决定 · 完整性已验证”）；“关联视图”把两边的记录对齐显示。
- /lab 的 audit 卡片：trail 状态（`IsLogging`、`LatestDeliveryTime`）、数据事件桶列表、最近一次 `validate-logs` 的结果；外部 trail 时显示“复用已有 trail”。

**测量指标**
每个场景下的可追溯性（能否回答“谁”“做了什么”“从哪里”）；事件多久之后能查到（Event History、trail 的 S3 投递、CloudWatch Logs 投递）；保留期；完整性验证结果（篡改后能否被发现）；数据事件条数（费用驱动因素）。

**操作步骤**（`experiments/audit/`，启用 trail 前后各跑一次）
1. “谁删了这张照片”：`npm run exp -- audit --label <before|after> --scenario who-deleted`。`who-deleted.ts` 依次执行四个场景并记录时间点：
   1) 以测试用户 alice 的身份调用 `DELETE /api/photos/:id`；
   2) 以运维者身份执行 `aws s3 rm s3://<raw 桶>/<key>`（storage=s3 时；storage=local 时改为删除一条无害的 SSM 参数或给日志桶打标签，作为“绕过应用的 AWS 操作”）；
   3) `aws ec2 authorize-security-group-ingress` 加一条无害规则，随后 `revoke`；
   4) 临时从 `CloudAlbumAppRole` 上分离 storage 模块的 `PolicyArn`，触发一次上传制造 AccessDenied，然后重新附加（对应 saa-coverage.md 故障演练第 12 项）；结束后 iam 的深度探针会把实际附加的策略与 state.json 的附加记录比对，确认已恢复。
   之后每分钟查询一次两侧，直到超时（20 分钟）：`GET /api/admin/audit?since=...`；`aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AuthorizeSecurityGroupIngress`（经 `experiments/_lib/cloudtrail.ts`）；trail 模式下再用 Logs Insights 查 `DeleteObject`（或用 Athena）。输出“场景 × 来源”的可追溯矩阵和首次可见时间。
2. 日志完整性：`npm run exp -- audit --label after --scenario validate-logs`。脚本执行 `aws cloudtrail validate-logs --trail-arn <arn> --start-time <1 小时前>`；然后把某个日志对象**复制到一个测试前缀**、修改内容，再对测试副本做同样的 digest 校验演示（不篡改真正的日志）。
3. 哈希链篡改：在实例上执行 `faults/tamper-audit.sh`：停服务 → 用 `sqlite3` 删除 `audit_log_no_update` 触发器并修改一行 → 恢复触发器 → 启动服务；随后调用 `GET /api/admin/audit/verify`，应报告断点位置。再演示“重算整条链”也能骗过校验，说明为什么需要外部不可变存储。

**预期结果**
- 应用审计能回答“是哪个最终用户”，但看不到绕过应用的操作；CloudTrail 只看到 AWS 身份（应用角色或运维者），看不到最终用户。两者互补，关联视图通过 request_id、对象 key 或时间窗把它们拼在一起。
- Event History 能看到安全组变更和 AccessDenied 这类管理事件，但看不到 S3 对象级操作，而且只保留 90 天；IAM 等全局服务的事件要到 us-east-1 去查。
- trail 投递一般有分钟级延迟（官方说法是平均约 5 分钟，不保证）。
- `validate-logs` 能发现被修改或删除的日志文件。
- 本地哈希链能发现被修改的行，但拥有 root 或数据库所有者权限的人可以重写整条链——这说明审计日志为什么要放在应用之外（S3 + 对象锁）。

**运行时 A/B 还是切换重启**：两层审计本来就同时存在，不需要请求级 A/B。同一个场景脚本在启用 trail 前后各跑一次，比较哪些事件能查到、能保留多久、能否验证完整性（功能对比）。

### 6. 切换、数据迁移与回滚

**启用**：`scripts/module enable audit [--param DeliverToLogs=true] [--param ObjectLockDays=1]`
1. 计划校验与 preflight `existing-trail`：`describe-trails` 检查已有 trail，有多区域或组织 trail 时询问是否复用（默认复用，`CreateTrail=false`，记入 state.json 的只读接入清单）；`IAM_CREDENTIALS=none` 时提示 CRED-004（trail 照常创建，只是应用侧看不到）。
2. 确认：提示数据事件与额外副本按事件数计费。
3. 部署 `infra/modules/audit.yaml`：先建桶和桶策略，再建 trail（`DependsOn`）。参数中的 `DataEventBuckets`、`AlarmTopicArn`、`KmsKeyArn` 由已启用的 storage、monitoring、kms 的注入值提供（没有就为空）——本模块不读取它们的状态。
4～5. 生成 env（`MODULE_AUDIT=on`、`AUDIT_MODE=cloudtrail`、`CLOUDTRAIL_*`）；附加 `PolicyArn`（记入 state.json）。
6. 不迁移数据。
7～9. 原子写入 `modules.d/audit.env`；`check-config`；重启 api（只影响感知器与读取器）。
10. 探针：`GetTrailStatus` 返回 `IsLogging=true`；执行一个无害的写操作（给日志桶打一个标签），等待 `LatestDeliveryTime` 更新（几分钟，第 10 节）。

**迁移**：应用审计表不受影响，不需要迁移。trail 只记录启用之后的事件；启用之前的管理事件只能在 90 天内通过 Event History 查到。

**禁用**：`scripts/module disable audit`：删除 env（`AUDIT_MODE` 回到 `app`）→ 重启 → 分离策略 → 删除栈（trail 随之删除；只读接入模式下只删除本栈创建的附加资源，不动已有 trail）。本模块不向其他栈注入，所以没有需要撤销的注入。日志桶和日志组因 `DeletionPolicy: Retain` 保留；开启了对象锁的对象在保留期内无法删除。`/admin/audit` 的“AWS 事件”页签回到 Event History。

### 7. SAA 考点

- CloudTrail Event History（默认开启、90 天、仅管理事件）与 trail（长期留存、可多区域、可组织级）的区别。
- 管理事件、数据事件（S3 对象级、Lambda Invoke、DynamoDB 条目级等）、Insights 事件的区别；读事件与写事件。
- 保护审计日志：日志文件完整性验证（digest 文件）、SSE-KMS、S3 对象锁（现在也可以在已有桶上开启，开启后不可关闭）、MFA Delete、单独的日志账号。
- trail 投递到 CloudWatch Logs，再用指标过滤器和告警监控敏感 API（root 登录、安全组变更）。
- 用 Athena 查询 CloudTrail 日志；CloudTrail Lake。
- CloudTrail（谁调用了 API）、AWS Config（资源配置随时间的变化与合规）、CloudWatch（性能）的区别。
- 排查 AccessDenied：在 CloudTrail 中查看 `errorCode` 与调用者身份。
- 组织 trail（Organizations）：集中审计多个账号。
- 全局服务（IAM、STS、CloudFront）的事件记录在 us-east-1。

### 8. 费用与清理

- Event History 免费。每个区域第一份管理事件的 trail 投递免费；额外的副本（例如账号中已有的 trail + 本模块的 trail）和数据事件按事件数计费，上传量大时 S3 数据事件可能成为主要费用。另有 S3 存储和请求费；投递到 CloudWatch Logs 要付摄取费；Insights 事件和 CloudTrail Lake 另行计费。应用审计表没有 AWS 费用。以官方定价为准。
- 清理：`scripts/module disable audit`；确实不需要日志时再 `--purge`（对象锁保留期内删不掉，学习环境不要设长保留期）；确认没有留下第二个收费的 trail。

### 9. 常见坑

- 以为没建 trail 就没有审计记录：Event History 默认就有，只是只包含管理事件、只保留 90 天、只能看当前区域。
- 重复建 trail：账号里可能已经有多区域 trail（旧 labs.md Lab 0、组织 trail、以前的练习），再建一个就是收费的第二份副本；preflight `existing-trail` 默认只读接入。
- S3 数据事件不在 Event History 中，必须建 trail 并显式选择。
- 绝不能把 trail 日志桶自己选为数据事件来源，否则写日志又产生新的日志，费用失控；媒体桶只记录写事件。
- 桶策略必须先于 trail 存在（CloudFormation 中用 `DependsOn`），并按官方模板加 `aws:SourceArn` 条件。
- trail 投递有分钟级延迟，实验时不要立刻去查。
- `LookupEvents` 的调用频率限制很低，`/admin/audit` 必须缓存并退避。
- 在东京区域的 Event History 里找不到 IAM 的 `CreateUser`——全局服务事件在 us-east-1。
- CloudTrail 日志文件很小，给它们配“转 Standard-IA”的生命周期规则反而更贵。
- 对象锁开启后不可关闭，合规模式下连 root 都删不掉；学习环境用治理模式和短保留期。
- 应用审计表的哈希链只能发现篡改，防不住拥有 root 或表所有者权限的人整体重写，需要外部不可变存储兜底。
- 多实例并发写入时哈希链会冲突，要用 advisory lock 串行化，或者每个实例维护一条单独的链。
- 审计的 `details` 字段不能写入密码、令牌或完整的预签名 URL。
- `audit.log` 参与 logrotate，不能加 `chattr +a`。
- 为了“刷新数据事件桶”去手工改栈参数：`DataEventBuckets` 由 storage 的注入维护，手工值会在下一次注入时被覆盖。

### 10. 探针

audit 是纯基础设施型，探针就是感知器（`detectors/audit.ts`）；`AUDIT_MODE=app` 时只评估本地实现，结果记为 `localHealth`，`status=off`。

| 探针 | 方式 | `degraded` 判据 | `error` 判据 | 所需权限（在 `PolicyArn` 中） | 无凭证时 |
|---|---|---|---|---|---|
| 本地（`app`，60 秒） | 表可写；最近一次 `GET /api/admin/audit/verify` 的结果（worker 每日校验一次，管理员可手动触发） | 最近一次校验超过 2 天未执行 | 哈希链断点（被篡改）；表不可写 | — | 照常 |
| 常规（`cloudtrail`，60 秒） | `GetTrailStatus`：`IsLogging`、`LatestDeliveryTime`、`LatestDigestDeliveryTime` | 正在记录但超过 1 小时没有投递；只读接入的外部 trail 没有开启日志文件验证 | trail 停止记录或不存在；AccessDenied | `cloudtrail:GetTrailStatus`、`cloudtrail:DescribeTrails` | `credentials: optional`：降为 `inferred`（只能确认 env 声明），CRED-004 |
| 深度（管理员或 enable 第 10 步） | `GetEventSelectors`：是否含 S3 数据事件、数据事件桶是否等于注入的 `DataEventBuckets`；最近 1 小时 `LookupEvents` 中本应用角色的调用数 | 数据事件桶与注入值不一致（栈被手工改过）；`ExcludeKmsEvents=true` 时提示 kms 实验需看 Event History | — | `cloudtrail:GetEventSelectors`、`cloudtrail:LookupEvents` | 同上 |

### 11. 前端徽章

| 位置 | 本地实现时（`app`） | AWS 实现时（`cloudtrail`） | 降级时 |
|---|---|---|---|
| `/admin/audit` “AWS 事件”页签标题 | 来自 Event History · 仅管理事件 · 90 天 · 本区域（`IAM_CREDENTIALS=none` 时隐藏页签） | 来自 CloudTrail trail · 多区域 · 含 S3 写数据事件 · 完整性已验证（外部 trail 时加注“复用已有 trail”） | 黄色“trail 超过 1 小时没有投递” |
| `/admin/audit` 顶部 | 应用审计 · 哈希链校验通过 / 发现断点 | 同左 | 红色“哈希链断点：第 N 行” |
| `/lab` audit 卡片 | 本地实现：应用 `audit_log` 表（知道最终用户） | AWS 实现：CloudTrail trail（知道 AWS 身份）+ 最近一次 `validate-logs` 结果 | 文案后附“降级” |

```yaml
# registry.yaml：audit.lab（summary 与 badges）
summary:
  local: "应用审计表（带哈希链）+ 有凭证时只读的 Event History：看不到绕过应用的 AWS 操作"
  aws: "多区域 trail 长期留存管理事件与 S3 写数据事件，日志文件可验证完整性；与应用审计按 request_id 关联"
keyMetrics: ["“谁删了这张照片”可追溯矩阵", "事件多久可查", "篡改能否被发现"]
badges:
  local: "审计：应用审计 + Event History（90 天）"
  aws: "审计：CloudTrail trail · 多区域"
```

### 12. 平台模式（ATL）

> 第 4 轮新增（总纲 1.4 D16）。规格以 [docs/platform/06](../platform/06-cloudalbum-platform-mode.md) 为准（PM-M31）。

- **平台缺省不建 trail**：平台以 CloudTrail 事件历史确认归属与回收（不需要 trail），安装参数 `PlatformTrail` 缺省关闭，所以本模块的“创建 trail”照常有意义。若安装时开启了平台 trail（`atl-trail`，记录管理事件），`preflight: existing-trail` 会发现它：本模块只创建记录数据事件的 trail（不重复记录管理事件），并以“只读接入”展示管理事件。
- **对象锁**：平台模式下 `ObjectLockDays` 缺省 0；需要演示时只允许治理模式（合规模式的对象锁会产生回收器删不掉、又持续计费的存储，平台的学员护栏也拒绝它）。
- **“谁删了这张照片”实验**：实验机侧的场景从平台工作台经 SSM 投递执行（06 PM-41）；平台的身份在事件中显示为 `atl-<sid>-*` 会话名，学员与运行器的操作因此可以区分。
- trail、桶与日志组带平台标签；本环境创建的 trail 在回收时删除，“只读接入”的 trail 不删除。

<a id="threat-detection"></a>

## threat-detection：威胁检测 ↔ Amazon GuardDuty

> 一句话总结：没有 GuardDuty 时，EC2 上的 fail2ban 和本地分析器只看得见本机日志：能在秒级封禁 SSH 爆破、登录爆破和扫描路径，但看不见 DNS 查询、网络流量模式、AWS API 调用和凭证滥用；启用后，GuardDuty 在 AWS 侧独立分析 CloudTrail 管理事件、VPC 流日志和 DNS 日志，给出分级的发现（finding），经 EventBridge → SNS 通知——但它只告警、不阻断。最直观的区别：/lab 安全面板右栏出现 GuardDuty 发现，下方的覆盖矩阵里，“实例访问挖矿域名”“实例凭证在 AWS 外部被使用”“异常的 AWS API 调用”这几行只有右栏能打勾，而“应用登录爆破”“Web 扫描路径”只有左栏能打勾。

### 0. 元数据（registry 摘录）

```yaml
# modules/registry.yaml 中 threat-detection 的条目（摘录；不一致时以 registry 为准，并同步本节）
threat-detection:
  group: E
  function: 威胁检测
  awsService: Amazon GuardDuty
  auxServices: [Amazon EventBridge（发现转发规则）, Amazon SNS（模块自带 security-findings 主题）]
  type: infra                            # 无端口；感知器 + 只读读取器
  detector: detectors/threat-detection.ts   # 读取器 detectors/security-reader.ts
  switch: { var: THREAT_DETECTION_MODE, values: [fail2ban, guardduty], ownedValues: [guardduty], localTiers: [] }
  ownsEnv: [GUARDDUTY_]
  credentials: optional                  # detector 由部署者身份创建、照常检测；应用只在展示与“生成示例发现”按钮时调用 guardduty API（缺凭证 → CRED-004）
  prerequisites: [confirm-email]         # 发现邮件订阅需要收件人确认
  requires: []
  soft: [shell-access, waf, monitoring, kms]
  conflicts: []
  authoritative: false
  bypass: []
  preflight: [existing-detector, policy-quota]   # 每个账号每个区域只有一个 detector：新建 / 恢复（带 ManagedBy 标签）/ 只读接入
  stacks: [{ name: main, template: infra/modules/threat-detection.yaml }]
  # 本栈接收的注入：KmsKeyArn（kms）。本模块不向其他栈注入
  # 基线（fail2ban + 本地分析器）由 ec2 安装（00 的 6.5）：本组只定义 render-fail2ban.sh、jail、过滤器与动作的内容，不另设 hostSetup
  probe: { kind: detector, intervalSec: 60 }
  billing:
    - { resource: "GuardDuty 按分析的事件与日志量（可选保护计划另计）", dimension: usage }
  lab: { compare: functional, hourlyBilled: false, experiments: [sample-findings, login-bruteforce, web-scan, dns-canary, ssh-bruteforce] }   # 文案见第 11 节
  doc: docs/modules/05-ops-observability.md#threat-detection
```

- 类型 I：声明型开关 `THREAT_DETECTION_MODE=fail2ban|guardduty`，`fail2ban`（fail2ban + 本地分析器）是本地实现；只有 `guardduty` 时写 `MODULE_THREAT_DETECTION=on`。只读接入已有 detector 也是 `guardduty`（`GUARDDUTY_MANAGED=false`）。
- 基线在 GuardDuty 启用后**继续运行**，两者互补（覆盖矩阵见第 5 节）。
- IP 封禁只有一个文件 `/var/lib/cloudalbum/security/denylist.conf`（`geo $ca_denied`，ec2 提供；waf 的 BlocklistPort(nginx) 与 fail2ban 共写，评审统一值，与 01#waf 一致）。本模块**不再**投放自己的 geo / if 片段。

### 1. 基线实现（仅 EC2）

**fail2ban（以 root 运行的 systemd 服务；由 ec2 在 `install` 阶段安装，00 的 6.5；本组定义渲染逻辑、jail、过滤器与动作的内容）**
- 安装：AL2023 自 2023.6.20241010 版本起，核心仓库（AL2023 自带的软件仓库，不是 EPEL）提供 fail2ban 1.1.0（该版本发行说明的“新增软件包”，核实日期 2026-10-13；子包拆分以实例上 `dnf info fail2ban-server` 的结果为准）。ec2 的引导脚本执行 `dnf install -y fail2ban-server fail2ban-systemd nftables`，不装 `fail2ban` 元包，以免把不需要的 firewalld 子包拉进来（依赖关系以仓库实际为准）。如果固定使用了更早的 AMI 而仓库中没有这个包，退回到“sshd `MaxAuthTries` + Nginx `limit_req`”，安全面板显示“fail2ban 不可用”。不需要再从 GitHub 下载源码安装。
- 配置由 `/usr/local/lib/cloudalbum/render-fail2ban.sh`（root，ec2 安装）渲染到 `/etc/fail2ban/jail.d/cloudalbum.local`；它在 `l0-bootstrap.sh postattach` 时执行一次，`scripts/module` 在任何模块启停之后也都执行一次（总纲 9.2 第 7 步：入口变化会改变封禁方式，见下文），并把当前封禁方式写进安全快照的 `fail2ban.banMode`。jail：
  - `sshd`：`backend = systemd`（AL2023 没有 `/var/log/secure`），封禁方式固定为 nftables（SSH 不经过代理）。
  - `nginx-limit-req`：读取 `/var/log/nginx/error.log`，配合 L0 Nginx 的 `limit_req`（总纲 2.5）。
  - `cloudalbum-auth`：自定义过滤器，匹配 `api.log` 中 `"event":"auth.login_failed"` 的 JSON 行（Logger 保证 `event` 字段写在 `ip` 字段之前）。
  - `cloudalbum-scan`：自定义过滤器，匹配 `nginx-access.json` 中请求扫描器常用路径（`/.env`、`/.git/`、`/wp-login.php`、`/phpmyadmin`、`/cgi-bin/` 等）的行。fail2ban 自带的 `nginx-botsearch` 针对的是 combined 文本格式，读不了总纲的 JSON 访问日志。
  - `ignoreip` 包含运维者 IP：`scripts/module` 把它写进数据卷上的 `etc/fail2ban-ignoreip`（00 的 3.4），渲染脚本读取，防止自测时把自己封掉。
- **封禁方式随入口自动切换**：
  - 直连（L0）：`nftables-multiport`，在内核层丢弃攻击源的包。
  - 在 CloudFront 或 ALB 后面（`modules.d/cdn.env` 中有 `MODULE_CDN=on`，或 `modules.d/load-balancer.env` 中有 `MODULE_LOAD_BALANCER=on`；load-balancer 的本地档 `LB_LOCAL_WORKERS=2` 不算，00 的 6.5）：TCP 连接来自代理，在 nftables 层封禁等于封掉代理、也就是封掉所有用户。所以渲染脚本把 HTTP 类 jail 的封禁动作改为 `cloudalbum-denylist`：把 IP 写入**唯一的** IP 封禁列表 `/var/lib/cloudalbum/security/denylist.conf`。这个文件、读取它的 `geo $ca_denied` 与 `if ($ca_denied) { return 403; }`（总纲 2.5 主配置；cdn 的 8080 server 块自带同一行）、以及校验并 reload 的 `cloudalbum-denylist.path` 都由 ec2 提供；waf 的 BlocklistPort(nginx) 也写同一个文件（01#waf）。前提是 cdn / load-balancer 已经投放了真实 IP 恢复片段（`set_real_ip_from`，总纲 2.5 约定 1），否则 `geo` 看到的仍是代理地址。
- **本地分析器**：worker 内的循环（每 5 分钟，LockPort 单例），增量读取 `nginx-access.json`（复用 LabMetricsStore 统计源站卸载时的读取器与偏移量），规则包括：同一 IP 短时间内大量 4xx、请求扫描器路径、登录失败突增、可疑 User-Agent。结果写入 `security_findings` 表，字段仿照 GuardDuty：`type`（如 `Recon:WebScan`、`UnauthorizedAccess:AppLoginBruteForce`）、`severity`（1–10）、`resource`、`count`、`first_seen`、`last_seen`、`sample`、`source=local`。严重度 ≥ 7 的新发现给管理员发站内信并经 EmailPort 发邮件。
- **状态采集**：与 shell-access 共用 root 安全快照（本组公共约定 3），其中 `fail2ban.available`、`fail2ban.banMode`、`fail2ban.jails[]`（每个 jail 的当前封禁 IP 与累计封禁数）。
- **感知器** `backend/src/modules/detectors/threat-detection.ts`：`THREAT_DETECTION_MODE=fail2ban` 时 `status=off`，`localHealth` = fail2ban 是否可用 + 快照是否新鲜 + 封禁方式是否与入口匹配（判据见第 10 节）。
- **/lab 安全面板**左栏“主机内视角”：当前封禁的 IP、各 jail 计数、本地 `security_findings`。

**局限**：只能看到本机的日志；看不到 DNS 查询、出站流量模式、AWS API 调用和凭证滥用；封禁列表每台实例一份（`WAF_MODE=aws` 时由 waf 同步到 WAF IP 集合，才在边缘统一生效）。

### 2. AWS 实现

**先检查已有 detector**（preflight `existing-detector`）：每个账号每个区域只能有一个 GuardDuty detector。`scripts/module enable threat-detection` 先执行 `aws guardduty list-detectors`，结论记入 state.json 的带外资源清单（总纲 9.2 disable 第 6 步“谁创建谁清理”）：
- 没有：由本模块的栈创建。
- 有，且带标签 `ManagedBy=scripts/module`（本模块以前创建、禁用时被暂停的）：恢复它（`update-detector --enable`），模板参数 `CreateDetector=false`。
- 有，但不是本模块创建的（以前手动开过，或由组织的委派管理员管理）：**只读接入**模式，`GUARDDUTY_MANAGED=false`，不创建也不删除 detector，只建通知规则和主题。

**基础数据源**（由 GuardDuty 独立采集，**不需要**你开 VPC Flow Logs、也不需要建 trail）：CloudTrail 管理事件、VPC 流日志、Route 53 Resolver DNS 查询日志。可选的保护计划另行计费：S3 Protection（S3 数据事件，storage=s3 时才有意义）、Runtime Monitoring（需要在 EC2 上部署 GuardDuty 安全代理，自动部署依赖实例是 SSM 托管节点）、Malware Protection for EC2（发现可疑行为时扫描 EBS 快照）。

**CloudFormation：`infra/modules/threat-detection.yaml`**

| 资源 | 说明 |
|---|---|
| `Detector`（Condition `CreateDetector`） | `Enable: true`；`FindingPublishingFrequency: FIFTEEN_MINUTES`（只影响**已有发现的更新**多久推送一次，新发现照常尽快发出）；`Features`：`S3_DATA_EVENTS`、`RUNTIME_MONITORING`、`EBS_MALWARE_PROTECTION` 由参数控制，默认 `DISABLED`（特性名以官方文档为准）；标签 `ManagedBy=scripts/module`；`DeletionPolicy: Retain`（发现属于数据，见第 6 节） |
| `FindingsTopic` | SNS 主题 `cloudalbum-<env>-security-findings`；参数 `AlertEmail` 非空时建邮件订阅；主题策略允许 `events.amazonaws.com` 发布（条件 `aws:SourceArn` = 下面的规则）；参数 `KmsKeyArn`（kms 注入）非空时加密，必须是客户托管密钥并授权 `events.amazonaws.com` |
| `FindingsRule` | EventBridge 规则 `cloudalbum-<env>-guardduty-findings`，事件模式见第 3 节；目标是 `FindingsTopic`，用 InputTransformer 生成可读的邮件正文（类型、严重度、资源、控制台链接） |
| `AppPolicy` | 只读：`guardduty:ListDetectors`、`GetDetector`、`ListFindings`、`GetFindings`、`GetFindingsStatistics`；管理员按钮所需：`guardduty:CreateSampleFindings`、`guardduty:ArchiveFindings`（只在仅管理员可调用的 `/api/lab/threat-detection/*` 路径中使用）；探针需要的 `sns:GetTopicAttributes`（限本模块主题）。模板不写 `Roles` / `Users`（D2） |
| Outputs | `ModuleId`、`ModuleVersion`、`PolicyArn`、`EnvThreatDetectionMode`（= `guardduty`）、`EnvGuarddutyDetectorId`、`EnvGuarddutyManaged`、`EnvGuarddutyMinSeverity`、`EnvGuarddutyFindingsTopicArn`、`InfoFindingsUrl`。不使用 `Export` |

可选：把发现导出到 S3（publishing destination，需要 kms 模块的密钥）；自动响应作为进阶练习，不放进模板：EventBridge → Lambda → 把攻击 IP 加入 WAF IP set（waf 模块）或网络 ACL 的 deny 规则（network 模块）。

**应用侧**
- 感知器：`GetDetector`（`Status`、各特性状态）、`GetFindingsStatistics`（按严重度计数），判据见第 10 节。
- `backend/src/modules/detectors/security-reader.ts`：把本地 `security_findings` 与 GuardDuty 发现合并成统一结构（`source`、`type`、`severity`、`resource`、`firstSeen`、`lastSeen`、`isSample`），`ListFindings` 只取 `updatedAt` 晚于上次查询的部分，结果缓存 60 秒。
- 不需要应用侧的转发作业：通知由 EventBridge → SNS 原生完成，实例宕机也不受影响。

```mermaid
flowchart LR
  subgraph Host [EC2 主机内（基线）]
    J[journal sshd] --> F2B[fail2ban]
    NA[nginx-access.json / api.log] --> F2B
    NA --> LA[本地分析器] --> SF[(security_findings)]
    F2B -->|nftables 或 denylist| BAN[封禁]
  end
  subgraph AWS [AWS 侧（GuardDuty）]
    CT[CloudTrail 管理事件] --> GD[GuardDuty]
    FL[VPC 流日志] --> GD
    DNS[Route 53 Resolver DNS 日志] --> GD
    GD --> EB[EventBridge 规则 severity ≥ 4] --> SNS[security-findings 主题] --> MAIL[邮件]
  end
  SF --> PANEL[/lab 安全面板 · 覆盖矩阵/]
  GD --> PANEL
```

### 3. 开关与配置

```bash
# /etc/cloudalbum/modules.d/threat-detection.env（root:cloudalbum 0640，数据卷上；启用时由 scripts/module 写入；
# 不存在 = THREAT_DETECTION_MODE=fail2ban：fail2ban + 本地分析器）
MODULE_THREAT_DETECTION=on              # 只在 THREAT_DETECTION_MODE=guardduty 时写入（CFG-004）
MODULE_THREAT_DETECTION_VERSION=1
THREAT_DETECTION_MODE=guardduty         # fail2ban | guardduty（第一个是本地实现）；Outputs.EnvThreatDetectionMode
GUARDDUTY_DETECTOR_ID=<detector-id>
GUARDDUTY_MANAGED=true                  # false = 账号中已有不归本模块管理的 detector，只读接入
GUARDDUTY_MIN_SEVERITY=4                # 与 EventBridge 规则一致，仅展示
GUARDDUTY_FINDINGS_TOPIC_ARN=arn:aws:sns:ap-northeast-1:<acct>:cloudalbum-lab-security-findings
```

- fail2ban 与本地分析器属于 L0 基线，在 GuardDuty 启用后**继续运行**（两者互补），它们的配置不在本模块 env 中；env 中没有机密类键（CFG-002）；本模块不出现在 `X-CloudAlbum-Path` 中（被 denylist 拦下的请求由 ec2 的 403 错误页带 `waf=nginx:denylist` 段）。

基线配置（由 `render-fail2ban.sh` 渲染；直连时的结果）：

```ini
# /etc/fail2ban/jail.d/cloudalbum.local
[DEFAULT]
banaction = nftables-multiport          ; 代理后面时 HTTP 类 jail 改为 cloudalbum-denylist
ignoreip  = 127.0.0.1/8 ::1 203.0.113.10/32   ; 运维 IP 取自 etc/fail2ban-ignoreip
findtime  = 10m
bantime   = 1h
maxretry  = 5

[sshd]
enabled   = true
backend   = systemd
banaction = nftables-multiport          ; SSH 不经过代理，始终在内核层封禁

[nginx-limit-req]
enabled = true
logpath = /var/log/nginx/error.log

[cloudalbum-auth]
enabled = true
filter  = cloudalbum-auth
logpath = /var/lib/cloudalbum/logs/api.log

[cloudalbum-scan]
enabled  = true
filter   = cloudalbum-scan
logpath  = /var/lib/cloudalbum/logs/nginx-access.json
maxretry = 3
bantime  = 6h
```

```ini
# /etc/fail2ban/filter.d/cloudalbum-auth.conf
[Definition]
failregex   = "event":"auth\.login_failed".*"ip":"<HOST>"
datepattern = "ts":"%%Y-%%m-%%dT%%H:%%M:%%S

# /etc/fail2ban/filter.d/cloudalbum-scan.conf（字段顺序见总纲 §2.5 的 cloudalbum_json：ts、rid、ip、…、uri）
[Definition]
failregex   = "ip":"<HOST>".*"uri":"/(?:\.env|\.git/|wp-login\.php|wp-admin|phpmyadmin|cgi-bin/|vendor/phpunit)
datepattern = "ts":"%%Y-%%m-%%dT%%H:%%M:%%S

# /etc/fail2ban/action.d/cloudalbum-denylist.conf
[Definition]
actionban   = /usr/local/lib/cloudalbum/denylist-edit.sh add <ip> --src fail2ban --jail <name> --bantime <bantime>
actionunban = /usr/local/lib/cloudalbum/denylist-edit.sh del <ip> --src fail2ban --jail <name>
actionstop  = /usr/local/lib/cloudalbum/denylist-edit.sh flush --src fail2ban --jail <name>
```

（JSON 日志必须配置 `datepattern`，否则 fail2ban 找不到时间戳会忽略这些行；配置文件中的 `%` 要写成 `%%`。）

`denylist-edit.sh`（root，随 ec2 的 `/usr/local/lib/cloudalbum/*.sh` 一起安装；内容归本组）遵守 01#waf 与 00 的 6.7 为 `denylist.conf` 定的写入规则。**本模块不再投放自己的 geo / if 片段**：上一轮的两个 `threat-denylist.conf` 片段已删除，`geo $ca_denied` 与 `if ($ca_denied)` 由 L0 主配置提供（总纲 2.5）。

```bash
# /usr/local/lib/cloudalbum/denylist-edit.sh add|del|flush [<ip>] --src fail2ban --jail <name> [--bantime <秒>]（要点）
exec 9>/var/lib/cloudalbum/security/denylist.lock && flock -w 10 9      # 与 BlocklistPort(nginx) 共用同一把锁
f=/var/lib/cloudalbum/security/denylist.conf; tmp=$(mktemp "$f.XXXX")   # 同一目录，rename 是原子的
# 1) 去掉“本来源、本 jail”对该 IP 的旧行（flush 时去掉本 jail 的全部行）。幂等：fail2ban 重启后重放封禁不会产生重复行；
#    src=admin（管理后台经 BlocklistPort 写入）的行不受影响
awk -v ip="$ip" -v tag="# src=fail2ban jail=$jail " -v op="$op" \
    'index($0, tag) && (op == "flush" || $1 == ip) { next } { print }' "$f" > "$tmp"
# 2) add 时追加一行；格式只能是 "<IP 或 CIDR> 1;" 加注释（denylist-apply.sh 逐行校验，出现非法行则整个文件被拒绝）
[ "$op" = add ] && echo "$ip 1;  # src=fail2ban jail=$jail ts=$(date -u +%FT%TZ) bantime=$bantime" >> "$tmp"
chown cloudalbum:cloudalbum "$tmp"; chmod 0640 "$tmp"; mv -f "$tmp" "$f"   # 属主与 waf 写入的一致；path 单元随后校验并 reload
```

封禁生效链路：`denylist.conf` 变化 → ec2 的 `cloudalbum-denylist.path` → `denylist-apply.sh`（逐行校验；通过则保存 last-good 并 `nginx -t && reload`，不通过则恢复 last-good 并写审计日志）→ Nginx 对 `$ca_denied` 命中的请求返回 403。`WAF_MODE=aws` 时，waf 的 BlocklistPort 每分钟把 `denylist.conf` 的增量（包括 fail2ban 新增与到期的条目）同步到 WAF IP 集合，封禁在边缘生效（01#waf）。

EventBridge 事件模式：

```json
{"source":["aws.guardduty"],"detail-type":["GuardDuty Finding"],"detail":{"severity":[{"numeric":[">=",4]}]}}
```

### 4. 依赖与组合

**硬依赖**
- 无模块级硬依赖；每个账号每个区域只能有一个 detector（已存在时进入只读接入或恢复模式）。
- 应用读取发现需要 `IAM_CREDENTIALS≠none` 和 guardduty 只读权限（`credentials: optional`）；没有凭证时 GuardDuty 照样工作，只是 /lab 看不到（`confidence=inferred`，CRED-004）。
- DNS 类发现要求实例使用 Amazon 提供的 DNS 解析器（Route 53 Resolver）。默认 VPC 满足；改用自建 DNS 会让这类检测失效。
- 基线的 fail2ban、nftables 由 ec2 以 root 安装（00 的 6.5）。在 cdn 或 load-balancer 后面时，必须先有真实 IP 恢复，HTTP 类 jail 改用 denylist 封禁（`render-fail2ban.sh` 自动切换）。
- 要把发现推送给人，需要确认 SNS 邮件订阅（`prerequisites: [confirm-email]`）；否则只在控制台和 /lab 可见（`degraded`）。

**与其他模块组合**
- **shell-access**：基线（22 端口对公网开放）时，fail2ban 的 `sshd` jail 与 GuardDuty 的 `UnauthorizedAccess:EC2/SSHBruteForce`、`Recon:EC2/PortProbeUnprotectedPort` 都会有真实数据；启用 shell-access 并关闭 22 端口后，两边都安静下来——最直观的“缩小攻击面”对比。Runtime Monitoring 的代理自动部署也依赖实例是 SSM 托管节点。
- **cdn、load-balancer**：Nginx 看到的源 IP 变成 CloudFront 或 ALB 的地址。不先恢复真实 IP，fail2ban 会封掉代理地址（等于封掉所有用户）；恢复后也只能用 denylist（L7）封禁。cdn 模块把实例安全组限制为只允许 CloudFront 前缀列表后，直连的扫描基本消失。
- **waf**：WAF 在边缘拦截 L7 攻击（托管规则、限速），fail2ban 的 nginx 类 jail 触发次数会减少。两者共写同一份 `denylist.conf`（一把锁、一个 path 单元）；`WAF_MODE=aws` 时 waf 的 BlocklistPort 把其中的条目（含 fail2ban 写入的）同步到 WAF IP 集合，主机层的封禁因此也在边缘生效（01#waf）。三者分工：WAF 防护 Web 请求，GuardDuty 检测账号与网络层威胁，fail2ban 做主机层封禁。
- **auth（cognito）**：登录发生在 Cognito，暴力破解请求不经过 Express，`cloudalbum-auth` jail 不再触发；相应能力由 Cognito 的威胁防护提供（Plus 层级，额外收费，见 02#auth）。
- **autoscaling**：fail2ban 的封禁只对单台实例有效（`denylist.conf` 每台实例一份），请求被 ALB 分到别的实例时攻击者可以继续；本项目统一的共享方式是 `WAF_MODE=aws`，由 waf 把各实例的 denylist 增量同步到同一个 WAF IP 集合（01#waf），不另设共享封禁列表。GuardDuty 天然覆盖所有实例。
- **audit**：GuardDuty 自己读取 CloudTrail 管理事件，不依赖 trail；出现发现后，用 trail 做取证，查清攻击者调用了哪些 API。
- **iam**：role 模式下，实例角色凭证在 AWS 外部被使用时，GuardDuty 产生 `UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS`；keys 模式下对应的是 IAM 用户类的异常发现。
- **storage**：S3 Protection 只在 storage=s3 时有意义。
- **logging**：fail2ban 依赖本地日志文件，logging 的设计保证本地文件一直写。
- **monitoring**：可选，对 GuardDuty 发现数量做告警；发现通知走本模块自带的 security-findings 主题，不经过 ops-alarms 主题。
- **network**：私有子网 + NAT 时，发现仍然关联到实例的网卡。
- **vuln-scan（06）**：GuardDuty 检测“正在发生的入侵迹象”，Amazon Inspector 发现“可被利用的漏洞”；Runtime Monitoring 与 Inspector 的 EC2 扫描都依赖 SSM 托管节点（与 shell-access 相同的前提）。
- **compliance（06）**：AWS Config 规则可以检查“GuardDuty 是否已启用”（托管规则名以官方文档为准）；本地自检器读安全快照的 `fail2ban.available` 与 `banMode`。

### 5. 对比实验：有 vs 没有

| 维度 | 没有 GuardDuty（基线：fail2ban + 本地分析器） | 有 GuardDuty |
|---|---|---|
| 数据来源 | 本机 sshd、Nginx、应用日志 | CloudTrail 管理事件、VPC 流日志、DNS 日志（AWS 侧独立采集） |
| 能否阻断 | 能（秒级封禁） | 不能，只告警；阻断要靠 EventBridge 自动化 |
| 应用登录爆破、Web 扫描路径 | 能 | 不能（不分析应用日志和 HTTP 内容） |
| DNS（挖矿、C&C 域名） | 不能 | 能 |
| 凭证外泄、异常 API 调用 | 不能 | 能 |
| 实例宕机 / 被攻陷后 | 检测随之失效 | 不受影响 |
| 多实例 | 每台各管各的 | 账号级、区域级覆盖 |
| 通知 | 站内信 + EmailPort（依赖实例） | EventBridge → SNS |
| 费用 | 无 AWS 费用 | 按分析的数据量计费，新账号 / 新区域有 30 天免费试用 |

**覆盖矩阵**（显示在 /lab 安全面板下方，每次实验后自动打勾）

| 场景 | fail2ban / 本地分析器 | GuardDuty |
|---|---|---|
| SSH 爆破（22 端口开放时） | 能检测，秒级封禁 | 能检测（`SSHBruteForce`），分钟级，只告警 |
| 端口扫描 | 部分（只有 sshd 和 Nginx 记录到的） | 能检测（`Recon:EC2/PortProbeUnprotectedPort` 等） |
| 应用登录爆破（HTTP 401） | 能检测（`cloudalbum-auth`） | 不能 |
| Web 扫描路径（`/.env` 等） | 能检测（`cloudalbum-scan`、本地分析器） | 不能（属于 WAF 的范畴） |
| 实例访问挖矿或 C&C 域名 | 不能 | 能检测（依赖 DNS 日志） |
| 实例凭证在 AWS 外部被使用 | 不能 | 能检测（`InstanceCredentialExfiltration`） |
| 异常的 AWS API 调用 | 不能 | 能检测（依赖 CloudTrail 管理事件） |
| S3 异常访问 | 不能 | 能检测（需要开启 S3 Protection） |

**页面上能直接看到的差异**
- /lab 安全面板分两栏：左栏“主机内视角”（封禁的 IP、jail 计数、本地发现）；右栏“AWS 视角”（发现的类型、严重度颜色、资源、首次和最近出现时间、是否 `[SAMPLE]`），右栏有“生成示例发现”和“归档示例发现”按钮（仅管理员）。
- 收件箱收到 EventBridge → SNS 发来的发现邮件。

**测量指标**
每个场景能否被检出（覆盖率）；检出耗时（从攻击开始到出现封禁或发现）；能否自动阻断；误报（例如把 CloudFront 或 ALB 的地址封掉）；通知送达时间。

**操作步骤**（`experiments/threat-detection/`；所有测试只针对自己的资源，并遵守 AWS 渗透测试政策）
1. 示例发现：`npm run exp -- threat-detection --label after --scenario sample-findings`。脚本调用 `aws guardduty create-sample-findings --detector-id <id> --finding-types "UnauthorizedAccess:EC2/SSHBruteForce" "Recon:EC2/PortProbeUnprotectedPort" "CryptoCurrency:EC2/BitcoinTool.B!DNS" "UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS"`，然后轮询 /lab 右栏与邮件到达时间；结束时归档这些示例发现。
2. 登录爆破：从一台**不在** `ignoreip` 中的测试机（例如 CloudShell）运行 `k6 run -e BASE=http://<EIP> experiments/threat-detection/login-bruteforce.k6.js`，用错误密码连续调用 `/api/auth/login`（AUTH_DRIVER=local 时有效）。记录 `cloudalbum-auth` 封禁的时刻；GuardDuty 一侧应无发现。
3. Web 扫描：同一测试机运行 `npm run exp -- threat-detection --label <before|after> --scenario web-scan`，依次请求 `/.env`、`/wp-login.php`、`/phpmyadmin` 等路径；观察 `cloudalbum-scan` 封禁和本地分析器的 `Recon:WebScan` 发现。在 cdn 后面重做一次，验证 denylist 模式返回 403，而其他用户不受影响。
4. DNS 金丝雀（可选）：经投递通道在实例上执行 `dig <官方文档中的 GuardDuty 测试域名>`（例如 `guarddutyc2activityb.com`，以官方文档为准），等待 DNS 类发现出现；这是一条**真实**发现，实验后归档。
5. SSH 爆破（仅在启用 shell-access 之前）：从测试机用错误的密钥多次尝试登录，观察 `sshd` jail；GuardDuty 的 `SSHBruteForce` 需要一定规模的真实攻击才会产生，实验中不一定能复现，用第 1 步的示例发现演示。

**预期结果**
- HTTP 层的登录爆破和扫描路径只有 fail2ban 和本地分析器能发现，并能在秒级封禁。
- 实例访问恶意域名、凭证在外部被使用、异常的 API 调用只有 GuardDuty 能发现。
- GuardDuty 只告警不阻断，新发现通常在几分钟内出现（以官方文档为准）；通知经 EventBridge → SNS 送达，与实例状态无关。
- 示例发现带 `[SAMPLE]` 标记，不代表真实威胁。
- 在代理后面误用 nftables 封禁时，会看到“所有用户都被 403/超时”的误报——这是要刻意演示的坑。

**运行时 A/B 还是切换重启**：启用 GuardDuty 后 fail2ban 继续运行，两者在同一部署中并排工作，每个攻击场景执行一次即可同时看到两侧结果（功能对比）。与 shell-access 相关的场景（22 端口开或关）需要切换前后分别测量。

### 6. 切换、数据迁移与回滚

**启用**：`scripts/module enable threat-detection [--param AlertEmail=…] [--param S3Protection=ENABLED] [--with-sample]`
1. 计划校验与 preflight `existing-detector`：`list-detectors` 决定新建、恢复（带 `ManagedBy=scripts/module` 标签的暂停 detector）还是只读接入，结论记入 state.json；`IAM_CREDENTIALS=none` 时提示 CRED-004（GuardDuty 照常检测，只是应用侧看不到）。
2. 确认：提示按分析的数据量计费、可选保护计划另计；新账号 / 新区域有免费试用期（以控制台为准）。
3. 部署 `infra/modules/threat-detection.yaml`（detector、主题、规则、策略；`KmsKeyArn` 取 kms 的注入值）。
4～5. 生成 env（`MODULE_THREAT_DETECTION=on`、`THREAT_DETECTION_MODE=guardduty`、`GUARDDUTY_*`）；附加 `PolicyArn`（记入 state.json）。
6. 不迁移数据。
7～9. 原子写入 `modules.d/threat-detection.env`；执行 `render-fail2ban.sh`（总纲 9.2 第 7 步，入口未变时结果不变）；`check-config`；重启 api 和 worker（只影响感知器与读取器）。
10. 探针：`GetDetector` 返回 `Status=ENABLED`（第 10 节）。`--with-sample` 时调用 `CreateSampleFindings` 生成一条示例发现，确认 /lab 和邮件都能收到，再归档。

**迁移**：fail2ban 与本地 `security_findings` 表保持不变，不需要迁移。

**禁用**：`scripts/module disable threat-detection`
- 默认：删除栈（规则、主题随之删除），detector 因 `DeletionPolicy: Retain` 保留，`scripts/module` 随后执行 `update-detector --no-enable` 把它**暂停**：已有发现保留，暂停期间不再监控、不再计费。下次启用时恢复它。
- `--purge`：在暂停之后执行 `delete-detector`，所有发现随之删除（删除前可以先导出）。
- 只读接入模式：只删除本栈的规则、主题和策略，不动已有的 detector。
- 无论哪种方式，env 删除后 `THREAT_DETECTION_MODE` 回到 `fail2ban`；fail2ban 与本地分析器从未停止，没有检测空窗。本模块不向其他栈注入，没有需要撤销的注入。

### 7. SAA 考点

- GuardDuty 的基础数据源：CloudTrail 管理事件、VPC 流日志、DNS 日志，由 GuardDuty 独立采集，不需要自己开启。
- GuardDuty 只检测、不阻断；自动响应靠 EventBridge 触发 SNS、Lambda（例如更新 WAF IP set 或网络 ACL）。
- 发现的严重度分级；示例发现；多账户下的委派管理员；按区域启用。
- GuardDuty、Amazon Inspector（漏洞扫描）、Amazon Macie（S3 敏感数据）、Amazon Detective（调查）、AWS Security Hub（汇总）的区别。
- GuardDuty、AWS WAF、AWS Shield、AWS Network Firewall、安全组 / 网络 ACL 的区别，以及各自管哪一层。
- 可选的保护计划：S3 Protection、Runtime Monitoring、Malware Protection，以及 RDS、Lambda、EKS 保护。
- 在 CloudFront / ALB 后面获取真实客户端 IP（`X-Forwarded-For`）的意义。

### 8. 费用与清理

- GuardDuty 按分析的 CloudTrail 事件数、VPC 流日志和 DNS 日志的数据量计费；可选的保护计划另行计费。新账号或新区域开启时有 30 天免费试用，控制台的 Usage 页面可以查看预估费用。单台 EC2 的学习环境通常费用很低，但不用时应暂停或删除 detector。SNS、EventBridge 在这个量级下通常可以忽略。fail2ban 没有 AWS 费用。以官方定价为准。
- 清理：`scripts/module disable threat-detection`（暂停）或加 `--purge`（删除 detector 与发现）；归档或删除实验产生的示例发现和 DNS 金丝雀发现。

### 9. 常见坑

- 每个账号每个区域只能有一个 detector；已经存在时用 CloudFormation 直接创建会失败，脚本要先检测。
- GuardDuty 不阻止任何流量。只开 GuardDuty 而不配通知，就等于没人看。
- 示例发现带 `[SAMPLE]` 标记，演示完要归档，免得与真实发现混在一起。
- 新发现通常在几分钟内出现，同一发现的后续更新按 `FindingPublishingFrequency` 合并推送；实验时不要期待秒级响应。
- SSH 爆破类发现需要一定规模的真实攻击才会产生，实验中不一定能复现，用示例发现演示。
- 在 CloudFront 或 ALB 后面直接用 fail2ban 的 nftables 封禁 HTTP 攻击，会封掉代理地址，等于封掉所有用户；必须先恢复真实 IP，再改用 L7 denylist。
- fail2ban 的 `ignoreip` 一定要包含运维 IP，否则自测时会把自己封掉。
- AL2023 没有 rsyslog 和 `/var/log/secure`，`sshd` jail 必须用 `backend = systemd`。
- JSON 日志要配 `datepattern`，且过滤正则依赖字段顺序；fail2ban 自带的 nginx 过滤器针对的是文本格式日志。
- 攻击模拟只能针对自己的资源，并遵守 AWS 渗透测试政策，不要扫描别人的地址。
- EventBridge 发布到 KMS 加密的 SNS 主题时，必须用客户托管密钥，并在密钥策略中授权 `events.amazonaws.com`。
- 禁用时只删栈而不暂停 detector（它被 Retain 了），会一直计费；`scripts/module` 负责暂停，手工删栈时要记得。
- 自己再写一份 `geo $ca_denied` 或另起一个封禁文件：Nginx 变量只能定义一次，`nginx -t` 会失败；两个写入方各写各的文件还会出现“这边解封、那边还在封”。封禁只写 `denylist.conf`，并且必须先取 `denylist.lock`。
- 用 `echo >>` 或 `sed -i` 直接改 `denylist.conf`：绕过了锁和“临时文件 + rename”，可能与 waf 的写入交错，产生半行，被 `denylist-apply.sh` 整文件拒绝（保留 last-good，新封禁不生效）。

### 10. 探针

threat-detection 是纯基础设施型，探针就是感知器（`detectors/threat-detection.ts`）；`THREAT_DETECTION_MODE=fail2ban` 时只评估本地实现，结果记为 `localHealth`，`status=off`（与 00 第 7 节 ec2 的 `fail2ban` 检查项口径一致）。

| 探针 | 方式 | `degraded` 判据 | `error` 判据 | 所需权限（在 `PolicyArn` 中） | 无凭证时 |
|---|---|---|---|---|---|
| 本地（`fail2ban`，60 秒） | 安全快照的 `fail2ban` 段（`available`、`banMode`、`jails[]`）；本地分析器最近一次运行时间；`denylist.conf` 最近一次校验结果（快照 `host.nginx.denylistRejectedLines`） | 快照超过 5 分钟；fail2ban 不可用（旧 AMI，已退回 `MaxAuthTries` + `limit_req`）；在代理后面仍用 nftables 封禁 HTTP 类 jail（`banMode` 与入口不符）；denylist 有被拒绝的行（仍在用 last-good） | fail2ban 已安装但服务未运行 | — | 照常 |
| 常规（`guardduty`，60 秒） | `GetDetector`（`Status`、各特性状态）；`sns:GetTopicAttributes`（已确认订阅数） | 只读接入（外部 detector，`detail` 标注）且本模块规则未部署；没有已确认订阅；本地基线的任一 `degraded` 判据 | detector 被暂停或不存在；AccessDenied | `guardduty:ListDetectors`、`guardduty:GetDetector`、`sns:GetTopicAttributes` | `credentials: optional`：降为 `inferred`，CRED-004 |
| 深度（管理员或 enable 第 10 步） | `GetFindingsStatistics`（按严重度计数）；`ListFindings` 最近 24 小时（`updatedAt` 增量，缓存 60 秒） | — | — | `guardduty:GetFindingsStatistics`、`guardduty:ListFindings`、`guardduty:GetFindings` | 同上 |

### 11. 前端徽章

| 位置 | 本地实现时（`fail2ban`） | AWS 实现时（`guardduty`） | 降级时 |
|---|---|---|---|
| `/lab` 安全面板 | 只有左栏“主机内视角”：当前封禁的 IP、各 jail 计数、本地 `security_findings`、封禁方式（nftables / denylist） | 左栏不变，右栏“AWS 视角”：GuardDuty 发现（类型、严重度颜色、资源、时间、`[SAMPLE]` 标记）与“生成 / 归档示例发现”按钮（仅管理员） | 黄色“封禁方式与入口不符”或“发现邮件订阅未确认” |
| `/lab` 安全面板下方覆盖矩阵 | 左栏的行可打勾 | 右栏的行可打勾（每次实验后自动更新） | — |
| 管理后台 · 安全与合规（总纲 12.3） | 威胁检测：fail2ban + 本地分析器（只看本机） | 威胁检测：Amazon GuardDuty（只告警不阻断）+ 本机 fail2ban | 文案后附“降级” |

```yaml
# registry.yaml：threat-detection.lab（summary 与 badges）
summary:
  local: "fail2ban + 本地分析器：秒级封禁 SSH / 登录爆破与扫描路径，但看不见 DNS、流量模式与 API 调用"
  aws: "GuardDuty 在 AWS 侧分析 CloudTrail、VPC 流日志与 DNS 日志，经 EventBridge → SNS 通知；只告警不阻断，与 fail2ban 互补"
keyMetrics: ["各攻击场景的覆盖矩阵", "检出耗时", "能否自动阻断", "误报（封掉代理地址）"]
badges:
  local: "威胁检测：fail2ban（本机）"
  aws: "威胁检测：GuardDuty + fail2ban"
```

### 12. 平台模式（ATL）

> 第 4 轮新增（总纲 1.4 D16）。规格以 [docs/platform/06](../platform/06-cloudalbum-platform-mode.md) 为准（PM-M32）。

- **谁创建谁清理**：本环境创建的 GuardDuty 检测器在 `disable` 与平台回收时**删除**（不是暂停），因为检测器是账号级单例、按量计费，暂停后留在账号里会让下一个环境误以为“已存在则只读接入”。`preflight: existing-detector` 发现检测器在平台安装之前就已存在时只读接入，不删除也不暂停。
- **攻击模拟的来源**：攻击脚本从平台工作台发起时，注意 fail2ban 的 `ignoreip` 与工作台出口地址的关系；平台工作台的出口地址以平台占位符 `${atl:workstationPublicCidr}` 引用。从 CloudShell 发起的结果无法上传到平台，只能人工确认。
- 检测器的计费是账号级的，平台的开始确认页会说明这一点。

## 修订记录

### 2026-10-13 · 第 2 轮（收敛修订：落实完整性评审与统一决策 D1～D15）

**改了什么**

- **结构**（D10、附录 A）：文首说明 ec2 基础契约以 00-ec2-base.md 为准；6 个模块标题前加锚点 `<a id="<id>"></a>`；每个模块补“第 0 节 元数据（registry 摘录）”“第 10 节 探针”“第 11 节 前端徽章”（编号方式与 01、03 组一致，原第 1～9 节编号不变）；原 §2 中的感知器判据移到第 10 节；registry 摘录只用总纲 3.5 允许的字段（`systemdDropIns` 统一为复数，`baseParams` 写成对象，`injects` 用 `{ target, params, when }`）。
- **开关与凭证**（D1、D9）：纯基础设施型改为声明型开关 `SHELL_ACCESS_MODE=ssh|ssm`、`AUDIT_MODE=app|cloudtrail`、`THREAT_DETECTION_MODE=fail2ban|guardduty`，`MODULE_<ID>=on` 只在取 AWS 值时写入；一览表增加“凭证”列（shell-access、logging、monitoring、tracing 为 required，audit、threat-detection 为 optional）；删除“IAM 命名未统一”的未决说明，统一按 `IAM_CREDENTIALS=none|role|keys`、CRED-001/002/004 书写；capabilities 示例的 `driver` 改为开关取值。
- **策略与跨栈**（D2）：shell-access 及本组全部模板只输出 `PolicyArn`，不写 `Roles` / `Users`、不 `ImportValue`、不 `Export`，由 `scripts/module` 附加并记入 state.json（给出 AppPolicy 片段，作废上一轮 `Roles: [!ImportValue …]` 写法）；删除“其他模块启停后再执行一次 enable monitoring / audit”的刷新方式，改为提供方 `injects`：logging → monitoring（`LogErrorsNamespace`）、monitoring → audit（`AlarmTopicArn`）、tracing → image-processing / workflow（`Tracing: Active`），并在约定 11 列出需要其他组声明的注入；`DataEventBuckets=auto` 读 storage 状态的做法删除。
- **规则**（D3）：只引用总纲 5.2 的编号（DEP-001 改为 `SHELL_ACCESS_MODE=ssm` 而 `IAM_CREDENTIALS≠role`；SEC-003、ASG-009/010、CFG-002/004、CRED-001/002/004），不自建编号。
- **机密与主机文件**（D5、D6）：env 文件注明在数据卷上（`root:cloudalbum 0640`）、不含机密类键；keys 模式下不为 CloudWatch Agent 另写凭证文件，依赖 Agent 的子功能关闭；logrotate 正文按固定 uid/gid 与 0640 改写（`nginx-access.json` 为 `nginx:cloudalbum`）；`alerts.yaml`、`fail2ban-ignoreip` 都在数据卷上；Agent 片段、tracing drop-in、`cloudalbum-ops` 用户由各模块 `hostSetup` 投放并遵守重放契约。
- **ConfigPort**（D7）：`logLevel`、`featureFlags['lab.faults']` 归 RuntimeConfig；删除“告警阈值、local 采样比例从 Parameter Store 热更新”“config 的 restart 类配置”等说法。
- **tracing 本地档**：从“偏差”改为“已收录”，第 0 节给出与总纲 1.3、2.4、2.6、2.8、3.2、4.1、4.2、4.4、6.2、7.2、8.3、10.2、10.4 的逐项对应表；env 增加 `TRACING_LOCAL_RETENTION_DAYS`，`TRACING_OTLP_ENDPOINT` 改为总纲默认值 `http://127.0.0.1:4318`；路径头取值 `unsampled` 统一为 `not-sampled`。
- **IP 封禁**（评审统一值）：只保留 `security/denylist.conf`（`geo $ca_denied`，ec2 提供），删除本组自带的两个 `threat-denylist.conf` Nginx 片段；fail2ban 动作改为调用 `denylist-edit.sh`（取 `denylist.lock`、临时文件 + rename、带 `src=fail2ban` 注释，幂等）；多实例的共享封禁统一为 waf 同步到 WAF IP 集合，删除“放到 redis 集合”的提议。
- **fail2ban**：写明来自 AL2023 核心仓库（2023.6.20241010 发行说明新增 fail2ban 1.1.0），由 ec2 安装；`render-fail2ban.sh` 的切换条件对齐 00（`MODULE_CDN=on` 或 `MODULE_LOAD_BALANCER=on`，本地档不算）。
- **ec2 基础栈**：`SshIngressCidr`、`KeyName`、`DetailedMonitoring` 的定义、写入规则与 preflight 改为引用 00-ec2-base.md 6.2～6.4；“防锁死”改用 `rebuild-instance` 与 EIC Endpoint。
- **其他**：故障注入、后台任务、`audit.retention` 改为引用总纲 8.4、4.2；启用顺序与 Lab 编号改为引用总纲第 10 节（shell-access Lab 2、logging/monitoring Lab 3、tracing Lab 22、audit/threat-detection Lab 23）；补充与 compliance、vuln-scan（06）的联动；LogReader 改为在总纲签名上追加可选字段；核实并注明日期（2026-10-13）：X-Ray SDK / Daemon 维护期（2026-02-25 起，2027-02-25 结束支持）、X-Ray 接受 W3C trace ID 的收集器版本、AL2023 的 fail2ban 软件包。

**没有采纳或做了调整的评审意见**

1. 附录 A 把“探针”“前端徽章”放在第 2、5 节内的子小节；本文与 01、03 组一致，放在第 10、11 节，内容相同，原“见第 N 节”的引用不必改动。
2. 评审统一值把 keys 模式的长期密钥写在 `iam-keys.env`；本文按总纲第 2 轮与 D5 写作 `secrets.env` 中的 `IAM_KEYS_*`。
3. 上一轮“keys 模式下给 CloudWatch Agent 另配 shared credentials”的做法不再保留：与 D5 冲突，改为 keys 模式下关闭依赖 Agent 的子功能（与总纲 CRED-002 的说明一致）。

**仍需其他文件配合**

- 总纲：4.4 Core zod 增加 `AUDIT_RETENTION_DAYS`、`AUDIT_HASH_CHAIN`；`Tracing` 段增加 `TRACING_LOCAL_SPANS`、`TRACING_LOCAL_SAMPLE_RATIO`、`TRACING_SAMPLING_ENDPOINT`、`TRACING_XRAY_GROUP`；4.2 `Dims` 注明 ASG 目标跟踪指标的 `AutoScalingGroupName` 例外；3.5 `preflight` 收录 `ssm-session-preferences`；5.2 建议在 DEP-035 之后增设一条部署规则：`TRACING_DRIVER=xray`、`LOG_CW_SHIPPER=agent`、`METRICS_CW_MODE=emf` 要求 `IAM_CREDENTIALS=role`（目前只靠 CRED-002 提示与探针报错）。
- 01（load-balancer、autoscaling）、03（database、cache、storage）、04（queue、image-processing、social-api）的 registry 条目补 `injects`：向 monitoring 注入告警维度、storage 向 audit 注入 `DataEventBuckets`；04#image-processing 与 06#workflow 的模板声明 `Tracing` 参数。
- 02#kms：密钥策略授权 `logs.<region>.amazonaws.com`、`cloudwatch.amazonaws.com`、`events.amazonaws.com`、`cloudtrail.amazonaws.com`（带 `aws:SourceArn`），供本组日志组、主题、trail 桶使用。02#iam 中“shell-access、logging 挂载的 AWS 托管策略”的说法需改为“本组默认只用客户托管策略”。
- 00-ec2-base.md：6.5 辅助脚本表加入 `denylist-edit.sh`；安全快照 `host.units` 加入 `amazon-cloudwatch-agent`，并收录本组定义的 `sshd.effective`、`fail2ban.banMode` 字段；`/etc/logrotate.d/cloudalbum` 采用本文 logging 第 1 节的正文；`alerts.yaml` 不存在时由引导脚本写入默认规则。

### 2026-10-13 第 3 轮：审计修复

- **补齐注入**：monitoring 作为提供方增加 `{ target: backup, params: { AlarmTopicArn } }`（03 backup 原来标为“待 05 声明”）；作为接收方补上 workflow 注入的 `StateMachineArn`（第 0 节注释、模板参数清单、告警清单中的 Step Functions 失败执行数告警）。约定 11 的注入表同步：storage → audit 的 `DataEventBuckets` 与各提供方 → monitoring 的告警维度已由 01、03、04、06 声明，删除“待补”。
- **模板结构**：总纲附录 A 第 3 轮按本组与 01～04 组的实际结构定稿（“10. 探针”“11. 前端徽章”独立成节），本文上一轮“没有采纳的评审意见”第 1 条因此不再是偏差。
- 上一轮“仍需其他文件配合”中的第 2 条（01、03、04 补 `injects`、storage → audit）已完成；`Tracing` 段的 4 个键与 Core 的 `AUDIT_RETENTION_DAYS`、`AUDIT_HASH_CHAIN` 已由总纲 4.4 收录。仍未完成：总纲 4.2 `Dims` 的 ASG 例外，3.5 `preflight` 的 `ssm-session-preferences`，以及“Agent 类子选项要求 role”的部署规则建议；02#kms 密钥策略的服务主体语句；00 的若干细节。

### 2026-10-13 第 4 轮：平台模式回写（总纲 D16）

- shell-access、logging、audit、threat-detection 各新增“### 12. 平台模式（ATL）”（总纲附录 A 的可选第 12 节），规格以 [docs/platform/06](../platform/06-cloudalbum-platform-mode.md) 为准：shell-access 的“启用前”在平台模式下已有 SSM 管理通道、平台终端使用 `ATL-SessionShell` 且统计时排除、`SSM-SessionManagerRunShell` 的原值备份到状态桶、`probe-port --target private-ip`；logging 的运行时日志组命名与回收；audit 在已有平台 trail 时只建数据事件 trail、`ObjectLockDays` 缺省 0；threat-detection 本环境创建的检测器删除而不是暂停。monitoring、tracing 没有模块侧改动（停止实例的演练由卡片声明预期中断窗口）。
- 只做增补，独立模式的行为不变。

### 2026-10-13 第 5 轮：平台模式补充（kill-test 分阶段）

- monitoring 新增“### 12. 平台模式（ATL）”：`kill-test` 增加 `--phase service|instance|all`（平台模式缺省 `service`，独立模式缺省 `all`），登记一次性变体 `stop-instance`；第 5 部分第 2 步注明该参数。依据 docs/platform/06 PM-M30（跨文档审计：卡片 svc-monitoring、sc-observability 的成对比较只用第一阶段）。上一轮“monitoring、tracing 没有模块侧改动”的说法对 monitoring 不再成立。
