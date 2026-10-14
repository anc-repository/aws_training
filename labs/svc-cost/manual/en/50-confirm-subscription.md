---
step: confirm-subscription
---

In the {{ learner.inputs.notify-email }} mailbox, find the cost topic's "AWS Notification - Subscription Confirmation" (it may be in your spam folder) and click **Confirm subscription**.

```bash {runsOn=workstation}
aws sns list-subscriptions-by-topic --topic-arn "{{ var.costTopicArn }}" --query "Subscriptions[].[Protocol,SubscriptionArn]" --output table
```

:::expected
The email subscription's `SubscriptionArn` changes from `PendingConfirmation` to an ARN. Email recipients of budget notifications get them straight from Budgets and need no confirmation;
the SNS topic path does.
:::

:::why
The SNS topic policy must allow `budgets.amazonaws.com` to publish (the template restricts it to this account with `aws:SourceAccount`); otherwise budget notifications fail silently.
:::

::checks
