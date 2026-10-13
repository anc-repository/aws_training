---
step: after
---

记录 after：与第 2 步完全相同的混合读写，这次数据库在 RDS 上。

```bash {runsOn=workstation}
npm run exp -- database --label after --scenario mixed-rw --vus 10,50 --upload
```

::experiment{module=database id=mixed-rw label=after}

:::expected
10 并发时单次请求略慢于 SQLite（多一次网络往返）；50 并发时延迟平缓上升，事件循环延迟不再出现尖峰。
:::

::checks
