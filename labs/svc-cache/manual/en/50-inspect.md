---
step: inspect
---

Connect to the same cache endpoint from two places: the lab instance and the workbench. Both are in the default VPC, and the endpoint only resolves to a private address.

In the **lab instance terminal**, send one PING over TLS (Valkey has in-transit encryption on, so TLS is required):

```bash {runsOn=lab}
printf 'PING\r\n' | timeout 5 openssl s_client -connect "{{ var.redisUrl | host }}:6379" -quiet 2>/dev/null | head -1
```

In the **workbench terminal**, only test whether a TCP connection can be opened (the workbench has no Redis client):

```bash {runsOn=workstation}
timeout 5 bash -c 'exec 3<>/dev/tcp/{{ var.redisUrl | host }}/6379' && echo open || echo blocked
```

Then look at the cache node's security groups:

```bash {runsOn=workstation}
aws elasticache describe-cache-clusters --cache-cluster-id "{{ var.replicationGroupId }}-001" --query "CacheClusters[0].SecurityGroups"
```

:::expected
The lab instance gets `+PONG`; the workbench prints `blocked`. What blocks the workbench is `sg-cache`: its inbound rule for 6379 only allows the lab instance's security group `{{ target.sgId }}`.
:::

:::why
ElastiCache has no public endpoint and can only be reached from inside the VPC. Using another security group as the source is sturdier than an IP range: the rule stays the same when the instance's IP changes or when you scale out to several instances.
:::

::checks
