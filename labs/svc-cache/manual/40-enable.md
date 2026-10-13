---
step: enable
---

接入 ElastiCache：模块在默认 VPC 中创建子网组、`sg-cache`（6379 只放行实验机安全组）与单节点复制组（`cache.t4g.micro`，传输与静态加密开启），
写入 `REDIS_URL` 后重启 api，再用 SET / GET / DEL 探针确认可用。

:::method{kind=script default}
先看变更预览：

```bash {runsOn=workstation}
scripts/module enable cache --dry-run
```

确认后执行：

```bash {runsOn=workstation}
scripts/module enable cache
```
:::

:::wait{typical=10 max=25}
复制组创建通常需要 10 分钟左右。等待期间可以读一读 Valkey / Redis OSS 与 Memcached 的区别（本步骤末尾）。
:::

:::expected
cache 的状态为“正常”；时间线连续刷新两次，第 2 次的路径头出现 `cache=redis@elasticache:hit`，性能徽章显示“ElastiCache HIT”。
:::

:::saa{domain=cost confusable="Valkey / Redis OSS vs Memcached"}
节点式 Memcached 多线程、无复制、无持久化；Valkey / Redis OSS 支持副本、Multi-AZ 自动故障转移（至少一个副本）与快照。
Serverless 按存储与 ECPU 计费且有最低存储计费量；节点模式按节点小时计费。
:::

::checks
