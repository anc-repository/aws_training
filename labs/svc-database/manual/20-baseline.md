---
step: baseline
---

记录 before：混合读写压测，依次跑 10 与 50 两档并发。30% 的请求是写（发评论、建私有相册，结束后删除），其余读时间线。

```bash {runsOn=workstation}
npm run exp -- database --label before --scenario mixed-rw --vus 10,50 --upload
```

::experiment{module=database id=mixed-rw label=before}

:::expected
10 并发时时间线 p95 很低；50 并发时写入排队，`host.event_loop_delay.p99` 出现尖峰。
:::

::checks
