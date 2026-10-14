---
step: dlq-replay
---

Messages in the dead-letter queue are not processed automatically. Once the handler is fixed, you can redrive them back to the source queue. Here the handler is not fixed, so you will see the message return to the dead-letter queue.

```bash {runsOn=workstation}
aws sqs start-message-move-task --source-arn "{{ var.dlqArn }}"
aws sqs list-message-move-tasks --source-arn "{{ var.dlqArn }}" --query "Results[].[Status,ApproximateNumberOfMessagesMoved]" --output table
```

:::expected
When the move task finishes, the dead-letter queue's message count first drops to 0; a few minutes later the bad message has failed 3 more receives and is back in the dead-letter queue.
:::

:::saa{domain=resilient}
For standard queues, a message's expiry still counts from when it was first enqueued after it moves to the dead-letter queue, so the dead-letter queue needs a longer retention than the source queue;
`RedriveAllowPolicy` can limit which source queues may use the dead-letter queue as their target.
:::

::checks
