---
step: inspect
---

从两个地方连接同一个缓存端点：实验机与工作台。它们同在默认 VPC，端点也只解析到私有地址。

在**实验机终端**用 TLS 发送一次 PING（Valkey 开启了传输加密，必须走 TLS）：

```bash {runsOn=lab}
printf 'PING\r\n' | timeout 5 openssl s_client -connect "{{ var.redisUrl | host }}:6379" -quiet 2>/dev/null | head -1
```

在**工作台终端**只测 TCP 连接能否建立（工作台没有 Redis 客户端）：

```bash {runsOn=workstation}
timeout 5 bash -c 'exec 3<>/dev/tcp/{{ var.redisUrl | host }}/6379' && echo open || echo blocked
```

再看缓存节点的安全组：

```bash {runsOn=workstation}
aws elasticache describe-cache-clusters --cache-cluster-id "{{ var.replicationGroupId }}-001" --query "CacheClusters[0].SecurityGroups"
```

:::expected
实验机得到 `+PONG`；工作台输出 `blocked`。挡住工作台的是 `sg-cache`：6379 的入站规则只放行实验机的安全组 `{{ target.sgId }}`。
:::

:::why
ElastiCache 没有公网端点，只能在 VPC 内访问；安全组的来源写成另一个安全组，比写 IP 段更稳：实例换了 IP、扩成多台，规则都不用改。
:::

::checks
