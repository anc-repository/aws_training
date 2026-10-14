---
step: ingest
---

Record after: send 20 requests, then search CloudWatch every 2 seconds until all of them appear.

```bash {runsOn=workstation}
npm run exp -- logging --label after --scenario ingest-lag --upload
```

::experiment{module=logging id=ingest-lag label=after}

:::expected
`local.foundImmediately` equals the number of requests (immediately visible locally); `ingestLagP50Ms` is the ingestion latency on the CloudWatch side (`ingestionTime − timestamp`),
from a few seconds to a dozen or so; `missing` is 0.
:::

:::why
Ingestion latency has two parts: the shipper's batch interval (`LOG_CW_FLUSH_MS`, 2 seconds by default; about 5 seconds with the agent) and CloudWatch ingestion itself. The event time comes from the Nginx line's
`ts` (second precision), so individual values can be off by up to a second.
:::

::checks
