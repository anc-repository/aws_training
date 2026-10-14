---
step: confirm-subscription
---

{{ learner.inputs.notify-email }} のメールボックスで、cost トピックの「AWS Notification - Subscription Confirmation」（迷惑メールフォルダーに入っていることがあります）を探し、**Confirm subscription** をクリックします。

```bash {runsOn=workstation}
aws sns list-subscriptions-by-topic --topic-arn "{{ var.costTopicArn }}" --query "Subscriptions[].[Protocol,SubscriptionArn]" --output table
```

:::expected
メールサブスクリプションの `SubscriptionArn` が `PendingConfirmation` から ARN に変わります。予算通知のメール受信者には Budgets が直接送信するため確認は不要ですが、
SNS トピック経由の通知には確認が必要です。
:::

:::why
SNS のトピックポリシーで `budgets.amazonaws.com` の発行を許可しておく必要があります（テンプレートでは `aws:SourceAccount` でこのアカウントに限定しています）。許可がないと、予算の通知は何も言わずに失敗します。
:::

::checks
