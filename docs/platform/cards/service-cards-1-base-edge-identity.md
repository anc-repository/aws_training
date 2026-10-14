# 单服务卡片（第 1 批）：EC2 基线 · A 组入口与网络 · B 组身份与安全

> 本批 14 张单服务卡片（`kind: service`）：入门卡 `svc-ec2`；A 组 `svc-network`、`svc-cdn`、`svc-dns`、`svc-tls`、`svc-waf`、`svc-load-balancer`、`svc-autoscaling`；B 组 `svc-iam`、`svc-auth`、`svc-identity-pool`、`svc-secrets`、`svc-config`、`svc-kms`。状态：设计稿 · 第 2 轮（按主设计者裁决 C1～C5 修订，见文末修订记录）· 2026-10-13。

## 本批卡片总表

时长写成“预计 / 时间上限（分钟）”。startProfile 一列中“L0”= `l0-ec2`，后面是平台在开始实验时自动预置的模块（规则见 §1.1：L0 + iam(role) + 目标模块硬依赖的闭包，`svc-ec2`、`svc-iam` 不预置 iam）；“方案 B 关”= 关闭平台默认的 Let's Encrypt IP 证书预览（`startProfile.platform.preview.directHttps: off`，03 §6.2）。“部署等级”是 04 §3.1 必填字段 `provision.class`（等级定义见 02 §11.1）。“预期警告”是 04 §3.2.5 的 `expectedWarnings`：只有这些 warn 级规则导致的 `degraded` 才视为正常（§1.1 规则 3）。

| id | 标题 | 难度 | 时长 | startProfile | 预期警告 | 部署等级 | 费用档位 | 人工前置 |
|---|---|---|---|---|---|---|---|---|
| `svc-ec2` | Amazon EC2：运行整个应用 | 入门 | 60 / 90 | L0（C3 例外，不预置 iam） | — | A | 低 | 无 |
| `svc-network` | Amazon VPC：网络隔离 | 中级 | 90 / 150 | L0 + iam（目标：默认 VPC → 自定义 VPC 的 public 放置；private 归 `sc-private-network`） | — | A（卡内替换实例） | 低 | 无 |
| `svc-cdn` | Amazon CloudFront：内容分发与边缘缓存 | 中级 | 75 / 120 | L0 + iam | — | A | 低 | 无 |
| `svc-dns` | Amazon Route 53：域名解析 | 中级 | 60 / 120 | L0 + iam | — | A | 低 | 自有域名（已有托管区域，或能做 NS 委派） |
| `svc-tls` | AWS Certificate Manager：HTTPS 证书 | 中级 | 75 / 120 | L0 + iam，方案 B 关；ACME 端点不可用时变体 `acme-off` 再加 cdn | — | A（变体 B） | 低 | 自有域名，能添加 CNAME 与 A 记录 |
| `svc-waf` | AWS WAF：Web 应用防护 | 中级 | 90 / 150 | L0 + iam + cdn | DEP-018（第 4 步前） | B | 低 | 无 |
| `svc-load-balancer` | Elastic Load Balancing：负载均衡（ALB） | 中级 | 60 / 90 | L0 + iam | SEC-002、DEP-011 | A | 中 | 无 |
| `svc-autoscaling` | Amazon EC2 Auto Scaling：弹性伸缩 | 高级 | 120 / 180 | L0 + iam + storage + database + load-balancer，方案 B 关 | ASG-009～013、SEC-002、DEP-011 | D | 高 | 无 |
| `svc-iam` | AWS IAM：服务器访问 AWS 的凭证 | 初级 | 60 / 90 | L0（C3 例外：目标就是 iam） | —（keys 演示期间的 CRED-002 只用 once 检查观察） | A | 低 | 无 |
| `svc-auth` | Amazon Cognito User Pool：用户注册登录 | 中级 | 90 / 150 | L0 + iam；种子 `cognito-test-users`（本地阶段） | DEP-013 | A | 低 | 一个能收信的邮箱 |
| `svc-identity-pool` | Amazon Cognito Identity Pool：终端用户直传 S3 | 中级 | 90 / 150 | L0 + iam + storage + auth；种子 `cognito-test-users` | DEP-013、DEP-030 | B | 低 | 无 |
| `svc-secrets` | AWS Secrets Manager：密码与密钥管理 | 中级 | 60 / 90 | L0 + iam | — | A | 低 | 无 |
| `svc-config` | AWS Systems Manager Parameter Store：运行时配置 | 初级 | 45 / 90 | L0 + iam | — | A | 低 | 无 |
| `svc-kms` | AWS KMS：数据加密密钥 | 中级 | 75 / 120 | L0 + iam；种子 `gps-sample-photos` | — | A | 低 | 无 |

**依据**：模块事实取自 [00-ec2-base.md](../../modules/00-ec2-base.md)、[01-edge-network-scaling.md](../../modules/01-edge-network-scaling.md)、[02-identity-security.md](../../modules/02-identity-security.md)；依赖取自 [modular-design.md](../../modular-design.md) §3.2 模块总表、§5.2 规则表；卡片格式取自 [04-lab-format-checks-reports.md](../04-lab-format-checks-reports.md) §3（`atl.lab/v2`）；名称（栈、角色、标签、路由、实体）只引用 [01-architecture.md](../01-architecture.md) 的名称表（C1）；CloudAlbum 侧的平台模式能力（探测端点、CLI、种子、实验变体标签等）只引用 [06-cloudalbum-platform-mode.md](../06-cloudalbum-platform-mode.md)（C5）；难度、时长与费用档位的判定沿用 [05-lab-catalog.md](../05-lab-catalog.md) 的目录总则；学习路径、掌握度与徽章以 [tracks-and-catalog.md](tracks-and-catalog.md) 为准。本文不修改这些文件，需要它们配合的地方集中写在**附录 B**。不写金额与精确的性能数字，费用只给档位和主要计费来源。

**名称约定**：`<envName>` 是本环境的 CloudAlbum Env 名（`e` 加 7 位小写字母数字，例如 `e7k2m9qx`，01）；栈名一律 `cloudalbum-<envName>-<模块>`，手册与检查中用变量 `{{ session.env }}` 表示。模块文档里固定写死的少数名称（IP 集合 `cloudalbum-blocklist`、`cloudalbum-lab-allow`，响应头策略 `cloudalbum-lab`，缓存策略 `cloudalbum-media` 等）照模块文档原样引用。

---

## 目录

