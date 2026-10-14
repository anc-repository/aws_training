---
section: wrap-up
---

## What you did

- Moved photos from the EBS data volume into S3 and switched uploads to direct browser uploads: the lab instance no longer carries upload bytes.
- Understood the bucket's security baseline (BPA, ACLs disabled, HTTPS only, default encryption) and cost settings (versioning, lifecycle).

## Exam points recap

- Presigned URL validity and signing credentials: a URL signed with temporary credentials stops working early when the credentials expire.
- Block Public Access, `BucketOwnerEnforced`, the bucket policy condition `aws:SecureTransport`; SSE-S3, SSE-KMS and Bucket Keys.
- Versioning + lifecycle; the minimum storage duration and minimum billable size of storage classes.
- S3 event notifications vs EventBridge; S3 gateway endpoints are not billed hourly.
