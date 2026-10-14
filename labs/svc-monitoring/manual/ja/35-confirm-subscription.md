---
step: confirm-subscription
---

{{ learner.inputs.notify-email }} のメールボックスで「AWS Notification - Subscription Confirmation」を探し（迷惑メールフォルダーにあるかもしれません）、**Confirm subscription** をクリックします。

```bash {runsOn=workstation}
aws sns list-subscriptions-by-topic --topic-arn "{{ var.alarmTopicArn }}" --query "Subscriptions[].[Protocol,SubscriptionArn]" --output table
```

:::expected
メールサブスクリプションの `SubscriptionArn` が `PendingConfirmation` から ARN に変わります。30 秒以内に monitoring の状態が「正常」になります。
:::

:::why
誰でも他人のメールアドレスを自分のトピックにサブスクライブできてしまうため、SNS は受信者が確認してから配信します。確認前でもアラームは ALARM になりますが、メールが送られないだけです。
:::

::checks
