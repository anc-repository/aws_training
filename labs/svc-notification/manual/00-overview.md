---
section: overview
---

## 背景

“有人评论了你的照片”时，CloudAlbum 先写一条站内信（铃铛里的未读数），再把站外通知发出去。起始状态的 db 驱动由 EC2 自己逐个调用
EmailPort：接收人越多、渠道越多，EC2 干的活越多；QUEUE_DRIVER=sync 时这些时间全部算在发评论的请求里。
这张卡片把站外扇出交给 Amazon SNS：应用只调用一次 `Publish`，带上 `userId`、`audience` 等消息属性，由订阅上的过滤策略决定谁收到；
模块自带的 SQS 收件队列收到每条事件的副本，worker 据此记账。

:::why
SNS 是推送式的发布订阅：一条消息按订阅扇出成多份投递，每个订阅一份。SQS 是拉取式队列：一条消息只交给一个消费者。
“SNS 主题 + 每个消费者一条 SQS 队列”把两者组合起来：每个下游都有自己的副本和缓冲，一个下游暂时不可用不会丢消息，也不会拖慢别人。
:::

## 对比实验预告

### 一次事件的站外扇出（notification/fanout，必做）

- **没有 SNS（db 驱动）**：每条评论事件由 EC2 调用 EmailPort 给收件人写一封邮件（本卡起始状态写进本机 outbox）。
- **有了 SNS**：同样的评论，EC2 只调用一次 Publish（十几到几十毫秒量级），邮件由 SNS 发出；收件队列另收到一份副本。
- **你会在哪里看到**：报告中服务端投递记录的渠道从 `email` 变成 `sns` + `sqs-copy`；响应头 `X-CloudAlbum-Path` 从
  `notification=db:email` 变为 `notification=sns:published`；邮箱里收到发件人为 AWS Notifications、带退订链接的纯文本邮件。
- **如果结果不符合预期**：先确认种子用户的订阅都已确认（PendingConfirmation 的订阅不投递）；再确认 worker 在运行（`sqs-copy` 由它写）。

### 订阅过滤策略（notification/filter，必做）

只给 `+u1` 发一条事件：只有收件人为 `+u1` 的邮件到达（所有别名都进同一个邮箱，按收件人地址区分），CloudWatch 的
`NumberOfNotificationsFilteredOut` 增加。

## 开始前

- 一个能收信、支持 `+` 别名的邮箱（开始前填写的“通知邮箱”）。卡片中要点击约 4 封 “AWS Notification - Subscription Confirmation”
  确认邮件：1 封给运维订阅（`+admin`），3 封给测试用户（`+u1`～`+u3`）。确认邮件容易被归入垃圾箱。
- 平台不会代你确认订阅（人工前置 confirm-email）。

## 平台模式说明

对比实验在工作台运行；worker 的停止与启动在实验机终端执行（平台管理通道是 SSM，不需要 SSH）。
