---
section: wrap-up
---

## What you did

- Moved background jobs from process memory into SQS: kill the worker and not a single job is lost.
- Saw the price of at-least-once delivery: jobs may run twice, and idempotent deduplication absorbs that.
- Isolated a bad message with a dead-letter queue and practiced redriving it.

## Exam points recap

- Standard vs FIFO queues; visibility timeouts and heartbeats; long polling reduces empty receives.
- Dead-letter queues, `maxReceiveCount`, `RedriveAllowPolicy` and dead-letter redrive; the dead-letter queue needs a longer retention.
- Load leveling, loose coupling, competing consumers; driving Auto Scaling with a backlog-per-instance metric.
- When to use SQS, SNS, EventBridge and Kinesis.
