---
step: replica
---

（选做）只读副本：给模块加一个异步复制的副本，应用的读查询改走副本端点。副本是第 3 个按小时计费的实例，创建需要十几分钟以上。

```bash {runsOn=workstation}
scripts/module enable database --param MultiAz=true --param CreateReadReplica=true
```

副本可用后，用逐请求 A/B 对比读走主库与读走副本：

```bash {runsOn=workstation}
npm run exp -- database --label after --scenario replica-read --ab --upload
```

::experiment{module=database id=replica-read label=after}

:::expected
读走副本的那一组请求，路径头的 database 段指向副本；主库的读负载下降。写入后立刻读副本，可能读到旧数据（异步复制延迟）。
:::

::checks
