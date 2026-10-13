---
step: after
---

记录 after：同样的读压测，加 `--ab` 在同一部署内逐请求交替：A 组带 `X-Compare-Bypass: cache`（不读不写缓存），B 组正常走 ElastiCache。

```bash {runsOn=workstation}
npm run exp -- cache --label after --scenario feed-read --vus 20 --duration 120s --ab --upload
```

::experiment{module=cache id=feed-read label=after}

:::expected
B 组命中时每请求查库 0 次，命中率接近 1；A 组与 before 接近。两组同时段运行，排除了“换了时间段”的干扰。
:::

:::tip
单进程下 memory 的命中（进程内）比 ElastiCache（VPC 内一次 TLS 往返）更快；共享缓存的价值在于多进程、多实例时的一致性与重启后不清空。
:::

::checks
