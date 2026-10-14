---
step: confirm-subscription
---

Find "AWS Notification - Subscription Confirmation" in the {{ learner.inputs.notify-email }} mailbox (it may be in spam) and click **Confirm subscription**.

```bash {runsOn=workstation}
aws sns list-subscriptions-by-topic --topic-arn "{{ var.alarmTopicArn }}" --query "Subscriptions[].[Protocol,SubscriptionArn]" --output table
```

:::expected
The email subscription's `SubscriptionArn` changes from `PendingConfirmation` to an ARN; within half a minute monitoring's status becomes Healthy.
:::

:::why
Anyone could subscribe someone else's mailbox to their own topic, so SNS only delivers after the recipient confirms. Before confirmation, alarms still go to ALARM; the email just cannot be sent.
:::

::checks
