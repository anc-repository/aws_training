---
step: baseline
---

Record the before: 20 concurrent users keep uploading 4000×3000 JPEGs for 60 seconds, each going all the way through "create → PUT to S3 → complete → poll until READY".

```bash {runsOn=workstation}
npm run exp -- image-processing --label before --scenario upload-burst --vus 20 --duration 60s --upload
```

::experiment{module=image-processing id=upload-burst label=before}

:::expected
The complete API's p95 is in seconds; `host.cpu.p95` is close to 100%; the thumbnail's time to ready is about the same as complete's duration.
:::

:::tip
To also see the effect on neighbors, you can additionally run `npm run exp -- image-processing --label before --scenario neighbor --upload` (optional):
it reads the timeline 5 times per second under the same upload load and looks at the p95 of `GET /api/feed`. After enable, the same scenario can only record an after.
:::

::checks
