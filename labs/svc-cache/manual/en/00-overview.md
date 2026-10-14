---
section: overview
---

## Background

At L0 the timeline queries the database every time (`CACHE_DRIVER=none`). The timeline is a classic read-heavy, write-light API: the same person's timeline is read again and again within a few dozen seconds, and its content hardly changes.
Cache-aside reads the cache first, and on a miss queries the database and fills the cache; writes bump a version number so that old keys simply stop being used.
This card builds a single-node Amazon ElastiCache (Valkey) in the default VPC so that several processes and several instances can share one cache.

:::why
The cache is a **non-authoritative** port: the real data lives in the database. When the cache is unreachable the app treats it as a miss (fail-open) — requests get slower but do not fail, and the module is marked degraded.
So a cache failure should never turn into an error the user can see.
:::

## Comparison experiments

### Timeline read load test (cache/feed-read, required)

- **Without a cache (none)**: every timeline request runs several database queries.
- **With ElastiCache**: a hit makes zero database queries per request; the after run uses `--ab` to bypass the cache on every other request in the same deployment, so groups A and B are comparable over the same time window.
- **Where you will see it**: `client.timing.database.calls_per_request` and the hit ratio `client.outcome_ratio.cache.hit` in the comparison report;
  the cache segment of the `X-CloudAlbum-Path` response header changes from `none` to `redis@elasticache:hit` / `miss`.
- **If the results are not what you expect**: SQLite is on the same host and the data set is small, so the latency difference may be unclear — look at queries per request, not only at p95. With a single process, in-process cache (memory) hits are actually faster.

## Platform mode notes

ElastiCache nodes are billed hourly from creation; the comparison experiments run on the workbench. The workbench and the lab instance are both in the default VPC, but only the lab instance can reach the cache — you will verify this yourself in step 5.
