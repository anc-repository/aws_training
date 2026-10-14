---
step: feedback-loop
---

（选做）用 SES 邮箱模拟器演练退信与投诉回流。模拟器地址在沙盒中也能收信，不会影响你账号的信誉指标。

在应用预览退出登录，分别用下面两个地址各注册一个用户（注册接口每 IP 10 分钟限 20 次）：

```text
bounce@simulator.amazonses.com
complaint@simulator.amazonses.com
```

然后以管理员打开 `/admin/outbox`，等待这两封验证邮件的投递状态更新；同时看看反馈队列与它的 DLQ：

```bash {runsOn=workstation}
aws sqs get-queue-attributes --queue-url "{{ var.feedbackUrl }}" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
aws sqs get-queue-attributes --queue-url "{{ var.feedbackDlqUrl }}" --attribute-names ApproximateNumberOfMessages
```

:::expected
几秒到几分钟内，bounce 那一行变为“退信”，complaint 那一行变为“投诉”；`bounce@…` 对应用户的 `email_status` 变成 `bounced`，
之后只给它发验证与重置密码这两类必要邮件。反馈队列被 worker 消费到 0，反馈 DLQ 为 0。
:::

:::why
事件路径是 SES 配置集的事件目标 → SNS 事件主题 → SQS 反馈队列 → worker。worker 解析不了的消息在接收 5 次后进入反馈 DLQ；
配置集级与账户级抑制列表是第二道保护。
:::

::checks
