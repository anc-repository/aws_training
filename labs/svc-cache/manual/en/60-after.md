---
step: after
---

Record the after: the same read load test with `--ab`, alternating per request in the same deployment — group A sends `X-Compare-Bypass: cache` (no cache reads or writes), group B uses ElastiCache as usual.

```bash {runsOn=workstation}
npm run exp -- cache --label after --scenario feed-read --vus 20 --duration 120s --ab --upload
```

::experiment{module=cache id=feed-read label=after}

:::expected
Group B makes 0 queries per request on hits, with a hit ratio close to 1; group A is close to the before. Both groups run over the same time window, which rules out "it was a different time of day".
:::

:::tip
With a single process, memory hits (in-process) are faster than ElastiCache (one TLS round trip inside the VPC). The value of a shared cache is consistency across processes and instances, and that it survives restarts.
:::

::checks
