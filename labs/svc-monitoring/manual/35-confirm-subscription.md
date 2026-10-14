---
step: confirm-subscription
---

到 {{ learner.inputs.notify-email }} 的邮箱找 “AWS Notification - Subscription Confirmation”（可能在垃圾邮件箱），点击 **Confirm subscription**。

```bash {runsOn=workstation}
aws sns list-subscriptions-by-topic --topic-arn "{{ var.alarmTopicArn }}" --query "Subscriptions[].[Protocol,SubscriptionArn]" --output table
```

:::expected
邮件订阅的 `SubscriptionArn` 从 `PendingConfirmation` 变成一个 ARN；半分钟内 monitoring 的状态变为“正常”。
:::

:::why
任何人都能把别人的邮箱订阅到自己的主题上，所以 SNS 要求收件人确认后才投递。确认之前，告警照样会进入 ALARM，只是邮件发不出去。
:::

::checks
