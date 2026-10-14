---
step: subscribe-users
---

为 3 个测试用户建邮件订阅。脚本以每个用户的身份把“邮件通知”重新打开一次（`PUT /api/notifications/prefs`），
sns 驱动因此调用 `Subscribe`：协议 `email`、`ReturnSubscriptionArn=true`、过滤策略按 `userId` 匹配（管理员另加 `audience=admin`），
订阅 ARN 与“待确认”状态写回 `notification_prefs`。

```bash {runsOn=workstation}
npx tsx experiments/notification/subscribe-users.ts
```

:::wait{typical=5 max=20}
每个地址会收到一封 AWS 的确认邮件（共 3 封，收件人分别是 `+u1`～`+u3`），逐个点击 **Confirm subscription**。
worker 每 5 分钟同步一次订阅状态，设置页的“等待确认（请查收 AWS Notifications 的邮件）”随后变为“已开启”。
:::

在 SNS 控制台打开主题 `cloudalbum-{{ session.env }}-notification-events` 的“订阅”页，点开 `+u1` 的订阅，查看“订阅筛选策略”。

:::why
**过滤策略默认匹配消息属性。** 发布时忘了带 `userId` 属性，所有带过滤策略的订阅都收不到；反过来，一个**没有**过滤策略的邮件订阅
会收到主题上的全部消息——把用户订阅到主题却忘了加过滤策略，他会收到所有人的评论提醒，这是隐私事故。
:::

:::expected
主题上至少 5 个订阅：收件队列（sqs）、运维邮箱、3 个用户邮箱；用户订阅的筛选策略作用范围是 `MessageAttributes`。
:::

::checks
