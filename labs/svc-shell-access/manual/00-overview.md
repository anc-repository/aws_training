---
section: overview
---

## 背景

CloudAlbum 出了问题，你要登录 EC2 排障。L0 的做法是 SSH：安全组为运维 IP 开放 22 端口，私钥要分发、轮换、防丢；事后只知道
“哪把公钥从哪个 IP 登录过”，不知道登录后做了什么。平台模式下实验机的 SSM Agent 已经因为“平台管理通道”在线，所以本卡比较的不是
“有没有 SSM Agent”，而是**运维者通过哪条路登录、谁能登录、事后能不能追溯**。

:::why
Session Manager 的连接全部由实例上的 SSM Agent **主动向外**建立（443 到 `ssm`、`ssmmessages` 端点），运维者用自己的 IAM 身份经
Systems Manager 中转。安全组是有状态的，回包自动放行，所以实例可以没有任何管理端口入站；每次会话都记在 CloudTrail（谁、何时），
会话里的命令与输出写进会话日志组。
:::

## 对比实验预告

### 端口探测（shell-access/probe-port，必做）

- **没有（SSH 基线）**：从工作台探测实验机私网地址的 22 端口为 open；安全组里有一条“22 ← 工作台 /32”的规则。
- **有了 Session Manager**：同样的探测变成超时（filtered），安全组里不再有任何覆盖 22 的入站规则；443 不受影响。
- **你会在哪里看到**：对比报告中的 `port22.open`、`sgRules22`；capabilities 中 shell-access 的 detail 从“未启用”变成“无管理端口入站”。

### 审计链（shell-access/session-audit，必做）

- **有了 Session Manager**：会话历史（谁、何时）↔ 会话日志（执行了什么）↔ CloudTrail `StartSession`（IAM 身份）按会话 ID 对齐。
- **对照**：SSH 只能从 journal 看到“公钥指纹 + 来源 IP”，回答不了“谁执行了什么命令”。

## 平台模式说明

- 平台终端使用独立的 Session 文档 `ATL-SessionShell`，本模块不修改它；统计会话时会排除平台终端会话，只看你从工作台发起的会话。
- 本模块修改的是账号 × 区域级的单例 `SSM-SessionManagerRunShell`（会话首选项）：修改前把原值备份到环境状态桶，回收时还原。
- 平台模式下 `scripts/module` 的投递通道从一开始就是 SSM，所以“投递方式从 ssh 变成 ssm”这一观察点在本卡不成立。
