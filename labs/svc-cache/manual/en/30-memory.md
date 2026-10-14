---
step: memory
---

(Optional) First switch to the local memory tier: every Node process gets its own LRU, and no AWS resources are needed.

```bash {runsOn=workstation}
scripts/module enable cache --driver memory
```

Run the same read load test again:

```bash {runsOn=workstation}
npm run exp -- cache --label memory --scenario feed-read --vus 20 --duration 120s --upload
```

::experiment{module=cache id=feed-read label=memory}

:::expected
Hits make 0 queries per request, with microsecond latency (in-process) — faster than ElastiCache later on.
:::

:::why
**The cost of an in-process cache only shows up with several processes**: if two processes each have their own cache, about half of the requests after a write read stale data for up to one TTL, and restarting a process empties its cache.
This card's start state has only one api process, so you cannot see the inconsistency; for multi-instance versions see `sc-db-performance` and `sc-elastic-web`.
:::

::checks
