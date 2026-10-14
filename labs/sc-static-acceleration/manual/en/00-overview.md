---
section: overview
---

## Background

The starting point is "L0 + S3": photos are in an S3 bucket in Tokyo, and the browser downloads thumbnails directly with a presigned URL that is different every time; pages and `/assets` are served directly by Nginx on EC2.
Every byte for overseas users has to cross continents back to Tokyo, and since the URL changes every time, the browser cache is almost useless.
This card puts a CloudFront distribution in front of the bucket: thumbnails and front-end assets come back from the edge closest to the user, and the photo bucket stays completely closed to the internet.

## Why combine them

- **S3** provides a durable origin with no capacity to provision; **CloudFront** caches at the edge and terminates TLS; **OAC** lets CloudFront read the private bucket with a service identity (SigV4),
  so the bucket can keep all four BPA settings on, and the bucket policy uses `AWS:SourceArn` to allow only this distribution and only `variants/*`.
- Pages, `/assets` and `/api/*` still go to the lab instance (the 8080 origin listener + `X-Origin-Verify`), while media comes from S3: one distribution, two origins, split by path.
- **Common wrong combinations**: using the S3 static website endpoint as the origin (HTTP only, no OAC, the bucket must be public); reading SSE-KMS objects with OAI (not supported);
  using S3 Transfer Acceleration or Global Accelerator instead of a CDN (neither caches content).
- **Scope of this version**: a custom domain (Route 53 Alias) and an ACM certificate in us-east-1 will return once the tls and dns modules exist; this version uses the default `*.cloudfront.net` certificate, and the related exam points are covered in the quiz and further reading.

## Comparison experiments

### Media loading (cdn/media-load, required)

- **At the start**: every thumbnail is a request to S3 or EC2, and origin load grows linearly with traffic.
- **When done**: only misses go to the origin; the second request for the same thumbnail comes back from the edge (`X-Cache: Hit from cloudfront`).
- **Where you see it**: origin request count and bytes out in the comparison report; the “源站负载” (origin load) panel on the cdn card in `/lab`; the response headers `X-Cache`, `Age` and `X-Amz-Cf-Pop`.
- **Note**: the workbench and the lab instance are both in Tokyo, so the time-to-first-byte difference is small; the cross-continent difference is explained in the manual without multi-Region measurements.

## Platform mode notes

A distribution takes from a few minutes to over ten minutes to finish deploying after creation; at reclaim it must be disabled before it can be deleted, which takes a while, and the platform shows the progress separately.
