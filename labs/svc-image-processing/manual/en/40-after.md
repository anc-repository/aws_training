---
step: after
---

Record the after: exactly the same upload load as in step 1, this time with Lambda generating the thumbnails.

```bash {runsOn=workstation}
npm run exp -- image-processing --label after --scenario upload-burst --vus 20 --duration 60s --upload
```

::experiment{module=image-processing id=upload-burst label=after}

:::expected
complete's p95 drops to the tens of milliseconds; `host.cpu.p95` drops clearly; `biz.cold_starts` is above 0 (the first photos trigger cold starts); `biz.jobs_lost` is 0.
:::

:::tip
Add `--ab` to compare within the same time window: half of the photos carry `X-Compare-Bypass: image` and are processed on the spot in the API process, and the Lambda result that arrives later is ignored idempotently.
:::

::checks
