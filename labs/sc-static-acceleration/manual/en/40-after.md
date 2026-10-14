---
step: after
---

Record after: the same media loading as in step 1, but this time thumbnails come from the edge.

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario media-load --upload
```

::experiment{module=cdn id=media-load label=after}

:::expected
Origin request count and bytes out drop sharply, leaving only miss fetches; in the “源站负载” (origin load) panel in `/lab`, origin requests carrying `X-Amz-Cf-Id` are only a small share.
:::

:::saa{domain=performance confusable="CloudFront vs Global Accelerator vs S3 Transfer Acceleration"}
CloudFront caches content at the edge; Global Accelerator provides static Anycast IPs and backbone acceleration without caching, with ALB, NLB, EC2 and Elastic IPs as endpoints;
S3 Transfer Acceleration speeds up long-distance transfers between clients and the bucket (mostly uploads) and does not cache either.
:::

::checks
