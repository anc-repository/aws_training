---
section: wrap-up
---

## What you did

- Had the app batch-ship the same logs to CloudWatch Logs while still writing local files: a rollback leaves no gap, and the logs survive when the instance is gone.
- Measured ingestion latency: immediate locally, seconds in CloudWatch.
- Aggregated 5xx with Logs Insights and saw "bytes scanned", the basis of its billing; turned logs into metrics with metric filters.

## Exam points recap

- Log groups, log streams, retention (never expires by default) and KMS encryption; the Standard and Infrequent Access log classes.
- Logs on EC2 need the CloudWatch agent or an SDK; Lambda logs arrive automatically. The unified CloudWatch agent collects logs and metrics at the same time.
- Metric filter → metric → alarm, not retroactive; Logs Insights is billed by data scanned; subscription filters (Kinesis / Firehose / Lambda) are near real time, while export to S3 is batch.
- The difference between CloudWatch Logs (operational logs) and CloudTrail (API auditing).
