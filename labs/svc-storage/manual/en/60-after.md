---
step: after
---

Measure again with exactly the same parameters as before:

```bash {runsOn=workstation}
npm run exp -- storage --label after --scenario upload-burst --param fileMb=5 --duration 60s --upload
```

::experiment{module=storage id=upload-burst label=after}

:::expected
The lab instance's received bytes are down to KB-sized signing requests and no longer grow with the upload volume; API process CPU and the timeline p95 barely change; the before and after results are both valid and comparable.
:::

:::saa{domain=resilient}
S3 Standard stores objects redundantly across several Availability Zones (see the official documentation), while an EBS volume is only redundant within one Availability Zone; S3 needs no provisioned capacity, while an EBS volume has a fixed size.
:::

::checks
