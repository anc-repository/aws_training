---
section: overview
---

## 背景

起始状态下 CloudAlbum 的所有邮件——注册验证、找回密码、评论提醒、日报——都只写进 EC2 上的 outbox（`.eml` 文件 + `outbox_emails` 表），
本人在 `/me/outbox` 预览，页面标注“本地实现，未真正发信”。这能让一个人走完注册流程，但用户的真实邮箱什么也收不到，
而且 outbox 档的“邮箱已验证”证明不了邮箱归属（任何人都能用别人的地址注册，再在 `/me/outbox` 看到验证链接）。

这张卡片让同一份 MIME 经 Amazon SES 真正发出。投递、退信、投诉事件经配置集的事件目标送到模块自带的 SNS 主题，再进 SQS 反馈队列，
由 worker 拉取并更新 `/admin/outbox` 中的投递状态与 `users.email_status`——EC2 不需要开放任何入站端口。

:::why
为什么不在 EC2 上自建 postfix 直接投递？EC2 默认限制出站 25 端口（可以申请解除），而且从弹性 IP 直接发出的邮件信誉很差，大概率进垃圾箱。
SES 提供有信誉的发送 IP、DKIM 签名、退信与投诉处理，以及发送配额与速率的保护。
:::

## 对比实验预告

### 发信矩阵（email/send-matrix，必做）

- **没有 SES（outbox）**：给 SES 邮箱模拟器的三个地址与你自己的地址各触发一封“重置密码”，全部写进本机 outbox，没有真正发出。
- **有了 SES**：同样的四封经 SES 发出；success → 已投递、bounce → 退信、complaint → 投诉，几秒到几分钟内回流到 `/admin/outbox`。
- **你会在哪里看到**：报告中每个地址的 `deliveryStatus`；响应头 `X-CloudAlbum-Path` 从 `email=outbox:stored` 变为 `email=ses:sent`；
  你的邮箱里收到一封带 `DKIM-Signature` 的邮件。
- **如果结果不符合预期**：先确认发件身份已验证；沙盒期你自己的地址必须就是那个已验证的身份。

### 沙盒限制（email/sandbox，必做）

发给一个没有验证过的地址：服务端记录为 `failed`、错误 `MessageRejected`（`/admin/outbox` 标红），路径段 `email=ses:rejected`；
注册本身照常完成，应用不会把失败的邮件悄悄改写成“已发送”。

## 开始前

- SES 发件身份：一个能收信的邮箱（开始前填写）。部署后到邮箱点击 “Amazon Web Services – Email Address Verification Request” 中的链接。
- 建议用 DMARC 策略不是 `reject` 的邮箱：以邮箱身份发信时 SPF 与 DKIM 都不与发件域对齐，发件域若发布了 `p=reject`，
  发给你自己的邮件可能被收件方拒收（以官方文档与实测为准）。
- 可选：自有域名（最后一个选做步骤，域名身份 + Easy DKIM 需要写 3 条 CNAME）。
- 卡片始终在 SES 沙盒中完成：沙盒期只能发给已验证地址与 SES 邮箱模拟器。

## 平台模式说明

发件身份可以在结束时勾选保留；下次再部署 email 时，`scripts/module` 发现身份已存在会只读接入（`AdoptExistingIdentity=true`），
不会因为同名身份已存在而失败，禁用时也不会删除它。
