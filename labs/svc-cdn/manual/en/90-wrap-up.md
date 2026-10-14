---
section: wrap-up
---

## What you did

- Put the album that EC2 served directly behind CloudFront: static assets and thumbnails are cached at the edge, and hits never reach the origin.
- Proved an edge hit with server-side evidence (how many times the nonce appears in the origin log) instead of trusting response headers that can be forged.
- Confirmed that authenticated APIs sit in a `CachingDisabled` behavior and both requests reach the origin.
- Compared invalidations with versioned file names.

## Exam points recap

- The cache policy decides the cache key and TTLs, the origin request policy decides what is forwarded to the origin, and the response headers policy decides which headers go back to the browser.
- A custom origin must be a domain name; protect it with a managed prefix list plus a custom header, and use OAC for S3 origins.
- An ACM certificate used by CloudFront must be in us-east-1; traffic from an AWS origin to CloudFront is not charged as data transfer out.
- CloudFront caches content; Global Accelerator does not cache and provides static anycast IPs.
