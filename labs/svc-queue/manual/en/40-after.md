---
step: after
---

The same burst upload, but this time the runner runs `kill -9` on the worker at 30 s, and systemd then restarts it automatically:

```bash {runsOn=workstation}
npm run exp -- queue --label after --scenario upload-burst --upload
```

::experiment{module=queue id=upload-burst label=after}

:::expected
`biz.jobs_lost` is 0: the messages being processed when the worker was killed were not deleted, reappeared after the visibility timeout and were processed by the restarted worker;
draining takes longer than before, and the CPU graph changes from a spike to a plateau (load leveling).
:::

:::saa{domain=resilient confusable="可见性超时 vs 消息保留期"}
The visibility timeout must be longer than a single job's longest processing time, and long jobs extend their visibility periodically while they run (heartbeats); the message retention period decides how long an unprocessed message can stay.
:::

::checks
