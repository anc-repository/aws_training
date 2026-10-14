---
step: enable
---

Wire in ElastiCache: the module creates a subnet group in the default VPC, `sg-cache` (6379 only allows the lab instance's security group) and a single-node replication group (`cache.t4g.micro`, with in-transit and at-rest encryption on),
writes `REDIS_URL`, restarts api, and then confirms that the cache works with a SET / GET / DEL probe.

:::method{kind=script default}
Preview the changes first:

```bash {runsOn=workstation}
scripts/module enable cache --dry-run
```

When you are happy with them, run it:

```bash {runsOn=workstation}
scripts/module enable cache
```
:::

:::wait{typical=10 max=25}
Creating the replication group usually takes about 10 minutes. While you wait, read about the differences between Valkey / Redis OSS and Memcached (at the end of this step).
:::

:::expected
cache is Healthy; when you reload the timeline twice in a row, the second path header contains `cache=redis@elasticache:hit` and the performance badge shows "ElastiCache HIT".
:::

:::saa{domain=cost confusable="Valkey / Redis OSS vs Memcached"}
Node-based Memcached is multi-threaded with no replication and no persistence; Valkey / Redis OSS supports replicas, Multi-AZ automatic failover (which needs at least one replica) and snapshots.
Serverless is billed by storage and ECPUs, with a minimum billed storage; node-based clusters are billed by node hours.
:::

::checks
