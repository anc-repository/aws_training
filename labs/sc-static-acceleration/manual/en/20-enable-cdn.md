---
step: enable-cdn
---

Create the distribution and set the media origin to S3. `scripts/module` does it in three phases: deploy the distribution with EC2 as the origin (including the cache policy, the response headers policy, a CloudFront Function that strips the `/media` prefix,
and the 8080 origin listener and security group) → inject the distribution ARN into the storage stack to generate the OAC bucket policy → switch the origin of the `/media/*` behavior to S3.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_MEDIA_ORIGIN=s3 --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable cdn --set CDN_MEDIA_ORIGIN=s3
```
:::

:::wait{typical=8 max=25}
It takes a few minutes for the distribution to go from "Deploying" to "Enabled"; the distribution is updated twice during the three phases.
:::

Compare the behaviors, cache policy and origins in the console:

::console-link[Open the distribution]{link=cloudfront.distribution distributionId="{{ var.distributionId }}"}

:::expected
cdn is Healthy; the origin of the `/media/*` behavior is `s3-media` (with OAC), and the other behaviors go to the lab instance; a request to `/api/health/live` through the distribution has a path header starting with `entry=cloudfront>nginx`.
:::

:::saa{domain=performance confusable="缓存策略 vs 源请求策略"}
The cache policy decides the cache key and TTLs; the origin request policy decides which extra headers, cookies and query strings go to the origin (they are not part of the cache key); the response headers policy adds headers to responses at the edge (CORS, security headers).
:::

::checks
