---
step: after
---

Record the after: exactly the same mixed reads and writes as in step 2, this time with the database on RDS.

```bash {runsOn=workstation}
npm run exp -- database --label after --scenario mixed-rw --vus 10,50 --upload
```

::experiment{module=database id=mixed-rw label=after}

:::expected
At 10 concurrent users a single request is slightly slower than with SQLite (one more network round trip); at 50, latency rises gently and the event loop delay no longer spikes.
:::

::checks
