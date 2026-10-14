---
step: after
---

Measure again with the same load as before, this time going entirely through CloudFront (`target=cdn`):

```bash {runsOn=workstation}
npm run exp -- cdn --label after --scenario media-load --param target=cdn --upload
```

::experiment{module=cdn id=media-load label=after}

:::expected
Origin requests and EC2 bytes sent drop clearly (only the origin requests for misses remain); the report shows both the before and the after result as Valid and marks them as a comparable pair.
:::

:::saa{domain=cost}
Data transfer from an AWS origin (EC2, S3, ALB) to CloudFront is free; what users download from CloudFront is billed as CloudFront data transfer out (check the official pricing).
The higher the hit ratio, the less data EC2 sends out.
:::

::checks
