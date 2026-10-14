---
section: wrap-up
---

## What you did

- Put CloudFront in front of a private S3 bucket: thumbnail URLs became stable `https://<distribution domain>/media/variants/…` addresses that both the edge and the browser can cache.
- Used OAC + `AWS:SourceArn` to keep the bucket private with all BPA settings on, opening only `variants/*` to this distribution.
- Compared invalidations with versioned file names.

## Overall comparison

- **Media URLs**: a different presigned URL every time → a stable address on the distribution's domain.
- **Origin load**: every request reaches S3 or EC2 → only origin fetches remain.
- **Bucket exposure**: private, relying on presigned URLs → private, with only this distribution reading `variants/*` through OAC.
- **Hourly-billed resources**: unchanged (every added service is billed by usage).

## Exam points recap

- Edge locations and regional edge caches; cache, origin request and response headers policies; TTLs and `Cache-Control`.
- OAC vs OAI; bucket policies that only let CloudFront access S3; SSE-KMS objects need the key policy to allow CloudFront.
- ACM certificates used by CloudFront must be in us-east-1; a Route 53 Alias works at the root domain and queries to AWS resources are free; the root domain cannot have a CNAME.
- CloudFront vs S3 Transfer Acceleration vs Global Accelerator; transfer from AWS origins to CloudFront is free.
