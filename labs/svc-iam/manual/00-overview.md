---
section: overview
---

## 背景

L0 的应用不调用任何 AWS API。从这张卡开始，应用通过实例配置文件从 IMDSv2 取得**临时凭证**：小时级有效、由 EC2 自动轮换、不落盘。
之后的 storage、queue、cdn 等模块都依赖这一步。反面教材是把长期访问密钥（`AKIA…`）写进磁盘：它永不过期，会随快照、备份与日志扩散。

:::why
**实例有角色，不等于应用在用。** 平台模式下实验机从一开始就挂着 `CloudAlbumAppRole`（只含 `AmazonSSMManagedInstanceCore`，是平台的管理通道）。
本卡的“没有”是应用的 `IAM_CREDENTIALS=none`：应用根本不读这个角色。启用 iam 后，`scripts/module` 给角色附加 iam 模块自己的只读策略，
并让应用改用实例角色；以后每启用一个模块，再附加该模块的一条客户托管策略——最小权限随模块增减。
:::

## 对比实验预告

### 身份对照（iam/whoami，必做）

- **没有（none）**：应用不能调用 AWS API，whoami 报告“没有凭证”。
- **有了实例角色（role）**：调用者是 `assumed-role/CloudAlbumAppRole/<实例 ID>`，密钥以 `ASIA` 开头，带过期时间。
- **你会在哪里看到**：whoami 的报告；`/lab` 的 iam 卡片；CloudTrail 事件中的 `userIdentity`。
- **反面教材（只读）**：长期密钥以 `AKIA` 开头、没有过期时间，泄露后只能停用密钥，业务随之中断。

## 平台模式说明

`enable iam` 在平台模式下走 `AppRoleMode=existing`：`CloudAlbumAppRole` 与实例配置文件属于平台，模块只创建并附加自己的只读策略。
本卡不创建按量或按小时计费的资源。
