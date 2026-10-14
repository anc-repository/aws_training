---
step: baseline
---

Record the before: 20 concurrent users keep reading the timeline for 120 seconds (the runner uses its own experiment users, so your album is not affected).

```bash {runsOn=workstation}
npm run exp -- cache --label before --scenario feed-read --vus 20 --duration 120s --upload
```

::experiment{module=cache id=feed-read label=before}

:::expected
Database calls per request are above 0; the cache segment is always `none`; there are 0 errors.
:::

::checks
