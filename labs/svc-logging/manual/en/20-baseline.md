---
step: baseline
---

Record before: the runner first turns on the `error5xx` fault (about 20% of requests return 503, cleared automatically after 120 seconds), sends a constant load to `/api/lab/now`, and then runs two queries on
**the local side**: "count 5xx by route" and "find by request ID".

```bash {runsOn=workstation}
npm run exp -- logging --label before --scenario query-compare --upload
```

::experiment{module=logging id=query-compare label=before}

:::expected
In the report, `local.errors` equals the number of 503s the client saw (`agreeLocal`), along with the local scan's duration and bytes scanned; the `cloudwatch` side shows as unavailable.
:::

:::why
The local query scans the current file and `.1` backwards on the instance: fast while the data is small, but the time grows linearly with file size, and it only sees this machine's last two days.
:::

::checks
