---
step: memory
---

（选做）先切到本地档 memory：每个 Node 进程各有一份 LRU，不需要任何 AWS 资源。

```bash {runsOn=workstation}
scripts/module enable cache --driver memory
```

再跑一次同样的读压测：

```bash {runsOn=workstation}
npm run exp -- cache --label memory --scenario feed-read --vus 20 --duration 120s --upload
```

::experiment{module=cache id=feed-read label=memory}

:::expected
命中时每请求查库 0 次，延迟在微秒级（进程内），比之后的 ElastiCache 还快。
:::

:::why
**进程内缓存的代价在多进程时才出现**：两个进程各有一份缓存，写入后约一半请求会在一个 TTL 内读到旧数据；重启进程缓存就清空。
本卡的起始状态只有一个 api 进程，看不到这种不一致；多实例的版本见 `sc-db-performance` 与 `sc-elastic-web`。
:::

::checks
