---
step: enable-notification
---

接入 SNS。模块会创建主题 `notification-events`、收件队列 `notification-inbox`（原始消息传递、不设过滤策略）、订阅级 DLQ
`notification-dlq`，以及一个给运维兜底邮箱的邮件订阅（过滤策略 `{"audience":["admin"]}`）。运维邮箱请用通知邮箱的 `+admin` 别名，
例如通知邮箱是 `{{ learner.inputs.notify-email }}` 时，在 `@` 前加 `+admin`。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<通知邮箱的 +admin 别名> --no-migrate --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable notification --param AdminEmail=<通知邮箱的 +admin 别名> --no-migrate
```
:::

`--no-migrate`：迁移框架尚未接入；两位测试用户的订阅用下面的脚本创建（与迁移脚本走同一个 `subscribeEmail`）。
脚本以每位用户的身份把“邮件通知”重新打开一次，sns 驱动因此调用 `Subscribe`：协议 `email`、过滤策略 `{"userId":["<该用户的 ID>"]}`。

```bash {runsOn=workstation}
npx tsx experiments/notification/subscribe-users.ts
```

:::wait{typical=5 max=20}
共 3 封确认邮件（收件人分别是 `+admin`、`+u1`、`+u2`），逐个点击 **Confirm subscription**。确认之前，notification 的状态是黄色
“运维订阅待确认”——这是预期的等待，不是失败。worker 每 5 分钟同步一次订阅状态。
:::

全部确认后，在应用预览给 `+u1` 的照片发一条评论，然后在 SNS 控制台打开主题 `cloudalbum-{{ session.env }}-notification-events` 的“订阅”页，
点开 `+u1` 的订阅，查看“订阅筛选策略”。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/capabilities | jq '.modules.notification | {driver, status, detail}'
```

::console-link[在 SQS 控制台打开收件队列]{link=sqs.queue queueUrlEncoded="{{ var.inboxUrl | url }}"}

:::expected
notification 为“正常”；评论请求的路径头里有 `notification=sns:published`；主题上有收件队列的 sqs 订阅与至少 3 个已确认的邮件订阅；
收件队列的访问策略只允许本主题（`aws:SourceArn`）以 `sns.amazonaws.com` 身份发送。
:::

:::why
**为什么邮件订阅要确认？** 任何人都能把别人的地址订阅到自己的主题上；只有收件人点了确认链接，SNS 才开始投递。
**过滤策略默认匹配消息属性**：发布时忘了带 `userId` 属性，带过滤策略的订阅都收不到；反过来，一个**没有**过滤策略的邮件订阅会收到主题上的全部消息——
把用户订阅到主题却忘了加过滤策略，他会收到所有人的评论提醒，这是隐私事故。
:::

::checks
