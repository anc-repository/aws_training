---
section: overview
---

## 背景

起点是 L0：有人评论照片时，CloudAlbum 写一条站内信（铃铛里的未读数），再由 EC2 逐个调用 EmailPort 给开启了邮件通知的人发邮件——
而 EmailPort 只把邮件写进本机 outbox（`/me/outbox` 可以预览，页面标注“本地实现，未真正发信”）。接收人越多、渠道越多，EC2 干的活越多，
用户却一封也收不到；退信、投诉更是无从谈起。

这张卡片先让事务邮件经 **Amazon SES** 真正发出，并把退信与投诉经 SNS → SQS 拉回应用；再把“有新评论”的站外扇出交给 **Amazon SNS**：
应用只 `Publish` 一次，带上 `userId` 消息属性，由订阅过滤策略决定谁收到；模块自带的 SQS 收件队列收到每条事件的副本，worker 据此补写记录。

## 架构

### 开始时

![开始时：api 逐个调用 EmailPort，邮件只写进本机 outbox](assets/arch-start.svg)

### 完成后

![完成后：api 发布一次到 SNS 通知主题，按 userId 过滤投递到用户邮箱，并复制到 SQS 收件队列；验证码经 SES 发出，退信与投诉经 SNS → SQS 回到 worker](assets/arch-end.svg)

## 为什么组合在一起

- **SNS 负责“一次发布、多处投递”**：每个订阅拿到一份副本，接收人增加时发布方的耗时不变；订阅过滤策略在投递前执行，
  每个订阅只收到与自己相关的消息；以后加短信、移动推送或数据分析，只是多一个订阅。
- **SQS 让推送变成可靠的拉取**：SNS → SQS 订阅把事件放进队列，worker 长轮询消费，实验机不需要开放任何入站端口；worker 停机时消息在队列里等待。
  这里用的是 notification 与 email 两个模块**自带**的队列，并没有启用 queue 模块。
- **SES 负责事务邮件**：验证码、重置密码这类个性化、需要证明邮箱归属的邮件，经 SES 以你的发件身份发出（带 DKIM 签名）；
  配置集的事件目标把投递、退信、投诉事件发到 SNS，再进 SQS 反馈队列，由 worker 更新投递状态并停止给退信地址发非必要邮件。
- **常见错误组合**：用 SNS 邮件订阅发验证码（同一条纯文本发给所有订阅者、带退订尾注、收件人要先确认订阅）；用一个 SQS 队列做“一对多”
  （竞争消费，一条消息只给一个消费者）；在 EC2 上跑 SMTP 直接发信（出站 25 端口默认受限，没有发信信誉）；让 SES 事件推到实例的 HTTPS 端点
  （必须暴露入站端口）；忽略沙盒（沙盒期只能发给已验证地址与邮箱模拟器）。

## 对比实验预告

### 一次事件的站外扇出（notification/fanout，必做）

- **开始时（db）**：每条评论事件由 EC2 逐个调用 EmailPort（本卡起点写进 outbox），评论请求的 Server-Timing 中 `notification` 段包含这些调用。
- **完成后（sns）**：同样的评论，EC2 只调用一次 `Publish`，邮件由 SNS 发出，收件队列另收到一份副本。
- **你会在哪里看到**：报告中服务端投递记录的渠道从 `email` 变成 `sns` + `sqs-copy`；路径头从 `notification=db:email` 变为 `notification=sns:published`。

### 订阅过滤（notification/filter，必做）

只给 `+u1` 的照片发一条评论：服务端只有一行 `sns` 与一行 `sqs-copy`，邮箱里只有收件人为 `+u1` 的那封到达，
CloudWatch 的 `NumberOfNotificationsFilteredOut` 增加。

### worker 停机（notification/worker-stop，必做）

运行器在第 5 秒停止 worker、第 50 秒启动：评论照常成功、通知邮件照常到达，只有收件队列积压；worker 恢复后积压被消费，`sqs-copy` 记录补齐。

### SES 沙盒（email/sandbox，必做）

发给一个没有验证过的地址：服务端记为 `failed`、错误 `MessageRejected`，路径段 `email=ses:rejected`；注册本身照常完成，
应用不会把失败的邮件悄悄改写成“已发送”。

## 开始前

- **SES 发件身份**（`ses-identity`）：一个你能收信的邮箱地址。第 3 步部署后到邮箱点击 “Amazon Web Services – Email Address Verification Request” 中的链接。
- **通知邮箱**（`notify-email`）：一个支持 `+` 别名的邮箱，可以与发件身份相同。两位测试用户是它的 `+u1`、`+u2` 别名，运维订阅用 `+admin` 别名；
  本卡要点击约 3 封 “AWS Notification - Subscription Confirmation”，容易被归入垃圾箱。
- 卡片始终在 SES 沙盒中完成，不申请生产访问；平台不会代你点击任何验证或确认链接。

## 平台模式说明

对比实验与种子脚本在工作台运行；worker 的停止与启动经平台管理通道（SSM）完成，不需要 SSH。
