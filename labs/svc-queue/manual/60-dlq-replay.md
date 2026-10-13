---
step: dlq-replay
---

死信队列里的消息不会被自动处理。修好 handler 之后，可以把它们“重驱动”回源队列。这里 handler 没有修，你会看到它再次回到死信队列。

```bash {runsOn=workstation}
aws sqs start-message-move-task --source-arn "{{ var.dlqArn }}"
aws sqs list-message-move-tasks --source-arn "{{ var.dlqArn }}" --query "Results[].[Status,ApproximateNumberOfMessagesMoved]" --output table
```

:::expected
移动任务完成后，死信队列的消息数先变为 0；几分钟后坏消息又接收 3 次失败，重新出现在死信队列里。
:::

:::saa{domain=resilient}
标准队列的消息进入死信队列后，过期时间仍从最初入队时算起，所以死信队列的保留期要长于源队列；
`RedriveAllowPolicy` 可以限制哪些源队列能把死信队列作为目标。
:::

::checks
