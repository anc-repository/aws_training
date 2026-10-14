---
step: baseline-failover
---

Record the before failure window: the runner keeps writing and restarts api at second 30 (in the SQLite tier, a "database failure" can only mean restarting the app process).

```bash {runsOn=workstation}
npm run exp -- database --label before --scenario failover --upload
```

::experiment{module=database id=failover label=before}

:::expected
The report shows a window of failed writes, roughly as long as it takes api to restart.
:::

::checks
