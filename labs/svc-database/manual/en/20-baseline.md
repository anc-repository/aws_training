---
step: baseline
---

Record the before: a mixed read/write load test at two concurrency levels, 10 and then 50. 30% of the requests are writes (posting comments and creating private albums, deleted afterwards); the rest read the timeline.

```bash {runsOn=workstation}
npm run exp -- database --label before --scenario mixed-rw --vus 10,50 --upload
```

::experiment{module=database id=mixed-rw label=before}

:::expected
At 10 concurrent users the timeline p95 is very low; at 50, writes queue up and `host.event_loop_delay.p99` spikes.
:::

::checks
