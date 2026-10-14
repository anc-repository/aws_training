---
section: wrap-up
---

## What you did

- Moved thumbnail generation from sharp on EC2 to S3 → EventBridge → Lambda: the upload-complete API now does a single database update, and EC2's CPU no longer rises and falls with uploads.
- Read the retries, maximum event age and on-failure destination of asynchronous invocations, and separated permanent errors from transient ones.
- Pulled the emergency brake once yourself and confirmed it was released.

## Exam points recap

- Lambda's three invocation types: synchronous, asynchronous and event source mapping; asynchronous retries (0–2), maximum event age, Destinations and DLQs.
- S3 event notifications vs EventBridge vs SNS fan-out; choreography vs orchestration; separating input from output to avoid recursion.
- Reserved vs provisioned concurrency and the account concurrency quota; cold starts and `Init Duration`; CPU scales with memory, and arm64 gives better price-performance.
- The 15-minute timeout, `/tmp`, deployment packages vs layers / container images; Lambda cannot reach EBS, so state has to live outside the instance.
