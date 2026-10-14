---
step: baseline
---

Record before: a burst upload of 200 small images; the runner restarts the api at 30 s (simulating a release), then waits for the queue to drain and counts the lost jobs.

```bash {runsOn=workstation}
npm run exp -- queue --label before --scenario upload-burst --upload
```

::experiment{module=queue id=upload-burst label=before}

:::expected
`biz.jobs_lost` in the report is above 0: the jobs still in the in-memory queue at the restart were lost.
:::

:::tip
While it runs, open the lab terminal and use `top` to watch the CPU of the api and worker processes: job processing and the API share one machine's CPU.
:::

::checks
