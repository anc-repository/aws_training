---
step: inspect-bucket
---

Understand the original image bucket's security and cost settings. The module template sets them, so **look but do not change**.

:::method{kind=console default}
::console-link[Open the original image bucket]{link=s3.bucket bucket="{{ var.rawBucket }}"}

1. "Permissions": all four Block Public Access settings are on; Object Ownership is "Bucket owner enforced" (ACLs disabled); the bucket policy denies non-HTTPS requests (`aws:SecureTransport`).
2. "Properties": versioning is enabled; default encryption is SSE-S3 (or SSE-KMS); event notifications only have "Amazon EventBridge" turned on.
3. "Management": lifecycle rules transition originals to Standard-IA after 30 days, expire noncurrent versions after 30 days and abort incomplete multipart uploads.
:::

:::method{kind=cli}
```bash {runsOn=workstation}
aws s3api get-public-access-block --bucket {{ var.rawBucket }}
aws s3api get-bucket-versioning --bucket {{ var.rawBucket }}
aws s3api get-bucket-encryption --bucket {{ var.rawBucket }}
aws s3api get-bucket-notification-configuration --bucket {{ var.rawBucket }}
aws s3api get-bucket-lifecycle-configuration --bucket {{ var.rawBucket }}
```
:::

:::why
**Why only turn on EventBridge delivery?** S3 event notifications for the same event type and overlapping prefixes can have only one target; by delivering everything to EventBridge,
modules such as image-processing and tagging can each create rules in their own stacks and consume the events without conflicts (MUTEX-004).
:::

:::saa{domain=cost confusable="Standard-IA vs Intelligent-Tiering"}
Standard-IA has a 30-day minimum storage duration and a 128 KB minimum billable size, which suits MB-sized, infrequently accessed originals; Intelligent-Tiering does not auto-tier objects under 128 KB.
:::

::checks
