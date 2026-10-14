---
step: confirm-subscription
---

到 {{ learner.inputs.notify-email }} 的邮箱找 cost 主题的 “AWS Notification - Subscription Confirmation”（可能在垃圾邮件箱），点击 **Confirm subscription**。

```bash {runsOn=workstation}
aws sns list-subscriptions-by-topic --topic-arn "{{ var.costTopicArn }}" --query "Subscriptions[].[Protocol,SubscriptionArn]" --output table
```

:::expected
邮件订阅的 `SubscriptionArn` 从 `PendingConfirmation` 变成一个 ARN。预算通知的邮件订阅者是 Budgets 直接发送的，不需要确认；
SNS 主题这一路需要确认。
:::

:::why
SNS 主题策略必须允许 `budgets.amazonaws.com` 发布（模板已用 `aws:SourceAccount` 限定为本账号），否则预算通知会静默失败。
:::

::checks
