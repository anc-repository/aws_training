---
step: filter
---

Send one event to `+u1` only and see what the filter policy does. The runner posts a comment on u1's photo (message attribute `userId=<u1's ID>`), then reads that event's delivery records from the server:

```bash {runsOn=workstation}
npm run exp -- notification --label after --scenario filter --param user=u1 --upload
```

::experiment{module=notification id=filter label=after}

Check your mailbox: for this event only the email to `+u1` arrives, not `+u2` (all aliases land in the same mailbox, so tell them apart by recipient address).

:::wait{typical=3 max=10}
SNS's CloudWatch metrics lag by minutes: `NumberOfNotificationsFilteredOut` usually shows up a few minutes later.
:::

:::expected
filter's `emailedOthers` is 0, and the server has only one `sns` row and one `sqs-copy` row (the inbox queue has no filter policy, so it receives every event);
this topic's `NumberOfNotificationsFilteredOut` in CloudWatch is above 0.
:::

:::saa{domain=resilient confusable="SNS 过滤策略 vs 应用代码判断"}
Filtering happens on the SNS side, before delivery, with no change to application code; the scope can be message attributes (the default) or the message body (`FilterPolicyScope=MessageBody`).
When you need ordering and deduplication, use an SNS FIFO topic + an SQS FIFO queue.
:::

::checks
