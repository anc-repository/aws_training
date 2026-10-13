---
step: after
---

同样的突发上传，这次运行器在第 30 秒对 worker 执行 `kill -9`，systemd 随后自动拉起它：

```bash {runsOn=workstation}
npm run exp -- queue --label after --scenario upload-burst --upload
```

::experiment{module=queue id=upload-burst label=after}

:::expected
`biz.jobs_lost` 为 0：被杀时正在处理的消息没有被删除，可见性超时后重新出现，被重启后的 worker 处理；
排空时间比 before 长，CPU 曲线从尖峰变成平台（削峰）。
:::

:::saa{domain=resilient confusable="可见性超时 vs 消息保留期"}
可见性超时要大于单个任务的最长处理时间，长任务在处理中定期延长可见性（心跳）；消息保留期决定没人处理的消息能留多久。
:::

::checks
