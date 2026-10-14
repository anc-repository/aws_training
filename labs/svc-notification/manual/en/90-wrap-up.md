---
section: wrap-up
---

## What you did

- Replaced off-site notifications sent "one by one by EC2" with a single SNS Publish that fans out to email subscriptions and the module's own SQS inbox queue.
- Used subscription filter policies so each user only receives notifications about them, and saw the filtered-out deliveries in CloudWatch.
- Saw the email subscription confirmation flow, and that SNS keeps delivering while the worker is down — only the inbox queue backs up.

## Exam points recap

- SNS + SQS fan-out versus SQS competing consumers; subscription protocols (HTTP/S, Email, SQS, Lambda, SMS, mobile push, Firehose).
- Subscription filter policies (message attributes / message body); email subscriptions need confirmation; raw message delivery; per-protocol delivery retries and subscription-level DLQs.
- SNS FIFO + SQS FIFO for fan-out that needs ordering and deduplication.
- `aws:SourceArn` / `aws:SourceAccount` in queue and topic policies; SSE-KMS topics and granting access to service principals.
- When to use SNS, SES and EventBridge: broadcast subscriptions, transactional email, and routing on event content.