- [1. 本批通用约定](#1-本批通用约定)
- [2. svc-ec2](#2-svc-ec2amazon-ec2运行整个应用) · [3. svc-network](#3-svc-networkamazon-vpc网络隔离) · [4. svc-cdn](#4-svc-cdnamazon-cloudfront内容分发与边缘缓存) · [5. svc-dns](#5-svc-dnsamazon-route-53域名解析) · [6. svc-tls](#6-svc-tlsaws-certificate-managerhttps-证书) · [7. svc-waf](#7-svc-wafaws-wafweb-应用防护) · [8. svc-load-balancer](#8-svc-load-balancerelastic-load-balancing负载均衡alb) · [9. svc-autoscaling](#9-svc-autoscalingamazon-ec2-auto-scaling弹性伸缩)
- [10. svc-iam](#10-svc-iamaws-iam服务器访问-aws-的凭证) · [11. svc-auth](#11-svc-authamazon-cognito-user-pool用户注册登录) · [12. svc-identity-pool](#12-svc-identity-poolamazon-cognito-identity-pool终端用户直传-s3) · [13. svc-secrets](#13-svc-secretsaws-secrets-manager密码与密钥管理) · [14. svc-config](#14-svc-configaws-systems-manager-parameter-store运行时配置) · [15. svc-kms](#15-svc-kmsaws-kms数据加密密钥)
- [附录 A：svc-ec2 的完整 lab.yaml](#附录-asvc-ec2-的完整-labyaml)
- [附录 B：发现的现有设计问题与回写建议](#附录-b发现的现有设计问题与回写建议)
- [审稿修订记录](#审稿修订记录)

---

## 1. 本批通用约定

### 1.1 startProfile 的计算规则

本节落实主设计者裁决 C3（04 §3.2.3 是它在内容格式中的规范写法）。

1. **起始状态 = `l0-ec2` + iam(role) + 目标模块硬依赖的闭包**。闭包按目标模块的目标取值，在 registry `requires` 与规则表中递归求解；`a | b` 的分支取“可自动满足、费用更低”的一支，理由写在卡片元数据中（04 `startProfile.branches`）。
2. **iam(role) 一律预置**（`IAM_CREDENTIALS=role`；平台模式下 `enable iam` 走 `AppRoleMode=existing`，只附加 iam 自己的只读策略，01）。这包括目标模块为 `credentials: optional` 的卡片（network、cdn、dns、tls、waf、load-balancer），它们因此不再出现 CRED-004，控制面子功能（CloudFront 失效按钮、WAF IP 集合同步、目标健康查询、证书续期状态等）在 `/lab` 中可用。**例外**：`svc-ec2`（“没有任何 AWS 模块”的基线）与 `svc-iam`（目标就是 iam）不预置。第 1 轮“optional 不并入 iam”的写法与附录 B-4 的二选一随之作废。
3. **“正常”允许预期警告**：总纲 §5.3 规定 warn 级规则会把关联模块至少标为 `degraded`。卡片在元数据中声明 `expectedWarnings`（04 §3.2.5），capability 检查用 `op: healthy`（04 §5.3）：`status=ok`，或 `status=degraded` 且导致降级的规则**全部**属于本卡声明的预期警告、`validation.errors` 为空，才算正常。本批的预期警告见总表；同一列表也用于 02 的健康门 `caps.profile`（起始状态中的模块同样适用，例如 svc-network、svc-autoscaling 起始状态里的 load-balancer 会有 SEC-002、DEP-011）。某一步之后才允许出现、或之后必须消失的警告，用检查级 `expectedWarnings`（只能是卡片级列表的子集）表达，例如 svc-waf 锁定源站后的检查写 `expectedWarnings: []`。没有规则 ID 的 `degraded`（探针失败、置信度不足）不算正常。
4. **不直接使用 `single/<id>` 档位**：它包含目标模块本身。起始状态由 `scripts/module plan --start-of <卡片 id> [--variant <id>] --platform --json` 推导（06），构建期生成档位 `atl/<卡片 id>/<variant>`（默认变体写全为 `atl/<卡片 id>/default`，文件 `profiles/atl/<卡片 id>/<variant>.env`，01 §3.9；第 3 轮由短名 `atl/<卡片 id>` 改写）；`startProfile.provisions` 中 `kind: module | local | runtime` 的条目必须与 plan 的输出逐项相同（04 §3.2.3 的构建期核对）。
5. **目标模块的前驱取值**：目标模块以本地档或前驱取值出现在起始状态时，写 `basis: precursor` 与 `targetModules[].fromDriver`（04 §3.2.4，取代 v1 lint 第 4 条）。第 2 轮起本批没有这种卡片：第 1 轮 svc-network 的“`public` 预置 → `private`”已移交场景卡 `sc-private-network`，svc-network 改为“默认 VPC → `public`”（见第 3 节开头的说明）。
6. **平台固定部分**（不是模块，不参与推导，只向学员说明）：`mgmt-channel`（实验机挂只含 `AmazonSSMManagedInstanceCore` 的 `CloudAlbumAppRole`，是平台管理通道，不是应用权限）、`workstation`、`check-bundle`（检查包随 CloudAlbum 发布包分发，06）、`preview-direct-https`（方案 B：Let's Encrypt IP 证书，`TLS_MODE=letsencrypt`、`TLS_LE_PROFILE=shortlived`）。按 C5，`svc-tls`（要从自签名讲起）与 `svc-autoscaling`（ASG-014 禁止 `DEPLOY_MODE=asg` 与 `letsencrypt` 同时出现）在 `startProfile.platform.preview.directHttps` 中关闭方案 B。
7. **含 network 的起始状态**：开始编排先在默认 VPC 部署 L0 基础栈（运行器 `base-deploy`），再 `profile-apply`（02 §4.3）；起始状态含 network(public) 时（本批没有，场景卡 `sc-private-network` 有），`profile-apply` 会执行一次“迁入自定义 VPC”的分阶段实例替换（01#network §6），部署等级至少为 B。`profile apply --fresh` 是否进入 v1 以 02 为准，本批不依赖它。
8. **本地档与种子**：本地档调整写成 `kind: local` 的 provisions；测试数据写成 `kind: seed`，种子 id 取自 06 的种子登记表（本批用到 `cognito-test-users`、`gps-sample-photos`），由 02 的运行器在 `profile-apply` 之后执行，不参与推导。

**与 05 起始状态原则的关系**：S1、S3、S4、S6、S7、S8、S9 与本节一致。S2（`credentials: optional` 的目标模块也加入 iam）已由 C3 采纳为通则。S5（VPC 绑定的卡片以 `network(public)` 起步）不采用：C3 的起始状态只含硬依赖闭包，单服务卡片不预置 network（`svc-network` 除外），见附录 B-18。

### 1.2 费用档位

采用 05 §2.7.3 的判定（只看计费结构，构建期可算）：L0 与工作台是“基础”，不计入；**低** = 没有额外的按小时计费资源，其余全是按量或按月折算的小额固定项（客户托管密钥、托管区域、Web ACL、Secrets Manager 密钥等）；**中** = 额外的按小时计费资源恰好 1 个单位，或会话期间开启了账号级按量服务；**高** = 额外的按小时计费资源 ≥ 2 个单位。起始状态中预置的模块同样计入单位。

| 档位 | 本批 | 计入的按小时计费单位 |
|---|---|---|
| 低 | ec2、network、cdn、dns、tls、waf、iam、auth、identity-pool、secrets、config、kms | 无（iam 不计费；network 的 public 放置不建 NAT 与接口终端节点） |
| 中 | load-balancer | ALB × 1 |
| 高 | autoscaling | ALB + RDS + ASG 中的 2～4 台实例 |

金额由 01/02 的报价接口按 04 §3.4 的计费维度与 Price List 单价在开始前给出区间（不是仓库内的示例价），本文不写。可延长次数：全部卡片 2 次 × 30 分钟（与 05 一致，02 平台默认）；高档位卡片改为限制“保留环境”最长 12 小时（`retain.maxHours: 12`，其余 24 小时），以此控制持续计费。

### 1.3 难度

采用 05 §2.7.1 的判定标准（满足任一条即归入较高一级）：

| 难度 | 判定标准 | 本批 |
|---|---|---|
| 入门 | 不启用任何 AWS 模块；只观察、运行脚本与冒烟测试；没有等待型步骤 | ec2 |
| 初级 | 1～2 个模块，概念集中在单个服务；没有 VPC 绑定资源，没有数据迁移风险；以脚本与控制台为主 | iam、config |
| 中级 | 多个服务相互配合（边缘、身份、事件路由、加密）；或需要等待云端生效（分配部署、DNS、证书）；或需要理解网络与权限的交互；或有账号级影响（05 原文）。secrets、kms 有密钥迁移风险，不满足“初级”的“没有数据迁移风险”，因此归入中级；load-balancer 有 VPC 绑定资源，同理；network（public）有一次卡内实例替换，但没有替换后的故障演练与多个按小时计费资源（tracks-and-catalog §1.6 的高级判据），归入中级 | network、cdn、dns、tls、waf、load-balancer、auth、identity-pool、secrets、kms |
| 高级 | 数据迁移与实例替换后的故障演练、多 AZ、机群切换；或同时运行多个按小时计费的资源，出错的代价高 | autoscaling |

时长按 05 §2.7.2：预计时长是熟练学员完成全部**必需**步骤的典型用时（含实验中的云端等待、不含环境准备），取 15 分钟的整数倍；时间上限取 30 分钟的整数倍且 ≥ 预计 × 1.5。`difficulty` 用 04 v2 的四级 `intro | beginner | intermediate | advanced`（C2）。

### 1.4 检查的写法

步骤表中“检查”一列写成 `类型：判定要点`。类型简写：`LOCAL`（local，经 ATL-RunCheck，写出 checkId）、`CAP`（capability；“`healthy`”即 04 §5.3 的 `op: healthy`，按本卡 `expectedWarnings` 判定）、`HTTP`（http-header，写出 `from` 与 `target`）、`AWS`（aws-readonly，写出 `service:Action`，`action` 为 SDK 操作名，04 §5.7；凡是判定会话资源的都带 `ownership`：学员在本卡创建的用 `session`，起始状态创建的用 `session-or-start`）、`EXP`（experiment，写出 `模块/场景(变体标签)`）、`MAN`（manual）。所用的只读 action 都在 04 §5.7 的白名单内。

**书写约定**：

1. **描述起始（before）状态的检查一律 `drift: once`**（C3；04 §3.5 第 9 条把漏写列为 lint 错误）。“`cdn` 的 `driver=direct`”“`secrets` 的 `driver=env`”这类断言在启用目标模块后必然变为 fail，按 must-hold 处理会被最终复核判为漂移。下文步骤表中这类检查标注“（once）”。
2. **平台请求 CloudAlbum 的探测端点统一为 `/api/lab/probe/*`**（C5）：`now`、`echo`、`media-url`，以及按模块的 `auth`、`identity-pool`、`kms` 等，请求头 `X-ATL-Probe-Token`；端点清单、令牌（本机令牌 / 一次性令牌）与各端点经过的端口以 06 为准，引擎在路径以 `/api/lab/probe/` 开头时自动附带令牌（04 §5.2.3）。第 1 轮写的 `/api/console/probe/*`、`/api/lab/now`、`/api/lab/echo` 一律作废。
3. **在实验机上执行的实验脚本也从工作台发起**：leak-scan、imds-ssrf、ciphertext-view、key-file-risk、rotate-under-load 的手工轮换等需要在实验机上执行命令的部分，由工作台上的运行器经 SSM Run Command 投递，结果从工作台上传（上传接口按 `atl-<sid>-ws` 会话名绑定会话，实例角色不能调用）。学员在实验机终端里手动运行同一脚本只用于观察，不计入完成。
4. **归属只认创建证据，不认标签**（04 §5.2.4）：模块栈成员、02 台账、父资源，最后是 02 的**定向扫描** `OwnershipLookup`（C4(e)：CloudTrail 事件历史 `LookupEvents`，按资源名查询、在结果中按事件名与会话名过滤；全局服务——CloudFront、IAM、Route 53——的事件在 us-east-1 查询）。管理事件进入事件历史有分钟级延迟（以官方文档为准），所以学员在控制台刚创建的资源第一次检测通常是 `OWNERSHIP_PENDING`（界面显示“正在确认”，不是失败），之后按 2、2、4、4、8 分钟的间隔重试，默认最多等 20 分钟。手册**不要求**学员手工补打 `atl:` 标签。
5. **会中断管理通道的步骤**声明 `expectedOutage`（04 §3.2.8），平台动作声明 `interruptsManagementChannel: true`：窗口内的 `CHANNEL_DOWN` 显示为“预期中断”，不覆盖此前的通过结果。

### 1.5 平台模式下的共性差异（各卡片不再重复）

- `scripts/module`、`npm run exp` 在**工作台终端**以学员身份执行（会话名 `atl-<sid>-ws`）；实验机终端经 SSM 进入实验机。平台模式下 `scripts/module` 一律经 SSM 投递配置；`state.json` 在环境状态桶 `cloudalbum-lab-state-<acct>-<region>` 的 `<envName>/` 前缀下，环境操作锁在 DynamoDB 表 `cloudalbum-lab-locks` 中（C4(c)），学员、运行器与回收器共用同一份状态。
- 栈标签：`scripts/module` 在平台模式下给栈打 `atl:component=env`、`atl:session-id`、`atl:lab-id=<卡片 id>`、`atl:env-id`、`Project=CloudAlbum`（C4(d)；学员边界只保护 `atl:component` 的取值 `platform`、`workstation`）。实验机与工作台按 `atl:env-id` + `atl:role` 发现（01），复用环境后新会话照样找得到实验机。
- 对比实验从工作台（ap-northeast-1）发起：`npm run exp -- <模块> --label <变体> --scenario <场景> --upload`（参数形式以 06 为准）。`--label` 接受卡片 `experiments[].labels` 中声明的**任意变体**（`before`、`after`、`l0`、`unsafe`、`workers-2` 等），平台在结果中标注 `variant`（C5，04 §3.2.10）；未声明的标签在登记时被拒绝。模块文档中“从四个区域的 CloudShell 发起”的部分一律作为选做（附录 B-9）。
- 回收由 02 的 `atl-session-end`（运行器 `ATL_OP=destroy`，即 `scripts/module env destroy --fast`）+ 回收器 `atl-reaper` 完成：`Retain` 资源经 `RETAINED` 来源、数据卷经派生规则、栈外资源经 `state.json` 带外段与 CloudTrail 扫描（含 us-east-1）进入台账；User Pool 先关删除保护、Secrets Manager 不留恢复窗口、KMS 计划删除由 02 处理。各卡片“清理说明”只写学员需要知道或需要自己做的事。
- 每张卡片的 `finalChecks` 都包含共享检查 `no-world-ssh`（实验机安全组没有对 0.0.0.0/0 开放 22 端口；第 1 轮写作 `lab-no-world-ssh`）。
- **徽章只看完成**（C3）：单张卡片完成（最终复核通过）即颁发该卡徽章；小测不影响完成，也不影响徽章，历次最好成绩只**记录在徽章上**。证书只由学习路径颁发（模型以 tracks-and-catalog 为准）。

---

## 2. svc-ec2：Amazon EC2：运行整个应用

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-ec2` |
| kind | `service` |
| 标题 | Amazon EC2：运行整个应用 |
| 一句话简介 | 只有一台 EC2 时 CloudAlbum 的全部功能就能运行；看清它为什么“可替换”，又为什么仍是单点。 |
| 涉及的 AWS 服务 | Amazon EC2（主）；Amazon EBS、弹性 IP（公网 IPv4）、默认 VPC 与安全组、IMDSv2（辅）；AWS Systems Manager（只观察：平台管理通道） |
| 对应的模块 | `ec2`（base） |
| 难度 | 入门（所有学员的第一张卡） |
| 预计时长 / 时间上限 / 可延长 | 60 分钟 / 90 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2`（档位 `atl/svc-ec2/default`），**C3 例外：不预置 iam**——本卡就是“没有任何 AWS 模块”的基线。逐项：① **ec2**——基础栈 `cloudalbum-<envName>-ec2`（实例 t4g.small、gp3 根卷、独立 gp3 数据卷、EIP、安全组），由运行器 `base-deploy` 部署，没有任何模块依赖；② 平台固定部分：`mgmt-channel`（`CloudAlbumAppRole` 只有 SSM 核心策略，应用仍是 `IAM_CREDENTIALS=none`）、`workstation`、`check-bundle`、`preview-direct-https`（方案 B 的 IP 证书，保持开启，供预览嵌入） |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | 无。ec2 是基础模块，不能启用或禁用；本卡只观察和演练（附录 A 的 `targetModules: []`） |
| 费用档位与主要计费来源 | 低：EC2 按需实例小时；EBS 根卷与数据卷按 GB-月；公网 IPv4 按小时（EIP 未关联时同样计费）；选做的重建演练产生一个 EBS 快照 |
| 人工前置 | 无 |
| SAA 考试领域 | 弹性、安全、成本 |
| 推荐的前置卡片 | 无 |
| 徽章 | “EC2 基线” |

### 实验简介

**背景**：CloudAlbum 的 L0 只有一台 EC2：Nginx、api、worker、SQLite 和上传文件都在这台机器上，应用不加载 AWS SDK、不调用任何 AWS API。它与“传统单机部署”最大的区别是：数据、机密与本地配置都在独立数据卷上（`/etc/cloudalbum → /var/lib/cloudalbum/etc`），根卷可以随时重建。但它仍然是单点——停掉实例就是全站中断。

**你将学到**
- 认识 L0 的组成：实例、根卷与独立数据卷、弹性 IP、安全组、IMDSv2。
- 为什么实例“可替换”：机密与数据在数据卷上，换实例不会重新生成密钥（D5）。
- IMDSv2 的会话令牌如何挡住只能发 GET 请求的 SSRF。
- 停机 = 全站不可用；EIP 让公网地址在停止再启动后保持不变。
- 平台管理通道（实验机上的 SSM 角色）与“应用自己的 AWS 身份”是两回事。

**实验资源**：栈 `cloudalbum-<envName>-ec2`（实例、两块 gp3 卷、EIP、安全组 `cloudalbum-<envName>-ec2-sg`）；工作台；实验脚本 `experiments/ec2/`（`smoke`、`single-point-of-failure`、`imds-probe`、`rebuild-drill`、`cpu-credits`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | 认识实验机 | 控制台 | 在 EC2 控制台查看：IMDSv2 必需、跳数 1；两块卷，数据卷 `DeleteOnTermination=false`、带 `Backup=true`；EIP；实例配置文件是 `CloudAlbumAppRole` | `AWS`：`ec2:DescribeInstances`（`session-or-start`）——`MetadataOptions.HttpTokens=required`、`HttpPutResponseHopLimit=1`、挂载 2 块卷、实例配置文件名为 `CloudAlbumAppRole`；`AWS`：`ec2:DescribeVolumes`——数据卷 `Encrypted=true`、带 `Backup=true`；`MAN`：回答“这个角色是给谁用的”（平台管理通道，不是应用） |
| 2 | 用一遍相册 | 观察（应用预览） | 注册 → `/me/outbox` 打开验证邮件 → 上传照片 → 等缩略图 → 点赞评论 → F14 多文件分片上传；在 DevTools 中看 `X-CloudAlbum-Path`、`Server-Timing` | `HTTP`（`from: platform`，`target: public-ip`，`/api/health/ready`）：200，`entry=nginx`；`CAP`：`ec2` 的 `driver=single`、`healthy`；`CAP`：`iam` 的 `driver=none`、`status=off`（应用没有 AWS 凭证；本卡没有目标模块，iam 全程不变，按 must-hold） |
| 3 | 主机巡检：数据和机密在哪里 | CLI（实验机终端） | `findmnt /var/lib/cloudalbum`、`readlink /etc/cloudalbum`、`stat` 机密文件、`ss -ltn`、`systemctl list-timers 'cloudalbum-*'` | `CAP`（`view: admin`）：`ec2.checks` 中 `data-volume=ok`（感知器已核对独立挂载点、xfs、rw、设备不同于根卷、`/etc/cloudalbum` 指向数据卷；`LOCAL disk-usage` 只返回 `fstype`，而 AL2023 根卷同样是 xfs、两块卷同为 20 GiB，不能证明“独立挂载”）；`LOCAL file-stat`（`/etc/cloudalbum/secrets.env`）：`0640`、`root:cloudalbum`；`LOCAL port-listen`（3000）：只监听 `127.0.0.1` |
| 4 | IMDSv2 与 SSRF | CLI（实验机终端） | 不带令牌 `curl` IMDS → 401；`PUT /latest/api/token` 后带令牌 → 200；选做：把跳数临时改为 2 再改回 | `LOCAL imds-get`（`checkV1Rejected`）：`v1Status=401`；`EXP ec2/imds-probe(l0)`（选做部分不计入完成） |
| 5 | 记录 L0 基线 | 脚本 | 工作台执行 `npm run exp -- ec2 --label l0 --scenario smoke --upload` | `EXP ec2/smoke(l0)`：一次性实验（变体 `l0`，角色 `single`，`validity: functional`），S01～S26 通过（平台模式下 S02 的判定改为“实例配置文件只有平台管理策略”，附录 B-13） |
| 6 | 单点故障演练 | 对比实验 | 运行 `npm run exp -- ec2 --label l0 --scenario single-point-of-failure --upload`：工作台每 5 秒探测一次 `/api/health/live`，学员在控制台停止实例、等待、再启动。本步声明 `expectedOutage`（`channel: lab`，最长 15 分钟）：停机期间实验机终端与本地检查显示“预期中断” | `EXP ec2/single-point-of-failure(l0)`（`validity: functional`）：记录不可用时长；佐证：`LOCAL systemd-unit`（`amazon-ssm-agent`）的 `since` 晚于演练开始（实例确实停止并重新启动过；停机期间实例上的指标采集也停了，`lab-metrics-run` 交叉校验看不到这段时间）；`AWS`：`ec2:DescribeAddresses`——EIP 仍关联同一实例、地址等于 `{{ target.publicIp }}`；`CAP`：恢复后 `ec2` 为 `healthy` |
| 7 | （选做）重建实例：实例可替换 | 脚本 | `scripts/module rebuild-instance`：只读窗口 → 快照 → 换实例槽位 → 改挂数据卷；实例 ID 改变，已有账号仍能登录（`expectedOutage`：`lab`，最长 20 分钟） | `EXP ec2/rebuild-drill(rebuild)`；`CAP`（`view: admin`）：`ec2.checks` 中 `key-fingerprint=ok`、`data-volume=ok`（指纹未变） |

### 对比实验

ec2 没有“有/无”对比（00-ec2-base §9：它的实验是**验证 L0 的性质**）。本卡把“传统单机部署的做法”与“L0 的做法”放在一起对照（00 §12）：

| 观察点 | 没有（传统做法 / 改动前） | 有（L0 的做法） | 实验 |
|---|---|---|---|
| 公网地址 | 没有 EIP：停止再启动后自动分配的公网 IPv4 会变（只在说明中演示，不改 L0） | EIP：停止再启动后地址不变 | `experiments/ec2/single-point-of-failure` |
| 数据与机密的位置 | 在根卷上：重建实例 = 数据丢失、密钥重新生成、已加密字段解不开 | 在独立数据卷上：重建后实例 ID 变、密钥指纹不变 | `experiments/ec2/rebuild-drill` |
| 实例元数据 | IMDSv1：任何 GET 请求都能读到元数据 | IMDSv2：不带令牌返回 401 | `experiments/ec2/imds-probe` |
| 单点 | 停止实例 = 全站不可用 | 同左——L0 也是单点，这正是 load-balancer、autoscaling、backup 卡片要解决的问题 | `single-point-of-failure` |
| 突发性能（选做） | `unlimited` 不知不觉产生积分费用 | `standard`：积分耗尽后 CPU 被压在基线，可以观察 | `experiments/ec2/cpu-credits` |

### 小测

1. **（单选）** 一台 EC2 上的应用需要在“换实例类型、换 AMI、重建实例”之后保留上传文件与配置，并且能单独做快照。最合适的做法是：
   A. 把数据放在实例存储上　B. 放在单独的 EBS 数据卷上，并让它的 `DeleteOnTermination=false`　C. 放在根卷上并保持 `DeleteOnTermination=true`　D. 放在 `/tmp`
   **答案：B**。解析：实例存储在实例停止、终止或硬件故障时丢失；根卷默认随实例终止而删除；独立 EBS 卷的生命周期与实例无关，可以卸下改挂到新实例、单独快照与扩容。注意 EBS 卷绑定 AZ，跨 AZ 只能经快照。
2. **（单选）** 安全团队担心 Web 应用的 SSRF 漏洞被用来读取实例角色凭证。下列哪项措施最直接？
   A. 强制使用 IMDSv2（`HttpTokens=required`）　B. 关闭安全组的全部出站规则　C. 用 NACL 拒绝 169.254.169.254　D. 把实例换到更大的实例类型
   **答案：A**。解析：IMDSv2 要求先用 PUT 请求取得会话令牌并在请求头中携带，典型的 SSRF 只能让服务器发出 GET 请求，拿不到令牌。实例元数据服务是实例本地的链路地址，访问它不经过子网边界，NACL 无法用来控制；关闭出站规则会破坏正常功能且同样不影响 IMDS。
3. **（多选，选 2 项）** 关于弹性 IP 与公网 IPv4，下列说法正确的是：
   A. 没有 EIP 的实例停止再启动后，自动分配的公网 IPv4 通常会改变　B. 未关联到运行中实例的 EIP 不收费　C. 公网 IPv4 地址（包括 EIP）按小时计费　D. EIP 可以直接迁移到另一个区域使用
   **答案：A、C**。解析：AWS 对所有公网 IPv4 地址按小时计费，未关联的 EIP 同样计费；EIP 是区域资源，不能跨区域使用。

### 清理说明

- 平台回收会删除基础栈。数据卷设置了 `DeletionPolicy: Retain`，栈删除后它作为 `RETAINED` 资源进入台账，由回收器删除（02 §6.5、§7.4 的派生规则“`DeleteOnTermination=false` 的卷”），学员不需要手动删卷。平台模式不使用 `scripts/teardown --purge-data`。
- 第 6 步停止实例后**一定要再启动**：预期中断窗口（最长 15 分钟）内检测显示“预期中断”；窗口结束后实例仍未启动，检测就是 `CHANNEL_DOWN`，最终复核无法通过，倒计时照常走。
- 第 4 步如果把跳数改成了 2，结束前改回 1。
- 选做的重建演练会留下一个带 `Reason=pre-replace` 标签的快照，快照中含 `secrets.env`。由回收器删除；不要把它复制到其他区域或共享给其他账号。

### 对应 SAA 考点

EBS 卷与实例的生命周期相互独立、`DeleteOnTermination` 的默认值、EBS 绑定 AZ 与快照跨 AZ/跨区域；实例存储与 EBS 的持久性差异；弹性 IP 与公网 IPv4 计费；IMDSv2、跳数限制与 SSRF；User Data 与 `CreationPolicy` + `cfn-signal`；用 SSM 公共参数解析最新 AMI；T 系列 CPU 积分（standard / unlimited）；安全组有状态、只有允许规则；高可用与“有备份”的区别。

---

## 3. svc-network：Amazon VPC：网络隔离

> **第 2 轮改写**：目标从“`public` → `private`”改为“默认 VPC → 自定义 VPC（`public` 放置）”，与 tracks-and-catalog 的 T6、P-1 及 `saa-main` 中原 Lab 14 的映射一致；`private` 放置（入口 ALB、NAT、EIC Endpoint、`endpoint-only`）由场景卡 `sc-private-network`（原 Lab 20）承担。理由：C3 的起始状态是“L0 + iam(role) + 目标模块硬依赖的闭包”，`public` 放置的闭包为空；而 `private` 放置要同时具备入口、出网、运维通道（DEP-009），天然是多服务组合，放在单服务卡里会把大半个场景塞进起始状态，也会让“迁入自定义 VPC”这一步没有卡片承载。第 1 轮的 private 内容（含 B-6 的终端节点问题）随之移交 `sc-private-network`。

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-network` |
| kind | `service` |
| 标题 | Amazon VPC：网络隔离 |
| 一句话简介 | 把实验机从默认 VPC 迁进自己设计的分层 VPC：看懂公有、应用、数据三层子网与路由表，用 Flow Logs 看见被拒绝的流量；也亲眼确认“只换 VPC、不换放置”并不会减少攻击面。 |
| 涉及的 AWS 服务 | Amazon VPC（主：VPC、子网、路由表、IGW、NACL、网关终端节点、VPC Flow Logs）；Amazon EC2（实例替换、EBS 数据卷改挂、EIP 重新关联）；CloudWatch Logs（Flow Logs 目标） |
| 对应的模块 | `network` |
| 难度 | 中级（需要理解网络与权限的交互，并经历一次有停机窗口的实例替换；没有多 AZ 故障演练，也没有多个按小时计费的资源） |
| 预计时长 / 时间上限 / 可延长 | 90 分钟 / 150 分钟 / 2 次 × 30 分钟（实例替换约 10～25 分钟） |
| startProfile | `l0-ec2` + `iam`（档位 `atl/svc-network/default`）：`public` 放置的硬依赖闭包为空（总纲 §3.2：“`public`：—”）；iam(role) 按 C3 预置，network 的控制面感知（`DescribeVpcs` 确认 `IsDefault`、路由表、终端节点）因此是 `confirmed`。DEP-016 只在 `VpcId` 变化且已有 VPC 绑定模块时触发，起始状态没有 VPC 绑定模块，不会触发 |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | `network`：`NETWORK_PLACEMENT` `default` → `public`（`NatMode=none`、`InterfaceEndpoints=none`、`FlowLogDestination=cloudwatch`）。network 不在起始状态中，不需要 `fromDriver` |
| 费用档位与主要计费来源 | 低：自定义 VPC、子网、路由表、IGW、网关终端节点、NACL 不收费；Flow Logs 写入 CloudWatch Logs 的摄取与存储；迁移时的保险快照（EBS 快照按 GB-月）；EIP 照常按小时计费（与 L0 相同） |
| 部署等级 | A（起始状态只有 L0 + iam；实例替换发生在卡内，只影响时长） |
| 人工前置 | 无 |
| SAA 考试领域 | 安全、弹性、成本 |
| 推荐的前置卡片 | `svc-ec2`；之后：`sc-private-network`（私有化） |
| 徽章 | “自定义 VPC” |

### 实验简介

**背景**：L0 的实验机放在默认 VPC 的默认公有子网里：每个 AZ 一个 /20，主路由表 `0.0.0.0/0 → IGW`，所有东西都“直接在公网上”。以后要放数据库、缓存、私有实例，就需要自己设计的分层 VPC。实例不能“搬”到另一个 VPC，只能新建；CloudAlbum 的数据与机密都在独立数据卷上，所以迁移是“换一台新实例、把数据卷改挂过去、核对密钥指纹”。迁入后实验机仍在**公有**子网、仍挂原 EIP——攻击面不变，这正是要讲清楚的一点：隔离来自放置方式与路由，不来自“换了一个 VPC”。

**你将学到**
- 默认 VPC 与自定义 VPC；“公有子网”的定义：它的路由表里有指向 IGW 的路由。
- 三层子网（public / app / data）、路由表、data 子网没有默认路由；NACL 无状态、要放行临时端口。
- 网关终端节点（S3、DynamoDB）只对关联了它的路由表生效。
- 实例不能跨 VPC 移动：分阶段替换、数据卷改挂、EIP 重新关联、密钥指纹校验；EBS 绑定 AZ。
- 用 VPC Flow Logs 看 ACCEPT / REJECT 与 `traffic-path`，以及它不记录哪些流量。

**实验资源**：栈 `cloudalbum-<envName>-network`（VPC 10.0.0.0/16、三层子网、IGW、S3/DynamoDB 网关终端节点（关联 app 与 data 路由表）、data 子网 NACL、Flow Logs 与日志组 `/cloudalbum/<envName>/vpc-flow`）；迁移时的保险快照；实验脚本 `experiments/network/`（`surface-scan`、`egress-path`、`scan-count`、`cost-inventory`）。

**平台约束**：迁移会替换实验机，期间实验机终端与本地检查不可用（预期中断）。新实例在 public 子网先用自动分配的公网 IPv4 完成引导，收到 `cfn-signal` 后原 EIP 重新关联，所以公网地址、方案 B 的 IP 证书与平台的 `target: public-ip` 检查在迁移后照常可用；新实例同样挂 `CloudAlbumAppRole`、带 `atl:env-id` 与 `atl:role=lab-app`，平台按标签重新发现它。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | 认识默认 VPC | 控制台 | 在 VPC 控制台查看实验机所在 VPC：`默认 VPC = 是`、每个 AZ 一个默认子网、主路由表 `0.0.0.0/0 → igw-…`；`/lab` 网络卡片显示“默认 VPC · 公有子网” | `AWS`：`ec2:DescribeInstances`（`ownership: session-or-start`）——取出 `VpcId`（检查 id `lab-vpc-before`，证据保留 `VpcId`；once）；`AWS`：`ec2:DescribeVpcs`（`VpcIds` 取 `{{$check.lab-vpc-before…}}`）——`IsDefault=true`（once）；`CAP`：`network` 的 `driver=default`、`status=off`（once） |
| 2 | before：攻击面与出网路径 | 对比实验 | `npm run exp -- network --label before --scenario surface-scan --upload`（目标：实验机 EIP，从工作台发起）；`--scenario egress-path` | `EXP network/surface-scan(before)`：EIP 上 80/443 开放；`EXP network/egress-path(before)`：出网 IP 等于实验机 EIP，S3/DynamoDB 经公网端点 |
| 3 | 读懂迁移计划 | 观察 + 脚本 | `scripts/module enable network --placement public --dry-run`：读计划——新建 VPC 与三层子网、DEP-016 检查结果（当前没有 VPC 绑定模块，所以通过）、实例将被替换、数据卷在同一 AZ 改挂、EIP 重新关联、预计停机窗口 | `MAN`：回答“为什么必须替换实例”“迁移前要先处理哪些模块（DEP-016）” |
| 4 | 迁入自定义 VPC（接入应用） | 脚本 | `scripts/module enable network --placement public`：部署 network 栈 → 只读窗口 → 保险快照 → 卸卷 → 实例替换到新 VPC 的 public 子网（同 AZ）→ 挂卷 → `cloudalbum-postattach` → 密钥指纹校验 → EIP 重新关联 → 关闭只读；等待 10～25 分钟。本步声明 `expectedOutage`（`channel: lab`，最长 25 分钟） | `CAP`：`network` 的 `driver=public`、`healthy`；`HTTP`（`from: platform`，`target: public-ip`，`/api/health/ready`）：200，`entry=nginx`（同一个 EIP，链接不变）；`CAP`（`view: admin`）：`ec2.checks` 中 `key-fingerprint=ok`、`data-volume=ok`；`AWS`：`ec2:DescribeVpcs`（`VpcIds: [{{ stack.network.EnvNetworkVpcId }}]`，`ownership: session`：VPC 由学员这一步经 network 栈创建）——`IsDefault=false`、`CidrBlock=10.0.0.0/16`；`AWS`：`ec2:DescribeInstances`——实验机的 `VpcId` 等于该 VPC，仍有 `PublicIpAddress` |
| 5 | after：攻击面没有变 | 对比实验 | 同第 2 步，`--label after` | `EXP network/surface-scan`：`pair: [before, after]`——两次的开放端口相同（public 放置下攻击面不变）；`EXP network/egress-path`：`pair: [before, after]`——出网 IP 仍是同一个 EIP |
| 6 | 路由表与网关终端节点 | 观察 + CLI | 对比 public、app、data 三张路由表：public 有 `0.0.0.0/0 → IGW`；app、data 有 S3/DynamoDB 前缀列表 → `vpce-…`；data 没有默认路由。思考：为什么实验机（在 public 子网）访问 S3 仍走 IGW | `AWS`：`ec2:DescribeRouteTables`（`Filters: vpc-id`）——public 路由表含 `0.0.0.0/0 → igw-…`；data 路由表没有 `0.0.0.0/0`；app 路由表含 S3 前缀列表 → `vpce-…`；`MAN`：回答“网关终端节点对哪些子网生效” |
| 7 | Flow Logs 与 NACL | 控制台（Logs Insights） | 在 `/cloudalbum/<envName>/vpc-flow` 中按 `dstport` 统计 REJECT、按 `traffic-path` 统计出站字节；查看 data 子网 NACL 的入站与出站临时端口规则；`cost-inventory` 列出本 VPC 中按小时计费的网络资源（此卡只有公网 IPv4） | `AWS`：`ec2:DescribeFlowLogs`——存在、`TrafficType=ALL`；`AWS`：`ec2:DescribeNetworkAcls`——data 子网 NACL 出站放行 1024–65535；`MAN`：填写 REJECT 次数最多的目的端口；`EXP network/cost-inventory(after)` |
| 8 | （选做）私有化预告 | 观察 | `scripts/module enable network --placement private --dry-run`（不带 ALB、NAT、EIC）：读 DEP-009 的拒绝信息；对照 `sc-private-network` 的起始状态，说出入口、出网、运维通道分别由什么满足 | `MAN`：选出 DEP-009 要求的三项 |

### 对比实验

引用 `experiments/network/`（01#network §5）。before = L0（默认 VPC），after = 自定义 VPC 的 public 放置。主对比只能切换前后测量（实例只能在一个子网里）。

| 观察点 | 没有（默认 VPC / L0） | 有（自定义 VPC，public 放置） |
|---|---|---|
| 子网结构 | 每个 AZ 一个 /20 默认公有子网 | public / app / data 三层，每层两个 AZ |
| 外部端口扫描 | EIP 上 80/443 开放 | **相同**——实验机仍在公有子网、仍挂原 EIP |
| 出网 IP | 实验机自己的 EIP | 相同 |
| 访问 S3 / DynamoDB | 公网端点（经 IGW） | 实验机所在的 public 子网仍经 IGW；app、data 子网经网关终端节点 |
| 数据层隔离 | 无 | data 子网没有默认路由 + NACL（为后续的 RDS、ElastiCache、EFS 准备） |
| 流量审计 | 只有 Nginx 访问日志 | Flow Logs 的 ACCEPT/REJECT 与 `traffic-path` |
| 迁移代价 | — | 一次有只读窗口的实例替换；实例 ID 变化，密钥指纹不变 |
| 按小时计费的网络资源 | 公网 IPv4 | 公网 IPv4（不新增；NAT 与接口终端节点属于 `sc-private-network`） |

### 小测

1. **（单选）** 私有子网中的 EC2 需要大量读取同区域的 S3 对象，团队希望不经过 NAT、也不产生 NAT 数据处理费。最合适的是：
   A. 创建 S3 网关终端节点并关联私有子网的路由表　B. 给实例分配公网 IP　C. 改用 NAT 实例　D. 开启 S3 Transfer Acceleration
   **答案：A**。解析：网关终端节点只支持 S3 与 DynamoDB，加在路由表上、免费，只对同区域、且只对关联了它的路由表生效；Interface Endpoint 也能访问 S3，但按小时与流量收费。
2. **（单选）** 判断一个子网是不是“公有子网”，依据是：
   A. 它关联的路由表中有指向 Internet Gateway 的路由　B. 子网中的实例都有公网 IP　C. 子网 NACL 允许来自 0.0.0.0/0 的入站　D. 子网属于默认 VPC
   **答案：A**。解析：“公有”由路由决定；实例是否自动分配公网 IP 是子网的另一个属性，没有 IGW 路由时即使有公网 IP 也不可达；NACL 只是过滤；自定义 VPC 中同样可以有公有子网。
3. **（多选，选 2 项）** 关于安全组与 NACL，下列说法正确的是：
   A. 安全组有状态，允许的入站连接其返回流量自动放行　B. NACL 有状态　C. NACL 按规则编号顺序评估，可以写拒绝规则　D. 安全组可以写拒绝规则
   **答案：A、C**。解析：NACL 无状态，作用于子网，需要显式放行临时端口的回包（本卡 data 子网 NACL 的出站规则就是这个用途）；安全组作用于 ENI，只有允许规则。

### 清理说明

- 回收器按依赖的逆序删除：先删基础栈（实验机现在在自定义 VPC 中），再删 network 栈；Flow Logs 日志组按数据保护约定保留，栈删除后由回收器按台账删除。迁移时的保险快照记在 `state.json` 的带外段，由回收器删除（快照中含 `secrets.env`，不要复制或共享）。
- 你在控制台手工建的终端节点、安全组或 NACL 规则不需要补打标签：回收器按 CloudTrail 中你的会话创建的事件认领并删除（有分钟级延迟）。
- 选择“保留环境”后接着做 `sc-private-network` 时，同一 VPC 内从 public 切到 private 不改变 `VpcId`，可以复用（以 02 的复用规则为准）。

### 对应 SAA 考点

默认 VPC 与自定义 VPC；公有/私有子网与路由表；IGW；网关终端节点与 Interface Endpoint（PrivateLink）的区别（NAT 与终端节点的取舍在 `sc-private-network` 中实操）；安全组与 NACL；VPC Flow Logs 的目标、字段与不记录的流量；实例不能跨 VPC/子网移动、EBS 绑定 AZ、快照跨 AZ；CIDR 规划与每个子网保留 5 个地址；AZ 名称与 AZ ID；弹性 IP 与公网 IPv4 计费。

---

## 4. svc-cdn：Amazon CloudFront：内容分发与边缘缓存

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-cdn` |
| kind | `service` |
| 标题 | Amazon CloudFront：内容分发与边缘缓存 |
| 一句话简介 | 给 EC2 直出的相册加一层 CloudFront：命中缓存时不回源，源站流量与连接被卸载，用户拿到受信任的 HTTPS。 |
| 涉及的 AWS 服务 | Amazon CloudFront（主：分配、缓存策略、源请求策略、响应头策略、失效）；EC2 安全组 + CloudFront 托管前缀列表（辅：源站保护） |
| 对应的模块 | `cdn` |
| 难度 | 中级（需要等待分配部署） |
| 预计时长 / 时间上限 / 可延长 | 75 分钟 / 120 分钟 / 2 次 × 30 分钟（分配部署与删除都需要数分钟） |
| startProfile | `l0-ec2` + `iam`（档位 `atl/svc-cdn/default`）：硬依赖闭包为空——cdn 以 `CDN_ORIGIN_TYPE=ec2` 回源时只要求实例关联 EIP（DEP-014，L0 已满足），`CDN_MEDIA_ORIGIN=ec2` 不需要 storage（DEP-010 不触发）；iam(role) 按 C3 预置，`/lab` 的失效按钮与 `GetDistribution` 控制面感知因此可用，cdn 启用后为 `ok`（与 04 §11 的完整示例一致） |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | `cdn`：`driver=cloudfront`（`CDN_ORIGIN_TYPE=ec2`、`CDN_MEDIA_ORIGIN=ec2`、`CDN_DIRECT_ACCESS=open`），`adoptsExisting: true`（路线 M）；部署等级 A，`provision.cleanupBudgetMinutes: 90`（学员创建的分配要先禁用、等部署完成再删除） |
| 费用档位与主要计费来源 | 低：CloudFront 按请求数与出网 GB（学习流量通常在长期免费额度内）；超出免费配额的失效路径；回源流量不计出网费 |
| 人工前置 | 无 |
| SAA 考试领域 | 高性能、成本、安全 |
| 推荐的前置卡片 | `svc-ec2` |
| 徽章 | “边缘缓存” |

### 实验简介

**背景**：L0 时每一张缩略图、每一个 JS 文件都由东京这台 EC2 的 Nginx 发出。加上 CloudFront 后，同样的内容由离用户最近的边缘节点返回，命中时根本不回源。源站只接受带密钥头、来自 CloudFront 网段的回源请求。

**你将学到**
- 自定义源站只能填域名；用托管前缀列表 + `X-Origin-Verify` 保护源站。
- 缓存策略、源请求策略、响应头策略各管什么；认证 API 绝不能进可缓存的行为。
- 用服务端证据（源站日志）区分“边缘命中”和“源站响应”。
- 失效与版本化文件名的取舍。
- 为什么 CloudFront 能降低 EC2 的出网流量与费用。

**实验资源**：栈 `cloudalbum-<envName>-cdn`（分配、源站安全组、缓存策略 `cloudalbum-media` 与 `cloudalbum-api-micro`、响应头策略 `cloudalbum-lab`）；实验机上的 8080 源站监听器 `cdn-origin.conf`；实验脚本 `experiments/cdn/`（`ttfb`、`media-load`、`origin-requests`、`invalidation`、`api-nocache`、`compression`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | 起始状态：入口只有 Nginx | 观察 | 直连 `http://<EIP>/`，缩略图角标“图片由 EC2 Nginx 直出”；响应头没有 `X-Cache` | `HTTP`（`from: platform`，`target: public-ip`，`/assets/<文件>`）：没有 `x-cache`，`entry=nginx`（once）；`CAP`：`cdn` 的 `driver=direct`、`status=off`（once）。两项都是 before 断言（04 §11 的 `entry-direct-baseline`、`cdn-off`） |
| 2 | before：源站负载 | 对比实验 | `media-load`（`TARGET=direct`，5 分钟）+ `origin-requests`；选做：`ttfb`（远端区域视角需要多区域 CloudShell） | `EXP cdn/media-load(before)`；选做 `EXP cdn/ttfb(before)` |
| 3 | 启用 CloudFront（接入应用） | 脚本（可选路线 M：先在控制台建分配，再用 `scripts/module` 接管） | `scripts/module enable cdn`：生成 `origin-verify` → 投放 8080 监听器 → 部署分配与源站安全组 → 等待 `Deployed` → 写 `cdn.env` 并重启 | `CAP`：`cdn` 的 `driver=cloudfront`、`healthy`（预期警告为空，所以必须是 `ok`）；`HTTP`（`from: platform`，`target: cdn`，`/api/health/live`）：`entry` 以 `cloudfront` 开头；`LOCAL http-probe`（`target: cdn-origin`）：不带校验头访问 8080 返回 403；`AWS`：`cloudfront:GetDistribution`（`ownership: session`：只认本会话创建的分配。路线 S 走栈成员快路径；路线 M 在控制台建的分配走定向扫描——CloudFront 是全局服务，02 在 us-east-1 的事件历史中按分配 ID 查 `CreateDistribution`，首次检测通常是 `OWNERSHIP_PENDING`，几分钟后自动确认）——`Deployed`，源站为实验机公网 DNS:8080、`http-only`、带 `X-Origin-Verify`（证据打码） |
| 4 | 亲眼看到边缘命中 | 观察 | 同一 `/assets` 文件先 Miss 后 Hit、`Age` 递增；`/api/public/now` 在 `s-maxage` 内时间戳不变；探测端点 `/api/lab/probe/now`（`private, no-store`）两次都 Miss | `HTTP`（`from: platform`，`target: cdn`，`/api/public/now?atlprobe={{ sample.nonce }}`，`repeat: 2`）：第 2 次 `Hit from cloudfront` 且时间戳相同，佐证 `nginx-log-summary` 中该 nonce 只出现 1 次（依赖 Nginx 日志的 `args` 字段，06；同 04 §11.3 的 `edge-cache-observed`）；`HTTP`（同上，`/api/lab/probe/now`，引擎自动附带一次性探测令牌 `X-ATL-Probe-Token`，`repeat: 2`）：两次都 Miss 且 `now` 不同（04 §11.3 的 `api-not-cached`） |
| 5 | after：源站负载 | 对比实验 | `media-load`（`TARGET=cdn`）+ `origin-requests`；观察 `/lab` 的“源站负载”面板 | `EXP cdn/media-load(after)`：与 before 成对有效，源站请求数与 EC2 出网字节明显下降（按 `experiment.json` 的 `expect` 判定） |
| 6 | 失效与版本化文件名 | CLI | `/lab`“覆盖同名缩略图” → 经 CDN 仍是旧图；用 `/lab` 的失效按钮（起始状态带 iam，按钮可用），或在工作台执行 `aws cloudfront create-invalidation --paths /media/<key>` → 完成后变新图；再试“版本化键”，立即生效 | `AWS`：`cloudfront:ListInvalidations`——有 `CreateTime` 晚于 `session.readyAt` 且 `Completed` 的失效（once）；`MAN`：比较两种方式的生效时间、是否消耗失效配额 |
| 7 | （选做）压缩与协议 | 对比实验 | `compression`：JS/CSS 经 CDN 返回 `br`；`/lab`“加载 60 张缩略图”对比 `nextHopProtocol` | `EXP cdn/compression(after)` |

### 对比实验

引用 `experiments/cdn/`（01#cdn §5）。直连与经 CDN 两条 URL 同时在线，可以运行时 A/B。必需实验选 `media-load` 而不是 `ttfb`：工作台在东京，从东京测首字节时间两者差别很小，而源站负载的变化从任何位置都看得清（附录 B-9）。

| 观察点 | 没有 CloudFront（EC2 直出） | 有 CloudFront |
|---|---|---|
| 内容从哪里发出 | 东京的 EC2 | 最近的边缘节点；命中时不回源 |
| 源站负载 | 每个请求都到达 EC2 | 只剩未命中的回源请求；EC2 出网字节大幅下降 |
| HTTPS | 方案 B 的 IP 证书或自签名 | `*.cloudfront.net` 受信任证书 |
| 协议与压缩 | 80 端口 HTTP/1.1、gzip | HTTP/2、HTTP/3，文本资源 br |
| 更新同名文件 | 立即生效（受浏览器缓存影响） | TTL 内仍是旧内容，需要失效或换文件名 |
| 动态 API | 直达 | 认证 API 永远 Miss；公共 API 可做秒级微缓存 |
| 远端用户首字节时间（选做） | 跨洲往返，数百毫秒量级 | 命中时数十毫秒量级 |

### 小测

1. **（单选）** 全球用户访问部署在东京 EC2 上的图片与静态资源时延迟高，团队同时希望降低 EC2 的出网流量费用。最合适的方案是：
   A. 创建以该 EC2 为自定义源站的 CloudFront 分配　B. 使用 AWS Global Accelerator　C. 换成更大的实例类型　D. 开启 S3 Transfer Acceleration
   **答案：A**。解析：CloudFront 在边缘缓存内容，命中时不回源，从 AWS 源站回源到 CloudFront 的流量不收出网费；Global Accelerator 提供静态 Anycast IP 与骨干网加速，但不缓存内容；Transfer Acceleration 用于加速上传到 S3。
2. **（单选）** 只允许 CloudFront 读取 S3 源站中的对象，且桶使用 SSE-KMS 加密。推荐做法是：
   A. 使用 Origin Access Control（OAC），桶策略只允许 `cloudfront.amazonaws.com` 且 `AWS:SourceArn` 为该分配　B. 把桶设为公开读　C. 使用 Origin Access Identity（OAI）　D. 为每个对象生成预签名 URL 写进页面
   **答案：A**。解析：OAC 支持 SSE-KMS 与所有区域，OAI 不支持 SSE-KMS；此外密钥策略要允许 CloudFront 服务主体解密。
3. **（单选）** 发布新版前端后，部分用户仍拿到旧的 JS 文件。团队希望今后发布无需等待失效、也不消耗失效配额。应该：
   A. 静态文件名带内容哈希（版本化），`index.html` 设置 `no-cache`　B. 每次发布都创建 `/*` 失效　C. 把所有行为的 TTL 设为 0　D. 关闭边缘压缩
   **答案：A**。解析：版本化文件名让新版本成为“新对象”，立即生效；失效需要时间，超出免费配额要收费；TTL 全设为 0 会失去缓存收益。

### 清理说明

- 回收器要先禁用分配、等部署完成后才能删除，回收会比其他卡片慢（本卡的回收预算为 90 分钟）。按路线 M 在控制台手工建的分配不需要补打标签：平台按 CloudTrail 中你的会话创建分配的事件认领并删除。
- 手工创建的缓存策略、响应头策略要在分配删除后才能删除（`learnerCreatedHints`）。
- 失效路径尽量少（每月免费配额以外要收费）。

### 对应 SAA 考点

边缘站点与区域边缘缓存、Origin Shield；缓存策略、源请求策略、响应头策略的分工；TTL 与 `Cache-Control`、`s-maxage`；失效与版本化文件名；OAC 与 OAI；自定义源站必须是域名，前缀列表 + 自定义头保护源站；CloudFront 证书与 CLOUDFRONT 范围 WAF 在 us-east-1；签名 URL / 签名 Cookie 与 S3 预签名 URL；CloudFront Functions 与 Lambda@Edge；回源流量免费；CloudFront 与 Global Accelerator。

---

## 5. svc-dns：Amazon Route 53：域名解析

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-dns` |
| kind | `service` |
| 标题 | Amazon Route 53：域名解析 |
| 一句话简介 | 让相册用固定域名访问：背后的 IP 变了，域名链接在 TTL 过后自动恢复；顺带认识 Alias、TTL 与健康检查。 |
| 涉及的 AWS 服务 | Amazon Route 53（主：公有托管区域、记录、选做健康检查与故障转移）；EC2 弹性 IP（记录目标） |
| 对应的模块 | `dns` |
| 难度 | 中级（需要等待 DNS 生效） |
| 预计时长 / 时间上限 / 可延长 | 60 分钟 / 120 分钟（含 NS 委派的等待余量）/ 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam`（档位 `atl/svc-dns/default`）：硬依赖闭包为空——`DNS_TARGET_TYPE=eip` 只要求实例关联 EIP（L0 已满足）；`alb`、`cloudfront` 目标所需的 load-balancer、cdn + tls 不属于本卡。iam(role) 按 C3 预置，记录与健康检查状态的控制面感知在 `/lab` 中可用 |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | `dns`：`DNS_PROVIDER=route53`、`DNS_TARGET_TYPE=eip`、`DNS_ROUTING_POLICY=simple`（选做 `failover`） |
| 费用档位与主要计费来源 | 低：托管区域按月（创建后很快删除的托管区域有不收费的宽限规则，以官方为准）；标准查询按次，指向 AWS 资源的 Alias 查询免费；选做的健康检查按月。使用本账号已有的托管区域时不新增托管区域费用 |
| 人工前置 | 自有域名，二选一：① 本账号已有该域名（或其子域）的公有托管区域——推荐，不需要等待委派；② 能在注册商或父域为子域（例如 `lab.example.com`）添加 NS 委派——生效时间由注册商与顶级域决定，可能超出卡片时长 |
| SAA 考试领域 | 弹性、成本 |
| 推荐的前置卡片 | `svc-ec2` |
| 徽章 | “固定域名” |

### 实验简介

**背景**：L0 的链接里写的是 `http://<EIP>`，邮件和分享链接也是 IP。一旦地址变化（换实例、迁移、上 ALB 或 CDN），旧链接全部失效。有了 Route 53，名字固定，背后的目标可以随时更换。

**你将学到**
- 域名注册与 DNS 托管是两件事；NS 委派。
- A 记录、CNAME 与 Alias：根域名只能用 Alias，Alias 不能指向 IP。
- TTL 与缓存：迁移前先调低 TTL。
- 路由策略与健康检查（选做故障转移）。

**实验资源**：栈 `cloudalbum-<envName>-dns`（新建或复用的托管区域、TTL 60 的 A 记录、选做健康检查）；实验脚本 `experiments/dns/`（`ip-change-drill`、`failover-drill`、`weighted-sample`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：IP 链接有多脆弱 | 对比实验 | `ip-change-drill(before)`：分配临时 EIP 并关联到实验机，用旧 IP 链接每 5 秒探测一次，最后关联回原 EIP 并释放临时 EIP | `EXP dns/ip-change-drill(before)`：旧 IP 链接失败次数 > 0；`AWS`：`ec2:DescribeAddresses`——演练结束后原 EIP 已关联回实验机，临时 EIP 已释放 |
| 2 | 填写域名 | 观察 | 在变量面板填写域名（以及可选的已有托管区域 ID） | `AWS`：`route53:GetHostedZone`（只在填写了已有托管区域时）——`Name` 与域名匹配（学员已有的资源，不做 `ownership`）；`MAN`：确认能修改该域名的 NS，或已有托管区域 |
| 3 | 启用 Route 53（接入应用） | 脚本 | `scripts/module enable dns --domain {{ learner.inputs.domain }} [--zone-id …] --target eip`；新建托管区域时到注册商设置 NS，脚本轮询 `dig NS` 直到委派生效 | `CAP`：`dns` 的 `driver=route53`、`healthy`；`LOCAL module-state`（`dns`）：已由 `scripts/module` 启用；`LOCAL dns-resolve`（域名）：解析结果包含 `{{ target.publicIp }}`；`AWS`：`route53:ListResourceRecordSets`（用 `where` 选出该域名的 A 记录）——值为实验机 EIP、TTL 60。dns 是纯基础设施型模块，wire 证据按 04 §3.5 第 3 条用 `module-state` + 控制面证据；该记录是本会话 `cloudalbum-<envName>-dns` 栈的成员，新建托管区域时另对 `route53:GetHostedZone` 写 `ownership: session` |
| 4 | after：换 IP 演练 | 对比实验 | `ip-change-drill(after)`：关联临时 EIP 后脚本 UPSERT 记录，持续 `dig` 与 `curl` 域名 | `EXP dns/ip-change-drill(after)`：与 before 成对有效；域名链接在 TTL 量级的时间内恢复，旧 IP 链接持续失败 |
| 5 | Alias 与 CNAME | CLI | 本卡的目标是 EIP（普通 A 记录），没有现成的 Alias：先在同一托管区域建 `www.<域名>` → Alias 到 `<域名>` 的 A 记录（Alias 可以指向同一托管区域中的记录），用 `dig` 观察它直接返回 A 记录而不是 CNAME 链；再尝试为区域顶点建 CNAME，被 Route 53 拒绝 | `MAN`：记录“区域顶点 CNAME 被拒绝”的报错与 Alias 的解析结果 |
| 6 | （选做）健康检查与故障转移 | 对比实验 | `DNS_ROUTING_POLICY=failover` + `EnableHealthCheck=true`，按 01#dns 准备维护页（S3 网站桶名必须与记录名相同）；`failover-drill` 停止 Nginx，记录三个时刻 | `EXP dns/failover-drill(after)`；`AWS`：`route53:GetHealthCheckStatus`（04 §5.7 第 2 轮已收录）——演练期间出现 `Failure`、结束后恢复（once）；`MAN`：健康检查变为不健康的时间（健康检查指标在 us-east-1） |

### 对比实验

引用 `experiments/dns/`（01#dns §5）。“换 IP”是切换前后两次测量；IP 与域名两种 URL 也可以并排比较。

| 观察点 | 没有 Route 53（IP / EC2 主机名） | 有 Route 53 |
|---|---|---|
| 用户看到的地址 | `http://203.0.113.10` 或 `ec2-…amazonaws.com` | `album.example.com` |
| 换目标（换 IP、上 ALB、上 CDN） | 所有旧链接失效 | 改记录，TTL 过后用户无感 |
| 邮件与分享链接 | 绑定 IP | 绑定域名，长期有效 |
| 健康检查与故障转移 | 无 | 健康检查 + failover 记录（选做） |
| 根域名指向 AWS 资源 | 不适用 | Alias（查询免费） |

### 小测

1. **（单选）** 需要让根域名 `example.com` 指向一个 Application Load Balancer。应使用：
   A. Alias 记录　B. CNAME 记录　C. 写入 ALB 当前 IP 的 A 记录　D. MX 记录
   **答案：A**。解析：区域顶点不能建 CNAME；ALB 的 IP 会变化，不能写死；Alias 可以指向 ALB，并可开启 Evaluate Target Health。
2. **（单选）** 主站点故障时，希望用户自动看到托管在 S3 上的静态维护页。应使用：
   A. 故障转移路由策略，主记录关联健康检查　B. 加权路由　C. 地理位置路由　D. 在简单路由记录中写多个值
   **答案：A**。解析：PRIMARY 关联健康检查，不健康时返回 SECONDARY；作为备用目标的 S3 网站端点要求桶名与记录名相同，且只支持 HTTP。
3. **（多选，选 2 项）** 关于 Route 53 的 Alias 记录，下列说法正确的是：
   A. 可以用于区域顶点（根域名）　B. 指向 CloudFront、ALB 等 AWS 资源时查询不收费　C. 可以指向任意 IP 地址　D. 可以指向一个弹性 IP
   **答案：A、B**。解析：Alias 只能指向 AWS 资源或同一托管区域中的记录，不能指向 IP 或 EIP；指向 EIP 只能用普通 A 记录。

### 清理说明

- 回收器删除 dns 栈中的记录与健康检查；本会话**新建**的托管区域一并删除（02 §7.5 S2；结束对话框中可以勾选保留托管区域，02 §7.2）。之后请到注册商删除你添加的 NS 委派。
- 使用已有托管区域时，平台只删除本会话创建的记录：第 5 步手工建的 Alias 记录由回收器按 CloudTrail 中的 `ChangeResourceRecordSets` 认领（Route 53 是全局服务，事件在 us-east-1 查询；有分钟级投递延迟），建议你在结束前自己删除。
- 第 1、4 步的演练脚本会把原 EIP 关联回实验机；如果中途失败，到控制台确认实验机仍挂着原 EIP，并释放临时 EIP（未关联的 EIP 也计费）。

### 对应 SAA 考点

公有与私有托管区域；A、AAAA、CNAME 与 Alias；TTL 与缓存；简单、加权、延迟、故障转移、地理位置、地理邻近、多值应答、基于 IP 的路由策略；端点、计算型、基于 CloudWatch 告警的健康检查；Evaluate Target Health；Route 53 故障转移 + S3 静态维护页与 RTO；域名注册与 DNS 托管、NS 委派。

---

## 6. svc-tls：AWS Certificate Manager：HTTPS 证书

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-tls` |
| kind | `service` |
| 标题 | AWS Certificate Manager：HTTPS 证书 |
| 一句话简介 | 从浏览器拦截页到地址栏的锁：用 ACM 的 ACME 端点把受信任证书装到 Nginx，并分清“考试结论”和“2026 新能力”。 |
| 涉及的 AWS 服务 | AWS Certificate Manager（主：ACME 端点、域验证、ACME 证书；回退分支：us-east-1 的集成证书）；IAM（ACME 签发角色）；Amazon CloudFront（仅回退分支） |
| 对应的模块 | `tls`（回退分支另有前置 `cdn`） |
| 难度 | 中级 |
| 预计时长 / 时间上限 / 可延长 | 75 分钟 / 120 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam`（档位 `atl/svc-tls/default`），**关闭方案 B**（C5：`startProfile.platform.preview.directHttps: off`，`TLS_MODE=selfsigned`；预览按 03 §6.2 方案 A 在新标签页打开 `http://<EIP>`），因为本卡要从自签名讲起。iam(role) 按 C3 预置，`DescribeCertificate` 控制面感知（续期状态）在 `/lab` 中可用。tls 的硬依赖（DEP-005）：`TLS_DOMAIN`（人工前置）；ACME 端点可用时没有模块依赖。起始变体（04 `startProfile.variants`，`select: preflight`，由 02 的账号预检按预检键 `preflight.tlsAcme` 选择）：**`default`（ACME 端点可用）**——起始状态为 L0 + iam；**`acme-off`（不可用，DEP-005 ③ 回退，档位 `atl/svc-tls/acme-off`，部署等级 B）**——再加 cdn（`CDN_ORIGIN_TYPE=ec2`）；DEP-005 ③ 的另一半 `dns \| DNS_PROVIDER=external` 选外部 DNS。外部 DNS 的本地档要同时写 `APP_BASE_URL=http://<域名>`，域名是学员前置输入，按 04 §3.2.3 规则 6 不进起始状态，由学员在第 2 步写入（DEP-005 ③ 是 tls 启用时的启动检查，起始状态里不需要它），不需要等待 NS 委派。回退时在 `cdn \| load-balancer` 中选 cdn：不按小时计费；集成证书必须在 us-east-1，正是考试结论的考点；分配默认域名还能给预览提供受信任 HTTPS。两个变体共用一个徽章 |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | `tls`：`TLS_MODE=acm`，`TLS_ACME=on`；回退分支 `TLS_ACME=off`（集成证书挂在 CloudFront） |
| 费用档位与主要计费来源 | 低：ACME 证书按证书中的域名在签发与每次续期时计费；集成证书免费；回退分支另有 CloudFront 按量 |
| 人工前置 | 自有域名，并能在它的 DNS 中添加 CNAME（ACME 域验证或 ACM DNS 验证）与 A 记录（指向实验机 EIP，供浏览器访问）；本账号已有该域名的 Route 53 托管区域时可传 `--zone-id` 自动创建验证记录 |
| SAA 考试领域 | 安全、高性能 |
| 推荐的前置卡片 | `svc-dns`（使用 Route 53 时）、`svc-cdn` |
| 徽章 | “受信任 HTTPS” |

### 实验简介

**背景**：L0 的 443 是 User Data 生成的自签名证书，浏览器显示“不安全”，跨源 fetch 与 Cognito 回调都会失败。ACM 有两种给证书的方式：集成证书挂在 CloudFront、ALB、API Gateway 上，由 ACM 托管续期；2026-07 起，ACM 的 ACME 端点可以给自管服务器签发 45 天的公有证书，私钥留在实例上，由 certbot 续期（01#tls、总纲 §3.2 决定 9）。

**你将学到**
- 自签名、Let's Encrypt、ACM 三种证书在信任与续期上的差别。
- **考试结论**：ACM 公有证书不能装到 EC2，只能挂在集成服务上；CloudFront 用的证书必须在 us-east-1。
- **2026 新能力**：ACME 端点 + 预先批准的 DNS 域验证 + EAB；这类证书反过来不能挂到 CloudFront 或 ALB。答题时以考试结论为准。
- DNS 验证记录必须保留才能续期；HSTS 的风险。

**实验资源**：栈 `cloudalbum-<envName>-tls`（ACME 端点、域验证、签发角色 `cloudalbum-<envName>-acme-issuer`）；实验机上的 certbot（配置目录在数据卷上）与 `certbot-renew.timer`；回退分支另有 `cloudalbum-<envName>-tls-edge`（us-east-1 集成证书）；实验脚本 `experiments/tls/`（`inspect`、`handshake`、`cipher-scan`、`renew-drill`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：自签名 | 对比实验 | `inspect(before)`；新标签页打开 `https://<EIP>/` 看拦截页；`/lab`“跨源 fetch 测试”失败 | `EXP tls/inspect(before)`：直连证书签发者为 `CN=cloudalbum-l0`；`CAP`（`module: app`）：`https.trusted=false`（once：第 4 步后变为 true） |
| 2 | 准备域名 | 观察 + 外部 DNS | 填写域名变量；在你的 DNS 中添加 A 记录 → 实验机 EIP。回退分支另需在本步写入 dns 本地档 `DNS_PROVIDER=external`（`APP_BASE_URL` 改为域名，写法见 01#dns §1）：DEP-005 ③ 是启动时检查，缺少它第 4 步重启时会以退出码 78 拒绝启动 | `LOCAL dns-resolve`（域名）：解析结果包含 `{{ target.publicIp }}`；回退分支 `LOCAL env-key`（`dns`，`DNS_PROVIDER`）：值为 `external` |
| 3 | 先判断走哪条路 | CLI | `scripts/module enable tls --domain … --dry-run`，读 `preflight: acme-endpoint` 的结论（平台在开始前已探测并选好变体，手册按 `session.variant` 只显示对应的一条分支） | `MAN`：记录 `TLS_ACME=on/off` 及原因 |
| 4 | 启用 tls（接入应用） | 脚本 | ACME 分支：建 ACME 端点与域验证 → 打印验证 CNAME → 你在 DNS 中添加 → 域验证变为 `VALID` → 1 天有效的 EAB → certbot 注册与签发（客户端超时至少 120 秒）→ 切换证书符号链接并 reload → 删除 EAB。回退分支：在 us-east-1 签发集成证书，挂到 CloudFront 的 `Aliases`，你把域名 CNAME 到分配（替换第 2 步的 A 记录：同一名称不能同时有 A 与 CNAME；外部 DNS 的根域名不能建 CNAME，所以回退分支必须用子域，例如 `lab.example.com`） | `CAP`：`tls` 的 `driver=acm`、`healthy`；`LOCAL module-state`（`tls`）：已由 `scripts/module` 启用（tls 是纯基础设施型模块，04 §3.5 第 3 条）；ACME 分支 `LOCAL tls-handshake`（`target: self`，即本机 443）：证书签发者为 Amazon、SAN 含域名；ACME 分支 `HTTP`（`from: platform`，`target: tls-domain`，`/api/health/live`；04 §5.2.3 已加入该目标：平台解析域名，解析结果必须落在本环境入口集合中，并自动附加证书 SAN 佐证）：证书受信任，路径头 `tls=acm@nginx:acme`；回退分支 `HTTP`（`from: platform`，`target: cdn-alias`）：证书 SAN 含域名；`AWS`：ACME 分支先 `acm:ListCertificates`（ACME 来源过滤条件，模块文档所述 `--certificate-key-pair-origins ACME`，以官方 API 为准；检查 id `acme-cert-listed`）找出域名等于 `TLS_DOMAIN`、签发时间晚于 `session.readyAt` 的证书 ARN，再 `acm:DescribeCertificate`（ARN 取 `{{$check.acme-cert-listed…}}`，写进 `dependsOn`；`ownership: session`——创建者是本环境 tls 栈中的签发角色 `cloudalbum-<envName>-acme-issuer`，04 §5.2.4 第 2 条把“本环境栈成员角色”认作创建证据）——`Status=ISSUED`。回退分支用 `acm:DescribeCertificate`（`region: us-east-1`，`ownership: session`）——`Status=ISSUED`、`InUseBy` 含本会话分配 |
| 5 | after 与续期 | 对比实验 | `inspect(after)`、`cipher-scan`、`renew-drill`（`certbot renew --dry-run`；`--force-renewal` 后证书 ARN 不变） | `EXP tls/inspect(after)`：与 before 成对有效；`EXP tls/renew-drill(after)` |
| 6 | 两栏对照 | 观察 | 在 ACM 控制台用 ACME 过滤条件找到证书，看它的来源与续期方式；思考它能否挂到 CloudFront（不能），以及考试中“在 EC2 上终止 TLS”的标准答案 | `MAN`：两道判断（ACME 证书能否挂到 CloudFront；考试口径下 ACM 证书能否装到 EC2） |
| 7 | （选做）强制 HTTPS 与 HSTS | 脚本 | `TLS_FORCE_HTTPS=true`（HSTS `max-age` 用小值）；验证 80 → 443；结束前关闭 | `HTTP`（`from: platform`，`target: public-ip`，`/`）：301 到 https；`CAP`（`app`）：`validation.errors` 不含 DEP-015 |

### 对比实验

引用 `experiments/tls/`（01#tls §5）。只有 L0 时是切换前后两次测量（切换只需 Nginx reload）。

| 观察点 | 没有 ACM（自签名；本地档 Let's Encrypt） | 有 ACM |
|---|---|---|
| 浏览器表现 | 自签名：拦截页 | 锁标志 |
| 签发者 | `CN=cloudalbum-l0` / Let's Encrypt | Amazon |
| 有效期与续期 | 自签名长期有效但不受信任；Let's Encrypt 由 certbot 续期 | ACME 证书 45 天，certbot 续期；集成证书由 ACM 托管续期 |
| 私钥位置 | 实例上 | ACME：实例上；集成证书：ACM 托管、不可导出 |
| 是否依赖入站 80 | Let's Encrypt HTTP-01 需要 | 不需要（预先批准的 DNS 域验证） |
| 能否挂到 CloudFront / ALB | 不能（只能导入） | 只有集成证书可以 |
| 远端握手耗时（选做多区域 `handshake`） | 握手往返到东京 | 经 CloudFront 时在附近边缘完成（回退分支可观察） |

### 小测

1. **（单选）** 给 CloudFront 分配绑定自定义域名所需的 ACM 证书，应在哪个区域申请？
   A. us-east-1　B. 源站所在区域　C. 任意区域，CloudFront 会自动复制　D. 与 Route 53 托管区域相同的区域
   **答案：A**。解析：CloudFront（以及 Cognito 托管登录页的自定义域名）只使用 us-east-1 的 ACM 证书；ALB 与区域型 API Gateway 使用资源所在区域的证书。
2. **（单选）** 按 SAA 考试的常见口径：公司希望用 ACM 签发的公有证书为运行在 EC2 上的网站提供 HTTPS，并由 ACM 自动续期。应该：
   A. 在实例前放一个 ALB，把 ACM 证书挂在 HTTPS 监听器上　B. 从 ACM 导出普通公有证书装到 Nginx　C. 把证书文件放进 S3 由实例下载　D. 用 ACM Private CA 签发公有证书
   **答案：A**。解析：ACM 集成证书的私钥不可导出，只能挂在 CloudFront、ALB、API Gateway 等集成服务上，由 ACM 托管续期。2026 年起的 ACME 端点能把证书装到自管服务器，但续期由客户端负责，不是“ACM 自动续期”；答题仍以考试结论为准。
3. **（多选，选 2 项）** ACM 集成证书能够自动续期的前提包括：
   A. DNS 验证记录仍然存在　B. 证书正在被集成服务使用　C. 证书私钥已经导出备份　D. 实例上运行着 certbot 定时器
   **答案：A、B**。解析：DNS 验证的证书要靠保留的验证 CNAME 自动完成续期验证；ACM 只对“正在使用（已关联到集成服务）或已导出”的证书执行托管续期，没有关联任何服务的证书到期前不会自动续期（以官方文档为准）；ACM 集成证书的私钥不可导出，certbot 只用于 ACME 或 Let's Encrypt 证书。

### 清理说明

- 回收器删除 tls 栈：ACME 端点删除时一并删除 EAB、域验证与已注册的 ACME 账户；过期的 ACME 证书 ACM 会在一年后自动删除。选做：结束前在实验机上 `certbot revoke` 吊销仍有效的证书（ACM 的 `RevokeCertificate` 对 ACME 证书无效）。
- 你在自己 DNS 中添加的 A 记录、验证 CNAME（以及回退分支的 CNAME）平台无权删除，请自己删掉。
- 如果开过 HSTS，浏览器会在 `max-age` 内记住它，所以必须用小值，并在关闭 TLS 前先关闭 HSTS。

### 对应 SAA 考点

ACM 公有证书用于集成服务时免费、自动续期，私钥不可导出；DNS 验证与邮件验证；证书区域（CloudFront、Cognito 托管登录页自定义域名用 us-east-1，ALB/API Gateway 用所在区域）；导入的证书要手动续期；ACM Private CA；SNI 与一个监听器挂多张证书；ALB 到目标再加密、ALB 不校验目标证书；查看器协议策略与源站协议策略；HSTS；在边缘终止 TLS 降低远端握手延迟。2026 新能力（ACME 端点）只作了解。

---

## 7. svc-waf：AWS WAF：Web 应用防护

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-waf` |
| kind | `service` |
| 标题 | AWS WAF：Web 应用防护 |
| 一句话简介 | 同一套攻击脚本分别打向“只有 Nginx 限速”和“CloudFront + AWS WAF”：看被拦截的请求还会不会到达 EC2。 |
| 涉及的 AWS 服务 | AWS WAF（主：Web ACL、托管规则组、基于速率的规则、IP 集合、日志）；Amazon CloudFront（前置挂载点）；CloudWatch Logs（WAF 日志，us-east-1）；AWS Shield Standard（只讲解） |
| 对应的模块 | `waf`（目标）；`cdn`（前置） |
| 难度 | 中级 |
| 预计时长 / 时间上限 / 可延长 | 90 分钟 / 150 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam` + `cdn`（`CDN_ORIGIN_TYPE=ec2`、`CDN_MEDIA_ORIGIN=ec2`、`CDN_DIRECT_ACCESS=open`；档位 `atl/svc-waf/default`）。DEP-006 要求 `cdn \| load-balancer`，**选 cdn**（`branches: { DEP-006: { choose: cdn } }`）：① registry 表达式中第一个可自动满足的分支；② 不引入按小时计费的 ALB；③ 与 `saa-main` 路径中的边缘防护（CLOUDFRONT 范围）一致，“在边缘拦截”也是 SAA 的典型答案。代价：Web ACL、IP 集合与日志组都在 us-east-1，关联时分配要重新部署数分钟。`CDN_DIRECT_ACCESS` 起始为 `open`：让学员亲眼看到 DEP-018“可被绕过”，再在第 4 步收紧。iam(role) 按 C3 预置：管理后台封禁 IP 会同步到 AWS WAF 的 IP 集合，拦截计数（`GetSampledRequests`）在 `/lab` 中可见 |
| 预期警告 | `DEP-018`（卡片级）：第 3 步启用 WAF 时源站尚未锁定，waf 为 `degraded` 属预期；第 4 步锁定后的检查与 `finalChecks` 用检查级 `expectedWarnings: []`，要求 waf 必须是 `ok` |
| 目标模块 | `waf`：`WAF_MODE=aws`、`WAF_SCOPE=CLOUDFRONT`，先 `WAF_RULE_ACTION=count`，再改为 `block` |
| 费用档位与主要计费来源 | 低：Web ACL 与每条规则按月计费（按存续时间折算，以官方定价为准）+ 每百万请求；CloudFront 按量；WAF 日志写入 CloudWatch Logs 的摄取量 |
| 人工前置 | 无 |
| SAA 考试领域 | 安全、弹性 |
| 推荐的前置卡片 | `svc-cdn` |
| 徽章 | “边缘防护” |

### 实验简介

**背景**：L0 的“防火墙”是 Nginx：`limit_req` 限速加几条正则拦截明显的攻击载荷，每个恶意请求都已经到达实例。AWS WAF 挂在 CloudFront 上，在边缘按托管规则与速率规则拦截，被拦截的请求根本到不了 EC2。前提是源站已经锁定，否则攻击者可以绕过。

**你将学到**
- WAF 能挂在哪里（CloudFront、ALB、API Gateway REST API 等），不能挂在哪里（EC2、EIP、NLB）。
- CLOUDFRONT 范围的 Web ACL、IP 集合、日志组都在 us-east-1。
- 托管规则组先 Count 后 Block；CRS 对大请求体的误杀。
- 速率规则按窗口聚合、有检测延迟，与 Nginx 的精确限速不同。
- 源站锁定与“绕过 WAF”。

**实验资源**：栈 `cloudalbum-<envName>-waf-edge`（us-east-1：Web ACL、IP 集合 `cloudalbum-blocklist` 与 `cloudalbum-lab-allow`、日志组 `aws-waf-logs-cloudalbum-<envName>`）；前置栈 `cloudalbum-<envName>-cdn`；实验脚本 `experiments/waf/`（`flood`、`payloads`、`false-positive`、`bypass`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：Nginx 的限速与特征拦截 | 对比实验 | `flood(before, TARGET=direct)`、`payloads(before)`、`false-positive(before)`；`WAF_LAB_ALLOW_CIDR` 必须为空 | `EXP waf/flood(before)`：出现 429，路径头 `waf=nginx:ratelimit`；`EXP waf/payloads(before)`：编码变体有漏网 |
| 2 | 绕过检查（源站未锁定） | 对比实验 | `bypass(before)`：直接访问实验机公网 DNS 的 80 与 8080（带/不带密钥头） | `EXP waf/bypass(before)`：80 可以直达 |
| 3 | 启用 AWS WAF（Count 模式，接入应用） | 脚本 | `scripts/module enable waf`：以学员身份在 us-east-1 部署栈 `cloudalbum-<envName>-waf-edge`（Web ACL，Count）→ 经 `injects` 把 `WebAclArn` 写入 cdn 栈 → 分配重新部署（数分钟）。前提：01 §6.5 的 `UsEast1EdgeOnly` 放行 `cloudformation:*`，护栏 `UsEast1LabStacksOnly` 只允许 `stack/cloudalbum-*`（第 3 轮修订，附录 B-25） | `CAP`：`waf` 的 `driver=aws`、`healthy`（此刻因 DEP-018 为 `degraded`，属卡片级预期警告；once）；`HTTP`（`from: platform`，`target: cdn`，`/api/health/live`）：`entry` 以 `cloudfront>waf` 开头；`AWS`：`wafv2:GetWebACL`（`region: us-east-1`，`ownership: session`）——托管规则组的 `OverrideAction` 为 Count（once：第 6 步改为 Block） |
| 4 | 锁定源站 | 脚本 | `scripts/module enable cdn --param DirectAccess=admin-ip --param AdminIngressCidr={{ workstation.publicIp }}/32`（工作台公网出口 /32）；此后预览改用 CloudFront 入口。锁定后平台 Lambda 访问不到 `public-ip`，之后的直连类检查只能 `from: lab`（04 §5.2.3）。方案 B 的 IP 证书在会话内无需续期，保持开启不影响本卡 | `AWS`：`ec2:DescribeSecurityGroupRules`——实验机 80/443 只对 `{{ workstation.publicIp }}/32` 开放；`CAP`：`waf` 的 `healthy`，检查级 `expectedWarnings: []`（DEP-018 已消失，必须是 `ok`）；`EXP waf/bypass(after)` |
| 5 | 观察 Count 与误杀 | 观察 + 对比实验 | 在 Count 模式下跑 `payloads`、`false-positive`；在 us-east-1 的 Logs Insights 中执行 `stats count() by terminatingRuleId, action` | `EXP waf/false-positive(after)`；`MAN`：找出会误杀上传的规则（`SizeRestrictions_BODY`）以及本模块的处理方式 |
| 6 | 切换为 Block | 脚本 | `scripts/module set waf WAF_RULE_ACTION=block` | `AWS`：`wafv2:GetWebACL`——托管规则组 `OverrideAction=None`；`HTTP`（`from: platform`，`target: cdn`，路径为 `payloads` 场景中稳定命中的一条载荷，写成固定的路径加查询串，末尾附 `atlprobe={{ sample.nonce }}`）：403，佐证 `nginx-log-summary`（`nonce`）计数为 0——请求根本没有到达源站，这才能把 AWS WAF 的拦截与 Nginx 正则的 403（`waf=nginx:badinput`）区分开；路径头 `waf=aws:block-…` 只作 `severity: warn` 的辅助断言：托管规则组的 Block 默认返回 CloudFront 的 403 页，只有用 `RuleActionOverrides` 配了自定义响应时才会带这个头 |
| 7 | after：限速与载荷 | 对比实验 | `flood(after)` 同时打 `TARGET=edge` 与 `TARGET=direct`（直连只对工作台开放；`WAF_LAB_ALLOW_CIDR` 仍为空，否则工作台会跳过全部 WAF 规则）；`payloads(after)` | `EXP waf/flood(after)`：与 before 成对有效；佐证：攻击期间经 CloudFront 入口到达源站的请求数保持平稳（`nginx-log-summary` 按 `via-cloudfront` 分组）；`EXP waf/payloads(after)` |
| 8 | （选做）封禁 IP 与 Shield | 观察 | `/admin/security` 封禁文档保留地址 `192.0.2.1`：本地 denylist 立即生效，并同步到 us-east-1 的 IP 集合 `cloudalbum-blocklist`（起始状态带 iam，同步可用）；在 WAF 控制台确认地址出现在 IP 集合中，再解除封禁；阅读 Shield Standard 与 Advanced 的对照 | `MAN`（`wafv2:GetIPSet` 不在 04 §5.7 白名单中，选做步骤不为它扩充） |

### 对比实验

引用 `experiments/waf/`（01#waf §5）。源站锁定但对工作台开放直连时可以运行时 A/B；Count 与 Block 的切换是切换前后测量。

| 观察点 | 没有 AWS WAF（Nginx） | 有 AWS WAF（挂在 CloudFront 上） |
|---|---|---|
| 拦截位置 | EC2 上，请求已经到达实例 | CloudFront 边缘，请求到不了实例 |
| 限速 | 按秒、burst 精确、几乎立即生效 | 按评估窗口聚合、有检测延迟、不保证精确等于阈值 |
| 攻击期间的源站负载 | 连接、TLS、日志、带宽都消耗在实例上 | 源站请求数保持平稳 |
| 载荷识别 | 几条正则，编码变体可绕过、易误杀 | 托管规则组识别更强；CRS 会误杀大请求体，需先 Count |
| 多实例下的限额 | 每实例独立（ASG-013） | 全局统一 |
| 可观测性 | Nginx 日志汇总 | 采样请求、CloudWatch 指标、WAF 日志 |

### 小测

1. **（单选）** 网站在 CloudFront 后面。需要在请求到达 EC2 之前，限制单个 IP 对 `/api/auth/` 的 POST 请求速率。应该：
   A. 在关联到 CloudFront 的 Web ACL 中添加基于速率的规则，并把范围缩小为该路径与方法　B. 在实例安全组中限制来源　C. 在子网 NACL 中按 IP 拒绝　D. 依赖 Shield Standard 自动处理
   **答案：A**。解析：安全组与 NACL 工作在三/四层，无法按 URI 与速率判断，而且在 CloudFront 后面看到的是边缘地址；Shield Standard 防护网络层与传输层的 DDoS，不做应用层限速。
2. **（单选）** AWS WAF Web ACL **不能**直接关联到下列哪个资源？
   A. Network Load Balancer　B. Application Load Balancer　C. CloudFront 分配　D. API Gateway REST API
   **答案：A**。解析：WAF 工作在七层，可以关联 CloudFront、ALB、API Gateway REST API、AppSync、Cognito User Pool 等；不能关联 NLB、EC2 或 EIP。
3. **（多选，选 2 项）** 关于 CLOUDFRONT 范围的 Web ACL，下列说法正确的是：
   A. Web ACL 必须创建在 us-east-1　B. 日志写入 CloudWatch Logs 时，日志组名称必须以 `aws-waf-logs-` 开头　C. 只能关联 ALB　D. 不能使用 AWS 托管规则组
   **答案：A、B**。解析：CLOUDFRONT 范围的 Web ACL、IP 集合、日志目标都在 us-east-1，日志目标名称要以 `aws-waf-logs-` 开头；它关联的是 CloudFront 分配，关联 ALB 要用 REGIONAL 范围的 Web ACL（C 错）；托管规则组在两种范围都能用，新启用时建议先 Count 观察再 Block（D 错）。

### 清理说明

- 回收器先用空的 `WebAclArn` 更新 cdn 栈解除关联（分配重新部署数分钟），再删除 Web ACL；仍处于关联状态的 Web ACL 无法删除。
- WAF 日志组在 **us-east-1** 且按数据保护约定保留；回收器的扫描区域包含 us-east-1（02 §7.1），栈删除后按台账删除。自己在 Logs Insights 里查询时注意切到 us-east-1。
- 如果为别的实验设置过 `WAF_LAB_ALLOW_CIDR`，结束前清空：它是 Allow 动作，会让该 IP 跳过所有规则。
- 不要把 `flood` 提高到洪泛级别：只压测自己的资源，并遵守 AWS 的渗透测试政策。

### 对应 SAA 考点

WAF 的挂载点与不能挂载的资源；Web ACL、规则、托管规则组、基于速率的规则、IP 集合、地理匹配；Count 模式与 WCU；日志目标与 `aws-waf-logs-` 前缀；CLOUDFRONT 范围在 us-east-1；Shield Standard 与 Shield Advanced；Firewall Manager；安全组、NACL 与 WAF 的分层分工；源站锁定。

---

## 8. svc-load-balancer：Elastic Load Balancing：负载均衡（ALB）

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-load-balancer` |
| kind | `service` |
| 标题 | Elastic Load Balancing：负载均衡（ALB） |
| 一句话简介 | 在实例前放一个跨 AZ 的 ALB：看健康检查、失效开放，以及“只有一个目标时 ALB 并不带来高可用”。 |
| 涉及的 AWS 服务 | Elastic Load Balancing（主：ALB、监听器、目标组、健康检查）；EC2 安全组（辅）；Amazon S3（选做：访问日志） |
| 对应的模块 | `load-balancer` |
| 难度 | 中级（ALB 是 VPC 绑定资源） |
| 预计时长 / 时间上限 / 可延长 | 60 分钟 / 90 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam`（档位 `atl/svc-load-balancer/default`）：硬依赖闭包为空——ALB 需要同一 VPC 中至少两个 AZ 的子网，默认 VPC 已满足；HTTPS 监听器（需要 tls 与域名）与 `LB_ADMIN_AUTH=cognito`（DEP-017）不在本卡范围。iam(role) 按 C3 预置，`DescribeTargetHealth` 控制面感知在 `/lab` 中可用 |
| 预期警告 | `SEC-002`（`LB_LOCK_ORIGIN=off` 时入口对公网开放，A/B 正是靠它；选做第 7 步锁定后消失）、`DEP-011`（没有 HTTPS 监听器与 Cognito，F12 的 ALB 认证子功能关闭） |
| 目标模块 | `load-balancer`：`LB_MODE=alb`、`LB_HTTPS=false`、`LB_LOCK_ORIGIN=off`（选做改为 `on`） |
| 费用档位与主要计费来源 | 中：ALB 按小时 + LCU（没有流量也按小时扣费）；ALB 各 AZ 节点的公网 IPv4；选做的访问日志写 S3 |
| 人工前置 | 无 |
| SAA 考试领域 | 弹性、高性能 |
| 推荐的前置卡片 | `svc-ec2` |
| 徽章 | “负载均衡” |

### 实验简介

**背景**：L0 时 Nginx 自己就是“负载均衡器”，上游只有本机的一个（或本地档的两个）Node 进程，实例就是唯一入口。ALB 是跨 AZ 的托管入口，负责健康检查、HTTPS 终止、WAF 与 Cognito 认证的挂载。但只挂一个目标时，重启实例的中断与没有 ALB 时一样——ALB 是高可用的前提，不是高可用本身。

**你将学到**
- ALB、NLB、GWLB 的区别；监听器、规则、目标组。
- 健康检查路径为什么只检查本实例条件（`/api/health/ready?scope=instance`）。
- 所有目标都不健康时 ALB 会“失效开放”。
- `X-Forwarded-For` 与真实客户端 IP 只在 Nginx 解析一次。
- ALB 的 IP 会变化：用 DNS 名称或 Alias，需要固定 IP 时用 NLB 或 Global Accelerator。

**实验资源**：栈 `cloudalbum-<envName>-load-balancer`（ALB、目标组 `cloudalbum-<envName>-app-tg`、安全组 `cloudalbum-<envName>-alb-sg`）；实验机上的 `lb-realip.conf`；实验脚本 `experiments/load-balancer/`（`rolling-restart`、`health-fail`、`latency`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：单进程重启 | 对比实验 | `npm run exp -- load-balancer --label before --scenario rolling-restart --upload`，配置 a：单进程，`TARGET=direct`，恒定负载 3 分钟、第 60 秒重启 api | `EXP load-balancer/rolling-restart(before)`：重启期间出现秒级 502；`CAP`：`load-balancer` 的 `driver=nginx`、`status=off`（once） |
| 2 | （选做）本机双进程 | 脚本 + 对比实验 | 本地档 `LB_LOCAL_WORKERS=2`，再以变体 `workers-2`（配置 b，基线角色）跑 `rolling-restart` | `EXP load-balancer/rolling-restart(workers-2)`（非必需）；`HTTP`（`from: platform`，`target: public-ip`，`/api/lab/probe/now`，`repeat: 4`）：路径头 `load-balancer=nginx:w3000` 与 `nginx:w3001` 都出现（once：做了第 7 步锁定入口后平台访问不到 `public-ip`） |
| 3 | 启用 ALB（接入应用） | 脚本 | `scripts/module enable load-balancer`：部署 ALB、目标组与安全组 → 基础栈参数 `AlbSecurityGroupId` 放行 ALB → 注册实验机 → 等待 `healthy` → 投放 realip 片段 | `CAP`：`load-balancer` 的 `driver=alb`、`healthy`（SEC-002、DEP-011 为卡片级预期警告）；`HTTP`（`from: platform`，`target: alb`，`/api/health/ready`）：200，`entry=alb>nginx`；`AWS`：`elasticloadbalancing:DescribeTargetHealth`（`ownership: session`：ALB 由学员这一步经模块栈创建）——实验机目标为 `healthy` |
| 4 | 请求头与真实 IP | 观察 | `/lab`“请求头回显”分别经直连与 ALB 请求，对比 `X-Forwarded-For` 链与应用看到的客户端 IP | `HTTP`（`from: platform`，`target: alb`，`/api/lab/probe/echo`）：200，`entry=alb>nginx`，回显中有 `X-Amzn-Trace-Id`、`X-Forwarded-Proto=http`（`probe/echo` 回显这两个头由 06 规定，C5）；`MAN`：两条路径下应用看到的客户端 IP 是否一致 |
| 5 | after：ALB + 单目标重启 | 对比实验 | `rolling-restart --label after`，配置 c：`TARGET=alb` | `EXP load-balancer/rolling-restart(after)`：与 before 成对有效；中断与基线同一量级（ALB 本身不提供高可用） |
| 6 | 健康检查失败与失效开放 | 对比实验 | `health-fail`：让 `ready?scope=instance` 返回 503 共 90 秒，学员在 `/lab` 的目标健康面板（起始状态带 iam，可用）或用 `aws elbv2 describe-target-health` 每 5 秒观察一次，同时持续发请求 | `EXP load-balancer/health-fail(after)`：目标变为 `unhealthy`，请求仍被处理（只有一个目标时失效开放）；`MAN`：记录目标状态的变化时间 |
| 7 | （选做）锁定入口与延迟 | 脚本 + 对比实验 | `LB_LOCK_ORIGIN=on`（`PublicHttpIngress` 至少 `admin-ip`，管理员地址取 `{{ workstation.publicIp }}/32`）→ SEC-002 消失（DEP-011 仍在）；`latency` 比较直连与经 ALB 的 p50/p95（直连只剩工作台能访问）。锁定后方案 B 的直连预览失效，改为新标签页打开 ALB 地址（03 §6.2）；平台的 `from: platform, target: public-ip` 检查也不再可用 | `AWS`：`ec2:DescribeSecurityGroupRules`——实验机 80/443 不再对 `0.0.0.0/0` 开放；`EXP load-balancer/latency(after)` |

### 对比实验

引用 `experiments/load-balancer/`（01#load-balancer §5）。`LB_LOCK_ORIGIN=off` 时 EIP 直连与 ALB 同时指向同一台实例，可以运行时 A/B。模块文档中的配置 d（ALB + ASG 两台实例，接近零错误）属于 `svc-autoscaling`，本卡只在结论中提及。

| 观察点 | 没有 ALB（Nginx 单机） | 有 ALB |
|---|---|---|
| 入口 | 实例 EIP | 跨 AZ 的托管入口（DNS 名称，IP 会变化） |
| 健康检查与摘除 | 本机 systemd 与定时器重启进程 | 目标组健康检查；只有一个目标时失效开放 |
| 重启期间 | 单进程有秒级 502；本地双进程滚动可接近零错误 | 单目标同基线；两个以上目标 + 注销延迟才接近零错误 |
| HTTPS 终止 | Nginx | ALB（区域证书，本卡不做） |
| WAF 与 Cognito 认证 | Nginx 限速、应用自己的登录 | 可挂 REGIONAL Web ACL、`authenticate-cognito` |
| 固定费用 | 无 | 按小时 + LCU，外加节点的公网 IPv4 |

### 小测

1. **（单选）** 需要按路径把 `/api/*` 与 `/admin*` 转发到不同的目标组，并在负载均衡器上直接完成 Cognito 登录。应选择：
   A. Application Load Balancer　B. Network Load Balancer　C. Gateway Load Balancer　D. Classic Load Balancer
   **答案：A**。解析：ALB 工作在七层，支持基于路径、主机、请求头的规则，以及 `authenticate-cognito` / `authenticate-oidc` 动作（要求 HTTPS 监听器）。
2. **（单选）** ALB 后面只有一个目标，且它的健康检查持续失败。此时 ALB 会：
   A. 失效开放，仍然把请求转发给该目标　B. 立即返回 503 并停止转发　C. 自动启动一台新实例　D. 把流量转到其他区域
   **答案：A**。解析：所有目标都不健康时 ALB 会向全部目标转发（失效开放），所以单目标看不出“摘除”效果；替换实例是 Auto Scaling 的职责。
3. **（多选，选 2 项）** 合作方要求为入口提供固定 IP 以便加白名单，同时仍需 ALB 的七层路由。可行的做法是：
   A. 在 ALB 前加 AWS Global Accelerator（静态 Anycast IP）　B. 用 NLB，并把 ALB 注册为 NLB 的 ALB 类型目标组　C. 给 ALB 绑定弹性 IP　D. 在 DNS 中写死 ALB 当前的 IP
   **答案：A、B**。解析：ALB 不能绑定 EIP，IP 会变化；NLB 每个 AZ 可以有静态 IP，并支持以 ALB 为目标；Global Accelerator 提供两个静态 Anycast IP。

### 清理说明

- ALB **没有流量也按小时计费**，做完就结束实验。回收器删除 ALB、目标组与安全组，并清空基础栈参数 `AlbSecurityGroupId`。
- 第 6 步的 `health-fail` 到时会自动恢复；如果中途中断，调用一次恢复接口（见手册），否则最终复核时目标仍是 `unhealthy`。
- 选做开启了 S3 访问日志时，日志桶按数据保护约定保留，栈删除后由回收器清空并删除（02 §7.5 S2）。

### 对应 SAA 考点

ALB、NLB、GWLB、CLB 的区别；监听器、规则条件、目标组类型（instance、ip、lambda）；健康检查与失效开放；跨区负载均衡、注销延迟、慢启动；粘性会话；`X-Forwarded-For` 与 `X-Forwarded-Proto`；`authenticate-cognito` / `authenticate-oidc`；用 ACM 做 SSL 卸载与 SNI；固定响应与重定向、加权目标组；访问日志与 LCU 计费；ALB 至少两个 AZ，IP 会变化，固定 IP 用 NLB 或 Global Accelerator。

---

## 9. svc-autoscaling：Amazon EC2 Auto Scaling：弹性伸缩

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-autoscaling` |
| kind | `service` |
| 标题 | Amazon EC2 Auto Scaling：弹性伸缩 |
| 一句话简介 | 把单实例换成 ALB 后面的一组无状态实例：压测时自动扩容，终止一台几分钟内自动补齐，实例刷新几乎零错误。 |
| 涉及的 AWS 服务 | Amazon EC2 Auto Scaling（主：ASG、启动模板、目标跟踪策略、生命周期钩子、实例刷新）；SSM Parameter Store（SecureString 引导配置包）；CloudWatch（目标跟踪自动创建的告警）；前置：ALB、Amazon RDS for PostgreSQL、Amazon S3、IAM |
| 对应的模块 | `autoscaling`（目标）；`iam`、`load-balancer`、`database`、`storage`（前置） |
| 难度 | 高级 |
| 预计时长 / 时间上限 / 可延长 | 120 分钟 / 180 分钟 / 2 次 × 30 分钟（高档位：保留环境最长 12 小时）。必需实验为 `stateless-check`、`scale-out`、`terminate-drill`、`refresh`，`max-toggle` 改为选做；`scale-out` 需要短轮次参数（附录 B-10），否则时长偏紧 |
| startProfile | `l0-ec2` + `iam` + `storage` + `database` + `load-balancer`（档位 `atl/svc-autoscaling/default`），**关闭方案 B**，逐项：① **iam（`IAM_CREDENTIALS=role`，`basis: credential`）**——C3 通则，同时也是 DEP-007 的条件：ASG 实例要用实例角色读取引导配置包；autoscaling 本身是 `credentials: required`。② **load-balancer（`LB_MODE=alb`，`basis: closure`，`rule: DEP-007`）**——统一入口与目标组健康检查。③ **database（RDS for PostgreSQL，`MultiAz=false`，从 SQLite 迁移；`rule: ASG-002`/`ASG-003`）**——不能是 SQLite，也不能是本机上的库；单 AZ 是因为本卡关注计算层，Multi-AZ 属于 `svc-database` 与 `sc-ha-web`。④ **storage（`STORAGE_DRIVER=s3`，从本地迁移；`rule: ASG-001`）**——`storage \| shared-fs` 中选 storage（`branches`）：registry 表达式中的第一个分支、S3 按量计费且不绑定 VPC；EFS 做法属于场景卡 `sc-ha-web` 的变体。⑤ **方案 B 关闭**（C5：`startProfile.platform.preview.directHttps: off`，`TLS_MODE=selfsigned`）——ASG-014 禁止 `DEPLOY_MODE=asg` 与 `letsencrypt` 同时出现；预览改为新标签页打开 ALB 的 http 地址。⑥ 其余多实例规则无需额外模块：`CACHE_DRIVER=none`、`QUEUE_DRIVER=sync`、LockPort 在有 PostgreSQL 时自动用 pg 锁（ASG-006 不触发）、`SECRETS_ORIGIN=bundle` 由 autoscaling 启用时写入引导配置包（ASG-007/008），因此不需要 secrets。RDS 创建与两次数据迁移使开始阶段明显变慢（`provision.class: D`） |
| 预期警告 | `ASG-009`～`ASG-013`（启用 ASG 后，L0 的 logging、monitoring、email、config 仍是本地实现，按总纲 §5.3 会把 autoscaling 标为 `degraded`）；`SEC-002`、`DEP-011`（起始状态里的 load-balancer 不锁入口、没有 HTTPS 监听器与 Cognito，健康门 `caps.profile` 同样按这两条放行） |
| 目标模块 | `autoscaling`：`DEPLOY_MODE=asg`，`MinSize=2`、`Desired=2`、`MaxSize=4`，目标跟踪 `ASGAverageCPUUtilization=50`，生命周期钩子 `terminate-drain` |
| 费用档位与主要计费来源 | 高：ASG 中 2～4 台实例（按台计费）及各自的 EBS 与公网 IPv4（默认 VPC 公有子网）；ALB 小时 + LCU；RDS 实例小时与存储；保留用于回滚的 L0 实例停机后仍计 EBS 与 EIP；S3 按量 |
| 人工前置 | 无 |
| SAA 考试领域 | 弹性、高性能、成本 |
| 推荐的前置卡片 | `svc-load-balancer`、`svc-iam`、`svc-storage`、`svc-database` |
| 徽章 | “弹性伸缩” |

### 实验简介

**背景**：单实例时，负载升高只能停机换更大的实例类型，实例坏了就是全站中断。Auto Scaling 用启动模板批量创建实例，按负载增减、坏了自动替换。前提是**实例无状态**：数据在 RDS 与 S3，密钥经引导配置包共享，TLS 在 ALB 或 CloudFront 终止。CloudAlbum 的规则引擎会在启动时拒绝一切“多实例不安全”的组合（ASG-001～014）。

**你将学到**
- 启动模板、min/desired/max、目标跟踪策略。
- 健康检查类型 EC2 与 ELB、宽限期；生命周期钩子与优雅退出。
- 实例刷新；配置分发靠“引导配置包 + 实例刷新”，而不是逐台修改。
- 无状态设计：哪些本地实现在多实例下会出错（随机 401、1/N 的 404、陈旧读、重复执行）。

**实验资源**：栈 `cloudalbum-<envName>-autoscaling`（启动模板、ASG、目标跟踪策略、生命周期钩子）；SSM SecureString 参数 `/cloudalbum/<envName>/bootstrap/bundle`；前置栈 iam、storage、database、load-balancer；实验脚本 `experiments/autoscaling/`（`stateless-check`、`scale-out`、`max-toggle`、`terminate-drill`、`refresh`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | 核对起始状态 | 观察 | 看 `/lab`：storage、database、load-balancer、iam 都是 AWS 驱动；`autoscaling` 为 `single` | `CAP`：`storage.driver=s3`、`database.driver=postgres`（detail 为 RDS）、`load-balancer.driver=alb`、`iam.driver=role`，各自 `healthy`；`CAP`：`autoscaling` 的 `driver=single`、`status=off`（once） |
| 2 | before：单实例 | 对比实验 | `stateless-check(before)`（只有一台实例，分布只有一个 `inst`） | `EXP autoscaling/stateless-check(before)` |
| 3 | 读懂多实例规则 | 观察 + 脚本 | `scripts/module enable autoscaling --dry-run`：查看 `check-config --plan` 以 `DEPLOY_MODE=asg` 演练的结果（应为 0 个 error、若干 ASG-009～013 警告），对照 ASG-001～014 说出每条被哪个前置模块满足。**同时**把工作台出口 IP `{{ workstation.publicIp }}/32` 写入 `WAF_LAB_ALLOW_CIDR`（waf 本地实现的 Nginx 白名单，供第 6 步压测，避免测成“限速”）：必须在第 4 步之前写，这样它随引导配置包一起下发；启用 ASG 之后再改 `modules.d` 会走“机群模式”，触发一次十分钟量级的实例刷新（01#autoscaling §6） | `MAN`：完成规则 ↔ 前置模块的连线题；`LOCAL env-key`（`waf`，`WAF_LAB_ALLOW_CIDR`）：非空 |
| 4 | 启用 Auto Scaling（接入应用） | 脚本 | `scripts/module enable autoscaling`：发布固定版本 → 写入引导配置包（SecureString）→ 以 Desired=1 部署 → InService 且健康 → 从目标组注销 L0 实例 → Desired=2 → L0 实例停机保留用于回滚；等待 10～25 分钟 | `CAP`：`autoscaling` 的 `driver=asg`、`healthy`（ASG-009～013 为卡片级预期警告；`validation.errors` 必须为空）；`HTTP`（`from: platform`，`target: alb`，`/api/health/ready`，`repeat: 5`）：`inst` 段出现至少 2 个不同实例；`AWS`：`autoscaling:DescribeAutoScalingGroups`（`ownership: session`）——InService=2、`HealthCheckType=ELB`；`LOCAL systemd-unit`（`instances: all`，`cloudalbum-api`）：每台都 `active`。实例发现按 `atl:env-id` + `atl:role=lab-app`，ASG 模式下只取本环境 ASG 中 `InService` 的实例（04 §5.2.1），停机保留的 L0 实例不会被选中；ASG 实例能被发现的前提是启动模板传播会话与角色标签（附录 B-16） |
| 5 | after：无状态一致性 | 对比实验 | `stateless-check(after)`：令牌、媒体、相册在各实例上一致；`/lab` 一致性表全部一致 | `EXP autoscaling/stateless-check(after)`：与 before 成对有效，全部 200 |
| 6 | 扩容 | 对比实验 | 跑 `scale-out`（短轮次参数）；选做：再跑 `max-toggle`（max=1 与 max=4 对比） | `EXP autoscaling/scale-out(after)`：InService 数增加；`AWS`：`autoscaling:DescribeScalingActivities`——本会话出现扩容活动；选做 `EXP autoscaling/max-toggle(after)` |
| 7 | 自愈与实例刷新 | 对比实验 | `terminate-drill`：恒定负载下终止 ASG 中的一台；`refresh`：负载下执行 `start-instance-refresh` | `EXP autoscaling/terminate-drill(after)`：分钟级补齐、只有少量在途请求出错；`EXP autoscaling/refresh(after)`：错误数接近 0 |
| 8 | （选做）不安全组合 | 对比实验 | `CLOUDALBUM_ALLOW_UNSAFE=ASG-001,ASG-004,ASG-005,ASG-006,ASG-007` 并把对应驱动改回本地实现，实例刷新后以变体 `unsafe` 重跑 `npm run exp -- autoscaling --label unsafe --scenario stateless-check --upload`（C5：结果标注 `variant=unsafe`），然后立即恢复 | `CAP`（`app`）：`validation.overridden` 曾出现、最终为空；`MAN`：记录随机 401、约 1/N 的 404 等现象 |

### 对比实验

引用 `experiments/autoscaling/`（01#autoscaling §5）。`single` 与 `asg` 之间是切换前后测量；启用后，一致性检查与 `max-toggle` 可以运行时对比。

| 观察点 | 没有 Auto Scaling（单实例） | 有 Auto Scaling |
|---|---|---|
| 实例数量 | 1 台，手工维护 | Min～Max 之间自动增减 |
| 负载升高 | 延迟上升、开始出错，只能停机换实例类型 | 告警触发扩容，分钟级完成 |
| 实例故障 | 全站中断，直到人工重建 | 自动替换，少量在途请求出错 |
| 发布 | 重启有短暂中断 | 实例刷新，先启后停，接近零错误 |
| 状态 | 全部在本机数据卷 | 实例无状态，状态在 RDS 与 S3 |
| 每个请求由谁处理 | 永远同一台 | `inst`、`az` 在多台之间轮换 |

### 小测

1. **（单选）** Auto Scaling 组中的实例应用层已经故障（ALB 健康检查失败），却一直没有被替换。最可能的原因是：
   A. 组的健康检查类型是 EC2，应改为 ELB　B. 最大容量太小　C. 没有配置生命周期钩子　D. 没有开启详细监控
   **答案：A**。解析：EC2 类型只看实例状态检查；ELB 类型才把目标组健康检查结果纳入替换判断。宽限期要覆盖启动与安装所需时间，否则会反复替换。
2. **（单选）** 缩容时实例会被终止，但它可能正在处理异步任务。最合适的做法是：
   A. 配置 `EC2_INSTANCE_TERMINATING` 生命周期钩子，应用排空后调用 `CompleteLifecycleAction`　B. 对全部实例永久开启缩容保护　C. 开启粘性会话　D. 改用预测式伸缩
   **答案：A**。解析：生命周期钩子让实例停留在 Terminating:Wait，应用完成在途工作后继续终止；永久缩容保护会让伸缩失效。
3. **（多选，选 2 项）** 为了让 Web 层可以放进 Auto Scaling 组水平扩展，下列做法正确的是：
   A. 会话状态放在 ElastiCache 或 DynamoDB　B. 用户上传的文件存到 S3　C. 每台实例使用自己的本地 SQLite　D. 依赖粘性会话让用户总落在同一台实例
   **答案：A、B**。解析：本地数据库与粘性会话都会把状态绑在某台实例上，缩容或故障时丢失或不一致。

### 清理说明

- ASG 会自动补齐实例：回收器必须先把 min/desired 置 0 再删除 ASG。`terminate-drill` 只能终止 ASG 中的实例，**不要终止被保留的 L0 实例**（回滚依赖它）。
- 引导配置包是 SecureString，里面有共享的 `secrets.env`。它由 `scripts/module` 在栈外写入，记在 state.json 的带外段，回收器按台账删除（02 §6.5 第 6 条、§7.5 S2）；不要把参数值复制到别处。
- RDS 回收时跳过最终快照、删除自动备份；数据卷与 S3 桶按数据保护约定保留，栈删除后由回收器按台账删除（02 §7.5）。
- `CLOUDALBUM_ALLOW_UNSAFE` 演示结束立即清除（最终复核要求 `validation.overridden` 为空）。`WAF_LAB_ALLOW_CIDR` 在 ASG 模式下清除会触发一次实例刷新：会话结束时环境整体回收，可以不清；只有选择“保留环境”时才需要清除。

### 对应 SAA 考点

启动模板与启动配置；min/desired/max；目标跟踪、步进、简单、预定、预测式伸缩；冷却与实例预热；健康检查类型 EC2 与 ELB、宽限期；生命周期钩子、终止策略、AZ 再平衡、缩容保护；实例刷新、暖池；混合实例策略与 Spot；无状态设计（会话放 ElastiCache/DynamoDB，文件放 S3/EFS）；按 SQS 积压量伸缩；黄金 AMI 与 User Data 的取舍；纵向与横向扩展。

---

## 10. svc-iam：AWS IAM：服务器访问 AWS 的凭证

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-iam` |
| kind | `service` |
| 标题 | AWS IAM：服务器访问 AWS 的凭证 |
| 一句话简介 | 让应用第一次拥有 AWS 身份：比较“不用凭证、长期访问密钥、实例角色临时凭证”，看清 IMDSv2、撤销会话与 CloudTrail 中的差别。 |
| 涉及的 AWS 服务 | AWS IAM（主：角色、实例配置文件、客户托管策略）；AWS STS（临时凭证、`GetCallerIdentity`）；AWS CloudTrail（事件历史，只读）；EC2 IMDSv2 |
| 对应的模块 | `iam` |
| 难度 | 初级 |
| 预计时长 / 时间上限 / 可延长 | 60 分钟 / 90 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2`（档位 `atl/svc-iam/default`），**C3 例外：不预置 iam**——本卡的目标就是 iam。iam 没有硬依赖（`credentials: none`，它就是凭证提供方）。平台模式下实验机从一开始就挂着 `CloudAlbumAppRole`（只有 `AmazonSSMManagedInstanceCore`，`mgmt-channel`），所以本卡的“没有”是“**实例有角色，但应用 `IAM_CREDENTIALS=none`、根本不读它**”；`enable iam` 走 `AppRoleMode=existing`，只创建并附加 iam 自己的只读策略 |
| 预期警告 | 无（`expectedWarnings: []`）。keys 演示期间 iam 因 CRED-002 为 `degraded`，只用 once 检查观察，切回 role 后必须是 `ok` |
| 目标模块 | `iam`：`IAM_CREDENTIALS=role`（`keys` 只作反面教材，由平台动作执行） |
| 平台动作（`platformOps`） | `iam-keys-on`、`iam-keys-off`（必需步骤 4）；`iam-revoke-sessions`（`interruptsManagementChannel: true`）、`iam-refresh-credentials`（选做步骤 7）。`args` 只能取 registry `platformActions` 白名单中的参数（`revokeOlderSessions`、`refreshInstanceCredentials`）；请求体只带 `actionId`，由 `atl-module-op` 以运行器 `ATL_OP=module-op` 执行（01） |
| 费用档位与主要计费来源 | 低：IAM、STS 与 CloudTrail 事件历史查询不收费 |
| 人工前置 | 无 |
| SAA 考试领域 | 安全 |
| 推荐的前置卡片 | `svc-ec2` |
| 徽章 | “临时凭证” |

### 实验简介

**背景**：L0 的应用不调用任何 AWS API。从这张卡开始，应用通过实例配置文件从 IMDSv2 取得小时级、自动轮换、不落盘的临时凭证，其他模块才能调用 AWS。反面教材是把长期访问密钥（AKIA）写在磁盘上：它永不过期、会随快照和备份扩散。

**你将学到**
- 实例配置文件与访问密钥的取舍；AKIA 与 ASIA。
- “最小权限随模块增减”：每个模块一条客户托管策略，由 `scripts/module` 附加。
- `GetCallerIdentity` 不需要权限、显式 Deny 也挡不住，不能用来验证授权。
- 撤销角色会话（`aws:TokenIssueTime`）的效果与边界。
- CloudTrail 中 `AssumedRole` 与 `IAMUser` 的区别。

**实验资源**：栈 `cloudalbum-<envName>-iam`（`AppRoleMode=existing`：只读策略 `cloudalbum-<envName>-iam`；选做时平台创建演示用户 `cloudalbum-<envName>-demo-keys`）；实验脚本 `experiments/iam/`（`whoami`、`leak-scan`、`imds-ssrf`、`revoke`；`long-run` 需要数小时，不纳入卡片）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | 实例有角色 ≠ 应用在用 | 观察 + CLI（实验机终端） | `/lab` 的 iam 卡片显示“应用未使用 AWS 凭证”；在实验机上用 IMDSv2 读出角色名（只看名字，不打印凭证） | `CAP`：`iam` 的 `driver=none`、`status=off`（once）；`LOCAL imds-get`（`iam/security-credentials/`）：值为 `CloudAlbumAppRole`（检查不返回凭证内容）；`LOCAL aws-cred-source`：`appMode=none`、`envHasKeys=false`（once：第 2 步后 `appMode=role`） |
| 2 | 启用实例角色（接入应用） | 脚本 | `scripts/module enable iam`：附加 `cloudalbum-<envName>-iam` 策略、写入 `IAM_CREDENTIALS=role`、重启 | `CAP`：`iam` 的 `driver=role`、`healthy`，detail 含 `assumed-role/CloudAlbumAppRole` 与 `ASIA`；`LOCAL aws-cred-source`：`appMode=role`；`AWS`：`iam:ListAttachedRolePolicies`（`CloudAlbumAppRole`）——包含 `cloudalbum-<envName>-iam` 与 `AmazonSSMManagedInstanceCore` |
| 3 | 身份对照 | 对比实验 | `whoami`（或 `/lab` 的对照按钮）：ARN、Key 前缀、过期时间 | `EXP iam/whoami(after)` |
| 4 | 反面教材：长期访问密钥 | 观察（平台动作） | 点“切换到 keys 模式”（平台动作 `iam-keys-on`），平台以 `ATLProvisionerRole` 执行 `enable iam --mode keys`（学员边界禁止创建 IAM 用户与访问密钥，01）：演示用户 `cloudalbum-<envName>-demo-keys` 位于路径 `/cloudalbum/`、带 `ATLWorkloadBoundary`，访问密钥经 SecureString `/cloudalbum/<envName>/iam/demo-keys` 一次性交接给实验机后即删除；`whoami` 显示 AKIA；运行 `leak-scan`；再点“切回 role”（`iam-keys-off`），平台删除访问密钥 | `CAP`（`app`）：`validation.warnings` 曾含 CRED-002（`drift: once`）；`EXP iam/leak-scan`：keys 时为 before、切回后为 after，after 中 `secrets.env`、进程环境与日志里的 AKIA 命中数为 0（keys 模式期间如果跑过本地备份——每天 03:30 的 `cloudalbum-backup.timer` 或冒烟测试 S24——`backup/` 中会留下 AKIA 字符串；密钥已被删除，手册提示这正是“长期密钥随备份扩散”的现场，不计入 after 判定）；`LOCAL leaked-keys`：`count=0`；`AWS`：`iam:ListAccessKeys`（`UserName: cloudalbum-{{ session.env }}-demo-keys`；04 §5.7 的资源已统一为 `user/cloudalbum/cloudalbum-*-demo-keys`，C1）——没有 `Active` 的密钥 |
| 5 | IMDSv2 与 SSRF | CLI（实验机终端） | `bash experiments/iam/imds-ssrf.sh`：只能发 GET 的“SSRF”返回 401，正规流程 200 | `EXP iam/imds-ssrf(after)`；`LOCAL imds-get`（`checkV1Rejected`）：`v1Status=401` |
| 6 | CloudTrail 对照 | CLI（工作台） | `npx tsx experiments/_lib/cloudtrail.ts --attr Username=<实例 ID>`，以及演示用户名 | `MAN`：填写两者的 `userIdentity.type`（`AssumedRole` / `IAMUser`）与 Key 前缀 |
| 7 | （选做，平台动作）撤销会话 | 对比实验 | `aws-ping` 低速持续请求；平台对 `CloudAlbumAppRole` 执行“撤销活动会话”→ `GetRole` 列被拒、`GetCallerIdentity` 列照常 → 平台执行 `replace-iam-instance-profile-association` 并刷新应用缓存（`iam-refresh-credentials`，同时删除 `AWSRevokeOlderSessions` 内联策略）。**SSM Agent 用的也是这个角色的旧会话，平台管理通道同样中断，直到恢复动作完成**：`iam-revoke-sessions` 声明了 `interruptsManagementChannel: true`，执行后自动开启本步骤的 `expectedOutage` 窗口，期间实验机终端与本地检查显示“预期中断”。学员身份其实有权对 `CloudAlbumAppRole` 执行 `PutRolePolicy`（01 的护栏 `ProtectAppRole` 只拦删除、改信任策略、改标签、改实例配置文件），所以走平台动作的理由是“恢复必须成对、可自动完成”，不是“学员无权” | `EXP iam/revoke(after)`；`CAP`：恢复后 `iam` 为 `healthy` |

### 对比实验

引用 `experiments/iam/`（02#iam §5）。业务流量只能切换后重启；身份对照可以并排展示。

| 观察点 | 没有（none；反面教材 keys） | 有（role） |
|---|---|---|
| 能否调用 AWS API | none：不能；keys：能 | 能 |
| 凭证形态 | keys：AKIA 长期密钥 | ASIA 临时凭证 + SessionToken |
| 有效期与轮换 | 永不过期，只能人工轮换 | 小时级，EC2 自动轮换，SDK 自动刷新 |
| 明文落盘 | 数据卷上的 `secrets.env`，并随快照、同盘备份扩散 | 不落盘 |
| 泄露后处置 | 停用密钥，业务立即中断直到换新密钥 | 撤销会话让被盗副本失效；实例换新会话后恢复 |
| CloudTrail 身份 | `IAMUser`，AKIA… | `AssumedRole`，ASIA…，会话名是实例 ID |
| 业务功能与性能 | 相同 | 相同 |

### 小测

1. **（单选）** EC2 上的应用需要读写 S3。最安全、运维最省事的凭证做法是：
   A. 给实例关联带最小权限策略的 IAM 角色（实例配置文件）　B. 把访问密钥写进环境变量　C. 写进 `~/.aws/credentials`　D. 写进 User Data
   **答案：A**。解析：角色提供自动轮换的临时凭证，不落盘；User Data 可以通过 `DescribeInstanceAttribute` 读出，环境变量和文件都会随快照、备份扩散。
2. **（单选）** 怀疑某个角色的临时凭证已被盗，需要让此前签发的会话立即失效，但不删除角色。应该：
   A. 在 IAM 控制台对该角色执行“撤销活动会话”　B. 删除使用该角色的实例　C. 轮换访问密钥　D. 修改角色的信任策略
   **答案：A**。解析：撤销会话会给角色加一条按 `aws:TokenIssueTime` 拒绝旧会话的内联策略；临时凭证没有“访问密钥轮换”。注意实例上的 IMDS 仍会提供旧凭证直到轮换，实例需要换新会话才能恢复。
3. **（多选，选 2 项）** 关于 `sts:GetCallerIdentity`，下列说法正确的是：
   A. 调用它不需要任何 IAM 权限　B. 即使显式 Deny 也无法阻止调用　C. 可以用来确认角色是否仍有 S3 权限　D. 返回调用者的 Secret Access Key
   **答案：A、B**。解析：它只能证明“认证成功、我是谁”，不能证明授权；健康检查要再加一个受策略约束的调用（本模块用 `iam:GetRole`）。

### 清理说明

- 回收器复位 `CloudAlbumAppRole`：分离所有非平台附加的策略、删除内联策略（包括撤销实验留下的 `AWSRevokeOlderSessions`），删除演示用户与它的访问密钥。
- 不要把访问密钥复制到工作台或其他文件里（leak-scan 与 `leaked-keys` 会检出）；keys 模式期间做过的快照与本地备份里也有 AKIA，随会话一起删除。

### 对应 SAA 考点

IAM 用户、组、角色、策略；AWS 托管、客户托管、内联策略；实例配置文件与 `iam:PassRole`；STS 临时凭证与自动轮换；`aws:TokenIssueTime` 与撤销会话；IMDSv2 与 SSRF、跳数；策略评估逻辑（显式 Deny 优先、默认拒绝，`GetCallerIdentity` 例外）；SDK 默认凭证链的优先级；权限边界、SCP 与身份策略的关系；解读 CloudTrail 中的 `userIdentity`。

---

## 11. svc-auth：Amazon Cognito User Pool：用户注册登录

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-auth` |
| kind | `service` |
| 标题 | Amazon Cognito User Pool：用户注册登录 |
| 一句话简介 | 把“EC2 自己存密码哈希、自己签 JWT”的登录换成 Cognito User Pool：功能更多、代码更少，但“登出后立即失效”与责任划分都变了。 |
| 涉及的 AWS 服务 | Amazon Cognito User Pool（主：用户池、应用客户端、用户组）；IAM（应用策略）；AWS Lambda（触发器，本卡不使用） |
| 对应的模块 | `auth`（目标）；`iam`（前置） |
| 难度 | 中级 |
| 预计时长 / 时间上限 / 可延长 | 90 分钟 / 150 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam`（`IAM_CREDENTIALS=role`；档位 `atl/svc-auth/default`），逐项：① **iam**（`basis: credential`）——C3 通则；auth 本身也是 `credentials: required`（Admin* API、bulk 迁移、`DescribeUserPool` 探针，CRED-001）。② auth 自身没有模块硬依赖：本卡用 `COGNITO_LOGIN_MODE=sdk`（不触发 DEP-029）、`AUTH_MIGRATION=bulk`（不需要触发器与 Lambda，不触发 DEP-031）。③ **种子 `cognito-test-users`**（`kind: seed`，C5，06 的种子登记表）：auth 仍是 local 时，它只建若干已验证邮箱、密码已知的**本地**测试账号并生成 `users.csv`，作为 bulk 迁移的对象与 `login-storm` 的输入；迁移之后把这些账号设为“已确认、密码已知”是同一种子的 Cognito 阶段，在第 5 步执行（附录 B-11） |
| 预期警告 | `DEP-013`：L0 的 `EMAIL_DRIVER=outbox` 与 `AUTH_DRIVER=cognito` 同时出现，按总纲 §5.3 会把 auth 标为 `degraded`；这本身就是第 4 步的对比点 |
| 目标模块 | `auth`：`AUTH_DRIVER=cognito`、`COGNITO_LOGIN_MODE=sdk`、`AUTH_MIGRATION=bulk`、`COGNITO_TRIGGERS=off`、`AUTH_DUAL_STACK=off`（选做 `managed`） |
| 费用档位与主要计费来源 | 低：Cognito 按月活跃用户（MAU，默认 Essentials 层级，有免费额度）；默认由 Cognito 发送邮件（每日额度很低）；EC2 侧登录的 argon2 运算消耗 CPU 积分 |
| 人工前置 | 一个能收信的邮箱：Cognito 的注册验证码与迁移后的重置验证码会真实发出 |
| SAA 考试领域 | 安全、弹性 |
| 推荐的前置卡片 | `svc-iam` |
| 徽章 | “托管身份” |

### 实验简介

**背景**：L0 的登录全部由 EC2 实现：argon2id 密码哈希、ES256 JWT、邮箱验证、锁定、找回密码、可选 TOTP。启用 Cognito 后，密码与认证流程交给 User Pool，EC2 只做 BFF：代用户调用 Cognito、把 token 写进 HttpOnly Cookie、用 JWKS 在本地验签。

**你将学到**
- User Pool（认证）与 Identity Pool（授权、换 AWS 凭证）的分工。
- ID token、access token、refresh token 的用途；BFF 机密客户端与 `SECRET_HASH`。
- 无状态校验的代价：登出后本地验签的 access token 在过期前仍然有效。
- bulk 迁移：`AdminCreateUser` 不发邀请，用户首次登录时重置密码。
- 共享责任：密码由 AWS 保管，但 Cookie 安全、授权、App Client 配置（例如 `WriteAttributes`）仍是我们的责任。

**实验资源**：栈 `cloudalbum-<envName>-auth`（User Pool：`Retain` + 删除保护；BFF 客户端 `cloudalbum-bff`；用户组 admin、member）；client secret 经 SecretsPort 保存为 `cognito-client-secret`；实验脚本 `experiments/auth/`（`feature-matrix`、`login-storm`、`brute-force`、`revoke`、`token-claims`；`cross-instance` 需要多实例，不纳入）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：本地账号的家底 | 对比实验 | `feature-matrix(before)`；`cloc` 统计本地认证代码量；Token 查看器：`alg=ES256`、`iss` 是本站 | `EXP auth/feature-matrix(before)`；`CAP`：`auth` 的 `driver=local`、`status=off`（once） |
| 2 | before：登录压力、暴力破解与登出 | 对比实验 | `login-storm(before)` 同时看 CPU；`brute-force(before)` 记录 401 → 423 → 429；`revoke(before)`：登出后用旧 access token 访问 `/api/me` | `EXP auth/login-storm(before)`、`EXP auth/brute-force(before)`、`EXP auth/revoke(before)`：旧 token 立即被拒（`tv` 检查） |
| 3 | 启用 Cognito（接入应用） | 脚本 | `scripts/module enable auth`：部署 User Pool 与 BFF 客户端 → client secret 交给 SecretsPort → 只读窗口内 bulk 迁移（`MessageAction=SUPPRESS`）→ 写 `auth.env` 并重启 | `CAP`：`auth` 的 `driver=cognito`、`healthy`（DEP-013 为卡片级预期警告）；`HTTP`（`from: lab`，`target: self`，`/api/lab/probe/auth`，本机探测令牌）：路径头含 `auth=cognito:sdk`；`AWS`：`cognito-idp:DescribeUserPool`（`ownership: session`）——`DeletionProtection=ACTIVE`；`AWS`：`cognito-idp:DescribeUserPoolClient`——`WriteAttributes` 不含 `custom:plan`、`custom:app_uid` |
| 4 | 注册与验证码 | 观察（应用预览） | 用你的真实邮箱注册新账号：验证码由 Cognito 发出，`/me/outbox` 里看不到 | `MAN`：确认收到 Cognito 验证码邮件；`CAP`（`app`）：`validation.warnings` 含 DEP-013（auth=cognito 且 email=outbox 的提示，这本身就是对比点） |
| 5 | after：令牌与功能 | 对比实验 | 先准备测试账号：bulk 迁移后的账号处于“首次登录需重置密码”状态，`login-storm(after)`、`revoke(after)` 无法直接登录，所以在工作台执行种子 `cognito-test-users` 的 Cognito 阶段（命令以 06 为准），以**学员身份**对 `users.csv` 中的账号执行 `AdminSetUserPassword --permanent`（学员边界放行 `cognito-idp:*`；应用策略刻意不含这项权限；密码只写在工作台本地文件中供实验脚本读取，不在手册与证据中显示；附录 B-11）。然后看 Token 查看器：`alg=RS256`、`iss=https://cognito-idp…`、`token_use`、`client_id`；`feature-matrix(after)`、`cloc` | `EXP auth/feature-matrix(after)`：与 before 成对有效；`EXP auth/token-claims(after)` |
| 6 | after：登录压力与暴力破解 | 对比实验 | `login-storm(after)`：EC2 CPU 基本不受影响；`brute-force(after)`：NotAuthorized → “尝试次数超限”（BFF 映射为 429） | `EXP auth/login-storm(after)`、`EXP auth/brute-force(after)`：均与 before 成对有效 |
| 7 | 登出后的令牌 | 对比实验 | `revoke(after)`：cognito 下 refresh token 立即失效，本地验签的 access token 在过期前（不超过配置的有效期）仍然可用 | `EXP auth/revoke(after)`：与 before 成对有效，记录旧 access token 仍可用的时长 |
| 8 | （选做）托管登录与迁移用户首次登录 | 脚本 + 观察 | ① 迁移账号首次登录走“重置密码”：需要一个用你真实邮箱注册的**本地**账号，所以要在第 3 步迁移之前注册（经 `/me/outbox` 完成本地验证），且不要放进第 5 步的密码准备清单；② `COGNITO_LOGIN_MODE=managed` 需要受信 HTTPS（DEP-029）：平台方案 B 的 IP 证书在规则上满足（方案 B 下 `https.trusted` 与 `APP_BASE_URL` 的取值以 06 为准），但 Cognito 是否接受以 IP 为主机名的回调地址以官方文档为准、列入 07 的验证项，不满足时跳过（在 `sc-user-identity` 中用 CloudFront 域名完成）；托管登录在新标签页完成（预览框内的 Cookie 规则见 06） | `CAP`：`auth` 的 detail 含 `managed`（如完成）；`MAN` |

### 对比实验

引用 `experiments/auth/`（02#auth §5）。默认切换前后各测一次（`AUTH_DUAL_STACK=off`）。

| 观察点 | 没有 Cognito（local） | 有 Cognito User Pool |
|---|---|---|
| 密码存储 | 自己保存 argon2id 哈希 | AWS 保管，应用接触不到哈希 |
| 验证邮件 | 经 EmailPort 写入 outbox | Cognito 发送（默认发件人） |
| MFA、社交登录、联合 | 自己实现 TOTP；每个 IdP 自己集成 | 开箱即有，配置即可（按层级） |
| 账号锁定 | 本地计数 + Nginx 限速，多实例要共享状态 | 内置临时锁定，全局统一 |
| 令牌签名 | ES256，自己的密钥 | RS256，JWKS 校验 |
| 登出后旧 access token | 立即失效（`tv` 检查） | refresh token 立即失效；access token 在过期前仍有效 |
| 登录对 EC2 CPU 的影响 | argon2 推高 CPU、消耗积分 | 基本没有，多一次同区域往返 |
| 自写代码 | 多 | 少 |

### 小测

1. **（单选）** 网页应用需要用户注册、登录、MFA 与社交登录，团队不想自己保存密码哈希。应使用：
   A. Amazon Cognito User Pool　B. Amazon Cognito Identity Pool　C. 为每个用户创建 IAM 用户　D. IAM Identity Center
   **答案：A**。解析：User Pool 负责认证（你是谁）；Identity Pool 负责把已认证身份换成 AWS 临时凭证；IAM Identity Center 面向员工访问 AWS 账号与企业应用，而不是面向终端用户的应用注册。
2. **（单选）** 想在 ALB 上直接要求访问 `/admin*` 的用户先通过 Cognito 登录，前提是：
   A. 使用 HTTPS 监听器　B. 改用 NLB　C. 目标组类型为 Lambda　D. 开启粘性会话
   **答案：A**。解析：`authenticate-cognito` 动作只能用于 HTTPS 监听器，App Client 需要客户端密钥，回调地址为 `/oauth2/idpresponse`。
3. **（多选，选 2 项）** 后端（BFF）使用 Cognito 时，下列说法正确的是：
   A. 后端机密客户端可以有客户端密钥，调用相关 API 时要计算 `SECRET_HASH`　B. 校验 access token 时要同时校验 `token_use` 与 `client_id`　C. 运行在浏览器里的 SPA 公有客户端也应保存客户端密钥　D. 本地验签的 access token 在 GlobalSignOut 后立即失效
   **答案：A、B**。解析：公有客户端无法保密，不能有密钥；GlobalSignOut 让 refresh token 失效，但本地验签的 access token 在过期前仍然有效。

### 清理说明

- User Pool 设置了 `Retain` 与删除保护：栈删除后它作为 `RETAINED` 资源进入台账，回收器先关闭删除保护再删除（02 §7.5 S2 已写明），学员不需要手动处理。
- 如果开启过托管登录，User Pool 域名前缀 `cloudalbum-<envName>-<账号>` 会被下一次会话复用，回收时一并删除。
- Cognito 已发到你邮箱的邮件无法撤回；不要用别人的邮箱注册测试账号。

### 对应 SAA 考点

User Pool 与 Identity Pool；ID、access、refresh token；授权码 + PKCE，公有客户端与机密客户端；ALB `authenticate-cognito` 只能用于 HTTPS 监听器；API Gateway HTTP API 的 JWT 授权器；Lambda 触发器（Pre Sign-up、Pre Token Generation、User Migration）；社交登录与 SAML 联合；托管登录自定义域名证书在 us-east-1；无状态会话是 ASG 水平扩展的前提；Cognito 与 IAM Identity Center 的适用场景；功能层级与威胁防护；共享责任模型。

---

## 12. svc-identity-pool：Amazon Cognito Identity Pool：终端用户直传 S3

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-identity-pool` |
| kind | `service` |
| 标题 | Amazon Cognito Identity Pool：终端用户直传 S3 |
| 一句话简介 | 已登录用户换取一组只能写自己前缀的 STS 临时凭证，浏览器直接分片上传到 S3：授权从“应用代码”搬到“IAM 策略变量”。 |
| 涉及的 AWS 服务 | Amazon Cognito Identity Pool（主）；IAM（Uploader 角色、策略变量）；AWS STS（`AssumeRoleWithWebIdentity`）；Amazon S3（模块自带暂存桶、storage 的原图桶）；Amazon Cognito User Pool（前置） |
| 对应的模块 | `identity-pool`（目标）；`iam`、`storage`、`auth`（前置） |
| 难度 | 中级（多个身份服务配合；数据迁移由平台在起始状态完成） |
| 预计时长 / 时间上限 / 可延长 | 90 分钟 / 150 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam` + `storage` + `auth`，逐项：① **storage（`STORAGE_DRIVER=s3`，从本地迁移）**——DEP-002：最终的原图位置必须在 S3。② **auth（`AUTH_DRIVER=cognito`，`sdk`，`bulk`）**——DEP-002 的第二个条件二选一：`auth=cognito`，或 `auth=local` + `IDENTITY_DEV_PROVIDER`（开发者认证身份）。**选 cognito**：registry 表达式在 `IDENTITY_DEV_PROVIDER` 为空时直接要求 auth；User Pool + Identity Pool 是 SAA 的标准组合；开发者认证身份需要额外的 `GetOpenIdTokenForDeveloperIdentity` 权限与自定义集成，留作选读。③ **iam（role）**——C3 通则；以上三个模块也都是 `credentials: required`（CRED-001）。④ **种子 `cognito-test-users`**（`kind: seed`，C5，06 的种子登记表）：越权测试需要两个**已确认、密码已知**的 Cognito 测试用户 A、B，种子在 `profile-apply` 之后、学员进入之前生成；执行身份按 06 的选择：运行器在 `profile-apply` 之后执行种子的实验机部分并登记钩子，Cognito 中的已知密码由工作台接线时以学员身份执行钩子 `cognito-passwords` 设置（03 §4.6 第 3a 步、06 PM-36、PM-44；运行器不获得 `cognito-idp:Admin*`，01 §6.7），学员进入工作台时测试用户已可登录（附录 B-11）。⑤ HTTPS：DEP-030（warn）在 `APP_BASE_URL` 为 http 时把 identity-pool 标为 `degraded`（临时凭证经明文下发）。本卡依赖平台方案 B 提供受信 HTTPS；方案 B 下 `APP_BASE_URL` 是否改为 https 由 06 定义，在定义之前 DEP-030 列为预期警告，并在手册中说明（附录 B-5） |
| 预期警告 | `DEP-013`（起始状态中的 auth=cognito 与 L0 的 `EMAIL_DRIVER=outbox` 同时出现，健康门 `caps.profile` 按它放行）、`DEP-030`（见 startProfile ⑤） |
| 目标模块 | `identity-pool`：`IDENTITY_POOL_ID` 非空（暂存桶默认 SSE-S3） |
| 费用档位与主要计费来源 | 低：Identity Pool 不单独收费；S3 请求与少量存储（每张照片多一次 CopyObject 与 DeleteObject，暂存对象 1 天过期）；Cognito MAU |
| 人工前置 | 无 |
| SAA 考试领域 | 安全、高性能 |
| 推荐的前置卡片 | `svc-auth`、`svc-storage` |
| 徽章 | “直传 S3” |

### 实验简介

**背景**：F14 是“多文件、可续传、按前缀授权的直传”。没有 Identity Pool 时，EC2 签发一个应用自定义的前缀令牌，每一片都要先问一次 EC2（storage=s3 时先要签名 URL）。启用后，浏览器持有只能写 `private/<identityId>/` 的 STS 凭证，自己签名直传到暂存桶；`complete` 时后端校验大小、类型与文件头，再用服务端 CopyObject 导入原图位置。

**你将学到**
- User Pool 与 Identity Pool 的分工；Web 身份联合与 `AssumeRoleWithWebIdentity`。
- 信任策略中的 `aud`、`amr` 条件；策略变量 `${cognito-identity.amazonaws.com:sub}`（是 Identity ID，不是 User Pool 的 sub）。
- 应用自签令牌、预签名 URL、临时凭证三者的取舍。
- S3 CORS 必须暴露 ETag；分片上传与生命周期清理。

**实验资源**：栈 `cloudalbum-<envName>-identity-pool`（身份池、`CloudAlbumUploaderRole`、暂存桶 `cloudalbum-<envName>-upload-staging-<账号>`）；前置栈 iam、storage、auth；实验脚本 `experiments/identity-pool/`（`cross-prefix`、`upload-bench`、`resume`、`policy-sim`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：前缀令牌 | 对比实验 | `upload-bench(before, --mode token)`；在 DevTools 中看到每一片前都有一次 `parts:sign` 请求发往 EC2 | `EXP identity-pool/upload-bench(before)`；`CAP`：`identity-pool` 的 `driver=none`、`status=off`（once） |
| 2 | before：越权由谁拒绝 | 对比实验 | `cross-prefix(before, token)`：用户 A 写 B 的前缀，被应用以 403 `UPLOAD_PREFIX_DENIED` 拒绝 | `EXP identity-pool/cross-prefix(before)` |
| 3 | 启用 Identity Pool（接入应用） | 脚本 | `scripts/module enable identity-pool`：身份池（不允许未认证身份）、Uploader 角色、暂存桶（CORS 暴露 ETag、1 天生命周期、不配事件通知）→ 写 `identity-pool.env` 并重启 | `CAP`：`identity-pool` 的 `driver=cognito`、`healthy`（只允许 DEP-030）；`HTTP`（`from: lab`，`target: self`，`/api/lab/probe/identity-pool`，本机探测令牌）：路径头含 `identity-pool=cognito:probe`（06 PM-11：探测主体没有终端用户的 ID 令牌，探测端点只输出 `cognito:probe`，第 3 轮改写）；`LOCAL path-seen`（`segment: identity-pool`，`pattern: ^cognito:sts$`，`window: 15m`，`minCount: 1`；学员先在应用预览中上传一张照片）：真实上传确实经 Identity Pool 换取了 STS 临时凭证；`AWS`：`cognito-identity:DescribeIdentityPool`（`ownership: session`）——`AllowUnauthenticatedIdentities=false`；`AWS`：`cognito-identity:GetIdentityPoolRoles`——已认证角色为 `CloudAlbumUploaderRole` |
| 4 | 读策略 | 控制台 | 在 IAM 控制台查看 Uploader 角色：信任策略的 `aud`、`amr` 条件；权限资源 `private/${cognito-identity.amazonaws.com:sub}/*`；用 Policy Simulator 模拟不同前缀（`policy-sim`） | `AWS`：`iam:GetRole`（`CloudAlbumUploaderRole`）——信任策略同时含 `cognito-identity.amazonaws.com:aud` 与 `amr` 条件；`MAN`：记录模拟结果 |
| 5 | after：直传与越权 | 对比实验 | `upload-bench(after, --mode sts)`：中间没有发往 EC2 的分片请求；`cross-prefix(after, sts)`：写 B 的前缀被 S3 返回 AccessDenied | `EXP identity-pool/upload-bench(after)`、`EXP identity-pool/cross-prefix(after)`：均与 before 成对有效 |
| 6 | 断点续传 | 对比实验 | `resume --mode sts`：上传中途断网再恢复，只重传缺失的分片 | `EXP identity-pool/resume(after)` |
| 7 | （选做）同一部署内 A/B | 观察 | 管理员开会话时带 `X-Compare-Bypass: identity-pool`，本次改由前缀令牌上传 | `MAN`：记录两种会话的路径头（`identity-pool=cognito:bypass` 与 `cognito:sts`） |

### 对比实验

引用 `experiments/identity-pool/`（02#identity-pool §5）。可以运行时 A/B（`X-Compare-Bypass: identity-pool`，只在 `POST /api/uploads/session` 上有效）。

| 观察点 | 没有 Identity Pool（应用自签前缀令牌） | 有 Identity Pool（STS 临时凭证直传） |
|---|---|---|
| 浏览器持有什么 | 一个只有本应用认识的 HMAC 令牌 | 一组 S3 直接认识的 ASIA 临时凭证 |
| 授权在哪里执行 | 应用代码：每一片都由 Node 校验 | IAM 策略变量，由 S3 在服务端执行 |
| 每个文件对后端的请求 | 建档 + 每个分片一次 + complete | 换一次凭证 + 每个文件建档与 complete |
| 越权时谁拒绝 | 应用返回 403 | S3 返回 AccessDenied |
| 撤销 | 应用维护 `jti` 黑名单 | 凭证到期前无法单独撤销 |
| 服务端控制力 | 强 | 较弱：IAM 管不了大小与类型，靠 complete 校验与 1 天过期兜底 |

### 小测

1. **（单选）** 已登录用户需要直接把照片上传到 S3 中“只属于自己”的前缀，且授权由 IAM 而不是应用代码执行。应该：
   A. 使用 Cognito Identity Pool 的已认证角色，资源写成 `private/${cognito-identity.amazonaws.com:sub}/*`　B. 把用户加入 User Pool 的组　C. 把桶设为公共可写　D. 在桶策略中允许 `Principal: *` 的 PutObject
   **答案：A**。解析：Identity Pool 把 User Pool 的 ID token 换成 STS 临时凭证，策略变量把每个身份限制在自己的前缀；User Pool 的组本身不产生 AWS 凭证。
2. **（单选）** Identity Pool 已认证角色的信任策略中，为防止被其他身份池扮演，必须加入的条件是：
   A. `cognito-identity.amazonaws.com:aud` 等于本身份池 ID　B. `aws:SourceIp`　C. `s3:prefix`　D. `kms:ViaService`
   **答案：A**。解析：同时要求 `amr` 包含 `authenticated`。缺少 `aud` 条件时，任何身份池都可能扮演这个角色。
3. **（多选，选 2 项）** 浏览器向 S3 分片上传失败，可能的原因是：
   A. 桶的 CORS 没有暴露 `ETag` 响应头　B. 桶使用 SSE-KMS，而上传角色缺少 `kms:Decrypt`　C. 桶没有开启版本控制　D. 没有开启 S3 Transfer Acceleration
   **答案：A、B**。解析：浏览器需要读到每一片的 ETag 才能完成合并；SSE-KMS 下分片上传除 `kms:GenerateDataKey` 外还需要 `kms:Decrypt`。

### 清理说明

- 暂存桶必须先清空、中止未完成的分片上传才能删除，回收器会处理；原图桶（storage）按数据保护约定保留，栈删除后由回收器清空并删除（02 §7.5 S2）。
- User Pool 有删除保护（同 `svc-auth`，回收器先关闭再删）；Uploader 角色带 `ATLWorkloadBoundary`，随栈删除。
- 不要把浏览器拿到的临时凭证复制到其他地方使用；它们会在约一小时内过期，但期间可以写你自己的前缀。

### 对应 SAA 考点

User Pool 与 Identity Pool 的分工；IAM 策略变量 `${cognito-identity.amazonaws.com:sub}`；Web 身份联合、`AssumeRoleWithWebIdentity` 与信任策略的 `aud`、`amr` 条件；预签名 URL、应用令牌与临时凭证的取舍；S3 CORS（暴露 ETag）；访客身份的风险；开发者认证身份；基于规则或基于 token 的角色映射；SSE-KMS 下调用方的 KMS 权限；S3 分片上传与生命周期清理。

---

## 13. svc-secrets：AWS Secrets Manager：密码与密钥管理

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-secrets` |
| kind | `service` |
| 标题 | AWS Secrets Manager：密码与密钥管理 |
| 一句话简介 | 把数据卷上的 `secrets.env` 搬进 Secrets Manager：磁盘上不再有明文，轮换 JWT 签名密钥不用重启、用户不掉线，每次读取都有审计。 |
| 涉及的 AWS 服务 | AWS Secrets Manager（主）；IAM；AWS CloudTrail（事件历史）；AWS Lambda（选读：托管轮换函数，本卡不启用） |
| 对应的模块 | `secrets`（目标）；`iam`（前置） |
| 难度 | 中级 |
| 预计时长 / 时间上限 / 可延长 | 60 分钟 / 90 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam`（`IAM_CREDENTIALS=role`，`basis: credential`；档位 `atl/svc-secrets/default`）：C3 通则，secrets 本身也是 `credentials: required`（CRED-001）；secrets 没有模块硬依赖（`SECRETS_ROTATION=off`，不需要 Lambda；CFG-001 只约束子选项组合） |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | `secrets`：`SECRETS_DRIVER=secretsmanager`、`SECRETS_ROTATION=off`、`SECRETS_CACHE_TTL_SEC=300` |
| 费用档位与主要计费来源 | 低：按 secret 个数按月计费（本卡约 7～9 个，按存续时间折算以官方定价为准）+ 按 API 调用次数（应用缓存可大幅减少调用） |
| 人工前置 | 无 |
| SAA 考试领域 | 安全 |
| 推荐的前置卡片 | `svc-iam` |
| 徽章 | “机密托管” |

### 实验简介

**背景**：L0 的机密（JWT 签名私钥、各种 HMAC 密钥、本地主密钥……）以明文放在数据卷的 `secrets.env` 与 `keys/*.pem` 里，与它们保护的数据在同一块盘上，也会进入快照与同盘备份；改值要改文件并重启，没有版本也没有审计。迁移到 Secrets Manager 后，磁盘上只剩 `SECRETS_ORIGIN=aws`，读取有 CloudTrail 记录，轮换靠版本标签完成。

**你将学到**
- Secrets Manager 与 Parameter Store SecureString 的区别。
- 版本标签 `AWSCURRENT`、`AWSPREVIOUS`、`AWSPENDING`；轮换 Lambda 的四个步骤（选读）。
- 应用缓存与轮换的配合：遇到未知 `kid` 立即刷新。
- VPC 内的轮换函数为什么需要 Interface Endpoint 或 NAT。

**实验资源**：栈 `cloudalbum-<envName>-secrets`（`cloudalbum/<envName>/<逻辑名>` 形式的 secret 容器与应用策略）；迁移脚本 `scripts/migrate/secrets`；实验脚本 `experiments/secrets/`（`leak-scan`、`rotate-under-load`、`audit`、`cache-ttl`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：明文在哪里 | 对比实验 + CLI（实验机终端） | `leak-scan(before) --needle <测试值前 8 位>`：`secrets.env`、同盘 `backup/` 中命中，`/proc/<pid>/environ` 中没有 | `EXP secrets/leak-scan(before)`；`LOCAL file-stat`（检查 id `secrets-file-before`，`/etc/cloudalbum/secrets.env`）：存在、`0640`，证据保留 `sizeBytes`（once）；`CAP`：`secrets` 的 `driver=env`、`status=off`（once） |
| 2 | before：手工轮换 | 对比实验 | `rotate-under-load(before)`：`scripts/secrets rotate jwt-signing-key`（保留上一版本）再用 `--no-keep-previous` 重做一次 | `EXP secrets/rotate-under-load(before)`：重启期间有秒级 502；直接覆盖时旧 token 全部失效 |
| 3 | 启用 Secrets Manager（接入应用） | 脚本 | `scripts/module enable secrets`：部署栈 → 附加策略 → `migrate-module secrets up` 逐个写入（不经命令行参数）→ 重启 → 指纹校验 → `secrets.env` 只保留 `SECRETS_ORIGIN=aws` | `CAP`：`secrets` 的 `driver=secretsmanager`、`healthy`；`CAP`（`view: admin`）：`ec2.checks` 中 `key-fingerprint=ok`（主密钥值不变）；`LOCAL file-stat`（`/etc/cloudalbum/secrets.env`）：文件仍在，`sizeBytes` 小于 `{{$check.secrets-file-before.$.sizeBytes}}` 的一半（`dependsOn: [secrets-file-before]`；迁移后只剩 `SECRETS_ORIGIN=aws` 一行）；`AWS`：`secretsmanager:DescribeSecret`（`cloudalbum/{{ session.env }}/jwt-signing-key`，`ownership: session`：secret 容器由本步骤的 secrets 栈创建；`ownership` 针对单个资源 ARN，所以不用 `ListSecrets`）——存在 `AWSCURRENT` 版本 |
| 4 | after：泄露面 | 对比实验 | `leak-scan(after)`：数据卷上的当前文件里不再有明文（切换前的旧备份仍有） | `EXP secrets/leak-scan(after)`：与 before 成对有效 |
| 5 | 不重启轮换 | 对比实验 | `rotate-under-load(after)`：点 `/lab` 的“轮换 JWT 签名密钥”，Token 查看器中新 token 的 `kid` 改变、错误数为 0 | `EXP secrets/rotate-under-load(after)`：与 before 成对有效；`AWS`：`secretsmanager:DescribeSecret`（`jwt-signing-key`）——同时存在 `AWSCURRENT` 与 `AWSPREVIOUS` |
| 6 | 审计 | CLI（工作台） | `npx tsx experiments/_lib/cloudtrail.ts --attr EventName=GetSecretValue`（事件有几分钟延迟） | `MAN`：调用者是 `assumed-role/CloudAlbumAppRole/i-…`，记下事件时间 |
| 7 | （选做）缓存 TTL | 对比实验 | `cache-ttl`：`SECRETS_CACHE_TTL_SEC` 分别为 0 与 300，各跑一段同样的负载，统计 `GetSecretValue` 次数；两段分别用变体标签 `ttl-0`（基线）与 `ttl-300`（处理），C5 | `EXP secrets/cache-ttl`：`pair: [ttl-0, ttl-300]`（非必需） |

### 对比实验

引用 `experiments/secrets/`（02#secrets §5）。驱动本身只能切换前后各测一次；“轮换”能力可以在运行中演示。

| 观察点 | 没有 Secrets Manager（数据卷上的文件） | 有 Secrets Manager |
|---|---|---|
| 存放位置 | 与被保护的数据在同一块盘上 | Secrets Manager（静态加密），只在进程内存中缓存 |
| 明文落盘位置 | 文件本身、数据卷快照、同盘备份 | 无（切换前的旧备份除外） |
| 轮换 | 改文件 + 重启；忘了保留上一版本就全部掉线 | 新版本 + 版本标签，不重启、不掉线 |
| 审计 | 无 | CloudTrail 记录每一次读取与写入 |
| 多实例一致性 | 容易漂移 | 同一个来源 |
| 冷启动开销 | 无 | 首次读取多一次网络调用 |
| 费用 | 无 | 按 secret 个数与调用次数 |

### 小测

1. **（单选）** 需要定期自动轮换数据库密码，并让应用透明地取得最新值。最合适的服务是：
   A. AWS Secrets Manager（RDS 托管主密码或轮换函数）　B. Parameter Store 的 String 参数　C. 写进 User Data　D. 存成 S3 加密对象
   **答案：A**。解析：Secrets Manager 内置轮换与版本标签，RDS 还可以用托管主密码由 RDS 自己轮换；Parameter Store 没有内置轮换。
2. **（单选）** 放在 VPC 私有子网里的轮换 Lambda 一直卡住，secret 上残留 `AWSPENDING` 标签。最可能的原因是：
   A. Lambda 无法访问 Secrets Manager 端点（缺少 Interface Endpoint 或 NAT）　B. secret 的值太长　C. 没有开启 CloudTrail　D. Lambda 内存太小
   **答案：A**。解析：VPC 内的函数默认不能访问公网端点，既要能连到数据库，也要能连到 Secrets Manager。
3. **（多选，选 2 项）** 关于 Secrets Manager 与 Parameter Store SecureString，下列说法正确的是：
   A. Secrets Manager 内置轮换能力　B. Parameter Store 标准参数在标准吞吐量下不额外收费　C. Parameter Store SecureString 内置托管轮换　D. Secrets Manager 不能使用客户托管 KMS 密钥加密
   **答案：A、B**。解析：SecureString 用 KMS 加密但没有内置轮换；Secrets Manager 可以指定客户托管密钥。

### 清理说明

- 删除 secret 默认有恢复窗口，窗口内**不能重新创建同名 secret**。名称是 `cloudalbum/<envName>/<逻辑名>`，每个环境的 `envName` 不同（C1），所以下一次会话的新环境不会撞名；回收器按 02 的规定“立即删除，不进入恢复窗口”。只有在同一环境里 `disable secrets` 后马上再 `enable` 才可能短暂遇到同名冲突（强制删除在后台异步完成，以官方文档为准），`scripts/module enable secrets` 应短暂重试（附录 B-8）。
- 切换前的数据卷备份与快照里仍有明文，随会话一起删除；不要把 secret 值复制到工作台文件里。

### 对应 SAA 考点

Secrets Manager 与 Parameter Store SecureString（内置轮换、费用、跨账号共享、大小上限）；RDS 托管主密码；轮换函数的四个步骤与版本标签；VPC 内 Lambda 访问 Secrets Manager 需要 Interface Endpoint 或 NAT；KMS 信封加密与用 CMK 加密 secret；CloudFormation 动态引用 `{{resolve:secretsmanager:…}}`；Parameters and Secrets Lambda Extension；经 Parameter Store 引用 Secrets Manager 的限制。

---

## 14. svc-config：AWS Systems Manager Parameter Store：运行时配置

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-config` |
| kind | `service` |
| 标题 | AWS Systems Manager Parameter Store：运行时配置 |
| 一句话简介 | 把横幅、维护模式、缓存 TTL、日志级别这些运行时热键从 `runtime.json` 搬到 Parameter Store：不登录服务器就能改，带版本、有审计，写错的值会被拒绝。 |
| 涉及的 AWS 服务 | AWS Systems Manager Parameter Store（主）；IAM（按路径授权）；AWS CloudTrail；Amazon EventBridge（选读：参数变更事件） |
| 对应的模块 | `config`（目标）；`iam`（前置） |
| 难度 | 初级 |
| 预计时长 / 时间上限 / 可延长 | 45 分钟 / 90 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam`（`IAM_CREDENTIALS=role`，`basis: credential`；档位 `atl/svc-config/default`）：C3 通则，config 本身也是 `credentials: required`（CRED-001）；config 没有模块硬依赖 |
| 预期警告 | 无（`expectedWarnings: []`） |
| 目标模块 | `config`：`CONFIG_DRIVER=ssm`、`CONFIG_REFRESH_SEC=30` |
| 费用档位与主要计费来源 | 低：标准参数在标准吞吐量下不额外收费；高级参数与高吞吐量本卡不使用 |
| 人工前置 | 无 |
| SAA 考试领域 | 安全、弹性 |
| 推荐的前置卡片 | `svc-iam` |
| 徽章 | “远程开关” |

### 实验简介

**背景**：config 只管运行时业务热键，**不管任何模块开关或驱动**（D7）。L0 时这些热键在实验机的 `runtime.json` 里，改一个值要登录机器，没有版本与审计；多实例时容易漂移。启用后它们集中在 `/cloudalbum/<envName>/runtime/` 路径下，所有实例在一个轮询周期内收敛。

**你将学到**
- “运行时开关”与“部署配置”的区分；为什么远程开关绝不能改驱动。
- 层级路径与按路径的 IAM 授权；版本历史与回滚。
- Parameter Store、Secrets Manager、AppConfig 的分工。
- 轮询加抖动，避免限流。

**实验资源**：栈 `cloudalbum-<envName>-config`（只有应用策略与可选的变更提醒规则，**不创建参数**）；迁移脚本创建的参数 `/cloudalbum/<envName>/runtime/*`；实验脚本 `experiments/config/`（`propagation`、`history-rollback`、`audit`、`reject-invalid`、`layers`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：改一个热键要登录机器 | 对比实验 | `propagation(before, --file)`：经实验机终端修改 `runtime.json` 的 `banner`，计时 | `EXP config/propagation(before)`；`CAP`：`config` 的 `driver=file`、`status=off`（once） |
| 2 | 启用 Parameter Store（接入应用） | 脚本 | `scripts/module enable config` + `migrate-module config up`：把 `runtime.json` 的每个键写成 `/cloudalbum/<envName>/runtime/<key>` → 重启 → 在 diff 页面确认两层一致 | `CAP`：`config` 的 `driver=ssm`、`healthy`；`HTTP`（`from: lab`，`target: self`，`/api/lab/probe/now`，本机探测令牌）：路径头含 `config=ssm:v<N>`（第 3 轮由 `/api/capabilities` 改为 `/api/lab/probe/now`：capabilities 不保证经过 ConfigPort，`probe/now` 每次都读运行时热键，06 PM-11）；`AWS`：`ssm:DescribeParameters`（`ParameterFilters` 按路径 `/cloudalbum/{{ session.env }}/runtime`）——至少包含 `maintenanceMode`、`readOnly`、`maxUploadMb`、`feedCacheTtlSec`、`labBypassEnabled`、`logLevel`、`featureFlags` 这 7 个非空键。初稿写“9 个参数”：`banner` 默认为空串、`allowedEmailDomains` 默认为空列表，而 Parameter Store 不接受空值（以官方 API 校验为准），迁移脚本对空值是跳过还是写占位值未定义（附录 B-21），数量不能写死 |
| 3 | after：远程开关 | 对比实验 | `propagation(after)`：`put-parameter` 修改 `banner`，全站横幅在一个轮询周期内出现 | `EXP config/propagation(after)`：与 before 成对有效 |
| 4 | 热键的效果 | CLI + 观察 | `maintenanceMode=true` → 写接口返回 503；`logLevel=debug` → 日志量上升；随后都改回 | `MAN`：记录写接口的状态码与日志量变化；`CAP`：改回后 `config` 仍为 `healthy` |
| 5 | 历史、回滚与审计 | 对比实验 + CLI | `history-rollback`：`get-parameter-history` 找到旧值并写回；`cloudtrail.ts --attr EventName=PutParameter` 查看是谁改的 | `EXP config/history-rollback(after)`；`MAN`：填写修改者身份（学员角色会话名） |
| 6 | 拒绝非法值 | 对比实验 | `reject-invalid`：写 `maxUploadMb=-1` 与 `CACHE_DRIVER=redis`，`/lab` 分别显示“值不合法，已拒绝”和“未知键（ConfigPort 不管模块开关）”，网站行为不变；结束后**删除 `CACHE_DRIVER` 这个越权键，并用 `get-parameter-history` 把 `maxUploadMb` 写回原值**（不要删除 `maxUploadMb`：它是正式热键，删掉后应用会悄悄退回 file 层或默认值。02#config §5 的操作步骤写的是“删除这两个参数”，附录 B-21） | `EXP config/reject-invalid(after)`；`AWS`：`ssm:DescribeParameters`——不再有 `/cloudalbum/<envName>/runtime/CACHE_DRIVER`、仍有 `maxUploadMb`；`CAP`：`config` 回到 `healthy`（被拒绝的变更与未知键都已消失） |

### 对比实验

引用 `experiments/config/`（02#config §5）。驱动只能切换前后各测一次；`GET /api/lab/config/diff` 可以在运行中并排查看 file 层与 ssm 层。

| 观察点 | 没有 Parameter Store（`runtime.json`） | 有 Parameter Store |
|---|---|---|
| 修改方式 | 登录每台实例编辑文件 | 控制台 / CLI / IaC，不需要登录机器 |
| 多实例一致性 | 逐台修改，容易漂移（ASG-012） | 一个轮询周期内自动收敛 |
| 版本与回滚 | 无 | 每个参数都有版本历史 |
| 审计 | 无 | CloudTrail 记录 PutParameter 的调用者 |
| 访问控制 | 文件权限 + 谁能登录机器 | IAM 按路径授权 |
| 生效速度 | 文件监听，几乎立即 | 一个轮询周期（几十秒量级） |
| 写错值 | zod 拒绝，沿用旧快照 | 同左，另外能用版本历史写回 |

### 小测

1. **（单选）** 多台实例需要在不重新部署的情况下统一修改运行时开关，并保留版本历史与修改审计。最简单的做法是：
   A. 把开关放在 Parameter Store 的层级路径下，应用定期读取　B. 逐台登录修改本地配置文件　C. 写进 User Data　D. 重新制作 AMI
   **答案：A**。解析：Parameter Store 提供版本历史、按路径的 IAM 授权与 CloudTrail 审计；User Data 只在首次启动时执行。
2. **（单选）** 需要带验证器、按部署策略逐步发布，并在告警时自动回滚的功能开关。最合适的服务是：
   A. AWS AppConfig　B. Parameter Store 标准参数　C. AWS Secrets Manager　D. Amazon S3
   **答案：A**。解析：AppConfig 提供配置验证、部署策略与基于 CloudWatch 告警的回滚；Parameter Store 只存值，没有发布控制。
3. **（多选，选 2 项）** 关于 Parameter Store，下列说法正确的是：
   A. 可以按参数路径用 IAM 授权　B. 参数变更可以作为事件发送到 EventBridge　C. CloudFormation 可以直接创建 SecureString 参数　D. `GetParametersByPath` 可以读取 `/aws/reference/secretsmanager/` 引用
   **答案：A、B**。解析：CloudFormation 不能直接创建 SecureString 类型的参数；引用 Secrets Manager 的参数只能用 GetParameter / GetParameters 读取。

### 清理说明

- `/cloudalbum/<envName>/runtime/*` 参数由迁移脚本创建，不归 CloudFormation 管理：回收器按 CloudTrail 中的 `PutParameter` 创建事件认领后删除（02 §7.3、§7.5 S2）。第 6 步的 `CACHE_DRIVER` 请自己删除，`maxUploadMb` 写回原值。
- 第 4 步改过的 `maintenanceMode`、`logLevel` 请改回，否则最终复核时网站处于维护状态。

### 对应 SAA 考点

Parameter Store、Secrets Manager、AppConfig 的区别；标准参数与高级参数、标准吞吐量与高吞吐量；层级路径与按路径授权；SecureString 与 KMS；参数变更事件；不可变基础设施与配置外置；CloudFormation 中引用 SSM 参数（参数类型与动态引用）。

---

## 15. svc-kms：AWS KMS：数据加密密钥

### 元数据

| 字段 | 值 |
|---|---|
| id | `svc-kms` |
| kind | `service` |
| 标题 | AWS KMS：数据加密密钥 |
| 一句话简介 | 把“主密钥和密文在同一块盘上”的本地信封加密换成密钥不离开 KMS 的客户托管密钥：每次解密可审计，禁用密钥即可撤销。 |
| 涉及的 AWS 服务 | AWS KMS（主：客户托管密钥、别名、密钥策略、自动轮换）；AWS CloudTrail；Amazon EBS（选做：换成 CMK 加密的数据卷） |
| 对应的模块 | `kms`（目标）；`iam`（前置） |
| 难度 | 中级 |
| 预计时长 / 时间上限 / 可延长 | 75 分钟 / 120 分钟 / 2 次 × 30 分钟 |
| startProfile | `l0-ec2` + `iam`（`IAM_CREDENTIALS=role`，`basis: credential`；档位 `atl/svc-kms/default`）：C3 通则，kms 本身也是 `credentials: required`（CRED-001）；kms 没有模块硬依赖，`KMS_APPLY_TO` 中目标模块未启用的项直接跳过（storage、database、secrets 都不在起始状态中，所以本卡只做 `fields`，选做 `ebs`）。**种子 `gps-sample-photos`**（`kind: seed`，C5，06 的种子登记表）：平台在 `profile-apply` 之后上传 3 张带 GPS EXIF 的示例照片——加密字段是 `photos.location`，没有拍摄地点就看不到密文（附录 B-11） |
| 预期警告 | 无（`expectedWarnings: []`）。迁移进行中仍有 `local-v1` 密文时 kms 为 `degraded`（没有规则 ID），第 3 步的检查用 `pendingIf` 等待迁移完成，而不是把它当作预期警告 |
| 目标模块 | `kms`：`KMS_KEY_ID=alias/cloudalbum-{{ session.env }}`（平台模式下别名带环境名，模板参数 `AliasName`，06 PM-M13；独立模式仍为 `alias/cloudalbum`）、`KMS_APPLY_TO=fields`（选做 `ebs`） |
| 费用档位与主要计费来源 | 低：每把 CMK 按月计费（按存续时间折算以官方定价为准）+ 每次 API 请求；选做 `ebs` 新增一块 gp3 卷与快照 |
| 人工前置 | 无 |
| SAA 考试领域 | 安全 |
| 推荐的前置卡片 | `svc-iam`、`svc-secrets` |
| 徽章 | “密钥在 KMS” |

### 实验简介

**背景**：L0 的敏感字段默认就是加密的：每次生成随机数据密钥，用 AES-256-GCM 加密字段，再用 `LOCAL_MASTER_KEY` 包裹数据密钥。问题在于主密钥和密文在同一块数据卷上（快照与本地备份也同时包含两者），没人知道谁解密过，也无法“一键撤销”。换成 KMS 客户托管密钥后，密钥材料不离开 KMS，每次 `GenerateDataKey`、`Decrypt` 都进 CloudTrail，禁用密钥后各级缓存过期即无法读取。

**你将学到**
- AWS 托管密钥、客户托管密钥、AWS 自有密钥的区别；信封加密与加密上下文。
- 密钥策略与 IAM 策略的关系（根主体语句把授权委托给 IAM）。
- 数据密钥缓存、S3 Bucket Key 如何降低请求量；“禁用后多久失效”取决于各级缓存。
- RDS、EBS、EFS 只能在创建时选择加密密钥；禁用与删除的区别。

**实验资源**：栈 `cloudalbum-<envName>-kms`（CMK、别名 `alias/cloudalbum-<envName>`、应用策略）；迁移脚本 `scripts/migrate/kms`（按 `keyRef` 分批重新加密）；实验脚本 `experiments/kms/`（`ciphertext-view`、`key-file-risk`、`field-read`、`disable-demo`；`decrypt-count` 需要 storage，留给 `sc-security-baseline`）。

### 步骤大纲

| # | 步骤 | 类型 | 做什么 | 检查（类型：判定要点） |
|---|---|---|---|---|
| 1 | before：数据库里的字段 | 对比实验 + CLI（实验机终端） | `ciphertext-view(before)`：临时打开 `CRYPTO_LOCAL_PLAINTEXT=on` 上传一张带位置的照片 → `sqlite3` 中看到明文；关闭后再上传 → 看到 `ca1.local-v1.*` | `EXP kms/ciphertext-view(before)`；`CAP`：`kms` 的 `driver=local`（明文对照期间 `localHealth` 降级，关闭后恢复；once） |
| 2 | before：主密钥与密文同盘 | 对比实验 | `key-file-risk`：在数据卷的 `secrets.env` 中找到 `LOCAL_MASTER_KEY` | `EXP kms/key-file-risk(before)` |
| 3 | 启用 KMS（接入应用） | 脚本 | `scripts/module enable kms --apply-to fields`：部署 CMK 与别名 → 附加策略 → 重启 → `migrate-module kms up` 把 `local-v1` 重新加密为 `kms-<KeyId>`（`/lab` 显示进度） | `CAP`：`kms` 的 `driver=kms`、`healthy`（`pendingIf`：重新加密进度未到 100% 时记为等待）；`HTTP`（`from: lab`，`target: self`，`/api/lab/probe/kms`，本机探测令牌）：路径头为 `kms=kms:cache-hit` 或 `kms=kms:call`；`AWS`：`kms:DescribeKey`（`KeyId: {{ stack.kms.InfoKeyArn }}`，`ownership: session`；第 3 轮由写死的 `alias/cloudalbum` 改为栈输出——平台模式下别名是 `alias/cloudalbum-{{ session.env }}`）——`KeyState=Enabled`、`KeyManager=CUSTOMER`；`AWS`：`kms:GetKeyRotationStatus`（`KeyId: {{ stack.kms.InfoKeyArn }}`，与 04 §5.7 一致：这个 API 只接受密钥 ID 或密钥 ARN，**不接受别名**，已按官方 API 参考核实）——`KeyRotationEnabled=true` |
| 4 | after：密文与审计 | 对比实验 + CLI | `ciphertext-view(after)`：看到 `ca1.kms-<KeyId>.*`；用 `cloudtrail.ts` 按事件源 `kms.amazonaws.com` 查看 `GenerateDataKey`、`Decrypt` 与加密上下文 | `EXP kms/ciphertext-view(after)`：与 before 成对有效；`MAN`：填写加密上下文中的 `purpose`（`表.列`） |
| 5 | 数据密钥缓存 | 对比实验 | `field-read`：分别带与不带 `X-Compare-Bypass: kms` 读取照片详情，比较 `Server-Timing` 的 `kms;dur` 与 CloudTrail 中的调用次数 | `EXP kms/field-read(after)` |
| 6 | 禁用演示 | 对比实验 | `disable-demo`：学员身份执行 `aws kms disable-key --key-id <密钥 ARN 或密钥 ID>`（`DisableKey`/`EnableKey` 不接受别名，脚本先用 `describe-key --key-id alias/cloudalbum-{{ session.env }}` 解析（平台模式下的别名，06 PM-M13）；权限来自密钥策略的根主体语句 + 学员的 IAM 策略，不需要把学员放进 `KeyAdminArns`，附录 B-14）→ 绕过缓存的读取先失败、普通读取在数据密钥缓存过期后（不超过 `KMS_DATA_KEY_CACHE_SEC`，默认 300 秒）返回 503 `CRYPTO_UNAVAILABLE` → `enable-key` 后恢复。禁用期间 kms 是权威端口，`/api/health/ready` 返回 503，属预期 | `EXP kms/disable-demo(after)`；`AWS`：`kms:DescribeKey`——最终 `KeyState=Enabled`（`drift: must-hold`）；`CAP`：`kms` 恢复为 `healthy` |
| 7 | （选做）数据卷换成 CMK 加密 | 脚本 | `scripts/module enable kms --apply-to fields,ebs`（初稿写的 `--ebs` 不是模块定义的参数）：只读窗口 → 数据卷快照 → `copy-snapshot --kms-key-id` → 在同一 AZ 用加密快照建卷 → 分阶段替换实例并经 `DataVolumeId` 改挂（00-ec2-base §8；实例 ID 改变，有分钟级停机，本步声明 `expectedOutage`：`lab`，最长 20 分钟）→ 指纹校验 | `AWS`：`ec2:DescribeVolumes`——当前数据卷的 `KmsKeyId` 为本 CMK；`CAP`（`view: admin`）：`ec2.checks` 中 `key-fingerprint=ok` |

### 对比实验

引用 `experiments/kms/`（02#kms §5）。local 与 kms 两档是切换前后测量；数据密钥缓存可以用 `X-Compare-Bypass: kms` 做运行时对比。

| 观察点 | 没有 KMS CMK（本地主密钥信封加密） | 有 KMS CMK |
|---|---|---|
| 主密钥在哪里 | 数据卷上的 `secrets.env`，可以连同快照一起被拷走 | 不离开 KMS，不可导出 |
| 审计 | 无 | CloudTrail 记录每次 `GenerateDataKey`、`Decrypt`（含调用者与加密上下文） |
| 撤销 | 只能换主密钥并重新加密全部数据 | 禁用密钥：各级缓存过期后读取失败；重新启用即恢复 |
| 性能 | 本地运算，微秒级 | 缓存命中时与本地相同；未命中多一次 KMS 调用（毫秒到几十毫秒量级） |
| EBS（选做） | `aws/ebs` 托管密钥：看不到也改不了策略，快照不能跨账号共享 | CMK：可控的密钥策略、轮换、跨账号共享 |
| 费用 | 无 | 每把 CMK 按月 + 按请求 |

### 小测

1. **（单选）** 需要审计每一次解密，能够“一键撤销”对数据的访问，并且自己控制谁能使用密钥。应选择：
   A. KMS 客户托管密钥　B. AWS 托管密钥 `aws/ebs`　C. SSE-S3　D. 应用自己保管的本地主密钥
   **答案：A**。解析：客户托管密钥可以自定义密钥策略、启用/禁用、开启自动轮换，调用记录在 CloudTrail 中；AWS 托管密钥的策略不能修改。
2. **（单选）** 大量小对象使用 SSE-KMS，KMS 请求费用高并开始出现限流。最直接的改进是：
   A. 为桶启用 S3 Bucket Key　B. 改用 SSE-C　C. 关闭加密　D. 再创建多把 KMS 密钥轮流使用
   **答案：A**。解析：Bucket Key 让 S3 在一段时间内复用桶级数据密钥，可以把 KMS 调用量降低一个数量级以上；只对之后写入的对象生效。
3. **（多选，选 2 项）** 一个已经在运行的未加密 RDS 实例需要改为使用客户托管密钥加密。下列说法正确的是：
   A. 先创建快照，用 CMK 复制快照，再从加密的副本恢复新实例　B. 可以直接修改实例开启加密　C. RDS 的存储加密只能在创建实例时决定　D. 开启密钥自动轮换会改变密钥 ID，需要更新所有引用
   **答案：A、C**。解析：自动轮换只更换后台的密钥材料，密钥 ID 不变，旧密文仍可解密。

### 清理说明

- 禁用演示后**必须重新启用**密钥，否则最终复核时 kms 为 `error`，卡片无法完成。
- CMK 不能立即删除，只能计划删除（有等待期）：回收器会计划删除并删除别名；不要用这把密钥加密任何会话之外的数据。
- 选做 `--ebs` 后，旧数据卷（未用 CMK 加密、含 `secrets.env`）与它的快照仍然存在，由回收器删除。

### 对应 SAA 考点

AWS 托管密钥、客户托管密钥、AWS 自有密钥；信封加密、数据密钥与加密上下文；密钥策略与 IAM 策略、根主体语句、`kms:ViaService`；SSE-S3、SSE-KMS、DSSE-KMS、SSE-C；S3 Bucket Key；RDS 与 EBS 只能在创建时加密、存量靠快照复制；共享加密快照需要 CMK；CloudFront 通过 OAC 读取 SSE-KMS 对象；自动密钥轮换不改变密钥 ID；禁用与计划删除；KMS 请求配额；多区域密钥。

---

## 附录 A：svc-ec2 的完整 lab.yaml

### A.1 格式依据（第 2 轮）

第 1 轮在这里自拟了一张“相对 04 的 v2 增改字段”表。按裁决 C2，04 已把 `lab.yaml` 升级为以卡片为单位的 `atl.lab/v2`（04 §3，字段名以 04 为准），本附录改为按 04 书写，原表作废。第 1 轮写法与 04 v2 的对照：

| 第 1 轮写法 | 04 v2 写法 |
|---|---|
| `modules: [{ id, role }]` | `modules: { target[], start[], context[], related[] }`（`start`、`context` 由构建期推导核对） |
| `startProfile.profile` / `extends` + `add` + `drivers` | 删除；起始状态由 `scripts/module plan --start-of <卡片 id>` 推导，档位名 `atl/<卡片 id>/<variant>`（默认 `default`，C3、01 §3.9）；`provisions[]` 逐项列出并与 plan 输出核对 |
| `startProfile.provisions[].{item, kind: module \| platform, driver, rule, reason}` | `{item, kind: module \| local \| runtime \| seed \| platform, basis?, set?, params?, value?, rule?, reason}`；`basis: credential \| closure \| precursor \| context` |
| 能力检查“预期警告集合”逐项手写 | 卡片级 `expectedWarnings` + 断言 `op: healthy`（检查级 `expectedWarnings` 只能取子集） |
| 实验标签只有 before/after，另记 `variant` | `experiments[].labels` 声明任意变体 `{id, role: baseline \| treatment \| single}`，`pairs`、`requiredLabels`；一次性实验用 `role: single`，可配 `validity: functional` + `corroborateWith`（C5） |
| `allowSimulatedBefore` | `allowSimulatedBaseline` |
| `quiz: { passScore, requiredForBadge, … }` | `quiz: { file, draw }`；小测不影响完成与徽章（C3） |
| `badge: { id, title, icon, requires }` | `badge: { title, short?, icon? }`：完成即授予 |
| `finalChecks: [{ ref: lab-no-world-ssh }]` | `finalChecks: [no-world-ssh, …]` |
| （无） | 新增必填 `tracks`；步骤 `expectedOutage`；`platform.consoleLinks` |

### A.2 `labs/svc-ec2/lab.yaml`

```yaml
schema: atl.lab/v2
id: svc-ec2
kind: service
version: 2.0.0                                # 第 2 轮：实验标签与“正常”判定的语义变化 → 主版本 +1（04 §8.10）
status: beta
service: Amazon EC2
function: 运行整个应用
title: Amazon EC2：运行整个应用
subtitle: 只有一台 EC2 的 CloudAlbum（L0 基线）
summary: 只有一台 EC2 时 CloudAlbum 的全部功能就能运行。认识实例、独立数据卷、弹性 IP 与 IMDSv2，亲手体会“实例可替换”与“单点故障”。
story: |
  你的相册目前只跑在一台 EC2 上：网页、接口、数据库文件和照片都在这台机器里。
  它能用，而且换实例时数据和密钥不会丢——但只要停掉它，整个网站就打不开了。
objectives:
  - { text: 说清根卷与独立 EBS 数据卷的生命周期差别, domain: resilient, relatesTo: host-inspect }
  - { text: 用 IMDSv2 的会话令牌解释 SSRF 为何读不到凭证, domain: secure, relatesTo: imds }
  - { text: 区分平台管理通道的角色与应用自己的 AWS 身份, domain: secure, relatesTo: orient }
  - { text: 亲测单点：停机即中断，EIP 让地址保持不变, domain: resilient, relatesTo: spof }
  - { text: 知道公网 IPv4（含 EIP）与 EBS 的计费方式, domain: cost, relatesTo: orient }
difficulty: intro
estimatedMinutes: 60
timeLimitMinutes: 90
extensions: { maxCount: 2, minutesEach: 30 }
retain: { allowed: true, maxHours: 24, reason: L0 成本低，保留后可直接接着做其他 svc 卡片 }
regions:
  supported: [ap-northeast-1]
  alsoUses: []
services:
  - { id: ec2, name: Amazon EC2, role: primary, module: ec2 }
  - { id: ebs, name: Amazon EBS, role: supporting, module: ec2 }
  - { id: session-manager, name: AWS Systems Manager Session Manager（平台管理通道）, role: observed }
modules: { target: [], start: [], context: [], related: [iam, network, load-balancer, autoscaling, backup] }
prerequisites:
  cards: []                                   # 入门卡，没有前置
  learnerInputs: []
  knowledge: [Linux 命令行基础, HTTP 请求与响应头]

startProfile:
  provisions:                                 # C3 例外：本卡不预置 iam，没有 kind: module 的条目
    - { item: mgmt-channel, kind: platform,
        reason: 实验机挂只含 AmazonSSMManagedInstanceCore 的 CloudAlbumAppRole，是平台的管理通道；应用仍是 IAM_CREDENTIALS=none }
    - { item: workstation, kind: platform, reason: 每个会话一台工作台，用于运行 AWS CLI 与对比实验 }
    - { item: check-bundle, kind: platform, reason: 检查包随 CloudAlbum 发布包安装在 /opt/atl（06） }
    - { item: preview-direct-https, kind: platform,
        reason: 方案 B 的 Let's Encrypt IP 证书，供预览面板嵌入（03 §6.2）；本卡不涉及证书，保持开启 }
  platform: { preview: { directHttps: 'on' } }
  reason: ec2 是基础模块，起始状态就是 L0（档位 atl/svc-ec2/default）；按 C3 的例外不预置 iam——本卡要展示“没有任何 AWS 模块”的基线
targetModules: []                             # ec2 不能启用或禁用；本卡没有 wire 步骤
expectedWarnings: []

workstation: { required: true, tools: [aws-cli, node, k6, jq], savingsMode: ok }
platform:
  consoleLinks: [ec2.instances, ec2.elasticIps]   # 03 的深链接注册表 id（以 03 为准）
provision: { class: A }                       # 起始状态只有 L0

variables:
  eip:
    label: 弹性 IP
    from: derived
    fillFrom: target.publicIp

cost:
  currency: USD
  tier: low
  mainDrivers: [EC2 按需实例小时, EBS gp3 根卷与数据卷, 公网 IPv4 小时, 重建演练的 EBS 快照]
  basis:
    - { ref: start-profile, note: 实验机 EC2、EBS（根卷与数据卷）、公网 IPv4 }
    - { ref: workstation, note: 工作台 EC2、EBS、公网 IPv4 }
    - { key: rebuild-snapshot, pricingKey: ebs.snapshot.storage, billing: monthly, quantity: 20, unit: GB-month,
        source: learner-created, whenRetained: true, note: 选做步骤 rebuild 产生一个数据卷快照（按实际占用计费，此处按卷大小上限估算） }
  assumptions:
    - 停止实例期间不收实例费用，EBS 与公网 IPv4 照常计费
    - 不写金额；报价接口按 Price List 单价给出区间（04 §3.4、02 的 CostQuote），以官方定价为准

steps:
  - id: orient
    type: console
    title: 认识实验机：卷、地址、元数据与实例角色
    manual: manual/10-orient.md
    methods: [console, cli]
    panel: console
    estMinutes: 8
    checks: [instance-shape, data-volume-shape, mgmt-role-understood]

  - id: tour
    type: observe
    title: 用一遍相册：看懂 X-CloudAlbum-Path
    manual: manual/20-tour.md
    panel: preview
    estMinutes: 10
    checks: [entry-direct, cap-ec2-healthy, cap-iam-none]

  - id: host-inspect
    type: cli
    title: 主机巡检：数据、机密与端口在哪里
    manual: manual/30-host-inspect.md
    panel: terminal-lab
    estMinutes: 8
    checks: [data-volume-mounted, secrets-on-data-volume, api-loopback-only]

  - id: imds
    type: cli
    title: IMDSv2：不带令牌的请求为什么被拒绝
    manual: manual/40-imds.md
    panel: terminal-lab
    estMinutes: 7
    checks:
      - imdsv2-enforced
      - { ref: exp-imds-probe, required: false }

  - id: smoke
    type: experiment
    title: 记录 L0 基线：冒烟测试
    manual: manual/50-smoke.md
    experiment: { module: ec2, id: smoke, label: l0 }
    estMinutes: 8
    checks: [exp-smoke]

  - id: spof
    type: experiment
    title: 单点故障演练：停止再启动实例
    manual: manual/60-spof.md
    experiment: { module: ec2, id: single-point-of-failure, label: l0 }
    requires: { steps: [smoke] }
    estMinutes: 12
    wait: { typicalMinutes: 3, maxMinutes: 10, text: 实例停止与启动各需要一到数分钟 }
    expectedOutage: { channel: lab, maxMinutes: 15, reason: 学员亲手停止实验机，停机期间实验机终端与本地检查不可用 }
    checks: [exp-spof, ssm-agent-restarted, eip-unchanged, { ref: cap-ec2-healthy, as: cap-ec2-healthy-after-spof }]
    pitfalls:
      - { id: forgot-start, symptom: 预期中断窗口结束后实验机终端与检测仍然超时, match: 'ec2 status unavailable', cause: 停止实例后没有再启动, fix: 在 EC2 控制台启动实验机 }

  - id: rebuild
    type: script
    title: （选做）重建实例：实例 ID 变了，密钥指纹没变
    manual: manual/70-rebuild.md
    optional: { reason: 需要约 10 分钟的停机窗口；不影响完成 }
    experiment: { module: ec2, id: rebuild-drill, label: rebuild }
    requires: { steps: [spof] }
    estMinutes: 15
    wait: { typicalMinutes: 8, maxMinutes: 20, text: 只读窗口、快照、换实例、改挂数据卷 }
    expectedOutage: { channel: lab, maxMinutes: 20, reason: 实例替换期间旧实例已停止、新实例尚未就绪 }
    startsBilling: { class: usage, pricingKeys: [ebs.snapshot.storage], note: 演练前会对数据卷做一次快照 }
    checks: [exp-rebuild, fingerprint-kept]

finalChecks:
  - no-world-ssh                              # labs/_shared/checks：安全组没有对 0.0.0.0/0 开放 22
  - { ref: cap-ec2-healthy, as: final-ec2-healthy }

experiments:
  # 一次性实验：只有 role: single 的变体，完成条件是“该变体有一条有效结果”，不要求成对（04 §3.2.10）
  - module: ec2
    id: smoke
    labels: [ { id: l0, role: single } ]
    required: true
    runner: workstation
    validity: functional                      # 冒烟用例以功能断言为主，用检查佐证
    corroborateWith: [cap-ec2-healthy, data-volume-mounted]
  - module: ec2
    id: single-point-of-failure
    labels: [ { id: l0, role: single } ]
    required: true
    runner: workstation
    validity: functional                      # 停机期间实例上的指标采集也停了，按 runId 的服务端计数没有意义
    corroborateWith: [ssm-agent-restarted, eip-unchanged]
  - { module: ec2, id: imds-probe, labels: [ { id: l0, role: single } ], required: false, runner: workstation,
      validity: functional, corroborateWith: [imdsv2-enforced] }
  - { module: ec2, id: rebuild-drill, labels: [ { id: rebuild, role: single } ], required: false, runner: workstation,
      validity: functional, corroborateWith: [fingerprint-kept] }
  - { module: ec2, id: cpu-credits, labels: [ { id: standard, role: single } ], required: false, runner: workstation }

quiz: { file: quiz.yaml, draw: 3 }            # 成绩只记录在徽章上，不影响完成（C3）
badge: { title: EC2 基线, icon: assets/badge.svg }
tracks: [saa-main, resilient, cost-optimized, quick-compare]   # 以 _tracks/ 的实际包含关系为准（tracks-and-catalog §4），labs:fix 自动改写

cleanup:
  summary: 结束实验后平台删除基础栈与工作台。停止过实例的话请先确认它已重新启动；选做的重建演练会留下含机密的快照，由平台删除，不要复制或共享。
  autoReclaim: true
  dataRisk:
    - 数据卷设置了 DeletionPolicy=Retain，栈删除后作为 RETAINED 资源进入台账，由回收器删除（02）
    - 快照包含 secrets.env 与私钥，随会话删除
  learnerCreatedHints:
    - { resourceType: 'AWS::EC2::Snapshot', how: 由 rebuild-instance 创建并记入 state.json 的带外段，回收器按台账删除 }
    - { resourceType: 'AWS::EC2::Volume', how: 重建演练后不再挂载的卷（如有）按 CloudTrail 创建事件或派生规则认领后删除 }
  verify:
    - { ref: base-stack-gone }
    - { ref: no-session-volumes }

saa:
  domains: [resilient, secure, cost]
  topics:
    - { id: ebs-lifecycle, title: EBS 卷与实例生命周期、DeleteOnTermination、绑定 AZ, domain: resilient, relatesTo: host-inspect }
    - { id: instance-store, title: 实例存储与 EBS 的持久性差异, domain: resilient, relatesTo: host-inspect }
    - { id: imdsv2, title: IMDSv2 会话令牌、跳数与 SSRF, domain: secure, relatesTo: imds }
    - { id: eip-billing, title: 弹性 IP 与公网 IPv4 计费, domain: cost, relatesTo: orient }
    - { id: cpu-credits, title: T 系列 CPU 积分 standard 与 unlimited, domain: cost }
    - { id: spof, title: 高可用与“有备份”的区别, domain: resilient, relatesTo: spof }
  confusables:
    - { a: 实例存储, b: EBS, rule: 实例存储随实例停止或终止丢失，只放缓存与临时文件 }
    - { a: 自动分配的公网 IPv4, b: 弹性 IP, rule: 前者停止再启动会变，后者固定；两者都按小时计费 }

tags: [ec2, ebs, eip, imds, baseline]

permissions:
  learner:
    - ec2:StopInstances                       # 学员边界放行 ec2:*；工作台与平台实例带 atl:component=workstation|platform，受边界保护
    - ec2:StartInstances                      # 受实例规格护栏约束（t4g.small 在白名单内）
    - ec2:ModifyInstanceMetadataOptions       # 选做：跳数临时改为 2 再改回
    - ec2:CreateSnapshot                      # 选做：rebuild-instance 的快照
    - ec2:CreateTags
    - ssm:SendCommand                         # 冒烟测试的主机检查、rebuild-instance 的 predetach/postattach 经 Run Command 投递
    - cloudformation:CreateChangeSet          # 选做：rebuild-instance 分阶段更新基础栈（未指定服务角色时 CloudFormation 以调用者身份执行，下列 EC2/IAM 动作都要学员身份具备）
    - cloudformation:DescribeChangeSet
    - cloudformation:ExecuteChangeSet
    - cloudformation:DescribeStacks
    - cloudformation:DescribeStackEvents
    - ec2:RunInstances                        # 选做：换槽位新建实例
    - ec2:TerminateInstances                  # 选做：删除旧槽位实例
    - ec2:AttachVolume                        # 选做：改挂数据卷
    - ec2:DetachVolume
    - ec2:AssociateAddress                    # 选做：EIP 关联到新实例
    - iam:PassRole                            # 选做：新实例挂 CloudAlbumAppRole（学员边界只允许传递 CloudAlbum* 角色）
  notes: 停止实例与重建期间由 expectedOutage 把 CHANNEL_DOWN 显示为“预期中断”；02 的 watchdog 只对“已终止”的实验机报警，并按 atl:env-id + atl:role 重新发现实例（附录 B-13）。scripts/module 在平台模式下给栈打 atl:component=env、atl:session-id、atl:lab-id、atl:env-id 标签（C4(d)），状态在 cloudalbum-lab-state 桶与 cloudalbum-lab-locks 表中（C4(c)）

certificate: { enabled: false }               # 证书由学习路径颁发
owners: [cloudalbum-maintainers]
```

### A.3 本卡专属检查（节选：`labs/svc-ec2/checks/*.yaml`）

```yaml
checks:
  - id: instance-shape
    title: 实验机强制 IMDSv2、跳数 1、挂两块卷，实例配置文件只用于平台管理
    type: aws-readonly
    service: ec2
    action: DescribeInstances
    region: app
    params: { InstanceIds: ['{{ target.instanceId }}'] }
    ownership: { resource: 'arn:aws:ec2:{{ session.region }}:{{ session.accountId }}:instance/{{ target.instanceId }}', mode: session-or-start }
    drift: { policy: once }
    assert:
      - { path: '$.Reservations[0].Instances[0].MetadataOptions.HttpTokens', op: eq, value: required, label: IMDSv2 必需 }
      - { path: '$.Reservations[0].Instances[0].MetadataOptions.HttpPutResponseHopLimit', op: eq, value: 1, label: 跳数 }
      - { path: '$.Reservations[0].Instances[0].BlockDeviceMappings', op: len_eq, value: 2, label: 根卷 + 数据卷 }
      - { path: '$.Reservations[0].Instances[0].IamInstanceProfile.Arn', op: endsWith, value: '/CloudAlbumAppRole', label: 实例配置文件 }
    explain: 读取实验机的元数据选项、挂载的卷与实例配置文件。
    reproduce: { run: 'aws ec2 describe-instances --instance-ids {{ target.instanceId }} --query "Reservations[0].Instances[0].MetadataOptions"', runsOn: workstation }
    manualFallback:
      where: { breadcrumb: [EC2, 实例, '{{ target.instanceId }}', 安全, 修改实例元数据选项] }
      observed:
        question: “IMDSv2”一项显示什么？
        options:
          - { value: required, label: 必需, expected: true }
          - { value: optional, label: 可选, fixHint: 实验机被改过，回到 IMDS 步骤的说明 }

  - id: cap-ec2-healthy                       # 第 2 轮：“正常”统一用 op: healthy（04 §5.3）
    title: ec2 模块正常（只允许本卡声明的预期警告，本卡为空）
    type: capability
    module: ec2
    drift: { policy: must-hold }
    assert:
      - { path: $.driver, op: eq, value: single, label: 驱动 }
      - { path: $, op: healthy, label: 状态正常 }
    explain: status=ok，或 degraded 且导致降级的规则全部属于卡片的 expectedWarnings；本卡 expectedWarnings 为空，所以必须是 ok。

  - id: cap-iam-none
    title: 应用没有使用任何 AWS 凭证
    type: capability
    module: iam
    drift: { policy: must-hold }
    assert:
      - { path: $.driver, op: eq, value: none }
      - { path: $.status, op: eq, value: 'off' }
    explain: 实例挂着平台管理角色，但应用的 IAM_CREDENTIALS=none，从不读取它。

  - id: imdsv2-enforced
    title: 不带令牌访问 IMDS 返回 401
    type: local
    on: lab
    checkId: imds-get
    args: { path: instance-id, checkV1Rejected: true }
    drift: { policy: must-hold }
    assert:
      - { path: $.v1Status, op: eq, value: 401, label: 不带令牌的状态码 }
    reproduce: { run: "curl -s -o /dev/null -w '%{http_code}\\n' http://169.254.169.254/latest/meta-data/", runsOn: lab }

  - id: eip-unchanged
    title: 停止再启动后，实验机仍关联同一个弹性 IP
    type: aws-readonly
    service: ec2
    action: DescribeAddresses
    region: app
    params: { Filters: [ { Name: 'tag:atl:env-id', Values: ['{{ session.envId }}'] } ] }   # 第 2 轮：按环境标签发现（复用环境后仍可用）；EIP 是基础栈资源，栈标签已带 atl:env-id
    dependsOn: [exp-spof]
    drift: { policy: must-hold }
    assert:
      - path: $.Addresses
        where: { PublicIp: '{{ target.publicIp }}', InstanceId: '{{ target.instanceId }}' }
        op: len_eq
        value: 1
        label: EIP 关联在实验机上
    reproduce: { run: 'aws ec2 describe-addresses --filters Name=tag:atl:env-id,Values={{ session.envId }} --query "Addresses[].[PublicIp,InstanceId]"', runsOn: workstation }   # 04 lint：aws-readonly 必须有 reproduce
    manualFallback:
      where: { breadcrumb: [EC2, 弹性 IP] }
      observed:
        question: 你的弹性 IP 关联的实例 ID 是否就是实验机？
        options:
          - { value: yes, label: 是, expected: true }
          - { value: no, label: 否或未关联, fixHint: 实例可能还没启动完成 }

  - id: ssm-agent-restarted                   # 审稿补：服务端佐证“确实停过机”
    title: 单点故障演练期间实验机确实停止并重新启动过
    type: local
    on: lab
    checkId: systemd-unit
    args: { unit: amazon-ssm-agent }
    dependsOn: [exp-spof]
    drift: { policy: once }
    assert:
      - { path: $.active, op: eq, value: active, label: SSM Agent 运行中 }
      - { path: $.since, op: gt, value: '{{$check.exp-spof.startedAt}}', label: 启动时间晚于演练开始 }   # 04 §4.4 没有 step.* 命名空间，取依赖检查的证据时间
    explain: 停机期间实例上的指标采集也停了，实验结果的交叉校验看不到这段时间；用 SSM Agent 的启动时间佐证实例重启过。
    reproduce: { run: 'systemctl show -p ActiveEnterTimestamp amazon-ssm-agent', runsOn: lab }

  - id: fingerprint-kept
    title: 重建实例后主密钥指纹不变、数据卷正常挂载
    type: capability
    module: ec2
    view: admin
    dependsOn: [exp-rebuild]
    drift: { policy: once }
    assert:
      - { path: $.checks, where: { id: key-fingerprint, status: ok }, op: len_eq, value: 1, label: 密钥指纹 }
      - { path: $.checks, where: { id: data-volume, status: ok }, op: len_eq, value: 1, label: 数据卷 }
```

`data-volume-shape`、`mgmt-role-understood`（manual）、`entry-direct`、`data-volume-mounted`（capability，`view: admin`，断言 `ec2.checks` 中 `data-volume=ok`，见第 2 节第 3 步的审稿修订）、`secrets-on-data-volume`、`api-loopback-only`、`exp-*`、`base-stack-gone`、`no-session-volumes` 按第 2 节步骤表的判定要点书写，此处从略；全部 `aws-readonly` 检查都要带 `manualFallback` 与 `reproduce`（04 lint）；`no-world-ssh` 来自 `labs/_shared/checks/`；`exp-smoke`、`exp-spof` 写 `label: l0`，`exp-rebuild` 写 `label: rebuild`。小测 `quiz.yaml` 收录第 2 节的 3 道题（`draw: 3`）。

---

## 附录 B：发现的现有设计问题与回写建议

第 2 轮在每条“问题”开头标注处理状态：“已由 C# 解决”表示被主设计者本轮裁决（C1～C5）解决，正文已按裁决改写；“部分解决”“未解决”的剩余事项见各条与文末修订记录。B-22～B-24 为第 2 轮新增。

| # | 问题 | 涉及卡片 | 影响 | 建议（回写到） |
|---|---|---|---|---|
| B-1 | **已由 C3 解决**：起始状态由 `scripts/module plan --start-of <卡片 id>` 推导，档位名 `atl/<卡片 id>`（04 §3.2.3）。原问题：`single/<id>` 档位包含目标模块本身（§10.4：L0 + 该模块 + 依赖），不能直接作为卡片的 startProfile；04 的 `profileName` 也不接受新档位名 | 全部 | 卡片只能用写法 B（`extends` + `add`）逐张手写闭包 | 新增 `scripts/module profile gen-card <id>`，生成 `card/<id>.env` = `single/<id>` 去掉目标模块；`profileName` 增加 `card/`（总纲 §10.4、04 §3.3） |
| B-2 | **已由 C2 解决**：04 v2 用 `targetModules[].fromDriver` 与“目标必须真的改变什么”（DRV-5）取代 lint 第 4 条；而且第 2 轮 svc-network 已改为 public 目标，本批不再有前驱取值。原问题：04 §3.5 lint 第 4 条“目标模块不得出现在起始状态中”与 `svc-network` 冲突：private 的入口 ALB 是 VPC 绑定模块，必须先在自定义 VPC 中以 public 放置部署 network | network | 卡片无法通过 lint | 05 §4.1 S4（§7.4 C-5）已提出同样的细化（Lab 20 起始为 `network=public`），但 04 §3.5 尚未回写；建议回写时用 `targetModules[].fromDriver` 显式声明（04 §3.5） |
| B-3 | **已由 C2 解决**：04 v2 放宽 `id`、`title`（≤ 48 字）并采用四级难度。原问题：04 的 `id` 模式只允许 `lab-NN`；`title` ≤ 24 字放不下“服务：机能”（如“AWS Systems Manager Parameter Store：运行时配置”）；`difficulty` 只有三级 | 全部 | 卡片无法通过 schema | 见附录 A.1（04 §3.3） |
| B-4 | **已由 C3 解决**：除 `svc-ec2`、`svc-iam` 外一律预置 iam(role)，6 张 A 组卡片已改写，不再出现 CRED-004。原问题：`credentials: optional` 的模块在严格闭包下没有 iam，状态恒为 `degraded`（CRED-004）；04 §11 的 Lab 5 示例与 05 §4.1 S2 却都为此加入 iam，与“L0 + 硬依赖闭包”的卡片定义、总纲 §10.4 规则 2 冲突 | network、cdn、dns、tls、waf、load-balancer | 同一模块在不同内容里起始状态不同，`cap-ok` 检查口径不一；学员看到黄色状态 | 需主设计者拍板二选一：① 卡片不并入 iam，capability 检查接受“预期警告集合内的 degraded”（本文 §1.1 规则 3，当前写法；审稿后已不限于 CRED-004，见 B-19）；② 采纳 S2，把它定义为卡片的“可选凭证前置”（iam 免费、几分钟完成），6 张 A 组卡片统一 `add: [iam]`，CAP 检查改为 `status=ok`，其余内容不变（04 §11、05 §4.1、总纲 §10.4） |
| B-5 | **部分已由 C5 解决**：autoscaling、tls 卡片关闭方案 B（`startProfile.platform.preview.directHttps`）。剩余：方案 B 下 `APP_BASE_URL` 与 `https.trusted` 的取值由 06 定义；Cognito 是否接受 IP 主机名的回调地址列入 07 验证。原问题：平台默认方案 B（Let's Encrypt IP 证书）与 ASG-014 冲突；与 tls 的“从自签名讲起”冲突；DEP-029/DEP-030 依据的是 `APP_BASE_URL`，而方案 B 是否把基础配置的 `APP_BASE_URL` 改成 https 没有定义 | autoscaling、tls、auth、identity-pool | autoscaling 起始状态会被 ASG-014 拒绝（退出码 78）——05 的 lab-21 平台段写的是“预览 on（经 ALB 入口）”，同样会命中；identity-pool 可能停在 `degraded` | 方案 B 改为 startProfile 可声明的平台选项（`startProfile.platform.preview.directHttps`），默认开，autoscaling 与 tls 关闭；明确方案 B 下 `APP_BASE_URL` 与 `https.trusted` 的取值；Cognito 是否接受 IP 主机名的回调地址需实测（03 §6.2、总纲 DEP-029/030） |
| B-6 | **移交 `sc-private-network`**（第 2 轮 svc-network 改为 public 目标后，本批不再涉及 private 放置与 `endpoint-only`）；终端节点取值的统一仍未解决。原问题：DEP-009 的运维通道只认 `shell-access` 或 EIC Endpoint，不认平台模式下始终存在的 SSM 管理通道；network 的 `endpoint-only` 实验删除 NAT 路由会切断平台管理通道 | network | 卡片必须额外开 EIC Endpoint；选做实验会让检测与终端失效 | 平台模式下把“SSM 管理通道可达（NAT 或 ssm/ssmmessages 端点）”计为运维通道；`endpoint-only` 在平台模式下要求接口终端节点覆盖 `ssm`、`ssmmessages`（01 §9.8 建议另加 `ec2messages`）。注意三处写法不一致：01#network 的 `InterfaceEndpoints` 只有 `none\|ops\|all`，`ops` 不含 `ec2messages`；05 的 lab-20 写的是模块中不存在的 `--endpoints ssm`；本卡沿用 `ops`。需在 01#network 增加 `ec2messages` 或 `ssm` 取值后统一（总纲 DEP-009、01 §9.8、05 lab-20） |
| B-7 | **已由 C2 解决**：04 v2 的平台动作字段 `interruptsManagementChannel` 与步骤字段 `expectedOutage` 把窗口内的 `CHANNEL_DOWN` 显示为预期中断；02 需识别该窗口（04 §12.4）。原问题：iam 的撤销会话实验会同时切断平台管理通道（SSM Agent 用同一个角色的旧会话）。审稿更正：初稿说“01 D-2 禁止学员修改 `CloudAlbumAppRole`”不准确——护栏 `ProtectAppRole` 只拒绝删除角色、改信任策略、改标签、改实例配置文件，`KeepPlatformChannel` 只拒绝分离 SSM 核心策略，学员仍可 `PutRolePolicy`（撤销会话就是写一条内联策略）。走平台动作的真正理由是“撤销与恢复必须成对、恢复要换实例会话” | iam | 期间实验机终端与本地检查返回 `CHANNEL_DOWN` | 05 的 lab-01 已定义平台动作 `iam-revoke-sessions`、`iam-refresh-credentials`（含 `replace-iam-instance-profile-association`），本卡直接沿用；仍需 02 增加“预期管理通道中断窗口”，在窗口内把 `CHANNEL_DOWN` 显示为预期而不是故障（02、04 §5.6） |
| B-8 | **风险①已由 C1 大幅缩小**：secret 名称带每环境不同的 `envName`，新环境不会与上一环境撞名，只剩同一环境内 disable 后立即 enable 的情形；风险②（CloudTrail 投递延迟）由 02 的复扫与定向扫描覆盖。原问题：（审稿降级：初稿称为“回收缺口”，核对后大部分已由 02 覆盖）多个模块的资源默认保留或不归栈管理：ec2 数据卷 `Retain`、auth User Pool `Retain` + 删除保护、secrets 名称固定且删除有恢复窗口、config 参数由迁移脚本创建、waf 日志组在 us-east-1、dns 新建的托管区域、autoscaling 的 SecureString 引导配置包、KMS 只能计划删除、Flow Logs 日志组。02 的做法：`env destroy` 把 `Retain` 资源记为 `RETAINED`、把 state.json 带外资源写入台账（§6.5）；派生规则覆盖数据卷（§7.4）；CloudTrail 扫描覆盖学员与实例会话创建的参数、记录，扫描区域含 us-east-1（§7.1、§7.3）；§7.5 S2 已写明 User Pool 先关删除保护、Secrets Manager 立即删除不留恢复窗口，S5 计划删除 KMS 密钥。平台模式不使用 `scripts/teardown --purge-data` | ec2、auth、identity-pool、secrets、config、waf、dns、autoscaling、kms、network | 剩余风险只有两点：① Secrets Manager 的强制删除在后台异步完成，紧接着开始的下一次会话可能短暂建不出同名 secret；② 依赖 CloudTrail 认领的资源（config 参数、学员手工建的记录）受投递延迟影响，要靠 §7.7 的复扫 | ① `scripts/module enable secrets` 遇到“同名 secret 正在删除”时短暂重试，或 02 在会话结束后对同名 secret 做一次存在性确认再释放环境锁（02 §7、02-identity-security#secrets）；② 无需新增设计 |
| B-9 | **已被采纳**：04 §11 的 svc-cdn 示例以 `media-load` 为必需实验，`ttfb` 选做。原问题：cdn 的 `ttfb`、tls 的 `handshake` 依赖四个区域的 CloudShell；平台工作台只在东京，学员边界也可能限制其他区域 | cdn、tls | 04 §11 Lab 5 示例把 `ttfb` 设为必需实验，从东京测差别很小，信号弱 | 卡片改用 `media-load`/`origin-requests` 作为 cdn 的必需实验；多区域实验设为选做，或由平台提供多区域探测 Lambda（04 §11、03） |
| B-10 | **标签部分已由 C5 解决**：`--label` 接受任意变体，结果标注 `variant`，一次性实验用 `role: single`（04 §3.2.10）。剩余：实验脚本的卡片用短轮次参数（waf `flood`、autoscaling `scale-out`）仍需写进 `experiment.json`（总纲 §8.2）；运行器参数形式（`--scenario <id>` 还是位置参数）以 06 为准。原问题：04 的实验标签只有 before/after，而模块文档使用 `l0`、`unsafe`、配置 a/b/c/d、`selfhost` 等标签；部分场景时长不适合卡片（waf `flood` 每条路径 10 分钟，before/after × direct/edge 约 40 分钟；autoscaling `scale-out` 10 分钟） | ec2、load-balancer、autoscaling、waf | 变体无处记录；卡片超时 | 增加 `variant` 字段（附录 A.1）；实验脚本提供卡片用的短轮次参数并写入 `experiment.json`（总纲 §8.2）。另：04 §3.2.9 把“必需实验”定义为“一对有效的 before/after”，而 svc-ec2 的 `smoke`、`single-point-of-failure` 是一次性实验，只有一个标签；05 §7.4 F-7 提议的标签 `run` 与本文 A.1 的“每个声明标签各一条有效结果”二选一回写 04（04 §3.2.9、§7） |
| B-11 | **已由 C5 解决**：测试数据由 06 的种子登记表提供（`cognito-test-users`、`gps-sample-photos`），卡片以 `startProfile.provisions` 的 `kind: seed` 声明。Cognito 阶段的执行身份已定（第 3 轮）：工作台以学员身份执行钩子 `cognito-passwords`（06 PM-36、PM-44；03 §4.6 接线时执行一次，学员身份 `enable auth` 时立即执行），运行器不获得 `cognito-idp:Admin*`（01 §6.7）。原问题：测试数据：auth 的 `login-storm(after)`、identity-pool 的越权测试需要已确认、密码已知的 Cognito 用户，但 auth 的应用策略没有 `AdminSetUserPassword`，`scripts/admin seed-users` 也未定义 Cognito 版本；kms 需要带 GPS EXIF 的示例照片 | auth、identity-pool、kms | 起始状态缺测试数据，实验做不了或只能人工准备 | 审稿修订：初稿建议“runner 以部署者身份执行种子步骤”，但 01 §6.7 第 6 层规定 runner 只能直接调用 CloudFormation、SSM 投递等少数操作，实验服务的写操作必须经 CloudFormation，`cognito-idp:AdminSetUserPassword` 不在白名单中。改为：本地测试账号由 runner 经 SSM 在实验机上 `scripts/admin seed-users`（不涉及 AWS）预置，随 auth 的 bulk 迁移进入 Cognito；设置已知密码由工作台上的准备脚本以学员身份执行（学员边界放行 `cognito-idp:*`），svc-auth 放在第 5 步、svc-identity-pool 放在第 1 步之前。若希望在起始状态里完成，则需把 `AdminSetUserPassword` 列入 01 §6.7 的 `OutOfBandFromRegistry` 白名单（限本会话 User Pool）。示例照片随内容包发布（04 §2.1 `assets/`） |
| B-12 | **已由 C1、C5 解决**（以 04、06 定稿为准）：`tls-domain` 目标已加入 04 §5.2.3；探测端点统一为 `/api/lab/probe/*`（含按模块的 `auth`、`identity-pool`、`kms`，`echo` 回显 `X-Amzn-Trace-Id`、`X-Forwarded-Proto`），由 06 规定；`ListAccessKeys` 的资源统一为 `user/cloudalbum/cloudalbum-*-demo-keys`（04 §5.7）；04 §5.2.4 把“本环境栈成员角色”（ACME 签发角色）认作创建证据；纯基础设施型模块可用 `module-state` + 带 `ownership` 的控制面证据作 wire 证据（04 §3.5 第 3 条）；`DescribeInstanceConnectEndpoints` 已进白名单。原问题：检测能力缺口：http-header 目标枚举没有“自定义域名直连”（tls 的 ACME 证书装在 Nginx 上）；dns、tls 这类不在请求路径上的纯基础设施模块很难满足 lint 第 3 条“wire 步骤必须有 http-header 或 local 路径检查”；auth、identity-pool、kms 的路径段只出现在已认证请求上，需要 CloudAlbum 提供 `/api/lab/probe/<module>` 探测端点；EC2 Instance Connect Endpoint 的查询 API 不在只读白名单中 | dns、tls、auth、identity-pool、kms、network | 卡片的 wire 检查无法自动判定 | 新增目标 `tls-domain`（由 `envfile.tls.TLS_DOMAIN` 解析，以 TLS 证书 SAN 佐证）；lint 第 3 条对 `type: infra` 模块允许 `LOCAL dns-resolve`/`tls-handshake` 代替；ui-design §9.2 已有 `/api/lab/probe/now`、`/probe/echo`、`/probe/media-url`，需按模块补 `/probe/auth`、`/probe/identity-pool`、`/probe/kms`，并让 `/probe/echo` 回显 `X-Amzn-Trace-Id`、`X-Forwarded-Proto`（svc-load-balancer 第 4 步）；白名单增加 `ec2:DescribeInstanceConnectEndpoints`（04 §5.2.3、§5.7、§3.5）。**审稿补充三处**：① 04 §5.7 把 `iam:ListAccessKeys` 的 Resource 限定为演示用户 `cloudalbum-app`，而 02#iam 的演示用户名是 `cloudalbum-<env>-demo-keys`（01 §9.6 还规定路径 `/cloudalbum/`），按现状 svc-iam 第 4 步的检查会被验证角色的策略拒绝（`ACCESS_DENIED`），需统一名称；② ACME 证书由 ACM 以签发角色的会话创建，CloudTrail 中的会话名不是 04 §5.2.4 认可的学员或运行器会话名，`ownership` 无法直接判定，需要允许“签发端点属于本会话 tls 栈”作为间接归属，或把签发角色会话加入台账的认领规则（02 §7.3 的 I4 已覆盖回收，但 04 的所有权校验没有）；③ `ownership` 针对单个资源 ARN，`List*` 类调用（如 `secretsmanager:ListSecrets`）不能直接带它，本文已改用 `Describe*` |
| B-13 | **部分已由 C2 解决**：停机与重建窗口用 `expectedOutage`；watchdog 与检测按 `atl:env-id` + `atl:role` 重新发现实例（平台评审统一取值）。剩余：冒烟用例 S02 的平台模式判定仍需回写 00-ec2-base §9.1。原问题：平台模式下 L0 冒烟测试 S02“实例没有实例配置文件”必然失败（05 的 lab-00 已把对应核对项改写为“实例配置文件只含 `AmazonSSMManagedInstanceCore`”，但 00-ec2-base §9.1 的脚本本身还没改）。ec2 的单点故障演练让 SSM 管理通道离线，期间检测返回 `CHANNEL_DOWN`；rebuild 演练改变实例 ID。审稿更正：02 §5.7 的 watchdog 只对“实验机或工作台已终止”报警，停止实例不会触发；rebuild 终止的是旧实例，只要 watchdog 遵守 01 §9.8 “不缓存实例 ID、按标签发现”就不会误报 | ec2 | 不改 S02 时 `exp-smoke` 无法通过；停机期间检测失败的提示文案像“平台故障” | S02 增加平台模式判定（00-ec2-base §9.1）；04 允许步骤声明 `expectedOutage`，窗口内把 `CHANNEL_DOWN` 显示为预期；02 的 watchdog 实现时明确按标签重新发现实验机 |
| B-14 | **检查侧已解决**：04 §5.7 规定 `GetKeyRotationStatus` 用 `stack.kms.InfoKeyArn`，本卡已照用。剩余：02#kms §5 的 `disable-demo.sh` 仍直接用别名，需回写模块文档。原问题：（审稿更正）初稿称 kms 的禁用演示要求学员是密钥管理员（`KeyAdminArns`）。核对 02#kms：密钥策略第 1 条“允许本账号根主体 `kms:*`”把授权委托给 IAM，学员的 `PowerUserAccess` + 边界 `kms:*` 已足够，不需要进 `KeyAdminArns`。真正的问题在别处：02#kms §5 的 `disable-demo.sh --key alias/cloudalbum` 与本卡初稿都直接用别名，而 `DisableKey`、`EnableKey`、`GetKeyRotationStatus` 只接受密钥 ID 或密钥 ARN（已按 KMS API 参考核实） | kms | 按别名调用会直接报错，禁用演示与轮换状态检查都做不成 | 实验脚本先 `describe-key --key-id alias/cloudalbum` 解析出 ARN 再调用；检查用 `stack.kms.InfoKeyArn` 或依赖检查返回的 `KeyMetadata.Arn`（02#kms §5、04 检查写法）。另：01 的学员边界目前对 `kms:*` 全放行，若以后收紧，需保留对带本会话标签密钥的 `DisableKey`/`EnableKey` |
| B-15 | **无需裁决**（说明性条目，处理方式已写在卡片中）。原问题：（审稿更正）dns 的 `ip-change-drill` 需要学员 `AllocateAddress`/`AssociateAddress`/`ReleaseAddress`：01 的学员边界放行 `ec2:*`，`PowerUserAccess` 也包含它们，初稿说“权限边界可能拒绝”不成立。实际影响是演练期间实验机的公网地址改变：方案 B 的 IP 证书与 `target.publicIp` 暂时失效，`from: platform` 的检查失败；EIP 也是基础栈的资源，演练脚本中途失败会留下栈与实际状态不一致 | dns | 演练期间点“检测”会得到误导性的失败；中途失败需要手工恢复 | 手册提示演练期间不要点“检测”；`ip-change-drill` 在 `finally` 中关联回原 EIP 并释放临时 EIP（01#dns §5 已要求）；不必改为平台动作 |
| B-16 | **发现规则已由 C1 解决**：04 §5.2.1 按 `atl:env-id` + `atl:role=lab-app` 发现，ASG 模式只取 `InService` 实例，停机保留的 L0 实例不会被选中。剩余：01#autoscaling 的启动模板仍需传播 `atl:env-id`、`atl:session-id`、`atl:lab-id`、`atl:role=lab-app`（平台评审回写第 17 条）。原问题：autoscaling 的 ASG 实例需要继承 `atl:session-id`、`atl:lab-id`、`Project` 标签（`PropagateAtLaunch`），否则 `instances: all` 的检查、SSM 投递与回收器都找不到它们；registry 未写明 | autoscaling | 检测与回收遗漏实例 | 03 §9.5 与 05 的 lab-21 已要求启动模板传播会话标签，但 01#autoscaling 的模板与 registry 还没有写；需回写（01#autoscaling、02）。审稿补充反方向的问题：启用 ASG 后停机保留的 L0 实例仍带 `atl:role=lab-app`，04 §5.2.1 的 `instances: all` 会把它算进去并以 `CHANNEL_DOWN` 失败，`instances: one` 也可能选中它。建议 `scripts/module` 在 L0 实例停机保留时把它的 `atl:role` 改为 `lab-app-standby`，或 04 规定发现时只取 `running` 且（ASG 模式下）`InService` 的实例 |
| B-17 | **已由 C2 解决**：05 改写为卡片目录，Lab 0～25 成为 `saa-main` 中的步骤，路径引用卡片 id。原问题：05-lab-catalog 仍按 Lab 0～25 编写；04 §8.7 的 Track 格式用 `labs:` 引用 `lab-NN` | 全部 | 目录、Track、报告都无法引用卡片 | 05 改写为卡片目录（§2.7 的难度、时长、费用档位规则可直接沿用，本文已采用）；Track 改为 `cards:`（或 `items:` 同时接受卡片与旧 Lab）（04 §8.7、05） |
| B-18 | **已由 C3 定论**：起始状态只含硬依赖闭包，单服务卡片不预置 network；环境复用按 02 的规则判定。原问题：05 §4.1 S5 让所有 VPC 绑定的 Lab 以 `network(public)` 起步；单服务卡片按“硬依赖闭包”不预置 network，所以 `svc-load-balancer`、`svc-autoscaling` 的 ALB、RDS 建在默认 VPC | load-balancer、autoscaling | 与对应的 Lab 19、Lab 21 起始状态不同；保留环境后若接着做 `svc-network`，迁入自定义 VPC 会触发 DEP-016 | 按 02 §8.4 判为“不能复用、释放后全新开始”即可；若希望卡片也遵守 SAA 推荐的分层子网，则把 S5 定义为卡片的“部署形态偏好”并在 startProfile 中显式写出，不计入硬依赖（05 §4.1、02 §8.4） |
| B-19 | **已由 C3 解决**：04 v2 的卡片级 `expectedWarnings` 与断言 `op: healthy`（04 §3.2.5、§5.3）。原问题：（审稿新增）总纲 §5.3 第 2 条：`warn` 级规则会把关联模块至少标为 `degraded`。本批有多条设计上预期的警告：DEP-013（auth + outbox）、SEC-002（ALB 不锁入口）、DEP-018（WAF 锁源站前）、DEP-030（identity-pool + http）、ASG-009～013（ASG 下的本地实现）、CRED-004。初稿多处要求 `status=ok`（svc-auth、svc-autoscaling），永远无法通过 | auth、autoscaling、load-balancer、waf、identity-pool 及 A 组 | wire 检查与最终复核误判 | 本文 §1.1 规则 3 的“预期警告集合”写法；建议 04 为 capability 断言提供 `expectedWarnings: [...]` 简写（只允许列出的规则让模块为 `degraded`），避免每张卡片手写 `app.validation.warnings` 的子集断言（04 §5.3） |
| B-20 | **已由 C3 解决**：before 状态的断言一律 `drift: once`，04 §3.5 第 9 条把漏写列为 lint 错误。原问题：（审稿新增）04 §5.8 对 `capability`、`local`、`http-header`、`aws-readonly` 的默认漂移策略是 `must-hold`，只有 `observe` 步骤中的检查默认 `once`。描述 before 状态的检查放在对比实验或 CLI 步骤里时，启用目标模块后最终复核必然判为漂移 | 全部（svc-network、tls、waf、load-balancer、iam、auth、identity-pool、secrets、config、kms 已逐项标注） | 卡片无法完成 | 本文 §1.4 约定 1；建议 04 lint 增加一条：断言目标模块为本地驱动或 `status=off` 的检查若未标 `once` 且不在 `observe` 步骤中，给出警告（04 §3.5） |
| B-21 | **未解决**（需回写 02#config）。原问题：（审稿新增）02#config：① 迁移脚本把 `runtime.json` 的每个键写成参数，但 `banner` 默认空串、`allowedEmailDomains` 默认空列表，Parameter Store 不接受空值（以官方 API 校验为准），脚本对空值是跳过还是写占位未定义；② §5 的 `reject-invalid` 步骤写“实验后删除这两个参数”，其中 `maxUploadMb` 是正式热键，删除后应用会退回 file 层或默认值 | config | 迁移可能在空值上报错；实验后配置悄悄改变 | ① 迁移脚本跳过空值（读取时缺省即默认值），并在 diff 页面标注“未写入（空值）”；② 改为“删除 `CACHE_DRIVER`，用参数历史把 `maxUploadMb` 写回原值”（02#config §5、§6） |
| B-22 | （第 2 轮新增）**起始状态中的模块也会带来预期警告**：DEP-011（load-balancer 已启用但没有 HTTPS 监听器或 Cognito）在 `LB_MODE=alb` 的默认用法下必然触发，SEC-002 在不锁入口时必然触发；DEP-013 在 auth=cognito 且 email=outbox 时必然触发。04 §3.2.5 的“典型取值”只给 svc-load-balancer 列了 SEC-002、给 svc-identity-pool 列了 DEP-030 | load-balancer、autoscaling、identity-pool（及起始状态含 load-balancer 或 auth=cognito 的场景卡） | 漏列时 02 的健康门 `caps.profile` 在开始阶段就判失败，或 wire 检查永远不通过 | 本批已按实际触发的规则填写：svc-load-balancer `[SEC-002, DEP-011]`、svc-autoscaling `[ASG-009…013, SEC-002, DEP-011]`、svc-identity-pool `[DEP-013, DEP-030]`；04 §3.2.5 的典型取值同步；`labs:derive` 的 DRV-6 应同时检查起始状态（不只是启用目标的过程）出现的 warn（04 §3.2.5、§3.5） |
| B-23 | （第 2 轮新增）**svc-network 改为 public 目标后的衔接**：第 1 轮 svc-network 的 private 内容（入口 ALB、NAT、EIC Endpoint、`endpoint-only`、B-6 的终端节点取值问题）需要由场景卡 `sc-private-network` 承担；05 的卡片元数据汇总表需要按本文第 3 节同步（中级、低、部署等级 A、起始 L0 + iam） | network、`sc-private-network` | 两边都不写时，NAT 与私有化的教学点会丢失；两边都写时内容重复 | scenario-cards.md 的 `sc-private-network` 吸收上述选做内容；05 汇总表与 tracks-and-catalog §2.1 以本文为准（tracks-and-catalog T6、P-1、X-2） |
| B-24 | （第 2 轮新增）**模块文档中仍有不带 `envName` 的固定名称**：KMS 别名 `alias/cloudalbum`、WAF IP 集合 `cloudalbum-blocklist` 与 `cloudalbum-lab-allow`、CloudFront 响应头策略 `cloudalbum-lab`、缓存策略 `cloudalbum-media` 等。统一取值规定锁在 `CLEANUP_FAILED` 时也释放，上一环境的残留（回收失败、仍在删除中）可能与新环境的同名资源冲突 | kms、waf、cdn | 新环境的 `enable` 因名称已存在而失败 | 01 的名称表收录这些名称，或改为带 `envName` 的形式（例如 `alias/cloudalbum-<envName>`）并回写模块文档；在此之前卡片照模块文档原样引用（C1） |
| B-25 | （第 3 轮新增，**已由 01 第三轮解决**）**`us-east-1` 的 CloudFormation 被学员边界拒绝**：01 §6.5 的 `UsEast1EdgeOnly` 原先没有放行 `cloudformation:*`，而 `waf-edge`（CLOUDFRONT 范围的 Web ACL、IP 集合、日志组）与 `tls-edge`（CloudFront 集成证书）都是 `us-east-1` 的栈（modules/01）。学员在工作台上 `scripts/module enable waf`、`enable tls --no-acme` 会被拒，回收器也删不掉这些栈。01 现已在学员边界与 Provisioner 边界放行 `cloudformation:*`，并以护栏 `UsEast1LabStacksOnly` 把 `us-east-1` 的栈写操作限定为 `stack/cloudalbum-*`；07 V5-2 增加对应护栏用例并走查 waf 步骤 | waf、tls（回退档）、cdn（与 tls 联用时） | svc-waf（`saa-main` 必修）第 3 步与 svc-tls 回退档的启用失败；回收进入 `CLEANUP_FAILED` | 无需卡片改动；第 3 步注明前提（01 §6.5、§6.7、07 V5-2） |


---

## 审稿修订记录

### 2026-10-13 · 对抗式审稿（第 1 轮）

审稿依据：总纲 §3.2、§5.2、§5.3、§10.4；00～02 模块文档；平台文档 01（§6.4～6.7、§9）、02（§4.3、§5.7、§6.5、§7、§11）、03 §6.2、04（§3、§5、§6.4、§11.3）、05（§2.7、§4.1～4.3）；ui-design §9.2 与 B-16。AWS 事实中拿不准的，已按官方 API 参考核实：KMS `DisableKey`、`EnableKey`、`GetKeyRotationStatus` 只接受密钥 ID 或密钥 ARN，不接受别名。

**startProfile 闭包复核结论**：14 张卡片的模块集合都与总纲 §10.4 的最小依赖表与 §5.2 规则表一致，没有多也没有少；`credentials: required` 的卡片都已并入 iam，`optional` 的按 §10.4 规则 2 不并入。svc-network 的 `network(public)` 前驱状态是 DEP-016 的必然要求，不是多余模块。闭包本身未改，只改了实现路径（第 2 条）。

**已在正文中修正的问题**

| # | 位置 | 问题 | 修正 |
|---|---|---|---|
| R-1 | §1.1 规则 3、各 wire 步骤 | 总纲 §5.3 规定 warn 级规则会把关联模块标为 `degraded`。svc-auth（DEP-013）、svc-autoscaling（ASG-009～013）初稿要求 `status=ok`，永远无法通过；svc-load-balancer（SEC-002）、svc-waf（DEP-018）只按“detail 含‘无凭证’”判定也会误判 | 统一为“`status=ok`，或 `degraded` 且相关规则 ⊆ 本卡预期警告集合，`validation.errors` 为空”，每张卡片写出集合；回写建议见 B-19 |
| R-2 | §1.4、10 张卡片的 before 检查 | 04 §5.8 默认 `must-hold`；“`driver=local/off`”类断言放在对比实验或 CLI 步骤中，启用目标模块后最终复核必然判为漂移 | 新增书写约定 1，逐项标注 `once`（network、tls、waf、load-balancer、iam、auth、identity-pool、secrets、config、kms）；B-20 |
| R-3 | §1.1 规则 6、svc-network | `profile apply --fresh` 在 02 §11.4 中明确“不在 v1 范围”；v1 先在默认 VPC 部署 L0 | 改为“迁入自定义 VPC 的分阶段替换在开始阶段发生，部署等级 B” |
| R-4 | 总表、A.2 | 04 §3.1 必填的 `provision` 缺失，schema 校验会失败 | 总表加“部署等级”列，A.2 加 `provision: { class: A }`；svc-autoscaling 为 D |
| R-5 | §1.2、高档位卡片 | 初稿把高档位卡片的延长次数减为 1 次，与 05 §4.2“全部 2 × 30 分钟”不一致，且这些卡片等待最多 | 恢复 2 × 30 分钟，改为限制保留环境 ≤ 12 小时（与 05 一致） |
| R-6 | §1.5、A.1、A.2 | 徽章条件“小测 ≥ 70 分”与用户要求“完成单张卡片获得徽章”不符；每卡 3 题时 70 分等于全对；04 §3.2.10 规定小测不影响完成 | 徽章只看完成；`requiredForBadge` 默认 false，启用时题池 ≥ 5 题 |
| R-7 | §1.4 | `/api/lab/now` 在总纲中没有定义（ui-design B-16 已改名）；`/api/lab/*` 多为管理员接口，平台检查无法请求 | 改用 `/api/lab/probe/now`、`/probe/echo`（svc-cdn 第 4 步、svc-load-balancer 第 2、4 步） |
| R-8 | §1.4 | leak-scan、imds-ssrf、ciphertext-view 等写成在实验机终端运行，但上传接口要用学员身份 SigV4，实例角色只有 SSM 核心权限 | 约定从工作台发起、经 SSM 投递到实验机执行 |
| R-9 | svc-ec2 第 3 步 | `disk-usage` 只返回 `fstype`，AL2023 根卷同为 xfs、两卷同为 20 GiB，不能证明“独立挂载” | 改用 `CAP`（admin）`ec2.checks` 的 `data-volume=ok` |
| R-10 | svc-ec2 第 6 步、A.3 | 停机期间实例上的指标采集也停了，`lab-metrics-run` 交叉校验看不到停机，`single-point-of-failure` 缺少服务端佐证 | 新增 `ssm-agent-restarted`（`systemd-unit` 的 `since` 晚于演练开始）；修正为 04 §4.4 中存在的引用写法 |
| R-11 | A.2、A.3 | `eip-unchanged` 缺 `reproduce`（04 lint 第 6 条）；`cleanup.dataRisk` 写 `scripts/teardown --purge-data`（平台不用）；快照的 `learnerCreatedHints` 写“按标签删除”（02 §7.2：仅凭标签只进 REVIEW）；`permissions` 漏了 rebuild-instance 以调用者身份执行 CloudFormation 所需的 EC2、`iam:PassRole`、`ssm:SendCommand`，注释称“边界限定为本会话实例”与 01 §6.5 不符 | 逐项修正 |
| R-12 | A.1、A.2 | 04 §3.2.9 的“必需实验 = 一对有效 before/after”与只有一个标签的 `smoke`、`spof` 矛盾 | A.1 明确单标签语义，B-10 补回写建议 |
| R-13 | svc-cdn 第 3 步、svc-load-balancer 第 3 步、svc-network 第 4 步 | 学员在本卡创建的资源用了 `ownership: session-or-start`，会接受起始状态资源 | 改为 `session` |
| R-14 | svc-dns 第 5 步 | 目标是 EIP（普通 A 记录），本卡根本没有 Alias 可供 `dig` 观察 | 改为在同一托管区域建 `www` → Alias 到 A 记录；清理说明与 02 §7.3（回收器会删本会话建的记录）对齐 |
| R-15 | svc-tls | ① 回退分支漏写 `DNS_PROVIDER=external`，DEP-005 ③ 是启动检查，会退出码 78；② 回退分支需要把 A 记录换成 CNAME，且根域名不能 CNAME；③ `tls-handshake` 没写 `target`；④ ACME 证书由签发角色会话创建，无法直接用 `ownership`；⑤ 小测第 3 题解析对“在用才续期”说得含糊 | 逐项补写；④ 记入 B-12 |
| R-16 | svc-waf | ① DEP-018 与 Count 模式的检查会在第 4、6 步后漂移；② 托管规则组的 Block 默认不带 `waf=aws:block-…` 路径头，第 6 步检查不可靠，也无法区分 Nginx 正则的 403；③ 第 7 步“工作台在白名单内”易与 `WAF_LAB_ALLOW_CIDR` 混淆；④ 小测第 3 题解析没说明 C、D 为何错 | ① 标 once；② 改为 403 + `nginx-log-summary` 中 nonce 计数为 0，路径头降为 warn；③④ 改写 |
| R-17 | svc-autoscaling | ① `WAF_LAB_ALLOW_CIDR` 在 ASG 启用后修改会触发实例刷新；② 停机保留的 L0 实例仍带 `atl:role=lab-app`，`instances: all` 会失败；③ 必需实验偏多 | ① 移到第 3 步（启用前）；② 写入检查说明并扩充 B-16；③ `max-toggle` 改为选做 |
| R-18 | svc-iam | ① 撤销会话“学员无权”的理由不成立（`ProtectAppRole` 不拦 `PutRolePolicy`）；② `iam:ListAccessKeys` 的白名单资源名（`cloudalbum-app`）与演示用户名不一致；③ leak-scan(after) 可能命中 keys 模式期间的本地备份；④ 缺 `platformOps` | 逐项改写；② 记入 B-12；④ 补“平台动作”一行（与 05 lab-01 同名） |
| R-19 | svc-auth、svc-identity-pool | bulk 迁移后的账号处于“首次登录需重置”状态，`login-storm(after)`、`revoke(after)`、越权测试都登不进去；初稿让 runner 直接 `AdminSetUserPassword`，违反 01 §6.7 第 6 层；选做“迁移账号首次登录”需要一个迁移前注册的本地账号 | 改为工作台准备脚本以学员身份设置已知密码；B-11 改写 |
| R-20 | svc-secrets | “文件显著变小”无法判定；`ListSecrets` 不能带单资源 `ownership`；强制删除是异步的 | 改为与第 1 步 `sizeBytes` 比较、改用 `DescribeSecret`；清理说明与 B-8 补异步删除的风险 |
| R-21 | svc-config | ① “9 个参数”：`banner`、`allowedEmailDomains` 默认为空，Parameter Store 不接受空值；② 第 6 步“删除两个参数”会删掉正式热键 `maxUploadMb` | ① 改为列出 7 个非空键；② 只删 `CACHE_DRIVER`，`maxUploadMb` 写回原值；B-21 |
| R-22 | svc-kms | ① `GetKeyRotationStatus`、`DisableKey`/`EnableKey` 不接受别名（已核实）；② “需要学员是密钥管理员”不成立（根主体语句把授权委托给 IAM）；③ `--ebs` 不是模块参数，换卷流程误写为 rsync | ① 改用密钥 ARN；② 改写并更正 B-14；③ 改为 `--apply-to fields,ebs` 与快照复制 + 分阶段替换 |
| R-23 | 附录 B | B-7、B-8、B-13、B-14、B-15 的前提与 01、02 的现有设计不符（护栏范围、回收器已覆盖的清单、watchdog 只对“已终止”报警、密钥策略的根主体语句、学员边界放行 `ec2:*`） | 逐条更正；新增 B-19～B-21 |
| R-24 | §1.2、§1.3 | 费用说成“按示例价”（04 §3.4 审稿后已改为 Price List）；中级判定标准改动了 05 的原文 | 恢复 05 原文，并说明 secrets、kms、load-balancer 归入中级的依据 |

**未改动、需要主设计者或其他文档确认的事项**：B-4（`optional` 模块是否并入 iam）、B-5（方案 B 下 `APP_BASE_URL` 的取值与 Cognito 是否接受 IP 回调地址）、B-12（`tls-domain` 目标、按模块的探测端点、ACME 证书的所有权判定、`ListAccessKeys` 资源名）、B-16（停机 L0 实例的发现规则）、B-19（`expectedWarnings` 断言简写）。ACM ACME 端点相关的 API 细节（`ListCertificates` 的 ACME 过滤参数名等）是 2026 年的新能力，本轮只与 01#tls 的核实记录对齐，未独立复核。

### 2026-10-13 · 第 2 轮（按主设计者裁决 C1～C5 修订）

依据：主设计者裁决 C1～C5；平台评审的统一取值（inconsistencies 第 2、3、23、24、29、31、37 条等）；04 第 2 轮（`atl.lab/v2`、`op: healthy`、`expectedWarnings`、`expectedOutage`、定向扫描、`/api/lab/probe/*`）；tracks-and-catalog 的 T6、P-1、X-2。

| # | 裁决 / 来源 | 位置 | 修改 |
|---|---|---|---|
| R2-1 | C3 | §1.1、总表、cdn、dns、tls、waf、load-balancer 的元数据与检查 | 起始状态改为“L0 + iam(role) + 硬依赖闭包”，`svc-ec2`、`svc-iam` 例外；6 张 A 组卡片加 iam，CRED-004 全部删除，失效按钮、IP 集合同步、目标健康、证书状态等控制面子功能改为可用；起始状态由 `plan --start-of` 推导，档位 `atl/<卡片 id>` |
| R2-2 | C3 | §1.1 规则 3、总表“预期警告”列、各卡元数据与 wire / final 检查 | 能力检查统一为 `op: healthy` + 卡片级 `expectedWarnings`；按实际触发的规则补齐 DEP-011（load-balancer）与起始状态模块的警告（svc-autoscaling、svc-identity-pool），svc-waf 锁定后用检查级 `expectedWarnings: []`（B-22） |
| R2-3 | C3 | §1.4、各卡 before 检查 | before 断言一律 `drift: once` 保持并补齐（cdn 第 1 步、autoscaling 第 1 步等） |
| R2-4 | C3 | §1.5、附录 A | 徽章只看完成，小测成绩只记录在徽章上；删除 `passScore`、`requiredForBadge` |
| R2-5 | C1 | 全文 | 栈、参数、secret、角色、日志组、演示用户等改为 `cloudalbum-<envName>-*`、`/cloudalbum/<envName>/*`；演示用户 `cloudalbum-<envName>-demo-keys`（路径 `/cloudalbum/`），交接路径 `/cloudalbum/<envName>/iam/demo-keys`；共享检查名 `no-world-ssh`；实例发现与 EIP 检查改按 `atl:env-id`；回收与编排用 `atl-session-end`、`ATL_OP=destroy`、`atl-reaper` |
| R2-6 | C4(c)(d)(e) | §1.4 约定 4、§1.5、cdn / network / dns 的清理说明 | `state.json` 与锁位于 `cloudalbum-lab-state-<acct>-<region>`、`cloudalbum-lab-locks`；栈标签含 `atl:component=env`、`atl:env-id`；控制台手建资源的归属走定向扫描（us-east-1 查全局服务、分钟级延迟、2/2/4/4/8 分钟重试、默认 20 分钟上限），删除“手工补打 `atl:session-id`”的要求 |
| R2-7 | C5 | 全文 | 探测端点统一为 `/api/lab/probe/*`（`now`、`echo`、`auth`、`identity-pool`、`kms`），令牌头 `X-ATL-Probe-Token`；`echo` 回显两个头改为正式断言；实验标签改为任意变体（`l0`、`rebuild`、`workers-2`、`unsafe`、`ttl-0`/`ttl-300`），结果标注 `variant`；测试数据改为种子 `cognito-test-users`、`gps-sample-photos`；svc-tls、svc-autoscaling 关闭方案 B |
| R2-8 | C2、04 v2 | 附录 A | A.1 改为“第 1 轮写法 ↔ 04 v2”的对照表；A.2 按 04 v2 重写（`modules` 对象、`provisions` 的 `kind/basis`、`expectedWarnings`、单标签实验 `role: single` + `validity: functional`、`badge`、`tracks`、`expectedOutage`）；A.3 新增 `cap-ec2-healthy` |
| R2-9 | tracks-and-catalog P-1 / X-2（C2：路径以其为准） | 第 3 节、§1.1～1.3、总表 | svc-network 改为“默认 VPC → 自定义 VPC 的 public 放置”（原 Lab 14），难度中级、费用低、部署等级 A；private 放置移交 `sc-private-network`（B-23） |
| R2-10 | 04 v2 | ec2、iam、kms 的停机步骤 | 停机、实例替换与撤销会话步骤声明 `expectedOutage` / `interruptsManagementChannel` |
| R2-11 | 04 §5.2.3、§5.2.4、§5.7 | tls、dns、network、secrets、kms | tls 用 `tls-domain` 目标与“栈成员角色”归属；dns、tls 的 wire 证据加 `module-state`；`DescribeInstanceConnectEndpoints`、`GetHealthCheckStatus` 已进白名单；secrets 的跨检查引用写成 `{{$check.secrets-file-before…}}`；kms 用 `stack.kms.InfoKeyArn` |
| R2-12 | 附录 B | B-1～B-21 | 逐条标注处理状态（已由 C# 解决 / 部分解决 / 未解决）；新增 B-22～B-24 |

**没有采纳的意见**：svc-tls 的起始变体名采用 tracks-and-catalog 的 `acme-off`，但没有采纳它“把 `DNS_PROVIDER=external` 写进变体起始状态”的做法：外部 DNS 本地档必须同时写入含域名的 `APP_BASE_URL`，域名是学员前置输入，04 §3.2.3 规则 6 规定这类设置不进起始状态；DEP-005 ③ 只在启用 tls 时检查，本卡在第 2 步写入即可（需 tracks-and-catalog §2.2 同步）。

**仍需其他文件配合**：06（`cognito-test-users` 的两个阶段与执行身份、`probe/echo` 回显、方案 B 下 `APP_BASE_URL` 的取值、运行器参数形式）；01（名称表收录 B-24 的固定名称；若种子由运行器执行，带外白名单加入限定本环境 User Pool 的 `AdminSetUserPassword`）；04（§3.2.5 典型取值补 DEP-011，DRV-6 覆盖起始状态的警告）；scenario-cards（`sc-private-network` 承接 svc-network 的 private 内容）；05 与 tracks-and-catalog（元数据汇总按本文同步：svc-network 行、各卡起始状态加 iam）；01#autoscaling（启动模板标签传播）；02#config、02#kms、00-ec2-base §9.1（B-21、B-14、B-13 的模块文档回写）；07（Cognito IP 回调、定向扫描延迟实测）。

### 2026-10-13 · 第 3 轮（跨文档审计修复）

| # | 审计问题 | 位置 | 修订 |
|---|---|---|---|
| R3-1 | （中）元数据中的档位名 `atl/<card-id>` 与 01 的 `atl/<card-id>/<variant>` 不一致，运行器按 01 下载文件 | §1.1 约定、全部卡片元数据、附录 A、迁移对照表 | 一律改为 `atl/<card-id>/default`（svc-tls 的回退档仍为 `atl/svc-tls/acme-off`） |
| R3-2 | （中）svc-identity-pool 第 3 步断言 `identity-pool=cognito:sts`，而 06 PM-11 的探测端点只输出 `cognito:probe`，检查永远失败 | svc-identity-pool 第 3 步 | 探测端点改断言 `cognito:probe`；“真的接入 STS”的证据改为 `path-seen`（`^cognito:sts$`，学员上传一张照片之后） |
| R3-3 | （中）svc-config 第 2 步用 `/api/capabilities` 取 `config=` 路径段，capabilities 不保证经过 ConfigPort | svc-config 第 2 步 | 改为请求 `/api/lab/probe/now`（06 PM-11） |
| R3-4 | （中）svc-kms 写死 `alias/cloudalbum`，平台模式下别名为 `alias/cloudalbum-<envName>`（06 PM-M13） | svc-kms 目标模块、实验资源、第 3、6 步 | 别名写 `alias/cloudalbum-{{ session.env }}`；`kms:DescribeKey` 改用栈输出 `stack.kms.InfoKeyArn` |
| R3-5 | （高，配合）`us-east-1` 的 CloudFormation 被学员边界拒绝 | svc-waf 第 3 步、附录 B-25 | 01 已放行并加护栏；第 3 步注明前提，附录 B 记录 |
| R3-6 | 自查 | 附录 B-11 | Cognito 阶段的执行身份已由 06 定为工作台学员身份 |

**没有采纳的意见**：无。

**仍需其他文件配合**：无新增（01 §6.5、06 PM-11/PM-M13 已就绪；05 §4 的汇总表同轮同步）。
